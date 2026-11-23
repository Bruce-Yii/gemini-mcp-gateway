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
