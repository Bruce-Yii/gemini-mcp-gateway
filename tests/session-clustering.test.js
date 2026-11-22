/**
 * Batch 11 — online capture session/window clustering + offline join.
 *
 * Covers the W3 remaining item rules:
 *   1. envelope.sessionId wins and groups directly;
 *   2. without sessionId, initialize / 15-min idle split into windows;
 *   3. requests from different windows never mix;
 *   4. join is explicit-taskId-only with matched/unmatched;
 *   5. deterministic: same input -> same output across repeated runs.
 *
 * All inputs are inline fixtures; no R2, no network, no client/SDK.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assignWindows, digestSessions, sessionIdOf, mcpMethodOf, clientInfoOf,
  DEFAULT_IDLE_MS,
} from '../scripts/capture-digest.mjs';
import { joinOnlineToOffline, taskIdOf, attachTaskAnchors } from '../scripts/join-online-offline.mjs';

/** Minimal capture envelope fixture (only fields clustering/readers consume). */
function env({
  id = `req-${Math.random()}`,
  ts = '2026-11-22T10:00:00.000Z',
  method = 'tools/call',
  sessionId = null,
  clientInfo = null,
  clientIp = null,
  status = 200,
  raw = '{}',
  truncated = false,
  modelTruncated = false,
  taskId = null,
  headers = {},
} = {}) {
  const h = { ...headers };
  if (clientIp) h['x-forwarded-for'] = clientIp;
  return {
    schema: 'gmg.capture.v1',
    ts,
    requestId: id,
    sessionId,
    ...(clientInfo ? { clientInfo } : {}),
    ...(taskId ? { taskId } : {}),
    request: {
      method: 'POST',
      url: '/mcp',
      headers: h,
      raw: method ? JSON.stringify({ jsonrpc: '2.0', method, params: { name: 'github__get_file' } }) : 'not-json',
    },
    response: {
      status,
      raw,
      bytes: raw.length,
      durationMs: 10,
      ...(truncated ? { truncated: true } : {}),
    },
    ...(modelTruncated ? { model: { possibleModelTruncation: true } } : {}),
    events: [],
  };
}

const T0 = '2026-11-22T10:00:00.000Z';
const T1 = '2026-11-22T10:05:00.000Z';
const T2 = '2026-11-22T10:14:59.000Z'; // < 15 min after T0
const T3 = '2026-11-22T10:30:01.000Z'; // > 15 min after previous request (T2)

// -------------------------------------------------------------------------
// Rule 1: sessionId is the primary grouping key
// -------------------------------------------------------------------------
test('sessionId groups directly and never gets overridden', () => {
  const envelopes = [
    env({ id: 'a', ts: T0, sessionId: 'sess-A', method: 'initialize' }),
    env({ id: 'b', ts: T3, sessionId: 'sess-A' }), // long gap: same session stays together
    env({ id: 'c', ts: T1, sessionId: 'sess-B' }),
  ];
  const result = assignWindows(envelopes);
  const byId = Object.fromEntries(result.map((e) => [e.requestId, e]));

  assert.equal(byId.a.windowId, 'session:sess-A');
  assert.equal(byId.b.windowId, 'session:sess-A');
  assert.equal(byId.c.windowId, 'session:sess-B');
  assert.equal(byId.a.sessionId, 'sess-A'); // original untouched
  assert.equal(byId.a.requestId, 'a');
  assert.equal(byId.a.windowStrategy, 'sessionId');
});

test('sessionId wins over request headers and request.raw echo', () => {
  const envelope = env({ id: 'x', sessionId: 'top-level' });
  envelope.request.headers['mcp-session-id'] = 'header-value';
  envelope.request.sessionId = 'request-value';
  assert.equal(sessionIdOf(envelope), 'top-level');
  assert.equal(assignWindows([envelope])[0].windowId, 'session:top-level');
});

