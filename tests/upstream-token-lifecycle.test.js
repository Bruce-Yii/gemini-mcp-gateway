/**
 * Batch 15 · upstream token lifecycle regressions.
 *
 * Every test uses a fake KV store and a fake fetch — no network, no real
 * credentials, no provider calls. These pin the root causes of the recurring
 * Notion invalid_grant / Linear invalid_token / Vercel invalid_token incidents
 * documented in docs/HANDOFF.md and docs/ledger/batch-15-token-lifecycle.md.
 *
 * Root causes covered:
 *   A. env re-seed + bootstrapped true -> refresh on every call ("刷太多")
 *   B. owner-less lock + blind DEL -> A deletes B's lease -> concurrent refresh
 *   C. provider call before CAS -> two workers spend the SAME rotating grant
 *   D. loser's invalid_grant -> whole family wrongly marked REAUTH_REQUIRED
 *   E. preview/production share one KV key -> preview burns production grant
 *   F. Vercel has no refreshUrl -> static token expiry needs an explicit signal
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  UpstreamAuth, resolveEnvironment, REAUTH_REQUIRED, STATIC_TOKEN_NO_REFRESH,
  SHARED_GRANT_REFRESH_FORBIDDEN, DSH_GRANT_SOURCE, ReauthRequiredError,
} from '../src/upstream-auth.js';
import { TokenStore } from '../src/store.js';
import { UpstreamManager } from '../src/upstreams.js';

const KEY = 'gmcgw:v2:grant:local:gateway:notion';
const KEY_PREVIEW = 'gmcgw:v2:grant:preview:gateway:notion';
const KEY_PROD = 'gmcgw:v2:grant:production:gateway:notion';

/** Fake Upstash-compatible KV with real NX / owner-aware Lua semantics. */
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

function record(overrides = {}) {
  return {
    access_token: 'AT_0', refresh_token: 'RT_0', client_id: 'CID',
    expires_at: Date.now() + 60 * 60 * 1000, envSeed: 'ENV_AT_0',
    // R1: a grant that may be refreshed must be EXPLICITLY gateway-owned.
    owner: 'gateway', source: 'gateway-oauth', environment: 'local',
    bootstrapped: false, ...overrides,
  };
}

function seedStore(store, rec, key = KEY) {
  store._data.set(key, JSON.stringify(rec));
}

function tokenFetch(handler) {
  return async (url, opts) => {
    const body = String(opts?.body ?? '');
    if (body.includes('grant_type=refresh_token')) return handler(url, body);
    return { ok: false, status: 401 };
  };
}

const ENV = {
  envToken: 'ENV_AT_0', envRefresh: 'ENV_RT_0', envClientId: 'CID',
  envExpiresIn: 3600, envObtainedAt: Date.now(),
  grantOwner: 'gateway', source: 'gateway-oauth',
};

// ── A. env seed is one-shot; bootstrapped attempt is consumed ──────────────

test('A1: bootstrapped refresh attempt is consumed once even when it fails (no per-call loop)', async () => {
  const store = fakeStore();
  let refreshCalls = 0;
  const auth = new UpstreamAuth({
    store,
    fetch: tokenFetch(() => {
      refreshCalls++;
      return { ok: false, json: async () => ({ error: 'invalid_client' }) };
    }),
  });
  await auth.getAccessToken('notion', ENV);
  assert.equal(refreshCalls, 1);
  await auth.getAccessToken('notion', ENV);
  await auth.getAccessToken('notion', ENV);
  assert.equal(refreshCalls, 1, 'a failed bootstrap must NOT be retried on every call');
  const rec = JSON.parse(store._data.get(KEY));
  assert.equal(rec.bootstrapped, false);
});

test('A2: a rotated KV record is not rebuilt from env on cold start', async () => {
  const store = fakeStore();
  // Simulate the pair left by a successful refresh: envSeed preserved.
  seedStore(store, record({ access_token: 'AT_ROTATED', refresh_token: 'RT_1', envSeed: ENV.envToken }));
  let refreshCalls = 0;
  const auth = new UpstreamAuth({
    store,
    fetch: tokenFetch(() => { refreshCalls++; throw new Error('must not refresh'); }),
  });
  const tok = await auth.getAccessToken('notion', ENV);
  assert.equal(tok, 'AT_ROTATED');
  assert.equal(refreshCalls, 0);
  assert.equal(JSON.parse(store._data.get(KEY)).refresh_token, 'RT_1');
});

