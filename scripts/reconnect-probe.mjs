#!/usr/bin/env node
/**
 * Offline reconnect / post-deploy observability probe.
 *
 * Produces a repeatable JSON evidence record for the six gateway-side
 * observations covered by tests/reconnect-server.test.js. It:
 *
 *   - binds a loopback-only (127.0.0.1) in-process HTTP server using the real
 *     `createMcpRequestHandler` / `createAppHandler` from src/ — no external
 *     network, no upstream credentials, no Gemini host simulation;
 *   - accepts an INJECTABLE fetch implementation via `runProbe({ fetchImpl })`
 *     so CI can point it at a different loopback endpoint without editing code;
 *   - enforces loopback-only URLs when --base-url is supplied (external
 *     hosts are rejected; this script never calls the internet).
 *
 * Usage:
 *   node scripts/reconnect-probe.mjs                       # own loopback server
 *   node scripts/reconnect-probe.mjs --base-url http://127.0.0.1:3000
 *
 * Library use (fetch injection):
 *   import { runProbe, startProbeServer } from './scripts/reconnect-probe.mjs';
 *   const s = await startProbeServer();
 *   try {
 *     const report = await runProbe({ fetchImpl: myFetch, baseUrl: s.baseUrl });
 *   } finally { await s.close(); }
 *
 * Exit code is 0 when all six observations are collected; 1 otherwise.
 * This script writes no files and never modifies src/.
 */
import http from 'node:http';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMcpRequestHandler } from '../src/server.js';
import { createAppHandler } from '../src/vercel-app.js';

const ACCEPT = 'application/json, text/event-stream';
const STALE_SESSION = '00000000-0000-4000-8000-deadbeefdead';

const FAKE_ENTRIES = [
  {
    server: 'github', tool: 'get_file', name: 'github__get_file',
    description: 'Read a file.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    server: 'notion', tool: 'search', name: 'notion__search',
    description: 'Search pages.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
];

function fakeManager() {
  return {
    getEntries: () => FAKE_ENTRIES,
    getWhitelist: () => FAKE_ENTRIES,
    callTool: async (server, tool, args) => ({
      content: [{ type: 'text', text: JSON.stringify({ ok: true, server, tool, args }) }],
    }),
  };
}

const fakeStore = {
  async getToken() { return null; },
  async saveClient() {}, async getClient() { return null; },
  async saveCode() {}, async takeCode() { return null; },
  async saveToken() {}, async getTokenRecord() { return null; },
};

/** Assert a URL is loopback-only. Throws for any external host. */
export function assertLoopbackUrl(value) {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  const allowed = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
  if (!allowed.has(host)) {
    throw new Error(`refusing non-loopback URL ${url.origin}: this probe is offline-only`);
  }
  return url;
}

/** Start a loopback-only server wired to the real gateway + app handlers. */
export async function startProbeServer() {
  const mcpHandler = createMcpRequestHandler(fakeManager(), { mode: 'whitelist' });
  const appHandler = createAppHandler({
    store: fakeStore,
    baseUrl: 'https://gateway.example',
    mcpHandler,
  });
  // Route /mcp through the auth-aware app handler (so the 401 check runs the
  // real `unauthorized()` code), and expose the raw handler at /mcp-raw for
  // protocol checks that do not need a bearer token.
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (pathname === '/mcp-raw') {
      req.url = '/mcp';
      void mcpHandler(req, res);
      return;
    }
    void appHandler(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function parseArgs(argv) {
  let baseUrl;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--base-url') baseUrl = argv[++i];
    else if (argv[i].startsWith('--base-url=')) baseUrl = argv[i].slice('--base-url='.length);
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (baseUrl) assertLoopbackUrl(baseUrl);
  return { baseUrl };
}

function initBody(id = 1) {
  return {
    jsonrpc: '2.0', id, method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'reconnect-probe', version: '1.0.0' },
    },
  };
}

function rpcMessages(raw) {
  const out = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    try { out.push(JSON.parse(trimmed.slice(5).trim())); } catch { /* ignore */ }
  }
  if (out.length === 0) {
    try { out.push(JSON.parse(raw)); } catch { /* ignore */ }
  }
  return out;
}

function toolsFrom(raw) {
  const msg = rpcMessages(raw).find((m) => m.result && Array.isArray(m.result.tools));
  return msg?.result?.tools ?? null;
}

function snapshot(tools) {
  if (!tools) return null;
  const canonical = tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  return {
    names: tools.map((tool) => tool.name),
    count: tools.length,
    schemaHash: createHash('sha256').update(JSON.stringify(canonical)).digest('hex'),
  };
}

/**
 * Run all six observations. `fetchImpl` is injectable: any function with the
 * global fetch signature works. Defaults to globalThis.fetch.
 */
