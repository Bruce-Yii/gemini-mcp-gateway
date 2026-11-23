# 跨模块 / 分层 / 用户旅程 / 交叉关系架构审计（00-crosscut）

> 审计日期：2026-11-24（Asia/Singapore）。只读审计，**未改 src/、scripts/、tests/、README、其他 docs、workflows；未 commit/push/deploy**。
> 本报告是**自包含的新增文件**，不修改任何现有文档。框架性结论仍以 `docs/FRAMEWORK.md` 为唯一入口（AGENTS.md §0），本报告是对它的**交叉校验**，不是替代。
> 证据口径：区分「文档自述」与「代码/运行证据」；测试绿 ≠ 验收。凡运行证据缺失处一律标 `NOT VERIFIED` / `unknown`，不补造。

---

## 0. 证据分级与阅读约定

| 标记 | 含义 |
|---|---|
| **【文档】** | 仅来自 FRAMEWORK / ARCHITECTURE / HANDOFF / ACCEPTANCE / EVALUATION / INDEPENDENT-REVIEW 等文档自述 |
| **【代码】** | 在 `src/`、`api/`、`tests/`、`scripts/` 中读到具体实现，附文件:行 |
| **【运行】** | 有命令输出/线上 healthz 证据（本报告为只读审计，运行证据仅引用已有文档记录，未重新实测） |
| **【缺口】** | 文档要求但代码/运行未覆盖，或代码存在但文档未建模 |

已知运行基线（来自 `INDEPENDENT-REVIEW` 与 `ACCEPTANCE`，**本报告未重新实测**）：
- 生产曾部署 `d1f36ba`（02:57 手动部署，healthz `commit=d1f36ba`/`buildHash=a1002d86`，门 A/构建可追溯 PASS）；push→production 自动部署已关（`git.deploymentEnabled.main=false`），branch push 仍出 preview。
- 全量测试以 lead 最近一次实跑为准：`1406 tests / 1400 pass / 0 fail / 6 todo`（AGENTS.md 记录；独立审查当时为 1381/1375）。
- V0 验收：门 A PASS，B FAIL（真实客户端未跑），C PARTIAL（真实写回环 ad-hoc 跑通、CI 被 billing 阻塞），D FAIL（授权生命周期），E FAIL（baseline=none），F PARTIAL（真实 401/Docker/npm audit 未做），G FAIL（独立评测未跑）——**整体 NOT ACCEPTED**。
- 认证状态：`docs/AUTH-READY.md` = **NOT READY**，不得找用户授权。

---

## 1. 六模块是否覆盖用户口述；并列 / 上下层 / 交叉；依赖图

### 1.1 用户原文六模块 vs 文档覆盖（【文档】FRAMEWORK §0/§2）

| 用户口述模块 | FRAMEWORK 落点 | ARCHITECTURE 落点 | 覆盖判定 |
|---|---|---|---|
| ① 核心底座（可替换，省上下文/多步/跨上游，按客户端替换） | §2 模块一 + §8.1-8.2 | L2 Execution Core | **已覆盖**，但「按客户端替换」在代码里只做到 v1/v2 路由 + 静态 profile，见 §4 |
| ② 客户端（Gemini/ChatGPT/Claude 网页非代码模式 + 接入 + 适配 + 主动被动评测） | §2 模块二 + §11 + §13.1 | L1 Client Adaptation | **已覆盖并纠正**（§11/§13.1 把"非 Code Mode 客户端"改为"客户端的非代码模式"） |
| ③ 评测体系（离线复用+优化 / 主动+被动线上 / 采集层 session·project·task 交叉 / 主动反哺被动） | §2 模块三 + §4 | L4 Evidence & Eval | **已覆盖**（三/四线齐全），但采集层字段落地不全，见 §3 |
| ④ 上游接入（GitHub/Notion/Linear/Vercel + 后续候选 + 授权第一 + 首次引导 + SOP） | §2 模块四 + §5 | L3 Upstream Integration | **已覆盖**；Figma 已在代码/文档中（ARCHITECTURE L3 列表含 Figma），属文档滞后而非代码缺失 |
| ⑤ 运行时/部署（Vercel/内网穿透/本地容器/服务器，费用风险） | §2 模块五 + §6 | L5 Runtime & Deployment | **已覆盖**，Docker/npm audit 未验（【运行】） |
| ⑥ 开源工程（依赖前五层，发布前问题后置，治理调研） | §2 模块六 + §7 | L6 OSS Release（支撑层） | **已覆盖**；未公开，仅本地产物 |
| 用户特别强调的「六模块交叉、上层/底层」 | §3 分层与交叉 + §12 遗漏 | ARCHITECTURE §3/§5/§6 | **已覆盖并被扩展**（FRAMEWORK §12 增补 14 项遗漏，§13 定稿） |

