#!/usr/bin/env node
/**
 * Preview/production environment isolation check (READ-ONLY).
 *
 * The gateway keys every grant by environment, but if two environments share
 * the SAME Upstash credentials, isolation relies only on key prefixes — a
 * single config bug can then read or burn the other environment's grant.
 * AGENTS.md §2 requires "绝不让本地/预览读写 production key"; AUTH-READY
 * item 1.4-2 requires "不存在跨环境共用 KV".
 *
 * This script inspects the Vercel project env (never values beyond equality)
 * and reports:
 *   - shared-record : ONE env var whose target includes production AND preview
 *   - same-value    : separate records whose plaintext values are identical
 *   - unknown       : separate records, at least one sensitive → cannot compare
 *
 * It never prints a secret value; only key/target/type and equality booleans.
 *
 * Usage:
 *   node scripts/check-env-isolation.mjs                 # uses .vercel/project.json + CLI auth
 *   node scripts/check-env-isolation.mjs --json
 *   VERCEL_TOKEN=… node scripts/check-env-isolation.mjs --project prj_x
 */
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const API = 'https://api.vercel.com';

/** Variables whose cross-environment sharing breaks the isolation guarantee. */
export const ISOLATION_KEYS = Object.freeze([
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'KV_REST_API_URL',
  'KV_REST_API_TOKEN',
  'KV_REST_API_READ_ONLY_TOKEN',
  'KV_URL',
  'REDIS_URL',
  'PUBLIC_BASE_URL',
]);

const isKvKey = (key) => ISOLATION_KEYS.includes(key);

/**
 * Pure analyzer over `/v9/projects/:id/env` records.
 * @param {Array<{id?:string,key:string,value?:string,type?:string,target:string[]}>} envs
 */
export function analyzeEnvIsolation(envs, { keys = ISOLATION_KEYS } = {}) {
  const violations = [];
  const warnings = [];
  const byKey = new Map();
  for (const record of envs) {
    if (!record || typeof record.key !== 'string') continue;
    if (keys.length && !keys.includes(record.key)) continue;
    if (!byKey.has(record.key)) byKey.set(record.key, []);
    byKey.get(record.key).push({
      id: record.id ?? null,
      target: Array.isArray(record.target) ? record.target : [],
      type: record.type ?? 'plain',
      value: typeof record.value === 'string' ? record.value : undefined,
    });
  }

  for (const [key, records] of byKey) {
    for (const record of records) {
      const targets = new Set(record.target);
      if (targets.has('production') && targets.has('preview')) {
        violations.push({
          key, kind: 'shared-record',
          detail: 'one env record targets production AND preview → same credential in both environments',
          target: [...targets].sort(),
        });
        if (isKvKey(key)) {
          violations[violations.length - 1].severity = 'P0';
        }
      }
    }
    // Separate records: compare plaintext values when both are visible.
    const prod = records.filter((r) => r.target.includes('production'));
    const preview = records.filter((r) => r.target.includes('preview'));
    for (const a of prod) {
      for (const b of preview) {
        if (a.id && b.id && a.id === b.id) continue; // same record, already flagged
        if (a.value !== undefined && b.value !== undefined) {
          if (a.value === b.value) {
            violations.push({
              key, kind: 'same-value', detail: 'production and preview records hold the same value',
            });
          } else {
            warnings.push({ key, kind: 'distinct-value', detail: 'production and preview values differ (good)' });
          }
        } else {
          warnings.push({
            key, kind: 'unknown', detail: 'at least one record is sensitive; value equality cannot be verified from the API',
          });
        }
      }
    }
  }

  const severityRank = { P0: 0, P1: 1 };
  violations.sort((a, b) => (severityRank[a.severity] ?? 9) - (severityRank[b.severity] ?? 9));
  return { ok: violations.length === 0, violations, warnings, checkedKeys: [...byKey.keys()].sort() };
}

export function resolveProjectId(argValue) {
  if (argValue) return argValue;
  try {
    const parsed = JSON.parse(readFileSync(path.join(ROOT, '.vercel', 'project.json'), 'utf8'));
    if (parsed?.projectId) return parsed.projectId;
  } catch { /* not a linked checkout */ }
  return process.env.VERCEL_PROJECT_ID;
}

const AUTH_CANDIDATES = () => [
  process.env.APPDATA ? path.join(process.env.APPDATA, 'com.vercel.cli', 'Data', 'auth.json') : null,
  path.join(os.homedir(), '.local', 'share', 'com.vercel.cli', 'auth.json'),
  path.join(os.homedir(), 'Library', 'Application Support', 'com.vercel.cli', 'auth.json'),
  path.join(os.homedir(), '.vercel', 'auth.json'),
].filter(Boolean);

export async function resolveToken({ token, env = process.env, candidates = AUTH_CANDIDATES() } = {}) {
  if (token) return token;
  if (env.VERCEL_TOKEN) return env.VERCEL_TOKEN;
  for (const file of candidates) {
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8'));
      if (parsed?.token) return parsed.token;
      if (parsed?.['//']) return parsed['//'];
    } catch { /* next candidate */ }
  }
  return null;
}

export async function fetchProjectEnv({ projectId, token, fetchImpl = globalThis.fetch }) {
  const response = await fetchImpl(`${API}/v9/projects/${encodeURIComponent(projectId)}/env`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Vercel env API ${response.status}: ${String(text).slice(0, 200)}`);
  }
  const body = await response.json();
  return Array.isArray(body?.envs) ? body.envs : [];
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const args = parseArgv(argv);
  const { stdout = console.log, stderr = console.error, fetchImpl = globalThis.fetch, env = process.env } = deps;
  const projectId = resolveProjectId(args.project);
  if (!projectId) {
    stderr('[env-isolation] missing project id: pass --project or run inside a linked checkout');
    return 2;
  }
  const token = await resolveToken({ token: args.token, env });
  if (!token) {
    stderr('[env-isolation] missing Vercel token: pass --token or set VERCEL_TOKEN');
    return 2;
  }
  let envs;
  try {
    envs = await fetchProjectEnv({ projectId, token, fetchImpl });
  } catch (error) {
    stderr(`[env-isolation] ${error?.message ?? String(error)}`);
    return 2;
  }
  const report = analyzeEnvIsolation(envs);
  if (args.json) {
    stdout(JSON.stringify(report, null, 2));
  } else {
    stdout(`[env-isolation] checked ${report.checkedKeys.length} isolation keys: ${report.checkedKeys.join(', ') || '(none)'}`);
    for (const v of report.violations) stdout(`[env-isolation] VIOLATION ${v.severity ?? ''} ${v.key}: ${v.kind} — ${v.detail}`);
    for (const w of report.warnings) stdout(`[env-isolation] note ${w.key}: ${w.kind} — ${w.detail}`);
    stdout(`[env-isolation] result: ${report.ok ? 'ISOLATED' : 'NOT ISOLATED'}`);
  }
  return report.ok ? 0 : 1;
}

function parseArgv(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') { out.json = true; continue; }
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { out[key] = next; i += 1; }
  }
  return out;
}

const isDirectRun = typeof process.argv[1] === 'string' && /check-env-isolation\.mjs$/.test(process.argv[1]);
if (isDirectRun) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(`[env-isolation] ${error?.message ?? String(error)}`);
    process.exitCode = 2;
  });
}
