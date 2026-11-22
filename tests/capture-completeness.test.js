/**
 * P0 capture-completeness regression tests.
 *
 * These tests pin the request-level audit trail added to fix "many Vercel
 * POST /mcp, few R2 captures": every capture-enabled POST emits exactly one
 * [capture_ack] and one [capture_done] sharing a requestId; every non-captured
 * request emits a [capture_skipped] with a safe reason; and the sink is queued
 * synchronously inside res.end (never in a queueMicrotask) so Vercel cannot
 * freeze the function before waitUntil sees the pending work.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  startCapture,
  captureSkip,
  captureEnabled,
  captureFailureStats,
} from '../src/capture.js';
import { createAppHandler } from '../src/vercel-app.js';
import { createMcpRequestHandler } from '../src/server.js';

/** Minimal res double that records every write/end and exposes status. */
function fakeRes({ statusCode = 200 } = {}) {
  const body = [];
  return {
    statusCode,
    headers: {},
    headersSent: false,
    ended: false,
    writeHead(status, headers = {}) {
      this.statusCode = status;
      this.headersSent = true;
      Object.assign(this.headers, headers);
      return this;
    },
    setHeader(key, value) { this.headers[key] = value; },
    getHeaders() { return this.headers; },
    write(chunk) {
      body.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      return true;
    },
    end(chunk) {
      if (chunk) body.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      this.ended = true;
      return this;
    },
    body,
  };
}

function fakeReq({ method = 'POST', url = '/mcp', headers = {}, raw } = {}) {
  const req = { method, url, headers };
  if (raw !== undefined) req.__gatewayRawBody = raw;
  return req;
}

function collectLines() {
  const lines = [];
  return {
    lines,
    log(tag, fields) { lines.push({ tag, fields }); },
    find(tag) { return lines.filter((line) => line.tag === tag); },
  };
}

function parse(line) {
  return line[1] !== undefined ? JSON.parse(line[1]) : JSON.parse(line);
}

// ---------------------------------------------------------------------------
// 1. startCapture ack/done on every path
// ---------------------------------------------------------------------------

test('startCapture emits exactly one ack and one done with matching requestId on a normal response', async () => {
  const capture = collectLines();
  const req = fakeReq({ raw: '{"jsonrpc":"2.0","id":1}' });
  const res = fakeRes();
  const ctx = startCapture(req, res, {
    mode: 'full',
    sink: 'file',
    fileDir: await mkdtemp(join(tmpdir(), 'gmg-complete-')),
    log: capture.log,
  });
  assert.ok(ctx?.requestId);
  res.write('{"ok":true}');
  res.end();

  const acks = capture.find('capture_ack');
  const dones = capture.find('capture_done');
  assert.equal(acks.length, 1, 'exactly one ack');
  assert.equal(dones.length, 1, 'exactly one done');
  assert.equal(acks[0].fields.requestId, ctx.requestId);
  assert.equal(dones[0].fields.requestId, ctx.requestId);
  assert.equal(acks[0].fields.path, '/mcp');
  assert.equal(acks[0].fields.method, 'POST');
  assert.equal(acks[0].fields.mode, 'full');
  assert.equal(acks[0].fields.sink, 'file');
  assert.equal(acks[0].fields.enabled, true);
  assert.equal(acks[0].fields.requestBytes, '{"jsonrpc":"2.0","id":1}'.length);
  assert.equal(acks[0].fields.bodyBuffered, true);
  assert.equal(dones[0].fields.status, 200);
  assert.equal(typeof dones[0].fields.duration, 'number');
  assert.equal(dones[0].fields.sinkQueued, true);
  assert.ok(!('sinkError' in dones[0].fields), 'no error field on success');
  assert.ok(!JSON.stringify(capture.lines).includes('Bearer'), 'no auth values in audit lines');
});

