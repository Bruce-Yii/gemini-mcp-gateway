/**
 * R2 real-traffic distillation (design: docs/eval/R2-DISTILLATION-DESIGN.md).
 *
 * Deterministic, offline: every case builds a synthetic analyzer-input in
 * memory, so nothing here touches R2 or the network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CANDIDATES_SCHEMA,
  detectSignals,
  distill,
  fingerprintOf,
  priorityScore,
  applySignal,
  emptyPool,
} from '../scripts/distill-r2-candidates.mjs';
import {
  rebuildIndex,
  rejectCandidate,
  promoteCandidate,
  validatePromotion,
} from '../scripts/promote-eval-candidate.mjs';

/* ── synthetic analyzer-input helpers ─────────────────────────────────────── */

const row = (id, ts, overrides = {}) => ({
  id,
  ts,
  clientPlatform: 'gemini',
  clientProfile: 'gemini-text-json',
  protocolVersion: 'v1',
  buildCommit: '1328787',
  method: 'tools/call',
  tool: 'execute_read',
  status: 200,
  durationMs: 100,
  servers: ['github'],
  wireShape: 'textJson',
  ...overrides,
});

const sample = (id, overrides = {}) => ({
  id,
  ts: '2026-11-24T19:00:10.000Z',
  clientPlatform: 'gemini',
  clientProfile: 'gemini-text-json',
  protocolVersion: 'v1',
  executor: 'codemode',
  buildCommit: '1328787',
  servers: ['github'],
  tool: 'execute_read',
  code: 'async () => 1',
  status: 200,
  durationMs: 120,
  bytes: 1000,
  subCalls: [],
  responsePreview: { preview: '{"result":{"ok":1}}' },
  truncated: false,
  ...overrides,
});

const input = (rows, samples = []) => ({
  schema: 'analyzer-input.v1',
  date: '2026-11-24',
  dataStatus: 'HAS_DATA',
  requestIndex: rows,
  samples,
  clusters: [],
  metrics: { requests: rows.length, errors: 0 },
});

/* ── stage 1: six triggers ────────────────────────────────────────────────── */

test('trigger retry_loop: failed call retried within 5 minutes', () => {
  const signals = detectSignals({
    input: input([
      row('a', '2026-11-24T19:00:00.000Z', { status: 500, tool: 'github__get_file_contents' }),
      row('b', '2026-11-24T19:02:00.000Z', { tool: 'github__get_file_contents' }),
    ]),
  });
  const hit = signals.find((signal) => signal.signal === 'retry_loop');
  assert.ok(hit, 'retry within window must trigger');
  assert.deepEqual(hit.requestIds, ['a', 'b']);
  assert.equal(hit.upstream, 'github');
});

test('trigger retry_loop boundary: success first, or gap > 5 min, does not trigger', () => {
  const successFirst = detectSignals({
    input: input([
      row('a', '2026-11-24T19:00:00.000Z', { tool: 'github__get_file_contents' }),
      row('b', '2026-11-24T19:01:00.000Z', { tool: 'github__get_file_contents' }),
    ]),
  });
  assert.equal(successFirst.filter((signal) => signal.signal === 'retry_loop').length, 0);

  const tooLate = detectSignals({
    input: input([
      row('a', '2026-11-24T19:00:00.000Z', { status: 500, tool: 'github__get_file_contents' }),
      row('b', '2026-11-24T19:06:00.000Z', { tool: 'github__get_file_contents' }),
    ]),
  });
  assert.equal(tooLate.filter((signal) => signal.signal === 'retry_loop').length, 0);
});

test('trigger search_thrash: 4 consecutive searches without execute', () => {
  const rows = ['a', 'b', 'c', 'd'].map((id, index) => (
    row(id, `2026-11-24T19:0${index}:00.000Z`, { tool: 'search' })
  ));
  const signals = detectSignals({ input: input(rows) });
  const hit = signals.find((signal) => signal.signal === 'search_thrash');
  assert.ok(hit);
  assert.equal(hit.requestIds.length, 4);
  assert.equal(hit.tool, 'search');
});

