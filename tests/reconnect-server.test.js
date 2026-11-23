/**
 * Reconnect / post-deploy observability suite (gateway side only).
 *
 * Scope (deliberately narrow):
 *   - This suite measures ONLY what the gateway can observe on the wire:
 *     initialize/tools/list stability, HTTP method semantics, stale
 *     Mcp-Session-Id handling, the 401 auth challenge, and the gateway's own
 *     `unknown tool:` error string.
 *   - It does NOT simulate Gemini's client host, its tool cache, or its
 *     internal `unknown_tool`/`not-found` classification. Those are not
 *     observable from the gateway and are recorded as UNKNOWN, never faked.
 *
 * All traffic is loopback-only or in-process (no external network). src/ is
 * used as-is via createMcpRequestHandler / createGatewayServer / createAppHandler.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createMcpRequestHandler, createGatewayServer } from '../src/server.js';
import { createAppHandler } from '../src/vercel-app.js';

const ACCEPT = 'application/json, text/event-stream';
const STALE_SESSION = '00000000-0000-4000-8000-deadbeefdead'; // looks like a pre-restart session id

// A deterministic fake upstream. Two whitelist tools plus the two gateway
// fallbacks give a stable, non-trivial tool surface.
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

function fakeManager(entries = FAKE_ENTRIES) {
  return {
    getEntries: () => entries,
    getWhitelist: () => entries,
    callTool: async (server, tool, args) => ({
      content: [{ type: 'text', text: JSON.stringify({ ok: true, server, tool, args }) }],
    }),
  };
}

// ---------------------------------------------------------------------------
// loopback harness (binds 127.0.0.1 only; no external network)
// ---------------------------------------------------------------------------

async function startGateway(manager = fakeManager(), options = { mode: 'whitelist' }) {
  const handler = createMcpRequestHandler(manager, options);
  const server = http.createServer((req, res) => { void handler(req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function request(port, { method = 'POST', path = '/mcp', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const finalHeaders = { accept: ACCEPT, host: '127.0.0.1', ...headers };
    let payload;
    if (body !== undefined) {
      payload = typeof body === 'string' ? body : JSON.stringify(body);
      finalHeaders['content-type'] = 'application/json';
      finalHeaders['content-length'] = Buffer.byteLength(payload);
    }
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: finalHeaders }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk.toString(); });
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: raw,
      }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function initializeBody(id = 1) {
  return {
    jsonrpc: '2.0', id, method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'reconnect-suite', version: '1.0.0' },
    },
  };
}

// Extract the JSON-RPC message from a Streamable HTTP SSE body. The gateway
// emits `event: message\ndata: {...}\n\n` for POST /mcp responses.
function rpcMessages(raw) {
  const out = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    try { out.push(JSON.parse(trimmed.slice(5).trim())); } catch { /* ignore non-JSON data lines */ }
  }
  if (out.length === 0) {
    try { out.push(JSON.parse(raw)); } catch { /* leave empty */ }
  }
  return out;
}

function toolsFrom(raw) {
  const messages = rpcMessages(raw);
  const result = messages.find((m) => m.result && Array.isArray(m.result.tools));
  assert.ok(result, `expected a tools/list result, got: ${raw.slice(0, 400)}`);
  return result.result.tools;
}

function toolSnapshot(tools) {
  // Stable digest over name + order + description + inputSchema. This is the
  // exact contract a Gemini host ingests at registration time.
  const canonical = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
  return {
    names: tools.map((tool) => tool.name),
    count: tools.length,
    schemaHash: createHash('sha256').update(JSON.stringify(canonical)).digest('hex'),
  };
}

// ---------------------------------------------------------------------------
// 1. New session: initialize + tools/list are stable
// ---------------------------------------------------------------------------

