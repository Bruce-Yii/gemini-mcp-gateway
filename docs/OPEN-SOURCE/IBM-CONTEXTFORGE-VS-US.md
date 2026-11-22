# IBM/mcp-context-forge 深度竞品分析（静态源码审查版）

> 日期：**2026-11-23**；时间窗口 2026-11-21 ~ 2026-11-23（Asia/Singapore）。
> 分析方法：`git clone --depth 1 https://github.com/IBM/mcp-context-forge.git` 到 `work/ibm-contextforge/`（只读，
> commit `14a4c4a6`，2026-11-20T15:14:12Z），通读 README（1007 行）、`docs/docs/`（288 个 md）、关键源码
> （`mcpgateway/` 442 个 py / 约 223,717 行）、`plugins/`（41 个插件目录）、`pyproject.toml`、
> `Containerfile`、`docker-compose*.yml`、`charts/`，并用 `gh repo view` / `gh release list` / `gh api`
> 抓取快照。**未运行其服务或测试**（无环境副作用）。
> 结论分三类：**[官方]** = 上游 README/文档/release 自述；**[代码]** = 本地 clone 中可直接核验的源码/配置事实；
> **[未验证]** = 无一手证据，不下结论。所有数字都是本窗口快照，stars/活跃度随时间长变。
> 本文只聚焦 ContextForge 与我们的关系；上游仓库内的 AGENTS.md/CLAUDE.md 仅作为其治理事实阅读，未受其约束。

---

## 0. TL;DR（给 lead 的结论）

1. **ContextForge 是企业级"AI 基础设施控制面"**：MCP + A2A + REST/gRPC 联邦网关、registry、virtual servers、
   40+ 插件、RBAC/SSO/OAuth/DCR、OTel 观测、PostgreSQL/Redis/K8s。规模约 22 万行 Python + 891 个测试文件；
   Apache-2.0；4,875★ / 982 fork / 992 open issues；约每 2~3 周一个 release，最近 v1.1.1（2026-11-10）。
   **[官方] [代码]**
2. **它的"优化"和我们不是同一件事**：README 的 "Optimizes Agent & Tool calling" 落到代码上主要是
   **TOON 插件压缩工具"结果"**（`tool_post_invoke`，JSON→TOON，30–70% 自述），且该插件在
   `plugins/config.yaml` 中默认 `mode: disabled`、框架本身 `PLUGINS_ENABLED=false`。它**不压缩工具定义**，
   **没有 tool search / progressive disclosure**（语义搜索明确列在 roadmap），**没有 Code Mode、没有 guest 代码沙箱**
   （untrusted server 沙箱也是 roadmap 🚧）。**[代码] [官方]**
3. **它面向企业多租户运维者，不是网页客户端单用户**：一手客户端文档只列 Claude Desktop / Cline / Continue /
   MCP Inspector；**没有 Gemini web / ChatGPT web / Claude web 的连接器适配证据**，尽管它自己实现了
   OAuth 2.0 DCR + PKCE（作为"网关 → 上游 MCP server"的客户端侧能力，语义与我们"作为授权服务器给 web 客户端"相反）。
   **[代码] [未验证]**
4. **直接吃我们开源用户的风险低**：它解决"企业把几百个内部系统治理起来"，我们解决"一个人把常用上游塞进
   Gemini 网页版还不炸上下文"。重叠在"工具聚合"，但它把工具全量列给客户端、我们只暴露 3 个稳定工具。
   真正威胁是**定位叙事**：它 4.9k★ + IBM 品牌 + "上下文压缩"关键词，会让搜索 "MCP gateway context
   optimization" 的人先看到它——所以我们的文档必须把"压的是工具定义 vs 压的是结果"讲清楚。
5. **最该抄**：virtual server 按场景裁剪工具集、`GET /v1/search` 统一检索 API、工具预览 dry-run、
   幂等/异步写生命周期（`Retry-After`、name 去重键）、RBAC/token scoping 的思路（只取其思想，不引入体系）。
   **最不该抄**：企业控制面、多租户、40+ 插件框架、PostgreSQL/Redis/K8s、A2A/LLM proxy、TOON（对我们收益低，
   我们已经在沙箱内做结果投影）。**[分析]**
6. **一句话定位建议**（可直接进 README）：
   > **ContextForge governs the enterprise tool estate; gemini-mcp-gateway shrinks the tool surface for one
   > web-client user.** It compresses tool *results* behind a full control plane; we compress tool *definitions*
   > into three stable tools and orchestrate calls in a real QuickJS sandbox with full-fidelity capture/eval.

---

## A. ContextForge 到底是什么

### A.1 定位与架构

- **官方定义**：README:3,20-28 —— "An open source registry and proxy that federates MCP, A2A, and REST/gRPC
  APIs with centralized governance, discovery, and observability. Optimizes Agent & Tool calling, and supports
  plugins."；"runs as a fully compliant MCP server … scales to multi-cluster environments on Kubernetes with
  Redis-backed federation and caching"。
- **技术栈** [官方+代码]：FastAPI + Pydantic 2 + SQLAlchemy 2（SQLite 默认 / PostgreSQL 生产）、Alembic 迁移、
  Uvicorn(dev)/Gunicorn(prod)、HTMX 2 + Alpine.js Admin UI、**独立容器**的 Web UI v0.2.4（README:408-427）。
  架构文档 `docs/docs/architecture/index.md:29-149` 明确分层：FastAPI 应用、ORM、多传输 MCP、
  联邦 registry、virtual server 组合、多租户 RBAC、插件框架、OTel、A2A、安全/限流、资源/内容管理。
