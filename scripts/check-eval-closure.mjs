#!/usr/bin/env node
/**
 * CI gate for the active -> passive evaluation closure (AGENTS.md §3.1.0).
 *
 * The closure loop kept being recorded without ever executing the free model:
 * the comparison artifact looked `exact/likely` while the passive side had been
 * produced by `--dry-run` (or by a failed call). This gate scans the COMMITTED
 * closure records and requires positive proof that the model actually ran:
 *   - `analyzerRun.llmExecuted === true`, OR
 *   - a legitimate `closureStatus: "BLOCKED_INFRA"` with a non-empty reason
 *     (still not a pass, but explicitly recorded as blocked).
 *
 * Scope: `docs/eval/active-passive-*.json`. Records whose file-name date (or
 * `generatedAt`) is BEFORE 2026-11-25 and that have no `llmExecuted` field are
 * legacy snapshots and are skipped, so historical artifacts stay compatible.
 *
 * Exit codes: 0 = no violations; 1 = at least one violation; 2 = usage error.
 *
 * Usage:
 *   node scripts/check-eval-closure.mjs [--dir docs/eval] [--cutoff 2026-11-25] [--json]
 */
import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { analyzerRunOf } from './compare-active-passive.mjs';

export const EVAL_CLOSURE_GATE_SCHEMA = 'eval-closure-gate.v1';
export const EVAL_CLOSURE_CUTOFF = '2026-11-25';
export const CLOSURE_FILE_PREFIX = 'active-passive-';
const DATE_RE = /^(\d{4}-\d{2}-\d{2})$/;
const FILE_DATE_RE = /^active-passive-(\d{4}-\d{2}-\d{2})/;
const GENERATED_AT_RE = /^(\d{4}-\d{2}-\d{2})(?:T|$)/;

const str = (value) => (typeof value === 'string' ? value : '');

/** Date recorded in the file name, else the artifact's `generatedAt` date. */
export function recordDateOf(file, record = {}) {
  const match = FILE_DATE_RE.exec(basename(String(file)));
  if (match) return match[1];
  const generated = str(record?.generatedAt).trim();
  const generatedMatch = GENERATED_AT_RE.exec(generated);
  return generatedMatch ? generatedMatch[1] : null;
}

/** Non-empty reason accepted for a legitimate BLOCKED_INFRA record. */
export function blockedReasonOf(record) {
  for (const key of ['closureStatusReason', 'blockedReason', 'infraBlockedReason', 'reason']) {
    const value = str(record?.[key]).trim();
    if (value) return value;
  }
  return '';
}

/**
 * Evaluate one closure record.
 * @returns {{file:string,date:string|null,status:'ok'|'blocked-infra'|'legacy-skip'|'violation',reason:string|null,llmExecuted:(boolean|undefined),closureStatus:string|null}}
 */
export function evaluateClosureRecord({ file, record }, { cutoff = EVAL_CLOSURE_CUTOFF } = {}) {
  const date = recordDateOf(file, record);
  const analyzerRun = analyzerRunOf(record);
  const llmExecuted = analyzerRun?.llmExecuted;
  const closureStatus = str(record?.closureStatus).trim() || null;
  const base = { file: String(file), date, llmExecuted, closureStatus };
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return { ...base, status: 'violation', reason: 'record is not a JSON object' };
  }
  if (llmExecuted === true) {
    return { ...base, status: 'ok', reason: null };
  }
  if (closureStatus === 'BLOCKED_INFRA') {
    const blockedReason = blockedReasonOf(record);
    if (blockedReason) {
      return { ...base, status: 'blocked-infra', reason: blockedReason };
    }
    return { ...base, status: 'violation', reason: 'closureStatus=BLOCKED_INFRA without a non-empty reason' };
  }
  // Legacy compatibility: pre-cutoff snapshots that never had the field.
  if (llmExecuted === undefined && date !== null && date < cutoff) {
    return { ...base, status: 'legacy-skip', reason: null };
  }
  const reason = llmExecuted === undefined
    ? 'missing analyzerRun.llmExecuted (the free-model execution is not proven)'
    : `analyzerRun.llmExecuted=${JSON.stringify(llmExecuted)} (must be true)`;
  const statusHint = closureStatus ? `; closureStatus=${closureStatus}` : '';
  const dateHint = date === null ? '; record date is unknown (cannot be dated as legacy)' : '';
  return { ...base, status: 'violation', reason: `${reason}${statusHint}${dateHint}` };
}

