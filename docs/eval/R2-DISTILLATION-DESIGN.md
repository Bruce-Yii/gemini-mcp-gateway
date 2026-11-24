# R2 真实流量自动蒸馏候选评测题框架设计（R2 Distillation）

> **治理标记**：`[云端总控]` 架构骨架定稿（2026-11-25）。  
> **目标**：把线上所有客户端在真实干活时踩出的高频摩擦，通过**确定性规则漏斗 + 去重脱敏 + 人工转正闸门**自动沉淀为高质量候选精题，让 66 道金标题库拥有持续进化的“活水”，同时**零污染主库、零额外 R2 API 请求**。

---

## 一、硬架构约束（不可违背）

1. **0 额外 R2 API 请求**：蒸馏脚本 **绝对不能** 直接请求 Cloudflare R2 REST API（避免再次触发 1,200 req/5min 账户级 429）。它只消费 `capture-daily.yml` 本轮已经落盘的本地 `digest` / `analyzer-input` / `analyzer-output` JSON 产物。
2. **纯确定性提取（0 LLM 成本）**：阶段 1–3 全部用确定性规则跑完，稳定、可复现、可单测；不让免费模型直接改写正式题库。
3. **强制人工/总控转正闸门**：蒸馏产物只写入 `docs/eval/suites/candidates.json`，永远不能自动写入 `*-gold.json` 或 `INDEX.json`；必须通过 `promote-eval-candidate.mjs` 的 5 条精题硬标准校验后才能转正。
4. **严格脱敏**：复用 PR #28 的 `redactSecrets`（含无引号 `key=value`、token family 与 JSON 引号形态 `"token":"..."`），剥离一切凭据与私有业务正文，只保留工具名、错误形态、参数骨架与 `sampleRequestIds[]`。

---

## 二、四阶段漏斗架构

### 阶段 1：6 类确定性信号触发器（从本轮产物筛选高摩擦轨迹）

| 信号 ID | 触发条件（精确阈值） | 映射失败模式 | 默认严重度权重 |
|---|---|---|---|
| `retry_loop` | 同一 `clientPlatform` + 同一工具（或同 `subCalls[].tool`）在 5 分钟窗内连续调用 `>= 2` 次，且前一次非 200 / 返回空 / 抛错 | `failed_error_recovery` | 3 |
| `search_thrash` | 同一会话/5 分钟窗内连续触发 `search` `>= 4` 次仍未进入 `execute_read`/`execute`（或单任务总 `search >= 5`） | `wrong_tool_selection` | 2 |
| `truncation_reread` | 响应带 `truncated: true` 或 `truncation` 对象，且随后 2 轮内再次读取同一工具/路径 | `response_misparsing` / `constraint_violations` | 3 |
| `semantic_200_gap` | HTTP 200，但 `responsePreview` 出现关键字段 `null`（如 `number: null`、`url: null`、`path: null`）或写入调用返回 `written: 0` / `dryRun: true` | `malformed_parameters` / `response_misparsing` | 4 |
| `slow_or_unexpected` | 单次耗时 `> 8000ms`，或出现非预期 4xx/5xx（**显式白名单排除已知观察项**，如 `OBS-001` ChatGPT `server/discover` 400） | `failed_error_recovery` | 2 |
| `client_divergence` | 同一 `buildCommit` 下同一工具在两个以上 `clientPlatform` 的错误率差值 `>= 25%` 或中位轮次差值 `>= 2` | `constraint_violations` | 5 |

### 阶段 2：确定性指纹去重 & 噪音黑名单

- **指纹公式**：
  `fingerprint = sha256([upstream || 'gateway', toolName, primarySignal, normalizedErrorShape].join('|')).slice(0, 16)`
