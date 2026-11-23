/**
 * tests/harness-parallel.test.js — R8 worker-pool contract tests.
 *
 * Pure-local: mock tasks + injected sleeps only. No model call, no upstream
 * connection, no execution of run-explore.mjs, no model quota touched.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// explore/trace.mjs is a private eval fixture and is excluded from the OSS
// export. Skip explicitly (with a reason) when it is absent; the private repo
// still loads the real module and runs every assertion unchanged.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hasPrivateTrace = existsSync(path.join(ROOT, 'explore', 'trace.mjs'));
const skipReason = hasPrivateTrace
  ? false
  : 'private eval fixture explore/trace.mjs is excluded from the OSS export (see docs/OPEN-SOURCE/EXPORT-TEST-CURATION.md)';
const {
  DEFAULT_CONCURRENCY, MAX_CONCURRENCY, readConcurrency,
  safeTaskKey, taskArtifactPath,
  AnomalyCollector, DETECTOR_VERSION, mergeCollectors,
  runWorkerPool, withRetries, llmBackoffDelayMs, LLM_MAX_RETRIES,
} = hasPrivateTrace ? await import('../explore/trace.mjs') : {};

const t = (name, fn) => test(name, { skip: skipReason }, fn);

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * Config — concurrency is configurable but bounded
 * ------------------------------------------------------------------ */
t('readConcurrency: default 3, numeric strings, clamped to [1, max]', () => {
  assert.equal(DEFAULT_CONCURRENCY, 3);
  assert.equal(readConcurrency(), 3);
  assert.equal(readConcurrency(undefined), 3);
  assert.equal(readConcurrency('4'), 4);
  assert.equal(readConcurrency(0), 3);
  assert.equal(readConcurrency(-2), 3);
  assert.equal(readConcurrency('not-a-number'), 3);
  assert.equal(readConcurrency(2.9), 2);
  assert.equal(readConcurrency(999), MAX_CONCURRENCY);
});

/* ------------------------------------------------------------------ *
 * Worker pool scheduling
 * ------------------------------------------------------------------ */
t('runWorkerPool: never exceeds concurrency, visits each task once, keeps order', async () => {
  const tasks = Array.from({ length: 12 }, (_, i) => ({ id: `T${i}` }));
  let active = 0, maxActive = 0;
  const seen = [];
  const { results } = await runWorkerPool(tasks, {
    concurrency: 3,
    worker: async (t) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await tick(2);
      seen.push(t.id);
      active -= 1;
      return `${t.id}:ok`;
    },
  });
  assert.equal(maxActive, 3, 'peak parallelism == configured concurrency');
  assert.equal(seen.length, 12);
  assert.deepEqual([...seen].sort(), tasks.map((t) => t.id).sort(), 'each task exactly once');
  assert.deepEqual(results, tasks.map((t) => `${t.id}:ok`), 'results aligned to input order');
});

t('runWorkerPool: each worker owns one independent context used serially', async () => {
  const tasks = Array.from({ length: 9 }, (_, i) => ({ id: `T${i}` }));
  let seq = 0, overlap = false;
  const inFlight = new Map();
  const owner = new Map();
  const { contexts } = await runWorkerPool(tasks, {
    concurrency: 3,
    initWorker: () => ({ id: ++seq }),
    worker: async (t, ctx) => {
      const n = inFlight.get(ctx.id) ?? 0;
      if (n > 0) overlap = true;
      inFlight.set(ctx.id, n + 1);
      await tick(1);
      inFlight.set(ctx.id, n);
      owner.set(t.id, ctx.id);
      return t.id;
    },
  });
  assert.equal(contexts.length, 3);
  assert.equal(overlap, false, 'a context (its mgr) is never used concurrently');
  assert.equal(new Set(owner.values()).size, 3, 'all three workers actually ran tasks');
});

t('runWorkerPool: onReady runs before dispatch, onWorkerDone always runs', async () => {
  const events = [];
  await assert.rejects(() => runWorkerPool([{ id: 'X' }, { id: 'Y' }], {
    concurrency: 2,
    initWorker: (i) => { events.push(`init${i}`); return { id: i }; },
    onReady: (ctxs) => { events.push(`ready:${ctxs.length}`); },
    worker: async () => { events.push('work'); throw new Error('boom'); },
    onWorkerDone: (ctx) => { events.push(`done${ctx.id}`); },
  }), /boom/);
  assert.deepEqual(events.slice(0, 3), ['init0', 'init1', 'ready:2']);
  assert.ok(events.includes('done0') && events.includes('done1'), 'contexts closed even on task error');
});

t('runWorkerPool: a failed init closes already-created contexts', async () => {
  const closed = [];
  await assert.rejects(() => runWorkerPool([1, 2], {
    concurrency: 5,
    initWorker: (i) => { if (i === 1) throw new Error('init fail'); return { id: i }; },
    onWorkerDone: (ctx) => closed.push(ctx.id),
  }), /init fail/);
  assert.ok(closed.includes(0), 'worker 0 connection closed after worker 1 init failure');
});

t('runWorkerPool: never allocates more contexts than tasks', async () => {
  const { contexts, results } = await runWorkerPool([{ id: 'only' }], {
    concurrency: 5,
    initWorker: (i) => ({ id: i }),
  });
  assert.equal(contexts.length, 1);
  assert.deepEqual(results, [{ id: 'only' }]);
});

/* ------------------------------------------------------------------ *
 * Collector merge — workers collect locally, main thread merges
 * ------------------------------------------------------------------ */
