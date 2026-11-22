/**
 * B10 integration — canonical adapters + upstream orchestration helpers inside
 * Code Mode. All upstream I/O is faked through `callTool`; no network, no
 * credentials, no real GitHub tools are touched.
 *
 * The fake tool results use the MCP content-envelope shape that the gateway's
 * unwrapResult() consumes, so these tests exercise the same path as production.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runInSandbox, createCodeModeTools } from '../src/codemode.js';

// ---------------------------------------------------------------------------
// Fakes / helpers
// ---------------------------------------------------------------------------

function toolDesc(tool, { readOnly = false } = {}) {
  return {
    server: 'github',
    tool,
    name: `github__${tool}`,
    description: tool,
    inputSchema: { type: 'object', properties: {}, required: [] },
    annotations: { readOnlyHint: readOnly },
  };
}

const READ_TOOLS = ['get_file_contents', 'list_branches', 'list_pull_requests', 'search_code', 'get_issue'];
const WRITE_TOOLS = ['create_or_update_file', 'create_branch', 'delete_branch', 'create_pull_request', 'update_pull_request'];
const ALL_TOOLS = [
  ...READ_TOOLS.map((t) => toolDesc(t, { readOnly: true })),
  ...WRITE_TOOLS.map((t) => toolDesc(t)),
];

/** Wrap a value in the MCP text-content envelope used by real upstream results. */
function textResult(value) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] };
}

/**
 * Run guest code, recording every tool call.
 * `handlers` maps `server::tool` to a function(args) returning a raw tool result.
 */
async function evalCode(code, handlers = {}, { tools = ALL_TOOLS, maxCalls } = {}) {
  const calls = [];
  const callTool = async (server, tool, args) => {
    calls.push({ server, tool, args });
    const fn = handlers[`${server}::${tool}`];
    if (!fn) throw new Error(`unexpected tool call: ${server}::${tool}`);
    return fn(args);
  };
  const out = await runInSandbox({
    code: `async () => { ${code} }`,
    tools,
    callTool,
    ...(maxCalls !== undefined ? { maxCalls } : {}),
  });
  assert.ok(!out.isError, out.result);
  return { value: JSON.parse(out.result), calls, out };
}

// A realistic get_file_contents result for a text file.
const FILE_BODY = 'one\ntwo\nthree\n';
function fileResult(args) {
  return textResult({ content: FILE_BODY, sha: 'sha-read-1', path: args.path, encoding: 'utf-8' });
}

const PATCH = '@@ -2,1 +2,1 @@\n-two\n+TWO\n';

// ---------------------------------------------------------------------------
// 1. Canonical adapters (bridge → host result-normalize.js)
// ---------------------------------------------------------------------------

test('canonical: normalizeFile/normalizePr/normalizeIssue/normalizeResult return host-adapter shapes with raw', async () => {
  const { value } = await evalCode(`
    const file = codemode.normalizeFile({ content: 'abc', sha: 's', size: 3, path: 'a.txt' });
    const pr = codemode.normalizePr({ number: 12, html_url: 'https://github.com/o/r/pull/12', head: { sha: 'h' }, base: { ref: 'main' } });
    const issue = codemode.normalizeIssue({ number: 7, title: 'bug', state: 'open' });
    const dispatched = codemode.normalizeResult('github__get_issue', { number: 9, title: 'x' });
    const unknown = codemode.normalizeResult('notion__fetch', { foo: 1 });
    return { file, pr, issue, dispatched, unknown };
  `);
  assert.deepEqual(Object.keys(value.file).sort(), [
    'content', 'encoding', 'path', 'raw', 'sha', 'size', 'truncated',
  ]);
  assert.equal(value.file.content, 'abc');
  assert.equal(value.file.sha, 's');
  assert.equal(value.file.path, 'a.txt');
  assert.ok(value.file.raw);

  assert.deepEqual(Object.keys(value.pr).sort(), [
    'baseRef', 'headSha', 'id', 'mergeable', 'number', 'raw', 'sha', 'state', 'title', 'url',
  ]);
  assert.equal(value.pr.number, 12);
  assert.equal(value.pr.headSha, 'h');
  assert.equal(value.pr.baseRef, 'main');

  assert.deepEqual(Object.keys(value.issue).sort(), ['id', 'number', 'raw', 'state', 'title', 'url']);
  assert.equal(value.issue.number, 7);

  assert.equal(value.dispatched.number, 9, 'normalizeResult dispatches by tool name');
  assert.deepEqual(value.unknown, { raw: { foo: 1 } }, 'unknown tool name → raw-only fallback');
});

