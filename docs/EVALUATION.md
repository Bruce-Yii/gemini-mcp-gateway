# Evaluation architecture — online × semi-online

> 唯一入口文档。回答三个问题：
> 1) 在线评测和半在线评测各自看什么、看不到什么；
> 2) 一条在线反馈如何变成不会重复发生的半在线回归；
> 3) 当前哪些已经落实、哪些还没落实。
>
> 相关文档：
> - [ONLINE-FEEDBACK.md](eval/ONLINE-FEEDBACK.md) — `online-feedback.v1` schema / 记录流程
> - [SEMI-ONLINE-GAPS.md](eval/SEMI-ONLINE-GAPS.md) — 半在线缺口抽象 + N1–N9
> - [ONLINE-SEMIONLINE-JOIN-2026-11-23.md](eval/ONLINE-SEMIONLINE-JOIN-2026-11-23.md) — F1–F6 × 半在线 join / J1–J6
> - [TYPED-PLAN-TEST-PLAN.md](eval/TYPED-PLAN-TEST-PLAN.md) — 配对/分账/验收线
> - [EXECUTION-PLAN.md](EXECUTION-PLAN.md) — 跨板块任务路由

## 1. 两个评测面

| | 在线（online） | 半在线（semi-online = L1/G6/replay） |
|---|---|---|
| 触发 | 真实用户/真实客户端 | 固定任务集 / runner |
| 环境 | 真实上游、OAuth、宿主、上下文压力 | fake/replay/受控 real |
| 强项 | 发现新维度、真实客户端行为、真实数据形状 | 可重复、可比较、可进 CI |
| 盲区 | 难复现、缺 requestId、构建版本混淆 | 看不到宿主内部、真实用户用法、随机模型行为 |

**结论：半在线不能替代在线；在线也不能替代半在线。**
在线负责“发现”，半在线负责“固化”。

## 2. 分层模型

```text
L0 纯函数/契约测试        无网络，秒级
L1 fake/replay 任务集     固定任务，可进 CI
L2 真实客户端 conformance 受控仓库 + 真实 Gemini/ChatGPT/Claude
L3 canary/shadow          真实流量，新旧并行，只记录差异
L4 人工在线反馈           用户真实窗口，发现新维度
```

- L0/L1 每次提交跑；
- L2 发布前跑；
- L3 部署窗口跑；
- L4 持续发生，必须被 intake。

## 3. 一条在线反馈的标准闭环

```text
用户反馈
  → online-feedback.v1 记录（unknown 不编造）
  → F 矩阵：在线证据能证明/不能证明什么
  → G 缺口分类（G1 盲区 / G2 未部署 / G3 在线-only / G4 客户端 / G5 指标 / G6 证据链）
  → 对应半在线轴（N/J/T）
  → 回归测试或任务
  → 在旧构建 vs 新构建分别跑（同 prompt/fixture/session）
  → 部署后在线复验
  → 更新 join 文档与 baseline
```

硬规则：

- 在线报告是**待验证假设**，不是事实，不直接驱动改代码/开 issue/部署；
- 没有 requestId 就写 `unknown`，不补造；
- 不跨构建硬比，不把 durationMs/bytes 换算成 tokens；
- 数据不足就标 `NOT_ENOUGH`，不自动切默认；
- 客户端宿主不可控的部分记 `unknown`，不记网关 pass/fail。

## 4. 当前 inventory

| 层 | 产物 | 状态 |
|---|---|---|
| schema/intake | `docs/eval/ONLINE-FEEDBACK.md`、`scripts/record-online-feedback.mjs` | ✅ |
| 在线记录 | `online-feedback-2026-11-23.md`、`-chatgpt.md`、`-gemini.md` | ✅ |
| 半在线缺口 | `SEMI-ONLINE-GAPS.md`、`tests/online-gap-regression.test.js` | ✅ 17 pass + 6 todo |
| 任务集 | `explore/tasks-online-gap.json` N1–N9 | ✅ |
| join | `ONLINE-SEMIONLINE-JOIN-2026-11-23.md`、`tasks-online-gap-2.json` J1–J6 | ✅ |
| join 测试 | `tests/online-semionline-join.test.js` | ✅ 14/14 |
| L1 接线 | `scripts/run-l1-smoke.mjs --profile online-gap` | ✅ 21/21；commit acba249 |
| 在线 replay | `scripts/replay-online-session.mjs` | ✅ 22/22；commit 1bb8f8a |
| 真实客户端 lane | platform conformance suite / matrix | ✅ 离线；真实连接未做 |
| canary/shadow | 未实现（需部署/流量） | ❌ |
| 自动 intake | 未实现（当前人工记录） | ❌ |

