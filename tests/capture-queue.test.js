/**
 * Tests for the isolated async capture queue prototype (B15 D+C direction).
 *
 * These tests exercise only `src/capture-queue.js`. They do not touch the
 * production capture path. All timing is driven by a deterministic fake
 * scheduler so retry/backoff assertions do not depend on wall-clock sleeps.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CaptureQueue,
  createHttpSink,
  CRITICAL_TAGS,
} from '../src/capture-queue.js';

/** Deterministic scheduler: `advance(ms)` fires due timers in insertion order. */
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
    async sleep(ms) { // advance time so drain() cannot spin forever
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

function makeQueue(overrides = {}) {
  const scheduler = overrides.scheduler ?? fakeScheduler();
  const calls = [];
  const events = [];
  const drops = [];
  const dlq = [];
  const queue = new CaptureQueue({
    scheduler,
    sink: async (batch, meta) => { calls.push({ batch, meta }); },
    onEvent: (e) => events.push(e),
    onDrop: (item, reason) => drops.push({ item, reason }),
    onDlq: (item, meta) => { dlq.push({ item, meta }); },
    flushIntervalMs: 10,
    backoffBaseMs: 20,
    backoffMaxMs: 1000,
    ...overrides,
  });
  return { queue, scheduler, calls, events, drops, dlq };
}

function envelopes(n, prefix = 'r') {
  return Array.from({ length: n }, (_, i) => ({
    requestId: `${prefix}-${i}`,
    tag: 'envelope',
    envelope: { request: { raw: `body-${i}` }, events: [], response: {} },
  }));
}

// ---------------------------------------------------------------------------
// 1. API surface & critical tagging
// ---------------------------------------------------------------------------

test('CRITICAL_TAGS covers ack/done/dropped/meta and criticalTagOf recognises legacy tags', () => {
  assert.deepEqual([...CRITICAL_TAGS], ['ack', 'done', 'dropped', 'meta']);
  assert.equal(CaptureQueue.criticalTagOf({ tag: 'capture_ack' }), 'ack');
  assert.equal(CaptureQueue.criticalTagOf({ tag: 'capture_done.v1' }), 'done');
  assert.equal(CaptureQueue.criticalTagOf({ tag: 'capture_dropped' }), 'dropped');
  assert.equal(CaptureQueue.criticalTagOf({ tag: 'capture_meta' }), 'meta');
  assert.equal(CaptureQueue.criticalTagOf({ tag: 'envelope' }), null);
  assert.equal(CaptureQueue.criticalTagOf({ critical: true }), 'meta');
});

test('constructor rejects a missing sink', () => {
  assert.throws(() => new CaptureQueue({}), /requires a sink/);
});

test('enqueue returns lane info and never throws on sink failure', async () => {
  const { queue, scheduler } = makeQueue({
    sink: async () => { throw new Error('boom'); },
  });
  const r = queue.pushEnvelope('a', {});
  assert.deepEqual({ accepted: r.accepted, critical: r.critical }, { accepted: true, critical: false });
  const c = queue.pushCritical('ack', { requestId: 'a' });
  assert.equal(c.critical, true);
  scheduler.advance(50);
  await Promise.resolve();
  queue.close();
});

// ---------------------------------------------------------------------------
// 2. Batch flush / burst 200 / ordering
// ---------------------------------------------------------------------------

test('burst of 200 envelopes is batched, bounded, and all delivered', async () => {
  const { queue, scheduler, calls } = makeQueue({
    batchSize: 32,
    maxItems: 256,
    flushIntervalMs: 5,
  });
  for (const env of envelopes(200)) queue.pushEnvelope(env.requestId, env.envelope);
  assert.equal(queue.snapshot().depth, 200);
  scheduler.advance(5);
  for (let i = 0; i < 20; i += 1) { scheduler.flushDue(); await Promise.resolve(); }
  const delivered = calls.flatMap((c) => c.batch);
  assert.equal(delivered.length, 200);
  assert.equal(new Set(delivered.map((e) => e.requestId)).size, 200);
  assert.equal(queue.snapshot().depth, 0);
  assert.ok(calls.length >= 7, '200 / batchSize 32 needs at least 7 batches');
});

test('sink delay does not block enqueue (async flush)', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { queue, scheduler, calls } = makeQueue({
    sink: async (batch) => { calls.push({ batch }); await gate; },
  });
  const t0 = scheduler.now();
  queue.pushEnvelope('slow', {});
  // enqueue returns synchronously even though the sink has not settled.
  assert.equal(scheduler.now(), t0);
  assert.equal(calls.length, 0);
  scheduler.advance(10);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1, 'sink was invoked');
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(queue.snapshot().depth, 0);
});

