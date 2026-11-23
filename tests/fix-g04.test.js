import test from 'node:test';
import assert from 'node:assert/strict';
import { UpstreamManager } from '../src/upstreams.js';

/**
 * G-04 regression suite: callTool() must re-check allow/deny on every call.
 *
 * All tests are offline. A fake MCP client records every upstream callTool()
 * request; we drive the REAL UpstreamManager.connect() code path with a fake
 * clientFactory, then call mgr.callTool() directly — exactly what the
 * gateway_call / codemode bridges do — to prove a denied tool never reaches
 * the upstream.
 */

const TOOLS = [
  { name: 'read_file', description: 'read', inputSchema: { type: 'object', properties: {} } },
  { name: 'delete_file', description: 'delete', inputSchema: { type: 'object', properties: {} } },
  { name: 'list_issues', description: 'list', inputSchema: { type: 'object', properties: {} } },
];

function fakeClient(upstreamCalls) {
  return {
    async connect() {},
    async listTools() { return { tools: TOOLS.map((t) => ({ ...t })) }; },
    async callTool(request) {
      upstreamCalls.push(request);
      return { content: [{ type: 'text', text: 'ok' }] };
    },
    async close() {},
  };
}

async function makeManager(configExtra = {}) {
  const upstreamCalls = [];
  const client = fakeClient(upstreamCalls);
  const config = {
    name: 'svc',
    transport: 'http',
    url: 'https://example.invalid/mcp',
    ...configExtra,
  };
  const mgr = new UpstreamManager([config], { clientFactory: () => client });
  await mgr.connect();
  assert.deepEqual(mgr.failedServers, [], 'fake upstream should connect cleanly');
  return { mgr, upstreamCalls, client };
}

// ---------- connect() filtering stays intact ----------

test('G-04 connect filtering: denied tools are absent from entries/whitelist', async () => {
  const { mgr } = await makeManager({ denyTools: ['svc/delete_file'] });
  const names = mgr.getWhitelist().map((e) => e.tool);
  assert.ok(names.includes('read_file'));
  assert.ok(!names.includes('delete_file'));
});

// ---------- default allow ----------

test('G-04 default allow: no rules lets every exposed tool through', async () => {
  const { mgr, upstreamCalls } = await makeManager();
  const result = await mgr.callTool('svc', 'delete_file', {});
  assert.equal(result.content[0].text, 'ok');
  assert.equal(upstreamCalls.length, 1);
  assert.deepEqual(upstreamCalls[0], { name: 'delete_file', arguments: {} });
});

// ---------- allowTools whitelist ----------

test('G-04 allowTools: allowed tool reaches upstream', async () => {
  const { mgr, upstreamCalls } = await makeManager({ allowTools: ['svc/read_file'] });
  const result = await mgr.callTool('svc', 'read_file', {});
  assert.equal(result.content[0].text, 'ok');
  assert.equal(upstreamCalls.length, 1);
});

test('G-04 allowTools: non-whitelisted tool is rejected with NO upstream request', async () => {
  const { mgr, upstreamCalls } = await makeManager({ allowTools: ['svc/read_file'] });
  await assert.rejects(
    () => mgr.callTool('svc', 'delete_file', {}),
    (err) => {
      assert.equal(err.code, 'TOOL_POLICY_DENIED');
      assert.match(err.message, /\[upstream:svc\/delete_file\].*策略拒绝/);
      return true;
    },
  );
  assert.equal(upstreamCalls.length, 0, 'denied call must not touch upstream');
});

test('G-04 allowTools: wildcard allow permits matching tool', async () => {
  const { mgr, upstreamCalls } = await makeManager({ allowTools: ['svc/*'] });
  await mgr.callTool('svc', 'list_issues', {});
  assert.equal(upstreamCalls.length, 1);
});

// ---------- denyTools blacklist ----------

test('G-04 denyTools: denied tool is rejected with NO upstream request', async () => {
  const { mgr, upstreamCalls } = await makeManager({ denyTools: ['svc/delete_file'] });
  await assert.rejects(
    () => mgr.callTool('svc', 'delete_file', {}),
    (err) => err.code === 'TOOL_POLICY_DENIED',
  );
  assert.equal(upstreamCalls.length, 0);
});

test('G-04 denyTools: non-denied tool still reaches upstream', async () => {
  const { mgr, upstreamCalls } = await makeManager({ denyTools: ['svc/delete_file'] });
  await mgr.callTool('svc', 'read_file', {});
  assert.equal(upstreamCalls.length, 1);
});

