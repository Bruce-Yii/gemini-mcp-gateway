# 探索式测试发现的问题清单（全覆盖版）

> 2026-11-21。用四个 MCP 官网挖出的 **191 条任务**（覆盖全部 191 个暴露工具；换用满额度 Firecrawl key 重挖后，
> **105 条官方逐字示例 + 86 条基于官方 description**——官方确实没给后者的逐工具示例，不是没挖）。
> 让 hy4 通过网关 search+execute 实际执行，捕捉"用着别扭/报错/重试"的地方。
> 跑了 138 条（GitHub 42 + Linear 36 + Vercel 60；Notion 53 条因 grant 坏了排除）。
> 捕捉 176 个异常。**这不是打分，是找问题**——类比你让 Gemini"试用感受一下"，但规模大得多、且逐工具覆盖。
>
> 任务来源权威性：105/191（55%）是官方逐字 prompt（来自各 MCP 官方 docs 的 "Try a prompt"/"Sample prompt"、官方评测 JSON、Copilot cheat sheet 等）；
> 86 条因官方无逐工具示例而基于官方 description 构造，已在任务集里用 `official: false` 标注。

## 数据概览

| 指标 | 数值 |
|---|---|
| 任务集 | 191 条（GitHub 42 / Notion 53 / Linear 36 / Vercel 60），逐工具全覆盖；105 官方逐字 |
| 本轮执行 | 138 条（排除 Notion） |
| 捕捉异常 | 176 |
| 按服务 | Linear 87 / Vercel 71 / GitHub 18 |
| 按类型 | retry 89 / execute_error 73 / model_confusion 9 / no_tool_call 4 / search_empty 1 |

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

- **Notion 53 条没跑**：grant 坏了（我本地测试反复 refresh 抢 grant 导致），需重新授权
- **模型是 hy4 不是 Gemini**：编程模型，盲点和 Gemini 不同
- **大部分任务是 description 推导**（132/191）：Firecrawl 额度耗尽，挖不到更多逐字官方示例
- **占位符假错误**：官方示例用虚构数据，产生大量假 404

## 数据来源
- 任务集：explore/tasks-deep.json（191 条，逐工具覆盖，来源见每条 source）
- 官方源深挖：work/deep-{github,notion,linear,vercel}.json
- 原始异常：explore/results/anomalies.json（194 条）
- 执行器：explore/run-explore.mjs
