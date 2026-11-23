/**
 * Inbound OAuth origin consistency (2026-11-24).
 *
 * The issuer, the protected-resource `resource`/`authorization_servers`, the
 * 401 `resource_metadata` URL and the CIMD `client_id` must all describe the
 * origin the client actually used. A deployment-wide PUBLIC_BASE_URL must not
 * leak a second origin into those documents. Zero network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveBaseUrl } from '../src/oauth.js';
import { createAppHandler } from '../src/vercel-app.js';

function makeReq({ method = 'GET', url = '/', headers = {}, noHost = false } = {}) {
  return {
    method,
    url,
    headers: noHost ? { ...headers } : { host: 'gateway.example', ...headers },
    async *[Symbol.asyncIterator]() { /* empty body */ },
  };
}

function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    headersSent: false,
    body: '',
    writeHead(status, headers = {}) {
      this.statusCode = status;
      for (const [key, value] of Object.entries(headers)) this.headers[key.toLowerCase()] = value;
      this.headersSent = true;
      return this;
    },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) this.body += chunk.toString();
      return this;
    },
    getHeader(key) { return this.headers[key.toLowerCase()]; },
    setHeader(key, value) { this.headers[key.toLowerCase()] = value; },
  };
}

function storeStub() {
  return {
    getToken: async () => null,
    getClient: async () => null,
    saveClient: async () => {},
    saveCode: async () => {},
    takeCode: async () => null,
    saveToken: async () => {},
    saveRefresh: async () => {},
    getRefresh: async () => null,
    revokeToken: async () => {},
  };
}

async function call(app, opts) {
  const res = makeRes();
  await app(makeReq(opts), res);
  return res;
}

async function withPublicBase(value, fn) {
  const previous = process.env.PUBLIC_BASE_URL;
  if (value === undefined) delete process.env.PUBLIC_BASE_URL;
  else process.env.PUBLIC_BASE_URL = value;
  try { return await fn(); } finally {
    if (previous === undefined) delete process.env.PUBLIC_BASE_URL;
    else process.env.PUBLIC_BASE_URL = previous;
  }
}

test('resolveBaseUrl: explicit option wins; request host wins over PUBLIC_BASE_URL', async () => {
  assert.equal(resolveBaseUrl({ baseUrl: 'https://explicit.example/' }, makeReq()), 'https://explicit.example');
  await withPublicBase('https://canonical.example', () => {
    assert.equal(resolveBaseUrl({}, makeReq({ headers: { host: 'used.example' } })), 'https://used.example');
    // No request host → the configured canonical origin is the fallback.
    assert.equal(resolveBaseUrl({}, { headers: {} }), 'https://canonical.example');
  });
});

test('resolveBaseUrl: proxy headers, ports and malformed hosts', async () => {
  const req = makeReq({ headers: { 'x-forwarded-host': 'first.example, proxy.example', 'x-forwarded-proto': 'https' } });
  assert.equal(resolveBaseUrl({}, req), 'https://first.example');
  assert.equal(resolveBaseUrl({}, makeReq({ headers: { host: 'gw.example:8443', 'x-forwarded-proto': 'http' } })), 'http://gw.example:8443');
  await withPublicBase('https://canonical.example', () => {
    // A host carrying a path/credentials must never be reflected into metadata.
    assert.equal(resolveBaseUrl({}, makeReq({ headers: { host: 'evil.example/path' } })), 'https://canonical.example');
    assert.equal(resolveBaseUrl({}, makeReq({ headers: { host: 'a@evil.example' } })), 'https://canonical.example');
  });
});

test('all inbound surfaces describe the SAME origin for a request (host A)', async () => {
  await withPublicBase('https://canonical.example', async () => {
    const app = createAppHandler({ store: storeStub() });
    const host = 'gemini-mcp-gateway.vercel.app';
    const headers = { host };

    const meta = JSON.parse((await call(app, { url: '/.well-known/oauth-authorization-server', headers })).body);
    assert.equal(meta.issuer, `https://${host}`);
    assert.equal(meta.authorization_endpoint, `https://${host}/oauth/authorize`);

    const resource = JSON.parse((await call(app, { url: '/.well-known/oauth-protected-resource', headers })).body);
    assert.equal(resource.resource, `https://${host}/mcp`);
    assert.deepEqual(resource.authorization_servers, [`https://${host}`]);

    const cimd = JSON.parse((await call(app, { url: '/.well-known/mcp-client.json', headers })).body);
    assert.equal(cimd.client_id, `https://${host}/.well-known/mcp-client.json`);
    assert.deepEqual(cimd.redirect_uris, [`https://${host}/upstream/oauth/callback`]);

    const denied = await call(app, { method: 'POST', url: '/mcp', headers });
    assert.equal(denied.statusCode, 401);
    const challenge = denied.headers['www-authenticate'];
    assert.match(challenge, new RegExp(`resource_metadata="https://${host.replace(/\./g, '\\.')}/\.well-known/oauth-protected-resource"`));
    const body = JSON.parse(denied.body);
    assert.match(body._meta['mcp/www_authenticate'][0], new RegExp(`https://${host.replace(/\./g, '\\.')}/`));
  });
});

test('a different request host yields that host everywhere (no cached cross-origin leak)', async () => {
  await withPublicBase('https://canonical.example', async () => {
    const app = createAppHandler({ store: storeStub() });
    const host = 'other-alias.example';
    const headers = { host };
    const meta = JSON.parse((await call(app, { url: '/.well-known/oauth-authorization-server', headers })).body);
    const resource = JSON.parse((await call(app, { url: '/.well-known/oauth-protected-resource', headers })).body);
    const cimd = JSON.parse((await call(app, { url: '/.well-known/mcp-client.json', headers })).body);
    assert.equal(meta.issuer, `https://${host}`);
    assert.equal(resource.authorization_servers[0], `https://${host}`);
    assert.equal(cimd.client_id, `https://${host}/.well-known/mcp-client.json`);
  });
});

test('host-less calls fall back to PUBLIC_BASE_URL', async () => {
  await withPublicBase('https://canonical.example', async () => {
    const app = createAppHandler({ store: storeStub() });
    const meta = JSON.parse((await call(app, { url: '/.well-known/oauth-authorization-server', noHost: true })).body);
    assert.equal(meta.issuer, 'https://canonical.example');
  });
});