test('trigger search_thrash: interrupted by execute is not a run', () => {
  const rows = [
    row('a', '2026-11-24T19:00:00.000Z', { tool: 'search' }),
    row('b', '2026-11-24T19:00:30.000Z', { tool: 'search' }),
    row('c', '2026-11-24T19:01:00.000Z', { tool: 'execute_read' }),
    row('d', '2026-11-24T19:01:30.000Z', { tool: 'search' }),
    row('e', '2026-11-24T19:02:00.000Z', { tool: 'search' }),
  ];
  const signals = detectSignals({ input: input(rows) });
  assert.equal(signals.filter((signal) => signal.signal === 'search_thrash').length, 0);
});

test('trigger truncation_reread: truncated response then reread within 2 calls', () => {
  const rows = [
    row('a', '2026-11-24T19:00:00.000Z', { tool: 'github__get_file_contents' }),
    row('b', '2026-11-24T19:00:30.000Z', { tool: 'github__get_file_contents' }),
  ];
  const samples = [sample('a', { tool: 'github__get_file_contents', truncated: true })];
  const signals = detectSignals({ input: input(rows, samples) });
  const hit = signals.find((signal) => signal.signal === 'truncation_reread');
  assert.ok(hit);
  assert.deepEqual(hit.requestIds, ['a', 'b']);
  assert.equal(hit.errorShape, 'truncated');
});

test('trigger semantic_200_gap: null number/url on HTTP 200', () => {
  const signals = detectSignals({
    input: input(
      [row('a', '2026-11-24T19:00:00.000Z', { tool: 'github__merge_pull_request' })],
      [sample('a', {
        status: 200,
        tool: 'github__merge_pull_request',
        responsePreview: { preview: '{"result":{"number":null,"url":null}}', nullKeys: ['number', 'url'] },
      })],
    ),
  });
  const hit = signals.find((signal) => signal.signal === 'semantic_200_gap');
  assert.ok(hit);
  assert.equal(hit.errorShape, 'null:number+url');
  assert.deepEqual(hit.evidence.nullKeys, ['number', 'url']);
});

test('trigger semantic_200_gap: dryRun / written:0 on a write path', () => {
  const signals = detectSignals({
    input: input(
      [row('a', '2026-11-24T19:00:00.000Z', { tool: 'execute' })],
      [sample('a', {
        status: 200,
        tool: 'execute',
        responsePreview: { preview: '{"ok":true,"dryRun":true,"written":0}' },
      })],
    ),
  });
  assert.ok(signals.some((signal) => signal.signal === 'semantic_200_gap'));
});

test('trigger slow_or_unexpected: >8000ms and non-2xx, OBS-001 whitelisted', () => {
  const slow = detectSignals({
    input: input([row('a', '2026-11-24T19:00:00.000Z', { durationMs: 8001 })]),
  });
  assert.ok(slow.some((signal) => signal.signal === 'slow_or_unexpected'));

  const bad = detectSignals({
    input: input([row('a', '2026-11-24T19:00:00.000Z', { status: 502 })]),
  });
  assert.ok(bad.some((signal) => signal.signal === 'slow_or_unexpected'));

  // OBS-001: ChatGPT server/discover 400 is expected protocol negotiation.
  const whitelisted = detectSignals({
    input: input([row('a', '2026-11-24T19:00:00.000Z', {
      clientPlatform: 'chatgpt',
      tool: null,
      method: 'server/discover',
      status: 400,
      durationMs: 18,
    })]),
  });
  assert.equal(whitelisted.filter((signal) => signal.signal === 'slow_or_unexpected').length, 0);
});

test('trigger client_divergence: same build+tool error-rate gap >= 25%', () => {
  const rows = [];
  for (let i = 0; i < 6; i += 1) {
    rows.push(row(`g${i}`, `2026-11-24T19:0${i}:00.000Z`, { clientPlatform: 'gemini', tool: 'notion__search' }));
  }
  for (let i = 0; i < 6; i += 1) {
    rows.push(row(`c${i}`, `2026-11-24T19:1${i}:00.000Z`, {
      clientPlatform: 'chatgpt',
      tool: 'notion__search',
      status: i < 3 ? 500 : 200,
    }));
  }
  const signals = detectSignals({ input: input(rows) });
  const hit = signals.find((signal) => signal.signal === 'client_divergence');
  assert.ok(hit);
  assert.equal(hit.tool, 'notion__search');
  assert.deepEqual(hit.affectedClients.sort(), ['chatgpt', 'gemini']);
  assert.equal(hit.evidence.roundsAvailable, false);
});