## 5. 2026-11-23 两轮在线反馈状态

### Gemini F1–F6（PR #77–#80）

| ID | 问题 | 半在线 | 代码层 | 缺口 | 下一步 |
|---|---|---|---|---|---|
| F1 | content 混入 notice | weak | fixed/deployed 3dd206f，在线复验未做 | G1+G2 | J1 + 同窗在线回放 |
| F2 | PR number 失真 | weak | fixed/deployed 3dd206f，在线复验未做 | G1+G2 | J2 + 同窗在线回放 |
| F3 | batch wrapper 不一致 | missing | fixed code-level（`unwrapBatch`） | G3 | J3 + 部署后复验 |
| F4 | 截断切末尾 | weak | fixed code-level（`withTruncationMetadata`） | G3 | J4 + 部署后复验 |
| F5 | 逐文件提交 | weak | fixed code-level（atomic guidance/partial） | G3 | J5 + 部署后复验 |
| F6 | CI 轮询碎 | missing | fixed code-level（`waitForPrChecks`） | G3 | J6 + 部署后复验 |

### ChatGPT 在线反馈

| ID | 问题 | 状态 |
|---|---|---|
| F1 | Actions logs 415 | fixed；真实 replay 200；deployed 3dd206f，在线复验未做 |
| F2 | normalizeFile.path null | fixed；deployed 3dd206f |
| F3 | PR id/nodeId 缺失 | fixed；deployed 3dd206f |
| F4 | 大文件 truncated | 通过 |
| F5 | branch 别名 | 通过（控制实验） |

## 6. 还没落实的（诚实清单）

1. J1–J6 已接 L1 `--profile online-gap`（acba249），但 baseline 尚未冻结；
2. 在线 replay harness 已完成（1bb8f8a），真实 capture 端到端仍 unknown；
3. **部署进度**：生产 `f2002d9`（2026-11-25 01:55 手动部署）；F1/F2 的修复已随 `3dd206f` 上线（`f2002d9` 继承），但 PR #28 的证据链修复只在 `main` `cd23fdc`（**未部署**）；F1/F2 同窗在线复验仍未做（不得写“验收通过”）；
4. **真实客户端 lane**：只有离线 conformance，没有真实 Gemini/ChatGPT/Claude 连接；
5. **canary/shadow**：未实现；
6. **自动 intake**：未实现，当前靠人贴 + lead 记录；
7. F3–F5 代码层已修（codemode-ergonomics），但部署后在线复验未做；
8. **PR #28 证据链修复**已合入 `main` `cd23fdc`（R2 全量分页 / `isTruncated` 严格化 / `responsePreview`+`subCalls` / analyzer 成功态归因 / `observed.findings` 对账），**未部署**（生产仍 `f2002d9`）；同窗重跑与验收待 R2 冷却后执行。Pack 1（PR #30，weekly 读 scorecard + `R2_RATE_LIMITED`）与 Pack 2（PR #31，Notion 运行时 `Authorization`）均 **OPEN 未合并**。

## 7. 新增一条在线反馈时

1. 复制 `online-feedback-2026-11-23-gemini.md` 的 schema；
2. 写清 build、platform、evidence、`requestId`（没有就 unknown）；
3. 在 `SEMI-ONLINE-GAPS.md` 加 F 行，标 covered/weak/missing；
4. 若 missing/weak，加 N/J 任务到对应任务集；
5. 写确定性测试或明确 `todo` + 原因；
6. 更新 `ONLINE-SEMIONLINE-JOIN-*.md`；
7. 部署后同任务复验，更新状态；
8. 不许只写“已记录”就结束。

- 主动↔被动时间戳/任务关联设计：[eval/ACTIVE-PASSIVE-CORRELATION.md](eval/ACTIVE-PASSIVE-CORRELATION.md)


- 2026-11-24 PR #80–#101 真实反馈与被动 scorecard 对照：[eval/ONLINE-FEEDBACK-2026-11-24-PR80-101.md](eval/ONLINE-FEEDBACK-2026-11-24-PR80-101.md)

---

## 8. 2026-11-24 PR #80–#101 反馈接入（append-only）

