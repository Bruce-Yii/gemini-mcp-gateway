import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildAnalyzerInput, validateAnalyzerOutput, dailyTrend, renderWeeklyReview, isoWeek, filterEnvelopes,
  parseCliFilters, buildEmptyWindowAnalyzerOutput, analyzerPrompt,
} from '../scripts/analyze-captures.mjs';
import { aggregateEnvelopes } from '../scripts/capture-digest.mjs';

function envelope(status, raw, extra = {}) {
  return {
    requestId: extra.requestId ?? `req-${Math.random()}`,
    ...(extra.ts ? { ts: extra.ts } : {}),
    request: {
      method: extra.method ?? 'POST', url: extra.url ?? '/mcp',
      raw: raw === null ? null : JSON.stringify({ jsonrpc: '2.0', method: extra.mcpMethod ?? 'tools/call', params: { name: extra.tool ?? 'github__get_file_contents', arguments: { code: extra.code } } }),
    },
    response: { status, raw: raw ?? '', bytes: (raw ?? '').length, durationMs: extra.durationMs ?? 10, ...(extra.truncated ? { truncated: true } : {}) },
    events: extra.events ?? [],
  };
}

test('buildAnalyzerInput clusters failures with evidence and truncates code', () => {
  const code = 'x'.repeat(5000);
  const input = buildAnalyzerInput([
    envelope(200, '{"result":{"ok":true}}'),
    envelope(404, '{"error":"not found"}', { code, requestId: 'req-a' }),
    envelope(404, '{"error":"not found"}', { requestId: 'req-b' }),
    envelope(500, '{"error":"internal error"}', { requestId: 'req-c' }),
  ], { date: '2026-11-22' });
  assert.equal(input.schema, 'analyzer-input.v1');
  assert.equal(input.metrics.requests, 4);
  assert.equal(input.metrics.errors, 3);
  const notFound = input.clusters.find((cluster) => cluster.errorClass === 'upstream_4xx');
  assert.ok(notFound);
  assert.equal(notFound.count, 2);
  assert.deepEqual(notFound.sampleEventIds, ['req-a', 'req-b']);
  assert.ok(notFound.sampleCode.length < 5000);
  assert.match(notFound.sampleCode, /truncated/);
});

test('validateAnalyzerOutput drops bad categories and invented evidence ids', () => {
  const input = {
    clusters: [{ id: 'c1', sampleEventIds: ['req-a'] }],
    limits: { maxIssues: 5 },
  };
  const output = validateAnalyzerOutput({
    schema: 'analyzer-output.v1',
    summary: 'summary',
    issues: [
      { id: 'i1', severity: 'P1', category: 'gateway', title: 'ok', evidenceEventIds: ['req-a'], likelyCause: 'x', suggestedFix: 'y' },
      { id: 'i2', severity: 'P1', category: 'security', title: 'bad category', evidenceEventIds: ['req-a'] },
      { id: 'i3', severity: 'P1', category: 'upstream', title: 'bad evidence', evidenceEventIds: ['invented'] },
    ],
    ignored: [{ clusterId: 'c1', reason: 'upstream quota' }],
  }, input);
  assert.equal(output.issues.length, 1);
  assert.equal(output.issues[0].id, 'i1');
  assert.equal(output.ignored.length, 1);
});

test('analyzer ignores expected non-POST /mcp 405 probes and keeps a fallback error preview', () => {
  const getProbe = {
    requestId: 'probe', request: { method: 'GET', url: '/mcp', raw: null },
    response: { status: 405, raw: '', durationMs: 1 },
  };
  const postError = {
    requestId: 'post-err', request: { method: 'POST', url: '/mcp', raw: JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'execute_read' } }) },
    response: { status: 500, raw: '', durationMs: 10 },
  };
  const input = buildAnalyzerInput([getProbe, postError], { date: '2026-11-22' });
  assert.equal(input.metrics.requests, 1);
  assert.equal(input.metrics.errors, 1);
  assert.equal(input.clusters.length, 1);
  assert.equal(input.clusters[0].sampleError, 'HTTP 500');
});
test('buildAnalyzerInput includes successful execute samples for friction analysis', () => {
  const env = {
    requestId: 'req-sample',
    request: { method: 'POST', url: '/mcp', raw: JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'execute_read', arguments: { code: 'async () => 1' } } }) },
    response: { status: 200, raw: 'ok', bytes: 2, durationMs: 50 },
    events: [],
  };
  const input = buildAnalyzerInput([env], { date: '2026-11-22' });
  assert.equal(input.samples.length, 1);
  assert.equal(input.samples[0].id, 'req-sample');
  assert.equal(input.samples[0].tool, 'execute_read');
  assert.match(input.samples[0].code, /async/);
});
test('analyzer output is explicitly advisory and requires human review', () => {
  const input = { clusters: [{ id: 'c1', sampleEventIds: ['req-a'] }], limits: { maxIssues: 5 } };
  const out = validateAnalyzerOutput({
    summary: 'x',
    issues: [{ severity: 'P2', category: 'gateway', title: 'x', evidenceEventIds: ['req-a'] }],
  }, input);
  assert.equal(out.policy, 'free-model-advisory-v1');
  assert.equal(out.advisoryOnly, true);
  assert.equal(out.requiresHumanReview, true);
});

