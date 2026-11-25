# BADCASES — 分类 Badcase 库（云端总控维护）

> **治理标记**：`[云端总控]` 定型（2026-11-24）；2026-11-25 回填 PR #28 五根因、R2 429、BC-015 复现与 ChatGPT 协议观察项。
> **用途**：沉淀所有来自真实客户端主动评测与被动高频分析的高价值问题。
> **分类原则**：按 **客户端 × 上游（含跨上游） × 问题类别** 归档，同时保留原文来源与 `buildCommit`——既保洞察与定向抽测权，也支持随时全量丢给单个客户端回归。
> **下线声明**：不再继续新增 `N10+ / J6+ / FB10+` 等碎片字母编号；新问题统一登记于本表并沉淀进确定性回归测试。
> **跨客户端规则**：公共层（tool 描述 / 返回结构 / 截断规则 / helper 契约）的改动见 `AGENTS.md` §3.2；未完成“主客户端 + 至少一个第二客户端”回归的，只能标「未验证」。

---

## 分类维度字典

- **客户端**：`gemini` | `chatgpt` | `claude` | `cross-client`（网关共性）
- **上游**：`github` | `notion` | `linear` | `vercel` | `figma` | `cross-upstream`（单次任务串多个上游）
- **问题类别**：`正文/契约` | `参数/发现` | `写路径/原子性` | `截断/预算` | `跨上游衔接` | `授权/401` | `弹窗/宿主体验` | `CI/轮询` | `评测/采集` | `评测/归因` | `协议版本/协商`
- **跨客户端验证结果**：`通过`（两端均正向） | `退化`（一端正向一端退化） | `未验证`（未做/证据不足） | `不适用`（客户端/上游专属，不属公共层）
- **关联 activeEvalId**：对应 `active-eval.v1` 的 `activeEvalId`；旧条目可写 `—`，新条目必须填（`check-badcases --strict` 会拦）。
- **回归测试/任务**：确定性测试路径或任务 ID；旧条目可写 `—`，新条目必须填。
- **状态**：`待复现` | `已修待部署` | `已上生产待复验` | `已通过` | `已合入 main 待实测验收`（代码已合入 main，未部署/未重跑，**不得写“已验收”**） | `已定位（外部限流/待转 Pack）` | `已归因（非待修 bug）`

---

## 活跃 Badcase 登记表

