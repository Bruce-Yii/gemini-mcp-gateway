import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// scripts/check-task-coverage.mjs reads private Figma snapshots/tasks at
// module load. The pure checkCoverage() function is still worth testing in the
// private repo; the clean export skips the whole file explicitly. See
// docs/OPEN-SOURCE/EXPORT-TEST-CURATION.md.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hasCoverageFixtures = existsSync(path.join(ROOT, 'explore', 'figma-tasks.json'))
  && existsSync(path.join(ROOT, 'data', 'tool-snapshots', 'figma.json'))
  && existsSync(path.join(ROOT, 'data', 'tool-dataset.json'));
const skipReason = hasCoverageFixtures
  ? false
  : 'private eval fixtures (explore/figma-tasks.json, data/tool-snapshots/figma.json, data/tool-dataset.json) are excluded from the OSS export (see docs/OPEN-SOURCE/EXPORT-TEST-CURATION.md)';
const { checkCoverage } = hasCoverageFixtures
  ? await import('../scripts/check-task-coverage.mjs')
  : {};

const t = (name, fn) => test(name, { skip: skipReason }, fn);

const SERVER = { name: 'figma', denyTools: [], allowTools: [] };

function snapshot(names) {
  return { tools: names.map((name) => ({ name })) };
}

function task(overrides = {}) {
  return {
    id: 'FIG-001',
    server: 'figma',
    tool: 'a',
    prompt: 'Use the Figma tool a.',
    authority: 'schema-reverse',
    source: 'https://example.test/docs',
    expectedTools: ['a'],
    ...overrides,
  };
}

t('checkCoverage: every retained tool covered passes', () => {
  const result = checkCoverage({
    snapshot: snapshot(['a', 'b']),
    server: SERVER,
    tasks: [task(), task({ id: 'FIG-002', tool: 'b', expectedTools: ['b'] })],
  });
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.equal(result.stats.retained, 2);
  assert.equal(result.stats.covered, 2);
  assert.equal(result.stats.missing.length, 0);
});

t('checkCoverage: retained tool without task fails', () => {
  const result = checkCoverage({ snapshot: snapshot(['a', 'b']), server: SERVER, tasks: [task()] });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /retained tools without tasks: b/);
});

t('checkCoverage: task targeting denied tool fails', () => {
  const result = checkCoverage({
    snapshot: snapshot(['a', 'b']),
    server: { ...SERVER, denyTools: ['b'] },
    tasks: [task(), task({ id: 'FIG-002', tool: 'b', expectedTools: ['b'] })],
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /targets non-retained tool: b/);
});

t('checkCoverage: invalid authority and duplicate ids fail', () => {
  const result = checkCoverage({
    snapshot: snapshot(['a']),
    server: SERVER,
    tasks: [task(), task({ authority: 'guess' })],
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /duplicate task id/);
  assert.match(result.errors.join('\n'), /invalid authority/);
});

t('checkCoverage: expectedTools must include the task tool', () => {
  const result = checkCoverage({
    snapshot: snapshot(['a']),
    server: SERVER,
    tasks: [task({ expectedTools: [] })],
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /expectedTools must include a/);
});
