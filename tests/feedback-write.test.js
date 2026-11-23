/**
 * PR80-101 feedback regression suite (batch 17).
 *
 * #1 多文件写入前的真实语法预检（JS/TS），JSX/TSX 不支持时 checked:false。
 * #2 一等补丁式局部修改：editText / applyTextEdits，唯一命中 + 自动 sha + 原子。
 * #3 结构化截断：truncation.fields / tail / next，保留 --- TRUNCATED --- 标记。
 *
 * 所有测试仅用纯函数与注入的 I/O，不访问网络、不改生产文件。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const TS_STRIP_AVAILABLE = typeof createRequire(import.meta.url)('node:module').stripTypeScriptTypes === 'function';

import {
  precheckText,
  editText,
  applyTextEdits,
  applyFilePatches,
} from '../src/file-write.js';
import { truncateResultValue } from '../src/tool-format.js';

/* ------------------------------------------------------------------ *
 * #1 · write-before precheck: real syntax parse, honest checked flag
 * ------------------------------------------------------------------ */

test('precheckText returns the structured {ok,errors,language,checked} shape', () => {
  const good = precheckText('const x: number = 1;\n', 'a.ts');
  assert.deepEqual(Object.keys(good).filter((k) => ['ok', 'errors', 'language', 'checked'].includes(k)).sort(),
    ['checked', 'errors', 'language', 'ok']);
  assert.equal(good.ok, true);
  assert.equal(good.language, 'typescript');
  assert.equal(good.checked, TS_STRIP_AVAILABLE);
  assert.deepEqual(good.errors, []);
});

test('precheckText parses .js/.mjs/.cjs with acorn — syntax errors fail BEFORE any write', async () => {
  for (const path of ['a.js', 'a.mjs', 'a.cjs']) {
    assert.equal(precheckText('const x = 1;\n', path).ok, true, path);
    const bad = precheckText('const x = ;\n', path);
    assert.equal(bad.ok, false, path);
    assert.equal(bad.checked, true);
    assert.ok(bad.errors.length > 0);
    assert.match(bad.error, /bracket balance precheck failed/); // legacy error prefix
    assert.equal(bad.check, 'balance'); // legacy field retained
  }

  const calls = [];
  const out = await applyFilePatches({
    read: async () => 'const x = 1;\n',
    write: async (path) => { calls.push(path); return {}; },
    patches: [{ path: 'bad.js', patch: '@@ -1,1 +1,1 @@\n-const x = 1;\n+const x = ;\n' }],
    dryRun: false,
  });
  assert.equal(out.ok, false);
  assert.match(out.error, /precheck failed/);
  assert.deepEqual(calls, [], 'a syntax error must block the write');
});

test('precheckText uses node:module.stripTypeScriptTypes for .ts and still rejects real syntax errors', { skip: !TS_STRIP_AVAILABLE }, () => {
  const ok = precheckText('function f<T>(x: T): T { return x; }\n', 'a.ts');
  assert.equal(ok.ok, true);
  assert.equal(ok.language, 'typescript');
  assert.equal(ok.checked, true);

  const bad = precheckText('const x: number = ;\n', 'a.ts');
  assert.equal(bad.ok, false);
  assert.equal(bad.checked, true);
  assert.match(bad.errors[0], /bracket balance precheck failed/);
});

test('precheckText never pretends JSX/TSX or unsupported TS syntax was checked', () => {
  for (const [path, language, source] of [
    ['a.tsx', 'tsx', 'const x: number = 1;\n'],
    ['a.jsx', 'jsx', 'const x = <div/>;\n'],
    ['a.ts', 'typescript', 'enum E { A, B }\n'],
    ['a.ts', 'typescript', 'namespace N { export const x = 1; }\n'],
  ]) {
    const out = precheckText(source, path);
    assert.equal(out.ok, true, 'unsupported syntax must not block a write');
    assert.equal(out.checked, false, `${path} must be explicitly unchecked`);
    assert.equal(out.language, language);
    assert.ok(typeof out.reason === 'string' && out.reason.length > 0, `${path} must state a reason`);
  }
});

