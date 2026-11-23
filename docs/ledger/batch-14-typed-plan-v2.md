# B14 — typed-plan v2 版本化 schema 接入方案

> 状态：**设计稿（未执行）**。本文只定义版本化接入方案，不写生产代码，不改
> `src/`/`scripts/`/`tests/`/`README`/其他 docs/workflows，不 commit/push/deploy。
>
> 对应台账：`docs/ledger/batch-14-typed-plan.md`（B14 不变量与验收线）。
> 输入依据：`docs/eval/TYPED-PLAN-TEST-PLAN.md`（A/B、任务集、fallback 触发、门槛）、
> `docs/eval/PLATFORM-CONFORMANCE-MATRIX.md`（C1/C5 版本路径结论）、
> `scripts/typed-plan-spike.mjs`（op registry / validatePlan / executePlan 的真实形状）、
> `src/codemode.js` 的 `createCodeModeTools`（当前 execute schema 与三工具注册）、
> `docs/AGENTS.md` + 根 `AGENTS.md`（sanitize / 稳定工具列表 / 文本 JSON / 免费模型硬规则）。
>
> 一句话结论：**不原地给 `execute` 加 `plan`**（那会改 Gemini 的 function-declaration
> snapshot，且违反工具列表冻结），而是把带 `plan` 的 inputSchema 放到新版本路径
> `/mcp/v2`，v1 `/mcp` 原样保留；两侧工具名仍是 `search`/`execute_read`/`execute`
> 三个、顺序不变。是否把 v2 设为默认由 A/B 门槛和 lead 人审决定，本文不做切换。

---

## 1. 为什么不能原地给 `execute` 加 `plan`

### 1.1 现状事实（来自源码，非推测）

`src/codemode.js:1409-1450` 的 `makeExecute(name, readOnly)` 当前 inputSchema 是：

```js
inputSchema: {
  type: 'object',
  properties: { code: { type: 'string', description: 'An async arrow function …' } },
  required: ['code'],
}
```

工具列表由 `createCodeModeTools` 在末行一次性返回、顺序固定：

```js
return [searchTool, makeExecute('execute_read', true), makeExecute('execute', false)];
```

- `required:['code']` 且没有声明 `additionalProperties`，`sanitizeTool`（`src/sanitize.js`）不会
  放行未声明字段；客户端侧 schema 校验会拒绝 `{plan:[...]}`。这正是
  `PLATFORM-CONFORMANCE-MATRIX.md` C1/T1 判 `fail` 的原因。
- `PLATFORM-CONFORMANCE-MATRIX.md` C5 明确：schema 变更必须走版本路径（`/v1`、`/v2`），
  不能在会话中改工具定义。

### 1.2 三个独立的“不能原地改”理由

1. **Gemini 的 schema snapshot**：Gemini web custom app 在连接时把 function declarations
   快照下来；会话中途改 `execute.inputSchema`（加 `plan`）会让模型按旧 schema 生成
   `{code:…}`，或按新描述生成 `{plan:[...]}` 却被旧快照拒绝。Gemini 不消费
   `notifications/tools/list_changed`（`AGENTS.md`、`PLATFORM-CONFORMANCE-MATRIX.md §2.1`），
   所以没有“热更新 schema”这条路。要改 schema，只能让客户端重新连接——即换 URL。
2. **工具列表冻结不变量**：B14 与 conformance `stable_tools_list` 要求工具恰好
   `['search','execute_read','execute']` 且同名同序（`TYPED-PLAN-TEST-PLAN.md §0.2`）。
   原地改 schema 不增加工具数量，但它改变“同一 URL 上工具定义的稳定性”——同一端点在不同
   时间返回不同 schema，等价于把 A/B 的对照组也污染了：F 与 S 不再可比，冻结基线失效。
3. **A/B 有效性**：A/B 要求两侧唯一差异是 profile（F=code / S=plan-first）。若原地改
   v1 的 schema，`/mcp` 上既有 F 会话也有 S 会话，baseline 与 experiment 共用端点，
   无法按端点隔离，也没法做回滚（回滚=把 schema 改回去=又一次 snapshot 破坏）。

### 1.3 结论：版本分流，而非字段开关

