# gemini-mcp-gateway

[English](README.md) | 简体中文

**给网页端 MCP 客户端用的 Code Mode 网关。** 把成百上千个上游 MCP 工具定义压缩成
**3 个固定工具**，并让工具调用结果不进入模型上下文。

按仓库内置目录实测：直连 4 个上游 MCP 会把 **456 个工具定义（约 217,601 tokens）**
塞进模型上下文；本网关只暴露 **3 个工具（约 1,286 tokens）**，**减少 99.4%**，
而同样的上游工具仍然可以在隔离沙箱里调用。

模型先 `search` 发现工具，再写一段 JS 调用 `execute_read`（只读）或 `execute`（读写）；
只有函数的 `return` 值进入对话。

> **状态：v0.1 alpha，单用户 / 自托管。** 已在 Gemini 网页版自定义 app 验证；
> 其他 MCP 客户端理论上可用，但尚未实测。1.0 之前接口和配置可能变化。

## 为什么

网页端 MCP 客户端会把每个已连接工具的完整定义（name、description、JSON Schema）
常驻放进 prompt。接 4 个上游就是约 21.8 万 tokens 的固定开销，挤掉对话历史、文档和推理空间。

这个网关让模型侧的工具面恒定且很小，并把编排放进沙箱：

```
Gemini / MCP 客户端
        │  Streamable HTTP + OAuth 2.1
        ▼
┌──────────────────────────────────────────────┐
│  gemini-mcp-gateway                          │
│                                              │
│  search(query, limit?)     渐进发现上游工具  │
│  execute_read(code)        只读沙箱          │
│  execute(code)             读写沙箱          │
│                                              │
│        QuickJS worker 沙箱（无 process、     │
│        无 require、无 fetch、无 Node 全局）  │
│                     │                        │
│   codemode.github__list_issues({...})        │
│   codemode.notion__notion_search({...})      │
│   codemode.linear__list_issues({...})        │
│   codemode.vercel__list_deployments({...})   │
└─────────────────────┬────────────────────────┘
                      │
        MCP over Streamable HTTP（带 token 生命周期）
                      │
      GitHub · Notion · Linear · Vercel ·（你的上游）
```

只有 `return` 值和紧凑的 `search` 结果进入模型；大的上游返回在沙箱里被过滤/聚合。

## 特性

- **3 个固定工具**：`search` / `execute_read` / `execute`，会话中途不变
  （Gemini 不消费 `notifications/tools/list_changed`）。
- **引擎级沙箱**：Vercel `run` SDK（QuickJS + worker thread），guest 无
  `process` / `require` / `fetch` / Node 全局；带逃逸回归测试。
- **渐进发现**：BM25 + 标识符感知排序、`select:<name>` 取完整 JSON Schema、
  少量中文查询同义词扩展。
- **上下文纪律**：结果投影与结构化截断、单次执行的只读去重、调用预算、
  `safeAll()` 局部失败隔离。
- **OAuth 2.1 授权服务器**：DCR、PKCE S256、state 透传、不轮换 refresh token；
  可选锁定单客户端（`ALLOWED_CLIENT_ID`）。
- **上游 token 生命周期**：内置 Notion/Linear 的刷新/轮换、CAS fencing、invalid_grant
  终态与自愈；其他 OAuth provider 配 `refreshUrl` 即走同一生命周期；GitHub/Vercel 用静态 Bearer。
- **Gemini 安全 schema**：所有注册工具过 `sanitizeTool`（array 补 items、多类型收敛、
  深 oneOf 截断）；结果用文本 JSON（不用 `structuredContent`）。
- **部署校验**：`GET /healthz` 返回构建 commit 和运行时源码哈希。
- **上游无关**：任何 Streamable HTTP / stdio MCP server，加一个配置条目即可（见 [docs/UPSTREAMS.md](docs/UPSTREAMS.md)）。
- **离线测试**：308 项单测/集成测试 + 假上游 harness，不需要网络或凭据。

## 快速开始（本地）

要求 **Node.js >= 20.19**。

```bash
git clone https://github.com/Bruce-Yii/gemini-mcp-gateway.git
cd gemini-mcp-gateway
npm ci
npm test            # 离线 308 项
npm run smoke       # 假上游 MCP server，无需凭据
node scripts/check-config.mjs  # 校验配置 + 环境变量警告
npm start           # http://localhost:3000/mcp
npm start -- --config examples/local-stdio-fake.json  # 本地 stdio 示例
```

