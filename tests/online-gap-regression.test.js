/**
 * Batch 15 · semi-online gap regression (2026-11-23).
 *
 * Abstracts the 2026-11-23 Gemini online feedback into deterministic,
 * offline checks of the properties L1/G6 currently do not measure. See
 * docs/eval/SEMI-ONLINE-GAPS.md for the mapping table and the seven test
 * classes (T1..T7). Nothing here touches the network, a token, the
 * filesystem, or any other test's state. No commit / push / deploy.
 *
 * HONESTY RULE: cases blocked on P0 fixes that are still red in this
 * checkout (tests/gh-file-p0.test.js: P0-1/P0-2/P0-3/P0-4) are declared
 * `test.todo` with the exact failing test they replace. They are not
 * silently passed, and they are not weakened to match current behavior.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeFileResult, normalizePrResult } from '../src/result-normalize.js';
import {
  aliasGetFileContentsArgs,
  validateToolArgs,
  searchWithFallback,
  createCodeModeTools,
} from '../src/codemode.js';
import { applyFilePatch, applyTextPatch } from '../src/file-write.js';
import { createBranchIfMissing } from '../src/github-helpers.js';
import {
  CLIENT_PROFILES,
  encodeToolResult,
  encodeModelOutput,
  applyProfileToTools,
} from '../src/client-profile.js';
import {
  SCHEMA,
  recordFromMarkdown,
  validateRecord,
} from '../scripts/record-online-feedback.mjs';
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), '..');

/* ------------------------------------------------------------------ *
 * Canonical real-shape fixtures (T3) — the exact payloads from the
 * online incident, never simplified stand-ins.
 * ------------------------------------------------------------------ */
const SHA = '4cb29ea38f70d7c61b2a3a25b02e3bdf44905402';
const NOTICE = `successfully downloaded text file (SHA: ${SHA})\n`;
const BODY = `# gemini-mcp-gateway\n\nexport const answer = 42;\n${'真实文件正文行。\n'.repeat(20)}`;
const RAW = { text: NOTICE + BODY, resources: [{ text: BODY }] };
const PR_REAL = {
  id: 5444514334,
  html_url: 'https://api.github.com/repos/o/r/pulls/53',
  number: 999, // deliberately disagreeing field: URL must win
  title: 'real PR 53',
  state: 'open',
};

function githubReadTool() {
  return {
    name: 'github__get_file_contents',
    server: 'github',
    tool: 'get_file_contents',
    description: 'Read a file from a GitHub repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' }, repo: { type: 'string' },
        path: { type: 'string' }, ref: { type: 'string' }, branch: { type: 'string' },
      },
      required: ['owner', 'repo', 'path'],
    },
    annotations: { readOnlyHint: true },
  };
}

function prTool() {
  return {
    name: 'github__pull_request_read',
    server: 'github',
    tool: 'pull_request_read',
    description: 'Read a pull request and its associated data.',
    inputSchema: {
      type: 'object',
      properties: { method: { type: 'string' }, pullNumber: { type: 'integer' } },
    },
    annotations: { readOnlyHint: true },
  };
}

// ================================================================== *
// T3 — canonical real-shape fixtures
// ================================================================== */

test('T3: real {text:notice+body, resources} shape normalizes to pure body + sha from notice', () => {
  const out = normalizeFileResult(RAW);
  assert.equal(out.content, BODY, 'content must be exactly the file body, never notice+body');
  assert.equal(out.content.startsWith('#'), true);
  assert.equal(out.content.includes('successfully downloaded'), false);
  assert.equal(out.sha, SHA);
  assert.equal(out.raw, RAW, 'raw upstream payload is preserved for audit');
});

test('T3: real create_pull_request shape yields number from URL, not DB id', () => {
  const out = normalizePrResult(PR_REAL);
  assert.equal(out.number, 53, 'URL must win over the disagreeing number field');
  assert.equal(out.id, '5444514334', 'DB id is kept only as a string, never as number');
  assert.notEqual(out.number, Number(out.id));
});

