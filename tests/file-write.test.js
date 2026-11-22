/**
 * B10 P0-3 / P0-4 — host-side file patch write + dry-run diff.
 *
 * All I/O is injected via fake read/write functions; no upstream tool,
 * network, or filesystem is touched. Untrusted inputs are represented only by
 * local fixed fixtures.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyTextPatch, applyFilePatch, normalizeWriteResult } from '../src/file-write.js';

// ---------- applyTextPatch (pure) ----------

test('applyTextPatch applies a single hunk with strict context and counts', () => {
  const base = 'one\ntwo\nthree\nfour\n';
  const patch = [
    '--- a/file.txt',
    '+++ b/file.txt',
    '@@ -2,2 +2,3 @@',
    '-two',
    '+two changed',
    ' three',
    '+inserted',
  ].join('\n');
  const r = applyTextPatch(base, patch);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.text, 'one\ntwo changed\nthree\ninserted\nfour\n');
  assert.equal(r.added, 2);
  assert.equal(r.removed, 1);
  assert.equal(r.hunks, 1);
});

test('applyTextPatch refuses context mismatch and never partially writes', () => {
  const base = 'one\ntwo\nthree\n';
  const patch = '@@ -2,1 +2,1 @@\n-NOT_TWO\n+changed\n';
  const r = applyTextPatch(base, patch);
  assert.equal(r.ok, false);
  assert.match(r.error, /context mismatch/);
  assert.equal(r.text, base, '原文必须原样返回，不得部分写入');
});

test('applyTextPatch handles multiple hunks with independent offsets', () => {
  const base = 'a\nb\nc\nd\ne\nf\n';
  const patch = [
    '@@ -1,1 +1,1 @@',
    '-a',
    '+A',
    '@@ -5,2 +5,2 @@',
    '-e',
    '-f',
    '+E',
    '+F',
  ].join('\n');
  const r = applyTextPatch(base, patch);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.text, 'A\nb\nc\nd\nE\nF\n');
  assert.equal(r.hunks, 2);
  assert.equal(r.added, 3);
  assert.equal(r.removed, 3);
});

test('applyTextPatch rejects the second hunk atomically (first hunk not applied)', () => {
  const base = 'a\nb\nc\nd\n';
  const patch = [
    '@@ -1,1 +1,1 @@',
    '-a',
    '+A',
    '@@ -3,1 +3,1 @@',
    '-WRONG',
    '+X',
  ].join('\n');
  const r = applyTextPatch(base, patch);
  assert.equal(r.ok, false);
  assert.match(r.error, /context mismatch/);
  assert.equal(r.text, base, '任一 hunk 失败必须整体回退');
});

test('applyTextPatch normalizes CRLF for both text and patch', () => {
  const base = 'one\r\ntwo\r\nthree\r\n';
  const patch = '@@ -2,1 +2,1 @@\r\n-two\r\n+TWO\r\n';
  const r = applyTextPatch(base, patch);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.text, 'one\nTWO\nthree\n');
  assert.equal(r.text.includes('\r'), false);
});

test('applyTextPatch preserves trailing-newline presence conservatively', () => {
  const withNl = 'a\nb\n';
  const withoutNl = 'a\nb';
  const patch = '@@ -2,1 +2,1 @@\n-b\n+B\n';
  const r1 = applyTextPatch(withNl, patch);
  const r2 = applyTextPatch(withoutNl, patch);
  assert.equal(r1.ok, true, r1.error);
  assert.equal(r2.ok, true, r2.error);
  assert.equal(r1.text, 'a\nB\n');
  assert.equal(r2.text, 'a\nB');
});

test('applyTextPatch rejects a patch with no hunks', () => {
  const r = applyTextPatch('a\n', 'just some random text');
  assert.equal(r.ok, false);
  assert.match(r.error, /no hunks|empty patch/);
  assert.equal(r.text, 'a\n');
});

test('applyTextPatch rejects a hunk whose old line is out of range', () => {
  const r = applyTextPatch('a\n', '@@ -99,1 +99,1 @@\n-x\n+y\n');
  assert.equal(r.ok, false);
  assert.match(r.error, /out of range/);
  assert.equal(r.text, 'a\n');
});

// ---------- applyFilePatch (injected orchestration) ----------

function fakeIo(text, { writeImpl } = {}) {
  const calls = { read: [], write: [] };
  const read = async (p) => { calls.read.push(p); return text; };
  const write = async (p, t) => { calls.write.push([p, t]); return writeImpl ? writeImpl(p, t) : undefined; };
  return { read, write, calls };
}

test('applyFilePatch success (non-dry-run) writes new text and returns diff + commitSha', async () => {
  const base = 'one\ntwo\nthree\n';
  const io = fakeIo(base, { writeImpl: () => ({ commitSha: 'abc123' }) });
  const r = await applyFilePatch({
    ...io,
    path: 'docs/a.txt',
    patch: '@@ -2,1 +2,1 @@\n-two\n+TWO\n',
    dryRun: false,
  });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(io.calls.read, ['docs/a.txt']);
  assert.equal(io.calls.write.length, 1);
  assert.deepEqual(io.calls.write[0], ['docs/a.txt', 'one\nTWO\nthree\n']);
  assert.equal(r.commitSha, 'abc123');
  assert.equal(r.diff.path, 'docs/a.txt');
  assert.equal(r.diff.added, 1);
  assert.equal(r.diff.removed, 1);
  assert.equal(r.diff.hunks, 1);
  assert.match(r.diff.diff, /a\/docs\/a\.txt/);
});

test('applyFilePatch default dryRun does NOT write (despite a working write fn)', async () => {
  const base = 'a\nb\n';
  const io = fakeIo(base);
  const r = await applyFilePatch({ ...io, path: 'x.txt', patch: '@@ -2,1 +2,1 @@\n-b\n+B\n' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.commitSha, undefined);
  assert.equal(r.content, undefined);
  assert.equal(io.calls.write.length, 0, 'dry-run 绝不能调用 write');
  assert.equal(r.diff.added, 1);
});

test('applyFilePatch with context mismatch does not write, returns error', async () => {
  const base = 'a\nb\n';
  const io = fakeIo(base);
  const r = await applyFilePatch({
    ...io,
    path: 'x.txt',
    patch: '@@ -2,1 +2,1 @@\n-WRONG\n+B\n',
    dryRun: false,
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /context mismatch/);
  assert.equal(io.calls.write.length, 0);
});

test('applyFilePatch multi-hunk writes the fully patched text', async () => {
  const base = 'a\nb\nc\nd\ne\nf\n';
  const io = fakeIo(base);
  const patch = [
    '@@ -1,1 +1,1 @@',
    '-a',
    '+A',
    '@@ -5,2 +5,2 @@',
    '-e',
    '-f',
    '+E',
    '+F',
  ].join('\n');
  const r = await applyFilePatch({ ...io, path: 'm.txt', patch, dryRun: false });
  assert.equal(r.ok, true, r.error);
  assert.equal(io.calls.write.length, 1);
  assert.equal(io.calls.write[0][1], 'A\nb\nc\nd\nE\nF\n');
  assert.equal(r.diff.hunks, 2);
});

test('applyFilePatch propagates a thrown write error (never fakes success)', async () => {
  const base = 'a\nb\n';
  const io = fakeIo(base, { writeImpl: () => { throw new Error('disk full'); } });
  const r = await applyFilePatch({
    ...io,
    path: 'x.txt',
    patch: '@@ -2,1 +2,1 @@\n-b\n+B\n',
    dryRun: false,
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /write failed.*disk full/);
  // A write was genuinely attempted; it must not be reported as success.
  assert.equal(io.calls.write.length, 1);
});

test('applyFilePatch propagates a thrown read error without writing', async () => {
  const io = {
    read: async () => { throw new Error('not found'); },
    write: async () => { throw new Error('should not be called'); },
  };
  const r = await applyFilePatch({ ...io, path: 'missing.txt', patch: '@@ -1,1 +1,1 @@\n-a\n+b\n', dryRun: false });
  assert.equal(r.ok, false);
  assert.match(r.error, /read failed.*not found/);
});

test('applyFilePatch reports an upstream result with ok:false as failure', async () => {
  const io = fakeIo('a\nb\n', { writeImpl: () => ({ ok: false, error: 'sha conflict' }) });
  const r = await applyFilePatch({
    ...io,
    path: 'x.txt',
    patch: '@@ -2,1 +2,1 @@\n-b\n+B\n',
    dryRun: false,
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /sha conflict/);
});

test('applyFilePatch validates its injected dependencies', async () => {
  const r1 = await applyFilePatch({ path: 'x', patch: '@@ -1 +1 @@\n-a\n+b\n' });
  assert.equal(r1.ok, false);
  assert.match(r1.error, /read must be a function/);

  const r2 = await applyFilePatch({ read: async () => 'a', path: '', patch: 'x' });
  assert.equal(r2.ok, false);
  assert.match(r2.error, /path/);
});
test('normalizeWriteResult reads GitHub {content:{sha},commit:{sha}} shape', () => {
  const out = normalizeWriteResult({ content: { sha: 'blob-new' }, commit: { sha: 'commit-new' } }, { sha: 'old' });
  assert.equal(out.sha, 'blob-new');
  assert.equal(out.commitSha, 'commit-new');
});

