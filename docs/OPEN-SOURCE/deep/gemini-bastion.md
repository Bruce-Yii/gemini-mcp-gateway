# gemini-bastion-mcp 深度核验报告（Kaiserunix/gemini-bastion-mcp）

- 核验日期：2026-11-23（Asia/Singapore）
- 核验方式：`gh auth status`（Bruce-Yii，scopes 含 repo/workflow）→ `gh repo view --json ...` → `gh repo clone Kaiserunix/gemini-bastion-mcp work/deep-gemini-bastion -- --depth=1` → 通读 README/README.zh-CN/DESIGN/PRODUCT_STRATEGY/CHANGELOG/architecture-guardrails、Docker、OAuth/MCP/policy/sandbox 源码与测试。
- 证据标记：**[代码]**（读过的源码/测试，带 `路径:行号`）、**[文档]**（README/docs/changelog/guardrails 原文）、**[未验证]**（无一手证据、需外部条件或只是自述）。
- 范围约束：只新建本文件；未改 src/、scripts/、tests/、README、其他 docs、workflows；**未 commit/push/deploy**。上游 clone 位于 `work/deep-gemini-bastion`（本仓库 work/ 下，本地只读分析）。

## 0. 仓库画像与取证可信度（先看这个，再看功能）

| 项 | 结论 | 证据 |
|---|---|---|
| 仓库身份 | `Kaiserunix/gemini-bastion-mcp`，MIT，TypeScript，默认分支 main | [代码] `gh repo view --json`：`nameWithOwner`、`licenseInfo.key=mit`、`primaryLanguage=TypeScript` |
| Stars / Forks | **1★ / 0 fork**；非归档 | [代码] `gh repo view`：`stargazerCount:1, forkCount:0, isArchived:false` |
| 创建 / 最后推送 | 2026-11-20 / 2026-11-22（**极新项目，约 2 天生命期**） | [代码] `createdAt:2026-11-20T17:55:29Z`、`pushedAt:2026-11-22T03:23:28Z`（API 快照） |
| 本地 HEAD | `182e0c1` `feat(mcp): add MCP_TRUST_SANDBOX_HINTS to stop Web Gemini popup fatigue`，119 files / 47,418 insertions **全部在一个 commit 里** | [代码] `git show --stat HEAD`：119 个文件全是 `create mode`（new file），无历史增量 |
| 版本 | v0.3.0（CHANGELOG 0.1.0→0.3.0 均标 2026-11-21） | [文档] `CHANGELOG.md:7,23,39`；[代码] `src/mcp/server.ts:9`、`package.json:3` |
| 测试声明 | `npm test` = vitest；CHANGELOG 自述「59/59 automated Vitest checks passing」 | [文档] `package.json:51`；`CHANGELOG.md:55-56`（**自述数字，本轮未实跑**）[未验证] |
| 关键可信度警告 | **没有可审计的提交历史**（全量 squash 成 1 commit）；安全审计「Neon + GPT-6.2-Astra xhigh」仅 CHANGELOG 一句话，无报告、无 issue/PR 记录 | [代码] `git show --stat HEAD`；[文档] `CHANGELOG.md:55`；[未验证] 审计真实性 |

**判定**：这是一个非常新、代码量很大但历史不可审计的高活跃个人项目。功能面真有代码，不是空壳；但「安全审计通过」「三客户端全部支持」等强声明需要打折看待（下文逐条标注证据等级）。

---

## 1. 工具面：到底 10 个工具，没有 Code Mode / 工具定义压缩 / progressive disclosure

### 1.1 10 个工具是代码级硬约束（不是 README 口号）