t('mergeCollectors: concatenates items and sums dedupCount across workers', () => {
  const c1 = new AnomalyCollector(DETECTOR_VERSION);
  const c2 = new AnomalyCollector(DETECTOR_VERSION);
  const t1 = { id: 'T1', server: 'github', category: 'official', prompt: 'p' };
  const t2 = { id: 'T2', server: 'linear', category: 'official', prompt: 'p' };
  c1.flag(t1, 'search_empty', 'x');
  c1.flag(t1, 'search_empty', 'x'); // duplicate within worker 1
  c2.flag(t2, 'no_tool_call', 'y');
  const j = mergeCollectors([c1, c2]).toJSON();
  assert.equal(j.anomalies.length, 2);
  assert.equal(j.dedupCount, 1, 'within-worker dedup preserved');
  assert.equal(j.rawCount, 3, 'occurrences summed');
  assert.deepEqual(j.anomalies.map((a) => a.task).sort(), ['T1', 'T2']);
});

t('mergeCollectors: worker collectors stay independent until merge', () => {
  const c1 = new AnomalyCollector(DETECTOR_VERSION);
  const c2 = new AnomalyCollector(DETECTOR_VERSION);
  const task = { id: 'T', server: 'github', category: 'official', prompt: 'p' };
  c1.flag(task, 'search_empty', 'a');
  assert.equal(c2.items.length, 0, 'flag on one worker never touches another');
  c2.flag(task, 'search_empty', 'b');
  assert.equal(mergeCollectors([c1, c2]).toJSON().anomalies.length, 2);
});

/* ------------------------------------------------------------------ *
 * Task-scoped artifact files — no cross-worker overwrite
 * ------------------------------------------------------------------ */
t('taskArtifactPath: distinct taskIds -> distinct files; same id -> same file', () => {
  assert.notEqual(taskArtifactPath('T1', 'trace'), taskArtifactPath('T2', 'trace'));
  assert.equal(taskArtifactPath('T1', 'trace'), taskArtifactPath('T1', 'trace'));
  assert.notEqual(taskArtifactPath('T1', 'trace'), taskArtifactPath('T1', 'anomalies'),
    'trace and anomaly files for one task never collide');
  assert.equal(safeTaskKey('a/b:c'), 'a_b_c');
  assert.equal(safeTaskKey(''), 'unnamed');
});

/* ------------------------------------------------------------------ *
 * LLM 429 backoff — injectable sleep, no network
 * ------------------------------------------------------------------ */
t('llmBackoffDelayMs: waits 2^n seconds (1s, 2s, 4s)', () => {
  assert.equal(llmBackoffDelayMs(0), 1000);
  assert.equal(llmBackoffDelayMs(1), 2000);
  assert.equal(llmBackoffDelayMs(2), 4000);
  assert.equal(llmBackoffDelayMs(-5), 1000);
});

t('withRetries: 429 retried 3 times with 1/2/4s backoff, then succeeds', async () => {
  const delays = [];
  let calls = 0;
  const rateLimit = Object.assign(new Error('LLM 429: rate limit'), { status: 429, retryable: true });
  const value = await withRetries(async () => {
    calls += 1;
    if (calls <= 3) throw rateLimit;
    return 'ok';
  }, {
    shouldRetry: (e) => e?.retryable === true,
    sleep: async (ms) => { delays.push(ms); },
  });
  assert.equal(value, 'ok');
  assert.equal(calls, LLM_MAX_RETRIES + 1, 'initial call + 3 retries');
  assert.deepEqual(delays, [1000, 2000, 4000]);
});

t('withRetries: gives up after max retries and rethrows the last error', async () => {
  let calls = 0;
  const err = Object.assign(new Error('LLM 503'), { retryable: true });
  await assert.rejects(() => withRetries(async () => { calls += 1; throw err; }, {
    shouldRetry: (e) => e.retryable === true,
    sleep: async () => {},
  }), /LLM 503/);
  assert.equal(calls, LLM_MAX_RETRIES + 1);
});

t('withRetries: non-retryable errors fail immediately (no sleep)', async () => {
  let calls = 0;
  const err = Object.assign(new Error('LLM 400 bad request'), { retryable: false });
  await assert.rejects(() => withRetries(async () => { calls += 1; throw err; }, {
    shouldRetry: (e) => e.retryable === true,
    sleep: async () => { throw new Error('sleep must not be called'); },
  }), /LLM 400/);
  assert.equal(calls, 1);
});

/* ------------------------------------------------------------------ *
 * Mock end-to-end flow mirroring the runner (still no I/O / no model)
 * ------------------------------------------------------------------ */
t('mock flow: 7 tasks across 3 workers -> one anomaly per task after merge', async () => {
  const tasks = Array.from({ length: 7 }, (_, i) => ({
    id: `F${100 + i}`, server: 'github', category: 'official', prompt: `prompt ${i}`,
  }));
  const { results, contexts } = await runWorkerPool(tasks, {
    concurrency: 3,
    initWorker: () => ({ collector: new AnomalyCollector(DETECTOR_VERSION) }),
    onReady: (ctxs) => { assert.ok(ctxs.length >= 1); },
    worker: async (task, ctx) => {
      ctx.collector.flag(task, 'search_empty', task.prompt, { traceId: `run:${task.id}` });
      await tick(1);
      return { taskId: task.id, anomalyCount: 1 };
    },
    onWorkerDone: async () => {},
  });
  const merged = mergeCollectors(contexts.map((c) => c.collector)).toJSON();
  assert.equal(results.length, 7);
  assert.equal(merged.anomalies.length, 7);
  assert.equal(new Set(merged.anomalies.map((a) => a.task)).size, 7,
    'exactly one anomaly per distinct taskId');
});
