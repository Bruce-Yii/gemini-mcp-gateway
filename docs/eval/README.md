# Eval docs index

> **治理标记**：`[云端总控]` 收口（2026-11-24）；2026-11-25 同步 PR #28 / M4 五门 / Pack 1-2 / Issue #27。
> 先读 [../EVALUATION.md](../EVALUATION.md) §9（开发期五环评测闭环）与 §10（PR #28 证据链修复与 R2 约束）。

## 当前门禁入口（本批 M4 五门口径，2026-11-25）

> 「M4 五门」是**本批云端总控定义的口径**，不是既有编号体系；状态必须逐门附证据，不能写成整体 PASS。
> 代码态：`main` `cd23fdc`（PR #28 已合入、**未部署**）；生产：`f2002d9`（旧代码）。

| 门 | 口径 | 当前状态 | 入口 / 证据 |
|---|---|---|---|
| **Gate 1** | 线上采集 + 平台分账 | **PASS（按本轮指定口径）**：scorecard-2026-11-24 真实采集 335 请求（`gemini` 104 / `chatgpt` 10 / `unknown` 221 旧 envelope）；四维分账与 `--platform` / `--eval-mode` 过滤已用真实采集验证；修复分支 last 180m 重跑进一步恢复 34 条（chatgpt 10） | [M4-A-FOUR-DIM.md](M4-A-FOUR-DIM.md)、[BADCASES.md](BADCASES.md) PR #28 回填、[scorecard-2026-11-24.md](scorecard-2026-11-24.md) |
| **Gate 2** | R2 + 免费模型稳定跑通 | **短窗 PASS；周报代码已部署待重跑**：7 天 weekly-review 受 R2 REST API 429（账户级 1,200 req/5min）；Pack 1 = PR #30 已随 `42caaf2` 部署，周报 0 R2 GET 路径待冷却重跑 | [EVAL-CLOSURE.md](EVAL-CLOSURE.md) §2.2、[CONTINUOUS-EVAL.md](CONTINUOUS-EVAL.md) §8 |
| **Gate 3** | 主被动精确对齐 + 反哺闭环 | 请求级 `match=exact` 已达成（PR #24）；`responsePreview` / `observed.findings` 已随 PR #28/`42caaf2` 部署，语义级重跑 **待冷却后**，当前未验收 | [active-eval window1](active-eval-2026-11-24-window1.json)、[EVAL-CLOSURE.md](EVAL-CLOSURE.md) §3.1、[ACTIVE-PASSIVE-CORRELATION.md](ACTIVE-PASSIVE-CORRELATION.md) §10 |
| **Gate 4** | 缺陷闭环修复 | **PASS**：PR #22 修复已线上验证（`3dd206f`/`f2002d9`：`fileResult` 40KB 不误报 `truncated`、`path` 保留；`issue_write` URL 兜底 `number` 随 `3dd206f` 部署） | [BADCASES.md](BADCASES.md) BC-010、[AUTHORITATIVE-SUITE.md](AUTHORITATIVE-SUITE.md) AT-GH-01 |
| **Gate 5** | ChatGPT 跨客户端防回退 | **部分通过（ChatGPT 2/3）**：AT-GH-01 PASS、AT-LN-01 PASS（首次 Linear truncated）、AT-XU-01 FAIL（deployment `meta:{}` 无 SHA + 台账缺记录）；Gemini 当前构建未复验，跨客户端未验证 | [AUTHORITATIVE-SUITE.md](AUTHORITATIVE-SUITE.md) §跨上游 / 单上游任务集 |

### Pack 1 / Pack 2 / Issue #27 关联

| 项 | 内容 | 状态 | 对五门的关系 |
|---|---|---|---|
| **Pack 1 = PR #30** | weekly 默认读已提交 daily scorecard（0 R2 GET）；`from_r2=true` 显式回退；429 解析 `Retry-After`/`Ratelimit`，超 120s 抛 `R2_RATE_LIMITED` | **已合并并随 `42caaf2` 部署，待冷却重跑** | 解锁 Gate 2 周报；不改变 Gate 3 的 exact/findings 判定 |
| **Pack 2 = PR #31** | Notion 无 `tokenEnv` 时也注入 gateway OAuth `Authorization`（运行时 401/offline 根因） | **已合并并随 `42caaf2` 部署，runtime 待在线实测** | 业务代码 bug，不属 M4 修复；是 Gate 5 做 Notion 跨客户端回归的前置 |
| **Issue #27** | 统一客户端接入：预注册 Client Registry 取代生产 DCR（Gemini/ChatGPT/Claude + 自托管） | **OPEN 设计 issue** | 影响 Gate 1 平台分账的接入方式与 Gate 5 的第二客户端；不阻塞本轮 |

### 门禁命令入口

