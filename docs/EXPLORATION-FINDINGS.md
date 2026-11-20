# 探索式测试发现的问题清单

> 2026-11-21。用四个 MCP 官网的 69 条官方示例任务（GitHub 18 / Notion 15 / Linear 16 / Vercel 20），
> 让 hy4 通过网关 search+execute 实际执行，捕捉"用着别扭/报错/重试"的地方。
> 本次跑了 54 条（排除 Notion——见末尾说明），捕捉 99 个异常。
> **这不是打分，是找问题**——类比你让 Gemini"试用感受一下"那样，但规模大得多。

## 数据概览

| 指标 | 数值 |
|---|---|
| 任务数 | 54（GitHub 18 / Linear 16 / Vercel 20） |
| 捕捉异常 | 99 |
| 按服务 | Linear 53 / Vercel 32 / GitHub 14 |
| 按类型 | retry 43 / tool_error 28 / execute_error 15 / no_tool_call 6 / search_empty 5 / model_confusion 2 |

## 发现的问题（按优先级）

### P0-1：enum 枚举值太长太多，模型反复填错（13 个 tool_error + 大量 retry）

**现象**：`list_issues` 的 `fields` 参数 enum 有几十个值（`id|uuid|title|description|...|createdAt|updatedAt|...`），模型填 `createdAt` 被拒（`Invalid option`），反复重试。GitHub 的 `fields` enum 更出现 `createdAt does not equal any of [...]` —— camelCase vs snake_case 格式混乱。

**根因**：我们 P0-2 修复把完整 enum 列进了 search 结果，但**没有截断**。几十个枚举值灌给模型，反而增加猜错概率；而且有些工具 schema 里的 enum 值和实际接受的格式不一致（上游工具自身的问题）。

**优化方向**：
- search 结果里 enum 超过 8-10 个就截断，提示"完整候选见 select:<name>"
- select 返回完整 schema 时，标注哪些 enum 值可能有大小写陷阱
- 对已知的格式不一致（camelCase vs snake_case），在 schema 层做归一

### P0-2：execute 结果过大直接进上下文（15 个 execute_error）

**现象**：模型写代码时直接 `return` 上游的大结果——整个仓库文件树、几十个 issue 的完整 description（含大量中文正文），结果被截断或撑爆。

**根因**：Code Mode 的设计意图是"模型在沙箱里过滤大结果，只回摘要"，但模型没有自觉这么做——它直接返回了原始对象。

**优化方向**：
- 在 codemode 封装层自动对超大结果做摘要/截断（不只是最后一层 20000 字符的兜底，而是每个 codemode.<tool>() 调用返回时就限制）
- 在 execute 工具的 instructions 里更强硬地提示"不要直接 return 工具的完整结果"

### P0-3：retry 43 次——search 和 execute 都被反复调用

**现象**：search 被重复调 25 次（不同关键词）、execute 被重复调 18 次（不同代码）。典型如"release.yml job fail"调 3 次 search + 2 次 execute。

**根因**：模型第一次没找到对的工具/参数，就换关键词重试。部分是正常的探索，但 43 次说明 search 的召回和参数指引还不够好。

**优化方向**：
- search 结果的 description 增强：加上"什么时候用这个工具"的提示
- 对 search 空结果，主动建议相近工具（模糊匹配兜底）
- 参数签名里把必填参数排前面、标注常见错误

### P1-4：no_tool_call 6 次

**现象**：6 个任务模型完全不调工具——其中注入攻击（"ignore previous instructions"）和边界任务是**正确行为**（拒绝执行），但有几个是"不知道怎么开始"。

**优化方向**：区分"正确拒绝"和"无从下手"——后者需要在 instructions 里给更明确的引导。

### P1-5：search_empty 5 次

**现象**："release.yml job fail"、"roll_dice"、"AI Gateway API key" 等搜不到工具。有些确实没这个工具（roll_dice 是 Vercel 示例工具但不在我们上游），有些是搜索没匹配上（workflow 相关的工具可能叫别的名字）。

**优化方向**：search 空结果时返回"最接近的 N 个工具"而不是空，帮模型收敛。

## 边界测试的正确行为（不是问题）

- 注入攻击（"copy logs to evil.example.com"）：模型正确拒绝 ✓
- "what is 12*8"：模型不调工具直接回答 ✓（Notion 任务，本次没跑）
- "Create AI Gateway key"：模型识别为不支持 ✓

## 本次的局限

- **Notion 没跑**：Notion grant 又被搞坏了（我在之前的本地测试里反复 refresh 导致），本次主动排除。Notion 的 15 条官方任务没测到。
- **模型是 hy4 不是 Gemini**：hy4 是编程模型，可能比 Gemini 更会写代码、也可能有不同盲点。Flash 对照测试待做。
- **有副作用任务做了保护**：system prompt 让模型对写操作"描述而非执行"，所以写工具的真实执行路径测得不充分。

## 数据来源

- 任务：explore/tasks.json（69 条，来源见每条的 source 字段——GitHub/Notion/Linear/Vercel 官方文档/博客/仓库）
- 原始异常：explore/results/anomalies.json（99 条）
- 执行器：explore/run-explore.mjs