- **保留 `/mcp`（v1）**：schema 一字不动，`execute`/`execute_read` 仍 `code` only；F 继续跑这里。
- **新增 `/mcp/v2`（v2）**：同名同序三工具，但 `execute_read`/`execute` 的 inputSchema
  接受“`plan` 或 `code` 二选一”；S 跑这里。
- **三个工具名/数量恒定**：v1 与 v2 都只返回 `search`/`execute_read`/`execute`；
  `plan` 是入参形态，不是第四工具，也不是第二工具面（B14“明确不做”第 2 条）。
- 两个版本是**两条独立连接**：客户端切换 profile = 换 MCP Server URL + 重新 initialize，
  不是在同一 session 里切字段。

---

## 2. v2 的 inputSchema 定义

### 2.1 设计原则

- 沿用 spike 的真实形状（`OP_REGISTRY` / `validatePlan` / `executePlan`），不另发明一套。
- **禁用 `oneOf` 按 op 分支**：Gemini sanitizer 把 `oneOf`/`anyOf` 上限压到 8
  （`PLATFORM-CONFORMANCE-MATRIX.md §3.2`），而 registry 有 6 个 op 且会增长；采用
  **扁平 step schema**：`op` 是带 `enum` 的普通 string，参数字段平铺在 step 对象上。
- 所有数组声明 `items`；无多类型裸字段；无 `structuredContent`；结果走文本 JSON。
- **互斥靠 `oneOf:[{required:['plan']},{required:['code']}]` 表达“二选一”**；注意这里的
  `oneOf` 只有 2 个分支，远低于 8，且分支是对象级而非 op 级——若 sanitize 后仍被拆坏，
  回退方案见 §7 R3（用 `anyOf` + 服务端强校验，或改为两个字段皆 optional、由服务端拒绝
  同时出现）。不要在未跑 P6（sanitize fixture）前宣称该 schema 在 Gemini 可用。

### 2.2 `execute_read` inputSchema（v2，只读 plan，无 code fallback）