test('canonical: download notice cannot masquerade as file body (real GitHub capture shape)', async () => {
  // Real get_file_contents returns a short "successfully downloaded ... (SHA: ...)"
  // text block first, with the actual body in a nested MCP resource block.
  const notice = 'successfully downloaded text file (SHA: abcdef1234567890)';
  const body = 'line one\nline two\nline three\n';
  const raw = {
    content: [
      { type: 'text', text: notice },
      { type: 'resource', resource: { uri: 'file:///x.txt', mimeType: 'text/plain', text: body } },
    ],
    sha: 'abcdef1234567890',
    path: 'x.txt',
  };
  const { value } = await evalCode(`
    return codemode.normalizeFile(${JSON.stringify(raw)});
  `);
  assert.notEqual(value.content, notice, 'download notice must not be used as content');
  assert.ok(!value.content.includes('successfully downloaded'));
  assert.equal(value.content.trim(), body.trim(), 'real resource body must win');
  assert.equal(value.sha, 'abcdef1234567890');
  assert.ok(value.raw, 'raw must be preserved');
});

test('canonical helpers never throw and are hidden (no constructor leak)', async () => {
  // Bridge args are structured-cloned, so getter-throwing Proxies cannot cross
  // it (the SDK rejects them). The host adapter's Proxy-robustness is covered
  // by tests/result-normalize.test.js; here we verify odd-but-serializable
  // shapes do not throw and that every helper is hidden.
  const { value } = await evalCode(`
    return {
      file: codemode.normalizeFile({ weird: [1, 2, 3], nope: null }),
      pr: codemode.normalizePr(42),
      hidden: ['normalizeFile','normalizePr','normalizeIssue','normalizeResult','applyFilePatch','ensureBranch','upsertPr','fetchAllPages','repoGrep']
        .every((k) => typeof codemode[k] === 'function' && codemode[k].constructor === undefined),
    };
  `);
  assert.equal(value.file.content, null);
  assert.equal(value.pr.number, null);
  assert.equal(value.hidden, true, 'every new helper must be __dshHide\'d');
});

// ---------------------------------------------------------------------------
// 2. applyFilePatch — dryRun / mismatch / real write
// ---------------------------------------------------------------------------

test('applyFilePatch: dryRun reads but never writes; returns diff only', async () => {
  const { value, calls } = await evalCode(`
    return await codemode.applyFilePatch({
      owner: 'o', repo: 'r', path: 'x.txt', patch: ${JSON.stringify(PATCH)},
    });
  `, {
    'github::get_file_contents': fileResult,
    'github::create_or_update_file': () => { throw new Error('must not write on dryRun'); },
  });
  assert.equal(value.ok, true, value.error);
  assert.equal(value.commitSha, undefined);
  assert.equal(value.content, undefined);
  assert.equal(value.diff.path, 'x.txt');
  assert.equal(value.diff.added, 1);
  assert.equal(value.diff.removed, 1);
  assert.match(value.diff.diff, /a\/x\.txt/);
  assert.deepEqual(calls.map((c) => c.tool), ['get_file_contents'], 'only a read happened');
  assert.equal(calls[0].args.ref, undefined, 'no branch → no ref override');
});

test('applyFilePatch: patch mismatch never writes and returns an error', async () => {
  const badPatch = '@@ -2,1 +2,1 @@\n-WRONG\n+TWO\n';
  const { value, calls } = await evalCode(`
    return await codemode.applyFilePatch({
      owner: 'o', repo: 'r', path: 'x.txt', branch: 'feature/x',
      patch: ${JSON.stringify(badPatch)}, dryRun: false, message: 'm',
    });
  `, {
    'github::get_file_contents': fileResult,
    'github::create_or_update_file': () => { throw new Error('must not write on mismatch'); },
  });
  assert.equal(value.ok, false);
  assert.match(value.error, /context mismatch/);
  assert.deepEqual(calls.map((c) => c.tool), ['get_file_contents'], 'write tool never called');
  assert.equal(calls[0].args.ref, 'feature/x', 'branch is forwarded as ref on read');
});

