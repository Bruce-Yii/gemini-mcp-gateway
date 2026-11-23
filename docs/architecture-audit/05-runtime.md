# 架构深读审计 05 — 运行时 / 部署（Runtime & Deployment）

> 只读审计，仅新增本文件；未改 src/、scripts/、tests/、README、其他 docs、workflows；未 commit / push / deploy。
> 审计日期锚点：2026-11-24（Asia/Singapore）。代码视角为本地工作树；生产事实来自只读 `GET /healthz` 与文档，不读任何 token 值。
> 证据强度约定：**[代码]** 已在源文件逐行核对；**[文档]** 来自已列出的 docs；**[线上]** 来自生产只读探测；**[未验证]** 无证据，不写成 PASS。

---

## 0. 结论摘要（不美化）

- 运行时模块当前**只有 Vercel 一条真实载体**，且 Health/BuildHash/部署日志/手动 promote 已具备可追溯骨架；生产 `/healthz` 实测 `commit=d1f36ba45c1d55e1f23035ea6534bd27c7d9480f`、`buildHash=a1002d867d051ded5c90c3e73bcd8fa64d825a9b`、`env=production`、`deploymentId=dpl_7qGruKcZ8ffE7rri6erS6ZaiqiNS`。**[线上]**
- Vercel 免费托管已实际跑通；但 frugal 路径存在两个已记录风险：push→production 自动部署曾导致 40 次无登记上线（现已靠 `git.deploymentEnabled.main=false` 止血），branch push 仍生成 preview；preview/production 共用 KV；无自动扣费告警/额度闸门；无生产回滚演练。**[文档]**
- HTTP 入口、配置、KV、R2 capture sink、healthz 的实现细节在源码中都能看到；Dockerfile/docker-compose 文件完整，但 **Docker build / npm audit / docker daemon 均 NOT-RUN**（独立审查与 HANDOFF 明确记录），因此“本地容器”载体成熟度只能评 L1（代码就绪、未执行）。**[文档]**
- Cloudflare 内网穿透：仓库内**只有测试用途的 quick tunnel 记录**和**明确标注 not deployable 的 Workers 模板**；没有生产隧道配置。**Cloudflare 隧道载体不存在可复用实现**，状态 L0–L1。**[文档]**
- 其他免费平台：只有调研文档和模板草图，无实装。**[文档]**
- Healthz 明确不连上游、永远 `ok:true`，不反映上游健康；多载体适配（RuntimeAdapter 接口）在架构文档中定义，但**代码里没有对应实现/接口文件**。[代码][文档]
- 成熟度总评：HTTP/配置/State 层 L2–L3（Vercel）；部署策略 L2；Docker L1（NOT-RUN）；Cloudflare Workers/隧道 L0–L1；其他免费平台/服务器 L0。距“同一套核心跑在不同载体、可回滚”的模块目标仍有明显差距。

---

## 1. 用户原话校验（FRAMEWORK.md §0 逐字保存）

> 原话来自 `docs/FRAMEWORK.md` 第 16 行“第五，运行时 部署……”段；下方按其语义逐条核对，不做扩写。