结论：**用户口述的六个模块在文档层被完整覆盖，且 FRAMEWORK §11–§14 做了重要纠偏**；但「文档覆盖」不等于「代码/运行实现」，交叉项的执行所有权、状态隔离、并发调度在代码层多为**约束声明或单测**，未形成端到端机制（见 §2–§7）。

### 1.2 并列 / 上下层 / 交叉关系判定

**不是纯并列。** 按用户旅程与依赖方向，六模块分为三层：

```text
场景层（上层，用户视角）：⑤ 运行时/部署 → ② 客户端 → ④ 上游 → 首次授权/使用
                              │
功能层（横向能力）：① 核心底座   ③ 评测体系   ⑥ 开源工程（支撑）
                              │
横切层（贯穿）：授权/owner · 隔离(client/session/project/task/grant) ·
                并发/限流 · 采集 · SOP · 成本/预算 · 结果契约 · 协议版本
                              │
底层复用：执行底座 · 评测方法 · 认证框架 · 结果规范化/canonical
```

- **上下层**：⑤→②→④ 是用户旅程的"选择顺序"（部署→客户端→上游），上层模块借用下层能力；③ 评测与 ① 底座是"偏底层/复用"（用户原话）。
- **并列**：① 与 ④ 在 ARCHITECTURE 里是相邻的两层（Execution → Upstream），但用户明确二者是"底座 vs 上游"的能力分工，存在**调用关系**而非纯并列。
- **交叉（用户明确点名 + 文档确认）**：客户端×底座、客户端×评测、上游×评测、上游×授权、运行时×客户端（隔离/并发）、运行时×开源、评测×采集、开源×全部（FRAMEWORK §3.3 表）。

### 1.3 依赖图（代码落点，【代码】）

```text
                          api/index.js (5 行，仅 createAppHandler)
                                │
                          src/vercel-app.js  ── healthz/route/captureedge/OAuth 路由
                                │
   ┌────────────────────────────┼─────────────────────────────┐
   │                            │                             │
src/oauth.js              src/upstream-oauth.js        src/server.js
(客户端 OAuth/DCR,            (上游 grant 授权)          (MCP 协议/工具注册)
 client 锁定)                                              │
                                                     ┌────┴─────┐
                                                     │          │
                                          mode=codemode      mode=whitelist
                                          ├─ codemode.js      └─ buildToolRegistry
                                          ├─ codemode-v2.js         (whitelist + gateway_call/search)
                                          └─ typed-plan.js (host 执行引擎)
                                                     │
                                   src/client-profile.js / sanitize.js
                                   src/tool-format.js / result-normalize.js / github-helpers.js / file-write.js
                                                     │
                                            src/upstreams.js (UpstreamManager)
                                            ├─ upstream-auth.js ──► store.js (Upstash KV)
                                            ├─ upstream-oauth.js
                                            ├─ config.js
                                            └─ figma-guard.js (实例内 Figma quota breaker + 读缓存)
                                                     │
   capture 横切：vercel-app.js 与 server.js 双入口 startCapture() → src/capture.js
                 → src/capture-queue.js → src/project-tag.js（request→project 派生）
                 → scripts/analyze-captures.mjs / capture-digest.mjs / eval-cycle.mjs
```

关键方向约束（【文档】ARCHITECTURE-PROGRESSIVE L1「硬规则」）：
- 不允许 Client 直接依赖 Upstream；不允许 Upstream 反向依赖 Client；
- 不允许 Evidence 反向控制执行；不允许 OSS 进入核心运行时；
- 跨模块只通过接口/数据，不通过全局状态。

【代码】核对：主链路符合该方向（`server.js` 用注入的 `upstreamManager`，`client-*` 只做编码/检测，`capture*` 只观测）。**但存在一处反例**：`codemode.js` 直接 import `typed-plan.js` 的 `executeTypedPlan`（codemode.js:54），并在 guest 侧暴露 `codemode.runTypedPlan`（codemode.js:191）——这是"底座内部桥接"，未破坏工具面，但意味着执行底座不是完全可插拔的独立实现，Typed Plan 通过 Code Mode 的桥被调用。选型时须注意。

---

## 2. 用户旅程：文档顺序 vs 首次使用真实顺序

### 2.1 用户构造的场景（【文档】FRAMEWORK §0/§3.1）

用户描述的旅程：**部署 → 客户端（可能多个）→ 上游（可能多个）→ 首次接入/授权 → 日常使用 → 评测/优化**。上层问题：一网关多客户端隔离、一网关多上游隔离/限流、多客户端并发+上游并发限制、免费/会员计划、底层复用。

### 2.2 首次使用的真实顺序（【文档】FRAMEWORK §12.11 已提出纠正）

FRAMEWORK §12.11 明确：「产品 onboarding 顺序：部署 → 上游授权 → 客户端连接，可能不是用户自然的"部署→客户端→上游"」。代码事实支持这一纠正：

