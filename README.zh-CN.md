# gemini-mcp-gateway

[English](README.md) | 简体中文

**面向网页版 AI 客户端、持续优化的上下文与工具调用层。** 直连 5 个上游 MCP 会把
**506 个工具定义（约 245,377 tokens）**塞进模型上下文；本网关只暴露 **3 个稳定工具
（约 1,520 tokens）**，**减少 99.4%**，同样的上游工具仍在隔离沙箱里可调用。

这不只是聚合。模型先用 `search` 渐进发现工具（BM25 排序、紧凑签名，`select:<name>`
按需取完整 schema），再在 QuickJS 沙箱里编排调用，并做读写分离：`execute_read`
只读、`execute` 读写。**只有沙箱的返回值进入对话**，上游原始 payload 留在上下文之外；
结果会被规范化成 canonical 的文件/PR/Issue 形状、带行区间，并用显式标记截断，而不是静默截断。

这里的优化是**持续评测闭环，不是一次性 benchmark**：全量 `capture` → `digest` →
analyzer（只产出待验证假设）→ L1 冒烟 / G6 scorecard → 回归测试。每次改动都对照真实
session 和固定任务集验证，见 [docs/OBSERVABILITY-AND-EVAL.md](docs/OBSERVABILITY-AND-EVAL.md)。

> **状态：v0.1 alpha，单持有者 / 自托管。** 一个人的上游放进一个网关；
> 不提供也不承诺多租户凭据隔离。已在 Gemini 网页版自定义 app 实测；其他客户端是目标，
> 不是已验证的承诺。1.0 之前接口和配置可能变化。

## 为什么

网页端 MCP 客户端会把每个已连接工具的完整定义（name、description、JSON Schema）
常驻放进 prompt，多个上游就是一笔巨大的固定开销，挤掉对话历史、文档和推理空间。
多数网关让工具「可达」；这个网关让工具**易于发现、安全执行、可持续度量改进**。

```
Gemini / MCP 客户端
        │  Streamable HTTP + OAuth 2.1
        ▼
┌──────────────────────────────────────────────┐
│  gemini-mcp-gateway                           │
│                                               │
│  search(query, limit?)     渐进发现上游工具  │
│  execute_read(code)        只读沙箱          │
│  execute(code)             读写沙箱          │
│                                               │
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

只有 `return` 值和紧凑的 `search` 结果进入模型；上游大 payload 在沙箱内被过滤、
规范化与聚合。

## 我们优化什么

| 层 | 做法 |
|---|---|
| **工具定义上下文** | 506 个 schema（约 245,377 tokens）→ 3 个稳定工具（约 1,520 tokens），-99.4%；工具面会话中途不变（Gemini 不消费 `notifications/tools/list_changed`）。 |
| **渐进发现** | BM25 + 标识符感知排序、紧凑签名、`select:<name>` 按需取完整 JSON Schema、少量中文查询同义词。 |
| **结果上下文** | 只有沙箱返回值进入上下文；canonical 文件/PR/Issue 形状、行区间、结构化截断标记。 |
| **读写分离** | `execute_read` 把写工具替换成会抛错的 stub；`execute` 才允许写。带读写标注和单次执行调用预算。 |
| **调用正确性** | `server__tool` 命名、所有 schema 过 `sanitizeTool`、扁平参数、固定工具顺序、文本 JSON 结果（不用 `structuredContent`）。 |
| **持续评测** | 全量 capture → digest → analyzer（仅建议）→ L1/G6 → 回归；模型建议只是假设，不能直接改代码，见 [AGENTS.md](AGENTS.md)。 |
| **隔离** | Vercel `run` SDK 的 worker 线程 QuickJS；无 `process`/`require`/`fetch`/Node 全局，带逃逸回归测试。 |

上游通过一行配置接入，支持 Streamable HTTP 或 stdio（见 [docs/UPSTREAMS.md](docs/UPSTREAMS.md)）。
OAuth 2.1 DCR + PKCE S256、上游 token 刷新/轮换、`GET /healthz` 部署校验都是配套能力，
不是主线卖点。

## 客户端

| 客户端 | 状态 |
|---|---|
| **Gemini 网页版自定义 app** | **已实测。** Settings → Connected Apps → Custom apps → 添加 `https://<your-domain>/mcp`。锁定模式需填 `ALLOWED_CLIENT_ID` / `ALLOWED_CLIENT_SECRET`。Google 目前限制：个人账号、18+、美国、英文界面。 |
| **Claude.ai 自定义连接器** | **目标**——适配器工作量小（显式 `readOnlyHint`/`destructiveHint`、结果大小限制），这里尚未端到端验证。 |
| **MCP Inspector / 本地 stdio + HTTP** | **可复现目标**：任何兼容性声明前先用它检查工具面和冒烟。 |
| **ChatGPT Business / Enterprise / Edu** | **有文档、未承诺。** 完整 MCP 受套餐限制，Pro 仅 read/fetch，schema token 上限无官方文档；结果编码/安全标注适配尚未做，不要假定可用。 |
| **其他网页客户端 / 个人套餐 / 移动端** | **不承诺。** 调研与注意事项见 [docs/OPEN-SOURCE/WEB-CLIENTS.md](docs/OPEN-SOURCE/WEB-CLIENTS.md) 和 [docs/CLIENTS.md](docs/CLIENTS.md)。 |

