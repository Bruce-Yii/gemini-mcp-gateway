/**
 * Suggestion 1 — image passthrough channel.
 *
 * An upstream MCP `{type:'image', data, mimeType}` block must reach the model as
 * a *native* MCP image content block. If its base64 is serialized into the
 * single text block, the vision encoder cannot see it and the payload can blow
 * up (or be truncated out of) the context window.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createGatewayServer } from '../src/server.js';

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgAAAAAgAB4iG8MwAAAABJRU5ErkJggg==';

const IMAGE_TOOL = {
  server: 'github',
  tool: 'get_screenshot',
  name: 'github__get_screenshot',
  description: 'Take a screenshot of a page.',
  inputSchema: { type: 'object', properties: {} },
};

async function connect(server) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'image-passthrough-test', version: '1' });
  await client.connect(clientTransport);
  return client;
}

function codemodeManager(callTool) {
  return { getEntries: () => [IMAGE_TOOL], callTool };
}

test('execute: image block becomes a native MCP content block, never base64 in text', async () => {
  let calls = 0;
  const manager = codemodeManager(async () => {
    calls += 1;
    return {
      content: [
        { type: 'text', text: '{"path":"shot.png","width":1440}' },
        { type: 'image', data: PNG_B64, mimeType: 'image/png' },
      ],
    };
  });
  const client = await connect(createGatewayServer(manager, { mode: 'codemode' }));
  try {
    const response = await client.callTool({
      name: 'execute',
      arguments: { code: 'async () => await codemode.github__get_screenshot({})' },
    });

    assert.equal(calls, 1);
    assert.ok(Array.isArray(response.content), 'MCP response must have a content array');
    assert.equal(response.content[0].type, 'text', 'text block must come first');

    const text = response.content[0].text;
    assert.ok(!text.includes(PNG_B64), 'text block must not embed the base64 payload');
    const parsed = JSON.parse(text);
    assert.ok(!JSON.stringify(parsed).includes(PNG_B64), 'no base64 anywhere in the text JSON');
    assert.deepEqual(parsed.result.images, [{ __imageRef: 0, mimeType: 'image/png' }],
      'text keeps only a lightweight image reference');

    const imageBlocks = response.content.filter((c) => c.type === 'image');
    assert.equal(imageBlocks.length, 1, 'exactly one native image block expected');
    assert.equal(imageBlocks[0].data, PNG_B64, 'image bytes must arrive intact');
    assert.equal(imageBlocks[0].mimeType, 'image/png');
  } finally {
    await client.close();
  }
});

test('execute: a large image is not truncated and does not inflate the text block', async () => {
  const bigB64 = 'A'.repeat(60000); // > the default 20000-char execute result cap
  const manager = codemodeManager(async () => ({
    content: [{ type: 'image', data: bigB64, mimeType: 'image/png' }],
  }));
  const client = await connect(createGatewayServer(manager, { mode: 'codemode' }));
  try {
    const response = await client.callTool({
      name: 'execute',
      arguments: { code: 'async () => await codemode.github__get_screenshot({})' },
    });

    const imageBlock = response.content.find((c) => c.type === 'image');
    assert.ok(imageBlock, 'native image block expected');
    assert.equal(imageBlock.data.length, bigB64.length, 'base64 must not be truncated');
    assert.equal(imageBlock.data, bigB64);
    assert.ok(response.content[0].text.length < 1000, 'text block stays small');
    assert.ok(!/TRUNCATED/.test(response.content[0].text), 'no truncation marker leaked into text');
  } finally {
    await client.close();
  }
});

test('execute: results without images keep the single text block behaviour', async () => {
  const manager = codemodeManager(async () => ({
    content: [{ type: 'text', text: '{"ok":true,"n":1}' }],
  }));
  const client = await connect(createGatewayServer(manager, { mode: 'codemode' }));
  try {
    const response = await client.callTool({
      name: 'execute',
      arguments: { code: 'async () => await codemode.github__get_screenshot({})' },
    });

    assert.equal(response.content.length, 1, 'no images -> only the text block');
    assert.equal(response.content[0].type, 'text');
    assert.deepEqual(JSON.parse(response.content[0].text).result, { ok: true, n: 1 });
  } finally {
    await client.close();
  }
});

test('direct whitelist tool: upstream image block is also passed through natively', async () => {
  const manager = {
    getEntries: () => [IMAGE_TOOL],
    getWhitelist: () => [IMAGE_TOOL],
    callTool: async () => ({
      content: [
        { type: 'text', text: 'screenshot taken' },
        { type: 'image', data: PNG_B64, mimeType: 'image/png' },
      ],
    }),
  };
  const client = await connect(createGatewayServer(manager));
  try {
    const response = await client.callTool({ name: 'github__get_screenshot', arguments: {} });

    assert.equal(response.content[0].type, 'text');
    assert.ok(!response.content[0].text.includes(PNG_B64), 'text must stay free of base64');
    const imageBlock = response.content.find((c) => c.type === 'image');
    assert.ok(imageBlock, 'native image block expected for direct tools too');
    assert.equal(imageBlock.data, PNG_B64);
    assert.equal(imageBlock.mimeType, 'image/png');
  } finally {
    await client.close();
  }
});