v2 的 `execute_read` 只接受 `plan`（读路径不提供 code fallback——fallback 只在 `execute`
上，见 §2.5）。这与 spike 的 read-only 语义一致：registry 中 `effect:'read'` 的 op
（`readFileRange`/`repoGrep`/`runChecks`）可进，`effect:'write'` 的 op 在 `execute_read`
被服务端拒绝（不依赖客户端 annotation 当安全边界）。

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "plan": {
      "type": "array",
      "description": "Ordered read-only typed steps. Never writes; skipped when empty.",
      "items": { "$ref": "#/$defs/step" },
      "minItems": 1,
      "maxItems": 64
    }
  },
  "required": ["plan"],
  "$defs": {
    "step": {
      "type": "object",
      "description": "A single typed op. 'op' selects the registry entry; all other fields are that op's validated args.",
      "additionalProperties": false,
      "properties": {
        "op": {
          "type": "string",
          "enum": ["readFileRange", "repoGrep", "runChecks"],
          "description": "Registry op name. Unknown op is rejected before any step runs."
        },
        "path":       { "type": "string",  "description": "readFileRange: repo path" },
        "startLine":  { "type": "integer", "minimum": 1, "description": "readFileRange: 1-based" },
        "endLine":    { "type": "integer", "minimum": 1, "description": "readFileRange: inclusive" },
        "pattern":    { "type": "string",  "description": "repoGrep: regex/source pattern" },
        "pathPrefix": { "type": "string",  "description": "repoGrep optional: scope" },
        "limit":      { "type": "integer", "minimum": 1, "description": "repoGrep optional: max matches" },
        "command":    { "type": "string",  "description": "runChecks: command name" }
      },
      "required": ["op"]
    }
  }
}
```

> 参数字段是“ union 平铺”而非按 op 分组：由服务端 `validatePlan` 按 `OP_REGISTRY[step.op].fields`
> 做逐 op 必填/类型校验（`scripts/typed-plan-spike.mjs:129-176`）。schema 只保证字段类型，
> 不保证“哪个 op 该有哪个字段”——这层由服务端承担，错误信息回给模型供其自纠
> （T3/O3）。把 `$defs` 内联到每个 `properties.plan.items`（若目标客户端不解析 `$ref`），
> 语义不变；是否保留 `$ref` 由 P6 fixture 决定。

### 2.3 `execute` inputSchema（v2，plan 或 code 二选一）

```json
{
  "type": "object",
  "additionalProperties": false,
  "oneOf": [
    { "required": ["plan"] },
    { "required": ["code"] }
  ],
  "properties": {
    "plan": {
      "type": "array",
      "description": "Typed write/read steps. Prefer this path; code only for complex fallback.",
      "items": { "$ref": "#/$defs/step" },
      "minItems": 1,
      "maxItems": 64
    },
    "code": {
      "type": "string",
      "description": "Fallback only: an async arrow function using codemode.<tool>(args) with complex transformation/branch logic that the op registry cannot express."
    },
    "dryRun": {
      "type": "boolean",
      "default": false,
      "description": "Plan-level gate: when true no write op produces a side effect; write steps return a preview/diff."
    },
    "approve": {
      "type": "array",
      "description": "Op names explicitly authorized for real writes (alternative to per-step approve:true). Ignored when dryRun is true.",
      "items": { "type": "string", "enum": ["ensureBranch", "applyPatch", "openPr"] },
      "uniqueItems": true
    }
  },
  "$defs": {
    "step": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "op": {
          "type": "string",
          "enum": ["readFileRange", "repoGrep", "runChecks", "ensureBranch", "applyPatch", "openPr"],
          "description": "Registry op name (full six in execute; read-only three in execute_read)."
        },
        "path":       { "type": "string" },
        "startLine":  { "type": "integer", "minimum": 1 },
        "endLine":    { "type": "integer", "minimum": 1 },
        "pattern":    { "type": "string" },
        "pathPrefix": { "type": "string" },
        "limit":      { "type": "integer", "minimum": 1 },
        "command":    { "type": "string" },
        "owner":      { "type": "string", "description": "ensureBranch/openPr" },
        "repo":       { "type": "string", "description": "ensureBranch/openPr" },
        "branch":     { "type": "string", "description": "ensureBranch" },
        "patch":      { "type": "string", "description": "applyPatch: unified diff" },
        "head":       { "type": "string", "description": "openPr" },
        "base":       { "type": "string", "description": "openPr" },
        "title":      { "type": "string", "description": "openPr" },
        "approve":    { "type": "boolean", "description": "Per-step real-write authorization; ignored if dryRun is true." }
      },
      "required": ["op"]
    }
  }
}
```

**硬约束：禁止同时给 `code` 与 `plan`。** 三层防御：
1. schema 层 `oneOf` 的 `required` 分支（同时出现会同时满足两个分支 → `oneOf` 失败）；
2. 若 sanitize 降级为 `anyOf`，服务端入口显式拒绝：
   `if ('code' in args && 'plan' in args) → validation error E-VAL-BOTH`；
3. 即便只给一个，`code` 分支里不能夹带 `plan` 字段、`plan` 分支里不能夹带 `code`
   （`additionalProperties:false` + 服务端二次检查）。拒绝信息须描述性、能回去让模型自纠。

### 2.4 dryRun / approve 状态机（写语义，来自 spike 但约束到网关）

真实写必须走 `dryRun → 真写 → verify`；typed plan 不得绕过审批
（B14 第 3 条“不用 typed plan 替代写路径/幂等/审批”）。状态机（每次 `execute` 调用内部）：

```
                plan 入参 + 全量结构校验通过？
                  ├─ 否 → PL_INVALID（无副作用返回 validationErrors）
                  └─ 是 ↓
         该 plan 是否含 effect:'write' 的 op？
          ├─ 否（纯读 plan）→ 直接顺序执行 → PLAN_DONE
          └─ 是 ↓
   dryRun === true ?
     ├─ 是 → 每写 op 只产出 diff/preview（ctx.dryRun），不产生真实写
     │       → PLAN_DRY_RUN_DONE（ok=true, dryRun=true, steps[].result.preview）
     │       → 模型据预览决定是否提交下一步；服务端不自动从 dryRun 升级为真写
     └─ 否 ↓
  写 op 是否有 step.approve===true 或 op ∈ approve[] ？
     ├─ 否 → PLAN_NEEDS_APPROVAL（无副作用；错误码 E-VAL-APPROVAL）
     │       → 模型补齐审批或改 dryRun 后重试
     └─ 是 → 客户端确认 UX 仍须触发（annotations 不是安全边界，T4）
             → 顺序执行；首个失败即 stoppedAt=i，后续 step 不执行、不出 trace
             → PLAN_WRITTEN（需带 sha/commitSha 等 verify 字段，供写回放成功率统计）
