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

## 基线

`explore/baselines/l1-smoke.json`：来自 2026-11-22 G6（228 条）按 50 个 smoke task id 过滤，
不是伪造；fake 有独立 fake 基线，只用于接线检查。

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