- **必须先部署**：`api/index.js` → `createAppHandler`，所有能力由 HTTP 入口提供（【代码】）。
- **上游 grant 是"配置/环境先于请求"**：`availableServers()` 会过滤掉 `tokenEnv` 未设置的 server（vercel-app.js:138-143）；UpstreamManager 在首个已认证 `/mcp` 命中时才 `connect()` 并 `listTools()`（vercel-app.js:178-187）；token 通过 env seed 或 OAuth callback 预置（upstreams.js:231-277, upstream-auth.js:851-887）。**没有"在网页客户端里首次添加上游"的产品化流程代码**。
- **客户端 OAuth 在网关自身**：`/oauth/register`、`/oauth/authorize`、`/oauth/token`（vercel-app.js:391-399）是客户端拿到访问网关的 bearer token 的流程；客户端需要先有网关 URL + 一个 OAuth 连接。
- **「引导性问题/首次使用流程」目前是 docs 层面的承诺**：FRAMEWORK §2 模块四"首次使用引导流程"、模块二"客户端接入引导"；实际是 `docs/CLIENTS*.md`、`docs/UPSTREAMS.md` 等静态文档，**没有 onboarding wizard/代码**（【代码】全仓未见引导路由/交互流程）。

**差距**：文档已经把"部署→上游授权→客户端"记为未决/纠正项，但代码层没有把它产品化；用户"反复授权很无语"的痛点（FRAMEWORK §0/§2 模块四）目前靠 `static_bearer`/owner 标记 + vault 预置缓解，而非终端用户友好的首次引导（见 §7 P1）。

### 2.3 多客户端隔离（【代码】+【文档】缺口）

- `resolveClientProfile()` 把平台识别为 gemini/chatgpt/claude/unknown，只影响**结果编码**（structuredContent / annotations 默认补齐），明确声明"不是多租户/安全层"（client-profile.js:3-7, 229-241）。
- `detectClientPlatform()` 同样是 observability only，明确"NEVER used by write paths, idempotency keys, permissions, tool names/count/schema, or upstream auth decisions"（client-platform.js:9-22）。
- 网关入站认证只做 `store.getToken(token)` + 过期检查（vercel-app.js:289-299）；token 记录里有 `clientId`/`scope`/`resource`（oauth.js:669-677），但**请求处理路径未绑定 clientId 到会话/工具权限**（vercel-app.js 未设置 `__gatewayOAuthClientId`，capture 的 `oauthClientId` 通常为 null，见 capture.js:91-98）。
- 文档结论（ARCHITECTURE §1「单 owner、单租户；不做多租户隔离」）与用户场景「一网关多客户端如何隔离」（FRAMEWORK §3.1/§13.6）**存在张力**：代码目前是"单 owner + 多个客户端连接，但客户端之间不隔离，共享同一 OAuth grant 池与同一工具面"。`docs/CLIENTS-CHATGPT.md:98-101` 甚至明确："本服务不按 plan gate 工具名，持有效 token 的调用方仍能调用 `gateway_call`/`execute`"。

**判定**：多客户端隔离在代码层是 **NOT IMPLEMENTED（仅 profile 编码层区分）**；FRAMEWORK §9未决 #3、§13.6 已识别，但未进入验收门。

### 2.4 多上游

- `UpstreamManager.connect()` 用 `Promise.all` 并行连接所有上游，单失败不拖垮（upstreams.js:323-329）；`failedServers` 记录失败，`codemode.services()` 暴露 point-in-time 快照（codemode.js:128）。
- 每个上游 grant 由 v2 KV key 隔离：`gmcgw:v2:grant:<environment>:<owner>:<server>`（upstream-auth.js:46, 188-191）；owner∈{gateway,dsh,manual}，未标记=shared 禁止 refresh（upstream-auth.js:78, 218-232）。
- **共享点**：同一环境、同一 owner 下，所有客户端共用同一个 `<server>` 的 grant（key 里没有 clientId）；多客户端写同一上游时用同一凭证，无法按客户端审计 grant 使用。
- Figma 有实例内 quota breaker + 读缓存（upstreams.js:225-226, figma-guard.js），但**是 per-instance 内存态**，serverless 多实例下不共享（【代码】）；其余上游无统一限流/调度器。

### 2.5 并发 / 限流

- **令牌刷新并发**：设计最完整。同实例 `_refreshPromises` 合并（upstream-auth.js:718-729）；跨实例 Redis 租约 + owner token + CAS fencing + 租约续期 + 失效 grant 不动终态（upstream-auth.js:317-387, 653-687, 731-843）；store 层提供 `casToken`/`releaseLease`/`renewLease` Lua（store.js:100-162）。
- **工具调用预算**：Code Mode 每 `execute()` 默认 `DEFAULT_MAX_CALLS=50`（codemode.js:56）；v2 plan I/O budget（`DEFAULT_V2_MAX_CALLS=50`，codemode-v2.js:145-146）；`maxWhitelistTools`/`maxResultChars` 由 config 注入（vercel-app.js:180-185）。
- **多客户端并发调度 / 上游并发限制**：无全局队列或背压；FRAMEWORK §9未决 #4、§12.3 已列缺口，`docs/ACCEPTANCE.md` 无对应门。**判定：只有"刷新并发"和"单请求预算"，没有"多客户端→多上游"的调度层**。

