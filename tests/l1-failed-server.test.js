import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  ROOT, metricsFromExplore, fakeMetrics, compareWithBaseline,
  parseFailedServers, baselineScopeFor, evaluateL1Scope,
  deriveBaselineForServers, renderReport, parseArgs,
  DEFAULT_REAL_SERVERS, DENOMINATOR_FORMULA,
} from '../scripts/run-l1-smoke.mjs';

// The L1 helper logic (metric denominators, scope classification, comparison,
// report rendering, CLI parsing) is public and stays tested in the clean OSS
// export. Tests that pin the private 50-task smoke snapshot / frozen baseline
// need eval fixtures excluded from the export; they skip explicitly with a
// reason instead of crashing at module load time (see EXPORT-TEST-CURATION.md).
const readJson = (p) => JSON.parse(fs.readFileSync(path.resolve(ROOT, p), 'utf8'));
const hasFixtures = fs.existsSync(path.join(ROOT, 'explore', 'tasks-smoke.json'))
  && fs.existsSync(path.join(ROOT, 'explore', 'baselines', 'l1-smoke.json'));
const fixtureSkip = hasFixtures
  ? false
  : 'private eval fixtures explore/tasks-smoke.json + explore/baselines/l1-smoke.json are excluded from the OSS export (see docs/OPEN-SOURCE/EXPORT-TEST-CURATION.md)';
const fixtureTest = (name, fn) => test(name, { skip: fixtureSkip }, fn);
const SMOKE = hasFixtures ? readJson('explore/tasks-smoke.json') : null;
const BASELINE = hasFixtures ? readJson('explore/baselines/l1-smoke.json') : null;
const REAL_TASKS = hasFixtures
  ? SMOKE.tasks.filter((t) => DEFAULT_REAL_SERVERS.includes(t.server))
  : [];

/* ------------------------------------------------------------------ *
 * Fixtures: deterministic per-task rows + anomalies for a 40-task run
 * ------------------------------------------------------------------ */

/**
 * Build a synthetic real run. `hitByServer` maps server -> whether the
 * expected tool was found for ALL tasks on that server. `callByServer`
 * controls whether search was called at all ('called' | 'silent').
 */
function makeRun({ failedServers = [], hitByServer = {}, callByServer = {} } = {}) {
  const perTask = REAL_TASKS.map((t) => {
    const failed = failedServers.includes(t.server);
    const called = callByServer[t.server] !== 'silent';
    const hit = hitByServer[t.server] === true;
    return {
      task: t.id,
      server: t.server,
      expectedTool: t.tool,
      serverFailed: failed,
      searchHit: called ? hit : null,
      toolHit: called ? hit : null,
      wallMs: 1000,
      totalTokens: 1000,
    };
  });
  const anomalies = [];
  return { tasks: REAL_TASKS, perTask, anomalies };
}

function evaluateScopeFor({ failedServers, mode = 'real', run = makeRun({ failedServers }) }) {
  const scope = baselineScopeFor({ requestedServers: DEFAULT_REAL_SERVERS, failedServers });
  const metrics = run.metrics ?? metricsFromExplore({
    tasks: run.tasks, perTask: run.perTask, anomalies: run.anomalies, failedServers,
  });
  return {
    scope,
    metrics,
    ...evaluateL1Scope({
      isReal: true, mode, tasks: run.tasks, metrics,
      baselineDoc: BASELINE,
      failedServers,
      baselineScope: scope,
      skippedServers: ['figma'],
      notes: [],
    }),
  };
}

/* ------------------------------------------------------------------ *
 * 1. Failed-server input normalization & scope classification
 * ------------------------------------------------------------------ */

test('failed servers: explicit CLI + manifest are merged, deduped and sorted', () => {
  assert.deepEqual(parseFailedServers(), []);
  assert.deepEqual(parseFailedServers({ explicit: 'vercel, notion', manifest: { failedServers: ['notion'] } }), ['notion', 'vercel']);
  assert.deepEqual(parseFailedServers({ explicit: ['github'], manifest: {} }), ['github']);
  assert.deepEqual(parseFailedServers({ manifest: { serverToolCounts: { notion: 0 } } }), [],
    'tool counts are NOT an upstream-failure signal; only explicit failedServers is');
});

fixtureTest('failed servers: 4/4 connected -> full scope, no failed servers', () => {
  const scope = baselineScopeFor({ requestedServers: DEFAULT_REAL_SERVERS, failedServers: [] });
  assert.equal(scope, 'full');
  const r = evaluateScopeFor({ failedServers: [] });
  assert.equal(r.effectiveBaseline.fallback, false);
  assert.equal(r.effectiveBaseline.metrics.tasks, 40, 'full 40-task snapshot, not overall');
  assert.equal(r.effectiveBaseline.metrics.searchHitRate, 82.4);
  assert.equal(r.effectiveBaseline.metrics.toolHitRate, 53.3);
  assert.deepEqual(r.measuredTasks.map((t) => t.id), REAL_TASKS.map((t) => t.id));
  assert.equal(r.noMeasurement, false);
});

