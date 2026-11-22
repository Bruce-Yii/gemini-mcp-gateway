# Adding an upstream

The gateway is upstream-agnostic: it connects to any MCP server that speaks
**Streamable HTTP** or **stdio**, pulls its tool list, and exposes the tools to
the model through the three Code Mode tools. Adding a server is configuration,
not code.

## 1. Add a config entry

Copy `config.example.json`, then add one object to `servers` (see `examples/`
for complete files):

```json
{
  "name": "my-upstream",
  "transport": "http",
  "url": "https://mcp.example.com/mcp",
  "tokenEnv": "MY_UPSTREAM_TOKEN"
}
```

`name` is the public namespace (`my-upstream__tool_name` inside the sandbox), so
keep it short and stable: renaming it changes every callable identifier.

## 2. Provide credentials

The gateway never reads secrets from config files. Point `tokenEnv` at an
environment variable and export the token there. Upstreams whose env var is
unset are **skipped** at startup (the rest of the gateway keeps working).

OAuth-refresh upstreams also set `refreshEnv`, `clientIdEnv`, and optionally
`expiresInEnv` / `obtainedAtEnv`; see [Auth patterns](#auth-patterns).

## 3. Verify

```bash
node scripts/check-config.mjs my.json      # schema + env warnings
npm start -- --config my.json              # local server on :3000/mcp
node scripts/smoke.mjs                     # fake upstream smoke test (unrelated)
```

Then connect an MCP client and run a task that requires the new tools. A quick
sanity check is to search for one of its tool names:

```json
{"query": "select:<name>__<tool>"}
```

## Config reference

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | Namespace used in `server__tool` identifiers (`[A-Za-z0-9_-]{1,32}`, unique) |
| `transport` | yes | `http` (Streamable HTTP) or `stdio` |
| `url` | http | MCP endpoint URL (absolute `http(s)`) |
| `command` / `args` | stdio | Executable + argument list |
| `env` | stdio | Extra environment variables for the child process (string map) |
| `headers` | http | Extra request headers (string map); do not put secrets here — use `tokenEnv` |
| `tokenEnv` | http | Env var holding a Bearer token |
| `tokenHeader` | no | Header name for the raw token instead of `Authorization` (e.g. Figma's `X-Figma-Token`) |
| `authScheme` | no | HTTP auth scheme for `tokenEnv`: `bearer` (default), `basic`, or a provider scheme such as `Sentry-Bearer` |
| `refreshEnv`, `clientIdEnv` | OAuth | Refresh token + public OAuth client id env vars |
| `clientSecretEnv` | OAuth | Client secret env var, for confidential OAuth clients (Google/Slack/etc.) |
| `expiresInEnv`, `obtainedAtEnv` | OAuth | Optional token lifetime + real issuance time; used to compute expiry honestly |
| `refreshUrl` | OAuth | Token endpoint for non-built-in providers (built-ins: Notion, Linear) |
| `authorizeUrl` | OAuth (gateway-initiated) | Authorization endpoint; enables `/upstream/oauth/start` for this server |
| `oauthScopes` | OAuth (gateway-initiated) | Array of scopes sent to the authorization endpoint |
| `oauthRedirectUri` | no | Explicit callback URL; default is `<base>/upstream/oauth/callback` |
| `allowTools` | no | Allowlist. Empty/absent = all tools. Patterns: `tool`, `server/tool`, `server/*` |
| `denyTools` | no | Denylist, applied before `allowTools`. Same pattern syntax |

Top-level options: `mode` (`codemode` default, or legacy `whitelist`),
`maxWhitelistTools`, `maxCalls` (per `execute`, default 50), `maxResultChars`
(result projection cap).

## Auth patterns

**Static bearer token (most common).** PAT/API token in an env var:

```json
{ "name": "github", "transport": "http", "url": "https://api.githubcopilot.com/mcp/", "tokenEnv": "GITHUB_TOKEN" }
```

**Static Basic / custom scheme.** Set `authScheme` and put the credential in the
env var. `basic` takes `base64(user:token)`; a provider-specific scheme is sent
verbatim (e.g. Sentry's `Sentry-Bearer`):

```json
{ "name": "atlassian", "transport": "http", "url": "https://mcp.atlassian.com/v2/mcp?tools=all", "tokenEnv": "ATLASSIAN_BASIC_TOKEN", "authScheme": "basic" }
```

Credential acquisition for providers that need app registration/OAuth is
documented in [CREDENTIALS.md](CREDENTIALS.md). For a Vercel deployment the
gateway can also run the authorization-code flow itself: set
`UPSTREAM_OAUTH_ADMIN_KEY`, add `authorizeUrl` + `refreshUrl` + `clientIdEnv` to
the server, then open
`/upstream/oauth/start?server=<name>&key=<UPSTREAM_OAUTH_ADMIN_KEY>`.

**Static headers.** For servers that need extra headers. Keep secrets in env
vars if the server supports templating; otherwise this field is best for
non-secret identifiers.

**OAuth refresh (built-in).** Notion and Linear have their token endpoints
built in; set the env vars:
```json
{
  "name": "notion", "transport": "http", "url": "https://mcp.notion.com/mcp",
  "tokenEnv": "NOTION_TOKEN", "refreshEnv": "NOTION_REFRESH_TOKEN",
  "clientIdEnv": "NOTION_CLIENT_ID", "expiresInEnv": "NOTION_EXPIRES_IN",
  "obtainedAtEnv": "NOTION_OBTAINED_AT"
}
```

Seed the token pair into the hosted KV store (needed for cold instances to
refresh): `GEMINI_GATEWAY_TOKENS_DIR=~/.gemini-gateway-tokens node scripts/seed-upstream-tokens.mjs`.

**OAuth refresh (any other provider).** Add `refreshUrl` (token endpoint) and
the same env fields; the refresh lifecycle (lock, CAS fencing, invalid_grant
terminal state) is provider-agnostic. Confidential clients also set
`clientSecretEnv`; the secret is sent to the token endpoint only:

```json
{
  "name": "acme", "transport": "http", "url": "https://mcp.acme.example/mcp",
  "tokenEnv": "ACME_TOKEN", "refreshEnv": "ACME_REFRESH_TOKEN",
  "clientIdEnv": "ACME_CLIENT_ID", "clientSecretEnv": "ACME_CLIENT_SECRET",
  "refreshUrl": "https://auth.acme.example/token"
}
```

Verified drop-in entries for public servers (Slack, Twilio, Zapier, Google
Drive) live in [`templates/upstreams/`](../templates/upstreams/README.md); copy one
into `servers` and export its env vars.

The token endpoint must accept the standard `grant_type=refresh_token` form
(`refresh_token`, `client_id`) and return `access_token` (+ rotating
`refresh_token`, `expires_in`). If your provider needs a client secret or a
different body, the generic path does not fit yet — open an issue.

**stdio.** For local MCP servers spawned as a child process:

```json
{ "name": "local", "transport": "stdio", "command": "node", "args": ["path/to/server.mjs"], "env": { "FOO": "bar" } }
```

## What the gateway does with the tools

- Names them `name__tool` (double underscore) so clients that split on the first
  underscore keep them intact.
- Carries upstream `readOnlyHint`/`destructiveHint` annotations through; the
  read-only sandbox (`execute_read`) filters on them.
- Runs every input schema through `sanitizeTool` before it can reach a Gemini
  client (arrays get `items`, multi-types collapse, deep `oneOf` truncates).
- Indexes names/descriptions for `search`; complex tools remain reachable via
  `select:<name>` for the full JSON Schema.
- Never changes the outer MCP tool surface: adding or removing an upstream only
  changes what the sandbox can call, not the client's tool list — no reconnect
  required.

## Figma quota breaker & read cache

The `figma` upstream gets two extra guardrails in `src/figma-guard.js` (wired
into `UpstreamManager.callTool`). No other server is affected.

- **Quota cooldown.** If a Figma `callTool` fails with plan-limit / rate-limit
  wording (`Figma MCP tool call limit`, `Starter plan`, `upgrade your plan`,
  `429`, `rate limit` — case-insensitive, also detected inside MCP
  `isError: true` results), the manager opens a cooldown. Until it expires,
  every subsequent Figma call throws
  `FigmaQuotaCooldownError` (`Figma 配额冷却中（剩余 N 秒）`,
  `code: "FIGMA_QUOTA_COOLDOWN"`) without touching the upstream.
  Tripping the breaker also clears the Figma read cache.
- **Read cache.** Successful results of the two read-only tools `whoami` and
  `get_metadata` are cached by tool name + canonical JSON args. Writes and
  error results are never cached; the cooldown takes priority over a cache hit.
- **Environment variables:** `FIGMA_COOLDOWN_MS` (default `86400000` = 24h),
  `FIGMA_CACHE_TTL_MS` (default `3600000` = 1h),
  `FIGMA_CACHE_MAX` (default `200` entries, LRU eviction).
- **Limitations:** state is in-memory per `UpstreamManager` instance. On
  serverless (Vercel) every warm instance keeps its own cooldown and cache, and
  a cold start begins with a clean slate — there is no cross-instance
  coordination, so a freshly warmed instance may still spend quota once after
  another instance has tripped. No persistent storage is used.

Tests: `tests/figma-guard.test.js` (fake client, no network, no credentials).

## Verification checklist

1. `npm run check:config -- my.json` — no errors, expected warnings only.
2. `npm start -- --config my.json` starts and logs the connected/failed upstream
   list.
3. `search` for a known tool; `select:` returns its schema.
4. A read-only `execute_read` call returns real data.
5. A write tool call (if the upstream has one) works from `execute` and is
   annotated so clients can ask for confirmation.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Upstream missing from `search` | Its `tokenEnv` env var is unset, or `denyTools` filters everything |
| `http 上游环境变量 X 未设置` | Export the token env var |
| `unknown transport` | Only `http` (Streamable HTTP) and `stdio` are supported; SSE-only servers are not |
| 401 after a while | OAuth token expired and no refresh path: add `refreshEnv` + `refreshUrl` and re-seed KV |
| Refresh loop / `invalid_grant` | Grant was burned by concurrent refreshes or a stale KV copy; re-authorize and re-seed (the gateway stops retrying a dead grant) |
| Tools listed twice / weird names | Upstream already prefixes tool names with `server__`; the gateway detects that |
