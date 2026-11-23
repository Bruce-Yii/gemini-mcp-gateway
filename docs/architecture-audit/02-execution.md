# 架构深读审计 02 — 核心底座 / 执行模块（Execution Core）

> 只读审计：**仅新增本文件**；未改 `src/`、`scripts/`、`tests/`、README、其他 docs、workflows；未 commit / push / deploy。
> 审计日期锚点：2026-11-24（Asia/Singapore）。代码视角为本地工作树，不代表线上已生效；生产事实以 `docs/FRAMEWORK.md`、`AGENTS.md` 的记录为准。
> 证据强度约定：**[代码]** 已在源文件逐行核对；**[文档]** 来自本任务必读 docs/ledger；**[测试]** 来自列出的测试文件断言；**[未验证]** 无证据，不写成 PASS。
> 必读依据：`docs/FRAMEWORK.md`（§0 用户原文 / §2 模块一 / §4–§5 / §11–§14）、`docs/ARCHITECTURE-PROGRESSIVE.md`（模块 2、L2/L3）、`src/codemode.js`、`src/codemode-v2.js`、`src/typed-plan.js`、`src/tool-format.js`、`src/result-normalize.js`、`src/file-write.js`、`src/github-helpers.js`、`scripts/typed-plan-spike.mjs`、`scripts/typed-plan-ab.mjs`、`scripts/mcp-v2-smoke.mjs`、`tests/typed-plan-*.test.js`、`tests/codemode-ergonomics.test.js`、`tests/mcp-v2-smoke.test.js`、`docs/ledger/batch-14-typed-plan*.md`。

---

## 0. 结论摘要（不美化）

- **主执行底座是 Code Mode**（自由 JS + QuickJS 沙箱），已落地且是当前唯一生产默认：`mode: 'codemode'`（`config.example.json:2`），`/mcp` 三工具 `search` / `execute_read` / `execute` 全部走 `src/codemode.js::createCodeModeTools()`。**[代码][文档]**
- **Typed Plan 已实现但默认不启用**：执行器 `src/typed-plan.js` 为生产级纯模块；接入形态有两个——v1 沙箱 helper `codemode.runTypedPlan()`（`src/codemode.js`）与 v2 版本路由 `POST /mcp/v2`（`src/codemode-v2.js` + `src/server.js`）。两者都**必须显式 opt-in**：`/mcp/v2` 只有 `ENABLE_MCP_V2 === '1'` 才存在，否则 404；`runTypedPlan` 只在模型主动调用时才走。**[代码]**
- **Native / Hybrid 执行器不存在**：架构文档把它们列为候选与默认策略（`ARCHITECTURE-PROGRESSIVE.md` L2-4 选择策略表），但仓库里没有对应实现、接口文件、开关或测试。**[代码][文档]**
- **执行所有权未定**：当前规划权在"客户端模型写 JS / plan"，执行权在网关沙箱；客户端 agent loop 与网关的分工没有明确契约，`FRAMEWORK.md` §12-1 把它列为未决问题。**[文档]**
- **按客户端替换底座未实现**：有 client profile（编码差异）与 v1/v2 端点分流，但**没有"按客户端自动选择执行器"的路由/协商/配置**；切换 profile = 换 MCP URL + 重新 initialize，是运维动作，不是按客户端自适配。**[代码][文档]**
- **A/B 无真实数据**：`scripts/typed-plan-ab.mjs` 是离线骨架，默认 fake，门槛明确 `NOT_ENOUGH`、`defaultSwitchAllowed:false`；N1–N9 的多数任务因 registry 表达力不足触发 `fallback.reason=2` 走 code 分支。没有 real/Gemini ≥3 重复的证据，不得切换默认。**[代码][文档][测试]**
- 成熟度总评：**Code Mode L3**（生产默认、沙箱/预算/结果/写路径齐全）；**Typed Plan 内核与路由 L2–L3**（代码+测试强，但 flag/spike 色彩、无真实客户端验证）；**按客户端替换 / Native / Hybrid L0**（只停留在架构文档）；**上下文预算策略 L2**（字符级截断+标记，无 token 级预算与分层策略）；**执行所有权契约 L0–L1**。

---

## 1. 用户原话校验（FRAMEWORK.md §0，逐字为最高意图来源）

> 原话要点来自 `docs/FRAMEWORK.md` 第 16 行"第一是核心底座……"段；下方按语义逐条核对，不扩写、不编造。

