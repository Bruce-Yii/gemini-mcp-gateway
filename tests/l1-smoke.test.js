import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SMOKE_SERVERS, DEFAULT_SMOKE_SIZE, evenPick, allocatePerServer,
  selectSmokeTasks, buildSmokeDocument,
} from '../explore/select-smoke.mjs';
import {
  ROOT, percentile, metricsFromExplore, fakeMetrics,
  compareWithBaseline, DEFAULT_THRESHOLDS, renderReport,
} from '../scripts/run-l1-smoke.mjs';

const readJson = (p) => JSON.parse(fs.readFileSync(path.resolve(ROOT, p), 'utf8'));
const G6 = readJson('explore/tasks-g6.json');
const SMOKE = readJson('explore/tasks-smoke.json');
const BASELINE = readJson('explore/baselines/l1-smoke.json');

/* ------------------- selection ------------------- */

test('L1 selection: 50 tasks, 10 per server, all 5 servers covered', () => {
  assert.equal(SMOKE.count, DEFAULT_SMOKE_SIZE);
  assert.equal(SMOKE.tasks.length, DEFAULT_SMOKE_SIZE);
  for (const server of SMOKE_SERVERS) {
    assert.equal(SMOKE.stats.byServer[server], 10, `expected 10 for ${server}`);
    assert.equal(SMOKE.tasks.filter((t) => t.server === server).length, 10);
  }
});

test('L1 selection: read / write / boundary all present with meaningful counts', () => {
  assert.ok(SMOKE.stats.byGroup.read >= 30, 'read stratum too small');
  assert.ok(SMOKE.stats.byGroup.write >= 5, 'write stratum too small');
  assert.ok(SMOKE.stats.byGroup.boundary >= 3, 'boundary stratum too small');
  const cat = SMOKE.stats.byCategory;
  assert.ok((cat.write ?? 0) >= 3, 'explicit write tasks missing');
  assert.ok((cat.boundary ?? 0) >= 3, 'explicit boundary tasks missing');
});

test('L1 selection: tasks are verbatim G6 objects, no hand-edited prompts', () => {
  const byId = new Map(G6.tasks.map((t) => [t.id, t]));
  assert.equal(SMOKE.tasks.length, new Set(SMOKE.tasks.map((t) => t.id)).size, 'duplicate ids');
  for (const t of SMOKE.tasks) {
    assert.deepEqual(t, byId.get(t.id), `task ${t.id} is not a verbatim copy from G6`);
  }
});

test('L1 selection: deterministic and reproducible via --check semantics', () => {
  const doc = buildSmokeDocument(G6);
  assert.equal(JSON.stringify(doc), JSON.stringify(SMOKE), 'committed file differs from deterministic selection');
  const again = selectSmokeTasks(G6.tasks);
  assert.deepEqual(again.tasks.map((t) => t.id), doc.tasks.map((t) => t.id));
});

test('L1 selection: evenPick and allocatePerServer edge cases', () => {
  assert.deepEqual(evenPick([1, 2, 3], 0), []);
  assert.deepEqual(evenPick([1, 2, 3], 10), [1, 2, 3]);
  assert.deepEqual(evenPick([0, 1, 2, 3, 4], 2), [0, 2]);
  const alloc = allocatePerServer(G6.tasks, 50);
  assert.equal([...alloc.values()].reduce((a, b) => a + b, 0), 50);
  const capped = allocatePerServer([{ server: 'github' }], 50);
  assert.equal(capped.get('github'), 1);
});

/* ------------------- metrics ------------------- */

test('L1 percentile: p95 is interpolated and robust to empty input', () => {
  assert.equal(percentile([], 95), 0);
  assert.equal(percentile([5], 95), 5);
  assert.equal(percentile([1, 2, 3, 4], 50), 2.5);
  assert.ok(percentile([10, 20, 30, 40, 50], 95) > 40);
});

