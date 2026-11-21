/**
 * Code Mode for the gateway (based on Cloudflare @cloudflare/codemode, MIT).
 *
 * Exposes only two MCP tools to the model:
 *   - search(query): find upstream tools (name + one-line description + params)
 *   - execute(code): the model writes an async arrow function that calls
 *     codemode.<tool>(args); only the function's return value enters context.
 *
 * Big upstream results never enter the model context directly: the model can
 * process/filter them inside the sandbox and return only a summary.
 *
 * Sandbox: node:vm context with ONLY `codemode` injected — no process/require/
 * fetch/Node globals. Not a hard security boundary (vm is not a security
 * mechanism), but sufficient for model-authored code that only needs our tools.
 */
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { normalizeCode, sanitizeToolName } from './codemode-util.js';
import { searchEntries } from './catalog.js';
import {
  unwrapResult,
  formatToolSummary,
  formatToolDetail,
  truncateResultValue,
  truncateResponseText,
} from './tool-format.js';

const DEFAULT_MAX_CALLS = 50; // max upstream tool calls per execute() (was 30)
const DEFAULT_MAX_RESULT_CHARS = 20000; // cap the execute() return value
const EXEC_TIMEOUT_MS = 30000;
const ARG_FIELD_MAX = 200; // cap each arg field in the audit trail (prevents context leak)
const DEFAULT_MAX_LOG_CHARS = 4000; // cap serialized console logs so a chatty script cannot flood context

const READ_ONLY_TOOL_RE =
  /^(get|list|search|query|read|fetch|view|describe|find|count|aggregate|check)_|^notion-(get|list|search|query|memory)/i;

/** Conservative read-only detection: upstream annotation wins, then name hint. */
export function isReadOnlyTool(t) {
  return t?.annotations?.readOnlyHint === true || READ_ONLY_TOOL_RE.test(String(t?.tool ?? ''));
}

/** Summarize tool-call args for the audit trail — never echo large payloads
 * (e.g. push_files with full source of 10 files) back into model context.
 * Cycle-safe (#41): a self-referential array (`a.push(a)`) used to recurse
 * through `sample` forever and blow the stack. We track the current path in a
 * WeakSet (works for cross-realm objects too) and cap nesting depth, emitting
 * a short placeholder instead. */
function summarizeArgs(args, max = ARG_FIELD_MAX, seen = new WeakSet(), depth = 0) {
  if (args === null || args === undefined) return null;
  if (typeof args === 'string') return args.length > max ? `<string len=${args.length}>` : args;
  if (typeof args !== 'object') return args;
  if (seen.has(args)) return '[Circular]';
  if (depth >= 8) return '[Deeply nested]';
  seen.add(args);
  try {
    if (Array.isArray(args)) {
      return { __array: args.length, sample: args.slice(0, 3).map((x) => summarizeArgs(x, max, seen, depth + 1)) };
    }
    const out = {};
    for (const [k, v] of Object.entries(args)) {
      if (typeof v === 'string' && v.length > max) out[k] = `<string len=${v.length}>`;
      else if (Array.isArray(v)) out[k] = { __array: v.length };
      else if (v && typeof v === 'object') out[k] = { __object: Object.keys(v).length };
      else out[k] = v;
    }
    return out;
  } finally {
    seen.delete(args);
  }
}

/** Deterministic, cycle-safe key for dedup (independent of object key order). */
function stableKey(value, seen = new Set()) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (seen.has(value)) return '"[circular]"';
  seen.add(value);
  let out;
  if (Array.isArray(value)) {
    out = `[${value.map((v) => stableKey(v, seen)).join(',')}]`;
  } else {
    out = `{${Object.keys(value).sort()
      .map((k) => `${JSON.stringify(k)}:${stableKey(value[k], seen)}`).join(',')}}`;
  }
  seen.delete(value);
  return out;
}

/** Compact one-line tool summary for codemode.listTools(). */
function listSummary(t) {
  const desc = String(t.description ?? '').replace(/\s+/g, ' ').trim();
  const summary = desc.length > 80 ? `${desc.slice(0, 79)}…` : desc;
  return {
    name: t.name,
    service: t.server ?? '',
    readOnly: isReadOnlyTool(t),
    summary,
  };
}

