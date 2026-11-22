# Open-source deployment templates & configuration layering

Audience: people who cloned this repository and want to run the gateway
themselves. This document is **design + onboarding documentation**. It
describes four target environments and points at example files under
`templates/<env>/`. Everything marked **需开发 / needs development** is a
proposal only — it is not implemented and must not be treated as a supported
feature.

> Scope guarantees of this document
>
> - No real hostnames, accounts, tokens or secrets appear here; all values are
>   placeholders (`<...>`, `example.invalid`, `YOUR_*`).
> - The gateway is **single-owner**: a deployment holds the upstream tokens you
>   give it. Do not share one deployment across mutually untrusted users.
> - `config.example.json` is read-only reference for this work; do not edit it
>   to deploy. Use the layering described below instead.

---

## 0. What exists today (evidence from the code)

Facts that constrain any deployment template, verified by reading the source:

| Fact | Evidence |
|---|---|
| Two entrypoints exist: local CLI (stdio **or** localhost Streamable HTTP) and Vercel HTTP handler | `src/server.js` (`runCli`, `startHttpServer`, `--stdio`, `--port`), `api/index.js` → `src/vercel-app.js` |
| Local HTTP binds `127.0.0.1` only; `/mcp` is the sole protocol route | `src/server.js:503` (`listen(port, '127.0.0.1')`), `src/server.js:420` |
| `/mcp` is stateless: POST only; GET → 405, DELETE → 204 | `src/server.js:384-490` |
| Gateway needs `--config <path>` when run via CLI; config has `servers[]`, `mode`, `maxWhitelistTools`, `maxCalls`, `maxResultChars` | `src/server.js:544-557`, `src/config.js:17,60` |
| Config validation is strict: names `^[A-Za-z0-9_-]{1,32}$`, http/stdio transports only, env-var references only for secrets | `src/config.js:14-16,94-136` |
| HTTP entry supports inline config via `UPSTREAMS_JSON` and path config via `GATEWAY_CONFIG` | `src/vercel-app.js:71-88` (**HTTP/Vercel entry only** — the local CLI does not read these env vars; marked **需开发** below) |
| Servers whose `tokenEnv` is unset are skipped at boot (HTTP entry); CLI passes all servers through | `src/vercel-app.js:90-96`, `src/server.js:551` |
| OAuth 2.1: DCR, PKCE S256, metadata, token/revoke routes; locked client via `ALLOWED_CLIENT_ID`/`ALLOWED_CLIENT_SECRET`; Google-hosted redirect allowlist | `src/oauth.js:9-24,252-253`, `DEPLOY.md:51-55` |
| Bearer validation happens in the HTTP entry using a store lookup; no auth on local CLI HTTP | `src/vercel-app.js:214-246`, `src/server.js:497-509` |
| TokenStore is **Upstash Redis REST** over `fetch` with `KV_REST_API_URL`/`KV_REST_API_TOKEN` (or `UPSTASH_REDIS_REST_*`); keys are hashed, codes use GETDEL, refresh writes use Lua EVAL CAS | `src/store.js:38-46,100-123,194-237` |
| Code Mode sandbox uses the `run` package (QuickJS in a worker thread) plus Vercel SDK's `@vercel/functions.waitUntil` imported at module load | `src/codemode.js:12-19`, `src/capture.js:27` |
| Upstream transports: stdio (`StdioClientTransport` → child process) and Streamable HTTP (`StreamableHTTPClientTransport`) | `src/upstreams.js:11-14` |
| Capture sink defaults to local files under `work/capture`, optional HTTP / R2; `CAPTURE_MODE` off by default | `src/capture.js:183-199,576-578` |
| No Dockerfile, docker-compose, Cloudflare Worker entry, or `wrangler.toml` exists in the repository | repository file listing (only `work/mcpmark/Dockerfile` unrelated scratch file) |

Consequences: **Vercel and local Node are the only two environments that work
with the current code.** Cloudflare Workers and the Docker topology below are
evaluations/templates with explicit **需开发** gaps.

