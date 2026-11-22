# gemini-mcp-gateway

[![CI](https://github.com/Bruce-Yii/gemini-mcp-gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/Bruce-Yii/gemini-mcp-gateway/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20.19-339933.svg)](package.json)

**A Code Mode MCP gateway for web-based MCP clients.** It collapses hundreds of
upstream MCP tool definitions into **three stable tools** and keeps tool payloads
out of the model's context.

Measured on the bundled catalog: connecting five upstream MCP servers directly
puts **506 tool definitions (~245,377 tokens)** into the model context. This
gateway exposes **3 tools (~1,520 tokens)**, a **99.4% reduction** — while the
same upstream tools stay callable inside an isolated sandbox.

The model first calls `search` to discover tools, then writes a short JavaScript
function that calls `execute_read` (read-only) or `execute` (read/write). Only
the function's return value enters the conversation.

> **Status: v0.1 alpha, single-user / self-hosted.** Tested with Gemini web
> custom apps. Other MCP clients are expected to work but are not yet verified.
> APIs and configuration may change before 1.0.

**中文文档: [README.zh-CN.md](README.zh-CN.md)**

## Why

Web MCP clients inject every connected tool's full definition (name,
description, JSON schema) into the prompt. With four upstream servers that is
already ~218k tokens of constant overhead, squeezing out conversation history,
documents and reasoning.

This gateway makes the model-facing surface constant and small, and moves tool
orchestration into a sandbox:

```
Gemini / MCP client
        │  Streamable HTTP + OAuth 2.1
        ▼
┌──────────────────────────────────────────────┐
│  gemini-mcp-gateway                           │
│                                               │
│  search(query, limit?)     progressive discovery
│  execute_read(code)        read-only sandbox  │
│  execute(code)             read/write sandbox │
│                                               │
│        QuickJS worker sandbox  (no process,   │
│        no require, no fetch, no Node globals) │
│                     │                         │
│   codemode.github__list_issues({...})         │
│   codemode.notion__notion_search({...})       │
│   codemode.linear__list_issues({...})         │
│   codemode.vercel__list_deployments({...})    │
└─────────────────────┬─────────────────────────┘
                      │
        MCP over Streamable HTTP (with token lifecycle)
                      │
      GitHub · Notion · Linear · Vercel · (your upstreams)
```

Only `return` values and compact `search` results reach the model. Large
upstream payloads are filtered/aggregated inside the sandbox.

## Features

- **Three stable tools** — `search`, `execute_read`, `execute`. The tool surface
  never changes mid-session (Gemini does not consume
  `notifications/tools/list_changed`).
- **Engine-level sandbox** — QuickJS in a worker thread via the Vercel `run`
  SDK; guest code has no `process`, `require`, `fetch` or Node globals. Escape
  regression tests included.
- **Progressive discovery** — BM25 + identifier-aware ranking, `select:<name>`
  for full JSON schemas, and a small Chinese-query synonym layer.
- **Context discipline** — compact result projection, structured truncation,
  per-run read-only dedup, a per-execution call budget, and `safeAll()` for
  partial-batch failures.
- **OAuth 2.1 authorization server** — DCR, PKCE S256, state passthrough,
  non-rotating refresh tokens, optional locked-client mode
  (`ALLOWED_CLIENT_ID`).
- **Upstream token lifecycle** — refresh/rotation, CAS fencing, invalid-grant
  terminal state and self-healing for Notion/Linear; static bearer/env tokens
  for GitHub/Vercel.
- **Gemini-safe schemas** — every registered tool schema passes `sanitizeTool`
  (arrays get `items`, multi-types collapse, deep `oneOf` truncated); results
  are text JSON (no `structuredContent`).
- **Deploy verification** — `GET /healthz` exposes the build commit and a hash
  of the runtime sources.
- **Upstream-agnostic** — any MCP server over Streamable HTTP or stdio; add one
  with a config entry (see [docs/UPSTREAMS.md](docs/UPSTREAMS.md)).
- **Offline tests** — 364 unit/integration tests and a fake-upstream harness;
  no network or credentials needed.

## Quick start (local)

Requirements: **Node.js >= 20.19**.

```bash
git clone https://github.com/Bruce-Yii/gemini-mcp-gateway.git
cd gemini-mcp-gateway
npm ci
npm test            # offline: 300 tests
npm run smoke       # fake upstream MCP server, no credentials
node scripts/check-config.mjs  # validate config + env warnings
npm start           # http://localhost:3000/mcp
npm start -- --config examples/local-stdio-fake.json  # local stdio example
```

`npm start` uses `config.example.json`; upstreams whose `tokenEnv` variables are
unset are skipped, so you can inspect the three-tool surface first (e.g. with
MCP Inspector). To use real upstreams, export the tokens listed below. Verified
drop-in entries for public servers are in
[`templates/upstreams/`](templates/upstreams/README.md).

Measurement scripts (offline, no model calls):

```bash
node scripts/measure-context.mjs          # tool-definition context footprint
node scripts/eval-search.mjs              # offline search recall
node scripts/write-build-info.mjs --print # current commit + runtime source hash
```

## Configuration

For a step-by-step guide to adding a server, see
**[docs/UPSTREAMS.md](docs/UPSTREAMS.md)**; minimal configs live in `examples/`.

Configuration lives in `config.example.json` (copy it and point
`GATEWAY_CONFIG` at your copy, or pass `--config`). Upstream entries support:

```jsonc
{
  "mode": "codemode",                 // codemode (default) or whitelist (legacy/debug)
  "servers": [{
    "name": "github",
    "transport": "http",              // "http" (Streamable HTTP) or "stdio"
    "url": "https://api.githubcopilot.com/mcp/",
    "tokenEnv": "GITHUB_TOKEN",       // bearer token comes from this env var
    "allowTools": [],                 // optional allowlist (empty = all)
    "denyTools": ["get_teams"]        // optional denylist
  }]
}
```

OAuth-capable upstreams also take `refreshEnv`, `clientIdEnv`, `expiresInEnv`,
`obtainedAtEnv` and, for providers other than the built-in Notion/Linear,
`refreshUrl` (the token endpoint). See `config.example.json`.

Environment variables used by the reference deployment:

| Variable | Purpose |
|---|---|
| `GITHUB_TOKEN` | GitHub MCP bearer token (PAT or Copilot token) |
| `NOTION_TOKEN`, `NOTION_REFRESH_TOKEN`, `NOTION_CLIENT_ID`, `NOTION_EXPIRES_IN`, `NOTION_OBTAINED_AT` | Notion upstream credentials |
| `LINEAR_TOKEN`, `LINEAR_REFRESH_TOKEN`, `LINEAR_CLIENT_ID`, `LINEAR_EXPIRES_IN`, `LINEAR_OBTAINED_AT` | Linear upstream credentials |
| `VERCEL_TOKEN` | Vercel MCP bearer token |
| `FIGMA_ACCESS_TOKEN`, `FIGMA_REFRESH_TOKEN`, `FIGMA_CLIENT_ID`, `FIGMA_CLIENT_SECRET`, `FIGMA_EXPIRES_IN`, `FIGMA_OBTAINED_AT` | Figma official MCP via a community OAuth workaround (unsupported by Figma; see [docs/CREDENTIALS.md](docs/CREDENTIALS.md)) |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | Upstash Redis for OAuth client/token storage |
| `PUBLIC_BASE_URL` | Public base URL of the deployment (e.g. `https://<your-domain>`) |
| `ALLOWED_CLIENT_ID`, `ALLOWED_CLIENT_SECRET` | Lock the gateway to one pre-registered OAuth client (**required for production**) |
| `UPSTREAM_OAUTH_ADMIN_KEY` | Optional. Enables `/upstream/oauth/start` for servers configured with `authorizeUrl` (see [docs/CREDENTIALS.md](docs/CREDENTIALS.md)) |
| `GATEWAY_CONFIG`, `UPSTREAMS_JSON` | Optional inline config overrides |

**Bring your own upstream credentials by default.** Obtain a PAT/API token
yourself and pass it via env. For providers that only support OAuth, the gateway
can optionally run the authorization-code flow itself (set
`UPSTREAM_OAUTH_ADMIN_KEY` and configure `authorizeUrl`; see
[docs/CREDENTIALS.md](docs/CREDENTIALS.md)). Notion/Linear access+refresh tokens
can be seeded into the hosted KV store with
`scripts/seed-upstream-tokens.mjs`; other OAuth upstreams can use the same
`refreshUrl`/`clientSecretEnv` refresh lifecycle.

## Deploy

See **[DEPLOY.md](DEPLOY.md)** for a Vercel + Upstash KV walkthrough, the exact
environment variables, safe deployment defaults, and verification steps
(`/healthz`, well-known metadata, `/mcp` 401 with `WWW-Authenticate`).

## Connect a client

- **Gemini web (tested):** Settings → Connected Apps → Custom apps → add
  `https://<your-domain>/mcp`. In locked mode, enter your `ALLOWED_CLIENT_ID` /
  `ALLOWED_CLIENT_SECRET`. Google currently limits custom apps to personal
  accounts, 18+, in the US, using English.
- **Other clients:** see [docs/CLIENTS.md](docs/CLIENTS.md) for the compatibility matrix. Any client supporting Streamable HTTP and
  either a static `Authorization` header or OAuth 2.1 should work. Please report
  compatibility results in an issue.

## Benchmarks and testing

All numbers below are reproducible offline against the bundled catalog:

| Metric | Result |
|---|---|
| Tool-definition context, 5 upstreams directly | 506 tools ≈ 245,377 tokens |
| Tool-definition context, this gateway | 3 tools ≈ 1,520 tokens (**-99.4%**) |
| Offline search recall (191 tool-level tasks, English) | top1 **56.5%**, top5 **72.3%** |
| Offline search recall (19 realistic Chinese queries) | top1 **84%**, top5 **95%** |
| Offline tests | **364** passing |

```bash
npm test
node scripts/eval-search.mjs
node scripts/measure-context.mjs
node bench/run.mjs --dry-run      # model-in-loop harness check (no model calls)
```

These are lexical-search and token-estimate measurements, not end-to-end model
benchmarks; see [docs/WHY.md](docs/WHY.md) for methodology and caveats. For a
model-in-loop harness (real OpenAI-compatible model, deterministic fake upstream),
see [bench/README.md](bench/README.md).

## Security

Read **[SECURITY.md](SECURITY.md)** before deploying. In short: this is a
**single-user** gateway that holds real upstream credentials. Always set
`ALLOWED_CLIENT_ID`, use least-privilege upstream tokens, and never share a
deployment between users. The sandbox provides isolation, not authorization.

## Repository layout

| Path | Purpose |
|---|---|
| `src/` | catalog/search, schema sanitizer, upstream client, sandbox, OAuth, Vercel app |
| `tests/` | offline unit + integration tests |
| `harness/` | fake upstream MCP server |
| `scripts/` | smoke, dataset collection, context/search measurement, build info |
| `data/tool-dataset.json` | real tool schemas used for measurements |
| `docs/` | design notes, context measurements, sandbox threat notes, research snapshots |
| `explore/` | optional real-model exploratory harness (not part of CI) |

## Docs

- [docs/WHY.md](docs/WHY.md) — problem, measurements, external evidence
- [docs/UPSTREAMS.md](docs/UPSTREAMS.md) — add an upstream (config, auth patterns, verification)
- [docs/WORKFLOW.md](docs/WORKFLOW.md) — upstream onboarding + quality gates (B1–B4 workflow)
- [docs/OBSERVABILITY-AND-EVAL.md](docs/OBSERVABILITY-AND-EVAL.md) — zero-impact telemetry + evaluation loop design (B9, design only)
- [docs/CREDENTIALS.md](docs/CREDENTIALS.md) — how to obtain tokens for Slack/Atlassian/etc.
- [docs/CLIENTS.md](docs/CLIENTS.md) — client compatibility matrix
- [docs/ADOPTION-RANKINGS.md](docs/ADOPTION-RANKINGS.md) — what public data says about MCP/connector adoption
- [templates/upstreams/](templates/upstreams/README.md) — verified drop-in upstream entries
- [bench/README.md](bench/README.md) — model-in-loop benchmark harness
- [docs/SANDBOX-SECURITY.md](docs/SANDBOX-SECURITY.md) — sandbox model and caveats
- [docs/CODEMODE-SURVEY.md](docs/CODEMODE-SURVEY.md) — Code Mode landscape survey
- [docs/UNNEEDED-TOOLS.md](docs/UNNEEDED-TOOLS.md) — how the bundled tool denylist was chosen
- [docs/GEMINI-OFFICIAL-DOCS.md](docs/GEMINI-OFFICIAL-DOCS.md) — Gemini connector constraints
- [CONTRIBUTING.md](CONTRIBUTING.md) · [CHANGELOG.md](CHANGELOG.md) · [SECURITY.md](SECURITY.md)

## Known limitations

- Single-tenant by design; there is no multi-tenant credential isolation.
- Upstream credential acquisition (OAuth flows for Notion/Linear/etc.) is out of
  scope; bring tokens.
- Only four upstream templates ship in the box; adding a fifth is configuration
  plus documentation, not code, but it has not been packaged as a wizard yet.
- Gemini custom apps have regional/account restrictions imposed by Google.
- The outer tool surface is intentionally stable; breaking changes require a
  versioned endpoint and a client reconnect.

## License

[MIT](LICENSE). Not affiliated with Google, Vercel, Cloudflare, GitHub, Notion
or Linear.
