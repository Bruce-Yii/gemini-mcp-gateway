import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateEnvelopes, classifyError, renderScorecard, isTruncated,
  protocolVersionOf, executorOf, serversOf, evalModeOf, fourDimensionKeyOf,
} from '../scripts/capture-digest.mjs';

const envelope = (status, durationMs, raw = '{}', extra = {}) => ({
  request: {
    method: extra.method ?? 'POST', url: extra.url ?? '/mcp',
    raw: extra.raw ?? JSON.stringify({ jsonrpc: '2.0', method: extra.mcpMethod ?? 'tools/call', params: { name: extra.tool ?? 'github__get_file_contents' } }),
  },
  response: {
    status, durationMs, bytes: extra.bytes ?? (raw ?? '').length, raw,
    overflow: extra.overflow ?? false, ...(extra.truncated ? { truncated: true } : {}),
  },
  ...(extra.ts ? { ts: extra.ts } : {}),
  ...(extra.events ? { events: extra.events } : {}),
});

test('capture digest aggregates requests, tools and error classes', () => {
  const metrics = aggregateEnvelopes([
    envelope(200, 10, '{"result":{"ok":true}}'),
    envelope(200, 30, '{"result":{"ok":true}}'),
    envelope(400, 20, '{"error":"validation: missing field"}'),
    envelope(500, 40, '{"error":"internal error"}'),
  ]);
  assert.equal(metrics.requests, 4);
  assert.equal(metrics.errors, 2);
  assert.equal(metrics.tools['tools/call'], 4);
  assert.equal(metrics.upstreams.github__get_file_contents, 4);
  assert.equal(metrics.errorClasses.validation, 1);
  assert.equal(metrics.errorClasses.upstream_5xx, 1);
  assert.equal(metrics.p50Ms, 20);
  assert.equal(metrics.p95Ms, 40);
  // Existing scorecard fields remain intact.
  assert.equal(metrics.mcpRequests, 4);
  assert.equal(metrics.nonMcpRequests, 0);
  assert.equal(metrics.mcpErrors, 2);
});