| # | 用户原话要点 | 当前事实 | 状态 |
|---|---|---|---|
| 1 | “运行时/部署”作为第五模块 | `FRAMEWORK.md` §2 模块五列为候选：Vercel / 同类免费平台 / 内网穿透 / 本地容器 / 服务器；`ARCHITECTURE-PROGRESSIVE.md` 定义模块 5 Runtime & Deployment，接口 `RuntimeAdapter` | 文档已定义 |
| 2 | “Vercel 比较方便，这属于免费托管平台” | Vercel 是**唯一实际部署载体**：`api/index.js` → `src/vercel-app.js`；生产域名 `gemini-mcp-gateway.vercel.app`；`/healthz` 实测 production | 已实现且线上运行 |
| 3 | “不知道有没有同类型的，也可以多试几个，注意费用” | Cloudflare Workers 有 `templates/cloudflare/README.md`，但明确写 **not deployable with current code**；其他免费平台只见调研/竞品文档 | 未实现，仅调研 |
| 4 | “保证按照我们方式部署是不能用扣费风险” | `FRAMEWORK.md` §6、§8 写为原则；`vercel.json` 关掉 main 自动部署；但**无扣费闸门、无预算告警、无免费层硬约束**；preview 仍生成；共用 KV 也有成本/隔离风险 | 部分（策略层），**保障缺失** |
| 5 | “内网穿透，利用 cloudflare，还不知道有没有其他好的工具” | HANDOFF §7 记 `work/local-chatgpt-app.mjs`、Cloudflare quick tunnel / ngrok **只用于测试**；`docs/eval/VERCEL-CIMD-*.md` 中隧道域名用于 CIMD 探针并被 AS 拒绝；无生产隧道部署 | 测试使用，**非部署载体** |
| 6 | “本地部署吧？似乎需要容器，不知道会不会过重” | 有完整 `Dockerfile` + `docker-compose.yml` + `docs/OPEN-SOURCE/DOCKER.md`；镜像 `node:20-bookworm-slim`、`npm ci --omit=dev`、非 root、TCP healthcheck | 代码就绪，**build NOT-RUN**；“是否过重”**未实测** |
| 7 | “同时还有服务器” | 无独立服务器部署脚本/模板；Docker 可自托管，但按 HANDOFF 未验证 | 未实现 |
| 8 | “这些既属于运行时也属于开源工程” | `docs/OPEN-SOURCE/DEPLOYMENT-TEMPLATES.md`、templates/ 下有 vercel/docker/cloudflare/local 模板；OSS 尚未公开 | 模板存在，发布未做 |
| 9 | （交叉）“网关和多个客户端怎么做隔离？并发场景，上游也有并发限制” | 运行时层无 per-client 隔离/限流；`store.js` 有 Redis CAS/lease 保护**刷新并发**，但请求级并发/上游配额调度不在运行时模块 | **缺口**，`FRAMEWORK.md` §9 未决问题 3/4 |

**结论**：用户点名的 5 类载体中，Vercel 已落地；本地容器“代码有、未跑”；Cloudflare 隧道仅测试；其他免费平台与服务器仅文档。默认无扣费风险是**设计原则，不是已实现的保障**。

---

## 2. 实现清单（HTTP 入口 / 配置 / KV / 健康 / 部署 / Docker / 隧道）

### 2.1 HTTP 入口

| 项 | 文件/位置 | 事实 |
|---|---|---|
| Vercel serverless 入口 | `api/index.js:1-5` | 5 行：`createAppHandler()` 构造 handler 并 default export；无端口绑定 |
| Vercel 路由/app | `src/vercel-app.js:158-413` | `createAppHandler()` 路由：`GET /healthz`、`/.well-known/*`（oauth-authorization-server、oauth-protected-resource、CIMD `/.well-known/mcp-client.json`）、`/oauth/register|authorize|token|revoke`、`/upstream/oauth/start|callback`、`/mcp` 与（开关打开时）`/mcp/v2`、OPTIONS、404/500 **[代码]** |
| Bearer 校验 | `src/vercel-app.js:272-304` | 只在此处做 `store.getToken()` + 过期检查；`/mcp` 协议交给 `createMcpRequestHandler()`；401 带 `WWW-Authenticate` + `_meta["mcp/www_authenticate"]` 供 ChatGPT **[代码]** |
| MCP 协议处理 | `src/server.js:477-613` | `createMcpRequestHandler()`：Stateless，每次 POST 新建 `McpServer` + `StreamableHTTPServerTransport({sessionIdGenerator: undefined})` 并在响应后关闭；GET→405、DELETE→204；body 上限 1MB **[代码]** |
| 本地/独立 HTTP | `src/server.js:619-632` | `startHttpServer()` 用 `http.createServer`，默认 host `127.0.0.1`、port 3000；`--host/--port/--stdio/--config` CLI 见 `:638-665` **[代码]** |
| rewrites | `vercel.json:11-16` | 所有路径 rewrite 到 `/api/index` |
| 函数时长 | `vercel.json:6-10` | `api/index.js` `maxDuration: 60`（秒）；GET `/mcp` 因 SSE 会挂到超时，故设计上返回 405（`src/server.js:585-592`） |

### 2.2 配置

