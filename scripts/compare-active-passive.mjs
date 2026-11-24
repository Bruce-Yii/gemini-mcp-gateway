#!/usr/bin/env node
/**
 * Compare one `active-eval.v1` record with the same-window PASSIVE artifact
 * (`analyzer-input.v1` / `analyzer-output.v1` produced by capture-daily).
 *
 * Why: `AGENTS.md` §3.1 step 2/5 requires an explicit “被动抓到了什么、漏了什么、
 * 为什么漏” answer. This script makes that comparison deterministic:
 *   - exact     : at least one active requestId is present in the passive window
 *   - likely    : window + platform + build align, but no requestId match
 *   - weak      : window + platform align only
 *   - unmatched : empty window / build mismatch / no overlap
 *
 * It never guesses a requestId, never treats EMPTY_WINDOW as a pass, and never
 * calls a model.
 *
 * Usage:
 *   node scripts/compare-active-passive.mjs \
 *     --active docs/eval/active-eval-2026-11-24.json \
 *     --passive work/run-<id>/analyzer/analyzer-output-2026-11-24-last-60m-commit-3dd206f.json \
 *     --out docs/eval/active-passive-<id>.json --json
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const COMPARISON_SCHEMA = 'active-passive-comparison.v1';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const str = (value) => (typeof value === 'string' ? value : '');
const arr = (value) => (Array.isArray(value) ? value : []);

/** Unwrap analyzer-output ({input}) / analyzer-input into one passive view. */
export function normalizePassive(passive) {
  const input = passive?.input ?? passive ?? {};
  const samples = arr(input.samples);
  const requestIndex = arr(input.requestIndex);
  const dimensions = input.dimensions ?? {};
  const ids = new Set();
  const tsById = new Map();
  const idsFromRows = (rows) => {
    for (const row of arr(rows)) {
      for (const id of arr(row?.requestIdSamples)) if (str(id)) ids.add(id);
    }
  };
  for (const sample of samples) {
    if (str(sample?.id)) ids.add(sample.id);
    if (str(sample?.id) && str(sample?.ts)) tsById.set(sample.id, sample.ts);
  }
  // G3: the full requestIndex is the authoritative membership source; samples
  // and per-bucket requestIdSamples are only fallbacks for older artifacts.
  for (const item of requestIndex) {
    if (!str(item?.id)) continue;
    ids.add(item.id);
    if (str(item?.ts)) tsById.set(item.id, item.ts);
  }
  idsFromRows(dimensions.byClientPlatform);
  idsFromRows(dimensions.byFourDimension);
  idsFromRows(dimensions.byProtocolVersion);
  idsFromRows(dimensions.byClientProfile);
  for (const row of Object.values(input.serviceState?.byServer ?? {})) idsFromRows([row]);
  for (const row of Object.values(input.connectFailures?.byServer ?? {})) idsFromRows([row]);

  const platforms = new Set();
  for (const row of arr(dimensions.byClientPlatform)) if (str(row?.platform)) platforms.add(row.platform);
  for (const sample of samples) if (str(sample?.clientPlatform)) platforms.add(sample.clientPlatform);

  const commits = new Set();
  for (const sample of samples) if (str(sample?.buildCommit)) commits.add(sample.buildCommit);
  if (str(input?.filters?.commit)) commits.add(input.filters.commit);

  const timestamps = [
    ...samples.map((sample) => str(sample?.ts)),
    ...requestIndex.map((item) => str(item?.ts)),
  ].filter(Boolean);
  const requests = Number(input?.metrics?.requests ?? 0);

  return {
    input,
    dataStatus: str(input?.dataStatus) || (requests === 0 ? 'EMPTY_WINDOW' : 'HAS_DATA'),
    requests,
    requestIds: ids,
    requestIndex,
    tsById,
    platforms,
    commits,
    timestamps,
    serviceState: input.serviceState ?? { snapshots: 0, byServer: {}, offlineServers: [] },
    connectFailures: input.connectFailures ?? { failures: 0, byServer: {} },
  };
}

function buildCheck(activeBuild, passiveCommits) {
  const active = str(activeBuild).trim();
  if (!active || active === 'unknown' || passiveCommits.size === 0) return 'unknown';
  for (const commit of passiveCommits) {
    if (commit.startsWith(active) || active.startsWith(commit)) return 'match';
  }
  return 'mismatch';
}

