# Residual security audit — 已修项复核、F-08/F-09 与 auth readiness

> 审计日期：2026-11-23（Asia/Singapore）。**只读复核**：本报告是本批唯一写入文件。
> 未修改 `src/`、`scripts/`、`tests/`、README、其他 docs、workflows；未 commit / push / deploy。
>
> 依据（按要求通读）：
> - `docs/eval/CODEMODE-SECURITY-AUDIT.md`（原始审计 F-01～F-11）
> - `docs/ledger/batch-15-security-fix-2.md`（第二批修复声明）
> - `AGENTS.md` §6（capture / 安全硬规则）
> - `docs/AUTH-READY.md`（授权门禁）
>
> 方法：静态代码阅读（带文件:行证据）+ 本地只读动态探针（`%TEMP%` 临时脚本，已删除；
> 无真实凭据，只用 `ghp_SUPERSECRET123` 等假值；未联网、未写仓库状态）。
> 所有结论可在本地用下方命令/输入复现，不引用任何 free-model 建议作为证据（AGENTS.md §1）。
>
> **构建状态提醒（AGENTS.md §0）**：生产 `https://gemini-mcp-gateway.vercel.app` 仍是旧构建，
> 以下"已修"只描述本地工作树。不要拿旧构建的在线行为判定新代码失败，也不要写"线上已修好"。

---

## 0. 结论摘要

| 项 | 复核结论 | 判定 |
|---|---|---|
| F-01 模型错误脱敏（核心路径） | `redactSecrets` / `modelErrorMessage` / `unwrapResult` / bridge / `makeErrorOutput` 均已落地，探针确认 | **PASS（但有未覆盖路径，见 R-01）** |
| F-03 capture 截断审计误判 | 裸 `truncated:` 正则已删除；探针 `possibleModelTruncation=true` | **PASS** |
| F-04 预算 | v1 bridge（`chargeBudget`）与 v1 plan 步数上限已落地；**v2 plan handler 仍绕过计费** | **PARTIAL（R-02）** |
| F-06 `__proto__` 守卫 / bridge 不可达 | 保留 ident 过滤、`invoke` hasOwnProperty 守卫、不可猜测 bridge 名均已落地 | **PASS（R-03 仅纵深防御说明）** |
| F-07 `fileText` truncated 语义 | `fileTextFromRaw` 统一三态、不再静默 `false` | **PASS（R-04 下游语义需知悉）** |
| **F-08** canonical / 模型视图截断字段矛盾 | **未修**，探针复现 `truncated:false` + `--- TRUNCATED ---` 并存 | **FAIL / 未落地（R-05）** |
| **F-09** `boundResult` 无结果级 `truncated` | **未修**，探针复现返回 keys 仅 `['content']` | **FAIL / 未落地（R-06）** |
| Auth readiness（AUTH-READY） | 多项 `[ ]` 未勾；5 类真实阻塞未消除 | **NOT READY / 不能授权** |
| Vercel CIMD | 代码就绪但文档未部署、`clientId` 占位、未真实授权 | **BLOCKED** |
| 隐私 / full-fidelity 边界 | capture 保真与模型可见脱敏两不矛盾（同一 Error 双投影） | **无矛盾；但 R-01 是真正越界** |

**发布/授权前必须清零项**见 §6；一句话：F-08、F-09、R-01（server.js 直接工具错误路径脱敏缺失）、
R-02（v2 plan 预算）四项未清；auth 六项阻塞未清；`PUBLIC-SAFETY-AUDIT.md` 的 P0 未清前不得公开 OSS。

---

## 1. 已修项复核（逐项落地证据与未覆盖路径）

### 1.1 F-01 模型错误脱敏 — 核心路径 PASS，未覆盖路径见 R-01

**已落地证据：**

