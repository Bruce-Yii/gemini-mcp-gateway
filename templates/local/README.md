# Local Node deployment template

Current status: **works with the existing code** (`src/server.js` CLI). No
OAuth server, no KV, no adapters required. See
[docs/OPEN-SOURCE/DEPLOYMENT-TEMPLATES.md](../../docs/OPEN-SOURCE/DEPLOYMENT-TEMPLATES.md)
for the full design and the meaning of **需开发**.

## Layout

```
templates/local/
├── README.md                    # this file
├── config.local.example.json    # placeholder-only config (copy before use)
└── .env.example                 # env var NAMES, no values
```

## Quickstart (≤ 3 commands)

```bash
npm install
cp templates/local/config.local.example.json ./my-gateway.local.json   # edit public URLs + env var names only
YOUR_TOKEN_ENV=YOUR_VALUE node src/server.js --config ./my-gateway.local.json --stdio
```

HTTP instead of stdio:

```bash
YOUR_TOKEN_ENV=YOUR_VALUE node src/server.js --config ./my-gateway.local.json --port 3000
# endpoint: http://127.0.0.1:3000/mcp
```

`npm start` runs the shipped reference config (`config.example.json`) and is
not recommended for personal use — copy the example instead.

## Modes

- `--stdio`: MCP over stdin/stdout. Use with MCP Inspector
  (`npx @modelcontextprotocol/inspector`) or a stdio-capable IDE.
- `--port N`: Streamable HTTP at `http://127.0.0.1:N/mcp`. POST only; GET
  returns 405, DELETE 204. Binds loopback only.

The two modes are mutually exclusive (`--stdio` + `--port` is an error).

## Config rules

- `servers[].tokenEnv` etc. are **environment variable names**, never token
  values. The config file itself must contain no secrets.
- `name` must match `^[A-Za-z0-9_-]{1,32}$` and be unique.
- `transport` is `http` or `stdio`; `stdio` needs `command` (+ optional
  `args`, `env`), `http` needs an absolute `url`.
- `mode: "codemode"` exposes the three stable tools `search` /
  `execute_read` / `execute`. Keep this surface stable.

## Env

Copy `.env.example` to an untracked `.env` and export values in your shell (or
use a tool that loads `.env`). Names must match what your config references.
Optional:

- `GATEWAY_MAX_RESULT_CHARS` — cap for text results on the HTTP path.
- `CAPTURE_MODE=off|meta|full`, `CAPTURE_SINK=file|console|http|r2`,
  `CAPTURE_FILE_DIR` — local capture defaults to `work/capture`, mode `off`.

## OAuth / callbacks

- Inbound OAuth (metadata, DCR, PKCE, `/oauth/*`) is **not** served by this
  CLI. MCP Inspector / local clients that can send their own headers work for
  tool listing. Gemini's hosted custom apps cannot use a localhost OAuth
  redirect.
- Making the full OAuth flow available locally is **需开发**: mount
  `createAppHandler()` from `src/vercel-app.js` on a local Node HTTP server and
  relax/extend the Google-hosted redirect allowlist deliberately.
- Upstream tokens / refresh material come from env or the local vault
  (`docs/CREDENTIALS.md`). Gateway-initiated OAuth routes exist only in the
  Vercel HTTP entry today — **需开发** locally.

## Storage and limits

- No KV needed. Rotated upstream tokens are process-local; a restart may
  require re-seeding (需开发 for durable local token storage).
- HTTP binds `127.0.0.1` only; remote access needs a reverse proxy (see the
  Docker template; authentication at the proxy is 需开发).
- `UPSTREAMS_JSON` / `GATEWAY_CONFIG` env overrides are ignored by the CLI —
  use `--config` (parity is 需开发).
