# Code Mode 沙箱与 host bridge 安全审计

> 审计日期：2026-11-23（Asia/Singapore）。审计对象：`src/codemode.js`、`src/codemode-v2.js`、`src/typed-plan.js`、`src/file-write.js`、`src/github-helpers.js`、`src/tool-format.js`、`src/result-normalize.js`、`src/client-profile.js`、`src/capture.js`、`src/upstreams.js`、`src/server.js`、`src/sanitize.js` 及相关测试。
>
> 方法：静态阅读 + 本地只读动态探针（`runInSandbox` 直接调用、假 `callTool`、临时脚本放在仓库外的 `%TEMP%`，已删除）。**未修改任何源码/测试/配置，未 commit / push / deploy。**
>
> **并发开发提示**：本次审计期间其他 agent 正在改动 `src/capture.js`、`src/result-normalize.js`、`src/typed-plan.js` 等文件。下面的行号以审计时读到的工作树快照为准；代码片段是证据本身，行号可能因后续提交漂移。特别是 F-08 描述的问题在审计结束前已被另一个 agent 修复（见该条注记），本报告仍保留分析以说明威胁模型。
>
> 自由模型输出不是事实来源（AGENTS.md 硬规则）：本报告所有结论均可由下方“复现建议”在本地用确定性输入复现，未引用任何 free-model 建议作为证据。

---

## 0. 结论摘要

| # | 级别 | 问题 | 位置 |
|---|---|---|---|
| F-01 | **高** | 上游/上游错误消息中的 token 与敏感文本无脱敏回显给模型与 JSON-RPC 响应 | `src/upstreams.js:190-194`, `src/tool-format.js:428-430`, `src/codemode.js:1075-1076, 827-845`, `src/server.js:174-179, 593-600` |
| F-02 | **高** | capture envelope 将请求头（含 `Authorization: Bearer ...`）、原始 body、OAuth refresh/client secret、完整 sandbox code 与全部 tool args 原样落盘/送 HTTP/R2 sink | `src/capture.js:44-48, 50-54, 740-754`, `src/upstream-auth.js:420-424, 456-476, 505-508`, `src/codemode.js:1641-1646` |
| F-03 | **高** | 截断审计 `possibleModelTruncation` 可被上游文本 `"truncated": false` 抑制（audit poisoning） | `src/capture.js:174-184, 242-256` |
| F-04 | **中高** | `runTypedPlan` / `github_actions_*` bridge 调用不经 50 次工具预算；v1 typed-plan 无 step 数上限，形成调用预算/allow-deny 绕过与 DoS 面 | `src/codemode.js:1126-1144, 1174-1191`, `src/typed-plan.js:173-186`（审计快照） |
| F-05 | **中高** | `execute` 模式下 plan 的 per-step `approve:true` 自授权真实写操作；approve 不是针对 plan 作者的授权边界 | `src/typed-plan.js:124, 136-140, 205-217`, `src/codemode-v2.js:64, 120-125` |
| F-06 | **中** | guest 可直触 `__bridge.invoke`，绕过 `__dshInvoke` 的错误重建；`codemode.__proto__` 命名工具可污染 guest 侧 `codemode` 对象原型 | `src/codemode.js:122-127, 1258-1273, 1307` |
| F-07 | **中** | 写路径截断检查不一致：`file-write.js` 只查 in-band marker、`fileText` fallback 默认 `truncated:false`、typed-plan `applyPatch` 曾完全不查（并发修复中） | `src/file-write.js:265-272`, `src/codemode.js:277-278, 945-950`, `src/typed-plan.js:78-96` |
| F-08 | **中** | 上游可控 `truncated:false` / `--- TRUNCATED ---` 文本可进入 canonical 视图与模型输出，误导模型认为数据完整 | `src/tool-format.js:437, 443`, `src/result-normalize.js:327+`（快照 `:282-321`） |
| F-09 | **中** | `boundResult` 在 MCP envelope 层静默截断，不设置结果级 `truncated` 布尔 | `src/server.js:82-115` |
| F-10 | **低（设计确认）** | client profile 由不可信 header/UA/clientInfo 决定，**明确不是安全边界**；annotations 只影响客户端提示；未发现可通过 profile 注入额外字段 | `src/client-profile.js:1-20, 100-125, 229-240`, `src/server.js:300, 375-389` |
| F-11 | **低** | guest 沙箱逃逸面（Function/eval/constructor/Intl/Date/原型）实测全部关闭；引擎级 QuickJS 隔离成立 | `src/codemode.js:122-440, 1298-1308`, `tests/true-isolation.test.js` |

以下逐条展开。

---