| 位置 | 代码证据 | 效果 |
|---|---|---|
| `src/tool-format.js:24-53` | `SECRET_PATTERNS` + `redactSecrets()`：覆盖 `Authorization: Bearer/Basic/Token`、`Bearer`、`access_token/refresh_token/client_secret/api_key/token/secret/password` 赋值与 query 参数、`gh[pousr]_`、`github_pat_`、`xox[baprs]-`、`sk-`、`AKIA`、`AIza`；保留 label 便于排障；幂等 | 统一脱敏原语存在 |
| `src/tool-format.js:58-65` | `modelErrorMessage(err)`：优先取非枚举 `modelMessage`，否则 redact `message` | 双投影模型建立 |
| `src/tool-format.js:488-492` | `unwrapResult()` 的 `isError` 分支 `throw new Error(redactSecrets(allText) \|\| ...)` | sandbox try/catch 看到的错误已脱敏；输入 envelope 不被改写（第 103 行测试佐证） |
| `src/upstreams.js:197-206` | `upstreamError()`：`Error.message` 保持 raw 供 capture，`Object.defineProperty(error,'modelMessage',{value:redactSecrets(...),enumerable:false})` | capture 全保真且模型侧可脱敏 |
| `src/codemode.js:952-975` | `makeErrorOutput()`：`info.message = redactSecrets(...)`、`modelErrorMessage(err)` 进 `result` 与 `execute error:` 前缀 | SDK/timeout/沙箱直抛错误也被脱敏 |
| `src/codemode.js:1266-1269` | `hostErrorMessage = (err) => modelErrorMessage(err)` | bridge 错误信封红化 |
| `tests/security-fix-2.test.js:51-120` | 5 组确定性用例：模式覆盖、bridge、`unwrapResult`、`modelMessage` 优先级、最终 execute error | 离线可复现 |

**本地探针（复现命令思路）**：`redactSecrets('failed with ghp_SUPERSECRET123 and Bearer ghp_SUPERSECRET123 ?token=ghp_SUPERSECRET123')`
→ `failed with [REDACTED] and Bearer [REDACTED] ?token=[REDACTED]`；
`modelErrorMessage(new Error('oops ghp_SUPERSECRET123'))` → `oops [REDACTED]`。均符合预期。

**未覆盖路径 → R-01（见 §2.1）**：`src/server.js:67-68` `errorMessage()` 直接返回 `error.message`，
被 `errorResult()`（:174-179 → 工具调用错误响应，模型可见）与 JSON-RPC 500（:593-600）使用。
`upstreamError` 挂的是非枚举 `modelMessage`，`errorMessage()` 不读取它。

### 1.2 F-03 capture 截断审计污染 — PASS

`src/capture.js:185-221` `hasExplicitTruncationMark()`：删掉了裸 `truncated:` 文本正则；
现在只认 (1) `value===true`；(2) `truncated/isTruncated/truncation` truthy 或 `truncation` 对象；
(3) 先对以 `{` 开头的字符串 `JSON.parse` 再检查顶层与 `result` 子树；(4) 固定 marker
`--- TRUNCATED ---` / `…[truncated N]`。`"truncated":false` 不再抑制。

**探针**：`buildModelOutputAudit({events:[upstream 1000 bytes, sandbox 150 bytes + ' truncated: false']})`
→ `possibleModelTruncation: true`（审计快照期望 true）。**残留风险见 R-07（JSON 嵌套深度/字符串形态边界）**。

### 1.3 F-04 预算 — PARTIAL（v1 PASS，v2 FAIL）

v1 已落地（`src/codemode.js`）：
- `:1245-1253` 唯一计费点 `chargeBudget(kind)`：递增 `calls`，超过 `maxCalls` 抛
  `tool call limit (N) exceeded` + `err.code='TOOL_CALL_LIMIT_EXCEEDED'` + `err.kind`。
- `:1100-1107` 默认 typed-plan IO 的每次 `invoke()` 计费；`:1334-1345` 自定义 IO 每方法计费（`runChecks` 除外）。
- `:1327-1331` v1 plan 步数上限 `MAX_TYPED_PLAN_STEPS=64`，稳定 code `TYPED_PLAN_TOO_MANY_STEPS`，guest 无法覆盖。
- `:1407` `github_actions_*`、`:1438` `wait_for_pr_checks` 轮询计费；`:1470` `registry.tool` 计费；
  `:1311` `remainingCalls()` 反映上述全部。

**未覆盖路径 → R-02（见 §2.2）**：`src/codemode-v2.js:196-216` 的 `makePlanHandler` 直接调用
`executeTypedPlan(a.plan, {...(options.typedPlanIO ? {io: options.typedPlanIO} : {}) ...})`，
没有经过 v1 `runTypedPlan` 的 `chargeBudget` 包装。`maxItems:64`（`codemode-v2.js:92`）只限步数，
不限总 I/O 次数（`repoGrep` 内部多次 read、自定义 IO 方法可多次调用）。v2 由 `ENABLE_MCP_V2=1` 启用，默认关闭，
但一旦开启即存在与 F-04 同类的预算绕过面。

### 1.4 F-06 `__proto__` 守卫 / `__bridge` 不可达 — PASS（纵深防御性质）

`src/codemode.js`：
- `:63` `BRIDGE_GLOBAL='__dshHostBridge9f4c2a'`（不可猜测名）；
- `:67` `RESERVED_TOOL_IDENTS` 过滤上游工具名中的 `__proto__`/`constructor`/`prototype`/内部 helper；
  `:1260-1264` 构建 `byIdent` 时过滤；`:1535/1539/1545` 绑定正常工具与 stub 时再次过滤；
