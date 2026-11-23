/**
 * Batch 15 · provider DCR (Notion) + CIMD (Vercel).
 *
 * Deterministic, zero-network regressions. Every fetch/store is a local fake:
 * no provider call, no real credential, no deployment. The tests pin the
 * gateway-owned client identity contract:
 *   - Notion: register once via POST /register, persist to the v2 client
 *     namespace (never the legacy v1 hash key), reuse on repeated start.
 *   - DCR/CIMD client_id flows through OAuth state, so callback and refresh
 *     never depend on env or re-registration (which would orphan grants).
 *   - Vercel: authorize includes openid + offline_access + RFC 8707 resource;
 *     CIMD document is public, has the right shape, and client_id == URL.
 * No secret value is ever printed by the code under test (capture is stubbed
 * by using raw fake stores; stdout assertions check no token/client_secret).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createUpstreamOAuthHandlers, PROVIDER_ENDPOINTS } from '../src/upstream-oauth.js';
import { validateConfig } from '../src/config.js';
import {
  createAppHandler, CIMD_PATH, cimdClientId, buildCimdDocument,
} from '../src/vercel-app.js';
import { UpstreamAuth } from '../src/upstream-auth.js';

// ── helpers ────────────────────────────────────────────────────────────────

class FakeStore {
  constructor() {
    this.values = new Map();
    this.states = new Map();
    this.commands = [];
  }
  isConfigured() { return true; }
  async saveOAuthState(state, record) { this.states.set(state, record); }
  async takeOAuthState(state) {
    const record = this.states.get(state) ?? null;
    this.states.delete(state);
    return record;
  }
  async _command(...args) {
    this.commands.push(args);
    const [cmd, key, value, ...rest] = args;
    if (cmd === 'set') {
      // UpstreamAuth uses NX/EX for locks; mimic that minimal subset.
      if (rest.includes('NX') && this.values.has(key)) return null;
      this.values.set(key, value);
      return 'OK';
    }
    if (cmd === 'get') return this.values.get(key) ?? null;
    if (cmd === 'del') { this.values.delete(key); return 1; }
    if (cmd === 'getdel') {
      const found = this.values.get(key) ?? null;
      this.values.delete(key);
      return found;
    }
    return null;
  }
}

function mockRes() {
  const state = { status: 0, headers: {}, body: '', headersSent: false, writableEnded: false };
  return {
    get state() { return state; },
    writeHead(status, headers) { state.status = status; Object.assign(state.headers, headers); state.headersSent = true; },
    setHeader(key, value) { state.headers[key] = value; },
    end(body = '') { state.body = body; state.writableEnded = true; },
  };
}

const REQ = { headers: { host: 'gw.example' }, socket: {} };
const OPTIONS = { baseUrl: 'https://gw.example' };
const CLIENT_KEY = 'gmcgw:v2:client:local:notion';
const GRANT_KEY = 'gmcgw:v2:grant:local:gateway:notion';

/** Notion DCR config — no clientIdEnv, registration is gateway-driven. */
const NOTION_SERVER = {
  name: 'notion',
  transport: 'http',
  url: 'https://mcp.notion.com/mcp',
  authorizeUrl: 'https://mcp.notion.com/authorize',
  refreshUrl: 'https://mcp.notion.com/token',
  dcr: true,
  registrationEndpoint: 'https://mcp.notion.com/register',
  resource: 'https://mcp.notion.com/mcp',
};

/** Vercel CIMD config — clientId is a public HTTPS metadata URL. */
const CIMD_URL = 'https://gw.example/.well-known/mcp-client.json';
const VERCEL_SERVER = {
  name: 'vercel',
  transport: 'http',
  url: 'https://mcp.vercel.com/',
  authorizeUrl: 'https://vercel.com/oauth/authorize',
  refreshUrl: 'https://api.vercel.com/login/oauth/token',
  clientId: CIMD_URL,
  resource: 'https://mcp.vercel.com/',
};

function handlers(store, config, fetchImpl, options = OPTIONS) {
  return createUpstreamOAuthHandlers({
    store, getConfig: async () => config, options, fetch: fetchImpl,
  });
}

function jsonResponse(body, ok = true, status = ok ? 200 : 400) {
  return { ok, status, text: async () => JSON.stringify(body), json: async () => body };
}

