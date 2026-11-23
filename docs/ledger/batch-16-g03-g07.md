# Batch 16 · G-03 / G-07 — v2 plan 真实 IO 接线 + startCapture options 透传

> 日期：2026-11-24（Asia/Singapore）。范围：全仓库审计 `FULL-REPO-FINDINGS.md` §2 的 G-03、G-07（`15-src.md` 对应条目）。
> 状态：本地工作树已修 + 确定性测试。**未 commit / push / deploy。** 生产仍旧构建（AGENTS.md §0）。
> 写作用域严格限定：`src/codemode-v2.js`、`src/vercel-app.js`、`tests/fix-g03-g07.test.js`（新增）、本文档。
> `src/server.js` 虽在允许清单内，但本次无需改动（v2 plan handler 的 IO 接缝在 codemode-v2.js，capture 接缝在 vercel-app.js）；未触碰 v1 三工具/schema。

---

## 0. 边界与不变量

- **不联网 / 无凭据**：所有测试用 fake IO adapter、fake upstream manager、fake res/req，不读真实 token、不发真实请求。
- **不改工具面**：v1 的 `search` / `execute_read` / `execute` 名称、顺序、schema、annotations 保持原样；v2 仍是同名同序三工具，`plan` 仍只是入参。测试显式断言 v1 `execute` 仍是 code-only schema。
- **fail-closed 语义保留**：没有可用 adapter 时仍由 `executeTypedPlan` 返回明确错误（`io adapter is required`），零副作用；不做静默 fallback、不绕过写闸（dryRun / approve / readOnly 全保留）。
- **默认行为不变**：G-07 的 spread 不改变无注入时的 env/默认路径；显式 route 字段（path/bodyBuffered/requestBytes）仍覆盖注入值。

---

## 1. 根因

### G-03 — `/mcp/v2` plan 无真实 IO，`fail closed` 导致实际不可用

- `src/codemode-v2.js` 原 `makePlanHandler` 只在 `options.typedPlanIO` 存在时才把 `io` 传给 `executeTypedPlan`：
  `...(rawIO ? { io: budgetIO(rawIO, budget) } : {})`。没有注入时 **完全不传 `io`**。
- `src/typed-plan.js` 的 `executeTypedPlan`（L314–326）在没有 `io` 时故意返回
  `io adapter is required (no default real adapter is bundled)`，零步骤。
- 结果：生产 `/mcp/v2` 上任何 plan（连纯 `readFileRange`）都失败，除非调用方手动注入 `typedPlanIO`。
- 对照 v1：`src/codemode.js` 的 `runInSandbox().registry.runTypedPlan`（L1332–1345）在
  `typedPlanIO` 缺失时用 `createDefaultTypedPlanIO({ tools, callTool, charge })` 从上游工具桥
  构造**真实** adapter。两条路径注入方式不对称——这正是审计 G-03 的结论。

### G-07 — `vercel-app.js` `startCapture` 未透传 options

- `src/vercel-app.js` 原调用：`startCapture(req, res, { path: pathname, bodyBuffered, requestBytes })`。
- `createAppHandler(options)` 收下的注入项（`oauthClientMap`、`sink`、`asyncQueue`、`log`、
  `queueSink`、`queueScheduler`、`fileDir`、`httpUrl/token`、`fetchImpl` 等）在此处被**整体丢弃**。
- `src/capture.js` 的 `configFromOptions`（L304–340）与 `buildClientPlatformBlock`（L117–136）
  都从 `options` 读这些接缝；因此注入全部失效：oauthClientMap 不生效、sink 固定回退到 env/file、
  asyncQueue 无法开启、log 回调拿不到审计行。审计定位：`FULL-REPO-FINDINGS.md` G-07。

---

## 2. 修复

### 2.1 G-03 — v2 复用与 v1 相同的 IO/ops 注入接缝

全部改动在 `src/codemode-v2.js`：

1. `makePlanHandler` 新增 `upstreamManager` 参数（两个调用点 `readOnlyHandler` / `writeHandler` 均传入）。
2. IO 解析改为两路：
   - **注入优先**：`options.typedPlanIO` 存在时仍走原路径，用 `budgetIO(rawIO, budget)` 按方法计费（runChecks 不计费，与 v1 对齐）。
   - **默认 adapter**：无注入时，调用新增的 `createDefaultV2TypedPlanIO({ tools, callTool, charge })`，从
     `upstreamManager.getEntries()` + `upstreamManager.callTool()` 构造真实 adapter，和 v1
     `createDefaultTypedPlanIO` 同构（readFileRange/repoGrep/ensureBranch/writeFile/openPr/runChecks），
     每次上游 `invoke` 通过 `charge` 计入同一个 `makeChargeBudget(maxCalls)` 预算。
   - **都不可用**：默认 adapter 构造返回 `null`（manager 没有可识别的上游工具或没有 `callTool`）时，
     不传 `io`，由引擎返回稳定的 fail-closed 错误，零副作用。
