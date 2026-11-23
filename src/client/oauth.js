/**
 * OAuth 2.1 authorization server routes for the Gemini MCP gateway.
 *
 * Implements the Gemini hard requirements: DCR with 6+ Google-hosted redirect
 * URIs, byte-preserving ~1400-char state, PKCE S256, non-rotating refresh
 * tokens and well-known metadata that returns 200 directly (no 404 probing).
 *
 * ChatGPT connector support is additive and strictly opt-in: the redirect
 * allowlist includes OpenAI's documented callbacks, RFC 9207 `iss` is sent on
 * every authorization response, and `ALLOW_DCR_FOR_CHATGPT=1` carves out a
 * ChatGPT-only DCR path that never reuses the Gemini locked client.
 *
 * Claude.ai web connector support is equally narrow: the shared redirect
 * allowlist accepts Anthropic's single documented callback
 * `https://claude.ai/api/mcp/auth_callback` and nothing else on claude.ai.
 * Claude callbacks use their own client platform and never attach to the
 * Gemini locked client. In LOCKED mode DCR stays disabled unless
 * `ALLOW_DCR_FOR_CLAUDE=1` is explicitly set; the Gemini default is unchanged.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { hashSecret } from '../shared/store.js';

const MAX_BODY_BYTES = 1024 * 1024;
const CODE_TTL_MS = 10 * 60 * 1000;
const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;

const SCOPES = ['mcp', 'openid', 'email', 'profile', 'offline_access'];
const RESPONSE_TYPES = ['code'];
const GRANT_TYPES = ['authorization_code', 'refresh_token'];

const GOOGLE_REDIRECT_HOSTS = new Set([
  'oauth-redirect.googleusercontent.com',
  'oauth-redirect-sandbox.googleusercontent.com',
  'oauth-redirect-test.googleusercontent.com',
]);

// ChatGPT's stable callback (used when the AS publishes RFC 9207 issuer
// identification) and its callback-ID-specific form. Both are documented by
// OpenAI; no other host or path shape is accepted.
const CHATGPT_STABLE_REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect';
const CHATGPT_REDIRECT_PREFIX = 'https://chatgpt.com/connector/oauth/';
const CHATGPT_CALLBACK_ID = /^[A-Za-z0-9_-]+$/;

// Claude.ai's web connector publishes exactly one OAuth callback. Host and path
// are matched strictly: no other Claude host, path, port, userinfo or query
// (including `?`/`#`) is accepted anywhere in the OAuth flow.
const CLAUDE_REDIRECT_HOST = 'claude.ai';
const CLAUDE_REDIRECT_PATH = '/api/mcp/auth_callback';

/** True when the URI is a Google relay, a documented ChatGPT callback, or Claude's callback. */
export function isAllowedRedirectUri(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  if (GOOGLE_REDIRECT_HOSTS.has(host)) {
    return url.pathname.startsWith('/r/') || url.pathname.startsWith('/a/');
  }
  if (host === 'chatgpt.com') {
    if (value === CHATGPT_STABLE_REDIRECT) return true;
    if (!value.startsWith(CHATGPT_REDIRECT_PREFIX)) return false;
    const callbackId = value.slice(CHATGPT_REDIRECT_PREFIX.length);
    return Boolean(callbackId) && CHATGPT_CALLBACK_ID.test(callbackId);
  }
  if (host === CLAUDE_REDIRECT_HOST) {
    return url.pathname === CLAUDE_REDIRECT_PATH &&
      url.port === '' && url.search === '' && url.hash === '';
  }
  return false;
}

/** Backwards-compatible name kept for existing callers/tests. */
export const isValidGoogleRedirectUri = isAllowedRedirectUri;

/** True when the URI is one of ChatGPT's two documented OAuth callbacks. */
export function isChatgptRedirectUri(value) {
  return typeof value === 'string' && isAllowedRedirectUri(value) &&
    new URL(value).hostname.toLowerCase() === 'chatgpt.com';
}

