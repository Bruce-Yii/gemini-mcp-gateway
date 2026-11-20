/**
 * Targeted tests for the remaining gateway fixes:
 * 1. single serialization of execute() results
 * 2. structured truncation with `--- TRUNCATED ---` markers
 * 3. MCP content blocks: structuredContent / audio / resource_link
 * 4. compact listTools() with {service, brief}
 * 5. 50-call budget, remainingCalls(), read-only dedup cache
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createGatewayServer } from '../src/server.js';
import { runInSandbox } from '../src/codemode.js';
import { unwrapResult, truncateResultValue } from '../src/tool-format.js';

const TOOLS = [
  {
    server: 'github', tool: 'get_file_contents', name: 'github__get_file_contents',
    description: 'Get a file from a GitHub repository. This description is deliberately extremely long so that returning it unabridged would blow up the model context window and get cut off mid-sentence.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    server: 'github', tool: 'create_issue', name: 'github__create_issue',
    description: 'Create a new issue in a repository.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    server: 'notion', tool: 'notion-search', name: 'notion__notion-search',
    description: 'Search Notion workspace pages.',
    inputSchema: { type: 'object', properties: {} },
  },
];

async function codemodeClient(manager) {
  const server = createGatewayServer(manager, { mode: 'codemode' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'gateway-rest-test', version: '1' });
  await client.connect(clientTransport);
  return client;
}

/* ---------------- 1. double serialization ---------------- */

test('execute: model receives result as structured JSON, not a JSON-encoded string', async () => {
  const manager = {
    getEntries: () => TOOLS,
    callTool: async () => ({ content: [{ type: 'text', text: '{"ok":true}' }] }),
  };
  const client = await codemodeClient(manager);
  try {
    const response = await client.callTool({
      name: 'execute',
      arguments: { code: 'async () => ({ a: 1, b: [1, 2] })' },
    });
    const wire = response.content[0].text;
    const data = JSON.parse(wire);
    assert.equal(typeof data.result, 'object', 'result must be a real object on the wire');
    assert.equal(data.result.a, 1);
    assert.deepEqual(data.result.b, [1, 2]);
    assert.ok(!wire.includes('\\"a\\"'), `no double-escaped JSON expected, got: ${wire}`);
  } finally {
    await client.close();
  }
});

test('runInSandbox: direct callers still read result as a legacy string', async () => {
  const out = await runInSandbox({
    code: 'async () => ({ a: 1 })', tools: [], callTool: async () => ({}),
  });
  assert.equal(out.result, '{"a":1}');
});

/* ---------------- 2. structured truncation ---------------- */

test('truncateResultValue: oversized object stays valid JSON of the same shape', () => {
  const value = { big: 'x'.repeat(5000), arr: Array.from({ length: 200 }, (_, i) => i), small: 1 };
  const out = truncateResultValue(value, { maxChars: 800 });
  const serialized = JSON.stringify(out);
  assert.ok(serialized.length <= 800, `serialized length ${serialized.length} must fit 800`);
  assert.ok(serialized.includes('--- TRUNCATED ---'), 'must carry a truncation marker');
  assert.equal(out.small, 1, 'small sibling must survive');
  assert.ok(Array.isArray(out.arr), 'array shape preserved');
});

test('execute: truncated result on the wire is valid JSON with a marker', async () => {
  const out = await runInSandbox({
    code: 'async () => ({ big: "x".repeat(5000), keep: 42 })',
    tools: [], callTool: async () => ({}), maxResultChars: 600,
  });
  // This is exactly what server.js textResult() produces.
  const wire = JSON.parse(JSON.stringify(out));
  assert.equal(typeof wire.result, 'object');
  assert.ok(JSON.stringify(wire.result).includes('--- TRUNCATED ---'));
  assert.equal(wire.result.keep, 42);
  assert.ok(JSON.stringify(wire.result).length <= 700);
});

test('execute: oversized string result is truncated as text with a marker', async () => {
  const out = await runInSandbox({
    code: 'async () => "y".repeat(5000)', tools: [], callTool: async () => ({}), maxResultChars: 300,
  });
  const wire = JSON.parse(JSON.stringify(out));
  assert.ok(wire.result.includes('--- TRUNCATED ---'));
  assert.ok(wire.result.length <= 310);
});

/* ---------------- 3. MCP content blocks ---------------- */

test('unwrapResult: structuredContent is exposed directly', () => {
  const r = { content: [{ type: 'text', text: 'status line' }], structuredContent: { foo: 'bar', n: 1 } };
  assert.deepEqual(unwrapResult(r), { foo: 'bar', n: 1 });
});

