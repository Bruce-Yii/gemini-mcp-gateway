# L1 Smoke — 快速回归手册

> 50 条分层任务，5–10 分钟；和 G6 全量（228 条）分工：L1 日常守门，G6 周期性全量体检。

## 模式

- `fake`：默认，零网络/零凭据，只验证 runner + compare + report 接线，**不代表网关质量**；
- `replay`：用既有 G6 产物离线回放，验证指标计算；
- `real`：真实模型 + 上游，每周一次；Figma 默认跳过，避免烧 Starter 配额。

## 运行

```bash
npm run smoke:l1          # fake
npm run smoke:l1:real     # real（需要模型/上游凭据）
node scripts/run-l1-smoke.mjs --mode replay --input explore/results/anomalies.json
# real 且已知部分上游失败时，显式传入（否则从 explore/results/manifest.json 的 failedServers 读取）：
node scripts/run-l1-smoke.mjs --mode real --servers github,notion,linear,vercel \
  --failed-servers notion,vercel --date 2026-11-23
```

`failedServers` 是显式输入，不靠工具数猜测：`explore/run-explore.mjs` 在 `mgr.connect()` 后把
`UpstreamManager.failedServers` 写进 `manifest.failedServers` 和每条 per-task 行的
`serverFailed`；`run-l1-smoke.mjs` 合并 `--failed-servers` 与 manifest（CLI 兼容旧 manifest）。
仅「连接失败」的 server 会被剔除；连上但白名单为 0 个工具不算失败 server。

## 基线（独立于当前 run）

唯一基线来源是 `explore/baselines/l1-smoke.json`，一次性从 2026-11-22 G6（228 条，`run-1795368949291-1d86ee2a` / git `6b4254c`）按 smoke task id 过滤后**冻结**进文件：

- 顶层 `metrics`：50 条（全 5 server）的整体基线；
- `byServer`：github / notion / linear / vercel / figma 各 10 条的按 server 指标（来源、runId、时间写在文件里）；
- `serverSets["github,notion,linear,vercel"]`：real 默认跳过 Figma 后的 40 条精确快照（completionRate 77.5、gatewayAnomalyCount 18、searchHitRate 82.4、toolHitRate 53.3、tokens/task 16547、p95 22709）；
- `fake`：确定性接线检查基线，只用于 fake 模式。

`scripts/run-l1-smoke.mjs` 的 `deriveBaselineForServers()` **只从上述基线文件读取**，优先取精确 serverSets 快照，否则按 `byServer` 加权聚合；绝不读 `explore/results/metrics.json` / `anomalies.json`，因为 real 模式刚由 `run-explore.mjs` 写入这两个文件，把它们当基线会造成 baseline === current，阈值永远“通过”。这个自引用 bug 已由 `tests/l1-baseline.test.js` 覆盖（当前文件与基线文件不同 → 断言失败；byServer 选择；当前 run 文件不得作为基线）。

若基线文件缺少所需 server 的 `byServer` / `serverSets`，会**显式回退**到整体 50 条基线，并在报告里写明 `baseline-source: overall 50; not per-server`（JSON `baseline.fallback: true`、控制台 WARNING）。回退不是等价比较，可能掩盖回归，看到该提示应更新基线文件。

## 部分上游失败时的基线口径（degraded scope）

冻结基线 `serverSets["github,notion,linear,vercel"]`（40 条，searchHit 82.4 / toolHit 53.3）
的前提是 **5 个 server 全连通**。real run 若只有 2/4 连通（例如 45085493847：notion/vercel 失败），
失败 server 的 20 个任务的 expected tool 根本不进入 `search()` 索引，拿全量基线硬比必然系统性偏低。
因此 real 模式按下面的规则选择比较范围（JSON `baselineScope` / 报告 `Comparison scope`）：

| `baselineScope` | 条件 | 行为 |
|---|---|---|
| `full` | 请求的 server 全部连通 | 与原有 40 条快照比较（Figma 仍跳过） |
| `degraded-subset` | 部分 server 失败，仍有连通 server | **只用连通 server 的任务**，基线从同一冻结文件的 `byServer` 按任务数加权聚合（如 github+linear → 20 条，searchHit 87.5 / toolHit 81.3）；不读当前 run 产物 |
| `no-measured-tasks` | 请求的 server 全部失败 | 跳过所有比较，报 `NO MEASUREMENT` infra 结果、退出码 1；**不是** gateway 回归，也不是用整体基线硬比 |