`npm start` 使用 `config.example.json`；未设置 `tokenEnv` 环境变量的上游会被跳过，
所以可以先用 MCP Inspector 查看 3 工具面。接真实上游时需要导出下面的 token。
公开服务的现成配置条目在 [`templates/upstreams/`](templates/upstreams/README.md)。

离线测量脚本（不调用模型）：

```bash
node scripts/measure-context.mjs          # 工具面上下文占用
node scripts/eval-search.mjs              # 离线搜索召回
node scripts/write-build-info.mjs --print # 当前 commit + 运行时源码哈希
```

## 配置

加上游的完整步骤见 **[docs/UPSTREAMS.md](docs/UPSTREAMS.md)**；最小示例在 `examples/`。

配置在 `config.example.json`（复制一份，用 `GATEWAY_CONFIG` 指向它，或给 `--config`）。上游条目：

```jsonc
{
  "mode": "codemode",                 // codemode（默认）或 whitelist（历史/调试）
  "servers": [{
    "name": "github",
    "transport": "http",              // "http"（Streamable HTTP）或 "stdio"
    "url": "https://api.githubcopilot.com/mcp/",
    "tokenEnv": "GITHUB_TOKEN",       // bearer token 从这个环境变量读
    "allowTools": [],                 // 可选白名单（空 = 全量）
    "denyTools": ["get_teams"]        // 可选黑名单
  }]
}
```

支持 OAuth 的上游还可以配 `refreshEnv` / `clientIdEnv` / `expiresInEnv` /
`obtainedAtEnv`（见 `config.example.json` 里的 Notion/Linear）。

参考部署用到的环境变量：

| 变量 | 用途 |
|---|---|
| `GITHUB_TOKEN` | GitHub MCP bearer token（PAT 或 Copilot token） |
| `NOTION_TOKEN`、`NOTION_REFRESH_TOKEN`、`NOTION_CLIENT_ID`、`NOTION_EXPIRES_IN`、`NOTION_OBTAINED_AT` | Notion 上游凭据 |
| `LINEAR_TOKEN`、`LINEAR_REFRESH_TOKEN`、`LINEAR_CLIENT_ID`、`LINEAR_EXPIRES_IN`、`LINEAR_OBTAINED_AT` | Linear 上游凭据 |
| `VERCEL_TOKEN` | Vercel MCP bearer token |
| `KV_REST_API_URL`、`KV_REST_API_TOKEN` | Upstash Redis（OAuth client/token 存储） |
| `PUBLIC_BASE_URL` | 部署的公网地址（如 `https://<your-domain>`） |
| `ALLOWED_CLIENT_ID`、`ALLOWED_CLIENT_SECRET` | 锁定单个预注册 OAuth 客户端（**生产必填**） |
| `UPSTREAM_OAUTH_ADMIN_KEY` | 可选。启用 `/upstream/oauth/start`，让网关为配置了 `authorizeUrl` 的上游发起授权（见 [docs/CREDENTIALS.md](docs/CREDENTIALS.md)） |
| `GATEWAY_CONFIG`、`UPSTREAMS_JSON` | 可选的内联配置覆盖 |

**上游凭据默认自带。** PAT/API token 需要你自己申请并通过环境变量传入。只支持 OAuth 的
提供商可以选择让网关自己跑授权码流程（设置 `UPSTREAM_OAUTH_ADMIN_KEY` 并配置
`authorizeUrl`，见 [docs/CREDENTIALS.md](docs/CREDENTIALS.md)）。Notion/Linear 的
access+refresh token 可用 `scripts/seed-upstream-tokens.mjs` 写入托管 KV；其他 OAuth
上游走同一套 `refreshUrl`/`clientSecretEnv` 刷新生命周期。

## 部署

见 **[DEPLOY.md](DEPLOY.md)**：Vercel + Upstash KV 步骤、完整环境变量、安全默认值，
以及验证（`/healthz`、well-known、`/mcp` 401 + `WWW-Authenticate`）。

## 连接客户端

- **Gemini 网页版（已验证）**：Settings → Connected Apps → Custom apps → 添加
  `https://<your-domain>/mcp`。锁定模式需要填 `ALLOWED_CLIENT_ID` /
  `ALLOWED_CLIENT_SECRET`。Google 目前限制：个人账号、18+、美国、英文界面。