test('ordering: batch preserves enqueue order by requestId', async () => {
  const { queue, scheduler, calls } = makeQueue({ batchSize: 64 });
  for (const id of ['z', 'a', 'm', 'b']) queue.pushEnvelope(id, { n: id });
  scheduler.advance(10);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls[0].batch.map((e) => e.requestId), ['z', 'a', 'm', 'b']);
});

// ---------------------------------------------------------------------------
// 3. Retry / backoff / 500 and 429 / abort
// ---------------------------------------------------------------------------

test('500 is retried with exponential backoff and eventually succeeds', async () => {
  const scheduler = fakeScheduler();
  const attempts = [];
  const { queue, events } = makeQueue({
    scheduler,
    maxAttempts: 4,
    sink: async (batch, meta) => {
      attempts.push(meta.attempt);
      if (attempts.length < 3) throw Object.assign(new Error('server'), { status: 500 });
    },
  });
  queue.pushEnvelope('flaky', {});
  scheduler.advance(10);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(attempts, [1]);
  assert.ok(events.some((e) => e.type === 'retry_scheduled' && e.delayMs === 20));
  scheduler.advance(20);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(attempts, [1, 2]);
  assert.ok(events.some((e) => e.type === 'retry_scheduled' && e.delayMs === 40));
  scheduler.advance(40);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(attempts, [1, 2, 3]);
  assert.equal(queue.snapshot().depth, 0);
  assert.equal(queue.snapshot().retries, 2);
});

test('429 retryable; 400 non-retryable goes straight to DLQ', async () => {
  for (const [status, expectDlq] of [[429, false], [400, true]]) {
    const scheduler = fakeScheduler();
    const attempts = [];
    const { queue, dlq } = makeQueue({
      scheduler,
      maxAttempts: 3,
      sink: async (_batch, meta) => {
        attempts.push(meta.attempt);
        throw Object.assign(new Error('rejected'), { status });
      },
    });
    queue.pushEnvelope(`s-${status}`, {});
    scheduler.advance(10);
    await new Promise((resolve) => setImmediate(resolve));
    if (expectDlq) {
      assert.deepEqual(attempts, [1]);
      assert.equal(dlq.length, 1);
      assert.equal(dlq[0].meta.status, status);
      assert.equal(queue.snapshot().dlq, 1);
    } else {
      assert.deepEqual(attempts, [1]);
      assert.equal(dlq.length, 0);
      scheduler.advance(20);
      await new Promise((resolve) => setImmediate(resolve));
      scheduler.advance(40);
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(attempts, [1, 2, 3]);
      assert.equal(dlq.length, 1, 'exhausted 429 lands in DLQ');
      assert.equal(dlq[0].meta.attempt, 3);
    }
  }
});

test('abort-style failure (rejected promise, no status) retries then DLQ', async () => {
  const scheduler = fakeScheduler();
  const { queue, dlq, events } = makeQueue({
    scheduler,
    maxAttempts: 2,
    sink: async () => { throw new Error('aborted'); },
  });
  queue.pushEnvelope('aborted', {});
  scheduler.advance(10);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.filter((e) => e.type === 'retry_scheduled').length, 1);
  scheduler.advance(20);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(dlq.length, 1);
  assert.equal(dlq[0].meta.reason, 'max_attempts');
  assert.equal(queue.snapshot().depth, 0);
});

// ---------------------------------------------------------------------------
// 4. Idempotency / duplicates / response-shape failure
// ---------------------------------------------------------------------------

