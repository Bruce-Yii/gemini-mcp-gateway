#!/usr/bin/env node
/**
 * Owner-marking migration for rotating grants (READ-ONLY by default).
 *
 * Why: since 2026-11-24 an unmarked grant is `shared` and is NEVER refreshed
 * (see upstream-auth._grantOwner). Legacy v1 records are read-only aliases, so
 * the only way to make one refreshable again is to copy it forward under an
 * explicit owner namespace — which must be a deliberate, auditable action.
 *
 * This script:
 *   - reads v1 legacy + v2 owner records for every configured server;
 *   - plans a v2 copy for UNMARKED legacy records under `--owner` (default dsh,
 *     which is read-only and still never refreshed);
 *   - reports (does not rewrite) unmarked v2 records and unknown owners;
 *   - with `--apply`, writes only the planned copies (never touches the legacy
 *     key, never deletes anything, never calls a provider).
 *
 * It never prints, logs, compares or returns access/refresh token values;
 * only booleans (hasAccessToken / hasRefreshToken) are reported.
 *
 * Usage:
 *   node scripts/auth-migrate-owners.mjs                       # plan (needs KV to read)
 *   node scripts/auth-migrate-owners.mjs --apply               # write copies
 *   node scripts/auth-migrate-owners.mjs --owner dsh --json
 *   node scripts/auth-migrate-owners.mjs --allow-gateway ...   # explicit risk opt-in
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LEGACY_KEY_PREFIX, V2_KEY_PREFIX, GRANT_OWNERS } from '../src/upstream-auth.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

export function grantKey(environment, owner, server) {
  return `${V2_KEY_PREFIX}:${environment}:${owner}:${server}`;
}

export function legacyKey(environment, server) {
  return environment === 'production'
    ? `${LEGACY_KEY_PREFIX}:${server}`
    : `${LEGACY_KEY_PREFIX}:${environment}:${server}`;
}

/** Classify a stored record by its explicit ownership marking. */
export function classifyRecord(record) {
  if (!record || typeof record !== 'object') return 'missing';
  const raw = String(record.owner ?? record.source ?? '').trim().toLowerCase();
  if (!raw) return 'unmarked';
  if (raw.includes('dsh')) return 'dsh';
  if (raw === 'gateway' || raw.includes('gateway')) return 'gateway';
  if (raw === 'manual' || raw.includes('static_bearer') || raw.includes('pat')) return 'manual';
  return 'unknown';
}

function copyForOwner(record, owner, environment, server) {
  const clean = { ...record };
  delete clean.__fromLegacyKey;
  return {
    ...clean,
    owner,
    source: owner === 'dsh' ? 'dsh-exported' : owner === 'gateway' ? 'gateway-oauth' : 'manual',
    environment,
    grantId: typeof clean.grantId === 'string' && clean.grantId
      ? clean.grantId
      : `${owner}:${environment}:${server}`,
  };
}

/**
 * Pure planner. Inputs are already-read records so it is trivially testable.
 * @returns {{environment:string,targetOwner:string,actions:object[],summary:object}}
 */
export function planMigration({ environment, servers, legacy = {}, v2 = {}, targetOwner = 'dsh' }) {
  const actions = [];
  for (const server of servers) {
    const legacyRecord = legacy[server] ?? null;
    if (legacyRecord) {
      const kind = classifyRecord(legacyRecord);
      if (kind === 'missing') {
        // nothing
      } else if (kind !== 'unmarked') {
        actions.push({
          server, type: 'skip', reason: 'legacy-already-marked', ownership: kind,
          from: legacyKey(environment, server), to: null,
        });
      } else {
        const to = grantKey(environment, targetOwner, server);
        const target = v2?.[server]?.[targetOwner] ?? null;
        if (target) {
          actions.push({
            server, type: 'skip', reason: 'target-exists', ownership: classifyRecord(target),
            from: legacyKey(environment, server), to,
          });
        } else {
          actions.push({
            server, type: 'copy-legacy', ownership: 'unmarked',
            from: legacyKey(environment, server), to, owner: targetOwner,
            hasAccessToken: Boolean(legacyRecord.access_token),
            hasRefreshToken: Boolean(legacyRecord.refresh_token),
          });
        }
      }
    }
    for (const [owner, record] of Object.entries(v2?.[server] ?? {})) {
      if (!record) continue;
      const kind = classifyRecord(record);
      if (kind === 'unmarked') {
        const to = grantKey(environment, targetOwner, server);
        const targetFree = !v2?.[server]?.[targetOwner];
        actions.push({
          server, type: targetFree ? 'tag-v2' : 'report',
          reason: targetFree ? 'v2-unmarked' : 'v2-unmarked-target-occupied',
          ownership: 'unmarked', from: grantKey(environment, owner, server),
          sourceOwner: owner,
          to: targetFree ? to : null, owner: targetOwner,
          hasAccessToken: Boolean(record.access_token),
          hasRefreshToken: Boolean(record.refresh_token),
        });
      } else if (kind === 'unknown') {
        actions.push({
          server, type: 'report', reason: 'unknown-owner', ownership: 'unknown',
          from: grantKey(environment, owner, server), to: null,
        });
      }
    }
  }
  const summary = {
    copyLegacy: actions.filter((a) => a.type === 'copy-legacy').length,
    tagV2: actions.filter((a) => a.type === 'tag-v2').length,
    reported: actions.filter((a) => a.type === 'report').length,
    skipped: actions.filter((a) => a.type === 'skip').length,
  };
  return { environment, targetOwner, actions, summary };
}