test('A3: concurrent cold starts seed once; only ONE provider refresh happens', async () => {
  const store = fakeStore();
  let refreshCalls = 0;
  const auth = new UpstreamAuth({
    store,
    fetch: tokenFetch(() => {
      refreshCalls++;
      return { ok: true, json: async () => ({ access_token: `AT_${refreshCalls}`, refresh_token: `RT_${refreshCalls}`, expires_in: 3600 }) };
    }),
  });
  const [a, b] = await Promise.all([
    auth.getAccessToken('notion', ENV),
    auth.getAccessToken('notion', ENV),
  ]);
  assert.equal(refreshCalls, 1, `two cold starts must spend the grant once, got ${refreshCalls}`);
  assert.equal(a, b, 'both workers must converge on the winner token');
  assert.equal(JSON.parse(store._data.get(KEY)).refresh_token, 'RT_1');
});

// ── B. lease owner + compare-and-delete ────────────────────────────────────

test('B1: lease carries an owner token and is only released by its owner', async () => {
  const store = fakeStore();
  const auth = new UpstreamAuth({ store, fetch: tokenFetch(() => { throw new Error('unused'); }) });
  const ownerA = await auth._acquireLock('notion');
  assert.ok(ownerA && ownerA !== 'no-kv', 'first acquire returns a UUID owner');
  assert.equal(await auth._acquireLock('notion'), null, 'second acquire must fail while lease held');

  const lockKey = `${KEY}:lock`;
  const stored = JSON.parse(store._data.get(lockKey));
  assert.equal(stored.owner, ownerA);
  assert.ok(stored.expiresAt > Date.now(), 'lease has an expiry');

  // Simulate A's lease expiring and B taking over with a fresh UUID.
  const ownerB = '00000000-0000-4000-8000-000000000001';
  store._data.set(lockKey, JSON.stringify({ owner: ownerB, expiresAt: Date.now() + 60_000 }));

  // A tries to release after its lease was taken over: must NOT delete B's lock.
  await auth._releaseLock('notion', ownerA);
  assert.ok(store._data.has(lockKey), 'stale owner must not delete another worker\'s lease');
  await auth._releaseLock('notion', ownerB);
  assert.equal(store._data.has(lockKey), false, 'real owner can release');
});

test('B2: real TokenStore.releaseLease uses Lua compare-and-delete', async () => {
  const calls = [];
  const tokenStore = new TokenStore({ url: 'https://kv.invalid', token: 'k' });
  tokenStore._commandBody = async (args) => {
    calls.push(args);
    return 1;
  };
  const ok = await tokenStore.releaseLease('some:lock', 'owner-1');
  assert.equal(ok, true);
  assert.equal(calls[0][0], 'EVAL');
  assert.match(calls[0][1], /owner.*ARGV\[1\]/);
  assert.match(calls[0][1], /DEL/);
});

test('B3: real TokenStore.renewLease refreshes expiry only for the owner', async () => {
  const calls = [];
  const tokenStore = new TokenStore({ url: 'https://kv.invalid', token: 'k' });
  tokenStore._commandBody = async (args) => { calls.push(args); return 0; };
  assert.equal(await tokenStore.renewLease('some:lock', 'owner-1', 60), false);
  assert.match(calls[0][1], /expiresAt/);
});

// ── C. provider call only inside the lease, after a second KV read ─────────

