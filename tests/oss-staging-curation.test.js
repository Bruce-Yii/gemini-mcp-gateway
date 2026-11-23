/**
 * OSS staging curation guards.
 *
 * The clean OSS export excludes every private eval fixture (explore/, data/).
 * Two test files and one measurement script used to crash at load time on
 * ENOENT, which made `npm test` fail in staging. They now use existsSync gates
 * and report explicit SKIPs with a reason. This test proves that behaviour:
 *
 *   1. Source-level: the guards exist in the three curated files.
 *   2. Fixture-missing: running the curated file in a temp tree without the
 *      private fixtures produces skipped tests WITH a reason, zero failures,
 *      and (critically) the skipped tests are NOT counted as passing tests.
 *   3. Fixture-present: the same file actually runs its assertions when the
 *      private fixture is available (no SKIP, real pass/fail outcomes).
 *   4. measure-context.mjs: missing dataset -> `SKIP:` on stdout + exit 0,
 *      no fabricated work/context-measure.json.
 *
 * Pure/offline only. Uses node:test child processes; no network, no tokens,
 * no writes to the repository (all scratch files live in os.tmpdir()).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oss-staging-curation-'));
  return {
    dir,
    write(rel, content) {
      const abs = path.join(dir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
      return abs;
    },
    cleanup() { fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

/** Structured summary of a `node --test --test-reporter=tap` child run. */
// node --test sets NODE_TEST_CONTEXT in child processes; without stripping it
// the nested `node --test` thinks it is a recursive run and emits no TAP plan.
const CHILD_ENV = { ...process.env };
delete CHILD_ENV.NODE_TEST_CONTEXT;

function runTap(file) {
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', file], {
    cwd: path.dirname(file), encoding: 'utf8', env: CHILD_ENV,
  });
  // Normalize CRLF so `$` in the summary regex matches line ends on Windows.
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.replace(/\r\n/g, '\n');
  const skipLines = out.split('\n').filter((l) => /^ok \d+ - .*# SKIP /.test(l));
  const executedOkLines = out.split('\n').filter((l) => /^ok \d+ - /.test(l) && !l.includes('# SKIP'));
  const failLines = out.split('\n').filter((l) => /^not ok \d+ - /.test(l));
  const summary = (key) => {
    const m = out.match(new RegExp(`^# ${key} (\\d+)$`, 'm'));
    return m ? Number(m[1]) : null;
  };
  return {
    code: r.status, out, signal: r.signal, spawnError: r.error?.message ?? null,
    skipLines, executedOkLines, failLines,
    tests: summary('tests'), pass: summary('pass'),
    fail: summary('fail'), skipped: summary('skipped'),
  };
}

/**
 * Build a temp tree that contains a copy of one curated test file but none of
 * the private fixtures. For l1-failed-server.test.js the imported helper is
 * replaced by a shim that re-exports the real public helpers while reporting
 * the temp tree as ROOT (so existsSync sees the fixture-free tree).
 */
function fixtureFreeTree(testFile) {
  const t = scratch();
  t.write(`tests/${path.basename(testFile)}`, read(`tests/${testFile}`));
  if (testFile === 'l1-failed-server.test.js') {
    const real = pathToFileURL(path.join(ROOT, 'scripts', 'run-l1-smoke.mjs')).href;
    // ROOT must be the temp tree's root, otherwise existsSync() would find the
    // real private fixtures and the exercised code path would not be the SKIP
    // path we are verifying.
    t.write('scripts/run-l1-smoke.mjs', [
      `import { fileURLToPath } from 'node:url';`,
      `import path from 'node:path';`,
      `export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');`,
      `export { metricsFromExplore, fakeMetrics, compareWithBaseline,`,
      `  parseFailedServers, baselineScopeFor, evaluateL1Scope,`,
      `  deriveBaselineForServers, renderReport, parseArgs,`,
      `  DEFAULT_REAL_SERVERS, DENOMINATOR_FORMULA } from '${real}';`,
    ].join('\n'));
  }
  return t;
}

/* ------------------------------------------------------------------ *
 * 1. Source-level guards
 * ------------------------------------------------------------------ */

test('curation: l1-failed-server guards both private fixtures and skips with a reason', () => {
  const src = read('tests/l1-failed-server.test.js');
  assert.match(src, /existsSync\(path\.join\(ROOT, 'explore', 'tasks-smoke\.json'\)\)/);
  assert.match(src, /existsSync\(path\.join\(ROOT, 'explore', 'baselines', 'l1-smoke\.json'\)\)/);
  assert.match(src, /const fixtureTest = \(name, fn\) => test\(name, \{ skip: fixtureSkip \}, fn\)/);
  assert.match(src, /readJson\('explore\/tasks-smoke\.json'\)/);
  assert.ok(src.includes('const SMOKE = hasFixtures ?'), 'fixture read must be conditional, not top-level');
  assert.match(src, /excluded from the OSS export/);
});