- [代码] `src/mcp/registry.ts:15-26`：`MCP_TOOL_NAMES` 精确列出 10 个名字：`workspace_manage`、`code_explore`、`code_patch`、`workspace_exec`、`dispatch_runner`、`job_status`、`github_inspect`、`infra_inspect`、`stage_mutation_plan`、`publish_changes`。
- [代码] `src/mcp/registry.ts:78-104`：`register()` 拒绝非契约工具（"Refusing to register non-contract MCP tool ... Exact 10-tool surface is enforced"）、拒绝重复注册、只有 `publish_changes` 可声明 `destructiveHint:true` 且必须 `readOnlyHint:false`。
- [代码] `src/mcp/registry.ts:117-126`：`attachToServer()` 默认 `requireCompleteContract=true`，缺任何一个工具就抛错，保证 tools/list 稳定。
- [代码] `src/mcp/tools/index.ts:15-32`：三组注册函数合并出完整 10 工具。
- [文档] `.agents/rules/architecture-guardrails.md:10`：把「Exact 10-Tool Surface」列为强制不变量。

### 1.2 三层 blast-radius 分层（这是它的核心设计，不是 read/write split）

- [文档] `README.md:114-142`：Tier 1（工具 1–8，建议 Always Allow：工作区管理与沙盒写 + 外部只读）、Tier 2（工具 9 `stage_mutation_plan`，零写入的两阶段暂存，15 分钟 TTL）、Tier 3（工具 10 `publish_changes`，唯一外部写闸门，Ask Before Running）。
- [代码] `src/policy/approvalGate.ts:53-65`：`evaluateScope()` 做 `mcp:read` / `mcp:tools` / `mcp:write` scope 判定；`src/mcp/outputGuard.ts:362-382` 在 handler 执行前检查 scope，不足返回 `insufficient_scope` 文本错误。
- [代码] `src/mcp/tools/infraPublishTools.ts:484-492`：`publish_changes` 的 annotations 是 `{readOnlyHint:false, destructiveHint:true, openWorldHint:true}`，`requiredScope:'write'`；同文件 `:437-445` 的 action 枚举 7 种：`github_pr`、`github_pr_review`、`github_comment`、`cloudflare_worker_deploy`、`cloudflare_pages_deploy`、`execute_staged_plan`、`rollback_plan`。

### 1.3 没有 Code Mode / 工具定义压缩 / progressive disclosure

- [代码] 全仓 grep `code.?mode|codemode|progressive disclosure|tool.*compress|compress.*tool` **零匹配**；`package.json:53-63` 依赖里也没有 `@cloudflare/codemode` 或任何沙箱 JS 运行时。
- [代码] `src/mcp/server.ts:26-151`：注册的是 4 个**MCP Prompts**（`review_pr`、`fix_issue`、`resume_workspace_task`、`ops_health_check`），是给模型读的 SOP 文本，不是把工具折叠成 `search`/`execute` 的 Code Mode。
- [代码] `src/mcp/server.ts:11-16`：initialize 时下发 `MCP_SERVER_INSTRUCTIONS` 文本（约 4 行 SOP）——这是"指令压缩"，不是工具定义压缩。
- [文档] `README.md:53,114-116`：明确产品设计就是「不暴露几十个细粒度工具 → 收敛到 10 个复合工具」，靠**复合工具 + 1 审批门**降弹窗，**不是**靠隐藏工具定义或代码编排降 token。
- [文档] `docs/PRODUCT_STRATEGY.md:12-13`：营销语「Stop Clicking 'Allow' 40 Times」，优化轴是**审批弹窗次数**，不是上下文 token。

**结论**：它与我们的 Code Mode 是**不同的优化轴**。它把 40+ 细粒度工具手工合并为 10 个「复合工具」并压到 1 个审批门；我们是把 N 个上游工具折叠成 3 个元工具（`search` / `execute_read` / `execute`），让模型在 QuickJS 里编排。[代码]+[文档]

### 1.4 最有意思的一手细节：`readOnlyHint` 提示层"骗过" Web Gemini 的弹窗

