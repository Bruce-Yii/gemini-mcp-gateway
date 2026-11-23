/**
 * B15 auth provisioning — deterministic, zero-network regressions.
 *
 * Every fake store/fetch is local; no real credential, provider call or
 * deployment is involved. These tests pin the contract that MUST be green
 * before we ask the user to authorize anything (docs/AUTH-READY.md):
 *   - static_bearer never enters the refresh path
 *   - the token value is never printed anywhere
 *   - v2 key namespace is always explicit
 *   - Linear PAT / Notion static / DCR / Vercel offline_access branches are honest
 *   - the "not ready" checklist blocks premature authorization requests
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { validateConfig, AUTH_MODES, STATIC_BEARER } from '../src/config.js';
import {
  UpstreamAuth, STATIC_TOKEN_NO_REFRESH, STATIC_BEARER as AUTH_STATIC_BEARER,
  V2_KEY_PREFIX, requiredScopes, OAUTH_PROVIDER_FACTS,
} from '../src/upstream-auth.js';
import {
  MCP_URLS, STATIC_CAPABLE, OAUTH_ONLY, SUPPORTED_PROVIDERS,
  normalizeEnvironment, grantKey, buildStaticGrant,
  planProvision, formatPlan, provision, main,
} from '../scripts/auth-provision.mjs';

// ── helpers ───────────────────────────────────────────────────────────────

function fakeStore() {
  const data = new Map();
  const commands = [];
  return {
    data,
    commands,
    isConfigured: () => true,
    _command: async (...args) => {
      const [cmd, key, value, ...rest] = args;
      commands.push([cmd, key, value, ...rest]);
      if (cmd === 'get') return data.get(key) ?? null;
      if (cmd === 'set') {
        if (rest.includes('NX') && data.has(key)) return null;
        data.set(key, value);
        return 'OK';
      }
      if (cmd === 'del') { data.delete(key); return 1; }
      return null;
    },
  };
}

function captureOutput() {
  const lines = [];
  return { lines, stdout: (line) => lines.push(String(line)), stderr: () => {} };
}

const LOCAL_ENV = { LINEAR_PAT_STATIC: 'lin_pat_secret_value', NOTION_MCP_STATIC_TOKEN: 'ntn_static_secret_value' };
const TOKEN = LOCAL_ENV.LINEAR_PAT_STATIC;

// ── 1. static_bearer in config validation ─────────────────────────────────

test('config: static_bearer is an explicit valid authMode (no warning on the key)', () => {
  assert.deepEqual([...AUTH_MODES], ['oauth', 'static_bearer']);
  const { config, warnings } = validateConfig({
    servers: [{
      name: 'linear', transport: 'http', url: 'https://mcp.linear.app/mcp',
      tokenEnv: 'LINEAR_PAT_STATIC', authMode: STATIC_BEARER,
    }],
  }, { env: LOCAL_ENV });
  assert.equal(config.servers[0].authMode, STATIC_BEARER);
  assert.equal(warnings.some((w) => w.includes('authMode')), false, 'authMode is a known key, never warned as unknown');
});

test('config: static_bearer requires tokenEnv and forbids refresh fields', () => {
  assert.throws(() => validateConfig({
    servers: [{ name: 'linear', transport: 'http', url: 'https://mcp.linear.app/mcp', authMode: 'static_bearer' }],
  }, { env: {} }), /requires tokenEnv/);
  assert.throws(() => validateConfig({
    servers: [{
      name: 'linear', transport: 'http', url: 'https://mcp.linear.app/mcp',
      tokenEnv: 'LINEAR_PAT_STATIC', authMode: 'static_bearer', refreshEnv: 'LINEAR_REFRESH',
    }],
  }, { env: LOCAL_ENV }), /refreshEnv is not allowed with authMode "static_bearer"/);
  assert.throws(() => validateConfig({
    servers: [{
      name: 'linear', transport: 'http', url: 'https://mcp.linear.app/mcp',
      tokenEnv: 'LINEAR_PAT_STATIC', authMode: 'bogus',
    }],
  }, { env: LOCAL_ENV }), /authMode must be one of oauth, static_bearer/);
});

// ── 2. UpstreamAuth static_bearer path: no refresh, owner=manual, v2 key ──

test('UpstreamAuth: authMode=static_bearer returns token verbatim and NEVER calls the token endpoint', async () => {
  const store = fakeStore();
  let refreshCalls = 0;
  const auth = new UpstreamAuth({
    store,
    fetch: async () => { refreshCalls += 1; throw new Error('static token must not refresh'); },
  });
  const token = await auth.getAccessToken('linear', {
    envToken: TOKEN,
    authMode: AUTH_STATIC_BEARER,
  }, { force: true }); // even force (provider 401) must not refresh
  assert.equal(token, TOKEN);
  assert.equal(refreshCalls, 0);
});

test('UpstreamAuth: static_bearer persists owner=manual at the explicit v2 key', async () => {
  const store = fakeStore();
  const auth = new UpstreamAuth({ store, environment: 'production' });
  await auth.getAccessToken('linear', { envToken: TOKEN, authMode: AUTH_STATIC_BEARER });
  const key = `${V2_KEY_PREFIX}:production:manual:linear`;
  assert.equal(store.data.has(key), true, 'v2 key with explicit environment + owner');
  const rec = JSON.parse(store.data.get(key));
  assert.equal(rec.owner, 'manual');
  assert.equal(rec.environment, 'production');
  assert.equal(rec.authMode, STATIC_BEARER);
  assert.equal(rec.refresh_token, undefined, 'no rotating grant stored');
  assert.equal(rec.bootstrapped, false);
});

test('UpstreamAuth: forced static retry reports STATIC_TOKEN_NO_REFRESH (terminal)', async () => {
  const store = fakeStore();
  const auth = new UpstreamAuth({ store });
  await auth.getAccessToken('linear', { envToken: 'expired_pat', authMode: AUTH_STATIC_BEARER }, { force: true });
  const status = await auth.getAuthStatus('linear');
  assert.equal(status.status, 'REAUTH_REQUIRED');
  assert.equal(status.reason, STATIC_TOKEN_NO_REFRESH);
});

// ── 3. token is never printed ─────────────────────────────────────────────

test('formatPlan redacts even an accidentally supplied token value', () => {
  const plan = planProvision({ provider: 'linear', tokenEnv: 'LINEAR_PAT_STATIC', environment: 'local' }, { env: LOCAL_ENV });
  // Simulate a caller accidentally injecting the token into a plan line;
  // the defence-in-depth redaction must still scrub it.
  plan.lines.push(`accidental debug line with ${TOKEN}`);
  const text = formatPlan(plan, { secrets: [TOKEN] });
  assert.equal(text.includes(TOKEN), false, 'raw token must never appear in plan output');
  assert.match(text, /\[REDACTED\]/);
  // The env var NAME may appear; its VALUE must not.
  assert.match(text, /LINEAR_PAT_STATIC/);
});

test('provision stdout/stderr contain no token value, including on verify/apply', async () => {
  const store = fakeStore();
  const out = captureOutput();
  const fakeFetch = async (url, opts) => {
    assert.equal(url, MCP_URLS.linear);
    assert.equal(opts.headers.Authorization, `Bearer ${TOKEN}`);
    return { ok: true, status: 200 };
  };
  const result = await provision({
    provider: 'linear', tokenEnv: 'LINEAR_PAT_STATIC', environment: 'local', verify: true, apply: true,
  }, { env: LOCAL_ENV, store, fetchImpl: fakeFetch, stdout: out.stdout, stderr: out.stderr });
  assert.equal(result.verified, true);
  assert.equal(result.wrote, true);
  assert.equal(result.plan.ready, true);
  const printed = out.lines.join('\n');
  assert.equal(printed.includes(TOKEN), false, `token leaked to stdout: ${printed}`);
  // The KV record legitimately holds the token; only stdout is constrained.
  assert.equal(JSON.parse(store.data.get(result.plan.key)).access_token, TOKEN);
});

test('provision without token never performs a network call', async () => {
  const out = captureOutput();
  let networkCalls = 0;
  await provision({ provider: 'linear', tokenEnv: 'LINEAR_PAT_STATIC', verify: true }, {
    env: {}, fetchImpl: async () => { networkCalls += 1; return { ok: true }; }, stdout: out.stdout, stderr: out.stderr,
  });
  assert.equal(networkCalls, 0, 'no token means no tools/list request is attempted');
});

// ── 4. v2 key / owner mapping ─────────────────────────────────────────────

test('grantKey always uses the explicit v2 namespace and maps prod → production', () => {
  assert.equal(normalizeEnvironment('prod'), 'production');
  assert.equal(normalizeEnvironment('local'), 'local');
  assert.equal(normalizeEnvironment('bogus'), null);
  assert.equal(grantKey('production', 'manual', 'linear'), 'gmcgw:v2:grant:production:manual:linear');
  assert.equal(grantKey('local', 'gateway', 'vercel'), 'gmcgw:v2:grant:local:gateway:vercel');
  assert.deepEqual([...STATIC_CAPABLE], ['linear', 'notion']);
  assert.deepEqual([...OAUTH_ONLY], ['vercel']);
  assert.deepEqual([...SUPPORTED_PROVIDERS], ['linear', 'notion', 'vercel']);
});

test('buildStaticGrant has owner=manual, no refresh token, and a stable grantId', () => {
  const rec = buildStaticGrant({ server: 'linear', token: TOKEN, environment: 'local' });
  assert.equal(rec.owner, 'manual');
  assert.equal(rec.source, 'manual');
  assert.equal(rec.environment, 'local');
  assert.equal(rec.grantId, 'manual:local:linear');
  assert.equal(rec.authMode, 'static_bearer');
  assert.equal(rec.refresh_token, undefined);
  assert.equal(rec.client_id, undefined);
  assert.equal(rec.staticTokenNoRefresh, true);
  assert.throws(() => buildStaticGrant({ server: 'linear', token: '', environment: 'local' }), /requires a token/);
});

// ── 5. Linear PAT path ────────────────────────────────────────────────────

test('Linear PAT: offline plan is ready when token env is present (no network)', () => {
  const plan = planProvision({ provider: 'linear', tokenEnv: 'LINEAR_PAT_STATIC', environment: 'local' }, { env: LOCAL_ENV });
  assert.equal(plan.kind, 'static');
  assert.equal(plan.ready, true);
  assert.equal(plan.tokenPresent, true);
  assert.deepEqual(plan.blockers, []);
  assert.equal(plan.key, 'gmcgw:v2:grant:local:manual:linear');
});

test('Linear PAT: verify hits the official MCP tools/list and records success', async () => {
  const out = captureOutput();
  const calls = [];
  const result = await provision({ provider: 'linear', tokenEnv: 'LINEAR_PAT_STATIC', verify: true }, {
    env: LOCAL_ENV,
    fetchImpl: async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200 }; },
    stdout: out.stdout, stderr: out.stderr,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, MCP_URLS.linear);
  assert.equal(calls[0].init.method, 'POST');
  assert.match(String(calls[0].init.body), /tools\/list/);
  assert.equal(result.verified, true);
});

test('Linear PAT: a 401 tools/list blocks readiness with a clear blocker', async () => {
  const out = captureOutput();
  const result = await provision({ provider: 'linear', tokenEnv: 'LINEAR_PAT_STATIC', verify: true }, {
    env: LOCAL_ENV, fetchImpl: async () => ({ ok: false, status: 401 }), stdout: out.stdout, stderr: out.stderr,
  });
  assert.equal(result.verified, false);
  assert.ok(result.blockers.some((b) => /HTTP 401/.test(b)));
  assert.equal(result.plan.ready, false);
});

// ── 6. Vercel offline_access config ───────────────────────────────────────

test('Vercel: requiredScopes includes offline_access; OAUTH_PROVIDER_FACTS is OAuth-only', () => {
  assert.ok(requiredScopes('vercel').includes('offline_access'));
  assert.equal(OAUTH_PROVIDER_FACTS.vercel.auth, 'oauth');
  assert.equal(OAUTH_PROVIDER_FACTS.vercel.rotates, true);
});

test('Vercel: offline plan is BLOCKED with CIMD/offline_access guidance and no KV write', () => {
  const out = captureOutput();
  const plan = planProvision({ provider: 'vercel', environment: 'prod', callbackBaseUrl: 'https://gw.example' });
  assert.equal(plan.kind, 'oauth');
  assert.equal(plan.ready, false);
  assert.equal(plan.key, 'gmcgw:v2:grant:production:gateway:vercel');
  assert.ok(plan.blockers.some((b) => /CIMD/.test(b)));
  const text = formatPlan(plan);
  assert.match(text, /offline_access/);
  assert.match(text, /CIMD/);
  assert.match(text, /env=production/);
  // OAuth plan never writes a grant itself.
  assert.equal(plan.lines.some((l) => l.includes('written by callback, NOT by this script')), true);
});

test('Vercel: --apply on an OAuth plan performs no KV write', async () => {
  const store = fakeStore();
  const out = captureOutput();
  const result = await provision({ provider: 'vercel', environment: 'local', apply: true }, {
    env: {}, store, stdout: out.stdout, stderr: out.stderr,
  });
  assert.equal(result.wrote, false);
  assert.equal(store.commands.length, 0, 'oauth provisioning must not write a static grant');
});

// ── 7. Notion static / DCR branch ─────────────────────────────────────────

test('Notion: static MCP token path is ready and uses owner=manual v2 key', async () => {
  const plan = planProvision({ provider: 'notion', tokenEnv: 'NOTION_MCP_STATIC_TOKEN', environment: 'prod' }, { env: LOCAL_ENV });
  assert.equal(plan.kind, 'static');
  assert.equal(plan.ready, true);
  assert.equal(plan.key, 'gmcgw:v2:grant:production:manual:notion');
  const text = formatPlan(plan);
  assert.match(text, /Business\/Enterprise/);
  assert.match(text, /REST integration token is NOT valid/);
});

test('Notion: interactive OAuth is explicitly BLOCKED because upstream-oauth has no DCR', () => {
  const plan = planProvision({ provider: 'notion', mode: 'oauth', environment: 'prod' });
  assert.equal(plan.kind, 'oauth');
  assert.equal(plan.ready, false);
  assert.ok(plan.blockers.some((b) => /DCR\/CIMD client registration is not implemented/.test(b)),
    'must honestly mark DCR as unsupported instead of promising it works');
});

test('Notion OAuth requires offline_access in facts but handler has no DCR start route', () => {
  assert.ok(OAUTH_PROVIDER_FACTS.notion.requiredScopes.includes('offline_access'));
  assert.equal(OAUTH_PROVIDER_FACTS.notion.auth, 'oauth-dcr');
});

// ── 8. not-ready checklist assertion ──────────────────────────────────────

test('checklist: readiness is false while any blocker exists — do not ask the user yet', () => {
  const plans = [
    planProvision({ provider: 'linear', tokenEnv: 'MISSING_ENV', environment: 'local' }, { env: {} }),
    planProvision({ provider: 'notion', mode: 'oauth', environment: 'local' }),
    planProvision({ provider: 'vercel', environment: 'production' }),
    planProvision({ provider: 'unknown' }),
  ];
  for (const plan of plans) {
    assert.equal(plan.ready, false, `${plan.provider} must be blocked`);
    assert.ok(plan.blockers.length >= 1, `${plan.provider} must state why it is blocked`);
  }
  // The only green offline plan is a static credential whose env is present.
  const ready = planProvision({ provider: 'linear', tokenEnv: 'LINEAR_PAT_STATIC', environment: 'local' }, { env: LOCAL_ENV });
  assert.equal(ready.ready, true);
});

test('main(): bad args exit 2, blocked plan exit 1, ready offline plan exit 0', async () => {
  const out = captureOutput();
  assert.equal(await main([], { env: LOCAL_ENV, stdout: out.stdout, stderr: () => {} }), 2);
  assert.equal(await main(['--provider', 'vercel'], { env: LOCAL_ENV, stdout: out.stdout, stderr: out.stderr }), 1);
  assert.equal(await main(['--provider', 'linear', '--token-env', 'LINEAR_PAT_STATIC'], {
    env: LOCAL_ENV, stdout: out.stdout, stderr: out.stderr,
  }), 0);
});

test('main(): --json emits machine-readable readiness with no token', async () => {
  const out = captureOutput();
  const code = await main(['--provider', 'linear', '--token-env', 'LINEAR_PAT_STATIC', '--json'], {
    env: LOCAL_ENV, stdout: out.stdout, stderr: out.stderr,
  });
  assert.equal(code, 0);
  const jsonLine = out.lines[out.lines.length - 1];
  const payload = JSON.parse(jsonLine);
  assert.equal(payload.ready, true);
  assert.equal(payload.verified, false, 'offline run never verifies');
  assert.equal(payload.wrote, false, 'offline run never writes');
  assert.equal(jsonLine.includes(TOKEN), false);
});
