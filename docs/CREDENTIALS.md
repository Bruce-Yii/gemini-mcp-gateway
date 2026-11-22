# Getting upstream credentials

The gateway does **not** implement OAuth acquisition for upstream services. It
connects with whatever credential you provide (env var, optionally refreshed
with a refresh token). This page explains how to obtain credentials for the
upstreams that need more than a simple PAT, and what is supported today.

Nothing here should be committed. Put values in environment variables only.

## Token models supported by the gateway

| Model | Config | Notes |
|---|---|---|
| Static bearer / API token | `tokenEnv` | Simplest; PAT/API keys that do not expire quickly |
| Static Basic credential | `tokenEnv` + `authScheme: "basic"` | Env value is the pre-encoded `base64(user:token)` |
| OAuth + refresh | `tokenEnv` + `refreshEnv` + `clientIdEnv` (+ `clientSecretEnv`) + `refreshUrl` | The gateway refreshes before expiry and persists rotated tokens in KV |
| Upstream OAuth/DCR (gateway as OAuth client) | — | **Not implemented.** You must obtain the token yourself; only viable when you also have client id/secret for refresh |

## Slack

Endpoint: `https://mcp.slack.com/mcp` (Streamable HTTP). Slack does **not**
support dynamic client registration; MCP clients must be backed by a registered
Slack app.

1. Create a Slack app (from `api.slack.com/apps`) that is internal to your
   workspace (or a published app if you need one).
2. Add OAuth **user** scopes for the MCP server. The official docs list them:
   `channels:history`, `channels:read`, `chat:write`, `files:read`, `files:write`,
   `groups:history`, `groups:read`, `im:history`, `im:read`, `mpim:history`,
   `mpim:read`, `search:read`, `users:read`, `users:read.email`, `canvases:read`,
   `canvases:write`, `reactions:read`, `reactions:write`, `team:read`.
3. Install the app to the workspace, complete the OAuth consent, and take the
   user access token.
4. Configure the template (`templates/upstreams/slack.json`) and export
   `SLACK_MCP_USER_TOKEN`.

Refresh: if your Slack app uses **token rotation**, the OAuth response also
contains a refresh token. The gateway can refresh it by setting `refreshEnv`,
`clientIdEnv`, `clientSecretEnv` and `refreshUrl:
https://slack.com/api/oauth.v2.user.access` — verify the token endpoint for your
app before relying on it.

**Caveat:** the docs require the MCP client to be backed by a Slack app with a
fixed app id, but do not specify how a third-party gateway presents that app
identity. The endpoint and OAuth flow are verified; a gateway-as-MCP-client
handshake is not. Treat the Slack template as **experimental** until tested with
a real token.

## Atlassian Rovo MCP (Jira/Confluence)

Endpoint: `https://mcp.atlassian.com/v2/mcp`. **A gateway must add
`?tools=all`** — the plain endpoint uses dynamic discovery, and Atlassian
explicitly documents the query parameter for gateways that need a complete,
paginated tool list.

Two non-interactive options (your org admin must enable API-token auth):

- **Service account API key (Bearer)** — recommended for a gateway. Create a
  service account API key with the `agent-interface` scopes for the apps you
  need (Jira `read/write/search/delete/manage:jira:agent-interface`,
  Confluence `read/write/search:confluence:agent-interface`, etc.), then export
  it as `ATLASSIAN_MCP_API_KEY` and use
  `templates/upstreams/atlassian-service-account.json`.
- **Personal API token (Basic)** — create a token at
  `id.atlassian.com/manage-profile/security/api-tokens` with the same scopes,
  then encode `email:token` as base64 and export it as `ATLASSIAN_BASIC_TOKEN`;
  use `templates/upstreams/atlassian-personal-token.json` (sets
  `authScheme: "basic"`).

OAuth 2.1 is the interactive option: obtain an access token through your OAuth
app and pass it via `tokenEnv`. For refresh, add
`refreshUrl: https://auth.atlassian.com/oauth/token` plus client id/secret —
confirm the refresh response against your OAuth app before relying on it.

## Sentry

Endpoint: `https://mcp.sentry.dev/mcp`, OAuth-based (dynamic client
registration). There is **no documented static token** for this server, and the
gateway does not run an upstream OAuth client, so there is no supported template
yet. If Sentry exposes a long-lived token for your account, configure it like any
static bearer; otherwise this upstream waits for the upstream-OAuth helper.

## Figma

Endpoint: `https://mcp.figma.com/mcp`, but the official docs do not state whether
it uses DCR or a pre-registered OAuth app. No template until that is verified.

## Providers with simple API tokens

These are the easiest to onboard and already have templates: Cloudflare (API
token), Stripe (agent API key), Supabase (PAT), Neon (API key), Zapier
(connection token), Twilio (no auth). See `templates/upstreams/`.
