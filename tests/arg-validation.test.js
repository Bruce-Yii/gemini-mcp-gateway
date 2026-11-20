/**
 * Gemini suggestion 2: 沙箱内 `codemode.<tool>(args)` 的入参轻量校验。
 *
 * 只覆盖两层：required 缺失 + 顶层基础类型不符。enum / format / items /
 * 嵌套结构 / schema 未声明的字段一律交给上游，避免重复校验与误伤。
 * 这里全部走 runInSandbox，验证的是模型真正看到的报错与上游调用行为。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runInSandbox, validateToolArgs } from '../src/codemode.js';

const TOOL = {
  name: 'linear__list_issues',
  server: 'linear',
  tool: 'list_issues',
  description: 'list issues',
  inputSchema: {
    type: 'object',
    properties: {
      teamId: { type: 'string' },
      limit: { type: 'number' },
      flag: { type: 'boolean' },
      tags: { type: 'array', items: { type: 'string' } },
      filter: { type: 'object' },
      state: { type: 'string', enum: ['open', 'closed'] },
    },
    required: ['teamId'],
  },
};

/** Run sandbox code, recording every upstream call. */
function call(code, { tools = [TOOL], calls = [], maxCalls } = {}) {
  const opts = {
    code,
    tools,
    callTool: async (server, tool, args) => {
      calls.push({ server, tool, args });
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
    },
  };
  if (maxCalls !== undefined) opts.maxCalls = maxCalls;
  return { promise: runInSandbox(opts), calls };
}

/** cross-realm 对象（vm 里造的 args）先过一圈 JSON 再做深度比较。 */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

/* ---------------- 1. 缺必填字段 ---------------- */

test('缺必填字段：精准报错 tool X requires fields: a，且上游未被调用', async () => {
  const { promise, calls } = call(
    `async () => { return await codemode.linear__list_issues({ limit: 2 }); }`,
  );
  const out = await promise;
  assert.equal(out.isError, true);
  assert.match(out.result, /tool linear__list_issues requires fields: teamId/);
  assert.match(out.result, /requires fields: teamId$/); // 不夹带其它噪音字段
  assert.equal(calls.length, 0, 'invalid args must be rejected before any upstream call');
});

test('多个必填字段一次性列全，顺序同 schema.required', async () => {
  const tool = {
    ...TOOL,
    inputSchema: { ...TOOL.inputSchema, required: ['teamId', 'filter', 'limit'] },
  };
  const out = await call(
    `async () => { return await codemode.linear__list_issues({ flag: true }); }`,
    { tools: [tool] },
  ).promise;
  assert.match(out.result, /tool linear__list_issues requires fields: teamId, filter, limit/);
});

/* ---------------- 2. 基础类型不符 ---------------- */

test('类型不符：expected number, got string', async () => {
  const { promise, calls } = call(
    `async () => { return await codemode.linear__list_issues({ teamId: 'T', limit: '2' }); }`,
  );
  const out = await promise;
  assert.equal(out.isError, true);
  assert.match(out.result, /tool linear__list_issues field 'limit' expected number, got string/);
  assert.equal(calls.length, 0);
});

