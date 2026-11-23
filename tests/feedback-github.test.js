import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createIssue,
  canonicalIssue,
  rerunFailedJobs,
  mergePrWithOptionalBranchDelete,
  deleteFiles,
  renameFiles,
  unwrapBatch,
  UNSUPPORTED_UPSTREAM_TOOL,
} from '../src/execution/github-helpers.js';
import {
  normalizePrResult,
  normalizeIssueResult,
  canonicalIssueResult,
} from '../src/execution/result-normalize.js';
import { runInSandbox, createCodeModeTools } from '../src/codemode.js';

// ---------------------------------------------------------------------------
// OF-1 · createIssue: dedupe / number-from-URL / short poll / idempotency
// ---------------------------------------------------------------------------

test('createIssue: number comes from URL, never from internal id', async () => {
  const created = await createIssue({
    callables: {
      github__create_issue: async () => ({
        id: 9876543210, // internal DB id — must NOT become number
        title: 'Login fails',
        body: 'step 1',
        html_url: 'https://github.com/acme/repo/issues/42',
        state: 'open',
      }),
    },
    owner: 'acme', repo: 'repo', title: 'Login fails', body: 'step 1',
  });
  assert.equal(created.ok, true);
  assert.equal(created.created, true);
  assert.equal(created.issue.number, 42);
  assert.equal(created.issue.id, '9876543210');
  assert.equal(created.issue.url, 'https://github.com/acme/repo/issues/42');
  assert.equal(created.issue.state, 'open');
  assert.equal(Object.prototype.hasOwnProperty.call(created.issue, 'raw'), true);
});

test('createIssue: dedupe before create — repeated call reuses the existing issue', async () => {
  let createCount = 0;
  const existing = {
    number: 90, id: 111, title: 'Duplicate check', body: 'same body',
    html_url: 'https://github.com/acme/repo/issues/90', state: 'open',
  };
  const opts = {
    callables: {
      github__list_issues: async () => [existing],
      github__create_issue: async () => { createCount += 1; return { ...existing, number: 91 }; },
    },
    owner: 'acme', repo: 'repo', title: 'Duplicate check', body: 'same body',
  };
  const first = await createIssue(opts);
  const second = await createIssue(opts);
  assert.equal(first.created, false);
  assert.equal(first.reused, true);
  assert.equal(second.created, false);
  assert.equal(second.issue.number, 90);
  assert.equal(createCount, 0, 'no create call when a matching issue exists');
});

test('createIssue: short-polls after create when number is missing (list-index delay)', async () => {
  let polls = 0;
  const sleeps = [];
  const result = await createIssue({
    callables: {
      // create response has ONLY an internal id — no number, no URL
      github__create_issue: async () => ({ id: 999, title: 'Delayed', body: 'x', state: 'open' }),
      // the list index is eventually consistent: pre-check (call 1) is empty,
      // polls 2 and 3 are still empty, poll 4 finally contains the new issue.
      github__list_issues: async () => {
        polls += 1;
        if (polls < 4) return [];
        return [{ number: 101, id: 999, title: 'Delayed', body: 'x', html_url: 'https://github.com/acme/repo/issues/101', state: 'open' }];
      },
    },
    sleep: async (ms) => { sleeps.push(ms); },
    owner: 'acme', repo: 'repo', title: 'Delayed', body: 'x', maxPolls: 5,
  });
  assert.equal(result.created, true);
  assert.equal(result.issue.number, 101);
  assert.equal(result.foundAfterCreate, true);
  assert.equal(result.polls, 3);
  assert.ok(sleeps.length === 3);
});

test('createIssue: never fabricates a number from id when polling exhausts', async () => {
  const result = await createIssue({
    callables: {
      github__create_issue: async () => ({ id: 12345, title: 'NoNumber', body: 'y', state: 'open' }),
      // list never yields a numbered issue (index lag persists)
      github__list_issues: async () => [],
    },
    sleep: async () => {},
    owner: 'acme', repo: 'repo', title: 'NoNumber', body: 'y', maxPolls: 3,
  });
  assert.equal(result.ok, true);
  assert.equal(result.issue.number, null, 'internal id must not become number');
  assert.equal(result.issue.id, '12345');
  assert.equal(result.numberMissing, true);
  assert.equal(result.polls, 3);
});