| 项 | 文件 | 事实 |
|---|---|---|
| 配置加载优先级 | `src/vercel-app.js:118-135` | `options.config` > `options.upstreamsJson`/`UPSTREAMS_JSON` > `GATEWAY_CONFIG`/`config.example.json`；`validateConfig()` 校验 **[代码]** |
| Upstream 可用性 | `src/vercel-app.js:137-143` | `tokenEnv` 未设置的上游被过滤掉，保证 app 可启动（缺失 token 只 warning，不 fail fast） |
| 环境名（只读，取值不读） | 源码引用 | `KV_REST_API_URL`/`UPSTASH_REDIS_REST_URL`、`KV_REST_API_TOKEN`/`UPSTASH_REDIS_REST_TOKEN`、`UPSTREAMS_JSON`、`GATEWAY_CONFIG`、`GATEWAY_MAX_RESULT_CHARS`、`CAPTURE_*`（mode/sink/fileDir/httpUrl/httpToken/maxBytes/asyncQueue/queue*）、`R2_ACCOUNT_ID`/`R2_BUCKET`/`R2_AUTH_EMAIL`/`R2_AUTH_KEY`/`R2_API_TOKEN`/`R2_PREFIX`、`CAPTURE_FALLBACK_HTTP_URL`/`CAPTURE_FALLBACK_HTTP_TOKEN`、`PUBLIC_BASE_URL`、`VERCEL_URL`、`VERCEL_ENV`、`VERCEL_GIT_COMMIT_SHA`、`VERCEL_DEPLOYMENT_ID`、`ALLOWED_CLIENT_ID`/`ALLOWED_CLIENT_SECRET`、`ALLOW_DCR_FOR_CHATGPT`/`ALLOW_DCR_FOR_CLAUDE`、`UPSTREAM_OAUTH_ADMIN_KEY`、`ENABLE_MCP_V2` **[代码]** |
| 环境名（Vercel 项目侧） | `HANDOFF-NEXT-WINDOW.md:336-351`、`INDEPENDENT-REVIEW-2026-11-24.md:98` | 记录 41 个 env；`NOTION_REFRESH_TOKEN`/`LINEAR_REFRESH_TOKEN`/`FIGMA_REFRESH_TOKEN` 存在，但**无** `grantOwner`/`grantSource`/`LINEAR_PAT_STATIC`；KV env target = production+preview；`PUBLIC_BASE_URL` 三环境共用 **[文档]** |
| 配置校验时机 | `src/vercel-app.js:169-193` | upstreamManager 懒初始化：第一次带认证的 `/mcp` 才 `connect()`，冷启动 healthz 不触发上游网络调用 |

### 2.3 KV / R2 / 状态

| 项 | 文件 | 事实 |
|---|---|---|
| TokenStore | `src/store.js:38-359` | Upstash Redis REST，纯 `fetch`，无额外依赖；key 前缀 `gmcgw:v1`，secret 只存 sha256；`TTL.client=0/code=600/token=3600/refresh=0` **[代码]** |
| 并发原语 | `src/store.js:100-162` | `compareAndSet`、`releaseLease`、`renewLease`、`casToken` 用 Lua EVAL，防并发 refresh 重复消费 rotating grant；`takeCode`/`takeOAuthState` 用 GETDEL 保证一次性 **[代码]** |
| 环境隔离 | `src/store.js:287-293` | `_oauthStateKey()` 用 `environment:grantOwner:hash(state)` 命名；但生产 env 中 KV 实例本身 production+preview 共用（见 2.2），**实例级隔离缺失** **[代码][文档]** |
| Capture sink | `src/capture.js:304-340,373-455` | sink 可选 `file`/`http`/`console`/`r2`；R2 走 Cloudflare API PUT，gzip 后按 `capture/<day>/<requestId>.json.gz` 写；fallback HTTP 在 sink 失败时 best-effort；`CAPTURE_ASYNC_QUEUE=1` 启用 `CaptureQueue`（默认 OFF） **[代码]** |
| waitUntil | `src/capture.js:27,811-827,923-941` | `import { waitUntil } from '@vercel/functions'` 在 res.end 同步调用，防 Vercel 冻结函数导致 capture 丢失；本地无 waitUntil 时 best-effort **[代码]** |
| Capture 完整性 | `src/capture.js:656-981` | 每请求 `capture_ack`/`capture_done`/`capture_skipped`/`capture_dropped` 结构化日志；full-fidelity raw 保留（AGENTS §6） **[代码]** |

### 2.4 健康

