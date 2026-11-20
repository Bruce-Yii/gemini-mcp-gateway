/**
 * Review 遗留项回归测试：
 *  1. console logs 必须有上限（结构化截断 + `--- TRUNCATED ---` 标记）
 *  2. runInSandbox catch 必须返回结构化错误（status/error），同时保留旧字段
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCodeModeTools, runInSandbox } from '../src/codemode.js';

const NO_CALL = async () => ({});

/* ---------------- logs 上限 ---------------- */

test('logs: 小日志原样保留，不被误伤', async () => {
  const out = await runInSandbox({
    code: `async () => { console.log('hello', 42); return 'ok'; }`,
    tools: [], callTool: NO_CALL,
  });
  assert.equal(out.result, 'ok');
  assert.deepEqual(out.logs, ['hello 42']);
  assert.ok(!JSON.stringify(out.logs).includes('TRUNCATED'));
});

test('logs: 多条日志序列化超 4000 字符后结构化截断并带标记', async () => {
  const out = await runInSandbox({
    code: `async () => {
      for (let i = 0; i < 80; i++) console.log('line-' + i + '-' + 'x'.repeat(200));
      return 'done';
    }`,
    tools: [], callTool: NO_CALL,
  });
  const serialized = JSON.stringify(out.logs);
  assert.ok(serialized.length <= 4000, `serialized logs ${serialized.length} chars must fit 4000`);
  assert.ok(serialized.includes('--- TRUNCATED ---'), 'must carry a truncation marker');
  assert.ok(out.logs.length < 80, 'later lines must be dropped');
  assert.ok(out.logs.some((l) => String(l).includes('line-0-')), 'early lines remain useful');
  assert.equal(out.result, 'done');
});

test('logs: 单条超大对象日志也被截断，不原样回流', async () => {
  const out = await runInSandbox({
    code: `async () => { console.log({ blob: 'z'.repeat(20000) }); return 1; }`,
    tools: [], callTool: NO_CALL,
  });
  const serialized = JSON.stringify(out.logs);
  assert.ok(serialized.length <= 4000, `serialized logs ${serialized.length} chars must fit 4000`);
  assert.ok(serialized.includes('--- TRUNCATED ---'));
});

test('logs: warn/error 通道同样受上限约束', async () => {
  const out = await runInSandbox({
    code: `async () => { console.warn('W'.repeat(15000)); console.error('E'.repeat(15000)); return 1; }`,
    tools: [], callTool: NO_CALL,
  });
  const serialized = JSON.stringify(out.logs);
  assert.ok(serialized.length <= 4000, `serialized logs ${serialized.length} chars must fit 4000`);
  assert.ok(serialized.includes('--- TRUNCATED ---'));
});

test('logs: wire 序列化结果也不会被大日志撑爆', async () => {
  const out = await runInSandbox({
    code: `async () => { console.log('L'.repeat(30000)); return 1; }`,
    tools: [], callTool: NO_CALL,
  });
  const wire = JSON.stringify(out);
  assert.ok(wire.length <= 5000, `serialized output ${wire.length} chars must stay bounded`);
});

/* ---------------- 错误结构化 ---------------- */

test('error: 沙箱内 throw 返回结构化 status/error，且保留兼容字段', async () => {
  const out = await runInSandbox({
    code: `async () => { throw new Error('boom'); }`,
    tools: [], callTool: NO_CALL,
  });
  assert.equal(out.isError, true, 'legacy isError kept');
  assert.match(out.result, /^execute error: /, 'legacy result string kept');
  assert.equal(out.status, 'error');
  assert.deepEqual(out.error, { message: 'boom', type: 'Error' });
  assert.ok(Array.isArray(out.logs), 'structured error still carries logs');
  assert.ok(Array.isArray(out.toolCalls), 'structured error still carries toolCalls');

  // server.js serializes the handler result exactly once with JSON.stringify().
  const wire = JSON.parse(JSON.stringify(out));
  assert.equal(wire.status, 'error');
  assert.equal(wire.isError, true);
  assert.deepEqual(wire.error, { message: 'boom', type: 'Error' });
});

test('error: 非 Error 类型抛出也有结构化 message/type', async () => {
  const out = await runInSandbox({
    code: `async () => { throw 'plain-string'; }`,
    tools: [], callTool: NO_CALL,
  });
  assert.equal(out.status, 'error');
  assert.deepEqual(out.error, { message: 'plain-string', type: 'UnknownError' });
  assert.equal(out.result, 'execute error: plain-string');
});

test('error: 上游 isError 转成结构化错误，审计链与日志不丢', async () => {
  const out = await runInSandbox({
    code: `async () => { console.log('before'); await codemode.fake__x({}); return 1; }`,
    tools: [{ name: 'fake__x', server: 'fake', tool: 'x', description: 'x' }],
    callTool: async () => ({ content: [{ type: 'text', text: 'upstream failed' }], isError: true }),
  });
  assert.equal(out.status, 'error');
  assert.match(out.error.message, /upstream failed/);
  assert.equal(out.toolCalls.length, 1);
  assert.ok(out.logs.some((l) => l.includes('before')));
  assert.ok(JSON.stringify(out.logs).length <= 4000);
});

test('error: execute handler 把结构化错误字段透传到 wire', async () => {
  const execute = createCodeModeTools({
    getEntries: () => [],
    callTool: NO_CALL,
  }).find((t) => t.name === 'execute');
  const out = await execute.handler({ code: `async () => { throw new Error('boom'); }` });
  const wire = JSON.parse(JSON.stringify(out));
  assert.equal(wire.status, 'error');
  assert.deepEqual(wire.error, { message: 'boom', type: 'Error' });
  assert.equal(wire.isError, true);
});

test('error: 调用预算耗尽也是结构化错误', async () => {
  const out = await runInSandbox({
    code: `async () => { for (let i=0;i<5;i++) await codemode.t({}); return 'x'; }`,
    tools: [{ name: 't', server: 'f', tool: 't', description: 't' }],
    callTool: NO_CALL,
    maxCalls: 2,
  });
  assert.equal(out.isError, true);
  assert.match(out.result, /tool call limit/);
  assert.equal(out.status, 'error');
  assert.match(out.error.message, /tool call limit/);
  assert.equal(out.error.type, 'Error');
});
