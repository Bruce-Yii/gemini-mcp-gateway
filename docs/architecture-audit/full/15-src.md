# 15 — src/ 全量源码 + 配置/工作流逐文件深读（只读审计）

> 审计时间：2026-11-24（Asia/Singapore）。审计范围：`src/` 全部 26 个 `.js`、`api/index.js`、根配置 7 件、`.github/workflows/` 3 件及 `.github/` 其余 3 件。
> 方法：`git ls-files src api .github` + 根配置列清单；**逐文件用 read 工具打开全文阅读**（非目录列举、非 grep 代替阅读）；只读，未写任何代码，未 commit/push/deploy。
> 事实标记：`[代码]` = 本次读到的源码/配置事实；`[配置]` = 配置文件/工作流事实；`[未验证]` = 代码无法证明、需要线上/真实客户端/外部系统验证的事项。
> 框架基线：`docs/FRAMEWORK.md`（六模块、FRAMEWORK 承诺、§15 七模块审计索引）。

---

## 0. 清单覆盖度（硬要求 1）

### 0.1 `git ls-files src api .github` 输出（32 件）

| # | 路径 | 字节 | expected | read | unread |
|---|---|---:|---|---|---|
| 1 | `.github/ISSUE_TEMPLATE/bug_report.yml` | 1523 | ✓ | ✓ | 0 |
| 2 | `.github/ISSUE_TEMPLATE/feature_request.yml` | 1026 | ✓ | ✓ | 0 |
| 3 | `.github/PULL_REQUEST_TEMPLATE.md` | 409 | ✓ | ✓ | 0 |
| 4 | `.github/workflows/capture-daily.yml` | 5442 | ✓ | ✓ | 0 |
| 5 | `.github/workflows/ci.yml` | 1460 | ✓ | ✓ | 0 |
| 6 | `.github/workflows/l1-smoke.yml` | 4812 | ✓ | ✓ | 0 |
| 7 | `api/index.js` | 149 | ✓ | ✓ | 0 |
| 8 | `src/build-info.js` | 443 | ✓ | ✓ | 0 |
| 9 | `src/capture-queue.js` | 19264 | ✓ | ✓ | 0 |
| 10 | `src/capture.js` | 40135 | ✓ | ✓ | 0 |
| 11 | `src/catalog.js` | 20322 | ✓ | ✓ | 0 |
| 12 | `src/client-platform.js` | 9258 | ✓ | ✓ | 0 |
| 13 | `src/client-profile.js` | 10589 | ✓ | ✓ | 0 |
| 14 | `src/codemode-util.js` | 1411 | ✓ | ✓ | 0 |
| 15 | `src/codemode-v2.js` | 13654 | ✓ | ✓ | 0 |
| 16 | `src/codemode.js` | 139486 | ✓ | ✓（1931 行，分 5 段读完） | 0 |
| 17 | `src/config.js` | 15027 | ✓ | ✓ | 0 |
| 18 | `src/figma-guard.js` | 5517 | ✓ | ✓ | 0 |
| 19 | `src/file-write.js` | 27932 | ✓ | ✓ | 0 |
| 20 | `src/github-helpers.js` | 38764 | ✓ | ✓ | 0 |
| 21 | `src/oauth.js` | 36975 | ✓ | ✓ | 0 |
| 22 | `src/project-tag.js` | 9503 | ✓ | ✓ | 0 |
| 23 | `src/result-normalize.js` | 29477 | ✓ | ✓ | 0 |
| 24 | `src/sanitize.js` | 12600 | ✓ | ✓ | 0 |
| 25 | `src/server.js` | 30007 | ✓ | ✓ | 0 |
| 26 | `src/store.js` | 13409 | ✓ | ✓ | 0 |
| 27 | `src/tool-format.js` | 26727 | ✓ | ✓ | 0 |
| 28 | `src/typed-plan.js` | 15140 | ✓ | ✓ | 0 |
| 29 | `src/upstream-auth.js` | 41532 | ✓ | ✓ | 0 |
| 30 | `src/upstream-oauth.js` | 22546 | ✓ | ✓ | 0 |
| 31 | `src/upstreams.js` | 24912 | ✓ | ✓ | 0 |
| 32 | `src/vercel-app.js` | 15978 | ✓ | ✓ | 0 |

### 0.2 根配置文件清单

| # | 路径 | 字节 | expected | read | unread |
|---|---|---:|---|---|---|
| 33 | `package.json` | 1951 | ✓ | ✓ | 0 |
| 34 | `config.example.json` | 12361 | ✓ | ✓ | 0 |
| 35 | `vercel.json` | 446 | ✓ | ✓ | 0 |
| 36 | `Dockerfile` | 1721 | ✓ | ✓ | 0 |
| 37 | `docker-compose.yml` | 1012 | ✓ | ✓ | 0 |
| 38 | `.vercelignore` | 43 | ✓ | ✓ | 0 |
| 39 | `.dockerignore` | 338 | ✓ | ✓ | 0 |

**汇总：expected=39 / read=39 / unread=0。** 额外读过框架基线 `docs/FRAMEWORK.md`（510 行，只读）。

---

## 1. 逐文件阅读记录（硬要求 2：路径 / 字节 / 读完 / 入口 / 关键导出 / 风险）

### 1.1 入口与装配层

**`api/index.js`**（149 B，5 行，读完）
- 入口：Vercel serverless handler；`createAppHandler()` 单例，`export default (req,res)=>handler(req,res)`。
- 关键导出：默认导出 handler。
- 风险：`[代码]` 无 try/catch；依赖 `vercel-app.js` 内部兜底。`[配置]` `vercel.json` rewrites 全部流量到此入口，`maxDuration:60`。

**`src/vercel-app.js`**（15978 B，415 行，读完）
- 入口：`createAppHandler(options)` 返回 `(req,res)=>Promise<void>`；路由 `/healthz`、OAuth 三件套、CIMD `/.well-known/mcp-client.json`、upstream OAuth start/callback、`/mcp`、`/mcp/v2`。
- 关键导出：`CIMD_PATH`、`cimdClientId()`、`buildCimdDocument()`、`createAppHandler()`、默认导出。
- 风险：
  - `[代码]` **L332 `startCapture(req,res,{path,bodyBuffered,requestBytes})` 没有把 `options` 透传**，`oauthClientMap` / `mode` / `sink` / `asyncQueue` 等注入无法生效（capture 走 env 默认）。
  - `[代码]` `availableServers()`（L138-143）按 `tokenEnv` 是否设置过滤上游；没有 tokenEnv 的纯 OAuth/DCR 上游会被静默跳过。
  - `[代码]` `getMcpHandler()` 构造 `gatewayOptions` 时（L180-185）**未传 `typedPlanIO`/`typedPlanOps`**，也未传 `env`；v2 plan 路径因此无真实 IO 适配器（结合 codemode-v2 的 fail-closed 设计，真实 plan 执行会返回验证错误）。`[代码]` `isMcpV2Enabled(options.env ?? process.env)` 读 env，与 handler 内部一致。
  - `[代码]` L405-410 顶层 catch 把 `error.message` 原样回写 JSON 500；虽然上游错误大多经 `errorResult()` 脱敏，但此处是模型/客户端可见面，属潜在未脱敏路径（需具体触发验证）。`[未验证]` 是否可由可控输入制造带 secret 的顶层错误。
  - `[代码]` 默认配置为 `config.example.json`（L27）——若生产未设置 `GATEWAY_CONFIG`/`UPSTREAMS_JSON`，加载的是占位示例（含 `your-domain.example` CIMD、grantOwner=dsh 等）。
  - `[配置]` origin 一致性：issuer/resource/401/CIMD 均跟随请求 host（`resolveBaseUrl`），与 FRAMEWORK/AGENTS 2026-11-24 记录一致。

