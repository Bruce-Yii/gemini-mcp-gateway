/**
 * Batch 15 · ChatGPT online read-only test fixes (2026-11-23).
 *
 * Deterministic, network-free regressions for the three gateway problems the
 * ChatGPT window exposed, plus the additive PR id/nodeId fields:
 *
 *   1. githubActionsGetJobLogs: the GitHub REST logs endpoint returns 415 for
 *      `Accept: application/octet-stream`. It requires
 *      `application/vnd.github+json`; the 302 target is a signed Blob URL that
 *      must be followed WITHOUT Authorization and with a generic Accept.
 *   2. normalizeFileResult: `path` must be parsed from
 *      `repo://owner/repo/contents/<path>` resource URIs; no URI → null; never
 *      guess a path from arbitrary text.
 *   3. normalizeFile strips the notice from canonical `content`, but the outer
 *      raw `value.text` still carries the upstream wrapper notice. Upstream is
 *      NOT changed; the eval doc records "raw envelope != canonical content".
 *   4. prResult / canonical / normalizePr keep DB `id` and GraphQL `nodeId` as
 *      separate additive strings; `number` stays URL-first and is NEVER an id.
 *   5. Positive signals (branch alias, PR #59 number/checks, large file
 *      truncated=false, tool discovery) are recorded in the online eval doc.
 *
 * No real token, no network, no commit/push/deploy.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  githubActionsGetJobLogs,
  canonicalResult,
} from '../src/github-helpers.js';
import { normalizeFileResult, normalizePrResult } from '../src/result-normalize.js';
import { runInSandbox } from '../src/codemode.js';

const TOKEN_ENV = { GITHUB_TOKEN: 'fake-token-not-logged' };

function response(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (k) => (k && headers[String(k).toLowerCase()] !== undefined ? headers[String(k).toLowerCase()] : null),
    },
    text: async () => body,
  };
}

function redirect(location) {
  return response(302, '', { location });
}

async function evalCode(code) {
  const out = await runInSandbox({
    code: `async () => { ${code} }`,
    tools: [],
    callTool: async () => ({}),
  });
  assert.ok(!out.isError, out.result);
  return typeof out.result === 'string' ? JSON.parse(out.result) : out.result;
}

// ---------------------------------------------------------------------------
// 1. Actions job logs — 415 / 302 / 200 with correct headers and token safety
// ---------------------------------------------------------------------------

test('actions logs: initial REST request uses application/vnd.github+json, not octet-stream', async () => {
  let seen;
  const out = await githubActionsGetJobLogs({
    fetch: async (url, init) => {
      seen = { url, headers: init.headers };
      return response(200, 'log body');
    },
    env: TOKEN_ENV,
    owner: 'o',
    repo: 'r',
    job_id: 42,
  });
  assert.equal(out.ok, true);
  assert.equal(out.text, 'log body');
  assert.equal(seen.headers.Accept, 'application/vnd.github+json');
  assert.equal(seen.headers.Authorization, 'Bearer fake-token-not-logged');
  assert.match(seen.url, /\/repos\/o\/r\/actions\/jobs\/42\/logs$/);
});

test('actions logs: HTTP 415 from GitHub becomes a stable structured error', async () => {
  const out = await githubActionsGetJobLogs({
    fetch: async () => response(415, 'Unsupported Media Type'),
    env: TOKEN_ENV,
    owner: 'o',
    repo: 'r',
    job_id: 77,
  });
  assert.equal(out.ok, false);
  assert.equal(out.status, 415);
  assert.equal(out.text, null);
  assert.match(out.error, /415/);
  assert.equal(JSON.stringify(out).includes('fake-token'), false);
});

test('actions logs: 302 signed URL is followed without token, with generic Accept, returns text', async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, headers: { ...init.headers } });
    if (calls.length === 1) return redirect('https://storage.example.com/signed-log?sig=abc');
    return response(200, '2026-11-23T00:00:00Z Error: process exited with code 1\n');
  };
  const out = await githubActionsGetJobLogs({
    fetch: fakeFetch,
    env: TOKEN_ENV,
    owner: 'o',
    repo: 'r',
    job_id: 77,
  });
  assert.equal(out.ok, true);
  assert.equal(out.status, 200);
  assert.equal(out.text, '2026-11-23T00:00:00Z Error: process exited with code 1\n');
  assert.equal(calls.length, 2);
  // First hop: REST endpoint, JSON media type, with token.
  assert.equal(calls[0].headers.Accept, 'application/vnd.github+json');
  assert.equal(calls[0].headers.Authorization, 'Bearer fake-token-not-logged');
  // Second hop: signed Blob URL, no token, generic Accept.
  assert.equal(calls[1].url, 'https://storage.example.com/signed-log?sig=abc');
  assert.equal(calls[1].headers.Authorization, undefined, 'signed URL must not receive the token');
  assert.equal(calls[1].headers.Accept, '*/*');
});