## 0.1 架构与信任边界（用于理解后续所有发现）

```
模型(不可信代码/plan)
   │  execute({code}) / execute_read({code}) / v2 execute({plan|code})
   ▼
MCP handler: src/codemode.js:1619-1648 / src/codemode-v2.js:185-301
   │  readOnly = (name === 'execute_read')  ← 唯一的真实只读开关，宿主决定
   ▼
runInSandbox(): src/codemode.js:1060-1354
   │  GUEST_PRELUDE 字符串拼接（122-440）+ toolLines（1246-1273）+ 用户函数（1278-1294）
   ▼
QuickJS（run SDK 2.1.13, worker 线程, 冻结内建原型）
   │  唯一出口 __bridge.invoke(name,args) → registry (1085-1226) → 宿主函数
   ▼
宿主：callTool → upstreams.callTool → MCP upstream；capture.captureEvent；toModelOutput
```

关键事实：
- **引擎边界成立**（F-11）：guest 没有 `process/require/fetch/Buffer/global`；`eval` 为 undefined；guest realm 的 `Function('...')` 抛 `TypeError: Function constructor is not allowed`；`Object.prototype` 冻结；`Intl` 不存在，`Date` 存在（UTC 语义）。
- **bridge 函数全部在宿主 realm 执行**：计数、校验、审计、上游调用都在 `registry`（`codemode.js:1085-1226`）。沙箱隔离不是授权边界。
- **readOnly 由宿主决定**（`codemode.js:1621-1622` 过滤 usable/unavailable；`1128-1139` 强制 typedPlanReadOnly；`codemode-v2.js:194-204`）。
- **annotations 来自上游**，只影响客户端是否少弹确认；不是安全边界（`server.js:375-389`，`client-profile.js:229-240`）。

---

## F-01（高）上游/上游错误消息中的 token 与敏感文本无脱敏回显给模型与 JSON-RPC 响应

**证据链（4 处代码片段）：**

```js
// src/upstreams.js:189-194 —— 只加前缀，零脱敏
function upstreamError(name, action, err) {
  const error = new Error(`[upstream:${name}] ${action}: ${messageOf(err)}`);
  error.cause = err;
  return error;
}

// src/tool-format.js:427-430 —— isError 时把全部 error text 抛到 guest
const allText = texts.join('\n');
if (r.isError === true) {
  throw new Error(allText || 'upstream tool returned an error');
}

// src/codemode.js:1075-1076 —— bridge 错误 → 原样 message
const hostErrorMessage = (err) => (err instanceof Error || (err && typeof err.message === 'string'))
  ? String(err.message) : String(err);

// src/codemode.js:833 —— 进入模型可读的 result 字符串
const message = `execute error: ${rawMessage}${loc}`;
```

`server.js:174-179`（工具错误）与 `server.js:593-600`（JSON-RPC 500）同样用 `errorMessage(error)` 直接拼接 `err.message`。

**实测复现**（临时脚本 `%TEMP%\codemode-probe2.mjs`，已删除）：
```js
const out = await runInSandbox({
  code: `async () => { try { return await codemode.svc__get_file({}); }
         catch(e){ return {msg:e.message, type:e.type, hostOrigin:e.__dshHostOrigin}; } }`,
  tools: usable, unavailableTools: unavailable,
  callTool: async () => { throw new Error('upstream failed with token ghp_SUPERSECRET123'); },
});
// out.result = {"msg":"upstream failed with token ghp_SUPERSECRET123","hostOrigin":true}
```
`ghp_SUPERSECRET123` **原样进入模型上下文**，并随 `captureEvent('sandbox',...)` 落盘（见 F-02）。

**威胁模型**：上游 SDK（stdio MCP server 或 HTTP transport）的错误常含响应体、`Authorization` 头、带 query token 的 URL；一个被提示注入的模型可以故意触发错误并用 `try/catch` 把 token 作为返回值带走。即使上游是诚实的，401/403 文本也可能包含凭据片段。

**修复建议（未实施）**：在 `hostErrorMessage`、`unwrapResult` 的 isError 分支、`server.js` 的 `errorMessage` 增加统一脱敏规则：按 `Bearer\s+\S+|gh[pousr]_[A-Za-z0-9]+|sk-[A-Za-z0-9]+|refresh_token=[^&\s]+|client_secret=[^&\s]+|Authorization:\s*\S+` 等模式替换为 `[REDACTED]`；错误体只保留固定上限（如 4KB）和状态码。

