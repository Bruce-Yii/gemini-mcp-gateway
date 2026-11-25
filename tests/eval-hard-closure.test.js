/**
 * Hard eval-closure gate (2026-11-25): the free model must actually run.
 *
 * Covers, with zero network / zero R2 / zero real model calls:
 *   - analyze-captures: analyzerRun on dry-run / not-configured / empty-window /
 *     http-error / parse-failed / success (injected fetch);
 *   - compare-active-passive: INVALID_NO_LLM / BLOCKED_INFRA / CLOSED + exit codes;
 *   - check-eval-closure: new records need proof, legacy snapshots skip,
 *     BLOCKED_INFRA-with-reason passes;
 *   - run-active-closure: the whole 4-step chain with a fake subprocess runner.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  ANALYZER_SKIP_REASONS,
  buildAnalyzerRun,
  buildEmptyWindowAnalyzerOutput,
  main as analyzeMain,
} from '../scripts/analyze-captures.mjs';
import {
  CLOSURE_STATUS,
  compareActivePassive,
  main as compareMain,
} from '../scripts/compare-active-passive.mjs';
import {
  CLOSURE_RUN_SCHEMA,
  assertAnalyzeArgsAreLocal,
  buildAnalyzeArgs,
  formatChecklist,
  main as closureMain,
  parseClosureArgs,
  parseDistillSummary,
  resolveWindow,
  sliceEnvelopes,
} from '../scripts/run-active-closure.mjs';
import {
  EVAL_CLOSURE_CUTOFF,
  evaluateClosureRecord,
  evaluateClosureRecords,
  main as gateMain,
} from '../scripts/check-eval-closure.mjs';
import { buildActiveEval } from '../scripts/record-active-eval.mjs';

const REQ_ID = '0442a80c-85a2-4fc1-a0fa-d8697ed42650';
const FIXED_NOW = '2026-11-25T06:21:00.000Z';
const FIXED_NOW_DATE = () => new Date(FIXED_NOW);
const REAL_MODEL = 'free-model-test';

function captureIo() {
  const out = [];
  const err = [];
  return {
    stdout: (line) => out.push(String(line)),
    stderr: (line) => err.push(String(line)),
    out,
    err,
  };
}

function withTemp(prefix, body) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function withTempAsync(prefix, body) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return await body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ *
 * fixtures
 * ------------------------------------------------------------------ */

/** Successful MCP tools/call envelope used by the analyzer input builder. */
function captureEnvelope({ requestId = REQ_ID, ts = '2026-11-25T06:12:00.000Z' } = {}) {
  return {
    requestId,
    ts,
    clientPlatform: 'gemini',
    evalMode: 'active',
    deployment: { commit: '3dd206f' },
    request: {
      method: 'POST',
      url: '/mcp',
      raw: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'execute_read', arguments: { code: 'async () => 1' } },
      }),
    },
    response: { status: 200, raw: '{"ok":true}', bytes: 11, durationMs: 10 },
    events: [],
  };
}

function activeRecord(overrides = {}) {
  return {
    platform: 'gemini',
    buildCommit: '3dd206f',
    window: { from: '2026-11-25T06:00:00.000Z', to: '2026-11-25T06:20:00.000Z' },
    anchors: {
      repos: ['Bruce-Yii/gemini-mcp-gateway'],
      prs: [49],
      issues: [15],
      branches: ['main'],
      files: ['scripts/analyze-captures.mjs'],
      startAction: 'read scripts/analyze-captures.mjs',
      endAction: 'run closure loop',
    },
    prompt: '原始主动评测原文（逐字保存）',
    expected: { outcome: 'closure loop closes', tools: ['execute_read'], checks: ['llm ran'] },
    observed: {
      tools: ['execute_read'],
      results: ['closure'],
      errors: [],
      requestIds: [REQ_ID],
      captureVerified: true,
      services: [],
      connectFailures: [],
    },
    source: { window: 'dev lead window', messageAt: '2026-11-25T06:20:30.000Z' },
    ...overrides,
  };
}

function buildActive(overrides = {}) {
  const base = activeRecord(overrides);
  return buildActiveEval(base, { now: FIXED_NOW, rawText: base.prompt });
}

const REAL_ANALYZER_RUN = Object.freeze({
  llmExecuted: true,
  model: REAL_MODEL,
  skippedReason: null,
  executedAt: FIXED_NOW,
});

function passiveInput(overrides = {}) {
  return {
    schema: 'analyzer-input.v1',
    dataStatus: 'HAS_DATA',
    filters: { platform: '', evalMode: '', lastMinutes: 60, commit: '3dd206f' },
    metrics: { requests: 1, errors: 0 },
    samples: [{
      id: REQ_ID,
      ts: '2026-11-25T06:12:00.000Z',
      clientPlatform: 'gemini',
      clientProfile: 'gemini-text-json',
      protocolVersion: 'v1',
      buildCommit: '3dd206f',
      servers: ['github'],
      tool: 'execute_read',
    }],
    requestIndex: [{
      id: REQ_ID,
      ts: '2026-11-25T06:12:00.000Z',
      clientPlatform: 'gemini',
      buildCommit: '3dd206f',
      tool: 'execute_read',
    }],
    dimensions: { byClientPlatform: [{ platform: 'gemini', requestIdSamples: [REQ_ID] }] },
    serviceState: { snapshots: 0, byServer: {}, offlineServers: [] },
    connectFailures: { failures: 0, byServer: {} },
    ...overrides,
  };
}

