# 重连 / 发版后工具消失：网关可观测测试（batch 15，2026-11-23）

> 范围：**只测网关在 HTTP wire 上能观测到的部分**。不模拟 Gemini 宿主的
> 工具缓存、内部 `unknown_tool` / `not-found` 分类或自动重连行为。
> 本次仅新增 `tests/reconnect-server.test.js`、`scripts/reconnect-probe.mjs`
> 及两份文档；未改 `src/`、其他 `scripts/`、`tests/`、`README`、workflows；
> 未 commit / push / deploy。

## 一、为什么只测"可观测部分"

线上事实（用户提供，Batch 11 已记录于 `docs/ledger/batch-11-reconnect.md`）：
发版/重启后长会话报 `unknown_tool` / `not-found`，用户手动 `@` 恢复。

客户端宿主"摘工具"的动作在 **Google 侧进程**里，网关进程看不到，也无法控制。
因此把结论分成三档，测试只覆盖第一档：

| 档位 | 内容 | 本套件态度 |
|---|---|---|
| **可观测（网关 wire）** | `initialize` / `tools/list` 响应、HTTP 状态码、session 头、401 challenge、网关自己返回的 `unknown tool:` 错误串 | 确定性断言，9 项测试 |
| **可推断但不可验证** | "客户端缓存快照过期导致工具消失" | 写进边界说明，不当作测试结论 |
| **不可观测** | Gemini 内部把它归类成 `unknown_tool` 还是 `not-found`、是否会自动重连恢复 | 明确记为 `unknown`，**不伪造指标、不造恢复事件** |

任何声称"网关已自动修复/客户端已自动恢复"的表述都不属于本套件证据。

## 二、六项观测与断言口径

对应 `tests/reconnect-server.test.js`（`node --test tests/reconnect-server.test.js`，9/9 通过）。

1. **新 session `initialize` / `tools/list` 稳定**
   - `initialize` → 200，响应头 `Mcp-Session-Id` 是 UUID；
   - 该 session 的 `tools/list` → 200，返回**完整**工具面（fake 上游下固定 4 个：2 个白名单 + `gateway_call` + `gateway_search`）；
   - 另起一个独立 handler 实例（模拟重启后的新进程），两次快照完全一致。

2. **旧 / 未知 `Mcp-Session-Id`**
   - 向网关发送形似重启前会话的 ID（UUID 形态、非 UUID、空白）；
   - 允许的状态码是 **200 / 400 / 404**（MCP 规范允许服务端对未知会话回 404/400）；
   - **观测结果**：本网关 stateless，实测回 **200 + 完整工具表**，不是 404/400。这是
     源码事实（`sessionIdGenerator: undefined`，session 头只作 capture 关联键），
     测试如实记录，**不把它改成 404 来"制造重连信号"**；
   - 硬约束：任何情况下不得返回**半截工具表**，`tools/list` 不得由网关自己吐出
     `unknown_tool` / `not-found`；带旧 session 调用已在册的工具仍成功。

3. **HTTP 方法语义**
   - `GET /mcp` → **405**，`Allow: POST, DELETE`；
   - `DELETE /mcp` → **204**，空 body；
   - `PUT /mcp` → 405，`Allow: GET, POST, DELETE`；非 `/mcp` 路径 → 404；
   - `POST /mcp` 不带 session 头仍然是合法的（stateless），`tools/list` 返回完整表且不新发 session 头；
     `initialize` 不带头才由服务端生成 UUID；带客户端自带头则不覆盖；
     无 body 的 POST 被 SDK 以 400/415 拒绝。

4. **`tools/list` 三次快照完全一致**
   - 用 sha256(name + 顺序 + description + inputSchema) 做 schema hash；
   - 同一 client 连续三次 `listTools()`，name 数组、数量、hash 全等。
   - 这正对应 Gemini "注册时摄入工具表" 的模型：表不稳定就会撞缓存。

5. **401 `_meta["mcp/www_authenticate"]`**
   - 经 `createAppHandler` 对无 bearer / 非法 bearer 的 `POST /mcp` 观测：
     401 + `WWW-Authenticate` 头 + body 中 `_meta["mcp/www_authenticate"]` 恰一条 challenge，
     含 `resource_metadata=` / `error=` / `error_description=`；
   - 这条是 additive，不改工具名/schema，Gemini 字节契约不受影响。