**回归测试建议**（新建 `tests/security-redaction.test.js`）：
```js
test('upstream error token does not reach model', async () => {
  const out = await runInSandbox({
    code: `async () => { try { await codemode.svc__get_file({}); } catch(e){ return e.message; } }`,
    tools: [{name:'svc__get_file',server:'svc',tool:'get_file',annotations:{readOnlyHint:true},inputSchema:{type:'object',properties:{}}}],
    callTool: async () => { throw new Error('Bearer ghp_LEAK123'); },
  });
  assert.ok(!out.result.includes('ghp_LEAK123'));
});
```

---

## F-02（高）capture envelope 原样持久化凭据与完整 sandbox code

**证据：**

```js
// src/capture.js:44-54
export function captureEvent(type, payload) {
  const store = captureStore.getStore();
  if (!store) return;
  store.events.push({ type, ts: Date.now(), payload });   // 无脱敏、无逐字段上限
}
export function captureHeaders(headers = {}) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) out[name] = value; // 全量复制
  return out;
}

// src/capture.js:740-750
request: { method: req.method, url: req.url,
           headers: captureHeaders(req.headers),          // 含客户端 Authorization
           raw: req.__gatewayRawBody ?? null },           // 含 initialize auth / tool args
...
response: { status: res.statusCode, headers: captureHeaders(res.getHeaders?.() ?? {}),
            raw: overflow ? null : Buffer.concat(chunks).toString('utf8'), ... }
```

sink 路径（同文件 `:336-340` file、`:356-379` HTTP、`:381-407` R2、`:832` fallback POST）直接 `JSON.stringify(envelope)`，**没有任何 redaction**。唯一的脱敏在 `:329-334`，只针对 `[capture_skipped].detail` 这一条诊断日志。

另有两条独立泄漏路径（subagent 核实并实测）：
- `src/upstream-auth.js:420-424` 把 `authorization: Bearer ${accessToken}` 写进 `upstream_http` capture event；`:456-466` 的 token-refresh POST body 含 `refresh_token`/`client_id`/`client_secret` 原样入 event；`:473-476` 记录 token endpoint 原始响应（新 access/refresh token）；`:505-508` CAS 冲突时记录 `expectedRefresh`/`winnerAccess` 原始 token 字符串。
- `src/upstreams.js:24-38` 的 `tapTransport` 捕获完整入/出 MCP frame（参数与工具结果）；`:489-492` 捕获完整 `upstream.result`。

**sandbox 专属面**：
```js
// src/codemode.js:1641-1646
const wire = typeof full.toJSON === 'function' ? full.toJSON() : full;
captureEvent('sandbox', { tool: readOnly ? 'execute_read' : 'execute',
                          code, output: wire });
return toModelOutput(wire, profile); // 只在这里剥离 logs/toolCalls
```
`wire` 来自 `makeOutput().toJSON()`（`:563-577`），含 `{result, logs, toolCalls}`。模型输出侧 `toModelOutput` 删掉了 `logs/toolCalls`，但 capture 保存的是**投影前**的数据：完整模型代码 + 全部 tool args。模型若把上游返回的 key 硬编码进脚本，或工具参数本身含 token，就落盘。

**这是有意为之的设计**（`tests/capture.test.js:23-45` 明确断言 “capture preserves credential headers verbatim”，`:63-68` 断言 `captureHeaders` 不脱敏；`docs/OPEN-SOURCE/EXPORT-IMPLEMENTATION.md:95-96` 说 capture 数据“never redacted or rewritten”），因此列为**暴露面而非编码 bug**：该网关是个人工具，capture 桶/目录必须当作 secret 存储对待。

**修复/缓解建议**：
1. 在 `captureEvent` Sink 边界增加可配置 redactor（默认开启），对 headers、body、tool args、sandbox code 中的 `Authorization`/token 模式脱敏；保留原始 event 仅用于本地 `sink:'file'` + 显式 `CAPTURE_KEEP_SECRETS=1` 调试。
2. 明确文档化 retention 与访问控制；Vercel R2 bucket 不得公读。
3. 对 `code`/`toolCalls` 设逐字段上限（如 64KB / 200 条）。

**回归测试建议**：在 `tests/capture.test.js` 新增：file sink + `captureEvent('upstream_http',{body:'refresh_token=SECRET'})`，断言落盘的 envelope 不含 `SECRET`（当前会失败——这正是待修行为）。

---

## F-03（高）截断审计可被上游文本 `"truncated": false` 抑制

**证据：**

