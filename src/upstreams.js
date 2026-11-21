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
import { UpstreamAuth } from './upstream-auth.js';
import { normalizeToolArguments } from './sanitize.js';

const CLIENT_INFO = { name: 'gemini-mcp-gateway', version: '0.1.0' };
/** Upstreams whose OAuth access tokens expire and need auto-refresh. */
const PROVIDER_REFRESH_SERVERS = new Set(['notion', 'linear']);

function messageOf(err) {
  return err instanceof Error ? err.message : String(err);
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
  }

  async _resolveToken(config) {
    if (!config.tokenEnv) return undefined;
    const envToken = process.env[config.tokenEnv];
    if (!PROVIDER_REFRESH_SERVERS.has(config.name)) return envToken; // long-lived token
    // Notion/Linear: go through the refresh-aware lifecycle.
    return this._auth.getAccessToken(config.name, {
      envToken,
      envRefresh: config.refreshEnv ? process.env[config.refreshEnv] : undefined,
      envClientId: config.clientIdEnv ? process.env[config.clientIdEnv] : undefined,
      envExpiresIn: config.expiresInEnv ? Number(process.env[config.expiresInEnv]) : undefined,
      envObtainedAt: config.obtainedAtEnv ? Number(process.env[config.obtainedAtEnv]) : undefined,
    });
  }

  async _createTransport(config) {
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
        const token = await this._resolveToken(config);
        if (!token) {
          throw new Error(`http 上游环境变量 ${config.tokenEnv} 未设置`);
        }
        headers.Authorization = `Bearer ${token}`;
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
        transport = await this._createTransport(config);
        client = new Client(CLIENT_INFO);
        await client.connect(transport);

        const { tools } = await client.listTools();
        this._clients.set(name, { client, transport, config });

        for (const tool of tools ?? []) {
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
