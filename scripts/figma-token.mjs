#!/usr/bin/env node
/**
 * Local Figma credential vault bridge (no secrets in the repo).
 *
 * One-time setup: run the OAuth helper once so it writes
 *   <vault>/figma-oauth.json
 * with client_id/client_secret/refresh_token/access_token/expires_at.
 *
 * After that this script can refresh the access token non-interactively, so a
 * new terminal/window does NOT need another Figma authorization.
 *
 * Usage:
 *   node scripts/figma-token.mjs status
 *   node scripts/figma-token.mjs refresh
 *   node scripts/figma-token.mjs run -- node src/server.js --config ... --port ...
 *
 * Vault location: GATEWAY_SECRET_DIR (required in CI), else the per-user
 * default at `~/.config/codemode-mcp-gateway/`. No machine-specific path is
 * baked into this script.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const TOKEN_URL = 'https://api.figma.com/v1/oauth/token';
const REFRESH_SKEW_MS = 5 * 60 * 1000;

export function vaultDir() {
  if (process.env.GATEWAY_SECRET_DIR) return resolve(process.env.GATEWAY_SECRET_DIR);
  // Portable per-user default. Use GATEWAY_SECRET_DIR to point at a
  // machine-specific private store; no absolute personal path is hard-coded.
  const home = process.env.HOME || process.env.USERPROFILE || '';
  return resolve(home, '.config', 'codemode-mcp-gateway');
}

export function vaultFile(name) {
  return join(vaultDir(), name);
}

function readJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* Windows: best effort */ }
}

export function status() {
  const file = vaultFile('figma-oauth.json');
  const record = readJson(file);
  if (!record) {
    return { configured: false, file, reason: 'missing figma-oauth.json' };
  }
  const expiresAt = Number(record.expires_at ?? 0);
  return {
    configured: true,
    file,
    hasRefresh: Boolean(record.refresh_token),
    expired: expiresAt > 0 ? Date.now() >= expiresAt - REFRESH_SKEW_MS : true,
    expiresAt: expiresAt || null,
  };
}

async function refresh(record) {
  if (!record.refresh_token || !record.client_id || !record.client_secret) {
    throw new Error('vault is missing refresh_token/client_id/client_secret; run the one-time OAuth helper');
  }
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: record.refresh_token,
    client_id: record.client_id,
    client_secret: record.client_secret,
  });
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Figma refresh failed (HTTP ${response.status}); re-run the one-time OAuth helper`);
  }
  const token = JSON.parse(text);
  if (!token.access_token) throw new Error('Figma refresh returned no access_token');
  const expiresIn = Number(token.expires_in ?? 0);
  const next = {
    ...record,
    access_token: token.access_token,
    refresh_token: token.refresh_token ?? record.refresh_token,
    expires_at: expiresIn > 0 ? Date.now() + expiresIn * 1000 : 0,
    obtained_at: Date.now(),
  };
  writeJson(vaultFile('figma-oauth.json'), next);
  return next;
}

/** Return a currently valid access token, refreshing from the vault if needed. */
export async function getAccessToken({ force = false } = {}) {
  const file = vaultFile('figma-oauth.json');
  if (!existsSync(file)) {
    throw new Error(`Figma credentials not found in vault (${file}); one-time OAuth helper required`);
  }
  let record = readJson(file);
  if (!record) throw new Error(`cannot parse ${file}`);
  const expiresAt = Number(record.expires_at ?? 0);
  const needsRefresh = force || !record.access_token || (expiresAt > 0 && Date.now() >= expiresAt - REFRESH_SKEW_MS);
  if (needsRefresh) record = await refresh(record);
  if (!record.access_token) throw new Error('vault has no usable Figma access token');
  return record.access_token;
}

function envFor(record) {
  return {
    FIGMA_ACCESS_TOKEN: record.access_token,
    FIGMA_REFRESH_TOKEN: record.refresh_token ?? '',
    FIGMA_CLIENT_ID: record.client_id ?? '',
    FIGMA_CLIENT_SECRET: record.client_secret ?? '',
    FIGMA_EXPIRES_IN: record.expires_in ? String(record.expires_in) : '',
    FIGMA_OBTAINED_AT: record.obtained_at ? String(record.obtained_at) : String(Date.now()),
  };
}

async function runCommand(command) {
  const record = readJson(vaultFile('figma-oauth.json'));
  if (!record) throw new Error('Figma credentials not found in vault; one-time OAuth helper required');
  let current = record;
  const expiresAt = Number(current.expires_at ?? 0);
  if (!current.access_token || (expiresAt > 0 && Date.now() >= expiresAt - REFRESH_SKEW_MS)) {
    current = await refresh(current);
  }
  const env = { ...process.env, ...envFor(current) };
  const child = spawn(command[0], command.slice(1), { stdio: 'inherit', env, shell: process.platform === 'win32' });
  child.on('exit', (code) => process.exit(code ?? 1));
}

async function main() {
  const [action, ...rest] = process.argv.slice(2);
  if (action === 'status') {
    const state = status();
    if (!state.configured) {
      console.log(`[figma-token] not configured (${state.file}): ${state.reason}`);
      process.exitCode = 2;
      return;
    }
    console.log(`[figma-token] configured, refresh=${state.hasRefresh ? 'yes' : 'no'}, ` +
      (state.expiresAt ? `expires=${new Date(state.expiresAt).toISOString()}` : 'expiry=unknown'));
    return;
  }
  if (action === 'refresh') {
    const token = await getAccessToken({ force: true });
    console.log(`[figma-token] refreshed (access token length ${token.length})`);
    return;
  }
  if (action === 'run') {
    const sep = rest.indexOf('--');
    const command = sep >= 0 ? rest.slice(sep + 1) : rest;
    if (command.length === 0) throw new Error('usage: node scripts/figma-token.mjs run -- <command>');
    await runCommand(command);
    return;
  }
  console.log('usage: node scripts/figma-token.mjs <status|refresh|run -- command...>');
  process.exitCode = 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(`[figma-token] ${error.message}`);
    process.exit(1);
  });
}
