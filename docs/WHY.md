# 为什么做这个网关

## 目的

**省上下文。** 工具定义（name + description + inputSchema）是常驻占用模型上下文的。在 Gemini 里直连 GitHub、Notion、Linear、Vercel 四个官方 MCP，会把 456 个工具的完整 schema 一次性塞进上下文，约 **217,601 tokens**——挤掉对话历史、文档内容和推理空间。

网关只暴露 3 个固定的 Code Mode 工具（`search` / `execute_read` / `execute`），约 **1,286 tokens**，**省 99.4%**。上游工具的定义不进上下文；需要时模型先用 `search` 按需发现，再在沙箱里调用。

## 实测数据

`scripts/measure-context.mjs`（真实 schema，bytes/4 估算，无模型调用）：

| | 工具数 | 定义大小 | 约 tokens |
|---|---|---|---|
| 直连 4 个 MCP（全量） | 456 | 870,402 B | ~217,601 |
| 本网关（Code Mode 工具面） | 3 | 5,142 B | ~1,286 |
| **节省** | | | **99.4%** |

上游工具分布：GitHub 46 / Notion 77 / Linear 60 / Vercel 273。当前配置 deny 后启用 **191** 个（GitHub 42 / Notion 53 / Linear 36 / Vercel 60），它们可在沙箱内调用，但定义不进上下文。

> 早期 whitelist 形态测过「424 工具 → 9 工具，4,782 tokens，-97.6%」。那组数字已过期，现以 Code Mode 口径为准。

## 工具发现（search 召回）

`scripts/eval-search.mjs` 用 191 条逐工具任务、按**生产目录**（191 个启用工具，不含被 deny 的）离线评测 BM25 搜索：

- top1 **56.5%**（108/191）、top5 **72.3%**（138/191）
- 剩余 53 条 miss 主要是纯语义/编号类（"PR #123"、Notion 语义查询、附件类），不是排序缺陷；是否引入 embedding 尚未决定

## 这不是新命题，是成熟思路的云端实现

"渐进式披露 / Tool Search / Code Mode 能省上下文且保准确率"已有大量一手 A/B 证据，本项目不需要重新证明：

- **Anthropic Tool Search**：上下文 72K→8.7K（-85%），Opus 4 准确率 49%→74%（[来源](https://www.anthropic.com/research/advanced-tool-use)）
- **Cloudflare Code Mode**：两工具约 1,000 tokens vs 全量 1.17M tokens，形态与本项目最接近（[来源](https://blog.cloudflare.com/code-mode-mcp)）
- **RAG-MCP 论文**：准确率 13.6%→43.1%，prompt token -49%（[来源](https://arxiv.org/abs/2505.03275)）
- **GitHub Copilot**：内置工具 40→13，上 embedding routing（[来源](https://github.blog/ai-and-ml/github-copilot/how-were-making-github-copilot-smarter-with-fewer-tools/)）

共识：裁剪 + 渐进披露整体有效。分歧：具体阈值无共识，工具描述质量可能比数量更重要。

## 复现

```powershell
# 重新采集 4 个上游的真实工具 schema（GitHub 从 CC Switch，Linear/Notion 从 DSH 缓存，Vercel 需 VERCEL_TOKEN 环境变量）
node scripts/collect-tools.mjs

# 工具面上下文占用（Code Mode 口径）
node scripts/measure-context.mjs

# 搜索召回（生产目录口径）
node scripts/eval-search.mjs
```

数据存 `data/tool-dataset.json`，测量脚本不访问模型、不打印凭据。

## 网关对 Gemini 的价值

1. **上下文恒定**：不管上游工具涨到多少，模型侧只看到固定的 3 个工具定义 + 稳定 schema（顺序固定，可吃 prompt caching）。
2. **能力不丢**：白名单/deny 之后的 191 个工具都能在沙箱里调用，只是不常驻上下文。
3. **稳定 schema**：工具列表是静态快照；Gemini 不消费 `notifications/tools/list_changed`，改工具走版本化路径。
