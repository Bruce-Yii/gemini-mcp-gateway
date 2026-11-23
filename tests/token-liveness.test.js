/**
 * Regression tests for the "该刷没刷" Linear incident (2026-11-21 invalid_token):
 * a token the local KV considered fresh was already dead, and the gateway had
 * no provider-failure feedback loop. These tests pin the three根因 fixes:
 *   1. provider 401/invalid_token -> exactly one forced refresh + one reconnect
 *   2. invalid_grant -> never retried (no grant burning)
 *   3. expiry comes from the real authorization time, never Date.now()+expiresIn
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { UpstreamAuth } from '../src/upstream-auth.js';
import { UpstreamManager } from '../src/upstreams.js';

const ENV = {
  tokenEnv: 'TL_LINEAR_TOKEN',
  refreshEnv: 'TL_LINEAR_REFRESH',
  clientIdEnv: 'TL_LINEAR_CLIENT_ID',
  expiresInEnv: 'TL_LINEAR_EXPIRES_IN',
  obtainedAtEnv: 'TL_LINEAR_OBTAINED_AT',
};
const KEY = 'gmcgw:v2:grant:local:gateway:linear';

function setEnv(token = 'STALE_AT', refresh = 'RT_0') {
  process.env[ENV.tokenEnv] = token;
  process.env[ENV.refreshEnv] = refresh;
  process.env[ENV.clientIdEnv] = 'CID';
  process.env[ENV.expiresInEnv] = '86400';
  delete process.env[ENV.obtainedAtEnv];
}
function clearEnv() {
  for (const key of Object.values(ENV)) delete process.env[key];
}
function linearConfig() {
  return {
    name: 'linear',
    transport: 'http',
    url: 'https://example.invalid/mcp',
    tokenEnv: ENV.tokenEnv,
    refreshEnv: ENV.refreshEnv,
    clientIdEnv: ENV.clientIdEnv,
    expiresInEnv: ENV.expiresInEnv,
    obtainedAtEnv: ENV.obtainedAtEnv,
    allowTools: [],
    denyTools: [],
    grantOwner: 'gateway',
    grantSource: 'gateway-oauth',
  };
}

/** In-memory KV with real NX/DEL/CAS semantics (needed by the refresh lock). */
function fakeStore() {
  const data = new Map();
  return {
    isConfigured: () => true,
    _data: data,
    _command: async (...args) => {
      const [cmd, key, value, ...rest] = args;
      if (cmd === 'get') return data.get(key) ?? null;
      if (cmd === 'set') {
        if (rest.includes('NX') && data.has(key)) return null;
        data.set(key, value);
        return 'OK';
      }
      if (cmd === 'del') { data.delete(key); return 1; }
      return null;
    },
    casToken: async (key, expectedRefresh, nextJson) => {
      const cur = data.get(key);
      if (!cur) return false;
      if (String(JSON.parse(cur).refresh_token) !== String(expectedRefresh)) return false;
      data.set(key, nextJson);
      return true;
    },
  };
}

/** Seed the exact poisoned state from the incident: KV says "fresh", token is dead. */
function seedStaleButFresh(store) {
  store._data.set(KEY, JSON.stringify({
    access_token: 'STALE_AT',
    refresh_token: 'RT_0',
    client_id: 'CID',
    expires_at: Date.now() + 60 * 60 * 1000, // fabricated future deadline
    envSeed: 'STALE_AT',                     // stops env bootstrap from rebuilding
    bootstrapped: false,
    owner: 'gateway', source: 'gateway-oauth', environment: 'local',
  }));
}

const INVALID_TOKEN = new Error(
  'Streamable HTTP error: Error POSTing to endpoint: {"error":"invalid_token","error_description":"Invalid access token"}',
);
const STATUS_401 = Object.assign(new Error('Unauthorized'), { status: 401 });

/** Fake MCP clients: each `step` controls connect/listTools behaviour. */
function fakeClients(steps) {
  const clients = [];
  let n = 0;
  return {
    factory: () => {
      const step = steps[Math.min(n++, steps.length - 1)];
      const client = {
        step,
        transport: null,
        closed: false,
        async connect(transport) {
          this.transport = transport;
          if (step.connectError) throw step.connectError;
        },
        async listTools() {
          if (step.listError) throw step.listError;
          return { tools: step.tools ?? [] };
        },
        async close() { this.closed = true; },
      };
      clients.push(client);
      return client;
    },
    clients,
    get count() { return n; },
  };
}

