import test from 'node:test';
import assert from 'node:assert/strict';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { normalizeToolArguments, toSnakeCase } from '../src/sanitize.js';
import { UpstreamManager } from '../src/upstreams.js';
import { createGatewayServer } from '../src/server.js';

// ---------------------------------------------------------------------------
// toSnakeCase: boundary rules from CamelCaseArgumentsMiddleware
// ---------------------------------------------------------------------------

test('toSnakeCase: lower/digit->Upper and Upper->Upper+lower boundaries', () => {
  assert.equal(toSnakeCase('createdAt'), 'created_at');
  assert.equal(toSnakeCase('pageId'), 'page_id');
  assert.equal(toSnakeCase('timeMin'), 'time_min');
  assert.equal(toSnakeCase('iCalUid'), 'i_cal_uid');
  assert.equal(toSnakeCase('iCalUID'), 'i_cal_uid'); // 同一目标 -> 交给规则④歧义保护
  assert.equal(toSnakeCase('already_snake'), 'already_snake');
  assert.equal(toSnakeCase('URLValue'), 'url_value');
});

// ---------------------------------------------------------------------------
// normalizeToolArguments: the four rules
// ---------------------------------------------------------------------------

test('规则①：键本身是 schema 声明参数则跳过（含 Notion 原生 camelCase）', () => {
  const schema = {
    type: 'object',
    properties: {
      pageId: { type: 'string' },
      databaseId: { type: 'string' },
      isInline: { type: 'boolean' },
      created_at: { type: 'string' },
    },
  };
  const args = {
    pageId: 'page-123',
    databaseId: 'db-456',
    isInline: true,
    createdAt: '2024-01-01',
  };
  const out = normalizeToolArguments(args, schema);

  assert.equal(out.pageId, 'page-123');
  assert.equal(out.databaseId, 'db-456');
  assert.equal(out.isInline, true);
  assert.equal(out.created_at, '2024-01-01');
  assert.equal(Object.hasOwn(out, 'createdAt'), false);
});

test('规则②：键的 snake_case 形式是声明参数则转过去', () => {
  const schema = { type: 'object', properties: { created_at: { type: 'string' } } };
  const args = { createdAt: '2024-01-01' };
  const out = normalizeToolArguments(args, schema);

  assert.deepEqual(out, { created_at: '2024-01-01' });
  assert.notEqual(out, args, 'rename 时返回新对象');
  assert.deepEqual(args, { createdAt: '2024-01-01' }, '不修改入参');
});

test('规则③：调用方已显式传 snake_case 键时不动 camelCase 版本（显式优先，不覆盖）', () => {
  const schema = { type: 'object', properties: { created_at: { type: 'string' } } };
  const args = { createdAt: 'from-camel', created_at: 'explicit-snake' };
  const out = normalizeToolArguments(args, schema);

  assert.equal(out.createdAt, 'from-camel');
  assert.equal(out.created_at, 'explicit-snake');
  assert.equal(Object.keys(out).length, 2);
});

test('规则④：两个键归一到同一目标时都不动，交上游 schema 校验拒绝', () => {
  const schema = { type: 'object', properties: { i_cal_uid: { type: 'string' } } };
  const args = { iCalUid: 'a', iCalUID: 'b' };
  const out = normalizeToolArguments(args, schema);

  assert.equal(out.iCalUid, 'a');
  assert.equal(out.iCalUID, 'b');
  assert.equal(Object.hasOwn(out, 'i_cal_uid'), false);
  assert.deepEqual(Object.keys(out).sort(), ['iCalUID', 'iCalUid']);
});

// ---------------------------------------------------------------------------
// 边界：不递归、不误伤、无 schema 透传
// ---------------------------------------------------------------------------

test('不递归改写嵌套键（Notion 富文本/复杂对象的键保持原样）', () => {
  const nested = {
    createdAt: 'inner-camel',
    list: [{ plain_text: 'hello', createdAt: 'deep' }],
  };
  const schema = {
    type: 'object',
    properties: {
      created_at: { type: 'string' },
      payload: { type: 'object' },
    },
  };
  const args = { createdAt: 'top', payload: nested };
  const out = normalizeToolArguments(args, schema);

  assert.equal(out.created_at, 'top');
  assert.equal(Object.hasOwn(out, 'createdAt'), false);
  assert.equal(out.payload, nested, '嵌套值原样透传，不克隆、不递归');
  assert.equal(out.payload.createdAt, 'inner-camel');
  assert.equal(out.payload.list[0].plain_text, 'hello');
  assert.equal(out.payload.list[0].createdAt, 'deep');
});

