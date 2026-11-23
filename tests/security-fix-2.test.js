/**
 * Batch 15 · second security-fix pass (deterministic, offline regression tests).
 *
 * Covers the five remaining findings in docs/eval/CODEMODE-SECURITY-AUDIT.md
 * that are in scope for this batch:
 *   F-01  model-visible error redaction (capture stays FULL-FIDELITY)
 *   F-03  truncation-audit poisoning via `"truncated": false`
 *   F-04  runTypedPlan / github_actions_* budget bypass
 *   F-06  `__bridge` direct reach + reserved tool identifiers / prototype
 *   F-07  fileText fallback silently reporting truncated:false
 *
 * No network, no credentials, no capture redaction assertions: the project
 * deliberately keeps capture verbatim (AGENTS.md §6, tests/capture.test.js).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { runInSandbox, fileTextFromRaw } from '../src/codemode.js';
import { redactSecrets, modelErrorMessage, unwrapResult } from '../src/tool-format.js';
import { buildModelOutputAudit } from '../src/capture.js';

const TOOL = {
  name: 'svc__get_file',
  server: 'svc',
  tool: 'get_file',
  annotations: { readOnlyHint: true },
  inputSchema: { type: 'object', properties: {} },
};
const textResult = (value) => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
});
const parsed = (out) => JSON.parse(out.result);
const guest = async (body, options = {}) => {
  const out = await runInSandbox({
    code: `async () => { ${body} }`,
    tools: options.tools ?? [TOOL],
    callTool: options.callTool ?? (async () => textResult({ ok: true })),
    ...(options.maxCalls !== undefined ? { maxCalls: options.maxCalls } : {}),
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.typedPlanIO !== undefined ? { typedPlanIO: options.typedPlanIO } : {}),
  });
  assert.ok(!out.isError, out.result);
  return parsed(out);
};

/* ------------------------------------------------------------------ *
 * F-01 · model-visible errors must not echo credential shapes
 * ------------------------------------------------------------------ */

test('F-01: redactSecrets covers Bearer / ghp_ / github_pat_ / xoxb / sk- / api keys', () => {
  const input = [
    'Authorization: Bearer ghp_LEAK123',
    'github_pat_ABCDEFG123',
    'xoxb-1234567890',
    'sk-abcdefgh12345678',
    'api_key=SECRETKEY123',
    'refresh_token=REFRESH123&scope=repo',
    'token: gho_OTHERSECRET',
  ].join(' | ');
  const safe = redactSecrets(input);
  for (const secret of ['ghp_LEAK123', 'github_pat_ABCDEFG123', 'xoxb-1234567890',
    'sk-abcdefgh12345678', 'SECRETKEY123', 'REFRESH123', 'gho_OTHERSECRET']) {
    assert.ok(!safe.includes(secret), `secret leaked: ${secret}`);
  }
  // Labels survive so the error stays actionable; redaction is stable/idempotent.
  assert.match(safe, /Authorization: Bearer \[REDACTED\]/);
  assert.equal(redactSecrets(safe), safe);
  assert.match(safe, /api_key=\[REDACTED\]/);
  assert.equal(redactSecrets('plain error text'), 'plain error text');
});

test('F-01: upstream error via sandbox bridge is redacted for the model', async () => {
  const result = await guest(
    `try { await codemode.svc__get_file({}); return 'NO_ERROR'; }
     catch (e) { return { msg: e.message, host: e.__dshHostOrigin }; }`,
    {
      callTool: async () => {
        throw new Error('upstream failed: Bearer ghp_SUPERSECRET123 / github_pat_ANOTHER999');
      },
    },
  );
  assert.notEqual(result.msg, 'NO_ERROR');
  assert.equal(result.host, true, 'error still reconstructs as a host-origin guest Error');
  assert.ok(!result.msg.includes('ghp_SUPERSECRET123'));
  assert.ok(!result.msg.includes('github_pat_ANOTHER999'));
  assert.match(result.msg, /\[REDACTED\]/);
  assert.match(result.msg, /upstream failed:/); // structure/prefix preserved
});

test('F-01: unwrapResult isError text is redacted without changing throw semantics', () => {
  const raw = { isError: true, content: [{ type: 'text', text: 'denied: token ghp_UNWRAP123' }] };
  assert.throws(
    () => unwrapResult(raw),
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /^denied: token \[REDACTED\]$/);
      assert.ok(!err.message.includes('ghp_UNWRAP123'));
      return true;
    },
  );
  // The input envelope (the same object capture observes) is never mutated.
  assert.equal(raw.content[0].text, 'denied: token ghp_UNWRAP123');
});

