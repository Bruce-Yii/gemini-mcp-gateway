# 硬闭环实测记录：T0 窗口真实免费模型三轮对照（2026-11-25）

> **目的**：验证「治本包 1」的硬门禁不是纸面规则——在真实免费模型下跑一次完整闭环，
> 检查 `activeEvalId=ae_20261124_30c393b5`（ChatGPT T0，窗口 `2026-11-24T23:31:38Z–23:36:09Z`）
> 的 4 条 `passive-observable` findings 是否真被检出，漏检则反哺提示词并重跑。

环境事实（必须如实记录）：

- 本机没有 `ANALYZER_BASE_URL` / `ANALYZER_API_KEY`，真实模型调用只能在 CI 的 secrets 环境执行。
- 因此三轮的**模型调用**都在 CI（`capture-daily.yml`，`--ref feat/eval-hard-closure-gate`，`last_minutes=240`）完成；
  同窗 `compare` 与 `distill` 在本地用下载下来的 `analyzer-output` 执行。链路等价，但不是单进程串联。
- 单入口 `run-active-closure.mjs` 的全链编排由单测 + 本地假模型端点做过端到端验证（见 `tests/eval-hard-closure.test.js`），
  其真实模型分支与 CI 使用的是同一份 `analyze-captures.mjs` 代码路径。

## 1. CI 硬门禁自证（红灯有效）

第 2 轮把提示词加长后，免费模型返回的 JSON 被 `max_tokens` 截断，解析失败：

```text
run 45536356159  conclusion=failure
analyzerRun={"llmExecuted":false,"model":null,"skippedReason":"parse_failed",...}
::error::free model did not execute (llmExecuted != true, skippedReason=parse_failed).
```

这正是门禁要拦的情况：**模型没跑成 → workflow 直接红**，不再因为“artifact 存在”而假绿。
（修复：压缩提示词 + `max_tokens` 7000 + issue 上限 6。）

## 2. 三轮对照

| 轮次 | run | 模型证据 | issues | 检出 | missed | 说明 |
|---|---|---|---|---|---|---|
| 基线（未反哺） | [45535836473](https://github.com/Bruce-Yii/gemini-mcp-gateway/actions/runs/45535836473) | `llmExecuted=true model=hy4-flash-free` | 5 | 0 | 4 | 模型只报泛化的 unwrap/解析冗余 |
| 第 1 次反哺（friction-token 提示词 + 放宽 issue 上限） | [45536759513](https://github.com/Bruce-Yii/gemini-mcp-gateway/actions/runs/45536759513) | `llmExecuted=true` | 6 | 0 | 4 | 模型报出 “Search-heavy thrash”，但 active-eval 关键词写的是 `16 次 search`，字面不匹配 |
| 第 2 次反哺（要求预留 issue 槽位 + 修正关键词/标签） | [45537374261](https://github.com/Bruce-Yii/gemini-mcp-gateway/actions/runs/45537374261) | `llmExecuted=true` | 6 | **1** | 2 | `F-t0-search-overuse` 命中（`search-heavy`）；`output-truncation` 改判 active-only |

最终状态：`closureStatus=CLOSED`、`llmExecuted=true`、`match=likely`、`detected=1 / missed=2 / activeOnly=3`。

## 3. 两条残留 missed 的定性（不粉饰）

### 3.1 `F-t0-gh-search-incomplete` —— 模型容量漏检（可继续改进）

- 证据确实在输入里：`analyzer-input` 含 `incomplete_results`、`search_code` 字面量。
- 模型在该轮 6 个 issue 槽位里没有覆盖它，仍被泛化的 unwrap/解析类问题占位。
- 结论：**提示词优先级不足，不是数据缺失**。下一步应把 (a) 类信号做成强制首条输出，或对
  `incomplete_results` 做确定性预扫描直接生成候选（不依赖模型自觉）。

### 3.2 `F-t0-notion-business-gate` —— NOT_ENOUGH（证据不在同窗捕获里）

- `Business-plan options were omitted` 字符串在 `analyzer-input` 中 **不存在**；只有
  `edited_by_user_ids` 出现过。
- 说明该 Notion 调用的响应体没有被这批 sampled capture 收录（采样/窗口边界），
  模型无从判断。
- 结论：`NOT_ENOUGH`，不是因为模型漏检，也不据此改提示词。

### 3.3 一处标签修正（我自己之前标错）

`F-t0-output-truncation` 原标 `passive-observable`，但“客户端展示层截断”在网关 capture 里
没有对应字段（`TRUNCATED` / `readFileRange` 在输入中均不存在）。已改判 `active-only`，不计入漏检门禁。
修正后的记录：`docs/eval/active-eval-2026-11-24-chatgpt-t0-corrected.json`（原始记录不改写）。

## 4. 复现命令

```bash
# 模型在 CI（有 secrets）：
gh workflow run capture-daily.yml --ref feat/eval-hard-closure-gate \
  -f last_minutes=240 -f run_weekly=false -f from_r2=false
gh run download <run-id> -n capture-digest -D work/run-real-llm

# 本地同窗对照（硬校验 llmExecuted）：
node scripts/compare-active-passive.mjs \
  --active docs/eval/active-eval-2026-11-24-chatgpt-t0-corrected.json \
  --passive work/run-real-llm/analyzer/analyzer-output-*.json \
  --out work/active-passive-t0-real.json --json
```

有 `ANALYZER_*` 的环境可一条命令跑完全链：

```bash
node scripts/run-active-closure.mjs \
  --active-input docs/eval/inputs/active-chatgpt-t0-2026-11-24.input.json \
  --raw docs/eval/active-eval-2026-11-24-chatgpt-t0.json.raw.txt \
  --since 2026-11-24T23:31:00Z --until 2026-11-24T23:37:00Z \
  --store work/capture-store --out-dir work/closure
```

## 5. 对治本包 1 结论的影响

- 门禁有效：`llmExecuted` 三态、`INVALID_NO_LLM` 硬拒、CI 红灯都在真实运行中被触发过（含一次真实红灯）。
- 反哺有效但未清零：4 条 → 1 条命中、1 条容量漏检、1 条 NOT_ENOUGH、1 条标签修正。
- 不更新 baseline，不宣称“漏检清零”。
