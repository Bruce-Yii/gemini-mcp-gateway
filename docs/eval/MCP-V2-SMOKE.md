# `/mcp/v2` 本地 live smoke（2026-11-23）

> 范围：对**已实现**的 `/mcp/v2` 做一次本地、进程内、真实 HTTP socket 的冒烟；
> 不改生产默认行为，不做 A/B 切换，不把 v2 设为默认。
> 本次只新增 `scripts/mcp-v2-smoke.mjs`、`tests/mcp-v2-smoke.test.js` 与本文件；
> 未改 `src/`、其他 scripts/tests/README/workflows；未 commit / push / deploy。

## 一、什么叫 "live"，什么叫"不联网"

- **live**：直接 import `src/` 里的 `createMcpRequestHandler` / `createAppHandler`，
  经真实的 Node `http.Server`（`127.0.0.1` + OS 分配的 ephemeral 端口）和真实
  Streamable HTTP 传输收发 JSON-RPC；不是只调用 handler 函数、也不是比较常量。
- **不联网**：upstream manager、typed-plan IO 适配器、token store 全是脚本内的
  fake；不读配置、不连真实 MCP server、不读 vault、不写文件。所有 URL 强制
  loopback（`runSmoke()` 对非 loopback `baseUrl` 直接 throw）。
- **不改默认行为**：`ENABLE_MCP_V2` 只以 `env` 选项注入 handler（`{ENABLE_MCP_V2:'1'}`
  / `'0'`），**从不写 `process.env`**；flag-off 用第二个 handler 实例验证。

## 二、运行方式

```powershell
# 只跑脚本（stdout 是纯 JSON，stderr 是 [req]/[capture_*] 日志）
node scripts/mcp-v2-smoke.mjs
# PowerShell 下只要 JSON：
node scripts/mcp-v2-smoke.mjs 2>$null | ConvertFrom-Json

# 只跑本套测试
node --test tests/mcp-v2-smoke.test.js

# 全量
npm test
```

**退出码**：所有 check 通过 → `0`；任一 check 失败 → `1`（并打印 JSON，
失败项 `detail.error` 写明实际值与期望，不做静默 skip）。
**输出契约**：`{ "ok": boolean, "checks": [ { "name", "ok", "detail" } ] }`。

库用法（测试即如此，可注入 fetch / 已有 loopback 端口）：

```js
import { runSmoke, startSmokeServer } from './scripts/mcp-v2-smoke.mjs';
const report = await runSmoke();                       // 自己起 server
const s = await startSmokeServer();                    // 或复用已有端口
try {
  const r = await runSmoke({ fetchImpl: myFetch, baseUrl: s.baseUrl });
} finally { await s.close(); }
```

## 三、九项检查与证据

| # | check 名 | 验证内容 | 关键证据 |
|---|---|---|---|
| 1 | `v1_tools_shape_unchanged` | flag on 时 `/mcp` 三工具 name/顺序/schema/annotations 与进程内 v1 factory 基线逐字相同；无 `plan` 字段 | names `search,execute_read,execute`；schemaHash `8c3def8f…` |
| 2 | `v2_tools_shape` | `/mcp/v2` 同名同序三工具；`execute_read` 仅 `plan`（required `[plan]`，无 `code`）；`execute` 同时有 `plan`/`code`，`oneOf` 恰 2 支；所有 array 有 `items` | names 同上；schemaHash `04ad1349…` |
| 3 | `v2_plan_simple_success` | 简单 read plan 在 fake IO 上真实执行 | steps `["readFileRange"]`，`meta.protocolVersion=v2`，fake IO 恰 1 次调用 |
| 4 | `v2_readonly_rejects_write` | `execute_read` 夹带写 op 被服务端拒（先读后写也不执行） | `ok:false`，steps `0`，错误含 `not allowed in read-only mode`，fake IO 调用数不变 |
| 5 | `v2_write_requires_approve` | `execute` 写 op 无 `approve`/`dryRun` 被拒 | `ok:false`，steps `0`，错误含 `requires dryRun or explicit approve`，未触达 `writeFile` |
| 6 | `v1_rejects_plan` | v1 `execute` 不接受 `plan`：按无 code 处理，不执行 typed plan | 结果无 steps/plan meta，fake IO 调用数不变（实测结果 `{}`） |
| 7 | `v2_requires_plan_or_code` | v2 输入边界：都缺 `E-VAL-NONE`，`execute_read` 缺 plan 报 `plan is required`，两者都给 `E-VAL-BOTH` | 三条错误串原样记录 |
| 8 | `flag_off_v2_404` | flag `'0'` 时 `/mcp/v2` 404，v1 仍 200 且工具表不变 | `v2Status:404`, `v1Status:200` |
| 9 | `v2_auth_401_challenge` | 经真实 `createAppHandler`：无 bearer → 401 + `WWW-Authenticate` + `_meta["mcp/www_authenticate"]` 恰 1 条且含 `resource_metadata/error/error_description`；带 fake token → 200 | `metaChallengeCount:1`, `authenticatedV2Status:200` |

