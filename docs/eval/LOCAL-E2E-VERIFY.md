# 本地最新代码端到端验证（HTTP loopback + fake upstream）

> 状态：**代码 + 测试完成，未 commit / push / deploy**。
> 只新增 `scripts/local-e2e-verify.mjs`、`tests/local-e2e-verify.test.js`、本文与
> `docs/ledger/batch-15-local-e2e.md`。未改 `src/`、其他 `scripts/` / `tests/`、
> README、workflows、config、任何契约文档。
>
> **重要边界**：本验证只证明**本地最新源码**在真实路由上生效。生产 Vercel 当前
> 仍跑旧构建（见根 `AGENTS.md` §0）；本验证**不能**、也不试图证明"线上已修好"。

---

## 0. 目的与结论

单元测试钉住单个纯函数；本 harness 回答一个更窄但关键的问题：
**"已入库的修复，在本地最新代码的真实 HTTP 路由上是否真的生效？"**

做法：把真实的 `createAppHandler`（`src/vercel-app.js`）和真实的
`createMcpRequestHandler`（`src/server.js`）挂在一个真实 Node `http` 服务器上，
绑定 `127.0.0.1` + 随机 ephemeral 端口，用真实 `fetch` 和 MCP SDK 的
`StreamableHTTPClientTransport` 发真实请求。**只 fake 最外两层边界**：

- **fake token store**：内存 `Map`，实现 `saveToken`/`getToken`/`saveClient`/`getClient`。
  不访问 KV / vault / 磁盘。预置一个字面量 `FAKE-LOCAL-E2E-TOKEN`。
- **fake upstream manager**：进程内确定性工具（`getEntries`/`getWhitelist`/`callTool`），
  不启动 stdio 子进程、不发网络请求、不读真实凭据。typed-plan 的 IO adapter
  同样是内存 fake（`fakeTypedPlanIO`）。

其余全部是真实本地代码：路由分发、OAuth metadata、CIMD 文档、401 challenge、
capture 边缘、MCP `initialize`/`tools/list`/`tools/call`、三工具 Code Mode 面、
`sandbox`、结果归一化、v2 flag 判定。

### 运行方式

```text
node scripts/local-e2e-verify.mjs           # stdout 只有 {ok, checks[]} JSON；全绿退出码 0，任一失败 1
node --test tests/local-e2e-verify.test.js
npm test                                    # 全量绿
```

CLI 报例子：

```json
{
  "ok": true,
  "checks": [
    { "name": "healthz-200", "ok": true, "detail": "200, ok:true, fake server listed, buildHash present" }
  ]
}
```

失败时对应 check 为 `{ name, ok:false, error }`，进程退出码 1。
`runLocalE2E({ failCheck })` 可注入失败，测试用它验证失败不会被吞掉。

---

## 1. 覆盖的 check（11 项）

| check 名 | 验证内容 | 真实链路 |
| --- | --- | --- |
| `healthz-200` | `GET /healthz` 200、`ok:true`、配置加载、fake server 名、`buildHash` 存在 | 真实 `createAppHandler` 路由 |
| `oauth-metadata` | `/.well-known/oauth-authorization-server` 200 + 必需字段 + PKCE S256；`/.well-known/oauth-protected-resource` 200、`resource` 以 `/mcp` 结尾 | 真实 `createOAuthHandlers` |
| `cimd-document` | `GET /.well-known/mcp-client.json` 200 公开可访问；`client_id` = 文档 URL；无 `client_secret`；S256 | 真实 `buildCimdDocument` + app 路由 |
| `mcp-401-challenge` | 无 token / 错 token 的 `POST /mcp` 返回 401；`WWW-Authenticate` 带 `resource_metadata`；body 带 `_meta["mcp/www_authenticate"]` 数组 | 真实 app 401 分支 |
| `mcp-three-tools` | 真实 MCP client `tools/list` → `['search','execute_read','execute']` 固定顺序；每个 schema 为 object | 真实 `createMcpRequestHandler` + SDK |
| `file-content-pure-body` | `execute_read` 内 `codemode.fileResult()` 的 `content` 是纯正文，download notice 不混入；`sha` 在元数据、`notice`/`noticeSha` 经 `fileMeta()` 可见 | 真实 Code Mode sandbox + `result-normalize` |
| `pr-number-url-first` | `execute` 内 `codemode.prResult()` 从 `html_url` 的 `/pulls/53` 取 `number=53`，数据库 `id`/`nodeId` 独立字段，不用 id 兜底 | 真实 sandbox + `github-helpers` |
| `wait-for-pr-checks-helper` | `codemode.waitForPrChecks` 在 sandbox 内可见（`typeof === 'function'`）；fake `pull_request_read` 永远 pending → `maxPolls=2` 后 `ok:false`、`timedOut:true`、`polls=2` | 真实 sandbox helper + 上游工具桥 |
| `run-typed-plan-helper` | `execute` 内 `codemode.runTypedPlan(plan,{dryRun:true})` 返回稳定 `ok:true` envelope，步骤命中 fake IO adapter | 真实 typed-plan 引擎 + host bridge |
| `v2-flag-off-404` | `ENABLE_MCP_V2` 未设为 `1` 时 `POST /mcp/v2` 为 404，且**不**降级到 v1 | 真实 flag 判定（app + server 双层） |
| `v2-flag-on-three-tools` | `ENABLE_MCP_V2=1` 时 `POST /mcp/v2` 可用，仍是同名同序三工具，`execute` schema 含 `plan` 入参 | 真实 v2 工具工厂 + flag |

