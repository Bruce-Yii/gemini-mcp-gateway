# Master execution plan (2026-11-23)

> 这是一个多板块并行项目。本页只做**任务路由**：谁在跑、什么没派、什么被阻塞。
> 没有日历排期；完成即集成。详细台账：
> [B11](ledger/batch-11-recent.md)、[B12](ledger/batch-12-active.md)、
> [B13](ledger/batch-13-active.md)、[B14](ledger/batch-14-typed-plan.md)、
> [B15](ledger/batch-15-auth.md)、[OSS](OPEN-SOURCE/PLAN.md)。

## 0. 当前运行中

| Agent | 板块 | 目标 |
|---|---|---|
| `auth-arch-fix` | Auth | 修 R1–R6：空 owner=shared、本地默认 local、OAuth callback 带 env/owner、legacy key、state 隔离、同实例 refreshPromise |
| `claude-connector` | Platform | Claude callback allowlist + docs/tests |
| `online-gap-tasks` | Eval | N1–N9 在线缺口任务集 |
| `oss-release-dryrun` | OSS | 实际导出 staging + 发布门禁 |

## 1. 六个大板块状态

| 板块 | 状态 | 文档 |
|---|---|---|
| **Auth / 上游授权** | 🔨 架构修复中；provider 事实已明 | `docs/eval/AUTH-PROVIDERS.md`、`docs/ledger/batch-15-auth*.md` |
| **Platform 隔离** | ✅ capture/eval/registry/ChatGPT OAuth 已入；Claude 未 | `batch-13-active.md`、`CLIENT-PROFILES.md` |
| **Typed plan** | ✅ 方案/spike/conformance/复用调研；未接生产 | `TYPED-PLAN-TEST-PLAN.md`、`batch-14-typed-plan.md` |
| **Online / semi-online eval** | 🔨 反馈已建档；半在线补测部分完成 | `ONLINE-FEEDBACK.md`、`SEMI-ONLINE-GAPS.md` |
| **OSS 发布** | ✅ 研究/导出/模板/README/Docker；未真正开新仓库 | `OPEN-SOURCE/PLAN.md`、`EXPORT-MANIFEST.md` |
| **Infra / 部署** | ⚠️ 最新代码未部署（Vercel 100/day 限额） | `HANDOFF-2026-11-23.md` |

## 2. 还没派出去的任务（按板块）

### Auth（最高优先，授权零容忍）

| 任务 | 状态 | 依赖 |
|---|---|---|
| gateway-owned OAuth provisioning（Notion DCR / Linear OAuth / Vercel CIMD+offline_access） | ❌ 未派 | `auth-arch-fix` 完成 |
| static bearer 迁移：Linear PAT、Notion static MCP token | ❌ 未派 | `auth-arch-fix` 支持 `authMode=static_bearer` |
| 真实 provider 一次性授权 + 72h 观察 | ❌ 未派 | 用户/令牌 + 代码完成后 |
| Vercel `offline_access` + CIMD 生产配置 | ❌ 未派 | gateway-owned OAuth |
| 旧 DSH grant 清理/只读化 | ❌ 未派 | 迁移文档 |

### Platform / 客户端

| 任务 | 状态 |
|---|---|
| Claude.ai callback allowlist + 真实 connector 验收 | ❌ 未派 |
| ChatGPT CIMD（当前只有 DCR/自定义 client） | ❌ 未派（P1） |
| ChatGPT 真实 connector 回归（GitHub 只读 + 写） | ⚠️ 已手工连上；正式测试未派 |
| 多平台 eval lane 接入 `run-l1-smoke` | ❌ 未派（文档已给接入点） |

### Typed plan

| 任务 | 状态 |
|---|---|
| `/v2` 或版本化 schema 承载 `plan` 字段 | ❌ 未派（必须先于生产接入） |
| `codemode.runTypedPlan` 接入生产 execute | ❌ 未派 |
| L1 A/B runner（Profile F vs S） | ❌ 未派（测试计划已完成） |
| 生产 fallback/异常测试 | ❌ 未派 |

