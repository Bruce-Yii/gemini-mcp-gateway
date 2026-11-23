import test from 'node:test';
import assert from 'node:assert/strict';

import {
  aggregateEnvelopes,
  renderScorecard,
  digestSessions,
  digestProjects,
  clientPlatformOf,
  clientProfileOf,
  oauthClientIdOf,
  CLIENT_PLATFORMS,
  UNKNOWN_PLATFORM,
} from '../scripts/capture-digest.mjs';

import {
  runConformance,
  platformOf,
  isDualEncoded,
  checkGeminiNoStructuredContent,
  checkChatgptDualEncoding,
  checkClaudeAnnotations,
  checkStableToolsList,
  renderReport,
  EXPECTED_TOOLS,
} from '../scripts/platform-conformance.mjs';

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const PAYLOAD = { ok: true, n: 1 };

/** Capture-style envelope with an explicit platform (or none for legacy). */
function env({
  id = 'req-1',
  platform,
  profile,
  oauthClientId,
  method = 'tools/call',
  result,
  status = 200,
  truncated = false,
  modelSuspect = false,
  sessionId = null,
  projects,
  ts = '2026-11-23T03:00:00.000Z',
  tool = 'github__get_file_contents',
} = {}) {
  const e = {
    requestId: id,
    ts,
    ...(platform !== undefined ? { clientPlatform: platform } : {}),
    ...(profile !== undefined ? { clientProfile: profile } : {}),
    ...(oauthClientId !== undefined ? { oauthClientId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(projects !== undefined ? { projects } : {}),
    request: {
      method: 'POST',
      url: '/mcp',
      raw: JSON.stringify(method ? { jsonrpc: '2.0', id: 1, method, params: { name: tool } } : {}),
    },
    response: {
      status,
      durationMs: 5,
      bytes: 20,
      raw: JSON.stringify(result === undefined ? { jsonrpc: '2.0', result: { content: [{ type: 'text', text: JSON.stringify(PAYLOAD) }] } } : { jsonrpc: '2.0', result }),
      ...(truncated ? { truncated: true } : {}),
    },
    ...(modelSuspect ? { model: { possibleModelTruncation: true } } : {}),
  };
  return e;
}

const annotatedTools = EXPECTED_TOOLS.map((name, i) => ({
  name,
  inputSchema: { type: 'object' },
  annotations: { readOnlyHint: i !== 0, destructiveHint: i === 0 },
}));

/* ------------------------------------------------------------------ *
 * 1. platform field readers (explicit / closed set / no guessing)
 * ------------------------------------------------------------------ */

test('clientPlatformOf accepts only explicit canonical values', () => {
  assert.equal(clientPlatformOf({ clientPlatform: 'gemini' }), 'gemini');
  assert.equal(clientPlatformOf({ clientPlatform: 'chatgpt' }), 'chatgpt');
  assert.equal(clientPlatformOf({ clientPlatform: 'claude' }), 'claude');
  // Tolerant of case/whitespace, but never guesses.
  assert.equal(clientPlatformOf({ clientPlatform: ' ChatGPT ' }), 'chatgpt');
});

test('clientPlatformOf maps missing/null/non-string/unknown to unknown', () => {
  assert.equal(clientPlatformOf({}), UNKNOWN_PLATFORM);
  assert.equal(clientPlatformOf({ clientPlatform: null }), UNKNOWN_PLATFORM);
  assert.equal(clientPlatformOf({ clientPlatform: 42 }), UNKNOWN_PLATFORM);
  assert.equal(clientPlatformOf({ clientPlatform: '' }), UNKNOWN_PLATFORM);
  assert.equal(clientPlatformOf({ clientPlatform: 'mystery' }), UNKNOWN_PLATFORM);
  // A UA header or client name never becomes a platform here.
  assert.equal(clientPlatformOf({ request: { headers: { 'user-agent': 'Claude-Desktop/1' } } }), UNKNOWN_PLATFORM);
  assert.deepEqual([...CLIENT_PLATFORMS], ['gemini', 'chatgpt', 'claude']);
});

test('clientProfileOf / oauthClientIdOf read canonical fields without inference', () => {
  assert.equal(clientProfileOf({ clientProfile: 'gemini-text-json' }), 'gemini-text-json');
  assert.equal(clientProfileOf({ clientProfile: 'chatgpt-structured' }), 'chatgpt-structured');
  assert.equal(clientProfileOf({ clientProfile: 'claude-text' }), 'claude-text');
  assert.equal(clientProfileOf({ clientProfile: 'gemini' }), UNKNOWN_PLATFORM); // not a profile label
  assert.equal(clientProfileOf({}), UNKNOWN_PLATFORM);
  assert.equal(oauthClientIdOf({ oauthClientId: 'client-abc' }), 'client-abc');
  assert.equal(oauthClientIdOf({ oauthClientId: null }), null);
  assert.equal(oauthClientIdOf({}), null);
});

/* ------------------------------------------------------------------ *
 * 2. digest grouping — no cross-platform pollution
 * ------------------------------------------------------------------ */

test('digest groups requests into gemini/chatgpt/claude buckets independently', () => {
  const metrics = aggregateEnvelopes([
    env({ id: 'g1', platform: 'gemini' }),
    env({ id: 'g2', platform: 'gemini', status: 500 }),
    env({ id: 'c1', platform: 'chatgpt' }),
    env({ id: 'cl1', platform: 'claude' }),
  ]);
  assert.equal(metrics.byClientPlatform.gemini.requests, 2);
  assert.equal(metrics.byClientPlatform.gemini.errors, 1);
  assert.equal(metrics.byClientPlatform.chatgpt.requests, 1);
  assert.equal(metrics.byClientPlatform.chatgpt.errors, 0);
  assert.equal(metrics.byClientPlatform.claude.requests, 1);
  assert.equal(metrics.byClientPlatform.claude.errors, 0);
  assert.equal(metrics.byClientPlatform[UNKNOWN_PLATFORM], undefined, 'no unknown bucket when all tagged');
  assert.deepEqual(metrics.platformSummary.map((r) => r.platform), ['gemini', 'chatgpt', 'claude']);
});

test('legacy envelopes (no platform fields) land in unknown only', () => {
  const metrics = aggregateEnvelopes([
    env({ id: 'old1' }), // no clientPlatform at all
    env({ id: 'old2', platform: null }),
    env({ id: 'old3', platform: 'nonsense' }),
    env({ id: 'g1', platform: 'gemini' }),
  ]);
  assert.equal(metrics.byClientPlatform[UNKNOWN_PLATFORM].requests, 3);
  assert.equal(metrics.byClientPlatform.gemini.requests, 1);
  // Old envelopes never inflate a platform bucket.
  assert.equal(metrics.byClientPlatform.gemini.toolCalls, 1);
  assert.deepEqual(metrics.platformSummary.at(-1).platform, UNKNOWN_PLATFORM);
});

test('per-platform toolCalls/errors/truncationSuspects are counted separately', () => {
  const metrics = aggregateEnvelopes([
    env({ id: 'g1', platform: 'gemini' }),
    env({ id: 'g2', platform: 'gemini', method: 'tools/list' }),
    env({ id: 'g3', platform: 'gemini', status: 400, truncated: true }),
    env({ id: 'c1', platform: 'chatgpt', modelSuspect: true }),
  ]);
  const g = metrics.byClientPlatform.gemini;
  assert.equal(g.requests, 3);
  assert.equal(g.mcpRequests, 3);
  assert.equal(g.toolCalls, 2, 'only tools/call counts as a tool call (g1 + g3)');
  assert.equal(g.errors, 1);
  assert.equal(g.truncationSuspects, 1, 'wire truncation counts as suspect');
  const c = metrics.byClientPlatform.chatgpt;
  assert.equal(c.truncationSuspects, 1, 'model-side silent truncation counts as suspect');
  assert.equal(c.errors, 0);
});

test('platformSummary carries sessions/projects counts from explicit ids/tags', () => {
  const metrics = aggregateEnvelopes([
    env({ id: 'g1', platform: 'gemini', sessionId: 's1', projects: [{ key: 'github:a/b' }] }),
    env({ id: 'g2', platform: 'gemini', sessionId: 's1', projects: [{ key: 'github:a/b' }] }),
    env({ id: 'g3', platform: 'gemini', sessionId: 's2', projects: [{ key: 'github:c/d' }] }),
  ]);
  const g = metrics.platformSummary.find((r) => r.platform === 'gemini');
  assert.equal(g.sessions, 2);
  assert.equal(g.projects, 2);
  assert.deepEqual(g.requestIdSamples, ['g1', 'g2', 'g3']);
});

test('sessions and projects carry the platform dimension', () => {
  const envelopes = [
    env({ id: 'g1', platform: 'gemini', sessionId: 's1', projects: [{ key: 'github:a/b' }] }),
    env({ id: 'c1', platform: 'chatgpt', sessionId: 's2', projects: [{ key: 'github:a/b' }] }),
  ];
  const sessions = digestSessions(envelopes);
  assert.ok(sessions.every((s) => Array.isArray(s.clientPlatforms)));
  const s1 = sessions.find((s) => s.sessionId === 's1');
  const s2 = sessions.find((s) => s.sessionId === 's2');
  assert.deepEqual(s1.clientPlatforms, ['gemini']);
  assert.deepEqual(s2.clientPlatforms, ['chatgpt']);
  assert.equal(s1.requestsByClientPlatform.gemini, 1);

  const { byProject } = digestProjects(envelopes);
  assert.deepEqual(byProject[0].clientPlatforms, ['gemini', 'chatgpt'],
    'one project may span platforms, listed explicitly not guessed');
});

test('scorecard renders a per-platform table and keeps legacy sections', () => {
  const md = renderScorecard('2026-11-23', aggregateEnvelopes([
    env({ id: 'g1', platform: 'gemini' }),
    env({ id: 'c1', platform: 'chatgpt' }),
    env({ id: 'old1' }),
  ]));
  assert.match(md, /## By client platform \(batch 13\)/);
  assert.match(md, /\| Platform \| Requests \| MCP requests \| Errors \| Tool calls \| Trunc suspects \| Sessions \| Projects \|/);
  assert.match(md, /\| gemini \| 1 \| 1 \| 0 \| 1 \| 0 \| 0 \| 0 \|/);
  assert.match(md, /\| chatgpt \| 1 \| 1 \| 0 \| 1 \| 0 \| 0 \| 0 \|/);
  assert.match(md, /\| unknown \| 1 \| 1 \| 0 \| 1 \| 0 \| 0 \| 0 \|/);
  // Legacy sections still present.
  assert.match(md, /# Capture Scorecard — 2026-11-23/);
  assert.match(md, /## Projects \(derived labels, batch 11\)/);
  assert.match(md, /Raw payloads remain in R2/);
});

/* ------------------------------------------------------------------ *
 * 3. conformance — per-scenario pass/fail/unknown with evidence
 * ------------------------------------------------------------------ */

test('conformance: dual encoding detector requires sc + matching text JSON', () => {
  assert.equal(isDualEncoded({ structuredContent: PAYLOAD, content: [{ type: 'text', text: JSON.stringify(PAYLOAD) }] }), true);
  assert.equal(isDualEncoded({ content: [{ type: 'text', text: JSON.stringify(PAYLOAD) }] }), false, 'no structuredContent');
  assert.equal(isDualEncoded({ structuredContent: PAYLOAD }), false, 'no text JSON');
  assert.equal(isDualEncoded({ structuredContent: { different: 1 }, content: [{ type: 'text', text: JSON.stringify(PAYLOAD) }] }), false, 'mismatch');
  assert.equal(isDualEncoded(null), false);
});

test('conformance: all four scenarios pass with good fixtures', () => {
  const result = runConformance([
    env({ id: 'g-txt', platform: 'gemini', method: 'tools/call', result: { content: [{ type: 'text', text: JSON.stringify(PAYLOAD) }] } }),
    env({ id: 'c-dual', platform: 'chatgpt', method: 'tools/call', result: { structuredContent: PAYLOAD, content: [{ type: 'text', text: JSON.stringify(PAYLOAD) }] } }),
    env({ id: 'cl-list', platform: 'claude', method: 'tools/list', result: { tools: annotatedTools } }),
    env({ id: 'g-list', platform: 'gemini', method: 'tools/list', result: { tools: annotatedTools } }),
  ]);
  assert.equal(result.status, 'pass');
  assert.deepEqual(result.checks.map((c) => c.status), ['pass', 'pass', 'pass', 'pass']);
  assert.ok(result.checks.every((c) => c.evidence.length > 0), 'every check cites a requestId');
  const report = renderReport(result);
  assert.match(report, /# Platform conformance — PASS/);
  assert.match(report, /`g-txt`/);
  assert.match(report, /`c-dual`/);
});

test('conformance: gemini structuredContent leak is FAIL with requestId evidence', () => {
  const result = runConformance([
    env({ id: 'g-leak', platform: 'gemini', method: 'tools/call', result: { structuredContent: PAYLOAD, content: [{ type: 'text', text: JSON.stringify(PAYLOAD) }] } }),
  ]);
  assert.equal(result.status, 'fail');
  const check = result.checks.find((c) => c.check === 'gemini_no_structured_content');
  assert.equal(check.status, 'fail');
  assert.deepEqual(check.evidence, ['g-leak']);
});

test('conformance: chatgpt missing dual encoding is FAIL; claude missing annotations is FAIL', () => {
  const result = runConformance([
    env({ id: 'c-plain', platform: 'chatgpt', method: 'tools/call', result: { content: [{ type: 'text', text: JSON.stringify(PAYLOAD) }] } }),
    env({ id: 'cl-list', platform: 'claude', method: 'tools/list', result: { tools: [{ name: 'search', inputSchema: {} }] } }),
  ]);
  assert.equal(result.status, 'fail');
  assert.deepEqual(result.checks.find((c) => c.check === 'chatgpt_dual_encoding').evidence, ['c-plain']);
  assert.equal(result.checks.find((c) => c.check === 'claude_annotations').status, 'fail');
});

test('conformance: no matching fixture yields UNKNOWN, never a pass', () => {
  const result = runConformance([env({ id: 'old', method: 'tools/call' })]); // legacy, no platform
  assert.equal(result.status, 'unknown');
  const byName = Object.fromEntries(result.checks.map((c) => [c.check, c.status]));
  assert.deepEqual(byName, {
    gemini_no_structured_content: 'unknown',
    chatgpt_dual_encoding: 'unknown',
    claude_annotations: 'unknown',
    stable_tools_list: 'unknown',
  });
  assert.match(renderReport(result), /insufficient fixture signal/);
});

test('conformance: tools/list three-tool surface is stable across platforms', () => {
  assert.deepEqual([...EXPECTED_TOOLS], ['search', 'execute_read', 'execute']);
  const good = checkStableToolsList([
    env({ id: 'a', platform: 'gemini', method: 'tools/list', result: { tools: annotatedTools } }),
    env({ id: 'b', platform: 'chatgpt', method: 'tools/list', result: { tools: annotatedTools } }),
    env({ id: 'c', platform: 'claude', method: 'tools/list', result: { tools: annotatedTools } }),
  ]);
  assert.equal(good.status, 'pass');

  const wrongName = annotatedTools.map((t, i) => i === 1 ? { ...t, name: 'execute_write' } : t);
  assert.equal(checkStableToolsList([
    env({ id: 'bad-name', platform: 'claude', method: 'tools/list', result: { tools: wrongName } }),
  ]).status, 'fail');

  const extra = [...annotatedTools, { name: 'extra_tool', annotations: {} }];
  assert.equal(checkStableToolsList([
    env({ id: 'bad-count', platform: 'gemini', method: 'tools/list', result: { tools: extra } }),
  ]).status, 'fail');
});

test('conformance helpers: platformOf and individual check functions are usable standalone', () => {
  assert.equal(platformOf({ clientPlatform: 'claude' }), 'claude');
  assert.equal(platformOf({ clientPlatform: null }), 'unknown');
  assert.equal(checkGeminiNoStructuredContent([]).status, 'unknown');
  assert.equal(checkChatgptDualEncoding([]).status, 'unknown');
  assert.equal(checkClaudeAnnotations([]).status, 'unknown');
  assert.equal(checkStableToolsList([]).status, 'unknown');
});

/* ------------------------------------------------------------------ *
 * 4. read-only / offline guarantees of the conformance module
 * ------------------------------------------------------------------ */

test('conformance module is read-only and offline (no fetch/write/subprocess)', async () => {
  const { readFile: readFileMod } = await import('node:fs/promises');
  const src = await readFileMod(new URL('../scripts/platform-conformance.mjs', import.meta.url), 'utf8');
  assert.ok(src.includes("from 'node:fs/promises'"), 'only fs read APIs are used');
  assert.doesNotMatch(src, /\bwriteFile\b|\bappendFile\b|\bunlink\b|\brm\s*\(/);
  assert.doesNotMatch(src, /\bfetch\s*\(|\bhttps?\s*\(|\bspawn\s*\(|\bexec\s*\(/);
  // Behavior check: the same pure function returns the same result twice.
  const fixtures = [env({ id: 'g', platform: 'gemini', method: 'tools/call' })];
  assert.deepEqual(runConformance(fixtures), runConformance(fixtures));
});
