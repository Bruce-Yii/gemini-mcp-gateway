import test from 'node:test';
import assert from 'node:assert/strict';
import { createCodeModeTools, servicesSnapshot } from '../src/codemode.js';
import { sanitizeToolName } from '../src/codemode-util.js';

/**
 * New Gemini feedback (round 2) regression suite:
 *   1. list-mode search results carry a compact <=160-char description;
 *      select:<name> still returns the full upstream description verbatim.
 *   2. every search result carries an explicit `access: "read"|"write"` field,
 *      in both the outer search tool and the in-sandbox codemode.search.
 *   3. an in-sandbox codemode.services() helper aggregates local upstream
 *      state (no new MCP tool schema, no network call).
 */

const emptyCall = async () => ({ content: [{ type: 'text', text: '{"ok":true}' }] });
const noNetwork = () => { throw new Error('codemode.services() must not call the upstream'); };

const LONG_DESC =
  'Search pages and databases across the Notion workspace. ' +
  'This tool supports an exhaustive query language with filters, sorts, archiving semantics and ' +
  'many more rules that are documented at great length in the upstream specification. '.repeat(20);

const READ_ANNOTATED = {
  server: 'github', tool: 'get_me', name: 'github__get_me',
  description: 'Get the authenticated user.',
  inputSchema: { type: 'object', properties: {}, required: [] },
  annotations: { readOnlyHint: true },
};
const WRITE_TOOL = {
  server: 'github', tool: 'issue_write', name: 'github__issue_write',
  description: 'Create or update an issue in a repository.',
  inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
};
const READ_BY_NAME = {
  server: 'linear', tool: 'list_issues', name: 'linear__list_issues',
  description: 'List issues.',
  inputSchema: { type: 'object', properties: {}, required: [] },
};

// ---------------------------------------------------------------------------
// 1. Bounded description in list mode; full description in select mode
// ---------------------------------------------------------------------------

test('feedback2#1: list search description <=160 chars with … hint; params + callName kept', async () => {
  const entry = {
    server: 'notion', tool: 'notion-search', name: 'notion__notion-search',
    description: LONG_DESC,
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    annotations: { readOnlyHint: true },
  };
  const [search] = createCodeModeTools({ getEntries: () => [entry], callTool: emptyCall });
  const hits = await search.handler({ query: '' }); // empty query -> browse all

  assert.equal(hits.matches.length, 1);
  const hit = hits.matches[0];
  assert.ok(hit.description.length <= 160, `description length ${hit.description.length} > 160`);
  assert.ok(hit.description.length < entry.description.length, 'description was compacted');
  assert.ok(hit.description.endsWith('…'), 'ellipsis hints that select:<name> has the full text');
  assert.match(hit.description, /^Search pages and databases across the Notion workspace/, 'first sentence kept');
  assert.ok(Array.isArray(hit.params) && hit.params.some((p) => p.includes('query!: string')), 'params signature preserved');
  assert.equal(hit.callName, sanitizeToolName(entry.name), 'callName preserved');
});

test('feedback2#1: cap holds at exactly 160 when there is no sentence/newline boundary', async () => {
  const entry = {
    server: 'x', tool: 'tool', name: 'x__tool',
    description: 'z'.repeat(500), // no '.', no '\n'
    inputSchema: { type: 'object', properties: {}, required: [] },
  };
  const [search] = createCodeModeTools({ getEntries: () => [entry], callTool: emptyCall });
  const hit = (await search.handler({ query: '' })).matches[0];
  assert.equal(hit.description.length, 160);
  assert.ok(hit.description.endsWith('…'));
});