test('applyFilePatch: explicit readTool/writeTool + non-dryRun writes with sha and returns commitSha/content', async () => {
  const { value, calls } = await evalCode(`
    return await codemode.applyFilePatch({
      owner: 'o', repo: 'r', path: 'x.txt', patch: ${JSON.stringify(PATCH)},
      dryRun: false, message: 'fix typo', branch: 'feature/x',
      tools: { readTool: 'github__get_file_contents', writeTool: 'github__create_or_update_file' },
    });
  `, {
    'github::get_file_contents': fileResult,
    'github::create_or_update_file': (args) => textResult({ commitSha: 'commit-9', content: { name: 'x.txt' } }),
  });
  assert.equal(value.ok, true, value.error);
  assert.equal(value.commitSha, 'commit-9');
  assert.deepEqual(value.content, { name: 'x.txt' });
  assert.deepEqual(calls.map((c) => c.tool), ['get_file_contents', 'create_or_update_file']);
  const write = calls[1].args;
  assert.equal(write.content, 'one\nTWO\nthree\n');
  assert.equal(write.sha, 'sha-read-1', 'read sha is forwarded as optimistic-lock sha');
  assert.equal(write.branch, 'feature/x');
  assert.equal(write.message, 'fix typo');
});

test('applyFilePatch: read failure never writes', async () => {
  const { value, calls } = await evalCode(`
    return await codemode.applyFilePatch({
      owner: 'o', repo: 'r', path: 'missing.txt', patch: ${JSON.stringify(PATCH)}, dryRun: false,
    });
  `, {
    'github::get_file_contents': () => { throw new Error('not found'); },
    'github::create_or_update_file': () => { throw new Error('must not write'); },
  });
  assert.equal(value.ok, false);
  assert.match(value.error, /read failed.*not found/);
  assert.deepEqual(calls.map((c) => c.tool), ['get_file_contents']);
});

// ---------------------------------------------------------------------------
// 3. ensureBranch / upsertPr / fetchAllPages / repoGrep
// ---------------------------------------------------------------------------

test('ensureBranch: reuses existing branch idempotently (no create/delete)', async () => {
  const { value, calls } = await evalCode(`
    return await codemode.ensureBranch({ owner: 'o', repo: 'r', name: 'feature/x', fromBranch: 'main' });
  `, {
    'github::list_branches': () => textResult([{ name: 'main' }, { name: 'feature/x' }]),
    'github::create_branch': () => { throw new Error('must not create on reuse'); },
  });
  assert.equal(value.created, false);
  assert.equal(value.reused, true);
  assert.equal(value.reset, false);
  assert.deepEqual(calls.map((c) => c.tool), ['list_branches']);
});

test('ensureBranch: creates a missing branch from base', async () => {
  const { value, calls } = await evalCode(`
    return await codemode.ensureBranch({ owner: 'o', repo: 'r', name: 'feature/new', fromBranch: 'main' });
  `, {
    'github::list_branches': () => textResult([{ name: 'main' }]),
    'github::create_branch': (args) => ({ name: args.branch, from: args.from_branch }),
  });
  assert.equal(value.created, true);
  assert.equal(value.reused, false);
  assert.equal(value.branch.name, 'feature/new');
  assert.deepEqual(calls.map((c) => c.tool), ['list_branches', 'create_branch']);
});

test('upsertPr: creates when no matching open PR; updates when one exists', async () => {
  const created = await evalCode(`
    return await codemode.upsertPr({ owner: 'o', repo: 'r', head: 'feature/x', base: 'main', title: 'T' });
  `, {
    'github::list_pull_requests': () => textResult([]),
    'github::create_pull_request': (args) => ({ number: 42, ...args }),
    'github::update_pull_request': () => { throw new Error('must not update'); },
  });
  assert.equal(created.value.created, true);
  assert.equal(created.value.pr.number, 42);

  const existing = { number: 7, head: { ref: 'feature/x' }, base: { ref: 'main' }, state: 'open' };
  const updated = await evalCode(`
    return await codemode.upsertPr({ owner: 'o', repo: 'r', head: 'feature/x', base: 'main', title: 'New' });
  `, {
    'github::list_pull_requests': () => textResult([existing]),
    'github::create_pull_request': () => { throw new Error('must not create'); },
    'github::update_pull_request': (args) => ({ number: args.pullNumber, title: args.title }),
  });
  assert.equal(updated.value.updated, true);
  assert.equal(updated.value.created, false);
  assert.equal(updated.value.pr.number, 7);
  assert.equal(updated.value.pr.title, 'New');
});

