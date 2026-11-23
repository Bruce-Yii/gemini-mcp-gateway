/**
 * Offline integrity checks for the 2026-11-23 online↔semi-online JOIN batch.
 *
 * Validates two artifacts only:
 *   1. explore/tasks-online-gap-2.json — the new J1–J6 task set: parseable,
 *      schema-compatible with the existing G6/smoke shape, exact IDs, unique,
 *      all required fields, known expectedTools, dryRun/fake/no-real-writes
 *      defaults, the four online-only coverage axes, build-axis pairing, and
 *      no real credentials (no token/secret key names, no real paths).
 *   2. docs/eval/ONLINE-SEMIONLINE-JOIN-2026-11-23.md — parseable key fields
 *      (§6.1 machine-readable block) and the required join sections/tables.
 *
 * Pure/offline: reads two UTF-8 files from disk; no fetch, no child process,
 * no network, no token, no writes. It never imports or modifies src/, scripts/,
 * the existing N1–N9 task set, or any other test. No commit/push/deploy.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TASKS_FILE = path.join(ROOT, 'explore', 'tasks-online-gap-2.json');
const JOIN_DOC = path.join(ROOT, 'docs', 'eval', 'ONLINE-SEMIONLINE-JOIN-2026-11-23.md');
const SNAPSHOT_DIR = path.join(ROOT, 'data', 'tool-snapshots');

// Private eval fixtures are excluded from the OSS export. Guard top-level reads
// so the clean export loads this file and reports reason-bearing SKIPs instead
// of crashing with ENOENT (same rule as tests/online-gap-tasks.test.js).
const hasTaskFixtures = existsSync(TASKS_FILE) && existsSync(SNAPSHOT_DIR);
const hasJoinDoc = existsSync(JOIN_DOC);
const taskSkip = hasTaskFixtures
  ? false
  : 'private eval fixtures explore/tasks-online-gap-2.json + data/tool-snapshots are excluded from the OSS export';
const docSkip = hasJoinDoc
  ? false
  : 'join doc docs/eval/ONLINE-SEMIONLINE-JOIN-2026-11-23.md is absent in this checkout';
const taskTest = (name, fn) => test(name, { skip: taskSkip }, fn);
const docTest = (name, fn) => test(name, { skip: docSkip }, fn);

const REQUIRED_FIELDS = [
  'id', 'name', 'server', 'tool', 'prompt', 'source', 'category',
  'expectedTools', 'authority', 'coverageAxis', 'buildAxis',
  'closesFeedback', 'gapCodes', 'dryRun', 'forRealWrite', 'preconditions',
];
const REQUIRED_STRING_FIELDS = REQUIRED_FIELDS.filter(
  (f) => !['expectedTools', 'buildAxis', 'closesFeedback', 'gapCodes', 'preconditions', 'dryRun', 'forRealWrite'].includes(f),
);
const VALID_AUTHORITIES = new Set(['official-verbatim', 'benchmark', 'schema-reverse']);
const EXPECTED_IDS = ['J1', 'J2', 'J3', 'J4', 'J5', 'J6'];
const REQUIRED_AXES = [
  'batch-wrapper-contract',
  'truncation-tail-metadata',
  'ci-wait-helper',
  'atomic-by-default',
];
// Keys that would indicate a real credential/path leaked into the task set.
const FORBIDDEN_CREDENTIAL_PATTERN =
  /\b(GITHUB_TOKEN|GH_TOKEN|OPENAI_API_KEY|ANTHROPIC_API_KEY|client[_-]?secret|access[_-]?token|refresh[_-]?token|Bearer\s+\S+|\\[A-Za-z0-9_]+\\.secrets\\)\b/i;

let tasks;
let taskParseError;
if (hasTaskFixtures) {
  try {
    tasks = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
  } catch (err) {
    taskParseError = err;
  }
}

/** Set of every known tool name across snapshots (bare and server__tool). */
function knownToolNames() {
  const names = new Set();
  for (const file of fs.readdirSync(SNAPSHOT_DIR).filter((f) => f.endsWith('.json'))) {
    const snap = JSON.parse(fs.readFileSync(path.join(SNAPSHOT_DIR, file), 'utf8'));
    const server = snap.server || path.basename(file, '.json');
    for (const tool of (Array.isArray(snap.tools) ? snap.tools : [])) {
      if (!tool || typeof tool.name !== 'string') continue;
      const bare = tool.name.includes('__') ? tool.name.split('__').slice(1).join('__') : tool.name;
      names.add(tool.name);
      names.add(bare);
      names.add(`${server}__${bare}`);
    }
  }
  for (const t of ['search', 'execute_read', 'execute']) names.add(t);
  return names;
}
const KNOWN = hasTaskFixtures ? knownToolNames() : new Set();