test('feedback2#1: first newline is a compact boundary', async () => {
  const entry = {
    server: 'x', tool: 'tool', name: 'x__tool',
    description: 'First line of the description\nSecond line with lots more detail.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  };
  const [search] = createCodeModeTools({ getEntries: () => [entry], callTool: emptyCall });
  const hit = (await search.handler({ query: '' })).matches[0];
  assert.equal(hit.description, 'First line of the description…');
});

test('feedback2#1: short descriptions are left untouched (no spurious ellipsis)', async () => {
  const [search] = createCodeModeTools({ getEntries: () => [READ_ANNOTATED], callTool: emptyCall });
  const hit = (await search.handler({ query: '' })).matches[0];
  assert.equal(hit.description, READ_ANNOTATED.description);
});

test('feedback2#1: select:<name> keeps the FULL description and schema (not compacted)', async () => {
  const entry = {
    server: 'notion', tool: 'notion-search', name: 'notion__notion-search',
    description: LONG_DESC,
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    annotations: { readOnlyHint: true },
  };
  const [search] = createCodeModeTools({ getEntries: () => [entry], callTool: emptyCall });
  const detail = (await search.handler({ query: 'select:notion__notion-search' })).matches[0];
  assert.equal(detail.description, LONG_DESC, 'full upstream description preserved');
  assert.ok(detail.inputSchema, 'full schema preserved');
  assert.equal(detail.callName, sanitizeToolName(entry.name));
});

// ---------------------------------------------------------------------------
// 2. Explicit read/write access on every result (outer + sandbox)
// ---------------------------------------------------------------------------

test('feedback2#2: outer search hits carry access read/write (annotation and name based)', async () => {
  const mgr = { getEntries: () => [READ_ANNOTATED, WRITE_TOOL, READ_BY_NAME], callTool: emptyCall };
  const [search] = createCodeModeTools(mgr);
  const byName = new Map((await search.handler({ query: '' })).matches.map((m) => [m.name, m]));
  assert.equal(byName.size, 3);
  assert.equal(byName.get('github__get_me').access, 'read', 'readOnlyHint annotation -> read');
  assert.equal(byName.get('linear__list_issues').access, 'read', 'list_ name hint -> read');
  assert.equal(byName.get('github__issue_write').access, 'write', 'write tool -> write');
});

test('feedback2#2: select result also carries access', async () => {
  const [search] = createCodeModeTools({ getEntries: () => [WRITE_TOOL], callTool: emptyCall });
  const hit = (await search.handler({ query: 'select:github__issue_write' })).matches[0];
  assert.equal(hit.access, 'write');
});

test('feedback2#2: in-sandbox codemode.search results carry the same access field', async () => {
  const [, , exec] = createCodeModeTools({
    getEntries: () => [READ_ANNOTATED, WRITE_TOOL],
    callTool: emptyCall,
  });
  const wire = await exec.handler({
    code: `async () => codemode.search('').matches.map((m) => ({ name: m.name, access: m.access, descLen: m.description.length }))`,
  });
  assert.equal(wire.isError, undefined);
  const data = wire.result;
  assert.equal(data.length, 2);
  const byName = new Map(data.map((m) => [m.name, m]));
  assert.equal(byName.get('github__get_me').access, 'read');
  assert.equal(byName.get('github__issue_write').access, 'write');
  assert.ok(byName.get('github__get_me').descLen <= 160);
});

// ---------------------------------------------------------------------------
// 3. codemode.services(): local-only status aggregation
// ---------------------------------------------------------------------------

test('feedback2#3: services() aggregates entries by server and flags failedServers offline', async () => {
  const entries = [
    { server: 'github', tool: 'get_me', name: 'github__get_me', description: '', inputSchema: {} },
    { server: 'github', tool: 'search_code', name: 'github__search_code', description: '', inputSchema: {} },
    { server: 'notion', tool: 'notion-search', name: 'notion__notion-search', description: '', inputSchema: {} },
    { server: 'linear', tool: 'list_issues', name: 'linear__list_issues', description: '', inputSchema: {} },
  ];
  let upstreamCalls = 0;
  const mgr = {
    getEntries: () => entries,
    failedServers: ['notion'],
    callTool: () => { upstreamCalls += 1; throw new Error('services() must not call the upstream'); },
  };
  const [, execRead, exec] = createCodeModeTools(mgr);
  for (const tool of [execRead, exec]) {
    assert.match(tool.description, /codemode\.services\(\)/, `${tool.name} documents services()`);
  }

  const wire = await exec.handler({ code: 'async () => codemode.services()' });
  assert.equal(wire.isError, undefined, JSON.stringify(wire));
  const data = wire.result;
  assert.deepEqual(
    data.services.map((s) => [s.name, s.toolCount, s.online]),
    [
      ['github', 2, true],
      ['linear', 1, true],
      ['notion', 1, false],
    ],
  );
  assert.match(data.services.find((s) => s.name === 'notion').needsReauth, /token|授权/);
  assert.equal(data.services.find((s) => s.name === 'github').needsReauth, undefined);
  assert.equal(upstreamCalls, 0, 'services() made no upstream tool calls');
});

test('feedback2#3: a failed server with zero entries still appears as offline', async () => {
  const mgr = {
    getEntries: () => [
      { server: 'github', tool: 'get_me', name: 'github__get_me', description: '', inputSchema: {} },
    ],
    failedServers: ['vercel'],
    callTool: noNetwork,
  };
  const [, , exec] = createCodeModeTools(mgr);
  const data = (await exec.handler({ code: 'async () => codemode.services()' })).result;
  assert.deepEqual(
    data.services.map((s) => [s.name, s.toolCount, s.online]),
    [
      ['github', 1, true],
      ['vercel', 0, false],
    ],
  );
});

test('feedback2#3: services() reads live state and needsReauth is optional', async () => {
  const mgr = {
    getEntries: () => [
      { server: 'github', tool: 'get_me', name: 'github__get_me', description: '', inputSchema: {} },
    ],
    failedServers: [],
    callTool: noNetwork,
  };
  const [, , exec] = createCodeModeTools(mgr);
  const first = (await exec.handler({ code: 'async () => codemode.services()' })).result;
  assert.equal(first.services[0].online, true);
  assert.equal(first.services[0].needsReauth, undefined);

  // A later failure is reflected without recreating the tools (getter, not a
  // frozen snapshot) and no network call is involved.
  mgr.failedServers.push('github');
  const second = (await exec.handler({ code: 'async () => codemode.services()' })).result;
  assert.equal(second.services[0].online, false);
  assert.ok(second.services[0].needsReauth);
});

test('feedback2#3: servicesSnapshot handles missing manager fields defensively', () => {
  assert.deepEqual(servicesSnapshot({}), { services: [] });
  assert.deepEqual(servicesSnapshot({ getEntries: () => null, failedServers: 'github' }), { services: [] });
  const snap = servicesSnapshot({
    getEntries: () => [{ server: 'github', tool: 'get_me', name: 'github__get_me' }],
    failedServers: new Set(['github']), // Set is also accepted
  });
  assert.equal(snap.services[0].online, false);
  assert.ok(snap.services[0].needsReauth);
});