---

## 1. Unified configuration schema

### 1.1 One config shape for every environment

All environments consume the same JSON shape (from `src/config.js` and
`src/vercel-app.js:47-59`):

```jsonc
{
  // Optional. "codemode" (three tools: search / execute_read / execute) or
  // "whitelist" (direct tools + gateway_call / gateway_search).
  "mode": "codemode",
  "maxWhitelistTools": 0,   // 0 = no cap
  "maxCalls": 50,           // Code Mode only
  "maxResultChars": 20000,  // Code Mode only
  "servers": [
    {
      "name": "example",                  // ^[A-Za-z0-9_-]{1,32}$, unique
      "transport": "http",                // "http" | "stdio"
      "url": "https://mcp.example.invalid/mcp",
      // -- or for stdio --
      // "command": "npx", "args": ["-y", "some-mcp-server"], "env": { "KEY": "VALUE" }

      "tokenEnv": "EXAMPLE_TOKEN",        // NAME of an env var, never a token
      "tokenHeader": "X-Example-Token",   // optional; default Authorization: Bearer
      "authScheme": "bearer",             // optional; "basic", "Sentry-Bearer", etc.

      "refreshEnv": "EXAMPLE_REFRESH_TOKEN",
      "clientIdEnv": "EXAMPLE_CLIENT_ID",
      "clientSecretEnv": "EXAMPLE_CLIENT_SECRET",
      "expiresInEnv": "EXAMPLE_EXPIRES_IN",
      "obtainedAtEnv": "EXAMPLE_OBTAINED_AT",
      "refreshUrl": "https://auth.example.invalid/oauth/token",

      // gateway-initiated OAuth (Vercel HTTP entry, admin key required)
      "authorizeUrl": "https://auth.example.invalid/authorize",
      "oauthScopes": ["mcp:read"],
      "oauthRedirectUri": "https://<your-deployment>/upstream/oauth/callback",

      "allowTools": [],                   // empty = all (after denyTools)
      "denyTools": ["dangerous_tool"]
    }
  ]
}
```

Rules (enforced today):

- Secret fields are **names of environment variables**, not values
  (`src/config.js:131-136`). A literal token in these fields is a typo and will
  be rejected by the env-name regex.
- `mode` must be `codemode` or `whitelist`; unknown keys produce warnings
  (`src/config.js:65-72`).
- `refreshEnv` requires `tokenEnv` and, for non built-in providers, a
  `refreshUrl`; `authorizeUrl` requires `clientIdEnv` + `refreshUrl`
  (`src/config.js:141-154`).
- `allowTools` and `denyTools` can coexist; `denyTools` is applied first
  (`src/config.js:169-171`).
- The external tool surface must stay stable (`search` / `execute_read` /
  `execute` in Code Mode). Do not change tool names mid-session; a change
  requires a versioned endpoint and client reconnect (AGENTS.md, `DEPLOY.md:126-129`).

### 1.2 Configuration layering (proposed; file-based parts work today)

Order of precedence, lowest → highest. This design keeps personal tokens out
of committed config:

1. **Shipped defaults** — `config.example.json` (read-only; placeholders only).
2. **Profile config file** — `templates/profiles/*.json` (profiles described
   below). Selected with `--config <path>` (local CLI) or `GATEWAY_CONFIG`
   (HTTP entry). **需开发:** no `GATEWAY_PROFILE` resolver exists; all shipping
   is done by copying a profile file to your own untracked path.
3. **Inline override** — `UPSTREAMS_JSON` (HTTP entry only, takes precedence
   over `GATEWAY_CONFIG` per `src/vercel-app.js:73-79`). **需开发:** local CLI
   does not read it.
4. **Runtime secrets** — environment variables named by `tokenEnv`,
   `refreshEnv`, `clientIdEnv`, etc. These are never stored in config files.
