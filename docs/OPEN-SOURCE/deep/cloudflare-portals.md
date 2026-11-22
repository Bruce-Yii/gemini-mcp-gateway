# Cloudflare MCP Server Portals / context optimization / Code Mode 深度核验报告

- 核验日期：2026-11-23（Asia/Singapore）
- 核验方式：`gh auth status`（Bruce-Yii，scopes 含 repo）→ `gh repo view` / `gh api` 读取公开仓库 stars / activity / license / README → `web_fetch` + Firecrawl `scrape` 读取 Cloudflare 官方文档、changelog、官方博客（非营销页；原文见下方 URL）→ 阅读本仓库 `src/` 源码做对照。
- 证据标记：**[官方文档]**（Cloudflare docs / changelog / 官方博客，附 URL）、**[代码]**（`gh api` 拉取的仓库字段 / README 原文 / 本仓库 `src/` 文件与行号）、**[未验证]**（无第一方证据，只有推断或第三方材料）。
- 范围约束：只新增本文件；未改 `src/`、`scripts/`、`tests/`、README、其他 docs、workflows；未 clone 闭源 Portals，未 commit/push/deploy。

---

## 0. 先纠正任务书里的三个前提（重要）

任务书把三个不同机制混成了一个。核验后，Cloudflare 官方文档明确区分如下：

