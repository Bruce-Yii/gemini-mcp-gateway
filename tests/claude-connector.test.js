/**
 * Claude.ai web connector OAuth callback regressions.
 *
 * Scope is deliberately minimal: only the shared redirect allowlist in
 * `src/oauth.js` changes. This file proves that Anthropic's single documented
 * callback is accepted, that every look-alike variant is rejected, that the
 * Google/ChatGPT contracts are untouched, and that DCR / authorize / token all
 * go through the same validator. Platform isolation and LOCKED-by-default DCR
 * are covered so the new callback never widens the Gemini client.
 *
 * The 401 `WWW-Authenticate` metadata, tool annotations and text result shape
 * are already owned by `src/vercel-app.js` / `src/client-profile.js` and are
 * NOT re-implemented here. No live Claude connector was exercised.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  createOAuthHandlers,
  isAllowedRedirectUri,
  isValidGoogleRedirectUri,
  isChatgptRedirectUri,
  isClaudeRedirectUri,
} from '../src/oauth.js';

const CLAUDE = 'https://claude.ai/api/mcp/auth_callback';
const CHATGPT = 'https://chatgpt.com/connector_platform_oauth_redirect';
const GOOGLE = 'https://oauth-redirect.googleusercontent.com/r/111111111';
const ISSUER = 'https://gateway.example';

class MemoryStore {
  constructor() { this.map = new Map(); }
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
  return invoke(oauth.register, {
    method: 'POST',
    url: '/oauth/register',
    headers: { 'content-type': 'application/json' },
    body: {
      client_name: 'Claude',
      redirect_uris: redirects,
      token_endpoint_auth_method: 'none',
      ...extra,
    },
  });
}

async function authorizeFlow(oauth, clientId, { state, verifier, redirectUri, extraParams = {} }) {
  const codeChallenge = createHash('sha256').update(verifier).digest('base64url');
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: 'mcp offline_access',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    ...extraParams,
  }).toString();

  const consent = await invoke(oauth.authorize, { method: 'GET', url: `/oauth/authorize?${query}` });
  assert.equal(consent.statusCode, 200, consent.body);
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
    }),
  });
  assert.equal(approved.statusCode, 200, approved.body);
  const location = extractRedirectUrl(approved.body);
  const params = new URL(location).searchParams;
  return { location, code: params.get('code'), state: params.get('state'), iss: params.get('iss'), verifier, redirectUri };
}

// ---------------------------------------------------------------------------
// 1. Claude callback accepted; look-alikes rejected
// ---------------------------------------------------------------------------

test('Claude callback: the single documented https://claude.ai/api/mcp/auth_callback is allowed', () => {
  assert.equal(isAllowedRedirectUri(CLAUDE), true);
  assert.equal(isClaudeRedirectUri(CLAUDE), true);
  assert.equal(isValidGoogleRedirectUri(CLAUDE), true, 'legacy export is the shared allowlist');
  assert.equal(isAllowedRedirectUri('https://CLAUDE.AI/api/mcp/auth_callback'), true, 'host is case-insensitive per URL semantics');
});

test('Claude callback rejects http, other hosts, path variants, userinfo, query and fragments', () => {
  const denied = [
    // scheme / port (`:443` is normalized by URL to the default https port and
    // is therefore the same callback, not a variant — accepted intentionally)
    'http://claude.ai/api/mcp/auth_callback',
    'https://claude.ai:8443/api/mcp/auth_callback',
    // other hosts (including suffix tricks)
    'https://claude.ai.evil.example.com/api/mcp/auth_callback',
    'https://evil-claude.ai/api/mcp/auth_callback',
    'https://claude.com/api/mcp/auth_callback',
    'https://www.claude.ai/api/mcp/auth_callback',
    'https://anthropic.com/api/mcp/auth_callback',
    // path variants
    'https://claude.ai/',
    'https://claude.ai/api/mcp',
    'https://claude.ai/api/mcp/auth_callback/',
    'https://claude.ai/api/mcp/auth_callback/extra',
    'https://claude.ai/api/mcp/Auth_Callback',
    'https://claude.ai/api/mcp/auth_callback/../admin',
    'https://claude.ai/other/path',
    // userinfo
    'https://user:pass@claude.ai/api/mcp/auth_callback',
    'https://user@claude.ai/api/mcp/auth_callback',
    // query / fragment
    'https://claude.ai/api/mcp/auth_callback?code=evil',
    'https://claude.ai/api/mcp/auth_callback#fragment',
    // malformed
    'not-a-url',
    '',
  ];
  for (const uri of denied) {
    assert.equal(isAllowedRedirectUri(uri), false, uri);
    assert.equal(isClaudeRedirectUri(uri), false, uri);
  }
});

test('Google and ChatGPT existing redirect behavior is unchanged', () => {
  // Google relay prefix rules, including the legacy nested-path case.
  for (const uri of [
    GOOGLE,
    'https://oauth-redirect.googleusercontent.com/a/222222222',
    'https://oauth-redirect-sandbox.googleusercontent.com/r/333333333',
    'https://oauth-redirect-test.googleusercontent.com/a/666666666',
    'https://oauth-redirect.googleusercontent.com/r/123/legacy',
  ]) {
    assert.equal(isAllowedRedirectUri(uri), true, uri);
    assert.equal(isClaudeRedirectUri(uri), false, uri);
  }
  // ChatGPT stable + callback-id form.
  for (const uri of [CHATGPT, 'https://chatgpt.com/connector/oauth/abc123_XYZ-789']) {
    assert.equal(isAllowedRedirectUri(uri), true, uri);
    assert.equal(isChatgptRedirectUri(uri), true, uri);
    assert.equal(isClaudeRedirectUri(uri), false, uri);
  }
  // Existing ChatGPT denials still denied.
  for (const uri of [
    'http://chatgpt.com/connector/oauth/abc',
    'https://chatgpt.com/connector/oauth/',
    'https://chatgpt.com/connector/oauth/abc/def',
  ]) assert.equal(isAllowedRedirectUri(uri), false, uri);
});

// ---------------------------------------------------------------------------
// 2. DCR / authorize / token share the validator
// ---------------------------------------------------------------------------

test('DCR rejects a malicious Claude variant even with a Claude-looking client name', async () => {
  const { oauth } = makeOauth();
  for (const uri of [
    'http://claude.ai/api/mcp/auth_callback',
    'https://claude.ai.evil.example.com/api/mcp/auth_callback',
    'https://claude.ai/api/mcp/auth_callback?code=evil',
    'https://user@claude.ai/api/mcp/auth_callback',
  ]) {
    const res = await register(oauth, [uri]);
    assert.equal(res.statusCode, 400, uri);
    assert.equal(json(res).error, 'invalid_redirect_uri', uri);
  }
});

test('DCR registers the exact Claude callback; authorize and token use the same validator', async () => {
  const { store, oauth } = makeOauth();

  const registered = await register(oauth, [CLAUDE]);
  assert.equal(registered.statusCode, 200, registered.body);
  const clientId = json(registered).client_id;
  assert.equal((await store.getClient(clientId)).platform, 'claude');
  assert.equal(json(registered).token_endpoint_auth_method, 'none');

  // authorize rejects a Claude look-alike registered to nobody.
  const badAuthorize = await invoke(oauth.authorize, {
    method: 'GET',
    url: `/oauth/authorize?${new URLSearchParams({
      client_id: clientId,
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback?code=evil',
      state: 'bad', code_challenge: 'c', code_challenge_method: 'S256', response_type: 'code',
    })}`,
  });
  assert.equal(badAuthorize.statusCode, 400);
  assert.equal(json(badAuthorize).error, 'invalid_request');
  assert.match(json(badAuthorize).error_description, /not allowed/);

  // Full Claude flow: success redirect carries RFC 9207 `iss`.
  const flow = await authorizeFlow(oauth, clientId, {
    state: 'claude-state', verifier: `v-${'c'.repeat(40)}`, redirectUri: CLAUDE,
  });
  assert.equal(flow.iss, ISSUER);
  assert.equal(new URL(flow.location).searchParams.get('iss'), ISSUER);
  assert.equal(store.peekCode(flow.code).platform, 'claude');

  // token accepts the allowlisted Claude redirect.
  const tokenRes = await invoke(oauth.token, {
    method: 'POST', url: '/oauth/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({
      grant_type: 'authorization_code', code: flow.code, client_id: clientId,
      code_verifier: flow.verifier, redirect_uri: CLAUDE,
    }),
  });
  assert.equal(tokenRes.statusCode, 200, tokenRes.body);
  assert.ok(json(tokenRes).access_token);

  // token rejects a malicious Claude-variant redirect_uri (same validator).
  const flow2 = await authorizeFlow(oauth, clientId, {
    state: 'claude-state-2', verifier: `v-${'d'.repeat(40)}`, redirectUri: CLAUDE,
  });
  const badToken = await invoke(oauth.token, {
    method: 'POST', url: '/oauth/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({
      grant_type: 'authorization_code', code: flow2.code, client_id: clientId,
      code_verifier: flow2.verifier,
      redirect_uri: 'http://claude.ai/api/mcp/auth_callback',
    }),
  });
  assert.equal(badToken.statusCode, 400);
  assert.equal(json(badToken).error, 'invalid_grant');
  // Either guard rejects it: redirect mismatch against the stored code, or the
  // shared allowlist. Both prove the malicious variant never reaches a token.
  assert.match(json(badToken).error_description, /not allowed|does not match the code/);
});

test('Claude callback cannot be mixed with Google or ChatGPT redirects at DCR', async () => {
  const { oauth } = makeOauth();
  for (const redirects of [
    [CLAUDE, GOOGLE],
    [CLAUDE, CHATGPT],
    [CLAUDE, GOOGLE, CHATGPT],
  ]) {
    const res = await register(oauth, redirects);
    assert.equal(res.statusCode, 400, redirects.join(', '));
    assert.equal(json(res).error, 'invalid_redirect_uri');
  }
});

// ---------------------------------------------------------------------------
// 3. LOCKED default semantics preserved; platform isolation holds
// ---------------------------------------------------------------------------

test('LOCKED mode: DCR stays disabled by default, even for a Claude-looking registration', async () => {
  const { oauth } = makeOauth({
    allowedClientId: 'gemini-locked-client',
    allowedClientSecret: 'gemini-secret',
  });
  const denied = await register(oauth, [CLAUDE]);
  assert.equal(denied.statusCode, 403);
  assert.equal(json(denied).error, 'invalid_request');
  assert.match(json(denied).error_description, /dynamic client registration is disabled/);
});

test('LOCKED mode with ALLOW_DCR_FOR_CLAUDE: narrow carve-out works, Gemini client untouched', async () => {
  const options = {
    allowedClientId: 'gemini-locked-client',
    allowedClientSecret: 'gemini-secret',
    allowDcrForClaude: true,
  };
  const { store, oauth } = makeOauth(options);

  const approved = await register(oauth, [CLAUDE]);
  assert.equal(approved.statusCode, 200, approved.body);
  const client = json(approved);
  assert.equal((await store.getClient(client.client_id)).platform, 'claude');
  assert.notEqual(client.client_id, options.allowedClientId);
  assert.equal(await store.getClient(options.allowedClientId), null);

  // An arbitrary host is still rejected with the opt-in enabled.
  const evil = await register(oauth, ['https://evil.example.com/api/mcp/auth_callback']);
  assert.ok(evil.statusCode === 400 || evil.statusCode === 403);

  // Claude public client completes the flow without a client secret, non-rotating refresh.
  const flow = await authorizeFlow(oauth, client.client_id, {
    state: 'locked-claude', verifier: `v-${'l'.repeat(40)}`, redirectUri: CLAUDE,
  });
  const tokenRes = await invoke(oauth.token, {
    method: 'POST', url: '/oauth/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({
      grant_type: 'authorization_code', code: flow.code, client_id: client.client_id,
      code_verifier: flow.verifier, redirect_uri: CLAUDE,
    }),
  });
  assert.equal(tokenRes.statusCode, 200, tokenRes.body);
  const tokens = json(tokenRes);
  assert.ok(tokens.refresh_token);
  const refreshed = json(await invoke(oauth.token, {
    method: 'POST', url: '/oauth/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id }),
  }));
  assert.equal(refreshed.refresh_token, tokens.refresh_token, 'refresh token must not rotate');
});

test('LOCKED mode: Gemini locked client cannot use the Claude callback; tokens are not interchangeable', async () => {
  const options = {
    allowedClientId: 'gemini-locked-client',
    allowedClientSecret: 'gemini-secret',
    allowDcrForClaude: true,
  };
  const { oauth } = makeOauth(options);

  // The Gemini client stays Google-relay-only even though Claude is allowlisted.
  const mixed = await invoke(oauth.authorize, {
    method: 'GET',
    url: `/oauth/authorize?${new URLSearchParams({
      client_id: options.allowedClientId, redirect_uri: CLAUDE, state: 'mixed',
      code_challenge: 'c', code_challenge_method: 'S256', response_type: 'code',
    })}`,
  });
  assert.equal(mixed.statusCode, 400);
  assert.match(json(mixed).error_description, /Gemini client cannot use a Claude redirect/);

  // A Claude code cannot be redeemed by the Gemini locked client.
  const registered = json(await register(oauth, [CLAUDE]));
  const flow = await authorizeFlow(oauth, registered.client_id, {
    state: 'claude-code', verifier: `v-${'x'.repeat(40)}`, redirectUri: CLAUDE,
  });
  const stolen = await invoke(oauth.token, {
    method: 'POST', url: '/oauth/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({
      grant_type: 'authorization_code', code: flow.code, client_id: options.allowedClientId,
      client_secret: options.allowedClientSecret, code_verifier: flow.verifier, redirect_uri: CLAUDE,
    }),
  });
  // client_id mismatch is checked before platform isolation; either guard keeps
  // the Claude code from being redeemed by the Gemini locked client.
  assert.ok(stolen.statusCode === 400 || stolen.statusCode === 401);
  assert.match(json(stolen).error_description, /platform mismatch|client_id does not match/);

  // Platform mixing at DCR never succeeds: with both opt-ins enabled the
  // carve-out predicates reject the mixed set, so the LOCKED gate returns 403.
  const openBoth = makeOauth({
    ...options, allowDcrForChatgpt: true, allowDcrForClaude: true,
  });
  const mixedRegister = await register(openBoth.oauth, [CLAUDE, CHATGPT], { client_name: 'ChatGPT' });
  assert.equal(mixedRegister.statusCode, 403);
  assert.equal(json(mixedRegister).error, 'invalid_request');
});