test('precheckText does not misreport Markdown prose in a .ts path as a syntax error', async () => {
  // online-gap regression fixture: a Markdown/readme-style body read through a
  // .ts path. The legacy balance-only precheck accepted it; the upgraded
  // parser must not turn that into a false positive. It is reported honestly
  // as UNCHECKED instead.
  const markdownTs = '# test-gateway\n\nexport const answer = 42;\n真实文件正文行。\n';
  const out = precheckText(markdownTs, 'a.ts');
  assert.equal(out.ok, true);
  assert.equal(out.checked, false);
  assert.match(out.reason, /Markdown/);

  let writes = 0;
  const applied = await applyFilePatches({
    read: async () => markdownTs,
    write: async () => { writes += 1; return {}; },
    patches: [{ path: 'a.ts', patch: '@@ -3,1 +3,1 @@\n-export const answer = 42;\n+export const answer = 43;\n' }],
    dryRun: false,
  });
  assert.equal(applied.ok, true, applied.error);
  assert.equal(writes, 1);
});

test('precheckText still strictly parses JSON and skips unrelated extensions', () => {
  const json = precheckText('{"a":1}', 'a.json');
  assert.equal(json.ok, true);
  assert.equal(json.checked, true);
  assert.equal(json.language, 'json');
  const bad = precheckText('{"a":}', 'a.json');
  assert.equal(bad.ok, false);
  assert.equal(bad.check, 'json');
  const md = precheckText('{ unbalanced', 'a.md');
  assert.equal(md.ok, true);
  assert.equal(md.checked, false);
  assert.equal(md.language, 'other');
});

/* ------------------------------------------------------------------ *
 * #2 · first-class local edits
 * ------------------------------------------------------------------ */

test('editText applies multiple edits in order and preserves line endings', () => {
  const out = editText('a\nb\nc\n', [
    { oldText: 'b', newText: 'B' },
    { oldText: 'c', newText: 'C' },
  ]);
  assert.equal(out.ok, true);
  assert.equal(out.text, 'a\nB\nC\n');
  assert.equal(out.edits.length, 2);

  const crlf = editText('a\r\nb\r\n', [{ oldText: 'b\n', newText: 'B\n' }]);
  assert.equal(crlf.ok, true);
  assert.ok(crlf.text.includes('\r\n'), 'CRLF file keeps its CRLF endings');
});

test('editText supports adding new lines and deleting old lines', () => {
  const added = editText('one\ntwo\n', [{ oldText: 'one\n', newText: 'one\nextra\n' }]);
  assert.equal(added.text, 'one\nextra\ntwo\n');
  const removed = editText('one\ntwo\nthree\n', [{ oldText: 'two\n', newText: '' }]);
  assert.equal(removed.text, 'one\nthree\n');
});

test('editText refuses blank, missing and ambiguous oldText atomically', () => {
  for (const [source, edits, pattern] of [
    ['a a\n', [{ oldText: 'a', newText: 'b' }], /matched 2 times/],
    ['abc\n', [{ oldText: 'z', newText: 'b' }], /not found/],
    ['abc\n', [{ oldText: '', newText: 'b' }], /non-empty string/],
    ['abc\n', [{ oldText: 'a', newText: 'ok' }, { oldText: 'z', newText: 'b' }], /not found/],
  ]) {
    const out = editText(source, edits);
    assert.equal(out.ok, false);
    assert.match(out.error, pattern);
    assert.equal(out.text, source, 'a failed edit never returns partially edited text');
  }
});

test('editText requires a non-empty edit list', () => {
  const out = editText('abc', []);
  assert.equal(out.ok, false);
  assert.match(out.error, /non-empty array/);
});

test('applyTextEdits is dryRun by default, auto-fills sha, and never writes on failed precheck', async () => {
  const calls = [];
  const io = {
    read: async () => 'const x = 1;\n',
    getSha: async (p) => `sha-${p}`,
    write: async (path, text, opts) => { calls.push({ path, text, opts }); return { sha: 'new-blob', commitSha: 'new-commit' }; },
  };

  const dry = await applyTextEdits({ ...io, path: 'a.js', edits: [{ oldText: 'x = 1', newText: 'x = 2' }] });
  assert.equal(dry.ok, true);
  assert.equal(dry.sha, 'sha-a.js', 'automatic sha from getSha');
  assert.ok(dry.diff);
  assert.deepEqual(calls, [], 'dryRun never writes');

  const failed = await applyTextEdits({
    ...io,
    path: 'a.js',
    edits: [{ oldText: 'x = 1', newText: 'x = ;' }],
    dryRun: false,
  });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /precheck failed/);
  assert.deepEqual(calls, [], 'precheck failure blocks the write');
});