| # | 用户原话要点 | 当前实现事实 | 状态 |
|---|---|---|---|
| 1 | "核心底座的作用是**节省上下文 多步骤执行 跨上游的工具调用**" | **节省上下文**：Code Mode 只让函数返回值入模（`codemode.js:9-10`、`toModelOutput` 剥离 `toolCalls`/`logs`），结构化截断见 `tool-format.js`；**多步骤**：沙箱内 `await codemode.<tool>()` 顺序/并发、`safeAll`、typed-plan 6-op 顺序执行；**跨上游**：`upstreamManager.getEntries()/callTool()` 统一桥接已挂载的多上游工具（`codemode.js:1852-1906`） | 三项均有代码实现 **[代码]** |
| 2 | "分别是 **codemode typed plan native hybrid** 等等我不知道还有没有更好的" | Code Mode、Typed Plan 有实现；Native、Hybrid **无实现、无文件、无开关**；`FRAMEWORK.md` §9-1 "还有没有更合适的执行底座"仍列未决 | 2/4 落地，候选开放 **[代码][文档]** |
| 3 | "这个核心底座是**根据客户端替换**的" | 有 client profile 编码差异（`client-profile.js`、`toModelOutput(wire, profile)`）与 v1/v2 端点隔离；但**没有按客户端自动选底座的机制**：切换靠换 URL/重新 initialize 的运维 opt-in，`ARCHITECTURE-PROGRESSIVE.md` 的选择策略表（Gemini→Typed Plan、强模型→Code Mode 等）没有对应代码 | **不符合**：文档策略未落地 **[代码][文档]** |
| 4 | "对客户端暴露的主接口仍是 3 个稳定工具"（FRAMEWORK.md §2 整理） | v1/v2 都只返回 `['search','execute_read','execute']`，同名同序同 annotations；`plan` 是入参不是第 4 工具；`runTypedPlan` 是沙箱 helper（`tests/typed-plan-integration.test.js:307-348` 逐字断言） | 符合 **[代码][测试]** |
| 5 | "底座替换不应改变读/写/授权/结果契约"（FRAMEWORK.md §2 整理） | 读写分离（`execute_read` 只读过滤/写工具 stub、typed-plan `readOnly` 服务端硬拒）、dryRun/approve 门、canonical/截断/编码链在 v1/v2 共用；A/B 选择策略表要求协议/版本兼容 | 基本符合（换底座不改契约）**[代码][文档]** |
| 6 | "积极/被动线上评测……按客户端做适配优化"（§2 模块二/三交叉） | 有 A/B runner、conformance matrix、capture 标签设计；但真实客户端主动评测数据缺失，见 §4 缺口 | 框架有、数据缺 **[文档]** |

**结论**：用户点名的三项底座作用均有代码支撑；四种候选只落地两种；"按客户端替换"是**当前最大偏差**——架构文档写了策略，代码里没有按客户端选执行器的实现，v2 flag 也非"自动按客户端"而是显式 opt-in。

---

## 2. 实现清单（3 工具 / search / execute_read+execute / 沙箱 / 预算 / plan-code / v2 flag / fallback / 结果截断 / 写审批 / 上下文预算）

### 2.1 对外三工具（工具面冻结）

| 项 | 文件/位置 | 事实 |
|---|---|---|
| 三工具工厂 | `src/codemode.js:1847-1931` `createCodeModeTools()` | 返回 `[searchTool, makeExecute('execute_read',true), makeExecute('execute',false)]`，固定顺序 **[代码]** |
| `search` 工具 | `src/codemode.js:1859-1882` | 两种模式：关键词 → 紧凑列表；`select:<name>` → 完整 schema；描述带 `callName` / `access` / `services` 后缀；annotations `{readOnlyHint:true,destructiveHint:false,openWorldHint:false}` **[代码]** |
| `search` 共享搜索 | `src/codemode.js:995-1018` `searchWithFallback()` | v1 外部 handler 与沙箱内 `codemode.search` 共用同一搜索函数，空结果回退到最长 token / 服务前缀；`select:` 不走 fallback **[代码]** |
| `execute_read` / `execute` | `src/codemode.js:1884-1927` `makeExecute()` | 入参 `{code:string}`（`required:['code']`）；`execute_read` 过滤只读工具并给写工具绑 stub（`:1899-1900`、`:1532-1541`）；`execute` 全量工具。**annotations**：read `{true,false,true}`、write `{false,true,true}` **[代码]** |
| 模型输出投影 | `src/codemode.js:714-729` `toModelOutput()` | 剥离 `toolCalls`/`logs`/`toJSON`，保留 `isError`/`status`/`error`；按 profile 调 `encodeModelOutput`（Gemini 无 structuredContent）**[代码]** |
| 三工具不变测试 | `tests/typed-plan-integration.test.js:307-348`、`tests/typed-plan-v2-route.test.js:115-149`、`tests/mcp-v2-smoke.test.js` | v1 三工具 schema/名/序/annotations 逐字断言；v2 同三工具、无第 4 工具 **[测试]** |

### 2.2 沙箱（执行边界）

