# B14 — `/mcp/v2` typed-plan 路由实现记录

> 状态：**已落地**。按 `docs/ledger/batch-14-typed-plan-v2.md`（设计稿）实现隔离的
> `/mcp/v2` 版本化路由：默认关闭（`ENABLE_MCP_V2=1` 才暴露），v1 `/mcp` 字节不变，
> 三工具同名同序。未 commit / push / deploy。
>
> 本轮只写：`src/server.js`、`src/vercel-app.js`、`src/codemode-v2.js`（新增）、
> `tests/typed-plan-v2-route.test.js`（新增）、本文件（新增）。
> 未改 `src/codemode.js`、`src/typed-plan.js`、`src/capture.js`、`scripts/`、其他
> tests / README / workflows。

## 1. 交付边界（明确不做什么）

- 不原地给 v1 `execute` 加 `plan`：v1 的 `execute`/`execute_read` inputSchema 仍是
  `{code:string}, required:['code']`，一字不动（回归测试逐字断言）。
- 不加第四工具：v1 与 v2 都只返回 `search`/`execute_read`/`execute`，顺序一致、annotations 一致。
- 不复制 op registry / validator：v2 handler 直接调用现有 `executeTypedPlan`
  （`src/typed-plan.js`），plan schema 只描述字段类型，per-op 必填/类型/server-side
  readOnly & 审批全部由引擎的 `validateTypedPlan` 承担。
- 不发 `notifications/tools/list_changed`；两个端点各自在连接时冻结工具定义。
- 不碰真实凭据、不联网：所有 I/O 通过 `options.typedPlanIO`/`typedPlanOps` 注入 fake；
  未注入时引擎 fail-closed（稳定校验错误、零副作用）。

## 2. 文件与改动

### 2.1 `src/server.js`（改动）

- 新增 `MCP_V1_PATH='/mcp'`、`MCP_V2_PATH='/mcp/v2'` 常量与纯函数
  `isMcpV2Enabled(env)`：`env.ENABLE_MCP_V2 === '1'` 是唯一开启条件（其它值含
  `0`/`true`/`1 `/`undefined` 均视为关闭）；`env` 可注入，便于离线测试。
- `createGatewayServer()` 接受 `options.protocolVersion === 'v2'`：
  - 选 `createCodeModeToolsV2()` 生成工具；v1 分支仍走 `createCodeModeTools()`；
  - v2 的 `serverInfo` 增加 additive `version: '0.1.0+v2'` 与
    `_meta.gateway = { protocolVersion:'v2', planVersion:'v2.0.0',
    supportedInputModes:['plan','code'], profile:'S' }`；`registerCapabilities`
    增加同样的 additive `_meta.gateway`。v1 不返回这些字段（`serverInfo` 原样）。
- `createMcpRequestHandler()` 按 pathname 分发：
  - flag off 时 `/mcp/v2` 落到 404（无 capture envelope，仅 audit skip）；
  - flag on 时 `/mcp/v2` 与 `/mcp` 共用 OAuth/capture/transport/upstreamManager，
    只把 `protocolVersion:'v2'` 传入 server factory；
  - `/mcp/v3` 等未知路径 404，不隐式降级到 v1；
  - v2 POST 进 capture envelope，并写入 additive event
    `protocol_version {protocolVersion:'v2', planVersion, profile:'S'}`
    （Vercel 边缘已打标签时跳过，避免重复事件）；v1 不写该事件。

### 2.2 `src/vercel-app.js`（改动）

- 从 `server.js` 引入 `isMcpV2Enabled`/`MCP_V1_PATH`/`MCP_V2_PATH`；从 `capture.js`
  引入 `captureEvent`。
- `appHandler` 计算 `isMcpRoute = pathname==='/mcp' || (pathname==='/mcp/v2' && flag)`：
  - v2 POST 同样先 `bufferCaptureBody` → `startCapture`（进 envelope，不 `captureSkip`）；
  - v2 在 envelope 写 `protocol_version` 标签；
  - 路由分发用 `isMcpRoute` → `handleMcp()`，OAuth/resource/401 challenge 全部共用；
    flag off 时 `/mcp/v2` 落到 404 JSON。
- v1 分支与响应字节不变。

### 2.3 `src/codemode-v2.js`（新增）

- `createCodeModeToolsV2(upstreamManager, options)`：先调用 v1
  `createCodeModeTools()` 取得 `search`（结构逐字相同），再覆盖两个 execute 的
  `inputSchema` 与 `handler`，保留其 name/description/annotations。
