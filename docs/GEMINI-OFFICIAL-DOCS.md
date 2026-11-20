# Gemini 接入 MCP 官方文档要点（调研）

> 2026-11-20 调研。来源：Google 官方文档。**本文件只记录事实，不改任何代码/配置。**

## 来源

1. **用户侧：连接自定义 app**（support.google.com）
   https://support.google.com/gemini/answer/17209137 — 网页版 gemini.google.com 怎么连自定义 MCP
2. **开发者侧：MCP 集成标准**（developers.google.com，最后更新 2026-10-27）
   https://developers.google.com/connected-apps/mcp/server-optimization — 工具/协议/安全规范
3. 相关：Gemini Enterprise 自定义 MCP 配置 https://docs.cloud.google.com/gemini/enterprise/docs/connectors/custom-mcp-server/set-up-custom-mcp-server
4. 相关：Gemini CLI MCP https://geminicli.com/docs/tools/mcp-server/

## 1. 网页版连接自定义连接器（用户侧）

- 路径：gemini.google.com → Settings → Connected Apps → 自定义 apps → Add a custom app → 填 MCP Server URL
- 若服务器不支持 DCR：Advanced features → Show more → 填凭据
- 连上后在网页版和手机 App 都能用；用 `@` 选具体 app
- **前提**：18+、在美国、个人 Google 账号（工作/学校账号不支持）、History 开启、仅英文界面
- 安全提示：Google 不控制第三方 MCP server，写操作需手动确认，但需要你信任该服务

## 2. MCP 集成标准（开发者侧，跟我们的设计直接相关）

### 与我们冲突的部分

**工具粒度：要求原子工具，反对 mega-tool**
- "Treat tools as atomic endpoints without inside tool conditions or multiple functionalities"
- 明确反对 `manage_user(action=create/update/delete)` 这种"一个工具塞多个动作"的形态
- 我们 Code Mode 的 `execute(code)` 是一个万能执行器 —— 正是官方反对的形态
- "MCP servers exposing dozens of tools or deeply nested 'mega-tool' schemas will be flagged during review for fixes"

**工具数量**
- 官方倾向少而精。"暴露几十个工具"会被标记整改
- 我们当前暴露 199 个工具（禁用 265 个后）——按官方标准仍偏多

### 与我们一致的部分

**大结果处理**
- "Always filter, pre-aggregate, or summarize large data streams on your MCP server before returning"
- "Never dump raw database rows or complete unindexed logs into the tool return payload"
- 平台对 context window / execution latency / reasoning steps 有 guardrail
- —— 我们 Code Mode 在沙箱里过滤大结果、结果 8000 字符截断，方向一致

**协议**（我们已符合）
- Streamable HTTP，单 endpoint，JSON-RPC over POST；不支持旧 SSE（2024-11-05）
- 支持到 MCP `2025-11-25`；GET 流可回 405
- annotations 必须显式声明（readOnlyHint / destructiveHint / openWorldHint）——不声明时客户端默认 readOnlyHint=false + destructiveHint=true
- 版本化路径 /v1 /v2 便于升级

**其它规范**
- 工具命名：snake_case/camelCase，动词-名词（verb_noun）
- 描述写成"指令"而非"注释"，说明来源、格式、约束
- 错误：可恢复错误返回描述性文本让模型自纠；终态错误抛 McpError
- 安全：防 prompt injection，描述里不要命令式"MUST/CRITICAL"，不要引用其它工具名

## 3. 关键判断

1. **官方标准反对 mega-tool**，我们的 `execute(code)` 属于这类。但这份标准是给要上 Gemini 应用市场审核的开发者 —— 我们是个人自建连接器，不走审核，所以"会被标记"对我们不发生。
2. **但它揭示了 Google 的模型是围绕原子工具优化的** —— 我们的 execute 形态在 Gemini 默认模型上可能表现不佳。这与 hy4（编程模型）的测试结果不同：hy4 擅长写代码，Gemini 网页版默认模型不一定。
3. **工具数量**：官方倾向精简，我们 199 个仍偏多，但这是取舍（用户要 452 全量、只禁"用不上"的）。
4. **大结果处理方向一致** —— 这块我们做对了。

## 4. 对指标的影响（未验证）

- **准确性**：Code Mode 的 execute 形态可能不符合 Gemini 模型的优化预期 —— 这可能是准确率的隐患，需在 Gemini 里实测（但缺评测账号）。
- **速度**：execute 多一轮（LLM 写代码 → execute），延迟代价未知。
- **上下文**：execute 形态本身省上下文（工具定义少 + 结果沙箱过滤）——方向确定。

**注意**：以上"影响"是推断，没有实测数据。官方标准不等于"违反就一定差"，只是设计倾向。
