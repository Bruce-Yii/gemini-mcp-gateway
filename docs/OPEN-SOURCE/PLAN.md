# Open-source launch plan

> Status: **proposal for lead decision**. No calendar dates; workstreams run in
> parallel by dependency. Source research:
> [competitors](COMPETITORS.md), [web clients](WEB-CLIENTS.md),
> [deployment templates](DEPLOYMENT-TEMPLATES.md), [readiness audit](READINESS.md).

## 0. One-line positioning

> **The Code Mode MCP gateway for web AI clients — three stable tools, a real
> QuickJS sandbox, and full-fidelity captures for evaluation.**

Recommended public name: **`codemode-mcp-gateway`** (neutral; `gemini` stays a
keyword + “tested with Gemini web” section). Keep `gemini-mcp-gateway` only if
brand continuity is more important than client breadth.

## 1. What we are / are not

**We are:** single-owner, self-hosted Code Mode gateway for web MCP clients.
One deployment holds the user's upstream credentials; the model-facing surface
is always three tools (`search` / `execute_read` / `execute`); execution is
isolated; captures are full-fidelity and feed a real eval loop.

**We are not:** multi-tenant SaaS, enterprise policy engine, general LLM
gateway, connector marketplace, or a guarantee that every web client works.
`SECURITY.md` already says “one deployment = one owner”; make that explicit in
README and release notes.

## 2. Competitive conclusion

- Pure MCP aggregation is red ocean (MetaMCP archived, MCPHub/Unla/agentgateway/
  Docker active). We should not compete on “more servers”.
- Code Mode is no longer unique (Cloudflare MCP Portals default, Limen,
  dev-mcp, Forgemax). We should not claim uniqueness.
- Our defensible combination:
  1. **3 tools with read/write split** (`execute_read` vs `execute`);
  2. **QuickJS engine-level isolation** in a portable Node/Vercel gateway;
  3. **full-fidelity capture + L1/G6 scorecard**;
  4. **real write replay + real Gemini session proof**.
- The only direct web-client competitor (`gemini-bastion-mcp`) is a vertical
  coding/DevOps toolkit; we are a generic upstream aggregator. Different lane.

## 3. Client scope for v0.1

| Client | v0.1 commitment | Work |
|---|---|---|
| Gemini web custom apps | ✅ tested | Keep current guarantees; add annotations |
| Claude.ai web | ✅ target | 401 metadata, `readOnlyHint`/`destructiveHint`, 150k result cap, public 443 |
| MCP Inspector / local | ✅ target | Reproducible smoke, no real tokens needed |
| ChatGPT web | ⚠️ documented, not promised | Business/Enterprise/Edu only; OAuth only (no static Bearer); `readOnlyHint`; schema/tool-name review |
| Copilot Studio | ⏸️ later | Streamable + DCR; no consumer Copilot claim |
| Grok / Perplexity | ❌ not promised | Unverified/broken reports; re-test later |

**Do not advertise “works with every MCP client.”** The README matrix must show
tested/target/documented/not-promised.

## 4. Deployment matrix for v0.1

| Environment | v0.1 | Notes |
|---|---|---|
| Local Node | ✅ | `npm start`, localhost HTTP / stdio; no tokens needed to inspect; optional static token |
| Docker | ✅ | single container; **needs `--host` flag** because current server binds `127.0.0.1`; env-file + volume |
| Vercel | ✅ | current reference; Upstash Redis; OAuth DCR |
| Cloudflare Workers | ⏸️ design only | Node APIs, worker-thread QuickJS, `waitUntil`, Upstash Lua CAS, R2, streaming all need adapters; do not promise one-click |
| Cloudflare Containers / Tunnel | P2 | could document as “run Docker behind Tunnel” without a Workers port |

Release artifacts:

```text
Dockerfile
docker-compose.yml
templates/local/
templates/docker/
templates/vercel/
templates/cloudflare/   # sketch + gap list, not supported
```

## 5. Configuration & profiles

Unified JSON shape is already enforced by `src/config.js`: `mode`,
`maxWhitelistTools`, `maxCalls`, `maxResultChars`, `servers[]`, env-var names for
secrets.

For v0.1, add **examples**, not a new config engine:

```text
config.example.json          # neutral placeholders
templates/local/config.local.example.json
templates/docker/config.docker.example.json
templates/vercel/config.vercel.example.json
```

Profiles to document (and only implement if needed):

- `read-only`: upstream allowlist excludes all write tools; `execute` stubbed;
- `personal`: read + write, single-owner;
- `docker`: env-driven config path `/app/gateway-config.json`;
- `vercel`: `UPSTREAMS_JSON` / `GATEWAY_CONFIG` + KV.

Do not invent a profile key before the loader supports it; docs must label
“needs development” until then.

## 6. Workstreams (parallel, no dates)

### W-OSS-1 · Identity, hygiene, publication gate (P0)

- Decide owner/org and project name.
- Replace real Vercel hostnames and Figma identity in tracked docs with
  placeholders.
- Replace personal vault/absolute paths with `GATEWAY_SECRET_DIR`/`~/.secrets`.
- Remove personal defaults from `scripts/replay-write.mjs`; require explicit
  `REPLAY_OWNER`/`REPLAY_REPO`.
