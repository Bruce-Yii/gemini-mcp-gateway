import test from 'node:test';
import assert from 'node:assert/strict';
import { boundResult } from '../src/server.js';

test('boundResult: small result passes through unchanged', () => {
  const r = { content: [{ type: 'text', text: 'hello' }] };
  assert.deepEqual(boundResult(r, 100), r);
});

test('boundResult: large text block is truncated with guidance', () => {
  const big = 'x'.repeat(5000);
  const out = boundResult({ content: [{ type: 'text', text: big }] }, 8000);
  assert.equal(out.content[0].text, big); // 5000 <= 8000, unchanged
});

test('boundResult: text over limit is capped and marked', () => {
  const big = 'x'.repeat(5000);
  const out = boundResult({ content: [{ type: 'text', text: big }] }, 1000);
  assert.ok(out.content[0].text.length < 1200);
  assert.ok(out.content[0].text.includes('truncated 4000 chars'));
  assert.ok(out.content[0].text.includes('narrower query'));
  assert.ok(out.content[0].text.startsWith('x'.repeat(1000)));
});

test('boundResult: keeps structure and non-text content, truncates only big text', () => {
  const r = {
    content: [
      { type: 'text', text: 'short' },
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      { type: 'text', text: 'y'.repeat(3000) },
    ],
    isError: false,
  };
  const out = boundResult(r, 500);
  assert.equal(out.content[0].text, 'short');
  assert.deepEqual(out.content[1], { type: 'image', data: 'AAAA', mimeType: 'image/png' });
  assert.ok(out.content[2].text.includes('truncated 2500 chars'));
  assert.equal(out.isError, false);
});

test('boundResult: non-MCP shapes pass through untouched', () => {
  assert.deepEqual(boundResult({ foo: 'bar' }, 10), { foo: 'bar' });
  assert.deepEqual(boundResult(null, 10), null);
});
