# maximhq/bifrost 深度核验（源码 + 文档 + 外部基准）

- 核验时间：2026-11-23（Asia/Singapore）。
- 核验方式：`gh auth status`、`gh repo view`、`gh repo clone maximhq/bifrost work/deep-bifrost -- --depth=1`（HEAD `8ad61e208215a6eb928421982ffd06c430971f67`, 2026-11-22），逐文件读 README / `docs/mcp/` / `docs/features/` / `core/mcp/**` / `transports/bifrost-http/**`，并用 `gh api` / `web_fetch` 交叉验证外部基准与博客。
- 证据标签：`[代码]`=本仓库源码行号；`[文档]`=本仓库文档或官方外链；`[未验证]`=无法从源码/文档确证。
- **本报告只写此文件，未改任何源码/配置/其他文档，未 commit/push/deploy。**

## 0. 仓库基本盘

| 项 | 值 | 证据 |
|---|---|---|
| nameWithOwner | `maximhq/bifrost` | [文档] `gh repo view ...` |
| stars | 9953（≈9.9k） | [文档] `gh repo view ...`（2026-11-23） |
| pushedAt | 2026-11-22T23:14:13Z | [文档] 同上，活跃维护 |
| license | Apache-2.0 | [文档] 同上；`LICENSE` |
| latest release | `helm-chart-v2.1.49`（2026-11-19） | [文档] 同上 |
| 定位 | 多提供者 LLM gateway + MCP gateway + Agent Gateway，面向企业控制面 | [文档] `README.md:15,60-63,90`；`docs/overview.mdx:75-101` |
| 规模 | Go 文件 1201（core）、343（transports）、600（framework）、254（plugins）；`docs/` 约 700 个 `.mdx`；`core/mcp/` 仅 80 个 Go 文件 | [代码] 本地 `Get-ChildItem` 统计 |
| 近期提交中 MCP 占比 | 最近 100 个 commit subject 中 9 个含 `mcp`/`codemode` | [代码] `gh api repos/maximhq/bifrost/commits?per_page=100` |

## 1. MCP Code Mode：到底是几个工具、压缩怎么做的、92.8% 是否可复现

### 1.1 恰好四个工具（与我们的三个不同）

[代码] `core/mcp/codemode.go:13-18,86-97` 定义四个常量并组成 `codeModeToolNames`：

```
listToolFiles / readToolFile / getToolDocs / executeToolCode
```

[代码] `core/mcp/codemode/starlark/starlark.go:92-103` 的 `GetTools()` 返回这四个；`docs/mcp/code-mode.mdx:56-60,383-385` 同述。**没有** `search` 工具、**没有** `execute_read`/`execute` 分层——只有一个 `executeToolCode`，读写同权，靠 agent-mode 的 `tools_to_auto_execute` 白名单拦截（见 §4）。

对比我们：`src/codemode.js:1326` 返回 `[search, execute_read, execute]` 三个工具；`search` 是**检索式**发现（`select:<name>` 看完整 schema，`src/codemode.js:1262-1279`），而 Bifrost 是**文件树式**发现。

### 1.2 "工具定义压缩"的实现机制

不是把 schema 做语义压缩，而是**用虚拟 `.pyi` 文件树做按需加载（progressive disclosure by file）**：

1. [代码] `core/mcp/codemode/starlark/listfiles.go:18-61`：`listToolFiles` 返回一棵 `servers/<server>.pyi`（server-level 默认）或 `servers/<server>/<tool>.pyi`（tool-level）的树；其 description 明确要求模型"先 listToolFiles 再 readToolFile"。
2. [代码] `listfiles.go:96-113,127-153`：按 `bindingLevel` 生成文件路径；树输出头部写明 workflow 和"哪些 server 有 instructions"。
3. [代码] `core/mcp/codemode/starlark/readfile.go:18-75`：把完整 JSON Schema **渲染成 Python 函数签名**（`def search(query: str, maxResults: int = None) -> dict:  # Search for videos`），每次只读一个文件、支持 `startLine/endLine` 部分读。这是"压缩"的实质：签名化 + 分片读取，而不是 lossy 摘要。
4. [代码] `core/mcp/codemode/starlark/getdocs.go:15-49`：`getToolDocs` 在签名不够时才返回完整 docstring。
5. [文档] `docs/mcp/code-mode.mdx:423-437,459-504` 给出 stub 与 docs 的实际输出样例；`docs/mcp/code-mode.mdx:538-631` 描述 server/tool 两级绑定（全局设置）。

