/**
 * Issue #15 (Gemini active-eval, 2026-11-24) — deterministic regressions for the
 * two prioritized contract bugs:
 *
 * 1. `codemode.unwrap(...)` on a successful `github__issue_write` result used to
 *    keep `number: null` even when the URL contained `/issues/<n>`. It must fill
 *    a MISSING number from the GitHub issue/PR URL (URL-first, never override an
 *    existing number, never use an internal id).
 * 2. `codemode.fileResult(...)` (and the write-before truncation gate) treated
 *    ANY occurrence of the literal `--- TRUNCATED ---` inside the body as a
 *    truncation signal. A complete ~40KB source file that merely *mentions* the
 *    marker was reported `truncated:true` and refused by the write gate.
 *
 * All upstream I/O is faked; no network, token, commit or deploy.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { runInSandbox, fileTextFromRaw } from '../src/codemode.js';
import { normalizeFileResult, explainTruncation } from '../src/result-normalize.js';

const MARKER = '--- TRUNCATED ---';

/** ~40KB body whose MIDDLE mentions the marker but whose tail is normal code. */
function completeFortyKbFile() {
  const lines = [
    '# capture.js (synthetic 40KB body for the false-positive regression)',
    `const TRUNCATION_MARKER = '${MARKER}'; // the file mentions the marker itself`,
    `const BABEL = /--- TRUNCATED ---\\s*(\\d+)/; // another ordinary mention`,
  ];
  for (let i = 0; i < 900; i += 1) lines.push(`const line${String(i).padStart(3, '0')} = '${'x'.repeat(36)}';`);
  lines.push('export function captureEnabled() { return true; }');
  return lines.join('\n');
}

const BODY = completeFortyKbFile();

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

const TOOLS = [
  toolDesc('get_file_contents', { readOnly: true }),
  toolDesc('create_or_update_file'),
];

function textResult(value) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] };
}

async function evalCode(code, handlers = {}) {
  const calls = [];
  const callTool = async (server, tool, args) => {
    calls.push({ server, tool, args });
    const fn = handlers[`${server}::${tool}`];
    if (!fn) throw new Error(`unexpected tool call: ${server}::${tool}`);
    return fn(args);
  };
  const out = await runInSandbox({ code: `async () => { ${code} }`, tools: TOOLS, callTool });
  assert.ok(!out.isError, out.result);
  return { value: typeof out.result === 'string' ? JSON.parse(out.result) : out.result, calls };
}

// ---------------------------------------------------------------------------
// 1. unwrap: URL-first number fill for Issue/PR results
// ---------------------------------------------------------------------------

test('issue15-1: unwrap fills a MISSING number from a GitHub issue/PR URL', async () => {
  const { value } = await evalCode(`
    const u = codemode.unwrap;
    const raw = { number: null, url: 'https://github.com/o/r/issues/12', title: 'x' };
    const filled = u(raw);
    return {
      filled,
      rawNumberAfter: raw.number,
      existing: u({ number: 7, url: 'https://github.com/o/r/issues/12' }),
      pull: u({ url: 'https://github.com/o/r/pull/53' }),
      htmlUrlFragment: u({ html_url: 'https://github.com/o/r/issues/12#issuecomment-1' }),
      nonGithub: u({ number: null, url: 'https://example.com/issues/12' }),
      contentEnvelope: u({ content: [{ type: 'text', text: JSON.stringify({ number: null, html_url: 'https://github.com/o/r/issues/99' }) }] }),
    };
  `);
  assert.equal(value.filled.number, 12);
  assert.equal(value.filled.url, 'https://github.com/o/r/issues/12');
  assert.equal(value.filled.title, 'x');
  assert.equal(value.rawNumberAfter, null, 'input object must not be mutated');
  assert.equal(value.existing.number, 7, 'an existing number is never overridden');
  assert.equal(value.pull.number, 53, 'PR URLs also fill the number');
  assert.equal(value.htmlUrlFragment.number, 12);
  assert.equal(value.nonGithub.number, null, 'non-GitHub URLs are left untouched');
  assert.equal(value.contentEnvelope.number, 99, 'the MCP content envelope path is covered too');
});

test('issue15-1: unwrap never derives a number from an internal id', async () => {
  const { value } = await evalCode(`
    const u = codemode.unwrap;
    return u({ number: null, id: 1000000001, node_id: 'I_kwDOEXAMPLE', url: 'https://example.com/nope' });
  `);
  assert.equal(value.number, null);
  assert.equal(value.id, 1000000001);
  assert.equal(value.node_id, 'I_kwDOEXAMPLE');
});

test('issue15-1: the host issue adapter stays URL-first (same contract as unwrap)', async () => {
  const { value } = await evalCode(`
    return {
      fromUrl: codemode.normalizeIssue({ number: null, url: 'https://github.com/o/r/issues/12' }),
      fromHtmlUrl: codemode.normalizeIssue({ number: null, html_url: 'https://github.com/o/r/issues/13' }),
    };
  `);
  assert.equal(value.fromUrl.number, 12);
  assert.equal(value.fromHtmlUrl.number, 13);
});

// ---------------------------------------------------------------------------
// 2. fileResult: a complete 40KB file mentioning the marker is NOT truncated
// ---------------------------------------------------------------------------

