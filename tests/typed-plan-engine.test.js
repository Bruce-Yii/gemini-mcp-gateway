/**
 * Batch 14 — production typed-plan engine tests.
 *
 * Fully offline: every I/O path goes through a local fake adapter. No network,
 * no credentials, no filesystem writes, no production tool registration.
 * Covers: success, unknown op, bad args, unknown fields, unapproved write,
 * read-only write rejection, partial failure, empty plan, idempotence/dryRun,
 * input immutability, and meta stability.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  executeTypedPlan,
  validateTypedPlan,
  createDefaultOps,
  DEFAULT_OPS,
  OP_EFFECTS,
  PLAN_VERSION,
  runTypedPlan,
} from '../src/typed-plan.js';

function fakeIO(overrides = {}) {
  const files = overrides.files || { 'a.txt': 'one\ntwo\nthree\n' };
  const calls = [];
  const record = (op, args, value) => {
    calls.push({ op, args: { ...args } });
    return value;
  };
  return {
    calls,
    files,
    readFileRange: async (args) => record('readFileRange', args, {
      path: args.path,
      text: files[args.path] ?? '',
      lines: (files[args.path] ?? '').split('\n').slice((args.startLine || 1) - 1, args.endLine),
      truncated: false,
    }),
    repoGrep: async (args) => record('repoGrep', args, { matches: [], pattern: args.pattern }),
    ensureBranch: async (args) => record('ensureBranch', args, { branch: args.branch, created: true }),
    writeFile: async (args) => record('writeFile', args, { path: args.path, written: true }),
    openPr: async (args) => record('openPr', args, { number: 1, head: args.head, base: args.base }),
    runChecks: async (args) => record('runChecks', args, { command: args.command, ok: true }),
    ...overrides,
  };
}

const assertStable = (out) => {
  assert.deepEqual(Object.keys(out).sort(), [
    'dryRun', 'error', 'meta', 'ok', 'steps', 'stoppedAt',
  ].concat('validationErrors' in out ? ['validationErrors'] : []).sort());
  assert.equal(typeof out.ok, 'boolean');
  assert.equal(typeof out.dryRun, 'boolean');
  assert.ok(Array.isArray(out.steps));
  assert.ok(out.stoppedAt === null || typeof out.stoppedAt === 'number');
  assert.ok(out.error === null || typeof out.error === 'string');
  assert.ok(out.meta && typeof out.meta === 'object');
  for (const step of out.steps) {
    assert.equal(typeof step.ok, 'boolean');
    assert.equal(typeof step.op, 'string');
    if (step.ok) {
      assert.ok('result' in step);
      assert.ok(!('error' in step));
    } else {
      assert.ok('error' in step);
      assert.ok(!('result' in step));
    }
  }
};

// 1. 成功 -------------------------------------------------------------------
test('success: read -> patch -> check with stable step shape', async () => {
  const io = fakeIO();
  const plan = [
    { op: 'readFileRange', path: 'a.txt', startLine: 1, endLine: 3 },
    { op: 'applyPatch', path: 'a.txt', patch: '@@ -2,1 +2,1 @@\n-two\n+TWO\n' },
    { op: 'runChecks', command: 'npm test' },
  ];
  const out = await executeTypedPlan(plan, { dryRun: true, io });
  assertStable(out);
  assert.equal(out.ok, true);
  assert.equal(out.error, null);
  assert.equal(out.stoppedAt, null);
  assert.deepEqual(out.steps.map((s) => s.op), ['readFileRange', 'applyPatch', 'runChecks']);
  assert.equal(out.steps[1].result.dryRun, true);
  assert.equal(io.calls.some((c) => c.op === 'writeFile'), false, 'dryRun must not write');
});

// 2. 未知 op ----------------------------------------------------------------
test('unknown op: rejected before any handler runs', async () => {
  const io = fakeIO();
  const out = await executeTypedPlan([{ op: 'dropTable', path: 'x' }], { io, dryRun: true });
  assertStable(out);
  assert.equal(out.ok, false);
  assert.deepEqual(out.steps, []);
  assert.equal(out.stoppedAt, null);
  assert.match(out.error, /unknown op/);
  assert.equal(io.calls.length, 0);
});

// 3. 参数错 -----------------------------------------------------------------
test('bad args: missing, wrong type, NaN, and wrong optional type are rejected', async () => {
  const missing = validateTypedPlan([{ op: 'readFileRange', startLine: 1 }]);
  assert.ok(missing.some((e) => /missing required arg "path"/.test(e)));
  assert.ok(validateTypedPlan([{ op: 'repoGrep', pattern: 123 }])
    .some((e) => /pattern must be string, got number/.test(e)));
  assert.ok(validateTypedPlan([{ op: 'readFileRange', path: 'a', startLine: NaN, endLine: 2 }])
    .some((e) => /startLine must be number/.test(e)));
  assert.ok(validateTypedPlan([{ op: 'repoGrep', pattern: 'x', limit: '10' }])
    .some((e) => /limit must be number/.test(e)));

  const io = fakeIO();
  const out = await executeTypedPlan([{ op: 'repoGrep', pattern: 123 }], { io, dryRun: true });
  assert.equal(out.ok, false);
  assert.deepEqual(out.steps, []);
  assert.equal(io.calls.length, 0);
});

// 4. 未知字段 ---------------------------------------------------------------
test('unknown fields: rejected strictly, no handler runs', async () => {
  const io = fakeIO();
  const out = await executeTypedPlan([
    { op: 'readFileRange', path: 'a.txt', startLine: 1, endLine: 2, sneaky: true },
  ], { io, dryRun: true });
  assertStable(out);
  assert.equal(out.ok, false);
  assert.match(out.error, /unknown field "sneaky"/);
  assert.deepEqual(out.steps, []);
  assert.equal(io.calls.length, 0);

  // `approve` is the only non-arg control field and must be boolean.
  const badApprove = await executeTypedPlan([
    { op: 'readFileRange', path: 'a.txt', startLine: 1, endLine: 2, approve: 'yes' },
  ], { io, dryRun: true });
  assert.equal(badApprove.ok, false);
  assert.match(badApprove.error, /approve must be boolean/);
});

// 5. write 未批准 -----------------------------------------------------------
test('write without dryRun or approve is rejected with zero execution', async () => {
  const io = fakeIO();
  const plan = [{ op: 'ensureBranch', owner: 'o', repo: 'r', branch: 'b' }];
  const denied = await executeTypedPlan(plan, { io });
  assertStable(denied);
  assert.equal(denied.ok, false);
  assert.match(denied.error, /requires dryRun or explicit approve/);
  assert.deepEqual(denied.steps, []);
  assert.equal(io.calls.length, 0);

  const global = await executeTypedPlan(plan, { io, approve: ['ensureBranch'] });
  assert.equal(global.ok, true);
  const perStep = await executeTypedPlan([{ ...plan[0], approve: true }], { io: fakeIO() });
  assert.equal(perStep.ok, true);
  const controlIo = fakeIO();
  await executeTypedPlan([{ ...plan[0], approve: true }], { io: controlIo });
  assert.equal('approve' in controlIo.calls[0].args, false, 'control field must not leak to handlers');
});

// 6. read-only 拒绝写 -------------------------------------------------------
test('readOnly mode rejects every write-effect op even when approved', async () => {
  const io = fakeIO();
  const writePlan = [{ op: 'openPr', owner: 'o', repo: 'r', head: 'b', base: 'main', title: 't' }];
  for (const opts of [{ io, readOnly: true, approve: ['openPr'] },
    { io, readOnly: true, dryRun: true },
    { io, readOnly: true },
    { io, readOnly: true, approve: ['openPr'], dryRun: true }]) {
    const out = await executeTypedPlan(writePlan, opts);
    assert.equal(out.ok, false, 'readOnly is a hard boundary');
    assert.match(out.error, /not allowed in read-only mode/);
    assert.deepEqual(out.steps, []);
    assert.equal(io.calls.length, 0);
  }
  assert.equal(OP_EFFECTS.applyPatch, 'write');
  assert.equal(OP_EFFECTS.readFileRange, 'read');

  // read-only plan still works.
  const reads = await executeTypedPlan([
    { op: 'readFileRange', path: 'a.txt', startLine: 1, endLine: 2 },
  ], { io, readOnly: true });
  assert.equal(reads.ok, true);
});

// 7. 部分失败 ---------------------------------------------------------------
test('partial failure: stop at first failing step; later steps never run', async () => {
  const io = fakeIO({ openPr: async () => { throw new Error('PR rejected'); } });
  const plan = [
    { op: 'ensureBranch', owner: 'o', repo: 'r', branch: 'b', approve: true },
    { op: 'readFileRange', path: 'a.txt', startLine: 1, endLine: 2 },
    { op: 'openPr', owner: 'o', repo: 'r', head: 'b', base: 'main', title: 't', approve: true },
    { op: 'runChecks', command: 'npm test' },
  ];
  const out = await executeTypedPlan(plan, { io });
  assertStable(out);
  assert.equal(out.ok, false);
  assert.deepEqual(out.steps.map((s) => s.op), ['ensureBranch', 'readFileRange', 'openPr']);
  assert.equal(out.steps[0].ok, true);
  assert.equal(out.steps[2].ok, false);
  assert.equal(out.stoppedAt, 2);
  assert.match(out.error, /^\openPr: PR rejected$/);
  assert.equal(io.calls.some((c) => c.op === 'runChecks'), false);

  // Patch failure uses the shared pure patcher's error, surfaced as PATCH_FAILED.
  const patchIo = fakeIO();
  const patchOut = await executeTypedPlan([
    { op: 'applyPatch', path: 'a.txt', patch: '@@ -2,1 +2,1 @@\n-NOT_TWO\n+X\n' },
  ], { io: patchIo, dryRun: true });
  assert.equal(patchOut.ok, false);
  assert.equal(patchOut.stoppedAt, 0);
  assert.match(patchOut.steps[0].error, /^PATCH_FAILED:.*context mismatch/);
  assert.equal(patchIo.calls.some((c) => c.op === 'writeFile'), false);
});

// 8. 空 plan ----------------------------------------------------------------
test('empty / non-array plan rejected with stable shape', async () => {
  for (const plan of [[], null, undefined, { op: 'readFileRange' }, 'nope']) {
    const out = await executeTypedPlan(plan, { io: fakeIO(), dryRun: true });
    assertStable(out);
    assert.equal(out.ok, false);
    assert.ok(out.error.includes('non-empty array'));
    assert.deepEqual(out.steps, []);
  }
});

// 9. 幂等 / dryRun ----------------------------------------------------------
test('idempotence: repeated dryRun runs are deep-equal and never write', async () => {
  const plan = [
    { op: 'readFileRange', path: 'a.txt', startLine: 1, endLine: 2 },
    { op: 'applyPatch', path: 'a.txt', patch: '@@ -2,1 +2,1 @@\n-two\n+TWO\n' },
  ];
  const a = await executeTypedPlan(plan, { io: fakeIO(), dryRun: true });
  const b = await executeTypedPlan(plan, { io: fakeIO(), dryRun: true });
  assert.deepEqual(a, b);
  assert.equal(a.dryRun, true);
  assert.deepEqual(validateTypedPlan(plan, { dryRun: true }), validateTypedPlan(plan, { dryRun: true }));

  // runTypedPlan alias behaves identically.
  const alias = await runTypedPlan(plan, { io: fakeIO(), dryRun: true });
  assert.deepEqual(alias, a);
});

// 10. 输入不变 --------------------------------------------------------------
test('input immutability: frozen plan and step objects are never modified', async () => {
  const plan = Object.freeze([
    Object.freeze({ op: 'readFileRange', path: 'a.txt', startLine: 1, endLine: 2 }),
    Object.freeze({ op: 'applyPatch', path: 'a.txt', patch: '@@ -2,1 +2,1 @@\n-two\n+TWO\n', approve: true }),
  ]);
  const snapshot = JSON.stringify(plan);
  await executeTypedPlan(plan, { io: fakeIO() });
  assert.equal(JSON.stringify(plan), snapshot);
  assert.deepEqual(plan[1], { op: 'applyPatch', path: 'a.txt', patch: '@@ -2,1 +2,1 @@\n-two\n+TWO\n', approve: true });
});

// 11. meta ------------------------------------------------------------------
test('meta: stable, deterministic, and reflects options + executed count', async () => {
  const plan = [
    { op: 'readFileRange', path: 'a.txt', startLine: 1, endLine: 2 },
    { op: 'runChecks', command: 'npm test' },
  ];
  const ok = await executeTypedPlan(plan, { io: fakeIO(), approve: ['openPr'] });
  assert.deepEqual(ok.meta, {
    planVersion: PLAN_VERSION,
    readOnly: false,
    approvedOps: ['openPr'],
    executedCount: 2,
  });
  const invalid = await executeTypedPlan([{ op: 'nope' }], { io: fakeIO(), readOnly: true });
  assert.deepEqual(invalid.meta, {
    planVersion: PLAN_VERSION,
    readOnly: true,
    approvedOps: [],
    executedCount: 0,
  });
  const partial = await executeTypedPlan([
    { op: 'readFileRange', path: 'a.txt', startLine: 1, endLine: 2 },
    { op: 'repoGrep', pattern: 'x', other: 1 },
  ], { io: fakeIO(), dryRun: true });
  assert.equal(partial.meta.executedCount, 0, 'whole-plan validation rejects before any handler runs');
});

// 补充：registry 可注入 + 六个核心 op 完整 ----------------------------------
test('registry injection: custom ops run; built-ins remain the six core ops', async () => {
  const custom = {
    ...createDefaultOps(),
    ping: { effect: 'read', fields: { value: 'string' }, optional: {}, run: async (args) => ({ pong: args.value }) },
  };
  const io = fakeIO();
  const out = await executeTypedPlan([{ op: 'ping', value: 'hi' }], { ops: custom, io });
  assert.equal(out.ok, true);
  assert.deepEqual(out.steps[0].result, { pong: 'hi' });

  assert.deepEqual(Object.keys(DEFAULT_OPS), [
    'readFileRange', 'repoGrep', 'ensureBranch', 'applyPatch', 'openPr', 'runChecks',
  ]);
  assert.equal(Object.isFrozen(DEFAULT_OPS), true);
  assert.equal(createDefaultOps() === DEFAULT_OPS, false, 'createDefaultOps returns a fresh copy');
  assert.equal(PLAN_VERSION, 'v2.0.0');
});
