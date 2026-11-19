import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { createOAuthHandlers, isValidGoogleRedirectUri } from '../src/oauth.js';
import { createAppHandler } from '../src/vercel-app.js';

// ---------------------------------------------------------------------------
// In-memory stand-in for TokenStore: no network, no real credentials.
// ---------------------------------------------------------------------------

class MemoryStore {
  constructor() {
    this.map = new Map();
  }

  async saveClient(id, record) {
    this.map.set(`client:${id}`, structuredClone(record));
  }

  async getClient(id) {
    return this.map.get(`client:${id}`) ?? null;
  }

  async saveCode(code, record) {
    this.map.set(`code:${code}`, structuredClone(record));
  }

  peekCode(code) {
    return this.map.get(`code:${code}`) ?? null;
  }

  async takeCode(code) {
    const record = this.map.get(`code:${code}`) ?? null;
    this.map.delete(`code:${code}`);
    return record;
  }

  async saveToken(token, record) {
    this.map.set(`token:${token}`, structuredClone(record));
  }

  async getToken(token) {
    return this.map.get(`token:${token}`) ?? null;
  }

  async saveRefresh(refreshToken, record) {
    this.map.set(`refresh:${refreshToken}`, structuredClone(record));
  }

  async getRefresh(refreshToken) {
    return this.map.get(`refresh:${refreshToken}`) ?? null;
  }

  async revokeToken(token) {
    this.map.delete(`token:${token}`);
    this.map.delete(`refresh:${token}`);
  }
}

function makeReq({ method = 'GET', url = '/', headers = {}, body } = {}) {
  let raw = '';
  if (body !== undefined && body !== null) {
    raw = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const chunks = raw ? [Buffer.from(raw, 'utf8')] : [];
  return {
    method,
    url,
    headers: { host: 'gateway.example', ...headers },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    headersSent: false,
    ended: false,
    body: '',
    writeHead(status, headers = {}) {
      this.statusCode = status;
      for (const [key, value] of Object.entries(headers)) {
        this.headers[key.toLowerCase()] = value;
      }
      this.headersSent = true;
      return this;
    },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) this.body += chunk.toString();
      this.ended = true;
      return this;
    },
    getHeader(key) {
      return this.headers[key.toLowerCase()];
    },
  };
}

async function invoke(handler, options = {}) {
  const req = makeReq(options);
  const res = makeRes();
  await handler(req, res);
  return res;
}

function jsonBody(res) {
  return JSON.parse(res.body);
}

function formBody(fields) {
  return new URLSearchParams(fields).toString();
}

/** Pull the target URL out of the 200 + meta-refresh consent response. */
function extractRedirectUrl(html) {
  const match = /http-equiv="refresh" content="0;url=([^"]*)"/i.exec(html);
  assert.ok(match, 'expected a meta refresh redirect page');
  return match[1]
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'");
}

// ---------------------------------------------------------------------------
// fixtures & flow helpers
// ---------------------------------------------------------------------------

const REDIRECTS = [
  'https://oauth-redirect.googleusercontent.com/r/111111111',
  'https://oauth-redirect.googleusercontent.com/a/222222222',
  'https://oauth-redirect-sandbox.googleusercontent.com/r/333333333',
  'https://oauth-redirect-sandbox.googleusercontent.com/a/444444444',
  'https://oauth-redirect-test.googleusercontent.com/r/555555555',
  'https://oauth-redirect-test.googleusercontent.com/a/666666666',
];

function makeOAuth() {
  const store = new MemoryStore();
  const oauth = createOAuthHandlers(store, { baseUrl: 'https://gateway.example' });
  return { store, oauth };
}

async function registerClient(oauth, redirects = REDIRECTS) {
  const res = await invoke(oauth.register, {
    method: 'POST',
    url: '/oauth/register',
    headers: { 'content-type': 'application/json' },
    body: {
      client_name: 'Google',
      redirect_uris: redirects,
      response_types: ['code'],
      grant_types: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_method: 'client_secret_post',
    },
  });
  assert.equal(res.statusCode, 200, res.body);
  return jsonBody(res);
}

async function startAuthorization(oauth, clientId, { state, verifier, redirectUri = REDIRECTS[0] }) {
  const codeChallenge = createHash('sha256').update(verifier).digest('base64url');
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: 'mcp',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  }).toString();

  const consent = await invoke(oauth.authorize, {
    method: 'GET',
    url: `/oauth/authorize?${query}`,
  });
  assert.equal(consent.statusCode, 200, consent.body);
  assert.match(consent.body, /<form method="post" action="\/oauth\/authorize">/);
  assert.ok(!/content-security-policy/i.test(JSON.stringify(consent.headers)), 'no CSP on consent page');

  const approved = await invoke(oauth.authorize, {
    method: 'POST',
    url: '/oauth/authorize',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: formBody({
      client_id: clientId,
      redirect_uri: redirectUri,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      scope: 'mcp',
      response_type: 'code',
    }),
  });
  assert.equal(approved.statusCode, 200, approved.body);

  const location = extractRedirectUrl(approved.body);
  const parsed = new URL(location);
  return {
    location,
    code: parsed.searchParams.get('code'),
    state: parsed.searchParams.get('state'),
    codeChallenge,
    verifier,
    clientId,
    redirectUri,
  };
}

