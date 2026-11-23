/**
 * Gateway-initiated upstream OAuth (authorization code + PKCE).
 *
 * Lets the gateway act as the OAuth client for one configured upstream:
 *   GET /upstream/oauth/start?server=figma&key=<UPSTREAM_OAUTH_ADMIN_KEY>
 *     -> redirects to the provider's authorization endpoint
 *   GET /upstream/oauth/callback?code&state
 *     -> exchanges the code, seeds the upstream token record in KV
 *
 * The feature is disabled unless UPSTREAM_OAUTH_ADMIN_KEY is set, and only
 * servers with `authorizeUrl`, `refreshUrl` and `clientIdEnv` can use it.
 * No token or secret is ever written to logs or HTML.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { UpstreamAuth, resolveEnvironment, ENVIRONMENTS, requiredScopes } from './upstream-auth.js';
import { resolveBaseUrl } from '../client/oauth.js';

const STATE_TTL_HINT = 'OAuth state expires after 10 minutes and can be used once.';

/**
 * Gateway-owned client registration facts (batch 15 · provider DCR/CIMD).
 * Fetched from live AS/PR metadata on 2026-11-23 — see docs/eval/AUTH-PROVIDERS.md.
 *
 * - Notion: DCR at https://mcp.notion.com/register (public client,
 *   token_endpoint_auth_method: none) and RFC 8707 resource
 *   https://mcp.notion.com/mcp. `scopes_supported` is `default` — there is NO
 *   offline_access scope; refresh is issued by AS policy to registered clients.
 * - Vercel: CIMD (client_id is an HTTPS URL serving a metadata document) is
 *   the no-review path for mcp.vercel.com. The PR metadata advertises only
 *   `openid`, but the AS advertises offline_access — the gateway MUST augment
 *   the scope with `offline_access` or it gets a 1-hour token and no refresh.
 *   RFC 8707 resource is https://mcp.vercel.com/.
 *
 * Nothing here is a credential; these are public endpoint URLs.
 */
export const PROVIDER_ENDPOINTS = Object.freeze({
  notion: Object.freeze({
    registrationEndpoint: 'https://mcp.notion.com/register',
    resource: 'https://mcp.notion.com/mcp',
    dcrScopes: ['default'],
  }),
  vercel: Object.freeze({
    resource: 'https://mcp.vercel.com/',
    // PR metadata says only `openid`; AS says offline_access. The gateway
    // client must ask for both (docs/eval/AUTH-PROVIDERS.md §2.3).
    dcrScopes: ['openid', 'offline_access'],
  }),
});

/** v2 client namespace — DCR clients live here, NEVER in the legacy v1 client hash keys. */
function dcrClientKey(environment, serverName) {
  return `gmcgw:v2:client:${environment}:${serverName}`;
}

/**
 * Read a persisted DCR client. Returns null when absent/unreadable. Uses raw
 * store commands so the v1 `saveClient` hash namespace is never touched.
 */
async function readDcrClient(store, environment, serverName) {
  try {
    const raw = await store._command('get', dcrClientKey(environment, serverName));
    if (!raw || typeof raw !== 'string') return null;
    const rec = JSON.parse(raw);
    return rec?.client_id ? rec : null;
  } catch {
    return null;
  }
}

/**
 * Register a public OAuth client via RFC 7591 DCR. Returns the persisted
 * record. `token_endpoint_auth_method: none` means no client_secret is sent.
 */