### 2.6 免费 / 会员计划

- 【文档】FRAMEWORK §2/§9：计划差异"与是否免费无关，可能影响自定义 MCP 权限"；未决 #5「免费/会员计划差异如何建模」。
- 【代码】无 plan 字段、无基于计划的工具裁剪；`docs/CLIENTS-CHATGPT.md:17` 记 Free 无自定义 connector UI，"Not supported; no promise"；:98-101 明确服务端不按 plan gate。
- **判定：未建模**。

### 2.7 成本

- 【文档】FRAMEWORK §13.4-13.5：token 成本靠上下文节省；搜索 API（Firecrawl/Exa）浪费调用可去重/缓存/裁剪/合并；存储成本不独立成层；默认部署无扣费风险。
- 【代码】`figma-guard.js` 有读缓存（唯一落地的"调用节省"）；codemode 的 `search`/`select:`/结果裁剪是 token 节省手段；没有通用搜索 API 去重/预算/合并模块（候选上游 Firecrawl/Exa/Tavily 尚未接入）。
- **判定：成本作为"实现约束/原则"存在，未形成可度量的成本模型或保护机制**（除 Figma 缓存）。

---

## 3. 跨模块状态：client / session / project / task / grant / request —— 哪些字段存在、哪些缺失；隔离边界

| 状态维度 | 代码中存在的字段/键 | 位置 | 缺失 / 未落地 |
|---|---|---|---|
| **request** | `requestId`（随机 UUID）、path/method、raw body/headers、status、durationMs、events、`deployment`(commit/buildHash) | capture.js:668, 766-804 | —（最完整的一维） |
| **session** | `sessionId`（initialize 时 randomUUID，通过 `Mcp-Session-Id` 回显；**仅 correlation key，transport 无状态**） | server.js:552-567, 565-566；capture.js:712/770 | 不是服务端会话态，不能承载跨请求上下文；用户"长会话重连"验收门 B 未跑 |
| **client** | `clientInfo`（initialize 的 params.clientInfo）、`clientPlatform`/`clientProfile`/`oauthClientId`（capture 附加，observability only） | capture.js:771-774, 117-135；client-platform.js | 无 client instance id；`oauthClientId` 常为 null（vercel-app 未附加）；平台识别不参与权限/隔离 |
| **project** | `projects[]` + `primaryProject`（`github:<owner>/<repo>`，纯函数从 request 派生，tool-args>code-literal>pr-url 置信度） | project-tag.js:140-246；capture.js:797-803 | 只覆盖 GitHub owner/repo；Notion/Linear/Vercel 项目不派生；来自 request 而非 upstream result（设计取舍） |
| **task** | 评测侧 N1–N9 / J1–J6 / F1–F6 任务集（`explore/tasks-online-gap*.json`），capture envelope **无 taskId 字段** | EVALUATION §4；capture.js envelope 766-804 | capture 与 eval 任务之间无 `taskId` 关联字段；在线反馈 F 行 `requestId: unknown`、`captureVerified:false`（INDEPENDENT-REVIEW R5）；task↔capture join 靠人工/文档 |
| **grant** | v2 key `<env>:<owner>:<server>`；记录含 `access_token/refresh_token/client_id/client_secret/expires_at/envSeed/owner/source/environment/grantId/bootstrapped/needsReauth/status/reauthReason/updatedAt` | upstream-auth.js:188-202, 483-500, 871-884 | 生产 env 缺显式 owner（独立审查 R2，历史）；key 无 clientId/会话维度；未标记 grant=shared 拒绝 refresh |
| **access token(客户端)** | `clientId/scope/resource/tokenHash/refreshTokenHash/issuedAt/expiresAt` | oauth.js:663-678；store.js:320-325 | 请求路径只校验 token 存在/未过期，未用 clientId 做隔离；`resource` 不核验 aud（CLIENTS-CHATGPT:108-110） |

**隔离边界判定**：
- **最强的隔离**：grant 按 `environment × owner × server`（可防跨环境/跨 owner 串用）【代码】。
- **中等隔离**：平台 profile 仅编码隔离；请求 raw + project 标签可观测隔离。
- **弱/无隔离**：客户端之间无工具权限隔离、无 clientId→grant 绑定、无会话级状态；同一环境内所有客户端共用 grant 池与工具面。
- **FRAMEWORK §12.2「单 owner 不等于单客户端」** 这一未决问题，代码尚未回应；ARCHITECTURE「不做多租户」是**有意的产品边界**，但需要在文档里明确"多客户端 ≠ 多租户"的边界线，否则用户场景与产品边界会持续冲突（见 §7 P1）。