- [代码] `src/config.ts:450`：`mcpTrustSandboxHints: parseBooleanFlag(parsed.MCP_TRUST_SANDBOX_HINTS, true)` —— **默认 true**。
- [代码] `src/mcp/registry.ts:146-159`：当 `trustSandboxHints=true` 时，除 `publish_changes` 外所有工具对外 advertise `readOnlyHint:true, destructiveHint:false`，**覆盖工具自身的真实 annotations**；`publish_changes` 强制保持 `readOnlyHint:false, destructiveHint:true`。
- [文档] `README.md:300`：直言 "Web Gemini ignores 'Always Allow' for `readOnlyHint: false` tools and prompts on every call. By default ... Tools 1–9 advertise `readOnlyHint: true` ... (server-side `mcp:write` scope, checkpoints, and sandbox isolation remain strictly enforced)"。
- [文档] `docs/PRODUCT_STRATEGY.md:29`：项目自身承认这是**标注策略而非真实只读**（"NEVER label Tier 1 simply 'Read-Only'"；Tier 1 里含 `code_patch`、`workspace_exec`、`dispatch_runner` 等本地写）。
- [代码] HEAD commit 标题 `feat(mcp): add MCP_TRUST_SANDBOX_HINTS to stop Web Gemini popup fatigue`（`git log -1`）——这是他们最近一次功能迭代，说明**Web Gemini 弹窗疲劳是他们实测到的真痛点**。

**诚实性备注**：这是"提示层降低弹窗 + 服务端 scope/沙箱兜底"的组合，与我们的 `execute_read` 在**沙箱层真正把写工具替换成抛错 stub**（[代码] 我们 `src/codemode.js`、`docs/COMPETITORS.md:129`）不同。它信任客户端按 hint 免弹窗；我们不依赖客户端行为。[代码]+[文档]

---

## 2. Web Gemini / Claude.ai / ChatGPT 的 OAuth/DCR 适配证据分级

### 2.1 代码层：确实是通用 OAuth 2.1 + PKCE S256 + DCR + RFC 8707/9728

- [代码] `src/auth/dcr.ts:7-8`：`MAX_DCR_REDIRECT_URIS = 16`、`MAX_DYNAMIC_CLIENTS = 500`；`:11-15` 硬编码 Google 专用 redirect 模式（`oauth-redirect.googleusercontent.com/r/*`、`/a/*`、sandbox/test 域、`vertexaisearch.cloud.google.com/oauth-redirect`）；`:207-211` 超过 16 个 redirect URI 返回 400。
- [代码] `src/auth/authorize.ts:17`：`MAX_STATE_BYTES = 8192`；`:472-477` 超长 state 拒绝。
- [代码] `src/config.ts:12-20`：`DEFAULT_ALLOWED_REDIRECT_HOSTS` = `gemini.google.com, aistudio.google.com, accounts.google.com, claude.ai, chatgpt.com, localhost, 127.0.0.1`。
- [代码] `src/mcp/server.ts:175-219`：`STATIC_ALLOWED_MCP_ORIGINS` 同样显式含 `https://gemini.google.com`、`https://aistudio.google.com`、`https://claude.ai`、`https://chatgpt.com`（+ 动态 allowlist/loopback）。
- [代码] `src/auth/discovery.ts` 与 `tests/oauth-gemini-compat.test.ts:100-140`：RFC 9728 `WWW-Authenticate: Bearer resource_metadata=...`、RFC 8414 AS metadata、DCR endpoint 全部端到端测试覆盖。
- [代码] `tests/oauth-gemini-compat.test.ts:217-348`：完整 PKCE S256 流程，state 用 2600+ 字符（`>=2590`）跨错误密码重试逐字节保持，code 单次使用/replay 撤销 token family。
- [代码] `tests/oauth-gemini-compat.test.ts:350-433`：RFC 8707 resource 在 `/authorize`、`/token`、`/mcp` 三处绑定校验（mismatch → `invalid_target`）。
- [代码] `tests/oauth-gemini-compat.test.ts:555-660`：refresh token 轮换 + 60s 并发宽限 + 窗口外重放撤销整个 family。
- [代码] `tests/oauth-gemini-compat.test.ts:1193-1212`：redirect URI 绕过向量（fragment/userinfo/wildcard/encoded traversal）全部 400。
- [代码] `src/auth/upstreamIdp.ts`：额外提供 Google/GitHub 操作员 SSO（README 称 fail-closed：credentials + 非空 allowlist 缺一不可，`NODE_ENV=production` 无 allowlist 直接拒绝启动），见 `tests/oauth-upstream-idp.test.ts`。

