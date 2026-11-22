/**
 * Legacy MCP session correlation: the gateway issues a standard
 * Mcp-Session-Id on initialize without keeping server-side state, and a
 * spec-compliant client echoes it on subsequent requests. This is only a
 * capture/eval correlation key; requests still run statelessly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMcpRequestHandler } from '../src/server.js';

test('initialize issues Mcp-Session-Id and the client echoes it', async () => {
  const manager = {
    getEntries: () => [],
    getWhitelist: () => [],
    callTool: async () => ({ content: [{ type: 'text', text: '{}' }] }),
  };
  const handler = createMcpRequestHandler(manager, { mode: 'whitelist' });
  const server = http.createServer((req, res) => handler(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const client = new Client({ name: 'session-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
  try {
    await client.connect(transport);
    assert.match(String(transport.sessionId), /^[0-9a-f-]{36}$/);
    const first = transport.sessionId;
    await client.listTools();
    assert.equal(transport.sessionId, first, 'client keeps the session id');
  } finally {
    await client.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
