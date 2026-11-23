/**
 * Upstream MCP client manager.
 *
 * Connects to every configured MCP upstream (stdio or Streamable HTTP), pulls
 * its tool list, and produces a flat catalog of entries whose public name is
 * `server__tool` (double underscore avoids Gemini's "first underscore splits
 * namespace" parsing). Tools outside a server's allow/deny policy are dropped
 * at connect time; the raw client reference travels on `_client` so callTool
 * can route by the original (unprefixed) server/tool names.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { isAllowed } from './catalog.js';
import {
  UpstreamAuth, defaultProvider, resolveEnvironment,
  REAUTH_REQUIRED, STATIC_TOKEN_NO_REFRESH, ReauthRequiredError,
} from './upstream-auth.js';
import { normalizeToolArguments } from './sanitize.js';
import { captureEvent } from './capture.js';
import { createFigmaGuard, isFigmaQuotaError } from './figma-guard.js';
// F-01: only the MODEL-VISIBLE projection is redacted. `error.message` below
// stays raw so `captureEvent` keeps its full-fidelity audit trail.
import { redactSecrets } from './tool-format.js';

export function tapTransport(transport, server) {
  if (!transport) return transport;
  const originalSend = transport.send?.bind(transport);
  if (originalSend) {
    transport.send = (message, options) => {
      captureEvent('upstream_frame', { server, direction: 'out', message, options });
      return originalSend(message, options);
    };
  }
  const originalOnMessage = transport.onmessage;
  transport.onmessage = (message, extra) => {
    captureEvent('upstream_frame', { server, direction: 'in', message, extra });
    return originalOnMessage?.(message, extra);
  };
  return transport;
}

/** Max bytes of an upstream HTTP response body kept in a capture event.
 * Bounded so a runaway upstream cannot bloat the envelope; the SDK always gets
 * the full, untouched response regardless of this limit. */
const MAX_UPSTREAM_RESPONSE_BODY = 64 * 1024;

function responseHeader(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : null;
}

function isStreamingResponse(response) {
  const type = responseHeader(response?.headers, 'content-type') ?? '';
  return /text\/event-stream/i.test(String(type));
}

/** Read up to `maxBytes` from a cloned response body without consuming the
 * original. Returns `{ text, truncated }`; failures degrade to an empty read
 * so capture can never break the SDK's response. */
async function readResponseBodyCapped(response, maxBytes) {
  if (!response || typeof response.clone !== 'function') {
    return { text: null, truncated: false, skipped: 'no-clone' };
  }
  let clone;
  try { clone = response.clone(); } catch { return { text: null, truncated: false, skipped: 'clone-failed' }; }
  if (!clone?.body || typeof clone.body.getReader !== 'function') {
    if (typeof clone?.text === 'function') {
      try {
        const full = await clone.text();
        const truncated = full.length > maxBytes;
        return { text: truncated ? full.slice(0, maxBytes) : full, truncated };
      } catch { return { text: null, truncated: false, skipped: 'read-failed' }; }
    }
    return { text: null, truncated: false, skipped: 'no-body' };
  }
  const reader = clone.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (bytes + value.byteLength > maxBytes) {
        const remaining = maxBytes - bytes;
        if (remaining > 0) text += decoder.decode(value.subarray(0, remaining), { stream: true });
        truncated = true;
        // Do NOT call reader.cancel() — on Node's Response-backed streams that
        // can hang. Just stop reading; the clone is discarded with the GC.
        break;
      }
      text += decoder.decode(value, { stream: true });
      bytes += value.byteLength;
    }
    text += decoder.decode();
  } catch {
    // Partial text is still useful; never throw into the caller.
  }
  return { text, truncated };
}

/** Wrap a fetch implementation so every upstream HTTP call emits structured
 * `upstream_http` request/response capture events. The returned Response is
 * the original object — cloning and body reads happen off the critical path. */
