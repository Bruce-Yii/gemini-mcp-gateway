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
 * (e.g. push_files with full source of 10 files) back into model context. */
function summarizeArgs(args, max = ARG_FIELD_MAX) {
  if (args === null || args === undefined) return null;
  if (typeof args === 'string') return args.length > max ? `<string len=${args.length}>` : args;
  if (Array.isArray(args)) {
    return { __array: args.length, sample: args.slice(0, 3).map((x) => summarizeArgs(x, max)) };
  }
  if (typeof args === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(args)) {
      if (typeof v === 'string' && v.length > max) out[k] = `<string len=${v.length}>`;
      else if (Array.isArray(v)) out[k] = { __array: v.length };
      else if (v && typeof v === 'object') out[k] = { __object: Object.keys(v).length };
      else out[k] = v;
    }
    return out;
  }
  return args;
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

/** Describe a thrown value cross-realm-safe: vm errors fail `instanceof Error`. */
function errorInfo(err) {
  const errLike = err && typeof err === 'object' &&
    typeof err.message === 'string' && typeof err.name === 'string';
  if (err instanceof Error || errLike) {
    return {
      message: err.message,
      type: err.name || err.constructor?.name || 'Error',
    };
  }
  return { message: String(err), type: 'UnknownError' };
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

/**
 * Run normalized model code in a VM with a `codemode` proxy whose methods call
 * upstream tools. @returns { result, logs, toolCalls }.
 */
export function runInSandbox({ code, tools, callTool, maxCalls = DEFAULT_MAX_CALLS, maxResultChars = DEFAULT_MAX_RESULT_CHARS, timeout = EXEC_TIMEOUT_MS, unavailableTools = [] }) {
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
      codemode[ident] = async () => {
        throw new Error(`${tool.name} is a write tool and unavailable in execute_read; use execute() instead`);
      };
    }
  }
  for (const [ident, tool] of byIdent) {
    codemode[ident] = async (args) => {
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
    };
  }
  // Discovery helpers available inside the sandbox — same shape as external search.
  codemode.listTools = (options) => {
    const opts = options && typeof options === 'object' ? options : {};
    let list = tools;
    if (typeof opts.service === 'string' && opts.service) {
      list = list.filter((t) => (t.server ?? '') === opts.service);
    }
    const entries = list.map(listSummary);
    // brief:true -> name + service only; default -> name/service/readOnly/summary.
    return opts.brief ? entries.map(({ name, service }) => ({ name, service })) : entries;
  };
  codemode.search = (query) => searchEntries(tools, String(query ?? ''), { limit: 5 }).matches.map(formatToolSummary);
  // Expose remaining budget so model scripts can batch/paginate safely.
  codemode.remainingCalls = () => Math.max(0, maxCalls - calls);

  const pushLog = (...a) => logs.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  // Lightweight crypto helper: digest(algo, data) -> hex. Models often need
  // SHA-1/SHA-256 for content hashing and previously hand-rolled JS SHA impls.
  const crypto = {
    digest: (algo, data, encoding = 'hex') =>
      createHash(String(algo).toLowerCase())
        .update(typeof data === 'string' ? data : Buffer.from(data))
        .digest(encoding),
    createHash: (algo) => createHash(String(algo).toLowerCase()), // Node hash object: .update().digest()
  };
  // global search alias: models often write search() instead of codemode.search()
  const search = codemode.search;

  const sandbox = {
    codemode,
    search,
    crypto,
    console: {
      log: pushLog,
      info: pushLog,
      debug: pushLog,
      warn: (...a) => logs.push('WARN ' + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')),
      error: (...a) => logs.push('ERROR ' + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')),
    },
    JSON, Math, Date, Array, Object, String, Number, Boolean, Promise,
    Map, Set, Symbol, RegExp, Error, TypeError, RangeError,
    parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent,
    // Web standard APIs the model expects. NOTE: Buffer object is NOT exposed
    // (its .constructor is host Function -> sandbox escape). Encoding helpers
    // close over host Buffer but the object itself stays outside the sandbox.
    TextEncoder, TextDecoder, URL, URLSearchParams,
    atob: (s) => Buffer.from(String(s), 'base64').toString('utf8'),
    btoa: (s) => Buffer.from(String(s), 'utf8').toString('base64'),
    setTimeout, clearTimeout,
  };
  const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });

  const script = new vm.Script(`(async () => { const __fn = (${normalized}); return await __fn(); })()`, { timeout });
  return Promise.resolve(script.runInContext(context, { timeout }))
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
    })
    .catch((err) => {
      // A tool throwing inside sandbox code (e.g. unwrapResult raising on
      // isError) must become a normal execute result, not an unhandled
      // rejection that kills the process. The model sees the error text.
      const info = errorInfo(err);
      // Keep the legacy message byte-for-byte for existing callers/tests.
      const rawMessage = err instanceof Error ? err.message : String(err);
      const message = `execute error: ${rawMessage}`;
      const out = makeOutput({
        legacyResult: message,
        structuredResult: message,
        logs: boundLogs(logs),
        toolCalls,
        isError: true,
      });
      // Structured error: `result` (legacy string) and `isError` stay for
      // backwards compatibility; `status` + typed `error` are the new fields.
      out.status = 'error';
      out.error = info;
      const baseToJSON = out.toJSON;
      out.toJSON = () => ({ ...baseToJSON(), status: 'error', error: info });
      return out;
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
    description: 'Search upstream tools. Returns name, description and compact param signatures (name!: required). Use query "select:<exact name>" to get the full inputSchema of one tool before calling it in execute(). Prefix a service name (e.g. "vercel ...") to focus on that service.',
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