export async function runProbe({ fetchImpl = globalThis.fetch, baseUrl = 'http://127.0.0.1:3000' } = {}) {
  assertLoopbackUrl(baseUrl);
  const root = baseUrl.replace(/\/$/, '');
  const call = async (path, { method = 'POST', headers = {}, body } = {}) => {
    const finalHeaders = { accept: ACCEPT, ...headers };
    let payload;
    if (body !== undefined) {
      payload = typeof body === 'string' ? body : JSON.stringify(body);
      finalHeaders['content-type'] = 'application/json';
    }
    const response = await fetchImpl(`${root}${path}`, {
      method,
      headers: finalHeaders,
      ...(payload !== undefined ? { body: payload } : {}),
    });
    const text = await response.text();
    return {
      status: response.status,
      sessionHeader: response.headers.get('mcp-session-id') ?? null,
      wwwAuthenticate: response.headers.get('www-authenticate') ?? null,
      body: text,
    };
  };

  const report = {
    generatedAt: new Date().toISOString(),
    target: root,
    offline: true,
    observations: {},
  };

  // 1. new session initialize + tools/list
  const init = await call('/mcp-raw', { body: initBody() });
  const session = init.sessionHeader;
  const list = await call('/mcp-raw', {
    body: { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    headers: session ? { 'mcp-session-id': session } : {},
  });
  report.observations.newSession = {
    initializeStatus: init.status,
    issuedSessionId: typeof session === 'string' && /^[0-9a-f-]{36}$/.test(session) ? 'uuid' : session,
    toolsListStatus: list.status,
    snapshot: snapshot(toolsFrom(list.body)),
  };

  // 2. stale session id — record the actual status, never a faked 404
  const stale = await call('/mcp-raw', {
    body: { jsonrpc: '2.0', id: 3, method: 'tools/list' },
    headers: { 'mcp-session-id': STALE_SESSION },
  });
  report.observations.staleSession = {
    statusAllowed: [200, 400, 404].includes(stale.status),
    status: stale.status,
    fullTable: stale.status === 200
      ? JSON.stringify(snapshot(toolsFrom(stale.body))) === JSON.stringify(report.observations.newSession.snapshot)
      : null,
    gatewayReportedUnknownTool: /unknown[_ ]tool|not[- ]found/i.test(stale.body),
  };

  // 3. HTTP method semantics
  const get = await call('/mcp-raw', { method: 'GET' });
  const del = await call('/mcp-raw', { method: 'DELETE' });
  const postNoSession = await call('/mcp-raw', { body: { jsonrpc: '2.0', id: 4, method: 'tools/list' } });
  report.observations.httpSemantics = {
    get: { status: get.status, allow: get.status === 405 ? 'POST, DELETE' : null },
    delete: { status: del.status },
    postWithoutSession: {
      status: postNoSession.status,
      snapshot: snapshot(toolsFrom(postNoSession.body)),
    },
  };

  // 4. three-call snapshot determinism
  const snaps = [];
  for (let i = 0; i < 3; i++) {
    const res = await call('/mcp-raw', { body: { jsonrpc: '2.0', id: 10 + i, method: 'tools/list' } });
    snaps.push(snapshot(toolsFrom(res.body)));
  }
  report.observations.snapshotDeterminism = {
    identical: snaps.every((s) => JSON.stringify(s) === JSON.stringify(snaps[0])),
    schemaHash: snaps[0]?.schemaHash ?? null,
    calls: snaps.length,
  };

  // 5. 401 auth challenge (through the app handler, no bearer token)
  const unauth = await call('/mcp', { body: { jsonrpc: '2.0', id: 20, method: 'tools/list' } });
  let unauthBody = null;
  try { unauthBody = JSON.parse(unauth.body); } catch { /* leave null */ }
  const challenges = unauthBody?._meta?.['mcp/www_authenticate'];
  report.observations.authChallenge = {
    status: unauth.status,
    wwwAuthenticateHeader: unauth.wwwAuthenticate,
    metaChallengeCount: Array.isArray(challenges) ? challenges.length : 0,
    metaChallengeHasError: Array.isArray(challenges) && challenges.length > 0
      ? /error=/.test(challenges[0]) && /error_description=/.test(challenges[0])
      : false,
  };

  // 6. unknown tool is reported verbatim; client-internal classification is UNKNOWN
  const unknownName = 'github__tool_removed_after_release';
  const unknownCall = await call('/mcp-raw', {
    body: { jsonrpc: '2.0', id: 30, method: 'tools/call', params: { name: unknownName, arguments: {} } },
  });
  const unknownMsg = rpcMessages(unknownCall.body).find((m) => m.result && m.result.content);
  const unknownText = (unknownMsg?.result?.content ?? []).map((b) => b.text ?? '').join('\n');
  report.observations.unknownTool = {
    status: unknownCall.status,
    isError: unknownMsg?.result?.isError ?? null,
    echoesName: unknownText.includes(unknownName),
    messageShape: /unknown tool:/i.test(unknownText) ? 'unknown tool: <name>' : null,
    clientInternalClassification: 'unknown', // NOT observable from the gateway
    autoRecovered: 'unknown',                // NOT observable from the gateway
  };

  report.ok = Object.values(report.observations).every((o) => {
    if (o.statusAllowed !== undefined) return o.statusAllowed;
    if (o.initializeStatus !== undefined) return o.initializeStatus === 200 && o.toolsListStatus === 200 && o.snapshot?.count === 4;
    if (o.get !== undefined) return o.get.status === 405 && o.delete.status === 204;
    if (o.identical !== undefined) return o.identical === true;
    if (o.metaChallengeCount !== undefined) return o.status === 401 && o.metaChallengeCount === 1 && o.metaChallengeHasError;
    if (o.isError !== undefined) return o.isError === true && o.echoesName && o.messageShape !== null;
    return false;
  });
  return report;
}

async function main() {
  const { baseUrl } = parseArgs(process.argv.slice(2));
  let server;
  let target = baseUrl;
  if (!target) {
    server = await startProbeServer();
    target = server.baseUrl;
  }
  const originalLog = console.log;
  try {
    // Keep stdout pure JSON: the handlers log [capture_skipped]/[req] lines to
    // console.log, which would otherwise break consumers piping into a parser.
    console.log = (...args) => process.stderr.write(args.map(String).join(' ') + '\n');
    const report = await runProbe({ fetchImpl: globalThis.fetch, baseUrl: target });
    originalLog(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  } finally {
    console.log = originalLog;
    if (server) await server.close();
  }
}

// Run the CLI only when invoked directly (not when imported for fetch injection).
const invokedDirectly = (() => {
  try {
    return Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch { return false; }
})();
if (invokedDirectly) await main();