/** analyzer-output.v1 wrapper. Pass `analyzerRun: null` for a model-free artifact. */
function analyzerOutput({ analyzerRun = REAL_ANALYZER_RUN, input = passiveInput(), issues = [] } = {}) {
  return {
    schema: 'analyzer-output.v1',
    input,
    raw: null,
    ...(analyzerRun ? { analyzerRun } : {}),
    validated: {
      schema: 'analyzer-output.v1',
      policy: 'free-model-advisory-v1',
      advisoryOnly: true,
      requiresHumanReview: true,
      dataStatus: input?.dataStatus ?? 'HAS_DATA',
      summary: 'advisory',
      issues,
      ignored: [],
      ...(analyzerRun ? { analyzerRun } : {}),
    },
  };
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

/* ------------------------------------------------------------------ *
 * analyze-captures: analyzerRun truth marker
 * ------------------------------------------------------------------ */

test('analyze: --dry-run records llmExecuted=false + skippedReason=dry_run (never calls fetch)', async () => {
  await withTempAsync('hard-closure-dry-', async (dir) => {
    const inputDir = join(dir, 'captures');
    mkdirSync(inputDir);
    writeFileSync(join(inputDir, 'one.json'), JSON.stringify(captureEnvelope()));
    const out = join(dir, 'out');
    const io = captureIo();
    let fetched = false;
    const code = await analyzeMain(
      ['--dir', inputDir, '--out', out, '--date', '2026-11-25', '--dry-run'],
      {
        stdout: io.stdout,
        stderr: io.stderr,
        env: {},
        now: FIXED_NOW_DATE,
        fetchImpl: async () => { fetched = true; throw new Error('fetch must not be called'); },
      },
    );
    assert.equal(code, 0);
    assert.equal(fetched, false);
    const artifact = JSON.parse(readFileSync(join(out, 'analyzer-output-2026-11-25.json'), 'utf8'));
    assert.deepEqual(artifact.analyzerRun, {
      llmExecuted: false,
      model: null,
      skippedReason: 'dry_run',
      executedAt: FIXED_NOW,
    });
    assert.equal(artifact.validated, null);
    assert.equal(artifact.input.dataStatus, 'HAS_DATA');
    assert.match(io.out.join('\n'), /dry-run/);
  });
});

test('analyze: missing baseUrl/apiKey is a degraded not_configured artifact and exits non-zero', async () => {
  await withTempAsync('hard-closure-noconfig-', async (dir) => {
    const inputDir = join(dir, 'captures');
    mkdirSync(inputDir);
    writeFileSync(join(inputDir, 'one.json'), JSON.stringify(captureEnvelope()));
    const out = join(dir, 'out');
    const io = captureIo();
    let fetched = false;
    const code = await analyzeMain(
      ['--dir', inputDir, '--out', out, '--date', '2026-11-25'],
      {
        stdout: io.stdout,
        stderr: io.stderr,
        env: {},
        now: FIXED_NOW_DATE,
        fetchImpl: async () => { fetched = true; throw new Error('fetch must not be called'); },
      },
    );
    assert.equal(code, 1);
    assert.equal(fetched, false);
    const artifact = JSON.parse(readFileSync(join(out, 'analyzer-output-2026-11-25.json'), 'utf8'));
    assert.equal(artifact.analyzerRun.llmExecuted, false);
    assert.equal(artifact.analyzerRun.model, null);
    assert.equal(artifact.analyzerRun.skippedReason, 'not_configured');
    assert.equal(artifact.analyzerRun.executedAt, FIXED_NOW);
    assert.match(io.err.join('\n'), /not_configured/);
  });
});

test('analyze: a real parsed free-model response sets llmExecuted=true and the actual model', async () => {
  await withTempAsync('hard-closure-ok-', async (dir) => {
    const inputDir = join(dir, 'captures');
    mkdirSync(inputDir);
    writeFileSync(join(inputDir, 'one.json'), JSON.stringify(captureEnvelope()));
    const out = join(dir, 'out');
    const io = captureIo();
    let seen = null;
    const fetchImpl = async (url, init) => {
      seen = { url, body: JSON.parse(String(init?.body ?? '{}')) };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: '{"summary":"advisory","issues":[]}' } }],
        }),
      };
    };
    const code = await analyzeMain(
      ['--dir', inputDir, '--out', out, '--date', '2026-11-25'],
      {
        stdout: io.stdout,
        stderr: io.stderr,
        env: {
          ANALYZER_BASE_URL: 'http://fake.local/v1',
          ANALYZER_API_KEY: 'test-key-not-real',
          ANALYZER_MODEL: REAL_MODEL,
        },
        now: FIXED_NOW_DATE,
        fetchImpl,
      },
    );
    assert.equal(code, 0, io.err.join('\n'));
    assert.equal(seen.url, 'http://fake.local/v1/chat/completions');
    assert.equal(seen.body.model, REAL_MODEL);
    const artifact = JSON.parse(readFileSync(join(out, 'analyzer-output-2026-11-25.json'), 'utf8'));
    assert.deepEqual(artifact.analyzerRun, {
      llmExecuted: true,
      model: REAL_MODEL,
      skippedReason: null,
      executedAt: FIXED_NOW,
    });
    assert.deepEqual(artifact.validated.analyzerRun, artifact.analyzerRun);
    assert.deepEqual(artifact.validated.issues, []);
    assert.equal(artifact.input.dataStatus, 'HAS_DATA');
  });
});

