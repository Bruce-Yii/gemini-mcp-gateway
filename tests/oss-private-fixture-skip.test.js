/**
 * OSS export regression: offline eval scripts must SKIP explicitly (exit 0,
 * with a reason on stdout) when their private fixtures are absent, rather
 * than crashing with ENOENT or silently reporting a successful measurement.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function run(script, args = []) {
  return spawnSync(process.execPath, [join(root, 'scripts', script), ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

function skipOnly(result, label) {
  assert.equal(result.status, 0, `${label}: ${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /^SKIP:/m, `${label} must print an explicit SKIP reason: ${result.stdout}`);
  assert.match(result.stdout, /private eval fixture excluded from OSS export/, `${label}: ${result.stdout}`);
  // A SKIP must not print measurement numbers that would look like a pass.
  assert.doesNotMatch(result.stdout, /^(top1|total=|catalog:)/m, `${label} printed a measurement despite SKIP: ${result.stdout}`);
}

test('eval-search.mjs SKIPs with a reason when the private tasks fixture is absent', () => {
  // Force the OSS-export condition even in a private checkout that still has
  // the fixtures: pass an explicit path that cannot exist.
  skipOnly(
    run('eval-search.mjs', ['--tasks', join(root, '__absent_private_fixture__', 'tasks.json')]),
    'eval-search.mjs',
  );
});

test('audit-tools.mjs SKIPs with a reason when the private figma snapshot is absent', () => {
  skipOnly(
    run('audit-tools.mjs', ['--server', 'figma', '--snapshot', join(root, '__absent_private_fixture__', 'figma.json')]),
    'audit-tools.mjs',
  );
});
