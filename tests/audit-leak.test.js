/**
 * audit-leak: 按 Cloudflare `toModelOutput` 模式，模型侧只能拿到 return 值。
 *
 * 断言对象是 execute handler 的返回值（server.js 会把它的 JSON.stringify
 * 塞进 MCP text block，即模型实际看到的内容），以及可选的 toModelOutput 投影。
 *
 * 注意：不能只断言"大参数字符串不出现"——现有 summarizeArgs 已经把大参数
 * 压成 `<string len=N>`，那样写今天就会误绿。真正的判据是审计字段整体
 * 不存在，连同它的摘要标记一起不进上下文。
 *
 * 状态（当前 HEAD 03c294b）：toModelOutput 已在 src/codemode.js:150 导出，
 * 并在 execute handler 边界实际调用（src/codemode.js:449-450：先 unwrap
 * makeOutput 的 toJSON，再投影，toolCalls + logs 不进模型上下文）。
 * 因此本文件不再是"功能尚未实现、1/2 预期为红"的草案，而是现行行为的回归测试。
 * 第 3 个用例里的 skip 分支（typeof mod.toModelOutput !== 'function'）现已不触发，
 * 会真正执行投影断言；保留该分支只是历史兼容，并非功能缺失的证据。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCodeModeTools, runInSandbox } from '../src/codemode.js';

const RESULT_TOKEN = 'MODEL_RESULT_SENTINEL_42';
// 长哨兵：完整的大日志才会包含它；Cloudflare 风格的有界日志只留前 4000 字符，
// 不会包含整段，因此 bounded 与 drop 两种实现都能通过。
const LONG_LOG_MARKER = 'AUDIT_LEAK_LOG_'.repeat(500);

const TOOL = {
  name: 'fake__push',
  server: 'fake',
  tool: 'push',
  description: 'push a large content payload',
  inputSchema: { type: 'object', properties: { content: { type: 'string' } } },
};

const CODE = `async () => {
  const big = 'AUDIT_LEAK_ARG_'.repeat(2000);
  await codemode.fake__push({ content: big });
  console.log('AUDIT_LEAK_LOG_'.repeat(2000));
  return '${RESULT_TOKEN}';
}`;

function fakeManager() {
  return {
    getEntries: () => [TOOL],
    callTool: async () => ({ content: [{ type: 'text', text: '{}' }] }),
  };
}

async function modelFacingExecute() {
  const execute = createCodeModeTools(fakeManager()).find((t) => t.name === 'execute');
  assert.ok(execute, 'execute tool must exist');
  return execute.handler({ code: CODE });
}

test('模型侧 execute 输出不含 toolCalls 审计与大参数摘要', async () => {
  const out = await modelFacingExecute();
  const serialized = JSON.stringify(out);

  assert.ok(serialized.includes(RESULT_TOKEN), 'return value must still reach the model');
  assert.ok(
    !/"(toolCalls|calls)"/.test(serialized),
    'toolCalls/calls audit log must never be projected into the model output',
  );
  assert.ok(!serialized.includes('AUDIT_LEAK_ARG'), 'large tool-call args must not be echoed');
  assert.ok(
    !serialized.includes('<string len='),
    'not even summarized audit args may reach the model',
  );
});

test('模型侧 execute 输出不带 unbounded console logs', async () => {
  const out = await modelFacingExecute();
  const serialized = JSON.stringify(out);

  assert.ok(serialized.includes(RESULT_TOKEN), 'return value must still reach the model');
  assert.ok(
    !serialized.includes(LONG_LOG_MARKER),
    'full console.log payload must not reach the model',
  );
  // 若实现选择 Cloudflare 的 bounded-logs 模式而非完全删除，也必须远小于原始体积。
  if (Array.isArray(out.logs)) {
    assert.ok(serialized.length < 20000, 'logs kept in model output must be bounded');
  }
});

test('toModelOutput 投影剥离审计（导出存在时）', async (t) => {
  const mod = await import('../src/codemode.js');
  if (typeof mod.toModelOutput !== 'function') {
    t.skip('toModelOutput 尚未实现，等待 lead 协调合并 codemode.js');
    return;
  }

  // 内部结果仍应是全量的；投影只发生在模型边界。
  const raw = await runInSandbox({
    code: CODE,
    tools: [TOOL],
    callTool: fakeManager().callTool,
  });
  assert.equal(raw.toolCalls.length, 1, 'internal audit trail must be kept');

  const shaped = mod.toModelOutput(raw);
  const serialized = JSON.stringify(shaped);
  assert.ok(serialized.includes(RESULT_TOKEN), 'return value must survive projection');
  assert.ok(!/"(toolCalls|calls)"/.test(serialized));
  assert.ok(!serialized.includes('AUDIT_LEAK_ARG'));
  assert.ok(!serialized.includes('AUDIT_LEAK_LOG'));
});

test('错误结果保留 status/error，但审计同样不进模型输出', async () => {
  const execute = createCodeModeTools(fakeManager()).find((t) => t.name === 'execute');
  const out = await execute.handler({
    code: `async () => { await codemode.fake__push({ content: 'small' }); throw new Error('boom'); }`,
  });
  const serialized = JSON.stringify(out);

  assert.equal(out.status, 'error');
  assert.deepEqual(out.error, { message: 'boom', type: 'Error' });
  assert.ok(out.result.includes('execute error: boom'));
  assert.ok(!/"(toolCalls|calls)"/.test(serialized));
  assert.ok(!serialized.includes('<string len='));
});

test('内部审计链仍在 runInSandbox 结果里（模型侧投影不得破坏它）', async () => {
  const raw = await runInSandbox({
    code: CODE,
    tools: [TOOL],
    callTool: fakeManager().callTool,
  });
  assert.equal(raw.toolCalls.length, 1);
  assert.equal(raw.toolCalls[0].name, 'fake__push');
  // logs 可能被 fix-logs-errors 的 boundLogs() 有界化，这里只要求审计通道仍在，
  // 不要求保留全量原文（全量与否由 lead 决定）。
  assert.ok(Array.isArray(raw.logs) && raw.logs.length > 0);
  assert.ok(raw.result.includes(RESULT_TOKEN));
});