### 2.2 证据分级（哪些是一手、哪些只是自述）

| 客户端 | 证据强度 | 依据 |
|---|---|---|
| **Web Gemini (`gemini.google.com` Connected Apps)** | **一手代码+测试，最接近"实测"**（但仍非在真实 Gemini 页面上人工走通） | [代码] Google redirect 模式硬编码于 `src/auth/dcr.ts:11-15`；2600 字符 state 保留测试 `tests/oauth-gemini-compat.test.ts:217-348`；[文档] `README.md:296-300` 详细连接步骤、`:300` 说明 `readOnlyHint` 弹窗行为（应来自真实观察）。[未验证] 没有录屏/截图/issue 证明"在真实 gemini.google.com UI 上成功连接" |
| **Claude.ai Custom Connectors** | **仅通用协议 + 文档声明，无客户端专属测试** | [代码] `src/config.ts:16` / `src/mcp/server.ts:178` 把 `claude.ai` 加入 allowlist；[文档] `README.md:301-303` 称自动 DCR 或静态客户端 fallback；`src/mcp/landingPage.ts:497-500` 给出连接说明。全仓无 Claude 专属 OAuth quirks 测试。[未验证] 真实 Claude.ai 连接器握手 |
| **ChatGPT MCP Connectors** | 同上，**更弱**；且产品文档自承需手动加 host | [代码] `src/config.ts:17` / `src/mcp/server.ts:179` 含 `chatgpt.com`；[文档] `docs/PRODUCT_STRATEGY.md:32` 自承默认 host 列表原本不含它、要求 operator 手动 append（**代码已改但策略文档未同步——文档漂移**）；`README.md:301-303`。[未验证] 真实 ChatGPT 连接器握手；ChatGPT Developer Mode / plan 限制按我们 `docs/OPEN-SOURCE/COMPETITORS.md:115` 的一手平台文档，它 README 未提 |

**结论**：三家都支持的说法在**架构层面成立**（通用 DCR/Streamable HTTP，且把它家的 quirks 做成硬编码常量）；但**只有 Web Gemini 有一手测试深度**（16 URI、8KB state、Google redirect 白名单、弹窗行为）。Claude/ChatGPT 是"按通用标准实现 + README 声明"，与我们的状态（Gemini 实测、Claude/ChatGPT 未验证）差距比 README 口径小得多。[代码]+[文档]+[未验证]

---

## 3. 审批 gate / bwrap 沙箱 / 写路径 / Docker 部署

### 3.1 审批 gate：单闸门 + 两阶段暂存，代码闭环完整

- [代码] `src/policy/approvalGate.ts:41-45`：`DefaultApprovalGatePolicy` 自称 pure/deterministic/default-deny；`:67-126` 保护分支校验（main/master + 传入的 default/base branch，拒绝空名/空格/`..`/`-`前缀/HEAD）；`:198-235` plan 执行校验（必须 `staged` 状态、15 分钟 TTL 未过期、target prefix 匹配）；`:237-273` rollback 校验（必须 `executed`、有 `rollback_payload`）。
- [代码] `src/policy/approvalGate.ts:305-497`：`MutationPlanGate` 的 `executePlan()`/`rollbackPlan()` 在 claim 状态前先做 preDecision+adapter 校验，全程写 `auditLogger` 并过 `SecretScrubber`。
- [代码] `src/core/githubService.ts:404`、`925` 调用 `evaluateProtectedBranch()` 阻断直推。
- [代码] `src/mcp/tools/infraPublishTools.ts:430-492`：唯一 destructive 工具，7 种 action 全部经它出网。
- [文档] `README.md:31-33,137-141` 与 `.agents/rules/architecture-guardrails.md:23-26` 明确"所有外部写必须经 publish_changes"。

### 3.2 bwrap 沙箱：真实现，但有 Linux/宿主能力前提

