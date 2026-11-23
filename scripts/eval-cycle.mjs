#!/usr/bin/env node
/**
 * scripts/eval-cycle.mjs — repeatable, offline online↔semi-online eval cycle.
 *
 * Converts the one-off "online feedback → join doc" exercise into a command
 * that can be re-run on every checkout change. It performs, in one command:
 *
 *   1. deterministic L1 fake run (no credentials, no network) with the
 *      additive `online-gap` profile semantics (N1–N9 + J1–J6);
 *   2. replay of the deterministic fake online-session fixture through the
 *      existing replay harness (offline stub only);
 *   3. join-coverage audit: F1–F6 still covered/weak/missing, J1–J6 exist,
 *      N1–N9 load; `unknown` is NEVER counted as a pass;
 *   4. docs artifact presence/content check (join doc, gaps doc, feedback
 *      record, this cycle's docs);
 *   5. baseline comparison (READ-ONLY): frozen explore/baselines/* and/or the
 *      previous eval-cycle report. A changed signature is `DRIFT`; with no
 *      baseline at all the result is `NO_BASELINE`. Neither is a failure, but
 *      both are printed explicitly. Baselines are never written or updated.
 *
 * HARD BOUNDARIES (inherits AGENTS.md + docs/eval/ONLINE-FEEDBACK.md):
 *   - 100% offline: no fetch, no R2, no upstream calls, no credentials,
 *     no production writes. No child processes. No timers/schedules.
 *   - Writes ONLY new timestamped `docs/eval/eval-cycle-*.json|md` artifacts,
 *     and refuses to overwrite an existing path (unique name per run).
 *   - No changes to src/, other scripts/tests/docs, workflows, explore tasks,
 *     baselines, or the fixed `docs/eval/l1-online-gap*.{json,md}` artifacts
 *     written by scripts/run-l1-smoke.mjs.
 *   - No commit / push / deploy.
 *
 * Exit codes:
 *   0 = no FAIL in any check (DRIFT / NO_BASELINE allowed but explicit)
 *   1 = at least one FAIL (e.g. missing task id, unreadable required doc)
 *   2 = bad CLI input
 *
 * Usage:
 *   node scripts/eval-cycle.mjs
 *   node scripts/eval-cycle.mjs --now 2026-11-23T12:00:00.000Z --out-dir /tmp/cycle
 *
 * Pure API (tests / other scripts):
 *   parseArgs, auditJoinCoverage, auditDocs, evaluateBaseline,
 *   buildReport, renderMarkdown, runCycle, main
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  fakeMetrics,
  loadOnlineGapTasks,
  loadOnlineGapBaseline,
  computeOnlineGapMetrics,
  compareOnlineGapCurrent,
  ONLINE_GAP_BASELINE_FILE,
} from './run-l1-smoke.mjs';
import {
  createFakeSession, buildReplayPlan, replayPlan, diffReplay,
} from './replay-online-session.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');

export const SCHEMA = 'eval-cycle.v1';
export const F_IDS = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6'];
export const N_IDS = ['N1', 'N2', 'N3', 'N4', 'N5', 'N6', 'N7', 'N8', 'N9'];
export const J_IDS = ['J1', 'J2', 'J3', 'J4', 'J5', 'J6'];
const COVERAGE_STATES = new Set(['covered', 'weak', 'missing']);

export const DEFAULT_FILES = Object.freeze({
  joinDoc: 'docs/eval/ONLINE-SEMIONLINE-JOIN-2026-11-23.md',
  gapsDoc: 'docs/eval/SEMI-ONLINE-GAPS.md',
  feedbackDoc: 'docs/eval/online-feedback-2026-11-23-gemini.md',
  nTasks: 'explore/tasks-online-gap.json',
  jTasks: 'explore/tasks-online-gap-2.json',
  l1Baseline: 'explore/baselines/l1-smoke.json',
  onlineGapBaseline: 'explore/baselines/l1-online-gap.json',
  continuousDoc: 'docs/eval/CONTINUOUS-EVAL.md',
  ledger: 'docs/ledger/batch-15-continuous-eval.md',
});

/** CLI options. Default out-dir is docs/eval (timestamped names, never overwrite). */
export function parseArgs(argv = []) {
  const arg = (name) => {
    const eq = argv.find((a) => a.startsWith(`--${name}=`));
    if (eq) return eq.slice(name.length + 3);
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const outDir = arg('out-dir') ?? 'docs/eval';
  const now = arg('now');
  if (now !== undefined && Number.isNaN(Date.parse(now))) {
    throw new TypeError(`invalid --now: ${now}`);
  }
  const reportDir = arg('report-dir') ?? outDir;
  return {
    outDir,
    reportDir,
    now: now ?? new Date().toISOString(),
    // Optional stable tag for tests; does not change check semantics.
    tag: arg('tag') ?? null,
    help: argv.includes('--help') || argv.includes('-h'),
  };
}

/** Stable JSON canonicalization for hashing signatures (sorted keys). */
function canonical(value) {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
export function stableHash(value) {
  return createHash('sha256').update(canonical(value)).digest('hex').slice(0, 16);
}

/* ------------------------------------------------------------------ *
 * Join-coverage audit (F1–F6 / J1–J6 / N1–N9)
 * ------------------------------------------------------------------ */

/**
 * Parse the F1–F6 coverage states from the authoritative join doc table.
 * Only exact `covered|weak|missing` in the "当前覆盖状态" column count.
 * Anything else (including `unknown`, prose-only mentions, a missing row) is
 * reported as an explicit non-pass finding — never silently folded into pass.
 *
 * @returns {{rows: Array, missing: Array, nonPass: Array}}
 */
export function parseFCoverage(joinDocMarkdown) {
  const lines = String(joinDocMarkdown ?? '').split(/\r?\n/);
  const rows = [];
  for (const line of lines) {
    // Table rows look like: | **F1**（P0） ... | ... | **`weak`** | ... |
    const cells = line.split('|').map((c) => c.trim());
    if (cells.length < 3) continue;
    const idMatch = cells[1]?.match(/\b(F[1-6])\b/);
    if (!idMatch) continue;
    const id = idMatch[1];
    if (rows.some((r) => r.id === id)) continue;
    // The coverage column is normally index 4 in the join doc, but a narrow
    // table may place it earlier. Find the FIRST cell (after the id column)
    // containing a coverage keyword; never read the code-state column's
    // `unknown` as a coverage state.
    const stateIndex = cells.findIndex((cell, i) => i > 1 && /\b(covered|weak|missing)\b/.test(cell ?? ''));
    const stateCell = stateIndex >= 0 ? cells[stateIndex] : '';
    const stateMatch = stateCell.match(/\b(covered|weak|missing)\b/);
    const state = stateMatch ? stateMatch[1] : 'unknown';
    rows.push({
      id,
      state,
      recognized: COVERAGE_STATES.has(state),
      // `covered` for some F rows is split ("covered（原子写） ... weak（默认语义）").
      // Record every recognized state in the cell so no weaker half is lost.
      allStates: [...new Set([...stateCell.matchAll(/\b(covered|weak|missing)\b/g)].map((m) => m[1]))],
    });
  }
  const missing = F_IDS.filter((id) => !rows.some((r) => r.id === id));
  const nonPass = rows.filter((r) => !r.recognized || r.allStates.some((s) => s !== 'covered'));
  return { rows, missing, nonPass };
}

/**
 * Audit one cycle of join coverage using real files (injectable for tests).
 * `unknown` / SKIP / missing task ids are FAIL findings, never passes.
 */
export function auditJoinCoverage({
  files = DEFAULT_FILES,
  root = ROOT,
  read = (p) => fs.readFileSync(p, 'utf8'),
  exists = (p) => fs.existsSync(p),
  loadTasks = (rel, opts) => loadOnlineGapTasks({ files: [rel], expectedIds: opts.expectedIds, root, exists, read: (p) => JSON.parse(read(p)) }),
} = {}) {
  const findings = [];
  const readRel = (rel) => read(path.isAbsolute(rel) ? rel : path.join(root, rel));

  let f = { rows: [], missing: F_IDS, nonPass: [] };
  try {
    f = parseFCoverage(readRel(files.joinDoc));
  } catch (err) {
    findings.push({ level: 'FAIL', id: 'joinDoc', detail: `unreadable (${err.message})` });
  }
  for (const id of f.missing) {
    findings.push({ level: 'FAIL', id, detail: 'F1–F6 join row absent or unparseable (unknown, never a pass)' });
  }
  for (const row of f.nonPass) {
    findings.push({
      level: 'INFO', id: row.id,
      detail: `coverage=${row.allStates.join('+') || 'unknown'} (weak/missing tracked, not a pass)`,
    });
  }

  const taskAudit = {};
  for (const [label, rel, expectedIds] of [
    ['N', files.nTasks, N_IDS],
    ['J', files.jTasks, J_IDS],
  ]) {
    let loaded = [];
    let skips = [];
    try {
      ({ tasks: loaded, skips } = loadTasks(rel, { expectedIds }));
    } catch (err) {
      findings.push({ level: 'FAIL', id: `${label}-tasks`, detail: `unreadable (${err.message})` });
    }
    const present = new Set(loaded.map((t) => t.id));
    for (const id of expectedIds) {
      if (present.has(id)) continue;
      const skip = skips.find((s) => s.id === id);
      findings.push({
        level: 'FAIL', id,
        detail: skip ? `SKIP (${skip.reason}) — not a pass` : 'declared task id not loaded — unknown, not a pass',
      });
    }
    taskAudit[label] = {
      file: rel,
      expected: expectedIds,
      loaded: [...present],
      skips,
    };
  }

  const ok = !findings.some((x) => x.level === 'FAIL');
  return { ok, findings, fRows: f.rows, taskAudit };
}

/* ------------------------------------------------------------------ *
 * Docs artifact check
 * ------------------------------------------------------------------ */

/** Presence + minimal content checks for the docs that the cycle depends on. */
export function auditDocs({
  files = DEFAULT_FILES,
  root = ROOT,
  read = (p) => fs.readFileSync(p, 'utf8'),
  exists = (p) => fs.existsSync(p),
} = {}) {
  const checks = [];
  const required = [
    ['joinDoc', files.joinDoc, /F1|coverage|覆盖/],
    ['gapsDoc', files.gapsDoc, /N1|SEMI-ONLINE/],
    ['feedbackDoc', files.feedbackDoc, /online-feedback\.v1|F1/],
    ['nTasks', files.nTasks, null],
    ['jTasks', files.jTasks, null],
    ['continuousDoc', files.continuousDoc, /eval-cycle|continuous/i],
    ['ledger', files.ledger, /batch-15-continuous-eval|eval-cycle/i],
  ];
  for (const [name, rel, pattern] of required) {
    const abs = path.isAbsolute(rel) ? rel : path.join(root, rel);
    if (!exists(abs)) {
      checks.push({ artifact: rel, status: 'FAIL', reason: 'artifact absent' });
      continue;
    }
    try {
      const body = read(abs);
      if (pattern && !pattern.test(body)) {
        checks.push({ artifact: rel, status: 'FAIL', reason: 'artifact content does not match expected marker' });
        continue;
      }
      checks.push({ artifact: rel, status: 'OK', bytes: Buffer.byteLength(body) });
    } catch (err) {
      checks.push({ artifact: rel, status: 'FAIL', reason: `unreadable (${err.message})` });
    }
  }
  return { ok: checks.every((c) => c.status === 'OK'), checks };
}

/* ------------------------------------------------------------------ *
 * Baseline comparison (READ-ONLY)
 * ------------------------------------------------------------------ */

/** List previous eval-cycle JSON reports, newest name last (names are timestamped). */
export function listPreviousReports({ root = ROOT, readdir = (d) => fs.readdirSync(d), dir: dirArg = 'docs/eval' } = {}) {
  const dir = path.isAbsolute(dirArg) ? dirArg : path.join(root, dirArg);
  let names = [];
  try { names = readdir(dir); } catch { return []; }
  return names
    .filter((n) => /^eval-cycle-.*\.json$/.test(n))
    .sort()
    .map((n) => ({ name: n, path: path.join(dirArg, n).replace(/\\/g, '/') }));
}

/**
 * Compare the current signature against baseline sources WITHOUT writing them.
 *
 * Sources, in priority order:
 *   1. frozen `explore/baselines/l1-online-gap.json` (readOnly baseline, if any);
 *   2. frozen `explore/baselines/l1-smoke.json` (L1 metrics + thresholds);
 *   3. most recent previous `docs/eval/eval-cycle-*.json` report (continuous
 *      iteration baseline — the previous run's signature).
 *
 * Classification:
 *   - no readable baseline with a comparable signature => `NO_BASELINE`;
 *   - signature differs from any comparable baseline => `DRIFT`;
 *   - identical => `STABLE`.
 * DRIFT and NO_BASELINE are informational: they never make a cycle fail.
 */
export function evaluateBaseline({
  signature,
  reportDir = 'docs/eval',
  root = ROOT,
  exists = (p) => fs.existsSync(p),
  read = (p) => JSON.parse(fs.readFileSync(p, 'utf8')),
  readdir = (d) => fs.readdirSync(d),
  now = () => new Date().toISOString(),
} = {}) {
  const sources = [];
  const abs = (rel) => (path.isAbsolute(rel) ? rel : path.join(root, rel));
  const trySource = (rel, extract, comparable) => {
    if (!exists(abs(rel))) return;
    try {
      const doc = read(abs(rel));
      const value = extract(doc);
      if (value === null || value === undefined) return;
      sources.push({
        source: rel,
        readOnly: true,
        signature: value,
        // A frozen L1 metrics snapshot has a DIFFERENT schema from a cycle
        // signature; treating that as DRIFT would make the label permanent and
        // meaningless. It is read and recorded as REFERENCE only.
        comparable: typeof comparable === 'function' ? comparable(doc) : comparable,
        status: (typeof comparable === 'function' ? comparable(doc) : comparable)
          ? (canonical(value) === canonical(signature) ? 'STABLE' : 'DRIFT')
          : 'REFERENCE',
      });
    } catch { /* unreadable baseline is treated as absent, never as a pass */ }
  };
  // Frozen baselines are read for provenance. They become a comparable
  // baseline only if they explicitly carry an eval-cycle signature.
  trySource(DEFAULT_FILES.onlineGapBaseline, (doc) => {
    if (doc?.readOnly !== true) return null;
    if (doc?.signature !== undefined) return doc.signature;
    const value = { identity: doc.identity ?? null, metrics: doc.metrics ?? null };
    return (value.identity === null && value.metrics === null) ? null : value;
  }, (doc) => doc?.signature !== undefined);
  trySource(DEFAULT_FILES.l1Baseline, (doc) => {
    if (doc?.signature !== undefined) return doc.signature;
    const value = { metrics: doc?.metrics ?? null, thresholds: doc?.thresholds ?? null };
    return (value.metrics === null && value.thresholds === null) ? null : value;
  }, (doc) => doc?.signature !== undefined);
  for (const prev of listPreviousReports({ root, readdir, dir: reportDir }).slice(-1)) {
    trySource(prev.path, (doc) => (doc?.signature ?? null), true);
  }

  const comparable = sources.filter((s) => s.comparable);
  const drift = comparable.filter((s) => s.status === 'DRIFT');
  const status = drift.length ? 'DRIFT' : (comparable.length ? 'STABLE' : 'NO_BASELINE');
  return {
    status,
    sources,
    driftSources: drift.map((s) => s.source),
    noBaselineReason: comparable.length
      ? null
      : 'no frozen baseline with a comparable eval-cycle signature and no previous eval-cycle report (frozen L1 metrics are recorded as REFERENCE only)',
    readOnly: true,
    neverWritten: true,
    checkedAt: now(),
  };
}

/* ------------------------------------------------------------------ *
 * Cycle execution
 * ------------------------------------------------------------------ */

/** Deterministic fake L1 + online-gap profile (pure; no artifact writes). */
export function runFakeL1({ tasks, skips, baseline = null } = {}) {
  const l1 = fakeMetrics(tasks);
  // Reuse the frozen profile helpers but do NOT call runOnlineGapProfile():
  // that writes fixed paths (docs/eval/l1-online-gap*.json|md). This cycle
  // owns its own timestamped artifacts only.
  const metrics = computeOnlineGapMetrics(tasks, []);
  const comparison = baseline ? compareOnlineGapCurrent({ perTask: [] }, baseline, tasks)
    : { ok: false, checks: [], allUnknown: true };
  return {
    mode: 'fake-dry-run',
    profile: 'online-gap',
    note: 'Deterministic wiring check only; NOT a gateway quality measurement.',
    l1,
    taskCount: tasks.length,
    skips,
    gapMetrics: metrics,
    baseline: baseline ? ONLINE_GAP_BASELINE_FILE : null,
    comparison,
    unknownIsPass: false,
    ok: l1.tasks === tasks.length,
  };
}

/** Deterministic offline replay of the fake online-session fixture. */
export async function runReplayFixture({ sessionFactory = createFakeSession } = {}) {
  const session = sessionFactory();
  const plan = buildReplayPlan(session);
  const output = await replayPlan(plan, {});
  const diff = diffReplay(plan, output, { recorded: session });
  // A `diff` verdict is EXPECTED here: the recorded result comes from a fake
  // fixture, while replay uses a deterministic offline stub. It is evidence,
  // not a gate failure. `ok` verifies harness integrity only: the plan ran,
  // no write was attempted for real, and the verdict is a known value.
  return {
    source: session.source,
    fixtureSeed: session.fixtureSeed ?? null,
    requestIds: session.requestIds,
    steps: plan.steps.length,
    verdict: diff.verdict,
    counts: diff.counts,
    notComparableNote: diff.notComparableNote,
    diffIsInformational: true,
    ok: plan.steps.length > 0
      && ['pass', 'diff', 'partial', 'not-comparable'].includes(diff.verdict)
      && !output.steps.some((s) => s.realWriteAttempted),
  };
}

/** Build the full report object (pure except for optional injected clock). */
export async function buildReport({
  opts,
  join,
  docs,
  fake,
  replay,
  baseline,
  signature,
} = {}) {
  const failures = [];
  if (!join.ok) failures.push(...join.findings.filter((f) => f.level === 'FAIL').map((f) => `join:${f.id}`));
  if (!docs.ok) failures.push(...docs.checks.filter((c) => c.status === 'FAIL').map((c) => `docs:${c.artifact}`));
  if (!fake.ok) failures.push('fake-l1');
  if (!replay.ok) failures.push('replay-fixture');

  return {
    schema: SCHEMA,
    generatedAt: opts.now,
    tag: opts.tag,
    cycle: 'online ↔ semi-online continuous eval',
    advisoryOnly: true,
    requiresHumanReview: true,
    offline: true,
    noProductionWrites: true,
    networkCalls: 0,
    ok: failures.length === 0,
    failures,
    baselineStatus: baseline.status,
    baselineExplicit: true,
    baselineNote: baseline.status === 'NO_BASELINE'
      ? 'NO_BASELINE: no frozen baseline/previous report; not a failure, but no drift claim is possible.'
      : (baseline.status === 'DRIFT' ? `DRIFT: ${baseline.driftSources.join(', ')}; not a failure by policy, review required.` : 'STABLE: signature matches a baseline source.'),
    signature,
    baseline,
    checks: {
      fakeL1: fake,
      replay,
      joinCoverage: join,
      docs,
    },
    policy: [
      'unknown / SKIP / missing task id is never a pass',
      'DRIFT and NO_BASELINE are explicit but do not fail the cycle',
      'baselines are read-only; never auto-updated by a cycle',
      'no timers, no network, no production writes, no commit/push/deploy',
    ],
  };
}

/** Render a compact human-readable markdown report from a built report. */
export function renderMarkdown(report) {
  const c = report.checks ?? {};
  const lines = [
    `# Continuous Eval Cycle — ${report.generatedAt}`,
    '',
    `- Schema: \`${report.schema}\`${report.tag ? ` — tag \`${report.tag}\`` : ''}`,
    `- Result: **${report.ok ? 'PASS' : 'FAIL'}**`,
    `- Baseline: **${report.baselineStatus}** (${report.baselineNote})`,
    `- Signature: \`${report.signature ?? '—'}\``,
    `- Offline: ${report.offline} | Production writes: ${report.noProductionWrites} | Network calls: ${report.networkCalls}`,
    '',
    '## Stage results',
    '',
    '| Stage | Status | Detail |',
    '|---|---|---|',
    `| L1 fake + online-gap profile | ${c.fakeL1?.ok ? 'PASS' : 'FAIL'} | tasks=${c.fakeL1?.taskCount ?? 0}, skips=${c.fakeL1?.skips?.length ?? 0}, gap metrics computed=${Object.keys(c.fakeL1?.gapMetrics?.perTask ?? {}).length} |`,
    `| Replay fixture | ${c.replay?.ok ? 'PASS' : 'FAIL'} | verdict=${c.replay?.verdict ?? '—'}, steps=${c.replay?.steps ?? 0}, pass/diff/not-comparable=${JSON.stringify(c.replay?.counts ?? {})} |`,
    `| Join coverage | ${c.joinCoverage?.ok ? 'PASS' : 'FAIL'} | F rows=${c.joinCoverage?.fRows?.length ?? 0}, findings=${c.joinCoverage?.findings?.length ?? 0} |`,
    `| Docs artifacts | ${c.docs?.ok ? 'PASS' : 'FAIL'} | checked=${c.docs?.checks?.length ?? 0} |`,
    '',
    '## F1–F6 join coverage',
    '',
    '| Feedback | State (as documented) |',
    '|---|---|',
  ];
  for (const row of (c.joinCoverage?.fRows ?? [])) {
    lines.push(`| ${row.id} | ${row.allStates.join(' + ') || 'unknown'} |`);
  }
  lines.push('', '## Findings', '');
  if (!c.joinCoverage?.findings?.length) lines.push('- (none)');
  for (const finding of (c.joinCoverage?.findings ?? [])) {
    lines.push(`- [${finding.level}] ${finding.id}: ${finding.detail}`);
  }
  lines.push('', '## Baseline sources (read-only)', '');
  if (!(report.baseline?.sources?.length)) lines.push('- (none)');
  for (const s of (report.baseline?.sources ?? [])) {
    lines.push(`- \`${s.source}\`: ${s.status}`);
  }
  if (report.failures?.length) {
    lines.push('', '## Failures', '', ...report.failures.map((f) => `- ${f}`));
  }
  lines.push('', '> Advisory only. Fake/replay wiring checks are NOT gateway quality measurements. Online feedback stays a hypothesis until human review and post-deploy replay. No commit / push / deploy.', '');
  return lines.join('\n');
}

/** Artifact name: timestamped, unique, no overwrite. */
export function artifactNames(now, tag = null) {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  const suffix = tag ? `-${String(tag).replace(/[^a-zA-Z0-9_-]/g, '_')}` : '';
  return {
    json: `eval-cycle-${stamp}${suffix}.json`,
    md: `eval-cycle-${stamp}${suffix}.md`,
  };
}

/**
 * Full cycle: audit → fake → replay → baseline → write artifacts.
 * All filesystem writes use `wx` (exclusive create) and only to outDir.
 */
export async function runCycle({
  opts,
  root = ROOT,
  read = (p) => fs.readFileSync(p, 'utf8'),
  exists = (p) => fs.existsSync(p),
  writeFile = (p, data) => fsp.writeFile(p, data, { flag: 'wx' }),
  mkdir = (p) => fsp.mkdir(p, { recursive: true }),
  sessionFactory = createFakeSession,
  baselineFile = ONLINE_GAP_BASELINE_FILE,
} = {}) {
  const join = auditJoinCoverage({ root, read, exists });
  const docs = auditDocs({ root, read, exists });

  // Load the N1–N9 / J1–J6 task sets through the frozen online-gap loader.
  const glob = (rel) => {
    const abs = path.isAbsolute(rel) ? rel : path.join(root, rel);
    return exists(abs) ? JSON.parse(read(abs)) : { tasks: [] };
  };
  const nTaskIds = (glob(DEFAULT_FILES.nTasks).tasks ?? []).map((t) => t.id);
  const jTaskIds = (glob(DEFAULT_FILES.jTasks).tasks ?? []).map((t) => t.id);
  const loadFor = (rel, expectedIds) => {
    const doc = glob(rel);
    const tasks = (doc.tasks ?? []).filter((t) => expectedIds.includes(t.id));
    const skips = expectedIds.filter((id) => !tasks.some((t) => t.id === id))
      .map((id) => ({ id, reason: 'SKIP: task not loaded (unknown, never a pass)', kind: 'missing-task' }));
    return { tasks, skips };
  };
  const nLoaded = loadFor(DEFAULT_FILES.nTasks, N_IDS);
  const jLoaded = loadFor(DEFAULT_FILES.jTasks, J_IDS);

  // The frozen online-gap baseline is READ-ONLY. loadOnlineGapBaseline() returns
  // null when absent (current checkout) — that is NO_BASELINE, never a pass.
  let frozenBaseline = null;
  try {
    const abs = path.isAbsolute(baselineFile) ? baselineFile : path.join(root, baselineFile);
    if (exists(abs)) frozenBaseline = loadOnlineGapBaseline(abs);
  } catch { frozenBaseline = null; }

  const fake = runFakeL1({
    tasks: [...nLoaded.tasks, ...jLoaded.tasks],
    skips: [...nLoaded.skips, ...jLoaded.skips],
    baseline: frozenBaseline,
  });
  const replay = await runReplayFixture({ sessionFactory });

  const signature = stableHash({
    schema: SCHEMA,
    join: join.fRows.map((r) => ({ id: r.id, states: r.allStates })),
    findings: join.findings.filter((f) => f.level === 'FAIL').map((f) => f.id).sort(),
    nTaskIds: [...nTaskIds].sort(),
    jTaskIds: [...jTaskIds].sort(),
    fake: { taskCount: fake.taskCount, l1: fake.l1, skipIds: fake.skips.map((s) => s.id) },
    replay: { verdict: replay.verdict, counts: replay.counts },
  });
  const baseline = evaluateBaseline({
    signature,
    root,
    reportDir: opts.reportDir ?? opts.outDir,
    exists,
    read: (p) => JSON.parse(read(p)),
    readdir: (d) => fs.readdirSync(d),
    now: () => opts.now,
  });
  const report = await buildReport({ opts, join, docs, fake, replay, baseline, signature });

  const outDir = path.isAbsolute(opts.outDir) ? opts.outDir : path.join(root, opts.outDir);
  await mkdir(outDir);
  const names = artifactNames(opts.now, opts.tag);
  const jsonPath = path.join(outDir, names.json);
  const mdPath = path.join(outDir, names.md);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(mdPath, renderMarkdown(report));
  return {
    report,
    paths: {
      json: path.relative(root, jsonPath),
      md: path.relative(root, mdPath),
    },
  };
}

export function helpText() {
  return [
    'Usage: node scripts/eval-cycle.mjs [--out-dir DIR] [--report-dir DIR] [--now ISO] [--tag TAG]',
    '',
    'Runs the offline, repeatable online↔semi-online eval cycle and writes',
    'timestamped docs/eval/eval-cycle-*.json|md reports (never overwrites).',
    'Exit 0 when no check fails; DRIFT/NO_BASELINE are explicit non-failures.',
  ].join('\n');
}

export async function main(argv = process.argv.slice(2)) {
  let opts;
  try { opts = parseArgs(argv); } catch (err) {
    process.stderr.write(`[eval-cycle] ${err.message}\n`);
    return 2;
  }
  if (opts.help) {
    process.stdout.write(`${helpText()}\n`);
    return 0;
  }
  try {
    const { report, paths } = await runCycle({ opts });
    process.stdout.write(`[eval-cycle] ${report.ok ? 'PASS' : 'FAIL'} | baseline=${report.baselineStatus} | signature=${report.signature}\n`);
    process.stdout.write(`[eval-cycle] json: ${paths.json}\n[eval-cycle] md: ${paths.md}\n`);
    if (report.baselineStatus !== 'STABLE') process.stdout.write(`[eval-cycle] ${report.baselineNote}\n`);
    for (const failure of report.failures) process.stderr.write(`[eval-cycle] FAIL ${failure}\n`);
    return report.ok ? 0 : 1;
  } catch (err) {
    process.stderr.write(`[eval-cycle] failed: ${err?.message ?? err}\n`);
    return 1;
  }
}

const isMain = typeof process.argv[1] === 'string'
  && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  process.exit(await main());
}
