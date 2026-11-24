import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureBranch, upsertPr, fetchAllPages, repoGrep, waitForPrChecks, canonicalResult } from '../src/github-helpers.js';

// ---------- ensureBranch ----------

test('ensureBranch: reuse returns existing branch, no create/delete', async () => {
  const existing = { name: 'feature/x', sha: 'abc' };
  let created = 0;
  let deleted = 0;
  const out = await ensureBranch({
    listBranches: async () => [existing],
    createBranch: async () => { created += 1; return { name: 'feature/x' }; },
    deleteBranch: async () => { deleted += 1; },
    name: 'feature/x',
    fromSha: 'base',
  });
  assert.deepEqual(out, { created: false, reused: true, reset: false, branch: existing });
  assert.equal(created, 0);
  assert.equal(deleted, 0);
});

test('ensureBranch: missing branch is created from fromSha', async () => {
  const calls = [];
  const out = await ensureBranch({
    listBranches: async () => ({ items: [{ name: 'main' }] }),
    createBranch: async (args) => { calls.push(args); return { name: args.name, sha: args.fromSha }; },
    name: 'feature/y',
    fromSha: 'deadbeef',
  });
  assert.deepEqual(calls, [{ name: 'feature/y', fromSha: 'deadbeef' }]);
  assert.equal(out.created, true);
  assert.equal(out.reused, false);
  assert.equal(out.reset, false);
  assert.equal(out.branch.sha, 'deadbeef');
});

test('ensureBranch: reset deletes then recreates from new sha', async () => {
  const calls = [];
  const out = await ensureBranch({
    listBranches: async () => [{ name: 'feature/z', sha: 'old' }],
    createBranch: async (args) => { calls.push(['create', args]); return { name: args.name, sha: args.fromSha }; },
    deleteBranch: async (args) => { calls.push(['delete', args]); },
    name: 'feature/z',
    fromSha: 'new-sha',
    ifExists: 'reset',
  });
  assert.equal(out.reset, true);
  assert.equal(out.created, true);
  assert.equal(out.branch.sha, 'new-sha');
  assert.deepEqual(calls, [
    ['delete', { name: 'feature/z', branch: { name: 'feature/z', sha: 'old' } }],
    ['create', { name: 'feature/z', fromSha: 'new-sha' }],
  ]);
});

test('ensureBranch: reset without deleteBranch throws explicit unsupported', async () => {
  await assert.rejects(
    ensureBranch({
      listBranches: async () => [{ name: 'b' }],
      createBranch: async () => ({}),
      name: 'b',
      fromSha: 's',
      ifExists: 'reset',
    }),
    /reset.*requires a deleteBranch callback.*unsupported/,
  );
});

test('ensureBranch: callback errors are not swallowed', async () => {
  await assert.rejects(
    ensureBranch({
      listBranches: async () => { throw new Error('list failed'); },
      createBranch: async () => ({}),
      name: 'b', fromSha: 's',
    }),
    /list failed/,
  );
  await assert.rejects(
    ensureBranch({ listBranches: async () => [], name: 'b', fromSha: 's' }),
    /createBranch must be a function/,
  );
  await assert.rejects(
    ensureBranch({
      listBranches: async () => [],
      createBranch: async () => { throw new Error('create failed'); },
      name: 'b', fromSha: 's',
    }),
    /create failed/,
  );
});

// ---------- upsertPr ----------

test('upsertPr: creates when no matching open PR', async () => {
  const args = [];
  const out = await upsertPr({
    listPrs: async () => [
      { number: 1, head: { ref: 'other' }, base: { ref: 'main' }, state: 'open' },
      { number: 2, head: { ref: 'feature/a' }, base: { ref: 'main' }, state: 'closed' },
    ],
    createPr: async (a) => { args.push(a); return { number: 3, ...a }; },
    head: 'feature/a', base: 'main', title: 'Title', body: 'Body',
  });
  assert.equal(out.created, true);
  assert.equal(out.updated, false);
  assert.equal(out.reused, false);
  assert.equal(out.pr.number, 3);
  assert.deepEqual(args, [{ head: 'feature/a', base: 'main', title: 'Title', body: 'Body' }]);
});

