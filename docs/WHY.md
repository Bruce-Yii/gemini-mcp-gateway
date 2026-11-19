# 为什么做这个网关

## 目的

**省上下文。** 工具定义（name + description + inputSchema）是常驻占用模型上下文的。在 Gemini 里直连 GitHub、Notion、Linear、Vercel 四个官方 MCP，会把 424 个工具的完整 schema 一次性塞进上下文，约 **20 万 tokens**——挤掉对话历史、文档内容和推理空间。

网关把工具定义压到Constant的 9 个（白名单高频工具 + 2 个兜底元工具），约 **4,782 tokens**，**省 97.6%**。

减掉用不上的工具只是手段——它们的 schema 留着纯属浪费上下文。核心是上下文占用本身的下降。

## 实测数据

`scripts/measure-context.mjs`（真实 schema，bytes/4 估算，无模型调用）：

| | 工具数 | 定义大小 | 约 tokens |
|---|---|---|---|
| 直连 4 个 MCP（全量） | 424 | 811,697 B | ~202,924 |
| 本网关（白名单 7 + 兜底 2） | 9 | 19,129 B | ~4,782 |
| **节省** | | | **97.6%** |

上游工具分布：GitHub 28 / Notion 77 / Linear 60 / Vercel 259。

## 这不是新命题，是成熟思路的云端实现

"渐进式披露 / Tool Search / Code Mode 能省上下文且保准确率"已有大量一手 A/B 证据，本项目不需要重新证明：

- **Anthropic Tool Search**：上下文 72K→8.7K（-85%），Opus 4 准确率 49%→74%（[来源](https://www.anthropic.com/research/advanced-tool-use)）
- **Cloudflare Code Mode**：两工具约 1,000 tokens vs 全量 1.17M tokens，形态与本项目最接近（[来源](https://blog.cloudflare.com/code-mode-mcp)）
- **RAG-MCP 论文**：准确率 13.6%→43.1%，prompt token -49%（[来源](https://arxiv.org/abs/2505.03275)）
- **GitHub Copilot**：内置工具 40→13，上 embedding routing（[来源](https://github.blog/ai-and-ml/github-copilot/how-were-making-github-copilot-smarter-with-fewer-tools/)）

共识：裁剪 + 渐进披露整体有效，9 个白名单工具落在各来源公认的安全区。分歧：具体阈值无共识，工具描述质量可能比数量更重要。

## 复现

```powershell
# 重新采集 4 个上游的真实工具 schema（GitHub 从 CC Switch，Linear/Notion 从 DSH 缓存，Vercel 需 VERCEL_TOKEN 环境变量）
node scripts/collect-tools.mjs

# 实测上下文节省
node scripts/measure-context.mjs
```

数据存 `data/tool-dataset.json`，测量脚本不访问模型、不打印凭据。

## 网关对 Gemini 的价值

1. **上下文恒定**：不管上游工具涨到多少，模型侧只看到固定的 9 个工具定义 + 稳定的 schema（顺序固定，可吃 prompt caching）。
2. **兜底不丢能力**：白名单没覆盖的工具，通过 `gateway_call` / `gateway_search` 两轮访问——能力不丢，只是不常驻上下文。
3. **稳定 schema**：工具列表是静态快照，Gemini 不消费 `notifications/tools/list_changed`，改工具走版本化路径。