- **去重规则**：
  1. 若 `fingerprint` 已被标记为 `status: "rejected_noise"`：静默跳过，不再重复生成；
  2. 若 `fingerprint` 已存在于 `docs/eval/suites/candidates.json`：不新建条目，仅更新 `seenCount += 1`、`lastSeenAt`、合并去重 `affectedClients[]` 与 `sampleRequestIds[]`（最多保留最近 10 个），并重算 `priorityScore`；
  3. 若该问题已明确对应正式金标题库中已有 `sourceRefs` / 相同指纹：仍可递增 `seenCount` 作为线上复发计数，但不重复建候选。
- **优先级评分**：
  `priorityScore = severityWeight * Math.log2(seenCount + 1) * (affectedClients.length >= 2 ? 1.5 : 1.0)`（保留 2 位小数）。

### 阶段 3：候选池 Schema（`docs/eval/suites/candidates.json`）

```json
{
  "schema": "gold-eval-candidates.v1",
  "updatedAt": "2026-11-25T00:00:00Z",
  "ignoredFingerprints": [],
  "candidates": [
    {
      "candidateId": "CAND-20261125-a1b2c3d4",
      "fingerprint": "a1b2c3d4e5f67890",
      "status": "pending_review",
      "triggerSignals": ["semantic_200_gap"],
      "upstream": "github",
      "tool": "normalizeMerge",
      "affectedClients": ["gemini"],
      "buildCommits": ["42caaf2b"],
      "seenCount": 3,
      "priorityScore": 8.0,
      "firstSeenAt": "2026-11-24T18:00:00Z",
      "lastSeenAt": "2026-11-24T19:25:00Z",
      "sampleRequestIds": ["03a21275-..."],
      "redactedEvidence": {
        "status": 200,
        "nullKeys": ["number", "url"],
        "durationMs": 420
      },
      "draftTask": {
        "upstream": "github",
        "access": "write",
        "tier": "T2",
        "failureModeTarget": ["response_misparsing"],
        "trap": "待人工精修：HTTP 200 返回关键字段 null（number/url）",
        "userPromptDraft": "",
        "verifiableClaimsDraft": [],
        "efficiencyBaseline": { "maxSearchCalls": 2, "maxExecuteReadCalls": 2, "maxExecuteCalls": 2 }
      },
      "promotedTaskId": null,
      "rejectedReason": null
    }
  ]
}
```

### 阶段 4：人工 / 总控转正闸门（`scripts/promote-eval-candidate.mjs`）

- **转正命令**：
  `node scripts/promote-eval-candidate.mjs --id CAND-... --to docs/eval/suites/adversarial-client-gold.json --task-id AC-ADV-09 --prompt-file work/prompt.txt --claims-file work/claims.json`
  - 硬校验 5 条精题标准（缺任一项返回非零退出码拒绝入库）：
    1. `userPrompt` 非空且长度 `>= 40` 字符，不含明文密钥；
    2. `trap` 非空；
    3. `verifiableClaims` 为数组且至少包含 **3 条**具体二元可判声明；
    4. `referenceSource` 自动回填 `candidateId + sampleRequestIds`；
    5. `efficiencyBaseline` 完整合法。
  - 校验通过后：追加写入目标 `*-gold.json`，同步重生成 `docs/eval/suites/INDEX.json`，并将原候选状态置为 `promoted`（写入 `promotedTaskId`）。
- **忽略噪音命令**：
  `node scripts/promote-eval-candidate.mjs --id CAND-... --reject --reason "OBS-001 已知协议协商"`
  - 将状态置为 `rejected_noise` 并把 `fingerprint` 写入 `ignoredFingerprints[]`。

---

## 三、CI 与工作流接入点

- 在 `.github/workflows/capture-daily.yml` 的 `analyze-captures.mjs` 之后追加一步轻量脚本：
  `node scripts/distill-r2-candidates.mjs --analyzer-input ... --analyzer-output ... --candidates docs/eval/suites/candidates.json --out work/candidates-updated.json`
- 该步骤为纯本地 JSON 计算，**0 网络请求、0 R2 GET**，产出的 `candidates-updated.json` 随 artifact 上传（或由人工/PR 审阅后合入 `docs/eval/suites/candidates.json`，不自动直推 `main`）。
