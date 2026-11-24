/**
 * M2 public-contract hardening — Issue #15 remaining items + Gate5 friction.
 *
 * Deterministic, offline regressions for:
 *   BC-011 · `codemode.normalizeMerge(value, context)` fills top-level
 *            `number`/`url` when a merge result only carries {sha,merged,message}
 *            (URL-first; never from an internal id).
 *   BC-012 · `codemode.writeFiles` (the applyFilePatch sandbox bridge) rejects
 *            the github__push_files {files:[...]} shape with an actionable error
 *            instead of silently failing, and a default-dry-run preview now says
 *            `dryRun:true, written:0` + a warning instead of looking like a
 *            completed write.
 *   Gate5 AT-LN-01 · `linear__list_issues` search hint + execute guidance steer
 *            the default request to a small `limit` and a minimal `fields` list
 *            so a 10-issue default page does not blow the ~26.8KB output cap.
 *   CI polling · a `check_runs`-only snapshot (no top-level status/conclusion)
 *            aggregates to status:"completed" + the right conclusion.
 *
 * Every upstream call is a local fake; no network, token, commit or deploy.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { runInSandbox, createCodeModeTools } from '../src/codemode.js';

// ---------------------------------------------------------------------------
// Sandbox fake bridge (same shape as tests/b10-write-semantics.test.js)
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

const READ_TOOL = toolDesc('get_file_contents', { readOnly: true });
const WRITE_TOOL = toolDesc('create_or_update_file');
const PUSH_TOOL = toolDesc('push_files');
const BASE_TOOLS = [READ_TOOL, WRITE_TOOL];

function textResult(value) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] };
}

const PATCH = '@@ -1,1 +1,1 @@\n-a\n+b\n';

/** Run guest code with an injected tool bridge; records every upstream call. */
async function evalCode(code, handlers = {}, tools = BASE_TOOLS) {
  const calls = [];
  const callTool = async (server, tool, args) => {
    calls.push({ server, tool, args });
    const fn = handlers[`${server}::${tool}`];
    if (!fn) throw new Error(`unexpected tool call: ${server}::${tool}`);
    return fn(args);
  };
  const out = await runInSandbox({ code: `async () => { ${code} }`, tools, callTool });
  assert.ok(!out.isError, out.result);
  return { value: typeof out.result === 'string' ? JSON.parse(out.result) : out.result, calls };
}

// ---------------------------------------------------------------------------
// BC-012 · writeFiles input contract (files[] misuse is rejected, not silent)
// ---------------------------------------------------------------------------

