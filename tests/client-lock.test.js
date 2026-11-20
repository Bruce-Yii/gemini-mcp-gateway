import test from 'node:test';
import assert from 'node:assert/strict';
import { createOAuthHandlers } from '../src/oauth.js';

function fakeStore() {
  const data = new Map();
  return {
    isConfigured: () => true,
    _command: async (...args) => {
      const [cmd, key, val] = args;
      if (cmd === 'get') return data.get(key) ?? null;
      if (cmd === 'set') { data.set(key, val); return 'OK'; }
      if (cmd === 'getdel') { const v = data.get(key) ?? null; data.delete(key); return v; }
      return null;
    },
    saveClient: async (id, r) => data.set('c:' + id, r),
    getClient: async (id) => data.get('c:' + id) ?? null,
    saveCode: async (c, r) => data.set('code:' + c, r),
    takeCode: async (c) => { const v = data.get('code:' + c) ?? null; data.delete('code:' + c); return v; },
    saveToken: async () => {}, saveRefresh: async () => {},
  };
}
function res() {
  return { status: 0, headers: {}, body: '', writeHead(s, h) { this.status = s; this.headers = h; }, setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = b ?? ''; }, get headersSent() { return this.status > 0; } };
}
const CID = 'gmc_mysecretclient', SEC = 'supersecretvalue';

test('locked: metadata hides registration_endpoint', async () => {
  const o = createOAuthHandlers(fakeStore(), { allowedClientId: CID, allowedClientSecret: SEC, baseUrl: 'https://x' });
  const r = res(); await o.metadata({}, r);
  const doc = JSON.parse(r.body);
  assert.equal(doc.registration_endpoint, undefined);
  assert.ok(doc.token_endpoint);
});

test('locked: DCR register is rejected', async () => {
  const o = createOAuthHandlers(fakeStore(), { allowedClientId: CID, allowedClientSecret: SEC, baseUrl: 'https://x' });
  const r = res();
  await o.register({ method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', [Symbol.asyncIterator]: async function*(){ yield '{}'; } }, r);
  assert.equal(r.status, 403);
});

test('unlocked: metadata exposes registration_endpoint (backward compatible)', async () => {
  const o = createOAuthHandlers(fakeStore(), { baseUrl: 'https://x' });
  const r = res(); await o.metadata({}, r);
  assert.ok(JSON.parse(r.body).registration_endpoint);
});
