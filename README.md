# gemini-mcp-gateway

标准远程 MCP 网关：把 GitHub / Notion 等上游 MCP 的几十个工具，收敛成**稳定的白名单工具 + `gateway_call` / `gateway_search` 兜底**，供 Gemini 网页版自定义连接器使用。解决两个问题：

1. **上下文**：工具定义恒定且很小，不随上游工具数膨胀；
2. **速度**：高频工具走单轮直调，不做模型驱动的两轮搜索（搜索只在兜底路径）。

## 当前状态：本地 MVP 完成

- [x] 项目骨架 + 接口契约（`CONTRACT.md`）
- [x] catalog / sanitize / upstreams / server 四模块
- [x] 单元 + 集成测试（37 项通过）
- [x] 本地冒烟（假上游 + MCP Inspector 兼容的 Streamable HTTP）
- [x] **真实 GitHub 远程 MCP 端到端验证**（只读端点，白名单 5 个工具，实际调用返回数据）
- [ ] Notion 真实 MCP（需 OAuth DCR，留到 Vercel 阶段）
- [ ] OAuth / DCR + Vercel 部署

### Token 注入（重要）

凭据**只走环境变量**，绝不进配置文件/git/日志。HTTP 上游用 `tokenEnv` 字段指定环境变量名：

```json
{ "name": "github", "transport": "http",
  "url": "https://api.githubcopilot.com/mcp/readonly",
  "tokenEnv": "GITHUB_TOKEN", "allowTools": ["get_file_contents", "search_repositories"] }
```

`npm run start` 前先 `setx GITHUB_TOKEN <token>`（或在进程里注入）。`scripts/verify-real-github.mjs` 演示了从 CC Switch 的 Copilot token 读取并注入环境变量（不落盘、不打印）。

## 设计

详见 `CONTRACT.md`。核心形态：

```
Gemini → [本网关 /mcp] → GitHub / Notion 上游 MCP
          ├─ 白名单工具（10-20 个，完整 schema，固定顺序）  ← 热路径单轮
          ├─ gateway_call(server, tool, args)                ← 兜底
          └─ gateway_search(query, limit?)                   ← 兜底
```

关键约束：Streamable HTTP、MCP 2025-11-25、schema 过 sanitize（array 必须有 items）、工具名 `server__tool`（双下划线）、结果用文本 JSON（不用 structuredContent）、工具列表会话中不变。

## 快速开始（开发完成后）

```powershell
cd D:\12412\dsh工作区\projects\gemini-mcp-gateway
npm install
npm test
npm run smoke     # 本地假上游冒烟
npm start         # http://localhost:3000/mcp
```

配置见 `config.example.json`（真实凭据不进仓库）。

## 评测

`docs/EVALUATION.md`：直连 4 个 MCP（Notion/GitHub/Linear/Vercel）vs 网关收敛的对比方案——三层指标框架、20 个测试任务、记录模板、决策规则。核心结论：成功率是底线，token/速度是优化项；省 token 但任务失败就是负收益。

## 目录

| 路径 | 用途 |
|---|---|
| `CONTRACT.md` | 接口契约（并发开发唯一真相） |
| `src/catalog.js` | 工具目录 / BM25 搜索 / allow-deny（复用 dsh-mcp-gateway） |
| `src/sanitize.js` | Gemini schema 清洗 |
| `src/upstreams.js` | 上游 MCP 客户端 |
| `src/server.js` | MCP server 入口 |
| `tests/` | 单元 + 集成测试 |
| `harness/` | 假上游 MCP server |
| `scripts/` | 冒烟脚本 |
