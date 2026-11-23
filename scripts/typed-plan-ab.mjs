#!/usr/bin/env node
/**
 * typed-plan-ab.mjs — offline A/B runner skeleton for typed-plan / Code Mode.
 *
 * Batch 14. This file is a *test harness skeleton*, not production code:
 *   - Profile F = v1 free Code Mode (`search` + `execute_read`/`execute` code);
 *   - Profile S = v2 typed plan (`plan:[...]`) plus observable code fallback.
 *
 * Hard boundaries (docs/eval/TYPED-PLAN-TEST-PLAN.md §0.2 / §6.1):
 *   - NO network, NO credentials, NO real writes, NO model calls by default.
 *     The only way to obtain data from a real model is to inject an adapter via
 *     `options.model` (an injection point only — this module never imports an
 *     HTTP client and never calls the network stack).
 *   - Default adapters are deterministic fakes/replays; the same input always
 *     produces the same output (no Date.now/Math.random in the data path).
 *   - F and S share the same task objects and prompts verbatim.
 *
 * Exports (importable, side-effect free unless invoked as CLI):
 *   PROFILES, GATE_IDS, ERROR_CLASSES, FALLBACK_REASONS
 *   loadTaskSet(pathOrArray), createFakeModel(), createFakeIO(),
 *   classifyError(signal), computeMetrics(trace), runTask(profile, task, opts),
 *   runAB(tasks, opts), summarize(runs, opts), evaluateGates(summary, opts),
 *   renderMarkdown(report), renderJson(report), writeReport(report, dir, name),
 *   parseArgs(argv), main(argv)
 *
 * No commit / push / deploy. Does not modify src/ or any other file except the
 * two explicit report files when `writeReport` is called by the CLI.
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { OP_REGISTRY, executePlan, createFakeIO } from './typed-plan-spike.mjs';

/** The two A/B profiles and the invariant tool face (same for both). */
export const PROFILES = Object.freeze({
  F: Object.freeze({ id: 'F', protocolVersion: 'v1', inputMode: 'code' }),
  S: Object.freeze({ id: 'S', protocolVersion: 'v2', inputMode: 'plan+fallback' }),
});
export const TOOL_FACE = Object.freeze(['search', 'execute_read', 'execute']);