test('string / boolean / array / object 四类顶层类型都按同样规则报错', async () => {
  const cases = [
    [`{ teamId: 42 }`, `field 'teamId' expected string, got number`],
    [`{ teamId: 'T', flag: 'yes' }`, `field 'flag' expected boolean, got string`],
    [`{ teamId: 'T', tags: 'a,b' }`, `field 'tags' expected array, got string`],
    [`{ teamId: 'T', filter: [] }`, `field 'filter' expected object, got array`],
    [`{ teamId: 'T', filter: null }`, `field 'filter' expected object, got null`],
  ];
  for (const [argLiteral, expected] of cases) {
    const out = await call(
      `async () => { return await codemode.linear__list_issues(${argLiteral}); }`,
    ).promise;
    assert.equal(out.isError, true, `${argLiteral} should fail`);
    assert.match(out.result, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('校验失败不消耗调用预算、也不写 toolCalls 审计', async () => {
  const { promise, calls } = call(
    `async () => {
       let first = '';
       try { await codemode.linear__list_issues({}); } catch (e) { first = e.message; }
       const r = await codemode.linear__list_issues({ teamId: 'T' });
       return { first, ok: r.ok };
     }`,
    { maxCalls: 1 },
  );
  const out = await promise;
  assert.equal(out.isError, undefined, `budget was eaten by the rejected call: ${out.result}`);
  const r = JSON.parse(out.result);
  assert.match(r.first, /tool linear__list_issues requires fields: teamId/);
  assert.equal(r.ok, true, 'the one allowed upstream call must still be available');
  assert.equal(calls.length, 1, 'only the valid call reached upstream');
  assert.equal(out.toolCalls.length, 1, 'rejected call must not enter the audit trail');
});

/* ---------------- 3. 合法参数正常调用上游 ---------------- */

test('合法参数：正常调用上游，参数原样透传，返回值进沙箱', async () => {
  const { promise, calls } = call(
    `async () => {
       const r = await codemode.linear__list_issues({
         teamId: 'T', limit: 2, flag: true, tags: ['a'], filter: { x: 1 }
       });
       return r.ok;
     }`,
  );
  const out = await promise;
  assert.equal(out.isError, undefined);
  assert.equal(out.result, 'true');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].server, 'linear');
  assert.equal(calls[0].tool, 'list_issues');
  assert.deepEqual(plain(calls[0].args), {
    teamId: 'T', limit: 2, flag: true, tags: ['a'], filter: { x: 1 },
  });
});

/* ---------------- 4. 不拦、不深挖、不重复上游校验 ---------------- */

test('schema 未声明的额外字段不拦，原样透传上游', async () => {
  const { promise, calls } = call(
    `async () => { return await codemode.linear__list_issues({ teamId: 'T', surprise: { deep: 1 } }); }`,
  );
  const out = await promise;
  assert.equal(out.isError, undefined, `unexpected: ${out.result}`);
  assert.equal(calls.length, 1);
  assert.equal(plain(calls[0].args).surprise.deep, 1);
});

test('只做两层：enum 范围、数组 items、嵌套对象都不深挖', async () => {
  const { promise, calls } = call(
    `async () => {
       return await codemode.linear__list_issues({
         teamId: 'T', state: 'not-in-enum', tags: [123], filter: { nested: 'deep' }
       });
     }`,
  );
  const out = await promise;
  assert.equal(out.isError, undefined, `unexpected: ${out.result}`);
  assert.equal(calls.length, 1, 'upstream stays authoritative for these checks');
});

test('integer 当作 number 校验，但不检查整数性（交给上游）', async () => {
  const tool = {
    ...TOOL,
    inputSchema: {
      type: 'object',
      properties: { count: { type: 'integer' } },
      required: ['count'],
    },
  };
  const { promise, calls } = call(
    `async () => { return await codemode.linear__list_issues({ count: 1.5 }); }`,
    { tools: [tool] },
  );
  const out = await promise;
  assert.equal(out.isError, undefined, `unexpected: ${out.result}`);
  assert.equal(calls.length, 1);

  const bad = await call(
    `async () => { return await codemode.linear__list_issues({ count: '1' }); }`,
    { tools: [tool] },
  ).promise;
  assert.match(bad.result, /field 'count' expected number, got string/);
});

test('多类型 / 无 type 的字段跳过类型检查，交给上游', async () => {
  const tool = {
    ...TOOL,
    inputSchema: {
      type: 'object',
      properties: { maybe: { type: ['string', 'null'] }, anything: { description: 'no type' } },
      required: [],
    },
  };
  const out = await call(
    `async () => { return await codemode.linear__list_issues({ maybe: 42, anything: [] }); }`,
    { tools: [tool] },
  ).promise;
  assert.equal(out.isError, undefined, `unexpected: ${out.result}`);
});

test('无 inputSchema / 非对象 inputSchema 的工具不误伤', async () => {
  for (const schema of [undefined, null, [1, 2], 'oops']) {
    const tool = { name: 'x', server: 'f', tool: 'x', description: 'x', inputSchema: schema };
    const out = await call(`async () => { return (await codemode.x({ anything: 1 })).ok; }`, { tools: [tool] }).promise;
    assert.equal(out.isError, undefined, `schema=${JSON.stringify(schema)} should not be validated`);
    assert.equal(out.result, 'true');
  }
});

/* ---------------- 5. discovery helper 不走校验 ---------------- */

test('listTools / search / remainingCalls 不受入参校验影响', async () => {
  const out = await call(`async () => {
    const listed = codemode.listTools({ service: 'linear' });
    const found = codemode.search('list issues');
    const left = codemode.remainingCalls();
    return { listed: listed.length, found: found.length, left };
  }`).promise;
  assert.equal(out.isError, undefined, `unexpected: ${out.result}`);
  const r = plain(JSON.parse(out.result));
  assert.equal(r.listed, 1);
  assert.ok(r.found >= 1);
  assert.equal(r.left, 50);
});

/* ---------------- 6. 纯函数边界（直接调用导出的 helper） ---------------- */

test('validateToolArgs 只抛精准错误，合法/空参数不抛', () => {
  assert.throws(() => validateToolArgs(TOOL, {}), /tool linear__list_issues requires fields: teamId/);
  assert.throws(
    () => validateToolArgs(TOOL, { teamId: 'T', limit: '2' }),
    /tool linear__list_issues field 'limit' expected number, got string/,
  );
  assert.doesNotThrow(() => validateToolArgs(TOOL, { teamId: 'T' }));
  // 没有必填字段的工具：null / 原始值 / 任意额外字段都不该被拦。
  const noRequired = { name: 'x', inputSchema: { type: 'object', properties: {} } };
  assert.doesNotThrow(() => validateToolArgs(noRequired, null));
  assert.doesNotThrow(() => validateToolArgs(noRequired, 'primitive arg'));
  assert.doesNotThrow(() => validateToolArgs(noRequired, { anything: 1 }));
  // 原型链上的同名属性不算"填了"（避免 __proto__/toString 之类误判）。
  assert.throws(() => validateToolArgs(TOOL, Object.create({ teamId: 'inherited' })), /requires fields: teamId/);
});
