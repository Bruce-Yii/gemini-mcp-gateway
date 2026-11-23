# B14 · typed-plan 隔离原型（结论报告）

> 日期：2026-11-23。仅新增 3 个文件：`scripts/typed-plan-spike.mjs`、
> `tests/typed-plan-spike.test.js`、本文件。未改 `src/`、其他 scripts/tests、
> README、workflows；未接入生产、未 commit / push / deploy。
>
> 目标：验证 `plan: [{op, ...}]` 的可行性，**不替换 Code Mode**。结论先行：
> typed plan 可行，但只适合作为 Code Mode 之上的“窄而可验证”的补充层，
> 不能承载任意控制流与跨步骤计算——那些必须留在 Code Mode。

## 一、原型做了什么

- **Op registry**（单一事实来源）：`readFileRange`、`repoGrep`、`ensureBranch`、
  `applyPatch`、`openPr`、`runChecks`，每项声明 `effect: 'read'|'write'`、
  必填/可选参数类型、以及一个 `run(args, ctx)` 处理器。处理器默认调用注入的
  fake I/O；调用方可完全替换为真实适配器，但原型本身不接任何上游。
- **校验器 `validatePlan`**：在执行任何处理器之前，对整个 plan 做纯结构校验：
  - 未知 op → 拒绝（handler 根本拿不到执行机会）；
  - 缺参、类型错（含 `NaN` 的 number、可选参数类型错）→ 逐个列出错误；
  - 危险 op（写操作）必须满足以下之一：全局 `dryRun:true`、该步 `approve:true`、
    或全局 `approve: [op, ...]` 白名单。三者都没有就拒绝。
- **执行器 `executePlan`**：顺序执行、逐步产出稳定形状：
  - 成功：`{ok:true, op, result}`；失败：`{ok:false, op, error}`（两者互斥，
    不会出现 `result` 与 `error` 同时存在或同时缺失）。
  - 顶层返回 `{ok, dryRun, steps, stoppedAt, error, validationErrors?}`。
  - 失败即停：`stoppedAt` 指向失败步索引；**后续步骤不出现在 trace 中**，
    不伪造 `skipped` 条目，便于审计“到底哪一步真的跑了”。
  - 控制字段 `op` / `approve` 在交给 handler 前被剥离，不泄漏进参数。
  - dryRun 下 `applyPatch` 返回 `preview` + 差异统计，绝不调用写回调。
- **CLI 冒烟**：`node scripts/typed-plan-spike.mjs` 打印一条 dry-run trace。

## 二、复用现有纯函数（不复制大段代码）

| 复用项 | 来源 | 用法 |
|---|---|---|
| `applyTextPatch` | `src/file-write.js`（纯函数，严格上下文校验、原子失败、保留行尾） | `applyPatch` op 的 diff 核心。原型只做“读当前文本 → 调 applyTextPatch → 成功才把结果交给注入的 write”这段编排，**没有**自己解析 unified diff，也没有复制 `parseUnifiedDiff` / `precheckText` 的逻辑。 |

说明：`src/file-write.js` 本身是 B10/B11 已有的 host 侧纯模块，依赖注入
`read`/`write`，正好与 spike 的 I/O 注入模型对齐。原型通过相对路径 import
直接复用它，而不是 import `src/codemode.js`（后者依赖 `run`/`acorn` 且会触发
沙箱）；因此 spike 保持零网络、零凭据、零生产副作用。

未复用（有意不碰）：`codemode.readFileRange/repoGrep/ensureBranch/upsertPr` 等
沙箱 helper——它们是 Code Mode 沙箱内的胶水，原型只在文档中把 op 名映射到它们，
行为用 fake 复现，验证的是“plan 的形状与执行语义”，不是它们的真实调用链。

## 三、测试与证据

`tests/typed-plan-spike.test.js` 共 **9 个测试**（覆盖要求的 8 类场景 + registry 完整性）：

1. 成功流：read → patch → check；稳定步形状；读操作无需批准；dryRun 下零写入。
2. 未知 op：校验期拒绝，`steps: []`，handler 零调用。
3. 参数错：缺参、wrong type、NaN、`limit` 可选参数错，全部拒绝且零执行。
4. write 批准门：无 dryRun / 无 approve 被拒；全局 op 白名单与逐步 `approve:true`
   两种形式均可放行；控制字段不泄漏进 handler args。
5. patch 失败：上下文不匹配 → `PATCH_FAILED: ... context mismatch`，零写入。
6. 部分失败：第 3 步抛错，trace 只含前 3 步，`stoppedAt:2`，后续 `runChecks` 未运行。
7. 空 plan：`[]` / null / 非数组统一报 `plan must be a non-empty array`。
8. 确定性：相同输入两次执行返回深相等结果；冻结的 plan 不被修改；校验器幂等。
9. registry 完整性：恰好 6 个 op，effect 标注正确。

运行：`node --test tests/typed-plan-spike.test.js` → **9/9 通过**；
CLI 冒烟 `node scripts/typed-plan-spike.mjs` 输出 3 步成功 dry-run trace。
全程不联网、不读真实凭据、不写文件。

## 四、原型结论：哪些 op 适合 typed

判定标准：参数形状固定、无跨步骤数据依赖、失败语义可枚举、调用是“一次性动作”。

**适合 typed（本原型的 6 个均符合大部分条件）：**