---

## 4. 执行所有权：网页客户端 vs Code 模式客户端；网关 vs 客户端 agent loop

### 4.1 两类客户端的分工（【文档】FRAMEWORK §11/§12.1/§13.1）

- **网页非代码模式（主战场）**：客户端不能跑代码、MCP 优化不足 → 网关 Code Mode 价值最大。目标平台 Gemini / ChatGPT / Claude 逐个做（接入→测试→优化→评测→回归）。
- **Code 模式客户端（Claude Code/Codex 等）**：FRAMEWORK §13.1 明确"不是当前主战场，只作为后续兼容对象"；§12.1 提醒"网关可能是冗余/补充，需要单独策略"。
- 【代码】实际应用 `applyProfileToTools` 对所有 profile 保持 annotations 不变（client-profile.js:229-241），没有针对 Code 模式客户端的独立工具面/策略。

### 4.2 网关 vs 客户端 agent loop（避免重复编排）

- **设计意图**：3 工具 + `search` 发现 + `execute(_read)` 内做多步，结果只回传摘要 → 把"多步编排"收进网关沙箱，避免模型上下文爆炸（codemode.js:1-17, server.js instructions 324-334）。
- **执行器选择**（【文档】ARCHITECTURE §5 / PROGRESSIVE L2）：Gemini→Typed Plan/Code Mode fallback；强模型→Code Mode；宿主支持 tool search→Native；未知→Code Mode。
- 【代码】实情：
  - `isV2` 由 `/mcp/v2` 路径 + `ENABLE_MCP_V2=1` 决定（server.js:51-53, 488-490）；
  - `mode=whitelist|codemode` 由网关 config 决定（vercel-app.js:181），**不是按客户端 profile 动态选择**；
  - v1 `execute` 入参是 `code`，v2 才是 `plan`（codemode.js:1889-1892 vs codemode-v2.js:96-127）；
  - v2 的 `execute` 同时允许 `plan` 或 `code` 回退分支（codemode-v2.js:108-115）。
- **判定**：「底座按客户端替换」在代码里是**部署开关（路径 flag）+ 配置 mode**，不是"检测到 Gemini 就自动用 Typed Plan"。客户端 agent loop 与网关沙箱之间**没有显式"谁规划"的协商**；同一任务若客户端自己也做多步工具调用，仍可能双重编排。FRAMEWORK §12.1 的执行所有权问题被识别但未形成机制；A/B 切换默认执行器被 AGENTS §9 明确禁止（"没有 A/B 数据时默认切 typed-plan"）。

### 4.3 权限来源边界（与 §6 联动）

- host approve（top-level `approve` / dryRun）是**服务端代码级安全闸**：`validateTypedPlan` 拒绝 per-step `approve`（APPROVAL_REQUIRES_HOST）与 `allowTruncatedRead`，写 op 必须 dryRun 或 host 白名单（typed-plan.js:233-253）。
- 这是"网关内部授权"，**不是** MCP 客户端 UI 的确认；二者职责不能被混用（见 §6）。

---

## 5. 主动/被动评测与工具级真值的跨模块流；capture→eval→fix→deploy 闭环；canary 是否现在做

### 5.1 主动 vs 被动的跨模块流（【文档】FRAMEWORK §4/§13.2-13.3, EVALUATION §3）

```text
主动线上评测（人/agent 在真实客户端提问，requestId 有时 unknown）
  → 新维度/高价值缺陷 → 形成 F 行 + N/J/T 任务 + 确定性测试
  → 被动 capture 采集（full-fidelity）+ 工具级真值核验
  → 用主动结论校准被动规则 → 被动逼近主动 → 降低主动频率/成本
```

- **工具级真值**（FRAMEWORK §13.3）：评的是工具调用而非模型思考——参数契约、返回 schema/字段/字节、上游真实结果一致、写后副作用、同 args 重放一致。被动缺"任务级预期"但有"工具级可核验真值"（重放对比、上游 API 核验、schema 断言、主动任务标签回填、fixture 对照）。
- 【代码】支撑：capture full-fidelity envelope（capture.js:766-804）；model-output truncation audit（capture.js 138-146）；project 派生（project-tag.js）；`scripts/replay-online-session.mjs`、`scripts/analyze-captures.mjs`（免费模型输出仅假设，见 AGENTS §1）；`docs/eval/ONLINE-FEEDBACK.md` schema；F/G 矩阵 + N1–N9 + J1–J6（EVALUATION §4-5）。

### 5.2 capture→eval→fix→deploy 闭环状态（【文档】+【代码】）

