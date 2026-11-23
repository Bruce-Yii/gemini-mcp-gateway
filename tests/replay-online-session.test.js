/**
 * Offline tests for scripts/replay-online-session.mjs.
 *
 * Covers: capture/fixture parsing, read-only replay, write dryRun enforcement,
 * diff classification (exactness/contract/truncation/path/id), not-comparable
 * marking for client-host fields, missing-identity policy (unknown, never
 * fabricated), and byte-level determinism. No network, no credentials, no real
 * writes, no src/ or repo-file modifications. No commit/push/deploy.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SCHEMA,
  UNKNOWN,
  DIFF_FIELDS,
  NOT_COMPARABLE_FIELDS,
  canonicalJson,
  extractSession,
  createFakeSession,
  isWriteTool,
  buildReplayPlan,
  replayPlan,
  classifyField,
  diffReplay,
  toJson,
  fakeResponse,
} from '../scripts/replay-online-session.mjs';

// ---------------------------------------------------------------------------
// Helpers: a minimal gmg.capture.v1 envelope per src/capture.js
// ---------------------------------------------------------------------------

const REQ_ID = '602f4012-8776-465d-8bb3-d9507ef2bd90';
const SESSION_ID = 'sess-abc';

function envelope(overrides = {}) {
  return {
    schema: 'gmg.capture.v1',
    ts: '2026-11-23T01:00:00.000Z',
    requestId: REQ_ID,
    sessionId: SESSION_ID,
    clientPlatform: 'gemini',
    clientProfile: 'gemini-text-json',
    oauthClientId: null,
    deployment: 'prod-old-2026-11-23',
    request: {
      method: 'POST',
      url: '/mcp',
      raw: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'execute_read',
          arguments: { code: 'async () => { return await codemode.github__get_file_contents({owner:"o",repo:"r",path:"p"}); }' },
        },
      }),
    },
    events: [
      {
        type: 'upstream',
        payload: {
          server: 'github',
          tool: 'get_file_contents',
          args: { owner: 'o', repo: 'r', path: 'p' },
          result: { content: [{ type: 'text', text: '{"ok":true,"path":"p"}' }] },
          durationMs: 12,
        },
      },
      {
        type: 'sandbox',
        payload: {
          tool: 'execute_read',
          code: 'async () => { return await codemode.github__get_file_contents({owner:"o",repo:"r",path:"p"}); }',
          output: { result: '{"ok":true}' },
        },
      },
    ],
    response: { status: 200, raw: '{"jsonrpc":"2.0","id":1,"result":{}}', bytes: 120, durationMs: 80 },
    model: { possibleModelTruncation: false },
    ...overrides,
  };
}

function toolsListEnvelope() {
  return envelope({
    ts: '2026-11-22T23:59:00.000Z',
    request: {
      method: 'POST',
      url: '/mcp',
      raw: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'tools/list', params: {} }),
    },
    events: [],
    response: {
      status: 200,
      raw: JSON.stringify({ result: { tools: [{ name: 'search' }, { name: 'execute_read' }, { name: 'execute' }] } }),
    },
  });
}

// ---------------------------------------------------------------------------
// 1. Parsing / extraction
// ---------------------------------------------------------------------------

test('extractSession: reads clientPlatform/profile/model/tools-list/requestId/sessionId/timeline from a real capture', () => {
  const session = extractSession([toolsListEnvelope(), envelope()]);
  assert.equal(session.schema, SCHEMA);
  assert.equal(session.source, 'capture');
  assert.equal(session.clientPlatform, 'gemini');
  assert.equal(session.clientProfile, 'gemini-text-json');
  assert.equal(session.sessionId, SESSION_ID);
  assert.deepEqual(session.requestIds, [REQ_ID, REQ_ID]);
  assert.equal(session.model, canonicalJson({ possibleModelTruncation: false }));
  assert.equal(session.prompts.length, 1);
  assert.match(session.prompts[0], /get_file_contents/);
  assert.deepEqual(
    session.toolsListSnapshot.map((t) => t.name),
    ['search', 'execute_read', 'execute'],
  );
  // Timeline is ordered by ts, not input order.
  assert.equal(session.timeline[0].method, 'tools/list');
  assert.equal(session.timeline[1].method, 'tools/call');
});

test('extractSession: captures each tool call name/args/result and never mutates the envelope', () => {
  const env = envelope();
  const before = canonicalJson(env);
  const session = extractSession([env]);
  assert.equal(canonicalJson(env), before, 'input envelope must stay byte-identical');
  assert.equal(session.toolCalls.length, 1);
  const call = session.toolCalls[0];
  assert.equal(call.name, 'github__get_file_contents');
  assert.deepEqual(call.args, { owner: 'o', repo: 'r', path: 'p' });
  assert.deepEqual(call.result, { content: [{ type: 'text', text: '{"ok":true,"path":"p"}' }] });
  assert.equal(call.isError, false);
});

test('extractSession: upstream error event is preserved, no fabricated result', () => {
  const env = envelope({
    events: [{
      type: 'upstream',
      payload: { server: 'github', tool: 'list_issues', args: { owner: 'o' }, error: { message: 'boom' } },
    }],
  });
  const session = extractSession([env]);
  assert.equal(session.toolCalls[0].isError, true);
  assert.deepEqual(session.toolCalls[0].result, { error: { message: 'boom' } });
});

test('extractSession: missing requestId/sessionId become unknown, never a generated UUID', () => {
  const env = envelope();
  delete env.requestId;
  delete env.sessionId;
  delete env.request.id;
  const session = extractSession([env]);
  assert.equal(session.sessionId, UNKNOWN);
  assert.ok(session.requestIds.every((id) => id === UNKNOWN));
  assert.ok(session.toolCalls.every((call) => call.requestId === UNKNOWN));
  assert.ok(!JSON.stringify(session).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i));
});

test('createFakeSession: deterministic fixture works without any real capture', () => {
  const a = createFakeSession();
  const b = createFakeSession();
  assert.equal(toJson(a), toJson(b));
  assert.equal(a.source, 'fixture');
  assert.equal(a.clientPlatform, 'gemini');
  assert.equal(a.sessionId, UNKNOWN);
  assert.deepEqual(a.requestIds, [UNKNOWN]);
  assert.ok(a.toolCalls.length >= 1);
});

// ---------------------------------------------------------------------------
// 2. Replay plan + read-only replay
// ---------------------------------------------------------------------------

test('buildReplayPlan: same prompt/args/client profile, read call stays read-only', () => {
  const session = createFakeSession({ includeWrite: false });
  const plan = buildReplayPlan(session);
  assert.equal(plan.clientPlatform, session.clientPlatform);
  assert.equal(plan.clientProfile, session.clientProfile);
  assert.deepEqual(plan.prompts, session.prompts);
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].mode, 'read-only');
  assert.equal(plan.steps[0].forRealWrite, false);
  assert.deepEqual(plan.steps[0].args, session.toolCalls[0].args);
});

test('replayPlan: read-only call is dispatched to injected upstream with same args', async () => {
  const plan = buildReplayPlan(createFakeSession({ includeWrite: false }));
  const calls = [];
  const output = await replayPlan(plan, {
    upstream: async (call) => { calls.push(call); return { content: [{ type: 'text', text: 'ok' }] }; },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'github__get_file_contents');
  assert.deepEqual(calls[0].args, plan.steps[0].args);
  assert.equal(output.steps[0].mode, 'read-only');
  assert.equal(output.steps[0].realWriteAttempted, false);
});

test('replayPlan: never calls network even when fetch is injected', async () => {
  const plan = buildReplayPlan(createFakeSession({ includeWrite: false }));
  let fetched = 0;
  const output = await replayPlan(plan, {
    fetch: async () => { fetched += 1; return fakeResponse({ ok: true }); },
  });
  assert.equal(fetched, 0, 'harness itself must never perform a fetch');
  assert.equal(output.steps.length, 1);
});

// ---------------------------------------------------------------------------
// 3. Write safety: dryRun default
// ---------------------------------------------------------------------------

test('isWriteTool: recognizes create/update/patch/push write names', () => {
  assert.equal(isWriteTool('github__create_or_update_file'), true);
  assert.equal(isWriteTool('github__push_files'), true);
  assert.equal(isWriteTool('github__applyFilePatch'), true);
  assert.equal(isWriteTool('github__get_file_contents'), false);
  assert.equal(isWriteTool('search'), false);
});

test('buildReplayPlan: write args get dryRun=true even if online recorded dryRun=false', () => {
  const session = createFakeSession();
  session.toolCalls[1].args.dryRun = false;
  const plan = buildReplayPlan(session);
  assert.equal(plan.steps[1].mode, 'dryRun');
  assert.equal(plan.steps[1].args.dryRun, true);
  assert.equal(plan.steps[1].forRealWrite, false);
  assert.equal(session.toolCalls[1].args.dryRun, false, 'session must not be mutated');
});

test('replayPlan: write tool is only executed with dryRun; real write attempt is flagged, not performed', async () => {
  const session = createFakeSession();
  session.toolCalls[1].args.forRealWrite = true; // malicious/broken upstream arg
  const plan = buildReplayPlan(session);
  const seen = [];
  const output = await replayPlan(plan, {
    upstream: async (call) => { seen.push(call); return { content: [{ type: 'text', text: 'simulated' }] }; },
  });
  const writeCall = seen.find((c) => c.name === 'github__create_or_update_file');
  assert.ok(writeCall, 'write must still be dispatched in dryRun mode');
  assert.equal(writeCall.args.dryRun, true);
  assert.equal(output.steps[1].mode, 'dryRun');
  assert.equal(output.steps[1].forRealWrite, false);
  assert.equal(output.steps[1].realWriteAttempted, true, 'upstream forRealWrite attempt must be recorded');
});

// ---------------------------------------------------------------------------
// 4. Diff classification
// ---------------------------------------------------------------------------

test('diffReplay: identical outputs classify fields as pass and verdict pass (no writes)', async () => {
  const session = createFakeSession({ includeWrite: false, withTruncation: true });
  const plan = buildReplayPlan(session);
  // Upstream returns the recorded result byte-for-byte: exactness should pass.
  const upstream = async (call) => plan.steps[call.index].recordedResult;
  const output = await replayPlan(plan, { upstream });
  const report = diffReplay(plan, output, { recorded: session });
  assert.equal(report.verdict, 'pass');
  const step = report.steps[0];
  for (const field of DIFF_FIELDS) {
    if (field === 'id') assert.equal(step.fields.find((f) => f.field === field).status, 'not-comparable');
    else if (field === 'path') assert.equal(step.fields.find((f) => f.field === field).status, 'not-comparable',
      'fixture result has no explicit path, so path must be honestly not-comparable');
    else assert.equal(step.fields.find((f) => f.field === field).status, 'pass', `${field} should pass`);
  }
  assert.deepEqual(Object.keys(report.counts).sort(), ['diff', 'not-comparable', 'pass']);
});

test('diffReplay: changed text yields exactness diff but contract still passes', () => {
  const plan = buildReplayPlan(createFakeSession({ includeWrite: false }));
  const output = {
    ...plan,
    steps: plan.steps.map((s) => ({
      ...s,
      result: { content: [{ type: 'text', text: '{"changed":true,"path":"other"}' }] },
    })),
  };
  const report = diffReplay(plan, output, { recorded: createFakeSession({ includeWrite: false }) });
  const fields = report.steps[0].fields;
  assert.equal(fields.find((f) => f.field === 'exactness').status, 'diff');
  assert.equal(fields.find((f) => f.field === 'contract').status, 'pass');
  assert.ok(['diff', 'partial'].includes(report.verdict));
});

test('classifyField: contract detects shape mismatch in replayed output', () => {
  const recorded = { content: [{ type: 'text', text: 'x' }] };
  const replayed = { structuredContent: { value: 1 } }; // no content[] -> broken contract
  const result = classifyField('contract', recorded, replayed);
  assert.equal(result.status, 'diff');
  assert.equal(result.recordedShapeOk, true);
  assert.equal(result.replayedShapeOk, false);
});

test('classifyField: truncation marker mismatch is a diff, matching marker is pass', () => {
  const truncated = { content: [{ type: 'text', text: 'abc\n--- TRUNCATED ---' }] };
  const clean = { content: [{ type: 'text', text: 'abc' }] };
  assert.equal(classifyField('truncation', truncated, clean).status, 'diff');
  assert.equal(classifyField('truncation', truncated, truncated).status, 'pass');
});

test('classifyField: path comparison works only when both sides expose a path', () => {
  assert.equal(classifyField('path', { path: 'p' }, { path: 'p' }).status, 'pass');
  assert.equal(classifyField('path', { path: 'p' }, { path: 'q' }).status, 'diff');
  assert.equal(classifyField('path', { a: 1 }, { b: 2 }).status, 'not-comparable');
});

test('classifyField: id is not-comparable when either side is unknown, no fabricated id', () => {
  const u = classifyField('id', UNKNOWN, UNKNOWN);
  assert.equal(u.status, 'not-comparable');
  assert.match(u.reason, /unknown/);
  assert.equal(classifyField('id', 'id-a', 'id-a').status, 'pass');
  assert.equal(classifyField('id', 'id-a', 'id-b').status, 'diff');
});

// ---------------------------------------------------------------------------
// 5. Not-comparable marking for client-host / model / timing
// ---------------------------------------------------------------------------

test('diffReplay: client-host fields are always marked not-comparable', () => {
  for (const field of ['clientPlatform', 'clientProfile', 'model', 'clientInfo', 'deployment', 'durationMs', 'responseBytes']) {
    assert.ok(NOT_COMPARABLE_FIELDS.includes(field) || ['clientPlatform', 'clientProfile'].includes(field),
      `${field} must be covered by the not-comparable policy`);
  }
  const session = createFakeSession({ includeWrite: false });
  const plan = buildReplayPlan(session);
  const report = diffReplay(plan, { ...plan, steps: [] }, { recorded: { ...session, model: 'gemini-2.5-pro' } });
  for (const row of report.context) {
    assert.equal(row.status, 'not-comparable', `${row.field} must be not-comparable`);
  }
  assert.match(report.notComparableNote, /Client host/);
});

test('classifyField: explicit notComparable overrides any equality', () => {
  const result = classifyField('exactness', { a: 1 }, { a: 1 }, { notComparable: true, reason: 'host effect' });
  assert.equal(result.status, 'not-comparable');
  assert.equal(result.reason, 'host effect');
});

test('diffReplay: dryRun write step cannot claim exactness against a real online write', () => {
  const session = createFakeSession();
  const plan = buildReplayPlan(session);
  const output = {
    ...plan,
    steps: plan.steps.map((s) => ({ ...s, result: s.recordedResult })),
  };
  const report = diffReplay(plan, output, { recorded: session });
  const writeStep = report.steps.find((s) => s.mode === 'dryRun');
  const exactness = writeStep.fields.find((f) => f.field === 'exactness');
  assert.equal(exactness.status, 'not-comparable');
  assert.match(exactness.reason, /dryRun/);
});

// ---------------------------------------------------------------------------
// 6. Determinism
// ---------------------------------------------------------------------------

test('determinism: extract -> plan -> replay -> diff is byte-identical across runs', async () => {
  async function run() {
    const session = extractSession([toolsListEnvelope(), envelope()]);
    const plan = buildReplayPlan(session);
    const output = await replayPlan(plan, {}); // deterministic offline stub
    return toJson({ session, plan, output, comparison: diffReplay(plan, output, { recorded: session }) });
  }
  const a = await run();
  const b = await run();
  assert.equal(a, b);
});

test('determinism: fake upstream yields identical JSON and no timestamps', async () => {
  const session = createFakeSession();
  const plan = buildReplayPlan(session);
  const upstream = async (call) => ({ content: [{ type: 'text', text: canonicalJson(call.args) }] });
  const one = toJson(await replayPlan(plan, { upstream }));
  const two = toJson(await replayPlan(plan, { upstream }));
  assert.equal(one, two);
  assert.ok(!/"(generatedAt|now|timestamp)"/.test(one), 'no wall-clock timestamps in replay output');
});