function windowCheck(window, timestamps) {
  const from = Date.parse(str(window?.from));
  const to = Date.parse(str(window?.to));
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 'unknown';
  if (!timestamps.length) return 'unknown';
  const parsed = timestamps.map((ts) => Date.parse(ts)).filter(Number.isFinite);
  if (!parsed.length) return 'unknown';
  return parsed.some((ts) => ts >= from && ts <= to) ? 'match' : 'mismatch';
}

function platformCheck(activePlatform, passivePlatforms) {
  const platform = str(activePlatform).trim();
  if (!platform || platform === 'unknown' || passivePlatforms.size === 0) return 'unknown';
  return passivePlatforms.has(platform) ? 'match' : 'mismatch';
}

function requestIdCheck(activeIds, passiveIds, { window, tsById }) {
  const wanted = arr(activeIds).map(str).filter((id) => UUID_RE.test(id));
  if (!wanted.length) return { status: 'unknown', matched: [], missing: [], verified: [], unverified: [] };
  const matched = wanted.filter((id) => passiveIds.has(id));
  const from = Date.parse(str(window?.from));
  const to = Date.parse(str(window?.to));
  const inWindow = (id) => {
    const ts = tsById.get(id);
    if (!ts || !Number.isFinite(from) || !Number.isFinite(to)) return false;
    const parsed = Date.parse(ts);
    return Number.isFinite(parsed) && parsed >= from && parsed <= to;
  };
  const verified = matched.filter((id) => inWindow(id));
  const unverified = matched.filter((id) => !inWindow(id));
  const status = matched.length === 0 ? 'none' : (verified.length ? 'exact' : 'matched-ts-unverified');
  return { status, matched, missing: wanted.filter((id) => !passiveIds.has(id)), verified, unverified };
}

function serviceChecks(expectedServices, passive) {
  const checks = [];
  for (const service of arr(expectedServices)) {
    const name = str(service?.name).trim();
    if (!name) continue;
    const expected = service?.needsReauth === true || str(service?.status) === 'offline' ? 'offline' : 'online';
    const row = passive.serviceState?.byServer?.[name] ?? null;
    const latest = row?.latest ?? null;
    const passiveOffline = latest
      ? (latest.needsReauth === true || latest.status === 'offline')
      : Boolean(row && (row.needsReauth === true || (row.statuses?.offline ?? 0) > 0));
    const covered = expected === 'offline' ? passiveOffline : Boolean(row && !passiveOffline);
    checks.push({
      kind: 'service',
      subject: name,
      expected,
      covered,
      passiveStatus: row ? (latest ? `latest:${latest.status ?? 'unknown'}` : (passiveOffline ? 'offline' : 'online/observed')) : 'no-snapshot',
      reason: covered ? null : (row ? 'passive-status-differs' : 'no-services-snapshot'),
    });
  }
  return checks;
}

function connectChecks(expectedServers, passive) {
  return arr(expectedServers).map(str).filter(Boolean).map((server) => {
    const row = passive.connectFailures?.byServer?.[server];
    const offline = Boolean(row && Number(row.failures) > 0) || arr(passive.serviceState?.offlineServers).includes(server);
    return {
      kind: 'connect-failure',
      subject: server,
      expected: 'failed-connect',
      covered: offline,
      passiveStatus: offline ? 'connect-failure-visible' : 'not-visible',
      reason: offline ? null : 'no-connect-failure-or-offline-snapshot',
    };
  });
}

/**
 * Pure comparison. `active` is an active-eval.v1 object; `passive` is an
 * analyzer-input/analyzer-output object (or their wrapper).
 */
