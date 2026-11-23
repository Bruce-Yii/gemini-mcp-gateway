import test from 'node:test';
import assert from 'node:assert/strict';

import { createUpstreamOAuthHandlers } from '../src/upstream-oauth.js';
import { createAppHandler } from '../src/vercel-app.js';

const CONFIG = {
  servers: [
    {
      name: 'figma',
      transport: 'http',
      url: 'https://mcp.figma.com/mcp',
      authorizeUrl: 'https://www.figma.com/oauth/mcp',
      oauthScopes: ['mcp:connect'],
      refreshUrl: 'https://api.figma.com/v1/oauth/token',
      clientIdEnv: 'FIGMA_CLIENT_ID',
      clientSecretEnv: 'FIGMA_CLIENT_SECRET',
    },
  ],
};

class MemoryStore {
  constructor() {
    this.values = new Map();
    this.states = new Map();
  }
  isConfigured() { return true; }
  async saveOAuthState(state, record) { this.states.set(state, record); }
  async takeOAuthState(state) {
    const record = this.states.get(state) ?? null;
    this.states.delete(state);
    return record;
  }
  async _command(...args) {
    if (args[0] === 'set') { this.values.set(args[1], args[2]); return 'OK'; }
    if (args[0] === 'get') return this.values.get(args[1]) ?? null;
    if (args[0] === 'del') { this.values.delete(args[1]); return 1; }
    if (args[0] === 'getdel') {
      const value = this.values.get(args[1]) ?? null;
      this.values.delete(args[1]);
      return value;
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

const req = { headers: { host: 'gw.example' }, socket: {} };
const options = { baseUrl: 'https://gw.example' };

function handlers(store, fetchImpl) {
  return createUpstreamOAuthHandlers({
    store,
    getConfig: async () => CONFIG,
    options,
    fetch: fetchImpl,
  });
}

test('upstream OAuth: start redirects with PKCE and stores single-use state', async () => {
  process.env.FIGMA_CLIENT_ID = 'figma-client';
  process.env.FIGMA_CLIENT_SECRET = 'figma-secret';
  process.env.UPSTREAM_OAUTH_ADMIN_KEY = 'admin-secret';
  const store = new MemoryStore();
  const res = mockRes();
  await handlers(store).start(req, res, new URL('https://gw.example/upstream/oauth/start?server=figma&key=admin-secret'));
  assert.equal(res.state.status, 302);
  const location = new URL(res.state.headers.location);
  assert.equal(location.origin + location.pathname, 'https://www.figma.com/oauth/mcp');
  assert.equal(location.searchParams.get('client_id'), 'figma-client');
  // R5: redirect carries the environment so the callback can use the
  // environment-scoped state key (local by default per R2).
  const redirectUri = new URL(location.searchParams.get('redirect_uri'));
  assert.equal(redirectUri.origin + redirectUri.pathname, 'https://gw.example/upstream/oauth/callback');
  assert.equal(redirectUri.searchParams.get('env'), 'local');
  assert.equal(location.searchParams.get('scope'), 'mcp:connect');
  assert.equal(location.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(location.searchParams.get('code_challenge'));
  const state = location.searchParams.get('state');
  assert.ok(store.states.has(state));
  delete process.env.UPSTREAM_OAUTH_ADMIN_KEY;
});

test('upstream OAuth: callback exchanges the code and seeds the upstream token', async () => {
  process.env.FIGMA_CLIENT_ID = 'figma-client';
  process.env.FIGMA_CLIENT_SECRET = 'figma-secret';
  process.env.UPSTREAM_OAUTH_ADMIN_KEY = 'admin-secret';
  const store = new MemoryStore();
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600 }),
    };
  };
  const api = handlers(store, fakeFetch);

  const startRes = mockRes();
  await api.start(req, startRes, new URL('https://gw.example/upstream/oauth/start?server=figma&key=admin-secret'));
  const state = new URL(startRes.state.headers.location).searchParams.get('state');

  const callbackRes = mockRes();
  await api.callback(req, callbackRes, new URL(`https://gw.example/upstream/oauth/callback?state=${state}&code=AUTH_CODE&env=local`));
  assert.equal(callbackRes.state.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.figma.com/v1/oauth/token');
  assert.match(String(calls[0].init.body), /code=AUTH_CODE/);
  assert.match(String(calls[0].init.headers.authorization), /^Basic /);
  // R3/R4: callback lands in the v2 env+owner namespace with full grant identity.
  const stored = JSON.parse(store.values.get('gmcgw:v2:grant:local:gateway:figma'));
  assert.equal(stored.access_token, 'AT');
  assert.equal(stored.refresh_token, 'RT');
  assert.equal(stored.client_id, 'figma-client');
  assert.equal(stored.client_secret, 'figma-secret');
  assert.equal(stored.environment, 'local');
  assert.equal(stored.owner, 'gateway');
  assert.equal(stored.source, 'gateway-oauth');
  assert.match(stored.grantId, /^gw:local:figma:/);

  // State is single use.
  const replayRes = mockRes();
  await api.callback(req, replayRes, new URL(`https://gw.example/upstream/oauth/callback?state=${state}&code=AUTH_CODE&env=local`));
  assert.equal(replayRes.state.status, 400);
  delete process.env.UPSTREAM_OAUTH_ADMIN_KEY;
});

test('upstream OAuth: disabled without admin key and rejects a wrong key', async () => {
  process.env.FIGMA_CLIENT_ID = 'figma-client';
  delete process.env.UPSTREAM_OAUTH_ADMIN_KEY;
  const disabled = mockRes();
  await handlers(new MemoryStore()).start(req, disabled, new URL('https://gw.example/upstream/oauth/start?server=figma'));
  assert.equal(disabled.state.status, 404);

  process.env.UPSTREAM_OAUTH_ADMIN_KEY = 'admin-secret';
  const wrong = mockRes();
  await handlers(new MemoryStore()).start(req, wrong, new URL('https://gw.example/upstream/oauth/start?server=figma&key=nope'));
  assert.equal(wrong.state.status, 403);
  delete process.env.UPSTREAM_OAUTH_ADMIN_KEY;
});

test('vercel app wires GET /upstream/oauth/start', async () => {
  delete process.env.UPSTREAM_OAUTH_ADMIN_KEY;
  const handler = createAppHandler({ config: CONFIG });
  const res = mockRes();
  await handler(
    { method: 'GET', url: '/upstream/oauth/start?server=figma', headers: { host: 'gw.example' } },
    res,
  );
  assert.equal(res.state.status, 404);
});