| 项 | 文件/位置 | 事实 |
|---|---|---|
| 沙箱引擎 | `src/codemode.js:1571-1583` `runInSandbox()` | Vercel `run` SDK（硬化的 QuickJS，worker 线程）；guest 无 `process`/`require`/`fetch`/Node 全局，原型冻结；限 `timeoutMs`/`cpuTimeoutMs`/`maxResultBytes:16MB`/`maxBridgeRequests:2048`；host 桥接注入为非可猜名 `__dshHostBridge9f4c2a`（F-06）**[代码]** |
| Guest prelude | `src/codemode.js:153-499` `GUEST_PRELUDE` | 重建 `TextEncoder`/`URL`/`atob`/`crypto`/`console`/timer shim + `safeAll`/`unwrapBatch`/`grepSnippet`/`fileResult`/`readFileRange`/`applyPatch`/`writeFiles`/`fetchAllPages`/`repoGrep`/`waitForPRChecks`/GitHub Actions helper 等；所有暴露值经 `__dshHide` 处理 **[代码]** |
| 工具绑定安全 | `src/codemode.js:1255-1264`、`:1450-1482`、`:1517-1546` | `RESERVED_TOOL_IDENTS` 过滤 `__proto__`/`constructor` 等不可信工具名；bridge 只接受 registry 自有键；工具名同时按 sanitized ident 与原名绑定；`validateToolArgs()` 预检必填/基本类型 **[代码]** |
| 错误与脱敏 | `src/codemode.js:952-976`、`src/tool-format.js:24-65` | 模型可见错误经 `redactSecrets`/`modelErrorMessage` 脱敏（Bearer/ghp_/ghp_/API key 等）；原始 `Error.message` 保留给 capture（full-fidelity）**[代码]** |
| 墙钟超时 | `src/codemode.js:841-850` `withDeadline()` + `:1622-1631` | host 侧 `totalTimeout`（默认 `max(timeout*2,1000)`）兜底 `await callTool()` 挂起；abort 让 `run` 退出阻塞 worker；错误转结构化 `makeErrorOutput` **[代码]** |

### 2.3 预算 / 上下文预算

| 项 | 文件/位置 | 事实 |
|---|---|---|
| 单次 execute 工具调用预算 | `src/codemode.js:56-58` `DEFAULT_MAX_CALLS=50`、`DEFAULT_MAX_RESULT_CHARS=20000`；`:1245-1253` `chargeBudget()` | 每次上游 I/O（工具调用 / typed-plan IO / github_actions REST / waitForPrChecks 轮询）共用一个 `calls` 计数，`> maxCalls` 抛 `TOOL_CALL_LIMIT_EXCEEDED`（stable code）**[代码]** |
| 只读去重缓存 | `src/codemode.js:1231-1234`、`:1465-1480` | 单次 execute 内相同只读调用（工具+参数稳定 key）复用首次结果、不重扣预算；写调用不去重 **[代码]** |
| 返回值字符预算 | `src/codemode.js:1608-1619`、`:631-686` | `truncateResultValue(maxChars)` + `withTruncationMetadata()`：字段级截断元数据 `{truncated,field,totalChars,tail,next}`；`truncateResponseText` 追加 `--- TRUNCATED ---` 与定位提示 **[代码]** |
| 截断算法 | `src/tool-format.js:107-382` | water-filling 结构截断，保 valid JSON；对象保留 top-level keys 摘要、数组报原长度、字符串带总长；图片 base64 不截断（走 native image block）；`isExplicitTruncationFlag` 统一 truthy 语义（F-08）**[代码]** |
| 上下文预算策略 | `docs/FRAMEWORK.md` §13.4、"核心底座细分设计"，`ARCHITECTURE-PROGRESSIVE.md` L2-6 | **是字符级截断/摘要/结果表示的横切策略，没有 token 级预算、分层压缩、会话级上下文账本**；`FRAMEWORK.md` §12-7 列为遗漏项，§13.4 收编为底座子设计 **[代码][文档]** |
| v2 预算对齐 | `src/codemode-v2.js:145-189` | `makeChargeBudget`/`budgetIO` 给 typed-plan IO 套同样的 `maxCalls` 计数，`runChecks` 为本地 stub 不计费，等价 v1 语义（F-04 残余）**[代码]** |

### 2.4 Plan / Code 双路径

