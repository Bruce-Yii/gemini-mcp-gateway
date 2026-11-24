#!/usr/bin/env node
/**
 * Incremental capture sync.
 *
 * Why: Cloudflare R2's REST API is limited to 1,200 requests / 5 minutes and
 * object keys carry no timestamp, so a "last 90 minutes" filter still has to
 * read every object of the day. Re-reading the same day on every hourly run is
 * both wasteful and the reason a single run can burst past the quota.
 *
 * This script keeps a local store:
 *   <dir>/manifest.json      -> { version, keys: [already-fetched object keys] }
 *   <dir>/envelopes.ndjson   -> every envelope fetched so far, pruned by ts
 *
 * Each run:
 *   1. lists the day prefixes that overlap the retention window (cheap: 1-2
 *      LIST calls per day, per_page=1000);
 *   2. computes the keys it has never fetched;
 *   3. GETs ONLY those new envelopes (usually a handful);
 *   4. appends them to the store, prunes envelopes older than --retain-minutes;
 *   5. writes the manifest back.
 *
 * The store is then the single local input for digest/analyzer, so retrospective
 * analysis costs zero R2 reads. `--max-fetch` is a hard guard: if a run would
 * fetch more than the budget it fails loudly instead of silently bursting.
 *
 * Usage:
 *   node scripts/sync-captures.mjs --dir work/capture-store --retain-minutes 1440
 *   node scripts/sync-captures.mjs --dir work/capture-store --dry-run --json
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { listR2Keys, readR2Envelope } from './capture-digest.mjs';

export const SYNC_SCHEMA = 'capture-sync.v1';
const DEFAULT_RETAIN_MINUTES = 24 * 60;
const DEFAULT_MAX_FETCH = 900; // cold-start seed stays under the 1200/5min budget

const str = (value) => (typeof value === 'string' ? value : '');

function tsOf(envelope) {
  const parsed = Date.parse(str(envelope?.ts));
  return Number.isFinite(parsed) ? parsed : null;
}

/** Day prefixes (UTC) that overlap [now - retainMinutes, now]. */
export function dayPrefixes(retainMinutes, now = new Date()) {
  const start = new Date(now.getTime() - retainMinutes * 60 * 1000);
  const days = new Set([start.toISOString().slice(0, 10), now.toISOString().slice(0, 10)]);
  return [...days].sort();
}

/** Envelope rows encoded as NDJSON (deterministic, newline-terminated). */
export function encodeStore(envelopes) {
  const rows = Array.isArray(envelopes) ? envelopes : [];
  return rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '');
}

export function decodeStore(text) {
  const rows = [];
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    rows.push(JSON.parse(trimmed));
  }
  return rows;
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * Pure planning step: given already-seen keys and the keys present in R2,
 * return the new keys (order preserved) and the ones dropped from the store.
 */
export function planSync({ seen = [], present = [], maxFetch = DEFAULT_MAX_FETCH } = {}) {
  const seenSet = new Set(seen);
  const presentSet = new Set(present);
  const newKeys = present.filter((key) => !seenSet.has(key));
  if (newKeys.length > maxFetch) {
    const error = new Error(
      `SYNC_FETCH_BUDGET_EXCEEDED: ${newKeys.length} new objects exceed --max-fetch=${maxFetch}; `
      + 'refusing to burst the R2 REST quota (1200 req/5min). Lower --retain-minutes or raise --max-fetch deliberately.',
    );
    error.code = 'SYNC_FETCH_BUDGET_EXCEEDED';
    throw error;
  }
  // Keep only keys that still exist, so the manifest cannot grow forever.
  const nextSeen = [...seenSet].filter((key) => presentSet.has(key)).concat(newKeys);
  return { newKeys, seen: nextSeen };
}

/**
 * One sync pass. All I/O is injectable so tests never touch the network.
 * `listKeys(prefix)` -> string[]; `readEnvelope(key)` -> envelope.
 */
