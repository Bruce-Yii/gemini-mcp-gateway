# B17 · PR #80–#101 反馈接入离线/半在线评测（可重复回归）

> 状态：**文档 + 任务集（新增/更新），无代码/测试改动；未 commit / push / deploy**。
> 本批严格只写任务指定文件：
> - 新增 `explore/tasks-feedback-2026-11-24.json`
> - 新增 `explore/tasks-online-gap-3.json`
> - 新增 `docs/eval/FEEDBACK-2026-11-24-MATRIX.md`
> - 更新 `docs/eval/ONLINE-FEEDBACK-2026-11-24-PR80-101.md`
> - 更新 `docs/eval/SEMI-ONLINE-GAPS.md`（仅追加 §8）
> - 更新 `docs/EVALUATION.md`（仅追加 §8）
> - 新增本文
>
> 未改 `src/`、`scripts/`、`tests/`、其它 docs、README、workflows、配置。
> 工作区内出现的 `src/execution/*.js` 改动来自**并发的其它 agent**，非本批产生，本文不描述、不处理。

---

## 0. 目标与结果

把 PR #80–#101 的真实体感反馈接入离线/半在线评测体系，形成**可重复回归**，而不是只写报告。

| 目标 | 交付 | 状态 |
|---|---|---|
| F/G/N/J 矩阵 | `docs/eval/FEEDBACK-2026-11-24-MATRIX.md` | ✅ 反馈→能/不能证明→G→离线 N(FB)→半在线 J(N10+)→验收 |
| 离线任务 JSON | `explore/tasks-feedback-2026-11-24.json` | ✅ 10 条 FB1–FB10，全部含 tool-level truth / fixture / 断言点 |
| 在线 gap-3 任务 | `explore/tasks-online-gap-3.json` | ✅ N10–N16，抽象自反馈、不复制原文 |
| N 编号避冲突 | `SEMI-ONLINE-GAPS.md` §8 | ✅ N10 起，未动 N1–N9 / J1–J6 |
| EVALUATION 索引 | `docs/EVALUATION.md` §8 | ✅ 已追加索引 |
| 修正 20 次推断 | `ONLINE-FEEDBACK-...PR80-101.md` | ✅ 标「已知每次执行 20 次上限」，非 R2 分页/分母 bug；保留「样本不足、不能定量」 |
| truncation suspect | 全批 | ✅ 标 advisory，不作事实/判据 |
| 跑 L1 smoke 并记录 | 本文 §3 | ✅ 实际执行，结果 PASS（wiring），见下 |

---

## 1. 关键更正：20 次不是 capture 分母 bug

- 用户确认「一次执行确实只能 20 次，以前就有测试上限记录」；
- 佐证：`docs/GEMINI-PROBE.md` 记 Gemini 单轮约 20 次工具调用上限（客户端侧，非网关）；
- 因此旧文档「20 很可能是 R2 list 上限 / 修 R2 分页分母」的推断**已废弃**，反馈文档与
  `OF-3` 工作包已相应改写；
- 被动 scorecard（2026-11-23）：20 请求 / 10 项目请求 / 10 工具调用 /
  9 model truncation suspects（advisory）/ 3 错误 / p95 5153ms / clientPlatform 全 unknown /
  时间窗 00:43–03:24 UTC。样本受执行上限约束，不能定量，保留该结论。

---

## 2. 反馈 → 回归映射

- 10 条离线任务 FB1–FB10 覆盖：issue 重复、PR number、文件 content 污染、batch unwrap、
  TS 预检、patch edit、truncation、CI rerun/wait、delete/rename、branch cleanup；
  每条含 `expectedTools` / `expectedOps` / `toolLevelTruth` / `fixture` / `assertionPoints`。
- 7 条半在线任务 N10–N16 抽象在线-only 轴（创建幂等、预检+patch、advisory 隔离、
  CI wait+rerun、delete/rename 原子、合并后清理、证据链），编号避开 N1–N9。
- 全部 `dryRun:true` / `forRealWrite:false` / fake/replay / `requestIds:unknown`；
  不编造真实 requestId（`scorecard` 中的 requestId 样本未被复制到任务里）。

---

## 3. 执行命令与结果（如实记录）

命令：

```text
node scripts/run-l1-smoke.mjs --mode fake --profile online-gap
```

实际输出（2026-11-24，原样）：

```text
[l1-smoke] profile=online-gap: PASS (no frozen baseline: all metrics unknown) | loaded=15 skipped=0 baseline=none
[l1-smoke] report: docs\eval\l1-online-gap-report.md
EXIT_CODE=0
```

解读（避免夸大）：

- **PASS = 接线检查通过**，不是网关质量结论；输出自述 `no frozen baseline: all metrics unknown`。
- 该 profile 当前仅加载 `explore/tasks-online-gap.json`（N1–N9）与
  `explore/tasks-online-gap-2.json`（J1–J6），共 15 条、0 SKIP。
- **本批新增的 FB1–FB10 与 N10–N16 不在该 profile 的文件列表里**（runner 未改，符合本批
  「不改 scripts」的约束）；它们目前是任务定义 + 断言点，尚未接入 runner。按 §1.2 关闭标准，
  状态为 `registered`，不是 `covered`。
- 未使用 `--profile online-gap` 之外的真实/replay 模式：本批无网络、无真实凭据、无真实写。

命令生成的 `docs/eval/l1-online-gap-report.md` 与 `docs/eval/l1-online-gap.json` 属于本批
**允许写入清单之外**的产物，已在确认其 untracked 且仅由本次 smoke 生成后删除，以严格遵守写入范围；
结果以本文记录为准。

