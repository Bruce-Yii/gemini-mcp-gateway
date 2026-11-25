#!/usr/bin/env node
/**
 * Single-entry ACTIVE -> PASSIVE evaluation closure (AGENTS.md §3.1.0).
 *
 * Why: the closure loop kept being "completed" by skipping the free model —
 * `analyze-captures --dry-run` (or a failed call) plus a `match=likely`
 * comparison looked like a closed loop. This script makes the whole loop one
 * command, enforces a real free-model execution in code, and prints the
 * mandatory three-line closure checklist. There is no `--dry-run` here.
 *
 * Pipeline (any hard failure stops the chain and surfaces the reason):
 *   1. record-active-eval   -> verbatim raw text + active-eval.v1 JSON
 *   2. analyze-captures     -> REAL free-model call over the local incremental
 *                              store window (`--bundle`, therefore ZERO extra R2
 *                              GET); `analyzerRun.llmExecuted` must be true
 *   3. compare-active-passive -> closureStatus gate + missed split
 *   4. distill-r2-candidates  -> local candidate pool (ZERO extra R2 GET)
 *   5. stdout: three forced checklist lines (落库结果 / 同窗对照与 missed 分流 /
 *      反哺动作或明确阻塞原因)
 *
 * Usage:
 *   ANALYZER_BASE_URL=... ANALYZER_API_KEY=... \
 *   node scripts/run-active-closure.mjs \
 *     --active-input work/active-2026-11-25.json \
 *     --raw work/active-2026-11-25.txt \
 *     --last-minutes 60
 *   # or explicit same-window:
 *   node scripts/run-active-closure.mjs --active-input ... --raw ... \
 *     --since 2026-11-25T06:00:00Z --until 2026-11-25T06:20:00Z
 *   # only when the free model/R2 is genuinely blocked (still non-zero, never a pass):
 *   node scripts/run-active-closure.mjs ... --infra-blocked-reason "R2 限流，同窗数据不可用"
 *
 * Exit codes: 0 = green closure; 1 = ran but not green (missed/unmatched/
 * BLOCKED_INFRA/step failure); 2 = usage/config error.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { encodeEnvelopeBundle, readEnvelopeBundle } from './capture-digest.mjs';
import { CLOSURE_STATUS, analyzerRunOf } from './compare-active-passive.mjs';

export const CLOSURE_RUN_SCHEMA = 'active-closure-run.v1';
export const DEFAULT_STORE = 'work/capture-store';
export const DEFAULT_CANDIDATES = 'docs/eval/suites/candidates.json';
export const DEFAULT_OUT_DIR = 'docs/eval';
export const CHECKLIST_LABELS = Object.freeze([
  '落库结果',
  '同窗对照与 missed 分流',
  '反哺动作或明确阻塞原因',
]);

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const CAPTURED_OUTPUT_LIMIT = 4000;

const str = (value) => (typeof value === 'string' ? value : '');
const arr = (value) => (Array.isArray(value) ? value : []);

export const USAGE = `usage: run-active-closure.mjs --active-input <active.json> [--raw <verbatim.txt>]
  (--last-minutes <n> | --since <ISO> --until <ISO>)   # default: window.from/to of the active record
  [--store work/capture-store] [--bundle <envelopes.ndjson>]
  [--out-dir docs/eval] [--work-dir work/active-closure/<date>]
  [--candidates docs/eval/suites/candidates.json] [--candidates-out work/candidates-updated.json]
  [--report <path>] [--date <YYYY-MM-DD>] [--now <ISO>]
  [--infra-blocked-reason <reason>] [--json]

The free model is mandatory: ANALYZER_BASE_URL and ANALYZER_API_KEY must be set.
There is no --dry-run path here; the closure loop must execute the model.`;

/** Parse an ISO-ish timestamp; returns canonical ISO or null. */
function isoOf(value) {
  const text = str(value).trim();
  if (!text) return null;
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString();
}