| 环节 | 状态 | 证据 / 缺口 |
|---|---|---|
| capture（full-fidelity） | **代码就绪** | capture.js envelope；capture-queue.js 异步队列 + DLQ；AGENTS §6 明确禁止对 capture 做隐私过滤 |
| 模型可见错误脱敏 | **代码就绪** | `modelErrorMessage`/`redactSecrets`（tool-format.js），server.js:68-76 |
| online intake | **框架就绪，真实数据弱** | `scripts/record-online-feedback.mjs`；F1–F6 `requestId: unknown`、`captureVerified:false`（INDEPENDENT-REVIEW R5） |
| F 矩阵 / G1–G6 / N-J 任务 | **文档就绪** | EVALUATION §3-5；`docs/eval/` |
| 确定性回归测试 | **部分就绪** | `tests/online-gap-tasks.test.js`、`tests/online-semionline-join.test.js`、`tests/l1-smoke.test.js` 等存在；但 replay/e2e 是 fixture + fake store/upstream（INDEPENDENT-REVIEW R5） |
| 旧/新构建同任务对照 | **未做** | 门 E FAIL，baseline=none；自动部署（历史）让旧构建消失（ACCEPTANCE §1 E） |
| 部署后在线复验 | **未做** | F1/F2 pending-deploy；F3–F6 代码层修但无真实复验（EVALUATION §6） |
| baseline/join 更新 | **未冻结** | EVALUATION §6.1「J1–J6 已接 L1 profile，但 baseline 尚未冻结」 |

**闭环判定**：链路在**文档/脚本/测试骨架层闭合**，但在**真实 capture→真实 requestId→旧新构建对照→部署复验**层断裂。最关键的断点是"没有真实 requestId 的 capture 能进 eval 并闭环"（INDEPENDENT-REVIEW R5），以及"自动部署曾使对照构建消失"（R1）。测试绿不能替代这些门（ACCEPTANCE §0）。

### 5.3 canary 是否现在做（【文档】明确结论）

**不做。** FRAMEWORK §13.7 明确「暂不引入 canary/shadow/复杂发布工程：先把真实客户端/写回环/授权做通」；EVALUATION §4 标 canary/shadow ❌；ACCEPTANCE §0 把"没有 canary"列为不算验收的原因之一但不是当前待办。前置条件（门 B/C/D/E 的真实证据）未满足前做 canary 无意义——没有可被分流的真实流量与可对照的构建。建议顺序：**先补 B/C/D/E 的真实证据 → 冻结 baseline → 再评估 canary**，与 FRAMEWORK §13.7 一致。

---

## 6. 审批/权限：客户端 annotations 与网关 approve 的职责边界；Gemini destructive/openWorld 弹窗；重复确认

### 6.1 代码事实（【代码】+【文档】FRAMEWORK §14）

三工具 annotations（codemode.js:1867, 1894-1896；whitelist 模式 gateway_call/search 见 server.js:223/239）：

| 工具 | readOnlyHint | destructiveHint | openWorldHint |
|---|---|---|---|
| search | true | false | false |
| execute_read | true | false | **true** |
| execute | false | **true** | **true** |

**网关 approve 边界**：`validateTypedPlan` 只允许 host top-level `approve`/`dryRun`，拒绝 per-step approve（typed-plan.js:233-253）；v2 schema 有 plan-level `dryRun`/`approve` 入参（codemode-v2.js:115-125），由 host 解释。客户端 annotations 是**提示**，不是安全边界（FRAMEWORK §14「不要用 annotations 伪装安全」；client-profile.js 注释"annotations are not a security boundary"）。

### 6.2 Gemini 弹窗问题判断（【文档】FRAMEWORK §14 + 【代码】）

- 公开资料+社区实测：destructiveHint / openWorldHint 会触发确认，无 readOnlyHint 被视为可能 destructive；即便 Gemini 设成"允许"，强提示仍可能强制确认 → **双触发**：`execute_read` 的 `openWorldHint:true` + `execute` 的 `destructiveHint:true`（FRAMEWORK §14 §1-3）。
- **代码现状对 §14 建议的偏离**：FRAMEWORK §14「建议先做 B 的实验 profile（Gemini: execute_read openWorldHint=false；execute destructive/openWorld=false），不改默认/ChatGPT/Claude；同时做 D（网关内把客户端已发起的 execute 视为 host approval，减少重试叠加确认）」。
  - 【代码】`applyProfileToTools` **对所有 profile 保持 annotations 完全一致**（client-profile.js:229-241），没有实验 profile；`createCodeModeTools` 的 annotations 是固定写死（codemode.js:1894-1896）。
  - 【代码】没有"客户端已确认 → 网关视为 host approval"的通路；网关的 approve 仍是纯代码级 dryRun/白名单，且 v2 的 per-step approve 被明确拒绝。
  - **判定：§14 建议的 B/D 均未实现**。当前"重复确认"风险：模型被网关拒绝写（APPROVAL_REQUIRES_HOST / dryRun 默认）后重试，可在客户端触发更多次确认（FRAMEWORK §14 §4 已识别）。