function bearerOf(client) {
  const headers = client.transport?._requestInit?.headers ?? client.transport?.requestInit?.headers;
  return headers?.Authorization ?? headers?.get?.('Authorization');
}

function successfulAuth(store) {
  let refreshCalls = 0;
  const auth = new UpstreamAuth({
    store,
    fetch: async (_url, opts) => {
      const raw = String(opts?.body ?? '');
      if (raw.includes('grant_type=refresh_token')) {
        refreshCalls++;
        return {
          ok: true,
          json: async () => ({ access_token: 'FRESH_AT', refresh_token: 'RT_1', expires_in: 86400 }),
        };
      }
      return { ok: false };
    },
  });
  return { auth, count: () => refreshCalls };
}

test('provider 401 on connect forces exactly one refresh, then reconnects with the fresh token', async () => {
  setEnv();
  const store = fakeStore();
  seedStaleButFresh(store);
  const { auth, count } = successfulAuth(store);
  const clients = fakeClients([
    { connectError: INVALID_TOKEN },
    { tools: [{ name: 'list_issues', description: 'd', inputSchema: { type: 'object' } }] },
  ]);
  const mgr = new UpstreamManager([linearConfig()], { auth, clientFactory: clients.factory });

  await mgr.connect();

  assert.equal(count(), 1, '401 must trigger exactly one forced refresh');
  assert.equal(clients.count, 2, 'one failed connect + one reconnect, no more');
  assert.equal(clients.clients[0].closed, true, 'half-open client from the failed attempt must be closed');
  assert.deepEqual(mgr.failedServers, []);
  assert.deepEqual(mgr.getEntries().map((e) => e.name), ['linear__list_issues']);
  assert.equal(bearerOf(clients.clients[0]), 'Bearer STALE_AT');
  assert.equal(bearerOf(clients.clients[1]), 'Bearer FRESH_AT', 'reconnect must use the refreshed token');
  await mgr.close();
  clearEnv();
});

test('provider 401 on listTools also forces a refresh and reconnect', async () => {
  setEnv();
  const store = fakeStore();
  seedStaleButFresh(store);
  const { auth, count } = successfulAuth(store);
  const clients = fakeClients([
    { listError: STATUS_401 },
    { tools: [{ name: 'get_issue' }] },
  ]);
  const mgr = new UpstreamManager([linearConfig()], { auth, clientFactory: clients.factory });

  await mgr.connect();

  assert.equal(count(), 1);
  assert.equal(clients.count, 2);
  assert.deepEqual(mgr.failedServers, []);
  assert.deepEqual(mgr.getEntries().map((e) => e.name), ['linear__get_issue']);
  await mgr.close();
  clearEnv();
});

test('invalid_grant is never retried — no grant burning, even across another connect', async () => {
  setEnv();
  const store = fakeStore();
  seedStaleButFresh(store);
  let refreshCalls = 0;
  const auth = new UpstreamAuth({
    store,
    fetch: async (_url, opts) => {
      if (String(opts?.body ?? '').includes('grant_type=refresh_token')) {
        refreshCalls++;
        return { ok: false, json: async () => ({ error: 'invalid_grant', error_description: 'grant revoked' }) };
      }
      return { ok: false };
    },
  });
  const clients = fakeClients([{ connectError: INVALID_TOKEN }]); // always 401
  const mgr = new UpstreamManager([linearConfig()], { auth, clientFactory: clients.factory });

  await mgr.connect();
  assert.equal(refreshCalls, 1, 'one forced refresh attempt only');
  assert.equal(clients.count, 2, 'one reconnect only');
  assert.deepEqual(mgr.failedServers, ['linear']);
  assert.equal(mgr.getEntries().length, 0);
  assert.equal(JSON.parse(store._data.get(KEY)).needsReauth, true, 'dead grant must be flagged');

  // A second connect cycle must still not consume the grant again.
  await mgr.connect();
  assert.equal(refreshCalls, 1, 'needsReauth backoff survives across connect cycles');
  clearEnv();
});

