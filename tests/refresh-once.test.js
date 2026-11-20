import test from 'node:test';
import assert from 'node:assert/strict';
import { UpstreamAuth } from '../src/upstream-auth.js';

test('refresh happens once after bootstrap, not on every call (rotating token safe)', async () => {
  const mem = new Map();
  const store = {
    isConfigured: () => true,
    _command: async (...a) => {
      const [cmd, key, val] = a;
      if (cmd === 'get') return mem.get(key) ?? null;
      if (cmd === 'set') { mem.set(key, val); return 'OK'; }
      return null;
    },
  };
  let refreshCount = 0;
  let currentRefresh = 'REFRESH_0';
  const auth = new UpstreamAuth({
    store,
    fetch: async () => {
      refreshCount++;
      currentRefresh = 'REFRESH_' + refreshCount;
      return { ok: true, json: async () => ({ access_token: 'ACCESS_' + refreshCount, refresh_token: currentRefresh, expires_in: 28800 }) };
    },
  });
  const env = { envToken: 'ENV_TOKEN', envRefresh: 'ENV_REFRESH', envClientId: 'CID', envExpiresIn: 28800, envObtainedAt: Date.now() };

  // first call: bootstrap + forced refresh once
  await auth.getAccessToken('notion', env);
  assert.equal(refreshCount, 1, 'first call refreshes once');

  // subsequent calls with SAME env seed: must NOT refresh again
  await auth.getAccessToken('notion', env);
  await auth.getAccessToken('notion', env);
  assert.equal(refreshCount, 1, `should still be 1 after repeated calls, got ${refreshCount}`);

  // simulate a genuinely new deployed token -> one refresh
  await auth.getAccessToken('notion', { ...env, envToken: 'NEW_ENV_TOKEN' });
  assert.equal(refreshCount, 2, 'new env seed triggers exactly one more refresh');
});
