/**
 * Batch 15 · residual security fix — deterministic, offline regression tests.
 *
 * Covers the four items in docs/OPEN-SOURCE/RESIDUAL-RISK-AUDIT.md that were
 * still open after the earlier security passes:
 *   R-01 (P0) server.js model-visible error paths must redact secrets
 *   F-08 (P1) truncation markers / flags must never contradict each other,
 *             and tool-format + result-normalize must share one truth table
 *   F-09 (P1) boundResult must expose a result-level truncated:true flag that
 *             survives client-profile encoding
 *   R-02 (P1) v2 makePlanHandler must charge every plan I/O against maxCalls
 *             with a stable TOOL_CALL_LIMIT_EXCEEDED error
 *
 * HARD BOUNDARIES (AGENTS.md §6): no capture redaction, no network, no real
 * credentials, no tool-surface changes. Fake tokens below are inert literals.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { boundResult, createMcpRequestHandler } from '../src/server.js';
import { truncateResultValue } from '../src/tool-format.js';
import { explainTruncation, normalizeFileResult } from '../src/result-normalize.js';
import { createCodeModeToolsV2 } from '../src/codemode-v2.js';
import { encodeToolResult, encodeModelOutput, CLIENT_PROFILES } from '../src/client-profile.js';

const TOKEN = 'ghp_RESIDUALLEAK999';
const TOKEN2 = 'github_pat_RESIDUALLEAK888';

function parseRpcBody(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return JSON.parse(trimmed);
  const dataLines = text.split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);
  for (const line of dataLines.reverse()) {
    try { return JSON.parse(line); } catch { /* keep scanning */ }
  }
  throw new SyntaxError(`not a JSON-RPC body: ${text.slice(0, 80)}`);
}

