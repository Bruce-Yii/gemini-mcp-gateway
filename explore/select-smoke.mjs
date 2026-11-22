#!/usr/bin/env node
/**
 * explore/select-smoke.mjs — deterministic L1 smoke task selection from G6.
 *
 * Pure + reproducible: given the SAME tasks-g6.json, this always picks the
 * SAME task ids (evenly spaced within each stratum). Task objects are copied
 * verbatim — prompts are never rewritten or hand-edited.
 *
 * Usage:
 *   node explore/select-smoke.mjs                    # write explore/tasks-smoke.json
 *   node explore/select-smoke.mjs --print            # stdout JSON only
 *   node explore/select-smoke.mjs --check            # verify committed file matches selection
 *
 * Importable pure helpers (no I/O at import time):
 *   selectSmokeTasks(tasks, opts) -> { tasks, stats, seed }
 *   SMOKE_SERVERS, SMOKE_CATEGORY_GROUPS, DEFAULT_SMOKE_SIZE
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');

/** Every upstream family must appear in L1. */
export const SMOKE_SERVERS = ['github', 'notion', 'linear', 'vercel', 'figma'];

/**
 * Category groups for stratification. G6 categories are:
 *   read / write / boundary / derived / cross / official
 * "derived"/"official" are mostly read-only, "cross" is mixed; we map them to
 * the closest intent bucket so that every server gets read + write + boundary
 * coverage where the source data actually contains those categories.
 */
export const SMOKE_CATEGORY_GROUPS = {
  read: ['read', 'derived', 'official'],
  write: ['write', 'cross'],
  boundary: ['boundary'],
};

export const DEFAULT_SMOKE_SIZE = 50;

/**
 * Evenly pick `n` items from `arr` without replacements and without randomness.
 * Uses the "stride" method: indices floor(i * len / n) for i in 0..n-1.
 * When n >= len, returns a copy of arr in original order.
 */
export function evenPick(arr, n) {
  if (!Number.isInteger(n) || n < 0) throw new TypeError('evenPick: n must be a non-negative integer');
  if (n === 0 || arr.length === 0) return [];
  if (n >= arr.length) return [...arr];
  const out = [];
  for (let i = 0; i < n; i++) out.push(arr[Math.floor((i * arr.length) / n)]);
  return out;
}

/**
 * Allocate `total` slots across servers, aiming for equal per-server counts but
 * never exceeding what a server can supply (after category constraints).
 * Remainder is handed to servers in SMOKE_SERVERS order (stable).
 */
export function allocatePerServer(tasks, total = DEFAULT_SMOKE_SIZE, servers = SMOKE_SERVERS) {
  const available = new Map(servers.map((s) => [s, tasks.filter((t) => t.server === s).length]));
  const out = new Map();
  let remaining = total;
  // First pass: equal share, capped by availability.
  for (const s of servers) {
    const share = Math.min(Math.floor(total / servers.length), available.get(s) ?? 0);
    out.set(s, share);
    remaining -= share;
  }
  // Second pass: distribute the remainder to servers with spare capacity.
  for (const s of servers) {
    if (remaining <= 0) break;
    const spare = (available.get(s) ?? 0) - (out.get(s) ?? 0);
    const add = Math.min(spare, remaining);
    out.set(s, (out.get(s) ?? 0) + add);
    remaining -= add;
  }
  return out;
}

/**
 * Select a stratified smoke set from a full task array.
 *
 * @param {Array} tasks full G6 tasks (verbatim objects)
 * @param {{size?:number, perServer?:number, quota?:Object}} opts
 * @returns {{tasks:Array, stats:Object, seed:string}}
 */
