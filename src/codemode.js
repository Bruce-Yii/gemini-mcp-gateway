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
 * Sandbox: Vercel `run` SDK — a hardened QuickJS context inside a worker
 * thread. Guest code has no process/require/fetch/Node globals and its built-in
 * prototypes are frozen; only the host functions declared below are reachable.
 * This is a real engine-level boundary (unlike node:vm), so `.constructor`
 * cannot reach the host realm.
 */
import { createRunner } from 'run';
import { createHash } from 'node:crypto';
import { normalizeCode, sanitizeToolName } from './codemode-util.js';
import { normalizeToolArguments } from './sanitize.js';
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

// RC-D7: brief boundary/refusal guidance appended to BOTH execute tool
// descriptions, so the model knows what to do when it cannot/should not comply
// instead of forcing a tool call. Kept as one shared constant to avoid drift.
const EXEC_BOUNDARY_GUIDANCE = " Boundary: if the task exceeds the available tools' capabilities, requires an external service, or information is insufficient, explicitly state it cannot be done and explain why — do not force tool calls; refuse harmful requests.";

/**
 * Guest-side compatibility layer, injected as a single function body prefix.
 *
 * QuickJS has no TextEncoder/TextDecoder/URL/atob/crypto/timers, `console`
 * only implements `log`, and run-js-v1 drops named properties on arrays
 * (which would break codemode.search's array-with-named-props contract).
 * All of that is reconstructed here. Every exposed value is passed through
 * __dshHide() so `.constructor` never resolves to the guest Function either
 * — the isolation is real, but this also keeps the historical probes green.
 *
 * Line 1 deliberately creates a sentinel Error: its `run.js:N` frame lets the
 * host calibrate the SDK's internal wrapper offset for error line numbers.
 */
