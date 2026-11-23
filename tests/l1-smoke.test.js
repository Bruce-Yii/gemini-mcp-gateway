import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  ROOT, percentile, metricsFromExplore, fakeMetrics,
  compareWithBaseline, DEFAULT_THRESHOLDS, renderReport,
  parseArgs, resolveMode, selectTasksByServers, realReportPaths,
  evaluateConsecutiveAlerts, deriveBaselineForServers,
  DEFAULT_REAL_SERVERS, SKIPPED_SERVERS,
} from '../scripts/run-l1-smoke.mjs';

// Pure L1 helpers stay testable in the clean export. Tests that pin the
// private 50-task smoke snapshot / frozen baseline / owner-only workflow are
// skipped with an explicit reason. See docs/OPEN-SOURCE/EXPORT-TEST-CURATION.md.
const hasSmokeFixtures = fs.existsSync(path.resolve(ROOT, 'explore/select-smoke.mjs'))
  && fs.existsSync(path.resolve(ROOT, 'explore/tasks-g6.json'))
  && fs.existsSync(path.resolve(ROOT, 'explore/tasks-smoke.json'))
  && fs.existsSync(path.resolve(ROOT, 'explore/baselines/l1-smoke.json'));
const fixtureSkip = hasSmokeFixtures
  ? false
  : 'private eval fixtures (explore/select-smoke.mjs, tasks-g6.json, tasks-smoke.json, baselines/l1-smoke.json) are excluded from the OSS export (see docs/OPEN-SOURCE/EXPORT-TEST-CURATION.md)';
const hasWorkflow = fs.existsSync(path.resolve(ROOT, '.github/workflows/l1-smoke.yml'));
const workflowSkip = hasWorkflow
  ? false
  : 'owner-only workflow .github/workflows/l1-smoke.yml is excluded from the OSS export (see docs/OPEN-SOURCE/EXPORT-TEST-CURATION.md)';
const fixtureTest = (name, fn) => test(name, { skip: fixtureSkip }, fn);
const workflowTest = (name, fn) => test(name, { skip: workflowSkip }, fn);

const {
  SMOKE_SERVERS, DEFAULT_SMOKE_SIZE, evenPick, allocatePerServer,
  selectSmokeTasks, buildSmokeDocument,
} = hasSmokeFixtures ? await import('../explore/select-smoke.mjs') : {};

const readJson = (p) => JSON.parse(fs.readFileSync(path.resolve(ROOT, p), 'utf8'));
const G6 = hasSmokeFixtures ? readJson('explore/tasks-g6.json') : null;
const SMOKE = hasSmokeFixtures ? readJson('explore/tasks-smoke.json') : null;
const BASELINE = hasSmokeFixtures ? readJson('explore/baselines/l1-smoke.json') : null;

/* ------------------- selection ------------------- */

fixtureTest('L1 selection: 50 tasks, 10 per server, all 5 servers covered', () => {
  assert.equal(SMOKE.count, DEFAULT_SMOKE_SIZE);
  assert.equal(SMOKE.tasks.length, DEFAULT_SMOKE_SIZE);
  for (const server of SMOKE_SERVERS) {
    assert.equal(SMOKE.stats.byServer[server], 10, `expected 10 for ${server}`);
    assert.equal(SMOKE.tasks.filter((t) => t.server === server).length, 10);
  }
});

fixtureTest('L1 selection: read / write / boundary all present with meaningful counts', () => {
  assert.ok(SMOKE.stats.byGroup.read >= 30, 'read stratum too small');
  assert.ok(SMOKE.stats.byGroup.write >= 5, 'write stratum too small');
  assert.ok(SMOKE.stats.byGroup.boundary >= 3, 'boundary stratum too small');
  const cat = SMOKE.stats.byCategory;
  assert.ok((cat.write ?? 0) >= 3, 'explicit write tasks missing');
  assert.ok((cat.boundary ?? 0) >= 3, 'explicit boundary tasks missing');
});

fixtureTest('L1 selection: tasks are verbatim G6 objects, no hand-edited prompts', () => {
  const byId = new Map(G6.tasks.map((t) => [t.id, t]));
  assert.equal(SMOKE.tasks.length, new Set(SMOKE.tasks.map((t) => t.id)).size, 'duplicate ids');
  for (const t of SMOKE.tasks) {
    assert.deepEqual(t, byId.get(t.id), `task ${t.id} is not a verbatim copy from G6`);
  }
});

fixtureTest('L1 selection: deterministic and reproducible via --check semantics', () => {
  const doc = buildSmokeDocument(G6);
  assert.equal(JSON.stringify(doc), JSON.stringify(SMOKE), 'committed file differs from deterministic selection');
  const again = selectSmokeTasks(G6.tasks);
  assert.deepEqual(again.tasks.map((t) => t.id), doc.tasks.map((t) => t.id));
});