/** True when the URI is Claude.ai's single documented OAuth callback. */
export function isClaudeRedirectUri(value) {
  return typeof value === 'string' && isAllowedRedirectUri(value) &&
    new URL(value).hostname.toLowerCase() === CLAUDE_REDIRECT_HOST;
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function str(value) {
  return typeof value === 'string' ? value : '';
}

function trimTrailingSlash(value) {
  return String(value).replace(/\/+$/, '');
}

function hostFromRequest(req) {
  const headers = req?.headers ?? {};
  const rawHost = headers['x-forwarded-host'] ?? headers.host;
  if (!rawHost) return null;
  // First value only: proxy chains may append `, proxy.example`.
  const host = String(rawHost).split(',')[0].trim();
  if (!host || host.length > 255) return null;
  // Strict host[:port] only — a malicious value must never inject a path,
  // credentials or a second origin into issuer/resource/CIMD documents.
  if (!/^(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+)(:\d{1,5})?$/.test(host)) return null;
  const rawProto = String(headers['x-forwarded-proto'] ?? '').split(',')[0].trim().toLowerCase();
  const isLoopback = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host);
  const proto = rawProto === 'http' || rawProto === 'https' ? rawProto : (isLoopback ? 'http' : 'https');
  return `${proto}://${host}`;
}

/**
 * Resolve the externally visible base URL.
 *
 * Priority: explicit `options.baseUrl` > the origin the client actually used >
 * `PUBLIC_BASE_URL` > `VERCEL_URL` > localhost.
 *
 * Origin consistency (2026-11-24): the AS `issuer`, the protected-resource
 * `resource`/`authorization_servers`, the 401 `resource_metadata` URL and the
 * CIMD `client_id` must ALL describe the same origin the client is talking to.
 * Letting a deployment-wide `PUBLIC_BASE_URL` win over the request host used to
 * emit a second origin (e.g. a `*-yu-ac3a.vercel.app` host) into every one of
 * those documents even when the client connected via the documented domain;
 * strict clients reject that as a cross-origin/mismatched resource. The request
 * host therefore wins; `PUBLIC_BASE_URL` remains the canonical fallback for
 * host-less callers (CLI, tests, health probes).
 */
export function resolveBaseUrl(options = {}, req) {
  if (options.baseUrl) return trimTrailingSlash(options.baseUrl);
  const requestOrigin = hostFromRequest(req);
  if (requestOrigin) return requestOrigin;
  if (process.env.PUBLIC_BASE_URL) return trimTrailingSlash(process.env.PUBLIC_BASE_URL);
  if (process.env.VERCEL_URL) return `https://${trimTrailingSlash(process.env.VERCEL_URL)}`;
  return 'http://localhost:3000';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/'/g, '&#39;');
}

