# B14 — typed-plan / Code Mode A/B runner 骨架（fake/replay，离线）

> 状态：**已落地，仅 3 个新增文件**。本轮只写 `scripts/typed-plan-ab.mjs`（新增）、
> `tests/typed-plan-ab.test.js`（新增）、本文件（新增）。未改 `src/`、其他
> `scripts/`/`tests/`、`README`、其他 docs、workflows、配置或任务集；未接真实模型、
> 未联网、未 commit/push/deploy。
>
> 输入依据：`docs/eval/TYPED-PLAN-TEST-PLAN.md`（A/B 定义、40 条任务集、§4 指标、
> §5 错误八类、§7 A1–A7 门槛、§6.1 fake/replay/real 递进）、
> `explore/tasks-online-gap.json`（N1–N9 fixture）、
> `scripts/typed-plan-spike.mjs`（op registry / validatePlan / executePlan 的真实形状，
> 本 runner 直接 import 它，不复制实现）、`docs/ledger/batch-14-typed-plan-v2.md`（v1/v2
> 与 fallback 语义）、根 `AGENTS.md`（免费模型建议只是假设）。

## 一、目的与边界

落一个**可验证的 A/B runner 骨架**：同一批任务分别跑 Profile F（v1 自由 code）与
Profile S（v2 typed plan + code fallback），产出逐 task 指标、配对汇总、A1–A7 判定与
JSON/markdown 报告。本轮**只验证测试管线正确性**，fake/replay 数据不得写成「S 优于 F」
的质量证据，也不得据此切换默认 profile。

硬边界：

- 默认零网络、零凭据、零真实写；决策所需 I/O 全部经 `options.model` / `options.io`
  注入。runner 源码不 import `http(s)`/`net`/`child_process`，不调用网络 API。
- 真实模型只有**注入点**：调用方自行传入实现 `decide(profile, task, ctx)` 的 adapter；
  本脚本不提供、不加载任何真实模型客户端。
- 不重构任务 prompt；F/S 拿到同一个 task 对象，prompt 逐字不变。
- 同输入同输出：数据路径不含 `Date.now()` / `Math.random()`；报告也可重复生成逐字相同。

## 二、数据结构

| 对象 | 关键字段 | 说明 |
|---|---|---|
| Profile F | `protocolVersion:'v1'`, `inputMode:'code'` | 对照；`execute(_read)({code})` 自由脚本路径 |
| Profile S | `protocolVersion:'v2'`, `inputMode:'plan+fallback'` | 实验；`plan:[{op,...}]` 主路径 + `meta.fallback` 可观测回退 |
| TOOL_FACE | `['search','execute_read','execute']` | 两侧恒定，同名同序（A7 `stable_tools_list`） |
| trace | `profile/taskId/decision/searchHits/executedOps/tokens/wallMs/errors/fallback/writeReplaySteps/execution` | 原始证据；F 记 codeOps，S 记 spike 执行器 steps |
| metrics | `completion/toolHit/searchHit/repair/tokens/wallMs/writeReplay/errorClass/unverified/fallback` | 每 task 每 profile 一条，null=不适用/剔除 |
| run | `{taskId, repeat, order, F, S, traces}` | 配对单元；`order` 按 repeat 交替 F→S / S→F |
| report | `meta/tasks/summary/gates` | JSON 与 markdown 同源渲染 |

`errorClass` 为 E1–E8 之一或 null；无法归类的错误置 `unverified:true` 且 `errorClass:null`
（AGENTS.md 硬规则：归因器输出只是假设，未本地复现不计入验收统计）。`fallback` 为
`{reason:1|2|3|4, attemptPlan, atStep}`，F 侧恒 null。

## 三、Runner 行为

1. `loadTaskSet`：接受文件路径（`{tasks:[...]}` 或裸数组）或数组；默认
   `explore/tasks-online-gap.json` 的 N1–N9，也可喂 40 条任务集。
2. `createFakeModel`：确定性假模型。按 task 的 `expectedTools`/`expectedOps` 生成
   codeOps 或 plan；`fakeErrors`/`fakeTokens`/`fakeWallMs`/`fakePlanErrors`/
   `fakeComplex`/`fakeMissingOp`/`fakeExplicitCode`/`fakeFallback` 等字段注入故障与
   fallback 条件（覆盖 §1.2 四种触发）。
3. `runTask`：
   - S 且未 fallback → 调 spike 的 `executePlan(plan,{dryRun,approve,io})`，写 op 默认
     `dryRun:true`，真写需显式 `forRealWrite/approve`；非 ok step 转成可分类错误。
   - F 或 S fallback → 不执行 JS，仅把 adapter 声明的 ops 作为可观测 trace
     （真实 code 执行仍属于 adapter 注入点）。
4. `computeMetrics`：`completion` 用 anomaly proxy（E7/runner_error 才失败）；
   `toolHit` 要求 expected 集合全覆盖、null 剔除；`searchHit` 用 search 结果命中；
   `repair` = 注入错误数 + plan 重试；`tokens=input+output`（S 的 plan schema token 由
   adapter 计入）；`p95` 为 nearest-rank wallMs；`writeReplay` 要求
   `dryRun→write→verify` 三步齐全（非写任务记 null，不进分母）。