test('C1: loser never calls the token endpoint; it waits and adopts the winner', async () => {
  const store = fakeStore();
  seedStore(store, record({ expires_at: Date.now() - 1000 })); // needs refresh
  let providerCalls = 0;
  const mkAuth = () => new UpstreamAuth({
    store,
    fetch: tokenFetch(() => {
      providerCalls++;
      return { ok: true, json: async () => ({ access_token: `AT_${providerCalls}`, refresh_token: `RT_${providerCalls}`, expires_in: 3600 }) };
    }),
  });
  const a1 = mkAuth();
  const a2 = mkAuth();
  const [r1, r2] = await Promise.all([
    a1.getAccessToken('notion', ENV),
    a2.getAccessToken('notion', ENV),
  ]);
  assert.equal(providerCalls, 1, `exactly one provider call, got ${providerCalls}`);
  assert.equal(r1, r2);
  assert.equal(JSON.parse(store._data.get(KEY)).refresh_token, 'RT_1');
});

test('C2: lock acquired but KV already refreshed inside -> no provider call', async () => {
  const store = fakeStore();
  const needsRefresh = record({ expires_at: Date.now() - 1000 });
  seedStore(store, needsRefresh);
  let providerCalls = 0;
  const auth = new UpstreamAuth({
    store,
    fetch: tokenFetch(() => { providerCalls++; return { ok: false }; }),
  });
  // Simulate another worker winning between our first read and lock acquire:
  // patch _load so the first read returns the stale record, the second (inside
  // the lease) returns a freshly rotated one.
  let reads = 0;
  const originalLoad = auth._load.bind(auth);
  auth._load = async (server) => {
    reads++;
    if (reads === 2) return record({ access_token: 'AT_WINNER', refresh_token: 'RT_WINNER', expires_at: Date.now() + 3600_000 });
    return originalLoad(server);
  };
  const token = await auth.getAccessToken('notion', ENV);
  assert.equal(token, 'AT_WINNER');
  assert.equal(providerCalls, 0, 'must not spend the grant when a winner already refreshed');
});

test('C3: CAS failure reads and returns the winner; loser writes nothing back', async () => {
  const store = fakeStore();
  seedStore(store, record({ expires_at: Date.now() - 1000 }));
  let n = 0;
  const auth = new UpstreamAuth({
    store,
    fetch: tokenFetch(() => {
      n++;
      return { ok: true, json: async () => ({ access_token: `AT_${n}`, refresh_token: `RT_${n}`, expires_in: 3600 }) };
    }),
  });
  const base = await auth._load('notion');
  // Worker A's refresh: CAS wins.
  const first = await auth._refresh('notion', base);
  assert.equal(first.access_token, 'AT_1');
  // Worker B spent the same old grant: provider returned AT_2 but CAS must lose.
  const second = await auth._refresh('notion', base);
  assert.equal(second.access_token, 'AT_1', 'loser must get winner token');
  const final = JSON.parse(store._data.get(KEY));
  assert.equal(final.refresh_token, 'RT_1');
  assert.notEqual(final.access_token, 'AT_2', 'loser result never written back');
});

// ── D. invalid_grant terminal, but never by a loser ─────────────────────────

test('D1: invalid_grant -> REAUTH_REQUIRED, no further refresh attempts', async () => {
  const store = fakeStore();
  seedStore(store, record({ expires_at: Date.now() - 1000 }));
  let calls = 0;
  const auth = new UpstreamAuth({
    store,
    fetch: tokenFetch(() => { calls++; return { ok: false, json: async () => ({ error: 'invalid_grant' }) }; }),
  });
  await auth.getAccessToken('notion', ENV);
  assert.equal(calls, 1);
  assert.equal((await auth.getAuthStatus('notion')).status, REAUTH_REQUIRED);
  const rec = JSON.parse(store._data.get(KEY));
  assert.equal(rec.needsReauth, true);
  assert.equal(rec.status, REAUTH_REQUIRED);
  await auth.getAccessToken('notion', ENV);
  await auth.getAccessToken('notion', ENV);
  assert.equal(calls, 1, 'terminal grant is never retried');
});