fixtureTest('L1 selection: evenPick and allocatePerServer edge cases', () => {
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

fixtureTest('L1 baseline file: real + fake sections and thresholds are well formed', () => {
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

/* ------------------- workflow static validation ------------------- */

workflowTest('L1 workflow: daily fake + weekly Monday real schedules and dispatch choices', () => {
  const wf = fs.readFileSync(path.resolve(ROOT, '.github/workflows/l1-smoke.yml'), 'utf8');
  const crons = [...wf.matchAll(/cron:\s*'([^']+)'/g)].map((m) => m[1]);
  assert.equal(crons.length, 2, `expected two schedules, got ${JSON.stringify(crons)}`);
  assert.ok(crons.some((c) => /^\d+ \d+ \* \* \*$/.test(c.trim())), 'daily fake cron missing');
  assert.ok(crons.some((c) => /^\d+ \d+ \* \* 1$/.test(c.trim())), 'weekly Monday real cron missing');
  assert.match(wf, /workflow_dispatch:/);
  assert.match(wf, /options:\s*\[fake, real\]/);
  assert.match(wf, /--mode fake/);
  assert.match(wf, /--mode real/);
  // Mode resolver must distinguish the weekly cron exactly.
  assert.match(wf, /\$CRON"\s*=\s*"0 18 \* \* 1"/);
});

workflowTest('L1 workflow: real injects free model key + 4 upstreams, never Figma', () => {
  const wf = fs.readFileSync(path.resolve(ROOT, '.github/workflows/l1-smoke.yml'), 'utf8');
  assert.match(wf, /EXPLORE_MODEL_KEY:\s*\$\{\{ secrets\.(?:OPENCODE_GO_API_KEY|ANALYZER_API_KEY) \}\}/);
  assert.ok(/secrets\.(?:GITHUB_TOKEN|GH_PAT)/.test(wf), 'missing upstream GitHub token secret');
  for (const secret of ['NOTION_TOKEN', 'LINEAR_TOKEN', 'VERCEL_TOKEN']) {
    assert.ok(wf.includes(`secrets.${secret}`), `missing upstream secret ${secret}`);
  }
  assert.match(wf, /--servers github,notion,linear,vercel/);
  assert.doesNotMatch(wf, /FIGMA_TOKEN/);
  assert.match(wf, /EXPLORE_SERVERS/);
});

workflowTest('L1 workflow: artifacts retained on failure with 30-day retention', () => {
  const wf = fs.readFileSync(path.resolve(ROOT, '.github/workflows/l1-smoke.yml'), 'utf8');
  assert.match(wf, /if:\s*\$\{\{ always\(\) \}\}/);
  assert.match(wf, /retention-days:\s*30/);
  assert.match(wf, /l1-real-\*\.md/);
  assert.match(wf, /l1-real-state\.json/);
  // No write/push: this workflow is reports-only.
  assert.doesNotMatch(wf, /git (commit|push)/);
});

/* ------------------- argument / mode resolution ------------------- */

test('L1 args: --mode/--input/--baseline/--date/--servers parse in both styles', () => {
  const defaults = parseArgs([]);
  assert.equal(defaults.mode, 'fake');
  assert.equal(defaults.input, undefined);
  assert.equal(defaults.servers, null);
  assert.equal(defaults.baseline, 'explore/baselines/l1-smoke.json');
  assert.match(defaults.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(parseArgs(['--mode=real']).mode, 'real');
  assert.equal(parseArgs(['--mode', 'replay', '--input', 'x.json']).input, 'x.json');
  assert.equal(parseArgs(['--date=2026-11-23']).date, '2026-11-23');
  assert.deepEqual(parseArgs(['--servers', 'github,notion']).servers, ['github', 'notion']);
  assert.deepEqual(parseArgs(['--servers=']).servers, null);
  assert.equal(parseArgs(['--baseline', 'custom.json']).baseline, 'custom.json');
});

test('L1 mode resolution: daily schedule fake, Monday schedule real, dispatch explicit', () => {
  assert.equal(resolveMode({ eventName: 'schedule', schedule: '0 18 * * *' }), 'fake');
  assert.equal(resolveMode({ eventName: 'schedule', schedule: '0 18 * * 1' }), 'real');
  assert.equal(resolveMode({ eventName: 'workflow_dispatch', dispatchMode: 'real' }), 'real');
  assert.equal(resolveMode({ eventName: 'workflow_dispatch', dispatchMode: 'fake' }), 'fake');
  assert.equal(resolveMode({ eventName: 'workflow_dispatch', dispatchMode: 'bogus' }), 'fake');
  assert.equal(resolveMode({}), 'fake');
});

fixtureTest('L1 real servers: Figma excluded by default, skips reported not failed', () => {
  assert.deepEqual(DEFAULT_REAL_SERVERS, ['github', 'notion', 'linear', 'vercel']);
  assert.deepEqual(SKIPPED_SERVERS, ['figma']);
  const { tasks, skippedServers } = selectTasksByServers(SMOKE.tasks, DEFAULT_REAL_SERVERS);
  assert.equal(tasks.length, 40, '4 servers x 10 tasks');
  assert.deepEqual(skippedServers, ['figma']);
  const all = selectTasksByServers(SMOKE.tasks, null);
  assert.equal(all.tasks.length, 50);
  assert.deepEqual(all.skippedServers, []);
});

test('L1 real report paths: dated, distinct per day, under docs/eval', () => {
  const a = realReportPaths('2026-11-23');
  const b = realReportPaths('2026-11-24');
  assert.match(a.md, /docs[\\/]eval[\\/]l1-real-2026-11-23\.md$/);
  assert.match(a.json, /docs[\\/]eval[\\/]l1-real-2026-11-23\.json$/);
  assert.notEqual(a.md, b.md);
  assert.throws(() => realReportPaths('not-a-date'), /bad date/);
});

const hasG6Results = fs.existsSync(path.resolve(ROOT, 'explore/results/metrics.json')) && fs.existsSync(path.resolve(ROOT, 'explore/results/anomalies.json'));
const derivedSkip = fixtureSkip || (hasG6Results
  ? false
  : 'private eval artifacts explore/results/metrics.json + anomalies.json are excluded from the OSS export (see docs/OPEN-SOURCE/EXPORT-TEST-CURATION.md)');
test('L1 real baseline: derived 40-task subset matches G6 filtered metrics', { skip: derivedSkip }, () => {
  const { tasks } = selectTasksByServers(SMOKE.tasks, DEFAULT_REAL_SERVERS);
  const baseline = deriveBaselineForServers(tasks);
  assert.equal(baseline.metrics.tasks, 40);
  assert.equal(baseline.metrics.measuredTasks, 40);
  assert.ok(baseline.metrics.completionRate > 0 && baseline.metrics.completionRate <= 100);
  assert.ok(baseline.metrics.searchHitRate > 0);
  assert.ok(baseline.metrics.p95LatencyMs > 0);
  assert.match(baseline.source, /Figma excluded/);
});

/* ------------------- free-model volatility / ALERT ------------------- */

test('L1 alert rule: ALERT only after two consecutive real failures', () => {
  const first = evaluateConsecutiveAlerts(null, { ok: false, date: '2026-11-23', runId: 'r1' });
  assert.equal(first.alert, false);
  assert.equal(first.state.consecutiveFailures, 1);
  const second = evaluateConsecutiveAlerts(first.state, { ok: false, date: '2026-11-24', runId: 'r2' });
  assert.equal(second.alert, true);
  assert.equal(second.state.consecutiveFailures, 2);
  assert.match(second.alertReason, /2 consecutive/);
  const recovered = evaluateConsecutiveAlerts(second.state, { ok: true, date: '2026-11-25', runId: 'r3' });
  assert.equal(recovered.alert, false);
  assert.equal(recovered.state.consecutiveFailures, 0);
});

test('L1 report renderer: real report surfaces skipped servers and ALERT', () => {
  const md = renderReport({
    title: 'L1 Real Regression — 2026-11-23', mode: 'real', trigger: 'schedule',
    ok: false, alert: true, alertReason: '2 consecutive real-mode failures',
    skippedServers: ['figma'],
    metrics: { tasks: 40, completionRate: 60, gatewayAnomalyCount: 25, searchHitRate: 70, toolHitRate: 40, tokensPerTask: 16000, p95LatencyMs: 30000, source: 'real' },
    baseline: { source: 'G6 filtered', metrics: { completionRate: 77.5 } },
    comparison: { checks: [] },
  });
  assert.match(md, /# L1 Real Regression/);
  assert.match(md, /FAIL/);
  assert.match(md, /\*\*ALERT\*\*/);
  assert.match(md, /Skipped servers: `figma`/);
  assert.match(md, /2 consecutive real-mode failures/);
});

/* ------------------- fake stays runnable end-to-end ------------------- */

fixtureTest('L1 fake mode still runs offline and exits 0 with PASS report', () => {
  const mdPath = path.resolve(ROOT, 'docs/eval/l1-smoke-report.md');
  const jsonPath = path.resolve(ROOT, 'docs/eval/l1-smoke.json');
  // Preserve the committed artifacts: the runner regenerates them by design.
  const mdBefore = fs.readFileSync(mdPath, 'utf8');
  const jsonBefore = fs.readFileSync(jsonPath, 'utf8');
  try {
    const res = spawnSync(process.execPath, [path.resolve(ROOT, 'scripts/run-l1-smoke.mjs'), '--mode', 'fake'], {
      cwd: ROOT, encoding: 'utf8', env: { ...process.env, GITHUB_EVENT_NAME: 'schedule' },
    });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /fake-dry-run: PASS/);
    const doc = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    assert.equal(doc.mode, 'fake-dry-run');
    assert.equal(doc.ok, true);
    assert.equal(doc.metrics.tasks, 50);
    assert.deepEqual(doc.skippedServers, []);
    assert.match(fs.readFileSync(mdPath, 'utf8'), /fake-dry-run/);
  } finally {
    fs.writeFileSync(mdPath, mdBefore);
    fs.writeFileSync(jsonPath, jsonBefore);
  }
});