function startUrl(server, env = 'local') {
  return new URL(`https://gw.example/upstream/oauth/start?server=${server}&env=${env}&key=admin-secret`);
}

async function start(api, store, server = 'notion') {
  const res = mockRes();
  await api.start(REQ, res, startUrl(server));
  const location = res.state.headers.location;
  return { res, state: location ? new URL(location).searchParams.get('state') : null, location };
}

function withAdminKey(fn) {
  process.env.UPSTREAM_OAUTH_ADMIN_KEY = 'admin-secret';
  return Promise.resolve().then(fn).finally(() => { delete process.env.UPSTREAM_OAUTH_ADMIN_KEY; });
}

// ── config validation ──────────────────────────────────────────────────────

test('config: DCR and CIMD keys are known and validated (no unknown warnings)', () => {
  const { config, warnings } = validateConfig({ servers: [NOTION_SERVER, VERCEL_SERVER] }, { env: {} });
  assert.equal(warnings.length, 0);
  assert.equal(config.servers[0].dcr, true);
  assert.equal(config.servers[1].clientId, CIMD_URL);
});

test('config: rejects malformed DCR/CIMD combinations', () => {
  const base = { name: 'notion', transport: 'http', url: 'https://mcp.notion.com/mcp' };
  assert.throws(() => validateConfig({ servers: [{ ...base, dcr: 'yes' }] }, { env: {} }), /dcr must be a boolean/);
  assert.throws(() => validateConfig({ servers: [{ ...base, dcr: true }] }, { env: {} }), /requires registrationEndpoint/);
  assert.throws(() => validateConfig({ servers: [{ ...NOTION_SERVER, clientIdEnv: 'NOTION_CLIENT_ID' }] }, { env: {} }), /must not be combined with clientIdEnv/);
  assert.throws(() => validateConfig({ servers: [{ ...base, clientId: 'not-a-url' }] }, { env: {} }), /clientId must be an absolute https URL/);
  assert.throws(() => validateConfig({ servers: [{ ...VERCEL_SERVER, clientId: 'https://a.example/x', clientIdEnv: 'C' }] }, { env: {} }), /mutually exclusive/);
  assert.throws(() => validateConfig({ servers: [{ ...base, resource: 'nope' }] }, { env: {} }), /resource must be an absolute/);
});

// ── Notion DCR: registration ───────────────────────────────────────────────

test('Notion DCR: start POSTs RFC 7591 registration and persists client to v2 key', async () => {
  await withAdminKey(async () => {
    const store = new FakeStore();
    const calls = [];
    const fakeFetch = async (url, init) => {
      calls.push({ url, init });
      assert.equal(url, 'https://mcp.notion.com/register');
      assert.equal(init.method, 'POST');
      const body = JSON.parse(init.body);
      assert.deepEqual(body.redirect_uris, ['https://gw.example/upstream/oauth/callback?env=local']);
      assert.equal(body.client_name.includes('notion'), true);
      assert.deepEqual(body.grant_types, ['authorization_code', 'refresh_token']);
      assert.deepEqual(body.response_types, ['code']);
      assert.equal(body.token_endpoint_auth_method, 'none');
      assert.equal(body.scope, 'default');
      return jsonResponse({ client_id: 'dcr-public-client', token_endpoint_auth_method: 'none' });
    };
    const api = handlers(store, { servers: [NOTION_SERVER] }, fakeFetch);
    const { res, state, location } = await start(api, store);
    assert.equal(res.state.status, 302);
    assert.equal(calls.length, 1, 'exactly one registration POST');
    assert.equal(new URL(location).searchParams.get('client_id'), 'dcr-public-client');
    assert.equal(new URL(location).searchParams.get('resource'), 'https://mcp.notion.com/mcp');
    assert.equal(new URL(location).searchParams.get('scope'), 'default');

    const stored = JSON.parse(store.values.get(CLIENT_KEY));
    assert.equal(stored.client_id, 'dcr-public-client');
    assert.equal(stored.client_secret, undefined, 'public client has no secret');
    assert.equal(stored.token_endpoint_auth_method, 'none');
    assert.equal(stored.registration_environment, 'local');
    // State carries the client id; callback must not fall back to env.
    assert.equal(store.states.get(state).clientId, 'dcr-public-client');
    assert.equal(store.states.get(state).clientKind, 'dcr');
    // Never touch the legacy v1 client hash namespace.
    assert.equal([...store.values.keys()].some((k) => k.startsWith('gmcgw:v1:')), false);
  });
});

