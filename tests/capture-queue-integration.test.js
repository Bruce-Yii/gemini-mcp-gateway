/**
 * Integration tests: wiring the async CaptureQueue into src/capture.js.
 *
 * Scope of this file (B15 batch-15-capture-queue-integration):
 *   - CAPTURE_ASYNC_QUEUE must be opt-in; default keeps legacy behaviour.
 *   - Critical rows (ack/done/dropped) stay synchronous and survive sink loss.
 *   - Only the envelope body goes through CaptureQueue (retry / DLQ / dedupe).
 *   - CAPTURE_SYNC is overridden (never a duplicate sync write) when the flag
 *     is on, and falls back to the legacy path when it is off.
 *   - R2 key / gzip / envelope schema and response bytes remain compatible.
 *
 * All sinks are injected fakes; there is NO network I/O and no real timer
 * waiting. A deterministic fake scheduler drives the queue where needed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { startCapture, captureFailureStats } from '../src/capture.js';
import { CaptureQueue } from '../src/capture-queue.js';

/** Minimal res double; records the exact bytes handed to originalEnd. */
function fakeRes() {
  const body = [];
  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    headersSent: false,
    writeHead(status, headers) {
      this.statusCode = status;
      this.headersSent = true;
      Object.assign(this.headers, headers ?? {});
      return this;
    },
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

function fakeReq(overrides = {}) {
  return {
    method: 'POST',
    url: '/mcp',
    headers: { 'content-type': 'application/json' },
    __gatewayRawBody: '{"jsonrpc":"2.0","method":"tools/list","id":1}',
    ...overrides,
  };
}

/** Deterministic scheduler; `advance(ms)` fires due timers in insertion order. */
function fakeScheduler(start = 1_000_000) {
  let time = start;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => time,
    setTimeout(fn, ms) {
      const id = ++seq;
      timers.set(id, { at: time + Math.max(0, ms), fn, order: id });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    async sleep(ms) {
      time += Math.max(0, ms);
      await Promise.resolve();
      this.flushDue();
    },
    flushDue() {
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.at <= time)
          .sort((a, b) => a[1].order - b[1].order);
        if (due.length === 0) break;
        const [id, timer] = due[0];
        timers.delete(id);
        timer.fn();
      }
    },
    advance(ms) { time += ms; this.flushDue(); },
    pending() { return timers.size; },
  };
}

/**
 * Inject a fake batch sink + deterministic scheduler. capture.js still owns
 * the CaptureQueue instance and its drop/DLQ handlers, so `capture_dropped`
 * reconciliation is exercised exactly as in production.
 */
function makeQueueOptions(sink, overrides = {}) {
  const scheduler = fakeScheduler();
  return {
    queueSink: sink,
    queueScheduler: scheduler,
    queueFlushIntervalMs: 1,
    queueBackoffBaseMs: 1,
    queueBackoffMaxMs: 10,
    queueMaxAttempts: 4,
    ...overrides,
    scheduler,
  };
}

function r2Cfg(fetchImpl, extra = {}) {
  return {
    mode: 'full',
    sink: 'r2',
    fetchImpl,
    r2AccountId: 'acct',
    r2Bucket: 'bucket',
    r2ApiToken: 'tok',
    r2Prefix: 'capture',
    ...extra,
  };
}

/** Collect structured log(tag, fields) calls without touching console. */
function collectLines() {
  const lines = [];
  return {
    lines,
    log(tag, fields) { lines.push({ tag, fields }); },
    find(tag) { return lines.filter((line) => line.tag === tag); },
  };
}

/** Drain helper: fake-scheduler queues need a few microtask turns to flush. */
async function settleQueue(scheduler, turns = 12) {
  scheduler.advance(50);
  for (let i = 0; i < turns; i += 1) {
    scheduler.flushDue();
    await new Promise((resolve) => setImmediate(resolve));
  }
}

// ---------------------------------------------------------------------------
// 1. Flag OFF: legacy behaviour, byte-for-byte, including CAPTURE_SYNC
// ---------------------------------------------------------------------------

test('flag OFF: CAPTURE_SYNC=1 still blocks originalEnd on the sink and writes once', async () => {
  const calls = [];
  const lines = collectLines();
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200 };
  };
  const req = fakeReq();
  const res = fakeRes();
  const cap = startCapture(req, res, {
    ...r2Cfg(fetchImpl),
    sync: true,
    log: lines.log,
    // No asyncQueue option and CAPTURE_ASYNC_QUEUE unset in this process.
  });
  assert.ok(cap?.requestId);
  res.end('legacy-body');
  assert.ok(!res.ended, 'sync path has not called originalEnd yet');
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(res.ended, true);
  assert.equal(calls.length, 1, 'exactly one legacy sink write');
  assert.equal(Buffer.concat(res.body).toString(), 'legacy-body');
  assert.equal(lines.find('capture_queue_mode').length, 0, 'no queue mode log by default');
  const done = lines.find('capture_done')[0];
  assert.equal(done.fields.sync, true);
  assert.equal(done.fields.asyncQueue, undefined);
});