| ID | 客户端 | 上游 | 类别 | 现象摘要 | 来源原文 | 发现构建 | 跨客户端验证结果 | 状态 | 关联 activeEvalId | 回归测试/任务 |
|---|---|---|---|---|---|---|---|---|---|---|
| **BC-001** | `cross-client` | `github` | 正文/契约 | 读文件 `content` 偶发混入下载提示/SHA；`fileResult.path` 丢失 | [PR80-101 反馈](ONLINE-FEEDBACK-2026-11-24-PR80-101.md) / Issue #4 | `9ab0e57`（旧） | `未验证`（Gemini 未在当前构建复验，第二客户端未跑） | 已修待复验（`1481408`） | — | — |
| **BC-002** | `cross-client` | `github` | 正文/契约 | 创建 PR 时 `number` 偶发内部 ID；创建 Issue `number` 空或重复 | [PR80-101 反馈](ONLINE-FEEDBACK-2026-11-24-PR80-101.md) | `9ab0e57`（旧） | `未验证`（同上） | PR 已修待复验；Issue 幂等待补 | — | — |
| **BC-003** | `cross-client` | `github` | 写路径/原子性 | `applyFilePatch` 返回 `blobSha` 作 `commitSha`；缺局部补丁一等契约与 TS 预检 | Issue #5 / [PR80-101 反馈](ONLINE-FEEDBACK-2026-11-24-PR80-101.md) | `1481408` | `未验证`（同上） | `commitSha` 已修；补丁/TS 预检待补 | — | — |
| **BC-004** | `gemini` | `cross-upstream` | 弹窗/宿主体验 | 客户端已设“允许”仍频繁弹确认框（`openWorldHint`/`destructiveHint`） | [FRAMEWORK.md](../FRAMEWORK.md) §14 | `1481408` | `不适用`（客户端宿主专属，不属公共层） | 待实验 profile B+D | — | — |
| **BC-005** | `cross-client` | `github` | CI/轮询 | CI 失败缺少 `rerunFailedJobs` helper；合并后未默认清理源分支 | [PR80-101 反馈](ONLINE-FEEDBACK-2026-11-24-PR80-101.md) | `9ab0e57`（旧） | `未验证`（同上） | 待补 | — | — |
| **BC-006** | `cross-client` | `cross-upstream` | 跨上游衔接 | 旧采集 `scorecard` 平台全 `unknown`，且未展开沙箱内部 `subCalls` 给分析器 | [scorecard-2026-11-23](scorecard-2026-11-23.md) | `1481408` | `未验证`（四维分账已落地 PR #18，真实分账未验证） | 已合入 main（PR #10 平台分账 + PR #28 R2 全量分页 / `responsePreview` / `subCalls`）；待 R2 冷却后实测重跑验收 | — | — |
| **BC-007** | `cross-client` | `cross-upstream` | 跨上游衔接 | 单次 `execute_read` 跨 GitHub+Notion+Linear 11 步串行尾延迟 6.2s–14.5s，缺 per-step timing 优化 | [HISTORY-MINED](HISTORY-MINED-2026-11-24.md) §2.2 (`10c13554`) | `2026-11-22` | `未验证`（公共层性能优化，需两端回归） | 待优化 | — | — |
| **BC-008** | `cross-client` | `linear` | 参数/发现 | `list_projects` 触发 GraphQL 复杂度超限（19130 > 10000）与 `limit <= 50` 参数边界报错 | [HISTORY-MINED](HISTORY-MINED-2026-11-24.md) §2.3 (`F112/F116`) | `2026-11-22` | `不适用`（上游参数约束，非公共层优化） | 待优化/提示约束 | — | — |
| **BC-009** | `cross-client` | `notion` | 写路径/原子性 | `notion-update-page` 局部更新防整页覆盖；`validation_error 400` 与 Business 套餐门控需与网关 bug 区分 | [HISTORY-MINED](HISTORY-MINED-2026-11-24.md) §2.3/§3.3 (`F051/F060/F088`) | `2026-11-22` | `不适用`（上游行为/套餐门控） | 待回归 | — | — |
| **BC-010** | `gemini` | `github` | 正文/契约 | 实测 `github__issue_write` 顶层 `number:null`、`normalizeMerge` `number/url:null`、`fileResult` 对 40KB 完整文件误标 `truncated:true`、`writeFiles` 误传 `files` 静默无报错 | Issue #15（云端总控 Gemini 实测） | `1481408` | `未验证`（公共 canon/写路径，需 ChatGPT/Claude 防串伤回归） | 待复现修复 | — | — |
| **BC-011** | `gemini` | `github` | 写路径/契约 | 合并 PR #23 后 `normalizeMerge` 顶层 `number:null`、`url:null`（sha 正常） | [active-eval window1](active-eval-2026-11-24-window1.json) | `3dd206f` | `未验证`（公共 canon，需 ChatGPT/Claude 防串伤） | 待复现修复（Issue #15 剩余项） | `ae_20261124_e20b7502` | Issue #15 / 待补 normalizeMerge 契约测试 |
| **BC-012** | `gemini` | `github` | 写路径/契约 | `writeFiles` 误传 `files` 而非 `patches` / 默认 dryRun 时静默未推 commit | [active-eval window1](active-eval-2026-11-24-window1.json) | `3dd206f` | `未验证`（公共写入口，需第二客户端） | 待复现修复（Issue #15 剩余项） | `ae_20261124_e20b7502` | Issue #15 / 待补 writeFiles 入参测试 |
| **BC-013** | `cross-client` | `cross-upstream` | 返回结构/解包 | `vercel__list_deployments` 列表在 `deployments.deployments`；`github_actions_list_workflow_runs` 在 `data.workflow_runs`，与 `github__list_commits` 数组形状不一致 | [active-eval window1](active-eval-2026-11-24-window1.json) | `3dd206f` | `未验证`（公共 helper 契约） | 待优化 | `ae_20261124_e20b7502` | 待补列表解包契约测试 |
| **BC-014** | `cross-client` | `cross-upstream` | 工具描述/可发现性 | `execute`/`execute_read` 描述约 1500 词无分节，导致漏用 `sliceLines`/`applyFilePatch`、误用 `grepSnippet.window` | [active-eval window1](active-eval-2026-11-24-window1.json) | `3dd206f` | `未验证`（公共描述影响所有客户端） | 待优化 | `ae_20261124_e20b7502` | 待补工具描述审查/示例回归 |
| **BC-015** | `gemini` | `github` | 宿主/挂载生命周期 | 会话中途 MCP 掉线：`unknown tool name`，`expand_tools` 返回 `not-found`，需手动重新 @ 挂载 | [active-eval window2](active-eval-2026-11-24-window2.json) / [cloud-control](active-eval-2026-11-24-cloud-control.json) | `unknown`（被动侧 5039ac6/1481408）；2026-11-24 复现于 `f2002d9` | `未验证`（宿主侧，需第二客户端） | 待复现（2026-11-24 上下文压缩后再次复现；宿主侧，未修） | `ae_20261124_da4104fd` / `ae_20261124_8396a638` | 待补宿主重连探针 |
| **BC-016** | `gemini` | `github` | CI/失败诊断 | `waitForPrChecks` 缺顶层 `runId`；失败 job 缺 failedStep/annotations 摘要；`steps:[]`+日志 404 时无诊断；`get_job_logs` 尾部被容器清理噪音占满 | [active-eval window2](active-eval-2026-11-24-window2.json) | `unknown`（被动侧 5039ac6/1481408） | `未验证`（公共 CI helper） | 待优化 | `ae_20261124_da4104fd` | 待补 CI 失败诊断任务 |
| **BC-017** | `cross-client` | `cross-upstream` | 读取/截断/批处理 | 多字段返回约 20KB 触发整块截断，需多轮 slice；`grepSnippet` window 是字符非行；`Promise.all` 单 404 拖垮整批（应 safeAll） | [active-eval window2](active-eval-2026-11-24-window2.json) | `unknown`（被动侧 5039ac6/1481408） | `未验证`（公共读取契约） | 待优化 | `ae_20261124_da4104fd` | 待补截断/切片/批处理测试 |
| **BC-018** | `gemini` | `cross-upstream` | 评测/归因 | 第二个真实 Gemini 窗口在被动侧被记为 `clientPlatform=unknown`（5039ac6/1481408），无法按 gemini 分账/做 exact 对照 | [active-eval window2](active-eval-2026-11-24-window2.json) | `unknown` | `不适用`（评测基础设施，非公共层） | 已合入 main（PR #28：`analyzerPrompt` + validator 增加 `clientPlatform`/`servers` 归因）；待 R2 冷却后重跑验收 | `ae_20261124_da4104fd` | 待补 clientPlatform 归因测试 |
| **BC-019** | `cross-client` | `cross-upstream` | 评测/采集 | R2 REST API 账户级 1,200 req/5min 限流：分页修复后 weekly 对 7 天全量 raw GET 打满 → 429；digest/analyzer 已产出 34 条（数据未丢），但 run conclusion=failure，需冷却后重跑 | PR #28 真实重跑（run `45455949665`）/ [Cloudflare R2 limits](https://developers.cloudflare.com/r2/platform/limits/) | `cd23fdc`（修复分支） | `不适用`（评测基础设施，非客户端/上游行为） | 已定位外部限流；长期解法 Pack 1 = PR #30 **OPEN（未合并/未部署）** | —（非主动窗口；被动 run `45455949665`） | `tests/capture-digest.test.js`（429 有界重试/`R2_RATE_LIMITED`，PR #30）+ `tests/weekly-from-scorecards.test.js`（PR #30） |
| **BC-020** | `cross-client` | `cross-upstream` | 评测/归因 | 主动 `observed.findings[]` 报出的语义问题无法与被动 `validated.issues` 核对；旧 compare 只覆盖 services/connectFailures，语义漏抓时仍可 `missed: []` + `match=exact`（假绿） | [cloud-control active-eval](active-eval-2026-11-24-cloud-control.json) / PR #28 | `cd23fdc`（修复分支；主动窗口 `f2002d9`） | `不适用`（评测基础设施） | 已合入 main，待 R2 冷却后实测重跑验收 | `ae_20261124_8396a638` | `tests/eval-closure.test.js`（finding 未命中强制 `missed[]` / 默认非零退出） |
| **BC-021** | `chatgpt` | `github` | 参数/发现 | `github__search_code` 连续两次返回 `incomplete_results:true`、`total_count:0`、`items:[]`；改用递归遍历后枚举 38 目录 / 441 候选文件并撞 50 次工具调用上限，全仓符号检索未完成（MK-GH-02 判 `early_termination`） | [T0 active-eval](active-eval-2026-11-24-chatgpt-t0.json) | `1328787` | `未验证`（仅 ChatGPT 窗口；Gemini 未跑同题） | `待复现` | `ae_20261124_30c393b5` | 蒸馏候选 `CAND-20261124-74541350`（search_thrash）；待补确定性用例：`search_code` `incomplete_results=true` 时必须回退受限检索，不得递归全仓 |
| **BC-022** | `chatgpt` | `notion` | 弹窗/宿主体验 | Notion 搜索返回 `These Business-plan options were omitted: filters.edited_by_user_ids, sort.`；最近编辑查询受 Business/Enterprise 套餐门控，属宿主能力限制而非鉴权失败；客户端未用 Recently Viewed 冒充最近编辑 | [T0 active-eval](active-eval-2026-11-24-chatgpt-t0.json) | `1328787` | `未验证`（仅 ChatGPT 窗口） | `已归因（外部套餐限制）` | `ae_20261124_30c393b5` | 待设计 T2 任务：Notion 最近编辑不可用时必须如实降级，禁止用最近浏览替代 |
| **BC-023** | `chatgpt` | `gateway` | CI/轮询 | 首次 `execute_read` 触发 Code Mode 执行超时（`Code Mode execution timed out`），被动捕获该请求 `durationMs=59995`（≈60s 函数上限）、响应体仅 39 字符；重跑后成功。蒸馏同窗输出 `slow_or_unexpected`（CAND-20261125-baba98da） | [Gateway Gate5 active-eval](active-eval-2026-11-25-chatgpt-gateway-gate5.json) | `1328787` | `未验证`（仅 ChatGPT 窗口） | `已定位待修复` | `ae_20261125_58ba7cbe` | 待补确定性用例：单次 execute_read 超过 60s 时应返回明确超时错误码而非空响应 |
| **BC-024** | `chatgpt` | `notion` | 参数/发现 | Notion 工具展示名为 `notion__notion-get-self`、实际调用名为 `notion__notion_get_self`；按调用名执行 `select:` 两次均返回 0，改用展示名后才取到完整 Schema | [Gateway Gate5 active-eval](active-eval-2026-11-25-chatgpt-gateway-gate5.json) | `1328787` | `未验证` | `待复现` | `ae_20261125_58ba7cbe` | 待补：search 的 select 解析应同时接受连字符与下划线两种工具名形态 |
| **BC-025** | `chatgpt` | `gateway` | CI/轮询 | 生产 `1328787` 落后 main `69af629` 共 5 个提交，其中 `faba0d8` 含运行时代码：`tool-format.js` 新增 `lin_api_`/`ntn_`/`figd_` 脱敏规则，生产 blob `8a000ab` vs main `583c418`；台账与线上一致，但与 HEAD 不一致 | [Gateway Gate5 active-eval](active-eval-2026-11-25-chatgpt-gateway-gate5.json) | `69af629`（生产 `1328787`） | `不适用`（部署治理） | `已定位待部署` | `ae_20261125_58ba7cbe` | 部署 main 后核对 `tool-format.js` blob = `583c418`，并跑 `check-status-drift --expected <new>` |

