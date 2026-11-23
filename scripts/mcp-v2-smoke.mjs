#!/usr/bin/env node
/**
 * Local live smoke for the `/mcp/v2` typed-plan route (offline by construction).
 *
 * What "live" means here: the real `createMcpRequestHandler` / `McpServer` /
 * Streamable HTTP transport from src/ are exercised over an actual HTTP socket.
 * What it does NOT mean: no real upstream, no credentials, no internet. The
 * upstream manager, typed-plan IO adapter and token store are all fakes defined
 * in this file. Every socket binds to 127.0.0.1 on an OS-assigned ephemeral port.
 *
 * Production defaults are never touched: the v2 flag is injected as
 * `env: { ENABLE_MCP_V2: '1' }` into the handler options (never written to
 * process.env), and the flag-off case uses a second handler with `'0'`.
 *
 * Usage:
 *   node scripts/mcp-v2-smoke.mjs              # prints JSON only on stdout
 *
 * Library use (tests/mcp-v2-smoke.test.js does exactly this):
 *   import { runSmoke } from './scripts/mcp-v2-smoke.mjs';
 *   const report = await runSmoke();           // { ok, checks: [...] }
 *
 * Exit code: 0 when every check passes, 1 otherwise.
 */

import http from 'node:http';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCodeModeTools } from '../src/codemode.js';
import { createMcpRequestHandler, MCP_V1_PATH, MCP_V2_PATH } from '../src/server.js';
import { createAppHandler } from '../src/vercel-app.js';

const ACCEPT = 'application/json, text/event-stream';
const FILES = { 'a.txt': 'one\ntwo\nthree\n' };
const PATCH = '@@ -2,1 +2,1 @@\n-two\n+TWO\n';
const READ_PLAN = [{ op: 'readFileRange', path: 'a.txt', startLine: 1, endLine: 2 }];
const WRITE_PLAN = [{ op: 'applyPatch', path: 'a.txt', patch: PATCH }];
const TOOL_NAMES = ['search', 'execute_read', 'execute'];

/** Fake upstream manager: no sockets, no credentials, no real tools. */
function fakeManager() {
  return {
    getEntries: () => [],
    getWhitelist: () => [],
    callTool: async () => { throw new Error('unexpected upstream call in smoke'); },
  };
}

/** Fake typed-plan IO adapter: records every op, touches no real files/repos. */
function fakeIO() {
  const calls = [];
  const record = (op, args, value) => {
    calls.push({ op, args: { ...args } });
    return value;
  };
  const files = { ...FILES };
  return {
    calls,
    files,
    readFileRange: async (args) => record('readFileRange', args, {
      path: args.path,
      text: files[args.path] ?? '',
      lines: (files[args.path] ?? '').split('\n').slice((args.startLine || 1) - 1, args.endLine),
      truncated: false,
    }),
    repoGrep: async (args) => record('repoGrep', args, { matches: [], pattern: args.pattern }),
    ensureBranch: async (args) => record('ensureBranch', args, { branch: args.branch, created: true }),
    writeFile: async (args) => record('writeFile', args, { path: args.path, written: true }),
    openPr: async (args) => record('openPr', args, { number: 1, head: args.head, base: args.base }),
    runChecks: async (args) => record('runChecks', args, { command: args.command, ok: true }),
  };
}

const fakeStore = {
  async getToken(token) {
    return token === 'smoke-token' ? { expiresAt: Date.now() + 60_000 } : null;
  },
  async saveClient() {}, async getClient() { return null; },
  async saveCode() {}, async takeCode() { return null; },
  async saveToken() {}, async getTokenRecord() { return null; },
};

/**
 * Start one loopback server with three logical mounts:
 *   POST /mcp, /mcp/v2          -> real MCP handler, flag injected ON
 *   POST /off/mcp/v2, /off/mcp  -> same handler with flag OFF (URL rewritten)
 *   POST /auth/mcp/v2          -> real createAppHandler (URL rewritten to /mcp/v2)
 * The rewrites are the only way the fakes are injected; no process.env writes.
 */