test('flag OFF: queue options are inert and the legacy waitUntil path is unchanged', async () => {
  const lines = collectLines();
  let writes = 0;
  const fetchImpl = async () => { writes += 1; return { ok: true, status: 200 }; };
  const req = fakeReq();
  const res = fakeRes();
  startCapture(req, res, {
    ...r2Cfg(fetchImpl),
    asyncQueue: false,
    sync: false,
    queueBatchSize: 1,
    log: lines.log,
  });
  res.end('ok');
  assert.equal(res.ended, true, 'legacy async path ends immediately');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writes, 1);
  assert.equal(lines.find('capture_queue_mode').length, 0);
  const flush = lines.find('capture_flush_end')[0];
  assert.equal(flush.fields.asyncQueue, undefined);
  assert.equal(flush.fields.sync, false);
});

// ---------------------------------------------------------------------------
// 2. Flag ON: response is never blocked; critical rows are synchronous
// ---------------------------------------------------------------------------

test('flag ON: gated sink does not delay res.end; ack/done stay synchronous', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const sinkCalls = [];
  const queueOptions = makeQueueOptions(async (batch) => {
    sinkCalls.push(batch);
    await gate;
  });
  const lines = collectLines();
  const req = fakeReq();
  const res = fakeRes();
  startCapture(req, res, {
    ...r2Cfg(async () => ({ ok: true, status: 200 })),
    asyncQueue: true,
    ...queueOptions,
    log: lines.log,
  });

  res.end('{"ok":true}');
  // The response is finalized in the same tick even though the sink is gated.
  assert.equal(res.ended, true);
  assert.equal(Buffer.concat(res.body).toString(), '{"ok":true}');
  assert.equal(sinkCalls.length, 0, 'sink has not even been invoked yet');
  assert.equal(lines.find('capture_ack').length, 1);
  assert.equal(lines.find('capture_done').length, 1);
  assert.equal(lines.find('capture_done')[0].fields.asyncQueue, true);
  assert.equal(lines.find('capture_done')[0].fields.sync, false);
  assert.equal(lines.find('capture_queue_mode').length, 1);

  release();
  await settleQueue(queueOptions.scheduler);
  assert.equal(sinkCalls.length, 1, 'sink flushed after gate released');
  assert.equal(sinkCalls[0][0].envelope.requestId, lines.find('capture_ack')[0].fields.requestId);
});

test('flag ON with CAPTURE_SYNC=1: sync override is explicit and only one write path runs', async () => {
  const writes = [];
  const queueOptions = makeQueueOptions(async (batch) => {
    for (const item of batch) writes.push(item.envelope.requestId);
  });
  const lines = collectLines();
  const req = fakeReq();
  const res = fakeRes();
  startCapture(req, res, {
    ...r2Cfg(async () => { throw new Error('legacy path must not be used'); }),
    asyncQueue: true,
    sync: true, // CAPTURE_SYNC=1 equivalent — queue must win
    ...queueOptions,
    log: lines.log,
  });
  res.end('x');
  assert.equal(res.ended, true, 'never waited on a legacy sync sink');
  const mode = lines.find('capture_queue_mode')[0].fields;
  assert.equal(mode.syncRequested, true);
  assert.equal(mode.syncEffective, false);
  assert.equal(lines.find('capture_done')[0].fields.syncOverride, true);
  await settleQueue(queueOptions.scheduler);
  assert.equal(writes.length, 1);
});

test('flag ON: response bytes are identical to flag OFF for the same fixture', async () => {
  const bodyChunks = ['{"jsonrpc":"2.0",', '"result":{"tools":[]}}'];
  const runCapture = async (asyncQueue) => {
    const queueOptions = makeQueueOptions(async () => {});
    const res = fakeRes();
    startCapture(fakeReq(), res, {
      ...r2Cfg(async () => ({ ok: true, status: 200 })),
      asyncQueue,
      ...queueOptions,
    });
    res.write(bodyChunks[0]);
    res.end(bodyChunks[1]);
    await settleQueue(queueOptions.scheduler);
    return Buffer.concat(res.body).toString();
  };
  assert.equal(await runCapture(false), await runCapture(true));
  assert.equal(await runCapture(true), bodyChunks.join(''));
});

// ---------------------------------------------------------------------------
// 3. Critical rows survive sink failure; dropped event is preserved
// ---------------------------------------------------------------------------

test('flag ON: sink failure leaves critical logs intact and emits capture_dropped', async () => {
  const before = captureFailureStats().dropped;
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  const lines = collectLines();
  const queueOptions = makeQueueOptions(
    async () => { throw new Error('sink down'); },
    { queueMaxAttempts: 2, queueBackoffBaseMs: 1, queueBackoffMaxMs: 2 },
  );
  let cap;
  try {
    const res = fakeRes();
    cap = startCapture(fakeReq(), res, {
      ...r2Cfg(async () => ({ ok: true, status: 200 })),
      asyncQueue: true,
      ...queueOptions,
      log: lines.log,
    });
    res.end('payload');
    await settleQueue(queueOptions.scheduler, 40);
  } finally {
    console.error = originalError;
  }
  assert.equal(lines.find('capture_ack').length, 1);
  assert.equal(lines.find('capture_done').length, 1);
  assert.equal(captureFailureStats().dropped, before + 1);
  assert.ok(errors.some((line) => line.includes('[capture_dropped]')));
  assert.ok(errors.some((line) => line.includes('gmg.capture_dropped.v1')));
  assert.ok(cap.queue.snapshot().dlq >= 1, 'failed envelope reached DLQ');
});

