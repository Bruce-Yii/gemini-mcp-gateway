import test from 'node:test';
import assert from 'node:assert/strict';
import { UpstreamManager } from '../src/upstreams.js';
import {
  FigmaQuotaCooldownError,
  isFigmaQuotaError,
  createFigmaGuard,
  cacheKey,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_CACHE_MAX,
} from '../src/figma-guard.js';

// No network, no credentials: a fake client records every upstream call.
function fakeClient(handler) {
  const calls = [];
  return {
    calls,
    async callTool(request) {
      calls.push(request);
      return handler(request);
    },
    async connect() {},
    async listTools() { return { tools: [] }; },
    async close() {},
  };
}

function makeManager({ server = 'figma', handler, guardOptions = {} } = {}) {
  const client = fakeClient(handler);
  const mgr = new UpstreamManager(
    [{ name: server, transport: 'http', url: 'https://example.invalid/mcp' }],
    { clientFactory: () => client, figmaGuardOptions: guardOptions },
  );
  mgr._clients.set(server, { client, transport: {}, config: mgr.configs[0] });
  return { mgr, client };
}

const ok = (v = { content: [{ type: 'text', text: 'ok' }] }) => v;

test('defaults: 24h cooldown, 1h cache TTL, 200 entries', () => {
  assert.equal(DEFAULT_COOLDOWN_MS, 24 * 60 * 60 * 1000);
  assert.equal(DEFAULT_CACHE_TTL_MS, 60 * 60 * 1000);
  assert.equal(DEFAULT_CACHE_MAX, 200);
});

test('isFigmaQuotaError detects all patterns, case-insensitively', () => {
  for (const msg of [
    'Figma MCP tool call limit reached',
    'Your Starter plan has no calls left',
    'please upgrade your plan',
    'HTTP 429',
    'Rate limit exceeded',
    'figma mcp TOOL CALL LIMIT',
  ]) assert.equal(isFigmaQuotaError(new Error(msg)), true, msg);
  assert.equal(isFigmaQuotaError(new Error('connection reset')), false);
  assert.equal(isFigmaQuotaError({ isError: true, content: [{ type: 'text', text: 'Starter plan limit' }] }), true);
});

test('quota error opens cooldown; second call does not reach upstream', async () => {
  const { mgr, client } = makeManager({
    handler: () => { throw new Error('Figma MCP tool call limit reached on Starter plan'); },
  });
  await assert.rejects(() => mgr.callTool('figma', 'whoami', {}), /Figma MCP tool call limit/);
  assert.equal(client.calls.length, 1);
  assert.ok(mgr.figmaGuard.cooldownRemainingMs > 0);
  await assert.rejects(() => mgr.callTool('figma', 'whoami', {}), (err) => {
    assert.ok(err instanceof FigmaQuotaCooldownError);
    assert.match(err.message, /Figma 配额冷却中（剩余 \d+ 秒）/);
    assert.equal(err.code, 'FIGMA_QUOTA_COOLDOWN');
    return true;
  });
  assert.equal(client.calls.length, 1, 'upstream must not be called during cooldown');
});

test('cooldown also trips on isError results returned by MCP callTool', async () => {
  const { mgr, client } = makeManager({
    handler: () => ({
      isError: true,
      content: [{ type: 'text', text: 'rate limit: upgrade your plan' }],
    }),
  });
  await mgr.callTool('figma', 'whoami', {});
  assert.ok(mgr.figmaGuard.cooldownRemainingMs > 0);
  await assert.rejects(() => mgr.callTool('figma', 'whoami', {}), FigmaQuotaCooldownError);
  assert.equal(client.calls.length, 1);
});

test('other servers are completely unaffected by Figma cooldown', async () => {
  const figma = fakeClient(() => { throw new Error('Figma MCP tool call limit'); });
  const githubClient = fakeClient(() => ok());
  const mgr = new UpstreamManager(
    [
      { name: 'figma', transport: 'http', url: 'https://example.invalid/f' },
      { name: 'github', transport: 'http', url: 'https://example.invalid/g' },
    ],
    { clientFactory: () => figma },
  );
  mgr._clients.set('figma', { client: figma, transport: {}, config: mgr.configs[0] });
  mgr._clients.set('github', { client: githubClient, transport: {}, config: mgr.configs[1] });
  await assert.rejects(() => mgr.callTool('figma', 'whoami', {}), /limit/);
  const cooldownBefore = mgr.figmaGuard.cooldownRemainingMs;
  const result = await mgr.callTool('github', 'get_file', { path: 'a' });
  assert.deepEqual(result, ok());
  assert.equal(githubClient.calls.length, 1);
  // The Figma breaker state is untouched by any GitHub traffic (allow a small
  // clock tick while the GitHub call was awaited).
  assert.ok(mgr.figmaGuard.cooldownRemainingMs > 0);
  assert.ok(Math.abs(cooldownBefore - mgr.figmaGuard.cooldownRemainingMs) < 1000);

  // Conversely, a quota-looking error from a non-Figma upstream never trips it.
  const mgr2 = makeManager({ server: 'github', handler: () => { throw new Error('429 rate limit'); } });
  await assert.rejects(() => mgr2.mgr.callTool('github', 'get_file', {}), /429/);
  assert.equal(mgr2.mgr.figmaGuard.cooldownRemainingMs, 0);
});

