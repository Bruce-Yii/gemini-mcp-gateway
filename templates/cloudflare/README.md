# Cloudflare Workers template — feasibility evaluation (需开发)

Status: **not deployable with the current code.** Nothing in this folder is a
working worker. It documents the target design and the exact gaps. Do not
advertise Cloudflare support until the adapters listed here exist and are
tested. Full analysis:
[docs/OPEN-SOURCE/DEPLOYMENT-TEMPLATES.md §4](../../docs/OPEN-SOURCE/DEPLOYMENT-TEMPLATES.md).

## Why today's code cannot run on Workers

| Area | Blocking fact (from source) | Required work (需开发) |
|---|---|---|
| Node APIs | `node:http`, `node:fs`, `node:crypto`, `node:zlib`, `node:async_hooks` in `src/server.js`, `src/store.js`, `src/capture.js`, `src/vercel-app.js` | Port to Web APIs: `crypto.subtle`, `crypto.randomUUID`, `TextEncoder`, no filesystem. |
| stdio upstreams | `StdioClientTransport` spawns child processes (`src/upstreams.js:13`) | Impossible in Workers; templates must use `transport: "http"` only. |
| HTTP server | `http.createServer` + Node `IncomingMessage/ServerResponse` (`src/server.js:497-509`) | New `fetch(Request) -> Response` router (Hono or raw Worker). |
| Code Mode sandbox | `run` creates QuickJS in a **Node worker thread** (`src/codemode.js:12-19`) | Worker-compatible QuickJS WASM adapter with identical host-bridge contract; re-run sandbox probes. |
| `waitUntil` | `import { waitUntil } from '@vercel/functions'` at module load (`src/capture.js:27`) | Runtime abstraction: Vercel `waitUntil`, Workers `ctx.waitUntil`, local no-op. |
| Token store | SHA-256 + Lua EVAL CAS + GETDEL over Upstash REST (`src/store.js:25,100-123,229-257`) | WebCrypto port at minimum; for KV/D1, implement one-time code redemption and refresh CAS (D1 transactions preferred — KV is eventually consistent). |
| OAuth routes | Node-style `req/res` in `src/vercel-app.js` | Adapt to `Request/Response`; redirect allowlist and single-owner model remain. |
| Streaming | GET `/mcp` 405 by design; upstream SSE fetch exists | Verify SSE passthrough against Workers streaming/CPU limits. |
| Capture | `mkdir`/`writeFile` to `work/capture` | R2 binding or HTTP sink adapter. |

## Proposed layout (all files here are sketches)

```
templates/cloudflare/
├── README.md                       # this evaluation
├── wrangler.example.toml           # placeholder bindings, no account ids
├── worker.example.js               # 501 sketch: NOT a working entrypoint
└── config.cloudflare.example.json  # http-only upstreams, no stdio
```

## Target env/bindings (only after adapters exist)

- Secrets (via `wrangler secret put`): `PUBLIC_BASE_URL`,
  `ALLOWED_CLIENT_ID`, `ALLOWED_CLIENT_SECRET`, upstream `*_TOKEN` names,
  optional `UPSTREAM_OAUTH_ADMIN_KEY`.
- Bindings: `DB` (D1, token store), `CAPTURE_BUCKET` (R2, optional).
- `KV_REST_API_*` not required if a D1/WebCrypto store is implemented.

## Target commands (NOT runnable today)

```bash
npm install
wrangler secret put ALLOWED_CLIENT_ID      # then ALLOWED_CLIENT_SECRET and upstream tokens
wrangler d1 create <your-db-name>          # set database_id in your own wrangler.toml
wrangler dev --config templates/cloudflare/wrangler.example.toml
wrangler deploy --config templates/cloudflare/wrangler.example.toml
```

## Limits to verify before any support claim

- Workers CPU-time limits vs. QuickJS orchestration of many upstream calls.
- D1/KV cannot currently provide Upstash Lua CAS semantics without new code.
- No localhost/stdio upstreams (e.g. Figma desktop) from the edge.
- Tool surface must stay the same three tools; schema sanitization rules
  (AGENTS.md) still apply to any adapter.
