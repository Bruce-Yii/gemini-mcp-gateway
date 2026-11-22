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

import { UpstreamAuth } from './upstream-auth.js';
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

    const redirectUri = absoluteUrl(server.oauthRedirectUri)
      ? server.oauthRedirectUri
      : `${resolveBaseUrl(options, req)}/upstream/oauth/callback`;
    const state = randomBytes(24).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');

    await store.saveOAuthState(state, {
      server: serverName,
      verifier,
      redirectUri,
      createdAt: Date.now(),
    });

    const authUrl = new URL(server.authorizeUrl);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('code_challenge', challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    const scopes = Array.isArray(server.oauthScopes) ? server.oauthScopes : [];
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
    const saved = await store.takeOAuthState(state);
    if (!saved) {
      sendHtml(res, 400, 'Invalid state', `Unknown, expired or already used state. ${STATE_TTL_HINT}`);
      return;
    }

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

    await new UpstreamAuth({ store, fetch: fetchImpl }).seed(saved.server, {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      clientId,
      clientSecret,
      expiresIn: Number(token.expires_in ?? 0),
      obtainedAt: Date.now(),
    });

    console.log(`[upstream-oauth] ${saved.server} authorization stored (refresh: ${token.refresh_token ? 'yes' : 'no'})`);
    sendHtml(res, 200, 'Connected',
      `${saved.server} is authorized. Reconnect the MCP client if it was already connected; the gateway will use the stored token.`);
  }

  return { start, callback };
}
