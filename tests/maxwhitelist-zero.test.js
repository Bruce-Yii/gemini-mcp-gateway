import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createGatewayServer } from '../src/server.js';

test('maxWhitelistTools=0 means no cap: all whitelist tools exposed', async () => {
  const mgr = {
    getEntries: () => [
      { server: 'a', tool: 'x', name: 'a__x', description: 'x', inputSchema: { type: 'object' } },
      { server: 'a', tool: 'y', name: 'a__y', description: 'y', inputSchema: { type: 'object' } },
      { server: 'b', tool: 'z', name: 'b__z', description: 'z', inputSchema: { type: 'object' } },
    ],
    getWhitelist: function () { return this.getEntries(); },
    callTool: async () => ({}),
  };
  const server = createGatewayServer(mgr, { mode: 'whitelist', maxWhitelistTools: 0 });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: 't', version: '1' });
  await client.connect(ct);
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  assert.ok(names.includes('a__x') && names.includes('a__y') && names.includes('b__z'), 'all 3 whitelist tools present, got ' + names.join(','));
  await client.close();
});
