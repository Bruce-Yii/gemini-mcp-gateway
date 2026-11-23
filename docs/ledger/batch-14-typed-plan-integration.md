# B14 — typed-plan 接入 Code Mode 沙箱（helper 形态）

> 状态：**已落地，仅 3 个文件**。本轮只写 `src/codemode.js`、
> `tests/typed-plan-integration.test.js`（新增）、本文件（新增）。
> 未改 `src/typed-plan.js` / `src/server.js` / `src/vercel-app.js` / `src/capture.js` /
> `scripts/` / 其他 tests / README / workflows；未接 `/mcp/v2` 路由；未 commit / push / deploy。
>
> 输入依据：`src/typed-plan.js`（`executeTypedPlan` 执行内核）、`scripts/typed-plan-spike.mjs`
> （op registry / fake io 形状）、`docs/ledger/batch-14-typed-plan-v2.md`（版本化设计稿）、
> `docs/ledger/batch-14-typed-plan-engine.md`（执行器契约与 §4 未来接入设计）、
> `src/codemode.js` 的 guest prelude / host bridge / `createCodeModeTools` 注入点。

## 一、交付边界（明确不做什么）

把已完成的 typed-plan 执行器接进 Code Mode 沙箱，但**保持对外工具面完全冻结**：

- **不改三工具 schema / 名称 / 顺序 / annotations**：`search` / `execute_read` / `execute`
  三个工具的 `inputSchema`、`name`、返回顺序、`annotations` 与接入前逐字一致。
- **不加第四个工具**：`runTypedPlan` 是 `codemode` 全局上的**沙箱 helper**，不是 MCP tool。
- **不接 `/mcp/v2` 路由**：本轮没有任何路由/工厂分层；`execute` 仍是 `code` only。
- 不改 typed-plan 执行器本身；`codemode.js` 是唯一新增的运行时接线。

## 二、接线设计

### 2.1 guest 侧（prelude）

在 `GUEST_PRELUDE` 中、`codemode.services` 旁新增一行：

```js
codemode.runTypedPlan = (plan, opts) => __dshInvoke("runTypedPlan", [plan, opts]);
```

- 与所有其它 codemode 能力走**同一个 host bridge**（`__dshInvoke("runTypedPlan", …)`），
  不引入新的跨边界原语；guest 函数不能跨 bridge，所以只有 `(plan, opts)` 两个纯数据入参、
  一个普通对象出参。
- 返回值是真实 Promise 解析值，`await` / `.then` 都能用；与其它 typed helper 一致。

### 2.2 host 侧（bridge）

`runInSandbox` 的 `registry` 新增 `runTypedPlan(plan, opts)`：

1. **强制 readOnly**：`sandbox` 的 `typedPlanReadOnly`（由 `execute_read` handler 传入）
   在 host 侧强制为真，guest 传 `readOnly:false` / `approve` / `dryRun:false` 都不能越界。
2. **dryRun 默认 true**：`opts.dryRun === undefined` 时按 `true` 处理；真实写必须显式
   `dryRun:false` 且 `approve`（由执行器的 whole-plan 校验门把守）。
3. **io / ops 注入**：
   - `typedPlanIO` / `typedPlanOps` 作为 `runInSandbox` 新选项，供离线测试 / 后续接线注入。
   - 默认真实 adapter `createDefaultTypedPlanIO({ tools, callTool })` 复用**现有 codemode 能力**：
     读 op 用同一套上游工具桥（`github__get_file_contents` / list+read for grep）与
     `unwrapResult` / `hostNormalizeResult`；写 op 用 file-write 的 `applyTextPatch`（由 op 自身调用）
     + `create_or_update_file` / 分支 / PR 工具（对齐 `applyFilePatch` / `ensureBranch` / `upsertPr`）。
   - 没有默认真实 adapter 时绝不隐式真实 I/O：缺工具会抛出可执行错误，由执行器转成稳定 step 错误。