test('same requestId enqueued three times delivers one copy', async () => {
  const { queue, scheduler, calls, events } = makeQueue();
  for (let i = 0; i < 3; i += 1) queue.pushEnvelope('dup-id', { n: i });
  assert.equal(queue.snapshot().depth, 1);
  assert.equal(queue.snapshot().duplicates, 2);
  scheduler.advance(10);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.flatMap((c) => c.batch).length, 1);
  assert.equal(events.filter((e) => e.type === 'duplicate').length, 2);
});

test('sink returning { ok:false, status:503 } is treated as retryable failure', async () => {
  const scheduler = fakeScheduler();
  let n = 0;
  const { queue } = makeQueue({
    scheduler,
    sink: async () => { n += 1; return n === 1 ? { ok: false, status: 503 } : { ok: true }; },
  });
  queue.pushEnvelope('shape', {});
  scheduler.advance(10);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(n, 1);
  scheduler.advance(20);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(n, 2);
  assert.equal(queue.snapshot().depth, 0);
});

// ---------------------------------------------------------------------------
// 5. Backpressure / P0 never dropped / critical priority
// ---------------------------------------------------------------------------

test('maxItems overflow drops oldest envelope, never a critical row', async () => {
  const { queue, drops, scheduler } = makeQueue({ maxItems: 3, flushIntervalMs: 1e9 });
  queue.pushCritical('ack', { requestId: 'p0' });
  queue.pushEnvelope('e1', {});
  queue.pushEnvelope('e2', {});
  queue.pushEnvelope('e3', {});
  queue.pushEnvelope('e4', {});
  assert.equal(queue.snapshot().depth, 3);
  assert.equal(drops.length, 2);
  assert.ok(drops.every((d) => d.reason === 'ring_overflow'));
  assert.equal(drops[0].item.requestId, 'e1', 'oldest droppable evicted first');
  assert.ok(queue.ring.some((e) => e.requestId === 'p0'), 'P0 survived overflow');
  assert.equal(queue.snapshot().criticalDepth, 1);
  queue.close();
  void scheduler;
});

test('maxBytes backpressure evicts oldest envelope while preserving critical', async () => {
  const { queue, drops } = makeQueue({ maxBytes: 60, maxItems: 100, flushIntervalMs: 1e9 });
  queue.pushCritical('meta', { requestId: 'p0', data: 'x' });
  queue.pushEnvelope('big1', { blob: 'a'.repeat(40) });
  queue.pushEnvelope('big2', { blob: 'b'.repeat(40) });
  assert.ok(queue.snapshot().bytes <= queue.maxBytes || queue.ring.every((e) => e.lane === 'critical'));
  assert.ok(drops.length >= 1);
  assert.ok(queue.ring.some((e) => e.requestId === 'p0'));
  queue.close();
});

test('critical rows are flushed before envelopes regardless of arrival order', async () => {
  const { queue, scheduler, calls } = makeQueue({ batchSize: 10, flushIntervalMs: 1e9 });
  queue.pushEnvelope('body-1', {});
  queue.pushCritical('done', { requestId: 'p0-done' });
  queue.pushCritical('ack', { requestId: 'p0-ack' });
  scheduler.advance(1); // critical present -> immediate kick
  await new Promise((resolve) => setImmediate(resolve));
  const first = calls[0]?.batch.map((e) => e.requestId ?? e.tag) ?? [];
  assert.ok(first.includes('p0-ack') && first.includes('p0-done'));
  assert.ok(!first.includes('body-1'), 'envelope not in the priority batch');
  scheduler.advance(10);
  await new Promise((resolve) => setImmediate(resolve));
  const all = calls.flatMap((c) => c.batch.map((e) => e.requestId ?? e.tag));
  assert.ok(all.includes('body-1'), 'envelope eventually delivered');
});

test('critical rows with a duplicate requestId are still accepted (audit rows are distinct)', () => {
  const { queue } = makeQueue();
  queue.pushEnvelope('same', {});
  const a = queue.pushCritical('ack', { requestId: 'same' });
  const b = queue.pushCritical('done', { requestId: 'same' });
  assert.equal(a.accepted, true);
  assert.equal(b.accepted, true);
  assert.equal(queue.snapshot().critical, 2);
  queue.close();
});

// ---------------------------------------------------------------------------
// 6. No token / body leakage through observability callbacks
// ---------------------------------------------------------------------------

