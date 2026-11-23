/**
 * Upstream OAuth token lifecycle (batch 15 · token lifecycle).
 *
 * THE PROBLEM THIS FILE FIXES
 * ---------------------------
 * Notion kept getting `invalid_grant`, Linear kept getting `invalid_token`, and
 * Vercel eventually returned `invalid_token` with no way to recover. The old
 * flow looked safe (lock + CAS + invalid_grant terminal) but the state machine
 * was wrong in four concrete ways:
 *
 *   1. A fresh env seed set `bootstrapped: true`, which forced a refresh on
 *      EVERY call until one succeeded. With rotating refresh tokens, N cold
 *      starts all refreshing the same grant = grant revoked.
 *   2. The refresh lock had no owner token and was released with an
 *      unconditional DEL. If worker A's lease expired, A could delete worker
 *      B's lock, letting C refresh concurrently (rotation race again).
 *   3. The `invalid_grant` terminal marker was written with a plain SET after
 *      the refresh attempt. A stale loser could overwrite the winner's freshly
 *      rotated record with a dead token + needsReauth.
 *   4. KV keys were global: a Vercel preview deployment could read/refresh the
 *      production grant. Vercel has no refresh endpoint at all, so its static
 *      token expiry could only ever be reported, never auto-fixed.
 *
 * THE STATE MACHINE NOW
 * ---------------------
 *   (no KV record)  --env seed-->  SEEDING (bootstrapped: true)
 *   SEEDING         --one refresh attempt under lease, success-->  ACTIVE
 *   SEEDING         --attempt failed-->  ACTIVE (attempt consumed; no retry loop)
 *   ACTIVE          --expiry skew / provider 401-->  REFRESHING (lease + CAS)
 *   REFRESHING      --CAS win-->  ACTIVE (new pair committed)
 *   REFRESHING      --CAS lose-->  ACTIVE (winner's pair adopted, never written back)
 *   REFRESHING      --invalid_grant-->  REAUTH_REQUIRED (terminal, CAS-guarded)
 *   REAUTH_REQUIRED --new env grant explicitly seeded-->  SEEDING
 *
 * KV is the only source of truth for the current pair. Env is used ONLY to
 * seed a missing record, or when the caller explicitly signals a new grant
 * (`envSeed` change). A rotated record keeps its `envSeed`, so cold starts do
 * not rebuild it. `needsReauth` is terminal until a *different* env seed
 * arrives AND that seed is actually accepted as a new grant.
 */

import { randomUUID } from 'node:crypto';
import { captureEvent } from './capture.js';
import { TokenStore } from './store.js';

/** v2 namespace: environment + owner are ALWAYS explicit in the key. */
const KEY_PREFIX_V2 = 'gmcgw:v2:grant';
/** v1 keys are read-only legacy aliases (migration window, design doc §6). */
const KEY_PREFIX_V1 = 'gmcgw:v1:upstream';

export const ENVIRONMENTS = Object.freeze(['production', 'preview', 'development', 'local']);
export const LEGACY_KEY_PREFIX = KEY_PREFIX_V1;
export const V2_KEY_PREFIX = KEY_PREFIX_V2;

const REFRESH_SKEW_MS = 5 * 60 * 1000; // refresh 5 min before expiry
const LEASE_TTL_MS = 60 * 1000;   // long enough for a slow provider call
const LEASE_RENEW_MS = 20 * 1000; // renew every 20s so the lease cannot expire mid-refresh
const LOCK_WAIT_MS = 1200;

/** Explicit terminal status written to KV and surfaced to callers. */
export const REAUTH_REQUIRED = 'REAUTH_REQUIRED';

/** A static (non-OAuth) token cannot be refreshed. Report it, don't pretend. */
export const STATIC_TOKEN_NO_REFRESH = 'STATIC_TOKEN_NO_REFRESH';

/**
 * The grant is owned by another process (notably the DSH MCP connector). Its
 * rotating refresh token may be spent at any moment by that owner, so THIS
 * gateway must never refresh it. Use a long-lived access token or authorize
 * the gateway as its own OAuth client instead.
 */
export const SHARED_GRANT_REFRESH_FORBIDDEN = 'SHARED_GRANT_REFRESH_FORBIDDEN';

/** Legacy/source markers found in DSH-exported grants. */
export const DSH_GRANT_SOURCE = 'dsh-mcp-connector-oauth-grant';

/** Owners we recognise. Anything else is treated as foreign/shared. */
export const GRANT_OWNERS = Object.freeze(['gateway', 'dsh', 'manual']);

/** Error type for callers that want to distinguish terminal auth failures. */
export class ReauthRequiredError extends Error {
  constructor(server, reason = REAUTH_REQUIRED) {
    super(`[${server}] ${REAUTH_REQUIRED} (${reason}): upstream credentials must be re-authorized; automatic refresh is disabled until a new grant is seeded`);
    this.name = 'ReauthRequiredError';
    this.server = server;
    this.reason = reason;
    this.status = REAUTH_REQUIRED;
  }
}

