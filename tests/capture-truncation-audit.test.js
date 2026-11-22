/**
 * Batch 11 (P0): model-side silent truncation must be detectable by
 * capture / digest / analyzer, not just patched once in a README.
 *
 * All rules are deterministic and byte-based. These tests pin the false-positive
 * boundaries as tightly as the true-positive case.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildModelOutputAudit, startCapture } from '../src/capture.js';
import {
  aggregateEnvelopes, isModelTruncationSuspect, renderScorecard,
} from '../scripts/capture-digest.mjs';
import { buildAnalyzerInput, validateAnalyzerOutput } from '../scripts/analyze-captures.mjs';

const FULL = 'A'.repeat(1000);
const upstream = (result = FULL) => ({
  type: 'upstream',
  payload: { server: 'github', tool: 'get_file_contents', result },
});
const sandbox = (result, extra = {}) => ({
  type: 'sandbox',
  payload: { tool: 'execute_read', code: 'async () => ...', output: { result, logs: [], toolCalls: [], ...extra } },
});
function env({ events = [], requestId = 'req-1', sessionId = null, response = {} } = {}) {
  const resolvedResponse = { status: 200, bytes: 1000, durationMs: 10, raw: 'ok', ...response };
  return {
    requestId,
    ...(sessionId ? { sessionId } : {}),
    ts: '2026-11-23T03:00:00.000Z',
    request: {
      method: 'POST', url: '/mcp',
      raw: JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'execute_read' } }),
    },
    events,
    response: resolvedResponse,
    // Mirrors the additive stamp capture.js writes into every envelope.
    model: buildModelOutputAudit({ events, response: resolvedResponse }),
  };
}

/* ---------------- capture.js envelope audit fields ---------------- */

test('audit: full upstream output reaching the model is not flagged', () => {
  const audit = buildModelOutputAudit({ events: [upstream(), sandbox(FULL)] });
  assert.equal(audit.sourceBytes, 1000);
  assert.equal(audit.modelOutputBytes, 1000);
  assert.equal(audit.possibleModelTruncation, false);
  assert.ok(audit.modelOutput);
  assert.equal(audit.modelOutput.length, 1000);
  assert.match(audit.modelOutput.sha256, /^[0-9a-f]{16}$/);
  assert.ok(audit.modelOutput.summary.length <= 161);
});

test('audit: model output short with no marker is detected', () => {
  const audit = buildModelOutputAudit({ events: [upstream(), sandbox(FULL.slice(0, 150))] });
  assert.equal(audit.sourceBytes, 1000);
  assert.equal(audit.modelOutputBytes, 150);
  assert.equal(audit.possibleModelTruncation, true);
});

test('audit: explicit truncated:true is not flagged', () => {
  const audit = buildModelOutputAudit({
    events: [upstream(), sandbox(FULL.slice(0, 150), { truncated: true })],
  });
  assert.equal(audit.modelOutputBytes, 150);
  assert.equal(audit.possibleModelTruncation, false);
});

test('audit: a wire truncation marker is not flagged', () => {
  const audit = buildModelOutputAudit({
    events: [upstream(), sandbox(`${FULL.slice(0, 150)}…[truncated 850]`)],
  });
  assert.equal(audit.possibleModelTruncation, false);
});

test('audit: no sandbox output and no upstream source are not flagged', () => {
  const noSandbox = buildModelOutputAudit({ events: [upstream()] });
  assert.deepEqual(noSandbox, {
    modelOutput: null, sourceBytes: 0, modelOutputBytes: 0, possibleModelTruncation: false,
  });
  const noUpstream = buildModelOutputAudit({ events: [sandbox('short')] });
  assert.equal(noUpstream.sourceBytes, 0);
  assert.equal(noUpstream.possibleModelTruncation, false);
});

test('audit: slightly shorter output above the 50% threshold is not flagged', () => {
  // 900 vs 1000 bytes: a legitimate summary, not a silent truncation.
  const audit = buildModelOutputAudit({ events: [upstream(), sandbox(FULL.slice(0, 900))] });
  assert.equal(audit.possibleModelTruncation, false);
});

test('audit: gateway overflow is unrelated and never triggers the model flag', () => {
  const audit = buildModelOutputAudit({
    events: [upstream(), sandbox(FULL)],
    response: { overflow: true },
  });
  assert.equal(audit.possibleModelTruncation, false);
});