```bash
npm test                                              # 工作区全量（以 lead 最近一次实跑为准）
node scripts/check-badcases.mjs --strict              # 新 Badcase 必须有 activeEvalId + 回归任务
node scripts/check-status-drift.mjs --expected f2002d9  # 生产 commit 引用漂移（人工门禁，非 CI）
node scripts/compare-active-passive.mjs --active ... --passive ...  # 默认对 missed/unmatched 非零
node scripts/eval-cycle.mjs                           # 离线 cycle；STABLE ≠ 线上验证
node scripts/check-module-boundaries.mjs              # 模块边界门禁（0 new violations）
```

> 以上命令输出只证明“检查通过/有数据”，不等于验收；验收仍需真实客户端、部署后复验或 R2 冷却后重跑。

## 核心评测资产（当前活跃）

- [suites/mcpmark-gold.json](suites/mcpmark-gold.json)
- [suites/universe-atlas-gold.json](suites/universe-atlas-gold.json) — 批次 2 精挖金标题库（源自 MCP-Universe 与 MCP-Atlas，16 道长程多步 + 零工具名直跑精题，内置 11 类失败模式诊断标签与 Claim 覆盖阈值） — 批次 1 精挖金标题库（源自 MCPMark 真实 `description.md`，16 道可直跑顶配精题：GitHub 9 + Notion 7，每题含完整 `userPrompt` / `trap` / 二元 `verifiableClaims` / `efficiencyBaseline`）
- [suite.json](suite.json) — 机器可读权威评测题库真源（`authoritative-suite.v2`，72 条：单上游高频工作流 44 + 跨上游/长链条 10 + 对抗性边界 8 + 客户端隔离探针 10，含 T0/T1/T2/T3 四档套餐与跨客户端状态）
- [AUTHORITATIVE-SUITE.md](AUTHORITATIVE-SUITE.md) — 高复用「单上游 + 跨上游」核心权威任务集（19 条，源自真实历史资产；含 AT-GH-01 / AT-LN-01 / AT-XU-01 等）+ 两套深度客户端投喂模板
- [BADCASES.md](BADCASES.md) — 分类 Badcase 库（`客户端 × 上游(含跨上游) × 问题类别`）；含 PR #28 五根因回填、BC-015 复现记录、R2 429 条目与 ChatGPT `server/discover` 观察项
- [HISTORY-MINED-2026-11-24.md](HISTORY-MINED-2026-11-24.md) — 历史主动评测原文、被动日志异常与任务集索引全量打捞
- [ANALYZER-REVIEW.md](ANALYZER-REVIEW.md) — 免费模型建议人工闸门与审查清单
- [CAPTURE-ANALYZER.md](../CAPTURE-ANALYZER.md) — capture → digest → analyzer 的字段口径与边界
- [M4-A-FOUR-DIM.md](M4-A-FOUR-DIM.md) — platform × protocol(v1/v2) × profile × build 四维分账 + `--platform/--eval-mode` 过滤
- [M4-C-FREQ-CLOSED-LOOP-2026-11-24.md](M4-C-FREQ-CLOSED-LOOP-2026-11-24.md) — 跨客户端防串伤规则落地 + 高频闭环实测（R2/analyzer 凭据不可用 → BLOCKED 记录，不伪造）
- [ACTIVE-PASSIVE-CORRELATION.md](ACTIVE-PASSIVE-CORRELATION.md) — 主动↔被动关联机制 + §10 按 PR #28 现行实现校正（observed.findings / findings.missed / responsePreview / R2 429 边界）
- [ONLINE-FEEDBACK.md](ONLINE-FEEDBACK.md) — `online-feedback.v1` schema 与对照规则
- [SEMI-ONLINE-GAPS.md](SEMI-ONLINE-GAPS.md) / [ONLINE-SEMIONLINE-JOIN-2026-11-23.md](ONLINE-SEMIONLINE-JOIN-2026-11-23.md) — 半在线缺口抽象 + F1–F6 / N1–N9 / J1–J6（历史编号，不再新增）

## 闭环执行层（M5-E）

- [EVAL-CLOSURE.md](EVAL-CLOSURE.md) — `active-eval.v1` 记录、同窗 active↔passive 对照、`EMPTY_WINDOW` 语义、状态漂移检查；§2.1 analyzer 成功态字段、§2.2 R2 scorecard 聚合边界；配合 `AGENTS.md` §3.1.1 触发探针
- [CONTINUOUS-EVAL.md](CONTINUOUS-EVAL.md) — `eval-cycle.mjs` 离线 cycle 与 signature/baseline 规则；§8 同步 PR #28 数据通道与 R2 约束
- [L1-FEEDBACK-PROFILE.md](L1-FEEDBACK-PROFILE.md) — L1 `--profile feedback` 接线与反馈任务集
- [L1-ONLINE-GAP-WIRE.md](L1-ONLINE-GAP-WIRE.md) — L1 `--profile online-gap` 接线
- [ONLINE-REPLAY-HARNESS.md](ONLINE-REPLAY-HARNESS.md) — 主动会话回放 harness（fake/replay）
- [LOCAL-E2E-VERIFY.md](LOCAL-E2E-VERIFY.md) — loopback 真实路由 E2E 验证