test('observability event stream never contains body bytes, tokens or raw error text', async () => {
  // onDrop/onDlq callbacks intentionally receive the full item so the collector
  // can persist it; they are storage sinks, not logs. The onEvent stream is the
  // only observability surface and must stay body-free.
  const { queue, events, scheduler } = makeQueue({
    sink: async () => { throw Object.assign(new Error('secret-should-not-leak'), { status: 400 }); },
  });
  queue.pushEnvelope('secret-id', {
    authorization: 'Bearer SUPER_SECRET_TOKEN',
    raw: 'very-private-envelope-body',
  });
  scheduler.advance(10);
  await new Promise((resolve) => setImmediate(resolve));
  const serialised = JSON.stringify(events);
  assert.ok(!serialised.includes('SUPER_SECRET_TOKEN'));
  assert.ok(!serialised.includes('very-private-envelope-body'));
  assert.ok(!serialised.includes('secret-should-not-leak'), 'raw error text may carry secrets; events must not reuse it');
});

// ---------------------------------------------------------------------------
// 7. HTTP sink injectable fake + status checking + abort
// ---------------------------------------------------------------------------

test('createHttpSink checks response.ok and returns status on success', async () => {
  const seen = [];
  const sink = createHttpSink({
    url: 'http://collector.test/ingest',
    fetchImpl: async (url, init) => {
      seen.push({ url, init });
      return { ok: true, status: 202 };
    },
  });
  const result = await sink([{ requestId: 'x' }]);
  assert.deepEqual(result, { ok: true, status: 202 });
  assert.equal(seen[0].url, 'http://collector.test/ingest');
  assert.equal(seen[0].init.method, 'POST');
  const body = JSON.parse(seen[0].init.body);
  assert.equal(body.schema, 'gmg.capture_batch.v1');
});

test('createHttpSink marks 500 retryable and 400 non-retryable', async () => {
  for (const status of [500, 400]) {
    const sink = createHttpSink({
      url: 'http://collector.test/ingest',
      fetchImpl: async () => ({ ok: false, status }),
    });
    await assert.rejects(sink([]), (err) => err.status === status && err.retryable === (status === 500));
  }
});

test('createHttpSink abort on timeout surfaces as retryable failure', async () => {
  const sink = createHttpSink({
    url: 'http://collector.test/ingest',
    timeoutMs: 1,
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }),
  });
  await assert.rejects(sink([]), /aborted/);
});

// ---------------------------------------------------------------------------
// 8. close / drain / determinism
// ---------------------------------------------------------------------------

test('close stops accepting work; snapshot reports counts only', () => {
  const { queue } = makeQueue();
  queue.pushEnvelope('before', {});
  queue.close();
  assert.equal(queue.pushEnvelope('after', {}).reason, 'closed');
  const snap = queue.snapshot();
  assert.ok(!('payload' in snap) && !('body' in snap));
  assert.equal(typeof snap.enqueued, 'number');
});

test('determinism: identical inputs produce identical snapshot and event sequence', async () => {
  async function run() {
    const ctx = makeQueue({ batchSize: 4 });
    for (const env of envelopes(6)) ctx.queue.pushEnvelope(env.requestId, env.envelope);
    ctx.scheduler.advance(10);
    await new Promise((resolve) => setImmediate(resolve));
    return {
      snapshot: ctx.queue.snapshot(),
      calls: ctx.calls.map((c) => c.batch.map((e) => e.requestId)),
      events: ctx.events.map((e) => ({ type: e.type, requestId: e.requestId, lane: e.lane, size: e.size })),
    };
  }
  const a = await run();
  const b = await run();
  assert.deepEqual(b, a);
});

test('drain waits for retries and reports completion', async () => {
  const scheduler = fakeScheduler();
  let n = 0;
  const { queue, scheduler: _unused } = makeQueue({
    scheduler,
    sink: async () => { n += 1; if (n === 1) throw Object.assign(new Error('busy'), { status: 503 }); },
  });
  void _unused;
  queue.pushEnvelope('drain-me', {});
  const done = queue.drain({ timeoutMs: 1000 });
  scheduler.advance(10);
  scheduler.advance(20);
  assert.equal(await done, true);
  assert.equal(n, 2);
  assert.equal(queue.snapshot().depth, 0);
});