5. **Local secret vault / secret manager** — outside the repo
   (`docs/CREDENTIALS.md` documents `GATEWAY_SECRET_DIR`, default
   `D:\12412\dsh-home\.secrets\gemini-mcp-gateway`). Exporting vault values into
   env vars is a **需开发** helper; today scripts read the vault directly.

**How to avoid personal tokens in config:** config files contain only
`*_Env` field names and public URLs. Put values in a `.env` file that is
gitignored, in Vercel sensitive env vars, in Docker secrets, or in the vault.
Never paste a token into `servers[]`, a README, an issue, or a capture envelope
(the store hashes secrets; see `src/store.js:169-192`).

### 1.3 Proposed profiles (personal / team / read-only / write)

These are **profiles of intent**, expressed by choosing a config file plus
env vars. No runtime `profile` key exists today — adding one is **需开发**
(it would be an unknown top-level key and only produce a warning,
`src/config.js:65-66`).

| Profile | Config pattern | Tool policy | Credentials |
|---|---|---|---|
| **personal** | your own copy of a profile file with the upstreams you use | `mode: codemode`, `denyTools` for org admin / destructive tools | personal PATs/OAuth tokens in your own env or vault; one deployment per owner |
| **team** | shared config committed to the team repo, no tokens | same external three tools; `denyTools` for billing/members/flag admin tools | one shared service account per upstream, injected by the platform; do **not** share a single personal deployment |
| **read-only** | `mode: codemode`, only read-only upstream tools; `execute` still exists but the model is instructed to use `execute_read` | `allowTools` restricted to `get_*`/`list_*`/`search_*`; `denyTools` for every write verb | read-scoped PATs; **need-development:** hard server-side enforcement that `execute` cannot call write tools — today `execute_read` filtering is the only guard (`src/codemode.js`) |
| **write** | personal/team config with explicit write tools allowed | `denyTools` minimal; expect Gemini per-tool approval for `execute` | tokens with write scope; rotate often; enable capture auditing |

Never commit a profile that contains evaluated secrets. The shipped
`templates/*/*.example.json` files are placeholder-only skeletons.

---

## 2. Environment 1 — Local Node

Directory: [`templates/local/`](../../templates/local/README.md)

### Directory structure (template)

```
templates/local/
├── README.md               # this environment's guide
├── config.local.example.json   # placeholder config, copy to an untracked path
└── .env.example            # env var names only, no values
```

### Required env

- Upstream token vars named in your config (e.g. `EXAMPLE_TOKEN`).
- `GATEWAY_MAX_RESULT_CHARS` — optional, result cap for the non-Code-Mode HTTP
  path (`src/server.js:47`).
- `CAPTURE_MODE` / `CAPTURE_SINK` / `CAPTURE_FILE_DIR` — optional; default off,
  sink `file`, dir `work/capture` (`src/capture.js:183-199`).
- No OAuth server env vars are needed by the local CLI: `src/server.js` does not
  run `createAppHandler`, so OAuth/KV are not involved.

### Startup commands

```bash
npm install
cp templates/local/config.local.example.json ./my-gateway.local.json   # then fill names/URLs, never tokens
# stdio (MCP Inspector / IDE that speaks stdio):
node src/server.js --config ./my-gateway.local.json --stdio
# localhost HTTP (Streamable HTTP):
node src/server.js --config ./my-gateway.local.json --port 3000
```

`npm start` (from `package.json:30`) runs the shipped reference config on port
3000; use the `--config` form for your own profile.

### OAuth / callback

- **Inbound (clients → gateway):** not implemented on the local CLI. Use a
  client that can send no auth / its own headers (MCP Inspector works for tool
  listing; `docs/CLIENTS.md:10`). If you need the OAuth 2.1 flow locally, that
  is **需开发:** mount `createAppHandler()` on a local HTTP server with
  `PUBLIC_BASE_URL=http://127.0.0.1:3000` and allowed redirect URIs — the
  shipped OAuth handler only allowlists `*.googleusercontent.com` redirects
  (`src/oauth.js:20-24`), so Gemini's hosted flow cannot target localhost.
