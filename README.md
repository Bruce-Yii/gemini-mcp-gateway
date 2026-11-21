# gemini-mcp-gateway

标准远程 MCP 网关：**核心目的是省上下文**——把 4 个上游 MCP 的 456 个工具定义（约 217,601 tokens）压成固定的 3 个 Code Mode 工具（约 1,286 tokens，省 99.4%），供 Gemini 网页版自定义连接器使用。详见 `docs/WHY.md`。

模型先 `search` 找到工具，再写一段 JS 用 `execute_read` / `execute` 在沙箱里编排上游工具；只有脚本的 `return` 值进入对话上下文。上游工具本身仍在网关内可调用（当前配置启用 191 个），只是定义不常驻上下文。

## 当前状态：已上线

- [x] catalog / sanitize / upstreams / server / codemode / oauth / store 模块
- [x] 单元 + 集成测试（286 项通过）
- [x] OAuth 2.1 DCR + PKCE + Vercel 部署，线上全链路验证通过（6 redirect URI / PKCE / state / token / MCP 握手）
- [x] 四个上游接入：GitHub / Notion / Linear / Vercel（refresh token 轮换 + 失效自愈）
- [x] Code Mode 沙箱：Vercel `run` SDK（QuickJS + worker thread）真隔离，有逃逸回归测试
- [x] 上下文节省实测（`scripts/measure-context.mjs`：217,601 → 1,286 tokens，-99.4%）
- [x] 在 Gemini 网页版实际连接并用真实任务反馈迭代（见 `docs/GEMINI-REAL-TASK-FEEDBACK.md`）
- [x] 部署校验：`GET /healthz` 返回 commit / buildHash / mode / servers；本地用 `node scripts/write-build-info.mjs --print` 对照 buildHash

线上域名：`https://gemini-mcp-gateway-yu-ac3a.vercel.app/mcp`　仓库：`https://github.com/Bruce-Yii/gemini-mcp-gateway`

### Token 注入（重要）

凭据**只走环境变量**，绝不进配置文件/git/日志。HTTP 上游用 `tokenEnv` 字段指定环境变量名，刷新参数用 `refreshEnv` / `clientIdEnv` / `expiresInEnv` / `obtainedAtEnv`：

```json
{ "name": "github", "transport": "http",
  "url": "https://api.githubcopilot.com/mcp/",
  "tokenEnv": "GITHUB_TOKEN",
  "denyTools": ["get_teams", "get_team_members"] }
```

`npm start` 前先注入 token（`setx GITHUB_TOKEN <token>` 或进程环境变量）。`scripts/verify-real-github.mjs` 演示了从 CC Switch 的 Copilot token 读取并注入环境变量（不落盘、不打印）。

## 设计

Code Mode 形态（`src/codemode.js`）：

```
Gemini → [网关 /mcp]
          ├─ search(query, limit?)                  ← 渐进发现上游工具
          ├─ execute_read(code)                     ← 只读沙箱（客户端可少弹审批）
          └─ execute(code)                          ← 读写沙箱
                 └─ 沙箱内 codemode.<server>__<tool>(args) → GitHub / Notion / Linear / Vercel
```

关键约束（含历史原因）：
- Streamable HTTP、MCP 2025-11-25；工具列表会话中不变（Gemini 不消费 `notifications/tools/list_changed`，改 schema 要换版本路径）
- schema 过 `sanitizeTool`（array 必须有 items、多类型收敛、深 oneOf 截断）
- 上游工具名用 `server__tool`（双下划线）；结果用文本 JSON（不用 `structuredContent`）
- 沙箱真隔离：QuickJS in worker thread，无 process/require/fetch/Node globals

`whitelist` 模式仍保留（`config.mode` 切换），用于本地调试与对照，不是线上形态。

## 快速开始（开发）

```powershell
cd D:\12412\dsh工作区\projects\gemini-mcp-gateway
npm install
npm test
npm run smoke     # 本地假上游冒烟
npm start         # http://localhost:3000/mcp
```

诊断脚本：

```powershell
node scripts/measure-context.mjs   # 工具面上下文占用（当前 Code Mode 口径）
node scripts/eval-search.mjs       # 离线搜索召回（生产目录 191 个工具）
node scripts/write-build-info.mjs --print  # 当前 checkout 的 commit/buildHash
```

配置见 `config.example.json`（真实凭据不进仓库）。工具裁剪现状见 `docs/UNNEEDED-TOOLS.md`。

## 目录

| 路径 | 用途 |
|---|---|
| `docs/WHY.md` | 项目目的 + 上下文节省实测 |
| `docs/GEMINI-PROBE.md` | 网页端体感探针：手动任务序列 + 提问脚本（把 Gemini 的回答贴回来即可） |
| `docs/CODEMODE-SURVEY.md` / `docs/DSH-CODEMODE-FIT.md` | Code Mode 横向调研 / DSH 本地接入调研（快照，非规范） |
| `CONTRACT.md` / `CONTRACT.vercel.md` | 历史阶段契约（whitelist / Vercel-OAuth）；Code Mode 以 `src/` + `tests/` 为准 |
| `DEPLOY.md` | 部署交接文档（whitelist 时代，待刷新） |
| `src/` | catalog / sanitize / upstreams / server / codemode / tool-format / oauth / store / vercel-app |
| `tests/` | 单元 + 集成测试（286 项） |
| `harness/` | 假上游 MCP server |
| `scripts/` | 冒烟 / 真实 GitHub 验证 / 工具采集 / 上下文与搜索评测 / build 信息 |
| `data/tool-dataset.json` | 4 个上游真实工具 schema（456 个，测量依据） |