- **重要修正** [官方]：`docs/docs/architecture/index.md:7-19` —— 仓库内 Rust runtime/workspace 已按
  EPIC #5817 / ADR-058 删除（v1.1.1 release "Removed" 段同样确认）；"Performance-Optimized Foundation"
  一段仍在宣传 Rust-powered 组件（同文件 141-149 行），属于**文档内部矛盾**，以 v1.1.1 release notes
  "completes the removal of the repository-owned Rust runtime" 为准。
- **规模** [代码，本次统计]：
  - `mcpgateway/` 442 个 .py、约 223,717 行；`services/` 84 个 py、`routers/` 31 个、`middleware/` 25 个。
  - `tests/` 891 个 `test_*.py`（README:136/926 自述 "7,000+ tests"，未逐条核验测试数）。
  - `plugins/` 41 个插件目录；`docs/docs/` 288 个 md。
  - `pyproject.toml:60-110`：Python >=3.12,<3.15；核心依赖约 45 项（fastapi、mcp>=2.0、sqlalchemy、
    redis、cel、cpex、jq、jsonschema、orjson、starlette-compress 等）；`uv.lock` 存在。
  - README:382 自述 "PostgreSQL - 55+ tables"；`config.py` 300+ 环境变量（README:797 自述）。

### A.2 MCP / A2A / REST 网关与 registry

- **协议/传输** [官方]：README:73-82 —— MCP 联邦、A2A 集成（OpenAI/Anthropic/custom agents）、
  gRPC→MCP 反射式翻译、REST→MCP 适配器（JSON Schema 抽取 / headers / tokens / retry / rate-limit）、
  HTTP/JSON-RPC/WebSocket/SSE/Streamable HTTP、stdio（server 侧）。
- **MCP 协议版本** [代码+官方]：README:94 示例中可选 `2025-11-25`；架构文档 `index.md:47` 仍写
  "protocol version 2025-03-26"，v1.1.1 release notes 又写了 `initialize (2025-11-25)` 与
  `server/discover (2026-07-28)` —— 说明**协议支持是多版本并存**，文档滞后，不能只看某一句。
- **Registry** [官方+代码]：tools / resources / prompts 三类统一注册（README:121-127）；
  MCP Server Catalog（YAML，100 项/页，3600s 缓存，`docs/docs/architecture/index.md:135-139`）；
  `mcpgateway/routers/search.py` 提供 `GET /v1/search` 跨实体统一搜索（servers/gateways/tools/resources/
  prompts/agents/teams/users/roots/catalog），`q` + tag 过滤 + `limit` 默认 8，**关键词搜索**
  （`perform_unified_search` 实现于 `admin.py`，经 search.py:86-105 委派）。
- **Virtual servers** [官方+代码]：README:309-322 给出 `POST /servers` + `associated_tools` 的端到端示例；
  `docs/docs/overview/ui-concepts.md:28-37` 定义 "logical wrapper that combines selected tools, resources,
  and prompts under one context-specific endpoint"，客户端访问 `/servers/{UUID}/mcp`。
  **这是它离"工具面收敛"最近的能力，但仍是"全量暴露所选工具定义"，不是我们的 3 工具 + 运行时检索。**

### A.3 插件、部署依赖、License

- **插件** [代码]：框架为外部 `cpex` 包（README:25 自述 40+ plugins；`plugins/AGENTS.md` 列 6 个生产 hook：
  prompt/tool/resource 的 pre/post；模式 sequential/transform/disabled；支持 native 与 external MCP 插件）。
  `plugins/config.yaml` 1349 行，绝大多数插件 `mode: disabled`（含 ToonEncoder、OutputLengthGuard），
  `.env.example` 中 `PLUGINS_ENABLED=false`。即**插件是可选能力，不是默认行为**。
- **部署依赖** [官方+代码]：PyPI `mcp-contextforge-gateway`（pip/uvx 一行启动）、Docker/Podman GHCR 镜像、
  docker-compose（PostgreSQL + Redis + 3 gateway 副本 + Nginx，README:344-386）、Helm chart
  `charts/mcp-stack`（HPA/ingress/网络策略，README:429-482）、K8s/OpenShift/AWS/Azure/GCP/IBM Cloud 指南、
  飞地/离线（airgapped）部署。**注意 arm64 生产不支持**（README:336）；
  `README.md:340` 明确本地 `docker compose build` 会因为"hermetic wheel closure only produced by CI"失败，须 pull 预构建镜像。
- **License** [代码]：根目录 `LICENSE` = Apache License 2.0；`pyproject.toml:53-55` `license = "Apache-2.0"`；
  `gh repo view` 快照 `licenseInfo.key = apache-2.0`。
- **活跃度快照** [官方 API，2026-11-23]：
  `gh repo view IBM/mcp-context-forge` → stars **4,875**、forks **982**、open issues **992**、
  创建 2025-05-08、push 2026-11-21T20:19:28Z；
  `gh release list` → v1.1.1（2026-11-10，含 72 PR）、v1.1.0（2026-10-20）、v1.0.11（2026-09-28）…
  约月度节奏；最近提交 `14a4c4a6` 2026-11-20 "Security hardening (#7633)"。
  **判断：高活跃、高维护成本、明显企业级投入。**

---

## B. 它的"上下文/工具调用优化"究竟是什么

