/**
 * Regression tests for the two proven capture bugs fixed in batch 15 (no D+C
 * architecture rewrite):
 *
 *   1. writeHttpSink ignored `response.ok` -> a 500/429 collector was recorded
 *      as `capture_sink_ok`. It must now throw on any non-2xx and never echo
 *      the response body (which may contain a token).
 *   2. `capture_done.duration` is sampled before the sync sink settles, so it
 *      could not be used as MCP latency. `mcp_latency_ms` is now sampled at the
 *      real `originalEnd` point and includes the sink wait; the legacy field
 *      keeps its old meaning.
 *
 * Only this file, src/capture.js and the batch-15 ledger doc are touched.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { startCapture, captureFailureStats } from '../src/capture.js';

const TOKEN = 'SECRET-TOKEN-DO-NOT-LOG';
const TOKEN_IN_BODY = `{"error":"denied","token":"${TOKEN}"}`;

/** Mirror Node's ServerResponse byte handling for the fake response. */
function toBuffer(chunk) {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  return Buffer.from(String(chunk));
}

function fakeRes() {
  const body = [];
  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    headersSent: false,
    ended: false,
    endCalls: 0,
    endAt: null,
    writeHead(status, headers) {
      this.statusCode = status;
      this.headersSent = true;
      Object.assign(this.headers, headers ?? {});
      return this;
    },
    getHeaders() { return this.headers; },
    write(chunk) {
      body.push(toBuffer(chunk));
      return true;
    },
    end(chunk) {
      this.endCalls += 1;
      if (this.endAt === null) this.endAt = Date.now();
      if (chunk) body.push(toBuffer(chunk));
      this.ended = true;
      return this;
    },
    body,
  };
}

function fakeReq(raw = '{"jsonrpc":"2.0","id":1}') {
  return { method: 'POST', url: '/mcp', headers: { 'mcp-session-id': 'sid-1' }, __gatewayRawBody: raw };
}

function collectLogs() {
  const lines = [];
  return {
    lines,
    log(tag, fields) { lines.push({ tag, fields }); },
    find(tag) { return lines.filter((line) => line.tag === tag); },
    tags() { return lines.map((line) => line.tag); },
  };
}

/** Capture console.error while `fn` runs, restoring it in a finally block. */
async function withCapturedErrors(fn) {
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.map(String).join(' '));
  try {
    return await fn(errors);
  } finally {
    console.error = original;
  }
}

function httpOptions({ status = 200, body = '', log, delayMs = 0, reject, token = TOKEN } = {}) {
  const calls = [];
  return {
    calls,
    options: {
      mode: 'full',
      sink: 'http',
      httpUrl: 'https://collector.example/capture',
      httpToken: token,
      log,
      fetchImpl: async (url, init) => {
        calls.push({ url, init, at: Date.now() });
        if (reject) throw reject;
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
        return { ok: status >= 200 && status < 300, status, text: async () => body };
      },
    },
  };
}