5. `summarize`：按 profile 聚合率/均值/p95，显式分母，null 剔除；`pairedDiff` 给
   completion/tokens/repair 的 S−F 差值。不做跨平台合并。
6. `evaluateGates`：A1–A7 逐项 PASS/FAIL/NOT_ENOUGH。只有 `environment==='real'`、
   `repeats>=3` 且 `platform==='gemini'` 才给实质判定；其余一律 `NOT_ENOUGH`，
   decision=`INSUFFICIENT`。即使全 PASS，`defaultSwitchAllowed` 恒 `false`
   （需 lead 人审），符合「数据不到不切 / 不自动切默认」。
7. 报告：`buildReport` → `renderJson` / `renderMarkdown` / 可选 `writeReport`；
   CLI `--write` 才落盘，默认 stdout 输出 JSON。CLI 没有传 frozen baseline/conformance
   的参数，故 CLI 报告必然 NOT_ENOUGH——防止命令行误产出「通过」结论。

## 四、测试与证据

`node --test tests/typed-plan-ab.test.js` → **23/23 通过**（离线、fake io、无联网）：

1. 数据结构常量：F/S profile、三工具面、A1–A7、E1–E8、fallback reason 1–4。
2. fixture 运行：N1–N9 全部加载并产出 9 对指标；prompt 逐字不变；每项指标类型/取值合法。
3. 3 次重复：`order` 交替 F→S / S→F，整轮输出逐字相同。
4. S 执行 registry plan：`dryRun` 写不产生真实写（`io.calls` 无 `writeFile`）；
   F 走 codeOps 并记录写回放三步。
5. 指标计算：null 分母、部分覆盖记 miss、completion proxy、写回放三步、tokens/p95。
6. 错误分类：E1–E8 八类各一样本；未知信号 → `unverified` 且 `errorClass:null`。
7. fallback：reason 1/2/3/4 全部在 S 的 trace/metrics 中可观测，F 侧恒 null；
   无 fallback 的 S 走 plan 路径而非静默 code。
8. 汇总：配对差值、null 剔除、显式分母、`errorClasses` 分布。
9. 门槛：fake/replay/2 次/非 Gemini lane 全部 NOT_ENOUGH 且 `INSUFFICIENT`；
   构造足量 real Gemini 数据时 A1–A7 可全 PASS，但 `defaultSwitchAllowed=false`；
   A2/A5/A7 负例分别 FAIL → `BLOCKED`。
10. 报告：JSON 可解析、markdown 含 gates 与逐 task 表；临时目录写出与内存渲染逐字一致。
11. 确定性：全量报告两次渲染逐字相同。
12. 不联网：源码无网络/子进程 import 与调用；自定义 adapter 注入生效（不碰网络）。

全量 `npm test`：**tests 1200 / pass 1194 / fail 0 / todo 6 / skipped 0**，耗时约 20.6s。
6 个 todo 是仓库既有标记测试，与本轮改动无关；全程离线，未联网、未 commit。

> N1–N9 的 fake 运行里，多数任务的 `expectedOps` 是 `normalizeFileResult` /
> `applyTextPatch` 这类 helper 而非 spike registry op，因此假模型按 §1.2 条件 2
> 触发 `fallback.reason=2` 并走 code 分支。这是**诚实的可观测结果**：说明当前 spike
> registry 尚不能表达 N1–N9 的 helper 语义，不说明 S 的质量好坏；真实 A/B 需要更完整
> 的 op registry/adapter，并由 lead 复核。

## 五、已知限制 / 后续

- runner 是骨架：不做模型调用、不做真实上游 I/O、不执行 JS code 字符串；F 的 code
  路径仅消费 adapter 声明的 trace。真实 A/B 必须注入实现了工具调用与 trace 记录的 adapter。
- 未接 `/mcp/v2` 路由、未改工具 schema（属于 `batch-14-typed-plan-v2.md` 的范围）。
- `searchHitAt3` / `toolHitAdjusted`、8 类完整样本覆盖、conformance 四检查的真实结果、
  冻结基线读取与人工复核，均是后续实现/跑数项；本轮仅在门槛里留了对应字段/判定位置。
- 40 条任务集可喂入（接口接受数组/JSON），本轮测试只用现有 N1–N9 fixture；新增 TP-xx
  不在本轮落 fixtures（测试方案 §3.3 明确不落代码）。
- 不 commit、不 push、不 deploy；报告默认只打印到 stdout，不改变仓库其他文件。

## 六、交付清单

- `scripts/typed-plan-ab.mjs`（新增）
- `tests/typed-plan-ab.test.js`（新增，23/23 通过）
- `docs/ledger/batch-14-typed-plan-ab.md`（本文件，新增）

未修改 `src/`、其他 `scripts/`/`tests/`、`README`、其他 docs/workflows；未 commit、push、deploy。
