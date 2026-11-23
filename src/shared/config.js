/**
 * Config validation for upstream definitions.
 *
 * The gateway is deliberately generic about upstreams, so most onboarding
 * mistakes (typo in transport, missing URL, env var that is never set) would
 * otherwise only surface as a confusing runtime failure on a cold start.
 * `validateConfig()` fails fast with actionable messages and collects warnings
 * for things that do not block startup.
 */
import { defaultProvider, GRANT_OWNERS } from '../upstream/upstream-auth.js';

export const MODES = ['codemode', 'whitelist'];

/**
 * Explicit upstream auth modes. `static_bearer` means the credential is an
 * owner-created, non-rotating bearer token (Linear PAT, Notion static MCP
 * token, Vercel REST token for non-MCP upstreams). It MUST NOT enter the OAuth
 * refresh path — see `src/upstream-auth.js` and `src/upstreams.js`.
 * `oauth` (the default when refresh fields are present) uses the rotating
 * grant lifecycle owned by the gateway.
 */
export const AUTH_MODES = Object.freeze(['oauth', 'static_bearer']);
export const STATIC_BEARER = 'static_bearer';

const NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;
const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const TOP_LEVEL_KEYS = new Set(['servers', 'mode', 'maxWhitelistTools', 'maxCalls', 'maxResultChars']);
const SERVER_KEYS = new Set([
  'name', 'transport', 'url', 'command', 'args', 'env', 'headers',
  'tokenEnv', 'tokenHeader', 'authScheme', 'refreshEnv', 'clientIdEnv', 'clientSecretEnv', 'expiresInEnv', 'obtainedAtEnv',
  'refreshUrl', 'authorizeUrl', 'oauthScopes', 'oauthRedirectUri', 'allowTools', 'denyTools',
  // Explicit auth mode for gateway-owned credentials (see AUTH_MODES above).
  'authMode', 'staticBearer',
  // Gateway-owned DCR / CIMD client registration (batch 15 provider paths).
  // `dcr:true` asks upstream-oauth to POST registrationEndpoint at start and
  // persist the client in the v2 client namespace. `clientId` carries a CIMD
  // metadata-document URL (client_id == HTTPS URL) instead of an env var name.
  // `resource` is the RFC 8707 target sent on authorize/token requests.
  'dcr', 'registrationEndpoint', 'clientId', 'resource',
  // Grant ownership marking (AGENTS.md §2). An env-seeded rotating grant is
  // either DSH-exported (`dsh`, read-only, NEVER refreshed by the gateway) or
  // explicitly gateway-owned (`gateway`). Unset means unmarked → treated as
  // shared → never auto-refreshed (fail-safe; see upstream-auth._grantOwner).
  'grantOwner', 'grantOwnerEnv', 'grantSource', 'grantSourceEnv',
]);

