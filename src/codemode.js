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
import { normalizeCode, sanitizeToolName } from './codemode-util.js';
import { searchEntries } from './catalog.js';

const DEFAULT_MAX_CALLS = 30; // max upstream tool calls per execute()
const DEFAULT_MAX_RESULT_CHARS = 20000; // cap the execute() return value
const EXEC_TIMEOUT_MS = 30000;

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
      toolCalls.push({ name: tool.name, args: args ?? null });
      return callTool(tool.server, tool.tool, args ?? {});
    };
  }
  // Discovery helpers available inside the sandbox.
  codemode.listTools = () => tools.map((t) => ({ name: t.name, description: t.description }));
  codemode.search = (query) => searchEntries(tools, String(query ?? ''), { limit: 5 }).matches.map((x) => ({ name: x.name, description: x.description }));

  const sandbox = {
    codemode,
    console: {
      log: (...a) => logs.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')),
      error: (...a) => logs.push('ERROR ' + a.map(String).join(' ')),
    },
    JSON, Math, Date, Array, Object, String, Number, Boolean, Promise,
    setTimeout, clearTimeout,
  };
  const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });

  const script = new vm.Script(`(async () => { const __fn = (${normalized}); return await __fn(); })()`, { timeout });
  return script.runInContext(context, { timeout }).then((result) => {
    let text;
    try { text = typeof result === 'string' ? result : JSON.stringify(result ?? null); }
    catch { text = String(result); }
    if (text && text.length > maxResultChars) {
      text = text.slice(0, maxResultChars) + `\n…[execute result truncated ${text.length - maxResultChars} chars]`;
    }
    return { result: text ?? '', logs, toolCalls };
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
    description: 'Search the catalog of available upstream tools. Returns tool names, descriptions and parameter names. Use before execute() to discover tool names.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Keywords describing the capability you need' }, limit: { type: 'integer', minimum: 1, maximum: 10 } },
      required: ['query'],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    handler: async (args) => {
      const limit = Number.isFinite(args?.limit) ? args.limit : 8;
      const res = searchEntries(tools, String(args?.query ?? ''), { limit });
      return { matches: res.matches.map((x) => ({ name: x.name, description: x.description, params: Object.keys(x.inputSchema?.properties ?? {}) })), total: res.total, hint: res.hint };
    },
  };

  const types = /* generated lazily by caller if needed; kept simple here */ null;
  const executeTool = {
    name: 'execute',
    description: 'Write JavaScript to call upstream tools via codemode.<tool>(args). Only your returned value enters the conversation — process large results inside code and return a summary. Available: codemode.listTools(), codemode.search(q), and one method per upstream tool (use search to find exact names). Example: async () => { const r = await codemode.github__search_repositories({query:"x"}); return r.total_count; }',
    inputSchema: {
      type: 'object',
      properties: { code: { type: 'string', description: 'An async arrow function that calls codemode tools and returns a result.' } },
      required: ['code'],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    handler: async (args) => {
      const code = String(args?.code ?? '');
      return runInSandbox({
        code,
        tools: sanitized,
        callTool: (server, tool, a) => upstreamManager.callTool(server, tool, a),
        maxCalls: options.maxCalls,
        maxResultChars: options.maxResultChars,
      });
    },
  };

  return [searchTool, executeTool];
}
