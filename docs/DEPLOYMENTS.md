# Deployment log

> 部署机制（2026-11-24 起）：GitHub push **不再**自动发布 production。
> `vercel.json` 已加 `git.deploymentEnabled.main = false`（commit `05f607c`）。
> 生产部署只能手动触发（`vercel --prod` / dashboard promote），且必须过
> [DEPLOY-POLICY.md](DEPLOY-POLICY.md) 并在此登记。

| 时间 (Asia/Singapore) | Commit | 方式 | 目的 | 结果 | 证据 |
|---|---|---|---|---|---|
| 2026-11-24 00:50 | `87d91af` | CLI（手动） | 验收门 A：部署最新代码并核对 healthz | READY | `commit=87d91af0caf84f1bc2f5ed1fff3ba20bbe234472`，`buildHash=02c96881...`；`/mcp` 401；未做真实客户端/授权验收 |
| 2026-11-24 01:51 | `9ab0e57` | git push 自动（最后一次） | 修复自动部署说明的 docs 提交，被自动上线 | READY | `deploymentId=dpl_8vioi2zsZdF41zGqJTbh61Bg3bts`；healthz `commit=9ab0e57d7c3b1a7ebda548d1319887c1b70a64da` / `buildHash=02c96881...` / `builtAt=2026-11-23T17:51:36.429Z` |
| 2026-11-24 01:59 | `05f607c` | git push | 关掉 main 的自动 production 部署（`vercel.json`） | **未部署** | Vercel deployments API：该 commit 无任何 deployment 记录（含 preview） |
| 2026-11-24 02:02 | `c5a0a06` | git push | 记录部署控制与验收仓库 | **未部署** | 同上 |
| 2026-11-24 02:05 | `36e4c76` | git push | 更新 handoff | **未部署** | 同上 |
| 2026-11-24 02:08 | `34c406d` | git push | handoff 状态更新 | **未部署** | 同上 |
| 2026-11-24 02:16 | `9ab0e57`（复核） | 只读复核 | 确认自动部署已停、生产未漂移 | **PASS** | ① healthz：`commit=9ab0e57…`、`buildHash=02c96881…`、`env=production`、`mode=codemode`；② Vercel `GET /v6/deployments?projectId=…&limit=15`：最新 production 部署仍是 `9ab0e57`（01:51:21），其后 `05f607c/c5a0a06/36e4c76/34c406d` 全部 `deployed=false`；③ 无 preview 部署产生 |

## 规则

- 每次部署前过 [DEPLOY-POLICY.md](DEPLOY-POLICY.md) 检查；
- 记录 commit、方式、目的、healthz 证据、对应 acceptance gate；
- 生产部署必须手动发起，并登记 deploymentId；
- docs/tests-only 不部署；
- 自动部署关闭后，push 到 main 不再改变生产；若发现 healthz commit 变化而本表无记录，按事故处理。

## 未登记的部署历史（2026-11-24 01:12 复核）

2026-11-23 07:31 — 2026-11-24 01:12 期间共 **40 次**自动 production 部署（Vercel API 实查），
本表此前只登记了 `87d91af` 一次。历史不可追溯部分按 `INDEPENDENT-REVIEW-2026-11-24.md`
记为 A 门 PARTIAL 的原因之一；不补造记录。
