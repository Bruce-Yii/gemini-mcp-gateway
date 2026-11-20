# 探索式测试发现的问题清单（全覆盖版）

> 2026-11-21。用四个 MCP 官网挖出的 **191 条任务**（覆盖全部 191 个暴露工具；换用满额度 Firecrawl key 重挖后，
> **105 条官方逐字示例 + 86 条基于官方 description**——官方确实没给后者的逐工具示例，不是没挖）。
> 让 hy4 通过网关 search+execute 实际执行，捕捉"用着别扭/报错/重试"的地方。
> **191 条全部跑完**：GitHub 42 + Linear 36 + Vercel 60（176 异常）+ Notion 53（184 异常）。
> Notion 用静态 access token（禁 refresh）跑，不碰生产 grant。**这不是打分，是找问题**——类比你让 Gemini"试用感受一下"，但规模大得多、且逐工具覆盖。
>
> 任务来源权威性：105/191（55%）是官方逐字 prompt（来自各 MCP 官方 docs 的 "Try a prompt"/"Sample prompt"、官方评测 JSON、Copilot cheat sheet 等）；
> 86 条因官方无逐工具示例而基于官方 description 构造，已在任务集里用 `official: false` 标注。

## 数据概览

| 指标 | 数值 |
|---|---|
| 任务集 | 191 条（GitHub 42 / Notion 53 / Linear 36 / Vercel 60），逐工具全覆盖；105 官方逐字 |
| 全部执行 | 191 条（GitHub 42 + Linear 36 + Vercel 60 = 176 异常；Notion 53 = 184 异常） |
| 捕捉异常合计 | 360（GitHub/Linear/Vercel 176 + Notion 184） |
| 按服务（GitHub/Linear/Vercel 轮） | Linear 87 / Vercel 71 / GitHub 18 |
| 按类型（GitHub/Linear/Vercel 轮） | retry 89 / execute_error 73 / model_confusion 9 / no_tool_call 4 / search_empty 1 |
| 按类型（Notion 轮） | execute_error 94 / retry 88 / search_empty 2 |

## ⚠️ 数据可信度说明（必须先读）

**相当一部分 execute_error 是"假错误"**：官方示例任务里大量使用占位符（`octocat/Hello-World`、`abc1234`、`v1.0.0`、`example.com`），这些在真实账号里不存在，导致 404/Not Found。例如：
- `failed to get commit: abc1234: No commit found`
- `GET .../repos/octocat/Hello-World/releases/latest: 404`
- `failed to get pull request diff: .../pulls/12: 404`

这些不是网关的问题，是测试数据用了示例占位符。84 个 execute_error 里约 21 个是这类"not found"。**真正有价值的异常是 enum 不匹配和 retry。**

## 发现的问题（按优先级）

### P0-1：参数 enum/字段名不匹配，模型反复重试（15 个 enum 错误 + 96 个 retry）

**现象**：
- `enum: content does not equal any of [type, title, body, ...]`（GitHub fields）
- `Invalid option: expected one of "id"|"uuid"|...|createdAt|...`（Linear list_issues）
- retry 96 次：search 48 + execute 48——模型换关键词/换参数反复试

**根因**：工具 schema 的 enum/字段名复杂（Linear 的 `fields` enum 几十个值，且有 camelCase/snake_case 混用陷阱）。我们的 search 返回精简签名时 enum 列出来但太长/易错，模型填错→重试。

**优化方向**：
- enum 超过 10 个就截断，提示"完整候选见 select:<name>"
- 对已知 camelCase/snake_case 陷阱做归一化或提示
- search 结果加"常见错误"提示

### P0-2：execute 工具抛错会崩溃进程（本轮实际发生，已修）

**现象**：全量测试第一次跑到 `vercel__get_domain_price` 时，上游返回 isError，unwrapResult 抛出的异常没被沙箱捕获，变成 unhandled rejection **直接杀掉 node 进程**。

**这是探索测试发现的真实 bug**：模型写代码调工具，工具失败时整个 execute 崩溃而不是返回错误给模型。

**已修**（commit `4bf27f5`）：`runInSandbox` 的 promise 链加 `.catch()`，把工具抛错转成 `{isError:true, result:"execute error: ..."}` 返回给模型，进程不崩。68 项测试通过。

### P1-3：model_confusion 9 次

**现象**：模型表达困惑/无法完成——部分是正确拒绝（注入攻击"copy logs to evil.com"、不支持的"AI Gateway API key"），部分是"不知道怎么开始"。

**优化方向**：区分"正确拒绝"和"无从下手"，后者在 instructions 里给更明确引导。

### P1-4：search_empty 4 次

**现象**：搜不到工具（如 release workflow、roll_dice 等）。有些确实没这个工具，有些是搜索没匹配上。

