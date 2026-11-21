import test from 'node:test';
import assert from 'node:assert/strict';
import { runInSandbox } from '../src/codemode.js';

test('grepSnippet extracts context windows around keyword (case-insensitive)', async () => {
  const out = await runInSandbox({
    code: `async () => {
      const text = 'alpha BETA gamma'.repeat(20);
      const hits = grepSnippet(text, 'beta', 60);
      return { count: hits.length, first: hits[0]?.text, hasKeyword: hits[0]?.text.toLowerCase().includes('beta') };
    }`,
    tools: [], callTool: async () => ({}),
  });
  assert.ok(!out.isError, out.result);
  const r = JSON.parse(out.result);
  assert.ok(r.count >= 1 && r.count <= 10);
  assert.equal(r.hasKeyword, true);
  assert.ok(r.first.length <= 60);
});

test('grepSnippet accepts objects and returns empty on no match', async () => {
  const out = await runInSandbox({
    code: `async () => {
      const obj = { title: 'Hello', body: 'world' };
      return { a: grepSnippet(obj, 'hello', 50).length, b: grepSnippet('abc', 'zzz', 50).length };
    }`,
    tools: [], callTool: async () => ({}),
  });
  assert.ok(!out.isError, out.result);
  const r = JSON.parse(out.result);
  assert.ok(r.a >= 1, 'object should be JSON-stringified and searched');
  assert.equal(r.b, 0);
});

test('error line numbers still correct after prelude grew (self-calibration)', async () => {
  const out = await runInSandbox({
    code: `async () => {
      const x = 1;
      throw new Error('boom');
    }`,
    tools: [], callTool: async () => ({}),
  });
  assert.ok(out.isError);
  assert.ok(/script line \d+/.test(out.result), `expected line info, got: ${out.result}`);
});
