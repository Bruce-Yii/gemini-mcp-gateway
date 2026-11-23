#!/usr/bin/env node
/**
 * local-e2e-verify.mjs — offline, end-to-end verification of the LOCAL checkout.
 *
 * WHY
 * ---
 * Unit tests pin individual handlers. This harness answers a narrower but
 * important question: "do the already-committed fixes actually take effect on
 * the REAL HTTP routes, using the REAL handler chain, from the latest local
 * source?" It mounts the real `createAppHandler` / `createMcpRequestHandler`
 * on a real Node `http` server at an ephemeral 127.0.0.1 port and drives real
 * HTTP requests (raw `fetch` + the MCP SDK Streamable HTTP client).
 *
 * ONLY TWO BOUNDARIES ARE FAKED (never src/):
 *   - the token store: an in-memory Map (no KV, no vault, no disk);
 *   - the upstream manager: deterministic in-process tools (no stdio child, no
 *     network). The typed-plan IO adapter is likewise an in-memory fake.
 * Everything else — routing, OAuth metadata, 401 challenge, MCP initialize /
 * tools/list / tools/call, three-tool surface, Code Mode sandbox, result
 * normalization — is the actual local code under src/.
 *
 * SAFETY INVARIANTS
 * -----------------
 *  - No internet: all URLs are loopback; the fake upstream rejects unknown
 *    tools instead of forwarding anything. No provider/vault/KV is contacted.
 *  - No production code touched; no commit / push / deploy; nothing written to
 *    disk. Only stdout receives `{ok, checks[]}` JSON.
 *  - No real credential-like values; the bearer token is the literal FAKE-TOKEN.
 *
 * USAGE
 * -----
 *   node scripts/local-e2e-verify.mjs                 # -> {ok, checks[]} JSON
 *   import { runLocalE2E } from './local-e2e-verify.mjs'; // from tests
 *
 * A non-zero exit code (1) means at least one check failed.
 */

import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { createAppHandler, CIMD_PATH } from '../src/vercel-app.js';
import { createMcpRequestHandler, MCP_V1_PATH, MCP_V2_PATH } from '../src/server.js';

export const FAKE_TOKEN = 'FAKE-LOCAL-E2E-TOKEN';

const NOTICE_SHA = '4cb29ea38f70d7c61b2a3a25b02e3bdf44905402';
const NOTICE = `successfully downloaded text file (SHA: ${NOTICE_SHA})\n`;
const BODY = '# title\nline one\nlast line\n';
// Real create_pull_request shape: the DB `id` is huge, the true PR number is
// in the URL (/pulls/53). The URL must win over both `id` and `number`.
const REAL_PR = {
  id: 1000000001,
  node_id: 'PR_kwDOEXAMPLE001',
  number: 999,
  html_url: 'https://github.com/o/r/pulls/53',
  sha: 'deadbeef',
};

// ── In-memory fake token store (never touches KV / vault / disk) ────────────

class FakeStore {
  constructor() {
    this.tokens = new Map();
    this.clients = new Map();
  }

  async saveToken(token, record) { this.tokens.set(token, { ...record }); }
  async getToken(token) { return this.tokens.get(token) ?? null; }
  async saveClient(id, record) { this.clients.set(id, { ...record }); }
  async getClient(id) { return this.clients.get(id) ?? null; }
}

// ── Deterministic fake upstream manager (no network / no child process) ────

/**
 * @param {{ prChecksStatus?: string, prChecksSnapshot?: object }} [options]
 */
