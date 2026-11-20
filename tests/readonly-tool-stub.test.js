import test from 'node:test';
import assert from 'node:assert/strict';
import { runInSandbox } from '../src/codemode.js';

test('execute_read filtered tools give actionable error, not "not a function"', async () => {
  const out = await runInSandbox({
    code: `async () => { return await codemode.github__pull_request_read({owner:'a',repo:'b',pullNumber:1}); }`,
    tools: [], // not registered as usable
    unavailableTools: [{ name: 'github__pull_request_read', annotations: { readOnlyHint: true } }],
    callTool: async () => ({}),
  });
  assert.match(out.result, /unavailable in execute_read.*use execute\(\)/);
  assert.ok(!/not a function/.test(out.result));
});

test('annotations.readOnlyHint takes priority over name regex for execute_read', async () => {
  // A tool whose name starts with a write verb but is annotated read-only must
  // still be callable in execute_read (the v2 regression: pull_request_read).
  const { isReadOnlyTool } = await import('../src/codemode.js');
  assert.equal(isReadOnlyTool({ tool: 'pull_request_read', annotations: { readOnlyHint: true } }), true);
  assert.equal(isReadOnlyTool({ tool: 'delete_thing', annotations: { readOnlyHint: false } }), false);
});