test('createIssue: supports upstream naming differences (issues_create / issue_write)', async () => {
  const a = await createIssue({
    callables: { github__issues_create: async () => ({ number: 7, html_url: 'https://x/issues/7', title: 'T', state: 'open' }) },
    owner: 'o', repo: 'r', title: 'T',
  });
  assert.equal(a.issue.number, 7);
  let action;
  const b = await createIssue({
    callables: { github__issue_write: async (args) => { action = args.action; return { number: 8, html_url: 'https://x/issues/8', title: 'T2', state: 'open' }; } },
    owner: 'o', repo: 'r', title: 'T2',
  });
  assert.equal(b.issue.number, 8);
  assert.equal(action, 'create', 'issue_write requires action:"create"');
});

test('createIssue: no create tool returns UNSUPPORTED_UPSTREAM_TOOL, never fake success', async () => {
  const out = await createIssue({ callables: {}, owner: 'o', repo: 'r', title: 'X' });
  assert.equal(out.ok, false);
  assert.equal(out.code, UNSUPPORTED_UPSTREAM_TOOL);
  assert.equal(out.created, false);
});

test('createIssue: failed dedupe pre-check fails closed instead of creating blindly', async () => {
  let created = false;
  const out = await createIssue({
    callables: {
      github__list_issues: async () => { throw new Error('index down'); },
      github__create_issue: async () => { created = true; return { number: 3 }; },
    },
    owner: 'o', repo: 'r', title: 'X',
  });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'DEDUPE_PRECHECK_FAILED');
  assert.equal(created, false);
});

test('canonicalIssue: id / node_id are never a number fallback', () => {
  const c = canonicalIssue({ id: 555, node_id: 'n1', title: 'T' });
  assert.equal(c.number, null);
  assert.equal(c.id, '555');
  assert.equal(c.rawUntrusted, 'untrusted-upstream-envelope');
});

// ---------------------------------------------------------------------------
// OF-2 · canonical PR / Issue normalization on ALL paths
// ---------------------------------------------------------------------------

test('normalizePrResult: URL wins over id and explicit number', () => {
  const pr = normalizePrResult({
    id: 9876543210, number: 3,
    html_url: 'https://github.com/o/r/pull/53',
    title: 'Fix', state: 'open',
  });
  assert.equal(pr.number, 53);
  assert.equal(pr.id, '9876543210');
});

test('normalizePrResult: nested result envelope still resolves URL-first', () => {
  const pr = normalizePrResult({ result: { id: 99, url: 'https://github.com/o/r/pulls/77' } });
  assert.equal(pr.number, 77);
  assert.equal(pr.id, '99');
});

test('normalizeIssueResult and canonicalIssueResult agree on all paths', () => {
  const payload = { id: 42, html_url: 'https://github.com/o/r/issues/99', title: 'Bug', state: 'closed' };
  const a = normalizeIssueResult(payload);
  const b = canonicalIssueResult(payload);
  for (const key of ['number', 'id', 'url', 'state', 'title']) {
    assert.deepEqual(a[key], b[key], `field ${key} must agree across paths`);
  }
  assert.equal(a.number, 99);
  assert.equal(a.id, '42');
});

test('normalizeIssueResult: JSON text and list-item shapes also URL-first', () => {
  const a = normalizeIssueResult('{"id":1,"html_url":"https://github.com/o/r/issues/12","title":"J"}');
  assert.equal(a.number, 12);
  const b = normalizeIssueResult({ items: [{ id: 2, url: 'https://github.com/o/r/issues/13' }] });
  assert.equal(b.number, 13);
});

// ---------------------------------------------------------------------------
// OF-3 · unified batch unwrapping
// ---------------------------------------------------------------------------

test('unwrapBatch (host): bare value, {ok,value}, JSON string, nested array', () => {
  assert.deepEqual(unwrapBatch(5), [{ ok: true, value: 5 }]);
  assert.deepEqual(unwrapBatch({ ok: false, value: 'boom' }), [{ ok: false, value: 'boom' }]);
  assert.deepEqual(unwrapBatch('[{"ok":true,"value":1},2]'), [
    { ok: true, value: 1 }, { ok: true, value: 2 },
  ]);
  assert.deepEqual(unwrapBatch([[1, 2], [3]]), [
    { ok: true, value: 1 }, { ok: true, value: 2 }, { ok: true, value: 3 },
  ]);
  assert.deepEqual(unwrapBatch({ result: { answer: 42 } }), [{ ok: true, value: { answer: 42 } }]);
});

