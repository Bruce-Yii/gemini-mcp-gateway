/**
 * tests/oss-neutralizer.test.js — P0 regression suite for OSS handle leaks.
 *
 * The old neutralizer rewrote the private handle into a JS unicode escape and
 * the old detector matched only the literal form, so `--check` falsely passed
 * on an export tree containing ~60 recoverable handle occurrences.
 *
 * All handle strings in this file are assembled at runtime from neutral pieces
 * so the exported copy of this test file never contains a detector hit.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  canonicalizeForScan, detectHandleForms, hasHandleLeak,
  neutralizeHandleText, validateExport, validateSelected,
} from '../scripts/export-oss.mjs';
import {
  assertClean, handlePatterns, neutralizeText,
} from '../scripts/prepare-neutral-source.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXPORT_SCRIPT = path.join(ROOT, 'scripts', 'export-oss.mjs');
const NEUTRALIZER_SCRIPT = path.join(ROOT, 'scripts', 'prepare-neutral-source.mjs');

// Assembled at runtime; no contiguous handle literal appears in this source.
const A = String.fromCharCode(66, 114, 117, 99, 101);
const B = String.fromCharCode(89, 105, 105);
const literal = () => `${A}-${B}`;
const escaped = (backslashCount = 1) => `${A}${'\\'.repeat(backslashCount)}u002d${B}`;
const urlEncoded = (times = 1) => `${A}${times === 1 ? '%2d' : `${'%25'.repeat(times - 1)}2d`}${B}`;

let serial = 0;
function tempDir(prefix) {
  serial += 1;
  return mkdtempSync(path.join(tmpdir(), `${prefix}-${process.pid}-${serial}-`));
}
function write(dir, rel, content) {
  const abs = path.join(dir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
  return abs;
}

/* ------------------------------------------------------------------ *
 * 1. Detector catches every equivalent form
 * ------------------------------------------------------------------ */
test('detectHandleForms catches literal, escaped, URL-encoded and case variants', () => {
  const cases = [
    ['literal', literal()],
    ['literal-uppercase', literal().toUpperCase()],
    ['literal-mixed-case', `${A}-${B.toUpperCase()}`],
    ['unicode-escape', escaped(1)],
    ['double-backslash-escape', escaped(2)],
    ['url-encoded', urlEncoded(1)],
    ['double-url-encoded', urlEncoded(2)],
    ['html-entity', `${A}&#45;${B}`],
    ['concatenation', `'${A}' + '-${B}'`],
  ];
  for (const [name, sample] of cases) {
    assert.equal(hasHandleLeak(sample), true, `${name} was not detected: ${sample}`);
    assert.ok(detectHandleForms(sample).length > 0, `${name}: no form reported`);
  }
});

test('canonicalizeForScan decodes nested escapes to the same token', () => {
  const canonical = canonicalizeForScan(literal());
  assert.ok(canonical.includes(literal().toLowerCase()));
  for (const sample of [escaped(1), escaped(2), urlEncoded(1), urlEncoded(2), `${A}&#45;${B}`]) {
    assert.ok(canonicalizeForScan(sample).includes(literal().toLowerCase()), sample);
  }
});

test('detectHandleForms does not report clean content', () => {
  const clean = [
    'example-org/example-repo',
    'git+https://github.com/example-org/gemini-mcp-gateway.git',
    'const owner = "octocat";',
    ' integrity": "sha512-abcYyii07tpPsLw=="',
    'https://example-org.example.com/docs',
    '',
  ];
  for (const sample of clean) {
    assert.deepEqual(detectHandleForms(sample), [], `false positive on: ${sample}`);
  }
});

/* ------------------------------------------------------------------ *
 * 2. Neutralizer removes every form and stays syntactically neutral
 * ------------------------------------------------------------------ */
test('neutralizeText removes literal / escaped / URL / concatenated forms', () => {
  const samples = [
    literal(),
    escaped(1),
    escaped(2),
    urlEncoded(1),
    urlEncoded(2),
    `${A}&#45;${B}`,
    `'${A}' + '-${B}'`,
    `const OWNER = '${literal()}';`,
    `git+https://github.com/${literal()}/example-repo.git`,
  ];
  for (const sample of samples) {
    const out = neutralizeText(sample);
    assert.equal(hasHandleLeak(out.text), false, `leak after neutralization: ${sample}`);
    assert.ok(!out.text.includes(A), out.text);
    assert.ok(!out.text.includes(B), out.text);
    assert.ok(out.replacements > 0, `no replacement recorded for ${sample}`);
  }
});

