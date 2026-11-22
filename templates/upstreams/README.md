# Upstream templates

Verified `servers[]` entries for public MCP servers. Each file is a single
server object: copy it into your config's `servers` array (or into a minimal
config), then export the env vars it names.

These were checked against **official docs** in November 2026. Endpoints and
auth requirements can change; verify against the linked docs before relying on
them. Nothing here contains credentials.

| Template | Endpoint | Auth | Notes |
|---|---|---|---|
| `slack.json` | `https://mcp.slack.com/mcp` | OAuth (pre-registered Slack app) | Streamable HTTP; Slack does **not** support DCR. Use a user token from your Slack app's OAuth flow. Long-lived user tokens work as a static Bearer; rotation needs client id + secret, which is not preconfigured here. |
| `twilio-docs.json` | `https://mcp.twilio.com/docs` | none | Read-only public API-docs server (Public Beta). No Twilio account or token needed. |
| `zapier.json` | `https://mcp.zapier.com/api/v1/connect` | static Bearer | Create a server at `mcp.zapier.com` and use its connection token. |
| `cloudflare.json` | `https://mcp.cloudflare.com/mcp` | OAuth or static Bearer | Cloudflare API MCP (Code Mode). OAuth for interactive use; an API token works as a Bearer header for automation. |
| `stripe.json` | `https://mcp.stripe.com` | OAuth DCR or agent API key | OAuth is preferred; agent API keys are explicitly supported as Bearer tokens. Not all-agent API keys remain valid after Jan 11, 2027 (see docs). |
| `supabase.json` | `https://mcp.supabase.com/mcp` | OAuth DCR or PAT | DCR by default; a personal access token works as a Bearer header for CI. Consider `?project_ref=...&read_only=true` URL parameters. |
| `neon.json` | `https://mcp.neon.tech/mcp` | OAuth DCR or API key | API key works as a Bearer header; add `?readonly=true` / `?projectId=...` to scope access. |
| `google-drive.json` | `https://drivemcp.googleapis.com/mcp/v1` | OAuth 2.0 + refresh | Requires your own Google OAuth client with "Let AI agents use this client" and `access_type=offline`. The refresh flow needs the client id **and secret** (`clientSecretEnv`). |

## Sources

- Slack: <https://docs.slack.dev/ai/slack-mcp-server/> — "All requests should be sent to: https://mcp.slack.com/mcp … We do not support … Dynamic Client Registration at this time."
- Twilio: <https://www.twilio.com/docs/ai/mcp> — "Hosted MCP server | `https://mcp.twilio.com/docs` | None".
- Zapier: <https://docs.zapier.com/mcp/get-started/connect/other> — connection token to `https://mcp.zapier.com/api/v1/connect` as `Authorization: Bearer`.
- Cloudflare: <https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/> — endpoint `https://mcp.cloudflare.com/mcp`; API token as Bearer for automation.
- Stripe: <https://docs.stripe.com/mcp> — endpoint `https://mcp.stripe.com`; agent API key as Bearer token.
- Supabase: <https://supabase.com/docs/guides/ai-tools/mcp> — endpoint `https://mcp.supabase.com/mcp`; DCR by default, PAT as Bearer for CI.
- Neon: <https://neon.com/docs/ai/neon-mcp-server> — endpoint `https://mcp.neon.tech/mcp`; OAuth or API key Bearer.
- Google Workspace: <https://developers.google.com/workspace/guides/configure-mcp-servers> — per-product endpoints (`https://drivemcp.googleapis.com/mcp/v1` for Drive), OAuth 2.0 with refresh tokens.

## Why some candidates are missing

- **Atlassian Rovo MCP** (`https://mcp.atlassian.com/v2/mcp`) is verified, but its
  OAuth client is confidential and token refresh specifics vary; a static token
  expires quickly. Add `refreshUrl` + `clientSecretEnv` once you confirm the
  token endpoint for your OAuth app.
- **Microsoft 365** remote MCP endpoints are tenant-scoped
  (`agent365.svc.cloud.microsoft/agents/tenants/{tenant_id}/...`), so there is no
  universal template.
- **Sentry** (https://mcp.sentry.dev/mcp, OAuth/DCR only) and **Figma** (https://mcp.figma.com/mcp, auth mode not officially documented) have no static-token template yet.
- Providers whose MCP server needs a pre-registered OAuth client with a client
  secret can use the generic refresh path: `refreshEnv`, `clientIdEnv`,
  `clientSecretEnv`, `refreshUrl`.
