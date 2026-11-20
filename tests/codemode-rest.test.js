/**
 * codemode-rest: 剩余未修/半修项的回归测试
 *   #41 summarizeArgs 循环数组爆栈
 *   #47 注入宿主函数的 .constructor 逃逸止血
 *   #59 逃逸路径 + 正常功能回归
 *   #42 codemode.search 内外形状一致
 *   #12 脚本错误附行号
 *   #46（可选）整轮墙钟超时
 *
 * 全部本地运行：vm + 假上游，不联网、不调模型、不读真实凭据。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runInSandbox } from '../src/codemode.js';

const NO_CALL = async () => ({});
const OK = async () => ({ content: [{ type: 'text', text: '{}' }] });
const TOOLS = [
  { name: 'fake__echo', server: 'fake', tool: 'echo', description: 'echo an argument', inputSchema: {} },
  { name: 'fake__search', server: 'fake', tool: 'search', description: 'search fake things', inputSchema: {} },
];

const parsed = (out) => JSON.parse(out.result);

/* ---------------- #41：循环 / 超深参数不再爆栈 ---------------- */

test('#41: 顶层自引用数组不再 Maximum call stack size exceeded', async () => {
  const out = await runInSandbox({
    code: `async () => {
      const a = [1];
      a.push(a);
      await codemode.fake__echo(a);
      return 'survived';
    }`,
    tools: TOOLS,
    callTool: OK,
  });
  assert.equal(out.isError, undefined, `unexpected error: ${out.result}`);
  assert.equal(out.result, 'survived');
  assert.equal(out.toolCalls.length, 1);
  const summarized = out.toolCalls[0].args;
  assert.equal(summarized.__array, 2);
  // sample 是 vm realm 的数组，deepStrictEqual 会因 prototype 不同而拒绝，
  // 因此逐项断言（同时验证占位符确实替代了自引用）。
  assert.equal(summarized.sample.length, 2);
  assert.equal(summarized.sample[0], 1);
  assert.equal(summarized.sample[1], '[Circular]');
  assert.ok(Number.isFinite(JSON.stringify(out).length));
});

test('#41: 两个数组互指也不会无限递归', async () => {
  const out = await runInSandbox({
    code: `async () => {
      const a = ['a'];
      const b = ['b', a];
      a.push(b);
      await codemode.fake__echo(a);
      return 'mutual-ok';
    }`,
    tools: TOOLS,
    callTool: OK,
  });
  assert.equal(out.result, 'mutual-ok', out.result);
  assert.ok(JSON.stringify(out.toolCalls[0].args).includes('[Circular]'));
});

test('#41: 超深嵌套数组被限深并给出占位符', async () => {
  const out = await runInSandbox({
    code: `async () => {
      let deep = [1];
      for (let i = 0; i < 20; i++) deep = [deep];
      await codemode.fake__echo(deep);
      return 'deep-ok';
    }`,
    tools: TOOLS,
    callTool: OK,
  });
  assert.equal(out.result, 'deep-ok', out.result);
  assert.ok(JSON.stringify(out.toolCalls[0].args).includes('[Deeply nested]'));
});

/* ---------------- #47 / #59：constructor 逃逸止血 ---------------- */

// 每个探针先读 .constructor；若拿到函数，再用宿主代码执行 `40 + 2` 判断是否
// 真的逃到了宿主 realm。用 42 而不是 process 作哨兵：即使修复失效也不会真的
// 把 process 交出去，只证明"任意宿主代码可执行"这一事实。
const ESCAPE_CODE = `async () => {
  const cases = {
    TextEncoder: () => TextEncoder.constructor,
    TextDecoder: () => TextDecoder.constructor,
    URL: () => URL.constructor,
    URLSearchParams: () => URLSearchParams.constructor,
    atob: () => atob.constructor,
    btoa: () => btoa.constructor,
    consoleLog: () => console.log.constructor,
    consoleWarn: () => console.warn.constructor,
    setTimeout: () => setTimeout.constructor,
    cryptoDigest: () => crypto.digest.constructor,
    listTools: () => codemode.listTools.constructor,
    search: () => codemode.search.constructor,
    remainingCalls: () => codemode.remainingCalls.constructor,
    toolMethod: () => codemode.fake__echo.constructor,
    globalSearch: () => search.constructor,
    codemodeObj: () => codemode.constructor,
    consoleObj: () => console.constructor,
    cryptoObj: () => crypto.constructor,
  };
  const report = {};
  for (const [name, getCtor] of Object.entries(cases)) {
    let ctorType = 'throw';
    let hostCodeRan = false;
    try {
      const F = getCtor();
      ctorType = typeof F;
      if (typeof F === 'function') {
        try { hostCodeRan = (F('return 40 + 2')() === 42); } catch (e) { hostCodeRan = false; }
      }
    } catch (e) { /* 记为 throw，仍视为不可逃逸 */ }
    report[name] = { ctorType, hostCodeRan };
  }
  return report;
}`;

test('#47/#59: TextEncoder/console.log/atob/codemode.listTools 等 constructor 不再通向宿主', async () => {
  const out = await runInSandbox({ code: ESCAPE_CODE, tools: TOOLS, callTool: OK });
  assert.equal(out.isError, undefined, out.result);
  const report = parsed(out);
  for (const key of ['TextEncoder', 'consoleLog', 'atob', 'listTools']) {
    assert.ok(key in report, `缺少审计点名的探针：${key}`);
  }
  for (const [name, r] of Object.entries(report)) {
    assert.equal(r.ctorType, 'undefined', `${name}.constructor 应被隐藏，实际 ${r.ctorType}`);
    assert.equal(r.hostCodeRan, false, `${name} 仍能执行宿主代码`);
  }
});

