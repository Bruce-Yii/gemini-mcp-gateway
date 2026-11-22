import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ALLOWLIST,
  buildPlan,
  isAllowed,
  isDenied,
  parseArgs,
  validateExport,
  validateSelected,
} from '../scripts/export-oss.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts', 'export-oss.mjs');

let serial = 0;
function tempDir(label = 'export-oss') {
  serial += 1;
  return mkdtempSync(path.join(tmpdir(), `${label}-${process.pid}-${serial}-`));
}

function write(dir, rel, content = 'neutral content\n') {
  const abs = path.join(dir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
  return abs;
}

function fixture() {
  const src = tempDir('oss-src');
  // allowlisted files
  write(src, 'package.json', '{\n  "name": "codemode-mcp-gateway",\n  "repository": "example-org/example-repo"\n}\n');
  write(src, 'README.md', '# codemode-mcp-gateway\nPublic docs for example-org/example-repo.\n');
  write(src, 'config.example.json', '{"servers": []}\n');
  write(src, 'vercel.json', '{"rewrites": []}\n');
  write(src, 'src/server.js', 'export const ok = true;\n');
  write(src, 'tests/smoke.test.js', "import test from 'node:test';\n");
  write(src, 'scripts/smoke.mjs', 'console.log("smoke");\n');
  write(src, 'harness/fake-upstream.mjs', 'export const fake = true;\n');
  write(src, 'templates/docker/Dockerfile.example', 'FROM node:20\n');
  write(src, 'examples/basic/index.js', 'console.log("example");\n');
  write(src, 'docs/CLIENTS.md', '# Clients\n');
  write(src, '.github/workflows/ci.yml', 'name: ci\n');
  // denylisted files / dirs
  write(src, 'AGENTS.md', 'internal rules\n');
  write(src, 'project.json', '{"internal": true}\n');
  write(src, 'docs/ledger/2026.md', 'private ledger\n');
  write(src, 'docs/PLAN-OPEN.md', 'private plan\n');
  write(src, 'docs/HANDOFF-2026.md', 'private handoff\n');
  write(src, 'docs/OPEN-SOURCE/READINESS.md', 'internal audit\n');
  write(src, 'docs/OPEN-SOURCE/PLAN.md', 'public plan\n');
  write(src, 'explore/results/probe.json', '{"x":1}\n');
  write(src, 'work/draft.mjs', 'internal\n');
  write(src, 'outputs/run.log', 'log\n');
  write(src, 'capture/session.capture.json', '{"requestId":"x"}\n');
  write(src, 'data/vendor.json', '{"big":true}\n');
  write(src, '.github/workflows/capture-daily.yml', 'name: capture\n');
  write(src, '.github/workflows/l1-smoke.yml', 'name: l1\n');
  write(src, 'config.local.json', '{"token":"local"}\n');
  write(src, '.env', 'TOKEN=local\n');
  // outside allowlist but not denylisted (must be excluded, not copied)
  write(src, 'internal-notes/scratch.md', 'unlisted directory\n');
  return src;
}

function cli(args) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

test('teardown helper removes fixtures (sanity)', () => {
  const dir = tempDir('oss-sanity');
  assert.ok(existsSync(dir));
  rmSync(dir, { recursive: true, force: true });
  assert.equal(existsSync(dir), false);
});

test('isAllowed / isDenied classify allowlist and denylist paths', () => {
  assert.ok(ALLOWLIST.includes('src'));
  assert.ok(isAllowed('src/server.js'));
  assert.ok(isAllowed('docs/CLIENTS.md'));
  assert.equal(isAllowed('docs/ledger/2026.md'), false);
  assert.ok(isDenied('AGENTS.md'));
  assert.ok(isDenied('docs/PLAN-OPEN.md'));
  assert.ok(isDenied('docs/HANDOFF-2026.md'));
  assert.ok(isDenied('work/draft.mjs'));
  assert.ok(isDenied('capture/session.capture.json'));
  assert.ok(isDenied('.github/workflows/capture-daily.yml'));
  assert.ok(isDenied('config.local.json'));
  assert.ok(isDenied('.env'));
  assert.equal(isDenied('src/server.js'), false);
});

test('buildPlan includes allowlisted files and rejects denylist', () => {
  const src = fixture();
  try {
    const plan = buildPlan(src);
    assert.ok(plan.files.includes('src/server.js'));
    assert.ok(plan.files.includes('tests/smoke.test.js'));
    assert.ok(plan.files.includes('scripts/smoke.mjs'));
    assert.ok(plan.files.includes('harness/fake-upstream.mjs'));
    assert.ok(plan.files.includes('templates/docker/Dockerfile.example'));
    assert.ok(plan.files.includes('examples/basic/index.js'));
    assert.ok(plan.files.includes('docs/CLIENTS.md'));
    assert.ok(plan.files.includes('docs/OPEN-SOURCE/PLAN.md'));
    assert.ok(plan.files.includes('.github/workflows/ci.yml'));
    assert.ok(plan.directories.includes('src'));
    assert.ok(plan.directories.includes('templates/docker'));

    // denylisted paths never appear in files
    for (const rel of plan.denied) assert.ok(!plan.files.includes(rel));
    assert.ok(plan.denied.includes('AGENTS.md'));
    assert.ok(plan.denied.includes('project.json'));
    assert.ok(plan.denied.some((p) => p.startsWith('docs/ledger/')));
    assert.ok(plan.denied.includes('docs/PLAN-OPEN.md'));
    assert.ok(plan.denied.includes('docs/HANDOFF-2026.md'));
    assert.ok(plan.denied.includes('docs/OPEN-SOURCE/READINESS.md'));
    assert.ok(plan.denied.some((p) => p.startsWith('explore/')));
    assert.ok(plan.denied.some((p) => p.startsWith('work/')));
    assert.ok(plan.denied.some((p) => p.startsWith('outputs/')));
    assert.ok(plan.denied.some((p) => p.startsWith('capture/')));
    assert.ok(plan.denied.includes('.github/workflows/capture-daily.yml'));
    assert.ok(plan.denied.includes('.github/workflows/l1-smoke.yml'));
    assert.ok(plan.denied.includes('config.local.json'));
    assert.ok(plan.denied.includes('.env'));

    // outside-allowlist but not denied: still not copied
    assert.ok(plan.outsideAllowlist.some((p) => p.startsWith('internal-notes/')));
    assert.equal(plan.counts.included + plan.counts.denied + plan.counts.outsideAllowlist, plan.counts.total);
  } finally {
    rmSync(src, { recursive: true, force: true });
  }
});

test('validateExport passes on a clean fixture', () => {
  const src = tempDir('oss-clean');
  try {
    write(src, 'README.md', '# codemode-mcp-gateway\nPublic docs for example-org/example-repo.\n');
    write(src, 'src/server.js', 'export const ok = true;\n');
    write(src, 'docs/CLIENTS.md', '# Clients\n');
    write(src, 'config.example.json', '{"servers":[]}\n');
    const result = validateExport(src);
    assert.equal(result.ok, true, JSON.stringify(result.violations));
    assert.equal(result.violations.length, 0);
    assert.ok(result.checkedFiles > 0);
  } finally {
    rmSync(src, { recursive: true, force: true });
  }
});

test('validateExport catches denylist presence and sensitive strings', () => {
  const src = tempDir('oss-sensitive');
  try {
    const cases = [
      ['src/leak.js', 'const owner = "Bruce-Yii";', 'personal-handle'],
      ['docs/WHY.md', 'See D:\\12412\\dsh-home\\.secrets\\token for details', 'personal-path-dsh'],
      ['README.md', 'deployed at gemini-mcp-gateway.vercel.app', 'real-domain'],
      ['config.example.json', '{"API_KEY": "abcdefghijklmnopqrstuvwxyz"}', 'secret-assignment'],
    ];
    for (const [rel, content] of cases) write(src, rel, content);
    // denylist file that would also be caught
    write(src, 'docs/ledger/secret.md', 'private\n');

    const result = validateExport(src);
    assert.equal(result.ok, false);
    const kinds = new Set(result.violations.map((v) => v.kind));
    assert.ok(kinds.has('denylist'));
    assert.ok(kinds.has('personal-handle'));
    assert.ok(kinds.has('personal-path-dsh'));
    assert.ok(kinds.has('vault-path'));
    assert.ok(kinds.has('real-domain'));
    assert.ok(kinds.has('secret-assignment'));
  } finally {
    rmSync(src, { recursive: true, force: true });
  }
});

test('validateSelected checks only supplied plan files', () => {
  const src = fixture();
  try {
    write(src, 'src/leak.js', 'const who = "Bruce-Yii";\n');
    const clean = validateSelected(src, ['src/server.js', 'README.md']);
    assert.equal(clean.ok, true);
    const dirty = validateSelected(src, ['src/server.js', 'src/leak.js']);
    assert.equal(dirty.ok, false);
    assert.ok(dirty.violations.some((v) => v.file === 'src/leak.js' && v.kind === 'personal-handle'));
  } finally {
    rmSync(src, { recursive: true, force: true });
  }
});

test('parseArgs enforces flags and mutual exclusion', () => {
  assert.deepEqual(parseArgs(['--out', 'x']), {
    out: 'x', source: null, write: false, check: false, help: false, errors: [],
  });
  assert.equal(parseArgs(['--write', '--check', '--out', 'x']).errors.length, 1);
  assert.ok(parseArgs(['--bogus']).errors.some((e) => /unknown argument/.test(e)));
  assert.ok(parseArgs([]).errors.some((e) => /--out/.test(e)));
});

test('CLI dry-run does not write anything to staging', () => {
  const src = fixture();
  const out = tempDir('oss-out-dry');
  try {
    // Use a *clean* source: remove all denylist entries by using a smaller fixture.
    const clean = tempDir('oss-clean-src');
    write(clean, 'src/server.js', 'export const x = 1;\n');
    write(clean, 'README.md', '# public\n');
    try {
      const result = cli(['--out', out, '--source', clean]);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /mode=dry-run/);
      assert.match(result.stdout, /DRY RUN: no files written/);
      assert.match(result.stdout, /staging=/);
      assert.equal(existsSync(path.join(out, 'src')), false);
      assert.equal(existsSync(path.join(out, 'README.md')), false);
    } finally {
      rmSync(clean, { recursive: true, force: true });
    }
  } finally {
    rmSync(src, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test('CLI --write copies only allowlisted files and post-validates', () => {
  const src = tempDir('oss-write-src');
  const out = tempDir('oss-out-write');
  try {
    write(src, 'README.md', '# codemode-mcp-gateway\n');
    write(src, 'src/server.js', 'export const ok = true;\n');
    write(src, 'scripts/export-oss.mjs', 'console.log("export");\n');
    write(src, 'config.example.json', '{"servers":[]}\n');
    write(src, 'AGENTS.md', 'private\n'); // denylisted -> must abort entirely

    const blocked = cli(['--out', out, '--source', src, '--write']);
    assert.equal(blocked.status, 1, blocked.stdout + blocked.stderr);
    assert.match(blocked.stderr, /REFUSING to export/);
    assert.equal(existsSync(path.join(out, 'README.md')), false, 'nothing should be copied when denylist present');

    // now remove the denylisted file and retry
    rmSync(path.join(src, 'AGENTS.md'));
    const ok = cli(['--out', out, '--source', src, '--write']);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /post-export check passed/);
    assert.match(ok.stdout, /No git init\/commit\/push\/deploy performed/);
    assert.equal(readFileSync(path.join(out, 'src', 'server.js'), 'utf8'), 'export const ok = true;\n');
    assert.equal(existsSync(path.join(out, 'README.md')), true);
    assert.equal(existsSync(path.join(out, 'AGENTS.md')), false);
  } finally {
    rmSync(src, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test('CLI --check passes on clean staging and fails on dirty staging', () => {
  const out = tempDir('oss-check');
  try {
    write(out, 'README.md', '# codemode-mcp-gateway\n');
    write(out, 'src/server.js', 'export const ok = true;\n');
    const pass = cli(['--out', out, '--check']);
    assert.equal(pass.status, 0, pass.stdout + pass.stderr);
    assert.match(pass.stdout, /CHECK PASSED/);

    write(out, 'AGENTS.md', 'should not be public\n');
    const fail = cli(['--out', out, '--check']);
    assert.equal(fail.status, 1);
    assert.match(fail.stderr, /VIOLATION denylist/);
    assert.match(fail.stderr, /FAILED:/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('CLI refuses sensitive content before copying', () => {
  const src = tempDir('oss-sensitive-src');
  const out = tempDir('oss-sensitive-out');
  try {
    write(src, 'README.md', 'maintained by Bruce-Yii\n');
    const result = cli(['--out', out, '--source', src, '--write']);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /sensitive content detected in source/);
    assert.equal(existsSync(path.join(out, 'README.md')), false);
  } finally {
    rmSync(src, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});
