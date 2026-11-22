# 竞品排行榜：按我们的核心 / 痛点 / 需求 / 场景 / 人群

> 这不是“MCP gateway 谁 star 多”的排行榜。排序依据是 **和本项目真实价值主张的重合度**：
> 单用户、自托管、Web AI 客户端、上下文压缩、工具调用正确性、读写安全、可评测。
> 评分是**工程判断**，不是市场数据；权重可改，结论可重算。

## 0. 先定义“我们的核心”

### 核心

> 让一个使用网页版 AI（Gemini web 优先，Claude 次之）的人，把多个 MCP 上游塞进一个网关，
> **工具定义不炸上下文、工具调用不选错、读写不失控、每次优化都能被真实 eval 证明。**

### 真实痛点（按用户能感知的顺序）

| # | 痛点 | 用户看到的现象 | 我们对应能力 |
|---|---|---|---|
| 1 | 工具定义吃上下文 | 连 5 个上游，prompt 先塞 245k tokens 的 schema | 506→3 tools，-99.4%；`search` 渐进发现 |
| 2 | 工具选择/调用错误 | 选错工具、名字带 `__` 不会调、schema 不符合客户端 | `callName`、`sanitizeTool`、稳定工具面 |
| 3 | 结果撑爆上下文/截断 | 读一个文件返回 100KB；模型静默 `slice(0,150)` | 只有 sandbox 返回值入上下文；canonical/行区间/truncation |
| 4 | 读写失控 | Web 客户端每次调用都弹确认；写操作难审 | `execute_read` / `execute` 分层；写路径 dry-run/幂等 |
| 5 | 写一半失败 | 多文件写非原子、PR 编号要正则抠 | 原子 `push_files`、顶层 `number/url/sha`、真实 replay |
| 6 | 优化不可证 | “感觉快了”，但没有任务级数据 | capture → digest → analyzer → L1/G6 → 回归 |
| 7 | 客户端适配碎片化 | Gemini 不支持 structuredContent；ChatGPT 有 5k token/计划限制 | 客户端 profile/annotations/结果编码（进行中） |

### 场景

- **S1（主场景）**：个人用户在 Gemini web 里挂 3–10 个上游，做读文件、查 issue、改代码、开 PR；
- **S2**：同一个人想在 Claude.ai/ChatGPT 里复用同一网关；
- **S3**：开发者本地用 Inspector/Claude Code 做可复现验证；
- **S4（非目标）**：企业多租户治理、RBAC、K8s 控制面；
- **S5（非目标）**：只做工具检索、不执行/不写。

### 人群

- **主要**：会自己部署 Node/Vercel、有多个 MCP token 的个人开发者/技术用户；
- **次要**：想从 Claude 迁移到 Gemini web 的早期用户；
- **不是**：企业平台团队、需要多租户隔离的 SaaS 买家。

## 1. 评分方法

每项 1–5 分，按权重加总（满分 100）：

| 维度 | 权重 | 含义 |
|---|---:|---|
| 人群匹配 | 25 | 是否服务“单用户 Web AI 用户”，而不是企业平台 |
| 痛点重合 | 20 | 是否真的解决上下文/工具调用/写路径痛点 |
| 上下文/工具优化深度 | 20 | 工具定义压缩、渐进发现、结果投影、Code Mode |
| 执行/写/评测深度 | 15 | 读写分层、写语义、真实 capture/eval |
| Web 客户端可用性 | 10 | 对 Gemini/Claude/ChatGPT web 的实际适配 |
| 自托管/开源重合 | 10 | 是否可自托管、开源、可修改 |

> 分数是**相对相关性**，不是产品质量；企业产品在“人群匹配”天然低分，不代表它弱。

## 2. 排行榜（Top 12）

