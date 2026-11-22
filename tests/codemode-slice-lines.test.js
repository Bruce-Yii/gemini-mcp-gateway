import test from 'node:test';
import assert from 'node:assert/strict';
import { runInSandbox } from '../src/codemode.js';

const TOOL = {
  server: 'fake',
  tool: 'big',
  name: 'fake__big',
  description: 'returns a large text file',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true },
};

function bigText(lines) {
  return Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join('\r\n');
}

test('sandbox holds the full upstream text; sliceLines returns only the requested range', async () => {
  const text = bigText(5000); // ~60KB, well over the model-visible cap
  const out = await runInSandbox({
    tools: [TOOL],
    callTool: async () => ({ content: [{ type: 'text', text }] }),
    code: `async () => {
      const full = await codemode.fake__big({});
      const sliced = codemode.sliceLines(full, 100, 103);
      return { saved: typeof full === 'string' ? full.length : -1, ...sliced };
    }`,
  });
  assert.ok(!out.isError, out.result);
  const result = JSON.parse(out.result);
  assert.ok(result.saved > 50_000, `full text reached the sandbox (${result.saved} chars)`);
  assert.equal(result.startLine, 100);
  assert.equal(result.endLine, 103);
  assert.equal(result.totalLines, 5000);
  assert.equal(result.truncated, true);
  assert.match(result.text, /^line 100\nline 101\nline 102\nline 103$/);
});

test('sliceLines clamps ranges, handles single line and empty input', async () => {
  const out = await runInSandbox({
    tools: [],
    callTool: async () => ({}),
    code: `async () => ({
      clamped: codemode.sliceLines('a\\nb\\nc', 0, 99),
      reversed: codemode.sliceLines('a\\nb\\nc', 3, 2),
      single: codemode.sliceLines('a\\nb\\nc', 2, 2),
      empty: codemode.sliceLines('', 1, 10),
    })`,
  });
  assert.ok(!out.isError, out.result);
  const result = JSON.parse(out.result);
  assert.equal(result.clamped.text, 'a\nb\nc');
  assert.equal(result.clamped.startLine, 1);
  assert.equal(result.clamped.endLine, 3);
  assert.equal(result.reversed.text, '');
  assert.equal(result.single.text, 'b');
  assert.equal(result.empty.totalLines, 1);
});

test('final execute result stays small when the script returns only a slice', async () => {
  const text = bigText(4000);
  const out = await runInSandbox({
    tools: [TOOL],
    callTool: async () => ({ content: [{ type: 'text', text }] }),
    code: `async () => { const full = await codemode.fake__big({}); return codemode.sliceLines(full, 2000, 2002); }`,
  });
  assert.ok(!out.isError, out.result);
  assert.ok(out.result.length < 2000, `result stayed small (${out.result.length} chars)`);
  assert.match(out.result, /line 2002/);
});