async function registerDcrClient({ store, environment, serverName, endpoint, redirectUri, fetchImpl }) {
  const form = {
    redirect_uris: [redirectUri],
    client_name: `gemini-mcp-gateway (${serverName}, ${environment})`,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  };
  const scopes = PROVIDER_ENDPOINTS[serverName]?.dcrScopes;
  if (Array.isArray(scopes) && scopes.length > 0) form.scope = scopes.join(' ');
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(form),
    });
  } catch (error) {
    throw new Error(`DCR registration request failed: ${error?.message ?? error}`);
  }
  if (!response.ok) {
    throw new Error(`DCR registration returned HTTP ${response.status}`);
  }
  let issued;
  try {
    issued = await response.json();
  } catch {
    throw new Error('DCR registration returned a non-JSON response');
  }
  if (!issued?.client_id || typeof issued.client_id !== 'string') {
    throw new Error('DCR registration response did not contain a client_id');
  }
  const record = {
    client_id: issued.client_id,
    // Public client (token_endpoint_auth_method: none) normally has no secret.
    // Only persist one if the AS unexpectedly issued one — never log it.
    ...(issued.client_secret ? { client_secret: issued.client_secret } : {}),
    client_id_issued_at: Number(issued.client_id_issued_at ?? 0),
    registration_endpoint: endpoint,
    registration_environment: environment,
    server: serverName,
    redirect_uris: Array.isArray(issued.redirect_uris) ? issued.redirect_uris : [redirectUri],
    token_endpoint_auth_method: issued.token_endpoint_auth_method ?? 'none',
    createdAt: Date.now(),
  };
  await store._command('set', dcrClientKey(environment, serverName), JSON.stringify(record));
  return record;
}

/**
 * Resolve the OAuth client for a gateway-owned start.
 *  1. DCR: reuse the persisted client; register once if none exists. A second
 *     start during a concurrent registration re-reads the key so we never
 *     orphan a grant by registering twice (Notion explicitly warns about this).
 *  2. CIMD: `clientId` is a public HTTPS metadata-document URL.
 *  3. Static: `clientIdEnv` names an env var (legacy path, unchanged).
 */
async function resolveClient({ store, server, serverName, environment, redirectUri, fetchImpl }) {
  if (server.dcr === true) {
    const endpoint = server.registrationEndpoint ?? PROVIDER_ENDPOINTS[serverName]?.registrationEndpoint;
    if (!endpoint) throw new Error(`${serverName} DCR requires registrationEndpoint`);
    const existing = await readDcrClient(store, environment, serverName);
    if (existing) return { clientId: existing.client_id, clientSecret: existing.client_secret ?? '', dcr: true };
    try {
      const created = await registerDcrClient({
        store, environment, serverName, endpoint, redirectUri, fetchImpl,
      });
      return { clientId: created.client_id, clientSecret: created.client_secret ?? '', dcr: true };
    } catch (error) {
      // Registration may have succeeded on another concurrent start even if
      // this one saw a network error. Re-read before failing so a retry never
      // creates a second client / orphans a grant.
      const raced = await readDcrClient(store, environment, serverName);
      if (raced) return { clientId: raced.client_id, clientSecret: raced.client_secret ?? '', dcr: true };
      throw error;
    }
  }
  if (server.clientId) return { clientId: server.clientId, clientSecret: '', cimd: true };
  const clientId = process.env[server.clientIdEnv];
  if (!clientId) throw new Error(`Environment variable ${server.clientIdEnv} is not set.`);
  return {
    clientId,
    clientSecret: server.clientSecretEnv ? (process.env[server.clientSecretEnv] ?? '') : '',
  };
}

