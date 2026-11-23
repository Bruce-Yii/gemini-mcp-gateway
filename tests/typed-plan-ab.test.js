/**
 * Batch 14 — offline tests for scripts/typed-plan-ab.mjs.
 *
 * Covers: fixture run with the N1–N9 task set, per-task metrics, error
 * classification (E1–E8), fallback observability (reasons 1–4), write replay,
 * paired aggregation, A1–A7 gate evaluation including NOT_ENOUGH (no default
 * switch), determinism, JSON/markdown reports, and the no-network boundary
 * (no fetch/http/child_process imports in the runner; all I/O injected).
 *
 * Fully offline: no network, no credentials, no writes outside the temp dir
 * created in the report test. No commit / push / deploy.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PROFILES,
  TOOL_FACE,
  GATE_IDS,
  ERROR_CLASSES,
  FALLBACK_REASONS,
  GATE_STATUS,
  DECISION,
  loadTaskSet,
  createFakeModel,
  createFakeIOForTask,
  classifyError,
  computeMetrics,
  runTask,
  runAB,
  summarize,
  evaluateGates,
  buildReport,
  renderJson,
  renderMarkdown,
  writeReport,
  parseArgs,
} from '../scripts/typed-plan-ab.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TASK_FILE = path.join(ROOT, 'explore', 'tasks-online-gap.json');
const RUNNER_FILE = path.join(ROOT, 'scripts', 'typed-plan-ab.mjs');

// explore/tasks-online-gap.json is a private eval fixture excluded from the OSS
// export. Guard the fixture-dependent tests so the clean export reports an
// explicit reason-bearing SKIP instead of crashing with ENOENT. In the private
// repo the fixture exists and every test runs unchanged.
const fixtureSkip = fs.existsSync(TASK_FILE)
  ? false
  : 'private eval fixture explore/tasks-online-gap.json is excluded from the OSS export (see docs/OPEN-SOURCE/EXPORT-TEST-CURATION.md)';
const fixtureTest = (name, fn) => test(name, { skip: fixtureSkip }, fn);

const fixtureTasks = () => loadTaskSet(TASK_FILE);

// Simple registry-expressible task for typed-plan execution tests.
const typedTask = {
  id: 'T-TYPED',
  name: 'registry-expressible read+patch',
  expectedTools: ['readFileRange', 'applyPatch'],
  expectedOps: ['readFileRange', 'applyPatch'],
  fakeWrite: true,
  fakePlan: [
    { op: 'readFileRange', path: 'example.txt', startLine: 1, endLine: 3 },
    { op: 'applyPatch', path: 'example.txt', patch: '@@ -2,1 +2,1 @@\n-two\n+TWO\n' },
  ],
  fakeTokens: { input: 120, output: 30 },
  fakeWallMs: 7,
};

// 1. 常量 / 数据结构 ---------------------------------------------------------
test('profiles: F is v1 code, S is v2 plan+fallback, tool face is identical', () => {
  assert.equal(PROFILES.F.protocolVersion, 'v1');
  assert.equal(PROFILES.F.inputMode, 'code');
  assert.equal(PROFILES.S.protocolVersion, 'v2');
  assert.match(PROFILES.S.inputMode, /plan/);
  assert.match(PROFILES.S.inputMode, /fallback/);
  assert.deepEqual([...TOOL_FACE], ['search', 'execute_read', 'execute']);
  assert.deepEqual([...GATE_IDS], ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7']);
  assert.equal(ERROR_CLASSES.length, 8);
  assert.deepEqual([...FALLBACK_REASONS], [1, 2, 3, 4]);
});

// 2. fixture 运行 ------------------------------------------------------------
fixtureTest('fixture run: N1–N9 load and produce 9 paired metrics with identical tasks/prompts', async () => {
  const tasks = fixtureTasks();
  assert.equal(tasks.length, 9);
  assert.deepEqual(tasks.map((t) => t.id), ['N1', 'N2', 'N3', 'N4', 'N5', 'N6', 'N7', 'N8', 'N9']);
  // The task set forbids real writes; runner never overrides that.
  assert.ok(tasks.every((t) => t.dryRun === true && t.forRealWrite === false));
  const promptsBefore = tasks.map((t) => t.prompt);
  const ab = await runAB(tasks, { environment: 'fake', repeats: 1 });
  assert.deepEqual(tasks.map((t) => t.prompt), promptsBefore, 'prompt must not be rewritten');
  assert.equal(ab.runs.length, 9);
  assert.equal(ab.taskCount, 9);
  for (const run of ab.runs) {
    assert.deepEqual(run.order, ['F', 'S']);
    for (const p of ['F', 'S']) {
      const m = run[p];
      assert.equal(m.taskId, run.taskId);
      assert.equal(m.profile, p);
      assert.equal(typeof m.completion, 'boolean');
      assert.equal(typeof m.repair, 'number');
      assert.equal(typeof m.tokens, 'number');
      assert.equal(typeof m.wallMs, 'number');
      assert.ok(m.toolHit === null || typeof m.toolHit === 'boolean');
      assert.ok(m.searchHit === null || typeof m.searchHit === 'boolean');
      assert.ok(m.writeReplay === null || typeof m.writeReplay === 'boolean');
      assert.ok(m.errorClass === null || ERROR_CLASSES.includes(m.errorClass));
    }
  }
});

fixtureTest('fixture run repeated 3x alternates F→S / S→F and stays deterministic', async () => {
  const tasks = fixtureTasks().slice(0, 3);
  const a = await runAB(tasks, { repeats: 3, environment: 'fake' });
  const b = await runAB(tasks, { repeats: 3, environment: 'fake' });
  assert.deepEqual(a, b, 'same input must produce byte-identical output');
  assert.deepEqual(a.runs[0].order, ['F', 'S']);
  assert.deepEqual(a.runs[3].order, ['S', 'F']);
  assert.deepEqual(a.runs[6].order, ['F', 'S']);
});

// 3. 单任务 / typed plan 执行 -------------------------------------------------
test('runTask: S executes a registry-expressible plan with dryRun write (no real write)', async () => {
  const io = createFakeIOForTask(typedTask);
  const { trace, metrics } = await runTask('S', typedTask, { io });
  assert.equal(trace.decision, 'plan');
  assert.equal(trace.execution.ok, true);
  assert.deepEqual(trace.execution.steps.map((s) => s.op), ['readFileRange', 'applyPatch']);
  assert.equal(trace.execution.dryRun, true);
  assert.equal(trace.fallback, null);
  assert.equal(io.calls.some((c) => c.op === 'writeFile'), false, 'dryRun must not write');
  assert.equal(metrics.completion, true);
  assert.equal(metrics.toolHit, true);
  assert.equal(metrics.tokens, 150);
  assert.equal(metrics.wallMs, 7);
  assert.equal(metrics.fallback, null);
});

test('runTask: F uses codeOps from the adapter and records write-replay steps', async () => {
  const task = { ...typedTask, id: 'T-F', fakeWrite: true };
  const { trace, metrics } = await runTask('F', task, { model: createFakeModel() });
  assert.equal(trace.decision, 'code');
  assert.deepEqual(trace.executedOps, ['readFileRange', 'applyPatch']);
  assert.deepEqual(trace.writeReplaySteps, ['dryRun', 'write', 'verify']);
  assert.equal(metrics.writeReplay, true);
  assert.equal(trace.fallback, null);
});

// 4. metrics 计算 ------------------------------------------------------------
test('computeMetrics: toolHit/searchHit null when no expected names; repair and tokens', () => {
  const m = computeMetrics({
    taskId: 'X', profile: 'F', expectedTools: [], expectedOps: [],
    errors: [], tokens: { input: 11, output: 4 }, wallMs: 3,
  });
  assert.equal(m.toolHit, null);
  assert.equal(m.searchHit, null);
  assert.equal(m.tokens, 15);
  assert.equal(m.repair, 0);
  assert.equal(m.writeReplay, null, 'non-write task: not applicable, not false');
  assert.equal(m.completion, true);
});

test('computeMetrics: partial tool coverage is a miss; searchHit checks first expected', () => {
  const m = computeMetrics({
    taskId: 'Y', profile: 'F',
    expectedTools: ['github__get_commit', 'github__list_commits'], expectedOps: [],
    executedOps: ['github__get_commit'], searchHits: ['github__list_commits'],
    errors: [], tokens: { input: 10, output: 10 }, wallMs: 5,
  });
  assert.equal(m.toolHit, false, 'all expected names must be covered');
  assert.equal(m.searchHit, true);
});

test('computeMetrics: completion proxy ignores raw finished but honors E7/runner error', () => {
  const base = { taskId: 'Z', profile: 'F', expectedTools: [], expectedOps: [], tokens: {}, wallMs: 1 };
  const ok = computeMetrics({ ...base, errors: [{ code: 'E2', message: 'Invalid option' }] });
  assert.equal(ok.completion, true, 'recoverable error is not a completion failure');
  assert.equal(ok.errorClass, 'E2');
  const giveUp = computeMetrics({ ...base, errors: [{ code: 'X', message: 'max_turns_exceeded' }] });
  assert.equal(giveUp.completion, false);
  assert.equal(giveUp.errorClass, 'E7');
  const runner = computeMetrics({ ...base, errors: [{ code: 'RUNNER', message: 'runner_error' }] });
  assert.equal(runner.completion, false);
});

test('computeMetrics: write replay requires dryRun -> write -> verify in order', () => {
  const mk = (steps) => computeMetrics({
    taskId: 'W', profile: 'S', expectedTools: [], expectedOps: [], tokens: {}, wallMs: 1,
    isWrite: true, writeReplaySteps: steps,
  }).writeReplay;
  assert.equal(mk(['dryRun', 'write', 'verify']), true);
  assert.equal(mk(['dryRun', 'write']), false);
  assert.equal(mk(['write', 'verify']), false);
  assert.equal(mk([]), false);
});

// 5. 错误分类 ----------------------------------------------------------------
test('classifyError: all eight classes E1–E8 map from representative signals', () => {
  const samples = {
    E1: 'search returned no match for select: tool',
    E2: 'Invalid option: expected one of a, b',
    E3: 'Unknown tool github__notARealTool',
    E4: 'applyFilePatch hunk did not match anchor',
    E5: 'This tool requires a Business plan',
    E6: 'upstream 503 timeout',
    E7: 'max_turns_exceeded',
    E8: '--- TRUNCATED --- response cap reached',
  };
  for (const c of ERROR_CLASSES) {
    assert.equal(classifyError(samples[c]), c, `${c} signal must classify to ${c}`);
  }
  assert.equal(classifyError('some totally unknown thing'), null, 'unknown signal -> unverified');
  assert.equal(classifyError(''), null);
});

test('computeMetrics: unrecognized error is marked unverified and errorClass null', () => {
  const m = computeMetrics({
    taskId: 'U', profile: 'F', expectedTools: [], expectedOps: [], tokens: {}, wallMs: 1,
    errors: [{ code: 'MYSTERY', message: 'weird unreproducible failure' }],
  });
  assert.equal(m.unverified, true);
  assert.equal(m.errorClass, null);
});

// 6. fallback 可观测性 -------------------------------------------------------
test('fallback reasons 1–4 are all observable in S metrics and traces', async () => {
  const tasks = [
    { ...typedTask, id: 'FB1', fakeComplex: true },
    { ...typedTask, id: 'FB2', fakeMissingOp: true },
    { ...typedTask, id: 'FB3', fakePlanErrors: 2 },
    { ...typedTask, id: 'FB4', fakeExplicitCode: true },
  ];
  const ab = await runAB(tasks, { repeats: 1 });
  const reasons = ab.runs.map((r) => r.S.fallback?.reason);
  assert.deepEqual(reasons, [1, 2, 3, 4]);
  for (const run of ab.runs) {
    assert.equal(run.traces.S.decision, 'code', 'fallback must execute the code path');
    assert.ok(run.traces.S.fallback && typeof run.traces.S.fallback.attemptPlan === 'boolean');
    assert.equal(run.F.fallback, null, 'F never has a fallback marker');
  }
  assert.equal(ab.runs[0].traces.S.fallback.atStep, 0);
});

test('S with no fallback executes the plan path (not silently code)', async () => {
  const ab = await runAB([typedTask], { repeats: 1 });
  assert.equal(ab.runs[0].traces.S.decision, 'plan');
  assert.equal(ab.runs[0].S.fallback, null);
});

// 7. 汇总与门槛 --------------------------------------------------------------
test('summarize: paired aggregation with explicit denominators and p95', () => {
  const runs = [
    { F: { completion: true, toolHit: true, searchHit: false, repair: 0, tokens: 10, wallMs: 1, writeReplay: true, errorClass: null }, S: { completion: true, toolHit: false, searchHit: true, repair: 1, tokens: 12, wallMs: 2, writeReplay: true, errorClass: 'E2', fallback: { reason: 1 } } },
    { F: { completion: false, toolHit: null, searchHit: null, repair: 2, tokens: 20, wallMs: 100, writeReplay: null, errorClass: 'E6' }, S: { completion: true, toolHit: null, searchHit: null, repair: 0, tokens: 18, wallMs: 3, writeReplay: null, errorClass: null, fallback: null } },
  ];
  const s = summarize(runs);
  assert.equal(s.F.completion, 0.5);
  assert.equal(s.S.completion, 1);
  assert.equal(s.F.toolHit, 1, 'null excluded from denominator');
  assert.equal(s.F.searchHit, 0, 'false counted, null excluded');
  assert.equal(s.F.repair, 1);
  assert.equal(s.S.repair, 0.5);
  assert.equal(s.F.tokens, 15);
  assert.equal(s.S.tokens, 15);
  assert.equal(s.F.writeReplay, 1, 'null excluded from write denominator');
  assert.equal(s.F.p95, 100);
  assert.equal(s.S.fallbackRate, 0.5);
  assert.deepEqual(s.F.errorClasses, { E6: 1 });
  assert.equal(s.pairedDiff.completion, 0.5);
  assert.equal(s.pairedDiff.tokens, 0);
  assert.equal(s.pairedDiff.repair, -0.5);
});

test('NOT_ENOUGH: fake/replay/insufficient repeats never pass gates and never switch default', () => {
  const s = summarize([
    { F: { completion: 1, toolHit: true, searchHit: true, repair: 0, tokens: 10, wallMs: 1, writeReplay: null }, S: { completion: 1, toolHit: true, searchHit: true, repair: 0, tokens: 10, wallMs: 1, writeReplay: null, fallback: null } },
  ]);
  for (const meta of [
    { environment: 'fake', repeats: 3, platform: 'gemini', conformance: { a: true }, frozenBaseline: true, baselineNotCurrent: true, noCrossPlatformCompare: true },
    { environment: 'replay', repeats: 3, platform: 'gemini', conformance: { a: true }, frozenBaseline: true, baselineNotCurrent: true, noCrossPlatformCompare: true },
    { environment: 'real', repeats: 2, platform: 'gemini', conformance: { a: true }, frozenBaseline: true, baselineNotCurrent: true, noCrossPlatformCompare: true },
    { environment: 'real', repeats: 3, platform: 'chatgpt', conformance: { a: true }, frozenBaseline: true, baselineNotCurrent: true, noCrossPlatformCompare: true },
  ]) {
    const g = evaluateGates(s, meta);
    assert.deepEqual(g.gates.map((x) => x.status), GATE_IDS.map(() => GATE_STATUS.NOT_ENOUGH));
    assert.equal(g.decision, DECISION.INSUFFICIENT);
    assert.equal(g.defaultSwitchAllowed, false);
  }
});

test('enough real Gemini data: gates evaluate pass/fail, still no automatic switch', () => {
  const good = {
    F: { completion: 0.9, toolHit: 0.8, searchHit: 0.8, repair: 1, tokens: 100, p95: 50, writeReplay: 0.9 },
    S: { completion: 0.9, toolHit: 0.85, searchHit: 0.85, repair: 0.6, tokens: 95, p95: 55, writeReplay: 1, fallbackRate: 0.1 },
  };
  const meta = {
    environment: 'real', repeats: 3, platform: 'gemini',
    conformance: {
      gemini_no_structured_content: true, chatgpt_dual_encoding: true,
      claude_annotations: true, stable_tools_list: true,
    },
    frozenBaseline: true, baselineNotCurrent: true, noCrossPlatformCompare: true,
  };
  const pass = evaluateGates(good, meta);
  assert.deepEqual(pass.gates.map((g) => g.status), GATE_IDS.map(() => GATE_STATUS.PASS));
  assert.equal(pass.decision, DECISION.KEEP_F);
  assert.equal(pass.defaultSwitchAllowed, false, 'lead human review still required');

  const fail = evaluateGates({ ...good, S: { ...good.S, tokens: 101 } }, meta);
  assert.equal(fail.gates.find((g) => g.id === 'A2').status, GATE_STATUS.FAIL);
  assert.equal(fail.decision, DECISION.BLOCKED);

  const badBaseline = evaluateGates(good, { ...meta, frozenBaseline: false });
  assert.equal(badBaseline.gates.find((g) => g.id === 'A5').status, GATE_STATUS.FAIL);
  const noConformance = evaluateGates(good, { ...meta, conformance: null });
  assert.equal(noConformance.gates.find((g) => g.id === 'A7').status, GATE_STATUS.FAIL);
});

// 8. report ------------------------------------------------------------------
fixtureTest('buildReport emits JSON + markdown with all gates and a paired task table', async () => {
  const ab = await runAB(fixtureTasks().slice(0, 2), { environment: 'fake', repeats: 1 });
  const report = buildReport(ab, { platform: 'gemini' });
  const json = renderJson(report);
  const parsed = JSON.parse(json);
  assert.equal(parsed.kind, 'typed-plan-ab');
  assert.equal(parsed.tasks.length, 2);
  assert.equal(parsed.gates.gates.length, 7);
  assert.equal(parsed.gates.defaultSwitchAllowed, false);
  assert.deepEqual(parsed.meta.toolFace, [...TOOL_FACE]);
  const md = renderMarkdown(report);
  assert.match(md, /Typed-plan \/ Code Mode A\/B report/);
  assert.match(md, /## Gates A1–A7/);
  assert.match(md, /## Per-task paired metrics/);
  assert.match(md, /INSUFFICIENT/);
  assert.match(md, /N1/);
});

test('writeReport writes deterministic files in a temp dir (no repo changes)', async () => {
  const ab = await runAB([typedTask], { environment: 'fake' });
  const report = buildReport(ab);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'typed-plan-ab-'));
  try {
    const files = writeReport(report, dir, 'ab-test');
    assert.equal(path.basename(files.jsonPath), 'ab-test.json');
    assert.equal(path.basename(files.mdPath), 'ab-test.md');
    assert.equal(fs.readFileSync(files.jsonPath, 'utf8'), renderJson(report));
    assert.equal(fs.readFileSync(files.mdPath, 'utf8'), renderMarkdown(report));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// 9. 确定性 / 不联网 ---------------------------------------------------------
fixtureTest('determinism: full report is byte-identical across repeated runs', async () => {
  const tasks = fixtureTasks();
  const a = renderJson(buildReport(await runAB(tasks, { repeats: 2 })));
  const b = renderJson(buildReport(await runAB(tasks, { repeats: 2 })));
  assert.equal(a, b);
  assert.equal(renderMarkdown(buildReport(await runAB(tasks, { repeats: 2 }))),
    renderMarkdown(buildReport(await runAB(tasks, { repeats: 2 }))));
});

test('no-network boundary: runner source has no fetch/http/net imports', () => {
  const src = fs.readFileSync(RUNNER_FILE, 'utf8');
  assert.equal(/\bfetch\s*\(/.test(src), false, 'runner must not call fetch');
  assert.equal(/from\s+['"](node:)?https?['"]/.test(src), false, 'runner must not import http(s)');
  assert.equal(/from\s+['"]node:net['"]/.test(src), false, 'runner must not import net');
  assert.equal(/child_process/.test(src), false, 'runner must not spawn processes');
  assert.match(src, /options\.model/, 'a real-model injection point must exist');
  assert.match(src, /options\.io/, 'an I/O injection point must exist');
});

test('adapter injection: custom model controls decisions without touching the network', async () => {
  const seen = [];
  const model = {
    async decide(profile, task) {
      seen.push(`${profile}:${task.id}`);
      return {
        kind: 'code', codeOps: ['custom__op'], searchHits: ['custom__op'],
        tokens: { input: 1, output: 2 }, wallMs: 9, errors: [], fallback: null,
      };
    },
  };
  const ab = await runAB([typedTask], { model });
  assert.deepEqual(seen, ['F:T-TYPED', 'S:T-TYPED']);
  assert.equal(ab.runs[0].F.tokens, 3);
  assert.deepEqual(ab.runs[0].traces.F.executedOps, ['custom__op']);
});

test('parseArgs: CLI defaults stay offline and do not write by default', () => {
  const a = parseArgs([]);
  assert.equal(a.environment, 'fake');
  assert.equal(a.repeats, 1);
  assert.equal(a.write, false);
  assert.equal(a.help, false);
  assert.throws(() => parseArgs(['--bogus']), /unknown arg/);
});

fixtureTest('loadTaskSet: accepts both bare arrays and {tasks:[...]} JSON', () => {
  const tasks = fixtureTasks();
  assert.deepEqual(loadTaskSet(tasks), tasks);
  assert.equal(loadTaskSet(TASK_FILE).length, 9);
  assert.throws(() => loadTaskSet({}), /expected path or array/);
});