export async function startSmokeServer() {
  const io = fakeIO();
  const common = { mode: 'codemode', typedPlanIO: io };
  const onHandler = createMcpRequestHandler(fakeManager(), {
    ...common, env: { ENABLE_MCP_V2: '1' },
  });
  const offHandler = createMcpRequestHandler(fakeManager(), {
    ...common, env: { ENABLE_MCP_V2: '0' },
  });
  const appHandler = createAppHandler({
    env: { ENABLE_MCP_V2: '1' },
    baseUrl: 'https://gateway.example',
    store: fakeStore,
    mcpHandler: onHandler,
  });

  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (pathname.startsWith('/off/')) {
      req.url = req.url.slice('/off'.length); // /off/mcp/v2 -> /mcp/v2
      void offHandler(req, res);
      return;
    }
    if (pathname.startsWith('/auth/')) {
      req.url = req.url.slice('/auth'.length); // /auth/mcp/v2 -> /mcp/v2
      void appHandler(req, res);
      return;
    }
    void onHandler(req, res);
  });
  await new Promise((listen, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', fail);
      listen();
    });
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    baseUrl,
    io,
    close: () => new Promise((done) => server.close(done)),
  };
}

/** Parse a Streamable HTTP body (plain JSON or SSE `data:` frames). */
function parseRpcBody(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return JSON.parse(trimmed);
  const lines = text.split(/\r?\n/).filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim()).filter(Boolean);
  for (const line of lines.reverse()) {
    try { return JSON.parse(line); } catch { /* keep scanning */ }
  }
  throw new SyntaxError(`not a JSON-RPC body: ${text.slice(0, 120)}`);
}

function pureSchema(tool) {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations,
  };
}

function schemaHash(tools) {
  const canonical = tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function walk(node, visit, path = 'schema') {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach((n, i) => walk(n, visit, `${path}[${i}]`)); return; }
  visit(node, path);
  for (const [key, value] of Object.entries(node)) walk(value, visit, `${path}.${key}`);
}

/**
 * Run every smoke check against a freshly started server.
 * `fetchImpl` is injectable so tests can substitute a loopback-only wrapper.
 */
