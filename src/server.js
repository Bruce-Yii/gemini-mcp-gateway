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
import { createCodeModeTools } from './codemode.js';
import { validateConfig } from './config.js';
import { captureEvent, startCapture, captureSkip } from './capture.js';

const SERVER_INFO = { name: 'gemini-mcp-gateway', version: '0.1.0' };

const INSTRUCTIONS = [
  'A consolidated gateway over several upstream MCP servers.',
  'Frequently used upstream capabilities are offered directly with their full parameter schemas.',
  'When none of the direct capabilities fits, search the available tool catalog and then invoke an upstream tool by its server and tool name.',
  'Prefer the direct capabilities for routine work; use the fallback only for uncovered or unusual requests.',
].join(' ');

const MAX_BODY_BYTES = 1024 * 1024;
// Result-size guard: a single upstream call can dump a huge blob (file content,
// deployment logs) straight into the model's context. Cap each text block and
// tell the model how to get more. Keep the MCP content structure intact.
const DEFAULT_MAX_RESULT_CHARS = Number(process.env.GATEWAY_MAX_RESULT_CHARS ?? 8000);

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Bound upstream tool results before they re-enter the model context.
 * Works on the MCP result shape { content: [{type:'text', text}, ...] }.
 * Non-text content (images etc.) is left untouched.
 */
function truncationSuffix(removed, maxChars, original) {
  return `\n\n… [truncated ${removed} chars by gateway: ` +
    `limit ${maxChars} chars, original ${original} chars. ` +
    `Use a narrower query or gateway_call with specific args to fetch less.]`;
}

export function boundResult(result, maxChars = DEFAULT_MAX_RESULT_CHARS) {
  if (!result || typeof result !== 'object' || !Array.isArray(result.content)) return result;
  let truncated = false;
  const content = result.content.map((item) => {
    if (!item || item.type !== 'text' || typeof item.text !== 'string') return item;
    if (item.text.length <= maxChars) return item;
    truncated = true;
    const original = item.text.length;
    // The suffix states the exact number of dropped chars, which depends on
    // how much head we keep — and that depends on the suffix length. Iterate
    // to a fixed point so head + suffix is always <= maxChars.
    let keep = Math.max(0, maxChars);
    let tail = truncationSuffix(original - keep, maxChars, original);
    for (let i = 0; i < 4; i++) {
      const nextKeep = Math.max(0, maxChars - tail.length);
      const nextTail = truncationSuffix(original - nextKeep, maxChars, original);
      if (nextKeep === keep && nextTail === tail) break;
      keep = nextKeep;
      tail = nextTail;
    }
    let out = item.text.slice(0, keep) + tail;
    while (keep > 0 && out.length > maxChars) {
      keep = Math.max(0, keep - (out.length - maxChars));
      tail = truncationSuffix(original - keep, maxChars, original);
      out = item.text.slice(0, keep) + tail;
    }
    if (out.length <= maxChars) return { ...item, text: out };
    // Pathologically small maxChars: even the suffix does not fit. Keep a
    // minimal bounded marker rather than exceeding the cap.
    const marker = '…[truncated]';
    return { ...item, text: item.text.slice(0, Math.max(0, maxChars - marker.length)) + marker.slice(0, Math.max(0, maxChars)) };
  });
  return truncated ? { ...result, content } : result;
}

/**
 * Native MCP image content blocks are `{type:'image', data, mimeType}`.
 * `unwrapResult()` collects upstream image blocks into an `images[]` array, and
 * direct whitelist tools can return an MCP `content` array with image blocks.
 * When such a result is serialized as one text block the base64 is invisible to
 * the vision encoder and large enough to blow up the context window.
 *
 * These helpers detach every recognised image payload into its own content
 * block, leaving only a lightweight `{__imageRef, mimeType}` placeholder in the
 * text JSON. Results without images are passed through byte-for-byte, so all
 * other tools keep their existing behaviour.
 */
