# Upstream templates

`servers[]` entries for public MCP servers, checked against official docs. Each
file is a single server object: copy it into your config's `servers` array (or
into a minimal config), then export the env vars it names.

These were checked against **official docs** in November 2026. Endpoints and
auth requirements can change; verify against the linked docs before relying on
them. Nothing here contains credentials. Per-provider credential acquisition is
documented in [docs/CREDENTIALS.md](../../docs/CREDENTIALS.md).

| Template | Endpoint | Auth | Notes |
|---|---|---|---|
| `slack.json` | `https://mcp.slack.com/mcp` | OAuth (registered Slack app) | Verified: Streamable HTTP, confidential OAuth, **no DCR**; only internal or directory-published apps may use MCP. Use your app's fixed client id/secret; refresh is optional (`refreshEnv` + `clientSecretEnv`). |
| `sentry.json` | `https://mcp.sentry.dev/mcp` | Static token via `Sentry-Bearer` | Sentry documents a remote path for clients that can send custom headers: `Authorization: Sentry-Bearer <user-token>`. Create a user auth token with the documented scopes; it is long-lived and not stored/refreshed by the worker. |
| `atlassian-service-account.json` | `https://mcp.atlassian.com/v2/mcp?tools=all` | API key (Bearer) | Rovo MCP for Jira/Confluence. The `?tools=all` query parameter is required for gateways that need the complete tool list. Or use the personal-token variant below. |
| `atlassian-personal-token.json` | `https://mcp.atlassian.com/v2/mcp?tools=all` | API token (Basic) | Same endpoint; `authScheme: "basic"` with `base64(email:token)` in the env var. Your org admin must enable API-token auth. |
| `twilio-docs.json` | `https://mcp.twilio.com/docs` | none | Read-only public API-docs server (Public Beta). No Twilio account or token needed. |
| `zapier.json` | `https://mcp.zapier.com/api/v1/connect` | static Bearer | Create a server at `mcp.zapier.com` and use its connection token. |
| `cloudflare.json` | `https://mcp.cloudflare.com/mcp` | OAuth or static Bearer | Cloudflare API MCP (Code Mode). OAuth for interactive use; an API token works as a Bearer header for automation. |
| `stripe.json` | `https://mcp.stripe.com` | OAuth DCR or agent API key | OAuth is preferred; agent API keys are explicitly supported as Bearer tokens. Not all-agent API keys remain valid after Jan 11, 2027 (see docs). |
| `supabase.json` | `https://mcp.supabase.com/mcp` | OAuth DCR or PAT | DCR by default; a personal access token works as a Bearer header for CI. Consider `?project_ref=...&read_only=true` URL parameters. |
| `neon.json` | `https://mcp.neon.tech/mcp` | OAuth DCR or API key | API key works as a Bearer header; add `?readonly=true` / `?projectId=...` to scope access. |
| `google-drive.json` | `https://drivemcp.googleapis.com/mcp/v1` | OAuth 2.0 + refresh | Requires your own Google OAuth client with "Let AI agents use this client" and `access_type=offline`. The refresh flow needs the client id **and secret** (`clientSecretEnv`). |
| `figma-desktop.json` | `http://127.0.0.1:3845/mcp` | none (localhost) | **Local gateway only.** Figma's desktop MCP server runs on the machine with the Figma desktop app; a hosted gateway (Vercel) cannot reach it. |
| `figma-oauth.json` | `https://mcp.figma.com/mcp` | OAuth via gateway | Requires a Figma OAuth app (`FIGMA_CLIENT_ID`/`FIGMA_CLIENT_SECRET`), a registered callback, and `UPSTREAM_OAUTH_ADMIN_KEY` on the gateway. Figma may still reject non-catalog clients; use the status page to confirm. |

## Sources

- Slack: <https://docs.slack.dev/ai/slack-mcp-server/> — "All requests should be sent to: https://mcp.slack.com/mcp … We do not support … Dynamic Client Registration at this time." App identity: "MCP clients must be backed by a registered Slack app with a fixed app ID and hardcode that app ID."
- Sentry: <https://github.com/getsentry/sentry-mcp> — remote clients "can pass an upstream Sentry API token directly … `Authorization: Sentry-Bearer ${SENTRY_ACCESS_TOKEN}`"; the worker does not refresh it.
- Atlassian: <https://developer.atlassian.com/cloud/rovo-mcp/guides/getting-started/> and <https://developer.atlassian.com/cloud/rovo-mcp/guides/configuring-authentication-via-api-token/> — `?tools=all` for gateways; service-account API key (Bearer) and personal API token (Basic).
- Twilio: <https://www.twilio.com/docs/ai/mcp> — "Hosted MCP server | `https://mcp.twilio.com/docs` | None".
- Zapier: <https://docs.zapier.com/mcp/get-started/connect/other> — connection token to `https://mcp.zapier.com/api/v1/connect` as `Authorization: Bearer`.
- Cloudflare: <https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/> — endpoint `https://mcp.cloudflare.com/mcp`; API token as Bearer for automation.
- Stripe: <https://docs.stripe.com/mcp> — endpoint `https://mcp.stripe.com`; agent API key as Bearer token.
- Supabase: <https://supabase.com/docs/guides/ai-tools/mcp> — endpoint `https://mcp.supabase.com/mcp`; DCR by default, PAT as Bearer for CI.
- Neon: <https://neon.com/docs/ai/neon-mcp-server> — endpoint `https://mcp.neon.tech/mcp`; OAuth or API key Bearer.
- Google Workspace: <https://developers.google.com/workspace/guides/configure-mcp-servers> — per-product endpoints (`https://drivemcp.googleapis.com/mcp/v1` for Drive), OAuth 2.0 with refresh tokens.
- Figma: <https://developers.figma.com/docs/figma-mcp-server/> and <https://help.figma.com/hc/en-us/articles/39216419318551> — remote server is OAuth/DCR and "Only clients listed in the Figma MCP catalog … can connect"; desktop server runs at `http://127.0.0.1:3845/mcp`.

## Why some candidates are missing

- **Microsoft 365** remote MCP endpoints are tenant-scoped
  (`agent365.svc.cloud.microsoft/agents/tenants/{tenant_id}/...`), so there is no
  universal template. See [docs/CREDENTIALS.md](../../docs/CREDENTIALS.md).
- **Figma remote** (`https://mcp.figma.com/mcp`): OAuth 2.0 with dynamic client
  registration, but Figma only allows MCP clients listed in its catalog; a
  third-party gateway registration returns `403 Forbidden`, and new clients must
  join Figma's waitlist. **Figma desktop** (`http://127.0.0.1:3845/mcp`) works
  without OAuth but only from a gateway on the same machine (see
  `figma-desktop.json`).
- **Google Workspace** has a template for Drive, but its refresh flow needs a
  Google OAuth client with a client secret (see `clientSecretEnv`).
- Providers whose MCP server needs a pre-registered OAuth client with a client
  secret can use the generic refresh path: `refreshEnv`, `clientIdEnv`,
  `clientSecretEnv`, `refreshUrl`.