export function makeCaptureFetch(server) {
  return async (input, init = {}) => {
    const request = input instanceof Request ? input : null;
    const url = typeof input === 'string' ? input : (input?.url ?? String(input));
    const headers = new Headers(init.headers ?? request?.headers ?? undefined);
    let body = init.body ?? request?.body ?? null;
    if (body && typeof body !== 'string' && !(body instanceof Uint8Array)) body = null;
    captureEvent('upstream_http', {
      phase: 'request', server, url,
      method: init.method ?? request?.method ?? 'GET',
      headers: Object.fromEntries(headers),
      body: typeof body === 'string' ? body : (body ? Buffer.from(body).toString('utf8') : null),
    });
    const response = await fetch(input, init);
    const responseHeaders = Object.fromEntries(response?.headers ?? []);
    const event = {
      phase: 'response', server, url,
      status: response?.status,
      headers: responseHeaders,
    };
    if (isStreamingResponse(response)) {
      // SSE / streaming: never wait for the body — the stream may never end.
      event.bodySkipped = 'stream';
    } else {
      // Read from a clone so the SDK-facing Response is untouched. The read is
      // bounded (64KB) and awaited here to make the capture deterministic;
      // streaming responses take the non-blocking path above instead.
      const { text, truncated, skipped } = await readResponseBodyCapped(response, MAX_UPSTREAM_RESPONSE_BODY);
      event.body = text;
      if (truncated) event.bodyTruncated = true;
      if (skipped) event.bodySkipped = skipped;
    }
    captureEvent('upstream_http', event);
    return response;
  };
}

const CLIENT_INFO = { name: 'gemini-mcp-gateway', version: '0.1.0' };

/** Resolve the OAuth-refresh provider for a server config.
 * A `refreshUrl` in the config opts any upstream into refresh; the built-in
 * Notion/Linear defaults keep the shipped config working without it. */
function providerFor(config) {
  if (!config || typeof config !== 'object') return null;
  if (typeof config.refreshUrl === 'string' && config.refreshUrl) {
    return { tokenUrl: config.refreshUrl, mcpUrl: config.url };
  }
  return defaultProvider(config.name);
}

function messageOf(err) {
  return err instanceof Error ? err.message : String(err);
}

/** True when an upstream rejected our credentials (HTTP 401 / invalid_token).
 * The MCP SDK surfaces provider errors in different places (message, status,
 * response, cause), so inspect them all. Deliberately strict: a generic failure
 * must NOT trigger a refresh — only a provider-side auth rejection may. */
function isAuthError(err) {
  if (!err) return false;
  const seen = new Set();
  const parts = [];
  const walk = (e, depth) => {
    if (!e || depth > 4 || seen.has(e)) return;
    if (typeof e !== 'object') { parts.push(messageOf(e)); return; }
    seen.add(e);
    parts.push(messageOf(e));
    for (const key of ['status', 'statusCode', 'code']) {
      if (e[key] === 401) parts.push('401');
    }
    if (typeof e.error === 'string') parts.push(e.error);
    if (e.response && typeof e.response === 'object') {
      if (e.response.status === 401 || e.response.statusCode === 401) parts.push('401');
      if (typeof e.response.error === 'string') parts.push(e.response.error);
    }
    if (e.data && typeof e.data === 'object') walk(e.data, depth + 1);
    if (e.cause) walk(e.cause, depth + 1);
  };
  walk(err, 0);
  return parts.some((p) => /\b401\b|invalid_token|invalid access token|unauthorized/i.test(p));
}

/** Wrap any failure with the upstream name so logs point at the right server.
 * F-01: keep `message` RAW for capture (full fidelity is an explicit product
 * decision), but attach a redacted `modelMessage` that every model-visible
 * error path prefers. Non-enumerable so JSON.stringify/capture never drops or
 * duplicates it, and the public error shape is unchanged. */
function upstreamError(name, action, err) {
  const error = new Error(`[upstream:${name}] ${action}: ${messageOf(err)}`);
  error.cause = err;
  Object.defineProperty(error, 'modelMessage', {
    value: redactSecrets(error.message),
    enumerable: false,
    configurable: true,
    writable: false,
  });
  return error;
}

function aggregate(errors) {
  return new AggregateError(errors, errors.map((error) => error.message).join('; '));
}

export class UpstreamManager {
  constructor(configs = [], options = {}) {
    this.configs = Array.isArray(configs) ? configs : [];
    // All token state is namespaced by deployment environment. A preview
    // deployment must never read, refresh, or revoke a production grant.
    this.environment = options.environment ?? resolveEnvironment();
    /** @type {Array<{server:string, tool:string, name:string, description?:string, inputSchema?:object, _client:Client}>} */
    this.entries = [];
    /** server name -> { client, transport, config } */
    this._clients = new Map();
    this._closed = new Set();
    this._auth = options.auth ?? new UpstreamAuth({ environment: this.environment });
    // Figma-only quota breaker + read cache. In-memory and per-instance.
    this.figmaGuard = options.figmaGuard ?? createFigmaGuard(options.figmaGuardOptions);
    // Test seam: inject a fake MCP client without touching the real SDK.
    this._clientFactory = options.clientFactory ?? (() => new Client(CLIENT_INFO));
  }