> 这是本报告最关键的一节：营销词 "Optimizes Agent & Tool calling" 容易被误读成和我们同一赛道。逐条拆开看。

### B.1 TOON compression：压缩的是**工具结果**，不是工具定义；默认关闭

- **定义** [官方+代码]：`plugins/toon_encoder/toon.py:6-11` —— TOON (Token-Oriented Object Notation) 是
  JSON 数据模型的紧凑人类可读编码，spec v3.0（`https://github.com/toon-format/spec`），纯 Python 实现，
  支持 columnar 数组（如 `[2]{x,y}:\n 1,2\n 3,4`）、encode/decode/`estimate_token_savings`。
- **作用点** [代码]：`plugins/toon_encoder/toon_encoder.py:11-12,119` —— 挂在 **`tool_post_invoke`** hook，
  "intercepting tool results **after execution**"；只处理 `result["content"]` 中 `type=="text"` 且能
  `orjson.loads` 的 JSON 字符串（`:239-266`）；`min_size_bytes=100`、`max_size_bytes=1MB`（`:101-102`）；
  **仅当 TOON 结果严格小于原 JSON 才替换**（`:276-281`）；替换时保留 annotations 并加
  `annotations.format="toon"`（`:289-303`）；有 `exclude_tools`/`include_tools` 过滤与 `skip_on_error`（`:210-224`）。
- **收益声明** [官方]：插件 docstring `:60` 与 `plugins/config.yaml:1241` 自述 "typically reduces token count
  by **30-70%**" —— **未独立验证**（我们未运行其测试/无真实 eval 数据），且是"结果文本"的字符/token 比例，
  与我们的"工具定义 token 数"完全不是同一指标。
- **默认状态** [代码]：`plugins/config.yaml:1238-1260` —— `ToonEncoder` `mode: "disabled"`；
  `plugins/AGENTS.md` 与 `.env.example` 显示 `PLUGINS_ENABLED=false`。**默认部署下 TOON 不生效。**
- **结论** [分析]：ContextForge 的"压缩"是**传输/编码层的结果瘦身**（类似 JSON→列式文本），
  不是"少给模型几个工具定义"。它不改变 `tools/list` 的大小；模型仍看到所有已注册工具的 schema。
  另外，TOON 是上游格式，模型是否原生理解需客户端配合（格式标记只是 annotation），**对 Gemini web 的实际
  兼容性未验证**。

### B.2 有没有 tool search / progressive disclosure？——没有（明确在 roadmap）

- [代码] `mcpgateway/routers/search.py:37-105` 的 `GET /v1/search` 是**运维/管理向**的统一检索（跨 servers、
  tools、prompts、agents、teams、users 等），面向已认证用户，不是 MCP `tools/call` 暴露给模型的元工具；
  `q` 是 free-text 关键词，`limit` 默认 8。
- [官方] `docs/docs/best-practices/selecting-an-mcp-gateway.md:495-515`：
  "**ContextForge Roadmap** — Tool embedding index and semantic search service；Conversational tool discovery
  interface；Tool recommendation engine based on usage patterns；Natural language direct tool execution；
  Tool usage analytics for search ranking optimization；Tool chain templates and workflow automation"。
  同页 499 行把 "Semantic tool search beyond keyword matching" 列为**待评估项**而非已交付项。
- [代码] `mcpgateway/transports/streamablehttp_transport.py:4139-4148` 有 **paginated `tools/list`**（v2 handler，
  `cursor` + `ttl_ms` + `cache_scope="private"`，同文件 4122-4132 的 `list_catalog_page`）。
  但这只是协议层分页，**不是模型驱动的按需发现**；而且 `notifications/tools/list_changed` 存在于代码
  （`:4929`）——与 Gemini web 不消费该通知的限制相反，它的设计假定客户端能处理动态工具列表。
- **结论** [分析]：没有类似我们 `search` 的 progressive disclosure；virtual server 允许**管理员预先**裁剪
  每个端点的工具集（静态、按项目），不是模型运行时检索。

### B.3 有没有 code mode / 沙箱执行？——没有；untrusted-server 沙箱仍 🚧

- [官方] `docs/docs/architecture/security-features.md:198-211` 在 "Planned & In-Progress Enhancements (🚧 Planned)"
  中列出 "**Sandboxed execution** — gVisor, Firecracker, or WebAssembly sandboxes for untrusted MCP servers and
  plugins"（:203），并声明 "These features remain **aspirational until the associated PRs merge**"（:211）。
- [官方] `docs/docs/best-practices/selecting-an-mcp-gateway.md:549` 把 "Sandboxing beyond containers (gVisor, Kata,
  SELinux)" 和 TEE 列入 evaluation 清单；:568 "Kubernetes Operator (Helm-based … - roadmap)"。
- [代码] 仓库中确实存在**沙箱化的表达式求值**：`CEL_EXECUTION=subprocess`（fork 子进程，1s 超时）、
  jq filter sandbox、JSON Schema regex sandbox（`docs/docs/manage/securing.md:719-814`、`config.py`），
  v1.1.1 引入 CEL tool validation policy。**这些是策略/校验的小沙箱，不是 guest JS 代码执行，
  也不是工具编排 runtime。**
- [官方] README:932-936 反而警告："Never run untrusted MCP servers directly on your local filesystem …
  Always use a sandbox, container, or microVM"——即它承认自己不提供该隔离，靠外部容器。