**`src/server.js`**（30007 B，737 行，读完）
- 入口：`runCli()`（CLI，`--config/--port/--host/--stdio`）、`createMcpRequestHandler()`（HTTP）、`createGatewayServer()`、`startHttpServer()`。
- 关键导出：`MCP_V1_PATH`、`MCP_V2_PATH`、`isMcpV2Enabled()`、`boundResult()`、`createGatewayServer()`、`createMcpRequestHandler()`、`startHttpServer()`、`DEFAULT_HOST`、`parseCliArgs()`、`resolveHost()`。
- 风险：
  - `[代码]` `createGatewayServer()`（L318-323）只按 `options.mode==='codemode'` 与 `options.protocolVersion==='v2'` 选工厂；**不存在按客户端（Gemini/ChatGPT/Claude）选执行器的分支**。`profile` 只影响结果编码（`encodeToolResult`/`toModelOutput`），不改执行语义。
  - `[代码]` `buildToolRegistry()`（whitelist 模式）仍暴露 `gateway_call` / `gateway_search` 两个元工具（全量工具数 >3）；只有 codemode 模式是 3 工具。`[配置]` `config.example.json` `mode:"codemode"`，所以默认生产面是 3 工具。
  - `[代码]` `CALL_TOOL.handler`（L278-283）直接 `upstreamManager.callTool(server, tool, ...)`，`UpstreamManager.callTool` 不复核 allow/deny（见 1.5），构成潜在策略绕过面（需要模型被诱导或 whitelist 模式下调用）。
  - `[代码]` CLI `runCli()` L689-694 的 `gatewayOptions` 未包含 `typedPlanIO`、也未把 `config.mode` 之外的运行时选项（如 `env`）传入；CLI `/mcp/v2` 同样无真实 plan IO。
  - `[代码]` `INSTRUCTIONS` 常量（L55-60）在 codemode 模式下被覆盖，whitelist 模式使用；无 Native/Hybrid 相关指令。
  - `[代码]` 会话：`sessionIdGenerator:undefined` 无状态；initialize 生成 `req.__gatewaySessionId` 仅作 capture 关联（L554-563）。
  - `[代码]` `boundResult()` 结果级 `truncated:true` 与 in-band 标记并存（F-09），与 capture 的截断真值表统一。

**`src/build-info.js`**（443 B，13 行，读完）
- 入口：静态 `BUILD` 常量；构建期由 `scripts/write-build-info.mjs` 覆写（脚本不在本次范围）。
- 关键导出：`BUILD={commit:'dev',buildHash:'dev',builtAt:null}`。
- 风险：`[代码]` 纯 checkout 永远报 `dev`；线上 commit/buildHash 需 `/healthz` 实测。`[未验证]` 当前生产 buildHash 与本地源码一致性。

### 1.2 客户端与编码层

**`src/client-profile.js`**（10589 B，241 行，读完）
- 入口：`resolveClientProfile()` / `encodeToolResult()` / `encodeModelOutput()` / `applyProfileToTools()`。
- 关键导出：`GEMINI/CLAUDE/CHATGPT`、`CLIENT_PROFILES`（frozen）、`PROFILE_HEADER`、上述四个函数。
- 风险：`[代码]` 明确注释“NOT a multi-tenant or security layer”；只做 wire 编码。`applyProfileToTools()` **不调整 annotations**（id 仅 `void`），FRAMEWORK §14 的“实验 profile 降低 Gemini 弹窗”未实现。检测依赖显式 header/clientInfo/UA/env；未识别→gemini 默认。

**`src/client-platform.js`**（9258 B，227 行，读完）
- 入口：`detectClientPlatform(input)`。
- 关键导出：`PLATFORM_*`、`PROFILE_*`、`CLIENT_PLATFORM_PROFILES`、`DELEGATED_CLIENT_PROFILES`、`detectClientPlatform()`。
- 风险：`[代码]` 纯观测标签，硬规则写明“NEVER used by write paths, idempotency, permissions, tool names/count/schema, upstream auth decisions”；与“按客户端选执行器”承诺相冲突（观测有、执行选择无）。UA 无显式 gemini token，未识别即 `unknown`。

**`src/sanitize.js`**（12600 B，340 行，读完）
- 入口：`sanitizeTool()` / `sanitizeInputSchema()` / `normalizeToolArguments()` / `toSnakeCase()`。
- 关键导出：上述四个。
- 风险：`[代码]` schema 变换为有损（数组补 items、多类型折叠、enum 过滤、oneOf/anyOf 截到 8 分支），靠 description hint 标注；名称替换非 ASCII→`_` 且截 63。`normalizeToolArguments()` 用 `Object.defineProperty` 防 `__proto__`。`[代码]` `UNSAFE_ANNOTATION_KEYS` 防原型污染。

**`src/tool-format.js`**（26727 B，585 行，读完）
- 入口：`redactSecrets()` / `modelErrorMessage()` / `formatToolSummary()` / `formatToolDetail()` / `truncateResultValue()` / `unwrapResult()` / `isExplicitTruncationFlag()`。
- 关键导出：`MAX_RESOURCE_BINARY_BYTES` 及上述函数。
- 风险：`[代码]` F-01 模型可见错误脱敏（Bearer/ghp_/github_pat_/sk-/AKIA 等），capture 保持 full-fidelity。`truncateResultValue()` `images[]` 从文本预算中剥离并原样保留。`unwrapResult()` 对 `structuredContent` 只在无其他 block 时直返（RC-A3 修复）。

### 1.3 核心底座与执行层