async function exchangeCode(oauth, flow, verifier = flow.verifier) {
  return invoke(oauth.token, {
    method: 'POST',
    url: '/oauth/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: formBody({
      grant_type: 'authorization_code',
      code: flow.code,
      redirect_uri: flow.redirectUri,
      client_id: flow.clientId,
      code_verifier: verifier,
    }),
  });
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

test('DCR: all six Google redirect URIs accepted, foreign hosts rejected, registration idempotent', async () => {
  const { store, oauth } = makeOAuth();

  for (const uri of REDIRECTS) {
    assert.equal(isValidGoogleRedirectUri(uri), true, uri);
  }

  const first = await registerClient(oauth);
  assert.equal(first.redirect_uris.length, 6);
  assert.deepEqual(first.redirect_uris, REDIRECTS);
  assert.deepEqual((await store.getClient(first.client_id)).redirectUris, REDIRECTS);

  const second = await registerClient(oauth);
  assert.equal(second.client_id, first.client_id, 'same redirect set must yield the same client');

  const foreign = await invoke(oauth.register, {
    method: 'POST',
    url: '/oauth/register',
    headers: { 'content-type': 'application/json' },
    body: { client_name: 'Google', redirect_uris: ['https://evil.example.com/r/1'] },
  });
  assert.equal(foreign.statusCode, 400);
  assert.equal(jsonBody(foreign).error, 'invalid_redirect_uri');

  const mixed = await invoke(oauth.register, {
    method: 'POST',
    url: '/oauth/register',
    headers: { 'content-type': 'application/json' },
    body: { client_name: 'Google', redirect_uris: [...REDIRECTS, 'https://evil.example.com/a/9'] },
  });
  assert.equal(mixed.statusCode, 400);
});

test('authorize: ~1400-char state preserved verbatim and PKCE S256 challenge stored on the code', async () => {
  const { store, oauth } = makeOAuth();
  const { client_id: clientId } = await registerClient(oauth);

  // 9 * 158 = 1422 chars, all base64url-safe so even the raw URL bytes match.
  const state = 'aB3xY9-_0'.repeat(158);
  assert.equal(state.length, 1422);
  const verifier = `verifier-${'v'.repeat(64)}`;

  const flow = await startAuthorization(oauth, clientId, { state, verifier });

  assert.equal(flow.state.length, 1422);
  assert.equal(flow.state, state);
  assert.equal(
    Buffer.from(flow.state, 'utf8').toString('hex'),
    Buffer.from(state, 'utf8').toString('hex'),
    'state bytes must be identical',
  );
  assert.ok(flow.location.includes(`state=${state}`), 'raw state must appear verbatim in redirect URL');

  const record = store.peekCode(flow.code);
  assert.ok(record, 'a code record must be stored at authorize time');
  assert.equal(record.state, state);
  assert.equal(record.codeChallenge, flow.codeChallenge);
  assert.equal(record.codeChallengeMethod, 'S256');
});

test('token: correct verifier succeeds, wrong verifier rejected, code is single-use', async () => {
  const { store, oauth } = makeOAuth();
  const { client_id: clientId } = await registerClient(oauth);

  const goodFlow = await startAuthorization(oauth, clientId, {
    state: 'good-state',
    verifier: `correct-${'c'.repeat(64)}`,
  });
  const badFlow = await startAuthorization(oauth, clientId, {
    state: 'bad-state',
    verifier: `correct-${'d'.repeat(64)}`,
  });

  const wrong = await exchangeCode(oauth, badFlow, `wrong-${'w'.repeat(64)}`);
  assert.equal(wrong.statusCode, 400);
  assert.equal(jsonBody(wrong).error, 'invalid_grant');
  assert.equal(store.peekCode(badFlow.code), null, 'a rejected code must also be consumed');

  const ok = await exchangeCode(oauth, goodFlow);
  assert.equal(ok.statusCode, 200, ok.body);
  const tokens = jsonBody(ok);
  assert.equal(tokens.token_type, 'Bearer');
  assert.ok(tokens.access_token && tokens.refresh_token);
  assert.ok(tokens.expires_in > 0);
  assert.ok(await store.getToken(tokens.access_token));
  assert.ok(await store.getRefresh(tokens.refresh_token));

  const replay = await exchangeCode(oauth, goodFlow);
  assert.equal(replay.statusCode, 400);
  assert.equal(jsonBody(replay).error, 'invalid_grant');
});