test('upsertPr: updates matching open PR when updatePr provided', async () => {
  const existing = { number: 9, head: { ref: 'feature/a' }, base: { ref: 'main' }, state: 'open' };
  const calls = [];
  const out = await upsertPr({
    listPrs: async () => ({ data: [existing] }),
    createPr: async () => { throw new Error('should not create'); },
    updatePr: async (a) => { calls.push(a); return { ...existing, title: 'New' }; },
    head: 'feature/a', base: 'main', title: 'New', body: 'New body',
  });
  assert.equal(out.updated, true);
  assert.equal(out.created, false);
  assert.equal(out.pr.title, 'New');
  assert.equal(calls[0].number, 9);
  assert.equal(calls[0].title, 'New');
});

test('upsertPr: reuses matching open PR when no updatePr provided', async () => {
  const existing = { number: 7, head: 'feature/a', base: 'main', state: 'open' };
  const out = await upsertPr({
    listPrs: async () => [existing],
    createPr: async () => { throw new Error('should not create'); },
    head: 'feature/a', base: 'main', title: 'ignored',
  });
  assert.deepEqual(out, { created: false, updated: false, reused: true, pr: existing });
});

test('upsertPr: errors from callbacks propagate', async () => {
  await assert.rejects(
    upsertPr({
      listPrs: async () => { throw new Error('list boom'); },
      createPr: async () => ({}), head: 'h', base: 'b', title: 't',
    }),
    /list boom/,
  );
  await assert.rejects(
    upsertPr({
      listPrs: async () => [],
      createPr: async () => { throw new Error('create boom'); }, head: 'h', base: 'b', title: 't',
    }),
    /create boom/,
  );
});

// ---------- fetchAllPages ----------

test('fetchAllPages: follows nextCursor, de-duplicates, reports pages', async () => {
  const cursors = [];
  const out = await fetchAllPages({
    fetchPage: async (arg) => {
      cursors.push(arg.cursor);
      if (arg.cursor === undefined) return { items: [{ id: 1 }, { id: 2 }], nextCursor: 'c2' };
      if (arg.cursor === 'c2') return { items: [{ id: 2 }, { id: 3 }], next: 'c3' };
      return { data: [{ id: 4 }], next: null };
    },
  });
  assert.deepEqual(cursors, [undefined, 'c2', 'c3']);
  assert.deepEqual(out.items, [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]);
  assert.equal(out.pages, 3);
  assert.equal(out.truncated, false);
  assert.equal(out.nextCursor, null);
});

test('fetchAllPages: stops on empty page', async () => {
  let calls = 0;
  const out = await fetchAllPages({
    fetchPage: async () => { calls += 1; return calls === 1 ? { items: [{ id: 1 }], nextCursor: 'x' } : { items: [] }; },
  });
  assert.equal(calls, 2);
  assert.deepEqual(out.items, [{ id: 1 }]);
  assert.equal(out.truncated, false);
});

test('fetchAllPages: maxPages sets truncated true', async () => {
  let calls = 0;
  const out = await fetchAllPages({
    maxPages: 3,
    cursorKey: 'after',
    fetchPage: async (arg) => {
      calls += 1;
      return { items: [{ n: calls }], next: `c${calls}` };
    },
  });
  assert.equal(out.pages, 3);
  assert.equal(calls, 3);
  assert.deepEqual(out.items, [{ n: 1 }, { n: 2 }, { n: 3 }]);
  assert.equal(out.truncated, true);
  assert.equal(out.nextCursor, 'c3');
});

test('fetchAllPages: non-advancing cursor and errors', async () => {
  const stalled = await fetchAllPages({
    fetchPage: async () => ({ items: [{ id: 1 }], nextCursor: 'same' }),
  });
  assert.equal(stalled.pages, 2); // one repeat needed to detect non-advancing cursor
  assert.equal(stalled.truncated, false);
  await assert.rejects(
    fetchAllPages({ fetchPage: async () => { throw new Error('page boom'); } }),
    /page boom/,
  );
  await assert.rejects(fetchAllPages({}), /fetchPage must be a function/);
});

// ---------- repoGrep ----------

test('repoGrep: finds matches with file/line/column/text', async () => {
  const files = {
    'a.js': 'const alpha = 1;\nconst BETA = 2;\n',
    'b.js': 'alpha beta alpha\n',
  };
  const out = await repoGrep({
    listFiles: async () => ({ items: Object.keys(files) }),
    readFile: async (f) => files[f],
    pattern: 'alpha',
  });
  assert.equal(out.errors.length, 0);
  assert.deepEqual(out.matches.map((m) => [m.file, m.line, m.column]), [
    ['a.js', 1, 7],
    ['b.js', 1, 1],
    ['b.js', 1, 12],
  ]);
  assert.equal(out.matches[0].text, 'const alpha = 1;');
  assert.equal(out.scanned, 2);
  assert.equal(out.truncated, false);
});