test('#59: 止血不破坏正常功能（Web API / 日志 / crypto / codemode.*）', async () => {
  const out = await runInSandbox({
    code: `async () => {
      const bytes = new TextEncoder().encode('hi');
      const text = new TextDecoder().decode(bytes);
      const q = new URL('https://example.com/x?a=1').searchParams.get('a');
      const rt = atob(btoa('hello'));
      console.log('log-marker', 7);
      const digest = crypto.digest('SHA-256', 'abc').slice(0, 8);
      const listed = codemode.listTools({ brief: true });
      const echoed = await codemode.fake__echo({ v: 1 });
      const left = codemode.remainingCalls();
      return {
        enc: bytes.length, text, q, rt, digestLen: digest.length,
        listed: listed.length, left, echoedOk: echoed.ok,
      };
    }`,
    tools: TOOLS,
    callTool: async () => ({ content: [{ type: 'text', text: '{"ok":true}' }] }),
  });
  assert.equal(out.isError, undefined, out.result);
  const r = parsed(out);
  assert.equal(r.enc, 2);
  assert.equal(r.text, 'hi');
  assert.equal(r.q, '1');
  assert.equal(r.rt, 'hello');
  assert.equal(r.digestLen, 8);
  assert.equal(r.listed, TOOLS.length);
  assert.equal(r.left, 49, '调用一次后剩余预算应减一');
  assert.equal(r.echoedOk, true);
  assert.ok(out.logs.some((l) => l.includes('log-marker')), 'console.log 仍被捕获');
});

/* ---------------- #42：search 形状一致 ---------------- */

test('#42: 沙箱内 search 同时提供 {matches,total,hint} 且保留数组兼容', async () => {
  const out = await runInSandbox({
    code: `async () => {
      const a = codemode.search('fake');
      const b = search('fake');
      return {
        isArray: Array.isArray(a),
        len: a.length,
        hasMatches: Array.isArray(a.matches),
        names: a.matches.map((m) => m.name),
        total: a.total,
        sameShape: b.total === a.total && b.hint === a.hint && b.matches.length === a.matches.length,
        namedKeys: Object.keys(a).filter((k) => isNaN(Number(k))).sort(),
      };
    }`,
    tools: TOOLS,
    callTool: OK,
  });
  assert.equal(out.isError, undefined, out.result);
  const r = parsed(out);
  assert.equal(r.isArray, true, '兼容旧脚本的 Array.isArray()');
  assert.ok(r.len >= 1, '兼容旧脚本的 .length');
  assert.equal(r.hasMatches, true);
  assert.ok(r.names.length >= 1 && r.names.every((n) => n.startsWith('fake__')), JSON.stringify(r.names));
  assert.equal(r.total, TOOLS.length);
  assert.equal(r.sameShape, true, 'codemode.search 与全局 search 形状一致');
  assert.deepEqual(r.namedKeys, ['hint', 'matches', 'total']);
});

/* ---------------- #12：脚本错误行号 ---------------- */

test('#12: 沙箱脚本抛错带脚本行号，错误对象旧形状不变', async () => {
  const code = [
    'async () => {',
    '  const x = 1;',
    '  if (x) {',
    "    throw new Error('line probe');",
    '  }',
    '}',
  ].join('\n');
  const out = await runInSandbox({ code, tools: [], callTool: NO_CALL });
  assert.equal(out.status, 'error');
  assert.equal(out.error.line, 4, JSON.stringify(out.error));
  assert.equal(typeof out.error.column, 'number');
  assert.match(out.result, /script line 4:\d+/);
  // line/column 是非枚举属性：旧调用方与 wire 上的 {message,type} 不变
  assert.deepEqual(out.error, { message: 'line probe', type: 'Error' });
  const wire = JSON.parse(JSON.stringify(out));
  assert.deepEqual(wire.error, { message: 'line probe', type: 'Error' });
  assert.match(wire.result, /script line 4/);
});

test('#12: host 侧抛错（工具预算）不被误标脚本行号', async () => {
  const out = await runInSandbox({
    code: `async () => { await codemode.t({}); return 'x'; }`,
    tools: [{ name: 't', server: 'f', tool: 't', description: 't', inputSchema: {} }],
    callTool: NO_CALL,
    maxCalls: 0,
  });
  assert.equal(out.status, 'error');
  assert.match(out.result, /tool call limit \(0\) exceeded$/);
  assert.equal(out.error.line, undefined);
  assert.ok(!out.result.includes('script line'));
});

/* ---------------- #46：整轮墙钟超时（可选实现） ---------------- */

test('#46: host 侧 callTool 挂起时整轮超时并转成结构化错误', async () => {
  const out = await runInSandbox({
    code: `async () => { await codemode.fake__echo({}); return 'never'; }`,
    tools: TOOLS,
    callTool: () => new Promise(() => {}),
    timeout: 5000,
    totalTimeout: 60,
  });
  assert.equal(out.status, 'error');
  assert.equal(out.isError, true);
  assert.match(out.result, /execute overall timeout \(60ms\)/);
  assert.equal(out.error.type, 'Error');
});
