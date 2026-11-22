import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAnalyzerInput, validateAnalyzerOutput, dailyTrend, renderWeeklyReview, isoWeek,
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