**关键点**：[代码] `executecode.go:65-96` 的 `executeToolCode` 描述是一大段（约 2.5k 字符）静态 prompt，包含 Starlark 与 Python 的差异说明、可用性提示、retry policy；它不是"零成本"，只是**固定成本**——这是压缩成立的前提（固定 4 个定义 vs 随工具数线性增长的定义）。

### 1.3 92.8% 的口径：是自述，但外部基准可复现

- [文档] `docs/mcp/code-mode.mdx:4,34,40-44,50` 自述 92.8%（ Round 3，508 tools / 16 servers；75.1M → 5.4M input tokens；成本 $377 → $29；pass rate 65/65 保持 100%）。注意 [文档] `docs/overview.mdx:90` 仍写"50% less tokens"，与 detail 页口径不一致（营销文案滞后）。
- [文档] `docs/mcp/code-mode.mdx:50` 链接到独立仓库 `maximhq/bifrost-benchmarking` 的 `mcp-code-mode-benchmark/benchmark_report.md`；我用 web_fetch 拉取了原文（HTTP 200）：包含三轮完整表格、**每 query 的 OFF/ON input/output/token/reduction 明细**（R1 64 行、R2 65 行、R3 65 行），并标注模型 `anthropic/claude-sonnet-4-6`、tool-level binding、token 为整个 agent loop 累计。R3 总计 75,097.0k → 5,415.6k = -92.8%；R3M36 单 query 14.3M→245k (-98.3%)。
- **结论**：数字有公开原始数据，不是纯营销自述；但 [未验证] 我未本地重跑基准（需要 16 个上游 MCP server + Claude 付费 API）。报告自身也披露不利样本：R2M17 (-6%)、R2H6 (-75%)、R3M35 仅降 36%（大响应 payload 把 Starlark 执行上下文撑大）。所以"up to 92.8%"应读作**大规模工具场景的上界**，不是通用承诺。
- 另一个口径差异：[文档] 报告称 latency "40% faster"，但原始数据三轮 wall clock 变化是 -26.8% / -6.8% / -17.1%；92.8% 是 input token，不是总 token（总 token -92.7%）。

## 2. Web MCP clients（Gemini / ChatGPT / Claude）与 OAuth / DCR

### 2.1 Claude 系与 Cursor：一手支持

- [文档] `docs/mcp/overview.mdx:15,59,136,345,421-425,586`：`/mcp` 端点面向 Claude Desktop、Claude Code、Cursor；approval 由 host 决定（Bifrost 在 pure gateway 模式无 LLM loop）。
- [文档] `docs/mcp/gateway-auth.mdx:14,63,84,110`：Bifrost 自身作为 OAuth 2.1 authorization server，支持 RFC 7591 DCR，浏览器 consent（"Claude Code wants to connect"）。
- [代码] `transports/bifrost-http/handlers/mcpoauth2issuance.go:35,95,135`：`POST /oauth2/register` 是 RFC 7591 DCR 实现；`framework/oauth2/discovery.go:744-758,819,881-922` 有 DCR request/response 与注册函数；`framework/oauth2/main.go:781-814` 先尝试 CIMD（Client ID Metadata Document），再回退 DCR。
- [文档] `docs/mcp/auth/oauth.mdx:194,251-274,305-306`：client_id 可为空，由 metadata document 或 DCR 获得；`per_user_oauth` 同（`docs/mcp/auth/per-user-oauth.mdx:49,87`）。[代码] `core/schemas/oauth.go:218-222` 有 `registration_url` 字段。

### 2.2 Gemini / ChatGPT 作为 web MCP client：**未找到支持证据**