fixtureTest('failed servers: 2/4 connected -> degraded-subset baseline (github+linear only)', () => {
  const failedServers = ['notion', 'vercel'];
  const scope = baselineScopeFor({ requestedServers: DEFAULT_REAL_SERVERS, failedServers });
  assert.equal(scope, 'degraded-subset');
  const r = evaluateScopeFor({ failedServers });
  assert.equal(r.noMeasurement, false);
  assert.equal(r.measuredTasks.length, 20);
  assert.deepEqual([...new Set(r.measuredTasks.map((t) => t.server))].sort(), ['github', 'linear']);
  assert.equal(r.effectiveBaseline.fallback, false, 'byServer aggregate must be available for the subset');
  assert.equal(r.effectiveBaseline.perServer, true);
  assert.equal(r.effectiveBaseline.baselineScope, 'degraded-subset');
  assert.equal(r.effectiveBaseline.metrics.tasks, 20, '20-task degraded baseline, never the full 40');
  // Weighted from byServer: github(100/100) + linear(75/62.5) => 87.5 / 81.25.
  assert.equal(r.effectiveBaseline.metrics.searchHitRate, 87.5);
  assert.equal(r.effectiveBaseline.metrics.toolHitRate, 81.3);
  assert.match(r.effectiveBaseline.source, /byServer aggregate/);
  assert.doesNotMatch(r.effectiveBaseline.source, /explore\/results/, 'baseline must not be current-run output');
  assert.notEqual(r.effectiveBaseline.metrics.searchHitRate, 82.4, 'must NOT reuse the full 40-task baseline');
  assert.notEqual(r.effectiveBaseline.metrics.toolHitRate, 53.3);
});

fixtureTest('failed servers: 0/4 connected -> no-measurement infra result, no baseline comparison', () => {
  const failedServers = [...DEFAULT_REAL_SERVERS];
  const scope = baselineScopeFor({ requestedServers: DEFAULT_REAL_SERVERS, failedServers });
  assert.equal(scope, 'no-measured-tasks');
  const r = evaluateScopeFor({ failedServers });
  assert.equal(r.noMeasurement, true);
  assert.equal(r.ok, false, 'CI must fail on an unmeasurable real run');
  assert.equal(r.effectiveBaseline, null, 'no full/overall baseline may be used');
  assert.equal(r.comparison.ok, false);
  assert.deepEqual(r.comparison.checks, []);
  assert.equal(r.measuredTasks.length, 0);
  assert.match(r.metrics.source, /explore|run-explore/);
});

fixtureTest('failed servers: 1/4 connected -> degraded baseline of that single server', () => {
  const failedServers = ['notion', 'linear', 'vercel'];
  const r = evaluateScopeFor({ failedServers });
  assert.equal(r.scope, 'degraded-subset');
  assert.equal(r.measuredTasks.length, 10);
  assert.deepEqual([...new Set(r.measuredTasks.map((t) => t.server))], ['github']);
  assert.equal(r.effectiveBaseline.metrics.tasks, 10);
  assert.equal(r.effectiveBaseline.metrics.searchHitRate, 100);
  assert.equal(r.effectiveBaseline.metrics.toolHitRate, 100);
});

/* ------------------------------------------------------------------ *
 * 2. Denominator semantics
 * ------------------------------------------------------------------ */

fixtureTest('denominator: failed-server tasks are excluded from BOTH numerator and denominator', () => {
  const failedServers = ['notion', 'vercel'];
  const run = makeRun({
    failedServers,
    hitByServer: { github: true, linear: true, notion: true, vercel: true },
    callByServer: { github: 'called', linear: 'called', notion: 'called', vercel: 'silent' },
  });
  const m = metricsFromExplore({ tasks: run.tasks, perTask: run.perTask, failedServers });
  assert.equal(m.tasks, 20, 'only connected-server tasks are measured');
  assert.deepEqual(m.skippedByServer, { notion: 10, vercel: 10 });
  assert.deepEqual(m.failedServers, ['notion', 'vercel']);
  assert.equal(m.searchHitRate, 100, 'failed-server hits/misses never enter the rate');
  assert.equal(m.toolHitRate, 100);
  // The failed servers' null rows must NOT be counted as misses either.
  assert.equal(m.searchDenominator, 20, 'denominator is the 20 measurable tasks only');
  assert.equal(m.adjustedDenominator, 20);
});