### BC-015 复现记录（2026-11-24，append-only）

| 日期 / 窗口 | 客户端 / 构建 | 触发 | 现象 | 判定 / 证据 |
|---|---|---|---|---|
| 2026-11-24（window2） | gemini / `unknown`（被动侧 `5039ac6`/`1481408`） | 会话中途 | `unknown tool name`、`expand_tools` → `not-found`，需手动重新 @ 挂载 | [active-eval](active-eval-2026-11-24-window2.json) + [同窗对照](active-passive-2026-11-24-window2.json)：`match=unmatched`、被动平台 `unknown`；`未验证` |
| 2026-11-24T15:00–18:20Z（云端总控长会话） | gemini / `f2002d9`（`buildHash=3b1a0772…`；前段 `3dd206f`） | **上下文压缩（compaction）后** | `@Gemini Mcp Gateway` 入口工具全部返回 `not-found`，无法自动重连 | [cloud-control active-eval](active-eval-2026-11-24-cloud-control.json) `ae_20261124_8396a638`，finding `F-mcp-drop`；同窗被动对照待跑 → `NOT_ENOUGH` |

> 两次都不指向网关工具/上游契约缺陷；宿主侧连接生命周期不可控部分记 `unknown`。
> 修复动作尚未发生（无第二客户端复现、无重连探针），因此状态保持 `待复现`，**不得写“已修/已验收”**。

