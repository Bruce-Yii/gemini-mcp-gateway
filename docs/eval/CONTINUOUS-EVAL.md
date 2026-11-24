# Continuous Eval Cycle — 在线 ↔ 半在线的可重复迭代检查

> 状态：**新增文档（2026-11-23）**。本批只新增 4 个文件：
> `scripts/eval-cycle.mjs`、`tests/eval-cycle.test.js`、本文档、
> `docs/ledger/batch-15-continuous-eval.md`。
> 不改 `src/`、其它 scripts/tests、README、workflows、`explore/` 任务集或任何 baseline；
> 不接定时器、不联网、不写生产、不 commit / push / deploy。

## 1. 它解决什么

`docs/eval/ONLINE-SEMIONLINE-JOIN-2026-11-23.md` 是一次性 join：把 F1–F6、
N1–N9、J1–J6 的关系写清楚，但没有「下次代码改了以后再验一次」的入口。
`scripts/eval-cycle.mjs` 把这个 join 变成**一次命令、可重复运行、有时间戳报告**的
持续迭代检查：

```bash
node scripts/eval-cycle.mjs
# 可选：固定时间/标签，便于确定性测试与对照
node scripts/eval-cycle.mjs --now 2026-11-23T12:00:00.000Z --tag ci-001
# 可选：改输出目录（默认 docs/eval）；--report-dir 指定“上一轮报告”的读取目录，默认同 out-dir
node scripts/eval-cycle.mjs --out-dir /tmp/eval-cycle
```

一次运行依次做：

1. **L1 fake + online-gap profile**：复用 `scripts/run-l1-smoke.mjs` 的确定性 fake
   指标和 N1–N9 / J1–J6 只读加载器（含 fixture 存在性与 dryRun 约束）；不做网络，
   不调用真实 upstream。Fake 数字**只验管线**，不是网关质量结论。
2. **replay fixture**：用 `scripts/replay-online-session.mjs` 的确定性 fake session
   （`createFakeSession`）走 `buildReplayPlan → replayPlan → diffReplay`；写操作强制
   `dryRun`，宿主/模型/时序字段记 `not-comparable`，不伪造 requestId。
3. **join 覆盖审计**：从 join 文档解析 F1–F6 的 `covered/weak/missing`；核对 J1–J6
   存在、N1–N9 加载；`unknown`、SKIP、缺失任务 id 一律记 FAIL 或 INFO，**不记 pass**。
4. **docs artifact 检查**：确认 join 文档、缺口文档、在线反馈记录、两个任务集、以及
   本批的 `CONTINUOUS-EVAL.md` / ledger 存在且带预期标记。
5. **baseline 对比（只读）**：见 §2。

报告写到 `docs/eval/eval-cycle-<timestamp>[-<tag>].json` 和同名 `.md`。
文件名带 ISO 时间戳（冒号/点替换为连字符），以独占创建（`wx`）写入：
**默认不覆盖旧报告**，重复同一秒同标签运行会明确报错而不是覆写。

## 2. baseline 规则（只读、不自动更新）

对比来源，按优先级：

1. `explore/baselines/l1-online-gap.json`（如存在；必须是 `readOnly:true`）；
2. `explore/baselines/l1-smoke.json`（冻结的 L1 指标/阈值）；
3. 上一次 `docs/eval/eval-cycle-*.json` 报告中的 `signature`（持续迭代的“上一轮”）。

签名覆盖：F 行状态、FAIL findings、N/J 任务 id 集合、fake 指标与 skip id、
replay 的 verdict/counts。只有**同 schema 的 eval-cycle 签名**（上一轮报告，或显式
带 `signature` 字段的冻结 baseline）参与比较：签名不同 → **`DRIFT`**，一致 →
`STABLE`；没有任何可比来源 → **`NO_BASELINE`**。冻结的 L1 指标文件 schema 不同，
只读并记为 `REFERENCE`，不会被误判成永久 DRIFT。

- `DRIFT` / `NO_BASELINE` **不算 fail**，但会在 stdout、`baselineStatus`、
  `baselineNote` 和 MD 报告里显式出现，必须人工 review。
- baseline 文件永远只读；cycle 不写、不“刷新”、不把当前结果转成新 baseline。
  要更新冻结 baseline 必须走独立、人工授权的流程。