test('analyze: HTTP failure and unparseable response degrade with http_error/parse_failed', async () => {
  await withTempAsync('hard-closure-degrade-', async (dir) => {
    const inputDir = join(dir, 'captures');
    mkdirSync(inputDir);
    writeFileSync(join(inputDir, 'one.json'), JSON.stringify(captureEnvelope()));
    const env = {
      ANALYZER_BASE_URL: 'http://fake.local/v1',
      ANALYZER_API_KEY: 'test-key-not-real',
      ANALYZER_MODEL: REAL_MODEL,
    };
    const httpOut = join(dir, 'http-out');
    const httpCode = await analyzeMain(['--dir', inputDir, '--out', httpOut, '--date', '2026-11-25'], {
      stdout: () => {},
      stderr: () => {},
      env,
      now: FIXED_NOW_DATE,
      fetchImpl: async () => ({ ok: false, status: 503, text: async () => 'service unavailable' }),
    });
    assert.equal(httpCode, 1);
    const httpArtifact = JSON.parse(readFileSync(join(httpOut, 'analyzer-output-2026-11-25.json'), 'utf8'));
    assert.equal(httpArtifact.analyzerRun.llmExecuted, false);
    assert.equal(httpArtifact.analyzerRun.skippedReason, 'http_error');

    const parseOut = join(dir, 'parse-out');
    const parseCode = await analyzeMain(['--dir', inputDir, '--out', parseOut, '--date', '2026-11-25'], {
      stdout: () => {},
      stderr: () => {},
      env,
      now: FIXED_NOW_DATE,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: 'not json at all' } }] }),
      }),
    });
    assert.equal(parseCode, 1);
    const parseArtifact = JSON.parse(readFileSync(join(parseOut, 'analyzer-output-2026-11-25.json'), 'utf8'));
    assert.equal(parseArtifact.analyzerRun.llmExecuted, false);
    assert.equal(parseArtifact.analyzerRun.skippedReason, 'parse_failed');
  });
});

test('analyze: empty window keeps llmExecuted=false + skippedReason=empty_window (and never calls the model)', async () => {
  await withTempAsync('hard-closure-empty-', async (dir) => {
    const inputDir = join(dir, 'captures');
    mkdirSync(inputDir);
    const out = join(dir, 'out');
    let fetched = false;
    const code = await analyzeMain(['--dir', inputDir, '--out', out, '--date', '2026-11-25'], {
      stdout: () => {},
      stderr: () => {},
      env: { ANALYZER_BASE_URL: 'http://fake.local/v1', ANALYZER_API_KEY: 'k' },
      now: FIXED_NOW_DATE,
      fetchImpl: async () => { fetched = true; throw new Error('no model call on empty window'); },
    });
    assert.equal(code, 0);
    assert.equal(fetched, false);
    const artifact = JSON.parse(readFileSync(join(out, 'analyzer-output-2026-11-25.json'), 'utf8'));
    assert.equal(artifact.validated.dataStatus, 'EMPTY_WINDOW');
    assert.equal(artifact.analyzerRun.llmExecuted, false);
    assert.equal(artifact.analyzerRun.skippedReason, 'empty_window');
    assert.deepEqual(artifact.validated.analyzerRun, artifact.analyzerRun);
    assert.equal(artifact.input.dataStatus, 'EMPTY_WINDOW');
  });
});

test('analyze: buildEmptyWindowAnalyzerOutput carries the marker by default', () => {
  const out = buildEmptyWindowAnalyzerOutput({ dataStatus: 'EMPTY_WINDOW' });
  assert.equal(out.dataStatus, 'EMPTY_WINDOW');
  assert.equal(out.analyzerRun.llmExecuted, false);
  assert.equal(out.analyzerRun.model, null);
  assert.equal(out.analyzerRun.skippedReason, 'empty_window');
  assert.equal(typeof out.analyzerRun.executedAt, 'string');
  assert.ok(!Number.isNaN(Date.parse(out.analyzerRun.executedAt)));
  // Every documented skip reason stays accepted by the builder (no silent typo drift).
  for (const reason of ANALYZER_SKIP_REASONS) {
    const run = buildAnalyzerRun({ skippedReason: reason, executedAt: FIXED_NOW });
    assert.equal(run.llmExecuted, false);
    assert.equal(run.skippedReason, reason);
  }
  // Success normalizes a real model name and clears the reason.
  assert.deepEqual(
    buildAnalyzerRun({ llmExecuted: true, model: ` ${REAL_MODEL} `, skippedReason: 'http_error', executedAt: FIXED_NOW }),
    { llmExecuted: true, model: REAL_MODEL, skippedReason: null, executedAt: FIXED_NOW },
  );
});

/* ------------------------------------------------------------------ *
 * compare-active-passive: closure gate
 * ------------------------------------------------------------------ */