test('actions logs: explicit followAccept can request text/plain on the signed URL', async () => {
  const seen = [];
  const fakeFetch = async (url, init) => {
    seen.push(init.headers.Accept);
    if (seen.length === 1) return redirect('https://storage.example.com/signed');
    return response(200, 'plain');
  };
  const out = await githubActionsGetJobLogs({
    fetch: fakeFetch,
    env: TOKEN_ENV,
    owner: 'o',
    repo: 'r',
    job_id: 1,
    followAccept: 'text/plain',
  });
  assert.equal(out.ok, true);
  assert.equal(out.text, 'plain');
  assert.deepEqual(seen, ['application/vnd.github+json', 'text/plain']);
});

// ---------------------------------------------------------------------------
// 2. File path — parse from root/resources URIs; no URI => null; no guessing
// ---------------------------------------------------------------------------

const NOTICE = 'successfully downloaded text file (SHA: 4cb29ea38f70d7c61b2a3a25b02e3bdf44905402)\n';
const BODY = '# real body\nline two\n';

test('file path: repo://.../contents/<path> URI yields the exact path', () => {
  const out = normalizeFileResult({
    text: NOTICE + BODY,
    resources: [{
      uri: 'repo://Bruce-Yii/gemini-mcp-gateway/contents/docs/eval/note.md',
      mimeType: 'text/plain; charset=utf-8',
      text: BODY,
    }],
  });
  assert.equal(out.path, 'docs/eval/note.md');
  assert.equal(out.content, BODY);
  assert.equal(out.content.includes('successfully downloaded'), false);
});

test('file path: root-level uri is parsed too; explicit path still wins', () => {
  const fromUri = normalizeFileResult({
    uri: 'repo://Bruce-Yii/gemini-mcp-gateway/contents/src/codemode.js',
    content: 'x',
  });
  assert.equal(fromUri.path, 'src/codemode.js');
  const explicit = normalizeFileResult({
    path: 'OVERRIDE.ts',
    uri: 'repo://o/r/contents/ignored.ts',
    content: 'x',
  });
  assert.equal(explicit.path, 'OVERRIDE.ts');
});

test('file path: nested resource URI inside content array is found', () => {
  const out = normalizeFileResult({
    content: [
      { type: 'text', text: NOTICE },
      { type: 'resource', resource: { uri: 'repo://o/r/contents/a/b/c.txt', text: BODY } },
    ],
  });
  assert.equal(out.path, 'a/b/c.txt');
  assert.equal(out.content, BODY);
});

test('file path: no URI (and no explicit path) returns null — never guesses', () => {
  assert.equal(normalizeFileResult({ text: BODY, resources: [{ text: BODY }] }).path, null);
  assert.equal(normalizeFileResult({ content: BODY }).path, null);
  assert.equal(normalizeFileResult({ uri: 'https://example.com/not-a-repo-uri', content: BODY }).path, null);
  assert.equal(normalizeFileResult('plain text').path, null);
});

test('file path: percent-encoded segments are decoded; malformed encoding does not throw', () => {
  assert.equal(normalizeFileResult({ uri: 'repo://o/r/contents/docs%20dir/a%20b.md', content: 'x' }).path, 'docs dir/a b.md');
  assert.equal(normalizeFileResult({ uri: 'repo://o/r/contents/%E0%A4%A', content: 'x' }).path, '%E0%A4%A');
});