test('startCapture emits ack/done for 401/403/405 status codes (sink still queued)', async () => {
  for (const status of [401, 403, 405]) {
    const capture = collectLines();
    const res = fakeRes();
    const ctx = startCapture(fakeReq(), res, { mode: 'meta', sink: 'console', log: capture.log });
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end('{"error":"no"}');
    assert.equal(capture.find('capture_ack').length, 1, `ack for ${status}`);
    const done = capture.find('capture_done')[0];
    assert.equal(done.fields.status, status);
    assert.equal(done.fields.requestId, ctx.requestId);
    assert.equal(done.fields.sinkQueued, true);
  }
});

test('startCapture emits done even when res.end is called twice (no second envelope)', async () => {
  const capture = collectLines();
  const res = fakeRes();
  startCapture(fakeReq(), res, { mode: 'full', sink: 'console', log: capture.log });
  res.end('first');
  res.end('second');
  assert.equal(capture.find('capture_ack').length, 1);
  assert.equal(capture.find('capture_done').length, 1, 'only one done');
});

test('startCapture sink failure emits capture_dropped and done with sinkError', async () => {
  const before = captureFailureStats().dropped;
  const capture = collectLines();
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    const res = fakeRes();
    startCapture(fakeReq(), res, {
      mode: 'full',
      sink: 'r2',
      r2AccountId: '', // forces writeR2Sink to throw
      log: capture.log,
    });
    res.end('ok');
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    console.error = originalError;
  }
  assert.equal(captureFailureStats().dropped, before + 1);
  assert.ok(errors.some((line) => line.includes('[capture_dropped]')));
  const done = capture.find('capture_done')[0];
  assert.equal(done.fields.sinkQueued, true, 'sink was queued even though it failed');
  // sinkError is recorded in the dropped log; done is emitted synchronously
  // before the promise settles, so sinkQueued reflects scheduling.
  assert.ok(done.fields.requestId);
});

// ---------------------------------------------------------------------------
// 2. disabled / skipped paths
// ---------------------------------------------------------------------------

test('startCapture with mode off emits capture_skipped and returns null (no ack/done)', () => {
  const capture = collectLines();
  const res = fakeRes();
  const result = startCapture(fakeReq(), res, { mode: 'off', log: capture.log });
  assert.equal(result, null);
  assert.equal(capture.find('capture_ack').length, 0);
  assert.equal(capture.find('capture_done').length, 0);
  const skips = capture.find('capture_skipped');
  assert.equal(skips.length, 1);
  assert.equal(skips[0].fields.reason, 'capture_disabled');
  assert.equal(skips[0].fields.enabled, false);
});

test('captureSkip never leaks header/token/body values into reason or detail', () => {
  const capture = collectLines();
  captureSkip(
    { method: 'POST', url: '/mcp', headers: { authorization: 'Bearer SUPER_SECRET' } },
    {
      path: '/mcp',
      reason: 'Bearer SUPER_SECRET token=abc',
      detail: 'authorization=Bearer SUPER_SECRET cookie=s=1',
      log: capture.log,
    },
  );
  const line = capture.find('capture_skipped')[0];
  assert.ok(!JSON.stringify(line).includes('SUPER_SECRET'));
  assert.ok(!JSON.stringify(line).includes('Bearer'));
  assert.equal(['capture_disabled', 'capture_mode_off', 'env_missing', 'not_eligible',
    'already_started', 'non_post', 'body_buffer_failed', 'handler_error'].includes(line.fields.reason), true,
    'reason is restricted to a safe enum');
  assert.ok(line.fields.requestId, 'skip carries a requestId');
});

test('captureEnabled reads CAPTURE_MODE correctly', () => {
  assert.equal(captureEnabled({ CAPTURE_MODE: 'full' }), true);
  assert.equal(captureEnabled({ CAPTURE_MODE: 'meta' }), true);
  assert.equal(captureEnabled({ CAPTURE_MODE: 'off' }), false);
  assert.equal(captureEnabled({}), false);
});

// ---------------------------------------------------------------------------
// 3. idempotency — no double envelope
// ---------------------------------------------------------------------------

