# Docker deployment (standalone CLI gateway)

This is the **runnable** Docker setup for the local CLI path. The older
`templates/docker/*` files are examples; this document and the repo-root
`Dockerfile` / `docker-compose.yml` are the real thing.

The image runs `node src/server.js` — the same stateless Streamable HTTP
gateway used by the CLI. It is **not** the Vercel entry: OAuth routes, `/healthz`
and KV-backed token storage are not part of this container (see limits below).
No Cloudflare product or service is involved in this deployment.

## Quickstart

```bash
# 1. Config (no real secrets in the JSON — only env var NAMES):
cp templates/local/config.local.example.json ./my-gateway.local.json
#    edit URLs / tokenEnv names; keep this file untracked.

# 2. Env: copy the names-only example, then fill real values from your vault.
cp templates/local/.env.example .env
#    .env must stay untracked; never commit it or bake it into the image.

# 3. Build and run:
docker compose up --build
```

The MCP endpoint is `http://127.0.0.1:3000/mcp` on the host by default. The
container listens on `0.0.0.0:3000` internally so the port mapping works — that
is what `--host 0.0.0.0` in `docker-compose.yml` provides. Without it the CLI
would bind `127.0.0.1` inside the container and the mapped port would be dead.

Stop with `docker compose down`. No volumes hold credentials; capture output
lives in `./work/capture` on the host.

## Required / optional environment

- **Upstream tokens:** every `tokenEnv` (and `refreshEnv` / `clientIdEnv` /
  `clientSecretEnv` if configured) named in `my-gateway.local.json` must be set
  in `.env` (or another `env_file`). The template uses `EXAMPLE_HTTP_TOKEN`.
  A missing token only produces a config warning at startup and the upstream is
  skipped — the gateway still starts.
- `GATEWAY_MAX_RESULT_CHARS` (optional): caps text blocks returned to the model.
- `CAPTURE_MODE` (optional): `off` (default), `meta`, or `full`.
- `CAPTURE_SINK` (optional): `file` (default) or `http`.
- `CAPTURE_FILE_DIR` (optional): defaults to `./work/capture` in the process;
  the container writes to `/app/work/capture` (the compose volume target).
- `CAPTURE_HTTP_URL` / `CAPTURE_HTTP_TOKEN` (optional): only for `CAPTURE_SINK=http`.
- `GATEWAY_CONFIG` / `UPSTREAMS_JSON` are **not** read by this CLI entry; pass
  config with `--config` (the compose file mounts it at
  `/app/gateway-config.json`).

Config JSON contains **variable names**, never token values. Values come from
`.env` / your secret store at container start.

## OAuth and callback limitations

- Inbound OAuth / DCR routes do not exist on this path. Do not expose the
  container to the public internet without an authenticating reverse proxy;
  the CLI does no bearer-token validation.
- Callback URLs configured on upstreams (`oauthRedirectUri`) cannot be served
  by this container. Authorization must be completed outside it (e.g. the
  Vercel deployment), with the resulting token supplied via env.
- Outbound upstream credentials are read from env at startup. Rotated tokens
  are process-local; there is no durable token store here.

## Capture data volume

`docker-compose.yml` bind-mounts `./work/capture` to `/app/work/capture`.
Set `CAPTURE_MODE=meta` or `full` in `.env` and keep `CAPTURE_SINK=file` for
files to land there. The directory is owned by the non-root `node` user inside
the image. Without the volume, capture data is lost when the container is
removed. To use an HTTP sink instead, set `CAPTURE_SINK=http` and the two
capture env vars, and you may drop the volume line.

## Health check

The Dockerfile healthcheck opens a **TCP connection** to port 3000. There is no
`/healthz` route on the CLI/standalone path — that route exists only in the
Vercel entry (`src/vercel-app.js`) and is not mounted in this container. A bare
`GET /mcp` returns 400/405, so it is not a valid health signal either. Local
`/healthz` parity is a separate follow-up task and is not claimed here.

## Image notes

- Base `node:20-bookworm-slim` satisfies `engines.node >= 20.19.0`; `node:22`
  also works if you change the `FROM` tag.
- Dependencies are installed with `npm ci --omit=dev` from `package-lock.json`.
  `package.json` declares no `devDependencies`, so no test/build tooling is
  needed at runtime.
- The image runs as the non-root `node` user, copies only `src/` and `api/`,
  and exposes port 3000. There is no `config/` directory in this repo; the
  gateway config is supplied by the compose mount.
- `.dockerignore` keeps `.env`, local configs, `node_modules`, git data, tests,
  scripts and docs out of the build context.