test('repoGrep: skips unreadable file and records errors', async () => {
  const out = await repoGrep({
    listFiles: async () => ['ok.txt', 'bad.txt'],
    readFile: async (f) => {
      if (f === 'bad.txt') throw new Error('EACCES');
      return 'needle here';
    },
    pattern: /needle/,
  });
  assert.equal(out.matches.length, 1);
  assert.deepEqual(out.errors, [{ file: 'bad.txt', error: 'EACCES' }]);
  assert.equal(out.scanned, 1);
});

test('repoGrep: limit N and custom flags', async () => {
  const out = await repoGrep({
    listFiles: async () => ['x.txt'],
    readFile: async () => 'TODO TODO TODO TODO',
    pattern: 'todo',
    flags: 'gi',
    limit: 2,
  });
  assert.equal(out.matches.length, 2);
  assert.equal(out.truncated, true);
  assert.deepEqual(out.matches.map((m) => m.column), [1, 6]);
});

test('repoGrep: handles text/content object shapes and validates input', async () => {
  const out = await repoGrep({
    listFiles: async () => ['p.md'],
    readFile: async () => ({ content: 'found me' }),
    pattern: 'found',
    flags: '',
  });
  assert.equal(out.matches.length, 1);
  assert.equal(out.matches[0].column, 1);
  await assert.rejects(repoGrep({ listFiles: async () => [], readFile: async () => '' }), /pattern is required/);
});

// ---------- waitForPrChecks: top-level status/conclusion aggregation ----------
//
// M2 contract fix: GitHub's `pull_request_read` (`method:"get_check_runs"`)
// returns ONLY {total_count, check_runs[]} — no top-level status/conclusion.
// Before the fix a fully settled snapshot came back as
// status:"in_progress" / conclusion:null, so callers could not tell success
// from failure in one call. Every fixture here is a fixed local object.

function waitOptions(check, extra = {}) {
  return { owner: 'o', repo: 'r', pullNumber: 53, timeoutMs: 500, maxPolls: 4, pollIntervalMs: 1, check, ...extra };
}

test('waitForPrChecks: check_runs-only snapshot aggregates completed + success (no fake in_progress)', async () => {
  const out = await waitForPrChecks(waitOptions(async () => ({
    total_count: 2,
    check_runs: [
      { name: 'ci', status: 'completed', conclusion: 'success' },
      { name: 'lint', status: 'completed', conclusion: 'skipped' },
    ],
  })));
  assert.equal(out.ok, true);
  assert.equal(out.status, 'completed', 'settled runs must not report the in_progress placeholder');
  assert.equal(out.conclusion, 'success');
  assert.equal(out.timedOut, false);
  assert.equal(out.polls, 1);
  assert.equal(out.checkRuns.length, 2);
});

test('waitForPrChecks: conclusion precedence is failure > cancelled > success', async () => {
  const cases = [
    { name: 'failure', runs: [{ status: 'completed', conclusion: 'failure' }, { status: 'completed', conclusion: 'success' }], expected: 'failure' },
    { name: 'timed_out', runs: [{ status: 'completed', conclusion: 'timed_out' }], expected: 'failure' },
    { name: 'action_required', runs: [{ status: 'completed', conclusion: 'action_required' }], expected: 'failure' },
    { name: 'failure beats cancelled', runs: [{ status: 'completed', conclusion: 'cancelled' }, { status: 'completed', conclusion: 'failure' }], expected: 'failure' },
    { name: 'cancelled', runs: [{ status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion: 'cancelled' }], expected: 'cancelled' },
    { name: 'neutral/skipped', runs: [{ status: 'completed', conclusion: 'neutral' }, { status: 'completed', conclusion: 'skipped' }], expected: 'success' },
  ];
  for (const item of cases) {
    const out = await waitForPrChecks(waitOptions(async () => ({ check_runs: item.runs })));
    assert.equal(out.ok, true, item.name);
    assert.equal(out.status, 'completed', item.name);
    assert.equal(out.conclusion, item.expected, `${item.name}: wrong aggregate conclusion`);
  }
});