test('D2: a loser invalid_grant does NOT kill a winner that rotated the grant', async () => {
  const store = fakeStore();
  const stale = record({ refresh_token: 'RT_OLD', expires_at: Date.now() - 1000 });
  seedStore(store, stale);
  let calls = 0;
  const auth = new UpstreamAuth({
    store,
    fetch: tokenFetch(() => {
      calls++;
      // First call simulates the loser: grant already rotated by a winner.
      store._data.set(KEY, JSON.stringify(record({
        access_token: 'AT_WINNER', refresh_token: 'RT_WINNER',
      })));
      return { ok: false, json: async () => ({ error: 'invalid_grant' }) };
    }),
  });
  const tok = await auth.getAccessToken('notion', ENV);
  assert.equal(calls, 1);
  assert.equal(tok, 'AT_WINNER', 'loser adopts winner token');
  const rec = JSON.parse(store._data.get(KEY));
  assert.equal(rec.needsReauth, undefined, 'winner grant must NOT be marked terminal');
  assert.notEqual((await auth.getAuthStatus('notion')).status, REAUTH_REQUIRED);
});

test('D3: REAUTH_REQUIRED clears only when a genuinely NEW env grant is seeded', async () => {
  const store = fakeStore();
  seedStore(store, record({ expires_at: Date.now() - 1000 }));
  let calls = 0;
  const auth = new UpstreamAuth({
    store,
    fetch: tokenFetch(() => {
      calls++;
      if (calls === 1) return { ok: false, json: async () => ({ error: 'invalid_grant' }) };
      return { ok: true, json: async () => ({ access_token: 'AT_NEW', refresh_token: 'RT_NEW', expires_in: 3600 }) };
    }),
  });
  await auth.getAccessToken('notion', ENV);
  assert.equal((await auth.getAuthStatus('notion')).status, REAUTH_REQUIRED);
  // Same env seed: still terminal.
  await auth.getAccessToken('notion', ENV);
  assert.equal(calls, 1);
  // New env grant: exactly one refresh, terminal cleared.
  await auth.getAccessToken('notion', { ...ENV, envToken: 'ENV_AT_NEW', envRefresh: 'ENV_RT_NEW' });
  assert.equal(calls, 2);
  assert.notEqual((await auth.getAuthStatus('notion')).status, REAUTH_REQUIRED);
});

// ── E. environment namespaces ──────────────────────────────────────────────

test('E1: resolveEnvironment maps VERCEL_ENV and explicit override (R2: local default)', () => {
  assert.equal(resolveEnvironment({ VERCEL_ENV: 'production' }), 'production');
  assert.equal(resolveEnvironment({ VERCEL_ENV: 'preview' }), 'preview');
  assert.equal(resolveEnvironment({ VERCEL_ENV: 'development' }), 'development');
  assert.equal(resolveEnvironment({ GMCGW_ENVIRONMENT: 'preview', VERCEL_ENV: 'production' }), 'preview');
  assert.equal(resolveEnvironment({}), 'local'); // R2: local cold start must NEVER read production
  assert.equal(resolveEnvironment({ VERCEL: '1' }), 'preview'); // Vercel without VERCEL_ENV: safe fallback
  assert.equal(resolveEnvironment({ GMCGW_ENVIRONMENT: 'local', VERCEL_ENV: 'production' }), 'local');
});

test('E2: preview and production cannot see or burn each other\'s grant', async () => {
  const store = fakeStore();
  const prod = new UpstreamAuth({ store, environment: 'production' });
  const preview = new UpstreamAuth({ store, environment: 'preview' });
  await prod.seed('notion', { accessToken: 'PROD_AT', refreshToken: 'PROD_RT', clientId: 'CID', grantOwner: 'gateway' });
  assert.equal(store._data.has(KEY_PROD), true);
  assert.equal(store._data.has(KEY_PREVIEW), false);

  // A preview cold start seeds its own record — production untouched.
  await preview.getAccessToken('notion', {
    envToken: 'PREVIEW_AT', envRefresh: 'PREVIEW_RT', envClientId: 'CID',
    envExpiresIn: 3600, envObtainedAt: Date.now(),
    grantOwner: 'gateway', source: 'gateway-oauth',
  });
  assert.equal(JSON.parse(store._data.get(KEY_PROD)).refresh_token, 'PROD_RT');
  assert.equal(JSON.parse(store._data.get(KEY_PREVIEW)).refresh_token, 'PREVIEW_RT');

  // Even a REAUTH_REQUIRED in preview is invisible to production.
  await preview._markReauth('notion', await preview._load('notion'), REAUTH_REQUIRED);
  assert.equal((await prod.getAuthStatus('notion')).status, 'ACTIVE');
  assert.equal((await preview.getAuthStatus('notion')).status, REAUTH_REQUIRED);
});