test('Notion DCR: repeated start reuses persisted client and never re-registers', async () => {
  await withAdminKey(async () => {
    const store = new FakeStore();
    let registrations = 0;
    const fakeFetch = async (url) => {
      registrations += 1;
      assert.equal(url, 'https://mcp.notion.com/register');
      return jsonResponse({ client_id: `client-${registrations}` });
    };
    const api = handlers(store, { servers: [NOTION_SERVER] }, fakeFetch);
    const first = await start(api, store);
    const second = await start(api, store);
    assert.equal(registrations, 1, 'second start must not POST /register again');
    assert.equal(new URL(first.location).searchParams.get('client_id'), 'client-1');
    assert.equal(new URL(second.location).searchParams.get('client_id'), 'client-1');
    // Two independent states, both bound to the same stable client id.
    assert.notEqual(first.state, second.state);
    assert.equal(store.states.get(first.state).grantId, store.states.get(second.state).grantId);
  });
});

test('Notion DCR: failed registration returns 500, does not persist a client, and a retry registers', async () => {
  await withAdminKey(async () => {
    const store = new FakeStore();
    let attempt = 0;
    const fakeFetch = async () => {
      attempt += 1;
      if (attempt === 1) return jsonResponse({ error: 'invalid_redirect_uri' }, false, 400);
      return jsonResponse({ client_id: 'client-after-retry' });
    };
    const api = handlers(store, { servers: [NOTION_SERVER] }, fakeFetch);
    const failed = await start(api, store);
    assert.equal(failed.res.state.status, 500);
    assert.equal(store.values.has(CLIENT_KEY), false, 'no partial client on failure');
    assert.equal(store.states.size, 0, 'no OAuth state was saved on failure');

    const retry = await start(api, store);
    assert.equal(retry.res.state.status, 302);
    assert.equal(attempt, 2);
    assert.equal(new URL(retry.location).searchParams.get('client_id'), 'client-after-retry');
  });
});

test('Notion DCR: a racing registration already in KV is reused (no orphan grant)', async () => {
  await withAdminKey(async () => {
    const store = new FakeStore();
    let attempt = 0;
    const fakeFetch = async () => {
      attempt += 1;
      if (attempt === 1) {
        // Simulate the POST landing in another worker but our response failing.
        await store._command('set', CLIENT_KEY, JSON.stringify({ client_id: 'raced-client', createdAt: Date.now() }));
        throw new Error('network timeout after provider committed');
      }
      return jsonResponse({ client_id: 'should-not-happen' });
    };
    const api = handlers(store, { servers: [NOTION_SERVER] }, fakeFetch);
    const { res, location } = await start(api, store);
    assert.equal(res.state.status, 302);
    assert.equal(attempt, 1, 'retry-free recovery from a raced registration');
    assert.equal(new URL(location).searchParams.get('client_id'), 'raced-client');
  });
});

// ── Notion DCR: callback / refresh client identity ─────────────────────────