test('L1 metricsFromExplore: uses anomaly-based completion proxy and gateway attribution', () => {
  const tasks = [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }];
  const perTask = [
    { task: 'A', searchHit: true, toolHit: true, wallMs: 100, totalTokens: 1000 },
    { task: 'B', searchHit: false, toolHit: false, wallMs: 200, totalTokens: 2000 },
    { task: 'C', searchHit: null, toolHit: null, wallMs: 300, totalTokens: 3000 },
    { task: 'D', searchHit: true, toolHit: true, wallMs: 400, totalTokens: 4000 },
  ];
  const anomalies = [
    { task: 'A', type: 'execute_error', attribution: 'gateway' },
    { task: 'B', type: 'max_turns_exceeded', attribution: 'model' },
    { task: 'B', type: 'retry', attribution: 'model' },
    { task: 'C', type: 'runner_error', attribution: 'harness' },
    { task: 'OTHER', type: 'execute_error', attribution: 'gateway' },
  ];
  const m = metricsFromExplore({ tasks, perTask, anomalies });
  assert.equal(m.tasks, 4);
  assert.equal(m.completed, 2, 'B and C are fatal, A and D completed');
  assert.equal(m.completionRate, 50);
  assert.equal(m.gatewayAnomalyCount, 1, 'anomaly for OTHER must be excluded');
  assert.equal(m.anomalyCount, 4);
  assert.equal(m.searchHitRate, 66.7, 'only A/B/D have searchHit measured');
  assert.equal(m.toolHitRate, 66.7);
  assert.equal(m.tokensPerTask, 2500);
  assert.ok(m.p95LatencyMs >= 385 && m.p95LatencyMs <= 400);
});

test('L1 fakeMetrics: deterministic wiring-check values, explicitly labelled', () => {
  const m = fakeMetrics([{ id: 'a' }, { id: 'b' }]);
  assert.equal(m.tasks, 2);
  assert.equal(m.completionRate, 100);
  assert.equal(m.gatewayAnomalyCount, 0);
  assert.match(m.source, /fake-dry-run/);
});

/* ------------------- baseline comparison ------------------- */

test('L1 compare: passes within tolerance, fails on regressions in each direction', () => {
  const baseline = { metrics: { completionRate: 80, gatewayAnomalyCount: 5, searchHitRate: 80, toolHitRate: 60, tokensPerTask: 15000, p95LatencyMs: 20000 } };
  const good = compareWithBaseline({
    completionRate: 75, gatewayAnomalyCount: 7, searchHitRate: 74,
    toolHitRate: 55, tokensPerTask: 17000, p95LatencyMs: 25000,
  }, baseline);
  assert.equal(good.ok, true, JSON.stringify(good.checks));

  const bad = compareWithBaseline({
    completionRate: 60, gatewayAnomalyCount: 12, searchHitRate: 50,
    toolHitRate: 30, tokensPerTask: 30000, p95LatencyMs: 60000,
  }, baseline);
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.checks.map((c) => c.metric).filter((m, i, a) => bad.checks[i].status === 'fail'), Object.keys(DEFAULT_THRESHOLDS));
});

test('L1 compare: missing baseline is skipped; missing current value fails', () => {
  const r = compareWithBaseline({ completionRate: null, searchHitRate: 80 }, { metrics: { completionRate: 80 } });
  assert.equal(r.ok, false);
  const by = new Map(r.checks.map((c) => [c.metric, c.status]));
  assert.equal(by.get('completionRate'), 'fail');
  assert.equal(by.get('searchHitRate'), 'skip');
});

test('L1 baseline file: real + fake sections and thresholds are well formed', () => {
  assert.equal(BASELINE.metrics.tasks, 50);
  assert.equal(BASELINE.fake.metrics.tasks, 50);
  assert.match(BASELINE.source, /G6/);
  assert.equal(Object.keys(BASELINE.thresholds).length, 6);
  for (const [key, rule] of Object.entries(BASELINE.thresholds)) {
    assert.ok(['min', 'max'].includes(rule.direction), `${key} direction`);
    assert.ok(rule.tolerance >= 0, `${key} tolerance`);
  }
});

/* ------------------- report ------------------- */

test('L1 report renderer: includes all required metrics and pass/fail status', () => {
  const result = {
    generatedAt: '2026-01-01T00:00:00.000Z', mode: 'fake-dry-run', ok: true,
    metrics: { tasks: 50, completionRate: 100, gatewayAnomalyCount: 0, searchHitRate: 100, toolHitRate: 100, tokensPerTask: 0, p95LatencyMs: 0, source: 'fake' },
    baseline: { source: 'fake baseline', metrics: { tasks: 50, completionRate: 100 } },
    comparison: { checks: [{ metric: 'completionRate', status: 'pass', direction: 'min', tolerance: 10, unit: '%' }] },
    notes: ['test note'],
  };
  const md = renderReport(result);
  for (const s of ['# L1 Smoke Report', 'PASS', 'Completion rate (%)', 'Gateway-attributed anomalies', 'searchHitRate (%)', 'toolHitRate (%)', 'Tokens / task', 'p95 latency (ms)', 'test note', 'fake baseline']) {
    assert.ok(md.includes(s), `report missing: ${s}`);
  }
});
