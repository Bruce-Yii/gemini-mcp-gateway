import test from 'node:test';
import assert from 'node:assert/strict';
import { runInSandbox, pickScriptLoc } from '../src/codemode.js';

async function evalCode(code) {
  const out = await runInSandbox({ code: `async () => { ${code} }`, tools: [], callTool: async () => ({}) });
  assert.ok(!out.isError, out.result);
  return JSON.parse(out.result);
}

test('replaceLines replaces, inserts and deletes a 1-based line range', async () => {
  const result = await evalCode(`
    const src = 'a\\nb\\nc\\nd';
    return {
      replace: codemode.replaceLines(src, 2, 2, 'B'),
      insert: codemode.replaceLines(src, 3, 2, 'x'),
      del: codemode.replaceLines(src, 2, 3, ''),
      bad: codemode.replaceLines(src, 99, 99, 'x'),
    };
  `);
  assert.equal(result.replace.text, 'a\nB\nc\nd');
  assert.equal(result.insert.text, 'a\nb\nx\nc\nd');
  assert.equal(result.del.text, 'a\nd');
  assert.equal(result.bad.ok, false);
});

test('applyPatch applies a unified diff hunk and reports counts', async () => {
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
  const result = await evalCode(`
    return codemode.applyPatch(${JSON.stringify(base)}, ${JSON.stringify(patch)});
  `);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.text, 'one\ntwo changed\nthree\ninserted\nfour\n');
  assert.equal(result.hunks, 1);
  assert.equal(result.added, 2);
  assert.equal(result.removed, 1);
});

test('applyPatch refuses a context mismatch and returns the original text', async () => {
  const base = 'one\ntwo\nthree\n';
  const patch = '@@ -2,1 +2,1 @@\n-NOT_TWO\n+changed\n';
  const result = await evalCode(`
    return codemode.applyPatch(${JSON.stringify(base)}, ${JSON.stringify(patch)});
  `);
  assert.equal(result.ok, false);
  assert.match(result.error, /context mismatch/);
  assert.equal(result.text, base);
});

test('applyPatch handles multiple hunks with independent offsets', async () => {
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
  const result = await evalCode(`
    return codemode.applyPatch(${JSON.stringify(base)}, ${JSON.stringify(patch)});
  `);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.text, 'A\nb\nc\nd\nE\nF\n');
  assert.equal(result.hunks, 2);
});

test('diffSummary reports a compact before/after change summary', async () => {
  const result = await evalCode(`
    return codemode.diffSummary('a\\nb\\nc', 'a\\nB\\nc\\nd');
  `);
  assert.equal(result.beforeLines, 3);
  assert.equal(result.afterLines, 4);
  assert.equal(result.changed, true);
  assert.ok(result.added >= 1);
  assert.ok(result.removed >= 1);
});

test('thrown guest errors are mapped to the user script line, not run.js', async () => {
  const out = await runInSandbox({
    code: 'async () => { codemode.notARealTool(); }',
    tools: [],
    callTool: async () => ({}),
  });
  assert.equal(out.isError, true);
  assert.match(out.result, /not a function/);
  assert.match(out.result, /script line 1:\d+/);
});


test('pickScriptLoc picks the last positive run.js frame, not the wrapper frame', () => {
  const stack = 'TypeError: not a function\n    at __dshFn (run.js:354:20)\n    at <anonymous> (run.js:374:37)';
  assert.deepEqual(pickScriptLoc(stack, 360), { line: 14, column: 37 });
  assert.equal(pickScriptLoc('Error\n at x (run.js:10:2)', 300, 60), null);
  assert.equal(pickScriptLoc('', 1), null);
});