4. **不崩沙箱**：整个 wrapper 用 `try/catch` 包住，任何异常都返回
   `typedPlanFailure()` 的稳定 `{ok:false, steps:[], stoppedAt:null, error, meta, validationErrors}`；
   执行器自身的失败本就是稳定对象，原样透传，不静默截断、不吞 `steps`/`stoppedAt`。

### 2.3 注入点串联

`createCodeModeTools` 的 `makeExecute` handler 在调用 `runInSandbox` 时新增三个参数：
`typedPlanReadOnly: readOnly`、`typedPlanIO: options.typedPlanIO`、`typedPlanOps: options.typedPlanOps`。
`execute_read` 因此拿到 `readOnly:true`，`execute` 拿到 `false`；两者都不改工具 schema。

## 三、调用示例（模型侧，execute 的 code 脚本内）

```js
const plan = [
  { op: 'readFileRange', path: 'work/tp.txt', startLine: 1, endLine: 20 },
  { op: 'applyPatch', path: 'work/tp.txt', patch: '@@ -2,1 +2,1 @@\n-old\n+new\n' },
];
// dryRun 默认 true -> 写 op 只产出 preview/diff，零真实写
return codemode.runTypedPlan(plan);
```

真写需显式审批：`codemode.runTypedPlan(plan, { dryRun: false, approve: ['applyPatch'] })`。
在 `execute_read` 里同一段脚本会因 host 强制 readOnly 而返回稳定失败，写 op 零执行。

## 四、测试与证据

`node --test tests/typed-plan-integration.test.js` → **16/16 通过**（离线、fake io，无联网）：

1. helper 在沙箱内可调用并返回引擎结果
2. 完整 `execute({code})` handler 路径结果形状正确、无 audit 字段泄漏
3. execute：dryRun 读 + 预览写、零真实写
4. execute：`dryRun:false + approve` 才触发真实写
5. execute_read 强制 readOnly 拒写（guest 尝试 opt-out 仍失败）
6. execute_read 仍可执行纯读 plan
7. dryRun 默认 true（写 op 变预览）
8. 显式 `dryRun:false + approve` 触发真实写
9. 未知 op 稳定失败且沙箱后续调用正常
10. 写未批准 → 稳定失败 + 零副作用
11. 空 plan / 错参 / 非数组 → 不崩沙箱
12. io adapter 抛错 → 稳定 step 错误
13. 同输入深相等（确定性）
14. io `truncated` 标志原样透出（不静默截断）
15. 三工具数量/名称/顺序/schema/annotations 逐字不变；schema 中无 `plan`/`runTypedPlan`
16. helper 不注册为工具

`npm test` 全量结果：**tests 1123 / pass 1117 / fail 0 / todo 6 / skipped 0**
（6 个 todo 是仓库既有的 `# TODO` 标记测试，与本轮改动无关；本轮新增 16 个测试全绿，
既有 `typed-plan-engine` 12 个测试也全绿）。全程离线，未联网、未 commit。

## 五、边界与风险

- 默认真实 adapter 是**接通骨架**：读路径对齐现有 codemode 工具默认值与归一化；写路径对齐
  file-write / upsertPr 语义。实际工具名随会话挂载而变，缺工具会明确报错而非静默成功。
- `runChecks` 无宿主 runner 时返回带 `skipped:true` 的诚实结果，不伪造“检查通过”。
- 审批 UX 仍不由 annotations 代替；helper 只做“是否允许发起 + 参数是否合法”的门。
- 不实现 `/mcp/v2` 的 `plan` 入参（那是 v2 设计稿 §4 的范围）；本轮 helper 从 `code` 脚本调用。
- 免费模型建议未被当作事实；全部结论来自本地确定性测试与源码核对。

## 六、交付清单

- `src/codemode.js`（修改：import、prelude helper、host bridge、默认 adapter、注入点）
- `tests/typed-plan-integration.test.js`（新增，16/16 通过）
- `docs/ledger/batch-14-typed-plan-integration.md`（本文件，新增）

未 commit、未 push、未 deploy。
