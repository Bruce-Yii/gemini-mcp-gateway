# Docker deployment — real verification report

This is a factual record of an actual Docker verification run for the repo-root
`Dockerfile` / `docker-compose.yml`. No source code, scripts, tests, README, or
other docs were changed. No commit, push, or deploy was performed.

Date/time of run: 2026-11-23 (Asia/Singapore, UTC+8).
Host: Windows 10 (build 22631), Docker Desktop with daemon v29.8.2
(`docker version --format '{{.Server.Version}}'` → `29.8.2`). The daemon was
initially stopped; it was started locally for this verification.

## Scope and inputs read before running

- `Dockerfile` — `node:20-bookworm-slim`, `USER node`, `EXPOSE 3000`, TCP
  healthcheck, `CMD` with `--config /app/gateway-config.json --host 0.0.0.0 --port 3000`.
- `docker-compose.yml` — single service, binds `127.0.0.1:3000:3000`, mounts
  `./my-gateway.local.json` read-only at `/app/gateway-config.json`, `env_file: .env`.
- `.dockerignore` — excludes `.git`, `.env`, `.env.*`, `*.local.json`,
  `my-gateway.local.json`, `node_modules`, `tests/`, `scripts/`, `docs/`, etc.
- `docs/OPEN-SOURCE/DOCKER.md` — documents the setup and its limits.
- `config.example.json` and `templates/local/{README.md,config.local.example.json,.env.example}`
  — config contains env var NAMES only, never token values.
- `src/server.js` — confirmed `GET /mcp` → 405, `POST /mcp` → normal MCP,
  `DELETE /mcp` → 204, other paths → 404, `--host` parsed and passed to
  `httpServer.listen(port, host)`, default host `127.0.0.1`.

## Temporary verification inputs (untracked, no real secrets)

- `my-gateway.local.json`: one upstream named `placeholder-upstream`, transport
  `http`, URL `https://mcp.invalid.example/mcp`, `tokenEnv: EXAMPLE_HTTP_TOKEN`.
  This URL is deliberately unreachable; no real token was used.
- `.env`: `EXAMPLE_HTTP_TOKEN=PLACEHOLDER_NOT_A_REAL_TOKEN` (placeholder only).

These files were created for the run and removed afterwards.

## Commands and results

### 1. Build the image

```bash
docker build -t gemini-mcp-gateway:verify .
BUILD_EXIT=0
```

Build log saved as `docker-build-verify.log` (untracked). Key steps:
`npm ci --omit=dev` added 117 packages, 0 vulnerabilities; `COPY src`, `COPY api`;
final image tagged `gemini-mcp-gateway:verify` (manifest
`sha256:7d249f42…`). Base image resolved to
`node:20-bookworm-slim@sha256:2cf067cf…` with `NODE_VERSION=20.20.2`, which
satisfies `engines.node >= 20.19.0`.

### 2. Image metadata / no secrets in layers

```bash
docker inspect gemini-mcp-gateway:verify \
  --format 'User={{.Config.User}} ExposedPorts={{.Config.ExposedPorts}} Cmd={{json .Config.Cmd}} Healthcheck={{json .Config.Healthcheck}}'
```

Output:

```
User=node
ExposedPorts=map[3000/tcp:{}]
Cmd=["node","src/server.js","--config","/app/gateway-config.json","--host","0.0.0.0","--port","3000"]
Healthcheck={"Test":["CMD-SHELL","node -e \"const s=require('net').connect({host:'127.0.0.1',port:Number(process.env.PORT||3000)},()=>{s.end();process.exit(0)});s.on('error',()=>process.exit(1));setTimeout(()=>{s.destroy();process.exit(1)},2000)\""],"Interval":30000000000,"Timeout":3000000000,"StartPeriod":10000000000,"Retries":3}
```

```bash
docker history --no-trunc gemini-mcp-gateway:verify > docker-history-verify.log
```

The history contains only the expected layers: `FROM`, `WORKDIR`, `COPY package*.json`,
`npm ci`, `COPY src`, `COPY api`, `RUN mkdir/chown`, `USER node`, `EXPOSE`,
`HEALTHCHECK`, `CMD`. Grep for the placeholder token value, `my-gateway.local.json`,
and `.env` produced **no secret-bearing match** (the only `.env`-like substring is
`process.env.PORT` inside the healthcheck command, which is not a value).

Image filesystem spot check:

```bash
docker run --rm --entrypoint sh gemini-mcp-gateway:verify -c \
  'ls -la /app; find /app -maxdepth 2 -name "*.env*" -o -name "my-gateway*" -o -name "gateway-config.json" -o -name "token*"; stat -c "%U %n" /app/work/capture'
```

`/app` contains only `api/`, `node_modules/`, `package.json`, `package-lock.json`,
`src/`, `work/`. The `find` returned nothing. `/app/work/capture` is owned by
`node`. Conclusion: no `.env`, local config, or token value is baked into the image.

### 3. Run container with temp config (direct `docker run`)

