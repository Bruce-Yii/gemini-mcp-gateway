/**
 * Offline wiring tests for the OPTIONAL `--profile online-gap` of the L1 smoke
 * runner (N1–N9 + J1–J6). Covers: task load counts, explicit SKIP for unknown
 * tasks / missing fixtures, frozen-baseline isolation (read-only, keyed by
 * task id + fixture hash, current results in a separate file), extended metric
 * fields (unknown when not computable), 0 fail in the default fake path, and
 * determinism. No network, no credentials, no writes to src/, no commit.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  ROOT, parseArgs,
  ONLINE_GAP_PROFILE, ONLINE_GAP_TASK_FILES, ONLINE_GAP_EXPECTED_IDS,
  ONLINE_GAP_METRIC_KEYS, ONLINE_GAP_BASELINE_FILE,
  ONLINE_GAP_RESULT_JSON, ONLINE_GAP_RESULT_MD,
  loadOnlineGapTasks, checkFixtures, fixtureHashForTask, baselineIdentity,
  freezeOnlineGapBaseline, loadOnlineGapBaseline, compareOnlineGapCurrent,
  computeOnlineGapMetrics, renderOnlineGapReport, runOnlineGapProfile,
} from '../scripts/run-l1-smoke.mjs';

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const hasFixtures = ONLINE_GAP_TASK_FILES.every((f) => fs.existsSync(path.join(ROOT, f)));
const fixtureSkip = hasFixtures
  ? false
  : 'private eval fixtures explore/tasks-online-gap{,-2}.json are excluded from the OSS export (see docs/OPEN-SOURCE/EXPORT-TEST-CURATION.md)';
const fixtureTest = (name, fn) => test(name, { skip: fixtureSkip }, fn);

/* ------------------------------------------------------------------ *
 * 1. CLI surface: profile is opt-in; default parse is unchanged
 * ------------------------------------------------------------------ */

test('online-gap profile: parseArgs defaults profile to null (legacy L1 untouched)', () => {
  assert.equal(parseArgs([]).profile, null);
  assert.equal(parseArgs(['--mode', 'fake']).profile, null);
  assert.equal(parseArgs(['--profile', ONLINE_GAP_PROFILE]).profile, 'online-gap');
  assert.equal(parseArgs(['--profile=online-gap']).profile, 'online-gap');
});

/* ------------------------------------------------------------------ *
 * 2. Task loading: exact N1–N9 + J1–J6, unique, no silent pass
 * ------------------------------------------------------------------ */

fixtureTest('load: exactly 15 tasks (N1–N9 + J1–J6), unique ids, zero SKIP when fixtures present', () => {
  const { tasks, skips } = loadOnlineGapTasks();
  assert.equal(tasks.length, 15, 'must load N1–N9 + J1–J6');
  assert.deepEqual(
    [...tasks.map((t) => t.id)].sort(),
    [...ONLINE_GAP_EXPECTED_IDS].sort(),
  );
  assert.equal(new Set(tasks.map((t) => t.id)).size, 15, 'ids must be unique');
  assert.deepEqual(skips, [], 'no task should be skipped when all fixtures exist');
  assert.ok(tasks.every((t) => t.dryRun === true && t.forRealWrite === false));
});

test('load: unknown task ids are explicit SKIP, never counted as loaded/pass', () => {
  const doc = {
    tasks: [
      { id: 'N1', server: 'github', tool: 'get_file_contents', dryRun: true, forRealWrite: false, preconditions: [] },
      { id: 'Z9', server: 'github', tool: 'x', dryRun: true, forRealWrite: false, preconditions: [] },
    ],
  };
  const read = () => doc;
  const { tasks, skips } = loadOnlineGapTasks({
    files: ['fake.json'],
    expectedIds: ['N1'], // canonical set: Z9 is not declared => unknown
    exists: () => true,
    read,
  });
  assert.deepEqual(tasks.map((t) => t.id), ['N1']);
  const z = skips.find((s) => s.id === 'Z9');
  assert.ok(z, 'unknown id must produce a SKIP record');
  assert.equal(z.kind, 'unknown-task');
  assert.match(z.reason, /SKIP: unknown task id/);
});

test('load: missing task file and missing fixture produce reason-bearing SKIPs', () => {
  const { tasks, skips } = loadOnlineGapTasks({
    files: ['absent.json', 'fixtures.json'],
    expectedIds: ['N1'],
    exists: (p) => p.endsWith('fixtures.json'),
    read: () => ({
      tasks: [{
        id: 'N1', dryRun: true, forRealWrite: false,
        preconditions: ['fake upstream fixture data/gaps/missing-fixture.json is required'],
      }],
    }),
  });
  assert.equal(tasks.length, 0);
  assert.ok(skips.some((s) => s.kind === 'missing-file'), 'absent file must be SKIP');
  assert.ok(skips.some((s) => s.id === 'N1' && s.kind === 'missing-fixture'), 'missing fixture must be SKIP');
  assert.ok(skips.every((s) => /SKIP:/.test(s.reason)), 'every skip must be explicit');
});

