/**
 * Batch 16 — regression tests for the full-repo audit G-03 / G-07 fixes.
 *
 * G-03: /mcp/v2 plan paths had no real IO adapter when the caller did not
 *       inject `typedPlanIO`; the engine's fail-closed branch made every plan
 *       (even pure reads) unusable. v1 `codemode.runTypedPlan` builds a REAL
 *       adapter from the upstream bridge. Fix: v2 uses the same injection seam.
 * G-07: vercel-app.js called startCapture() with only { path, bodyBuffered,
 *       requestBytes }, dropping injected options (oauthClientMap / sink /
 *       asyncQueue / log / queueSink / ...). Fix: spread the options through.
 *
 * Fully offline: no network, no credentials, no filesystem writes. Constraints:
 *   - v1 three tools / schema unchanged (tested here, not edited);
 *   - default behavior unchanged (no injection => same fail-closed / env path).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createCodeModeTools } from '../src/codemode.js';
import { createCodeModeToolsV2 as createV2 } from '../src/codemode-v2.js';
import { createAppHandler } from '../src/vercel-app.js';

// ---------------------------------------------------------------------------
// Fakes / helpers
// ---------------------------------------------------------------------------

const PATCH = '@@ -2,1 +2,1 @@\n-two\n+TWO\n';

function fakeIO(files = { 'a.txt': 'one\ntwo\nthree\n' }) {
  const calls = [];
  const record = (op, args, value) => { calls.push({ op, args: { ...args } }); return value; };
  return {
    calls,
    readFileRange: async (args) => record('readFileRange', args, {
      path: args.path,
      text: files[args.path] ?? '',
      lines: (files[args.path] ?? '').split('\n'),
      truncated: false,
    }),
    repoGrep: async (args) => record('repoGrep', args, { matches: [], pattern: args.pattern }),
    ensureBranch: async (args) => record('ensureBranch', args, { branch: args.branch, created: true }),
    writeFile: async (args) => record('writeFile', args, { path: args.path, written: true }),
    openPr: async (args) => record('openPr', args, { number: 1, head: args.head, base: args.base }),
    runChecks: async (args) => record('runChecks', args, { command: args.command, ok: true }),
  };
}

function emptyManager() {
  return {
    getEntries: () => [],
    getWhitelist: () => [],
    callTool: async () => { throw new Error('unexpected upstream call'); },
  };
}

/** Manager exposing one real-looking upstream file tool (default IO seam). */
function fileManager(calls) {
  return {
    getEntries: () => [{
      name: 'github__get_file_contents',
      server: 'github',
      tool: 'get_file_contents',
      inputSchema: { type: 'object', properties: {} },
    }],
    getWhitelist: () => [],
    callTool: async (server, tool, args) => {
      calls.push({ server, tool, args });
      // Upstream envelope shape that hostNormalizeResult/fileTextFromRaw read.
      return {
        content: [{ type: 'text', text: JSON.stringify({ content: 'one\ntwo\nthree\n', sha: 'abc' }) }],
      };
    },
  };
}

function parseResult(res) {
  if (res && typeof res === 'object' && 'result' in res && typeof res.result === 'object') {
    return res.result;
  }
  return res;
}

// ---------------------------------------------------------------------------
// G-03 · v2 plan execution
// ---------------------------------------------------------------------------

test('G-03: v2 execute_read runs a read plan with an injected IO adapter', async () => {
  const io = fakeIO();
  const [, readTool] = createV2(emptyManager(), { mode: 'codemode', typedPlanIO: io });
  const result = parseResult(await readTool.handler({
    plan: [{ op: 'readFileRange', path: 'a.txt', startLine: 1, endLine: 2 }],
  }));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.steps.map((s) => s.op), ['readFileRange']);
  assert.equal(result.meta.readOnly, true);
  assert.equal(result.meta.protocolVersion, 'v2');
  assert.ok(io.calls.some((c) => c.op === 'readFileRange'));
});

