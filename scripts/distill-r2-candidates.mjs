#!/usr/bin/env node
/**
 * R2 real-traffic distillation · stages 1–3 (see docs/eval/R2-DISTILLATION-DESIGN.md).
 *
 * HARD CONSTRAINTS (design §一):
 *   1. ZERO extra R2 / network requests. This script only reads JSON artifacts
 *      that capture-daily.yml already wrote locally (analyzer-input /
 *      analyzer-output / digest) plus the existing candidates pool.
 *   2. Pure deterministic rules, no LLM.
 *   3. Candidates only — never writes *-gold.json or INDEX.json (that is the
 *      stage-4 promote gate in promote-eval-candidate.mjs).
 *   4. Strict redaction via the PR #28 redactor (unquoted key=value, token
 *      families, and JSON `"token":"..."` shapes).
 *
 * Usage:
 *   node scripts/distill-r2-candidates.mjs \
 *     --analyzer-input work/analyzer/analyzer-input-*.json \
 *     --analyzer-output work/analyzer/analyzer-output-*.json \
 *     --candidates docs/eval/suites/candidates.json \
 *     --out work/candidates-updated.json --json
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { redactAnalyzerText } from './analyze-captures.mjs';

export const CANDIDATES_SCHEMA = 'gold-eval-candidates.v1';
export const DEFAULT_CANDIDATES_PATH = 'docs/eval/suites/candidates.json';
export const WINDOW_MS = 5 * 60 * 1000;

/** Design §二·阶段1 severity weights. */
export const SEVERITY_WEIGHT = Object.freeze({
  retry_loop: 3,
  search_thrash: 2,
  truncation_reread: 3,
  semantic_200_gap: 4,
  slow_or_unexpected: 2,
  client_divergence: 5,
});

/** Signal → failure modes it maps to (design §二·阶段1). */
export const SIGNAL_FAILURE_MODES = Object.freeze({
  retry_loop: ['failed_error_recovery'],
  search_thrash: ['wrong_tool_selection'],
  truncation_reread: ['response_misparsing', 'constraint_violations'],
  semantic_200_gap: ['malformed_parameters', 'response_misparsing'],
  slow_or_unexpected: ['failed_error_recovery'],
  client_divergence: ['constraint_violations'],
});

/** Known observations that must never become candidates (design §二·阶段1). */
export const EXPECTED_400_WHITELIST = Object.freeze([
  // OBS-001: ChatGPT probes MCP 2026-07-28 via server/discover; the gateway
  // answers 400 on purpose (protocol negotiation) and the client falls back.
  { method: 'server/discover', status: 400 },
]);

const SLOW_MS = 8000;
const RETRY_MIN_GAP_MS = WINDOW_MS;
const SEARCH_THRASH_CONSECUTIVE = 4;
const SEARCH_THRASH_TOTAL = 5;
const DIVERGENCE_MIN_CALLS = 5;
const DIVERGENCE_ERROR_RATE_DELTA = 0.25;
const MAX_SAMPLE_REQUEST_IDS = 10;
const MAX_CLAIM_EVIDENCE_IDS = 3;

const arr = (value) => (Array.isArray(value) ? value : []);
const str = (value) => (typeof value === 'string' ? value : '');
const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

function tsOf(row) {
  const parsed = Date.parse(str(row?.ts ?? row?.firstTs));
  return Number.isFinite(parsed) ? parsed : null;
}

function isFailureStatus(status) {
  const code = Number(status);
  return Number.isFinite(code) && code >= 400;
}