**`src/codemode.js`**（139486 B，1931 行，读完，分 5 段）
- 入口：`createCodeModeTools(upstreamManager, options)` → `[search, execute_read, execute]`；`runInSandbox()`；`toModelOutput()`；`servicesSnapshot()`；`instrumentLineMarkers()`；`pickScriptLoc()`；`fileTextFromRaw()`；`aliasGetFileContentsArgs()`；`validateToolArgs()`；`searchWithFallback()`；`isReadOnlyTool()`。
- 关键导出：上述函数。
- 风险：
  - `[代码]` **工具工厂无客户端参数分支**：`options.profile` 仅透传给 `toModelOutput`；执行器恒为 QuickJS sandbox（`createRunner` from `run`），无 Native/Hybrid 实现，无 executor 注册表。
  - `[代码]` F-06 桥接：guest 只能经非可猜名 `__dshHostBridge9f4c2a` 调 `invoke`；`invoke()` 用 `hasOwnProperty` 白名单 + 保留标识过滤（`RESERVED_TOOL_IDENTS`）。
  - `[代码]` 成本/预算：`DEFAULT_MAX_CALLS=50`、`MAX_TYPED_PLAN_STEPS=64`、`EXEC_TIMEOUT_MS=30000`、`maxResultChars=20000`；所有 I/O（tool / typedPlan / githubActions / waitForPrChecks）共用 `chargeBudget`。
  - `[代码]` write 闸：`execute_read` 仅绑定只读工具，写工具为抛错 stub；typedPlan 强制 `readOnly`，`dryRun` 默认 true。
  - `[代码]` `codemode.runTypedPlan` 是**沙箱内 helper**（第 4 个工具未新增），默认 IO 由 `createDefaultTypedPlanIO()` 从上游工具桥构造，但 `runChecks` 是 `skipped:true` stub（L1197）——检查步骤不会真跑。
  - `[代码]` 大量 guidance 常量（L86 等）含“NO SILENT CHARACTER TRUNCATION”等长文本，直接进入 execute 描述 → 上下文预算的一部分；`[未验证]` 实际每请求 token 成本。
  - `[代码]` guest 侧 `codemode.applyPatch` 与 host 侧 `file-write.js::applyTextPatch` 是两份独立实现（guest 版 L344，host 版 file-write L111），存在语义漂移风险（host 版做严格上下文校验、尾部换行保留；guest 版更简）。

**`src/typed-plan.js`**（15140 B，383 行，读完）
- 入口：`executeTypedPlan(plan, options)` / `validateTypedPlan()` / `createDefaultOps()`。
- 关键导出：`PLAN_VERSION='v2.0.0'`、`DEFAULT_OPS`、`OP_EFFECTS`、`runTypedPlan`（别名）、默认导出。
- 风险：
  - `[代码]` **文件头明写“deliberately NOT wired into the MCP tool surface”**；v1 仅通过 codemode 沙箱 helper 间接可达，v2 通过 `/mcp/v2` 可达（但生产未注入真实 IO）。
  - `[代码]` 纯引擎：六 op（readFileRange/repoGrep/ensureBranch/applyPatch/openPr/runChecks），无默认真实 IO（fail closed）；`APPROVAL_REQUIRES_HOST`、`PATCH_READ_TRUNCATED`、per-step `approve`/`allowTruncatedRead` 均拒绝。
  - `[未验证]` typed-plan vs codemode 的 A/B 对照数据（FRAMEWORK 禁止无数据默认切换）。

**`src/codemode-v2.js`**（13654 B，358 行，读完）
- 入口：`createCodeModeToolsV2(upstreamManager, options)`。
- 关键导出：`PROTOCOL_VERSION='v2'`、`V2_PROFILE='S'`、`V2_EXECUTE_READ_INPUT_SCHEMA`、`V2_EXECUTE_INPUT_SCHEMA`、工厂。
- 风险：
  - `[代码]` v2 复用 v1 `search` 工具对象，只替换两个 execute 的 schema/handler；3 工具名/顺序/annotations 不变；`oneOf:[{plan},{code}]` + 服务端 both/neither 检查（E-VAL-BOTH/E-VAL-NONE）。
  - `[代码]` `makePlanHandler` 只用 `options.typedPlanIO`（注入存在才传 `io`）；**生产入口未注入** → 默认引擎无 IO，plan 调用失败（fail closed 但功能不可用）。
  - `[代码]` v2 `dryRun` schema 默认 false，但 v1 helper 默认 true——同一逻辑两种默认，需 A/B 时留意。
  - `[配置]` `ENABLE_MCP_V2=1` 默认关闭（vercel-app/server 双重门控）。

**`src/codemode-util.js`**（1411 B，25 行，读完）
- 入口：动态 import `@cloudflare/codemode` 的 minified 工具 chunk。
- 关键导出：`normalizeCode`、`sanitizeToolName`、`generateTypesFromJsonSchema`。
- 风险：`[代码]` 硬编码 chunk 文件名 `json-schema-types-D_m9tVnI.js` 与单字母导出映射（s/a/t），**强绑定 @cloudflare/codemode@0.5.6**，升级即可能崩。`generateTypesFromJsonSchema` 在当前 src 无调用点（潜在死代码/仅测试用）。

**`src/catalog.js`**（20322 B，461 行，读完）
- 入口：`buildIndex()` / `searchEntries()` / `parseQuery()` / `tokenize()` / `isAllowed()` / `patternMatches()`。
- 关键导出：上述函数。
- 风险：`[代码]` 纯 BM25-ish 检索；CJK 同义词表与 server 别名硬编码（`repository→github`、`deployment→vercel`），新上游需改代码；`select:` 精确名匹配。`isAllowed()` deny 优先、allow 为空即全放行。

**`src/file-write.js`**（27932 B，713 行，读完）
- 入口：`applyTextPatch()` / `applyFilePatch()` / `applyFilePatches()`(=`writeFiles`) / `precheckText()` / `normalizeWriteResult()` / `describeAtomicCapability()` / `buildAtomicFiles()`。
- 关键导出：上述函数 + 默认导出。
- 风险：
  - `[代码]` 原子多文件写依赖注入 `commitFiles`（GitHub push_files）；无 committer 时 `atomic:true` 硬失败，非原子路径返回 `partial:true/written/remaining/compensation`。
  - `[代码]` `applyFilePatch()` L320-322：`commitSha` 先取 `writeResult.commitSha`，随后被 `blobSha` 无条件覆盖（两者均存在时丢失 commitSha）——与 `normalizeWriteResult()` 的语义不一致，属代码级缺陷候选。
  - `[代码]` `precheckText()` 只做 JSON.parse 与 JS/TS 括号/引号平衡，非编译器；通过不等于可编译。
  - `[代码]` 截断读拒绝：`--- TRUNCATED ---` 字符串 + 显式标记（typed-plan 侧）。

