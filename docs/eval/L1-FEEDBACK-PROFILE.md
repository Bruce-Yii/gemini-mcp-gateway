# L1 `--profile feedback` — PR #80–#101 反馈回归接线

> 状态：**runner 接线已实现（文档 + 脚本 + 测试），未 commit / push / deploy**。
> 本批只写：`scripts/run-l1-smoke.mjs`（改）、`tests/l1-feedback-profile.test.js`（新增）、
> 本文（新增）、`docs/ledger/batch-17-feedback-eval.md`（追加）。
> 不改 src/、其它 tests、其它 docs、README、workflows、配置。

## 1. 为什么

`explore/tasks-feedback-2026-11-24.json`（FB1–FB10）与
`explore/tasks-online-gap-3.json`（N10–N16）此前只是**登记的任务定义**，
没有被任何 runner 加载。本批把它们真正接进 L1 smoke，形成可重复执行路径。

## 2. 用法

```bash
node scripts/run-l1-smoke.mjs --mode fake --profile feedback
```

- `--profile feedback` 是 opt-in；不传 flag 时行为与旧 L1 完全一致（50 任务 fake PASS）。
- `--profile online-gap` 的行为、基线、输出**完全不变**（仍加载 N1–N9 + J1–J6，15 任务）。
- `--profile bogus` 仍以 exit 2 拒绝，错误信息现在列出两个合法 profile。

预期输出（2026-11-24 实测）：

```text
[l1-smoke] profile=feedback: PASS (no frozen baseline: all metrics unknown) | loaded=17 skipped=0 baseline=none
[l1-smoke] report: docs\eval\l1-feedback-report.md
```

## 3. 实现要点

### 3.1 复用而非复制

- `loadOnlineGapTasks` 增加可选参数 `idSetLabel`（默认 `N1–N9/J1–J6`），
  仅影响 unknown-task 的 SKIP 文案；online-gap 默认值下文案**逐字不变**
  （有回归测试断言该字符串）。
- `runOnlineGapProfile` 增加可选参数 `profile` / `baselineFile` / `resultJson` /
  `resultMd` / `reportTitle` / `metricsSource` / `taskCount`，默认值保持 online-gap
  的输出字节不变；`runFeedbackProfile` 是薄包装，传入 feedback 自有取值。
- 两份任务集共用同一套 SKIP 语义：unknown/duplicate/unsafe-write/missing-fixture/
  missing-file/missing-task 一律显式 SKIP，绝不静默计入 pass。

### 3.2 独立输出，互不污染

| 产物 | online-gap | feedback |
|---|---|---|
| 当前 JSON | `docs/eval/l1-online-gap.json` | `docs/eval/l1-feedback.json` |
| 当前 MD | `docs/eval/l1-online-gap-report.md` | `docs/eval/l1-feedback-report.md` |
| 冻结基线 | `explore/baselines/l1-online-gap.json` | `explore/baselines/l1-feedback.json`（**尚不存在**，只读加载返回 null） |
| 报告标题 | `L1 Online-Gap Wire Report` | `L1 Feedback Wire Report` |

两个 profile 都**从不写冻结基线**，只写各自的当前结果文件；legacy
`docs/eval/l1-smoke.json` / `-report.md` 不受影响。

### 3.3 PASS 的含义（防止误读）

`PASS` 只表示 **wiring 检查通过**（任务加载、SKIP 记录、指标计算、baseline 比较、报告写出
这条管线没坏）。输出中的 `(no frozen baseline: all metrics unknown)` 是硬性声明：

- 没有冻结基线时 `allUnknown=true`，所有 extended metrics 为 `unknown`，不是 pass；
- fake 模式无网络、无真实上游、无真实凭据、无真实写；不能读作网关质量结论；
- 9 个 model truncation suspect 仍是 advisory，不进入任何判据；
- 20 次是已知执行上限，不是 capture 分母 bug。

### 3.4 当前状态与关闭标准

FB1–FB10 / N10–N16 现在从 `registered` 升级为 **`wired`**（runner 可加载、可出报告），
但**仍不是 `covered`**：perTask 指标尚未由真实 runner 行填充（`perTask: []`），
冻结基线尚未建立。按 `SEMI-ONLINE-GAPS.md` §1.2，关闭一条轴需要
(1) 确定性离线测试 + (2) runner 能报告同一属性；本批完成的是加载/报告管线，(2) 的
指标赋值与基线冻结留待后续（需真实 runner 行，不在本批范围）。

## 4. 测试

```bash
node --test tests/l1-feedback-profile.test.js tests/l1-online-gap-wire.test.js
# 33 pass / 0 fail（2026-11-24 实测）
```

覆盖：CLI surface、17 任务精确加载、SKIP 文案泛化（online-gap 原文不变）、独立输出路径、
不写冻基线、all-unknown 语义、确定性、端到端 CLI（17/0 SKIP）、unknown profile exit 2。
测试全部离线；spawn 类测试会备份/恢复自己写入的报告文件，避免与其它测试进程竞争。

## 5. 索引

- 任务集：`explore/tasks-feedback-2026-11-24.json`、`explore/tasks-online-gap-3.json`
- 矩阵：`docs/eval/FEEDBACK-2026-11-24-MATRIX.md`
- 原始反馈：`docs/eval/ONLINE-FEEDBACK-2026-11-24-PR80-101.md`
- 既有 profile 参考：`docs/eval/L1-ONLINE-GAP-WIRE.md`
- 台账：`docs/ledger/batch-17-feedback-eval.md`