test('fetchAllPages: follows cursors, de-duplicates, and reports truncation', async () => {
  const { value, calls } = await evalCode(`
    return await codemode.fetchAllPages({
      tools: { pageTool: 'github__search_code' }, maxPages: 5,
    });
  `, {
    'github::search_code': (args) => {
      if (args.cursor === undefined) return textResult({ items: [{ id: 1 }, { id: 2 }], nextCursor: 'c2' });
      if (args.cursor === 'c2') return textResult({ items: [{ id: 2 }, { id: 3 }], next: 'c3' });
      return textResult({ items: [{ id: 4 }], next: null });
    },
  });
  assert.deepEqual(value.items, [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]);
  assert.equal(value.pages, 3);
  assert.equal(value.truncated, false);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].args.cursor, undefined);
  assert.equal(calls[1].args.cursor, 'c2');
  assert.equal(calls[2].args.cursor, 'c3');

  const capped = await evalCode(`
    return await codemode.fetchAllPages({ tools: { pageTool: 'github__search_code' }, maxPages: 2 });
  `, {
    'github::search_code': (args) => textResult({
      items: [{ n: args.cursor ? Number(args.cursor) + 1 : 1 }],
      next: args.cursor ? `c${Number(args.cursor.slice(1)) + 1}` : 'c2',
    }),
  });
  assert.equal(capped.value.pages, 2);
  assert.equal(capped.value.truncated, true, 'reaching maxPages sets truncated');
});

test('repoGrep: matches with file/line/column and records unreadable files', async () => {
  const { value } = await evalCode(`
    return await codemode.repoGrep({
      listTool: 'github__search_code', readTool: 'github__get_file_contents', pattern: 'TODO',
    });
  `, {
    'github::search_code': () => textResult({ items: [{ path: 'a.js' }, { path: 'bad.js' }] }),
    'github::get_file_contents': (args) => {
      if (args.path === 'bad.js') throw new Error('EACCES');
      return textResult({ content: 'const x = 1;\n// TODO fix\n', sha: 's' });
    },
  });
  assert.equal(value.matches.length, 1);
  assert.deepEqual([value.matches[0].file, value.matches[0].line, value.matches[0].column], ['a.js', 2, 4]);
  assert.deepEqual(value.errors, [{ file: 'bad.js', error: 'EACCES' }]);
  assert.equal(value.scanned, 1);
  assert.equal(value.truncated, false);
});

// ---------------------------------------------------------------------------
// 4. Boundaries — helper calls consume the tool budget; schemas unchanged
// ---------------------------------------------------------------------------

test('orchestration helpers go through the same tool-call budget', async () => {
  const out = await runInSandbox({
    // Distinct paths avoid the read-only dedup cache so the second call
    // genuinely consumes another tool-call budget slot.
    code: `async () => {
      await codemode.applyFilePatch({ owner:'o', repo:'r', path:'x', patch: ${JSON.stringify(PATCH)} });
      await codemode.applyFilePatch({ owner:'o', repo:'r', path:'y', patch: ${JSON.stringify(PATCH)} });
      return 'unexpected';
    }`,
    tools: ALL_TOOLS,
    callTool: async (_server, tool) => (tool === 'get_file_contents' ? fileResult({}) : textResult({})),
    maxCalls: 1,
  });
  assert.equal(out.isError, true);
  assert.match(out.result, /tool call limit \(1\) exceeded/);
});

test('execute/execute_read tool schemas are unchanged by the B10 integration', () => {
  const manager = {
    getEntries: () => [],
    callTool: async () => ({}),
  };
  const [search, executeRead, execute] = createCodeModeTools(manager);
  assert.deepEqual(Object.keys(search.inputSchema.properties).sort(), ['limit', 'query']);
  assert.deepEqual(search.inputSchema.required, ['query']);
  for (const tool of [executeRead, execute]) {
    assert.deepEqual(Object.keys(tool.inputSchema.properties), ['code']);
    assert.deepEqual(tool.inputSchema.required, ['code']);
    assert.equal(tool.inputSchema.properties.code.type, 'string');
  }
  // No new MCP tool was registered; the helpers are sandbox-only.
  assert.deepEqual([search.name, executeRead.name, execute.name], ['search', 'execute_read', 'execute']);
});
