# B1 · 阶段一：测评场景覆盖全且权威

> 门控：本项通过后才能进 B2。判定标准见 README.md。

## 台账条目

### SCENARIO-01 任务覆盖度
- **要求**：任务集覆盖当前暴露的全部工具
- **证据**（2026-11-21 实测）：
  - 当前配置暴露工具：191（GitHub 42 + Notion 53 + Linear 36 + Vercel 60）
  - 任务集 tasks-v2.json：191 条，unique tool 191
  - 暴露但无任务：0
  - 任务指向不存在工具：0
- **结论**：✅ 通过（191/191 全覆盖）

### SCENARIO-02 来源权威性
- **要求**：任务来源权威（官方逐字 / 权威 benchmark / schema 驱动+反向验证，逐级标注）
- **第二轮重搜**（用户质疑搜索方法后，work/authority-research2.md，不带预设重搜）：
  - 找到两个之前漏掉的源，但都不满足全部条件：
    - TrueFoundry mcp-skillbench：19 条 Linear 任务（有 prompt+评分+冻结回放），但厂商博客实验非学术 benchmark、**公开仓库实测 404 拿不到**、只覆盖 Linear 不覆盖 Vercel、许可证未知
    - Vercel `next-evals-oss`：26 个任务 MIT 公开，但任务是 Next.js 编码任务，**不是 Vercel MCP 工具任务**
  - 新查的 10+ 学术 MCP benchmark（MCP-AgentBench AAAI2026、MCPAgentBench 北大、MCP-Bench Accenture、LiveMCPBench、MCPEval Salesforce、MCP-Atlas、HumanMCP 等）+ SWE-bench/WebArena/OSWorld/τ-bench/BFCL + 三家官方 eval：**全部无 Linear/Vercel MCP 工具任务**
  - **结构性根因**：benchmark 为可复现普遍筛选"无状态/无需凭据/纯文本"服务器，Linear/Vercel 是有状态需 OAuth 的 SaaS，被系统性排除；任务领域也不含项目管理/云部署运维
- **证据汇总**：
  - 官方逐字 prompt：105/191（55%）
  - schema 驱动 + 反向验证：86/191（45%），86/86 通过 top-5 验证
  - 权威 benchmark：GitHub/Notion 有（MCPMark 71 等），Linear/Vercel 结构性 0 覆盖
- **判定**：✅ **通过（附条件）**——覆盖全（SCENARIO-01）+ 权威性达到**客观可达上限**。经两轮独立调研（含用户质疑后的不带预设重搜）确认：不存在"权威 + 可直接用 + 覆盖 Linear/Vercel MCP 工具"的任务源。当前 55% 官方逐字 + 45% schema 驱动+反向验证已是能达到的最优组合。剩余缺口是结构性的，非搜索遗漏或偷懒。

## B1 门控结论

- SCENARIO-01（覆盖全）：✅ 通过（191/191）
- SCENARIO-02（权威）：✅ 通过（附条件）——经两轮调研确认已达客观上限；Linear/Vercel 的 0 覆盖是结构性行业现状

**B1 判定：通过。** 依据：用户质疑后已做第二轮不带预设重搜，结论一致且给出了结构性根因。权威性缺口有客观证据支撑，不是方法问题。

**遗留登记**（不阻塞 B1）：TrueFoundry mcp-skillbench 仓库若将来可用（当前 404），可补 19 条 Linear 权威任务——登记为 DEC，本轮不等待。
