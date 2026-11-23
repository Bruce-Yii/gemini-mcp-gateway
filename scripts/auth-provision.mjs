#!/usr/bin/env node
/**
 * Gateway-owned authorization provisioning helper (batch 15 · auth readiness).
 *
 * This script makes an authorization REPEATABLE and AUDITABLE before we ever
 * ask the user to grant anything. It is deliberately split into two phases:
 *
 *   1. OFFLINE PLAN (default, no network): read-only. It checks provider facts,
 *      `--token-env` presence (name only, value never printed), the target
 *      environment namespace, and prints EXACTLY what would be written and
 *      what still blocks the authorization. Nothing is sent anywhere.
 *   2. APPLY (`--apply`, KV write only): writes a v2 grant
 *      `gmcgw:v2:grant:<environment>:<owner>:<server>` with an explicit owner,
 *      environment and grantId. For static credentials the owner is `manual`
 *      and the record carries `authMode: 'static_bearer'` so no code path can
 *      ever try to refresh it.
 *
 * Network access happens ONLY when `--verify` is passed (and even then through
 * an injectable `fetch` so tests use a fake). `--verify` performs a real
 * MCP `tools/list` call with the bearer token to prove the credential works.
 * NO token, secret, or Authorization header value is ever written to stdout,
 * stderr, or a KV audit field.
 *
 * Provider facts (`docs/eval/AUTH-PROVIDERS.md`, fetched 2026-11-23):
 *   - Linear: official MCP accepts a Bearer PAT directly → static_bearer is the
 *     preferred path; no refresh, no OAuth grant.
 *   - Notion: official MCP accepts an owner-created static MCP token on
 *     Business/Enterprise → static_bearer works IF the user has such a token;
 *     interactive OAuth requires DCR/CIMD, which `src/upstream-oauth.js` does
 *     NOT implement yet → blocked until DCR lands or a static token is supplied.
 *   - Vercel: OAuth-only (no static MCP token). It MUST use `offline_access`
 *     and a CIMD/pre-registered client; DCR-only clients are not accepted by
 *     the MCP server. Cannot be provisioned here yet → blocked with a clear
 *     explanation and the exact start URL to use once CIMD is configured.
 *
 * Usage:
 *   node scripts/auth-provision.mjs --provider linear --token-env LINEAR_TOKEN [--environment local|prod]
 *   node scripts/auth-provision.mjs --provider notion --token-env NOTION_MCP_TOKEN --environment prod
 *   node scripts/auth-provision.mjs --provider vercel --environment prod           # prints OAuth start instructions
 *   node scripts/auth-provision.mjs --provider linear --token-env LINEAR_TOKEN --verify [--apply]
 *
 * Exit status: 0 = plan/applied with no blockers; 1 = blocked (checklist not
 * all green); 2 = bad arguments. `--json` emits a machine-readable plan.
 */
import { randomUUID } from 'node:crypto';

import {
  ENVIRONMENTS, V2_KEY_PREFIX, GRANT_OWNERS,
  STATIC_BEARER, STATIC_TOKEN_NO_REFRESH,
  requiredScopes,
} from '../src/upstream-auth.js';

/** Default MCP endpoints for the providers we can provision. */
export const MCP_URLS = Object.freeze({
  notion: 'https://mcp.notion.com/mcp',
  linear: 'https://mcp.linear.app/mcp',
  vercel: 'https://mcp.vercel.com/',
});

/** Which providers support an owner-created static bearer credential. */
export const STATIC_CAPABLE = Object.freeze(['linear', 'notion']);
export const OAUTH_ONLY = Object.freeze(['vercel']);
export const SUPPORTED_PROVIDERS = Object.freeze([...STATIC_CAPABLE, ...OAUTH_ONLY]);

/** Map the CLI's short `--environment prod` to the canonical env name. */
export function normalizeEnvironment(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (raw === 'prod') return 'production';
  return ENVIRONMENTS.includes(raw) ? raw : null;
}