- [代码] `src/utils/exec.ts:312-356`：`buildBwrapArgs()` 生成 `--die-with-parent --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp --tmpfs <workspacesRoot> [--tmpfs <dataDir>] --bind <workspaceDir> --chdir <chdir> [--unshare-net] -- <cmd>`——默认断网，兄弟 workspace 与 `/data` 用 tmpfs 遮蔽。
- [代码] `src/utils/exec.ts:358-527`：探测 `bwrap` 是否可用（user/mount/net namespace），不可用时 `SANDBOX_STRICT_ISOLATION=false` **降级为 UID-dropped 执行并打 warn**，strict=true 才 fail closed。
- [代码] `src/core/workspaceExec.ts:258-283`、`src/core/agentDrivers/baseCliDriver.ts:258-352`、`src/mcp/tools/execRunnerTools.ts:70-110`：workspace_exec / CLI agent drivers 走 bwrap。
- [代码] `tests/workspace-exec.test.ts:294-336`：断言 `--unshare-net`、`--tmpfs /workspaces`、`--tmpfs /data`、allow_network 时不加 `--unshare-net`、关闭 isolation 时不加 bwrap。
- [代码] `docker/docker-compose.yml:65-68` 注释：Ubuntu/Debian AppArmor 宿主需手动 `apparmor:unconfined` 才能开启嵌套 bwrap，否则**回退到 UID 1002 worker 隔离**——文档承诺的 bwrap jail 在常见宿主上不一定生效。[代码]+[文档]

**诚实性亮点**：[文档] `docs/PRODUCT_STRATEGY.md:30` 自承双 UID 1001/1002 只覆盖 `workspace_exec`/`shell_task`；`validationPipeline.ts` 的 L1/L2 与 `codexRunner.ts`（`CODEX_HOME=/data/codex`）仍以 UID 1001 运行，靠 env allowlist + Codex SDK 的 `workspace-write` sandbox。这是他们自己写进 P0 安全待办的**真实边界**，比 README 的 "6-layer defense-in-depth" 口径诚实。[文档]

### 3.3 写路径黑名单与回滚

- [代码] `src/core/workspaceLock.ts:131-155`：`isSensitiveWorkspacePath()` 硬黑名单 `.env*`、`.dev.vars*`、`.git/config`、`.git/hooks/*`、`*.pem`、`*.key`、`id_rsa*`、`id_ed25519*`，并做 NTFS 尾点/空格归一化防绕过。
- [代码] `src/core/githubService.ts:947-998`：commit/push 前逐文件阻断敏感路径；`src/core/cloudflareService.ts:376,409` 部署前同样检查。
- [代码] `.agents/rules/architecture-guardrails.md:33-35`：pre-patch/pre-agent 用临时 `GIT_INDEX_FILE` + `refs/mcp-checkpoints/*` 做非破坏快照；超限输出 offload 到 `/data/artifacts`，返回 `artifact_id` 由 `code_explore(read_artifact)` 回读。
- [文档] `README.md:326-330`：SecretScrubber 覆盖所有输出/artifact/webhook。

### 3.4 Docker 部署：这是它明显领先我们的一块

- [代码] `docker/docker-compose.yml:21-74`：`gateway` 用 GHCR `lite`/`full` 镜像，`expose:["8787"]` **零宿主端口**，挂 4 个 named volume，`env_file: ../.env`，healthcheck `/healthz`。
- [代码] 同文件 `:76-93`：cloudflared sidecar 只拿 `TUNNEL_TOKEN`（不挂 `.env`，避免泄露 GH_TOKEN/OAUTH_SIGNING_SECRET），走 `edge_net`。
- [代码] 同文件 `:95-167`：两个可选 profile —— `ops`（Bearer 鉴权的 ops-mcp sidecar，`OPS_MCP_AUTH_TOKEN>=24`，`internal: true` 网络）+ `isolated-runner`（UID 1002、无 `/data`、无 SQLite、无 GH/CF/OAuth secrets，`no-new-privileges:true`）。
- [代码] `docker/ops-mcp-auth-proxy.mjs`、`docker/ops-mcp-config.example.json`：MCP-2 federation 的认证代理。
- [代码] `.github/workflows/docker-publish.yml`：打 `v*` tag 先推 GHCR 再用 `mcp-publisher` OIDC 发布到官方 MCP Registry（`server.json`，schema `2025-12-11`）——[文档] `README.md:374-381`。

