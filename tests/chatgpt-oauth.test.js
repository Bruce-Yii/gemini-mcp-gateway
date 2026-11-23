/**
 * ChatGPT custom MCP connector OAuth regressions.
 *
 * Covers the additive ChatGPT support without weakening Gemini's contract:
 * redirect allowlist, RFC 9207 `iss`, metadata scopes, `resource` echo,
 * 401 `_meta["mcp/www_authenticate"]`, locked-mode DCR carve-out, tool
 * annotations/securitySchemes, and byte-for-byte state preservation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  createOAuthHandlers,
  isAllowedRedirectUri,
  isValidGoogleRedirectUri,
  isChatgptRedirectUri,
} from '../src/oauth.js';
import { createAppHandler } from '../src/vercel-app.js';
import { createGatewayServer } from '../src/server.js';

const STABLE = 'https://chatgpt.com/connector_platform_oauth_redirect';
const CALLBACK_ID = 'https://chatgpt.com/connector/oauth/abc123_XYZ-789';
const GOOGLE = 'https://oauth-redirect.googleusercontent.com/r/111111111';
const ISSUER = 'https://gateway.example';

class MemoryStore {
  constructor() {
    this.map = new Map();
  }
  async saveClient(id, record) { this.map.set(`client:${id}`, structuredClone(record)); }
  async getClient(id) { return this.map.get(`client:${id}`) ?? null; }
  async saveCode(code, record) { this.map.set(`code:${code}`, structuredClone(record)); }
  peekCode(code) { return this.map.get(`code:${code}`) ?? null; }
  async takeCode(code) {
    const record = this.map.get(`code:${code}`) ?? null;
    this.map.delete(`code:${code}`);
    return record;
  }
  async saveToken(token, record) { this.map.set(`token:${token}`, structuredClone(record)); }
  async getToken(token) { return this.map.get(`token:${token}`) ?? null; }
  async saveRefresh(token, record) { this.map.set(`refresh:${token}`, structuredClone(record)); }
  async getRefresh(token) { return this.map.get(`refresh:${token}`) ?? null; }
  async revokeToken(token) {
    this.map.delete(`token:${token}`);
    this.map.delete(`refresh:${token}`);
  }
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
      for (const [key, value] of Object.entries(headers)) this.headers[key.toLowerCase()] = value;
      this.headersSent = true;
      return this;
    },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) this.body += chunk.toString();
      this.ended = true;
      return this;
    },
    getHeader(key) { return this.headers[key.toLowerCase()]; },
  };
}

function makeReq({ method = 'GET', url = '/', headers = {}, body } = {}) {
  const raw = body === undefined || body === null
    ? ''
    : (typeof body === 'string' ? body : JSON.stringify(body));
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

async function invoke(handler, options = {}) {
  const res = makeRes();
  await handler(makeReq(options), res);
  return res;
}

const json = (res) => JSON.parse(res.body);
const form = (fields) => new URLSearchParams(fields).toString();

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

function makeOauth(extraOptions = {}) {
  const store = new MemoryStore();
  const oauth = createOAuthHandlers(store, { baseUrl: ISSUER, ...extraOptions });
  return { store, oauth };
}

async function register(oauth, redirects, extra = {}) {
  const res = await invoke(oauth.register, {
    method: 'POST',
    url: '/oauth/register',
    headers: { 'content-type': 'application/json' },
    body: {
      client_name: 'ChatGPT',
      redirect_uris: redirects,
      token_endpoint_auth_method: 'none',
      ...extra,
    },
  });
  return res;
}

async function authorizeFlow(oauth, clientId, { state, verifier, redirectUri, resource, extraParams = {} }) {
  const codeChallenge = createHash('sha256').update(verifier).digest('base64url');
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: 'mcp offline_access',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    ...(resource ? { resource } : {}),
    ...extraParams,
  }).toString();

  const consent = await invoke(oauth.authorize, { method: 'GET', url: `/oauth/authorize?${query}` });
  const approved = await invoke(oauth.authorize, {
    method: 'POST',
    url: '/oauth/authorize',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({
      client_id: clientId,
      redirect_uri: redirectUri,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      scope: 'mcp offline_access',
      response_type: 'code',
      ...(resource ? { resource } : {}),
    }),
  });
  assert.equal(approved.statusCode, 200, approved.body);
  const location = extractRedirectUrl(approved.body);
  const params = new URL(location).searchParams;
  return { location, code: params.get('code'), state: params.get('state'), iss: params.get('iss'), verifier, redirectUri };
}

// ---------------------------------------------------------------------------
// redirect allowlist
// ---------------------------------------------------------------------------

test('ChatGPT redirect allowlist: stable callback and /connector/oauth/<id> accepted', () => {
  for (const uri of [STABLE, CALLBACK_ID, 'https://chatgpt.com/connector/oauth/xyz']) {
    assert.equal(isAllowedRedirectUri(uri), true, uri);
    assert.equal(isChatgptRedirectUri(uri), true, uri);
    assert.equal(isValidGoogleRedirectUri(uri), true, 'legacy export is now the shared allowlist');
  }
  assert.equal(isChatgptRedirectUri(GOOGLE), false);
});

test('redirect allowlist rejects unknown hosts, http, userinfo, and malformed callback ids', () => {
  const denied = [
    'https://evil.example.com/connector/oauth/abc',
    'https://chatgpt.com.evil.example.com/connector/oauth/abc',
    'http://chatgpt.com/connector/oauth/abc',
    'https://user:pass@chatgpt.com/connector/oauth/abc',
    'https://chatgpt.com/connector/oauth/',
    'https://chatgpt.com/connector/oauth/../admin',
    'https://chatgpt.com/connector/oauth/abc/def',
    'https://chatgpt.com/connector_platform_oauth_redirect/../admin',
    'https://chatgpt.com/other/path',
    'not-a-url',
  ];
  for (const uri of denied) assert.equal(isAllowedRedirectUri(uri), false, uri);

  // Google's legacy prefix rule is preserved byte-for-byte (no tightening).
  assert.equal(isAllowedRedirectUri('https://oauth-redirect.googleusercontent.com/r/123/legacy'), true);
});

test('DCR, authorize and token all use the same redirect validator', async () => {
  const { oauth } = makeOauth();

  // DCR rejects an arbitrary host even with a ChatGPT-looking client name.
  const badRegister = await register(oauth, ['https://evil.example.com/connector/oauth/abc']);
  assert.equal(badRegister.statusCode, 400);
  assert.equal(json(badRegister).error, 'invalid_redirect_uri');

  const registered = await register(oauth, [CALLBACK_ID]);
  assert.equal(registered.statusCode, 200, registered.body);
  const clientId = json(registered).client_id;

  // authorize rejects an unregistered, disallowed redirect.
  const badAuthorize = await invoke(oauth.authorize, {
    method: 'GET',
    url: `/oauth/authorize?${new URLSearchParams({
      client_id: clientId,
      redirect_uri: 'https://evil.example.com/connector/oauth/abc',
      state: 's', code_challenge: 'c', code_challenge_method: 'S256', response_type: 'code',
    })}`,
  });
  assert.equal(badAuthorize.statusCode, 400);

  // token rejects a disallowed redirect_uri parameter.
  const flow = await authorizeFlow(oauth, clientId, {
    state: 'ok', verifier: `v-${'x'.repeat(40)}`, redirectUri: CALLBACK_ID,
  });
  const badToken = await invoke(oauth.token, {
    method: 'POST', url: '/oauth/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({
      grant_type: 'authorization_code', code: flow.code, client_id: clientId,
      redirect_uri: 'https://evil.example.com/connector/oauth/abc', code_verifier: flow.verifier,
    }),
  });
  assert.equal(badToken.statusCode, 400);
  assert.equal(json(badToken).error, 'invalid_grant');
});

// ---------------------------------------------------------------------------
// RFC 9207, metadata, resource echo
// ---------------------------------------------------------------------------

test('metadata advertises RFC 9207, S256, DCR and offline_access', async () => {
  const { oauth } = makeOauth();
  const res = await invoke(oauth.metadata, { method: 'GET', url: '/.well-known/oauth-authorization-server' });
  assert.equal(res.statusCode, 200);
  const meta = json(res);
  assert.equal(meta.issuer, ISSUER);
  assert.equal(meta.authorization_response_iss_parameter_supported, true);
  assert.equal(meta.issuer, ISSUER);
  assert.ok(meta.code_challenge_methods_supported.includes('S256'));
  assert.ok(meta.scopes_supported.includes('offline_access'));
  assert.ok(meta.scopes_supported.includes('mcp'));
  assert.ok(meta.registration_endpoint.endsWith('/oauth/register'));

  const protectedRes = await invoke(oauth.protectedResource, {
    method: 'GET', url: '/.well-known/oauth-protected-resource',
  });
  const protectedMeta = json(protectedRes);
  assert.deepEqual(protectedMeta.authorization_servers, [ISSUER]);
  assert.ok(protectedMeta.scopes_supported.includes('offline_access'));
});

test('authorize success and error redirects carry iss exactly equal to metadata issuer', async () => {
  const { store, oauth } = makeOauth();
  const registered = await register(oauth, [STABLE]);
  const clientId = json(registered).client_id;

  // Success response.
  const flow = await authorizeFlow(oauth, clientId, {
    state: 'iss-success', verifier: `v-${'s'.repeat(40)}`, redirectUri: STABLE,
    resource: `${ISSUER}/mcp`,
  });
  assert.equal(flow.iss, ISSUER);
  assert.equal(new URL(flow.location).searchParams.get('iss'), ISSUER);
  assert.ok(store.peekCode(flow.code), 'code must be issued');

  // Error response after a safe redirect is known (missing S256).
  const errorRes = await invoke(oauth.authorize, {
    method: 'GET',
    url: `/oauth/authorize?${new URLSearchParams({
      client_id: clientId,
      redirect_uri: STABLE,
      state: 'iss-error',
      response_type: 'code',
      // deliberately absent: code_challenge + S256
    })}`,
  });
  const errorLocation = extractRedirectUrl(errorRes.body);
  const errorParams = new URL(errorLocation).searchParams;
  assert.equal(errorParams.get('error'), 'invalid_request');
  assert.equal(errorParams.get('state'), 'iss-error');
  assert.equal(errorParams.get('iss'), ISSUER);

  // No safe redirect: JSON error, never a redirect to an attacker-controlled host.
  const noRedirect = await invoke(oauth.authorize, {
    method: 'GET',
    url: `/oauth/authorize?${new URLSearchParams({
      client_id: clientId,
      redirect_uri: 'https://evil.example.com/cb',
      state: 'no-redirect',
    })}`,
  });
  assert.equal(noRedirect.statusCode, 400);
  assert.equal(json(noRedirect).error, 'invalid_request');
});

test('token response echoes resource when requested; Gemini flow without resource is unchanged', async () => {
  const { oauth } = makeOauth();
  const chatgpt = json(await register(oauth, [STABLE]));

  const flow = await authorizeFlow(oauth, chatgpt.client_id, {
    state: 'resource-state', verifier: `v-${'r'.repeat(40)}`, redirectUri: STABLE,
    resource: `${ISSUER}/mcp`,
  });
  const tokenRes = await invoke(oauth.token, {
    method: 'POST', url: '/oauth/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({
      grant_type: 'authorization_code', code: flow.code, client_id: chatgpt.client_id,
      code_verifier: flow.verifier, redirect_uri: STABLE, resource: `${ISSUER}/mcp`,
    }),
  });
  assert.equal(tokenRes.statusCode, 200, tokenRes.body);
  const tokens = json(tokenRes);
  assert.equal(tokens.resource, `${ISSUER}/mcp`);
  assert.ok(tokens.refresh_token);
  assert.ok(tokens.scope.includes('offline_access'));

  // Refresh keeps the resource echo.
  const refreshed = json(await invoke(oauth.token, {
    method: 'POST', url: '/oauth/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: chatgpt.client_id }),
  }));
  assert.equal(refreshed.resource, `${ISSUER}/mcp`);

  // Gemini: existing flow with a Google redirect and no resource has no extra key.
  const gemini = json(await register(oauth, [GOOGLE], { client_name: 'Google', token_endpoint_auth_method: 'client_secret_post' }));
  const geminiFlow = await authorizeFlow(oauth, gemini.client_id, {
    state: 'gemini-state', verifier: `v-${'g'.repeat(40)}`, redirectUri: GOOGLE,
  });
  const geminiToken = json(await invoke(oauth.token, {
    method: 'POST', url: '/oauth/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({
      grant_type: 'authorization_code', code: geminiFlow.code, client_id: gemini.client_id,
      code_verifier: geminiFlow.verifier, redirect_uri: GOOGLE,
    }),
  }));
  assert.equal(Object.hasOwn(geminiToken, 'resource'), false);
});

// ---------------------------------------------------------------------------
// 401 _meta + tools/list auth metadata
// ---------------------------------------------------------------------------

test('401 /mcp body adds mcp/www_authenticate while preserving WWW-Authenticate header', async () => {
  const app = createAppHandler({
    store: new MemoryStore(),
    baseUrl: ISSUER,
    mcpHandler: async () => { throw new Error('must not reach MCP handler'); },
  });

  for (const headers of [{}, { authorization: 'Bearer invalid-token' }]) {
    const res = await invoke(app, {
      method: 'POST', url: '/mcp',
      headers: { 'content-type': 'application/json', ...headers },
      body: { jsonrpc: '2.0', method: 'tools/list', id: 1 },
    });
    assert.equal(res.statusCode, 401);
    assert.equal(
      res.getHeader('www-authenticate'),
      `Bearer resource_metadata="${ISSUER}/.well-known/oauth-protected-resource"`,
    );
    const body = json(res);
    assert.ok(body.error === 'invalid_request' || body.error === 'invalid_token');
    const challenges = body._meta?.['mcp/www_authenticate'];
    assert.ok(Array.isArray(challenges) && challenges.length === 1);
    assert.match(challenges[0], /resource_metadata=/);
    assert.match(challenges[0], /error=/);
    assert.match(challenges[0], /error_description=/);
  }
});

test('tools/list advertises readOnlyHint and oauth2 securitySchemes without changing tool names/schema', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

  const upstreamManager = {
    getEntries: () => [],
    getWhitelist: () => [],
    callTool: async () => ({}),
  };
  const server = createGatewayServer(upstreamManager, {});
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'chatgpt-test', version: '1' });
  await client.connect(clientTransport);

  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name), ['gateway_call', 'gateway_search']);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  assert.equal(byName.get('gateway_call').annotations.readOnlyHint, false);
  assert.equal(byName.get('gateway_search').annotations.readOnlyHint, true);
  for (const tool of tools) {
    assert.equal(typeof tool.annotations?.readOnlyHint, 'boolean', `${tool.name} needs readOnlyHint`);
    const schemes = tool._meta?.securitySchemes;
    assert.ok(Array.isArray(schemes) && schemes.some((s) => s.type === 'oauth2'), `${tool.name} needs oauth2 securitySchemes`);
    assert.ok(schemes.find((s) => s.type === 'oauth2').scopes.includes('mcp'));
    assert.equal(Object.hasOwn(tool.inputSchema ?? {}, 'type'), true, 'input schema must stay intact');
  }

  await client.close();
  await server.close();
});

// ---------------------------------------------------------------------------
// LOCKED-mode ChatGPT DCR carve-out + platform isolation
// ---------------------------------------------------------------------------

test('LOCKED mode: ChatGPT DCR carve-out works only with the explicit opt-in', async () => {
  const lockedOptions = { allowedClientId: 'gemini-locked-client', allowedClientSecret: 'gemini-secret' };

  const off = makeOauth({ ...lockedOptions, allowDcrForChatgpt: false });
  const denied = await register(off.oauth, [STABLE]);
  assert.equal(denied.statusCode, 403);
  assert.equal(json(denied).error, 'invalid_request');

  const on = makeOauth({ ...lockedOptions, allowDcrForChatgpt: true });
  const approved = await register(on.oauth, [CALLBACK_ID]);
  assert.equal(approved.statusCode, 200, approved.body);
  const client = json(approved);
  assert.ok(await on.store.getClient(client.client_id));
  assert.equal((await on.store.getClient(client.client_id)).platform, 'chatgpt');

  // Unknown / arbitrary hosts remain rejected even when the flag is on (the
  // carve-out only applies to ChatGPT-identifiable registrations).
  const evil = await register(on.oauth, ['https://evil.example.com/connector/oauth/abc']);
  assert.ok(evil.statusCode === 400 || evil.statusCode === 403);
  assert.ok(['invalid_redirect_uri', 'invalid_request'].includes(json(evil).error));

  // OAuth flow through the carve-out: no client secret required, PKCE S256.
  const flow = await authorizeFlow(on.oauth, client.client_id, {
    state: 'locked-chatgpt', verifier: `v-${'l'.repeat(40)}`, redirectUri: CALLBACK_ID,
  });
  assert.equal(flow.iss, ISSUER);
  const tokenRes = await invoke(on.oauth.token, {
    method: 'POST', url: '/oauth/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({
      grant_type: 'authorization_code', code: flow.code, client_id: client.client_id,
      code_verifier: flow.verifier, redirect_uri: CALLBACK_ID,
      // deliberately NO client_secret: ChatGPT DCR clients are public.
    }),
  });
  assert.equal(tokenRes.statusCode, 200, tokenRes.body);
  assert.ok(json(tokenRes).access_token);
});

test('LOCKED mode: Gemini locked client is untouched, unknown clients rejected, tokens are not interchangeable', async () => {
  const options = {
    allowedClientId: 'gemini-locked-client',
    allowedClientSecret: 'gemini-secret',
    allowDcrForChatgpt: true,
  };
  const { store, oauth } = makeOauth(options);

  // ChatGPT cannot register with the Gemini locked client id.
  const attempted = await invoke(oauth.register, {
    method: 'POST', url: '/oauth/register',
    headers: { 'content-type': 'application/json' },
    body: { client_name: 'ChatGPT', redirect_uris: [STABLE], client_id: options.allowedClientId },
  });
  assert.equal(attempted.statusCode, 200);
  assert.notEqual(json(attempted).client_id, options.allowedClientId, 'DCR must never overwrite the Gemini client');
  assert.equal(await store.getClient(options.allowedClientId), null, 'no Gemini client record was created');

  // Unknown client_id is rejected at authorize.
  const unknown = await invoke(oauth.authorize, {
    method: 'GET',
    url: `/oauth/authorize?${new URLSearchParams({
      client_id: 'totally-unknown', redirect_uri: STABLE, state: 's',
      code_challenge: 'c', code_challenge_method: 'S256', response_type: 'code',
    })}`,
  });
  assert.equal(unknown.statusCode, 400);
  assert.equal(json(unknown).error, 'invalid_client');

  // Gemini locked client keeps its Google-only redirect behaviour.
  const geminiCode = createHash('sha256').update('gemini-verifier').digest('base64url');
  const geminiQuery = new URLSearchParams({
    client_id: options.allowedClientId, redirect_uri: GOOGLE, state: 'gemini-locked',
    code_challenge: geminiCode, code_challenge_method: 'S256', response_type: 'code', scope: 'mcp',
  });
  const geminiConsent = await invoke(oauth.authorize, { method: 'GET', url: `/oauth/authorize?${geminiQuery}` });
  assert.equal(geminiConsent.statusCode, 200);
  const geminiApproved = await invoke(oauth.authorize, {
    method: 'POST', url: '/oauth/authorize',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({
      client_id: options.allowedClientId, redirect_uri: GOOGLE, state: 'gemini-locked',
      code_challenge: geminiCode, code_challenge_method: 'S256', scope: 'mcp', response_type: 'code',
    }),
  });
  const geminiLocation = extractRedirectUrl(geminiApproved.body);
  assert.equal(new URL(geminiLocation).searchParams.get('iss'), ISSUER);
  const geminiCodeValue = new URL(geminiLocation).searchParams.get('code');
  const geminiToken = await invoke(oauth.token, {
    method: 'POST', url: '/oauth/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({
      grant_type: 'authorization_code', code: geminiCodeValue, client_id: options.allowedClientId,
      client_secret: options.allowedClientSecret, code_verifier: 'gemini-verifier', redirect_uri: GOOGLE,
    }),
  });
  assert.equal(geminiToken.statusCode, 200, geminiToken.body);
  assert.equal(Object.hasOwn(json(geminiToken), 'resource'), false);

  // The Gemini locked client cannot use a ChatGPT callback.
  const mixed = await invoke(oauth.authorize, {
    method: 'GET',
    url: `/oauth/authorize?${new URLSearchParams({
      client_id: options.allowedClientId, redirect_uri: STABLE, state: 'mixed',
      code_challenge: geminiCode, code_challenge_method: 'S256', response_type: 'code',
    })}`,
  });
  assert.equal(mixed.statusCode, 400);
  assert.match(json(mixed).error_description, /Gemini client cannot use a ChatGPT redirect/);
});

// ---------------------------------------------------------------------------
// Gemini regression + state byte fidelity
// ---------------------------------------------------------------------------

test('Gemini regression: six Google redirects, ~1400-char state preserved byte-for-byte with iss appended', async () => {
  const { store, oauth } = makeOauth();
  const redirects = [
    'https://oauth-redirect.googleusercontent.com/r/111111111',
    'https://oauth-redirect.googleusercontent.com/a/222222222',
    'https://oauth-redirect-sandbox.googleusercontent.com/r/333333333',
    'https://oauth-redirect-sandbox.googleusercontent.com/a/444444444',
    'https://oauth-redirect-test.googleusercontent.com/r/555555555',
    'https://oauth-redirect-test.googleusercontent.com/a/666666666',
  ];
  const registered = json(await register(oauth, redirects, {
    client_name: 'Google', token_endpoint_auth_method: 'client_secret_post',
  }));
  assert.equal((await store.getClient(registered.client_id)).platform, 'gemini');
  assert.deepEqual(registered.redirect_uris, redirects);

  // 1422 chars including base64url-safe and reserved characters; state must be
  // identical after URL encoding/decoding and in the stored code record.
  const state = `${'aB3xY9-_0'.repeat(158)}%+=&`;
  const flow = await authorizeFlow(oauth, registered.client_id, {
    state, verifier: `gemini-${'v'.repeat(64)}`, redirectUri: redirects[0],
  });
  assert.equal(flow.state, state);
  assert.equal(
    Buffer.from(flow.state, 'utf8').toString('hex'),
    Buffer.from(state, 'utf8').toString('hex'),
  );
  assert.equal(store.peekCode(flow.code).state, state);
  assert.equal(flow.iss, ISSUER);
  assert.ok(flow.location.includes(`iss=${encodeURIComponent(ISSUER)}`));
});