/** Build the v2 key this script writes. Kept here (not importing private
 *  UpstreamAuth._key) so the script is independently verifiable in tests. */
export function grantKey(environment, owner, server) {
  return `${V2_KEY_PREFIX}:${environment}:${owner}:${server}`;
}

/** Build the v2 grant record for a static bearer credential. `token` is used
 *  only as `access_token` in the returned object; callers must never print it. */
export function buildStaticGrant({ server, token, environment, grantSource = 'manual' }) {
  if (!token) throw new Error('static grant requires a token');
  if (!environment || !ENVIRONMENTS.includes(environment)) throw new Error('static grant requires a valid environment');
  return {
    access_token: token,
    owner: 'manual',
    source: grantSource,
    environment,
    grantId: `manual:${environment}:${server}`,
    authMode: STATIC_BEARER,
    bootstrapped: false,
    needsReauth: false,
    // No refresh_token / client_id on purpose: a static credential must never
    // be mistaken for a rotating gateway grant.
    staticTokenNoRefresh: true,
    provisionedBy: 'scripts/auth-provision.mjs',
    provisionedAt: new Date().toISOString(),
    leaseId: randomUUID(),
  };
}

/**
 * Make a pure, offline plan for a provider. This is the default output and
 * performs ZERO network I/O. Every returned line is safe to print (no token).
 *
 * @param {{
 *   provider: string,
 *   tokenEnv?: string,
 *   environment?: string,
 *   mode?: 'static'|'oauth',
 *   callbackBaseUrl?: string,
 * }} input
 * @param {{env?: Record<string,string|undefined>, now?: number}} [ctx]
 */
export function planProvision(input, { env = process.env } = {}) {
  const provider = String(input.provider ?? '').trim().toLowerCase();
  const environment = normalizeEnvironment(input.environment ?? 'local');
  const tokenEnv = input.tokenEnv ? String(input.tokenEnv).trim() : undefined;
  const blockers = [];
  const lines = [];
  const result = {
    provider,
    environment,
    tokenEnv: tokenEnv ?? null,
    tokenPresent: false,
    key: null,
    kind: null,
    verify: false,
    ready: false,
    blockers,
    lines,
  };

  if (!SUPPORTED_PROVIDERS.includes(provider)) {
    blockers.push(`unsupported provider "${provider}" (expected one of ${SUPPORTED_PROVIDERS.join(', ')})`);
    return result;
  }
  if (!environment) {
    blockers.push(`invalid environment (expected ${ENVIRONMENTS.join(', ')} or prod)`);
    return result;
  }

  const wantsStatic = input.mode === 'static' || Boolean(tokenEnv);
  const wantsOAuth = input.mode === 'oauth' || OAUTH_ONLY.includes(provider);
  if (wantsStatic && wantsOAuth) {
    blockers.push('static and oauth modes are mutually exclusive');
    return result;
  }
  if (wantsOAuth) {
    result.kind = 'oauth';
    result.key = grantKey(environment, 'gateway', provider);
    lines.push(`provider=${provider} mode=oauth environment=${environment}`);
    lines.push(`target KV key (written by callback, NOT by this script): ${result.key}`);
    if (provider === 'vercel') {
      lines.push('Vercel is OAuth-only: no static MCP token exists.');
      lines.push('Authorization MUST include offline_access and a CIMD / pre-approved client; DCR-only clients are rejected by mcp.vercel.com.');
      lines.push(`required scopes: ${requiredScopes('vercel').join(' ') || '(none)'}`);
      lines.push(`authorize URL base: https://vercel.com/oauth/authorize (token endpoint https://api.vercel.com/login/oauth/token)`);
      if (input.callbackBaseUrl) {
        lines.push(`callback URI: ${String(input.callbackBaseUrl).replace(/\/$/, '')}/upstream/oauth/callback?env=${environment}`);
      }
      blockers.push('Vercel OAuth start URL cannot be generated until a CIMD client_id is configured (src/upstream-oauth.js has no DCR support)');
      blockers.push('real authorization + refresh_token verification is pending (do not ask the user yet)');
    } else {
      // notion/linear interactive OAuth through the generic handler needs
      // authorizeUrl/clientIdEnv and (for Notion) DCR, which we do not have.
      blockers.push(`${provider} interactive OAuth is not provisionable here: DCR/CIMD client registration is not implemented in src/upstream-oauth.js`);
    }
    result.ready = false;
    return result;
  }

  // Static bearer path (Linear PAT / Notion static MCP token).
  result.kind = 'static';
  result.key = grantKey(environment, 'manual', provider);
  lines.push(`provider=${provider} mode=static_bearer environment=${environment}`);
  lines.push(`target KV key: ${result.key}`);
  lines.push(`grant owner: manual (source: manual) — no rotating grant, never refreshed`);
  lines.push(`token source: env ${tokenEnv ?? '(missing)'}`);
  if (!STATIC_CAPABLE.includes(provider)) {
    blockers.push(`${provider} has no owner-created static MCP token; cannot use static_bearer`);
  }
  if (!tokenEnv) {
    blockers.push('missing --token-env (the name of the env var holding the static token)');
  } else {
    result.tokenPresent = Boolean(env[tokenEnv]);
    if (!result.tokenPresent) {
      blockers.push(`env ${tokenEnv} is not set in this shell — nothing was read or written`);
    }
  }
  if (provider === 'notion') {
    lines.push('Notion static MCP token requires a Business/Enterprise workspace and a workspace owner-created token;');
    lines.push('a REST integration token is NOT valid for mcp.notion.com. If unavailable, DCR/CIMD OAuth is required (not yet implemented).');
  }
  lines.push(`on expiry/revoke: status ${STATIC_TOKEN_NO_REFRESH} — owner must rotate the token manually`);
  result.ready = blockers.length === 0;
  return result;
}