**`src/github-helpers.js`**（38764 B，938 行，读完）
- 入口：纯函数（`ensureBranch`/`upsertPr`/`fetchAllPages`/`repoGrep`/`canonicalResult`/`unwrapResultPayload`）+ 三个 Actions REST helper + `waitForPrChecks()`。
- 关键导出：见文件默认导出（16 项）。
- 风险：
  - `[代码]` Actions helper 直接读 `process.env.GITHUB_TOKEN`（经注入 env），独立于上游 MCP 的 token 生命周期；不复用 `UpstreamAuth`。签名 URL 跟随 302 且**不携带 Authorization**（L641-654），正确。
  - `[代码]` `canonicalResult()` number 优先 URL 正则，id/nodeId 独立且永不兜底 number；`rawUntrusted` 非枚举标记。
  - `[代码]` `repoGrep()` 对截断读设置 `truncated:true`（安全审计修复）。
  - `[代码]` `waitForPrChecks()` 单调用硬上限 30s/100 polls；`check` 注入，生产由 codemode.js 桥接到 `pull_request_read(method:'get_check_runs')`。

### 1.4 结果归一化与安全

**`src/result-normalize.js`（29477 B，745 行，读完）**
- 入口：`normalizeFileResult()` / `normalizePrResult()` / `normalizeIssueResult()` / `normalizeResult(toolName,value)` / `explainTruncation()`。
- 关键导出：上述函数 + `UNTRUSTED_RAW_MARKER`。
- 风险：`[代码]` 文件正文永远是纯 body，download notice/SHA 放独立元数据；`raw` 保留原始 envelope 并打 `rawUntrusted` 非枚举标记；PR/Issue number URL 优先、id 绝不兜底；只覆盖 GitHub 工具名集合，其他上游走 `{raw}`.

**`src/project-tag.js`**（9503 B，249 行，读完）
- 入口：`extractProjects(request)`。
- 关键导出：`extractProjects()`、默认导出。
- 风险：`[代码]` 纯函数，从请求（owner/repo 显式参数、代码字面量、PR URL）派生 `github:<owner>/<repo>` tag；不猜自然语言；只认 `tools/call`。capture 在 envelope 中调用（capture.js L797-803）。

**`src/figma-guard.js`**（5517 B，151 行，读完）
- 入口：`createFigmaGuard(options)` / `isFigmaQuotaError()` / `cacheKey()` / `FigmaQuotaCooldownError`。
- 关键导出：`DEFAULT_COOLDOWN_MS=24h`、`DEFAULT_CACHE_TTL_MS=1h`、`DEFAULT_CACHE_MAX=200`、`CACHEABLE_TOOLS={whoami,get_metadata}`、上述函数/类。
- 风险：`[代码]` **纯进程内状态**；Vercel 每个 warm instance 独立冷却/缓存，冷启动清零，无共享 KV；`429`/plan-limit 关键词触发 24h 冷却（over-broad 模式可能误触发）。`[配置]` `config.example.json` 的 figma 是第 5 个上游（FRAMEWORK 只列 4 个）。

### 1.5 上游与授权层

**`src/upstreams.js`**（24912 B，540 行，读完）
- 入口：`UpstreamManager` 类：`connect()` / `getEntries()` / `getWhitelist()` / `callTool()` / `close()`；工具函数 `tapTransport()` / `makeCaptureFetch()`。
- 关键导出：`UpstreamManager`、`tapTransport`、`makeCaptureFetch`。
- 风险：
  - `[代码]` **`callTool(server,tool,args)` 不复核 allow/deny**：L480 仅用 entries 查找做参数归一化，L498 直接用传入 `tool` 调 SDK。白名单只在 `connect()` 灌入 `entries` 时过滤（`getWhitelist()` 再过滤一次）。模型经 `gateway_call` 或 codemode 桥传任意 `tool` 可绕过（工具名仍需在已连接 server 上）。
  - `[代码]` `_resolveToken()` 静态 bearer 需 `config.authMode==='static_bearer'` 才不走刷新路径；config.example 的 notion/linear 只写 `grantOwner:dsh` 而**没有 authMode**，靠 refreshEnv 齐全进入 OAuth 生命周期（dsh owner → `_mayRefresh=false` → 永不刷新，只报告）。
  - `[代码]` 401 只强制一次刷新+一次重连；静态 token 401 直接 `ReauthRequiredError(STATIC_TOKEN_NO_REFRESH)`。
  - `[代码]` Figma guard 在 `callTool` 层作用于所有调用（含 codemode 间接路径）。
  - `[代码]` `makeCaptureFetch()` 把完整 Authorization header 写入 `upstream_http` capture（full-fidelity 设计，符合 AGENTS §6；模型可见错误另由 redactSecrets 脱敏）。

**`src/upstream-auth.js`**（41532 B，888 行，读完）
- 入口：`UpstreamAuth` 类：`getAccessToken()` / `seed()` / `getAuthStatus()`；工具函数 `resolveEnvironment()` / `defaultProvider()` / `requiredScopes()`。
- 关键导出：`KEY_PREFIX_V2='gmcgw:v2:grant'`、`ENVIRONMENTS`、`GRANT_OWNERS`、`REAUTH_REQUIRED`、`STATIC_TOKEN_NO_REFRESH`、`SHARED_GRANT_REFRESH_FORBIDDEN`、`OAUTH_PROVIDER_FACTS`、`resolveEnvironment()` 等。
- 风险：
  - `[代码]` owner 门是核心安全闸：`_grantOwner()` 未标记→`shared`→`_mayRefresh=false`；仅 `owner=gateway` 可花 rotating refresh token；v1 key 只读（legacy exception 已删）。
  - `[代码]` KV key `gmcgw:v2:grant:<env>:<owner>:<server>`；`resolveEnvironment()` 永不默认 production（无 VERCEL_ENV 且 VERCEL=1 → preview；本地 → local）。
  - `[代码]` 并发防护：实例内 `_coalescedRefresh` + Redis lease（owner token、renew、compare-and-delete）+ `casToken` fencing；invalid_grant 只有“同 grant 且无可用 winner”才写 terminal。
  - `[代码]` `captureEvent('upstream_http')` 记录完整 bearer（L424）与 CAS lost 的 refresh/access 原值（L507-510）——**capture full-fidelity 允许**，但这些事件进入 R2 envelope，需确认 capture 存储的访问控制（`[未验证]`）。
  - `[代码]` L787-803 的 stale-recovery `_save()` **未写 owner/environment/grantId/source**（与 `_save()` 默认填充不同：refresh 路径的 `_save` 会填 owner=gateway，但这里 rec 是新对象且 owner 缺省 → `clean.owner=this.grantOwner` 通常 gateway；environment 同理；风险较低但 grantId 会按默认串生成，与 callback 的 `gw:` 格式不一致）。
  - `[代码]` `getAccessToken()` 静态路径对 `force:true` 返回同一 token 并写 status（不会假装刷新成功）。
  - `[配置]` `OAUTH_PROVIDER_FACTS` 称 notion `scopes_supported` 仅 `default`，而 `upstream-oauth.js` 对 DCR/CIMD 路径也确实跳过了 offline_access 增补——两处一致。

