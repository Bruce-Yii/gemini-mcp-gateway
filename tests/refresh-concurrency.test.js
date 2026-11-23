import test from 'node:test';
import assert from 'node:assert/strict';
import { UpstreamAuth } from '../src/upstream-auth.js';

test('concurrent getAccessToken across instances refreshes only once (rotation-safe)', async () => {
  const mem = new Map();
  const store = {
    isConfigured: () => true,
    _command: async (...a) => {
      const [cmd, key, val, ...rest] = a;
      if (cmd === 'get') return mem.get(key) ?? null;
      if (cmd === 'set') {
        // emulate NX: only set if not exists
        if (rest.includes('NX') && mem.has(key)) return null;
        mem.set(key, val); return 'OK';
      }
      if (cmd === 'del') { mem.delete(key); return 1; }
      return null;
    },
  };
  let refreshCount = 0;
  const mkFetch = () => async () => {
    refreshCount++;
    await new Promise(r => setTimeout(r, 100)); // simulate latency
    return { ok: true, json: async () => ({ access_token: 'ACCESS_' + refreshCount, refresh_token: 'REF_' + refreshCount, expires_in: 28800 }) };
  };
  const env = {
    envToken: 'ENV', envRefresh: 'ENV_REF', envClientId: 'CID',
    envExpiresIn: 28800, envObtainedAt: Date.now() - 9 * 3600 * 1000,
    grantOwner: 'gateway', source: 'gateway-oauth',
  }; // near expiry -> needs refresh
  const a1 = new UpstreamAuth({ store, fetch: mkFetch() });
  const a2 = new UpstreamAuth({ store, fetch: mkFetch() });

  const [r1, r2] = await Promise.all([
    a1.getAccessToken('notion', env),
    a2.getAccessToken('notion', env),
  ]);
  assert.equal(refreshCount, 1, `expected exactly 1 refresh, got ${refreshCount}`);
  assert.equal(r1, r2, 'both instances should see the same fresh token');
});