## 在线反馈与 Scorecard 记录

- 2026-11-24 真实窗口 #1/#2（Gemini）：[active-eval window1](active-eval-2026-11-24-window1.json) / [window2](active-eval-2026-11-24-window2.json)；同窗对照 [window1](active-passive-2026-11-24-window1.json) / [window2](active-passive-2026-11-24-window2.json)
- 2026-11-24 云端总控长会话：[active-eval cloud-control](active-eval-2026-11-24-cloud-control.json)（`ae_20261124_8396a638`，含 `observed.findings[]`；同窗被动对照待 R2 冷却后重跑）
- [ONLINE-FEEDBACK-2026-11-24-PR80-101.md](ONLINE-FEEDBACK-2026-11-24-PR80-101.md) — PR #80–#101 真实使用反馈
- [FEEDBACK-2026-11-24-MATRIX.md](FEEDBACK-2026-11-24-MATRIX.md) — F/G/N/J 矩阵
- [online-feedback-2026-11-23-gemini.md](online-feedback-2026-11-23-gemini.md) / [online-feedback-2026-11-23-chatgpt.md](online-feedback-2026-11-23-chatgpt.md)
- [scorecard-2026-11-24.md](scorecard-2026-11-24.md) / [scorecard-2026-11-23.md](scorecard-2026-11-23.md) / [weekly-2026-47.md](weekly-2026-47.md) / [weekly-2026-46.md](weekly-2026-46.md)
- 运行产物（生成物，非稳定资产）：`l1-smoke-report.md` / `l1-feedback-report.md` / `l1-online-gap-report.md`

## 近期新增 / 变更索引（2026-11-24 → 2026-11-25）

| 日期 | 文档 / 产物 | 变更 |
|---|---|---|
| 2026-11-24 | [AUTHORITATIVE-SUITE.md](AUTHORITATIVE-SUITE.md)、[M4-A-FOUR-DIM.md](M4-A-FOUR-DIM.md)、[M4-C-FREQ-CLOSED-LOOP-2026-11-24.md](M4-C-FREQ-CLOSED-LOOP-2026-11-24.md) | 权威任务集、四维分账、跨客户端防串伤闭环 |
| 2026-11-24 | [EVAL-CLOSURE.md](EVAL-CLOSURE.md)、[BADCASES.md](BADCASES.md) | 4/5 环执行层、双窗口 Badcase 与同窗对照 |
| 2026-11-25 | [EVALUATION.md](../EVALUATION.md) §10、[CONTINUOUS-EVAL.md](CONTINUOUS-EVAL.md) §8、[EVAL-CLOSURE.md](EVAL-CLOSURE.md) §2.1/§2.2、[ACTIVE-PASSIVE-CORRELATION.md](ACTIVE-PASSIVE-CORRELATION.md) §10 | PR #28 五根因机制同步（R2 分页 / `isTruncated` / `responsePreview`+`subCalls` / analyzer 归因 / `observed.findings`）与 R2 429 约束 |
| 2026-11-25 | [BADCASES.md](BADCASES.md) | 新增 BC-019（R2 429）、BC-020（compare 假绿）、BC-015 复现记录、OBS-001（ChatGPT `server/discover` 协议协商） |
| 2026-11-25 | [README.md](README.md)（本文件） | 补 M4 五门 / Pack 1-2 / Issue #27 门禁索引与近期变更 |

## 安全 / 平台合规 / 专项评测

- [CODEMODE-SECURITY-AUDIT.md](CODEMODE-SECURITY-AUDIT.md)
- [PLATFORM-CONFORMANCE-MATRIX.md](PLATFORM-CONFORMANCE-MATRIX.md)
- [MCP-V2-SMOKE.md](MCP-V2-SMOKE.md)
- [RECONNECT-TESTS.md](RECONNECT-TESTS.md)
- [TYPED-PLAN-TEST-PLAN.md](TYPED-PLAN-TEST-PLAN.md)

## 历史半在线归档（不再新增碎片编号）

- [SEMI-ONLINE-GAPS.md](SEMI-ONLINE-GAPS.md) / [ONLINE-SEMIONLINE-JOIN-2026-11-23.md](ONLINE-SEMIONLINE-JOIN-2026-11-23.md) / [FEEDBACK-2026-11-24-MATRIX.md](FEEDBACK-2026-11-24-MATRIX.md) / [CONTINUOUS-EVAL.md](CONTINUOUS-EVAL.md)
