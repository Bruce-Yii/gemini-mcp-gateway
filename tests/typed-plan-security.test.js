/**
 * Batch 14 — typed-plan audit regression tests (HIGH + MEDIUM).
 *
 * Fully offline: every I/O path is a local fake adapter; no network, no
 * credentials, no filesystem writes, no MCP tool registration.
 *
 * Audit findings covered:
 *   HIGH   applyPatch must refuse a readFileRange result with truncated:true
 *          or an in-band `--- TRUNCATED ---` marker; opt-out requires an
 *          explicit HOST option `allowTruncatedRead:true` (default false).
 *          Never write a partial file silently.
 *   MEDIUM per-step `approve:true` is a guest forgery of host consent: write
 *          ops only accept the HOST-issued top-level `approve` option (or the
 *          dryRun preview path). Per-step approve is rejected explicitly.
 *   REVIEW readOnly whole-plan validation before any handler; unapproved write
 *          = zero handler calls; unknown fields / wrong types / NaN rejected.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  executeTypedPlan,
  validateTypedPlan,
} from '../src/typed-plan.js';

const PATCH = '@@ -2,1 +2,1 @@\n-two\n+TWO\n';
const FULL_TEXT = 'one\ntwo\nthree\n';

function fakeIO(overrides = {}) {
  const files = overrides.files || { 'a.txt': FULL_TEXT };
  const calls = [];
  const record = (op, args, value) => {
    calls.push({ op, args: { ...args } });
    return value;
  };
  const base = {
    readFileRange: async (args) => ({
      path: args.path,
      text: files[args.path] ?? '',
      lines: (files[args.path] ?? '').split('\n').slice((args.startLine || 1) - 1, args.endLine),
      truncated: false,
    }),
    repoGrep: async (args) => ({ matches: [], pattern: args.pattern }),
    ensureBranch: async (args) => ({ branch: args.branch, created: true }),
    writeFile: async (args) => ({ path: args.path, written: true }),
    openPr: async (args) => ({ number: 1, head: args.head, base: args.base }),
    runChecks: async (args) => ({ command: args.command, ok: true }),
    ...overrides,
  };
  // Wrap every adapter method in a recorder so overrides are audited too.
  const io = { calls, files };
  for (const [op, fn] of Object.entries(base)) {
    if (typeof fn === 'function') {
      io[op] = async (args) => record(op, args, await fn(args));
    }
  }
  return io;
}

/** Stable top-level envelope, mirroring the engine contract. */
function assertStable(out) {
  assert.deepEqual(Object.keys(out).sort(), [
    'dryRun', 'error', 'meta', 'ok', 'steps', 'stoppedAt',
  ].concat('validationErrors' in out ? ['validationErrors'] : []).sort());
  assert.equal(typeof out.ok, 'boolean');
  assert.equal(typeof out.dryRun, 'boolean');
  assert.ok(Array.isArray(out.steps));
  assert.ok(out.stoppedAt === null || typeof out.stoppedAt === 'number');
  assert.ok(out.error === null || typeof out.error === 'string');
  assert.deepEqual(Object.keys(out.meta).sort(), [
    'planVersion', 'readOnly', 'approvedOps', 'executedCount',
  ].sort());
}

const writeCalls = (io) => io.calls.filter((c) => c.op === 'writeFile');
const ops = (io) => io.calls.map((c) => c.op);

// ---------------------------------------------------------------------------
// 1. HIGH — truncated reads must never be patched/written
// ---------------------------------------------------------------------------

test('HIGH: truncated:true read is refused before patch/write (dryRun path)', async () => {
  const io = fakeIO({
    readFileRange: async (args) => ({
      path: args.path, text: 'one\ntwo\n', truncated: true,
      truncation: { reason: 'range' }, lines: ['one', 'two'],
    }),
  });
  const out = await executeTypedPlan(
    [{ op: 'applyPatch', path: 'a.txt', patch: PATCH }],
    { io, dryRun: true },
  );
  assertStable(out);
  assert.equal(out.ok, false);
  assert.equal(out.stoppedAt, 0);
  assert.equal(out.steps.length, 1);
  assert.equal(out.steps[0].ok, false);
  assert.match(out.steps[0].error, /^PATCH_READ_TRUNCATED:/);
  assert.match(out.error, /PATCH_READ_TRUNCATED/);
  assert.deepEqual(ops(io), ['readFileRange'], 'no patcher preview/write after a truncated read');
  assert.equal(writeCalls(io).length, 0);
  assert.equal('preview' in (out.steps[0].result ?? {}), false, 'no silent preview from partial text');
});

