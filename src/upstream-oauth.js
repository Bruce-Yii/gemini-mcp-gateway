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
import { resolveBaseUrl } from './oauth.js';

const STATE_TTL_HINT = 'OAuth state expires after 10 minutes and can be used once.';

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
    if (!server.authorizeUrl || !server.refreshUrl || !server.clientIdEnv) {
      sendHtml(res, 400, 'Not configured',
        `${serverName} needs authorizeUrl, refreshUrl (token endpoint) and clientIdEnv.`);
      return;
    }
    const clientId = process.env[server.clientIdEnv];
    if (!clientId) {
      sendHtml(res, 500, 'Missing client id', `Environment variable ${server.clientIdEnv} is not set.`);
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
    const stateRecord = {
      server: serverName,
      verifier,
      redirectUri,
      createdAt: Date.now(),
      environment,
      grantOwner,
      grantId,
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
    // Vercel (and any rotating OAuth provider) MUST request offline_access or
    // no refresh token is issued. Augment explicitly-configured scopes with
    // the provider facts; never rely on the protected-resource metadata alone.
    const scopes = Array.isArray(server.oauthScopes) ? [...server.oauthScopes] : [];
    for (const required of requiredScopes(serverName)) {
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
    const source = saved.grantId?.includes(':dcr:') ? 'gateway-dcr' : 'gateway-oauth';

    const config = await getConfig();
    const server = (config?.servers ?? []).find((item) => item?.name === saved.server);
    if (!server?.refreshUrl || !server.clientIdEnv) {
      sendHtml(res, 500, 'Server no longer configured', `${saved.server} is missing from the current config.`);
      return;
    }
    const clientId = process.env[server.clientIdEnv];
    const clientSecret = server.clientSecretEnv ? process.env[server.clientSecretEnv] : '';
    if (!clientId) {
      sendHtml(res, 500, 'Missing client id', `Environment variable ${server.clientIdEnv} is not set.`);
      return;
    }

    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: saved.redirectUri,
      code_verifier: saved.verifier,
    });
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