---

## 4. capture / eval / scorecard：**没有**（它有的是审计日志与使用计量）

- [代码] 全仓无 `captures/`、`evals/`、`scorecards/`、`benchmarks/` 目录（glob 零结果）；grep `capture` 的命中全是 `stage_mutation_plan` 的「rollback snapshot capture」和 JS 测试里的 `capturedCalls` 变量，与"抓包留档"无关。
- [代码] `src/db/repositories/auditRepo.ts`、`usageRepo.ts` + `src/security/auditSink.ts`：记录审计事件、工具调用计数/token 估算/耗时（见 `tests/oauth-gemini-compat.test.ts:972-1025` 的 usage/mark-limit 测试）。
- [文档] `README.md:170,323-330`、`src/admin/ui.ts`： `/admin` PWA 提供 SSE live jobs、KPI、scrubbed audit trail、CI Watchdog 告警——是**运维可观测**，不是 eval 框架。
- [代码] `tests/` 11 个 vitest 文件是确定性单测/e2e，没有 LLM 评判、没有 scorecard、没有每周报告。

**结论**：它在"操作审计/计量"上有东西，在"capture → eval → scorecard 数据闭环"上**完全没有**。这正是我们 `docs/COMPETITORS.md:136-139` 定义的最被低估差异化，差距是结构性的（不是补几个测试能追上）。[代码]+[文档]

---

## 5. 和我们的真实差异（人群最接近，但优化轴不同）

### 5.1 人群重合度：**高**

- [文档] 双方都把 Web Gemini / Claude.ai / ChatGPT 网页版连接器作为首要场景（它：`README.md:9,31`；我们：`docs/OPEN-SOURCE/COMPETITORS.md:96,127`）。都是 single-user / self-hosted 定位（我们明确写在 `README`/`COMPETITORS.md:164,170`；它单操作员 allowlist + 单审批门）。这是竞品里人群最接近的一家。

### 5.2 痛点是否真的重合：**部分重合**

| 痛点 | 它 | 我们 | 是否重合 |
|---|---|---|---|
| Web Gemini 每次调用弹审批窗、手机端点不过来 | ✅ 核心痛点（README 主标题、HEAD commit、`readOnlyHint` 方案） | ✅ 相关但我们的解法是 `execute_read`/`execute` 分层 + 3 工具 | **重合**，但解法不同 |
| 工具定义吃满上下文（506→3 tools 省 99.4%） | ❌ 它不做工具定义压缩，10 个复合工具全量注册 | ✅ 核心卖点（`src/server.js:279-288`、`scripts/measure-context.mjs`） | **不重合** |
| 模型写 JS 编排多个上游调用 | ❌ 无 Code Mode | ✅ QuickJS `search`/`execute_read`/`execute` | **不重合** |
| 需要真正写代码、跑测试、发 PR、管 Cloudflare | ✅ 核心场景（bwrap + 多 agent driver + publish_changes） | ❌ 我们是通用上游工具聚合，不做工作区/DevOps 垂直 | **不重合**（它是垂直应用，我们是通用层） |
| 全量 capture + eval 证明优化有效 | ❌ 无 | ✅ L0/L1/G6/scorecard | **不重合** |
| Docker 一键自托管 | ✅ GHCR lite/full + 3 profile | ❌ 我们只有 npm/Vercel（见 `COMPETITORS.md:158`） | **它赢** |
| 三客户端 DCR 适配 | ✅ 架构齐 + Gemini 一手测试 | Gemini 实测，Claude/ChatGPT 未验证 | **它文档口径领先，实测口径接近** |

### 5.3 它赢 / 我们赢

