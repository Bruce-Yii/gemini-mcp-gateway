# Batch 15 · residual security fix (R-01 / F-08 / F-09 / R-02)

> 日期：2026-11-23（Asia/Singapore）。范围：`docs/OPEN-SOURCE/RESIDUAL-RISK-AUDIT.md` §6.1/§6.2 四项。
> 状态：本地工作树已修 + 确定性测试。**未 commit / push / deploy。** 生产仍是旧构建（AGENTS.md §0）。

---

## 0. 边界与不变量

- **不改工具面**：三工具 `search` / `execute_read` / `execute` 的名称、顺序、schema、annotations 未变；
  v1 `/mcp` 逐字不变；v2 仍是同名同序三工具，`plan` 仍是入参。
- **capture 不脱敏**：`src/capture.js`、`src/upstreams.js`、`src/codemode.js` 未改；
  raw `Error.message` 原样保留给 capture，只改**模型可见投影**（AGENTS.md §6 双投影边界）。
- **无联网 / 无真实凭据**：全部离线测试，只用 `ghp_RESIDUALLEAK999` 等假值字面量。
- 写作用域严格限定在：
  `src/server.js`、`src/tool-format.js`、`src/codemode-v2.js`、`src/result-normalize.js`、
  `tests/residual-security-fix.test.js`、本文档。

---

## 1. R-01（P0）server.js 直接错误路径脱敏

**问题**：`errorMessage()` 直接返回 `error.message`，被两条模型可见路径使用：
- `errorResult()`（工具调用错误响应 `isError:true`，text JSON）— `CallToolRequest` handler 的 catch；
- JSON-RPC 500 — `createMcpRequestHandler` 顶层 catch（`sendJsonRpcError(..., -32603, ...)`）。

`upstreamError()` 挂的非枚举 `modelMessage` 红化投影从未被读取，上游 401 的
`Authorization: Bearer <token>` 会原样回显给模型。

**修复**：
- `src/server.js` 从 `tool-format.js` 导入 `modelErrorMessage()`；
- `errorMessage()` 改为 `return modelErrorMessage(error)`：
  - 优先使用上游附加的非枚举 `modelMessage`（已脱敏）；
  - 否则对 `error.message` 做 secret 形态脱敏（Bearer / `ghp_` / `github_pat_` / query token / API key 等）；
  - **raw `error.message` 不被改写**，capture 全保真不变。

**覆盖**：两条路径都经 `errorMessage()`，一次修改全覆盖。测试：
`R-01: errorResult ...`（fake 上游抛含 token 错误 → 工具错误 text 不含 token、含 `[REDACTED]`、前缀保留；
并断言 raw error.message 未被改写）；
`R-01: JSON-RPC 500 ...`（挂 `modelMessage` 的错误 → 500 文本不含 token、含 `[REDACTED]`）。

---

## 2. F-08（P1）截断字段语义统一

**问题**：`shrinkObject()` 生成 `--- TRUNCATED ---` marker 时保留上游 `truncated:false`，
模型看到矛盾键；`result-normalize.js:flagFrom()` 把任意非空字符串当截断原因，
与 tool-format 的布尔透传语义不一致。

**修复**：
- `src/tool-format.js`
  - 新增 `isExplicitTruncationFlag()` / `truncationReason()`：真值表统一为
    只有 `true / 1 / '1' / 'true' / truncation 对象` 算显式 flag；任意字符串是**原因**不是 flag。
  - `shrinkObject()` 真正截断时：剔除上游 `truncated/isTruncated/truncation` 键，
    改写为 `truncated:true` + 独立 `truncation` 原因串 + marker；`cost()` 预留新键开销，
    输出不超 `maxChars`；最小 marker fallback 同样不带矛盾键。
  - 未截断时不加 marker、不改写上游布尔（保持原样）。
- `src/result-normalize.js`
  - `flagFrom()` 删除"任意非空字符串 → `upstream:<raw>`"分支，只认 true-like 值与对象原因；
    与 tool-format 同一真值表（boolean 与 reason 分开）。