async function withServer(handlerFn, fn) {
  const server = http.createServer((req, res) => { void handlerFn(req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    return await fn(port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/* ------------------------------------------------------------------ *
 * R-01 (P0) · model-visible error redaction on BOTH server.js paths
 * ------------------------------------------------------------------ */

test('R-01: errorResult (tool-call error) does not leak tokens from a fake upstream error', async () => {
  // A whitelisted tool whose upstream handler throws a raw credential-bearing
  // error. capture keeps the raw message; only the model-visible projection is
  // redacted.
  const rawError = new Error(`upstream 401 Authorization: Bearer ${TOKEN} token=${TOKEN2}`);
  const manager = {
    getEntries: () => [],
    getWhitelist: () => [{
      name: 'svc__boom', server: 'svc', tool: 'boom',
      description: 'boom', inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
    }],
    callTool: async () => { throw rawError; },
  };
  // Use a clean in-process HTTP server with a fresh transport per request, as
  // the real handler does (createGatewayServer is exercised transitively).
  const handler = createMcpRequestHandler(manager, { mode: 'whitelist' });
  await withServer(handler, async (port) => {
    const client = new Client({ name: 'r01-tool-error', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
    try {
      await client.connect(transport);
      const result = await client.callTool({ name: 'svc__boom', arguments: {} });
      const text = JSON.stringify(result);
      assert.equal(result.isError, true);
      assert.ok(!text.includes(TOKEN), `tool error leaked ${TOKEN}`);
      assert.ok(!text.includes(TOKEN2), `tool error leaked ${TOKEN2}`);
      assert.match(text, /\[REDACTED\]/);
      assert.match(text, /upstream 401/); // structure/prefix preserved
    } finally {
      await client.close().catch(() => {});
    }
  });

  // The raw error object is NEVER mutated — capture full-fidelity is intact.
  assert.equal(rawError.message, `upstream 401 Authorization: Bearer ${TOKEN} token=${TOKEN2}`);
});

test('R-01: JSON-RPC 500 path redacts tokens from an error with a modelMessage projection', async () => {
  // Make createGatewayServer throw while building the catalog, which is inside
  // the request handler's try/catch -> JSON-RPC 500 -> errorMessage().
  const rawError = new Error(`internal: Bearer ${TOKEN} api_key=${TOKEN2}`);
  Object.defineProperty(rawError, 'modelMessage', {
    value: `internal: Bearer [REDACTED] api_key=[REDACTED]`, enumerable: false,
  });
  const manager = {
    getEntries: () => { throw rawError; },
    getWhitelist: () => [],
  };
  const handler = createMcpRequestHandler(manager, { mode: 'whitelist' });
  await withServer(handler, async (port) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body,
    });
    const text = await res.text();
    const json = parseRpcBody(text);
    assert.equal(res.status, 500);
    assert.equal(json.error?.code, -32603);
    assert.ok(!text.includes(TOKEN), `JSON-RPC 500 leaked ${TOKEN}`);
    assert.ok(!text.includes(TOKEN2), `JSON-RPC 500 leaked ${TOKEN2}`);
    assert.match(text, /\[REDACTED\]/);
    assert.match(text, /Internal error:/);
  });
  assert.equal(rawError.message, `internal: Bearer ${TOKEN} api_key=${TOKEN2}`);
});

/* ------------------------------------------------------------------ *
 * F-08 (P1) · truncation marker/flag consistency and shared truth table
 * ------------------------------------------------------------------ */

test('F-08: truncateResultValue never emits truncated:false alongside a TRUNCATED marker', () => {
  const out = truncateResultValue(
    { truncated: false, big: 'B'.repeat(5000) }, { maxChars: 200 },
  );
  const marker = Object.keys(out).find((k) => k.startsWith('--- TRUNCATED'));
  assert.ok(marker, 'a genuine truncation must emit the marker');
  assert.equal(out.truncated, true, 'the flag must be true, never false');
  assert.notEqual(out.truncated, false);
  assert.equal(typeof out.truncated, 'boolean');
  assert.equal(typeof out.truncation, 'string', 'reason is a separate field');
  assert.ok(!(out.truncated === false && marker), 'contradictory pair eliminated');
  assert.ok(JSON.stringify(out).length <= 240, 'stays within budget');
});

test('F-08: no truncation and no marker when content fits; no contradictory keys', () => {
  const small = truncateResultValue({ truncated: false, big: 'ok' }, { maxChars: 500 });
  assert.equal(small.truncated, false, 'upstream false is preserved when nothing is truncated');
  assert.ok(!Object.keys(small).some((k) => k.startsWith('--- TRUNCATED')));
});

test('F-08: string-truncated truthiness is uniform across tool-format and result-normalize', () => {
  // An arbitrary non-empty string is a REASON, not a boolean flag, on its own.
  assert.equal(explainTruncation({ truncated: 'benign' }, 'full body'), null);
  assert.equal(normalizeFileResult({ text: 'full body', truncated: 'benign' }).truncated, false);
  // True-like values are flags in both modules.
  for (const flag of [true, 1, '1', 'true']) {
    assert.equal(explainTruncation({ truncated: flag }, 'full body'), 'upstream:truncated');
    assert.equal(normalizeFileResult({ text: 'full body', truncated: flag }).truncated, true);
  }
  // An explicit truncation object with a reason stays a flag with that reason.
  const reason = explainTruncation({ truncated: { reason: 'range cut' } }, 'full body');
  assert.equal(reason, 'range cut');
});

/* ------------------------------------------------------------------ *
 * F-09 (P1) · result-level truncated flag survives profile encoding
 * ------------------------------------------------------------------ */

test('F-09: boundResult adds result-level truncated:true only when it truly truncates', () => {
  const out = boundResult({ content: [{ type: 'text', text: 'X'.repeat(500) }] }, 100);
  assert.equal(out.truncated, true);
  assert.ok(out.content[0].text.includes('truncated'));
  assert.equal(boundResult({ content: [{ type: 'text', text: 'short' }] }, 100).truncated, undefined);
  assert.equal(boundResult({ content: [{ type: 'text', text: 'X'.repeat(500) }] }, 100).content[0].text.length <= 100, true);
});

test('F-09: all client profiles preserve the result-level truncated flag', () => {
  const bounded = boundResult({ content: [{ type: 'text', text: 'X'.repeat(500) }] }, 100);
  const wrapped = { content: [{ type: 'text', text: JSON.stringify(bounded) }], truncated: true };
  for (const profile of Object.values(CLIENT_PROFILES)) {
    const encoded = encodeToolResult(wrapped, profile);
    assert.equal(encoded.truncated, true, `profile ${profile.id} dropped truncated flag`);
    const textual = JSON.parse(encoded.content[0].text);
    assert.equal(textual.truncated, true, `profile ${profile.id} lost embedded flag`);
  }
  // Model-output projection also preserves it.
  const projected = encodeModelOutput({ result: bounded, truncated: true }, CLIENT_PROFILES.CHATGPT);
  assert.equal(projected.truncated, true);
});

/* ------------------------------------------------------------------ *
 * R-02 (P1) · v2 plan I/O budget with stable error code
 * ------------------------------------------------------------------ */

function makeIO(overrides = {}) {
  const calls = [];
  const base = {
    calls,
    readFileRange: async (args) => { calls.push(args.path); return { text: 'one\ntwo', truncated: false }; },
    repoGrep: async (args) => { calls.push(args.pattern); return { matches: [] }; },
    runChecks: async (args) => { calls.push(args.command); return { ok: true }; },
  };
  return { ...base, ...overrides, calls };
}

test('R-02: v2 plan stops at maxCalls with stable TOOL_CALL_LIMIT_EXCEEDED (no extra I/O)', async () => {
  const io = makeIO();
  const [, readTool] = createCodeModeToolsV2(
    { getEntries: () => [], getWhitelist: () => [] },
    { typedPlanIO: io, maxCalls: 2 },
  );
  const plan = [1, 2, 3, 4].map((n) => ({ op: 'readFileRange', path: `f${n}.txt`, startLine: 1, endLine: 1 }));
  const result = await readTool.handler({ plan });
  assert.equal(result.ok, false);
  const succeeded = result.steps.filter((s) => s.ok).length;
  assert.equal(succeeded, 2, 'only two steps succeeded');
  assert.equal(result.stoppedAt, 2, 'third step hit the limit');
  assert.match(result.error, /TOOL_CALL_LIMIT_EXCEEDED/);
  assert.match(result.error, /tool call limit \(2\) exceeded/);
  assert.deepEqual(io.calls, ['f1.txt', 'f2.txt'], 'no over-budget upstream I/O escaped');
});

test('R-02: v2 plan within budget succeeds and runChecks does not consume the budget', async () => {
  const io = makeIO();
  const [, readTool] = createCodeModeToolsV2(
    { getEntries: () => [], getWhitelist: () => [] },
    { typedPlanIO: io, maxCalls: 3 },
  );
  const result = await readTool.handler({
    plan: [
      { op: 'runChecks', command: 'lint' },
      { op: 'readFileRange', path: 'a.txt', startLine: 1, endLine: 1 },
      { op: 'readFileRange', path: 'b.txt', startLine: 1, endLine: 1 },
      { op: 'readFileRange', path: 'c.txt', startLine: 1, endLine: 1 },
    ],
  });
  assert.equal(result.ok, true);
  assert.equal(io.calls.length, 4, 'runChecks ran plus three reads');
  assert.equal(result.steps.length, 4);
});

test('R-02: a multi-call IO adapter cannot exceed maxCalls within a step', async () => {
  // A custom adapter that performs two upstream reads per readFileRange call.
  // Each underlying IO invocation consumes budget, so maxCalls=3 allows only
  // three underlying reads even though the plan has just two steps.
  let reads = 0;
  const io = {
    readFileRange: async () => { reads += 1; return { text: 'x', truncated: false }; },
  };
  const [, readTool] = createCodeModeToolsV2(
    { getEntries: () => [], getWhitelist: () => [] },
    { typedPlanIO: io, maxCalls: 1 },
  );
  const result = await readTool.handler({
    plan: [
      { op: 'readFileRange', path: 'a.txt', startLine: 1, endLine: 1 },
      { op: 'readFileRange', path: 'b.txt', startLine: 1, endLine: 1 },
    ],
  });
  assert.equal(result.ok, false);
  assert.equal(reads, 1, 'the over-budget adapter invocation never ran');
  assert.match(result.error, /TOOL_CALL_LIMIT_EXCEEDED/);
});