/* ── stage 2/3: fingerprint, priority, blacklist, redaction ───────────────── */

test('fingerprint: deterministic and sensitive to upstream/tool/signal/shape', () => {
  const base = { upstream: 'github', tool: 'get_file_contents', primarySignal: 'retry_loop', normalizedErrorShape: 'status:500|none' };
  assert.equal(fingerprintOf(base), fingerprintOf({ ...base }));
  assert.equal(fingerprintOf(base).length, 16);
  assert.notEqual(fingerprintOf(base), fingerprintOf({ ...base, tool: 'other' }));
  assert.notEqual(fingerprintOf(base), fingerprintOf({ ...base, normalizedErrorShape: 'status:502|none' }));
});

test('priorityScore: severity * log2(seen+1) * 1.5 for 2+ clients', () => {
  assert.equal(priorityScore({ severityWeight: 3, seenCount: 1, affectedClients: ['gemini'] }), 3);
  assert.equal(priorityScore({ severityWeight: 4, seenCount: 3, affectedClients: ['gemini', 'chatgpt'] }), 12);
  assert.equal(priorityScore({ severityWeight: 2, seenCount: 7, affectedClients: [] }), 6);
});

test('dedupe: same fingerprint merges instead of creating a second candidate', () => {
  const signal = {
    signal: 'retry_loop',
    upstream: 'github',
    tool: 'get_file_contents',
    platform: 'gemini',
    buildCommit: '1328787',
    requestIds: ['a', 'b'],
    evidence: { firstStatus: 500 },
  };
  const now = new Date('2026-11-25T00:00:00Z');
  const first = distill({ input: input([]), pool: emptyPool(now), now });
  const applied = applySignal(first.pool, signal, { now });
  assert.equal(applied.created, true);
  const second = applySignal(applied.pool, { ...signal, platform: 'chatgpt', requestIds: ['c'] }, { now });
  assert.equal(second.created, false);
  assert.equal(second.pool.candidates.length, 1);
  const candidate = second.pool.candidates[0];
  assert.equal(candidate.seenCount, 2);
  assert.deepEqual(candidate.affectedClients.sort(), ['chatgpt', 'gemini']);
  assert.deepEqual(candidate.sampleRequestIds.sort(), ['a', 'b', 'c']);
  assert.ok(candidate.priorityScore > 3, 'multi-client merge raises priority');
});

test('sampleRequestIds are capped at the most recent 10', () => {
  const signal = {
    signal: 'slow_or_unexpected',
    upstream: 'gateway',
    tool: 'execute',
    platform: 'gemini',
    buildCommit: '1328787',
    requestIds: Array.from({ length: 8 }, (_, index) => `id-${index}`),
    evidence: {},
  };
  const now = new Date('2026-11-25T00:00:00Z');
  let pool = emptyPool(now);
  pool = applySignal(pool, signal, { now }).pool;
  pool = applySignal(pool, { ...signal, requestIds: ['id-8', 'id-9', 'id-10'] }, { now }).pool;
  assert.equal(pool.candidates[0].sampleRequestIds.length, 10);
  assert.ok(pool.candidates[0].sampleRequestIds.includes('id-10'));
});

test('ignoredFingerprints: blacklisted fingerprint is skipped silently', () => {
  const signal = {
    signal: 'search_thrash',
    upstream: 'gateway',
    tool: 'search',
    platform: 'chatgpt',
    buildCommit: '1328787',
    requestIds: ['a'],
    evidence: {},
  };
  const now = new Date('2026-11-25T00:00:00Z');
  const fingerprint = fingerprintOf(signal);
  const pool = {
    schema: CANDIDATES_SCHEMA,
    updatedAt: now.toISOString(),
    ignoredFingerprints: [fingerprint],
    candidates: [],
  };
  const result = applySignal(pool, signal, { now });
  assert.equal(result.skipped, true);
  assert.equal(result.pool.candidates.length, 0);
});