// ---------------------------------------------------------------------------
// 3. Raw envelope != canonical content (upstream untouched, documented)
// ---------------------------------------------------------------------------

test('raw envelope keeps the upstream wrapper notice; canonical content is pure body', () => {
  const raw = { text: NOTICE + BODY, resources: [{ uri: 'repo://o/r/contents/f.md', text: BODY }] };
  const out = normalizeFileResult(raw);
  assert.equal(out.content, BODY);
  assert.equal(out.content.includes('successfully downloaded'), false);
  // The raw envelope is preserved by reference — the upstream wrapper text is
  // intentionally NOT rewritten. "raw envelope != canonical content" is a
  // documented contract, not a bug to fix by mutating upstream.
  assert.equal(out.raw, raw);
  assert.equal(out.raw.text.includes('successfully downloaded'), true);
  assert.equal(out.path, 'f.md');
});

// ---------------------------------------------------------------------------
// 4. PR id / nodeId additive; number stays URL-first (PR #59 fixture)
// ---------------------------------------------------------------------------

const PR59 = {
  id: 5444514334,
  node_id: 'PR_kwDOABC123',
  number: 999, // deliberately disagreeing field: URL must win
  html_url: 'https://github.com/Bruce-Yii/gemini-mcp-gateway/pull/59',
  sha: 'head-sha-59',
};

test('normalizePrResult: id + nodeId are strings, number comes from URL, never from id', () => {
  const out = normalizePrResult(PR59);
  assert.equal(out.number, 59);
  assert.equal(out.url, 'https://github.com/Bruce-Yii/gemini-mcp-gateway/pull/59');
  assert.equal(out.sha, 'head-sha-59');
  assert.equal(out.id, '5444514334');
  assert.equal(out.nodeId, 'PR_kwDOABC123');
  assert.notEqual(out.number, Number(out.id));
  // Stable enumerable key set is unchanged (nodeId is additive non-enumerable).
  assert.equal(Object.keys(out).includes('nodeId'), false);
});

test('canonicalResult: additive id/nodeId only appear when upstream provides them', () => {
  const withIds = canonicalResult(PR59);
  assert.equal(withIds.number, 59);
  assert.equal(withIds.id, '5444514334');
  assert.equal(withIds.nodeId, 'PR_kwDOABC123');
  const withoutIds = canonicalResult({ number: 12, html_url: 'u12', head: { sha: 'h12' } });
  assert.deepEqual(Object.keys(withoutIds).sort(), ['number', 'raw', 'sha', 'url']);
  assert.equal(canonicalResult(null).number, null);
});

test('guest prResult: id/nodeId exposed separately, number URL-first', async () => {
  const out = await evalCode(`
    return codemode.prResult(${JSON.stringify(PR59)});
  `);
  assert.equal(out.number, 59);
  assert.equal(out.url, 'https://github.com/Bruce-Yii/gemini-mcp-gateway/pull/59');
  assert.equal(out.sha, 'head-sha-59');
  assert.equal(out.id, '5444514334');
  assert.equal(out.nodeId, 'PR_kwDOABC123');
  assert.notEqual(out.number, Number(out.id));
});

test('guest fileResult: path parsed from repo://.../contents/ URI', async () => {
  const raw = { text: NOTICE + BODY, resources: [{ uri: 'repo://o/r/contents/guest/path.md', text: BODY }] };
  const out = await evalCode(`
    return codemode.fileResult(${JSON.stringify(raw)});
  `);
  assert.equal(out.content, BODY);
  assert.equal(out.content.includes('successfully downloaded'), false);
  assert.equal(out.path, 'guest/path.md');
});

test('guest + host agree on PR #59 number and do not confuse id with number', async () => {
  const guest = await evalCode(`return codemode.prResult(${JSON.stringify(PR59)});`);
  const host = normalizePrResult(PR59);
  const canonical = canonicalResult(PR59);
  assert.equal(guest.number, host.number);
  assert.equal(host.number, canonical.number);
  assert.equal(guest.number, 59);
  assert.equal(String(guest.id), String(host.id));
  assert.equal(guest.nodeId, host.nodeId);
});