- **Outbound (gateway → upstreams):** provide tokens or refresh material via
  env / vault as described in `docs/CREDENTIALS.md`. Gateway-initiated OAuth
  (`/upstream/oauth/start`) is a Vercel HTTP-entry route only
  (`src/vercel-app.js:288-291`) — **需开发** for local.

### Storage dependencies

- None required. Tokens come from env/vault; no KV is used by the CLI path.
- Optional local capture files under `work/capture/` (`src/capture.js:187`).

### Limits

- HTTP binds `127.0.0.1` only (`src/server.js:503`) — not reachable from
  another machine; a reverse proxy is **需开发**.
- stdio and `--port` are mutually exclusive (`src/server.js:530-533`).
- No persistence of rotated upstream tokens via KV on this path; refresh
  results are in-memory per process (UpstreamAuth) unless seeded elsewhere.
- `UPSTREAMS_JSON` / `GATEWAY_CONFIG` env overrides are ignored by the CLI —
  **需开发** for parity with the HTTP entry.

---

## 3. Environment 2 — Vercel (reference deployment)

Directory: [`templates/vercel/`](../../templates/vercel/README.md)

### Directory structure (template)

```
templates/vercel/
├── README.md               # deployment steps (links to DEPLOY.md)
├── vercel.example.json     # placeholder copy of the repo's vercel.json
└── .env.example            # all variable names, placeholder values only
```

The root `vercel.json` already exists and is used as-is (framework `null`,
rewrite `/(.*)` → `/api/index`, `maxDuration: 60`). The template copy is for
reference only; do not commit a second active config.

### Required env

See `DEPLOY.md:37-49` and `templates/vercel/.env.example`:

| Variable | Purpose |
|---|---|
| `PUBLIC_BASE_URL` | deployment origin, no trailing slash, `https://<your-app>.example.invalid` |
| `ALLOWED_CLIENT_ID` | required; generated client id, disables open DCR when set |
| `ALLOWED_CLIENT_SECRET` | recommended; sensitive random secret |
| `KV_REST_API_URL` + `KV_REST_API_TOKEN` (or `UPSTASH_REDIS_REST_*`) | Upstash Redis REST store for clients/codes/tokens/OAuth state |
| `GITHUB_TOKEN`, `VERCEL_TOKEN`, `NOTION_*`, `LINEAR_*`, `FIGMA_*` | upstream credentials named by the config |
| `GATEWAY_CONFIG` / `UPSTREAMS_JSON` | optional config override; normally unset |
| `UPSTREAM_OAUTH_ADMIN_KEY` | optional; enables `/upstream/oauth/start` |
| `CAPTURE_MODE`, `CAPTURE_SINK`, `R2_*` | optional capture config (file sink is not useful on serverless; use `r2`/`console`/`http`) |

### Startup / deploy commands

```bash
npm install
# configure project env vars in the Vercel dashboard (or `vercel env add NAME production`)
vercel deploy          # or import the repo in the dashboard
```

### OAuth / callback

- Metadata: `/.well-known/oauth-authorization-server`,
  `/.well-known/oauth-protected-resource` (also `.../mcp`).
- Client flow: `/oauth/register` (disabled when `ALLOWED_CLIENT_ID` is set),
  `/oauth/authorize`, `/oauth/token`, `/oauth/revoke` (`src/vercel-app.js:294-315`).
- Gemini custom app URL: `<PUBLIC_BASE_URL>/mcp`; enter client id/secret in
  advanced settings in locked mode (`DEPLOY.md:84-93`). Redirect URIs are
  restricted to Google hosts (`src/oauth.js:20-24`).
- Upstream callback (optional): register
  `<PUBLIC_BASE_URL>/upstream/oauth/callback`, set
  `UPSTREAM_OAUTH_ADMIN_KEY`, open
  `<PUBLIC_BASE_URL>/upstream/oauth/start?server=<name>&key=<ADMIN_KEY>` once
  (`docs/CREDENTIALS.md:131-153`). State is single-use, 10-minute,
  PKCE-bound (`src/store.js:240-257`).