## PR #28 五根因修复回填（2026-11-25，append-only）

> PR #28 已于 2026-11-24T18:19:59Z 合入 `main` `cd23fdc`；**未部署**，生产仍为 `f2002d9` 旧代码。
> 下表是代码态回填，不是生产验收；状态统一为「已合入 main，待 R2 冷却后实测重跑验收」。

| # | 根因 | 现行机制（main `cd23fdc` 代码态） | 关联 BC | 回归测试 | 状态 |
|---|---|---|---|---|---|
| 1 | R2 `list` 全量分页（P0） | `listR2Keys` 改为 `per_page=1000` + `result_info.cursor` 循环，`maxPages` 默认 50；触顶仍有 cursor 时 warning + 返回数组 `truncated=true`，不再静默丢日志；429/5xx 有界重试 | BC-006 / BC-019 | `tests/capture-digest.test.js` | 已合入 main，待 R2 冷却后实测重跑验收 |
| 2 | `isTruncated` 假阳性（P0） | 删除宽泛 `truncated:` 正则；只认 `response.truncated===true`、真实 `truncation` 对象、或响应尾部 256 字符内的固定 marker | BC-010（工具层，相邻问题） | `tests/capture-digest.test.js`、`tests/capture-analyzer.test.js` | 已合入 main，待 R2 冷却后实测重跑验收 |
| 3 | 成功样本返回体轮廓（P0） | `samples[].responsePreview`（前 500 字符 + `topLevelKeys`/`nullKeys`/`arrays`/`nested` 轮廓）；`subCalls[]` 增加 `error`/`resultShape`；预览与错误走 secret 形态脱敏 | BC-006 | `tests/capture-analyzer.test.js` | 已合入 main，待 R2 冷却后实测重跑验收 |
| 4 | analyzerPrompt 成功态 + 归因（P1） | prompt 要求结合 `responsePreview + subCalls + clientPlatform + servers[]` 找 HTTP-200 语义摩擦；issue schema 增加可选 `clientPlatform`/`servers`，validator 不因归因缺失丢 issue | BC-006 / BC-018 | `tests/capture-analyzer.test.js` | 已合入 main，待 R2 冷却后实测重跑验收 |
| 5 | compare 假绿 `missed: []`（P1） | `active-eval.v1` 支持 `observed.findings[] {id,title,keywords}`；compare 逐条匹配被动 `validated.issues` 文本，未命中强制进 `missed[]`（`reason=passive-not-detected`），默认非零退出（`--allow-missed-findings` 才例外） | BC-020 | `tests/eval-closure.test.js` | 已合入 main，待 R2 冷却后实测重跑验收 |

