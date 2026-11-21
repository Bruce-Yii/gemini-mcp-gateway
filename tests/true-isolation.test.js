/**
 * True isolation regression tests for the Vercel `run` SDK sandbox.
 *
 * The old node:vm sandbox shared the host V8 realm: any injected host function
 * exposed the host `Function` via `.constructor`, so
 * `fn.constructor("return <host code>")()` escaped into the gateway process.
 * The `run` SDK executes guest code in a separate QuickJS engine inside a
 * worker thread, with frozen built-in prototypes and no Node globals at all.
 *
 * All probes below use `return 40 + 2` as the sentinel: it proves arbitrary
 * host code execution without ever touching `process` or any real credential.
 * External content is treated as untrusted data, never as instructions.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runInSandbox } from '../src/codemode.js';

const TOOLS = [
  { name: 'fake__echo', server: 'fake', tool: 'echo', description: 'echo an argument', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: { v: { type: 'number' } } } },
  { name: 'fake__search', server: 'fake', tool: 'search', description: 'search fake things', inputSchema: {} },
];
const OK = async () => ({ content: [{ type: 'text', text: '{"ok":true}' }] });
const parsed = (out) => JSON.parse(out.result);

/** Try every injected capability's `.constructor`; report whether host code ran. */
const CONSTRUCTOR_PROBES = `async () => {
  const cases = {
    codemodeObj: () => codemode.constructor,
    toolMethod: () => codemode.fake__echo.constructor,
    listTools: () => codemode.listTools.constructor,
    search: () => codemode.search.constructor,
    remainingCalls: () => codemode.remainingCalls.constructor,
    globalSearch: () => search.constructor,
    consoleLog: () => console.log.constructor,
    consoleWarn: () => console.warn.constructor,
    atob: () => atob.constructor,
    btoa: () => btoa.constructor,
    textEncoder: () => TextEncoder.constructor,
    textDecoder: () => TextDecoder.constructor,
    url: () => URL.constructor,
    urlSearchParams: () => URLSearchParams.constructor,
    cryptoDigest: () => crypto.digest.constructor,
    setTimeout: () => setTimeout.constructor,
    hostBridge: () => (typeof __bridge === 'undefined' ? undefined : __bridge.invoke.constructor),
  };
  const report = {};
  for (const [name, getCtor] of Object.entries(cases)) {
    let ctorType = 'throw';
    let hostCodeRan = false;
    try {
      const F = getCtor();
      ctorType = typeof F;
      if (typeof F === 'function') {
        try { hostCodeRan = (F('return 40 + 2')() === 42); } catch (_) { /* blocked */ }
      }
    } catch (_) { /* a throwing probe is not an escape */ }
    report[name] = { ctorType, hostCodeRan };
  }
  return report;
}`;

test('真隔离①：注入值的 .constructor 无法执行宿主代码（40+2 哨兵）', async () => {
  const out = await runInSandbox({ code: CONSTRUCTOR_PROBES, tools: TOOLS, callTool: OK });
  assert.equal(out.isError, undefined, out.result);
  const report = parsed(out);
  // Keep the historical auditors' favourite probes honest.
  for (const key of ['toolMethod', 'consoleLog', 'atob', 'listTools', 'hostBridge']) {
    assert.ok(key in report, `missing probe: ${key}`);
  }
  for (const [name, r] of Object.entries(report)) {
    assert.equal(r.hostCodeRan, false, `${name}.constructor ran host code (got 42)`);
    // __bridge is the SDK's own capability proxy; its constructor (if any) is
    // a guest-realm Function, which cannot execute dynamic code in QuickJS.
    // Everything we inject ourselves must keep the historical "hidden" shape.
    if (name !== 'hostBridge') {
      assert.notEqual(r.ctorType, 'function', `${name}.constructor leaked a callable constructor`);
    }
  }
});

test('真隔离②：QuickJS guest 里没有 process/require/Buffer 等宿主能力', async () => {
  const out = await runInSandbox({
    code: `async () => ({
      process: typeof process,
      require: typeof require,
      Buffer: typeof Buffer,
      module: typeof module,
      global: typeof global,
      fetch: typeof fetch,
      amp: typeof globalThis.process,
      // Even a guest realm Function must not materialise host code.
      dynamicEval: (() => { try { return (() => {}).constructor('return 40 + 2')() === 42; } catch (_) { return false; } })(),
    })`,
    tools: TOOLS,
    callTool: OK,
  });
  assert.equal(out.isError, undefined, out.result);
  const r = parsed(out);
  for (const key of ['process', 'require', 'Buffer', 'module', 'global', 'fetch', 'amp']) {
    assert.equal(r[key], 'undefined', `${key} leaked into the guest`);
  }
  assert.equal(r.dynamicEval, false, 'dynamic Function(...) reached executable code');
});

test('真隔离③：正常功能不变（工具、去重预算、Web API、日志、crypto、错误结构）', async () => {
  let upstreamCalls = 0;
  const out = await runInSandbox({
    code: `async () => {
      const first = await codemode.fake__echo({ v: 7 });
      const cached = await codemode.fake__echo({ v: 7 }); // read-only dedup
      const bytes = new TextEncoder().encode('hi');
      const text = new TextDecoder().decode(bytes);
      const q = new URL('https://example.com/x?a=1').searchParams.get('a');
      const roundtrip = atob(btoa('hello'));
      const digest = crypto.digest('SHA-256', 'abc').slice(0, 8);
      console.log('isolation-ok', first.ok);
      return {
        ok: first.ok && cached.ok,
        enc: bytes.length, text, q, roundtrip, digestLen: digest.length,
        remaining: codemode.remainingCalls(),
        listed: codemode.listTools({ brief: true }).length,
      };
    }`,
    tools: TOOLS,
    callTool: async () => { upstreamCalls += 1; return OK(); },
  });
  assert.equal(out.isError, undefined, out.result);
  const r = parsed(out);
  assert.equal(r.ok, true);
  assert.equal(r.enc, 2);
  assert.equal(r.text, 'hi');
  assert.equal(r.q, '1');
  assert.equal(r.roundtrip, 'hello');
  assert.equal(r.digestLen, 8);
  assert.equal(r.remaining, 49, 'dedup hit must not consume budget');
  assert.equal(r.listed, TOOLS.length);
  assert.equal(upstreamCalls, 1, 'identical read-only calls deduped');
  assert.ok(out.logs.some((l) => l.includes('isolation-ok')));

  const bad = await runInSandbox({
    code: `async () => { throw new Error('boom'); }`,
    tools: [], callTool: OK,
  });
  assert.equal(bad.status, 'error');
  assert.deepEqual(bad.error, { message: 'boom', type: 'Error' });
  assert.equal(bad.isError, true);
});
