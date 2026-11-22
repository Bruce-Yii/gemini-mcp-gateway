# Vercel deployment template

Status: **reference deployment**, works with the existing code. Full guide:
[DEPLOY.md](../../DEPLOY.md). This folder contains placeholder-only copies for
open-source onboarding; the repository root `vercel.json` is the active config
and should not be replaced by these examples.

## Layout

```
templates/vercel/
├── README.md            # this file
├── vercel.example.json  # copy of the root vercel.json with no real values
└── .env.example         # all env var NAMES, placeholder values only
```

The example `vercel.json` sets `framework: null`, builds with
`node scripts/write-build-info.mjs && npm run build --if-present`, rewrites
`/(.*)` → `/api/index`, and gives `/api/index` `maxDuration: 60`.

## Quickstart (≤ 3 commands)

```bash
npm install
vercel link                 # or import the repo in the Vercel dashboard
vercel deploy               # after configuring env vars + Upstash KV (below)
```

## Required setup (dashboard or `vercel env add NAME production`)

| Variable | Value form |
|---|---|
| `PUBLIC_BASE_URL` | `https://<your-app>.example.invalid` (origin, no trailing slash) |
| `ALLOWED_CLIENT_ID` | `gmc_` + random hex; locks DCR to one client |
| `ALLOWED_CLIENT_SECRET` | random 32+ byte secret (sensitive env var) |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | injected by the Upstash Redis Marketplace integration (or `UPSTASH_REDIS_REST_*`) |
| `EXAMPLE_TOKEN` etc. | upstream credentials named by your config (never in JSON) |
| `GATEWAY_CONFIG` / `UPSTREAMS_JSON` | optional; normally unset (uses root `config.example.json`) |
| `UPSTREAM_OAUTH_ADMIN_KEY` | optional; enables `/upstream/oauth/start` |
| `CAPTURE_MODE`, `CAPTURE_SINK`, `R2_*` | optional capture config (use `r2`/`http`/`console`, not `file`) |

Generate client id/secret locally:

```bash
node -e "const c=require('node:crypto');console.log('gmc_'+c.randomBytes(16).toString('hex'));console.log(c.randomBytes(32).toString('base64url'))"
```

After setting vars, redeploy (or use `vercel deploy` again). Then seed refresh
tokens if you use Notion/Linear-style upstreams:

```bash
node scripts/seed-upstream-tokens.mjs
```

## OAuth / callbacks

- Discovery: `GET <BASE>/.well-known/oauth-authorization-server` and
  `GET <BASE>/.well-known/oauth-protected-resource`.
- Client registration: `POST <BASE>/oauth/register` (403 when locked),
  `/oauth/authorize`, `/oauth/token`, `/oauth/revoke`.
- Gemini custom app URL: `<BASE>/mcp`; enter client id/secret in Advanced
  features in locked mode. Redirects must be Google-hosted
  (`src/oauth.js:20-24`). This is a Gemini-side restriction.
- Upstream callback: register `<BASE>/upstream/oauth/callback`, set the admin
  key, then open
  `<BASE>/upstream/oauth/start?server=<name>&key=<UPSTREAM_OAUTH_ADMIN_KEY>`
  once. State is one-time and expires in 10 minutes.
- `/mcp` requires `Authorization: Bearer <token issued by /oauth/token>`;
  without it the response is 401 with a `WWW-Authenticate` resource-metadata
  challenge.

## Storage

Upstash Redis REST via `src/store.js` is the only production token store. Keys
are SHA-256 hashes; codes use GETDEL; refresh writes use Lua EVAL CAS. A
deployment without KV variables can boot (`/healthz` works) but `/mcp` auth
will fail. Capture uses R2/HTTP sinks on serverless; the `file` sink is not
durable.

## Limits

- 60s function duration; POST-only stateless `/mcp` (GET → 405).
- Hobby log retention is 1 hour; use `/healthz` and capture for post-hoc checks.
- Single-owner: do not share a deployment between users.
- Changing the outer tool surface requires a versioned endpoint + client
  reconnect. Keep `mode: codemode` with the three stable tools unless you know
  the consequences.