test('load: declared-but-absent expected id is SKIP, not silently dropped', () => {
  const { skips } = loadOnlineGapTasks({
    files: [],
    expectedIds: ['J1', 'J6'],
  });
  assert.equal(skips.length, 2);
  assert.deepEqual(skips.map((s) => s.id), ['J1', 'J6']);
  assert.ok(skips.every((s) => s.kind === 'missing-task'));
});

test('checkFixtures: inline descriptions pass; missing repo-relative fixture is reported', () => {
  assert.equal(checkFixtures('N1', { preconditions: ['body includes CJK + trailing newline'] }, { exists: () => false }), null);
  const missing = checkFixtures(
    'N1',
    { preconditions: ['fixture work/fixtures/gap.json must exist'] },
    { exists: () => false },
  );
  assert.equal(missing, 'work/fixtures/gap.json');
});

test('load: unsafe (non-dryRun) task is SKIPped, never executed', () => {
  const { tasks, skips } = loadOnlineGapTasks({
    files: ['f.json'],
    expectedIds: ['N9'],
    exists: () => true,
    read: () => ({ tasks: [{ id: 'N9', dryRun: false, forRealWrite: true, preconditions: [] }] }),
  });
  assert.equal(tasks.length, 0);
  assert.equal(skips[0].kind, 'unsafe-write');
});

/* ------------------------------------------------------------------ *
 * 3. Baseline freezing: id + fixture hash; old baseline read-only;
 *    current results written to a separate file
 * ------------------------------------------------------------------ */

fixtureTest('baseline: identity is exactly {taskId: fixtureHash} for 15 tasks', () => {
  const { tasks } = loadOnlineGapTasks();
  const identity = baselineIdentity(tasks);
  assert.equal(Object.keys(identity).length, 15);
  for (const t of tasks) {
    assert.equal(identity[t.id], fixtureHashForTask(t));
    assert.match(identity[t.id], /^[0-9a-f]{16}$/);
  }
});

test('baseline: fixture hash is deterministic and changes when the fixture changes', () => {
  const t = { id: 'N1', server: 'github', tool: 'get_file_contents', prompt: 'p', expectedTools: ['a'], expectedOps: [], preconditions: ['x'] };
  assert.equal(fixtureHashForTask(t), fixtureHashForTask({ ...t }));
  const changed = fixtureHashForTask({ ...t, prompt: 'different prompt' });
  assert.notEqual(changed, fixtureHashForTask(t));
});

test('baseline: freeze is pure/read-only and never mutates inputs', () => {
  const tasks = [{ id: 'N1', server: 'github', prompt: 'p' }];
  const metrics = { tasks: 1, perTask: { N1: { writePostConditionOk: true } } };
  const before = JSON.stringify({ tasks, metrics });
  const frozen = freezeOnlineGapBaseline({ tasks, metrics, runId: 'r1' });
  assert.equal(frozen.readOnly, true);
  assert.equal(frozen.profile, ONLINE_GAP_PROFILE);
  assert.deepEqual(frozen.identity, baselineIdentity(tasks));
  assert.deepEqual(frozen.metrics, metrics);
  assert.equal(JSON.stringify({ tasks, metrics }), before, 'freeze must not mutate inputs');
  assert.throws(() => { frozen.metrics.tasks = 99; }, /Cannot|read only|assign/i);
});

test('baseline: loader accepts only read-only frozen docs and never reads explore/results', () => {
  const valid = { readOnly: true, identity: { N1: 'abc' }, metrics: {} };
  const bad = { identity: { N1: 'abc' }, metrics: {} };
  assert.deepEqual(loadOnlineGapBaseline('f.json', () => true, () => valid), valid);
  assert.equal(loadOnlineGapBaseline('f.json', () => true, () => bad), null, 'non-readOnly doc must be rejected');
  assert.equal(loadOnlineGapBaseline('f.json', () => false, () => { throw new Error('should not read'); }), null);
  // The frozen path must not be inside explore/results (current-run artifacts).
  assert.doesNotMatch(ONLINE_GAP_BASELINE_FILE, /explore[\\/]results/);
});