- `invoke()` 宿主守卫（ledger §F-06）只接受字符串、拒绝 `__proto__`/`constructor`/`prototype`，
  并要求 `hasOwnProperty(registry, name)`；
- prelude 中 `__bridge` 显式 `undefined`，guest 只能经 `__dshInvoke` 拿到重建后的 Error。

**评价（R-03）**：`__bridge` 改名是纵深防御而非授权边界；真实边界是宿主 registry + readOnly 过滤
（审计 F-06 自述"不构成宿主逃逸"）。当前实现与该威胁模型一致，**无新增漏洞**。

### 1.5 F-07 `fileText` truncated 语义 — PASS（下游需知悉 null 语义）

`src/codemode.js:1065-1087` `fileTextFromRaw()`：有证据（flag/marker）→ `truncated:true` + `truncation` 原因；
无证据 → `truncated:null`（unknown），不再静默 `false`；无文本 → `{text:null,truncated:null}`。
`:1109-1110` canonical 与 fallback 共用该 helper；`:1118` 起 `readFileRange` 透传 true/null；
`repoGrep` 在任一文件 truncated 时整体标 truncated。`tests/security-fix-2.test.js:318-377` 覆盖三态。

**R-04（语义提示，非漏洞）**：`null` 表示 unknown，只有 `true` 是显式截断。
任何下游消费者若把 `null` 当 falsy 并写回文件，需按 AGENTS.md §5 的"禁止静默截断"复核；
本次未发现写路径把 `null` 当 `false` 使用，但 `ctx.allowTruncatedRead` 逃生开关（ledger §F-07 已知边界）
只应由宿主传入，需保持 guest 不可控。

---

## 2. Residual findings（F-08/F-09 + 新发现）

### 2.1 R-01（中高，**新发现**）直接工具错误路径未脱敏 — server.js

**复现/代码证据：**
```js
// src/server.js:67-68
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);  // 只读 raw message
}
// :174-179  工具调用错误响应（isError:true，text JSON）——模型可见
return errorResult(error);
// :400-412  CallToolRequest handler：upstreamManager.callTool 抛错 → errorResult(error)
// :593-600  JSON-RPC 500
sendJsonRpcError(res, 500, -32603, `Internal error: ${errorMessage(error)}`);
```
`src/upstreams.js:197-206` 的 `upstreamError()` 把红化投影放在**非枚举** `modelMessage` 上，
`errorMessage()` 完全不读取它。

**本地探针：**
构造 `new Error('[upstream:x] call: 401 Authorization: Bearer ghp_LEAK1234')` 并按 `upstreamError`
方式挂 `modelMessage` → `raw_leaks=true`、`modelMessage_leaks=false`。
`errorMessage()` 取 raw，所以 `ghp_LEAK1234` 会原样出现在 `errorResult()` 的 `{ok:false,error:...}`
与 JSON-RPC 500 文本中。

**风险**：F-01 修复只覆盖了 sandbox bridge 与 `unwrapResult` 的 isError 分支；
通过**直接工具名**（如 `gateway_call` 或 whitelisted tool）触发上游 401/403 时，模型仍可能读到
`Authorization: Bearer <token>` / query token。这与 F-01 原始威胁模型完全相同（AGENTS.md §6：
"模型可见错误必须脱敏"），属于修复未覆盖路径，而非 capture 保真边界。

**优先级**：**P0**（与 F-01 同级，收尾前必须清零）。修复建议：`errorMessage()` 改为
`modelErrorMessage(error)`（从 `tool-format.js` 导入），保证 raw capture 不变、只脱敏模型可见投影；
补 `tests/security-fix-2.test.js` 用例：fake upstream 抛含 token 的错误 → `errorResult()` text 不含 token。

### 2.2 R-02（中，F-04 残留）v2 plan handler 预算绕过

**代码证据：** `src/codemode-v2.js:196-216`（见 §1.3）。v1 的 `chargeBudget` 只包在
`src/codemode.js:1319-1354` 的 `runTypedPlan` bridge 内；v2 `makePlanHandler` 直接调 engine。
`src/result-normalize.js` 与此无关。

**风险**：v2 开启后，一个 64 步的 plan 每步可触发多次上游 I/O（默认 IO 的 `repoGrep` 内部多次 read；
自定义 IO 方法不受限），不受 `maxCalls=50` 约束；与 F-04 原始 DoS/配额绕过同类。
由于 v2 默认关闭（`ENABLE_MCP_V2=1` 才启用），当前生产面为零，但属于"已修项未覆盖路径"。