- 当前 checkout 没有 `l1-online-gap.json`，所以首次运行预期是 `NO_BASELINE`；
  这**不是**“通过质量门禁”，只是“有上一轮之前没有参照”。

## 3. 退出码

| 退出码 | 含义 |
|---|---|
| `0` | 所有检查无 FAIL；允许显式 `DRIFT` / `NO_BASELINE` |
| `1` | 任一检查 FAIL（如任务 id 缺失、必需文档不可读、replay 出现真实写） |
| `2` | CLI 输入错误（如非法 `--now`） |

CLI 在退出前打印一行 `PASS|FAIL | baseline=... | signature=...`，随后是报告路径。
CI 可以直接用退出码做门禁，但不要把 `DRIFT` 自动当成回归失败。

## 4. CI 可选接入（不添加 schedule）

本批**不新增任何 workflow 或定时任务**。若现有流水线已经因 push/PR 触发，可在
其中加一步（仅示例，不落地到本仓库）：

```yaml
- name: Continuous eval cycle (offline)
  run: node scripts/eval-cycle.mjs --tag "${GITHUB_RUN_ID:-local}"
```

约束：

- 不要接 `schedule:` / cron / 本会话的 scheduled task；持续迭代 = “每次改动后人工或
  既有 CI 触发”，不是“定时自动跑”。
- 不需要任何 token / 网络权限；产物是时间戳报告，天然保留历史。
- 报告中的 fake/replay 结论不能替代部署后在线复验；不得据此自动改代码、开 issue、
  合并或部署。

## 5. 什么算“持续迭代”

一次 cycle 结束后，下一轮重复以下闭环（人审驱动）：

```text
改代码 / 改任务 / 新捕获在线反馈
  → node scripts/eval-cycle.mjs（本地或既有 CI）
  → 看 signature：STABLE / DRIFT / NO_BASELINE
  → 看 F1–F6 覆盖是否从 missing/weak 升级、N/J 是否仍全加载
  → 人审决定是否把它写成新的冻结 baseline / 新任务 / 新确定性回归
  → 部署窗口恢复后，另做在线同任务复验（J-DEPLOY，不在本命令内）
```

“持续”体现在：每轮都产出**新的、不可覆盖的**带时间戳报告，签名可以跨轮比较，
覆盖状态被反复核对；**不体现在**自动修复、自动更新 baseline 或定时执行。

## 6. 仍靠人工 intake 的边界（不可自动化部分）

- **在线反馈 intake**：`online-feedback.v1` 的 F1–F6 来自用户报告，全部
  `requestIds:["unknown"]`、`captureVerified:false`。新反馈要由人按
  `docs/eval/ONLINE-FEEDBACK.md` 登记、抽象成半在线轴，cycle 只审计“已登记的轴
  是否仍被覆盖”，不会自己产生新 F 条目。
- **旧构建 vs 新构建对照**：生产仍是 `f2002d9`、`main` `cd23fdc`（PR #28）未部署；禁止跨构建硬比。cycle 的
  fake/replay 只说明当前 checkout 的管线与任务是否可观测，不能判定现网修好。
- **DRIFT 的裁决**：签名变了可能是“任务集升级”也可能是“覆盖回退”，需要人看报告
  决定；cycle 不自动判好坏，也不改 baseline。
- **模型/归因器建议**：按 `AGENTS.md` §1 只是待验证假设；不得由 cycle 输出直接驱动
  改代码、开 issue/PR、合并、部署。
- **J-DEPLOY 与真实凭据**：部署后在线 replay、requestId/capture 证据、vault token
  均为人工、非本命令范围；本命令零网络、零凭据、零真实写。

## 7. 与其他产物的关系

- 输入（只读）：`ONLINE-SEMIONLINE-JOIN-2026-11-23.md`、`SEMI-ONLINE-GAPS.md`、
  `online-feedback-2026-11-23-gemini.md`、`explore/tasks-online-gap*.json`、
  `explore/baselines/*`。
- 复用（只读导入）：`scripts/run-l1-smoke.mjs` 的纯函数、
  `scripts/replay-online-session.mjs` 的纯函数。**不调用**
  `runOnlineGapProfile()`（它会写固定路径 `docs/eval/l1-online-gap*.json|md`）。