test('E3: preview invalid_grant does not mark production terminal', async () => {
  const store = fakeStore();
  const prod = new UpstreamAuth({ store, environment: 'production' });
  await prod.seed('notion', { accessToken: 'PROD_AT', refreshToken: 'PROD_RT', clientId: 'CID', grantOwner: 'gateway' });
  const preview = new UpstreamAuth({
    store,
    environment: 'preview',
    fetch: tokenFetch(() => ({ ok: false, json: async () => ({ error: 'invalid_grant' }) })),
  });
  seedStore(store, record({ expires_at: Date.now() - 1000, environment: 'preview' }), KEY_PREVIEW);
  await preview.getAccessToken('notion', {
    envToken: 'PREVIEW_AT', envRefresh: 'PREVIEW_RT', envClientId: 'CID',
    envExpiresIn: 3600, envObtainedAt: Date.now(),
    grantOwner: 'gateway', source: 'gateway-oauth',
  });
  assert.equal((await preview.getAuthStatus('notion')).status, REAUTH_REQUIRED);
  assert.equal((await prod.getAuthStatus('notion')).status, 'ACTIVE');
  assert.equal(JSON.parse(store._data.get(KEY_PROD)).needsReauth, undefined);
});

// ── F. static token (Vercel) has no fake auto-refresh ───────────────────────

test('F1: static upstream returns env token verbatim, never calls a token endpoint', async () => {
  const store = fakeStore();
  let fetched = 0;
  const auth = new UpstreamAuth({ store, fetch: async () => { fetched++; return { ok: false }; } });
  assert.equal(await auth.getAccessToken('vercel', { envToken: 'vercel_static_token' }), 'vercel_static_token');
  assert.equal(fetched, 0);
  assert.equal(store._data.size, 0, 'no KV record created for static tokens');
});

test('F2: static-token 401 surfaces REAUTH_REQUIRED / STATIC_TOKEN_NO_REFRESH', async () => {
  process.env.LIFECYCLE_VERCEL_TOKEN = 'expired_static';
  let clientN = 0;
  const clientFactory = () => {
    clientN++;
    return {
      async connect() { throw new Error('invalid_token: access token expired'); },
      async listTools() { return { tools: [] }; },
      async close() {},
    };
  };
  const mgr = new UpstreamManager([{
    name: 'vercel', transport: 'http', url: 'https://mcp.vercel.com/',
    tokenEnv: 'LIFECYCLE_VERCEL_TOKEN', allowTools: [], denyTools: [],
  }], { auth: new UpstreamAuth({ store: fakeStore() }), clientFactory });
  await mgr.connect();
  assert.deepEqual(mgr.failedServers, ['vercel']);
  assert.equal(clientN, 1, 'no pointless reconnect with the same dead static token');
  delete process.env.LIFECYCLE_VERCEL_TOKEN;
});

test('F3: ReauthRequiredError carries an explicit machine-readable status', () => {
  const err = new ReauthRequiredError('vercel', STATIC_TOKEN_NO_REFRESH);
  assert.equal(err.status, REAUTH_REQUIRED);
  assert.equal(err.reason, STATIC_TOKEN_NO_REFRESH);
  assert.match(err.message, /REAUTH_REQUIRED/);
  assert.match(err.message, /re-authorized/);
});

// ── G. shared grants: DSH and gateway must not spend the same grant ────────