// In the clean OSS export the neutralizer's private signature constants are
// deliberately scrubbed, so this self-neutralization check has no subject.
// Skip it there with an explicit reason; it still runs in the private repo
// where the signature constants are present.
const signaturePresent = (() => {
  try {
    const source = readFileSync(NEUTRALIZER_SCRIPT, 'utf8');
    return source.includes(`const SEG_A = '${A}'`) && source.includes(`const SEG_B = '${B}'`);
  } catch {
    return false;
  }
})();
const signatureSkip = signaturePresent
  ? false
  : 'private handle signature constants are scrubbed from scripts/prepare-neutral-source.mjs in the OSS export';

test('neutralizer self-neutralizes its own signature constants', { skip: signatureSkip }, () => {
  const source = readFileSync(NEUTRALIZER_SCRIPT, 'utf8');
  assert.ok(source.includes(`const SEG_A = '${A}'`));
  assert.ok(source.includes(`const SEG_B = '${B}'`));
  const out = neutralizeText(source, { self: true });
  assert.equal(hasHandleLeak(out.text), false);
  assert.ok(!out.text.includes(`const SEG_A = '${A}'`));
  assert.ok(!out.text.includes(`const SEG_B = '${B}'`));
  assertClean(out.text, 'self-neutralized script');
});

test('handlePatterns are shared with the detector grammar', () => {
  const patterns = handlePatterns();
  assert.ok(patterns.length >= 5);
  for (const sample of [literal(), escaped(1), urlEncoded(1), `'${A}' + '-${B}'`]) {
    const out = neutralizeHandleText(sample, patterns, 'example-org');
    assert.equal(hasHandleLeak(out.text), false, sample);
  }
});

/* ------------------------------------------------------------------ *
 * 3. validateExport / validateSelected hard-fail on any form
 * ------------------------------------------------------------------ */
test('validateExport fails on escaped handle in any exported text file', () => {
  const dir = tempDir('oss-leak-detect');
  try {
    write(dir, 'README.md', `# public\nmaintained by ${escaped(1)}\n`);
    const result = validateExport(dir);
    assert.equal(result.ok, false);
    assert.ok(result.violations.some((v) => v.file === 'README.md' && v.kind === 'personal-handle'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('validateSelected fails on URL-encoded handle and passes clean files', () => {
  const dir = tempDir('oss-selected');
  try {
    write(dir, 'src/clean.js', 'export const ok = true;\n');
    write(dir, 'src/leak.js', `const profile = '${urlEncoded(1)}';\n`);
    assert.equal(validateSelected(dir, ['src/clean.js']).ok, true);
    const dirty = validateSelected(dir, ['src/clean.js', 'src/leak.js']);
    assert.equal(dirty.ok, false);
    assert.ok(dirty.violations.some((v) => v.file === 'src/leak.js' && v.kind === 'personal-handle'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('validateExport passes a clean staging fixture', () => {
  const dir = tempDir('oss-clean');
  try {
    write(dir, 'README.md', '# example-org/example-repo\n');
    write(dir, 'package.json', '{"repository":"example-org/example-repo"}\n');
    const result = validateExport(dir);
    assert.equal(result.ok, true, JSON.stringify(result.violations));
    assert.equal(result.violations.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * 4. CLI --check exit codes (the false-PASS regression)
 * ------------------------------------------------------------------ */
function cli(scriptPath, args) {
  return spawnSync(process.execPath, [scriptPath, ...args], { cwd: ROOT, encoding: 'utf8' });
}

test('export-oss --check exits 0 on clean staging and 1 on escaped handle', () => {
  const dir = tempDir('oss-cli-check');
  try {
    write(dir, 'README.md', '# public\n');
    const pass = cli(EXPORT_SCRIPT, ['--out', dir, '--check']);
    assert.equal(pass.status, 0, pass.stdout + pass.stderr);
    assert.match(pass.stdout, /CHECK PASSED/);

    write(dir, 'src/leak.js', `const owner = '${escaped(1)}';\n`);
    const fail = cli(EXPORT_SCRIPT, ['--out', dir, '--check']);
    assert.equal(fail.status, 1, fail.stdout + fail.stderr);
    assert.match(fail.stderr, /VIOLATION personal-handle/);
    assert.match(fail.stderr, /FAILED:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('export-oss --check fails on URL-encoded and concatenated forms', () => {
  for (const payload of [urlEncoded(1), `'${A}' + '-${B}'`]) {
    const dir = tempDir('oss-cli-form');
    try {
      write(dir, 'src/leak.js', `const owner = ${JSON.stringify(payload)};\n`);
      const result = cli(EXPORT_SCRIPT, ['--out', dir, '--check']);
      assert.equal(result.status, 1, `${payload}: ${result.stdout}${result.stderr}`);
      assert.match(result.stderr, /VIOLATION personal-handle/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('prepare-neutral-source --check exits 0 on a clean neutralizer build', () => {
  const out = tempDir('oss-neutral-cli');
  try {
    const result = cli(NEUTRALIZER_SCRIPT, ['--out', out, '--check']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /NEUTRAL CHECK PASSED/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
