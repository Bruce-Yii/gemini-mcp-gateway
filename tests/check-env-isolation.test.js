/**
 * Preview/production env isolation analyzer — zero network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  analyzeEnvIsolation, resolveProjectId, resolveToken, fetchProjectEnv, main, ISOLATION_KEYS,
} from '../scripts/check-env-isolation.mjs';

test('a single record targeting production+preview is a P0 shared-credential violation', () => {
  const report = analyzeEnvIsolation([
    { id: 'env_1', key: 'UPSTASH_REDIS_REST_URL', type: 'plain', target: ['production', 'preview'], value: 'https://kv.example' },
  ]);
  assert.equal(report.ok, false);
  assert.equal(report.violations.length, 1);
  assert.equal(report.violations[0].kind, 'shared-record');
  assert.equal(report.violations[0].severity, 'P0');
});

test('separate records with identical plaintext values are also violations', () => {
  const report = analyzeEnvIsolation([
    { id: 'a', key: 'UPSTASH_REDIS_REST_URL', type: 'plain', target: ['production'], value: 'https://same.example' },
    { id: 'b', key: 'UPSTASH_REDIS_REST_URL', type: 'plain', target: ['preview'], value: 'https://same.example' },
  ]);
  assert.equal(report.ok, false);
  assert.equal(report.violations[0].kind, 'same-value');
});

test('separate records with different values are isolated (note only)', () => {
  const report = analyzeEnvIsolation([
    { id: 'a', key: 'UPSTASH_REDIS_REST_URL', type: 'plain', target: ['production'], value: 'https://prod.example' },
    { id: 'b', key: 'UPSTASH_REDIS_REST_URL', type: 'plain', target: ['preview'], value: 'https://preview.example' },
  ]);
  assert.equal(report.ok, true);
  assert.ok(report.warnings.some((w) => w.kind === 'distinct-value'));
});

test('sensitive separate records cannot be compared → unknown note, not a pass claim', () => {
  const report = analyzeEnvIsolation([
    { id: 'a', key: 'UPSTASH_REDIS_REST_TOKEN', type: 'sensitive', target: ['production'] },
    { id: 'b', key: 'UPSTASH_REDIS_REST_TOKEN', type: 'sensitive', target: ['preview'] },
  ]);
  assert.equal(report.ok, true);
  assert.ok(report.warnings.some((w) => w.kind === 'unknown'));
});

test('non-isolation keys are ignored; PUBLIC_BASE_URL is checked', () => {
  const report = analyzeEnvIsolation([
    { id: 'x', key: 'GITHUB_TOKEN', type: 'sensitive', target: ['production', 'preview'] },
    { id: 'y', key: 'PUBLIC_BASE_URL', type: 'plain', target: ['production', 'preview'], value: 'https://gw.example' },
  ]);
  assert.equal(report.checkedKeys.length, 1);
  assert.equal(report.checkedKeys[0], 'PUBLIC_BASE_URL');
  assert.equal(report.violations.length, 1);
  assert.equal(report.violations[0].key, 'PUBLIC_BASE_URL');
});

test('ISOLATION_KEYS contains the documented KV variables', () => {
  for (const key of ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'KV_URL', 'REDIS_URL', 'PUBLIC_BASE_URL']) {
    assert.ok(ISOLATION_KEYS.includes(key), `${key} must be checked`);
  }
});

test('resolveToken prefers explicit → env; resolveProjectId prefers explicit', async () => {
  assert.equal(await resolveToken({ token: 'explicit', env: { VERCEL_TOKEN: 'env' } }), 'explicit');
  assert.equal(await resolveToken({ env: { VERCEL_TOKEN: 'env' } }), 'env');
  // Never read the operator's real CLI credentials from a unit test.
  assert.equal(await resolveToken({ env: {}, candidates: [] }), null);
  assert.equal(resolveProjectId('prj_explicit'), 'prj_explicit');
});

test('fetchProjectEnv and main: violation → exit 1; isolated → exit 0; API error → 2', async () => {
  const envs = [
    { id: 'a', key: 'UPSTASH_REDIS_REST_URL', type: 'plain', target: ['production', 'preview'], value: 'https://kv.example' },
  ];
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ envs }) });
  assert.deepEqual(await fetchProjectEnv({ projectId: 'p', token: 't', fetchImpl }), envs);

  const logs = [];
  const code = await main(['--project', 'p', '--token', 't', '--json'], { stdout: (s) => logs.push(s), stderr: () => {}, fetchImpl });
  assert.equal(code, 1);
  assert.equal(JSON.parse(logs[0]).ok, false);

  const isolated = async () => ({
    ok: true, status: 200,
    json: async () => ({ envs: [
      { id: 'a', key: 'UPSTASH_REDIS_REST_URL', type: 'plain', target: ['production'], value: 'https://prod.example' },
      { id: 'b', key: 'UPSTASH_REDIS_REST_URL', type: 'plain', target: ['preview'], value: 'https://pre.example' },
    ] }),
  });
  assert.equal(await main(['--project', 'p', '--token', 't'], { stdout: () => {}, stderr: () => {}, fetchImpl: isolated }), 0);

  const failing = async () => ({ ok: false, status: 403, text: async () => 'forbidden' });
  assert.equal(await main(['--project', 'p', '--token', 't'], { stdout: () => {}, stderr: () => {}, fetchImpl: failing }), 2);
});
