#!/usr/bin/env node
/**
 * Offline search-recall diagnostic. No network, no model calls, no credentials.
 *
 * The gateway only searches the tools it actually exposes, so the default
 * catalog here is the production one: data/tool-dataset.json minus the
 * config.example.json deny lists. `--all` keeps the old (misleading) 456-tool
 * catalog for comparison only.
 *
 * Usage:
 *   node scripts/eval-search.mjs                      # top1/top5 + summary
 *   node scripts/eval-search.mjs --show-misses        # + the missed tasks
 *   node scripts/eval-search.mjs --limit=10           # wider recall window
 *   node scripts/eval-search.mjs --all                # old whole-dataset catalog
 *   node scripts/eval-search.mjs --tasks explore/figma-tasks.json
 *   node scripts/eval-search.mjs --tasks explore/figma-tasks.json --authority schema-reverse
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { searchEntries } from '../src/catalog.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const hasFlag = (name) => args.includes(name);
const limitArg = args.find((a) => a.startsWith('--limit='));
const limit = limitArg ? Number(limitArg.split('=')[1]) : 5;
const valueArg = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};

const tasksFile = path.resolve(root, valueArg('--tasks', 'explore/tasks-v2.json'));
const datasetFile = path.join(root, 'data', 'tool-dataset.json');
const authorityFilter = valueArg('--authority', null);

/** Private eval fixtures are excluded from the OSS export. Skip explicitly. */
function skipIfPrivateFixtureMissing(file, label) {
  if (fs.existsSync(file)) return false;
  console.log(`SKIP: ${label} not present (${path.relative(root, file)}) — private eval fixture excluded from OSS export`);
  return true;
}

if (skipIfPrivateFixtureMissing(tasksFile, 'tasks fixture')) process.exit(0);
if (skipIfPrivateFixtureMissing(datasetFile, 'tool dataset')) process.exit(0);

let tasks = JSON.parse(fs.readFileSync(tasksFile, 'utf8')).tasks;
if (authorityFilter) tasks = tasks.filter((task) => task.authority === authorityFilter);
const allTools = JSON.parse(fs.readFileSync(datasetFile, 'utf8'));
const config = JSON.parse(fs.readFileSync(path.join(root, 'config.example.json'), 'utf8'));

const denyByServer = new Map((config.servers ?? []).map((s) => [s.name, new Set(s.denyTools ?? [])]));
const enabled = allTools.filter((t) => !denyByServer.get(t.server)?.has(t.tool));
const catalog = hasFlag('--all') ? allTools : enabled;

const matchesTarget = (entryName, tool) =>
  String(entryName).toLowerCase().endsWith(`__${String(tool).toLowerCase()}`);

let top1 = 0;
let top5 = 0;
const misses = [];
for (const task of tasks) {
  const names = searchEntries(catalog, task.prompt, { limit }).matches.map((m) => m.name);
  const rank = names.findIndex((name) => matchesTarget(name, task.tool));
  if (rank === 0) top1++;
  if (rank >= 0) top5++;
  else misses.push({ tool: task.tool, prompt: task.prompt });
}

const pct = (n) => `${(n / tasks.length * 100).toFixed(1)}%`;
console.log(`catalog: ${hasFlag('--all') ? `ALL ${catalog.length}` : `PRODUCTION ${catalog.length}`} | tasks: ${tasks.length} | limit: ${limit}`);
console.log(`tasks file: ${tasksFile}${authorityFilter ? ` | authority: ${authorityFilter}` : ''}`);
console.log(`top1: ${pct(top1)} (${top1}/${tasks.length}) | top${limit}: ${pct(top5)} (${top5}/${tasks.length}) | misses: ${misses.length}`);
if (hasFlag('--show-misses')) {
  for (const miss of misses) console.log(`- ${miss.tool} :: ${miss.prompt.slice(0, 90)}`);
}