test('codemode.unwrapBatch (guest) matches host for the same shapes', async () => {
  const out = await runInSandbox({
    code: `async () => JSON.stringify({
      bare: codemode.unwrapBatch(5),
      slot: codemode.unwrapBatch({ ok:false, value:'boom' }),
      json: codemode.unwrapBatch('[{"ok":true,"value":1},2]'),
      nested: codemode.unwrapBatch([[1,2],[3]]),
      envelope: codemode.unwrapBatch({ result: { answer: 42 } }),
    })`,
    tools: [], callTool: async () => ({}),
  });
  assert.ok(!out.isError, out.result);
  const got = JSON.parse(out.result);
  assert.deepEqual(got.bare, unwrapBatch(5));
  assert.deepEqual(got.slot, unwrapBatch({ ok: false, value: 'boom' }));
  assert.deepEqual(got.json, unwrapBatch('[{"ok":true,"value":1},2]'));
  assert.deepEqual(got.nested, unwrapBatch([[1, 2], [3]]));
  assert.deepEqual(got.envelope, unwrapBatch({ result: { answer: 42 } }));
});

// ---------------------------------------------------------------------------
// OF-5 · rerunFailedJobs (no silent fake success) + waitForPrChecks exposed
// ---------------------------------------------------------------------------

test('rerunFailedJobs: calls injected tool when present', async () => {
  let received;
  const out = await rerunFailedJobs({
    callables: { github__rerun_failed_jobs: async (args) => { received = args; return { id: 1 }; } },
    owner: 'o', repo: 'r', runId: 123,
  });
  assert.equal(out.ok, true);
  assert.equal(out.rerun, true);
  assert.equal(out.tool, 'github__rerun_failed_jobs');
  assert.equal(received.run_id, 123);
});

test('rerunFailedJobs: absent tool returns UNSUPPORTED_UPSTREAM_TOOL (never ok:true)', async () => {
  const out = await rerunFailedJobs({ callables: {}, owner: 'o', repo: 'r', runId: 1 });
  assert.equal(out.ok, false);
  assert.equal(out.code, UNSUPPORTED_UPSTREAM_TOOL);
  assert.equal(out.rerun, false);
  assert.match(out.error, /no upstream rerun tool/);
});

test('waitForPrChecks is exposed in codemode guidance and registry', () => {
  const [searchTool, readTool, execTool] = createCodeModeTools({
    upstreamManager: { getEntries: () => [], callTool: async () => ({}) },
  });
  assert.equal(searchTool.name, 'search');
  assert.equal(readTool.name, 'execute_read');
  assert.equal(execTool.name, 'execute');
  assert.match(execTool.description, /waitForPrChecks/);
  assert.match(execTool.description, /createIssue/);
  assert.match(execTool.description, /rerunFailedJobs/);
  assert.match(execTool.description, /deleteFiles/);
  assert.match(execTool.description, /renameFiles/);
  assert.match(execTool.description, /unwrapBatch/);
  assert.match(readTool.description, /waitForPrChecks/);
});

// ---------------------------------------------------------------------------
// OF-9 · merge with optional branch deletion (opt-in, explicit)
// ---------------------------------------------------------------------------

test('mergePrWithOptionalBranchDelete: no deletion by default', async () => {
  let deleted = false;
  const out = await mergePrWithOptionalBranchDelete({
    merge: async () => ({ number: 5 }),
    deleteBranchTool: async () => { deleted = true; },
    owner: 'o', repo: 'r', pullNumber: 5, head: 'feature/a',
  });
  assert.equal(out.ok, true);
  assert.equal(out.branchDeleted, false);
  assert.equal(deleted, false);
});

test('mergePrWithOptionalBranchDelete: explicit deleteBranch:true deletes source', async () => {
  let deletedArgs;
  const out = await mergePrWithOptionalBranchDelete({
    merge: async () => ({ number: 5 }),
    deleteBranchTool: async (args) => { deletedArgs = args; },
    owner: 'o', repo: 'r', pullNumber: 5, head: 'feature/a',
    deleteBranch: true,
  });
  assert.equal(out.branchDeleted, true);
  assert.equal(deletedArgs.name, 'feature/a');
});