**`src/upstream-oauth.js`**（22546 B，492 行，读完）
- 入口：`createUpstreamOAuthHandlers({store,getConfig,...})` → `{start, callback}`。
- 关键导出：`PROVIDER_ENDPOINTS`、工厂。
- 风险：
  - `[代码]` 需 `UPSTREAM_OAUTH_ADMIN_KEY` 才启用；start 用 `env=` 显式绑定环境，grantOwner 固定 `gateway`；state 按 env+owner 命名空间（R5），callback 校验 env 一致。
  - `[代码]` DCR 客户端存 `gmcgw:v2:client:<env>:<server>`；并发注册后重读防重复 client。
  - `[代码]` CIMD/Vercel：`offline_access` 通过 dcrScopes 增补；Vercel callback 无 refresh_token 直接 400。
  - `[配置]` `config.example.json` 的 vercel `clientId:"https://your-domain.example/.well-known/mcp-client.json"` 是占位符；AGENTS §2 记录“CIMD 目前被 AS 拒绝，BLOCKED”——`[未验证]` 现状是否已变。
  - `[代码]` Notion 在 `_authProvisioning` 标 `grantOwner:manual`，但 servers[] 为 `dsh`（互相矛盾的配置语义，见 §4）。

**`src/oauth.js`**（36975 B，846 行，读完）
- 入口：`createOAuthHandlers(store, options)` → `{metadata, protectedResource, register, authorize, token, revoke}`。
- 关键导出：`isAllowedRedirectUri()`、`resolveBaseUrl()`、`isValidGoogleRedirectUri()`、`isChatgptRedirectUri()`、`isClaudeRedirectUri()`、工厂、默认导出。
- 风险：
  - `[代码]` 这是**网关自己的 OAuth AS**（客户端连网关），与 upstream OAuth 完全独立；redirect 白名单严格（Google relay/ChatGPT/Claude）；RFC 9207 `iss` 附在每个授权响应；PKCE S256 强制；refresh token 不轮换。
  - `[代码]` `LOCKED` 时 DCR 默认 403，ChatGPT/Claude 需各自 flag；平台间 code/client 隔离。
  - `[代码]` origin 一致性：`resolveBaseUrl()` 请求 host 优先（L138-145），issuer/resource/CIMD/401 同源。
  - `[代码]` `authorize()` L534 与 `token()` L823 有 console.log 记录 client_id/redirect 前缀/scope，不含 secret；`oauth-error` 记录 error description（可能含上游文本，但为 AS 协议错误）`[未验证]` 是否可能含 secret。
  - `[配置]` 生产是否设置 `ALLOWED_CLIENT_ID` 未从仓库证明。

**`src/store.js`**（13409 B，359 行，读完）
- 入口：`TokenStore` 类（Upstash Redis REST）。
- 关键导出：`hashSecret()`、`TokenStore`、默认导出。
- 风险：`[代码]` Redis key 对 secret 取 sha256；`compareAndSet`/`releaseLease`/`renewLease`/`casToken` 用 Lua 脚本；OAuth state 按 env+owner 作用域（10 分钟 TTL）；v1 `gmcgw:v1` 命名空间。TTL：code 10min、token 1h、client/refresh 永久。

**`src/config.js`**（15027 B，303 行，读完）
- 入口：`validateConfig()` / `normalizeConfigValue()`。
- 关键导出：`MODES=['codemode','whitelist']`、`AUTH_MODES`、`STATIC_BEARER`、`ConfigError`、上述函数。
- 风险：`[代码]` **没有任何 `native`/`hybrid` 模式值**——FRAMEWORK 的候选执行器在配置层不存在。`[代码]` 顶层未知键只警告不拒绝（config.example 的 `_authProvisioning` 因此被静默忽略）。`[代码]` 静态 bearer 与 refresh 字段互斥校验；未标记 grantOwner 的 env seed 只警告。

### 1.6 采集与评测支撑层

**`src/capture.js`（40135 B，1008 行，读完）**
- 入口：`startCapture()` / `captureEvent()` / `captureSkip()` / `captureEnabled()` / `buildModelOutputAudit()` / `captureFailureStats()` / `captureHeaders()` / `captureOAuthClientId()`。
- 关键导出：上述函数 + `captureStore`。
- 风险：
  - `[代码]` envelope `gmg.capture.v1` 含 request.raw/headers、response.raw、events、model audit、projects/primaryProject、clientPlatform/clientProfile/oauthClientId、sessionId；full-fidelity 不脱敏（符合 AGENTS §6）。
  - `[代码]` `CAPTURE_MODE=off` 默认关闭；`CAPTURE_ASYNC_QUEUE=1` 启用队列（见下）；`CAPTURE_SYNC=1` 同步等待 sink；两者互斥。
  - `[代码]` `buildModelOutputAudit()` 只在 sandbox output 存在、source>0、visible ≤50% 且差 ≥64B、无显式标记时置 `possibleModelTruncation`；纯字节判定。
  - `[代码]` ack/done/dropped/flush_end 日志结构固定；`safeSkipReason`/`safeSkipDetail` 防 token 泄漏到 skip 行。
  - `[代码]` envelope **无 taskId/task 字段**（只有 sessionId、projects、platform）。

**`src/capture-queue.js`**（19264 B，501 行，读完）
- 入口：`CaptureQueue` 类、`createHttpSink()`。
- 关键导出：`CRITICAL_TAGS`、`CaptureQueue`、`createHttpSink()`、默认导出。
- 风险：`[代码]` **文件头注释过时**：声称“deliberately not imported by capture.js … nothing here changes production capture path”，但 capture.js L31 已 import 且在 `CAPTURE_ASYNC_QUEUE=1` 下实际接线（B15 集成已完成）。`[代码]` 有界 ring + 优先级 critical lane + 退避重试 + DLQ；`seen` 集合按 requestId 永久增长（进程内内存泄漏风险，长生命周期进程需验证）。

### 1.7 配置与部署文件

**`package.json`**（1951 B，54 行，读完）
- 入口：`main:"src/server.js"`，`type:"module"`，engines node>=20.19.0；scripts 覆盖 test/verify/smoke/l1/bench/审计。
- 依赖：`@cloudflare/codemode@0.5.6`、`@modelcontextprotocol/sdk@^1.32.2`、`@vercel/functions@^3.11.3`、`acorn`、`run@^2.1.13`。MIT，author/repository/homepage 均为 `example-org` 占位。
- 风险：`[配置]` OSS 发布元数据仍是占位（与 AGENTS §0 “OSS 未公开”一致）；`"name":"codemode-mcp-gateway"` 与仓库名 `gemini-mcp-gateway` 不同。

