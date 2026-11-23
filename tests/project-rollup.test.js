/**
 * Batch 11 — project-level rollup across digest / analyzer / join.
 *
 * Covers:
 *   1. same repo across 3 sessions merges into one byProject row, with a
 *      per-session timeline (handoff) preserved;
 *   2. one request with several project tags contributes to every tag;
 *   3. requests without project tags do not pollute any project bucket;
 *   4. join projectKey matched / unmatched, with explicit taskId priority;
 *   5. old envelopes (no projects[] / primaryProject) are backfilled
 *      deterministically from request.raw — no model, no prose parsing.
 *
 * All inputs are inline fixtures. No R2, no network, no src/ writes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateEnvelopes, digestProjects, digestSessions, projectKeysOf,
  primaryProjectKeyOf, renderScorecard, renderProjectTimelines,
} from '../scripts/capture-digest.mjs';
import { buildAnalyzerInput } from '../scripts/analyze-captures.mjs';
import {
  joinOnlineToOffline, projectKeyOf, projectKeysOfWindow,
} from '../scripts/join-online-offline.mjs';

const KEY_A = 'github:acme/alpha';
const KEY_B = 'github:acme/beta';

const project = (key, overrides = {}) => ({
  server: 'github',
  owner: key.split(':')[1].split('/')[0],
  repo: key.split('/')[1],
  key,
  confidence: 'high',
  source: 'tool-args',
  ...overrides,
});

/** Minimal envelope fixture carrying explicit project tags. */
function env({
  id = `req-${Math.random()}`,
  ts = '2026-11-22T10:00:00.000Z',
  sessionId = null,
  projects = [],
  primaryProject = null,
  status = 200,
  raw = '{}',
  method = 'tools/call',
  tool = 'github__get_file_contents',
} = {}) {
  return {
    schema: 'gmg.capture.v1',
    ts,
    requestId: id,
    sessionId,
    ...(projects.length ? { projects } : {}),
    ...(primaryProject ? { primaryProject } : {}),
    request: {
      method: 'POST',
      url: '/mcp',
      headers: {},
      raw: JSON.stringify({ jsonrpc: '2.0', method, params: { name: tool } }),
    },
    response: { status, raw, bytes: raw.length, durationMs: 10, overflow: false },
    events: [],
  };
}