test('curation: online-gap-tasks guards task JSON + snapshot dir before every read', () => {
  const src = read('tests/online-gap-tasks.test.js');
  assert.match(src, /existsSync\(TASKS_FILE\) && existsSync\(SNAPSHOT_DIR\)/);
  assert.match(src, /if \(hasFixtures\) \{[\s\S]*readFileSync\(TASKS_FILE/);
  assert.match(src, /const KNOWN = hasFixtures \? knownToolNames\(\) : new Set\(\)/);
  assert.match(src, /const fixtureTest = \(name, fn\) => test\(name, \{ skip: fixtureSkip \}, fn\)/);
  assert.match(src, /excluded from the OSS export/);
});

test('curation: measure-context skips with exit 0 when the private dataset is absent', () => {
  const src = read('scripts/measure-context.mjs');
  assert.match(src, /if \(!fs\.existsSync\(DATASET\)\)/);
  assert.match(src, /console\.log\('SKIP: data\/tool-dataset\.json/);
  assert.match(src, /process\.exit\(0\)/);
  const marker = src.indexOf('if (!fs.existsSync(DATASET))');
  const readMarker = src.indexOf('const allTools = JSON.parse');
  assert.ok(marker >= 0 && readMarker > marker, 'SKIP guard must run before the dataset read');
});

/* ------------------------------------------------------------------ *
 * 2. Fixture-missing -> explicit SKIP, never a fake pass
 * ------------------------------------------------------------------ */

function missingFixtureRun(name, testFile, expectedSkips) {
  const t = fixtureFreeTree(testFile);
  try {
    const r = runTap(path.join(t.dir, 'tests', path.basename(testFile)));
    assert.equal(r.code, 0, `fixture-free ${name} must not crash (signal=${r.signal}, spawnError=${r.spawnError}):\n${r.out}`);
    assert.equal(r.fail, 0, `no failures allowed:\n${r.out}`);
    assert.equal(r.skipped, expectedSkips, `expected ${expectedSkips} explicit skips:\n${r.out}`);
    assert.equal(r.skipLines.length, expectedSkips, 'every skipped test needs a # SKIP line');
    for (const line of r.skipLines) {
      assert.match(line, /private eval fixtures? .*excluded from the OSS export/,
        `skip must state the reason: ${line}`);
    }
    // A skipped test is TAP-"ok" but must NOT inflate the pass count.
    assert.equal(r.executedOkLines.length, r.pass,
      'skipped tests must not be counted as passing tests');
    assert.ok(r.pass < r.tests, 'at least one test must be reported as skipped, not passed');
    return r;
  } finally {
    t.cleanup();
  }
}

test('curation: l1-failed-server with missing fixtures -> 12 SKIPs with reasons, no false pass', () => {
  missingFixtureRun('l1-failed-server', 'l1-failed-server.test.js', 12);
});

test('curation: online-gap-tasks with missing fixtures -> 6 SKIPs with reasons, no false pass', () => {
  missingFixtureRun('online-gap-tasks', 'online-gap-tasks.test.js', 6);
});

test('curation: measure-context with missing dataset -> SKIP on stdout, exit 0, no output file', () => {
  const t = scratch();
  try {
    t.write('scripts/measure-context.mjs', read('scripts/measure-context.mjs'));
    t.write('src/codemode.js', 'export function createCodeModeTools() { return []; }\n');
    const r = spawnSync(process.execPath, [path.join(t.dir, 'scripts', 'measure-context.mjs')], {
      cwd: t.dir, encoding: 'utf8',
    });
    assert.equal(r.status, 0, `must exit 0:\n${r.stdout ?? ''}${r.stderr ?? ''}`);
    assert.match(r.stdout, /^SKIP: data\/tool-dataset\.json/m);
    assert.match(r.stdout, /excluded from the OSS export/);
    assert.doesNotMatch(r.stdout, /^=== Tool-definition/m, 'no measurement must be attempted');
    assert.equal(fs.existsSync(path.join(t.dir, 'work', 'context-measure.json')), false,
      'must not fabricate a measurement artifact');
  } finally {
    t.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * 3. Fixture-present -> tests actually run (no SKIP)
 * ------------------------------------------------------------------ */

test('curation: online-gap-tasks runs its assertions when fixtures exist', () => {
  const t = scratch();
  try {
    t.write('tests/online-gap-tasks.test.js', read('tests/online-gap-tasks.test.js'));
    // Minimal neutral snapshot: all five expected tools from the private task
    // set, so the "no unknown tool" assertion has real data to check.
    const names = [
      'github__get_file_contents', 'github__list_commits', 'notion__notion-search',
      'linear__list_comments', 'vercel__get_runtime_logs', 'figma__get_file',
    ];
    for (const server of ['github', 'notion', 'linear', 'vercel', 'figma']) {
      t.write(`data/tool-snapshots/${server}.json`, {
        server,
        tools: names.filter((n) => n.startsWith(`${server}__`)).map((name) => ({ name })),
      });
    }
    // Tasks are not required to pass here: the point is that they EXECUTE.
    t.write('explore/tasks-online-gap.json', { realWritesAllowed: false, count: 0, tasks: [] });
    const r = runTap(path.join(t.dir, 'tests', 'online-gap-tasks.test.js'));
    assert.equal(r.code, 1, 'synthetic empty task set must fail assertions, proving they ran');
    assert.equal(r.skipped, 0, 'fixture present -> zero SKIPs');
    assert.equal(r.skipLines.length, 0);
    assert.ok(r.failLines.length > 0, 'assertions must execute, not silently skip');
    assert.ok(r.tests > 0);
  } finally {
    t.cleanup();
  }
});

test('curation: l1-failed-server executes the gated tests when real fixtures exist', (t) => {
  const smoke = path.join(ROOT, 'explore', 'tasks-smoke.json');
  const baseline = path.join(ROOT, 'explore', 'baselines', 'l1-smoke.json');
  if (!fs.existsSync(smoke) || !fs.existsSync(baseline)) return t.skip(
    'private L1 fixtures not present in this tree; the fixture-present run is verified in the private repo',
  );
  const r = runTap(path.join(ROOT, 'tests', 'l1-failed-server.test.js'));
  assert.equal(r.code, 0, `fixture-present run must pass:\n${r.out}`);
  assert.equal(r.skipped, 0, 'all tests must execute when the fixture is available');
  assert.equal(r.fail, 0);
  assert.ok(r.executedOkLines.length >= 12, '12 fixture-dependent tests must actually run');
});
