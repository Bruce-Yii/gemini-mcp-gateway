/**
 * Owner marking (2026-11-24): explicit grant attribution + unmarked = shared.
 *
 * Deterministic, zero-network. No real credential is used.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { validateConfig, ConfigError } from '../src/config.js';
import {
  UpstreamAuth, SHARED_GRANT_REFRESH_FORBIDDEN, V2_KEY_PREFIX, LEGACY_KEY_PREFIX,
} from '../src/upstream-auth.js';
import {
  classifyRecord, grantKey, legacyKey, planMigration, migrate,
} from '../scripts/auth-migrate-owners.mjs';

const V2 = (env, owner, server) => `${V2_KEY_PREFIX}:${env}:${owner}:${server}`;
const LEGACY = (env, server) => (env === 'production' ? `${LEGACY_KEY_PREFIX}:${server}` : `${LEGACY_KEY_PREFIX}:${env}:${server}`);

function fakeStore() {
  const data = new Map();
  const commands = [];
  return {
    _data: data,
    commands,
    isConfigured: () => true,
    _command: async (...args) => {
      const [cmd, key, value] = args;
      commands.push([cmd, key, value]);
      if (cmd === 'get') return data.get(key) ?? null;
      if (cmd === 'set') { data.set(key, value); return 'OK'; }
      if (cmd === 'del') { data.delete(key); return 1; }
      return null;
    },
    casToken: async (key, expectedRefresh, nextJson) => {
      const cur = data.get(key);
      if (!cur) return false;
      if (String(JSON.parse(cur).refresh_token) !== String(expectedRefresh)) return false;
      data.set(key, nextJson);
      return true;
    },
    releaseLease: async () => true,
    renewLease: async () => true,
    acquireLease: async () => 'lease-owner',
  };
}

function refreshFetch(counter) {
  return async () => {
    counter.calls += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({ access_token: `AT_${counter.calls}`, refresh_token: `RT_${counter.calls}`, expires_in: 3600 }),
      headers: new Map(),
    };
  };
}

// ── config surface ─────────────────────────────────────────────────────────

test('config: grantOwner/grantOwnerEnv/grantSource/grantSourceEnv are known keys (no unknown warning)', () => {
  const { warnings } = validateConfig({
    servers: [{
      name: 'notion', transport: 'http', url: 'https://mcp.notion.com/mcp',
      tokenEnv: 'NOTION_TOKEN', refreshEnv: 'NOTION_REFRESH_TOKEN',
      grantOwner: 'dsh',
    }, {
      name: 'linear', transport: 'http', url: 'https://mcp.linear.app/mcp',
      tokenEnv: 'LINEAR_TOKEN', refreshEnv: 'LINEAR_REFRESH_TOKEN',
      grantOwnerEnv: 'LINEAR_GRANT_OWNER', grantSource: 'dsh-exported',
      grantSourceEnv: 'LINEAR_GRANT_SOURCE',
    }],
  });
  assert.deepEqual(warnings.filter((w) => /unknown key/.test(w)), []);
});

test('config: invalid grantOwner / env names are hard errors', () => {
  const bad = (server) => assert.throws(
    () => validateConfig({ servers: [{ name: 'notion', transport: 'http', url: 'https://mcp.notion.com/mcp', tokenEnv: 'T', ...server }] }),
    (error) => error instanceof ConfigError,
  );
  bad({ grantOwner: 'shared' });
  bad({ grantOwner: 'GATEWAY-typo' });
  bad({ grantOwnerEnv: 'lower case' });
  bad({ grantSource: 42 });
});

test('config: static_bearer ignores grantOwner with an explicit warning', () => {
  const { warnings } = validateConfig({
    servers: [{
      name: 'linear', transport: 'http', url: 'https://mcp.linear.app/mcp',
      tokenEnv: 'LINEAR_PAT_STATIC', authMode: 'static_bearer', grantOwner: 'gateway',
    }],
  });
  assert.ok(warnings.some((w) => /owner=manual/.test(w)));
});

test('config: refreshEnv without any owner marking warns that refresh is impossible', () => {
  const { warnings } = validateConfig({
    servers: [{
      name: 'notion', transport: 'http', url: 'https://mcp.notion.com/mcp',
      tokenEnv: 'NOTION_TOKEN', refreshEnv: 'NOTION_REFRESH_TOKEN',
    }],
  });
  assert.ok(warnings.some((w) => /NEVER auto-refresh/.test(w)));
});

test('config.example.json marks every env-seeded rotating grant owner=dsh', async () => {
  const parsed = JSON.parse(await readFile(new URL('../config.example.json', import.meta.url), 'utf8'));
  const byName = Object.fromEntries(parsed.servers.map((s) => [s.name, s]));
  for (const name of ['notion', 'linear', 'figma']) {
    assert.equal(byName[name].grantOwner, 'dsh', `${name} must be explicitly dsh`);
  }
});

// ── auth lifecycle ─────────────────────────────────────────────────────────

test('explicit owner=dsh: env seed lands in the dsh key and NEVER refreshes', async () => {
  const store = fakeStore();
  const counter = { calls: 0 };
  const auth = new UpstreamAuth({ store, environment: 'production', fetch: refreshFetch(counter) });
  const token = await auth.getAccessToken('notion', {
    envToken: 'DSH_AT', envRefresh: 'DSH_RT', envClientId: 'CID',
    envExpiresIn: 0, envObtainedAt: 0, // expired → would refresh if gateway-owned
    grantOwner: 'dsh',
  });
  assert.equal(token, 'DSH_AT', 'expired dsh token is still returned verbatim');
  assert.equal(counter.calls, 0, 'dsh grant must never call the token endpoint');
  const rec = JSON.parse(store._data.get(V2('production', 'dsh', 'notion')));
  assert.equal(rec.owner, 'dsh');
  assert.equal(rec.source, 'dsh');
  assert.equal(store._data.has(V2('production', 'gateway', 'notion')), false);
  const status = await auth.getAuthStatus('notion');
  assert.equal(status.status, 'REAUTH_REQUIRED');
  assert.equal(status.reason, SHARED_GRANT_REFRESH_FORBIDDEN);
});

test('explicit owner=gateway still refreshes and writes the gateway key', async () => {
  const store = fakeStore();
  const counter = { calls: 0 };
  const auth = new UpstreamAuth({ store, environment: 'production', fetch: refreshFetch(counter) });
  const token = await auth.getAccessToken('notion', {
    envToken: 'GW_AT', envRefresh: 'GW_RT', envClientId: 'CID',
    envExpiresIn: 0, envObtainedAt: 0,
    grantOwner: 'gateway',
  });
  assert.equal(counter.calls, 1);
  assert.equal(token, 'AT_1');
  assert.equal(JSON.parse(store._data.get(V2('production', 'gateway', 'notion'))).owner, 'gateway');
});

test('legacy v1 unmarked record is readable but can never be refreshed', async () => {
  const store = fakeStore();
  store._data.set(LEGACY('production', 'notion'), JSON.stringify({
    access_token: 'OLD_AT', refresh_token: 'OLD_RT', client_id: 'CID',
    expires_at: 0, envSeed: 'OLD_AT', // expired / unknown → refresh would fire if owned
  }));
  const counter = { calls: 0 };
  const auth = new UpstreamAuth({ store, environment: 'production', fetch: refreshFetch(counter) });
  const token = await auth.getAccessToken('notion', { envToken: 'OLD_AT', envRefresh: 'OLD_RT', envClientId: 'CID', envExpiresIn: 0, envObtainedAt: 0 });
  assert.equal(token, 'OLD_AT');
  assert.equal(counter.calls, 0);
  assert.equal(store._data.has(V2('production', 'gateway', 'notion')), false);
});

// ── migration planner/apply ────────────────────────────────────────────────

test('classifyRecord: marked vs unmarked vs unknown', () => {
  assert.equal(classifyRecord(null), 'missing');
  assert.equal(classifyRecord({}), 'unmarked');
  assert.equal(classifyRecord({ owner: 'dsh' }), 'dsh');
  assert.equal(classifyRecord({ source: 'dsh-mcp-connector-oauth-grant' }), 'dsh');
  assert.equal(classifyRecord({ owner: 'gateway' }), 'gateway');
  assert.equal(classifyRecord({ source: 'gateway-oauth' }), 'gateway');
  assert.equal(classifyRecord({ owner: 'manual' }), 'manual');
  assert.equal(classifyRecord({ owner: 'whatever' }), 'unknown');
});

test('planMigration: unmarked legacy → copy to dsh; marked/target-existing → skip; v2 unmarked → tag', () => {
  const plan = planMigration({
    environment: 'production',
    servers: ['notion', 'linear', 'figma'],
    targetOwner: 'dsh',
    legacy: {
      notion: { access_token: 'A', refresh_token: 'R' },
      linear: { access_token: 'A', owner: 'gateway' },
    },
    v2: {
      notion: {},
      linear: { gateway: { access_token: 'A', owner: 'gateway' } },
      figma: { shared: { access_token: 'A' } },
    },
  });
  assert.equal(plan.summary.copyLegacy, 1);
  assert.equal(plan.summary.tagV2, 1);
  assert.equal(plan.summary.skipped, 1);
  const copy = plan.actions.find((a) => a.type === 'copy-legacy');
  assert.equal(copy.server, 'notion');
  assert.equal(copy.to, V2('production', 'dsh', 'notion'));
  assert.equal(copy.hasAccessToken, true);
  assert.equal(copy.hasRefreshToken, true);
  const tag = plan.actions.find((a) => a.type === 'tag-v2');
  assert.equal(tag.server, 'figma');
  assert.equal(tag.sourceOwner, 'shared');
  assert.equal(tag.to, V2('production', 'dsh', 'figma'));
});

test('migrate --apply: writes an owned copy, never touches the legacy key, never calls a provider', async () => {
  const store = fakeStore();
  store._data.set(LEGACY('production', 'notion'), JSON.stringify({ access_token: 'A1', refresh_token: 'R1', client_id: 'CID', expires_at: 123 }));
  const result = await migrate({ store, servers: ['notion'], environment: 'production', targetOwner: 'dsh', apply: true });
  assert.equal(result.applied.length, 1);
  const rec = JSON.parse(store._data.get(V2('production', 'dsh', 'notion')));
  assert.equal(rec.owner, 'dsh');
  assert.equal(rec.source, 'dsh-exported');
  assert.equal(rec.environment, 'production');
  assert.equal(rec.grantId, 'dsh:production:notion');
  assert.equal(rec.access_token, 'A1', 'access token preserved verbatim');
  assert.equal(rec.refresh_token, 'R1', 'refresh token preserved verbatim');
  assert.equal(store._data.has(V2('production', 'gateway', 'notion')), false);
  assert.ok(store._data.has(LEGACY('production', 'notion')), 'legacy alias is never written/deleted');
  assert.equal(store.commands.filter(([cmd]) => cmd === 'set').length, 1);
});

test('migrate: refuses owner=gateway without explicit opt-in; refuses missing KV', async () => {
  const store = fakeStore();
  await assert.rejects(
    () => migrate({ store, servers: ['notion'], environment: 'production', targetOwner: 'gateway' }),
    /allow-gateway/,
  );
  await assert.rejects(
    () => migrate({ store: null, servers: ['notion'], environment: 'production' }),
    /KV store is not configured/,
  );
});