```

要点：
- 全量校验在任何 handler 之前完成（spike `validatePlan` 的 whole-plan 语义），坏 step 不会
  留下部分副作用；但**执行期**失败仍会部分写，故 `executePlan` 返回的 `steps`/`stoppedAt`
  必须原样透出，不静默吞（T3、B11）。
- `dryRun` 的写 op 返回 `{path, diff, preview, dryRun:true}`（spike line 68-70），该字段必须
  在文本 JSON 里可见，否则 A/B 的“写回放三步齐全”无法判定。
- `execute_read` 服务端过滤 `effect:'write'` 的 op；即使 schema 的 enum 写错或客户端绕过，
  服务端也拒绝（安全边界在服务端，不在 annotation/schema）。

### 2.5 fallback 与返回形状

v2 `execute` 的 `code` 仅作 fallback，触发条件**写死**（`TYPED-PLAN-TEST-PLAN.md §1.2`，
不得由模型随意选）：
1. 多步数据变换/条件分支/跨结果拼接，超出 registry 表达力（如 TP-10、F155）；
2. 需要 registry 中不存在的 op（op 不存在错误累计 1 次后允许）；
3. plan 校验/schema 错误累计 ≥ 2 次；
4. 模型在 plan 首步显式声明 `fallback:"code"`（即直接传 `code` 入参）。

每次 fallback 必须写可观测标记（否则 S≈F，实验无意义）：
`meta.fallback = { reason: <1|2|3|4>, attemptPlan: <boolean>, atStep: <number|null> }`
进入 trace/capture；计数器按 session 作用域（新 session 从 0 起）。

**返回形状（plan 路径）** 直接复用 `executePlan` 的输出，不在 schema/文档层另造：

```json
{
  "ok": true,
  "dryRun": false,
  "steps": [
    { "ok": true,  "op": "readFileRange", "result": { "path": "work/tp.txt", "lines": ["one","two"] } },
    { "ok": true,  "op": "applyPatch",   "result": { "path": "work/tp.txt", "written": true, "sha": "abc123" } }
  ],
  "stoppedAt": null,
  "error": null,
  "meta": {
    "protocolVersion": "v2",
    "planVersion": "v2.0.0",
    "profile": "S",
    "fallback": null
  }
}
```

失败示例（部分写，执行期在第 2 步断）：

```json
{
  "ok": false, "dryRun": false,
  "steps": [
    { "ok": true,  "op": "ensureBranch", "result": { "branch": "tp/replay", "created": true } },
    { "ok": false, "op": "applyPatch",   "error": "PATCH_FAILED: hunk did not match" }
  ],
  "stoppedAt": 1,
  "error": "applyPatch: PATCH_FAILED: hunk did not match",
  "meta": { "protocolVersion": "v2", "planVersion": "v2.0.0", "profile": "S", "fallback": null }
}
```

校验失败（无副作用、未执行任何 step）：`{ok:false, steps:[], stoppedAt:null,
error:"...; ...", validationErrors:[...], meta:{...}}`。
`code` fallback 路径的返回形状沿用当前 `runInSandbox → toModelOutput(wire, profile)`
（文本 JSON，按 profile 决定 strip/dual），不因多一个 `meta` 破坏现有字段；`meta` 为附加字段。

---

## 3. 兼容策略

| 维度 | v1 `/mcp` | v2 `/mcp/v2` |
|---|---|---|
| 客户端 | 现有所有已连接客户端（F） | 显式选择 v2 的新连接（S） |
| `execute_read`/`execute` schema | `{code:string}`, `required:['code']` —— **一字不改** | §2 的 plan/code 二选一 |
| 默认入参 | `code` | `plan`（typed-first） |
| code fallback | 就是主路径 | 仅 §2.5 四种条件触发 |
| 工具名/数量/顺序 | `search`,`execute_read`,`execute` | 同左，完全相同 |
| annotations | 同左 | 同左（`execute_read` read-only true；`execute` destructive true）——**不改**，避免 conformance 回归 |
| 编码 profile | gemini strip / chatgpt dual / claude text | 完全相同路径 |
| capture / OAuth / 上游 token | 不变 | 不变（只加 `protocolVersion`/`planVersion` 标签） |

**fallback 触发条件**（仅 v2）：见 §2.5 四条；`meta.fallback.reason` 取值 1/2/3/4，必须可回到
capture 的 `requestId`。**工具列表冻结**：两个端点各自在连接时冻结；任何一端点在整个 session
中不得变更工具定义，不发送 `list_changed`；新增 op 属于 `planVersion` 升级，走新版本路径或
新 plan 版本标签，不在已冻结端点上原地改 enum。

回滚：把客户端 URL 指回 `/mcp` 即回到 F 的 schema 与行为；v2 端点可独立下线而不影响 v1
（见 §5）。

---

## 4. 服务器如何暴露两个版本

### 4.1 路径与 transport

- v1：`POST /mcp`（Streamable HTTP，JSON-RPC，`Accept: application/json, text/event-stream`），
  现状不动。
- v2：`POST /mcp/v2`，**同一套 Streamable HTTP handler**，仅把
  `createCodeModeTools(upstreamManager, options)` 换成 v2 版本（schema 工厂接受
  `version:'v2'` 选项，按 §2 返回 inputSchema，handler 内 `plan` 分支调 spike 的
  `validatePlan/executePlan`，`code` 分支沿用 `runInSandbox`）。
- 版本选择发生在**路由层**：解析 `pathname`，`/mcp` → v1 tool factory，`/mcp/v2` → v2 tool
  factory；两者共用 `upstreamManager`、`callTool`、`captureEvent`、`maxCalls`、
  `maxResultChars` 等所有运行时依赖。
- 未知路径（如 `/mcp/v3`）返回 404，不做隐式降级到 v1——避免“以为在用 v2 其实在跑 F”的
  观测污染。

### 4.2 discovery / capabilities / server info

- `initialize` 返回的 `serverInfo`/`capabilities` 在 v1/v2 **字段一致**，只新增可加性字段：
  v2 的 `serverInfo` 增加 `version` 与 `_meta.gateway = { protocolVersion:"v2",
  planVersion:"v2.0.0", supportedInputModes:["plan","code"] }`；v1 不返回该 `_meta`
  （或返回 `protocolVersion:"v1"`），以便 capture 区分。
- `tools/list` 两端点均返回三工具、同名同序；v2 只是 inputSchema 不同。不得新增
  `v2__execute` 之类工具名，也不得改 annotations（ChatGPT/Claude conformance 已 pass）。
- 不发送 `notifications/tools/list_changed`（AGENTS.md；Gemini 不消费）。
- `/.well-known/oauth-protected-resource`（及 `/mcp` 变体）的 `resource` 值需与实际访问
  资源匹配：若 v2 用独立 URL，需评估是共用 `resource: https://<domain>/mcp` 还是增加
  `/mcp/v2` 变体；**实现前必须按各客户端的 RFC 8707 audience 行为确认**（见 §4.4），
  本文不预设可随意复用。