// ---------------------------------------------------------------------------
// 1. Task-set checks (J1–J6)
// ---------------------------------------------------------------------------

taskTest('join tasks: JSON parses with the expected top-level shape', () => {
  assert.equal(taskParseError, undefined, `tasks-online-gap-2.json must parse: ${taskParseError?.message}`);
  assert.ok(tasks && typeof tasks === 'object', 'top level must be an object');
  assert.ok(Array.isArray(tasks.tasks), 'tasks must be an array');
  assert.equal(tasks.realWritesAllowed, false, 'task set must forbid real writes');
  assert.equal(tasks.defaults?.dryRun, true, 'defaults.dryRun must be true');
  assert.equal(tasks.defaults?.forRealWrite, false, 'defaults.forRealWrite must be false');
});

taskTest('join tasks: exactly 6 tasks J1–J6 with unique IDs', () => {
  assert.equal(tasks.count, 6, 'declared count must be 6');
  assert.equal(tasks.tasks.length, 6, 'must contain exactly 6 tasks');
  const ids = tasks.tasks.map((t) => t.id);
  assert.deepEqual([...ids].sort(), [...EXPECTED_IDS].sort(), 'IDs must be exactly J1..J6');
  assert.equal(new Set(ids).size, ids.length, 'task IDs must be unique');
});

taskTest('join tasks: every task has all required fields with valid values', () => {
  for (const task of tasks.tasks) {
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
      task.expectedTools.includes(task.tool) || task.expectedTools.some((t) => t.endsWith(`__${task.tool}`)),
      `${task.id}: expectedTools must include the task tool ${task.tool}`,
    );
    if (Array.isArray(task.expectedOps)) {
      assert.ok(task.expectedOps.every((op) => typeof op === 'string'), `${task.id}: expectedOps must be strings`);
    }
  }
});

taskTest('join tasks: no expectedTools name references a nonexistent tool', () => {
  for (const task of tasks.tasks) {
    for (const name of task.expectedTools) {
      assert.ok(
        KNOWN.has(name) || KNOWN.has(name.split('__').slice(1).join('__')),
        `${task.id}: unknown tool ${name} in expectedTools`,
      );
    }
  }
});

taskTest('join tasks: every task is dryRun/fake with documented preconditions', () => {
  for (const task of tasks.tasks) {
    assert.equal(task.dryRun, true, `${task.id}: dryRun must be true`);
    assert.equal(task.forRealWrite, false, `${task.id}: forRealWrite must be false`);
    assert.ok(
      Array.isArray(task.preconditions) && task.preconditions.length > 0,
      `${task.id}: preconditions must document the fake/no-network boundary`,
    );
    assert.match(
      task.prompt, /fake|replay|no real|no network/i,
      `${task.id}: prompt must state the fake/no-real boundary`,
    );
  }
  const writeTasks = tasks.tasks.filter((t) => t.category === 'write');
  assert.equal(writeTasks.length, 1, 'exactly one write-category task (J5)');
  assert.match(
    writeTasks[0].prompt, /dryRun=true|forRealWrite=false|no real/i,
    'J5 prompt must explicitly forbid real writes',
  );
});

