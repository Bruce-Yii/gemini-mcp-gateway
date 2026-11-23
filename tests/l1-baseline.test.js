import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ROOT, compareWithBaseline, deriveBaselineForServers,
  DEFAULT_THRESHOLDS, OVERALL_FALLBACK_LABEL, renderReport,
  DEFAULT_REAL_SERVERS, SKIPPED_SERVERS,
} from '../scripts/run-l1-smoke.mjs';

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

// The L1 pure helpers (metrics/compare/report/threshold logic) are public and
// stay tested in the clean export. Tests that pin the frozen G6 baseline or
// the 50-task smoke snapshot need private eval fixtures and skip explicitly.
const hasBaselineFixtures = fs.existsSync(path.join(ROOT, 'explore', 'baselines', 'l1-smoke.json'))
  && fs.existsSync(path.join(ROOT, 'explore', 'tasks-smoke.json'));
const baselineSkip = hasBaselineFixtures
  ? false
  : 'private eval fixtures explore/baselines/l1-smoke.json + explore/tasks-smoke.json are excluded from the OSS export (see docs/OPEN-SOURCE/EXPORT-TEST-CURATION.md)';
const fixtureTest = (name, fn) => test(name, { skip: baselineSkip }, fn);
const BASELINE_DOC = hasBaselineFixtures
  ? readJson(path.join(ROOT, 'explore/baselines/l1-smoke.json'))
  : null;
const SMOKE = hasBaselineFixtures
  ? readJson(path.join(ROOT, 'explore/tasks-smoke.json'))
  : null;