- [未验证] 全仓 grep 未见 `codemode` / `execute_read` / guest JS 执行工具（我们检索 `codemode|code mode|
  sandbox|scorecard` 的文档命中均为架构模式讨论/roadmap/插件安全，无已交付的 code mode 工具）。
- **结论**：**没有 Code Mode，没有 our `execute_read`/`execute` 对等物，没有 QuickJS/V8 guest runtime。**

### B.4 读写分层、工具调用编排（批量/分页/幂等/写路径）

| 能力 | ContextForge 实际情况 | 证据 |
|---|---|---|
| 只读/写分层 | **无执行器分层**。暴露的是原始上游工具；`readOnlyHint` 等 annotations 由上游附带，网关在 `api-usage.md:738` 示例中原样呈现，不做强制分层。 | [代码] `docs/docs/manage/api-usage.md:738`；架构 `tool-invocation-and-validation.md` 全文 |
| 工具预览 dry-run | **有**：`POST /tools/preview/{name}`，v1.1.1 增加 `server_id` 限定 virtual server 内工具；`tool_pre_invoke` hook 仅当插件带 `tags: ["preview_safe"]` 才在预览中运行（`plugins/AGENTS.md` "preview_safe" 段）。 | [官方] v1.1.1 release "server_id on tool preview"；[代码] `plugins/AGENTS.md` |
| 批量 | 管理面有 bulk import/export（`mcpgateway_bulk_import_max_tools=200`，`config.py:1333`）；调用面无"批量工具调用"元工具。OAuth status 有 batch endpoint（`routers/oauth_router.py:1756`）。 | [代码] 上述路径 |
| 分页 | **有**：管理 REST 普遍 `limit/offset` 或 cursor；MCP `tools/list` v2 分页（`streamablehttp_transport.py:4139-4144`）；v1.1.1 "federated pagination results are deduplicated"。 | [代码+官方] 同上 |
| 幂等/写语义 | **有工程化的生命周期语义**：async gateway 注册用 name 作 natural dedup key；重复 POST 同 name 在 pending 时返回当前记录 `202`，active 时 `409`；`Retry-After` 提示；DELETE 幂等（重复删返回 202/最终 404）；指数退避 `min(2**(n-1),300)s`。**这是"网关资源写入"语义，不是"模型调用上游工具"的幂等保证**——后者依赖各工具自身的 `idempotentHint`。 | [官方] `docs/docs/manage/api-usage.md:364-418` |
| 写路径验证 | 工具输入 schema 校验 + 三层输出 schema 校验（Validator A/B/C，`docs/docs/architecture/tool-invocation-and-validation.md`）；CEL tool validation policy 决定哪些 discovered tools 被启用（v1.1.1）；**没有捕获/回放真实写调用做回归**。 | [官方+代码] 同上 |

### B.5 真实 eval / scorecard？——网关内没有；依赖外部观测平台

- [官方] OTel/Langfuse/Phoenix 集成文档描述的是**外部**能力：`docs/docs/manage/observability/langfuse.md:11,235`
  "Evaluations — Score traces with custom or built-in evaluators"；`phoenix.md:139-155` 给出
  `phoenix.evals.llm_eval` 示例。**这些不是 ContextForge 自带的工具调用 scorecard。**
- [代码] README:900-907 的 `make test/coverage` 是**软件测试**，不是模型 eval；`bench`/Locust 是性能压测
  （`docs/docs/deployment/openshift-pgo.md:234-252`），不是质量评测。
- [未验证] 未发现类似我们 `docs/eval/` G6 scorecard / 全量 capture 回放的设施。
- **结论**：它的"可观测"= traces/metrics/logs/audit + 外接 eval 平台；我们的"可观测"= 全量原文 capture
  + 本地可复现 eval 阶梯。两者不是同一层级。

---

## C. 它面向谁

### C.1 企业多租户控制面（明确）

- [官方+代码] `docs/docs/architecture/multitenancy.md`、`docs/docs/manage/rbac.md`、上游 AGENTS.md 的
  "two-layer security model"（Layer 1 token scoping 控制可见性，Layer 2 RBAC 控制动作）；内置角色
  `platform_admin` / `team_admin` / `developer` / `viewer`；SSO 支持 GitHub/Google/Entra/Verify/Okta/Keycloak/
  generic OIDC；UAID 跨网关路由需要域名白名单，fail-closed。
- [官方] README:475-481 "Enterprise Features: HPA, Postgres, OTel, RBAC, HA, Grafana"；
  `selecting-an-mcp-gateway.md:70` 自述 "production-hardened through deployment in financial services,
  healthcare, and government contexts"（**自述，未验证**）。
- **使用者画像**：平台团队 / 运维 / 安全合规；一个 gateway 服务多个团队、多个租户、多集群。

### C.2 Web 客户端单用户？——不是

- [代码] `docs/docs/using/clients/index.md:15-24` 的兼容客户端表只有：
  **Claude Desktop（经 fastmcp-remote 桥接）、Cline、Continue、MCP Inspector**；同页 :11 明确
  "There are two ways clients typically connect: **Direct to Gateway (HTTP/SSE/WS)**"——完全没有浏览器侧
  Connected Apps / Custom Connectors 章节。
- [代码] `docs/docs/using/clients/claude-desktop.md:3-46`：Claude Desktop 只能起 stdio 子进程，需
  `fastmcp-remote` 桥接到 Streamable HTTP。
