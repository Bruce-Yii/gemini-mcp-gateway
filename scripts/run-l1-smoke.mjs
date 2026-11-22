#!/usr/bin/env node
/**
 * scripts/run-l1-smoke.mjs — L1 smoke regression runner.
 *
 * Modes:
 *   --mode fake                deterministic, offline, NO credentials (default)
 *   --mode real                runs explore/run-explore.mjs with EXPLORE_SUITE=smoke
 *                              (needs free model key + upstream tokens), then
 *                              converts its artifacts into L1 metrics.
 *   --mode replay --input FILE reuse an existing explore/results/anomalies.json
 *                              (+ sibling metrics.json) offline.
 *
 * Outputs:
 *   docs/eval/l1-smoke.md       human-readable report (always regenerated)
 *   docs/eval/l1-smoke.json     machine-readable result (always regenerated)
 *
 * Exit code: 0 = within thresholds, 1 = regression vs baseline, 2 = bad input.
 *
 * Nothing here talks to a real upstream in fake/replay mode. Real results are
 * never fabricated: fake mode is explicitly labelled `mode: "fake-dry-run"`
 * and its numbers are NOT used to validate gateway behaviour, only the wiring.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');
const SMOKE_TASKS = path.join(ROOT, 'explore/tasks-smoke.json');
const BASELINE_FILE = path.join(ROOT, 'explore/baselines/l1-smoke.json');
const REPORT_MD = path.join(ROOT, 'docs/eval/l1-smoke.md');
const REPORT_JSON = path.join(ROOT, 'docs/eval/l1-smoke.json');

/* ------------------------------------------------------------------ *
 * Pure helpers (unit-tested in tests/l1-smoke.test.js)
 * ------------------------------------------------------------------ */

/** Percentile (linear interpolation between closest ranks). */
export function percentile(values, p) {
  const xs = (values ?? []).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!xs.length) return 0;
  if (xs.length === 1) return xs[0];
  const rank = (p / 100) * (xs.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return lo === hi ? xs[lo] : xs[lo] + (xs[hi] - xs[lo]) * (rank - lo);
}

const round1 = (x) => Math.round(x * 10) / 10;
const rate = (hit, total) => (total > 0 ? round1((hit / total) * 100) : null);

/**
 * "Completed" = runner did not record a fatal/harness failure and the model
 * produced a final answer within the turn budget. The G6 `finished` boolean is
 * true only when the last LLM turn had NO tool call, which is a harness
 * artifact (most tasks end on a tool-result turn), so we deliberately use an
 * anomaly-based proxy instead. See docs/eval/L1-SMOKE.md.
 */
const FATAL_TYPES = new Set(['runner_error', 'max_turns_exceeded']);

/** Convert explore runner artifacts into L1 metrics. */
export function metricsFromExplore({ tasks, perTask = [], anomalies = [], source = 'explore' }) {
  const ids = tasks.map((t) => t.id);
  const idSet = new Set(ids);
  const rows = perTask.filter((r) => idSet.has(r.task));
  const relevant = anomalies.filter((a) => idSet.has(a.task));
  const fatalTasks = new Set(relevant.filter((a) => FATAL_TYPES.has(a.type)).map((a) => a.task));
  const gatewayAnomalies = relevant.filter((a) => a.attribution === 'gateway').length;
  const searchRows = rows.filter((r) => r.searchHit !== null && r.searchHit !== undefined);
  const toolRows = rows.filter((r) => r.toolHit !== null && r.toolHit !== undefined);
  const latencies = rows.map((r) => r.wallMs ?? 0);
  const tokens = rows.reduce((s, r) => s + (r.totalTokens ?? 0), 0);

  return {
    tasks: ids.length,
    measuredTasks: rows.length,
    completed: Math.max(0, ids.length - fatalTasks.size),
    completionRate: rate(Math.max(0, ids.length - fatalTasks.size), ids.length),
    gatewayAnomalyCount: gatewayAnomalies,
    anomalyCount: relevant.length,
    searchHitRate: rate(searchRows.filter((r) => r.searchHit === true).length, searchRows.length),
    toolHitRate: rate(toolRows.filter((r) => r.toolHit === true).length, toolRows.length),
    tokensPerTask: rows.length ? Math.round(tokens / rows.length) : 0,
    p95LatencyMs: Math.round(percentile(latencies, 95)),
    source,
  };
}

/**
 * Deterministic offline simulation. This exercises the whole L1 pipeline
 * (selection -> metrics -> compare -> report) with zero network/credentials.
 * It is a wiring check, not a model/gateway quality measurement.
 */
