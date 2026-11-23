/**
 * G-13 regression tests — bounded end-to-end dedupe window in
 * `src/capture-queue.js`.
 *
 * Root cause: `seen` used to be a Set of every requestId ever observed, so a
 * long-lived process grew memory without bound. The fix turns `seen` into a
 * capacity-bound, TTL-aware LRU Map whose evictions never target a requestId
 * that is still queued / in-flight / retrying (so an eviction cannot cause an
 * immediate duplicate write).
 *
 * Determinism rules for this file:
 *   - fake scheduler only (`now`/`setTimeout`/`clearTimeout`/`sleep`), no wall
 *     clock, no real timers, no network;
 *   - synchronous fake sink (plain return value, not a promise) so every
 *     `await this.sink(...)` resolves on a fixed microtask boundary;
 *   - `tick()` advances exactly N microtask turns, never a variable number of
 *     setImmediate/setTimeout polls; no assertion depends on IO readiness.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CaptureQueue } from '../src/capture-queue.js';

/** Deterministic scheduler (same shape as tests/capture-queue.test.js). */
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
      this.flushDue();
      await Promise.resolve();
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
 * Run exactly `n` microtask turns. The queue's `_kickFlush` uses
 * `queueMicrotask` and `_deliverBatch` awaits `sink`; with a synchronous sink
 * every batch completes within a small, fixed number of turns. No IO, no
 * wall-clock wait, no variable-length polling.
 */
async function tick(n = 8) {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
}

function makeQueue(overrides = {}) {
  const scheduler = overrides.scheduler ?? fakeScheduler();
  const calls = [];
  const events = [];
  const queue = new CaptureQueue({
    scheduler,
    // Synchronous fake sink: no promise from user code, fully deterministic.
    sink: (batch) => { calls.push({ batch }); return { ok: true }; },
    onEvent: (e) => events.push(e),
    // Idle flush disabled by default so bookkeeping assertions are stable;
    // tests that need delivery call `scheduler.advance()` + `tick()`.
    flushIntervalMs: overrides.flushIntervalMs ?? 1e9,
    ...overrides,
  });
  return { queue, scheduler, calls, events };
}

function envelopes(n, prefix = 'r') {
  return Array.from({ length: n }, (_, i) => ({
    requestId: `${prefix}-${i}`,
    tag: 'envelope',
    envelope: { n: i },
  }));
}

// ---------------------------------------------------------------------------
// 1. Defaults are sane and observable
// ---------------------------------------------------------------------------

test('defaults: bounded cap (4096) and 24h TTL, exposed in snapshot', () => {
  const { queue } = makeQueue();
  const snap = queue.snapshot();
  assert.equal(snap.seenCap, 4096);
  assert.equal(snap.seenTtlMs, 24 * 60 * 60 * 1000);
  assert.equal(snap.seenSize, 0);
  queue.close();
});

test('cap and TTL are configurable; 0 disables the cap, idempotent:false disables dedupe', () => {
  const bounded = makeQueue({ seenMaxEntries: 2, seenTtlMs: 100 });
  assert.equal(bounded.queue.snapshot().seenCap, 2);
  assert.equal(bounded.queue.snapshot().seenTtlMs, 100);

  const unbounded = makeQueue({ seenMaxEntries: 0, seenTtlMs: 0 });
  assert.equal(unbounded.queue.snapshot().seenCap, 0);
  assert.equal(unbounded.queue.snapshot().seenTtlMs, 0);

  const off = makeQueue({ idempotent: false });
  for (let i = 0; i < 5; i += 1) off.queue.pushEnvelope(`x-${i}`, {});
  assert.equal(off.queue.snapshot().seenSize, 0, 'no dedupe bookkeeping when disabled');
  assert.equal(off.queue.snapshot().depth, 5);
  bounded.queue.close(); unbounded.queue.close(); off.queue.close();
});

// ---------------------------------------------------------------------------
// 2. Repeated requestId stays idempotent within the window
// ---------------------------------------------------------------------------