```js
// src/capture.js:174-184（审计快照；并发编辑后为 175-185）
function hasExplicitTruncationMark(...values) {
  return values.some((value) => {
    if (typeof value === 'boolean') return value === true;
    if (value && typeof value === 'object' && value.truncated === true) return true;
    const text = typeof value === 'string' ? value : (() => {
      try { return JSON.stringify(value) ?? ''; } catch { return ''; }
    })();
    return /--- TRUNCATED ---|…\[truncated\s*\d*\]|(?:^|["'\s])truncated["'\s]*:/i.test(text);
  });
}
```
第三个分支 `(?:^|["'\s])truncated["'\s]*:` 只匹配**字段名 + 冒号**，不检查布尔值。`JSON.stringify({truncated:false})` 产生 `{"truncated":false}`，`"` + `truncated` + `"` + `:` 完全命中。

`:242-256`：
```js
const marked = hasExplicitTruncationMark(output, visible, response?.truncated, response?.raw);
...
possibleModelTruncation: sourceBytes > 0 && modelOutputBytes < sourceBytes && materiallyShorter && !marked,
```
`marked=true` 直接把 P0 静默截断检测关掉。且 `text` 由 `JSON.stringify(visible)` 得到，任何嵌套 `truncated:false` 字段都会触发。

**复现（subagent 实跑成功）**：
```js
buildModelOutputAudit({ events: [
  { type:'upstream', payload:{ result:'A'.repeat(1000) } },
  { type:'sandbox', payload:{ output:{ result:'A'.repeat(150) + ' truncated: false' } } },
]}).possibleModelTruncation  // false；期望 true
```

**威胁模型**：这正是 `docs/eval/capture-verification-2026-11-23.md` 所记录的静默截断事故类别——审计信号本身可被上游数据污染，导致 analyzer 永远看不到真阳性。

**修复建议**：把正则改为只匹配“真·截断声明”：删除 `(?:^|["'\s])truncated["'\s]*:` 分支；对对象只在 `value.truncated === true`（已由上一分支覆盖）或 `truncation` 对象存在时判定；文本分支只接受 `--- TRUNCATED ---` / `…[truncated N]` 两种固定 marker。

**回归测试建议**：在 `tests/capture-truncation-audit.test.js` 加 `upstream(FULL)` + `sandbox(FULL.slice(0,150) + ' truncated: false')`，断言 `possibleModelTruncation === true`。

---

## F-04（中高）runTypedPlan / github_actions_* 桥接调用绕过工具预算与 allow-deny

**证据：**

```js
// src/codemode.js:1118 —— 预算只数 registry.tool()
remainingCalls: () => Math.max(0, maxCalls - calls),
// src/codemode.js:1212-1214 —— 只有 tool() 递增 calls
calls += 1;
if (calls > maxCalls) throw new Error(`tool call limit (${maxCalls}) exceeded`);

// src/codemode.js:1174-1176 —— Actions helper 明确不计费
// Batch 11 · GitHub Actions read-only REST helpers. ... These do NOT consume the upstream tool-call budget.
github_actions_list_workflow_runs: (opts) => githubActionsListWorkflowRuns({ fetch: hostFetch ?? ..., env, ...(opts ...) }),

// src/codemode.js:940-943 —— typed-plan 的 io adapter 直接调用 callTool，不经 registry.tool
const invoke = async (tool, args) => {
  if (!tool) throw new Error('typed-plan io: required upstream tool is unavailable');
  return unwrapResult(await callTool(tool.server, tool.tool, args ?? {}));
};
```

- `github_actions_*` 每次调用触发宿主 REST GET（带 `GITHUB_TOKEN`），只受 SDK `maxBridgeRequests: 2048`（`codemode.js:1305`）与总 deadline 约束；单次 execute 可发数千次外部请求。
- `runTypedPlan(plan)` 的 v1 入口对 plan 长度**没有上限**（审计快照 `src/typed-plan.js:180-182` 只要求非空数组；v2 schema 才有 `maxItems:64`）。每个 read/write step 都经 `invoke()` 直连 `callTool`，完全不递增 `calls`。一条包含大量 `readFileRange`/`repoGrep` step 的 plan 可以几百次调用某个工具，绕过 `maxCalls=50`，并对 allow/deny 语义构成压力（虽然工具本身仍来自已挂载集合，不是任意工具）。
- `services` / `hasTool` / `normalizeResult` / `precheckText` 等纯函数桥也不计费，但它们无 I/O（属合理）。

**实测**（`codemode-probe2.mjs`）：普通 `codemode.svc__get_file` 在 `maxCalls:2` 下第 3 次被拒，符合预期；说明绕过只存在于上述专用桥。

