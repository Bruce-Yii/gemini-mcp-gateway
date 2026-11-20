/**
 * Upstream OAuth token lifecycle: auto-refresh Notion/Linear access tokens.
 *
 * Notion/Linear OAuth access tokens expire (8h / 24h) and refresh tokens ROTATE
 * on use. To avoid re-authorising by hand, we persist the current token pair in
 * Upstash KV under a fixed key per server. Before each MCP connection we:
 *   1. load the stored pair (or bootstrap from env on first run),
 *   2. if the access token is expired/near-expiry, call the provider's /token
 *      endpoint with the refresh token to get a fresh pair,
 *   3. write the rotated refresh token back to KV (atomic enough for our scale),
 *   4. return the current access token.
 *
 * If KV is unavailable, we fall back to the env token (which works until it
 * expires) — so local dev / first deploy still functions without KV.
 */
import { TokenStore } from './store.js';

const KEY_PREFIX = 'gmcgw:v1:upstream';
const REFRESH_SKEW_MS = 5 * 60 * 1000; // refresh 5 min before expiry

// Per-provider refresh endpoints. client_id is a public OAuth client id (not a secret).
const PROVIDERS = {
  notion: { token: 'https://mcp.notion.com/token' },
  linear: { token: 'https://mcp.linear.app/token' },
};

export class UpstreamAuth {
  constructor(options = {}) {
    this.store = options.store ?? new TokenStore();
    this._fetch = options.fetch ?? globalThis.fetch;
  }

  _key(server) { return `${KEY_PREFIX}:${server}`; }

  async _load(server) {
    if (!this.store.isConfigured()) return null;
    try {
      const raw = await this.store._command('get', this._key(server));
      if (!raw || typeof raw !== 'string') return null;
      return JSON.parse(raw);
    } catch { return null; }
  }

  async _save(server, record) {
    if (!this.store.isConfigured()) return;
    try {
      await this.store._command('set', this._key(server), JSON.stringify(record));
    } catch (e) {
      console.error(`[upstream-auth] failed to persist ${server} token: ${e.message}`);
    }
  }

  /** Acquire a short-lived refresh lock (SET NX EX). Returns true if acquired. */
  async _acquireLock(server, ttlSeconds = 30) {
    if (!this.store.isConfigured()) return true; // no KV: single-instance assumption
    try {
      const r = await this.store._command('set', this._key(server) + ':lock', '1', 'NX', 'EX', String(ttlSeconds));
      return r === 'OK' || r === 'ok' || r === true;
    } catch { return true; } // lock backend failure -> degrade to unlocked
  }

  async _releaseLock(server) {
    if (!this.store.isConfigured()) return;
    try { await this.store._command('del', this._key(server) + ':lock'); } catch {}
  }