function sha256Hex(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

/** Design §二·阶段2 fingerprint formula. */
export function fingerprintOf({ upstream, tool, primarySignal, normalizedErrorShape }) {
  const parts = [
    str(upstream) || 'gateway',
    str(tool) || 'unknown',
    str(primarySignal) || 'unknown',
    str(normalizedErrorShape) || 'none',
  ];
  return sha256Hex(parts.join('|')).slice(0, 16);
}

/** Design §二·阶段2 priorityScore (2 decimals). */
export function priorityScore({ severityWeight, seenCount, affectedClients }) {
  const weight = Number(severityWeight) || 0;
  const seen = Math.max(1, Number(seenCount) || 1);
  const clients = arr(affectedClients).filter(Boolean);
  const multiplier = clients.length >= 2 ? 1.5 : 1.0;
  return Number((weight * Math.log2(seen + 1) * multiplier).toFixed(2));
}

/* ------------------------------------------------------------------ *
 * Stage 1 — six deterministic triggers
 * ------------------------------------------------------------------ */

function indexSamplesById(input) {
  const map = new Map();
  for (const sample of arr(input?.samples)) {
    const id = str(sample?.id);
    if (id) map.set(id, sample);
  }
  return map;
}

function upstreamOf(row) {
  const servers = arr(row?.servers).filter((value) => typeof value === 'string' && value);
  return servers[0] || 'gateway';
}

function previewOf(sample) {
  const preview = sample?.responsePreview;
  if (typeof preview === 'string') return { text: preview, nullKeys: [] };
  return {
    text: str(preview?.preview),
    nullKeys: arr(preview?.nullKeys).filter((key) => typeof key === 'string'),
  };
}

function isTruncatedSample(sample) {
  if (sample?.truncated === true) return true;
  const { text } = previewOf(sample);
  return /---\s*TRUNCATED\s*---/.test(text);
}

/** retry_loop: same platform+tool within 5 min, previous call failed. */
function detectRetryLoop(rows, samplesById) {
  const signals = [];
  const groups = new Map();
  for (const row of rows) {
    if (!str(row?.tool)) continue;
    const key = `${str(row.clientPlatform)}|${str(row.tool)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  for (const group of groups.values()) {
    group.sort((a, b) => (tsOf(a) ?? 0) - (tsOf(b) ?? 0));
    for (let i = 1; i < group.length; i += 1) {
      const previous = group[i - 1];
      const current = group[i];
      const gap = (tsOf(current) ?? 0) - (tsOf(previous) ?? 0);
      if (gap < 0 || gap > RETRY_MIN_GAP_MS) continue;
      const sample = samplesById.get(str(previous.id));
      const subError = arr(sample?.subCalls).find((call) => call?.ok === false && call?.error);
      if (!isFailureStatus(previous.status) && !subError) continue;
      signals.push({
        signal: 'retry_loop',
        upstream: upstreamOf(previous),
        tool: str(previous.tool),
        platform: str(previous.clientPlatform) || 'unknown',
        buildCommit: str(previous.buildCommit),
        requestIds: [str(previous.id), str(current.id)].filter(Boolean),
        errorShape: `status:${num(previous.status)}|${str(subError?.error?.name) || 'none'}`,
        evidence: {
          firstStatus: num(previous.status),
          retryStatus: num(current.status),
          gapMs: gap,
          subCallError: subError ? redactAnalyzerText(str(subError?.error?.message)).slice(0, 120) : null,
        },
      });
    }
  }
  return signals;
}

/** search_thrash: >=4 consecutive search without execute, or >=5 in one window. */
function detectSearchThrash(rows) {
  const signals = [];
  const byPlatform = new Map();
  for (const row of rows) {
    const platform = str(row.clientPlatform) || 'unknown';
    if (!byPlatform.has(platform)) byPlatform.set(platform, []);
    byPlatform.get(platform).push(row);
  }
  for (const [platform, list] of byPlatform) {
    list.sort((a, b) => (tsOf(a) ?? 0) - (tsOf(b) ?? 0));
    let run = [];
    const flushRun = () => {
      if (run.length >= SEARCH_THRASH_CONSECUTIVE) {
        signals.push({
          signal: 'search_thrash',
          upstream: 'gateway',
          tool: 'search',
          platform,
          buildCommit: str(run[0].buildCommit),
          requestIds: run.map((row) => str(row.id)).filter(Boolean),
          errorShape: `run:${run.length}`,
          evidence: { consecutiveSearch: run.length, firstTs: run[0].ts ?? null, lastTs: run[run.length - 1].ts ?? null },
        });
      }
      run = [];
    };
    for (const row of list) {
      const tool = str(row.tool);
      if (tool === 'search') {
        const last = run[run.length - 1];
        if (last && (tsOf(row) ?? 0) - (tsOf(last) ?? 0) > WINDOW_MS) flushRun();
        run.push(row);
        continue;
      }
      if (tool === 'execute' || tool === 'execute_read') flushRun();
    }
    flushRun();
    // Single-window total >= 5 (covers interleaved non-search noise).
    for (let i = 0; i < list.length; i += 1) {
      const windowRows = list.filter((row) => {
        const delta = (tsOf(row) ?? 0) - (tsOf(list[i]) ?? 0);
        return delta >= 0 && delta <= WINDOW_MS;
      });
      const searches = windowRows.filter((row) => str(row.tool) === 'search');
      if (searches.length >= SEARCH_THRASH_TOTAL) {
        signals.push({
          signal: 'search_thrash',
          upstream: 'gateway',
          tool: 'search',
          platform,
          buildCommit: str(searches[0].buildCommit),
          requestIds: searches.map((row) => str(row.id)).filter(Boolean),
          errorShape: `window:${searches.length}`,
          evidence: { windowSearch: searches.length, windowStart: searches[0].ts ?? null },
        });
        break;
      }
    }
  }
  return signals;
}

/** truncation_reread: truncated response, same tool/path read again within 2 calls. */
function detectTruncationReread(rows, samplesById) {
  const signals = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const sample = samplesById.get(str(row.id));
    if (!sample || !isTruncatedSample(sample)) continue;
    const lookahead = rows.slice(i + 1, i + 3);
    const reread = lookahead.find((candidate) => (
      str(candidate.tool) === str(row.tool)
      && str(candidate.clientPlatform) === str(row.clientPlatform)
    ));
    if (!reread) continue;
    signals.push({
      signal: 'truncation_reread',
      upstream: upstreamOf(row),
      tool: str(row.tool) || 'unknown',
      platform: str(row.clientPlatform) || 'unknown',
      buildCommit: str(row.buildCommit),
      requestIds: [str(row.id), str(reread.id)].filter(Boolean),
      errorShape: 'truncated',
      evidence: {
        status: num(row.status),
        truncated: true,
        rereadTool: str(reread.tool),
        rereadStatus: num(reread.status),
      },
    });
  }
  return signals;
}

/** semantic_200_gap: HTTP 200 but key fields null / dry-run zero-write. */
function detectSemanticGaps(input) {
  const signals = [];
  const nullKeyWatch = new Set(['number', 'url', 'path']);
  for (const sample of arr(input?.samples)) {
    if (num(sample?.status) !== 200) continue;
    const { text, nullKeys } = previewOf(sample);
    const hitsNull = nullKeys.filter((key) => nullKeyWatch.has(key));
    const dryWrite = /"dryRun"\s*:\s*true/.test(text) || /"written"\s*:\s*0\b/.test(text);
    const writtenZero = /"written"\s*:\s*0\b/.test(text);
    if (hitsNull.length === 0 && !dryWrite) continue;
    const shape = hitsNull.length
      ? `null:${[...hitsNull].sort().join('+')}`
      : (writtenZero ? 'written:0' : 'dryRun:true');
    signals.push({
      signal: 'semantic_200_gap',
      upstream: upstreamOf(sample),
      tool: str(sample.tool) || 'execute',
      platform: str(sample.clientPlatform) || 'unknown',
      buildCommit: str(sample.buildCommit),
      requestIds: [str(sample.id)].filter(Boolean),
      errorShape: shape,
      evidence: {
        status: 200,
        nullKeys: [...hitsNull].sort(),
        dryRun: /"dryRun"\s*:\s*true/.test(text),
        writtenZero,
        durationMs: num(sample.durationMs),
      },
    });
  }
  return signals;
}

function isWhitelistedResponse(row) {
  const method = str(row?.method);
  const status = num(row?.status);
  return EXPECTED_400_WHITELIST.some((entry) => entry.method === method && entry.status === status);
}

/** slow_or_unexpected: >8s, or non-whitelisted 4xx/5xx. */
function detectSlowOrUnexpected(rows) {
  const signals = [];
  for (const row of rows) {
    const durationMs = num(row.durationMs);
    const status = num(row.status);
    if (durationMs > SLOW_MS) {
      signals.push({
        signal: 'slow_or_unexpected',
        upstream: upstreamOf(row),
        tool: str(row.tool) || 'execute',
        platform: str(row.clientPlatform) || 'unknown',
        buildCommit: str(row.buildCommit),
        requestIds: [str(row.id)].filter(Boolean),
        errorShape: 'duration>8000',
        evidence: { durationMs, status },
      });
      continue;
    }
    if (!isFailureStatus(status) || isWhitelistedResponse(row)) continue;
    signals.push({
      signal: 'slow_or_unexpected',
      upstream: upstreamOf(row),
      tool: str(row.tool) || 'execute',
      platform: str(row.clientPlatform) || 'unknown',
      buildCommit: str(row.buildCommit),
      requestIds: [str(row.id)].filter(Boolean),
      errorShape: `status:${status}`,
      evidence: { durationMs, status, method: str(row.method) || null },
    });
  }
  return signals;
}

/** client_divergence: same build+tool error-rate delta >= 25% across clients. */
function detectClientDivergence(rows) {
  const signals = [];
  const groups = new Map();
  for (const row of rows) {
    const tool = str(row.tool);
    if (!tool) continue;
    const key = `${str(row.buildCommit)}|${tool}`;
    if (!groups.has(key)) groups.set(key, new Map());
    const perPlatform = groups.get(key);
    const platform = str(row.clientPlatform) || 'unknown';
    const bucket = perPlatform.get(platform) ?? { calls: 0, errors: 0, ids: [] };
    bucket.calls += 1;
    if (isFailureStatus(row.status)) bucket.errors += 1;
    if (bucket.ids.length < MAX_CLAIM_EVIDENCE_IDS) bucket.ids.push(str(row.id));
    perPlatform.set(platform, bucket);
  }
  for (const [key, perPlatform] of groups) {
    const platforms = [...perPlatform.entries()].filter(([, bucket]) => bucket.calls >= DIVERGENCE_MIN_CALLS);
    if (platforms.length < 2) continue;
    const rates = platforms.map(([platform, bucket]) => ({ platform, rate: bucket.errors / bucket.calls }));
    const max = rates.reduce((a, b) => (b.rate > a.rate ? b : a));
    const min = rates.reduce((a, b) => (b.rate < a.rate ? b : a));
    const delta = max.rate - min.rate;
    if (delta < DIVERGENCE_ERROR_RATE_DELTA) continue;
    const [buildCommit, tool] = key.split('|');
    signals.push({
      signal: 'client_divergence',
      upstream: 'gateway',
      tool,
      platform: max.platform,
      buildCommit,
      requestIds: [...perPlatform.get(max.platform).ids, ...perPlatform.get(min.platform).ids].filter(Boolean),
      errorShape: `errdelta:${Math.round(delta * 100)}`,
      evidence: {
        buildCommit,
        errorRates: Object.fromEntries(rates.map((row) => [row.platform, Number(row.rate.toFixed(3))])),
        delta: Number(delta.toFixed(3)),
        roundsAvailable: false,
      },
      affectedClients: rates.map((row) => row.platform),
    });
  }
  return signals;
}

/** Run every trigger and return the raw signals (deterministic order). */
export function detectSignals({ input }) {
  const rows = arr(input?.requestIndex).slice().sort((a, b) => (
    (tsOf(a) ?? 0) - (tsOf(b) ?? 0) || String(a.id).localeCompare(String(b.id))
  ));
  const samplesById = indexSamplesById(input);
  return [
    ...detectRetryLoop(rows, samplesById),
    ...detectSearchThrash(rows),
    ...detectTruncationReread(rows, samplesById),
    ...detectSemanticGaps(input),
    ...detectSlowOrUnexpected(rows),
    ...detectClientDivergence(rows),
  ];
}

/* ------------------------------------------------------------------ *
 * Stage 2/3 — fingerprint merge into the candidates pool
 * ------------------------------------------------------------------ */

export function emptyPool(now = new Date()) {
  return {
    schema: CANDIDATES_SCHEMA,
    updatedAt: now.toISOString(),
    ignoredFingerprints: [],
    candidates: [],
  };
}

export function normalizePool(pool, now = new Date()) {
  const base = pool && typeof pool === 'object' ? pool : {};
  return {
    schema: CANDIDATES_SCHEMA,
    updatedAt: str(base.updatedAt) || now.toISOString(),
    ignoredFingerprints: [...new Set(arr(base.ignoredFingerprints).map(str).filter(Boolean))],
    candidates: arr(base.candidates).filter((row) => row && typeof row === 'object' && str(row.fingerprint)),
  };
}

function dateKey(iso) {
  const parsed = Date.parse(str(iso));
  const date = Number.isFinite(parsed) ? new Date(parsed) : new Date();
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}`;
}

function mergeRequestIds(existing, incoming) {
  const merged = [...new Set([...arr(existing), ...arr(incoming)].map(str).filter(Boolean))];
  return merged.slice(-MAX_SAMPLE_REQUEST_IDS);
}

/**
 * Merge one signal into the pool.
 * @returns {{pool: object, created: boolean, skipped: boolean}}
 */
export function applySignal(pool, signal, { now = new Date() } = {}) {
  const next = normalizePool(pool, now);
  const fingerprint = fingerprintOf(signal);
  if (next.ignoredFingerprints.includes(fingerprint)) return { pool: next, created: false, skipped: true };

  const existing = next.candidates.find((candidate) => candidate.fingerprint === fingerprint);
  const affectedClients = [...new Set([
    ...arr(signal.affectedClients),
    str(signal.platform) || 'unknown',
  ].filter(Boolean))];
  const seenAt = now.toISOString();

  if (existing) {
    existing.seenCount = num(existing.seenCount) + 1;
    existing.lastSeenAt = seenAt;
    existing.affectedClients = [...new Set([...arr(existing.affectedClients), ...affectedClients])];
    existing.sampleRequestIds = mergeRequestIds(existing.sampleRequestIds, signal.requestIds);
    existing.buildCommits = [...new Set([...arr(existing.buildCommits), str(signal.buildCommit)].filter(Boolean))].slice(-5);
    existing.triggerSignals = [...new Set([...arr(existing.triggerSignals), signal.signal])];
    existing.priorityScore = priorityScore({
      severityWeight: num(existing.severityWeight) || SEVERITY_WEIGHT[signal.signal] || 1,
      seenCount: existing.seenCount,
      affectedClients: existing.affectedClients,
    });
    if (existing.status === 'rejected_noise') return { pool: next, created: false, skipped: true };
    return { pool: next, created: false, skipped: false };
  }

  const created = now.toISOString();
  const candidate = {
    candidateId: `CAND-${dateKey(created)}-${fingerprint.slice(0, 8)}`,
    fingerprint,
    status: 'pending_review',
    primarySignal: signal.signal,
    triggerSignals: [signal.signal],
    severityWeight: SEVERITY_WEIGHT[signal.signal] ?? 1,
    upstream: str(signal.upstream) || 'gateway',
    tool: str(signal.tool) || 'unknown',
    affectedClients,
    buildCommits: [str(signal.buildCommit)].filter(Boolean),
    seenCount: 1,
    priorityScore: priorityScore({
      severityWeight: SEVERITY_WEIGHT[signal.signal] ?? 1,
      seenCount: 1,
      affectedClients,
    }),
    firstSeenAt: created,
    lastSeenAt: seenAt,
    sampleRequestIds: mergeRequestIds([], signal.requestIds),
    redactedEvidence: sanitizeEvidence(signal.evidence ?? {}),
    draftTask: {
      upstream: str(signal.upstream) || 'gateway',
      access: str(signal.signal) === 'semantic_200_gap' ? 'write' : 'read',
      tier: 'T2',
      failureModeTarget: [...(SIGNAL_FAILURE_MODES[signal.signal] ?? [])],
      trap: `待人工精修：${signal.signal} — ${str(signal.tool) || 'unknown'}`,
      userPromptDraft: '',
      verifiableClaimsDraft: [],
      efficiencyBaseline: { maxSearchCalls: 2, maxExecuteReadCalls: 2, maxExecuteCalls: 2 },
    },
    promotedTaskId: null,
    rejectedReason: null,
  };
  next.candidates.push(candidate);
  return { pool: next, created: true, skipped: false };
}

/** Redact every string in the evidence object before it reaches the pool. */
export function sanitizeEvidence(value) {
  if (typeof value === 'string') return redactAnalyzerText(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeEvidence(item));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = sanitizeEvidence(item);
    return out;
  }
  return value;
}

/** Stage 1–3 entry point: artifacts + pool → updated pool + summary. */
export function distill({ input, output = null, pool = null, now = new Date() } = {}) {
  if (!input || typeof input !== 'object') throw new Error('distill: analyzer-input object is required');
  let next = normalizePool(pool ?? emptyPool(now), now);
  const signals = detectSignals({ input, output });
  let created = 0;
  let merged = 0;
  let skipped = 0;
  for (const signal of signals) {
    const result = applySignal(next, signal, { now });
    next = result.pool;
    if (result.skipped) skipped += 1;
    else if (result.created) created += 1;
    else merged += 1;
  }
  next.updatedAt = now.toISOString();
  next.candidates.sort((a, b) => (
    (num(b.priorityScore) - num(a.priorityScore)) || String(a.candidateId).localeCompare(String(b.candidateId))
  ));
  return {
    pool: next,
    summary: {
      schema: CANDIDATES_SCHEMA,
      dataStatus: str(input.dataStatus) || null,
      signals: signals.length,
      created,
      merged,
      skippedIgnored: skipped,
      pending: next.candidates.filter((row) => row.status === 'pending_review').length,
      promoted: next.candidates.filter((row) => row.status === 'promoted').length,
      rejected: next.candidates.filter((row) => row.status === 'rejected_noise').length,
    },
  };
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const { stdout = console.log, stderr = console.error } = deps;
  const arg = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : '');
  const inputPath = arg('--analyzer-input');
  const outputPath = arg('--analyzer-output');
  const digestPath = arg('--digest');
  const candidatesPath = arg('--candidates') || DEFAULT_CANDIDATES_PATH;
  const outPath = arg('--out');
  const nowArg = arg('--now');
  const now = nowArg ? new Date(nowArg) : new Date();
  if (Number.isNaN(now.getTime())) {
    stderr(`[distill] invalid --now: ${nowArg}`);
    return 2;
  }
  if (!inputPath) {
    stderr('usage: distill-r2-candidates.mjs --analyzer-input <file> [--analyzer-output <file>] [--digest <file>] [--candidates <file>] [--out <file>] [--now ISO] [--json]');
    return 2;
  }
  const input = await readJson(inputPath);
  if (!input) {
    stderr(`[distill] cannot read analyzer-input: ${inputPath}`);
    return 2;
  }
  const output = outputPath ? await readJson(outputPath) : null;
  const digest = digestPath ? await readJson(digestPath) : null;
  const pool = await readJson(candidatesPath, null) ?? emptyPool(now);
  const result = distill({ input: digest ? { ...input, digest } : input, output, pool, now });
  const target = outPath || candidatesPath;
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(result.pool, null, 2)}\n`, 'utf8');
  if (argv.includes('--json')) stdout(JSON.stringify({ ...result.summary, out: target }, null, 2));
  else stdout(`[distill] ${result.summary.signals} signals -> ${result.summary.created} new, ${result.summary.merged} merged, ${result.summary.skippedIgnored} ignored -> ${target}`);
  return 0;
}

const isDirectRun = typeof process.argv[1] === 'string' && /distill-r2-candidates\.mjs$/.test(process.argv[1]);
if (isDirectRun) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(`[distill] ${error?.message ?? String(error)}`);
    process.exitCode = 1;
  });
}

export const __internal = Object.freeze({ join, DEFAULT_CANDIDATES_PATH });
