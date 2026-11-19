# gemini-mcp-gateway

标准远程 MCP 网关：**核心目的是省上下文**——把 4 个上游 MCP 的 424 个工具定义（约 20 万 tokens）压成固定的 9 个（约 4,782 tokens，省 97.6%），供 Gemini 网页版自定义连接器使用。详见 `docs/WHY.md`。

减掉用不上的工具只是手段，上下文下降才是目的。高频工具走单轮直调，`gateway_call` / `gateway_search` 兜底覆盖长尾。

## 当前状态：已上线

- [x] catalog / sanitize / upstreams / server 四模块
- [x] 单元 + 集成测试（43 项通过）
- [x] 真实 GitHub 远程 MCP 端到端验证（只读端点，白名单工具实际可调）
- [x] OAuth / DCR + Vercel 部署，线上全链路验证通过（6 redirect URI / PKCE / state / token / MCP 握手）
- [x] 上下文节省实测（`scripts/measure-context.mjs`：97.6%）
- [ ] Notion 真实 MCP（缺 token，未接入）
- [ ] 在 Gemini 网页版实际连接验证（需用户操作）

线上域名：`https://gemini-mcp-gateway-yu-ac3a.vercel.app/mcp`　仓库：`https://github.com/Bruce-Yii/gemini-mcp-gateway`

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

## 两种模式

config 里 `mode` 切换：

- **`whitelist`**（默认）：暴露白名单工具 + `gateway_call`/`gateway_search` 兜底。
- **`codemode`**：只暴露 `search` + `execute` 两个工具（基于 Cloudflare `@cloudflare/codemode` MIT SDK 的机制，Node VM 沙箱）。模型写代码调 `codemode.<tool>()`，**大结果在沙箱里被代码过滤，只有 return 值进上下文**——解决"调用时不多占"。真实端到端已验证：GitHub/Notion 工具能在沙箱里调用，5 万字符的上游结果被过滤成小摘要。

`docs/WHY.md`：目的与实测数据。挂载时 424 工具 ~202,924 tokens → 9 工具 ~4,782 tokens（-97.6%）；调用时靠 codemode 沙箱控制。

## 目录

| 路径 | 用途 |
|---|---|
| `docs/WHY.md` | 项目目的 + 上下文节省实测 |
| `CONTRACT.md` / `CONTRACT.vercel.md` | 本地 / Vercel 阶段接口契约 |
| `DEPLOY.md` | 部署交接文档 |
| `src/` | catalog（BM25/allow-deny）/ sanitize / upstreams / server / oauth / store / vercel-app |
| `tests/` | 单元 + 集成测试（43 项） |
| `harness/` | 假上游 MCP server |
| `scripts/` | 冒烟 / 真实 GitHub 验证 / 工具采集 / 上下文测量 |
| `data/tool-dataset.json` | 4 个上游真实工具 schema（测量依据） |