test('baseline: current results go to a separate file, not the frozen baseline', () => {
  assert.notEqual(ONLINE_GAP_RESULT_JSON, ONLINE_GAP_BASELINE_FILE);
  assert.match(ONLINE_GAP_RESULT_JSON, /docs[\\/]eval[\\/]l1-online-gap\.json$/);
  assert.match(ONLINE_GAP_RESULT_MD, /docs[\\/]eval[\\/]l1-online-gap-report\.md$/);
  const writes = [];
  const { result } = runOnlineGapProfile({
    mode: 'fake',
    tasks: [{ id: 'N1', server: 'github', prompt: 'p' }],
    skips: [], baseline: null, perTask: [],
    write: (p, c) => writes.push({ p, c }),
    mkdir: () => {},
    now: () => '2026-01-01T00:00:00.000Z',
  });
  assert.equal(writes.length, 2, 'writes current JSON + MD only');
  assert.ok(writes.every((w) => !w.p.includes('baselines')), 'must never write the frozen baseline');
  assert.equal(result.generatedAt, '2026-01-01T00:00:00.000Z');
});

/* ------------------------------------------------------------------ *
 * 4. Extended metrics: fields present, unknown when not computable
 * ------------------------------------------------------------------ */

fixtureTest('metrics: all 6 fields present for every task; unknown when not derivable', () => {
  const { tasks } = loadOnlineGapTasks();
  const m = computeOnlineGapMetrics(tasks, []);
  for (const t of tasks) {
    for (const key of ONLINE_GAP_METRIC_KEYS) {
      assert.ok(Object.hasOwn(m.perTask[t.id], key), `${t.id}: missing ${key}`);
    }
  }
  assert.equal(m.perTask.N9.writePostConditionOk, 'unknown', 'N9 postcondition not computable from absence');
  assert.equal(m.perTask.N3.idAsPrNumberCount, 'unknown');
  assert.equal(m.perTask.J3.wrapperUnwrapDepthConsistent, 'unknown');
  assert.equal(m.perTask.J4.truncationTailMetadataOk, 'unknown');
  assert.equal(m.perTask.J5.atomicByDefault, 'unknown');
  assert.equal(m.perTask.J6.ciWaitRounds, 'unknown', 'J6 wait helper absent => unknown, not pass/fail');
});

test('metrics: explicit perTask values are honoured; irrelevant tasks stay null', () => {
  const tasks = [
    { id: 'N9', prompt: 'p', preconditions: [] },
    { id: 'X1', prompt: 'p', preconditions: [] }, // not part of any metric's relevant set
  ];
  const m = computeOnlineGapMetrics(tasks, [
    { task: 'N9', writePostConditionOk: true, atomicByDefault: false },
  ]);
  assert.equal(m.perTask.N9.writePostConditionOk, true);
  assert.equal(m.perTask.N9.atomicByDefault, false);
  assert.equal(m.perTask.X1.writePostConditionOk, null, 'not applicable to X1');
});

/* ------------------------------------------------------------------ *
 * 5. Comparison: hash mismatch => unknown; boolean regression => fail
 * ------------------------------------------------------------------ */

test('comparison: matching fixture hashes compare metrics; mismatched hashes are unknown', () => {
  const tasks = [
    { id: 'N1', server: 'github', tool: 'get_file_contents', prompt: 'p', expectedTools: [], preconditions: [] },
  ];
  const baseline = freezeOnlineGapBaseline({
    tasks,
    metrics: { perTask: { N1: { writePostConditionOk: true } } },
  });
  const good = compareOnlineGapCurrent({ perTask: [{ task: 'N1', writePostConditionOk: true }] }, baseline, tasks);
  assert.equal(good.ok, true);
  assert.ok(good.checks.some((c) => c.id === 'N1' && c.metric === 'writePostConditionOk' && c.status === 'pass'));

  const changed = tasks.map((t) => ({ ...t, prompt: 'changed fixture' }));
  const drift = compareOnlineGapCurrent({ perTask: [{ task: 'N1', writePostConditionOk: true }] }, baseline, changed);
  assert.equal(drift.allUnknown, true, 'hash drift must yield all-unknown, never a pass');
  assert.ok(drift.checks.every((c) => c.status === 'unknown' && /hash changed/.test(c.reason)));
});

test('comparison: boolean regression true -> false is a fail (not a silent pass)', () => {
  const tasks = [{ id: 'J5', prompt: 'p' }];
  const baseline = freezeOnlineGapBaseline({
    tasks,
    metrics: { perTask: { J5: { atomicByDefault: true } } },
  });
  const bad = compareOnlineGapCurrent({ perTask: [{ task: 'J5', atomicByDefault: false }] }, baseline, tasks);
  assert.equal(bad.ok, false);
  const check = bad.checks.find((c) => c.metric === 'atomicByDefault');
  assert.equal(check.status, 'fail');
});

/* ------------------------------------------------------------------ *
 * 6. Determinism and 0-fail default path
 * ------------------------------------------------------------------ */