| 项 | 文件 | 事实 |
|---|---|---|
| `/healthz` 实现 | `src/vercel-app.js:217-254` | 返回 `ok:true` 恒真、`commit`（`VERCEL_GIT_COMMIT_SHA` 或 BUILD.commit）、`buildHash`、`builtAt`、`env`、`deploymentId`、`uptimeMs`、`startedAt`、`configLoaded`/`configError`/`mode`/`servers`；**刻意不连 token store、不连上游** **[代码]** |
| 构建身份生成 | `scripts/write-build-info.mjs:24-98` | `buildHash` 覆盖 `api/index.js` + `src/*.js`（排除生成文件）+ `config.example.json` + `package.json`，CRLF→LF 归一化；vercel.json 不纳入 hash（Vercel 会 minify）；失败时写 `unknown` 但退出 0 **[代码]** |
| 本地校验命令 | `scripts/write-build-info.mjs:15-16` | `node scripts/write-build-info.mjs --print` 可本地算 hash 与 `/healthz.buildHash` 对照；独立审查已做过一次（HEAD 758a232 时一致） **[文档]** |
| Docker healthcheck | `Dockerfile:26-30` | **不是 /healthz**：只做 TCP 3000 端口探测；文档明确 CLI 路径没有 `/healthz`（`docs/OPEN-SOURCE/DOCKER.md:75-81`）；HANDOFF 把 “`/healthz` 与 Docker healthcheck 一致性”列为 P1 待查 **[代码][文档]** |
| 生产实测 | `GET /healthz`（只读） | `ok:true`、`commit=d1f36ba…`、`buildHash=a1002d86…`、`builtAt=2026-11-23T18:57:04.672Z`、`env=production`、`deploymentId=dpl_7qGruKcZ8ffE7rri6erS6ZaiqiNS`、`configLoaded:true`、`mode=codemode`、`servers=[github,notion,linear,vercel,figma]` **[线上]** |

> 注意：`uptimeMs=744`、`startedAt=2026-11-23T21:07:27.763Z` 与 `builtAt` 相差约 2h10m，说明探测命中了一个刚因空闲冷启动的新实例；不影响 commit/hash 判定。

### 2.5 部署策略与状态

| 项 | 文件/事实 |
|---|---|
| 部署策略 | `docs/DEPLOY-POLICY.md`：不设固定次数；docs/tests-only 不部署；部署前过 6 项检查；部署后核 healthz + 记录；**当前状态段仍写生产 `87d91af`（验收门 A PASS），已过时** **[文档]** |
| 部署日志 | `docs/DEPLOYMENTS.md`：生产 `d1f36ba` 于 2026-11-24 02:57 CLI 手动部署，deploymentId 已登记；05f607c 起 main 自动 production 关闭；branch push 仍生成 preview（02:26/02:32 两次）；40 次历史自动部署未登记 **[文档]** |
| 自动部署开关 | `vercel.json:17-21` `git.deploymentEnabled.main=false`；若要连 preview 也停，需改 `{"*": false}` 并手动部署一次（DEPLOYMENTS.md:38） **[代码][文档]** |
| 回滚 | `docs/ledger/batch-11-reconnect.md:49-60,142-169` 记录 `vercel promote`/`vercel rollback` 是域名级原子重指向；建议 staged promote→验证→低峰 promote→异常 rollback 的 runbook；但 `RESIDUAL-RISK-AUDIT.md:272` 与 `AUTH-READY.md:115-121` 明确**回滚未演练** **[文档]** |
| 独立审查修正 | `INDEPENDENT-REVIEW-2026-11-24.md` §1/§4：A 门 PARTIAL（40 条部署只登记 1 条、自动部署导致验收 commit 失效）；F 门 PARTIAL（npm audit 404、Docker 未运行） **[文档]** |

### 2.6 Docker

| 项 | 文件 | 事实 |
|---|---|---|
| 镜像 | `Dockerfile:1-33`：基础 `node:20-bookworm-slim`；`npm ci --omit=dev`；只 COPY `src/`、`api/`；非 root `node` 用户；`EXPOSE 3000`；CMD 用 `--host 0.0.0.0 --port 3000` **[代码]** |
| 编排 | `docker-compose.yml:5-23`：单服务；端口 `127.0.0.1:3000:3000`；`env_file: .env`；config 只读挂载；capture 目录 bind mount；`restart: unless-stopped` **[代码]** |
| 文档 | `docs/OPEN-SOURCE/DOCKER.md`：明确“**不是 Vercel entry**：OAuth routes、/healthz、KV-backed token store 不在这个容器”；无 Cloudflare 产品参与；容器对外暴露需 authenticating reverse proxy（CLI 无 bearer 校验）；token 轮换是进程内，无持久存储 **[文档]** |
| 状态 | **NOT-RUN**：`docker version` → daemon 未运行（独立审查实跑清单 `:102`）；Docker build 未验证（HANDOFF `:89`、`:225`、`:382`） **[文档]** |

