/**
 * Batch 14 — typed-plan host helper wired into the Code Mode sandbox.
 *
 * `codemode.runTypedPlan(plan, opts)` is a SANDBOX HELPER, not a fourth MCP
 * tool: this file verifies it is callable from execute({code}) scripts, that
 * the host enforces read-only / dryRun boundaries, that errors come back as
 * stable {ok:false,...} data (never crash the sandbox), and that the public
 * three-tool surface is byte-for-byte unchanged.
 *
 * Fully offline: every io path is a local fake adapter injected through
 * runInSandbox({ typedPlanIO }). No network, no credentials, no filesystem
 * writes, no real upstream tool is ever called.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runInSandbox, createCodeModeTools } from '../src/codemode.js';
import { PLAN_VERSION } from '../src/typed-plan.js';

// ---------------------------------------------------------------------------
// Fakes / helpers
// ---------------------------------------------------------------------------

function fakeIO(overrides = {}) {
  const calls = [];
  const files = overrides.files || { 'a.txt': 'one\ntwo\nthree\n' };
  const record = (op, args, value) => { calls.push({ op, args: { ...args } }); return value; };
  const base = {
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
  };
  return { ...base, ...overrides, calls };
}

const FILES = { 'a.txt': 'one\ntwo\nthree\n' };
const PATCH = '@@ -2,1 +2,1 @@\n-two\n+TWO\n';

/** Run a guest body with an injected io adapter; returns parsed result + audit. */
async function runHelper(body, { adapter = fakeIO({ files: FILES }), readOnly = false, tools = [], callTool } = {}) {
  const out = await runInSandbox({
    code: `async () => { ${body} }`,
    tools,
    callTool: callTool ?? (async () => { throw new Error('unexpected upstream call'); }),
    typedPlanIO: adapter,
    typedPlanReadOnly: readOnly,
  });
  return { out, adapter, value: out.isError ? null : JSON.parse(out.result) };
}

/** Assert a stable typed-plan result envelope (from the engine contract). */
function assertStable(value) {
  assert.ok(value && typeof value === 'object');
  assert.deepEqual(Object.keys(value).sort(), [
    'dryRun', 'error', 'meta', 'ok', 'steps', 'stoppedAt',
  ].concat('validationErrors' in value ? ['validationErrors'] : []).sort());
  assert.equal(typeof value.ok, 'boolean');
  assert.equal(typeof value.dryRun, 'boolean');
  assert.ok(Array.isArray(value.steps));
  assert.ok(value.stoppedAt === null || typeof value.stoppedAt === 'number');
  assert.ok(value.error === null || typeof value.error === 'string');
  assert.deepEqual(Object.keys(value.meta).sort(), [
    'approvedOps', 'executedCount', 'planVersion', 'readOnly',
  ].sort());
  assert.equal(value.meta.planVersion, PLAN_VERSION);
}

// ---------------------------------------------------------------------------
// 1. helper is callable inside the sandbox
// ---------------------------------------------------------------------------

test('helper is callable and returns the engine result through the sandbox', async () => {
  const plan = [
    { op: 'readFileRange', path: 'a.txt', startLine: 1, endLine: 2 },
    { op: 'runChecks', command: 'npm test' },
  ];
  const { out, value, adapter } = await runHelper(
    `return codemode.runTypedPlan(${JSON.stringify(plan)}, { dryRun: true });`,
  );
  assert.ok(!out.isError, out.result);
  assertStable(value);
  assert.equal(value.ok, true);
  assert.equal(value.error, null);
  assert.deepEqual(value.steps.map((s) => s.op), ['readFileRange', 'runChecks']);
  assert.deepEqual(adapter.calls.map((c) => c.op), ['readFileRange', 'runChecks']);
});

test('helper result shape survives the full execute({code}) tool handler', async () => {
  const manager = {
    getEntries: () => [],
    callTool: async () => { throw new Error('unexpected upstream call'); },
  };
  const [searchTool, readTool, execTool] = createCodeModeTools(manager, {
    typedPlanIO: fakeIO({ files: FILES }),
  });
  const plan = [{ op: 'readFileRange', path: 'a.txt', startLine: 1, endLine: 2 }];
  const result = await execTool.handler({
    code: `async () => codemode.runTypedPlan(${JSON.stringify(plan)}, { dryRun: true })`,
  });
  assert.ok(result && typeof result === 'object');
  assert.equal(result.isError, undefined, 'not an error result');
  assert.equal(result.result.ok, true);
  assert.deepEqual(result.result.steps.map((s) => s.op), ['readFileRange']);
  // no toolCalls/logs leaked into the model projection
  assert.equal('toolCalls' in result, false);
  assert.equal('logs' in result, false);
  void searchTool; void readTool;
});

// ---------------------------------------------------------------------------
// 2. read/write separation (both directions)
// ---------------------------------------------------------------------------