- [未验证] 全仓 `docs/mcp/**` 搜索 `gemini|chatgpt|chat.openai|gemini-cli` **零命中**；[文档] `docs/mcp/connecting-to-servers.mdx:856,873` 点名的是 Claude Desktop / Cursor；博客（getmaxim.ai）逐字列的是 "Claude Code, Cursor, or any MCP client" 与 STDIO/HTTP/SSE/in-process。Bifrost 支持 Gemini 作为**被代理的 LLM provider**（`docs/overview.mdx` providers），但那与"Gemini 作为 MCP host 连进来"不是一回事。
- ChatGPT 方面只看到 [文档] `transports/changelog.md:33` 的 ChatGPT 登录 + Codex passthrough（LLM 侧），不是 MCP client 入口。
- **判断**：对"web MCP clients"的覆盖是 **Claude-first**，Gemini/ChatGPT 属于未验证/不支持。这正是我们的差异化窗口（见 §6）。

## 3. Progressive disclosure / tool search / 沙箱 / 读写分层

| 能力 | Bifrost | 证据 |
|---|---|---|
| 按需发现 | ✅ 文件树 `.pyi` + 部分读；无语义/向量 tool search | [代码] `listfiles.go:18-61`；`readfile.go`；[文档] `docs/mcp/code-mode.mdx:391-504` |
| 语义 tool search | ❌ 未发现；`core/mcp/` 中 `search` 命中都是工具名字符串（如 `notes-search`） | [未验证] `grep -r "semantic.*tool\|tool.*vector\|top_k"` on `core/mcp/`、`docs/mcp/` 无实现 |
| 沙箱 | ✅ 进程内 Starlark（Canonical 实现），`RequireSafety(CPUSafe\|MemSafe\|TimeSafe)`，`SetMaxSteps/SetMaxAllocs`；无 import / 文件 / 网络；json + math 模块预置 | [代码] `core/mcp/codemode/starlark/sandbox.go:24-30,54-67,105-170`；[文档] `docs/mcp/code-mode.mdx:686-775` |
| 限额 | 7 项：source 64KiB / steps 1e6 / memory 64MiB / log 64KiB / tool calls 64 / value 1MiB / depth 64；默认 30s；**无全局并发上限** | [代码] `sandbox.go:58-60,68-88,117-120`；[文档] `docs/mcp/code-mode.mdx:755-779`（Helm 也暴露：`helm-charts/bifrost/README.md:119`） |
| 沙箱性质 | 明确声明是**协作式计量**，非 OS 强制内存隔离；"no child-process startup or IPC" | [文档] `docs/mcp/code-mode.mdx:773`；[代码] `sandbox.go:64-66` |
| 读写分层 | ❌ Code Mode 只有一个 `executeToolCode`；只读性靠 agent-mode 的 `tools_to_auto_execute` 白名单与 `readOnlyHint` 元数据，**不是工具级强制分层** | [代码] `core/mcp/codemode.go:13-18`；`core/mcp/toolmanager.go:1095-1126` |
| 写路径语义 | 运行期逐次校验每个嵌套调用；auto-execute 白名单是权威闸门（预扫描仅启发式）；批准后的代码不受 auto-execute 约束，但仍受 `tools_to_execute` 约束；写工具重试按 `readOnlyHint/destructiveHint/idempotentHint` **fail-closed** 跳过 | [文档] `docs/mcp/code-mode.mdx:635-663`；[代码] `core/mcp/agent.go:203-261`；`core/mcp/codemode/starlark/executecode.go:288,357,389`；`core/mcp/toolmanager.go:1095-1126` |
| 结果回传 | 只有 `print()` 日志 + `result` 值进入模型；错误值 `hasattr(r,"error")` 由脚本自行处理，`fail()` 主动失败 | [文档] `docs/mcp/code-mode.mdx:701-737`；[代码] `executecode.go:141-200` |

**与我们最重要的差异**：我们有 `execute_read`（工具注册层只读，写工具在 sandbox 里被替换成会抛错的 stub，`src/codemode.js:895,935-949`），Bifrost 是在策略层做白名单。对 Gemini 这种"工具定义稳定性敏感、prompt 注入面大"的 host，我们的分层是更强的安全边界；Bifrost 的分层更依赖配置正确性。

## 4. 定位：LLM gateway / 企业控制面 vs 单用户自托管

