# Batch 15 · Code Mode 安全审计二次修复（F-01/F-03/F-04/F-06/F-07）

日期：2026-11-23（Asia/Singapore）
依据：`docs/eval/CODEMODE-SECURITY-AUDIT.md`

## 边界声明（硬规则）

- **capture 保持 full-fidelity**：按用户与 AGENTS.md §6 的明确要求，本次 **不对 capture 做任何脱敏/隐私过滤**；`captureEvent`、file/HTTP/R2 sink、`captureHeaders`、raw body、完整 sandbox code/tool args 全部保持原样。审计 F-02 不在本次范围。
- 本次只修 **模型可见** 的错误文本、截断检测、调用预算、bridge 暴露与截断语义。
- 未 commit / push / deploy；生产环境仍是旧构建，本记录只描述本地工作树。

## 写入范围

- `src/tool-format.js`（新增统一脱敏 helper；`unwrapResult` isError 分支）
- `src/upstreams.js`（`upstreamError` 附加红化投影，raw message 不变）
- `src/capture.js`（仅 `hasExplicitTruncationMark` 检测器）
- `src/codemode.js`（错误路径、预算、bridge、fileText）
- `tests/security-fix-2.test.js`（新增 21 条确定性用例）
- 本 ledger

未改 `src/typed-plan.js`、`src/result-normalize.js`、`scripts/`、其他 tests/README/workflows。

## 各项修复

### F-01（高）模型可见错误脱敏

- `src/tool-format.js`
  - 导出 `redactSecrets(text)`：覆盖 `Authorization: Bearer/Basic/...`、`Bearer`、`access_token/refresh_token/client_secret/api_key/token/secret/password` 赋值与 query 参数、`gh[pousr]_`、`github_pat_`、`xox[baprs]-`、`sk-`、`AKIA`、`AIza`。
  - 导出 `modelErrorMessage(err)`：优先取 Error 上非枚举的 `modelMessage`，否则对 `message` 红化。
  - `unwrapResult()` 的 `isError` 分支抛出的 Error 文本改为 `redactSecrets(allText)`；错误 code/结构/前缀不变，输入 envelope 不被改写。
- `src/upstreams.js`
  - `upstreamError()` 保持 `error.message` **原文**（capture 仍拿到完整凭据字符串），额外挂非枚举 `modelMessage = redactSecrets(message)`。错误 name/cause/枚举字段不变。
- `src/codemode.js`
  - `hostErrorMessage` 改用 `modelErrorMessage`。
  - `makeErrorOutput` 的 `result` 与 `out.error.message` 均走红化。
- 所有红化是幂等的；`[REDACTED]` 不会被二次处理。

### F-03（高）截断审计污染

- `hasExplicitTruncationMark` 删除裸 `truncated:` 字段名正则。现在仅以下情况算“显式截断”：
  1. `value === true`；
  2. 对象的 `truncated`/`isTruncated` 为 true（或 1/'1'/'true'），或 `truncation` 对象存在；
  3. 针对 JSON 字符串先 `JSON.parse`，再按上述规则检查顶层与 `result` 子树；
  4. 固定 wire marker `--- TRUNCATED ---` / `…[truncated N]`。
- `"truncated": false`（字符串/JSON/嵌套）不再是 mark；`truncated:true` 与 marker 仍命中。

### F-04（中高）预算绕过

- `src/codemode.js` 新增唯一计费点 `chargeBudget(kind)`，沿用原 `calls > maxCalls` 与 `tool call limit (N) exceeded` 文案，并附稳定 `code = TOOL_CALL_LIMIT_EXCEEDED`。
- `registry.tool` 改为调用该计费点，原语义不变。
- `runTypedPlan`：
  - 默认 IO 的每次 `invoke()`（含 `repoGrep` 内部多次 read）计费；
  - 自定义 `typedPlanIO` 的每个 I/O 方法调用计费（`runChecks` 是本地 stub，不计费）；
  - host 侧 v1 plan 步数上限 64（与 v2 `maxItems` 对齐），超限返回稳定 `TYPED_PLAN_TOO_MANY_STEPS`；guest 无法传 override。
- `github_actions_*` 三个 helper 与 `wait_for_pr_checks` 的每次轮询均计费；超限在出站请求前抛错。
- bridge 错误信封新增可选 `code`，guest 侧 `__dshInvoke` 重建 Error 时透传。
- `remainingCalls()` 现在反映所有上述调用。

### F-06（中）bridge 暴露 / 原型污染

- SDK `syncHostFunctions` 组名由 `__bridge` 改为不可猜测的 `__dshHostBridge9f4c2a`；prelude 中 `__bridge` 显式为 `undefined`，guest 无法直接调用原始 registry 信封，只能经 `__dshInvoke`（Error 重建 + `hostOrigin` 标记）。
- `invoke()` 宿主侧守卫：只接受字符串、拒绝 `__proto__`/`constructor`/`prototype`，并要求 `hasOwnProperty(registry, name)`。
- `RESERVED_TOOL_IDENTS` 过滤上游工具名中的 `__proto__`/`constructor`/`prototype`/内部 helper 名等；已挂载工具与 stub 都不绑定这些 ident，`codemode` 原型不再被上游名称替换。

### F-07（中）fileText fallback 截断语义

- 新增导出纯函数 `fileTextFromRaw(raw, {normalizeName})`，统一 canonical 与 fallback 两条路径：
  - 有证据（`truncated`/`isTruncated`/`truncation`/in-band marker）→ `truncated: true` + `truncation` 原因；
  - 无证据 → `truncated: null`（unknown），**不再静默 false**；
  - 无文本 → `{text:null, truncated:null}`。
- `readFileRange` 保留 `true` 优先级（行裁剪/upstream flag），unknown 用 `null` 透传；`repoGrep` 在任一文件被标记 truncated 时把整体结果标为 truncated。

## 测试

- 新增 `tests/security-fix-2.test.js`：21 条确定性用例，全离线/无真实凭据。
  - F-01：脱敏覆盖、幂等、sandbox 桥、unwrapResult、最终 execute error；并断言 raw envelope/raw message 不变（capture 全保真边界）。
  - F-03：`truncated:false` 文本/JSON/嵌套不抑制检测；`truncated:true`/marker 仍抑制。
  - F-04：typed-plan（默认与自定义 IO）计费、剩余次数、Actions REST 计费与错误 code、65 步拒绝。
  - F-06：`__bridge` 不可达、正常 helper 不受影响、`__proto__`/`constructor`/`__dshInvoke` 工具名不污染原型。
  - F-07：helper 的 marker/unknown/explicit 三态与 typed-plan 传播。
- 验证命令：`node --test tests/security-fix-2.test.js` → 21/21 pass；`npm test` 全量绿（结果以 lead 汇总为准）。

## 已知边界 / 后续

- F-01 只覆盖**模型可见**路径；日志/capture 中的原文按设计保留，capture 桶/目录仍须按 secret 级存储对待。
- F-04 的 typed-plan 计费以“每次 I/O 方法/每次 invoke”为单位，v1 plan 步数上限在 bridge 而非 `src/typed-plan.js`（本批写入范围限制）。
- F-06 的 `__bridge` 名称不可猜测是纵深防御；真正授权边界仍是宿主 registry 与 readOnly 过滤。
- F-07 的 `null` 语义要求下游消费者把 `null` 当 “unknown”，只有 `true` 才是显式截断；`false` 仅由其他显式判定产生。
