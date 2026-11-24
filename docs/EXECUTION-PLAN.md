# Master execution plan (2026-11-25)

> 任务路由页。没有日历排期；完成即集成。
> 总评测架构见 [EVALUATION.md](EVALUATION.md)；当前基线与恢复点见
> [HANDOFF-2026-11-23.md](HANDOFF-2026-11-23.md)。

## 0. 当前快照

- 生产 Vercel：**`f2002d9`**（2026-11-25 01:55 手动部署；healthz `commit=f2002d9…` / `buildHash=3b1a0772…` / `deploymentId=dpl_6P2Ww8vsTHXbbSF98GTE55HKitB4`）；`main` HEAD `cd23fdc`（PR #28 已合入、未进入生产构建）
- 最近全量：`1592 tests / 1586 pass / 0 fail / 6 todo`（2026-11-25 lead 实跑（fix/eval-loop-trigger-and-observability），引用时以 lead 当次实跑为准）
- 工作分支：`docs/sync-status-and-milestones`（只同步 `docs/STATUS.md`、`docs/EXECUTION-PLAN.md`、`docs/ACCEPTANCE.md`；不碰业务代码）
- 已完成 PR 里程碑：`#22` Issue #15 前两项 → `#23` M5-E 闭环工具层 → `#24` 双窗口主动评测 → `#25` 子代理 M1–M6 编排规则 → `#26` 入站审批口令 → `#28` 5 个评测根因（未部署）→ `#29` Linear PAT + Notion gateway OAuth（生产 `f2002d9`）
- Auth：Linear `static_bearer` + PAT 线上可用；Notion OAuth 凭据已存储但 runtime `offline`（Pack 2 / PR #31 OPEN）；Vercel CIMD BLOCKED；`AUTH-READY.md` = **NOT READY**（已按 2026-11-25 事实重写）
- OSS：**未公开**；只有本地产物 `work/oss-release-staging` / `work/oss-release-repo`

## 1. 正在跑

| 工作项 | 板块 | 目标 |
|---|---|---|
| **Pack 2 / PR #31** | M3 Auth | Notion `_resolveToken` 在无 `tokenEnv` 时也要注入网关自有 OAuth Authorization；合并后部署并复验 `codemode.services()` |
| **Pack 1 / PR #30** | M4 Eval | weekly 默认读 scorecard（0 R2 GET）+ 显式 R2 fallback/429；合并后跑周报，收 M4 Gate 2 |
| **PR #28 冷却重跑** | M4 Eval | 用 `responsePreview` / `observed.findings` 重跑 active→passive，确认 `findings` / `missed`，再决定 #14 |
| **docs 状态同步** | 治理 | 本分支只改 STATUS / EXECUTION-PLAN / ACCEPTANCE，消除生产 / HEAD / PR / 验收漂移 |

## 2. 板块状态

| 板块 | 状态 | 文档 |
|---|---|---|
| **Auth / 上游授权** | 🔨 Linear PAT 线上可用；Notion OAuth 已存储但 runtime `offline`（Pack 2 PR #31 OPEN）；Vercel CIMD BLOCKED；D 门 8h/72h 未验 | `AUTH-READY.md`（NOT READY）、`eval/AUTH-PROVIDERS.md` |
| **Platform 隔离** | 🔨 代码层：Gemini / ChatGPT / Claude profile、ChatGPT DCR/OAuth、Claude callback；ChatGPT 已捕获 10 条请求；真实客户端 B 门未验 | `CLIENT-PROFILES.md`、`eval/PLATFORM-CONFORMANCE-MATRIX.md` |
| **Typed plan** | ✅ `/mcp/v2` flag、执行器、security 修复；未默认启用；无真实模型 A/B | `TYPED-PLAN-TEST-PLAN.md` |
| **Online / semi-online eval** | ✅ M4 Gate 1 / Gate 4 PASS；🔨 Gate 2 短窗 PASS、周报待 Pack 1；🔨 Gate 3 请求对齐 `exact`、语义发现待 PR #28 重跑；🔨 Gate 5 部分通过（ChatGPT 2/3；AT-XU-01 FAIL） | `EVALUATION.md`、`eval/EVAL-CLOSURE.md`、`eval/scorecard-2026-11-24.md` |
| **OSS 发布** | 🔨 staging/local repo 已重建；未公开；M6 前需 Issue #27 Client Registry 替代 DCR | `OPEN-SOURCE/RELEASE-LOCAL.md`、`PUBLIC-SAFETY-AUDIT.md` |
| **Infra / 部署** | ⚠️ 生产 `f2002d9`；`main` `cd23fdc` 未部署；手动部署；Pack 1 / Pack 2 未上线 | `DEPLOYMENTS.md`、`DEPLOY-POLICY.md` |

## 3. 未派 / 待决策

### Auth

| 任务 | 状态 | 依赖 |
|---|---|---|
| Linear PAT 接入 | ✅ 已完成并线上验证（`f2002d9`，`linear__list_teams` 成功） | 8h/72h 观察 |
| Notion runtime 上线 | 🔨 Pack 2 / PR #31 OPEN | review → merge → deploy → `codemode.services()` 复验 |
| 真实 provider 8h/72h 观察 | ❌ 未验 | Notion runtime 上线 + Linear PAT 持续观察 |
| Vercel 稳定域名 CIMD | ❌ BLOCKED（AS 拒绝） | 预注册 / Client Registry 替代 |
| Client Registry（#27） | ❌ 未开始 | M6 开源前收口 |
| 跨环境 KV 隔离实测 | ❌ 未验 | 部署后 preview 缺授权测试 |