const FEEDBACK_RECORD = path.join(REPO, 'docs', 'eval', 'online-feedback-2026-11-23.md');
const hasFeedbackRecord = fs.existsSync(FEEDBACK_RECORD);
test('T3: online-feedback.v1 record still parses and keeps F1..F7 evidence',
  { skip: hasFeedbackRecord ? false : 'online-feedback record is not present in this checkout — gap explicitly not measured, never a silent pass' },
  () => {
  const rec = recordFromMarkdown(fs.readFileSync(FEEDBACK_RECORD, 'utf8'));
  assert.equal(rec.schema, SCHEMA);
  assert.equal(rec.feedback.length, 7);
  const byCategory = Object.fromEntries(rec.feedback.map((f) => [f.category, f]));
  assert.ok(byCategory['result-shape-download-notice']);
  assert.deepEqual(byCategory['result-shape-download-notice'].evidence.pr, [56, 57]);
  assert.ok(byCategory['ignored-parameter-branch']);
  assert.deepEqual(byCategory['pr-number-id-confusion'].evidence.pr, [53]);
  assert.deepEqual(validateRecord(rec), []);
});

// ================================================================== *
// T1 — byte-exact round-trip read → patch → write → readback
// ================================================================== */

test('T1: patch is byte-exact against the canonical body (pure applyTextPatch)', () => {
  const diff = [
    '--- a/a.ts',
    '+++ b/a.ts',
    '@@ -3,1 +3,1 @@',
    '-export const answer = 42;',
    '+export const answer = 43;',
  ].join('\n');
  const applied = applyTextPatch(BODY, diff);
  assert.equal(applied.ok, true, applied.error);
  const intended = BODY.replace('export const answer = 42;', 'export const answer = 43;');
  assert.equal(applied.text, intended, 'every byte outside the hunk must survive');
  assert.equal(applied.text.endsWith('真实文件正文行。\n'), true, 'trailing newline and CJK must survive');
});

test('T1: applyFilePatch dryRun writes zero bytes, real write readback is byte-exact', async () => {
  let stored = BODY;
  let writes = 0;
  const read = async () => normalizeFileResult(RAW).content; // canonical read path
  const patch = [
    '--- a/a.ts', '+++ b/a.ts', '@@ -3,1 +3,1 @@',
    '-export const answer = 42;', '+export const answer = 43;',
  ].join('\n');

  const preview = await applyFilePatch({ read, write: () => { throw new Error('must not write'); }, path: 'a.ts', patch, dryRun: true });
  assert.equal(preview.ok, true, preview.error);
  assert.equal(writes, 0);
  assert.equal(stored, BODY, 'dryRun must not mutate storage');

  const real = await applyFilePatch({
    read,
    write: async (_p, text) => { writes += 1; stored = text; return { sha: 'neblob', commit: { sha: 'newcommit' } }; },
    path: 'a.ts', patch, dryRun: false,
  });
  assert.equal(real.ok, true, real.error);
  assert.equal(writes, 1);
  assert.equal(stored, BODY.replace('export const answer = 42;', 'export const answer = 43;'));
  // POST-CONDITION: readback equals intended, byte for byte.
  const readback = normalizeFileResult({ text: stored });
  assert.equal(readback.content, stored);
  assert.equal(readback.content.includes('successfully downloaded'), false);
});

test.todo(
  'T1 (P0, BLOCKED): guest fileResult({text:notice+body, resources}) on the real shape must return pure body — red in tests/gh-file-p0.test.js "P0-1: guest fileResult on the real raw shape"',
  { reason: 'P0 fix not landed in this checkout; do not weaken to current behavior. Un-todo after gh-file-p0 P0-1 is green.' },
  () => {},
);

test.todo(
  'T1 (P0, BLOCKED): host normalizeFileResult({text:notice+body}) with NO resources must strip the notice — red in tests/gh-file-p0.test.js "P0-2: host normalizeFileResult strips a leading notice with no resources"',
  { reason: 'P0 fix not landed in this checkout; the with-resources case is asserted above, the no-resources case stays todo.' },
  () => {},
);

// ================================================================== *
// T2 — negative contract: aliases / unknown args / no silent fallback
// ================================================================== */

test('T2: branch→ref alias is pure and never overwrites an explicit ref', () => {
  const a = aliasGetFileContentsArgs('github__get_file_contents', { owner: 'o', repo: 'r', path: 'p', branch: 'eval/gap-f2' });
  assert.equal(a.args.ref, 'eval/gap-f2');
  assert.equal(a.aliased, true);
  const b = aliasGetFileContentsArgs('github__get_file_contents', { branch: 'x', ref: 'v1' });
  assert.equal(b.args.ref, 'v1');
  assert.equal(b.aliased, false, 'explicit ref must win — no silent overwrite');
  const c = aliasGetFileContentsArgs('other__tool', { branch: 'x' });
  assert.equal(c.args.ref, undefined);
  assert.equal(c.aliased, false, 'unrelated tools are never aliased');
});