// -------------------------------------------------------------------------
// 1. Same repo across 3 sessions -> one byProject row + 3 timeline rows
// -------------------------------------------------------------------------
test('same project across three sessions merges in byProject but keeps handoff timelines', () => {
  const envelopes = [
    env({ id: 'r1', ts: '2026-11-22T09:00:00.000Z', sessionId: 's1', projects: [project(KEY_A)], primaryProject: project(KEY_A) }),
    env({ id: 'r2', ts: '2026-11-22T10:00:00.000Z', sessionId: 's2', projects: [project(KEY_A)], primaryProject: project(KEY_A) }),
    env({ id: 'r3', ts: '2026-11-22T11:00:00.000Z', sessionId: 's3', projects: [project(KEY_A)], primaryProject: project(KEY_A) }),
  ];
  const rollup = digestProjects(envelopes);

  assert.equal(rollup.byProject.length, 1);
  assert.equal(rollup.byProject[0].key, KEY_A);
  assert.equal(rollup.byProject[0].requests, 3);
  assert.equal(rollup.byProject[0].mcpRequests, 3);
  assert.equal(rollup.byProject[0].toolCalls, 3);
  assert.equal(rollup.byProject[0].errors, 0);
  assert.equal(rollup.byProject[0].truncationSuspects, 0);
  assert.deepEqual(rollup.byProject[0].sessionIds.sort(), ['s1', 's2', 's3']);
  assert.equal(rollup.byProject[0].firstTs, '2026-11-22T09:00:00.000Z');
  assert.equal(rollup.byProject[0].lastTs, '2026-11-22T11:00:00.000Z');

  assert.equal(rollup.projectTimelines.length, 3);
  assert.deepEqual(rollup.projectTimelines.map((row) => row.sessionId), ['s1', 's2', 's3']);
  assert.deepEqual(rollup.projectTimelines.map((row) => row.primaryProjectRequests), [1, 1, 1]);

  // metrics integration
  const metrics = aggregateEnvelopes(envelopes, { date: '2026-11-22' });
  assert.equal(metrics.byProject[KEY_A].requests, 3);
  assert.equal(metrics.projectTimelines.length, 3);

  // sessions[] carries a project summary
  const sessions = digestSessions(envelopes);
  assert.equal(sessions.length, 3);
  assert.ok(sessions.every((row) => row.projects.length === 1 && row.projects[0].key === KEY_A));
  assert.ok(sessions.every((row) => row.primaryProjects[0] === KEY_A));

  // MD tables render
  const md = renderScorecard('2026-11-22', metrics) + renderProjectTimelines(rollup.projectTimelines);
  assert.match(md, /## Projects \(derived labels/);
  assert.match(md, /github:acme\/alpha/);
  assert.match(md, /## Project timelines/);
});

// -------------------------------------------------------------------------
// 2. One request, multiple repos/tags -> each tag counted independently
// -------------------------------------------------------------------------
test('one request with two project tags contributes to both project buckets', () => {
  const multi = env({
    id: 'multi',
    projects: [project(KEY_A), project(KEY_B, { source: 'code-literal', confidence: 'medium' })],
    primaryProject: project(KEY_A),
  });
  const metrics = aggregateEnvelopes([multi], { date: '2026-11-22' });

  assert.equal(metrics.byProject[KEY_A].requests, 1);
  assert.equal(metrics.byProject[KEY_B].requests, 1);
  assert.equal(metrics.projectTimelines.length, 2);
  assert.deepEqual(projectKeysOf(multi).sort(), [KEY_A, KEY_B].sort());
  assert.equal(primaryProjectKeyOf(multi), KEY_A);

  const primaryB = { ...multi, primaryProject: project(KEY_B) };
  const rollup = digestProjects([primaryB]);
  const timelineA = rollup.projectTimelines.find((row) => row.projectKey === KEY_A);
  const timelineB = rollup.projectTimelines.find((row) => row.projectKey === KEY_B);
  assert.equal(timelineA.primaryProjectRequests, 0);
  assert.equal(timelineB.primaryProjectRequests, 1);
});

// -------------------------------------------------------------------------
// 3. No-project requests do not pollute any bucket
// -------------------------------------------------------------------------
test('requests without project tags produce no byProject rows or timelines', () => {
  const plain = env({ id: 'plain', projects: [], primaryProject: null });
  const metrics = aggregateEnvelopes([plain], { date: '2026-11-22' });

  assert.equal(metrics.requests, 1);
  assert.deepEqual(metrics.byProject, {});
  assert.deepEqual(metrics.projectTimelines, []);
  assert.deepEqual(projectKeysOf(plain), []);
  assert.equal(primaryProjectKeyOf(plain), null);
  assert.deepEqual(projectKeysOfWindow(digestSessions([plain])[0]), []);
});

// -------------------------------------------------------------------------
// 4. Join: explicit taskId priority, projectKey matched/unmatched
// -------------------------------------------------------------------------
test('join matches by explicit taskId before projectKey', () => {
  const windows = [{
    windowId: 'session:s1',
    sessionId: 's1',
    taskId: 'T001',
    projects: [project(KEY_A)],
    primaryProject: project(KEY_A),
    requestIdSamples: ['r1'],
    requests: 1,
  }];
  const tasks = [
    { id: 'T001', server: 'github', tool: 'get_file', projectKey: KEY_B },
  ];
  const result = joinOnlineToOffline({ windows, tasks });
  assert.equal(result.matched.length, 1);
  assert.equal(result.matched[0].matchBy, 'taskId');
  assert.equal(result.matched[0].offlineTaskId, 'T001');
  assert.equal(result.summary.matchedByTaskId, 1);
  assert.equal(result.summary.matchedByProjectKey, 0);
});

test('join matches strictly by projectKey when no taskId exists', () => {
  const windows = [
    {
      windowId: 'session:s1', sessionId: 's1',
      projects: [project(KEY_A), project(KEY_B)],
      primaryProject: project(KEY_A),
      requestIdSamples: ['r1'], requests: 1,
    },
  ];
  const tasks = [
    { id: 'T100', server: 'github', tool: 'get_file', projectKey: KEY_B },
  ];
  const result = joinOnlineToOffline({ windows, tasks });
  assert.equal(result.matched.length, 1);
  assert.equal(result.matched[0].matchBy, 'projectKey');
  assert.equal(result.matched[0].onlineProjectKey, KEY_B);
  assert.equal(result.matched[0].offlineTaskId, 'T100');
  assert.equal(result.matched[0].offline.projectKey, KEY_B);
  assert.equal(result.summary.matchedByProjectKey, 1);
});

test('join leaves project-key windows unmatched when offline has no such repo', () => {
  const windows = [{
    windowId: 'session:s1', sessionId: 's1',
    projects: [project(KEY_A)], primaryProject: project(KEY_A),
    requestIdSamples: ['r1'], requests: 1,
  }];
  const tasks = [{ id: 'T100', server: 'github', tool: 'get_file', projectKey: KEY_B }];
  const result = joinOnlineToOffline({ windows, tasks });

  assert.equal(result.matched.length, 0);
  assert.equal(result.unmatched.length, 1);
  assert.equal(result.unmatched[0].reason, 'no-offline-task');
  assert.equal(result.unmatched[0].matchAttempt, 'projectKey');
  assert.deepEqual(result.unmatched[0].onlineProjectKeys, [KEY_A]);
  assert.equal(result.offlineOnly.length, 1); // never force-paired
});

test('projectKeyOf accepts only explicit repo/project fields, never prose', () => {
  assert.equal(projectKeyOf({ projectKey: KEY_A }), KEY_A);
  assert.equal(projectKeyOf({ project: { key: KEY_A } }), KEY_A);
  assert.equal(projectKeyOf({ repo: 'acme/alpha' }), KEY_A);
  assert.equal(projectKeyOf({ owner: 'acme', repo: 'alpha' }), KEY_A);
  assert.equal(projectKeyOf({ repo: 'alpha' }), null, 'bare repo name is not explicit enough');
  assert.equal(projectKeyOf({ prompt: 'please fix acme/alpha' }), null);
});

// -------------------------------------------------------------------------
// 5. Old envelope compatibility — deterministic backfill from request.raw
// -------------------------------------------------------------------------
test('old envelopes without project fields are backfilled from request.raw', () => {
  const old = {
    requestId: 'old-1',
    ts: '2026-11-22T10:00:00.000Z',
    sessionId: 'legacy',
    request: {
      method: 'POST',
      url: '/mcp',
      headers: {},
      raw: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: {
          name: 'github__get_file_contents',
          arguments: { owner: 'acme', repo: 'alpha', path: 'README.md' },
        },
      }),
    },
    response: { status: 200, raw: '{}', bytes: 2, durationMs: 10 },
    events: [],
  };
  assert.deepEqual(projectKeysOf(old), [KEY_A]);
  assert.equal(primaryProjectKeyOf(old), KEY_A);

  const rollup = digestProjects([old]);
  const row = rollup.byProject.find((p) => p.key === KEY_A);
  assert.ok(row);
  assert.equal(row.requests, 1);
  assert.equal(row.mcpRequests, 1);
  assert.deepEqual(row.sessionIds, ['legacy']);
});

