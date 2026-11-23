/**
 * Batch 15 · P0 from live user testing (2026-11-23).
 *
 * 1. GitHub get_file_contents returns
 *    {text:"successfully downloaded text file (SHA: <hex>)\n<body>", resources:[{text:body}]}.
 *    The guest `fileResult` helper still preferred `text`, so the download notice
 *    became line 1 of the file content and got written into a ledger + 5 .ts/.tsx
 *    files (tsc errors; user cleaned up in PR #57). content MUST be pure body.
 * 2. get_file_contents' real parameter is `ref`; passing `branch` was silently
 *    ignored upstream and fell back to main.
 * 3. pull_request_read aggregates method=get|get_files|get_check_runs, but the
 *    tool guidance never said so, costing an extra probe round every time.
 *
 * All upstream I/O is faked. No real token, no network, no commit/push/deploy.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { runInSandbox, createCodeModeTools, aliasGetFileContentsArgs } from '../src/codemode.js';
import { normalizeFileResult } from '../src/result-normalize.js';

const BODY = `# gemini-mcp-gateway\n\nexport const answer = 42;\n${'真实文件正文行。\n'.repeat(20)}`;
const SHA = '4cb29ea38f70d7c61b2a3a25b02e3bdf44905402';
const NOTICE = `successfully downloaded text file (SHA: ${SHA})\n`;
const RAW = { text: NOTICE + BODY, resources: [{ text: BODY }] };

async function evalCode(code) {
  const out = await runInSandbox({ code: `async () => { ${code} }`, tools: [], callTool: async () => ({}) });
  assert.ok(!out.isError, out.result);
  return asValue(out.result);
}

/** runInSandbox may hand back a JS object or a JSON string depending on size. */
function asValue(result) {
  return typeof result === 'string' ? JSON.parse(result) : result;
}

function githubReadTool(overrides = {}) {
  return {
    name: 'github__get_file_contents',
    server: 'github',
    tool: 'get_file_contents',
    description: 'Read a file from a GitHub repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        path: { type: 'string' },
        ref: { type: 'string' },
        branch: { type: 'string' },
      },
      required: ['owner', 'repo', 'path'],
    },
    annotations: { readOnlyHint: true },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. guest fileResult: the actual P0
// ---------------------------------------------------------------------------

test('P0-1: guest fileResult on the real raw shape → pure body, sha from notice, stable field set', async () => {
  const r = await evalCode(`return codemode.fileResult(${JSON.stringify(RAW)});`);
  assert.deepEqual(Object.keys(r).sort(), ['content', 'encoding', 'path', 'sha', 'size', 'truncated']);
  assert.equal(r.content, BODY, 'content must be 100% file body');
  assert.equal(r.content.includes('successfully downloaded'), false);
  assert.equal(r.content.startsWith('#'), true, 'notice must not be line 1');
  assert.equal(r.sha, SHA);
  assert.equal(r.size, BODY.length);
});

test('P0-1: guest fileResult strips a leading notice even with no resources', async () => {
  const r = await evalCode(`return codemode.fileResult(${JSON.stringify({ text: NOTICE + BODY })});`);
  assert.equal(r.content, BODY);
  assert.equal(r.sha, SHA);
  assert.equal(r.content.includes('successfully downloaded'), false);
});

test('P0-1: guest fileResult strips a CRLF notice', async () => {
  const notice = `successfully downloaded text file (SHA: ${SHA})\r\n`;
  const r = await evalCode(`return codemode.fileResult(${JSON.stringify({ text: notice + BODY })});`);
  assert.equal(r.content, BODY);
  assert.equal(r.sha, SHA);
});

test('P0-1: guest fileResult keeps an ordinary text+resources shape intact (no regression)', async () => {
  const r = await evalCode(`return codemode.fileResult({ text: 'hello', resources: [{ text: 'hello' }] });`);
  assert.equal(r.content, 'hello');
  assert.equal(r.size, 5);
  assert.equal(r.sha, null);
});

test('P0-1: guest fileResult keeps truncation and JSON-text semantics', async () => {
  const r = await evalCode(`return {
    marker: codemode.fileResult({ content: 'a--- TRUNCATED --- 10 chars total' }),
    json: codemode.fileResult(${JSON.stringify(JSON.stringify({ content: 'from-json', sha: 'j1' }))}),
  };`);
  assert.equal(r.marker.truncated, true);
  assert.equal(r.json.content, 'from-json');
  assert.equal(r.json.sha, 'j1');
});

