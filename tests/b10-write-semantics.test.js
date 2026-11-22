/**
 * B10 follow-up — Gemini PR #41–#48 incremental write suggestions.
 *
 * Covers, with fake tools / injected read-write callbacks only (no network,
 * no credentials, no real GitHub writes):
 *   1. create_branch_if_missing — branch existing/missing/reset opt-in.
 *   2. unified applyFilePatch/writeFiles — sha auto-fill, single vs multi,
 *      identical top-level {sha, commitSha, number?, url?} fields.
 *   3. canonical {number,url,sha} for PR / Issue / merge results.
 *   4. write-before precheck (JSON strict, JS/TS bracket balance) that blocks
 *      the write on failure.
 * Sandbox tests use the same fake-tool bridge as tests/b10-codemode.test.js.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createBranchIfMissing,
  create_branch_if_missing,
  canonicalResult,
  unwrapResultPayload,
} from '../src/github-helpers.js';
import {
  applyFilePatch,
  applyFilePatches,
  writeFiles,
  precheckText,
  normalizeWriteResult,
} from '../src/file-write.js';
import { runInSandbox } from '../src/codemode.js';

// ---------------------------------------------------------------------------
// Fake-tool helpers (sandbox)
// ---------------------------------------------------------------------------

function toolDesc(tool, { readOnly = false } = {}) {
  return {
    server: 'github',
    tool,
    name: `github__${tool}`,
    description: tool,
    inputSchema: { type: 'object', properties: {}, required: [] },
    annotations: { readOnlyHint: readOnly },
  };
}

const ALL_TOOLS = [
  ...['get_file_contents', 'list_branches', 'list_pull_requests', 'search_code', 'get_issue']
    .map((t) => toolDesc(t, { readOnly: true })),
  ...['create_or_update_file', 'create_branch', 'delete_branch', 'create_pull_request', 'update_pull_request']
    .map((t) => toolDesc(t)),
];

function textResult(value) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] };
}

async function evalCode(code, handlers = {}) {
  const calls = [];
  const callTool = async (server, tool, args) => {
    calls.push({ server, tool, args });
    const fn = handlers[`${server}::${tool}`];
    if (!fn) throw new Error(`unexpected tool call: ${server}::${tool}`);
    return fn(args);
  };
  const out = await runInSandbox({ code: `async () => { ${code} }`, tools: ALL_TOOLS, callTool });
  assert.ok(!out.isError, out.result);
  return { value: JSON.parse(out.result), calls };
}

// ---------------------------------------------------------------------------
// 1. create_branch_if_missing
// ---------------------------------------------------------------------------

test('createBranchIfMissing: existing branch is reused (no create/delete), snake alias works', async () => {
  const calls = [];
  const existing = { name: 'feature/x', sha: 'abc' };
  const out = await createBranchIfMissing({
    listBranches: async () => [existing],
    createBranch: async (a) => { calls.push(['create', a]); return { name: a.name }; },
    deleteBranch: async (a) => { calls.push(['delete', a]); },
    name: 'feature/x',
    base: 'main',
  });
  assert.equal(out.created, false);
  assert.equal(out.reused, true);
  assert.equal(out.reset, false);
  assert.equal(out.branch, existing);
  assert.deepEqual(calls, []);

  // snake_case alias is the same function and behaves identically.
  assert.equal(create_branch_if_missing, createBranchIfMissing);
});

test('createBranchIfMissing: missing branch is created from base', async () => {
  const calls = [];
  const out = await createBranchIfMissing({
    listBranches: async () => ({ items: [{ name: 'main' }] }),
    createBranch: async (a) => { calls.push(a); return { name: a.name, fromSha: a.fromSha }; },
    name: 'feature/new',
    base: 'main',
  });
  assert.equal(out.created, true);
  assert.equal(out.reused, false);
  assert.deepEqual(calls, [{ name: 'feature/new', fromSha: 'main' }]);
  assert.equal(out.branch.fromSha, 'main');
});

test('createBranchIfMissing: reset is an explicit opt-in and needs deleteBranch', async () => {
  const calls = [];
  const out = await createBranchIfMissing({
    listBranches: async () => [{ name: 'feature/z', sha: 'old' }],
    createBranch: async (a) => { calls.push(['create', a]); return { name: a.name, fromSha: a.fromSha }; },
    deleteBranch: async (a) => { calls.push(['delete', a]); },
    name: 'feature/z',
    base: 'new-sha',
    ifExists: 'reset',
  });
  assert.equal(out.reset, true);
  assert.equal(out.created, true);
  assert.deepEqual(calls.map((c) => c[0]), ['delete', 'create']);
  assert.equal(out.branch.fromSha, 'new-sha');

  await assert.rejects(
    createBranchIfMissing({
      listBranches: async () => [{ name: 'b' }],
      createBranch: async () => ({}),
      name: 'b',
      base: 'main',
      ifExists: 'reset',
    }),
    /deleteBranch callback.*unsupported/,
  );
});

test('sandbox createBranchIfMissing: reuses existing, creates from base, reset opt-in', async () => {
  const reused = await evalCode(`
    return await codemode.createBranchIfMissing({ owner: 'o', repo: 'r', name: 'b', base: 'main' });
  `, {
    'github::list_branches': () => textResult([{ name: 'main' }, { name: 'b' }]),
    'github::create_branch': () => { throw new Error('must not create'); },
  });
  assert.equal(reused.value.reused, true);
  assert.equal(reused.value.created, false);
  assert.deepEqual(reused.calls.map((c) => c.tool), ['list_branches']);

  const created = await evalCode(`
    return await codemode.create_branch_if_missing({ owner: 'o', repo: 'r', name: 'new', base: 'main' });
  `, {
    'github::list_branches': () => textResult([{ name: 'main' }]),
    'github::create_branch': (args) => ({ name: args.branch, from: args.from_branch }),
  });
  assert.equal(created.value.created, true);
  assert.equal(created.calls[1].args.from_branch, 'main');

  const resetCalls = [];
  const reset = await evalCode(`
    return await codemode.createBranchIfMissing({ owner:'o', repo:'r', name:'b', base:'main', ifExists:'reset' });
  `, {
    'github::list_branches': () => textResult([{ name: 'b' }]),
    'github::delete_branch': () => { resetCalls.push('delete'); return textResult({}); },
    'github::create_branch': (args) => { resetCalls.push(args.from_branch); return { name: args.branch }; },
  });
  assert.equal(reset.value.reset, true);
  assert.equal(reset.value.created, true);
  assert.deepEqual(resetCalls, ['delete', 'main'], 'reset deletes then recreates from base');
});

// ---------------------------------------------------------------------------
// 2. Unified applyFilePatch / writeFiles — sha auto-fill, single vs multi
// ---------------------------------------------------------------------------

function ioFake(files, writeImpl) {
  const calls = { read: [], write: [] };
  const read = async (path) => {
    calls.read.push(path);
    if (!(path in files)) throw new Error(`not found: ${path}`);
    return files[path].content;
  };
  const write = async (path, text, meta) => {
    calls.write.push({ path, text, meta });
    return writeImpl ? writeImpl(path, text, meta) : undefined;
  };
  const getSha = async (path) => files[path]?.sha;
  return { read, write, getSha, calls };
}

test('host applyFilePatches: single file auto-fills sha from getSha and returns unified top-level fields', async () => {
  const io = ioFake(
    { 'a.json': { content: '{"a":1}\n', sha: 'blob-a' } },
    () => ({ commitSha: 'commit-1', sha: 'new-blob-a' }),
  );
  const out = await applyFilePatches({
    ...io,
    patches: [{ path: 'a.json', patch: '@@ -1,1 +1,1 @@\n-{"a":1}\n+{"a":2}\n' }],
    dryRun: false,
  });
  assert.equal(out.ok, true, out.error);
  assert.equal(out.files.length, 1);
  assert.equal(out.files[0].sha, 'blob-a', 'sha auto-filled via getSha');
  assert.equal(io.calls.write[0].meta.sha, 'blob-a', 'resolved sha passed to write');
  assert.equal(io.calls.write[0].text, '{"a":2}\n');
  assert.equal(out.commitSha, 'commit-1');
  assert.equal(out.sha, 'new-blob-a');
  assert.ok('number' in out === false, 'number is optional when upstream did not return one');
  assert.ok('url' in out === false, 'url is optional when upstream did not return one');
});

test('host writeFiles alias: multiple files use the same logic and return unified fields', async () => {
  const io = ioFake({
    'a.json': { content: '{"a":1}\n', sha: 'blob-a' },
    'b.json': { content: '{"b":1}\n', sha: 'blob-b' },
  }, (path) => ({ commitSha: `commit-${path}`, sha: `new-${path}` }));
  const out = await writeFiles({
    ...io,
    patches: [
      { path: 'a.json', patch: '@@ -1,1 +1,1 @@\n-{"a":1}\n+{"a":2}\n' },
      { path: 'b.json', patch: '@@ -1,1 +1,1 @@\n-{"b":1}\n+{"b":2}\n' },
    ],
    dryRun: false,
  });
  assert.equal(out.ok, true, out.error);
  assert.equal(io.calls.write.length, 2);
  assert.deepEqual(out.files.map((f) => [f.path, f.sha]), [
    ['a.json', 'blob-a'], ['b.json', 'blob-b'],
  ]);
  assert.equal(out.commitSha, 'commit-b.json');
  assert.equal(out.sha, 'new-b.json');
  assert.equal(Array.isArray(out.diff), true, 'multi-file diff is an array');
});

test('host applyFilePatches: an explicit per-file sha wins over getSha', async () => {
  const io = ioFake({ 'a.txt': { content: 'a\nb\n', sha: 'auto' } }, () => ({ commitSha: 'c' }));
  const out = await applyFilePatches({
    ...io,
    patches: [{ path: 'a.txt', patch: '@@ -2,1 +2,1 @@\n-b\n+B\n', sha: 'explicit' }],
    dryRun: false,
  });
  assert.equal(out.ok, true, out.error);
  assert.equal(io.calls.write[0].meta.sha, 'explicit');
  assert.equal(io.calls.read.length, 1, 'no extra sha lookup when sha was supplied');
});

test('sandbox applyFilePatch/writeFiles: single and multi return the same top-level field set', async () => {
  const files = {
    'a.json': textResult({ content: '{"a":1}\n', sha: 'blob-a' }),
    'b.json': textResult({ content: '{"b":1}\n', sha: 'blob-b' }),
  };
  const handlers = {
    'github::get_file_contents': (args) => files[args.path],
    'github::create_or_update_file': (args) => textResult({ commitSha: `commit-${args.path}`, sha: `new-${args.path}` }),
  };
  const single = await evalCode(`
    return await codemode.applyFilePatch({
      owner: 'o', repo: 'r', path: 'a.json', branch: 'feature/x',
      patch: '@@ -1,1 +1,1 @@\\n-{"a":1}\\n+{"a":2}\\n', dryRun: false,
    });
  `, handlers);
  assert.equal(single.value.ok, true, single.value.error);
  assert.deepEqual(Object.keys(single.value).sort(), ['commitSha', 'diff', 'files', 'ok', 'sha']);
  assert.equal(single.value.files[0].sha, 'blob-a', 'sha auto-filled from read result');
  assert.equal(single.calls.find((c) => c.tool === 'create_or_update_file').args.sha, 'blob-a');
  assert.equal(single.value.commitSha, 'commit-a.json');
  assert.equal(single.value.sha, 'new-a.json');

  const multi = await evalCode(`
    return await codemode.writeFiles({
      owner: 'o', repo: 'r', branch: 'feature/x', dryRun: false,
      patches: [
        { path: 'a.json', patch: '@@ -1,1 +1,1 @@\\n-{"a":1}\\n+{"a":2}\\n' },
        { path: 'b.json', patch: '@@ -1,1 +1,1 @@\\n-{"b":1}\\n+{"b":2}\\n' },
      ],
    });
  `, handlers);
  assert.equal(multi.value.ok, true, multi.value.error);
  assert.deepEqual(Object.keys(multi.value).sort(), ['commitSha', 'diff', 'files', 'ok', 'sha']);
  assert.equal(multi.value.files.length, 2);
  assert.equal(multi.value.commitSha, 'commit-b.json');
  assert.equal(multi.value.sha, 'new-b.json');
  assert.equal(multi.calls.filter((c) => c.tool === 'create_or_update_file').length, 2);
});

test('sandbox unified write result exposes optional number/url when upstream returns them', async () => {
  const { value } = await evalCode(`
    return await codemode.applyFilePatch({
      owner: 'o', repo: 'r', path: 'a.txt', dryRun: false,
      patch: '@@ -1,1 +1,1 @@\\n-a\\n+A\\n',
    });
  `, {
    'github::get_file_contents': () => textResult({ content: 'a\n', sha: 'blob' }),
    'github::create_or_update_file': () => textResult({
      commitSha: 'c1', sha: 'new', number: 41, html_url: 'https://github.com/o/r/pull/41',
    }),
  });
  assert.equal(value.ok, true, value.error);
  assert.equal(value.number, 41);
  assert.equal(value.url, 'https://github.com/o/r/pull/41');
  assert.equal(value.sha, 'new');
  assert.equal(value.commitSha, 'c1');
});

// ---------------------------------------------------------------------------
// 3. Canonical {number,url,sha} for PR / Issue / merge results
// ---------------------------------------------------------------------------

test('canonicalResult: PR / Issue / merge / MCP text all yield {number,url,sha}', () => {
  const pr = canonicalResult({ number: 12, html_url: 'https://github.com/o/r/pull/12', sha: 'head-1' });
  assert.deepEqual([pr.number, pr.url, pr.sha], [12, 'https://github.com/o/r/pull/12', 'head-1']);

  const issue = canonicalResult({ issue_number: 7, url: 'https://github.com/o/r/issues/7', head_sha: 'h' });
  assert.deepEqual([issue.number, issue.url, issue.sha], [7, 'https://github.com/o/r/issues/7', 'h']);

  const merge = canonicalResult(textResult({ pullNumber: 9, html_url: 'https://github.com/o/r/pull/9', sha: 'm' }));
  assert.deepEqual([merge.number, merge.url, merge.sha], [9, 'https://github.com/o/r/pull/9', 'm']);

  const nested = canonicalResult({ result: { number: 5, url: 'u', commit: { sha: 'c' } } });
  assert.deepEqual([nested.number, nested.url, nested.sha], [5, 'u', 'c']);

  const fallback = canonicalResult({ url: 'https://github.com/o/r/pull/77' });
  assert.equal(fallback.number, 77, 'URL fallback only when no explicit number field');
  assert.equal(fallback.sha, null);
  assert.equal(canonicalResult(null).number, null, 'never throws');
  assert.ok('raw' in pr, 'raw preserved');
});

test('unwrapResultPayload handles JSON strings, {result}, and MCP text content', () => {
  assert.deepEqual(unwrapResultPayload('{"number":3}'), { number: 3 });
  assert.deepEqual(unwrapResultPayload({ result: { number: 4 } }), { number: 4 });
  assert.deepEqual(unwrapResultPayload(textResult({ number: 5 })), { number: 5 });
  assert.equal(unwrapResultPayload('plain text'), 'plain text');
});

test('sandbox canonicalize/normalizeMerge give top-level number/url/sha', async () => {
  const { value } = await evalCode(`
    return {
      pr: codemode.canonicalize({ number: 12, html_url: 'u12', head: { sha: 'h12' } }),
      issue: codemode.canonicalize({ issue_number: 7, url: 'u7' }),
      merge: codemode.normalizeMerge({ pullNumber: 9, html_url: 'u9', sha: 'm9' }),
    };
  `);
  assert.deepEqual(value.pr, { number: 12, url: 'u12', sha: 'h12', raw: { number: 12, html_url: 'u12', head: { sha: 'h12' } } });
  assert.equal(value.issue.number, 7);
  assert.equal(value.issue.url, 'u7');
  assert.equal(value.merge.number, 9);
  assert.equal(value.merge.url, 'u9');
  assert.equal(value.merge.sha, 'm9');
});

test('normalizeWriteResult always exposes sha/commitSha and optional number/url', () => {
  const base = normalizeWriteResult({ commitSha: 'c', sha: 'b' });
  assert.equal(base.sha, 'b');
  assert.equal(base.commitSha, 'c');
  assert.ok(!('number' in base));
  const full = normalizeWriteResult({ commit_sha: 'c2', sha: 'b2', number: 8, url: 'u' }, 'fallback');
  assert.deepEqual([full.sha, full.commitSha, full.number, full.url], ['b2', 'c2', 8, 'u']);
  const empty = normalizeWriteResult(undefined);
  assert.equal(empty.sha, null);
  assert.equal(empty.commitSha, null);
});

// ---------------------------------------------------------------------------
// 4. Write-before precheck — failure means no write
// ---------------------------------------------------------------------------

test('precheckText: JSON strict parse, JS/TS bracket+quote balance, other files skipped', () => {
  assert.equal(precheckText('{"a":1}', 'a.json').ok, true);
  assert.equal(precheckText('{"a":}', 'a.json').ok, false);
  assert.equal(precheckText('const f = (x) => x + 1;\n', 'a.ts').ok, true);
  assert.equal(precheckText('function f() { return "x";', 'a.js').ok, false);
  assert.equal(precheckText('const s = "unterminated', 'a.js').ok, false);
  assert.equal(precheckText('a ) b', 'a.js').ok, false);
  assert.equal(precheckText('// comment with ( unbalanced\n', 'a.js').ok, true);
  assert.equal(precheckText('not { code', 'a.md').ok, true);
});

test('host applyFilePatch: precheck failure never writes (JSON + JS)', async () => {
  const io = ioFake({ 'bad.json': { content: '{"a":1}\n', sha: 's' } }, () => ({ commitSha: 'should-not-happen' }));
  const out = await applyFilePatch({
    ...io,
    path: 'bad.json',
    patch: '@@ -1,1 +1,1 @@\n-{"a":1}\n+{"a":}\n',
    dryRun: false,
  });
  assert.equal(out.ok, false);
  assert.match(out.error, /JSON precheck failed/);
  assert.equal(out.precheck, 'json');
  assert.equal(io.calls.write.length, 0);

  const io2 = ioFake({ 'bad.ts': { content: 'const x = 1;\n', sha: 's' } }, () => ({ commitSha: 'no' }));
  const out2 = await applyFilePatch({
    ...io2,
    path: 'bad.ts',
    patch: '@@ -1,1 +1,1 @@\n-const x = 1;\n+function f() { return 1;\n',
    dryRun: false,
  });
  assert.equal(out2.ok, false);
  assert.match(out2.error, /bracket balance precheck failed/);
  assert.equal(io2.calls.write.length, 0);
});

test('host applyFilePatches: one file failing precheck blocks ALL writes', async () => {
  const io = ioFake({
    'ok.txt': { content: 'a\n', sha: 's1' },
    'bad.json': { content: '{"x":1}\n', sha: 's2' },
  }, () => ({ commitSha: 'no' }));
  const out = await applyFilePatches({
    ...io,
    patches: [
      { path: 'ok.txt', patch: '@@ -1,1 +1,1 @@\n-a\n+A\n' },
      { path: 'bad.json', patch: '@@ -1,1 +1,1 @@\n-{"x":1}\n+{"x":}\n' },
    ],
    dryRun: false,
  });
  assert.equal(out.ok, false);
  assert.match(out.error, /precheck failed/);
  assert.equal(io.calls.write.length, 0, 'no file is written when a batch member fails');
});

test('sandbox applyFilePatch: precheck failure returns error and never calls write tool', async () => {
  const { value, calls } = await evalCode(`
    return await codemode.applyFilePatch({
      owner: 'o', repo: 'r', path: 'bad.json', dryRun: false,
      patch: '@@ -1,1 +1,1 @@\\n-{"a":1}\\n+{"a":}\\n',
    });
  `, {
    'github::get_file_contents': () => textResult({ content: '{"a":1}\n', sha: 's' }),
    'github::create_or_update_file': () => { throw new Error('must not write'); },
  });
  assert.equal(value.ok, false);
  assert.match(value.error, /precheck failed/);
  assert.equal(value.precheck, 'json');
  assert.deepEqual(calls.map((c) => c.tool), ['get_file_contents']);
});

test('sandbox precheckText bridge agrees with the host implementation', async () => {
  const { value } = await evalCode(`
    return {
      ok: codemode.precheckText('{"a":1}', 'a.json'),
      bad: codemode.precheckText('function f() {', 'a.js'),
    };
  `);
  assert.equal(value.ok.ok, true);
  assert.equal(value.ok.check, 'json');
  assert.equal(value.bad.ok, false);
  assert.equal(value.bad.check, 'balance');
});

test('new helpers are hidden (no constructor leak) and MCP schemas stay unchanged', async () => {
  const { value } = await evalCode(`
    return [
      'applyFilePatch', 'writeFiles', 'createBranchIfMissing', 'canonicalize',
      'normalizeMerge', 'precheckText',
    ].every((k) => typeof codemode[k] === 'function' && codemode[k].constructor === undefined);
  `);
  assert.equal(value, true);
});