| op | 为什么适合 | 注意 |
|---|---|---|
| `readFileRange` | 参数就是 `path/startLine/endLine`；结果稳定；天然只读 | 截断标记必须显式返回并由调用方处理（复用 `file-write.js` 的“拒绝 patch 截断读取”契约） |
| `repoGrep` | `pattern` 等固定参数；结果可枚举 | 正则非法要在校验/执行期转成结构化 error；结果条数要有上限 |
| `runChecks` | `command` + 固定结果 `{ok, ...}` | 真实环境里 command 白名单化，禁止任意 shell 字符串 |
| `applyPatch` | 单一 `path` + `patch`；可先 dryRun 预览 | 依赖前序 `readFileRange` 拿到的内容做上下文校验——这是**唯一**需要轻量“跨步上下文”的 op，原型通过注入的 io 读当前文件而不是把 step 结果传下去，避免引入表达式语法 |
| `ensureBranch` | 幂等、参数固定、写操作可显式批准 | 需把 `ifExists: reuse/reset` 作为枚举参数，不允许自由布尔组合 |
| `openPr` | 标题/头/基固定；写操作可显式批准 | 真实实现应走现有 `upsertPr` 的幂等语义，typed 层只负责“批准与参数校验” |

**必须 code fallback（留在 Code Mode）：**

- **控制流**：条件分支、重试、循环、分页循环（例如 `readFileRange` 按 `nextStart`
  一直读到不截断、`repoGrep` 多模式组合）。typed plan 刻意不支持。
- **跨步骤计算/数据整形**：把上一步结果过滤、拼接、去重后再喂给下一步；
  “读取 PR 列表 → 找 head==X 的那个 → 取其 number → 更新它”。这需要 JS 表达式，
  加固成 DSL 的成本远高于直接用 Code Mode。
- **形状不确定的上游**：Notion/Linear 返回值差异大、GitHub 结果可能是 JSON 文本
  或 envelope；防御性 `Array.isArray` / `unwrap` 属于代码逻辑，typed 参数无法表达。
- **任意工具调用组合**：6 个 op 覆盖不了的上游工具（发布、评论、review、release…）
  不应靠不断膨胀 registry 解决——registry 膨胀就是重新发明一套弱化的 Code Mode。
- **错误恢复策略**：失败后是回滚、改参数重试还是换路径，属于策略而非声明。

## 五、与 3 tools 的接口设计（建议，未实现）

现有对外 3 tools（按 AGENTS.md / `src/codemode.js` 现状）：
`search`、`execute_read`、`execute`。typed plan **不新增第 4 个 MCP tool**
（会触发工具列表变更/schema 重连问题）。建议接口如下：

1. **作为 execute 内的一个宿主 helper（推荐）**：
   在 Code Mode 沙箱里暴露 `codemode.runTypedPlan(plan, {dryRun, approve})`。
   - 模型先用 `search` 找到所需能力，再决定用 `execute` 写普通脚本，或在
     “纯顺序、参数已知、含写操作”的场景下写 `{op,...}` 数组交给 helper。
   - helper 内部严格做本原型的校验 + 顺序执行；写 op 仍然要求
     `dryRun` 或 `approve`（与现有写语义一致，不绕过）。

2. **plan 作为模型输出的数据，不是新工具参数**：
   `execute` 的脚本可以写 `const plan = [...]; return codemode.runTypedPlan(plan, {dryRun:true});`。
   这样 schema 不变、3 tools 数量/顺序不变，符合“工具列表必须稳定”的约束。
   `execute_read` 只允许 read-effect op（校验器加一个 `readOnly:true` 选项即可，
   原型已把 effect 标注清楚，接入时一行判断就能拒绝 write op）。

3. **结果编码**：沿用 `client-profile.js` 的编码规则——Gemini 用 text JSON，
   ChatGPT/Claude 用各自 profile；每步 `{ok,op,result|error}` 稳定形状天然适合
   被 `sanitizeTool` 后的 schema 描述（array 带 items，object 无多类型 oneOf）。

4. **写路径继续复用 host 的 `applyFilePatches` / `upsertPr`**：typed 层的
   `approve`/`dryRun` 只做“是否允许发起”的决策，真正的原子写、sha 乐观锁、
   precheck 仍由 `src/file-write.js` 和 `src/github-helpers.js` 负责；typed 原型
   不复制这些逻辑。

5. **明确不做的集成**：不把 plan 塞进 `tools/list`，不改 `CONTRACT.md`，
   不改白名单排序；接入时机与是否接入由 lead 决定。

## 六、边界与风险

- 原型只有 6 个 op，参数类型是基础的 string/number，**没有枚举、范围、正则编译校验**；
  接入真实工具前须补齐（例如 `command` 白名单、branch 名格式）。
- `runChecks` 的 effect 标为 `'read'`，但真实执行可能有副作用/耗时；接入时建议
  改成独立 effect 或强制 `approve`，文档已标注该假设。
- dryRun 只保证“不调用注入的 write”；真实 upstream 的 dry-run 语义仍需单独验证。
- 失败即停是刻意选择；不做补偿/回滚（与 `file-write.js` 的 `partialFailure` 报告
  语义不同——那里是多文件原子写的部分落盘报告，这里是跨 op 的顺序 halt）。
- 免费模型建议未被当作事实；本原型所有结论均来自本地确定性测试。

## 七、交付清单

- `scripts/typed-plan-spike.mjs`（新增）
- `tests/typed-plan-spike.test.js`（新增，9/9 通过）
- `docs/ledger/batch-14-typed-plan-spike.md`（本文件，新增）

未 commit、未 push、未 deploy；等待 lead 审阅决定是否接入。