export async function runSmoke({ fetchImpl = globalThis.fetch, baseUrl } = {}) {
  const ownServer = baseUrl ? null : await startSmokeServer();
  const root = (baseUrl ?? ownServer.baseUrl).replace(/\/$/, '');
  if (!/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(root)) {
    throw new Error(`refusing non-loopback URL ${root}: this smoke is offline-only`);
  }
  const io = ownServer?.io;

  const checks = [];
  let current = null;
  const check = (name, fn) => {
    current = { name, ok: false, detail: null };
    checks.push(current);
    try {
      const detail = fn();
      current.detail = detail ?? null;
      current.ok = true;
    } catch (error) {
      current.ok = false;
      current.detail = { error: error instanceof Error ? error.message : String(error) };
    }
    return current;
  };
  const asyncCheck = async (name, fn) => {
    current = { name, ok: false, detail: null };
    checks.push(current);
    try {
      const detail = await fn();
      current.detail = detail ?? null;
      current.ok = true;
    } catch (error) {
      current.ok = false;
      current.detail = { error: error instanceof Error ? error.message : String(error) };
    }
    return current;
  };
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };

  const request = async (path, rpc, headers = {}) => {
    const response = await fetchImpl(`${root}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: ACCEPT, ...headers },
      body: typeof rpc === 'string' ? rpc : JSON.stringify(rpc),
    });
    return { status: response.status, headers: response.headers, text: await response.text() };
  };
  const rpcRequest = async (path, method, params, id = 1, headers = {}) => {
    const res = await request(path, { jsonrpc: '2.0', id, method, params }, headers);
    let parsed = null;
    try { parsed = parseRpcBody(res.text); } catch { /* keep null for 404/plain */ }
    return { ...res, parsed };
  };
  const toolsOf = (res) => res.parsed?.result?.tools ?? null;
  const callResult = (res) => {
    const item = res.parsed?.result?.content?.[0];
    assert(item?.type === 'text', `expected text content block, got ${JSON.stringify(res.parsed?.result ?? res.text).slice(0, 200)}`);
    return JSON.parse(item.text);
  };
  const unwrap = (value) => (value && typeof value === 'object' && 'result' in value
    && value.result && typeof value.result === 'object' ? value.result : value);

  try {
    // 1. v1 contract: names/order/schema/annotations unchanged, even with the
    //    v2 flag on. Compare against the v1 factory as an in-process baseline.
    await asyncCheck('v1_tools_shape_unchanged', async () => {
      const res = await rpcRequest(MCP_V1_PATH, 'tools/list', {});
      assert(res.status === 200, `v1 tools/list status ${res.status}`);
      const tools = toolsOf(res);
      assert(tools !== null, 'v1 tools/list returned no tools array');
      assert(JSON.stringify(tools.map((t) => t.name)) === JSON.stringify(TOOL_NAMES),
        `v1 tool names/order changed: ${JSON.stringify(tools.map((t) => t.name))}`);
      const baseline = createCodeModeTools(fakeManager(), {}).map(pureSchema);
      const live = tools.map(pureSchema);
      assert(JSON.stringify(live) === JSON.stringify(baseline),
        'v1 tool surface differs from the in-process v1 factory baseline');
      assert(!('plan' in tools[2].inputSchema.properties), 'v1 execute leaked a plan field');
      assert(JSON.stringify(tools[2].inputSchema.required) === '["code"]', 'v1 execute must stay code-required');
      return { names: tools.map((t) => t.name), schemaHash: schemaHash(tools) };
    });

    // 2. v2 discovery: same three tools in the same order; only the two execute
    //    schemas differ, both sanitize-stable (arrays carry items, oneOf <= 8).
    await asyncCheck('v2_tools_shape', async () => {
      const res = await rpcRequest(MCP_V2_PATH, 'tools/list', {});
      assert(res.status === 200, `v2 tools/list status ${res.status}`);
      const tools = toolsOf(res);
      assert(tools !== null, 'v2 tools/list returned no tools array');
      assert(JSON.stringify(tools.map((t) => t.name)) === JSON.stringify(TOOL_NAMES),
        `v2 tool names/order changed: ${JSON.stringify(tools.map((t) => t.name))}`);
      const [read, exec] = [tools[1].inputSchema, tools[2].inputSchema];
      assert(JSON.stringify(read.required) === '["plan"]', 'execute_read must require plan only');
      assert(!('code' in read.properties), 'execute_read must not advertise code');
      assert(read.properties.plan.type === 'array' && !!read.properties.plan.items, 'execute_read plan needs array+items');
      assert(!!exec.properties.plan && !!exec.properties.code, 'execute must advertise both plan and code');
      assert(Array.isArray(exec.oneOf) && exec.oneOf.length === 2, 'execute must have exactly two oneOf branches');
      assert(JSON.stringify(exec.properties.plan.items.properties.op.enum.length) === '6', 'execute op enum length changed');
      const arraysWithoutItems = [];
      walk(exec, (node, path) => {
        if (node.type === 'array' && !(node.items && typeof node.items === 'object')) arraysWithoutItems.push(path);
      });
      assert(arraysWithoutItems.length === 0, `v2 schemas have arrays without items: ${arraysWithoutItems}`);
      return { names: tools.map((t) => t.name), schemaHash: schemaHash(tools), readOnlyOps: read.properties.plan.items.properties.op.enum };
    });

    // 3. A simple typed plan actually executes against the fake IO adapter.
    await asyncCheck('v2_plan_simple_success', async () => {
      const before = io.calls.length;
      const res = await rpcRequest(MCP_V2_PATH, 'tools/call', { name: 'execute_read', arguments: { plan: READ_PLAN } });
      assert(res.status === 200, `tools/call status ${res.status}`);
      const out = unwrap(callResult(res));
      assert(out.ok === true, `plan did not succeed: ${JSON.stringify(out).slice(0, 200)}`);
      assert(JSON.stringify(out.steps.map((s) => s.op)) === '["readFileRange"]', 'unexpected executed steps');
      assert(out.meta?.protocolVersion === 'v2' && out.meta?.planVersion, 'missing v2 plan meta');
      assert(io.calls.length === before + 1 && io.calls.at(-1).op === 'readFileRange', 'fake IO did not see one read op');
      return { ok: out.ok, steps: out.steps.map((s) => s.op), meta: out.meta };
    });

    // 4. readOnly is enforced server-side: zero steps, zero side effects.
    await asyncCheck('v2_readonly_rejects_write', async () => {
      const before = io.calls.length;
      const res = await rpcRequest(MCP_V2_PATH, 'tools/call', {
        name: 'execute_read', arguments: { plan: [...READ_PLAN, ...WRITE_PLAN] },
      });
      assert(res.status === 200, `tools/call status ${res.status}`);
      const out = unwrap(callResult(res));
      assert(out.ok === false, 'write op was accepted by execute_read');
      assert(Array.isArray(out.steps) && out.steps.length === 0, 'validate must run before any step');
      assert(/not allowed in read-only mode/.test(out.error ?? ''), `unexpected error: ${out.error}`);
      assert(io.calls.length === before, 'readOnly rejection touched fake IO');
      return { ok: out.ok, steps: out.steps.length, error: out.error };
    });

    // 5. Write op without approve/dryRun is rejected before any handler runs.
    await asyncCheck('v2_write_requires_approve', async () => {
      const before = io.calls.length;
      const res = await rpcRequest(MCP_V2_PATH, 'tools/call', { name: 'execute', arguments: { plan: WRITE_PLAN } });
      assert(res.status === 200, `tools/call status ${res.status}`);
      const out = unwrap(callResult(res));
      assert(out.ok === false, 'unapproved write was accepted');
      assert(Array.isArray(out.steps) && out.steps.length === 0, 'unapproved write produced steps');
      assert(/requires dryRun or explicit approve/.test(out.error ?? ''), `unexpected error: ${out.error}`);
      assert(!io.calls.slice(before).some((c) => c.op === 'writeFile'), 'unapproved write reached fake writeFile');
      return { ok: out.ok, steps: out.steps.length, error: out.error };
    });

    // 6. v1 never accepts a plan argument: its code-only handler sees no code
    //    and returns an empty sandbox projection ({}), with no typed-plan steps
    //    and no fake IO call. That is the observable "plan ignored" contract.
    await asyncCheck('v1_rejects_plan', async () => {
      const before = io.calls.length;
      const res = await rpcRequest(MCP_V1_PATH, 'tools/call', { name: 'execute', arguments: { plan: READ_PLAN } });
      assert(res.status === 200, `tools/call status ${res.status}`);
      const out = unwrap(callResult(res));
      assert(!Array.isArray(out.steps), `v1 executed typed-plan steps: ${JSON.stringify(out).slice(0, 200)}`);
      assert(!out.meta?.planVersion, 'v1 result carries a v2 plan meta');
      assert(io.calls.length === before, 'v1 plan reached the typed-plan fake IO');
      return { ignoredPlan: true, ioCallsUnchanged: true, resultKeys: Object.keys(out) };
    });

    // 7. v2 missing input: execute -> E-VAL-NONE, execute_read -> plan required.
    await asyncCheck('v2_requires_plan_or_code', async () => {
      const none = unwrap(callResult(await rpcRequest(MCP_V2_PATH, 'tools/call', {
        name: 'execute', arguments: {},
      })));
      assert(none.ok === false && /E-VAL-NONE/.test(none.error ?? ''), `execute({}) error mismatch: ${none.error}`);
      const missing = unwrap(callResult(await rpcRequest(MCP_V2_PATH, 'tools/call', {
        name: 'execute_read', arguments: {},
      })));
      assert(missing.ok === false && /plan is required/.test(missing.error ?? ''), `execute_read({}) error mismatch: ${missing.error}`);
      const both = unwrap(callResult(await rpcRequest(MCP_V2_PATH, 'tools/call', {
        name: 'execute', arguments: { plan: READ_PLAN, code: 'async () => 1' },
      })));
      assert(both.ok === false && /E-VAL-BOTH/.test(both.error ?? ''), `both-input error mismatch: ${both.error}`);
      return { executeEmpty: none.error, readEmpty: missing.error, both: both.error };
    });

    // 8. Flag off: /mcp/v2 is 404 while v1 still serves the baseline tools.
    await asyncCheck('flag_off_v2_404', async () => {
      const off = await rpcRequest('/off/mcp/v2', 'tools/list', {});
      assert(off.status === 404, `flag-off v2 status ${off.status} (expected 404)`);
      const v1 = await rpcRequest('/off/mcp', 'tools/list', {});
      assert(v1.status === 200, `flag-off v1 status ${v1.status}`);
      assert(JSON.stringify(toolsOf(v1)?.map((t) => t.name)) === JSON.stringify(TOOL_NAMES), 'flag-off v1 tools changed');
      return { v2Status: off.status, v1Status: v1.status };
    });

    // 9. 401 challenge on the real createAppHandler path, plus an authenticated
    //    v2 request through the same mount to prove the auth gate is the only
    //    difference. No token ever leaves this process.
    await asyncCheck('v2_auth_401_challenge', async () => {
      const noToken = await rpcRequest('/auth/mcp/v2', 'tools/list', {});
      assert(noToken.status === 401, `no-token status ${noToken.status} (expected 401)`);
      assert(/^Bearer /.test(noToken.headers.get('www-authenticate') ?? ''), 'missing WWW-Authenticate header');
      let body = null;
      try { body = JSON.parse(noToken.text); } catch { /* assert below */ }
      const challenges = body?._meta?.['mcp/www_authenticate'];
      assert(Array.isArray(challenges) && challenges.length === 1, `_meta challenge count ${challenges?.length}`);
      assert(/resource_metadata=/.test(challenges[0]) && /error=/.test(challenges[0])
        && /error_description=/.test(challenges[0]), `incomplete challenge: ${challenges[0]}`);

      const withToken = await rpcRequest('/auth/mcp/v2', 'tools/list', {}, 2, {
        authorization: 'Bearer smoke-token',
      });
      assert(withToken.status === 200, `authenticated v2 status ${withToken.status}`);
      assert(JSON.stringify(toolsOf(withToken)?.map((t) => t.name)) === JSON.stringify(TOOL_NAMES),
        'authenticated v2 tools changed');
      return {
        status: noToken.status,
        metaChallengeCount: challenges.length,
        authenticatedV2Status: withToken.status,
      };
    });
  } finally {
    if (ownServer) await ownServer.close();
  }

  return { ok: checks.every((c) => c.ok), checks };
}

async function main() {
  const originalLog = console.log;
  let report;
  try {
    // Handlers log [req]/[capture_*] lines; keep stdout pure JSON for piping.
    console.log = (...args) => process.stderr.write(args.map(String).join(' ') + '\n');
    report = await runSmoke();
  } finally {
    console.log = originalLog;
  }
  originalLog(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

const invokedDirectly = (() => {
  try {
    return Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch { return false; }
})();
if (invokedDirectly) await main();