test('F-01: modelErrorMessage prefers a precomputed redacted projection', () => {
  const err = new Error('RAW ghp_ORIGINAL123');
  Object.defineProperty(err, 'modelMessage', { value: 'RAW [REDACTED]', enumerable: false });
  assert.equal(modelErrorMessage(err), 'RAW [REDACTED]');
  assert.equal(err.message, 'RAW ghp_ORIGINAL123', 'raw capture message stays untouched');
  assert.equal(modelErrorMessage(new Error('Bearer xoxb-999')), 'Bearer [REDACTED]');
  assert.equal(modelErrorMessage('sk-abcdefgh12345678'), '[REDACTED]');
});

test('F-01: final execute-error output redacts secrets in result and error fields', async () => {
  const out = await runInSandbox({
    code: "async () => { throw new Error('boom api_key=CALLERSECRET999'); }",
    tools: [], callTool: async () => ({}),
  });
  assert.equal(out.status, 'error');
  assert.ok(!out.result.includes('CALLERSECRET999'));
  assert.ok(!out.error.message.includes('CALLERSECRET999'));
  assert.match(out.result, /^execute error: boom api_key=\[REDACTED\]/);
});

/* ------------------------------------------------------------------ *
 * F-03 · truncation audit must ignore upstream `truncated:false` text
 * ------------------------------------------------------------------ */

const FULL = 'A'.repeat(1000);
const upstreamSource = { type: 'upstream', payload: { server: 'svc', tool: 'get_file', result: FULL } };
const sandboxOutput = (result, extra = {}) => ({
  type: 'sandbox',
  payload: { tool: 'execute_read', output: { result, ...extra } },
});
const short = FULL.slice(0, 150);

test('F-03: prose "truncated: false" can no longer suppress a real silent-truncation finding', () => {
  const audit = buildModelOutputAudit({ events: [upstreamSource, sandboxOutput(`${short} truncated: false`)] });
  assert.equal(audit.sourceBytes, 1000);
  assert.equal(audit.modelOutputBytes, short.length + ' truncated: false'.length);
  assert.equal(audit.possibleModelTruncation, true);
});

test('F-03: JSON {"truncated":false} anywhere in the visible text is not a truncation mark', () => {
  const audit = buildModelOutputAudit({
    events: [upstreamSource, sandboxOutput(JSON.stringify({ body: short, truncated: false, nested: { truncated: false } }))],
  });
  assert.equal(audit.possibleModelTruncation, true);
});

test('F-03: explicit truncated:true still clears the finding (boolean and nested envelope)', () => {
  const flag = buildModelOutputAudit({ events: [upstreamSource, sandboxOutput(short, { truncated: true })] });
  assert.equal(flag.possibleModelTruncation, false);
  const structured = buildModelOutputAudit({
    events: [upstreamSource, sandboxOutput(JSON.stringify({ text: short, truncated: true }))],
  });
  assert.equal(structured.possibleModelTruncation, false);
  const responseRaw = buildModelOutputAudit({
    events: [upstreamSource, sandboxOutput(short)],
    response: { truncated: true },
  });
  assert.equal(responseRaw.possibleModelTruncation, false);
});

test('F-03: fixed wire markers still count; unrelated prose does not', () => {
  const inBand = buildModelOutputAudit({ events: [upstreamSource, sandboxOutput(`${short} --- TRUNCATED ---`)] });
  assert.equal(inBand.possibleModelTruncation, false);
  const bracket = buildModelOutputAudit({ events: [upstreamSource, sandboxOutput(`${short}…[truncated 850]`)] });
  assert.equal(bracket.possibleModelTruncation, false);
  const prose = buildModelOutputAudit({ events: [upstreamSource, sandboxOutput(`${short} the file was not truncated at all`)] });
  assert.equal(prose.possibleModelTruncation, true);
});

/* ------------------------------------------------------------------ *
 * F-04 · runTypedPlan / github_actions_* must consume the tool budget
 * ------------------------------------------------------------------ */

const readTool = {
  name: 'github__get_file_contents',
  server: 'github',
  tool: 'get_file_contents',
  annotations: { readOnlyHint: true },
  inputSchema: { type: 'object', properties: {} },
};