**它赢的点**：
1. **审批 UX 的真实场景理解**：`readOnlyHint` 默认 true + 服务端 scope 兜底，是针对 Web Gemini 客户端行为的一手工程对策（[代码] `src/mcp/registry.ts:146-159`、`src/config.ts:450`）。
2. **端到端"手机 prompt → PR"产品闭环**：工作区管理 → bwrap 沙箱测试 → 单闸门发 PR，有完整代码与 UX 设计文档（[代码] `README.md:40-47`；[文档] `docs/UX_EXPERIENCE_AND_DESIGN_SPEC.md`）。
3. **Docker/GHCR/OCI 分发 + MCP Registry**：零构建镜像、sidecar profile、官方 registry 发布（[代码] `docker/docker-compose.yml`、`server.json`）。
4. **OAuth 边界测试深度**：16 redirect URI、8KB state、token family 撤销、redirect 绕过向量，测试很扎实（[代码] `tests/oauth-gemini-compat.test.ts`）。
5. **自承边界的诚实文档**：`PRODUCT_STRATEGY.md:23-34` 的"Anti-Overpromise Contract"列了 5 条自打脸式真相对照（Qualify Dual-UID、不叫 Tier 1 "Read-Only" 等）。

**我们赢的点**：
1. **Code Mode 三工具 + 沙箱内读写分层**：`execute_read` 真正把写工具替换成抛错 stub，不依赖客户端对 hint 的解读（[代码] 我们 `src/codemode.js`、`src/server.js:285-288`）。
2. **QuickJS 引擎级隔离 + 逃逸回归测试**（[文档] 我们 `docs/SANDBOX-SECURITY.md`）——bwrap 是 OS 级进程沙箱，两者不同层；我们的 guest JS 无 process/require/fetch。
3. **全量 capture → L0/L1/G6 → scorecard 的可评测闭环**（[文档] 我们 `docs/OBSERVABILITY-AND-EVAL.md`、`docs/eval/`）——它完全没有。
4. **上下文定量证据**：506→3 tools 的 token 实测可离线复现（[文档] 我们 `docs/WHY.md`）；它的 10 工具是固定面，没有"省定义"的量化命题。
5. **真实写路径验证 ledger**（[文档] 我们 `docs/ledger/batch-10-write-semantics.md`、`docs/eval/write-replay-2026-11-23.md`）；它只有单测和 audit log。

### 5.4 威胁等级

**低—中（产品叙事层面中等，技术替代层面低）。**

- 低的原因：定位不同——它是**垂直 DevOps 应用网关**，我们是**通用 Code Mode 工具面层**。它不会替代我们的 `search`/`execute_read`/`execute`；它甚至可以被我们当作一个上游 MCP 来聚合（它暴露标准 Streamable HTTP `/mcp`）。
- 中的原因：人群与 web client 叙事高度重合，且它在"三客户端 DCR + 单审批门"上先发了完整文档与 Docker 分发；在 lead 的竞品排名里它被列为主竞品之一（[文档] 我们 `docs/COMPETITORS.md:16,99`）。当 HN/V2EX 叙事比拼"谁更适合手机网页版改代码"时，它的完整产品故事有传播优势。
- 不可忽略：它迭代极快（2 天内 3 个版本 + HEAD 直接针对 Web Gemini 弹窗），且 `readOnlyHint` 这类技巧如果成为 web client 生态共识，可能被平台/其他网关复制。[代码]+[文档]（威胁判断为分析结论，非事实标记）

### 5.5 最该抄的 3 点（按优先级）