- **职责边界结论**：客户端权限设置是用户意图第一权威；网关只做代码级安全闸，不叠加用户审批；不应靠撒谎 annotations 降弹窗。要降弹窗只能走"实验 profile + 真实 Gemini 窗口验证"，当前未做（FRAMEWORK §14 待验证清单）。

---

## 7. 架构缺口清单（P0/P1/P2）+ 渐进式延伸 + 底层可复用方法/SOP

### P0（阻塞"真实可用"，必须先解决）

1. **真实客户端任务（门 B）**：Gemini/ChatGPT 10 条受控任务 + exact tool call/args/actual/requestId（ACCEPTANCE B；当前 FAIL）。
2. **真实写回环（门 C 完整化）**：read→patch→commit→PR→CI + 写后字节对账 + 失败无半成品；CI 被 billing 阻塞需绕开（ACCEPTANCE C PARTIAL）。
3. **授权生命周期（门 D）**：gateway-owned grant 显式 owner + 重启/72h/REAUTH 实测；AUTH-READY NOT READY 不得找用户授权。
4. **入站 origin 一致性（历史 R3）**：issuer/resource/401/CIMD 三处曾指向 `yu-ac3a`（独立审查 R3）；d1f36ba 声称已修但**未在真实客户端验证**。
5. **preview/production KV 隔离（历史 R4）**：d1f36ba 声称新增检查脚本，但 env 是否实际拆分未有运行证据。
6. **在线↔半在线真实闭环（门 E/G）**：真实 requestId capture、baseline 冻结、旧/新构建同任务对照、独立 evaluator（R5 / ACCEPTANCE E/G）。
7. **模型可见错误真实 401 脱敏 + Docker build + npm audit（门 F）**：当前仅代码/离线测试（ACCEPTANCE F PARTIAL）。
8. **多客户端隔离边界的产品决策**：明确"多客户端≠多租户"边界；至少把 clientId 绑定到请求/审计链，避免共享 grant 无区分（§2.3/§3，FRAMEWORK §12.2）。

### P1（架构成型与体验）

9. **客户端 annotations 实验 profile（Gemini 弹窗）**：FRAMEWORK §14 方案 B+D，真实窗口验证后再决定全局策略；当前完全未实现（§6.2）。
10. **首次使用引导/onboarding**：部署→上游授权→客户端的真实顺序产品化（FRAMEWORK §12.11、模块四"引导性问题"）；当前仅静态文档。
11. **并发/限流调度层**：多客户端并发 + 上游并发限制的统一队列/背压；当前只有刷新并发与单请求预算（§2.5）。
12. **采集层字段补全**：capture 增 `taskId`、client instance id；让 session/project/task/request 真正可 join（§3，FRAMEWORK §4 关键要求）。
13. **执行器按客户端选择的证据**：A/B 后再决定默认；当前 mode 是配置/flag，非 profile 驱动（§4.2，AGENTS §9 禁止无数据默认切）。
14. **计划权限建模**：Free/Plus/企业差异如何 gate（FRAMEWORK §9未决 #5）；当前服务端完全不按 plan gate（CLIENTS-CHATGPT:98-101）。
15. **上游扩展 SOP 落地**：Firecrawl/Exa/Tavily 等搜索 API 的去重/缓存/预算/合并（FRAMEWORK §13.5）；当前只 Figma 有缓存。

### P2（治理与未来）

16. 其他执行底座调研（FRAMEWORK §9未决 #1）；Grok/Muse/Manus 同类问题（#2）。
17. 容器本地部署是否过重、其他免费平台无扣费风险调研（#7/#8）。
18. 被动评测自动逼近主动、采样偏差/标注层（§12.5-12.6）。
19. 开源治理（许可证/安全披露/兼容/贡献，§12.12/§7）；未公开前不建远端。
20. canary/shadow/回滚（§5.3）——**当前不做**，前置门满足后再议。

### 渐进式延伸（与 ARCHITECTURE-PROGRESSIVE 一致）

- L0 一屏：保持"1 让客户端只看见 3 工具；2 沙箱执行；3 连真实上游；4 证明能用；5 跑起来；6 交付别人"。
- L1 模块卡片/依赖方向：作为扩展检查表，新增能力先归层，不打破"Client↔Upstream 不直连、Evidence 不反向控制执行"。
- L2→L3：新客户端/上游/执行器/评测集/部署载体分别只改对应模块；跨模块契约（版本/安全/数据）在 L3 统一。
- 每次只加一层能力：**先真实证据（P0）→ 再隔离/体验（P1）→ 再治理/扩展（P2）**，与"少部署、批量部署"纪律一致（AGENTS §8）。

### 底层可复用方法 / SOP（【文档】FRAMEWORK §5）

