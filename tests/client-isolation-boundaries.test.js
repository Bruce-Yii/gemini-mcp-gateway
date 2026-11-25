/**
 * M1 physical client isolation — module-boundary NEGATIVE tests.
 *
 * Proves `scripts/check-module-boundaries.mjs` actually catches the two new
 * physical rules instead of only passing on the current (clean) tree:
 *
 *   Rule A: src/clients/<platformA>/** importing src/clients/<platformB>/**
 *           (A != B), or src/clients/_base/** importing a concrete platform.
 *   Rule B: src/execution|upstream|evidence/** importing
 *           src/clients/{gemini,chatgpt,claude}/**.
 *
 * Both function-level inputs (fast, exact rule ids) and an end-to-end CLI run
 * against a temporary src tree (non-zero exit code) are covered. A final test
 * runs the audit against this repository, so CI would fail if the real tree
 * ever drifts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  CLIENT_BOUNDARY_RULES,
  CLIENT_PLATFORMS,
  analyzeClientBoundaries,
  clientPlatformOf,
  importsOf,
  parseArgs,
  relativeImportsOf,
  resolveImportTarget,
  scanClientModules,
} from '../scripts/check-module-boundaries.mjs';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const SCRIPT = fileURLToPath(new URL('../scripts/check-module-boundaries.mjs', import.meta.url));

function analyze(graph) {
  return analyzeClientBoundaries(graph);
}

function ruleOf(violations, fromFile, toFile) {
  return violations.find((v) => v.fromFile === fromFile && v.toFile === toFile)?.rule ?? null;
}

/* ================================================================== *
 * 1. Rule A — concrete platform must not import another platform
 * ================================================================== */

test('rule A: gemini importing chatgpt is a violation with the rule-A id', () => {
  const { violations } = analyze({
    'clients/gemini/index.js': ['../chatgpt/index.js'],
  });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].rule, CLIENT_BOUNDARY_RULES.CROSS_CLIENT_IMPORT);
  assert.equal(violations[0].from, 'clients/gemini');
  assert.equal(violations[0].to, 'clients/chatgpt');
  assert.equal(violations[0].allowed, false);
});

test('rule A: every ordered platform pair is caught (A != B), including prompts.js', () => {
  const platforms = [...CLIENT_PLATFORMS];
  for (const from of platforms) {
    for (const to of platforms) {
      if (from === to) continue;
      const graph = { [`clients/${from}/prompts.js`]: [`../${to}/prompts.js`] };
      const { violations } = analyze(graph);
      assert.equal(violations.length, 1, `${from}->${to}`);
      assert.equal(violations[0].rule, CLIENT_BOUNDARY_RULES.CROSS_CLIENT_IMPORT);
    }
  }
});

test('rule A: the shared base must never import a concrete platform', () => {
  const { violations } = analyze({
    'clients/_base/index.js': ['../claude/index.js'],
  });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].rule, CLIENT_BOUNDARY_RULES.CROSS_CLIENT_IMPORT);
  assert.match(violations[0].reason, /shared base/);
});

test('rule A allows own-platform, base and router imports', () => {
  const { violations } = analyze({
    'clients/gemini/index.js': ['./prompts.js', '../_base/index.js', '../index.js'],
    'clients/_base/index.js': ['../../client/client-profile.js', '../../shared/catalog.js'],
    'clients/index.js': ['./gemini/index.js', './chatgpt/index.js', './claude/index.js', './_base/index.js'],
    'clients/chatgpt/prompts.js': ['./prompts.js'],
  });
  assert.deepEqual(violations, []);
});

test('rule A reports the allowed router/platform wiring as edges (no silent under-detection)', () => {
  const { edges, violations } = analyze({
    'clients/index.js': ['./gemini/index.js', './chatgpt/index.js', './claude/index.js', './_base/index.js'],
    'clients/gemini/index.js': ['./prompts.js', '../_base/index.js'],
  });
  assert.deepEqual(violations, []);
  const keys = edges.map((e) => `${e.fromFile}->${e.toFile}:${e.allowed}`);
  assert.ok(keys.includes('clients/index.js->clients/gemini/index.js:true'), 'router -> gemini edge');
  assert.ok(keys.includes('clients/index.js->clients/_base/index.js:true'), 'router -> base edge');
  assert.ok(keys.includes('clients/gemini/index.js->clients/gemini/prompts.js:true'), 'own prompts edge');
  assert.ok(keys.includes('clients/gemini/index.js->clients/_base/index.js:true'), 'base edge');
});