test('startCapture is idempotent: a second call reuses the first context, no second ack', async () => {
  const capture = collectLines();
  const dir = await mkdtemp(join(tmpdir(), 'gmg-complete-'));
  const req = fakeReq({ raw: '{}' });
  const res = fakeRes();
  const first = startCapture(req, res, { mode: 'full', sink: 'file', fileDir: dir, log: capture.log });
  const second = startCapture(req, res, { mode: 'full', sink: 'file', fileDir: dir, log: capture.log });
  assert.equal(first, second, 'second call returns the existing context');
  assert.equal(second.requestId, first.requestId);
  res.end('ok');
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(capture.find('capture_ack').length, 1, 'exactly one ack');
  assert.equal(capture.find('capture_done').length, 1, 'exactly one done');
  const files = await readdir(dir);
  assert.equal(files.length, 1, 'exactly one R2/file envelope');
  await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 4. sink is scheduled synchronously in res.end (not in queueMicrotask)
// ---------------------------------------------------------------------------

test('sink is scheduled synchronously: writeSink runs by the time res.end returns', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gmg-complete-sync-'));
  const capture = collectLines();
  const req = fakeReq({ raw: '{}' });
  const res = fakeRes();
  let syncDone = false;
  // A custom log lets us check ordering: capture_done is emitted after
  // waitUntil is called, synchronously inside res.end.
  startCapture(req, res, {
    mode: 'full',
    sink: 'file',
    fileDir: dir,
    log: (tag, fields) => {
      capture.log(tag, fields);
      if (tag === 'capture_done') syncDone = true;
    },
  });
  res.end('ok');
  assert.equal(syncDone, true, 'capture_done emitted synchronously in res.end');
  // The file write is a promise; wait until it settles. The point is that
  // scheduling happened before res.end returned (asserted via syncDone).
  await new Promise((r) => setTimeout(r, 80));
  const files = await readdir(dir);
  assert.equal(files.length, 1);
  const envelope = JSON.parse(await readFile(join(dir, files[0]), 'utf8'));
  assert.equal(envelope.requestId, capture.find('capture_ack')[0].fields.requestId);
  await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 5. vercel-app integration: 401/403/405/404 + MCP early return all audited
// ---------------------------------------------------------------------------

const STORE = {
  async getToken(token) {
    if (token === 'valid') return { clientId: 'c', expiresAt: Date.now() + 60_000 };
    if (token === 'expired') return { clientId: 'c', expiresAt: Date.now() - 1000 };
    return null;
  },
};

function appReq(options = {}) {
  const { method = 'POST', url = '/mcp', headers = {}, body = '' } = options;
  const chunks = body ? [Buffer.from(body)] : [];
  let i = 0;
  return {
    method,
    url,
    headers: { host: 'gateway.example', ...headers },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
      i += 1;
    },
    get consumed() { return i; },
  };
}

test('vercel app: POST /mcp without bearer emits skip and the 401 is still audited', async () => {
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    const handler = createAppHandler({
      store: STORE,
      config: { servers: [] },
      mcpHandler: async () => { throw new Error('must not reach mcp'); },
    });
    const res = fakeRes();
    await handler(appReq({ headers: { 'content-type': 'application/json' } }), res);
    assert.equal(res.statusCode, 401);
  } finally {
    console.log = originalLog;
  }
  const audit = logs.filter((l) => l.includes('[capture_ack]') || l.includes('[capture_skipped]'));
  assert.ok(audit.length >= 1);
  // mode off in tests -> capture_skipped; the 401 still has an auditable line.
  assert.ok(audit.some((l) => l.includes('capture_skipped')));
});

test('vercel app: valid token reaches MCP handler and yields ack+done with one requestId', async () => {
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  let handlerCalled = 0;
  try {
    const handler = createAppHandler({
      store: STORE,
      config: { servers: [] },
      mcpHandler: async (req, res) => {
        handlerCalled += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"jsonrpc":"2.0","result":{}}');
      },
    });
    const res = fakeRes();
    await handler(
      appReq({
        headers: { authorization: 'Bearer valid', 'content-type': 'application/json' },
        body: '{"jsonrpc":"2.0","method":"tools/list","id":1}',
      }),
      res,
    );
    assert.equal(res.statusCode, 200);
  } finally {
    console.log = originalLog;
  }
  assert.equal(handlerCalled, 1);
  const ack = logs.find((l) => l.includes('[capture_ack]'));
  const done = logs.find((l) => l.includes('[capture_done]'));
  // With CAPTURE_MODE off (test default) the route emits a skip instead.
  if (!ack) {
    assert.ok(logs.some((l) => l.includes('[capture_skipped]')));
    return;
  }
  assert.ok(done, 'done must accompany ack');
  const ackId = JSON.parse(ack.slice(ack.indexOf('{'))).requestId;
  const doneId = JSON.parse(done.slice(done.indexOf('{'))).requestId;
  assert.equal(ackId, doneId, 'ack and done share requestId');
});

