/**
 * Offline end-to-end verification of the real HTTP route chain.
 *
 * This test drives scripts/local-e2e-verify.mjs, which mounts the REAL
 * `createAppHandler` / `createMcpRequestHandler` from the latest local src/ on
 * an ephemeral 127.0.0.1 port and drives real HTTP + MCP client requests. Only
 * the token store and upstream manager are faked — no network, no credentials,
 * no disk writes, no production code touched.
 *
 * It answers the question unit tests cannot: "do the committed fixes take
 * effect end-to-end on the actual gateway routes?" See
 * docs/eval/LOCAL-E2E-VERIFY.md for coverage and deployment differences.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { runLocalE2E } from '../scripts/local-e2e-verify.mjs';

const EXPECTED_CHECKS = [
  'healthz-200',
  'oauth-metadata',
  'cimd-document',
  'mcp-401-challenge',
  'mcp-three-tools',
  'file-content-pure-body',
  'pr-number-url-first',
  'wait-for-pr-checks-helper',
  'run-typed-plan-helper',
  'v2-flag-off-404',
  'v2-flag-on-three-tools',
];

test('local E2E: all real-route checks pass and report {ok, checks[]}', async () => {
  // Mute the handlers' [req]/[capture_*] console.log noise for this test; the
  // harness itself still returns structured results.
  const originalLog = console.log;
  let result;
  try {
    console.log = () => {};
    result = await runLocalE2E();
  } finally {
    console.log = originalLog;
  }
  assert.equal(typeof result.ok, 'boolean');
  assert.ok(Array.isArray(result.checks), 'checks must be an array');
  assert.equal(result.ok, true, `checks failed: ${result.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.error}`).join('; ')}`);
  assert.deepEqual(result.checks.map((c) => c.name), EXPECTED_CHECKS);
  for (const item of result.checks) {
    assert.equal(item.ok, true, `${item.name} failed: ${item.error ?? ''}`);
    assert.equal(typeof item.name, 'string');
    if (item.ok) assert.ok(typeof item.detail === 'string' && item.detail.length > 0, `${item.name} has no detail`);
  }
});

test('local E2E: an injected failure is surfaced, never swallowed', async () => {
  const originalLog = console.log;
  let result;
  try {
    console.log = () => {};
    result = await runLocalE2E({ failCheck: 'mcp-three-tools' });
  } finally {
    console.log = originalLog;
  }
  assert.equal(result.ok, false, 'harness must report failure');
  const failed = result.checks.filter((c) => !c.ok);
  assert.deepEqual(failed.map((c) => c.name), ['mcp-three-tools']);
  assert.match(failed[0].error, /injected harness failure/);
  // The rest of the checks must still have run (failures are isolated).
  assert.equal(result.checks.length, EXPECTED_CHECKS.length);
});
