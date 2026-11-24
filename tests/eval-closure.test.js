/**
 * Eval closure (M5-E): active-eval record → same-window passive comparison →
 * status drift. Deterministic, zero-network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTIVE_EVAL_SCHEMA, buildActiveEval, validateActiveEval,
} from '../scripts/record-active-eval.mjs';
import { compareActivePassive } from '../scripts/compare-active-passive.mjs';
import {
  checkStatusDrift, parseDeploymentLog, parseStatusDoc,
} from '../scripts/check-status-drift.mjs';

const REQ_ID = '0442a80c-85a2-4fc1-a0fa-d8697ed42650';

function activeRecord(overrides = {}) {
  return {
    platform: 'gemini',
    buildCommit: '3dd206f',
    window: { from: '2026-11-24T06:00:00.000Z', to: '2026-11-24T06:20:00.000Z' },
    anchors: {
      repos: ['Bruce-Yii/gemini-mcp-gateway'],
      prs: [22],
      issues: [15],
      branches: ['main'],
      files: ['src/evidence/capture.js'],
      startAction: 'read src/evidence/capture.js',
      endAction: 'call codemode.services()',
    },
    prompt: '原始主动评测原文（逐字保存）',
    expected: { outcome: 'services 显示 3 online + 2 offline', tools: ['services'], checks: ['offline visible'] },
    observed: {
      tools: ['execute_read'],
      results: ['services snapshot'],
      errors: [],
      requestIds: [REQ_ID],
      captureVerified: true,
      services: [
        { name: 'github', status: 'observed', needsReauth: false },
        { name: 'notion', status: 'offline', needsReauth: true },
      ],
      connectFailures: ['notion'],
    },
    source: { window: 'dev lead window', messageAt: '2026-11-24T06:20:30.000Z' },
    ...overrides,
  };
}

function passiveInput(overrides = {}) {
  return {
    schema: 'analyzer-input.v1',
    dataStatus: 'HAS_DATA',
    filters: { platform: '', evalMode: '', lastMinutes: 60, commit: '3dd206f' },
    metrics: { requests: 3, errors: 0 },
    samples: [{
      id: REQ_ID,
      ts: '2026-11-24T06:12:00.000Z',
      clientPlatform: 'gemini',
      clientProfile: 'gemini-text-json',
      protocolVersion: 'v1',
      buildCommit: '3dd206f',
      servers: ['github'],
      tool: 'execute_read',
    }],
    dimensions: {
      byClientPlatform: [{ platform: 'gemini', requestIdSamples: [REQ_ID] }],
      byFourDimension: [{ clientPlatform: 'gemini', requestIdSamples: [REQ_ID] }],
    },
    serviceState: {
      snapshots: 1,
      byServer: {
        github: { snapshots: 1, toolCount: 42, statuses: { observed: 1 }, needsReauth: false },
        notion: { snapshots: 1, toolCount: 0, statuses: { offline: 1 }, needsReauth: true },
      },
      offlineServers: ['notion'],
    },
    connectFailures: { failures: 1, byServer: { notion: { failures: 1, errorClasses: { auth: 1 } } } },
    ...overrides,
  };
}

// ── active-eval record ─────────────────────────────────────────────────────

test('active-eval: valid record builds a stable id and validates', () => {
  const errors = validateActiveEval(activeRecord());
  assert.deepEqual(errors, []);
  const built = buildActiveEval(activeRecord(), { now: '2026-11-24T06:21:00.000Z' });
  assert.equal(built.schema, ACTIVE_EVAL_SCHEMA);
  assert.match(built.activeEvalId, /^ae_20261124_[0-9a-f]{8}$/);
  assert.equal(built.recordedAt, '2026-11-24T06:21:00.000Z');
  assert.equal(built.observed.requestIds[0], REQ_ID);
  assert.equal(built.observed.services[1].name, 'notion');
  // Deterministic: same input + same now → byte-identical.
  assert.deepEqual(built, buildActiveEval(activeRecord(), { now: '2026-11-24T06:21:00.000Z' }));
});

test('active-eval: invalid platform/window/requestId are rejected, never fabricated', () => {
  assert.ok(validateActiveEval(activeRecord({ platform: 'nope' })).some((e) => /platform/.test(e)));
  assert.ok(validateActiveEval(activeRecord({ window: { from: 'not-a-date', to: '2026-11-24T06:20:00Z' } })).some((e) => /window.from/.test(e)));
  assert.ok(validateActiveEval(activeRecord({ window: { from: '2026-11-24T07:00:00Z', to: '2026-11-24T06:00:00Z' } })).some((e) => /before window.from/.test(e)));
  assert.ok(validateActiveEval(activeRecord({ buildCommit: 'xyz' })).some((e) => /buildCommit/.test(e)));
  assert.ok(validateActiveEval(activeRecord({ anchors: { startAction: '', endAction: '' } })).some((e) => /startAction/.test(e)));
  assert.throws(
    () => buildActiveEval(activeRecord({ observed: { requestIds: ['not-a-uuid'] } })),
    /neither a UUID nor "unknown"/,
  );
});

// ── active ↔ passive comparison ────────────────────────────────────────────

test('compare: exact requestId match + services/connect coverage', () => {
  const active = buildActiveEval(activeRecord(), { now: '2026-11-24T06:21:00.000Z' });
  const result = compareActivePassive(active, passiveInput());
  assert.equal(result.match, 'exact');
  assert.deepEqual(result.requestIds.matched, [REQ_ID]);
  assert.equal(result.checks.build, 'match');
  assert.equal(result.checks.platform, 'match');
  assert.equal(result.checks.window, 'match');
  assert.equal(result.missed.length, 0);
  assert.equal(result.coverage.find((row) => row.subject === 'notion').covered, true);
});

test('compare: EMPTY_WINDOW is unmatched, never a pass', () => {
  const active = buildActiveEval(activeRecord(), { now: '2026-11-24T06:21:00.000Z' });
  const result = compareActivePassive(active, { dataStatus: 'EMPTY_WINDOW', metrics: { requests: 0 } });
  assert.equal(result.match, 'unmatched');
  assert.equal(result.passive.dataStatus, 'EMPTY_WINDOW');
  assert.ok(result.reasons.some((reason) => /EMPTY_WINDOW/.test(reason)));
  // With no passive service snapshot, the expected offline service is a missed item.
  assert.ok(result.missed.some((row) => row.subject === 'notion' && row.reason === 'no-services-snapshot'));
});

test('compare: build mismatch is reported and prevents a hard comparison', () => {
  const active = buildActiveEval(activeRecord({ buildCommit: '3dd206f' }), { now: '2026-11-24T06:21:00.000Z' });
  const passive = passiveInput();
  passive.filters.commit = '9ab0e57';
  passive.samples[0].buildCommit = '9ab0e57';
  const result = compareActivePassive(active, passive);
  assert.equal(result.checks.build, 'mismatch');
  assert.equal(result.match, 'weak', 'build differs → downgrade to weak, never claim exact/likely');
  assert.ok(result.reasons.some((reason) => /do not hard-compare/.test(reason)));
});

test('compare: service visible but status differs → missed with a reason', () => {
  const active = buildActiveEval(activeRecord(), { now: '2026-11-24T06:21:00.000Z' });
  const passive = passiveInput();
  passive.serviceState.byServer.notion = { snapshots: 1, toolCount: 0, statuses: { observed: 1 }, needsReauth: false };
  passive.serviceState.offlineServers = [];
  passive.connectFailures = { failures: 0, byServer: {} };
  const result = compareActivePassive(active, passive);
  assert.ok(result.missed.some((row) => row.subject === 'notion' && row.reason === 'passive-status-differs'));
});

// ── status drift ───────────────────────────────────────────────────────────

const DEPLOYMENTS = `
| 时间 | Commit | 方式 | 目的 | 结果 | 证据 |
|---|---|---|---|---|---|
| 2026-11-24 13:43 | \`3dd206f\` | CLI | deploy issue15 | READY | healthz |
| 2026-11-24 14:02 | \`3dd206f\` | CLI | env redeploy | READY | healthz |
`;

test('status-drift: parses the latest READY deployment and stale references', () => {
  const parsed = parseDeploymentLog(DEPLOYMENTS);
  assert.equal(parsed.latest, '3dd206f');
  assert.equal(parsed.rows.length, 2);
  assert.ok(parseStatusDoc('生产已部署 `5039ac6`').some((ref) => ref.commit === '5039ac6'));
  const stale = checkStatusDrift({
    deploymentLog: DEPLOYMENTS,
    documents: [
      { path: 'AGENTS.md', text: '生产已部署 `5039ac6`\n当前生产：`3dd206f`' },
      { path: 'docs/STATUS.md', text: '| 生产部署（Vercel） | **`3dd206f`** |' },
    ],
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.expected, '3dd206f');
  assert.equal(stale.violations.length, 1);
  assert.equal(stale.violations[0].claimed, '5039ac6');
});

test('status-drift: aligned documents pass; missing expectation fails', () => {
  const aligned = checkStatusDrift({
    deploymentLog: DEPLOYMENTS,
    documents: [{ path: 'AGENTS.md', text: '当前生产：`3dd206f`' }],
  });
  assert.equal(aligned.ok, true);
  const missing = checkStatusDrift({ deploymentLog: 'no table here', documents: [{ path: 'AGENTS.md', text: 'x' }] });
  assert.equal(missing.ok, false);
  assert.ok(missing.violations.some((row) => row.kind === 'missing-expectation'));
});