// -------------------------------------------------------------------------
// Rule 2: no sessionId -> initialize opens a window; idle > 15 min splits
// -------------------------------------------------------------------------
test('no sessionId: initialize opens a new window', () => {
  const envelopes = [
    env({ id: 'a', ts: T0, method: 'tools/call' }),
    env({ id: 'b', ts: T1, method: 'initialize' }), // explicit boundary
    env({ id: 'c', ts: T1, method: 'tools/call' }),
  ];
  const byId = Object.fromEntries(assignWindows(envelopes).map((e) => [e.requestId, e]));
  assert.equal(byId.a.windowId, 'window:001');
  assert.equal(byId.b.windowId, 'window:002');
  assert.equal(byId.c.windowId, 'window:002');
  assert.equal(byId.b.windowStrategy, 'initialize');
});

test('no sessionId: idle gap > 15 minutes opens a new window, exactly 15 does not', () => {
  const gapEnvelopes = [
    env({ id: 'a', ts: T0 }),
    env({ id: 'b', ts: '2026-11-22T10:14:59.000Z' }), // 14m59s
    env({ id: 'c', ts: T3 }), // 15m02s from previous
  ];
  const byId = Object.fromEntries(assignWindows(gapEnvelopes).map((e) => [e.requestId, e]));
  assert.equal(byId.a.windowId, 'window:001');
  assert.equal(byId.b.windowId, 'window:001');
  assert.equal(byId.c.windowId, 'window:002');
  assert.equal(byId.c.windowStrategy, 'idle-gap');
  assert.equal(DEFAULT_IDLE_MS, 900000);

  const exact = assignWindows([
    env({ id: 'a', ts: T0 }),
    env({ id: 'b', ts: '2026-11-22T10:15:00.000Z' }), // exactly 15 min -> NOT split
  ]);
  assert.equal(exact[1].windowId, 'window:001');
});

test('no initialize: first request opens a legacy window', () => {
  const result = assignWindows([
    env({ id: 'a', ts: T0, method: 'tools/call' }),
    env({ id: 'b', ts: T1, method: 'tools/call' }),
  ]);
  assert.equal(result[0].windowStrategy, 'first-request');
  assert.equal(result[1].windowStrategy, 'continued');
  assert.equal(result[0].windowId, result[1].windowId);
});

test('tools/list refresh and clientInfo / IP changes do not split a window', () => {
  const envelopes = [
    env({ id: 'a', ts: T0, method: 'tools/list', clientInfo: { name: 'gemini', version: '1' }, clientIp: '10.0.0.1' }),
    env({ id: 'b', ts: T1, method: 'tools/list', clientInfo: { name: 'inspector', version: '2' }, clientIp: '10.0.0.2' }),
    env({ id: 'c', ts: T2, method: 'tools/call', clientInfo: { name: 'gemini', version: '3' }, clientIp: '10.0.0.3' }),
  ];
  const result = assignWindows(envelopes);
  assert.equal(new Set(result.map((e) => e.windowId)).size, 1, 'auxiliary signals never split');
  assert.ok(result[0].windowMeta.auxiliarySignals.includes('tools-list-refresh'));
  assert.deepEqual(clientInfoOf(envelopes[0]), { name: 'gemini', version: '1' });
  assert.deepEqual(clientInfoOf(envelopes[1]), { name: 'inspector', version: '2' });
  // tools/list counts as an mcp method but not a tool call.
  const digest = digestSessions(envelopes);
  assert.equal(digest.length, 1);
  assert.equal(digest[0].methods['tools/list'], 2);
  assert.equal(digest[0].methods['tools/call'], 1);
  assert.equal(digest[0].toolCalls, 1);
});

