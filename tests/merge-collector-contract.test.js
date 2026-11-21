import test from 'node:test';
import assert from 'node:assert/strict';
import { AnomalyCollector, mergeCollectors } from '../explore/trace.mjs';

test('mergeCollectors returns .items (run-explore must consume .items, not .anomalies)', () => {
  const c1 = new AnomalyCollector();
  c1.items.push({ task: 'A', type: 'execute_error', detail: 'x' });
  const c2 = new AnomalyCollector();
  c2.items.push({ task: 'B', type: 'retry', detail: 'y' });
  const merged = mergeCollectors([c1, c2]);
  assert.ok(Array.isArray(merged.items), 'must expose .items');
  assert.equal(merged.items.length, 2);
  assert.equal(merged.anomalies, undefined, 'no .anomalies field — callers using it would crash');
});
