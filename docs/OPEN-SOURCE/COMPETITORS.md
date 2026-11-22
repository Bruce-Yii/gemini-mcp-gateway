# 开源前竞品调研：Code Mode MCP 网关 / Web Client MCP 网关

> 调研日期：**2026-11-23**（抓取时间 2026-11-22 ~ 2026-11-23 UTC；stars/活跃度均为该窗口快照）。
> 方法：`web_search` / `web_fetch` 抓取一手 README、官方文档与 GitHub API；外部内容按**不可信数据**处理，
> 下文数字凡来自项目自述均标注「自述」，未在本文独立复现。星标/推送时间来自 GitHub REST API（抓取日快照）。
> 范围：2026 年 11 月仍活跃或近期仍有明确产出的项目；已停更/归档的项目也保留，标注状态。
> 项目内部事实依据：`README.md`、`package.json`、`docs/WHY.md`、`docs/CODEMODE-SURVEY.md`、
> `docs/OBSERVABILITY-AND-EVAL.md`、`docs/UPSTREAMS.md`、`src/`。

---

## 0. 读前修正：竞品要看“优化轴”，不是“功能清单”\n\n> 本项目不是“又一个 MCP 聚合网关”。聚合是副产物；核心是**持续优化上下文与工具调用**。\n> 因此主竞品只有四类：Cloudflare Code Mode/Portals、Limen、corrreia/dev-mcp、gemini-bastion-mcp。\n> MCPHub/MetaMCP/Unla/agentgateway 是相邻基础设施，不是同一优化轴上的竞品。详见 [DIFFERENTIATION.md](DIFFERENTIATION.md)。\n\n## 0. 结论先行（给 lead 的 TL;DR）

1. **「MCP 聚合网关」已是红海**：MetaMCP（2,762★，但已 archived）、MCPHub（2,748★）、Unla（2,262★）、Docker MCP Gateway（1,643★）、agentgateway（6,358★）都在做「多上游 → 单端点」。单纯聚合、OpenAPI 转换、多租户已不是差异化。
2. **「网关 + Code Mode」也不再独有**：Cloudflare MCP Portals 自 2026-03-26 起**默认开启 Code Mode**（`?codemode=search_and_execute` 暴露单个 `code` 工具）；Limen、corrreia/dev-mcp、Forgemax 都是 2 工具 Code Mode 网关。我们与它们的关键差别在**3 工具的读写分层（execute_read / execute）**、**QuickJS 真隔离**、**全量 capture + L1/G6 eval**、**真实写路径验证**与**Gemini 网页版实测**。
3. **「面向 Web AI 客户端（Gemini/Claude/ChatGPT）+ OAuth 2.1 DCR」仍是稀疏赛道**：直接对标只有 Kaiserunix/gemini-bastion-mcp（2026-11-20 新建、1★、MIT、10 工具 1 审批门、bwrap 沙箱）。它是**垂直应用网关**（coding/DevOps 工具集），我们是**通用上游聚合网关**——定位不同，正面竞争弱。
4. **缺的 table stakes**：Docker 部署、Cloudflare Workers 一键部署、ChatGPT/Claude 连接器适配验证、配置模板/管理 UI。多用户/租户：与我们当前「single-user / self-hosted」定位一致，**不建议现在做**。
5. **一句话定位建议**：*The Code Mode MCP gateway for web AI clients — three stable tools, a real QuickJS sandbox, and full-fidelity captures for evaluation.*

---

## 0.2 第二轮：按“问题空间”重搜（第一次方法有缺陷）

第一次搜索按品类词 `MCP gateway` + star 排序，漏掉了真正同轴的竞品。第二次改为按问题搜索：
`tool retrieval`、`tool search`、`progressive disclosure`、`context reduction`、`tool definition tokens`、
`TOON compression`、`MCP Groups`。结果如下（这些才是实质竞品）：

| 项目 | 证据 | 为什么同轴 |
|---|---|---|
| **IBM/mcp-context-forge** | 4,875★，2026-11-21 仍活跃；MCP/A2A/REST 网关，企业控制面；**TOON 插件压工具结果（`tool_post_invoke`），默认 `mode:disabled`、`PLUGINS_ENABLED=false`；不压工具定义，无 tool search/progressive disclosure、无 Code Mode/guest 沙箱** | 大厂开源网关，直接做工具聚合 + 观测；但和我们不是同一压缩轴：它压结果，我们压定义；它面向企业多租户，我们面向单用户 Web 客户端。详见 [IBM-CONTEXTFORGE-VS-US.md](IBM-CONTEXTFORGE-VS-US.md) |
| **RajeshwariVelmurugan/MCP-Tool-Retrieval-Gateway (toolgate)** | 2 tools `search_tools` / `call_tool`；BM25 / embeddings / hybrid RRF / reranker；自带 Recall@k/MRR/nDCG/token/latency 评测；对比 Anthropic native tool search | 和我们的 `search` + 工具调用最接近的“检索型网关”；虽然 0★，但概念完全同轴 |
| **vrraj/axiolex** | intent-ranked Top-K retrieval；MCP/A2A/internal tools；BM25S + ColBERT；namespace/catalog | 工具发现/检索层竞品 |
| **dehydrator** | client-side BM25 tool search；把完整 tool list 换成一个 `tool_search` | 说明“工具检索”正在变成通用能力，不一定需要网关 |
| **modus-data/mcp_codemode** | 6-step Code Mode pipeline；工具过滤 + TS API + 沙箱 | Code Mode 库级竞品，不是网关但可被集成 |
| **MCP Groups / Progressive Disclosure WG** | SEP-2084 / PR #2110；Groups 原语；官方 WG 2026-11 仍在推进 | **协议原生**的分组/延迟发现；如果客户端采用，我们的 `search` 价值会被部分吸收 |
| **Anthropic MCP Tool Search / Programmatic Tool Calling** | Claude Code 的 MCP 工具搜索 + 代码调用 | 宿主原生能力，直接替代“网关帮我省 schema”的一部分 |
| **OpenAI `tool_search`** | gpt-5.4+ Responses API，`defer_loading` + MCP server/namespace 搜索 | 同上，宿主原生延迟加载 |

