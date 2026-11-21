import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createGatewayServer } from '../src/server.js';
import { formatParams, unwrapResult } from '../src/tool-format.js';
import { runInSandbox } from '../src/codemode.js';

const TOOLS = [
  { server: 'github', tool: 'get_me', name: 'github__get_me', description: 'get me', inputSchema: { type: 'object', properties: {}, required: [] } },
  { server: 'vercel', tool: 'list_projects', name: 'vercel__list_projects', description: 'List all projects in the workspace with pagination and filtering options for team and status', inputSchema: { type: 'object', properties: { limit: { type: 'string' }, teamId: { type: 'string' } }, required: [] } },
  { server: 'linear', tool: 'list_issues', name: 'linear__list_issues', description: 'list issues with many options', inputSchema: { type: 'object', properties: { teamId: { type: 'string' }, limit: { type: 'number' }, state: { type: 'string', enum: ['open', 'closed'] } }, required: ['teamId'] } },
];
const mgr = {
  getEntries: () => TOOLS,
  getWhitelist: () => TOOLS,
  callTool: async (server, tool, args) => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true, server, tool }) }] }),
};

test('P0-2: param signatures show type, required!, enum', () => {
  const p = formatParams(TOOLS[2].inputSchema);
  assert.ok(p.includes('teamId!: string'), 'teamId required marker');
  assert.ok(p.includes('limit?: number'), 'limit type number');
  assert.ok(p.includes('state?: string (open|closed)'), 'enum choices');
});

test('P0-3: unwrapResult parses JSON and throws on isError', () => {
  assert.deepEqual(unwrapResult({ content: [{ type: 'text', text: '{"a":1}' }] }), { a: 1 });
  assert.equal(unwrapResult({ content: [{ type: 'text', text: 'plain' }] }), 'plain');
  assert.throws(() => unwrapResult({ isError: true, content: [{ type: 'text', text: 'boom' }] }), /boom/);
});

test('P1-5: console.warn/info/debug available in sandbox', async () => {
  const out = await runInSandbox({
    code: `async () => { console.info('i'); console.warn('w'); console.debug('d'); return 1; }`,
    tools: [], callTool: async () => ({}),
  });
  assert.ok(out.logs.some((l) => l.includes('i')));
  assert.ok(out.logs.some((l) => l.includes('WARN w')));
  assert.ok(out.logs.some((l) => l.includes('d')));
});

test('P0-3 in-sandbox: tool result auto-unwrapped (no JSON.parse needed)', async () => {
  const out = await runInSandbox({
    code: `async () => { const r = await codemode.github__get_me({}); return r.ok; }`,
    tools: TOOLS, callTool: async () => ({ content: [{ type: 'text', text: '{"ok":true}' }] }),
  });
  assert.equal(out.result, 'true');
});

test('P0-2/P1-6: external search returns typed params; select: returns full schema; codemode.search same shape', async () => {
  const server = createGatewayServer(mgr, { mode: 'codemode' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const c = new Client({ name: 't', version: '1' });
  await c.connect(ct);
  let r = await c.callTool({ name: 'search', arguments: { query: 'list issues' } });
  let data = JSON.parse(r.content[0].text);
  const issueMatch = data.matches.find((m) => m.name === 'linear__list_issues');
  assert.ok(issueMatch.params.some((p) => p.includes('teamId!: string')), 'typed params in search');
  r = await c.callTool({ name: 'search', arguments: { query: 'select:linear__list_issues' } });
  data = JSON.parse(r.content[0].text);
  assert.ok(data.matches[0].inputSchema, 'select returns full inputSchema');
  await c.close();
});

test('P1-4: explicit service prefix filters other services', async () => {
  const server = createGatewayServer(mgr, { mode: 'codemode' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const c = new Client({ name: 't', version: '1' });
  await c.connect(ct);
  const r = await c.callTool({ name: 'search', arguments: { query: 'vercel create update delete', limit: 10 } });
  const data = JSON.parse(r.content[0].text);
  assert.ok(data.matches.length > 0);
  assert.ok(data.matches.every((m) => m.name.startsWith('vercel__')), `all results should be vercel, got ${data.matches.map((m) => m.name).join(',')}`);
  await c.close();
});

// ---------- 2026-11-22 residual Gemini feedback: Promise chaining ----------

test('sandbox tool calls are native Promises: .then/.catch/Promise.all work', async () => {
  const echo = { server: 'fake', tool: 'echo', name: 'fake__echo', description: 'echo', inputSchema: { type: 'object', properties: { v: { type: 'number' } }, required: ['v'] } };
  const failing = { server: 'fake', tool: 'fail', name: 'fake__fail', description: 'fail', inputSchema: { type: 'object', properties: {} } };
  const callTool = async (_server, tool, args) => {
    if (tool === 'fail') throw new Error('upstream boom');
    return { content: [{ type: 'text', text: JSON.stringify({ v: args.v, doubled: args.v * 2 }) }] };
  };
  const out = await runInSandbox({
    code: `async () => {
      const chained = await codemode.fake__echo({ v: 2 }).then((r) => r.doubled);
      const caught = await codemode.fake__fail({}).catch((e) => 'caught:' + e.message);
      const batch = await Promise.all([1, 2, 3].map((v) => codemode.fake__echo({ v }).then((r) => r.v)));
      return { chained, caught, batch };
    }`,
    tools: [echo, failing],
    callTool,
  });
  assert.equal(out.isError, undefined);
  assert.deepEqual(JSON.parse(out.result), { chained: 4, caught: 'caught:upstream boom', batch: [1, 2, 3] });
});

test('sandbox helpers stay synchronous (documented contract)', async () => {
  const out = await runInSandbox({
    code: `async () => ({
      services: typeof codemode.services().services,
      remaining: typeof codemode.remainingCalls(),
      listed: Array.isArray(codemode.listTools()),
      searched: Array.isArray(codemode.search('anything').matches),
    })`,
    tools: [],
    callTool: async () => ({}),
  });
  assert.deepEqual(JSON.parse(out.result), { services: 'object', remaining: 'number', listed: true, searched: true });
});

test('execute_read write-stubs still throw synchronously when un-awaited', async () => {
  const out = await runInSandbox({
    code: `async () => { codemode.github__issue_write({}); return 'should not reach'; }`,
    tools: [],
    unavailableTools: [{ server: 'github', tool: 'issue_write', name: 'github__issue_write' }],
    callTool: async () => ({}),
  });
  assert.equal(out.isError, true);
  assert.match(out.result, /write tool|execute\(\)/);
});
