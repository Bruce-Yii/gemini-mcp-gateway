import test from 'node:test';
import assert from 'node:assert/strict';
import { UpstreamAuth } from '../src/upstream-auth.js';

// Fake in-memory store (mirrors the _command interface UpstreamAuth uses).
function fakeStore() {
  const data = new Map();
  return {
    isConfigured: () => true,
    _command: async (...args) => {
      const [cmd, key, value] = args;
      if (cmd === 'get') return data.get(key) ?? null;
      if (cmd === 'set') { data.set(key, value); return 'OK'; }
      return null;
    },
    _data: data,
  };
}

test('long-lived token (github) is returned unchanged, no KV/refresh', async () => {
  const auth = new UpstreamAuth({ store: fakeStore() });
  assert.equal(await auth.getAccessToken('github', { envToken: 'ghp_x' }), 'ghp_x');
});

test('notion first run bootstraps from env and returns env token', async () => {
  const store = fakeStore();
  const auth = new UpstreamAuth({ store });
  const tok = await auth.getAccessToken('notion', {
    envToken: 'access-1', envRefresh: 'refresh-1', envClientId: 'cid-1',
  });
  assert.equal(tok, 'access-1');
  const rec = JSON.parse(store._data.get('gmcgw:v1:upstream:notion'));
  assert.equal(rec.refresh_token, 'refresh-1');
  assert.equal(rec.client_id, 'cid-1');
});

test('notion expired token triggers refresh and persists rotated pair', async () => {
  const store = fakeStore();
  const calls = [];
  const mockFetch = async (url, opts) => {
    calls.push({ url, body: opts.body });
    return {
      ok: true,
      json: async () => ({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600 }),
    };
  };
  const auth = new UpstreamAuth({ store, fetch: mockFetch });
  // Seed an expired record
  await auth.seed('notion', { accessToken: 'old', refreshToken: 'refresh-1', clientId: 'cid-1', expiresAt: Date.now() - 10000 });
  const tok = await auth.getAccessToken('notion', { envToken: 'x' });
  assert.equal(tok, 'access-2');
  assert.equal(calls.length, 1);
  const rec = JSON.parse(store._data.get('gmcgw:v1:upstream:notion'));
  assert.equal(rec.access_token, 'access-2');
  assert.equal(rec.refresh_token, 'refresh-2'); // rotated value persisted
  assert.ok(rec.expires_at > Date.now());
});

test('valid token is returned without refresh call', async () => {
  const store = fakeStore();
  let called = false;
  const auth = new UpstreamAuth({
    store,
    fetch: async () => { called = true; return { ok: true, json: async () => ({}) }; },
  });
  await auth.seed('linear', { accessToken: 'valid', refreshToken: 'r', clientId: 'c', expiresIn: 3600 });
  const tok = await auth.getAccessToken('linear', {});
  assert.equal(tok, 'valid');
  assert.equal(called, false);
});
