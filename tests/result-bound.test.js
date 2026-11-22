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

test('boundResult: text over limit is capped and marked with limit + original size', () => {
  const big = 'x'.repeat(5000);
  const out = boundResult({ content: [{ type: 'text', text: big }] }, 1000);
  const text = out.content[0].text;
  assert.ok(text.length <= 1000, `text length ${text.length} must be <= maxChars 1000`);
  // The message states the applied per-block limit and the original size.
  assert.ok(text.includes('limit 1000 chars'));
  assert.ok(text.includes('original 5000 chars'));
  // Guidance is kept; "truncated N chars" now reports the real number of
  // dropped chars (original - kept head), not original - maxChars.
  assert.match(text, /truncated \d+ chars by gateway/);
  assert.ok(text.includes('narrower query'));
  assert.ok(text.startsWith('x'.repeat(100)));
  const marker = text.slice(text.indexOf('\n\n'));
  const kept = text.length - marker.length;
  assert.ok(marker.includes(`truncated ${big.length - kept} chars`),
    'reported removed count must match original - kept head');
});

test('boundResult: total text length stays <= maxChars including suffix', () => {
  for (const maxChars of [100, 200, 500, 1000, 8000]) {
    const big = 'x'.repeat(maxChars * 2 + 37);
    const out = boundResult({ content: [{ type: 'text', text: big }] }, maxChars);
    assert.ok(out.content[0].text.length <= maxChars,
      `maxChars=${maxChars}: got ${out.content[0].text.length}`);
  }
  // Pathologically small limits still stay bounded (minimal-marker fallback).
  const tiny = boundResult({ content: [{ type: 'text', text: 'x'.repeat(50) }] }, 5);
  assert.ok(tiny.content[0].text.length <= 5);
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
  assert.ok(out.content[2].text.length <= 500);
  assert.ok(out.content[2].text.includes('limit 500 chars'));
  assert.ok(out.content[2].text.includes('original 3000 chars'));
  assert.match(out.content[2].text, /truncated \d+ chars by gateway/);
  assert.equal(out.isError, false);
});

test('boundResult: non-MCP shapes pass through untouched', () => {
  assert.deepEqual(boundResult({ foo: 'bar' }, 10), { foo: 'bar' });
  assert.deepEqual(boundResult(null, 10), null);
});
