# gemini-mcp-gateway

[![CI](https://github.com/example-org/codemode-mcp-gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/example-org/codemode-mcp-gateway/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20.19-339933.svg)](package.json)

**A continuously optimized context & tool-call layer for web-based AI clients.**
Connecting five upstream MCP servers directly puts **506 tool definitions
(~245,377 tokens)** into the model context; this gateway exposes **3 stable tools
(~1,520 tokens)** — a **99.4% reduction** — while the same upstream tools remain
callable inside an isolated sandbox.

This is not just aggregation. The model discovers tools progressively with
`search` (BM25 ranking, compact signatures, `select:<name>` for full schemas on
demand), then orchestrates calls in a QuickJS sandbox through a read/write split:
`execute_read` for read-only calls and `execute` for reads and writes. **Only the
sandbox return value enters the conversation** — raw upstream payloads stay out.
Results are normalized into canonical file/PR/Issue shapes, carry line ranges,
and are explicitly truncated with markers instead of silently cut.

Optimization here is a **continuous eval loop, not a one-time benchmark**:
full-fidelity `capture` → `digest` → analyzer (advisory hypotheses only) →
L1 smoke / G6 scorecards → regression tests. Every change is checked against
real sessions and a fixed task set; see
[docs/OBSERVABILITY-AND-EVAL.md](docs/OBSERVABILITY-AND-EVAL.md).

> **Status: v0.1 alpha, single-owner / self-hosted.** One person's upstreams in
> one gateway; no multi-tenant credential isolation is provided or promised.
> Tested with Gemini web custom apps; other clients are targets, not claims.
> APIs and configuration may change before 1.0.

**中文文档: [README.zh-CN.md](README.zh-CN.md)**

## Why

Web MCP clients inject every connected tool's full definition (name,
description, JSON schema) into the prompt. With several upstream servers that is
a huge fixed overhead, squeezing out conversation history, documents and
reasoning. Most gateways make tools *reachable*; this gateway makes them *cheap
to discover, safe to execute, and measurable to improve*.

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
upstream payloads are filtered, normalized and aggregated inside the sandbox.

## What we optimize

| Layer | What we do |
|---|---|
| **Tool-definition context** | 506 upstream schemas (~245,377 tokens) → 3 stable tools (~1,520 tokens), -99.4%; the surface never changes mid-session (Gemini ignores `notifications/tools/list_changed`). |
| **Progressive discovery** | BM25 + identifier-aware ranking, compact signatures, `select:<name>` for full JSON schemas, a small Chinese-query synonym layer. |
| **Result context** | Only the sandbox return value enters context; canonical file/PR/Issue shapes, line ranges, structured truncation markers. |
| **Read/write split** | `execute_read` stubs out write tools in read mode; `execute` allows writes. Per-tool read/write labels and a per-execution call budget. |
| **Tool-call correctness** | `server__tool` names, every schema through `sanitizeTool`, flat params, stable tool order, text-JSON results (no `structuredContent`). |
| **Continuous eval** | Full-fidelity capture → digest → analyzer (advisory) → L1/G6 → regression. Model suggestions are hypotheses, never auto-applied; see [AGENTS.md](AGENTS.md). |
| **Isolation** | QuickJS in a worker thread via the Vercel `run` SDK; no `process`, `require`, `fetch` or Node globals, with escape regression tests. |

Upstreams are added with a config entry over Streamable HTTP or stdio (see
[docs/UPSTREAMS.md](docs/UPSTREAMS.md)). OAuth 2.1 DCR + PKCE S256, upstream
token refresh/rotation and deploy verification (`GET /healthz`) are supporting
plumbing, not the headline.

## Clients

| Client | Status |
|---|---|
| **Gemini web custom apps** | **Tested.** Settings → Connected Apps → Custom apps → add `https://<your-domain>/mcp`. Locked mode needs `ALLOWED_CLIENT_ID` / `ALLOWED_CLIENT_SECRET`. Google restricts custom apps to personal accounts, 18+, in the US, using English. |
| **Claude.ai custom connectors** | **Target** — low-effort adapter (explicit `readOnlyHint`/`destructiveHint`, result-size limits). Not yet verified end-to-end here. |
| **MCP Inspector / local stdio + HTTP** | **Reproducibility target** for tool-surface and smoke checks; use this before claiming any new client works. |
| **ChatGPT Business / Enterprise / Edu** | **Documented, not promised.** Full MCP is plan-gated; Pro is read/fetch only; schema-token limits are undocumented. Adapter work (result encoding, safety hints) is not done — do not assume it works. |
| **Other web clients / consumer plans / mobile** | **Not promised.** See [docs/OPEN-SOURCE/WEB-CLIENTS.md](docs/OPEN-SOURCE/WEB-CLIENTS.md) and [docs/CLIENTS.md](docs/CLIENTS.md) for the research and caveats. |

## Why another Code Mode gateway?

Code Mode and tool-retrieval gateways are no longer unique: Cloudflare Code Mode
/Portals, Limen, Limen-style `dev-mcp`, toolgate, IBM's `mcp-context-forge` and
others compress tool surfaces or retrieve tools. This project is **not the only
context optimizer**, and aggregation is a side effect, not the product.

Our position is the intersection: **web-client delivery + Code Mode
orchestration + read/write isolation + canonical result context + a full-fidelity
eval loop**, self-hosted for a single owner. Host-native tool search (Anthropic,
OpenAI, MCP Groups) is a long-term watch item, not something we claim to replace
or permanently beat. The short comparison and threat model live in
[docs/OPEN-SOURCE/DIFFERENTIATION.md](docs/OPEN-SOURCE/DIFFERENTIATION.md) and
[docs/OPEN-SOURCE/COMPETITORS.md](docs/OPEN-SOURCE/COMPETITORS.md) §0.2; we
intentionally do not maintain a long aggregator feature table.

## Not trying to be

- Multi-tenant / RBAC / organization control plane — **single-owner by design**.
- An enterprise policy gateway or general LLM router.
- A universal "all MCP clients verified" project — compatibility claims stay
  narrow and evidence-based.
- A Docker-first platform: a single-container Docker path exists for local
  self-hosting, but Vercel remains the reference deployment.

## Quick start (local)

Requirements: **Node.js >= 20.19**.

```bash
git clone https://github.com/example-org/codemode-mcp-gateway.git
cd codemode-mcp-gateway
npm ci
npm test            # offline suite
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
| `CAPTURE_MODE` | Optional full-fidelity capture: `off`（默认）/`full`/`meta`；见 [docs/OBSERVABILITY-AND-EVAL.md](docs/OBSERVABILITY-AND-EVAL.md) |
| `CAPTURE_SINK` | `file`（本地）/`http`（collector）/`console`（仅 debug） |
| `CAPTURE_FILE_DIR` | File sink directory (default `work/capture`) |
| `CAPTURE_HTTP_URL`, `CAPTURE_HTTP_TOKEN` | HTTP collector endpoint + bearer token |
| `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_PREFIX` | Cloudflare R2 capture destination (default prefix `capture`) |
| `R2_AUTH_EMAIL`, `R2_AUTH_KEY` | Cloudflare global API key auth (secret; prefer a scoped token later) |
| `R2_API_TOKEN` | Optional scoped Cloudflare API token; takes precedence over email/key |
| `CAPTURE_MAX_BYTES` | Per-response raw cap (default 32 MiB) |

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
For a single-container local deployment, see
**[docs/OPEN-SOURCE/DOCKER.md](docs/OPEN-SOURCE/DOCKER.md)**: build with
`docker compose up --build`, pass `--host 0.0.0.0` (the CLI defaults to
loopback), and use the TCP healthcheck because `/healthz` exists only in the
Vercel entry.

## Evaluation and testing

Reproducible offline measurements (no model calls, no credentials):

| Metric | Result |
|---|---|
| Tool-definition context, 5 upstreams directly | 506 tools ≈ 245,377 tokens |
| Tool-definition context, this gateway | 3 tools ≈ 1,520 tokens (**-99.4%**) |
| Offline search recall | top1 **56.5%**, top5 **72.3%** (English, tool-level tasks); Chinese queries improved with a synonym layer |
| Offline suite | `npm test` — unit + integration tests with a fake-upstream harness; no network or credentials needed |

```bash
npm test
node scripts/eval-search.mjs
node scripts/measure-context.mjs
node bench/run.mjs --dry-run      # model-in-loop harness check (no model calls)
```

These are lexical-search and token-estimate measurements, not end-to-end model
benchmarks; methodology and caveats are in [docs/WHY.md](docs/WHY.md). The
ongoing capture → digest → analyzer → L1/G6 loop is described in
[docs/OBSERVABILITY-AND-EVAL.md](docs/OBSERVABILITY-AND-EVAL.md); analyzer output
is advisory and must be verified against a `requestId` and a local reproduction
before any change ([AGENTS.md](AGENTS.md)). A model-in-loop harness (real
OpenAI-compatible model, deterministic fake upstream) is in
[bench/README.md](bench/README.md).

## Security

Read **[SECURITY.md](SECURITY.md)** before deploying. In short: this is a
**single-owner / self-hosted** gateway that holds real upstream credentials.
Always set `ALLOWED_CLIENT_ID`, use least-privilege upstream tokens, and never
share a deployment between users — there is no multi-tenant isolation. The
sandbox provides isolation, not authorization.

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
- [docs/OPEN-SOURCE/DIFFERENTIATION.md](docs/OPEN-SOURCE/DIFFERENTIATION.md) — positioning: continuous context/tool-call optimization
- [docs/OPEN-SOURCE/COMPETITORS.md](docs/OPEN-SOURCE/COMPETITORS.md) — competitor research, §0.2 threat model
- [docs/OPEN-SOURCE/WEB-CLIENTS.md](docs/OPEN-SOURCE/WEB-CLIENTS.md) — web-client adaptation survey
- [docs/EVALUATION.md](docs/EVALUATION.md) — online × semi-online evaluation architecture
- [docs/EXECUTION-PLAN.md](docs/EXECUTION-PLAN.md) — cross-workstream execution router
- [docs/AUTH-READY.md](docs/AUTH-READY.md) — when upstream authorization may be requested
- [docs/ONLINE-EVAL-GPT-CHARTER.md](docs/ONLINE-EVAL-GPT-CHARTER.md) — durable charter for independent ChatGPT evaluation windows (issue #3)
- [docs/UPSTREAMS.md](docs/UPSTREAMS.md) — add an upstream (config, auth patterns, verification)
- [docs/WORKFLOW.md](docs/WORKFLOW.md) — upstream onboarding + quality gates (B1–B4 workflow)
- [docs/OBSERVABILITY-AND-EVAL.md](docs/OBSERVABILITY-AND-EVAL.md) — zero-impact telemetry + evaluation loop design
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

- Single-owner / self-hosted by design; no multi-tenant credential isolation.
- Upstream credential acquisition (OAuth flows for Notion/Linear/etc.) is out of
  scope; bring tokens.
- Only a few upstream templates ship in the box; adding one is configuration
  plus documentation, not a wizard.
- Gemini custom apps have regional/account restrictions imposed by Google.
- The outer tool surface is intentionally stable; breaking changes require a
  versioned endpoint and a client reconnect.
- Docker is supported for single-container self-hosting; Cloudflare Workers is
  not shipped. Claude.ai and ChatGPT connectors are targets/documented, not
  verified claims.

## License

[MIT](LICENSE). Not affiliated with Google, Vercel, Cloudflare, GitHub, Notion
or Linear.
