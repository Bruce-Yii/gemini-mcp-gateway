import test from 'node:test';
import assert from 'node:assert/strict';

import { checkCoverage } from '../scripts/check-task-coverage.mjs';

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

test('checkCoverage: every retained tool covered passes', () => {
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

test('checkCoverage: retained tool without task fails', () => {
  const result = checkCoverage({ snapshot: snapshot(['a', 'b']), server: SERVER, tasks: [task()] });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /retained tools without tasks: b/);
});

test('checkCoverage: task targeting denied tool fails', () => {
  const result = checkCoverage({
    snapshot: snapshot(['a', 'b']),
    server: { ...SERVER, denyTools: ['b'] },
    tasks: [task(), task({ id: 'FIG-002', tool: 'b', expectedTools: ['b'] })],
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /targets non-retained tool: b/);
});

test('checkCoverage: invalid authority and duplicate ids fail', () => {
  const result = checkCoverage({
    snapshot: snapshot(['a']),
    server: SERVER,
    tasks: [task(), task({ authority: 'guess' })],
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /duplicate task id/);
  assert.match(result.errors.join('\n'), /invalid authority/);
});

test('checkCoverage: expectedTools must include the task tool', () => {
  const result = checkCoverage({
    snapshot: snapshot(['a']),
    server: SERVER,
    tasks: [task({ expectedTools: [] })],
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /expectedTools must include a/);
});