JSON 校验（附加自检，非门禁）：

```text
explore/tasks-feedback-2026-11-24.json OK count=10 ids=FB1,...,FB10
explore/tasks-online-gap-3.json        OK count=7  ids=N10,...,N16
```

---

## 4. 未验证项 / 边界

1. **真实窗口在线复验未做**：FB/N10–N16 需在部署后用同任务、有 requestId/capture 的在线窗口复验；本批不声称现网修好。
2. **无冻结基线**：online-gap profile 当前 `baseline=none`，所有指标 unknown，不能用于跨构建硬比。
3. **advisory 信号**：9 个 model truncation suspect 不是事实，未进入任何 pass/fail 判据。
4. **不自造证据**：全批 `requestIds:unknown`，不从 scorecard 样本复制 UUID。
5. **并发写入**：工作区的 `src/execution/*.js` 修改由其它 agent 产生；本 agent 未触碰，集成由 lead 统一处理。

---

## 5. 结论

反馈已经从「一条报告」变成「可重复回归的任务集 + 矩阵 + 索引」，并跑通了现有的
L1 online-gap 接线（PASS，wiring only）。剩余工作是 runner 接入新任务、冻结基线、
以及部署后在线复验——这些需要改 scripts/或真实窗口，不在本批写入范围。

**不 commit / push / deploy。** 按 `AGENTS.md` §1，反馈与模型输出只是待验证假设。

---

## 6. 追加：新任务真正接入 runner（`--profile feedback`）

> 本节记录 lead 后续授权的第二阶段工作，**更新上文 §3/§5 的口径**：FB1–FB10 与 N10–N16
> 已从 `registered` 升级为 **`wired`**（runner 可加载、可出独立报告），但**仍不是 `covered`**
> （perTask 指标未赋值、冻结基线未建立）。
> 追加授权写入范围：`scripts/run-l1-smoke.mjs`（改）、`tests/l1-feedback-profile.test.js`（新增）、
> `docs/eval/L1-FEEDBACK-PROFILE.md`（新增）、本文（追加）。不改 src/、其它 tests/docs、workflows。

### 6.1 实现

- 新增 `--profile feedback`，加载 `explore/tasks-feedback-2026-11-24.json` +
  `explore/tasks-online-gap-3.json`，expected IDs = FB1–FB10 + N10–N16（17 条）。
- 复用 `loadOnlineGapTasks`：新增可选 `idSetLabel` 参数（默认 `N1–N9/J1–J6`），
  只泛化 unknown-task 的 SKIP 文案；online-gap 默认值下文案逐字不变（有断言保护）。
- 复用 `runOnlineGapProfile`：新增可选 `profile`/`baselineFile`/`resultJson`/`resultMd`/
  `reportTitle`/`metricsSource`/`taskCount` 参数，默认值保持 online-gap 输出字节不变；
  `runFeedbackProfile` 为薄包装。**不改 online-gap 行为/基线/输出。**
- 独立产物：`docs/eval/l1-feedback-report.md`、`docs/eval/l1-feedback.json`；
  冻结基线路径 `explore/baselines/l1-feedback.json` 当前不存在，只读加载返回 null；
  两个 profile 都从不写冻结基线，legacy `docs/eval/l1-smoke.json` 不受影响。

### 6.2 命令与结果（实测原样）

```text
node scripts/run-l1-smoke.mjs --mode fake --profile feedback
[l1-smoke] profile=feedback: PASS (no frozen baseline: all metrics unknown) | loaded=17 skipped=0 baseline=none
[l1-smoke] report: docs\eval\l1-feedback-report.md
EXIT_CODE=0
```

产物自检：`profile=feedback, tasks=17, loaded=17, skipped=0, allUnknown=true`；
报告首行 `Tasks: 17 loaded, 0 SKIP`，标题 `L1 Feedback Wire Report`。
PASS 仅为 wiring 检查；无冻结基线 → 所有 extended metrics unknown，不是质量结论。

回归检查（同批实测）：

```text
node scripts/run-l1-smoke.mjs --mode fake --profile online-gap
→ PASS | loaded=15 skipped=0 baseline=none，EXIT=0（行为未变）

node scripts/run-l1-smoke.mjs --mode fake
→ fake-dry-run: PASS | measured=50/50，EXIT=0（legacy 未变）
```

### 6.3 测试结果

```text
node --test tests/l1-feedback-profile.test.js tests/l1-online-gap-wire.test.js
→ tests 33 / pass 33 / fail 0

npm test
→ tests 1518 / pass 1512 / fail 0 / todo 6 / skipped 0，EXIT=0
```

（全量数字高于 AGENTS 记录的 1461 基线，因并发 teammates 同批新增测试文件；
本 agent 仅新增 `tests/l1-feedback-profile.test.js`，该文件 12 个用例全绿。）

新测试覆盖：CLI surface、17 任务精确加载、SKIP 文案泛化（online-gap 原文不变）、
独立输出路径、不写冻基线、all-unknown 语义、确定性、端到端 CLI（17/0 SKIP）、
unknown profile exit 2。全部离线；spawn 类测试备份/恢复自己的报告文件，避免跨进程竞争。

### 6.4 仍待完成

1. perTask extended metrics 由真实 runner 行填充（当前 `perTask: []`，全部 unknown）；
2. 冻结 `explore/baselines/l1-feedback.json` 后才能做同构建回归比较；
3. 部署后真实窗口在线复验（同任务 + requestId/capture）；
4. advisory truncation suspect 与 20 次执行上限规则继续沿用，不进入任何判据。

**不 commit / push / deploy。**