| 机制 | 激活参数 | 对模型暴露的工具 | 是否真的执行 JS 代码 | 证据 |
|---|---|---|---|---|
| `minimize_tools` | `?optimize_context=minimize_tools` | 全部上游工具**只留 name**（description + inputSchema 被剥掉）+ `portal_query_tools` | 否 | [官方文档] [MCP server portals — Optimize context](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/#optimize-context)、[changelog 2026-03-26](https://developers.cloudflare.com/changelog/post/2026-03-26-mcp-portal-context-optimization/) |
| `search_and_execute`（context optimization） | `?optimize_context=search_and_execute` | 只暴露 **`portal_query_tools` + `portal_execute`** 两个工具（另有 portal 内置 3 个会话工具）；`portal_execute` 是**按名字+参数代理调用上游工具**，不写 JS | 否（changelog 措辞含糊说 "runs the upstream tools in an isolated Dynamic Worker"，但 portal 主文档的工具表明确 `portal_execute` 是 "Calls an upstream tool by name with the provided arguments"；无 `codemode.*` 代码入口） | [官方文档] [portal 内置工具表](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/#built-in-portal-tools)、[changelog](https://developers.cloudflare.com/changelog/post/2026-03-26-mcp-portal-context-optimization/)；该矛盾点标 **[未验证]**（需实测 portal 行为才能 100% 定论） |
| Code Mode（portal 级） | `?codemode=search_and_execute`（策略可 `off`/`opt_in`/`default_on`/`enforced`） | **`portal_codemode_search` + `portal_codemode_execute`**；模型写 JS，经 `codemode.tools()` / `codemode.<tool>()` 调用上游 | **是**，运行在 Dynamic Worker 沙箱 | [官方文档] [MCP server portals — Code Mode](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/#code-mode)、[changelog 2026-03-26](https://developers.cloudflare.com/changelog/post/2026-03-26-mcp-portal-code-mode/)、[官方博客 enterprise-mcp](https://blog.cloudflare.com/enterprise-mcp/) |

**结论**：Cloudflare 对外有**两套**名为 `search_and_execute` 的东西——一个是 `optimize_context` 取值的"2 工具代理模式"，一个是 `codemode` 取值的"真·代码执行模式"。前者对应我们的 `search` + 直接调用，后者才对应我们的 `search` + `execute`/`execute_read`。两者不能混谈。[官方文档]+[未验证]（参数交叉组合的精确行为未实测）

另外：`cloudflare/mcp-server-cloudflare` README 已声明**该仓库的领域专用 MCP server 大多 deprecated，推荐迁移到 `cloudflare/mcp`（`https://mcp.cloudflare.com/mcp`）**；[代码] `gh api repos/cloudflare/mcp-server-cloudflare/readme`（"Deprecated servers" 表 + "recommended Cloudflare API MCP Server is maintained in cloudflare/mcp"）。

---

## 1. 开源仓库画像（GitHub CLI 实测）

`gh auth status`：✓ 登录 Bruce-Yii，token scopes 含 `repo`（[代码]）。

| 仓库 | Stars / Forks | License | 最近 push | 活跃度 | 与本任务关系 |
|---|---|---|---|---|---|
| [`cloudflare/mcp`](https://github.com/cloudflare/mcp) | 1154 / 180 | Apache-2.0 | 2026-11-21 | 近期 commit 频繁；README 自称 "2500 endpoints in 1k tokens, powered by Code Mode" | **Code Mode MCP server 参考实现，开源**（[代码] `gh repo view` + README） |
| [`cloudflare/agents`](https://github.com/cloudflare/agents) | 6030 / 858 | MIT | 2026-11-22 | 极活跃，11-22 当天多条 commit（`1b931ee2`、`ad96c7f8` 等） | `packages/codemode` 所在仓库；Code Mode SDK 开源（MIT）但 README 标 **Experimental — may have breaking changes**（[代码] `gh api repos/cloudflare/agents/contents/packages/codemode/README.md`） |
| [`cloudflare/mcp-server-cloudflare`](https://github.com/cloudflare/mcp-server-cloudflare) | 4489 / 585 | Apache-2.0 | 2026-10-22 | 活跃；最近 commit `dfd49e5f` 升级 workers-oauth-provider 1.2.4、退役 `/sse`（[代码] `gh api .../commits`） | 领域专用 servers；多数已 deprecated |
| [`cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider) | 1901 / 144 | MIT | 2026-11-17 | 活跃；最近 commit `dbd149a2` 修 CIMD DCR 客户端登录（[代码] `gh api .../commits`） | OAuth 2.1 / DCR 库；我们 Vercel 端的实现参考 |

**Portals 本体闭源**：`gh api search/repositories?q=org:cloudflare+portals+in:name,description` 与 `q=org:cloudflare+codemode` 均无结果；Portals 是 Cloudflare One Access 的托管服务，文档明确只能在 Zero Trust dashboard / API / Terraform 配置，且 DNS CNAME 指向 `gateway.agents.cloudflare.com`（[官方文档] [MCP portals — Manage portals via API / 522 排障](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/#manage-portals-via-api)）。**无源码可 clone**，符合任务书预期。

**可借鉴的开源部分不是 Portals，而是 `cloudflare/mcp` 与 `packages/codemode`**（[代码] README + license 字段）。

---

## 2. `minimize_tools` 具体行为核验

**任务书问题：只留 name？省 5x？** — 两条都确认为真：

- [官方文档] [MCP portals — Minimize tools](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/#minimize-tools)："The `minimize_tools` option **strips tool descriptions and input schemas** from all upstream tools, **leaving only their names**. The portal exposes a special `query` tool that agents use to search and retrieve full tool definitions on demand."
- [官方文档] 同页 / [changelog](https://developers.cloudflare.com/changelog/post/2026-03-26-mcp-portal-context-optimization/)："This provides **up to 5x savings** in token usage" —— 注意是 **up to**，且"querying tool definitions before use adds a small amount of overhead"。
- [官方文档] [内置工具表](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/#built-in-portal-tools)：该模式实际新增的工具名为 **`portal_query_tools`**（"Searches upstream tools by name, description, or schema using a **regex pattern**. Returns full tool definitions so the agent can call them"），不是文档正文简写的 `query`。
- [官方文档] 即使开启 minimize_tools，`portal_list_servers` / `portal_toggle_servers` / `portal_toggle_single_server` 这 3 个内置工具**始终存在**（同页 "Always available" 表）。所以"只留 name"指**上游工具定义**，不含 portal 自带工具。

**对照**：我们的 `search` 默认返回 name + service + readOnly + 一行 summary，`select:<name>` 才返回完整 inputSchema（[代码] `src/codemode.js:1262-1285`、`src/tool-format.js`）。这比 `minimize_tools` 的"只有 name"信息量**更高**（有语义摘要），但比它的 5x 数字更费 token —— 我们没做过 5x 基准，**"我们省 5x"属 [未验证]**，不能引用。

---

## 3. `search_and_execute` 具体暴露几个工具 / 沙箱边界 / 认证与权限

### 3.1 暴露几个工具

- [官方文档] `optimize_context=search_and_execute`：**`portal_query_tools` + `portal_execute` 两个**（[内置工具表](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/#built-in-portal-tools)）；changelog 写作 `query` / `execute`（[changelog](https://developers.cloudflare.com/changelog/post/2026-03-26-mcp-portal-context-optimization/)）。加上永远存在的 3 个 portal 内置工具，客户端 `tools/list` 可见 **5 个**。
- [官方文档] Code Mode 策略开启时：**`portal_codemode_search` + `portal_codemode_execute` 两个**（[portal Code Mode 节](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/#code-mode)、[changelog](https://developers.cloudflare.com/changelog/post/2026-03-26-mcp-portal-code-mode/)）；changelog 早期措辞"a single `code` tool"与现行两工具说法不一致，**以现行 portal 文档 + 官方博客为准**（[官方博客](https://blog.cloudflare.com/enterprise-mcp/)给出 2 工具与 `codemode.tools()` / `codemode` proxy 示例）。
- [官方文档] `portal_codemode_search` 沙箱内提供 `codemode.tools()` 返回全部上游工具定义（sanitized names）；`portal_codemode_execute` 提供 `codemode` proxy 对象，每个属性是一个上游工具函数，**支持 `Promise.all()` 并行**（[内置工具表](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/#built-in-portal-tools)、[官方博客](https://blog.cloudflare.com/enterprise-mcp/)）。
- Code Mode 的 4 档策略：`off` / `opt_in`（默认，需 `?codemode=search_and_execute`）/ `default_on`（可 `?codemode=off`）/ `enforced`（忽略 query param）；旧字段 `allow_code_mode` 已废弃（[官方文档] [portal Code Mode policies](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/#code-mode-policies)）。
- **不支持上游自带 Code Mode**：portal 无法接一个已经开启 Code Mode 的上游 server，需要上游 opt-out 或关掉 portal Code Mode（[官方文档] 同页 "Upstream servers with Code Mode turned on"）。这与我们的网关**自己就是 Code Mode server**、放在别人 portal 后面会冲突 —— 设计上要注意。

### 3.2 Dynamic Worker 沙箱边界

- [官方文档] [How Code Mode works](https://developers.cloudflare.com/agents/tools/codemode/how-it-works/)：沙箱是 **Dynamic Worker**（V8 isolate），"does not expose Node.js APIs, host credentials, `process`, `require`, or unrestricted network access. All external operations go through connector globals unless the executor explicitly provides another capability."
- [官方文档] 同上：`DynamicWorkerExecutor` 默认 `globalOutbound: null`，**外部 fetch/connect 默认被阻断**；可显式给 `Fetcher` 走受控出口。connector 调用走 **Cloudflare Workers RPC**，host 在调用前拦截以实施审批 / 日志 / replay / rollback。
- [官方文档] [Code Mode API reference](https://developers.cloudflare.com/agents/tools/codemode/api-reference/)：`DynamicWorkerExecutorOptions` 含 `loader`（WorkerLoader binding）、`timeout`（默认 60000ms）、`globalOutbound`（默认 `null`）、`modules`、`bindings`；iframe 浏览器执行器另有默认 CSP `default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval';` + `sandbox="allow-scripts"`。
- [官方文档] [Dynamic Workers 产品页](https://developers.cloudflare.com/dynamic-workers/)：定位"unlimited Workers to execute arbitrary code specified at runtime… lightweight alternative to containers for securely sandboxing code you do not trust"；可调 bindings / auth / egress / observability / resource limits。
- [官方博客] [code mode 中文版](https://blog.cloudflare.com/zh-cn/code-mode-mcp)："Dynamic Worker 隔离，轻量 V8 沙箱**无文件系统**、**无环境变量**（避免提示注入泄露）、**默认禁用外部请求**"。
- 持久化边界：执行历史存在 Durable Object facet 的 SQLite（每次执行最多保留 50 条 terminal record，24h 清退 paused/running），代码本身不持有 durable state（[官方文档] [How Code Mode works — Durable runtime / Retention](https://developers.cloudflare.com/agents/tools/codemode/how-it-works/)）。
- **写路径语义**：connector 工具可标 `requiresApproval: true` → 运行时 abort 当前 pass、记录 pending action，用户 `approve()` 后**带同一 executionId 重放**（已 applied 的调用返回记录结果，不重复执行）；`reject()` 只结束执行不回滚；`rollback()` 按逆序调用各 connector 的 `revert`，是**补偿而非事务隔离**；`replay: "reexecute"` 仅适合幂等读，不能用于审批方法（[官方文档] [How Code Mode works — Approvals / Deterministic replay / Rollback](https://developers.cloudflare.com/agents/tools/codemode/how-it-works/)、[API reference — CodemodeConnector](https://developers.cloudflare.com/agents/tools/codemode/api-reference/)）。
- 结果上限：`truncateResult` 默认 6000 estimated tokens（4 chars/token），超长 JSON 保留结构并加截断标记（[官方文档] [API reference — truncateResponse/truncateResult](https://developers.cloudflare.com/agents/tools/codemode/api-reference/)）；[代码] `cloudflare/mcp` README 的 "Tool Result Truncation" 同样写 ~6000 tokens、`truncate: false` 可关。

### 3.3 认证与企业权限

- [官方文档] 客户端 → portal：标准 OAuth 2.0 authorization code flow（Managed OAuth），非浏览器客户端收到 `401` + `WWW-Authenticate` 指向 Access 的 OAuth discovery endpoints（不是浏览器重定向）；也支持 Access service token（`CF-Access-Client-Id` / `CF-Access-Client-Secret`）做 M2M（[MCP portals — Key features / Connect with a service token](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/)）。
- [官方文档] portal → 上游：每用户独立 OAuth（dashboard 的 `Require user auth` = API `on_behalf: true`），或用管理员 credential（`on_behalf: false`）；DCR 自动发现或手工 client id/secret（secret 加密存储且不回显）；DCR server 每约 2 小时用 admin credential 同步 tools/prompts（[同页](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/#synchronize-the-mcp-server)）。
- [官方文档] 企业策略面：Access policies 决定哪些用户能看到哪个 server / portal；可按 portal 做**工具白名单**与别名；Gateway routing 可对上游 hostname 做 HTTP 日志 + DLP（block 双向：请求含敏感数据或响应命中 profile 都报错），Logpush 导出仅 Enterprise；每个 portal 最多 120 个 server；上游工具调用 60s 超时（[MCP portals — Key features / Route portal traffic through Gateway / Known limitations](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/)）。
- [官方文档] 权限限制（易被营销页掩盖）：通过 portal 授权 server 时，**Independent MFA / purpose justification / temporary authentication 不生效**（Emails/Groups/Country/Device Posture 仍生效）；只支持远程 HTTP MCP（stdio only 的 server 接不了）；部分 server 拒绝 proxy 客户端（403）；admin token 过期**不会通知管理员**，只把 server 状态变成 Error / Sync required 并从 portal 隐藏（[同页 — Policy limitations / Known limitations](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/)）。
- [官方博客] 内部做法：集中团队用 monorepo 模板部署 remote MCP server，**默认拒绝写（default-deny write controls）+ 审计日志 + 自动 CI/CD + secrets management**；再按人群分 portal —— finance 组只见只读工具，engineering 组（企业设备）才见读写工具（[Scaling MCP adoption](https://blog.cloudflare.com/enterprise-mcp/)）。这是"读写分层"的**真实产品化形态**：不是 server 内两种工具，而是**两个策略不同的 portal + 工具白名单**。

---

## 4. 客户端支持：Gemini / ChatGPT / Claude web 还是 Access 企业客户端？

**核验结果：官方文档只承诺 MCP 协议兼容 + Claude/Workers AI Playground/OpenCode/Windsurf 等客户端；没有 Gemini web / ChatGPT web 的第一方支持声明。**

- [官方文档] 连接章节列出：Workers AI Playground、MCP Inspector、Claude Desktop（含 custom connector，Free/Pro/Max 与 Team/Enterprise 两条路径）、OpenCode、Windsurf、`mcp-remote` bridge、service token（[MCP portals — Connect to a portal](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/#connect-to-a-portal)）。**没有 Gemini web custom apps、没有 ChatGPT web**。
- [官方文档] 明确的认证入口是 **Cloudflare Access**（IdP/SSO/MFA/设备证书）或 service token；Claude 从 Anthropic 云基础设施连接，**不经过用户设备上的 Cloudflare One Client**，文档特意提醒不要给 Claude connector 加 Cloudflare 根证书（[同页 Claude Desktop 节 Note](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/#connect-claude-desktop)）。
- [官方文档] "Device authentication（从 Cloudflare One Client 继承身份）**目前不支持** portals，首次连接必须在浏览器完成 Access 登录"（[同页 — Device authentication](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/#device-authentication)）。
- 因此：**Portals 的人群是企业员工（Access/IdP 管控），不是 Gemini/ChatGPT 消费者 web 用户**。[官方文档]+[未验证]（不能排除客户端侧偶然可用，例如把 portal URL 填进 Gemini custom app 是否能过 OAuth discovery —— 无第一方证据，标未验证；我们自己的 web client 现状见 [WEB-CLIENTS.md](../WEB-CLIENTS.md)）。
- 对照：我们项目**已实测的客户端是 Gemini web custom apps**（[代码] `docs/OPEN-SOURCE/WEB-CLIENTS.md:6,31`），部署在 Vercel、OAuth 2.1 DCR + PKCE（[代码] `src/oauth.js`、`src/vercel-app.js`、`api/index.js`；AGENTS.md 项目约束）。人群正好与 Portals 相反：我们是**个人/小团队、单用户 web 客户端优先**。

---

## 5. 任务级 eval / capture、读写分层、写路径语义、Web 单用户自托管

| 问题 | Cloudflare 侧结论 | 我们侧结论 |
|---|---|---|
| 任务级 eval / capture | [官方文档] Portal 日志字段只有 Time / Status / Server / Capability / Duration，且只支持 Logpush 导出（Enterprise）（[View portal logs](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/#view-portal-logs)）。[官方文档] Code Mode SDK 有 execution log / executionId / 审计记录（`executions()`、`maxExecutions=50`），但这是**开发者库能力**，不是 Portal 产品承诺的"任务级 capture + 离线 eval"。**未发现 Cloudflare 官方提供 capture→eval 闭环**（[未验证]，仅基于检索到的 docs/blog，不能证明不存在）。 | [代码] `src/capture.js:41-45` `captureEvent()` + `requestId` 关联 `capture_ack`/`capture_done`；`src/codemode.js:1316-1320` 每次 sandbox 执行记 `code`+完整 output；`src/capture.js:53-120` 还有字节级"模型截断审计"（source vs visible、显式 truncated 标记）；`docs/eval/` 下有 L1 smoke / scorecard / write-replay 等。**这块我们比 Portal 的日志强一个数量级**。 |
| 读写分层 | [官方博客] 分层在**portal 层**实现：不同 Access 策略的门户暴露不同工具白名单（finance 只读 / engineering 读写），server 内部默认 deny-write（[Scaling MCP adoption](https://blog.cloudflare.com/enterprise-mcp/)）。[官方文档] Portal 侧 tool-level 白名单/别名见 "Customized tools per portal"（[MCP portals](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/)）。SDK 层另有 `requiresApproval` / `revert` / `rollback`（[How Code Mode works](https://developers.cloudflare.com/agents/tools/codemode/how-it-works/)）。 | [代码] 我们直接在 MCP 工具面分层：`execute_read`（只注入 `readOnlyHint`/READ_ONLY_TOOL_RE 过滤出的工具）+ `execute`（全量），`src/codemode.js:1287-1326`；`annotations` 分别为 read-only 与 destructive（1297-1299）。**粒度更细（每次调用可由模型选择），但缺 portal 那种按人群强制的策略层**。 |
| 写路径语义 | [官方文档] 审批 = abort + 重放；拒绝不回滚；rollback 是尽力补偿；`replay:"reexecute"` 禁用于审批方法；connector 调用需顺序执行以免 replay divergence（[How Code Mode works](https://developers.cloudflare.com/agents/tools/codemode/how-it-works/)）。[官方博客] 内部模板 default-deny write + 审计。 | [代码] 我们有 host 侧 `applyFilePatches` / `precheckText` / `createBranchIfMissing` / `canonicalResult` / `upsertPr`，dryRun 默认、`readFileRange` 拒绝用 truncated 读去写、GitHub `push_files` 11 文件原子提交（`src/file-write.js`、`src/github-helpers.js`、`src/codemode.js:154-180,1287-1326`）。**写语义是"确定性host helper + 显式预览/原子提交"，不是审批重放**。两者的可信模型不同：Cloudflare 依赖 Durable Object 重放，我们依赖 host 侧幂等/预检。 |
| Web 单用户自托管 | [官方文档] Portals 是 Cloudflare One Access 托管服务：需要 active domain（full/partial setup）+ IdP + Zero Trust dashboard/API/Terraform；DNS 指向 `gateway.agents.cloudflare.com`；没有单用户/本地自托管形态（[Prerequisites / Manage portals via API](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/)）。[代码] 开源的是 SDK（`cloudflare/agents` MIT）与示例 server（`cloudflare/mcp` Apache-2.0），可自托管**自己的** Code Mode MCP server，但不是 Portal 本体。 | [代码] 我们 Vercel 单实例部署 + OAuth DCR + 本地 `config.example.json`/vault（[docs/CREDENTIALS.md](../../CREDENTIALS.md)）；完全单用户自托管可行。**这是结构性差异，不是差距**：Portals 解决"企业集中治理 N 个 server"，我们解决"一个人把 N 个 SaaS 塞进 Gemini web"。 |

---

## 6. 对照我们的项目：同轴度、人群差、部署差、威胁

### 6.1 功能同轴度

| 维度 | Cloudflare Portals / Code Mode | 我们（gemini-mcp-gateway） | 判定 |
|---|---|---|---|
| 工具数收敛 | 3 个内置 + 2 个 optimize 工具 或 +2 codemode 工具（[官方文档]） | 3 个：`search` / `execute_read` / `execute`（[代码] `src/codemode.js:1326`、`src/server.js:285`） | **高度同轴**：都是"少量入口 + 按需发现" |
| 发现语义 | `codemode.search()` 返回 ranked paths（top 50，带 score/truncated），`codemode.describe()` 取 TS 文档（[官方文档] [API reference](https://developers.cloudflare.com/agents/tools/codemode/api-reference/)）；`portal_query_tools` 用 regex 搜 name/description/schema | `search(query)` 关键词排名 + `select:<name>` 取完整 schema；工具名 `__` 分隔；结果带 `callName` 提示 | 同轴；我们的**有摘要但无 TS 类型**，Cloudflare 的**有 TS 类型但发现分两跳** |
| 上下文预算 | ~6000 tokens 结果截断 + `truncate:false` 逃生（[代码] cloudflare/mcp README；[官方文档] API reference） | `DEFAULT_MAX_RESULT_CHARS=20000`、`DEFAULT_MAX_LOG_CHARS=4000`、maxCalls=50、显式 truncated 标记（[代码] `src/codemode.js:41-45`） | 同轴，阈值不同；我们**对截断的可审计性更强** |
| 沙箱 | Dynamic Worker（V8 isolate），无 Node/无 env/默认禁出站，RPC 桥接 connector（[官方文档]） | Vercel `run` SDK 的 hardened QuickJS（worker thread），无 process/require/fetch/Node globals、原型冻结、`.constructor` 不可达 host（[代码] `src/codemode.js:12-16,88-113`；[docs/SANDBOX-SECURITY.md](../../SANDBOX-SECURITY.md)） | 同轴但**引擎不同**：他们 V8 isolate + 可控 fetcher，我们 QuickJS + 全禁网；我们的威胁面更小 |
| 写编排 | 审批/重放/补偿回滚（SDK），portal 层 default-deny + 工具白名单（博客） | host 侧确定性 helper + dryRun + 原子 push（代码） | 目标相同，机制不同；他们强在**通用审批框架**，我们强在**具体写语义正确性** |

### 6.2 人群差

- Cloudflare：**企业员工 + 管理员 + 安全团队**；身份来自 IdP/SSO/MFA/设备姿态，按组分 portal，可审计可 DLP（[官方文档] + [官方博客](https://blog.cloudflare.com/enterprise-mcp/)）。
- 我们：**单用户 / 小团队，Gemini web custom apps 实测优先**（[代码] `WEB-CLIENTS.md`）；OAuth 让我们以用户身份接 SaaS，而不是企业管理员下发策略。
- 结论：Portal 的"按人员分工具子集"思路对我们**有借鉴价值但不能照搬** —— 我们没有 IdP 与组织目录，硬做 Access 式策略会引入没有的基础设施。

### 6.3 部署差

- Portal：托管服务，必须有域名 + Cloudflare One + proxied CNAME 到 `gateway.agents.cloudflare.com`，API/Terraform 创建还需手工建 DNS（[官方文档]）。开箱即全球任何点、60s 上限、每 portal 120 server。
- 我们：Vercel Serverless，`api/index.js` 入口，本地 MCP Inspector / 冒烟脚本验证（AGENTS.md）；无 Cloudflare 依赖。
- 迁移/借鉴成本：Code Mode SDK（`cloudflare/agents`, MIT）理论上可自托管，但依赖 WorkerLoader binding + Durable Object，**与我们的 Vercel/QuickJS 架构不兼容**；直接替换沙箱会把现有 capture/审计与 Gemini 兼容性全部推翻，**不建议**。

### 6.4 威胁（含 Cloudflare 自己承认的）

- [官方博客] Cloudflare 自述本地 MCP server 是供应链 / 工具注入风险，集中部署 + 默认 deny-write + 审计是解法；并给出 Shadow MCP 检测 regex（JSON-RPC body 里的 `tools/call` / `initialize` 等）与 WAF "AI Security for Apps" 检查入站 prompt injection（[Scaling MCP adoption](https://blog.cloudflare.com/enterprise-mcp/)）。
- [官方文档] 明确警告：**portal 的 Access 策略只控制"能否看到 server"，被挡的用户仍可用 server 直连 URL 绕过**；要真正强制需把 Access 配成 server 的 OAuth provider（[Add an MCP server — Caution](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/#add-an-mcp-server)）。这是"集中网关不等于强制单点"的重要反例。
- [官方文档] 另一个威胁：admin OAuth token 静默过期导致 server 从 portal 消失且无通知；DCR 同步用 admin credential 而非用户 credential；`X-Forwarded-User-Agent` 是**不可信客户端输入，不能用于鉴权**（[同页](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/)）。
- 我们侧对应威胁（[代码] + [docs/SANDBOX-SECURITY.md](../../SANDBOX-SECURITY.md)）：模型生成代码是主要攻击面，QuickJS 边界 + 无 fetch + 调用数/结果上限是缓解；写路径靠 dryRun/预检/原子提交；capture 用于事后审计。**我们没有企业级的 DLP/Shadow-MCP 能力，也不需要把它当目标**。

---

## 7. 可借鉴的设计（具体到"抄什么、怎么落地"）

1. **`minimize_tools` 的渐进式披露策略** —— [官方文档]（[changelog](https://developers.cloudflare.com/changelog/post/2026-03-26-mcp-portal-context-optimization/)）。我们已有 `search` 摘要 + `select:` 详情，等价于更细的版本；可借鉴的是**把"只留 name"作为可选项**用于超大 tool catalog：给 `search` 加一个 `brief` 参数或在 catalog 层提供 name-only profile，**但不要改变现有 MCP 工具 schema**（AGENTS.md：Gemini 不消费 `tools/list_changed`，改 schema 要换版本路径）。收益未量化，**标 [未验证]，只做设计储备**。
2. **`query`/`execute` 命名与两跳发现** —— [官方文档] `codemode.search()` 返回 ranked paths + `codemode.describe()` 按需取类型（[How Code Mode works](https://developers.cloudflare.com/agents/tools/codemode/how-it-works/)）。我们的 `search` + `select:` 已是两跳，但 `select:` 靠**字符串协议**而非独立工具；可借鉴的是**在 `search` 结果里附更结构化的参数签名/required 标记**（我们已有 `name!` 必填标记，[代码] `src/codemode.js:1264`），继续强化即可，**无需新工具**。
3. **上下文参数的显式化** —— [官方文档] `truncate:false` 逃生口 + `--- TRUNCATED ---` 标记（[cloudflare/mcp README](https://github.com/cloudflare/mcp)、[API reference](https://developers.cloudflare.com/agents/tools/codemode/api-reference/)）。我们已有 `truncated:true` / `truncation.reason` / `nextStart` 分页，且**比他们更严**（写前拒绝 truncated 读，[代码] `src/codemode.js:154-167`）。可借鉴点极小：为"大结果直接落文件不经模型"的场景预留一个显式参数，但**需先写回归测试**，不在本轮改代码。
4. **写路径分层理念** —— [官方博客] default-deny write + 按人群暴露只读/读写工具集（[Scaling MCP adoption](https://blog.cloudflare.com/enterprise-mcp/)）。我们用 `execute_read`/`execute` 已实现**调用级**分层；可借鉴的是**在文档里明确写清"只读 ≠ 安全凭证降级"**（只读工具仍持有写权限 token，只是不调用写方法），避免用户误解。
5. **审计/可观测性** —— [官方文档] SDK 的 `executionId` + 顺序日志 + 24h 清退（[How Code Mode works](https://developers.cloudflare.com/agents/tools/codemode/how-it-works/)）。我们的 requestId + capture 已覆盖；可借鉴的是**给每次 sandbox 执行分配稳定 executionId 并串起上下游调用**（我们现在用 requestId 串整条 HTTP 请求，[代码] `src/capture.js`），作为未来多步任务追踪的演进方向，**本轮不动**。
6. **明确不抄的** —— Dynamic Worker / Durable Object / Workers RPC / Access 策略栈：与 Vercel + QuickJS 部署形态不兼容；Portals 本体闭源且是企业付费产品，抄不了也不该抄。

---

## 8. 证据清单（按类型）

**官方文档（一手）**
- [MCP server portals（产品主文档）](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/) — 工具表、Code Mode 策略、认证、Gateway/DLP、限制、客户端
- [Context optimization changelog（2026-03-26）](https://developers.cloudflare.com/changelog/post/2026-03-26-mcp-portal-context-optimization/) — minimize_tools 5x、search_and_execute 两工具
- [Code Mode for MCP server portals changelog（2026-03-26）](https://developers.cloudflare.com/changelog/post/2026-03-26-mcp-portal-code-mode/)
- [Code Mode API reference](https://developers.cloudflare.com/agents/tools/codemode/api-reference/)
- [How Code Mode works](https://developers.cloudflare.com/agents/tools/codemode/how-it-works/)
- [Dynamic Workers](https://developers.cloudflare.com/dynamic-workers/)
- [Scaling MCP adoption（企业参考架构博客）](https://blog.cloudflare.com/enterprise-mcp/)
- [Code Mode: give agents an entire API in 1,000 tokens（官方博客）](https://blog.cloudflare.com/code-mode-mcp/) / [中文版](https://blog.cloudflare.com/zh-cn/code-mode-mcp)

**代码（gh api / 本仓库）**
- `gh repo view cloudflare/{mcp,agents,mcp-server-cloudflare,workers-oauth-provider} --json ...`
- `gh api repos/cloudflare/mcp/readme`、`gh api repos/cloudflare/agents/contents/packages/codemode/README.md`
- `gh api search/repositories?q=org:cloudflare+portals...`（无结果）
- 本仓库：`src/codemode.js:41-45,54,88-113,154-180,1262-1326`、`src/server.js:279-334`、`src/capture.js:41-120`、`docs/OPEN-SOURCE/WEB-CLIENTS.md`、`docs/SANDBOX-SECURITY.md`

**未验证（明确不声称）**
- `optimize_context=search_and_execute` 的 `portal_execute` 是否内部真的用 Dynamic Worker（changelog 与 portal 工具表措辞不一致）— 需实测
- Gemini web / ChatGPT web 直接填 portal URL 能否通过 OAuth discovery — 无第一方证据
- Cloudflare 是否提供 Portal 级"任务级 eval/capture 闭环" — 检索到的文档只到日志字段与 SDK execution log
- 我们自己的 "5x token 节省" — 无基准数据
- Code Mode SDK 的 Experimental 状态是否已在生产 portal 中消除 — portal 产品已 GA，但 SDK README 仍标 Experimental（[代码]）

> 本报告只做核验与记录；未修改任何代码、配置或线上资源，未 commit。
