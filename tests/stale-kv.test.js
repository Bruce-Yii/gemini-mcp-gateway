import test from 'node:test';
import assert from 'node:assert/strict';
import { UpstreamAuth } from '../src/upstream-auth.js';

test('stale KV record is replaced by fresh env token', async () => {
  const mem = new Map();
  const store = {
    isConfigured: () => true,
    _command: async (...a) => {
      const [c, k, v] = a;
      if (c === 'get') return mem.get(k) ?? null;
      if (c === 'set') { mem.set(k, v); return 'OK'; }
      return null;
    },
  };
  // Pre-seed a STALE record with a revoked refresh token
  mem.set('gmcgw:v2:grant:local:gateway:notion', JSON.stringify({
    access_token: 'OLD_EXPIRED', refresh_token: 'OLD_REVOKED', client_id: 'old', expires_at: 0,
    owner: 'gateway', source: 'gateway-oauth', environment: 'local',
  }));
  let refreshedWith = null;
  const auth = new UpstreamAuth({
    store,
    fetch: async (url, opts) => {
      refreshedWith = new URLSearchParams(opts.body).get('refresh_token');
      return { ok: true, json: async () => ({ access_token: 'FRESH', refresh_token: 'NEWREF', expires_in: 3600 }) };
    },
  });
  const tok = await auth.getAccessToken('notion', {
    envToken: 'NEW_ENV_TOKEN', envRefresh: 'NEW_ENV_REFRESH', envClientId: 'NEW_CID', envExpiresIn: 28800,
    grantOwner: 'gateway', source: 'gateway-oauth',
  });
  assert.equal(refreshedWith, 'NEW_ENV_REFRESH', 'must refresh with the env refresh token, not stale KV');
  assert.equal(tok, 'FRESH');
});