### 2.7 隧道 / Cloudflare / 其他免费平台

| 项 | 事实 | 状态 |
|---|---|---|
| Cloudflare quick tunnel / ngrok | `HANDOFF-NEXT-WINDOW.md:355-357` 标注“只用于测试，不是生产”；`work/local-chatgpt-app.mjs` 可能引用旧 tunnel URL | 测试工具，非部署 |
| Cloudflare Workers | `templates/cloudflare/README.md:1-7` 明言 **not deployable with current code**；列出 Node API、stdio、HTTP server、QuickJS worker thread、`@vercel/functions` waitUntil、Upstash Lua CAS 等阻塞；`worker.example.js` 是 501 sketch | L0–L1（评估/草图） |
| Cloudflare R2 | 只是 capture sink（`src/capture.js:418-444`），不是部署载体 | 已实现（代码层） |
| 其他免费平台 / 服务器 | 仅 `FRAMEWORK.md` §6、`ARCHITECTURE.md` L5、`DEPLOYMENT-TEMPLATES.md` 的调研与模板草图 | L0 |

---

## 3. 成熟度评估（L0–L3）

> 口径：L0=只有文档/未落地；L1=代码/模板存在但未运行验证；L2=单一载体可跑且有运维骨架；L3=多载体可切换、可回滚、可验证、成本可控。

| 子能力 | 等级 | 依据 |
|---|---|---|
| Vercel HTTP 入口 + 路由 | **L3** | `api/index.js` + `src/vercel-app.js` 完整；生产 `/healthz` 实测 production，功能路径（OAuth/MCP/CIMD/health）齐备 |
| 配置 + 校验 | **L2** | 多源加载 + `validateConfig`；但缺失 token 只 warning 不 fail fast（`vercel-app.js:137-143`），与 Progressive 文档“配置错误 fail fast”原则有偏差 |
| KV 状态 + 并发原语 | **L2** | `store.js` CAS/lease/GETDEL 完整；但实例共享、v1 key 前缀、无 v2 环境隔离实例 |
| Capture sink（R2/file/http） | **L2** | 代码完整、waitUntil 修正、fallback/DLQ；但真实 R2 写入未在本审计范围验证（capture 质量属模块 4） |
| Health / BuildHash | **L2** | 身份可追溯且冷启动即时；**不反映上游健康**（设计如此）；Docker 无 parity |
| Vercel 部署/自动部署 | **L2** | 手动 promote 策略 + 日志 + 自动部署止血；但 preview 仍自动生成、无回滚演练、历史记录不全 |
| 本地容器（Docker） | **L1 — NOT-RUN** | 文件完整；docker build / daemon 未运行；容器无 OAuth/healthz/KV，与 Vercel 不等价 |
| Cloudflare 隧道 | **L1** | 仅测试用途 quick tunnel，无生产配置 |
| Cloudflare Workers / 其他免费平台 / 服务器 | **L0–L1** | 模板明确 not deployable；无实现 |
| 多载体适配（RuntimeAdapter） | **L0** | 架构文档定义接口（`ARCHITECTURE-PROGRESSIVE.md:304-313`、`ARCHITECTURE.md:215-224`），但代码里无 `RuntimeAdapter` 文件/导出；`@vercel/functions` 直接 import 是硬耦合 |

**模块 5 总评：L2（Vercel 单载体可用），未达 L3。**

---

## 4. 缺口清单（按用户关注点对齐）

