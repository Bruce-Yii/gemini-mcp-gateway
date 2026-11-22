# Docker deployment template (single container + reverse proxy)

Status: **example files only**. The CLI path works inside a container today;
OAuth on `/mcp` does not (the CLI has no bearer validation) — putting an
auth-capable HTTP entry in the image is **需开发**. Full design:
[docs/OPEN-SOURCE/DEPLOYMENT-TEMPLATES.md §5](../../docs/OPEN-SOURCE/DEPLOYMENT-TEMPLATES.md).

## Layout

```
templates/docker/
├── README.md            # this file
├── Dockerfile.example   # copy to repo-root Dockerfile before building
├── compose.example.yml  # single service + optional proxy profile
├── .env.example         # env var NAMES only, placeholder values
└── nginx.example.conf   # optional TLS/reverse-proxy sketch
```

## Quickstart (≤ 3 commands)

```bash
cp templates/docker/Dockerfile.example Dockerfile && cp templates/local/config.local.example.json ./my-gateway.local.json
docker build -t my-gateway:local .
docker run --rm -p 3000:3000 --env-file templates/docker/.env.example -v "$PWD/my-gateway.local.json:/app/my-gateway.local.json:ro" my-gateway:local
```

Compose variant:

```bash
docker compose --env-file templates/docker/.env.example -f templates/docker/compose.example.yml up --build
```

The Dockerfile installs prod dependencies, runs as a non-root user, and starts
`node src/server.js --config /app/gateway-config.json --port 3000`. Mount your
config at `/app/gateway-config.json` read-only. It does **not** bake any
tokens into layers. Node >= 20.19.0 is required (`package.json:43-45`).

**Known limitation:** `startHttpServer()` binds `127.0.0.1`
(`src/server.js:503`), so the container's port is not reachable from outside
the container as shipped. A `--host 0.0.0.0` CLI flag (or an env-driven bind
address) is **需开发**; until then the example commands are a scaffold, not a
verified network path. Alternatively, run the container with `--network host`
and connect from the same host, or mount an auth-capable HTTP entry
(**需开发**, see below).

## Config / env

- Copy `templates/local/config.local.example.json` to an untracked path; edit
  only public URLs and env var names. Mount it into the container.
- `.env.example` lists upstream token var names and optional capture vars.
  Never commit the filled `.env`.
- `GATEWAY_CONFIG`/`UPSTREAMS_JSON` are not read by the CLI — **需开发** for
  parity; the Dockerfile uses `--config`.
- Optional capture: `CAPTURE_MODE=meta|full`, `CAPTURE_SINK=file|http|r2`,
  `CAPTURE_FILE_DIR=/app/work/capture` (mount a volume for durability).

## OAuth / callbacks

- Inbound OAuth routes do not exist on the CLI path. The proxy sketch only
  terminates TLS and forwards `/mcp`; it provides no authentication.
- Do not expose the container publicly without auth. Add bearer auth at the
  proxy (**需开发**) or mount a Node entry that calls `createAppHandler()`
  (`src/vercel-app.js`) — that entry file does not exist yet (**需开发**).
- Outbound upstream credentials come from env/vault/refresh env. Never put
  them in the image, compose file, or config JSON.
- A full OAuth + KV deployment on Vercel is documented in
  [DEPLOY.md](../../DEPLOY.md).

## Storage / persistence

- No KV needed for the stateless CLI path. Rotated upstream tokens are
  process-local; durable local storage is **需开发**.
- Capture files persist only if you mount a volume at `CAPTURE_FILE_DIR` or use
  an HTTP/R2 sink.
- Upstash Redis can still be used by a future HTTP entry via `KV_REST_API_*`
  (需开发 for the container).

## Limits

- Single container, single owner. No multi-tenancy.
- `/mcp` caps request bodies at 1 MiB (`src/server.js:43`); the proxy must not
  impose a smaller client_max_body_size.
- HTTP binds `127.0.0.1` inside the container (`src/server.js:503`), so port
  mapping / the nginx proxy sketch do not work until a `--host` flag is added
  (**需开发**) or a network-host workaround is used.
- Tool surface stays the three Code Mode tools; keep schemas sanitized.