test('issue15-2: complete ~40KB file containing the marker mid-body reports truncated:false', () => {
  assert.ok(BODY.length >= 40_000, `fixture must be ~40KB, got ${BODY.length}`);
  const host = normalizeFileResult({ resources: [{ text: BODY }] });
  assert.equal(host.content, BODY, 'content must be byte-identical');
  assert.equal(host.truncated, false, 'mid-body marker mention is not a truncation');
  assert.ok(host.content.includes(MARKER), 'the marker is real content here');
  assert.ok(host.content.endsWith('export function captureEnabled() { return true; }'));
});

test('issue15-2: guest fileResult on the same body is not truncated (string + object shapes)', async () => {
  const { value } = await evalCode(`
    const check = (r) => ({ truncated: r.truncated, size: r.size, matches: r.content === ${JSON.stringify(BODY)}, tail: r.content.slice(-60) });
    return {
      objectShape: check(codemode.fileResult({ content: ${JSON.stringify(BODY)} })),
      arrayShape: check(codemode.fileResult({ content: [{ type: 'text', text: ${JSON.stringify(BODY)} }] })),
      stringShape: check(codemode.fileResult(${JSON.stringify(BODY)})),
    };
  `);
  for (const key of ['objectShape', 'arrayShape', 'stringShape']) {
    assert.equal(value[key].truncated, false, `${key} must not be a false-positive truncation`);
    assert.equal(value[key].matches, true, `${key} content must be complete`);
    assert.equal(value[key].size, BODY.length, `${key} size must be the real length`);
    assert.ok(value[key].tail.endsWith('export function captureEnabled() { return true; }'), `${key} tail must be the real last line`);
  }
});

test('issue15-2: a genuine append-at-cut marker is still detected (guest + host)', async () => {
  const truncatedBody = `${BODY}\n${MARKER} 900 chars total`;
  const host = normalizeFileResult({ resources: [{ text: truncatedBody }] });
  assert.equal(host.truncated, true);
  const { value } = await evalCode(`
    const truncatedBody = ${JSON.stringify(truncatedBody)};
    return {
      guest: codemode.fileResult({ content: truncatedBody }).truncated,
      hostText: codemode.normalizeFile({ resources: [{ text: truncatedBody }] }).truncated,
      legacyShort: codemode.fileResult({ content: 'a' + ${JSON.stringify(MARKER)} + ' 10 chars total' }).truncated,
    };
  `);
  assert.equal(value.guest, true);
  assert.equal(value.hostText, true);
  assert.equal(value.legacyShort, true, 'the historical short tail-marker shape stays truncated');
});

test('issue15-2: explainTruncation ignores mid-body mentions but keeps tail markers', () => {
  assert.equal(explainTruncation({ content: BODY }), null);
  assert.equal(explainTruncation(BODY, undefined), null);
  assert.equal(explainTruncation({ content: `${BODY}\n${MARKER} 1 char total` }), `in-band:${MARKER}`);
});

test('issue15-2: host fileTextFromRaw keeps the true truncation contract', () => {
  assert.equal(fileTextFromRaw({ content: BODY }).truncated, null, 'no evidence → null (unknown), not false');
  const truncated = fileTextFromRaw({ content: `${BODY}\n${MARKER} 10 chars` });
  assert.equal(truncated.truncated, true);
  assert.ok(truncated.truncation);
});

// ---------------------------------------------------------------------------
// 3. write-before gate: complete file is patchable; truncated read still stops
// ---------------------------------------------------------------------------

const PATCH = [
  '--- a/x.js',
  '+++ b/x.js',
  '@@ -1,2 +1,2 @@',
  '-# capture.js (synthetic 40KB body for the false-positive regression)',
  `+// patched header (file mentions ${MARKER} only as content)`,
  ' const BABEL_NEVER_USED = 1;',
  '',
].join('\n');

test('issue15-2: write gate accepts a complete 40KB file that mentions the marker', async () => {
  const patch = [
    '--- a/x.js',
    '+++ b/x.js',
    '@@ -1,1 +1,1 @@',
    '-# capture.js (synthetic 40KB body for the false-positive regression)',
    '+// patched header (file mentions the marker only as content)',
    '',
  ].join('\n');
  const { value, calls } = await evalCode(`
    return await codemode.applyFilePatch({
      owner: 'o', repo: 'r', path: 'x.js', patch: ${JSON.stringify(patch)}, dryRun: true,
    });
  `, { 'github::get_file_contents': () => textResult(BODY) });
  assert.equal(value.ok, true, value.error);
  assert.equal(value.diff.path, 'x.js');
  assert.deepEqual(calls.map((c) => c.tool), ['get_file_contents'], 'dryRun never writes');
  assert.ok(!String(value.error ?? '').includes('truncated'), 'must not be refused as truncated');
});

test('issue15-2: write gate still refuses a genuinely truncated read', async () => {
  const truncatedBody = `${BODY}\n${MARKER} 900 chars total`;
  const { value } = await evalCode(`
    return await codemode.applyFilePatch({
      owner: 'o', repo: 'r', path: 'x.js', patch: ${JSON.stringify(PATCH)}, dryRun: true,
    });
  `, { 'github::get_file_contents': () => textResult(truncatedBody) });
  assert.equal(value.ok, false);
  assert.match(String(value.error), /refusing to patch a truncated read/);
});
