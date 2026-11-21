import test from 'node:test';
import assert from 'node:assert/strict';
import { createCodeModeTools, runInSandbox } from '../src/codemode.js';
import { sanitizeToolName } from '../src/codemode-util.js';

/**
 * Regression suite for the three Gemini real-call feedback items:
 *   1. first-turn "Connected services: ..." in tool descriptions
 *   2. search hits carry `callName`; sandbox accepts original AND sanitized names
 *   3. return-shape guidance + a safeAll() batch helper that keeps successes
 */

const emptyCall = () => ({ content: [{ type: 'text', text: '{"ok":true}' }] });

// ---------------------------------------------------------------------------
// 1. Dynamic, deduplicated, stably sorted service list
// ---------------------------------------------------------------------------

test('feedback#1: search/execute descriptions list connected services (deduped + sorted)', () => {
  const entries = [
    { server: 'github', tool: 'get_me', name: 'github__get_me' },
    { server: 'notion', tool: 'notion-search', name: 'notion__notion-search' },
    { server: 'linear', tool: 'list_issues', name: 'linear__list_issues' },
    { server: 'github', tool: 'search_code', name: 'github__search_code' }, // dup server
    { server: 'vercel', tool: 'list_projects', name: 'vercel__list_projects' },
    { server: 'notion', tool: 'notion-fetch', name: 'notion__notion-fetch' }, // dup server
  ];
  const mgr = { getEntries: () => entries, callTool: emptyCall };
  const [search, execRead, exec] = createCodeModeTools(mgr);

  for (const tool of [search, execRead, exec]) {
    assert.match(tool.description, /Connected services:/, `${tool.name} description`);
    assert.match(tool.description, /Connected services: github, linear, notion, vercel\.?/, `${tool.name} services`);
    // each service name must appear exactly once in the suffix
    const suffix = tool.description.split('Connected services:')[1].split('.')[0];
    for (const svc of ['github', 'linear', 'notion', 'vercel']) {
      assert.equal(suffix.split(svc).length - 1, 1, `${tool.name}: ${svc} deduped`);
    }
  }
});

test('feedback#1: no connected services -> no suffix (no dangling label)', () => {
  const [search] = createCodeModeTools({ getEntries: () => [], callTool: emptyCall });
  assert.doesNotMatch(search.description, /Connected services:/);
});

// ---------------------------------------------------------------------------
// 2. callName field + dual-name sandbox aliases
// ---------------------------------------------------------------------------

const HYPHEN_TOOL = {
  server: 'notion',
  tool: 'notion-create-pages',
  name: 'notion__notion-create-pages',
  description: 'Create a Notion page',
  inputSchema: { type: 'object', properties: {}, required: [] },
};

test('feedback#2: outer search and select: results carry callName', async () => {
  const mgr = { getEntries: () => [HYPHEN_TOOL], callTool: emptyCall };
  const [searchTool] = createCodeModeTools(mgr);
  const expected = sanitizeToolName(HYPHEN_TOOL.name); // notion__notion_create_pages

  const hits = await searchTool.handler({ query: 'create pages' });
  assert.equal(hits.matches.length, 1);
  assert.equal(hits.matches[0].name, HYPHEN_TOOL.name);
  assert.equal(hits.matches[0].callName, expected);

  const detail = await searchTool.handler({ query: 'select:notion__notion-create-pages' });
  assert.equal(detail.matches.length, 1);
  assert.equal(detail.matches[0].callName, expected);
  assert.ok(detail.matches[0].inputSchema, 'select keeps full schema');

  assert.match(searchTool.description, /callName/, 'description explains callName');
});

test('feedback#2: in-sandbox codemode.search also returns callName', async () => {
  const out = await runInSandbox({
    code: `async () => { const r = codemode.search('create pages'); return r.matches.map((m) => m.callName); }`,
    tools: [HYPHEN_TOOL],
    callTool: emptyCall,
  });
  assert.equal(out.isError, undefined);
  assert.deepEqual(JSON.parse(out.result), [sanitizeToolName(HYPHEN_TOOL.name)]);
});