### 4.3 OAuth / redirect 是否共用

- **共用同一套 OAuth 2.1 DCR + PKCE**：`src/oauth.js` 的 redirect allowlist（Google relay、
  两个 ChatGPT 形状）、客户端 profile 解析、`ALLOW_DCR_FOR_CHATGPT` 开关、401
  `_meta["mcp/www_authenticate"]` 挑战都不因版本分叉。客户端拿同一个 token 访问两条路径。
- redirect URI 与 `/.well-known/*` 端点不变；v2 不新增 OAuth 客户端类型，不扩大 allowlist。
- 但 **resource 绑定要显式决策**：ChatGPT 侧要求 `resource` 回显且 audience 绑定
  （`PLATFORM-CONFORMANCE-MATRIX.md §2.2`、`docs/CLIENTS-CHATGPT.md`）。两个方案：
  - A（推荐先验证）：OAuth `resource` 仍是 `https://<domain>/mcp`，把 `/mcp/v2` 视为同一
    资源的第二入口，token 通用；
  - B：为 v2 声明独立 `resource: https://<domain>/mcp/v2`，并确认各客户端授权流程会把
    该值回显且 `tools/call` 的 audience 校验通过。
  在真实 ChatGPT/Claude 客户端上跑通前，该结论记 **unknown / 不得宣称**；Gemini lane 已
  有 full-chain 证据，优先在 Gemini 上验证 A 方案。