**修复建议**：
1. 给 `registry.runTypedPlan` 传入一个 `budget` 回调，让 `executeTypedPlan` 的 io adapter 每次 `invoke()` 都计入 `calls`；或按 plan step 数一次性扣减 `calls += plan.length`。
2. 对 `github_actions_*` 单独设限（如每 execute 最多 10 次、每秒最多 2 次）并计数到同一预算。
3. v1 typed-plan validator 增加 `plan.length <= 64`（与 v2 对齐）。

**回归测试建议**：`maxCalls:2` + 3-step `runTypedPlan` 读 plan，断言第 3 step 得到预算错误且上游 `callTool` 只被调用 2 次。

---

## F-05（中高）plan 的 per-step `approve:true` 自授权真实写操作

**证据：**

```js
// src/typed-plan.js（审计快照 124/136-140/215-217）
const CONTROL_FIELDS = new Set(['op', 'approve']);
function approvalSet(approve) {
  if (Array.isArray(approve)) return new Set(approve);
  if (typeof approve === 'string') return new Set([approve]);
  ...
}
if (!dryRun && step.approve !== true && !approved.has(name)) {
  errors.push(`${at}: write op "${name}" requires dryRun or explicit approve`);
}
```
`approve` 是 plan 里的普通布尔字段（v2 schema 也明确暴露：`src/codemode-v2.js:64` `approve: {type:'boolean'}`），与声明写操作的是同一个不可信 plan。任何能影响模型输出/被提示注入的内容都可以给自己的 write step 打 `approve:true`。全局 `approve:['applyPatch']` 同理只是 op 名字符串。

**边界厘清**：这**不是 readOnly 逃逸**。`readOnly` 是宿主强制的（`codemode.js:1128,1139`；`codemode-v2.js:194-204`），`validateTypedPlan` 对 `effect==='write'` 的 op 一律拒绝（`typed-plan.js:211-214`），测试覆盖充分（`tests/typed-plan-engine.test.js:158-180` 等）。问题只在于 **execute 模式下的 dryRun 防护可被 plan 作者单方面解除**。如果产品定义是“模型自己批准自己的写操作”，那这是设计而非 bug；如果定义是“dryRun 是安全闸门”，则当前实现不构成授权边界。

**修复建议**：若要让 approve 成为边界，必须由宿主侧提供（例如 HTTP 请求级 `X-Allow-Writes` 或会话态 capability），plan 内 `approve` 字段只读且被宿主值覆盖；否则在文档中明确说明 approve 不是安全保证。

**回归测试建议**：现有测试（`typed-plan-engine.test.js:149-155` 等）已把自授权当作期望行为，需先决定是否改变契约再写测试。

---

## F-06（中）guest 可直触 `__bridge.invoke`；工具名可污染 guest 侧 `codemode` 对象

**(a) `__bridge` 在 guest 全局可达。** 探针结果：
```
bridge-direct => {"bridge":"function","keys":null}
bridge-invoke-raw => {"r":{"__hostError":1,"message":"unknown tool: nope","type":"Error"}}
```
`syncHostFunctions: { __bridge: { invoke } }`（`codemode.js:1307`）由 run SDK 注入， guest 可绕过 `__dshInvoke`（`:127`）直接调用任意 registry 方法，拿到的是原始 `{value}` / `{__hostError,...}` 而不是重建后的 guest Error。后果：
- 依赖 `e instanceof Error` / `e.__dshHostOrigin` 的 guest 代码会收到不同语义；
- 错误对象在 `__dshInvoke` 路径会被 `new Error(r.message)` 重建（`:127`），但直触路径不会，脚本行为分叉。
- **不构成宿主逃逸**：registry 本身仍是所有能力的唯一入口，直接调用 `tool`/`stub` 的实测结果显示 readOnly 边界成立（`hasToolWrite:false`、写工具返回 `unknown tool`、stub 返回 `use execute() instead`）。

**(b) 工具名未经保留字过滤。** `sanitizeToolName`（`src/codemode-util.js:24`）原样返回 `constructor`、`__proto__`、`__dshInvoke`、`stub` 等：
```
constructor -> constructor ; __proto__ -> __proto__ ; stub -> stub ; __dshInvoke -> __dshInvoke
```
绑定代码：
```js
// src/codemode.js:1258-1260
const bind = (key, invokeExpr, asPromise = false) => {
  toolLines.push(`codemode[${JSON.stringify(key)}] = __dshHide(${asPromise ? 'async ' : ''}(args) => ${invokeExpr});`);
};
```
实测把名为 `__proto__` 的工具放入 guest：
```
{"codemodeProto":false,   // Object.getPrototypeOf(codemode) !== Object.prototype
 "protoOwn":false,        // __proto__ 不是 own property（赋值改了原型）
 "ctorOwn":true, "ctorType":"undefined", "objProtoFrozen":true}
```
即上游提供的工具名可以把 `codemode` 对象的原型替换成一个函数，破坏后续通过原型链访问的方法。由于 `Object.prototype` 冻结，逃逸不到宿主；但这是一个真实的 guest 侧完整性问题，且工具名来自上游 MCP server（不可信输入面）。