/**
 * Bound captured console logs before they can re-enter the model context.
 * A single `console.log(bigObject)` used to be pushed verbatim; we reuse the
 * structured truncator so the array stays valid JSON and carries a
 * `--- TRUNCATED ---` marker instead of silently losing entries.
 */
function boundLogs(logs, maxChars = DEFAULT_MAX_LOG_CHARS) {
  if (!Array.isArray(logs)) return logs;
  return truncateResultValue(logs, { maxChars });
}

/**
 * Describe a thrown value cross-realm-safe: vm errors fail `instanceof Error`.
 * (#12) Also lift the script location out of a vm stack (`evalmachine.<anonymous>:
 * LINE:COL`). `line`/`column` are defined non-enumerable so the legacy
 * `{message, type}` shape stays byte-identical for direct callers and for
 * `JSON.stringify(wire.error)`; the catch path surfaces the location in the
 * human-readable `result` string, which is what the model actually reads.
 */
function errorInfo(err) {
  const errLike = err && typeof err === 'object' &&
    typeof err.message === 'string' && typeof err.name === 'string';
  const info = (err instanceof Error || errLike)
    ? { message: err.message, type: err.name || err.constructor?.name || 'Error' }
    : { message: String(err), type: 'UnknownError' };
  const stack = typeof err?.stack === 'string' ? err.stack : '';
  // Only attribute a *script* location when the throw site itself is in the vm
  // script. Host-side errors (arg validation, tool-call budget, upstream
  // failures) merely pass through a vm frame in their call stack; tagging
  // those would change their legacy message and break callers/tests.
  const firstFrame = stack.split('\n').find((line) => line.trim().startsWith('at ')) ?? '';
  const loc = /evalmachine\.<anonymous>:(\d+):(\d+)/.exec(firstFrame);
  if (loc) {
    Object.defineProperty(info, 'line', { value: Number(loc[1]), enumerable: false, configurable: true });
    Object.defineProperty(info, 'column', { value: Number(loc[2]), enumerable: false, configurable: true });
  }
  return info;
}

/**
 * Build the sandbox output object.
 *
 * Direct callers (and the existing tests) read `out.result` as a string, so
 * that field is kept. `server.js` serializes the whole handler result exactly
 * once with JSON.stringify(); a plain string `result` would therefore land in
 * the envelope as a JSON-encoded string (double serialization). `toJSON()`
 * makes the model receive `result` as the real structured value on the wire.
 */
function makeOutput({ legacyResult, structuredResult, logs, toolCalls, isError = false }) {
  const out = {
    result: legacyResult,
    logs,
    toolCalls,
    ...(isError ? { isError: true } : {}),
  };
  out.toJSON = () => ({
    result: structuredResult,
    logs,
    toolCalls,
    ...(isError ? { isError: true } : {}),
  });
  return out;
}

/**
 * Cloudflare-style `toModelOutput` projection (see @cloudflare/codemode 0.5.6,
 * dist/index.js:1774): the durable call log (`toolCalls`) and the sandbox
 * `logs` are audit-only and must never reach the model. Everything else —
 * including `isError`, `status` and typed `error` — is preserved.
 *
 * This is applied by the execute handlers at the tool boundary, after
 * runInSandbox() has produced its full internal result. Direct callers of
 * runInSandbox() still see `toolCalls`/`logs` for audit and diagnostics.
 */
export function toModelOutput(output) {
  if (output === null || typeof output !== 'object' || Array.isArray(output)) {
    return { result: toJsonSafe(output) };
  }
  // The original `toJSON()` hook must be dropped too: leaving it on the object
  // would re-invoke makeOutput()'s serializer during server.js's JSON.stringify
  // and resurrect logs/toolCalls on the wire. Spreading rather than whitelisting
  // keeps fields added by other fixes (status/error) intact.
  const { toolCalls, calls, logs, toJSON, ...rest } = output;
  void toolCalls; void calls; void logs; void toJSON;
  return toJsonSafe(rest); // cycles / BigInt → {error}, never throws
}