- degraded 子集若缺少 `byServer` 数据，runner 会**拒绝**用整体基线比较并报告 skip（退出码 1），不会静默退回 50 条。
- CI 仍会在连通任务上出现真实回归时 fail（`compareWithBaseline` 容差不变）。
- 报告/JSON 新增字段：`baselineScope`、`failedServers`、`measuredTasks`、`skippedByServer`。
  失败 server 的任务一律标为 skipped，既不算 gateway miss，也不进入分母。

## searchHit / toolHit 分母口径

历史缺陷：分母只统计「模型实际调用了 `search` / `execute(_read)` 且任务有 expectedTool」的行；
`null`（从未调用）被剔除。失败 server 的任务若模型调了工具就作为 `false` 进分母，没调就作为
`null` 被剔除 —— 同一批任务因模型选择而在「算 miss」和「不算数」之间摇摆。

修正后的公式（`metricsFromExplore` / `explore/summarizeMetrics`）：

```
measurable = 有 expectedTool 且 server 不在 failedServers（row.serverFailed !== true）
primary（与冻结基线同口径，用于阈值比较；null 剔除）:
  searchHitRate  = count(measurable, searchHit === true) / count(measurable, searchHit != null) * 100
  toolHitRate    = count(measurable, toolHit   === true) / count(measurable, toolHit   != null) * 100
adjusted（诊断用；null 视为 MISS）:
  searchHitRateAdjusted = count(measurable, searchHit === true) / |measurable| * 100
  toolHitRateAdjusted   = count(measurable, toolHit   === true) / |measurable| * 100
```

- **失败 server 任务从分子和分母同时剔除**（`skippedByServer` 记录数量），绝不会「一次算 miss、一次剔除」。
- 主指标保留 null 剔除，是因为冻结基线也是这个口径，比较必须同口径；`*Adjusted` 与
  `denominatorFormula` / `searchDenominator` / `toolDenominator` / `adjustedDenominator`
  一并写进 JSON 与 Markdown，便于量化口径影响。
- `explore/results/metrics.json` 的 `summary.toolRecall` 用修正口径（含
  `denominatorTasks` / `denominatorFormula` / `skippedByServer`），旧口径保留在
  `summary.toolRecallRaw`，标记为「非等价、上游失败时不可用于判定」。

## 阈值

完成率、gateway 归因异常、searchHit、toolHit 各 10% / +3 容差；tokens/task、p95 另有上限。
超阈值退出码 1；免费模型有波动，连续两次红才在周报标 ALERT，单次失败仍记录。

## 限制

- real 需要免费模型 key + 上游 token secrets；上游 token 失效会触发 `failedServers` /
  `NO MEASUREMENT` infra 标记（需要重新授权），不要把它当 gateway 回归；
- Figma 配额低，默认跳过；
- 旧 G6 归因器有已知误标（`applyServerCoverage()` 会把 0-工具 server 的 gateway anomaly
  降级为 infra），`gatewayAnomalyCount` 在部分上游失败时只能作为参考；L1 只看相对变化；
- degraded 子集基线来自同一 G6 冻结快照的 `byServer` 聚合，不是「半连通条件下新采集的
  可信基线」，只能消除口径不一致，不能替代全连通重跑；
- fake/replay 结果不能当真实质量。

回归测试结果与失败用例见 `tests/l1-failed-server.test.js`（4/4、2/4、1/4、0/4 连通、
分母口径、旧行为兼容、真实回归仍 fail）与 `docs/eval/l1-real-regression-2026-11-23.md`。

## 产物

- `docs/eval/l1-smoke-report.md`（fake）
- `docs/eval/l1-real-YYYY-MM-DD.md/.json`（real；含 `baselineScope` / `failedServers` /
  `measuredTasks` / `skippedByServer` / 分母公式）
- `docs/eval/l1-real-state.json`（连续失败状态）
- `explore/results/manifest.json`（`failedServers` / `serverToolCounts`；下游范围判定输入）
