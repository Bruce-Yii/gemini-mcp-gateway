/**
 * Offline, deterministic tests for scripts/eval-cycle.mjs.
 *
 * No network, no credentials, no child processes, no writes to the repo:
 * filesystem access is injected with in-memory fakes. The tests pin:
 *   - CLI parsing and explicit baseline statuses (DRIFT / NO_BASELINE);
 *   - F1–F6 coverage parsing (unknown is never a pass);
 *   - J1–J6 / N1–N9 join audit (SKIP / missing ids are FAIL);
 *   - replay of the deterministic fake session (no real writes, never pass unknown);
 *   - artifact naming / no-overwrite semantics and full-cycle exit behaviour.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  parseArgs, parseFCoverage, auditJoinCoverage, auditDocs,
  evaluateBaseline, runFakeL1, runReplayFixture, buildReport,
  renderMarkdown, artifactNames, runCycle, stableHash,
  DEFAULT_FILES, F_IDS, N_IDS, J_IDS, SCHEMA,
} from '../scripts/eval-cycle.mjs';

const NOW = '2026-11-23T12:00:00.000Z';
const opt = (overrides = {}) => ({ outDir: 'docs/eval', now: NOW, tag: null, help: false, ...overrides });

/* -------------------------------------------------------------- *
 * CLI
 * -------------------------------------------------------------- */

test('parseArgs: defaults, explicit values and invalid date', () => {
  const defaults = parseArgs([]);
  assert.equal(defaults.outDir, 'docs/eval');
  assert.equal(defaults.tag, null);
  assert.equal(defaults.help, false);
  assert.ok(!Number.isNaN(Date.parse(defaults.now)));
  const parsed = parseArgs(['--now', NOW, '--out-dir', '/tmp/x', '--tag', 'ci-1', '--help']);
  assert.equal(parsed.now, NOW);
  assert.equal(parsed.outDir, '/tmp/x');
  assert.equal(parsed.reportDir, '/tmp/x'); // defaults to out-dir
  assert.equal(parseArgs(['--out-dir', '/tmp/y', '--report-dir', '/tmp/z']).reportDir, '/tmp/z');
  assert.equal(parsed.tag, 'ci-1');
  assert.equal(parsed.help, true);
  assert.throws(() => parseArgs(['--now', 'not-a-date']), /invalid --now/);
  assert.throws(() => parseArgs(['--now=nope']), /invalid --now/);
});

test('stableHash: key order independent, value order sensitive', () => {
  assert.equal(stableHash({ a: 1, b: 2 }), stableHash({ b: 2, a: 1 }));
  assert.notEqual(stableHash({ a: [1, 2] }), stableHash({ a: [2, 1] }));
});

/* -------------------------------------------------------------- *
 * F1–F6 coverage parsing
 * -------------------------------------------------------------- */

const joinDoc = [
  '| 反馈 | 在线证据 | 任务 | 当前覆盖状态 | 代码层状态 |',
  '|---|---|---|---|---|',
  '| **F1**（P0）notice | user report | N1 | **`weak`** | `pending-deploy` |',
  '| **F2**（P0）number | user report | N3 | **`weak`** | `pending-deploy` |',
  '| **F3** wrapper | user report | J3 | `missing` | `unknown` |',
  '| **F4** truncation | user report | J4 | `weak` | `unknown` |',
  '| **F5** atomic | user report | J5 | **`covered`（原子写）** 但 **`weak`（默认语义）** | `unknown` |',
  '| **F6** CI wait | user report | J6 | `missing` | `unknown` |',
].join('\n');

test('parseFCoverage: reads covered/weak/missing and keeps weaker half', () => {
  const f = parseFCoverage(joinDoc);
  assert.deepEqual(f.missing, []);
  assert.deepEqual(f.rows.map((r) => r.id), F_IDS);
  assert.equal(f.rows.find((r) => r.id === 'F1').state, 'weak');
  assert.deepEqual(f.rows.find((r) => r.id === 'F5').allStates, ['covered', 'weak']);
  assert.ok(f.nonPass.some((r) => r.id === 'F3' && r.state === 'missing'));
});

