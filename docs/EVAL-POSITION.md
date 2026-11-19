# 评测定位（最终版）

> 状态：**取代 `EVAL-REDESIGN.md` 和作废的 `EVAL-RESULTS.md`**。
> 结论先行：我们要做的"渐进式披露能省上下文"这件事，**业界已有大量严谨 A/B 评测**，不需要也不应该自己重跑一个更差的。本项目应转向"实现验证 + 特有工程变量测试"。

## 一、我们到底在做什么

本网关本质 = **Code Mode / Tool Search（渐进式披露）的云端工程包装**：
- 把多个远程 MCP 的工具收敛成 `search_tools` + `call_tool` 两工具形态（等价于 Anthropic Tool Search / Cloudflare Code Mode 的两工具模式）
- 加了一层 Gemini 自定义连接器需要的 OAuth DCR
- 加了白名单裁剪（等价于 GitHub Copilot 的 40→13 工具治理）

所以"工具少是否更好"这个命题，答案别人已经给了。我们要验证的是**这个具体实现**，不是重新证明命题。

## 二、现成的一手评测证据（直接引用，不重复造轮子）

| 来源 | 评测 | 关键数据 | 类型 |
|---|---|---|---|
| Anthropic 官方 | Tool Search 开关 A/B（同模型同任务） | Opus 4 **49%→74%**，Opus 4.5 **79.5%→88.1%**，token 占用 **72K→8.7K（-85%）**；保留上下文 122,800→191,300 tokens | 厂商内部 A/B（营销性，非独立复现） |
| Anthropic 官方 | Code execution with MCP | **150K→2K tokens（-98.7%）** | 厂商示例 |
| Cloudflare Code Mode | 云端两工具（search+execute），**与本项目形态最贴合** | 两工具约 **1,000 tokens**；等价全量 MCP 需 **1.17M tokens**（超最强模型整个上下文窗口） | 厂商博客 |
| RAG-MCP (arXiv:2505.03275) | 检索式工具选择 | 准确率 **13.6%→43.1%**，prompt token **-49%**；1→11,100 工具压测；候选池 <30 工具成功率 >90%，>100 工具 retrieval 退化主导 | 论文 |
| BoR (arXiv:2605.24660, Meta) | 该看几个工具，chance-corrected | 展示 50 个 90.8%，只展示 7 个 90.3%；选择准确率 **93.1% vs 87.1%** | 论文 |
| Less is More (arXiv:2411.15399) | 裁剪工具数 | 46→19 工具，准确率 **89%** | 论文 |
| GitHub 官方 | Copilot 工具治理 | 内置工具 **40→13**，上 embedding routing | 厂商博客 |
| Stacklok | 工具搜索头对头 | 检索 5 工具 / 2823 tokens / ~12s | 厂商对比 |
| MDPI (19/6/447) | 噪声工具影响 | 噪声 10→50：检索 recall 0.992→0.890，LLM 选择 0.674→0.586 | 论文 |
| Arcade.dev | 反向压测 | 4000+ 工具下 tool search 检索准确率仅 **60%** | 厂商博客（反面证据） |
| Fullstory | 反向观点 | frontier 模型压到 100 工具仍 OK，关键是描述质量 | 厂商博客（反面证据） |

**共识**：裁剪 + 渐进披露整体有效，白名单/少工具落在各来源公认的安全区。
**分歧**：具体阈值无共识（"20 工具断崖"缺乏可靠一手出处）；工具描述质量可能比数量更重要。
**我们网关的位置**：9 个白名单工具（远低于所有阈值）+ 兜底两工具，符合共识方向。

## 三、本项目真正该验证的（别人没覆盖的）

### A. 实现正确性验证（必须做，轻量）
- 网关 `tools/list` 是否真的只暴露白名单工具 + 2 元工具？（已由 `tests/server.test.js` 覆盖）
- schema sanitize 是否满足 Gemini 约束（array.items、多类型收敛）？（已由 `tests/sanitize.test.js` 覆盖）
- 白名单工具是否都是完整 schema 而非摘要（避免 -10.3pp 的参数错误代价）？（已实现，需确认）
- **结论：这部分测试已基本完成，不需要再做大评测。**

### B. 我们特有的工程变量（值得做，但需要真实 Gemini）
1. **兜底两轮延迟**：`gateway_search` → `gateway_call` 多一轮推理，在 Gemini 网页版实际多慢？——必须在 Gemini 里手动测，无 API。
2. **DCR + 多上游 token 代持稳定性**：长期运行会不会掉线、token 过期怎么处理。——运维监控问题，非 benchmark。
3. **白名单维护成本**：上游工具改名/新增时，白名单会不会失效？——工程流程问题。

### C. 不做的事
- ❌ 不再用 hy4 反向生成 100 题跑"工具数梯度"——那是重做 Anthropic/RAG-MCP/BoR 已做的，且我们模型代理、小样本，结论不可靠。
- ❌ 不再纠结 McNemar / BoR / 100 题样本量——那是发布新 benchmark 才需要的严谨度，我们不是发论文。
- ❌ 不再把作废的 `EVAL-RESULTS.md` 数字当结论。

## 四、交付方式

给用户的价值主张改为：
> "网关方向有 Anthropic/GitHub/RAG-MCP 等一手 A/B 背书（工具收敛能同时省 token 且保/提准确率）。本项目是这套思路在 Gemini 网页版 + 多远程 MCP 场景的云端实现。需要验证的是这个实现本身是否正确、以及兜底延迟/GitHub 只读端点等特有问题，而不是重新证明'少工具更好'。"

## 五、来源

- Anthropic Tool Search: https://www.anthropic.com/research/advanced-tool-use
- Anthropic Code Mode: https://www.anthropic.com/research/code-execution-with-mcp
- Cloudflare Code Mode: https://blog.cloudflare.com/code-mode-mcp
- RAG-MCP: https://arxiv.org/abs/2505.03275
- BoR: https://arxiv.org/abs/2605.24660
- Less is More: https://arxiv.org/abs/2411.15399
- GitHub Copilot 工具治理: https://github.blog/ai-and-ml/github-copilot/how-were-making-github-copilot-smarter-with-fewer-tools/
- Stacklok head-to-head: https://stacklok.com/blog/stackloks-mcp-optimizer-vs-anthropics-tool-search-tool-a-head-to-head-comparison/
- Arcade.dev 反面数据: https://arcade.dev/blog/anthropic-tool-search-4000-tools-test/
- Fullstory 反面观点: https://www.fullstory.com/blog/tool-calling-accuracy-context-is-the-bottleneck/
- MDPI: https://www.mdpi.com/1999-4893/19/6/447
