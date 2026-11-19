#!/usr/bin/env node
/**
 * Local end-to-end smoke test: fake upstream -> gateway -> Streamable HTTP -> MCP client.
 *
 * Run: node scripts/smoke.mjs
 * No network, no credentials, no real MCP servers are involved.
 */

import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { UpstreamManager } from '../src/upstreams.js';
import { startHttpServer } from '../src/server.js';

const FAKE_UPSTREAM = fileURLToPath(new URL('../harness/fake-upstream.mjs', import.meta.url));

async function main() {
  // UpstreamManager spawns the fixture as a stdio child process.
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

  let httpServer;
  let client;
  try {
    await manager.connect();
    console.log(`[smoke] upstream tools: ${manager.getWhitelist().length}`);

    httpServer = await startHttpServer(manager, 0);
    const port = httpServer.address().port;
    const url = new URL(`http://127.0.0.1:${port}/mcp`);
    console.log(`[smoke] gateway listening at ${url}`);

    client = new Client({ name: 'smoke-client', version: '1.0.0' }, { capabilities: {} });
    await client.connect(new StreamableHTTPClientTransport(url));

    const { tools } = await client.listTools();
    console.log(`[smoke] tools/list (${tools.length}): ${tools.map((tool) => tool.name).join(', ')}`);

    const directName =
      tools.find((tool) => tool.name.includes('get_file_contents'))?.name ??
      tools.find((tool) => tool.name !== 'gateway_call' && tool.name !== 'gateway_search')?.name;
    if (!directName) throw new Error('no direct whitelist tool was registered');

    const direct = await client.callTool({
      name: directName,
      arguments: { owner: 'acme', repo: 'demo', path: 'README.md' },
    });
    console.log(`[smoke] direct call ${directName}: ${direct.content[0].text}`);

    const fallback = await client.callTool({
      name: 'gateway_call',
      arguments: {
        server: 'github',
        tool: 'github__list_issues',
        arguments: { owner: 'acme', repo: 'demo', state: 'open', limit: 2 },
      },
    });
    console.log(`[smoke] gateway_call: ${fallback.content[0].text}`);

    console.log('[smoke] OK');
  } finally {
    if (client) await client.close().catch(() => {});
    if (httpServer) {
      await new Promise((done) => httpServer.close(() => done()));
    }
    await manager.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(`[smoke] FAILED: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
});
