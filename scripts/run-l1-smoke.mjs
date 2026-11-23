#!/usr/bin/env node
/**
 * scripts/run-l1-smoke.mjs — L1 smoke regression runner.
 *
 * Modes:
 *   --mode fake                deterministic, offline, NO credentials (default)
 *   --mode real                runs explore/run-explore.mjs with EXPLORE_SUITE=smoke
 *                              (needs free model key + upstream tokens), then
 *                              converts its artifacts into L1 metrics. Figma is
 *                              skipped by default (no Starter-quota burn).
 *   --mode replay --input FILE reuse an existing explore/results/anomalies.json
 *                              (+ sibling metrics.json) offline.
 *
 * Outputs:
 *   fake / replay:
 *     docs/eval/l1-smoke-report.md  human-readable report (always regenerated)
 *     docs/eval/l1-smoke.json       machine-readable result (always regenerated)
 *   real (dated, kept as history; never overwritten):
 *     docs/eval/l1-real-YYYY-MM-DD.md
 *     docs/eval/l1-real-YYYY-MM-DD.json
 *     docs/eval/l1-real-state.json  consecutive-failure state for the ALERT rule
 *
 * Exit code: 0 = within thresholds, 1 = regression vs baseline, 2 = bad input.
 *
 * Baseline isolation: the baseline is ALWAYS read from the frozen snapshot in
 * explore/baselines/l1-smoke.json. explore/results/* is the current real-run
 * output and is NEVER used as a baseline (that caused baseline === current and
 * made all thresholds trivially pass). See docs/eval/L1-SMOKE.md.
 *
 * Failed-upstream scope: in real mode the runner reads `failedServers` from the
 * run manifest (or --failed-servers) and compares ONLY the connected servers'
 * tasks against a byServer-derived degraded-subset baseline. Failed-server
 * tasks are skipped, never counted as gateway misses, and never silently
 * dropped from just part of the denominator. With 0 connected servers the run
 * is reported as a no-measurement infra failure (exit 1), not a gateway FAIL.
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
const MANIFEST_FILE = path.join(ROOT, 'explore/results/manifest.json');
const REPORT_MD = path.join(ROOT, 'docs/eval/l1-smoke-report.md');
const REPORT_JSON = path.join(ROOT, 'docs/eval/l1-smoke.json');
const REAL_STATE = path.join(ROOT, 'docs/eval/l1-real-state.json');
const VALID_MODES = new Set(['fake', 'real', 'replay']);

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

/**
 * Hit-rate denominator formula (see docs/eval/L1-SMOKE.md):
 *
 *   measurable = tasks with expectedTool whose server is NOT in failedServers
 *                 (OR whose row.serverFailed !== true)
 *   primary rate (like-for-like with the FROZEN baseline, which was computed
 *     with the same null-excluded rule):
 *     searchHitRate = count(measurable, searchHit === true)
 *                   / count(measurable, searchHit !== null && !== undefined)
 *   coverage-adjusted diagnostic (null === never called => MISS):
 *     searchHitRateAdjusted = count(measurable, searchHit === true) / |measurable|
 *
 * A failed-server task is excluded from BOTH numerator and denominator — it
 * is a skipped upstream, never a gateway miss. The old harness sometimes
 * counted such a task as `false` (when the model called search) and sometimes
 * dropped it as `null` (when it did not), making the rate model-dependent.
 */
export const DENOMINATOR_FORMULA = 'measurable = expectedTool && !serverFailed; primary: hits / non-null (matches frozen baseline); adjusted: hits / |measurable| with null counted as miss';

/**
 * Convert explore runner artifacts into L1 metrics.
 *
 * When `failedServers` is provided (real mode), tasks belonging to those
 * servers are removed from the measurement scope entirely: their rows,
 * anomalies and hit-rate contributions all disappear. `skippedByServer`
 * records what was removed. With no failedServers the legacy behavior is
 * unchanged (backward compatible with replay/fake and existing consumers).
 */