export class ConfigError extends Error {
  constructor(issues) {
    super(`Invalid gateway config:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Accept either a `servers` array or a full config object. */
export function normalizeConfigValue(value) {
  if (Array.isArray(value)) return { servers: value };
  if (value && typeof value === 'object') return { ...value, servers: value.servers ?? [] };
  throw new ConfigError(['config must be an object with a "servers" array']);
}

function isStringRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.values(value).every((item) => typeof item === 'string');
}

/**
 * Validate and normalize a gateway config.
 * @param {unknown} value parsed JSON (object or servers array)
 * @param {{env?: Record<string, string|undefined>}} [options]
 * @returns {{config: object, warnings: string[]}}
 * @throws {ConfigError}
 */
export function validateConfig(value, { env = process.env } = {}) {
  const issues = [];
  const warnings = [];
  const config = normalizeConfigValue(value);

  for (const key of Object.keys(config)) {
    if (!TOP_LEVEL_KEYS.has(key)) warnings.push(`unknown top-level key "${key}" (ignored)`);
  }

  if (config.mode !== undefined && !MODES.includes(config.mode)) {
    issues.push(`mode must be one of ${MODES.join(', ')} (got ${JSON.stringify(config.mode)})`);
  }
  for (const [key, min] of [['maxWhitelistTools', 0], ['maxCalls', 1], ['maxResultChars', 1]]) {
    const item = config[key];
    if (item !== undefined && (!Number.isFinite(item) || item < min)) {
      issues.push(`${key} must be a number >= ${min}`);
    }
  }

  if (!Array.isArray(config.servers) || config.servers.length === 0) {
    issues.push('servers must be a non-empty array');
  } else {
    const seenNames = new Set();
    config.servers.forEach((server, index) => {
      const at = `servers[${index}]`;
      if (!server || typeof server !== 'object' || Array.isArray(server)) {
        issues.push(`${at} must be an object`);
        return;
      }

      for (const key of Object.keys(server)) {
        if (!SERVER_KEYS.has(key)) warnings.push(`${at}: unknown key "${key}" (ignored)`);
      }

      if (typeof server.name !== 'string' || !NAME_RE.test(server.name)) {
        issues.push(`${at}.name must match ${NAME_RE}`);
      } else if (seenNames.has(server.name)) {
        issues.push(`${at}.name duplicate "${server.name}"`);
      } else {
        seenNames.add(server.name);
      }

      if (!['http', 'stdio'].includes(server.transport)) {
        issues.push(`${at}.transport must be "http" or "stdio"`);
      } else if (server.transport === 'http') {
        if (typeof server.url !== 'string' || !isHttpUrl(server.url)) {
          issues.push(`${at}.url must be an absolute http(s) URL for http transport`);
        }
        if (server.command !== undefined) warnings.push(`${at}: "command" is ignored for http transport`);
      } else {
        if (typeof server.command !== 'string' || !server.command.trim()) {
          issues.push(`${at}.command is required for stdio transport`);
        }
        if (server.url !== undefined) warnings.push(`${at}: "url" is ignored for stdio transport`);
      }

      if (server.tokenHeader !== undefined
          && (typeof server.tokenHeader !== 'string' || !/^[A-Za-z0-9-]+$/.test(server.tokenHeader))) {
        issues.push(`${at}.tokenHeader must be an HTTP header name`);
      }
      if (server.tokenHeader && !server.tokenEnv) {
        warnings.push(`${at}: tokenHeader is ignored without tokenEnv`);
      }
      if (server.authScheme !== undefined
          && (typeof server.authScheme !== 'string' || !/^[A-Za-z][A-Za-z0-9-]*$/.test(server.authScheme))) {
        issues.push(`${at}.authScheme must be an HTTP auth scheme such as "bearer", "basic" or "Sentry-Bearer"`);
      }
      if (server.authScheme && !server.tokenEnv) {
        warnings.push(`${at}: authScheme is ignored without tokenEnv`);
      }

      // ── Explicit auth mode ─────────────────────────────────────────────
      // `authMode` opts a server into a credential lifecycle. Only
      // "oauth" (rotating, gateway-owned grant) and "static_bearer"
      // (owner-created, non-rotating token) are valid. Never infer this from
      // envToken alone — callers must state their intent explicitly.
      if (server.authMode !== undefined && !AUTH_MODES.includes(server.authMode)) {
        issues.push(`${at}.authMode must be one of ${AUTH_MODES.join(', ')} (got ${JSON.stringify(server.authMode)})`);
      }
      if (server.staticBearer !== undefined && typeof server.staticBearer !== 'boolean') {
        issues.push(`${at}.staticBearer must be a boolean`);
      }
      const isStatic = server.authMode === STATIC_BEARER || server.staticBearer === true;
      if (isStatic && server.authMode === 'oauth') {
        issues.push(`${at}: authMode "oauth" conflicts with staticBearer:true`);
      }
      if (isStatic) {
        if (!server.tokenEnv) {
          issues.push(`${at}: authMode "static_bearer" requires tokenEnv`);
        }
        // A static token has no rotating grant. Refusing refresh fields here
        // prevents a silent misconfiguration where the gateway would look for
        // a refresh token that can never exist.
        for (const key of ['refreshEnv', 'refreshUrl', 'authorizeUrl', 'clientIdEnv', 'clientSecretEnv', 'expiresInEnv', 'obtainedAtEnv', 'dcr', 'registrationEndpoint', 'clientId']) {
          if (server[key] !== undefined) {
            issues.push(`${at}: ${key} is not allowed with authMode "static_bearer" (static tokens are not refreshed)`);
          }
        }
      }

      // ── Grant ownership marking ─────────────────────────────────────────
      // Explicit attribution is required before a rotating grant may ever be
      // refreshed: `gateway` (gateway-owned OAuth), `dsh` (DSH-exported,
      // read-only) or `manual` (owner-provisioned static token). An unmarked
      // env seed is treated as shared and is NEVER auto-refreshed.
      if (server.grantOwner !== undefined
          && !GRANT_OWNERS.includes(String(server.grantOwner).toLowerCase())) {
        issues.push(`${at}.grantOwner must be one of ${GRANT_OWNERS.join(', ')} (got ${JSON.stringify(server.grantOwner)})`);
      }
      for (const key of ['grantOwnerEnv', 'grantSourceEnv']) {
        if (server[key] !== undefined && (typeof server[key] !== 'string' || !ENV_RE.test(server[key]))) {
          issues.push(`${at}.${key} must be an env var name`);
        }
      }
      if (server.grantSource !== undefined
          && (typeof server.grantSource !== 'string' || !server.grantSource.trim())) {
        issues.push(`${at}.grantSource must be a non-empty string`);
      }
      if (isStatic && server.grantOwner !== undefined
          && String(server.grantOwner).toLowerCase() !== 'manual') {
        warnings.push(`${at}: authMode "static_bearer" always persists owner=manual; grantOwner is ignored`);
      }
      if (!isStatic && server.refreshEnv !== undefined
          && server.grantOwner === undefined && server.grantOwnerEnv === undefined
          && server.grantSource === undefined && server.grantSourceEnv === undefined) {
        warnings.push(`${at}: env-seeded rotating grant has no grantOwner; it is treated as shared and will NEVER auto-refresh (mark "dsh" or "gateway" explicitly)`);
      }

      for (const key of ['tokenEnv', 'refreshEnv', 'clientIdEnv', 'clientSecretEnv', 'expiresInEnv', 'obtainedAtEnv']) {
        const item = server[key];
        if (item !== undefined && (typeof item !== 'string' || !ENV_RE.test(item))) {
          issues.push(`${at}.${key} must be an environment variable name`);
        }
      }

      if (server.refreshUrl !== undefined && !isHttpUrl(server.refreshUrl)) {
        issues.push(`${at}.refreshUrl must be an absolute http(s) URL`);
      }
      if (server.refreshEnv && !server.tokenEnv) {
        issues.push(`${at}: refreshEnv requires tokenEnv`);
      }
      if (server.refreshEnv && !server.refreshUrl && !defaultProvider(server.name)) {
        issues.push(`${at}: refreshEnv requires refreshUrl for non-built-in providers`);
      }

      if (server.authorizeUrl !== undefined) {
        if (!isHttpUrl(server.authorizeUrl)) {
          issues.push(`${at}.authorizeUrl must be an absolute http(s) URL`);
        }
        // A client_id can come from an env var (static client), an inline CIMD
        // metadata-document URL, or gateway-driven DCR. Require at least one.
        if (!server.clientIdEnv && !server.clientId && server.dcr !== true) {
          issues.push(`${at}.authorizeUrl requires clientIdEnv, clientId (CIMD URL) or dcr:true`);
        }
        if (!server.refreshUrl) issues.push(`${at}.authorizeUrl requires refreshUrl (the token endpoint)`);
      }
      if (server.oauthRedirectUri !== undefined && !isHttpUrl(server.oauthRedirectUri)) {
        issues.push(`${at}.oauthRedirectUri must be an absolute http(s) URL`);
      }

      // ── Gateway-owned DCR / CIMD client identity ────────────────────────
      if (server.dcr !== undefined && typeof server.dcr !== 'boolean') {
        issues.push(`${at}.dcr must be a boolean`);
      }
      if (server.registrationEndpoint !== undefined && !isHttpUrl(server.registrationEndpoint)) {
        issues.push(`${at}.registrationEndpoint must be an absolute http(s) URL`);
      }
      if (server.dcr === true && !server.registrationEndpoint) {
        issues.push(`${at}: dcr:true requires registrationEndpoint (the AS /register URL)`);
      }
      if (server.dcr === true && server.clientIdEnv) {
        issues.push(`${at}: dcr:true must not be combined with clientIdEnv (DCR owns the client id)`);
      }
      // A CIMD client_id is a public HTTPS URL that serves the metadata
      // document; a bare opaque string is NOT a CIMD client_id.
      if (server.clientId !== undefined) {
        if (typeof server.clientId !== 'string' || !isHttpUrl(server.clientId) || !server.clientId.startsWith('https://')) {
          issues.push(`${at}.clientId must be an absolute https URL (CIMD metadata document)`);
        }
        if (server.clientIdEnv) {
          issues.push(`${at}: clientId and clientIdEnv are mutually exclusive`);
        }
      }
      if (server.resource !== undefined && !isHttpUrl(server.resource)) {
        issues.push(`${at}.resource must be an absolute http(s) URL (RFC 8707 target)`);
      }
      if (server.oauthScopes !== undefined
          && (!Array.isArray(server.oauthScopes) || server.oauthScopes.some((scope) => typeof scope !== 'string' || !scope))) {
        issues.push(`${at}.oauthScopes must be an array of non-empty strings`);
      }

      for (const key of ['allowTools', 'denyTools']) {
        const list = server[key];
        if (list !== undefined && (!Array.isArray(list) || list.some((item) => typeof item !== 'string' || !item))) {
          issues.push(`${at}.${key} must be an array of non-empty strings`);
        }
      }
      if ((server.allowTools?.length ?? 0) > 0 && (server.denyTools?.length ?? 0) > 0) {
        warnings.push(`${at}: both allowTools and denyTools are set; denyTools is applied first`);
      }

      if (server.headers !== undefined && !isStringRecord(server.headers)) {
        issues.push(`${at}.headers must be an object with string values`);
      }
      if (server.env !== undefined && !isStringRecord(server.env)) {
        issues.push(`${at}.env must be an object with string values`);
      }
      if (server.args !== undefined && (!Array.isArray(server.args) || server.args.some((arg) => typeof arg !== 'string'))) {
        issues.push(`${at}.args must be an array of strings`);
      }

      if (server.tokenEnv && !env[server.tokenEnv]) {
        warnings.push(`${at}: ${server.tokenEnv} is not set in this environment; the upstream will be skipped`);
      }
    });
  }

  if (issues.length > 0) throw new ConfigError(issues);
  return { config, warnings };
}