test('compare: model-free passive is INVALID_NO_LLM + non-zero, even when match=exact', async () => {
  await withTempAsync('hard-closure-compare-invalid-', async (dir) => {
    const active = buildActive();
    const passive = passiveInput(); // bare analyzer-input: no analyzerRun at all
    const result = compareActivePassive(active, passive);
    assert.equal(result.match, 'exact', 'deterministic match facts stay intact');
    assert.equal(result.closureStatus, CLOSURE_STATUS.INVALID_NO_LLM);
    assert.equal(result.llmExecuted, false);
    assert.equal(result.analyzerRun, null);
    assert.ok(result.reasons.some((reason) => /INVALID_NO_LLM/.test(reason)));

    const activePath = join(dir, 'active.json');
    const passivePath = join(dir, 'passive.json');
    const outPath = join(dir, 'out', 'active-passive.json');
    writeJson(activePath, active);
    writeJson(passivePath, passive);
    const io = captureIo();
    const code = await compareMain(['--active', activePath, '--passive', passivePath, '--out', outPath], io);
    assert.equal(code, 1);
    const artifact = JSON.parse(readFileSync(outPath, 'utf8'));
    assert.equal(artifact.closureStatus, 'INVALID_NO_LLM');
    assert.ok(artifact.reasons.some((reason) => /INVALID_NO_LLM/.test(reason)));
    assert.match(io.err.join('\n'), /INVALID_NO_LLM/);
    // No "allow" flag may turn a model-free artifact green.
    assert.equal(await compareMain([
      '--active', activePath, '--passive', passivePath,
      '--allow-unmatched', '--allow-missed-findings', '--require-match',
    ], captureIo()), 1);
  });
});

test('compare: analyzerRun.llmExecuted=true yields CLOSED and keeps existing green rules', async () => {
  await withTempAsync('hard-closure-compare-closed-', async (dir) => {
    const active = buildActive();
    const passive = analyzerOutput();
    const result = compareActivePassive(active, passive);
    assert.equal(result.closureStatus, CLOSURE_STATUS.CLOSED);
    assert.equal(result.llmExecuted, true);
    assert.deepEqual(result.analyzerRun, REAL_ANALYZER_RUN);
    assert.equal(result.closureStatusReason, null);
    assert.equal(result.match, 'exact');

    const activePath = join(dir, 'active.json');
    const passivePath = join(dir, 'passive.json');
    writeJson(activePath, active);
    writeJson(passivePath, passive);
    assert.equal(await compareMain(['--active', activePath, '--passive', passivePath], captureIo()), 0);
  });
});

test('compare: --infra-blocked-reason yields BLOCKED_INFRA with the reason, still non-zero', async () => {
  await withTempAsync('hard-closure-compare-blocked-', async (dir) => {
    const active = buildActive();
    const passivePath = join(dir, 'passive.json');
    const outPath = join(dir, 'out', 'active-passive.json');
    writeJson(join(dir, 'active.json'), active);
    writeJson(passivePath, passiveInput());
    const reason = 'R2 限流，同窗数据不可用';
    const code = await compareMain([
      '--active', join(dir, 'active.json'), '--passive', passivePath,
      '--out', outPath, '--infra-blocked-reason', reason,
    ], captureIo());
    assert.equal(code, 1, 'BLOCKED_INFRA is never a pass');
    const artifact = JSON.parse(readFileSync(outPath, 'utf8'));
    assert.equal(artifact.closureStatus, 'BLOCKED_INFRA');
    assert.equal(artifact.closureStatusReason, reason);

    // A reason is mandatory for BLOCKED_INFRA.
    assert.equal(await compareMain([
      '--active', join(dir, 'active.json'), '--passive', passivePath, '--infra-blocked-reason',
    ], captureIo()), 2);
    assert.equal(await compareMain([
      '--active', join(dir, 'active.json'), '--passive', passivePath, '--infra-blocked-reason', '   ',
    ], captureIo()), 2);
  });
});

/* ------------------------------------------------------------------ *
 * check-eval-closure: CI gate
 * ------------------------------------------------------------------ */

test('gate: new active-passive record without llmExecuted is a violation (files listed)', async () => {
  await withTempAsync('hard-closure-gate-new-', async (dir) => {
    const badFile = join(dir, 'active-passive-2026-11-25-window1.json');
    writeJson(badFile, { schema: 'active-passive-comparison.v1', closureStatus: 'CLOSED', match: 'likely' });
    const io = captureIo();
    const code = await gateMain(['--dir', dir], io);
    assert.equal(code, 1);
    assert.match(io.err.join('\n'), /active-passive-2026-11-25-window1\.json/);
    assert.match(io.err.join('\n'), /llmExecuted/);
    assert.match(io.out.join('\n'), /violations=1/);

    const report = evaluateClosureRecords([{ file: badFile, record: { closureStatus: 'CLOSED' } }]);
    assert.equal(report.violations.length, 1);
    assert.equal(report.legacySkipped, 0);
  });
});

test('gate: pre-cutoff legacy snapshot without llmExecuted is skipped', async () => {
  await withTempAsync('hard-closure-gate-legacy-', async (dir) => {
    const legacyFile = join(dir, 'active-passive-2026-11-24-window1.json');
    writeJson(legacyFile, {
      schema: 'active-passive-comparison.v1',
      generatedAt: '2026-11-24T14:46:12.931Z',
      match: 'exact',
    });
    const io = captureIo();
    const code = await gateMain(['--dir', dir], io);
    assert.equal(code, 0);
    assert.match(io.out.join('\n'), /legacy-skipped=1/);
    const row = evaluateClosureRecord({ file: legacyFile, record: { generatedAt: '2026-11-24T00:00:00.000Z' } }, { cutoff: EVAL_CLOSURE_CUTOFF });
    assert.equal(row.status, 'legacy-skip');
    // An old file that now DOES carry llmExecuted=false is not legacy anymore.
    const notLegacy = evaluateClosureRecord({
      file: legacyFile,
      record: { analyzerRun: { llmExecuted: false, skippedReason: 'dry_run' } },
    });
    assert.equal(notLegacy.status, 'violation');
  });
});