taskTest('join tasks: the four online-only coverage axes are present and mapped to F3–F6', () => {
  const byId = Object.fromEntries(tasks.tasks.map((t) => [t.id, t]));
  const axisMap = [
    ['J3', 'batch-wrapper-contract', 'F3'],
    ['J4', 'truncation-tail-metadata', 'F4'],
    ['J5', 'atomic-by-default', 'F5'],
    ['J6', 'ci-wait-helper', 'F6'],
  ];
  for (const [id, axis, feedback] of axisMap) {
    assert.equal(byId[id]?.coverageAxis, axis, `${id}: wrong coverageAxis`);
    assert.ok(byId[id].closesFeedback.includes(feedback), `${id}: must close ${feedback}`);
    assert.ok(byId[id].gapCodes.includes('G3'), `${id}: online-only axis must carry gap code G3`);
  }
  for (const axis of REQUIRED_AXES) {
    assert.ok(tasks.tasks.some((t) => t.coverageAxis === axis), `missing online-only axis ${axis}`);
  }
  // J1/J2 close the deploy-blocked F1/F2 pair and are build-paired.
  assert.deepEqual(byId.J1?.closesFeedback, ['F1']);
  assert.deepEqual(byId.J2?.closesFeedback, ['F2']);
  for (const id of ['J1', 'J2']) {
    const axes = byId[id].buildAxis;
    assert.ok(Array.isArray(axes) && axes.includes('checkout-current'), `${id}: must pair on checkout-current`);
    assert.ok(axes.includes('prod-old-2026-11-23'), `${id}: must label the old-build observation`);
  }
});

taskTest('join tasks: build-axis pairing forbids cross-build hard comparison', () => {
  assert.match(
    tasks.defaults.comparison ?? '', /same-prompt-same-build-paired|cross-build-hard-compare=forbidden/i,
    'defaults must encode the same-build pairing rule',
  );
  assert.equal(tasks.defaults.requestIds, 'unknown', 'requestIds policy must be unknown (never fabricated)');
  for (const task of tasks.tasks) {
    assert.ok(task.buildAxis.length > 0, `${task.id}: buildAxis must not be empty`);
  }
});

taskTest('join tasks: no real credentials or secret paths in the task set', () => {
  const raw = fs.readFileSync(TASKS_FILE, 'utf8');
  assert.doesNotMatch(raw, FORBIDDEN_CREDENTIAL_PATTERN, 'task set must not contain credential key names or secret paths');
  for (const task of tasks.tasks) {
    assert.doesNotMatch(task.prompt, FORBIDDEN_CREDENTIAL_PATTERN, `${task.id}: prompt leaks a credential reference`);
  }
});

taskTest('join tasks: join metadata references the correct sources and states', () => {
  assert.equal(tasks.join.joinDate, '2026-11-23');
  assert.equal(tasks.join.onlineRecord, 'docs/eval/online-feedback-2026-11-23-gemini.md');
  assert.equal(tasks.join.semiOnlineSource, 'docs/eval/SEMI-ONLINE-GAPS.md');
  assert.equal(tasks.join.existingTaskSet, 'explore/tasks-online-gap.json');
  assert.deepEqual(tasks.join.deployBlockedFeedback, ['F1', 'F2']);
  assert.deepEqual(tasks.join.needsReproFeedback, ['F3', 'F4', 'F5']);
  assert.deepEqual(tasks.join.unknownFeedback, ['F6']);
  assert.deepEqual([...tasks.join.coveredFeedback].sort(), ['F1', 'F2', 'F3', 'F4', 'F5', 'F6']);
});

// ---------------------------------------------------------------------------
// 2. Join-document checks (parseable key fields, no prose-only claims)
// ---------------------------------------------------------------------------

const joinDoc = hasJoinDoc ? fs.readFileSync(JOIN_DOC, 'utf8') : '';

/** Parse the deterministic `KEY: value` block in §6.1 (and top-level keys). */
function parseJoinKeys(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Z][A-Z0-9_]*):\s*(.+?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}
const JOIN_KEYS = parseJoinKeys(joinDoc);

