/**
 * B2 根因追溯残留补修回归测试
 *   RC-D4: 沙箱内 codemode.search 空结果兜底 + 与外层 handler 共用 searchWithFallback
 *   RC-D7: execute / execute_read 描述包含边界/拒绝引导
 *
 * 外部内容（工具描述、query 等）仅作不可信数据处理，这里全部使用本地固定夹具。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCodeModeTools, runInSandbox, searchWithFallback } from '../src/codemode.js';

const TOOLS = [
  { server: 'github', tool: 'get_me', name: 'github__get_me', description: 'get the authenticated user', inputSchema: { type: 'object', properties: {}, required: [] } },
  { server: 'github', tool: 'list_issues', name: 'github__list_issues', description: 'list issues in a repository', inputSchema: { type: 'object', properties: { repo: { type: 'string' } }, required: [] } },
  { server: 'notion', tool: 'search', name: 'notion__search', description: 'search notion pages', inputSchema: { type: 'object', properties: {}, required: [] } },
];
const NO_MATCH_QUERY = '+github zzzzqqqxxxxx'; // +server 前缀 + 完全不存在的词：整体必然零命中
const OK = async () => ({ content: [{ type: 'text', text: '{}' }] });
const mgr = {
  getEntries: () => TOOLS,
  getWhitelist: () => TOOLS,
  callTool: OK,
};

/** 在沙箱里跑一次 codemode.search，抽出与外层可比较的普通字段。 */
async function sandboxSearch(query) {
  const out = await runInSandbox({
    code: `async () => {
      const r = codemode.search(${JSON.stringify(query)});
      return { names: r.matches.map(m => m.name), total: r.total, hint: r.hint };
    }`,
    tools: TOOLS,
    callTool: OK,
  });
  assert.equal(out.isError, undefined, out.result);
  return JSON.parse(out.result);
}

test('RC-D4①: 沙箱内 codemode.search 对不可能匹配的 query 返回最接近工具而非空', async () => {
  // 没有兜底时：searchEntries(tools, QUERY) 命中 0 条 -> count === 0，本测试失败。
  const r = await sandboxSearch(NO_MATCH_QUERY);
  assert.ok(r.names.length > 0, `兜底应返回最接近工具，实际结果: ${JSON.stringify(r)}`);
  assert.ok(r.names.every((n) => n.startsWith('github__')), `应回退到 github 工具，实际: ${JSON.stringify(r.names)}`);
  assert.ok(r.hint && r.hint.includes('showing closest for "github"'), `应给出兜底 hint，实际: ${r.hint}`);
});

test('RC-D4②: searchWithFallback 为单一共享实现，外层 handler 与沙箱行为一致', async () => {
  assert.equal(typeof searchWithFallback, 'function', 'searchWithFallback 应作为共享函数导出');

  // 直接调用共享函数作为基线
  const direct = searchWithFallback(TOOLS, NO_MATCH_QUERY, 5);
  assert.ok(direct.res.matches.length > 0, '共享函数本身应含兜底');

  // 外层 MCP search handler
  const [searchTool] = createCodeModeTools(mgr);
  const outer = await searchTool.handler({ query: NO_MATCH_QUERY, limit: 5 });

  // 沙箱内 codemode.search（复用同一 query / 同一工具集）
  const sandbox = await sandboxSearch(NO_MATCH_QUERY);

  const outerNames = outer.matches.map((m) => m.name);
  assert.deepEqual(sandbox.names, outerNames, '沙箱与外层兜底命中的工具应完全一致');
  assert.equal(sandbox.total, outer.total, 'total 应一致');
  assert.equal(sandbox.hint, outer.hint, '兜底 hint 文案应一致');
  assert.deepEqual(outerNames, direct.res.matches.map((m) => m.name), '外层结果应与共享函数基线一致');
  assert.equal(outer.hint, direct.hint, '外层 hint 应与共享函数基线一致');
});

test('RC-D4①(补): select: 处理保持不变——不走兜底、返回完整 schema', async () => {
  const [searchTool] = createCodeModeTools(mgr);
  const exact = await searchTool.handler({ query: 'select:notion__search' });
  assert.equal(exact.matches.length, 1);
  assert.ok(exact.matches[0].inputSchema, 'select 应返回完整 inputSchema');
  assert.equal(exact.matches[0].params, undefined, 'select 不应返回精简 params');

  // select 一个不存在的名字不能被兜底成别的工具
  const missing = await searchTool.handler({ query: 'select:does_not_exist' });
  assert.equal(missing.matches.length, 0, 'select 不存在的名字不应触发兜底');
});

test('RC-D7③: execute 与 execute_read 描述包含边界/拒绝引导', () => {
  const [, executeRead, execute] = createCodeModeTools(mgr);
  for (const [name, tool] of [['execute', execute], ['execute_read', executeRead]]) {
    assert.equal(typeof tool.description, 'string', `${name} 应有描述`);
    assert.ok(tool.description.includes('explicitly state it cannot be done'),
      `${name} 应引导"明确说明不可完成"`);
    assert.ok(tool.description.includes('requires an external service'),
      `${name} 应引导"需要外部服务"`);
    assert.ok(tool.description.includes('insufficient'),
      `${name} 应引导"信息不足"`);
    assert.ok(tool.description.includes('refuse harmful requests'),
      `${name} 应引导"拒绝有害请求"`);
  }
});