test('unwrapResult: audio and resource_link metadata is preserved, not dropped', () => {
  const r = {
    content: [
      { type: 'text', text: 'done' },
      { type: 'audio', data: 'QUJDRA==', mimeType: 'audio/wav' },
      { type: 'resource_link', uri: 'https://example.com/doc.pdf', name: 'doc.pdf', mimeType: 'application/pdf', description: 'a doc' },
    ],
  };
  const out = unwrapResult(r);
  assert.equal(out.audios.length, 1);
  assert.equal(out.audios[0].mimeType, 'audio/wav');
  assert.equal(out.audios[0].dataLength, 8, 'payload length kept, raw base64 not echoed');
  assert.equal(out.resourceLinks.length, 1);
  assert.equal(out.resourceLinks[0].uri, 'https://example.com/doc.pdf');
  assert.equal(out.resourceLinks[0].name, 'doc.pdf');
  assert.ok(!out.text.includes('QUJDRA=='), 'no base64 payload in text');
});

test('unwrapResult: audio-only result does not fall back to the raw envelope', () => {
  const r = { content: [{ type: 'audio', data: 'QUJD', mimeType: 'audio/mpeg' }] };
  const out = unwrapResult(r);
  assert.equal(out.audios[0].mimeType, 'audio/mpeg');
});

/* ---------------- 4. listTools() ---------------- */

test('listTools: compact default, service filter and brief mode', async () => {
  const out = await runInSandbox({
    code: `async () => ({
      all: codemode.listTools(),
      gh: codemode.listTools({ service: 'github' }),
      brief: codemode.listTools({ brief: true }),
    })`,
    tools: TOOLS, callTool: async () => ({}),
  });
  const data = JSON.parse(out.result);
  assert.equal(data.all.length, 3);
  assert.deepEqual(Object.keys(data.all[0]).sort(), ['name', 'readOnly', 'service', 'summary']);
  assert.ok(data.all.every((x) => x.summary.length <= 80), 'summary must be <= 80 chars');
  const ro = data.all.find((x) => x.name === 'github__get_file_contents');
  assert.equal(ro.readOnly, true);
  const wr = data.all.find((x) => x.name === 'github__create_issue');
  assert.equal(wr.readOnly, false);
  assert.ok(data.gh.length === 2 && data.gh.every((x) => x.service === 'github'), 'service filter works');
  assert.ok(data.brief.every((x) => 'name' in x && 'service' in x && !('summary' in x)), 'brief hides summary');
});

/* ---------------- 5. budget + remainingCalls + dedup ---------------- */

test('remainingCalls: starts at 50 and decrements on each upstream call', async () => {
  const out = await runInSandbox({
    code: `async () => {
      const before = codemode.remainingCalls();
      await codemode.github__get_file_contents({ p: 1 });
      return { before, after: codemode.remainingCalls() };
    }`,
    tools: TOOLS,
    callTool: async () => ({ content: [{ type: 'text', text: '{"ok":true}' }] }),
  });
  assert.deepEqual(JSON.parse(out.result), { before: 50, after: 49 });
});

test('identical read-only calls are deduped within one execute', async () => {
  let calls = 0;
  const out = await runInSandbox({
    code: `async () => {
      const a = await codemode.github__get_file_contents({ p: 1 });
      const b = await codemode.github__get_file_contents({ p: 1 });
      const c = await codemode.github__get_file_contents({ p: 2 });
      return { a, b, c, remaining: codemode.remainingCalls() };
    }`,
    tools: TOOLS,
    callTool: async () => {
      calls += 1;
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, call: calls }) }] };
    },
  });
  assert.equal(calls, 2, 'same args deduped, different args still called');
  const data = JSON.parse(out.result);
  assert.deepEqual(data.a, { ok: true, call: 1 });
  assert.deepEqual(data.b, { ok: true, call: 1 }, 'cache hit reuses first value');
  assert.deepEqual(data.c, { ok: true, call: 2 });
  assert.equal(data.remaining, 48, 'dedup hit does not consume budget');
});

test('write tools are never deduped', async () => {
  let calls = 0;
  const out = await runInSandbox({
    code: `async () => {
      await codemode.github__create_issue({ title: 'x' });
      await codemode.github__create_issue({ title: 'x' });
      return codemode.remainingCalls();
    }`,
    tools: TOOLS,
    callTool: async () => {
      calls += 1;
      return { content: [{ type: 'text', text: '{}' }] };
    },
  });
  assert.equal(calls, 2);
  assert.equal(Number(out.result), 48);
});
