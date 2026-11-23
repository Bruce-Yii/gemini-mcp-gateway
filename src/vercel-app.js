/**
 * Vercel HTTP entrypoint: route well-known / oauth / mcp requests.
 *
 * The /mcp route only performs bearer-token validation here; the actual MCP
 * protocol handling is delegated to createMcpRequestHandler() from server.js
 * (lead-owned), so tool registration is never duplicated.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TokenStore } from './store.js';
import { createOAuthHandlers, resolveBaseUrl } from './oauth.js';
import { UpstreamManager } from './upstreams.js';
import { createUpstreamOAuthHandlers } from './upstream-oauth.js';
import { createMcpRequestHandler } from './server.js';
import { startCapture, captureEnabled, captureSkip } from './capture.js';
import { BUILD } from './build-info.js';
import { validateConfig } from './config.js';

const DEFAULT_CONFIG_PATH = fileURLToPath(new URL('../config.example.json', import.meta.url));

/**
 * CIMD (Client ID Metadata Document) for the Vercel MCP upstream.
 * The AS fetches this public HTTPS URL and treats the document URL itself as
 * `client_id` — the no-review path for mcp.vercel.com (docs/eval/AUTH-PROVIDERS.md
 * §2.3). No secret is ever placed in the document: this is a public client with
 * PKCE S256 and `token_endpoint_auth_method: none`.
 *
 * The path is fixed so operators can set `clientId` to
 * `https://<gateway-domain>/.well-known/mcp-client.json` in config without
 * coordination. Override the document origin with `options.cimdBaseUrl` or
 * `PUBLIC_BASE_URL` / `VERCEL_URL` (same resolution as the OAuth metadata).
 */
export const CIMD_PATH = '/.well-known/mcp-client.json';

export function cimdClientId(options = {}, req) {
  const origin = options.cimdBaseUrl ? String(options.cimdBaseUrl).replace(/\/+$/, '')
    : resolveBaseUrl(options, req);
  return `${origin}${CIMD_PATH}`;
}

/** Build the public CIMD document. `client_id` MUST equal the fetch URL. */
export function buildCimdDocument({ clientId, redirectUri }) {
  if (!clientId || !clientId.startsWith('https://')) {
    throw new Error('CIMD client_id must be an absolute https URL');
  }
  if (!redirectUri || !redirectUri.startsWith('https://')) {
    throw new Error('CIMD redirect_uris must be absolute https URLs');
  }
  return {
    client_id: clientId,
    client_name: 'Gemini MCP Gateway (Vercel)',
    client_uri: clientId.replace(CIMD_PATH, '/'),
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    code_challenge_methods_supported: ['S256'],
    //RFC 8707 / SEP-2207: a gateway-owned grant needs a refresh token.
    scope: 'openid offline_access',
  };
}

function sendJson(res, status, payload, extraHeaders = {}) {
  if (res?.headersSent || res?.writableEnded || res?.ended) return;
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extraHeaders,
  };
  if (typeof res?.writeHead === 'function') {
    res.writeHead(status, headers);
  } else if (res) {
    res.statusCode = status;
    for (const [key, value] of Object.entries(headers)) res.setHeader?.(key, value);
  }
  res?.end?.(JSON.stringify(payload));
}

function sendNoContent(res, extraHeaders = {}) {
  if (res?.headersSent || res?.writableEnded || res?.ended) return;
  if (typeof res?.writeHead === 'function') res.writeHead(204, extraHeaders);
  else if (res) res.statusCode = 204;
  res?.end?.();
}

function normalizeConfig(value) {
  if (Array.isArray(value)) return { servers: value };
  if (value && typeof value === 'object') {
    return {
      servers: value.servers ?? [],
      maxWhitelistTools: value.maxWhitelistTools,
      mode: value.mode,
      maxCalls: value.maxCalls,
      maxResultChars: value.maxResultChars,
    };
  }
  throw new Error('gateway config must be an object with a servers array');
}

function parseUpstreamsJson(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('UPSTREAMS_JSON is not valid JSON');
  }
  return normalizeConfig(parsed);
}

async function loadConfig(options) {
  if (options.config !== undefined) return normalizeConfig(options.config);
  const inline = options.upstreamsJson ?? process.env.UPSTREAMS_JSON;
  if (inline) {
    const { config } = validateConfig(parseUpstreamsJson(inline));
    return config;
  }
  const configPath = options.configPath ?? process.env.GATEWAY_CONFIG ?? DEFAULT_CONFIG_PATH;
  const raw = await readFile(resolve(configPath), 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`gateway config ${configPath} is not valid JSON: ${error.message}`);
  }
  const { config } = validateConfig(parsed);
  return normalizeConfig(config);
}

/** Skip upstreams whose tokenEnv variable is unset so the app can boot. */
function availableServers(servers) {
  return (servers ?? []).filter((server) => {
    if (!server?.tokenEnv) return true;
    return Boolean(process.env[server.tokenEnv]);
  });
}