脚本在端口上挂载三类逻辑路由（仅为注入 fake，无路由逻辑改动）：
`/mcp`、`/mcp/v2` → flag-on handler；`/off/*` → 把 URL 改写回 `/mcp|/mcp/v2`
后交给 flag-off handler；`/auth/*` → 改写后交给 `createAppHandler`（401 检查）。

## 四、与 `tests/typed-plan-v2-route.test.js`（typed-plan-v2-route）的差异

| 维度 | `typed-plan-v2-route.test.js`（既有 20 项） | 本套 smoke（脚本 + 3 项测试） |
|---|---|---|
| 目的 | 单元/集成回归：覆盖 flag 语义、schema 细节（sanitize 幂等、oneOf≤8、op enum 长度）、dryRun preview、显式 approve 真写、code fallback、discovery `_meta`、Vercel 路由分派等 20 个细粒度断言 | 端到端冒烟：一次真实 HTTP 往返验证"v1 没变 / v2 三工具与输入契约 / plan 成功与三道拒绝 / flag-off 404 / 401 challenge"，产出可归档的 JSON 证据 |
| 层次 | 多数直接调用 `createCodeModeToolsV2(...).handler()`；HTTP 部分只做 `tools/list` + SDK client `listTools()` | 全部通过 loopback socket 的 JSON-RPC `tools/list` 与 `tools/call`，覆盖真实序列化（`text` JSON）与服务端校验路径 |
| v1 比对方式 | 断言 v1 schema 字面量（如 `required:['code']`） | 与**进程内 v1 factory 产出的 schema 全文**逐字比对（含 description/annotations），并给出 schema hash |
| 失败可见性 | `node --test` 的 TAP 断言失败 | `{ok:false, checks[]}` JSON + 非零退出码；测试还故意注入 sabotaged fetch，证明失败项可被命名且带 `detail.error` |
| 复用关系 | 独立实现自己的 fake | 测试直接调用脚本导出的 `runSmoke()`/`startSmokeServer()`，避免两套断言漂移；不复制 src 实现 |
| 并发安全 | 自带 in-process server | 每次 `runSmoke()` 独占 ephemeral 端口，`npm test` 并发全量运行无端口冲突 |

本套**不重复** route 测试的 dryRun preview、显式 approve 真写、code fallback、
`/mcp/v3`、discovery `_meta.gateway` 等断言——那些仍由原测试负责。

## 五、未覆盖项（明确记录，不伪造结论）

- **真实 Gemini / ChatGPT / Claude 客户端**：未验证任何宿主实际挂载 `/mcp/v2`、
  工具缓存刷新、OAuth `resource` audience（设计稿方案 A/B）的真实行为；本套只测网关侧 wire。
- **真实上游与真实 credentials**：无 GitHub / Notion 等真实调用，无 token，无 vault 读取。
- **生产默认路径**：未改默认配置、未切换 A/B、未发版；flag-off 仅验证 404 与 v1 不变。
- **OAuth 完整握手**：只验证 401 challenge 与 fake token 放行；`/oauth/*`、`/upstream/oauth/*`、
  DCR/PKCE、refresh 等不在范围内（由 `tests/oauth*` 等既有套件覆盖）。
- **写操作真实副作用**：只验证"未 approve 被拒"及 zero-side-effect；approve 后真写、
  dryRun preview 由 `typed-plan-v2-route.test.js` / `typed-plan` 单测覆盖。
- **capture envelope**：本地默认 `CAPTURE_MODE` 关闭，日志显示 `capture_disabled`；
  本套不声称 capture 落盘正确（另有 capture 套件覆盖）。
- **并发/负载、超时、SSE GET 流**：不做压测，不测多客户端并发 session 行为。

## 六、验收记录

- `node scripts/mcp-v2-smoke.mjs` → `ok:true`，9/9 checks，exit 0。
- `node --test tests/mcp-v2-smoke.test.js` → 3/3 pass，0 fail。
- `npm test` 全量（并发）：tests 1224 / pass 1216 / fail 2 / todo 6；
  本文件 3 项在两次全量运行中均为 pass。**2 个失败位于
  `tests/capture-queue-integration.test.js`（`Cannot read properties of null
  (reading 'snapshot')`），属另一并发热更新的 capture 队列工作，与本套无 import
  关系、不在本轮改动范围，不计入本套结论。**
  全程离线，无真实凭据、无文件写入、未 commit。