| 排名 | 项目 | 总分 | 人群 | 痛点 | 优化 | 执行/评测 | Web | 自托管 | 一句话判断 |
|---:|---|---:|---:|---:|---:|---:|---:|---:|---|
| 1 | **agentgateway** | **69** | 2 | 5 | 4 | 3 | 2 | 5 | 开源企业网关，progressive disclosure + Code Mode；强在 K8s/策略，不是 Web 单用户 |
| 2 | **Bifrost** | **69** | 2 | 5 | 4 | 3 | 2 | 5 | Code Mode 四 meta-tools，宣称 -92.8% 定义 token；企业网关路线 |
| 3 | **toolgate** | **68** | 3 | 5 | 4 | 1 | 2 | 5 | 最接近我们的 `search`：2 工具 + BM25/embedding/rerank + eval；但没有 Code Mode/写路径/Web 实测 |
| 4 | **Cloudflare MCP Portals context optimization** | **65** | 2 | 5 | 5 | 3 | 2 | 1 | 功能最同轴：`minimize_tools` + `search_and_execute`；但闭源平台、企业向、非单用户 Web，所以人群/自托管拉低总分 |
| 5 | **gemini-bastion-mcp** | **64** | 4 | 2 | 1 | 4 | 5 | 5 | 人群最接近（Web Gemini/Claude/ChatGPT），但 10 固定工具、无 Code Mode、无定义压缩；优化的是审批 UX |
| 6 | **Speakeasy MCP Gateway** | **64** | 3 | 4 | 4 | 3 | 2 | 2 | 明确“Code Mode 放在 gateway”；一个 execute + live tool search；商业/企业向 |
| 7 | **Limen / corrreia/dev-mcp / Forgemax / mcp_codemode** | **61** | 3 | 4 | 3 | 2 | 1 | 5 | Code Mode 同轴，但多已停滞/实验性；没有 Web 客户端/eval |
| 8 | **Consiliency/pmcp** | **60** | 3 | 4 | 3 | 1 | 2 | 5 | 开源 Progressive MCP gateway；`catalog_search` + lazy servers；缺执行/写/评测 |
| 9 | **Stacklok MCP Optimizer** | **54** | 3 | 3 | 3 | 1 | 2 | 4 | 工具检索/优化器；可对标 eval，但不做执行/写 |
| 10 | **IBM ContextForge** | **51** | 2 | 3 | 2 | 3 | 1 | 5 | 企业控制面；TOON 只压 tool result 且默认 disabled；无 tool search/Code Mode；叙事竞品 |
| 11 | **Anthropic Tool Search / OpenAI `tool_search` / MCP Groups** | **45–50** | 3 | 4 | 3 | 1 | 2 | 0 | 长期协议/宿主威胁；按用户实测当前 Web 客户端效果不好，暂列 watch |
| 12 | **MCPHub / MetaMCP / Unla / Docker MCP Gateway / 纯聚合** | **35–45** | 2 | 2 | 1 | 2 | 1 | 5 | 聚合/控制面，不是同一优化轴；只作为相邻基础设施 |

> **分数解释**：Cloudflare 在“功能同轴度”上其实最高（优化 5/5），但本榜权重把“单用户/自托管/Web 人群”看得很重，所以它总分低于 agentgateway/Bifrost/toolgate。若只看“平台级功能威胁”，Cloudflare 应为第一。

## 3. 按“威胁类型”重排（老板视角）

| 威胁类型 | 项目 | 为什么 |
|---|---|---|
| **平台级直接替代** | Cloudflare Portals、agentgateway、Bifrost | 功能同轴，若用户愿意上企业平台/网关，会先选它们 |
| **开源直接竞品** | toolgate、Consiliency/pmcp、Limen/dev-mcp | 同问题、同技术路线，star 少但可被开发者直接 clone |
| **Web 人群直接竞品** | gemini-bastion-mcp | 同样打 Gemini/Claude/ChatGPT web；但它不解决上下文/工具定义压缩 |
| **叙事/搜索词竞品** | IBM ContextForge | 4.9k★ + IBM 品牌会抢“MCP context optimization”搜索结果，但压的是结果不是定义 |
| **长期结构性威胁** | Anthropic Tool Search、OpenAI `tool_search`、MCP Groups | 宿主/协议原生做掉 progressive disclosure；但当前 Web 客户端效果不好 |

## 4. 我们真正该赢的对比