const FOUR_SERVER_TASKS = hasBaselineFixtures
  ? SMOKE.tasks.filter((t) => DEFAULT_REAL_SERVERS.includes(t.server))
  : [];

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l1-baseline-'));
  return {
    dir,
    write(name, value) {
      const file = path.join(dir, name);
      fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
      return file;
    },
    cleanup() { fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

/* ------------------------------------------------------------------ *
 * 1. Real regression must be detectable: current file != baseline file
 * ------------------------------------------------------------------ */

test('L1 baseline regression: fake current metrics vs separate baseline FAILS thresholds', () => {
  const t = tmpDir();
  try {
    // "current run" artifact — deliberately different from the baseline file.
    const currentFile = t.write('metrics-current.json', {
      runId: 'current-run-DEADBEEF',
      metrics: {
        tasks: 40,
        completionRate: 40,     // way below baseline 77.5 - 10
        gatewayAnomalyCount: 40, // way above baseline 18 + 3
        searchHitRate: 40,
        toolHitRate: 10,
        tokensPerTask: 80000,
        p95LatencyMs: 200000,
      },
    });
    // The independent baseline file — a separate file with separate numbers.
    const baselineFile = t.write('baseline.json', {
      source: 'frozen test baseline',
      metrics: {
        tasks: 40,
        completionRate: 90,
        gatewayAnomalyCount: 2,
        searchHitRate: 90,
        toolHitRate: 80,
        tokensPerTask: 10000,
        p95LatencyMs: 15000,
      },
    });
    const current = readJson(currentFile).metrics;
    const baseline = readJson(baselineFile);
    assert.notDeepEqual(current, baseline.metrics, 'current and baseline must be DIFFERENT files/values');
    const comparison = compareWithBaseline(current, baseline);
    assert.equal(comparison.ok, false, 'a real regression must fail, not silently pass');
    const failed = new Set(comparison.checks.filter((c) => c.status === 'fail').map((c) => c.metric));
    for (const key of Object.keys(DEFAULT_THRESHOLDS)) {
      assert.ok(failed.has(key), `${key} regression should be caught`);
    }
  } finally {
    t.cleanup();
  }
});

test('L1 baseline regression: self-comparison (baseline === current) would pass — the bug we prevent', () => {
  const t = tmpDir();
  try {
    // Demonstrates the original self-reference failure mode and why isolation matters.
    const file = t.write('run-metrics.json', {
      metrics: { tasks: 40, completionRate: 10, gatewayAnomalyCount: 99, p95LatencyMs: 500000 },
    });
    const same = readJson(file);
    const comparison = compareWithBaseline(same.metrics, same);
    assert.equal(comparison.ok, true, 'reading the current run as its own baseline always passes (bug)');
  } finally {
    t.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * 2. byServer selection (independent snapshot, not current run)
 * ------------------------------------------------------------------ */

fixtureTest('L1 baseline byServer: default 4-server real set selects exact 40-task snapshot', () => {
  assert.deepEqual(SKIPPED_SERVERS, ['figma']);
  assert.equal(FOUR_SERVER_TASKS.length, 40);
  const baseline = deriveBaselineForServers(FOUR_SERVER_TASKS, BASELINE_DOC);
  assert.equal(baseline.fallback, false);
  assert.equal(baseline.perServer, true);
  assert.equal(baseline.baselineSource, 'byServer');
  assert.equal(baseline.metrics.tasks, 40, 'must be a 40-task baseline, not the 50-task aggregate');
  assert.equal(baseline.metrics.completionRate, 77.5);
  assert.equal(baseline.metrics.gatewayAnomalyCount, 18);
  assert.match(baseline.source, /byServer snapshot/);
  assert.doesNotMatch(baseline.source, /explore\/results/, 'baseline must not point at current-run artifacts');
  // Validate the snapshot against the committed overall 50-task baseline: both
  // come from the same G6 run but are DIFFERENT datasets.
  assert.notEqual(baseline.metrics.tasks, BASELINE_DOC.metrics.tasks);
  assert.notEqual(baseline.metrics.completionRate, BASELINE_DOC.metrics.completionRate);
});

fixtureTest('L1 baseline byServer: subset without prepared snapshot aggregates from byServer', () => {
  const tasks = SMOKE.tasks.filter((t) => ['github', 'notion'].includes(t.server));
  const baseline = deriveBaselineForServers(tasks, BASELINE_DOC);
  assert.equal(baseline.fallback, false);
  assert.equal(baseline.perServer, true);
  assert.equal(baseline.metrics.tasks, 20);
  assert.equal(baseline.metrics.gatewayAnomalyCount, 1 + 3, 'counts are summed');
  assert.equal(baseline.metrics.completionRate, 75, 'rates weighted by task count');
  assert.match(baseline.source, /byServer aggregate/);
});

/* ------------------------------------------------------------------ *
 * 3. Missing byServer -> explicit overall fallback, never silent
 * ------------------------------------------------------------------ */

fixtureTest('L1 baseline fallback: missing byServer falls back to overall 50 with explicit label', () => {
  const overallOnly = {
    source: 'overall baseline from G6',
    capturedAt: '2026-11-22T17:50:59.641Z',
    metrics: { ...BASELINE_DOC.metrics },
    thresholds: BASELINE_DOC.thresholds,
  };
  const baseline = deriveBaselineForServers(FOUR_SERVER_TASKS, overallOnly);
  assert.equal(baseline.fallback, true);
  assert.equal(baseline.perServer, false);
  assert.equal(baseline.metrics.tasks, 50, 'fallback uses the full 50-task baseline');
  assert.match(baseline.source, new RegExp(OVERALL_FALLBACK_LABEL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(baseline.baselineSource, OVERALL_FALLBACK_LABEL);

  // The label must survive into the rendered report (no silent mislabelling).
  const md = renderReport({
    mode: 'real', ok: true,
    baseline: { source: baseline.source, fallback: true, perServer: false, metrics: baseline.metrics },
    metrics: { tasks: 40, source: 'real run' },
    comparison: { checks: [] },
  });
  assert.match(md, /Baseline scope: baseline-source: overall 50; not per-server/);
});

fixtureTest('L1 baseline fallback: incomplete byServer does NOT pretend to be per-server', () => {
  const partial = {
    ...BASELINE_DOC,
    byServer: { github: BASELINE_DOC.byServer.github }, // only 1 of 4 servers
    serverSets: {},
  };
  const baseline = deriveBaselineForServers(FOUR_SERVER_TASKS, partial);
  assert.equal(baseline.fallback, true);
  assert.equal(baseline.perServer, false);
  assert.equal(baseline.metrics.tasks, 50);
  assert.match(baseline.source, /not per-server/);
});

/* ------------------------------------------------------------------ *
 * 4. Current run file can never be read as baseline
 * ------------------------------------------------------------------ */

test('L1 baseline isolation: deriveBaselineForServers reads no current-run files', () => {
  const script = fs.readFileSync(path.join(ROOT, 'scripts/run-l1-smoke.mjs'), 'utf8');
  const start = script.indexOf('export function deriveBaselineForServers');
  assert.ok(start > 0, 'function not found');
  const end = script.indexOf('\nfunction runRealMode', start);
  const body = script.slice(start, end > 0 ? end : undefined)
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
  // The only file the selector may read is the frozen baseline file; it must
  // never touch explore/results/* (the current run output).
  assert.doesNotMatch(body, /metrics\.json|anomalies\.json|explore\/results|G6_METRICS|G6_ANOMALIES/,
    'baseline selector must not read explore/results/* (the current run output)');
  assert.doesNotMatch(body, /readFileSync/, 'baseline selector must use the frozen baseline loader only');
  // Also ensure the runtime script never uses a results-path constant as baseline.
  assert.doesNotMatch(script, /deriveBaselineForServers\([^)]*G6_/);
});

fixtureTest('L1 baseline isolation: poison current-run metrics cannot influence the baseline', () => {
  const t = tmpDir();
  try {
    // Even if a file named like the current run exists with absurd numbers,
    // deriveBaselineForServers only uses the passed-in frozen baseline doc.
    const poison = t.write('metrics.json', {
      runId: 'this-run',
      metrics: { tasks: 40, completionRate: 0, gatewayAnomalyCount: 999, p95LatencyMs: 999999 },
      byServer: {
        github: { tasks: 10, completionRate: 0, gatewayAnomalyCount: 999, p95LatencyMs: 999999 },
      },
    });
    const poisonDoc = readJson(poison);
    const baseline = deriveBaselineForServers(FOUR_SERVER_TASKS, BASELINE_DOC);
    assert.notDeepEqual(baseline.metrics, poisonDoc.metrics);
    assert.equal(baseline.metrics.completionRate, 77.5);
    assert.equal(baseline.metrics.gatewayAnomalyCount, 18);
    assert.equal(baseline.metrics.p95LatencyMs, 22709);

    // And a real regression against that frozen baseline is still detected.
    const current = { tasks: 40, completionRate: 50, gatewayAnomalyCount: 30, searchHitRate: 50, toolHitRate: 20, tokensPerTask: 30000, p95LatencyMs: 50000 };
    const comparison = compareWithBaseline(current, baseline);
    assert.equal(comparison.ok, false);
    assert.ok(comparison.checks.some((c) => c.metric === 'gatewayAnomalyCount' && c.status === 'fail'));
  } finally {
    t.cleanup();
  }
});

fixtureTest('L1 baseline file: byServer / serverSets sections are frozen and readable', () => {
  assert.equal(BASELINE_DOC.metrics.tasks, 50, 'original overall baseline preserved');
  for (const server of [...DEFAULT_REAL_SERVERS, ...SKIPPED_SERVERS]) {
    const row = BASELINE_DOC.byServer[server];
    assert.ok(row, `${server} byServer entry missing`);
    assert.equal(row.tasks, 10, `${server} should have 10 smoke tasks`);
    for (const key of Object.keys(DEFAULT_THRESHOLDS)) {
      assert.ok(row[key] !== undefined, `${server}.${key} missing`);
    }
  }
  assert.equal(BASELINE_DOC.serverSets['github,notion,linear,vercel'].tasks, 40);
  assert.match(BASELINE_DOC.runId, /^run-/);
  assert.match(BASELINE_DOC.computedFrom, /2026-11-22/);
});
