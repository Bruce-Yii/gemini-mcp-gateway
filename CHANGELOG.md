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
- Upstream-config and generic-auth tests (suite now 364).
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
- `tokenHeader` config for upstreams that take the raw token in a custom header (e.g. Figma's `X-Figma-Token`). Ready-made hosted Figma route via Framelink `figma-developer-mcp` (Streamable HTTP, PAT, two read-only tools) documented in `docs/CREDENTIALS.md` with `templates/upstreams/figma-framelink.json`; verified end-to-end through the gateway (2 tools indexed, search works).
- Figma official remote MCP can be configured with `FIGMA_ACCESS_TOKEN`/refresh env vars via a community OAuth allowlist workaround (50 tools, incl. `create_new_file` and `use_figma`); `config.example.json` includes the server (skipped when env vars are unset). Verified end-to-end: gateway created a real Figma file.
- Figma tool curation corrected after auditing Figma's official Tools docs: the first pass over-denied 18 official tools (Weave/Shader/Generative plugin) by name; final `denyTools` is 4 ChatGPT/UI-internal tools, 46 kept. Recorded as a process lesson in `docs/UNNEEDED-TOOLS.md` and `docs/ledger/batch-4-figma.md`.
- `docs/WORKFLOW.md`: end-to-end upstream onboarding + quality-gate workflow distilled from B0–B4 (G1 access → G2 tool curation → G3 scenario coverage → G4 baseline → G5 root cause → G6 retest → G7 delivery), with checklists and current upstream status.
- Review remediation: committed `tools/list` snapshots for the four existing upstreams (`data/tool-snapshots/`), `scripts/audit-tools.mjs` (official-list vs snapshot vs deny diff, refuses to pass without a snapshot), official Figma tool list + deny policy (`data/official-tools/`, `data/tool-policy/`), and `check-config` now prints `total/exposed/denied` per server.
- Local credential vault schema + `scripts/figma-token.mjs` (one-time Figma authorization, non-interactive refresh) and `vercel-auth.json` backup; Vercel refreshed tokens synced back via CLI.
- `data/tool-snapshots/figma.json` captured (50 tools) and `data/tool-dataset.json` synced to 506; `check-config` now prints `total/exposed/denied`; `scripts/audit-tools.mjs` added to CI.
- G6 full exploration (228 tasks, five upstreams) found a real sandbox gap: QuickJS has no `Intl`; most other gateway-attributed anomalies were model/upstream account/detector artifacts. Recorded in `docs/ledger/batch-7-g6-findings.md`; G6 remains ❌ until fixed and retested.
- Real GitHub write replay: branch → create file → dryRun → patch → verify → cleanup; fixed notice/sha/write-result nesting bugs.
- Write semantics: create_branch_if_missing, unified sha/top-level number/url/sha, multi-file precheck/dry-run.
- Online/offline join: PR #41–#48 timeline vs capture gap report.
- Digest/analyzer: per-upstream/tool stats, truncation/overflow split, weekly review workflow; L1 real weekly with Figma skip.
- B10 host helpers: canonical result adapter, atomic patch/dry-run, idempotent branch/PR/pagination/repoGrep; tests only, not wired.
- Free-model analyzer is advisory-only: AGENTS.md hard rule, output flags, review checklist, no auto-issue/auto-fix.
- L1 smoke: 50-task stratified suite, baseline, fake/replay/real runner, daily workflow.
- Capture fix: Uint8Array response chunks stored as text, not byte lists.
- Analyzer: digest -> free-model -> validated issue drafts; daily workflow commits scorecard and keeps raw analyzer artifacts.
- Capture gap closure: upstream HTTP request/response headers/bodies + auth refresh; `capture_dropped` structured failure events.
- Capture P1/P2: app-level all-route HTTP + MCP frames + upstream raw frames + sandbox/config events; auth-failure bodies included.
- Capture P1: full `/mcp` request/response raw envelope, credential redaction, file/http/R2 sinks, zero-impact tests.
- B8-4: acorn-based statement line markers (`__dshLine(n)`) replace unreliable QuickJS stack mapping; online Gemini verified `script line 2:1`; non-Error throws keep old shape.
- B8 helpers: `codemode.sliceLines` (line-range reads), `codemode.fileResult`/`prResult` (canonical flat views), `codemode.replaceLines`/`applyPatch`/`diffSummary` (safe line/patch edits with strict context); tests and guidance added.
- G7 verified from Gemini web against the deployed gateway: Vercel read (project/deployment READY) and Figma whoami/pages succeeded; B4 G1–G7 now complete.
- G6 rerun after Intl/detector fixes: 228 tasks, 363 anomalies, gateway 86 all upstream/account/data after triage, no new functional gateway bug; `codemode.formatDate/nowISO` + guidance added.
- Search stability: per-service BM25 index + narrow service aliases (repository/repo/octocat→github, deployment→vercel); restores existing 191-task baseline after adding Figma (top1 57.1%, top5 72.3%) and adds `tests/search-service-attribution.test.js`.
- Figma G3 coverage: `explore/figma-tasks.json` (46 tasks for 46 retained tools; 18 official/28 schema; 9 Weave skips), `scripts/gen-figma-tasks.mjs` + `check-task-coverage.mjs` (CI); schema-reverse 28/28 top-5.
- Binary/image resources: mimeType-gated resource blob → native image block, 1 MiB cap with metadata fallback; text/resource metadata unchanged (`src/tool-format.js`, `tests/resource-blob-image.test.js`).
- Gemini feedback (B5): deduplicated GitHub text/resource/`content` results (`src/tool-format.js`), made the `boundResult` truncation suffix state the exact `limit/original` with a true cap (`src/server.js`), and added the `codemode.unwrap(value)` sandbox helper (`src/codemode.js`); new tests for all three. Binary/image resource handling analyzed but not yet implemented.
- Figma quota breaker + read-only cache (`src/figma-guard.js`, wired into `UpstreamManager.callTool`): plan/rate-limit errors open a 24h cooldown (`FIGMA_COOLDOWN_MS`) that short-circuits further Figma calls with `FigmaQuotaCooldownError`; `whoami`/`get_metadata` successes cached with 1h TTL (`FIGMA_CACHE_TTL_MS`) and 200-entry LRU (`FIGMA_CACHE_MAX`). Other upstreams unaffected; state is per-instance in memory. Added `tests/figma-guard.test.js` and `docs/UPSTREAMS.md` notes.

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
