# 探索式测试（规模化版 Gemini 试用）

## 目的

不是打分（pass@k），而是**像 Gemini 那样"试用、感受"，但规模大得多**——用大量来自四个 MCP 官方的示例任务，自动跑，自动捕捉异常，产出"问题清单"作为优化方向。

## 流程

1. `tasks/` — 四个 MCP 官方示例任务（标注来源 URL）
2. `run-explore.mjs` — 用 hy4 通过网关 search+execute 执行每个任务，捕捉异常
3. `report.mjs` — 把异常归类成问题清单（就像 Gemini 给的那份）

## 捕捉的异常类型（以 `run-explore.mjs` 实际 `flag()` 调用为准）

> 当前代码共发出 11 类 anomaly。`explore/trace.mjs` 的 `classifyRootCause()` 只是给 anomaly
> 附加 `rootCause` 标签（enum/param/schema/permission/JS 错误/result too large/not found/infra/other），
> **不是独立 detector**。归因 `attribution` 取 gateway / model / infra / harness / synthetic_data / expected_behavior。

- `tool_error`：`runToolCall` 抛错（工具调用层失败）
- `execute_error`：execute 结果里的错误文本（isError / ReferenceError / TypeError / 404 / 403 等）；
  fixture 占位符导致的 404 会打 `subtype: placeholder_404` + `attribution: synthetic_data`，不算网关缺陷
- `infra_error`：上游 429 限流 / 5xx 服务端错误（`attribution: infra`）
- `search_empty`：search 返回的 `matches` 为空
- `model_confusion`：模型说 "I cannot" / "not sure" 等；boundary 任务的正确拒绝打 `expected_behavior`
- `token_anomaly`：`finish_reason=length`、`completion_tokens>1500`，或单轮 token 增量 >12000
- `runner_error`：harness 自身异常（`attribution: harness`）
- `max_turns_exceeded`：6 轮内没有产出最终答案
- `direct_answer`：非 boundary 任务零工具调用直接给出长答案
- `retry`：同一工具名、不同参数重复调用（按 name+argsKey 签名统计）
- `no_tool_call`：模型完全没调用工具；boundary 场景下打 `expected_behavior`

**未实现**（旧版 README 列过，别据此高估覆盖率）：`wrong_tool`、`search_irrelevant`、
`result_too_large`、`truncated`、`timeout`、`no_result` 都没有独立 detector；
"result too large" / "timeout" 只在 `rootCause` 正则里作为标签出现，不是 anomaly type。

**已知局限**：`work/full-audit.md` #21–#23 指出探测器存在归因误标（Vercel 404/403 被贴 schema mismatch、
execute 的 detail 抓错、缺 Linear 工具被归到 gateway），原始 anomaly 分布不能直接拿来排优先级。

## 模型

- hy4（OpenCode Go，主）：大规模自动跑
- 反重力 flash（对照）：跑一部分，对比不同模型的坑