### 4.4 Vercel 路由

- 现状：`api/index.js` 是 Vercel serverless 入口，`src/vercel-app.js` 内按 `pathname` 分发
  （`/mcp` 的 POST/非 POST、well-known、401 challenge、capture 开始/跳过）。
- v2 落点：在同一个 `pathname` 分发里增设 `/mcp/v2` 分支，复用 `unauthorized()`、
  body buffer、capture envelope、errorResult 等逻辑；只把 MCP handler 的 tool factory 切到 v2。
- `vercel.json` 若存在路由/rewrites，需让 `/mcp/v2` 走同一 function（无额外函数、无额外
  部署单元）；本文不改任何配置文件，仅记录实现约束。
- capture：v1 已有 `POST /mcp` 的 envelope 采集；v2 必须同样进入 envelope（不能变成
  `captureSkip`），并在 envelope/摘要里带 `protocolVersion`/`planVersion`，否则 A/B 无法按
  版本分账（见 §5.3）。写路径 envelope 覆盖缺口（`online-offline-join`）仍在，写回放以
  受控仓库 verify 为准。

---

## 5. 迁移 / 回滚

### 5.1 客户端如何切换

- 切换是**换 MCP Server URL + 重新 initialize**，不是 session 内切 profile：
  - F：`https://<domain>/mcp`（现有配置，零改动）；
  - S：`https://<domain>/mcp/v2`（实验 opt-in）。
- 新会话：每个 (task, profile, repeat) 用新 `initialize` 拿新 sessionId，不复用上下文
  （`TYPED-PLAN-TEST-PLAN.md §6.3`）。A/B runner 目标 URL 作为参数注入，不写死。
- 在 v2 上，默认生成 `plan`（typed-first）；`code` 只在 §2.5 四条件出现。模型侧提示词
  **逐字相同**（F/S 同 prompt），差异只来自 URL 带来的 schema/description——description 需
  写明“优先 plan，code 仅 fallback”，但不能写成第二套任务指令。

### 5.2 旧会话

- v1 已连接的会话继续按 v1 schema 跑完，不受 v2 上线影响（两端点独立工具定义）。
- 旧会话不会被自动迁移；如需进入 S，必须重新添加 connector / 指向 `/mcp/v2` 并重新授权
  流程（若 resource 方案选 B）。Gemini 的 snapshot 行为决定了“改 URL”是唯一可靠切法。
- 运行期不发送 `list_changed`，不动态改 schema；旧会话若误传 `plan` 给 v1，会被 v1 的
  `required:['code']` 拒绝——这是预期的安全失败，不是 bug。

### 5.3 capture 标签 `protocolVersion` / `planVersion`

- 每个 capture envelope / trace / A/B 结果行打两个维度标签：
  - `protocolVersion`: `"v1"`（`/mcp`）或 `"v2"`（`/mcp/v2`）；
  - `planVersion`: v1 记 `null` 或 `"n/a"`；v2 记 `"v2.0.0"`（op registry + step schema 的
    版本；registry 变更时递增）。
- 同时保留既有 `clientPlatform` 分账语义：分账**只认 envelope 的 `clientPlatform`**，
  缺失进 `unknown`，不与任何 lane 混算；`protocolVersion` 是**第二个正交维度**，不替代平台。
- 标签用途：A/B 按 `(clientPlatform, protocolVersion, profile)` 过滤；回归时能回答“这个
  completion 来自 v1 还是 v2、哪版 plan schema”；回滚后能证明流量已回到 v1。
- 免费模型/归因器输出的分类仍是**待验证假设**（AGENTS.md 硬规则）：必须由 `requestId`
  回到原始 capture、本地复现，未复现标 `unverified`，不作为切换证据。

### 5.4 回滚

1. **客户端回滚（秒级）**：把 connector URL 从 `/mcp/v2` 改回 `/mcp`，重新 initialize；
   v1 从未改动，立即恢复 F 行为。受影响的只是实验会话。
2. **服务端回滚**：下线 `/mcp/v2` 路由（返回 404）即可；v1 handler/工具/OAuth/capture 全不动。
   不需要改数据库或迁移状态。