**优先级**：**P1**（若近期不启用 v2，可记为带期限的已知项；启用前必须清零）。
修复建议：v2 `makePlanHandler` 注入与 v1 相同的 `charge` 回调（复用 `chargeBudget`），
或对自定义 IO 每方法调用统一扣减 `calls`。

### 2.3 R-05 = F-08（中，**未修**）canonical / 模型视图截断字段自相矛盾

**复现（本地实跑）：**
```js
import { truncateResultValue } from './src/tool-format.js';
const out = truncateResultValue({truncated:false, big:'B'.repeat(5000)}, {maxChars:200});
// 实测：
// out keys   = ['truncated', 'big', '--- TRUNCATED ---']
// out.truncated = false
// marker key 存在 → 矛盾并存
```

**代码证据：**
- `src/tool-format.js:230-278` `shrinkObject()`：先 `const entries = Object.entries(value)`，
  `:273` `const all = [...kept, [markerKey, note]]`，`:275-277` 把所有 kept 字段（含上游原有
  `truncated:false`）与 `--- TRUNCATED ---` marker 一起写进输出。没有清理/规范化上游 `truncated` 字段。
- `src/tool-format.js:296-323` `truncateResultValue()`：`serialized.length > maxChars` 时走 `shrink(JSON.parse(serialized), maxChars)`，
  保留原有布尔字段。
- `src/result-normalize.js:373-384` `flagFrom()` 对任何非空字符串 `truncated` 都当作截断原因
  （`upstream:${raw}`），即上游 `truncated:"benign"` 会让 canonical 显示 `truncated:true`（保守误报方向），
  与 `truncateResultValue` 的布尔透传形成"两种语义不一致"。

**风险**：模型看到 `truncated:false` 与 `--- TRUNCATED ---` 并存，可能判定"数据完整"而漏报截断、
把残缺内容写入仓库（与 F-07 写路径威胁直接衔接）；反向的字符串误报方向虽保守，但可被用来消耗模型注意力。
审计快照对此的判定是 P2，但"上游可控文本进入 canonical 视图"在 full-fidelity capture 前提下仍是真实边界问题。

**优先级**：**P1**。修复建议：`shrinkObject`/`truncateResultValue` 在生成 marker 时，
若原对象含 `truncated` 字段且值为 false/非真，删除该字段或改写为 `truncated:true` +
`truncation` 原因（禁止输出自相矛盾的键）；统一 `explainTruncation` 与 `hasExplicitTruncationMark`
的真值判定（只有 true/1/'1'/'true'/对象算截断，任意非空字符串不再直接当原因）。
补测试：`truncateResultValue({truncated:false,big:'B'.repeat(5000)},{maxChars:200})`
断言不存在 `out.truncated === false && marker key` 的组合。

### 2.4 R-06 = F-09（中，**未修**）`boundResult` 静默截断无结果级 flag

**复现（本地实跑）：**
```js
import { boundResult } from './src/server.js';
const out = boundResult({content:[{type:'text',text:'X'.repeat(500)}]}, 100);
// 实测：Object.keys(out) = ['content']；out.truncated === undefined；
// out.content[0].text.length = 100（尾部有 '… [truncated N chars by gateway...]'）
```

**代码证据：** `src/server.js:82-115`：`:84` `let truncated = false` 只在函数内使用；
`:88` 超限时置 true；`:114` `return truncated ? { ...result, content } : result;`
——从不写 `result.truncated`。`tests/result-bound.test.js:5-69` 只断言 in-band 文本 marker，
未断言结果级布尔（与原始审计 §2 记录一致）。

**风险**：下游按 `result.truncated === true` 判定的消费者会漏掉 gateway 层截断。
capture 的 `hasExplicitTruncationMark` 能识别 `…[truncated N]` 文本形式（F-03 第二分支），
所以审计侧能看到；但**数据消费者看不到**，这正是 F-09 原始定义。

**优先级**：**P1**。修复建议：`return truncated ? { ...result, truncated: true, content } : result;`，
并确认 `encodeToolResult`/`encodeModelOutput` 保留该字段（现有 profile 白名单可能丢弃未知字段，
需在 `client-profile.js` 白名单中显式加入 `truncated` 或放在被保留的顶层字段）。
补测试：`assert.equal(boundResult(big,100).truncated, true)`。

### 2.5 R-07（低）截断审计的边界形态（F-03 残留面）

`hasExplicitTruncationMark` 对以 `{` 开头的 JSON 字符串只 `JSON.parse` 一次（`capture.js:210-216`），
且只检查顶层与 `result` 子树。若上游把 `truncated:true` 藏在更深层（如 `output.result.data.truncated`）
或包在 base64/多层 JSON 字符串中，检测会漏报；但反向（上游塞 `truncated:false` 抑制）已修。
属于"可能漏报显式截断声明"，保守方向是 P0 探测器更敏感而非被关闭。当前风险可接受，记录为已知边界。