test('whoami and get_metadata successful results are cached (upstream hit once)', async () => {
  const { mgr, client } = makeManager({ handler: () => ok({ user: 'u' }) });
  const a = await mgr.callTool('figma', 'whoami', {});
  const b = await mgr.callTool('figma', 'whoami', {});
  assert.deepEqual(a, b);
  assert.equal(client.calls.length, 1);
  const m = await mgr.callTool('figma', 'get_metadata', { file_key: 'F1' });
  await mgr.callTool('figma', 'get_metadata', { file_key: 'F1' });
  assert.deepEqual(m, ok({ user: 'u' }));
  assert.equal(client.calls.length, 2);
});

test('cache key uses canonical JSON of args (key order irrelevant)', () => {
  assert.equal(cacheKey('whoami', { a: 1, b: 2 }), cacheKey('whoami', { b: 2, a: 1 }));
  assert.notEqual(cacheKey('whoami', { a: 1 }), cacheKey('whoami', { a: 2 }));
});

test('write tools bypass cache entirely', async () => {
  const { mgr, client } = makeManager({ handler: () => ok() });
  await mgr.callTool('figma', 'create_new_file', { name: 'x' });
  await mgr.callTool('figma', 'create_new_file', { name: 'x' });
  assert.equal(client.calls.length, 2);
  assert.equal(mgr.figmaGuard.cacheSize, 0);
});

test('failed results are never cached', async () => {
  let n = 0;
  const { mgr, client } = makeManager({
    handler: () => (++n === 1 ? { isError: true, content: [{ type: 'text', text: 'file not found' }] } : ok()),
  });
  await mgr.callTool('figma', 'get_metadata', { file_key: 'x' });
  assert.equal(mgr.figmaGuard.cacheSize, 0);
  const second = await mgr.callTool('figma', 'get_metadata', { file_key: 'x' });
  assert.deepEqual(second, ok());
  assert.equal(client.calls.length, 2);
});

test('cooldown takes priority over an existing cached read', async () => {
  let n = 0;
  const { mgr, client } = makeManager({
    handler: () => {
      n += 1;
      if (n === 1) return ok({ user: 'cached' });
      throw new Error('Starter plan limit reached');
    },
  });
  await mgr.callTool('figma', 'whoami', {}); // fills cache
  // A write call trips the breaker; cached read must now be unreachable.
  await assert.rejects(() => mgr.callTool('figma', 'create_new_file', {}), /limit/);
  await assert.rejects(() => mgr.callTool('figma', 'whoami', {}), FigmaQuotaCooldownError);
  assert.equal(client.calls.length, 2);
});

test('cache TTL expiry causes a fresh upstream call', async () => {
  const { mgr, client } = makeManager({
    handler: () => ok({ n: client.calls.length }),
    guardOptions: { cacheTtlMs: 5, cooldownMs: 1000 },
  });
  await mgr.callTool('figma', 'whoami', {});
  await mgr.callTool('figma', 'whoami', {});
  assert.equal(client.calls.length, 1);
  await new Promise((resolve) => setTimeout(resolve, 15));
  await mgr.callTool('figma', 'whoami', {});
  assert.equal(client.calls.length, 2);
});

test('cache capacity is bounded (LRU eviction, default 200)', () => {
  const guard = createFigmaGuard({ cacheMax: 3, cacheTtlMs: 10000 });
  for (let i = 0; i < 3; i += 1) guard.set('get_metadata', { k: i }, ok({ i }));
  assert.equal(guard.cacheSize, 3);
  guard.get('get_metadata', { k: 0 }); // touch k=0 so k=1 becomes oldest
  guard.set('get_metadata', { k: 3 }, ok({ i: 3 }));
  assert.equal(guard.cacheSize, 3);
  assert.equal(guard.get('get_metadata', { k: 1 }), undefined);
  assert.notEqual(guard.get('get_metadata', { k: 0 }), undefined);
  assert.notEqual(guard.get('get_metadata', { k: 3 }), undefined);
});

test('cooldown expiry lets calls through again', async () => {
  let n = 0;
  const { mgr, client } = makeManager({
    handler: () => {
      n += 1;
      if (n === 1) throw new Error('429 rate limit');
      return ok();
    },
    guardOptions: { cooldownMs: 5 },
  });
  await assert.rejects(() => mgr.callTool('figma', 'get_metadata', {}), /429/);
  await assert.rejects(() => mgr.callTool('figma', 'get_metadata', {}), FigmaQuotaCooldownError);
  await new Promise((resolve) => setTimeout(resolve, 15));
  await mgr.callTool('figma', 'get_metadata', { file_key: 'again' });
  assert.equal(client.calls.length, 2);
});
