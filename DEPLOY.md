# Deploying gemini-mcp-gateway

This guide deploys the gateway as a **single-user** service on Vercel: one
MCP endpoint (`/mcp`), OAuth 2.1 authorization, and Upstash Redis for
client/token storage. The same code also runs locally (`npm start`); Vercel is
just the reference deployment.

> **Do not share a deployment between users.** The gateway holds the upstream
> tokens you give it. One deployment = one owner. See
> [SECURITY.md](SECURITY.md).

## Prerequisites

- A Vercel account (Hobby is enough for personal use; runtime logs are retained
  for 1 hour on Hobby).
- An Upstash Redis database attached via the Vercel Marketplace (free tier is
  enough).
- Upstream credentials (see [Upstream tokens](#upstream-tokens)).

## 1. Import the repository

- Vercel → **Add New → Project → Import** this repository.
- Framework preset: **Other** (`vercel.json` sets `framework: null`).
- Root directory: repository root.
- Leave Build Command / Output Directory at their defaults — `vercel.json` runs
  `node scripts/write-build-info.mjs && npm run build --if-present`.
- Deploy. It can boot without environment variables, but `/mcp` will not work
  until KV and tokens are configured.

## 2. Create the KV store

- Project → **Storage → Create Database → Upstash Redis** (Marketplace).
- Vercel injects `KV_REST_API_URL` and `KV_REST_API_TOKEN`. Confirm both exist
  under **Settings → Environment Variables** for Production (and Preview if you
  use it).

## 3. Set environment variables

| Variable | Value |
|---|---|
| `PUBLIC_BASE_URL` | Your deployment origin, no trailing slash, e.g. `https://<your-app>.vercel.app` |
| `ALLOWED_CLIENT_ID` | **Required.** A client id you generate, e.g. `gmc_` + random hex |
| `ALLOWED_CLIENT_SECRET` | Strongly recommended. A random secret (32+ bytes) |
| `GITHUB_TOKEN` | GitHub MCP bearer token (PAT or Copilot token) |
| `NOTION_TOKEN` / `NOTION_REFRESH_TOKEN` / `NOTION_CLIENT_ID` / `NOTION_EXPIRES_IN` / `NOTION_OBTAINED_AT` | Notion upstream credentials (optional if you do not connect Notion) |
| `LINEAR_TOKEN` / `LINEAR_REFRESH_TOKEN` / `LINEAR_CLIENT_ID` / `LINEAR_EXPIRES_IN` / `LINEAR_OBTAINED_AT` | Linear upstream credentials (optional) |
| `VERCEL_TOKEN` | Vercel MCP bearer token (optional) |
| `GATEWAY_CONFIG` / `UPSTREAMS_JSON` | Optional inline config override; normally leave unset to use `config.example.json` |
| `UPSTREAM_OAUTH_ADMIN_KEY` | Optional. Random admin secret; enables `/upstream/oauth/start` for servers with `authorizeUrl` (see `docs/CREDENTIALS.md`) |

Setting `ALLOWED_CLIENT_ID` locks the gateway to one pre-registered OAuth
client **and disables dynamic client registration**. Without it, DCR is open to
anyone on the internet (the redirect allowlist only accepts Google-hosted
redirect URIs). Treat `ALLOWED_CLIENT_SECRET` like any other secret: never commit
it, store it as a Vercel sensitive environment variable.

Generate values locally, for example:

```bash
node -e "const c=require('node:crypto');console.log('gmc_'+c.randomBytes(16).toString('hex'));console.log(c.randomBytes(32).toString('base64url'))"
```

## 4. Redeploy

After adding variables: **Deployments → latest → Redeploy** (build cache is
fine). Commits to `main` trigger automatic deployments once the project is
connected to the repository.

## 5. Verify

Replace `<BASE>` with `PUBLIC_BASE_URL`:

| Check | Expected |
|---|---|
| `GET <BASE>/healthz` | `200` JSON with `commit`, `buildHash`, `mode`, `servers` |
| `GET <BASE>/.well-known/oauth-authorization-server` | `200` JSON, has `registration_endpoint` |
| `GET <BASE>/.well-known/oauth-protected-resource` | `200` JSON |
| `POST <BASE>/oauth/register` (when locked) | `403 dynamic client registration is disabled` |
| `POST <BASE>/mcp` without auth | `401` with `WWW-Authenticate: Bearer resource_metadata=".../oauth-protected-resource"` |

`/healthz`'s `buildHash` can be compared with a local checkout:
`node scripts/write-build-info.mjs --print`.

## 6. Connect Gemini

1. `gemini.google.com` → **Settings → Connected Apps → Custom apps → Add**.
2. MCP server URL: `<BASE>/mcp`.
3. Open **Advanced features → Show more** and enter your `ALLOWED_CLIENT_ID` and
   `ALLOWED_CLIENT_SECRET` (locked mode requires them).
4. Approve the consent page, then try: *"List my GitHub repositories."*

Google currently limits custom apps to personal Google accounts, 18+, in the
US, with English UI — this is a Gemini-side restriction.

## Upstream tokens

This repository does **not** implement OAuth acquisition for upstream services.
You need to provide tokens yourself:

- **GitHub**: fine-grained PAT (Contents/Issues/Pull requests as needed) or a
  Copilot token, passed as `GITHUB_TOKEN`. The bundled config points at
  `https://api.githubcopilot.com/mcp/`; change `url` in the config if you use a
  different endpoint.
- **Vercel**: an account token with access to the team/projects you want the
  model to see, passed as `VERCEL_TOKEN`.
- **Notion / Linear**: access token + refresh token + client id. You can obtain
  them through the respective MCP OAuth flow or your own integration, then seed
  them into the deployed KV store:

```bash
# Writes ~/.gemini-gateway-tokens/{notion,linear}.json into KV using
# KV_REST_API_URL / KV_REST_API_TOKEN. Never prints token values.
node scripts/seed-upstream-tokens.mjs
```

Run the seed step **after** setting the KV variables, and repeat it whenever you
re-authorize an upstream (a rotated refresh token must exist in KV before the
first request of a cold instance).

## Operational notes

- Each `/mcp` POST is handled statelessly (Vercel may route to any instance).
- Function `maxDuration` is 60 seconds (`vercel.json`).
- Hobby retains runtime logs for 1 hour; use `/healthz` and structured server
  logs for post-hoc checks.
- To change the exposed tool catalog, edit the `denyTools` / `allowTools`
  arrays. The **outer** tool surface (`search` / `execute_read` / `execute`)
  should not change; changing it requires a versioned endpoint and a client
  reconnect.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `/mcp` 401 without `WWW-Authenticate` | `PUBLIC_BASE_URL` missing or wrong |
| OAuth metadata 404 | Old deployment; redeploy the current commit |
| `invalid_request: dynamic client registration is disabled` | Expected in locked mode; enter the client id/secret in the client's advanced settings |
| Redirect URI rejected | Client must use a Google-hosted redirect URI; registration is limited by design |
| Consent page redirects but `/token` never arrives | Stale deployment; the consent page uses a meta refresh to survive Google's relay |
| KV errors | `KV_REST_API_URL` / `KV_REST_API_TOKEN` absent or not applied to the environment, or no redeploy |
| `invalid_token` / `invalid_grant` from an upstream | Re-authorize the upstream and re-seed KV tokens |