test('F-04: runTypedPlan counts each upstream invoke against maxCalls', async () => {
  const calls = [];
  const plan = [1, 2, 3].map((n) => ({ op: 'readFileRange', path: `f${n}.txt`, startLine: 1, endLine: 2 }));
  const result = await guest(
    `const r = await codemode.runTypedPlan(${JSON.stringify(plan)});
     const succeeded = r.steps.filter((s) => s.ok).length;
     return { ok: r.ok, stoppedAt: r.stoppedAt, error: r.error, executed: succeeded };`,
    {
      tools: [readTool],
      maxCalls: 2,
      callTool: async (server, tool, args) => {
        calls.push(args.path);
        return textResult({ text: 'line1\nline2', sha: 's' });
      },
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.stoppedAt, 2, 'third step fails');
  assert.equal(result.executed, 2, 'only two steps ran');
  assert.ok(result.error.includes('TOOL_CALL_LIMIT_EXCEEDED'));
  assert.match(result.error, /tool call limit \(2\) exceeded/);
  assert.deepEqual(calls, ['f1.txt', 'f2.txt'], 'no third upstream call escaped the budget');
});

test('F-04: remainingCalls reflects typed-plan budget consumption', async () => {
  const result = await guest(
    `const before = codemode.remainingCalls();
     await codemode.runTypedPlan([{op:'readFileRange',path:'f.txt',startLine:1,endLine:1}]);
     return { before, after: codemode.remainingCalls() };`,
    { tools: [readTool], maxCalls: 3 },
  );
  assert.equal(result.before, 3);
  assert.equal(result.after, 2);
});

test('F-04: custom typedPlanIO cannot bypass the budget', async () => {
  let invoked = 0;
  const out = await runInSandbox({
    code: `async () => {
      const r = await codemode.runTypedPlan([
        {op:'readFileRange',path:'a',startLine:1,endLine:1},
        {op:'readFileRange',path:'b',startLine:1,endLine:1},
      ]);
      return { ok:r.ok, error:r.error, executed:r.steps.filter((s) => s.ok).length };
    }`,
    tools: [], callTool: async () => ({}), maxCalls: 1,
    typedPlanIO: {
      readFileRange: async (args) => { invoked += 1; return { text: 'x', truncated: false }; },
    },
  });
  assert.ok(!out.isError, out.result);
  const result = parsed(out);
  assert.equal(result.ok, false);
  assert.match(result.error, /tool call limit \(1\) exceeded/);
  assert.equal(result.executed, 1);
  assert.equal(invoked, 1, 'the over-budget adapter method never ran');
});

test('F-04: github_actions_* consumes the budget with a stable error and code', async () => {
  let fetches = 0;
  const result = await guest(
    `const out = [];
     for (let i = 0; i < 3; i++) {
       try { await codemode.github_actions_list_workflow_runs({owner:'o',repo:'r'}); out.push('ok'); }
       catch (e) { out.push({ error: e.message, code: e.code, host: e.__dshHostOrigin }); }
     }
     return { out, remaining: codemode.remainingCalls() };`,
    {
      tools: [], maxCalls: 2,
      env: { GITHUB_TOKEN: 'fake-test-token-not-a-real-credential' },
      fetch: async () => { fetches += 1; return { ok: true, status: 200, json: async () => ({ workflow_runs: [] }) }; },
    },
  );
  assert.deepEqual(result.out.slice(0, 2), ['ok', 'ok']);
  assert.equal(result.out[2].error, 'tool call limit (2) exceeded');
  assert.equal(result.out[2].code, 'TOOL_CALL_LIMIT_EXCEEDED');
  assert.equal(result.out[2].host, true);
  assert.equal(result.remaining, 0);
  assert.equal(fetches, 2, 'no third REST call escaped the budget');
});

test('F-04: v1 typed-plan step count is capped at 64 (host-side)', async () => {
  const plan = Array.from({ length: 65 }, (_, i) => ({ op: 'readFileRange', path: `f${i}`, startLine: 1, endLine: 1 }));
  const result = await guest(
    `const r = await codemode.runTypedPlan(${JSON.stringify(plan)});
     return { ok:r.ok, error:r.error, executed:r.meta.executedCount };`,
    { tools: [readTool], maxCalls: 100 },
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /TYPED_PLAN_TOO_MANY_STEPS|exceeds 64 steps/);
  assert.equal(result.executed, 0);
});

/* ------------------------------------------------------------------ *
 * F-06 · bridge exposure and reserved tool identifiers
 * ------------------------------------------------------------------ */

test('F-06: __bridge is not reachable from guest', async () => {
  const result = await guest(
    `return {
       type: typeof __bridge,
       value: __bridge === undefined,
       invokeProbe: (() => { try { return typeof __bridge.invoke; } catch (_) { return 'throws'; } })(),
       normalTool: typeof codemode.svc__get_file,
     };`,
  );
  assert.equal(result.type, 'undefined');
  assert.equal(result.value, true);
  assert.equal(result.invokeProbe, 'throws');
  assert.equal(result.normalTool, 'function');
});

test('F-06: reserved tool names cannot replace the codemode prototype or shadow helpers', async () => {
  const hostile = [
    { name: '__proto__', server: 'evil', tool: 'proto', inputSchema: { type: 'object', properties: {} } },
    { name: 'constructor', server: 'evil', tool: 'ctor', inputSchema: { type: 'object', properties: {} } },
    { name: '__dshInvoke', server: 'evil', tool: 'invoke', inputSchema: { type: 'object', properties: {} } },
    TOOL,
  ];
  const result = await guest(
    `return {
       protoIntact: Object.getPrototypeOf(codemode) === Object.prototype,
       protoOwn: Object.prototype.hasOwnProperty.call(codemode, '__proto__'),
       ctorSafe: typeof codemode.constructor === 'undefined',
       invokeOwn: Object.prototype.hasOwnProperty.call(codemode, '__dshInvoke'),
       normalTool: typeof codemode.svc__get_file,
     };`,
    { tools: hostile },
  );
  assert.equal(result.protoIntact, true);
  assert.equal(result.protoOwn, false);
  assert.equal(result.ctorSafe, true, 'constructor is hidden, never a callable upstream tool');
  assert.equal(result.invokeOwn, false);
  assert.equal(result.normalTool, 'function');
});

test('F-06: removing the raw bridge does not break normal codemode capabilities', async () => {
  // Even with __bridge hidden, every documented helper still routes through the
  // renamed bridge successfully and keeps its original shape.
  const result = await guest(
    `return {
       call: typeof codemode.svc__get_file,
       list: Array.isArray(codemode.listTools()),
       search: typeof codemode.search,
       remaining: codemode.remainingCalls(),
     };`,
  );
  assert.equal(result.call, 'function');
  assert.equal(result.list, true);
  assert.equal(result.search, 'function');
  assert.equal(result.remaining, 50);
});

/* ------------------------------------------------------------------ *
 * F-07 · fileText fallback must not silently claim truncated:false
 * ------------------------------------------------------------------ */

test('F-07: fileText helper detects an in-band marker on the fallback shape', () => {
  const parsedFile = fileTextFromRaw({ text: 'partial --- TRUNCATED ---', sha: 's' });
  assert.equal(parsedFile.text, 'partial --- TRUNCATED ---');
  assert.equal(parsedFile.truncated, true);
  assert.match(String(parsedFile.truncation), /TRUNCATED/);
});

test('F-07: fileText fallback with no truncation evidence reports unknown (null), not false', () => {
  const parsedFile = fileTextFromRaw({ text: 'full body', sha: 's' });
  assert.equal(parsedFile.text, 'full body');
  assert.equal(parsedFile.truncated, null, 'null = unknown; never a silent false');
  assert.equal(parsedFile.truncation, undefined);
  const noText = fileTextFromRaw({});
  assert.equal(noText.text, null);
  assert.equal(noText.truncated, null, 'missing text is unknown, not complete');
});

test('F-07: explicit upstream truncated:true still wins in fileText', () => {
  assert.equal(fileTextFromRaw({ text: 'short body', sha: 's', truncated: true }).truncated, true);
  assert.equal(fileTextFromRaw({ result: { text: 'short body', truncated: true } }).truncated, true);
});

test('F-07: typed-plan readFileRange propagates the truncation signal to callers', async () => {
  const result = await guest(
    `const r = await codemode.runTypedPlan([{op:'readFileRange',path:'x.txt',startLine:1,endLine:1}]);
     return { ok: r.ok, truncated: r.steps[0].result.truncated };`,
    {
      tools: [readTool],
      callTool: async () => textResult({ text: 'partial --- TRUNCATED ---', sha: 's' }),
    },
  );
  assert.equal(result.ok, true);
  assert.equal(result.truncated, true, 'a truncated read is never reported complete');
});
