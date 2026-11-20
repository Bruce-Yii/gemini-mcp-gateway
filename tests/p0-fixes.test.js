import test from 'node:test';
import assert from 'node:assert/strict';
import { unwrapResult } from '../src/tool-format.js';
import { runInSandbox } from '../src/codemode.js';

test('P0-1: resource content block preserved (file contents not lost)', () => {
  const r = {
    content: [
      { type: 'text', text: 'successfully downloaded text file (SHA: abc)' },
      { type: 'resource', resource: { uri: 'file:///src/main.js', mimeType: 'text/javascript', text: 'console.log("hello")' } },
    ],
  };
  const out = unwrapResult(r);
  assert.ok(typeof out === 'object');
  assert.ok(out.text.includes('successfully downloaded'));
  assert.ok(out.text.includes('console.log("hello")'), 'resource.text must be preserved');
  assert.equal(out.resources.length, 1);
  assert.equal(out.resources[0].uri, 'file:///src/main.js');
});

test('P0-1: single JSON text block still parses to object', () => {
  assert.deepEqual(unwrapResult({ content: [{ type: 'text', text: '{"a":1}' }] }), { a: 1 });
});

test('P0-2: large args in toolCalls audit are truncated', async () => {
  const out = await runInSandbox({
    code: `async () => { const s = 'y'.repeat(50000); await codemode.fake__push({ content: s }); return 'ok'; }`,
    tools: [{ name: 'fake__push', server: 'f', tool: 'push', description: 'push', inputSchema: {} }],
    callTool: async () => ({ content: [{ type: 'text', text: '{}' }] }),
  });
  const serialized = JSON.stringify(out);
  assert.ok(!serialized.includes('y'.repeat(1000)), 'huge arg content must not appear in result');
  assert.ok(serialized.includes('<string len=50000>'), 'should show length marker');
});

test('P1: sandbox has Web APIs (TextEncoder/atob/URL/crypto/search)', async () => {
  const out = await runInSandbox({
    code: `async () => {
      const enc = new TextEncoder().encode('hi');
      const b64 = btoa('hello');
      const u = new URL('https://example.com/x?a=1').searchParams.get('a');
      const sha = crypto.digest('SHA-256', 'abc').slice(0, 8);
      return { enc: enc.length, b64, u, sha };
    }`,
    tools: [], callTool: async () => ({}),
  });
  const r = JSON.parse(out.result);
  assert.equal(r.enc, 2);
  assert.equal(r.b64, 'aGVsbG8=');
  assert.equal(r.u, '1');
  assert.equal(r.sha.length, 8);
});

test('P1: global search() alias works', async () => {
  const out = await runInSandbox({
    code: `async () => { const r = await search('fake'); return Array.isArray(r); }`,
    tools: [{ name: 'fake__x', server: 'f', tool: 'x', description: 'fake tool', inputSchema: {} }],
    callTool: async () => ({}),
  });
  assert.equal(out.result, 'true');
});