/** Wait until the sink chain has settled (bounded, under full-suite load). */
async function settle(condition, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// ---------------------------------------------------------------------------
// 1. HTTP sink status handling: 200/204 succeed; 500/429 are drops
// ---------------------------------------------------------------------------

for (const status of [200, 204]) {
  test(`HTTP sink status ${status}: sink_ok emitted, no drop`, async () => {
    const logs = collectLogs();
    const before = captureFailureStats().dropped;
    const { options, calls } = httpOptions({ status, log: logs.log });
    await withCapturedErrors(async (errors) => {
      const res = fakeRes();
      startCapture(fakeReq(), res, options);
      res.end('ok');
      await settle(() => logs.find('capture_sink_ok').length === 1);
      assert.deepEqual(errors, [], 'no capture_dropped on 2xx');
    });
    assert.equal(calls.length, 1, 'one POST');
    assert.equal(logs.find('capture_sink_start').length, 1);
    assert.equal(logs.find('capture_sink_ok').length, 1, '2xx must mark sink_ok');
    assert.equal(captureFailureStats().dropped, before, 'no drop counted');
  });
}

for (const status of [500, 429]) {
  test(`HTTP sink status ${status}: no sink_ok, dropped, body token not logged`, async () => {
    const logs = collectLogs();
    const before = captureFailureStats().dropped;
    const { options, calls } = httpOptions({
      status,
      body: TOKEN_IN_BODY,
      log: logs.log,
    });
    let errors = [];
    await withCapturedErrors(async (captured) => {
      const res = fakeRes();
      startCapture(fakeReq(), res, options);
      res.end('ok');
      await settle(() => logs.find('capture_sink_start').length === 1 && captured.length > 0);
      // Give any late sink_ok a chance to appear before asserting its absence.
      await new Promise((resolve) => setTimeout(resolve, 30));
      errors = captured.slice();
    });
    assert.equal(calls.length, 1);
    assert.equal(logs.find('capture_sink_start').length, 1);
    assert.equal(logs.find('capture_sink_ok').length, 0, `${status} must NOT mark sink_ok`);
    assert.equal(captureFailureStats().dropped, before + 1, 'drop counted once');
    assert.ok(errors.some((line) => line.includes('[capture_dropped]')));
    const allText = `${errors.join('\n')}${JSON.stringify(logs.lines)}`;
    assert.ok(!allText.includes(TOKEN), 'no token from response body in logs');
    assert.ok(/status 500|status 429/.test(errors.join('\n')), 'status is recorded');
  });
}

test('HTTP sink rejects on transport error (abort) and still records a drop without sink_ok', async () => {
  const logs = collectLogs();
  const before = captureFailureStats().dropped;
  const abortError = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
  const { options, calls } = httpOptions({ reject: abortError, log: logs.log });
  const errors = [];
  await withCapturedErrors(async (captured) => {
    const res = fakeRes();
    startCapture(fakeReq(), res, options);
    res.end('ok');
    await settle(() => captured.length > 0);
    errors.push(...captured);
  });
  assert.equal(calls.length, 1);
  assert.equal(logs.find('capture_sink_ok').length, 0);
  assert.equal(captureFailureStats().dropped, before + 1);
  assert.ok(errors.some((line) => line.includes('[capture_dropped]')));
});

// ---------------------------------------------------------------------------
// 2. mcp_latency_ms is sampled at the real originalEnd point
// ---------------------------------------------------------------------------

test('sync mode: mcp_latency_ms includes sink wait, legacy duration does not', async () => {
  const logs = collectLogs();
  const delayMs = 120;
  const { options, calls } = httpOptions({ status: 200, delayMs, log: logs.log });
  const res = fakeRes();
  startCapture(fakeReq(), res, { ...options, sync: true });
  res.end('payload');
  // In sync mode originalEnd is deferred until the sink settles. The sink is
  // dispatched in a microtask, so wait for the fake fetch before asserting.
  assert.equal(res.ended, false, 'response held until sink completes');
  await settle(() => calls.length === 1);
  assert.equal(res.ended, false, 'still held while sink is in flight');
  await settle(() => res.ended);

  const done = logs.find('capture_done')[0];
  const flush = logs.find('capture_flush_end')[0];
  assert.ok(done, 'capture_done present');
  assert.ok(flush, 'capture_flush_end present');
  assert.equal(typeof done.fields.duration, 'number');
  assert.equal(typeof flush.fields.mcp_latency_ms, 'number', 'new independent field');
  assert.equal(flush.fields.sync, true);
  assert.equal(flush.fields.sink, 'http');
  assert.ok(flush.fields.waitedMs >= delayMs - 20, `waitedMs=${flush.fields.waitedMs} should include sink delay`);
  assert.ok(
    flush.fields.mcp_latency_ms >= done.fields.duration + delayMs - 30,
    `mcp_latency_ms=${flush.fields.mcp_latency_ms} must include the ${delayMs}ms sink wait; duration=${done.fields.duration}`,
  );
  // The fake response records its own end time inside originalEnd; the flush
  // log's endAt is sampled immediately before that call. Comparing these two
  // (rather than wall-clock now) is deterministic even under full-suite load.
  assert.equal(
    new Date(flush.fields.endAt).getTime(),
    res.endAt,
    'endAt matches the actual originalEnd execution time',
  );
  assert.equal(logs.find('capture_sink_ok').length, 1);
  assert.equal(Buffer.concat(res.body).toString(), 'payload');
});

test('async mode: originalEnd is immediate; mcp_latency_ms excludes sink wait', async () => {
  const logs = collectLogs();
  const delayMs = 120;
  const { options, calls } = httpOptions({ status: 200, delayMs, log: logs.log });
  const res = fakeRes();
  startCapture(fakeReq(), res, { ...options, sync: false });
  res.end('payload');
  assert.equal(res.ended, true, 'async mode ends immediately');
  await settle(() => calls.length === 1);
  const flush = logs.find('capture_flush_end')[0];
  assert.ok(flush, 'capture_flush_end still logged');
  assert.equal(flush.fields.sync, false);
  assert.ok(flush.fields.mcp_latency_ms < delayMs, 'latency measured before sink settles');
  assert.ok(flush.fields.waitedMs < delayMs, 'no sink wait in async path');
  assert.equal(calls.length, 1);
  await settle(() => logs.find('capture_sink_ok').length === 1);
});

test('default CAPTURE_SYNC behaviour unchanged: sync only when explicitly enabled', async () => {
  const logs = collectLogs();
  const { options } = httpOptions({ status: 200, log: logs.log });
  const res = fakeRes();
  // No `sync` option and no CAPTURE_SYNC env read here (configFromOptions uses
  // process.env.CAPTURE_SYNC === '1'); in the test process it is unset.
  startCapture(fakeReq(), res, options);
  res.end('ok');
  assert.equal(res.ended, true, 'default is async/non-blocking');
  const flush = logs.find('capture_flush_end')[0];
  assert.equal(flush.fields.sync, false);
});

// ---------------------------------------------------------------------------
// 3. Abort / retry paths must not write the sink twice
// ---------------------------------------------------------------------------

test('abort then retry: only one sink POST and one envelope, response bytes intact', async () => {
  const logs = collectLogs();
  const before = captureFailureStats().dropped;
  const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' });
  const { options, calls } = httpOptions({ reject: abortError, log: logs.log });
  const req = fakeReq();
  const res = fakeRes();
  await withCapturedErrors(async () => {
    const ctx = startCapture(req, res, options);
    assert.ok(ctx);
    res.write('part-1');
    res.end('part-2');
    await settle(() => calls.length === 1);

    // Retry paths: another startCapture on the same req (idempotency guard)
    // and another res.end (finished guard) must not queue a second write.
    const again = startCapture(req, res, options);
    assert.equal(again, ctx, 'idempotency guard reuses the original context');
    res.end('retried');
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
  assert.equal(calls.length, 1, 'sink written exactly once');
  assert.equal(logs.find('capture_ack').length, 1);
  assert.equal(logs.find('capture_done').length, 1);
  assert.equal(logs.find('capture_flush_end').length, 1, 'one end point');
  assert.equal(captureFailureStats().dropped, before + 1);
  assert.equal(Buffer.concat(res.body).toString(), 'part-1part-2retried');
});

test('sync-mode retry after failure also writes only once', async () => {
  const logs = collectLogs();
  const before = captureFailureStats().dropped;
  const { options, calls } = httpOptions({ status: 500, log: logs.log });
  const req = fakeReq();
  const res = fakeRes();
  await withCapturedErrors(async () => {
    startCapture(req, res, { ...options, sync: true });
    res.end('first');
    await settle(() => res.ended);
    res.end('second');
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  assert.equal(calls.length, 1, 'non-2xx still writes once; no retry duplicate');
  assert.equal(captureFailureStats().dropped, before + 1);
  assert.equal(logs.find('capture_done').length, 1);
  assert.equal(logs.find('capture_flush_end').length, 1);
  assert.equal(Buffer.concat(res.body).toString(), 'firstsecond');
});

// ---------------------------------------------------------------------------
// 4. Response bytes are byte-for-byte unchanged by the fix
// ---------------------------------------------------------------------------

test('response bytes unchanged with capture on vs off (string + Uint8Array chunks)', async () => {
  const chunks = [
    Buffer.from('{"jsonrpc":"2.0",'),
    new TextEncoder().encode('"result":{"ok":true}}\n'),
  ];
  const expected = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString();

  const offRes = fakeRes();
  // No capture started.
  offRes.write(chunks[0]);
  offRes.end(chunks[1]);

  const onRes = fakeRes();
  const logs = collectLogs();
  const originalLog = console.log;
  console.log = () => {};
  try {
    startCapture(fakeReq(), onRes, {
      mode: 'full',
      sink: 'console',
      log: logs.log,
      fetchImpl: async () => ({ ok: true, status: 200 }),
    });
    onRes.write(chunks[0]);
    onRes.end(chunks[1]);
    // Console sink writes in a microtask; let it run before restoring the log.
    await settle(() => logs.find('capture_sink_ok').length === 1);
  } finally {
    console.log = originalLog;
  }

  assert.equal(Buffer.concat(onRes.body).toString(), expected);
  assert.deepEqual(onRes.body.map((b) => b.toString()), offRes.body.map((b) => b.toString()));
  assert.ok(logs.find('capture_flush_end').length === 1, 'flush log added without touching bytes');
});