test('T2: validateToolArgs enforces required fields and types instead of silently accepting', () => {
  const tool = githubReadTool();
  assert.throws(() => validateToolArgs(tool, { repo: 'r', path: 'p' }), /requires fields: owner/);
  assert.throws(() => validateToolArgs(tool, { owner: 'o', repo: 'r', path: 42 }), /expected string, got number/);
  // An unknown extra argument is not rejected by the pure helper (upstream
  // decides), but it is never rewritten into a different parameter silently.
  const args = { owner: 'o', repo: 'r', path: 'p', unknownArg: 'keep' };
  assert.doesNotThrow(() => validateToolArgs(tool, args));
});

test('T2: createBranchIfMissing accepts branch (F4 spelling) without "name is required"', async () => {
  const seen = [];
  const out = await createBranchIfMissing({
    listBranches: async () => [],
    createBranch: async (args) => { seen.push(args); return { ok: true }; },
    branch: 'eval/gap-f4',
    base: 'main',
  });
  assert.notEqual(out.error, 'ensureBranch: name is required');
  assert.equal(seen.length, 1);
  const created = seen[0].name ?? seen[0].branch;
  assert.equal(created, 'eval/gap-f4');
});

test.todo(
  'T2 (P0, BLOCKED): sandbox github__get_file_contents({branch}) must send ref=branch to upstream — red in tests/gh-file-p0.test.js "P0-3: sandbox call to github__get_file_contents sends ref=branch"',
  { reason: 'the host bridge alias is not wired yet; pure alias helper is asserted above, bridge case stays todo.' },
  () => {},
);

test.todo(
  'T2 (P0, BLOCKED): readFileRange({branch}) must reach upstream as ref — red in tests/gh-file-p0.test.js "P0-3: readFileRange(branch) also reaches upstream as ref"',
  { reason: 'same unfixed P0-3 bridge gap; no network, no silent fallback assertion until fixed.' },
  () => {},
);

// ================================================================== *
// T4 — discovery effort (search count / method enum visibility)
// ================================================================== */

test('T4: one search surfaces the pull_request_read tool (no extra probes)', () => {
  const tools = [prTool(), githubReadTool()];
  const { res, isSelect } = searchWithFallback(tools, 'pull request read', 5);
  assert.equal(isSelect, false);
  const hit = res.matches.find((m) => m.name === 'github__pull_request_read');
  assert.ok(hit, 'the tool must be discoverable in the first search');
  assert.equal(res.matches.length > 0, true);
});

test('T4: select:<name> resolves without fallback probing', () => {
  const { res, isSelect, hint } = searchWithFallback([prTool()], 'select:github__pull_request_read', 8);
  assert.equal(isSelect, true);
  assert.equal(res.matches[0].name, 'github__pull_request_read');
  assert.equal(hint, undefined, 'select must not need the fuzzy fallback hint');
});

test.todo(
  'T4 (P1, BLOCKED): select detail + search list must carry the pull_request_read method enum get|get_files|get_check_runs in one shot — red in tests/gh-file-p0.test.js "P0-4: search detail and list carry the pull_request_read method enum"',
  { reason: 'description enum not visible in this checkout; probesToDiscover metric cannot be claimed as 0 until P0-4 is green.' },
  () => {},
);

// ================================================================== *
// T5 — write safety (dryRun / atomic / post-condition) — invariant guard
// ================================================================== */

test('T5: truncated read is a hard stop before any write', async () => {
  let writes = 0;
  const out = await applyFilePatch({
    read: async () => `${BODY}--- TRUNCATED --- 100 chars total`,
    write: async () => { writes += 1; return {}; },
    path: 'a.ts',
    patch: '--- a/a.ts\n+++ b/a.ts\n@@ -3,1 +3,1 @@\n-export const answer = 42;\n+export const answer = 43;',
    dryRun: false,
  });
  assert.equal(out.ok, false);
  assert.match(out.error, /refusing to patch a truncated read/);
  assert.equal(writes, 0, 'no write may happen after a truncated read');
});