test('capture digest classifies auth/timeout/rate-limit and renders a scorecard', () => {
  assert.equal(classifyError(envelope(401, 1, '{"error":"invalid_token"}')), 'auth');
  assert.equal(classifyError(envelope(429, 1, '{"error":"rate limit"}')), 'rate_limit');
  assert.equal(classifyError(envelope(200, 1, '{"error":"execute error: timeout"}')), 'timeout');
  const md = renderScorecard('2026-11-22', aggregateEnvelopes([envelope(200, 10)]));
  assert.match(md, /# Capture Scorecard — 2026-11-22/);
  assert.match(md, /Requests \| 1/);
  assert.match(md, /Raw payloads remain in R2/);
  // New sections are rendered.
  assert.match(md, /## Per-upstream stats/);
  assert.match(md, /## Per-MCP-tool stats/);
  assert.match(md, /## Requests by day/);
  assert.match(md, /## Requests by hour \(UTC\)/);
  assert.match(md, /## Non-MCP routes \(kept separate\)/);
});

test('digest splits per-upstream and per-MCP-tool calls, errors and timings', () => {
  const events = (server) => [{ type: 'upstream', payload: { server, tool: 'x' } }];
  const metrics = aggregateEnvelopes([
    envelope(200, 10, '{}', { tool: 'github__get_file_contents', events: events('github'), bytes: 100 }),
    envelope(200, 30, '{}', { tool: 'github__get_file_contents', events: events('github'), bytes: 100 }),
    envelope(500, 50, '{"error":"internal error"}', { tool: 'github__create_issue', events: events('github') }),
    envelope(404, 20, '{"error":"not found"}', { tool: 'notion__search', events: events('notion') }),
  ]);
  const github = metrics.upstreamStats.github;
  assert.equal(github.calls, 3);
  assert.equal(github.errors, 1);
  assert.equal(github.errorRate, 0.3333);
  assert.equal(github.p50Ms, 30);
  assert.equal(github.p95Ms, 50);
  assert.equal(github.avgMs, 30);
  assert.equal(github.errorClasses.upstream_5xx, 1);
  const notion = metrics.upstreamStats.notion;
  assert.equal(notion.calls, 1);
  assert.equal(notion.errors, 1);
  assert.equal(notion.errorRate, 1);
  assert.equal(metrics.toolStats['github__get_file_contents'].calls, 2);
  assert.equal(metrics.toolStats['github__create_issue'].p95Ms, 50);
  assert.equal(metrics.toolStats['notion__search'].errors, 1);
});

test('digest falls back to the tool prefix when no upstream event exists', () => {
  const metrics = aggregateEnvelopes([envelope(200, 5, '{}', { tool: 'figma__get_file' })]);
  assert.equal(metrics.upstreamStats.figma.calls, 1);
});

test('digest counts truncation and overflow separately, including wire markers', () => {
  const flagged = envelope(200, 5, 'ok', { truncated: true });
  const overflowed = envelope(200, 5, null, { overflow: true });
  const marker = envelope(200, 5, '{"result":"--- TRUNCATED ---"}');
  const plain = envelope(200, 5, '{"result":"truncated is a normal word in this code"}');
  assert.equal(isTruncated(flagged), true);
  assert.equal(isTruncated(overflowed), false, 'overflow is counted separately, not as truncation');
  assert.equal(isTruncated(marker), true);
  assert.equal(isTruncated(plain), false);
  const metrics = aggregateEnvelopes([flagged, overflowed, marker, plain]);
  assert.equal(metrics.truncated, 2);
  assert.equal(metrics.overflow, 1);
  assert.equal(metrics.truncationRate, 0.5);
  assert.equal(metrics.overflowRate, 0.25);
  assert.equal(metrics.upstreamStats.github.truncated, 2);
  assert.equal(metrics.upstreamStats.github.overflow, 1);
});

test('digest buckets requests by day and by UTC hour', () => {
  const metrics = aggregateEnvelopes([
    envelope(200, 1, '{}', { ts: '2026-11-21T03:10:00.000Z' }),
    envelope(200, 2, '{}', { ts: '2026-11-21T03:45:00.000Z' }),
    envelope(200, 3, '{}', { ts: '2026-11-22T17:05:00.000Z' }),
  ]);
  assert.deepEqual(metrics.byDay, { '2026-11-21': 2, '2026-11-22': 1 });
  assert.deepEqual(metrics.byHour, { '03': 2, '17': 1 });
  assert.deepEqual(metrics.byDayHour, { '2026-11-21T03': 2, '2026-11-22T17': 1 });
});

test('digest keeps non-MCP routes in a separate table', () => {
  const metrics = aggregateEnvelopes([
    envelope(200, 5, '{}'),
    envelope(404, 1, '{"error":"not found"}', { method: 'GET', url: '/healthz', mcpMethod: undefined, raw: null }),
    envelope(500, 2, '{"error":"internal error"}', { method: 'GET', url: '/nope', raw: null }),
  ]);
  assert.equal(metrics.mcpRequests, 1);
  assert.equal(metrics.nonMcpRequests, 2);
  assert.equal(metrics.mcpErrors, 0);
  assert.equal(metrics.errors, 2);
  assert.equal(metrics.byRoute['GET /healthz'].errors, 1);
  assert.equal(metrics.byRoute['GET /nope'].errors, 1);
  assert.equal(metrics.routeErrors.upstream_4xx, 1);
  assert.equal(metrics.routeErrors.upstream_5xx, 1);
});

// ── M4-A: four-dimension ledger (clientPlatform × protocol × profile × build) ──

function dimEnvelope({
  requestId, url = '/mcp', status = 200, raw = '{"result":{"ok":true}}',
  clientPlatform, clientProfile, protocolVersion, servers, evalMode, commit,
  ts = '2026-11-24T01:00:00.000Z', method = 'POST', mcpMethod = 'tools/call',
  durationMs = 10,
} = {}) {
  return {
    requestId,
    ts,
    ...(clientPlatform !== undefined ? { clientPlatform } : {}),
    ...(clientProfile !== undefined ? { clientProfile } : {}),
    ...(protocolVersion !== undefined ? { protocolVersion } : {}),
    ...(servers !== undefined ? { servers } : {}),
    ...(evalMode !== undefined ? { evalMode } : {}),
    ...(commit !== undefined ? { deployment: { commit } } : {}),
    request: {
      method, url,
      raw: JSON.stringify({ jsonrpc: '2.0', method: mcpMethod, params: { name: 'execute_read' } }),
    },
    response: { status, raw, bytes: raw.length, durationMs },
    events: [],
  };
}

test('M4-A: protocol/profile/servers/evalMode helpers are explicit-only', () => {
  assert.equal(protocolVersionOf(dimEnvelope({ url: '/mcp' })), 'v1');
  assert.equal(protocolVersionOf(dimEnvelope({ url: '/mcp/v2' })), 'v2');
  assert.equal(protocolVersionOf(dimEnvelope({ url: '/healthz' })), 'unknown');
  // Explicit field wins over the path (future capture stamping).
  assert.equal(protocolVersionOf(dimEnvelope({ url: '/mcp', protocolVersion: 'v2' })), 'v2');
  assert.equal(protocolVersionOf(dimEnvelope({ protocolVersion: 'v9' })), 'v1');
  assert.equal(executorOf(dimEnvelope({ url: '/mcp/v2' })), 'typed-plan');
  assert.deepEqual(serversOf(dimEnvelope({})), ['unknown']);
  assert.deepEqual(serversOf(dimEnvelope({ servers: ['github', 'github', 'vercel'] })), ['github', 'vercel']);
  assert.equal(evalModeOf(dimEnvelope({ evalMode: 'active' })), 'active');
  assert.equal(evalModeOf(dimEnvelope({ evalMode: 'ACTIVE' })), 'unknown');
  assert.equal(fourDimensionKeyOf(dimEnvelope({
    clientPlatform: 'gemini', clientProfile: 'gemini-text-json', url: '/mcp/v2', commit: 'c1',
  })), 'gemini|v2|gemini-text-json|c1');
});

test('M4-A: four-dimension buckets never mix platform/protocol/profile/build', () => {
  const envelopes = [
    dimEnvelope({ requestId: 'e1', clientPlatform: 'gemini', clientProfile: 'gemini-text-json', url: '/mcp', commit: 'c1', evalMode: 'active', servers: ['github'] }),
    dimEnvelope({ requestId: 'e2', clientPlatform: 'gemini', clientProfile: 'gemini-text-json', url: '/mcp/v2', commit: 'c1', evalMode: 'active', servers: ['github', 'vercel'] }),
    dimEnvelope({ requestId: 'e3', clientPlatform: 'chatgpt', clientProfile: 'chatgpt-structured', url: '/mcp', commit: 'c1', evalMode: 'passive', servers: ['notion'], status: 500, raw: '{"error":"internal error"}' }),
    dimEnvelope({ requestId: 'e4', clientPlatform: 'claude', clientProfile: 'claude-text', url: '/mcp/v2', commit: 'c2', evalMode: 'passive', servers: ['linear'], mcpMethod: 'tools/list' }),
    // Old envelope: no platform/profile/servers/evalMode/commit fields at all.
    dimEnvelope({ requestId: 'e5', url: '/mcp' }),
  ];
  const m = aggregateEnvelopes(envelopes);

  assert.equal(m.byProtocolVersion.v1.requests, 3);
  assert.equal(m.byProtocolVersion.v1.executor, 'codemode');
  assert.equal(m.byProtocolVersion.v2.requests, 2);
  assert.equal(m.byProtocolVersion.v2.executor, 'typed-plan');
  assert.equal(m.byProtocolVersion.unknown, undefined);

  assert.equal(m.byClientProfile['gemini-text-json'].requests, 2);
  assert.equal(m.byClientProfile['chatgpt-structured'].requests, 1);
  assert.equal(m.byClientProfile['claude-text'].requests, 1);
  assert.equal(m.byClientProfile.unknown.requests, 1);

  assert.equal(m.byBuildCommit.c1.requests, 3);
  assert.equal(m.byBuildCommit.c2.requests, 1);
  assert.equal(m.byBuildCommit.unknown.requests, 1);
  assert.deepEqual(m.byBuildCommit.c1.clientPlatforms, ['gemini', 'chatgpt']);

  assert.equal(m.byEvalMode.active.requests, 2);
  assert.equal(m.byEvalMode.passive.requests, 2);
  assert.equal(m.byEvalMode.unknown.requests, 1);

  assert.equal(m.byServerTag.github.requests, 2);
  assert.equal(m.byServerTag.vercel.requests, 1);
  assert.equal(m.byServerTag.notion.requests, 1);
  assert.equal(m.byServerTag.linear.requests, 1);
  assert.equal(m.byServerTag.unknown.requests, 1);
  assert.equal(m.multiServerRequests, 1);

  // Five distinct four-dimension buckets: e1 vs e2 differ by protocol.
  assert.equal(m.fourDimensionSummary.length, 5);
  const byKey = Object.fromEntries(m.fourDimensionSummary.map((row) => [`${row.clientPlatform}|${row.protocolVersion}|${row.clientProfile}|${row.buildCommit}`, row]));
  assert.equal(byKey['gemini|v1|gemini-text-json|c1'].requests, 1);
  assert.equal(byKey['gemini|v2|gemini-text-json|c1'].requests, 1);
  assert.equal(byKey['gemini|v2|gemini-text-json|c1'].executor, 'typed-plan');
  assert.equal(byKey['gemini|v2|gemini-text-json|c1'].toolCalls, 1);
  assert.deepEqual(byKey['gemini|v2|gemini-text-json|c1'].servers, ['github', 'vercel']);
  assert.equal(byKey['chatgpt|v1|chatgpt-structured|c1'].errors, 1);
  assert.equal(byKey['chatgpt|v1|chatgpt-structured|c1'].evalModes.passive, 1);
  assert.equal(byKey['claude|v2|claude-text|c2'].toolCalls, 0, 'tools/list is not a tool call');
  // Old envelope: unknown dimension fields, but the /mcp route is still v1.
  assert.equal(byKey['unknown|v1|unknown|unknown'].requests, 1);
});

test('M4-A: scorecard renders the four new sections with unknown rows', () => {
  const m = aggregateEnvelopes([
    dimEnvelope({ requestId: 'e1', clientPlatform: 'gemini', clientProfile: 'gemini-text-json', url: '/mcp/v2', commit: 'c1', evalMode: 'active', servers: ['github', 'vercel'] }),
    dimEnvelope({ requestId: 'e2', url: '/mcp' }),
  ]);
  const md = renderScorecard('2026-11-24', m);
  assert.match(md, /## By protocol version \(v1 \/ v2\) — M4-A/);
  assert.match(md, /## By client profile — M4-A/);
  assert.match(md, /## Four-dimension ledger — platform × protocol × profile × build \(M4-A\)/);
  assert.match(md, /## By servers\[\] \(cross-upstream\) — M4-A/);
  assert.match(md, /## By eval mode \(active \/ passive\) — M4-A/);
  assert.match(md, /\| v2 \| typed-plan \| 1 \|/);
  assert.match(md, /\| v1 \| codemode \| 1 \|/);
  assert.match(md, /multiServerRequests`=1/);
  assert.match(md, /\| gemini \| v2 \| typed-plan \| gemini-text-json \| c1 \|/);
  assert.match(md, /\| active:1 \| github, vercel \|/);
});