export function fakeMetrics(tasks) {
  return {
    tasks: tasks.length,
    measuredTasks: tasks.length,
    completed: tasks.length,
    completionRate: 100,
    gatewayAnomalyCount: 0,
    anomalyCount: 0,
    searchHitRate: 100,
    toolHitRate: 100,
    tokensPerTask: 0,
    p95LatencyMs: 0,
    source: 'fake-dry-run (deterministic simulation; not a gateway measurement)',
  };
}

/**
 * Compare current metrics against a baseline using per-metric tolerances.
 * Direction: 'min'  -> regression when current < baseline - tolerance
 *            'max'  -> regression when current > baseline + tolerance
 * A null baseline metric is skipped; a null current metric is a regression.
 */
export const DEFAULT_THRESHOLDS = {
  completionRate: { direction: 'min', tolerance: 10, unit: '%' },
  gatewayAnomalyCount: { direction: 'max', tolerance: 3, unit: 'count' },
  searchHitRate: { direction: 'min', tolerance: 10, unit: '%' },
  toolHitRate: { direction: 'min', tolerance: 10, unit: '%' },
  tokensPerTask: { direction: 'max', tolerance: 3000, unit: 'tokens' },
  p95LatencyMs: { direction: 'max', tolerance: 15000, unit: 'ms' },
};

export function compareWithBaseline(current, baseline, thresholds = DEFAULT_THRESHOLDS) {
  const checks = [];
  for (const [metric, rule] of Object.entries(thresholds)) {
    const cur = current?.[metric];
    const base = baseline?.metrics?.[metric] ?? baseline?.[metric];
    if (base === null || base === undefined) { checks.push({ metric, status: 'skip', reason: 'no baseline' }); continue; }
    if (cur === null || cur === undefined) { checks.push({ metric, status: 'fail', current: cur, baseline: base, reason: 'missing current value' }); continue; }
    const delta = Number(cur) - Number(base);
    let ok;
    if (rule.direction === 'min') ok = delta >= -rule.tolerance;
    else if (rule.direction === 'max') ok = delta <= rule.tolerance;
    else throw new TypeError(`unknown direction ${rule.direction}`);
    checks.push({
      metric, status: ok ? 'pass' : 'fail',
      current: cur, baseline: base, delta: Math.round(delta * 10) / 10,
      tolerance: rule.tolerance, direction: rule.direction, unit: rule.unit ?? '',
    });
  }
  return { ok: checks.every((c) => c.status !== 'fail'), checks };
}