| 项 | 文件/位置 | 事实 |
|---|---|---|
| Typed Plan 内核 | `src/typed-plan.js:281-370` `executeTypedPlan()` | 纯模块：whole-plan 校验先行、顺序执行、失败即停；6 op `readFileRange`/`repoGrep`/`ensureBranch`/`applyPatch`/`openPr`/`runChecks`；无注入 `io` 时 fail closed；稳定结果 `{ok,dryRun,steps,stoppedAt,error,meta}` **[代码]** |
| 6 op 与复用 | `src/typed-plan.js:54-133`、`:39` | `applyPatch` 复用 `file-write.js::applyTextPatch`（不复制 diff 解析）；截断读硬门 `PATCH_READ_TRUNCATED`，唯一例外是 host `allowTruncatedRead:true` **[代码]** |
| v1 沙箱 helper | `src/codemode.js:191`、`:1319-1356` | `codemode.runTypedPlan(plan,opts)` 走同一 host bridge；host 强制 `readOnly`（execute_read 上下文）、`dryRun` 默认 true；64 步上限；错误转稳定 `{ok:false}` 数据，不崩沙箱 **[代码]** |
| 默认真实 IO adapter | `src/codemode.js:1089-1199` `createDefaultTypedPlanIO()` | 读复用 `github__get_file_contents` / list+read，写复用 `create_or_update_file`/branch/PR 工具；每个 invoke 走统一预算；`fileTextFromRaw()` 对截断返回 `truncated:null`（未报告≠false）**[代码]** |
| v2 plan 路径 | `src/codemode-v2.js:96-137`、`:231-271`、`:283-356` | `execute_read` 仅接受 `plan`（读 op enum 3 个）；`execute` `oneOf` 二选一 `plan`/`code`（6 op）+ `dryRun`/`approve`；plan handler 调 `executeTypedPlan` 并打 `meta.protocolVersion/planVersion/profile/fallback`；`code` 分支复用 v1 handler 并加 `fallback.reason=4` **[代码]** |
| A/B 骨架 | `scripts/typed-plan-ab.mjs`、`scripts/typed-plan-spike.mjs` | F=v1 code、S=v2 plan+fallback；fake model/IO 注入；40 条任务集接口、A1–A7 门槛；**默认 fake、无网络、无真实模型**；详见 §4 **[代码][文档]** |

### 2.5 v2 flag 与 fallback

| 项 | 文件/位置 | 事实 |
|---|---|---|
| 唯一开启条件 | `src/server.js:51-52` `isMcpV2Enabled(env)` | `env.ENABLE_MCP_V2 === '1'` 严格字符串；`'true'`/`'1 '`/`undefined` 均关闭 **[代码][测试]** |
| 路由分发 | `src/server.js:477-613`、`src/vercel-app.js:181,233` | `/mcp/v2` 仅 flag on 存在；flag off 时 404（不进 capture envelope，仅 audit skip）；`/mcp/v3` 404 不降级；v2 与 v1 共用 OAuth/capture/transport **[代码]** |
| discovery 可加标签 | `src/server.js`（`createGatewayServer`） | v2 `serverInfo` 加 `version:'0.1.0+v2'` 与 `_meta.gateway={protocolVersion:'v2',planVersion:'v2.0.0',supportedInputModes:['plan','code'],profile:'S'}`，v1 无该字段 **[代码][文档]** |
| fallback 可观测 | `src/codemode-v2.js:333-349`、`:210-223` | code 分支 `meta.fallback={reason:4,attemptPlan:false,atStep:null}`；plan 分支 `meta.fallback:null`；设计稿 4 种 reason 中**目前代码只写 reason 4**（模型直接传 code），reason 1/2/3 需 session 计数器，属后续 A/B runner 工作 **[代码][文档]** |
| smoke | `scripts/mcp-v2-smoke.mjs`、`tests/mcp-v2-smoke.test.js` | 9 项检查：v1 形状不变、v2 形状、plan 成功、readOnly 拒写、write 需 approve、v1 忽略 plan、输入互斥、flag off 404、401 挑战；loopback + fake，不写 `process.env` **[代码][测试]** |
| 生产默认 | `config.example.json:2`、`src/vercel-app.js` | 默认 `mode:'codemode'`；**`ENABLE_MCP_V2` 生产未开启**（AGENTS.md/ledger 多次记录 flag 默认关闭，未经真实客户端验证不切） **[文档]** |

### 2.6 写审批 / 结果归一化

| 项 | 文件/位置 | 事实 |
|---|---|---|
| 写门（typed-plan） | `src/typed-plan.js:143-257` | 授权**只来自 host**：`dryRun:true`（preview）或顶层 `approve`；per-step `approve` 一律 `APPROVAL_REQUIRES_HOST` 拒绝；`readOnly` 服务端硬边界 **[代码][测试]** |
| 写门（Code Mode） | `src/codemode.js:1450-1452`、`file-write.js:246-326,524-699` | `execute_read` 写工具 stub 抛"use execute()"；多文件优先 `github__push_files` 原子提交，失败零写；非原子失败返回 `partial:true/written/remaining/compensation` **[代码]** |
| 结果规范化 | `src/result-normalize.js:419-745` | `normalizeFileResult`/`normalizePrResult`/`normalizeIssueResult` 恒定字段集；`content` 恒为纯正文（download notice 入元数据）；PR `number` URL 优先，`id`/`nodeId` 永不兜底；`explainTruncation()` 单一真值源；raw 以 `rawUntrusted` 非枚举标记 **[代码][测试]** |
| 结果解包 | `src/tool-format.js:449-585` `unwrapResult()` | 保 `text`/`resource`/`image`/`audio`/`resource_link` 全块；`structuredContent` 仅在无其它块时直接返回；单文本 JSON 自动 parse；isError 抛脱敏错误 **[代码]** |
| 主机侧编排 helper | `src/github-helpers.js` | 注入式 `ensureBranch`/`upsertPr`/`fetchAllPages`/`repoGrep`/`canonicalResult`/GitHub Actions REST 只读 helper/`waitForPrChecks`；truncated 跨页/跨文件透传；token 不回显 **[代码]** |