| # | 缺口 | 证据 | 影响 |
|---|---|---|---|
| G1 | **多载体适配缺失**：Vercel handler 与 Node http 入口是两套代码路径，无统一 `RuntimeAdapter`（serve/store/captureSink/health/deploy）；`waitUntil` 直接从 `@vercel/functions` import | `src/vercel-app.js`、`src/server.js:619-632`、`src/capture.js:27`；`ARCHITECTURE-PROGRESSIVE.md:304-313`；grep 无 RuntimeAdapter | 换载体要改核心代码，违背“同一套核心跑在不同载体” |
| G2 | **容器路径不完整/未验证**：Docker 无 `/healthz`、无 OAuth 路由、无 KV token store、token 轮换仅进程内；build/daemon NOT-RUN | `Dockerfile:26-30`、`docs/OPEN-SOURCE/DOCKER.md:7-10,55-64,75-81`、`INDEPENDENT-REVIEW:102` | 本地容器不是 Vercel 的等价替代；“是否过重”无实测 |
| G3 | **默认无扣费风险没有硬保障**：只有策略文档，无额度闸门/预算告警/免费层约束；branch push 仍生成 preview；Vercel 100/day 上限只是平台限制 | `FRAMEWORK.md:249-256`、`DEPLOYMENTS.md:28-38`、`HANDOFF:370` | 与用户体验原则冲突；未来误操作仍可能产生费用或资源消耗 |
| G4 | **并发 / 隔离缺失**：运行时层无 per-client/session 隔离、无请求级限流、无上游并发调度；store 的 CAS/lease 仅保护 refresh；单 owner 不等于单客户端 | `FRAMEWORK.md:151-155,289-290,418-424`；`src/store.js:100-162`；G1 无适配器 | 多客户端并发、上游配额问题未解；承接模块 1/3 的交叉需求 |
| G5 | **无回滚演练 / 发布工程**：`vercel promote/rollback` 只在台账里作为建议；AUTH-READY 1.8 回滚四项、AUTH 回滚底线都未演练 | `batch-11-reconnect.md:142-169`、`RESIDUAL-RISK-AUDIT.md:272`、`AUTH-READY.md:115-121` | 线上事故无已验证止血路径 |
| G6 | **healthz 不反映上游健康**：实现刻意只报进程/配置身份，`ok:true` 恒真；上游 token 过期会静默降级 | `src/vercel-app.js:217-226`、`INDEPENDENT-REVIEW R2` | 监控无法发现“网关活着但上游全断”；需在评测/运维层补独立探针，且不能把 healthz 改成上游探针（会破坏冷启动即时性） |
| G7 | **preview/production KV 共用**：`UPSTASH_REDIS_REST_*` target=production+preview，`PUBLIC_BASE_URL` 三环境共用；代码层 `_oauthStateKey` 有 env 前缀，但实例共享 | `INDEPENDENT-REVIEW R4`、`HANDOFF:78`；`src/store.js:287-293` | 验收门 D（授权生命周期）不成立；AUTH-READY 1.4-2 不成立 |
| G8 | **配置错误不 fail fast**：缺失 tokenEnv 的上游被静默跳过，app 仍启动 | `src/vercel-app.js:137-143` | 用户可能以为上游可用但实际被过滤，与 Progressive “配置错误 fail fast”原则冲突 |
| G9 | **部署文档过时/记录不全**：`DEPLOY-POLICY.md` §5 仍写 `87d91af`；40 次自动部署历史未登记；HANDOFF 的 healthz 段仍写 `9ab0e57` | `DEPLOY-POLICY.md:45-48`、`DEPLOYMENTS.md:40-44`、`HANDOFF:63-66` | 审计链断裂；不要把文档里的生产 commit 当真值 |
| G10 | **其他免费平台/服务器/隧道无实装**：Cloudflare Workers 模板自述 not deployable；quick tunnel 仅测试 | `templates/cloudflare/README.md:1-21`、`HANDOFF:355-357` | 用户“多试几个”的诉求未满足 |

---

## 5. 渐进式延伸：RuntimeAdapter 接口 / 能力 / 测试

> 架构文档已给出接口草案（`ARCHITECTURE-PROGRESSIVE.md:304-313`、`ARCHITECTURE.md:215-224`），但实现缺位。以下是**建议的渐进路径**，不是已完成事实。

### 5.1 建议接口（与架构文档对齐）

```text
RuntimeAdapter
  serve(handler)        // Vercel handler / node:http / Worker fetch(Request)->Response
  store()               // TokenStore 或等价 KV 实现（含 CAS/GETDEL 语义）
  captureSink()         // file / http / r2 / console + waitUntil 抽象
  health()              // 进程/配置身份，不连上游
  deploy()              // promote / rollback / 策略门禁（贡献点，非运行时强依赖）
```

### 5.2 分层落地顺序（每步可独立验收）