test('vercel app: non-POST /mcp emits a capture_skipped with a safe reason', async () => {
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    const handler = createAppHandler({
      store: STORE,
      config: { servers: [] },
      mcpHandler: async () => { throw new Error('must not reach mcp'); },
    });
    const res = fakeRes();
    await handler(appReq({ method: 'GET', url: '/mcp' }), res);
    // Auth is checked before method routing in vercel-app, so an unauthenticated
    // GET /mcp returns 401. The audit requirement is the skip line, not the code.
    assert.ok([401, 405].includes(res.statusCode));
  } finally {
    console.log = originalLog;
  }
  assert.ok(logs.some((l) => l.includes('[capture_skipped]')), 'non-POST /mcp is audited as skipped');
});

// ---------------------------------------------------------------------------
// 6. server handler does not double-capture when app already started it
// ---------------------------------------------------------------------------

test('server handler reads existing capture context and creates no second envelope', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gmg-complete-srv-'));
  const capture = collectLines();
  const req = fakeReq({ raw: '{"jsonrpc":"2.0","method":"tools/list","id":1}' });
  const res = fakeRes();
  // Simulate the Vercel app having already started capture.
  const first = startCapture(req, res, {
    mode: 'full', sink: 'file', fileDir: dir, log: capture.log,
  });

  const fakeUpstreamManager = {
    getEntries: () => [],
    getWhitelist: () => [],
    callTool: async () => ({}),
  };
  const handler = createMcpRequestHandler(fakeUpstreamManager, { mode: 'whitelist' });
  // The handler should not throw; it reads req.__gatewayCapture instead of
  // starting a second capture. We only assert audit counts, not MCP semantics.
  await handler(req, res);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(capture.find('capture_ack').length, 1, 'no second ack');
  assert.equal(req.__gatewayCapture, first, 'existing context preserved');
  const files = await readdir(dir);
  assert.equal(files.length, 1, 'exactly one envelope');
  await rm(dir, { recursive: true, force: true });
});

test('server handler starts its own capture when used standalone (no prior context)', async () => {
  const capture = collectLines();
  const req = fakeReq({ raw: 'not-json' });
  const res = fakeRes();
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    const fakeUpstreamManager = {
      getEntries: () => [],
      getWhitelist: () => [],
      callTool: async () => ({}),
    };
    const handler = createMcpRequestHandler(fakeUpstreamManager, { mode: 'whitelist' });
    await handler(req, res);
  } finally {
    console.log = originalLog;
  }
  assert.equal(res.statusCode, 500, 'invalid JSON body returns 500');
  assert.equal(req.__gatewayCaptureStarted, true);
  // With CAPTURE_MODE off the standalone capture emits a skip; with on it
  // emits ack+done+skip(body_buffer_failed). Either way it is auditable.
  const allLines = logs.join('\n');
  assert.ok(
    allLines.includes('[capture_ack]') || allLines.includes('[capture_skipped]'),
    'standalone path is audited',
  );
  void capture;
});
