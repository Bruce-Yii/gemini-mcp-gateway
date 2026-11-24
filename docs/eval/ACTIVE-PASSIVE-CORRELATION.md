# 主动评测 ↔ 被动评测：时间戳关联机制

> 目的：把“用户在真实客户端主动提问”与“线上 capture 被动数据”稳定对起来，不靠记忆、不靠手工翻台账。
> 现状：可以人工按时间戳对，但麻烦，容易漏；需要标准化。

---

## 1. 现实链路

```text
用户主动在 Gemini/ChatGPT 提问
  → 用户把反馈发到开发窗口
  → 开发窗口/台账记录：时间、平台、任务、现象
  → 同一时间线上，网关 capture 已有被动数据
  → 两边按时间/平台/任务对齐
```

问题不在“有没有时间戳”，在：

- 主动侧记录格式不统一；
- 被动侧字段不齐；
- 关联靠人眼；
- 对不上时没有“为什么对不上”的记录。

---

## 2. 目标

1. 用户**不需要额外操作**；
2. 开发窗口只做一次轻量记录；
3. 被动 capture 自动带时间/会话/项目；
4. 关联脚本给出 exact/likely/weak/unmatched；
5. 对不上的也保留原因，不硬凑。

---

## 3. 数据模型

### 3.1 主动评测记录 `active-eval.v1`

```json
{
  "activeEvalId": "ae_20261124_...",
  "platform": "gemini",
  "clientMode": "web-non-code",
  "project": "github:owner/repo | unknown",
  "prompt": "用户原话",
  "taskFingerprint": "sha256(prompt + expectedTools)",
  "startedAt": "ISO-8601 UTC",
  "endedAt": "ISO-8601 UTC",
  "expected": {
    "tools": ["..."],
    "outcome": "..."
  },
  "observed": {
    "tools": ["..."],
    "result": "...",
    "error": "..."
  },
  "source": {
    "window": "dev lead window",
    "ledger": "path",
    "messageAt": "ISO-8601"
  }
}
```

### 3.2 被动 capture 关联键

capture 已有/应有：

- `requestId`
- `sessionId`
- `clientPlatform`
- `clientMode`
- `project`
- `startedAt` / `endedAt`
- `toolCalls[]`（name/args/result summary）
- `taskId`（当前缺失，需要补）

### 3.3 关联结果 `active-passive-link.v1`

```json
{
  "activeEvalId": "ae_...",
  "passiveSessionIds": ["..."],
  "requestIds": ["..."],
  "match": "exact | likely | weak | unmatched",
  "method": "taskId | time+platform | fingerprint | manual",
  "confidence": 0.0,
  "timeDeltaMs": 0,
  "reasons": []
}
```

---

## 4. 关联算法（不硬凑）

按优先级：

1. **exact**：同一 `taskId` 或显式 `activeEvalId` 回填；
2. **likely**：时间窗重叠（如 ±10 分钟）+ 平台一致 + 项目一致 + 工具序列指纹相近；
3. **weak**：只有时间接近/平台一致，缺项目或工具指纹；
4. **unmatched**：对不上，写原因（无 capture、时间漂移、平台标签 unknown、用户换了窗口等）。

禁止：

- 只凭“差不多同一时间”硬配；
- 编造 requestId；
- 把 unmatched 算成 pass。

---

## 5. 关联指纹

```text
taskFingerprint = sha256(prompt + normalizedExpectedTools)
toolSeqFingerprint = sha256(tool names + normalized args keys + order)
```

用途：

- 同 prompt 重复出现时区分；
- 主动/被动工具序列对齐；
- 避免只靠时间。

---

## 6. 标准流程

### 开发窗口（主动）

1. 用户发来主动反馈；
2. 开发窗口记录一条 `active-eval.v1`；
3. 时间戳用真实消息时间/当前 UTC；
4. 有 requestId 就写，没有写 unknown；
5. 不补造。

### 网关（被动）

1. capture 自动带时间、session、platform、project；
2. 补 `taskId`（从 active eval 回填或 header）；
3. 不因主动记录而改 capture。

### 关联

1. 跑 `active-passive-link`；
2. 输出 exact/likely/weak/unmatched；
3. likely/weak 需人工确认一次；
4. 确认后写回 `evalMode=active|passive` 标签；
5. 规则从 active 标签生成，应用到被动。

### 优化

1. 主动失败 → 修复；
2. 修复 → 回归测试；
3. 回归 → 被动规则；
4. 被动规则 → 发现同类；
5. 统计被动 vs 主动一致率；
6. 一致率达标后，降低主动频率。

---

## 7. 关键指标

- 关联率：exact/likely/weak/unmatched 比例；
- 时间漂移：主动记录时间 vs capture 时间；
- 误配率：人工复核推翻比例；
- 主动标签覆盖率；
- 被动规则对主动标签的 precision/recall；
- 主动评测成本 / 修复产出；
- 回归逃逸率。

---

## 8. 最低可行实现

1. `active-eval.v1` 记录（先手工/脚本）；
2. capture 增加 `clientMode`、`taskId`；
3. `scripts/link-active-passive.mjs`：读 active 记录 + capture JSON，输出 link；
4. 报告 `docs/eval/active-passive-links-*.json/md`；
5. 不接生产写入；先离线跑。