test('execute mode: dryRun plan reads and previews writes without real writes', async () => {
  const plan = [
    { op: 'readFileRange', path: 'a.txt', startLine: 1, endLine: 3 },
    { op: 'applyPatch', path: 'a.txt', patch: PATCH },
    { op: 'runChecks', command: 'npm test' },
  ];
  const { value, adapter } = await runHelper(
    `return codemode.runTypedPlan(${JSON.stringify(plan)}, { dryRun: true });`,
  );
  assert.equal(value.ok, true);
  assert.deepEqual(value.steps.map((s) => s.op), ['readFileRange', 'applyPatch', 'runChecks']);
  assert.equal(value.steps[1].result.dryRun, true);
  assert.ok(value.steps[1].result.preview.includes('TWO'));
  assert.equal(adapter.calls.some((c) => c.op === 'writeFile'), false, 'dryRun must not write');
});

test('execute mode: real write runs only with explicit dryRun:false + approve', async () => {
  const plan = [{ op: 'ensureBranch', owner: 'o', repo: 'r', branch: 'b' }];
  const { value, adapter } = await runHelper(
    `return codemode.runTypedPlan(${JSON.stringify(plan)}, { dryRun: false, approve: ['ensureBranch'] });`,
  );
  assert.equal(value.ok, true);
  assert.equal(value.dryRun, false);
  assert.equal(value.meta.approvedOps[0], 'ensureBranch');
  assert.deepEqual(adapter.calls.map((c) => c.op), ['ensureBranch']);
});

test('execute_read context forces readOnly and rejects write ops', async () => {
  const writePlan = [
    { op: 'openPr', owner: 'o', repo: 'r', head: 'b', base: 'main', title: 't' },
  ];
  // The guest tries hard to opt out: dryRun:false + approve + step approve:true.
  const { out, value, adapter } = await runHelper(
    `return codemode.runTypedPlan(${JSON.stringify(writePlan)},
      { dryRun: false, approve: ['openPr'] });`,
    { readOnly: true },
  );
  assert.ok(!out.isError, out.result);
  assertStable(value);
  assert.equal(value.ok, false);
  assert.equal(value.meta.readOnly, true, 'host forced readOnly');
  assert.match(value.error, /not allowed in read-only mode/);
  assert.deepEqual(value.steps, []);
  assert.deepEqual(adapter.calls, [], 'no io handler ran in read-only rejection');
});

test('execute_read still allows read-only plans', async () => {
  const plan = [{ op: 'repoGrep', pattern: 'two' }];
  const { value, adapter } = await runHelper(
    `return codemode.runTypedPlan(${JSON.stringify(plan)});`,
    { readOnly: true },
  );
  assert.equal(value.ok, true);
  assert.equal(value.meta.readOnly, true);
  assert.deepEqual(adapter.calls.map((c) => c.op), ['repoGrep']);
});

// ---------------------------------------------------------------------------
// 3. dryRun default (true in execute mode)
// ---------------------------------------------------------------------------

test('dryRun defaults to true in execute mode — writes become previews', async () => {
  const plan = [{ op: 'applyPatch', path: 'a.txt', patch: PATCH }];
  const { value, adapter } = await runHelper(
    `return codemode.runTypedPlan(${JSON.stringify(plan)});`,
  );
  assert.equal(value.ok, true);
  assert.equal(value.dryRun, true, 'host applied dryRun default');
  assert.equal(value.steps[0].result.dryRun, true);
  assert.equal(adapter.calls.some((c) => c.op === 'writeFile'), false);
});

test('explicit dryRun:false + approve triggers a real write', async () => {
  const plan = [{ op: 'applyPatch', path: 'a.txt', patch: PATCH }];
  const { value, adapter } = await runHelper(
    `return codemode.runTypedPlan(${JSON.stringify(plan)}, { dryRun: false, approve: ['applyPatch'] });`,
  );
  assert.equal(value.ok, true);
  assert.equal(value.dryRun, false);
  const writes = adapter.calls.filter((c) => c.op === 'writeFile');
  assert.equal(writes.length, 1);
  assert.ok(writes[0].args.content.includes('TWO'));
});

// ---------------------------------------------------------------------------
// 4. unknown op / unapproved write → stable {ok:false,...}, no crash
// ---------------------------------------------------------------------------

test('unknown op returns stable failure; sandbox keeps running afterward', async () => {
  const { out, value, adapter } = await runHelper(`
    const bad = codemode.runTypedPlan([{ op: 'dropTable' }]);
    const good = codemode.runTypedPlan([{ op: 'runChecks', command: 'x' }]);
    return { bad, good };
  `);
  assert.ok(!out.isError, out.result);
  assertStable(value.bad);
  assert.equal(value.bad.ok, false);
  assert.match(value.bad.error, /unknown op/);
  assert.deepEqual(value.bad.steps, []);
  assert.equal(value.good.ok, true, 'sandbox survived the failed helper call');
  assert.deepEqual(adapter.calls.map((c) => c.op), ['runChecks']);
});

test('write without approve (dryRun:false) is rejected with zero side effects', async () => {
  const plan = [{ op: 'ensureBranch', owner: 'o', repo: 'r', branch: 'b' }];
  const { value, adapter } = await runHelper(
    `return codemode.runTypedPlan(${JSON.stringify(plan)}, { dryRun: false });`,
  );
  assertStable(value);
  assert.equal(value.ok, false);
  assert.match(value.error, /requires dryRun or explicit approve/);
  assert.deepEqual(adapter.calls, []);
});