test('HIGH: truncated:true read is refused on a real (host-approved) write', async () => {
  const io = fakeIO({
    readFileRange: async (args) => ({ path: args.path, text: 'one\ntwo\n', truncated: true }),
  });
  const out = await executeTypedPlan(
    [{ op: 'applyPatch', path: 'a.txt', patch: PATCH }],
    { io, approve: ['applyPatch'] },
  );
  assertStable(out);
  assert.equal(out.ok, false);
  assert.equal(out.steps[0].error.startsWith('PATCH_READ_TRUNCATED:'), true);
  assert.deepEqual(ops(io), ['readFileRange'], 'writeFile must never be reached');
  assert.equal(writeCalls(io).length, 0);
});

test('HIGH: in-band --- TRUNCATED --- marker is refused even without truncated:true', async () => {
  const io = fakeIO({
    readFileRange: async (args) => ({
      path: args.path, text: 'one\ntwo\n--- TRUNCATED ---', truncated: false,
    }),
  });
  const out = await executeTypedPlan(
    [{ op: 'applyPatch', path: 'a.txt', patch: PATCH }],
    { io, dryRun: true },
  );
  assert.equal(out.ok, false);
  assert.equal(out.steps[0].ok, false);
  assert.match(out.steps[0].error, /^PATCH_READ_TRUNCATED:/);
  assert.deepEqual(ops(io), ['readFileRange']);
  assert.equal(writeCalls(io).length, 0);
});

test('HIGH: string-shaped read result with marker is refused too', async () => {
  const io = fakeIO({
    readFileRange: async () => 'one\ntwo\n--- TRUNCATED ---',
  });
  const out = await executeTypedPlan(
    [{ op: 'applyPatch', path: 'a.txt', patch: PATCH }],
    { io, dryRun: true },
  );
  assert.equal(out.ok, false);
  assert.match(out.steps[0].error, /^PATCH_READ_TRUNCATED:/);
  assert.deepEqual(ops(io), ['readFileRange']);
});

test('HIGH: host allowTruncatedRead:true explicitly authorizes a truncated read (dryRun)', async () => {
  const io = fakeIO({
    readFileRange: async (args) => ({ path: args.path, text: 'one\ntwo\nthree\n', truncated: true }),
  });
  const out = await executeTypedPlan(
    [{ op: 'applyPatch', path: 'a.txt', patch: PATCH }],
    { io, dryRun: true, allowTruncatedRead: true },
  );
  assertStable(out);
  assert.equal(out.ok, true);
  assert.equal(out.steps[0].ok, true);
  assert.equal(out.steps[0].result.dryRun, true);
  assert.match(out.steps[0].result.preview, /TWO/);
  assert.deepEqual(ops(io), ['readFileRange'], 'dryRun still performs no real write');
});

test('HIGH: host allowTruncatedRead:true explicitly authorizes a real write', async () => {
  const io = fakeIO({
    readFileRange: async (args) => ({ path: args.path, text: FULL_TEXT, truncated: true }),
  });
  const out = await executeTypedPlan(
    [{ op: 'applyPatch', path: 'a.txt', patch: PATCH }],
    { io, approve: ['applyPatch'], allowTruncatedRead: true },
  );
  assert.equal(out.ok, true);
  assert.deepEqual(ops(io), ['readFileRange', 'writeFile']);
  assert.match(writeCalls(io)[0].args.content, /TWO/);
});

test('HIGH: a per-step allowTruncatedRead cannot bypass the host-only opt-out', async () => {
  const io = fakeIO({
    readFileRange: async (args) => ({ path: args.path, text: FULL_TEXT, truncated: true }),
  });
  const out = await executeTypedPlan(
    [{ op: 'applyPatch', path: 'a.txt', patch: PATCH, allowTruncatedRead: true }],
    { io, dryRun: true },
  );
  assert.equal(out.ok, false);
  assert.match(out.error, /allowTruncatedRead is host-only/);
  assert.deepEqual(ops(io), [], 'validation rejects before any handler');
});

// ---------------------------------------------------------------------------
// 2. MEDIUM — host-issued approval only
// ---------------------------------------------------------------------------

