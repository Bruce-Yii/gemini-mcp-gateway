# L1 online-gap profile 接入说明（N1–N9 + J1–J6）

> 状态：**评测接线文档（新增）**。本文件说明如何把 `explore/tasks-online-gap.json`
> （N1–N9）与 `explore/tasks-online-gap-2.json`（J1–J6）接入 L1 smoke runner
> 的可选 `online-gap` profile，以及冻结基线、扩展指标、SKIP 规则与证据边界。
>
> 只新增/改动 4 个文件：`scripts/run-l1-smoke.mjs`（加可选 profile）、
> `tests/l1-online-gap-wire.test.js`、`docs/eval/L1-ONLINE-GAP-WIRE.md`（本文）、
> `docs/ledger/batch-15-l1-gap-wire.md`。**不改** `src/`、`explore/tasks-smoke.json`、
> `explore/baselines/l1-smoke.json`、其它 scripts/tests/README/workflows/explore 任务集。
> 不 commit / push / deploy。

## 0. 一句话

`--profile online-gap` 把 N1–N9 + J1–J6（共 **15** 个 fake/replay 任务）接入 L1 runner；
**没有 `--profile` 时，runner 的默认行为与之前逐字一致**（fake 仍跑 50 个 L1 任务）。
扩展的 6 个指标在算不出来时记 `unknown`；缺 fixture / 未知任务显式 `SKIP`；
冻结基线按 **task id + fixture hash** 只读比对，当前结果写到**单独文件**。

## 1. 怎么跑

```bash
# 默认 L1（完全不变；50 任务，fake-dry-run PASS）
node scripts/run-l1-smoke.mjs --mode fake

# 新增：online-gap profile（offline、零凭据、零网络）
node scripts/run-l1-smoke.mjs --profile online-gap

# 校验接线测试（21 项全绿）
node --test tests/l1-online-gap-wire.test.js
```

`--profile online-gap` 产物（**当前结果**，每次重跑覆盖）：

- `docs/eval/l1-online-gap.json`
- `docs/eval/l1-online-gap-report.md`

冻结基线（**只读**，本批未创建，run 只读取；路径固定但不存在时表示「尚无基线」）：

- `explore/baselines/l1-online-gap.json`（`readOnly: true`，`identity` 为 `{taskId: fixtureHash}`）

默认 L1 产物仍为 `docs/eval/l1-smoke.json` / `l1-smoke-report.md`，profile 不覆盖它们。
未知 profile 名直接 exit 2 并报 `unknown profile`，不会静默回退到默认 L1。

## 2. 加载与 SKIP 规则（不静默 pass）

`loadOnlineGapTasks()` 只从两个任务文件读取任务：

| 文件 | 任务 |
|---|---|
| `explore/tasks-online-gap.json` | N1–N9 |
| `explore/tasks-online-gap-2.json` | J1–J6 |

每个任务必须 `dryRun === true && forRealWrite === false`，否则 SKIP（`unsafe-write`）——
profile 里禁止真写。以下情况**显式 SKIP**，并且写入当前结果 JSON 的 `skipped` 数组、
打印到 stdout，绝不并入分母或当成 pass：

- `unknown-task`：任务 id 不在规范集合（N1…N9 / J1…J6）；
- `missing-file` / `bad-file`：任务文件缺失或不可解析；
- `missing-fixture`：`preconditions` 中引用了不存在且非文档类的仓库相对 fixture 路径
  （如 `work/fixtures/gap.json`）；行内描述（fake 上游运行时合成）不算缺失；
- `duplicate-task` / `missing-task`：重复 id，或声明了却没出现。

实测（当前 checkout）：**loaded=15，skipped=0**。

## 3. 扩展指标（6 项，算不出记 unknown）

`computeOnlineGapMetrics()` 为每个任务输出以下字段，缺失证据时为字符串 `unknown`，
对该任务不适用时为 `null`：

| 指标 | 相关任务 | 含义 | 无证据时 |
|---|---|---|---|
| `writePostConditionOk` | N1 / N9 / J1 | 写后读回字节相等、无下载提示污染 | `unknown` |
| `idAsPrNumberCount` | N3 / J2 | 内部 id 被误当 PR number 的次数 | `unknown` |
| `wrapperUnwrapDepthConsistent` | J3 | 并发批次每个槽位解包层级一致 | `unknown` |
| `truncationTailMetadataOk` | J4 | 截断携带 limit/original 且尾部关键字段有交代 | `unknown` |
| `atomicByDefault` | J5 | 多文件写默认原子（失败零落盘） | `unknown` |
| `ciWaitRounds` | J6 | 一次等待到终态的轮数 | checkout 无 wait helper → `unknown`（missing-capability，不记 pass/fail） |

J6 带 `skipReason`（`waitForPrChecks` / 等价 helper 不存在，已全仓搜索确认）。
按 `ONLINE-SEMIONLINE-JOIN-2026-11-23.md` §4.2，**helper 不存在 ≠ 测试失败**，
也绝不等于通过；记 `unknown` 并保留搜索到的 REST helper 名作为证据。

## 4. 冻结基线与隔离

1. **身份键**：`fixtureHashForTask()` 对任务的 `id + server + tool + prompt +
   expectedTools + expectedOps + buildAxis + preconditions` 做 sha256（取前 16 hex）。
   冻结基线 `identity` 为 `{ [taskId]: fixtureHash }`。
