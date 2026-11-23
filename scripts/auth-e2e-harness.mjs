#!/usr/bin/env node
/**
 * auth-e2e-harness.mjs — isolated HTTP end-to-end harness for gateway-owned
 * OAuth (Notion DCR / Vercel CIMD). Batch 15 · auth-e2e-harness. NON-PRODUCTION.
 *
 * WHY THIS EXISTS
 * ---------------
 * Unit tests pin the pure handlers. This harness goes one step further: it
 * starts a REAL Node `http` loopback server and drives real HTTP requests
 * against the real route handlers (`createUpstreamOAuthHandlers` for
 * /upstream/oauth/start and /callback, `createAppHandler` for the public CIMD
 * document route). Only the two outer boundaries are faked:
 *   - `fetch` toward the provider: fixed-string responses, no network;
 *   - the token store: an in-memory Map, never a real KV / vault / disk.
 * Real code, real routing, real redirects — zero internet, zero credentials.
 *
 * SAFETY INVARIANTS
 * -----------------
 *  - Every provider response is a fixed, non-secret literal (FAKE-ACCESS etc.).
 *    No real token, client_secret or credential is ever read, printed or sent.
 *  - The fake fetcher rejects ANY url outside the declared provider allowlist,
 *    so a leaked real-network call fails loudly instead of silently going out.
 *  - Reports contain only check names / booleans / short safe messages. Assert
 *    helpers redact known fake secret values before recording a failure.
 *  - Nothing is committed, pushed, deployed or written to disk.
 *
 * USAGE
 * -----
 *   node scripts/auth-e2e-harness.mjs            # prints {ok, checks[]} JSON
 *   import { runAuthE2E } from './auth-e2e-harness.mjs'; // for tests
 *
 * See docs/ledger/batch-15-auth-e2e-harness.md for how to swap in real
 * provider/KV endpoints after deployment (that is NOT done here).
 */

import http from 'node:http';

import { createUpstreamOAuthHandlers } from '../src/upstream-oauth.js';
import { UpstreamAuth } from '../src/upstream-auth.js';
import { createAppHandler, CIMD_PATH } from '../src/vercel-app.js';

// ── Fixed strings only — no real credential-like values anywhere ────────────

export const FAKE = Object.freeze({
  adminKey: 'FAKE-ADMIN-KEY',
  notionClientId: 'FAKE-NOTION-DCR-CLIENT',
  access: 'FAKE-ACCESS',
  refresh: 'FAKE-REFRESH',
  rotatedAccess: 'FAKE-ROTATED-ACCESS',
  vercelClientId: 'https://gw.example.test/.well-known/mcp-client.json',
  code: 'FAKE-CODE',
});

const NOTION_SERVER = Object.freeze({
  name: 'notion',
  transport: 'http',
  url: 'https://mcp.notion.com/mcp',
  authorizeUrl: 'https://mcp.notion.com/authorize',
  refreshUrl: 'https://mcp.notion.com/token',
  dcr: true,
  registrationEndpoint: 'https://mcp.notion.com/register',
  resource: 'https://mcp.notion.com/mcp',
});

const VERCEL_SERVER = Object.freeze({
  name: 'vercel',
  transport: 'http',
  url: 'https://mcp.vercel.com/',
  authorizeUrl: 'https://vercel.com/oauth/authorize',
  refreshUrl: 'https://api.vercel.com/login/oauth/token',
  clientId: FAKE.vercelClientId,
  resource: 'https://mcp.vercel.com/',
});

const CONFIG = Object.freeze({ servers: [NOTION_SERVER, VERCEL_SERVER] });

const ALLOWED_FETCH_URLS = new Set([
  NOTION_SERVER.registrationEndpoint,
  NOTION_SERVER.refreshUrl,
  VERCEL_SERVER.refreshUrl,
]);

// ── In-memory fake store (never touches real KV / disk) ─────────────────────

export class FakeStore {
  constructor() {
    this.values = new Map();
    this.states = new Map();
    this.commands = [];
    this.registrations = 0;
    this.tokenExchanges = 0;
  }

  isConfigured() { return true; }

  _oauthStateKey(state, { environment, grantOwner } = {}) {
    return `fake:oauthstate:${environment ?? 'local'}:${grantOwner ?? 'gateway'}:${state}`;
  }

  async saveOAuthState(state, record, scope = {}) {
    this.states.set(this._oauthStateKey(state, scope), { ...record });
  }

