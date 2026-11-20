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
import { unwrapResult, formatToolSummary, formatToolDetail } from './tool-format.js';

const DEFAULT_MAX_CALLS = 30; // max upstream tool calls per execute()
const DEFAULT_MAX_RESULT_CHARS = 20000; // cap the execute() return value
const EXEC_TIMEOUT_MS = 30000;
const ARG_FIELD_MAX = 200; // cap each arg field in the audit trail (prevents context leak)

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

/**
 * Run normalized model code in a VM with a `codemode` proxy whose methods call
 * upstream tools. @returns { result, logs, toolCalls }.
 */
export function runInSandbox({ code, tools, callTool, maxCalls = DEFAULT_MAX_CALLS, maxResultChars = DEFAULT_MAX_RESULT_CHARS, timeout = EXEC_TIMEOUT_MS }) {
  const normalized = normalizeCode(code);
  const logs = [];
  const toolCalls = [];
  let calls = 0;

  // Map sanitized JS identifier -> original tool descriptor.
  const byIdent = new Map();
  for (const t of tools) byIdent.set(sanitizeToolName(t.name), t);

  const codemode = {};
  for (const [ident, tool] of byIdent) {
    codemode[ident] = async (args) => {
      calls += 1;
      if (calls > maxCalls) throw new Error(`tool call limit (${maxCalls}) exceeded`);
      toolCalls.push({ name: tool.name, args: summarizeArgs(args) });
      const raw = await callTool(tool.server, tool.tool, args ?? {});
      // Throw on upstream errors and auto-parse JSON results so model scripts
      // can use the return value directly without JSON.parse(content[0].text).
      return unwrapResult(raw);
    };
  }
  // Discovery helpers available inside the sandbox — same shape as external search.
  codemode.listTools = () => tools.map((t) => ({ name: t.name, description: t.description }));
  codemode.search = (query) => searchEntries(tools, String(query ?? ''), { limit: 5 }).matches.map(formatToolSummary);

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
    .then((result) => {
      let text;
      try { text = typeof result === 'string' ? result : JSON.stringify(result ?? null); }
      catch { text = String(result); }
      if (text && text.length > maxResultChars) {
        text = text.slice(0, maxResultChars) + `\n…[execute result truncated ${text.length - maxResultChars} chars]`;
      }
      return { result: text ?? '', logs, toolCalls };
    })
    .catch((err) => {
      // A tool throwing inside sandbox code (e.g. unwrapResult raising on
      // isError) must become a normal execute result, not an unhandled
      // rejection that kills the process. The model sees the error text.
      return { result: `execute error: ${err instanceof Error ? err.message : String(err)}`, logs, toolCalls, isError: true };
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

  const isReadOnly = (t) =>
    t.annotations?.readOnlyHint === true ||
    /^(get|list|search|query|read|fetch|view|describe|find|count|aggregate|check)_|^notion-(get|list|search|query|memory)/i.test(t.tool);

  const makeExecute = (name, readOnly) => ({
    name,
    description: (readOnly
      ? 'Write JavaScript to call READ-ONLY upstream tools (get/list/search/query) via codemode.<tool>(args). This tool is annotated read-only so the client may prompt less; it runs the same sandbox as execute(). Only your return value enters the conversation. Example: async () => { const r = await codemode.github__search_repositories({query:"x"}); return r.total_count; }'
      : 'Write JavaScript to call upstream tools via codemode.<tool>(args). Only your returned value enters the conversation — process large results inside code and return a summary. Available: codemode.listTools(), codemode.search(q), global search(), TextEncoder/atob/URL/crypto, and one method per upstream tool. Example: async () => { const r = await codemode.github__search_repositories({query:"x"}); return r.total_count; }'),
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
      const usable = readOnly ? sanitized.filter(isReadOnly) : sanitized;
      return runInSandbox({
        code,
        tools: usable,
        callTool: (server, tool, a) => upstreamManager.callTool(server, tool, a),
        maxCalls: options.maxCalls,
        maxResultChars: options.maxResultChars,
      });
    },
  });

  // Two execute tools: read-only (no approval friction) and full (read+write).
  return [searchTool, makeExecute('execute_read', true), makeExecute('execute', false)];
}