- **其他客户端**：兼容性矩阵见 [docs/CLIENTS.md](docs/CLIENTS.md)。支持 Streamable HTTP + 静态 `Authorization`
  或 OAuth 2.1 的客户端理论上都能连，欢迎在 issue 里反馈兼容性。

## 评测与测试

以下数字都可用内置目录离线复现：

| 指标 | 结果 |
|---|---|
| 直连 4 个上游的工具定义上下文 | 456 个工具 ≈ 217,601 tokens |
| 本网关的工具定义上下文 | 3 个工具 ≈ 1,286 tokens（**-99.4%**） |
| 离线搜索召回（191 条工具级任务，英文） | top1 **56.5%**、top5 **72.3%** |
| 离线搜索召回（19 条真实风格中文查询） | top1 **84%**、top5 **95%** |
| 离线测试 | **300** 项通过 |

```bash
npm test
node scripts/eval-search.mjs
node scripts/measure-context.mjs
node bench/run.mjs --dry-run      # 模型在环 harness 自检（不调模型）
```

这些是词面检索和 token 估算，不是端到端模型 benchmark；方法和局限见
[docs/WHY.md](docs/WHY.md)。模型在环 harness（真实 OpenAI 兼容模型 + 确定性假上游）见
[bench/README.md](bench/README.md)。

## 安全

部署前务必读 **[SECURITY.md](SECURITY.md)**。要点：这是**单用户**网关，持有真实上游凭据；
生产必须设置 `ALLOWED_CLIENT_ID`，使用最小权限上游 token，不要多人共用一个部署。
沙箱提供的是隔离，不是授权边界。

## 目录

| 路径 | 用途 |
|---|---|
| `src/` | catalog/搜索、schema 清洗、上游客户端、沙箱、OAuth、Vercel 入口 |
| `tests/` | 离线单测 + 集成测试 |
| `harness/` | 假上游 MCP server |
| `scripts/` | 冒烟、工具采集、上下文/搜索评测、build 信息 |
| `data/tool-dataset.json` | 测量用的真实工具 schema |
| `docs/` | 设计说明、上下文实测、沙箱安全、调研快照 |
| `explore/` | 可选的真实模型探索 harness（不进 CI） |

## 文档

- [docs/WHY.md](docs/WHY.md) — 问题、实测数据、外部证据
- [docs/UPSTREAMS.md](docs/UPSTREAMS.md) — 加上游：配置、鉴权模式、验证
- [docs/CREDENTIALS.md](docs/CREDENTIALS.md) — Slack/Atlassian 等上游的 token 获取
- [docs/CLIENTS.md](docs/CLIENTS.md) — 客户端兼容性矩阵
- [docs/ADOPTION-RANKINGS.md](docs/ADOPTION-RANKINGS.md) — MCP/连接器公开采用数据的整理
- [templates/upstreams/](templates/upstreams/README.md) — 已验证的现成上游配置
- [bench/README.md](bench/README.md) — 模型在环 benchmark harness
- [docs/SANDBOX-SECURITY.md](docs/SANDBOX-SECURITY.md) — 沙箱模型与局限
- [docs/CODEMODE-SURVEY.md](docs/CODEMODE-SURVEY.md) — Code Mode 横向调研
- [docs/UNNEEDED-TOOLS.md](docs/UNNEEDED-TOOLS.md) — 内置工具黑名单的依据
- [docs/GEMINI-OFFICIAL-DOCS.md](docs/GEMINI-OFFICIAL-DOCS.md) — Gemini 连接器约束
- [CONTRIBUTING.md](CONTRIBUTING.md) · [CHANGELOG.md](CHANGELOG.md) · [SECURITY.md](SECURITY.md)

## 已知限制

- 单租户设计，没有多租户凭据隔离。
- 不包含上游 OAuth 获取流程，需要自带 token。
- 只内置 4 个上游模板；加第 5 个是配置 + 文档工作，但还没做成向导。
- Gemini custom apps 有 Google 侧的地区/账号限制。
- 外层工具面刻意保持稳定；破坏性变更需要版本化路径 + 客户端重连。

## License

[MIT](LICENSE)。与 Google、Vercel、Cloudflare、GitHub、Notion、Linear 无关联。