export async function syncCaptures({
  dir,
  retainMinutes = DEFAULT_RETAIN_MINUTES,
  maxFetch = DEFAULT_MAX_FETCH,
  now = new Date(),
  listKeys = (prefix) => listR2Keys(prefix),
  readEnvelope = (key) => readR2Envelope(key),
  dryRun = false,
} = {}) {
  if (!dir) throw new Error('syncCaptures: dir is required');
  const storeFile = join(dir, 'envelopes.ndjson');
  const manifestFile = join(dir, 'manifest.json');

  const previous = await readJson(manifestFile, null);
  const seen = Array.isArray(previous?.keys) ? previous.keys : [];
  const previousEnvelopes = dryRun ? [] : decodeStore(await readFile(storeFile, 'utf8').catch(() => ''));

  const presentKeys = new Set();
  for (const day of dayPrefixes(retainMinutes, now)) {
    const keys = await listKeys(`capture/${day}/`);
    for (const key of keys) presentKeys.add(key);
  }
  const present = [...presentKeys];

  const { newKeys, seen: nextSeen } = planSync({ seen, present, maxFetch });

  const fetched = [];
  for (const key of newKeys) fetched.push(await readEnvelope(key));

  const cutoff = now.getTime() - retainMinutes * 60 * 1000;
  const byId = new Map();
  for (const envelope of [...previousEnvelopes, ...fetched]) {
    const ts = tsOf(envelope);
    if (ts !== null && ts < cutoff) continue;
    const id = str(envelope?.requestId) || JSON.stringify(envelope).slice(0, 64);
    byId.set(id, envelope);
  }
  const merged = [...byId.values()].sort((a, b) => (tsOf(a) ?? 0) - (tsOf(b) ?? 0));

  const result = {
    schema: SYNC_SCHEMA,
    dir,
    retainMinutes,
    days: dayPrefixes(retainMinutes, now),
    presentKeys: present.length,
    seenKeysBefore: seen.length,
    newKeys: newKeys.length,
    fetchedEnvelopes: fetched.length,
    storedEnvelopes: merged.length,
    maxFetch,
    dryRun,
    storeFile,
    manifestFile,
  };

  if (!dryRun) {
    await mkdir(dir, { recursive: true });
    await writeFile(storeFile, encodeStore(merged), 'utf8');
    await writeFile(manifestFile, `${JSON.stringify({ version: SYNC_SCHEMA, updatedAt: now.toISOString(), keys: nextSeen }, null, 2)}\n`, 'utf8');
  }
  return result;
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const { stdout = console.log, stderr = console.error } = deps;
  const arg = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : '');
  const dir = arg('--dir');
  if (!dir) {
    stderr('usage: sync-captures.mjs --dir <store-dir> [--retain-minutes 1440] [--max-fetch 400] [--dry-run] [--json]');
    return 2;
  }
  const retainMinutes = Number(arg('--retain-minutes') || DEFAULT_RETAIN_MINUTES);
  const maxFetch = Number(arg('--max-fetch') || DEFAULT_MAX_FETCH);
  try {
    const result = await syncCaptures({
      dir,
      retainMinutes: Number.isFinite(retainMinutes) && retainMinutes > 0 ? retainMinutes : DEFAULT_RETAIN_MINUTES,
      maxFetch: Number.isFinite(maxFetch) && maxFetch > 0 ? maxFetch : DEFAULT_MAX_FETCH,
      dryRun: argv.includes('--dry-run'),
    });
    if (argv.includes('--json')) stdout(JSON.stringify(result, null, 2));
    else stdout(`[sync] present=${result.presentKeys} new=${result.newKeys} stored=${result.storedEnvelopes} -> ${result.storeFile}`);
    return 0;
  } catch (error) {
    stderr(`[sync] ${error?.message ?? String(error)}`);
    return 1;
  }
}

const isDirectRun = typeof process.argv[1] === 'string' && /sync-captures\.mjs$/.test(process.argv[1]);
if (isDirectRun) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(`[sync] ${error?.message ?? String(error)}`);
    process.exitCode = 1;
  });
}