**修复建议**：在 `byIdent` 构建前过滤 `RESERVED_TOOL_IDENTS = new Set(['__proto__','constructor','prototype','__dshInvoke','__dshHide','__bridge','codemode','search','console','stub','tool','log',...])`，或用 `Object.create(null)` + `Object.defineProperty` 绑定 guest 工具表，杜绝原型赋值语义。

**回归测试建议**：把名为 `__proto__`/`constructor` 的工具传给 `runInSandbox`，断言 `Object.getPrototypeOf(codemode) === Object.prototype` 且所有正常工具仍可调用。

---

## F-07（中）写路径截断检查不一致

三条写路径的截断防护强度不同：

1. **sandbox `codemode.applyFilePatch`（强）** — `codemode.js:361-363`：
```js
if (nf.truncated || text.includes("--- TRUNCATED ---")) return { ok: false,
  error: "refusing to patch a truncated read for " + item.path + ": re-read the full file before writing" };
```
结构化 flag + in-band marker 都查。

2. **`file-write.js:265-272`（弱）** — 只查 in-band marker：
```js
// 注释明确说 upstream flags 由 sandbox orchestration 检查
if (rawText.includes('--- TRUNCATED ---')) throw ...
```
单独使用 `applyFilePatches` 的调用方若传 `{text:'...', truncated:true}`（无 marker）不会被拒。

3. **typed-plan `applyPatch`（审计开始时缺失，期间已被并发修复）** — 原快照 `src/typed-plan.js:76-94` 只读 `current.text` 就直接 `applyTextPatch` 并 `writeFile`，完全不查截断。审计结束前读取到的当前代码已加：
```js
// src/typed-plan.js:87-96（当前工作树）
const truncated = !!current && typeof current === 'object' && current.truncated === true;
const marker = typeof text === 'string' && text.includes(TRUNCATED_MARKER);
if ((truncated || marker) && ctx.allowTruncatedRead !== true) {
  const err = new Error('refusing to applyPatch on a truncated read for ' + args.path + ...);
  err.code = 'PATCH_READ_TRUNCATED';
  throw err;
}
```
**审计建议**：这个修复引入了 `ctx.allowTruncatedRead` 逃生开关，需要确认它不会被 guest 的 plan 字段控制（当前只有宿主可传 ctx），并补上“marker 在 text 中但 flag 为 false”以及“flag 为 true 但无 marker”两组测试。

4. **`fileText` fallback（弱）** — `codemode.js:945-950`：
```js
if (value && typeof value.text === 'string') return { text: value.text, sha: value.sha ?? null, truncated: false };
return { text: null, sha: null, truncated: false };
```
未调用宿主的 `explainTruncation`（`result-normalize.js:327+`），`--- TRUNCATED ---` 文本会原样进入 text 且 flag 为 false；配合旧版 typed-plan `applyPatch` 会把 marker 写进仓库文件。

**修复建议**：统一到一个 `isTruncatedRead(raw, text)` 宿主函数（复用 `explainTruncation`），所有写路径调用它；禁止任何写路径接受 guest 传入的 truncated 覆盖值。

---

## F-08（中）上游可控截断文本进入 canonical 视图与模型输出

**证据：**
```js
// src/tool-format.js:437, 443（unwrapResult）
if (r.structuredContent !== undefined && !hasOtherBlocks) return r.structuredContent;
...
try { return JSON.parse(texts[0]); } catch { return texts[0]; }
```
上游 JSON 里的 `truncated:false` 字段原样透传；`truncateResultValue` 的 `shrinkObject` 保留已有 `truncated` 键，因此输出可能同时含 `truncated:false` 与 `--- TRUNCATED ---` 标记键。模型看到自相矛盾的“未截断 + 截断标记”数据，可能漏报截断。

另一个方向：`result-normalize.js`（审计快照 `:294-305`）的 `flagFrom` 把任何非空字符串 `truncated` 值当作截断原因：
```js
if (typeof raw === 'string' && raw.trim() !== '') return `upstream:${raw.trim().slice(0, 160)}`;
```
即上游发 `truncated:"benign"` 会让 canonical 视图显示 `truncated:true`——这是保守方向（误报），危害较小，但会被用来消耗模型注意力。

**复现建议**：`truncateResultValue({truncated:false, big:'B'.repeat(5000)}, {maxChars:200})`，断言输出不含两个互相矛盾的键（当前二者并存）。