## 为什么又做一个 Code Mode 网关

Code Mode 和工具检索网关已不新鲜：Cloudflare Code Mode/Portals、Limen、
Limen 式的 `dev-mcp`、toolgate、IBM 的 `mcp-context-forge` 等都在压缩工具面或检索工具。
本项目**不是唯一的上下文优化方案**，聚合只是副产物，不是产品本身。

我们的位置是这几条的交集：**网页客户端交付 + Code Mode 编排 + 读写隔离 +
规范化结果上下文 + 全量评测闭环**，自托管、面向单持有者。宿主原生工具搜索
（Anthropic、OpenAI、MCP Groups）是长期观察项，我们不声称替代或永久胜过它。
简短对比与威胁模型见 [docs/OPEN-SOURCE/DIFFERENTIATION.md](docs/OPEN-SOURCE/DIFFERENTIATION.md)
和 [docs/OPEN-SOURCE/COMPETITORS.md](docs/OPEN-SOURCE/COMPETITORS.md) §0.2；
这里刻意不维护「聚合网关功能长表」。

## 不做什么

- 多租户 / RBAC / 组织级控制面——**单持有者设计**。
- 企业策略网关或通用 LLM 路由。
- 「所有 MCP 客户端都验证过」——兼容性声明保持窄且有证据。
- 不是 Docker-first 平台：提供单容器 Docker 自托管路径，但参考部署仍是 Vercel。

## 快速开始（本地）

要求 **Node.js >= 20.19**。

```bash
git clone https://github.com/example-org/codemode-mcp-gateway.git
cd codemode-mcp-gateway
npm ci
npm test            # 离线测试套件
npm run smoke       # 假上游 MCP server，无需凭据
node scripts/check-config.mjs  # 校验配置 + 环境变量警告
npm start           # http://localhost:3000/mcp
npm start -- --config examples/local-stdio-fake.json  # 本地 stdio 示例
```

`npm start` 使用 `config.example.json`；未设置 `tokenEnv` 的上游会被跳过，
可以先在 MCP Inspector 里看 3 工具面。接真实上游时需导出下面的 token。
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
`obtainedAtEnv`，内置 Notion/Linear 之外的 provider 再配 `refreshUrl`（token 端点）。
见 `config.example.json`。

参考部署用到的环境变量：

| 变量 | 用途 |
|---|---|
| `GITHUB_TOKEN` | GitHub MCP bearer token（PAT 或 Copilot token） |
| `NOTION_TOKEN`、`NOTION_REFRESH_TOKEN`、`NOTION_CLIENT_ID`、`NOTION_EXPIRES_IN`、`NOTION_OBTAINED_AT` | Notion 上游凭据 |
| `LINEAR_TOKEN`、`LINEAR_REFRESH_TOKEN`、`LINEAR_CLIENT_ID`、`LINEAR_EXPIRES_IN`、`LINEAR_OBTAINED_AT` | Linear 上游凭据 |
| `VERCEL_TOKEN` | Vercel MCP bearer token |
| `FIGMA_ACCESS_TOKEN`、`FIGMA_REFRESH_TOKEN`、`FIGMA_CLIENT_ID`、`FIGMA_CLIENT_SECRET`、`FIGMA_EXPIRES_IN`、`FIGMA_OBTAINED_AT` | Figma 官方 MCP（社区 OAuth 绕过方案，Figma 不支持；见 [docs/CREDENTIALS.md](docs/CREDENTIALS.md)） |
| `KV_REST_API_URL`、`KV_REST_API_TOKEN` | Upstash Redis（OAuth client/token 存储） |
| `PUBLIC_BASE_URL` | 部署的公网地址（如 `https://<your-domain>`） |
| `ALLOWED_CLIENT_ID`、`ALLOWED_CLIENT_SECRET` | 锁定单个预注册 OAuth 客户端（**生产必填**） |
| `UPSTREAM_OAUTH_ADMIN_KEY` | 可选。启用 `/upstream/oauth/start`，让网关为配置了 `authorizeUrl` 的上游发起授权（见 [docs/CREDENTIALS.md](docs/CREDENTIALS.md)） |
| `GATEWAY_CONFIG`、`UPSTREAMS_JSON` | 可选的内联配置覆盖 |
| `CAPTURE_MODE` | 可选全量 capture：`off`（默认）/`full`/`meta`；见 [docs/OBSERVABILITY-AND-EVAL.md](docs/OBSERVABILITY-AND-EVAL.md) |
| `CAPTURE_SINK` | `file`（本地）/`http`（collector）/`console`（仅 debug） |
| `CAPTURE_FILE_DIR` | 文件 sink 目录（默认 `work/capture`） |
| `CAPTURE_HTTP_URL`、`CAPTURE_HTTP_TOKEN` | HTTP collector 地址 + bearer token |
| `R2_ACCOUNT_ID`、`R2_BUCKET`、`R2_PREFIX` | Cloudflare R2 capture 目标（默认前缀 `capture`） |
| `R2_AUTH_EMAIL`、`R2_AUTH_KEY` | Cloudflare 全局 API key 鉴权（密钥；以后优先用 scoped token） |
| `R2_API_TOKEN` | 可选 scoped Cloudflare API token，优先于 email/key |
| `CAPTURE_MAX_BYTES` | 单响应原文上限（默认 32 MiB） |