6. **客户端 `unknown_tool` 明确记 unknown，不伪造**
   - 调用一个当前工具面上不存在、形似"发版后残留"的工具名：网关回 `isError:true` +
     `unknown tool: <name>`，原样回显名字便于关联；
   - 对照：在册工具仍成功，证明该 unknown 来自客户端提供的名字，不是网关整体故障；
   - 对 Gemini 内部分类是否 `unknown_tool`、是否自动恢复，记录为 `unknown`。

## 三、离线复现（无外网、无凭据）

```powershell
# 只跑新套件（9 项）
node --test tests/reconnect-server.test.js

# 全量
npm test

# 离线证据探针（自带 loopback server，输出 JSON，不改文件）
node scripts/reconnect-probe.mjs

# 注入自定义 fetch（库用法，示例见脚本头注释）
#   import { runProbe, startProbeServer } from './scripts/reconnect-probe.mjs';
#   const s = await startProbeServer();
#   const report = await runProbe({ fetchImpl: myFetch, baseUrl: s.baseUrl });
```

探针只绑定 `127.0.0.1`；`--base-url` 传外部域名会被拒绝（"offline-only"）。
fake 上游写在脚本内部，不读配置、不连真实 MCP server、不触碰 vault。

预期关键输出（fake 工具面）：

```json
"newSession": { "initializeStatus": 200, "issuedSessionId": "uuid", "snapshot": { "count": 4 } },
"staleSession": { "statusAllowed": true, "status": 200, "fullTable": true, "gatewayReportedUnknownTool": false },
"httpSemantics": { "get": { "status": 405 }, "delete": { "status": 204 } },
"snapshotDeterminism": { "identical": true },
"authChallenge": { "status": 401, "metaChallengeCount": 1 },
"unknownTool": { "isError": true, "echoesName": true, "clientInternalClassification": "unknown" },
"ok": true
```

## 四、线上复现步骤（只读观测，不改代码）

> 以下用于在真实发版窗口**观测**问题，不保证能复现 Google 内部行为；
> 任何一步都不应被解读为"网关已自动恢复客户端"。

1. 发版前记录基线：`GET /healthz` 的 `commit` / `buildHash` / `deploymentId`；
   用 MCP Inspector 或 `node scripts/reconnect-probe.mjs --base-url http://127.0.0.1:<port>`
   对本地新进程记录工具名集合与 schemaHash。
2. 发版后先在**新窗口** `initialize` + `tools/list`：应拿到新 session 头、完整工具表；
   对比 schemaHash 与基线一致（工具名/schema 不该因发版改变）。
3. 打开一个**发版前就已存在的长会话窗口**，直接触发一次工具调用：
   - 若出现 `unknown_tool` / `not-found`：**这是客户端缓存快照症状**，网关侧只会
     在 capture 里看到 `tools/call` 的真实 name；把它记为 `clientInternalClassification = unknown`；
   - 在 capture/digest 里按 `requestId` 找该请求：核对 `sessionId`（旧 UUID）、`clientInfo`、
     `mcpMethod`、工具 name、以及是否真有网关返回的 `unknown tool:` 错误串。
   - 关键判别：**网关是否真的没这个工具**？用同一 name 在新窗口调用：成功 → 客户端陈旧；
     失败且网关回 `unknown tool:` → 工具面确实缺该名字（应触发回滚而非重挂载）。
4. 用户手动 `@Gemini Mcp Gateway` 重挂载后，再 `tools/list`：新 session + 同一快照 = 恢复。
   记录这是**用户动作**，不是网关自动推送。
5. 若某次发版确实改变了工具名/schema：按 `docs/ledger/batch-11-reconnect.md` 的
   runbook 走 `/mcp/v1|v2` 版本化路径 + staged promote / rollback，不要原地发。

## 五、边界与禁止事项

- **不模拟宿主**：本套件不创建"假 Gemini 客户端缓存"，不宣称理解了 Google 的内部机制；
- **不伪造成功**：stale session 实测是 200 完整表（不是 404），就写 200；unknown 就是 unknown；
- **不改契约**：不声明 `listChanged`、不开 GET SSE、不发 404 重连信号（与 Batch 11 决策一致）；
- **不联网**：测试与探针仅 loopback / in-process；无真实凭据、无 vault 读取。