/**
 * @param {{
 *   store?: import('./store.js').TokenStore,
 *   mcpHandler?: (req:any,res:any)=>Promise<void>,
 *   upstreamManager?: import('./upstreams.js').UpstreamManager,
 *   baseUrl?: string,
 *   mcpUrl?: string,
 *   config?: object,
 *   configPath?: string,
 *   upstreamsJson?: string,
 * }} [options]
 * @returns {(req: any, res: any) => Promise<void>}
 */
export function createAppHandler(options = {}) {
  const store = options.store ?? new TokenStore();
  const oauth = createOAuthHandlers(store, options);
  let mcpHandlerPromise;
  let configPromise;
  const getConfig = () => {
    if (!configPromise) configPromise = loadConfig(options);
    return configPromise;
  };
  const upstreamOAuth = createUpstreamOAuthHandlers({ store, getConfig, options });

  async function getMcpHandler() {
    if (options.mcpHandler) return options.mcpHandler;
    if (!mcpHandlerPromise) {
      mcpHandlerPromise = (async () => {
        let upstreamManager = options.upstreamManager;
        let gatewayOptions = {};
        if (!upstreamManager) {
          const config = await getConfig();
          upstreamManager = new UpstreamManager(availableServers(config.servers));
          // Deferred init: no network call until the first authenticated /mcp hit.
          await upstreamManager.connect();
          gatewayOptions = {
            mode: config.mode ?? 'whitelist',
            maxWhitelistTools: config.maxWhitelistTools,
            maxCalls: config.maxCalls,
            maxResultChars: config.maxResultChars,
          };
        }
        return createMcpRequestHandler(upstreamManager, gatewayOptions);
      })().catch((error) => {
        mcpHandlerPromise = undefined;
        throw error;
      });
    }
    return mcpHandlerPromise;
  }

  function unauthorized(res, resourceMetadataUrl, reason) {
    const bodyError = reason === 'missing_token' ? 'invalid_request' : 'invalid_token';
    const description = `Bearer token ${reason}`;
    // OpenAI auth docs: ChatGPT only shows its OAuth linking UI when the tool
    // error carries `_meta["mcp/www_authenticate"]`, an array of strings that
    // include both `error` and `error_description`. This is ADDITIVE: the
    // existing WWW-Authenticate header and top-level error fields are unchanged,
    // so Gemini's byte-level contract is preserved.
    const challenge = `Bearer resource_metadata="${resourceMetadataUrl}", error="${bodyError}", error_description="${description}"`;
    sendJson(
      res,
      401,
      {
        error: bodyError,
        error_description: description,
        _meta: { 'mcp/www_authenticate': [challenge] },
      },
      { 'www-authenticate': `Bearer resource_metadata="${resourceMetadataUrl}"` },
    );
  }

  /**
   * Public build/deploy identity. Deliberately does NOT touch the token store or
   * connect upstreams: it must answer instantly on a cold start and must not
   * turn a health check into upstream traffic.
   *
   * buildHash is computed over the runtime source files by
   * scripts/write-build-info.mjs at build time, so `node
   * scripts/write-build-info.mjs --print` on a local checkout can be compared
   * with this endpoint to prove production runs the same code.
   */
  async function healthz(req, res) {
    let configInfo = { configLoaded: false };
    try {
      const config = await loadConfig(options);
      configInfo = {
        configLoaded: true,
        mode: config.mode ?? 'whitelist',
        servers: (config.servers ?? []).map((server) => server.name),
      };
    } catch (error) {
      configInfo = {
        configLoaded: false,
        configError: error instanceof Error ? error.message : String(error),
      };
    }
    const uptimeMs = Math.round(process.uptime() * 1000);
    sendJson(res, 200, {
      ok: true,
      commit: process.env.VERCEL_GIT_COMMIT_SHA || BUILD.commit,
      buildHash: BUILD.buildHash,
      builtAt: BUILD.builtAt,
      env: process.env.VERCEL_ENV || 'development',
      deploymentId: process.env.VERCEL_DEPLOYMENT_ID || null,
      uptimeMs,
      startedAt: new Date(Date.now() - uptimeMs).toISOString(),
      ...configInfo,
    });
  }

  /**
   * Buffer the raw request body before auth so every POST /mcp — including
   * 401/403 rejections — has a complete capture envelope. Returns the buffered
   * byte count (0 when nothing was read). Never throws: a read failure is
   * recorded by the route's capture.skip('body_buffer_failed').
   */
  async function bufferCaptureBody(req) {
    if (!captureEnabled() || req?.method !== 'POST' || req.__gatewayRawBody !== undefined) {
      return req?.__gatewayRawBody?.length ?? 0;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    req.__gatewayRawBody = Buffer.concat(chunks).toString('utf8');
    return req.__gatewayRawBody.length;
  }

  async function handleMcp(req, res) {
    // Body buffering is done centrally by appHandler before startCapture so
    // the [capture_ack] carries accurate requestBytes/bodyBuffered. This is a
    // no-op here when already buffered.
    await bufferCaptureBody(req);
    const metadataUrl = `${resolveBaseUrl(options, req)}/.well-known/oauth-protected-resource`;
    const authorization = typeof req?.headers?.authorization === 'string'
      ? req.headers.authorization
      : '';
    const match = /^Bearer\s+(.+)$/i.exec(authorization);
    if (!match) return unauthorized(res, metadataUrl, 'missing_token');

    const token = match[1].trim();
    if (!token) return unauthorized(res, metadataUrl, 'missing_token');

    let record;
    try {
      record = await store.getToken(token);
    } catch {
      return sendJson(res, 500, {
        error: 'server_error',
        error_description: 'token store is unavailable',
      });
    }
    if (!record) return unauthorized(res, metadataUrl, 'invalid_token');
    if (Number(record.expiresAt) && Number(record.expiresAt) <= Date.now()) {
      return unauthorized(res, metadataUrl, 'expired_token');
    }

    // FALLTHROUGH: the MCP protocol itself is handled by server.js.
    const handler = await getMcpHandler();
    await handler(req, res);
  }

  return async function appHandler(req, res) {
    const url = new URL(req?.url ?? '/', 'http://localhost');
    let pathname = url.pathname;
    if (pathname.length > 1) pathname = pathname.replace(/\/+$/, '');
    const method = typeof req?.method === 'string' ? req.method.toUpperCase() : 'GET';
    console.log(`[req] ${method} ${pathname}`);

    // P0: one capture per request, started at the outermost edge so 401/403,
    // 404, 405, body-read failures and MCP early returns are all covered. Only
    // POST /mcp produces an envelope; other routes get an explicit skip.
    if (pathname === '/mcp' && method === 'POST') {
      let requestBytes = 0;
      let bodyBuffered = false;
      let bodyBufferFailed = false;
      try {
        requestBytes = await bufferCaptureBody(req);
        bodyBuffered = req.__gatewayRawBody !== undefined;
      } catch {
        bodyBufferFailed = true;
        bodyBuffered = false;
      }
      const capture = startCapture(req, res, { path: pathname, bodyBuffered, requestBytes });
      if (bodyBufferFailed && capture?.skip) capture.skip('body_buffer_failed');
    } else if (pathname === '/mcp' && !req.__gatewayCaptureStarted) {
      // Non-POST /mcp probes (GET/DELETE/405) are not captured but are audited.
      captureSkip(req, { path: pathname, reason: 'non_post', detail: 'non-POST /mcp method' });
    }
    try {

      if (method === 'OPTIONS') {
        return sendNoContent(res, {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
          'access-control-allow-headers': 'Authorization, Content-Type, Mcp-Session-Id',
        });
      }

      if (method === 'GET' && pathname === '/healthz') {
        return healthz(req, res);
      }
      if (method === 'GET' && pathname === '/upstream/oauth/start') {
        return upstreamOAuth.start(req, res, url);
      }
      if (method === 'GET' && pathname === '/upstream/oauth/callback') {
        return upstreamOAuth.callback(req, res, url);
      }
      if (method === 'GET' && pathname === '/.well-known/oauth-authorization-server') {
        return oauth.metadata(req, res);
      }
      // Vercel MCP CIMD: public client metadata document. It MUST be fetchable
      // without auth, and `client_id` in the document is this exact URL.
      if (method === 'GET' && pathname === CIMD_PATH) {
        const clientId = cimdClientId(options, req);
        const redirectUri = `${resolveBaseUrl(options, req)}/upstream/oauth/callback`;
        return sendJson(res, 200, buildCimdDocument({ clientId, redirectUri }), {
          'cache-control': 'public, max-age=3600',
        });
      }
      if (
        method === 'GET' &&
        (pathname === '/.well-known/oauth-protected-resource' ||
          pathname === '/.well-known/oauth-protected-resource/mcp')
      ) {
        return oauth.protectedResource(req, res);
      }
      if (method === 'POST' && pathname === '/oauth/register') {
        return oauth.register(req, res);
      }
      if ((method === 'GET' || method === 'POST') && pathname === '/oauth/authorize') {
        return oauth.authorize(req, res);
      }
      if (method === 'POST' && pathname === '/oauth/token') {
        return oauth.token(req, res);
      }
      if (method === 'POST' && pathname === '/oauth/revoke') {
        return oauth.revoke(req, res);
      }
      if (pathname === '/mcp') {
        return handleMcp(req, res);
      }

      sendJson(res, 404, { error: 'not_found', error_description: `no route for ${pathname}` });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 500, { error: 'server_error', error_description: message });
    }
  };
}

export default createAppHandler;
