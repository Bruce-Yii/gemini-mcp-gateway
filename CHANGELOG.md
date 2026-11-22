# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Config validation (`src/config.js`, `scripts/check-config.mjs`, `npm run check:config`):
  actionable errors and env warnings, used at Vercel and CLI startup.
- Generic OAuth-refresh upstreams: set `refreshUrl` on a server config to use
  the refresh lifecycle for any provider; Notion/Linear keep built-in defaults.
- `scripts/seed-upstream-tokens.mjs` now seeds every configured refresh upstream
  instead of a hardcoded provider list.
- [docs/UPSTREAMS.md](docs/UPSTREAMS.md), [docs/CLIENTS.md](docs/CLIENTS.md),
  [docs/CREDENTIALS.md](docs/CREDENTIALS.md) and ready-to-use `examples/` configs.
- Upstream-config and generic-auth tests (suite now 307).
- `clientSecretEnv` support for confidential OAuth refresh (Google Workspace, Slack, Atlassian, ...).
- `authScheme: "basic"` for static Basic credentials (e.g. Atlassian personal API tokens); any provider scheme (e.g. `Sentry-Bearer`) is sent verbatim.
- Slack template verified (registered internal/published app, no DCR, optional refresh) and **Sentry template via `Sentry-Bearer` user auth token**; credential guides updated.
- Verified upstream templates in `templates/upstreams/` (Slack, Sentry, Twilio, Zapier, Cloudflare, Stripe, Supabase, Neon, Google Drive, Atlassian) with official-doc links.
- Model-in-loop benchmark harness (`bench/`, `npm run bench`, CI dry run);
  validated live against a free OpenAI-compatible model (5/5 deterministic tasks).
- Slack/Atlassian/Sentry credential-acquisition notes and the Figma gap note in `docs/CREDENTIALS.md`.
- Figma findings from live probing: remote server uses OAuth/DCR with a **client-name allowlist** (third-party gateway gets 403); local Figma desktop server (`http://127.0.0.1:3845/mcp`) has a local-only template.
- **Gateway-initiated upstream OAuth** (Vercel): `/upstream/oauth/start` + `/upstream/oauth/callback`, PKCE S256, single-use state, admin-key gate, tokens seeded into KV. New config fields `authorizeUrl`, `oauthScopes`, `oauthRedirectUri`; Figma OAuth template (`figma-oauth.json`). Set `UPSTREAM_OAUTH_ADMIN_KEY` to enable.
- Figma live OAuth attempt: a self-created OAuth app gets `Invalid scope: mcp:connect`, confirming the remote server is restricted to catalog clients; only the local desktop-server path is usable (`figma-desktop.json`).

## [0.1.0] - 2026-11-22

Initial public snapshot.

### Added

- Code Mode MCP gateway: exposes exactly three tools (`search`,
  `execute_read`, `execute`) instead of per-upstream tool definitions.
- QuickJS-in-worker sandbox (Vercel `run` SDK) for orchestrating upstream tool
  calls; only the script return value enters model context.
- BM25 + identifier search over upstream tools, with `select:<name>` for full
  schemas and a small Chinese-query synonym layer.
- OAuth 2.1 authorization server for MCP clients (DCR, PKCE S256, state
  passthrough, non-rotating refresh tokens), with optional locked-client mode.
- Upstream token lifecycle handling (refresh, rotation, CAS fencing,
  invalid-grant terminal state) for GitHub / Notion / Linear / Vercel.
- Schema sanitizing for Gemini function declarations, image passthrough,
  structured result truncation, per-run read-only dedup, and `safeAll`.
- 301 offline tests, fake upstream harness, context/search measurement scripts.
- `GET /healthz` with build identity and a source hash for deployment
  verification.

### Security

- Sandbox escape regression tests (`tests/true-isolation.test.js`).
- Client-side token hashing in KV; secrets are environment-only.
