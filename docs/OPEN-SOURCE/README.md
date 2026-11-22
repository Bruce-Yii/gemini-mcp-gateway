# Open-source docs

This directory is the open-source launch workspace. It is **not** runtime
documentation; runtime docs stay at `README.md`, `DEPLOY.md`, `docs/CLIENTS.md`.

| File | Purpose |
|---|---|
| [PLAN.md](PLAN.md) | Launch plan, workstreams, release gate, open decisions |\n| [DIFFERENTIATION.md](DIFFERENTIATION.md) | Context/tool-call optimization moat, not generic feature matrix |\n| [COMPETITOR-RANKING.md](COMPETITOR-RANKING.md) | Ranked competitor list by our users / pain / scenario, with weighted scores |\n| [deep/README.md](deep/README.md) | GitHub-CLI source-level deep dives; corrects ranking claims |\n| [EXPORT-MANIFEST.md](EXPORT-MANIFEST.md) | New-repo delivery model: allowlist export, private repo stays source of truth |
| [COMPETITORS.md](COMPETITORS.md) | 2026-11 competitor matrix + our differentiation |
| [WEB-CLIENTS.md](WEB-CLIENTS.md) | Gemini / ChatGPT / Claude / Copilot web MCP compatibility |
| [DEPLOYMENT-TEMPLATES.md](DEPLOYMENT-TEMPLATES.md) | local / Docker / Vercel / Cloudflare templates, gaps, env |
| [READINESS.md](READINESS.md) | pre-publication audit: personal residue, workflows, .gitignore, metadata |

## Current recommendation

- Name: **`codemode-mcp-gateway`** (neutral; Gemini stays a tested client).
- v0.1 clients: **Gemini web + Claude.ai + MCP Inspector**; ChatGPT documented
  but plan-gated, not promised.
- v0.1 deployments: **local Node + Docker + Vercel**; Cloudflare design-only.
- Model: **single-owner / self-hosted**, no multi-tenant.
- Do not publish until [PLAN.md](PLAN.md) §7 release gate passes.