/** Eight mutually exclusive error classes from TYPED-PLAN-TEST-PLAN.md §5. */
export const ERROR_CLASSES = Object.freeze(['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'E8']);
/** Fallback reasons from §1.2 (S only). Null means no fallback happened. */
export const FALLBACK_REASONS = Object.freeze([1, 2, 3, 4]);
export const GATE_IDS = Object.freeze(['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7']);

/** Gate statuses. NOT_ENOUGH is never coerced into a pass or a default switch. */
export const GATE_STATUS = Object.freeze({
  PASS: 'PASS',
  FAIL: 'FAIL',
  NOT_ENOUGH: 'NOT_ENOUGH',
  NO_MEASUREMENT: 'NO_MEASUREMENT',
});

/** Decision values for the overall A/B verdict. NEVER "SWITCH" from this skeleton. */
export const DECISION = Object.freeze({
  KEEP_F: 'KEEP_F',
  INSUFFICIENT: 'INSUFFICIENT',
  BLOCKED: 'BLOCKED',
});

// ---------------------------------------------------------------------------
// Task set loading
// ---------------------------------------------------------------------------

/**
 * Load a task set from a JSON file or pass through an array.
 * Accepts either a bare array or `{tasks:[...]}` (tasks-online-gap.json shape).
 * The task prompt is never rewritten: F and S receive the identical object.
 */
export function loadTaskSet(source) {
  if (Array.isArray(source)) return source.map((t) => ({ ...t }));
  if (typeof source !== 'string') throw new TypeError('loadTaskSet: expected path or array');
  const parsed = JSON.parse(fs.readFileSync(source, 'utf8'));
  const tasks = Array.isArray(parsed) ? parsed : parsed.tasks;
  if (!Array.isArray(tasks)) throw new TypeError(`loadTaskSet: no tasks array in ${source}`);
  return tasks.map((t) => ({ ...t }));
}

// ---------------------------------------------------------------------------
// Adapters: fake model + fake IO. Both are deterministic and offline.
// ---------------------------------------------------------------------------

/**
 * Deterministic fake "model" adapter. It decides which operations a task needs
 * from the task's `expectedTools` / `expectedOps` fields — no language model is
 * involved. Each decision is a plain object:
 *
 *   { kind: 'code'|'plan', codeOps: [...], plan: [...], searchHits: [...],
 *     tokens: {input, output}, wallMs: <number>, errors: [{code, message}],
 *     fallback: null | {reason, attemptPlan, atStep}, steps: [...] }
 *
 * A REAL model adapter only needs to implement `decide(profile, task, ctx)` and
 * return this shape; the runner itself never opens a socket. Any adapter that
 * attempts network I/O must be supplied by the caller (injection point only).
 *
 * Task fields understood by the fake (all optional except id):
 *   expectedTools / expectedOps   source of "intended" tool names
 *   fakeErrors: [{code,message}]  injected tool errors -> repair + errorClass
 *   fakeTokens: {input,output}    deterministic token accounting
 *   fakeWallMs: number            deterministic per-task latency
 *   fakeFallback: {reason,...}    force an S fallback (TP-10 / F155 style)
 *   fakeComplex: boolean          S fallback reason 1 (expression not in registry)
 *   fakeMissingOp: boolean        S fallback reason 2 (op not in registry)
 *   fakeSearchMiss: boolean       make searchHit false
 *   fakeWrite: boolean            task involves a write -> write replay checked
 *   fakeTruncated: boolean        E8 signal
 *   fakeNoCompletion: boolean     E7 signal (max turns)
 *   fakePlanErrors: number        count of plan validation attempts (reason 3)
 *   fakeExplicitCode: boolean     reason 4 (model declares fallback up front)
 */
/**
 * Conservative tool->spike-op aliases used ONLY by the fake adapter. A real
 * adapter maps its own tools; these aliases let the offline fixture exercise
 * the typed path for the N1–N9 upstream tool names without pretending the
 * spike registry has one-to-one coverage.
 */
const FAKE_TOOL_ALIASES = Object.freeze({
  get_file_contents: 'readFileRange',
  list_commits: 'repoGrep',
  get_commit: 'repoGrep',
  get_me: 'repoGrep',
  list_branches: 'repoGrep',
  pull_request_read: 'repoGrep',
  merge_pull_request: 'openPr',
  create_or_update_file: 'applyPatch',
  push_files: 'applyPatch',
  search: 'repoGrep',
  execute_read: 'readFileRange',
});

const fakeOpName = (name) => {
  const bare = String(name).split('__').pop();
  return FAKE_TOOL_ALIASES[bare] || bare;
};

/**
 * Build a deterministic default plan for the fake S adapter from a task's
 * declared ops. Only registry ops are emitted (op names outside the registry
 * are a fallback signal, not an executable step); arg values are stable and
 * chosen to pass validatePlan, including the write-op authorization gate.
 */
function defaultPlanForTask(task) {
  const declared = [...(task.expectedOps || []), ...(task.expectedTools || [])].map(fakeOpName);
  const samples = {
    readFileRange: { op: 'readFileRange', path: 'example.txt', startLine: 1, endLine: 3 },
    repoGrep: { op: 'repoGrep', pattern: String(task.id || 'task') },
    runChecks: { op: 'runChecks', command: 'npm test' },
    ensureBranch: { op: 'ensureBranch', owner: 'o', repo: 'r', branch: 'tp/replay', approve: true },
    applyPatch: { op: 'applyPatch', path: 'example.txt', patch: '@@ -2,1 +2,1 @@\n-two\n+TWO\n', approve: true },
    openPr: { op: 'openPr', owner: 'o', repo: 'r', head: 'tp/replay', base: 'main', title: 'tp', approve: true },
  };
  const plan = [];
  for (const name of declared) {
    const key = fakeOpName(name);
    if (Object.hasOwn(OP_REGISTRY, key) && samples[key] && !plan.some((s) => s.op === key)) {
      plan.push({ ...samples[key] });
    }
  }
  if (plan.length === 0) plan.push({ ...samples.repoGrep });
  return plan;
}

export function createFakeModel(overrides = {}) {
  const defaults = {
    decide(profile, task) {
      const tools = Array.isArray(task.expectedTools) ? task.expectedTools : [];
      const ops = Array.isArray(task.expectedOps) ? task.expectedOps : [];
      const errors = Array.isArray(task.fakeErrors)
        ? task.fakeErrors.map((e) => ({ ...e }))
        : [];
      const tokens = task.fakeTokens || { input: 100, output: 40 };
      const plan = Array.isArray(task.fakePlan) ? task.fakePlan.map((s) => ({ ...s }))
        : defaultPlanForTask(task);
      const searchHits = task.fakeSearchMiss
        ? []
        : (tools.length ? [tools[0]] : []);
      // Registry expressiveness check: declared ops that are not spike ops
      // cannot be typed -> fallback reason 2 (§1.2 condition 2).
      const declared = [...ops, ...tools].map(fakeOpName);
      const unexpressible = !task.fakePlan
        && declared.some((name) => !Object.hasOwn(OP_REGISTRY, String(name)));
      const fallback = profile !== 'S' ? null : (task.fakeFallback
        ? { ...task.fakeFallback }
        : (task.fakeComplex ? { reason: 1, attemptPlan: true, atStep: 0 }
          : (task.fakeMissingOp || unexpressible) ? { reason: 2, attemptPlan: true, atStep: 0 }
            : (task.fakePlanErrors >= 2 ? { reason: 3, attemptPlan: true, atStep: null }
              : task.fakeExplicitCode ? { reason: 4, attemptPlan: false, atStep: 0 }
                : null)));
      return {
        kind: profile === 'S' && fallback ? 'code' : (profile === 'S' ? 'plan' : 'code'),
        codeOps: tools.slice(),
        plan: plan.slice(),
        searchHits,
        tokens: { input: tokens.input, output: tokens.output },
        wallMs: task.fakeWallMs ?? 12,
        errors,
        fallback,
        steps: plan.slice(),
        // One repair per injected error; plan-level retries also count (§4).
        repairHints: errors.length + (task.fakePlanErrors || 0),
      };
    },
  };
  return { ...defaults, ...overrides };
}

/** Reuse the spike's deterministic fake IO, with per-task overrides. */
export function createFakeIOForTask(task = {}, base = {}) {
  const files = { ...(base.files || { 'example.txt': 'one\ntwo\nthree\n' }), ...(task.fakeFiles || {}) };
  return createFakeIO({ ...base, files, ...(task.fakeIO || {}) });
}

// ---------------------------------------------------------------------------
// Error classification (§5, eight mutually exclusive classes)
// ---------------------------------------------------------------------------

/**
 * Classify a single error signal to E1–E8.
 * Classification is keyword based and deterministic; returns null for an
 * unrecognized signal so callers can mark it `unverified` (AGENTS.md hard rule:
 * model suggestions are hypotheses, not facts).
 */
export function classifyError(signal) {
  const raw = signal && (signal.message || signal.code || signal);
  const s = String(raw ?? '').toLowerCase();
  if (!s) return null;
  if (/max_turns_exceeded|gave up|无法完成|no further tool call|abandon/.test(s)) return 'E7';
  if (/truncat|response cap|silent prefix|--- truncated ---/.test(s)) return 'E8';
  if (/business plan|permission|scope|readonly|read-only|requires approval|forbidden/.test(s)) return 'E5';
  if (/unknown tool|notarealtool|unknown op|not in registry/.test(s)) return 'E3';
  if (/patch|hunk|anchor|context mismatch|did not match/.test(s)) return 'E4';
  if (/invalid option|validation|schema|must be|required arg|type mismatch/.test(s)) return 'E2';
  if (/5\d\d|timeout|upstream|failedserver|connect fail|econnreset/.test(s)) return 'E6';
  if (/no (tool )?match|empty result|search|select:/.test(s)) return 'E1';
  return null;
}

// ---------------------------------------------------------------------------
// Metrics (§4). All values are numbers/booleans/null — JSON stable.
// ---------------------------------------------------------------------------

const p95 = (values) => {
  const xs = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  // Nearest-rank definition; deterministic and sample-size independent.
  return xs[Math.max(0, Math.ceil(0.95 * xs.length) - 1)];
};

/** True when a name matches an expected op/tool by bare or server__tool form. */
const nameMatches = (name, expected) => {
  const norm = (v) => String(v).toLowerCase().replace(/^codemode\./, '').split('__').pop();
  // Exact bare-name match only: alias equivalence belongs in the adapter's
  // op mapping, not in the metric (aliases would make distinct tools collapse).
  return norm(name) === norm(expected);
};

/**
 * Compute the per-task metric vector from a single profile trace.
 * Trace shape: { profile, taskId, decision, searchHits, executedOps,
 *                tokens, wallMs, errors, fallback, writeReplaySteps, meta }
 */
export function computeMetrics(trace) {
  const expectedTools = Array.isArray(trace.expectedTools) ? trace.expectedTools : [];
  const expectedOps = Array.isArray(trace.expectedOps) ? trace.expectedOps : [];
  // F traces carry upstream tool names, S traces carry registry op names
  // (TYPED-PLAN-TEST-PLAN.md §3.4): accept full coverage of either set.
  const executed = Array.isArray(trace.executedOps) ? trace.executedOps.map(String) : [];
  const searchHits = Array.isArray(trace.searchHits) ? trace.searchHits.map(String) : [];
  const covers = (set) => set.length > 0 && set.every((e) => executed.some((op) => nameMatches(op, e)));
  const toolHit = expectedTools.length === 0 && expectedOps.length === 0
    ? null
    : covers(expectedTools) || covers(expectedOps);
  const anyExpected = [...expectedTools, ...expectedOps];
  const searchHit = anyExpected.length === 0
    ? null
    : searchHits.some((hit) => anyExpected.some((e) => nameMatches(hit, e)));

  // completion = anomaly proxy: no runner_error / max_turns_exceeded.
  const classified = (trace.errors || []).map(classifyError);
  const hasE7 = classified.includes('E7');
  const runnerError = (trace.errors || []).some((e) => {
    const text = e && typeof e === 'object'
      ? `${e.code ?? ''} ${e.message ?? ''}`
      : String(e);
    return /runner_error|internal error/i.test(text);
  });
  const completion = !hasE7 && !runnerError;

  // Primary error class = first error that blocks the task (§5), else null.
  const errorClass = classified.find((c) => c !== null && c !== 'E7') ?? (hasE7 ? 'E7' : null);
  const unverified = classified.some((c) => c === null);

  // Repair = injected errors + plan/schema retries (counted in decision.repairHints).
  const repair = (trace.errors || []).length + (trace.planRetries || 0);

  // Write replay: dryRun -> real write -> verify, all present when task is a write.
  const steps = Array.isArray(trace.writeReplaySteps) ? trace.writeReplaySteps.map(String) : [];
  const writeReplay = trace.isWrite
    ? (steps.includes('dryRun') && steps.includes('write') && steps.includes('verify'))
    : null; // null = not applicable; excluded from the write-replay denominator

  const tokensIn = Number(trace.tokens?.input) || 0;
  const tokensOut = Number(trace.tokens?.output) || 0;
  return {
    taskId: trace.taskId,
    profile: trace.profile,
    completion,
    toolHit,
    searchHit,
    repair,
    tokens: tokensIn + tokensOut,
    wallMs: Number(trace.wallMs) || 0,
    writeReplay,
    errorClass,
    unverified,
    fallback: trace.fallback ? { ...trace.fallback } : null,
  };
}

// ---------------------------------------------------------------------------
// Runner: one task, one profile
// ---------------------------------------------------------------------------

/**
 * Run a single (task, profile) pair. All I/O goes through injected adapters.
 * `options.model` and `options.io` are the ONLY external injection points;
 * defaults are the deterministic offline fakes. No fetch, no HTTP import.
 */
export async function runTask(profile, task, options = {}) {
  const p = PROFILES[profile];
  if (!p) throw new TypeError(`runTask: unknown profile ${profile}`);
  const model = options.model || createFakeModel();
  const io = options.io || createFakeIOForTask(task, options.baseIO);
  const decision = await model.decide(p.id, task, { io, profile: p });
  if (!decision || typeof decision !== 'object') {
    throw new TypeError('model adapter must return a decision object');
  }

  const executedOps = [];
  const writeReplaySteps = [];
  const errors = Array.isArray(decision.errors) ? decision.errors.map((e) => ({ ...e })) : [];
  let execution = null;

  if (p.id === 'S' && decision.kind === 'plan') {
    // Typed path: use the spike's validate + execute, with injected fake IO.
    // Write ops are dryRun by default; real writes require explicit approval.
    const plan = Array.isArray(decision.plan) ? decision.plan : [];
    const dryRun = task.forRealWrite === true ? false : true;
    const approve = task.forRealWrite === true ? (task.fakeApprove || []) : [];
    execution = await executePlan(plan, { dryRun, approve, io });
    for (const step of execution.steps) {
      executedOps.push(step.op);
      if (!step.ok && step.error) errors.push({ code: 'PLAN_STEP', message: step.error });
      if (step.op === 'applyPatch' || step.op === 'ensureBranch' || step.op === 'openPr') {
        writeReplaySteps.push(step.result?.dryRun ? 'dryRun' : 'write');
      }
    }
  } else {
    // Code path (F baseline, or S fallback): no JS evaluation here. The
    // adapter's declared ops are the observable trace, exactly as the plan
    // path's steps are. A real adapter would supply its own trace fields.
    for (const op of (decision.codeOps || [])) executedOps.push(String(op));
    if (Array.isArray(decision.writeReplaySteps)) writeReplaySteps.push(...decision.writeReplaySteps);
    if (task.fakeWrite && writeReplaySteps.length === 0) {
      writeReplaySteps.push('dryRun', 'write', 'verify');
    }
  }

  if (task.fakeTruncated) errors.push({ code: 'TRUNCATED', message: 'silent truncation' });
  if (task.fakeNoCompletion) errors.push({ code: 'MAX_TURNS', message: 'max_turns_exceeded' });

  const isWrite = task.fakeWrite === true || task.category === 'write' || task.forRealWrite === true;
  if (isWrite && writeReplaySteps.includes('write') && !writeReplaySteps.includes('verify')) {
    writeReplaySteps.push('verify');
  }

  const trace = {
    profile: p.id,
    taskId: task.id,
    taskName: task.name ?? null,
    protocolVersion: p.protocolVersion,
    expectedTools: task.expectedTools || [],
    expectedOps: task.expectedOps || [],
    decision: decision.kind,
    searchHits: decision.searchHits || [],
    executedOps,
    tokens: decision.tokens || { input: 0, output: 0 },
    wallMs: decision.wallMs ?? 0,
    errors,
    planRetries: decision.repairHints && decision.kind === 'plan'
      ? Math.max(0, decision.repairHints - errors.length)
      : 0,
    fallback: decision.fallback ? { ...decision.fallback } : null,
    writeReplaySteps,
    isWrite,
    execution: execution ? {
      ok: execution.ok,
      dryRun: execution.dryRun,
      steps: execution.steps.map((s) => ({ ok: s.ok, op: s.op, error: s.error ?? null })),
      stoppedAt: execution.stoppedAt,
      error: execution.error,
    } : null,
  };
  return { trace, metrics: computeMetrics(trace) };
}

/**
 * Paired A/B run over a full task set. Each (task, repeat) produces an F and
 * an S result with the SAME task object. Repeats alternate F→S / S→F but this
 * ordering has no effect on a deterministic fake; the field is kept for the
 * real adapter's benefit.
 */
export async function runAB(tasks, options = {}) {
  const repeats = options.repeats ?? 1;
  if (!Number.isInteger(repeats) || repeats < 1) throw new TypeError('repeats must be >= 1');
  const runs = [];
  for (let repeat = 1; repeat <= repeats; repeat += 1) {
    for (const task of tasks) {
      const order = repeat % 2 === 1 ? ['F', 'S'] : ['S', 'F'];
      const results = {};
      for (const profile of order) {
        results[profile] = await runTask(profile, task, options);
      }
      runs.push({
        taskId: task.id,
        repeat,
        order,
        F: results.F.metrics,
        S: results.S.metrics,
        traces: { F: results.F.trace, S: results.S.trace },
      });
    }
  }
  return { runs, repeats, taskCount: tasks.length, environment: options.environment || 'fake' };
}

// ---------------------------------------------------------------------------
// Aggregation + gate evaluation (§7)
// ---------------------------------------------------------------------------

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const rate = (values) => {
  const bools = values.filter((v) => typeof v === 'boolean');
  return bools.length ? bools.filter(Boolean).length / bools.length : null;
};

/** Aggregate per-metric statistics with explicit, never-borrowed denominators. */
export function summarize(runs) {
  const stat = (profile) => {
    const ms = runs.map((r) => r[profile]).filter(Boolean);
    const completion = rate(ms.map((m) => m.completion));
    const toolHit = rate(ms.map((m) => m.toolHit));
    const searchHit = rate(ms.map((m) => m.searchHit));
    const writeReplay = rate(ms.map((m) => m.writeReplay));
    return {
      tasks: ms.length,
      completion,
      toolHit,
      searchHit,
      repair: mean(ms.map((m) => m.repair)),
      tokens: mean(ms.map((m) => m.tokens)),
      p95: p95(ms.map((m) => m.wallMs)),
      writeReplay,
      fallbackRate: profile === 'S' ? rate(ms.map((m) => Boolean(m.fallback))) : null,
      errorClasses: ms.reduce((acc, m) => {
        if (m.errorClass) acc[m.errorClass] = (acc[m.errorClass] || 0) + 1;
        return acc;
      }, {}),
      unverified: ms.filter((m) => m.unverified).length,
    };
  };
  return { F: stat('F'), S: stat('S'), pairedDiff: {
    completion: (() => {
      const f = rate(runs.map((r) => r.F?.completion));
      const s = rate(runs.map((r) => r.S?.completion));
      return f === null || s === null ? null : s - f;
    })(),
    tokens: (() => {
      const f = mean(runs.map((r) => r.F?.tokens).filter(Number.isFinite));
      const s = mean(runs.map((r) => r.S?.tokens).filter(Number.isFinite));
      return f === null || s === null ? null : s - f;
    })(),
    repair: (() => {
      const f = mean(runs.map((r) => r.F?.repair).filter(Number.isFinite));
      const s = mean(runs.map((r) => r.S?.repair).filter(Number.isFinite));
      return f === null || s === null ? null : s - f;
    })(),
  } };
}

/**
 * Evaluate A1–A7. Requires ≥3 valid real repeats for a decision; fake/replay
 * runs are explicitly NOT enough. Insufficient data => NOT_ENOUGH, never PASS,
 * never an implicit switch to S.
 */
export function evaluateGates(summaryObj, meta = {}) {
  const env = meta.environment || 'fake';
  const repeats = meta.repeats ?? 1;
  const platform = meta.platform || 'unknown';
  const isReal = env === 'real';
  const enough = isReal && repeats >= 3 && platform === 'gemini';
  const conformance = meta.conformance || null; // { stable_tools_list, ... } booleans
  const baselineOk = meta.frozenBaseline === true && meta.baselineNotCurrent === true;
  const platformOk = platform === 'gemini' && meta.noCrossPlatformCompare === true;

  const gate = (id, ok, note) => ({
    id,
    status: !enough ? GATE_STATUS.NOT_ENOUGH : (ok ? GATE_STATUS.PASS : GATE_STATUS.FAIL),
    note,
  });
  const f = summaryObj.F;
  const s = summaryObj.S;
  const gates = [
    gate('A1', f.completion !== null && s.completion !== null
      && s.completion >= f.completion - 0.03, 'completion(S) >= completion(F) - 3pp'),
    gate('A2', f.tokens !== null && s.tokens !== null && s.tokens <= f.tokens,
      'tokens/task(S) <= tokens/task(F)'),
    gate('A3', f.repair !== null && s.repair !== null && s.repair <= 0.7 * f.repair,
      'repair/task(S) <= 0.7 * repair/task(F)'),
    gate('A4', f.writeReplay === null || s.writeReplay === null || s.writeReplay >= f.writeReplay,
      'write replay(S) >= write replay(F)'),
    gate('A5', baselineOk, 'frozen baseline, no baseline===current, no borrowed denominator'),
    gate('A6', platformOk, 'platform lanes independent; unknown not merged; no cross-lane hard compare'),
    gate('A7', conformance !== null && Object.values(conformance).every((v) => v === true),
      'four conformance checks pass on lanes with fixtures'),
  ];

  const allPass = gates.every((g) => g.status === GATE_STATUS.PASS);
  const decision = !enough
    ? DECISION.INSUFFICIENT
    : (allPass ? DECISION.KEEP_F : DECISION.BLOCKED);
  return {
    gates,
    decision,
    // Even with all gates passing, a default switch needs lead human review.
    defaultSwitchAllowed: false,
    note: !enough
      ? 'data not sufficient (>=3 real repeats on Gemini required); keeping F as default'
      : (allPass
        ? 'gates pass; still REQUIRES lead human review before any default switch'
        : 'one or more gates failed; keeping F as default'),
  };
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

/** Build the final report object (JSON-serializable, deterministic). */
export function buildReport(ab, meta = {}) {
  const summaryObj = summarize(ab.runs);
  const gates = evaluateGates(summaryObj, {
    environment: ab.environment,
    repeats: ab.repeats,
    platform: meta.platform,
    conformance: meta.conformance ?? null,
    frozenBaseline: meta.frozenBaseline ?? false,
    baselineNotCurrent: meta.baselineNotCurrent ?? false,
    noCrossPlatformCompare: meta.noCrossPlatformCompare ?? false,
  });
  return {
    schemaVersion: 1,
    kind: 'typed-plan-ab',
    meta: {
      environment: ab.environment,
      repeats: ab.repeats,
      taskCount: ab.taskCount,
      platform: meta.platform || 'unknown',
      profileF: PROFILES.F,
      profileS: PROFILES.S,
      toolFace: TOOL_FACE,
      note: 'fake/replay data is pipeline validation only, never quality evidence',
    },
    tasks: ab.runs.map((r) => ({
      taskId: r.taskId,
      repeat: r.repeat,
      order: r.order,
      F: r.F,
      S: r.S,
    })),
    summary: summaryObj,
    gates,
  };
}

/** Markdown rendering of a report (no timestamps, so it is deterministic). */
export function renderMarkdown(report) {
  const lines = [];
  lines.push('# Typed-plan / Code Mode A/B report');
  lines.push('');
  lines.push(`- environment: \`${report.meta.environment}\` (${report.meta.platform})`);
  lines.push(`- repeats: ${report.meta.repeats}, tasks: ${report.meta.taskCount}`);
  lines.push(`- profiles: F=${report.meta.profileF.protocolVersion}/${report.meta.profileF.inputMode}, `
    + `S=${report.meta.profileS.protocolVersion}/${report.meta.profileS.inputMode}`);
  lines.push('- fake/replay results are pipeline validation only, NOT quality evidence.');
  lines.push('');
  lines.push('## Aggregate');
  lines.push('');
  lines.push('| metric | F | S | paired diff |');
  lines.push('|---|---:|---:|---:|');
  const fmt = (v) => (v === null || v === undefined ? 'n/a' : (typeof v === 'number' ? v.toFixed(4) : String(v)));
  const rows = [
    ['completion', 'completion'],
    ['toolHit', 'toolHit'],
    ['searchHit', 'searchHit'],
    ['repair/task', 'repair'],
    ['tokens/task', 'tokens'],
    ['p95 wallMs', 'p95'],
    ['writeReplay', 'writeReplay'],
  ];
  for (const [label, key] of rows) {
    lines.push(`| ${label} | ${fmt(report.summary.F[key])} | ${fmt(report.summary.S[key])} | ${fmt(report.summary.pairedDiff[key])} |`);
  }
  lines.push(`| fallback rate (S) | n/a | ${fmt(report.summary.S.fallbackRate)} | n/a |`);
  lines.push('');
  lines.push('## Gates A1–A7');
  lines.push('');
  lines.push('| gate | status | note |');
  lines.push('|---|---|---|');
  for (const g of report.gates.gates) lines.push(`| ${g.id} | ${g.status} | ${g.note} |`);
  lines.push('');
  lines.push(`**Decision: ${report.gates.decision}**. ${report.gates.note}`);
  lines.push('');
  lines.push('Default switch allowed: `false` (lead human review required).');
  lines.push('');
  lines.push('## Per-task paired metrics');
  lines.push('');
  lines.push('| taskId | rep | F.completion | S.completion | F.toolHit | S.toolHit | '
    + 'F.searchHit | S.searchHit | F.repair | S.repair | F.tokens | S.tokens | '
    + 'F.writeReplay | S.writeReplay | errorClass(F/S) | fallback(S) |');
  lines.push('|---|---:|---|---|---|---|---|---|---|---:|---|---|---|---|');
  for (const t of report.tasks) {
    lines.push(`| ${t.taskId} | ${t.repeat} | ${t.F.completion} | ${t.S.completion} | `
      + `${fmt(t.F.toolHit)} | ${fmt(t.S.toolHit)} | ${fmt(t.F.searchHit)} | ${fmt(t.S.searchHit)} | `
      + `${t.F.repair} | ${t.S.repair} | ${t.F.tokens} | ${t.S.tokens} | `
      + `${fmt(t.F.writeReplay)} | ${fmt(t.S.writeReplay)} | `
      + `${t.F.errorClass || '-'}/${t.S.errorClass || '-'} | `
      + `${t.S.fallback ? `reason ${t.S.fallback.reason}` : '-'} |`);
  }
  lines.push('');
  return lines.join('\n');
}

/** JSON rendering is canonical (stable key order from buildReport). */
export function renderJson(report) {
  return `${JSON.stringify(report, null, 2)}\n`;
}

/** Write the two report files. Only called from CLI, never on import. */
export function writeReport(report, dir, baseName) {
  fs.mkdirSync(dir, { recursive: true });
  const jsonPath = path.join(dir, `${baseName}.json`);
  const mdPath = path.join(dir, `${baseName}.md`);
  fs.writeFileSync(jsonPath, renderJson(report), 'utf8');
  fs.writeFileSync(mdPath, renderMarkdown(report), 'utf8');
  return { jsonPath, mdPath };
}

// ---------------------------------------------------------------------------
// CLI (offline by default; --model-inject is a documented injection point)
// ---------------------------------------------------------------------------

export function parseArgs(argv = []) {
  const out = {
    tasks: 'explore/tasks-online-gap.json',
    repeats: 1,
    environment: 'fake',
    platform: 'gemini',
    outDir: 'docs/eval',
    baseName: 'typed-plan-ab',
    write: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--tasks') out.tasks = argv[++i];
    else if (a === '--repeats') out.repeats = Number(argv[++i]);
    else if (a === '--environment') out.environment = argv[++i];
    else if (a === '--platform') out.platform = argv[++i];
    else if (a === '--out-dir') out.outDir = argv[++i];
    else if (a === '--base-name') out.baseName = argv[++i];
    else if (a === '--write') out.write = true;
    else throw new Error(`unknown arg: ${a}`);
  }
  return out;
}

const HELP = `Usage: node scripts/typed-plan-ab.mjs [options]
  --tasks <file|inline-json>   task set (default explore/tasks-online-gap.json)
  --repeats <n>               repeats (default 1; >=3 real for a decision)
  --environment <fake|replay|real>   default fake (offline)
  --platform <name>           lane name (default gemini)
  --out-dir <dir>             report directory (default docs/eval)
  --base-name <name>          report file base (default typed-plan-ab)
  --write                     write JSON + markdown reports to disk
  --help                      show this help

A real model is NEVER called by this script. To use one, import runAB() and
pass options.model (an injected adapter implementing decide(profile, task, ctx)).
No network, no credentials, no commit/push/deploy.`;

export async function main(argv = []) {
  const args = parseArgs(argv);
  if (args.help) { console.log(HELP); return { report: null }; }
  let source = args.tasks;
  if (source.startsWith('[') || source.startsWith('{')) source = JSON.parse(source);
  const tasks = loadTaskSet(source);
  const ab = await runAB(tasks, { repeats: args.repeats, environment: args.environment });
  const report = buildReport(ab, {
    platform: args.platform,
    // A CLI invocation is not evidence of a frozen baseline or conformance;
    // these must be supplied programmatically by the caller with real data.
    frozenBaseline: false,
    baselineNotCurrent: false,
    noCrossPlatformCompare: false,
    conformance: null,
  });
  if (args.write) {
    const files = writeReport(report, args.outDir, args.baseName);
    console.log(`wrote ${files.jsonPath} and ${files.mdPath}`);
  } else {
    console.log(renderJson(report));
  }
  return { report };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