- [文档] `README.md:60-63` 明说 MCP gateway 属于"enterprise deployments unlock advanced capabilities"；但 `docs/enterprise/moving-from-oss/overview.mdx:7,27-29` 又说 OSS 是严格子集、MCP servers 可无损迁移，且 `docs/mcp/code-mode.mdx:205-227,230-256` 给出本地 `config.json` + 单客户端启动方式。[代码] `core/mcp/codemode/starlark/` 与 `transports/bifrost-http/handlers/mcpoauth2issuance.go` 都在 OSS 仓库中。
- **结论**：功能代码在 OSS 仓库、可单机跑（SQLite 默认，`docs/enterprise/moving-from-oss/overview.mdx:37`），但产品叙事与收费点是**团队/企业控制面**：virtual keys、MCP Tool Groups、per-tool 定价、审计、cluster、guardrails（[文档] 博客全文；`README.md:96-101`）。单用户自托管是"能跑但不是目标用户"。
- [文档] `transports/changelog.md:12`（Claude Code Gateway Sign-In）、`docs/features/agent-gateway/*`：Agent Gateway / SSO / SCIM / 企业身份体系是主战场。
- [未验证] 是否有面向个人的 hosted 免费层——仓库内无证据；博客只提 Enterprise 14 天试用。

## 5. Eval / capture / scorecard

- [文档] `docs/features/observability/default.mdx:9-11,108,494-512`：请求级日志、token/cost/latency、MCP tool calls 全量入日志；`docs/features/agent-gateway/observability.mdx:107,225-256`：Agent Gateway 支持 **Raw Capture**（默认关，1MiB 上限），OTel/BigQuery 等可导出。
- [文档] `docs/features/observability/maxim.mdx:17,228-249`：Maxim 平台有 evaluation/dataset/scorecard 类能力，但**是外部产品**；Bifrost 仓库本身只是把 trace 转发过去。
- [代码] `plugins/routing/changelog.md:2` 有 complexity router 的 "sampled request capture, impact replay"（路由规则优化用），不是 MCP eval harness。
- **结论**：有日志/raw capture/OTel，有外部 Maxim eval 集成；**仓库内没有**类似我们 `docs/eval/scorecard-*.json`、`scripts/analyze-captures.mjs` 的"capture → 假设 → 本地复现 → scorecard"闭环。[文档] `docs/mcp/code-mode.mdx:36-50` 的基准是独立仓库的一次性报告，不是随代码演进的回归门禁。
- 反过来看，他们的 benchmark 方法论（三轮按工具规模递增、逐 query 明细、披露恶化样本）值得我们抄进 `docs/eval/`。

## 6. 对照我们：同轴/相邻、威胁等级、该抄/不该抄

### 6.1 坐标

- **同轴**：都是"MCP 工具定义太多 → Code Mode 写脚本在 sandbox 内编排 → 只回传最终结果"；都是 4→3 个 meta-tool 级别的接口收敛；都用进程内 JS/Starlark 解释器 + 预算限额；都有 OAuth 2.1 DCR（我们 `src/oauth.js` / `src/vercel-app.js` 已上线）。
- **相邻而非同层**：Bifrost 是 23+ provider 的 LLM gateway + 企业治理控制面，MCP 是其中一条业务线（近 100 commits 里约 9% 提到 MCP）；我们是 Gemini-first 的单用户/小团队 MCP gateway，Code Mode 是主界面。它的 9.9k stars 主要来自 LLM gateway 与性能叙事（[文档] `README.md:200`：5000 RPS 下 11µs overhead），**不是 MCP 部分**。
- **单用户场景**：它可自托管但叙事偏企业；我们在 Vercel 上单用户 OAuth+DCR 已跑通（`AGENTS.md`），这是它没主打的空隙。

### 6.2 威胁等级

**直接竞争威胁：中（对 Gemini web-client 场景低-中；对通用企业 LLM+MCP 平台场景高）。**

