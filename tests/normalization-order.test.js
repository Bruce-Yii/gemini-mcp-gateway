import test from 'node:test';
import assert from 'node:assert/strict';
import { validateToolArgs } from '../src/codemode.js';
import { runInSandbox } from '../src/codemode.js';

const tool = {
  name: 'svc__demo',
  inputSchema: {
    type: 'object',
    properties: { owner: { type: 'string' }, per_page: { type: 'number' } },
    required: ['owner', 'per_page'],
  },
};

test('RC-D3: camelCase required field passes preflight (normalize before validate)', () => {
  // Model fills perPage (camelCase) but schema declares per_page (required).
  // Preflight must NOT report per_page missing.
  assert.doesNotThrow(() => validateToolArgs(tool, { owner: 'x', perPage: 5 }));
});

test('RC-D3: genuinely missing required field still throws', () => {
  assert.throws(() => validateToolArgs(tool, { perPage: 5 }), /owner/);
});

test('RC-D3: wrong type after normalization still throws', () => {
  assert.throws(() => validateToolArgs(tool, { owner: 'x', perPage: 'five' }), /per_page.*number/);
});

test('RC-D3: end-to-end camelCase args reach sandbox tool call without preflight error', async () => {
  let received;
  const out = await runInSandbox({
    code: `async () => await codemode.svc__demo({ owner:'x', perPage: 5 })`,
    tools: [tool],
    callTool: async (_s, _t, a) => { received = a; return { content: [{ type: 'text', text: '{"ok":true}' }] }; },
  });
  assert.ok(!out.isError, `unexpected error: ${out.result}`);
});