function isImagePayload(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    typeof value.data === 'string' && value.data.length > 0;
}

function imageAt(value, inImagesArray) {
  return isImagePayload(value) && (inImagesArray || value.type === 'image');
}

function hasImagePayload(value, inImagesArray = false) {
  if (Array.isArray(value)) return value.some((v) => hasImagePayload(v, inImagesArray));
  if (value === null || typeof value !== 'object') return false;
  if (imageAt(value, inImagesArray)) return true;
  return Object.entries(value).some(([key, v]) => hasImagePayload(v, key === 'images'));
}

function collectImages(value, sink, inImagesArray = false) {
  if (Array.isArray(value)) return value.map((v) => collectImages(v, sink, inImagesArray));
  if (value === null || typeof value !== 'object') return value;
  if (imageAt(value, inImagesArray)) {
    const ref = sink.length;
    sink.push({
      type: 'image',
      data: value.data,
      mimeType: typeof value.mimeType === 'string' && value.mimeType ? value.mimeType : 'image/png',
    });
    return { __imageRef: ref, ...(typeof value.mimeType === 'string' ? { mimeType: value.mimeType } : {}) };
  }
  const out = {};
  for (const [key, v] of Object.entries(value)) out[key] = collectImages(v, sink, key === 'images');
  return out;
}

