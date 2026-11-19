#!/usr/bin/env node
/**
 * Standard MCP gateway server for Gemini custom connectors.
 *
 * Exposes a fixed, pre-sanitized tool surface: whitelisted upstream tools first
 * (sorted), then the two fallback meta-tools. The upstream tool schemas are
 * advertised verbatim after sanitizeTool(), so we register the low-level
 * tools/list and tools/call handlers on the underlying Server of McpServer:
 * registerTool() would round-trip the schema through Zod and mutate it.
 */

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
} from '@modelcontextprotocol/sdk/types.js';

import { sanitizeTool } from './sanitize.js';
import { searchEntries } from './catalog.js';
import { UpstreamManager } from './upstreams.js';

const SERVER_INFO = { name: 'gemini-mcp-gateway', version: '0.1.0' };

const INSTRUCTIONS = [
  'A consolidated gateway over several upstream MCP servers.',
  'Frequently used upstream capabilities are offered directly with their full parameter schemas.',
  'When none of the direct capabilities fits, search the available tool catalog and then invoke an upstream tool by its server and tool name.',
  'Prefer the direct capabilities for routine work; use the fallback only for uncovered or unusual requests.',
].join(' ');

const MAX_BODY_BYTES = 1024 * 1024;

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function textResult(result) {
  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
}

function errorResult(error) {
  return {
    content: [{ type: 'text', text: JSON.stringify({ ok: false, error: errorMessage(error) }) }],
    isError: true,
  };
}

/** Drop non-serializable client/transport references from catalog entries. */
function publicEntry(entry) {
  if (entry === null || typeof entry !== 'object') return entry;
  const { _client, transport, ...rest } = entry;
  void _client;
  void transport;
  return rest;
}

function sortKey(entry) {
  return `${entry.server ?? ''}__${entry.tool ?? entry.name ?? ''}`;
}

const CALL_TOOL = sanitizeTool({
  name: 'gateway_call',
  description:
    'Fallback: call an upstream tool directly by its server name and tool name. Use this only when no direct tool covers the request.',
  inputSchema: {
    type: 'object',
    properties: {
      server: { type: 'string', description: 'Upstream server name' },
      tool: { type: 'string', description: 'Tool name on that upstream (without any prefix)' },
      arguments: {
        type: 'object',
        description: 'Arguments to pass to the upstream tool',
        additionalProperties: true,
      },
    },
    required: ['server', 'tool'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
});

const SEARCH_TOOL = sanitizeTool({
  name: 'gateway_search',
  description:
    'Fallback: search the catalog of upstream tools when a direct tool cannot be found by name.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Keywords, or "select:<exact name>" for an exact lookup' },
      limit: { type: 'integer', description: 'Maximum number of matches', minimum: 1, maximum: 10 },
    },
    required: ['query'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
});

/**
 * Build the ordered tool registry. Whitelisted entries come first in a stable
 * order, followed by gateway_call and gateway_search.
 */
function buildToolRegistry(upstreamManager, options = {}) {
  const allEntries = upstreamManager.getEntries?.() ?? [];
  const whitelist = [...(upstreamManager.getWhitelist?.() ?? allEntries)];
  whitelist.sort((a, b) => sortKey(a).localeCompare(sortKey(b), 'en'));

  const max = options.maxWhitelistTools;
  if (Number.isFinite(max) && max >= 0) {
    whitelist.length = Math.min(whitelist.length, max);
  }

  const tools = whitelist.map((entry) => {
    const clean = sanitizeTool({
      name: entry.name,
      description: entry.description,
      inputSchema: entry.inputSchema,
      annotations: entry.annotations,
    });
    return {
      name: clean.name,
      description: clean.description,
      inputSchema: clean.inputSchema,
      annotations: clean.annotations,
      handler: async (args) => upstreamManager.callTool(entry.server, entry.tool, args ?? {}),
    };
  });

  tools.push({
    name: CALL_TOOL.name,
    description: CALL_TOOL.description,
    inputSchema: CALL_TOOL.inputSchema,
    annotations: CALL_TOOL.annotations,
    handler: async (args) => {
      const { server, tool } = args ?? {};
      if (typeof server !== 'string' || server === '') throw new Error('server is required');
      if (typeof tool !== 'string' || tool === '') throw new Error('tool is required');
      return upstreamManager.callTool(server, tool, args.arguments ?? {});
    },
  });

  tools.push({
    name: SEARCH_TOOL.name,
    description: SEARCH_TOOL.description,
    inputSchema: SEARCH_TOOL.inputSchema,
    annotations: SEARCH_TOOL.annotations,
    handler: async (args) => {
      const query = typeof args?.query === 'string' ? args.query : '';
      const limit = Number.isFinite(args?.limit) ? args.limit : 5;
      const result = searchEntries(allEntries, query, { limit });
      return { ...result, matches: result.matches.map(publicEntry) };
    },
  });

  return tools;
}

/**
 * Create the gateway as an McpServer.
 * @param {import('./upstreams.js').UpstreamManager} upstreamManager
 * @param {{maxWhitelistTools?: number}} [options]
 * @returns {McpServer}
 */
export function createGatewayServer(upstreamManager, options = {}) {
  const tools = buildToolRegistry(upstreamManager, options);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  const mcpServer = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });
  const server = mcpServer.server;
  server.registerCapabilities({ tools: { listChanged: false } });

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: tools.map(({ name, description, inputSchema, annotations }) => ({
      name,
      description,
      inputSchema,
      annotations,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params?.name;
    const tool = byName.get(name);
    if (!tool) return errorResult(new Error(`unknown tool: ${name}`));
    try {
      return textResult(await tool.handler(request.params?.arguments ?? {}));
    } catch (error) {
      return errorResult(error);
    }
  });

  return mcpServer;
}

