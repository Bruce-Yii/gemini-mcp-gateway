#!/usr/bin/env node
/**
 * Record one ACTIVE online-evaluation observation as `active-eval.v1`.
 *
 * Why: `AGENTS.md` §3.1 requires every pasted active-evaluation result to be
 * preserved with its build/anchor context before the passive lane is pulled.
 * This script makes that record deterministic and validated (no fabricated
 * requestIds, no model output treated as fact).
 *
 * Input (JSON; see docs/eval/EVAL-CLOSURE.md):
 *   {
 *     "platform": "gemini|chatgpt|claude|unknown",
 *     "buildCommit": "<7-40 hex>|unknown",
 *     "window": { "from": ISO, "to": ISO },
 *     "anchors": { "repos": [], "prs": [], "issues": [], "branches": [], "files": [],
 *                   "startAction": "...", "endAction": "..." },
 *     "prompt": "...", "expected": { "outcome": "...", "tools": [], "checks": [] },
 *     "observed": { "tools": [], "results": [], "errors": [], "requestIds": [],
 *                    "captureVerified": false, "services": [], "connectFailures": [] },
 *     "source": { "window": "...", "messageAt": ISO }
 *   }
 *
 * `--now` fixes the timestamp for deterministic tests. The stable activeEvalId
 * is derived from the normalized record (never random).
 *
 * Usage:
 *   node scripts/record-active-eval.mjs --input work/active.json \
 *     --out docs/eval/active-eval-2026-11-24.json
 *   node scripts/record-active-eval.mjs --input work/active.json --json
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const ACTIVE_EVAL_SCHEMA = 'active-eval.v1';
export const PLATFORMS = Object.freeze(['gemini', 'chatgpt', 'claude', 'unknown']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const COMMIT_RE = /^[0-9a-f]{7,40}$/i;

const str = (value) => (typeof value === 'string' ? value : '');
const arr = (value) => (Array.isArray(value) ? value : []);

function normalizeRequestIds(list) {
  const out = [];
  for (const raw of arr(list)) {
    const value = str(raw).trim();
    if (!value) continue;
    if (value === 'unknown' || UUID_RE.test(value)) {
      if (!out.includes(value)) out.push(value);
      continue;
    }
    throw new Error(`requestIds entry is neither a UUID nor "unknown": ${value.slice(0, 40)}`);
  }
  return out.length ? out : ['unknown'];
}

function normalizeServices(list) {
  return arr(list).map((row) => {
    if (typeof row === 'string') return { name: row, status: 'unknown', needsReauth: false };
    const name = str(row?.name).trim();
    const status = str(row?.status).trim() || 'unknown';
    return {
      name,
      status,
      needsReauth: row?.needsReauth === true,
    };
  }).filter((row) => row.name);
}

/** Validate the caller-supplied record; returns a list of human-readable errors. */
export function validateActiveEval(record) {
  const errors = [];
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return ['record must be an object'];
  }
  if (!PLATFORMS.includes(record.platform)) {
    errors.push(`platform must be one of ${PLATFORMS.join(', ')}`);
  }
  const build = str(record.buildCommit).trim();
  if (build !== 'unknown' && !COMMIT_RE.test(build)) {
    errors.push('buildCommit must be a 7-40 char git hash or "unknown"');
  }
  const from = str(record?.window?.from).trim();
  const to = str(record?.window?.to).trim();
  if (!ISO_RE.test(from)) errors.push('window.from must be an ISO-8601 timestamp');
  if (!ISO_RE.test(to)) errors.push('window.to must be an ISO-8601 timestamp');
  if (ISO_RE.test(from) && ISO_RE.test(to) && Date.parse(to) < Date.parse(from)) {
    errors.push('window.to must not be before window.from');
  }
  if (!str(record.prompt).trim()) errors.push('prompt must be a non-empty string (keep the original text)');
  const anchors = record.anchors ?? {};
  if (!str(anchors.startAction).trim()) errors.push('anchors.startAction is required (write "unknown" if not known)');
  if (!str(anchors.endAction).trim()) errors.push('anchors.endAction is required (write "unknown" if not known)');
  for (const listName of ['repos', 'prs', 'issues', 'branches', 'files']) {
    if (anchors[listName] !== undefined && !Array.isArray(anchors[listName])) {
      errors.push(`anchors.${listName} must be an array`);
    }
  }
  try {
    normalizeRequestIds(record?.observed?.requestIds);
  } catch (error) {
    errors.push(error.message);
  }
  return errors;
}

