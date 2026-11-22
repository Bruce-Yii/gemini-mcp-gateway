import test from 'node:test';
import assert from 'node:assert/strict';
import { unwrapResult } from '../src/tool-format.js';

const FILE = 'const answer = 42;\n// a file body long enough to be meaningful';
const STATUS = 'successfully downloaded text file (SHA: abc)';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

/** Count non-overlapping occurrences of `needle` across all string fields of `obj`. */
function countOccurrences(obj, needle) {
  if (needle === '') return 0;
  const visit = (v) => {
    if (typeof v === 'string') {
      let n = 0;
      let i = v.indexOf(needle);
      while (i !== -1) {
        n += 1;
        i = v.indexOf(needle, i + needle.length);
      }
      return n;
    }
    if (Array.isArray(v)) return v.reduce((sum, x) => sum + visit(x), 0);
    if (v && typeof v === 'object') return Object.values(v).reduce((sum, x) => sum + visit(x), 0);
    return 0;
  };
  return visit(obj);
}

test('1) identical text + resource body -> one copy, no duplicate content alias', () => {
  const out = unwrapResult({
    content: [
      { type: 'text', text: FILE },
      { type: 'resource', resource: { uri: 'file:///src/main.js', mimeType: 'text/javascript', text: FILE } },
    ],
  });

  assert.ok(out && typeof out === 'object');
  assert.equal(out.text, FILE, 'body must appear exactly once in text (not body\\nbody)');
  assert.equal(countOccurrences(out, FILE), 1, 'body appears exactly once in the whole result');
  assert.equal(Object.hasOwn(out, 'content'), false, 'no third `content` alias');
  // Resource metadata survives even though the redundant body was dropped.
  assert.equal(out.resources.length, 1);
  assert.equal(out.resources[0].uri, 'file:///src/main.js');
  assert.equal(out.resources[0].mimeType, 'text/javascript');
  assert.equal(Object.hasOwn(out.resources[0], 'text'), false, 'redundant resource body omitted');
});

test('2) different text + resource bodies -> both preserved, no third copy', () => {
  const out = unwrapResult({
    content: [
      { type: 'text', text: STATUS },
      { type: 'resource', resource: { uri: 'file:///src/main.js', mimeType: 'text/javascript', text: FILE } },
    ],
  });

  assert.ok(out && typeof out === 'object');
  assert.equal(out.text, `${STATUS}\n${FILE}`, 'both distinct bodies present in text');
  assert.ok(out.text.includes(STATUS), 'status body preserved');
  assert.ok(out.text.includes(FILE), 'file body preserved');
  assert.equal(out.resources[0].text, FILE, 'resource body still available on the resource entry');
  assert.equal(Object.hasOwn(out, 'content'), false, 'no third content alias');
  // The file body may be in both `text` and `resources[].text` (kept for
  // backward compatibility), but there must be no *third* `content` copy.
  assert.equal(countOccurrences(out, FILE), 2);
  assert.equal(countOccurrences(out, STATUS), 1);
});

test('3) single text JSON still parsed as before', () => {
  assert.deepEqual(unwrapResult({ content: [{ type: 'text', text: '{"a":1,"b":[2,3]}' }] }), { a: 1, b: [2, 3] });
  assert.equal(unwrapResult({ content: [{ type: 'text', text: 'plain text' }] }), 'plain text');
});

test('4) structuredContent-only unchanged', () => {
  assert.deepEqual(
    unwrapResult({ content: [{ type: 'text', text: 'status line' }], structuredContent: { foo: 'bar', n: 1 } }),
    { foo: 'bar', n: 1 },
  );
  assert.deepEqual(unwrapResult({ structuredContent: { only: true } }), { only: true });
});

test('5) image content block unchanged', () => {
  const out = unwrapResult({
    content: [
      { type: 'text', text: 'status' },
      { type: 'image', data: PNG, mimeType: 'image/png' },
    ],
  });
  assert.ok(Array.isArray(out.images) && out.images.length === 1);
  assert.deepEqual(out.images[0], { data: PNG, mimeType: 'image/png' });
  assert.equal(out.text, 'status', 'base64 must not leak into text');
});

test('6) isError still throws with the error text', () => {
  assert.throws(
    () => unwrapResult({ isError: true, content: [{ type: 'text', text: 'upstream boom' }] }),
    /upstream boom/,
  );
});