export function metricsFromExplore({ tasks, perTask = [], anomalies = [], source = 'explore', failedServers = [] }) {
  const failed = new Set(failedServers);
  const scopedTasks = failed.size ? tasks.filter((t) => !failed.has(t.server)) : tasks;
  const ids = scopedTasks.map((t) => t.id);
  const idSet = new Set(ids);
  const rows = perTask.filter((r) => idSet.has(r.task) && !failed.has(r.server));
  const relevant = anomalies.filter((a) => idSet.has(a.task));
  const fatalTasks = new Set(relevant.filter((a) => FATAL_TYPES.has(a.type)).map((a) => a.task));
  const gatewayAnomalies = relevant.filter((a) => a.attribution === 'gateway').length;
  const searchRows = rows.filter((r) => r.searchHit !== null && r.searchHit !== undefined);
  const toolRows = rows.filter((r) => r.toolHit !== null && r.toolHit !== undefined);
  const latencies = rows.map((r) => r.wallMs ?? 0);
  const tokens = rows.reduce((s, r) => s + (r.totalTokens ?? 0), 0);
  const withTool = rows.filter((r) => r.expectedTool || r.searchHit !== null || r.toolHit !== null);
  const skippedByServer = {};
  if (failed.size) {
    for (const t of tasks.filter((t) => failed.has(t.server))) {
      skippedByServer[t.server] = (skippedByServer[t.server] ?? 0) + 1;
    }
  }

  return {
    tasks: ids.length,
    measuredTasks: rows.length,
    completed: Math.max(0, ids.length - fatalTasks.size),
    completionRate: rate(Math.max(0, ids.length - fatalTasks.size), ids.length),
    gatewayAnomalyCount: gatewayAnomalies,
    anomalyCount: relevant.length,
    searchHitRate: rate(searchRows.filter((r) => r.searchHit === true).length, searchRows.length),
    toolHitRate: rate(toolRows.filter((r) => r.toolHit === true).length, toolRows.length),
    // Coverage-adjusted diagnostics: null (never called) is a MISS, failed
    // servers are out of scope. Not used for baseline comparison because the
    // frozen baseline only stores the legacy rates.
    searchHitRateAdjusted: rate(withTool.filter((r) => r.searchHit === true).length, withTool.length),
    toolHitRateAdjusted: rate(withTool.filter((r) => r.toolHit === true).length, withTool.length),
    searchDenominator: searchRows.length,
    toolDenominator: toolRows.length,
    adjustedDenominator: withTool.length,
    denominatorFormula: DENOMINATOR_FORMULA,
    tokensPerTask: rows.length ? Math.round(tokens / rows.length) : 0,
    p95LatencyMs: Math.round(percentile(latencies, 95)),
    source,
    failedServers: [...failed],
    skippedByServer,
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
    `# ${result.title ?? 'L1 Smoke Report'}`,
    '',
    `- Generated: ${result.generatedAt ?? '(unknown)'}`,
    `- Mode: \`${result.mode ?? '(unknown)'}\``,
    `- Trigger: \`${result.trigger ?? '(unknown)'}\``,
    `- Run id: ${result.runId ?? '(none)'}`,
    `- Result: **${result.ok ? 'PASS' : 'FAIL'}**${result.alert ? ' — **ALERT**' : ''}`,
  ];
  if (result.skippedServers?.length) {
    lines.push(`- Skipped servers: ${result.skippedServers.map((s) => `\`${s}\``).join(', ')} (no upstream calls, no quota burned)`);
  }
  if (result.failedServers?.length) {
    lines.push(`- Failed upstreams: ${result.failedServers.map((s) => `\`${s}\``).join(', ')} (their tasks are excluded from all metrics — skipped, not gateway misses)`);
  }
  if (result.baselineScope) {
    lines.push(`- Comparison scope: \`${result.baselineScope}\``);
  }
  if (result.measuredTasks !== undefined && result.taskCount !== undefined) {
    lines.push(`- Measured tasks: ${result.measuredTasks}/${result.taskCount}${result.skippedByServer && Object.keys(result.skippedByServer).length ? ` (skipped by server: ${Object.entries(result.skippedByServer).map(([s, n]) => `\`${s}\`:${n}`).join(', ')})` : ''}`);
  }
  if (result.alert) {
    lines.push(`- Free-model volatility: **ALERT** — ${result.alertReason ?? 'consecutive regressions'}`);
  } else if (result.mode === 'real' && !result.ok) {
    lines.push('- Free-model volatility: single red run — no ALERT yet (see L1-SMOKE.md)');
  }
  lines.push('', '## Metrics', '', '| Metric | Current | Baseline | Threshold | Status |', '|---|---:|---:|---:|---|');
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
  lines.push(`- Baseline scope: ${result.baseline?.fallback ? OVERALL_FALLBACK_LABEL : (result.baseline?.perServer ? 'per-server snapshot (like-for-like)' : 'overall baseline')}`);
  if (result.baseline?.baselineScope) lines.push(`- Baseline scope input: \`${result.baseline.baselineScope}\``);
  if (m.denominatorFormula && !String(m.source ?? '').includes('fake-dry-run')) {
    lines.push(`- Hit-rate denominator: ${m.denominatorFormula}`);
    lines.push(`- Denominators: search=${m.searchDenominator ?? '—'}, tool=${m.toolDenominator ?? '—'}, adjusted=${m.adjustedDenominator ?? '—'}; adjusted rates (null = miss): search=${m.searchHitRateAdjusted ?? '—'}%, tool=${m.toolHitRateAdjusted ?? '—'}%`);
  }
  if (result.notes?.length) for (const note of result.notes) lines.push(`- ${note}`);
  lines.push('');
  lines.push('> This report is generated by `scripts/run-l1-smoke.mjs`. In `fake-dry-run` mode the numbers exercise plumbing only and must NOT be read as gateway quality.', '');
  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * Argument / mode / server parsing (pure, unit-tested)
 * ------------------------------------------------------------------ */