### 2.6 R-08（设计确认，非漏洞）client profile / annotations 不是安全边界

原始审计 F-10 结论仍成立：`src/client-profile.js` 明示 NOT a security layer；
annotations 来自上游只影响客户端提示。真实只读判定在 `codemode.js:isReadOnlyTool` 与宿主过滤。
不列为待清零项。

---

## 3. Auth readiness — 对照 AUTH-READY 逐项判定

判定口径：`PASS` = 文档 `[x]` 且本地有确定性测试/代码证据；
`FAIL` = 文档明确 `[ ]` 且无证据；`UNKNOWN` = 仓库内无法验证（需要真实 provider/Vercel/KV，属于外部状态）。
**任何 FAIL/UNKNOWN 存在即 NOT READY，不得发起授权（AUTH-READY §0/§2）。**

### 3.1 §1 Checklist 逐项

| # | 项（AUTH-READY） | 文档状态 | 本报告判定 | 证据 / 阻塞 |
|---|---|---|---|---|
| 1.1-1 | static_bearer config 校验显式可用 | `[x]` | **PASS** | `tests/auth-provision.test.js` + `config-validation.test.js`；`AUTH_MODES=['oauth','static_bearer']` |
| 1.1-2 | static token 不 refresh（force:true 仍 0 次 token endpoint） | `[x]` | **PASS** | `auth-provision.test.js` 对应用例 |
| 1.1-3 | v2 key + owner=manual | `[x]` | **PASS** | `gmcgw:v2:grant:<env>:manual:<server>`，含 environment/grantId/authMode，无 refresh_token |
| 1.1-4 | token 不打印（stdout/stderr + formatPlan 红化） | `[x]` | **PASS** | `provision stdout/stderr contain no token value` 等测试 |
| 1.1-5 | 全量 npm test 绿 | `[x]` | **PASS（以 lead 最近基线为准）** | AGENTS.md §0：`1352/1346 pass/0 fail/6 todo`（2026-11-23，commit `4a77fc0` 后）；与 AUTH-READY 文中 `1087` 数字不同，属并发新增测试导致的漂移，以 ledger 当次记录为准 |
| 1.1-6 | 静态扫描无 P0 | `[x]` | **PASS（以当次记录为准）** | `node scripts/audit-truncation.mjs --ci` → `P0=0 PASS`（仅 P1 warning） |
| 1.2-1 | 目标环境已部署本批代码 | `[ ]` | **FAIL** | 无部署记录；AGENTS.md §0 明确生产仍跑旧构建、Vercel 100 deployments/day 已用尽 |
| 1.2-2 | env 命名空间正确 | `[ ]` | **UNKNOWN** | 需 Vercel project env / shell 中 `GMCGW_ENVIRONMENT`/`VERCEL_ENV` 实际取值；仓库内无法验证 |
| 1.3-1 | Linear 优先 static_bearer(PAT)，代码路径 | `[x]` | **PASS** | `docs/eval/AUTH-PROVIDERS.md` §2.2 + `Linear PAT: offline plan is ready...` |
| 1.3-2 | Linear PAT 已由 owner 创建并放入 vault | `[ ]` | **FAIL** | 无 vault 文件/`tools/list --verify` 真实成功证据 |
| 1.3-3 | Notion 分支诚实（static token 需 Business/Enterprise；REST token 无效） | `[x]` | **PASS（含过时文案注记）** | `scripts/auth-provision.mjs` blocker 文案过时，AUTH-READY §1.3 已声明以本节为准 |
| 1.3-4 | Notion DCR 代码已实现（真实授权未做） | `[x]` | **PASS（代码）/ FAIL（真实授权）** | `src/upstream-oauth.js` DCR 注册/复用/state client/KV 客户端记录 + 13 项测试；`gmcgw:v2:client:<env>:notion` 未真实写入 → 见 §2-4 |
| 1.3-5 | Vercel OAuth-only + `offline_access` | `[x]` | **PASS** | `src/upstream-oauth.js` authorize URL 带 `openid offline_access` + `resource`；回调无 refresh_token 直接 400；测试覆盖 |
| 1.3-6 | Vercel CIMD 代码已实现（真实部署/授权未做） | `[x]` | **PASS（代码）/ BLOCKED（真实）** | `src/vercel-app.js` `GET /.well-known/mcp-client.json`；`config.example.json` 仅占位 URL → 详见 §3.3 |
| 1.4-1 | token/client env 变量名在目标环境存在 | `[ ]` | **UNKNOWN** | 需在目标环境跑 `node scripts/auth-provision.mjs --provider linear --token-env LINEAR_PAT_STATIC --environment <env>` 且不报 env not set |
| 1.4-2 | KV 凭据只在该环境配置，无跨环境共用 | `[ ]` | **UNKNOWN** | 需 Vercel project env 绑定证据；本地 shell 不得有 production KV 凭据 |
| 1.5-1 | 脚本对 static 写 owner=manual v2 grant | `[x]` | **PASS** | `buildStaticGrant()` + `Vercel: --apply on an OAuth plan performs no KV write` |
| 1.5-2 | `--apply` 已由 operator 在正确 env 执行且 KV 可读 | `[ ]` | **FAIL** | 从未真实跑过 `--apply`；无 `result: READY ... wrote=true` 证据 |
| 1.5-3 | `getAuthStatus()` 返回 ACTIVE/明确 static 状态 | `[ ]` | **UNKNOWN** | 需管理端点/脚本真实输出；不得是 `REAUTH_REQUIRED`/`SHARED_GRANT_REFRESH_FORBIDDEN` |
| 1.6-1 | 真 `tools/list` 成功（真实 fetch） | `[ ]` | **FAIL** | 只有 fake fetch 测试；Linear/Notion 官方 MCP 未真实返回工具列表；Vercel 回调未返回非空 refresh_token |
| 1.6-2 | 真实 gateway 冷启动连得上上游 | `[ ]` | **FAIL** | `npm run smoke:l1:real` 未跑；无上游工具出现在 `search`/`execute` 的 401-free 证据 |
| 1.6-3 | 跨环境隔离实测 | `[ ]` | **FAIL** | 无 preview 缺授权时读不到 production key 的实测 |
| 1.7-1 | 离线默认零网络 | `[x]` | **PASS** | `provision without token never performs a network call` |
| 1.7-2 | `--verify` 可注入 fake fetch | `[x]` | **PASS** | `Linear PAT: verify hits the official MCP tools/list` 测试不联网 |
| 1.8-1 | 回滚方案已演练 | `[ ]` | **FAIL** | `docs/ledger/batch-15-auth-architecture.md` §6.4 四项均"待做/无证据"；不可回滚底线（不重启用 dsh grant 自动刷新）必须保持 |