// -------------------------------------------------------------------------
// Rule 3: cross-window never mixes; digest preserves counters and requestIds
// -------------------------------------------------------------------------
test('cross-window requests never mix in the digest', () => {
  const envelopes = [
    env({ id: 'a', ts: T0, method: 'initialize' }),
    env({ id: 'b', ts: T1, raw: '{"error":"validation: missing field"}', status: 400 }),
    env({ id: 'c', ts: '2026-11-22T10:20:00.000Z', method: 'initialize' }),
    env({ id: 'd', ts: '2026-11-22T10:21:00.000Z', truncated: true }),
    env({ id: 'e', ts: '2026-11-22T10:22:00.000Z', modelTruncated: true }),
  ];
  const digest = digestSessions(envelopes);
  assert.equal(digest.length, 2);
  const [w1, w2] = digest;
  assert.deepEqual(w1.requestIdSamples, ['a', 'b']);
  assert.deepEqual(w2.requestIdSamples, ['c', 'd', 'e']);
  assert.equal(w1.mcpErrors, 1);
  assert.equal(w1.truncationSuspects, 0);
  assert.equal(w2.mcpErrors, 0);
  assert.equal(w2.truncationSuspects, 2, 'wire truncation + model truncation counted');
  assert.equal(w1.firstTs, T0);
  assert.equal(w1.lastTs, T1);
  // Identity fields are never overwritten; windowId is additive only.
  assert.equal(assignWindows(envelopes).find((e) => e.requestId === 'a').sessionId, null);
  assert.equal(assignWindows(envelopes).find((e) => e.requestId === 'a').requestId, 'a');
});

test('digest toolCalls counts only tools/call', () => {
  const digest = digestSessions([
    env({ id: 'a', ts: T0, method: 'tools/call' }),
    env({ id: 'b', ts: T1, method: 'tools/list' }),
    env({ id: 'c', ts: T2, method: 'ping' }), // kept in same window: no initialize
  ]);
  assert.equal(digest.length, 1);
  assert.equal(digest[0].toolCalls, 1);
  assert.equal(digest[0].requests, 3);
  assert.equal(digest[0].mcpRequests, 3);
});

// -------------------------------------------------------------------------
// Rule 4: join matched / unmatched, explicit taskId only
// -------------------------------------------------------------------------
test('join maps by explicit taskId and marks windows without one unmatched', () => {
  const windows = [
    { windowId: 'session:s1', sessionId: 's1', taskId: 'T001', requestIdSamples: ['a'], requests: 3 },
    { windowId: 'session:s2', sessionId: 's2', taskId: 'T999', requestIdSamples: ['b'], requests: 2 },
    { windowId: 'window:003', sessionId: null, taskId: null, requestIdSamples: ['c'], requests: 1 },
  ];
  const tasks = [
    { id: 'T001', server: 'github', tool: 'get_file', prompt: 'Read README.md', source: 'unit' },
    { id: 'T002', server: 'notion', tool: 'search', prompt: 'Search docs', source: 'unit' },
  ];
  const result = joinOnlineToOffline({ windows, tasks });

  assert.equal(result.matched.length, 1);
  assert.equal(result.matched[0].offlineTaskId, 'T001');
  assert.equal(result.matched[0].windowId, 'session:s1');
  assert.equal(result.matched[0].online.requestIdSamples[0], 'a');
  assert.equal(result.matched[0].offline.server, 'github');

  assert.equal(result.unmatched.length, 2);
  assert.deepEqual(
    result.unmatched.map((u) => u.reason).sort(),
    ['no-offline-task', 'no-online-taskId'],
  );
  assert.equal(result.unmatched.find((u) => u.reason === 'no-online-taskId').windowId, 'window:003');
  assert.equal(result.unmatched.find((u) => u.reason === 'no-offline-task').onlineTaskId, 'T999');

  // Offline tasks without an online anchor are listed, never force-paired.
  assert.deepEqual(result.offlineOnly.map((t) => t.taskId), ['T002']);
  assert.equal(result.summary.matched, 1);
  assert.equal(result.summary.unmatched, 2);
  assert.match(result.summary.policy, /explicit-taskId-only/);
});

test('join never guesses a task from prompt/tool/timestamp similarity', () => {
  const windows = [
    { windowId: 'session:s1', sessionId: 's1', taskId: null, requestIdSamples: ['a'], requests: 1 },
  ];
  const tasks = [
    { id: 'T001', server: 'github', tool: 'get_file', prompt: 'Read README.md', source: 'unit' },
  ];
  const result = joinOnlineToOffline({ windows, tasks });
  assert.equal(result.matched.length, 0);
  assert.equal(result.unmatched[0].reason, 'no-online-taskId');
  assert.equal(result.offlineOnly.length, 1);
});

