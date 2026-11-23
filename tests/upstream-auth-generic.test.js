import test from 'node:test';
import assert from 'node:assert/strict';

import { UpstreamAuth, defaultProvider } from '../src/upstream-auth.js';
import { UpstreamManager } from '../src/upstreams.js';

function memoryStore() {
  const data = new Map();
  return {
    data,
    isConfigured: () => true,
    _command: async (cmd, key, value, ...rest) => {
      if (cmd === 'get') return data.get(key) ?? null;
      if (cmd === 'set') {
        if (rest.includes('NX') && data.has(key)) return null;
        data.set(key, value);
        return 'OK';
      }
      if (cmd === 'del') { data.delete(key); return 1; }
      return null;
    },
    casToken: async (key, expectedRefresh, nextJson) => {
      const current = data.get(key);
      if (!current || JSON.parse(current).refresh_token !== expectedRefresh) return false;
      data.set(key, nextJson);
      return true;
    },
  };
}

test('a custom provider refreshes at its configured refreshUrl', async () => {
  const store = memoryStore();
  const calls = [];
  const auth = new UpstreamAuth({
    store,
    fetch: async (url, options) => {
      calls.push({ url, body: String(options?.body ?? '') });
      return { ok: true, json: async () => ({ access_token: 'NEW_AT', refresh_token: 'NEW_RT', expires_in: 3600 }) };
    },
  });

  const token = await auth.getAccessToken('acme', {
    envToken: 'AT',
    envRefresh: 'RT',
    envClientId: 'CID',
    envClientSecret: 'CSEC',
    tokenUrl: 'https://auth.example/token',
    mcpUrl: 'https://mcp.example/mcp',
    grantOwner: 'gateway', source: 'gateway-oauth',
  });

  assert.equal(token, 'NEW_AT');
  assert.equal(calls[0].url, 'https://auth.example/token');
  assert.match(calls[0].body, /client_secret=CSEC/);
  assert.equal(JSON.parse(store.data.get('gmcgw:v2:grant:local:gateway:acme')).refresh_token, 'NEW_RT');
});

test('built-in providers keep their default token endpoint', () => {
  assert.deepEqual(defaultProvider('notion'), { tokenUrl: 'https://mcp.notion.com/token', mcpUrl: 'https://mcp.notion.com/mcp' });
  assert.deepEqual(defaultProvider('linear'), { tokenUrl: 'https://mcp.linear.app/token', mcpUrl: 'https://mcp.linear.app/mcp' });
  assert.equal(defaultProvider('github'), null);
});

test('static-token upstreams never enter the refresh path', async () => {
  let fetched = 0;
  const auth = new UpstreamAuth({ store: memoryStore(), fetch: async () => { fetched += 1; return { ok: false }; } });
  const token = await auth.getAccessToken('github', { envToken: 'ghp_static' });
  assert.equal(token, 'ghp_static');
  assert.equal(fetched, 0);
});

test('UpstreamManager forwards refreshUrl and mcpUrl from config to the auth layer', async () => {
  const seen = [];
  const fakeAuth = {
    getAccessToken: async (name, options) => {
      seen.push({ name, options });
      return 'T';
    },
  };
  const client = {
    connect: async () => {},
    listTools: async () => ({ tools: [] }),
    close: async () => {},
  };
  const manager = new UpstreamManager([{
    name: 'custom',
    transport: 'http',
    url: 'https://mcp.example/mcp',
    tokenEnv: 'CUSTOM_TOKEN',
    refreshEnv: 'CUSTOM_REFRESH',
    clientIdEnv: 'CUSTOM_CLIENT',
    refreshUrl: 'https://auth.example/token',
  }], { auth: fakeAuth, clientFactory: () => client });
  process.env.CUSTOM_TOKEN = 'env-token';
  try {
    await manager.connect();
  } finally {
    delete process.env.CUSTOM_TOKEN;
  }
  assert.equal(seen.length, 1);
  assert.equal(seen[0].name, 'custom');
  assert.equal(seen[0].options.tokenUrl, 'https://auth.example/token');
  assert.equal(seen[0].options.mcpUrl, 'https://mcp.example/mcp');
});