test('parseFCoverage: unknown / missing rows are non-pass, never silently green', () => {
  const f = parseFCoverage('| 反馈 | 当前覆盖状态 |\n|---|---|\n| **F1** | `unknown` |\n| **F2** | `covered` |\n');
  assert.equal(f.rows.find((r) => r.id === 'F1').state, 'unknown');
  assert.ok(f.nonPass.some((r) => r.id === 'F1'));
  assert.deepEqual(f.missing, F_IDS.slice(2)); // F3–F6 absent
});

/* -------------------------------------------------------------- *
 * Join / docs audit (all filesystem access injected)
 * -------------------------------------------------------------- */

function virtualFs(extra = {}) {
  const files = {
    [DEFAULT_FILES.joinDoc]: joinDoc,
    [DEFAULT_FILES.gapsDoc]: '# SEMI-ONLINE-GAPS N1–N9\n',
    [DEFAULT_FILES.feedbackDoc]: 'schema: online-feedback.v1\nF1: ...\n',
    [DEFAULT_FILES.nTasks]: JSON.stringify({ tasks: N_IDS.map((id) => ({ id, dryRun: true, forRealWrite: false })) }),
    [DEFAULT_FILES.jTasks]: JSON.stringify({ tasks: J_IDS.map((id) => ({ id, dryRun: true, forRealWrite: false })) }),
    [DEFAULT_FILES.continuousDoc]: '# Continuous Eval Cycle — eval-cycle 报告\n',
    [DEFAULT_FILES.ledger]: '# batch-15-continuous-eval\n',
    ...extra,
  };
  return {
    files,
    read: (p) => {
      const rel = path.relative('D:/root', p).replace(/\\/g, '/');
      if (!(rel in files)) throw new Error(`ENOENT ${rel}`);
      return files[rel];
    },
    exists: (p) => path.relative('D:/root', p).replace(/\\/g, '/') in files,
    root: 'D:/root',
  };
}