  async takeOAuthState(state, scope = {}) {
    const key = this._oauthStateKey(state, scope);
    const record = this.states.get(key) ?? null;
    this.states.delete(key);
    return record;
  }

  async _command(...args) {
    this.commands.push(args.map(String));
    const [cmd, key, value, ...rest] = args;
    if (cmd === 'set') {
      if (rest.includes('NX') && this.values.has(key)) return null;
      this.values.set(key, value);
      return 'OK';
    }
    if (cmd === 'get') return this.values.get(key) ?? null;
    if (cmd === 'del') { this.values.delete(key); return 1; }
    if (cmd === 'getdel') {
      const found = this.values.get(key) ?? null;
      this.values.delete(key);
      return found;
    }
    return null;
  }

  async casToken(key, expectedRefresh, nextJson) {
    const current = this.values.get(key);
    if (!current) return false;
    let parsed;
    try { parsed = JSON.parse(current); } catch { return false; }
    if (String(parsed.refresh_token) !== String(expectedRefresh)) return false;
    this.values.set(key, nextJson);
    return true;
  }
}

/** Build a fake provider fetcher that returns ONLY fixed strings. */
export function createFakeFetch(store, { vercelNoRefresh = false } = {}) {
  return async function fakeFetch(url, init = {}) {
    if (!ALLOWED_FETCH_URLS.has(String(url))) {
      throw new Error(`harness: blocked unexpected network URL ${String(url)}`);
    }
    const json = (body, status = 200) => ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(body),
      json: async () => body,
      clone() { return this; },
      headers: new Map(),
    });
    if (url === NOTION_SERVER.registrationEndpoint) {
      if (init.method !== 'POST') throw new Error('harness: DCR must be POST');
      const form = JSON.parse(String(init.body ?? '{}'));
      // Registry is fake: one client id, no secret ever issued.
      if (store) store.registrations += 1;
      if (!Array.isArray(form.redirect_uris) || form.redirect_uris.length !== 1) {
        return json({ error: 'invalid_redirect_uri' }, 400);
      }
      return json({ client_id: FAKE.notionClientId, token_endpoint_auth_method: 'none' });
    }
    if (store) store.tokenExchanges += 1;
    if (url === NOTION_SERVER.refreshUrl) {
      const form = new URLSearchParams(String(init.body ?? ''));
      if (form.get('grant_type') === 'refresh_token') {
        return json({ access_token: FAKE.rotatedAccess, refresh_token: FAKE.refresh, expires_in: 3600 });
      }
      return json({ access_token: FAKE.access, refresh_token: FAKE.refresh, expires_in: 3600 });
    }
    if (url === VERCEL_SERVER.refreshUrl) {
      return json(vercelNoRefresh
        ? { access_token: FAKE.access, expires_in: 3600 }
        : { access_token: FAKE.access, refresh_token: FAKE.refresh, expires_in: 3600 });
    }
    throw new Error('harness: unreachable');
  };
}

// ── HTTP helpers ────────────────────────────────────────────────────────────