### 这改变了威胁模型

| 威胁 | 影响 | 我们的应对 |
|---|---|---|
| 宿主原生 tool search / MCP Groups 普及 | 客户端自己就能延迟加载工具，`search` 不再是独有卖点 | 聚焦**没有原生 tool search 的网页客户端**（Gemini web 当前没有）；强化 Code Mode 编排、读写分层、结果投影。**用户实测 Gemini/GPT web 的原生工具发现/加载目前效果不好，所以这是长期 watch item，不是当前替代品。** |
| 检索型网关（toolgate/axiolex/dehydrator） | 直接竞争“工具发现 + 少 schema” | 我们的差异不是检索本身，而是**检索后能写代码编排 + 读写隔离 + 全量 capture/eval + 真实写路径** |
| IBM ContextForge 这类大厂网关 | 功能面/生态/部署更强 | 不做企业控制面；做单用户、Web 客户端、Code Mode、可评测的轻量层 |
| Cloudflare Code Mode / Portals | 平台级 Code Mode 免费/默认 | 提供可移植、可自托管、面向 web 客户端、带 eval 的版本 |

**结论：实质竞品是存在的，而且比第一次列的多。** 我们不是“没有竞品”，而是“竞品分布在不同层”：
宿主原生能力、检索网关、Code Mode 平台、企业网关、Web 垂直网关。我们的位置是
**“Web 客户端可用的 Code Mode + 读写隔离 + 全量评测”**，不是“唯一会省 context 的网关”。

## 0.3 Firecrawl 问题空间搜索（2026-11-23 第三轮）

用 `firecrawl_search` 按“上下文优化 / progressive disclosure / tool retrieval / Code Mode / web client limits”搜到的
新增实质竞品与事实（比前两轮完整）：

| 项目/能力 | 证据 | 对我们的意义 |
|---|---|---|
| **Cloudflare MCP Portals: Context optimization** | 官方 changelog：`minimize_tools` 只保留工具名，最多省 5x token；`search_and_execute` 只暴露 `query` + `execute`，在 Dynamic Worker 里执行 | 大厂把“工具定义压缩 + Code Mode”做成门户默认能力；我们不能再把 Code Mode 当独有；差异在自托管、Web 客户端、读写分层、eval |
| **agentgateway Progressive Disclosure** | Solo.io 文章：`toolMode: Search`，自称省 91% token；OpenAPI→MCP + `run_code` | 企业网关直接竞品；它强在 K8s/策略，我们强在 Web 客户端/单用户/评测 |
| **Bifrost** | 开源 gateway，Code Mode 四个 meta-tools，宣称工具定义 token 降 92.8% | 又一个 Code Mode 网关；需要看它是否做 Web 客户端/session/capture |
| **Speakeasy MCP Gateway Code Mode** | 文章明确“Code Mode 属于 gateway 而不是单个 MCP server”；一个 `execute` 工具 + live tool search | 方向和我们一致，说明“网关层 Code Mode”是品类；差异仍是 Web/read-write/eval |
| **Stacklok MCP Optimizer** | 与 Anthropic Tool Search 做 head-to-head 检索准确率对比 | “工具优化器”独立品类；我们应把 eval 做成可比指标 |
| **Consiliency/pmcp (Progressive MCP)** | 开源 gateway，`catalog_search` + lazy servers + progressive disclosure | 直接竞品；需要逐项比较 |
| **toolgate** | 2 tools `search_tools`/`call_tool`，BM25/embedding/rerank + Recall@k/MRR/token eval | 检索型网关直接竞品；它没有 Code Mode/读写分层/Web 实测 |
| **IBM ContextForge** | 企业控制面；TOON 只压 tool result，默认 disabled；无 tool search/Code Mode | 不同轴；叙事竞品 |
| **MCP Groups / Anthropic Tool Search / OpenAI tool_search** | 协议/宿主原生 progressive disclosure | 长期 watch；按用户实测，当前 Web 客户端效果不好 |

### 最关键的新证据：检索提升 ≠ 任务成功

OpenAI 社区 2026-11 的实验：MCP 工具检索 top-1 从 50.3% 提到 93.3%，但 25 个 agent 工具使用任务从 16/25 降到 14/25；
模型经常**根本不咨询 discovery gateway**。另一篇 2026-11 arXiv 预注册研究直接比较 Code Mode / decision layer 的成本与正确率。

对我们的含义：

1. **只卖“search/检索”不够**，检索准确率不等于任务成功率；
2. 我们的 **L1/G6 + capture/eval** 不是附属品，而是证明“优化真的有用”的核心；
3. 读写分层、写语义、真实 replay 这些“执行侧”能力，比再做一个 retrieval 网关更难被复制；
4. README 不该用“token 降 99%”当唯一卖点，必须跟“任务成功率/工具命中/写回放”一起讲。