test('malformed plan / bad args never crash the sandbox', async () => {
  const { out, value } = await runHelper(`
    const empty = codemode.runTypedPlan([]);
    const badarg = codemode.runTypedPlan([{ op: 'repoGrep', pattern: 123 }]);
    const weird = codemode.runTypedPlan('not-an-array');
    return { empty, badarg, weird };
  `);
  assert.ok(!out.isError, out.result);
  for (const key of ['empty', 'badarg', 'weird']) {
    assertStable(value[key]);
    assert.equal(value[key].ok, false);
  }
  assert.match(value.empty.error, /non-empty array/);
  assert.match(value.badarg.error, /pattern must be string/);
});

test('io adapter throwing is surfaced as a stable step error, not a sandbox crash', async () => {
  const adapter = fakeIO({ files: FILES, readFileRange: async () => { throw new Error('boom'); } });
  const plan = [{ op: 'readFileRange', path: 'a.txt', startLine: 1, endLine: 2 }];
  const { out, value } = await runHelper(
    `return codemode.runTypedPlan(${JSON.stringify(plan)});`,
    { adapter },
  );
  assert.ok(!out.isError, out.result);
  assertStable(value);
  assert.equal(value.ok, false);
  assert.equal(value.stoppedAt, 0);
  assert.equal(value.steps.length, 1);
  assert.equal(value.steps[0].ok, false);
  assert.match(value.steps[0].error, /boom/);
});

// ---------------------------------------------------------------------------
// 5. result stability / determinism / no silent truncation
// ---------------------------------------------------------------------------

test('same plan + same options is deep-equal across repeated calls', async () => {
  const plan = [
    { op: 'readFileRange', path: 'a.txt', startLine: 1, endLine: 3 },
    { op: 'applyPatch', path: 'a.txt', patch: PATCH },
  ];
  const { value } = await runHelper(`
    const p = ${JSON.stringify(plan)};
    return { a: codemode.runTypedPlan(p, { dryRun: true }), b: codemode.runTypedPlan(p, { dryRun: true }) };
  `);
  assert.deepEqual(value.a, value.b);
  assertStable(value.a);
});

test('no silent truncation: io truncated flag is preserved in step result', async () => {
  const adapter = fakeIO({
    files: FILES,
    readFileRange: async (args) => ({
      path: args.path, text: 'TRUNCATED-BODY', truncated: true,
      truncation: { reason: 'upstream', detail: 'cut' }, lines: ['TRUNCATED-BODY'],
    }),
  });
  const plan = [{ op: 'readFileRange', path: 'a.txt', startLine: 1, endLine: 3 }];
  const { value } = await runHelper(
    `return codemode.runTypedPlan(${JSON.stringify(plan)});`,
    { adapter },
  );
  assert.equal(value.steps[0].result.truncated, true);
  assert.deepEqual(value.steps[0].result.truncation, { reason: 'upstream', detail: 'cut' });
});

// ---------------------------------------------------------------------------
// 6. three MCP tools unchanged (no fourth tool / no schema/name/order/annotation drift)
// ---------------------------------------------------------------------------

test('createCodeModeTools still returns exactly the same three tools', () => {
  const manager = { getEntries: () => [], callTool: async () => ({}) };
  const tools = createCodeModeTools(manager);
  assert.equal(tools.length, 3);
  assert.deepEqual(tools.map((t) => t.name), ['search', 'execute_read', 'execute']);

  // schemas untouched
  assert.deepEqual(tools[0].inputSchema, {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Keywords describing the capability you need' },
      limit: { type: 'integer', minimum: 1, maximum: 10 },
    },
    required: ['query'],
  });
  for (const t of [tools[1], tools[2]]) {
    assert.deepEqual(t.inputSchema, {
      type: 'object',
      properties: { code: { type: 'string', description: 'An async arrow function that calls codemode tools and returns a result.' } },
      required: ['code'],
    });
  }
  // annotations untouched
  assert.deepEqual(tools[0].annotations, { readOnlyHint: true, destructiveHint: false, openWorldHint: false });
  assert.deepEqual(tools[1].annotations, { readOnlyHint: true, destructiveHint: false, openWorldHint: true });
  assert.deepEqual(tools[2].annotations, { readOnlyHint: false, destructiveHint: true, openWorldHint: true });
  // no helper leaked into any inputSchema
  for (const t of tools) {
    assert.equal(JSON.stringify(t.inputSchema).includes('plan'), false);
    assert.equal(JSON.stringify(t.inputSchema).includes('runTypedPlan'), false);
  }
});

test('runTypedPlan is a sandbox helper only — not registered as a tool', () => {
  const manager = {
    getEntries: () => [{ server: 'github', tool: 'x', name: 'github__x', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } }],
    callTool: async () => ({ content: [] }),
  };
  const tools = createCodeModeTools(manager);
  assert.equal(tools.some((t) => /typed|plan/i.test(t.name)), false);
  assert.equal(tools.length, 3);
});