| 阶段 | 能力 | 最小交付 | 验收 |
|---|---|---|---|
| A. 抽象 waitUntil 与 captureSink | `waitUntil` 不再是 Vercel 硬 import；本地/worker 用 no-op 或 ctx 版本 | 新增 `src/runtime/*` 适配层，capture.js 改为注入 | 现有 capture 测试全绿；本地不再因无 `@vercel/functions` 报错 |
| B. 抽象 health | 统一 `health()` 输出；Docker/CLI 路径暴露等价 `/healthz`（或明确记为 parity 缺口） | Node http 入口加 `/healthz`，字段与 Vercel 一致 | HANDOFF P1“healthz 与 Docker healthcheck 一致性”关闭 |
| C. 统一 HTTP 入口 | `serve(handler)` 分别实现 Vercel/Node；避免两套路由分叉 | `api/index.js` 与 `src/server.js` 共用路由表 | 同一组路由测试在两种入口跑通 |
| D. 存储适配 | `store()` 支持 Upstash（现有）/D1（Workers）等；CAS/GETDEL 语义必须有等价实现 | 至少一份接口契约测试 | `templates/cloudflare/README.md` 的阻塞项逐条销账 |
| E. 部署/回滚 runbook | `deploy()` 贡献 manifest + 人工 gate；staged promote → healthz 核验 → rollback 演练 | `docs/WORKFLOW.md:366-368` 已有回滚段，补真实演练记录 | `AUTH-READY.md` 1.8 四项有证据 |

### 5.3 必须新增的测试（防止“文档写了=实现了”）

1. `RuntimeAdapter` 契约测试：至少两种适配实现跑同一组 `serve/store/captureSink/health` 断言。
2. 配置 fail-fast 测试：缺失必需 env/config 时启动失败，不再静默跳过上游（`vercel-app.js:137-143` 行为变更需先写测试）。
3. healthz 反敲测试：断言 healthz **不触发** token store / 上游网络调用（保持冷启动即时与“不伪装上游健康”）。
4. 环境隔离测试：preview 与 production 的 token/state key 不串；KV 实例共享时靠 key 前缀仍隔离，或显式禁止共用实例。
5. 回滚演练脚本：记录 promote/rollback 前后 `/healthz` 的 commit/buildHash/deploymentId 与 tools/list 工具名，作为验收证据。
6. 成本闸门测试：CI 检查 `vercel.json` 的 `git.deploymentEnabled`，防止误开自动 production 部署。

---

## 6. 可复用方法 / SOP

### 6.1 载体接入 SOP（建议，供未来每个平台复用）

1. **能力映射**：逐项列出 Node API / HTTP 模型 / 沙箱 / waitUntil / token store 的替代方案（可复用 `templates/cloudflare/README.md` 的阻塞表格式）。
2. **接口实现**：按 §5.1 五个方法实现适配器；不允许把平台 SDK 直接散落到业务代码。
3. **契约测试**：同一组测试跑通至少两种载体；fake/replay 不算 pass。
4. **健康与身份**：`health()` 必须返回 commit/buildHash/builtAt/env/deploymentId；不连上游。
5. **成本审查**：确认免费层上限、是否有按量计费触发路径、是否生成 preview；写进部署文档。
6. **部署纪律**：过 `DEPLOY-POLICY.md` 六项检查 → 手动部署 → `/healthz` 核身份 → 记 `DEPLOYMENTS.md` → 真实检查 → 保留回滚路径。
7. **证据留痕**：每次部署记录 commit、deploymentId、healthz 输出、验证命令；不补造历史。

### 6.2 只读审计 SOP（本次方法，供其他模块复用）

1. 先读 `FRAMEWORK.md` 用户原文，逐条校验，不扩写意图。
2. 读架构分层（L0–L3）与模块接口定义，记录“接口定义存在吗、实现存在吗”。
3. 读源码，按“入口 / 配置 / 状态 / 健康 / 部署 / 载体特定文件”分组，标 `[代码]`。
4. 线上只读探测（healthz / 401 metadata / CIMD），**不读 token 值**，标 `[线上]`。
5. 与 HANDOFF / 独立审查 / DEPLOYMENTS 交叉核对，区分“文档自述”“代码候选”“线上事实”“未验证”。
6. 缺口按用户原话顺序编号；成熟度只给有证据的等级；NOT-RUN 明确写 NOT-RUN。
7. 只写指定报告文件，不改代码、不 commit、不部署。

---

## 7. 优先级 / 依赖 / Unknown

### 7.1 优先级（建议，按阻塞关系排序）