**`config.example.json`**（12361 B，375 行，读完）
- 入口：`mode:"codemode"`、`maxWhitelistTools:0`、`_authProvisioning`（占位）、`servers[5]`：github/notion/linear/vercel/figma。
- 风险：
  - `[配置]` notion/linear/figma 的 `grantOwner:"dsh"`；`_authProvisioning` 中 linear/notion 写 `grantOwner:"manual"` + `preferredMode:"static_bearer"`，但 servers[] 没有 `authMode:"static_bearer"` 且 grantOwner 不同 → **两份授权意图互相矛盾**（生效的是 servers[]，因为 `_authProvisioning` 是未知顶层键被 config.js 忽略）。
  - `[配置]` vercel clientId 占位 `your-domain.example`，CIMD BLOCKED。
  - `[配置]` figma 是第五个上游，FRAMEWORK 只列四个；denyTools 覆盖 figma 四个工具。
  - `[配置]` allowTools 全空 → 所有未被 deny 的工具放行。

**`vercel.json`**（446 B，22 行，读完）
- `framework:null`、`buildCommand` 写 build-info、`outputDirectory:"."`、api/index.js `maxDuration:60`、全量 rewrite 到 `/api/index`、`git.deploymentEnabled.main=false`（push 不自动部署生产）。

**`Dockerfile`**（1721 B，33 行，读完）
- node:20-bookworm-slim；只 COPY package.json/lock 与 src/、api/；运行 `node src/server.js --config /app/gateway-config.json --host 0.0.0.0 --port 3000`；HEALTHCHECK 用 TCP 连接（注释说明 CLI 路径无 /healthz）。

**`docker-compose.yml`**（1012 B，23 行，读完）
- 单服务；端口绑 `127.0.0.1:3000`；`env_file:.env`；挂载未跟踪 `my-gateway.local.json` 与 work/capture；`restart:unless-stopped`。

