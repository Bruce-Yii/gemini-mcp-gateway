# AGENTS.md - gemini-mcp-gateway

本文件只写本项目特有、且与工作区根 AGENTS.md 不同的规则。通用规则见工作区根。

## 本项目的坑

- **接口契约是唯一真相**：`CONTRACT.md` 定义了所有文件路径与导出接口。并发开发时每个 agent 只写自己的文件，跨文件需求先给 lead 发消息，不要擅自改契约或写别人的文件。
- **MVP 只做本地**：不实现 OAuth / DCR / Vercel 部署。目标是本地跑通标准 MCP server（Streamable HTTP），用 MCP Inspector 或冒烟脚本验证"白名单工具 + gateway_call + gateway_search"的工具列表。
- **不碰真实凭据**：`config.example.json` 只能有占位符；真实 token / client secret 不进仓库、不进 git、不进日志。测试只用 `harness/fake-upstream.mjs`。
- **schema 必须过 sanitize**：Gemini 对 function declaration 有硬性约束（`type:"array"` 必须有 `items`、多类型会被拆坏、超深 oneOf 超限）。任何注册给 Gemini 的工具 schema 都必须经过 `sanitizeTool`，否则 Gemini 侧直接 400。
- **工具列表必须稳定**：白名单工具按固定顺序注册（排序后），不要在会话中途改工具定义——Gemini 不消费 `notifications/tools/list_changed`，改 schema 要换版本路径。
- **工具名用双下划线**：entry 对外 name 用 `server__tool`（`__` 分隔），避开 Gemini"按第一个下划线分 namespace"的解析规则。
- **结果用文本 JSON**：`content:[{type:'text',text:JSON.stringify(result)}]`，不要用 `structuredContent`（Gemini 不支持）。