test('G-04 denyTools: wildcard deny blocks all matching tools', async () => {
  const { mgr, upstreamCalls } = await makeManager({ denyTools: ['svc/*'] });
  await assert.rejects(
    () => mgr.callTool('svc', 'read_file', {}),
    (err) => err.code === 'TOOL_POLICY_DENIED',
  );
  assert.equal(upstreamCalls.length, 0);
});

// ---------- deny takes precedence over allow ----------

test('G-04 deny wins: allow "*" + deny tool still rejects', async () => {
  const { mgr, upstreamCalls } = await makeManager({
    allowTools: ['*'],
    denyTools: ['svc/delete_file'],
  });
  await assert.rejects(
    () => mgr.callTool('svc', 'delete_file', {}),
    (err) => err.code === 'TOOL_POLICY_DENIED',
  );
  assert.equal(upstreamCalls.length, 0);
});

test('G-04 deny wins: tool in both allow and deny is rejected', async () => {
  const { mgr, upstreamCalls } = await makeManager({
    allowTools: ['svc/delete_file'],
    denyTools: ['svc/delete_file'],
  });
  await assert.rejects(
    () => mgr.callTool('svc', 'delete_file', {}),
    (err) => err.code === 'TOOL_POLICY_DENIED',
  );
  assert.equal(upstreamCalls.length, 0);
});

test('G-04 deny wins: non-denied tool under allow+deny still passes', async () => {
  const { mgr, upstreamCalls } = await makeManager({
    allowTools: ['svc/*'],
    denyTools: ['svc/delete_file'],
  });
  await mgr.callTool('svc', 'read_file', {});
  assert.equal(upstreamCalls.length, 1);
});

// ---------- empty array semantics ----------

test('G-04 empty arrays behave as default allow', async () => {
  const { mgr, upstreamCalls } = await makeManager({ allowTools: [], denyTools: [] });
  await mgr.callTool('svc', 'delete_file', {});
  assert.equal(upstreamCalls.length, 1);
});

test('G-04 empty allowTools + non-empty denyTools follows deny only', async () => {
  const { mgr, upstreamCalls } = await makeManager({
    allowTools: [],
    denyTools: ['svc/delete_file'],
  });
  await mgr.callTool('svc', 'read_file', {});
  assert.equal(upstreamCalls.length, 1);
  await assert.rejects(
    () => mgr.callTool('svc', 'delete_file', {}),
    (err) => err.code === 'TOOL_POLICY_DENIED',
  );
  assert.equal(upstreamCalls.length, 1, 'second call must not reach upstream');
});

// ---------- unknown tool ----------

test('G-04 unknown tool is rejected before any upstream request', async () => {
  const { mgr, upstreamCalls } = await makeManager();
  await assert.rejects(
    () => mgr.callTool('svc', 'never_exposed', {}),
    (err) => {
      assert.equal(err.code, 'UNKNOWN_UPSTREAM_TOOL');
      assert.match(err.message, /\[upstream:svc\/never_exposed\]/);
      return true;
    },
  );
  assert.equal(upstreamCalls.length, 0);
});

test('G-04 unknown server keeps existing error', async () => {
  const { mgr, upstreamCalls } = await makeManager();
  await assert.rejects(
    () => mgr.callTool('other', 'read_file', {}),
    /未连接或未配置的上游/,
  );
  assert.equal(upstreamCalls.length, 0);
});

// ---------- repeated/parallel bypass attempts ----------

test('G-04 denied tool stays blocked on repeat calls', async () => {
  const { mgr, upstreamCalls } = await makeManager({ denyTools: ['svc/delete_file'] });
  for (let i = 0; i < 3; i++) {
    await assert.rejects(
      () => mgr.callTool('svc', 'delete_file', {}),
      (err) => err.code === 'TOOL_POLICY_DENIED',
    );
  }
  assert.equal(upstreamCalls.length, 0);
});

test('G-04 parallel allowed + denied calls: only allowed reaches upstream', async () => {
  const { mgr, upstreamCalls } = await makeManager({ denyTools: ['svc/delete_file'] });
  const settled = await Promise.allSettled([
    mgr.callTool('svc', 'read_file', {}),
    mgr.callTool('svc', 'delete_file', {}),
  ]);
  assert.equal(settled[0].status, 'fulfilled');
  assert.equal(settled[1].status, 'rejected');
  assert.equal(settled[1].reason.code, 'TOOL_POLICY_DENIED');
  assert.equal(upstreamCalls.length, 1);
  assert.equal(upstreamCalls[0].name, 'read_file');
});