test('redaction: JSON-quoted, unquoted key=value and token families never land in the pool', () => {
  const leaky = [
    '{"access_token":"sk-live-abcdef0123456789"}',
    'Authorization: Bearer abcdef0123456789abcdef',
    'https://x.test/?api_key=plainsecretvalue123',
    'github_pat_11ABCDEFG0123456789_abcdefghijklmnop',
    'lin_api_DUMMYKEYFORREDACTIONTEST0000000000',
  ].join('\n');
  const signals = detectSignals({
    input: input(
      [
        row('a', '2026-11-24T19:00:00.000Z', { status: 500, tool: 'github__get_file_contents' }),
        row('a2', '2026-11-24T19:00:30.000Z', { tool: 'github__get_file_contents' }),
      ],
      [sample('a', {
        status: 200,
        tool: 'github__get_file_contents',
        responsePreview: { preview: leaky, nullKeys: ['url'] },
        subCalls: [{ server: 'github', tool: 'get_file_contents', ok: false, error: { name: 'Err', message: leaky } }],
      })],
    ),
  });
  const now = new Date('2026-11-25T00:00:00Z');
  let pool = emptyPool(now);
  for (const signal of signals) pool = applySignal(pool, signal, { now }).pool;
  const serialized = JSON.stringify(pool);
  for (const needle of ['sk-live-abcdef0123456789', 'github_pat_11ABCDEFG0123456789', 'lin_api_DUMMYKEYFORREDACTIONTEST0000000000', 'plainsecretvalue123']) {
    assert.ok(!serialized.includes(needle), `secret leaked: ${needle}`);
  }
  assert.ok(serialized.includes('[REDACTED]'), 'redaction marker expected');
});

/* ── stage 4: promote gate ────────────────────────────────────────────────── */

const GOOD_TIMES = '2026-11-25T00:00:00.000Z';

function makeCandidate(overrides = {}) {
  const now = new Date(GOOD_TIMES);
  const signal = {
    signal: 'semantic_200_gap',
    upstream: 'github',
    tool: 'normalizeMerge',
    platform: 'gemini',
    buildCommit: '1328787',
    requestIds: ['req-1', 'req-2'],
    evidence: { status: 200 },
  };
  const pool = applySignal(emptyPool(now), signal, { now }).pool;
  const candidate = pool.candidates[0];
  candidate.draftTask.trap = 'HTTP 200 但 number/url 为 null，调用方必须自己兜底补全';
  Object.assign(candidate, overrides);
  return { pool, candidate };
}

function tempSuite() {
  const dir = mkdtempSync(join(tmpdir(), 'promote-suite-'));
  mkdirSync(dir, { recursive: true });
  const suitePath = join(dir, 'adversarial-client-gold.json');
  writeFileSync(suitePath, `${JSON.stringify({
    schema: 'gold-eval-suite.v1',
    batch: 'batch-4-adversarial-and-clients',
    version: '1.0.0',
    updatedAt: GOOD_TIMES,
    tasks: [],
  }, null, 2)}\n`, 'utf8');
  return { dir, suitePath };
}

const GOOD_PROMPT = '合并这个 PR 后用 normalizeMerge 校验返回体，必须拿到 number 和 url，不得出现 null。';
const GOOD_CLAIMS = ['返回体 number 非 null', '返回体 url 非 null', 'url 形如 /pull/<number>'];

