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
import { UpstreamAuth, defaultProvider } from './upstream-auth.js';
import { normalizeToolArguments } from './sanitize.js';

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

/** Wrap any failure with the upstream name so logs point at the right server. */
function upstreamError(name, action, err) {
  const error = new Error(`[upstream:${name}] ${action}: ${messageOf(err)}`);
  error.cause = err;
  return error;
}

function aggregate(errors) {
  return new AggregateError(errors, errors.map((error) => error.message).join('; '));
}

export class UpstreamManager {
  constructor(configs = [], options = {}) {
    this.configs = Array.isArray(configs) ? configs : [];
    /** @type {Array<{server:string, tool:string, name:string, description?:string, inputSchema?:object, _client:Client}>} */
    this.entries = [];
    /** server name -> { client, transport, config } */
    this._clients = new Map();
    this._closed = new Set();
    this._auth = options.auth ?? new UpstreamAuth();
    // Test seam: inject a fake MCP client without touching the real SDK.
    this._clientFactory = options.clientFactory ?? (() => new Client(CLIENT_INFO));
  }

  async _resolveToken(config, { force = false } = {}) {
    if (!config.tokenEnv) return undefined;
    const envToken = process.env[config.tokenEnv];
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
          client = this._clientFactory();
          await client.connect(transport);
          const { tools } = await client.listTools();
          return tools ?? [];
        };

        let tools;
        try {
          tools = await establish();
        } catch (err) {
          // A 401/invalid_token is the provider telling us our locally "fresh"
          // token is actually dead. This feedback loop is the only reliable
          // liveness signal — local expiry timestamps cannot be trusted. Force
          // exactly one refresh (through UpstreamAuth's lock/CAS/needsReauth
          // guards) and reconnect exactly once. invalid_grant / other errors
          // never take this path, so a dead grant cannot be burned by retries.
          if (!isAuthError(err) || !providerFor(config)?.tokenUrl) throw err;
          console.error(`[upstreams] ${name} 上游拒绝 token (401/invalid_token)，强制刷新一次并重连`);
          try {
            if (client) await client.close();
            else if (transport) await transport.close();
          } catch {
            // Ignore cleanup failures; the refresh/reconnect result is what matters.
          }
          client = undefined;
          transport = undefined;
          const freshToken = await this._resolveToken(config, { force: true });
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
    try {
      return await record.client.callTool({ name: tool, arguments: finalArgs });
    } catch (err) {
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
