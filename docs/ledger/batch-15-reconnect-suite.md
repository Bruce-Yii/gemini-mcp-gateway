# B15 · 重连/发版后工具消失——网关可观测测试套件（2026-11-23）

> 范围（本批只写所列文件，全部为**新增**）：
> - `tests/reconnect-server.test.js`（新增）：9 项确定性回归；
> - `scripts/reconnect-probe.mjs`（新增）：离线/fake + 可注入 fetch 的证据探针；
> - `docs/eval/RECONNECT-TESTS.md`（新增）：可观测边界 + 本地/线上复现步骤；
> - 本台账 `docs/ledger/batch-15-reconnect-suite.md`（新增）。
>
> **未改** `src/`、其它 `scripts/`、`tests/`、`README`、契约文档、workflows。
> **未 commit / push / deploy**；未联网（仅 loopback / in-process）、未触真实凭据、未开 issue。
> 遵守 `AGENTS.md`：线上反馈只是待验证假设，本批只做可复现的网关侧观测，不对
> Google 内部行为下结论。

---

## 一、输入与判断

- 背景：线上反馈发版/重启后长会话报 `unknown_tool` / `not-found`，用户手动 `@` 恢复；
  客户端宿主摘工具不在网关控制范围（详见 `docs/ledger/batch-11-reconnect.md`）。
- Batch 11 决策保持不变：**不**做 stateful session / 404 重连信号 / SSE `list_changed`
  / Skew Protection；**不**承诺自动重连；唯一已验证恢复动作是用户手动重挂载。
- 本批任务边界：**只测网关可观测部分**，把"客户端内部 unknown_tool 分类"明确记为
  `unknown`，不伪造指标、不造恢复事件。

## 二、改动逐项

| 文件 | 内容 | 约束 |
|---|---|---|
| `tests/reconnect-server.test.js` | 9 项：新 session 稳定（2）、stale session 无半截表（1）、HTTP 方法语义（2）、三次快照一致（1）、401 challenge（1）、unknown 工具诚实记账（2） | 用 `createMcpRequestHandler` / `createGatewayServer` / `createAppHandler`；loopback 仅 127.0.0.1；无外网 |
| `scripts/reconnect-probe.mjs` | 导出 `startProbeServer()` / `runProbe({ fetchImpl, baseUrl })` / `assertLoopbackUrl()`；CLI 输出 JSON，`ok` 汇总 | fake 上游内建；`--base-url` 仅 loopback；外域 URL 直接拒绝；不写文件、不改 src |
| `docs/eval/RECONNECT-TESTS.md` | 六项断言口径、离线复现命令、线上观测步骤、边界与禁止事项 | 明确 "200 完整表" 为实测事实，不是 404；unknown 记 unknown |

## 三、测试结果（只报告本批文件，不替并发改动背书）

### 新增测试

`node --test tests/reconnect-server.test.js` → **9 tests, 9 pass, 0 fail**。

覆盖清单：

1. `initialize` 200 + UUID session 头，新 session `tools/list` 完整 4 工具；
2. 两个独立 handler 实例（模拟重启）快照完全一致；
3. stale/非 UUID/空白 session：状态 ∈ {200,400,404}，实测 200 且完整表、无半截表、
   无网关侧 `unknown_tool`；带旧 session 的在册工具仍可用；
4. GET 405 + `Allow: POST, DELETE`、DELETE 204、PUT 405、非 `/mcp` 404；
5. POST 不带 session 合法且不新发头；initialize 带头不被覆盖；无 body → 400/415；
6. 三次 `tools/list` 的 name/顺序/sha256 schema hash 全等；
7. 无 bearer / 非法 bearer → 401 + `WWW-Authenticate` 头 + `_meta['mcp/www_authenticate']` 一条 challenge；
8. 未知工具名 → `isError:true` + 原样回显 `unknown tool: <name>`；在册工具对照成功；
9. 不可观测的客户端分类/自动恢复均记为 `unknown`（文档即测试）。

### 离线探针

`node scripts/reconnect-probe.mjs` → `ok: true`。

关键输出：`newSession.initializeStatus=200`、issued session `uuid`、snapshot `count=4`；
`staleSession.status=200` / `fullTable=true` / `gatewayReportedUnknownTool=false`；
`httpSemantics.get=405` / `delete=204`；
`snapshotDeterminism.identical=true`（hash `a6252a91…`, fake 工具面下稳定）；
`authChallenge.status=401` / `metaChallengeCount=1`；
`unknownTool.isError=true` / `echoesName=true` / `clientInternalClassification=unknown`。

注入验证：`runProbe({ fetchImpl: wrappedFetch })` 触发 11 次调用且 `ok=true`；
`assertLoopbackUrl('https://example.com/mcp')` 被拒绝（offline-only）。

### 全量

`npm test` 最终稳定跑出 **1087 tests, 1081 pass, 0 fail, 6 todo**（中途出现过
`figma-guard` / `capture-completeness` 的偶发失败，均为并发改动/时序 flake，
单独重跑及后续全量均通过，与本批 4 个新增文件无关）。
探针 CLI 已将 handler 的 `[capture_skipped]` / `[req]` 日志改道 stderr，
stdout 为纯 JSON，可直接 `ConvertFrom-Json` / `jq` 消费。

## 四、关键观测结论（不越界）

- **实测事实**：本网关 stateless，未知/旧 `Mcp-Session-Id` **不会**触发 404/400，而是
  **200 + 完整工具表**。测试如实记录这一点，并明确禁止返回半截工具表。
  "用 404 提示客户端重连"属 Batch 11 已否决方案，本批不复活它。
- **可观测证据上限**：网关能看到 `tools/list` 是否稳定、`tools/call` 的真实 name 与
  网关自己的 `unknown tool:` 串；看不到 Google 客户端为何把某个名字标记为
  `unknown_tool` / `not-found`，也看不到它是否自动恢复。这两项记 `unknown`。
- **不伪造**：没有造"自动恢复"事件、没有捏造 capture 指标、没有模拟宿主摘工具。

## 五、后续（不在本批）

- 若线上再次出现工具消失，按 `docs/eval/RECONNECT-TESTS.md` 第四节用 `requestId`
  关联 capture，先判别"网关真的没这个工具"还是"客户端缓存陈旧"；
- 工具名/schema 若必须变更，走 `batch-11-reconnect.md` 的 `/mcp/v1|v2` 版本化 + 回滚 runbook；
- 本批不改任何 `src/`，因此不改变生产行为与实际 MTTR。

## 六、证据来源

- 仓库内：`docs/ledger/batch-11-reconnect.md`、`docs/eval/session-marker-2026-11-23.md`、
  `AGENTS.md`、`src/server.js`、`src/vercel-app.js`、`tests/chatgpt-oauth.test.js`（401 _meta 既有口径）。
- 本地执行：`node --test tests/reconnect-server.test.js`、`node scripts/reconnect-probe.mjs`、
  fetch 注入与 loopback guard 验证（见第三节）。
- 线上反馈仅为背景输入（**[事实]**），未获取 Google 客户端 wire 证据，故客户端内部机制 **[未验证]**。