test('dailyTrend rolls up multi-day envelopes deterministically', () => {
  const trend = dailyTrend([
    envelope(200, '{"ok":true}', { ts: '2026-11-21T03:00:00.000Z' }),
    envelope(500, '{"error":"internal error"}', { ts: '2026-11-21T04:00:00.000Z' }),
    envelope(200, '{"ok":true}', { ts: '2026-11-22T03:00:00.000Z' }),
  ]);
  assert.equal(trend.length, 2);
  assert.equal(trend[0].date, '2026-11-21');
  assert.equal(trend[0].requests, 2);
  assert.equal(trend[0].errors, 1);
  assert.equal(trend[0].errorRate, 0.5);
  assert.equal(trend[1].date, '2026-11-22');
  assert.equal(trend[1].errors, 0);
});

test('buildAnalyzerInput carries cross-day trend and per-upstream error rates', () => {
  const days = [
    envelope(200, '{"ok":true}', { ts: '2026-11-21T03:00:00.000Z', tool: 'github__get_file_contents' }),
    envelope(500, '{"error":"internal error"}', { ts: '2026-11-21T04:00:00.000Z', tool: 'github__create_issue', requestId: 'req-gh-err' }),
    envelope(404, '{"error":"not found"}', { ts: '2026-11-22T03:00:00.000Z', tool: 'notion__search', requestId: 'req-nt-err' }),
    envelope(200, '{"ok":true}', { ts: '2026-11-22T04:00:00.000Z', tool: 'notion__search' }),
  ];
  const trend = dailyTrend(days);
  const input = buildAnalyzerInput(days, { date: '2026-11-22', trend });
  assert.deepEqual(input.trend.map((row) => row.date), ['2026-11-21', '2026-11-22']);
  const rates = Object.fromEntries(input.upstreamErrorRates.map((row) => [row.server, row]));
  assert.equal(rates.github.calls, 2);
  assert.equal(rates.github.errors, 1);
  assert.equal(rates.github.errorRate, 0.5);
  assert.deepEqual(rates.github.sampleEventIds, ['req-gh-err']);
  assert.equal(rates.notion.calls, 2);
  assert.equal(rates.notion.errors, 1);
  // Advisory invariants still hold with the new input fields.
  const validated = validateAnalyzerOutput({ issues: [] }, input);
  assert.equal(validated.advisoryOnly, true);
  assert.equal(validated.requiresHumanReview, true);
});

test('per-upstream rates are derived from upstream events, not the MCP tool name', () => {
  const events = (server, tool) => [
    { type: 'upstream', payload: { server, tool } },
    { type: 'sandbox', payload: { tool: 'execute_read', output: { toolCalls: [] } } },
  ];
  const envelopes = [
    envelope(200, '{"ok":true}', { tool: 'execute_read', requestId: 'req-multi-ok', events: events('github', 'get_file_contents') }),
    envelope(200, '{"ok":true}', { tool: 'execute_read', requestId: 'req-multi-ok2', events: events('vercel', 'list_deployments') }),
    envelope(500, '{"error":"internal error"}', { tool: 'execute_read', requestId: 'req-multi-fail', events: events('github', 'create_issue') }),
  ];
  const input = buildAnalyzerInput(envelopes, { date: '2026-11-22' });
  const rates = Object.fromEntries(input.upstreamErrorRates.map((row) => [row.server, row]));
  assert.equal(rates.github.calls, 2);
  assert.equal(rates.github.errors, 1);
  assert.equal(rates.github.errorRate, 0.5);
  assert.deepEqual(rates.github.sampleEventIds, ['req-multi-fail']);
  assert.equal(rates.vercel.calls, 1);
  assert.equal(rates.vercel.errors, 0);
  assert.ok(!rates.execute_read, 'gateway tool name is never counted as an upstream server');

  // Digest must agree with the analyzer on the same definition.
  const digest = aggregateEnvelopes(envelopes, { date: '2026-11-22' });
  assert.equal(digest.upstreamStats.github.calls, 2);
  assert.equal(digest.upstreamStats.github.errors, 1);
  assert.equal(digest.upstreamStats.vercel.calls, 1);
  assert.equal(digest.upstreamStats.github.errorRate, rates.github.errorRate);
});