test('mergePrWithOptionalBranchDelete: no delete callback reports unsupported', async () => {
  const out = await mergePrWithOptionalBranchDelete({
    merge: async () => ({ number: 5 }),
    owner: 'o', repo: 'r', pullNumber: 5, head: 'feature/a',
    deleteBranch: true,
  });
  assert.equal(out.branchDeleted, false);
  assert.equal(out.code, UNSUPPORTED_UPSTREAM_TOOL);
  assert.match(out.deleteError, /deleteBranchTool/);
});

// ---------------------------------------------------------------------------
// OF-8 · deleteFiles / renameFiles are honestly two-phase, not atomic
// ---------------------------------------------------------------------------

test('deleteFiles: per-file fallback reports atomic:false and partial', async () => {
  const deleted = [];
  const out = await deleteFiles({
    deleteFile: async ({ path }) => { deleted.push(path); },
    owner: 'o', repo: 'r', branch: 'main', paths: ['a.txt', 'b.txt'],
  });
  assert.deepEqual(deleted, ['a.txt', 'b.txt']);
  assert.equal(out.atomic, false);
  assert.equal(out.ok, true);
  assert.equal(out.failed.length, 0);
  assert.match(out.reason, /push_files.*no.*delete|delete.*separate/i);
});

test('deleteFiles: partial failure is surfaced, never hidden', async () => {
  const out = await deleteFiles({
    deleteFile: async ({ path }) => { if (path === 'bad.txt') throw new Error('404'); },
    owner: 'o', repo: 'r', branch: 'main', paths: ['ok.txt', 'bad.txt'],
  });
  assert.equal(out.ok, false);
  assert.equal(out.partial, true);
  assert.deepEqual(out.remaining, ['bad.txt']);
  assert.match(out.failed[0].error, /404/);
});

test('deleteFiles: injected gitData callback may be atomic', async () => {
  const out = await deleteFiles({
    gitData: async (args) => ({ sha: 'commit' }),
    owner: 'o', repo: 'r', branch: 'main', paths: ['a.txt'],
  });
  assert.equal(out.atomic, true);
  assert.equal(out.partial, false);
  assert.deepEqual(out.deleted, ['a.txt']);
});

test('renameFiles: two-phase write+delete reports atomic:false, commitsRequired:2', async () => {
  const calls = [];
  const out = await renameFiles({
    readFile: async () => ({ content: 'hello' }),
    writeFile: async (a) => { calls.push(['write', a.path]); },
    deleteFile: async (a) => { calls.push(['delete', a.path]); },
    owner: 'o', repo: 'r', branch: 'main', renames: [{ from: 'old.txt', to: 'new.txt' }],
  });
  assert.deepEqual(calls, [['write', 'new.txt'], ['delete', 'old.txt']]);
  assert.equal(out.atomic, false);
  assert.equal(out.partial, true);
  assert.equal(out.commitsRequired, 2);
  assert.deepEqual(out.renamed, [{ from: 'old.txt', to: 'new.txt' }]);
});

test('renameFiles: injected gitData callback may be atomic', async () => {
  const out = await renameFiles({
    gitData: async () => ({ sha: 'commit' }),
    owner: 'o', repo: 'r', branch: 'main', renames: [{ from: 'a', to: 'b' }],
  });
  assert.equal(out.atomic, true);
  assert.equal(out.partial, false);
});

// ---------------------------------------------------------------------------
// Sandbox bridge smoke: new helpers are callable and return honest shapes
// ---------------------------------------------------------------------------

test('sandbox: codemode.rerunFailedJobs returns UNSUPPORTED_UPSTREAM_TOOL when no tool mounted', async () => {
  const out = await runInSandbox({
    code: `async () => codemode.rerunFailedJobs({owner:'o',repo:'r',runId:1})`,
    tools: [], callTool: async () => ({}),
  });
  assert.ok(!out.isError, out.result);
  const value = JSON.parse(out.result);
  assert.equal(value.code, UNSUPPORTED_UPSTREAM_TOOL);
  assert.equal(value.ok, false);
});

test('sandbox: codemode.createIssue returns unsupported with no issue tool mounted', async () => {
  const out = await runInSandbox({
    code: `async () => codemode.createIssue({owner:'o',repo:'r',title:'X'})`,
    tools: [], callTool: async () => ({}),
  });
  assert.ok(!out.isError, out.result);
  const value = JSON.parse(out.result);
  assert.equal(value.code, UNSUPPORTED_UPSTREAM_TOOL);
  assert.equal(value.created, false);
});
