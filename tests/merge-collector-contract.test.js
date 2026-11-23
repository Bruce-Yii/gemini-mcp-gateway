import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TRACE = path.join(ROOT, 'explore', 'trace.mjs');
const hasPrivateTrace = existsSync(TRACE);
const skipReason = hasPrivateTrace
  ? false
  : 'private eval fixture explore/trace.mjs is excluded from the OSS export (see docs/OPEN-SOURCE/EXPORT-TEST-CURATION.md)';

// The module is imported dynamically so the clean export can skip explicitly
// instead of crashing at module load. In the private repo (fixture present)
// behaviour is unchanged: the real implementation is loaded and tested.
const { AnomalyCollector, mergeCollectors } = hasPrivateTrace
  ? await import('../explore/trace.mjs')
  : {};

test('mergeCollectors returns .items (run-explore must consume .items, not .anomalies)', { skip: skipReason }, () => {
  const c1 = new AnomalyCollector();
  c1.items.push({ task: 'A', type: 'execute_error', detail: 'x' });
  const c2 = new AnomalyCollector();
  c2.items.push({ task: 'B', type: 'retry', detail: 'y' });
  const merged = mergeCollectors([c1, c2]);
  assert.ok(Array.isArray(merged.items), 'must expose .items');
  assert.equal(merged.items.length, 2);
  assert.equal(merged.anomalies, undefined, 'no .anomalies field — callers using it would crash');
});
