# B14 — typed-plan 生产执行器（独立模块）

> 状态：**已落地为独立模块，未接入任何路由 / MCP 工具**。本轮只新增 3 个文件：
> `src/typed-plan.js`、`tests/typed-plan-engine.test.js`、本文件。
> 未改 `src/codemode.js` / `src/server.js` / `src/vercel-app.js` / `src/upstream-*` /
> `scripts/` / 其他 tests / README / workflows；未 commit、push、deploy。
>
> 输入依据：`docs/ledger/batch-14-typed-plan-v2.md`（版本化 schema 设计稿，本文只实现其中的
> 执行内核，不实现 `/mcp/v2` 路由）、`scripts/typed-plan-spike.mjs`（op registry / 校验 /
> 执行的真实形状）、`src/file-write.js`（patch 纯函数）、`src/result-normalize.js`（归一化边界）、
> `docs/ledger/batch-14-typed-plan-spike.md`（原型结论报告）。

## 一、交付边界

把 spike 的执行内核提升为生产可用的**独立 ES 模块**，但不改变对外工具面：

- 导出 `executeTypedPlan(plan, { ops, io, dryRun, approve, readOnly })`，纯函数式顺序执行器。
- 6 个核心 op 与 spike 一致：`readFileRange` / `repoGrep` / `ensureBranch` / `applyPatch` /
  `openPr` / `runChecks`；registry 可整体注入替换。
- **不暴露为 MCP 工具**：三工具（`search` / `execute_read` / `execute`）的数量、名称、顺序、
  inputSchema、annotations 全部不动；不新增第四工具，不改现有工具 schema。
- 默认 adapter **不存在**：`io` 未注入时 fail closed（返回稳定校验错误），绝无隐式真实 I/O。

## 二、模块契约（src/typed-plan.js）

### 2.1 公开导出

| 导出 | 用途 |
|---|---|
| `executeTypedPlan(plan, options)` | 校验 + 顺序执行；唯一主入口 |
| `runTypedPlan` | 与未来 host helper 同名的别名，行为等同 |
| `validateTypedPlan(plan, options)` | 纯校验器，返回错误字符串数组（空 = 通过） |
| `createDefaultOps()` | 返回六个核心 op 的**新副本**，调用方可安全扩展 |
| `DEFAULT_OPS` | 冻结的默认 registry 快照（单一事实来源） |
| `OP_EFFECTS` | `op -> 'read'|'write'` 冻结映射，供 read-only 门使用 |
| `PLAN_VERSION` | `'v2.0.0'`，与 v2 设计稿的 planVersion 标签一致 |

### 2.2 严格校验（任何 handler 之前，whole-plan）

1. `plan` 必须是非空数组，且每步是 plain object；
2. `op` 必须是注册表中的键（未知 op 直接拒绝，handler 零调用）；
3. 必填字段齐全且类型正确：`string` / `number`（`NaN` 与 `Infinity` 一律拒绝）、
   可选字段出现时同样校验类型；
4. **未知字段拒绝**：step 上除 `op`、声明的必填/可选字段、控制字段 `approve` 之外
   的任何键都报错（`approve` 必须是 boolean）；防止客户端夹带未声明参数；
5. 写语义门：`effect:'write'` 的三个 op（`ensureBranch` / `applyPatch` / `openPr`）必须
   满足 `dryRun:true`、或该步 `approve:true`、或全局 `approve:[op,...]` 之一；
6. **read-only 是服务端硬边界**：`readOnly:true` 时即使给了 `approve`/`dryRun`，写 op
   仍被拒绝（不依赖 schema enum 或客户端 annotation 当安全边界，对应 v2 设计稿 R5）。

校验失败：`{ok:false, dryRun, steps:[], stoppedAt:null, error:'...; ...', meta, validationErrors:[...]}`。

### 2.3 执行与稳定结果

- 顺序执行，失败即停；`steps` 只含**真正执行过**的步骤，失败后的步骤不出现在 trace 中，
  不伪造 `skipped` 条目（B14 T3/B11：失败不静默吞）。
- 每步稳定形状：成功 `{ok:true, op, result}`、失败 `{ok:false, op, error}`，两者互斥。
- 顶层恒定 `{ok, dryRun, steps, stoppedAt, error, meta}`；`meta` 恒定四项：
  `{planVersion, readOnly, approvedOps:[...], executedCount}`，确定性可序列化。
- 控制字段 `op` / `approve` 在交给 handler 前从**浅拷贝**中剥离，不泄漏给 handler，
  也不修改调用方 plan（冻结 plan 同样安全）。
- 错误归一化：带 `code` 的异常（如 `PATCH_FAILED`）前缀 code；非 Error 抛出确定字符串化。
- 同输入 + 同注入 io 两次执行深相等（幂等 / 确定性）。

### 2.4 复用与不复制

- `applyPatch` 只做“读当前文本 → 调 `./file-write.js::applyTextPatch` → 成功才把结果
  交给注入的 `io.writeFile`”的编排；**不复制** `parseUnifiedDiff` / `precheckText` 等逻辑。