**验证**：审计探针 `truncateResultValue({truncated:false, big:'B'.repeat(5000)}, {maxChars:200})`
现在输出 `truncated:true` + `truncation:'tool-format:object-shrunk'` + marker，无矛盾键，
JSON 长度 ≤ maxChars。测试 3 组覆盖矛盾消除、无截断保持、跨模块真值表一致。

---

## 3. F-09（P1）boundResult 结果级 flag

**问题**：`boundResult()` 只在函数内置 `truncated=true`，返回时从不写 `result.truncated`；
下游按结果级布尔判定的消费者漏报 gateway 层截断。

**修复**：
- `src/server.js:boundResult()` 返回改为
  `truncated ? { ...result, content, truncated: true } : result`；
  in-band `… [truncated N chars by gateway...]` marker **原样保留**，不改变既有 marker 语义。
- `encodeToolResult` / `encodeModelOutput`（`src/client-profile.js`，未改）：
  两者只对 `structuredContent` 做 profile 分支，其余顶层字段经 `...rest` 透传，
  因此 `truncated` 在 gemini / claude / chatgpt 三个 profile 下均保留；
  `textResult()` 将 bounded 对象 JSON.stringify 进 text block，嵌入的 flag 同样保留。

**验证**：测试覆盖「真截断才有 flag」「三 profile 保留结果级与嵌入 flag」「in-band marker 仍在」。

---

## 4. R-02（P1）v2 plan 预算接入

**问题**：`src/codemode-v2.js:makePlanHandler` 直接调用 `executeTypedPlan`，
未经过 v1 的 `chargeBudget`，64 步 plan 的自定义 IO 可无限上游 I/O，绕过 `maxCalls`。

**修复（优先实现，未走"标记不计费"退路）**：
- 新增 `makeChargeBudget(maxCalls)`，与 v1 `chargeBudget` 同语义：
  递增计数，超过 `maxCalls` 抛 `Error('tool call limit (N) exceeded')` +
  `err.code='TOOL_CALL_LIMIT_EXCEEDED'` + `err.kind='typedPlanV2'`；默认 50（与 v1 对齐）。
- 新增 `budgetIO(io, budget)`：包裹注入 IO 的每个方法（**除 `runChecks`**，与 v1 一致，
  其为本地 stub），每次调用前 `charge()`，超限则底层 I/O 根本不执行。
- `makePlanHandler` 每次执行创建**独立预算**（per tool call，对齐 v1 per-execute），
  把 `budgetIO(options.typedPlanIO, budget)` 传给 `executeTypedPlan`。

**效果**：`executeTypedPlan` 的 per-step try/catch 把稳定 code 写进
`result.error`（`TOOL_CALL_LIMIT_EXCEEDED: tool call limit (N) exceeded`）与失败 step，
模型可见且可判定；无注入 IO 时仍 fail-closed（"io adapter is required"），行为不变。

**验证**：测试覆盖「超限在第 3 步停、仅 2 次 I/O、稳定 code」「预算内成功且 runChecks 不计费」
「自定义 IO 单步多次调用也受 maxCalls 约束」。code fallback 走 v1 handler 已自带预算。

---

## 5. 测试结果

- 新增 `tests/residual-security-fix.test.js`：10 项，全部通过，离线。
- 全量 `npm test`：见本次会话最终汇总（以 lead 最近基线为准；本文件不重复声明最终数字）。

---

## 6. 未做 / 已知边界

- **未部署**：生产仍旧构建；部署后须重跑 healthz / tools/list / 在线复验（AGENTS.md §0）。
- **未授权**：AUTH-READY 仍 NOT READY；本修复不涉及授权门禁。
- **OSS**：`PUBLIC-SAFETY-AUDIT.md` 的 P0/F-01/F-02 未清零，仍 DO NOT PUBLISH。
- **R-07**（F-03 残留：多层 JSON 嵌套漏报显式截断声明）仍为已知边界，本次未纳入范围。
- 无 capture 脱敏、无 raw 错误改写；双投影边界保持不变。
