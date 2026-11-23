import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MODULES,
  LEGACY_EDGES,
  moduleOf,
  importsOf,
  analyzeGraph,
} from '../scripts/check-module-boundaries.mjs';

test('module map covers the flat src layout', () => {
  assert.equal(moduleOf('codemode.js'), 'execution');
  assert.equal(moduleOf('client-profile.js'), 'client');
  assert.equal(moduleOf('upstream-auth.js'), 'upstream');
  assert.equal(moduleOf('capture.js'), 'evidence');
  assert.equal(moduleOf('vercel-app.js'), 'runtime');
  assert.equal(moduleOf('config.js'), 'shared');
  assert.equal(moduleOf('store.js'), 'shared');
  assert.equal(moduleOf('not-a-file.js'), 'unmapped');
  assert.equal(Object.values(MODULES).flat().length, 25);
});

test('importsOf parses relative ESM imports', () => {
  const source = `
    import a from './a.js';
    import { b } from './b';
    import c from 'crypto';
  `;
  assert.deepEqual(importsOf(source).sort(), ['a.js', 'b.js']);
});

test('analyzeGraph allows target direction and reports forbidden edges', () => {
  const graph = {
    'codemode.js': ['typed-plan.js', 'capture.js'],
    'typed-plan.js': ['file-write.js'],
    'capture.js': ['project-tag.js'],
    'upstreams.js': ['tool-format.js'],
  };
  const { edges, violations } = analyzeGraph(graph);
  const byPair = new Map(edges.map((e) => [`${e.fromFile}->${e.toFile}`, e]));
  assert.equal(byPair.get('codemode.js->typed-plan.js').allowed, true);
  assert.equal(byPair.get('typed-plan.js->file-write.js').allowed, true);
  assert.equal(byPair.get('capture.js->project-tag.js').allowed, true);
  assert.equal(byPair.get('codemode.js->capture.js').legacy, true);
  assert.equal(byPair.get('upstreams.js->tool-format.js').legacy, true);
  assert.equal(violations.length, 0);
});

test('new forbidden edges fail the audit', () => {
  const graph = {
    'codemode.js': ['upstreams.js'],
  };
  const { violations } = analyzeGraph(graph);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].from, 'execution');
  assert.equal(violations[0].to, 'upstream');
});

test('legacy debt set is explicit and non-empty', () => {
  assert.ok(LEGACY_EDGES.size > 0);
  assert.ok(LEGACY_EDGES.has('execution->evidence'));
});