### 2.7 必读文件 → 实现/测试/标志速查

| 类别 | 文件 | 角色 |
|---|---|---|
| 核心实现 | `src/codemode.js` | v1 Code Mode 唯一生产底座：三工具、沙箱、预算、截断、写路径、typed-plan helper 桥 |
| 核心实现 | `src/codemode-v2.js` | `/mcp/v2` 工厂：plan/code 二选一 schema + handler，复用 v1 search/code |
| 核心实现 | `src/typed-plan.js` | 纯执行器：6 op、whole-plan 校验、审批门、6 步结果 |
| 核心实现 | `src/tool-format.js` / `src/result-normalize.js` | 解包/截断/脱敏 / canonical 归一化 |
| 核心实现 | `src/file-write.js` / `src/github-helpers.js` | 纯 patch/原子写 / 幂等/分页/REST helper |
| Spike/骨架 | `scripts/typed-plan-spike.mjs` / `scripts/typed-plan-ab.mjs` / `scripts/mcp-v2-smoke.mjs` | 原型 / A/B 骨架 / 离线 live smoke |
| 测试 | `tests/typed-plan-{spike,engine,security,integration,v2-route,ab}.test.js`、`tests/codemode-ergonomics.test.js`、`tests/mcp-v2-smoke.test.js` | 全离线、fake IO/HTTP，覆盖安全/形状/路由/门槛 |
| 标志 | `ENABLE_MCP_V2`（严格 `'1'`，默认关）；`mode:'codemode'`（默认）；`config` 的 `maxCalls`/`maxResultChars` | 切换开关与预算配置 |
| 台账 | `docs/ledger/batch-14-typed-plan{,-spike,-engine,-v2,-v2-route,-integration,-security,-ab}.md` | 设计→原型→内核→接入→路由→安全→A/B 的全过程证据 |

---

## 3. 成熟度分级 L0–L3（证据）

> 分级口径：L0=只有概念/文档；L1=代码原型或 spike/flag；L2=独立模块+离线测试齐备、可 opt-in；L3=生产默认且有真实链路验证。**本地测试绿 ≠ 线上验收。**

| 能力 | 级别 | 证据 | 说明 |
|---|---|---|---|
| Code Mode 三工具 + 沙箱 + 截断 + 写路径 | **L3** | `src/codemode.js` 全链路；`tests/codemode-ergonomics.test.js`；`AGENTS.md` §4–§5；生产 `/mcp` 默认 | 生产默认底座；"线上已验收"仍不成立（真实客户端/写回环未完成，AGENTS.md §0） |
| Typed Plan 执行内核（模块） | **L2–L3** | `src/typed-plan.js` + `tests/typed-plan-engine.test.js`(12/12) + `security.test.js`(18/18) | 生产级纯模块，但默认非用户入口；通过 helper/flag 才可达 |
| Typed Plan 经 `codemode.runTypedPlan` 接入 | **L2** | `src/codemode.js` helper + `tests/typed-plan-integration.test.js`(16/16) | 沙箱内可用；生产默认脚本不调用它；需模型主动写 helper 调用 |
| `/mcp/v2` plan 路由 | **L2（flag-gated）** | `src/codemode-v2.js` + `tests/typed-plan-v2-route.test.js`(20/20) + `scripts/mcp-v2-smoke.mjs` 9 检查 | **flag 默认关**、fake IO/fake HTTP、**不是生产默认**；OAuth resource audience 真实客户端未验证（设计稿 §4.3） |
| `scripts/typed-plan-spike.mjs` | **L1（spike）** | `docs/ledger/batch-14-typed-plan-spike.md`：明确"不替换 Code Mode、不接生产、无网络" | 原型保留旧的 per-step `approve:true` 语义，与生产执行器**有意不一致**（security ledger §六） |
| `scripts/typed-plan-ab.mjs` | **L1（骨架）** | `docs/ledger/batch-14-typed-plan-ab.md`：fake/replay 骨架、`NOT_ENOUGH`、`defaultSwitchAllowed:false` | 管线验证，不是质量证据；**没有真实 A/B 数据** |
| Native / Hybrid 执行器 | **L0** | 仅 `ARCHITECTURE-PROGRESSIVE.md` L2-4 选择策略表、FRAMEWORK.md §2 候选 | 无代码、无接口、无测试 |
| 按客户端自动替换底座 | **L0–L1** | 有 profile 编码（L1），无选择/协商代码（L0） | 换底座=换 URL 的运维 opt-in，不是自适配 |
| 执行所有权契约（客户端 loop vs 网关） | **L0–L1** | `FRAMEWORK.md` §12-1 未决、§13.7 暂不做通用能力检测 | 只在文档层提出，无实现 |
| 上下文预算策略（token 级） | **L1–L2** | 字符级截断+字段元数据 L2；无 token 预算 L1 | `FRAMEWORK.md` §12-7/§13.4 定位为底座子设计，未独立实现 |
| 审批 UX（不弹窗） | **L1** | `FRAMEWORK.md` §14：annotations 诚实声明导致的客户端弹窗问题待真机验证；实验 profile B 未做 | 网关内部闸 L2，客户端 UX 层未解决 |

