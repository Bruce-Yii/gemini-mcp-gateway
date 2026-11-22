import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ConfigError, normalizeConfigValue, validateConfig } from '../src/config.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (file) => JSON.parse(readFileSync(path.join(root, file), 'utf8'));
const base = () => ({
  mode: 'codemode',
  servers: [{ name: 'github', transport: 'http', url: 'https://example.com/mcp', tokenEnv: 'GITHUB_TOKEN' }],
});
const noEnv = { env: {} };

test('valid config passes; missing token env is only a warning', () => {
  const { warnings } = validateConfig(base(), noEnv);
  assert.deepEqual(warnings, ['servers[0]: GITHUB_TOKEN is not set in this environment; the upstream will be skipped']);
  const withEnv = validateConfig(base(), { env: { GITHUB_TOKEN: 'x' } });
  assert.deepEqual(withEnv.warnings, []);
});

test('servers-only arrays are accepted (legacy shape)', () => {
  const { config } = validateConfig([{ name: 'fake', transport: 'stdio', command: 'node', args: ['x.mjs'] }], noEnv);
  assert.equal(config.servers.length, 1);
  assert.equal(config.mode, undefined);
});

test('rejects duplicate names, bad transports and missing endpoints', () => {
  assert.throws(
    () => validateConfig({ servers: [
      { name: 'a', transport: 'http', url: 'https://a.example/mcp' },
      { name: 'a', transport: 'http', url: 'https://b.example/mcp' },
    ] }, noEnv),
    (error) => error instanceof ConfigError && /duplicate "a"/.test(error.message),
  );
  assert.throws(() => validateConfig({ servers: [{ name: 'a', transport: 'sse', url: 'https://a' }] }, noEnv), /transport must be/);
  assert.throws(() => validateConfig({ servers: [{ name: 'a', transport: 'http' }] }, noEnv), /url must be an absolute http/);
  assert.throws(() => validateConfig({ servers: [{ name: 'a', transport: 'stdio' }] }, noEnv), /command is required/);
  assert.throws(() => validateConfig({ servers: [] }, noEnv), /servers must be a non-empty array/);
});

test('rejects invalid top-level values', () => {
  assert.throws(() => validateConfig({ mode: 'mega', servers: [{ name: 'a', transport: 'http', url: 'https://a' }] }, noEnv), /mode must be/);
  assert.throws(() => validateConfig({ maxCalls: 0, servers: [{ name: 'a', transport: 'http', url: 'https://a' }] }, noEnv), /maxCalls/);
  assert.throws(() => validateConfig(42, noEnv), /must be an object/);
});

test('OAuth-refresh rules: refreshEnv needs tokenEnv; custom providers need refreshUrl', () => {
  assert.throws(
    () => validateConfig({ servers: [{ name: 'x', transport: 'http', url: 'https://x.example/mcp', refreshEnv: 'X_REFRESH' }] }, noEnv),
    /refreshEnv requires tokenEnv/,
  );
  assert.throws(
    () => validateConfig({ servers: [{
      name: 'x', transport: 'http', url: 'https://x.example/mcp',
      tokenEnv: 'X_TOKEN', refreshEnv: 'X_REFRESH', clientIdEnv: 'X_CLIENT',
    }] }, noEnv),
    /refreshEnv requires refreshUrl/,
  );
  const custom = validateConfig({ servers: [{
    name: 'x', transport: 'http', url: 'https://x.example/mcp',
    tokenEnv: 'X_TOKEN', refreshEnv: 'X_REFRESH', clientIdEnv: 'X_CLIENT',
    refreshUrl: 'https://auth.example/token',
  }] }, noEnv);
  assert.equal(custom.config.servers[0].refreshUrl, 'https://auth.example/token');

  // Built-in providers (Notion/Linear) do not need refreshUrl.
  const builtin = validateConfig({ servers: [{
    name: 'notion', transport: 'http', url: 'https://mcp.notion.com/mcp',
    tokenEnv: 'NOTION_TOKEN', refreshEnv: 'NOTION_REFRESH_TOKEN', clientIdEnv: 'NOTION_CLIENT_ID',
  }] }, noEnv);
  assert.equal(builtin.config.servers[0].name, 'notion');
});

test('rejects bad header/env/args/tool-list types and warns on unknown keys', () => {
  assert.throws(() => validateConfig({ servers: [{ name: 'a', transport: 'http', url: 'https://a', headers: { A: 1 } }] }, noEnv), /headers/);
  assert.throws(() => validateConfig({ servers: [{ name: 'a', transport: 'http', url: 'https://a', env: [] }] }, noEnv), /env must/);
  assert.throws(() => validateConfig({ servers: [{ name: 'a', transport: 'stdio', command: 'node', args: [1] }] }, noEnv), /args/);
  assert.throws(() => validateConfig({ servers: [{ name: 'a', transport: 'http', url: 'https://a', denyTools: 'x' }] }, noEnv), /denyTools/);

  const { warnings } = validateConfig({
    mystery: true,
    servers: [{ name: 'a', transport: 'http', url: 'https://a', typoField: 1 }],
  }, noEnv);
  assert.ok(warnings.some((warning) => warning.includes('mystery')));
  assert.ok(warnings.some((warning) => warning.includes('typoField')));
});

test('normalizeConfigValue accepts objects and server arrays only', () => {
  assert.deepEqual(normalizeConfigValue([{ name: 'a' }]).servers, [{ name: 'a' }]);
  assert.throws(() => normalizeConfigValue('nope'), ConfigError);
});

test('the shipped config and all examples validate', () => {
  validateConfig(readJson('config.example.json'), { env: { GITHUB_TOKEN: 'x', NOTION_TOKEN: 'x', LINEAR_TOKEN: 'x', VERCEL_TOKEN: 'x' } });
  const examples = readdirSync(path.join(root, 'examples')).filter((name) => name.endsWith('.json'));
  assert.ok(examples.length >= 3);
  for (const file of examples) validateConfig(readJson(path.join('examples', file)), noEnv);
});

test('all upstream templates are valid single-server entries', () => {
  const dir = path.join(root, 'templates', 'upstreams');
  const templates = readdirSync(dir).filter((name) => name.endsWith('.json'));
  assert.ok(templates.length >= 3);
  for (const file of templates) {
    const entry = readJson(path.join('templates', 'upstreams', file));
    const { config } = validateConfig({ mode: 'codemode', servers: [entry] }, noEnv);
    assert.equal(config.servers.length, 1, `${file} should contain one server entry`);
    assert.ok(entry.name, `${file} needs a name`);
  }
});
