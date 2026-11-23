/**
 * Schema + integrity checks for explore/tasks-online-gap.json (SEMI-ONLINE-GAPS
 * N1–N9). Pure/offline only: reads the task JSON and the tool snapshots from
 * disk, no network, no token, no writes. It never imports or modifies the
 * existing task sets (tasks-smoke.json / tasks-g6.json) or src/scripts.
 *
 * Validates: JSON parseable; task count; unique IDs; required fields; every
 * expectedTools name exists in the retained tool snapshots (either as a bare
 * name or as a `server__tool` entry); write-capable tasks default to dryRun
 * with no real writes. No commit / push / deploy.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TASKS_FILE = path.join(ROOT, 'explore', 'tasks-online-gap.json');
const SNAPSHOT_DIR = path.join(ROOT, 'data', 'tool-snapshots');

const REQUIRED_FIELDS = [
  'id', 'name', 'server', 'category', 'prompt', 'expectedTools', 'authority',
];
const REQUIRED_STRING_FIELDS = REQUIRED_FIELDS.filter((f) => f !== 'expectedTools');
const VALID_AUTHORITIES = new Set(['official-verbatim', 'benchmark', 'schema-reverse']);
const EXPECTED_IDS = ['N1', 'N2', 'N3', 'N4', 'N5', 'N6', 'N7', 'N8', 'N9'];

let parsed;
let parseError;
try {
  parsed = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
} catch (err) {
  parseError = err;
}

/** Set of every known tool name across all snapshots (bare and server__tool). */
function knownToolNames() {
  const names = new Set();
  for (const file of fs.readdirSync(SNAPSHOT_DIR).filter((f) => f.endsWith('.json'))) {
    const snap = JSON.parse(fs.readFileSync(path.join(SNAPSHOT_DIR, file), 'utf8'));
    const server = snap.server || path.basename(file, '.json');
    const tools = Array.isArray(snap.tools) ? snap.tools : [];
    for (const tool of tools) {
      if (!tool || typeof tool.name !== 'string') continue;
      const bare = tool.name.includes('__') ? tool.name.split('__').slice(1).join('__') : tool.name;
      names.add(tool.name);
      names.add(bare);
      names.add(`${server}__${bare}`);
    }
  }
  // The three Code Mode gateway tools.
  for (const t of ['search', 'execute_read', 'execute']) names.add(t);
  return names;
}

const KNOWN = knownToolNames();

test('online-gap tasks: JSON is parseable and has the expected top-level shape', () => {
  assert.equal(parseError, undefined, `tasks-online-gap.json must parse: ${parseError?.message}`);
  assert.ok(parsed && typeof parsed === 'object', 'top level must be an object');
  assert.ok(Array.isArray(parsed.tasks), 'tasks must be an array');
  assert.equal(parsed.realWritesAllowed, false, 'task set must forbid real writes');
});

test('online-gap tasks: exactly 9 tasks N1–N9 with unique IDs', () => {
  assert.equal(parsed.count, 9, 'declared count must be 9');
  assert.equal(parsed.tasks.length, 9, 'must contain exactly 9 tasks');
  const ids = parsed.tasks.map((t) => t.id);
  assert.deepEqual([...ids].sort(), [...EXPECTED_IDS].sort(), 'IDs must be exactly N1..N9');
  assert.equal(new Set(ids).size, ids.length, 'task IDs must be unique');
});

test('online-gap tasks: every task has all required fields with valid values', () => {
  for (const task of parsed.tasks) {
    for (const field of REQUIRED_FIELDS) {
      assert.ok(Object.hasOwn(task, field), `${task.id}: missing required field ${field}`);
    }
    for (const field of REQUIRED_STRING_FIELDS) {
      assert.ok(
        typeof task[field] === 'string' && task[field].length > 0,
        `${task.id}: ${field} must be a non-empty string`,
      );
    }
    assert.ok(VALID_AUTHORITIES.has(task.authority), `${task.id}: invalid authority ${task.authority}`);
    assert.ok(
      Array.isArray(task.expectedTools) && task.expectedTools.length > 0,
      `${task.id}: expectedTools must be a non-empty array`,
    );
    assert.ok(
      typeof task.tool === 'string' && task.tool.length > 0,
      `${task.id}: tool must be present for coverage compatibility`,
    );
    assert.ok(
      task.expectedTools.includes(task.tool) || task.expectedTools.some((t) => t.endsWith(`__${task.tool}`)),
      `${task.id}: expectedTools must include the task tool ${task.tool}`,
    );
    if (Array.isArray(task.expectedOps)) {
      assert.ok(task.expectedOps.every((op) => typeof op === 'string'), `${task.id}: expectedOps must be strings`);
    }
  }
});

test('online-gap tasks: no expectedTools name references a nonexistent tool', () => {
  for (const task of parsed.tasks) {
    for (const name of task.expectedTools) {
      assert.ok(
        KNOWN.has(name) || KNOWN.has(name.split('__').slice(1).join('__')),
        `${task.id}: unknown tool ${name} in expectedTools`,
      );
    }
  }
});

test('online-gap tasks: write-capable and all tasks default to dryRun with no real write', () => {
  for (const task of parsed.tasks) {
    assert.equal(task.dryRun, true, `${task.id}: dryRun must be true by default`);
    assert.equal(task.forRealWrite, false, `${task.id}: forRealWrite must be false (no real writes)`);
    assert.ok(
      Array.isArray(task.preconditions) && task.preconditions.length > 0,
      `${task.id}: preconditions must document the fake/no-network boundary`,
    );
  }
  const writeTasks = parsed.tasks.filter((t) => t.category === 'write');
  assert.ok(writeTasks.length >= 1, 'at least one write-category task must exist (N9)');
  for (const task of writeTasks) {
    assert.match(
      task.prompt, /dryRun|forRealWrite|no real/i,
      `${task.id}: write task prompt must explicitly forbid real writes`,
    );
  }
});

test('online-gap tasks: N1–N9 cover all required SEMI-ONLINE-GAPS axes', () => {
  const byId = Object.fromEntries(parsed.tasks.map((t) => [t.id, t]));
  const asserts = [
    ['N1', /byte|readback/i],
    ['N2', /branch|ref/i],
    ['N3', /number|url/i],
    ['N4', /search|probe|enum/i],
    ['N5', /actions|job logs|302/i],
    ['N6', /truncat|pagina/i],
    ['N7', /session|reconnect|unknown_tool/i],
    ['N8', /gemini|chatgpt|claude/i],
    ['N9', /atomic|postcondition|write/i],
  ];
  for (const [id, re] of asserts) {
    const task = byId[id];
    assert.ok(task, `missing task ${id}`);
    assert.match(`${task.prompt} ${task.expectedOps?.join(' ') ?? ''}`, re, `${id}: required axis not represented`);
  }
});
