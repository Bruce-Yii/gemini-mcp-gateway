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
import { resolve } from 'node:path';

import { validateConfig } from '../src/config.js';

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

try {
  const { config, warnings } = validateConfig(value);
  console.log(`config: ${process.env.UPSTREAMS_JSON ? '<UPSTREAMS_JSON env>' : configPath}`);
  console.log(`mode:   ${config.mode ?? 'whitelist'}`);
  console.log(`servers: ${config.servers.length}`);
  for (const server of config.servers) {
    const auth = server.refreshEnv ? 'oauth-refresh' : server.tokenEnv ? 'bearer-env' : 'static';
    const filters = `allow=${server.allowTools?.length ?? 0} deny=${server.denyTools?.length ?? 0}`;
    const target = server.transport === 'http' ? server.url : `${server.command} ${server.args?.join(' ') ?? ''}`.trim();
    console.log(`  - ${server.name} [${server.transport}/${auth}] ${target} (${filters})`);
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