test('T5: three tools only — no new tool introduced to work around a discovery gap', () => {
  const manager = { getEntries: () => [], callTool: async () => ({}) };
  assert.deepEqual(createCodeModeTools(manager).map((t) => t.name), ['search', 'execute_read', 'execute']);
});

// ================================================================== *
// T6 — long session / reconnect: server behavior vs client boundary
// ================================================================== */

test('T6 (server side): tool list is stable across a simulated long session / reconnect', () => {
  const manager = { getEntries: () => [prTool(), githubReadTool()], callTool: async () => ({}) };
  const names = [];
  for (let i = 0; i < 5; i += 1) names.push(createCodeModeTools(manager).map((t) => t.name).join(','));
  assert.equal(new Set(names).size, 1, 'no tool-list drift across calls (Gemini snapshot invariant)');
  assert.equal(names[0], 'search,execute_read,execute');
});

test('T6 (server side): tool annotations remain identical across profiles', () => {
  const tools = createCodeModeTools({ getEntries: () => [prTool()], callTool: async () => ({}) });
  for (const profile of Object.values(CLIENT_PROFILES)) {
    const adapted = applyProfileToTools(tools, profile);
    assert.deepEqual(adapted.map((t) => t.name), tools.map((t) => t.name));
    for (let i = 0; i < tools.length; i += 1) {
      assert.deepEqual(adapted[i].annotations, tools[i].annotations);
    }
  }
});

test.todo(
  'T6 (client side, UNKNOWABLE offline): post-deploy Gemini unknown_tool + manual @ recovery — external client behavior; gateway cannot observe or force reconnect',
  { reason: 'docs/ledger/batch-11-reconnect.md: no Google-side wire, no real-client run; must stay unknown (not pass, not gateway fail). Requires a deploy-window replay with evidence.' },
  () => {},
);

// ================================================================== *
// T7 — platform conformance (encoding + annotations, gap slice)
// ================================================================== */

const TEXT_JSON = { content: [{ type: 'text', text: JSON.stringify({ result: normalizeFileResult(RAW) }) }] };

test('T7: Gemini and Claude strip structuredContent; ChatGPT derives it', () => {
  for (const id of ['gemini', 'claude']) {
    const out = encodeToolResult({ ...TEXT_JSON, structuredContent: { leaked: true } }, CLIENT_PROFILES[id]);
    assert.equal('structuredContent' in out, false, `${id} must not leak structuredContent`);
    assert.equal(out.content[0].text, TEXT_JSON.content[0].text, 'text JSON unchanged');
  }
  const cg = encodeToolResult(TEXT_JSON, CLIENT_PROFILES.chatgpt);
  assert.equal('structuredContent' in cg, true);
  assert.deepEqual(cg.structuredContent, { result: normalizeFileResult(RAW) });
});

test('T7: encodeModelOutput never emits structuredContent on Gemini/Claude', () => {
  const output = { result: { number: 53 } };
  for (const id of ['gemini', 'claude']) {
    const out = encodeModelOutput(output, CLIENT_PROFILES[id]);
    assert.equal('structuredContent' in out, false);
  }
  assert.deepEqual(encodeModelOutput(output, CLIENT_PROFILES.chatgpt).structuredContent, { number: 53 });
});

test('T7: a notice-leaking body is not hidden by profile encoding — the fix must be upstream of encoding', () => {
  // If the download notice ever reaches the text JSON, no profile silently drops it.
  const dirty = { content: [{ type: 'text', text: JSON.stringify({ content: NOTICE + BODY }) }] };
  for (const profile of Object.values(CLIENT_PROFILES)) {
    const out = encodeToolResult(dirty, profile);
    assert.equal(out.content[0].text.includes('successfully downloaded'), true,
      `${profile.id} must not silently mask a leaked notice — content must be clean before encoding`);
  }
  // The clean path carries only the body. Assert on the `content` field of the
  // canonical result: `raw` intentionally keeps the original upstream payload
  // (including the notice) for audit, so stringifying the whole object is not
  // a valid "notice leaked into file body" check.
  const cleanBody = normalizeFileResult(RAW).content;
  const clean = { content: [{ type: 'text', text: JSON.stringify({ content: cleanBody }) }] };
  for (const profile of Object.values(CLIENT_PROFILES)) {
    assert.equal(encodeToolResult(clean, profile).content[0].text.includes('successfully downloaded'), false);
  }
});
