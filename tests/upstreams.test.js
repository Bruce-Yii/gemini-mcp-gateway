import test from 'node:test';
import assert from 'node:assert/strict';
import { UpstreamManager } from '../src/upstreams.js';

const ENV_KEY = 'GATEWAY_TEST_TOKEN_DO_NOT_USE';

test('tokenEnv: missing environment variable rejects with a clear error', async () => {
  delete process.env[ENV_KEY];
  const mgr = new UpstreamManager([
    { name: 'gh', transport: 'http', url: 'https://example.invalid/mcp', tokenEnv: ENV_KEY },
  ]);
  await assert.rejects(() => mgr._createTransport(mgr.configs[0]), /环境变量.*未设置/);
});

test('tokenEnv: env token becomes Authorization bearer header', async () => {
  process.env[ENV_KEY] = 'test-token-abc';
  const mgr = new UpstreamManager([
    { name: 'gh', transport: 'http', url: 'https://example.invalid/mcp', tokenEnv: ENV_KEY },
  ]);
  const transport = await mgr._createTransport(mgr.configs[0]);
  const headers = transport._requestInit?.headers ?? transport.requestInit?.headers;
  const auth = headers?.Authorization ?? headers?.get?.('Authorization');
  assert.equal(auth, 'Bearer test-token-abc');
  delete process.env[ENV_KEY];
});

test('tokenEnv: explicit headers still carried alongside token', async () => {
  process.env[ENV_KEY] = 'test-token-xyz';
  const mgr = new UpstreamManager([
    {
      name: 'gh',
      transport: 'http',
      url: 'https://example.invalid/mcp',
      tokenEnv: ENV_KEY,
      headers: { 'X-Custom': 'v' },
    },
  ]);
  const transport = await mgr._createTransport(mgr.configs[0]);
  const headers = transport._requestInit?.headers ?? transport.requestInit?.headers;
  assert.equal(headers['X-Custom'], 'v');
  assert.equal(headers.Authorization, 'Bearer test-token-xyz');
  delete process.env[ENV_KEY];
});

test('authScheme: basic sends an Authorization: Basic header', async () => {
  process.env[ENV_KEY] = 'dXNlcjpwYXNz';
  const mgr = new UpstreamManager([
    {
      name: 'atlassian',
      transport: 'http',
      url: 'https://example.invalid/mcp',
      tokenEnv: ENV_KEY,
      authScheme: 'basic',
    },
  ]);
  const transport = await mgr._createTransport(mgr.configs[0]);
  const headers = transport._requestInit?.headers ?? transport.requestInit?.headers;
  assert.equal(headers.Authorization, 'Basic dXNlcjpwYXNz');
  delete process.env[ENV_KEY];
});

test('authScheme: provider-specific scheme is preserved verbatim (Sentry-Bearer)', async () => {
  process.env[ENV_KEY] = 'sentry-user-token';
  const mgr = new UpstreamManager([
    {
      name: 'sentry',
      transport: 'http',
      url: 'https://example.invalid/mcp',
      tokenEnv: ENV_KEY,
      authScheme: 'Sentry-Bearer',
    },
  ]);
  const transport = await mgr._createTransport(mgr.configs[0]);
  const headers = transport._requestInit?.headers ?? transport.requestInit?.headers;
  assert.equal(headers.Authorization, 'Sentry-Bearer sentry-user-token');
  delete process.env[ENV_KEY];
});

test('tokenHeader: raw token goes into a custom header (Figma X-Figma-Token)', async () => {
  process.env[ENV_KEY] = 'figma-pat';
  const mgr = new UpstreamManager([
    {
      name: 'figma',
      transport: 'http',
      url: 'https://example.invalid/mcp',
      tokenEnv: ENV_KEY,
      tokenHeader: 'X-Figma-Token',
    },
  ]);
  const transport = await mgr._createTransport(mgr.configs[0]);
  const headers = transport._requestInit?.headers ?? transport.requestInit?.headers;
  assert.equal(headers['X-Figma-Token'], 'figma-pat');
  assert.equal(headers.Authorization, undefined);
  delete process.env[ENV_KEY];
});

test('gateway-owned OAuth without tokenEnv resolves KV token and sends Authorization', async () => {
  const auth = {
    getAccessToken: async (server, env) => {
      assert.equal(server, 'notion');
      assert.equal(env.envToken, undefined);
      return 'kv-gateway-token';
    },
  };
  const mgr = new UpstreamManager([
    {
      name: 'notion',
      transport: 'http',
      url: 'https://example.invalid/mcp',
      authorizeUrl: 'https://mcp.notion.com/authorize',
      refreshUrl: 'https://mcp.notion.com/token',
      grantOwner: 'gateway',
    },
  ], { auth });
  const transport = await mgr._createTransport(mgr.configs[0]);
  const headers = transport._requestInit?.headers ?? transport.requestInit?.headers;
  assert.equal(headers.Authorization, 'Bearer kv-gateway-token');
});
