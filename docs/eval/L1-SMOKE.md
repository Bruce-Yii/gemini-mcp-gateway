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
```

## 基线（独立于当前 run）

唯一基线来源是 `explore/baselines/l1-smoke.json`，一次性从 2026-11-22 G6（228 条，`run-1795368949291-1d86ee2a` / git `6b4254c`）按 smoke task id 过滤后**冻结**进文件：

- 顶层 `metrics`：50 条（全 5 server）的整体基线；
- `byServer`：github / notion / linear / vercel / figma 各 10 条的按 server 指标（来源、runId、时间写在文件里）；
- `serverSets["github,notion,linear,vercel"]`：real 默认跳过 Figma 后的 40 条精确快照（completionRate 77.5、gatewayAnomalyCount 18、searchHitRate 82.4、toolHitRate 53.3、tokens/task 16547、p95 22709）；
- `fake`：确定性接线检查基线，只用于 fake 模式。

`scripts/run-l1-smoke.mjs` 的 `deriveBaselineForServers()` **只从上述基线文件读取**，优先取精确 serverSets 快照，否则按 `byServer` 加权聚合；绝不读 `explore/results/metrics.json` / `anomalies.json`，因为 real 模式刚由 `run-explore.mjs` 写入这两个文件，把它们当基线会造成 baseline === current，阈值永远“通过”。这个自引用 bug 已由 `tests/l1-baseline.test.js` 覆盖（当前文件与基线文件不同 → 断言失败；byServer 选择；当前 run 文件不得作为基线）。

若基线文件缺少所需 server 的 `byServer` / `serverSets`，会**显式回退**到整体 50 条基线，并在报告里写明 `baseline-source: overall 50; not per-server`（JSON `baseline.fallback: true`、控制台 WARNING）。回退不是等价比较，可能掩盖回归，看到该提示应更新基线文件。

## 阈值

完成率、gateway 归因异常、searchHit、toolHit 各 10% / +3 容差；tokens/task、p95 另有上限。
超阈值退出码 1；免费模型有波动，连续两次红才在周报标 ALERT，单次失败仍记录。

## 限制

- real 需要免费模型 key + 上游 token secrets；
- Figma 配额低，默认跳过；
- 旧 G6 归因器有已知误标，L1 只看相对变化；
- fake/replay 结果不能当真实质量。

## 产物

- `docs/eval/l1-smoke-report.md`（fake）
- `docs/eval/l1-real-YYYY-MM-DD.md/.json`（real）
- `docs/eval/l1-real-state.json`（连续失败状态）
