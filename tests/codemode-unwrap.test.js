import test from 'node:test';
import assert from 'node:assert/strict';
import { runInSandbox } from '../src/codemode.js';

async function evalUnwrap(body) {
  const out = await runInSandbox({
    code: `async () => { const u = codemode.unwrap; ${body} }`,
    tools: [], callTool: async () => ({}),
  });
  assert.ok(!out.isError, out.result);
  return out.result;
}

test('codemode.unwrap parses a JSON string and leaves a plain string alone', async () => {
  const result = JSON.parse(await evalUnwrap(`
    return {
      parsed: u('{"a":1,"b":[2,3]}'),
      plain: u('hello world'),
      numberText: u('42'),
      globalAlias: unwrap('{"ok":true}'),
    };
  `));
  assert.deepEqual(result.parsed, { a: 1, b: [2, 3] });
  assert.equal(result.plain, 'hello world');
  assert.equal(result.numberText, 42);
  assert.deepEqual(result.globalAlias, { ok: true });
});

test('codemode.unwrap unwraps {result} and sole {structuredContent}', async () => {
  const result = JSON.parse(await evalUnwrap(`
    return {
      resultShape: u({ result: { ok: true, n: 7 } }),
      structured: u({ structuredContent: { title: 'Page' } }),
      structuredAndResult: u({ structuredContent: { a: 1 }, result: { b: 2 } }),
      structuredAndText: u({ structuredContent: { a: 1 }, text: 'body' }),
    };
  `));
  assert.deepEqual(result.resultShape, { ok: true, n: 7 });
  assert.deepEqual(result.structured, { title: 'Page' });
  assert.deepEqual(result.structuredAndResult, { structuredContent: { a: 1 }, result: { b: 2 } });
  assert.deepEqual(result.structuredAndText, { structuredContent: { a: 1 }, text: 'body' });
});

test('codemode.unwrap prefers text over duplicate resource bodies', async () => {
  const result = JSON.parse(await evalUnwrap(`
    const envelope = { text: 'status: ok', resources: [{ uri: 'file://a', text: 'status: ok' }] };
    const mixed = u({ structuredContent: { s: 1 }, text: 'status: ok',
      resources: [{ uri: 'file://a', text: 'status: ok' }] });
    return { simple: u(envelope), mixed, untouched: envelope.text };
  `));
  assert.equal(result.simple, 'status: ok');
  assert.equal(result.mixed, 'status: ok');
  assert.equal(result.untouched, 'status: ok');
});

test('codemode.unwrap extracts text from a content array without concatenating', async () => {
  const result = JSON.parse(await evalUnwrap(`
    return {
      textBlock: u({ content: [{ type: 'text', text: '{"count":3}' }] }),
      resourceBlock: u({ content: [{ type: 'resource', resource: { uri: 'x', text: 'resource body' } }] }),
      duplicateBodies: u({ content: [
        { type: 'text', text: 'same' },
        { type: 'resource', resource: { uri: 'x', text: 'same' } },
      ] }),
      ambiguousBodies: u({ content: [
        { type: 'text', text: 'first' },
        { type: 'resource', resource: { uri: 'x', text: 'second' } },
      ] }),
      imageBlock: u({ content: [
        { type: 'text', text: 'caption' },
        { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      ] }),
    };
  `));
  assert.deepEqual(result.textBlock, { count: 3 });
  assert.equal(result.resourceBlock, 'resource body');
  assert.equal(result.duplicateBodies, 'same');
  assert.deepEqual(result.ambiguousBodies, {
    content: [
      { type: 'text', text: 'first' },
      { type: 'resource', resource: { uri: 'x', text: 'second' } },
    ],
  });
  assert.deepEqual(result.imageBlock, {
    content: [
      { type: 'text', text: 'caption' },
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
    ],
  });
});

test('codemode.unwrap returns arrays/primitives as-is and ambiguous objects untouched', async () => {
  const result = JSON.parse(await evalUnwrap(`
    const ambiguous = { a: 1, b: 2 };
    return {
      array: u([1, { x: 2 }]),
      number: u(7),
      bool: u(false),
      nil: u(null) === null,
      ambiguous: u(ambiguous),
    };
  `));
  assert.deepEqual(result.array, [1, { x: 2 }]);
  assert.equal(result.number, 7);
  assert.equal(result.bool, false);
  assert.equal(result.nil, true);
  assert.deepEqual(result.ambiguous, { a: 1, b: 2 });
});

test('codemode.unwrap never throws, even for hostile shapes', async () => {
  const result = JSON.parse(await evalUnwrap(`
    const throwing = {};
    Object.defineProperty(throwing, 'result', { get() { throw new Error('boom'); }, enumerable: true });
    const cyclic = { label: 'cycle' }; cyclic.self = cyclic;
    return {
      throwing: u(throwing) === throwing,
      cyclic: u(cyclic).label,
      emptyContent: Array.isArray(u({ content: [] }).content),
      malformedBlock: u({ content: [null] }) !== null,
    };
  `));
  assert.equal(result.throwing, true);
  assert.equal(result.cyclic, 'cycle');
  assert.equal(result.emptyContent, true);
  assert.equal(result.malformedBlock, true);
});
