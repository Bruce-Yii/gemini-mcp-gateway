# agentgateway 深度核验报告（agentgateway/agentgateway）

- 核验日期：2026-11-23（Asia/Singapore）
- 核验方式：`gh auth status`（Bruce-Yii，scopes 含 repo）→ `gh repo view --json ...` / `gh api`（repo/releases/issues/search/issues/search/commits）→ `gh repo clone agentgateway/agentgateway work/deep-agentgateway -- --depth=1` → 通读 README、architecture/、Cargo crate 源码（`crates/agentgateway/src/mcp/`、`config_store.rs`、`cel/`、`http/`、`telemetry/`，`crates/llm/src/`）+ GitHub issue/PR 原文。
- 证据标记：**[代码]**（源码/测试数据，带路径:行号）、**[文档]**（README/架构文档/CLI 输出原文）、**[未验证]**（无证据或需外部条件）。
- 范围约束：只新增本文件；未改 src/、scripts/、tests/、README、其他 docs、workflows；未 commit/push/deploy。上游 clone 位于 `work/deep-agentgateway`（clone HEAD `888badbbe91f2a57ec8e7bf5a5ef3acda34b1fe5`，depth=1）。

## 1. 仓库画像（真·上游基础设施级项目）

| 项 | 结论 | 证据 |
|---|---|---|
| Stars / Forks / Watchers / Open issues | 6359 / 1124 / 50 / 356 | [文档] `gh repo view --json stargazerCount,forkCount`=6359/1124；`gh api repos/...`=`subscribers_count:50, open_issues_count:356` |
| License / 归属 | Apache-2.0，Linux Foundation 项目 | [文档] `gh repo view --json licenseInfo`=`apache-2.0`；[文档] `work/deep-agentgateway/README.md:129-132`（LF logo）；`LICENSE` 文件存在 |
| 创建 / 最后推送 | 2025-03-18 / 2026-11-22（即核验前一天） | [文档] `gh repo view --json createdAt,pushedAt` |
| 活跃度 | 近 3 个月合并 PR ≥843 个 | [文档] `gh api -X GET search/commits` / `search/issues -f q='repo:... is:pr is:merged merged:>2026-08-23'`=843 |
| 语言 / 定位 | Rust 主；"Next Generation Agentic Proxy for AI Agents and MCP servers" | [文档] `gh repo view --json primaryLanguage,description`；README:32 |
| 最新 release | v1.7.0，2026-10-27（非 prerelease）；Docker/Helm 镜像齐全 | [文档] `gh api repos/.../releases/latest`：`tag_name:v1.7.0`，`html_url: https://github.com/agentgateway/agentgateway/releases/tag/v1.7.0`；release body 列出 `cr.agentgateway.dev/agentgateway:v1.7.0`、`controller:v1.7.0`、Helm charts |
| 文档站 | agentgateway.dev/docs/standalone/latest 与 /docs/kubernetes/latest 双线 | [文档] `README.md:71-82` |

**判定**：这是 Envoy/IPV 血统的活跃上游基础设施项目（Cilium/Solo.io 生态），不是玩具。[代码]+[文档]

## 2. 重点核验结论（逐条给证据）

### 2.1 Progressive disclosure / toolMode Search：**当前主线不存在，且被维护者明确拒绝**

这是本报告最重要的发现，直接决定威胁等级。

1. **[代码] 当前源码（HEAD `888badba`）全仓无 `toolMode` / `tool_mode` / `ToolMode` / `progressive` / `run_code` / `code_mode` 实现**。全仓 grep（`*.rs` 及所有文本）仅命中：
   - `crates/llm/src/types/completions.rs:1440`（OpenAI web_search 工具描述）、`crates/agentgateway/src/telemetry/log_store.rs:88,157,337,470`（**日志搜索**的 `SearchRequest`）、`crates/agentgateway/src/ui.rs:1248`（日志搜索 API）、`crates/llm/src/types/responses.rs:476-479,582`（Anthropic/Responses API 的 server-side `ToolSearch` 输出类型，属于**上游 provider 的透传**，不是 gateway 自己的两工具模式）。
   - README 全文（132 行）无 "progressive disclosure" / "Search mode" / "code mode" 字样（[文档] `README.md:50-69` 的 Key Features 只有 LLM/MCP/A2A/Inference/Guardrails/Security&Observability）。