- `dryRun:true` 时返回 `{path, diff, preview, dryRun:true}`，零真实写。
- 不 import `src/codemode.js`（后者依赖 `run`/`acorn` 且触发沙箱），模块保持零网络、
  零凭据、零生产副作用；与 `src/result-normalize.js` 的边界一致：本模块只产出稳定结果，
  上游 envelope 的归一化仍由调用方决定。

## 三、与现有三工具的关系（当前：完全隔离）

本轮**没有任何运行时接线**：`src/codemode.js` 仍是最初的 `search` / `execute_read` / `execute`
三工具，`execute.inputSchema` 仍是 `{code:string}`。本模块只是可被 import 的普通文件，
不会被 `src/server.js` 或 `src/vercel-app.js` 加载路径触达。

## 四、未来如何由 `codemode.runTypedPlan` 调用（设计，未实现）

以下仅为后续接入方案，按 v2 设计稿走**版本路径**，不在本轮实现：

1. **宿主 helper 注入**：在 Code Mode 沙箱里新增 `codemode.runTypedPlan(plan, opts)`，
   其内部 `import { executeTypedPlan } from './typed-plan.js'`，把沙箱侧的读/写能力包装成
   `io` 适配器传入。模型仍通过 `execute({code})` 写脚本来调用 helper：
   ```js
   const plan = [
     { op: 'readFileRange', path: 'work/tp.txt', startLine: 1, endLine: 20 },
     { op: 'applyPatch', path: 'work/tp.txt', patch: '...' },
   ];
   return codemode.runTypedPlan(plan, { dryRun: true });
   ```
   `execute` 的 inputSchema **不变**（`code` only），三工具数量/顺序/annotations 全部冻结。
2. **只读分层**：`execute_read` 注入的 helper 固定 `readOnly:true`；执行器在服务端拒绝
   全部写 op（`E-VAL-WRITE-IN-READONLY` 语义），即使 schema 或模型误传也安全失败。
3. **写语义不绕过**：真实写仍要求 `dryRun → 真写 → verify` 三步；helper 只负责
   “是否允许发起 + 参数是否合法”，原子写/sha/precheck 继续由 `src/file-write.js` 与
   host 的 GitHub 写入链负责。客户端确认 UX 不由 annotations 代替。
4. **若未来走 `/mcp/v2` 的 `plan` 入参**（v2 设计稿 §2）：版本化工厂在 handler 的
   `plan` 分支调用同一个 `executeTypedPlan`，把返回的 `meta.planVersion` 与 capture 的
   `protocolVersion:'v2'` 标签合并；`code` 分支沿用 `runInSandbox`。是否切换默认由
   A/B 门槛 + lead 人审决定，本模块不表达任何切换意图。
5. **结果编码**：helper 返回值是普通对象，由既有 client-profile 编码链走文本 JSON，
   不使用 `structuredContent`；`steps[]` / `stoppedAt` / `meta` 原样透出给模型自纠。

## 五、测试与证据

`node --test tests/typed-plan-engine.test.js` → **12/12 通过**（离线、fake io）：

1. 成功流（read → patch → check，稳定步形状，dryRun 零写）
2. 未知 op（校验期拒绝，零 handler 调用）
3. 参数错（缺参 / 错类型 / NaN / 可选参数错）
4. 未知字段（严格拒绝 + `approve` 类型）
5. write 未批准（全局白名单与逐步 approve 两种放行 + 控制字段不泄漏）
6. read-only 拒绝写（含显式 approve / dryRun 也不能越界；纯读 plan 仍可执行）
7. 部分失败（第三步 halt，后续不运行；patch 上下文不匹配 → `PATCH_FAILED`）
8. 空 / 非数组 plan
9. 幂等 / dryRun（重复执行深相等，零真实写；`runTypedPlan` 别名一致）
10. 输入不变（冻结 plan 与 step 不被修改）
11. meta（稳定四项、反映选项、验证失败时 executedCount=0）
12. 补充：registry 可注入 + 六核心 op 完整性 + 副本隔离

## 六、边界与风险

- 参数类型仍是基础 `string/number`，没有枚举/范围/正则编译校验；真实接入 `command`
  白名单、branch 名格式等须在 host adapter 或 schema 层补齐（沿用 spike 结论）。
- `runChecks` 保持 `effect:'read'`，真实执行可能有副作用/耗时；若接入时改为写语义，
  属 `planVersion` 升级，不应在已冻结端点原地改。
- `io` 注入是硬性要求且无默认真实 adapter；调用方必须提供与所选 op 匹配的方法，
  否则 handler 抛错会作为执行期失败返回（不静默成成功）。
- 失败即停不做补偿/回滚，与 `file-write.js` 的多文件原子部分落盘报告是不同语义。
- 免费模型建议未被当作事实；本模块全部结论来自本地确定性测试。

## 七、交付清单

- `src/typed-plan.js`（新增）
- `tests/typed-plan-engine.test.js`（新增，12/12 通过）
- `docs/ledger/batch-14-typed-plan-engine.md`（本文件，新增）

未 commit、未 push、未 deploy；等待 lead 审阅决定是否接入。
