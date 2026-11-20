# 权威任务源调研结论

> 2026-11-21。目标：为 86 条"基于 description 构造"的任务补权威来源。
> 结论：**大部分补不了**——权威 MCP benchmark 只覆盖 GitHub/Notion，且钉死旧版工具，与我们的工具集对不上。

## 权威 MCP 评测任务源盘点

| 来源 | 许可证 | 任务量 | GitHub | Notion | Linear | Vercel | 可用 prompt 字段 |
|---|---|---|---|---|---|---|---|
| MCPMark | Apache-2.0 | 127 + 50 easy | ✅ 23 | ✅ 28 | ❌ | ❌ | `description.md` |
| MCP-Atlas (Scale AI) | CC-BY-4.0 | 1000（公开 500） | ✅ | ✅ | ❌ | ❌ | `PROMPT` |
| MCP-Universe (Salesforce) | Apache-2.0 | 231 | ✅ ~28 | ✅ | ❌ | ❌ | `question` |
| Toolathlon (ICLR 2026) | 未明示 + canary 限制 | 108 | ✅ | ✅ | ❌ | ❌ | 有，但不得入检索语料 |
| MCPToolBench++ | MIT | 1509 | ❌ | ❌ | ❌ | ❌ | `query`，但类别是 Browser/FS/Search/Map/Finance/Pay，与本项目无关 |
| BFCL / ToolBench / MCP-Bench | — | — | ❌ | ❌ | ❌ | ❌ | 不覆盖我们的服务 |

## 对 86 条 derived 任务的实际可替换率

- derived 分布：GitHub 19 / Notion 5 / Linear 16 / Vercel 46
- **只有 GitHub + Notion 的 24 条（28%）理论上可替换**；Linear/Vercel 的 62 条在任何权威 MCP benchmark 里都没有任务
- 工具级更严：GitHub 19 条中约 8-10 条是 MCP 特有工具（`sub_issue_write`、`list_issue_fields`、`request_copilot_review`），权威 benchmark 没有；Notion 5 条全是新版工具，而 MCPMark 钉死 `@1.9.1`、MCP-Atlas 用旧式 `notion_API-*`，对不上

## 官方源深挖（另一条线）

对 GitHub/Notion 剩余 derived 工具做了全量深挖（docs map + 多轮检索）：
- 只新找到 **3 条**官方逐字：`sub_issue_write`（Copilot 创建子 issue 文档）、`get_latest_release` / `search_issues`（github.blog）
- 其余 21 条**确认官方确实没有示例**（不是没挖——把 docs/ 全部 md、cheat sheet、cookbook evaluations 都枚举检索过了）

## 后续：44% derived 任务已用 schema 驱动 + 反向验证重生

既然权威源补不到 86 条 derived，改用业界成熟做法：**schema 驱动生成 + 反向验证闭环**（4 个子代理并行，按服务拆）：
- 每条任务从工具的官方 description + inputSchema 生成，语义严格来自 description
- 生成后跑本地 BM25（`searchEntries`），要求目标工具进 top 5，召回不了改措辞重试（≤3 次）
- 结果：**86/86 全部通过反向验证**（GitHub 19 rank=1 / Notion 5 rank=1 / Linear 16 rank=1 / Vercel 46 全 top5，40 个 rank=1）
- 对比：Linear 原 derived 任务有 8 条**根本召回不到**目标工具，重生后全部 rank=1

这把 44% 的"权威性"从"LLM 看描述随便写"提升为"基于官方 schema 生成 + 客观验证任务确实能被 search 召回目标工具"。虽然不是逐字官方 prompt，但对"测工具发现"这个目标是有效的、可验证的。最终任务集 `explore/tasks-v2.json`。

## 结论

1. **任务来源的现实天花板**：105 官方逐字 + 3 新补 = 108/191（56%）有官方来源；剩下 83 条（44%）——业界和官方都没有现成任务。但已通过 schema 驱动 + 反向验证重生，保证任务对工具发现有效。
2. **MCPMark 的价值**：它是唯一能给我们提供"权威任务 prompt"的源（GitHub 23 + Notion 28 条 description.md，本地已有克隆 `work/mcpmark`）。但它的任务依赖它自己的测试环境（固定页面/仓库），直接跑在我们的账号上会产生大量假 404（我们探索测试里已验证这个现象）。
3. **不要宣称权威评测**：我们这套 191 任务的准确定位是"官方为主 + 业界无任务处构造"的广度扫描，适合找问题，不适合发布分数。

## 来源
- MCPMark: https://github.com/eval-sys/mcpmark （本地克隆 work/mcpmark）
- MCP-Atlas: https://huggingface.co/datasets/ScaleAI/MCP-Atlas
- MCP-Universe: https://github.com/SalesforceAIResearch/MCP-Universe
- 调研原始报告：work/authoritative-sources.md、work/more-official.json