### Eval / 在线反馈

| 任务 | 状态 |
|---|---|
| 把 N1–N9 补进 L1/G6 任务集 | ❌ 未派（SEMI-ONLINE-GAPS §4） |
| F1–F6 在线反馈逐条 capture 复现 | 🔨 部分（gh-file-p0 已修 F1/F2；F3/F4/F5 待部署/重放） |
| 真实 PR #53 的 number/merge 回放 | ❌ 未派 |
| 真实 GitHub Actions 失败日志验证 | ❌ 未派 |
| L1 real 用冻结基线 + 干净 token 重跑 | ❌ 未派 |

### OSS / 发布

| 任务 | 状态 |
|---|---|
| `scripts/export-oss.mjs` 真正导出新仓库 + `git init` | ❌ 未派（脚本已就绪） |
| 新仓库名/owner 决定 | ❌ 待决策 |
| 公开 README 最终脱内部链接 | ✅ 已做；待导出验证 |
| Free platform 矩阵 / runtime adapter | ❌ 未派（文档建议先 Vercel/Docker/Tunnel） |
| Cloudflare Containers 模板 | ❌ 未派（需 Workers Paid $5） |

### Infra / 执行

| 任务 | 状态 |
|---|---|
| 部署最新代码（P0 + auth） | ❌ 被 Vercel 100/day 阻塞 |
| capture 同步延迟优化（collector/queue） | ❌ 未派 |
| 持久状态/checkpoint 实现 | ❌ 未派（设计已写） |
| Figma 跨实例缓存实现 | ❌ 未派（设计已写） |
| MCP 2026 实现 | ❌ 故意暂缓 |

## 3. 阻塞 / 决策

| 项 | 原因 |
|---|---|
| 部署最新代码 | Vercel free 100 deployments/day 用尽；等额度或换 Cloudflare Containers |
| 真实 Notion/Linear/Vercel 授权 | 需要 gateway-owned grant；不能再用 DSH token |
| ChatGPT 完整 MCP | 计划限制；Free/Plus 不承诺；Business/Enterprise 才完整 |
| Cloudflare Workers | 免费 CPU/Containers 限制；Containers 需 $5/月 |
| typed plan 生产 | 必须版本化 schema；先 A/B |

## 4. 建议的下一批并行（按依赖）

1. `auth-arch-fix` + `auth-sim-harness` 收口；
2. `auth-provisioning`：gateway-owned OAuth + static bearer 支持；
3. `deploy-and-verify`：Vercel 额度恢复后部署，跑 P0/auth 验证；
4. `eval-replay`：真实 PR #53 + Actions 日志 + 在线反馈 F1–F6 回放；
5. `typed-plan-v2`：schema 版本 + A/B runner（不默认切）；
6. `oss-export-repo`：新仓库导出 + 发布门禁；
7. `infra-followups`：持久状态、Figma 跨实例、capture 延迟。

## 5. 不要再忘的硬规则

- 授权：**DSH 与网关不能共享 rotating refresh token**；网关只刷新 gateway-owned grant。
- 在线反馈：每条都要落 `online-feedback.v1`，并回灌半在线测试。
- typed plan：没 A/B 数据不切默认；先 `/v2`。
- OSS：**新仓库**，私有仓库不公开；发布前过 `EXPORT-MANIFEST`。
- 部署：最新 commit 未部署前，不宣称线上生效。

## 6. Eval workstream（新增）

- 总览：docs/EVALUATION.md
- schema/流程：docs/eval/ONLINE-FEEDBACK.md
- 缺口：docs/eval/SEMI-ONLINE-GAPS.md
- join：docs/eval/ONLINE-SEMIONLINE-JOIN-2026-11-23.md
- N1–N9 + J1–J6：explore/tasks-online-gap.json / tasks-online-gap-2.json
- 未完成：L1 online-gap profile（l1-task-wire）、在线 replay（online-replay-harness）、部署后同任务复验、真实客户端 lane、canary/shadow、自动 intake