test('MEDIUM: per-step approve:true no longer authorizes a real write', async () => {
  const io = fakeIO();
  const out = await executeTypedPlan(
    [{ op: 'ensureBranch', owner: 'o', repo: 'r', branch: 'b', approve: true }],
    { io },
  );
  assertStable(out);
  assert.equal(out.ok, false);
  assert.equal(out.stoppedAt, null, 'whole-plan validation failure, not an execution failure');
  assert.match(out.error, /APPROVAL_REQUIRES_HOST/);
  assert.deepEqual(out.steps, []);
  assert.deepEqual(ops(io), [], 'zero handler calls for an unapproved write');
});

test('MEDIUM: every write op rejects per-step approve, including applyPatch and openPr', async () => {
  const writeSteps = [
    { op: 'applyPatch', path: 'a.txt', patch: PATCH, approve: true },
    { op: 'openPr', owner: 'o', repo: 'r', head: 'b', base: 'main', title: 't', approve: true },
  ];
  const errors = validateTypedPlan(writeSteps);
  // Each write step yields two errors: the forged step approve and the
  // still-missing host approval. Both must be present.
  assert.equal(errors.filter((e) => e.includes('APPROVAL_REQUIRES_HOST')).length >= 2, true);
  assert.equal(errors.filter((e) => e.includes('per-step approve is not allowed')).length, 2);
  const io = fakeIO();
  const out = await executeTypedPlan(writeSteps, { io });
  assert.equal(out.ok, false);
  assert.deepEqual(out.steps, []);
  assert.deepEqual(ops(io), []);
});

test('MEDIUM: even a read op carrying per-step approve is rejected (forgery is never allowed)', async () => {
  const io = fakeIO();
  const out = await executeTypedPlan(
    [{ op: 'readFileRange', path: 'a.txt', startLine: 1, endLine: 2, approve: true }],
    { io, dryRun: true },
  );
  assert.equal(out.ok, false);
  assert.match(out.error, /APPROVAL_REQUIRES_HOST/);
  assert.deepEqual(ops(io), []);
});

test('MEDIUM: host top-level approve (array) authorizes real writes', async () => {
  const io = fakeIO();
  const plan = [
    { op: 'ensureBranch', owner: 'o', repo: 'r', branch: 'b' },
    { op: 'applyPatch', path: 'a.txt', patch: PATCH },
  ];
  const out = await executeTypedPlan(plan, { io, approve: ['ensureBranch', 'applyPatch'] });
  assertStable(out);
  assert.equal(out.ok, true);
  assert.deepEqual(ops(io), ['ensureBranch', 'readFileRange', 'writeFile']);
  assert.deepEqual(out.meta.approvedOps, ['ensureBranch', 'applyPatch']);
  assert.equal(writeCalls(io).length, 1);
});

test('MEDIUM: host top-level approve (single op name string) authorizes a real write', async () => {
  const io = fakeIO();
  const out = await executeTypedPlan(
    [{ op: 'ensureBranch', owner: 'o', repo: 'r', branch: 'b' }],
    { io, approve: 'ensureBranch' },
  );
  assert.equal(out.ok, true);
  assert.deepEqual(ops(io), ['ensureBranch']);
  assert.deepEqual(out.meta.approvedOps, ['ensureBranch']);
});

test('MEDIUM: host approve for a different op does not authorize this write', async () => {
  const io = fakeIO();
  const out = await executeTypedPlan(
    [{ op: 'ensureBranch', owner: 'o', repo: 'r', branch: 'b' }],
    { io, approve: ['openPr'] },
  );
  assert.equal(out.ok, false);
  assert.match(out.error, /APPROVAL_REQUIRES_HOST/);
  assert.deepEqual(ops(io), []);
});

test('MEDIUM: dryRun preview path stays available without any approval', async () => {
  const io = fakeIO();
  const out = await executeTypedPlan(
    [{ op: 'applyPatch', path: 'a.txt', patch: PATCH }],
    { io, dryRun: true },
  );
  assert.equal(out.ok, true);
  assert.equal(out.dryRun, true);
  assert.equal(out.steps[0].result.dryRun, true);
  assert.match(out.steps[0].result.preview, /TWO/);
  assert.deepEqual(ops(io), ['readFileRange'], 'preview only — no writeFile');
});

// ---------------------------------------------------------------------------
// 3. REVIEW — readOnly, strict validation, zero side effects on failure
// ---------------------------------------------------------------------------

