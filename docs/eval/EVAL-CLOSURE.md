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
node scripts/record-active-eval.mjs --input work/active.json --raw work/active-2026-11-24.txt \
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
| `observed.requestIds[]` | UUID 或 `unknown`；**不编造**；建议用 `--capture-index` 验证 id 真在 capture 中 |
| `observed.services[]` | 可选：`{name, status, needsReauth}`，用于和被动 `serviceState` 对照 |
| `observed.connectFailures[]` | 可选：连不上的上游名，用于和被动 `connectFailures` 对照 |
| `observed.findings[]` | 可选：主动窗口自己报出的语义问题 `{id, title, keywords}`。`id`/`title` 非空字符串；`keywords` 是字符串数组（可缺失/为空，匹配时用 `title` 兜底）；结构非法直接退出 2 |

`activeEvalId` 由规范化内容哈希派生（`ae_<window日期>_<8位hash>`），同输入同 id，不随机；哈希包含 observed，两次不同观测不会撞 id。
`--raw` 的逐字文本会写到 `<out>.raw.txt` 并记录 `source.rawTextSha256/rawBytes`；缺原文直接退出 2，防止“摘要当原文”。

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

`EMPTY_WINDOW` **不是通过**，是“过滤窗口内没有数据”，必须写 `NOT_ENOUGH`。workflow 对 `workflow_dispatch` 的空窗口直接失败，scheduled 只告警；analyzer 遇到空窗口不调用模型。

### 2.1 analyzer-input 成功态字段（PR #28，main `cd23fdc`，未部署）

`analyzer-input` 的 `samples[]` 现在额外携带（让被动分析也能看见 HTTP-200 成功态语义摩擦）：

- `responsePreview`：成功响应体的**有界预览**（前 500 字符，带显式截断标记）+ 解析轮廓
  `topLevelKeys` / `keyCount` / `nullKeys` / `arrays` / `nested`（只暴露键名/计数，不暴露值）；
- `subCalls[]` 的 `error`（只保留 `name`/`message`，截断且做 secret 形态脱敏）与 `resultShape`。

用途：识别 `number:null`、双层嵌套（`result.content[0].text` 内再包 JSON）、误报截断、跨上游重复解包/格式化等
“HTTP 200 但语义有摩擦”的问题。边界：

- `responsePreview` 有界；**字段不在 preview 里 ≠ 全量 body 里不存在**，不能据此过度断言；
- analyzer-output.v1 的 issue 新增可选 `clientPlatform` / `servers[]` 归因；缺失时保留 issue（不因归因未知丢弃），
  归因只是模型推断，仍按 `AGENTS.md` §1 当 advisory；
- 预览与 subCall 错误都走 secret 形态脱敏，但 capture 本身仍是 full-fidelity（不得反推“已脱敏采集”）。

### 2.2 R2 约束与周报 scorecard 聚合边界（Pack 1 = PR #30，OPEN）