**`.vercelignore`**（43 B）：`work/`、`bench/results.json`、`explore/results/`。
**`.dockerignore`**（338 B）：排除 .git/node_modules/.env*/`*.local.json`/work/captures/docs/tests/scripts/templates/bench/harness/*.md 等；不排除 `config.example.json`（但镜像 CMD 不读它）。

### 1.8 CI/工作流

**`.github/workflows/ci.yml`**（1460 B，46 行，读完）：push main + PR；node 20/22/24 矩阵；`npm test`、audit-truncation、audit-tools(figma)、check-task-coverage(figma)、check-config（config.example + examples/*.json + templates/upstreams/*.json）、eval-search、measure-context、bench dry-run、build-info 自检。无真实网络/凭据步骤。

**`.github/workflows/l1-smoke.yml`**（4812 B，110 行，读完）：每日 fake（18:00 UTC）、周一 real（同类 cron）；real 注入 4 免费上游 secrets（Notion/Linear token JSON 在 runner.temp 临时生成），**刻意不注入 Figma 凭据**保护 Starter 配额；上传报告 artifact。真实 4 上游调用需 secrets 与网络，`[未验证]` 当前是否全绿。

**`.github/workflows/capture-daily.yml`**（5442 B，132 行，读完）：每日 R2 digest + 免费模型分析（advisory、`continue-on-error`）、每周 dry-run 聚合；两个 job 都 `git commit && git pull --rebase && git push` 回写 docs/eval（权限 `contents:write`）。`[代码]` 与“不要 commit/push/deploy（本次任务）”无关，但属仓库现有自动化事实；模型输出只是候选，AGENTS §1 明确不能自动采纳。

**`.github/ISSUE_TEMPLATE/*`、`.github/PULL_REQUEST_TEMPLATE.md`**：均已读；bug 模板提醒不要带 token、安全走 SECURITY.md；feature 模板要求确认 3 工具稳定面与单用户自托管约束；PR 模板要求 CHANGELOG。

---

## 2. 六模块映射与 FRAMEWORK 承诺核对（硬要求 3）

| 模块 | 本次读到的真实实现 | 主要文件 | FRAMEWORK 承诺 | 核对结论 |
|---|---|---|---|---|
| 一、核心底座 | Code Mode（QuickJS `run` SDK）**唯一执行器**；Typed Plan 纯引擎 + v2 版本路径；Native/Hybrid **不存在**；无按客户端选择执行器的代码 | codemode.js / typed-plan.js / codemode-v2.js / config.js | 底座按客户端替换；候选含 Code Mode/Typed Plan/Native/Hybrid；3 工具不变 | `[代码]` **未兑现**：`MODES` 仅 codemode/whitelist；无 executor 选择分支；Native/Hybrid 为零实现 |
| 二、客户端 | 三平台仅做 **profile 编码**（Gemini text JSON / ChatGPT structuredContent / Claude annotations）；平台检测为**纯观测标签**；clientInfo/UA/header 显式识别；无 mode detection（网页非代码 vs Code 模式） | client-profile.js / client-platform.js / oauth.js | 客户端按平台×模式分 lane；接入→测试→优化→评测→回归；annotations 实验 profile | `[代码]` 部分兑现（编码隔离+OAuth 回调隔离）；未兑现：模式检测、按客户端选执行器、annotations 实验 profile（applyProfileToTools 不改 annotations）；`[未验证]` 真实客户端弹窗行为 |
| 三、评测 | 采集层完整（full-fidelity capture、platform/project/session 标签、model-output truncation audit、digest/analyzer CI）；无 `taskId` 字段；主动/被动字段隔离仅在 docs/CI 层设计 | capture.js / project-tag.js / client-platform.js / capture-daily.yml | session/project/task 交叉、主动/被动隔离、taskId 关联 | `[代码]` **未兑现 taskId**（全 src 零匹配）；sessionId 仅 HTTP 关联；projects 有；主动/被动隔离无代码级字段 |
| 四、上游 | 5 个上游（github/notion/linear/vercel/figma）；OAuth DCR/CIMD/静态 bearer/owner 标记/租约 CAS/401 单次刷新/Figma 配额熔断；callTool 不复核白名单 | upstreams.js / upstream-auth.js / upstream-oauth.js / figma-guard.js | 授权第一位、每上游 SOP、4 上游 + 候选扩展 | `[代码]` 授权生命周期实现最完整；缺口：callTool 策略复核、配置双源矛盾、CIMD BLOCKED；`[未验证]` 真实授权/刷新/401 闭环 |
| 五、运行时 | Vercel 主路径（vercel-app/api/index）、CLI HTTP/stdio（server.js）、Docker/compose 本地路径；无扣费保护的**代码级**机制；无 RuntimeAdapter 抽象 | vercel-app.js / server.js / Dockerfile / vercel.json | RuntimeAdapter、多运行时部署、默认无扣费风险 | `[代码]` **RuntimeAdapter 零匹配**；部署形态是硬编码分叉；`[配置]` main push 部署关闭、Figma 配额保护是费用保护的一部分；`[未验证]` 免费平台实际账单 |
| 六、开源 | MIT 元数据、placeholder author/repo、issue/PR 模板、发布门禁文档（不在本次范围）、OSS 未公开 | package.json / .github 模板 / .dockerignore | 依赖前五层成熟；发布前治理 | `[代码]` 基础件存在；`[配置]` 元数据仍占位；`[未验证]` 公开仓库/安全披露（AGENTS §0 明确未公开） |

### 2.1 用户点名的承诺逐项判定

1. **按客户端选执行器**：`[代码]` 未实现。`createGatewayServer()` 只看 `mode` + `protocolVersion`（server.js L318-323），不看 `profile`；profile 只用于编码。
2. **Native / Hybrid**：`[代码]` 无实现、无枚举值、无分支。FRAMEWORK §15 已把两者列为 L0–L1 缺口，本次源码确认。
3. **RuntimeAdapter**：`[代码]` 全 src 零匹配（grep `taskId|RuntimeAdapter|task_id|runtimeAdapter` 无结果）。无抽象层。
4. **多客户端隔离**：`[代码]` 部分实现——OAuth AS 层 client_id 平台隔离（oauth.js L703-722）、上游 grant 按 owner/env KV 隔离（upstream-auth.js）、capture 标签（platform/profile/oauthClientId）。但**网关实例本身是无状态单 owner**，没有 per-client 会话/权限/限流分账；`client-platform.js` 明写不得参与权限。
5. **taskId**：`[代码]` **完全不存在**，capture envelope 只有 sessionId/projects/platform；FRAMEWORK §4 的“采集按 session/project/task 交叉”缺 task 维度。
6. **approval annotations**：`[代码]` 三工具 annotations 为 search `{true,false,false}` / execute_read `{true,false,true}` / execute `{false,true,true}`（codemode.js L1867、L1894-1896），与 FRAMEWORK §14 一致；`applyProfileToTools()` 对所有 profile 原样保留（L229-240），B 方案实验 profile 未落地。写操作的 host approve/dryRun 闸在 typed-plan 与 file-write 中存在，但不改变客户端弹窗。
7. **origin**：`[代码]` 已实现请求 host 优先（oauth.js `resolveBaseUrl()` L106-145），issuer/resource/401/CIMD 同源；与生产部署记录一致。`[未验证]` 真实客户端是否接受。
8. **KV**：`[代码]` 已实现 v2 命名空间 `gmcgw:v2:grant:<env>:<owner>:<server>`、legacy 只读、CAS/lease；OAuth state 按 env+owner 作用域；DCR client 按 env 域。`[未验证]` 生产 KV 中 owner 迁移是否完成（AGENTS §0 称已部署迁移脚本与隔离检查）。
9. **owner**：`[代码]` `GRANT_OWNERS=[gateway,dsh,manual]`；未标记→shared→拒绝自动刷新；static_bearer 强制 owner=manual。配置层双源矛盾见 §4。`[未验证]` 真实 grant 的实际 owner 标记值。

---

## 3. 代码级缺口 / 死代码 / 未接线 / flag 默认值 / 隐藏耦合（硬要求 4）

### 3.1 [代码] 缺口与缺陷候选

| ID | 位置 | 事实 | 影响 |
|---|---|---|---|
| G-01 | `server.js:318-323`、`config.js:12` | 无客户端→执行器选择；MODES 仅 codemode/whitelist | FRAMEWORK 核心承诺未兑现 |
| G-02 | `codemode.js:1847-1930`、`typed-plan.js:1-9` | Typed Plan 仅沙箱 helper/未接工具面；引擎自述 NOT wired | 执行底座替换能力只在 v2 半接线 |
| G-03 | `vercel-app.js:180-185`、`server.js:689-694` | 生产/CLI 均未注入 `typedPlanIO` | `/mcp/v2` plan 路径无真实 IO（fail closed 但不可用）；v1 `runTypedPlan` helper 有默认 IO，二者不对称 |
| G-04 | `upstreams.js:480-498` | `callTool` 不复核 allow/deny，仅靠 connect 时 entries 过滤 | `gateway_call`/guest 可调用同 server 上被 deny 的工具（工具存在即可） |
| G-05 | `file-write.js:320-322` | `commitSha` 被 `blobSha` 覆盖（两者并存时） | 单文件 patch 结果可能报 blob sha 为 commit sha |
| G-06 | `upstream-auth.js:787-803` | stale-recovery `_save()` 未显式传 owner/source/grantId | 新记录 grantId 走默认格式，与 callback 的 `gw:` 格式不统一（可追踪性下降） |
| G-07 | `vercel-app.js:332` | `startCapture` 未透传 `options` | capture 的注入式配置（含 oauthClientMap）在生产失效 |
| G-08 | `vercel-app.js:405-410` | 顶层 catch 回写原始 `error.message` | 潜在模型可见未脱敏路径（触发条件未验证） |
| G-09 | `capture-queue.js:1-7` vs `capture.js:31,811-827` | 文件头称未接线，实际已接线 | 文档/代码漂移，误导维护者 |
| G-10 | `codemode.js:344` vs `file-write.js:111` | 沙箱 applyPatch 与 host applyTextPatch 两份实现 | 语义漂移风险；host 是严格上下文校验版 |
| G-11 | `capture.js` envelope / 全 src | 无 taskId；sessionId 仅 initialize 关联 | 评测“session/project/task 交叉”缺 task 维 |
| G-12 | `client-profile.js:229-240`、`client-platform.js:9-22` | 平台检测与 profile 仅观测/编码；annotations 不改；无 mode detection | 客户端适配只到编码层，不到执行/权限层 |
| G-13 | `capture-queue.js:120,184` | `seen` Set 按 requestId 永不清空 | 长生命周期进程内存增长（`[未验证]` 规模） |

### 3.2 死代码 / 未接线候选 [代码]

- `src/codemode-util.js::generateTypesFromJsonSchema` — 导出但在 src 内无调用点（可能仅测试使用）。
- `src/typed-plan.js` 默认导出与 `runTypedPlan` 别名 — 引擎自身可用，但生产未直接调用（经 codemode-v2 的 `executeTypedPlan` 间接可达）。
- `src/capture-queue.js::createHttpSink` — 队列 HTTP sink 工厂；生产 `makeQueueBatchSink` 使用 `writeSink`，未用 createHttpSink（仅测试/未来采集器）。
- `src/codemode.js::execTool code fallback` — v2 存在但无 A/B 数据决定默认路径（FRAMEWORK 禁止默认切换）。
- `config.example.json::_authProvisioning` — 未知顶层键，被 `validateConfig()` 警告后忽略（L89-91），不参与任何运行时逻辑。
- `src/server.js::INSTRUCTIONS`（whitelist 模式文案）— codemode 模式下被覆盖，属于 whitelist 遗留面。

### 3.3 flag 默认值 [配置] / [代码]

| flag | 默认 | 来源 | 备注 |
|---|---|---|---|
| `mode` | `codemode`（config.example 显式）；代码缺值→`whitelist`（server.js L690、vercel-app L181） | 配置 + 代码 | 两者不一致：无配置时走 whitelist 多工具面 |
| `ENABLE_MCP_V2` | 关闭（仅 `'1'` 开启） | server.js L51-53 | 双重门控（edge + handler） |
| `CAPTURE_MODE` | `off` | capture.js L305 | 需显式 full/meta |
| `CAPTURE_SINK` | `file`；`CAPTURE_ASYNC_QUEUE=0`；`CAPTURE_SYNC=0` | capture.js L306-330 | 队列开启时同步模式强制 false |
| `UPSTREAM_OAUTH_ADMIN_KEY` | 未设置→start 返回 404 | upstream-oauth.js L208-211 | 网关自己发起上游 OAuth 的开关 |
| `ALLOW_DCR_FOR_CHATGPT` / `_CLAUDE` | 关闭 | oauth.js L372-379 | LOCKED 模式下 DCR 默认拒绝 |
| `grantOwner` 未标记 | `shared` → 拒绝刷新 | upstream-auth.js L218-232 | fail-safe，符合 AGENTS §2 |
| `GATEWAY_MAX_RESULT_CHARS` | 8000（server）；codemode 内 `DEFAULT_MAX_RESULT_CHARS=20000` | server.js L66 / codemode.js L58 | 两套默认，取决于调用路径 |
| `FIGMA_COOLDOWN_MS` | 24h；cache TTL 1h / max 200 | figma-guard.js L16-18 | 进程内 |
| `git.deploymentEnabled.main` | false | vercel.json | 生产 push 自动部署关闭 |

### 3.4 隐藏耦合 [代码]

- `codemode-util.js` 强绑 `@cloudflare/codemode@0.5.6` 的 minified 导出字母与 chunk 文件名；package.json 固定 `0.5.6`（精确版本）说明已知风险。
- `api/index.js` → `vercel-app.js` → `server.js` → `codemode.js` → `capture.js` → `capture-queue.js` → `store.js` → `upstream-auth.js` 形成单一加载链；任一模块顶层失败（如 codemode-util 的动态 import）会导致整个入口不可用。
- `figma-guard` 耦合在 `UpstreamManager.callTool()` 内，按 `server === 'figma'` 硬编码（upstreams.js L482）。
- `project-tag.js` 只识别 GitHub owner/repo（`SERVER='github'`），其他上游无项目标签。
- `searchWithFallback()` 硬编码服务名列表 `['github','notion','linear','vercel']`（codemode.js L1007），figma 不在其中。
- `github-helpers` Actions helper 直接依赖 `GITHUB_TOKEN`，与上游 github 的 tokenEnv 解析路径分离（两条凭据来源）。

### 3.5 [未验证] 需要外部证据的事项

- 生产 `d1f36ba` 的 `/healthz` buildHash 与本地源码是否一致；owner 迁移/KV 隔离脚本在生产是否全绿。
- 真实 Gemini/ChatGPT/Claude 网页非代码模式：3 工具可见性、annotations 弹窗次数、write 回环、授权生命周期。
- 真实上游 401 → 刷新 → 重连闭环；Vercel CIMD 是否仍被 AS 拒绝；Notion DCR offline_access 行为。
- `/mcp/v2` 真实 plan 执行（当前生产未注入 IO，预期失败，需部署侧证据）。
- Docker 构建、npm audit、Figma 配额误触发率、capture R2 写入与访问控制。
- CI 全量测试结果以 lead 最近一次基线为准（`1406/1400/0 fail/6 todo`，本次未重跑）。

---

## 4. 配置层专项矛盾（不写代码，仅记录）

1. **授权意图双源矛盾**：`_authProvisioning.linear/notion = {preferredMode:'static_bearer', grantOwner:'manual'}` 与 `servers[].linear/notion = {grantOwner:'dsh'}`，且 servers[] 未设 `authMode`。运行时只认 servers[]（`_authProvisioning` 被忽略）；因此实际行为是 dsh-owned 环境变量 grant + 永不自动刷新，而 provisioning 段暗示 manual static token——文档/配置误导。
2. **Vercel CIMD 占位**：`clientId:"https://your-domain.example/..."`；与 `vercel-app.js` 的 `cimdClientId()` 动态生成文档一致的正确值应由部署域名派生，但配置是静态占位；AGENTS 记录 CIMD 当前 BLOCKED。
3. **上游数量**：FRAMEWORK 六模块写 4 个上游（github/notion/linear/vercel），实际配置 5 个（+figma，带专用配额熔断）；`searchWithFallback()` 的服务名列表仍只 4 个。
4. **默认 mode 不一致**：配置显式 codemode；代码缺省 whitelist（多工具面）。任何未显式设 mode 的部署会暴露 `gateway_call`/`gateway_search`（与 3 工具不变量冲突）。
5. **OSS 元数据占位**：package.json author/repository/homepage 为 `example-org`；与 AGENTS §0“OSS 未公开”一致，发布前需处理（不在本次范围）。

---

## 5. 与既有审计索引的关系

`docs/FRAMEWORK.md` §15 已索引七份模块审计（00 跨模块、01 客户端、02 核心底座、03 上游、04 评测、05 运行时、06 开源），共同结论为“架构方向成立，但架构承诺与生产默认仍有距离；Native/Hybrid、按客户端选执行器、RuntimeAdapter、多客户端隔离、主动/被动字段隔离仍是 L0–L1”。本次 15-src 是**源码逐文件证据层**，逐项确认了上述结论，并补充了 G-01…G-13 的具体代码位置与 3.3 的 flag 默认值表。所有 `[未验证]` 项均未写“已验收”。

---

## 6. 审计边界声明

- 只读：本次未修改 `src/`、`scripts/`、`tests/`、`README`、其他 docs、workflows；唯一新增文件为本报告。
- 未执行 `git commit` / `push` / `deploy`；未运行会写文件的脚本。
- 报告中的风险是代码级事实或明确标注的假设/未验证项；未把 analyzer/模型建议当结论（AGENTS §1）。