**统计**：§1 共 22 项；11 项 PASS（均代码/测试层），3 项 UNKNOWN，8 项 FAIL（其中 2 项代码 PASS 但真实路径 FAIL 单独计入 §2）。
结论：**NOT READY**，与 AUTH-READY §0/§2 一致。

### 3.2 §2 五项真实阻塞（逐项明确）

1. **没有真实 provider 授权** — Linear PAT / Notion static MCP token 尚未由 owner 在 vault 创建并验证。→ 阻塞 1.3-2/1.6-1。
2. **没有真实 KV 写入** — `--apply` 从未在目标环境执行；v2 grant 记录没有真实创建/读取。→ 阻塞 1.5-2/1.5-3。
3. **没有部署验证** — 本批代码未部署；部署后 `tools/list` 与 `getAuthStatus()` 未验证。→ 阻塞 1.2-1/1.6-1/1.6-2（生产仍是旧构建，见 AGENTS.md §0）。
4. **Notion DCR 真实授权未做** — `gmcgw:v2:client:<env>:notion` 未被真实写入，部署后 tools/list 未验证；交互授权对外仍 BLOCKED（或用户已有 static MCP token）。
5. **Vercel CIMD 真实部署/授权未做** — 见 §3.3，**BLOCKED**。
6. **回滚未演练** — §1.8 四项无真实证据。

### 3.3 Vercel CIMD — 结论：**BLOCKED**

**代码侧（已就绪，非阻塞）**：
- `src/vercel-app.js` 新增 `GET /.well-known/mcp-client.json`：`client_id` = 文档 URL、
  `token_endpoint_auth_method: none`、S256、`scope: openid offline_access`；
- `src/upstream-oauth.js` authorize URL 带 `openid offline_access` + `resource=https://mcp.vercel.com/`；
  回调无 refresh_token 直接 400；
- `config.example.json` 中 `clientId` 是**占位 HTTPS URL**；
- `tests/provider-dcr-cimd.test.js` 13 项测试覆盖文档形状与路由（fake，零联网）。