  async _resolveToken(config, { force = false } = {}) {
    if (!config.tokenEnv) return undefined;
    const envToken = process.env[config.tokenEnv];
    // static_bearer: an EXPLICIT config opt-in for an owner-created static
    // credential (Notion MCP token / Linear PAT / Vercel REST token). It is
    // long-lived, non-rotating and must NEVER enter the OAuth refresh path.
    // Never infer this from envToken alone — only config.authMode opts in.
    const staticBearer = config.authMode === 'static_bearer' || config.staticBearer === true;
    if (staticBearer) {
      if (!envToken) throw new Error(`http 上游环境变量 ${config.tokenEnv} 未设置`);
      // Persist an owner=manual marker (R3/static path) so getAuthStatus()
      // reports a static credential and no code can mistake it for a
      // gateway-owned rotating grant. Best-effort: KV absence must not break
      // a static-token connection.
      if (typeof this._auth?.seed === 'function') {
        try {
          await this._auth.seed(config.name, {
            accessToken: envToken,
            grantOwner: 'manual',
            source: config.grantSource ?? 'manual',
            force: true,
          });
        } catch { /* static token works even without KV */ }
      }
      return envToken;
    }
    const provider = providerFor(config);
    if (!provider?.tokenUrl) return envToken; // long-lived token (GitHub/Vercel/custom)
    // OAuth-refresh upstream: go through the refresh-aware lifecycle. `force` is
    // set only after the provider itself rejected the token with 401/invalid_token.
    return this._auth.getAccessToken(config.name, {
      envToken,
      envRefresh: config.refreshEnv ? process.env[config.refreshEnv] : undefined,
      envClientId: config.clientIdEnv ? process.env[config.clientIdEnv] : undefined,
      envClientSecret: config.clientSecretEnv ? process.env[config.clientSecretEnv] : undefined,
      envExpiresIn: config.expiresInEnv ? Number(process.env[config.expiresInEnv]) : undefined,
      envObtainedAt: config.obtainedAtEnv ? Number(process.env[config.obtainedAtEnv]) : undefined,
      // Grant ownership is the deepest root cause: a DSH-exported rotating
      // grant must never be refreshed by the gateway. Configs can declare it
      // explicitly (grantOwner / grantSource); env vars work too so operators
      // can tag a shared grant without redeploying config.
      grantOwner: config.grantOwner ?? process.env[config.grantOwnerEnv ?? ''] ?? undefined,
      source: config.grantSource ?? process.env[config.grantSourceEnv ?? ''] ?? undefined,
      tokenUrl: provider.tokenUrl,
      mcpUrl: provider.mcpUrl,
    }, { force });
  }

  async _createTransport(config, tokenOverride) {
    if (config.transport === 'stdio') {
      if (!config.command) throw new Error('stdio 上游缺少 command');
      const params = { command: config.command, args: config.args ?? [] };
      // Let the SDK supply its default environment when none was configured.
      if (config.env && Object.keys(config.env).length > 0) params.env = config.env;
      return new StdioClientTransport(params);
    }
    if (config.transport === 'http') {
      if (!config.url) throw new Error('http 上游缺少 url');
      const headers = { ...(config.headers ?? {}) };
      // tokenEnv: read the bearer token from an environment variable so the
      // secret never lands in config files, git, or logs. For Notion/Linear the
      // token goes through the auto-refresh lifecycle before being used.
      if (config.tokenEnv) {
        // On an auth-retry we already forced a fresh token; do not resolve
        // (and possibly refresh) a second time for the same reconnect.
        const token = tokenOverride !== undefined ? tokenOverride : await this._resolveToken(config);
        if (!token) {
          throw new Error(`http 上游环境变量 ${config.tokenEnv} 未设置`);
        }
        // Most upstreams use Bearer; a few expect Basic (Atlassian personal API
        // tokens), a provider-specific scheme (Sentry's "Sentry-Bearer"), or
        // the raw token in a custom header (Figma's X-Figma-Token).
        const rawScheme = config.authScheme || 'Bearer';
        const lower = rawScheme.toLowerCase();
        const scheme = lower === 'basic' ? 'Basic' : lower === 'bearer' ? 'Bearer' : rawScheme;
        const headerName = config.tokenHeader ?? 'Authorization';
        if (headerName.toLowerCase() === 'authorization') {
          headers.Authorization = `${scheme} ${token}`;
        } else {
          headers[headerName] = token;
        }
      }
      const options = {};
      options.fetch = makeCaptureFetch(config.name ?? '<unnamed>');
      if (Object.keys(headers).length > 0) {
        options.requestInit = { headers };
      }
      return new StreamableHTTPClientTransport(new URL(config.url), options);
    }
    throw new Error(`未知 transport: ${String(config.transport)}（仅支持 stdio / http）`);
  }