- Decide `capture-daily` workflow fate: default `workflow_dispatch` or restrict
  to owner repo; do not auto-push generated scorecards from forks.
- Harden `.gitignore`: `outputs/`, captures, `config.local.*`, dated handoffs,
  `explore/results/**` exceptions.
- Decide whether internal `docs/ledger/`, `PLAN-*`, `HANDOFF-*`, `AGENTS.md`
  stay public or move to a private/ops tree.

Acceptance: tracked-file grep for real hostnames/paths/personal defaults is
clean; a fresh clone can run tests without tokens; no workflow pushes capture
artifacts to a fork's `main`.

### W-OSS-2 · Docker + local deployment (P0)

- Add `--host` to local HTTP server (currently binds `127.0.0.1`).
- Real `Dockerfile` + `docker-compose.yml` + healthcheck + volume for
  `work/capture` (optional).
- Local quickstart: inspect three tools without upstream tokens; then add one
  upstream.
- Document single-owner model and data directory.

Acceptance: `docker compose up` exposes `/healthz` and `/mcp`; no host
networking workaround; container can be reached from host browser.

### W-OSS-3 · Client adapter layer (P1, needed for Claude launch)

- Central annotations on all tools: `readOnlyHint`, `destructiveHint`,
  `openWorldHint`.
- Result encoding profile: Gemini = text JSON only; Claude = text; ChatGPT
  profile (later) = `structuredContent` + text JSON.
- Auth profiles: DCR (default), locked client, optional static header for
  clients that support it (Claude beta/Copilot); never change DCR for ChatGPT.
- Keep one canonical tool name; display/description variants only in profile.
- Validate with Claude.ai + Inspector before claiming support.

Acceptance: Gemini still passes; Claude connector loads tools and completes a
read + a write with correct confirmation behavior; no `if (client===...)` in
core execution path.

### W-OSS-4 · README and docs (P1)

- Rewrite README first screen: one-line positioning, 3 tools, 506→3 metrics,
  tested matrix, quickstart, non-goals, link to competitors.
- Remove stale absolute test counts or generate them.
- Add “no tokens needed for local inspection/tests”.
- Add scope & non-goals; link SECURITY/CREDENTIALS.
- Add `CODE_OF_CONDUCT.md`; keep CONTRIBUTING.
- Add `package.json` `files` before any npm publish; run `npm pack --dry-run`.
- Fix badge/clone URLs after rename.

Acceptance: a stranger clones, reads README, runs local inspect in <3 commands,
and understands it is single-owner/self-hosted.

### W-OSS-5 · Eval/CI publication policy (P1)

- Decide what `docs/eval/` artifacts are public.
- Make daily capture workflow opt-in or owner-repo-only; document secrets.
- Keep CI offline and credential-free.
- Keep truncation audit + context measurement green.

Acceptance: fork CI passes without secrets; scheduled capture does not mutate
fork main; public scorecards contain only aggregated data.

### W-OSS-6 · Cloudflare evaluation (P2, after launch)

- Prove or reject Workers port:
  - WebCrypto/D1 or Upstash-compatible store;
  - QuickJS via WASM/Dynamic Workers instead of Node worker thread;
  - waitUntil abstraction;
  - streaming/SSE behavior;
  - R2 capture sink.
- If rejected, publish “Cloudflare: use Docker behind Tunnel” instead of a
  half-working Workers template.

Acceptance: a documented decision with prototype evidence, not a promise.

## 7. Release gate (v0.1.0)

Must be true before making the repo public:

- [ ] Owner/name decided; package metadata + README + LICENSE consistent.
- [ ] No real domains, personal paths, personal defaults in tracked files.
- [ ] `.gitignore` blocks captures/outputs/dated handoffs.
- [ ] `capture-daily` cannot push to forks by default.
- [ ] `npm test` passes on Node 20/22/24 from a clean clone.
- [ ] `npm start` lets a stranger inspect 3 tools without tokens.
- [ ] Docker compose works; `/healthz` + `/mcp` reachable.
- [ ] README client matrix honest; Gemini tested, Claude target, ChatGPT
      documented-not-promised.
- [ ] CONTRIBUTING + SECURITY + CODE_OF_CONDUCT present.
- [ ] Release notes state v0.1 alpha, single-owner/self-hosted, API may change.

## 8. Explicit non-goals for v0.1

- multi-tenant/RBAC/hosted SaaS;
- enterprise policy engine/Zero Trust;
- general LLM gateway or model routing;
- connector marketplace/management UI;
- ChatGPT consumer/Plus full write support;
- Cloudflare Workers one-click deployment;
- “all MCP clients supported” claim.

## 9. Open decisions for the lead

1. Project name: `codemode-mcp-gateway` (recommended) vs keep
   `gemini-mcp-gateway`.
2. Publish under personal account or new org; update owner-dependent strings.
3. v0.1 clients: Gemini + Claude + Inspector (recommended) vs also ChatGPT
   Business.
4. Public eval artifacts: keep scorecards public, or make the workflow
   dispatch-only and keep `docs/eval/` curated.
5. Cloudflare: design-only after launch (recommended) vs attempt Workers port
   before launch.