function fakeUpstreamManager(options = {}) {
  const entries = [
    {
      server: 'github', tool: 'get_file_contents', name: 'github__get_file_contents',
      description: 'Read a file (fake)', annotations: { readOnlyHint: true },
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    },
    {
      server: 'github', tool: 'create_pull_request', name: 'github__create_pull_request',
      description: 'Open a PR (fake)', annotations: { readOnlyHint: false },
      inputSchema: { type: 'object', properties: { title: { type: 'string' } } },
    },
    {
      server: 'github', tool: 'pull_request_read', name: 'github__pull_request_read',
      description: 'Read PR checks (fake)', annotations: { readOnlyHint: true },
      inputSchema: { type: 'object', properties: { method: { type: 'string' } } },
    },
  ];
  const calls = [];
  return {
    calls,
    getEntries: () => entries,
    getWhitelist: () => entries,
    callTool: async (server, tool, args = {}) => {
      calls.push({ server, tool, args: { ...args } });
      if (tool === 'get_file_contents') {
        // The download notice is line 1; it is metadata, never file content.
        return { content: [{ type: 'text', text: NOTICE + BODY }], sha: NOTICE_SHA };
      }
      if (tool === 'create_pull_request') return REAL_PR;
      if (tool === 'pull_request_read') {
        return options.prChecksSnapshot ?? { status: options.prChecksStatus ?? 'pending', check_runs: [] };
      }
      return { ok: false, error: `unknown fake tool: ${server}__${tool}` };
    },
  };
}

/** In-memory typed-plan IO adapter for runTypedPlan. */
function fakeTypedPlanIO() {
  const calls = [];
  const files = { 'a.txt': 'one\ntwo\nthree\n' };
  const record = (op, args, value) => { calls.push({ op, args: { ...args } }); return value; };
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

// ── Helpers ─────────────────────────────────────────────────────────────────

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** Mount the REAL app handler on a real ephemeral loopback server. */
async function startGateway({ store, manager, typedPlanIO, env = {} } = {}) {
  // The MCP protocol is real createMcpRequestHandler; only its upstream manager
  // and typed-plan IO are faked. Passing it as `mcpHandler` keeps the real
  // createAppHandler route/auth/capture chain in front of it.
  const mcpHandler = createMcpRequestHandler(manager, {
    mode: 'codemode',
    typedPlanIO,
    env,
  });
  const appHandler = createAppHandler({
    store,
    config: { mode: 'codemode', servers: [{ name: 'github' }] },
    baseUrl: 'https://gw.local.test',
    cimdBaseUrl: 'https://gw.local.test',
    mcpHandler,
    env,
  });
  const server = http.createServer((req, res) => { void appHandler(req, res); });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function getJson(origin, path, headers = {}) {
  const response = await fetch(`${origin}${path}`, { redirect: 'manual', headers });
  const body = await response.text();
  let json = null;
  try { json = JSON.parse(body); } catch { /* non-JSON is fine for some routes */ }
  return { status: response.status, headers: response.headers, body, json };
}

/** POST a single JSON-RPC message with the fake bearer token; parse the body. */
async function mcpPost(origin, path, message, extraHeaders = {}) {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${FAKE_TOKEN}`,
      ...extraHeaders,
    },
    body: JSON.stringify(message),
  });
  const text = await response.text();
  // Streamable HTTP may return application/json or text/event-stream (SSE).
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    const match = /data:\s*(\{.*\})/s.exec(text);
    if (match) payload = JSON.parse(match[1]);
  }
  return { status: response.status, headers: response.headers, text, payload };
}

/** Drive a full MCP client session over the real loopback route. */
async function withClient(origin, path, fn, headers = {}) {
  const client = new Client({ name: 'local-e2e-verify', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}${path}`), {
    requestInit: {
      headers: { authorization: `Bearer ${FAKE_TOKEN}`, ...headers },
    },
  });
  try {
    await client.connect(transport);
    return await fn(client);
  } finally {
    await client.close();
  }
}

function textOf(result) {
  const block = result?.content?.find?.((item) => item?.type === 'text');
  if (!block) return null;
  const parsed = JSON.parse(block.text);
  // The Code Mode sandbox wraps a guest return value as {result: <value>};
  // plain plan results are already the value. Accept both shapes.
  return parsed && typeof parsed === 'object' && 'result' in parsed && parsed.result !== null
    ? parsed.result
    : parsed;
}