> 本批把真实体感反馈转成可重复回归，不只是写报告；不改 src/scripts/tests，不 commit/push/deploy。
> 更正（2026-11-24 二次核对，覆盖以上旧误判）：scorecard 只见 20 条不是 Gemini 上限，而是 **Cloudflare R2 list 默认每页 20 条**（UUID 字典序）导致日志缺失；
> `scripts/capture-digest.mjs` 的 `listR2Keys` 已改为 `per_page=1000` + `result_info.cursor` 全量翻页（触顶时 warning + 返回数组 `truncated=true`，不再静默丢）。
> Gemini 单轮约 `20` 次工具调用上限仍然存在（见 `GEMINI-PROBE.md`），但**不能**再把 scorecard 的 20 条当全量分母。
> 样本不足、不能定量的结论保留。9 个 `model truncation suspect` 标 **advisory**，不作事实/判据。

- **F/G/N/J 矩阵**：[eval/FEEDBACK-2026-11-24-MATRIX.md](eval/FEEDBACK-2026-11-24-MATRIX.md)
  — 反馈项 → 能证明/不能证明 → G 缺口分类 → 离线任务 → 半在线任务 → 验收。
- **离线任务集**：`explore/tasks-feedback-2026-11-24.json`（FB1–FB10，
  覆盖 issue 重复 / PR number / 文件 content 污染 / batch unwrap / TS 预检 / patch edit /
  truncation / CI rerun+wait / delete+rename / branch cleanup；每条含 tool-level truth、
  fixture、断言点；不编造 requestId）。
- **半在线任务集**：`explore/tasks-online-gap-3.json`（N10–N16，抽象自反馈、不照抄原文；
  编号避开旧 N1–N9 与 J1–J6）。
- **缺口登记**：[eval/SEMI-ONLINE-GAPS.md](eval/SEMI-ONLINE-GAPS.md) §8 N10–N16（append-only）。
- **台账**：`docs/ledger/batch-17-feedback-eval.md`。

状态：FB/N10–N16 为已登记任务（fake/replay、`dryRun:true`、`forRealWrite=false`、
`requestIds:unknown`），尚未接入真实 runner；部署后同任务在线复验与 join/baseline 更新不在本批。

---

## 9. 云端总控定型：开发期五环评测闭环（2026-11-24 收口）

> 为贴合当前高频开发迭代节奏（半小时~1小时一轮），不追求重型全自动化，将评测体系收口为以下 5 环闭环，并**正式下线/停止新增 `N10+ / J6+ / FB10+` 碎片字母编号**（历史任务集仅作归档，新问题统一进 [eval/BADCASES.md](eval/BADCASES.md)）：

1. **无感采集层（`src/evidence/capture.js`）**：全保真采集落 R2，带 `buildCommit`、OAuth `clientPlatform`、`servers[]`（跨上游）与可选 `evalMode`（`active`/`passive`），以 `session / 15分钟窗口 / project` 聚合切片。
2. **高频被动分析（`scripts/analyze-captures.mjs`）**：支持 `--last-minutes 60` 与 `--commit` 快拉，展开沙箱内 `upstream subCalls[]` 明细，交给免费模型灵活识问题（仅作假设）。
3. **主动线上评测（真实客户端分工）**：
   - **Gemini**：以日常真实会话 + 隔几轮询问优缺点、前后对比为主；
   - **ChatGPT 及其他平台**：以批量运行高复用的单上游/跨上游权威任务集（Issue #3 模式）为主；
   - **纠偏**：停止用本地 `hy4` 弱模型（及 DSH 宿主）跑分来评判客户端适配能力，离线侧只保留无模型的确定性契约回归。
4. **分类 Badcase 与复现回归（`docs/eval/BADCASES.md`）**：按 `客户端 × 上游(含跨上游) × 问题类别` 沉淀，拿到线索后直接换受控测试仓库复现动作并修复。
5. **主动反哺被动（`AGENTS.md` §3.1 触发）**：每次主动反馈丢进开发窗口，固定顺手拉同一时间窗被动日志对照，补齐采集盲区或分析提示词，逐步压低人工主动频次。

> 执行层（2026-11-24 补）：`active-eval.v1` 记录、同窗对照、`EMPTY_WINDOW` 语义、状态漂移检查
> 见 [eval/EVAL-CLOSURE.md](eval/EVAL-CLOSURE.md)；开发窗口的触发探针见 `AGENTS.md` §3.1.1。

---

## 10. 2026-11-25 证据链修复（PR #28）与 R2 约束（append-only）

> PR #28 已于 2026-11-24T18:19:59Z 合入 `main` `cd23fdc`，**未部署**（生产仍 `f2002d9` 旧代码）。
> 本节只同步**代码态机制**与**边界**，不是生产验收，也不是“线上已修”。

### 10.1 五个根因 → 现行机制

