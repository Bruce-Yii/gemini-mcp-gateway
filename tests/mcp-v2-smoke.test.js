/**
 * Tests around scripts/mcp-v2-smoke.mjs — the offline live smoke for /mcp/v2.
 *
 * This file does NOT duplicate the smoke's assertions: it runs the exact same
 * `runSmoke()` the CLI uses, over a loopback ephemeral port with fake upstream /
 * fake typed-plan IO / fake token store, and verifies that every named check
 * is present and green. It also verifies the report contract (`{ok, checks[]}`)
 * and that the smoke fails loudly when a check is broken (injecting a fetch
 * wrapper that sabotages one request).
 *
 * No network, no credentials, no filesystem writes, no process.env mutation.
 * Concurrent full-suite runs are safe: each run binds its own ephemeral port.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { runSmoke, startSmokeServer } from '../scripts/mcp-v2-smoke.mjs';

const EXPECTED_CHECKS = [
  'v1_tools_shape_unchanged',
  'v2_tools_shape',
  'v2_plan_simple_success',
  'v2_readonly_rejects_write',
  'v2_write_requires_approve',
  'v1_rejects_plan',
  'v2_requires_plan_or_code',
  'flag_off_v2_404',
  'v2_auth_401_challenge',
];

test('mcp-v2 smoke: report contract and all checks pass', async () => {
  const report = await runSmoke();

  assert.equal(typeof report.ok, 'boolean');
  assert.ok(Array.isArray(report.checks));
  assert.deepEqual(report.checks.map((c) => c.name), EXPECTED_CHECKS);
  for (const check of report.checks) {
    assert.equal(typeof check.ok, 'boolean', `${check.name}: ok must be boolean`);
    assert.equal(check.ok, true, `${check.name} failed: ${JSON.stringify(check.detail)}`);
  }
  assert.equal(report.ok, true, `smoke failed: ${JSON.stringify(report.checks.filter((c) => !c.ok))}`);
});

test('mcp-v2 smoke: key evidence from the live HTTP responses', async () => {
  const { checks } = await runSmoke();
  const byName = Object.fromEntries(checks.map((c) => [c.name, c.detail]));

  // Same three tools, same order, different schema hashes (v1 code-only vs v2 plan).
  assert.deepEqual(byName.v1_tools_shape_unchanged.names, ['search', 'execute_read', 'execute']);
  assert.deepEqual(byName.v2_tools_shape.names, ['search', 'execute_read', 'execute']);
  assert.notEqual(byName.v1_tools_shape_unchanged.schemaHash, byName.v2_tools_shape.schemaHash);
  assert.deepEqual(byName.v2_readonly_rejects_write.steps, 0);
  assert.match(byName.v2_readonly_rejects_write.error, /not allowed in read-only mode/);
  assert.match(byName.v2_write_requires_approve.error, /requires dryRun or explicit approve/);
  assert.equal(byName.v1_rejects_plan.ignoredPlan, true);
  assert.equal(byName.v1_rejects_plan.ioCallsUnchanged, true);
  assert.match(byName.v2_requires_plan_or_code.executeEmpty, /E-VAL-NONE/);
  assert.match(byName.v2_requires_plan_or_code.both, /E-VAL-BOTH/);
  assert.equal(byName.flag_off_v2_404.v2Status, 404);
  assert.equal(byName.flag_off_v2_404.v1Status, 200);
  assert.equal(byName.v2_auth_401_challenge.status, 401);
  assert.equal(byName.v2_auth_401_challenge.metaChallengeCount, 1);
  assert.equal(byName.v2_auth_401_challenge.authenticatedV2Status, 200);
});

test('mcp-v2 smoke: an injected failure is reported as ok:false with named detail', async () => {
  // startSmokeServer is exported so the test can supply a sabotaging fetch
  // without changing the CLI or any src/ file.
  const server = await startSmokeServer();
  try {
    const realFetch = globalThis.fetch;
    const sabotaged = async (url, options) => {
      if (String(url).endsWith('/mcp/v2')) {
        return new Response('sabotaged transport', { status: 502, headers: { 'content-type': 'text/plain' } });
      }
      return realFetch(url, options);
    };
    const report = await runSmoke({ fetchImpl: sabotaged, baseUrl: server.baseUrl });
    assert.equal(report.ok, false);
    const failed = report.checks.filter((c) => !c.ok).map((c) => c.name);
    assert.ok(failed.length > 0, 'sabotage must be visible in the report');
    assert.ok(failed.includes('v2_tools_shape'));
    // Failures carry explicit reason strings, never silent skips.
    for (const check of report.checks.filter((c) => !c.ok)) {
      assert.ok(check.detail && typeof check.detail.error === 'string',
        `${check.name} must carry an explicit error`);
    }
    // A non-loopback target is rejected outright (offline-only boundary).
    await assert.rejects(
      () => runSmoke({ baseUrl: 'https://example.com' }),
      /offline-only|non-loopback/,
    );
  } finally {
    await server.close();
  }
});