---

## 9. 为什么这样舒服

- 用户不需要额外操作；
- 开发窗口只写一条结构化记录；
- 被动 capture 自动；
- 时间戳 + 平台 + 项目 + 工具指纹，不靠人眼；
- 对不上有原因，不硬凑；
- 主动标签能反哺被动规则，最终减少主动提问频率。

---

## 10. 2026-11-25 同步：按 PR #28 现行实现校正口径（append-only）

> §3/§4/§8 是 2026-11-24 的设计稿；**现行可执行入口**是 `scripts/record-active-eval.mjs` +
> `scripts/compare-active-passive.mjs`（不是旧称 `link-active-passive.mjs`）。以下以代码为准，
> 代码已合入 `main` `cd23fdc` 但**未部署**，生产仍 `f2002d9`。

### 10.1 `active-eval.v1` 实际字段（取代 §3.1 草稿）

- `platform` / `buildCommit` / `window{from,to}` / `anchors{startAction,endAction,repos,prs,issues,branches,files}` / `prompt`；
- `observed.requestIds[]`（没有就 `unknown`，禁止编造）、`observed.services[]`、`observed.connectFailures[]`；
- **`observed.findings[]`**（PR #28 新增）：主动窗口自报的语义问题
  `{id, title, keywords[]}`；`id`/`title` 非空字符串，`keywords` 可缺失/为空（匹配时用 `title` 兜底）；
  结构非法直接退出码 2，不静默丢弃；
- `activeEvalId = ae_<window日期>_<8位hash>`，哈希包含 `observed`（含 findings）。

### 10.2 `compare-active-passive.mjs` 实际输出（取代 §3.3 草稿的部分字段）

- `match`：`exact | likely | weak | unmatched`；与 §4 的优先级一致，但 **exact 额外要求
  命中的 `requestId` 时间戳落在 active window 内**；跨构建只记 `build mismatch`，禁止硬比。
- `findings`：`{total, detected, missed}`——主动 `observed.findings[]` 的被动命中汇总；
- `missed[]`：包含服务/连接失败覆盖缺口与 **未命中的 finding**（`kind=finding`、
  `reason=passive-not-detected`）；
- `coverage[]`：本版 compare 把 `services`、`connectFailures`、`findings` 三类检查放进同一数组；
- 判定文本：用主动 finding 的 `keywords`（为空时用 `title` 兜底）去匹配被动 issue 的
  `title + likelyCause + suggestedFix`，大小写不敏感子串匹配；任一关键词命中即 `covered=true`
  并记 `passiveIssueId`，全部未命中强制进 `missed[]`；
- 默认退出码：只要 `findings.missed > 0` 就非零（即使 `match=exact`）；`unmatched` /
  `EMPTY_WINDOW` 仍默认非零。`--allow-missed-findings` 只是显式审计例外，**不是通过口径**。
- 命中只表示“被动日志里出现过同义文本”，**不等于问题已修复或已被 analyzer 正确归因**。

### 10.3 `responsePreview` 在关联链中的位置（PR #28）

- `responsePreview` **不参与 compare 的匹配**；它是 analyzer-input 的成功态证据：
  捕获响应体的有界预览（前 500 字符 + 截断标记）+ `topLevelKeys`/`nullKeys`/`arrays`/`nested`
  轮廓，`subCalls[]` 另带 `error{name,message}` / `resultShape`。
- 关联链是：主动 `observed.findings[]` → 被动 analyzer `validated.issues` → compare 的
  `findings{total,detected,missed}`；analyzer 可据 `responsePreview + subCalls` 产出 issue，
  compare 再用 issue 文本核对主动 findings。
- 边界：预览有界，字段不在 preview 里 ≠ 全量 body 不存在；预览不是 exact 判据；
  analyzer 输出仍是 advisory（`AGENTS.md` §1）。

### 10.4 R2 429 与 scorecard 聚合边界（Pack 1 = PR #30，OPEN）

- R2 REST API 是**账户级** 1,200 req / 5 min（[官方 limits](https://developers.cloudflare.com/r2/platform/limits/)）。
  日常短窗（`--last-minutes`）与周报解耦；周报优先聚合已提交 daily scorecard（0 R2 GET），
  只有显式 `from_r2=true` 才回退 7 天 raw + analyzer。
- 429 一律显式失败：解析 `Retry-After`/`Ratelimit`，总等待超 120s 抛 `R2_RATE_LIMITED`；
  **不是** `EMPTY_WINDOW`，不是 `unmatched` 的合法通过理由，也不能据此写“被动无数据”。
- scorecard 缺日 → `NOT_ENOUGH`，不伪造完整；跨构建/跨窗口仍按 `build mismatch` 只记录原因。
- 现状：修复分支真实重跑 last 180m 已从 2 条恢复到 34 条（gemini 17 / chatgpt 10 / unknown 7），
  但 weekly-review 在 R2 GET 上仍 429；PR #28 已合入 main 未部署，Pack 1/Pack 2 未合并，
  同窗重跑与验收待 R2 冷却后执行。

### 10.5 与门禁索引

本批「M4 五门」口径见 [README.md](README.md) §当前门禁入口；五门状态必须按 gate 附证据，
不得把本节的新机制合并成整体 PASS。
