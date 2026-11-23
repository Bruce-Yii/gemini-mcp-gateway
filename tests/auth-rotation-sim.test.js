/**
 * Batch 15 · isolated OAuth rotation simulation tests.
 *
 * Fully offline: every I/O boundary is a fake in scripts/auth-rotation-sim.mjs
 * (FakeClock / StepQueue / FakeKV / FakeOAuthProvider). No network, no
 * credentials, no real tokens, no src/ imports and no file writes. Tests assert
 * the *model's* behaviour so the future auth architecture can be validated
 * before any production code changes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STRATEGIES,
  FakeClock,
  StepQueue,
  FakeKV,
  FakeOAuthProvider,
  Instance,
  FakeClock as Clock,
  tokenKey,
  lockKey,
  mask,
  runScenario,
  runMatrix,
} from '../scripts/auth-rotation-sim.mjs';

// ─── 0. Harness sanity ──────────────────────────────────────────────────────

test('harness exposes the four strategies and never prints a full token', () => {
  assert.deepEqual(STRATEGIES, ['none', 'current', 'owner-fenced', 'owner-fenced-readback']);
  assert.ok(mask('ACCESS_supersecretvalue').includes('…'));
  assert.equal(mask('ACCESS_supersecretvalue').includes('supersecretvalue'), false);
  assert.equal(mask(''), '****');
  assert.equal(FakeClock, Clock, 'FakeClock export is stable');
});

test('fake KV: NX, TTL expiry, owner-aware release, and RT CAS', async () => {
  const clock = new FakeClock();
  const q = new StepQueue(clock);
  const kv = new FakeKV(clock, q);
  // Every KV op yields to the queue; start it, drain, then await the result.
  const step = (p) => q.drain().then(() => p);
  assert.equal(await step(kv.set('k', 'v1', 'NX', 'EX', '1')), 'OK');
  assert.equal(await step(kv.set('k', 'v2', 'NX', 'EX', '1')), null, 'NX refuses overwrite');
  await step(kv.set('k2', JSON.stringify({ owner: 'right-owner', expiresAt: clock.now() + 1000 })));
  assert.equal(await step(kv.releaseLease('k2', 'wrong-owner')), false);
  assert.equal(await step(kv.releaseLease('k2', 'right-owner')), true);
  await step(kv.set('k', JSON.stringify({ refresh_token: 'RT_1' })));
  assert.equal(await step(kv.casToken('k', 'RT_1', JSON.stringify({ refresh_token: 'RT_2' }))), true);
  assert.equal(await step(kv.casToken('k', 'RT_1', JSON.stringify({ refresh_token: 'RT_3' }))), false);
  assert.equal(kv.parse('k').refresh_token, 'RT_2', 'losing CAS must not overwrite');
  // TTL: a lock written with a 1s TTL expires once the fake clock advances.
  await step(kv.set('lock', JSON.stringify({ owner: 'a', expiresAt: clock.now() + 1000 })));
  clock.advance(1001);
  assert.equal(await step(kv.get('lock')), null, 'expired lease reads as absent');
  assert.ok(q.steps > 0, 'all KV ops went through the deterministic queue');
});

test('fake OAuth provider: a refresh token is single-use; reuse is invalid_grant + family revoked', async () => {
  const clock = new FakeClock();
  const q = new StepQueue(clock);
  const provider = new FakeOAuthProvider(q, { latencySteps: 2 });
  const firstPromise = provider.refresh('RT_seed');
  await q.drain();
  const first = await firstPromise;
  assert.equal(first.ok, true);
  assert.notEqual(first.refresh_token, 'RT_seed', 'token rotates');
  const secondPromise = provider.refresh('RT_seed');
  await q.drain();
  const second = await secondPromise;
  assert.equal(second.ok, false);
  assert.equal(second.error, 'invalid_grant');
  assert.equal(provider.familyRevoked, true, 'reuse detection revokes the family');
  assert.equal(provider.invalidGrants, 1);
});

test('namespacing and grant ownership mirror the intended architecture', () => {
  assert.equal(tokenKey('notion'), 'gmcgw:v1:upstream:notion');
  assert.equal(tokenKey('notion', { environment: 'production' }), 'gmcgw:v1:upstream:notion');
  assert.equal(tokenKey('notion', { environment: 'preview' }), 'gmcgw:v1:upstream:notion:preview');
  assert.equal(tokenKey('notion', { owner: 'dsh' }), 'gmcgw:v1:upstream:notion:owner-dsh');
  assert.equal(lockKey('notion', { environment: 'preview' }), 'gmcgw:v1:upstream:notion:preview:lock');
});

// ─── 1. No lock fails / double-refreshes ────────────────────────────────────

test('no-lock: two and three instances double-spend the rotating grant and end unusable', async () => {
  for (const scenario of ['concurrent-2', 'concurrent-3', 'cold-start']) {
    const r = await runScenario('none', scenario);
    assert.ok(r.refreshCount >= 2, `${scenario}: every instance spends the RT`);
    assert.ok(r.invalidGrantCount >= 1, `${scenario}: reuse returns invalid_grant`);
    assert.equal(r.finalTokenUsable, false, `${scenario}: reuse revoked the family`);
  }
});

// ─── 2. Current no-owner lock reproduces mis-delete / double refresh ────────

test('current (no-owner lock): lease expiry causes mis-delete AND double refresh', async () => {
  const r = await runScenario('current', 'lock-expiry');
  assert.equal(r.staleDeleteCount, 1, 'unconditional DEL removes another worker\'s lock');
  assert.equal(r.refreshCount, 2, 'grant is spent twice after the lease expired');
  assert.equal(r.invalidGrantCount, 1, 'second spend returns invalid_grant');
  assert.equal(r.finalTokenUsable, false);
  const stale = r.traces.find((t) => t.staleReleases === 1);
  assert.ok(stale, 'a trace must record the stale release');
  assert.equal(stale.release, 'unconditional-del');
});

// ─── 3. Owner-fenced succeeds ──────────────────────────────────────────────

test('owner-fenced: exactly one refresh for concurrent 2/3, cold start, and no mis-delete', async () => {
  for (const scenario of ['concurrent-2', 'concurrent-3', 'cold-start']) {
    const r = await runScenario('owner-fenced', scenario);
    assert.equal(r.refreshCount, 1, `${scenario}: single spend`);
    assert.equal(r.invalidGrantCount, 0);
    assert.equal(r.finalTokenUsable, true, `${scenario}: final token usable`);
    assert.equal(r.staleDeleteCount, 0, `${scenario}: no owner-less DEL`);
  }
});

test('owner-fenced: a losing contender adopts the winner token without spending its RT', async () => {
  const r = await runScenario('owner-fenced', 'concurrent-2');
  const loser = r.traces.find((t) => t.id === 2);
  assert.equal(loser.refreshCalls, 0, 'loser never called the provider');
  assert.equal(loser.adoptedWinner, true, 'loser read back the winner record');
  assert.equal(loser.release, 'not-held', 'loser must not release a lock it never owned');
  assert.equal(loser.result, mask('ACCESS_1'), 'loser result is masked in the report');
});

test('owner-fenced without keepalive still double-spends when the lease truly expires', async () => {
  // Documents WHY the fourth strategy exists: owner fencing alone prevents
  // mis-delete, but a genuinely expired lease needs renewal + in-lease re-read.
  const r = await runScenario('owner-fenced', 'lock-expiry');
  assert.equal(r.staleDeleteCount, 0, 'no mis-delete (owner-aware release)');
  assert.equal(r.invalidGrantCount, 1, 'but the expired lease allowed a second spend');
});

test('owner-fenced + in-lease re-read + keepalive survives lease expiry', async () => {
  const r = await runScenario('owner-fenced-readback', 'lock-expiry');
  assert.equal(r.refreshCount, 1);
  assert.equal(r.invalidGrantCount, 0);
  assert.equal(r.finalTokenUsable, true);
  assert.equal(r.staleDeleteCount, 0);
});

// ─── 4. Shared DSH grant is read-only ───────────────────────────────────────

test('shared grant: DSH-owned grant is used read-only, never refreshed', async () => {
  for (const s of STRATEGIES) {
    const r = await runScenario(s, 'shared-grant');
    assert.equal(r.refusedShared, true, `${s}: refusal recorded`);
    assert.equal(r.refreshCount, 0, `${s}: zero provider calls`);
    assert.equal(r.invalidGrantCount, 0);
    assert.equal(r.finalTokenUsable, true, `${s}: existing access token still usable`);
    assert.equal(r.final.access_token.startsWith('ACC'), true);
  }
});

// ─── 5. Cross-environment isolation ────────────────────────────────────────

test('cross-env: production and preview use separate keys and separate grants', async () => {
  const r = await runScenario('owner-fenced', 'cross-env');
  assert.equal(r.refreshCount, 2, 'each namespace refreshes its own grant');
  assert.equal(r.invalidGrantCount, 0, 'no cross-namespace token reuse');
  assert.equal(r.finalTokenUsable, true);
  assert.equal(r.crossEnv.production.refresh_token !== r.crossEnv.preview.refresh_token, true);
  assert.equal(r.crossEnv.production.access_token !== r.crossEnv.preview.access_token, true);
  for (const s of STRATEGIES) {
    const x = await runScenario(s, 'cross-env');
    assert.equal(x.invalidGrantCount, 0, `${s}: no invalid_grant across namespaces`);
  }
});

// ─── 6. CAS failure must not overwrite the winner ──────────────────────────

test('CAS failure: stale loser adopts winner and KV keeps the winner refresh token', async () => {
  const r = await runScenario('owner-fenced', 'cas-failure');
  assert.equal(r.invalidGrantCount, 0, 'distinct stale RT: both provider calls succeed');
  const [winner, loser] = r.traces;
  assert.equal(winner.committed, true);
  assert.equal(loser.committed, false, 'loser CAS failed');
  assert.equal(loser.adoptedWinner, true, 'loser adopted winner via read-back');
  assert.equal(loser.result, winner.result, 'loser returned the winner access token');
  // The winner's RT is REFRESH_1. A loser overwrite would leave REFRESH_2.
  assert.equal(r.final.refresh_token, 'REF…_1', 'KV still holds the winner grant');
  assert.equal(r.finalTokenUsable, true);
});

test('CAS failure: without fencing the stale worker overwrites the winner', async () => {
  const r = await runScenario('none', 'cas-failure');
  assert.equal(r.traces[1].committed, true, 'no CAS -> loser writes unconditionally');
  assert.equal(r.final.refresh_token, 'REF…_2', 'winner was clobbered by the stale worker');
});

// ─── 7. Determinism / safety ───────────────────────────────────────────────

test('full matrix is deterministic across repeated runs', async () => {
  const a = JSON.stringify(await runMatrix());
  const b = JSON.stringify(await runMatrix());
  assert.equal(a, b, 'same inputs must produce byte-identical reports');
  assert.ok(a.length > 1000, 'matrix contains a full report');
});

test('reports contain masked tokens only — no real or full fake token values', async () => {
  const raw = JSON.stringify(await runMatrix());
  for (const secret of ['ACCESS_seed', 'REFRESH_seed', 'ACCESS_supersecret', 'REFRESH_stale']) {
    assert.equal(raw.includes(secret), false, `${secret} must never appear in a report`);
  }
  assert.ok(raw.includes('…'), 'tokens are masked with an ellipsis');
});
