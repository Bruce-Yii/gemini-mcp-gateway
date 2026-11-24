/**
 * Inbound approval passphrase (OAUTH_APPROVE_PASSPHRASE).
 *
 * Threat: once ChatGPT/Claude DCR is enabled, anyone who obtains the authorize
 * URL could otherwise press Approve. With a passphrase configured, approval
 * must require the secret; missing/wrong attempts get HTTP 403 and never mint a
 * code. When unset, the legacy behaviour must be byte-compatible.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { createOAuthHandlers } from '../src/oauth.js';

const ISSUER = 'https://gateway.example';
const REDIRECT = 'https://oauth-redirect.googleusercontent.com/r/111111111';
const CLIENT_ID = 'locked-client';

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
  async revokeToken(token) { this.map.delete(`token:${token}`); this.map.delete(`refresh:${token}`); }
  codeCount() { return [...this.map.keys()].filter((key) => key.startsWith('code:')).length; }
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

const verifier = 'approve-passphrase-verifier-0123456789';
const codeChallenge = createHash('sha256').update(verifier).digest('base64url');

function authorizeQuery() {
  return new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    scope: 'mcp offline_access',
    state: 'state-approve-1',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  }).toString();
}

function approveBody(passphrase) {
  const fields = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    state: 'state-approve-1',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    scope: 'mcp offline_access',
    response_type: 'code',
  });
  if (passphrase !== undefined) fields.set('passphrase', passphrase);
  return fields.toString();
}

function makeOauth(extra = {}) {
  const store = new MemoryStore();
  const oauth = createOAuthHandlers(store, {
    baseUrl: ISSUER,
    allowedClientId: CLIENT_ID,
    allowedClientSecret: 'client-secret',
    ...extra,
  });
  return { store, oauth };
}

function extractRedirect(html) {
  const match = /http-equiv="refresh" content="0;url=([^"]*)"/i.exec(html);
  assert.ok(match, 'expected redirect page');
  return match[1];
}

test('configured passphrase: consent page asks for it, correct value mints a code', async () => {
  const { store, oauth } = makeOauth({ approvePassphrase: 'correct-horse-battery' });
  const consent = await invoke(oauth.authorize, { method: 'GET', url: `/oauth/authorize?${authorizeQuery()}` });
  assert.equal(consent.statusCode, 200);
  assert.match(consent.body, /type="password" name="passphrase" required autocomplete="off"/);

  const approved = await invoke(oauth.authorize, {
    method: 'POST',
    url: '/oauth/authorize',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: approveBody('correct-horse-battery'),
  });
  assert.equal(approved.statusCode, 200, approved.body);
  const location = extractRedirect(approved.body);
  assert.match(location, /[?&]code=/);
  assert.equal(store.codeCount(), 1);
});

test('configured passphrase: wrong and missing values are 403 and never mint a code', async () => {
  const { store, oauth } = makeOauth({ approvePassphrase: 'correct-horse-battery' });
  for (const passphrase of ['wrong', undefined]) {
    const before = store.codeCount();
    const rejected = await invoke(oauth.authorize, {
      method: 'POST',
      url: '/oauth/authorize',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: approveBody(passphrase),
    });
    assert.equal(rejected.statusCode, 403, `passphrase=${passphrase}`);
    assert.match(rejected.body, /type="password" name="passphrase"/);
    assert.match(rejected.body, /missing or incorrect/);
    assert.doesNotMatch(rejected.body, /[?&]code=/);
    assert.equal(store.codeCount(), before, 'no code may be stored on a rejected approval');
  }
});

test('passphrase value never appears in logs or the 403 page', async () => {
  const { oauth } = makeOauth({ approvePassphrase: 'do-not-log-me-123' });
  const calls = [];
  const originalWarn = console.warn;
  const originalLog = console.log;
  console.warn = (...args) => calls.push(args.join(' '));
  console.log = (...args) => calls.push(args.join(' '));
  try {
    await invoke(oauth.authorize, {
      method: 'POST',
      url: '/oauth/authorize',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: approveBody('do-not-log-me-123'),
    });
    await invoke(oauth.authorize, {
      method: 'POST',
      url: '/oauth/authorize',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: approveBody('wrong-value'),
    });
  } finally {
    console.warn = originalWarn;
    console.log = originalLog;
  }
  assert.equal(calls.join('\n').includes('do-not-log-me-123'), false);
  assert.equal(calls.join('\n').includes('wrong-value'), false);
});

test('unset passphrase keeps the legacy behaviour (no field, approval succeeds)', async () => {
  const { store, oauth } = makeOauth({ approvePassphrase: '' });
  const consent = await invoke(oauth.authorize, { method: 'GET', url: `/oauth/authorize?${authorizeQuery()}` });
  assert.equal(consent.statusCode, 200);
  assert.doesNotMatch(consent.body, /name="passphrase"/);

  const approved = await invoke(oauth.authorize, {
    method: 'POST',
    url: '/oauth/authorize',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: approveBody(undefined),
  });
  assert.equal(approved.statusCode, 200, approved.body);
  assert.match(extractRedirect(approved.body), /[?&]code=/);
  assert.equal(store.codeCount(), 1);
});

test('DCR enabled without passphrase logs exactly one secret-free warning', () => {
  const calls = [];
  const originalWarn = console.warn;
  console.warn = (...args) => calls.push(args.join(' '));
  try {
    makeOauth({ approvePassphrase: '', allowDcrForChatgpt: true });
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(calls.length, 1);
  assert.match(calls[0], /OAUTH_APPROVE_PASSPHRASE/);
  assert.match(calls[0], /anyone with the consent URL can approve/);
});