- Token seeding for refresh-based upstreams: `node scripts/seed-upstream-tokens.mjs`
  after KV vars exist (`DEPLOY.md:110-118`).

### Storage dependencies

- Upstash Redis REST is mandatory for `/mcp` on Vercel (bearer lookup,
  `src/vercel-app.js:229-238`). It is the only production store implementation
  today (`src/store.js`).
- Optional R2 / HTTP capture sink; `CAPTURE_MODE` defaults to `off`.

### Limits

- `maxDuration: 60` (`vercel.json:8`); GET `/mcp` intentionally 405, no SSE
  streaming (`src/server.js:463-471`).
- Each POST is stateless; no sticky sessions.
- Hobby log retention is 1 hour (`DEPLOY.md:14-15`).
- One deployment = one owner; do not multi-tenant.
- Serverless filesystem is read-only except `/tmp`; the default `file` capture
  sink is not durable — set `CAPTURE_SINK` to `r2`/`http`/`console`.

---

## 4. Environment 3 — Cloudflare Workers (feasibility evaluation, mostly 需开发)

Directory: [`templates/cloudflare/`](../../templates/cloudflare/README.md)

**Verdict: the current code cannot run on Cloudflare Workers as-is.** The
template is a target design and gap list, not a working deployment.

### Feasibility matrix

| Concern | Today | Workers compatibility / required change |
|---|---|---|
| Node built-ins | `node:http`, `node:crypto`, `node:fs/promises`, `node:path`, `node:url`, `node:zlib`, `node:async_hooks` across `src/server.js`, `src/store.js`, `src/capture.js`, `src/vercel-app.js` | Workers provide `crypto.subtle`, `Web Crypto`, no `node:fs`/`node:http` server. **需开发:** replace with Web APIs; `crypto.createHash` → `crypto.subtle.digest`, `randomUUID` → `crypto.randomUUID()`, `Buffer` → `Uint8Array`/`TextEncoder`. |
| MCP SDK transports | `StdioClientTransport` (child_process) and Node `StreamableHTTPServerTransport` | stdio is impossible in Workers (**需开发:** drop stdio upstreams). HTTP transport needs `fetch`-based / Worker-compatible transport; SSE response handling must be checked against Workers streaming limits. **需开发.** |
| Code Mode sandbox | `run` package creates a QuickJS context **in a worker thread** (`src/codemode.js:12-19`); code uses Node worker_threads | Worker threads do not exist in Workers; QuickJS WASM could run inside the isolate but the `run` SDK integration is Node-specific. **需开发:** new sandbox adapter (e.g. QuickJS WASM) with the same host-bridge surface; re-run all sandbox probes. |
| `waitUntil` import | `src/capture.js:27` imports `@vercel/functions` at module load | Vercel-specific package. **需开发:** adapter abstraction (`ExecutionContext.waitUntil` on Workers, `@vercel/functions.waitUntil` on Vercel, no-op locally). |
| Storage | Upstash Redis REST over `node:crypto` hashing + Lua EVAL CAS (`src/store.js`) | Redis REST itself is fetch-friendly and can work from Workers **if** SHA-256 is ported to Web Crypto and Lua EVAL is sent as JSON body (it already is). **需开发:** WebCrypto TokenStore; alternatively map to KV/D1 with different CAS semantics. |
| KV / D1 | not used today | **需开发 adapter:** implement the `TokenStore` interface over Workers KV (eventual consistency; no atomic GETDEL/EVAL → cannot safely guarantee one-time code redemption or refresh CAS) or D1 (SQLite transactions can implement GETDEL/CAS). D1 is the safer target. |
| OAuth flows | DCR/PKCE/metadata in `src/oauth.js`, routes in `src/vercel-app.js` | Logic is mostly portable after Node-crypto replacement; redirect allowlist and single-owner assumption remain. **需开发:** new Worker router (e.g. Hono/`fetch` handler), adapt `req/res` to `Request/Response`. |
| Streaming responses | Gateway intentionally answers GET `/mcp` with 405; no SSE needed. Upstream `fetch` supports SSE for tools that stream. | Workers support streaming responses but CPU/wall limits apply; passing SSE through needs testing. **需开发:** verify with real upstreams. |
| Filesystem capture | `writeFile`/`mkdir` under `work/capture` | No writable FS. Use R2 binding or HTTP sink. **需开发:** binding-backed sink. |

