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
  assert.equal(linear.tokenEnv, 'LINEAR_API_KEY');
  assert.equal(linear.url, 'https://mcp.linear.app/mcp/readonly');
  assert.equal(linear.refreshUrl, undefined);
  assert.equal(linear.refreshEnv, undefined);
  assert.equal(linear.clientIdEnv, undefined);
  assert.equal(linear.grantOwner, undefined);
});

test('notion uses gateway-owned OAuth/DCR (MCP token only exists on Business/Enterprise)', () => {
  const notion = server('notion');
  assert.equal(notion.authMode, undefined);
  assert.equal(notion.grantOwner, 'gateway');
  assert.equal(notion.dcr, true);
  assert.equal(notion.tokenEnv, undefined);
  assert.equal(notion.refreshEnv, undefined);
  assert.equal(notion.refreshUrl, 'https://mcp.notion.com/token');
});

test('static_bearer config validates with the linear PAT env set', () => {
  const { warnings } = validateConfig(config, {
    env: { LINEAR_API_KEY: 'lin_pat_dummy' },
  });
  assert.equal(
    warnings.some((warning) => /LINEAR_PAT_STATIC|NOTION_MCP_TOKEN/.test(warning)),
    false,
    `unexpected linear/notion token warning: ${warnings.join(' | ')}`,
  );
});
