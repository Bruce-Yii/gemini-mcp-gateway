/**
 * Batch 14 — isolated typed-plan prototype tests.
 *
 * Fully offline: all I/O is injected through createFakeIO(); no network, no
 * credentials, no filesystem writes, no production module import beyond the
 * pure applyTextPatch reused by the spike. Each assertion targets the stable
 * {ok, op, result|error} step contract and the validation gates.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OP_REGISTRY,
  createFakeIO,
  validatePlan,
  executePlan,
} from '../scripts/typed-plan-spike.mjs';

const STEP_SHAPE = (step) => {
  assert.equal(typeof step.ok, 'boolean');
  assert.equal(typeof step.op, 'string');
  if (step.ok) {
    assert.ok('result' in step, 'success step must carry result');
    assert.ok(!('error' in step), 'success step must not carry error');
  } else {
    assert.ok('error' in step, 'failed step must carry error');
    assert.ok(!('result' in step), 'failed step must not carry result');
  }
};

// 1. 成功流 -----------------------------------------------------------------
test('success flow: read -> patch -> check, stable step shape, no approval needed for reads', async () => {
  const io = createFakeIO({ files: { 'a.txt': 'one\ntwo\nthree\n' } });
  const plan = [
    { op: 'readFileRange', path: 'a.txt', startLine: 1, endLine: 3 },
    { op: 'applyPatch', path: 'a.txt', patch: '@@ -2,1 +2,1 @@\n-two\n+TWO\n' },
    { op: 'runChecks', command: 'npm test' },
  ];
  const out = await executePlan(plan, { dryRun: true, io });
  assert.equal(out.ok, true);
  assert.equal(out.stoppedAt, null);
  assert.equal(out.error, null);
  assert.deepEqual(out.steps.map((s) => s.op), ['readFileRange', 'applyPatch', 'runChecks']);
  out.steps.forEach(STEP_SHAPE);
  assert.equal(out.steps[1].result.dryRun, true, 'dryRun patch returns a preview, not a fake write');
  assert.equal(out.steps[1].result.path, 'a.txt');
  // The write side of the patch (writeFile) must NOT be called in dryRun.
  assert.equal(io.calls.some((c) => c.op === 'writeFile'), false);
});

// 2. 未知 op ----------------------------------------------------------------
test('unknown op: rejected at validation, zero steps executed', async () => {
  const io = createFakeIO();
  const out = await executePlan([{ op: 'deleteEverything', path: 'x' }], { io, dryRun: true });
  assert.equal(out.ok, false);
  assert.deepEqual(out.steps, []);
  assert.equal(out.stoppedAt, null);
  assert.match(out.error, /unknown op/);
  assert.equal(io.calls.length, 0, 'no handler may run for an unknown op');
  assert.equal(Object.prototype.hasOwnProperty.call(OP_REGISTRY, 'deleteEverything'), false);
});

// 3. 参数错（缺失 + 类型错误 + NaN）----------------------------------------
test('bad args: missing, wrong type, and NaN are all rejected before execution', async () => {
  const missing = validatePlan([{ op: 'readFileRange', startLine: 1 }]);
  assert.equal(missing.some((e) => /missing required arg "path"/.test(e)), true);

  const wrongType = validatePlan([{ op: 'repoGrep', pattern: 123 }]);
  assert.equal(wrongType.some((e) => /pattern must be string, got number/.test(e)), true);
  assert.equal(wrongType.some((e) => /\"pattern\": 123|pattern/.test(e)), true);

  const nan = validatePlan([{ op: 'readFileRange', path: 'a', startLine: NaN, endLine: 2 }]);
  assert.equal(nan.some((e) => /startLine must be number/.test(e)), true);

  const optionalWrong = validatePlan([{ op: 'repoGrep', pattern: 'x', limit: '10' }]);
  assert.equal(optionalWrong.some((e) => /limit must be number/.test(e)), true);

  const io = createFakeIO();
  const out = await executePlan([{ op: 'repoGrep', pattern: 123 }], { io, dryRun: true });
  assert.equal(out.ok, false);
  assert.deepEqual(out.steps, []);
  assert.equal(io.calls.length, 0);
});

// 4. write 必须显式 dryRun 或批准 -------------------------------------------
test('write ops require explicit dryRun or approval; approval forms are honored', async () => {
  const writeOps = ['ensureBranch', 'applyPatch', 'openPr'];
  for (const op of writeOps) {
    assert.equal(OP_REGISTRY[op].effect, 'write');
  }

  const bare = [
    { op: 'ensureBranch', owner: 'o', repo: 'r', branch: 'b' },
    { op: 'openPr', owner: 'o', repo: 'r', head: 'b', base: 'main', title: 't' },
  ];
  const denied = await executePlan(bare, { io: createFakeIO() }); // dryRun false, no approve
  assert.equal(denied.ok, false);
  assert.match(denied.error, /requires dryRun or explicit approve/);
  assert.deepEqual(denied.steps, []);

  const globalApproved = await executePlan(bare, { io: createFakeIO(), approve: ['ensureBranch', 'openPr'] });
  assert.equal(globalApproved.ok, true);
  assert.deepEqual(globalApproved.steps.map((s) => s.op), ['ensureBranch', 'openPr']);

  const perStep = await executePlan(
    [{ op: 'ensureBranch', owner: 'o', repo: 'r', branch: 'b', approve: true }],
    { io: createFakeIO() },
  );
  assert.equal(perStep.ok, true);
  assert.equal(perStep.steps[0].op, 'ensureBranch');
  // Control field must not leak into handler args.
  const io = createFakeIO();
  await executePlan([{ op: 'ensureBranch', owner: 'o', repo: 'r', branch: 'b', approve: true }], { io });
  assert.equal('approve' in io.calls[0].args, false);
});

// 5. patch 失败（上下文不匹配，复用纯函数）----------------------------------
test('patch failure: context mismatch surfaces as PATCH_FAILED with zero write', async () => {
  const io = createFakeIO({ files: { 'a.txt': 'one\ntwo\nthree\n' } });
  const out = await executePlan([
    { op: 'applyPatch', path: 'a.txt', patch: '@@ -2,1 +2,1 @@\n-NOT_TWO\n+X\n' },
  ], { dryRun: true, io });
  assert.equal(out.ok, false);
  assert.equal(out.steps.length, 1);
  STEP_SHAPE(out.steps[0]);
  assert.equal(out.steps[0].ok, false);
  assert.equal(out.steps[0].op, 'applyPatch');
  assert.match(out.steps[0].error, /PATCH_FAILED.*context mismatch/);
  assert.equal(out.stoppedAt, 0);
  assert.equal(io.calls.some((c) => c.op === 'writeFile'), false);
});

// 6. 部分失败（中途 halt，后续步骤不执行）----------------------------------
test('partial failure: plan stops at first failing step; later steps never run', async () => {
  const badIo = createFakeIO({
    files: { 'a.txt': 'one\ntwo\n' },
    openPr: async () => { throw new Error('PR rejected'); },
  });
  const plan = [
    { op: 'ensureBranch', owner: 'o', repo: 'r', branch: 'b', approve: true },
    { op: 'readFileRange', path: 'a.txt', startLine: 1, endLine: 2 },
    { op: 'openPr', owner: 'o', repo: 'r', head: 'b', base: 'main', title: 't', approve: true },
    { op: 'runChecks', command: 'npm test' },
  ];
  const out = await executePlan(plan, { io: badIo });
  assert.equal(out.ok, false);
  assert.deepEqual(out.steps.map((s) => s.op), ['ensureBranch', 'readFileRange', 'openPr']);
  assert.equal(out.stoppedAt, 2);
  assert.match(out.steps[2].error, /PR rejected/);
  out.steps.forEach(STEP_SHAPE);
  assert.equal(badIo.calls.some((c) => c.op === 'runChecks'), false, 'step after failure must not run');
});

// 7. 空 plan ----------------------------------------------------------------
test('empty / non-array plan is rejected deterministically', async () => {
  for (const plan of [[], null, undefined, { op: 'readFileRange' }, 'nope']) {
    const out = await executePlan(plan, { dryRun: true, io: createFakeIO() });
    assert.equal(out.ok, false);
    assert.deepEqual(out.steps, []);
    assert.match(out.error, /non-empty array/);
  }
});

// 8. 确定性（同输入同输出；输入不被修改）-----------------------------------
test('determinism: repeated runs yield identical traces and never mutate the plan', async () => {
  const plan = Object.freeze([
    Object.freeze({ op: 'readFileRange', path: 'a.txt', startLine: 1, endLine: 2 }),
    Object.freeze({ op: 'applyPatch', path: 'a.txt', patch: '@@ -2,1 +2,1 @@\n-two\n+TWO\n' }),
    Object.freeze({ op: 'runChecks', command: 'npm test' }),
  ]);
  const snapshot = JSON.stringify(plan);
  const a = await executePlan(plan, { dryRun: true, io: createFakeIO() });
  const b = await executePlan(plan, { dryRun: true, io: createFakeIO() });
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(plan), snapshot, 'plan must be treated as immutable input');
  // Validation is also pure/deterministic across repeated calls.
  assert.deepEqual(validatePlan(plan, { dryRun: true }), validatePlan(plan, { dryRun: true }));
});

// 补充：registry 完整性（六个 op，effect 标注正确，无网络依赖）
test('registry completeness: exactly six ops with declared effects', () => {
  assert.deepEqual(Object.keys(OP_REGISTRY), [
    'readFileRange', 'repoGrep', 'ensureBranch', 'applyPatch', 'openPr', 'runChecks',
  ]);
  assert.equal(OP_REGISTRY.readFileRange.effect, 'read');
  assert.equal(OP_REGISTRY.repoGrep.effect, 'read');
  assert.equal(OP_REGISTRY.runChecks.effect, 'read');
  assert.equal(OP_REGISTRY.ensureBranch.effect, 'write');
  assert.equal(OP_REGISTRY.applyPatch.effect, 'write');
  assert.equal(OP_REGISTRY.openPr.effect, 'write');
});