/** Print a plan. Every line is redacted against `secrets` as a defence in
 *  depth: even if a caller accidentally includes a token, it never reaches
 *  stdout. */
export function formatPlan(plan, { secrets = [] } = {}) {
  const values = secrets.filter((value) => typeof value === 'string' && value.length > 0);
  const redact = (line) => values.reduce(
    (acc, secret) => acc.split(secret).join('[REDACTED]'),
    String(line),
  );
  const out = [];
  out.push(...plan.lines.map(redact));
  out.push(`readiness: ${plan.ready ? 'GREEN (offline checks only)' : 'BLOCKED'}`);
  for (const blocker of plan.blockers) out.push(`  BLOCKER: ${redact(blocker)}`);
  return out.join('\n');
}

/**
 * Execute provisioning. Network is used ONLY when `verify` is true. KV write
 * is done ONLY when `apply` is true. All I/O is injectable for deterministic
 * tests (`store`, `fetchImpl`, `stdout`, `stderr`, `env`).
 *
 * @returns {Promise<{plan: object, verified: boolean, wrote: boolean, blockers: string[]}>}
 */
export async function provision(input, {
  env = process.env,
  store = null,
  fetchImpl = globalThis.fetch,
  stdout = console.log,
  stderr = console.error,
} = {}) {
  const plan = planProvision(input, { env });
  const output = formatPlan(plan, { secrets: input.tokenEnv ? [env[input.tokenEnv]] : [] });
  stdout(output);

  const token = input.tokenEnv ? env[input.tokenEnv] : undefined;
  let verified = false;
  if (plan.kind === 'static' && input.verify) {
    if (!token) {
      plan.blockers.push('cannot verify: token env is unset');
    } else {
      const url = input.mcpUrl ?? MCP_URLS[plan.provider];
      const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
      let response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            Authorization: `Bearer ${token}`,
          },
          body,
        });
        verified = Boolean(response?.ok);
      } catch (error) {
        plan.blockers.push(`tools/list failed: ${error?.message ?? String(error)}`);
      }
      if (!verified && !(plan.blockers.some((b) => b.startsWith('tools/list failed')))) {
        plan.blockers.push(`tools/list returned HTTP ${response?.status ?? 'unknown'} — credential rejected`);
      }
    }
  }

  let wrote = false;
  if (plan.kind === 'static' && input.apply) {
    if (!token) {
      plan.blockers.push('cannot apply: token env is unset');
    } else if (!store || typeof store._command !== 'function') {
      plan.blockers.push('cannot apply: KV store is not configured');
    } else {
      const record = buildStaticGrant({
        server: plan.provider,
        token,
        environment: plan.environment,
        grantSource: input.grantSource ?? 'manual',
      });
      try {
        await store._command('set', plan.key, JSON.stringify(record));
        wrote = true;
      } catch (error) {
        plan.blockers.push(`KV write failed: ${error?.message ?? String(error)}`);
      }
    }
  }

  plan.ready = plan.blockers.length === 0 && (input.apply ? wrote : true);
  const status = plan.ready ? 'READY' : 'BLOCKED';
  stdout(`result: ${status} verified=${verified} wrote=${wrote} blockers=${plan.blockers.length}`);
  return { plan, verified, wrote, blockers: plan.blockers };
}

