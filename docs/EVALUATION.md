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
| F1 | content 混入 notice | weak | fixed/pending-deploy | G1+G2 | J1 + 部署后回放 |
| F2 | PR number 失真 | weak | fixed/pending-deploy | G1+G2 | J2 + 部署后回放 |
| F3 | batch wrapper 不一致 | missing | fixed code-level（`unwrapBatch`） | G3 | J3 + 部署后复验 |
| F4 | 截断切末尾 | weak | fixed code-level（`withTruncationMetadata`） | G3 | J4 + 部署后复验 |
| F5 | 逐文件提交 | weak | fixed code-level（atomic guidance/partial） | G3 | J5 + 部署后复验 |
| F6 | CI 轮询碎 | missing | fixed code-level（`waitForPrChecks`） | G3 | J6 + 部署后复验 |

### ChatGPT 在线反馈

| ID | 问题 | 状态 |
|---|---|---|
| F1 | Actions logs 415 | fixed；真实 replay 200；pending deploy |
| F2 | normalizeFile.path null | fixed；待部署 |
| F3 | PR id/nodeId 缺失 | fixed；待部署 |
| F4 | 大文件 truncated | 通过 |
| F5 | branch 别名 | 通过（控制实验） |

## 6. 还没落实的（诚实清单）

1. J1–J6 已接 L1 `--profile online-gap`（acba249），但 baseline 尚未冻结；
2. 在线 replay harness 已完成（1bb8f8a），真实 capture 端到端仍 unknown；
3. **部署未做**：Vercel 100/day；所以 F1/F2 只能标 `pending-deploy`；
4. **真实客户端 lane**：只有离线 conformance，没有真实 Gemini/ChatGPT/Claude 连接；
5. **canary/shadow**：未实现；
6. **自动 intake**：未实现，当前靠人贴 + lead 记录；
7. F3–F5 代码层已修（codemode-ergonomics），但部署后在线复验未做。

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
> 更正：`20` 次是**已知每次执行/单轮工具调用上限**（见 `GEMINI-PROBE.md`），不是 R2 分页/capture 分母 bug；
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
