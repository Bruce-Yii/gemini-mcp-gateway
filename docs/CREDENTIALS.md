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
| Static Basic credential | `tokenEnv` + `authScheme: "basic"` | Env value is the pre-encoded `base64(user:token)` |`n| Static provider scheme | `tokenEnv` + `authScheme: "Sentry-Bearer"` (or similar) | The scheme is sent verbatim before the token |
| OAuth + refresh | `tokenEnv` + `refreshEnv` + `clientIdEnv` (+ `clientSecretEnv`) + `refreshUrl` | The gateway refreshes before expiry and persists rotated tokens in KV |
| Upstream OAuth/DCR (gateway as OAuth client) | — | **Not implemented.** You must obtain the token yourself; only viable when you also have client id/secret for refresh |

## Slack

Endpoint: `https://mcp.slack.com/mcp` (Streamable HTTP). Slack does **not**
support dynamic client registration. The docs require the MCP client to be
backed by a registered Slack app with a **fixed app ID**; only internal or
directory-published apps may use the MCP server.

1. Create an internal Slack app (from `api.slack.com/apps`) for your workspace,
   or use a directory-published one.
2. Add the OAuth **user** scopes listed in the official scopes table (channel,
   message, search, canvas, file, reactions, users and lists scopes). The table
   is authoritative; check it before installing.
3. Install the app to the workspace, complete the OAuth consent
   (`https://slack.com/oauth/v2_user/authorize`), and take the user access token.
4. Configure `templates/upstreams/slack.json` and export
   `SLACK_MCP_USER_TOKEN`.

App identity: the gateway acts as the MCP client and uses your registered app's
**fixed client id/secret** for OAuth — that app is the identity Slack requires.
No DCR is involved.

Refresh: the token endpoint is `https://slack.com/api/oauth.v2.user.access`.
If your app uses token rotation, put the refresh token, client id and client
secret in the template's `SLACK_MCP_*` env vars and the gateway will refresh it;
otherwise the static user token works until revoked.

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

Endpoint: `https://mcp.sentry.dev/mcp`. Besides OAuth, Sentry documents a remote
path for clients that can send custom headers: pass a **Sentry user auth token**
as `Authorization: Sentry-Bearer <token>`. That is exactly what the template
does; the worker does not refresh or store the token, so it must be long-lived
(revoke it when no longer needed).

1. Create a User Auth Token in Sentry with the documented scopes
   (`org:read`, `project:read`, `project:write`, `team:read`, `team:write`,
   `event:write` — check the current list in the Sentry MCP README).
2. Export it as `SENTRY_ACCESS_TOKEN` and use
   `templates/upstreams/sentry.json` (`authScheme: "Sentry-Bearer"`).

## Figma

Endpoint: `https://mcp.figma.com/mcp`. The official docs describe an OAuth login
flow (plus enterprise-managed authorization), but no static token and no
documented way for a third-party gateway to register itself. Our gateway does
not run an upstream OAuth client, so Figma is unsupported until Figma documents
a token path a gateway can use.

## Providers with simple API tokens

These are the easiest to onboard and already have templates: Cloudflare (API
token), Stripe (agent API key), Supabase (PAT), Neon (API key), Zapier
(connection token), Twilio (no auth). See `templates/upstreams/`.