test('G-03: v2 execute write plan with dryRun executes with real IO (no side effect)', async () => {
  const io = fakeIO();
  const [, , execTool] = createV2(emptyManager(), { mode: 'codemode', typedPlanIO: io });
  const result = parseResult(await execTool.handler({
    plan: [{ op: 'applyPatch', path: 'a.txt', patch: PATCH }],
    dryRun: true,
  }));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.dryRun, true);
  assert.equal(result.steps[0].result.dryRun, true);
  assert.ok(result.steps[0].result.preview !== undefined);
  assert.equal(io.calls.some((c) => c.op === 'writeFile'), false, 'no real write in dryRun');
});

test('G-03: v2 builds a REAL default IO from upstreamManager when none is injected', async () => {
  // This is the failing scenario from the audit: no `typedPlanIO`, manager with
  // a real get_file_contents tool. v1 would build a default adapter here; v2
  // must do the same through the identical injection seam.
  const calls = [];
  const [, readTool] = createV2(fileManager(calls), { mode: 'codemode' });
  const result = parseResult(await readTool.handler({
    plan: [{ op: 'readFileRange', path: 'a.txt', startLine: 1, endLine: 2 }],
  }));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.steps.map((s) => s.op), ['readFileRange']);
  assert.equal(calls.length, 1, 'default IO performed one upstream read call');
  assert.equal(calls[0].tool, 'get_file_contents');
});

test('G-03: no adapter available => explicit fail-closed error, zero steps', async () => {
  // Neither an injected adapter nor a usable upstream tool bridge exists.
  const [, readTool] = createV2(emptyManager(), { mode: 'codemode' });
  const result = parseResult(await readTool.handler({
    plan: [{ op: 'readFileRange', path: 'a.txt', startLine: 1, endLine: 2 }],
  }));
  assert.equal(result.ok, false);
  assert.deepEqual(result.steps, [], 'zero side effects');
  assert.match(result.error, /io adapter is required/);
  assert.match(result.meta.protocolVersion ?? 'v2', /v2/);
});

test('G-03: v1 three tools and code-only schema remain byte-for-byte unchanged', () => {
  const manager = emptyManager();
  const v1 = createCodeModeTools(manager, {});
  const v2 = createV2(manager, { typedPlanIO: fakeIO() });
  assert.deepEqual(v1.map((t) => t.name), ['search', 'execute_read', 'execute']);
  assert.deepEqual(v2.map((t) => t.name), ['search', 'execute_read', 'execute']);
  assert.deepEqual(v1[2].inputSchema.required, ['code']);
  assert.ok(!('plan' in v1[2].inputSchema.properties), 'v1 execute has no plan field');
  assert.deepEqual(v1[1].inputSchema, {
    type: 'object',
    properties: { code: { type: 'string', description: 'An async arrow function that calls codemode tools and returns a result.' } },
    required: ['code'],
  });
});

// ---------------------------------------------------------------------------
// G-07 · capture options passthrough in vercel-app.js
// ---------------------------------------------------------------------------

function fakeRes() {
  const body = [];
  return {
    statusCode: 200,
    headersSent: false,
    headers: {},
    writeHead(status, headers) { this.statusCode = status; this.headersSent = true; Object.assign(this.headers, headers ?? {}); },
    setHeader(k, v) { this.headers[k] = v; },
    getHeaders() { return this.headers; },
    write(chunk) { body.push(Buffer.from(String(chunk))); return true; },
    end(chunk) { if (chunk) body.push(Buffer.from(String(chunk))); this.ended = true; return this; },
    body,
  };
}

async function dispatchCapture(app, { oauthClientId } = {}) {
  const req = {
    url: '/mcp',
    method: 'POST',
    headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
    __gatewayRawBody: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    ...(oauthClientId ? { oauthClientId } : {}),
  };
  const res = fakeRes();
  await app(req, res);
  return { req, res };
}