test('old envelope fallback ignores prose repo names and is deterministic', () => {
  const prose = {
    requestId: 'old-2',
    request: {
      method: 'POST', url: '/mcp',
      raw: JSON.stringify({
        jsonrpc: '2.0', method: 'tools/call',
        params: { name: 'execute_read', arguments: { code: '// fix the acme/alpha repo please' } },
      }),
    },
    response: { status: 200, raw: '{}', bytes: 2, durationMs: 1 },
  };
  assert.deepEqual(projectKeysOf(prose), [], 'plain prose never becomes a project tag');

  const explicit = {
    ...prose,
    request: {
      ...prose.request,
      raw: JSON.stringify({
        jsonrpc: '2.0', method: 'tools/call',
        params: {
          name: 'execute_read',
          arguments: { code: "const owner = 'acme'; const repo = 'alpha'; return owner + '/' + repo;" },
        },
      }),
    },
  };
  const first = projectKeysOf(explicit);
  for (let i = 0; i < 3; i += 1) assert.deepEqual(projectKeysOf(explicit), first, 'fallback is deterministic');
});

// -------------------------------------------------------------------------
// Analyzer input integration (advisory-only, validator untouched)
// -------------------------------------------------------------------------
test('analyzer input carries projectWindows / projectSummary and derived-label note', () => {
  const envelopes = [
    env({ id: 'r1', ts: '2026-11-22T09:00:00.000Z', sessionId: 's1', projects: [project(KEY_A)], primaryProject: project(KEY_A) }),
    env({ id: 'r2', ts: '2026-11-22T10:00:00.000Z', sessionId: 's2', projects: [project(KEY_A)], primaryProject: project(KEY_A) }),
    env({ id: 'r3', ts: '2026-11-22T11:00:00.000Z', sessionId: 's2', projects: [project(KEY_B), project(KEY_A)], primaryProject: project(KEY_B) }),
  ];
  const input = buildAnalyzerInput(envelopes, { date: '2026-11-22' });

  assert.equal(input.projectWindows.length, 3);
  assert.equal(input.projectSummary.projects, 2);
  assert.equal(input.projectSummary.handoffProjects, 1);
  assert.equal(input.projectSummary.multiProjectSessions, 1);
  assert.match(input.projectNote, /DERIVED labels/);
  assert.match(input.projectNote, /not client-declared/);
  // Existing input contract untouched.
  assert.equal(input.schema, 'analyzer-input.v1');
  assert.equal(input.sessionWindows.length, 2);
  assert.ok(Array.isArray(input.clusters));
});
