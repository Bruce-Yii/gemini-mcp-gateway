# B15 · N1–N9 / J1–J6 接入 L1 smoke runner 与基线冻结（2026-11-23）

> 范围（本批只写 4 个文件）：
>
> - `scripts/run-l1-smoke.mjs`（修改）：新增**可选** `--profile online-gap`，加载 N1–N9 +
>   J1–J6；新增加载/SKIP、fixture hash、只读冻结基线、扩展指标、比较与报告纯函数。
> - `tests/l1-online-gap-wire.test.js`（新增）：21 项离线接线测试。
> - `docs/eval/L1-ONLINE-GAP-WIRE.md`（新增）：跑法、SKIP/指标/基线规则、real/deploy 边界、
>   与旧 L1/G6 的关系。
> - 本台账 `docs/ledger/batch-15-l1-gap-wire.md`（新增）。
>
> **未改** `src/`、其它 scripts/tests、README、其它 docs、workflows、explore 任务集；
> **未 commit / push / deploy**；零网络、零真实凭据、零真实写。工作区里其它 agent 的并发
> 改动一概未碰。遵守 `AGENTS.md`：用户反馈与免费模型输出只是待验证假设。

## 一、目标与边界

把 `explore/tasks-online-gap.json`（N1–N9）与 `explore/tasks-online-gap-2.json`（J1–J6）
接入 L1 smoke runner，但不改变任何默认行为、不改核心。默认（无 `--profile`）路径必须
逐字保持：fake 仍 50 任务、real/replay/failed-server 降级、G6 冻结基线与 ALERT 规则不动。

## 二、实现摘要

1. **可选 profile**：`parseArgs()` 新增 `profile`（默认 `null`）；`main()` 中仅在
   `opts.profile === 'online-gap'` 时进入新分支；未知 profile exit 2，不静默回退。
2. **加载与 SKIP**：`loadOnlineGapTasks()` + `checkFixtures()`。未知 id、缺文件、缺 fixture、
   重复/缺失任务、非 dryRun 任务全部生成 reason-bearing `SKIP` 记录（写进当前结果并打印），
   不并入分母、不静默 pass。实测 loaded=15 / skipped=0。
3. **扩展指标**：`computeOnlineGapMetrics()` 输出
   `writePostConditionOk / idAsPrNumberCount / wrapperUnwrapDepthConsistent /
   truncationTailMetadataOk / atomicByDefault / ciWaitRounds`，算不出为 `unknown`，不适用为
   `null`；J6 因 checkout 无 wait helper 固定 `unknown`（missing-capability，非 pass/fail）。
4. **基线冻结**：`fixtureHashForTask()`（id + fixture 字段 sha256，16 hex）、
   `baselineIdentity()`、`freezeOnlineGapBaseline()` / `loadOnlineGapBaseline()`（深度只读，
   只接受 `readOnly:true`）、`compareOnlineGapCurrent()`（hash 漂移 → unknown；布尔回归 → fail）。
   基线路径 `explore/baselines/l1-online-gap.json`（本批未创建，runner 只读不写）；
   当前结果路径 `docs/eval/l1-online-gap*.{json,md}`（物理隔离）。绝不读 `explore/results/*`。
5. **报告**：`renderOnlineGapReport()` 确定性输出（无时间戳字段混入正文），列出 loaded/hash、
   SKIP、各指标 current/baseline/status。

## 三、验证证据

```
node --test tests/l1-online-gap-wire.test.js
  tests 21 | pass 21 | fail 0 | skipped 0 | cancelled 0

node scripts/run-l1-smoke.mjs --mode fake
  [l1-smoke] fake-dry-run: PASS | measured=50/50 (full=50) ...   exit 0

node scripts/run-l1-smoke.mjs --profile online-gap
  [l1-smoke] profile=online-gap: PASS (no frozen baseline: all metrics unknown)
             | loaded=15 skipped=0 baseline=none                  exit 0
```

测试覆盖：加载数量与唯一 id、SKIP 全分支、基线 id+hash 身份与确定性、深度只读、
基线不读 explore/results、当前结果与基线文件分离、6 指标字段与 unknown、hash 漂移
unknown、布尔回归 fail、同输入字节相同、默认 fake 50 任务且结果无 profile 字段、
profile 端到端写独立文件、未知 profile exit 2。

## 四、与旧 L1/G6 / deploy 的关系

- 旧 `tasks-smoke.json`（50）、`explore/baselines/l1-smoke.json`（G6 快照）与
  `docs/eval/l1-smoke*` 全部不动；新 profile 是并列可选轨道，不是替换。
- 新基线独立冻结，不复用 G6 数字（N/J 任务无 G6 历史观测）。
- 本 profile 是 fake/replay 接线检查，**不是质量证据**。F1/F2 仍 `pending-deploy`；
  F3/F4/F5 `needs-repro`；F6 `unknown`（helper 不存在）；requestId 全批 `unknown`，
  不补造 UUID。部署后在线复验（J-DEPLOY）是 gated 人工流程，不在本批范围。
- 禁止跨构建硬比、禁止把在线单请求指标当 L1 任务指标（见
  `docs/eval/L1-ONLINE-GAP-WIRE.md` §5、§6）。

## 五、交付检查

- [x] 只写允许的 4 个文件；未改 src/ / 其它 scripts/tests / README / workflows / explore 任务集
- [x] 默认行为不变（fake 50 任务 PASS，无 profile 字段）
- [x] 15 任务加载、0 SKIP；SKIP 分支有测试
- [x] 6 扩展指标字段存在，算不出记 unknown，J6 记 missing-capability/unknown
- [x] 冻结基线 id+hash、只读、与当前结果分离；hash 漂移不复用旧值
- [x] 21/21 测试通过，0 fail；确定性验证
- [x] 零网络、零真实凭据、零真实写；未 commit / push / deploy
