/**
 * Upstash Redis REST backed store for OAuth clients, authorization codes and
 * tokens. No extra npm dependency: every command is a plain fetch() POST.
 *
 * Security notes:
 *  - Redis keys are hashes of the secret, never the secret itself.
 *  - Stored values never contain the plaintext secret that indexes them; only
 *    a sha256 digest plus the caller's metadata is persisted.
 *  - Authorization codes use GETDEL so a code can be redeemed exactly once.
 */

import { createHash } from 'node:crypto';

const KEY_PREFIX = 'gmcgw:v1';

/** TTLs in seconds. 0 / omitted means no expiry. */
const TTL = Object.freeze({
  client: 0,
  code: 10 * 60,
  token: 60 * 60,
  refresh: 0,
});

/** sha256 of a secret, hex encoded. Shared with oauth.js for hash comparisons. */
export function hashSecret(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function isHash(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function cloneJson(value) {
  if (value === null || typeof value !== 'object') return {};
  return JSON.parse(JSON.stringify(value));
}

export class TokenStore {
  /**
   * @param {{url?: string, token?: string, fetch?: typeof globalThis.fetch}} [options]
   */
  constructor(options = {}) {
    this.url = options.url ?? process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL ?? '';
    this.token = options.token ?? process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN ?? '';
    this._fetch = options.fetch ?? globalThis.fetch;
  }

  /** Deployment-time check: are the KV environment variables present? */
  static isConfigured() {
    const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
    return Boolean(url && token);
  }

  /** Same check on an instance (handy when credentials were injected). */
  isConfigured() {
    return Boolean(this.url && this.token);
  }

  _assertConfigured() {
    if (!this.url || !this.token) {
      throw new Error(
        'TokenStore 未配置：请设置环境变量 KV_REST_API_URL / UPSTASH_REDIS_REST_URL 与 KV_REST_API_TOKEN / UPSTASH_REDIS_REST_TOKEN',
      );
    }
    if (typeof this._fetch !== 'function') {
      throw new Error('TokenStore 需要可用的 fetch 实现');
    }
  }

  /** Run a command via JSON request body (needed for EVAL scripts with special chars). */
  async _commandBody(args) {
    this._assertConfigured();
    const base = String(this.url).replace(/\/+$/, '');
    let response;
    try {
      response = await this._fetch(base, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(args),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Upstash Redis 请求失败: ${message}`);
    }
    const text = await response.text();
    if (!response.ok) throw new Error(`Upstash Redis HTTP ${response.status}: ${text.slice(0, 300)}`);
    let payload;
    try { payload = JSON.parse(text); } catch { return text.trim(); }
    if (payload?.error) throw new Error(`Upstash Redis 错误: ${payload.error}`);
    return payload?.result ?? payload;
  }

  /**
   * Compare-and-set: write `nextJson` to key only if its current value still
   * equals `expectedJson`. Returns true if the swap happened. This is the
   * fencing primitive that makes concurrent refreshes safe even if the lock
   * lease expires.
   */
  async compareAndSet(key, expectedJson, nextJson) {
    const script =
      "if redis.call('GET', KEYS[1]) == ARGV[1] then " +
      "redis.call('SET', KEYS[1], ARGV[2]); return 1 else return 0 end";
    const r = await this._commandBody(['EVAL', script, '1', key, expectedJson, nextJson]);
    return Number(r) === 1;
  }

  /**
   * Fencing CAS for a token record: write `nextJson` only if the current
   * record's refresh_token still equals `expectedRefresh`. Prevents a stale
   * refresh result from overwriting a newer token written by another worker.
   */
  async casToken(key, expectedRefresh, nextJson) {
    const script =
      "local cur = redis.call('GET', KEYS[1]); " +
      "if not cur then return 0 end; " +
      "local ok, obj = pcall(cjson.decode, cur); " +
      "if not ok then return 0 end; " +
      "if tostring(obj.refresh_token) ~= ARGV[1] then return 0 end; " +
      "redis.call('SET', KEYS[1], ARGV[2]); return 1";
    const r = await this._commandBody(['EVAL', script, '1', key, String(expectedRefresh), nextJson]);
    return Number(r) === 1;
  }

  _key(namespace, secret) {
    return this._keyFromHash(namespace, hashSecret(secret));
  }

  _keyFromHash(namespace, hash) {
    return `${KEY_PREFIX}:${namespace}:${hash}`;
  }

  /**
   * Issue a raw Redis command over the Upstash REST API. Path segments after
   * the command are the command arguments (Upstash's wire format).
   */
  async _command(...args) {
    this._assertConfigured();
    const base = String(this.url).replace(/\/+$/, '');
    const path = args.map((arg) => encodeURIComponent(String(arg))).join('/');
    let response;
    try {
      response = await this._fetch(`${base}/${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.token}` },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Upstash Redis 请求失败: ${message}`);
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Upstash Redis HTTP ${response.status}: ${detail.slice(0, 300)}`);
    }
    const text = await response.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = undefined;
    }
    if (payload && typeof payload === 'object') {
      if (payload.error) throw new Error(`Upstash Redis 错误: ${payload.error}`);
      return payload.result;
    }
    return text.trim();
  }

  /** Build the value object: strip plaintext secrets, keep digests/index. */
  _prepare(namespace, secret, record) {
    const value = cloneJson(record);
    if (namespace === 'client') {
      value.idHash = hashSecret(secret);
      // A client secret is optional (public clients need none). If one was
      // supplied, persist only its digest so token validation can compare.
      if (typeof value.client_secret === 'string') {
        value.clientSecretHash = hashSecret(value.client_secret);
        delete value.client_secret;
      }
      if (typeof value.clientSecret === 'string') {
        value.clientSecretHash = hashSecret(value.clientSecret);
        delete value.clientSecret;
      }
      return value;
    }
    // code / token / refresh: remove any field equal to the indexing secret.
    for (const key of Object.keys(value)) {
      if (typeof value[key] === 'string' && value[key] === secret) delete value[key];
    }
    value.tokenHash = hashSecret(secret);
    return value;
  }

  async _put(namespace, secret, record, ttlSeconds) {
    const value = JSON.stringify(this._prepare(namespace, secret, record));
    const args = ['set', this._key(namespace, secret), value];
    if (ttlSeconds && ttlSeconds > 0) args.push('EX', String(ttlSeconds));
    await this._command(...args);
  }

  async _get(namespace, secret) {
    const raw = await this._command('get', this._key(namespace, secret));
    if (raw === null || raw === undefined || raw === '') return null;
    if (typeof raw !== 'string') return raw;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  // ---- clients -----------------------------------------------------------

  async saveClient(clientId, record) {
    await this._put('client', clientId, record, TTL.client);
  }

  async getClient(clientId) {
    return this._get('client', clientId);
  }

  // ---- authorization codes ----------------------------------------------

  async saveCode(code, record) {
    await this._put('code', code, record, TTL.code);
  }

  /** Atomic get-and-delete: the same code can never be redeemed twice. */
  async takeCode(code) {
    const raw = await this._command('getdel', this._key('code', code));
    if (raw === null || raw === undefined || raw === '') return null;
    if (typeof raw !== 'string') return raw;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  // ---- upstream OAuth state (short-lived, single use) --------------------

  /** Persist the PKCE verifier + server for an upstream OAuth redirect. */
  async saveOAuthState(state, record) {
    await this._put('oauthstate', state, record, 10 * 60);
  }

  /** Atomic get-and-delete for the upstream OAuth callback. */
  async takeOAuthState(state) {
    const raw = await this._command('getdel', this._key('oauthstate', state));
    if (raw === null || raw === undefined || raw === '') return null;
    if (typeof raw !== 'string') return raw;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  // ---- access tokens -----------------------------------------------------

  async saveToken(token, record) {
    await this._put('token', token, record, TTL.token);
  }

  async getToken(token) {
    return this._get('token', token);
  }

  // ---- refresh tokens (never rotated) ------------------------------------

  async saveRefresh(refreshToken, record) {
    await this._put('refresh', refreshToken, record, TTL.refresh);
  }

  async getRefresh(refreshToken) {
    return this._get('refresh', refreshToken);
  }

  // ---- revocation --------------------------------------------------------

  /**
   * Delete a token (or a refresh token) and any linked counterpart. The link
   * is kept as a digest, so revocation never needs the plaintext secret.
   */
  async revokeToken(token) {
    const keys = [this._key('token', token), this._key('refresh', token)];
    const tokenRecord = await this._get('token', token);
    const refreshRecord = await this._get('refresh', token);
    if (isHash(tokenRecord?.refreshTokenHash)) {
      keys.push(this._keyFromHash('refresh', tokenRecord.refreshTokenHash));
    }
    if (isHash(refreshRecord?.accessTokenHash)) {
      keys.push(this._keyFromHash('token', refreshRecord.accessTokenHash));
    }
    const uniqueKeys = [...new Set(keys)];
    if (uniqueKeys.length > 0) await this._command('del', ...uniqueKeys);
  }
}

export default TokenStore;