**上游凭据默认自带。** PAT/API token 需要你自己申请并通过环境变量传入。只支持 OAuth 的
提供商可以选择让网关自己跑授权码流程（设置 `UPSTREAM_OAUTH_ADMIN_KEY` 并配置
`authorizeUrl`，见 [docs/CREDENTIALS.md](docs/CREDENTIALS.md)）。Notion/Linear 的
access+refresh token 可用 `scripts/seed-upstream-tokens.mjs` 写入托管 KV；其他 OAuth
上游走同一套 `refreshUrl`/`clientSecretEnv` 刷新生命周期。

## 部署

见 **[DEPLOY.md](DEPLOY.md)**：Vercel + Upstash KV 步骤、完整环境变量、安全默认值，
以及验证（`/healthz`、well-known、`/mcp` 401 + `WWW-Authenticate`）。
单容器本地部署见 **[docs/OPEN-SOURCE/DOCKER.md](docs/OPEN-SOURCE/DOCKER.md)**：
`docker compose up --build`，CLI 必须加 `--host 0.0.0.0`（默认只绑 loopback）；
`/healthz` 只在 Vercel 入口存在，容器用 TCP healthcheck。

## 评测与测试

以下用内置目录离线复现（不调用模型、不需要凭据）：

| 指标 | 结果 |
|---|---|
| 直连 5 个上游的工具定义上下文 | 506 个工具 ≈ 245,377 tokens |
| 本网关的工具定义上下文 | 3 个工具 ≈ 1,520 tokens（**-99.4%**） |
| 离线搜索召回 | top1 **56.5%**、top5 **72.3%**（英文、工具级任务）；中文查询经同义词层改善 |
| 离线测试套件 | `npm test`：单测 + 集成测试 + 假上游 harness，不需要网络或凭据 |

```bash
npm test
node scripts/eval-search.mjs
node scripts/measure-context.mjs
node bench/run.mjs --dry-run      # 模型在环 harness 自检（不调模型）
```

这些是词面检索和 token 估算，不是端到端模型 benchmark；方法和局限见
[docs/WHY.md](docs/WHY.md)。持续闭环（capture → digest → analyzer → L1/G6）见
[docs/OBSERVABILITY-AND-EVAL.md](docs/OBSERVABILITY-AND-EVAL.md)；analyzer 输出只是假设，
必须回到 `requestId` 并在本地复现后才能改代码（[AGENTS.md](AGENTS.md)）。
模型在环 harness（真实 OpenAI 兼容模型 + 确定性假上游）见 [bench/README.md](bench/README.md)。

## 安全

部署前务必读 **[SECURITY.md](SECURITY.md)**。要点：这是**单持有者 / 自托管**网关，
持有真实上游凭据；生产必须设置 `ALLOWED_CLIENT_ID`，使用最小权限上游 token，
不要多人共用一个部署——没有多租户隔离。沙箱提供的是隔离，不是授权边界。

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
- [docs/OPEN-SOURCE/DIFFERENTIATION.md](docs/OPEN-SOURCE/DIFFERENTIATION.md) — 定位：持续优化上下文与工具调用
- [docs/OPEN-SOURCE/COMPETITORS.md](docs/OPEN-SOURCE/COMPETITORS.md) — 竞品调研，§0.2 威胁模型
- [docs/OPEN-SOURCE/WEB-CLIENTS.md](docs/OPEN-SOURCE/WEB-CLIENTS.md) — 网页客户端适配调研
- [docs/UPSTREAMS.md](docs/UPSTREAMS.md) — 加上游：配置、鉴权模式、验证
- [docs/WORKFLOW.md](docs/WORKFLOW.md) — 上游接入与质量门控（B1–B4 工作流）
- [docs/OBSERVABILITY-AND-EVAL.md](docs/OBSERVABILITY-AND-EVAL.md) — 零影响 telemetry + 评测闭环设计
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

- 单持有者 / 自托管设计，没有多租户凭据隔离。
- 不包含上游 OAuth 获取流程，需要自带 token。
- 只内置少量上游模板；加新上游是配置 + 文档工作，还没做成向导。
- Gemini custom apps 有 Google 侧的地区/账号限制。
- 外层工具面刻意保持稳定；破坏性变更需要版本化路径 + 客户端重连。
- Docker 支持单容器自托管；Cloudflare Workers 未交付。Claude.ai 与 ChatGPT 连接器是目标/有文档，不是已验证的承诺。

## License

[MIT](LICENSE)。与 Google、Vercel、Cloudflare、GitHub、Notion、Linear 无关联。
