# B14 — typed-plan 审计高危/中危修复（truncated 读 + host 批准）

> 状态：已落地，等待 lead 人审。三工具面（`search` / `execute_read` / `execute`）未改。
> 本轮改动范围：`src/typed-plan.js`、`tests/typed-plan-security.test.js`（新增）、
> `docs/ledger/batch-14-typed-plan-security.md`（本文件，新增），以及经 lead 明确授权的
> `tests/typed-plan-engine.test.js` 3 处旧语义断言更新（#4/#5/#7）。
> 未改 `src/codemode.js` / `src/codemode-v2.js` / `src/result-normalize.js` /
> `src/github-helpers.js` / `scripts/` / 其他 tests / README / workflows。未 commit、push、deploy。

## 一、审计发现与修复

### 1. HIGH — `applyPatch` 忽略截断读，仍可能静默写回

**原行为**：`applyPatch.run` 调 `ctx.io.readFileRange({path})`，只取 `text` 就交给
`applyTextPatch`；`truncated:true` 和正文里的 `--- TRUNCATED ---` 标记都被忽略。
即使 `dryRun:false` 且已获批准，也会把**部分文件**当成全文 patch 后 `writeFile`，
静默截断文件尾部（与 `src/file-write.js` 的 batch-11 P0 防护不一致）。

**修复**：在 `applyPatch` 内、`applyTextPatch` / dryRun preview / `writeFile` **之前**加硬门：

- 读返回对象 `truncated === true`，或正文 `text` 含 `--- TRUNCATED ---`（字符串形状的读结果也覆盖）；
- 默认拒绝，抛带 `code:'PATCH_READ_TRUNCATED'` 的异常 → 执行器归一化为
  `step.error = 'PATCH_READ_TRUNCATED: ...'`、`stoppedAt = 该步`、后续步骤不运行；
- 唯一例外是 **host 显式传入** `allowTruncatedRead:true`（`executeTypedPlan` options，
  默认 false）；plan 步骤里夹带 `allowTruncatedRead` 会被整份校验拒绝，来宾无法自行绕过。

```js
const truncated = !!current && typeof current === 'object' && current.truncated === true;
const marker = typeof text === 'string' && text.includes('--- TRUNCATED ---');
if ((truncated || marker) && ctx.allowTruncatedRead !== true) {
  const err = new Error('refusing to applyPatch on a truncated read for ' + args.path + ...);
  err.code = 'PATCH_READ_TRUNCATED';
  throw err;
}
```

### 2. MEDIUM — 每步 `approve:true` 可自我授权真实写

**原行为**：`validateTypedPlan` 把 step 上的控制字段 `approve` 当成合法授权源之一；
来宾只要在 plan 的写步骤里写 `approve:true`，就能在 `dryRun:false` 下真实写入。
该字段是 plan（来宾数据）的一部分，不是 host 的信任凭据。

**修复**：授权来源只剩两处，**都在 plan 之外**：

1. `options.dryRun === true`（预览，永不 `writeFile`）；
2. `options.approve`（host 通过白名单数组或单个 op 名字符串传入，经 codemode bridge
   来自宿主侧 `o.approve`）。

任何 plan 步骤出现 `approve`（不论 `true`/`false`/字符串）都在 whole-plan 校验期
**显式拒绝**：错误码 `APPROVAL_REQUIRES_HOST`；handler 零调用、`steps:[]`、`stoppedAt:null`。
写步骤缺少 host 批准时同样带 `APPROVAL_REQUIRES_HOST` 的错误文案
（保留旧子串 `requires dryRun or explicit approve` 以兼容既有断言）。

### 3. 复核项（已确认未回归）

- readOnly 是服务端硬边界：任何 handler 运行前，整份 plan 的写 op 全部拒绝；
  即使同时给 `approve` / `dryRun` / `allowTruncatedRead` 也无效。纯读 plan 正常执行。
- 未批准写 = 0 handler 调用；`steps:[]`，`meta.executedCount=0`。
- 未知 op / 未知字段 / 缺参 / 错类型 / `NaN` / `Infinity` 全部校验期拒绝；
  新增选项 `allowTruncatedRead` 非 boolean 也拒绝。
- 失败无副作用：truncated 门触发时 `readFileRange` 是唯一被记录的调用，
  无 `writeFile`、无 dryRun preview、后续步骤不运行；控制字段不泄漏给 handler；
  冻结 plan 不被修改；`meta` 四项稳定。
- `runChecks` 仍标 `effect:'read'`（沿用 spike 语义，未改 op 注册表/工具面）。

## 二、接口变更（仅选项层，三工具 schema 未动）

`executeTypedPlan(plan, options)` / `validateTypedPlan(plan, options)` 新增一个可选 host 选项：

| 选项 | 类型 | 默认 | 含义 |
|---|---|---|---|
| `allowTruncatedRead` | boolean | `false` | 仅 host 可传；`true` 时允许 `applyPatch` 对截断读做 patch（含真实写）。来宾 plan 中同名 step 字段被拒绝。 |

`approve` 语义收紧：仍接受 `string[] | string`，但**只能来自 host 侧 options**；
plan step 上的 `approve` 一律 `APPROVAL_REQUIRES_HOST`。
`dryRun` 路径不变：真实写仍需要 `dryRun:false` + 顶层 `approve:[op]`。

没有新增导出、没有改 `PLAN_VERSION`、没有改六个 op 的字段/effect 标注，
`codemode.js` 的 sandbox helper 无需改动即可继续工作（它本来就把 `o.approve` 放在 options 里）。

## 三、测试与证据

新增 `tests/typed-plan-security.test.js`：**18/18 通过**（`node --test`）：
- HIGH × 7：`truncated:true`（dryRun/真写）、in-band 标记（对象/字符串两种读返回形状）、
  host 显式 `allowTruncatedRead:true` 放行（dryRun/真写）、per-step 覆盖被拒；
- MEDIUM × 6：per-step approve 被拒（单写 op / 全部写 op / 读 op 也拒）、
  顶层 approve 数组与字符串通过、错误白名单不授权、dryRun 路径保留；
- 复核 × 5：readOnly 四种组合零 handler、未知字段/类型/NaN、失败即停且无副作用、冻结 plan 不变。

回归：`tests/typed-plan-engine.test.js` **12/12**、`tests/typed-plan-integration.test.js`
及 typed-plan 相关路由测试 **59/59** 通过（截断门只影响 applyPatch + 截断读组合，
既有 fake 读均 `truncated:false`）。

经 lead 授权更新 `tests/typed-plan-engine.test.js` 三处旧断言：
- #4：`approve:'yes'` 从期望 `approve must be boolean` 改为期望 `APPROVAL_REQUIRES_HOST`；
- #5：per-step `approve:true` 从期望放行改为期望显式拒绝，host 全局 approve 仍放行；
- #7：部分失败用例的写 op 改用 host 顶层 `approve:['ensureBranch','openPr']`。

## 四、边界与风险

- `allowTruncatedRead:true` 是显式的危险开关；只有 host（而不是来宾 plan）能设置。
  接入方应仅在确认读结果安全时传入，调用方责任不变。
- per-step `approve` 从「授权」变成「拒绝」属行为破坏性变更；`scripts/typed-plan-spike.mjs`
  原型仍保留旧的每步批准语义（脚本及其独立测试未改），生产执行器与原型在此点有意不一致。
- 本轮没有触碰三工具数量/名称/顺序/schema/annotations，也没有新增第四工具或路由。
- 免费模型建议未被当作事实；所有结论来自本地确定性测试与源码复核。