// Built-in OAuth providers (token + MCP endpoints). Any other upstream can opt
// into refresh by setting `refreshUrl` (token endpoint) in its config.
const DEFAULT_PROVIDERS = {
  notion: { tokenUrl: 'https://mcp.notion.com/token', mcpUrl: 'https://mcp.notion.com/mcp' },
  linear: { tokenUrl: 'https://mcp.linear.app/token', mcpUrl: 'https://mcp.linear.app/mcp' },
};

/**
 * Provider OAuth facts (verified against provider docs, 2026-11):
 *  - Notion MCP: OAuth DCR only, no API-key/bearer mode; access ~1h; the
 *    refresh token ROTATES on every use (single-use, grant family).
 *  - Linear MCP: OAuth only. A Linear PAT works for the GraphQL API but NOT
 *    for the official MCP server. Access ~24h + rotating refresh.
 *  - Vercel MCP: access ~1h. `offline_access` MUST be requested during the
 *    authorization request or no refresh token is issued (hourly reauth).
 *
 * A gateway-owned authorization MUST include `offline_access` so we get a
 * refresh token; without it we fall back to STATIC_TOKEN_NO_REFRESH rather
 * than pretending the token can be renewed.
 */
export const OAUTH_PROVIDER_FACTS = Object.freeze({
  notion: { auth: 'oauth-dcr', accessTtlSeconds: 3600, rotates: true, requiredScopes: ['offline_access'] },
  linear: { auth: 'oauth', accessTtlSeconds: 86400, rotates: true, requiredScopes: ['offline_access'] },
  vercel: { auth: 'oauth', accessTtlSeconds: 3600, rotates: true, requiredScopes: ['offline_access'] },
});

/** Scopes a gateway-owned authorization must request for a provider. */
export function requiredScopes(server) {
  return OAUTH_PROVIDER_FACTS[server]?.requiredScopes ?? [];
}

/** Built-in provider defaults, or null for static-token upstreams. */
export function defaultProvider(server) {
  return DEFAULT_PROVIDERS[server] ?? null;
}

/**
 * Resolve the deployment environment used to namespace upstream token keys.
 *
 * SECURITY (batch-15-auth-architecture R2): NEVER default to production.
 *  - GMCGW_ENVIRONMENT is the explicit override (all four environments).
 *  - VERCEL_ENV is the platform signal on Vercel (production/preview/development).
 *  - VERCEL === '1' with no VERCEL_ENV is a Vercel runtime we cannot classify —
 *    fall back to `preview` (a safe, isolated namespace), never production.
 *  - Everything else (a plain local shell, a test runner, an unidentified
 *    container) defaults to `local`. A local cold start can no longer read or
 *    refresh a production grant.
 */
export function resolveEnvironment(env = process.env) {
  const explicit = String(env.GMCGW_ENVIRONMENT ?? '').trim().toLowerCase();
  if (ENVIRONMENTS.includes(explicit)) return explicit;
  const vercel = String(env.VERCEL_ENV ?? '').trim().toLowerCase();
  if (['production', 'preview', 'development'].includes(vercel)) return vercel;
  if (String(env.VERCEL ?? '').trim() === '1') return 'preview';
  return 'local';
}

function isInvalidGrant(error) {
  const msg = String(error?.message ?? error ?? '');
  return /invalid_grant|revoked|grant.*(expired|invalid)/i.test(msg);
}

export class UpstreamAuth {
  constructor(options = {}) {
    this.store = options.store ?? new TokenStore();
    this._fetch = options.fetch ?? globalThis.fetch;
    this.environment = options.environment ?? resolveEnvironment();
    /**
     * Who owns the grants this instance manages. Only `gateway` may spend a
     * rotating refresh token. `dsh` / `manual` / unknown = shared or foreign —
     * we may USE the access token but must NEVER refresh it.
     */
    this.grantOwner = options.grantOwner ?? 'gateway';
    /** @type {Map<string, {status:string, reason?:string, at:number}>} */
    this._status = new Map();
    /**
     * R6: same-instance refresh coalescing. Concurrent getAccessToken() calls
     * on THIS UpstreamAuth instance share one in-flight refresh promise, so a
     * single serverless instance never spends the rotating grant more than
     * once. Cross-instance safety still relies on the Redis lease + CAS.
     * @type {Map<string, Promise<string>>}
     */
    this._refreshPromises = new Map();
  }

  /** Base KV key for a server. ALWAYS the explicit v2 namespace
   *  `gmcgw:v2:grant:<environment>:<owner>:<server>` (design doc §1.2, R4).
   *  No combination — including production+gateway — writes to a legacy
   *  un-suffixed key. Legacy keys are READ-ONLY aliases (see _legacyKey). */
  _key(server, owner) {
    const effectiveOwner = owner ?? this.grantOwner;
    return `${KEY_PREFIX_V2}:${this.environment}:${effectiveOwner}:${server}`;
  }

