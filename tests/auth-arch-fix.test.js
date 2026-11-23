/**
 * B15 auth-architecture residual risks R1-R6 + static bearer path.
 *
 * Deterministic, zero-network regressions for the fixes recorded in
 * docs/ledger/batch-15-auth-arch-fix.md. Every fake store/fetch is local;
 * no real credential, provider call or deployment is involved.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  UpstreamAuth, resolveEnvironment,
  SHARED_GRANT_REFRESH_FORBIDDEN, LEGACY_KEY_PREFIX, V2_KEY_PREFIX,
} from '../src/upstream-auth.js';
import { TokenStore as RealTokenStore } from '../src/store.js';
import { createUpstreamOAuthHandlers } from '../src/upstream-oauth.js';
import { UpstreamManager } from '../src/upstreams.js';

const V2 = (env, owner, server) => `${V2_KEY_PREFIX}:${env}:${owner}:${server}`;

function fakeStore() {
  const data = new Map();
  const commands = [];
  const store = {
    isConfigured: () => true,
    _data: data,
    commands,
    _command: async (...args) => {
      const [cmd, key, value, ...rest] = args;
      commands.push([cmd, key, value, ...rest]);
      if (cmd === 'get') return data.get(key) ?? null;
      if (cmd === 'set') {
        if (rest.includes('NX') && data.has(key)) return null;
        data.set(key, value);
        return 'OK';
      }
      if (cmd === 'del') { data.delete(key); return 1; }
      if (cmd === 'getdel') {
        const value = data.get(key) ?? null;
        data.delete(key);
        return value;
      }
      return null;
    },
    casToken: async (key, expectedRefresh, nextJson) => {
      const cur = data.get(key);
      if (!cur) return false;
      if (String(JSON.parse(cur).refresh_token) !== String(expectedRefresh)) return false;
      data.set(key, nextJson);
      return true;
    },
    releaseLease: async (key, owner) => {
      const cur = data.get(key);
      if (!cur) return false;
      let obj;
      try { obj = JSON.parse(cur); } catch { return false; }
      if (String(obj?.owner) !== String(owner)) return false;
      data.delete(key);
      return true;
    },
    renewLease: async (key, owner) => {
      const cur = data.get(key);
      if (!cur) return false;
      let obj;
      try { obj = JSON.parse(cur); } catch { return false; }
      if (String(obj?.owner) !== String(owner)) return false;
      obj.expiresAt = Date.now() + 60_000;
      data.set(key, JSON.stringify(obj));
      return true;
    },
  };
  return store;
}

function refreshFetch(handler) {
  return async (url, opts) => {
    const body = String(opts?.body ?? '');
    if (body.includes('grant_type=refresh_token')) return handler(url, body);
    return { ok: false, status: 401 };
  };
}

const gatewayEnv = {
  envToken: 'ENV_AT', envRefresh: 'ENV_RT', envClientId: 'CID',
  envExpiresIn: 0, envObtainedAt: 0,
  grantOwner: 'gateway', source: 'gateway-oauth',
};

// ── R1: unmarked owner = shared, never refreshed ────────────────────────────

test('R1: empty/unmarked grantOwner is shared and MUST NOT auto-refresh', async () => {
  const store = fakeStore();
  let providerCalls = 0;
  const auth = new UpstreamAuth({
    store,
    fetch: refreshFetch(() => { providerCalls++; throw new Error('must not spend grant'); }),
  });
  // No grantOwner / source anywhere: an unmarked grant is untrusted.
  const token = await auth.getAccessToken('notion', {
    envToken: 'UNMARKED_AT', envRefresh: 'UNMARKED_RT', envClientId: 'CID',
    envExpiresIn: 0, envObtainedAt: 0, // would need refresh if owned
  });
  assert.equal(token, 'UNMARKED_AT', 'access token still usable while alive');
  assert.equal(providerCalls, 0, 'unmarked grant must never be refreshed');
  const status = await auth.getAuthStatus('notion');
  assert.equal(status.status, 'REAUTH_REQUIRED');
  assert.equal(status.reason, SHARED_GRANT_REFRESH_FORBIDDEN);
});

test('R1: only explicit owner=gateway may refresh; unknown owners are shared', () => {
  const auth = new UpstreamAuth({ store: fakeStore() });
  assert.equal(auth._grantOwner({}), 'shared');
  assert.equal(auth._grantOwner(null, { grantOwner: '' }), 'shared');
  assert.equal(auth._grantOwner(null, { grantOwner: 'gateway' }), 'gateway');
  assert.equal(auth._grantOwner(null, { source: 'gateway-dcr' }), 'gateway');
  assert.equal(auth._grantOwner(null, { source: 'dsh-mcp-connector-oauth-grant' }), 'dsh');
  assert.equal(auth._grantOwner(null, { grantOwner: 'manual' }), 'manual');
  // 2026-11-24 owner-marking: the legacy-v1 exception is GONE. An unmarked
  // record read from a v1 key is `shared` too and must never be refreshed.
  assert.equal(auth._grantOwner({}, { legacy: true }), 'shared');
  assert.equal(auth._mayRefresh({}), false);
  assert.equal(auth._mayRefresh({}, { legacy: true }), false);
  assert.equal(auth._grantOwner({ owner: 'gateway' }, { legacy: true }), 'gateway');
});

test('R1: explicit owner=gateway still refreshes normally', async () => {
  const store = fakeStore();
  let calls = 0;
  const auth = new UpstreamAuth({
    store,
    fetch: refreshFetch(() => {
      calls++;
      return { ok: true, json: async () => ({ access_token: `AT_${calls}`, refresh_token: `RT_${calls}`, expires_in: 3600 }) };
    }),
  });
  const token = await auth.getAccessToken('notion', gatewayEnv);
  assert.equal(token, 'AT_1');
  assert.equal(calls, 1);
  assert.equal(JSON.parse(store._data.get(V2('local', 'gateway', 'notion'))).owner, 'gateway');
});

// ── R2: environment default is never production locally ─────────────────────

test('R2: no local metadata defaults to local, never production', () => {
  assert.equal(resolveEnvironment({}), 'local');
  assert.equal(resolveEnvironment({ GMCGW_ENVIRONMENT: '' }), 'local');
  assert.equal(resolveEnvironment({ GMCGW_ENVIRONMENT: 'bogus' }), 'local');
});

test('R2: Vercel without VERCEL_ENV defaults to a safe preview namespace', () => {
  assert.equal(resolveEnvironment({ VERCEL: '1' }), 'preview');
  assert.equal(resolveEnvironment({ VERCEL: '1', GMCGW_ENVIRONMENT: 'local' }), 'local');
});

test('R2: explicit env always wins; local cold start cannot read production key', async () => {
  const store = fakeStore();
  const prod = new UpstreamAuth({ store, environment: 'production' });
  await prod.seed('notion', { accessToken: 'PROD_AT', refreshToken: 'PROD_RT', clientId: 'CID', grantOwner: 'gateway' });

  const local = new UpstreamAuth({ store, environment: resolveEnvironment({}) });
  assert.equal(local.environment, 'local');
  const token = await local.getAccessToken('notion', {
    ...gatewayEnv, envToken: 'LOCAL_AT', envRefresh: 'LOCAL_RT',
  });
  assert.equal(token, 'LOCAL_AT');
  // Production grant is untouched by the local instance.
  assert.equal(JSON.parse(store._data.get(V2('production', 'gateway', 'notion'))).refresh_token, 'PROD_RT');
  assert.equal(store._data.has(V2('local', 'gateway', 'notion')), true);
});

// ── R4: legacy keys are read-only, new writes go to v2 ──────────────────────

test('R4: production+gateway writes to v2, never the legacy un-suffixed key', async () => {
  const store = fakeStore();
  const auth = new UpstreamAuth({ store, environment: 'production', grantOwner: 'gateway' });
  await auth.seed('notion', { accessToken: 'AT', refreshToken: 'RT', clientId: 'CID', grantOwner: 'gateway' });
  assert.equal(store._data.has(V2('production', 'gateway', 'notion')), true);
  assert.equal(store._data.has(`${LEGACY_KEY_PREFIX}:notion`), false);
});

test('R4: a rotated pair in a legacy key is READ-ONLY compatible but never rewritten', async () => {
  const store = fakeStore();
  // Simulate the migration window: only a v1 record exists.
  store._data.set(`${LEGACY_KEY_PREFIX}:notion`, JSON.stringify({
    access_token: 'LEGACY_AT', refresh_token: 'LEGACY_RT', client_id: 'CID',
    expires_at: Date.now() + 3_600_000, envSeed: 'LEGACY_AT',
  }));
  const auth = new UpstreamAuth({ store, environment: 'production' });
  const token = await auth.getAccessToken('notion', {});
  assert.equal(token, 'LEGACY_AT', 'legacy pair readable during migration');
  assert.equal(store._data.get(`${LEGACY_KEY_PREFIX}:notion`) !== undefined, true);
  assert.equal(store._data.has(V2('production', 'gateway', 'notion')), false, 'no writeback to v2 on read-only path');
});

// ── R5 / R3: OAuth state + callback carry environment and grant identity ────

test('R5: TokenStore OAuth state keys are environment/owner scoped', () => {
  const store = new RealTokenStore({ url: 'https://kv.invalid', token: 'k' });
  const scoped = store._oauthStateKey('state-123', { environment: 'preview', grantOwner: 'gateway' });
  const otherEnv = store._oauthStateKey('state-123', { environment: 'production', grantOwner: 'gateway' });
  const otherOwner = store._oauthStateKey('state-123', { environment: 'preview', grantOwner: 'dsh' });
  assert.match(scoped, /^gmcgw:v1:oauthstate:preview:gateway:/);
  assert.notEqual(scoped, otherEnv, 'cross-environment callback must not find the state');
  assert.notEqual(scoped, otherOwner, 'cross-owner callback must not find the state');
  assert.doesNotMatch(scoped, /state-123/, 'raw state must never appear in the key');
});

test('R3/R5: OAuth callback seeds env+owner+source+grantId into the v2 key', async () => {
  process.env.ARCH_FIX_CLIENT_ID = 'client-1';
  process.env.ARCH_FIX_CLIENT_SECRET = 'secret-1';
  process.env.UPSTREAM_OAUTH_ADMIN_KEY = 'admin-key';
  const store = fakeStore();
  const savedStates = new Map();
  store._oauthStateKey = (state, scope) => `oauthstate:${scope.environment}:${scope.grantOwner}:${state}`;
  store.saveOAuthState = async (state, record, scope) => {
    savedStates.set(store._oauthStateKey(state, scope), { ...record, ...scope });
  };
  store.takeOAuthState = async (state, scope) => {
    const key = store._oauthStateKey(state, scope);
    const value = savedStates.get(key) ?? null;
    savedStates.delete(key);
    return value;
  };
  const config = {
    servers: [{
      name: 'notion',
      authorizeUrl: 'https://example.invalid/authorize',
      refreshUrl: 'https://example.invalid/token',
      clientIdEnv: 'ARCH_FIX_CLIENT_ID',
      clientSecretEnv: 'ARCH_FIX_CLIENT_SECRET',
      oauthScopes: ['default'],
    }],
  };
  const res = () => {
    const state = { status: 0, headers: {}, body: '' };
    return {
      state,
      writeHead(status, headers) { state.status = status; Object.assign(state.headers, headers); },
      setHeader() {},
      end(body = '') { state.body = body; },
    };
  };
  const fetchImpl = async () => ({
    ok: true, status: 200,
    text: async () => JSON.stringify({ access_token: 'GW_AT', refresh_token: 'GW_RT', expires_in: 3600 }),
  });
  const api = createUpstreamOAuthHandlers({
    store, getConfig: async () => config,
    options: { baseUrl: 'https://gw.example' }, fetch: fetchImpl,
  });
  const startRes = res();
  await api.start({}, startRes, new URL('https://gw.example/upstream/oauth/start?server=notion&key=admin-key&env=preview'));
  assert.equal(startRes.state.status, 302);
  const location = new URL(startRes.state.headers.location);
  const state = location.searchParams.get('state');
  assert.match(location.searchParams.get('redirect_uri'), /env=preview/);
  assert.match(location.searchParams.get('scope'), /offline_access/);

  const callbackRes = res();
  await api.callback({}, callbackRes, new URL(`https://gw.example/upstream/oauth/callback?state=${state}&code=C&env=preview`));
  assert.equal(callbackRes.state.status, 200);
  const rec = JSON.parse(store._data.get(V2('preview', 'gateway', 'notion')));
  assert.equal(rec.environment, 'preview');
  assert.equal(rec.owner, 'gateway');
  assert.equal(rec.source, 'gateway-oauth');
  assert.match(rec.grantId, /^gw:preview:notion:/);
  assert.equal(store._data.has(V2('production', 'gateway', 'notion')), false, 'callback must never land on legacy production key');
  delete process.env.UPSTREAM_OAUTH_ADMIN_KEY;
  delete process.env.ARCH_FIX_CLIENT_ID;
  delete process.env.ARCH_FIX_CLIENT_SECRET;
});

test('R5: a state started in one environment cannot be consumed in another', async () => {
  const store = new RealTokenStore({ url: 'https://kv.invalid', token: 'k' });
  const calls = [];
  store._command = async (...args) => {
    calls.push(args);
    if (args[0] === 'set') return 'OK';
    if (args[0] === 'getdel') return null; // no state in the other environment's key
    return null;
  };
  await store.saveOAuthState('state', { server: 'notion' }, { environment: 'preview', grantOwner: 'gateway' });
  const previewKey = calls.find((c) => c[0] === 'set')[1];
  assert.match(previewKey, /:preview:gateway:/);
  const value = await store.takeOAuthState('state', { environment: 'production', grantOwner: 'gateway' });
  assert.equal(value, null, 'production callback cannot consume a preview state');
  const prodKey = calls.find((c) => c[0] === 'getdel')[1];
  assert.match(prodKey, /:production:gateway:/);
});

// ── R6: same-instance refresh coalescing; cross-instance still uses lease ───

test('R6: concurrent calls on ONE UpstreamAuth share a single refresh promise', async () => {
  const store = fakeStore();
  let providerCalls = 0;
  const auth = new UpstreamAuth({
    store,
    fetch: refreshFetch(() => {
      providerCalls++;
      return { ok: true, json: async () => ({ access_token: 'AT_ONE', refresh_token: 'RT_ONE', expires_in: 3600 }) };
    }),
  });
  await auth.seed('notion', {
    accessToken: 'AT_0', refreshToken: 'RT_0', clientId: 'CID',
    expiresAt: Date.now() - 1000, grantOwner: 'gateway', source: 'gateway-oauth',
  });
  const results = await Promise.all([
    auth.getAccessToken('notion', {}, { force: true }),
    auth.getAccessToken('notion', {}, { force: true }),
    auth.getAccessToken('notion', {}, { force: true }),
  ]);
  assert.equal(providerCalls, 1, `one instance must spend the grant once, got ${providerCalls}`);
  assert.deepEqual([...new Set(results)], ['AT_ONE']);
});

test('R6: cross-instance safety still uses the Redis lease (one provider call)', async () => {
  const store = fakeStore();
  let providerCalls = 0;
  const makeAuth = () => new UpstreamAuth({
    store,
    fetch: refreshFetch(() => {
      providerCalls++;
      return { ok: true, json: async () => ({ access_token: `AT_${providerCalls}`, refresh_token: `RT_${providerCalls}`, expires_in: 3600 }) };
    }),
  });
  for (const a of [makeAuth(), makeAuth()]) {
    await a.seed('notion', {
      accessToken: 'AT_0', refreshToken: 'RT_0', clientId: 'CID',
      expiresAt: Date.now() - 1000, grantOwner: 'gateway', source: 'gateway-oauth',
    });
  }
  const [a1, a2] = [makeAuth(), makeAuth()];
  const [t1, t2] = await Promise.all([
    a1.getAccessToken('notion', {}, { force: true }),
    a2.getAccessToken('notion', {}, { force: true }),
  ]);
  assert.equal(providerCalls, 1, 'lease must serialize separate instances');
  assert.equal(t1, t2);
});

// ── static_bearer / owner=manual path (AUTH-PROVIDERS.md decision) ──────────

test('static_bearer: explicit config opts out of refresh and persists owner=manual', async () => {
  process.env.ARCH_FIX_STATIC_TOKEN = 'ntn_static_token';
  const store = fakeStore();
  const auth = new UpstreamAuth({ store, fetch: refreshFetch(() => { throw new Error('must not refresh'); }) });
  const mgr = new UpstreamManager([{
    name: 'notion', transport: 'http', url: 'https://example.invalid/mcp',
    tokenEnv: 'ARCH_FIX_STATIC_TOKEN', authMode: 'static_bearer',
  }], { auth, clientFactory: () => ({ connect: async () => {}, listTools: async () => ({ tools: [] }), close: async () => {} }) });
  assert.equal(await mgr._resolveToken(mgr.configs[0]), 'ntn_static_token');
  const rec = JSON.parse(store._data.get(V2('local', 'manual', 'notion')));
  assert.equal(rec.owner, 'manual');
  assert.equal(rec.source, 'manual');
  delete process.env.ARCH_FIX_STATIC_TOKEN;
});

test('static_bearer: a 401 is terminal, never triggers a refresh/reconnect retry', async () => {
  process.env.ARCH_FIX_STATIC_TOKEN = 'expired_static';
  const store = fakeStore();
  let refreshes = 0;
  const auth = new UpstreamAuth({
    store,
    fetch: refreshFetch(() => { refreshes++; return { ok: true, json: async () => ({ access_token: 'X' }) }; }),
  });
  let connects = 0;
  const mgr = new UpstreamManager([{
    name: 'linear', transport: 'http', url: 'https://example.invalid/mcp',
    tokenEnv: 'ARCH_FIX_STATIC_TOKEN', authMode: 'static_bearer', allowTools: [], denyTools: [],
  }], {
    auth,
    clientFactory: () => {
      connects++;
      return { connect: async () => { throw new Error('401 invalid_token'); }, listTools: async () => ({ tools: [] }), close: async () => {} };
    },
  });
  await mgr.connect();
  assert.equal(refreshes, 0, 'static bearer must never enter the refresh path');
  assert.equal(connects, 1, 'no pointless reconnect with the same dead static token');
  assert.deepEqual(mgr.failedServers, ['linear']);
  delete process.env.ARCH_FIX_STATIC_TOKEN;
});

test('Vercel: authorization request augments scopes with offline_access', async () => {
  process.env.ARCH_FIX_VERCEL_CLIENT = 'cimd-client';
  process.env.UPSTREAM_OAUTH_ADMIN_KEY = 'admin-key';
  const store = fakeStore();
  const states = new Map();
  store.saveOAuthState = async (state, record) => { states.set(state, record); };
  store.takeOAuthState = async (state) => {
    const v = states.get(state) ?? null;
    states.delete(state);
    return v;
  };
  const config = {
    servers: [{
      name: 'vercel',
      authorizeUrl: 'https://vercel.example/authorize',
      refreshUrl: 'https://vercel.example/token',
      clientIdEnv: 'ARCH_FIX_VERCEL_CLIENT',
      oauthScopes: ['openid'],
    }],
  };
  const res = () => {
    const state = { status: 0, headers: {} };
    return { state, writeHead(status, headers) { state.status = status; Object.assign(state.headers, headers); }, setHeader() {}, end() {} };
  };
  const api = createUpstreamOAuthHandlers({
    store, getConfig: async () => config, options: { baseUrl: 'https://gw.example' },
  });
  const startRes = res();
  await api.start({}, startRes, new URL('https://gw.example/upstream/oauth/start?server=vercel&key=admin-key&env=production'));
  const location = new URL(startRes.state.headers.location);
  const scopes = location.searchParams.get('scope').split(' ');
  assert.ok(scopes.includes('openid'));
  assert.ok(scopes.includes('offline_access'), 'Vercel needs offline_access or no refresh token is issued');
  delete process.env.UPSTREAM_OAUTH_ADMIN_KEY;
  delete process.env.ARCH_FIX_VERCEL_CLIENT;
});

test('Vercel: callback without refresh_token fails loudly instead of accepting a 1h token', async () => {
  process.env.ARCH_FIX_VERCEL_CLIENT = 'cimd-client';
  process.env.UPSTREAM_OAUTH_ADMIN_KEY = 'admin-key';
  const store = fakeStore();
  const saved = new Map();
  store._oauthStateKey = (s, scope) => `state:${scope.environment}:${s}`;
  store.saveOAuthState = async (s, rec, scope) => saved.set(store._oauthStateKey(s, scope), { ...rec, ...scope });
  store.takeOAuthState = async (s, scope) => {
    const k = store._oauthStateKey(s, scope);
    const v = saved.get(k) ?? null;
    saved.delete(k);
    return v;
  };
  const config = {
    servers: [{
      name: 'vercel', authorizeUrl: 'https://vercel.example/authorize',
      refreshUrl: 'https://vercel.example/token', clientIdEnv: 'ARCH_FIX_VERCEL_CLIENT',
      oauthScopes: ['openid'],
    }],
  };
  const res = () => {
    const state = { status: 0, headers: {}, body: '' };
    return { state, writeHead(status, headers) { state.status = status; Object.assign(state.headers, headers); }, setHeader() {}, end(body = '') { state.body = body; } };
  };
  const api = createUpstreamOAuthHandlers({
    store, getConfig: async () => config, options: { baseUrl: 'https://gw.example' },
    fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'ONE_HOUR', expires_in: 3600 }) }),
  });
  const startRes = res();
  await api.start({}, startRes, new URL('https://gw.example/upstream/oauth/start?server=vercel&key=admin-key&env=production'));
  const state = new URL(startRes.state.headers.location).searchParams.get('state');
  const cb = res();
  await api.callback({}, cb, new URL(`https://gw.example/upstream/oauth/callback?state=${state}&code=C&env=production`));
  assert.equal(cb.state.status, 400);
  assert.match(cb.state.body, /refresh_token/);
  assert.equal(store._data.size, 0, 'no grant record for a token that cannot be refreshed');
  delete process.env.UPSTREAM_OAUTH_ADMIN_KEY;
  delete process.env.ARCH_FIX_VERCEL_CLIENT;
});

test('environment pollution: record environment must match its key or refresh is refused', async () => {
  const store = fakeStore();
  store._data.set(V2('local', 'gateway', 'notion'), JSON.stringify({
    access_token: 'POLLUTED_AT', refresh_token: 'POLLUTED_RT', client_id: 'CID',
    expires_at: Date.now() - 1000, owner: 'gateway', source: 'gateway-oauth',
    environment: 'production', // wrong: key says local
  }));
  let calls = 0;
  const auth = new UpstreamAuth({
    store, environment: 'local',
    fetch: refreshFetch(() => { calls++; throw new Error('must not refresh polluted record'); }),
  });
  const token = await auth.getAccessToken('notion', {}, { force: true });
  assert.equal(token, 'POLLUTED_AT');
  assert.equal(calls, 0);
  assert.match((await auth.getAuthStatus('notion')).reason, /^environment_mismatch:/);
});