- [未验证] 全仓 `gemini`/`chatgpt`/`claude web`/`connected apps`/`remote MCP connector` 检索命中均为
  LLM **provider** 配置（OpenAI/Anthropic/Vertex 作为被代理的模型）、Google Cloud 部署、Google SSO、
  GitHub Copilot MCP server 示例，**没有一条是"Gemini web / ChatGPT web / Claude.ai 网页连接器接入指南"**。
- **OAuth 方向相反** [代码+官方]：它的 DCR/CIMD/PKCE/token-exchange 是**作为 OAuth client 连接上游受保护
  MCP server**（`docs/docs/manage/dcr.md`、`oauth-design.md`、`config.py`），并明确 "MCP 2026-07-28 deprecates
  RFC 7591 DCR… CIMD preferred"（dcr.md:3-13）；我们实现的是**作为 OAuth 2.1 Authorization Server**
  让 Gemini web 自定义应用来注册（README:77-79, 188-191）。两者都叫 DCR，但**角色不同**，
  不能据此说"它支持网页客户端"。

### C.3 对 Gemini / ChatGPT / Claude web 的实际支持结论

| 客户端 | 证据 | 结论 |
|---|---|---|
| Gemini web Connected Apps | 仓库内无接入文档；上游的 Google 相关内容全是 SSO/Cloud Run/Vertex provider | **[未验证]，无一手支持证据** |
| ChatGPT web connectors | 无接入文档；OpenAI 仅作为 A2A agent / LLM provider / moderation 示例 | **[未验证]** |
| Claude.ai 网页连接器 | 有 Claude **Desktop** 文档（需 fastmcp-remote），无 claude.ai 文档 | **[未验证]** |
| 通用 MCP client（Inspector/Cline/Continue） | 有一手文档 | **支持**，但属于桌面/IDE 工具链 |

---

## D. 逐项对比矩阵

> 我们的列基于本仓库 `README.md`、`src/codemode.js`、`src/capture.js`、`src/oauth.js`、
> `docs/OBSERVABILITY-AND-EVAL.md`、`docs/ledger/`。ContextForge 列基于上文 A/B/C 的证据。

| 维度 | ContextForge（证据） | 我们 gemini-mcp-gateway（证据） | 谁赢 / 说明 |
|---|---|---|---|
| **上下文压缩对象** | 压缩**工具结果**（TOON，`tool_post_invoke`，默认 disabled，`plugins/toon_encoder/toon_encoder.py:119`；`plugins/config.yaml:1246`）。`tools/list` 全量给出。 | 压缩**工具定义**：506 tools ≈245,377 tokens → 3 tools ≈1,520 tokens（-99.4%，README:11-14；`scripts/measure-context.mjs`）；结果在沙箱内投影/截断。 | **我们赢**：模型上下文的恒定开销才是 web 客户端瓶颈；它压的是结果文本，定义仍占满。 |
| **工具发现** | 管理向关键词 `GET /v1/search`（`routers/search.py`）；virtual server 静态分组；语义搜索在 roadmap（`selecting-an-mcp-gateway.md:507-515`）。MCP `tools/list` 分页但不按需。 | `search(query, limit?)` BM25 + identifier-aware + `select:<name>` 拉完整 schema（`README.md:72-73`、`src/catalog.js`、`src/codemode.js`）；实测 top1 56.5%/top5 72.3%（191 英文任务）。 | **我们赢**（运行时模型侧发现）；它赢管理面跨实体检索。 |
| **代码编排** | 无 Code Mode、无 guest 代码执行工具（B.3）。 | `execute_read` / `execute` 写 JS，QuickJS worker-thread（`run` SDK），guest 无 process/require/fetch；`safeAll()`、`fetchAllPages`、分页/补丁助手（`src/codemode.js:126,257,935`）。 | **我们明确赢**。 |
| **读写分离** | 无；annotations 原样透传。 | `execute_read` 中写工具被替换为抛错 stub（`src/codemode.js:895,935-948`）；读去重、截断标志不可写。 | **我们赢**，且是 web 客户端审批 UX 的关键。 |
| **写语义** | 网关资源写入的工程化语义强：202/Retry-After/name 去重/幂等 DELETE/409（`api-usage.md:364-418`）；工具调用本身仍依赖上游 hint。 | 有真实写 ledger、原子 11 文件 push、dryRun applyFilePatch、CAS fencing、重放验证（`docs/ledger/`、`src/codemode.js:54`）；无 202/异步生命周期（我们的执行是同步单次）。 | **各有胜负**：它赢"管理 API 生命周期"，我们赢"模型驱动的真实写路径验证"。 |
| **capture / eval** | OTel/Phoenix/Langfuse traces + audit tables；eval 由外部平台做；无自带 scorecard（B.5）。 | 全量 capture（HTTP/MCP/上游帧/sandbox/OAuth）→ R2，`docs/OBSERVABILITY-AND-EVAL.md`；L0 364 tests → L1 smoke → L2 G6 228 任务 scorecard（`COMPETITORS.md:101-104`）。 | **我们赢**（面向自身质量的 eval 闭环）；它赢"企业级可观测生态"。 |
| **Web 客户端** | Claude Desktop/Cline/Continue/Inspector；无 web connector 文档（C.2）。 | Gemini web custom app 实测（README:188-191）；Claude/ChatGPT 未验证但有 `docs/CLIENTS.md` 矩阵。 | **我们赢**（Gemini 一手实测）。 |
| **部署** | PyPI/Docker/Podman/Compose(PG+Redis+3 replicas)/Helm/K8s/OpenShift/多云/airgap；arm64 生产不支持。 | Node ≥20.19；`npm start` 本地；Vercel serverless 已上线（README:180-184, 93-106）。 | **它赢**（生产部署矩阵）；我们赢轻量（零 DB、零 Redis）。 |
| **单用户/多租户** | 多租户 + RBAC + token scoping + SSO + 团队/个人team（`multitenancy.md`、`rbac.md`）。 | 明确 single-user/self-hosted；不共享部署（README:20-22, 220-225, 259）。 | **定位不同，不算输赢**。不要追平。 |
| **可移植性** | Python 包袱：Python 3.12+、45 核心依赖、PG/Redis/K8s；镜像需 CI 产出 wheel closure 才能本地 build（README:340）。 | Node/TS，配置一个 JSON + env 即可换上游，Vercel/本地双形态；MIT。 | **我们赢**（个人可移植）；它赢（企业可移植）。 |
| **维护成本** | 22 万行 py / 891 测试文件 / 992 open issues / 月更 release —— 企业级投入。 | 约 19 个 src js、364 测试、单人维护。 | **我们赢**（可持续）；它是体量换功能。 |
| **License** | Apache-2.0 | MIT | 都宽松；无风险。 |
| **协议覆盖** | MCP + A2A + REST/gRPC + LLM proxy；多传输、联邦。 | MCP Streamable HTTP + 上游 HTTP/stdio；无 A2A、无 REST→MCP。 | **它赢**（广度）。 |