### Proposed adapter layout (all 需开发)

```
templates/cloudflare/
├── README.md               # this evaluation + link to the gap list
├── wrangler.example.toml   # placeholder bindings: D1, R2, secrets (no account ids)
├── worker.example.js       # sketch only, NOT a working entrypoint
└── config.cloudflare.example.json  # http upstreams only; no stdio
```

Example sketch (illustrative, **需开发**, not runnable):

```js
// worker.example.js — sketch; no createAppHandler for Workers exists today.
export default {
  async fetch(request, env, ctx) {
    // ctx.waitUntil replaces @vercel/functions.waitUntil
    // store = new D1TokenStore(env.DB)   <-- needs development
    // sandbox = new QuickJsSandbox()     <-- needs development
    // return await appHandler(request, env, ctx)
    return new Response('not implemented', { status: 501 });
  },
};
```

### Required env / bindings (target design)

- Secrets: `PUBLIC_BASE_URL`, `ALLOWED_CLIENT_ID`, `ALLOWED_CLIENT_SECRET`,
  upstream `*_TOKEN` names, `UPSTREAM_OAUTH_ADMIN_KEY` (optional).
- Bindings: `DB` (D1, for token store), `CAPTURE_BUCKET` (R2, optional), secret
  values via `wrangler secret put`.
- No `KV_REST_API_*` needed if D1 store is implemented (需开发).

### Startup commands (only after adapters exist)

```bash
npm install
# wrangler secret put ALLOWED_CLIENT_ID  (etc.)
# wrangler d1 create <your-db-name>       # then set database_id in wrangler.toml
wrangler dev --config templates/cloudflare/wrangler.example.toml
wrangler deploy --config templates/cloudflare/wrangler.example.toml
```

### Limits

- Not deployable today; treat every command above as a target, not a verified
  quickstart.
- Workers CPU time limits (default ~50ms CPU, paid modes higher) make QuickJS
  orchestration of many upstream calls risky; needs benchmarking.
- stdio upstreams cannot work; localhost upstreams (Figma desktop etc.) cannot
  be reached from the edge.
- Do not claim KV/D1 token-store parity with Upstash Lua CAS until it is
  implemented and tested.

---

## 5. Environment 4 — Docker (single container + reverse proxy)

Directory: [`templates/docker/`](../../templates/docker/README.md)

### Directory structure (template)

```
templates/docker/
├── README.md               # build/run notes and topology
├── Dockerfile.example      # copy to ./Dockerfile at repo root to build
├── compose.example.yml     # single service + optional reverse proxy profile
├── .env.example            # env var names only
└── nginx.example.conf      # optional TLS/reverse-proxy sketch
```

### Required env

- Upstream token vars named by your config (same as local/Vercel).
- `PORT` (template convention; current CLI uses `--port`, so the Dockerfile
  passes it explicitly — env alone is **需开发** for CLI parity).
- `GATEWAY_CONFIG` points to a config file **inside** the container; mount it
  read-only rather than baking secrets into the image.
- `CAPTURE_MODE`, `CAPTURE_SINK`, `CAPTURE_FILE_DIR` (local file sink works if a
  volume is mounted), or `CAPTURE_HTTP_URL` for an external sink.
- OAuth env vars are **not** honored by the node CLI path; if you terminate TLS
  and want the full OAuth flow, that is **需开发** (see local section).

### Startup commands (with the example Dockerfile that is included)

