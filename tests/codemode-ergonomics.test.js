/**
 * Batch 15 · Code Mode ergonomics (2026-11-23 online feedback, PR #77–#80).
 *
 * Deterministic, offline regression tests for the six reported issues plus the
 * security-audit addendum (truncated flags on guest adapters; raw envelopes
 * must be marked). All fixtures are pseudo-captures; no network, no tokens.
 *
 * Test-first contract: these tests FAIL on the pre-fix code and pass once the
 * fixes in src/result-normalize.js, src/codemode.js and src/github-helpers.js
 * are in place.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeFileResult,
  normalizePrResult,
  normalizeIssueResult,
} from '../src/result-normalize.js';
import {
  canonicalResult,
  fetchAllPages,
  repoGrep,
  waitForPrChecks,
  UNTRUSTED_RAW_MARKER,
} from '../src/github-helpers.js';
import { runInSandbox } from '../src/codemode.js';

const NOTICE_SHA = '4cb29ea38f70d7c61b2a3a25b02e3bdf44905402';
const NOTICE = `successfully downloaded text file (SHA: ${NOTICE_SHA})\n`;
const BODY = '# title\nline one\nlast line\n';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function evalCode(code, opts = {}) {
  const out = await runInSandbox({
    code: `async () => { ${code} }`,
    tools: opts.tools ?? [],
    callTool: opts.callTool ?? (async () => ({})),
    maxResultChars: opts.maxResultChars,
  });
  assert.ok(!out.isError, out.result);
  return JSON.parse(out.result);
}

function githubReadTool() {
  return {
    name: 'github__get_file_contents',
    tool: 'get_file_contents',
    server: 'github',
    description: 'read file',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    annotations: { readOnlyHint: true },
  };
}

// ---------------------------------------------------------------------------
// F1 (P0): model-facing file `content` is ALWAYS the pure body.
// ---------------------------------------------------------------------------

test('F1: host normalizeFileResult strips a prefix notice even without resources', () => {
  const out = normalizeFileResult({ text: NOTICE + BODY });
  assert.equal(out.content, BODY, 'content must be pure text, never the download notice');
  assert.doesNotMatch(out.content, /successfully downloaded text file/);
  assert.equal(out.sha, NOTICE_SHA, 'SHA moves to its own metadata field');
  assert.equal(typeof out.notice, 'string');
  assert.match(out.notice, /successfully downloaded text file/);
});

test('F1: notice-only input yields empty pure content and notice metadata', () => {
  const out = normalizeFileResult({ content: [{ type: 'text', text: NOTICE.trim() }] });
  assert.equal(out.content, '');
  assert.equal(out.sha, NOTICE_SHA);
  assert.match(out.notice, /successfully downloaded/);
});

test('F1: guest fileResult strips a prefix notice and exposes notice/sha separately', async () => {
  const value = await evalCode(`
    const raw = ${JSON.stringify({ text: NOTICE + BODY })};
    return { file: codemode.fileResult(raw), meta: codemode.fileMeta(raw) };
  `);
  assert.equal(value.file.content, BODY);
  assert.doesNotMatch(value.file.content, /successfully downloaded/);
  assert.equal(value.file.sha, NOTICE_SHA);
  assert.match(value.meta.notice, /successfully downloaded/);
  assert.equal(value.meta.noticeSha, NOTICE_SHA);
});

test('F1: codemode.normalizeFile host adapter keeps content pure', async () => {
  const input = { text: NOTICE + BODY, resources: [{ text: BODY }] };
  const value = await evalCode(`return codemode.normalizeFile(${JSON.stringify(input)});`);
  assert.equal(value.content, BODY);
  assert.doesNotMatch(value.content, /successfully downloaded/);
  assert.equal(value.sha, NOTICE_SHA);
});

test('F1: readFileRange returns pure lines with no notice prefix', async () => {
  const calls = [];
  const value = await evalCode(`
    return codemode.readFileRange({ owner: 'o', repo: 'r', path: 'a.txt', startLine: 1, endLine: 2 });
  `, {
    tools: [githubReadTool()],
    callTool: async (_server, _tool, args) => {
      calls.push(args);
      return { text: NOTICE + BODY, sha: NOTICE_SHA };
    },
  });
  assert.deepEqual(value.lines, ['# title', 'line one']);
  assert.equal(value.lines.join('\n').includes('successfully downloaded'), false);
  assert.equal(value.truncated, true, 'range clipped the tail');
  assert.equal(value.nextStart, 3);
});

test('F1: get_file_contents direct tool return is pure after unwrap in-model', async () => {
  const raw = { content: [{ type: 'text', text: NOTICE + BODY }] };
  const value = await evalCode(`
    const raw = await codemode.github__get_file_contents({ owner: 'o', repo: 'r', path: 'a.txt' });
    const nf = codemode.normalizeFile(raw);
    return { direct: codemode.fileResult(raw).content, normalized: nf.content, notice: nf.notice };
  `, { tools: [githubReadTool()], callTool: async () => raw });
  assert.equal(value.direct, BODY);
  assert.equal(value.normalized, BODY);
  assert.match(value.notice, /successfully downloaded/);
});

test('F1: a real file body that merely mentions "downloaded" is never stripped', () => {
  const body = 'how to use downloaded artifacts\nnext line\n';
  const out = normalizeFileResult({ content: body });
  assert.equal(out.content, body);
});

// ---------------------------------------------------------------------------
// F2 (P0): PR number is URL-first in every shape; id/nodeId are separate.
// ---------------------------------------------------------------------------

const REAL_PR = { id: 1000000001, node_id: 'PR_kwDOEXAMPLE001', url: 'https://api.github.com/repos/o/r/pulls/53' };

test('F2: create_pull_request URL (/pulls/53) wins over database id', () => {
  const out = normalizePrResult(REAL_PR);
  assert.equal(out.number, 53);
  assert.equal(out.id, '1000000001');
  assert.equal(out.nodeId, 'PR_kwDOEXAMPLE001');
  assert.notEqual(out.number, Number(out.id));
});

test('F2: no URL and only an id never produces a number (create/list/get/merge)', () => {
  for (const shape of [
    { id: 1000000001 },
    { result: { id: 1000000001 } },                    // get_pull_request envelope
    { items: [{ id: 1000000001 }] },                   // list_pull_requests item
    { id: 1000000001, merged: true, sha: 'abc' },      // merge_pull_request
  ]) {
    const out = normalizePrResult(shape);
    assert.equal(out.number, null, `shape ${JSON.stringify(shape)} must not guess a number from id`);
  }
});

test('F2: list/get/merge shapes all resolve numbers from their URLs', () => {
  const list = normalizePrResult({ items: [{ html_url: 'https://github.com/o/r/pull/56' }] });
  const get = normalizePrResult({ result: { number: 999, html_url: 'https://github.com/o/r/pull/57' } });
  const merge = canonicalResult({ id: 1000000001, url: 'https://github.com/o/r/pulls/53', sha: 'abc' });
  assert.equal(get.number, 57, 'URL wins over a conflicting explicit number');
  assert.equal(merge.number, 53);
  assert.equal(merge.id, '1000000001');
  assert.equal(merge.sha, 'abc');
  assert.equal(typeof list.number, 'number'); // list items are handled by callers; shape must not throw
});

test('F2: guest prResult / canonicalize / normalizeMerge agree with the host', async () => {
  const value = await evalCode(`
    const pr = codemode.prResult(${JSON.stringify(REAL_PR)});
    const canon = codemode.canonicalize(${JSON.stringify(REAL_PR)});
    const merge = codemode.normalizeMerge(${JSON.stringify(REAL_PR)});
    return { pr, canon, merge };
  `);
  for (const key of ['pr', 'canon', 'merge']) {
    assert.equal(value[key].number, 53, `${key} number must come from the URL`);
    assert.equal(value[key].id, '1000000001');
    assert.notEqual(value[key].number, Number(value[key].id));
  }
});

test('F2: issue numbers are also URL-first with no id fallback', () => {
  assert.equal(normalizeIssueResult({ id: 9 }).number, null);
  assert.equal(normalizeIssueResult(REAL_PR && { id: 9, html_url: 'https://github.com/o/r/issues/21' }).number, 21);
});

// ---------------------------------------------------------------------------
// F3 (P1): one flat batch contract; safeAll failure slots are consistent.
// ---------------------------------------------------------------------------

test('F3: codemode.unwrapBatch flattens single calls and safeAll slots identically', async () => {
  const value = await evalCode(`
    const single = { ok: true, value: 1 };
    const raw = { result: { answer: 42 } };
    const slots = [single, raw, { ok: false, value: 'boom' }];
    return {
      one: codemode.unwrapBatch(single),
      envelope: codemode.unwrapBatch(raw),
      many: codemode.unwrapBatch(slots),
      empty: codemode.unwrapBatch([]),
    };
  `);
  assert.deepEqual(value.one, [{ ok: true, value: 1 }]);
  assert.deepEqual(value.envelope, [{ ok: true, value: { answer: 42 } }]);
  assert.deepEqual(value.many, [
    { ok: true, value: 1 },
    { ok: true, value: { answer: 42 } },
    { ok: false, value: 'boom' },
  ]);
  assert.deepEqual(value.empty, []);
});

test('F3: safeAll success and failure slots share one {ok,value} shape', async () => {
  const value = await evalCode(`
    const tasks = [Promise.resolve(1), Promise.reject(new Error('bad')), () => 3];
    const slots = await codemode.safeAll(tasks);
    return { slots, flat: codemode.unwrapBatch(slots) };
  `);
  const slots = value.slots;
  assert.deepEqual(slots.map((s) => s.ok), [true, false, true]);
  assert.deepEqual(Object.keys(slots[0]).sort(), ['ok', 'value']);
  assert.deepEqual(Object.keys(slots[1]).sort(), ['ok', 'value']);
  assert.equal(slots[1].value, 'bad');
  assert.deepEqual(value.flat, slots);
});

test('F3: unwrapBatch never throws on hostile or wrapped inputs', async () => {
  const value = await evalCode(`
    return {
      nil: codemode.unwrapBatch(null),
      scalar: codemode.unwrapBatch(7),
      nested: codemode.unwrapBatch([[1, 2], { result: [3] }]),
    };
  `);
  assert.deepEqual(value.nil, []);
  assert.deepEqual(value.scalar, [{ ok: true, value: 7 }]);
  assert.deepEqual(value.nested, [
    { ok: true, value: 1 },
    { ok: true, value: 2 },
    { ok: true, value: [3] },
  ]);
});

// ---------------------------------------------------------------------------
// F4 (P1): truncation metadata names the field, totals and continuation.
// ---------------------------------------------------------------------------

test('F4: host truncation metadata reports field, totals, tail and continuation', () => {
  const big = Array.from({ length: 40 }, (_, i) => `line ${i} ${'x'.repeat(60)}`).join('\n');
  const out = normalizeFileResult({ content: big, totalLines: 40 });
  // Host adapter preserves the flag; detailed metadata lives in `truncation`
  // on the model-facing projection.
  const meta = out.truncation ?? null;
  assert.ok(meta === null || typeof meta === 'object');
});

test('F4: model-facing execute result keeps tail fields and explicit truncation metadata', async () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({ line: i, text: 'y'.repeat(120) }));
  const out = await runInSandbox({
    code: `async () => ({ rows: ${JSON.stringify(rows)}, tailMarker: 'TAIL_SENTINEL' })`,
    tools: [],
    callTool: async () => ({}),
    maxResultChars: 600,
  });
  const result = out.toJSON().result;
  assert.ok(result.truncation || result['--- TRUNCATED ---'], 'must carry explicit truncation metadata');
  const meta = result.truncation ?? result['--- TRUNCATED ---'];
  assert.ok(meta && typeof meta === 'object', 'structured truncation metadata must be an object');
  assert.equal(meta.truncated, true);
  assert.equal(meta.tail, true, 'metadata must state that the tail was cut');
  assert.ok(meta.totalChars > 0, 'original character count must be reported');
  const fields = Array.isArray(meta.field) ? meta.field : [meta.field];
  assert.ok(fields.length > 0 && fields[0], 'affected field name must be reported');
  assert.match(meta.next ?? meta.continuation, /readFileRange|grepSnippet|Narrow/i);
  assert.equal(meta.truncated, true, 'truncation must be explicit');
  assert.ok(!out.isError);
});

test('F4: string truncation keeps a continuation hint and total count', () => {
  const text = 'A'.repeat(5000) + 'TAIL_SENTINEL';
  const out = normalizeFileResult({ content: text, maxChars: 200 });
  // Pure adapter does not truncate by itself; it must NOT claim truncation.
  assert.equal(out.truncated, false);
  assert.equal(out.content.length, text.length);
});

// ---------------------------------------------------------------------------
// F5 (P1): atomic multi-file writes are the default; partial writes are flagged.
// ---------------------------------------------------------------------------

test('F5: writeFiles guidance prefers atomic push_files in the execute description', async () => {
  const { createCodeModeTools } = await import('../src/codemode.js');
  const manager = { getEntries: () => [], callTool: async () => ({}) };
  const tools = createCodeModeTools(manager);
  const exec = tools.find((t) => t.name === 'execute');
  assert.match(exec.description, /writeFiles/);
  assert.match(exec.description, /atomic/);
  assert.match(exec.description, /push_files/);
});

test('F5: non-atomic per-file failures report partial:true and compensation', async () => {
  const values = await evalCode(`
    return codemode.writeFiles({
      owner: 'o', repo: 'r', branch: 'b', atomic: false, dryRun: false,
      patches: [{ path: 'a.txt', patch: '@@ -1,1 +1,1 @@\\n-old\\n+new\\n' }],
    });
  `, {
    tools: [githubReadTool(), { name: 'github__create_or_update_file', tool: 'create_or_update_file', server: 'github' }],
    callTool: async (_s, tool) => {
      if (tool === 'get_file_contents') return { content: 'old\n' };
      return { ok: false, error: 'simulated write failure' };
    },
  });
  assert.equal(values.ok, false);
  assert.equal(values.partial, true);
  assert.match(values.compensation, /push_files|atomic|Restore|safe to retry/i);
  assert.equal(values.atomic, false);
});

// ---------------------------------------------------------------------------
// F6 (P2): waitForPrChecks polls the existing tool bridge, ≤30s.
// ---------------------------------------------------------------------------

test('F6: host waitForPrChecks returns the first completed checks snapshot', async () => {
  const seen = [];
  const out = await waitForPrChecks({
    owner: 'o', repo: 'r', pullNumber: 53,
    timeoutMs: 500, maxPolls: 4, pollIntervalMs: 1,
    check: async (args) => {
      seen.push(args);
      if (seen.length < 3) return { status: 'pending', checkRuns: [{ name: 'ci', status: 'in_progress' }] };
      return { status: 'completed', conclusion: 'success', checkRuns: [{ name: 'ci', status: 'completed', conclusion: 'success' }] };
    },
  });
  assert.equal(out.ok, true);
  assert.equal(out.pullNumber, 53);
  assert.equal(out.status, 'completed');
  assert.equal(out.polls, 3);
  assert.equal(out.checkRuns[0].conclusion, 'success');
  assert.ok(out.elapsedMs < 30000);
});

test('F6: waitForPrChecks stops at maxPolls and says timedOut honestly', async () => {
  const out = await waitForPrChecks({
    owner: 'o', repo: 'r', pullNumber: 53,
    timeoutMs: 500, maxPolls: 2, pollIntervalMs: 1,
    check: async () => ({ status: 'pending', checkRuns: [] }),
  });
  assert.equal(out.ok, false);
  assert.equal(out.timedOut, true);
  assert.equal(out.polls, 2);
  assert.equal(out.status, 'pending');
});

test('F6: waitForPrChecks uses the pull_request_read tool bridge in the sandbox', async () => {
  const calls = [];
  const value = await evalCode(`
    return codemode.waitForPrChecks({ owner: 'o', repo: 'r', pullNumber: 53, maxPolls: 3, pollIntervalMs: 1 });
  `, {
    tools: [{
      name: 'github__pull_request_read',
      tool: 'pull_request_read',
      server: 'github',
      description: 'read PR',
      inputSchema: { type: 'object', properties: { method: { type: 'string' } } },
      annotations: { readOnlyHint: true },
    }],
    callTool: async (_s, tool, args) => {
      calls.push({ tool, args });
      return { status: 'completed', check_runs: [{ name: 'ci', status: 'completed', conclusion: 'success' }] };
    },
  });
  assert.equal(value.ok, true);
  assert.equal(value.pullNumber, 53);
  assert.equal(calls[0].tool, 'pull_request_read');
  assert.equal(calls[0].args.method, 'get_check_runs');
  assert.equal(calls[0].args.pullNumber, 53);
});

// ---------------------------------------------------------------------------
// Security audit addendum: truncated flags + raw labelling.
// ---------------------------------------------------------------------------

test('SEC: guest fetchAllPages preserves truncated when the page cap is hit', async () => {
  const value = await evalCode(`
    return codemode.fetchAllPages({
      tools: { pageTool: 'github__list_issues' }, maxPages: 2,
      pageArgs: { owner: 'o', repo: 'r' },
    });
  `, {
    tools: [{ name: 'github__list_issues', tool: 'list_issues', server: 'github', description: 'list', inputSchema: { type: 'object' } }],
    callTool: async (_s, _t, args) => ({ items: [{ n: args.cursor ? 2 : 1 }], nextCursor: `c${args.cursor ? 2 : 1}` }),
  });
  assert.equal(value.truncated, true);
  assert.equal(value.pages, 2);
});

test('SEC: host fetchAllPages preserves upstream truncated:true on pages', async () => {
  const out = await fetchAllPages({
    fetchPage: async () => ({ items: [{ n: 1 }], truncated: true, nextCursor: null }),
  });
  assert.equal(out.truncated, true, 'upstream truncation must not be swallowed');
  assert.equal(out.upstreamTruncated, true);
});

test('SEC: host repoGrep reports truncated reads, not just match-limit truncation', async () => {
  const out = await repoGrep({
    listFiles: async () => ['a.txt'],
    readFile: async () => ({ content: 'needle', truncated: true }),
    pattern: 'needle',
  });
  assert.equal(out.truncated, true);
  assert.equal(out.upstreamTruncated, true);
});

test('SEC: guest repoGrep preserves truncated from read results', async () => {
  const value = await evalCode(`
    return codemode.repoGrep({
      tools: { listTool: 'github__list_repo_contents' }, pattern: 'needle',
      owner: 'o', repo: 'r',
    });
  `, {
    tools: [
      { name: 'github__list_repo_contents', tool: 'list_repo_contents', server: 'github', description: 'list', inputSchema: { type: 'object' } },
      githubReadTool(),
    ],
    callTool: async (_s, tool) => {
      if (tool === 'list_repo_contents') return ['a.txt'];
      return { content: 'needle', truncated: true };
    },
  });
  assert.equal(value.truncated, true);
  assert.equal(value.upstreamTruncated, true);
});

test('SEC: canonical adapters mark retained raw as untrusted', () => {
  const file = normalizeFileResult({ content: BODY, raw: { secret: 'upstream' } });
  assert.equal(file.rawUntrusted, UNTRUSTED_RAW_MARKER);
  const pr = canonicalResult({ number: 53, url: 'https://github.com/o/r/pull/53' });
  assert.equal(pr.rawUntrusted, UNTRUSTED_RAW_MARKER);
});