test('only one retry: a second 401 fails the server without a third attempt', async () => {
  setEnv();
  const store = fakeStore();
  seedStaleButFresh(store);
  const { auth, count } = successfulAuth(store);
  const clients = fakeClients([{ connectError: INVALID_TOKEN }]); // both attempts 401
  const mgr = new UpstreamManager([linearConfig()], { auth, clientFactory: clients.factory });

  await mgr.connect();

  assert.equal(count(), 1, 'no second refresh after the reconnect also fails');
  assert.equal(clients.count, 2, 'exactly two connect attempts, then give up');
  assert.deepEqual(mgr.failedServers, ['linear']);
  assert.equal(mgr.getEntries().length, 0);
  clearEnv();
});

test('a non-auth connect failure never triggers a refresh', async () => {
  setEnv();
  const store = fakeStore();
  seedStaleButFresh(store);
  const { auth, count } = successfulAuth(store);
  const clients = fakeClients([{ connectError: new Error('ECONNRESET') }]);
  const mgr = new UpstreamManager([linearConfig()], { auth, clientFactory: clients.factory });

  await mgr.connect();

  assert.equal(count(), 0, 'generic failures must not burn the refresh token');
  assert.equal(clients.count, 1, 'no reconnect for a non-auth failure');
  assert.deepEqual(mgr.failedServers, ['linear']);
  clearEnv();
});

test('expires_at uses real obtained_at, never Date.now()+expiresIn', async () => {
  const obtainedAt = Date.now() - 10 * 60 * 60 * 1000; // authorized 10h ago
  const store = fakeStore();
  // Failing refresh keeps the bootstrap record intact so we can inspect it.
  const auth = new UpstreamAuth({ store, fetch: async () => { throw new Error('offline'); } });

  await auth.getAccessToken('linear', {
    envToken: 'AT', envRefresh: 'RT', envClientId: 'CID',
    envExpiresIn: 3600, envObtainedAt: obtainedAt,
    grantOwner: 'gateway', source: 'gateway-oauth',
  });
  let rec = JSON.parse(store._data.get(KEY));
  assert.equal(rec.expires_at, obtainedAt + 3600 * 1000, 'must be derived from the real issuance time');
  assert.ok(rec.expires_at < Date.now(), 'an old token must not be dressed up as fresh');
});

test('missing obtained_at stores expires_at=0 instead of a fabricated future deadline', async () => {
  const store = fakeStore();
  const auth = new UpstreamAuth({ store, fetch: async () => { throw new Error('offline'); } });
  const before = Date.now();

  await auth.getAccessToken('linear', {
    envToken: 'AT', envRefresh: 'RT', envClientId: 'CID', envExpiresIn: 3600,
    grantOwner: 'gateway', source: 'gateway-oauth',
  });
  const rec = JSON.parse(store._data.get(KEY));
  assert.equal(rec.expires_at, 0, 'unknown issuance time must not become now+expiresIn');
  assert.ok(!(rec.expires_at > before), 'no fake future expiry');
});

test('seed() honours obtainedAt and never fabricates a future expiry', async () => {
  const obtainedAt = Date.now() - 26 * 60 * 60 * 1000;
  const store = fakeStore();
  const auth = new UpstreamAuth({ store });

  await auth.seed('linear', {
    accessToken: 'a', refreshToken: 'r', clientId: 'c',
    expiresIn: 86400, obtainedAt, grantOwner: 'gateway', source: 'gateway-oauth',
  });
  assert.equal(JSON.parse(store._data.get(KEY)).expires_at, obtainedAt + 86400 * 1000);

  await auth.seed('linear', {
    accessToken: 'a', refreshToken: 'r', clientId: 'c', expiresIn: 86400,
    grantOwner: 'gateway', source: 'gateway-oauth',
  });
  assert.equal(JSON.parse(store._data.get(KEY)).expires_at, 0, 'no obtainedAt -> unknown, not now+expiresIn');
});

test('obtainedAtEnv is declared for linear and forwarded into getAccessToken', async () => {
  const config = JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));
  const linear = config.servers.find((s) => s.name === 'linear');
  assert.equal(linear.obtainedAtEnv, 'LINEAR_OBTAINED_AT');

  setEnv();
  process.env[ENV.obtainedAtEnv] = '1700000000000';
  let seen;
  const auth = {
    getAccessToken: async (server, env) => { seen = { server, env }; return 'AT'; },
  };
  const mgr = new UpstreamManager([linearConfig()], { auth });
  await mgr._resolveToken(mgr.configs[0]);
  assert.equal(seen.server, 'linear');
  assert.equal(seen.env.envObtainedAt, 1700000000000);
  clearEnv();
});
