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

## MCPMark 金标（`golden-mcpmark.mjs`）

背景调研见 `work/authoritative-sources.md`。MCPMark（eval-sys，Apache-2.0）是权威 MCP 任务源，本地克隆在
`work/mcpmark`（被 gitignore，缺失时需人工从 `https://github.com/eval-sys/mcpmark` 重新克隆；**本工具永不连上游，不会自动拉取**）。

**能做什么 / 不能做什么（先读结论，别高估）：**

| 能力 | 结论 |
|---|---|
| 拿 `description.md` 当权威 prompt 来源 | ✅ 可以。MCPMark 文档明确「`description.md` 全文会被喂给模型」，是纯用户口吻指令，可替换/补充 derived 任务 |
| 跑 `verify.py` 给我方任务自动打分（pass/fail 金标） | ❌ **不可以**。verify.py 是终态检查，直接调 `api.github.com` / `notion_client`，靠 `MCP_GITHUB_TOKEN` / `GITHUB_EVAL_ORG` 指向 MCPMark 自建的**临时 eval org / eval hub**，检查被预置的仓库（如 issue #49/#51、特定分支/文件）和页面（特定 block 结构）。我们的账号没有这套预置环境，也不连上游，所以 verifier 跑不通。硬跑只会得到全 fail 的假金标 |
| 工具名一一对应 | ❌ 权威 benchmark 钉住 GitHub MCP `v0.15.0` / Notion MCP `@1.9.1`；新增/特有工具（如 `sub_issue_write`、`notion-update-sidebar-tabs`）无同名任务。可移植的是 prompt（用户意图），不是工具调用标签 |

**`golden-mcpmark.mjs` 纯本地做三件事（不调模型、不连上游、不写文件、不执行 Python）：**

1. **盘点**：扫描 `work/mcpmark/tasks/{github,notion}/{standard,easy}/*/*/`，读三件套，导出 `description.md` 原文作为权威 prompt。实测 71 条（GitHub 33 = 23 standard + 10 easy；Notion 38 = 28 standard + 10 easy）。
2. **判定**：静态读 `verify.py` 源码 + `meta.json` 的固定环境 URL，给出 `runnableAgainstOurAccount:false / goldScoringAvailable:false` 与证据，**不尝试运行 verifier**。
3. **映射**：把 `tasks-final.json` 的 86 条 derived 任务映射到 MCPMark 权威 prompt 候选——GitHub 19 + Notion 5 共 24 条有同服务话题级候选（标 `matchKind:'topic-only'`，非逐工具 gold，特有工具另附等价性警告）；Linear 16 + Vercel 46 共 62 条权威源 0 覆盖，如实标 `no_authoritative_source`，不编造。

用法：`node explore/golden-mcpmark.mjs`（stdout 打印 JSON 报告）；单测 `node --test tests/golden-mcpmark.test.js`。
导出的纯函数（`discoverAuthoritativeTasks` / `classifyVerifier` / `loadDerivedTasks` /
`mapDerivedToAuthoritative` / `buildGoldenReport`）可供其它脚本复用。报告无时间戳，结果确定可复现。
