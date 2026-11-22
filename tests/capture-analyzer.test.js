import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAnalyzerInput, validateAnalyzerOutput } from '../scripts/analyze-captures.mjs';

function envelope(status, raw, extra = {}) {
  return {
    requestId: extra.requestId ?? `req-${Math.random()}`,
    request: { raw: JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { name: extra.tool ?? 'github__get_file_contents', arguments: { code: extra.code } } }) },
    response: { status, raw, bytes: raw.length, durationMs: extra.durationMs ?? 10 },
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