test('G-07: startCapture receives injected log/sink/asyncQueue/queueSink options', async () => {
  const logs = [];
  const envelopes = [];
  const app = createAppHandler({
    mcpHandler: async (req, res) => { res.writeHead(200, {}); res.end('{"ok":true}'); },
    store: { getToken: async () => ({ expiresAt: Date.now() + 60_000 }) },
    // Injected capture options — these used to be dropped by vercel-app.js.
    log: (tag, fields) => logs.push({ tag, fields }),
    mode: 'full',
    sink: 'http',
    asyncQueue: true,
    queueBatchSize: 1,
    queueFlushIntervalMs: 0,
    oauthClientMap: { 'client-chatgpt': 'chatgpt' },
    queueSink: async (batch) => {
      for (const item of batch) if (item?.envelope) envelopes.push(item.envelope);
    },
  });
  await dispatchCapture(app, { oauthClientId: 'client-chatgpt' });
  // Let the microtask-scheduled queue flush deliver the envelope.
  await new Promise((r) => setTimeout(r, 20));

  const ack = logs.find((l) => l.tag === 'capture_ack');
  assert.ok(ack, 'injected log callback received capture_ack');
  assert.equal(ack.fields.sink, 'http', 'injected sink reached startCapture');
  const queueMode = logs.find((l) => l.tag === 'capture_queue_mode');
  assert.ok(queueMode, 'asyncQueue option reached startCapture (capture_queue_mode emitted)');
  assert.equal(queueMode.fields.asyncQueue, true);

  assert.equal(envelopes.length, 1, 'injected queueSink received the envelope');
  assert.equal(envelopes[0].clientPlatform, 'chatgpt', 'injected oauthClientMap took effect');
  assert.equal(envelopes[0].clientProfile, 'chatgpt-structured');
  assert.equal(envelopes[0].oauthClientId, 'client-chatgpt');
});

test('G-07: default behavior unchanged — no options still uses env/defaults', async () => {
  // With no injected capture options, startCapture sees no `mode`, so capture
  // stays off and the audit line uses the built-in default sink 'file'. This is
  // byte-for-byte the previous behavior (options was previously not spread).
  const logs = [];
  const app = createAppHandler({
    mcpHandler: async (req, res) => { res.writeHead(200, {}); res.end('{"ok":true}'); },
    store: { getToken: async () => ({ expiresAt: Date.now() + 60_000 }) },
    log: (tag, fields) => logs.push({ tag, fields }),
    env: { ENABLE_MCP_V2: '0' },
  });
  await dispatchCapture(app);
  const skipped = logs.find((l) => l.tag === 'capture_skipped');
  assert.ok(skipped, 'capture disabled audit line still emitted');
  assert.equal(skipped.fields.enabled, false);
  assert.equal(skipped.fields.sink, 'file', 'default sink unchanged when not injected');
  assert.equal(logs.some((l) => l.tag === 'capture_queue_mode'), false, 'async queue stays off by default');
});

test('G-07: explicit per-request route fields still override injected options', async () => {
  // The spread must not let a caller-supplied path/bodyBuffered/requestBytes
  // override the route's authoritative values.
  const logs = [];
  const app = createAppHandler({
    mcpHandler: async (req, res) => { res.writeHead(200, {}); res.end('{"ok":true}'); },
    store: { getToken: async () => ({ expiresAt: Date.now() + 60_000 }) },
    log: (tag, fields) => logs.push({ tag, fields }),
    mode: 'full',
    sink: 'console',
    path: '/injected-should-not-win',
    requestBytes: -1,
  });
  await dispatchCapture(app);
  const ack = logs.find((l) => l.tag === 'capture_ack');
  assert.ok(ack);
  assert.equal(ack.fields.path, '/mcp', 'route path wins over injected path');
  assert.ok(ack.fields.requestBytes > 0, 'route requestBytes (buffered body length) wins over injected -1');
  assert.notEqual(ack.fields.requestBytes, -1, 'injected requestBytes did not override route value');
  assert.equal(ack.fields.sink, 'console', 'injected sink still applies');
});