---

## F-09（中）`boundResult` 静默截断，无结果级 `truncated`

```js
// src/server.js:82-115
let truncated = false;  // 仅函数内使用
...
return truncated ? { ...result, content } : result;   // 从不写 result.truncated
```
文本块被截成 `…[truncated N chars by gateway...]`，但结果对象没有 `truncated` 布尔（实测返回 keys 只有 `['content']`）。`tests/result-bound.test.js:16-33` 只断言 in-band 文本。下游若按 `result.truncated === true` 判断会漏掉；capture 的 `hasExplicitTruncationMark` 能识别 `…[truncated N]` 文本形式（F-03 正则第二分支），所以审计侧能看到，但数据消费者不能。

**修复建议**：`return truncated ? { ...result, truncated: true, content } : result;`，并在 `encodeToolResult`/`encodeModelOutput` 中保留该字段。补充测试断言。

---

## F-10（低，设计确认）profile / annotations 不是安全边界

`src/client-profile.js:4-7` 明确写明 “NOT a multi-tenant or security layer”。`resolveClientProfile`（`:100-125`）从不可信 HTTP header `x-gateway-client-profile`、`clientInfo.name`、User-Agent、环境变量解析 profile；`classifyExplicit`（`:67-74`）只接受精确 token，`__proto__` 等值回退 gemini；`CLIENT_PROFILES` 冻结（`:28-32`）；`encodeModelOutput`（`:179-199`）只用白名单 id 查表。**未发现通过 profile 注入额外字段或原型污染的向量。**

`annotations.readOnlyHint` 来自上游且只被 `applyProfileToTools`（`client-profile.js:229-240`）与 `server.js:384-389` 复制到 tools/list，用于客户端提示。真实只读判定在 `isReadOnlyTool`（`codemode.js:447-449`）与宿主过滤（`1621-1622`）。`docs/SANDBOX-SECURITY.md:37-39` 已有相同告诫。**结论：平台隔离/编码是展示层，不是权限层；这一点在文档和实现中一致，不构成漏洞。**

---

## F-11（低，正面结论）guest 沙箱逃逸面实测关闭

本地探针结果（全部通过）：

| 探针 | 结果 |
|---|---|
| `typeof eval` | `undefined`；调用抛 `TypeError: not a function` |
| `(function(){}).constructor('return 40+2')()` | `TypeError: Function constructor is not allowed` |
| `(async()=>{}).constructor(...)` | 同上 |
| `process/require/Buffer/module/global/fetch/globalThis.process` | 全部 `undefined` |
| `Object.prototype` 可写？ | `Object.isFrozen(Object.prototype) === true`；赋值无效 |
| `Intl` | `undefined`；宿主通过 prelude 的 `codemode.formatDate`（`codemode.js:187-188`）与 UTC `Date` getter 规避（探针 `Date.toISOString()` 正常） |
| `__dshHide`（`codemode.js:124`） | 对注入函数 `Object.defineProperty(f,'constructor',{value:undefined})`，历史 `.constructor` 探针全灭 |
| 字符串 prelude 注入 | `GUEST_PRELUDE` 是硬编码常量数组（`:122-440`），仅 `toolLines` 中的工具名经 `JSON.stringify(ident)`（`:1259, 1270`）注入；工具名若含引号会被正确转义。**唯一残留问题是保留字 `__proto__`（F-06b），不是代码注入。** |
| 资源限制 | `createRunner.limits`（`:1298-1308`）：`timeoutMs=totalMs+100`、`cpuTimeoutMs`、`maxResultBytes=16MB`、`maxBridgeRequests=2048`；宿主 `withDeadline`（`:716-725, 1348`）兜底 |

回归测试 `tests/true-isolation.test.js:62-147` 覆盖 `.constructor` 17 例、宿主全局缺失、正常功能不变。**注意**：这些测试只证明“guest 无法执行宿主代码”，不证明“bridge 调用是安全的”——后者由 F-01～F-07 覆盖。

---

## 1. 威胁模型（本审计采用）

