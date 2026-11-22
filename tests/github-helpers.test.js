import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureBranch, upsertPr, fetchAllPages, repoGrep } from '../src/github-helpers.js';

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