**阻塞（真实世界，未完成）**：
1. CIMD 文档尚未部署到稳定 HTTPS 域名，`GET /.well-known/mcp-client.json` 无法被 AS 抓取；
2. `config.clientId` 仍是占位 URL，未替换为真实文档 URL；
3. 未真实走一次 `/upstream/oauth/start?server=vercel&...`，未确认 AS 接受该 client；
4. 回调未确认 `refresh_token` 非空；`getAuthStatus()` 未返回 ACTIVE；
5. `scripts/auth-provision.mjs` 的 CIMD blocker 文案仍为旧版（脚本不在改动范围，属已知过时文案，
   不代表代码能力；真实门槛以 AUTH-READY §1.3/§2 为准）。

**明确判定：Vercel 授权对外仍 BLOCKED。不能找用户授权，不能说"Vercel 已就绪"。**
另注：原始安全审计前言明确 "CIMD 目前被 AS 拒绝，BLOCKED"（AGENTS.md §2）；
即使代码测试全绿，真实 AS 是否接受仍未验证，不得推断已解除。

### 3.4 "不能授权"的具体阻塞清单（最短路径）

要解除授权门禁，必须按顺序完成且留下证据：
1. 部署本批代码到目标环境（含 CIMD 路由），拿到 `GET /healthz` 新 build-info；
2. owner 在 vault 创建 Linear PAT（及 Notion static MCP token，或走 DCR）；
3. 目标环境配置 env 变量名与 KV 绑定，确认无跨环境共用；
4. operator 在**正确 env** 跑 `node scripts/auth-provision.mjs --provider <p> --token-env <ENV> --environment <env> --verify --apply`
   → `result: READY ... wrote=true`，KV 中 v2 key 可读且 environment 一致；
5. 真 `tools/list` 成功（真实 fetch）、gateway 冷启动冒烟成功、跨环境隔离实测通过；
6. Vercel：CIMD 文档部署到稳定 HTTPS → `clientId` 写入真实 URL → 真实授权 → `refresh_token` 非空 → `getAuthStatus()` ACTIVE；
7. 按 `batch-15-auth-architecture.md` §6.4 演练回滚，保持"不重新启用 dsh grant 自动刷新"底线。

---

## 4. 隐私 / full-fidelity 边界检查

**声明（AGENTS.md §6）**：capture 目标是 full-fidelity，用户明确禁止对 capture 做隐私/安全过滤；
但模型可见错误必须做 secret 形态脱敏。两者是**同一数据的两种投影**，不矛盾。

**实现如何满足（代码证据）**：
- `src/upstreams.js:197-206`：`error.message` 原样保留给 capture，`modelMessage`（非枚举）是红化副本；
- `src/tool-format.js:488-492`：`unwrapResult()` 只脱敏抛给模型的文本，**输入 envelope 不被改写**
  （`tests/security-fix-2.test.js:103` 断言 `raw.content[0].text` 仍是原 token）；
- `src/capture.js:44-54 / 740-754`：`captureEvent` / `captureHeaders` 全量复制，无脱敏；
- `tests/capture.test.js:23-68`：**反向断言** "capture preserves credential headers verbatim"，
  明确这是设计而非 bug；
- `docs/OPEN-SOURCE/EXPORT-IMPLEMENTATION.md:95-96`：capture 数据 "never redacted or rewritten"。

**结论**：`capture 保真` 与 `模型错误脱敏` **无矛盾**，当前实现用"raw message + 非枚举红化投影"
正确分离了两个边界。**但 R-01 是真正的越界**：`server.js:errorMessage()` 把 raw message 直接送进
模型可见的工具错误响应与 JSON-RPC 500，违反"模型可见错误不得泄漏 token"；这不是 capture 保真问题，
而是模型投影侧漏做脱敏。修复时**不得**改为改写到 capture 的原始错误对象。

**同时注意（AGENTS.md §5）**：raw upstream envelope 与 canonical output 必须区分，raw 不得
**无标记**泄漏到 capture/模型可见输出。当前 capture 中 raw 是"有标记的原样保存"（按 §6 明确授权）；
F-08（R-05）导致 canonical 视图出现自相矛盾的标记，属于"标记错误"而非"无标记泄漏"，但仍需清零。

---

## 5. 发布 / 授权前的其它关联门禁（非本报告主线，但必须知悉）

- **OSS 公开**：`docs/OPEN-SOURCE/PUBLIC-SAFETY-AUDIT.md` 结论为 **DO NOT PUBLISH**
  （F-01/F-02 为 P0 publication blocker；F-01 个人 handle 逃逸形式 63 处/11 文件，
  F-02 导出检测器自身正则匹配失败，`--check` 通过是假阴性）。发布前必须按
  `RELEASE-LOCAL.md` + `PUBLIC-SAFETY-AUDIT.md` 清零并重新导出/提交本地 release repo。
  本审计**未**修改这些产物，也未公开任何仓库。
