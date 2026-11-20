import test from 'node:test';
import assert from 'node:assert/strict';
import { UpstreamAuth } from '../src/upstream-auth.js';

test('invalid_grant stops refreshing (no rebootstrap loop) and marks needsReauth', async () => {
  const mem = new Map();
  const store = {
    isConfigured: () => true,
    _command: async (...a) => {
      const [cmd, key, val, ...rest] = a;
      if (cmd === 'get') return mem.get(key) ?? null;
      if (cmd === 'set') { if (rest.includes('NX') && mem.has(key)) return null; mem.set(key, val); return 'OK'; }
      if (cmd === 'del') { mem.delete(key); return 1; }
      return null;
    },
  };
  let refreshCalls = 0;
  let verifyCalls = 0;
  const auth = new UpstreamAuth({
    store,
    fetch: async (url, opts) => {
      const raw = typeof opts?.body === 'string' ? opts.body : String(opts?.body ?? '');
      if (raw.includes('grant_type=refresh_token')) {
        refreshCalls++;
        return { ok: false, json: async () => ({ error: 'invalid_grant', error_description: 'grant revoked' }) };
      }
      // _verifyToken call (tools/list)
      verifyCalls++;
      return { ok: false }; // env token also invalid -> must NOT rebootstrap
    },
  });
  const env = { envToken: 'ENV_TOKEN', envRefresh: 'ENV_REF', envClientId: 'CID', envExpiresIn: 28800, envObtainedAt: Date.now() - 9 * 3600 * 1000 };

  await auth.getAccessToken('notion', env);
  assert.equal(refreshCalls, 1, 'one refresh attempt');
  const rec1 = JSON.parse(mem.get('gmcgw:v1:upstream:notion'));
  assert.equal(rec1.needsReauth, true, 'grant marked needsReauth');

  // second call: same env token -> must NOT refresh again (backoff)
  await auth.getAccessToken('notion', env);
  assert.equal(refreshCalls, 1, 'no additional refresh attempts after invalid_grant');
});