/** JSON-only copy of a wire value; mirrors Cloudflare's `toJSONValue` helper. */
function toJsonSafe(value) {
  try {
    const text = JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? v.toString() : v));
    return text === undefined ? null : JSON.parse(text);
  } catch (err) {
    return { result: `Result could not be serialized for the model: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/* ------------------------------------------------------------------ *
 * Lightweight pre-flight arg validation (Gemini suggestion 2)
 *
 * Only two layers: (1) required fields present, (2) top-level primitive type
 * for fields whose schema declares a basic type. This is intentionally NOT a
 * full JSON Schema validator: enum/format/items/nested schemas, multi-types and
 * fields the schema never mentions are left to the upstream. The upstream is
 * the authority; we only reject what it would certainly reject anyway, so a
 * bad call fails in one round with an actionable message instead of after an
 * upstream 400 + retry.
 * ------------------------------------------------------------------ */
const BASIC_ARG_TYPES = new Set(['string', 'number', 'boolean', 'array', 'object']);
const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

/** Cross-realm-safe type name for the "got" part of an error message. */
function argType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array'; // Array.isArray works across vm realms
  return typeof value; // string | number | boolean | object | function | ...
}

/** Return the primitive name we check, or null to skip (leave it to upstream). */
function expectedArgType(def) {
  if (!def || typeof def !== 'object') return null;
  const type = def.type;
  if (type === 'integer') return 'number'; // integral-ness is upstream's job, not ours
  return typeof type === 'string' && BASIC_ARG_TYPES.has(type) ? type : null;
}

/**
 * Validate `codemode.<tool>(args)` against the tool's inputSchema.
 * Throws an actionable Error; the sandbox catch turns it into an execute error
 * the model can fix in a single round.
 */
export function validateToolArgs(tool, args) {
  const schema = tool?.inputSchema;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return;
  const name = tool?.name ?? tool?.tool ?? 'unknown';

  // Odd arg shapes are not our business — pass them through to the upstream.
  if (args !== null && (typeof args !== 'object' || Array.isArray(args))) return;
  const a = args ?? {};

  const props = schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)
    ? schema.properties
    : {};
  const required = Array.isArray(schema.required) ? schema.required : [];

  const missing = required.filter((field) => !hasOwn(a, field) || a[field] === undefined);
  if (missing.length > 0) {
    throw new Error(`tool ${name} requires fields: ${missing.join(', ')}`);
  }

  for (const [field, def] of Object.entries(props)) {
    if (!hasOwn(a, field) || a[field] === undefined) continue; // absent (optional) field
    const expected = expectedArgType(def);
    if (expected === null) continue; // unknown/multi-type: upstream decides
    const actual = argType(a[field]);
    if (actual !== expected) {
      throw new Error(`tool ${name} field '${field}' expected ${expected}, got ${actual}`);
    }
  }
}

/* ------------------------------------------------------------------ *
 * Sandbox hardening helpers
 * ------------------------------------------------------------------ */

/**
 * (#47/#59) Lightweight stopgap for injected host values. `node:vm` is NOT a
 * security boundary, and `codeGeneration.strings:false` does not stop a model
 * that has a host-realm function: `fn.constructor` is the host `Function`, so
 * `fn.constructor('return process')()` hands over `process`. Wrap every value
 * we inject with a Proxy that hides `constructor` on `get`. Calls, `new`,
 * `.prototype`, and every other property forward to the original, so
 * TextEncoder/URL/console/codemode keep working exactly as before.
 *
 * This is deliberately narrow: see docs/SANDBOX-SECURITY.md — the sandbox is
 * "防意外不防恶意". It cuts the trivial `.constructor('return process')()`
 * path, not every possible cross-realm gadget.
 */
function safeHostValue(value) {
  if (value === null || (typeof value !== 'function' && typeof value !== 'object')) return value;
  return new Proxy(value, {
    get(target, prop, receiver) {
      if (prop === 'constructor') return undefined;
      return Reflect.get(target, prop, receiver);
    },
  });
}

/** (#46) Host-side wall-clock deadline; the vm `timeout` only bounds the
 * synchronous slice, while `await callTool()` runs in the host realm with no
 * deadline of its own. The timer is always cleared so tests never hang. */
function withDeadline(promise, ms, message) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/** Uniform structured error output, shared by the vm error path and the
 * (#46) host deadline path. */
function makeErrorOutput(err, logs, toolCalls) {
  const info = errorInfo(err);
  // Keep the legacy message prefix byte-for-byte for existing callers/tests;
  // append the caught script location only when a vm stack provided one.
  const rawMessage = err instanceof Error ? err.message : String(err);
  const loc = info.line != null ? ` (script line ${info.line}:${info.column})` : '';
  const message = `execute error: ${rawMessage}${loc}`;
  const out = makeOutput({
    legacyResult: message,
    structuredResult: message,
    logs: boundLogs(logs),
    toolCalls,
    isError: true,
  });
  out.status = 'error';
  out.error = info;
  const baseToJSON = out.toJSON;
  out.toJSON = () => ({ ...baseToJSON(), status: 'error', error: info });
  return out;
}

/**
 * Run normalized model code in a VM with a `codemode` proxy whose methods call
 * upstream tools. @returns { result, logs, toolCalls }.
 */
export function runInSandbox({ code, tools, callTool, maxCalls = DEFAULT_MAX_CALLS, maxResultChars = DEFAULT_MAX_RESULT_CHARS, timeout = EXEC_TIMEOUT_MS, totalTimeout, unavailableTools = [] }) {
  const normalized = normalizeCode(code);
  const logs = [];
  const toolCalls = [];
  // In-process dedup cache, scoped to THIS execute() run. Identical read-only
  // calls (same tool + same args) reuse the first result and do not consume
  // another call from the budget.
  const cache = new Map();
  let calls = 0;

  // Map sanitized JS identifier -> original tool descriptor.
  const byIdent = new Map();
  for (const t of tools) byIdent.set(sanitizeToolName(t.name), t);

  const codemode = {};
  // Tools excluded by execute_read's filter are registered as stubs that throw
  // an actionable message — otherwise the model gets a cryptic "not a function"
  // even though search() showed the tool. (Real regression from v2 exploration.)
  for (const tool of unavailableTools ?? []) {
    const ident = sanitizeToolName(tool.name);
    if (!byIdent.has(ident)) {
      codemode[ident] = safeHostValue(async () => {
        throw new Error(`${tool.name} is a write tool and unavailable in execute_read; use execute() instead`);
      });
    }
  }
  for (const [ident, tool] of byIdent) {
    codemode[ident] = safeHostValue(async (args) => {
      // Pre-flight before any budget/audit/dedup bookkeeping or upstream call:
      // cheap, actionable errors beat an upstream 400 + another model round.
      validateToolArgs(tool, args);
      const dedupeKey = isReadOnlyTool(tool)
        ? `${tool.server ?? ''}::${tool.tool ?? ''}::${stableKey(args ?? {})}`
        : null;
      if (dedupeKey !== null && cache.has(dedupeKey)) return cache.get(dedupeKey);

      calls += 1;
      if (calls > maxCalls) throw new Error(`tool call limit (${maxCalls}) exceeded`);
      toolCalls.push({ name: tool.name, args: summarizeArgs(args) });
      const raw = await callTool(tool.server, tool.tool, args ?? {});
      // Throw on upstream errors and auto-parse JSON results so model scripts
      // can use the return value directly without JSON.parse(content[0].text).
      const value = unwrapResult(raw);
      if (dedupeKey !== null) cache.set(dedupeKey, value);
      return value;
    });
  }
  // Discovery helpers available inside the sandbox.
  codemode.listTools = safeHostValue((options) => {
    const opts = options && typeof options === 'object' ? options : {};
    let list = tools;
    if (typeof opts.service === 'string' && opts.service) {
      list = list.filter((t) => (t.server ?? '') === opts.service);
    }
    const entries = list.map(listSummary);
    // brief:true -> name + service only; default -> name/service/readOnly/summary.
    return opts.brief ? entries.map(({ name, service }) => ({ name, service })) : entries;
  });
  // (#42) One shape everywhere: also expose the outer search tool's
  // {matches,total,hint} fields inside the sandbox. We keep it a real Array
  // (with named props) so pre-existing scripts using Array.isArray()/.length
  // keep working; JSON on the wire still serializes it as the matches array.
  codemode.search = safeHostValue((query) => {
    const res = searchEntries(tools, String(query ?? ''), { limit: 5 });
    const matches = res.matches.map(formatToolSummary);
    matches.matches = matches.slice();
    matches.total = res.total;
    matches.hint = res.hint;
    return matches;
  });
  // Expose remaining budget so model scripts can batch/paginate safely.
  codemode.remainingCalls = safeHostValue(() => Math.max(0, maxCalls - calls));

  const pushLog = (...a) => logs.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  // Lightweight crypto helper: digest(algo, data) -> hex. Models often need
  // SHA-1/SHA-256 for content hashing and previously hand-rolled JS SHA impls.
  const crypto = safeHostValue({
    digest: safeHostValue((algo, data, encoding = 'hex') =>
      createHash(String(algo).toLowerCase())
        .update(typeof data === 'string' ? data : Buffer.from(data))
        .digest(encoding)),
    createHash: safeHostValue((algo) => createHash(String(algo).toLowerCase())), // Node hash object: .update().digest()
  });
  // global search alias: models often write search() instead of codemode.search()
  // (already constructor-shielded via safeHostValue above).
  const search = codemode.search;

  // (#47) Every value crossing into the sandbox is wrapped so `.constructor`
  // never resolves to the host Function. Normal calls/`new` are unaffected.
  // Buffer itself is still NOT exposed: encoding helpers close over it.
  const sandbox = {
    codemode: safeHostValue(codemode),
    search,
    crypto,
    console: safeHostValue({
      log: safeHostValue(pushLog),
      info: safeHostValue(pushLog),
      debug: safeHostValue(pushLog),
      warn: safeHostValue((...a) => logs.push('WARN ' + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '))),
      error: safeHostValue((...a) => logs.push('ERROR ' + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '))),
    }),
    JSON: safeHostValue(JSON), Math: safeHostValue(Math),
    Date: safeHostValue(Date), Array: safeHostValue(Array), Object: safeHostValue(Object),
    String: safeHostValue(String), Number: safeHostValue(Number), Boolean: safeHostValue(Boolean),
    Promise: safeHostValue(Promise), Map: safeHostValue(Map), Set: safeHostValue(Set),
    Symbol: safeHostValue(Symbol), RegExp: safeHostValue(RegExp),
    Error: safeHostValue(Error), TypeError: safeHostValue(TypeError), RangeError: safeHostValue(RangeError),
    parseInt: safeHostValue(parseInt), parseFloat: safeHostValue(parseFloat),
    isNaN: safeHostValue(isNaN), isFinite: safeHostValue(isFinite),
    encodeURIComponent: safeHostValue(encodeURIComponent), decodeURIComponent: safeHostValue(decodeURIComponent),
    // Web standard APIs the model expects. Wrapped above; the object itself
    // stays outside the sandbox. Encoding helpers close over host Buffer but
    // Buffer is not reachable from sandbox code.
    TextEncoder: safeHostValue(TextEncoder), TextDecoder: safeHostValue(TextDecoder),
    URL: safeHostValue(URL), URLSearchParams: safeHostValue(URLSearchParams),
    atob: safeHostValue((s) => Buffer.from(String(s), 'base64').toString('utf8')),
    btoa: safeHostValue((s) => Buffer.from(String(s), 'utf8').toString('base64')),
    setTimeout: safeHostValue(setTimeout), clearTimeout: safeHostValue(clearTimeout),
  };
  const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });

  const script = new vm.Script(`(async () => { const __fn = (${normalized}); return await __fn(); })()`, { timeout });
  const run = Promise.resolve(script.runInContext(context, { timeout }))
    .then((sandboxReturn) => {
      // Model-facing value: structured truncation keeps the result valid JSON
      // of the same shape, with `--- TRUNCATED ---` markers at the cut points.
      const structuredResult = truncateResultValue(sandboxReturn, { maxChars: maxResultChars });
      // Legacy string view kept for direct callers of runInSandbox().
      let legacy;
      try { legacy = typeof sandboxReturn === 'string' ? sandboxReturn : JSON.stringify(sandboxReturn ?? null); }
      catch { legacy = String(sandboxReturn); }
      const legacyResult = truncateResponseText(legacy ?? '', { maxChars: maxResultChars });
      return makeOutput({ legacyResult, structuredResult, logs: boundLogs(logs), toolCalls });
    });
  // (#46) A hung host-side callTool() would otherwise keep the whole round
  // open forever (the vm timeout only covers synchronous script execution).
  // 2x the vm timeout is generous enough not to race normal runs; the timer
  // is always cleared, and any error becomes the same structured result as a
  // sandbox throw. A tool throwing inside sandbox code (e.g. unwrapResult on
  // isError) must stay a normal execute result, not kill the process.
  const totalMs = totalTimeout ?? Math.max(timeout * 2, 1000);
  return withDeadline(run, totalMs, `execute overall timeout (${totalMs}ms)`)
    .catch((err) => makeErrorOutput(err, logs, toolCalls));
}

/**
 * Build the two Code Mode MCP tools bound to an UpstreamManager.
 */
export function createCodeModeTools(upstreamManager, options = {}) {
  const tools = upstreamManager.getEntries?.() ?? [];
  const sanitized = tools.map((t) => ({ ...t, ident: sanitizeToolName(t.name) }));

  const searchTool = {
    name: 'search',
    description: 'Search upstream tools. Two modes: (1) Plain keywords -> a ranked list of matching tools with compact param signatures (name!: required). (2) To see one tool\'s full inputSchema, pass EXACTLY "select:<name>" where <name> is a tool name copied from a search result (e.g. "select:github__issue_write"). Do NOT put task descriptions or phrases after "select:" — only an exact tool name works; for anything else use plain keyword search. Prefix a service name (e.g. "vercel ...") to focus on that service.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Keywords describing the capability you need' }, limit: { type: 'integer', minimum: 1, maximum: 10 } },
      required: ['query'],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    handler: async (args) => {
      const limit = Number.isFinite(args?.limit) ? args.limit : 8;
      const query = String(args?.query ?? '');
      const isSelect = /^select\s*:/i.test(query.trim());
      let res = searchEntries(tools, query, { limit });
      // Empty-result fallback: try the longest single query token, then a service
      // prefix if present — so the model gets SOMETHING instead of a dead end.
      let hint = res.hint;
      if (!isSelect && res.matches.length === 0 && query.trim()) {
        const tokens = query.trim().toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3).sort((a, b) => b.length - a.length);
        const service = tokens.find((t) => ['github', 'notion', 'linear', 'vercel'].includes(t));
        for (const probe of (service ? [service, ...tokens] : tokens).slice(0, 3)) {
          const retry = searchEntries(tools, probe, { limit });
          if (retry.matches.length) {
            res = retry;
            hint = `No exact match for "${query}"; showing closest for "${probe}".`;
            break;
          }
        }
      }
      return {
        matches: res.matches.map(isSelect ? formatToolDetail : formatToolSummary),
        total: res.total,
        hint,
      };
    },
  };

  const makeExecute = (name, readOnly) => ({
    name,
    description: (readOnly
      ? 'Write JavaScript to call READ-ONLY upstream tools (get/list/search/query) via codemode.<tool>(args). This tool is annotated read-only so the client may prompt less; it runs the same sandbox as execute(). Only your return value enters the conversation. Example: async () => { const r = await codemode.github__search_repositories({query:"x"}); return r.total_count; }'
      : 'Write JavaScript to call upstream tools via codemode.<tool>(args). Only your returned value enters the conversation — process large results inside code and return a summary. Available: codemode.listTools(), codemode.search(q), codemode.remainingCalls(), global search(), TextEncoder/atob/URL/crypto, and one method per upstream tool. Example: async () => { const r = await codemode.github__search_repositories({query:"x"}); return r.total_count; }'),
    inputSchema: {
      type: 'object',
      properties: { code: { type: 'string', description: 'An async arrow function that calls codemode tools and returns a result.' } },
      required: ['code'],
    },
    annotations: readOnly
      ? { readOnlyHint: true, destructiveHint: false, openWorldHint: true }
      : { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    handler: async (args) => {
      const code = String(args?.code ?? '');
      const usable = readOnly ? sanitized.filter(isReadOnlyTool) : sanitized;
      const unavailable = readOnly ? sanitized.filter((t) => !isReadOnlyTool(t)) : [];
      const full = await runInSandbox({
        code,
        tools: usable,
        unavailableTools: unavailable,
        callTool: (server, tool, a) => upstreamManager.callTool(server, tool, a),
        maxCalls: options.maxCalls,
        maxResultChars: options.maxResultChars,
      });
      // MakeOutput() attaches a toJSON() that emits the full audit payload;
      // unwrap it first so the projection below is what server.js serializes.
      const wire = typeof full.toJSON === 'function' ? full.toJSON() : full;
      return toModelOutput(wire); // toolCalls + logs never enter model context
    },
  });

  // Two execute tools: read-only (no approval friction) and full (read+write).
  return [searchTool, makeExecute('execute_read', true), makeExecute('execute', false)];
}