3. **数据回滚**：A/B 报告/基线只读冻结文件；若某轮口径不一致（baseline===current、借分母、
   跨平台硬比），该轮作废重跑（`TYPED-PLAN-TEST-PLAN.md §7 A5/A6`），不“回滚数据”而是丢弃。
4. **触发条件**：任一硬门槛未达、fallback 率 >50%（S≈F）、或 conformance gate fail →
   不切默认、保持 F；已 opt-in v2 的客户端可继续实验，但不得对外宣称“已升级”。

---

## 6. A/B 接入（Profile F / S）

- **F（对照）**：URL `/mcp`，`execute({code})` / `execute_read({code})`；基线从冻结
  `explore/baselines/l1-smoke.json` 读，且必须先确认其 `clientPlatform=gemini`，否则重冻。
- **S（实验）**：URL `/mcp/v2`，`execute({plan})` / `execute_read({plan})` 为主，
  `execute({code})` 仅 fallback；fallback 必须带 `meta.fallback` 才能计入“S 真的用了 plan”。
- **不变量（继承 `TYPED-PLAN-TEST-PLAN.md §0.2`，任一破坏即该轮作废）**：三工具同名同序、
  schema 过 `sanitizeTool`、读写分层（`execute_read` 写 op 服务端拒绝）、权限/OAuth/capture
  不变、写语义 `dryRun→真写→verify` 不变、任务集与 prompt 逐字相同、token budget/maxTurns/
  deadline 相同。
- **任务集**：40 条（L1 30 + TP-01…TP-10）；按平台独立 lane，Gemini 为主判据；ChatGPT/
  Claude 无真实 plan → 只报 conformance/protocol-ready，不进切换判据。
- **环境递进**：fake（零网络，接线验证）→ replay（口径回归，非质量证据）→ real（唯一可
  用于切换决策的数据，40×3 重复、反序、每任务新 session）。写回放只在受控仓库跑。
- **门槛沿用 A1–A7**：completion(S) ≥ F−3pp、tokens/task(S) ≤ F、repair 降 ≥30%、写回放
  成功率 ≥ F、基线口径正确、平台独立无硬比、conformance 四检查全 pass。
- **数据不够不切默认**：任一 lane 无 ≥3 次有效 real 重复、或某硬门槛未达、或分类被判
  unverified/口径不一致 → 保持 F 默认，S 仅 opt-in；只有 Gemini 全部门槛通过 **且** lead
  人审确认，才能提“把 S 设为默认”的后续提案。**本文不执行任何切换、不改生产配置。**

---

## 7. 风险与验收清单

### 7.1 风险表

| ID | 风险 | 证据/来源 | 缓解 |
|---|---|---|---|
| R1 | 原地改 schema 破坏 Gemini snapshot / 工具列表冻结 | `AGENTS.md`、C5、G2 | §1 版本路径；v1 一字不改；两端点各自冻结 |
| R2 | `oneOf`/`$ref`/数组 schema 被 sanitize 拆坏或 Gemini 400 | C1、§3.2、AGENTS.md | P6 先把 §2 schema 过 `sanitizeTool` fixture；失败按 §2.1 回退 `anyOf`+服务端强校验或内联 `$ref`；未过不得宣称可用 |
| R3 | 客户端不接受 array-of-objects 平铺 step schema（所有平台 `unknown`） | C1/C2、§3.2 | flat step + `op` enum（不用 per-op `oneOf`）；真机 `tools/list` 捕获；未知则 protocol-ready，不宣称 |
| R4 | `code`+`plan` 同时出现导致语义歧义 | 本文 §2.3 | 三层防御（oneOf + 服务端拒绝 + additionalProperties:false）；负例测试 |
| R5 | 写 op 借 plan 绕过审批 / annotations 不是安全边界 | T4、`docs/SANDBOX-SECURITY.md:37` | 服务端 dryRun/approve 状态机 + `execute_read` 服务端过滤写 op；真机确认确认 UX 触发 |
| R6 | 执行期部分写无法回滚 | spike `stoppedAt`、B11 | 原样透出 `steps`/`stoppedAt`；不静默吞；写回放三步校验 |
| R7 | 静默截断被模型当完整结果使用（E8） | TP-02、B11 | step result 带 `truncated` 字段时须可见；不因 plan 隐藏 |
| R8 | OAuth `resource`/audience 在 v2 URL 上不匹配 | §4.3、ChatGPT C2–C4 | 两方案先验证 A；真机前标 unknown；不随意扩 allowlist |
| R9 | S 退化为 F（fallback 率过高） | `TYPED-PLAN-TEST-PLAN.md §9.2` | 观测 fallback 率/reason，>50% 收益存疑；`meta.fallback` 强制可观测 |
| R10 | capture 写路径覆盖缺口导致误判 | `online-offline-join` | 写回放以受控仓库 verify 为准，capture 仅辅助；标签只作分账 |
| R11 | 免费模型建议被当成“S 更好”的结论触发切换 | AGENTS.md 硬规则 | 分类回 `requestId` 本地复现；未复现 `unverified`；lead 人审 |
| R12 | 工具 description 触发 ChatGPT 代码执行安全审查 | §3.2、`OPEN-SOURCE/WEB-CLIENTS.md` | description 保留“code 仅 fallback”措辞；真机前 ChatGPT lane 只报 protocol-ready |

