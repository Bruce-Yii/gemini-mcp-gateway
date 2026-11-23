/**
 * G-05 regression — commitSha must never be overwritten by blobSha.
 *
 * All I/O is injected with in-process fakes. No network, no credentials, no
 * real GitHub/MCP calls. Upstream response shapes are reproduced locally from
 * the documented GitHub MCP payloads (create_or_update_file / push_files).
 *
 * Contract under test (see docs/ledger/batch-16-g05.md):
 *   - `commitSha` comes ONLY from the commit-creation result.
 *   - `blobSha` comes ONLY from the file-write result and is exposed as
 *     `sha` (legacy field name) and the explicit `blobSha`.
 *   - The two identities may coexist; neither overwrites the other.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyFilePatch,
  applyFilePatches,
  writeFiles,
  normalizeWriteResult,
} from '../src/file-write.js';

// ---------------------------------------------------------------------------
// Injected fakes — real upstream shapes, zero I/O
// ---------------------------------------------------------------------------

function singleFileIo(text, writeResult) {
  const calls = { read: [], write: [] };
  return {
    calls,
    read: async (p) => { calls.read.push(p); return text; },
    write: async (p, t) => { calls.write.push([p, t]); return writeResult; },
  };
}

const PATCH_A = '@@ -2,1 +2,1 @@\n-two\n+TWO\n';
const BASE = 'one\ntwo\nthree\n';

function multiIo(files, { writeImpl, commitImpl } = {}) {
  const calls = { read: [], write: [], commit: [] };
  const read = async (p) => {
    calls.read.push(p);
    if (!(p in files)) throw new Error(`not found: ${p}`);
    return files[p].content;
  };
  const write = async (p, text, meta) => {
    calls.write.push({ path: p, text, meta });
    return writeImpl ? writeImpl(p, text, meta) : { commitSha: `c-${p}`, sha: `b-${p}` };
  };
  const getSha = async (p) => files[p]?.sha;
  const commitFiles = async (args) => {
    calls.commit.push(args);
    return commitImpl ? commitImpl(args) : { sha: 'commit-atomic', html_url: 'https://github.com/o/r/commit/atomic' };
  };
  return { read, write, getSha, commitFiles, calls };
}

const TWO_FILES = {
  'a.json': { content: '{"a":1}\n', sha: 'blob-a' },
  'b.json': { content: '{"b":1}\n', sha: 'blob-b' },
};
const TWO_PATCHES = [
  { path: 'a.json', patch: '@@ -1,1 +1,1 @@\n-{"a":1}\n+{"a":2}\n' },
  { path: 'b.json', patch: '@@ -1,1 +1,1 @@\n-{"b":1}\n+{"b":2}\n' },
];

// ---------------------------------------------------------------------------
// 1. Same-file / single-file patch — the exact G-05 collision
// ---------------------------------------------------------------------------

test('G-05: applyFilePatch keeps commitSha from commit.sha and blob from content.sha (both present)', async () => {
  // Real GitHub create_or_update_file payload: nested commit + content objects.
  const io = singleFileIo(BASE, {
    content: { sha: 'blob-new', path: 'docs/a.txt' },
    commit: { sha: 'commit-new' },
  });
  const r = await applyFilePatch({
    ...io,
    path: 'docs/a.txt',
    patch: PATCH_A,
    dryRun: false,
  });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.commitSha, 'commit-new', 'commitSha must come from the commit result, not the blob');
  assert.equal(r.sha, 'blob-new', 'sha keeps the blob identity');
  assert.equal(r.blobSha, 'blob-new', 'blobSha is an explicit alias of the file-write identity');
  assert.notEqual(r.commitSha, r.blobSha, 'the two identities must never collapse into one value');
  assert.equal(io.calls.write.length, 1);
});

test('G-05: applyFilePatch keeps commitSha from flat commitSha when flat sha is also present', async () => {
  // Flat shape used by several callers / MCP text payloads.
  const io = singleFileIo(BASE, { commitSha: 'commit-flat', sha: 'blob-flat' });
  const r = await applyFilePatch({ ...io, path: 'x.txt', patch: PATCH_A, dryRun: false });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.commitSha, 'commit-flat');
  assert.equal(r.sha, 'blob-flat');
  assert.equal(r.blobSha, 'blob-flat');
});

test('G-05: applyFilePatch commit-only result exposes no blob identity', async () => {
  const io = singleFileIo(BASE, { commitSha: 'commit-only' });
  const r = await applyFilePatch({ ...io, path: 'x.txt', patch: PATCH_A, dryRun: false });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.commitSha, 'commit-only');
  assert.equal(r.sha, undefined);
  assert.equal(r.blobSha, undefined);
});

test('G-05: applyFilePatch blob-only result exposes no commit identity', async () => {
  const io = singleFileIo(BASE, { sha: 'blob-only' });
  const r = await applyFilePatch({ ...io, path: 'x.txt', patch: PATCH_A, dryRun: false });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.commitSha, undefined, 'a blob sha must never be reported as a commit');
  assert.equal(r.sha, 'blob-only');
  assert.equal(r.blobSha, 'blob-only');
});

test('G-05: applyFilePatch dryRun exposes neither identity (no write happened)', async () => {
  const io = singleFileIo(BASE, { commitSha: 'never', sha: 'never' });
  const r = await applyFilePatch({ ...io, path: 'x.txt', patch: PATCH_A });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.commitSha, undefined);
  assert.equal(r.sha, undefined);
  assert.equal(r.blobSha, undefined);
  assert.equal(io.calls.write.length, 0);
});

// ---------------------------------------------------------------------------
// 2. Multi-file — per-file writes (non-atomic fallback)
// ---------------------------------------------------------------------------

test('G-05: multi-file per-file writes keep commit vs blob identities separate', async () => {
  const io = multiIo(TWO_FILES);
  delete io.commitFiles; // force the legacy per-file path
  const out = await writeFiles({ ...io, patches: TWO_PATCHES, dryRun: false });
  assert.equal(out.ok, true, out.error);
  assert.equal(out.atomic, false);
  // Last file's write shape is {commitSha:'c-b.json', sha:'b-b.json'}.
  assert.equal(out.commitSha, 'c-b.json', 'commitSha comes from the commit result');
  assert.equal(out.sha, 'b-b.json', 'sha comes from the file-write result');
  assert.notEqual(out.commitSha, out.sha, 'no overwrite even across multiple files');
});

// ---------------------------------------------------------------------------
// 3. Atomic push — push_files root `sha` IS the commit sha (semantics unchanged)
// ---------------------------------------------------------------------------

test('G-05: atomic push_files result keeps its root-sha-as-commit semantics', async () => {
  const io = multiIo(TWO_FILES, {
    commitImpl: () => ({
      sha: 'commit-atomic-2',
      commitSha: 'commit-atomic-2',
      html_url: 'https://github.com/o/r/commit/atomic2',
    }),
  });
  const out = await applyFilePatches({
    ...io,
    patches: TWO_PATCHES,
    dryRun: false,
    atomic: true,
    commitArgs: { owner: 'o', repo: 'r', branch: 'main', message: 'batch' },
  });
  assert.equal(out.ok, true, out.error);
  assert.equal(out.atomic, true);
  assert.equal(io.calls.write.length, 0, 'atomic push never calls per-file write');
  assert.equal(io.calls.commit.length, 1);
  assert.equal(out.commitSha, 'commit-atomic-2');
  assert.equal(out.sha, 'commit-atomic-2', 'push_files root sha is a commit sha by upstream contract');
});

test('G-05: atomic push_files with nested commit object still reports commitSha from the commit', async () => {
  const io = multiIo(TWO_FILES, {
    commitImpl: () => ({
      // push_files normally returns a commit object; this shape exercises the
      // nested branch of the normalizer without a root `sha`.
      commit: { sha: 'commit-nested' },
      content: { sha: 'blob-nested' },
    }),
  });
  const out = await writeFiles({ ...io, patches: TWO_PATCHES, dryRun: false, atomic: true });
  assert.equal(out.ok, true, out.error);
  assert.equal(out.commitSha, 'commit-nested');
  assert.equal(out.sha, 'blob-nested');
});

// ---------------------------------------------------------------------------
// 4. normalizeWriteResult — flat dual-identity shapes, no overwrite
// ---------------------------------------------------------------------------

test('G-05: normalizeWriteResult does not overwrite commitSha with sha (flat shape)', () => {
  const out = normalizeWriteResult({ commitSha: 'commit-n', sha: 'blob-n' });
  assert.equal(out.sha, 'blob-n');
  assert.equal(out.commitSha, 'commit-n');
  assert.notEqual(out.sha, out.commitSha);
});

test('G-05: normalizeWriteResult keeps nested content.sha and commit.sha distinct', () => {
  const out = normalizeWriteResult({ content: { sha: 'blob-n2' }, commit: { sha: 'commit-n2' } });
  assert.equal(out.sha, 'blob-n2');
  assert.equal(out.commitSha, 'commit-n2');
});

test('G-05: normalizeWriteResult still exposes null identities when upstream returned none', () => {
  const out = normalizeWriteResult(undefined);
  assert.equal(out.sha, null);
  assert.equal(out.commitSha, null);
});

// ---------------------------------------------------------------------------
// 5. Known limitation (explicitly NOT fixed in this batch)
// ---------------------------------------------------------------------------

test('G-05 limitation: normalizeWriteResult still treats root sha as a commit candidate when no explicit commit field exists', () => {
  // push_files returns a commit object whose root `sha` IS a commit sha, so
  // the shared normalizer intentionally keeps root `sha` in the commitSha
  // candidate list. For a file-write payload that ALSO carries a nested
  // commit.sha but no explicit flat commitSha, this can mislabel the blob as
  // the commit. This test pins the CURRENT behavior so the limitation is
  // visible rather than silently assumed away; fixing it requires a separate
  // write-path-aware change (see ledger "未验证项 / 限制").
  const out = normalizeWriteResult({ sha: 'blob-limitation', commit: { sha: 'commit-limitation' } });
  assert.equal(out.sha, 'blob-limitation');
  assert.equal(out.commitSha, 'blob-limitation', 'known limitation: root sha wins over nested commit.sha');
});

test('G-05: the host applyFilePatch path is NOT affected by that limitation', async () => {
  // Unlike normalizeWriteResult, applyFilePatch reads commit identity only
  // from commitSha / commit.sha, so the same payload reports the correct
  // commit even though a root `sha` is present.
  const io = singleFileIo(BASE, { sha: 'blob-ok', commit: { sha: 'commit-ok' } });
  const r = await applyFilePatch({ ...io, path: 'x.txt', patch: PATCH_A, dryRun: false });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.commitSha, 'commit-ok');
  assert.equal(r.sha, 'blob-ok');
  assert.equal(r.blobSha, 'blob-ok');
});