// ---------------------------------------------------------------------------
// 2. host normalizeFileResult agrees; no regression
// ---------------------------------------------------------------------------

test('P0-2: host normalizeFileResult on the real raw shape → pure body + sha', () => {
  const out = normalizeFileResult(RAW);
  assert.equal(out.content, BODY);
  assert.equal(out.sha, SHA);
  assert.equal(out.raw, RAW);
});

test('P0-2: host normalizeFileResult strips a leading notice with no resources', () => {
  const out = normalizeFileResult({ text: NOTICE + BODY });
  assert.equal(out.content, BODY);
  assert.equal(out.sha, SHA);
});

test('P0-2: guest fileResult / host normalizeFileResult / readFileRange agree', async () => {
  const out = await runInSandbox({
    code: `async () => {
      const raw = ${JSON.stringify(RAW)};
      const guest = codemode.fileResult(raw);
      const host = codemode.normalizeFile(raw, 'github__get_file_contents');
      const range = await codemode.readFileRange({ owner: 'o', repo: 'r', path: 'a.ts', startLine: 1, tools: { readTool: 'github__get_file_contents' } });
      return { guest, host, range };
    }`,
    tools: [githubReadTool()],
    callTool: async () => RAW,
  });
  assert.ok(!out.isError, out.result);
  const r = asValue(out.result);
  assert.equal(r.guest.content, BODY);
  assert.equal(r.host.content, BODY);
  assert.equal(r.guest.sha, SHA);
  assert.equal(r.host.sha, SHA);
  assert.equal(r.range.lines[0], '# gemini-mcp-gateway');
  assert.equal(r.range.lines.join('\n'), BODY);
});

test('P0-2: normalization does not regress notice-only / long-line / truncation shapes', () => {
  const noticeOnly = 'successfully downloaded text file (SHA: abcdef123456, 81 chars)';
  const noticeResult = normalizeFileResult({ content: [{ type: 'text', text: noticeOnly }] });
  assert.equal(noticeResult.content, '', 'notice is metadata only, never model-facing content');
  assert.match(noticeResult.notice, /successfully downloaded/);
  const long = `x${'A'.repeat(900)}Z`;
  for (const value of [long, JSON.stringify({ content: long }), { resources: [{ text: long }] }]) {
    assert.equal(normalizeFileResult(value).content, long);
  }
  assert.equal(normalizeFileResult({ content: 'ok--- TRUNCATED --- 3 chars' }).truncated, true);
});

// ---------------------------------------------------------------------------
// 3. branch → ref alias at the host tool bridge
// ---------------------------------------------------------------------------

test('P0-3: pure alias helper maps branch → ref without overwriting an explicit ref', () => {
  const a = aliasGetFileContentsArgs('github__get_file_contents', { owner: 'o', repo: 'r', path: 'p', branch: 'feature/x' });
  assert.equal(a.args.ref, 'feature/x');
  assert.equal(a.aliased, true);
  const b = aliasGetFileContentsArgs('github__get_file_contents', { owner: 'o', repo: 'r', path: 'p', branch: 'feature/x', ref: 'v1' });
  assert.equal(b.args.ref, 'v1');
  assert.equal(b.aliased, false);
  const c = aliasGetFileContentsArgs('github__other_tool', { branch: 'x' });
  assert.equal(c.args.branch, 'x');
  assert.equal(c.args.ref, undefined);
  assert.equal(c.aliased, false);
});

test('P0-3: sandbox call to github__get_file_contents sends ref=branch', async () => {
  const seen = [];
  const out = await runInSandbox({
    code: `async () => await codemode.github__get_file_contents({ owner: 'o', repo: 'r', path: 'a.ts', branch: 'feature/x' })`,
    tools: [githubReadTool()],
    callTool: async (server, tool, args) => { seen.push({ server, tool, args }); return RAW; },
  });
  assert.ok(!out.isError, out.result);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].args.ref, 'feature/x');
  assert.equal(seen[0].args.branch, 'feature/x', 'do not drop or rewrite unknown params');
  assert.equal(out.toolCalls[0].argAlias.ref, 'branch', 'alias must be recorded in the audit trail');
  const r = asValue(out.result);
  assert.equal(r.text.startsWith('successfully downloaded'), true, 'alias must not change the result');
});