test('feedback#2: sandbox accepts BOTH hyphenated name and sanitized name', async () => {
  const out = await runInSandbox({
    code: `async () => {
      const viaHyphen = await codemode['notion__notion-create-pages']({ marker: 'h' });
      const viaUnder  = await codemode['notion__notion_create_pages']({ marker: 'u' });
      return { viaHyphen, viaUnder };
    }`,
    tools: [HYPHEN_TOOL],
    callTool: async (_server, _tool, args) => ({
      content: [{ type: 'text', text: JSON.stringify({ ok: args.marker }) }],
    }),
  });
  assert.equal(out.isError, undefined, out.result);
  const data = JSON.parse(out.result);
  assert.equal(data.viaHyphen.ok, 'h');
  assert.equal(data.viaUnder.ok, 'u');
  assert.equal(out.toolCalls.length, 2);
  assert.ok(out.toolCalls.every((c) => c.name === HYPHEN_TOOL.name));
});

// ---------------------------------------------------------------------------
// 3. Return-shape guidance + safeAll partial-failure isolation
// ---------------------------------------------------------------------------

test('feedback#3: execute descriptions carry return-shape + safeAll guidance', () => {
  const [, execRead, exec] = createCodeModeTools({ getEntries: () => [], callTool: emptyCall });
  for (const tool of [execRead, exec]) {
    assert.match(tool.description, /Array\.isArray/, `${tool.name} mentions defensive guards`);
    assert.match(tool.description, /safeAll\(tasks\)/, `${tool.name} mentions safeAll`);
  }
});

test('feedback#3: safeAll keeps successful slots when a sub-task fails', async () => {
  const tools = [
    { name: 'good_tool', server: 'demo', tool: 'good_tool', description: 'g', inputSchema: {} },
    { name: 'bad_tool', server: 'demo', tool: 'bad_tool', description: 'b', inputSchema: {} },
  ];
  const out = await runInSandbox({
    code: `async () => {
      const r = await safeAll([
        () => codemode.good_tool({}),
        () => codemode.bad_tool({}),
        () => Promise.resolve('plain'),
        () => { throw new Error('sync boom'); },
      ]);
      return { r, safeOnCodemode: typeof codemode.safeAll === 'function' };
    }`,
    tools,
    callTool: async (_server, tool) => (tool === 'bad_tool'
      ? { isError: true, content: [{ type: 'text', text: 'upstream boom' }] }
      : { content: [{ type: 'text', text: JSON.stringify({ value: 'ok' }) }] }),
  });
  assert.equal(out.isError, undefined, out.result);
  const data = JSON.parse(out.result);
  assert.equal(data.safeOnCodemode, true);

  const [good, bad, plain, sync] = data.r;
  assert.equal(good.ok, true);
  assert.equal(good.value.value, 'ok');
  assert.equal(bad.ok, false);
  assert.match(bad.value, /upstream boom/);
  assert.equal(plain.ok, true);
  assert.equal(plain.value, 'plain');
  assert.equal(sync.ok, false);
  assert.match(sync.value, /sync boom/);
});

test('feedback#3: safeAll accepts already-started promises and preserves order', async () => {
  const out = await runInSandbox({
    code: `async () => {
      const slow = new Promise((resolve) => setTimeout(() => resolve('slow'), 0));
      const r = await safeAll([Promise.resolve('fast'), slow, Promise.reject(new Error('nope'))]);
      return r.map((x) => x.ok ? x.value : 'ERR:' + x.value);
    }`,
    tools: [],
    callTool: emptyCall,
  });
  assert.equal(out.isError, undefined, out.result);
  assert.deepEqual(JSON.parse(out.result), ['fast', 'slow', 'ERR:nope']);
});