- 高的一面：Code Mode 概念、4 工具设计、92.8% 基准叙事、DCR/PKCE、虚拟键/工具组治理、审计、per-tool cost 都已成熟且有文档与代码；若他们补上 Gemini/ChatGPT web client 入口，会直接压到我们的定位。
- 低的一面：[未验证] 无 Gemini/ChatGPT host 支持；无语义 tool search（我们的 `search` 更省一轮 stub 读取）；无 `execute_read` 强分层；MCP 不是其 star 与主叙事来源；其 Code Mode 需要 3+ server / 100+ tools 才划算（[文档] `docs/mcp/code-mode.mdx:64-73`），而我们小工具集场景也有收益。

### 6.3 该抄

1. **基准方法论**：三轮工具规模递增 + 逐 query 明细 + 披露负样本 + 外部独立仓库，用于我们的 `docs/eval/scorecard`（我们已有 capture/scorecard 基础设施，缺的是这种公开可复现的规模对照）。
2. **server instructions 注入点**：上游 handshake 的 instructions 只放进 `.pyi` 顶部、`listToolFiles` 只给指针（`listfiles.go:92-94,146-150`；`docs/mcp/code-mode.mdx:431-449`）——既保留上游提示又不污染每轮 context。我们的 `search` 结果可以做类似处理。
3. **嵌套调用失败语义**：`isError` 返回错误值而非异常、脚本自行 `hasattr(r,"error")` 决策、`fail(r.error)` 主动终止（[文档] `docs/mcp/code-mode.mdx:701-737`）——比我们当前错误传播更明确，值得对照 `src/codemode.js` 的 error path。
4. **限额配置化 + 热重载**：7 项限额、Helm/API/config/SDK 四种入口、nil 恢复默认（`docs/mcp/code-mode.mdx:777-853`；`core/bifrost.go:5107-5127`）。
5. **auto-execute 双层校验**：预扫描启发式 + 运行期逐次权威校验、插件改写名字后按新名字校验（[文档] `docs/mcp/code-mode.mdx:644-659`）——可直接映射到我们 `execute_read`/`execute` 的白名单逻辑。

### 6.4 不该抄

1. **不要为了 92.8% 改成"四个文件树工具"**：我们的 `search` + `select:<name>` 在工具数只有几十个时更省 turn；文件树需要 list→read→(docs)→execute 至少 2-3 轮发现。
2. **不要把读写分层降级为策略白名单**：`execute_read` 在工具注册层拒绝写工具是我们对 Gemini 注入风险的关键防线，Bifrost 只有 `tools_to_auto_execute` + 提示词。
3. **不要引入依赖企业控制面的叙事/架构**（virtual keys / tool groups / SCIM / cluster / guardrails）；那会把单用户自托管的简洁性换掉，且不是我们的差异点。
4. **不要在文档里只写一个百分比而不写口径与负样本**：他们自己 `docs/overview.mdx:90` 的 "50%" 与 detail 页的 92.8% 打架；我们要么写清"up to / 场景 / 样本 / 恶化案例"，要么不写。

## 7. 一句话结论

Bifrost 是**值得跟踪的相邻巨头、不是我们这个 Gemini web-MCP-client 细分市场的头号竞品**：它的 Code Mode 四工具、Starlark 沙箱与 92.8% 基准是真实现且外部可查（但只在 500 工具规模成立），OAuth/DCR/Claude 生态完整；缺口恰好落在我们的强项——Gemini/ChatGPT web client、语义 tool search、`execute_read` 强读写分层、单用户自托管体验、capture→scorecard 闭环。建议威胁等级定为**中**，重点抄它的基准方法论与 instructions/错误语义，不抄它的企业控制面与文件树发现路径。

---

### 附：核验命令备忘

```
gh auth status
gh repo view maximhq/bifrost --json nameWithOwner,stargazerCount,pushedAt,licenseInfo,latestRelease
gh repo clone maximhq/bifrost work/deep-bifrost -- --depth=1
gh api 'repos/maximhq/bifrost/commits?per_page=100' --jq '.[] | .commit.message | split("\n")[0]'
web_fetch https://raw.githubusercontent.com/maximhq/bifrost-benchmarking/main/mcp-code-mode-benchmark/benchmark_report.md
web_fetch https://www.getmaxim.ai/bifrost/blog/bifrost-mcp-gateway-access-control-cost-governance-and-92-lower-token-costs-at-scale
```