test('taskIdOf accepts explicit locations only and attachTaskAnchors flows into join', () => {
  const envelope = env({ id: 'a', taskId: 'T-A' });
  assert.equal(taskIdOf(envelope), 'T-A');
  const wrapped = { windowId: 'session:s', envelope };
  assert.equal(taskIdOf(wrapped), null); // no direct field
  const anchored = attachTaskAnchors([wrapped], [{ id: 'T-A' }]);
  assert.equal(anchored[0].taskId, 'T-A');
  const result = joinOnlineToOffline({ windows: anchored, tasks: [{ id: 'T-A' }] });
  assert.equal(result.matched.length, 1);
  assert.equal(result.matched[0].onlineTaskId, 'T-A');
});

test('digest rows preserve explicit taskId for join', () => {
  const digest = digestSessions([
    env({ id: 'a', ts: T0, taskId: 'T1', sessionId: 's1' }),
    env({ id: 'b', ts: T1, taskId: 'T1', sessionId: 's1' }),
  ]);
  assert.equal(digest[0].taskId, 'T1');
  const result = joinOnlineToOffline({ windows: digest, tasks: [{ id: 'T1' }] });
  assert.equal(result.matched.length, 1);
});

test('digest records conflicting taskIds inside one window', () => {
  const digest = digestSessions([
    env({ id: 'a', ts: T0, taskId: 'T1' }),
    env({ id: 'b', ts: T1, taskId: 'T2' }),
  ]);
  assert.equal(digest[0].taskIdConflicts, true);
});

// -------------------------------------------------------------------------
// Rule 5: determinism — same input, same output across repeated runs
// -------------------------------------------------------------------------
test('clustering and digest are deterministic across repeated runs', () => {
  const envelopes = [
    env({ id: 'c', ts: '2026-11-22T10:20:00.000Z', method: 'initialize' }),
    env({ id: 'a', ts: T0, method: 'initialize' }),
    env({ id: 'b', ts: T1 }),
    env({ id: 'd', ts: '2026-11-22T10:21:00.000Z' }),
    env({ id: 'e', ts: '2026-11-22T10:22:00.000Z', sessionId: 'sess-Z' }),
  ];
  const runOnce = () => ({
    windows: assignWindows(envelopes).map((e) => ({
      requestId: e.requestId, windowId: e.windowId, strategy: e.windowStrategy,
    })),
    digest: digestSessions(envelopes),
  });
  const first = JSON.stringify(runOnce());
  for (let i = 0; i < 4; i += 1) {
    assert.equal(JSON.stringify(runOnce()), first, `run ${i + 2} must match run 1`);
  }
  // Input array is not mutated (no windowId leaked back onto raw envelopes).
  assert.ok(envelopes.every((e) => !('windowId' in e)));
  assert.ok(envelopes.every((e) => !('_windowSortIndex' in e)));
});

test('join output is deterministic across repeated runs', () => {
  const windows = [
    { windowId: 'session:s1', sessionId: 's1', taskId: 'T001', requestIdSamples: ['a'] },
    { windowId: 'window:002', sessionId: null, taskId: null, requestIdSamples: ['b'] },
  ];
  const tasks = [{ id: 'T001', server: 'github', tool: 'get_file', prompt: 'Read file' }];
  const once = JSON.stringify(joinOnlineToOffline({ windows, tasks }));
  for (let i = 0; i < 3; i += 1) {
    assert.equal(JSON.stringify(joinOnlineToOffline({ windows, tasks })), once);
  }
});

test('mcpMethodOf returns null for non-JSON bodies without throwing', () => {
  assert.equal(mcpMethodOf(env({ method: null })), null);
  assert.equal(mcpMethodOf(env({ method: 'tools/call' })), 'tools/call');
});
