#!/usr/bin/env node
/**
 * Seed OAuth token pairs into Upstash KV so the gateway can auto-refresh them.
 *
 * Every server in the config that has a `refreshEnv` (i.e. opts into OAuth
 * refresh) is seeded from `<tokens-dir>/<server>.json`. Built-in Notion/Linear
 * token endpoints are used automatically; other providers need a `refreshUrl`
 * in their config entry.
 *
 * Token files are created by your own upstream OAuth flow and must contain
 * access_token, refresh_token, client_id and (ideally) expires_in/obtained_at.
 * Nothing is printed except counts/status, and tokens never leave the process.
 *
 * Usage:
 *   KV_REST_API_URL=... KV_REST_API_TOKEN=... node scripts/seed-upstream-tokens.mjs
 *   GATEWAY_CONFIG=my.json GEMINI_GATEWAY_TOKENS_DIR=~/tokens node scripts/seed-upstream-tokens.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { TokenStore } from '../src/store.js';
import { UpstreamAuth } from '../src/upstream-auth.js';
import { validateConfig } from '../src/config.js';

if (!TokenStore.isConfigured()) {
  console.error('KV not configured: set KV_REST_API_URL/TOKEN (or UPSTASH_REDIS_REST_*)');
  process.exit(1);
}

const configPath = process.env.GATEWAY_CONFIG || 'config.example.json';
let config;
try {
  config = validateConfig(JSON.parse(fs.readFileSync(configPath, 'utf8'))).config;
} catch (error) {
  console.error(`[seed] cannot load ${configPath}: ${error.message}`);
  process.exit(1);
}

const dir = process.env.GEMINI_GATEWAY_TOKENS_DIR || path.join(os.homedir(), '.gemini-gateway-tokens');
const auth = new UpstreamAuth();
const targets = config.servers.filter((server) => server.refreshEnv);
if (targets.length === 0) {
  console.error(`[seed] no OAuth-refresh upstreams in ${configPath} (none has refreshEnv)`);
  process.exit(1);
}

let seeded = 0;
for (const server of targets) {
  const file = path.join(dir, `${server.name}.json`);
  if (!fs.existsSync(file)) {
    console.error(`${server.name}: token file missing (${file})`);
    continue;
  }
  let token;
  try {
    token = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    console.error(`${server.name}: token file is not valid JSON (${error.message})`);
    continue;
  }
  if (!token.access_token || !token.refresh_token || !token.client_id) {
    console.error(`${server.name}: token file needs access_token, refresh_token and client_id`);
    continue;
  }
  await auth.seed(server.name, {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    clientId: token.client_id,
    clientSecret: token.client_secret,
    expiresIn: Number(token.expires_in ?? 0),
    // Use the real authorization timestamp so expires_at reflects issuance time,
    // not seed time (seeding an already-expired token must not look fresh).
    obtainedAt: token.obtained_at ? Date.parse(token.obtained_at) : undefined,
  });
  console.log(`${server.name}: seeded (expires_in=${token.expires_in ?? 'n/a'}s)`);
  seeded += 1;
}
console.log(`done: ${seeded}/${targets.length} seeded into KV under gmcgw:v1:upstream:*`);