- Schema（导出 `V2_EXECUTE_READ_INPUT_SCHEMA`/`V2_EXECUTE_INPUT_SCHEMA`，已经
  `sanitizeTool` 处理且幂等）：
  - `execute_read`：仅 `plan`，`plan` 是 array（`minItems:1, maxItems:64`），每项
    平铺 step object，`op` 是只读三 op 的 `string enum`，无 per-op `oneOf`；
  - `execute`：`oneOf:[{required:['plan']},{required:['code']}]`（仅 2 分支），
    `plan` 是六 op 的平铺 step array，`code` 是 fallback string，`dryRun` boolean，
    `approve` 是 write op 名的 string array（带 `items`）；
  - 所有数组声明 `items`，无多类型裸字段，无 `structuredContent`，结果走文本 JSON。
- Handler：
  - plan 路径调用 `executeTypedPlan(plan,{io,ops,dryRun,approve,readOnly})`，`execute_read`
    强制 `readOnly:true`（写 op 在校验期被拒、零副作用）；`execute` 的写 op 需要
    `dryRun:true` 或 `approve`（全局列表/step.approve）；返回稳定
    `{ok,dryRun,steps,stoppedAt,error,meta}`，meta 附加
    `protocolVersion/planVersion/profile/fallback`；`captureEvent('typed_plan_v2',…)`。
  - `execute` 三层互斥防御：schema `oneOf` + 服务端 `E-VAL-BOTH`（同时给）/
    `E-VAL-NONE`（都不给）+ plan 分支夹带 `code` 再拒。
  - `code` 分支复用 v1 的 execute handler（`runInSandbox → toModelOutput`），
    附加 additive `meta.fallback = {reason:4, attemptPlan:false, atStep:null}`。

### 2.4 `tests/typed-plan-v2-route.test.js`（新增）

20 个测试，全离线（fake IO/fake manager/in-process HTTP，无联网、无凭据、无真实写）：

1. flag 语义（只有精确 `'1'` 开启）；
2. v1 三工具 schema/顺序/annotations 逐字不变；
3. v2 三工具同名同序、无第四工具、annotations/description 一致；
4. schema 过 `sanitizeTool` 且幂等、数组有 items、oneOf≤2、op 为 enum；
5. execute_read plan 成功 + 稳定 meta、无 audit 字段泄漏；
6. execute_read 服务端拒绝写 op（零 step/零副作用）；
7. execute 写 op 无 dryRun/approve 被拒（零副作用）；
8. dryRun 写只出 preview、无真实写；
9. 显式 approve 真写成功、meta 稳定；
10. 未知 op/缺参在执行前被拒；
11. `code`+`plan` 同时给 `E-VAL-BOTH`、都不给 `E-VAL-NONE`；
12. code fallback 走沙箱并带 `meta.fallback`；
13. execute_read 无 code fallback；
14. flag off：`/mcp/v2` 404、v1 `/mcp` 仍工作；
15. flag on：`/mcp/v2` 三工具 + additive discovery 标签；
16. flag on：v1 仍是 code-only schema；
17. `/mcp/v3` 404 不降级；
18–19. Vercel app 路由（flag off 404、flag on token 校验共用、缺 token 401、v1 不变）；
20. `createGatewayServer` v2 discovery `_meta.gateway` / v1 无该字段。

## 3. 验收与证据

- `node --test tests/typed-plan-v2-route.test.js` → **20/20 通过**（离线）。
- `node --check src/server.js && node --check src/vercel-app.js && node --check src/codemode-v2.js` → 全绿。
- `npm test` 全量结果见本文件末的「全量测试」小节（由执行者回填；并发影响只报告本文件）。
- 未改 `src/codemode.js`/`src/typed-plan.js`/`src/capture.js`/`scripts/`/其他 tests/README/workflows。
- 未 commit / push / deploy。

## 4. 未做 / 后续（沿用设计稿约束）

- 不执行 A/B 切换、不把 v2 设为默认；是否切换由门槛 + lead 人审决定。
- OAuth `resource` audience（方案 A/B）仍待真实客户端验证，本实现沿用共用 `/mcp`
  resource（设计稿推荐先验证的 A 方案），未宣称 ChatGPT/Claude 通过。
- `fallback.reason` 目前 code 分支写 `4`（模型直接传 code），其余原因计数需要 session
  作用域计数器，属于后续 A/B runner 的工作，不在本轮路由实现范围。

## 全量测试

`npm test`（`node scripts/run-tests.mjs`，全仓 107 个测试文件）→
**tests 1200 / pass 1194 / fail 0 / todo 6 / skipped 0 / cancelled 0**，
exit code 0，耗时约 20s。6 个 todo 是仓库既有的 `# TODO` 标记测试，与本轮无关。
本轮新增 `typed-plan-v2-route.test.js` 的 20 个测试在并发全量运行中全部通过；
其它同时运行文件的 pass/fail 不计入本轮结论。全程离线，无联网、无真实凭据写入、未 commit。