  async connect() {
    const errors = [];
    this.failedServers = [];
    // Connect upstreams in parallel so one slow/failing server does not add its
    // latency to every cold start, and a single failure cannot take down the
    // whole gateway.
    await Promise.all(this.configs.map(async (config) => {
      const name = config?.name ?? '<unnamed>';
      let client;
      let transport;
      try {
        const establish = async (tokenOverride) => {
          transport = await this._createTransport(config, tokenOverride);
          tapTransport(transport, name);
          client = this._clientFactory();
          await client.connect(transport);
          const { tools } = await client.listTools();
          return tools ?? [];
        };

        let tools;
        const connectStarted = Date.now();
        try {
          tools = await establish();
          captureEvent('upstream_connect', {
            server: name, ok: true, toolCount: tools.length,
            durationMs: Date.now() - connectStarted,
          });
        } catch (err) {
          captureEvent('upstream_connect', {
            server: name, ok: false,
            error: { name: err?.name, message: err?.message, stack: err?.stack },
            durationMs: Date.now() - connectStarted,
          });
          // A 401/invalid_token is the provider telling us our locally "fresh"
          // token is actually dead. This feedback loop is the only reliable
          // liveness signal — local expiry timestamps cannot be trusted. Force
          // exactly one refresh (through UpstreamAuth's lock/CAS/needsReauth
          // guards) and reconnect exactly once. invalid_grant / other errors
          // never take this path, so a dead grant cannot be burned by retries.
          if (!isAuthError(err)) throw err;
          // A static bearer credential has no refresh path: a 401 means the
          // owner-created token is revoked/expired and must be replaced by the
          // owner. Never retry it as if an OAuth refresh could help.
          if (config.authMode === 'static_bearer' || config.staticBearer === true) {
            const noRefresh = new ReauthRequiredError(name, STATIC_TOKEN_NO_REFRESH);
            captureEvent('upstream_auth', {
              server: name, phase: 'static_bearer_expired', environment: this.environment,
              status: REAUTH_REQUIRED, reason: STATIC_TOKEN_NO_REFRESH,
              grantOwner: 'manual',
            });
            console.error(`[upstreams] ${noRefresh.message}（static_bearer: owner 需轮换静态 token）`);
            throw noRefresh;
          }
          if (!providerFor(config)?.tokenUrl) {
            // Static bearer upstream (Vercel/GitHub/custom): there is NO
            // refresh endpoint and no rotating grant to recover. Retrying the
            // same env token can never help — say so explicitly instead of
            // failing with a raw 401 that looks like a transient glitch.
            const noRefresh = new ReauthRequiredError(name, STATIC_TOKEN_NO_REFRESH);
            captureEvent('upstream_auth', {
              server: name, phase: 'static_token_expired', environment: this.environment,
              status: REAUTH_REQUIRED, reason: STATIC_TOKEN_NO_REFRESH,
            });
            console.error(`[upstreams] ${noRefresh.message}（长期 token 或补齐 refreshUrl + clientId 后重新授权）`);
            throw noRefresh;
          }
          console.error(`[upstreams] ${name} 上游拒绝 token (401/invalid_token)，强制刷新一次并重连（env=${this.environment}）`);
          try {
            if (client) await client.close();
            else if (transport) await transport.close();
          } catch {
            // Ignore cleanup failures; the refresh/reconnect result is what matters.
          }
          client = undefined;
          transport = undefined;
          const freshToken = await this._resolveToken(config, { force: true });
          const authStatus = typeof this._auth.getAuthStatus === 'function'
            ? await this._auth.getAuthStatus(name)
            : null;
          if (authStatus?.status === REAUTH_REQUIRED) {
            // Terminal grant: do not reconnect with a token we know is dead.
            // Report the explicit status instead of pretending another attempt
            // could work. Existing rate limits (one refresh attempt) hold.
            captureEvent('upstream_auth', {
              server: name, phase: 'reauth_required', environment: this.environment,
              status: REAUTH_REQUIRED, reason: authStatus.reason,
            });
            console.error(`[upstreams] ${name} ${REAUTH_REQUIRED}: ${authStatus.reason}`);
          }
          tools = await establish(freshToken); // second (and final) attempt
        }

        this._clients.set(name, { client, transport, config });

        for (const tool of tools) {
          // Some upstreams already prefix their tool names with the server name
          // (e.g. a fake fixture exposing `github__get_file_contents`). Do not
          // stack a second prefix — that would produce `github__github__...`.
          const prefix = `${name}__`;
          const prefixedName = tool.name.startsWith(prefix) ? tool.name : `${prefix}${tool.name}`;
          const entry = {
            server: name,
            tool: tool.name,
            name: prefixedName,
            description: tool.description,
            inputSchema: tool.inputSchema,
            // Preserve upstream annotations so execute_read can decide read-only
            // from the authoritative hint instead of a fragile name regex.
            annotations: tool.annotations,
            _client: client,
          };
          if (isAllowed(config, entry)) this.entries.push(entry);
        }
      } catch (err) {
        // A failed server must not leak its child process / HTTP session.
        try {
          if (client) await client.close();
          else if (transport) await transport.close();
        } catch {
          // Ignore cleanup failures; report the original error only.
        }
        this.failedServers.push(name);
        const e = upstreamError(name, '连接失败', err);
        errors.push(e);
        console.error(`[upstreams] ${e.message}`);
      }
    }));
    if (errors.length > 0) {
      // Keep the gateway alive with whichever upstreams connected. A dead
      // upstream must not make the whole MCP endpoint return 500.
      console.error(`[upstreams] ${errors.length}/${this.configs.length} upstreams failed: ${this.failedServers.join(', ')}`);
    }
  }