test('applyTextEdits commits once with the resolved sha and reports both identities', async () => {
  const calls = [];
  const out = await applyTextEdits({
    read: async () => 'const x = 1;\n',
    getSha: async () => 'base-sha',
    write: async (path, text, opts) => { calls.push({ path, text, opts }); return { sha: 'blob-2', commitSha: 'commit-2' }; },
    path: 'a.js',
    edits: [{ oldText: 'x = 1', newText: 'x = 2' }],
    dryRun: false,
  });
  assert.equal(out.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, 'const x = 2;\n');
  assert.equal(calls[0].opts.sha, 'base-sha');
  assert.equal(out.sha, 'blob-2');
  assert.equal(out.blobSha, 'blob-2');
  assert.equal(out.commitSha, 'commit-2');
});

test('applyTextEdits refuses a truncated read before any write', async () => {
  let wrote = false;
  const out = await applyTextEdits({
    read: async () => 'partial\n--- TRUNCATED --- 900 chars total',
    write: async () => { wrote = true; return {}; },
    path: 'a.js',
    edits: [{ oldText: 'partial', newText: 'P' }],
    dryRun: false,
  });
  assert.equal(out.ok, false);
  assert.match(out.error, /truncated read/);
  assert.equal(wrote, false);
});

/* ------------------------------------------------------------------ *
 * #3 · structured truncation metadata
 * ------------------------------------------------------------------ */

test('truncated objects expose truncation.fields with bytes/lines plus tail and next', () => {
  const original = {
    results: 'x'.repeat(9000),
    log: 'line1\nline2\nline3\n' + 'y'.repeat(2000),
    keep: 1,
  };
  const out = truncateResultValue(original, { maxChars: 1400 });
  const meta = out.truncation ?? out.truncationMeta;
  assert.ok(meta, 'structured truncation metadata must be present');
  assert.ok(meta.fields.results.bytes >= 9000, 'bytes reflect the original top-level value');
  assert.equal(meta.fields.log.lines, 4, 'multi-line strings report their line count');
  assert.equal(meta.fields.keep.bytes, 1);
  assert.ok(typeof meta.tail === 'string' && meta.tail.length > 0);
  assert.match(meta.next, /re-request|narrow/);
  assert.ok(JSON.stringify(out).length <= 1400, 'metadata fits the budget');
});

test('truncated text keeps the legacy marker AND embeds fields/tail/next', () => {
  const text = 'A'.repeat(12000) + '\nTHE-END-MARKER';
  const out = truncateResultValue(text, { maxChars: 600 });
  assert.equal(typeof out, 'string', 'plain text stays a string (backward compatible)');
  assert.ok(out.includes('--- TRUNCATED ---'));
  assert.ok(out.includes('truncation.fields={}'), 'strings have no top-level keys');
  assert.ok(out.includes('THE-END-MARKER'), 'tail excerpt comes from the original end');
  assert.match(out, /next="[^"]+"/);
  assert.ok(out.length <= 600);
});

test('nested string truncation still carries the legacy locating hint', () => {
  const out = truncateResultValue({ log: 'B'.repeat(12000) }, { maxChars: 500 });
  const serialized = JSON.stringify(out);
  assert.ok(serialized.includes('--- TRUNCATED ---'));
  assert.match(serialized, /grepSnippet\/text\.slice/);
  assert.ok(serialized.length <= 500);
});

test('small values are untouched and marker compatibility assertions still hold', () => {
  const small = { a: 1, b: [1, 2, 3] };
  assert.deepEqual(truncateResultValue(small, { maxChars: 800 }), small);
  for (const value of [
    { big: 'x'.repeat(5000), keep: 1 },
    Array.from({ length: 1000 }, (_, i) => i),
    'y'.repeat(5000),
  ]) {
    const out = truncateResultValue(value, { maxChars: 600 });
    const serialized = typeof out === 'string' ? out : JSON.stringify(out);
    assert.ok(serialized.includes('--- TRUNCATED ---'));
    assert.ok(serialized.length <= 610);
  }
});

test('F-08 compatibility: a string truncation reason stays a string', () => {
  const out = truncateResultValue({ truncated: false, big: 'B'.repeat(5000) }, { maxChars: 200 });
  assert.equal(out.truncated, true);
  assert.equal(typeof out.truncation, 'string');
  assert.ok(Object.keys(out).some((k) => k.startsWith('--- TRUNCATED')));
  assert.ok(JSON.stringify(out).length <= 240);
});