---

## E. 威胁评估

### E.1 哪些场景它明显赢

1. **企业内把 200 个内部 MCP/REST/gRPC/A2A 系统统一治理**：registry、virtual server、per-user OAuth token、
   RBAC/SSO、审计、OTel、K8s HA——我们没有对应物，也不该有。
2. **需要 SSO/团队隔离/合规（FedRAMP/FIPS 相关配置、airgapped、multi-arch）** 的采购场景。
3. **需要跨网关联邦（UAID）、多集群 Redis 缓存** 的部署。
4. **"MCP gateway + context optimization" 搜索入口**：它 4.9k★、README 明写 TOON compression 和
   "Optimizes Agent & Tool calling"，会先被搜到——**叙事威胁 > 功能威胁**。

### E.2 哪些场景我们明显赢

1. **Gemini 网页版用户**：3 个稳定工具、-99.4% 定义 token、DCR+PKCE 授权服务器、schema sanitize、双下划线命名、
   文本 JSON 结果——全是它文档里没有的 web 客户端实战细节。
2. **需要运行时按需发现 + 代码编排**：`search` → `execute_read/execute`，它只有静态 virtual server 分组。
3. **需要只读硬隔离**：`execute_read` 写工具 stub，而非靠 `readOnlyHint` 提示。
4. **需要证据链/评测**：全量 capture + 可复现 eval；它把 eval 外包给 Phoenix/Langfuse。
5. **轻量自托管**：无 DB/Redis/K8s，Node 一行启动，Vercel 一键上线。

### E.3 会不会直接吃掉我们的开源用户

- **结论：低概率直接吃掉；中等概率造成叙事混淆。** 理由：
  - 用户画像不重叠：它要"平台管理员部署一套系统"，我们要"一个人把自己的 Gemini 接上工具"。
  - 它默认给客户端全量工具定义，正好是我们诊断的痛点（README:28-31）；即便启用 TOON 也只压结果，
    **不会让 Gemini web 的 function declarations 变小**。
  - 它没有 web connector 文档；一个 Gemini web 用户照它的 README 走不到可用状态。
  - 但若用户只搜"MCP gateway TOON context optimization"，会先读到它的 30–70% 声明；
    **我们必须在 README/对比文档里显式区分"压结果 vs 压定义"**（本报告 B.1 可直接引用）。

### E.4 最该抄 / 最不该抄

**最该抄（思想级，轻量实现）：**
1. **virtual server 的场景化裁剪**：允许一个配置里定义"profile"，只把某组工具暴露给某客户端——我们可用
   `config.json profiles:` 实现，不动工具列表稳定性（换 profile 用换端点而非中途改 tools/list）。
2. **`GET /v1/search` 式统一检索 API** 的思路：把 `search` 的索引做成可查询端点，方便调试与未来客户端复用。
3. **tool preview dry-run**：`POST /tools/preview/{name}` + `preview_safe` 标记——我们可以在 sandbox 里做
   "只展开工具、不执行"的预览，帮助模型写对参数（不引入插件框架）。
4. **写幂等/生命周期语义**：对我们的 `execute` 加 `executionId` + 重复提交返回同一结果/冲突提示，
   以及明确的"写后轮询"指引（不需 202/后台 worker，保持同步即可）。
5. **CEL/jq/regex 那种"策略在 fork 子进程里跑"的思路**：如果我们未来允许模型提供过滤表达式，沿用
   "默认 fork、限时、fail-closed"的安全姿态（我们的 QuickJS 已隔离，但策略表达式是另一面）。

**最不该抄：**
1. 企业控制面 / 多租户 / RBAC / SSO 全家桶——直接毁掉 single-user 定位与维护成本优势。
2. 40+ 插件框架 + cpex 外部依赖——引入部署复杂度；我们用 config + 上游适配即可。
3. PostgreSQL/Redis/Helm/K8s/A2A/LLM proxy——与 web 单用户无关。
4. **TOON 作为主差异化**：它压结果且默认关闭，我们已在沙箱里做结果投影/结构化截断；再引入一种
   上游格式只会增加 Gemini schema/结果兼容性风险（参见 AGENTS.md：Gemini 不吃 structuredContent）。