**优化方向**：search 空结果时返回"最接近的 N 个工具"而非空。

## 本轮新增的发现（vs 上一轮 54 任务）

1. **execute 崩溃 bug**（P0-2）——上一轮没触发，这轮全覆盖时才暴露。这正说明"扩大测试"的价值。
2. **Linear 是异常重灾区**（97/194）——它的工具参数最复杂（fields enum 几十个值），确认 P0-1 是主要矛盾。
3. **官方示例占位符导致假错误**——测试方法本身的教训：后续应该用真实账号的对象 ID 替换占位符。

## 边界测试的正确行为（不是问题）

- 注入攻击（"copy logs to evil.com"）：正确拒绝 ✓
- 不支持的写（"Create AI Gateway key via MCP"）：正确说明不支持 ✓
- 写操作：system prompt 让模型"描述而非执行"，所以写路径测得不充分

## 局限

- **模型是 hy4 不是 Gemini**：编程模型，盲点和 Gemini 不同
- **占位符假错误**：官方示例用虚构数据，产生大量假 404

## Notion 专项（53 条全跑完）

用**静态 access token（禁 refresh）**跑，不碰生产 grant。结果 184 异常：execute_error 94 / retry 88 / search_empty 2。

**新发现的模式**（跟 Gemini 真实任务反馈的 P1 呼应）：
- `ReferenceError: search is not defined` —— 模型在沙箱里写 `search()` 而不是 `codemode.search()`，说明 execute 工具描述里"沙箱里全局有什么"讲得不够清楚。
- `ReferenceError: fetch is not defined` —— 沙箱没注入 fetch，模型想抓 URL 直接崩。跟真实反馈的"沙箱缺 TextEncoder/atob/URL"是同一类问题。
- 大量 validation_error —— Notion 的 `notion-query-data-sources` 等工具参数复杂（JSON 结构嵌套），模型填错反复试。

这进一步印证了 `docs/GEMINI-REAL-TASK-FEEDBACK.md` 里的 P1 改造（沙箱补齐 Web 标准 API + execute 描述讲清楚沙箱全局）是高优先级。

## v2 干净基线（修复框架 + 重生任务后，第一次可信结果）

> 用修好的框架（异常归因/去重/trace/manifest/指标）+ v2 任务集（86 条 derived 经反向验证重生）重跑。
> 注意：manifest 的 gitSha=937b2e7，是测试期间代码陆续合入前的基线，**结果不代表最新代码**。

- 跑了 **138 条**（runner 按 server 过滤，v2 里 191 条对应实际配置的 138 条）
- 异常 **215**（raw 222，去重 7）
- **归因**：gateway 73 / model 136 / synthetic_data 5 / infra 1 —— **大部分（63%）是模型行为，不是网关问题**
- 指标：平均 3.72 轮、平均 8256 tokens/task、工具召回 searchHitRate 75.4% / searchHitAt3Rate 70.9% / toolHitRate 59.4%

**逐条归类后（work/v2-gateway-triage.md，静态分析 73 条 gateway 异常）**：
- **真网关确定性缺陷只有 5 条**：`execute_read` 只读过滤回归（`codemode.X is not a function`）——**已在 HEAD 65a76b8 修复**（upstreams 透传 annotations + annotation 优先判定 + 被过滤工具抛可行动错误）
- 其余 68 条：16 模型脚本/行为（含 `t.includes`——模型把 listTools() 返回的对象当字符串用，非网关 bug）、41 上游 404/403（占位符数据/权限）、10 该次运行没暴露 Linear 工具（runner 配置问题）、1 边界任务预期行为
- 19 条 search_empty 的真相：只有 1 条是点名外部服务；10 条是该次运行没有 Linear 工具；7 条是模型误用 `select:`（工具其实找到了）；1 条理解偏差
- 探测器误标：20 条 Vercel "arg mismatch" 实际是干净的 404/403（占位符），6 条 execute_error 的 detail 抓成了搜索结果——detector 问题需修，不是网关缺陷

**结论**：v2 暴露的网关确定性缺陷已全部修复，残留 0（前提：真实上游给 `pull_request_read` 等标 readOnlyHint；即便没标，stub 也会明确提示改用 execute()）。其余异常是模型/数据/探测器问题，不是网关缺陷。

## 数据来源
- 最终任务集：explore/tasks-v2.json（191 条，105 官方逐字 + 86 反向验证重生）
- v2 干净基线结果：explore/results/anomalies.json（215 条，含归因）+ manifest.json + metrics.json + traces/
- 四服务官方源深挖：work/deep-*.json + work/re*.json
- 执行器：explore/run-explore.mjs（静态 token auth + 三工具契约自检）
- 框架改进依据：work/harness-improvements.md