test('gate: BLOCKED_INFRA with a reason passes, without a reason fails; llmExecuted=true passes', async () => {
  await withTempAsync('hard-closure-gate-blocked-', async (dir) => {
    writeJson(join(dir, 'active-passive-2026-11-25-blocked.json'), {
      closureStatus: 'BLOCKED_INFRA',
      closureStatusReason: 'analyzer endpoint 503 for the whole window',
    });
    writeJson(join(dir, 'active-passive-2026-11-25-closed.json'), {
      closureStatus: 'CLOSED',
      analyzerRun: { llmExecuted: true, model: REAL_MODEL, skippedReason: null, executedAt: FIXED_NOW },
    });
    assert.equal(await gateMain(['--dir', dir], captureIo()), 0);

    writeJson(join(dir, 'active-passive-2026-11-25-no-reason.json'), { closureStatus: 'BLOCKED_INFRA' });
    const io = captureIo();
    assert.equal(await gateMain(['--dir', dir], io), 1);
    assert.match(io.err.join('\n'), /no-reason\.json/);
    assert.match(io.err.join('\n'), /without a non-empty reason/);
  });
});

test('gate: unreadable / invalid JSON records are violations, not silent skips', async () => {
  await withTempAsync('hard-closure-gate-broken-', async (dir) => {
    writeFileSync(join(dir, 'active-passive-2026-11-25-broken.json'), '{not json', 'utf8');
    const io = captureIo();
    assert.equal(await gateMain(['--dir', dir], io), 1);
    assert.match(io.err.join('\n'), /cannot read\/parse JSON/);
  });
});

/* ------------------------------------------------------------------ *
 * run-active-closure: helpers
 * ------------------------------------------------------------------ */

test('closure: window resolution and local-only analyze args', () => {
  const active = activeRecord();
  assert.deepEqual(
    resolveWindow({ lastMinutes: 60 }, active, { now: () => new Date('2026-11-25T07:00:00.000Z') }),
    { from: '2026-11-25T06:00:00.000Z', to: '2026-11-25T07:00:00.000Z', source: 'last_minutes' },
  );
  assert.deepEqual(
    resolveWindow({ since: '2026-11-25T06:00:00Z', until: '2026-11-25T06:20:00Z' }, active),
    { from: '2026-11-25T06:00:00.000Z', to: '2026-11-25T06:20:00.000Z', source: 'explicit' },
  );
  assert.deepEqual(resolveWindow({}, active), {
    from: '2026-11-25T06:00:00.000Z',
    to: '2026-11-25T06:20:00.000Z',
    source: 'active_record',
  });
  assert.equal(resolveWindow({}, {}), null);
  assert.throws(() => resolveWindow({ since: '2026-11-25T06:00:00Z' }, active), /must be provided together/);
  assert.throws(() => resolveWindow({ since: 'nope', until: '2026-11-25T06:20:00Z' }, active), /invalid --since/);
  assert.throws(
    () => resolveWindow({ since: '2026-11-25T07:00:00Z', until: '2026-11-25T06:00:00Z' }, active),
    /must not be before/,
  );

  const envelopes = [
    captureEnvelope({ ts: '2026-11-25T05:59:59.000Z' }),
    captureEnvelope({ ts: '2026-11-25T06:10:00.000Z' }),
    captureEnvelope({ ts: '2026-11-25T06:20:00.000Z' }),
    captureEnvelope({ ts: '2026-11-25T06:20:01.000Z' }),
    { requestId: 'no-ts' },
  ];
  assert.deepEqual(
    sliceEnvelopes(envelopes, resolveWindow({}, active)).map((row) => row.ts),
    ['2026-11-25T06:10:00.000Z', '2026-11-25T06:20:00.000Z'],
  );

  const analyzeArgs = buildAnalyzeArgs({
    windowBundle: 'work/x/window-envelopes.ndjson',
    analyzerDir: 'work/x/analyzer',
    dateLabel: '2026-11-25',
  });
  assert.deepEqual(analyzeArgs, [
    '--bundle', 'work/x/window-envelopes.ndjson',
    '--out', 'work/x/analyzer',
    '--date', '2026-11-25',
  ]);
  assert.deepEqual(assertAnalyzeArgsAreLocal(analyzeArgs), analyzeArgs);
  assert.throws(() => assertAnalyzeArgsAreLocal([...analyzeArgs, '--dry-run']), /--dry-run/);
  assert.throws(() => assertAnalyzeArgsAreLocal(['--out', 'x']), /--bundle/);
});