**必须明确**：`typed-plan-spike`、`typed-plan-ab` 是 spike/骨架；`/mcp/v2`、`codemode.runTypedPlan` 是 flag/主动调用的可选路径。它们**都不是生产默认**。生产默认只有 v1 Code Mode（`mode:'codemode'`、`ENABLE_MCP_V2` 关）。

---

## 4. 缺口（诚实列出）

1. **执行所有权（客户端 agent loop vs 网关）**：当前模型在客户端产生 JS/plan，网关只执行；谁负责多步规划、重试、上下文压缩、失败恢复没有契约。`FRAMEWORK.md` §12-1 明确列为未决，§13.7 又"暂不做通用客户端能力检测框架"——缺口被有意搁置，而非解决。**[文档]**
2. **Code 模式客户端未处理**：用户 §13.1 定稿目标是"网页端非代码模式"；Claude Code/Codex 等有 Code 模式的客户端仅作为后续兼容对象，网关侧可能与宿主自带 tool loop 冗余，无单独策略；"客户端 × MCP 设计 × 非代码模式"逐平台 lane 尚未全部建好。**[文档]**
3. **Native / Hybrid 未实现**：`ARCHITECTURE-PROGRESSIVE.md` 的选择策略表（Gemini→Typed Plan、强模型→Code Mode、宿主 tool search→Native）没有任何代码对应；`FRAMEWORK.md` §9-1 "还有没有更好底座"也未收敛。**[代码][文档]**
4. **按客户端替换底座/能力协商缺失**：没有 mode detection → executor selection 的映射；能力无法可靠检测时的 fallback 也未实现（§12-4 列出，§13.7 推迟）；v2 flag 是全实例开关，不是按客户端。**[代码][文档]**
5. **上下文预算策略不完整**：只做字符级截断与结构化标记；缺 token 级预算、分层摘要/压缩、会话级上下文账本；写审批/截断元数据已做但策略在 `FRAMEWORK.md` §13.4 定位为子设计，未形成独立可配置策略。**[代码][文档]**
6. **A/B 无真实数据**：`typed-plan-ab.mjs` 默认 fake；CLI 报告必然 `NOT_ENOUGH`；N1–N9 多数任务因 registry 表达力触发 `fallback.reason=2` 走 code 分支（诚实的可观测结果，不说明 S 质量）；真实 Gemini ≥3 重复、冻结基线、conformance 四检查均未产出；`defaultSwitchAllowed:false` 必须保持。**[代码][文档][测试]**
7. **approval UX（客户端弹窗）**：`FRAMEWORK.md` §14 记录 Gemini 即使设"允许"仍弹窗，`execute_read` openWorldHint / `execute` destructiveHint 会触发确认；实验 profile B（改 annotations）未做、真机弹窗次数未测；网关内部 approve 不是客户端弹窗直接原因，但模型重试会叠加确认。**[文档]**
8. **sandbox 限制**：QuickJS 无 `Intl`、无真正 timers（微任务 shim）、无 `fetch`（宿主注入）、`maxResultBytes:16MB`/`maxBridgeRequests:2048`/`cpuTimeoutMs` 硬限；`runChecks` 无宿主 runner 时诚实返回 `skipped:true`；typed-plan 只有 6 op，registry 膨胀即"弱化版 Code Mode"（spike ledger §四）。真实多模态/大结果场景未压测。**[代码][文档]**
9. **fallback reason 1/2/3 未实现**：v2 代码只写 `reason:4`；设计稿四条件中 1–3 需要 session 作用域计数器与 op 缺失累计，属 A/B runner 后续；没有它就无法证明 S 真的用了 plan。**[代码][文档]**
10. **OAuth resource/audience on v2 未验证**：设计稿 §4.3 两方案（共用 `/mcp` resource vs 独立 `/mcp/v2`）待真实 ChatGPT/Claude 验证，当前沿用方案 A，标 unknown，不得宣称通过。**[文档]**

---

## 5. 渐进式延伸（下一层接口/能力/测试）

> 对齐 `ARCHITECTURE-PROGRESSIVE.md` 的 L2-1…L2-6 内部层次与 FRAMEWORK §9 未决项；只给方向与验收，不改代码。

### 5.1 下一层接口