test('G1: a DSH-sourced env grant is tagged and NEVER auto-refreshed', async () => {
  const store = fakeStore();
  let providerCalls = 0;
  const auth = new UpstreamAuth({
    store,
    fetch: tokenFetch(() => { providerCalls++; throw new Error('must not be called'); }),
  });
  const tok = await auth.getAccessToken('notion', {
    ...ENV, grantOwner: undefined, // DSH source must win over the default ENV owner
    envExpiresIn: 0, envObtainedAt: 0, // expired/unknown -> would refresh if owned
    source: DSH_GRANT_SOURCE,
  });
  assert.equal(tok, ENV.envToken, 'access token is still usable while alive');
  assert.equal(providerCalls, 0, 'gateway must not spend a DSH-owned rotating grant');
  const rec = JSON.parse(store._data.get('gmcgw:v2:grant:local:dsh:notion'));
  assert.equal(rec.owner, 'dsh');
  assert.equal(rec.source, DSH_GRANT_SOURCE);
  assert.equal(rec.bootstrapped, false);
  const status = await auth.getAuthStatus('notion');
  assert.equal(status.status, REAUTH_REQUIRED);
  assert.equal(status.reason, SHARED_GRANT_REFRESH_FORBIDDEN);
});

test('G2: even a provider 401 cannot force a refresh of a shared grant', async () => {
  const store = fakeStore();
  const shared = new UpstreamAuth({ store, environment: 'local', grantOwner: 'dsh' });
  await shared.seed('notion', {
    accessToken: 'AT_0', refreshToken: 'RT_0', clientId: 'CID',
    expiresAt: Date.now() - 1000, source: DSH_GRANT_SOURCE, grantOwner: 'dsh',
  });
  let providerCalls = 0;
  const auth = new UpstreamAuth({
    store, grantOwner: 'dsh',
    fetch: tokenFetch(() => { providerCalls++; throw new Error('must not be called'); }),
  });
  await auth.getAccessToken('notion', { ...ENV, grantOwner: undefined, source: DSH_GRANT_SOURCE }, { force: true });
  assert.equal(providerCalls, 0);
  assert.equal((await auth.getAuthStatus('notion')).reason, SHARED_GRANT_REFRESH_FORBIDDEN);
});

test('G3: grant records always live in explicit v2 env+owner namespaces', () => {
  const gateway = new UpstreamAuth({ store: fakeStore(), environment: 'production' });
  const shared = new UpstreamAuth({ store: fakeStore(), environment: 'production', grantOwner: 'dsh' });
  assert.equal(gateway._key('notion'), 'gmcgw:v2:grant:production:gateway:notion');
  assert.equal(shared._key('notion'), 'gmcgw:v2:grant:production:dsh:notion');
  const previewShared = new UpstreamAuth({
    store: fakeStore(), environment: 'preview', grantOwner: 'dsh',
  });
  assert.equal(previewShared._key('notion'), 'gmcgw:v2:grant:preview:dsh:notion');
  // R4: legacy v1 keys are read-only aliases, never a write target.
  assert.equal(gateway._legacyKey('notion'), 'gmcgw:v1:upstream:notion');
  assert.equal(previewShared._legacyKey('notion'), null);
});

test('G4: explicit long-lived access token path works without any refresh grant', async () => {
  const store = fakeStore();
  let providerCalls = 0;
  const auth = new UpstreamAuth({
    store,
    fetch: tokenFetch(() => { providerCalls++; throw new Error('must not be called'); }),
  });
  // A long-lived PAT: tokenEnv present, no refreshEnv/clientId for the seed.
  const tok = await auth.getAccessToken('notion', {
    envToken: 'ntn_longlived_pat', envExpiresIn: 0, envObtainedAt: 0,
  });
  assert.equal(tok, 'ntn_longlived_pat');
  assert.equal(providerCalls, 0);
  assert.equal(store._data.size, 0, 'no grant record for a pure long-lived token');
});

test('G5: gateway-authorized grant (explicit owner) DOES refresh normally', async () => {
  const store = fakeStore();
  let calls = 0;
  const auth = new UpstreamAuth({
    store,
    fetch: tokenFetch(() => {
      calls++;
      return { ok: true, json: async () => ({ access_token: `AT_${calls}`, refresh_token: `RT_${calls}`, expires_in: 3600 }) };
    }),
  });
  const tok = await auth.getAccessToken('notion', { ...ENV, source: 'gateway-oauth' });
  assert.equal(tok, 'AT_1');
  assert.equal(calls, 1);
  assert.equal(JSON.parse(store._data.get(KEY)).owner, 'gateway');
  assert.notEqual((await auth.getAuthStatus('notion')).status, REAUTH_REQUIRED);
});