test('repeat requestId within window delivers exactly once (LRU touch keeps the shield)', async () => {
  const { queue, scheduler, calls } = makeQueue({ seenMaxEntries: 4, flushIntervalMs: 5 });
  assert.equal(queue.pushEnvelope('dup', { n: 1 }).accepted, true);
  // Touch a different id so 'dup' is not the most-recently-used entry.
  queue.pushEnvelope('other', {});
  const second = queue.pushEnvelope('dup', { n: 2 });
  assert.equal(second.accepted, false);
  assert.equal(second.reason, 'duplicate');
  assert.equal(queue.snapshot().duplicates, 1);
  scheduler.advance(5);
  await tick();
  const ids = calls.flatMap((c) => c.batch.map((e) => e.requestId));
  assert.deepEqual(ids, ['dup', 'other']);
  assert.equal(queue.snapshot().seenSize, 2);
  queue.close();
});

test('critical rows with same requestId remain distinct audit rows', () => {
  const { queue } = makeQueue({ seenMaxEntries: 1 });
  queue.pushEnvelope('same', {});
  assert.equal(queue.pushCritical('ack', { requestId: 'same' }).accepted, true);
  assert.equal(queue.pushCritical('done', { requestId: 'same' }).accepted, true);
  assert.equal(queue.snapshot().critical, 2);
  queue.close();
});

// ---------------------------------------------------------------------------
// 3. Eviction: capacity / TTL / never evict in-flight
// ---------------------------------------------------------------------------

test('capacity eviction: oldest settled id is evicted and a new id can be written', () => {
  const { queue, events } = makeQueue({ seenMaxEntries: 2 });
  queue.pushEnvelope('old-1', {});
  queue.pushEnvelope('old-2', {});
  // No flush happened, so all ids are still inFlight; capacity may temporarily
  // overshoot rather than drop a live shield.
  assert.equal(queue.snapshot().seenSize, 2);
  queue.pushEnvelope('new', {});
  assert.equal(queue.snapshot().seenSize, 3);
  assert.ok(events.some((e) => e.type === 'seen_overflow'), 'live ids are never evicted');

  // Simulate the first two being delivered: inFlight is released via _release.
  const e1 = queue.ring.find((e) => e.requestId === 'old-1');
  const e2 = queue.ring.find((e) => e.requestId === 'old-2');
  queue._release(e1);
  queue._release(e2);
  queue.pushEnvelope('new-2', {});
  assert.equal(queue.snapshot().seenSize, 2, 'settled ids evicted down to the cap');
  assert.ok(!queue.seen.has('old-1') && !queue.seen.has('old-2'));
  assert.equal(queue.snapshot().seenEvicted, 2);
  assert.ok(events.some((e) => e.type === 'seen_evicted' && e.reason === 'lru'));
  queue.close();
});

test('eviction does not permit an immediate duplicate while the original is still queued', () => {
  const { queue } = makeQueue({ seenMaxEntries: 1 });
  assert.equal(queue.pushEnvelope('live', {}).accepted, true);
  // Force many new ids; 'live' must keep its dedupe shield.
  for (let i = 0; i < 20; i += 1) queue.pushEnvelope(`filler-${i}`, {});
  assert.equal(queue.seen.has('live'), true, 'in-flight id survives eviction pressure');
  const dup = queue.pushEnvelope('live', {});
  assert.equal(dup.accepted, false);
  assert.equal(dup.reason, 'duplicate');
  queue.close();
});

test('TTL expiry removes a settled id; duplicate after expiry is a fresh write', () => {
  const { queue, scheduler } = makeQueue({ seenTtlMs: 100 });
  queue.pushEnvelope('ttl', {});
  const entry = queue.ring.find((e) => e.requestId === 'ttl');
  queue._release(entry); // pretend delivered; only the dedupe window remains
  scheduler.advance(99);
  assert.equal(queue.pushEnvelope('ttl', {}).reason, 'duplicate', 'inside TTL window');
  scheduler.advance(1); // now exactly 100ms since first registration
  assert.equal(queue.pushEnvelope('ttl', {}).accepted, true, 'expired id is writable again');
  assert.ok(queue.snapshot().seenEvicted >= 1);
  queue.close();
});

