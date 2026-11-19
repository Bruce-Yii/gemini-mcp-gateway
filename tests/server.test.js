import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { UpstreamManager } from '../src/upstreams.js';
import { createGatewayServer } from '../src/server.js';

const FAKE_UPSTREAM = fileURLToPath(new URL('../harness/fake-upstream.mjs', import.meta.url));

const manager = new UpstreamManager([
  {
    name: 'github',
    transport: 'stdio',
    command: process.execPath,
    args: [FAKE_UPSTREAM],
    allowTools: [
      'github__get_file_contents',
      'github__list_issues',
      'github__search_code',
      // github__create_issue is intentionally NOT allowed (write operation).
    ],
  },
  {
    name: 'notion',
    transport: 'stdio',
    command: process.execPath,
    args: [FAKE_UPSTREAM],
    allowTools: ['notion__notion-search', 'notion__notion-fetch'],
  },
]);

let gatewayServer;
let client;
let listedTools;

before(async () => {
  await manager.connect();
  gatewayServer = createGatewayServer(manager);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'gateway-test-client', version: '1.0.0' }, { capabilities: {} });
  await Promise.all([
    gatewayServer.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  listedTools = (await client.listTools()).tools;
});

after(async () => {
  if (client) await client.close().catch(() => {});
  if (gatewayServer) await gatewayServer.close().catch(() => {});
  await manager.close().catch(() => {});
});

test('whitelist filtering: only allowed upstream tools are registered', () => {
  const names = listedTools.map((tool) => tool.name);
  const whitelistNames = manager
    .getWhitelist()
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'en'));

  assert.equal(whitelistNames.length, 5);
  assert.deepEqual(names.slice(0, whitelistNames.length), whitelistNames);
  assert.ok(!names.some((name) => name.includes('create_issue')), 'write tool must be filtered out');
  assert.equal(names.length, whitelistNames.length + 2);
});

test('tool registration order is stable: whitelist sorted, then gateway_call, gateway_search', () => {
  const names = listedTools.map((tool) => tool.name);
  assert.deepEqual(names.slice(-2), ['gateway_call', 'gateway_search']);
  const whitelistNames = names.slice(0, -2);
  assert.deepEqual(whitelistNames, [...whitelistNames].sort((a, b) => a.localeCompare(b, 'en')));
});

test('gateway_call exists and routes to the upstream tool', async () => {
  const tool = listedTools.find((entry) => entry.name === 'gateway_call');
  assert.ok(tool, 'gateway_call must be registered');

  const response = await client.callTool({
    name: 'gateway_call',
    arguments: {
      server: 'github',
      tool: 'github__get_file_contents',
      arguments: { owner: 'acme', repo: 'demo', path: 'README.md' },
    },
  });
  assert.equal(response.structuredContent, undefined);
  assert.equal(response.content.length, 1);
  assert.equal(response.content[0].type, 'text');

  const upstreamResult = JSON.parse(response.content[0].text);
  assert.equal(upstreamResult.content.length, 1);
  const payload = JSON.parse(upstreamResult.content[0].text);
  assert.equal(payload.ok, true);
  assert.equal(payload.server, 'github');
  assert.equal(payload.tool, 'get_file_contents');
  assert.equal(payload.arguments.path, 'README.md');
});

test('gateway_search searches the catalog without leaking upstream client objects', async () => {
  const response = await client.callTool({
    name: 'gateway_search',
    arguments: { query: 'get_file_contents', limit: 3 },
  });
  const payload = JSON.parse(response.content[0].text);
  assert.ok(payload.total >= 1);
  assert.ok(payload.matches.some((match) => match.name.includes('get_file_contents')));
  assert.ok(payload.matches.every((match) => !('_client' in match)));
});

test('sanitize adds items to the array that the upstream left incomplete', () => {
  const raw = manager
    .getWhitelist()
    .find((entry) => entry.tool === 'github__search_code');
  assert.ok(raw, 'fixture tool should be in the whitelist');
  assert.equal(raw.inputSchema.properties.filters.type, 'array');
  assert.equal(raw.inputSchema.properties.filters.items, undefined);

  const registered = listedTools.find((tool) => tool.name.includes('search_code'));
  assert.ok(registered, 'sanitized tool should be registered');
  assert.deepEqual(registered.inputSchema.properties.filters.items, { type: 'string' });
});

test('instructions stay high-level and do not enumerate tool names', () => {
  const instructions = client.getInstructions();
  assert.equal(typeof instructions, 'string');
  assert.ok(instructions.length > 20);
  assert.ok(!instructions.includes('__'), 'instructions must not list server__tool names');
});

test('direct whitelist tool call returns text JSON without structuredContent', async () => {
  const direct = listedTools.find((tool) => tool.name.includes('notion__notion-fetch'));
  assert.ok(direct, 'direct whitelist tool should be registered');

  const response = await client.callTool({
    name: direct.name,
    arguments: { id: 'page-1', includeContent: true },
  });
  assert.equal(response.structuredContent, undefined);
  const upstreamResult = JSON.parse(response.content[0].text);
  const payload = JSON.parse(upstreamResult.content[0].text);
  assert.equal(payload.ok, true);
  assert.equal(payload.arguments.id, 'page-1');
});