test('Notion DCR: callback exchanges code with the state client_id and seeds the grant', async () => {
  await withAdminKey(async () => {
    const store = new FakeStore();
    const calls = [];
    const fakeFetch = async (url, init) => {
      calls.push({ url, init });
      if (url === 'https://mcp.notion.com/register') return jsonResponse({ client_id: 'dcr-client-1' });
      return jsonResponse({ access_token: 'ACCESS', refresh_token: 'REFRESH', expires_in: 3600 });
    };
    const api = handlers(store, { servers: [NOTION_SERVER] }, fakeFetch);
    const { state } = await start(api, store);
    // Even if an env client id were set, callback must use the state client.
    process.env.NOTION_CLIENT_ID = 'env-client-MUST-NOT-BE-USED';
    const cb = mockRes();
    await api.callback(REQ, cb, new URL(`https://gw.example/upstream/oauth/callback?state=${state}&code=CODE&env=local`));
    delete process.env.NOTION_CLIENT_ID;
    assert.equal(cb.state.status, 200);
    assert.equal(calls.length, 2, 'registration + token exchange, no third call');
    const tokenCall = calls[1];
    assert.equal(tokenCall.url, 'https://mcp.notion.com/token');
    const body = new URLSearchParams(tokenCall.init.body);
    assert.equal(body.get('client_id'), 'dcr-client-1');
    assert.equal(body.get('resource'), 'https://mcp.notion.com/mcp');
    assert.equal(body.get('code_verifier').length > 0, true);
    assert.equal(tokenCall.init.headers.authorization, undefined, 'public client sends no Basic auth');

    const grant = JSON.parse(store.values.get(GRANT_KEY));
    assert.equal(grant.access_token, 'ACCESS');
    assert.equal(grant.refresh_token, 'REFRESH');
    assert.equal(grant.client_id, 'dcr-client-1');
    assert.equal(grant.source, 'gateway-dcr');
    assert.equal(grant.owner, 'gateway');
    assert.equal(grant.environment, 'local');
    assert.equal([...store.values.keys()].some((k) => k.startsWith('gmcgw:v1:')), false);
  });
});

test('Notion DCR: refresh uses the client_id stored in the KV grant record', async () => {
  const store = new FakeStore();
  const auth = new UpstreamAuth({ store, environment: 'local', grantOwner: 'gateway' });
  // Seed a DCR grant exactly as the callback would.
  await auth.seed('notion', {
    accessToken: 'OLD-ACCESS',
    refreshToken: 'OLD-REFRESH',
    clientId: 'dcr-client-1',
    expiresIn: 3600,
    obtainedAt: Date.now(),
    grantOwner: 'gateway',
    source: 'gateway-dcr',
    environment: 'local',
    grantId: 'gw:local:notion:dcr',
    force: true,
  });
  // Force a refresh with no env client id at all (DCR has no env identity).
  const calls = [];
  const refreshFetch = async (url, init) => {
    calls.push({ url, init });
    return jsonResponse({ access_token: 'NEW-ACCESS', refresh_token: 'NEW-REFRESH', expires_in: 3600 });
  };
  const refreshingAuth = new UpstreamAuth({ store, fetch: refreshFetch, environment: 'local', grantOwner: 'gateway' });
  const token = await refreshingAuth.getAccessToken('notion', { tokenUrl: 'https://mcp.notion.com/token' }, { force: true });
  assert.equal(token, 'NEW-ACCESS');
  assert.equal(calls.length, 1);
  const form = new URLSearchParams(calls[0].init.body);
  assert.equal(form.get('grant_type'), 'refresh_token');
  assert.equal(form.get('client_id'), 'dcr-client-1');
  assert.equal(form.get('refresh_token'), 'OLD-REFRESH');
  const rotated = JSON.parse(store.values.get(GRANT_KEY));
  assert.equal(rotated.refresh_token, 'NEW-REFRESH');
  assert.equal(rotated.client_id, 'dcr-client-1');
});

// ── Vercel CIMD ────────────────────────────────────────────────────────────

test('Vercel CIMD: authorize URL carries openid + offline_access and RFC 8707 resource', async () => {
  await withAdminKey(async () => {
    const store = new FakeStore();
    // No DCR on Vercel: any call to /register would be a bug.
    const fakeFetch = async (url) => {
      assert.notEqual(url, 'https://api.vercel.com/login/oauth/register');
      throw new Error(`unexpected CIMD network call: ${url}`);
    };
    const api = handlers(store, { servers: [VERCEL_SERVER] }, fakeFetch);
    const { res, state, location } = await start(api, store, 'vercel');
    assert.equal(res.state.status, 302);
    const auth = new URL(location);
    assert.equal(auth.origin + auth.pathname, 'https://vercel.com/oauth/authorize');
    assert.equal(auth.searchParams.get('client_id'), CIMD_URL);
    assert.equal(auth.searchParams.get('resource'), 'https://mcp.vercel.com/');
    const scopes = auth.searchParams.get('scope').split(' ');
    assert.ok(scopes.includes('openid'));
    assert.ok(scopes.includes('offline_access'));
    assert.equal(store.states.get(state).clientKind, 'cimd');
    assert.equal(store.states.get(state).clientId, CIMD_URL);
    assert.equal(store.values.size, 0, 'CIMD needs no KV client record and no registration');
  });
});