function parseRecord(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/** Read KV and produce a plan; `apply` writes only planned copies. */
export async function migrate({ store, servers, environment, targetOwner = 'dsh', apply = false, allowGateway = false }) {
  if (!GRANT_OWNERS.includes(targetOwner)) {
    throw new Error(`targetOwner must be one of ${GRANT_OWNERS.join(', ')}`);
  }
  if (targetOwner === 'gateway' && !allowGateway) {
    throw new Error('refusing to migrate to owner=gateway without --allow-gateway (it grants refresh rights)');
  }
  if (!store || typeof store._command !== 'function') {
    throw new Error('KV store is not configured');
  }

  const legacy = {};
  const v2 = {};
  for (const server of servers) {
    legacy[server] = parseRecord(await store._command('get', legacyKey(environment, server)));
    v2[server] = {};
    for (const owner of GRANT_OWNERS.concat(['shared'])) {
      v2[server][owner] = parseRecord(await store._command('get', grantKey(environment, owner, server)));
    }
  }

  const plan = planMigration({ environment, servers, legacy, v2, targetOwner });
  const applied = [];
  if (apply) {
    for (const action of plan.actions) {
      if (action.type !== 'copy-legacy' && action.type !== 'tag-v2') continue;
      const source = action.type === 'copy-legacy'
        ? legacy[action.server]
        : v2[action.server]?.[action.sourceOwner];
      if (!source) continue;
      const record = copyForOwner(source, targetOwner, environment, action.server);
      await store._command('set', action.to, JSON.stringify(record));
      applied.push({ server: action.server, to: action.to, type: action.type });
    }
  }
  return { ...plan, apply, applied };
}

function parseArgv(argv) {
  const out = { owner: 'dsh' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') { out.apply = true; continue; }
    if (arg === '--json') { out.json = true; continue; }
    if (arg === '--allow-gateway') { out.allowGateway = true; continue; }
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { out[key] = next; i += 1; }
  }
  return out;
}

async function loadServers(configPath) {
  const file = configPath ?? process.env.GATEWAY_CONFIG ?? resolve(ROOT, 'config.example.json');
  const parsed = JSON.parse(await readFile(resolve(file), 'utf8'));
  const servers = Array.isArray(parsed) ? parsed : parsed.servers;
  if (!Array.isArray(servers)) throw new Error(`${file}: missing servers[]`);
  return servers.map((s) => s.name).filter(Boolean);
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const args = parseArgv(argv);
  const { env = process.env, stdout = console.log, stderr = console.error, storeFactory = () => null } = deps;
  const environment = args.environment ?? env.GMCGW_ENVIRONMENT ?? env.VERCEL_ENV ?? 'local';
  if (environment !== 'production' && environment !== 'preview' && environment !== 'local') {
    stderr(`[auth-migrate] unsupported environment "${environment}"`);
    return 2;
  }
  const servers = await loadServers(args.config);
  const store = await storeFactory();
  if (!store || !store.isConfigured?.()) {
    stderr('[auth-migrate] needs KV to read grants: set KV_REST_API_URL/TOKEN (or UPSTASH_REDIS_REST_*). Plan mode still reads KV.');
    return 2;
  }
  const result = await migrate({
    store, servers, environment,
    targetOwner: args.owner ?? 'dsh',
    apply: Boolean(args.apply),
    allowGateway: Boolean(args.allowGateway),
  });
  if (args.json) {
    stdout(JSON.stringify({ environment: result.environment, targetOwner: result.targetOwner, apply: result.apply, summary: result.summary, actions: result.actions, applied: result.applied }, null, 2));
  } else {
    stdout(`[auth-migrate] environment=${result.environment} owner=${result.targetOwner} apply=${result.apply}`);
    stdout(`[auth-migrate] plan: copy-legacy=${result.summary.copyLegacy} tag-v2=${result.summary.tagV2} report=${result.summary.reported} skip=${result.summary.skipped}`);
    for (const action of result.actions) {
      stdout(`[auth-migrate] ${action.type.padEnd(11)} ${action.server.padEnd(8)} ${action.reason}${action.from ? ` from=${action.from}` : ''}${action.to ? ` to=${action.to}` : ''}`);
    }
    if (result.applied.length) stdout(`[auth-migrate] applied=${result.applied.length}`);
  }
  return result.summary.reported > 0 ? 1 : 0;
}

const isDirectRun = typeof process.argv[1] === 'string' && /auth-migrate-owners\.mjs$/.test(process.argv[1]);
if (isDirectRun) {
  main(process.argv.slice(2), {
    storeFactory: async () => {
      const { TokenStore } = await import('../src/store.js');
      return new TokenStore();
    },
  }).then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(`[auth-migrate] ${error?.message ?? String(error)}`);
    process.exitCode = 2;
  });
}