- 客户端 SOP：接入方式 → schema/profile/编码 → 计划/权限 → 主动任务 → 被动采集标签 → 适配优化 → 回归与文档。【代码】已有 profile/encoding/检测；**计划/权限与采集标签未完整落地**。
- 上游 SOP：传输/端点 → 授权 owner → 工具清单 allow/deny → 官方/权威任务集 → 离线评测 → canonical/写路径 → 限流/并发/失败 → 文档与开源引导。【代码】授权 owner、catalog、canonical、原子写、刷新并发较完整；**限流/并发调度与官方任务集覆盖不足**。
- 统一横切方法：owner 标记 + v2 KV 隔离（auth）；full-fidelity capture + 模型可见脱敏（evidence）；无静默截断 + 字段级元数据（结果契约）；3 工具名/序/schema 冻结 + `/mcp/v2` 版本路径（协议）；dryRun/host approve（写安全）。

---

## 8. 文档自述 vs 代码/运行证据 —— 不把测试绿当验收

### 8.1 明确区分

| 主题 | 文档自述 | 代码证据 | 运行证据 | 判定 |
|---|---|---|---|---|
| 六模块覆盖 | FRAMEWORK §2/§3 完整 | ARCHITECTURE 六层对应源码 | — | **文档+代码一致** |
| 底座按客户端替换 | FRAMEWORK §8.2 | mode=config、v2=flag、profile 仅编码（server.js/vercel-app.js） | A/B 未做 | **文档超前于代码** |
| 多客户端隔离 | FRAMEWORK §3.1/§13.6 列为未决 | profile observability-only；无 clientId→grant 绑定 | 真实多客户端未跑 | **未实现** |
| 主动/被动闭环 | FRAMEWORK §4/§13.2；EVALUATION §3 | capture/replay/L1/intake 脚本齐 | F1–F6 requestId unknown、baseline none、旧新对照未做 | **骨架闭合、真实链断** |
| annotations 实验 profile | FRAMEWORK §14 建议 B+D | 未实现（client-profile.js 保持全 profile 同 annotations） | 真实 Gemini 弹窗未测 | **文档建议未落地** |
| 授权独立/owner | AGENTS §2；FRAMEWORK §8.4 | v2 key+owner gate+CAS 完整 | AUTH-READY NOT READY；生产 owner 历史缺失 | **代码强、运行弱** |
| 测试绿 | 1406/1400/0 fail/6 todo | 测试覆盖广 | fake upstream/fixture/store；117 skip 非 pass | **测试绿≠验收**（ACCEPTANCE §0） |
| 部署状态 | d1f36ba 手动部署、A PASS | 自动部署已关 | healthz 曾核 commit；真实客户端未验证 | **构建可追溯≠线上可用** |

### 8.2 审计原则声明（与 HANDOFF / ACCEPTANCE / INDEPENDENT-REVIEW 一致）

1. **不把"文档写了"当"已实现"**：本报告中标注为"未实现/未落地"的项均以代码为准（§2.3/§4.2/§6.2）。
2. **不把"测试通过"当"真实可用"**：L1/G6 用 fake upstream、replay 用 fixture、local-e2e 用 fake token store（INDEPENDENT-REVIEW §2/§6）；117 skip 是私有 fixture 不存在（ACCEPTANCE §0）。
3. **不把"部署成功"当"验收通过"**：健康 uptime/commit 可核，但上游过期会静默降级，healthz 不连上游（INDEPENDENT-REVIEW R2）。
4. **不跨构建硬比、不编造 requestId、不把 durationMs/bytes 换算 tokens/p95、客户端宿主问题记 unknown**（AGENTS §3、EVALUATION 硬规则）。
5. **免费模型（analyze-captures）输出仅是待验证假设**，不驱动改代码/开 issue/部署（AGENTS §1）。

### 8.3 给 lead 的三条最高优先建议（只读结论，不执行）

1. 先止血并补真实证据：门 B/C/D/E 的真实客户端、真实写回环、真实授权、真实 capture requestId + baseline 对照；在此之前不做 canary。
2. 把"多客户端隔离"与"客户端 annotations 实验 profile"两项从 FRAMEWORK 未决/建议推进为**有验收判据的任务**（前者至少要 clientId 绑定审计链，后者要 Gemini 真实窗口验证），否则用户口述的交叉场景持续悬空。
3. 每次框架/架构变化仍只写 `docs/FRAMEWORK.md`（本文件是审计快照，不是新的架构沉淀入口）；修正 FRAMEWORK §12/§13 中已被代码证伪或尚未落地的条目时，标注"代码状态"而非"设计目标"。

---

> 结尾声明：本报告为只读审计产物，仅新增本文件；未触碰 src/scripts/tests/README/其他 docs/workflows，未 commit/push/deploy。所有"未验证/未实现"结论均基于上述代码行与已有文档运行记录，未补造任何数据。