test('promote gate: happy path appends the task and refreshes INDEX.json', async () => {
  const { pool, candidate } = makeCandidate();
  const { dir, suitePath } = tempSuite();
  try {
    const candidatesPath = join(dir, 'candidates.json');
    writeFileSync(candidatesPath, `${JSON.stringify(pool, null, 2)}\n`, 'utf8');
    const result = await promoteCandidate({
      candidatesPath,
      suitePath,
      candidateId: candidate.candidateId,
      taskId: 'AC-ADV-99',
      userPrompt: GOOD_PROMPT,
      verifiableClaims: GOOD_CLAIMS,
      now: new Date(GOOD_TIMES),
    });
    assert.equal(result.task.id, 'AC-ADV-99');
    assert.match(result.task.referenceSource, new RegExp(candidate.candidateId));
    assert.match(result.task.referenceSource, /req-1/);
    const suite = JSON.parse(readFileSync(suitePath, 'utf8'));
    assert.equal(suite.tasks.length, 1);
    const index = JSON.parse(readFileSync(join(dir, 'INDEX.json'), 'utf8'));
    assert.equal(index.totalTasks, 1);
    assert.deepEqual(index.byUpstream.github, ['AC-ADV-99']);
    const poolAfter = JSON.parse(readFileSync(candidatesPath, 'utf8'));
    assert.equal(poolAfter.candidates[0].status, 'promoted');
    assert.equal(poolAfter.candidates[0].promotedTaskId, 'AC-ADV-99');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('promote gate: each of the five standards blocks the write', async () => {
  const base = makeCandidate();
  const { dir, suitePath } = tempSuite();
  try {
    const candidatesPath = join(dir, 'candidates.json');
    writeFileSync(candidatesPath, `${JSON.stringify(base.pool, null, 2)}\n`, 'utf8');

    const cases = [
      ['short prompt', { userPrompt: 'too short', verifiableClaims: GOOD_CLAIMS }],
      ['placeholder trap', { userPrompt: GOOD_PROMPT, verifiableClaims: GOOD_CLAIMS, candidateOverride: { trap: '待人工精修：x' } }],
      ['too few claims', { userPrompt: GOOD_PROMPT, verifiableClaims: ['only one'] }],
      ['bad baseline', { userPrompt: GOOD_PROMPT, verifiableClaims: GOOD_CLAIMS, candidateOverride: { baseline: { maxSearchCalls: -1 } } }],
      ['secret in prompt', { userPrompt: `${GOOD_PROMPT} token=sk-live-abcdef0123456789`, verifiableClaims: GOOD_CLAIMS }],
    ];

    for (const [label, spec] of cases) {
      const pool = structuredClone(base.pool);
      if (spec.candidateOverride?.trap) pool.candidates[0].draftTask.trap = spec.candidateOverride.trap;
      if (spec.candidateOverride?.baseline) pool.candidates[0].draftTask.efficiencyBaseline = spec.candidateOverride.baseline;
      writeFileSync(candidatesPath, `${JSON.stringify(pool, null, 2)}\n`, 'utf8');
      await assert.rejects(
        () => promoteCandidate({
          candidatesPath,
          suitePath,
          candidateId: base.candidate.candidateId,
          taskId: 'AC-ADV-98',
          userPrompt: spec.userPrompt,
          verifiableClaims: spec.verifiableClaims,
          now: new Date(GOOD_TIMES),
        }),
        /PROMOTE_VALIDATION_FAILED/,
        `${label} must be rejected`,
      );
      const suite = JSON.parse(readFileSync(suitePath, 'utf8'));
      assert.equal(suite.tasks.length, 0, `${label}: suite must stay untouched`);
    }

    // Missing sampleRequestIds also blocks (referenceSource cannot be filled).
    const poolNoIds = structuredClone(base.pool);
    poolNoIds.candidates[0].sampleRequestIds = [];
    writeFileSync(candidatesPath, `${JSON.stringify(poolNoIds, null, 2)}\n`, 'utf8');
    await assert.rejects(
      () => promoteCandidate({
        candidatesPath,
        suitePath,
        candidateId: base.candidate.candidateId,
        taskId: 'AC-ADV-97',
        userPrompt: GOOD_PROMPT,
        verifiableClaims: GOOD_CLAIMS,
        now: new Date(GOOD_TIMES),
      }),
      /PROMOTE_VALIDATION_FAILED/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('promote gate: duplicate task id is refused', async () => {
  const { pool, candidate } = makeCandidate();
  const { dir, suitePath } = tempSuite();
  try {
    const suite = JSON.parse(readFileSync(suitePath, 'utf8'));
    suite.tasks.push({ id: 'AC-ADV-01', tier: 'T1', upstreams: ['github'], targetClients: ['all'], access: 'read', failureModeTarget: [] });
    writeFileSync(suitePath, `${JSON.stringify(suite, null, 2)}\n`, 'utf8');
    const candidatesPath = join(dir, 'candidates.json');
    writeFileSync(candidatesPath, `${JSON.stringify(pool, null, 2)}\n`, 'utf8');
    await assert.rejects(
      () => promoteCandidate({
        candidatesPath,
        suitePath,
        candidateId: candidate.candidateId,
        taskId: 'AC-ADV-01',
        userPrompt: GOOD_PROMPT,
        verifiableClaims: GOOD_CLAIMS,
        now: new Date(GOOD_TIMES),
      }),
      /PROMOTE_DUPLICATE_TASK_ID/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reject: marks rejected_noise and blacklists the fingerprint', async () => {
  const { pool, candidate } = makeCandidate();
  const { dir } = tempSuite();
  try {
    const candidatesPath = join(dir, 'candidates.json');
    writeFileSync(candidatesPath, `${JSON.stringify(pool, null, 2)}\n`, 'utf8');
    const result = await rejectCandidate({
      candidatesPath,
      candidateId: candidate.candidateId,
      reason: 'OBS-001 已知协议协商',
      now: new Date(GOOD_TIMES),
    });
    assert.equal(result.fingerprint, candidate.fingerprint);
    const after = JSON.parse(readFileSync(candidatesPath, 'utf8'));
    assert.equal(after.candidates[0].status, 'rejected_noise');
    assert.equal(after.candidates[0].rejectedReason, 'OBS-001 已知协议协商');
    assert.ok(after.ignoredFingerprints.includes(candidate.fingerprint));
    await assert.rejects(
      () => rejectCandidate({ candidatesPath, candidateId: candidate.candidateId, reason: '' }),
      /REJECT_REASON_REQUIRED/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rebuildIndex: aggregates multiple suites, tiers and clients deterministically', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'index-'));
  try {
    const write = (file, batch, tasks) => writeFileSync(join(dir, file), `${JSON.stringify({
      schema: 'gold-eval-suite.v1', batch, version: '1.0.0', updatedAt: GOOD_TIMES, tasks,
    }, null, 2)}\n`, 'utf8');
    write('a-gold.json', 'batch-a', [
      { id: 'A-1', tier: 'T1', access: 'read', upstreams: ['github'], targetClients: ['all'], failureModeTarget: [] },
      { id: 'A-2', tier: 'T2', access: 'write', upstreams: ['notion'], targetClients: ['gemini'], failureModeTarget: ['x'] },
    ]);
    write('b-gold.json', 'batch-b', [
      { id: 'B-1', tier: 'T1', access: 'read', upstreams: ['github'], targetClients: ['chatgpt'], failureModeTarget: [] },
    ]);
    const index = await rebuildIndex({ dir, now: new Date(GOOD_TIMES) });
    assert.equal(index.totalTasks, 3);
    assert.equal(index.suites.length, 2);
    assert.deepEqual(index.tiers.T1.taskIds, ['A-1', 'B-1']);
    assert.deepEqual(index.byUpstream.github, ['A-1', 'B-1']);
    assert.deepEqual(index.byClient.gemini.dedicatedProbes, ['A-2']);
    assert.deepEqual(index.byClient.chatgpt.dedicatedProbes, ['B-1']);
    assert.deepEqual(index.byClient.gemini.recommendedT1, ['A-1', 'B-1']);
    assert.equal(index.entries.length, 3);
    assert.equal(index.entries[0].file, 'a-gold.json');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ── purity: distillation must never write gold files ─────────────────────── */

test('distill output only contains the candidate schema (never gold tasks)', () => {
  const result = distill({
    input: input(
      [
        row('a', '2026-11-24T19:00:00.000Z', { status: 500, tool: 'github__get_file_contents' }),
        row('a2', '2026-11-24T19:00:30.000Z', { tool: 'github__get_file_contents' }),
      ],
      [sample('a', { truncated: true })],
    ),
    now: new Date(GOOD_TIMES),
  });
  assert.equal(result.pool.schema, CANDIDATES_SCHEMA);
  assert.ok(Array.isArray(result.pool.candidates));
  for (const candidate of result.pool.candidates) {
    assert.equal(candidate.status, 'pending_review');
    assert.equal(candidate.userPrompt, undefined, 'candidates never carry a final prompt');
  }
});

