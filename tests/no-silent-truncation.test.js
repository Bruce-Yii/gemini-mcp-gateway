/**
 * P0 · No silent truncation of line data (batch 11).
 *
 * Evidence: capture requestIds
 *   363fd3e7-a9ff-44b7-b2f0-c1e4c27329b6
 *   21896fe1-da1c-4682-93b9-1c8c53f5405c
 * Model code used `l.slice(0, 150)`; the gateway response was complete
 * (711/779 bytes, overflow:false) and carried no `truncated` marker.
 *
 * These tests are deterministic: fake upstreams only, no network, no secrets.
 * They pin the contract that the gateway never silently drops characters and
 * always reports truncation when it happens.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { runInSandbox } from '../src/codemode.js';
import {
  explainTruncation,
  normalizeFileResult,
} from '../src/result-normalize.js';
import {
  applyFilePatch,
  applyTextPatch,
} from '../src/file-write.js';

const READ_TOOL = {
  server: 'fake',
  tool: 'get_file_contents',
  name: 'fake__get_file_contents',
  description: 'read a file',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
};

const LONG_LINE = `const label = '${'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.repeat(6)}'; // ${'tail-marker-'.repeat(8)}END`;

function sandbox(resultExpr, callTool = async () => ({}), opts = {}) {
  return runInSandbox({
    code: `async () => (${resultExpr})`,
    tools: opts.tools ?? [],
    callTool,
    ...opts.run,
  });
}

function parse(out) {
  assert.ok(!out.isError, out.result);
  return JSON.parse(out.result);
}

// ---------------------------------------------------------------------------
// 1. Long lines are never character-truncated by default
// ---------------------------------------------------------------------------

test('readFileRange: a >150-char line is returned character-for-character with no maxCharsPerLine', async () => {
  assert.ok(LONG_LINE.length > 150, `fixture line is ${LONG_LINE.length} chars`);
  const text = `header\n${LONG_LINE}\nfooter`;
  const out = await sandbox(
    `codemode.readFileRange({path:'src/long.js', startLine:1, endLine:3, tools:{readTool:'fake__get_file_contents'}})`,
    async () => ({ content: text, sha: 'abc', size: text.length }),
    { tools: [READ_TOOL] },
  );
  const r = parse(out);
  assert.deepEqual(r.lines, ['header', LONG_LINE, 'footer']);
  assert.equal(r.lines[1].length, LONG_LINE.length);
  assert.equal(r.lines[1], LONG_LINE, 'line must be identical, not l.slice(0,150)');
  assert.equal(r.truncated, false);
  assert.equal(r.nextStart, null);
  assert.equal(r.totalLines, 3);
  assert.equal(r.truncation, undefined, 'no truncation reason when nothing was cut');
});

test('sliceLines (legacy) also preserves long lines verbatim', async () => {
  const out = await sandbox(`codemode.sliceLines(${JSON.stringify(`a\n${LONG_LINE}\nb`)}, 1, 3)`);
  const r = parse(out);
  assert.equal(r.text, `a\n${LONG_LINE}\nb`);
  assert.equal(r.truncated, false);
});

// ---------------------------------------------------------------------------
// 2. Explicit maxCharsPerLine is opt-in, marked, and reports a reason
// ---------------------------------------------------------------------------

test('readFileRange: maxCharsPerLine truncates explicitly with truncated:true and a reason', async () => {
  const text = `short\n${LONG_LINE}\nalso short`;
  const out = await sandbox(
    `codemode.readFileRange({path:'src/long.js', startLine:1, endLine:3, maxCharsPerLine:150, tools:{readTool:'fake__get_file_contents'}})`,
    async () => ({ content: text, sha: 'abc', size: text.length }),
    { tools: [READ_TOOL] },
  );
  const r = parse(out);
  assert.equal(r.truncated, true);
  assert.equal(r.lines[0], 'short');
  assert.equal(r.lines[1].length, 150);
  assert.equal(r.lines[1], LONG_LINE.slice(0, 150));
  assert.equal(r.lines[2], 'also short');
  assert.ok(r.truncation, 'truncation reason must be present');
  assert.equal(r.truncation.reason, 'maxCharsPerLine');
  assert.equal(r.truncation.maxCharsPerLine, 150);
  assert.deepEqual(r.truncation.lines, [2], '1-based line numbers that were cut');
  assert.match(r.truncation.detail, /maxCharsPerLine/);
});

test('readFileRange: maxCharsPerLine=0 or negative is rejected instead of silently cutting everything', async () => {
  for (const bad of [0, -1, 'abc']) {
    const out = await sandbox(
      `codemode.readFileRange({path:'x', startLine:1, endLine:1, maxCharsPerLine:${JSON.stringify(bad)}, tools:{readTool:'fake__get_file_contents'}})`,
      async () => ({ content: 'one\ntwo' }),
      { tools: [READ_TOOL] },
    );
    const r = parse(out);
    assert.equal(r.ok, false, `bad maxCharsPerLine=${JSON.stringify(bad)}`);
    assert.match(r.error, /maxCharsPerLine/);
  }
});

// ---------------------------------------------------------------------------
// 3. Line-range clipping is explicit; nextStart points at the unread line
// ---------------------------------------------------------------------------

test('readFileRange: line range clipping sets truncated + reason + nextStart', async () => {
  const text = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n');
  const out = await sandbox(
    `codemode.readFileRange({path:'x', startLine:2, endLine:4, tools:{readTool:'fake__get_file_contents'}})`,
    async () => ({ content: text }),
    { tools: [READ_TOOL] },
  );
  const r = parse(out);
  assert.deepEqual(r.lines, ['line 2', 'line 3', 'line 4']);
  assert.equal(r.totalLines, 10);
  assert.equal(r.truncated, true);
  assert.equal(r.truncation.reason, 'lineRange');
  assert.equal(r.truncation.omittedBefore, 1);
  assert.equal(r.truncation.omittedAfter, 6);
  assert.equal(r.nextStart, 5);
});

test('readFileRange: reading the whole file yields nextStart:null and no truncation', async () => {
  const out = await sandbox(
    `codemode.readFileRange({path:'x', startLine:1, tools:{readTool:'fake__get_file_contents'}})`,
    async () => ({ content: 'a\nb\nc' }),
    { tools: [READ_TOOL] },
  );
  const r = parse(out);
  assert.deepEqual(r.lines, ['a', 'b', 'c']);
  assert.equal(r.nextStart, null);
  assert.equal(r.truncated, false);
});

// ---------------------------------------------------------------------------
// 4. Upstream truncation is surfaced, never mistaken for complete content
// ---------------------------------------------------------------------------

test('readFileRange: upstream truncated flag is propagated with a reason', async () => {
  const out = await sandbox(
    `codemode.readFileRange({path:'x', startLine:1, endLine:2, tools:{readTool:'fake__get_file_contents'}})`,
    // structuredContent is the one envelope unwrapResult() preserves with the
    // sibling `truncated` metadata intact.
    async () => ({ structuredContent: { content: 'a\nb', truncated: true, truncation: { reason: 'upstream byte cap' } } }),
    { tools: [READ_TOOL] },
  );
  const r = parse(out);
  assert.equal(r.truncated, true);
  assert.equal(r.truncation.reason, 'upstream');
  assert.match(r.truncation.detail, /upstream byte cap/);
});

test('readFileRange: in-band TRUNCATED marker is propagated', async () => {
  const out = await sandbox(
    `codemode.readFileRange({path:'x', startLine:1, endLine:3, tools:{readTool:'fake__get_file_contents'}})`,
    async () => ({ content: 'a\nb\n--- TRUNCATED --- 900 chars total' }),
    { tools: [READ_TOOL] },
  );
  const r = parse(out);
  assert.equal(r.truncated, true);
  assert.equal(r.truncation.reason, 'upstream');
});

test('explainTruncation: nested and string flags are recognized (no silent drop)', () => {
  assert.equal(explainTruncation({ result: { content: 'x', truncated: true } }), 'upstream:truncated');
  assert.equal(explainTruncation({ content: 'x', truncated: 'true' }), 'upstream:truncated');
  assert.equal(explainTruncation({ content: 'x', truncation: { reason: 'byte cap' } }), 'byte cap');
  assert.equal(
    explainTruncation({ content: 'abc--- TRUNCATED --- 100 chars total' }),
    'in-band:--- TRUNCATED ---',
  );
  assert.equal(explainTruncation({ content: 'ok' }), null);
  assert.equal(normalizeFileResult({ result: { content: 'x', truncated: true } }).truncated, true);
});

// ---------------------------------------------------------------------------
// 5. Four result shapes — no silent character loss anywhere in the pipeline
// ---------------------------------------------------------------------------

// Each shape has two views: the value a host adapter sees, and the MCP envelope
// the gateway actually receives from an upstream (which unwrapResult() turns
// into the former before normalizeFile sees it).
const SHAPES = [
  ['JSON text',
    () => JSON.stringify({ content: LONG_LINE }),
    () => ({ content: [{ type: 'text', text: JSON.stringify({ content: LONG_LINE }) }] })],
  ['resources',
    () => ({ resources: [{ uri: 'repo://x', text: LONG_LINE }] }),
    () => ({ content: [{ type: 'resource', resource: { uri: 'repo://x', text: LONG_LINE } }] })],
  ['content array',
    () => ({ content: [
      { type: 'text', text: 'successfully downloaded text file (SHA: abcdef123456)' },
      { type: 'resource', resource: { uri: 'repo://x', text: LONG_LINE } },
    ] }),
    () => ({ content: [
      { type: 'text', text: 'successfully downloaded text file (SHA: abcdef123456)' },
      { type: 'resource', resource: { uri: 'repo://x', text: LONG_LINE } },
    ] })],
  ['file result',
    () => ({ content: LONG_LINE, sha: 's', size: LONG_LINE.length, encoding: 'utf-8', path: 'x.js' }),
    () => ({ content: [{ type: 'text', text: JSON.stringify({ content: LONG_LINE, sha: 's', size: LONG_LINE.length, encoding: 'utf-8', path: 'x.js' }) }] })],
];

for (const [name, makeHostValue, makeEnvelope] of SHAPES) {
  test(`shape "${name}": normalizeFileResult keeps every character of the long line`, () => {
    const out = normalizeFileResult(makeHostValue());
    assert.equal(out.content, LONG_LINE, `${name} lost characters`);
    assert.equal(out.content.length, LONG_LINE.length);
    assert.equal(out.truncated, false);
  });

  test(`shape "${name}": readFileRange keeps every character of the long line`, async () => {
    const out = await sandbox(
      `codemode.readFileRange({path:'x', startLine:1, endLine:1, tools:{readTool:'fake__get_file_contents'}})`,
      async () => makeEnvelope(),
      { tools: [READ_TOOL] },
    );
    const r = parse(out);
    assert.deepEqual(r.lines, [LONG_LINE]);
    assert.equal(r.lines[0].length, LONG_LINE.length);
    assert.equal(r.truncated, false);
  });
}

// ---------------------------------------------------------------------------
// 6. grepSnippet must mark its char window instead of silently cutting lines
// ---------------------------------------------------------------------------

test('grepSnippet: a clipped snippet reports truncated:true and a reason', async () => {
  const out = await sandbox(
    `codemode.grepSnippet(${JSON.stringify(LONG_LINE)}, 'tail-marker', 40)`,
  );
  const r = parse(out);
  assert.ok(r.length > 0);
  for (const snippet of r) {
    assert.ok(snippet.text.length <= 40);
    assert.equal(snippet.truncated, true, 'every clipped window must be marked');
    assert.equal(snippet.truncation.reason, 'grepWindow');
    assert.equal(snippet.fullLength, LONG_LINE.length);
  }
});

// ---------------------------------------------------------------------------
// 7. applyFilePatch refuses to write when the read was truncated
// ---------------------------------------------------------------------------

test('host applyFilePatch: in-band TRUNCATED marker in read result stops before write', async () => {
  const partial = 'one\ntwo\n--- TRUNCATED --- 900 chars total';
  const writes = [];
  const r = await applyFilePatch({
    read: async () => partial,
    write: async (p, t) => { writes.push([p, t]); },
    path: 'x.js',
    patch: '@@ -1,1 +1,1 @@\n-one\n+ONE\n',
    dryRun: false,
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /truncated/i);
  assert.equal(writes.length, 0, 'must never write a patch built on truncated input');
});

test('sandbox applyFilePatch: upstream truncated read stops before write', async () => {
  const calls = [];
  const out = await runInSandbox({
    code: `async () => codemode.applyFilePatch({
      path:'x.js', dryRun:false,
      tools:{readTool:'fake__get_file_contents', writeTool:'fake__write_file'},
      owner:'o', repo:'r',
      patch:'@@ -1,1 +1,1 @@\\n-one\\n+ONE\\n'
    })`,
    tools: [READ_TOOL, {
      server: 'fake', tool: 'write_file', name: 'fake__write_file',
      description: 'write a file', inputSchema: { type: 'object', properties: {} },
    }],
    callTool: async (server, tool) => {
      calls.push(tool);
      if (tool === 'get_file_contents') return { content: [{ type: 'text', text: 'one\ntwo\n--- TRUNCATED --- 900 chars total' }] };
      return { ok: true };
    },
  });
  const r = parse(out);
  assert.equal(r.ok, false);
  assert.match(r.error, /truncated/i);
  assert.equal(calls.filter((c) => c === 'write_file').length, 0);
});

test('applyTextPatch still applies a clean patch unchanged (no regression)', () => {
  const r = applyTextPatch('one\ntwo\n', '@@ -1,1 +1,1 @@\n-one\n+ONE\n');
  assert.equal(r.ok, true);
  assert.equal(r.text, 'ONE\ntwo\n');
});

// ---------------------------------------------------------------------------
// 8. Guidance is present in the model-facing description
// ---------------------------------------------------------------------------

test('execute tool description forbids l.slice(0,150) and points to readFileRange', async () => {
  const { createCodeModeTools } = await import('../src/codemode.js');
  const tools = createCodeModeTools({ getEntries: () => [], failedServers: [] }, { mode: 'codemode' });
  const desc = tools.find((t) => t.name === 'execute').description;
  assert.match(desc, /readFileRange/);
  assert.match(desc, /slice\(0,\s*150\)/);
  assert.match(desc, /substring\(0,\s*N\)/);
  assert.match(desc, /truncated/);
  assert.match(desc, /NO SILENT CHARACTER TRUNCATION/);
  // execute_read shares the same guidance suffix.
  const readDesc = tools.find((t) => t.name === 'execute_read').description;
  assert.match(readDesc, /readFileRange/);
});