| 优先级 | 事项 | 理由 |
|---|---|---|
| P0 | 低成本止血：校正部署文档过时值；补登历史部署或明确不可追溯；加 CI 检查自动部署开关 | 审计链断裂，A 门 PARTIAL 的直接原因 |
| P0 | preview/production KV 隔离（`INDEPENDENT-REVIEW R4`） | 阻塞 AUTH-READY 与验收 D |
| P0 | 回滚演练 + staged promote runbook（`AUTH-READY 1.8`） | 线上无已验证止血路径 |
| P1 | 抽象 waitUntil / captureSink / health，补 Node `/healthz` parity | 多载体前置，低风险 |
| P1 | Docker build + npm audit 实跑；明确“容器是否过重” | 把 L1 升到 L2；关闭 HANDOFF P1 项 |
| P1 | 配置 fail-fast + 请求级并发/隔离设计（承接模块 1×5、3×5） | 用户明确关注的交叉场景 |
| P2 | Cloudflare Workers / 其他免费平台 / 服务器适配器 | 用户“多试几个”诉求，依赖 P1 抽象完成 |
| P2 | 成本闸门（预算告警 / preview 策略 / 免费层约束固化） | 保障“无扣费风险”从原则变机制 |

### 7.2 依赖

- P0 的隔离/回滚属**运维 + 授权**交叉，需 lead 与授权模块协同；本审计不改代码。
- P1 抽象层是 P2 所有新载体的前置；没有它，Cloudflare Workers 的阻塞项（`templates/cloudflare/README.md`）无法逐条销账。
- 所有部署相关动作受 `DEPLOY-POLICY.md` 约束：docs/tests-only 不部署；本审计为 docs-only，**不构成部署理由**。

### 7.3 Unknown / NOT-RUN（明确标记，不写成 PASS）

| 项 | 状态 | 说明 |
|---|---|---|
| Docker build / docker daemon | **NOT-RUN** | `docker version` → daemon 未运行（独立审查 `:102`） |
| npm audit | **NOT-RUN / 404** | `npm audit --omit=dev` → 404 NOT_IMPLEMENTED（独立审查 `:101`） |
| 本地容器“是否过重” | **unknown** | 无镜像大小/启动耗时实测 |
| 真实 R2 写入 / capture 落盘 | **unknown（本审计范围外）** | 代码就绪；capture 质量属模块 4 |
| 生产回滚演练 | **未做** | `RESIDUAL-RISK-AUDIT.md:272`、`AUTH-READY.md:115-121` |
| 其他免费平台可用性 / 成本 | **unknown** | 仅调研，无实测 |
| 服务器部署形态 | **unknown** | 无独立脚本/模板 |
| healthz 是否曾因上游过期而“假绿” | **unknown** | 设计为恒 `ok:true`，需独立上游探针才能证明 |
| 预览域名 KV 共用是否已造成真实串数据 | **unknown** | 配置层已确认共用；无事故证据 |

---

## 8. 证据索引（本次实际读取）

- `docs/FRAMEWORK.md`（§0 用户原文、§2 模块五、§6 部署与成本、§8/§9）
- `docs/ARCHITECTURE-PROGRESSIVE.md`（L1 模块卡、L2 模块 5、L3 扩展点、当前成熟度）
- `docs/ARCHITECTURE.md`（L5 Runtime & Deployment，行 206–233）
- `docs/DEPLOY-POLICY.md`、`docs/DEPLOYMENTS.md`
- `docs/HANDOFF-NEXT-WINDOW.md`、`docs/OPEN-SOURCE/INDEPENDENT-REVIEW-2026-11-24.md`
- `docs/OPEN-SOURCE/DOCKER.md`、`docs/OPEN-SOURCE/RESIDUAL-RISK-AUDIT.md`（回滚）
- `docs/ledger/batch-11-reconnect.md`（promote/rollback）、`docs/AUTH-READY.md`（回滚门禁）
- `api/index.js`、`src/vercel-app.js`、`src/server.js`、`src/store.js`、`src/capture.js`、`src/build-info.js`、`scripts/write-build-info.mjs`
- `Dockerfile`、`docker-compose.yml`、`vercel.json`、`templates/vercel/.env.example`、`templates/cloudflare/README.md`
- 线上只读：`GET https://gemini-mcp-gateway.vercel.app/healthz`（HTTP 200，字段见 §2.4）
- `package.json` engines.node = `>=20.19.0`（与 Dockerfile 注释一致）

> 本文件为新增文件；未修改任何既有文件，未提交任何更改。