docTest('join doc: all §6.1 machine-readable key fields are present', () => {
  const required = [
    'JOIN_DATE', 'ONLINE_RECORD', 'SEMI_ONLINE_SOURCE', 'EXISTING_TASK_SET',
    'NEW_TASK_SET', 'TASK_IDS', 'REQUIRED_AXES', 'ONLINE_ONLY_GAPS',
    'DEPLOY_BLOCKED', 'NEEDS_REPRO', 'UNKNOWN', 'REQUEST_ID_POLICY',
    'CAPTURE_VERIFIED', 'COMPARISON_RULE',
  ];
  for (const key of required) {
    assert.ok(Object.hasOwn(JOIN_KEYS, key), `join doc missing machine-readable key ${key}`);
  }
});

docTest('join doc: key field values agree with the new task set', () => {
  assert.equal(JOIN_KEYS.JOIN_DATE, '2026-11-23');
  assert.equal(JOIN_KEYS.ONLINE_RECORD, 'docs/eval/online-feedback-2026-11-23-gemini.md');
  assert.equal(JOIN_KEYS.NEW_TASK_SET, 'explore/tasks-online-gap-2.json');
  assert.equal(JOIN_KEYS.EXISTING_TASK_SET, 'explore/tasks-online-gap.json (N1-N9, unchanged)');
  assert.equal(JOIN_KEYS.TASK_IDS, 'J1,J2,J3,J4,J5,J6');
  assert.equal(
    JOIN_KEYS.REQUIRED_AXES,
    'batch-wrapper-contract,truncation-tail-metadata,ci-wait-helper,atomic-by-default',
  );
  assert.deepEqual(JOIN_KEYS.REQUIRED_AXES.split(','), REQUIRED_AXES);
  assert.equal(JOIN_KEYS.DEPLOY_BLOCKED, 'F1,F2');
  assert.equal(JOIN_KEYS.NEEDS_REPRO, 'F3,F4,F5');
  assert.equal(JOIN_KEYS.UNKNOWN, 'F6');
  assert.match(JOIN_KEYS.REQUEST_ID_POLICY, /unknown/i);
  assert.match(JOIN_KEYS.CAPTURE_VERIFIED, /false/i);
  assert.match(JOIN_KEYS.COMPARISON_RULE, /cross-build-hard-compare=forbidden/i);
});

docTest('join doc: the F1–F6 join matrix exists and every row has all status columns', () => {
  assert.match(joinDoc, /^## 1\. 主 join 矩阵/m, 'join matrix section must exist');
  for (const id of ['F1', 'F2', 'F3', 'F4', 'F5', 'F6']) {
    assert.match(joinDoc, new RegExp(`\\| \\*\\*${id}\\*\\*`), `matrix row for ${id} must exist`);
  }
  for (const status of ['covered', 'weak', 'missing']) {
    assert.ok(joinDoc.includes(`\`${status}\``), `coverage enum ${status} must be documented`);
  }
  for (const status of ['fixed', 'pending-deploy', 'unknown']) {
    assert.ok(joinDoc.includes(`\`${status}\``), `code-layer enum ${status} must be documented`);
  }
  for (const code of ['G1', 'G2', 'G3', 'G4', 'G5', 'G6']) {
    assert.ok(joinDoc.includes(`\`${code}\``), `gap code ${code} must be defined`);
  }
});

docTest('join doc: same-build pairing rules and no-fabrication rules are explicit', () => {
  assert.match(joinDoc, /禁止跨构建硬比/);
  assert.match(joinDoc, /禁止 requestId 编造/);
  assert.match(joinDoc, /同一 prompt\/task.*旧生产构建.*新代码构建/s);
  assert.match(joinDoc, /prod-old-2026-11-23/);
  assert.match(joinDoc, /checkout-current/);
});

docTest('join doc: conclusions split semi-online gaps from deploy-only and post-deploy items', () => {
  assert.match(joinDoc, /^## 5\. 结论/m);
  assert.match(joinDoc, /^### 5\.1 说明「半在线缺口」的问题/m);
  assert.match(joinDoc, /^### 5\.2 只是「旧构建未部署」的问题/m);
  assert.match(joinDoc, /^### 5\.3 需要部署后在线复验的问题/m);
});
