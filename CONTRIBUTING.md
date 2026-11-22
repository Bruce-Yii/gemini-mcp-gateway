# Contributing

Thanks for taking a look. This repository is a self-hosted MCP gateway; the
most useful contributions are bug reports with reproducible traces, upstream
adapter templates, and search/context improvements backed by measurements.

## Setup

- Node.js **>= 20.19** (the sandbox relies on the Vercel `run` SDK).
- `npm ci` then `npm test` — the default test suite is offline (fake upstream,
  in-memory transports) and needs no credentials.

```bash
npm ci
npm test
node scripts/eval-search.mjs      # offline search recall on the bundled catalog
node scripts/measure-context.mjs  # tool-definition context footprint
npm run smoke                     # local fake-upstream smoke test
```

## Repository layout

| Path | Purpose |
|---|---|
| `src/` | catalog search, schema sanitize, upstream client, Code Mode sandbox, OAuth, Vercel app |
| `tests/` | offline unit/integration tests (`node --test`) |
| `harness/` | fake upstream MCP server used by tests |
| `scripts/` | smoke, dataset collection, context/search measurements, build info |
| `docs/` | design notes, threat notes, research snapshots |
| `explore/` | optional real-model exploratory harness (not part of CI) |

## Rules for changes

1. **Keep the outer tool surface stable.** Clients see exactly `search`,
   `execute_read`, `execute` with fixed schemas. Adding/renaming MCP tools is a
   breaking change that requires a versioned path and a client reconnect
   (Gemini does not consume `tools/list_changed`).
2. **Every schema registered for Gemini must pass `sanitizeTool`.**
3. **Do not add new runtime dependencies casually.** The gateway is deliberately
   dependency-light; explain the trade-off in the PR.
4. **Never commit credentials.** Use environment variables and the fake
   upstream for tests. If you find a leaked secret, report it via
   `SECURITY.md`.
5. **Search changes need evidence.** Include before/after
   `node scripts/eval-search.mjs` numbers (and the Chinese query cases when
   relevant).
6. **New upstream support** means: config entry + README/docs note + a
   contract-style test (tool list shape, annotation handling, error shape) —
   "it connected once" is not enough.

## Pull requests

- Keep PRs focused; one concern per PR.
- Run `npm test` locally; CI runs it on Node 20/22/24.
- Update `CHANGELOG.md` for user-visible changes.
- Describe behavior changes, risks and side effects explicitly.

## Commit messages

Short imperative subject, optionally conventional prefixes (`feat:`, `fix:`,
`docs:`, `test:`, `chore:`). English is preferred for commit messages and code
comments.