function sendJsonRpcError(res, status, code, message) {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}

function readJsonBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejectBody(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolveBody(undefined);
        return;
      }
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        rejectBody(new Error('invalid JSON body'));
      }
    });
    req.on('error', rejectBody);
  });
}

/**
 * Build a Streamable HTTP request handler for /mcp without binding a port.
 * Used both by the local `startHttpServer` and by the Vercel entrypoint.
 * @param {import('./upstreams.js').UpstreamManager} upstreamManager
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createMcpRequestHandler(upstreamManager) {
  /** @type {Map<string, {server: McpServer, transport: StreamableHTTPServerTransport}>} */
  const sessions = new Map();

  return async (req, res) => {
    try {
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (pathname !== '/mcp') {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Not found. MCP endpoint is /mcp.');
        return;
      }

      const method = req.method;
      if (method === 'POST') {
        const body = await readJsonBody(req);
        const sessionId = req.headers['mcp-session-id'];
        const session = sessionId ? sessions.get(String(sessionId)) : undefined;

        if (session) {
          await session.transport.handleRequest(req, res, body);
          return;
        }
        if (sessionId) {
          sendJsonRpcError(res, 404, -32001, 'Session not found');
          return;
        }
        if (!isInitializeRequest(body)) {
          sendJsonRpcError(res, 400, -32000, 'Bad Request: expected an initialize request');
          return;
        }

        let gatewayServer;
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            if (gatewayServer) sessions.set(sid, { server: gatewayServer, transport });
          },
        });
        transport.onclose = () => {
          for (const [sid, entry] of sessions) {
            if (entry.transport === transport) sessions.delete(sid);
          }
        };
        gatewayServer = createGatewayServer(upstreamManager);
        await gatewayServer.connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }

      if (method === 'GET' || method === 'DELETE') {
        const sessionId = req.headers['mcp-session-id'];
        const session = sessionId ? sessions.get(String(sessionId)) : undefined;
        if (!session) {
          sendJsonRpcError(res, 404, -32001, 'Session not found');
          return;
        }
        await session.transport.handleRequest(req, res);
        return;
      }

      res.writeHead(405, { Allow: 'GET, POST, DELETE' });
      res.end();
    } catch (error) {
      if (!res.headersSent) {
        sendJsonRpcError(res, 500, -32603, `Internal error: ${errorMessage(error)}`);
      } else {
        res.end();
      }
    }
  };
}

/**
 * Start a Streamable HTTP endpoint at /mcp with one MCP session per client.
 * @returns {Promise<http.Server>} the listening HTTP server
 */
export async function startHttpServer(upstreamManager, port = 3000) {
  const handleMcp = createMcpRequestHandler(upstreamManager);
  const httpServer = http.createServer((req, res) => { void handleMcp(req, res); });

  await new Promise((resolveListen, rejectListen) => {
    httpServer.once('error', rejectListen);
    httpServer.listen(port, '127.0.0.1', () => {
      httpServer.off('error', rejectListen);
      resolveListen();
    });
  });
  return httpServer;
}

function parseCliArgs(argv) {
  const out = { config: undefined, port: undefined, stdio: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--stdio') {
      out.stdio = true;
    } else if (arg === '--config' || arg.startsWith('--config=')) {
      const value = arg === '--config' ? argv[++i] : arg.slice('--config='.length);
      if (!value) throw new Error('--config requires a path');
      out.config = value;
    } else if (arg === '--port' || arg.startsWith('--port=')) {
      const value = arg === '--port' ? argv[++i] : arg.slice('--port='.length);
      const port = Number.parseInt(value, 10);
      if (!Number.isFinite(port) || port < 0 || port > 65535) throw new Error(`invalid --port: ${value}`);
      out.port = port;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (out.stdio && out.port !== undefined) {
    throw new Error('--port and --stdio are mutually exclusive');
  }
  return out;
}

function isMain() {
  try {
    return Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

async function runCli() {
  const args = parseCliArgs(process.argv.slice(2));
  if (!args.config) throw new Error('--config <path> is required');

  const config = JSON.parse(await readFile(args.config, 'utf8'));
  const upstreamManager = new UpstreamManager(config.servers ?? []);
  await upstreamManager.connect();

  let httpServer;
  let gatewayServer;
  if (args.stdio) {
    gatewayServer = createGatewayServer(upstreamManager, {
      maxWhitelistTools: config.maxWhitelistTools,
    });
    await gatewayServer.connect(new StdioServerTransport());
  } else {
    const port = args.port ?? 3000;
    httpServer = await startHttpServer(upstreamManager, port);
    const boundPort = httpServer.address()?.port ?? port;
    console.error(`[gemini-mcp-gateway] Streamable HTTP endpoint: http://127.0.0.1:${boundPort}/mcp`);
  }

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    try {
      await upstreamManager.close();
    } catch (error) {
      console.error(`[gemini-mcp-gateway] upstream close failed: ${errorMessage(error)}`);
    }
    try {
      if (httpServer) {
        await new Promise((done) => httpServer.close(() => done()));
      }
      if (gatewayServer) await gatewayServer.close();
    } catch (error) {
      console.error(`[gemini-mcp-gateway] server close failed: ${errorMessage(error)}`);
    }
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (isMain()) {
  runCli().catch((error) => {
    console.error(`[gemini-mcp-gateway] startup failed: ${errorMessage(error)}`);
    process.exitCode = 1;
  });
}