```bash
docker run -d --name gw-verify -p 13000:3000 \
  --env-file .env \
  -v "$PWD/my-gateway.local.json:/app/gateway-config.json:ro" \
  gemini-mcp-gateway:verify
```

`RUN_EXIT=0`; container id `cd06403b1f49…`.

Startup log (`docker logs gw-verify`, saved as `docker-logs-verify.log`):

```
[upstreams] [upstream:placeholder-upstream] 连接失败: fetch failed
[upstreams] 1/1 upstreams failed: placeholder-upstream
[gemini-mcp-gateway] Streamable HTTP endpoint: http://0.0.0.0:3000/mcp (host=0.0.0.0, port=3000)
```

The upstream failure is expected with the unreachable placeholder URL; the gateway
still starts (config warning only, as documented).

**Container starts:** `docker inspect` → `Status=running Running=true`.

**Non-root:** `docker exec gw-verify id` →
`uid=1000(node) gid=1000(node) groups=1000(node)`.

**Port 3000 and `--host 0.0.0.0`:** `docker exec gw-verify node -e …` reading
`/proc/net/tcp` showed `local_address=00000000:0BB8 state=0A`
(`00000000` = 0.0.0.0, `0BB8` hex = 3000, `0A` = LISTEN). The startup log also
prints `host=0.0.0.0, port=3000`. This confirms `--host 0.0.0.0` is effective.

**Healthcheck passes:** after the 10s start period,
`docker inspect gw-verify --format '... {{.State.Health.Status}} ...'` →
`Health=healthy`; health log exit code `0`. The healthcheck is a TCP connect to
127.0.0.1:3000 (there is no `/healthz` on this path, as documented).

**Host `curl` to /mcp** (host port 13000 mapped to container 3000):

| Request | Result |
| --- | --- |
| `curl http://127.0.0.1:13000/mcp` | `HTTP_CODE=405` (expected; GET is not allowed) |
| `curl -X POST -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' --data '{"jsonrpc":"2.0","id":1,"method":"initialize",...}' http://127.0.0.1:13000/mcp` | `HTTP_CODE=200`, `CONTENT_TYPE=text/event-stream` |
| `curl http://127.0.0.1:13000/healthz` | `HTTP_CODE=404` (no such route on CLI path, as documented) |

All requests produced real HTTP responses (no connection failure).

### 4. Compose path (static + end-to-end)

```bash
docker compose -f docker-compose.yml config          # valid; exit 0
docker compose -f docker-compose.yml run -d --name gw-compose-verify -p 13001:3000 gateway
```

`docker compose config` resolved the bind mount read-only, `env_file` values,
loopback host port, and command correctly. (It printed `EXAMPLE_HTTP_TOKEN:
PLACEHOLDER_NOT_A_REAL_TOKEN` under `environment` — that is runtime injection
from `.env`, not a layer in the image.)

The compose build first attempted to pull `gemini-mcp-gateway:local` from the
configured registry, which failed (`免费节点当前繁忙…`), then successfully built
the image locally from the Dockerfile and started the container. This is an
environment/network note, not a project bug.

Compose container checks: `Status=running Health=healthy User=node`; host
`curl http://127.0.0.1:13001/mcp` → `HTTP_CODE=405`. Logs show the same
`host=0.0.0.0, port=3000` startup line. Saved as `docker-compose-config-verify.log`
and `docker-compose-up-verify.log` (untracked).

## Summary

| Checked item | Result |
| --- | --- |
| `docker build` succeeds | PASS |
| Container starts with mounted config, no real token | PASS |
| Runs as non-root (`node`, uid 1000) | PASS |
| Listens on 0.0.0.0:3000 (`--host` effective) | PASS |
| Healthcheck reports `healthy` (exit 0) | PASS |
| Host `curl /mcp` → 405 (GET) / 200 (POST), no connection failure | PASS |
| No `.env` / token / local config baked into image layers or filesystem | PASS |
| `docker compose config` and compose run path | PASS (local build after registry pull failure) |
| `/healthz` route exists on this image | N/A — documented as Vercel-only; `GET /healthz` → 404 as expected |

## Limitations / not verified

- Only the standalone CLI container path was verified; OAuth/DCR, `/healthz`,
  and KV-backed token storage are not part of this image (documented in
  `DOCKER.md`). No real upstream token exists in verification files, so real
  upstream tool calls were not exercised.
- Verification was performed on Docker Desktop / Windows with a Linux container;
  no Linux host, Kubernetes, TLS termination, or authenticating reverse proxy
  was in scope.
- The Docker daemon had to be started manually; the registry mirror returned a
  transient error before the local build succeeded.
- Log files and temp config/.env created for verification were untracked and
  removed at the end; no commit/push/deploy was made.

## Conclusion

No defects were found in `Dockerfile`, `docker-compose.yml`, `.dockerignore`, or
`docs/OPEN-SOURCE/DOCKER.md`, so those files were intentionally left unchanged.
The Docker deployment is verified as working for its documented scope.
