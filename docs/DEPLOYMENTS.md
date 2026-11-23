# Deployment log

| 时间 (Asia/Singapore) | Commit | 目的 | 结果 | 备注 |
|---|---|---|---|---|
| 2026-11-24 00:50 | `87d91af` | 验收门 A：部署最新代码并核对 healthz build-info | PASS | `commit=87d91af0caf84f1bc2f5ed1fff3ba20bbe234472`，`buildHash=02c96881...`；`/mcp` 401；未做真实客户端/授权验收 |

| 2026-11-24 01:12 | `758a232` | push main 自动 production 部署（8 个 docs 提交之一） | READY | healthz `758a232…` / `02c96881…`；A 门因此退回 PARTIAL；实际部署 40 条，日志不完整 |\n\n## 规则

- 每次部署前过 [DEPLOY-POLICY.md](DEPLOY-POLICY.md) 检查；
- 记录 commit、目的、healthz 证据、对应 acceptance gate；
- docs/tests-only 不部署；
- 默认每天 ≤ 3 次生产部署。
