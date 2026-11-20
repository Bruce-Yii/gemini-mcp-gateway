import test from 'node:test';
import assert from 'node:assert/strict';
import { UpstreamAuth } from '../src/upstream-auth.js';

test('CAS fencing: stale refresh result does not overwrite winner token', async () => {
  // Simulate a KV store with casToken semantics
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
    casToken: async (key, expectedRefresh, nextJson) => {
      const cur = mem.get(key);
      if (!cur) return false;
      const obj = JSON.parse(cur);
      if (String(obj.refresh_token) !== String(expectedRefresh)) return false;
      mem.set(key, nextJson);
      return true;
    },
  };
  let refreshN = 0;
  const auth = new UpstreamAuth({
    store,
    fetch: async (url, opts) => {
      const raw = String(opts?.body ?? '');
      if (raw.includes('grant_type=refresh_token')) {
        refreshN++;
        return { ok: true, json: async () => ({ access_token: 'AT_' + refreshN, refresh_token: 'RT_' + refreshN, expires_in: 28800 }) };
      }
      return { ok: false };
    },
  });
  // Seed an expired-but-needs-refresh record
  mem.set('gmcgw:v1:upstream:notion', JSON.stringify({
    access_token: 'AT_old', refresh_token: 'RT_old', client_id: 'CID',
    expires_at: Date.now() - 1000, bootstrapped: false, envSeed: 'ENV',
  }));

  // Worker A refreshes -> wins CAS (writes AT_1/RT_1)
  const a = await auth._refresh('notion', { refresh_token: 'RT_old', client_id: 'CID', envSeed: 'ENV' });
  assert.equal(a.access_token, 'AT_1');

  // Worker B's stale refresh result (based on RT_old) must LOSE the CAS because
  // KV now holds RT_1. It should be handed winner's token instead.
  const b = await auth._refresh('notion', { refresh_token: 'RT_old', client_id: 'CID', envSeed: 'ENV' });
  assert.equal(b.access_token, 'AT_1', 'stale worker must get winner token, not its own AT_2');
  const final = JSON.parse(mem.get('gmcgw:v1:upstream:notion'));
  assert.equal(final.refresh_token, 'RT_1', 'KV must still hold winner refresh token');
});