| # | 根因 | 现行机制（`main` `cd23fdc`） | 主要落位 |
|---|---|---|---|
| 1 | R2 `list` 默认每页 20 条导致日志静默缺失（P0） | `listR2Keys` 使用 `per_page=1000` + `result_info.cursor` 全量翻页，`maxPages` 默认 50；触顶仍有 cursor 时 warning + 返回数组 `truncated=true`；429/5xx 有界重试 | `scripts/capture-digest.mjs` |
| 2 | `isTruncated` 假阳性（P0） | 删除宽泛 `truncated:` 正则；只认 `response.truncated===true`、真实 `truncation` 对象、或响应尾部 256 字符内的固定 marker；普通 JSON 正文里的 `"truncated": false/true` 不再误判 | `scripts/capture-digest.mjs` |
| 3 | 成功样本不可见（P0） | analyzer-input 的 `samples[]` 增加 `responsePreview`（前 500 字符 + `topLevelKeys`/`nullKeys`/`arrays`/`nested` 轮廓）；`subCalls[]` 增加 `error`/`resultShape`；预览与错误做 secret 形态脱敏 | `scripts/analyze-captures.mjs` |
| 4 | analyzerPrompt 只盯错误簇 + 无归因（P1） | prompt 要求结合 `responsePreview + subCalls + clientPlatform + servers[]` 识别 HTTP-200 语义摩擦（null 字段、双层嵌套、误报截断、跨上游冗余、重复防御解析）；issue schema 增加可选 `clientPlatform`/`servers`，validator 不因归因缺失丢 issue | `scripts/analyze-captures.mjs` |
| 5 | 主动↔被动对照假绿 `missed: []`（P1） | `active-eval.v1` 支持 `observed.findings[] {id,title,keywords}`；compare 逐条匹配被动 `validated.issues` 的 `title+likelyCause+suggestedFix`，未命中强制 `missed[]`（`reason=passive-not-detected`），默认非零退出（显式 `--allow-missed-findings` 才例外） | `scripts/record-active-eval.mjs`、`scripts/compare-active-passive.mjs` |

边界：

- `responsePreview` 是**有界**预览；字段不在 preview 里 ≠ 全量 body 里不存在，analyzer 不得据此过度断言。
- analyzer 输出仍是 **advisory 假设**（`AGENTS.md` §1）；归因/`servers[]` 是模型推断，不是事实。
- `isTruncated` 修复是**采集侧语义**，不改工具层 `fileResult.truncated`（后者已在 `3dd206f` 修过 40KB 假阳性）。

### 10.2 R2 约束（日常短窗与周报解耦）

- **外部限流事实**：R2 REST API 是**账户级** 1,200 req / 5 min（[官方 limits](https://developers.cloudflare.com/r2/platform/limits/)）。
- **问题**：分页修复后 `capture-daily` 能取全量，但 weekly-review 每次手动 dispatch 都重扫 7 天 raw envelope，会打满配额触发 429。
- **已观测**：修复分支真实重跑 last 180m，请求数 **2 → 34**（gemini 17 / chatgpt 10 / unknown 7）；同 run 的 weekly-review 在 R2 GET 上仍 429，run conclusion=failure——**digest/analyzer 数据已产出，不是数据丢失**，需冷却后重跑。
- **现行约束（代码态）**：
  1. 日常分析只用**短窗**（`--last-minutes`），不默认拉 7 天；
  2. 周报优先**聚合已提交的 daily scorecard**（`docs/eval/scorecard-YYYY-MM-DD.json`），0 R2 GET（Pack 1 = PR #30，**OPEN 未合并**）；
  3. 只有显式 `from_r2=true` 才回退旧 `capture-digest --since --days 7` + analyzer；
  4. 429 解析 `Retry-After`/`Ratelimit`，总等待超 120s 抛显式 `R2_RATE_LIMITED`，**不把 429 当空报告/成功**；缺 scorecard 的日期写 `NOT_ENOUGH`，不伪造完整。
- **诚实状态**：PR #28 已合入 main 未部署；Pack 1/Pack 2 未合并；`2 → 34` 是修复分支观测，不能当生产验收。

### 10.3 与门禁索引的关系

本批「M4 五门」口径（Gate1 线上采集+平台分账 / Gate2 R2+免费模型稳定跑通 / Gate3 主被动精确对齐+反哺闭环 / Gate4 缺陷闭环修复 / Gate5 ChatGPT 跨客户端防回退）见 [eval/README.md](eval/README.md) §当前门禁入口；五门不是既有编号体系，状态必须按证据随附，不能写成整体 PASS。
