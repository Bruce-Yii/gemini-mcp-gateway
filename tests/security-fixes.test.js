import test from 'node:test';
import assert from 'node:assert/strict';
import { unwrapResult } from '../src/tool-format.js';
import { runInSandbox } from '../src/codemode.js';

test('base64 resource blob decodes UTF-8 correctly (Chinese not mangled)', () => {
  const original = '你好 hello — café';
  const b64 = Buffer.from(original, 'utf8').toString('base64');
  const out = unwrapResult({
    content: [{ type: 'resource', resource: { uri: 'file:///x.txt', blob: b64, mimeType: 'text/plain' } }],
  });
  assert.equal(out.resources[0].text, original, 'must decode UTF-8, not latin1');
});

test('sandbox does not expose Buffer object directly', async () => {
  const out = await runInSandbox({
    code: `async () => typeof Buffer`,
    tools: [], callTool: async () => ({}),
  });
  assert.equal(out.result, 'undefined', 'Buffer must not be a sandbox global');
});

test('atob/btoa round-trip UTF-8 in sandbox', async () => {
  const out = await runInSandbox({
    code: `async () => { const b = btoa('你好'); return atob(b); }`,
    tools: [], callTool: async () => ({}),
  });
  assert.equal(out.result, '你好');
});