fixtureTest('denominator: null (never called) is a MISS in the adjusted rate, excluded in the primary rate', () => {
  const run = makeRun({
    hitByServer: { github: true, linear: false, notion: true, vercel: true },
    callByServer: { github: 'called', linear: 'silent', notion: 'called', vercel: 'called' },
  });
  const m = metricsFromExplore({ tasks: run.tasks, perTask: run.perTask });
  assert.equal(m.searchDenominator, 30, 'legacy primary denominator excludes the 10 silent linear rows');
  assert.equal(m.searchHitRate, 100, '30 called rows: github+notion+vercel all hit');
  // Adjusted: 40 measurable rows, 30 hits, 10 silent => 75%.
  assert.equal(m.adjustedDenominator, 40);
  assert.equal(m.searchHitRateAdjusted, 75, 'null counted as miss per the documented formula');
  assert.equal(m.toolHitRateAdjusted, 75);
  assert.match(m.denominatorFormula, /null counted as miss/);
  assert.equal(DENOMINATOR_FORMULA, m.denominatorFormula);
});

fixtureTest('denominator: a failed server called by the model is never a gateway miss', () => {
  // 2/4 connected; the failed servers are the ONLY ones with hits in this
  // synthetic run — if they leaked into the denominator they would inflate it.
  const failedServers = ['notion', 'vercel'];
  const run = makeRun({
    failedServers,
    hitByServer: { github: false, linear: false, notion: true, vercel: true },
    callByServer: { github: 'called', linear: 'called', notion: 'called', vercel: 'called' },
  });
  const m = metricsFromExplore({ tasks: run.tasks, perTask: run.perTask, failedServers });
  assert.equal(m.searchHitRate, 0, 'all 20 measured tasks missed; failed-server hits are skipped, not counted');
  assert.equal(m.searchHitRateAdjusted, 0);
  assert.equal(m.searchDenominator, 20);
  assert.deepEqual(m.skippedByServer, { notion: 10, vercel: 10 });
});

test('denominator: report renders scope, failed servers, measured count and formula', () => {
  const md = renderReport({
    mode: 'real', ok: true,
    title: 'L1 Real Regression — 2026-11-23',
    baselineScope: 'degraded-subset',
    failedServers: ['notion', 'vercel'],
    skippedByServer: { notion: 10, vercel: 10 },
    taskCount: 20,
    measuredTasks: 20,
    metrics: {
      tasks: 20, completionRate: 80, gatewayAnomalyCount: 9, searchHitRate: 87.5,
      toolHitRate: 81.3, tokensPerTask: 14395, p95LatencyMs: 27296, source: 'run-explore.mjs',
      denominatorFormula: DENOMINATOR_FORMULA, searchDenominator: 18,
      toolDenominator: 17, adjustedDenominator: 20, searchHitRateAdjusted: 80,
      toolHitRateAdjusted: 75,
    },
    baseline: { source: 'byServer aggregate [github,linear]', metrics: { tasks: 20 }, baselineScope: 'degraded-subset' },
    comparison: { checks: [] },
  });
  for (const s of [
    'Comparison scope: `degraded-subset`',
    'Failed upstreams: `notion`, `vercel`',
    'Measured tasks: 20/20',
    '`notion`:10', '`vercel`:10',
    'Hit-rate denominator:', 'null counted as miss',
    'Denominators: search=18, tool=17, adjusted=20',
    'Baseline scope input: `degraded-subset`',
  ]) assert.ok(md.includes(s), `report missing: ${s}`);
});

/* ------------------------------------------------------------------ *
 * 3. CI still fails on a real regression (degraded subset included)
 * ------------------------------------------------------------------ */

fixtureTest('CI: real regression within the measured subset still fails the degraded comparison', () => {
  const failedServers = ['notion', 'vercel'];
  const scopeR = evaluateScopeFor({ failedServers });
  const baseline = scopeR.effectiveBaseline;
  const regressed = {
    tasks: 20,
    completionRate: 20, gatewayAnomalyCount: 40, searchHitRate: 10, toolHitRate: 5,
    tokensPerTask: 90000, p95LatencyMs: 999999,
  };
  const cmp = compareWithBaseline(regressed, baseline);
  assert.equal(cmp.ok, false, 'a genuine regression must exit 1 even in degraded mode');
  const failedMetrics = new Set(cmp.checks.filter((c) => c.status === 'fail').map((c) => c.metric));
  assert.ok(failedMetrics.has('searchHitRate'));
  assert.ok(failedMetrics.has('toolHitRate'));
  assert.ok(failedMetrics.has('gatewayAnomalyCount'));

  const r = evaluateL1Scope({
    isReal: true, mode: 'real', tasks: REAL_TASKS, metrics: regressed,
    baselineDoc: BASELINE, failedServers, baselineScope: 'degraded-subset',
    skippedServers: ['figma'], notes: [],
  });
  assert.equal(r.ok, false);
  assert.equal(r.effectiveBaseline.metrics.tasks, 20);
});