```bash
cp templates/docker/Dockerfile.example Dockerfile
cp templates/docker/.env.example .env               # fill only env var NAMES with your own values
cp templates/local/config.local.example.json ./my-gateway.local.json
docker build -t my-gateway:local .
docker run --rm -p 3000:3000 --env-file .env \
  -v "$PWD/my-gateway.local.json:/app/gateway-config.json:ro" \
  my-gateway:local
# or: docker compose --env-file .env -f templates/docker/compose.example.yml up --build
# Caveat: src/server.js binds 127.0.0.1, so container port mapping is not
# reachable as shipped; a --host flag is 需开发 (see templates/docker/README.md).
```

### OAuth / callback

- Same as local Node: the CLI does not expose OAuth routes. The reverse proxy
  only terminates TLS and forwards `/mcp`.
- If you need inbound OAuth in Docker, mount the Vercel-style handler via a
  small Node entry that calls `createAppHandler()` — **需开发** (no such entry
  file exists; `api/index.js` is Vercel-specific but the handler itself is
  portable modulo `waitUntil` import).
- Outbound upstream OAuth is still via tokens/vault/refresh env, never in the
  image.

### Storage dependencies

- No KV needed for the CLI path. For rotated OAuth tokens across container
  restarts: **需开发** (persist via Upstash REST using `KV_REST_API_*` and the
  HTTP handler, or mount a volume for a file-backed token store — the latter
  does not exist).
- Capture persistence: mount a volume at `CAPTURE_FILE_DIR` (e.g.
  `/app/work/capture`) or use an HTTP/R2 sink.

### Limits

- Single container, single owner; do not expose publicly without auth —
  `/mcp` on the CLI path has **no bearer validation** (`src/server.js:497-509`).
  Add auth at the reverse proxy (**需开发** config) or use the OAuth-capable
  HTTP handler.
- Image must include Node >= 20.19.0 (`package.json:43-45`).
- Do not bake tokens into layers; use `--env-file`, compose `env_file`, or
  Docker secrets (需开发 for CLI consumption).
- Reverse proxy must forward POST bodies without buffering limits and should
  allow long requests; current gateway caps bodies at 1 MiB
  (`src/server.js:43`).

---

## 6. Minimal quickstarts (≤ 3 commands each)

Assumes Node >= 20.19.0 and a config file with no secrets in it.

**Local stdio**

```bash
npm install
cp templates/local/config.local.example.json ./my-gateway.local.json   # edit: public URLs + env var NAMES
EXAMPLE_HTTP_TOKEN=YOUR_VALUE node src/server.js --config ./my-gateway.local.json --stdio
```

**Local HTTP**

```bash
npm install
cp templates/local/config.local.example.json ./my-gateway.local.json
YOUR_TOKEN_ENV=YOUR_VALUE node src/server.js --config ./my-gateway.local.json --port 3000
```

**Vercel**

```bash
npm install
vercel link                    # or import the repo in the dashboard
vercel deploy                  # after setting env + Upstash KV in the dashboard (DEPLOY.md)
```

**Cloudflare Workers**

```bash
# NOT AVAILABLE — no Worker entry or adapters exist (§4). Commands below are target-only.
npm install
wrangler secret put ALLOWED_CLIENT_ID  # after 需开发 adapters land
wrangler deploy --config templates/cloudflare/wrangler.example.toml
```

**Docker**

```bash
cp templates/docker/Dockerfile.example Dockerfile && cp templates/local/config.local.example.json ./my-gateway.local.json
docker build -t my-gateway:local .
docker run --rm -p 3000:3000 --env-file templates/docker/.env.example -v "$PWD/my-gateway.local.json:/app/gateway-config.json:ro" my-gateway:local
```

Docker caveat (same as §5): the CLI binds `127.0.0.1`, so the port mapping is
scaffold-only until a `--host` flag exists (**需开发**).

No quickstart includes a real token, account, or domain. Replace
`YOUR_VALUE`/`YOUR_TOKEN_ENV` and `<...>` placeholders locally only.

