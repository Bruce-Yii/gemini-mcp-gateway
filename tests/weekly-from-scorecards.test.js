import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildWeeklyFromScorecards } from '../scripts/weekly-from-scorecards.mjs';

function writeScorecard(dir, date, metrics) {
  writeFileSync(join(dir, `scorecard-${date}.json`), JSON.stringify({ date, metrics }), 'utf8');
}

test('weekly-from-scorecards: aggregates committed scorecards with zero R2 requests', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'weekly-scorecards-'));
  try {
    writeScorecard(dir, '2026-11-18', { requests: 10, mcpRequests: 9, errors: 1, errorRate: 0.1, p50Ms: 10, p95Ms: 100, truncated: 1, overflow: 0 });
    writeScorecard(dir, '2026-11-19', { requests: 20, mcpRequests: 20, errors: 0, errorRate: 0, p50Ms: 20, p95Ms: 200, truncated: 0, overflow: 1 });
    const result = await buildWeeklyFromScorecards({
      since: '2026-11-18', days: 2, docsDir: dir, outDir: join(dir, 'out'),
    });
    assert.equal(result.r2Requests, 0);
    assert.equal(result.dates.length, 2);
    assert.deepEqual(result.missing, []);
    assert.equal(result.totals.requests, 30);
    assert.equal(result.totals.errors, 1);
    assert.equal(result.totals.truncated, 1);
    assert.equal(result.totals.overflow, 1);
    const md = readFileSync(result.path, 'utf8');
    assert.match(md, /# Weekly Capture Review/);
    assert.match(md, /2026-11-18/);
    assert.match(md, /2026-11-19/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('weekly-from-scorecards: refusing to fabricate an empty report', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'weekly-empty-'));
  try {
    mkdirSync(join(dir, 'out'));
    await assert.rejects(
      () => buildWeeklyFromScorecards({ since: '2026-11-18', days: 2, docsDir: dir, outDir: join(dir, 'out') }),
      /NO_SCORECARDS/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
