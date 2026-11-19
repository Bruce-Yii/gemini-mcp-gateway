#!/usr/bin/env node
/**
 * One-time: seed Notion/Linear OAuth token pairs into Upstash KV so the gateway
 * can auto-refresh them. Reads tokens from ~/.gemini-gateway-tokens/ (created by
 * the OAuth helper), never prints them. Requires KV env vars (or UPSTASH_*).
 *
 * Run locally after authorising, OR on Vercel as a one-off with env vars set.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TokenStore } from '../src/store.js';
import { UpstreamAuth } from '../src/upstream-auth.js';

if (!TokenStore.isConfigured()) {
  console.error('KV not configured: set KV_REST_API_URL/TOKEN (or UPSTASH_REDIS_REST_*)');
  process.exit(1);
}
const dir = path.join(os.homedir(), '.gemini-gateway-tokens');
const auth = new UpstreamAuth();
for (const server of ['notion', 'linear']) {
  const f = path.join(dir, `${server}.json`);
  if (!fs.existsSync(f)) { console.error(`${server}: token file missing (${f})`); continue; }
  const t = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (!t.access_token || !t.refresh_token || !t.client_id) {
    console.error(`${server}: token file incomplete`); continue;
  }
  await auth.seed(server, {
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    clientId: t.client_id,
    expiresIn: Number(t.expires_in ?? 0),
  });
  console.log(`${server}: seeded (expires_in=${t.expires_in ?? 'n/a'}s)`);
}
console.log('done. Tokens stored in KV under gmcgw:v1:upstream:*');