证据与边界：

- **真实 R2 重跑**：旧 main 代码 run `45439868204`（last 30m）只有 2 条 401；PR #28 修复分支 run `45455949665`（last 180m）恢复 **34 条**（gemini 17 / chatgpt 10 / unknown 7）。但该 run 的 7 天 weekly-review 在 R2 GET 上遇 429，run conclusion=failure；digest/analyzer 数据已产出，属外部限流而非数据丢失。
- **未部署**：以上代码只在 `main`/修复分支，生产 `f2002d9` 不含；同窗对账与“修复有效”结论必须等部署/冷却后重跑，不能把 PR 合并写成已验收。
- **Pack 1 = PR #30（OPEN，未合并）**：weekly 默认读已提交 daily scorecard（0 R2 GET）；`from_r2=true` 显式回退；429 解析 `Retry-After`/`Ratelimit`，超 120s 抛 `R2_RATE_LIMITED`。它是 BC-019 的长期解法，不改变上表 #1–#5 的验收状态。
- **Pack 2 = PR #31（OPEN，未合并）**：Notion 无 `tokenEnv` 时注入 gateway OAuth `Authorization`（运行时 401/offline 根因）。这是业务代码 bug，评测文档只记录、**不写已修**；对应 cloud-control active-eval finding `F-notion-offline`（`ae_20261124_8396a638`），验收需合并部署后 `codemode.services()` 实测。