- R2 REST API 是**账户级** 1,200 req / 5 min（[官方 limits](https://developers.cloudflare.com/r2/platform/limits/)）。
  日常短窗（`--last-minutes 60`）与周报必须解耦；周报不再每次手动 dispatch 都重扫 7 天 raw envelope。
- 现状证据：修复分支真实重跑 last 180m，请求数从 2 恢复 **34 条**（gemini 17 / chatgpt 10 / unknown 7）；
  同 run 的 weekly-review 在 R2 GET 上仍 429，run conclusion=failure——digest/analyzer 已产出，**数据未丢**，
  属外部限流，需冷却后重跑。
- 代码态（Pack 1，**PR #30 OPEN，未合并**）：weekly 默认读已提交 `docs/eval/scorecard-YYYY-MM-DD.json`
  （0 R2 GET）；只有 `from_r2=true` 才显式回退旧 7 天 raw + analyzer；429 优先解析 `Retry-After` / `Ratelimit`，
  总等待超 120s 抛显式 `R2_RATE_LIMITED`。
- 边界：缺 scorecard 的日期在 weekly 里显式 `NOT_ENOUGH`，不伪造完整；429 **不是** `EMPTY_WINDOW`，
  不能记 pass/空报告；同窗对照必须等 R2 冷却后重跑，不能拿“run failure”当数据缺失结论。

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
| `exact` | 主动 `requestId` 在被动窗口里命中，**且该 id 的时间戳在 active window 内**、build/platform 不冲突；`window` 不匹配时绝不 exact |
| `likely` | 时间窗 + 平台 + build 对齐，但无“在窗内时间戳已验证”的 requestId |
| `weak` | 只有时间窗 + 平台对齐 |
| `unmatched` | 空窗口 / build 不匹配 / 无重叠 |

compare 默认把 `unmatched` / `EMPTY_WINDOW` 视为非零退出；只有显式 `--allow-unmatched` 才允许绿色。

输入除 analyzer artifact 外，可用 `--request-index <analyzer-input.json>` 提供**全量** requestId 索引（不受 15/5 采样上限影响）。

输出同时包含：

- `checks`（build/platform/window/requestIds）；
- `coverage[]`：`observed.services` 和 `observed.connectFailures` 是否在被动
  `serviceState`/`connectFailures` 里可见；
- `findings`：`{total, detected, missed}`，主动 `observed.findings[]` 的被动命中汇总；
- `missed[]`：漏抓项 + 原因（如 `no-services-snapshot`、`no-connect-failure-or-offline-snapshot`、`passive-not-detected`）；
- 跨构建时明确 `build mismatch`，禁止硬比。

### 3.1 `observed.findings` 匹配规则（防止 `missed: []` 假绿）

对主动窗口每条 `observed.findings` 逐条检查被动侧是否看到：

| 项 | 规则 |
|---|---|
| 被动来源 | analyzer-output 包装的 `validated.issues`，或裸 `passive.issues` |
| 匹配文本 | 每条被动 issue 的 `title + likelyCause + suggestedFix`，大小写不敏感子串匹配 |
| 关键词 | `keywords` 任一命中即 `covered=true`，并记 `passiveIssueId`；`keywords` 为空时用 `title` 兜底 |
| 未命中 | `covered=false`、`reason=passive-not-detected`，强制进 `missed[]`（`kind=finding`） |

`keywords` 要选能定位该问题的短语：过窄会漏配（保守地判为未命中），过泛（如 `unknown`）会把无关 issue 当成已覆盖；
命中只表示“被动日志里出现过同义文本”，不等于问题已被修复或已被 analyzer 正确归因。

默认退出码：只要存在未命中的 finding 就非零退出（即使 `match=exact`）——主动报了 3 个语义问题、
被动 `validated.issues` 0 命中时，`missed: []` 不再可能出现。只有显式 `--allow-missed-findings`
才放过；原有 `unmatched` / `EMPTY_WINDOW` 非零逻辑不变，active 无 findings 时行为不变。

## 4. Badcase 与反哺

1. `missed` 或用户观察到的真问题 → 按 `客户端 × 上游 × 类别` 写进 BADCASES，
   带 `activeEvalId`/requestId/build 与回归任务；提交前跑
   `node scripts/check-badcases.mjs --strict`（旧条目 `—` 只告警，新条目必须填）；
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
- **R2 429 是外部限流，不是空窗口**：冷却前重跑可能仍 429；`R2_RATE_LIMITED`（Pack 1）与
  “run failure 但 digest 已产出”都必须显式记录，不能写成 `EMPTY_WINDOW` 或数据丢失。
- **代码态 ≠ 生产态**：PR #28 的五根因修复已合入 `main` `cd23fdc`，但生产仍 `f2002d9`；
  `responsePreview`/`observed.findings` 等结论在部署或冷却后重跑前都只能写“代码已合入/未验收”。
- **scorecard 聚合是周报的默认输入**（Pack 1 = PR #30，OPEN）：daily scorecard 缺日 → `NOT_ENOUGH`；
  不得用周报聚合倒推单窗口 exact/likely 结论。
