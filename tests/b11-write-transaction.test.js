/**
 * Batch 11 · Multi-file write atomicity / compensation.
 *
 * All fakes are in-process; no network, no credentials, no real GitHub writes.
 * Covers the host `applyFilePatches/writeFiles` (injected callbacks) and the
 * sandbox `codemode.applyFilePatch/writeFiles` (fake tool bridge).
 *
 * Test matrix (see docs/ledger/batch-11-write-transaction.md):
 *   1. push_files success — ONE call, full files[], atomic:true, top-level fields
 *   2. push_files failure — ZERO per-file writes, no fake success
 *   3. push_files absent — non-atomic fallback, legacy shape kept
 *   4. precheck failure — ZERO writes (atomic and fallback paths)
 *   5. single-file applyFilePatch — unchanged B10 behavior
 *   6. partial failure — atomic:false, partial:true, written[], compensation
 *   7. explicit atomic:true without push_files — hard fail, zero writes
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyFilePatch,
  applyFilePatches,
  writeFiles,
  describeAtomicCapability,
  buildAtomicFiles,
} from '../src/file-write.js';
import {
  detectPushFiles,
  buildPushFilesArgs,
  PUSH_FILES_TOOL,
} from '../src/github-helpers.js';
import { runInSandbox } from '../src/codemode.js';

// ---------------------------------------------------------------------------
// Host fakes
// ---------------------------------------------------------------------------

function hostIO(files, { writeImpl, commitImpl } = {}) {
  const calls = { read: [], write: [], commit: [] };
  const read = async (path) => {
    calls.read.push(path);
    if (!(path in files)) throw new Error(`not found: ${path}`);
    return files[path].content;
  };
  const write = async (path, text, meta) => {
    calls.write.push({ path, text, meta });
    return writeImpl ? writeImpl(path, text, meta) : { commitSha: `c-${path}`, sha: `b-${path}` };
  };
  const getSha = async (path) => files[path]?.sha;
  const commitFiles = async (args) => {
    calls.commit.push(args);
    return commitImpl ? commitImpl(args) : { sha: 'commit-sha', commitSha: 'commit-sha', html_url: 'https://github.com/o/r/commit/x' };
  };
  return { read, write, getSha, commitFiles, calls };
}

const PATCH_A = '@@ -1,1 +1,1 @@\n-{"a":1}\n+{"a":2}\n';
const PATCH_B = '@@ -1,1 +1,1 @@\n-{"b":1}\n+{"b":2}\n';

const TWO_FILES = {
  'a.json': { content: '{"a":1}\n', sha: 'blob-a' },
  'b.json': { content: '{"b":1}\n', sha: 'blob-b' },
};
const TWO_PATCHES = [
  { path: 'a.json', patch: PATCH_A },
  { path: 'b.json', patch: PATCH_B },
];

// ---------------------------------------------------------------------------
// 1. host: push_files success — one atomic commit, no per-file writes
// ---------------------------------------------------------------------------

test('host writeFiles atomic success: ONE commitFiles call with full files[], zero per-file writes', async () => {
  const io = hostIO(TWO_FILES);
  const out = await writeFiles({
    ...io,
    patches: TWO_PATCHES,
    dryRun: false,
    atomic: true,
    commitArgs: { owner: 'o', repo: 'r', branch: 'main', message: 'batch' },
  });
  assert.equal(out.ok, true, out.error);
  assert.equal(out.atomic, true);
  assert.equal(io.calls.write.length, 0, 'atomic path never calls per-file write');
  assert.equal(io.calls.commit.length, 1, 'exactly one push_files call');
  const arg = io.calls.commit[0];
  assert.deepEqual(arg.files, [
    { path: 'a.json', content: '{"a":2}\n' },
    { path: 'b.json', content: '{"b":2}\n' },
  ]);
  assert.deepEqual(out.files.map((f) => f.path), ['a.json', 'b.json']);
  assert.equal(out.commitSha, 'commit-sha');
  assert.equal(out.sha, 'commit-sha');
  assert.equal(out.url, 'https://github.com/o/r/commit/x');
  assert.ok(Array.isArray(out.diff), 'multi-file diff stays an array');
});

test('host applyFilePatches: atomic defaults to true when commitFiles is present', async () => {
  const io = hostIO(TWO_FILES);
  const out = await applyFilePatches({ ...io, patches: TWO_PATCHES, dryRun: false });
  assert.equal(out.ok, true, out.error);
  assert.equal(out.atomic, true);
  assert.equal(io.calls.commit.length, 1);
  assert.equal(io.calls.write.length, 0);
});

test('host applyFilePatches: atomic defaults to false with an explicit reason when commitFiles is absent', async () => {
  const io = hostIO(TWO_FILES);
  delete io.commitFiles;
  const out = await applyFilePatches({ ...io, patches: TWO_PATCHES, dryRun: false });
  assert.equal(out.ok, true, out.error);
  assert.equal(out.atomic, false);
  assert.match(out.reason, /github__push_files.*unavailable/);
  assert.equal(io.calls.write.length, 2, 'legacy per-file writes still work');
});

// ---------------------------------------------------------------------------
// 2. host: push_files failure — zero writes, never fake success
// ---------------------------------------------------------------------------

test('host push_files throws: zero per-file writes, atomic:false, partial:false', async () => {
  const io = hostIO(TWO_FILES, {
    commitImpl: () => { throw new Error('network down'); },
  });
  const out = await writeFiles({ ...io, patches: TWO_PATCHES, dryRun: false, atomic: true });
  assert.equal(out.ok, false);
  assert.match(out.error, /atomic commit failed.*network down/);
  assert.equal(out.atomic, false);
  assert.equal(out.partial, false);
  assert.deepEqual(out.written, []);
  assert.equal(io.calls.write.length, 0, 'fallback must NOT write after a failed atomic commit');
});

test('host push_files returns {ok:false}: zero writes and the upstream error is surfaced', async () => {
  const io = hostIO(TWO_FILES, {
    commitImpl: () => ({ ok: false, error: 'SHA mismatch' }),
  });
  const out = await writeFiles({ ...io, patches: TWO_PATCHES, dryRun: false, atomic: true });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'SHA mismatch');
  assert.equal(out.atomic, false);
  assert.deepEqual(out.written, []);
  assert.equal(io.calls.write.length, 0);
});

test('host explicit atomic:true without commitFiles is a hard failure (zero reads, zero writes)', async () => {
  const io = hostIO(TWO_FILES);
  delete io.commitFiles;
  const out = await writeFiles({ ...io, patches: TWO_PATCHES, dryRun: false, atomic: true });
  assert.equal(out.ok, false);
  assert.equal(out.atomic, false);
  assert.match(out.error, /github__push_files.*unavailable/);
  assert.equal(io.calls.read.length, 0, 'fail fast before reading');
  assert.equal(io.calls.write.length, 0);
});

// ---------------------------------------------------------------------------
// 3. host: precheck failure — zero writes in both modes
// ---------------------------------------------------------------------------

test('host atomic precheck failure: one bad file blocks the whole batch (zero commits)', async () => {
  const io = hostIO({
    'ok.json': { content: '{"a":1}\n', sha: 's1' },
    'bad.json': { content: '{"x":1}\n', sha: 's2' },
  });
  const out = await applyFilePatches({
    ...io,
    patches: [
      { path: 'ok.json', patch: PATCH_A.replace(/a/g, 'a') },
      { path: 'bad.json', patch: '@@ -1,1 +1,1 @@\n-{"x":1}\n+{"x":}\n' },
    ],
    dryRun: false,
    atomic: true,
  });
  assert.equal(out.ok, false);
  assert.match(out.error, /precheck failed/);
  assert.equal(io.calls.commit.length, 0, 'no atomic commit');
  assert.equal(io.calls.write.length, 0, 'no per-file writes');
});

// ---------------------------------------------------------------------------
// 4. host: partial failure in fallback mode — honest written list + compensation
// ---------------------------------------------------------------------------

test('host fallback mid-batch write failure: partial:true + exact written list + compensation', async () => {
  const io = hostIO(TWO_FILES, {
    writeImpl: (path) => {
      if (path === 'b.json') throw new Error('disk full');
      return { commitSha: `c-${path}` };
    },
  });
  delete io.commitFiles;
  const out = await writeFiles({ ...io, patches: TWO_PATCHES, dryRun: false });
  assert.equal(out.ok, false, 'never fake success');
  assert.equal(out.atomic, false);
  assert.equal(out.partial, true);
  assert.deepEqual(out.written, ['a.json']);
  assert.deepEqual(out.writtenFiles, ['a.json']);
  assert.deepEqual(out.remaining, ['b.json']);
  assert.match(out.error, /write failed for b\.json.*disk full/);
  assert.match(out.compensation, /Restore the 1 already-written file/);
  assert.equal(io.calls.write.length, 2);
});

// ---------------------------------------------------------------------------
// 5. host: single-file applyFilePatch behavior is unchanged
// ---------------------------------------------------------------------------

test('single-file applyFilePatch: unchanged dryRun/write/precheck behavior', async () => {
  const io = hostIO({ 'a.json': { content: '{"a":1}\n', sha: 'blob-a' } });
  const preview = await applyFilePatch({ ...io, path: 'a.json', patch: PATCH_A });
  assert.equal(preview.ok, true);
  assert.equal(io.calls.write.length, 0, 'dryRun is still the default');

  const written = await applyFilePatch({ ...io, path: 'a.json', patch: PATCH_A, dryRun: false });
  assert.equal(written.ok, true);
  assert.equal(io.calls.write.length, 1);
  assert.equal(io.calls.write[0].text, '{"a":2}\n');
  // G-05: commitSha comes only from the commit-creation result; the blob sha
  // from the file-write result is exposed separately as `sha` / `blobSha`.
  assert.equal(written.commitSha, 'c-a.json');
  assert.equal(written.sha, 'b-a.json');
  assert.equal(written.blobSha, 'b-a.json');

  const io2 = hostIO({ 'bad.json': { content: '{"a":1}\n', sha: 's' } });
  const bad = await applyFilePatch({
    ...io2, path: 'bad.json', patch: '@@ -1,1 +1,1 @@\n-{"a":1}\n+{"a":}\n', dryRun: false,
  });
  assert.equal(bad.ok, false);
  assert.equal(io2.calls.write.length, 0);
});

// ---------------------------------------------------------------------------
// 6. helpers: capability + args builders
// ---------------------------------------------------------------------------

test('describeAtomicCapability / detectPushFiles report consistent reasons', () => {
  assert.deepEqual(describeAtomicCapability(() => {}, undefined), { atomic: true, supported: true, reason: null });
  const absent = describeAtomicCapability(undefined, undefined);
  assert.equal(absent.atomic, false);
  assert.match(absent.reason, /github__push_files.*unavailable/);
  const forced = describeAtomicCapability(undefined, true);
  assert.equal(forced.atomic, false);
  assert.match(forced.reason, /requested but github__push_files.*unavailable/);

  assert.equal(detectPushFiles({ tools: [{ name: PUSH_FILES_TOOL }] }).available, true);
  assert.equal(detectPushFiles({ callables: { [PUSH_FILES_TOOL]: () => {} } }).available, true);
  const no = detectPushFiles({ tools: [{ name: 'github__create_or_update_file' }] });
  assert.equal(no.available, false);
  assert.match(no.reason, /not available/);
});

test('buildAtomicFiles / buildPushFilesArgs build the exact push_files schema', () => {
  const staged = [
    { path: 'a.json', applied: { content: 'A' } },
    { path: 'b.json', applied: { content: 'B' } },
  ];
  const files = buildAtomicFiles(staged);
  assert.deepEqual(files, [{ path: 'a.json', content: 'A' }, { path: 'b.json', content: 'B' }]);
  const args = buildPushFilesArgs({ owner: 'o', repo: 'r', branch: 'main', files, message: 'batch' });
  assert.deepEqual(args, {
    owner: 'o', repo: 'r', branch: 'main',
    files: [{ path: 'a.json', content: 'A' }, { path: 'b.json', content: 'B' }],
    message: 'batch',
  });
  assert.throws(() => buildPushFilesArgs({ files: [] }), /non-empty array/);
});

// ---------------------------------------------------------------------------
// Sandbox fakes (same bridge as tests/b10-write-semantics.test.js)
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

const BASE_TOOLS = [
  toolDesc('get_file_contents', { readOnly: true }),
  toolDesc('create_or_update_file'),
];
const WITH_PUSH = [...BASE_TOOLS, toolDesc('push_files')];

function textResult(value) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] };
}

async function evalCode(code, { tools = BASE_TOOLS, handlers = {} } = {}) {
  const calls = [];
  const callTool = async (server, tool, args) => {
    calls.push({ server, tool, args });
    const fn = handlers[`${server}::${tool}`];
    if (!fn) throw new Error(`unexpected tool call: ${server}::${tool}`);
    return fn(args);
  };
  const out = await runInSandbox({ code: `async () => { ${code} }`, tools, callTool });
  assert.ok(!out.isError, out.result);
  return { value: JSON.parse(out.result), calls };
}

const SB_FILES = {
  'a.json': textResult({ content: '{"a":1}\n', sha: 'blob-a' }),
  'b.json': textResult({ content: '{"b":1}\n', sha: 'blob-b' }),
};
const SB_PATCHES = `
      { path: 'a.json', patch: '@@ -1,1 +1,1 @@\\n-{"a":1}\\n+{"a":2}\\n' },
      { path: 'b.json', patch: '@@ -1,1 +1,1 @@\\n-{"b":1}\\n+{"b":2}\\n' },`;

function readHandlers(files = SB_FILES) {
  return {
    'github::get_file_contents': (args) => files[args.path],
  };
}

// ---------------------------------------------------------------------------
// 7. sandbox: push_files success — ONE tool call, atomic:true, top-level fields
// ---------------------------------------------------------------------------

test('sandbox push_files success: one push tool call, files[] payload, atomic:true, top-level fields', async () => {
  const handlers = {
    ...readHandlers(),
    'github::push_files': (args) => {
      assert.deepEqual(args.files, [
        { path: 'a.json', content: '{"a":2}\n' },
        { path: 'b.json', content: '{"b":2}\n' },
      ]);
      assert.equal(args.owner, 'o');
      assert.equal(args.repo, 'r');
      assert.equal(args.branch, 'main');
      return textResult({ sha: 'commit-1', html_url: 'https://github.com/o/r/commit/1', number: 7 });
    },
    'github::create_or_update_file': () => { throw new Error('must not use per-file write'); },
  };
  const { value, calls } = await evalCode(`
    return await codemode.writeFiles({
      owner: 'o', repo: 'r', branch: 'main', dryRun: false,
      patches: [${SB_PATCHES}],
    });
  `, { tools: WITH_PUSH, handlers });
  assert.equal(value.ok, true, value.error);
  assert.equal(value.atomic, true);
  assert.equal(calls.filter((c) => c.tool === 'push_files').length, 1);
  assert.equal(calls.filter((c) => c.tool === 'create_or_update_file').length, 0);
  assert.equal(value.commitSha, 'commit-1');
  assert.equal(value.sha, 'commit-1');
  assert.equal(value.url, 'https://github.com/o/r/commit/1');
  assert.equal(value.number, 7);
  assert.deepEqual(value.files.map((f) => f.path), ['a.json', 'b.json']);
  assert.ok(Array.isArray(value.diff));
});

// ---------------------------------------------------------------------------
// 8. sandbox: push_files failure — zero writes
// ---------------------------------------------------------------------------

test('sandbox push_files failure: zero per-file writes, atomic:false, no fake success', async () => {
  const { value, calls } = await evalCode(`
    return await codemode.writeFiles({
      owner: 'o', repo: 'r', dryRun: false,
      patches: [${SB_PATCHES}],
    });
  `, {
    tools: WITH_PUSH,
    handlers: {
      ...readHandlers(),
      'github::push_files': () => ({ ok: false, error: 'push rejected' }),
      'github::create_or_update_file': () => { throw new Error('must not write after failed atomic commit'); },
    },
  });
  assert.equal(value.ok, false);
  assert.equal(value.error, 'push rejected');
  assert.equal(value.atomic, false);
  assert.equal(value.partial, false);
  assert.deepEqual(value.written, []);
  assert.equal(calls.filter((c) => c.tool === 'create_or_update_file').length, 0);
});

test('sandbox push_files throws: error surfaced, zero writes', async () => {
  const { value, calls } = await evalCode(`
    return await codemode.applyFilePatch({
      owner: 'o', repo: 'r', dryRun: false,
      patches: [${SB_PATCHES}],
    });
  `, {
    tools: WITH_PUSH,
    handlers: {
      ...readHandlers(),
      'github::push_files': () => { throw new Error('transport error'); },
      'github::create_or_update_file': () => { throw new Error('must not write'); },
    },
  });
  assert.equal(value.ok, false);
  assert.match(value.error, /atomic commit failed.*transport error/);
  assert.equal(value.atomic, false);
  assert.equal(calls.filter((c) => c.tool === 'create_or_update_file').length, 0);
});

// ---------------------------------------------------------------------------
// 9. sandbox: push_files absent — non-atomic fallback, B10 shape preserved
// ---------------------------------------------------------------------------

test('sandbox without push_files: per-file writes succeed with unchanged B10 top-level keys', async () => {
  const { value, calls } = await evalCode(`
    return await codemode.writeFiles({
      owner: 'o', repo: 'r', branch: 'main', dryRun: false,
      patches: [${SB_PATCHES}],
    });
  `, {
    tools: BASE_TOOLS,
    handlers: {
      ...readHandlers(),
      'github::create_or_update_file': (args) => textResult({ commitSha: `c-${args.path}`, sha: `b-${args.path}` }),
    },
  });
  assert.equal(value.ok, true, value.error);
  assert.deepEqual(Object.keys(value).sort(), ['commitSha', 'diff', 'files', 'ok', 'sha'],
    'legacy non-atomic success shape is preserved (B10 contract)');
  assert.equal(calls.filter((c) => c.tool === 'create_or_update_file').length, 2);
  assert.equal(value.commitSha, 'c-b.json');
});

test('sandbox explicit atomic:true without push_files: hard failure, zero reads/writes', async () => {
  const { value, calls } = await evalCode(`
    return await codemode.writeFiles({
      owner: 'o', repo: 'r', dryRun: false, atomic: true,
      patches: [${SB_PATCHES}],
    });
  `, {
    tools: BASE_TOOLS,
    handlers: {
      ...readHandlers(),
      'github::create_or_update_file': () => { throw new Error('must not write'); },
    },
  });
  assert.equal(value.ok, false);
  assert.equal(value.atomic, false);
  assert.match(value.error, /github__push_files is unavailable/);
  assert.match(value.reason, /unavailable/);
  assert.equal(calls.length, 0, 'fail fast before any tool call');
});

// ---------------------------------------------------------------------------
// 10. sandbox: precheck failure — zero writes in both modes
// ---------------------------------------------------------------------------

test('sandbox precheck failure blocks the whole batch in atomic mode (zero pushes)', async () => {
  const { value, calls } = await evalCode(`
    return await codemode.writeFiles({
      owner: 'o', repo: 'r', dryRun: false,
      patches: [
        { path: 'bad.json', patch: '@@ -1,1 +1,1 @@\\n-{"a":1}\\n+{"a":}\\n' },
      ],
    });
  `, {
    tools: WITH_PUSH,
    handlers: {
      ...readHandlers({ 'bad.json': textResult({ content: '{"a":1}\n', sha: 's' }) }),
      'github::push_files': () => { throw new Error('must not push'); },
      'github::create_or_update_file': () => { throw new Error('must not write'); },
    },
  });
  assert.equal(value.ok, false);
  assert.match(value.error, /precheck failed/);
  assert.equal(calls.filter((c) => c.tool === 'push_files' || c.tool === 'create_or_update_file').length, 0);
});

// ---------------------------------------------------------------------------
// 11. sandbox: partial failure in fallback — compensation metadata
// ---------------------------------------------------------------------------

test('sandbox fallback mid-batch failure: partial:true + written[] + compensation', async () => {
  const { value, calls } = await evalCode(`
    return await codemode.writeFiles({
      owner: 'o', repo: 'r', dryRun: false,
      patches: [${SB_PATCHES}],
    });
  `, {
    tools: BASE_TOOLS,
    handlers: {
      ...readHandlers(),
      'github::create_or_update_file': (args) => {
        if (args.path === 'b.json') return { ok: false, error: 'no permission' };
        return textResult({ commitSha: `c-${args.path}` });
      },
    },
  });
  assert.equal(value.ok, false);
  assert.equal(value.atomic, false);
  assert.equal(value.partial, true);
  assert.deepEqual(value.written, ['a.json']);
  assert.deepEqual(value.writtenFiles, ['a.json']);
  assert.deepEqual(value.remaining, ['b.json']);
  assert.match(value.compensation, /Restore the 1 already-written file/);
  assert.match(value.reason, /github__push_files unavailable/);
  assert.equal(calls.filter((c) => c.tool === 'create_or_update_file').length, 2);
});

// ---------------------------------------------------------------------------
// 12. sandbox single-file regression + dryRun
// ---------------------------------------------------------------------------

test('sandbox single-file applyFilePatch: unchanged B10 success/failure/dryRun behavior', async () => {
  const handlers = {
    ...readHandlers(),
    'github::create_or_update_file': (args) => textResult({ commitSha: `c-${args.path}`, sha: `n-${args.path}` }),
    'github::push_files': () => textResult({ sha: 'atomic-sha', commitSha: 'atomic-commit' }),
  };
  // Without push_files, single-file behavior is byte-for-byte the B10 shape.
  const legacy = await evalCode(`
    return await codemode.applyFilePatch({
      owner: 'o', repo: 'r', path: 'a.json', dryRun: false,
      patch: '@@ -1,1 +1,1 @@\\n-{"a":1}\\n+{"a":2}\\n',
    });
  `, { tools: BASE_TOOLS, handlers });
  assert.equal(legacy.value.ok, true, legacy.value.error);
  assert.deepEqual(Object.keys(legacy.value).sort(), ['commitSha', 'diff', 'files', 'ok', 'sha']);
  assert.equal(legacy.value.commitSha, 'c-a.json');
  assert.equal(legacy.calls.filter((c) => c.tool === 'create_or_update_file').length, 1);

  // When push_files IS available the unified entry uses the atomic committer.
  const single = await evalCode(`
    return await codemode.applyFilePatch({
      owner: 'o', repo: 'r', path: 'a.json', dryRun: false,
      patch: '@@ -1,1 +1,1 @@\\n-{"a":1}\\n+{"a":2}\\n',
    });
  `, { tools: WITH_PUSH, handlers });
  assert.equal(single.value.ok, true, single.value.error);
  assert.equal(single.value.atomic, true);
  assert.equal(single.calls.filter((c) => c.tool === 'push_files').length, 1);

  const dry = await evalCode(`
    return await codemode.applyFilePatch({
      owner: 'o', repo: 'r', path: 'a.json',
      patch: '@@ -1,1 +1,1 @@\\n-{"a":1}\\n+{"a":2}\\n',
    });
  `, { tools: WITH_PUSH, handlers });
  assert.equal(dry.value.ok, true);
  assert.equal(dry.calls.filter((c) => c.tool === 'push_files' || c.tool === 'create_or_update_file').length, 0,
    'dryRun never writes');
});