function send(res, status, body, headers = {}) {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

/** Start a real loopback server mounting the real route handlers. */
async function startServer({ store, fetchImpl, options }) {
  const handlers = createUpstreamOAuthHandlers({
    store,
    getConfig: async () => CONFIG,
    options,
    fetch: fetchImpl,
  });
  // The CIMD document route must advertise an https redirect URI (real CIMD
  // requirement); it is served locally but never contacted by the AS here.
  const appHandler = createAppHandler({
    config: CONFIG,
    ...options,
    baseUrl: 'https://gw.example.test',
    store,
  });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/upstream/oauth/start') return void handlers.start(req, res, url);
    if (url.pathname === '/upstream/oauth/callback') return void handlers.callback(req, res, url);
    if (url.pathname === CIMD_PATH) return void appHandler(req, res);
    return send(res, 404, { error: 'not_found', path: url.pathname });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function httpGet(origin, pathAndQuery) {
  const response = await fetch(`${origin}${pathAndQuery}`, { redirect: 'manual' });
  const body = await response.text();
  let json = null;
  try { json = JSON.parse(body); } catch { /* html/empty is fine */ }
  return { status: response.status, location: response.headers.get('location'), body, json };
}

function withAdminKey(fn) {
  const previous = process.env.UPSTREAM_OAUTH_ADMIN_KEY;
  process.env.UPSTREAM_OAUTH_ADMIN_KEY = FAKE.adminKey;
  return Promise.resolve().then(fn).finally(() => {
    if (previous === undefined) delete process.env.UPSTREAM_OAUTH_ADMIN_KEY;
    else process.env.UPSTREAM_OAUTH_ADMIN_KEY = previous;
  });
}

function redact(message) {
  let text = String(message);
  for (const value of [FAKE.access, FAKE.refresh, FAKE.rotatedAccess, FAKE.adminKey]) {
    text = text.split(value).join('[REDACTED]');
  }
  return text;
}

/** One check: never throws; failure is recorded with a safe message. */
async function check(checks, name, fn) {
  try {
    const detail = await fn();
    checks.push({ name, ok: true, ...(detail ? { detail } : {}) });
    return true;
  } catch (error) {
    checks.push({ name, ok: false, error: redact(error?.message ?? error) });
    return false;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function grantKey(environment, server) {
  return `gmcgw:v2:grant:${environment}:gateway:${server}`;
}

function startPath(server, environment = 'local') {
  return `/upstream/oauth/start?server=${server}&env=${environment}&key=${encodeURIComponent(FAKE.adminKey)}`;
}

function stateFrom(location) {
  assert(Boolean(location), 'start response has no location header');
  return new URL(location).searchParams.get('state');
}

// ── The end-to-end run ──────────────────────────────────────────────────────

/**
 * Run the isolated HTTP E2E harness.
 * @param {{ vercelNoRefresh?: boolean, failCheck?: string }} [overrides]
 *   Inject a provider variant (tests exercise the no-refresh_token path
 *   without editing src), or force a named check to fail to verify that the
 *   report surfaces failures explicitly.
 * @returns {Promise<{ok: boolean, checks: Array<{name:string, ok:boolean, detail?:string, error?:string}>}>}
 */
export async function runAuthE2E(overrides = {}) {
  const checks = [];
  const store = new FakeStore();
  const fetchImpl = createFakeFetch(store, overrides);
  // CIMD needs an https-looking origin for its document; the loopback stays
  // http (real HTTP requests, local only). No outbound call uses this URL.
  const options = {
    baseUrl: 'http://127.0.0.1:1', // replaced per request via loopback origin below
    cimdBaseUrl: 'https://gw.example.test',
  };
  let server;

  try {
    server = await startServer({ store, fetchImpl, options });
    const origin = server.origin;
    // Loopback requests must carry the real origin in Host so the handlers'
    // redirect_uri points at the live server (fake provider accepts any URI).
    const get = (path) => httpGet(origin, path).then((res) => res);
    const request = (path) => fetch(`${origin}${path}`, { redirect: 'manual', headers: { host: origin.slice(7) } })
      .then(async (response) => ({
        status: response.status,
        location: response.headers.get('location'),
        body: await response.text(),
      }));

    await withAdminKey(async () => {
      // 1. Notion DCR: start -> register -> 302 -> callback -> v2 gateway grant.
      await check(checks, 'notion-dcr-start-register-redirect', async () => {
        const res = await request(startPath('notion'));
        assert(res.status === 302, `expected 302 from start, got ${res.status}`);
        const auth = new URL(res.location);
        assert(auth.origin + auth.pathname === 'https://mcp.notion.com/authorize', 'wrong authorize endpoint');
        assert(auth.searchParams.get('client_id') === FAKE.notionClientId, 'DCR client id missing from authorize URL');
        assert(auth.searchParams.get('resource') === 'https://mcp.notion.com/mcp', 'RFC 8707 resource missing');
        assert(Boolean(auth.searchParams.get('state')), 'state missing');
        assert(Boolean(auth.searchParams.get('code_challenge')), 'PKCE challenge missing');
        assert(store.registrations === 1, `expected 1 DCR registration, got ${store.registrations}`);
        const clientKey = 'gmcgw:v2:client:local:notion';
        assert(store.values.has(clientKey), 'v2 client record not persisted');
        assert(![...store.values.keys()].some((k) => k.startsWith('gmcgw:v1:')), 'legacy v1 key polluted');
        return { status: res.status, detail: '302 with DCR client, resource and PKCE' };
      });

      await check(checks, 'notion-dcr-repeated-start-reuses-client', async () => {
        const before = store.registrations;
        const res = await request(startPath('notion'));
        assert(res.status === 302, `expected 302, got ${res.status}`);
        assert(store.registrations === before, `repeated start re-registered (${before} -> ${store.registrations})`);
        return { detail: 'no second DCR POST' };
      });

      await check(checks, 'notion-dcr-callback-seeds-v2-gateway-grant', async () => {
        // Obtain a fresh start so we know the exact state to present.
        const fresh = await request(startPath('notion'));
        const state = stateFrom(fresh.location);
        const res = await request(`/upstream/oauth/callback?state=${encodeURIComponent(state)}&code=${FAKE.code}&env=local`);
        assert(res.status === 200, `expected 200 from callback, got ${res.status}: ${res.body.slice(0, 120)}`);
        const key = grantKey('local', 'notion');
        assert(store.values.has(key), `missing v2 grant at ${key}`);
        const grant = JSON.parse(store.values.get(key));
        assert(grant.owner === 'gateway', 'grant owner is not gateway');
        assert(grant.environment === 'local', 'grant environment is not local');
        assert(grant.source === 'gateway-dcr', `unexpected source ${grant.source}`);
        assert(grant.client_id === FAKE.notionClientId, 'grant bound to wrong client id');
        assert(Boolean(grant.refresh_token), 'grant has no refresh token');
        assert(![...store.values.keys()].some((k) => k.startsWith('gmcgw:v1:')), 'legacy v1 key polluted by callback');
        assert(!res.body.includes(FAKE.access) && !res.body.includes(FAKE.refresh), 'response leaked a fake secret');
        return { detail: 'owner=gateway, source=gateway-dcr, v2 key only' };
      });

      // 2. Vercel CIMD: public document route + authorize URL.
      await check(checks, 'vercel-cimd-document-route-200', async () => {
        const res = await get(CIMD_PATH);
        assert(res.status === 200, `CIMD route returned ${res.status}`);
        assert(res.json?.client_id === FAKE.vercelClientId, 'CIMD client_id is not the document URL');
        assert(res.json?.token_endpoint_auth_method === 'none', 'CIMD must be a public client');
        assert(!('client_secret' in (res.json ?? {})), 'CIMD document leaked a client_secret');
        return { detail: `GET ${CIMD_PATH} 200 JSON` };
      });

      await check(checks, 'vercel-cimd-authorize-scope-and-resource', async () => {
        const registrationsBefore = store.registrations;
        const res = await request(startPath('vercel'));
        assert(res.status === 302, `expected 302, got ${res.status}`);
        const auth = new URL(res.location);
        const scopes = String(auth.searchParams.get('scope') ?? '').split(' ');
        assert(scopes.includes('openid'), 'scope missing openid');
        assert(scopes.includes('offline_access'), 'scope missing offline_access');
        assert(auth.searchParams.get('resource') === 'https://mcp.vercel.com/', 'RFC 8707 resource missing');
        assert(auth.searchParams.get('client_id') === FAKE.vercelClientId, 'CIMD client_id missing');
        assert(store.registrations === registrationsBefore, 'CIMD must not perform DCR registration');
        return { detail: 'scope=openid offline_access, resource present' };
      });

      // 3. Vercel callback without refresh_token -> 400 (variant fetcher).
      await check(checks, 'vercel-cimd-callback-no-refresh-token-400', async () => {
        const variantStore = new FakeStore();
        const variantFetch = createFakeFetch(variantStore, { vercelNoRefresh: true });
        const variant = await startServer({
          store: variantStore,
          fetchImpl: variantFetch,
          options: { ...options },
        });
        try {
          const startRes = await fetch(`${variant.origin}${startPath('vercel')}`, {
            redirect: 'manual', headers: { host: variant.origin.slice(7) },
          });
          assert(startRes.status === 302, `variant start returned ${startRes.status}`);
          const state = stateFrom(startRes.headers.get('location'));
          const cbRes = await fetch(
            `${variant.origin}/upstream/oauth/callback?state=${encodeURIComponent(state)}&code=${FAKE.code}&env=local`,
            { redirect: 'manual', headers: { host: variant.origin.slice(7) } },
          );
          assert(cbRes.status === 400, `expected 400 without refresh_token, got ${cbRes.status}`);
          assert(!variantStore.values.has(grantKey('local', 'vercel')), 'no-refresh callback seeded a grant');
        } finally {
          await variant.close();
        }
        return { detail: '400 and no v2 grant seeded' };
      });

      // 4. Missing state -> 400.
      await check(checks, 'callback-missing-state-400', async () => {
        const res = await request(`/upstream/oauth/callback?code=${FAKE.code}`);
        assert(res.status === 400, `expected 400 for missing state, got ${res.status}`);
        return { detail: 'missing state rejected' };
      });

      // 5. Wrong environment on callback -> 400 (state bound to local).
      await check(checks, 'callback-wrong-environment-400', async () => {
        const startRes = await request(startPath('notion'));
        const state = stateFrom(startRes.location);
        const res = await request(
          `/upstream/oauth/callback?state=${encodeURIComponent(state)}&code=${FAKE.code}&env=production`,
        );
        assert(res.status === 400, `expected 400 for env mismatch, got ${res.status}`);
        assert(!store.values.has(grantKey('production', 'notion')), 'cross-env grant was seeded');
        return { detail: 'production env hint cannot complete a local state' };
      });

      // 6. Shared (DSH) grant is never refreshed; preview/prod keys isolated.
      await check(checks, 'shared-grant-never-refreshed', async () => {
        const sharedStore = new FakeStore();
        const sharedFetch = createFakeFetch(sharedStore);
        const sharedAuth = new UpstreamAuth({ store: sharedStore, fetch: sharedFetch, environment: 'preview' });
        await sharedAuth.seed('notion', {
          accessToken: FAKE.access,
          refreshToken: FAKE.refresh,
          clientId: FAKE.notionClientId,
          expiresIn: -1, // force the refresh branch
          obtainedAt: 1,
          grantOwner: 'dsh',
          source: 'dsh-mcp-connector-oauth-grant',
          environment: 'preview',
          force: true,
        });
        const exchangesBefore = sharedStore.tokenExchanges;
        const token = await sharedAuth.getAccessToken('notion', { tokenUrl: NOTION_SERVER.refreshUrl }, { force: true });
        assert(token === FAKE.access, 'shared access token was replaced');
        assert(sharedStore.tokenExchanges === exchangesBefore, 'shared grant was spent on the token endpoint');
        const status = await sharedAuth.getAuthStatus('notion');
        assert(status.status === 'REAUTH_REQUIRED', 'shared grant status is not terminal');
        assert(status.reason === 'SHARED_GRANT_REFRESH_FORBIDDEN', `unexpected reason ${status.reason}`);
        return { detail: 'token exchange count unchanged, status=REAUTH_REQUIRED' };
      });

      await check(checks, 'preview-production-key-isolation', async () => {
        const isolated = new FakeStore();
        for (const environment of ['preview', 'production']) {
          const auth = new UpstreamAuth({ store: isolated, fetch: createFakeFetch(isolated), environment });
          await auth.seed('notion', {
            accessToken: `FAKE-ACCESS-${environment.toUpperCase()}`,
            refreshToken: `FAKE-REFRESH-${environment.toUpperCase()}`,
            clientId: FAKE.notionClientId,
            environment,
            grantOwner: 'gateway',
            force: true,
          });
        }
        assert(isolated.values.has(grantKey('preview', 'notion')), 'missing preview grant');
        assert(isolated.values.has(grantKey('production', 'notion')), 'missing production grant');
        const preview = JSON.parse(isolated.values.get(grantKey('preview', 'notion')));
        const production = JSON.parse(isolated.values.get(grantKey('production', 'notion')));
        assert(preview.access_token !== production.access_token, 'preview and prod grants share a token');
        assert(preview.environment === 'preview' && production.environment === 'production', 'grant environment mismatch');
        assert(![...isolated.values.keys()].some((k) => k.startsWith('gmcgw:v1:')), 'legacy v1 key written');
        return { detail: 'two distinct v2 keys, no v1 writes' };
      });
    });
  } catch (error) {
    checks.push({ name: 'harness-setup', ok: false, error: redact(error?.message ?? error) });
  } finally {
    if (server) await server.close();
  }

  if (overrides.failCheck) {
    const index = checks.findIndex((item) => item.name === overrides.failCheck);
    const failure = { name: overrides.failCheck, ok: false, error: 'injected harness failure' };
    if (index >= 0) checks[index] = failure;
    else checks.push(failure);
  }

  return { ok: checks.length > 0 && checks.every((c) => c.ok), checks };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (invokedDirectly) {
  const result = await runAuthE2E();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.ok ? 0 : 1;
}