  /** Legacy v1 key for the SAME logical grant. Used ONLY as a read-only
   *  migration alias (design doc §6): a rotated v1 record can still be read,
   *  but is never written back to. Returns null for environments that never
   *  had a v1 key (local) or non-gateway owners. */
  _legacyKey(server, owner) {
    const effectiveOwner = owner ?? this.grantOwner;
    if (effectiveOwner !== 'gateway' || this.environment === 'local') return null;
    if (this.environment === 'production') return `${KEY_PREFIX_V1}:${server}`;
    return `${KEY_PREFIX_V1}:${this.environment}:${server}`;
  }

  _lockKey(server) { return `${this._key(server)}:lock`; }

  /**
   * Determine ownership of a grant from explicit options or the seed record.
   *
   * SECURITY (R1): an UNMARKED grant is untrusted — it is `shared`, and a
   * shared grant must NEVER be auto-refreshed by this gateway. Only an
   * explicit `owner=gateway` (or `source=gateway-*`) grants refresh rights.
   * The single exception is the legacy migration window: an unmarked record
   * living in a v1 key (the only place such records exist) is treated as
   * gateway so an existing deployment can rotate once before re-authorizing.
   * See design doc §4.1 / §6.
   */
  _grantOwner(rec, options = {}) {
    const explicit = String(options.grantOwner ?? options.source ?? rec?.owner ?? rec?.source ?? '').toLowerCase();
    if (!explicit) {
      return options.legacy ? 'gateway' : 'shared';
    }
    if (explicit.includes('dsh') || explicit === DSH_GRANT_SOURCE) return 'dsh';
    if (explicit === 'gateway' || explicit.includes('gateway')) return 'gateway';
    if (explicit === 'manual' || explicit.includes('static_bearer') || explicit.includes('pat')) return 'manual';
    return 'shared';
  }

  /** Only gateway-owned grants may be spent by this process. */
  _mayRefresh(rec, options = {}) {
    return this._grantOwner(rec, options) === 'gateway';
  }

  /** Marker set on records loaded from a read-only legacy alias. */
  static get LEGACY_MARK() { return '__fromLegacyKey'; }

  async _load(server, { includeLegacy = true, owner } = {}) {
    if (!this.store.isConfigured()) return null;
    const keys = owner
      ? [this._key(server, owner)]
      : [this._key(server), ...['gateway', 'dsh', 'manual', 'shared']
        .filter((o) => o !== this.grantOwner)
        .map((o) => this._key(server, o))];
    for (const key of keys) {
      try {
        const raw = await this.store._command('get', key);
        if (raw && typeof raw === 'string') return JSON.parse(raw);
      } catch { /* keep looking */ }
    }
    // R4: legacy keys are READ-ONLY aliases. We may read a rotated pair from
    // them during migration, but every write (_save / casToken) targets v2.
    if (includeLegacy) {
      const legacy = this._legacyKey(server, owner);
      if (legacy) {
        try {
          const rawLegacy = await this.store._command('get', legacy);
          if (rawLegacy && typeof rawLegacy === 'string') {
            const rec = JSON.parse(rawLegacy);
            // Preserve legacy unmarked grants as gateway for the migration
            // window only (R1 exception, design doc §4.1).
            if (rec && !rec.owner && !rec.source) rec.owner = 'gateway';
            if (rec) rec[UpstreamAuth.LEGACY_MARK] = true;
            return rec;
          }
        } catch { /* ignore */ }
      }
    }
    return null;
  }

  /** Write a full record. Used for seeding ONLY — never for a refresh result.
   *  Writes ALWAYS go to the v2 key; the legacy alias is never touched. */
  async _save(server, record) {
    if (!this.store.isConfigured()) return;
    const clean = { ...record };
    delete clean[UpstreamAuth.LEGACY_MARK];
    // Every v2 record carries its own environment + stable grantId so a
    // record found under the wrong key can be detected as polluted.
    if (!clean.environment) clean.environment = this.environment;
    if (!clean.owner) clean.owner = this.grantOwner;
    if (!clean.grantId) clean.grantId = `${clean.owner}:${clean.environment}:${server}`;
    if (!clean.source) clean.source = clean.owner === 'gateway' ? 'gateway-oauth' : clean.owner;
    try {
      // Key owner follows the RECORD, never the process default — a shared
      // grant seeded via options must never land in the gateway namespace.
      await this.store._command('set', this._key(server, clean.owner), JSON.stringify(clean));
    } catch (e) {
      console.error(`[upstream-auth] failed to persist ${server} token: ${e.message}`);
    }
  }

