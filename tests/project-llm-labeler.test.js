/**
 * Batch 11 — offline LLM project labeler (advisory only).
 *
 * Covers the required contract:
 *   - fixture input, schema validation;
 *   - low-confidence bucket separation;
 *   - no-repo and multi-repo windows;
 *   - empty input;
 *   - malformed / untraceable model output is rejected, never accepted;
 *   - no real network (all model calls use an injected fetchImpl).
 *
 * Every fixture is an inline digest/session-window SUMMARY, not a full body:
 * requestIds, methods/tools, repo/path/branch hints, PR/Issue titles and short
 * result summaries only — exactly what scripts/classify-projects.mjs sends.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLabelerInput, summarizeWindow, validateProjectLabels, classifyProjects,
  callProjectLabeler, renderLabelReview, DEFAULT_CONFIDENCE_THRESHOLD,
  LABELER_SCHEMA, LABELER_POLICY,
} from '../scripts/classify-projects.mjs';

// ---------------------------------------------------------------------------
// Fixtures (batch-11 style windows, modelled on real capture shapes)
// ---------------------------------------------------------------------------

function windowFixture(overrides = {}) {
  return {
    windowId: 'window:001',
    strategy: 'sessionId',
    sessionId: 'sess-abc',
    requestIdSamples: ['req-a', 'req-b'],
    requests: 2,
    mcpErrors: 0,
    methods: { 'tools/call': 2 },
    tools: ['github__get_file_contents'],
    projects: [],
    primaryProjects: [],
    repos: [],
    paths: [],
    branches: [],
    prOrIssueTitles: [],
    resultSummaries: [],
    ...overrides,
  };
}

const NO_REPO_WINDOW = windowFixture({
  windowId: 'window:001',
  requestIdSamples: ['req-a'],
  tools: ['notion__search', 'linear__list_issues'],
  methods: { 'tools/call': 1 },
  prOrIssueTitles: ['Project Atlas planning notes'],
  resultSummaries: ['Found 3 Notion pages, no GitHub repo referenced'],
});

const MULTI_REPO_WINDOW = windowFixture({
  windowId: 'session:multi',
  sessionId: 'multi',
  requestIdSamples: ['req-gh', 'req-gh2', 'req-nt'],
  tools: ['github__list_issues', 'notion__search'],
  methods: { 'tools/call': 3 },
  projects: [
    { key: 'github:test-org/test-repo' },
    { key: 'github:test-org/test-gateway' },
  ],
  primaryProjects: ['github:test-org/test-repo'],
  repos: ['test-org/test-repo', 'test-org/test-gateway'],
  paths: ['src/app/CandidatePage.tsx'],
  branches: ['main'],
  prOrIssueTitles: ['Fix pagination on candidate page (#12)'],
  resultSummaries: ['Listed 4 issues; read 1 file; searched Notion for design notes'],
});

function modelOutput(labels) {
  return {
    schema: LABELER_SCHEMA,
    projectLabels: labels.map((label) => ({
      model: 'hy4-flash-free',
      ...label,
    })),
  };
}

// ---------------------------------------------------------------------------
// 1. Input is a bounded summary, never a full body
// ---------------------------------------------------------------------------

test('buildLabelerInput emits schema-bound window summaries with no full bodies', () => {
  const input = buildLabelerInput([MULTI_REPO_WINDOW], { date: '2026-11-23' });
  assert.equal(input.schema, LABELER_SCHEMA);
  assert.equal(input.policy, LABELER_POLICY);
  assert.equal(input.advisoryOnly, true);
  assert.equal(input.requiresHumanReview, true);
  assert.equal(input.date, '2026-11-23');
  assert.equal(input.windows.length, 1);

  const window = input.windows[0];
  assert.deepEqual(window.requestIds, ['req-gh', 'req-gh2', 'req-nt']);
  assert.deepEqual(window.tools, ['github__list_issues', 'notion__search']);
  assert.deepEqual(window.mcpMethods, ['tools/call']);
  assert.deepEqual(window.hints.repos, ['test-org/test-repo', 'test-org/test-gateway']);
  assert.deepEqual(window.hints.paths, ['src/app/CandidatePage.tsx']);
  assert.deepEqual(window.hints.branches, ['main']);
  assert.deepEqual(window.hints.prOrIssueTitles, ['Fix pagination on candidate page (#12)']);
  assert.deepEqual(window.hints.resultSummaries, ['Listed 4 issues; read 1 file; searched Notion for design notes']);
  assert.deepEqual(window.hints.repoKeys, [
    'github:test-org/test-repo',
    'github:test-org/test-gateway',
  ]);

  const serialized = JSON.stringify(input);
  assert.ok(!serialized.includes('request.raw'), 'no raw request bodies in model input');
  assert.ok(!serialized.includes('response.raw'), 'no raw response bodies in model input');
  assert.ok(!serialized.includes('sandbox'), 'no sandbox code in model input');
  assert.ok(!serialized.includes('CandidatePage.tsx'.repeat(2)), 'hints are short, not full payloads');
});

test('summarizeWindow truncates long titles/results and caps requestIds', () => {
  const window = windowFixture({
    requestIdSamples: Array.from({ length: 12 }, (_, i) => `req-${i}`),
    prOrIssueTitles: ['T'.repeat(500)],
    resultSummaries: ['R'.repeat(500)],
  });
  const summary = summarizeWindow(window, 0);
  assert.equal(summary.requestIds.length, 5);
  assert.ok(summary.hints.prOrIssueTitles[0].length <= 201);
  assert.ok(summary.hints.resultSummaries[0].length <= 201);
  assert.match(summary.hints.prOrIssueTitles[0], /…$/);
});

test('buildLabelerInput accepts arrays and {windows}, dedupes, and respects maxWindows', () => {
  const a = windowFixture({ windowId: 'w1' });
  const dup = windowFixture({ windowId: 'w1', requests: 99 });
  const b = windowFixture({ windowId: 'w2' });
  const viaArray = buildLabelerInput([a, dup, b]);
  assert.deepEqual(viaArray.windows.map((w) => w.windowId), ['w1', 'w2']);
  const viaObject = buildLabelerInput({ windows: [a, b] });
  assert.equal(viaObject.windows.length, 2);
  const limited = buildLabelerInput([a, b], { maxWindows: 1 });
  assert.equal(limited.windows.length, 1);
  const viaSessions = buildLabelerInput({ sessions: [b] });
  assert.equal(viaSessions.windows[0].windowId, 'w2');
});

test('empty input yields zero windows and an advisory empty result', async () => {
  const input = buildLabelerInput([]);
  assert.deepEqual(input.windows, []);
  assert.equal(input.limits.maxLabels, 20);

  const result = await classifyProjects([], { dryRun: true });
  assert.equal(result.schema, LABELER_SCHEMA);
  assert.equal(result.advisoryOnly, true);
  assert.equal(result.requiresHumanReview, true);
  assert.equal(result.summary.windows, 0);
  assert.deepEqual(result.projectLabels, []);
  assert.deepEqual(result.lowConfidence, []);
  assert.match(result.downstream, /advisory-only/);
});

// ---------------------------------------------------------------------------
// 2. Schema validation: accepted labels are traceable and advisory
// ---------------------------------------------------------------------------

test('valid labels keep schema fields, evidence ids and advisory flags', () => {
  const input = buildLabelerInput([NO_REPO_WINDOW]);
  const result = validateProjectLabels(modelOutput([{
    windowId: 'window:001',
    projectKey: 'no-repo',
    confidence: 0.95,
    evidenceRequestIds: ['req-a'],
    reason: 'Only Notion/Linear search; no repo hint present',
  }]), input);

  assert.equal(result.schema, LABELER_SCHEMA);
  assert.equal(result.policy, LABELER_POLICY);
  assert.equal(result.advisoryOnly, true);
  assert.equal(result.requiresHumanReview, true);
  assert.equal(result.projectLabels.length, 1);
  assert.deepEqual(result.projectLabels[0], {
    windowId: 'window:001',
    projectKey: 'no-repo',
    confidence: 0.95,
    evidenceRequestIds: ['req-a'],
    reason: 'Only Notion/Linear search; no repo hint present',
    model: 'hy4-flash-free',
  });
  assert.equal(result.summary.lowConfidence, 0);
});

test('no-repo window: labeler proposes no-repo/ambiguous, never a fabricated owner/repo', async () => {
  const result = await classifyProjects([NO_REPO_WINDOW], {
    dryRun: true,
    raw: modelOutput([{
      windowId: 'window:001',
      projectKey: 'no-repo',
      confidence: 0.88,
      evidenceRequestIds: ['req-a'],
      reason: 'No explicit owner/repo; mixed Notion + Linear activity only',
    }]),
  });
  const label = result.projectLabels[0];
  assert.ok(label.projectKey === 'no-repo' || label.projectKey === 'ambiguous');
  assert.ok(!/github:owner\/repo/.test(label.projectKey), 'no fabricated repo');
});

test('multi-repo window: each candidate cites its own evidence and stays advisory', () => {
  const input = buildLabelerInput([MULTI_REPO_WINDOW]);
  const result = validateProjectLabels(modelOutput([
    {
      windowId: 'session:multi',
      projectKey: 'github:test-org/test-repo',
      confidence: 0.82,
      evidenceRequestIds: ['req-gh', 'req-gh2'],
      reason: 'Two GitHub issue/file calls target test-repo',
    },
    {
      windowId: 'session:multi',
      projectKey: 'github:test-org/test-gateway',
      confidence: 0.61,
      evidenceRequestIds: ['req-gh'],
      reason: 'Second repo appears in one code hint only',
    },
  ]), input);
  assert.equal(result.projectLabels.length, 1);
  assert.equal(result.lowConfidence.length, 1);
  assert.equal(result.projectLabels[0].projectKey, 'github:test-org/test-repo');
  assert.equal(result.lowConfidence[0].projectKey, 'github:test-org/test-gateway');
  // No automatic merge: downstream field names carry no 'primaryProject' write.
  assert.ok(!('primaryProject' in result.projectLabels[0]));
});

// ---------------------------------------------------------------------------
// 3. Low confidence is separated, never auto-accepted
// ---------------------------------------------------------------------------

test('confidence at threshold is normal; below threshold goes to lowConfidence', () => {
  const input = buildLabelerInput([NO_REPO_WINDOW, MULTI_REPO_WINDOW]);
  const result = validateProjectLabels(modelOutput([
    {
      windowId: 'window:001', projectKey: 'linear:ENG', confidence: DEFAULT_CONFIDENCE_THRESHOLD,
      evidenceRequestIds: ['req-a'], reason: 'Linear issue title mentions ENG team',
    },
    {
      windowId: 'session:multi', projectKey: 'notion:design', confidence: DEFAULT_CONFIDENCE_THRESHOLD - 0.01,
      evidenceRequestIds: ['req-nt'], reason: 'One Notion search only; weak signal',
    },
  ]), input);
  assert.equal(result.confidenceThreshold, DEFAULT_CONFIDENCE_THRESHOLD);
  assert.deepEqual(result.projectLabels.map((l) => l.confidence), [DEFAULT_CONFIDENCE_THRESHOLD]);
  assert.equal(result.lowConfidence.length, 1);
  assert.ok(result.lowConfidence[0].confidence < DEFAULT_CONFIDENCE_THRESHOLD);
  assert.equal(result.summary.lowConfidence, 1);
});

// ---------------------------------------------------------------------------
// 4. Malformed / untraceable model output is rejected, never silently kept
// ---------------------------------------------------------------------------

test('invalid model output is rejected: unknown window, invented evidence, bad confidence', () => {
  const input = buildLabelerInput([NO_REPO_WINDOW]);
  const result = validateProjectLabels({
    schema: LABELER_SCHEMA,
    projectLabels: [
      { windowId: 'invented-window', projectKey: 'x', confidence: 0.9, evidenceRequestIds: ['req-a'], reason: 'r', model: 'm' },
      { windowId: 'window:001', projectKey: 'x', confidence: 0.9, evidenceRequestIds: ['req-fake'], reason: 'r', model: 'm' },
      { windowId: 'window:001', projectKey: 'x', confidence: 'very-high', evidenceRequestIds: ['req-a'], reason: 'r', model: 'm' },
      { windowId: 'window:001', projectKey: '', confidence: 0.9, evidenceRequestIds: ['req-a'], reason: 'r', model: 'm' },
      { windowId: 'window:001', projectKey: 'x', confidence: 0.9, evidenceRequestIds: [], reason: 'r', model: 'm' },
    ],
  }, input);
  assert.equal(result.projectLabels.length, 0);
  assert.equal(result.lowConfidence.length, 0);
  assert.deepEqual(result.rejected.map((r) => r.reason), [
    'unknown-window',
    'no-valid-evidenceRequestIds',
    'invalid-confidence',
    'missing-projectKey',
    'no-valid-evidenceRequestIds',
  ]);
  assert.equal(result.summary.rejected, 5);
});

test('completely malformed raw output yields an empty, still-advisory result', () => {
  const input = buildLabelerInput([NO_REPO_WINDOW]);
  for (const raw of [null, undefined, {}, { projectLabels: 'not-an-array' }, { projectLabels: [null, 7] }, []]) {
    const result = validateProjectLabels(raw, input);
    assert.equal(result.schema, LABELER_SCHEMA);
    assert.equal(result.advisoryOnly, true);
    assert.equal(result.requiresHumanReview, true);
    assert.deepEqual(result.projectLabels, []);
    assert.deepEqual(result.lowConfidence, []);
  }
});

test('confidence is clamped to [0,1] and rounded deterministically', () => {
  const input = buildLabelerInput([NO_REPO_WINDOW]);
  const result = validateProjectLabels(modelOutput([
    { windowId: 'window:001', projectKey: 'a', confidence: 5, evidenceRequestIds: ['req-a'], reason: 'r' },
    { windowId: 'window:001', projectKey: 'b', confidence: -3, evidenceRequestIds: ['req-a'], reason: 'r' },
    { windowId: 'window:001', projectKey: 'c', confidence: 0.666, evidenceRequestIds: ['req-a'], reason: 'r' },
  ]), input);
  const byKey = Object.fromEntries([...result.projectLabels, ...result.lowConfidence].map((l) => [l.projectKey, l.confidence]));
  assert.equal(byKey.a, 1);
  assert.equal(byKey.b, 0);
  assert.equal(byKey.c, 0.67);
});

// ---------------------------------------------------------------------------
// 5. No network: fixture + injected fetchImpl paths
// ---------------------------------------------------------------------------

test('fixture mode loads JSON from a file-like object without fetch', async () => {
  const result = await classifyProjects([NO_REPO_WINDOW], {
    fixture: modelOutput([{
      windowId: 'window:001', projectKey: 'no-repo', confidence: 0.9,
      evidenceRequestIds: ['req-a'], reason: 'fixture reason',
    }]),
  });
  assert.equal(result.mode, 'fixture');
  assert.equal(result.projectLabels.length, 1);
  assert.equal(result.summary.rejected, 0);
});

test('callProjectLabeler uses injected fetchImpl, extracts fenced JSON, never real network', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: '```json\n' + JSON.stringify(modelOutput([{
              windowId: 'window:001', projectKey: 'no-repo', confidence: 0.9,
              evidenceRequestIds: ['req-a'], reason: 'model said so',
            }])) + '\n```',
          },
        }],
      }),
    };
  };
  const raw = await callProjectLabeler(buildLabelerInput([NO_REPO_WINDOW]), {
    baseUrl: 'https://example.invalid/v1/',
    apiKey: 'test-key',
    model: 'hy4-flash-free',
    fetchImpl,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://example.invalid/v1/chat/completions');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, 'hy4-flash-free');
  assert.equal(body.temperature, 0);
  assert.equal(body.reasoning_effort, 'none');
  assert.equal(calls[0].init.headers.authorization, 'Bearer test-key');
  // Prompt contains only the summary, never a full raw body.
  assert.ok(!JSON.stringify(body.messages).includes('"request.raw"'));
  assert.equal(raw.projectLabels.length, 1);
});

test('callProjectLabeler rejects non-OK responses and missing JSON without throwing away advisory flags', async () => {
  const input = buildLabelerInput([NO_REPO_WINDOW]);
  await assert.rejects(() => callProjectLabeler(input, {
    baseUrl: 'https://example.invalid/v1',
    fetchImpl: async () => ({ ok: false, status: 429, text: async () => 'rate limited' }),
  }), /labeler HTTP 429/);
  await assert.rejects(() => callProjectLabeler(input, {
    baseUrl: 'https://example.invalid/v1',
    fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'no json here' } }] }) }),
  }), /returned no JSON/);
  await assert.rejects(() => callProjectLabeler(input, {
    fetchImpl: async () => { throw new Error('must not happen'); },
  }), /LABELER_BASE_URL is required/);
});

// ---------------------------------------------------------------------------
// 6. Rendered review is advisory and action-free
// ---------------------------------------------------------------------------

test('renderLabelReview lists both buckets, evidence ids and a no-action gate', async () => {
  const result = await classifyProjects([NO_REPO_WINDOW, MULTI_REPO_WINDOW], {
    raw: modelOutput([
      { windowId: 'window:001', projectKey: 'no-repo', confidence: 0.9, evidenceRequestIds: ['req-a'], reason: 'no repo' },
      { windowId: 'session:multi', projectKey: 'notion:design', confidence: 0.3, evidenceRequestIds: ['req-nt'], reason: 'weak' },
    ]),
    dryRun: true,
  });
  const md = renderLabelReview(result);
  assert.match(md, /Advisory only/);
  assert.match(md, /\| normal \| window:001 \| no-repo \| 0\.9 \| `req-a`/);
  assert.match(md, /\| LOW \| session:multi \| notion:design \| 0\.3 \| `req-nt`/);
  assert.match(md, /not merged into captures/);
  assert.match(md, /never auto-accepted/);
  assert.match(md, /No label is used for writes, merges, issue\/PR creation, or idempotency keys/);
  assert.ok(!/```/.test(md), 'no code patches in review');
  assert.ok(!md.includes('apply') && !md.includes('auto-merge'), 'no apply/auto-merge action');
});

test('classifyProjects is deterministic across repeated calls', async () => {
  const opts = {
    raw: modelOutput([
      { windowId: 'window:001', projectKey: 'no-repo', confidence: 0.9, evidenceRequestIds: ['req-a'], reason: 'r' },
      { windowId: 'session:multi', projectKey: 'github:test-org/test-repo', confidence: 0.4, evidenceRequestIds: ['req-gh'], reason: 'r' },
    ]),
    dryRun: true,
  };
  const source = [NO_REPO_WINDOW, MULTI_REPO_WINDOW];
  const first = JSON.stringify(await classifyProjects(source, opts));
  for (let i = 0; i < 3; i += 1) {
    assert.equal(JSON.stringify(await classifyProjects(source, opts)), first);
  }
});
