# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
- 288 offline tests, fake upstream harness, context/search measurement scripts.
- `GET /healthz` with build identity and a source hash for deployment
  verification.

### Security

- Sandbox escape regression tests (`tests/true-isolation.test.js`).
- Client-side token hashing in KV; secrets are environment-only.