test('closure: flags parse with validation, checklist always has the three forced lines', () => {
  const options = parseClosureArgs([
    '--active-input', 'work/active.json', '--raw', 'work/active.txt',
    '--last-minutes', '60', '--store', 'work/capture-store',
    '--infra-blocked-reason', 'endpoint 503',
  ]);
  assert.equal(options.activeInput, 'work/active.json');
  assert.equal(options.lastMinutes, 60);
  assert.equal(options.infraBlockedReason, 'endpoint 503');
  assert.equal(options.store, 'work/capture-store');
  assert.throws(() => parseClosureArgs(['--last-minutes', '0']), /invalid --last-minutes/);
  assert.throws(() => parseClosureArgs(['--last-minutes', '60', '--since', 'x']), /not both/);
  assert.throws(() => parseClosureArgs(['--active-input']), /requires a value/);

  const lines = formatChecklist({
    activeEvalId: 'ae_20261125_deadbeef',
    rawPath: 'docs/eval/active-eval-x.json.raw.txt',
    activeEvalPath: 'docs/eval/active-eval-x.json',
    comparison: {
      match: 'exact',
      passive: { dataStatus: 'HAS_DATA' },
      requestIds: { status: 'exact' },
      findings: { total: 2, detected: 1, missed: 1, activeOnly: 1 },
      missed: [{ kind: 'finding', subject: 'f-x', reason: 'passive-not-detected' }],
    },
    closureStatus: CLOSURE_STATUS.CLOSED,
    blockedReason: '',
    distillSummary: { signals: 2, created: 1, merged: 1, pending: 1 },
    candidatesOut: 'work/candidates-updated.json',
  });
  assert.equal(lines.length, 3);
  assert.match(lines[0], /落库结果/);
  assert.match(lines[1], /同窗对照与 missed 分流/);
  assert.match(lines[1], /missed=1/);
  assert.match(lines[1], /active-only=1/);
  assert.match(lines[2], /反哺动作或明确阻塞原因/);
  const blocked = formatChecklist({
    activeEvalId: 'ae_x',
    comparison: null,
    closureStatus: CLOSURE_STATUS.BLOCKED_INFRA,
    blockedReason: 'endpoint 503',
    distillSummary: { signals: 0, created: 0 },
  });
  assert.equal(blocked.length, 3);
  assert.match(blocked[2], /BLOCKED_INFRA/);
  assert.match(blocked[2], /endpoint 503/);

  assert.deepEqual(parseDistillSummary('noise\n{"signals":3,"created":1}\n'), { signals: 3, created: 1 });
  assert.equal(parseDistillSummary('not json'), null);
});

/* ------------------------------------------------------------------ *
 * run-active-closure: full chain with a fake subprocess runner
 * ------------------------------------------------------------------ */

const CLOSURE_SCRIPTS = Object.freeze([
  'record-active-eval.mjs',
  'analyze-captures.mjs',
  'compare-active-passive.mjs',
  'distill-r2-candidates.mjs',
]);

/**
 * Fake subprocess runner: writes the same artifacts the real scripts write,
 * without a model, network or R2. `recorded` keeps script+argv order for
 * assertions.
 */
function makeFakeRunner({
  recorded = [],
  llmExecuted = true,
  analyzeCode = 0,
  compareStatus = CLOSURE_STATUS.CLOSED,
  compareCode = 0,
  activeEvalId = 'ae_20261125_deadbeef',
} = {}) {
  return async (scriptName, scriptArgs) => {
    recorded.push({ script: scriptName, args: scriptArgs });
    const arg = (flag) => (scriptArgs.includes(flag) ? scriptArgs[scriptArgs.indexOf(flag) + 1] : '');
    if (scriptName === 'record-active-eval.mjs') {
      const out = arg('--out');
      const raw = arg('--raw');
      writeJson(out, {
        schema: 'active-eval.v1',
        activeEvalId,
        platform: 'gemini',
        buildCommit: '3dd206f',
        window: { from: '2026-11-25T06:00:00.000Z', to: '2026-11-25T06:20:00.000Z' },
      });
      if (raw) writeFileSync(`${out}.raw.txt`, readFileSync(raw, 'utf8'), 'utf8');
      return { code: 0, stdout: `[active-eval] wrote ${out}`, stderr: '' };
    }
    if (scriptName === 'analyze-captures.mjs') {
      const outDir = arg('--out');
      const label = arg('--date');
      const analyzerRun = llmExecuted
        ? { llmExecuted: true, model: REAL_MODEL, skippedReason: null, executedAt: FIXED_NOW }
        : { llmExecuted: false, model: null, skippedReason: 'http_error', executedAt: FIXED_NOW };
      const input = { schema: 'analyzer-input.v1', dataStatus: 'HAS_DATA', metrics: { requests: 1, errors: 0 } };
      writeJson(join(outDir, `analyzer-input-${label}.json`), input);
      writeJson(join(outDir, `analyzer-output-${label}.json`), {
        date: label,
        input,
        raw: null,
        validated: llmExecuted ? { schema: 'analyzer-output.v1', issues: [], ignored: [], analyzerRun } : null,
        analyzerRun,
      });
      return { code: analyzeCode, stdout: '', stderr: analyzeCode ? 'analyzer HTTP 503: blocked' : '' };
    }
    if (scriptName === 'compare-active-passive.mjs') {
      const out = arg('--out');
      const result = {
        schema: 'active-passive-comparison.v1',
        activeEvalId,
        closureStatus: compareStatus,
        closureStatusReason: compareStatus === CLOSURE_STATUS.BLOCKED_INFRA
          ? (arg('--infra-blocked-reason') || 'blocked')
          : null,
        llmExecuted: compareStatus === CLOSURE_STATUS.CLOSED,
        analyzerRun: llmExecuted ? REAL_ANALYZER_RUN : null,
        match: 'exact',
        reasons: [],
        checks: { build: 'match', platform: 'match', window: 'match', requestIds: 'exact' },
        requestIds: { status: 'exact', matched: [REQ_ID], verified: [REQ_ID], unverified: [], missing: [] },
        coverage: [],
        missed: [],
        findings: { total: 0, detected: 0, missed: 0 },
        passive: {
          dataStatus: 'HAS_DATA', requests: 1, platforms: ['gemini'], buildCommits: ['3dd206f'],
          serviceSnapshots: 0, connectFailures: 0, issues: 0,
        },
      };
      writeJson(out, result);
      return { code: compareCode, stdout: JSON.stringify(result), stderr: '' };
    }
    if (scriptName === 'distill-r2-candidates.mjs') {
      const out = arg('--out');
      writeJson(out, { schema: 'gold-eval-candidates.v1', candidates: [] });
      return {
        code: 0,
        stdout: JSON.stringify({
          schema: 'gold-eval-candidates.v1', dataStatus: 'HAS_DATA',
          signals: 2, created: 1, merged: 1, skippedIgnored: 0,
          pending: 1, promoted: 0, rejected: 0, out,
        }),
        stderr: '',
      };
    }
    return { code: 1, stdout: '', stderr: `unexpected script ${scriptName}` };
  };
}