2. **只读**：`freezeOnlineGapBaseline()` 与 `loadOnlineGapBaseline()` 都会对文档做深度
   `Object.freeze()`；加载器只接受 `readOnly === true` 的文档。基线只能由一次性快照写入，
   **runner 永不写基线文件**。
3. **禁止自引用**：基线**只从** `explore/baselines/l1-online-gap.json` 读；
   绝不读 `explore/results/*`（那是当前 run 产物，会让 `baseline === current` 使阈值平凡通过）。
4. **当前结果分离**：run 只写 `docs/eval/l1-online-gap*.{json,md}`，与基线文件物理隔离。
5. **hash 漂移即 unknown**：`compareOnlineGapCurrent()` 对每个任务核对冻结 hash；
   hash 变化 / 无基线条目 / 无当前行 / 指标缺失 → `status: 'unknown'`，**不是 pass**。
   布尔指标 `true → false` 是 `fail`（exit 1）；计数指标只给 delta，不设硬阈值。

当前 checkout 尚无冻结基线文件：profile run 报 `ok: true`（**接线** PASS），
但 `allUnknown: true`，报告明确写「no baseline: all metrics unknown」——
这是管线通过，**不是**质量通过。

## 5. 哪些需要 real / deploy（本 profile 不做）

本 profile 是 fake/replay 接线检查，**不是质量证据**，也不代表网关行为已修好。
下表列出仍必须由人工/gated 流程完成的事项：

| 事项 | 状态 | 需要的证据 / 前置 |
|---|---|---|
| F1 旧构建 vs 当前构建 byte-exact 配对（J1） | `pending-deploy` | 部署窗口 + 真实读→写→读回 + requestId/capture；旧构建观测只作参照，**禁止跨构建相减** |
| F2 canonical PR number 真形状（J2） | `pending-deploy` | 部署窗口 + 真 PR 结果 + requestId；PR #53 是外部事实，不是 capture 证据 |
| F3 batch wrapper / F4 truncation tail / F5 atomic-by-default（J3/J4/J5） | `needs-repro` | 按 AGENTS.md 用同 code/args/fixture 本地复现 → 确定性回归 → 才升级为 `fixed` |
| F6 CI wait helper（J6） | `unknown` | helper 落地（当前不存在）→ 真 CI run（vault token，非 CI）→ 一次等待到终态 + 302 不转 token + 截断标记 |
| 冻结基线首次建立 | 未建立 | 由 lead 人审确认后，以一次性快照写入 `explore/baselines/l1-online-gap.json`；本批不创建 |
| requestId / capture 证据链 | 全批 unknown | `requestIds:["unknown"]`、`captureVerified:false`；不补造 UUID，不从 prompt 猜 task |

同构建配对规则（继承 `ONLINE-SEMIONLINE-JOIN-2026-11-23.md` §4 与 `TYPED-PLAN-TEST-PLAN.md`
§1.3/§6.3）：同 prompt / 同 fixture / 新 sessionId / 同预算 / 同判据；
**禁止**把生产旧构建的在线观测与新代码构建的 fake/replay 结果混算成差值。

## 6. 与旧 L1 / G6 的关系

- **不替换、不修改**旧 L1：`tasks-smoke.json`（50 任务）、`explore/baselines/l1-smoke.json`
  （G6 228 → L1 50 的冻结快照，`runId run-1795368949291-1d86ee2a` / git `6b4254c`）
  与 `docs/eval/l1-smoke*.{json,md}` 全部保持原样。
- profile 是**并列的可选轨道**：默认路径（含 fake / real / replay、failed-server
  降级、byServer 基线推导、ALERT 规则）完全不变，仅当 `--profile online-gap` 出现才分支。
- 新基线独立：不复用 G6 的 `metrics` / `byServer` / `serverSets` 数字；N/J 任务没有
  G6 历史观测，因此新基线必须独立冻结，且以 id+fixture hash 为键。
- 指标用途不同：旧 L1 主指标是 `completionRate` / `searchHitRate` / `toolHitRate` /
  `tokensPerTask` / `p95LatencyMs`；本 profile 的 6 个扩展指标是**轴级断言**，
  不能与在线单请求指标互相换算（`durationMs ≠ p95LatencyMs`、`bytes ≠ tokensPerTask`）。

## 7. 测试与验证证据

`node --test tests/l1-online-gap-wire.test.js`：**21 tests / 21 pass / 0 fail / 0 skip**。
覆盖：加载数量（15）、唯一 id、SKIP 各分支、基线 id+hash 身份、深度只读、
基线不读 explore/results、当前结果文件分离、6 指标字段与 unknown、hash 漂移 unknown、
布尔回归 fail、确定性（同输入字节相同 JSON）、默认 fake 50 任务 PASS 且无 profile 字段、
profile 端到端 exit 0 且写独立文件、未知 profile exit 2。

`node scripts/run-l1-smoke.mjs --mode fake` 实测仍输出
`fake-dry-run: PASS | measured=50/50 (full=50) ...`，exit 0。

遵守 `AGENTS.md`：无网络、无真实凭据、无真实写；用户反馈/模型输出只作待验证假设，
不驱动改 `src/`、开 issue、合并或部署。