test('1. new session: initialize issues a UUID session id and tools/list returns the full surface', async () => {
  const gw = await startGateway();
  try {
    const init = await request(gw.port, { body: initializeBody() });
    assert.equal(init.status, 200, `initialize must be 200, got ${init.status}: ${init.body.slice(0, 300)}`);
    const session = String(init.headers['mcp-session-id'] ?? '');
    assert.match(session, /^[0-9a-f-]{36}$/, 'initialize must issue a UUID Mcp-Session-Id');

    const list = await request(gw.port, {
      body: { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      headers: { 'mcp-session-id': session },
    });
    assert.equal(list.status, 200);
    const snap = toolSnapshot(toolsFrom(list.body));
    assert.deepEqual(snap.names, [
      'github__get_file', 'notion__search', 'gateway_call', 'gateway_search',
    ], 'whitelist tools sorted, then fallbacks — no entries missing');
    assert.equal(snap.count, 4);
  } finally {
    await gw.close();
  }
});

test('1b. two independent handler instances (simulated restart) advertise an identical snapshot', async () => {
  const first = await startGateway();
  const second = await startGateway(); // fresh manager + fresh server = post-restart process
  try {
    const snapFor = async (gw) => {
      const init = await request(gw.port, { body: initializeBody() });
      assert.equal(init.status, 200);
      const list = await request(gw.port, {
        body: { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        headers: { 'mcp-session-id': String(init.headers['mcp-session-id']) },
      });
      return toolSnapshot(toolsFrom(list.body));
    };
    const a = await snapFor(first);
    const b = await snapFor(second);
    assert.deepEqual(a, b, 'a new process must not change names, order, or schema hash');
  } finally {
    await first.close();
    await second.close();
  }
});

// ---------------------------------------------------------------------------
// 2. Old / unknown Mcp-Session-Id (pre-restart correlation key)
// ---------------------------------------------------------------------------

test('2. stale Mcp-Session-Id never yields a half tool table and never fabricates unknown_tool', async () => {
  const gw = await startGateway();
  try {
    const full = toolSnapshot(toolsFrom((await request(gw.port, {
      body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    })).body));

    for (const session of [STALE_SESSION, 'not-a-uuid', '  ']) {
      const res = await request(gw.port, {
        body: { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        headers: { 'mcp-session-id': session },
      });
      // OBSERVATION (not a prescription): this gateway is stateless, so a
      // stale/unknown id is accepted (200) with the FULL tool surface. 400/404
      // are the other spec-allowed outcomes; all three are acceptable here.
      // What is NOT acceptable is a partial list or a gateway-originated
      // unknown_tool/not-found error on tools/list.
      assert.ok([200, 400, 404].includes(res.status), `unexpected status ${res.status} for stale session`);
      if (res.status === 200) {
        assert.deepEqual(toolSnapshot(toolsFrom(res.body)), full,
          `stale session ${JSON.stringify(session)} must not return a truncated tool table`);
      }
      assert.doesNotMatch(res.body, /unknown[_ ]tool|not[- ]found/i,
        'tools/list must never report unknown_tool/not-found — that is a client-cache symptom');
    }

    // A tools/call using the stale correlation key still executes against the
    // current tool surface; the gateway does not invent a missing-tool error.
    const call = await request(gw.port, {
      body: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'github__get_file', arguments: { path: 'README.md' } } },
      headers: { 'mcp-session-id': STALE_SESSION },
    });
    assert.equal(call.status, 200);
    const messages = rpcMessages(call.body);
    const result = messages.find((m) => m.result && Array.isArray(m.result.content));
    assert.ok(result, 'known tool must remain callable with a stale session key');
    assert.equal(result.result.isError, undefined, 'known tool must not be flagged as an error');
  } finally {
    await gw.close();
  }
});

// ---------------------------------------------------------------------------
// 3. HTTP method / body semantics
// ---------------------------------------------------------------------------

test('3. GET /mcp = 405, DELETE /mcp = 204, other methods = 405, non-/mcp = 404', async () => {
  const gw = await startGateway();
  try {
    const get = await request(gw.port, { method: 'GET' });
    assert.equal(get.status, 405);
    assert.equal(String(get.headers.allow ?? ''), 'POST, DELETE');

    const del = await request(gw.port, { method: 'DELETE' });
    assert.equal(del.status, 204);
    assert.equal(del.body, '', 'DELETE must have an empty body');

    const put = await request(gw.port, { method: 'PUT' });
    assert.equal(put.status, 405);
    assert.equal(String(put.headers.allow ?? ''), 'GET, POST, DELETE');

    const other = await request(gw.port, { path: '/not-mcp', body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
    assert.equal(other.status, 404);
    assert.match(other.body, /MCP endpoint is \/mcp/);
  } finally {
    await gw.close();
  }
});

test('3b. POST /mcp without a session header is valid and stateless; initialize without one issues an id', async () => {
  const gw = await startGateway();
  try {
    // tools/list without any session header: still the complete tool list.
    const list = await request(gw.port, { body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
    assert.equal(list.status, 200);
    assert.equal(toolSnapshot(toolsFrom(list.body)).count, 4);
    assert.equal(list.headers['mcp-session-id'], undefined,
      'non-initialize POST must not mint a session id');

    // initialize without a header: server mints one.
    const init = await request(gw.port, { body: initializeBody(2) });
    assert.equal(init.status, 200);
    assert.match(String(init.headers['mcp-session-id']), /^[0-9a-f-]{36}$/);

    // initialize WITH a client-provided header: it is echoed as correlation
    // key, but the server does not mint a second UUID.
    const withSession = await request(gw.port, {
      body: initializeBody(3),
      headers: { 'mcp-session-id': 'client-provided-123' },
    });
    assert.equal(withSession.status, 200);
    assert.equal(withSession.headers['mcp-session-id'], undefined,
      'server must not overwrite a client-provided correlation key');

    // No JSON body at all: the SDK rejects it before the gateway handler runs.
    const empty = await request(gw.port, { method: 'POST' });
    assert.ok([400, 415].includes(empty.status),
      `bodyless POST must be rejected, got ${empty.status}`);
  } finally {
    await gw.close();
  }
});

// ---------------------------------------------------------------------------
// 4. tools/list snapshot is byte-stable across three calls
// ---------------------------------------------------------------------------

test('4. three tools/list calls produce identical name order, count, and schema hash', async () => {
  const gateway = createGatewayServer(fakeManager(), { mode: 'whitelist' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await gateway.connect(serverTransport);
  const client = new Client({ name: 'reconnect-snapshot', version: '1' });
  await client.connect(clientTransport);
  try {
    const snapshots = [];
    for (let i = 0; i < 3; i++) snapshots.push(toolSnapshot((await client.listTools()).tools));
    assert.deepEqual(snapshots[0], snapshots[1], 'call 1 === call 2');
    assert.deepEqual(snapshots[1], snapshots[2], 'call 2 === call 3');
    assert.equal(snapshots[0].schemaHash.length, 64, 'sha256 hex digest');
    assert.deepEqual(snapshots[0].names, [
      'github__get_file', 'notion__search', 'gateway_call', 'gateway_search',
    ]);
  } finally {
    await client.close();
    await gateway.close();
  }
});

// ---------------------------------------------------------------------------
// 5. 401 auth challenge carries _meta["mcp/www_authenticate"]
// ---------------------------------------------------------------------------

function makeRes() {
  return {
    statusCode: 200, headers: {}, headersSent: false, ended: false, body: '',
    writeHead(status, headers = {}) {
      this.statusCode = status;
      for (const [key, value] of Object.entries(headers)) this.headers[key.toLowerCase()] = value;
      this.headersSent = true;
      return this;
    },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) this.body += chunk.toString();
      this.ended = true;
      return this;
    },
    getHeader(key) { return this.headers[key.toLowerCase()]; },
  };
}

function makeReq({ method = 'POST', url = '/', headers = {}, body } = {}) {
  const raw = body === undefined || body === null
    ? ''
    : (typeof body === 'string' ? body : JSON.stringify(body));
  const chunks = raw ? [Buffer.from(raw, 'utf8')] : [];
  return {
    method,
    url,
    headers: { host: 'gateway.example', ...headers },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

test('5. unauthenticated /mcp returns 401 with WWW-Authenticate header and mcp/www_authenticate _meta', async () => {
  const issuer = 'https://gateway.example';
  const app = createAppHandler({
    store: {
      async getToken() { return null; }, // invalid bearer -> unauthorized
      async saveClient() {}, async getClient() { return null; },
      async saveCode() {}, async takeCode() { return null; },
      async saveToken() {}, async getTokenRecord() { return null; },
    },
    baseUrl: issuer,
    mcpHandler: async () => { throw new Error('must not reach MCP handler'); },
  });

  for (const headers of [{}, { authorization: 'Bearer invalid-token' }]) {
    const res = makeRes();
    await app(makeReq({
      method: 'POST', url: '/mcp',
      headers: { 'content-type': 'application/json', ...headers },
      body: { jsonrpc: '2.0', method: 'tools/list', id: 1 },
    }), res);

    assert.equal(res.statusCode, 401);
    assert.equal(
      res.getHeader('www-authenticate'),
      `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource"`,
    );
    const body = JSON.parse(res.body);
    assert.ok(body.error === 'invalid_request' || body.error === 'invalid_token');
    const challenges = body._meta?.['mcp/www_authenticate'];
    assert.ok(Array.isArray(challenges) && challenges.length === 1,
      '401 body must carry exactly one mcp/www_authenticate challenge');
    assert.match(challenges[0], /resource_metadata=/);
    assert.match(challenges[0], /error=/);
    assert.match(challenges[0], /error_description=/);
  }
});

// ---------------------------------------------------------------------------
// 6. Honest unknown-tool accounting (client-side staleness is UNKNOWN here)
// ---------------------------------------------------------------------------

test('6. gateway reports an unknown tool name verbatim as an error; it does not fake success or hide it', async () => {
  const gateway = createGatewayServer(fakeManager(), { mode: 'whitelist' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await gateway.connect(serverTransport);
  const client = new Client({ name: 'reconnect-unknown', version: '1' });
  await client.connect(clientTransport);
  try {
    const advertised = (await client.listTools()).tools.map((tool) => tool.name);
    // A deliberately stale name of the kind a cached host would keep sending.
    const staleName = 'github__tool_removed_after_release';
    assert.equal(advertised.includes(staleName), false, 'the stale name is not on the current surface');

    const response = await client.callTool({ name: staleName, arguments: {} });
    assert.equal(response.isError, true, 'unknown tool must be an error, not a silent success');
    const text = response.content.map((block) => block.text ?? '').join('\n');
    assert.match(text, /unknown tool:/i);
    assert.ok(text.includes(staleName), 'the exact stale name must be echoed for correlation');

    // Control: an advertised tool still works, so the unknown above is
    // genuinely a name the client supplied, not a gateway-side outage.
    const ok = await client.callTool({ name: 'github__get_file', arguments: { path: 'README.md' } });
    assert.notEqual(ok.isError, true);
    assert.match(ok.content[0].text, /ok.*true/, 'advertised tool result must not be an error payload');
  } finally {
    await client.close();
    await gateway.close();
  }
});

test('6b. observability boundary: unobservable client classifications are recorded as unknown', async () => {
  // This is a *documentation-as-test* assertion: the gateway's only evidence
  // for the reported production `unknown_tool` / `not-found` is the error
  // string above. Internal Gemini classification is outside this process and
  // MUST NOT be synthesized. If someone later adds a fabricated metric or
  // "auto-healed" flag, this test documents that it is not part of this suite.
  const OBSERVABLE = Object.freeze({
    wireError: 'unknown tool: <name>',
    clientInternalClassification: 'unknown',
    recoveredAutomatically: 'unknown',
  });
  assert.equal(OBSERVABLE.clientInternalClassification, 'unknown');
  assert.equal(OBSERVABLE.recoveredAutomatically, 'unknown');
  assert.equal(OBSERVABLE.wireError, 'unknown tool: <name>');
});
