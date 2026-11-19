# 评测重做方案（基于方法论调研）

> 状态：**方案，待批准**。旧评测（`EVAL-RESULTS.md`）已判定不成立，见下文"旧版问题"。
> 调研来源：ECBD (ACL 2024)、HELM、Stacklok head-to-head、ToolComp、MCPToolBench++、BFCL、BoR 论文 (arXiv:2605.24660)、τ-bench 等，链接见文末。

## 一、旧版为什么不成立

用"考试"比喻逐环节核对（ECBD 五模块）：

| 环节 | 旧版做法 | 问题 |
|---|---|---|
| 考题 | 手写 20 个任务 | 每题没有从真实工具反推，3 题的预期工具在数据集里根本不存在（#13/#14/#20 命中 0） |
| 答案 | `expectedToolHint` 正则 | 太宽（`search\|list` 命中 110 个工具）或错误；无人工校验 |
| 考官 | 自己写的 scoring | B 方案"调了 `gateway_search` 就算路由正确"——70.6% 靠这条拿分，等于"调用兜底就算对" |
| 考试人 | hy4（reasoning:none） | 单模型单次、temperature 0 但无重复，无方差估计 |
| 考场 | A9/A50/A128/A424 顺序截取 | A9 全是 GitHub、Vercel 259 个全挤在 A424；对照组工具构成完全不同，违反"adaptation 不得使某些对象吃亏"（ECBD） |
| 统计 | 配对二项 + p 值 | 二值应用 McNemar；20 题的 MDE≈±21pp，只能做 pilot，不能下结论 |

**结论：旧数字作废，包括"网关省 98% token 且路由 88.2%"这句。**

## 二、重做设计

### 研究问题（构念定义）

> 在工具数量从少到多的条件下，模型的（a）工具选择准确率、（b）参数正确率如何变化？网关的"紧凑策划工具集 + 兜底"相对"全量工具集"是否在不损失准确率的前提下显著降低上下文成本？

不声称：不声称代表 Gemini 网页版（无 API），只做 hy4 上的代理测试 + 明确标注外推限制。

### 考题构造（关键修正：反向生成）

照 Stacklok 做法：从 424 个真实工具里，为每个工具/工具链用 LLM 反向生成一条"自然会用到它"的查询，保留结构化 gold。这样：
- 每题 gold 确定且真实存在；
- 所有方案面对**同一批题、同一 gold**；
- 覆盖 4 个服务（按工具数比例分层采样，避免 A9 全是 GitHub 的偏差）。

### 对照组（单因素变量 = 可见工具集）

| 组 | 可见工具集 | 说明 |
|---|---|---|
| C（oracle） | 直接给 gold 工具 | 上限基线，分离"检索损失 vs 推理损失"（ToolBench oracle retriever 做法） |
| B（网关） | 紧凑白名单（4 服务均衡，如每服务 3-5 个）+ gateway_search/call | 真实网关形态 |
| A-K（直连） | 分层采样的 K 个工具，K∈{10, 25, 50, 100, 200, 424} | 按服务比例采样，保证每组都覆盖 4 服务 |

所有组：**同一 hy4 版本、同一 temperature/token 预算、同一 prompt、同一工具描述文本、同一工具顺序规则**（顺序 shuffle 后固定），唯一差异是工具集。

### 指标（分三段，对齐 ECBD evidence）

1. **检索阶段**：gold 是否进入可见集 → Recall@K + **BoR（chance-corrected）** = log2(P_obs / P_rand)，其中 P_rand = K/N（单工具题）。BoR 自动校正"工具越多越容易蒙对"。
2. **选择阶段**：在 gold 可见的题上，模型是否选中 gold → Selection Accuracy（这才是"选对工具"）。
3. **执行/参数阶段**：gold 调用的参数是否匹配 → AST exact match（BFCL 规则：函数名、参数名/类型/值；字符串标准化；多调用 all-or-nothing）。本代理测试无真实执行，用 AST 代替 pass rate，明确标注。
4. **成本**：工具定义 token、端到端 token、延迟（agent loop 轮数）。

三段分开报，不合并成单一"正确率"。

### 评分器（考官）校准

- 主评分用**确定性 AST 匹配**（不依赖 LLM judge），避免 judge 偏差。
- 用 LLM judge 的地方（反向生成题的质量、参数语义等价）需：固定 judge 版本、抽 50 题人工复核、报 Cohen κ / Krippendorff α ≥0.67。
- 评分失败/超时**默认判错**，不默认判对（旧版的隐性错误）。
- 保留逐题 trace 与判分理由，支持回放。

### 题量与统计

- 目标：**≥100 题**（pilot 先 30-50 题验证流程）；明确标注这是 pilot 级，MDE 仍约 ±10pp。
- 每题每方案跑 **3 次**（temperature 0 下用不同 seed 或轻微扰动），报 pass@1 与 pass^3。
- 配对统计：B vs 每个 A 组用 **McNemar**（不一致对<10 用精确二项），报 **odds ratio + 95% CI**，不只报 p。
- 多重比较（5 个 A 组）用 Holm 校正。
- 报工具集构成矩阵、逐题 gold、逐题 trace、失败原因分布。

### 效度与信度

- **构念效度**：写清"测的是工具选择，不是任务成功率；是 hy4 代理，不是 Gemini"。
- **内部效度**：对照唯一变量是工具集；工具描述文本、顺序规则、预算全部固定；加"空操作哨兵题"（无合适工具时应 abstain）。
- **信度**：test-retest（3 次运行的方差）、judge 一致性（α/κ）。
- **外部效度**：明确标注代理测试的外推边界。

## 三、实施步骤

1. 写构念定义 + 审计清单文档（本文件扩充）
2. 反向生成 ≥100 题（LLM 生成 + 人工/规则校验 gold 存在于数据集）
3. 校准评分器（AST matcher 单元测试 + 50 题人工复核 + judge α）
4. 固定 harness（模型版本/预算/prompt/顺序 shuffle 种子）
5. Pilot 跑 30 题，检查各环节无系统性错误
6. 全量跑，配对统计 + Holm 校正 + 效应量
7. 写结果报告（含 BenchmarkCards 式元数据、局限、可复现信息）
8. 清理旧的错误结果，标注 `EVAL-RESULTS.md` 作废

## 四、需要你确认

- 题量目标：100 题（pilot 级，约 ±10pp）还是更大？生成成本随题量线性增长。
- 是否接受"hy4 代理测试"这个定位（不冒充 Gemini）？
- 参数正确率用 AST 匹配（无真实执行）是否可以，还是必须为几个关键任务接真实 MCP 执行验证？

## 主要来源

- ECBD: https://aclanthology.org/2024.acl-long.861/
- HELM: https://arxiv.org/abs/2211.09110
- Stacklok head-to-head: https://stacklok.com/blog/stackloks-mcp-optimizer-vs-anthropics-tool-search-tool-a-head-to-head-comparison/
- ToolComp: https://arxiv.org/abs/2501.01290
- MCPToolBench++: https://arxiv.org/abs/2508.07575
- BFCL: https://proceedings.mlr.press/v267/patil25a.html
- BoR (arXiv:2605.24660): https://arxiv.org/html/2605.24660v1
- τ-bench: https://arxiv.org/abs/2406.12045
- Adding Error Bars to Evals: https://arxiv.org/html/2411.00640v1
- Measurement Without Validity: https://arxiv.org/html/2608.00794v5
- NeurIPS E&D 2026 Reviewer Guidelines: https://neurips.cc/Conferences/2026/EvaluationsDatasetsReviewerGuidelines