| 资产 | 威胁来源 | 现有防护 | 缺口 |
|---|---|---|---|
| 宿主进程 / OS | 模型写的 guest JS | QuickJS 引擎边界（`run` SDK） | 无（F-11）；bridge 是合法通道 |
| 上游工具权限（写/删/PR） | execute_read 中的模型代码 | 宿主过滤 usable/unavailable + stub + `byIdent` 只含已授权工具 | 无实测绕过；但 typed-plan/Actions 桥不消耗预算（F-04） |
| OAuth/上游 token | 上游错误消息、capture sink、模型代码内嵌 | GitHub Actions helper 显式不带 token 走重定向（`github-helpers.js:589-603`）；其余**无** | F-01、F-02 |
| 数据完整性（不丢内容） | 截断的上游结果被当成完整内容写回 | `codemode.js:363`、`file-write.js:270`、canonical `truncated` flag | 不一致（F-07）、marker/flag 污染（F-08）、`boundResult` 无 flag（F-09） |
| 审计可信度 | 上游文本中的 `truncated:` 字样 | `hasExplicitTruncationMark` | F-03 可直接关闭检测 |
| 调用预算 / 配额 | 多步 plan、Actions helper | `maxCalls=50` 仅对 `registry.tool` 生效 | F-04 |

**明确不在边界内**：client profile 编码、tools/list annotations、模型自己的 prompt 判断（见 F-10、`docs/SANDBOX-SECURITY.md`）。

---

## 2. 现有测试覆盖概览（按审计主题）

| 主题 | 覆盖良好的测试 | 缺口 |
|---|---|---|
| 沙箱逃逸 | `tests/true-isolation.test.js:62-147`（3 用例，17 探针） | 无 `__proto__` 工具名 / `__bridge` 直触测试（F-06） |
| readOnly 过滤 / stub | `tests/readonly-tool-stub.test.js`, `tests/b10-codemode.test.js`, `tests/typed-plan-engine.test.js:158-180` | 未测 `hasTool` 在 execute_read 对写工具返回 false（建议补） |
| dryRun / approve | `tests/typed-plan-engine.test.js:71-86,138-156,224-238`, `tests/typed-plan-v2-route.test.js:223-247` | approve 自授权被视为期望行为（F-05） |
| 截断读取拒绝写 | `tests/file-write.test.js:242-255`, `tests/no-silent-truncation.test.js:250-306` | typed-plan `applyPatch` 的新 guard 尚无回归测试（F-07） |
| 结果规范化 | `tests/result-normalize.test.js:31-204,414-439`, `tests/normalization.test.js` | `truncated:false` + marker 并存（F-08） |
| 截断审计 | `tests/capture-truncation-audit.test.js:47-134`, `tests/audit-truncation.test.js:61-145` | 无 audit poisoning 测试（F-03） |
| capture 不脱敏 | `tests/capture.test.js:23-68` **反向断言**“credential headers verbatim” | 无“secret 不应落盘”测试（F-02） |
| profile 隔离 | `tests/client-profile.test.js:20-199`, `tests/platform-conformance-suite.test.js:388-435,480` | 充分 |
| envelope 层截断 | `tests/result-bound.test.js:5-69` | 未断言结果级 `truncated`（F-09） |

---

## 3. 优先级修复建议（只建议，未实施）

**P0（立即）**
1. F-03：修正 `hasExplicitTruncationMark` 正则，删除裸 `truncated:` 文本匹配；补 audit poisoning 测试。
2. F-01：`hostErrorMessage` / `unwrapResult` isError / `server.js` 错误响应统一脱敏 token 模式并限长；补回归测试。

**P1（尽快）**
3. F-02：capture sink 增加可配置 redactor（默认开）；明确 capture 存储为 secret 级；限制 sandbox code/tool args 大小；在文档写明“模型代码原样持久化”。
4. F-04：把 typed-plan 的 `invoke()` 与 `github_actions_*` 纳入调用预算；v1 plan 长度上限 64。
5. F-07：统一写路径截断判定为宿主函数 `isTruncatedRead(raw,text)`，覆盖 flag/marker/嵌套；审查新加的 `allowTruncatedRead` 逃生开关不被 guest 控制。

**P2（排期）**
6. F-06：过滤保留工具名 / 用 null-prototype guest 工具表；补 `__proto__` 与 `__bridge` 测试。
7. F-05：决定 approve 是否要成为授权边界；若是，改为宿主侧 capability。
8. F-08 / F-09：canonical 视图拒绝矛盾的 `truncated` 字段；`boundResult` 加结果级 `truncated`。

---

## 4. 审计边界与未做事项

- 未审计 OAuth 协议实现（`src/oauth.js` / `src/upstream-oauth.js`）的密码学细节，只跟踪了 token 进入 capture 的路径。
- 未审计 Vercel/R2 bucket 的实际 IAM 配置（仓库外）。
- 未修改任何文件、未运行会改动状态的脚本、未 commit/push/deploy。
- 所有动态探针脚本写在 `%TEMP%` 并已删除；没有把任何真实凭据写入文件或日志（测试用 `ghp_SUPERSECRET123` 等假值）。