/** Render the markdown report from a JSON result (pure, deterministic). */
export function renderReport(result) {
  const m = result.metrics ?? {};
  const b = result.baseline?.metrics ?? {};
  const cmp = result.comparison ?? { checks: [] };
  const lines = [
    '# L1 Smoke Report',
    '',
    `- Generated: ${result.generatedAt ?? '(unknown)'}`,
    `- Mode: \`${result.mode ?? '(unknown)'}\``,
    `- Run id: ${result.runId ?? '(none)'}`,
    `- Result: **${result.ok ? 'PASS' : 'FAIL'}**`,
    '',
    '## Metrics',
    '',
    '| Metric | Current | Baseline | Threshold | Status |',
    '|---|---:|---:|---:|---|',
  ];
  const label = {
    tasks: 'Tasks', completionRate: 'Completion rate (%)',
    gatewayAnomalyCount: 'Gateway-attributed anomalies',
    searchHitRate: 'searchHitRate (%)', toolHitRate: 'toolHitRate (%)',
    tokensPerTask: 'Tokens / task', p95LatencyMs: 'p95 latency (ms)',
  };
  const checkByMetric = new Map(cmp.checks.map((c) => [c.metric, c]));
  for (const key of Object.keys(label)) {
    if (m[key] === undefined) continue;
    const c = checkByMetric.get(key);
    const tol = c ? `${c.direction === 'min' ? '−' : '+'}${c.tolerance}${c.unit ?? ''}` : '—';
    lines.push(`| ${label[key]} | ${m[key]} | ${b[key] ?? '—'} | ${tol} | ${c?.status ?? '—'} |`);
  }
  lines.push('', '## Source & caveats', '');
  lines.push(`- Metrics source: ${m.source ?? '(unknown)'}`);
  lines.push(`- Baseline source: ${result.baseline?.source ?? '(unknown)'}`);
  if (result.notes?.length) for (const note of result.notes) lines.push(`- ${note}`);
  lines.push('');
  lines.push('> This report is generated by `scripts/run-l1-smoke.mjs`. In `fake-dry-run` mode the numbers exercise plumbing only and must NOT be read as gateway quality.', '');
  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * Run modes
 * ------------------------------------------------------------------ */

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function runRealMode(tasks) {
  // Delegate to the existing runner with the smoke suite. It writes its own
  // artifacts under explore/results/; we convert them immediately afterwards.
  const env = { ...process.env, EXPLORE_SUITE: 'smoke', EXPLORE_SERVERS: [...new Set(tasks.map((t) => t.server))].join(',') };
  const res = spawnSync(process.execPath, [path.join(ROOT, 'explore/run-explore.mjs')], {
    cwd: ROOT, env, stdio: 'inherit',
  });
  if (res.status !== 0) throw new Error(`run-explore.mjs exited ${res.status}`);
  const metrics = loadJson(path.join(ROOT, 'explore/results/metrics.json'));
  const anomalies = loadJson(path.join(ROOT, 'explore/results/anomalies.json'));
  return {
    metrics: metricsFromExplore({ tasks, perTask: metrics.perTask, anomalies: anomalies.anomalies, source: `run-explore.mjs suite=smoke (${metrics.runId})` }),
    runId: metrics.runId,
  };
}

function runReplayMode(tasks, input) {
  if (!input) throw new Error('--input FILE is required with --mode replay');
  const anomaliesDoc = loadJson(path.resolve(ROOT, input));
  const sibling = path.join(path.dirname(path.resolve(ROOT, input)), 'metrics.json');
  const metricsDoc = fs.existsSync(sibling) ? loadJson(sibling) : { perTask: [] };
  return {
    metrics: metricsFromExplore({
      tasks,
      perTask: metricsDoc.perTask ?? [],
      anomalies: anomaliesDoc.anomalies ?? [],
      source: `replay:${input}`,
    }),
    runId: anomaliesDoc.runId ?? null,
  };
}

function main() {
  const argv = process.argv.slice(2);
  const arg = (name) => {
    const eq = argv.find((a) => a.startsWith(`--${name}=`));
    if (eq) return eq.slice(name.length + 3);
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const mode = arg('mode') ?? 'fake';
  const input = arg('input');
  const baselinePath = path.resolve(ROOT, arg('baseline') ?? 'explore/baselines/l1-smoke.json');

  const smoke = loadJson(SMOKE_TASKS);
  const tasks = smoke.tasks;
  const baseline = loadJson(baselinePath);
  let metrics, runId = null, notes = [];

  if (mode === 'fake') {
    metrics = fakeMetrics(tasks);
    notes.push('fake-dry-run: deterministic simulation, no model/upstream calls; only verifies runner + compare + report wiring.');
  } else if (mode === 'real') {
    ({ metrics, runId } = runRealMode(tasks));
  } else if (mode === 'replay') {
    ({ metrics, runId } = runReplayMode(tasks, input));
  } else {
    console.error(`[l1-smoke] unknown mode: ${mode}`);
    process.exit(2);
  }

  // Real/replay runs are compared to the real G6-derived baseline; fake mode
  // is compared to the fake baseline entry so CI stays green without secrets.
  const effectiveBaseline = (mode === 'fake' && baseline.fake) ? baseline.fake : baseline;
  const comparison = compareWithBaseline(metrics, effectiveBaseline, baseline.thresholds ?? DEFAULT_THRESHOLDS);
  // Task count must always match the committed smoke set.
  const countOk = metrics.tasks === tasks.length;
  const ok = comparison.ok && countOk;
  if (!countOk) notes.push(`task count mismatch: expected ${tasks.length}, got ${metrics.tasks}`);

  const result = {
    generatedAt: new Date().toISOString(),
    mode: mode === 'fake' ? 'fake-dry-run' : mode,
    runId,
    ok,
    taskCount: tasks.length,
    datasetSha256: null,
    metrics,
    baseline: {
      source: effectiveBaseline.source ?? '(unknown)',
      capturedAt: effectiveBaseline.capturedAt ?? null,
      metrics: effectiveBaseline.metrics ?? {},
    },
    comparison,
    notes,
  };

  fs.mkdirSync(path.dirname(REPORT_MD), { recursive: true });
  fs.writeFileSync(REPORT_JSON, JSON.stringify(result, null, 2) + '\n');
  fs.writeFileSync(REPORT_MD, renderReport(result));

  console.log(`[l1-smoke] ${result.mode}: ${ok ? 'PASS' : 'FAIL'} | tasks=${metrics.tasks} completion=${metrics.completionRate}% gatewayAnomalies=${metrics.gatewayAnomalyCount} searchHit=${metrics.searchHitRate}% toolHit=${metrics.toolHitRate}% tokens/task=${metrics.tokensPerTask} p95=${metrics.p95LatencyMs}ms`);
  for (const c of comparison.checks) if (c.status === 'fail') console.error(`[l1-smoke] REGRESSION ${c.metric}: ${c.current} vs baseline ${c.baseline} (${c.direction} tolerance ${c.tolerance})`);
  process.exit(ok ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