test('auditJoinCoverage: full N/J sets pass with explicit weak/missing INFO', () => {
  const v = virtualFs();
  const result = auditJoinCoverage({
    root: v.root, read: v.read, exists: v.exists,
    loadTasks: (rel, { expectedIds }) => ({
      tasks: JSON.parse(v.files[rel]).tasks.filter((t) => expectedIds.includes(t.id)),
      skips: [],
    }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.findings.filter((f) => f.level === 'FAIL').length, 0);
  assert.ok(result.findings.some((f) => f.level === 'INFO' && f.id === 'F3'));
  assert.deepEqual(result.taskAudit.J.loaded, J_IDS);
  assert.deepEqual(result.taskAudit.N.loaded, N_IDS);
});

test('auditJoinCoverage: SKIP and missing task ids are FAIL, not pass', () => {
  const v = virtualFs();
  const result = auditJoinCoverage({
    root: v.root, read: v.read, exists: v.exists,
    loadTasks: (rel, { expectedIds }) => {
      const expected = expectedIds.includes('J1') ? J_IDS : N_IDS;
      return {
        tasks: [{ id: expected[0] }],
        skips: expected.slice(1).map((id) => ({ id, reason: 'SKIP: missing fixture', kind: 'missing-fixture' })),
      };
    },
  });
  assert.equal(result.ok, false);
  const f = result.findings.filter((x) => x.level === 'FAIL');
  assert.ok(f.some((x) => x.id === 'J6' && /SKIP/.test(x.detail)));
  assert.ok(f.some((x) => x.id === 'N9'));
});

test('auditJoinCoverage: unreadable join doc is FAIL', () => {
  const v = virtualFs();
  const result = auditJoinCoverage({
    root: v.root,
    read: (p) => { throw new Error('EACCES'); },
    exists: v.exists,
    loadTasks: () => ({ tasks: [], skips: [] }),
  });
  assert.equal(result.ok, false);
  assert.ok(result.findings.some((f) => f.id === 'joinDoc' && f.level === 'FAIL'));
});

test('auditDocs: missing marker is FAIL', () => {
  const v = virtualFs({ [DEFAULT_FILES.continuousDoc]: 'empty\n' });
  const result = auditDocs({ root: v.root, read: v.read, exists: v.exists });
  assert.equal(result.ok, false);
  assert.ok(result.checks.some((c) => c.artifact === DEFAULT_FILES.continuousDoc && c.status === 'FAIL'));
});

/* -------------------------------------------------------------- *
 * Baseline (read-only, injected sources)
 * -------------------------------------------------------------- */

test('evaluateBaseline: NO_BASELINE when no sources exist', () => {
  const b = evaluateBaseline({
    signature: 'abc', root: 'D:/root',
    exists: () => false, read: () => ({}), readdir: () => [], now: () => NOW,
  });
  assert.equal(b.status, 'NO_BASELINE');
  assert.equal(b.sources.length, 0);
  assert.match(b.noBaselineReason, /no frozen baseline/);
  assert.equal(b.readOnly, true);
});

test('evaluateBaseline: DRIFT when a source signature differs', () => {
  const b = evaluateBaseline({
    signature: 'new', root: 'D:/root',
    exists: (p) => String(p).includes('l1-online-gap'),
    read: () => ({ readOnly: true, signature: 'old-signature' }),
    readdir: () => [], now: () => NOW,
  });
  assert.equal(b.status, 'DRIFT');
  assert.deepEqual(b.driftSources, [DEFAULT_FILES.onlineGapBaseline]);
});

test('evaluateBaseline: STABLE when previous report signature matches', () => {
  const b = evaluateBaseline({
    signature: 'same', root: 'D:/root',
    exists: (p) => String(p).endsWith('eval-cycle-old.json'),
    read: () => ({ signature: 'same' }),
    readdir: () => ['eval-cycle-old.json'], now: () => NOW,
  });
  assert.equal(b.status, 'STABLE');
  assert.ok(b.sources.some((s) => s.source.includes('eval-cycle-old.json')));
});

test('evaluateBaseline: frozen L1 metrics are REFERENCE, not a false DRIFT', () => {
  const b = evaluateBaseline({
    signature: 'cycle-signature', root: 'D:/root',
    exists: (p) => String(p).includes('l1-smoke'),
    read: () => ({ metrics: { completionRate: 76 } }),
    readdir: () => [], now: () => NOW,
  });
  assert.equal(b.status, 'NO_BASELINE');
  assert.equal(b.sources[0].status, 'REFERENCE');
  assert.match(b.noBaselineReason, /REFERENCE only/);
});

test('evaluateBaseline: non-readOnly frozen file is ignored', () => {
  const b = evaluateBaseline({
    signature: 'x', root: 'D:/root',
    exists: () => true, read: () => ({ readOnly: false, identity: { J1: 'z' } }),
    readdir: () => [], now: () => NOW,
  });
  assert.equal(b.status, 'NO_BASELINE');
});

/* -------------------------------------------------------------- *
 * Fake L1 + replay
 * -------------------------------------------------------------- */

test('runFakeL1: fake wiring, no baseline => all unknown, never a quality pass', () => {
  const tasks = [...N_IDS, ...J_IDS].map((id) => ({ id }));
  const fake = runFakeL1({ tasks, skips: [{ id: 'J6', reason: 'SKIP' }] });
  assert.equal(fake.ok, true);
  assert.equal(fake.taskCount, 15);
  assert.equal(fake.l1.mode !== undefined || fake.l1.source.includes('fake'), true);
  assert.equal(fake.comparison.allUnknown, true);
  assert.equal(fake.unknownIsPass, false);
});

test('runReplayFixture: offline deterministic, no real write, diff is informational', async () => {
  const replay = await runReplayFixture();
  assert.equal(replay.source, 'fixture');
  assert.equal(replay.requestIds[0], 'unknown'); // never fabricated
  assert.ok(replay.steps >= 2);
  assert.ok(['pass', 'diff', 'partial', 'not-comparable'].includes(replay.verdict));
  assert.equal(replay.ok, true); // harness integrity, not a gateway verdict
  assert.equal(replay.diffIsInformational, true);
  assert.ok(replay.counts && Object.keys(replay.counts).length > 0);
});

test('buildReport: DRIFT/NO_BASELINE do not fail; real FAILs do', async () => {
  const join = { ok: false, findings: [{ level: 'FAIL', id: 'J5', detail: 'missing' }], fRows: [], taskAudit: {} };
  const docs = { ok: true, checks: [] };
  const fake = { ok: true, taskCount: 15, skips: [], gapMetrics: {}, l1: {} };
  const replay = { ok: true, verdict: 'pass', counts: {} };
  const baseline = { status: 'DRIFT', sources: [], driftSources: ['x'] };
  const r = await buildReport({ opts: opt(), join, docs, fake, replay, baseline, signature: 's' });
  assert.equal(r.ok, false);
  assert.deepEqual(r.failures, ['join:J5']);
  assert.equal(r.baselineStatus, 'DRIFT');
  assert.match(renderMarkdown(r), /DRIFT/);

  const clean = { ...join, ok: true, findings: [] };
  const nb = { status: 'NO_BASELINE', sources: [], driftSources: [] };
  const r2 = await buildReport({ opts: opt(), join: clean, docs, fake, replay, baseline: nb, signature: 's' });
  assert.equal(r2.ok, true);
  assert.match(r2.baselineNote, /NO_BASELINE/);
});

/* -------------------------------------------------------------- *
 * Artifact naming and full cycle
 * -------------------------------------------------------------- */

test('artifactNames: timestamped and sanitized', () => {
  const n = artifactNames(NOW, 'ci/1');
  assert.match(n.json, /^eval-cycle-2026-11-23T12-00-00-000Z-ci_1\.json$/);
  assert.match(n.md, /^eval-cycle-2026-11-23T12-00-00-000Z-ci_1\.md$/);
});

test('runCycle: writes two new artifacts, no overwrite, explicit NO_BASELINE', async () => {
  const v = virtualFs();
  const written = new Map();
  const result = await runCycle({
    opts: opt({ tag: 'test' }),
    root: v.root,
    read: v.read,
    exists: v.exists,
    mkdir: async () => {},
    writeFile: async (p, data) => {
      const key = path.relative('D:/root', p).replace(/\\/g, '/');
      if (written.has(key)) throw new Error('EEXIST');
      written.set(key, data);
    },
    baselineFile: 'explore/baselines/absent.json',
  });
  assert.equal(result.report.ok, true);
  assert.equal(result.report.schema, SCHEMA);
  assert.equal(result.report.baselineStatus, 'NO_BASELINE');
  assert.equal(result.paths.json.endsWith('.json'), true);
  assert.equal(result.paths.md.endsWith('.md'), true);
  assert.equal(written.size, 2);
  const json = JSON.parse([...written.values()][0]);
  assert.equal(json.ok, true);
  assert.match([...written.values()][1], /Baseline: \*\*NO_BASELINE\*\*/);
  assert.equal(json.networkCalls, 0);
  assert.equal(json.noProductionWrites, true);
});

test('runCycle: missing J task is a FAIL but exit-result rows stay deterministic', async () => {
  const v = virtualFs({
    [DEFAULT_FILES.jTasks]: JSON.stringify({ tasks: J_IDS.slice(0, 5).map((id) => ({ id, dryRun: true, forRealWrite: false })) }),
  });
  const written = new Map();
  const { report } = await runCycle({
    opts: opt(), root: v.root, read: v.read, exists: v.exists,
    mkdir: async () => {},
    writeFile: async (p, data) => { written.set(path.basename(p), data); },
    baselineFile: 'explore/baselines/absent.json',
  });
  assert.equal(report.ok, false);
  assert.ok(report.failures.some((f) => f === 'join:J6'));
  assert.equal(report.baselineStatus, 'NO_BASELINE');
});