  /**
   * Return a valid access token for `server`.
   * `envToken` is the bootstrap value from the environment variable (first run).
   * `envRefresh` / `envClientId` are only needed on first run to seed KV.
   */
  /** Call the provider's refresh endpoint for a fresh token pair. */
  async _refresh(server, rec) {
    const provider = PROVIDERS[server];
    const now = Date.now();
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: rec.refresh_token,
      client_id: rec.client_id,
    });
    const r = await this._fetch(provider.token, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const j = await r.json();
    if (!r.ok || !j.access_token) throw new Error(j.error ?? `HTTP ${r.status}`);
    const expiresIn = Number(j.expires_in ?? 0);
    const next = {
      access_token: j.access_token,
      refresh_token: j.refresh_token || rec.refresh_token, // rotate, fall back to old
      client_id: rec.client_id,
      expires_at: expiresIn > 0 ? now + expiresIn * 1000 : 0,
      envSeed: rec.envSeed, // keep the seed marker so cold starts don't rebuild
      // CRITICAL: clear the bootstrap flag. Leaving it set makes every cold
      // start call refresh again; with rotating refresh tokens that burns the
      // grant after a few requests and ends in invalid_grant / revoked grant.
      bootstrapped: false,
    };
    await this._save(server, next);
    return next;
  }

  async getAccessToken(server, { envToken, envRefresh, envClientId, envExpiresIn, envObtainedAt } = {}) {
    const provider = PROVIDERS[server];
    if (!provider) return envToken; // GitHub/Vercel use long-lived tokens; no refresh.

    let rec = await this._load(server);
    // Env-injected tokens are the source of truth. Rebuild the record from env
    // only when the env seed changes (i.e. a genuinely new token was deployed) —
    // a stale KV record must not be reused, but a rotated token we produced must
    // not be thrown away on every cold start either.
    if (envToken && envRefresh && envClientId && rec?.envSeed !== envToken) {
      const expiresIn = Number(envExpiresIn ?? 0);
      const obtained = Number(envObtainedAt ?? 0);
      const expiresAt = obtained > 0 && expiresIn > 0
        ? obtained + expiresIn * 1000
        : (expiresIn > 0 ? Date.now() + expiresIn * 1000 : 0);
      rec = {
        access_token: envToken,
        refresh_token: envRefresh,
        client_id: envClientId,
        expires_at: expiresAt,
        envSeed: envToken,
        bootstrapped: true,
      };
      await this._save(server, rec);
    }
    if (!rec || !rec.access_token) return envToken;

    const now = Date.now();
    const exp = Number(rec.expires_at ?? 0);
    const nearExpiry = exp > 0 && exp - REFRESH_SKEW_MS <= now;
    // A freshly bootstrapped token is treated as stale on first use: env-injected
    // tokens may already be expired, so verify by refreshing once when possible.
    const shouldRefresh = nearExpiry || rec.bootstrapped === true;
    if (!shouldRefresh) return rec.access_token;

    if (!rec.refresh_token) {
      console.error(`[upstream-auth] ${server} token needs refresh but no refresh token stored`);
      return rec.access_token;
    }
    // Serialize refreshes across Vercel instances. Rotating refresh tokens mean
    // two concurrent refreshes invalidate each other -> revoked grant.
    const locked = await this._acquireLock(server);
    if (!locked) {
      // Another instance is refreshing; wait briefly and re-read the shared token.
      await new Promise((r) => setTimeout(r, 1200));
      const fresh = await this._load(server);
      if (fresh?.access_token && fresh.access_token !== rec.access_token) return fresh.access_token;
      return rec.access_token;
    }
    try {
      // Re-read inside the lock: another instance may have already refreshed
      // between our first read and acquiring the lock.
      const latest = await this._load(server);
      if (latest?.access_token && latest.access_token !== rec.access_token &&
          Number(latest.expires_at ?? 0) - REFRESH_SKEW_MS > Date.now()) {
        return latest.access_token;
      }
      const next = await this._refresh(server, rec);
      console.error(`[upstream-auth] refreshed ${server} token (expires_in=${next.expires_at ? Math.round((next.expires_at - Date.now())/1000) : '?'}s)`);
      return next.access_token;
    } catch (e) {
      console.error(`[upstream-auth] refresh ${server} failed: ${e.message}; using stored token`);
      // If the stored grant is revoked/invalid (rotated-away or burned), rebuild
      // from the env-injected token pair once. This self-heals a poisoned KV
      // record without needing manual cache deletion.
      const invalid = /invalid_grant|revoked|expired/i.test(String(e.message ?? ''));
      if (invalid && envToken && envRefresh && envClientId) {
        console.error(`[upstream-auth] ${server} grant invalid; rebootstrapping from env`);
        const rebuilt = {
          access_token: envToken,
          refresh_token: envRefresh,
          client_id: envClientId,
          expires_at: 0,
          envSeed: envToken,
          bootstrapped: false, // do NOT force-refresh again -> avoid burning grant in a loop
        };
        await this._save(server, rebuilt);
        return envToken;
      }
      return rec.access_token;
    } finally {
      await this._releaseLock(server);
    }
  }

  /** Seed KV with initial tokens from env (used by a one-time setup script). */
  async seed(server, { accessToken, refreshToken, clientId, expiresIn, expiresAt }) {
    const now = Date.now();
    const resolvedExpiry = Number.isFinite(expiresAt)
      ? expiresAt
      : (expiresIn > 0 ? now + expiresIn * 1000 : 0);
    await this._save(server, {
      access_token: accessToken,
      refresh_token: refreshToken,
      client_id: clientId,
      expires_at: resolvedExpiry,
    });
  }
}