2. **[文档] 需求仍然存在但状态是 OPEN**：issue [#1239 "Feature Request: Progressive disclosure"](https://github.com/agentgateway/agentgateway/issues/1239) 创建于 2026-03-16、至今 OPEN、0 条评论，原文："State of the art for MCP is to only expose query and activate tools with tiny token load and hide the federated mcp tools until needed. I could not find any obvious way to accomplish this without wrapping all mcp tools in another service..."（`gh api repos/.../issues/1239`）。
3. **[文档] 曾有人提交与本项目几乎同构的 PR，被 maintainers 关闭且明确拒绝**：[PR #3859 "mcp: opt-in lazy tool exposure via mcp_search/mcp_call"](https://github.com/agentgateway/agentgateway/pull/3859)，2026-10-08 创建、2026-10-12 关闭、`merged:false`、7 commits/11 files。PR 描述的数字与我们的优化轴完全一致：126 tools ≈ 63,083 tokens/request → 2 tools ≈ 194 tokens（−99.7%），设计 `mcp.lazyTools: true` + `mcp_search {query,limit?}` + `mcp_call {name,arguments}`，含 search ranking、RBAC 透传、stateless/per-backend。维护者 howardjohn 的拒答原文：**"I don't think this is a good fit for the project... This introduces completely new functionality where we are exposing essentially a completely bespoke MCP server inside of Agentgateway itself. This is something that could be built on top of instead of inside of Agentgateway... harnesses natively doing similar things and providers natively allowing 'deferred' tools; both of these are places that can actually better implement this as they have better context and controls compared to a proxy."**（`gh api repos/.../issues/3859/comments`）→ 这是上游官方立场：**该功能应由 harness/模型 provider 做，而不是 proxy**。这一点恰好是我们项目存在的理由，可直接写进我们的差异化叙事。
4. **[未验证] Solo.io 曾写过 "MCP progressive disclosure with agentgateway Search mode" 的 blog**，但本轮未在仓库内找到对应实现或文档（issue [#1950](https://github.com/agentgateway/agentgateway/issues/1950) 2026-05-24 提到该 write-up，2026-08-27 关闭、0 评论）；可能指 provider 原生 deferred tools 或已下线特性。不要把它当成 agentgateway 现存能力引用。
5. **有没有压缩工具定义？** [代码] 没有"定义压缩/摘要化"逻辑。`tools/list` 路径是 merge/fan-out：`crates/agentgateway/src/mcp/handler.rs:1204-1244`（fanout-wide guardrail hook）、`crates/agentgateway/src/mcp/handler.rs:2222-2244`（cache policy）、`crates/agentgateway/src/mcp/router.rs:118-133`。唯一"改变工具表面"的能力是：
   - CEL RBAC `mcpAuthorization` 在 `tools/list` 上**过滤**工具：`crates/agentgateway/src/mcp/rbac.rs:53-63,265-273`；测试 `crates/agentgateway/src/mcp/mcp_tests.rs:4042-4065`（"deny policy targeting a specific tool filters only that tool from list_tools"）、`mcp_tests.rs:9128-9185`（`mcpGuardrails.tier == "free"` 元数据驱动 list 过滤）。
   - mcpGuardrails 的 CEL response transform 可以改写 `tools/list` 结果：`crates/agentgateway/src/mcp/guardrails/expression.rs:242-271`，表达式 `mcp.result.with(r, r.merge({"tools": r.tools.filter(t, !t.name.startsWith("internal_"))}))`。这是**按名字过滤**，不是按 token 预算压缩 schema；schema 原样透传。
   - `prefixMode: always|conditional|never` 只处理命名/路由：`crates/agentgateway/src/types/agent.rs:1943-1955`，`crates/agentgateway/src/mcp/mod.rs:854-904`。
   - [代码] `mcp_call` 字面量只出现在 `crates/llm/src/types/responses.rs:149-151`（OpenAI Responses API 的 built-in mcp_call 结果字段遍历），与本项目的 `gateway_call` 无关。
6. **有没有 Code Mode / run_code / 沙箱边界？** [代码] **没有**。唯一与"沙箱"沾边的是：
   - stdio 上游 = 网关本机直接 spawn 子进程（`crates/agentgateway/src/mcp/upstream/stdio.rs:276-292` 用 `rmcp::transport::TokioChildProcess`；`crates/agentgateway/src/mcp/upstream/mod.rs:733-762` 构造 `McpStdio(Process::new(proc))`）——**没有 OS 容器/命名空间/权限降级**；且 `crates/agentgateway/src/types/local.rs:1863` 明确 stdio target 不支持 policies（"policies are not supported (stdio has no backend connection)"），测试 `local_tests.rs:1714-1726`。
   - 动态后端的 SSRF 边界：`crates/agentgateway/src/lib.rs:331-335,387`（`allow_dynamic_loopback` 默认 false）、`crates/agentgateway/src/client/mod.rs:567-576,694-695,763-778`（DNS 解析后拒绝 loopback/link-local/unspecified）、`crates/agentgateway/src/client/callout.rs:80-82`（callout 永不触达 loopback/link-local）。这是**网络层**防护，不是代码执行沙箱。
   - v1.7.0 release note 也确认 "dynamic backends can no longer reach loopback or link-local addresses"（[文档] release body）。
   - 结论：**没有 JS/Python 执行环境，没有 `execute`/`execute_read` 等价物，没有在我们的 QuickJS 意义上"模型在沙箱内编排多个工具调用"**。[代码]+[文档]

### 2.2 协议支持：MCP Streamable HTTP / stdio / OpenAPI→MCP **全都支持，且是生产级实现**

1. **[代码] Streamable HTTP**：`crates/agentgateway/src/mcp/upstream/streamablehttp.rs:65-149`（POST 返回 `Accepted`/`Json`/`Sse(event_stream, session_id)`，处理 session id）、`crates/agentgateway/src/mcp/streamablehttp.rs`（`StreamableHttpService`）、`crates/agentgateway/src/mcp/router.rs:202`（`StreamableHttpService::new(...)`）、客户端侧 `crates/agentgateway/src/mcp/mcp_tests.rs:1337`（stateless vnext tools/list 上游测试）。配置类型 `StreamableHTTPTargetSpec`：`crates/agentgateway/src/types/agent.rs:2110`。此外 README:55-56 明确列 stdio/HTTP/SSE/Streamable HTTP。
2. **[代码] stdio**：`crates/agentgateway/src/mcp/upstream/stdio.rs:21-48,265-292`（进程生命周期、pending request map、事件流；`get_event_stream()` 注释 79-82 明确单订阅者限制）；类型 `McpTargetSpec::McpStdio`：`crates/agentgateway/src/types/agent.rs:2078`；配置解析 `crates/agentgateway/src/types/local.rs:1850-1874`（stdio target 拒绝 policies）。
3. **[代码] OpenAPI→MCP**：`crates/agentgateway/src/mcp/upstream/openapi/mod.rs:256-355`（`parse_openapi_schema`：遍历 paths/methods，要求 `operation_id`，构造 `inputSchema`，合并 path/op 参数，body `$ref` 解析）；`crates/agentgateway/src/types/agent.rs:2088-2089,2116-2120`（`OpenAPITarget { schema: Arc<OpenAPI> }`）；`crates/agentgateway/src/types/local.rs:1874-1894,2203-2206`（local config 的 `openapi` target，支持 URL/文件加载 schema）；`crates/agentgateway/src/mcp/upstream/openapi/tests.rs:1108-1140+`（大量 schema 解析单测，含 recursive component bundling、header 覆盖、content-type 处理）；`openapi/mod.rs:877`（"Only allow headers defined in the OpenAPI schema"）。
4. **[代码] 联邦/聚合**：`McpBackend{prefix_mode, failure_mode, ...}`：`crates/agentgateway/src/types/agent.rs:1957-1967`；fanout 与缓存策略 `handler.rs:2222-2244`（`ttl_ms=0, cache_scope=Private`，注释明确"routing config, backend membership, and authz filtering can change without a client invalidation path"——防 authz 结果被共享缓存污染）。
5. **[文档] A2A / LLM Gateway 也在同一进程**：README:52-68；`crates/llm/src/` 全量 provider 转换（Gemini/Vertex/Anthropic/Bedrock/OpenAI/Copilot），`crates/llm/src/conversion/vertex_gemini.rs:763-797,1045-1095` 等有大量 Gemini schema 收敛逻辑。

### 2.3 认证 / 多租户 / 部署形态

1. **[代码] 认证矩阵**：`crates/agentgateway/src/types/local.rs:2779-2806,3195-3205`（JWT/OIDC/basicAuth/apiKey/externalAuthz），`local.rs:5694-5924`（编译期校验，OIDC 需要 `OIDC_COOKIE_SECRET`）；MCP 专用 OAuth 在 `crates/agentgateway/src/mcp/auth.rs`：
   - `auth.rs:21-26`：暴露 `/.well-known/oauth-protected-resource`、`/.well-known/oauth-authorization-server`（RFC 9728/8414）；
   - `auth.rs:28-60`：MCP 后端 JWT 校验（permissive 模式允许上游 JWT policy 剥离 token，但会告警）；
   - `auth.rs:76-130`：DCR `client-registration`、Entra 的 authorize/token 代理（因 Entra 拒绝 RFC 8707 `resource` 参数）。
   - `auth.rs:368`：从 issuer 的 tenant 段派生 v2.0 metadata URL（多 IdP tenant 支持）。
2. **[代码] 多租户/细粒度授权**：`crates/agentgateway/src/mcp/rbac.rs:13-63,70-117`（CEL `mcp.tool.name` / `jwt.sub` / `mcp.methodName` / `mcp.params._meta.tenant`；资源类型 Tool/Prompt/Resource/**Task**）；`mcp/rbac.rs:237-273` 单测（JWT claim 匹配/不匹配/缺失、list vs call 区分）；`crates/agentgateway/src/http/localratelimit.rs:50`（CEL 选 bucket，注释明说 `jwt.sub` 可做 per-user 限流）；`crates/agentgateway/src/cel/types.rs:999-1007`（`AgentContext.session`，从 `x-claude-code-session-id` 等 header 识别 agent harness）；`mcp/guardrails/client.rs` 的 metadata 可被 authz/transformation 消费（`mcp_tests.rs:8996-9039,9724-9779`）。
3. **[代码] 部署形态**：两种——standalone 扁平 YAML + 文件 watch（`architecture/configuration.md:12-19`）、Kubernetes controller + xDS + Gateway API（`configuration.md:21-52`；`controller/` 目录）；配置写路径支持 SQLite/Postgres（`config_store.rs:345-378`）。README:73-82 给两个 quickstart 链接；v1.7.0 新增 `agctl standalone` CLI（[文档] release body）。内置 UI 支持 raw YAML 编辑（release body + `ui/`）。

### 2.4 是否有 Web client（Gemini/ChatGPT/Claude）适配证据

1. **[代码] 有"协议翻译层"适配，不是"Web client 适配"**：`crates/llm/src/` 完整支持 Anthropic Messages / OpenAI Completions & Responses / Gemini native `generateContent` / Vertex Gemini / Bedrock / Copilot 的双向转换。例：`crates/llm/src/conversion/vertex_gemini.rs:12,34-47,591-593,763-797`（Gemini thoughtSignature、schema 子集、role 交替）；`crates/llm/src/conversion/completions.rs:753`（"Claude Code uses this marker to compact and retry a rejected prompt"）；`crates/agentgateway/src/http/session.rs:47`（`x-claude-code-session-id`）；`crates/agentgateway/src/mcp/auth.rs:1521-1544` 的 DCR 测试用 `"client_name":"Claude Code"`——**这是 mock 测试数据，不是专门的 web client 适配**。
2. **[文档] 真正的 hosted web client（claude.ai / ChatGPT）支持仍是 OPEN issue**：[#4366 "Entra broker mode: support hosted MCP clients like claude.ai and ChatGPT"](https://github.com/agentgateway/agentgateway/issues/4366)，2026-11-10 创建、OPEN、0 评论。原文指出 `broker_safe_redirect` 只允许 loopback/自定义 scheme，而 claude.ai/ChatGPT 用 HTTPS callback；且 broker callback 不返回 `iss`，ChatGPT 会为每条连接使用不同 redirect URI，导致需要为每个 connector 单独登记 redirect URI。**截至核验日未实现**。[文档]
3. **[文档] 内置 UI 是运维控制台**（拓扑/配置/日志/analytics），不是面向终端用户的聊天 Web client：`README.md:83-87`（"built-in UI for you to explore agentgateway connecting agent-to-agent or agent-to-tool"）、`ui/src/api/logsApi.ts:25-26`、`ui/src/types.ts:177-236`（Analytics API 类型）。
4. **[未验证]** 官方是否在其他仓库/站点提供 ChatGPT/Gemini Web 连接器适配，本轮未发现证据。

**结论**：provider 协议适配强；**hosted Web client 专用适配 = 没有，且被公开列为未解决问题**。

### 2.5 任务级 eval / capture / scorecard？——**没有，只有 OTel/日志分析**

1. **[代码] 遥测主体是访问日志 + OTel + analytics 聚合**：`crates/agentgateway/src/telemetry/log_store.rs:104-108,337-349`（`analytics_summary`）、`log_store.rs:406-414,499-567,599-612,671-736`（token/cost/TTFT/cache-read/cache-write/reasoning token 汇总、按 model/user/dimension 分组）；SQLite/Postgres 后端 `telemetry/log_store/sqlite.rs:124-151`、`postgres.rs:63-90`；UI 类型 `ui/src/types.ts:177-236`。README:67-68 明说 "OpenTelemetry metrics/logs/tracing"。
2. **[代码] 没有任务级 eval 数据结构**：全仓 `eval`/`scorecard`/`capture` 搜索命中的是 CEL 的 `eval()`（表达式求值）、`xtask/src/cel.rs`（CEL 命令行求值）、`policy-core/src/expression.rs`（策略求值）、`cel/types_test.rs:182-197,434-476`（请求快照 round-trip 测试）、`crates/llm/src/golden_tests.rs`（**翻译层的 golden snapshot 测试**，不是 agent 任务效果评测）、以及 test helper 里的 `capture_headers`。没有"采集真实会话 → 按任务打分 → 产出 scorecard → 驱动改进"的闭环。
3. **[文档] issue #1950（privacy-safe receipts for Search mode progressive disclosure）被关闭且 0 评论**（`gh api ... issues/1950`），说明连"披露边界的审计收据"都未进入路线图。
4. **[代码] 日志有审计能力**（`mcp/mod.rs:602-604,730` 存 `tools_list` 终态、`telemetry/log.rs:382` mcpGuardrails 动态元数据），但这是**请求级日志**，不是任务级 eval。

**结论**：agentgateway 的可观测性是"流量/成本/延迟/策略决策"维度；**我们的 `docs/eval/scorecard-2026-11-22.md`、`capture-verification-2026-11-23.md`、`write-replay-2026-11-23.md` 这一套任务级证据链是它完全缺失的**。[代码]+[文档]

### 2.6 写入/写路径语义：无 dry-run，但有 CAS + 事务 + 幂等

1. **[代码] 配置写路径是带 generation 的 CAS**：
   - `crates/agentgateway/src/config_store.rs:84`（`ConfigResourceError::GenerationConflict { expected, found }`）；
   - `config_store.rs:352-400`（`upsert_prepared(..., expected_generation)`；空写也校验 generation 并返回当前值，不消耗 generation）；
   - `config_store.rs:1882-1941`（SQLite `BEGIN IMMEDIATE` + `UPDATE agw_config_meta SET generation = generation + 1 WHERE ... generation = ? RETURNING generation`；Postgres 同构；不匹配则 GenerationConflict）；
   - `config_store.rs:1943-1996`（单事务内批量 upsert，JSON 消键序后按 value_json 比较，`WriteResult::Unchanged` 不推进 revision，`tx.commit()` 一次性提交）；
   - 单测 `config_store.rs:2429-2483`（stale generation 被拒、并发写只有一个 commit）、`2487-2513`（unpinned 写也推进 generation）、`2570-2609`（空写/未命中 delete 不消耗 generation）、`2805-2836`（rename 原子）。
   - **[未验证] dry-run**：全仓 `dry.run|dry_run` 搜索无配置写相关的 dry-run 端点（只有测试 fixture 里的注释）。MCP `tools/call` 本身是透传，网关不提供写操作预演/幂等键注入。
2. **[代码] 安全写语义的正面样例**：`handler.rs:2227-2240` 把所有可缓存 MCP 响应强制 `ttl_ms=0, cache_scope=Private`，注释明确因为 authz 过滤会变化——这是"策略变更后不返回过期授权结果"的正确设计。
3. 对照我们：`src/codemode.js` 的 `codemode.applyFilePatch` 默认 `dryRun`、`codemode.writeFiles` 的 `atomic:true`（一次 push）、`codemode.ensureBranch` 幂等、`replaceLines/applyPatch` 拒绝 truncated 读取——我们的**工具级写路径**语义比它的**配置存储级写路径**更贴近 agent 任务；但它配置平面的 CAS 设计可借鉴到我们的配置/凭据更新流程。

## 3. 对照我们项目：同一优化轴 vs 相邻

对照基准（本项目现状，均来自已读源码/文档）：`src/codemode.js:5-12,797-1043,1262-1326`（`search` + `execute_read`/`execute` 三工具、QuickJS 沙箱、调用上限/结果截断）、`src/catalog.js:299-461`（searchEntries 排序）、`src/sanitize.js`（Gemini schema sanitize）、`src/oauth.js` + `src/vercel-app.js` + `api/index.js`（OAuth 2.1 DCR+PKCE 已上线）、`docs/eval/` 全套任务级 capture/scorecard。

### 3.1 同一优化轴（它和我们争的是"agent 的 token/工具表面"吗？）

**基本不是。** 它的核心优化轴是 **"代理/路由/治理"**：把多 provider LLM、MCP、A2A 流量汇到一个策略执行点，卖点是安全、可观测、路由、成本、Kubernetes 集成（README:52-69）。工具表面压缩这个轴它**主动让出**：PR #3859 被拒的 maintainer 原话就是"harnesses/providers 更适合做"。因此：

- 同轴的只有一小块：`tools/list` 的 CEL 过滤（`rbac.rs:53-63`、`guardrails/expression.rs:242-271`）和命名前缀（`prefixMode`）——都是**策略性裁剪**，不是按 token 预算压缩、不是检索排序、不是代码内编排。
- 我们的轴是 **"模型侧工具检索 + 沙箱内编排 + 任务级证据"**，它明确说这是 harness 的活。这是很好的战略站位证据，但也意味着**它不会成为我们在该轴上的直接竞品**。

### 3.2 相邻轴（值得关注的重叠）

- **协议/传输层**：它是生产级 MCP Streamable HTTP/stdio/OpenAPI→MCP 全栈；我们主要面对 Gemini function-calling + 已上线 OAuth。若未来我们要接任意 MCP server，它的 transport 实现是参考实现。
- **Gemini schema 兼容性**：它做了非常细的 Gemini JSON Schema 收敛（`crates/llm/src/conversion/vertex_gemini.rs:763-797,1045-1095`、`vertex_gemini_tests.rs:711-812,1057,1199,1238,1280`：`additionalProperties` 剥离、`oneOf→anyOf`、`const→enum`、数组必须 `items`、thinkingBudget/Level 按模型版本选择）。与我们的 `sanitize.js` 是**同一类问题、同方向优化**，是最值得抄的技术细节来源。
- **多租户授权**：它的 `mcpAuthorization` CEL + JWT claim + `_meta.tenant` 组合，与我们的 OAuth 2.1 DCR 是相邻层（我们偏"客户端接入鉴权"，它偏"后端工具级授权"）。
- **可观测性**：它是流量/成本维度，我们是任务/证据维度；互补而非竞争。

### 3.3 它赢 / 我们赢

| 维度 | 赢家 | 依据 |
|---|---|---|
| 项目成熟度、社区、license | **agentgateway** | 6359★/1124 fork/843 PR/季度、Apache-2.0、LF、v1.7.0 发布 [文档] |
| 协议广度（MCP/A2A/LLM/OpenAPI/Gateway API） | **agentgateway** | README:52-69 + `crates/` 全栈 [代码]+[文档] |
| 生产级策略引擎（CEL/RBAC/guardrails/OIDC） | **agentgateway** | `mcp/rbac.rs`、`mcp/guardrails/*`、`local.rs:5694-5924` [代码] |
| Gemini schema 兼容性细节 | **agentgateway（略胜）** | `vertex_gemini.rs` + 大量 golden tests，覆盖 Gemini 3/4 特性 [代码] |
| Progressive disclosure / toolMode Search | **我们（它明确不做）** | PR #3859 被拒 + issue #1239 OPEN [文档]；我们三工具已上线 [代码] |
| Code Mode / 沙箱内编排 | **我们（碾压）** | 它没有 run_code/execute；我们有 QuickJS + execute/execute_read + 调用上限 [代码] |
| 工具定义压缩/搜索排序 | **我们** | 它只按 CEL 过滤/改名，无 token-aware 压缩 [代码] |
| 任务级 eval/capture/scorecard | **我们（碾压）** | 它只有 OTel/analytics，无任务级闭环 [代码] |
| 写路径 dry-run/幂等/原子 | **我们（工具级更强）**；它配置级 CAS 更严谨 | `codemode.js:323,358,1262+` vs `config_store.rs:1882-1996` [代码] |
| Hosted Web client（ChatGPT/Claude/Gemini Web）适配 | **平手偏我们**（它 OPEN issue #4366；我们也有 docs/CLIENTS 但需自查真实覆盖） | [文档] |

### 3.4 威胁等级

- **当前：低（对我们核心优化轴）/ 中高（对"通用 agent 基础设施"叙事）**。
  - 核心轴低：它 6359★ 但不做工具压缩/Code Mode/任务 eval，maintainer 公开拒绝把这类逻辑放进 proxy。它不会直接抢"Gemini MCP gateway 的 search/execute 体验"这个位置。[文档]+[代码]
  - 叙事中高：它的"Agentic Proxy"叙事（安全+治理+可观测+多协议）覆盖面广、社区与发布节奏碾压；若 lead 的对标文档把它列为"竞品"，必须明确标注**不同轴**，否则会误判优先级。[文档]
- **潜在：中**。两条路径可能让它进入我们的轴：① issue #1239 被重新激活并有人实现（目前 0 评论，概率低）；② provider 原生 deferred tools（Anthropic `ToolSearch` 类型已在 `crates/llm/src/types/responses.rs:476-479,582` 透传）普及后，它在 LLM 侧天然获得该能力，届时"harness 做"的论点会被削弱。[代码]+[文档]
- **实质威胁点不是功能而是标准话语权**：它作为 Envoy 系基础设施，可以定义 MCP 治理/审计的"正确做法"；我们的任务级 eval 证据链应尽早输出可引用数字，避免被它的流量指标叙事盖过。

### 3.5 最该抄的 3 点

1. **[最高优先] Gemini schema 收敛规则集（可立即落地到 `sanitize.js` 的回归测试）**：抄 `crates/llm/src/conversion/vertex_gemini.rs:763-797,1045-1095` + `vertex_gemini_tests.rs:711-812,1057,1199,1238,1280` 的 case 清单——`additionalProperties` 剥离、`oneOf→anyOf`（保类型）、`const→typed enum`、数组强制 `items`、`$ref` 递归 bounded、`thinkingBudget` vs `thinkingLevel` 按模型版本切换。这些正是我们 AGENTS.md 里"schema 必须过 sanitize"的已知坑，直接补确定性回归用例即可，无需改架构。
2. **配置写路径的 generation CAS + 事务语义（用于我们的配置/凭据/捕获数据更新）**：抄 `config_store.rs:1882-1996` 的 `UPDATE ... WHERE generation = ? RETURNING generation` + `BEGIN IMMEDIATE` + 批量事务 + `WriteResult::Unchanged` 不推进 revision；以及 `handler.rs:2227-2240` 的"authz 相关响应强制 private/ttl=0"。我们不照搬 SQLite/Postgres，但可把 "expectedGeneration" 概念用在 Vercel 配置写入与 eval 结果归档，避免并发覆盖。[代码]
3. **工具级授权/过滤的"双层一致"设计**：抄 `rbac.rs:53-63,265-273`（`mcp.methodName` 区分 list 与 call）+ `guardrails/expression.rs:242-271`（对 `tools/list` 结果做 CEL transform）+ `mcp_tests.rs:4042-4065,9128-9185`（同一 deny 规则同时作用于 list 与 call 的测试）。我们的白名单/工具注册目前是固定顺序（AGENTS.md 硬规则），但若增加按会话/租户裁剪工具，必须保证**list 隐藏 = call 拒绝**，否则模型仍可从上下文/历史调用未披露工具（issue #963 首条评论也指出了这一点，[文档]）。

**明确不该抄**：① 把 search/call 逻辑塞进网关本体（PR #3859 已被拒，且我们的差异化正是 harness 侧）；② stdio 子进程无沙箱（它直接 spawn 本机进程，我们 QuickJS 边界更强）；③ 只有 OTel/流量指标没有任务级 eval；④ 无 dry-run 的写路径。

## 4. 结论清单（逐条证据）

1. [文档] 6359★/1124 fork/50 watch/356 open issues，Apache-2.0，LF 项目，2025-03 创建、2026-11-22 仍在推送，v1.7.0（2026-10-27）为最新 release：`gh repo view`、`gh api releases/latest`、`README.md:129-132`。
2. [代码] 当前源码**无** toolMode/Search 两工具、无 run_code/Code Mode、无工具定义压缩：`crates/` 全仓 grep；`crates/llm/src/types/responses.rs:476-479,582` 的 ToolSearch 是 provider 输出类型透传。
3. [文档] issue #1239 progressive disclosure 仍 OPEN、0 评论：`gh api repos/.../issues/1239`。
4. [文档] PR #3859（mcp_search/mcp_call 懒暴露，126 tools 63k→194 tokens）`merged:false` 且被 maintainer 明确拒绝（"harnesses/providers 更适合，proxy 不该内置 bespoke MCP server"）：`gh api .../pulls/3859`、`.../issues/3859/comments`。
5. [代码] 工具表面裁剪只通过 CEL RBAC/guardrail 过滤 + prefixMode，schema 原样透传：`mcp/rbac.rs:53-63`、`mcp/guardrails/expression.rs:242-271`、`types/agent.rs:1943-1955`。
6. [代码] MCP Streamable HTTP / stdio / OpenAPI→MCP 全支持：`mcp/upstream/streamablehttp.rs:65-149`、`mcp/upstream/stdio.rs:21-48,276-292`、`mcp/upstream/openapi/mod.rs:256-355`、`types/agent.rs:2078,2088,2110-2120`。
7. [代码] stdio 上游无 OS 沙箱且不支持 policies；动态后端有 DNS 后 loopback/link-local 防护但有开关：`mcp/upstream/stdio.rs:276-292`、`types/local.rs:1863,1714-1726`、`client/mod.rs:567-576,694-695`、`lib.rs:331-335,387`。
8. [代码] 认证/多租户：JWT/OIDC/basic/apiKey/externalAuthz + MCP OAuth discovery/DCR/Entra 适配 + CEL 工具级授权：`types/local.rs:2779-2806,5694-5924`、`mcp/auth.rs:21-130,368`、`mcp/rbac.rs:13-117`、`http/localratelimit.rs:50`。
9. [文档] hosted Web client（claude.ai/ChatGPT）适配是 OPEN issue #4366，0 评论；内置 UI 是运维控制台：`gh api .../issues/4366`、`README.md:83-87`。
10. [代码] 无任务级 eval/capture/scorecard；只有 OTel/访问日志/analytics 聚合与翻译层 golden tests：`telemetry/log_store.rs:104-108,406-736`、`ui/src/types.ts:177-236`、`crates/llm/src/golden_tests.rs`；issue #1950 关闭且 0 评论。
11. [代码] 配置写有 generation CAS + 事务 + 幂等，但无 dry-run：`config_store.rs:352-400,1882-1996,2429-2609`。
12. [未验证] Solo.io 所谓 "agentgateway Search mode progressive disclosure" write-up 的真实内容/是否仍有效（仓库内无对应实现或文档，仅 issue #1950 转述）；ChatGPT/Gemini Web 连接器适配在本轮未发现证据。

URL：https://github.com/agentgateway/agentgateway （clone commit `888badbbe91f2a57ec8e7bf5a5ef3acda34b1fe5`，depth=1）；关键 issue/PR URL 已在正文内联。