  getEntries() {
    return this.entries;
  }

  getWhitelist() {
    // Entries were already filtered at connect time; re-check against the
    // stored config so this remains correct even if entries were added by hand.
    return this.entries.filter((entry) => {
      const config = this._clients.get(entry.server)?.config;
      return !config || isAllowed(config, entry);
    });
  }

  async callTool(server, tool, args) {
    const record = this._clients.get(server);
    if (!record) {
      throw new Error(`[upstream:${server}] 未连接或未配置的上游`);
    }
    // Normalize camelCase aliases against the upstream's ORIGINAL inputSchema
    // (never the Gemini-sanitized one). Every call path funnels through here:
    // Code Mode's codemode.<tool> (codemode.js) AND the direct whitelist /
    // gateway_call handlers (server.js) both call UpstreamManager.callTool.
    const entry = this.entries.find((e) => e.server === server && e.tool === tool);
    const finalArgs = normalizeToolArguments(args, entry?.inputSchema) ?? {};
    const guard = server === 'figma' ? this.figmaGuard : null;
    // Cooldown takes precedence over the cache: once quota is exhausted we do
    // not serve even a cached read, so the agent sees one consistent state.
    if (guard) guard.assertCool();
    if (guard) {
      const hit = guard.get(tool, finalArgs);
      if (hit !== undefined) {
        captureEvent('upstream', {
          server, tool, args: finalArgs, result: hit, cacheHit: true,
          durationMs: 0,
        });
        return hit;
      }
    }
    const started = Date.now();
    try {
      const result = await record.client.callTool({ name: tool, arguments: finalArgs });
      // MCP tool errors arrive as a successful callTool() with `isError: true`;
      // Figma surfaces plan/rate-limit wording there, not as a rejected promise.
      if (guard && result?.isError === true && isFigmaQuotaError(result)) guard.trip();
      captureEvent('upstream', {
        server, tool, args: finalArgs, result,
        durationMs: Date.now() - started,
      });
      if (guard && !result?.isError && guard.isCacheable(tool)) {
        guard.set(tool, finalArgs, result);
      }
      return result;
    } catch (err) {
      if (guard && isFigmaQuotaError(err)) guard.trip();
      captureEvent('upstream', {
        server, tool, args: finalArgs,
        error: { name: err?.name, message: err?.message, stack: err?.stack },
        durationMs: Date.now() - started,
      });
      throw upstreamError(`${server}/${tool}`, '调用失败', err);
    }
  }

  async close() {
    const errors = [];
    for (const [name, { client, transport }] of this._clients) {
      if (this._closed.has(name)) continue;
      try {
        await client.close();
      } catch (err) {
        // Best-effort direct transport shutdown when client.close() failed.
        try {
          await transport?.close();
        } catch {
          // Ignore fallback failures; report the original error only.
        }
        errors.push(upstreamError(name, '关闭失败', err));
      }
      this._closed.add(name);
    }
    if (errors.length > 0) throw aggregate(errors);
  }
}
