#!/usr/bin/env node
/**
 * Validate a gateway config and print a summary.
 *
 * Usage:
 *   node scripts/check-config.mjs [config-path]
 *   GATEWAY_CONFIG=my.json node scripts/check-config.mjs
 *   UPSTREAMS_JSON='[{...}]' node scripts/check-config.mjs
 *
 * Exit code 0 = valid (warnings allowed), 1 = invalid, 2 = file/JSON error.
 * No network calls, no credentials needed.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateConfig } from '../src/config.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function snapshotCounts(server) {
  const snapshotPath = resolve(root, 'data', 'tool-snapshots', `${server.name}.json`);
  let snapshot;
  try {
    snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
  } catch {
    return null;
  }
  const tools = Array.isArray(snapshot.tools) ? snapshot.tools.map((tool) => tool.name).filter(Boolean) : [];
  const matches = (pattern, tool) => {
    const value = String(pattern);
    if (value.includes('/')) {
      const [service, name] = value.split('/', 2);
      if (service !== server.name && service !== '*') return false;
      return name === '*' || name === tool;
    }
    return value === tool;
  };
  const denied = tools.filter((tool) => (server.denyTools ?? []).some((pattern) => matches(pattern, tool)));
  const exposed = tools.filter((tool) => {
    if ((server.denyTools ?? []).some((pattern) => matches(pattern, tool))) return false;
    if (!Array.isArray(server.allowTools) || server.allowTools.length === 0) return true;
    return server.allowTools.some((pattern) => matches(pattern, tool));
  });
  return { total: tools.length, exposed: exposed.length, denied: denied.length };
}

const args = process.argv.slice(2);
const positional = args.find((arg) => !arg.startsWith('-'));
const configPath = resolve(positional ?? process.env.GATEWAY_CONFIG ?? 'config.example.json');

let value;
try {
  if (process.env.UPSTREAMS_JSON) {
    value = JSON.parse(process.env.UPSTREAMS_JSON);
  } else {
    value = JSON.parse(readFileSync(configPath, 'utf8'));
  }
} catch (error) {
  console.error(`[check-config] cannot read config ${configPath}: ${error.message}`);
  process.exit(2);
}

// Also accept a single `servers[]` entry (the format in templates/upstreams/).
if (value && typeof value === 'object' && !Array.isArray(value) && value.servers === undefined && value.name) {
  value = { servers: [value] };
}

try {
  const { config, warnings } = validateConfig(value);
  console.log(`config: ${process.env.UPSTREAMS_JSON ? '<UPSTREAMS_JSON env>' : configPath}`);
  console.log(`mode:   ${config.mode ?? 'whitelist'}`);
  console.log(`servers: ${config.servers.length}`);
  for (const server of config.servers) {
    const auth = server.refreshEnv ? 'oauth-refresh' : server.tokenEnv ? 'bearer-env' : 'static';
    const filters = `allow=${server.allowTools?.length ?? 0} deny=${server.denyTools?.length ?? 0}`;
    const target = server.transport === 'http' ? server.url : `${server.command} ${server.args?.join(' ') ?? ''}`.trim();
    const counts = snapshotCounts(server);
    const tools = counts
      ? `; tools total=${counts.total} exposed=${counts.exposed} denied=${counts.denied}`
      : '; tools total=? exposed=? denied=? (snapshot missing in data/tool-snapshots/)';
    console.log(`  - ${server.name} [${server.transport}/${auth}] ${target} (${filters}${tools})`);
  }
  if (warnings.length > 0) {
    console.log('warnings:');
    for (const warning of warnings) console.log(`  ! ${warning}`);
  }
  console.log('config OK');
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