- **生产构建**：AGENTS.md §0 明确最新修复未部署；任何"在线复验通过"的说法在部署前都不成立。
- **token 落盘**：`config.example.json` 仅占位；真实 token 不进仓库/日志；本地凭据从 vault 读。

---

## 6. 发布 / 授权前必须清零项（具体、可执行）

### 6.1 安全 / 代码（P0 — 模型可见泄漏）

1. **R-01**：`src/server.js:67-68` `errorMessage()` 改用 `modelErrorMessage()`；覆盖 `errorResult()`
   （`:174-179`）与 JSON-RPC 500（`:593-600`）。验证：`errorResult()` 对含 `Authorization: Bearer ghp_...`
   的 fake upstream 错误，响应 text 不含 token，且 capture 原始 error 仍完整。补确定性测试。
2. **F-08 / R-05**：`src/tool-format.js` `shrinkObject()`/`truncateResultValue()` 消除
   `truncated:false` 与 `--- TRUNCATED ---` 并存；统一 `result-normalize.js:flagFrom()` 真值语义。
   验证：§2.3 探针不再出现矛盾键。补测试。
3. **F-09 / R-06**：`src/server.js:114` `boundResult()` 返回 `{...result, truncated:true, content}`，
   并确认 profile 编码保留该字段。验证：`boundResult(big,100).truncated === true`。补测试。
4. 全量 `node --test` 绿（以 lead 最近一次全量结果为准）；`node scripts/audit-truncation.mjs --ci` → P0=0。

### 6.2 安全 / 代码（P1 — 预算与边界）

5. **R-02**：若启用 `ENABLE_MCP_V2=1` 前，给 v2 plan handler 注入 `chargeBudget`（与 v1 同源），
   或明确记录"v2 不启用且不在本轮发布面"的决定；二者取其一，不得两者都无。
6. **R-07**：记录为已知边界即可（外层 JSON 嵌套漏报显式截断声明）；若 analyzer 依赖该信号，
   补一次多层 JSON 用例确认不会反向关闭 P0 检测。
7. **R-03/R-04/R-08**：保持现状，但在发布文档中明确：bridge 改名是纵深防御非授权边界；
   `truncated:null`=unknown；profile/annotations 不是安全边界。

### 6.3 Auth（NOT READY — 全部 8 项 FAIL + 3 项 UNKNOWN 清零前不授权）

8. 目标环境部署本批代码 + `GET /healthz` 新 build-info（1.2-1）。
9. env 变量名存在且 KV 只在该环境配置、无跨环境共用（1.4-1/1.4-2）。
10. owner 创建 Linear PAT / Notion static token 并放入 vault（1.3-2）。
11. operator 在正确 env 执行 `--verify --apply` → `wrote=true`，v2 grant 可读、environment 一致（1.5-2）。
12. `getAuthStatus()` ACTIVE 或明确 static 状态（1.5-3）。
13. 真 `tools/list` 成功 + 真实 gateway 冷启动冒烟 + 跨环境隔离实测（1.6-1/1.6-2/1.6-3）。
14. Notion DCR：真实授权一次、`gmcgw:v2:client:<env>:notion` 写入、部署后 tools/list 验证。
15. **Vercel CIMD：文档部署到稳定 HTTPS → `clientId` 填真实 URL → AS 接受 → 真实授权 →
    `refresh_token` 非空。`BLOCKED` 未解除前不得发起 Vercel 授权。**
16. 回滚四项演练完成，底线"不重启用 dsh grant 自动刷新"保持（1.8-1）。

### 6.4 OSS 发布（DO NOT PUBLISH — 见 §5）

17. 清零 `PUBLIC-SAFETY-AUDIT.md` F-01/F-02（P0）及其余 P1；重新导出并重新提交本地 release repo；
    修复导出检测器假阴性；`RELEASE-LOCAL.md` 全绿后由 release owner 决定公开。
    本审计未做上述任何动作。

---

## 7. 审计边界 / 未做事项

- 未审计 OAuth 密码学细节、Vercel/R2 实际 IAM、真实 provider/KV/Vercel 状态（仓库外，无法验证）。
- 未运行全量 `npm test` / 静态扫描（以 lead 最近基线为准）；本报告的动态探针只在 `%TEMP%`、
  用假 token、未联网、未写仓库。
- 未修改 `src/`、`scripts/`、`tests/`、README、其他 docs、workflows；未 commit / push / deploy / tag。
- 仓库当前存在其他 agent 的未提交改动（`docs/eval/l1-smoke*.{md,json}`、
  `docs/eval/l1-online-gap*.{md,json}`、`scripts/eval-cycle.mjs`），均非本审计所为，本报告未触碰。