// ── CLI ───────────────────────────────────────────────────────────────────
function parseArgv(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--verify') { out.verify = true; continue; }
    if (arg === '--apply') { out.apply = true; continue; }
    if (arg === '--json') { out.json = true; continue; }
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { out[key] = next; i += 1; }
    else out[key] = true;
  }
  return out;
}

/** Run the CLI. Split out so tests can stub process.exit / stdout. */
export async function main(argv = process.argv.slice(2), deps = {}) {
  const args = parseArgv(argv);
  const {
    env = process.env,
    storeFactory = () => null,
    fetchImpl = globalThis.fetch,
    stdout = console.log,
    stderr = console.error,
  } = deps;

  if (!args.provider) {
    stderr('usage: auth-provision.mjs --provider linear|notion|vercel [--token-env NAME] [--environment local|prod] [--verify] [--apply] [--json]');
    return 2;
  }

  const store = args.apply ? await storeFactory() : null;
  const outcome = await provision({
    provider: args.provider,
    tokenEnv: args.tokenEnv,
    environment: args.environment ?? 'local',
    mode: args.mode,
    callbackBaseUrl: args.callbackBaseUrl,
    verify: Boolean(args.verify),
    apply: Boolean(args.apply),
  }, { env, store, fetchImpl, stdout, stderr });

  if (args.json) {
    stdout(JSON.stringify({
      provider: outcome.plan.provider,
      environment: outcome.plan.environment,
      kind: outcome.plan.kind,
      key: outcome.plan.key,
      ready: outcome.plan.ready,
      verified: outcome.verified,
      wrote: outcome.wrote,
      blockers: outcome.blockers,
    }));
  }
  return outcome.plan.ready ? 0 : 1;
}

// Only build a real KV store when the script is executed directly with
// --apply. Importing it in tests must not require KV credentials or open a
// network connection. The dynamic import keeps the common offline path
// dependency- and network-free.
const isDirectRun = typeof process.argv[1] === 'string'
  && /auth-provision\.mjs$/.test(process.argv[1]);
if (isDirectRun) {
  main(process.argv.slice(2), {
    storeFactory: async () => {
      const { TokenStore } = await import('../src/store.js');
      const store = new TokenStore();
      if (!store.isConfigured()) {
        console.error('[auth-provision] --apply needs KV: set KV_REST_API_URL/TOKEN (or UPSTASH_REDIS_REST_*).');
        return null;
      }
      return store;
    },
  }).then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(`[auth-provision] ${error?.message ?? String(error)}`);
    process.exitCode = 2;
  });
}