function setupClosureFixture(dir) {
  const activeInput = join(dir, 'active.json');
  const raw = join(dir, 'active.txt');
  writeFileSync(activeInput, JSON.stringify(activeRecord()), 'utf8');
  writeFileSync(raw, '原始主动评测原文（逐字保存）', 'utf8');
  return {
    dir,
    activeInput,
    raw,
    outDir: join(dir, 'out'),
    workDir: join(dir, 'work'),
    candidates: join(dir, 'candidates.json'),
    candidatesOut: join(dir, 'candidates-updated.json'),
    report: join(dir, 'closure-run.json'),
  };
}

function closureArgs(fx, extra = []) {
  return [
    '--active-input', fx.activeInput,
    '--raw', fx.raw,
    '--store', join(fx.dir, 'capture-store'),
    '--out-dir', fx.outDir,
    '--work-dir', fx.workDir,
    '--candidates', fx.candidates,
    '--candidates-out', fx.candidatesOut,
    '--report', fx.report,
    ...extra,
  ];
}

const ENV_CONFIGURED = Object.freeze({
  ANALYZER_BASE_URL: 'http://fake.local/v1',
  ANALYZER_API_KEY: 'test-key-not-real',
  ANALYZER_MODEL: REAL_MODEL,
});

test('closure chain: record -> real-LLM analyze -> compare -> distill + 3-line checklist (green)', async () => {
  await withTempAsync('hard-closure-chain-', async (dir) => {
    const fx = setupClosureFixture(dir);
    const recorded = [];
    const io = captureIo();
    const code = await closureMain(closureArgs(fx), {
      stdout: io.stdout,
      stderr: io.stderr,
      env: ENV_CONFIGURED,
      run: makeFakeRunner({ recorded }),
      loadStore: async () => [
        captureEnvelope({ ts: '2026-11-25T06:10:00.000Z' }),
        captureEnvelope({ requestId: 'outside-window', ts: '2026-11-25T04:00:00.000Z' }),
      ],
      now: FIXED_NOW_DATE,
    });
    assert.equal(code, 0, io.err.join('\n'));
    // All four existing scripts ran, in the documented order.
    assert.deepEqual(recorded.map((row) => row.script), CLOSURE_SCRIPTS);
    // The analyzer is NEVER dry-run and always works from the local bundle.
    const analyzeArgs = recorded[1].args;
    assert.ok(analyzeArgs.includes('--bundle'));
    assert.equal(analyzeArgs.includes('--dry-run'), false);
    assert.equal(analyzeArgs.includes('--last-minutes'), false);
    // Local store sliced to exactly the active window: 0 extra R2 GET.
    const bundlePath = analyzeArgs[analyzeArgs.indexOf('--bundle') + 1];
    const bundleLines = readFileSync(bundlePath, 'utf8').trim().split('\n').filter(Boolean);
    assert.equal(bundleLines.length, 1);
    assert.equal(JSON.parse(bundleLines[0]).requestId, REQ_ID);
    // Compare got the model-backed output + the closure artifact.
    const compareArgs = recorded[2].args;
    assert.match(compareArgs[compareArgs.indexOf('--passive') + 1], /analyzer-output-2026-11-25\.json$/);
    assert.match(compareArgs[compareArgs.indexOf('--out') + 1], /active-passive-2026-11-25\.json$/);
    // Forced three-line checklist.
    const checklist = io.out.filter((line) => line.startsWith('[closure] '));
    assert.equal(checklist.length, 3);
    assert.match(checklist[0], /落库结果.*ae_20261125_deadbeef/);
    assert.match(checklist[1], /同窗对照与 missed 分流.*match=exact.*closureStatus=CLOSED/);
    assert.match(checklist[2], /反哺动作或明确阻塞原因.*signals=2.*created=1/);
    // Run report is written for audit.
    const report = JSON.parse(readFileSync(fx.report, 'utf8'));
    assert.equal(report.schema, CLOSURE_RUN_SCHEMA);
    assert.equal(report.exitCode, 0);
    assert.equal(report.closureStatus, 'CLOSED');
    assert.equal(report.checklist.length, 3);
    assert.equal(report.activeEvalId, 'ae_20261125_deadbeef');
    // The record-active-eval step received the verbatim --raw file.
    assert.equal(recorded[0].args[recorded[0].args.indexOf('--raw') + 1], fx.raw);
  });
});