/** Truncate captured subprocess output for the run report, with an explicit marker. */
function clipForReport(text, limit = CAPTURED_OUTPUT_LIMIT) {
  const value = String(text ?? '');
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}…[truncated ${value.length - limit}]`;
}

/**
 * Resolve the passive window. Priority: --last-minutes > --since/--until >
 * the active record's own `window.from/to`. Returns null when none is usable.
 */
export function resolveWindow(options = {}, activeInput = null, { now = () => new Date() } = {}) {
  const lastMinutes = Number(options.lastMinutes ?? 0);
  if (Number.isFinite(lastMinutes) && lastMinutes > 0) {
    const endValue = typeof now === 'function' ? now() : now;
    const end = endValue instanceof Date ? endValue : new Date(endValue);
    const endMs = Number.isNaN(end.getTime()) ? Date.now() : end.getTime();
    const start = new Date(endMs - Math.floor(lastMinutes) * 60 * 1000);
    return { from: start.toISOString(), to: new Date(endMs).toISOString(), source: 'last_minutes' };
  }
  const since = str(options.since).trim();
  const until = str(options.until).trim();
  if (since || until) {
    if (!since || !until) throw new Error('--since and --until must be provided together');
    const from = isoOf(since);
    const to = isoOf(until);
    if (!from) throw new Error(`invalid --since timestamp: ${since}`);
    if (!to) throw new Error(`invalid --until timestamp: ${until}`);
    if (Date.parse(to) < Date.parse(from)) throw new Error('--until must not be before --since');
    return { from, to, source: 'explicit' };
  }
  const from = isoOf(activeInput?.window?.from);
  const to = isoOf(activeInput?.window?.to);
  if (from && to) {
    if (Date.parse(to) < Date.parse(from)) throw new Error('active record window.to is before window.from');
    return { from, to, source: 'active_record' };
  }
  return null;
}

/** Deterministic local window slice (no R2 / network access). */
export function sliceEnvelopes(envelopes, window) {
  const from = Date.parse(str(window?.from));
  const to = Date.parse(str(window?.to));
  if (!Number.isFinite(from) || !Number.isFinite(to)) throw new Error('sliceEnvelopes: invalid window');
  return arr(envelopes).filter((envelope) => {
    const parsed = Date.parse(str(envelope?.ts ?? envelope?.timestamp));
    return Number.isFinite(parsed) && parsed >= from && parsed <= to;
  });
}

/**
 * analyze-captures arguments for a local window. `--bundle` short-circuits every
 * R2 read path inside analyze-captures; `--dry-run`/`--last-minutes`/`--since`/
 * `--dir` would either skip the model or issue R2 GETs, so they are forbidden.
 */
export function buildAnalyzeArgs({ windowBundle, analyzerDir, dateLabel }) {
  return ['--bundle', windowBundle, '--out', analyzerDir, '--date', dateLabel];
}

/** Refuse an analyze invocation that could skip the model or hit R2. */
export function assertAnalyzeArgsAreLocal(analyzeArgs) {
  const args = arr(analyzeArgs);
  for (const flag of ['--dry-run', '--last-minutes', '--since', '--dir']) {
    if (args.includes(flag)) {
      throw new Error(`analyze-captures must not be invoked with ${flag} inside the closure loop`);
    }
  }
  if (!args.includes('--bundle')) {
    throw new Error('analyze-captures must be invoked with --bundle (0 extra R2 GET) inside the closure loop');
  }
  return args;
}

/** Parse CLI flags with validation (usage errors throw). */
export function parseClosureArgs(argv = []) {
  const args = arr(argv);
  const valueOf = (flag) => {
    const index = args.indexOf(flag);
    if (index < 0) return undefined;
    const value = args[index + 1];
    if (value === undefined || String(value).startsWith('--')) throw new Error(`${flag} requires a value`);
    return value;
  };
  const options = {
    activeInput: valueOf('--active-input') ?? '',
    raw: valueOf('--raw') ?? '',
    store: valueOf('--store') || DEFAULT_STORE,
    bundle: valueOf('--bundle') ?? '',
    outDir: valueOf('--out-dir') || DEFAULT_OUT_DIR,
    workDir: valueOf('--work-dir') ?? '',
    candidates: valueOf('--candidates') || DEFAULT_CANDIDATES,
    candidatesOut: valueOf('--candidates-out') ?? '',
    report: valueOf('--report') ?? '',
    since: valueOf('--since') ?? '',
    until: valueOf('--until') ?? '',
    lastMinutes: 0,
    infraBlockedReason: valueOf('--infra-blocked-reason') ?? '',
    date: valueOf('--date') ?? '',
    now: valueOf('--now') ?? '',
    json: args.includes('--json'),
    help: args.includes('--help') || args.includes('-h'),
    dryRun: args.includes('--dry-run'),
  };
  const lastMinutesRaw = valueOf('--last-minutes');
  if (lastMinutesRaw !== undefined) {
    const parsed = Number(lastMinutesRaw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`invalid --last-minutes "${lastMinutesRaw}": expected a positive number`);
    }
    options.lastMinutes = Math.floor(parsed);
  }
  if (options.lastMinutes > 0 && (options.since || options.until)) {
    throw new Error('use either --last-minutes or --since/--until, not both');
  }
  if (options.now && !isoOf(options.now)) throw new Error(`invalid --now timestamp: ${options.now}`);
  if (options.infraBlockedReason && !options.infraBlockedReason.trim()) {
    throw new Error('--infra-blocked-reason requires a non-empty reason');
  }
  return options;
}

/** Default store reader: local incremental store/bundle only, never R2. */
export async function loadStoreEnvelopes({ store = DEFAULT_STORE, bundle = '' } = {}) {
  if (bundle) return readEnvelopeBundle(bundle);
  const file = join(store, 'envelopes.ndjson');
  if (!existsSync(file)) {
    throw new Error(`capture store missing: ${file} (run sync-captures.mjs first; the closure loop performs 0 R2 GET of its own)`);
  }
  return readEnvelopeBundle(file);
}

/** Default subprocess runner for the four existing scripts. */
export function runNodeScript(scriptName, scriptArgs = [], deps = {}) {
  const { spawnImpl = spawn, cwd = process.cwd() } = deps;
  const script = join(SCRIPT_DIR, scriptName);
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawnImpl(process.execPath, [script, ...arr(scriptArgs)], { cwd, env: process.env });
    } catch (error) {
      resolvePromise({ code: 1, stdout: '', stderr: `cannot spawn ${scriptName}: ${error?.message ?? String(error)}` });
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.on?.('error', (error) => {
      resolvePromise({ code: 1, stdout, stderr: `${stderr}${error?.message ?? String(error)}` });
    });
    child.on?.('close', (code) => {
      resolvePromise({ code: code === 0 ? 0 : (Number(code) || 1), stdout, stderr });
    });
  });
}

async function readJsonIfAny(file) {
  if (!file || !existsSync(file)) return null;
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Parse the distill `--json` summary; falls back to null. */
export function parseDistillSummary(stdout) {
  const text = String(stdout ?? '').trim();
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Format the mandatory three checklist lines (never zero, never more than three). */
export function formatChecklist({
  activeEvalId,
  rawPath,
  activeEvalPath,
  comparison,
  closureStatus,
  blockedReason,
  distillSummary,
  candidatesOut,
}) {
  const findings = comparison?.findings ?? {};
  const missedRows = arr(comparison?.missed);
  const missedDetail = missedRows.length
    ? `；missed 明细：${missedRows
      .slice(0, 5)
      .map((row) => `${str(row?.kind) || 'item'}:${str(row?.subject) || 'unknown'}(${str(row?.reason) || 'unknown'})`)
      .join(' | ')}${missedRows.length > 5 ? ` …[还有 ${missedRows.length - 5} 条]` : ''}`
    : '';
  const line1 = `[closure] ① 落库结果：activeEvalId=${activeEvalId || 'unknown'}；raw=${rawPath || 'missing'}；json=${activeEvalPath || 'missing'}`;
  const line2 = `[closure] ② 同窗对照与 missed 分流：match=${str(comparison?.match) || 'unknown'}；dataStatus=${str(comparison?.passive?.dataStatus) || 'unknown'}；requestId=${str(comparison?.requestIds?.status) || 'unknown'}；closureStatus=${closureStatus || 'unknown'}；missed=${missedRows.length}（passive-observable findings=${Number(findings.missed ?? 0)}，active-only=${Number(findings.activeOnly ?? 0)}）${missedDetail}`;
  const line3 = closureStatus === CLOSURE_STATUS.BLOCKED_INFRA
    ? `[closure] ③ 反哺动作或明确阻塞原因：BLOCKED_INFRA（${blockedReason || 'unknown'}）；distill 候选已生成 signals=${Number(distillSummary?.signals ?? 0)} created=${Number(distillSummary?.created ?? 0)}；闭环未通过`
    : `[closure] ③ 反哺动作或明确阻塞原因：distill 候选已生成 signals=${Number(distillSummary?.signals ?? 0)} created=${Number(distillSummary?.created ?? 0)} merged=${Number(distillSummary?.merged ?? 0)} pending=${Number(distillSummary?.pending ?? 0)} -> ${candidatesOut || 'unknown'}${missedRows.length ? '；missed 项需按 BADCASES/确定性测试反哺并重跑' : ''}`;
  return [line1, line2, line3];
}

/**
 * Run the whole closure loop. Returns an exit code; `deps` allows deterministic
 * tests to inject a fake subprocess runner, fake store loader and clock without
 * any network / real model / real R2 access.
 */
export async function main(argv = process.argv.slice(2), deps = {}) {
  const {
    stdout = console.log,
    stderr = console.error,
    run = runNodeScript,
    env = process.env,
    now = () => new Date(),
    loadStore = loadEnvelopeStoreDefault,
  } = deps ?? {};
  let options;
  try {
    options = parseClosureArgs(argv);
  } catch (error) {
    stderr(`[closure] ${error.message}`);
    return 2;
  }
  if (options.help) {
    stdout(USAGE);
    return 0;
  }
  if (!options.activeInput) {
    stderr(USAGE);
    return 2;
  }
  if (options.dryRun) {
    stderr('[closure] --dry-run is not supported: the single closure entry point must execute the free model');
    return 2;
  }
  // The model is mandatory. Missing config is an operator error, not an
  // "infra blocked" excuse; fail before doing any work.
  const baseUrl = str(env?.ANALYZER_BASE_URL).trim();
  const apiKey = str(env?.ANALYZER_API_KEY).trim();
  if (!baseUrl || !apiKey) {
    stderr('[closure] free model is NOT configured (ANALYZER_BASE_URL / ANALYZER_API_KEY missing); refusing to run a model-free closure loop. Set both env vars (values are never printed).');
    return 2;
  }
  let activeInput;
  try {
    activeInput = JSON.parse(await readFile(options.activeInput, 'utf8'));
  } catch (error) {
    stderr(`[closure] cannot read --active-input ${options.activeInput}: ${error?.message ?? String(error)}`);
    return 2;
  }
  let window;
  try {
    window = resolveWindow(options, activeInput, { now });
  } catch (error) {
    stderr(`[closure] ${error.message}`);
    return 2;
  }
  if (!window) {
    stderr('[closure] cannot determine the passive window: pass --since/--until or --last-minutes, or include window.from/to in the active record');
    return 2;
  }
  const dateLabel = options.date || window.from.slice(0, 10);
  const outDir = options.outDir;
  const workDir = options.workDir || join('work', 'active-closure', dateLabel);
  const candidatesOut = options.candidatesOut || join('work', 'candidates-updated.json');
  const reportPath = options.report || join(workDir, `${dateLabel}-closure-run.json`);
  await mkdir(outDir, { recursive: true });
  await mkdir(workDir, { recursive: true });

  const steps = [];
  const runStep = async (name, scriptName, scriptArgs) => {
    let result;
    try {
      result = await run(scriptName, scriptArgs);
    } catch (error) {
      result = { code: 1, stdout: '', stderr: error?.message ?? String(error) };
    }
    const entry = {
      name,
      script: scriptName,
      code: Number.isFinite(Number(result?.code)) ? Number(result.code) : 1,
      args: arr(scriptArgs),
      stdoutTail: clipForReport(result?.stdout),
      stderrTail: clipForReport(result?.stderr),
    };
    steps.push(entry);
    return entry;
  };
  const finish = async (code, extra = {}) => {
    const report = {
      schema: CLOSURE_RUN_SCHEMA,
      generatedAt: (typeof now === 'function' ? now() : now)?.toISOString?.() ?? new Date().toISOString(),
      activeEvalId: extra.activeEvalId ?? null,
      window,
      windowSource: window.source,
      closureStatus: extra.closureStatus ?? null,
      analyzerRun: extra.analyzerRun ?? null,
      checklist: extra.checklist ?? [],
      exitCode: code,
      steps: steps.map(({ name, script, code: stepCode, args }) => ({ name, script, code: stepCode, args })),
      ...extra.report,
    };
    try {
      await mkdir(dirname(reportPath), { recursive: true });
      await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    } catch (error) {
      stderr(`[closure] WARN: could not write run report ${reportPath}: ${error?.message ?? String(error)}`);
    }
    if (options.json) stdout(JSON.stringify(report, null, 2));
    return code;
  };
  const fail = async (message, code = 1, extra = {}) => {
    stderr(`[closure] FAILED: ${message}`);
    return finish(code, extra);
  };

  // ① record-active-eval: verbatim raw text + structured JSON.
  const activeEvalPath = join(outDir, `active-eval-${dateLabel}.json`);
  const rawPath = options.raw || `${options.activeInput.replace(/\.json$/i, '')}.txt`;
  if (options.raw && !existsSync(rawPath)) {
    return fail(`--raw file not found: ${rawPath} (the verbatim active-eval text is mandatory)`);
  }
  const recordArgs = ['--input', options.activeInput, '--out', activeEvalPath];
  if (existsSync(rawPath)) recordArgs.push('--raw', rawPath);
  if (options.now) recordArgs.push('--now', options.now);
  const recordStep = await runStep('record-active-eval', 'record-active-eval.mjs', recordArgs);
  if (recordStep.code !== 0) {
    return fail(`record-active-eval exited ${recordStep.code}; fix the active record before any passive comparison. ${recordStep.stderrTail || recordStep.stdoutTail}`.trim());
  }
  const activeEval = await readJsonIfAny(activeEvalPath);
  if (!activeEval?.activeEvalId) {
    return fail(`record-active-eval did not write a valid active-eval record at ${activeEvalPath}`);
  }
  const recordedRawPath = existsSync(`${activeEvalPath}.raw.txt`) ? `${activeEvalPath}.raw.txt` : null;

  // ② analyze-captures: local store window slice (0 R2 GET) + mandatory model call.
  let envelopes;
  try {
    envelopes = await loadStore({ store: options.store, bundle: options.bundle });
  } catch (error) {
    return fail(`cannot load the local capture store: ${error?.message ?? String(error)}`, 1, { activeEvalId: activeEval.activeEvalId });
  }
  const windowEnvelopes = sliceEnvelopes(envelopes, window);
  const windowBundle = join(workDir, 'window-envelopes.ndjson');
  await writeFile(windowBundle, encodeEnvelopeBundle(windowEnvelopes), 'utf8');
  const analyzerDir = join(workDir, 'analyzer');
  const analyzeArgs = buildAnalyzeArgs({ windowBundle, analyzerDir, dateLabel });
  try {
    assertAnalyzeArgsAreLocal(analyzeArgs);
  } catch (error) {
    return fail(error.message, 1, { activeEvalId: activeEval.activeEvalId });
  }
  const analyzeStep = await runStep('analyze-captures', 'analyze-captures.mjs', analyzeArgs);
  const analyzerOutputPath = join(analyzerDir, `analyzer-output-${dateLabel}.json`);
  const analyzerInputPath = join(analyzerDir, `analyzer-input-${dateLabel}.json`);
  const analyzerArtifact = await readJsonIfAny(analyzerOutputPath);
  const analyzerRun = analyzerRunOf(analyzerArtifact);
  const llmExecuted = analyzerRun?.llmExecuted === true;
  const infraBlockedReason = str(options.infraBlockedReason).trim();
  let blockedMode = false;
  if (!llmExecuted || analyzeStep.code !== 0) {
    const skipReason = str(analyzerRun?.skippedReason) || (analyzerArtifact ? 'unknown' : 'no_artifact');
    const detail = `analyze-captures exit=${analyzeStep.code} llmExecuted=${String(llmExecuted)} skippedReason=${skipReason} windowEnvelopes=${windowEnvelopes.length}`;
    if (!infraBlockedReason) {
      return fail(`free model did not produce a parsed passive analysis (${detail}). run-active-closure never skips the model; pass --infra-blocked-reason "<reason>" only if the model endpoint/R2 is genuinely blocked. ${analyzeStep.stderrTail || ''}`.trim(), 1, {
        activeEvalId: activeEval.activeEvalId,
        analyzerRun,
      });
    }
    if (!analyzerArtifact) {
      return fail(`BLOCKED_INFRA requested but analyze-captures wrote no artifact (${detail}); cannot compare deterministically`, 1, {
        activeEvalId: activeEval.activeEvalId,
        analyzerRun,
      });
    }
    blockedMode = true;
  }

  // ③ compare-active-passive: closure gate + missed split.
  const compareOut = join(outDir, `active-passive-${dateLabel}.json`);
  const compareArgs = ['--active', activeEvalPath, '--passive', analyzerOutputPath, '--out', compareOut, '--json'];
  if (blockedMode) compareArgs.push('--infra-blocked-reason', infraBlockedReason);
  const compareStep = await runStep('compare-active-passive', 'compare-active-passive.mjs', compareArgs);
  const comparison = await readJsonIfAny(compareOut);
  if (!comparison) {
    return fail(`compare-active-passive wrote no readable result at ${compareOut}; ${compareStep.stderrTail || compareStep.stdoutTail}`.trim(), 1, {
      activeEvalId: activeEval.activeEvalId,
      analyzerRun,
    });
  }
  const closureStatus = str(comparison.closureStatus) || 'UNKNOWN';
  if (closureStatus !== CLOSURE_STATUS.CLOSED && closureStatus !== CLOSURE_STATUS.BLOCKED_INFRA) {
    return fail(`comparison is not a valid closure: closureStatus=${closureStatus} (${str(comparison.closureStatusReason) || 'no reason'}); a model-free passive artifact can never be green`, 1, {
      activeEvalId: activeEval.activeEvalId,
      closureStatus,
      analyzerRun,
    });
  }
  if (closureStatus === CLOSURE_STATUS.BLOCKED_INFRA && !blockedMode) {
    return fail('comparison reported BLOCKED_INFRA without --infra-blocked-reason being set upstream; refusing an unexplained block', 1, {
      activeEvalId: activeEval.activeEvalId,
      closureStatus,
      analyzerRun,
    });
  }

  // Deliberate: only INVALID_NO_LLM / unreadable / unexplained-block results
  // abort here. A `CLOSED` comparison that exits non-zero because of
  // missed/unmatched/EMPTY_WINDOW is the closure VERDICT, not a chain error —
  // step ④ still runs so the missed split gets candidates, and the final exit
  // code stays non-zero (`green` below).

  // ④ distill-r2-candidates: local JSON only (0 extra R2 GET).
  const distillArgs = ['--analyzer-input', analyzerInputPath, '--candidates', options.candidates, '--out', candidatesOut, '--json'];
  if (existsSync(analyzerOutputPath)) distillArgs.push('--analyzer-output', analyzerOutputPath);
  const distillStep = await runStep('distill-r2-candidates', 'distill-r2-candidates.mjs', distillArgs);
  if (distillStep.code !== 0) {
    return fail(`distill-r2-candidates exited ${distillStep.code}; ${distillStep.stderrTail || distillStep.stdoutTail}`.trim(), 1, {
      activeEvalId: activeEval.activeEvalId,
      closureStatus,
      analyzerRun,
    });
  }
  const distillSummary = parseDistillSummary(distillStep.stdoutTail)
    ?? (await summarizeCandidatePool(candidatesOut));

  // ⑤ forced three-line checklist.
  const checklist = formatChecklist({
    activeEvalId: activeEval.activeEvalId,
    rawPath: recordedRawPath || 'embedded-sha256 (no .raw.txt)',
    activeEvalPath,
    comparison,
    closureStatus,
    blockedReason: infraBlockedReason,
    distillSummary,
    candidatesOut,
  });
  for (const line of checklist) stdout(line);
  const green = closureStatus === CLOSURE_STATUS.CLOSED && compareStep.code === 0;
  const exitCode = green ? 0 : 1;
  if (!green) {
    stderr(`[closure] closure NOT green (closureStatus=${closureStatus}, compare exit=${compareStep.code}); see ${compareOut} and the checklist above`);
  }
  return finish(exitCode, {
    activeEvalId: activeEval.activeEvalId,
    closureStatus,
    analyzerRun,
    checklist,
    report: {
      analyze: { windowEnvelopes: windowEnvelopes.length, windowBundle, analyzerOutputPath, analyzerInputPath },
      comparison: { path: compareOut, match: str(comparison.match) || null, missed: arr(comparison.missed).length, dataStatus: str(comparison?.passive?.dataStatus) || null },
      distill: { path: candidatesOut, summary: distillSummary },
      blockedReason: infraBlockedReason || null,
      green,
    },
  });
}

/** Fallback distill summary from the candidate pool file. */
async function summarizeCandidatePool(file) {
  const pool = await readJsonIfAny(file);
  const candidates = arr(pool?.candidates);
  return {
    signals: null,
    created: null,
    merged: null,
    pending: candidates.filter((row) => row?.status === 'pending_review').length,
    candidates: candidates.length,
  };
}

async function loadEnvelopeStoreDefault(options) {
  return loadStoreEnvelopes(options);
}

const isDirectRun = typeof process.argv[1] === 'string' && /run-active-closure\.mjs$/.test(process.argv[1]);
if (isDirectRun) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(`[closure] ${error?.message ?? String(error)}`);
    process.exitCode = 1;
  });
}