### Platform / 客户端

| 任务 | 状态 |
|---|---|
| ChatGPT 跨客户端防回退（M4 Gate 5） | 🔨 部分通过（ChatGPT 2/3）；AT-XU-01 FAIL；Gemini 未复验 |
| B 门 Gemini / ChatGPT 10 条固定任务 | ❌ 未跑 |
| Claude 真实 connector 验收 | ❌ 未派 |
| 多平台 eval lane 接入 `run-l1-smoke` | ❌ 未派 |
| ChatGPT CIMD（入站） | ❌ P1 未派 |

### Typed plan

| 任务 | 状态 |
|---|---|
| `/mcp/v2` 默认启用 | ❌ 需 A/B 数据，不切 |
| 真实模型 A/B（F vs S） | ❌ 等真实 lane |
| baseline freeze | ❌ 无冻结 baseline；M4 Gate 3 语义重跑后再谈 |

### Infra / 后续

| 任务 | 状态 |
|---|---|
| 部署 Pack 2 / Pack 1 | 🔨 等 PR 合并；合并后按实质代码批次部署 |
| 部署 `main` `cd23fdc` | ❌ docs/eval-only，不单独部署；等实质代码批次 |
| canary / shadow | ❌ 等部署 |
| 持久状态 / checkpoint | ❌ 未派 |
| Figma 跨实例缓存 | ❌ 未派 |
| capture collector 生产接线 | 🔨 队列 / flag 已有；默认关 |
| MCP 2026 | ❌ 故意暂缓 |

## 4. 下一步顺序

1. **Pack 2 / PR #31**：review → merge → 手动部署 → `codemode.services()` 不再把 Notion 标为 `offline`，`search('notion')` 有工具，登记 `DEPLOYMENTS.md`；
2. **Pack 1 / PR #30**：merge → 周报 0 R2 GET/429 实测 → M4 Gate 2 周报项有结论；不把“合并”当通过；
3. **PR #28 冷却重跑**：同窗 active→passive，`responsePreview` / `observed.findings` 产出 `findings`/`missed`；`missed=0` 才关 #14，否则记 `NOT_ENOUGH`；
4. **Issue #15 剩余项**：`normalizeMerge` / `writeFiles` 先补确定性测试，再修；不按反馈直接改；
5. **M1×M2 入口**：上述 1–4 收口后，进入 **M1 Client × M2 Execution 联合收口**（B 门真实任务 + 执行器路由 / Profile 编码）；
6. **部署纪律**：只部署有实质代码的批次；部署后更新 `DEPLOYMENTS.md` 并跑 `node scripts/check-status-drift.mjs --expected <deployed-commit>`，同时刷新 `AGENTS.md`（另一写域，由 lead 统一处理）与 STATUS / ACCEPTANCE；
7. **OSS**：M6 前完成 #27 Client Registry 替代 DCR；未公开前不 push / 不建远端 / 不打 tag。

### 4.1 M4 Gate 2/3/5 收口条件与 M1×M2 入口前提

- **Gate 2（R2 + 免费模型稳定跑通）**：Pack 1 / PR #30 合并后，weekly 走已提交 scorecard（0 R2 GET）不触发 429；缺 scorecard 的日期显式 `NOT_ENOUGH`；短窗仍 PASS。只有“周报也稳定”才把 Gate 2 写成全过。
- **Gate 3（主被动精确对齐 + 反哺）**：PR #28 已合入 `cd23fdc`；需在冷却窗用同一条 active 记录重跑 active→passive，产出 `responsePreview` / `observed.findings` 的 `findings`/`missed`；`missed=0` 或每条 `missed` 都有明确补采集/补测试/`NOT_ENOUGH` 结论，才关 #14；不得用 `match=exact` 单独代替语义发现。
- **Gate 5（ChatGPT 跨客户端防回退）**：真实 ChatGPT 窗口跑 AT-GH-01 / AT-LN-01 / AT-XU-01；公共层行为需 Gemini 与 ChatGPT 两端正向，证据写进 `BADCASES.md`；任一端未验证只能写“跨客户端未验证”，一端退化则按 `client-profile` 隔离，不硬凑折中。
- **M1×M2 入口前提**：上述 Gate 2/3/5 收口或明确记录 `NOT_ENOUGH`，且 Pack 2 部署后 Notion runtime online、Pack 1 合并；未满足前，M1×M2 只做只读准备，不宣称客户端/执行底座已验收。

## 5. 部署纪律

- 见 [DEPLOY-POLICY.md](DEPLOY-POLICY.md)：不设固定次数；无进展不部署，有明确进展/必须实测就部署；docs/tests-only 不部署。
- 当前生产 `f2002d9`（A 门当前构建可追溯）；`main` `cd23fdc` 未部署，不要把 HEAD 当生产。
- Pack 1 / Pack 2 合并后按实质代码批次部署；部署前过 DEPLOY-POLICY，部署后登记 `DEPLOYMENTS.md` 并跑 `check-status-drift`。

## 6. 硬规则

- 不把“代码已修”当“线上已生效”；不把“PR 合并”当“验收通过”；
- Pack 未合并 / 未部署前，不写“已修复 / 已通过”；
- Notion 0 tools 是异常，不写“正常只读 / 已验收”；
- 不跨构建硬比；不编造 `requestId`；
- 不为过测试保留无标记截断；
- DSH 与网关不共享 rotating refresh token；
- OSS 不 push / 不建远端，直到用户明确；
- 授权只在 `AUTH-READY.md` 全绿后发起。