- `ExecutionAdapter` 的"选择"层：在现有 3 工具工厂之上加一个**纯选择函数**（如 `selectExecutor({clientPlatform, mode, capabilities}) → {endpoint, inputMode}`），输入 client profile/mode detection 的结果，输出 v1/v2 端点与 plan/code 偏好。**先做纯函数 + 单测，不接 mode detection**。
- `fallback` 计数器接口：把 `meta.fallback.reason` 的 1/2/3 做成 session 作用域的注入式计数器（与 A/B runner 共用），不污染工具 schema。
- 能力协商的保守 fallback：detector 返回 `unknown` 时固定走 Code Mode（与 `ARCHITECTURE-PROGRESSIVE.md` 模块 1 失败隔离一致），不猜客户端行为（AGENTS.md §9 `unknown_tool` 禁令）。

### 5.2 下一层能力

- （可选）Native/Hybrid 的最小可验证原型：先用"宿主 tool search"场景做一个 opt-in 执行器，复用同一 3 工具契约与结果编码，不进默认；证明底座可替换的契约完整性，而不是追平全部上游工具。
- 上下文预算策略：把字符预算升级为可配置的"结果表示策略"（截断/摘要/字段投影/分页提示），并加 token 估算的可观测字段（不把 duration/bytes 换算成 token，遵守 AGENTS.md §3）。
- 客户端弹窗实验 profile：按 `FRAMEWORK.md` §14 建议 B，做**实验 profile**（仅改 annotations、不动默认/ChatGPT/Claude），在真实 Gemini 窗口验证；同时做 D（网关内部把已发起的 execute 视为 host approval，减少重试叠加）。
- approval UX：把 dryRun→真写→verify 的"代码级闸"与"客户端确认"分层，明确"客户端权限设置是用户意图第一权威，网关只留代码级闸"（FRAMEWORK §14 设计原则）。

### 5.3 下一层测试（全部可离线先写）

- 选择函数纯单测：平台×模式×能力矩阵 → 期望端点/输入模式；`unknown` 保守 Code Mode；无跨构建硬比。
- fallback reason 1/2/3 的确定性测试：注入计数器，断言 `meta.fallback` 可回到 `requestId`；reason 4 已有测试。
- v2 resource audience 的**真机** conformance：Gemini lane 先验证方案 A（共用 `/mcp` resource），ChatGPT/Claude 无真实 plan 时只报 protocol-ready / unknown。
- A/B 真实数据管线：fake→replay→real 的递进测试；只有 `environment==='real' && repeats>=3 && platform==='gemini'` 才允许实质判定（现有 `evaluateGates` 已实现，缺喂真实数据）。
- 写审批 UX 真机任务：统计真实任务中一次写操作平均触发几次客户端确认（FRAMEWORK §14 待验证清单）。

---

## 6. 可复用底层方法 / SOP（不复制代码，只沉淀方法）

1. **沙箱边界法**：guest 只拿到数据桥，不拿到宿主对象；不可猜桥名 + 自有键校验 + 保留标识过滤（`__proto__`/`constructor`）；错误作为数据返回；墙钟 deadline 兜底 host I/O。适用于任何"模型写脚本"的执行底座。
2. **whole-plan 校验先行法**：任何 handler 运行前把 op 名/字段/类型/审批全量校验；校验失败零副作用、可执行错误信息回模型自纠；失败即停、trace 只含真正跑过的 step，不伪造 skipped。
3. **授权来源单一法**：写授权只认 host 侧 `dryRun`/`approve`，来宾数据（plan step）永不成为授权源；`allowTruncatedRead` 等危险开关同理仅 host 可传；annotations 不是安全边界。
4. **截断显式法**：禁止静默字符截断；一律带字段级元数据（field/total/tail/next）与 `--- TRUNCATED ---` 标记；上游截断标志（布尔/对象/嵌套/带内标记）走**单一真值函数**（`explainTruncation`/`isExplicitTruncationFlag`），避免各层语义漂移；截断读不得写回。
5. **复用而非复制法**：新执行范式复用已有纯函数（diff 用 `file-write.js::applyTextPatch`、归一化用 `result-normalize.js`、搜索用 `searchWithFallback`、写编排用 `file-write.js::applyFilePatches`）；registry 只做"编排与授权"，不重新实现上游形状解析。
6. **版本路径法**：schema/工具面变更走新 URL（`/mcp/v2`），v1 逐字冻结；flag 严格 opt-in；未知路径 404 不降级；两端点工具名/序/annotations 恒定；capture 打 `protocolVersion`/`planVersion` 正交标签。
7. **A/B 纪律法**：F/S 同 task/prompt、配对反序、每任务新 session；fake/replay 只验证管线，real 才可决策；数据不足→`NOT_ENOUGH`/`INSUFFICIENT`，永不自动切默认；`defaultSwitchAllowed:false` 直到 lead 人审。
8. **模型可见脱敏 / capture full-fidelity 分离法**：只脱敏给模型看的文本，原始 envelope 原样入 capture；错误 code/形状保留以便自纠。
9. **证据分级法**：每个结论标注 [代码]/[文档]/[测试]/[线上]/[未验证]；测试绿不等于线上验收；免费模型输出只是假设，必须回到 `requestId` 本地复现（AGENTS.md §1）。
10. **host 侧编排 helper 法**：GitHub 幂等/分页/搜索/REST 只读 helper 全部注入式（I/O 由调用方给），可单测；网关专用 REST helper 不注册为 MCP 工具，工具面保持 3 个。

