#!/usr/bin/env node
/**
 * Offline Figma task-coverage audit.
 *
 * Checks that every retained tool (snapshot minus config deny/allow) has at
 * least one task, no task targets a denied/unknown tool, authority labels are
 * valid, and schema-reverse tasks still find their tool in the top-5 of the
 * production search catalog.
 *
 * Usage:
 *   node scripts/check-task-coverage.mjs --server figma
 *   node scripts/check-task-coverage.mjs --server figma --no-search
 */
import fs from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { searchEntries } from '../src/catalog.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const valueArg = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};

const serverName = valueArg('--server', 'figma');
const tasksPath = resolve(valueArg('--tasks', resolve(root, 'explore', `${serverName}-tasks.json`)));
const snapshotPath = resolve(valueArg('--snapshot', resolve(root, 'data', 'tool-snapshots', `${serverName}.json`)));
const configPath = resolve(valueArg('--config', resolve(root, 'config.example.json')));
const datasetPath = resolve(root, 'data', 'tool-dataset.json');

const AUTHORITIES = new Set(['official-verbatim', 'benchmark', 'schema-reverse']);

function matches(pattern, server, tool) {
  const value = String(pattern);
  if (value.includes('/')) {
    const [service, name] = value.split('/', 2);
    if (service !== server && service !== '*') return false;
    return name === '*' || name === tool;
  }
  return value === tool;
}

function retainedTools(server, snapshot) {
  const tools = Array.isArray(snapshot?.tools) ? snapshot.tools.map((tool) => tool.name) : [];
  return tools.filter((tool) => {
    if ((server.denyTools ?? []).some((pattern) => matches(pattern, server.name, tool))) return false;
    if (Array.isArray(server.allowTools) && server.allowTools.length > 0) {
      return server.allowTools.some((pattern) => matches(pattern, server.name, tool));
    }
    return true;
  });
}

/** Pure coverage check (used by CLI and tests). */
export function checkCoverage({ tasks, snapshot, server }) {
  const errors = [];
  const warnings = [];
  const retained = retainedTools(server, snapshot);
  const retainedSet = new Set(retained);
  const byTool = new Map();
  const ids = new Set();

  for (const task of tasks) {
    if (!task || typeof task !== 'object') {
      errors.push('task is not an object');
      continue;
    }
    if (!task.id) errors.push('task without id');
    else if (ids.has(task.id)) errors.push(`duplicate task id: ${task.id}`);
    else ids.add(task.id);
    if (!task.tool) errors.push(`task ${task.id ?? '?'} missing tool`);
    if (!task.prompt) errors.push(`task ${task.id ?? '?'} missing prompt`);
    if (!task.source) errors.push(`task ${task.id ?? '?'} missing source`);
    if (!AUTHORITIES.has(task.authority)) errors.push(`task ${task.id ?? '?'} invalid authority: ${task.authority}`);
    if (task.tool && !retainedSet.has(task.tool)) errors.push(`task ${task.id ?? '?'} targets non-retained tool: ${task.tool}`);
    if (Array.isArray(task.expectedTools) && task.tool && !task.expectedTools.includes(task.tool)) {
      errors.push(`task ${task.id ?? '?'} expectedTools must include ${task.tool}`);
    }
    if (task.tool) byTool.set(task.tool, (byTool.get(task.tool) ?? 0) + 1);
  }

  const missing = retained.filter((tool) => !byTool.has(tool));
  if (missing.length > 0) errors.push(`retained tools without tasks: ${missing.join(', ')}`);

  const extra = [...byTool.keys()].filter((tool) => !retainedSet.has(tool));
  if (extra.length > 0) errors.push(`tasks target tools outside retained set: ${extra.join(', ')}`);

  const counts = tasks.reduce((acc, task) => {
    if (task?.authority) acc[task.authority] = (acc[task.authority] ?? 0) + 1;
    return acc;
  }, {});

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    stats: {
      retained: retained.length,
      tasks: tasks.length,
      covered: retained.filter((tool) => byTool.has(tool)).length,
      missing,
      authority: counts,
      skipped: tasks.filter((task) => task.skipReason).length,
    },
    byTool,
  };
}

function searchValidation(tasks) {
  const dataset = JSON.parse(fs.readFileSync(datasetPath, 'utf8'));
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const server = (config.servers ?? []).find((item) => item.name === serverName);
  const enabled = dataset.filter((entry) => entry.server === serverName &&
    !(server.denyTools ?? []).some((pattern) => matches(pattern, serverName, entry.tool)));
  const schemaTasks = tasks.filter((task) => task.authority === 'schema-reverse');
  const misses = [];
  for (const task of schemaTasks) {
    const names = searchEntries(enabled, task.prompt, { limit: 5 }).matches.map((match) => match.name);
    if (!names.some((name) => name.toLowerCase().endsWith(`__${task.tool.toLowerCase()}`))) {
      misses.push({ id: task.id, tool: task.tool, prompt: task.prompt.slice(0, 100) });
    }
  }
  return { tested: schemaTasks.length, misses };
}

// The Figma tasks/snapshot/dataset files are private eval fixtures and are
// excluded from the clean OSS export. When they are absent (e.g. CI in a clean
// clone of the public repo), emit an explicit reason-bearing SKIP and exit 0
// so gate commands stay green; never silently fake a coverage result. In the
// private repo the fixtures exist and the original audit runs unchanged.
const missingFixtures = [tasksPath, snapshotPath, datasetPath].filter((p) => !fs.existsSync(p));
if (missingFixtures.length > 0) {
  console.log('SKIP: private eval fixtures excluded from the OSS export are missing: '
    + missingFixtures.map((p) => relative(root, p)).join(', ')
    + '; no coverage audit performed (see docs/OPEN-SOURCE/EXPORT-TEST-CURATION.md).');
  process.exit(0);
}

const tasksFile = JSON.parse(fs.readFileSync(tasksPath, 'utf8'));
const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const server = (config.servers ?? []).find((item) => item.name === serverName);
if (!server) {
  console.error(`[coverage] server not found: ${serverName}`);
  process.exit(1);
}

const result = checkCoverage({ tasks: tasksFile.tasks ?? [], snapshot, server });
const { stats } = result;
console.log(`[coverage] server=${serverName} tasks=${tasksPath}`);
console.log(`[coverage] retained=${stats.retained} tasks=${stats.tasks} covered=${stats.covered} skipped=${stats.skipped}`);
console.log(`[coverage] authority=${JSON.stringify(stats.authority)}`);
if (stats.missing.length > 0) console.log(`[coverage] missing=${stats.missing.join(', ')}`);
for (const error of result.errors) console.error(`  ✗ ${error}`);
for (const warning of result.warnings) console.log(`  ! ${warning}`);

if (!flag('--no-search') && result.ok) {
  const search = searchValidation(tasksFile.tasks ?? []);
  console.log(`[coverage] schema-reverse search: ${search.tested - search.misses.length}/${search.tested} top-5`);
  for (const miss of search.misses) console.error(`  ✗ search miss ${miss.id} ${miss.tool}: ${miss.prompt}`);
  if (search.misses.length > 0) result.ok = false;
}

if (!result.ok) process.exitCode = 1;