/** Append query params while preserving the state string byte-for-byte. */
function buildRedirectUrl(base, params) {
  const parts = String(base).split('#');
  const fragment = parts.length > 1 ? `#${parts.slice(1).join('#')}` : '';
  const withoutFragment = parts[0];
  const query = params
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&');
  if (!query) return `${withoutFragment}${fragment}`;
  const separator = withoutFragment.includes('?')
    ? (withoutFragment.endsWith('?') || withoutFragment.endsWith('&') ? '' : '&')
    : '?';
  return `${withoutFragment}${separator}${query}${fragment}`;
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function respond(res, status, headers, body) {
  if (res?.headersSent || res?.writableEnded || res?.ended) return;
  const all = { 'cache-control': 'no-store', ...headers };
  if (typeof res?.writeHead === 'function') {
    res.writeHead(status, all);
  } else {
    if (res) {
      res.statusCode = status;
      for (const [key, value] of Object.entries(all)) res.setHeader?.(key, value);
    }
  }
  res?.end?.(body);
}

function sendJson(res, status, payload, extra = {}) {
  respond(
    res,
    status,
    { 'content-type': 'application/json; charset=utf-8', ...extra },
    JSON.stringify(payload),
  );
}

function sendHtml(res, status, markup, extra = {}) {
  respond(
    res,
    status,
    {
      'content-type': 'text/html; charset=utf-8',
      // Deliberately NO Content-Security-Policy here: a `form-action 'self'`
      // directive breaks Google's relay redirect after the consent POST.
      'x-content-type-options': 'nosniff',
      ...extra,
    },
    markup,
  );
}

function oauthError(res, status, error, description) {
  console.log(`[oauth-error] ${status} ${error}: ${description}`);
  sendJson(res, status, { error, error_description: description });
}

async function readRawBody(req) {
  if (!req) return '';
  if (Buffer.isBuffer(req.body)) { req.__gatewayRawBody = req.body.toString('utf8'); return req.body.toString('utf8'); }
  if (typeof req.body === 'string') { req.__gatewayRawBody = req.body; return req.body; }
  if (req.body && typeof req.body === 'object') { req.__gatewayRawBody = JSON.stringify(req.body); return req.body; }

  const chunks = [];
  let size = 0;
  const push = (chunk) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(buffer);
  };

  if (typeof req[Symbol.asyncIterator] === 'function') {
    for await (const chunk of req) push(chunk);
  } else if (typeof req.on === 'function') {
    await new Promise((resolveRead, rejectRead) => {
      req.on('data', (chunk) => {
        try {
          push(chunk);
        } catch (error) {
          rejectRead(error);
        }
      });
      req.on('end', resolveRead);
      req.on('error', rejectRead);
    });
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  req.__gatewayRawBody = raw;
  return raw;
}

async function readParams(req) {
  const raw = await readRawBody(req);
  if (raw && typeof raw === 'object') return raw;
  const contentType = str(req?.headers?.['content-type']);
  if (contentType.includes('application/json')) {
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  }
  return Object.fromEntries(new URLSearchParams(raw || ''));
}

function normalizeRedirects(params) {
  let list = params.redirect_uris ?? params.redirect_uri ?? [];
  if (typeof list === 'string') list = [list];
  if (!Array.isArray(list)) return [];
  return [...new Set(list.filter((uri) => typeof uri === 'string' && uri.length > 0))];
}

function clientRedirects(client) {
  const list = client?.redirectUris ?? client?.redirect_uris ?? [];
  return Array.isArray(list) ? list : [];
}

function isRegisteredRedirect(client, uri) {
  return Boolean(uri) && clientRedirects(client).includes(uri);
}

/**
 * LOCKED mode normally disables DCR. When ALLOW_DCR_FOR_CHATGPT=1 we carve out
 * a single narrow exception: registrations whose redirects are ALL documented
 * ChatGPT callbacks and whose declared metadata identifies an OpenAI client.
 * Arbitrary hosts and unrecognised clients are still rejected.
 */
function isChatgptClientRegistration(params, redirects) {
  if (redirects.length === 0 || !redirects.every(isChatgptRedirectUri)) return false;
  const name = str(params.client_name).toLowerCase();
  const metadataUrl = str(params.client_uri).toLowerCase();
  if (name.includes('chatgpt') || name.includes('openai')) return true;
  if (metadataUrl.includes('chatgpt.com') || metadataUrl.includes('openai.com')) return true;
  return str(params.token_endpoint_auth_method) === 'none' ||
    str(params.token_endpoint_auth_method) === 'private_key_jwt';
}

/**
 * Claude's DCR path is deliberately as narrow as ChatGPT's: every redirect must
 * be the single documented Claude callback, and the declared metadata must
 * identify an Anthropic/Claude client. It never enables arbitrary redirects.
 */
function isClaudeClientRegistration(params, redirects) {
  if (redirects.length === 0 || !redirects.every(isClaudeRedirectUri)) return false;
  const name = str(params.client_name).toLowerCase();
  const metadataUrl = str(params.client_uri).toLowerCase();
  if (name.includes('claude') || name.includes('anthropic')) return true;
  if (metadataUrl.includes('claude.ai') || metadataUrl.includes('anthropic.com')) return true;
  return str(params.token_endpoint_auth_method) === 'none' ||
    str(params.token_endpoint_auth_method) === 'private_key_jwt';
}

function consentPage({ clientName, clientId, redirectUri, state, codeChallenge, scope, resource }) {
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>Authorize Gemini MCP Gateway</title></head><body>',
    '<h1>Authorize access</h1>',
    `<p>Client <strong>${escapeHtml(clientName || clientId)}</strong> requests access to the Gemini MCP gateway.</p>`,
    '<form method="post" action="/oauth/authorize">',
    `<input type="hidden" name="client_id" value="${escapeHtml(clientId)}">`,
    `<input type="hidden" name="redirect_uri" value="${escapeHtml(redirectUri)}">`,
    `<input type="hidden" name="state" value="${escapeHtml(state)}">`,
    `<input type="hidden" name="code_challenge" value="${escapeHtml(codeChallenge)}">`,
    '<input type="hidden" name="code_challenge_method" value="S256">',
    `<input type="hidden" name="scope" value="${escapeHtml(scope)}">`,
    `<input type="hidden" name="resource" value="${escapeHtml(resource)}">`,
    '<input type="hidden" name="response_type" value="code">',
    '<button type="submit">Approve</button>',
    '</form></body></html>',
  ].join('\n');
}