test('P0-3: explicit ref wins; wrong tool is not aliased', async () => {
  const seen = [];
  const out = await runInSandbox({
    code: `async () => {
      const a = await codemode.github__get_file_contents({ owner: 'o', repo: 'r', path: 'a.ts', branch: 'feature/x', ref: 'v1' });
      const b = await codemode.other__tool({ branch: 'feature/y' });
      return { a: !!a, b: !!b };
    }`,
    tools: [
      githubReadTool(),
      { name: 'other__tool', server: 'other', tool: 'tool', description: 'x', inputSchema: { type: 'object', properties: { branch: { type: 'string' } } } },
    ],
    callTool: async (server, tool, args) => { seen.push({ tool, args }); return RAW; },
  });
  assert.ok(!out.isError, out.result);
  assert.equal(seen.find((c) => c.tool === 'get_file_contents').args.ref, 'v1');
  assert.equal(seen.find((c) => c.tool === 'tool').args.ref, undefined);
});

test('P0-3: readFileRange(branch) also reaches upstream as ref', async () => {
  const seen = [];
  const out = await runInSandbox({
    code: `async () => await codemode.readFileRange({ owner: 'o', repo: 'r', path: 'a.ts', startLine: 1, branch: 'feature/z' })`,
    tools: [githubReadTool()],
    callTool: async (server, tool, args) => { seen.push(args); return RAW; },
  });
  assert.ok(!out.isError, out.result);
  assert.equal(seen[0].ref, 'feature/z');
  const r = asValue(out.result);
  assert.equal(r.lines[0], '# gemini-mcp-gateway');
});

// ---------------------------------------------------------------------------
// 4. guidance / search detail
// ---------------------------------------------------------------------------

function prTool() {
  return {
    name: 'github__pull_request_read',
    server: 'github',
    tool: 'pull_request_read',
    description: 'Read a pull request and its associated data.',
    inputSchema: { type: 'object', properties: { method: { type: 'string' }, pullNumber: { type: 'integer' } } },
    annotations: { readOnlyHint: true },
  };
}

test('P0-4: search detail and list carry the pull_request_read method enum', async () => {
  const manager = { getEntries: () => [prTool(), githubReadTool()], callTool: async () => ({}) };
  const [search] = createCodeModeTools(manager);
  const detail = await search.handler({ query: 'select:github__pull_request_read' });
  const hit = detail.matches[0];
  assert.ok(hit.description.includes('get_files'), 'select detail must enumerate methods');
  assert.ok(hit.description.includes('get_check_runs'), 'select detail must enumerate methods');
  assert.match(hit.usage, /"get"\s*\|\s*"get_files"\s*\|\s*"get_check_runs"/);

  const list = await search.handler({ query: 'pull request read', limit: 5 });
  const prHit = list.matches.find((m) => m.name === 'github__pull_request_read');
  assert.ok(prHit, 'search must still surface the tool');
  assert.match(prHit.usage, /get_files/);
});

test('P0-4: get_file_contents guidance says ref and mentions the branch alias', async () => {
  const manager = { getEntries: () => [githubReadTool()], callTool: async () => ({}) };
  const [search, executeRead, execute] = createCodeModeTools(manager);
  const detail = await search.handler({ query: 'select:github__get_file_contents' });
  assert.match(detail.matches[0].usage, /\bref\b/);
  assert.match(detail.matches[0].usage, /branch/);
  for (const tool of [executeRead, execute]) {
    assert.match(tool.description, /pull_request_read/);
    assert.match(tool.description, /get_files/);
    assert.match(tool.description, /get_check_runs/);
    assert.match(tool.description, /get_file_contents/);
    assert.match(tool.description, /\bref\b/);
  }
});

test('P0-4: still exactly three MCP tools (no new upstream tool)', () => {
  const manager = { getEntries: () => [], callTool: async () => ({}) };
  assert.deepEqual(createCodeModeTools(manager).map((t) => t.name), ['search', 'execute_read', 'execute']);
});
