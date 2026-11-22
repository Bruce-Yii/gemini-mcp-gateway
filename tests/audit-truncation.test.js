/**
 * Regression tests for scripts/audit-truncation.mjs.
 *
 * The audit is a lexical, read-only scanner. These tests use small in-memory
 * source fixtures plus temporary on-disk fixture trees (via --root) to pin
 * down severity classification, exempt uses, JSON output and exit codes.
 *
 * Crucially, the CI contract is asserted here: P0 fails the process, P1 is
 * warning-only, and P2 never fails. `npm test` must keep passing on a clean
 * tree while still detecting a newly introduced silent truncation in src/.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  scanSource,
  classify,
  auditTree,
  summarize,
  DEFAULT_ROOTS,
} from '../scripts/audit-truncation.mjs';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SCRIPT = join(REPO_ROOT, 'scripts', 'audit-truncation.mjs');

function severities(findings) {
  return findings.map((finding) => finding.severity);
}

/** Build a temporary fixture tree, run the real CLI against it, then clean up. */
function withFixtureTree(files, callback) {
  const root = mkdtempSync(join(tmpdir(), 'audit-truncation-'));
  try {
    for (const [path, source] of Object.entries(files)) {
      const full = join(root, path);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, source, 'utf8');
    }
    return callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function runCli(root, extraArgs = []) {
  return spawnSync(process.execPath, [SCRIPT, '--root', root, ...extraArgs], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
}

// ---------------------------------------------------------------------------
// Classification (pure fixtures)
// ---------------------------------------------------------------------------

test('P0: unmarked string slice in src/ is a production silent truncation', () => {
  const findings = scanSource(
    'export function f(result) { return result.text.slice(0, 100); }',
    'src/gateway.js',
  );
  assert.ok(findings.length >= 1, 'a cut must be reported');
  assert.ok(findings.some((finding) => finding.severity === 'P0'));
  assert.match(findings[0].reason, /production path/);
  assert.equal(findings[0].exempt, false);
});

test('P0: unmarked cap-based cut in src/ is reported', () => {
  const findings = scanSource(
    'const head = body.slice(0, maxBytes);',
    'src/stream.js',
  );
  assert.deepEqual(severities(findings), ['P0']);
});

test('P1: unmarked truncate() call site in scripts/ warns but does not fail', () => {
  const findings = scanSource(
    'const sample = truncate(issue.suggestedFix, 1200);',
    'scripts/analyze-captures.mjs',
  );
  assert.deepEqual(severities(findings), ['P1']);
  assert.equal(findings[0].exempt, false);
});

test('P1: harness/bench truncation of a result is possible-context truncation', () => {
  const findings = scanSource(
    'return (text || JSON.stringify(result)).slice(0, 8000);',
    'bench/run.mjs',
  );
  assert.deepEqual(severities(findings), ['P1']);
});

test('P2: explicitly marked truncation is acceptable', () => {
  const findings = scanSource(
    [
      'export function f(text) {',
      '  const out = text.slice(0, 500);',
      "  return out + '--- TRUNCATED --- [truncated]';",
      '}',
    ].join('\n'),
    'src/tool-format.js',
  );
  assert.ok(findings.length >= 1);
  assert.ok(findings.every((finding) => finding.severity === 'P2'));
  assert.ok(findings.some((finding) => /marker/i.test(finding.reason)));
});

test('P2: log/error-message truncation is acceptable with a note', () => {
  const findings = scanSource(
    'console.error(`HTTP ${res.status}: ${text.slice(0, 300)}`);',
    'src/store.js',
  );
  assert.ok(findings.length >= 1);
  assert.ok(findings.every((finding) => finding.severity === 'P2'));
});

test('exempt: argv parsing, date prefixes and prefix stripping are not findings', () => {
  const cases = [
    ['const args = process.argv.slice(2);', 'scripts/audit-tools.mjs'],
    ["const day = iso.slice(0, 10);", 'src/capture.js'],
    ["const value = arg.slice('--config='.length);", 'src/server.js'],
    ['const server = name.slice(0, separator);', 'harness/fake-upstream.mjs'],
  ];
  for (const [source, path] of cases) {
    const findings = scanSource(source, path);
    assert.ok(findings.every((finding) => finding.exempt), `expected exempt for: ${source}`);
  }
});

test('no hits: clean source produces no findings', () => {
  assert.deepEqual(scanSource('export const meaning = 42;\n', 'src/clean.js'), []);
});

test('classify() is exported and deterministic for the same input', () => {
  const candidate = {
    path: 'src/foo.js', line: 1, text: 's.slice(0, 10)', snippet: 's.slice(0, 10)',
    marker: false, kind: 'cut', fileMarked: false,
  };
  assert.deepEqual(classify(candidate), classify(candidate));
  assert.equal(classify(candidate).severity, 'P0');
});

// ---------------------------------------------------------------------------
// Exit codes / output contract (real CLI + fixture trees)
// ---------------------------------------------------------------------------

test('CLI exit code 1 on P0, with or without --json/--ci', () => {
  withFixtureTree({
    'src/bad.js': 'export function f(s) { return s.slice(0, 100); }\n',
  }, (root) => {
    for (const extra of [[], ['--json'], ['--ci']]) {
      const result = runCli(root, extra);
      assert.equal(result.status, 1, `expected exit 1 for args ${extra.join(' ')}`);
    }
  });
});

test('CLI exit code 0 with P1 only; --ci still prints the warning', () => {
  withFixtureTree({
    'scripts/warn.mjs': 'const x = truncate(payload, 500);\n',
  }, (root) => {
    const plain = runCli(root);
    assert.equal(plain.status, 0);
    assert.match(plain.stdout, /P1=1/);

    const ci = runCli(root, ['--ci']);
    assert.equal(ci.status, 0, 'P1 must be warning-only in CI');
    assert.match(ci.stdout, /P1 scripts\/warn\.mjs/);
    assert.match(ci.stdout, /PASS/);
  });
});

test('CLI exit code 0 with no hits; --json reports ok:true and counts', () => {
  withFixtureTree({
    'src/clean.js': 'export const x = 1;\n',
  }, (root) => {
    const plain = runCli(root);
    assert.equal(plain.status, 0);
    assert.match(plain.stdout, /P0=0 P1=0 P2=0/);

    const json = runCli(root, ['--json']);
    assert.equal(json.status, 0);
    const payload = JSON.parse(json.stdout);
    assert.equal(payload.ok, true);
    assert.deepEqual(payload.counts, { P0: 0, P1: 0, P2: 0 });
    assert.deepEqual(payload.findings, []);
  });
});

test('--ci hides P2 findings from the human summary but --json keeps them', () => {
  withFixtureTree({
    'src/log.js': 'console.error(`HTTP 500: ${text.slice(0, 300)}`);\n',
    'scripts/warn.mjs': 'const x = truncate(payload, 500);\n',
  }, (root) => {
    const ci = runCli(root, ['--ci']);
    assert.equal(ci.status, 0);
    assert.match(ci.stdout, /P0=0 P1=1 P2=1/);
    assert.doesNotMatch(ci.stdout, /P2 src\/log\.js/, 'CI view omits P2 detail');
    assert.match(ci.stdout, /P1 scripts\/warn\.mjs/);

    const json = JSON.parse(runCli(root, ['--json']).stdout);
    assert.equal(json.counts.P2, 1);
    assert.ok(json.findings.some((finding) => finding.severity === 'P2'));
  });
});

test('auditTree() scans only the configured roots', () => {
  withFixtureTree({
    'src/in.js': 'const a = text.slice(0, 50);\n',
    'docs/out.md': 'const b = text.slice(0, 50);\n',
    '.github/workflows/ci.yml': 'run: node scripts/audit-truncation.mjs --ci\n',
  }, (root) => {
    const report = auditTree({ root, roots: DEFAULT_ROOTS });
    assert.equal(report.filesScanned, 1, 'only src/ is scanned');
    assert.equal(report.findings.length, 1);
    assert.equal(report.findings[0].path, 'src/in.js');
  });
});

test('summarize() reports FAIL only when P0 > 0', () => {
  const clean = auditTree({
    root: REPO_ROOT,
    roots: ['src'],
  });
  // The committed repo must be clean at P0 (CI gate contract).
  assert.equal(clean.counts.P0, 0, 'committed src/ must not contain unmarked truncation');
  assert.match(summarize(clean, { mode: 'ci' }), /PASS/);

  const synthetic = { counts: { P0: 1, P1: 0, P2: 0 }, findings: [], filesScanned: 1 };
  assert.match(summarize(synthetic, { mode: 'ci' }), /FAIL/);
});
