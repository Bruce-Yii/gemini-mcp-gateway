# EVAL-CLOSURE — 主动评测触发探针与 4/5 环执行层（2026-11-24）

> 目的：把 `AGENTS.md` §3.1 的「主动反馈 → 同窗被动 → Badcase → 复现 → 反哺」从人肉约定
> 变成可执行、可校验的 4 件工具。设计口径以 [EVALUATION.md §9](../EVALUATION.md#L153) 五环为准；
> N/J/FB 碎片编号已下线，新问题统一进 [BADCASES.md](BADCASES.md)。
>
> 四个工具：`record-active-eval.mjs` / `capture-daily` 手动快拉 / `compare-active-passive.mjs`
> / `check-status-drift.mjs`。全部离线、确定性、不打印 token；模型输出仍只是 advisory。

## 1. 主动记录 `active-eval.v1`

真实窗口结束后，按 `AGENTS.md` §3.1 第 1 步把**原文**与锚点写成 JSON，再校验落盘：

```bash
node scripts/record-active-eval.mjs --input work/active.json \
  --out docs/eval/active-eval-2026-11-24.json
# 确定性测试/固定时间：
node scripts/record-active-eval.mjs --input work/active.json --now 2026-11-24T06:20:00.000Z --json
```

必填字段（缺一即退出码 2，不产出半截记录）：

| 字段 | 规则 |
|---|---|
| `platform` | `gemini \| chatgpt \| claude \| unknown` |
| `buildCommit` | 7–40 位 git hash，或 `unknown` |
| `window.from/to` | ISO-8601；`to >= from` |
| `anchors.startAction/endAction` | 必填；不知道就写 `unknown`（对应 #20 动作范围锚点） |
| `prompt` | 原文，非空 |
| `observed.requestIds[]` | UUID 或 `unknown`；**不编造** |
| `observed.services[]` | 可选：`{name, status, needsReauth}`，用于和被动 `serviceState` 对照 |
| `observed.connectFailures[]` | 可选：连不上的上游名，用于和被动 `connectFailures` 对照 |

`activeEvalId` 由规范化内容哈希派生（`ae_<window日期>_<8位hash>`），同输入同 id，不随机。
落盘 JSON 是后续 compare/回归/STATUS 的唯一主动侧锚点。

## 2. 同窗被动（R2 / 免费模型）

本地有 R2 凭据：

```bash
node scripts/analyze-captures.mjs --last-minutes 60 --commit <build> \
  --platform gemini --eval-mode active --dry-run --out work/analyzer
```

本地没有 R2/ANALYZER 凭据（当前开发窗口常态）：走既有 workflow（#21）：

```bash
gh workflow run capture-daily.yml -f last_minutes=60 -f commit=<build>
gh run list --workflow=capture-daily.yml --limit 1
gh run download <run-id> -n capture-digest -D work/run-<run-id>
```

拿到的 `work/run-<id>/analyzer/analyzer-output-*.json` 里：
- `validated.dataStatus`：`HAS_DATA` / `EMPTY_WINDOW`；
- `input.connectFailures`：`upstream_connect{ok:false}` 的确定性聚合；
- `input.serviceState`：`codemode.services()` 的 offline/stale/needsReauth 快照。

`EMPTY_WINDOW` **不是通过**，是“过滤窗口内没有数据”，必须写 `NOT_ENOUGH`。

## 3. 主动 ↔ 被动对照

```bash
node scripts/compare-active-passive.mjs \
  --active docs/eval/active-eval-2026-11-24.json \
  --passive work/run-<run-id>/analyzer/analyzer-output-2026-11-24-last-60m-commit-<build>.json \
  --out docs/eval/active-passive-2026-11-24.json --json
```

判定（不硬凑）：

| match | 条件 |
|---|---|
| `exact` | 主动 `requestId` 在被动窗口里命中（且 build/platform 不冲突） |
| `likely` | 时间窗 + 平台 + build 对齐，但无显式 requestId 命中 |
| `weak` | 只有时间窗 + 平台对齐 |
| `unmatched` | 空窗口 / build 不匹配 / 无重叠 |

输出同时包含：

- `checks`（build/platform/window/requestIds）；
- `coverage[]`：`observed.services` 和 `observed.connectFailures` 是否在被动
  `serviceState`/`connectFailures` 里可见；
- `missed[]`：漏抓项 + 原因（如 `no-services-snapshot`、`no-connect-failure-or-offline-snapshot`）；
- 跨构建时明确 `build mismatch`，禁止硬比。

## 4. Badcase 与反哺

1. `missed` 或用户观察到的真问题 → 按 `客户端 × 上游 × 类别` 写进 BADCASES，
   带 `activeEvalId`/requestId/build 与回归任务；
2. 被动不可见的项 → 补采集字段或 analyzer 提示词（例如 `services`/`connectFailures`
   已在本批补入 digest/analyzer input），加确定性测试；
3. **同窗重跑** compare：修复前 `missed=N` → 修复后 `missed=0` 才算反哺生效；
4. 仍无法对齐 → 写 `NOT_ENOUGH` + 原因，不进 baseline。

## 5. 状态漂移（buildCommit 口径）

部署/合并后：

```bash
node scripts/check-status-drift.mjs --json
node scripts/check-status-drift.mjs --expected <deployed-commit>
```

规则：`docs/DEPLOYMENTS.md` 最新 READY 行是唯一事实源；`AGENTS.md`（生产已部署/当前生产）、
`docs/STATUS.md`（生产部署行）里出现的生产 commit 必须与它一致（7+ 位前缀比较）。
不一致 → 退出码 1，列出 stale 引用。**目前不做 CI 门禁**，先作为人工/云端总控的检查命令；
等状态统一后再接 CI。

## 6. 边界

- 本套工具不调用模型、不联网（除 workflow_dispatch 那条命令由 gh 发起）；不写 R2。
- `active-eval.v1` 只记录“人看到什么 + 原文”，不把模型/分析器输出写成事实。
- `EMPTY_WINDOW`、`unknown`、`unmatched` 都是合法结果，**不是 pass**。
- 不跨构建硬比；不同构建的 `build` check 必须是 `mismatch`，只记录原因。