5. 跟着它把 `tools/list` 做成动态通知——Gemini 不消费 `notifications/tools/list_changed`（AGENTS.md 硬规则）。

### E.5 一句话定位建议（可直接放 README / 策略）

> **We are the thin, verifiable layer for one web-client user; ContextForge is the thick control plane for an
> enterprise tool estate.** It compresses tool *results* behind RBAC, Redis and Kubernetes; we compress tool
> *definitions* into three stable tools, orchestrate calls in a QuickJS sandbox, and prove quality with
> full-fidelity captures and offline evals.

中文版：
> **我们做"一个网页用户身边的小而可验证的层"，它做"企业工具资产的大而全控制面"。
> 它压结果、管租户；我们压定义、分读写、留全量证据。**

---

## F. 可验证的差距清单（P0 / P1 / P2）

> 目标：如果我们要和 ContextForge 在同一批用户里竞争，需要补什么。每条都有**可验证的完成条件**，
> 不做"加强可观测性"这种泛泛表述。本文不改代码，以下是给 lead 的 backlog 输入。

### P0（直接影响"同题对比"能否站住）

1. **README 增加"ContextForge vs us"对比段**，明确三句话：它压结果、我们压定义；它全量列工具、我们 3 工具；
   它没有 Code Mode/web connector 文档。完成条件：README 有指向本文的链接；`docs/OPEN-SOURCE/COMPETITORS.md`
   中 ContextForge 行从"一句带过"改为引用本文；F 中每条都能在 README/策略里找到对应表述。
2. **补齐"工具定义压缩"的可复现数字的可信度**：`scripts/measure-context.mjs` 的输出固化成带日期的 fixture
   （当前 README:11-14 的 245,377→1,520 已有脚本，但需注明 catalog 快照版本）。完成条件：任意人
   `node scripts/measure-context.mjs` 得到的 token 数与 README 差异 <1%，或 README 标注重算命令与日期。
3. **写路径幂等/重放的产品化说明**：把 `docs/ledger/batch-10-idempotent.md` 的结论变成一个用户可见的
   `execute` 使用模式（如 `executionId` + 重复提交提示）。完成条件：`docs/CLIENTS.md` 或 README 有
   "write semantics" 小节，且有一个 offline 测试覆盖重复提交不产生双写（fake upstream）。
4. **Web 客户端事实矩阵更新**：ContextForge 无 web connector 文档这一事实写进 `docs/CLIENTS.md`，
   避免销售/用户误以为"MCP 通用即 web 通用"。完成条件：`docs/CLIENTS.md` 有 ContextForge 一行，标
   "Claude Desktop/Cline/Continue/Inspector only; no web connector docs as of 2026-11-23"。

### P1（补齐"企业用户也在看"的 table stakes，但不越界）

1. **场景化工具 profile（抄 virtual server 的思想，轻量版）**：完成条件：新增配置字段如 `profiles:`，
   两个 profile 各自 `allowTools`，用不同端点暴露；有测试证明 profile A 的 `search` 看不到 profile B 的工具；
   工具名/数量在每个端点内稳定（不违反 AGENTS.md）。
2. **tool preview 元工具或脚本**：完成条件：给定工具名和 args，返回"该调用会映射到哪个上游工具 + 参数
   校验结果"，不产生任何上游写；有 offline 测试与至少一个 fake write tool 的 "preview 不写"断言。
3. **`GET /v1/search` 式检索端点（仅本地/inspect）**：完成条件：返回与 `search()` 相同的 top-k 结果，
   与 README 的 recall 数字来自同一索引；不对外开放未授权访问（沿用 OAuth/单用户约束）。
4. **ChatGPT web / Claude web 连接器验证**：完成条件：`docs/CLIENTS.md` 更新为实测状态或明确
   "未验证 + 所需 plan/权限"，不写虚假支持声明（延续 COMPETITORS.md:141 的诚实性规则）。

### P2（可观测/生态的加分项）

1. **capture 的 schema 化导出**：把全量 capture 转成结构化索引（可query），对标它的 audit tables，但保持
   "原文 + 索引分离"。完成条件：`docs/OBSERVABILITY-AND-EVAL.md` 有字段表；有一个脚本按 requestId 取回原文。
2. **结果压缩策略可切换**：在沙箱内实现"结构化投影 / 行式截断 / 可选列式编码"三档，并对同一 capture
   给出 token 数对比（**只作为结果侧实验，不替代工具定义压缩**）。完成条件：离线脚本输出三档 token 数，
   且默认档不变、不引入 Gemini 不兼容的 structuredContent。
3. **定期快照竞品指标**：每季度重跑 `gh repo view IBM/mcp-context-forge` + release list，更新本文头部快照，
   并 check 其是否新增 code mode / web connector 文档（这才是真正需要我们警觉的信号）。完成条件：本文
   更新记录 + 一处 `docs/OPEN-SOURCE/COMPETITORS.md` 交叉引用。

---

## G. 引用清单

> 本地路径均相对 `work/ibm-contextforge/`（本次 shallow clone，commit `14a4c4a6`，
> `git clone --depth 1 https://github.com/IBM/mcp-context-forge.git`），
> 外部 URL 均为本次抓取的一手来源。凡标 [官方] 的是上游自述，标 [代码] 的是本地可核验事实。