async function check(checks, name, fn) {
  try {
    const detail = await fn();
    // Check bodies return `{ detail: '...' }` (or a bare string); keep the
    // report flat so {ok, checks[]} stays trivially machine-readable.
    const extra = typeof detail === 'string' ? { detail } : (detail && typeof detail === 'object' ? detail : {});
    checks.push({ name, ok: true, ...extra });
    return true;
  } catch (error) {
    checks.push({ name, ok: false, error: String(error?.message ?? error) });
    return false;
  }
}

// ── The end-to-end run ──────────────────────────────────────────────────────

/**
 * Run the offline HTTP E2E verification.
 * @param {{ failCheck?: string }} [overrides] Force a named check to fail
 *   (used by the test to prove failures are surfaced, never swallowed).
 * @returns {Promise<{ok: boolean, checks: Array<{name:string, ok:boolean, detail?:string, error?:string}>}>}
 */
export async function runLocalE2E(overrides = {}) {
  const checks = [];
  const store = new FakeStore();
  const manager = fakeUpstreamManager();
  const typedPlanIO = fakeTypedPlanIO();
  await store.saveToken(FAKE_TOKEN, { clientId: 'gmc_local_e2e', expiresAt: Date.now() + 600000 });

  // v2 flag off: /mcp/v2 must not exist on the primary gateway.
  const gateway = await startGateway({ store, manager, typedPlanIO, env: {} });
  const origin = gateway.origin;

  try {
    // 1. /healthz
    await check(checks, 'healthz-200', async () => {
      const res = await getJson(origin, '/healthz');
      assert(res.status === 200, `healthz status ${res.status}`);
      assert(res.json?.ok === true, 'healthz ok flag missing');
      assert(res.json?.configLoaded === true, 'config not loaded');
      assert((res.json?.servers ?? []).includes('github'), 'fake server not reported');
      assert(typeof res.json.buildHash === 'string' && res.json.buildHash.length > 0, 'no buildHash');
      return { detail: '200, ok:true, fake server listed, buildHash present' };
    });

    // 2. OAuth metadata (authorization server + protected resource)
    await check(checks, 'oauth-metadata', async () => {
      const as = await getJson(origin, '/.well-known/oauth-authorization-server');
      assert(as.status === 200, `AS metadata status ${as.status}`);
      for (const key of ['authorization_endpoint', 'token_endpoint', 'registration_endpoint',
        'grant_types_supported', 'response_types_supported', 'code_challenge_methods_supported', 'scopes_supported']) {
        assert(as.json?.[key], `AS metadata missing ${key}`);
      }
      assert(as.json.code_challenge_methods_supported.includes('S256'), 'PKCE S256 missing');
      const pr = await getJson(origin, '/.well-known/oauth-protected-resource');
      assert(pr.status === 200, `protected-resource status ${pr.status}`);
      assert(String(pr.json?.resource).endsWith('/mcp'), 'resource not /mcp');
      assert(Array.isArray(pr.json?.authorization_servers) && pr.json.authorization_servers.length > 0,
        'authorization_servers missing');
      return { detail: 'AS metadata 200 (PKCE S256) + protected-resource 200' };
    });

    // 3. CIMD document (public, client_id == document URL, no secret)
    await check(checks, 'cimd-document', async () => {
      const res = await getJson(origin, CIMD_PATH);
      assert(res.status === 200, `CIMD status ${res.status}`);
      assert(res.json?.client_id === `https://gw.local.test${CIMD_PATH}`, 'client_id is not the document URL');
      assert(res.json?.token_endpoint_auth_method === 'none', 'CIMD is not a public client');
      assert(!('client_secret' in (res.json ?? {})), 'CIMD leaked a client_secret');
      assert((res.json?.code_challenge_methods_supported ?? []).includes('S256'), 'CIMD missing S256');
      return { detail: `GET ${CIMD_PATH} 200 public client document` };
    });

    // 4. 401 challenge (missing + invalid token)
    await check(checks, 'mcp-401-challenge', async () => {
      const missing = await fetch(`${origin}${MCP_V1_PATH}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
      });
      assert(missing.status === 401, `missing-token status ${missing.status}`);
      assert(String(missing.headers.get('www-authenticate')).includes('oauth-protected-resource'),
        'WWW-Authenticate missing resource_metadata');
      const body = await missing.json();
      assert(body._meta?.['mcp/www_authenticate']?.length > 0, 'ChatGPT challenge array missing');
      const invalid = await fetch(`${origin}${MCP_V1_PATH}`, {
        method: 'POST', headers: { authorization: 'Bearer WRONG-TOKEN' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
      });
      assert(invalid.status === 401, `invalid-token status ${invalid.status}`);
      return { detail: '401 for missing/invalid token with WWW-Authenticate + _meta challenge' };
    });

    // 5. /mcp three tools (real MCP client over loopback)
    let tools = null;
    await check(checks, 'mcp-three-tools', async () => {
      tools = await withClient(origin, MCP_V1_PATH, (client) => client.listTools());
      const names = tools.tools.map((t) => t.name);
      assert(JSON.stringify(names) === JSON.stringify(['search', 'execute_read', 'execute']),
        `unexpected tool surface: ${names.join(',')}`);
      for (const tool of tools.tools) {
        assert(tool.inputSchema?.type === 'object', `${tool.name} schema not object`);
      }
      return { detail: `tools/list -> ${names.join(',')}` };
    });

    // 6. file read: content is pure body; notice/sha are metadata only.
    await check(checks, 'file-content-pure-body', async () => {
      const value = await withClient(origin, MCP_V1_PATH, async (client) => {
        const result = await client.callTool({
          name: 'execute_read',
          arguments: {
            code: 'async () => { const raw = await codemode.github__get_file_contents({ owner: "o", repo: "r", path: "a.txt" }); return { file: codemode.fileResult(raw), meta: codemode.fileMeta(raw) }; }',
          },
        });
        return textOf(result);
      });
      const file = value?.file;
      assert(file && file.content === BODY, `content is not pure body: ${JSON.stringify(file)}`);
      assert(!String(file.content).includes('successfully downloaded'), 'notice leaked into content');
      assert(file.sha === NOTICE_SHA, 'sha metadata missing');
      // `notice` is deliberately non-enumerable on fileResult (stable key set);
      // fileMeta is the explicit, model-visible accessor for that metadata.
      assert(value.meta?.notice === NOTICE.trim(), 'notice metadata missing via fileMeta');
      assert(value.meta?.noticeSha === NOTICE_SHA, 'noticeSha metadata missing via fileMeta');
      return { detail: 'content == pure body; sha on fileResult, notice/noticeSha via fileMeta' };
    });

    // 7. PR number URL-first (id must never become the number).
    await check(checks, 'pr-number-url-first', async () => {
      const value = await withClient(origin, MCP_V1_PATH, async (client) => {
        const result = await client.callTool({
          name: 'execute',
          arguments: {
            code: 'async () => codemode.prResult(await codemode.github__create_pull_request({ owner: "o", repo: "r", title: "t", head: "h", base: "b" }))',
          },
        });
        return textOf(result);
      });
      assert(value && value.number === 53, `number from URL expected 53: ${JSON.stringify(value)}`);
      assert(value.id === '1000000001', 'database id not exposed separately');
      assert(value.nodeId === 'PR_kwDOEXAMPLE001', 'nodeId not exposed separately');
      return { detail: 'number=53 from URL; id/nodeId separate' };
    });

    // 8. waitForPrChecks helper visible + honest timeout.
    await check(checks, 'wait-for-pr-checks-helper', async () => {
      const value = await withClient(origin, MCP_V1_PATH, async (client) => {
        const result = await client.callTool({
          name: 'execute_read',
          arguments: {
            code: 'async () => ({ visible: typeof codemode.waitForPrChecks === "function", out: await codemode.waitForPrChecks({ owner: "o", repo: "r", pullNumber: 53, maxPolls: 2, pollIntervalMs: 1 }) })',
          },
        });
        return textOf(result);
      });
      assert(value?.visible === true, 'codemode.waitForPrChecks is not visible');
      assert(value.out?.ok === false && value.out?.timedOut === true, 'helper did not report timeout');
      assert(value.out?.polls === 2, 'poll cap not honored');
      return { detail: 'helper visible; 2 polls -> timedOut:true, ok:false' };
    });

    // 9. runTypedPlan helper usable (sandbox-only, through execute).
    await check(checks, 'run-typed-plan-helper', async () => {
      const plan = [{ op: 'readFileRange', path: 'a.txt', startLine: 1, endLine: 2 }];
      const value = await withClient(origin, MCP_V1_PATH, async (client) => {
        const result = await client.callTool({
          name: 'execute',
          arguments: {
            code: `async () => codemode.runTypedPlan(${JSON.stringify(plan)}, { dryRun: true })`,
          },
        });
        return textOf(result);
      });
      assert(value?.ok === true, `runTypedPlan failed: ${JSON.stringify(value)}`);
      assert(value.steps?.[0]?.op === 'readFileRange', 'plan step missing');
      assert(typedPlanIO.calls.some((c) => c.op === 'readFileRange'), 'typed-plan IO adapter not used');
      return { detail: 'runTypedPlan executed a typed plan via the fake IO adapter' };
    });

    // 10. v2 flag off: /mcp/v2 is absent (404), never downgrades to v1.
    await check(checks, 'v2-flag-off-404', async () => {
      const res = await fetch(`${origin}${MCP_V2_PATH}`, {
        method: 'POST', headers: { authorization: `Bearer ${FAKE_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
      });
      assert(res.status === 404, `v2 flag off expected 404, got ${res.status}`);
      return { detail: `${MCP_V2_PATH} 404 when ENABLE_MCP_V2 is not 1` };
    });
  } finally {
    await gateway.close();
  }

  // 11. v2 flag on: same three tools, plan-capable schema, additive discovery.
  let gatewayV2;
  try {
    gatewayV2 = await startGateway({ store, manager: fakeUpstreamManager(), typedPlanIO: fakeTypedPlanIO(), env: { ENABLE_MCP_V2: '1' } });
    await check(checks, 'v2-flag-on-three-tools', async () => {
      const tools = await withClient(gatewayV2.origin, MCP_V2_PATH, (client) => client.listTools());
      const names = tools.tools.map((t) => t.name);
      assert(JSON.stringify(names) === JSON.stringify(['search', 'execute_read', 'execute']),
        `v2 tool surface changed: ${names.join(',')}`);
      const exec = tools.tools.find((t) => t.name === 'execute');
      assert(exec && 'plan' in (exec.inputSchema?.properties ?? {}), 'v2 execute plan arg missing');
      return { detail: `${MCP_V2_PATH} 200, same 3 tools, execute accepts plan` };
    });
  } finally {
    if (gatewayV2) await gatewayV2.close();
  }

  if (overrides.failCheck) {
    const index = checks.findIndex((item) => item.name === overrides.failCheck);
    const failure = { name: overrides.failCheck, ok: false, error: 'injected harness failure' };
    if (index >= 0) checks[index] = failure;
    else checks.push(failure);
  }

  return { ok: checks.length > 0 && checks.every((c) => c.ok), checks };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const invokedDirectly = process.argv[1] && /local-e2e-verify\.mjs$/.test(process.argv[1].replace(/\\/g, '/'));
if (invokedDirectly) {
  // The real handlers log [req]/[capture_*] lines to stdout. Keep the CLI
  // contract ({ok, checks[]} JSON only) by muting those lines for the run, then
  // restore console.log before writing the report.
  const originalLog = console.log;
  let result;
  try {
    console.log = () => {};
    result = await runLocalE2E();
  } finally {
    console.log = originalLog;
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.ok ? 0 : 1;
}
