#!/usr/bin/env node
/**
 * Cross-platform test runner.
 *
 * `node --test <glob>` only expands globs from Node 22 onward, and Windows
 * shells do not expand them either. Enumerating the test files here keeps
 * `npm test` working on Node 20+ on every platform (and in CI).
 *
 * Extra CLI args (e.g. --watch) are forwarded to `node --test`.
 */
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testsDir = path.join(root, 'tests');
const files = readdirSync(testsDir)
  .filter((name) => name.endsWith('.test.js'))
  .sort()
  .map((name) => path.join(testsDir, name));

if (files.length === 0) {
  console.error('[test] no tests/*.test.js files found');
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], {
  cwd: root,
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