test('TTL never strips the shield from an in-flight id', () => {
  const { queue, scheduler } = makeQueue({ seenTtlMs: 10 });
  queue.pushEnvelope('inflight', {});
  scheduler.advance(1000);
  assert.equal(queue.seen.has('inflight'), true);
  assert.equal(queue.pushEnvelope('inflight', {}).reason, 'duplicate');
  queue.close();
});

// ---------------------------------------------------------------------------
// 4. Long burst: memory stays bounded; no duplicate deliveries
// ---------------------------------------------------------------------------

test('long burst keeps the settled dedupe window bounded and delivers without duplicates', async () => {
  const { queue, scheduler, calls } = makeQueue({
    seenMaxEntries: 8,
    batchSize: 64,
    flushIntervalMs: 5,
    maxItems: 8192, // no ring overflow — isolate the seen window
  });
  // Feed 5000 ids in 50 deterministic chunks. After each chunk, advance the
  // fake clock exactly 5ms (fires the idle timer) and run a fixed number of
  // microtask turns to let the sync sink drain the whole batch loop.
  for (let chunk = 0; chunk < 50; chunk += 1) {
    for (const env of envelopes(100, `c${chunk}-`)) queue.pushEnvelope(env.requestId, env.envelope);
    scheduler.advance(5);
    await tick(12);
  }
  assert.ok(queue.snapshot().seenEvicted > 0, 'settled ids were evicted');
  const delivered = calls.flatMap((c) => c.batch.map((e) => e.requestId));
  const unique = new Set(delivered);
  assert.equal(delivered.length, unique.size, 'no duplicate deliveries during the burst');
  assert.equal(delivered.length, 5000, 'all 5000 unique ids delivered exactly once');
  assert.equal(queue.snapshot().depth, 0, 'ring drained');
  // Eviction is insert-driven: after the final chunk, idle settled ids linger
  // until the next enqueue. Bound is (cap + last chunk size), never the total.
  assert.ok(
    queue.snapshot().seenSize <= 108,
    `window bounded after final drain: ${queue.snapshot().seenSize}`,
  );
  queue.pushEnvelope('trim', {});
  assert.ok(queue.snapshot().seenSize <= 9, 'next insert trims settled ids to the cap');
  queue.close();
});

test('unbounded mode (seenMaxEntries:0) keeps legacy behaviour for callers that opt in', () => {
  const { queue } = makeQueue({ seenMaxEntries: 0, seenTtlMs: 0 });
  for (const env of envelopes(500)) queue.pushEnvelope(env.requestId, env.envelope);
  assert.equal(queue.snapshot().seenSize, 500);
  assert.equal(queue.snapshot().seenEvicted, 0);
  queue.close();
});

// ---------------------------------------------------------------------------
// 5. close / drain still work with the bounded window
// ---------------------------------------------------------------------------

test('close stops enqueues; drain flushes remaining work and reports completion', async () => {
  const { queue, scheduler, calls } = makeQueue({
    seenMaxEntries: 4,
    flushIntervalMs: 5,
    batchSize: 8,
  });
  for (const env of envelopes(12)) queue.pushEnvelope(env.requestId, env.envelope);
  const drained = queue.drain({ timeoutMs: 1000 });
  for (let i = 0; i < 20; i += 1) { scheduler.advance(5); await tick(4); }
  assert.equal(await drained, true);
  assert.equal(calls.flatMap((c) => c.batch).length, 12);
  assert.equal(queue.snapshot().depth, 0);
  queue.close();
  assert.equal(queue.pushEnvelope('late', {}).reason, 'closed');
  assert.equal(queue.snapshot().closed, true);
});

test('window size is exposed as counts only in snapshot (no payload/token leakage)', () => {
  const { queue } = makeQueue();
  queue.pushEnvelope('secret-id', { authorization: 'Bearer SUPER_SECRET' });
  const snap = JSON.stringify(queue.snapshot());
  assert.ok(!snap.includes('SUPER_SECRET'));
  assert.ok(!snap.includes('secret-id'));
  assert.ok('seenSize' in JSON.parse(snap));
  queue.close();
});