test('closure chain: free model not executed fails the chain (no fake closure), unless infra-blocked is explicit', async () => {
  await withTempAsync('hard-closure-chain-nollm-', async (dir) => {
    const fx = setupClosureFixture(dir);
    const recorded = [];
    const io = captureIo();
    const code = await closureMain(closureArgs(fx), {
      stdout: io.stdout,
      stderr: io.stderr,
      env: ENV_CONFIGURED,
      run: makeFakeRunner({ recorded, llmExecuted: false, analyzeCode: 1 }),
      loadStore: async () => [captureEnvelope()],
      now: FIXED_NOW_DATE,
    });
    assert.equal(code, 1);
    assert.equal(recorded.length, 2, 'compare/distill must not run on a model-free passive artifact');
    assert.match(io.err.join('\n'), /free model did not produce a parsed passive analysis/);
    assert.match(io.err.join('\n'), /skippedReason=http_error/);
    assert.match(io.err.join('\n'), /never skips the model/);

    const blockedDir = join(dir, 'blocked');
    mkdirSync(blockedDir, { recursive: true });
    const blockedFx = setupClosureFixture(blockedDir);
    const blockedRecorded = [];
    const blockedIo = captureIo();
    const blockedCode = await closureMain(closureArgs(blockedFx, ['--infra-blocked-reason', 'endpoint 503 for the whole window']), {
      stdout: blockedIo.stdout,
      stderr: blockedIo.stderr,
      env: ENV_CONFIGURED,
      run: makeFakeRunner({
        recorded: blockedRecorded,
        llmExecuted: false,
        analyzeCode: 1,
        compareStatus: CLOSURE_STATUS.BLOCKED_INFRA,
        compareCode: 1,
      }),
      loadStore: async () => [captureEnvelope()],
      now: FIXED_NOW_DATE,
    });
    assert.equal(blockedCode, 1, 'BLOCKED_INFRA still exits non-zero');
    assert.deepEqual(blockedRecorded.map((row) => row.script), CLOSURE_SCRIPTS);
    const compareArgs = blockedRecorded[2].args;
    assert.equal(compareArgs[compareArgs.indexOf('--infra-blocked-reason') + 1], 'endpoint 503 for the whole window');
    const checklist = blockedIo.out.filter((line) => line.startsWith('[closure] '));
    assert.equal(checklist.length, 3);
    assert.match(checklist[2], /BLOCKED_INFRA/);
    assert.match(checklist[2], /endpoint 503/);
    const report = JSON.parse(readFileSync(blockedFx.report, 'utf8'));
    assert.equal(report.exitCode, 1);
    assert.equal(report.closureStatus, 'BLOCKED_INFRA');
  });
});

test('closure chain: missing LLM config / --dry-run are hard usage errors before any step', async () => {
  await withTempAsync('hard-closure-chain-config-', async (dir) => {
    const fx = setupClosureFixture(dir);
    const recorded = [];
    const io = captureIo();
    const noConfig = await closureMain(closureArgs(fx), {
      stdout: io.stdout,
      stderr: io.stderr,
      env: {},
      run: makeFakeRunner({ recorded }),
      loadStore: async () => [captureEnvelope()],
      now: FIXED_NOW_DATE,
    });
    assert.equal(noConfig, 2);
    assert.equal(recorded.length, 0);
    assert.match(io.err.join('\n'), /ANALYZER_BASE_URL/);

    const dryRunIo = captureIo();
    const dryRun = await closureMain(closureArgs(fx, ['--dry-run']), {
      stdout: dryRunIo.stdout,
      stderr: dryRunIo.stderr,
      env: ENV_CONFIGURED,
      run: makeFakeRunner({ recorded }),
      loadStore: async () => [captureEnvelope()],
      now: FIXED_NOW_DATE,
    });
    assert.equal(dryRun, 2);
    assert.equal(recorded.length, 0);
    assert.match(dryRunIo.err.join('\n'), /--dry-run is not supported/);
  });
});

test('closure chain: an empty local window is surfaced as skippedReason=empty_window, not a green loop', async () => {
  await withTempAsync('hard-closure-chain-empty-', async (dir) => {
    const fx = setupClosureFixture(dir);
    const recorded = [];
    const io = captureIo();
    const code = await closureMain(closureArgs(fx), {
      stdout: io.stdout,
      stderr: io.stderr,
      env: ENV_CONFIGURED,
      run: makeFakeRunner({ recorded, llmExecuted: false, analyzeCode: 0 }),
      loadStore: async () => [],
      now: FIXED_NOW_DATE,
    });
    assert.equal(code, 1);
    assert.equal(recorded.length, 2);
    assert.match(io.err.join('\n'), /skippedReason=http_error|skippedReason=/);
    const bundlePath = recorded[1].args[recorded[1].args.indexOf('--bundle') + 1];
    assert.equal(readFileSync(bundlePath, 'utf8'), '');
  });
});