  /**
   * CAS-guarded write used for terminal markers. Refuses to overwrite a record
   * whose refresh token changed (i.e. another worker won the rotation race).
   * Returns the record actually in KV afterwards, or null if unavailable.
   */
  async _saveTerminal(server, expectedRefresh, patch) {
    if (!this.store.isConfigured()) return null;
    const current = await this._load(server);
    if (!current) return null;
    if (expectedRefresh != null && String(current.refresh_token) !== String(expectedRefresh)) {
      return current; // winner already moved on — never clobber it
    }
    const next = { ...current, ...patch };
    try {
      if (typeof this.store.casToken === 'function') {
        const ok = await this.store.casToken(this._key(server), current.refresh_token, JSON.stringify(next));
        if (!ok) return await this._load(server);
      } else {
        await this._save(server, next);
      }
    } catch { return await this._load(server); }
    return next;
  }

  /**
   * Acquire a refresh lease with an OWNER TOKEN. Returns the owner string on
   * success, or null if someone else holds the lease. The owner is required to
   * release; a stale worker can never delete another worker's lock.
   */
  async _acquireLock(server, ttlSeconds = Math.ceil(LEASE_TTL_MS / 1000)) {
    if (!this.store.isConfigured()) return 'no-kv'; // single-instance fallback
    const owner = randomUUID();
    const value = JSON.stringify({ owner, expiresAt: Date.now() + ttlSeconds * 1000 });
    try {
      const r = await this.store._command('set', this._lockKey(server), value, 'NX', 'EX', String(ttlSeconds));
      return r === 'OK' || r === 'ok' || r === true ? owner : null;
    } catch { return null; } // lock backend failure: DO NOT refresh unlocked
  }

  /** Release only our own lease. Uses store.releaseLease when available (Lua
   * compare-and-delete); otherwise a get-then-delete guarded by owner match. */
  async _releaseLock(server, owner) {
    if (!owner || owner === 'no-kv' || !this.store.isConfigured()) return;
    try {
      if (typeof this.store.releaseLease === 'function') {
        await this.store.releaseLease(this._lockKey(server), owner);
        return;
      }
      const raw = await this.store._command('get', this._lockKey(server));
      if (!raw) return;
      let held;
      try { held = JSON.parse(raw); } catch { held = { owner: raw }; }
      const heldOwner = typeof held === 'string' ? held : held?.owner;
      if (heldOwner === owner) await this.store._command('del', this._lockKey(server));
    } catch { /* release is best-effort; fencing CAS is the real guard */ }
  }

  /**
   * True while we still hold the lease. Used to detect a lease we lost (e.g.
   * provider call took too long) before committing anything. Fake stores
   * without owner-aware commands fall back to reading the lock value.
   */
  async _ownsLease(server, owner) {
    if (!owner || owner === 'no-kv' || !this.store.isConfigured()) return true;
    try {
      const raw = await this.store._command('get', this._lockKey(server));
      if (!raw) return false;
      let held;
      try { held = JSON.parse(raw); } catch { held = { owner: raw }; }
      return (typeof held === 'string' ? held : held?.owner) === owner;
    } catch { return false; }
  }

  /** Renew our lease while a provider call is in flight. Returns a stop fn. */
  _keepLeaseAlive(server, owner) {
    if (!owner || owner === 'no-kv' || !this.store.isConfigured()) return () => {};
    let stopped = false;
    const timer = setInterval(async () => {
      if (stopped) return;
      try {
        if (typeof this.store.renewLease === 'function') {
          await this.store.renewLease(this._lockKey(server), owner, Math.ceil(LEASE_TTL_MS / 1000));
        } else {
          const raw = await this.store._command('get', this._lockKey(server));
          let held;
          try { held = JSON.parse(raw); } catch { held = null; }
          if (held?.owner === owner) held.expiresAt = Date.now() + LEASE_TTL_MS;
          else held = { owner, expiresAt: Date.now() + LEASE_TTL_MS };
          await this.store._command('set', this._lockKey(server), JSON.stringify(held));
        }
      } catch { /* best effort; _ownsLease + CAS are the real guards */ }
    }, LEASE_RENEW_MS);
    timer.unref?.();
    return () => { stopped = true; clearInterval(timer); };
  }

  /** Mark a terminal status in memory + KV. Never throws. */
  async _markReauth(server, rec, reason = REAUTH_REQUIRED) {
    const at = Date.now();
    this._status.set(server, { status: REAUTH_REQUIRED, reason, at });
    if (rec?.refresh_token) {
      await this._saveTerminal(server, rec.refresh_token, {
        needsReauth: true,
        status: REAUTH_REQUIRED,
        reauthReason: reason,
        needsReauthAt: at,
      });
    }
  }

  /** Read the explicit auth status for a server (KV + in-memory overlay). */
  async getAuthStatus(server) {
    const rec = await this._load(server);
    if (rec?.needsReauth || rec?.status === REAUTH_REQUIRED) {
      return {
        status: REAUTH_REQUIRED,
        reason: rec.reauthReason ?? REAUTH_REQUIRED,
        at: rec.needsReauthAt ?? 0,
      };
    }
    return this._status.get(server) ?? { status: 'ACTIVE' };
  }