export function compareActivePassive(active, passive) {
  const view = normalizePassive(passive);
  const activeEvalId = str(active?.activeEvalId) || 'unknown';
  const window = active?.window ?? {};
  const checks = {
    build: buildCheck(active?.buildCommit, view.commits),
    platform: platformCheck(active?.platform, view.platforms),
    window: windowCheck(window, view.timestamps),
  };
  const requestIds = requestIdCheck(active?.observed?.requestIds, view.requestIds, {
    window,
    tsById: view.tsById,
  });
  checks.requestIds = requestIds.status;

  const serviceResults = serviceChecks(active?.observed?.services, view);
  const connectResults = connectChecks(active?.observed?.connectFailures, view);
  const coverage = [...serviceResults, ...connectResults];
  const missed = coverage.filter((row) => !row.covered);

  let match;
  const reasons = [];
  if (view.dataStatus === 'EMPTY_WINDOW') {
    match = 'unmatched';
    reasons.push('passive-window-is-empty (EMPTY_WINDOW is NOT a pass)');
  } else if (requestIds.status === 'exact' && checks.window === 'match' && checks.build !== 'mismatch' && checks.platform !== 'mismatch') {
    match = 'exact';
    reasons.push(`matched requestIds inside the active window: ${requestIds.verified.join(', ')}`);
  } else if (checks.window === 'match' && checks.platform === 'match' && checks.build !== 'mismatch') {
    match = 'likely';
    reasons.push('window+platform+build align; no requestId with a verified in-window timestamp');
  } else if (checks.window === 'match' && checks.platform !== 'mismatch') {
    match = 'weak';
    reasons.push('only the time window (and possibly platform) align');
  } else {
    match = 'unmatched';
    reasons.push('no window/platform/build overlap, or passive data is missing');
  }
  for (const row of missed) reasons.push(`missed ${row.kind}:${row.subject} (${row.reason})`);
  if (requestIds.status === 'matched-ts-unverified') {
    reasons.push('requestId matched but its timestamp is outside the active window or unknown; NOT exact');
  }
  if (checks.build === 'mismatch') reasons.push('buildCommit does not match the passive window (do not hard-compare across builds)');
  if (checks.platform === 'mismatch') reasons.push('clientPlatform does not match the passive window');

  return {
    schema: COMPARISON_SCHEMA,
    activeEvalId,
    generatedAt: new Date().toISOString(),
    match,
    reasons,
    checks,
    requestIds: {
      status: requestIds.status,
      matched: requestIds.matched,
      verified: requestIds.verified,
      unverified: requestIds.unverified,
      missing: requestIds.missing,
    },
    coverage,
    missed,
    passive: {
      dataStatus: view.dataStatus,
      requests: view.requests,
      platforms: [...view.platforms].sort(),
      buildCommits: [...view.commits].sort(),
      serviceSnapshots: Number(view.serviceState?.snapshots ?? 0),
      connectFailures: Number(view.connectFailures?.failures ?? 0),
    },
  };
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const { stdout = console.log, stderr = console.error } = deps;
  const arg = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : '');
  const activePath = arg('--active');
  const passivePath = arg('--passive');
  if (!activePath || !passivePath) {
    stderr('usage: compare-active-passive.mjs --active <active-eval.json> --passive <analyzer-input|output.json> [--request-index <full-index.json>] [--out <file>] [--json] [--require-match] [--allow-unmatched]');
    return 2;
  }
  let active;
  let passive;
  try {
    active = JSON.parse(await readFile(activePath, 'utf8'));
    passive = JSON.parse(await readFile(passivePath, 'utf8'));
    const requestIndexPath = arg('--request-index');
    if (requestIndexPath) {
      const extra = JSON.parse(await readFile(requestIndexPath, 'utf8'));
      const list = Array.isArray(extra) ? extra : (Array.isArray(extra?.requestIndex) ? extra.requestIndex : arr(extra?.requests));
      const input = passive?.input ?? passive;
      input.requestIndex = [...arr(input.requestIndex), ...arr(list)];
    }
  } catch (error) {
    stderr(`[compare] cannot read input: ${error.message}`);
    return 2;
  }
  const result = compareActivePassive(active, passive);
  const out = arg('--out');
  if (out) {
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    stdout(`[compare] wrote ${out}`);
  }
  if (argv.includes('--json')) stdout(JSON.stringify(result, null, 2));
  else stdout(`[compare] ${result.activeEvalId}: match=${result.match} missed=${result.missed.length} dataStatus=${result.passive.dataStatus}`);
  if (argv.includes('--require-match') && result.match !== 'exact' && result.match !== 'likely') return 1;
  // G4: empty/unmatched must not be green by default; explicit --allow-unmatched
  // is required for deliberate "we know this window is empty" runs.
  if (!argv.includes('--allow-unmatched')
    && (result.match === 'unmatched' || result.passive.dataStatus === 'EMPTY_WINDOW')) return 1;
  return 0;
}

const isDirectRun = typeof process.argv[1] === 'string' && /compare-active-passive\.mjs$/.test(process.argv[1]);
if (isDirectRun) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(`[compare] ${error?.message ?? String(error)}`);
    process.exitCode = 2;
  });
}