## 已归因观察项（非待查 bug）

### OBS-001 · ChatGPT `server/discover` 400（协议版本协商，expected）

- **观察**：ChatGPT MCP 连接发出 `server/discover` 后收到 HTTP 400 / JSON-RPC `-32000 Bad Request: Unsupported protocol version: 2026-07-28 (supported versions: 2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05, 2024-10-07)`；同一连接随后 `initialize` 200、`tools/list` 200、`notifications/initialized` 202。
- **根因**：**协议版本协商**。ChatGPT 结构化客户端按 MCP `2026-07-28` 发起现代化探测（`server/discover` + `_meta` 版本），网关 SDK 1.32.2 支持上限为 `2025-11-25`；`server/discover` 是 2026-07-28 才成为 MUST 的 RPC，网关按自身支持版本集拒绝，客户端再回退 legacy `initialize` 握手。**不是扩展方法/未知 bug，不是待查缺陷。**
- **证据**：修复分支 run `45455949665` 的 analyzer issue「ChatGPT structured client sends unsupported MCP protocol version 2026-07-28」；digest `server/discover: 2`；同窗 chatgpt 10 条中 `initialize`/`tools/list` 为 200。
- **判定**：记录为观察项，不单独立 bug；若要支持 2026-07-28 现代客户端，需另立协议升级工作包（见 [PLAN-2026-11-23.md](../PLAN-2026-11-23.md)、[mcp-2026-07-compat.md](../ledger/mcp-2026-07-compat.md)），当前不承诺、不升级。
- **状态**：`已归因（非待修 bug）`；不得写“已修/已支持 2026-07-28”。

---

## 跨客户端防串伤回归记录区（M4-C）

> 规则来源：`AGENTS.md` §3.2。每条“公共层优化在主客户端验证有效后”的跨客户端回归都登记在这里；
> 没有第二客户端证据就写 `未验证`，不得用主客户端单端结果代替。

| 日期 | 公共层候选 / 变更 | 主客户端（Gemini） | 第二客户端（ChatGPT / Claude） | 结论 | 证据 |
|---|---|---|---|---|---|
| 2026-11-24 | 本任务无公共层代码变更（仅规则 + 闭环实测）；PR80–101 候选：content notice / PR number URL-first / truncation metadata / CI wait helper | 仅旧构建用户反馈，**当前构建未复验** | **未执行**（无真实第二客户端窗口） | `未验证` —— 不得写“公共层已修复” | [M4-C-FREQ-CLOSED-LOOP-2026-11-24.md](M4-C-FREQ-CLOSED-LOOP-2026-11-24.md) |

| 2026-11-25 | ChatGPT Gate 5 只读三任务（公共层：GitHub 正文纯净、Linear list 截断、Vercel deployment meta/台账） | Gemini 当前构建未复验（本次只跑 ChatGPT） | ChatGPT：AT-GH-01 PASS；AT-LN-01 PASS（首次 `truncated:true`/`keys omitted`，精简后正常）；AT-XU-01 FAIL（`meta:{}` 无 SHA，DEPLOYMENTS 未登记最新 dpl） | `部分通过`（ChatGPT 2/3；跨客户端未验证） | [active-eval](active-eval-2026-11-24-chatgpt-gate5.json) / [active-passive](active-passive-2026-11-24-chatgpt-gate5.json)；`ae_20261124_4889f8f4`；`match=likely`；serviceSnapshots 5/5 observed；被动窗口 19:23:31–19:25:10Z 共 9 条 ChatGPT |

### 跨客户端回归最小检查单（执行时逐项填）

1. 客户端 + buildCommit + requestId（没有写 `unknown`）；
2. 主客户端结果（正向/退化 + 证据字段）；
3. 第二客户端结果（正向/退化 + 证据字段）；
4. 公共层保留 / 下沉 `client-profile` / 底座配置隔离 的判定；
5. 若退化：隔离方案与回归用例路径；
6. 未完成项写 `未验证` 原因，不写成“通过”。