---

## 7. Gap list — what must be built before each template is truthful

Legend: ✅ works today · ⚠️ partial · ❌ 需开发 (needs development).

| Capability | Local | Vercel | Cloudflare | Docker |
|---|---|---|---|---|
| Config file via `--config` / `GATEWAY_CONFIG` | ✅ | ✅ | ❌ adapter | ✅ via volume |
| `UPSTREAMS_JSON` inline override | ❌ CLI ignores it | ✅ | ❌ | ❌ same as CLI |
| `profile` selection (personal/team/read-only/write) | ❌ | ❌ | ❌ | ❌ |
| stdio upstreams | ✅ | ❌ (no child_process) | ❌ impossible | ✅ |
| Streamable HTTP upstreams | ✅ | ✅ | ⚠️ needs Worker transport test | ✅ |
| Stateless `/mcp` POST | ✅ | ✅ | ❌ router needed | ✅ |
| Bearer auth on `/mcp` | ❌ | ✅ (KV lookup) | ❌ | ❌ (proxy auth 需开发) |
| OAuth 2.1 metadata / DCR / PKCE / token | ❌ | ✅ | ❌ | ❌ |
| Upstream OAuth start/callback | ❌ | ✅ | ❌ | ❌ |
| Token store (Upstash REST) | ⚠️ not used by CLI | ✅ | ⚠️ needs WebCrypto port | ⚠️ not used by CLI |
| Token store on KV/D1 | n/a | n/a | ❌ (CAS/GETDEL semantics) | n/a |
| Code Mode sandbox (`run` QuickJS) | ✅ (Node worker thread) | ✅ | ❌ needs WASM adapter | ✅ |
| `waitUntil` abstraction | n/a | ✅ via `@vercel/functions` | ❌ use `ctx.waitUntil` | n/a |
| Durable capture | ✅ local files | ✅ R2/HTTP sink | ❌ R2 binding sink | ✅ via mounted volume |
| Reverse-proxy / TLS termination guide | n/a | n/a | n/a | ⚠️ config sketch only |
| Image / Wrangler config files in repo | n/a | n/a | ❌ | ❌ (template examples only) |

Concrete files/adapters needed (all outside the scope of this documentation
change):

1. `src/runtime/waitUntil.js` — unify Vercel / Workers / no-op.
2. `src/store-webcrypto.js` — WebCrypto hash + REST commands for Workers.
3. `src/store-d1.js` — D1 implementation with `getdel`/CAS parity, plus tests.
4. `src/worker-app.js` — `fetch(request, env, ctx)` router mapping to the
   existing OAuth/MCP handlers.
5. `src/sandbox/quickjs-wasm.js` — Worker-compatible Code Mode sandbox with the
   same host-bridge contract, plus re-run of the sandbox probes.
6. `src/local-app.js` — Node HTTP entry mounting `createAppHandler()` so local
   and Docker can use OAuth/KV (and a `--upstreams-json` CLI flag for parity).
7. `Dockerfile`, `docker-compose.yml`, `wrangler.toml` — real deployment files
   (templates here are `.example` copies only).
8. Tests for each adapter (config parity, OAuth flow, token store CAS, sandbox
   isolation) before documenting any of them as supported.

Until these exist, do **not** advertise Cloudflare or Docker OAuth/KV/V1-ready
status in README or release notes.

---

## 8. Security reminders

- Never commit tokens, client secrets, account IDs, or real hostnames. Use
  placeholders and env var names.
- Keep one deployment per owner (`DEPLOY.md:8-10`).
- Capture files can contain full upstream payloads; restrict access and set
  `CAPTURE_MODE=off` unless auditing is needed.
- `execute` is a write-capable tool; Gemini still asks per-tool approval. Batch
  writes and grant approval consciously (`docs/CREDENTIALS.md:47-53`).
- Schemas registered with Gemini must pass `sanitizeTool`; tool names use
  `server__tool`; results are text JSON, not `structuredContent` (AGENTS.md).
