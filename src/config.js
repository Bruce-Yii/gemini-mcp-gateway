/**
 * Config validation for upstream definitions.
 *
 * The gateway is deliberately generic about upstreams, so most onboarding
 * mistakes (typo in transport, missing URL, env var that is never set) would
 * otherwise only surface as a confusing runtime failure on a cold start.
 * `validateConfig()` fails fast with actionable messages and collects warnings
 * for things that do not block startup.
 */
import { defaultProvider } from './upstream-auth.js';

export const MODES = ['codemode', 'whitelist'];

const NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;
const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const TOP_LEVEL_KEYS = new Set(['servers', 'mode', 'maxWhitelistTools', 'maxCalls', 'maxResultChars']);
const SERVER_KEYS = new Set([
  'name', 'transport', 'url', 'command', 'args', 'env', 'headers',
  'tokenEnv', 'authScheme', 'refreshEnv', 'clientIdEnv', 'clientSecretEnv', 'expiresInEnv', 'obtainedAtEnv',
  'refreshUrl', 'allowTools', 'denyTools',
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

      if (server.authScheme !== undefined && !['bearer', 'basic'].includes(server.authScheme)) {
        issues.push(`${at}.authScheme must be "bearer" or "basic"`);
      }
      if (server.authScheme && !server.tokenEnv) {
        warnings.push(`${at}: authScheme is ignored without tokenEnv`);
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