test('rule B reports the allowed router/base edges as edges too', () => {
  const { edges, violations } = analyze({
    'execution/codemode.js': ['../clients/index.js', '../clients/_base/index.js'],
  });
  assert.deepEqual(violations, []);
  assert.equal(edges.length, 2);
  assert.ok(edges.every((edge) => edge.allowed === true && edge.rule === null));
});

/* ================================================================== *
 * 2. Rule B — objective layers must not import a concrete client
 * ================================================================== */

test('rule B: execution/upstream/evidence importing any concrete client is a violation', () => {
  for (const layer of ['execution/codemode.js', 'execution/codemode-v2.js', 'upstream/upstreams.js', 'evidence/capture.js']) {
    for (const platform of CLIENT_PLATFORMS) {
      for (const file of ['index.js', 'prompts.js']) {
        const target = `../clients/${platform}/${file}`;
        const graph = { [layer]: [target] };
        const { violations } = analyze(graph);
        assert.equal(violations.length, 1, `${layer}->${target}`);
        assert.equal(violations[0].rule, CLIENT_BOUNDARY_RULES.OBJECTIVE_IMPORTS_CLIENT);
        assert.equal(violations[0].to, `clients/${platform}`);
      }
    }
  }
});

test('rule B allows importing the router and the shared base', () => {
  const { violations } = analyze({
    'execution/codemode.js': ['../clients/index.js', '../clients/_base/index.js'],
    'upstream/upstreams.js': ['../clients/index.js'],
    'evidence/capture.js': ['../clients/_base/index.js'],
  });
  assert.deepEqual(violations, []);
});

test('rule A and rule B are reported under distinct rule ids', () => {
  const ids = Object.values(CLIENT_BOUNDARY_RULES);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.length, 2);
  assert.ok(ids.every((id) => typeof id === 'string' && id.length > 0));
});

/* ================================================================== *
 * 3. Path helpers used by the physical rules
 * ================================================================== */

test('resolveImportTarget normalizes ../, ./, backslashes and bare specifiers', () => {
  assert.equal(resolveImportTarget('execution/codemode.js', '../clients/index.js'), 'clients/index.js');
  assert.equal(resolveImportTarget('clients/gemini/index.js', '../chatgpt/index.js'), 'clients/chatgpt/index.js');
  assert.equal(resolveImportTarget('clients/gemini/index.js', './prompts.js'), 'clients/gemini/prompts.js');
  assert.equal(resolveImportTarget('clients\\gemini\\index.js', '..\\_base\\index.js'), 'clients/_base/index.js');
  assert.equal(resolveImportTarget('execution/codemode.js', 'node:fs'), null);
  assert.equal(resolveImportTarget('execution/codemode.js', 'run'), null);
});

test('relativeImportsOf keeps ./ and sees side-effect imports; importsOf keeps legacy semantics', () => {
  const source = `
    import { a } from './a.js';
    import { b } from '../module/b';
    import '../clients/gemini/prompts.js';
    import c from 'run';
  `;
  assert.deepEqual(relativeImportsOf(source).sort(), [
    '../clients/gemini/prompts.js',
    '../module/b.js',
    './a.js',
  ]);
  // Legacy API (flat basenames) is unchanged: './a.js' -> 'a.js', no bare pkg.
  assert.deepEqual(importsOf(source).sort(), ['../module/b.js', 'a.js']);
});

test('clientPlatformOf only recognizes the three concrete platform dirs', () => {
  assert.equal(clientPlatformOf('clients/gemini/index.js'), 'gemini');
  assert.equal(clientPlatformOf('clients/chatgpt/prompts.js'), 'chatgpt');
  assert.equal(clientPlatformOf('clients/claude/index.js'), 'claude');
  assert.equal(clientPlatformOf('clients/_base/index.js'), null);
  assert.equal(clientPlatformOf('clients/index.js'), null);
  assert.equal(clientPlatformOf('execution/codemode.js'), null);
});

test('the real repository exposes the physical client tree to the scanner', () => {
  const files = scanClientModules(path.join(REPO_ROOT, 'src'));
  for (const expected of [
    'clients/index.js',
    'clients/_base/index.js',
    'clients/gemini/index.js',
    'clients/gemini/prompts.js',
    'clients/chatgpt/index.js',
    'clients/chatgpt/prompts.js',
    'clients/claude/index.js',
    'clients/claude/prompts.js',
  ]) {
    assert.ok(files.includes(expected), `missing ${expected}`);
  }
});

/* ================================================================== *
 * 4. End-to-end CLI: violations must exit non-zero
 * ================================================================== */

function makeTempTree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-client-boundary-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, 'src', rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