const GUEST_PRELUDE = [
  'const __dshCal = (() => { const m = /run\\.js:(\\d+)/.exec(String(new Error().stack || "")); return m ? Number(m[1]) : 1; })();',
  'const __dshHide = (f) => { try { Object.defineProperty(f, "constructor", { value: undefined, configurable: true }); } catch (_) {} return f; };',
  'const __dshInvoke = (name, args) => { const r = __bridge.invoke(name, args); if (r && r.__hostError) { const e = new Error(r.message); e.name = r.type; e.__dshHostOrigin = true; throw e; } return r.value; };',
  'const __dshStr = (x) => { if (typeof x === "string") return x; try { const s = JSON.stringify(x); return s === undefined ? "" : s; } catch (_) { return String(x); } };',
  'const console = __dshHide({ log: __dshHide((...a) => __dshInvoke("log", ["", a.map(__dshStr)])), info: __dshHide((...a) => __dshInvoke("log", ["", a.map(__dshStr)])), debug: __dshHide((...a) => __dshInvoke("log", ["", a.map(__dshStr)])), warn: __dshHide((...a) => __dshInvoke("log", ["WARN", a.map(__dshStr)])), error: __dshHide((...a) => __dshInvoke("log", ["ERROR", a.map(__dshStr)])) });',
  'const atob = __dshHide((s) => __dshInvoke("atob", [s]));',
  'const btoa = __dshHide((s) => __dshInvoke("btoa", [s]));',
  'const crypto = __dshHide({ digest: __dshHide((algo, data, enc) => __dshInvoke("digest", [algo, data, enc === undefined ? "hex" : enc])), createHash: __dshHide((algo) => { const parts = []; return { update(d) { parts.push(d); return this; }, digest(enc) { return __dshInvoke("digest", [algo, parts.map(__dshStr).join(""), enc === undefined ? "hex" : enc]); } }; }) });',
  'class TextEncoder { encode(s) { return new Uint8Array(__dshInvoke("encode", [String(s)])); } }',
  'class TextDecoder { decode(bytes) { return __dshInvoke("decode", [Array.from(bytes || [])]); } }',
  '__dshHide(TextEncoder); __dshHide(TextDecoder); __dshHide(TextEncoder.prototype); __dshHide(TextDecoder.prototype);',
  'class URLSearchParams { constructor(init) { this._p = {}; if (typeof init === "string") { const q = init.charAt(0) === "?" ? init.slice(1) : init; for (const pair of q.split("&")) { if (!pair) continue; const i = pair.indexOf("="); const k = i < 0 ? pair : pair.slice(0, i); const v = i < 0 ? "" : pair.slice(i + 1); try { this._p[decodeURIComponent(k.replace(/\\+/g, " "))] = decodeURIComponent(v.replace(/\\+/g, " ")); } catch (_) { this._p[k] = v; } } } else if (init && typeof init === "object") { for (const k of Object.keys(init)) this._p[k] = String(init[k]); } } get(k) { return Object.prototype.hasOwnProperty.call(this._p, k) ? this._p[k] : null; } has(k) { return Object.prototype.hasOwnProperty.call(this._p, k); } set(k, v) { this._p[k] = String(v); } toString() { return Object.keys(this._p).map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(this._p[k])).join("&"); } }',
  'class URL { constructor(input) { const s = String(input); const m = /^([A-Za-z][A-Za-z0-9+.-]*):\\/\\/([^/?#]*)([^?#]*)(\\?[^#]*)?(#.*)?$/.exec(s); if (m) { this.protocol = m[1] + ":"; this.host = m[2]; this.pathname = m[3] || "/"; this.search = m[4] || ""; this.hash = m[5] || ""; } else { this.protocol = ""; this.host = ""; this.pathname = s; this.search = ""; this.hash = ""; } this.href = s; this.searchParams = new URLSearchParams(this.search); } toString() { return this.href; } }',
  '__dshHide(URLSearchParams); __dshHide(URL); __dshHide(URLSearchParams.prototype); __dshHide(URL.prototype);',
  'const __dshSearch = __dshHide((q) => { const raw = __dshInvoke("search", [q == null ? "" : String(q)]); const matches = raw.matches.slice(); matches.matches = matches.slice(); matches.total = raw.total; matches.hint = raw.hint; return __dshHide(matches); });',
  'const search = __dshSearch;',
  'const codemode = __dshHide({});',
  'codemode.listTools = __dshHide((options) => __dshInvoke("listTools", [options]));',
  'codemode.search = __dshSearch;',
  'codemode.remainingCalls = __dshHide(() => __dshInvoke("remainingCalls", []));',
  // QuickJS has no event loop/timers. A microtask-based shim keeps the common
  // `await new Promise(r => setTimeout(r, 0))` pattern working without blocking
  // the host event loop (a host-side sleep would freeze the whole MCP server).
  'const __dshTimerIds = {}; let __dshTimerSeq = 0;',
  'const setTimeout = __dshHide((fn, ms, ...args) => { const id = ++__dshTimerSeq; __dshTimerIds[id] = true; Promise.resolve().then(() => { if (__dshTimerIds[id]) { try { fn(...args); } catch (_) {} } }); return id; });',
  'const clearTimeout = __dshHide((id) => { delete __dshTimerIds[id]; });',
].join('\n');
const GUEST_PREFIX_LINES = GUEST_PRELUDE.split('\n').length;

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
 * (#12) Also lift the script location out of the guest error stack. The `run`
 * SDK reports `run.js:LINE:COL`; the guest prelude resolves it to the original
 * model-code line before it reaches here (the vm-era fallback is kept for
 * compatibility). `line`/`column` are defined non-enumerable so the legacy
 * `{message, type}` shape stays byte-identical for direct callers and for
 * `JSON.stringify(wire.error)`; the catch path surfaces the location in the
 * human-readable `result` string, which is what the model actually reads.
 */
function errorInfo(err, scriptLoc) {
  const errLike = err && typeof err === 'object' &&
    typeof err.message === 'string' && typeof err.name === 'string';
  const info = (err instanceof Error || errLike)
    ? { message: err.message, type: err.name || err.constructor?.name || 'Error' }
    : { message: String(err), type: 'UnknownError' };
  // Only attribute a *script* location when the throw site itself is in guest
  // code. Host-side errors (arg validation, tool-call budget, upstream
  // failures) are marked by the guest bridge wrapper and carry no location;
  // tagging those would change their legacy message and break callers/tests.
  const loc = scriptLoc ?? (() => {
    const stack = typeof err?.stack === 'string' ? err.stack : '';
    const firstFrame = stack.split('\n').find((line) => line.trim().startsWith('at ')) ?? '';
    return /evalmachine\.<anonymous>:(\d+):(\d+)/.exec(firstFrame) ?? null;
  })();
  if (loc) {
    const line = Array.isArray(loc) ? loc[1] : loc.line;
    const column = Array.isArray(loc) ? loc[2] : loc.column;
    Object.defineProperty(info, 'line', { value: Number(line), enumerable: false, configurable: true });
    Object.defineProperty(info, 'column', { value: Number(column), enumerable: false, configurable: true });
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
  // ROOT-CAUSE FIX (RC-D3): normalize camelCase aliases BEFORE validating,
  // otherwise a required snake_case field filled as camelCase is falsely
  // reported missing and normalization in upstreams.callTool never runs.
  // (callTool normalizes again — idempotent — so wire args stay correct.)
  const a = normalizeToolArguments(args ?? {}, schema);

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

/** (#46) Host-side wall-clock deadline; the vm `timeout` only bounds the
 * synchronous slice, while `await callTool()` runs in the host realm with no
 * deadline of its own. The timer is always cleared so tests never hang. */
function withDeadline(promise, ms, message, onTimeout) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try { onTimeout?.(); } catch { /* never let cancellation mask the error */ }
      reject(new Error(message));
    }, ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/** Uniform structured error output, shared by the sandbox error path and the
 * (#46) host deadline path. */
function makeErrorOutput(err, logs, toolCalls, scriptLoc) {
  const info = errorInfo(err, scriptLoc);
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
 * RC-D4: the ONE shared search routine, used by both the outer `search` MCP
 * handler and the in-sandbox `codemode.search`.
 *
 * Root cause of RC-D4: there were two copies of the search call and only the
 * outer one had the empty-result probe, so they drifted apart. Routing both
 * through this function keeps their fallback behaviour identical.
 *
 * `select:` queries bypass the fallback (exact-name lookup only); the caller
 * decides how to render them. The sandbox never issues `select:`, preserving
 * its historical "no select support" contract (it always uses summaries).
 *
 * @param {Array} tools tool descriptors to search
 * @param {string} query raw query text
 * @param {number} limit max matches
 * @returns {{ res: object, hint: string|undefined, isSelect: boolean }}
 */
export function searchWithFallback(tools, query, limit = 8) {
  const q = String(query ?? '');
  const isSelect = /^select\s*:/i.test(q.trim());
  let res = searchEntries(tools, q, { limit });
  let hint = res.hint;
  // Empty-result fallback: the longest token first, but a known service prefix
  // wins — so a dead-end query like "+github zzzz" still surfaces the closest
  // github tools instead of returning nothing.
  if (!isSelect && res.matches.length === 0 && q.trim()) {
    const tokens = q.trim().toLowerCase().split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3)
      .sort((a, b) => b.length - a.length);
    const service = tokens.find((t) => ['github', 'notion', 'linear', 'vercel'].includes(t));
    for (const probe of (service ? [service, ...tokens] : tokens).slice(0, 3)) {
      const retry = searchEntries(tools, probe, { limit });
      if (retry.matches.length) {
        res = retry;
        hint = `No exact match for "${q}"; showing closest for "${probe}".`;
        break;
      }
    }
  }
  return { res, hint, isSelect };
}

/**
 * Run normalized model code in a hardened QuickJS sandbox (Vercel `run` SDK).
 * The `codemode` global is assembled by the guest prelude from a single host
 * bridge; all counting/validation/audit stays on the host side.
 * @returns { result, logs, toolCalls } with the unchanged legacy output shape.
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

  const hostErrorMessage = (err) => (err instanceof Error || (err && typeof err.message === 'string'))
    ? String(err.message) : String(err);
  const hostErrorType = (err) => (err instanceof Error || (err && typeof err.name === 'string'))
    ? String(err.name || 'Error') : 'UnknownError';

  // Every capability the guest can reach is a member of this one registry.
  // Errors are returned as DATA (not thrown) because `run` redacts host error
  // messages to "Host function failed."; the guest wrapper reconstructs a real
  // guest Error with the original message so try/catch and errorInfo() keep
  // their historical, actionable text.
  const registry = {
    log: (prefix, parts) => {
      logs.push(`${prefix ? prefix + ' ' : ''}${parts.join(' ')}`);
    },
    atob: (s) => Buffer.from(String(s), 'base64').toString('utf8'),
    btoa: (s) => Buffer.from(String(s), 'utf8').toString('base64'),
    encode: (s) => Array.from(Buffer.from(String(s), 'utf8')),
    decode: (bytes) => Buffer.from(Array.from(bytes ?? [])).toString('utf8'),
    digest: (algo, data, encoding = 'hex') =>
      createHash(String(algo).toLowerCase())
        .update(typeof data === 'string' ? data : Buffer.from(data))
        .digest(encoding),
    listTools: (options) => {
      const opts = options && typeof options === 'object' ? options : {};
      let list = tools;
      if (typeof opts.service === 'string' && opts.service) {
        list = list.filter((t) => (t.server ?? '') === opts.service);
      }
      const entries = list.map(listSummary);
      // brief:true -> name + service only; default -> name/service/readOnly/summary.
      return opts.brief ? entries.map(({ name, service }) => ({ name, service })) : entries;
    },
    // (#42) Return a plain object: run-js-v1 drops named props on arrays, so
    // the guest prelude rebuilds the array-with-named-props shape.
    // RC-D4: share the exact fallback logic with the outer search handler.
    search: (query) => {
      const { res, hint } = searchWithFallback(tools, query, 5);
      return {
        matches: res.matches.map(formatToolSummary),
        total: res.total,
        hint,
      };
    },
    remainingCalls: () => Math.max(0, maxCalls - calls),
    stub: (name) => {
      throw new Error(`${name} is a write tool and unavailable in execute_read; use execute() instead`);
    },
    tool: async (ident, args) => {
      const tool = byIdent.get(ident);
      if (!tool) throw new Error(`unknown tool: ${ident}`);
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
    },
  };

  const invoke = (name, args) => {
    try {
      const fn = registry[name];
      if (!fn) throw new Error(`unknown bridge function: ${name}`);
      return Promise.resolve()
        .then(() => fn(...(Array.isArray(args) ? args : [])))
        .then(
          (value) => ({ value }),
          (err) => ({ __hostError: 1, message: hostErrorMessage(err), type: hostErrorType(err) }),
        );
    } catch (err) {
      return { __hostError: 1, message: hostErrorMessage(err), type: hostErrorType(err) };
    }
  };

  // Tools excluded by execute_read's filter are registered as stubs that throw
  // an actionable message — otherwise the model gets a cryptic "not a function"
  // even though search() showed the tool. (Real regression from v2 exploration.)
  const toolLines = [];
  for (const tool of unavailableTools ?? []) {
    const ident = sanitizeToolName(tool.name);
    if (!byIdent.has(ident)) {
      toolLines.push(`codemode[${JSON.stringify(ident)}] = __dshHide((args) => __dshInvoke("stub", [${JSON.stringify(tool.name)}]));`);
    }
  }
  for (const ident of byIdent.keys()) {
    toolLines.push(`codemode[${JSON.stringify(ident)}] = __dshHide((args) => __dshInvoke("tool", [${JSON.stringify(ident)}, args]));`);
  }

  // Keep the sentinel on prelude line 1 and the model function immediately
  // after the prelude: code line L therefore lives on source line
  // GUEST_PREFIX_LINES + L (before the SDK's constant wrapper offset).
  const source = [
    GUEST_PRELUDE,
    ...toolLines,
    `const __dshFn = (${normalized});`,
    'return Promise.resolve().then(() => __dshFn()).then(',
    '  (v) => ({ __ok: true, v: v, cal: __dshCal }),',
    '  (e) => ({ __ok: false, cal: __dshCal, err: { message: e != null && e.message !== undefined ? String(e.message) : String(e), type: (e instanceof Error) ? String(e.name || "Error") : "UnknownError", hostOrigin: !!(e && e.__dshHostOrigin), stack: e && e.stack ? String(e.stack) : "" } })',
    ');',
  ].join('\n');

  const totalMs = totalTimeout ?? Math.max(timeout * 2, 1000);
  const controller = new AbortController();
  const runner = createRunner({
    limits: {
      // withDeadline owns the legacy timeout message; give the SDK a little
      // extra wall time so its own RUN_TIMEOUT cannot win that race.
      timeoutMs: totalMs + 100,
      cpuTimeoutMs: Math.max(1, Math.min(timeout, totalMs)),
      maxResultBytes: 16 * 1024 * 1024,
      maxBridgeRequests: 2048,
    },
    syncHostFunctions: { __bridge: { invoke } },
  });

  const run = runner.run({ source, abortSignal: controller.signal }).then((res) => {
    if (res.status !== 'completed') throw new Error(`sandbox run ${res.status}`);
    const env = res.value && typeof res.value === 'object' ? res.value : {};
    const cal = Number(env.cal);
    // The sentinel Error is created on source line 1; its reported line minus
    // one is the SDK's internal wrapper offset (self-calibrating across versions).
    const wrapperOffset = Number.isFinite(cal) && cal > 0 ? cal - 1 : 2;
    if (!env.__ok) {
      const e = env.err && typeof env.err === 'object' ? env.err : {};
      let scriptLoc;
      if (!e.hostOrigin && typeof e.stack === 'string') {
        const m = /run\.js:(\d+):(\d+)/.exec(e.stack);
        if (m) {
          const line = Number(m[1]) - wrapperOffset - GUEST_PREFIX_LINES;
          const column = Number(m[2]);
          if (line > 0 && Number.isFinite(column)) scriptLoc = { line, column };
        }
      }
      const err = new Error(String(e.message ?? ''));
      err.name = String(e.type || 'Error');
      throw Object.assign(err, { __dshScriptLoc: scriptLoc });
    }
    return env.v;
  }).then((sandboxReturn) => {
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
  // open forever. The wall-clock race is unchanged; aborting also lets `run`
  // retire the blocked worker. Any error becomes the same structured result
  // as a sandbox throw, keeping tool calls/logs in the audit trail.
  return withDeadline(run, totalMs, `execute overall timeout (${totalMs}ms)`, () => controller.abort())
    .catch((err) => {
      const scriptLoc = err?.__dshScriptLoc;
      const e = err?.code === 'RUN_TIMEOUT' ? new Error(`execute overall timeout (${totalMs}ms)`) : err;
      return makeErrorOutput(e, logs, toolCalls, scriptLoc);
    });
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
      // RC-D4: delegate to the shared routine so this and the in-sandbox
      // codemode.search cannot drift apart again. select: still bypasses the
      // fallback and is rendered as a full detail (formatToolDetail).
      const { res, hint, isSelect } = searchWithFallback(tools, args?.query ?? '', limit);
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
      : 'Write JavaScript to call upstream tools via codemode.<tool>(args). Only your returned value enters the conversation — process large results inside code and return a summary. Available: codemode.listTools(), codemode.search(q), codemode.remainingCalls(), global search(), TextEncoder/atob/URL/crypto, and one method per upstream tool. Example: async () => { const r = await codemode.github__search_repositories({query:"x"}); return r.total_count; }') + EXEC_BOUNDARY_GUIDANCE,
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