/** Evaluate a list of `{file, record}` entries (pure). */
export function evaluateClosureRecords(records, { cutoff = EVAL_CLOSURE_CUTOFF } = {}) {
  const results = (Array.isArray(records) ? records : []).map((entry) => evaluateClosureRecord(entry, { cutoff }));
  return {
    schema: EVAL_CLOSURE_GATE_SCHEMA,
    cutoff,
    checked: results.filter((row) => row.status !== 'legacy-skip').length,
    scanned: results.length,
    ok: results.filter((row) => row.status === 'ok').length,
    blockedInfra: results.filter((row) => row.status === 'blocked-infra').length,
    legacySkipped: results.filter((row) => row.status === 'legacy-skip').length,
    violations: results.filter((row) => row.status === 'violation'),
    results,
  };
}

/** List closure record file names (sorted) under one directory. */
export async function listClosureFiles(dir) {
  const names = await readdir(dir);
  return names
    .filter((name) => name.startsWith(CLOSURE_FILE_PREFIX) && name.endsWith('.json'))
    .sort();
}

/**
 * Read and evaluate every closure record in `dir`.
 * Unreadable / unparseable records are violations (never silently skipped).
 */
export async function scanEvalClosure(dir = join('docs', 'eval'), { cutoff = EVAL_CLOSURE_CUTOFF } = {}) {
  const files = await listClosureFiles(dir);
  const records = [];
  for (const name of files) {
    const file = join(dir, name);
    try {
      records.push({ file, record: JSON.parse(await readFile(file, 'utf8')) });
    } catch (error) {
      records.push({ file, record: null, parseError: error?.message ?? String(error) });
    }
  }
  const report = evaluateClosureRecords(records, { cutoff });
  // A parse failure is always a violation; keep the concrete parse error as the
  // reported reason instead of the generic "not an object".
  for (const entry of records) {
    if (!entry.parseError) continue;
    const row = report.results.find((item) => item.file === entry.file);
    if (!row) continue;
    row.status = 'violation';
    row.reason = `cannot read/parse JSON: ${entry.parseError}`;
  }
  report.violations = report.results.filter((row) => row.status === 'violation');
  report.ok = report.results.filter((row) => row.status === 'ok').length;
  report.blockedInfra = report.results.filter((row) => row.status === 'blocked-infra').length;
  report.checked = report.results.filter((row) => row.status !== 'legacy-skip').length;
  return report;
}

/** Format human-readable gate lines. */
export function formatClosureGate(report) {
  return {
    summary: `[eval-closure] scanned=${report.scanned} checked=${report.checked} ok=${report.ok} blocked-infra=${report.blockedInfra} legacy-skipped=${report.legacySkipped} violations=${report.violations.length} (cutoff=${report.cutoff})`,
    violationLines: report.violations.map((row) => `[eval-closure] VIOLATION ${row.file}: ${row.reason}`),
  };
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const { stdout = console.log, stderr = console.error } = deps ?? {};
  const args = Array.isArray(argv) ? argv : [];
  const arg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : '');
  const dir = arg('--dir') || join('docs', 'eval');
  const cutoff = arg('--cutoff') || EVAL_CLOSURE_CUTOFF;
  if (!DATE_RE.test(cutoff)) {
    stderr(`[eval-closure] invalid --cutoff "${cutoff}": expected YYYY-MM-DD`);
    return 2;
  }
  let report;
  try {
    report = await scanEvalClosure(dir, { cutoff });
  } catch (error) {
    stderr(`[eval-closure] cannot scan ${dir}: ${error?.message ?? String(error)}`);
    return 2;
  }
  const lines = formatClosureGate(report);
  if (args.includes('--json')) {
    stdout(JSON.stringify(report, null, 2));
  } else {
    stdout(lines.summary);
    for (const line of lines.violationLines) stderr(line);
  }
  if (report.violations.length > 0) {
    stderr(`[eval-closure] FAIL: ${report.violations.length} closure record(s) do not prove the free model executed; see ${dir}/active-passive-*.json`);
    return 1;
  }
  return 0;
}

const isDirectRun = typeof process.argv[1] === 'string' && /check-eval-closure\.mjs$/.test(process.argv[1]);
if (isDirectRun) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(`[eval-closure] ${error?.message ?? String(error)}`);
    process.exitCode = 2;
  });
}
