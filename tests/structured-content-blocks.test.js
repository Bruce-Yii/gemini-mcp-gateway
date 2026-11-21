import test from 'node:test';
import assert from 'node:assert/strict';
import { unwrapResult } from '../src/tool-format.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

test('RC-A3: structuredContent alone still returns directly', () => {
  assert.deepEqual(
    unwrapResult({ content: [{ type: 'text', text: '{"a":1}' }], structuredContent: { a: 1 } }),
    { a: 1 },
  );
});

test('RC-A3: content-array image block + structuredContent both preserved', () => {
  const out = unwrapResult({
    content: [
      { type: 'text', text: 'status' },
      { type: 'image', data: PNG, mimeType: 'image/png' },
    ],
    structuredContent: { ok: true },
  });
  assert.ok(out.images && out.images.length === 1, 'image from content[] preserved');
  assert.deepEqual(out.structuredContent, { ok: true });
});