### 平台限制（决定 Web 客户端适配）

- ChatGPT MCP connector：社区报告单工具描述/结果有 **5,000 token 限制**，超限要拆成单独 schema 工具；这解释了为什么我们的 3 工具面是优势。
- Gemini Enterprise custom MCP：官方建议 **同时启用的 actions 限制在 100**；Web Gemini custom apps 有地区/账号限制。
- 结论：Web 客户端不是“通用的”，必须按客户端做 schema/结果/annotation 适配；这正是我们的工程差异。

## 1. 竞品矩阵

### 1.1 主表（按相关度分组）

> 「Web client」列指 **ChatGPT / Gemini / Claude 网页版连接器**是否有一手文档或 README 明确支持；
> `未验证` = 没有找到一手证据，不等于不支持。「上下文压缩」泛指工具定义裁剪 / 结果过滤 / 大输出处理。

| 项目 | 定位 | 协议/传输 | Code Mode? | Web client 支持 | 部署形态 | 认证 | 上下文压缩 | 沙箱 | 可观测/eval | License | Stars / 活跃度（2026-11-23） |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **我们：Bruce-Yii/gemini-mcp-gateway** | 面向网页版 AI 的通用 Code Mode 网关；3 工具 + 多上游聚合 | MCP Streamable HTTP；上游 HTTP/stdio | ✅ `search` / `execute_read` / `execute` | ✅ Gemini 网页版 custom app 实测；Claude/ChatGPT 未验证 | Node ≥20.19；Vercel serverless 已上线；本地 `npm start` | OAuth 2.1 DCR + PKCE + 刷新令牌；上游 bearer/OAuth refresh | 工具定义 506→3（-99.4% 自测）；BM25 search + 结果投影/截断 | ✅ QuickJS in worker thread（`run` SDK）；guest 无 process/require/fetch；逃逸回归测试 | ✅ 全量 capture（HTTP/MCP/上游帧/sandbox）→ R2；L0 364 tests + L1 smoke + G6 scorecard | MIT（package.json） | 未公开（新建仓库，无抓取数据） |
| **Belphemur/limen** | Go 单二进制 MCP 网关，聚合上游 + Code Mode 2 元工具 | MCP Streamable HTTP（仅远程上游） | ✅ `codemode_search` / `codemode_execute`，Goja JS 沙箱，`codemode.tools()/call()` | 未验证（README 举例 Claude/Cursor） | 单二进制 / 拆分为 gateway+portal+staff；YAML 配置 | JWT/JWKS 网关注入；每租户 header 注入 | ✅ 2 工具约 600 tokens vs 52 工具约 9,400（自述 94–99%） | ✅ Goja（纯 Go，无 CGO）；无 fs/网络；30s 超时 / 64MB 堆 | ⚠️ structured zap logging 已发布；Prometheus metrics / DLP / 细粒度 ACL 仍在 roadmap | README 写 MIT；GitHub API `license: null`（**未验证**） | 1★ / 0 fork；最后 push 2026-07-21（**已 4 个月无更新**）[API](https://api.github.com/repos/Belphemur/limen) |
| **corrreia/dev-mcp** | 个人版 Cloudflare MCP 网关：MCP server + OpenAPI → 单端点 | MCP Streamable HTTP `/mcp`；上游 HTTP MCP + OpenAPI | ✅ `search` / `execute`；Dynamic Workers；`codemode.catalog()/spec()/sources()` | 未验证（面向通用 MCP 客户端） | Cloudflare Workers 一键部署；D1 + Durable Objects；TanStack Start dashboard | Better Auth + OIDC；每用户独立 source registry/session/broker；上游 OAuth（PKCE+加密存储） | ✅ 仅 2 个工具对外，全量目录在沙箱内 | ✅ Dynamic Workers，默认禁出站，仅注入 source 函数 | ⚠️ `execution_logs` 记代码/结果/状态/耗时到 D1；无 eval 框架 | GitHub API `license: null`（README 未提 License，**未验证**） | 3★ / 0 fork；最后 push 2026-05-09（**半年无更新**）[API](https://api.github.com/repos/corrreia/dev-mcp) |
| **Kaiserunix/gemini-bastion-mcp** | 自托管远程 MCP + OAuth 2.1 网关；10 工具 1 审批门；coding/DevOps 垂直 | MCP 2025-11-25 Streamable HTTP（无 legacy SSE） | ❌ 无 Code Mode；10 个固定工具按「blast radius」分层 | ✅✅ Web Gemini Connected Apps / Claude.ai Custom Connectors / ChatGPT MCP Connectors **全部一手 README 明确支持** | Docker Compose + GHCR 镜像（lite ~350MB / full）；Cloudflare Tunnel 或 Nginx；无宿主端口暴露 | OAuth 2.1 + PKCE S256 + DCR（16 redirect URI / 8KB state / RFC 8707/9728）+ Google/GitHub SSO | ⚠️ 不做工具定义裁剪；靠「10 工具 1 审批门」降低确认弹窗；`readOnlyHint` 欺骗式提示避免 Gemini 每次弹窗（自述） | ✅ 每 workspace `bwrap --unshare-net` jail；UID 1001/1002 隔离；SecretScrubber；GIT_INDEX_FILE 回滚 | ⚠️ /admin PWA + SSE live jobs + scrubbed audit trail + CI Watchdog；无 eval/scorecard | MIT | 1★ / 0 fork；2026-11-20 创建，最后 push 2026-11-22（**极新、高活跃**）[API](https://api.github.com/repos/Kaiserunix/gemini-bastion-mcp) |
| **Cloudflare Code Mode（源头）** | Code Mode 模式发明者；TS API → 沙箱执行；已演进为持久化 runtime | MCP（OpenAPI/connector → TS API）；Dynamic Workers | ✅ `search`/`execute`（早期 MCP server），现 `codemode.search()/describe()/step()/run()` | 未验证（Cloudflare 客户端生态） | Cloudflare Workers / Agents SDK；`@cloudflare/codemode` npm | bindings 持凭据，沙箱无网络 | ✅ 早期宣称 2 工具 ~1,000 tokens 覆盖 2500 endpoint；渐进发现 | ✅ V8 isolate；`globalOutbound:null`；iframe 版本 CSP | ⚠️ durable log / approval / replay / rollback；无通用 eval | MIT（`cloudflare/agents`） | 6,030★（`cloudflare/agents`）/ 最后 push 2026-11-22；SDK 仍标 Experimental [API](https://api.github.com/repos/cloudflare/agents) |
| **Cloudflare MCP Server Portals** | Zero Trust 企业 MCP 门户；多上游 + Access 管控 | MCP Streamable HTTP；`?codemode=search_and_execute` | ✅ **默认开启**；暴露单个 `code` 工具，模型写 JS 调 `codemode.*` | 未验证（企业 MCP 客户端） | Cloudflare Zero Trust 托管服务 | Cloudflare Access / Zero Trust + 上游 OAuth | ✅ Code Mode 折叠全部工具定义 | ✅ Dynamic Worker 隔离；凭据不入模型上下文 | ✅ 官方 analytics API（tool-calls timeseries 等） | 商业服务（闭源托管） | 2026-03-26 GA [公告](https://developers.cloudflare.com/changelog/post/2026-03-26-mcp-portal-code-mode/) |
| **metatool-ai/metamcp** | MCP 聚合器 / 中间件 / 网关；namespace + endpoint + OpenAPI 输出 | SSE / Streamable HTTP / OpenAPI；上游 stdio + remote | ❌ 无 Code Mode；「Filter inactive tools」中间件 + roadmap 里的「Elasticsearch for tool selection」 | 未验证（Open WebUI 集成） | Docker Compose（PG）；2–4GB RAM 建议 | Better Auth + API key + MCP OAuth 2025-06-18 + OIDC（Auth0/Keycloak/Azure AD/Google/Okta）；多租户 | ⚠️ 工具过滤中间件；无 code mode 式动态发现 | ❌ 无代码执行沙箱 | ⚠️ 文件日志 / error.log；roadmap 有 observability middleware | MIT | 2,762★ / 451 fork；**已 archived**；最后 push 2026-11-12 [API](https://api.github.com/repos/metatool-ai/metamcp) |
| **samanhappy/mcphub** | 自托管 MCP 网关 + 控制面；智能路由、凭据隔离、生产运维 | MCP SSE / Streamable HTTP / stdio | ❌ 无 Code Mode；Smart Routing = pgvector 语义搜索选工具（不是沙箱执行） | 未验证（Claude Desktop / Cursor / OpenWebUI） | Docker（`samanhappy/mcphub`、`-full`）、Railway、RepoCloud；PostgreSQL 多副本 | OAuth 2.0 client+server、Bearer key、passkey、Better Auth GitHub/Google；per-user credentials | ✅ Smart Routing 向量搜索 + **Tool Result Compression**（大输出压缩）；file staging | ❌ 无 guest 代码沙箱（stdio 进程隔离） | ✅ logs / latency / health checks / activity tracking | Apache-2.0 | 2,748★ / 384 fork；最后 push 2026-11-22（**活跃**）[API](https://api.github.com/repos/samanhappy/mcphub) |
| **AmoyLab/Unla** | Go 轻量网关：REST API / MCP → MCP endpoint，零代码改造 | MCP SSE + Streamable HTTP；REST→MCP | ❌ 无 Code Mode | 未验证 | Docker allinone、K8s/Helm、裸机 | OAuth 预认证；JWT；多租户；配置持久化（SQLite/PG/MySQL） | ❌ 未见工具定义裁剪 | ❌ 无 | ⚠️ 管理 UI + 配置版本控制；无 eval | MIT | 2,262★ / 195 fork；最后 push 2026-10-20 [API](https://api.github.com/repos/amoylab/unla) |
| **agentgateway/agentgateway** | Rust 高性能 agentic proxy：LLM + MCP + A2A + guardrails | MCP stdio/HTTP/SSE/Streamable HTTP；OpenAPI→MCP；A2A | ✅ 有 Code Mode（`run_code`，JS；见 [Solo.io 博客](https://www.solo.io/blog/agentgateway-code-mode-for-openapi-to-mcp)）；embedded runtime sandbox，内存/每次调用上限，默认 60s 超时 | 未验证 | 单机 YAML / Kubernetes Gateway API controller；Linux Foundation 项目 | JWT / API key / OAuth；CEL 细粒度 RBAC；rate limit；TLS | ✅ OpenAPI→MCP 单 `run_code` 工具大幅收敛工具面 | ✅ embedded runtime，资源上限 | ✅ OpenTelemetry metrics/logs/tracing | Apache-2.0 | 6,358★ / 1,124 fork；最后 push 2026-11-22（**非常活跃**）[API](https://api.github.com/repos/agentgateway/agentgateway) |
| **docker/mcp-gateway** | Docker MCP Toolkit 的 CLI 插件 + 网关；容器化 MCP 生命周期管理 | MCP stdio（本地）/ SSE / Streamable HTTP（`--port 8080 --transport streaming`） | ❌ 无 Code Mode；有 `mcp-find` 关键词/embedding 工具发现实验 | 未验证（VS Code / Cursor / Claude Desktop 等） | Docker Desktop 4.59+ 或独立 CLI；profile/catalog OCI 分发 | Docker Desktop secrets；OAuth 流程；Cedar MCP policy（第三方资料，**未验证**） | ⚠️ 动态发现 + 工具白名单；`mcp-find` 实验性 embedding（335 工具 ~209K tokens 自述） | ✅ 每个 MCP server 独立容器隔离（非 guest JS 沙箱） | ✅ built-in logging / call tracing | MIT | 1,643★ / 297 fork；最后 push 2026-11-19（**活跃**）[API](https://api.github.com/repos/docker/mcp-gateway) |
| **HelpCode-ai/anythingmcp** | 「Enterprise Agent Harness + MCP Gateway」；600+ 连接器 + 知识图谱 + memory/skills | MCP 端点；REST/OpenAPI/SOAP/GraphQL/OData/SQL/IMAP → MCP | ❌ 未见 Code Mode（有 code execution 关键词，**未验证**） | ✅ Claude / ChatGPT / Microsoft Copilot（README 自述） | 自托管 + 云版 | SSO/RBAC + audit log | ❌ 未见工具定义裁剪；反以「更多工具」为卖点 | ⚠️ 提及 code execution（细节未验证） | ✅ audit log + governance | AGPL-3.0 | 819★ / 140 fork；最后 push 2026-11-22（活跃）[API](https://api.github.com/repos/helpcode-ai/anythingmcp) |
| **postrv/forgemax** | 本地 sandboxed MCP Gateway，Code Mode 启发，N×M → 2 工具 ~1,000 tokens | 本地 stdio MCP | ✅ 2 工具 | ❌ 本地客户端 | Rust 本地二进制 | 未验证 | ✅ 2 工具收敛 | ✅ 本地沙箱（Rust） | 未验证 | Other / NOASSERTION | 159★ / 11 fork；最后 push 2026-10-21 [API](https://api.github.com/repos/postrv/forgemax) |

### 1.2 Web client 平台侧事实（不是竞品，但决定我们的适配工作）

| 平台 | 事实 | 来源 |
|---|---|---|
| **Gemini Connected Apps** | 要求 OAuth 2.1 + PKCE（强制），well-known 发现按固定顺序尝试且**遇到非 200 就停止**；必须提供 `registration_endpoint`（DCR）或手动填 client id/secret；`response_types_supported` 必须含 `code`；刷新令牌**不要轮转**（持久关联） | [Google OAuth 2.1 指南](https://developers.google.com/connected-apps/mcp/oauth) |
| **ChatGPT** | 自定义远程 MCP（apps/connectors）需 Developer Mode；Business/Enterprise/Edu 支持完整写能力，Plus/Pro 仅 read/fetch-only；`connector_id` 已 deprecated，改用 `server_url` | [OpenAI Help Center](https://help.openai.com/ko-kr/articles/12584461-developer-mode-apps-and-full-mcp-connectors-in-chatgpt-beta)、[OpenAI API schema](https://developers.openai.com/api/reference/cli/__sdk_schema?declaration=%28resource%29+realtime+%3E+%28model%29+realtime_response_create_mcp_tool+%3E+%28schema%29&selected=%28resource%29+realtime) |
| **Claude.ai** | 自定义连接器支持远程 MCP，免费用户限 1 个；Claude 从 Anthropic 云连接，**服务器必须公网可达** | [Anthropic Help Center](https://support.claude.com/zh-CN/articles/11175166-%E4%BD%BF%E7%94%A8%E8%BF%9C%E7%A8%8B-mcp-%E5%BC%80%E5%A7%8B%E4%BD%BF%E7%94%A8%E8%87%AA%E5%AE%9A%E4%B9%89%E8%BF%9E%E6%8E%A5%E5%99%A8) |
| **GeminiBastionMCP 实战细节** | Web Gemini 忽略 `readOnlyHint:false` 工具的「Always Allow」，每次调用都弹窗；该项目默认把 Tools 1–9 标为 `readOnlyHint:true`（**工具提示层面的策略，不等于真实只读**），只留 `publish_changes` 一个审批门；state 可达 8192 字节、DCR 16 redirect URI | [README](https://github.com/Kaiserunix/gemini-bastion-mcp) |

> **关键启示**：我们 README 已声明「单用户/自托管、Gemini 实测，其他客户端未验证」。上面 ChatGPT/Claude 的平台约束说明——**所谓「通用 MCP 客户端」并不通用**，各网页客户端的 OAuth/确认 UX 都是独立适配工作。

---

## 2. 我们的差异化（能站住脚的部分）

> 以下均可在仓库内自证；细节见 `docs/CODEMODE-SURVEY.md`（竞品技术谱系）、`docs/WHY.md`、`docs/OBSERVABILITY-AND-EVAL.md`。

1. **3 工具且读写分层：`search` / `execute_read` / `execute`**
   - 竞品几乎全是 2 工具（Limen、dev-mcp、Cloudflare 早期 MCP server、Forgemax）或 1 工具（Cloudflare Portals `code`、agentgateway `run_code`），**没有一家在 MCP 工具边界上做只读/全量双执行器的拆法**。
   - 对无法做细粒度逐工具审批的网页客户端尤其实用：`execute_read` 里写工具替换为会抛可操作错误的 stub（`src/codemode.js`）。
   - 旁证：Cloudflare 用 `requiresApproval`+重放、Vercel AI SDK 明确「需要审批的工具别放进 code mode」、Anthropic PTC 用 `allowed_callers`、OpenCode 用逐工具权限规则——都不等价。来源：[Cloudflare Code Mode 文档](https://developers.cloudflare.com/agents/tools/codemode/)、[Vercel AI SDK Code Mode](https://ai-sdk.dev/docs/ai-sdk-core/code-mode)、[Anthropic PTC](https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling)、[OpenCode tools#execute](https://opencode.ai/docs/tools#execute)。

2. **QuickJS 引擎级真隔离（不是 node:vm，不是「JS 不在沙箱」）**
   - `run` SDK 2.1.13 的 worker-thread QuickJS；guest 无 `process`/`require`/`fetch`/Node globals；原型冻结、`.constructor` 逃逸被挡；有 `tests/true-isolation.test.js` 与线上探活证据（`docs/SANDBOX-SECURITY.md`）。
   - 对照：Limen 用 Goja、Cloudflare 用 V8 isolate（绑平台）、OpenCode 自研最小 JS 解释器（明确不嵌 QuickJS）、Claude Code CLI 的 JS 明确**在沙箱外**。在通用 Node/Vercel 可部署的 MCP 网关里做这件事，是我们独有的组合。

3. **全量 capture + 真实数据闭环（最被低估的差异化）**
   - HTTP/MCP/上游双向原始帧/sandbox/OAuth/config/deployment 全量记录，不采样、不按主观裁剪；原文存私有 Vercel Blob，索引分离（`docs/OBSERVABILITY-AND-EVAL.md`）。
   - 配套 L0（364 tests）→ L1 smoke（50 任务，fake/replay/real）→ L2 G6（228 任务）→ scorecard 的 eval 阶梯（`docs/eval/`）。
   - 竞品的「可观测」多为日志/健康检查/调用追踪（Docker tracing、MCPHub logs、agentgateway OTel、Limen zap+roadmap metrics、dev-mcp `execution_logs`），**没有一家把全量原文 capture 与按周 scorecard 放在一起，并明确记录 Gemini 侧物理不可见的边界**。

4. **真实写路径验证 + 写语义工程**
   - `docs/ledger/batch-10-write-semantics.md`、`batch-10-idempotent.md`、`batch-10-pr-workflow.md`、`docs/eval/write-replay-2026-11-23.md`：真实 GitHub 写、幂等、重放、PR 工作流都有 ledger。竞品 README 多数只展示读示例或泛泛说「支持写」。
   - `execute_read` 的只读标注 Carry-through、工具名 `server__tool` 适配 Gemini 下划线解析、schema `sanitizeTool`、文本 JSON 结果——全是 web client 实战细节（`AGENTS.md`、`docs/UPSTREAMS.md`）。

5. **Gemini 实测 + 上下文定量证据**
   - `scripts/measure-context.mjs` 实测 506 工具 ~245,377 tokens → 3 工具 ~1,520 tokens（-99.4%）；BM25 search top1 56.5%、top5 72.3%，中文优化后 top1 88%（`docs/WHY.md`）。
   - Cloudflare 的 1,000 tokens 与 -99% 都是「自述」或基于自家 API spec；我们是**在自己的生产目录上离线可复现**的。

6. **诚实性设计**
   - `services()` 明确标注冷启动快照不是 live health check；截断打 `--- TRUNCATED ---`；capture 文档明确列出「网关物理看不到 Gemini 聊天上下文/推理/token」。这类反幻觉说明在竞品文档里很少见。

---

## 3. 我们缺的 table-stakes（按优先级）

| 优先级 | 缺口 | 竞品参照 | 建议 |
|---|---|---|---|
| P0 | **Docker 部署** | Docker MCP Gateway（1,643★）、MCPHub、Unla、gemini-bastion-mcp（GHCR 零构建）都有一键容器化；我们 README 只有 `npm start` + Vercel | 最小 `Dockerfile` + `docker-compose.yml`（Node 20/22），不引入编排复杂度 |
| P0 | **ChatGPT / Claude 网页版适配验证 + 配置模板** | gemini-bastion-mcp 已把三家 DCR 细节做成 README 章节；ChatGPT Developer Mode / read-only 限制、Claude 公网可达要求都是硬门槛 | 在 README 增「Client setup」小节；至少验证 Claude.ai custom connector（与 Gemini 同为 OAuth 2.1 DCR，成本最低），ChatGPT 标注 plan 限制 |
| P1 | **Cloudflare Workers 一键部署** | corrreia/dev-mcp 有 "Deploy to Cloudflare" 按钮；Cloudflare 自家 Portals Code Mode 默认开 | 评估成本；至少写清楚「为什么选 Vercel」的取舍，避免被当成缺位 |
| P1 | **配置模板 / 管理 UI** | MCPHub / Unla / MetaMCP 都有 dashboard 与 hot-reload；我们已有 `templates/upstreams/` 但无 UI | 先补模板数量与示例质量（config.example 防御性占位符），UI 暂缓 |
| P2 | **spill 而非截断** | Anthropic `$OUTPUT_DIR`→`file_id`、Cloudflare durable value 超限建议外部引用 | 我们目前截断不可回读；这是准确率天花板问题，详见 `docs/CODEMODE-SURVEY.md` P0 建议 |
| P2 | **类型化工具发现（TS 签名）** | Cloudflare `generateTypesFromJsonSchema`、Vercel TS signatures | 我们已导入但未使用 `generateTypesFromJsonSchema`；`select:<name>` 返回 TS 声明可提升调用正确率 |
| P2 | **多用户 / 租户** | MetaMCP、MCPHub、Unla、dev-mcp 都有 per-user 凭据/隔离 | **不做**（见第 4 节）——但 README 必须明确 single-user 定位，避免被误判成熟度 |

---

## 4. 明确不做的功能（与定位冲突）

1. **多租户 / RBAC / 组织级控制面**：我们的价值是「一个人把常用上游塞进一个网关」，上多租户就要引入用户系统、配额、租户隔离、审计合规，直接变成 MCPHub/MetaMCP 的低配版。
2. **企业 Zero Trust / 网关即策略引擎**：Cloudflare MCP Portals、agentgateway 的 CEL/RBAC、Docker 的 Cedar policy 是它们的地盘；我们不做策略编排。
3. **通用 LLM gateway / 模型路由 / 预算控制**：agentgateway、OmniRoute 类项目在做；保持「只做 MCP 工具面」。
4. **把宿主自带 code execution（PTC / Gemini code_execution）当竞争方向**：Anthropic PTC 明确**不支持 MCP connector 工具**（[来源](https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling)），Gemini code execution 是计算工具不是协议层；网关层 code mode 对网页客户端的价值反而更大。
5. ** empires of connectors / 知识图谱 / 企业 brain**：anythingmcp 的 AGPL 企业路线与我们 MIT + 轻量定位相反。
6. **持久化审批 / replay / rollback runtime**：Cloudflare 的主线；我们是单次无状态执行。若做也应保持轻量（pending + executionId 重跑），不要追成 durable workflow 引擎。
7. **为「所有 MCP 客户端」做泛化验证**：README 已诚实标注未验证；不要为了追 star 写虚假兼容性声明。

---

## 5. 开源定位与 README 对比表建议

### 5.1 一句话定位（建议）

> **The Code Mode MCP gateway for web AI clients — three stable tools, a real QuickJS sandbox, and full-fidelity captures for evaluation.**

中文：「面向网页版 AI 的 Code Mode MCP 网关：3 个稳定工具、真 QuickJS 沙箱、全量可观测数据驱动评测。」

备选（更强调痛点）：「Give Gemini, Claude and ChatGPT 191 tools without putting 191 tool definitions in the prompt.」

### 5.2 README 对比表建议（英文，可直接粘贴）

> 只对比**同一交叉点**（MCP 网关 + Code Mode + web client），不与"大而全控制面"硬比功能数量。
> 数字均来自本文第 1 节的抓取快照；发布前建议重新抓取 stars 并更新时间。

```markdown
| | This gateway | Limen | corrreia/dev-mcp | Cloudflare Portals | GeminiBastionMCP | MetaMCP | MCPHub |
|---|---|---|---|---|---|---|---|
| Code Mode tools | **3** (`search`/`execute_read`/`execute`) | 2 | 2 | 1 (`code`) | none (10 fixed tools) | none | none |
| Read/write split in sandbox | **yes** | no | no | no | approval gate instead | n/a | n/a |
| Sandbox | QuickJS (worker thread) | Goja | Dynamic Workers | Dynamic Workers | bwrap jail | none | none |
| Web Gemini / Claude / ChatGPT | Gemini tested; others unverified | unverified | unverified | unverified | all three documented | unverified | unverified |
| Upstream aggregation | Streamable HTTP + stdio | remote only | MCP + OpenAPI | enterprise portals | downstream MCP-2 federation | stdio + remote | stdio + remote |
| Full-fidelity capture + eval | **yes** | metrics (roadmap) | execution_logs | analytics API | audit trail | logs | logs |
| Deploy | Node/Vercel | single Go binary | Cloudflare Workers | managed Zero Trust | Docker/GHCR | Docker | Docker |
| License | MIT | MIT* | *unverified* | commercial | MIT | MIT (archived) | Apache-2.0 |
```

表下加一句脚注：`*Limen README says MIT; GitHub API reports no license. Stars/activity snapshot 2026-11-23; see docs/OPEN-SOURCE/COMPETITORS.md.`

### 5.3 README 中建议新增的段落顺序

1. 现有 hero + 99.4% 数字（保留）。
2. **「Why another Code Mode gateway?」** 一段：承认 Cloudflare/Limen/dev-mcp 已做 Code Mode；我们的差异是 3 工具读写分层 + QuickJS + capture/eval + Gemini 实测。链接本文。
3. **「Client setup」**：Gemini（已验证，步骤）+ Claude/ChatGPT（未验证，标注限制与所需 plan）。
4. **「Not trying to be」**：明确 single-user / 不做多租户 / 不做企业策略网关（用本文第 4 节的精简版）。

---

## 6. 来源清单（全部附 URL）

**指定竞品（一手 README / API）**
- Limen：<https://github.com/Belphemur/limen>、<https://raw.githubusercontent.com/Belphemur/limen/main/README.md>、<https://raw.githubusercontent.com/Belphemur/limen/main/internal/transport/codemode_server.go>、<https://api.github.com/repos/Belphemur/limen>
- corrreia/dev-mcp：<https://github.com/corrreia/dev-mcp>、<https://raw.githubusercontent.com/corrreia/dev-mcp/main/README.md>、<https://api.github.com/repos/corrreia/dev-mcp>
- Kaiserunix/gemini-bastion-mcp：<https://github.com/Kaiserunix/gemini-bastion-mcp>、<https://raw.githubusercontent.com/Kaiserunix/gemini-bastion-mcp/main/README.md>、<https://api.github.com/repos/Kaiserunix/gemini-bastion-mcp>

**平台 / 生态**
- Cloudflare Code Mode：<https://blog.cloudflare.com/code-mode>、<https://blog.cloudflare.com/code-mode-mcp>、<https://developers.cloudflare.com/agents/tools/codemode/>、<https://developers.cloudflare.com/agents/tools/codemode/how-it-works/>、<https://github.com/cloudflare/agents>、<https://api.github.com/repos/cloudflare/agents>
- Cloudflare MCP Portals Code Mode（2026-03-26）：<https://developers.cloudflare.com/changelog/post/2026-03-26-mcp-portal-code-mode/>、<https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/>
- MetaMCP：<https://github.com/metatool-ai/metamcp>、<https://raw.githubusercontent.com/metatool-ai/metamcp/main/README.md>、<https://api.github.com/repos/metatool-ai/metamcp>
- MCPHub：<https://github.com/samanhappy/mcphub>、<https://raw.githubusercontent.com/samanhappy/mcphub/main/README.md>、<https://api.github.com/repos/samanhappy/mcphub>
- Unla：<https://github.com/AmoyLab/Unla>、<https://raw.githubusercontent.com/AmoyLab/Unla/main/README.md>、<https://api.github.com/repos/amoylab/unla>
- agentgateway：<https://github.com/agentgateway/agentgateway>、<https://raw.githubusercontent.com/agentgateway/agentgateway/main/README.md>、<https://api.github.com/repos/agentgateway/agentgateway>、<https://www.solo.io/blog/agentgateway-code-mode-for-openapi-to-mcp>
- Docker MCP Gateway：<https://github.com/docker/mcp-gateway>、<https://raw.githubusercontent.com/docker/mcp-gateway/main/README.md>、<https://api.github.com/repos/docker/mcp-gateway>
- Forgemax：<https://github.com/postrv/forgemax>、<https://api.github.com/repos/postrv/forgemax>
- AnythingMCP：<https://github.com/HelpCode-ai/anythingmcp>、<https://api.github.com/repos/helpcode-ai/anythingmcp>

**Web 客户端平台约束**
- Gemini Connected Apps OAuth 2.1：<https://developers.google.com/connected-apps/mcp/oauth>、<https://developers.google.com/connected-apps>
- ChatGPT Developer Mode / MCP connectors：<https://help.openai.com/ko-kr/articles/12584461-developer-mode-apps-and-full-mcp-connectors-in-chatgpt-beta>、<https://gofastmcp.com/v3/integrations/chatgpt>
- Claude.ai custom connectors：<https://support.claude.com/zh-CN/articles/11175166-%E4%BD%BF%E7%94%A8%E8%BF%9C%E7%A8%8B-mcp-%E5%BC%80%E5%A7%8B%E4%BD%BF%E7%94%A8%E8%87%AA%E5%AE%9A%E4%B9%89%E8%BF%9E%E6%8E%A5%E5%99%A8>、<https://claude.com/docs/claude-science/custom-connectors>

**Code Mode 谱系 / 反面参照**
- Anthropic code execution with MCP：<https://www.anthropic.com/research/code-execution-with-mcp>
- Anthropic PTC（MCP connector 不支持）：<https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling>
- Vercel AI SDK Code Mode：<https://ai-sdk.dev/docs/ai-sdk-core/code-mode>
- OpenCode Code Mode：<https://opencode.ai/docs/tools#execute>、<https://github.com/anomalyco/opencode/issues/58708>
- Speakeasy（网关是跑 code mode 的正确位置）：<https://www.speakeasy.com/resources/code-mode>

**本项目内部依据**
- `README.md`、`package.json`、`docs/WHY.md`、`docs/CODEMODE-SURVEY.md`、`docs/OBSERVABILITY-AND-EVAL.md`、`docs/UPSTREAMS.md`、`docs/SANDBOX-SECURITY.md`、`docs/eval/`、`docs/ledger/`

---

## 7. 维护说明

- 本文只记录调研结论，**不构成任何代码变更依据**；竞品自述数字未经独立复现。
- 下次更新建议：重新抓取 GitHub API 的 stars/pushed_at（尤其 Limen 是否恢复活跃、MetaMCP archived 状态是否变化）、Cloudflare MCP Portals Code Mode 是否从 1 工具演进到 search/describe、ChatGPT/Claude 连接器政策是否有变。
- 「未验证」项在拿到一手证据前不要升级为事实。