  /** Verify an ACCESS token via tools/list. Does NOT consume the refresh grant. */
  async _verifyToken(server, accessToken, mcpUrl) {
    const url = mcpUrl ?? DEFAULT_PROVIDERS[server]?.mcpUrl;
    if (!url || !this._fetch) return false;
    try {
      const requestBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
      captureEvent('upstream_http', {
        phase: 'request', server, url, method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${accessToken}` },
        body: requestBody,
      });
      const r = await this._fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${accessToken}`,
        },
        body: requestBody,
      });
      let responseBody = null;
      try {
        if (typeof r.clone === 'function') {
          const text = await r.clone().text();
          responseBody = text.length > 64 * 1024 ? `${text.slice(0, 64 * 1024)}…[truncated]` : text;
        }
      } catch { /* capture is best-effort */ }
      captureEvent('upstream_http', { phase: 'response', server, url, status: r.status, headers: Object.fromEntries(r.headers), body: responseBody });
      return r.ok;
    } catch { return false; }
  }

  /**
   * Call the provider's refresh endpoint. The new pair is committed with a
   * fencing CAS keyed on the refresh token we actually spent. If the CAS loses,
   * we adopt the winner's record — we NEVER write our own result outside CAS.
   */
  async _refresh(server, rec, tokenUrl) {
    const url = tokenUrl ?? DEFAULT_PROVIDERS[server]?.tokenUrl;
    if (!url) throw new Error(`no refreshUrl configured for ${server}`);
    const now = Date.now();
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: rec.refresh_token,
      client_id: rec.client_id,
    });
    if (rec.client_secret) body.set('client_secret', rec.client_secret);
    const requestBody = body.toString();
    captureEvent('upstream_http', {
      phase: 'request', server, url, method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: requestBody,
    });
    const r = await this._fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: requestBody,
    });
    const responseText = typeof r.clone === 'function' ? await r.clone().text() : null;
    captureEvent('upstream_http', {
      phase: 'response', server, url, status: r.status,
      headers: Object.fromEntries(r.headers ?? []), body: responseText,
    });
    let j;
    try { j = await r.json(); } catch { throw new Error(`token endpoint returned non-JSON (HTTP ${r.status})`); }
    if (!r.ok || !j.access_token) throw new Error(j?.error ?? `HTTP ${r.status}`);
    const expiresIn = Number(j.expires_in ?? 0);
    const next = {
      access_token: j.access_token,
      refresh_token: j.refresh_token || rec.refresh_token, // rotate, fall back to old
      client_id: rec.client_id,
      client_secret: rec.client_secret,
      expires_at: expiresIn > 0 ? now + expiresIn * 1000 : 0,
      envSeed: rec.envSeed, // keep the seed marker so cold starts don't rebuild
      // Preserve grant ownership/metadata across rotation. A gateway-owned
      // grant stays gateway-owned; a shared grant is never refreshed at all.
      owner: rec.owner ?? 'gateway',
      source: rec.source ?? 'gateway-oauth',
      environment: rec.environment ?? this.environment,
      grantId: rec.grantId ?? `${rec.owner ?? 'gateway'}:${rec.environment ?? this.environment}:${server}`,
      updatedAt: now,
      // The bootstrap "verify once" attempt is CONSUMED by this refresh,
      // success or failure. Leaving it set was the original "刷太多" bug.
      bootstrapped: false,
    };

    if (typeof this.store.casToken === 'function' && this.store.isConfigured()) {
      const committed = await this.store.casToken(this._key(server), rec.refresh_token, JSON.stringify(next));
      if (!committed) {
        const winner = await this._load(server);
        if (winner?.access_token) {
          captureEvent('upstream_auth', {
            server, phase: 'cas_lost', expectedRefresh: rec.refresh_token,
            winnerAccess: winner.access_token, environment: this.environment,
          });
          return winner;
        }
        // KV vanished mid-flight: do not write our possibly-stale result.
        throw new Error('token CAS lost and no winner record available');
      }
    } else {
      await this._save(server, next);
    }
    return next;
  }

  /**
   * Return a valid access token for `server`.
   * `envToken` and friends are SEED inputs, not a live source of truth.
   */
  async getAccessToken(server, {
    envToken, envRefresh, envClientId, envClientSecret, envExpiresIn, envObtainedAt,
    tokenUrl, mcpUrl, grantOwner, source,
  } = {}, { force = false } = {}) {
    const provider = {
      tokenUrl: tokenUrl ?? DEFAULT_PROVIDERS[server]?.tokenUrl,
      mcpUrl: mcpUrl ?? DEFAULT_PROVIDERS[server]?.mcpUrl,
    };
    if (!provider.tokenUrl) {
      // Static bearer upstream (GitHub/Vercel/custom). No refresh path exists.
      // Expiry is reported by UpstreamManager as REAUTH_REQUIRED/STATIC_TOKEN_NO_REFRESH.
      return envToken;
    }

    // The effective owner comes from EXPLICIT options before any read: a
    // DSH-sourced env seed must be stored in (and read from) the dsh namespace.
    // With no explicit owner hint, search all owner namespaces (the record's
    // own `owner` is authoritative) instead of assuming the process default.
    const hasOwnerHint = grantOwner != null || source != null;
    const seedOwnerHint = hasOwnerHint ? this._grantOwner(null, { grantOwner, source }) : undefined;
    let rec = await this._load(server, { owner: seedOwnerHint });

    // ── STEP 1: env seed. KV is authoritative; env only seeds a MISSING record
    // or an explicitly different grant. A rotated record keeps its envSeed, so
    // ordinary cold starts never rebuild it.
    if (envToken && envRefresh && envClientId && rec?.envSeed !== envToken) {
      const expiresIn = Number(envExpiresIn ?? 0);
      const obtained = Number(envObtainedAt ?? 0);
      // Never invent a future expiry from an unknown authorization time.
      const expiresAt = obtained > 0 && expiresIn > 0 ? obtained + expiresIn * 1000 : 0;
      const seededOwner = this._grantOwner(null, { grantOwner, source });
      const seeded = {
        access_token: envToken,
        refresh_token: envRefresh,
        client_id: envClientId,
        client_secret: envClientSecret,
        expires_at: expiresAt,
        envSeed: envToken,
        owner: seededOwner,
        source: source ?? (seededOwner === 'gateway' ? 'gateway-oauth' : seededOwner),
        environment: this.environment,
        grantId: `${seededOwner}:${this.environment}:${server}`,
        // A shared grant is NEVER auto-refreshed by this gateway. Mark the
        // one-shot bootstrap attempt as already consumed so we don't even try.
        bootstrapped: seededOwner === 'gateway',
      };
      // Seed under the lease: two concurrent cold starts must not both seed
      // (and then both refresh) with the same env grant.
      const owner = await this._acquireLock(server);
      if (owner === null) {
        // Another worker is seeding/refreshing. Wait and adopt its record.
        await new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_MS));
        const fresh = await this._load(server);
        if (fresh?.access_token) return fresh.access_token;
        return envToken;
      }
      try {
        const latest = await this._load(server);
        if (latest?.access_token && latest.envSeed === envToken) {
          rec = latest; // already seeded by an earlier worker
        } else {
          await this._save(server, seeded);
          rec = seeded;
        }
      } finally {
        await this._releaseLock(server, owner);
      }
    }
    if (!rec || !rec.access_token) return envToken;

    // ── STEP 2: terminal grant guard. A dead grant is never retried. A NEW
    // env seed (different from the dead one) is the only legal recovery, and
    // that path is handled in STEP 1 (rec.envSeed !== envToken) above.
    if (rec.needsReauth || rec.status === REAUTH_REQUIRED) {
      if (!envToken || rec.envSeed === envToken) {
        this._status.set(server, {
          status: REAUTH_REQUIRED,
          reason: rec.reauthReason ?? REAUTH_REQUIRED,
          at: rec.needsReauthAt ?? Date.now(),
        });
        return rec.access_token;
      }
      // env changed: STEP 1 rebuilt the record, so clear the in-memory flag.
      this._status.delete(server);
      rec = await this._load(server) ?? rec;
    }

    const now = Date.now();
    const exp = Number(rec.expires_at ?? 0);
    const nearExpiry = exp > 0 && exp - REFRESH_SKEW_MS <= now;
    const shouldRefresh = force || nearExpiry || rec.bootstrapped === true;

    // ── GRANT OWNERSHIP GATE (the deepest root cause) ─────────────────────
    // DSH and the gateway are two independent OAuth clients that may hold the
    // SAME rotating refresh token (DSH exported grant -> gateway env seed).
    // Whoever refreshes first invalidates the other's copy. Locking/CAS inside
    // the gateway cannot see the other process. Therefore we DO NOT spend a
    // foreign/shared grant at all — we use its access token while it lives and
    // report SHARED_GRANT_REFRESH_FORBIDDEN when it dies.
    const ownerOpts = {
      grantOwner, source,
      legacy: Boolean(rec[UpstreamAuth.LEGACY_MARK]),
    };
    // R1 + environment-pollution guard (design doc §1.1): a record whose
    // `environment` does not match its key, or whose owner is not explicitly
    // gateway, is NEVER refreshed. It may still be used as an access token.
    const environmentMismatch = Boolean(rec.environment) && rec.environment !== this.environment;
    const grantIsForeign = environmentMismatch || !this._mayRefresh(rec, ownerOpts);
    if (grantIsForeign) {
      const owner = this._grantOwner(rec, ownerOpts);
      const reason = environmentMismatch
        ? `environment_mismatch:${rec.environment}!=${this.environment}`
        : SHARED_GRANT_REFRESH_FORBIDDEN;
      this._status.set(server, {
        status: REAUTH_REQUIRED,
        reason,
        at: Date.now(),
      });
      if (shouldRefresh) {
        captureEvent('upstream_auth', {
          server, phase: environmentMismatch ? 'environment_mismatch_refused' : 'shared_grant_refresh_refused',
          environment: this.environment, recordEnvironment: rec.environment ?? null,
          owner, source: rec.source ?? source ?? null,
        });
        console.error(`[upstream-auth] ${server} ${reason}: grant owner=${owner}; ` +
          'DSH 与网关不能共用同一个 rotating refresh token —— 使用长期 access token 或让网关独立 OAuth 授权');
      }
      return rec.access_token;
    }
    if (!shouldRefresh) return rec.access_token;
    if (!rec.refresh_token) {
      // Vercel (and any OAuth provider) issues a refresh token only when the
      // authorization request included offline_access. Without it there is no
      // recovery path — say so explicitly instead of looping on an expired
      // access token.
      this._status.set(server, {
        status: REAUTH_REQUIRED,
        reason: STATIC_TOKEN_NO_REFRESH,
        at: Date.now(),
      });
      captureEvent('upstream_auth', {
        server, phase: 'refresh_token_missing', environment: this.environment,
        requiredScopes: requiredScopes(server),
      });
      console.error(`[upstream-auth] ${server} ${STATIC_TOKEN_NO_REFRESH}: no refresh token stored; ` +
        `gateway-owned authorization must request [${requiredScopes(server).join(', ') || 'refresh scope'}] ` +
        'or use a long-lived token');
      return rec.access_token;
    }

    // ── STEP 3: refresh (coalesced within this instance, leased across
    // instances). R6: concurrent callers on the SAME UpstreamAuth share one
    // in-flight promise; cross-instance safety still uses the lease + CAS.
    return this._coalescedRefresh(server, () => this._refreshWithLease(server, {
      rec, provider, force, envToken, envRefresh, envClientId, envClientSecret,
      envExpiresIn, envObtainedAt,
    }));
  }

  /** R6: share one in-flight refresh per (environment, owner, server) key. */
  _coalescedRefresh(server, run) {
    const key = this._key(server);
    const existing = this._refreshPromises.get(key);
    if (existing) return existing;
    const promise = (async () => {
      try { return await run(); }
      finally { this._refreshPromises.delete(key); }
    })();
    this._refreshPromises.set(key, promise);
    return promise;
  }

  /** Distributed-lease refresh with all the existing safety guards. */
  async _refreshWithLease(server, {
    rec, provider, force, envToken, envRefresh, envClientId, envClientSecret,
    envExpiresIn, envObtainedAt,
  }) {
    // ── STEP 3: distributed lease with OWNER token. Backend failure FAILS
    // CLOSED — an unlocked refresh would consume a rotating grant twice.
    const owner = await this._acquireLock(server);
    if (owner === null) {
      // Someone else is refreshing. NEVER call the provider with our (stale)
      // refresh token, and NEVER report our old access token as a success.
      await new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_MS));
      const fresh = await this._load(server);
      if (fresh?.access_token && fresh.access_token !== rec.access_token &&
          !fresh.needsReauth) {
        return fresh.access_token;
      }
      return rec.access_token; // caller will still use it, but no grant was spent
    }

    let stopKeepalive = () => {};
    try {
      stopKeepalive = this._keepLeaseAlive(server, owner);

      // Re-read INSIDE the lease. Another worker may have refreshed between
      // our first read and lease acquisition. Only call the provider when the
      // record we are about to spend is still the one needing a refresh.
      const latest = await this._load(server) ?? rec;
      const latestExp = Number(latest.expires_at ?? 0);
      const latestNeedsRefresh = force || latest.bootstrapped === true ||
        (latestExp > 0 && latestExp - REFRESH_SKEW_MS <= Date.now());
      if (latest.access_token !== rec.access_token && !latestNeedsRefresh && !latest.needsReauth) {
        return latest.access_token; // winner already produced a fresh token
      }
      if (latest.needsReauth || latest.status === REAUTH_REQUIRED) {
        this._status.set(server, { status: REAUTH_REQUIRED, reason: latest.reauthReason ?? REAUTH_REQUIRED, at: latest.needsReauthAt ?? Date.now() });
        return latest.access_token;
      }

      const next = await this._refresh(server, latest, provider.tokenUrl);
      // We lost the lease mid-refresh: do not trust our result as authoritative.
      if (!(await this._ownsLease(server, owner))) {
        const winner = await this._load(server);
        if (winner?.access_token) return winner.access_token;
      }
      this._status.delete(server);
      console.error(`[upstream-auth] refreshed ${server} token (env=${this.environment}, expires_in=${next.expires_at ? Math.round((next.expires_at - Date.now()) / 1000) : '?'}s)`);
      return next.access_token;
    } catch (e) {
      const msg = String(e.message ?? '');
      const invalid = isInvalidGrant(e);
      console.error(`[upstream-auth] refresh ${server} failed (env=${this.environment}): ${msg}`);

      // "Lost update" recovery: only when the KV pair is stale relative to a
      // DIFFERENT env grant, and only after proving the env access token works
      // WITHOUT consuming the refresh grant.
      if (invalid && envToken && envRefresh && envClientId && rec.envSeed !== envToken) {
        const valid = await this._verifyToken(server, envToken, provider.mcpUrl);
        if (valid) {
          console.error(`[upstream-auth] ${server} KV record was stale; restoring from env token (no refresh)`);
          await this._save(server, {
            access_token: envToken,
            refresh_token: envRefresh,
            client_id: envClientId,
            client_secret: envClientSecret,
            expires_at: Number(envExpiresIn ?? 0) > 0 && Number(envObtainedAt ?? 0) > 0
              ? Number(envObtainedAt) + Number(envExpiresIn) * 1000 : 0,
            envSeed: envToken,
            bootstrapped: false,
          });
          this._status.delete(server);
          return envToken;
        }
      }

      if (invalid) {
        // ── CRITICAL (lead point #3): a LOSER must never mark the grant dead.
        // Only mark REAUTH_REQUIRED when the record actually in KV is the same
        // grant we just spent AND has no usable access token. If a winner
        // rotated it in the meantime, the family is alive — adopt its token.
        const winner = await this._load(server);
        const sameGrant = !winner || String(winner.refresh_token) === String(rec.refresh_token);
        // A DIFFERENT refresh token means a worker genuinely rotated the family
        // — the grant is alive and we must not mark it dead. Local expiry
        // timestamps are NOT proof of liveness (that was the Linear incident:
        // a "fresh" timestamp on an already-rejected token). So for the SAME
        // grant, invalid_grant is terminal regardless of expires_at.
        const winnerUsable = Boolean(winner?.access_token &&
          !winner.needsReauth &&
          String(winner.refresh_token) !== String(rec.refresh_token));
        if (sameGrant && !winnerUsable) {
          await this._markReauth(server, rec, REAUTH_REQUIRED);
          console.error(`[upstream-auth] ${server} ${REAUTH_REQUIRED}: grant invalid, automatic refresh stopped`);
        } else {
          captureEvent('upstream_auth', {
            server, phase: 'invalid_grant_loser', environment: this.environment,
            reason: 'KV winner rotated the grant; refusing to mark terminal',
          });
          if (winnerUsable) return winner.access_token;
        }
      } else {
        // The one-shot bootstrap attempt is consumed even on transient failure,
        // otherwise every call would re-attempt the refresh (the old loop).
        if (rec.bootstrapped === true) {
          await this._saveTerminal(server, rec.refresh_token, { bootstrapped: false });
        }
      }
      return rec.access_token;
    } finally {
      stopKeepalive();
      await this._releaseLock(server, owner);
    }
  }

  /**
   * Seed KV with initial tokens from env / OAuth callback (one-time setup).
   * Only writes when the namespace's record is absent OR an explicit override
   * is requested, so a re-authorization in another environment cannot be
   * silently overwritten by a cold start.
   */
  async seed(server, {
    accessToken, refreshToken, clientId, clientSecret, expiresIn, expiresAt, obtainedAt,
    grantOwner, source, grantId, environment, force = false,
  }) {
    const obtained = Number(obtainedAt ?? 0);
    const expires = Number(expiresIn ?? 0);
    const resolvedExpiry = Number.isFinite(expiresAt)
      ? expiresAt
      : (obtained > 0 && expires > 0 ? obtained + expires * 1000 : 0);
    if (!force && this.store.isConfigured()) {
      const existing = await this._load(server);
      if (existing?.refresh_token && existing.refresh_token !== refreshToken) {
        captureEvent('upstream_auth', {
          server, phase: 'seed_skipped', environment: this.environment,
          reason: 'existing grant in KV; pass force:true to replace',
        });
        return false;
      }
    }
    const owner = this._grantOwner(null, { grantOwner, source });
    await this._save(server, {
      access_token: accessToken,
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      expires_at: resolvedExpiry,
      envSeed: accessToken,
      owner,
      source: source ?? (owner === 'gateway' ? 'gateway-oauth' : owner),
      // R3: gateway-owned callback seeds carry the full grant identity.
      grantId: grantId ?? `${owner}:${environment ?? this.environment}:${server}`,
      environment: environment ?? this.environment,
      bootstrapped: false,
    });
    this._status.delete(server);
    return true;
  }
}