test('isoWeek formats UTC ISO week keys', () => {
  assert.equal(isoWeek('2026-11-22'), '2026-47');
  assert.equal(isoWeek('2026-01-01'), '2026-01');
  assert.equal(isoWeek('2025-12-31'), '2026-01');
});

test('weekly review render lists candidates and evidence ids only, with no auto actions', () => {
  const md = renderWeeklyReview({
    week: '2026-48',
    since: '2026-11-16',
    days: 7,
    trend: [{ date: '2026-11-21', requests: 10, errors: 2, errorRate: 0.2, p95Ms: 500, truncated: 1 }],
    totals: { requests: 10, mcpRequests: 8, errors: 2, errorRate: 0.2, truncated: 1, overflow: 0 },
    candidates: [
      { severity: 'P2', category: 'upstream', title: 'Notion 404 cluster', evidenceEventIds: ['req-a', 'req-b', 'req-c', 'req-d', 'req-e', 'req-f'] },
    ],
  });
  assert.match(md, /# Weekly Capture Review — 2026-48/);
  assert.match(md, /\| W1 \| P2 \| upstream \| Notion 404 cluster \| `req-a`, `req-b`, `req-c`, `req-d`, `req-e` \|/);
  assert.ok(!md.includes('req-f'), 'evidence ids are capped at five');
  assert.match(md, /Advisory only/);
  assert.match(md, /no GitHub issues are created/);
  assert.match(md, /human review required/i);
  assert.ok(!/```/.test(md), 'no code patches in the report');
});

test('buildAnalyzerInput expands upstream subCalls and metadata in samples', () => {
  const env = {
    requestId: 'req-subcalls',
    ts: '2026-11-24T02:00:00.000Z',
    clientPlatform: 'gemini',
    evalMode: 'active',
    deployment: { commit: '1481408abcdef' },
    servers: ['github', 'vercel'],
    request: {
      method: 'POST',
      url: '/mcp',
      raw: JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'execute', arguments: { code: 'async () => 1' } } }),
    },
    response: { status: 200, raw: 'ok', bytes: 2, durationMs: 320 },
    events: [
      { type: 'upstream', payload: { server: 'github', tool: 'github__get_file_contents', ok: true, durationMs: 110 } },
      { type: 'upstream', payload: { server: 'vercel', tool: 'vercel__get_deployment', ok: false, durationMs: 200 } },
    ],
  };
  const input = buildAnalyzerInput([env], { date: '2026-11-24' });
  assert.equal(input.samples.length, 1);
  assert.equal(input.samples[0].clientPlatform, 'gemini');
  assert.equal(input.samples[0].evalMode, 'active');
  assert.equal(input.samples[0].buildCommit, '1481408abcdef');
  assert.deepEqual(input.samples[0].servers, ['github', 'vercel']);
  assert.equal(input.samples[0].subCalls.length, 2);
  assert.equal(input.samples[0].subCalls[1].tool, 'vercel__get_deployment');
  assert.equal(input.samples[0].subCalls[1].ok, false);
});

test('filterEnvelopes filters by lastMinutes and buildCommit prefix', () => {
  const nowMs = Date.parse('2026-11-24T02:00:00.000Z');
  const list = [
    { requestId: 'r1', ts: '2026-11-24T01:45:00.000Z', deployment: { commit: '1481408aaa' } },
    { requestId: 'r2', ts: '2026-11-24T00:30:00.000Z', deployment: { commit: '1481408aaa' } },
    { requestId: 'r3', ts: '2026-11-24T01:55:00.000Z', deployment: { commit: '9ab0e57bbb' } },
  ];
  const filtered = filterEnvelopes(list, { lastMinutes: 30, commit: '1481408', nowMs });
  assert.deepEqual(filtered.map((x) => x.requestId), ['r1']);
});

// ── M4-A: platform / evalMode filters + four-dimension analyzer input ─────────

const ANALYZER_SCRIPT = fileURLToPath(new URL('../scripts/analyze-captures.mjs', import.meta.url));

function dimensionEnv({ id, url = '/mcp', platform, profile, evalMode, commit = '5039ac6', ts }) {
  return {
    requestId: id,
    ts,
    clientPlatform: platform,
    clientProfile: profile,
    evalMode,
    deployment: { commit },
    request: {
      method: 'POST',
      url,
      raw: JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'execute_read', arguments: { code: 'async () => 1' } } }),
    },
    response: { status: 200, raw: 'ok', bytes: 2, durationMs: 10 },
    events: [],
  };
}

test('M4-A: parseCliFilters validates --platform/--eval-mode/--last-minutes/--commit', () => {
  assert.deepEqual(parseCliFilters([]), { platform: '', evalMode: '', lastMinutes: 0, commit: '' });
  assert.deepEqual(
    parseCliFilters(['--platform', 'Gemini', '--eval-mode', 'ACTIVE', '--last-minutes', '60', '--commit', '5039ac6']),
    { platform: 'gemini', evalMode: 'active', lastMinutes: 60, commit: '5039ac6' },
  );
  assert.throws(() => parseCliFilters(['--platform', 'bogus']), /invalid --platform "bogus": expected gemini\|chatgpt\|claude/);
  assert.throws(() => parseCliFilters(['--eval-mode', 'bogus']), /invalid --eval-mode "bogus": expected active\|passive/);
  assert.throws(() => parseCliFilters(['--platform']), /--platform requires a value/);
  assert.throws(() => parseCliFilters(['--platform', '--dry-run']), /--platform requires a value/);
  assert.throws(() => parseCliFilters(['--last-minutes', '0']), /invalid --last-minutes "0": expected a positive number/);
  assert.throws(() => parseCliFilters(['--last-minutes', 'abc']), /invalid --last-minutes "abc"/);
  assert.throws(() => parseCliFilters(['--commit', '   ']), /--commit requires a non-empty commit prefix/);
});

test('M4-A: filterEnvelopes composes platform × evalMode × lastMinutes × commit', () => {
  const nowMs = Date.parse('2026-11-24T02:00:00.000Z');
  const list = [
    dimensionEnv({ id: 'a1', platform: 'gemini', profile: 'gemini-text-json', evalMode: 'active', ts: '2026-11-24T01:45:00.000Z', commit: 'c1' }),
    dimensionEnv({ id: 'a2', platform: 'gemini', profile: 'gemini-text-json', evalMode: 'passive', ts: '2026-11-24T01:50:00.000Z', commit: 'c1' }),
    dimensionEnv({ id: 'a3', platform: 'gemini', profile: 'gemini-text-json', evalMode: 'active', ts: '2026-11-24T00:30:00.000Z', commit: 'c1' }),
    dimensionEnv({ id: 'a4', platform: 'chatgpt', profile: 'chatgpt-structured', evalMode: 'active', ts: '2026-11-24T01:55:00.000Z', commit: 'c2' }),
  ];
  const selected = filterEnvelopes(list, { lastMinutes: 60, platform: 'gemini', evalMode: 'active', commit: 'c1', nowMs });
  assert.deepEqual(selected.map((row) => row.requestId), ['a1']);
  assert.deepEqual(
    filterEnvelopes(list, { platform: 'gemini', nowMs }).map((row) => row.requestId),
    ['a1', 'a2', 'a3'],
  );
  assert.deepEqual(
    filterEnvelopes(list, { evalMode: 'active', nowMs }).map((row) => row.requestId),
    ['a1', 'a3', 'a4'],
  );
  assert.throws(() => filterEnvelopes(list, { platform: 'bogus' }), /invalid platform filter/);
  assert.throws(() => filterEnvelopes(list, { evalMode: 'bogus' }), /invalid evalMode filter/);
});

test('M4-A: analyzer input carries dimensions + sample protocol/profile/executor', () => {
  const input = buildAnalyzerInput([
    dimensionEnv({ id: 'v1', url: '/mcp', platform: 'gemini', profile: 'gemini-text-json', evalMode: 'active', ts: '2026-11-24T01:00:00.000Z' }),
    dimensionEnv({ id: 'v2', url: '/mcp/v2', platform: 'chatgpt', profile: 'chatgpt-structured', evalMode: 'passive', ts: '2026-11-24T01:01:00.000Z' }),
  ], { date: '2026-11-24', filters: { platform: 'gemini', evalMode: 'active', lastMinutes: 60, commit: '5039ac6' } });

  assert.deepEqual(input.filters, { platform: 'gemini', evalMode: 'active', lastMinutes: 60, commit: '5039ac6' });
  assert.equal(input.dimensions.byProtocolVersion.v1.requests, 1);
  assert.equal(input.dimensions.byProtocolVersion.v2.requests, 1);
  assert.equal(input.dimensions.byProtocolVersion.v2.executor, 'typed-plan');
  assert.equal(input.dimensions.byFourDimension.length, 2);
  assert.equal(input.dimensions.unknownBucket, 'unknown');
  assert.equal(input.dimensions.multiServerRequests, 0);
  const v2 = input.samples.find((sample) => sample.id === 'v2');
  assert.equal(v2.protocolVersion, 'v2');
  assert.equal(v2.executor, 'typed-plan');
  assert.equal(v2.clientProfile, 'chatgpt-structured');
});

test('M4-A: CLI --dir composes filters; invalid args exit 1 with a clear error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'm4a-'));
  const out = join(dir, 'out');
  const now = Date.now();
  const ts = (minutesAgo) => new Date(now - minutesAgo * 60 * 1000).toISOString();
  writeFileSync(join(dir, 'a.json'), JSON.stringify(dimensionEnv({ id: 'a', url: '/mcp', platform: 'gemini', profile: 'gemini-text-json', evalMode: 'active', ts: ts(10) })));
  writeFileSync(join(dir, 'b.json'), JSON.stringify(dimensionEnv({ id: 'b', url: '/mcp/v2', platform: 'gemini', profile: 'gemini-text-json', evalMode: 'passive', ts: ts(5) })));
  writeFileSync(join(dir, 'c.json'), JSON.stringify(dimensionEnv({ id: 'c', url: '/mcp', platform: 'chatgpt', profile: 'chatgpt-structured', evalMode: 'active', ts: ts(5) })));
  try {
    const stdout = execFileSync(process.execPath, [
      ANALYZER_SCRIPT, '--dir', dir, '--out', out,
      '--platform', 'gemini', '--eval-mode', 'active', '--last-minutes', '60', '--dry-run',
    ], { encoding: 'utf8' });
    assert.match(stdout, /dry-run: dataStatus=HAS_DATA 0 clusters, 1 requests/);
    assert.match(stdout, /filters=platform=gemini, evalMode=active, lastMinutes=60/);

    let failure;
    try {
      execFileSync(process.execPath, [ANALYZER_SCRIPT, '--dir', dir, '--out', out, '--platform', 'bogus', '--dry-run'], { encoding: 'utf8' });
    } catch (error) { failure = error; }
    assert.ok(failure, 'invalid --platform must fail');
    assert.equal(failure.status, 1);
    assert.match(String(failure.stderr), /invalid --platform "bogus"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Eval closure: deterministic connect/service visibility + empty-window ────

test('eval-closure: analyzer input carries connect/service state and EMPTY_WINDOW is explicit', () => {
  const env = {
    requestId: 'req-services',
    ts: '2026-11-24T06:12:00.000Z',
    clientPlatform: 'gemini',
    evalMode: 'unknown',
    deployment: { commit: '3dd206f' },
    request: {
      method: 'POST', url: '/mcp',
      raw: JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'execute_read', arguments: { code: 'async () => codemode.services()' } } }),
    },
    response: { status: 200, raw: '{"services":[]}', bytes: 14, durationMs: 20 },
    events: [
      { type: 'upstream_connect', payload: { server: 'notion', ok: false, error: { message: '401 invalid_token' } } },
      { type: 'gateway_helper', payload: { helper: 'services', ok: true, services: [
        { name: 'github', toolCount: 42, status: 'observed', online: true },
        { name: 'notion', toolCount: 0, status: 'offline', online: false, needsReauth: true },
      ] } },
    ],
  };
  const withData = buildAnalyzerInput([env], { date: '2026-11-24' });
  assert.equal(withData.dataStatus, 'HAS_DATA');
  assert.equal(withData.connectFailures.failures, 1);
  assert.equal(withData.connectFailures.byServer.notion.errorClasses.auth, 1);
  assert.deepEqual(withData.serviceState.offlineServers, ['notion']);
  assert.equal(withData.serviceState.byServer.notion.needsReauth, true);
  assert.equal(validateAnalyzerOutput({ issues: [] }, withData).dataStatus, 'HAS_DATA');

  const empty = buildAnalyzerInput([], { date: '2026-11-24', filters: { platform: 'gemini', evalMode: 'active', lastMinutes: 60, commit: '3dd206f' } });
  assert.equal(empty.dataStatus, 'EMPTY_WINDOW');
  assert.equal(empty.metrics.requests, 0);
  assert.equal(empty.connectFailures.failures, 0);
  assert.ok(Array.isArray(empty.serviceState.offlineServers));
  assert.equal(validateAnalyzerOutput({ issues: [] }, empty).dataStatus, 'EMPTY_WINDOW');
});


test('G3/G4: analyzer input has a full unsampled requestIndex and empty-window output is deterministic', () => {
  const env = {
    requestId: 'req-index-1',
    ts: '2026-11-24T06:12:00.000Z',
    clientPlatform: 'gemini',
    clientProfile: 'gemini-text-json',
    deployment: { commit: '3dd206f' },
    request: { method: 'POST', url: '/mcp', raw: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list' }) },
    response: { status: 200, raw: '{"result":[]}', bytes: 12, durationMs: 5 },
    events: [],
  };
  const input = buildAnalyzerInput([env], { date: '2026-11-24' });
  assert.equal(input.requestIndex.length, 1);
  assert.equal(input.requestIndex[0].id, 'req-index-1');
  assert.equal(input.requestIndex[0].clientPlatform, 'gemini');
  assert.equal(input.requestIndex[0].buildCommit, '3dd206f');
  assert.equal(input.requestIndex[0].method, 'tools/list');

  const empty = buildAnalyzerInput([], { date: '2026-11-24' });
  const out = buildEmptyWindowAnalyzerOutput(empty);
  assert.equal(out.dataStatus, 'EMPTY_WINDOW');
  assert.equal(out.advisoryOnly, true);
  assert.deepEqual(out.issues, []);
  assert.match(out.summary, /NOT_ENOUGH/);
});

// ── Task C: success-response outline (HTTP-200 blind spot) ──────────────────

/** Successful tools/call capture with an explicit response body (null = overflow). */
function successEnvelope(raw, extra = {}) {
  const body = typeof raw === 'string' ? raw : null;
  return {
    requestId: extra.requestId ?? 'req-success-preview',
    clientPlatform: extra.clientPlatform ?? 'gemini',
    servers: extra.servers ?? ['vercel'],
    request: {
      method: 'POST',
      url: '/mcp',
      raw: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: extra.tool ?? 'execute_read', arguments: { code: 'async () => 1' } },
      }),
    },
    response: { status: 200, raw: body, bytes: body ? body.length : 0, durationMs: 20 },
    events: extra.events ?? [],
  };
}

test('task-C: successful sample carries a bounded responsePreview with nullKeys and nested outline', () => {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: null,
    result: {
      number: null,
      deployments: [{ id: 1 }, { id: 2 }],
      meta: { page: 1, hasMore: false },
    },
  });
  const input = buildAnalyzerInput([successEnvelope(body)], { date: '2026-11-24' });
  assert.equal(input.samples.length, 1);
  const preview = input.samples[0].responsePreview;
  assert.equal(typeof preview.preview, 'string');
  assert.deepEqual(preview.topLevelKeys, ['jsonrpc', 'id', 'result']);
  assert.equal(preview.keyCount, 3);
  assert.deepEqual(preview.nullKeys, ['id']);
  assert.deepEqual(preview.arrays, {});
  assert.deepEqual(preview.nested.result, ['number', 'deployments', 'meta']);
  assert.equal(preview.parseError, undefined);
});

test('task-C: responsePreview is bounded and parse failures keep only the preview', () => {
  const large = JSON.stringify({ big: 'z'.repeat(5000), number: null });
  const largePreview = buildAnalyzerInput(
    [successEnvelope(large, { requestId: 'req-large' })],
    { date: '2026-11-24' },
  ).samples[0].responsePreview;
  assert.match(largePreview.preview, /\[truncated \d+\]/);
  assert.ok(largePreview.preview.length < 560, `preview must stay bounded, got ${largePreview.preview.length}`);
  assert.deepEqual(largePreview.topLevelKeys, ['big', 'number']);
  assert.deepEqual(largePreview.nullKeys, ['number']);

  const broken = buildAnalyzerInput(
    [successEnvelope('ok', { requestId: 'req-broken' })],
    { date: '2026-11-24' },
  ).samples[0].responsePreview;
  assert.deepEqual(broken, { preview: 'ok', parseError: true });

  const absent = buildAnalyzerInput(
    [successEnvelope(null, { requestId: 'req-absent' })],
    { date: '2026-11-24' },
  ).samples[0].responsePreview;
  assert.deepEqual(absent, { preview: null });
});

test('task-C: subCalls carry resultShape on success and truncated name/message on error', () => {
  const events = [
    {
      type: 'upstream',
      payload: {
        server: 'vercel',
        tool: 'vercel__list_deployments',
        result: { number: null, deployments: [{ id: 1, state: 'READY' }, { id: 2, state: 'ERROR' }] },
        durationMs: 12,
      },
    },
    {
      type: 'upstream',
      payload: {
        server: 'github',
        tool: 'github__create_issue',
        error: { name: 'UpstreamError', message: 'boom '.repeat(100), stack: 'SECRET-STACK' },
        durationMs: 8,
      },
    },
  ];
  const sample = buildAnalyzerInput(
    [successEnvelope('{"result":{"content":[]}}', { requestId: 'req-subcalls-shape', events })],
    { date: '2026-11-24' },
  ).samples[0];

  assert.equal(sample.subCalls.length, 2);
  const [successCall, errorCall] = sample.subCalls;
  // Existing sub-call fields are preserved.
  assert.equal(successCall.server, 'vercel');
  assert.equal(successCall.tool, 'vercel__list_deployments');
  assert.equal(successCall.durationMs, 12);
  // Success: structure only, no invented error.
  assert.equal(successCall.error, null);
  assert.deepEqual(successCall.resultShape.topLevelKeys, ['number', 'deployments']);
  assert.deepEqual(successCall.resultShape.nullKeys, ['number']);
  assert.deepEqual(successCall.resultShape.arrays, { deployments: 2 });
  assert.deepEqual(successCall.resultShape.nested.deployments, ['id', 'state']);
  // Error: name/message only (truncated), stack and raw text never leak.
  assert.equal(errorCall.resultShape, null);
  assert.equal(errorCall.error.name, 'UpstreamError');
  assert.match(errorCall.error.message, /\[truncated \d+\]/);
  assert.ok(errorCall.error.message.length < 400, 'sub-call error message must stay bounded');
  assert.ok(!('stack' in errorCall.error), 'stack must be dropped');
  assert.ok(!JSON.stringify(sample.subCalls).includes('SECRET-STACK'));
});

test('task-C: analyzer prompt asks for HTTP-200 semantic friction and attribution', () => {
  const input = buildAnalyzerInput(
    [successEnvelope('{"result":{"number":null}}')],
    { date: '2026-11-24' },
  );
  const messages = analyzerPrompt(input);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'system');
  const system = messages[0].content;
  for (const term of ['responsePreview', 'subCalls', 'clientPlatform', 'servers', 'HTTP-200']) {
    assert.match(system, new RegExp(term), `prompt must mention ${term}`);
  }
  assert.match(system, /null field/i);
  assert.match(system, /double-layer nesting/);
  assert.match(system, /cross-upstream/);
  assert.match(system, /BOUNDED/);

  // The advertised return schema itself must list the two attribution fields.
  const schemaLine = system.split('\n').find((line) => line.startsWith('{"schema":"analyzer-output.v1"'));
  assert.ok(schemaLine, 'prompt must embed the analyzer-output.v1 schema');
  const schema = JSON.parse(schemaLine);
  assert.ok('clientPlatform' in schema.issues[0], 'schema must advertise clientPlatform');
  assert.ok(Array.isArray(schema.issues[0].servers), 'schema must advertise servers[]');

  // The constructed sample data itself reaches the model in the user message.
  assert.match(messages[1].content, /"responsePreview"/);
  assert.match(messages[1].content, /"subCalls"/);
});

test('task-C: validateAnalyzerOutput keeps clientPlatform/servers and strips unknown types', () => {
  const input = { clusters: [{ id: 'c1', sampleEventIds: ['req-a', 'req-b', 'req-c', 'req-d'] }], limits: { maxIssues: 5 } };
  const output = validateAnalyzerOutput({
    summary: 'summary',
    issues: [
      {
        severity: 'P2', category: 'gateway', title: 'with attribution', evidenceEventIds: ['req-a'],
        clientPlatform: ' gemini ', servers: ['github', 'github', ' vercel ', 42, null, { name: 'x' }, ''],
      },
      { severity: 'P3', category: 'upstream', title: 'no attribution', evidenceEventIds: ['req-b'] },
      {
        severity: 'P2', category: 'data', title: 'bad attribution types', evidenceEventIds: ['req-c'],
        clientPlatform: 42, servers: 'github',
      },
      {
        severity: 'P3', category: 'model', title: 'capped attribution', evidenceEventIds: ['req-d'],
        clientPlatform: 'p'.repeat(200), servers: Array.from({ length: 12 }, (_, i) => `server-${i}`),
      },
    ],
  }, input);

  assert.equal(output.issues.length, 4, 'missing/unknown attribution must never drop an issue');
  assert.equal(output.issues[0].clientPlatform, 'gemini');
  assert.deepEqual(output.issues[0].servers, ['github', 'vercel']);
  assert.equal(output.issues[1].clientPlatform, null);
  assert.deepEqual(output.issues[1].servers, []);
  assert.equal(output.issues[2].clientPlatform, null);
  assert.deepEqual(output.issues[2].servers, []);
  assert.match(output.issues[3].clientPlatform, /\[truncated \d+\]/);
  assert.ok(output.issues[3].clientPlatform.length < 80, 'clientPlatform must stay bounded');
  assert.equal(output.issues[3].servers.length, 8, 'servers are capped at eight entries');
});

test('task-C: responsePreview and subCallError redact secret-shaped tokens', () => {
  const token = `ghp_${'a'.repeat(36)}`;
  const env = envelope(200, JSON.stringify({ token, access_token: 'json-secret-value', nested: { authorization: 'Bearer top-secret-value' } }), {
    requestId: 'req-secret-preview',
    events: [{ type: 'upstream', payload: { server: 'github', tool: 'github__x', ok: false, error: { name: 'Error', message: 'Bearer top-secret-value' } } }],
  });
  const sample = buildAnalyzerInput([env], { date: '2026-11-24' }).samples[0];
  assert.equal(sample.responsePreview.preview.includes(token), false);
  assert.equal(sample.responsePreview.preview.includes('top-secret-value'), false);
  assert.equal(sample.responsePreview.preview.includes('json-secret-value'), false);
  assert.equal(sample.subCalls[0].error.message.includes('top-secret-value'), false);
});


test('task-C: cluster sampleError redacts JSON key/value secrets too', () => {
  const env = envelope(500, JSON.stringify({ error: 'upstream failed', access_token: 'error-json-secret' }), { requestId: 'req-error-secret' });
  const cluster = buildAnalyzerInput([env], { date: '2026-11-24' }).clusters.find((row) => row.sampleEventIds.includes('req-error-secret'));
  assert.ok(cluster);
  assert.equal(cluster.sampleError.includes('error-json-secret'), false);
});

// ── Wire shape: runtime-encoding fingerprint (M1 verification seam) ─────────

test('wireShape: structuredContent in the captured body proves the chatgpt profile encoded it', () => {
  const structured = JSON.stringify({
    result: { content: [{ type: 'text', text: '{"ok":1}' }], structuredContent: { ok: 1 } },
  });
  const textOnly = JSON.stringify({ result: { content: [{ type: 'text', text: '{"ok":1}' }] } });
  const input = buildAnalyzerInput([
    envelope(200, structured, { requestId: 'req-gpt', ts: '2026-11-24T19:24:00.000Z' }),
    envelope(200, textOnly, { requestId: 'req-gem', ts: '2026-11-24T19:23:00.000Z' }),
    { ...envelope(200, textOnly, { requestId: 'req-rawless' }), response: { status: 200 } },
  ], { date: '2026-11-24', platform: 'gemini' });
  // platform filter is gemini, so only assert per-row wireShape here.
  const byId = Object.fromEntries(input.requestIndex.map((row) => [row.id, row.wireShape]));
  assert.equal(byId['req-gem'], 'textJson');
  assert.equal(byId['req-rawless'], 'unknown');

  const all = buildAnalyzerInput([
    envelope(200, structured, { requestId: 'req-gpt', ts: '2026-11-24T19:24:00.000Z' }),
    envelope(200, textOnly, { requestId: 'req-gem', ts: '2026-11-24T19:23:00.000Z' }),
  ], { date: '2026-11-24' });
  const rows = all.wireShape.byClientPlatform;
  // No clientPlatform in these envelopes -> single unknown bucket, but the
  // fingerprint itself must still be counted correctly.
  assert.equal(rows.unknown.unknown, 0);
  assert.equal(rows.unknown.structuredContent + rows.unknown.textJson, 2);
  assert.match(all.wireShape.note, /captured response bodies/);
});

test('wireShape: tolerates whitespace before the structuredContent colon', () => {
  const spaced = '{"result":{"structuredContent"  :{"a":1}}}';
  const input = buildAnalyzerInput([envelope(200, spaced, { requestId: 'req-ws' })], { date: '2026-11-24' });
  assert.equal(input.requestIndex[0].wireShape, 'structuredContent');
});