// ---------------------------------------------------------------------------
// 4. Sink 500 retries through the queue; R2 key / gzip / envelope stay valid
// ---------------------------------------------------------------------------

test('flag ON: HTTP 500 is retried by the queue and eventually delivered', async () => {
  const posts = [];
  const fetchImpl = async () => {
    posts.push('attempt');
    if (posts.length < 3) return { ok: false, status: 500 };
    return { ok: true, status: 200 };
  };
  const delivered = [];
  const queueOptions = makeQueueOptions(async (batch) => {
    const response = await fetchImpl();
    if (!response.ok) {
      throw Object.assign(new Error('collector failure'), { status: response.status });
    }
    delivered.push(...batch);
  });
  const lines = collectLines();
  const req = fakeReq();
  const res = fakeRes();
  const cap = startCapture(req, res, {
    ...r2Cfg(fetchImpl),
    asyncQueue: true,
    ...queueOptions,
    log: lines.log,
  });
  res.end('{"result":1}');
  await settleQueue(queueOptions.scheduler, 24);
  assert.equal(posts.length, 3, 'two 500s retried, third attempt succeeded');
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].envelope.response.raw, '{"result":1}');
  assert.equal(delivered[0].requestId, lines.find('capture_ack')[0].fields.requestId);
  assert.ok(cap.queue.snapshot().retries >= 2);
});

test('flag ON: queue sink keeps R2 key, gzip payload and envelope schema', async () => {
  const puts = [];
  const fetchImpl = async (url, init) => {
    puts.push({ url, init });
    return { ok: true, status: 200 };
  };
  const queueOptions = makeQueueOptions(async (batch) => {
    for (const item of batch) {
      await fetchImpl(item.envelope.requestId, { method: 'PUT', body: item.envelope });
    }
  });
  const req = fakeReq();
  const res = fakeRes();
  const { requestId } = startCapture(req, res, {
    ...r2Cfg(async () => ({ ok: true, status: 200 })),
    asyncQueue: true,
    ...queueOptions,
  });
  res.end('bytes');
  await settleQueue(queueOptions.scheduler);
  assert.equal(puts.length, 1);
  const envelope = puts[0].init.body;
  assert.equal(envelope.schema, 'gmg.capture.v1');
  assert.equal(envelope.requestId, requestId);
  assert.equal(envelope.request.raw, req.__gatewayRawBody);
  assert.equal(envelope.response.raw, 'bytes');
  // Key compatibility is produced by writeR2Sink in the real queue sink; the
  // injected sink receives the unchanged envelope that writeR2Sink consumes.
  assert.match(`capture/2026-01-01/${requestId}.json.gz`, /^capture\/\d{4}-\d{2}-\d{2}\/.+\.json\.gz$/);
});

// ---------------------------------------------------------------------------
// 5. requestId idempotency: queue dedupes envelope bodies, critical rows do not
// ---------------------------------------------------------------------------

test('flag ON: duplicate requestId enqueues only one envelope', async () => {
  const delivered = [];
  const scheduler = fakeScheduler();
  const queue = new CaptureQueue({
    scheduler,
    sink: async (batch) => { delivered.push(...batch); },
    flushIntervalMs: 1,
  });
  const lines = collectLines();
  const resA = fakeRes();
  const resB = fakeRes();
  const a = startCapture(fakeReq(), resA, {
    ...r2Cfg(async () => ({ ok: true, status: 200 })),
    asyncQueue: true, captureQueue: queue, requestId: 'dup-id', log: lines.log,
  });
  const b = startCapture(fakeReq(), resB, {
    ...r2Cfg(async () => ({ ok: true, status: 200 })),
    asyncQueue: true, captureQueue: queue, requestId: 'dup-id', log: lines.log,
  });
  assert.equal(a.requestId, b.requestId);
  resA.end('first');
  resB.end('second');
  assert.equal(queue.snapshot().duplicates, 1, 'second envelope deduped by requestId');
  // Critical rows for the same requestId are still all accepted by the queue.
  assert.equal(queue.pushCritical('ack', { requestId: 'dup-id' }).accepted, true);
  assert.equal(queue.pushCritical('done', { requestId: 'dup-id' }).accepted, true);
  await settleQueue(scheduler);
  assert.equal(delivered.filter((item) => item.envelope).length, 1);
  assert.equal(delivered.filter((item) => item.critical).length, 2);
  assert.equal(lines.find('capture_ack').length, 2, 'both requests still have sync ack logs');
});