3. 复用既有纯函数 `fileTextFromRaw`（codemode.js 已导出）与 `unwrapResult`（tool-format.js 已导出），
   不复制归一化逻辑；`src/codemode.js`、v1 三工具/schema 均未改动。

> 说明：受写作用域限制不能改 `src/codemode.js`（其中 `createDefaultTypedPlanIO` 为私有），
> 因此在 v2 内按 v1 同构实现默认 adapter，使用完全相同的两个依赖（entries + callTool）与计费语义。

### 2.2 G-07 — `startCapture` 透传 options

`src/vercel-app.js` 的 POST /mcp 捕获入口改为：

```js
const capture = startCapture(req, res, {
  ...options,          // oauthClientMap / sink / asyncQueue / log / queueSink / ...
  path: pathname,      // 路由权威字段，覆盖注入值
  bodyBuffered,
  requestBytes,
});
```

- 注入项现在到达 `startCapture`；显式 route 字段仍在 spread 之后写入，保持权威。
- 默认（无注入）时 spread 为空对象，调用参数与修前逐字一致；`capture.js` 仍从 `process.env` 取默认值，默认行为不变。

---

## 3. 证据

### 3.1 确定性测试（新增 `tests/fix-g03-g07.test.js`，8 项全过）

单文件实跑：`node --test tests/fix-g03-g07.test.js` → **8 tests / 8 pass / 0 fail**。

| 覆盖 | 断言 |
|---|---|
| G-03 v2 read plan + 注入 IO | `ok:true`、步骤执行、meta.readOnly/protocolVersion 正确、IO 被调用 |
| G-03 v2 write plan dryRun + 注入 IO | `ok:true`、`dryRun:true`、有 preview、未发生真实 write |
| G-03 v2 默认 adapter（无注入，manager 有 `get_file_contents`） | `ok:true`、上游 callTool 恰好 1 次、tool=`get_file_contents` |
| G-03 无任何 adapter | `ok:false`、`steps:[]`、错误匹配 `/io adapter is required/`（fail closed） |
| G-03 v1 三工具/schema 未变 | 名称顺序一致、v1 execute 仍 code-only、无 plan 字段 |
| G-07 注入 log/sink/asyncQueue/queueSink/oauthClientMap 全部生效 | `capture_ack.sink='http'`、`capture_queue_mode.asyncQueue=true`、queueSink 收到 1 个信封、`clientPlatform='chatgpt'` / `clientProfile='chatgpt-structured'` |
| G-07 默认行为不变 | 无注入时 `capture_skipped`、`sink='file'`、不发 `capture_queue_mode` |
| G-07 route 字段覆盖注入值 | `path='/mcp'` 覆盖注入 path；requestBytes 为真实缓冲长度而非注入 -1；sink 注入仍生效 |

### 3.2 全量测试

本次会话实跑 `npm test`：**1461 tests / 1455 pass / 0 fail / 6 todo**（无失败）。
（同窗口其他 agent 也在并行改 g04/g05/g13 等；其全量结果可能因 timing 用例波动，最终基线以 lead 合并后最近一次实跑为准。）

---

## 4. 未验证项 / 已知边界

- **未部署**：生产仍为旧构建；部署后需按 DEPLOY-POLICY 重跑 healthz / tools/list / 在线复验（AGENTS.md §0）。
- **未做真实客户端验证**：无真实 Gemini / guest 会话；v2 plan 的默认 adapter 只在 fake upstream manager 上证明可执行，真实上游 envelope 形状（get/list 工具名、截断标记）需在真实客户端/写回环再核。
- **未授权**：AUTH-READY 仍 NOT READY；本修复不涉及授权门禁。
- **默认 adapter 与 v1 同构但非同一函数**：`src/codemode.js` 的 `createDefaultTypedPlanIO` 为私有且不在本次写作用域；若未来 v1 adapter 语义调整，v2 副本需同步（已在本文件 §2.1 标注约束来源）。
- **预算计费口径**：注入 adapter 走“每方法一次”计费；默认 adapter 走“每上游 invoke 一次”计费——与 v1 现状一致，未改变预算语义。
- **不做 commit**：按要求仅本地工作树修改。
