import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateEnvelopes, classifyError, renderScorecard } from '../scripts/capture-digest.mjs';

const envelope = (status, durationMs, raw = '{}') => ({
  request: { method: 'POST', url: '/mcp', raw: JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'github__get_file_contents' } }) },
  response: { status, durationMs, bytes: raw.length, raw, overflow: false },
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
});

test('capture digest classifies auth/timeout/rate-limit and renders a scorecard', () => {
  assert.equal(classifyError(envelope(401, 1, '{"error":"invalid_token"}')), 'auth');
  assert.equal(classifyError(envelope(429, 1, '{"error":"rate limit"}')), 'rate_limit');
  assert.equal(classifyError(envelope(200, 1, '{"error":"execute error: timeout"}')), 'timeout');
  const md = renderScorecard('2026-11-22', aggregateEnvelopes([envelope(200, 10)]));
  assert.match(md, /# Capture Scorecard — 2026-11-22/);
  assert.match(md, /Requests \| 1/);
  assert.match(md, /Raw payloads remain in R2/);
});