1. **P0 — Web Gemini 弹窗 UX 的一手对策**：把「`MCP_TRUST_SANDBOX_HINTS` 默认 true，把 Tier 1/2 工具的 `readOnlyHint` 对外标 true，服务端继续强制 scope/写闸门」做成我们 3 工具的可配置注解策略。理由：这是它 HEAD commit 亲自修的真痛点，我们虽用 `execute_read` 分层但 `execute` 在 Gemini 侧仍可能每次弹窗；可以只给 `execute_read` 标 `readOnlyHint:true`，`execute` 保持 false，把"少弹窗"从 10 工具方案迁移到 3 工具方案。证据：[代码] `src/mcp/registry.ts:146-159`、`src/config.ts:450`；[文档] `README.md:300`。**抄法建议**：加配置开关 + README 明示"hint 是 UX 层，不是安全边界"，不要直接照抄 10 工具分层。
2. **P1 — Docker/GHCR 零构建分发 + 官方 MCP Registry**：最小 `Dockerfile` + `docker-compose.yml`，镜像推 GHCR，`server.json` 走 `mcp-publisher` OIDC。这是竞品对比表里我们最显眼的 table-stakes 缺口（[文档] 我们 `docs/COMPETITORS.md:158,196-205`）。证据：[代码] `docker/docker-compose.yml:21-74`、`README.md:374-381`。**抄法建议**：只抄单容器 gateway + 无宿主端口 + healthcheck + `.dockerignore`，不抄它的 3 sidecar profile（超出我们 single-user 定位）。
3. **P2 — Anti-Overpromise 对照表做法**：把 `docs/PRODUCT_STRATEGY.md:23-34` 那张"每条安全声明 ↔ 代码真实行为 ↔ 文档措辞规则"的表引入我们的 `docs/OPEN-SOURCE/DIFFERENTIATION.md` 或 README 的 "Not trying to be" 段落。理由：它的这张表比任何营销文案都更能建立高信任开发者口碑，且其中"hint ≠ 真只读""双 UID 只覆盖部分路径"两条对我们同样适用（我们的 QuickJS sandbox 也要写清"不等于 OS 级隔离"）。[文档]

**不建议抄**：10 工具复合面、bwrap + 多 agent driver 的 DevOps 垂直栈、MCP-2 federation sidecar、CI Watchdog——都与我们的定位冲突（[文档] 我们 `docs/COMPETITORS.md:168-175`）。

---

## 6. 证据索引（可复查）

- 仓库：<https://github.com/Kaiserunix/gemini-bastion-mcp>（`gh repo view` 抓取 2026-11-23）
- 主页：<https://kaiserunix.github.io/gemini-bastion-mcp/>
- 关键本地路径（相对本仓库根）：`work/deep-gemini-bastion/README.md`、`src/mcp/registry.ts`、`src/mcp/tools/infraPublishTools.ts`、`src/mcp/server.ts`、`src/policy/approvalGate.ts`、`src/utils/exec.ts`、`src/auth/dcr.ts`、`src/auth/authorize.ts`、`src/config.ts`、`tests/oauth-gemini-compat.test.ts`、`docker/docker-compose.yml`、`docs/PRODUCT_STRATEGY.md`、`docs/GEMINI_GEM_PROMPT.md`、`.agents/rules/architecture-guardrails.md`
- 本项目对照：`docs/OPEN-SOURCE/COMPETITORS.md:99,127-151,154-165`、`src/server.js:279-288`、`docs/SANDBOX-SECURITY.md`、`docs/OBSERVABILITY-AND-EVAL.md`、`docs/eval/`
- 平台一手约束（我们已抓，见 `docs/OPEN-SOURCE/COMPETITORS.md:114-116`）：<https://developers.google.com/connected-apps/mcp/oauth>、<https://help.openai.com/ko-kr/articles/12584461-developer-mode-apps-and-full-mcp-connectors-in-chatgpt-beta>、<https://support.claude.com/zh-CN/articles/11175166-使用远程-mcp-开始使用自定义连接器>

## 7. 维护说明

- 本文只做证据化核验与对比，**不构成任何代码变更依据**；文中「抄法建议」需 lead/人审确认后才可能进入 backlog。
- 未实跑该项目的 `npm test`（本轮为静态源码核验），「59/59 passing」仍为 [未验证] 自述。
- 需复核的未决项：[未验证] Claude.ai / ChatGPT 真实连接器握手；[未验证] 其安全审计（CHANGELOG 一句话）的实际报告；[未验证] `bwrap` 在目标宿主是否真的可用（AppArmor 限制下降级为 UID 隔离）。