test('未知 camelCase 键（没有匹配的声明 snake 目标）保持不变', () => {
  const schema = { type: 'object', properties: { created_at: { type: 'string' } } };
  const args = { totallyUnknown: 1, createdAt: 'x' };
  const out = normalizeToolArguments(args, schema);

  assert.equal(out.totallyUnknown, 1);
  assert.equal(out.created_at, 'x');
});

test('inputSchema 缺失/非对象/无 properties 时原样返回（同一引用）', () => {
  const args = { createdAt: 'x' };
  for (const schema of [undefined, null, [], 'nope', 42, {}, { properties: null }, { properties: [] }]) {
    assert.equal(normalizeToolArguments(args, schema), args, `schema=${JSON.stringify(schema)}`);
  }
});

test('非对象 args 原样返回', () => {
  const arr = [{ createdAt: 'x' }];
  assert.equal(normalizeToolArguments(null, { properties: { created_at: {} } }), null);
  assert.equal(normalizeToolArguments('abc', { properties: { created_at: {} } }), 'abc');
  assert.equal(normalizeToolArguments(arr, { properties: { created_at: {} } }), arr);
});

test('无 rename 时返回同一引用（零开销 no-op）', () => {
  const schema = { type: 'object', properties: { created_at: {}, q: {} } };
  const args = { q: 'hello' };
  assert.equal(normalizeToolArguments(args, schema), args);
});

// ---------------------------------------------------------------------------
// 集成：两条调用路径都经过 UpstreamManager.callTool 并生效
// ---------------------------------------------------------------------------

const NORM_SCHEMA = {
  type: 'object',
  properties: {
    created_at: { type: 'string' },
    q: { type: 'string' },
  },
  // created_at 故意不放在 required：Code Mode 的 validateToolArgs 预检会放行
  // camelCase 别名，让归一化真正发生在 callTool（与直连路径一致）。
};

function makeManager(schema = NORM_SCHEMA) {
  const calls = [];
  const mgr = new UpstreamManager();
  mgr.entries = [{
    server: 'gh',
    tool: 'gh__list_items',
    name: 'gh__list_items',
    description: 'list items',
    inputSchema: schema,
    _client: {},
  }];
  mgr._clients.set('gh', {
    config: {},
    transport: {},
    client: {
      async callTool(request) {
        calls.push(request);
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
      },
    },
  });
  return { mgr, calls };
}

async function connectClient(mgr, mode) {
  const server = createGatewayServer(mgr, { mode });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: 'normalization-test-client', version: '1.0.0' },
    { capabilities: {} },
  );
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { client, server };
}

test('直连白名单路径：工具 handler 的 camelCase 入参在 callTool 被归一化', async () => {
  const { mgr, calls } = makeManager();
  const { client, server } = await connectClient(mgr, 'whitelist');
  try {
    await client.callTool({
      name: 'gh__list_items',
      arguments: { createdAt: '2024-01-01', q: 'x' },
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].arguments, { created_at: '2024-01-01', q: 'x' });
    assert.equal(calls[0].name, 'gh__list_items');
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  }
});

test('gateway_call 路径：透传的 camelCase 入参同样被归一化', async () => {
  const { mgr, calls } = makeManager();
  const { client, server } = await connectClient(mgr, 'whitelist');
  try {
    await client.callTool({
      name: 'gateway_call',
      arguments: {
        server: 'gh',
        tool: 'gh__list_items',
        arguments: { createdAt: '2024-01-01' },
      },
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].arguments, { created_at: '2024-01-01' });
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  }
});

test('Code Mode 路径：codemode.<tool>({camelCase}) 经 callTool 归一化后发往上游', async () => {
  const { mgr, calls } = makeManager();
  const { client, server } = await connectClient(mgr, 'codemode');
  try {
    const response = await client.callTool({
      name: 'execute',
      arguments: {
        code: "async () => { return await codemode.gh__list_items({ createdAt: '2024-01-01', q: 'x' }); }",
      },
    });
    const payload = JSON.parse(response.content[0].text);
    assert.notEqual(payload.status, 'error', JSON.stringify(payload));
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].arguments, { created_at: '2024-01-01', q: 'x' });
    assert.equal(calls[0].name, 'gh__list_items');
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  }
});
