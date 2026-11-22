import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { UpstreamManager } from '../src/upstreams.js';
import { createGatewayServer } from '../src/server.js';
import { runInSandbox } from '../src/codemode.js';

const fakeUpstream = fileURLToPath(new URL('../harness/fake-upstream.mjs', import.meta.url));

test('runInSandbox: tool call returns result, only code return value kept', async () => {
  const out = await runInSandbox({
    code: `async () => { const r = await codemode.fake__search_code({query:'x'}); return { ok: true, hasResult: !!r }; }`,
    tools: [{ name: 'fake__search_code', server: 'fake', tool: 'search_code', description: 'search code', inputSchema: {} }],
    callTool: async () => ({ content: [{ type: 'text', text: JSON.stringify({ huge: 'x'.repeat(50000) }) }] }),
  });
  assert.equal(out.result.includes('hasResult'), true);
  assert.ok(out.result.length < 500); // big upstream result filtered by code, not returned
  assert.equal(out.toolCalls.length, 1);
  assert.equal(out.toolCalls[0].name, 'fake__search_code');
});

test('runInSandbox: console.log captured as logs, not result', async () => {
  const out = await runInSandbox({
    code: `async () => { console.log('hello', 42); return 'done'; }`,
    tools: [], callTool: async () => ({}),
  });
  assert.equal(out.result, 'done');
  assert.ok(out.logs.some((l) => l.includes('hello')));
});

test('runInSandbox: tool call limit enforced (returned as error result)', async () => {
  const out = await runInSandbox({
    code: `async () => { for (let i=0;i<10;i++) await codemode.t({}); return 'x'; }`,
    tools: [{ name: 't', server: 'f', tool: 't', description: 't', inputSchema: {} }],
    callTool: async () => ({}),
    maxCalls: 3,
  });
  assert.equal(out.isError, true);
  assert.match(out.result, /tool call limit/);
});

// --- batch 11 · no silent truncation ---------------------------------------

test('batch11: readFileRange returns full lines by default, marked cuts when capped', async () => {
  const longLine = `L${'abcdefghij'.repeat(30)}Z`;
  const text = `head\n${longLine}\ntail`;
  const out = await runInSandbox({
    code: `async () => ({
      full: await codemode.readFileRange({path:'x', startLine:1, endLine:3, tools:{readTool:'fake__get_file_contents'}}),
      capped: await codemode.readFileRange({path:'x', startLine:1, endLine:3, maxCharsPerLine:150, tools:{readTool:'fake__get_file_contents'}})
    })`,
    tools: [{ name: 'fake__get_file_contents', server: 'fake', tool: 'get_file_contents', description: 'read', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } }],
    callTool: async () => ({ content: [{ type: 'text', text }] }),
  });
  assert.ok(!out.isError, out.result);
  const r = JSON.parse(out.result);
  assert.deepEqual(r.full.lines, ['head', longLine, 'tail']);
  assert.equal(r.full.truncated, false);
  assert.equal(r.full.truncation, undefined);
  assert.equal(r.capped.truncated, true);
  assert.equal(r.capped.truncation.reason, 'maxCharsPerLine');
  assert.equal(r.capped.lines[1], longLine.slice(0, 150));
});

test('batch11: grepSnippet marks its char window', async () => {
  const out = await runInSandbox({
    code: `async () => codemode.grepSnippet('${'x'.repeat(200)} needle ${'y'.repeat(200)}', 'needle', 40)`,
    tools: [], callTool: async () => ({}),
  });
  assert.ok(!out.isError, out.result);
  const r = JSON.parse(out.result);
  assert.equal(r[0].truncated, true);
  assert.equal(r[0].truncation.reason, 'grepWindow');
});

test('codemode server exposes only search + execute', async () => {
  const child = spawn(process.execPath, [fakeUpstream], { stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    const mgr = new UpstreamManager([{ name: 'github', transport: 'stdio', command: process.execPath, args: [fakeUpstream] }]);
    await mgr.connect();
    const server = createGatewayServer(mgr, { mode: 'codemode' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['execute', 'execute_read', 'search']);
    // read-only tool must advertise readOnlyHint
    const execRead = tools.find((t) => t.name === 'execute_read');
    assert.equal(execRead.annotations.readOnlyHint, true);
    const execFull = tools.find((t) => t.name === 'execute');
    assert.equal(execFull.annotations.destructiveHint, true);
    await client.close();
    await mgr.close();
  } finally { child.kill(); }
});