### vs Cloudflare / agentgateway / Bifrost

它们赢在：企业部署、策略、K8s、品牌、生态。
我们赢在：

- **自托管、单用户、Web 客户端**；
- **3 工具且读写分层**（它们是单 `code`/多 meta-tools，不强调 read/write 边界）；
- **真实写路径**（dry-run、幂等、原子 push、PR/Issue 结果）；
- **全量 capture + L1/G6 任务级 eval**（它们有 metrics/logs，不是任务级回归）。

### vs toolgate / pmcp

它们赢在：检索算法、离线 eval 工具、目录索引。
我们赢在：

- 检索之后还能**执行代码编排**；
- **读写隔离 + 写路径语义**；
- **Web 客户端实测**；
- **任务级 eval**，而不只是 Recall@k。

### vs gemini-bastion

它赢在：Web 三端适配、Docker/审批 UX、垂直 coding 工具。
我们赢在：

- **工具定义压缩 506→3**；
- **Code Mode 任意上游编排**；
- **读写分层 + 全量 capture/eval**；
- 不是固定 10 工具，而是任意上游聚合。

### vs IBM ContextForge

它赢在：企业治理、协议广度、管理 API、部署矩阵。
我们赢在：

- 压的是**工具定义**，不是结果；
- Code Mode + QuickJS；
- 单用户轻量、自托管、Web 客户端；
- 任务级 eval，而不是企业观测。

## 5. 结论：我们不是“第一”，但占一个它们都不占的位置

> **单用户 + 自托管 + Web 客户端 + 工具定义压缩 + Code Mode + 读写分层 + 全量评测**

- Cloudflare/agentgateway/Bifrost 有“上下文 + Code Mode”，但没有“单用户 Web + 读写语义 + 任务级 eval”；
- toolgate/pmcp 有“检索/渐进发现”，但没有“执行/写/评测”；
- gemini-bastion 有“Web 人群”，但没有“上下文/工具定义优化”；
- IBM 有“企业压缩叙事”，但压的是结果、不是定义，且不是 Web 单用户。

**所以排行榜第一不应该是我们，但“和我们完全同场景、同痛点、同人群”的产品目前不存在。**
这是机会，也是必须把“闭环”讲清楚的原因。

## 6. 参考

- Cloudflare context optimization：https://developers.cloudflare.com/changelog/post/2026-03-26-mcp-portal-context-optimization/
- agentgateway progressive disclosure：https://www.solo.io/blog/keeping-context-and-tokens-low-with-progressive-disclosure-in-agentgateway
- Bifrost：https://www.getmaxim.ai/bifrost
- Speakeasy Code Mode：https://www.speakeasy.com/blog/code-mode-mcp-gateway
- toolgate：https://github.com/RajeshwariVelmurugan/MCP-Tool-Retrieval-Gateway
- Consiliency/pmcp：https://github.com/Consiliency/pmcp
- Stacklok vs Anthropic tool search：https://stacklok.com/blog/stackloks-mcp-optimizer-vs-anthropics-tool-search-tool-a-head-to-head-comparison/
- IBM ContextForge 源码分析：[IBM-CONTEXTFORGE-VS-US.md](IBM-CONTEXTFORGE-VS-US.md)
- 检索 ≠ 任务成功：https://community.openai.com/t/mcp-tool-retrieval-improved-from-50-to-93-but-agent-tool-use-grades-did-not-improve/1411706
- 2026-11 Code Mode 预注册研究：https://arxiv.org/html/2611.19123v1
- ChatGPT 5k 限制报告：https://community.openai.com/t/tool-response-truncation-on-mcp-connector-responses-that-previously-worked/1383071
- Gemini Enterprise actions 限制：https://docs.cloud.google.com/gemini/enterprise/docs/connectors/custom-mcp-server/set-up-custom-mcp-server
- 内部完整矩阵：[COMPETITORS.md](COMPETITORS.md)、[DIFFERENTIATION.md](DIFFERENTIATION.md)、[WEB-CLIENTS.md](WEB-CLIENTS.md)