/** Build the canonical, stable record (pure; `now` must be supplied for determinism). */
export function buildActiveEval(record, { now = new Date().toISOString() } = {}) {
  const errors = validateActiveEval(record);
  if (errors.length) {
    const error = new Error(`invalid active-eval record:\n- ${errors.join('\n- ')}`);
    error.errors = errors;
    throw error;
  }
  const anchors = record.anchors ?? {};
  const expected = record.expected ?? {};
  const observed = record.observed ?? {};
  const normalized = {
    platform: record.platform,
    buildCommit: str(record.buildCommit).trim(),
    window: { from: str(record.window.from).trim(), to: str(record.window.to).trim() },
    anchors: {
      repos: arr(anchors.repos).map(str).filter(Boolean),
      prs: arr(anchors.prs).map((value) => Number(value)).filter((value) => Number.isFinite(value)),
      issues: arr(anchors.issues).map((value) => Number(value)).filter((value) => Number.isFinite(value)),
      branches: arr(anchors.branches).map(str).filter(Boolean),
      files: arr(anchors.files).map(str).filter(Boolean),
      startAction: str(anchors.startAction).trim(),
      endAction: str(anchors.endAction).trim(),
    },
    prompt: str(record.prompt),
    expected: {
      outcome: str(expected.outcome).trim(),
      tools: arr(expected.tools).map(str).filter(Boolean),
      checks: arr(expected.checks).map(str).filter(Boolean),
    },
    observed: {
      tools: arr(observed.tools).map(str).filter(Boolean),
      results: arr(observed.results).map(str).filter(Boolean),
      errors: arr(observed.errors).map(str).filter(Boolean),
      requestIds: normalizeRequestIds(observed.requestIds),
      captureVerified: observed.captureVerified === true,
      services: normalizeServices(observed.services),
      connectFailures: arr(observed.connectFailures).map(str).filter(Boolean),
    },
    source: {
      window: str(record?.source?.window).trim() || 'dev lead window',
      messageAt: str(record?.source?.messageAt).trim() || now,
    },
  };
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({
      platform: normalized.platform,
      buildCommit: normalized.buildCommit,
      window: normalized.window,
      prompt: normalized.prompt,
      anchors: normalized.anchors,
    }))
    .digest('hex')
    .slice(0, 8);
  const day = normalized.window.from.slice(0, 10).replace(/-/g, '');
  return {
    schema: ACTIVE_EVAL_SCHEMA,
    activeEvalId: `ae_${day}_${fingerprint}`,
    recordedAt: now,
    ...normalized,
  };
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const { stdout = console.log, stderr = console.error } = deps;
  const args = argv;
  const arg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : '');
  const inputPath = arg('--input');
  if (!inputPath) {
    stderr('usage: record-active-eval.mjs --input <record.json> [--out <file>] [--now <ISO>] [--json]');
    return 2;
  }
  let record;
  try {
    record = JSON.parse(await readFile(inputPath, 'utf8'));
  } catch (error) {
    stderr(`[active-eval] cannot read ${inputPath}: ${error.message}`);
    return 2;
  }
  const now = arg('--now') || new Date().toISOString();
  let built;
  try {
    built = buildActiveEval(record, { now });
  } catch (error) {
    stderr(`[active-eval] ${error.message}`);
    return 2;
  }
  const out = arg('--out');
  if (out) {
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, `${JSON.stringify(built, null, 2)}\n`, 'utf8');
    stdout(`[active-eval] wrote ${out} (${built.activeEvalId})`);
  }
  if (args.includes('--json')) stdout(JSON.stringify(built, null, 2));
  else if (!out) stdout(`${built.schema} ${built.activeEvalId} platform=${built.platform} build=${built.buildCommit}`);
  return 0;
}

const isDirectRun = typeof process.argv[1] === 'string' && /record-active-eval\.mjs$/.test(process.argv[1]);
if (isDirectRun) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(`[active-eval] ${error?.message ?? String(error)}`);
    process.exitCode = 2;
  });
}