---

## 7. 优先级 / 依赖 / 需真实客户端验证项

### 7.1 优先级（P0 先做，P2 可后置）

| 优先级 | 事项 | 理由 |
|---|---|---|
| **P0** | 明确执行所有权契约（客户端 loop vs 网关），写进 FRAMEWORK（框架变更只写该文件）；定"按客户端替换"的最小选择接口 | 用户原话核心偏差；后续所有执行器扩展的地基 |
| **P0** | 补齐 fallback reason 1/2/3 的 session 计数器 + 确定性测试 | 没有它无法证明 S 真用 plan，A/B 不可信 |
| **P0** | 真实 Gemini lane 的 A/B 数据（≥3 real 重复、冻结基线、conformance 四检查） | 唯一能支撑"是否切默认"的证据；当前 `NOT_ENOUGH` |
| **P1** | `FRAMEWORK.md` §14 approval UX 实验 profile B + D，真机统计弹窗次数 | 直接影响用户体验；不改默认、不撒谎 annotations |
| **P1** | v2 OAuth resource/audience 方案 A 真机验证（先 Gemini） | 决定 v2 是否可用于真实客户端；当前 unknown |
| **P1** | 上下文预算策略升级（token 级可观测、分层表示） | "节省上下文"是底座首要作用，当前只有字符级 |
| **P2** | Native/Hybrid 最小可验证原型（opt-in，不动默认） | 证明底座可替换；用户列为候选但未要求立即实现 |
| **P2** | Code 模式客户端兼容策略（Claude Code/Codex 等） | 用户定稿为非主战场，后续兼容对象 |
| **P2** | registry 扩展（覆盖 N1–N9 helper 语义） | 降低 fallback reason=2 率，但需要 A/B 数据先确认方向 |

### 7.2 依赖关系

```text
执行所有权/选择接口（P0）
  → 按客户端替换底座 / Native·Hybrid（P2）
  → fallback 计数器（P0）
  → 真实 A/B 数据（P0）
  → 是否切默认（需 lead 人审，defaultSwitchAllowed 永不为真直到人工确认）

approval UX 实验（P1）——依赖真实 Gemini 客户端窗口与 FRAMEWORK §14 约束
v2 resource 验证（P1）——依赖真实 MCP 客户端连接与 OAuth 流程
上下文预算策略（P1）——依赖 capture/eval 的可观测字段（不改 duration→token 换算规则）
```

硬约束（来自 AGENTS.md / FRAMEWORK）：
- 框架/架构变化只写 `docs/FRAMEWORK.md`；本审计文件只记录、不改框架。
- 没有 A/B 数据不默认切 typed-plan；`defaultSwitchAllowed:false`。
- 不找用户反复要授权（`docs/AUTH-READY.md` 未全绿）。
- 不把 capture 脱敏当修复；只脱敏模型可见错误。
- 不做 commit / push / deploy。

### 7.3 需真实客户端验证项（不可由本地测试代替）

1. **Gemini web 非代码模式**：`search`/plan/写操作在真实窗口的行为；`destructiveHint`/`openWorldHint` 是否无视"允许"仍弹窗；一次写平均触发几次确认（FRAMEWORK §14 待验证 4 条）。
2. **v2 在真实客户端的连接**：更换 URL 到 `/mcp/v2` 后 `tools/list` 三工具、schema 被客户端接受（flat step + `oneOf` 是否过真机 sanitize）、resource/audience 是否匹配（方案 A）。
3. **ChatGPT / Claude**：无真实 plan 时只报 protocol-ready / unknown，不宣称 A/B 通过；Claude callback allowlist 缺口是前置阻断（设计稿 §7.2）。
4. **写回环**：dryRun→真写→verify 在真实上游/受控仓库的回放成功率；capture 写路径覆盖缺口以受控仓库 verify 为准（R10）。
5. **多客户端并发 / 上游配额**：FRAMEWORK §3.1/§9-3-4 的隔离与限流问题，沙箱/上游并发未实测。
6. **线上生效性**：本审计全部基于本地工作树；生产是否含最新代码以 `GET /healthz` 的 commit/buildHash 为准（见审计 05），不能由本地绿推断。

---

## 附：与相邻审计的边界

- 本文件只覆盖**模块 2 Execution Core**（3 工具/沙箱/预算/执行器/结果/写审批）。
- 客户端适配（detect/profile/编码/OAuth/弹窗 UX 的客户端侧）属审计 01；上游接入（授权/grant/canonical/写回环）属审计 03；评测体系（capture/replay/A-B/门槛数据）属审计 04；运行时/部署/Vercel/第 6 模块属审计 05。
- 交叉项（执行所有权、上下文预算、并发、审批 UX）在本文件只记录缺口与延伸方向，框架性定稿仍写 `docs/FRAMEWORK.md`。
