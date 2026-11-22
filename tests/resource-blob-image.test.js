import test from 'node:test';
import assert from 'node:assert/strict';
import { unwrapResult, MAX_RESOURCE_BINARY_BYTES } from '../src/tool-format.js';

// 1x1 transparent PNG (base64), offline fixture — no network, no token.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
const WAV_B64 = Buffer.from('RIFFfakewavpayload').toString('base64');
const STATUS = 'file read ok';

test('1) image/png resource blob -> native images[] entry, no base64/mojibake in text', () => {
  const out = unwrapResult({
    content: [
      { type: 'text', text: STATUS },
      { type: 'resource', resource: { uri: 'file:///pic.png', mimeType: 'image/png', blob: PNG } },
    ],
  });

  assert.equal(out.images.length, 1);
  assert.equal(out.images[0].data, PNG, 'base64 must reach images[] untouched');
  assert.equal(out.images[0].mimeType, 'image/png');
  assert.ok(out.images[0].size > 0, 'decoded byte size reported');

  assert.equal(out.text, STATUS, 'text must contain only the status block');
  assert.equal(out.text.includes(PNG), false, 'no base64 in text');
  assert.equal(out.text.includes('\uFFFD'), false, 'no replacement chars in text');

  const meta = out.resources[0];
  assert.equal(meta.uri, 'file:///pic.png');
  assert.equal(meta.mimeType, 'image/png');
  assert.equal(meta.size, Buffer.from(PNG, 'base64').length);
  assert.equal(meta.dataLength, PNG.length);
  assert.equal(meta.blobRef, 0, 'blobRef indexes the entry pushed into images[]');
  assert.equal(Object.hasOwn(meta, 'text'), false, 'no mangled resource text');
  assert.equal(Object.hasOwn(out, 'content'), false, 'dedupe alias contract preserved');
});

test('2) blobRef indexes past a native image block already in images[]', () => {
  const NATIVE = 'AAAA';
  const out = unwrapResult({
    content: [
      { type: 'image', data: NATIVE, mimeType: 'image/jpeg' },
      { type: 'resource', resource: { uri: 'file:///two.png', mimeType: 'image/png', blob: PNG } },
    ],
  });
  assert.equal(out.images.length, 2);
  assert.equal(out.images[0].data, NATIVE);
  assert.equal(out.images[1].data, PNG);
  assert.equal(out.resources[0].blobRef, 1);
});

test('3) text/plain blob still decoded as UTF-8 (incl. CJK and accents)', () => {
  const original = '你好 hello — café';
  const b64 = Buffer.from(original, 'utf8').toString('base64');
  const out = unwrapResult({
    content: [{ type: 'resource', resource: { uri: 'file:///x.txt', blob: b64, mimeType: 'text/plain' } }],
  });
  assert.equal(out.resources[0].text, original);
  assert.equal(out.images.length, 0);
});

test('4) resource.text (not blob) unchanged', () => {
  const out = unwrapResult({
    content: [
      { type: 'text', text: STATUS },
      { type: 'resource', resource: { uri: 'file:///a.js', mimeType: 'text/javascript', text: 'const a = 1;' } },
    ],
  });
  assert.equal(out.resources[0].text, 'const a = 1;');
  assert.equal(out.text, `${STATUS}\nconst a = 1;`);
  assert.equal(out.images.length, 0);
});

test('5) over-cap image: no images entry, omitted marker, no base64 in text', () => {
  // Oversized but cheap to build: 1 MiB + 4 bytes of decoded payload.
  const big = Buffer.alloc(MAX_RESOURCE_BINARY_BYTES + 4, 0x41).toString('base64');
  const out = unwrapResult({
    content: [
      { type: 'text', text: STATUS },
      { type: 'resource', resource: { uri: 'file:///big.png', mimeType: 'image/png', blob: big } },
    ],
  });
  assert.equal(out.images.length, 0, 'oversized image must not be emitted');
  assert.equal(out.resources[0].omitted, 'binary payload over cap');
  assert.equal(out.resources[0].size, MAX_RESOURCE_BINARY_BYTES + 4);
  assert.equal(out.text, STATUS);
  assert.equal(out.text.includes(big.slice(0, 32)), false, 'no base64 in text');
  assert.ok(JSON.stringify(out).length < 1000, 'result stays small');
});

test('6) audio/wav blob: metadata only, no images entry, no base64 in text', () => {
  const out = unwrapResult({
    content: [
      { type: 'text', text: STATUS },
      { type: 'resource', resource: { uri: 'file:///sound.wav', mimeType: 'audio/wav', blob: WAV_B64 } },
    ],
  });
  assert.equal(out.images.length, 0);
  const meta = out.resources[0];
  assert.equal(meta.mimeType, 'audio/wav');
  assert.equal(meta.size, Buffer.from(WAV_B64, 'base64').length);
  assert.equal(meta.dataLength, WAV_B64.length);
  assert.equal(Object.hasOwn(meta, 'text'), false);
  assert.equal(out.text, STATUS);
  assert.equal(out.text.includes(WAV_B64), false);
});

test('7) invalid base64 / missing mimeType: legacy UTF-8 path, no crash', () => {
  // Documented behavior: a blob whose shape is not valid base64, or which has
  // no mimeType, is treated as legacy text (UTF-8 decode) exactly as before.
  const out = unwrapResult({
    content: [
      { type: 'resource', resource: { uri: 'file:///weird.bin', mimeType: 'image/png', blob: 'not-base64!!!' } },
      { type: 'resource', resource: { uri: 'file:///nomime.bin', blob: PNG } },
    ],
  });
  assert.equal(out.images.length, 0, 'malformed blob is not emitted as an image');
  assert.equal(out.resources.length, 2);
  assert.equal(typeof out.resources[0].text, 'string', 'legacy text decode retained');
  assert.equal(out.resources[1].text, Buffer.from(PNG, 'base64').toString('utf8'));
});
