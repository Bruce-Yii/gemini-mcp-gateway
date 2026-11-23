/**
 * Offline wiring tests for the OPTIONAL `--profile feedback` of the L1 smoke
 * runner (FB1–FB10 + N10–N16, the PR #80–#101 feedback regression tasks).
 *
 * Covers: CLI surface, exact task loading (17 ids, unique, zero SKIP when the
 * fixtures are present), generalized skip text (online-gap reason stays
 * byte-for-byte unchanged), independent result files (no legacy/online-gap
 * output overwritten, no frozen baseline written), all-unknown metrics with no
 * frozen baseline (wiring PASS is NOT a gateway quality verdict), determinism,
 * and the end-to-end CLI path. No network, no credentials, no src/ writes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  ROOT, parseArgs,
  ONLINE_GAP_PROFILE, ONLINE_GAP_RESULT_JSON, ONLINE_GAP_RESULT_MD,
  FEEDBACK_PROFILE, FEEDBACK_TASK_FILES, FEEDBACK_EXPECTED_IDS,
  FEEDBACK_ID_SET_LABEL, FEEDBACK_BASELINE_FILE,
  FEEDBACK_RESULT_JSON, FEEDBACK_RESULT_MD,
  loadOnlineGapTasks, runFeedbackProfile, renderOnlineGapReport,
} from '../scripts/run-l1-smoke.mjs';

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const hasFixtures = FEEDBACK_TASK_FILES.every((f) => fs.existsSync(path.join(ROOT, f)));
const fixtureSkip = hasFixtures
  ? false
  : 'private eval fixtures explore/tasks-feedback-2026-11-24.json and explore/tasks-online-gap-3.json are excluded from the OSS export';
const fixtureTest = (name, fn) => test(name, { skip: fixtureSkip }, fn);

/** Snapshot a file (or null if absent) and restore it after a spawning test. */
const snapshot = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);
const restore = (p, content) => {
  if (content === null) {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } else {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
};

/* ------------------------------------------------------------------ *
 * 1. CLI surface: feedback is opt-in; default / online-gap unchanged
 * ------------------------------------------------------------------ */

test('feedback profile: parseArgs accepts --profile feedback and keeps default null', () => {
  assert.equal(parseArgs([]).profile, null);
  assert.equal(parseArgs(['--mode', 'fake']).profile, null);
  assert.equal(parseArgs(['--profile', FEEDBACK_PROFILE]).profile, 'feedback');
  assert.equal(parseArgs(['--profile=feedback']).profile, 'feedback');
  assert.equal(parseArgs(['--profile', ONLINE_GAP_PROFILE]).profile, 'online-gap');
});

test('feedback profile: expected ids are FB1–FB10 + N10–N16 and disjoint from online-gap', () => {
  assert.equal(FEEDBACK_EXPECTED_IDS.length, 17);
  assert.equal(new Set(FEEDBACK_EXPECTED_IDS).size, 17);
  assert.deepEqual(FEEDBACK_TASK_FILES, [
    'explore/tasks-feedback-2026-11-24.json',
    'explore/tasks-online-gap-3.json',
  ]);
  assert.equal(FEEDBACK_ID_SET_LABEL, 'FB1–FB10/N10–N16');
});

/* ------------------------------------------------------------------ *
 * 2. Loading via the generalized helper
 * ------------------------------------------------------------------ */

fixtureTest('load: exactly 17 feedback tasks, unique ids, zero SKIP, all dryRun', () => {
  const { tasks, skips } = loadOnlineGapTasks({
    files: FEEDBACK_TASK_FILES,
    expectedIds: FEEDBACK_EXPECTED_IDS,
    idSetLabel: FEEDBACK_ID_SET_LABEL,
  });
  assert.equal(tasks.length, 17);
  assert.deepEqual([...tasks.map((t) => t.id)].sort(), [...FEEDBACK_EXPECTED_IDS].sort());
  assert.equal(new Set(tasks.map((t) => t.id)).size, 17);
  assert.deepEqual(skips, []);
  assert.ok(tasks.every((t) => t.dryRun === true && t.forRealWrite === false));
});

test('load: generalized SKIP label is reflected in the reason, default stays byte-identical', () => {
  const doc = {
    tasks: [
      { id: 'FB1', dryRun: true, forRealWrite: false, preconditions: [] },
      { id: 'ZZ9', dryRun: true, forRealWrite: false, preconditions: [] },
    ],
  };
  const read = () => doc;
  const feedback = loadOnlineGapTasks({
    files: ['f.json'], expectedIds: ['FB1'], idSetLabel: FEEDBACK_ID_SET_LABEL,
    exists: () => true, read,
  });
  const feedbackSkip = feedback.skips.find((s) => s.id === 'ZZ9');
  assert.equal(feedbackSkip.kind, 'unknown-task');
  assert.match(feedbackSkip.reason, /SKIP: unknown task id/);
  assert.match(feedbackSkip.reason, /FB1–FB10\/N10–N16/);

  const defaultGap = loadOnlineGapTasks({
    files: ['f.json'], expectedIds: ['FB1'],
    exists: () => true, read,
  });
  const defaultSkip = defaultGap.skips.find((s) => s.id === 'ZZ9');
  assert.equal(defaultSkip.reason, 'SKIP: unknown task id (not in N1–N9/J1–J6)',
    'online-gap default reason must remain byte-for-byte unchanged');
});

test('load: declared-but-absent feedback id is SKIP, not a silent pass', () => {
  const { tasks, skips } = loadOnlineGapTasks({
    files: [], expectedIds: FEEDBACK_EXPECTED_IDS, idSetLabel: FEEDBACK_ID_SET_LABEL,
  });
  assert.equal(tasks.length, 0);
  assert.equal(skips.length, 17);
  assert.ok(skips.every((s) => s.kind === 'missing-task' && /SKIP:/.test(s.reason)));
});

test('load: unsafe (non-dryRun) feedback task is SKIPped, never executed', () => {
  const { tasks, skips } = loadOnlineGapTasks({
    files: ['f.json'], expectedIds: ['FB1'], idSetLabel: FEEDBACK_ID_SET_LABEL,
    exists: () => true,
    read: () => ({ tasks: [{ id: 'FB1', dryRun: false, forRealWrite: true, preconditions: [] }] }),
  });
  assert.equal(tasks.length, 0);
  assert.equal(skips[0].kind, 'unsafe-write');
});

/* ------------------------------------------------------------------ *
 * 3. Independent output paths / no frozen baseline writes
 * ------------------------------------------------------------------ */

test('feedback profile: result paths are independent of legacy and online-gap', () => {
  assert.match(FEEDBACK_RESULT_JSON, /docs[\\/]eval[\\/]l1-feedback\.json$/);
  assert.match(FEEDBACK_RESULT_MD, /docs[\\/]eval[\\/]l1-feedback-report\.md$/);
  assert.notEqual(FEEDBACK_RESULT_JSON, ONLINE_GAP_RESULT_JSON);
  assert.notEqual(FEEDBACK_RESULT_MD, ONLINE_GAP_RESULT_MD);
  assert.doesNotMatch(FEEDBACK_BASELINE_FILE, /explore[\\/]results/);
});

test('feedback profile: writes only its own JSON + MD, never a frozen baseline', () => {
  const writes = [];
  const { result, paths } = runFeedbackProfile({
    tasks: [{ id: 'FB1' }], skips: [], baseline: null, perTask: [],
    write: (p, c) => writes.push({ p, c }),
    mkdir: () => {},
    now: () => '2026-01-01T00:00:00.000Z',
  });
  assert.equal(writes.length, 2);
  assert.ok(writes.every((w) => !w.p.includes('baselines')));
  assert.deepEqual(paths, { md: FEEDBACK_RESULT_MD, json: FEEDBACK_RESULT_JSON });
  assert.equal(result.profile, 'feedback');
  assert.equal(result.generatedAt, '2026-01-01T00:00:00.000Z');
});

/* ------------------------------------------------------------------ *
 * 4. Wiring PASS is not a quality pass
 * ------------------------------------------------------------------ */

test('feedback profile: no frozen baseline => PASS (wiring) with all metrics unknown', () => {
  const { result } = runFeedbackProfile({
    tasks: FEEDBACK_EXPECTED_IDS.map((id) => ({ id })),
    skips: [], baseline: null, perTask: [],
    write: () => {}, mkdir: () => {}, now: () => 'FIXED',
  });
  assert.equal(result.ok, true);
  assert.equal(result.allUnknown, true);
  assert.equal(result.loaded.length, 17);
  const report = renderOnlineGapReport(result, {
    title: 'L1 Feedback Wire Report', defaultProfile: FEEDBACK_PROFILE,
  });
  assert.match(report, /^# L1 Feedback Wire Report/);
  assert.match(report, /Tasks: 17 loaded, 0 SKIP/);
  assert.match(report, /no baseline: all metrics unknown/i);
  assert.match(report, /Never read as gateway quality/);
});

fixtureTest('determinism: two runs of the feedback profile produce byte-identical JSON', () => {
  const { tasks, skips } = loadOnlineGapTasks({
    files: FEEDBACK_TASK_FILES, expectedIds: FEEDBACK_EXPECTED_IDS, idSetLabel: FEEDBACK_ID_SET_LABEL,
  });
  const run = () => runFeedbackProfile({
    tasks, skips, baseline: null, perTask: [],
    write: () => {}, mkdir: () => {}, now: () => 'FIXED',
  }).result;
  assert.equal(JSON.stringify(run()), JSON.stringify(run()));
});

/* ------------------------------------------------------------------ *
 * 5. End-to-end CLI
 * ------------------------------------------------------------------ */

fixtureTest('end-to-end: --profile feedback loads 17, 0 SKIP, exits 0, writes own reports', () => {
  const runner = path.join(ROOT, 'scripts/run-l1-smoke.mjs');
  const beforeFbJson = snapshot(FEEDBACK_RESULT_JSON);
  const beforeFbMd = snapshot(FEEDBACK_RESULT_MD);
  try {
    const res = spawnSync(process.execPath, [runner, '--profile', 'feedback', '--mode', 'fake'], {
      cwd: ROOT, encoding: 'utf8', env: { ...process.env, GITHUB_EVENT_NAME: 'schedule' },
    });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /profile=feedback: PASS/);
    assert.match(res.stdout, /loaded=17 skipped=0/);
    assert.match(res.stdout, /no frozen baseline: all metrics unknown/);
    const doc = readJson(FEEDBACK_RESULT_JSON);
    assert.equal(doc.profile, 'feedback');
    assert.equal(doc.loaded.length, 17);
    assert.deepEqual(doc.skipped, []);
    assert.equal(doc.allUnknown, true);
    assert.deepEqual(doc.loaded.map((t) => t.id).sort(), [...FEEDBACK_EXPECTED_IDS].sort());
    assert.match(fs.readFileSync(FEEDBACK_RESULT_MD, 'utf8'), /^# L1 Feedback Wire Report/);
    // NOTE: legacy l1-smoke.json integrity is asserted by
    // tests/l1-online-gap-wire.test.js; do not snapshot it here because the two
    // test files run in separate processes concurrently and would race on it.
  } finally {
    restore(FEEDBACK_RESULT_JSON, beforeFbJson);
    restore(FEEDBACK_RESULT_MD, beforeFbMd);
  }
});

// NOTE: the online-gap CLI end-to-end path is covered by
// tests/l1-online-gap-wire.test.js. Do not spawn it here: two test files run
// in separate processes concurrently and would race on the same report files.

test('end-to-end: unknown profile is rejected with exit 2 and lists both valid profiles', () => {
  const res = spawnSync(process.execPath, [path.join(ROOT, 'scripts/run-l1-smoke.mjs'), '--profile', 'bogus'], {
    cwd: ROOT, encoding: 'utf8',
  });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /unknown profile/);
  assert.match(res.stderr, /online-gap/);
  assert.match(res.stderr, /feedback/);
});