export function selectSmokeTasks(tasks, opts = {}) {
  const size = opts.size ?? DEFAULT_SMOKE_SIZE;
  if (!Array.isArray(tasks)) throw new TypeError('selectSmokeTasks: tasks must be an array');
  if (!Number.isInteger(size) || size < 1) throw new TypeError('selectSmokeTasks: size must be a positive integer');

  const quota = opts.perServer
    ? new Map(SMOKE_SERVERS.map((s) => [s, opts.perServer]))
    : allocatePerServer(tasks, size);

  // Group by server, then by intent bucket. A task belongs to the FIRST
  // matching bucket; category precedence matches SMOKE_CATEGORY_GROUPS order.
  const picked = [];
  const stats = { byServer: {}, byCategory: {}, byGroup: {}, total: 0 };
  const seen = new Set();

  for (const server of SMOKE_SERVERS) {
    const want = quota.get(server) ?? 0;
    if (want === 0) continue;
    const pool = tasks.filter((t) => t.server === server);
    const groups = {};
    for (const [group, cats] of Object.entries(SMOKE_CATEGORY_GROUPS)) {
      groups[group] = pool.filter((t) => cats.includes(t.category) && !seen.has(t.id));
    }
    // L1 needs meaningful write + boundary coverage, not a token 1 task each.
    // Guarantee up to MIN_NONREAD per non-read stratum when the source supports
    // it, then fill the remaining slots with read tasks.
    const MIN_NONREAD = 2;
    const groupKeys = Object.keys(groups).filter((k) => groups[k].length > 0);
    const alloc = {};
    let left = want;
    for (const k of groupKeys) {
      if (k !== 'read') { alloc[k] = Math.min(MIN_NONREAD, groups[k].length, left); left -= alloc[k]; }
    }
    // Give the rest to read first, then spread to write/boundary if read is short.
    alloc.read = Math.min(groups.read?.length ?? 0, left);
    left -= alloc.read;
    for (const k of groupKeys) {
      if (k === 'read' || alloc[k] === undefined) continue;
      const extra = Math.min(groups[k].length - alloc[k], left);
      alloc[k] += extra;
      left -= extra;
    }
    for (const k of groupKeys) {
      if (left <= 0) break;
      const extra = Math.min(groups[k].length - (alloc[k] ?? 0), left);
      alloc[k] = (alloc[k] ?? 0) + extra;
      left -= extra;
    }

    for (const group of groupKeys) {
      const chosen = evenPick(groups[group], alloc[group] ?? 0);
      for (const task of chosen) {
        if (seen.has(task.id)) continue;
        seen.add(task.id);
        picked.push(task); // verbatim — never clone-rewrite the prompt
        stats.byServer[server] = (stats.byServer[server] ?? 0) + 1;
        stats.byCategory[task.category] = (stats.byCategory[task.category] ?? 0) + 1;
        stats.byGroup[group] = (stats.byGroup[group] ?? 0) + 1;
        stats.total += 1;
      }
    }
  }

  return {
    tasks: picked,
    stats,
    seed: `deterministic:evenPick:v1:size=${size}`,
  };
}

/** Build the output document (metadata + verbatim tasks). */
export function buildSmokeDocument(full, opts = {}) {
  const { tasks, stats, seed } = selectSmokeTasks(full.tasks, opts);
  return {
    generatedBy: 'explore/select-smoke.mjs',
    source: 'explore/tasks-g6.json',
    seed,
    description: 'L1 smoke subset of G6 (deterministic, stratified). Task objects are verbatim copies from the source; prompts are never edited.',
    count: tasks.length,
    stats,
    tasks,
  };
}

function main() {
  const argv = process.argv.slice(2);
  const full = JSON.parse(fs.readFileSync(path.join(ROOT, 'explore/tasks-g6.json'), 'utf8'));
  const doc = buildSmokeDocument(full);
  if (argv.includes('--print')) {
    process.stdout.write(JSON.stringify(doc, null, 2) + '\n');
    return;
  }
  const outFile = path.join(ROOT, 'explore/tasks-smoke.json');
  if (argv.includes('--check')) {
    const committed = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    const ok = JSON.stringify(committed) === JSON.stringify(doc);
    console.log(ok ? 'tasks-smoke.json matches deterministic selection' : 'MISMATCH: tasks-smoke.json differs from deterministic selection');
    if (!ok) process.exitCode = 1;
    return;
  }
  fs.writeFileSync(outFile, JSON.stringify(doc, null, 2) + '\n');
  console.log(`wrote explore/tasks-smoke.json: ${doc.count} tasks`, JSON.stringify(doc.stats));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