/**
 * Parse CLI args into a normalized options object. Unknown modes are returned
 * as-is so the caller can report them with exit code 2.
 */
export function parseArgs(argv = []) {
  const arg = (name) => {
    const eq = argv.find((a) => a.startsWith(`--${name}=`));
    if (eq) return eq.slice(name.length + 3);
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const servers = arg('servers');
  const failedServers = arg('failed-servers');
  return {
    mode: arg('mode') ?? 'fake',
    input: arg('input'),
    baseline: arg('baseline') ?? 'explore/baselines/l1-smoke.json',
    date: arg('date') ?? new Date().toISOString().slice(0, 10),
    // Comma-separated allow-list. Empty string => all servers (legacy replay).
    servers: servers === undefined || servers === '' ? null
      : servers.split(',').map((s) => s.trim()).filter(Boolean),
    // Explicit failed-server input; merged with the run manifest in real mode.
    // Empty/undefined => rely on the manifest (legacy compatible).
    failedServers: failedServers === undefined || failedServers === '' ? null
      : failedServers.split(',').map((s) => s.trim()).filter(Boolean),
  };
}

/**
 * Resolve the effective mode from a workflow event.
 * - daily schedule (cron at 18:00 UTC) => fake
 * - weekly Monday schedule (cron at 18:00 UTC) => real
 * - workflow_dispatch => the requested input (fake|real), default fake
 */
export function resolveMode({ eventName, schedule, dispatchMode } = {}) {
  if (eventName === 'workflow_dispatch') {
    return VALID_MODES.has(dispatchMode) ? dispatchMode : 'fake';
  }
  if (eventName === 'schedule') {
    const cron = String(schedule ?? '');
    return /^\s*\d+\s+\d+\s+\*\s+\*\s+1\b/.test(cron) ? 'real' : 'fake';
  }
  return 'fake';
}

/** Default real-mode upstreams: everything except Figma (Starter quota). */
export const DEFAULT_REAL_SERVERS = ['github', 'notion', 'linear', 'vercel'];
export const SKIPPED_SERVERS = ['figma'];

/** Filter tasks to the allowed servers; return both the kept tasks and skips. */
export function selectTasksByServers(tasks, servers) {
  if (!servers) return { tasks, skippedServers: [] };
  const allow = new Set(servers);
  const kept = tasks.filter((t) => allow.has(t.server));
  const present = new Set(tasks.map((t) => t.server));
  const skippedServers = [...present].filter((s) => !allow.has(s));
  return { tasks: kept, skippedServers };
}

/**
 * Normalize the explicit failed-server input (CLI) and the run manifest's
 * `failedServers` (produced by explore/run-explore.mjs from
 * UpstreamManager.failedServers). Both sources are merged; the result is
 * sorted/deduped. A missing manifest field is treated as "unknown", i.e. an
 * empty list — legacy runs keep their previous behavior.
 */
export function parseFailedServers({ explicit = [], manifest = {} } = {}) {
  const values = [
    ...(Array.isArray(explicit) ? explicit : String(explicit ?? '').split(',')),
    ...(Array.isArray(manifest?.failedServers) ? manifest.failedServers : []),
  ];
  return [...new Set(values.map((s) => String(s).trim()).filter(Boolean))].sort();
}

/**
 * Classify the comparison scope from the requested servers and the failures
 * observed in this run:
 *   full              — every requested server connected (legacy path)
 *   degraded-subset   — some failed, but at least one server is measurable
 *   no-measured-tasks — every requested server failed; nothing to compare
 */
export function baselineScopeFor({ requestedServers = [], failedServers = [] } = {}) {
  const failed = new Set(failedServers);
  const measured = requestedServers.filter((s) => !failed.has(s));
  if (!measured.length) return 'no-measured-tasks';
  return failed.size ? 'degraded-subset' : 'full';
}

/** Date-stamped real report paths (kept as history, never overwritten). */
export function realReportPaths(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new TypeError(`bad date: ${date}`);
  return {
    md: path.join(ROOT, 'docs/eval', `l1-real-${date}.md`),
    json: path.join(ROOT, 'docs/eval', `l1-real-${date}.json`),
  };
}

/**
 * Consecutive-failure state for the free-model volatility rule.
 * ALERT only after TWO consecutive real-mode failures. A pass resets the
 * streak to zero. A single red run still exits 1 (existing behaviour) but is
 * labelled "single red — no ALERT yet" in the report.
 */
export function evaluateConsecutiveAlerts(state, { ok, date, runId }) {
  const streak = ok ? 0 : (Number(state?.consecutiveFailures) || 0) + 1;
  const alert = streak >= 2;
  return {
    state: {
      consecutiveFailures: streak,
      lastRunDate: date,
      lastRunId: runId ?? null,
      lastResult: ok ? 'pass' : 'fail',
      alert,
      updatedAt: new Date().toISOString(),
    },
    alert,
    alertReason: alert
      ? `${streak} consecutive real-mode failures (free model may be volatile; check upstream/model signals before filing a gateway defect)`
      : null,
  };
}

/* ------------------------------------------------------------------ *
 * Run modes
 * ------------------------------------------------------------------ */

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * Build a server-filtered baseline from the COMMITTED baseline snapshot only.
 *
 * IMPORTANT: this function deliberately never reads explore/results/metrics.json
 * or anomalies.json. In real mode those files have just been overwritten by
 * run-explore.mjs with the CURRENT run; using them as a baseline made
 * baseline === current and every threshold passed trivially. The per-server
 * numbers were computed ONCE (2026-11-22 G6 run) and frozen into
 * explore/baselines/l1-smoke.json under `byServer` / `serverSets`.
 *
 * Selection rules:
 *   1. Exact `serverSets[<sorted comma list>]` snapshot when present (preferred:
 *      preserves the true p95 of the combined task set).
 *   2. Otherwise aggregate `byServer` entries for the requested servers
 *      (counts summed; rates/tokens weighted by task count; p95 = max, which is
 *      conservative for a 'max' threshold).
 *   3. Otherwise fall back to the overall (50-task) baseline and label it
 *      loudly as `baseline-source: overall 50; not per-server` — never silently
 *      present the aggregate as a per-server baseline.
 */
export const OVERALL_FALLBACK_LABEL = 'baseline-source: overall 50; not per-server';

export function deriveBaselineForServers(tasks, baselineDoc, thresholds = DEFAULT_THRESHOLDS, { baselineScope = 'full' } = {}) {
  // Backwards compatibility: the legacy signature was (tasks, thresholds?).
  // When callers pass thresholds instead of a baseline document, load the
  // FROZEN baseline file (never explore/results/*).
  let doc = baselineDoc;
  if (!doc || (!doc.metrics && !doc.byServer && !doc.serverSets)) {
    const legacyThresholds = doc && Object.keys(doc).length ? doc : thresholds;
    doc = fs.existsSync(BASELINE_FILE) ? loadJson(BASELINE_FILE) : {};
    thresholds = legacyThresholds;
  }
  const servers = [...new Set(tasks.map((t) => t.server))].sort();
  const key = servers.join(',');
  const byServer = doc.byServer ?? {};
  const serverSets = doc.serverSets ?? {};

  // Match snapshots regardless of key ordering (e.g. "github,notion,linear,vercel"
  // in the file vs. alphabetically sorted "github,linear,notion,vercel" at runtime).
  let fromSet = serverSets[key];
  if (!fromSet) {
    for (const [setKey, value] of Object.entries(serverSets)) {
      if (setKey.startsWith('_') || !value || typeof value !== 'object') continue;
      if (setKey.split(',').sort().join(',') === key) { fromSet = value; break; }
    }
  }
  const allPresent = servers.length > 0 && servers.every((s) => byServer[s] && Number.isFinite(byServer[s].tasks));
  if (fromSet && Number.isFinite(fromSet.tasks)) {
    return {
      source: `byServer snapshot [${key}] — ${doc.runId ?? 'frozen G6 baseline'}; Figma excluded if absent; see explore/baselines/l1-smoke.json`,
      capturedAt: doc.capturedAt ?? null,
      metrics: { ...fromSet },
      thresholds,
      baselineSource: 'byServer',
      perServer: true,
      servers,
      baselineScope,
      fallback: false,
    };
  }
  if (allPresent) {
    const rows = servers.map((s) => byServer[s]);
    const total = rows.reduce((sum, r) => sum + r.tasks, 0);
    const weighted = (metric) => total
      ? Math.round(rows.reduce((sum, r) => sum + (r[metric] ?? 0) * r.tasks, 0) / total * 10) / 10
      : 0;
    const counted = (metric) => rows.reduce((sum, r) => sum + (r[metric] ?? 0), 0);
    const metrics = {
      tasks: total,
      measuredTasks: counted('measuredTasks'),
      completed: counted('completed'),
      completionRate: weighted('completionRate'),
      gatewayAnomalyCount: counted('gatewayAnomalyCount'),
      anomalyCount: counted('anomalyCount'),
      searchHitRate: weighted('searchHitRate'),
      toolHitRate: weighted('toolHitRate'),
      tokensPerTask: Math.round(weighted('tokensPerTask')),
      // Conservative proxy: the p95 of a union of sets is at least the max of the
      // per-set p95s. Use the exact serverSets snapshot when available.
      p95LatencyMs: Math.max(...rows.map((r) => r.p95LatencyMs ?? 0)),
    };
    return {
      source: `byServer aggregate [${key}] — ${doc.runId ?? 'frozen G6 baseline'}; Figma excluded if absent; see explore/baselines/l1-smoke.json`,
      capturedAt: doc.capturedAt ?? null,
      metrics,
      thresholds,
      baselineSource: 'byServer',
      perServer: true,
      servers,
      baselineScope,
      fallback: false,
    };
  }
  const metrics = { ...(doc.metrics ?? {}) };
  return {
    source: `${doc.source ?? 'overall baseline'} — ${OVERALL_FALLBACK_LABEL} (Figma excluded if absent)`,
    capturedAt: doc.capturedAt ?? null,
    metrics,
    thresholds,
    baselineSource: OVERALL_FALLBACK_LABEL,
    perServer: false,
    servers,
    baselineScope,
    fallback: true,
  };
}

function runRealMode(tasks, servers, explicitFailedServers = []) {
  // Delegate to the existing runner with the smoke suite. It writes its own
  // artifacts under explore/results/; we convert them immediately afterwards.
  const allow = (servers ?? [...new Set(tasks.map((t) => t.server))]).join(',');
  const env = { ...process.env, EXPLORE_SUITE: 'smoke', EXPLORE_SERVERS: allow };
  const res = spawnSync(process.execPath, [path.join(ROOT, 'explore/run-explore.mjs')], {
    cwd: ROOT, env, stdio: 'inherit',
  });
  if (res.status !== 0) throw new Error(`run-explore.mjs exited ${res.status}`);
  const metrics = loadJson(path.join(ROOT, 'explore/results/metrics.json'));
  const anomalies = loadJson(path.join(ROOT, 'explore/results/anomalies.json'));
  const manifest = fs.existsSync(MANIFEST_FILE) ? loadJson(MANIFEST_FILE) : {};
  // Prefer the manifest (authoritative: UpstreamManager.failedServers) and
  // merge any explicit --failed-servers input. The CLI flag also covers old
  // manifests that predate the failedServers field.
  const failedServers = parseFailedServers({ explicit: explicitFailedServers, manifest });
  // Also trust per-row markings written by the updated explore runner, so a
  // 0-tool server that connected is not silently treated as a healthy server.
  const rowFailed = new Set(
    (metrics.perTask ?? []).filter((r) => r.serverFailed === true).map((r) => r.server),
  );
  const effectiveFailed = [...new Set([...failedServers, ...rowFailed])].sort();
  return {
    metrics: metricsFromExplore({
      tasks, perTask: metrics.perTask, anomalies: anomalies.anomalies,
      failedServers: effectiveFailed,
      source: `run-explore.mjs suite=smoke servers=${allow} (${metrics.runId})`,
    }),
    runId: metrics.runId,
    failedServers: effectiveFailed,
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

/**
 * Pure scope/baseline/comparison decision for a run. Extracted so the
 * failed-server matrix (4/4, 2/4, 0/4) can be unit-tested without spawning a
 * real run. See tests/l1-failed-server.test.js.
 */
export function evaluateL1Scope({
  isReal = false, mode = 'replay', tasks = [], metrics = {},
  baselineDoc = {}, thresholds = DEFAULT_THRESHOLDS,
  failedServers = [], baselineScope = 'full', skippedServers = [],
  notes = [],
} = {}) {
  const failedSet = new Set(failedServers);
  const measuredTasks = baselineScope === 'full' ? tasks : tasks.filter((t) => !failedSet.has(t.server));
  const noMeasurement = baselineScope === 'no-measured-tasks';

  let effectiveBaseline = null;
  let comparison = { ok: false, checks: [] };
  if (!noMeasurement) {
    if (isReal && (baselineScope !== 'full' || skippedServers.length)) {
      effectiveBaseline = deriveBaselineForServers(measuredTasks, baselineDoc, thresholds, { baselineScope });
      // Never hard-compare a degraded subset to the overall baseline: without
      // per-server data there is no like-for-like degraded baseline.
      if (effectiveBaseline.fallback && baselineScope !== 'full') {
        notes.push(`no per-server snapshot for [${[...new Set(measuredTasks.map((t) => t.server))].sort().join(',')}]; refusing to compare degraded subset against the overall baseline (not like-for-like).`);
        effectiveBaseline = null;
      }
    } else {
      effectiveBaseline = (mode === 'fake' && baselineDoc.fake) ? baselineDoc.fake : baselineDoc;
    }
    if (effectiveBaseline) comparison = compareWithBaseline(metrics, effectiveBaseline, thresholds);
  }
  if (effectiveBaseline?.fallback) {
    notes.push(`baseline fallback: ${OVERALL_FALLBACK_LABEL} — no per-server snapshot for [${[...new Set(measuredTasks.map((t) => t.server))].sort().join(',')}]; aggregate baseline is NOT like-for-like and regressions may be masked.`);
  }
  const countOk = metrics.tasks === measuredTasks.length;
  const ok = !noMeasurement && !!effectiveBaseline && comparison.ok && countOk;
  if (!countOk) notes.push(`task count mismatch: expected ${measuredTasks.length} measured tasks, got ${metrics.tasks}`);
  return { effectiveBaseline, comparison, measuredTasks, noMeasurement, countOk, ok };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { mode, input, date } = opts;
  if (!VALID_MODES.has(mode)) {
    console.error(`[l1-smoke] unknown mode: ${mode}`);
    process.exit(2);
  }

  const smoke = loadJson(SMOKE_TASKS);
  const allTasks = smoke.tasks;
  const baselineDoc = loadJson(path.resolve(ROOT, opts.baseline));
  const isReal = mode === 'real';
  const { tasks, skippedServers } = isReal
    ? selectTasksByServers(allTasks, opts.servers ?? DEFAULT_REAL_SERVERS)
    : { tasks: allTasks, skippedServers: [] };

  let metrics, runId = null;
  let failedServers = [];
  let baselineScope = 'full';
  let skippedByServer = {};
  const notes = [];
  if (mode === 'fake') {
    metrics = fakeMetrics(tasks);
    notes.push('fake-dry-run: deterministic simulation, no model/upstream calls; only verifies runner + compare + report wiring.');
  } else if (isReal) {
    const requestedServers = opts.servers ?? DEFAULT_REAL_SERVERS;
    ({ metrics, runId, failedServers } = runRealMode(tasks, requestedServers, opts.failedServers ?? []));
    skippedByServer = metrics.skippedByServer ?? {};
    baselineScope = baselineScopeFor({ requestedServers, failedServers });
    if (skippedServers.length) {
      notes.push(`skipped servers (${skippedServers.join(', ')}): no upstream calls made — Figma Starter quota preserved; mark as skipped, not failed.`);
    }
    if (failedServers.length) {
      notes.push(`degraded upstreams: ${failedServers.join(', ')} — their tasks were SKIPPED (not gateway misses); comparing only the connected-server subset against a byServer-derived baseline.`);
    }
    if (baselineScope === 'no-measured-tasks') {
      notes.push(`no measurable tasks: every requested upstream failed (${failedServers.join(', ')}) — this is an INFRA/no-measurement result, not a gateway regression; no baseline comparison was performed.`);
    }
    notes.push('Free-model volatility: a single red run still exits 1, but ALERT is only raised after two consecutive real-mode failures.');
  } else {
    ({ metrics, runId } = runReplayMode(tasks, input));
  }

  // Real/replay runs are compared to the frozen G6-derived baseline snapshot in
  // explore/baselines/l1-smoke.json; fake mode uses the separate fake entry.
  // In degraded real mode the baseline is derived ONLY from the connected
  // servers via byServer — never from the full 40-task snapshot and never from
  // explore/results/* (the current run output).
  const thresholds = baselineDoc.thresholds ?? DEFAULT_THRESHOLDS;
  const {
    effectiveBaseline, comparison, measuredTasks, noMeasurement, ok,
  } = evaluateL1Scope({
    isReal, mode, tasks, metrics, baselineDoc, thresholds,
    failedServers, baselineScope, skippedServers, notes,
  });

  let alert = false, alertReason = null;
  const paths = isReal ? realReportPaths(date) : { md: REPORT_MD, json: REPORT_JSON };
  if (isReal) {
    const state = fs.existsSync(REAL_STATE) ? loadJson(REAL_STATE) : null;
    const evaluated = evaluateConsecutiveAlerts(state, { ok, date, runId });
    alert = evaluated.alert;
    alertReason = evaluated.alertReason;
    fs.mkdirSync(path.dirname(REAL_STATE), { recursive: true });
    fs.writeFileSync(REAL_STATE, JSON.stringify(evaluated.state, null, 2) + '\n');
  }

  const result = {
    generatedAt: new Date().toISOString(),
    title: isReal ? `L1 Real Regression — ${date}` : 'L1 Smoke Report',
    mode: mode === 'fake' ? 'fake-dry-run' : mode,
    trigger: process.env.GITHUB_EVENT_NAME ?? 'local',
    date: isReal ? date : null,
    runId,
    ok,
    alert,
    alertReason,
    skippedServers,
    failedServers,
    baselineScope,
    measuredTasks: metrics.measuredTasks ?? measuredTasks.length,
    skippedByServer,
    taskCount: measuredTasks.length,
    fullSmokeTaskCount: allTasks.length,
    datasetSha256: null,
    metrics,
    baseline: effectiveBaseline ? {
      source: effectiveBaseline.source ?? '(unknown)',
      capturedAt: effectiveBaseline.capturedAt ?? null,
      metrics: effectiveBaseline.metrics ?? {},
      baselineSource: effectiveBaseline.baselineSource ?? 'overall',
      perServer: effectiveBaseline.perServer === true,
      fallback: effectiveBaseline.fallback === true,
      baselineScope: effectiveBaseline.baselineScope ?? baselineScope,
    } : null,
    comparison,
    notes,
  };

  fs.mkdirSync(path.dirname(paths.md), { recursive: true });
  fs.writeFileSync(paths.json, JSON.stringify(result, null, 2) + '\n');
  fs.writeFileSync(paths.md, renderReport(result));

  const scopeTag = baselineScope === 'full' ? '' : ` scope=${baselineScope}`;
  console.log(`[l1-smoke] ${result.mode}: ${ok ? 'PASS' : 'FAIL'}${alert ? ' ALERT' : ''}${scopeTag} | measured=${metrics.tasks}/${result.taskCount} (full=${allTasks.length}) failed=${failedServers.join(',') || 'none'} skippedByServer=${JSON.stringify(skippedByServer)} completion=${metrics.completionRate}% gatewayAnomalies=${metrics.gatewayAnomalyCount} searchHit=${metrics.searchHitRate}% toolHit=${metrics.toolHitRate}% tokens/task=${metrics.tokensPerTask} p95=${metrics.p95LatencyMs}ms`);
  console.log(`[l1-smoke] report: ${path.relative(ROOT, paths.md)}`);
  if (effectiveBaseline?.fallback) console.warn(`[l1-smoke] WARNING: ${OVERALL_FALLBACK_LABEL}`);
  if (noMeasurement) console.error('[l1-smoke] NO MEASUREMENT: all requested upstreams failed; infra/reauth required, not a gateway regression.');
  for (const c of comparison.checks) if (c.status === 'fail') console.error(`[l1-smoke] REGRESSION ${c.metric}: ${c.current} vs baseline ${c.baseline} (${c.direction} tolerance ${c.tolerance})`);
  process.exit(ok ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