function sendHtml(res, status, title, message) {
  if (res?.headersSent || res?.writableEnded) return;
  const body = `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
    `<h1>${title}</h1><p>${message}</p>`;
  const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };
  if (typeof res?.writeHead === 'function') res.writeHead(status, headers);
  else if (res) {
    res.statusCode = status;
    for (const [key, value] of Object.entries(headers)) res.setHeader?.(key, value);
  }
  res?.end?.(body);
}

function safeEqual(a, b) {
  const left = createHash('sha256').update(String(a ?? '')).digest();
  const right = createHash('sha256').update(String(b ?? '')).digest();
  return timingSafeEqual(left, right);
}

function absoluteUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** The callback carries the environment chosen at start time so the state can
 *  be read from its environment-scoped key (R5). Never trust it blindly: the
 *  state record itself is validated against it in the callback. */
function savedEnvironmentHint(url) {
  const value = String(url.searchParams.get('env') ?? '').trim().toLowerCase();
  return ENVIRONMENTS.includes(value) ? value : undefined;
}

/**
 * @param {{
 *   store: import('./store.js').TokenStore,
 *   getConfig: () => Promise<any>,
 *   options?: { baseUrl?: string, mcpUrl?: string },
 *   fetch?: typeof globalThis.fetch,
 * }} deps
 */
export function createUpstreamOAuthHandlers({ store, getConfig, options = {}, fetch: fetchImpl = globalThis.fetch }) {
  async function start(req, res, url) {
    const adminKey = process.env.UPSTREAM_OAUTH_ADMIN_KEY;
    if (!adminKey) {
      sendHtml(res, 404, 'Not found', 'Upstream OAuth is disabled (UPSTREAM_OAUTH_ADMIN_KEY is not set).');
      return;
    }
    if (!safeEqual(url.searchParams.get('key') ?? '', adminKey)) {
      sendHtml(res, 403, 'Forbidden', 'Invalid admin key.');
      return;
    }

    const serverName = url.searchParams.get('server') ?? '';
    // R2/R3: authorization is bound to an explicit environment. Admin callers
    // pass `env=`; the fallback is resolveEnvironment() (local by default),
    // never an implicit production.
    const requestedEnv = String(url.searchParams.get('env') ?? '').trim().toLowerCase();
    const environment = requestedEnv
      ? (ENVIRONMENTS.includes(requestedEnv) ? requestedEnv : null)
      : resolveEnvironment();
    if (!environment || !ENVIRONMENTS.includes(environment)) {
      sendHtml(res, 400, 'Invalid environment', `env must be one of ${ENVIRONMENTS.join(', ')}.`);
      return;
    }
    const grantOwner = 'gateway';
    const config = await getConfig();
    const server = (config?.servers ?? []).find((item) => item?.name === serverName);
    if (!server) {
      sendHtml(res, 404, 'Unknown server', `No upstream named "${serverName}".`);
      return;
    }
    if (!server.authorizeUrl || !server.refreshUrl) {
      sendHtml(res, 400, 'Not configured',
        `${serverName} needs authorizeUrl and refreshUrl (token endpoint).`);
      return;
    }
    // A client identity is still required, but it may come from DCR, a CIMD
    // metadata URL, or the legacy env var — resolveClient enforces this.
    if (!server.dcr && !server.clientId && !server.clientIdEnv) {
      sendHtml(res, 400, 'Not configured',
        `${serverName} needs dcr:true, clientId (CIMD URL) or clientIdEnv.`);
      return;
    }

    const baseRedirectUri = absoluteUrl(server.oauthRedirectUri)
      ? server.oauthRedirectUri
      : `${resolveBaseUrl(options, req)}/upstream/oauth/callback`;
    // R5: carry the environment in the redirect so the callback can select
    // the matching state namespace. Providers preserve extra query params.
    const redirectUrl = new URL(baseRedirectUri);
    redirectUrl.searchParams.set('env', environment);
    const redirectUri = redirectUrl.toString();
    // Resolve the client AFTER the redirect URI is known: DCR registration
    // must include the exact redirect_uri it will later exchange the code with.
    let client;
    try {
      client = await resolveClient({ store, server, serverName, environment, redirectUri, fetchImpl });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[upstream-oauth] ${serverName} client resolution failed: ${message}`);
      sendHtml(res, 500, 'Client setup failed',
        `${serverName} could not obtain an OAuth client id (${message}). Retry; existing DCR clients are reused.`);
      return;
    }
    const { clientId, clientSecret, dcr, cimd } = client;
    const state = randomBytes(24).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');

    // grantId: one authorization -> one stable gateway grant identity.
    // Use the FULL hash: no fixed-cap cut anywhere in the OAuth path, and the
    // id stays stable across DCR client reuse / grant rotation.
    const grantId = `gw:${environment}:${serverName}:${createHash('sha256')
      .update(`${clientId}|${server.refreshUrl}`)
      .digest('hex')}`;
    const stateScope = { environment, grantOwner };
    // The callback MUST use the client id from state (DCR/CIMD), never an env
    // var, so a gateway-registered client stays bound to its own grant.
    const stateRecord = {
      server: serverName,
      verifier,
      redirectUri,
      createdAt: Date.now(),
      environment,
      grantOwner,
      grantId,
      clientId,
      // Only DCR-issued secrets (if any) are carried in state. Legacy static
      // secrets stay in env and are read by the callback as before — never
      // copy an operator secret into a short-lived state record.
      ...(dcr && clientSecret ? { clientSecret } : {}),
      clientKind: dcr ? 'dcr' : (cimd ? 'cimd' : 'static'),
    };
    // R5: scope the state key by environment + owner when the store supports
    // it; the same fields are also stored inside the record so a fake store
    // that ignores the scope still cannot complete a cross-environment flow.
    if (typeof store._oauthStateKey === 'function') {
      await store.saveOAuthState(state, stateRecord, stateScope);
    } else {
      await store.saveOAuthState(state, stateRecord);
    }

    const authUrl = new URL(server.authorizeUrl);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('code_challenge', challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    // RFC 8707 resource: explicit config wins, then provider facts. Both
    // Notion (https://mcp.notion.com/mcp) and Vercel (https://mcp.vercel.com/)
    // require the target resource on the authorization request.
    const resource = server.resource ?? PROVIDER_ENDPOINTS[serverName]?.resource;
    if (resource) authUrl.searchParams.set('resource', resource);
    // Vercel (and any rotating OAuth provider) MUST request offline_access or
    // no refresh token is issued. Augment explicitly-configured scopes with
    // the provider facts; never rely on the protected-resource metadata alone.
    // Vercel PR metadata says `openid` only, but the AS advertises
    // offline_access — always add it for a gateway-owned grant.
    const scopes = Array.isArray(server.oauthScopes) ? [...server.oauthScopes] : [];
    // Notion's AS does NOT advertise offline_access (live scopes_supported is
    // `default`); refresh tokens are issued by AS policy to registered clients.
    // For the NEW DCR/CIMD client paths, asking for offline_access would be an
    // invalid_scope error, so we use the provider's advertised scopes only.
    // Legacy static-client configs keep the historical requiredScopes()
    // augmentation (pinned by tests/auth-arch-fix.test.js).
    const useProviderAdvertisedScopesOnly = serverName === 'notion' && (dcr || cimd);
    if (!useProviderAdvertisedScopesOnly) {
      for (const required of requiredScopes(serverName)) {
        if (!scopes.includes(required)) scopes.push(required);
      }
    }
    for (const required of PROVIDER_ENDPOINTS[serverName]?.dcrScopes ?? []) {
      if (!scopes.includes(required)) scopes.push(required);
    }
    if (scopes.length > 0) authUrl.searchParams.set('scope', scopes.join(' '));

    if (typeof res?.writeHead === 'function') {
      res.writeHead(302, { location: authUrl.toString(), 'cache-control': 'no-store' });
      res.end();
    } else if (res) {
      res.statusCode = 302;
      res.setHeader('location', authUrl.toString());
      res.setHeader('cache-control', 'no-store');
      res.end();
    }
  }

  async function callback(req, res, url) {
    const error = url.searchParams.get('error');
    if (error) {
      sendHtml(res, 400, 'Authorization denied',
        `${error}${url.searchParams.get('error_description') ? ': ' + url.searchParams.get('error_description') : ''}`);
      return;
    }
    const state = url.searchParams.get('state') ?? '';
    const code = url.searchParams.get('code') ?? '';
    if (!state || !code) {
      sendHtml(res, 400, 'Bad callback', `Missing state or code. ${STATE_TTL_HINT}`);
      return;
    }
    // R5: read the state from the environment-scoped key when the store
    // supports it. The record's own `environment` is the cross-env guard for
    // test doubles that ignore the scope argument.
    const saved = typeof store._oauthStateKey === 'function'
      ? await store.takeOAuthState(state, {
        environment: savedEnvironmentHint(url), grantOwner: 'gateway',
      })
      : await store.takeOAuthState(state);
    if (!saved) {
      sendHtml(res, 400, 'Invalid state', `Unknown, expired or already used state. ${STATE_TTL_HINT}`);
      return;
    }
    if (saved.environment && !ENVIRONMENTS.includes(saved.environment)) {
      sendHtml(res, 400, 'Invalid state environment', `State was created with an unknown environment. ${STATE_TTL_HINT}`);
      return;
    }
    const hint = savedEnvironmentHint(url);
    if (hint && saved.environment && hint !== saved.environment) {
      sendHtml(res, 400, 'Environment mismatch',
        `State was created for ${saved.environment}, not ${hint}. ${STATE_TTL_HINT}`);
      return;
    }
    // R3: the callback must NEVER land on a legacy production key. The grant
    // identity comes from the state created at start, not from process.env.
    const environment = saved.environment ?? hint ?? resolveEnvironment();
    const source = saved.clientKind === 'dcr' ? 'gateway-dcr'
      : (saved.clientKind === 'cimd' ? 'gateway-cimd' : 'gateway-oauth');

    const config = await getConfig();
    const server = (config?.servers ?? []).find((item) => item?.name === saved.server);
    if (!server?.refreshUrl) {
      sendHtml(res, 500, 'Server no longer configured', `${saved.server} is missing from the current config.`);
      return;
    }
    // DCR/CIMD client ids live in OAuth state, NOT in env. Fall back to env
    // only for legacy static-client configurations. This is what keeps a
    // gateway-registered client bound to the grant it authorized.
    const clientId = saved.clientId ?? (server.clientIdEnv ? process.env[server.clientIdEnv] : '');
    const clientSecret = saved.clientSecret
      ?? (server.clientSecretEnv ? (process.env[server.clientSecretEnv] ?? '') : '');
    if (!clientId) {
      sendHtml(res, 500, 'Missing client id',
        `The OAuth state has no client id and ${saved.server} no longer has a clientIdEnv.`);
      return;
    }

    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: saved.redirectUri,
      code_verifier: saved.verifier,
    });
    // RFC 8707: the token request must carry the same resource as authorize.
    const resource = server.resource ?? PROVIDER_ENDPOINTS[saved.server]?.resource;
    if (resource) form.set('resource', resource);
    if (!clientSecret) form.set('client_id', clientId);

    const headers = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
    if (clientSecret) {
      headers.authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
    }
    let tokenResponse = await fetchImpl(server.refreshUrl, { method: 'POST', headers, body: form });
    let tokenText = await tokenResponse.text();

    // Some providers only accept client_id/client_secret in the POST body.
    if (!tokenResponse.ok && clientSecret) {
      const retryForm = new URLSearchParams(form);
      retryForm.set('client_id', clientId);
      retryForm.set('client_secret', clientSecret);
      tokenResponse = await fetchImpl(server.refreshUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: retryForm,
      });
      tokenText = await tokenResponse.text();
    }
    if (!tokenResponse.ok) {
      console.error(`[upstream-oauth] ${saved.server} token exchange failed: HTTP ${tokenResponse.status}`);
      sendHtml(res, 502, 'Token exchange failed', `The provider returned HTTP ${tokenResponse.status}. Check the server logs.`);
      return;
    }

    let token;
    try {
      token = JSON.parse(tokenText);
    } catch {
      sendHtml(res, 502, 'Token exchange failed', 'The provider returned a non-JSON token response.');
      return;
    }
    if (!token?.access_token) {
      sendHtml(res, 502, 'Token exchange failed', 'The provider response did not contain an access_token.');
      return;
    }
    // Vercel-only: offline_access is required for a refresh token. Fail loudly
    // instead of silently accepting a 1-hour token that will expire hourly.
    if (saved.server === 'vercel' && !token.refresh_token) {
      console.error('[upstream-oauth] vercel callback returned no refresh_token; offline_access was not honored');
      sendHtml(res, 400, 'Missing refresh token',
        'Vercel returned no refresh_token. Confirm the authorization request included offline_access and the AS issued it, then retry.');
      return;
    }

    // R3: seed under the environment + gateway-owner v2 key with the full
    // grant identity. Never construct UpstreamAuth from process.env here —
    // that was the old bug that dropped callbacks into legacy production.
    await new UpstreamAuth({ store, fetch: fetchImpl, environment, grantOwner: 'gateway' }).seed(saved.server, {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      clientId,
      clientSecret,
      expiresIn: Number(token.expires_in ?? 0),
      obtainedAt: Date.now(),
      grantOwner: 'gateway',
      source,
      grantId: saved.grantId ?? `gw:${environment}:${saved.server}:oauth`,
      environment,
      force: true,
    });

    console.log(`[upstream-oauth] ${saved.server} authorization stored (refresh: ${token.refresh_token ? 'yes' : 'no'})`);
    sendHtml(res, 200, 'Connected',
      `${saved.server} is authorized. Reconnect the MCP client if it was already connected; the gateway will use the stored token.`);
  }

  return { start, callback };
}