test('Vercel CIMD: callback fails loudly when the AS returns no refresh_token', async () => {
  await withAdminKey(async () => {
    const store = new FakeStore();
    const calls = [];
    const fakeFetch = async (url, init) => {
      calls.push({ url, init });
      return jsonResponse({ access_token: 'ONLY-ACCESS', expires_in: 3600 });
    };
    const api = handlers(store, { servers: [VERCEL_SERVER] }, fakeFetch);
    const { state } = await start(api, store, 'vercel');
    const cb = mockRes();
    await api.callback(REQ, cb, new URL(`https://gw.example/upstream/oauth/callback?state=${state}&code=CODE&env=local`));
    assert.equal(cb.state.status, 400);
    assert.match(cb.state.body, /refresh_token/);
    assert.equal(store.values.has('gmcgw:v2:grant:local:gateway:vercel'), false, 'no grant seeded without refresh');
    const body = new URLSearchParams(calls[0].init.body);
    assert.equal(body.get('client_id'), CIMD_URL);
    assert.equal(body.get('resource'), 'https://mcp.vercel.com/');
  });
});

test('Vercel CIMD: public metadata document has the right shape (client_id == URL)', () => {
  const doc = buildCimdDocument({ clientId: CIMD_URL, redirectUri: 'https://gw.example/upstream/oauth/callback?env=local' });
  assert.equal(doc.client_id, CIMD_URL);
  assert.deepEqual(doc.redirect_uris, ['https://gw.example/upstream/oauth/callback?env=local']);
  assert.deepEqual(doc.grant_types, ['authorization_code', 'refresh_token']);
  assert.deepEqual(doc.response_types, ['code']);
  assert.equal(doc.token_endpoint_auth_method, 'none');
  assert.deepEqual(doc.code_challenge_methods_supported, ['S256']);
  assert.equal(doc.scope, 'openid offline_access');
  assert.equal('client_secret' in doc, false, 'no secret in a public CIMD document');
  assert.throws(() => buildCimdDocument({ clientId: 'http://insecure.example/x', redirectUri: 'https://gw.example/cb' }), /absolute https URL/);
  assert.throws(() => buildCimdDocument({ clientId: CIMD_URL, redirectUri: 'http://insecure.example/cb' }), /https URLs/);
});

test('Vercel CIMD: app handler serves GET /.well-known/mcp-client.json unauthenticated', async () => {
  const handler = createAppHandler({ config: { servers: [] }, baseUrl: 'https://gw.example' });
  assert.equal(cimdClientId({ baseUrl: 'https://gw.example' }), CIMD_URL);
  const res = mockRes();
  await handler({ method: 'GET', url: CIMD_PATH, headers: { host: 'gw.example' } }, res);
  assert.equal(res.state.status, 200);
  assert.match(res.state.headers['content-type'], /application\/json/);
  assert.equal(res.state.headers['cache-control'], 'public, max-age=3600');
  const doc = JSON.parse(res.state.body);
  assert.equal(doc.client_id, CIMD_URL);
  assert.deepEqual(doc.redirect_uris, ['https://gw.example/upstream/oauth/callback']);
  assert.equal(doc.token_endpoint_auth_method, 'none');
  assert.equal('client_secret' in doc, false);
  assert.equal('authorization' in res.state.headers, false, 'public route needs no auth');
});

// ── provider facts (pin the fetched metadata, no network) ──────────────────

test('provider facts: Notion DCR resource/scope and Vercel resource/scope are pinned', () => {
  assert.equal(PROVIDER_ENDPOINTS.notion.registrationEndpoint, 'https://mcp.notion.com/register');
  assert.equal(PROVIDER_ENDPOINTS.notion.resource, 'https://mcp.notion.com/mcp');
  assert.deepEqual([...PROVIDER_ENDPOINTS.notion.dcrScopes], ['default']);
  assert.equal(PROVIDER_ENDPOINTS.vercel.resource, 'https://mcp.vercel.com/');
  assert.deepEqual([...PROVIDER_ENDPOINTS.vercel.dcrScopes], ['openid', 'offline_access']);
});