test('REVIEW: readOnly whole-plan validation rejects every write before any handler runs', async () => {
  const io = fakeIO();
  const plan = [
    { op: 'openPr', owner: 'o', repo: 'r', head: 'b', base: 'main', title: 't' },
    { op: 'applyPatch', path: 'a.txt', patch: PATCH },
  ];
  for (const opts of [
    { readOnly: true },
    { readOnly: true, dryRun: true },
    { readOnly: true, approve: ['openPr', 'applyPatch'] },
    { readOnly: true, approve: ['openPr', 'applyPatch'], allowTruncatedRead: true },
  ]) {
    const out = await executeTypedPlan(plan, { io, ...opts });
    assert.equal(out.ok, false);
    assert.equal(out.stoppedAt, null);
    assert.match(out.error, /not allowed in read-only mode/);
    assert.deepEqual(out.steps, []);
    assert.equal(out.meta.readOnly, true);
  }
  assert.deepEqual(ops(io), [], 'no handler ran across all readOnly variants');

  const reads = await executeTypedPlan(
    [{ op: 'readFileRange', path: 'a.txt', startLine: 1, endLine: 2 }],
    { io, readOnly: true },
  );
  assert.equal(reads.ok, true);
});

test('REVIEW: unknown fields, wrong types and NaN are rejected with zero handler calls', async () => {
  const io = fakeIO();
  const cases = [
    [{ op: 'readFileRange', path: 'a.txt', startLine: 1, endLine: 2, sneaky: true }, /unknown field "sneaky"/],
    [{ op: 'repoGrep', pattern: 123 }, /pattern must be string/],
    [{ op: 'readFileRange', path: 'a', startLine: NaN, endLine: 2 }, /startLine must be number/],
    [{ op: 'repoGrep', pattern: 'x', limit: Infinity }, /limit must be number/],
    [{ op: 'readFileRange', path: 'a', startLine: 1, endLine: '2' }, /endLine must be number/],
    [{ op: 'noSuchOp', path: 'a' }, /unknown op/],
  ];
  for (const [step, pattern] of cases) {
    const out = await executeTypedPlan([step], { io, dryRun: true });
    assert.equal(out.ok, false);
    assert.match(out.error, pattern);
    assert.deepEqual(out.steps, []);
  }
  assert.deepEqual(ops(io), []);

  assert.match(validateTypedPlan(
    [{ op: 'readFileRange', path: 'a', startLine: 1, endLine: 2 }],
    { allowTruncatedRead: 'yes' },
  ).join('; '), /allowTruncatedRead must be boolean/);
});

test('REVIEW: failing step stops the plan and leaves no side effects after the failure', async () => {
  // Truncated read at step 2: earlier reads happened, the write and every
  // later step must never run.
  const io = fakeIO({
    readFileRange: async (args) => (args.path === 'partial.txt'
      ? { path: args.path, text: 'partial\n--- TRUNCATED ---', truncated: false }
      : { path: args.path, text: FULL_TEXT, truncated: false }),
  });
  const plan = [
    { op: 'repoGrep', pattern: 'two' },
    { op: 'applyPatch', path: 'partial.txt', patch: PATCH },
    { op: 'runChecks', command: 'npm test' },
  ];
  const out = await executeTypedPlan(plan, { io, dryRun: true });
  assertStable(out);
  assert.equal(out.ok, false);
  assert.equal(out.stoppedAt, 1);
  assert.deepEqual(out.steps.map((s) => s.op), ['repoGrep', 'applyPatch']);
  assert.equal(out.steps[0].ok, true);
  assert.equal(out.steps[1].ok, false);
  assert.match(out.steps[1].error, /^PATCH_READ_TRUNCATED:/);
  assert.deepEqual(ops(io), ['repoGrep', 'readFileRange'], 'runChecks must not run after failure');
  assert.equal(writeCalls(io).length, 0);
});

test('REVIEW: frozen plans are never mutated on either rejection path', async () => {
  const plan = Object.freeze([
    Object.freeze({ op: 'applyPatch', path: 'a.txt', patch: PATCH, approve: true }),
  ]);
  const snapshot = JSON.stringify(plan);
  const io = fakeIO();
  await executeTypedPlan(plan, { io, dryRun: true, allowTruncatedRead: true });
  assert.equal(JSON.stringify(plan), snapshot);
  assert.deepEqual(ops(io), [], 'per-step approve still rejects with the opt-out enabled');
});