所有 check 都通过真实 HTTP 字节流完成，而不是直接调用处理器函数。

---

## 2. 为什么"不联网、不泄密"

1. loopback server 只绑定 `127.0.0.1` 与随机端口；所有请求 URL 都是
   `http://127.0.0.1:<ephemeral>`，没有任何外网地址。
2. fake upstream 的 `callTool` 对未知工具返回 `{ok:false,error}`，不转发、不 fallback；
   没有 stdio 子进程、没有 MCP client 连到外部服务。
3. token 是字面量 `FAKE-LOCAL-E2E-TOKEN`，store 是内存 Map；没有 `TokenStore` 实例、
   不读 KV 环境变量、不读 vault、不写磁盘、不 commit/push/deploy。
4. 报告字段只有 `name` / `ok` / `detail` / `error`，不含任何凭据形态的值。
5. `cimdBaseUrl`/`baseUrl` 使用 `https://gw.local.test` 仅用于满足 CIMD 的 https
   文档约束；它不是真实域名，不会被任何代码路径 fetch。

---

## 3. 覆盖 / 未覆盖

### 已覆盖

- 上面 11 项 check 列出的真实路由行为。
- v2 flag 的开/关两种状态（同一 harness 起两个 gateway 实例）。
- 文件正文 notice 剥离在**真实 MCP 工具调用**路径上生效（不是仅纯函数单测）。
- PR number URL 优先、CI 等待 helper 超时、typed-plan helper 在**真实 sandbox** 内可用。

### 未覆盖（刻意不做）

- **真实 KV / vault / Upstash**：store 是内存 fake；token 生命周期、refresh 轮换、
  CAS fencing 由 `tests/upstream-auth*.test.js` 等专门测试覆盖。
- **真实 provider（GitHub / Notion / Vercel）**：fake upstream 不连外网；
  `scripts/verify-real-github.mjs` 才连真实 GitHub（需 token，本 harness 不调）。
- **真实 OAuth 授权码流程 / DCR / CIMD 抓取**：由
  `scripts/auth-e2e-harness.mjs`（fake provider）与部署后人工核对覆盖。
- **真实 Vercel serverless 环境**：`VERCEL_ENV`、冷启动、60s timeout、平台注入的
  `window.__DSH_BOOT__` 等不在本地复现。
- **capture sink 落盘**：默认 `CAPTURE_MODE` 关闭，日志显示 `[capture_skipped]`；
  本 harness 不验证 capture envelope 内容（另有 capture-* 测试覆盖）。
- **ChatGPT / Claude profile 分支**：本 harness 走默认 Gemini profile；
  profile 隔离由 `tests/client-profile.test.js` 覆盖。
- **部署一致性**：不比对 `healthz.buildHash` 与任何线上构建；这是部署后复验的事。

---

## 4. 与真实部署的差异（重要，别把本地绿当线上绿）

| 维度 | 本 harness | 真实 Vercel 部署 |
| --- | --- | --- |
| 代码版本 | 最新本地 `src/`（含未部署修复） | 当前是旧构建，见根 `AGENTS.md` §0 |
| 端口 / 绑定 | `127.0.0.1:<ephemeral>`，进程内 | Vercel edge，公网 HTTPS 域名 |
| token store | 内存 Map | Upstash Redis REST（真实 KV） |
| upstream | 进程内 fake 工具 | 真实 MCP upstream（stdio / HTTP + OAuth） |
| 凭据 | 字面量 fake token | vault 读取的真实 grant（不进仓库/日志） |
| CIMD URL | `https://gw.local.test`（不可达，仅满足文档格式） | 真实公网 `https://<domain>/.well-known/mcp-client.json`，AS 会真的抓取 |
| OAuth flow | 只验 metadata + 401 challenge，不跑 authorize/token | 完整 DCR/PKCE/CIMD + callback，受 provider 状态影响 |
| capture | `CAPTURE_MODE` 关闭，`[capture_skipped]` | 依部署配置可能开启，sink 行为不同 |
| 平台约束 | 无冷启动 / timeout / 多实例 | serverless per-request transport，stateless 设计 |

**结论口径**：本 harness 绿 = "本地最新代码的真实路由链可用"；**不是**"线上已修好"。
部署窗口恢复后仍需按 `docs/EVALUATION.md` 的流程做 `healthz` buildHash 对齐 +
tools/list + 在线同任务复验。