### 仓库与快照
- 仓库：<https://github.com/IBM/mcp-context-forge>；`gh repo view IBM/mcp-context-forge --json …`
  （2026-11-23：4,875★ / 982 forks / 992 open issues / Apache-2.0 / push 2026-11-21）。
- Releases：<https://github.com/IBM/mcp-context-forge/releases>；
  v1.1.1 <https://github.com/IBM/mcp-context-forge/releases/tag/v1.1.1>（2026-11-10，72 PR）。
- 最近提交：`14a4c4a6` "Security hardening (#7633)"，2026-11-20T15:14:12Z（`gh api repos/.../commits`）。
- 本地规模统计：`mcpgateway/` 442 py / ~223,717 行；`tests/` 891 `test_*.py`；`plugins/` 41 目录；
  `docs/docs/` 288 md（本次 `Get-ChildItem` 统计）。

### 一手文档（上游）
- README：`README.md:3,20-28`（定位）、:73-82（能力）、:94（协议版本）、:121-127（registries）、
  :136/926（7,000+ tests 自述）、:309-322（virtual server 示例）、:336-342（arm64/compose 构建注意）、
  :344-386（compose 依赖）、:408-427（Web UI）、:429-482（Helm/Enterprise）、:932-936（untrusted MCP 警告）、
  :993-995（Apache-2.0）。
- `pyproject.toml:29-110`（name/version 1.1.1/依赖/Python 版本/license）。
- `Containerfile:1-40`（UBI10-minimal / multi-arch）。
- `docs/docs/architecture/index.md:3-19,29-149`（架构、Rust 移除、技术栈、virtual server、RBAC）。
- `docs/docs/overview/ui-concepts.md:28-37`（virtual server 定义）。
- `docs/docs/using/clients/index.md:3-41`（客户端列表）；`clients/claude-desktop.md:3-46`（stdio 桥接）。
- `docs/docs/best-practices/selecting-an-mcp-gateway.md:470-516`（roadmap：semantic tool search）、
  :539-577（部署/沙箱 roadmap）、:677-687（社区数据自述）。
- `docs/docs/architecture/security-features.md:180-211`（🚧 sandboxed execution + aspirational 声明）。
- `docs/docs/architecture/tool-invocation-and-validation.md:1-140`（输入/输出校验三层）。
- `docs/docs/manage/api-usage.md:364-418`（异步写生命周期/幂等/重试）；:738（annotations 透传示例）。
- `docs/docs/manage/dcr.md:1-13,47-58`（DCR/CIMD，作为上游 OAuth client）。
- `docs/docs/manage/oauth.md:198-206`、`docs/docs/architecture/oauth-design.md:26-43`（OAuth 方向）。
- `docs/docs/manage/rbac.md`、`docs/docs/architecture/multitenancy.md`（多租户/RBAC）。
- `docs/docs/manage/observability/langfuse.md:11,235`、`phoenix.md:139-155`（外部 eval）。
- `docs/docs/manage/securing.md:719-814`（CEL/jq/regex 子进程沙箱）。

### 源码与配置（上游，本地可核验）
- `plugins/toon_encoder/toon_encoder.py:11-12,56-67,101-106,119-208,210-224,226-304`
  （TOON 作用点=tool_post_invoke、结果 text JSON、阈值、仅当更小、annotations）。
- `plugins/toon_encoder/toon.py:6-11,1229-1257`（TOON spec v3.0 / token savings 估算函数）。
- `plugins/config.yaml:571-594`（OutputLengthGuard 默认 disabled）、:1238-1260（ToonEncoder 默认 disabled）。
- `plugins/AGENTS.md`（hook 生命周期、preview_safe、框架为 cpex）。
- `mcpgateway/routers/search.py:1-105`（`GET /v1/search` 关键词跨实体检索）。
- `mcpgateway/transports/streamablehttp_transport.py:373,3072-3174,4139-4148,4929`
  （tools/list / paginated v2 handler / list_changed）。
- `mcpgateway/routers/oauth_router.py:1756-1853`（OAuth status batch）。
- `mcpgateway/config.py:1333,1500-1504`（bulk import max / 传输层压缩而非 token 压缩）。
- `mcpgateway/middleware/compression.py:8-27`（Brotli/Zstd/GZip，SSE 跳过；**非 token 层压缩**）。

### 我们项目（一手）
- `README.md:7-22,26-31,64-91,93-106,180-194,196-218,220-225,257-271`：定位、3 工具、99.4%、
  Gemini 实测、single-user、评测数字、已知限制。
- `src/codemode.js:5,54,126,257,416,807,895,900-948,1050,1291-1326`：
  search/execute/execute_read、safeAll、读去重、写工具 stub、工具描述注入。
- `src/capture.js`、`docs/OBSERVABILITY-AND-EVAL.md`：全量 capture 与 eval 设计。
- `docs/OPEN-SOURCE/COMPETITORS.md:30,45,101-104,141`：ContextForge 现有简述与差异化规则。
- `docs/eval/`、`docs/ledger/`、`bench/README.md`：G6 scorecard、写语义 ledger、model-in-loop harness。
- `AGENTS.md`：Gemini 工具名双下划线、schema sanitize、稳定工具列表、不消费 list_changed 等硬约束。

### 方法说明
- 未执行上游服务/测试；未修改上游 clone；本文是本任务唯一新增文件；未 commit/push/deploy。
- 所有"未验证"项均因缺少一手文档/代码证据，不代表功能不存在；后续如拿到证据应升级结论。