---

## 回归用法

- **定向抽测**：按 `客户端` 或 `上游` 列过滤出 `已上生产待复验` 项，交给对应客户端在受控测试仓库跑一遍；
- **跨客户端防串伤**：按「公共层候选」抽 `cross-client` 条目，先主客户端、再第二客户端各跑一次，结果写进上方记录区；
- **全量回归**：发版前可将表中所有 `cross-client` 与目标客户端条目打包交给单一客户端（如 ChatGPT / Gemini）做回归核验。

## Active eval 最小对照（2026-11-24 cloud-control）

- Active：`ae_20261124_8396a638`（`active-eval-2026-11-24-cloud-control.json`，`requestIds: unknown`）
- Passive：修复分支 run `45455949665` 的 `analyzer-output-2026-11-24-last-180m.json`（窗口 15:19–18:03Z；与 active 15:00–18:20Z 不是逐秒同窗）
- 结果：[active-passive-2026-11-24-cloud-control.json](active-passive-2026-11-24-cloud-control.json) → `match=likely`，findings `total=6/detected=3/missed=1/activeOnly=2`
- `missed[]`：
  - `F-writefiles`（`writeFiles` 静默失败）→ `passive-not-detected`（BC-012；本轮 passive 未抓到）
- `active-only`（不计入 passive 漏检门禁）：
  - `F-mcp-drop`（客户端上下文压缩后掉线，被动日志天生不可见）
  - `F-tool-description`（静态工具描述过长，被动日志天生不可见）
- service snapshots：本历史 passive artifact 是修复前生成的，仍为 0；新的 analyzer `serviceSnapshots` 已支持从 `upstream_connect`/`codemode.services()` 汇总，需部署后重跑同一窗口才能用新证据替换。
- 结论：**半闭环**。active 原文、passive 对照、active-only/missed 分流已落库；但 `missed=1` 未清零，且没有逐秒同窗/新分析器重跑，不能写“闭环完成/已验收”。下一步是部署新 analyzer 后重跑同一 active，确认 `F-writefiles` 是补采集还是业务修复。

### 2026-11-25 ChatGPT Gate 5 实测明细

- Active：`ae_20261124_4889f8f4`（`active-eval-2026-11-24-chatgpt-gate5.json`，`requestIds: unknown`）
- Passive：run `45471052427`（分支 `fix/eval-loop-trigger-and-observability`，`last_minutes=45`、`run_weekly=false`）→ `HAS_DATA`，29 条请求（ChatGPT 9 / Gemini 20）；窗口内 ChatGPT 时间 19:23:31–19:25:10Z；**未出现 R2 429**（Gate 2 短窗）。
- Service snapshots：5/5 observed（GitHub 42 / Vercel 73 / Linear 27 / Notion 53 / Figma 47）；`serviceSnapshots` 生效，不再 `no-snapshot`。
- Compare：`match=likely`、`window/platform/build` 均 match；active 原报告无 requestId，不能伪造 exact；被动首条 ChatGPT `tools/call` = `b9b2fd35…` @19:23:47.390Z，末条 `3cf07cb5…` @19:25:10.737Z，与人工时间窗对齐；总请求 29 条。
- Findings：`total=5 / detected=0 / missed=3 / activeOnly=2`；missed 为 F-chatgpt-deploy-sha、F-chatgpt-linear-truncated、F-chatgpt-execute-read-large（均为 passive-observable）；active-only 为 F-chatgpt-deploy-ledger、F-chatgpt-search-discovery。
- 泛词假绿：本轮无 finding 被 `MCP`/`api`/`error`/`tool` 单泛词判 covered（F-mcp-drop 类假绿被门禁拦下）；但 3 个 passive-observable missed 仍需补 analyzer input/提示词后重跑，当前是 **半闭环**。
- 结论：ChatGPT Gate 5 部分通过（2/3）；AT-XU-01 的 SHA/台账缺口已由本 PR 的 `DEPLOY-POLICY.md` 强制命令与 `DEPLOYMENTS.md` 登记修补策略覆盖，但本次生产 deployment 的 `meta:{}` 是既成事实，需下次带 `--meta githubCommitSha` 重部署才能消除；不能写“Gate 5 通过”。
