import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  aggregateEnvelopes, classifyError, renderScorecard, isTruncated,
  protocolVersionOf, executorOf, serversOf, evalModeOf, fourDimensionKeyOf,
  listR2Keys, readR2Envelope, encodeEnvelopeBundle, writeEnvelopeBundle, readEnvelopeBundle,
} from '../scripts/capture-digest.mjs';
import { planSync, syncCaptures } from '../scripts/sync-captures.mjs';

const envelope = (status, durationMs, raw = '{}', extra = {}) => ({
  ...(extra.requestId ? { requestId: extra.requestId } : {}),
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

// ── Eval closure: connect failures + services() snapshots are deterministic ──

test('eval-closure: digest aggregates upstream_connect failures and services() state', () => {
  const connectFail = (server, message) => [{
    type: 'upstream_connect',
    payload: { server, ok: false, error: { name: 'Error', message }, durationMs: 12 },
  }];
  const serviceEvent = (rows) => [{
    type: 'gateway_helper',
    payload: { helper: 'services', ok: true, services: rows },
  }];
  const metrics = aggregateEnvelopes([
    envelope(200, 5, '{}', {
      requestId: 'req-connect-auth',
      events: connectFail('notion', '401 invalid_token: The access token is invalid or expired'),
    }),
    envelope(200, 5, '{}', {
      requestId: 'req-connect-plain',
      events: connectFail('linear', 'ECONNRESET'),
    }),
    envelope(200, 5, '{}', {
      requestId: 'req-services',
      events: serviceEvent([
        { name: 'github', toolCount: 42, status: 'observed', online: true, needsReauth: false },
        { name: 'notion', toolCount: 0, status: 'offline', online: false, needsReauth: true },
        { name: 'linear', toolCount: 0, status: 'offline', online: false, needsReauth: true },
        { name: 'vercel', toolCount: 73, status: 'stale', online: true },
      ]),
    }),
  ]);
  assert.equal(metrics.upstreamConnect.failures, 2);
  const byServer = metrics.upstreamConnect.byServer;
  assert.equal(byServer.notion.failures, 1);
  assert.deepEqual(byServer.notion.errorClasses, { auth: 1 });
  assert.deepEqual(byServer.notion.sampleRequestIds, ['req-connect-auth']);
  assert.equal(byServer.linear.failures, 1);
  assert.deepEqual(byServer.linear.errorClasses, { connect: 1 });

  assert.equal(metrics.serviceState.snapshots, 1);
  assert.equal(metrics.serviceState.byServer.notion.status, undefined);
  assert.equal(metrics.serviceState.byServer.notion.statuses.offline, 1);
  assert.equal(metrics.serviceState.byServer.notion.needsReauth, true);
  assert.equal(metrics.serviceState.byServer.vercel.toolCount, 73);
  assert.deepEqual(metrics.serviceState.offlineServers, ['linear', 'notion']);
  assert.deepEqual(metrics.serviceState.staleServers, ['vercel']);
  assert.deepEqual(metrics.serviceState.onlineServers, ['github']);

  const md = renderScorecard('2026-11-24', metrics);
  assert.match(md, /## Upstream connect failures \(eval closure\)/);
  assert.match(md, /## Service state snapshots \(codemode\.services\(\)\)/);
  assert.match(md, /\| notion \| 1 \| auth:1 \| `req-connect-auth` \|/);
  assert.match(md, /\| notion \| 1 \| 0 \| offline:1 \| offline\/needsReauth \| `req-services` \|/);
  assert.match(md, /## Gateway helper calls \(eval closure\)/);
  assert.equal(metrics.serviceState.byServer.notion.latest.status, 'offline');
  assert.equal(metrics.serviceState.currentOfflineServers.includes('notion'), true);
  assert.ok((metrics.helperStats ?? []).some((row) => row.helper === 'services' && row.calls === 1));
});

// ── R2 list pagination: default 20/page silently dropped capture logs ──

const r2Page = (keys, cursor) => ({
  result: keys.map((key) => ({ key })),
  ...(cursor === undefined ? {} : { result_info: { cursor } }),
});

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

test('listR2Keys: follows result_info.cursor with per_page=1000 (3 pages, 45 keys)', async () => {
  const page1 = Array.from({ length: 20 }, (_, i) => `capture/2026-11-24/a-${i}.json.gz`);
  const page2 = Array.from({ length: 20 }, (_, i) => `capture/2026-11-24/b-${i}.json.gz`);
  const page3 = Array.from({ length: 5 }, (_, i) => `capture/2026-11-24/c-${i}.json.gz`);
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    const cursor = new URL(String(url)).searchParams.get('cursor');
    if (cursor === null) return jsonResponse(r2Page(page1, 'cursor-1'));
    if (cursor === 'cursor-1') return jsonResponse(r2Page(page2, 'cursor-2'));
    return jsonResponse(r2Page(page3));
  };

  const keys = await listR2Keys('capture/2026-11-24/', { fetchImpl });

  assert.equal(calls.length, 3);
  assert.equal(keys.length, 45);
  assert.equal(keys.pages, 3);
  assert.equal(keys.truncated, false);
  assert.deepEqual([...keys], [...page1, ...page2, ...page3], 'all pages stitched in order');
  for (const call of calls) {
    const url = new URL(call.url);
    assert.equal(url.searchParams.get('prefix'), 'capture/2026-11-24/');
    assert.equal(url.searchParams.get('per_page'), '1000');
    assert.equal(typeof call.init?.headers, 'object');
  }
  assert.equal(new URL(calls[0].url).searchParams.has('cursor'), false, 'first request has no cursor');
  assert.equal(new URL(calls[1].url).searchParams.get('cursor'), 'cursor-1');
  assert.equal(new URL(calls[2].url).searchParams.get('cursor'), 'cursor-2');
});

test('listR2Keys: filters non-.json.gz objects and de-dupes keys across pages', async () => {
  const fetchImpl = async (url) => {
    const cursor = new URL(String(url)).searchParams.get('cursor');
    if (cursor === null) {
      return jsonResponse(r2Page(['capture/x/a.json.gz', 'capture/x/ignored.txt', 'capture/x/a.json.gz'], 'c1'));
    }
    return jsonResponse(r2Page(['capture/x/a.json.gz', 'capture/x/b.json.gz'], ''));
  };
  const keys = await listR2Keys('capture/x/', { fetchImpl });
  assert.deepEqual([...keys], ['capture/x/a.json.gz', 'capture/x/b.json.gz']);
  assert.equal(keys.pages, 2, 'an empty-string cursor ends the walk');
  assert.equal(keys.truncated, false);
});

test('listR2Keys: maxPages cap warns once and flags truncated, never silently drops', async () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    let pageNo = 0;
    const fetchImpl = async () => {
      pageNo += 1;
      return jsonResponse(r2Page([`capture/x/page-${pageNo}.json.gz`], `cursor-${pageNo}`));
    };
    const keys = await listR2Keys('capture/x/', { fetchImpl, maxPages: 2 });
    assert.equal(pageNo, 2);
    assert.equal(keys.length, 2);
    assert.equal(keys.pages, 2);
    assert.equal(keys.truncated, true);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /maxPages=2/);
    assert.match(warnings[0], /cursor still present/);
    assert.match(warnings[0], /truncated=true/);
    assert.match(warnings[0], /capture\/x\//);
    assert.doesNotMatch(warnings[0], /https?:\/\//, 'warning must not leak endpoint/auth context');
  } finally {
    console.warn = originalWarn;
  }
});

test('listR2Keys: non-2xx and unparseable JSON throw instead of returning a partial listing', async () => {
  await assert.rejects(
    () => listR2Keys('capture/x/', { fetchImpl: async () => jsonResponse({}, 500) }),
    /R2 list failed: 500/,
  );
  await assert.rejects(
    () => listR2Keys('capture/x/', {
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token'); } }),
    }),
    /Unexpected token/,
  );
});

// ── isTruncated: strict flags only (false-positive fix) ──

test('isTruncated: strict boolean stamp and truncation object only', () => {
  assert.equal(isTruncated({ response: { truncated: true } }), true);
  assert.equal(isTruncated({ response: { truncation: { reason: 'maxCharsPerLine', totalChars: 1000 } } }), true);
  assert.equal(isTruncated({ response: { truncation: {} } }), true, 'a present truncation object is a positive declaration');
  assert.equal(isTruncated({ response: { truncation: null } }), false);
  assert.equal(isTruncated({ response: { truncation: ['maxCharsPerLine'] } }), false, 'arrays are not truncation objects');
  assert.equal(isTruncated({ response: { truncation: 'maxCharsPerLine' } }), false, 'bare reason strings are not objects');
  assert.equal(isTruncated({ response: { truncated: 'true' } }), false, 'string "true" is not the boolean stamp');
  assert.equal(isTruncated({}), false);
});

test('isTruncated: payload text is never a flag, including {"truncated": false}', () => {
  assert.equal(isTruncated({ response: { raw: '{"truncated": false}' } }), false);
  assert.equal(isTruncated({ response: { raw: '{"truncated": true}' } }), false, 'a payload string alone is not an explicit marker');
  assert.equal(isTruncated({ response: { raw: '{"result":{"truncated":false},"ok":true}' } }), false);
  assert.equal(isTruncated({ response: { raw: 'this code mentions truncated as a normal word' } }), false);
  assert.equal(isTruncated({ response: { raw: 'truncated:' } }), false, 'the old broad truncated: regex is gone');
});

test('isTruncated: wire markers count only inside the trailing 256 chars', () => {
  assert.equal(isTruncated({ response: { raw: '{"result":"… tail --- TRUNCATED ---"}' } }), true);
  assert.equal(isTruncated({ response: { raw: 'value …[truncated]' } }), true);
  assert.equal(isTruncated({ response: { raw: 'value …[truncated 12]' } }), true);
  assert.equal(isTruncated({ response: { raw: `${'x'.repeat(400)}--- TRUNCATED ---` } }), true, 'marker at the tail after a long payload');
  assert.equal(isTruncated({ response: { raw: `--- TRUNCATED ---${'x'.repeat(300)}` } }), false, 'a marker far from the tail does not prove a cut');
  assert.equal(isTruncated({ response: { raw: `prefix ${'x'.repeat(400)} …[truncated]` } }), true);
  assert.equal(isTruncated({ response: { raw: `…[truncated] ${'x'.repeat(300)}` } }), false);
  // Old envelopes that only carried a marker in `response.error` are no longer
  // re-classified: only the response body tail is trusted.
  assert.equal(isTruncated({ response: { error: '--- TRUNCATED ---' } }), false);
});



test('R2 retries transient 429/5xx for list and get', async () => {
  let listCalls = 0;
  const listFetch = async () => {
    listCalls += 1;
    if (listCalls < 3) return new Response('', { status: listCalls === 1 ? 429 : 503, headers: { 'retry-after': '0' } });
    return new Response(JSON.stringify({ result: [{ key: 'capture/a.json.gz' }], result_info: {} }), { status: 200 });
  };
  const keys = await listR2Keys('capture/', { fetchImpl: listFetch, maxAttempts: 3, maxPages: 2 });
  assert.deepEqual([...keys], ['capture/a.json.gz']);
  assert.equal(listCalls, 3);

  let getCalls = 0;
  const getFetch = async () => {
    getCalls += 1;
    if (getCalls < 3) return new Response('', { status: getCalls === 1 ? 429 : 502, headers: { 'retry-after': '0' } });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const env = await readR2Envelope('capture/a.json.gz', { fetchImpl: getFetch, maxAttempts: 3 });
  assert.deepEqual(env, { ok: true });
  assert.equal(getCalls, 3);
});

test('R2 429 exhaustion throws R2_RATE_LIMITED, never fakes success', async () => {
  const fetchImpl = async () => new Response('', {
    status: 429,
    headers: { ratelimit: '"default";r=0;t=0' },
  });
  await assert.rejects(
    () => readR2Envelope('capture/x.json.gz', { fetchImpl, maxAttempts: 2, maxWaitMs: 0 }),
    /R2_RATE_LIMITED/,
  );
  await assert.rejects(
    () => listR2Keys('capture/', { fetchImpl, maxAttempts: 1, maxWaitMs: 0 }),
    /R2_RATE_LIMITED/,
  );
});

test('eval-closure: cold-start upstream_connect events become serviceSnapshots', () => {
  const events = (rows) => rows.map((row) => ({ type: 'upstream_connect', payload: row }));
  const metrics = aggregateEnvelopes([
    envelope(200, 5, '{}', { requestId: 'req-ok', events: events([{ server: 'github', ok: true, toolCount: 42 }]) }),
    envelope(200, 5, '{}', { requestId: 'req-fail', events: events([{ server: 'notion', ok: false, error: { message: '401 invalid_token' } }]) }),
  ]);
  assert.equal(metrics.serviceSnapshots.snapshots, 2);
  assert.equal(metrics.serviceSnapshotCounts.helper, 0);
  assert.equal(metrics.serviceSnapshotCounts.connect, 2);
  assert.equal(metrics.serviceSnapshots.byServer.github.latest.status, 'online');
  assert.equal(metrics.serviceSnapshots.byServer.notion.latest.status, 'offline');
  assert.equal(metrics.serviceSnapshots.byServer.notion.needsReauth, true);
  assert.deepEqual(metrics.serviceSnapshots.onlineServers, ['github']);
  assert.deepEqual(metrics.serviceSnapshots.currentOfflineServers, ['notion']);
});

// ── Single-read bundle: digest writes it, analyzer reuses it ─────────────────

test('envelope bundle: NDJSON round-trips and tolerates blank lines', async () => {
  const store = {};
  const envelopes = [{ requestId: 'a', ts: '2026-11-24T19:00:00.000Z' }, { requestId: 'b' }];
  const text = encodeEnvelopeBundle(envelopes);
  assert.equal(text.trim().split('\n').length, 2);
  assert.equal(text.endsWith('\n'), true);
  // Round-trip through the exported writer/reader using a temp file.
  const dir = mkdtempSync(join(tmpdir(), 'bundle-'));
  try {
    const file = join(dir, 'envelopes.ndjson');
    const written = await writeEnvelopeBundle(file, envelopes);
    assert.equal(written, 2);
    assert.deepEqual(await readEnvelopeBundle(file), envelopes);
    writeFileSync(join(dir, 'blanks.ndjson'), '\n{"requestId":"c"}\n\n', 'utf8');
    assert.deepEqual(await readEnvelopeBundle(join(dir, 'blanks.ndjson')), [{ requestId: 'c' }]);
    assert.equal(encodeEnvelopeBundle([]), '');
    store.ok = true;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(store.ok, true);
});

// ── Incremental sync: only new keys are fetched, budget is enforced ─────────

test('sync: planSync fetches only unseen keys and prunes vanished ones', () => {
  const plan = planSync({
    seen: ['k1', 'k2', 'gone'],
    present: ['k1', 'k2', 'k3', 'k4'],
    maxFetch: 10,
  });
  assert.deepEqual(plan.newKeys, ['k3', 'k4']);
  assert.deepEqual(plan.seen.sort(), ['k1', 'k2', 'k3', 'k4']);
});

test('sync: exceeding the fetch budget fails loudly instead of bursting R2', () => {
  assert.throws(
    () => planSync({ seen: [], present: ['a', 'b', 'c'], maxFetch: 2 }),
    /SYNC_FETCH_BUDGET_EXCEEDED/,
  );
});

test('sync: incremental runs fetch nothing when the manifest is up to date', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'capture-sync-'));
  try {
    const envelopes = [
      { requestId: 'r1', ts: '2026-11-24T19:00:00.000Z' },
      { requestId: 'r2', ts: '2026-11-24T19:10:00.000Z' },
    ];
    const present = ['capture/2026-11-24/r1.json.gz', 'capture/2026-11-24/r2.json.gz'];
    const first = await syncCaptures({
      dir,
      now: new Date('2026-11-24T19:15:00.000Z'),
      retainMinutes: 1440,
      listKeys: async () => present,
      readEnvelope: async (key) => envelopes[present.indexOf(key)],
    });
    assert.equal(first.newKeys, 2);
    assert.equal(first.fetchedEnvelopes, 2);
    assert.equal(first.storedEnvelopes, 2);

    let reads = 0;
    const second = await syncCaptures({
      dir,
      now: new Date('2026-11-24T19:45:00.000Z'),
      retainMinutes: 1440,
      listKeys: async () => present,
      readEnvelope: async () => { reads += 1; return null; },
    });
    assert.equal(second.newKeys, 0, 'second run must fetch nothing new');
    assert.equal(reads, 0, 'no envelope GET on an up-to-date store');
    assert.equal(second.storedEnvelopes, 2, 'store is reused, not dropped');

    const third = await syncCaptures({
      dir,
      now: new Date('2026-11-24T20:00:00.000Z'),
      retainMinutes: 1440,
      listKeys: async () => [...present, 'capture/2026-11-24/r3.json.gz'],
      readEnvelope: async () => ({ requestId: 'r3', ts: '2026-11-24T19:50:00.000Z' }),
    });
    assert.equal(third.newKeys, 1);
    assert.equal(third.storedEnvelopes, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