test('waitForPrChecks: an unsettled run still times out honestly (no invented conclusion)', async () => {
  const out = await waitForPrChecks(waitOptions(async () => ({
    check_runs: [
      { name: 'ci', status: 'completed', conclusion: 'success' },
      { name: 'lint', status: 'in_progress' },
    ],
  }), { maxPolls: 2 }));
  assert.equal(out.ok, false);
  assert.equal(out.timedOut, true);
  assert.equal(out.polls, 2);
  assert.equal(out.status, 'in_progress');
  assert.equal(out.conclusion, null, 'partial data must never be aggregated into a conclusion');
});

test('waitForPrChecks: a completed run without a conclusion is never guessed as success', async () => {
  const out = await waitForPrChecks(waitOptions(async () => ({
    check_runs: [{ name: 'ci', status: 'completed' }],
  })));
  assert.equal(out.ok, true);
  assert.equal(out.status, 'completed');
  assert.equal(out.conclusion, null, 'unknown verdict stays null');
});

test('waitForPrChecks: an unknown conclusion vocabulary is never reported as success', async () => {
  const out = await waitForPrChecks(waitOptions(async () => ({
    check_runs: [{ name: 'ci', status: 'completed', conclusion: 'stale' }],
  })));
  assert.equal(out.ok, true);
  assert.equal(out.status, 'completed');
  assert.equal(out.conclusion, null, 'only success/skipped/neutral aggregate to success');
});

test('waitForPrChecks: explicit upstream status/conclusion still wins (behaviour preserved)', async () => {
  const out = await waitForPrChecks(waitOptions(async () => ({
    status: 'completed',
    conclusion: 'neutral',
    check_runs: [{ status: 'completed', conclusion: 'failure' }],
  })));
  assert.equal(out.status, 'completed');
  assert.equal(out.conclusion, 'neutral', 'upstream-supplied conclusion is authoritative');
});

// ---------- canonicalResult: BC-011 merge context fill ----------

test('canonicalResult: merge context fills number/url when the response only has {sha,merged,message}', () => {
  const merge = canonicalResult({ sha: 'm1', merged: true, message: 'merged' },
    { owner: 'o', repo: 'r', pullNumber: 53 });
  assert.deepEqual([merge.number, merge.url, merge.sha],
    [53, 'https://github.com/o/r/pull/53', 'm1']);

  // A response URL still wins over the call context (URL-first contract).
  const withUrl = canonicalResult(
    { sha: 'm2', html_url: 'https://github.com/o/r/pull/9' },
    { owner: 'o', repo: 'r', pullNumber: 53 },
  );
  assert.deepEqual([withUrl.number, withUrl.url], [9, 'https://github.com/o/r/pull/9']);

  // A bare pull number fills `number` but not a URL (no owner/repo to build it).
  const bare = canonicalResult({ sha: 'm3', merged: true, message: 'ok' }, 53);
  assert.deepEqual([bare.number, bare.url], [53, null]);

  // A context URL is used for both fields.
  const ctxUrl = canonicalResult({ sha: 'm4' }, { url: 'https://github.com/o/r/pull/7' });
  assert.deepEqual([ctxUrl.number, ctxUrl.url], [7, 'https://github.com/o/r/pull/7']);
});

test('canonicalResult: internal id is never a number fallback, even with merge context', () => {
  assert.equal(
    canonicalResult({ id: 1000000001, sha: 'm', merged: true }).number,
    null,
    'id alone never becomes a PR number',
  );
  const withContext = canonicalResult(
    { id: 1000000001, sha: 'm', merged: true },
    { owner: 'o', repo: 'r', pullNumber: 53 },
  );
  assert.equal(withContext.number, 53, 'number comes from the explicit call context');
  assert.equal(withContext.id, '1000000001', 'id stays a separate field');
  assert.notEqual(withContext.number, Number(withContext.id));

  // A mismatched context must not fabricate a URL for a different number.
  const explicit = canonicalResult({ number: 9, sha: 'm' }, { owner: 'o', repo: 'r', pullNumber: 53 });
  assert.deepEqual([explicit.number, explicit.url], [9, null]);
});

test('canonicalResult: no context keeps the historical shape/behaviour', () => {
  const out = canonicalResult({ number: 12, html_url: 'https://github.com/o/r/pull/12', sha: 'h' });
  assert.deepEqual([out.number, out.url, out.sha], [12, 'https://github.com/o/r/pull/12', 'h']);
  assert.deepEqual(Object.keys(out).sort(), ['number', 'raw', 'sha', 'url']);
  assert.equal(canonicalResult(null).number, null);
});