function textResult(result, options = {}) {
  const images = [];
  const detached = hasImagePayload(result) ? collectImages(result, images) : result;
  const bounded = options.noBound ? detached : boundResult(detached, options.maxChars);
  return {
    content: [
      { type: 'text', text: JSON.stringify(bounded) },
      ...images,
    ],
  };
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
  // 0 or unset means "no cap" — only a positive number limits the list.
  if (Number.isFinite(max) && max > 0) {
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
 * @param {{maxWhitelistTools?: number, mode?: 'whitelist'|'codemode', maxCalls?: number, maxResultChars?: number}} [options]
 * @returns {McpServer}
 */
export function createGatewayServer(upstreamManager, options = {}) {
  let tools;
  let instructions = INSTRUCTIONS;
  if (options.mode === 'codemode') {
    tools = createCodeModeTools(upstreamManager, options);
    instructions = [
      'This gateway exposes three tools: search() to discover upstream tools; execute_read() to run JavaScript that can only call read-only upstream tools; and execute() to run JavaScript with read-write access.',
      'Prefer execute_read() or execute(): write code that calls codemode.<tool>(args), process large results inside the code, and return only a concise summary. Only your return value enters the conversation.',
      'Use search() first if you do not know the exact tool name.',
    ].join(' ');
  } else {
    tools = buildToolRegistry(upstreamManager, options);
  }
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  captureEvent('gateway_catalog', {
    mode: options.mode ?? 'whitelist',
    limits: {
      maxWhitelistTools: options.maxWhitelistTools,
      maxCalls: options.maxCalls,
      maxResultChars: options.maxResultChars,
    },
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
    })),
    upstreams: [...new Set(upstreamManager.getEntries().map((entry) => entry.server))],
  });

  const mcpServer = new McpServer(SERVER_INFO, { instructions });
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
  if (Object.prototype.hasOwnProperty.call(req, '__gatewayRawBody')) {
    const raw = req.__gatewayRawBody;
    if (!raw) return Promise.resolve(undefined);
    try { return Promise.resolve(JSON.parse(raw)); } catch { return Promise.reject(new Error('invalid JSON body')); }
  }
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
        req.__gatewayRawBody = '';
        resolveBody(undefined);
        return;
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      req.__gatewayRawBody = raw;
      try {
        resolveBody(JSON.parse(raw));
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
export function createMcpRequestHandler(upstreamManager, options = {}) {
  // Stateless by design: Vercel serverless may route each request to a different
  // instance, so an in-memory session map cannot work. Every POST gets a fresh
  // McpServer + StreamableHTTPServerTransport, which handles that one request
  // and is discarded. sessionIdGenerator: undefined keeps the transport from
  // requiring a sticky session. This matches Google's stateless-server guidance.
  return async (req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    const method = req.method;

    // P0 capture audit: production already called startCapture at the top of
    // the Vercel app handler. Here we only avoid a double envelope — we read
    // the existing context instead of creating a second one. Standalone use
    // (local startHttpServer / direct handler calls) starts capture itself.
    let capture;
    if (pathname === '/mcp' && method === 'POST') {
      if (req.__gatewayCaptureStarted) {
        capture = req.__gatewayCapture ?? null;
      } else {
        capture = startCapture(req, res, {
          ...options,
          path: pathname,
          bodyBuffered: req.__gatewayRawBody !== undefined,
        });
      }
    } else if (!req.__gatewayCaptureStarted) {
      // Non-POST /mcp or non-/mcp: explicitly auditable as not eligible.
      // Never carry header/body values into the skip line.
      captureSkip(req, {
        path: pathname,
        reason: 'non_post',
        detail: pathname === '/mcp' ? 'GET/DELETE/other /mcp method' : 'not /mcp route',
      });
    }

    try {
      if (pathname !== '/mcp') {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Not found. MCP endpoint is /mcp.');
        return;
      }

      if (method === 'POST') {
        let body;
        try {
          body = await readJsonBody(req);
        } catch (error) {
          // Body read failed before any handler work. The response still
          // goes through res.end (sendJsonRpcError) so [capture_done] fires;
          // mark the skip reason explicitly for audit.
          if (capture?.skip) capture.skip('body_buffer_failed');
          throw error;
        }
        let gatewayServer;
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined, // stateless: no sticky session required
        });
        gatewayServer = createGatewayServer(upstreamManager, options);
        await gatewayServer.connect(transport);
        await transport.handleRequest(req, res, body);
        // Close after the single request is answered.
        try { await transport.close(); } catch {}
        try { await gatewayServer.close(); } catch {}
        return;
      }

      // GET opens an SSE stream that hangs until the client disconnects. On
      // Vercel this hits the 60s function timeout. Google's Connected Apps spec
      // explicitly allows stateless servers to answer GET with 405, which the
      // client proxy handles cleanly. All real traffic is HTTP POST.
      if (method === 'GET') {
        res.writeHead(405, { Allow: 'POST, DELETE' });
        res.end();
        return;
      }

      if (method === 'DELETE') {
        // Stateless mode: nothing to tear down. Acknowledge and move on.
        res.writeHead(204);
        res.end();
        return;
      }

      res.writeHead(405, { Allow: 'GET, POST, DELETE' });
      res.end();
    } catch (error) {
      if (capture?.skip && !res.headersSent) capture.skip('handler_error');
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
export async function startHttpServer(upstreamManager, port = 3000, options = {}) {
  const handleMcp = createMcpRequestHandler(upstreamManager, options);
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

  const parsed = JSON.parse(await readFile(args.config, 'utf8'));
  const { config, warnings } = validateConfig(parsed);
  for (const warning of warnings) console.error(`[config] ${warning}`);
  const upstreamManager = new UpstreamManager(config.servers ?? []);
  await upstreamManager.connect();
  const gatewayOptions = {
    mode: config.mode ?? 'whitelist',
    maxWhitelistTools: config.maxWhitelistTools,
    maxCalls: config.maxCalls,
    maxResultChars: config.maxResultChars,
  };

  let httpServer;
  let gatewayServer;
  if (args.stdio) {
    gatewayServer = createGatewayServer(upstreamManager, gatewayOptions);
    await gatewayServer.connect(new StdioServerTransport());
  } else {
    const port = args.port ?? 3000;
    httpServer = await startHttpServer(upstreamManager, port, gatewayOptions);
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