fixtureTest('CI: missing byServer snapshot for degraded subset -> explicit skip, never overall hard-compare', () => {
  const baselineWithoutServers = { ...BASELINE, byServer: {}, serverSets: {} };
  const r = evaluateL1Scope({
    isReal: true, mode: 'real', tasks: REAL_TASKS,
    metrics: { tasks: 20, completionRate: 99, gatewayAnomalyCount: 0, searchHitRate: 99, toolHitRate: 99, tokensPerTask: 1, p95LatencyMs: 1 },
    baselineDoc: baselineWithoutServers,
    failedServers: ['notion', 'vercel'], baselineScope: 'degraded-subset',
    skippedServers: ['figma'], notes: [],
  });
  assert.equal(r.effectiveBaseline, null, 'refuse to compare against the overall 50-task baseline');
  assert.equal(r.ok, false);
  assert.equal(r.comparison.checks.length, 0);
});

/* ------------------------------------------------------------------ *
 * 4. Legacy compatibility
 * ------------------------------------------------------------------ */

test('legacy: metricsFromExplore without failedServers preserves the old null-excluded rates', () => {
  const tasks = [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }];
  const perTask = [
    { task: 'A', expectedTool: 'x', searchHit: true, toolHit: true },
    { task: 'B', expectedTool: 'y', searchHit: false, toolHit: false },
    { task: 'C', expectedTool: 'z', searchHit: null, toolHit: null },
    { task: 'D', expectedTool: 'w', searchHit: true, toolHit: true },
  ];
  const m = metricsFromExplore({ tasks, perTask });
  assert.equal(m.searchHitRate, 66.7, 'legacy primary rate unchanged');
  assert.equal(m.toolHitRate, 66.7);
  assert.deepEqual(m.failedServers, []);
  assert.deepEqual(m.skippedByServer, {});
  assert.equal(m.searchDenominator, 3);
  // New diagnostics are additive, not breaking.
  assert.equal(m.searchHitRateAdjusted, 50);
});

fixtureTest('legacy: fake/replay paths and CLI parsing remain unchanged', () => {
  const f = fakeMetrics([{ id: 'a' }]);
  assert.equal(f.searchHitRate, 100);
  assert.equal(f.measuredTasks, 1);
  assert.equal(parseArgs([]).failedServers, null);
  assert.deepEqual(parseArgs(['--failed-servers', 'notion,vercel']).failedServers, ['notion', 'vercel']);
  assert.deepEqual(parseArgs(['--failed-servers=']).failedServers, null);
  // A replay run never scopes by failed servers, even if the old doc mentions them.
  const r = evaluateL1Scope({
    isReal: false, mode: 'replay', tasks: REAL_TASKS,
    metrics: { tasks: 40, completionRate: 77.5, gatewayAnomalyCount: 18, searchHitRate: 82.4, toolHitRate: 53.3, tokensPerTask: 16547, p95LatencyMs: 22709 },
    baselineDoc: BASELINE, failedServers: [], baselineScope: 'full', notes: [],
  });
  assert.equal(r.ok, true, 'replay compares to the top-level baseline as before');
  assert.equal(r.effectiveBaseline.metrics.tasks, 50, 'legacy replay uses the top-level 50-task baseline');
});

fixtureTest('legacy: full-scope real run with Figma skipped still picks the exact 40-task snapshot', () => {
  const r = evaluateL1Scope({
    isReal: true, mode: 'real', tasks: REAL_TASKS,
    metrics: { tasks: 40, completionRate: 77.5, gatewayAnomalyCount: 18, searchHitRate: 82.4, toolHitRate: 53.3, tokensPerTask: 16547, p95LatencyMs: 22709 },
    baselineDoc: BASELINE, failedServers: [], baselineScope: 'full',
    skippedServers: ['figma'], notes: [],
  });
  assert.equal(r.ok, true);
  assert.equal(r.effectiveBaseline.metrics.tasks, 40);
  assert.match(r.effectiveBaseline.source, /byServer snapshot/);
  assert.equal(r.effectiveBaseline.baselineScope, 'full');
});

fixtureTest('explore runner records failedServers explicitly in manifest and per-task rows (private explore/run-explore.mjs)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'explore/run-explore.mjs'), 'utf8');
  assert.match(src, /failedServers:\s*\[\], \/\/ filled from the first worker/);
  assert.match(src, /manifest\.failedServers = SHARED\.failedServers/);
  assert.match(src, /serverFailed:\s*\(failedServers \?\? \[\]\)\.includes\(task\.server\)/);
  assert.match(src, /failedServers: SHARED\.failedServers/);
  // Denominator fix lives only in the summary helper; no src/ changes here.
  assert.match(src, /never called\) is a MISS/);
});
