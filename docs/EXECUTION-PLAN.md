# Master execution plan (2026-11-23)

> 任务路由页。没有日历排期；完成即集成。
> 总评测架构见 [EVALUATION.md](EVALUATION.md)；当前基线与恢复点见
> [HANDOFF-2026-11-23.md](HANDOFF-2026-11-23.md)。

## 0. 当前快照

- 全量：`1329 tests / 1323 pass / 0 fail / 6 todo`（提交 `01d58f0` 后；lead 实跑）
- worktree：干净
- 生产 Vercel：**旧构建**；`100 deployments/day` 用尽，最新代码未部署
- Auth：`docs/AUTH-READY.md` = **NOT READY**，不发起授权
- OSS：**未公开**；只有本地产物 `work/oss-release-staging` / `work/oss-release-repo`

## 1. 正在跑

| Agent | 板块 | 目标 |
|---|---|---|
| `oss-reverify` | OSS | 最新代码重导出 staging/release repo，过发布门禁 |
| `security-fix-2` | Security | F-01/F-03/F-04/F-06/F-07：错误脱敏、截断审计、预算、原型污染、truncated 语义 |
| `local-latest-verify` | Infra | 本地真实路由 loopback E2E（healthz/OAuth/CIMD/三工具/content/PR/wait） |

## 2. 板块状态

| 板块 | 状态 | 文档 |
|---|---|---|
| **Auth / 上游授权** | 🔨 gateway-owned grant / owner 隔离 / DCR / CIMD 已实现；真实授权未做；Vercel CIMD BLOCKED | `AUTH-READY.md`、`eval/AUTH-PROVIDERS.md`、`ledger/batch-15-auth*.md` |
| **Platform 隔离** | ✅ Gemini/ChatGPT/Claude profile、ChatGPT OAuth、Claude callback；真实客户端未验 | `CLIENT-PROFILES.md`、`eval/PLATFORM-CONFORMANCE-MATRIX.md` |
| **Typed plan** | ✅ `/mcp/v2` flag、执行器、A/B runner、security 修复；未默认启用 | `TYPED-PLAN-TEST-PLAN.md`、`ledger/batch-14-typed-plan*.md` |
| **Online / semi-online eval** | ✅ F1–F6 join、N1–N9、J1–J6、L1 online-gap profile、replay harness；部署后复验未做 | `EVALUATION.md`、`eval/ONLINE-*`、`eval/SEMI-ONLINE-GAPS.md` |
| **OSS 发布** | 🔨 staging/local repo 已重建；公开前审计/身份/CI 门禁收口中 | `OPEN-SOURCE/RELEASE-LOCAL.md`、`PUBLIC-SAFETY-AUDIT.md` |
| **Infra / 部署** | ⚠️ 最新代码未部署（Vercel 100/day） | `HANDOFF-2026-11-23.md` |

## 3. 未派 / 待决策

### Auth

| 任务 | 状态 | 依赖 |
|---|---|---|
| Linear PAT 创建 + `static_bearer` 配到网关 | ❌ 等用户一次性授权 | `AUTH-READY` 全绿 |
| Notion static MCP token 或网关 DCR 真实授权 | ❌ 等用户一次性授权 | 同上 |
| Vercel 稳定域名 CIMD 验证 | ❌ 等部署 | Vercel 额度 |
| Vercel 预注册 client 路线 | ❌ 待决策 | CIMD 稳定域名复验失败后 |
| 真实 provider 72h 观察 | ❌ 等授权 | 以上 |

### Platform / 客户端

| 任务 | 状态 |
|---|---|
| ChatGPT 正式 connector 回归（GitHub 只读 + 写） | ⚠️ 手工连上；正式测试未派 |
| Claude 真实 connector 验收 | ❌ 未派 |
| 多平台 eval lane 接入 `run-l1-smoke` | ❌ 未派 |
| ChatGPT CIMD（入站） | ❌ P1 未派 |

### Typed plan

| 任务 | 状态 |
|---|---|
| `/mcp/v2` 默认启用 | ❌ 需 A/B 数据，不切 |
| 真实模型 A/B（F vs S） | ❌ 等部署/真实 lane |
| N1–N9/J1–J6 接 baseline freeze | 🔨 部分（profile 已接，基线未冻结） |

### Infra / 后续

| 任务 | 状态 |
|---|---|
| 部署最新代码 | ❌ Vercel 额度 |
| canary/shadow | ❌ 等部署 |
| 持久状态/checkpoint | ❌ 未派 |
| Figma 跨实例缓存 | ❌ 未派 |
| capture collector 生产接线 | 🔨 队列/flag 已有；默认关 |
| MCP 2026 | ❌ 故意暂缓 |

## 4. 下一步顺序

1. `oss-reverify` / `security-fix-2` / `local-latest-verify` 收口；
2. 全量 0 fail + CI 绿；
3. OSS staging/release repo 门禁；不 push；
4. Vercel 部署窗口恢复 → 部署最新代码；
5. 生产域名 CIMD 复验；
6. 跑 `AUTH-READY` real 检查；
7. 全绿后发起**一次** Linear/Notion/Vercel 授权；
8. 部署后同任务在线复验 F1–F6 / J1–J6；
9. 真实客户端 lane / canary。

## 5. 硬规则

- 不把“代码已修”当“线上已生效”；
- 不跨构建硬比；
- 不编造 requestId；
- 不为过测试保留无标记截断；
- DSH 与网关不共享 rotating refresh token；
- OSS 不 push/不建远端，直到用户明确；
- 授权只在 `AUTH-READY.md` 全绿后发起。