### 7.2 验收清单（实现落地后逐条勾；本文不执行）

**协议 / schema**
- [ ] `/mcp` 的 `execute`/`execute_read` inputSchema 与现状逐字一致（diff 为空）。
- [ ] `/mcp/v2` 返回 `search`/`execute_read`/`execute` 三工具，同名同序；无第四工具。
- [ ] v2 三工具 annotations 与 v1 完全一致；无 `list_changed` 发送。
- [ ] §2 两个 inputSchema 过 `sanitizeTool`：所有 array 有 `items`，无多类型裸字段，
      `oneOf` 分支数 ≤8；失败则按 R2 回退并记录。
- [ ] 负例：`{code, plan}` 同时给被拒（schema + 服务端两层）；未知 op / 缺参 / 错类型
      在执行任何 handler 前拒（E3/E2）。
- [ ] `execute_read` 服务端拒绝全部 `effect:'write'` op（即使 schema enum 写错）。
- [ ] dryRun 写 op 无真实副作用且返回 `{diff, preview, dryRun:true}`；无审批的真写在
      服务端被拒；`dryRun→真写→verify` 三步齐全。
- [ ] 执行期失败返回稳定形状 `{ok,dryRun,steps,stoppedAt,error}`，跳过的 step 不出现在
      `steps`；结果走文本 JSON，Gemini 无 `structuredContent`。
- [ ] fallback 四条件下 `meta.fallback.reason` 正确写入 trace/capture；≤2 次 plan 错才 fallback。

**路由 / 平台**
- [ ] `/mcp/v2` 走同一 Streamable HTTP + 同一 OAuth/redirect；未知 `/mcp/v3` 返回 404。
- [ ] v2 POST 进 capture envelope（非 `captureSkip`），带 `protocolVersion`/`planVersion`。
- [ ] discovery `capabilities` 一致；v2 `_meta.gateway` 为可加字段。
- [ ] Gemini lane：真机 `tools/list` 三工具 + G3/G4/G5/G6/G7（plan accepted、write 确认、
      structuredContent 非泄漏、错误形态可自纠）。
- [ ] ChatGPT/Claude：无真实 plan 时只标 protocol-ready / unknown，不宣称 A/B 通过；
      Claude callback allowlist 缺口（矩阵 A2/L0）仍是前置阻断。

**A/B / 决策**
- [ ] 每个 (task,profile,repeat) 新 session；prompt/budget/maxTurns 逐字相同；顺序反序抵消。
- [ ] 按 `(clientPlatform, protocolVersion, profile)` 分账；`unknown` 不借分母；无跨平台硬比。
- [ ] 基线只读冻结文件，无 `baseline===current`。
- [ ] A1–A7 逐项有 pass/fail/no-measurement；fallback 率/reason 分布已报告；错误 8 类各有
      样本且 `unverified` 单列。
- [ ] 数据不足或任一硬门槛未达 → 保持 F 默认；无任何 commit/push/deploy、未改
      `src/scripts/tests/README/其他 docs/workflows`。

---

> 本文件是 B14 版本化接入的**设计稿**，唯一产物。所有路由/工厂/标签均为实现约束描述，
> 不是已落地代码。未创建、修改任何生产代码、测试、配置或其他文档；未 commit、push、deploy。