function redirectPage(location) {
  const escaped = escapeHtml(location);
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    `<meta http-equiv="refresh" content="0;url=${escaped}">`,
    '<title>Redirecting</title></head><body>',
    '<p>Authorization complete. Redirecting…</p>',
    `<a href="${escaped}">Continue</a>`,
    '</body></html>',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// handler factory
// ---------------------------------------------------------------------------

/**
 * @param {import('./store.js').TokenStore} store
 * @param {{baseUrl?: string, mcpUrl?: string}} [options]
 */
export function createOAuthHandlers(store, options = {}) {
  const baseUrl = (req) => resolveBaseUrl(options, req);
  const mcpUrl = (req) => options.mcpUrl ?? `${baseUrl(req)}/mcp`;

  // When ALLOWED_CLIENT_ID is set, only this pre-registered client may connect.
  // DCR is disabled so a random person with the URL cannot self-register.
  const ALLOWED_CLIENT_ID = options.allowedClientId ?? process.env.ALLOWED_CLIENT_ID ?? '';
  const ALLOWED_CLIENT_SECRET = options.allowedClientSecret ?? process.env.ALLOWED_CLIENT_SECRET ?? '';
  const LOCKED = Boolean(ALLOWED_CLIENT_ID);
  // Explicit opt-in ONLY: production has ALLOWED_CLIENT_ID set, so DCR is off by
  // default. Setting ALLOW_DCR_FOR_CHATGPT=1 opens a narrow ChatGPT-only DCR
  // carve-out; Gemini's pre-registered client and its secret are untouched.
  const ALLOW_DCR_FOR_CHATGPT = options.allowDcrForChatgpt ?? ['1', 'true', 'yes'].includes(
    String(process.env.ALLOW_DCR_FOR_CHATGPT ?? '').toLowerCase(),
  );
  // Same explicit opt-in discipline for Claude. LOCKED mode (the production
  // default) still rejects ALL DCR without the matching flag.
  const ALLOW_DCR_FOR_CLAUDE = options.allowDcrForClaude ?? ['1', 'true', 'yes'].includes(
    String(process.env.ALLOW_DCR_FOR_CLAUDE ?? '').toLowerCase(),
  );

  function clientAllowed(clientId, clientSecret, checkSecret = false) {
    if (!LOCKED) return true;
    if (str(clientId) !== ALLOWED_CLIENT_ID) return false;
    // Only enforce the secret at token exchange / refresh, where the client
    // actually supplies it. The authorize page has no client_secret yet.
    if (checkSecret && ALLOWED_CLIENT_SECRET && !safeEqual(str(clientSecret), ALLOWED_CLIENT_SECRET)) return false;
    return true;
  }

  /** A DCR-registered ChatGPT public client, only when explicitly enabled. */
  async function isChatgptDcrClient(clientId) {
    if (!LOCKED || !ALLOW_DCR_FOR_CHATGPT || !clientId) return false;
    const client = await store.getClient(str(clientId));
    return client?.chatgptDcr === true;
  }

  /** A DCR-registered Claude public client, only when explicitly enabled. */
  async function isClaudeDcrClient(clientId) {
    if (!LOCKED || !ALLOW_DCR_FOR_CLAUDE || !clientId) return false;
    const client = await store.getClient(str(clientId));
    return client?.claudeDcr === true;
  }

  async function metadata(req, res) {
    const base = baseUrl(req);
    const doc = {
      issuer: base,
      // RFC 9207: we append `iss` to EVERY authorization response, success and
      // error alike. Stable issuer identifier must match authorization_servers.
      authorization_response_iss_parameter_supported: true,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      revocation_endpoint: `${base}/oauth/revoke`,
      response_types_supported: [...RESPONSE_TYPES],
      grant_types_supported: [...GRANT_TYPES],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
      scopes_supported: [...SCOPES],
    };
    // Always advertise registration_endpoint. Gemini's client requires it even
    // when pre-registered credentials are used; hiding it breaks connect.
    doc.registration_endpoint = `${base}/oauth/register`;
    sendJson(res, 200, doc);
  }

  async function protectedResource(req, res) {
    sendJson(res, 200, {
      resource: mcpUrl(req),
      authorization_servers: [baseUrl(req)],
      bearer_methods_supported: ['header'],
      scopes_supported: [...SCOPES],
    });
  }

  async function register(req, res) {
    let params;
    try {
      params = await readParams(req);
    } catch {
      return oauthError(res, 400, 'invalid_request', 'invalid registration body');
    }

    // Preserve the legacy locked behaviour byte-for-byte: with no explicit
    // opt-in, DCR is rejected with 403 *before* any redirect validation.
    const redirects = normalizeRedirects(params);
    const chatgptDcr = isChatgptClientRegistration(params, redirects);
    const claudeDcr = isClaudeClientRegistration(params, redirects);
    if (LOCKED && !(ALLOW_DCR_FOR_CHATGPT && chatgptDcr) && !(ALLOW_DCR_FOR_CLAUDE && claudeDcr)) {
      return oauthError(res, 403, 'invalid_request', 'dynamic client registration is disabled');
    }
    if (redirects.length === 0) {
      return oauthError(res, 400, 'invalid_redirect_uri', 'at least one redirect_uri is required');
    }
    // Single shared validator for DCR, authorize and token: Google relays,
    // documented ChatGPT callbacks and Claude's callback only — never an
    // arbitrary host.
    const invalid = redirects.find((uri) => !isAllowedRedirectUri(uri));
    if (invalid) {
      return oauthError(res, 400, 'invalid_redirect_uri', 'redirect_uri host or path is not allowed');
    }
    // Never mix platforms in one registration: a ChatGPT client must not carry
    // a Claude callback (or vice versa), and neither may carry a Google relay.
    const hasChatgpt = redirects.some(isChatgptRedirectUri);
    const hasClaude = redirects.some(isClaudeRedirectUri);
    const hasGoogle = redirects.some((uri) => !isChatgptRedirectUri(uri) && !isClaudeRedirectUri(uri));
    if ((Number(hasChatgpt) + Number(hasClaude) + Number(hasGoogle)) > 1) {
      return oauthError(res, 400, 'invalid_redirect_uri', 'redirect_uris must belong to one platform');
    }
    if (!LOCKED && !chatgptDcr && redirects.some(isChatgptRedirectUri)) {
      return oauthError(res, 400, 'invalid_redirect_uri', 'ChatGPT clients must be identified explicitly');
    }
    if (!LOCKED && !claudeDcr && redirects.some(isClaudeRedirectUri)) {
      return oauthError(res, 400, 'invalid_redirect_uri', 'Claude clients must be identified explicitly');
    }

    // Deterministic client id: same redirect set always maps to the same client.
    const canonical = [...redirects].sort().join('\n');
    const clientId = `gmc_${createHash('sha256').update(canonical).digest('hex').slice(0, 32)}`;
    const publicClient = chatgptDcr || claudeDcr;
    const authMethod = str(params.token_endpoint_auth_method) ||
      (publicClient ? 'none' : 'client_secret_post');
    const providedSecret = str(params.client_secret);
    const record = {
      clientId,
      clientName: str(params.client_name) || (chatgptDcr ? 'ChatGPT' : claudeDcr ? 'Claude' : 'Google'),
      redirectUris: redirects,
      responseTypes: [...RESPONSE_TYPES],
      grantTypes: [...GRANT_TYPES],
      tokenEndpointAuthMethod: authMethod,
      chatgptDcr,
      claudeDcr,
      // Platform isolation: never reuse/overwrite the Gemini locked client.
      platform: chatgptDcr ? 'chatgpt' : claudeDcr ? 'claude' : 'gemini',
      createdAt: Date.now(),
    };
    if (providedSecret) record.client_secret = providedSecret;

    await store.saveClient(clientId, record);

    sendJson(res, 200, {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: record.clientName,
      redirect_uris: redirects,
      response_types: [...RESPONSE_TYPES],
      grant_types: [...GRANT_TYPES],
      token_endpoint_auth_method: authMethod,
      scope: SCOPES.join(' '),
    });
  }

  async function authorize(req, res) {
    const method = str(req?.method).toUpperCase();
    let params;
    try {
      if (method === 'POST') {
        params = await readParams(req);
      } else {
        const url = new URL(req?.url ?? '/', 'http://localhost');
        params = Object.fromEntries(url.searchParams.entries());
      }
    } catch {
      return oauthError(res, 400, 'invalid_request', 'invalid authorize parameters');
    }

    const clientId = str(params.client_id);
    const redirectUri = str(params.redirect_uri);
    const state = str(params.state);
    const codeChallenge = str(params.code_challenge);
    const challengeMethod = str(params.code_challenge_method) || 'S256';
    const scope = str(params.scope);
    const responseType = str(params.response_type);
    const resourceParam = str(params.resource);
    console.log(`[oauth] authorize method=${method} client_id=${clientId} redirect=${redirectUri.slice(0,90)} scope=${scope}`);

    const issuer = baseUrl(req);
    // RFC 9207: once the redirect is known to be one of OUR allowlisted
    // callbacks, send protocol errors back through it with `iss` attached.
    // Before that point there is no safe place to send the user: use JSON.
    const canRedirect = isAllowedRedirectUri(redirectUri);
    const redirectError = (error, description, status = 400) => {
      if (canRedirect) {
        const location = buildRedirectUrl(redirectUri, [
          ['error', error],
          ['error_description', description],
          ['state', state],
          ['iss', issuer],
        ]);
        sendHtml(res, 200, redirectPage(location));
        return;
      }
      oauthError(res, status, error, description);
    };

    // In locked mode, Gemini credentials come from env; build a synthetic
    // client on the fly so no KV write is needed. ChatGPT/Claude use their OWN
    // registered clients via explicit DCR carve-outs — never the Gemini
    // ALLOWED_CLIENT_ID, whose redirect stays Google-only.
    let client = await store.getClient(clientId);
    const chatgptClient = client?.platform === 'chatgpt' || Boolean(await isChatgptDcrClient(clientId));
    const claudeClient = client?.platform === 'claude' || Boolean(await isClaudeDcrClient(clientId));
    if (LOCKED && clientAllowed(clientId)) {
      // Gemini's locked client is Google-relay-only: connector callbacks must
      // never be attached to it, even when the global allowlist includes them.
      if (redirectUri.startsWith('https://chatgpt.com/')) {
        return oauthError(res, 400, 'invalid_request', 'Gemini client cannot use a ChatGPT redirect');
      }
      if (isClaudeRedirectUri(redirectUri)) {
        return oauthError(res, 400, 'invalid_request', 'Gemini client cannot use a Claude redirect');
      }
      client = client ?? { clientId, clientName: 'Gemini', platform: 'gemini', redirectUris: [] };
      if (!client.redirectUris?.includes(redirectUri)) client.redirectUris = [...clientRedirects(client), redirectUri];
    }
    if (!client) {
      return oauthError(res, 400, 'invalid_client', 'unknown client_id');
    }
    if (!clientAllowed(clientId) && !chatgptClient && !claudeClient) {
      return oauthError(res, 401, 'invalid_client', 'client not allowed');
    }
    // Shared check for every platform: no arbitrary host, and the exact URI must
    // be registered for this client.
    if (!isAllowedRedirectUri(redirectUri)) {
      return oauthError(res, 400, 'invalid_request', 'redirect_uri host or path is not allowed');
    }
    // Connector clients may ONLY use their own callbacks; Gemini's locked client
    // may only use Google relay callbacks. Never mix platforms.
    if (chatgptClient && !isChatgptRedirectUri(redirectUri)) {
      return redirectError('invalid_request', 'ChatGPT clients must use a ChatGPT redirect_uri');
    }
    if (claudeClient && !isClaudeRedirectUri(redirectUri)) {
      return redirectError('invalid_request', 'Claude clients must use a Claude redirect_uri');
    }
    if (client.platform === 'chatgpt' && !chatgptClient) {
      return oauthError(res, 401, 'invalid_client', 'client not allowed');
    }
    if (client.platform === 'claude' && !claudeClient) {
      return oauthError(res, 401, 'invalid_client', 'client not allowed');
    }
    if (!isRegisteredRedirect(client, redirectUri)) {
      if (LOCKED && clientAllowed(clientId) && client.platform === 'gemini' &&
          !isChatgptRedirectUri(redirectUri) && !isClaudeRedirectUri(redirectUri)) {
        // Legacy Gemini behaviour: the single allowed client accepts any
        // Google-relay redirect without a prior DCR record — connectors excluded.
        client.redirectUris = [...clientRedirects(client), redirectUri];
      } else {
        return redirectError('invalid_request', 'redirect_uri is not registered for this client');
      }
    }
    if (responseType && responseType !== 'code') {
      return redirectError('unsupported_response_type', 'only response_type=code is supported');
    }
    if (!codeChallenge || challengeMethod !== 'S256') {
      return redirectError('invalid_request', 'PKCE code_challenge with S256 is required');
    }

    if (method !== 'POST') {
      console.log('[oauth] consent page shown');
      sendHtml(
        res,
        200,
        consentPage({
          clientName: client.clientName ?? client.client_name,
          clientId,
          redirectUri,
          state,
          codeChallenge,
          scope,
          resource: resourceParam,
        }),
      );
      return;
    }

    const code = randomBytes(32).toString('base64url');
    const now = Date.now();
    await store.saveCode(code, {
      clientId,
      redirectUri,
      // Keep the exact state string; encodeURIComponent in buildRedirectUrl
      // preserves its bytes on the way back to the client.
      state,
      scope,
      resource: resourceParam,
      platform: chatgptClient ? 'chatgpt' : claudeClient ? 'claude' : 'gemini',
      codeChallenge,
      codeChallengeMethod: 'S256',
      createdAt: now,
      expiresAt: now + CODE_TTL_MS,
    });

    // RFC 9207 issuer identification: every successful response carries `iss`,
    // exactly equal to metadata.issuer and protected resource authorization_servers.
    const location = buildRedirectUrl(redirectUri, [
      ['code', code],
      ['state', state],
      ['iss', issuer],
    ]);
    // 200 + meta refresh rather than a bare 302: Google's relay performs a
    // second navigation that a strict CSP (form-action 'self') would block.
    sendHtml(res, 200, redirectPage(location));
  }

  async function issueAccessToken(storeRef, { clientId, scope, resource, refreshTokenHash, existingRefreshToken }) {
    const accessToken = randomBytes(32).toString('base64url');
    const refreshToken = existingRefreshToken ?? randomBytes(32).toString('base64url');
    const accessTokenHash = hashSecret(accessToken);
    const resolvedRefreshHash = refreshTokenHash ?? hashSecret(refreshToken);
    const now = Date.now();
    await storeRef.saveToken(accessToken, {
      clientId,
      scope: scope ?? '',
      resource: resource ?? '',
      tokenHash: accessTokenHash,
      refreshTokenHash: resolvedRefreshHash,
      issuedAt: now,
      expiresAt: now + ACCESS_TOKEN_TTL_SECONDS * 1000,
    });
    return { accessToken, refreshToken, expiresIn: ACCESS_TOKEN_TTL_SECONDS };
  }

  async function handleCodeGrant(params, res) {
    const code = str(params.code);
    if (!code) return oauthError(res, 400, 'invalid_grant', 'code is required');

    // Atomic take: a code can only be redeemed once.
    const record = await store.takeCode(code);
    if (!record) return oauthError(res, 400, 'invalid_grant', 'invalid or already used code');
    if (Number(record.expiresAt) && Number(record.expiresAt) <= Date.now()) {
      return oauthError(res, 400, 'invalid_grant', 'code expired');
    }

    const clientId = str(params.client_id);
    if (clientId && record.clientId && clientId !== record.clientId) {
      return oauthError(res, 400, 'invalid_grant', 'client_id does not match the code');
    }
    if (params.redirect_uri && str(params.redirect_uri) !== record.redirectUri) {
      return oauthError(res, 400, 'invalid_grant', 'redirect_uri does not match the code');
    }
    // Token endpoint goes through the same redirect validator as DCR/authorize.
    if (params.redirect_uri && !isAllowedRedirectUri(str(params.redirect_uri))) {
      return oauthError(res, 400, 'invalid_grant', 'redirect_uri host or path is not allowed');
    }
    // Platform isolation: connector codes must not be redeemed by a Gemini
    // client id (and vice versa). Existing ChatGPT messages are unchanged.
    const chatgptCode = record.platform === 'chatgpt' || isChatgptRedirectUri(record.redirectUri);
    const claudeCode = record.platform === 'claude' || isClaudeRedirectUri(record.redirectUri);
    const connectorCode = chatgptCode || claudeCode;
    const redeemingClient = await store.getClient(str(params.client_id));
    if (chatgptCode && (redeemingClient?.platform === 'gemini' ||
        (LOCKED && str(params.client_id) === ALLOWED_CLIENT_ID))) {
      return oauthError(res, 401, 'invalid_client', 'platform mismatch: ChatGPT code');
    }
    if (!chatgptCode && redeemingClient?.platform === 'chatgpt') {
      return oauthError(res, 401, 'invalid_client', 'platform mismatch: Gemini code');
    }
    if (claudeCode && (redeemingClient?.platform !== 'claude' ||
        (LOCKED && str(params.client_id) === ALLOWED_CLIENT_ID))) {
      return oauthError(res, 401, 'invalid_client', 'platform mismatch: Claude code');
    }
    if (!connectorCode && redeemingClient?.platform === 'claude') {
      return oauthError(res, 401, 'invalid_client', 'platform mismatch: Gemini code');
    }

    const verifier = str(params.code_verifier);
    const computed = createHash('sha256').update(verifier).digest('base64url');
    if (!verifier || !safeEqual(computed, record.codeChallenge)) {
      return oauthError(res, 400, 'invalid_grant', 'PKCE code_verifier is invalid');
    }

    // Locked mode: the pre-registered Gemini client's secret must match the env
    // value. DCR connector clients are public PKCE clients with no secret.
    if (LOCKED && !connectorCode && !clientAllowed(str(params.client_id), str(params.client_secret), true)) {
      return oauthError(res, 401, 'invalid_client', 'client credentials are invalid');
    }
    if (record.clientId && !connectorCode) {
      const client = await store.getClient(record.clientId);
      if (client?.clientSecretHash) {
        if (!safeEqual(hashSecret(str(params.client_secret)), client.clientSecretHash)) {
          return oauthError(res, 401, 'invalid_client', 'client_secret is invalid');
        }
      }
    }

    // Echo `resource` when the client requested it (MCP 2025-11-25 / RFC 8707).
    // The value is recorded at authorize time (including through the consent
    // form); a token request may also supply it directly.
    const resource = str(params.resource) || str(record.resource);
    const tokens = await issueAccessToken(store, {
      clientId: record.clientId,
      scope: record.scope,
      resource,
    });
    await store.saveRefresh(tokens.refreshToken, {
      clientId: record.clientId,
      scope: record.scope ?? '',
      resource,
      tokenHash: hashSecret(tokens.refreshToken),
      accessTokenHash: hashSecret(tokens.accessToken),
      issuedAt: Date.now(),
    });

    console.log('[oauth] token issued');
    sendJson(res, 200, {
      access_token: tokens.accessToken,
      token_type: 'Bearer',
      expires_in: tokens.expiresIn,
      refresh_token: tokens.refreshToken,
      scope: record.scope ?? '',
      ...(resource ? { resource } : {}),
    });
  }

  async function handleRefreshGrant(params, res) {
    const refreshToken = str(params.refresh_token);
    if (!refreshToken) return oauthError(res, 400, 'invalid_grant', 'refresh_token is required');

    const record = await store.getRefresh(refreshToken);
    if (!record) return oauthError(res, 400, 'invalid_grant', 'unknown refresh_token');
    if (Number(record.expiresAt) && Number(record.expiresAt) <= Date.now()) {
      return oauthError(res, 400, 'invalid_grant', 'refresh_token expired');
    }
    const clientId = str(params.client_id);
    const chatgptRefresh = (await isChatgptDcrClient(clientId)) ||
      (LOCKED && clientId && clientId === ALLOWED_CLIENT_ID && str(record.platform) === 'chatgpt');
    const claudeRefresh = (await isClaudeDcrClient(clientId)) ||
      (LOCKED && clientId && clientId === ALLOWED_CLIENT_ID && str(record.platform) === 'claude');
    if (LOCKED && !chatgptRefresh && !claudeRefresh && !clientAllowed(clientId, str(params.client_secret), true)) {
      return oauthError(res, 401, 'invalid_client', 'client credentials are invalid');
    }
    if (clientId && record.clientId && clientId !== record.clientId) {
      return oauthError(res, 400, 'invalid_grant', 'client_id does not match the refresh token');
    }

    const resource = str(params.resource) || str(record.resource);
    // Non-rotating: the same refresh token stays valid and is returned again.
    const tokens = await issueAccessToken(store, {
      clientId: record.clientId,
      scope: record.scope,
      resource,
      refreshTokenHash: record.tokenHash ?? hashSecret(refreshToken),
      existingRefreshToken: refreshToken,
    });
    console.log('[oauth] token issued');
    sendJson(res, 200, {
      access_token: tokens.accessToken,
      token_type: 'Bearer',
      expires_in: tokens.expiresIn,
      // Deliberately the same token as the request — never rotate.
      refresh_token: refreshToken,
      scope: record.scope ?? '',
      ...(resource ? { resource } : {}),
    });
  }

  async function token(req, res) {
    let params;
    try {
      params = await readParams(req);
    } catch {
      return oauthError(res, 400, 'invalid_request', 'invalid token request body');
    }
    const grantType = str(params.grant_type);
    console.log(`[oauth] token request grant=${grantType} client_id=${str(params.client_id)} has_secret=${!!params.client_secret} redirect=${str(params.redirect_uri).slice(0,80)}`);
    if (grantType === 'authorization_code') return handleCodeGrant(params, res);
    if (grantType === 'refresh_token') return handleRefreshGrant(params, res);
    return oauthError(res, 400, 'unsupported_grant_type', 'unsupported grant_type');
  }

  async function revoke(req, res) {
    let params;
    try {
      params = await readParams(req);
    } catch {
      return oauthError(res, 400, 'invalid_request', 'invalid revocation body');
    }
    const tokenValue =
      str(params.token) || str(params.access_token) || str(params.refresh_token);
    if (tokenValue) await store.revokeToken(tokenValue);
    // RFC 7009: always respond 200 OK, even for an unknown token.
    sendJson(res, 200, {});
  }

  return { metadata, protectedResource, register, authorize, token, revoke };
}

export default createOAuthHandlers;