test('BC-012: sandbox writeFiles rejects {files:[...]} with an actionable error and zero I/O', async () => {
  const { value, calls } = await evalCode(`
    return await codemode.writeFiles({
      owner: 'o', repo: 'r', branch: 'b',
      files: [{ path: 'a.txt', content: 'A\\n' }],
      dryRun: false,
    });
  `);
  assert.equal(value.ok, false, 'the push_files shape must never be treated as patches');
  assert.match(value.error, /patches/);
  assert.match(value.error, /files/);
  assert.match(value.error, /Rename files->patches/);
  assert.match(value.hint, /writeFiles\(\{/);
  assert.equal(value.written, 0);
  assert.equal(value.partial, false);
  assert.deepEqual(calls, [], 'rejected before any read/write tool call');
});

test('BC-012: the writeFiles alias and applyFilePatch share the same rejection', async () => {
  const { value } = await evalCode(`
    return {
      alias: await codemode.writeFiles({ owner: 'o', repo: 'r', files: [{ path: 'a.txt', content: 'A\\n' }], dryRun: false }),
      single: await codemode.applyFilePatch({ owner: 'o', repo: 'r', files: [{ path: 'a.txt', content: 'A\\n' }], dryRun: false }),
    };
  `);
  for (const key of ['alias', 'single']) {
    assert.equal(value[key].ok, false, key);
    assert.match(value[key].error, /patches/, key);
  }
});

test('BC-012: default dryRun returns explicit dryRun:true + written:0 + warning (never a silent write)', async () => {
  const { value, calls } = await evalCode(`
    return await codemode.writeFiles({
      owner: 'o', repo: 'r', branch: 'b',
      patches: [{ path: 'a.txt', patch: ${JSON.stringify(PATCH)} }],
    });
  `, {
    'github::get_file_contents': () => textResult({ content: 'a\n', sha: 'blob' }),
    'github::push_files': () => { throw new Error('dryRun must not push'); },
  }, [...BASE_TOOLS, PUSH_TOOL]);
  assert.equal(value.ok, true, value.error);
  assert.equal(value.dryRun, true, 'the preview must label itself as a dry run');
  assert.equal(value.written, 0, 'zero files were written');
  assert.deepEqual(value.writtenFiles, []);
  assert.match(value.warning, /NO files were written/);
  assert.match(value.warning, /dryRun:false/);
  assert.equal(value.atomic, true, 'atomic capability is still reported in the preview');
  assert.deepEqual(calls.map((c) => c.tool), ['get_file_contents'], 'only a read happened');
});

test('BC-012: correct {patches, dryRun:false} sandbox call keeps the atomic write behaviour unchanged', async () => {
  const { value, calls } = await evalCode(`
    return await codemode.writeFiles({
      owner: 'o', repo: 'r', branch: 'b', dryRun: false,
      patches: [{ path: 'a.txt', patch: ${JSON.stringify(PATCH)} }],
    });
  `, {
    'github::get_file_contents': () => textResult({ content: 'a\n', sha: 'blob' }),
    'github::push_files': () => textResult({ sha: 'commit-x', commitSha: 'commit-x' }),
  }, [...BASE_TOOLS, PUSH_TOOL]);
  assert.equal(value.ok, true, value.error);
  assert.equal(value.atomic, true);
  assert.equal(value.dryRun, undefined, 'a real write never claims dryRun:true');
  assert.equal(value.warning, undefined);
  assert.deepEqual(calls.map((c) => c.tool), ['get_file_contents', 'push_files']);
});

test('BC-012: legacy non-atomic write path still writes each file with the historical shape', async () => {
  const { value, calls } = await evalCode(`
    return await codemode.writeFiles({
      owner: 'o', repo: 'r', branch: 'b', dryRun: false,
      patches: [{ path: 'a.txt', patch: ${JSON.stringify(PATCH)} }],
    });
  `, {
    'github::get_file_contents': () => textResult({ content: 'a\n', sha: 'blob' }),
    'github::create_or_update_file': () => textResult({ commitSha: 'c1', sha: 'new' }),
  });
  assert.equal(value.ok, true, value.error);
  assert.deepEqual(Object.keys(value).sort(), ['commitSha', 'diff', 'files', 'ok', 'sha']);
  assert.equal(value.dryRun, undefined);
  assert.equal(calls.filter((c) => c.tool === 'create_or_update_file').length, 1);
});

// ---------------------------------------------------------------------------
// BC-011 · normalizeMerge context fill (merge responses carry no PR identity)
// ---------------------------------------------------------------------------

const MERGE_ONLY = { sha: 'merge-sha-1', merged: true, message: 'Pull Request successfully merged' };

test('BC-011: normalizeMerge fills number/url from {owner,repo,pullNumber} when upstream omits them', async () => {
  const { value } = await evalCode(`
    const raw = ${JSON.stringify(MERGE_ONLY)};
    const out = codemode.normalizeMerge(raw, { owner: 'o', repo: 'r', pullNumber: 53 });
    return { out, rawAfter: raw };
  `);
  assert.equal(value.out.number, 53);
  assert.equal(value.out.url, 'https://github.com/o/r/pull/53');
  assert.equal(value.out.sha, 'merge-sha-1');
  assert.equal(value.out.merged, undefined, 'raw upstream fields stay inside raw');
  assert.deepEqual(value.out.raw, MERGE_ONLY, 'raw is preserved untouched');
  assert.equal(value.rawAfter.number, undefined, 'the input object is not mutated');
});

test('BC-011: a response URL wins; a bare pull number fills number only; no context stays null', async () => {
  const { value } = await evalCode(`
    return {
      fromResponseUrl: codemode.normalizeMerge(
        { sha: 's1', merged: true, html_url: 'https://github.com/o/r/pull/9' },
        { owner: 'o', repo: 'r', pullNumber: 53 },
      ),
      bareNumber: codemode.normalizeMerge(${JSON.stringify(MERGE_ONLY)}, 53),
      noContext: codemode.normalizeMerge(${JSON.stringify(MERGE_ONLY)}),
    };
  `);
  assert.deepEqual(
    [value.fromResponseUrl.number, value.fromResponseUrl.url],
    [9, 'https://github.com/o/r/pull/9'],
    'URL-first contract is unchanged',
  );
  assert.deepEqual([value.bareNumber.number, value.bareNumber.url], [53, null]);
  assert.deepEqual([value.noContext.number, value.noContext.url], [null, null],
    'without a context the honest answer stays null');
  assert.equal(value.noContext.sha, 'merge-sha-1');
});

test('BC-011: an internal id never becomes the merge number, even with context', async () => {
  const { value } = await evalCode(`
    return {
      idOnly: codemode.normalizeMerge({ id: 1000000001, sha: 's', merged: true, message: 'ok' }),
      withContext: codemode.normalizeMerge(
        { id: 1000000001, sha: 's', merged: true },
        { owner: 'o', repo: 'r', pullNumber: 53 },
      ),
      canonicalWithContext: codemode.canonicalize(${JSON.stringify(MERGE_ONLY)}, { owner: 'o', repo: 'r', pullNumber: 53 }),
    };
  `);
  assert.equal(value.idOnly.number, null, 'id is not a number fallback');
  assert.equal(value.idOnly.id, '1000000001');
  assert.equal(value.withContext.number, 53);
  assert.notEqual(value.withContext.number, Number(value.withContext.id));
  assert.equal(value.canonicalWithContext.number, 53, 'canonicalize accepts the same context');
  assert.equal(value.canonicalWithContext.url, 'https://github.com/o/r/pull/53');
});

// ---------------------------------------------------------------------------
// CI polling · check_runs-only snapshot aggregation through the sandbox bridge
// ---------------------------------------------------------------------------

test('waitForPrChecks (sandbox): a check_runs-only snapshot reports completed + success', async () => {
  const { value, calls } = await evalCode(`
    return await codemode.waitForPrChecks({ owner: 'o', repo: 'r', pullNumber: 53, maxPolls: 3, pollIntervalMs: 1 });
  `, {
    'github::pull_request_read': () => ({
      total_count: 2,
      check_runs: [
        { name: 'ci', status: 'completed', conclusion: 'success' },
        { name: 'lint', status: 'completed', conclusion: 'skipped' },
      ],
    }),
  }, [{ ...toolDesc('pull_request_read', { readOnly: true }) }]);
  assert.equal(value.ok, true);
  assert.equal(value.status, 'completed');
  assert.equal(value.conclusion, 'success');
  assert.equal(value.timedOut, false);
  assert.equal(calls[0].args.method, 'get_check_runs');
});

// ---------------------------------------------------------------------------
// Gate5 AT-LN-01 · Linear default-read guidance (no upstream schema change)
// ---------------------------------------------------------------------------

function linearListIssues() {
  return {
    name: 'linear__list_issues',
    server: 'linear',
    tool: 'list_issues',
    description: "List issues in the user's Linear workspace.",
    inputSchema: { type: 'object', properties: { limit: { type: 'number' }, fields: { type: 'array' } } },
    annotations: { readOnlyHint: true },
  };
}

function githubListIssues() {
  return {
    name: 'github__list_issues',
    server: 'github',
    tool: 'list_issues',
    description: 'List issues in a GitHub repository.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  };
}

test('AT-LN-01: linear__list_issues usage hint asks for a small limit + minimal fields', async () => {
  const tools = createCodeModeTools({ getEntries: () => [linearListIssues(), githubListIssues()], callTool: async () => ({}) });
  const [search] = tools;
  const detail = await search.handler({ query: 'select:linear__list_issues' });
  const usage = detail.matches[0].usage;
  assert.ok(usage, 'the compact usage hint must be present');
  assert.match(usage, /limit/);
  assert.match(usage, /fields/);
  assert.match(usage, /26\.8KB/);
  assert.match(usage, /cursor/);
  // The hint is server-scoped: GitHub's own list_issues keeps its old shape.
  const gh = await search.handler({ query: 'select:github__list_issues' });
  assert.equal(gh.matches[0].usage, undefined, 'the Linear hint must not leak onto GitHub list_issues');
});

test('AT-LN-01: both execute descriptions carry the Linear narrow-request guidance', () => {
  const tools = createCodeModeTools({ getEntries: () => [], callTool: async () => ({}) });
  for (const name of ['execute_read', 'execute']) {
    const desc = tools.find((t) => t.name === name).description;
    assert.match(desc, /Linear list_issues/, `${name} must mention the Linear default`);
    assert.match(desc, /fields/, `${name} must ask for minimal fields`);
    assert.match(desc, /26\.8KB/, `${name} must state the output-cap risk`);
  }
});