fixtureTest('determinism: two runs of the profile produce byte-identical JSON (except timestamp)', () => {
  const { tasks, skips } = loadOnlineGapTasks();
  const run = () => runOnlineGapProfile({
    tasks, skips, baseline: null, perTask: [],
    write: () => {}, mkdir: () => {}, now: () => 'FIXED',
  }).result;
  const a = run();
  const b = run();
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test('0 fail: no-frozen-baseline run is a wiring PASS with all-unknown metrics (no silent quality pass)', () => {
  const { result } = runOnlineGapProfile({
    tasks: ONLINE_GAP_EXPECTED_IDS.map((id) => ({ id })),
    baseline: null, perTask: [], write: () => {}, mkdir: () => {}, now: () => 'FIXED',
  });
  assert.equal(result.ok, true);
  assert.equal(result.allUnknown, true);
  assert.match(renderOnlineGapReport(result), /no baseline: all metrics unknown/i);
});

test('end-to-end: default `node scripts/run-l1-smoke.mjs --mode fake` still exits 0 with unchanged 50-task PASS', () => {
  const runner = path.join(ROOT, 'scripts/run-l1-smoke.mjs');
  const mdPath = path.join(ROOT, 'docs/eval/l1-smoke-report.md');
  const jsonPath = path.join(ROOT, 'docs/eval/l1-smoke.json');
  const beforeMd = fs.readFileSync(mdPath, 'utf8');
  const beforeJson = fs.readFileSync(jsonPath, 'utf8');
  try {
    const res = spawnSync(process.execPath, [runner, '--mode', 'fake'], {
      cwd: ROOT, encoding: 'utf8', env: { ...process.env, GITHUB_EVENT_NAME: 'schedule' },
    });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /fake-dry-run: PASS/);
    assert.doesNotMatch(res.stdout, /profile=/, 'default run must not activate the profile');
    const doc = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    assert.equal(doc.metrics.tasks, 50, 'legacy L1 task count unchanged');
    assert.equal(doc.ok, true);
    assert.equal(doc.profile, undefined, 'legacy result has no profile field');
  } finally {
    fs.writeFileSync(mdPath, beforeMd);
    fs.writeFileSync(jsonPath, beforeJson);
  }
});

test('end-to-end: `--profile online-gap` runs offline, writes separate current-result files, exits 0', () => {
  const runner = path.join(ROOT, 'scripts/run-l1-smoke.mjs');
  const beforeJson = fs.existsSync(ONLINE_GAP_RESULT_JSON) ? fs.readFileSync(ONLINE_GAP_RESULT_JSON, 'utf8') : null;
  const beforeMd = fs.existsSync(ONLINE_GAP_RESULT_MD) ? fs.readFileSync(ONLINE_GAP_RESULT_MD, 'utf8') : null;
  try {
    const res = spawnSync(process.execPath, [runner, '--profile', 'online-gap'], {
      cwd: ROOT, encoding: 'utf8', env: { ...process.env, GITHUB_EVENT_NAME: 'schedule' },
    });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /profile=online-gap: PASS/);
    assert.match(res.stdout, /loaded=15 skipped=0/);
    const doc = readJson(ONLINE_GAP_RESULT_JSON);
    assert.equal(doc.profile, 'online-gap');
    assert.equal(doc.loaded.length, 15);
    assert.deepEqual(doc.skipped, []);
    assert.equal(doc.allUnknown, true, 'no frozen baseline yet => all metrics unknown');
    assert.match(fs.readFileSync(ONLINE_GAP_RESULT_MD, 'utf8'), /L1 Online-Gap Wire Report/);
    // Legacy report files must be untouched by the profile run.
    const legacy = readJson(path.join(ROOT, 'docs/eval/l1-smoke.json'));
    assert.equal(legacy.metrics.tasks, 50);
  } finally {
    if (beforeJson === null) { if (fs.existsSync(ONLINE_GAP_RESULT_JSON)) fs.unlinkSync(ONLINE_GAP_RESULT_JSON); }
    else fs.writeFileSync(ONLINE_GAP_RESULT_JSON, beforeJson);
    if (beforeMd === null) { if (fs.existsSync(ONLINE_GAP_RESULT_MD)) fs.unlinkSync(ONLINE_GAP_RESULT_MD); }
    else fs.writeFileSync(ONLINE_GAP_RESULT_MD, beforeMd);
  }
});

test('end-to-end: unknown profile is rejected with exit 2 (no silent fallback)', () => {
  const res = spawnSync(process.execPath, [path.join(ROOT, 'scripts/run-l1-smoke.mjs'), '--profile', 'bogus'], {
    cwd: ROOT, encoding: 'utf8',
  });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /unknown profile/);
});