test('capture envelope carries the additive model audit block without changing capture fields', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gmg-trunc-audit-'));
  try {
    const req = { method: 'POST', url: '/mcp', headers: {}, __gatewayRawBody: '{}' };
    const res = {
      statusCode: 200,
      headers: {},
      writeHead(status) { this.statusCode = status; },
      getHeaders() { return this.headers; },
      write() { return true; },
      end(chunk) { if (chunk) this.body = String(chunk); return this; },
    };
    startCapture(req, res, { mode: 'full', sink: 'file', fileDir: dir });
    // Import lazily so the capture context (AsyncLocalStorage) is active.
    const { captureEvent } = await import('../src/capture.js');
    captureEvent('upstream', { server: 'github', tool: 'get_file_contents', result: FULL });
    captureEvent('sandbox', { tool: 'execute_read', code: 'x', output: { result: FULL.slice(0, 150), logs: [], toolCalls: [] } });
    res.end('{"ok":true}');
    await new Promise((resolve) => setTimeout(resolve, 150));
    const files = await readdir(dir);
    const envelope = JSON.parse(await readFile(join(dir, files[0]), 'utf8'));
    assert.equal(envelope.schema, 'gmg.capture.v1');
    assert.equal(envelope.response.raw, '{"ok":true}');
    assert.equal(envelope.response.overflow, false);
    assert.equal(envelope.model.sourceBytes, 1000);
    assert.equal(envelope.model.modelOutputBytes, 150);
    assert.equal(envelope.model.possibleModelTruncation, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* ---------------- digest counts + aggregations ---------------- */

test('digest counts model truncation suspects separately from gateway truncation/overflow', () => {
  const clean = env({ events: [upstream(), sandbox(FULL)], response: { truncated: true } });
  const gatewayOverflow = env({ events: [upstream(), sandbox(FULL)], response: { overflow: true } });
  const suspect = env({
    events: [upstream(), sandbox(FULL.slice(0, 150))],
    requestId: 'req-suspect', sessionId: 'sess-1',
  });
  const metrics = aggregateEnvelopes([clean, gatewayOverflow, suspect]);
  assert.equal(metrics.truncated, 1, 'gateway wire truncation stays in its own bucket');
  assert.equal(metrics.overflow, 1, 'capture overflow stays in its own bucket');
  assert.equal(metrics.model_truncation_suspects, 1);
  assert.equal(metrics.modelTruncationRate, 0.3333);
  assert.deepEqual(metrics.modelTruncationByServer, { github: 1 });
  assert.deepEqual(metrics.modelTruncationByTool, { execute_read: 1 });
  assert.deepEqual(metrics.modelTruncationBySession, { 'sess-1': 1 });
  assert.equal(metrics.upstreamStats.github.modelTruncationSuspects, 1);
  assert.equal(metrics.toolStats.execute_read.modelTruncationSuspects, 1);
});

test('digest isModelTruncationSuspect trusts only the deterministic envelope flag', () => {
  assert.equal(isModelTruncationSuspect({ model: { possibleModelTruncation: true } }), true);
  assert.equal(isModelTruncationSuspect({ model: { possibleModelTruncation: false } }), false);
  assert.equal(isModelTruncationSuspect({ response: { raw: 'truncated in code' } }), false);
  assert.equal(isModelTruncationSuspect({}), false);
});

test('scorecard renders model truncation stats in a dedicated section', () => {
  const metrics = aggregateEnvelopes([
    env({ events: [upstream(), sandbox(FULL.slice(0, 150))], sessionId: 'sess-9' }),
  ]);
  const md = renderScorecard('2026-11-23', metrics);
  assert.match(md, /Model truncation suspects \(silent, advisory\) \| 1/);
  assert.match(md, /### Model truncation suspects by server/);
  assert.match(md, /\| github \| 1 \|/);
  assert.match(md, /\| sess-9 \| 1 \|/);
  assert.match(md, /advisory-only/);
});

/* ---------------- analyzer independent advisory cluster ---------------- */

test('analyzer emits an independent model_truncation cluster keeping requestId and sessionId', () => {
  const suspect = env({
    events: [upstream(), sandbox(FULL.slice(0, 150))],
    requestId: '363fd3e7-a9ff-44b7-b2f0-c1e4c27329b6',
    sessionId: 'sess-r2',
  });
  const input = buildAnalyzerInput([
    env({ events: [upstream(), sandbox(FULL)], requestId: 'clean-1' }),
    suspect,
  ], { date: '2026-11-23' });
  assert.equal(input.truncationSuspects.length, 1);
  const row = input.truncationSuspects[0];
  assert.equal(row.requestId, '363fd3e7-a9ff-44b7-b2f0-c1e4c27329b6');
  assert.equal(row.sessionId, 'sess-r2');
  assert.equal(row.sourceBytes, 1000);
  assert.equal(row.modelOutputBytes, 150);
  const cluster = input.clusters.find((c) => c.kind === 'model_truncation_suspect');
  assert.ok(cluster);
  assert.equal(cluster.advisoryOnly, true);
  assert.deepEqual(cluster.sampleEventIds, ['363fd3e7-a9ff-44b7-b2f0-c1e4c27329b6']);
  // Validator rules are unchanged: suspect ids are valid evidence because they
  // are exposed as a cluster, not because the validator was loosened.
  const validated = validateAnalyzerOutput({
    issues: [{
      severity: 'P1', category: 'model', title: 'silent truncation candidate',
      evidenceEventIds: ['363fd3e7-a9ff-44b7-b2f0-c1e4c27329b6'],
    }],
  }, input);
  assert.equal(validated.issues.length, 1);
  assert.equal(validated.advisoryOnly, true);
  assert.equal(validated.requiresHumanReview, true);
});

test('analyzer produces no truncation cluster when captures are healthy', () => {
  const input = buildAnalyzerInput([
    env({ events: [upstream(), sandbox(FULL)], requestId: 'ok-1' }),
    env({ events: [upstream(), sandbox(FULL.slice(0, 150), { truncated: true })], requestId: 'marked-1' }),
  ], { date: '2026-11-23' });
  assert.equal(input.truncationSuspects.length, 0);
  assert.ok(!input.clusters.some((c) => c.kind === 'model_truncation_suspect'));
});

test('analyzer keeps both evidence requestIds from the real incidents auditable', () => {
  const ids = [
    '363fd3e7-a9ff-44b7-b2f0-c1e4c27329b6',
    '21896fe1-da1c-4682-93b9-1c8c53f5405c',
  ];
  const input = buildAnalyzerInput(ids.map((requestId, i) => env({
    events: [upstream(), sandbox(FULL.slice(0, 150))],
    requestId, sessionId: `sess-${i}`,
  })), { date: '2026-11-23' });
  assert.deepEqual(input.truncationSuspects.map((row) => row.requestId), ids);
  assert.equal(input.clusters.find((c) => c.kind === 'model_truncation_suspect').count, 2);
});