- 输出：`docs/eval/eval-cycle-*.json|md`（新增、带时间戳、不覆盖）。
- 台账：`docs/ledger/batch-15-continuous-eval.md`。

---

## 8. 2026-11-25 同步：PR #28 证据链修复与 R2 约束（append-only）

> 本节不改变 §1–§7 的周期定义：`eval-cycle.mjs` 仍然是**离线、零网络、零凭据**的确定性检查。
> 变化发生在它上下游的数据通道（capture-digest / analyzer / compare），必须显式记录，避免把
> “cycle 绿”误读成“线上证据链已验证”。

### 8.1 上游数据通道的新机制（main `cd23fdc`，**未部署**）

| 机制 | 现行行为 | 对 cycle/评测的含义 |
|---|---|---|
| R2 全量分页 | `listR2Keys` 用 `per_page=1000` + `result_info.cursor`，`maxPages` 默认 50；触顶 warning + `truncated=true` | scorecard 分母不再被默认 20 条截断；`truncated=true` 必须显式告警，不能当完整 |
| `isTruncated` 严格化 | 只认 boolean stamp / `truncation` 对象 / 尾部 256 字符固定 marker；删除 `truncated:` 宽正则 | 截断计数不再被普通 JSON 正文污染；`truncated` 统计可进 scorecard 而不产生假阳性 |
| `responsePreview` + `subCalls` | analyzer-input `samples[]` 增加成功响应有界预览 + 结构轮廓；`subCalls[]` 增加 `error`/`resultShape` | 被动侧能看见 HTTP-200 语义摩擦（`number:null`、双层嵌套、误报截断）；预览有界，不做“字段不存在”的强断言 |
| analyzer 归因 | issue 支持可选 `clientPlatform`/`servers[]`；missing 不丢 issue | 被动分析可按平台/上游分账；仍是 advisory，不是事实 |
| `observed.findings` 对账 | compare 输出 `findings{total,detected,missed}`；未命中强制 `missed[]`；默认非零 | 主动语义问题不再被“`missed: []` + `match=exact`”掩盖；重跑需显式 `--allow-missed-findings` 才可放行 |

> PR #28 的五根因、关联 BC 与“未部署/未验收”状态见 [BADCASES.md](BADCASES.md) §PR #28 五根因修复回填。

### 8.2 R2 约束（日常短窗 vs 周报）

- R2 REST API 是**账户级** 1,200 req / 5 min（[官方 limits](https://developers.cloudflare.com/r2/platform/limits/)）。
  修复分支真实重跑 last 180m 已把请求数从 2 恢复到 34，但同 run 的 weekly-review 在 R2 GET 上遇 429；
  数据已产出、run failure 属外部限流，**不是**分页/截断逻辑错误。
- 因此：日常用短窗（`--last-minutes`）；周报**优先聚合已提交 daily scorecard**（0 R2 GET），
  只有显式 `from_r2=true` 才回退 7 天 raw + analyzer（Pack 1 = PR #30，**OPEN 未合并**）。
- 429 必须显式失败：`R2_RATE_LIMITED`（超 120s）是非零错误，**不能**记成 `EMPTY_WINDOW`、
  `NO_BASELINE` 或 pass；缺 scorecard 的日期写 `NOT_ENOUGH`，不伪造完整。
- 结论：PR #28 已合入 main 未部署；Pack 1/Pack 2 未合并；同窗重跑与线上验收待 R2 冷却后执行。

### 8.3 对 eval-cycle 的边界

- `eval-cycle.mjs` 不读 R2、不调 analyzer、不跑 compare，因此上述修复**不会**让 cycle 的
  fake/replay 签名变成线上结论；cycle 的 `STABLE` 只说明“本轮离线管线与任务集与上一轮一致”。
- 若未来把 cycle 接到真实被动数据，输入必须是已产出的 scorecard/analyzer artifact；遇到
  `R2_RATE_LIMITED`/缺 scorecard 必须记 `NOT_ENOUGH` 或显式失败，不能自动转成默认/空窗口通过。
- 同窗重跑（active↔passive）走 [EVAL-CLOSURE.md](EVAL-CLOSURE.md) §3 的 `compare-active-passive.mjs`，
  不在 `eval-cycle.mjs` 内；`findings.missed > 0` 时不得宣称反哺生效。
