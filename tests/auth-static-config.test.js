/**
 * Production/OSS config must use gateway-owned STATIC credentials for Linear
 * and Notion. This is the fix for the DSH shared rotating-grant failures:
 * `authMode: "static_bearer"` never enters the OAuth refresh path.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateConfig, STATIC_BEARER } from '../src/config.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(readFileSync(path.join(root, 'config.example.json'), 'utf8'));
const server = (name) => config.servers.find((entry) => entry.name === name);

test('linear uses an owner-created PAT via static_bearer', () => {
  const linear = server('linear');
  assert.equal(linear.authMode, STATIC_BEARER);
  assert.equal(linear.tokenEnv, 'LINEAR_PAT_STATIC');
  assert.equal(linear.refreshUrl, undefined);
  assert.equal(linear.refreshEnv, undefined);
  assert.equal(linear.clientIdEnv, undefined);
  assert.equal(linear.grantOwner, undefined);
});

test('notion uses an owner-created MCP token via static_bearer', () => {
  const notion = server('notion');
  assert.equal(notion.authMode, STATIC_BEARER);
  assert.equal(notion.tokenEnv, 'NOTION_MCP_TOKEN');
  assert.equal(notion.dcr, undefined);
  assert.equal(notion.refreshUrl, undefined);
  assert.equal(notion.refreshEnv, undefined);
  assert.equal(notion.grantOwner, undefined);
});

test('static_bearer config validates with the two token env vars set', () => {
  const { warnings } = validateConfig(config, {
    env: { LINEAR_PAT_STATIC: 'lin_pat_dummy', NOTION_MCP_TOKEN: 'notion_mcp_dummy' },
  });
  assert.equal(
    warnings.some((warning) => /LINEAR_PAT_STATIC|NOTION_MCP_TOKEN/.test(warning)),
    false,
    `unexpected linear/notion token warning: ${warnings.join(' | ')}`,
  );
});