function runAudit(srcDir, extraArgs = []) {
  const run = spawnSync(process.execPath, [SCRIPT, '--src', srcDir, ...extraArgs], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return { status: run.status, output: `${run.stdout ?? ''}${run.stderr ?? ''}` };
}

test('e2e: a cross-client import makes the audit exit non-zero and names rule A', () => {
  const root = makeTempTree({
    'clients/index.js': "import './gemini/index.js';\n",
    'clients/_base/index.js': 'export const base = 1;\n',
    'clients/gemini/index.js': "import '../chatgpt/index.js';\nexport const gemini = 1;\n",
    'clients/chatgpt/index.js': 'export const chatgpt = 1;\n',
    'clients/claude/index.js': "import '../_base/index.js';\nexport const claude = 1;\n",
  });
  try {
    const { status, output } = runAudit(path.join(root, 'src'));
    assert.notEqual(status, 0, 'cross-client import must fail the audit');
    assert.match(output, /rule-a\/cross-client-import/);
    assert.match(output, /NEW CLIENT VIOLATIONS/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('e2e: an objective layer importing a concrete client exits non-zero and names rule B', () => {
  const root = makeTempTree({
    'execution/codemode.js': "import '../clients/gemini/index.js';\nexport const codemode = 1;\n",
    'clients/index.js': "import './gemini/index.js';\n",
    'clients/gemini/index.js': 'export const gemini = 1;\n',
  });
  try {
    const { status, output } = runAudit(path.join(root, 'src'));
    assert.notEqual(status, 0, 'execution -> concrete client must fail the audit');
    assert.match(output, /rule-b\/objective-imports-client/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('e2e: a clean tree (router + base only) exits zero and reports both rule counters', () => {
  const root = makeTempTree({
    'execution/codemode.js': "import { x } from '../clients/index.js';\nexport const codemode = x;\n",
    'clients/index.js': "import './gemini/index.js';\nimport './chatgpt/index.js';\nimport './claude/index.js';\nimport './_base/index.js';\nexport const x = 1;\n",
    'clients/_base/index.js': 'export const base = 1;\n',
    'clients/gemini/index.js': "import '../_base/index.js';\nexport const gemini = 1;\n",
    'clients/chatgpt/index.js': "import '../_base/index.js';\nexport const chatgpt = 1;\n",
    'clients/claude/index.js': "import '../_base/index.js';\nexport const claude = 1;\n",
  });
  try {
    const { status, output } = runAudit(path.join(root, 'src'));
    assert.equal(status, 0, output);
    assert.match(output, /\[client-boundaries\]/);
    assert.match(output, /rule A cross-client imports: 0/);
    assert.match(output, /rule B objective-layer -> concrete client imports: 0/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('e2e: --json exposes the client-boundary section with rule ids', () => {
  const root = makeTempTree({
    'clients/gemini/index.js': "import '../claude/index.js';\nexport const gemini = 1;\n",
    'clients/claude/index.js': 'export const claude = 1;\n',
  });
  try {
    const { status, output } = runAudit(path.join(root, 'src'), ['--json']);
    assert.notEqual(status, 0);
    const report = JSON.parse(output);
    assert.equal(report.clients.newViolations, 1);
    assert.equal(report.clients.ruleAViolations, 1);
    assert.equal(report.clients.ruleBViolations, 0);
    assert.equal(report.clients.violations[0].rule, CLIENT_BOUNDARY_RULES.CROSS_CLIENT_IMPORT);
    assert.deepEqual(report.clients.platforms, ['gemini', 'chatgpt', 'claude']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('parseArgs keeps the default src tree and supports --src / --src=', () => {
  const defaults = parseArgs([]);
  assert.equal(defaults.json, false);
  assert.equal(defaults.strict, false);
  assert.equal(path.basename(defaults.srcDir), 'src');
  assert.equal(parseArgs(['--strict', '--json']).strict, true);
  const spaced = parseArgs(['--src', path.join(os.tmpdir(), 'x')]);
  assert.equal(spaced.srcDir, path.resolve(os.tmpdir(), 'x'));
  const inline = parseArgs([`--src=${path.join(os.tmpdir(), 'x')}`]);
  assert.equal(inline.srcDir, path.resolve(os.tmpdir(), 'x'));
});

/* ================================================================== *
 * 5. The real repository must stay clean
 * ================================================================== */

test('the real repository passes both physical rules', () => {
  const { status, output } = runAudit(path.join(REPO_ROOT, 'src'));
  assert.equal(status, 0, output);
  assert.match(output, /new violations=0/);
  assert.match(output, /rule A cross-client imports: 0/);
  assert.match(output, /rule B objective-layer -> concrete client imports: 0/);
});