test('refresh: returns the same refresh token and the old one stays valid (no rotation)', async () => {
  const { store, oauth } = makeOAuth();
  const { client_id: clientId } = await registerClient(oauth);
  const flow = await startAuthorization(oauth, clientId, {
    state: 'refresh-state',
    verifier: `refresh-${'r'.repeat(64)}`,
  });
  const initial = jsonBody(await exchangeCode(oauth, flow));

  const refreshOnce = await invoke(oauth.token, {
    method: 'POST',
    url: '/oauth/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: formBody({
      grant_type: 'refresh_token',
      refresh_token: initial.refresh_token,
      client_id: clientId,
    }),
  });
  assert.equal(refreshOnce.statusCode, 200, refreshOnce.body);
  const once = jsonBody(refreshOnce);
  assert.equal(once.refresh_token, initial.refresh_token, 'refresh token must NOT rotate');
  assert.notEqual(once.access_token, initial.access_token);

  const refreshTwice = await invoke(oauth.token, {
    method: 'POST',
    url: '/oauth/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: formBody({
      grant_type: 'refresh_token',
      refresh_token: initial.refresh_token,
      client_id: clientId,
    }),
  });
  assert.equal(refreshTwice.statusCode, 200);
  assert.equal(jsonBody(refreshTwice).refresh_token, initial.refresh_token);
  assert.ok(await store.getRefresh(initial.refresh_token), 'old refresh token must remain valid');
});

test('well-known metadata endpoints return 200 directly with the required fields', async () => {
  const { store, oauth } = makeOAuth();

  const metadataRes = await invoke(oauth.metadata, {
    method: 'GET',
    url: '/.well-known/oauth-authorization-server',
  });
  assert.equal(metadataRes.statusCode, 200);
  const meta = jsonBody(metadataRes);
  for (const key of [
    'authorization_endpoint',
    'token_endpoint',
    'registration_endpoint',
    'grant_types_supported',
    'response_types_supported',
    'code_challenge_methods_supported',
    'scopes_supported',
  ]) {
    assert.ok(meta[key], `${key} must be present`);
  }
  assert.deepEqual(meta.response_types_supported, ['code']);
  assert.ok(meta.code_challenge_methods_supported.includes('S256'));
  assert.ok(meta.grant_types_supported.includes('authorization_code'));
  assert.ok(meta.grant_types_supported.includes('refresh_token'));

  const resourceRes = await invoke(oauth.protectedResource, {
    method: 'GET',
    url: '/.well-known/oauth-protected-resource',
  });
  assert.equal(resourceRes.statusCode, 200);
  const resource = jsonBody(resourceRes);
  assert.ok(resource.resource.endsWith('/mcp'));
  assert.ok(Array.isArray(resource.authorization_servers) && resource.authorization_servers.length > 0);

  // Routed through the real Vercel app: the first well-known URL must be 200.
  const app = createAppHandler({
    store,
    baseUrl: 'https://gateway.example',
    mcpHandler: async () => {},
  });
  const routed = await invoke(app, {
    method: 'GET',
    url: '/.well-known/oauth-authorization-server',
  });
  assert.equal(routed.statusCode, 200, routed.body);
});

test('/mcp without a bearer token returns 401 with WWW-Authenticate pointing at protected-resource metadata', async () => {
  const store = new MemoryStore();
  let mcpCalls = 0;
  const app = createAppHandler({
    store,
    baseUrl: 'https://gateway.example',
    mcpHandler: async () => {
      mcpCalls += 1;
    },
  });

  const missing = await invoke(app, {
    method: 'POST',
    url: '/mcp',
    headers: { 'content-type': 'application/json' },
    body: { jsonrpc: '2.0', method: 'initialize', id: 1 },
  });
  assert.equal(missing.statusCode, 401);
  assert.equal(
    missing.getHeader('www-authenticate'),
    'Bearer resource_metadata="https://gateway.example/.well-known/oauth-protected-resource"',
  );
  assert.equal(mcpCalls, 0);

  const invalid = await invoke(app, {
    method: 'POST',
    url: '/mcp',
    headers: { authorization: 'Bearer not-a-real-token' },
  });
  assert.equal(invalid.statusCode, 401);
  assert.equal(mcpCalls, 0);

  await store.saveToken('valid-access-token', {
    clientId: 'gmc_test',
    expiresAt: Date.now() + 60_000,
  });
  const valid = await invoke(app, {
    method: 'POST',
    url: '/mcp',
    headers: { authorization: 'Bearer valid-access-token' },
  });
  assert.equal(mcpCalls, 1, 'a valid token must reach the delegated MCP handler');
});
