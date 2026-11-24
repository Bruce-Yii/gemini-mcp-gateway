# STATUS — 项目实况雷达（云端总控维护）

> **治理标记**：`[云端总控]` 维护（最后刷新：2026-11-25）。
> **定位**：与静态架构骨架 [ARCHITECTURE-INDEX.md](ARCHITECTURE-INDEX.md) 分离，本文件只记录**当下真实运行状态、四层状态落差（代码态 / 生产态 / 验收态）与最优先推进的 3 件事**。
> **证据底线**：代码已修 ≠ 生产已生效 ≠ 真实验收通过；无真实命令/字段/`requestId` 一律不写 PASS。**PR 合并/部署成功也不等于验收通过。**

---

## 1. 一屏实况快照

| 维度 | 当前真实状态 | 证据 / 说明 |
|---|---|---|
| `main` HEAD | **`cd23fdc`**（PR #28 已合入；未进入生产构建） | `git log -n 15 --oneline`；PR #28 = 5 个评测根因修复（未部署） |
| 生产部署（Vercel） | **`42caaf2`**（2026-11-25 03:14 手动部署；PR #29/#30/#31/#32） | healthz `commit=42caaf2…` / `buildHash=27e67f39…` / `deploymentId=dpl_DLBySiFi6P63sQnpoYEiSB2DDowM`；`main` 自动生产部署仍关闭 |
| 修复包 | **Pack 1 = PR #30**（R2 weekly 0 GET/429）；**Pack 2 = PR #31**（Notion `tokenEnv` 注入修复） | 均已合并并随 `42caaf2` 部署；周报冷却重跑与 Notion runtime 实测完成前不得写“已修复/已验收” |
| CI 回归 | **`1592 tests / 1586 pass / 0 fail / 6 todo`**（2026-11-25 lead 实跑；fix/eval-loop-trigger-and-observability） | 以 lead 当次实跑为准；不引用 PR / 子代理数字，不与旧构建硬比 |
| V0 真实验收门（A–G） | **NOT ACCEPTED**（A PASS；B/D/E/G FAIL；C/F PARTIAL） | 见 [ACCEPTANCE.md](ACCEPTANCE.md) |
| 上游授权实况 | Linear PAT 线上可用；Notion OAuth 已存储但 runtime `offline`；Vercel CIMD BLOCKED | 详见 §4；[AUTH-READY.md](AUTH-READY.md) = **NOT READY**（已按 2026-11-25 事实重写；8h/72h 未开始） |
| 开源发布（OSS） | **未公开** | 仅本地 staging/release 产物，禁止建远端/push/tag |

---

## 2. 已完成 PR 台账与 Open Issues

### 2.1 已合入 / 已部署 PR

| PR | 内容 | 合入 commit | 生产状态 | 证据 / 备注 |
|---|---|---|---|---|
| **#22** | Issue #15 前两项：`issue_write` 成功后 URL 兜底顶层 `number`；`fileResult` 对 ~40KB 完整文件 `truncated:true` 假阳性（tail-only 判定） | `3dd206f` | 已随 `3dd206f` 上线（2026-11-24 13:43；14:02 同 commit env 重部署） | 线上复验：40KB 不再误报、`path` 保留 |
| **#23** | M5-E 闭环执行层 G2–G8：`record-active-eval` / `capture-digest` / `compare-active-passive` / `check-badcases` / `check-status-drift` + codemode 指引 | `adf205d` | 随 `9eb0c7a` 上线（2026-11-25 00:00/00:07） | M4 Gate 3 请求对齐的工具基础 |
| **#24** | 双窗口主动评测 / BC-011–BC-018 真实对账 | `b27817e` | 随 `9eb0c7a` 上线 | window1 `match=exact`（3 个 requestId 验证）；语义发现仍待 PR #28 重跑 |
| **#25** | 子代理按 M1–M6 模块并行编排规则 | `84bb1cd` | 随 `9eb0c7a` 上线（文档变更） | AGENTS.md §11 |
| **#26** | 入站 OAuth 授权页 owner 审批口令保护 | `9eb0c7a` | 已随 `9eb0c7a` 上线（2026-11-25 00:00/00:07） | `OAUTH_APPROVE_PASSPHRASE` 已配（值不记录） |
| **#28** | 5 个评测根因：R2 `listR2Keys` 全量翻页、`isTruncated` 误判、analyzer `responsePreview`/prompt、`observed.findings` 覆盖核对、secret 脱敏 | `cd23fdc` | **已随 `42caaf2` 部署**；语义发现待冷却窗重跑 | 脚本 / 评测层改动；语义发现待冷却窗重跑 |
| **#29** | Linear 切 `static_bearer` + PAT（`/mcp/readonly`，env `LINEAR_API_KEY`）；Notion 恢复网关自有 OAuth（owner=gateway） | `f2002d9` | 已部署 `f2002d9`（2026-11-25 01:55） | Linear 线上 `list_teams` 成功；Notion runtime 仍 `offline`（Pack 2） |

### 2.2 Open Issues（本轮主台账）

| Issue | 主题 | 当前处置 |
|---|---|---|
| **#14** | [M4-C] 跨客户端防串伤回归 + 端到端高频闭环 | 保持 OPEN；待 PR #28 冷却窗内重跑 active→passive，`observed.findings` 命中 / `missed` 清零后再关闭。未重跑前不写闭环完成。 |
| **#15** | 网关工具返回与写入契约 4 处 | 保持 OPEN；#22 已清前两项（`issue_write` number、40KB 截断假阳性）；剩余 `normalizeMerge` 顶层 `number/url` 与 `writeFiles` 入参契约（BC-011/BC-012），需先补确定性测试。 |
| **#27** | Client Registry 长期替代生产 DCR | 保持 OPEN；M6 开源前收口；当前 ChatGPT/Notion 仍依赖 DCR，不能把 DCR 当长期方案。 |

> 另有长期 OPEN：#3（独立评测总入口）、#4/#5（P2 返回字段），不在本轮三项主台账内。

---

## 3. 客户端真实可用矩阵（Web 非代码模式为主）

| 客户端 | 接入 / 认证 | Profile 编码 | 真实窗口任务（B 门） | 当前核心阻塞 / 备注 |
|---|---|---|---|---|
| **Gemini Web** | 已接入生产；`clientPlatform=gemini` 分账已通 | text JSON（无 `structuredContent`） | ❌ 未完成 10 条固定任务 | 主客户端；scorecard 2026-11-24 录得 `gemini` 104 请求；M4 Gate 1 PASS。B 门仍需带 exact args / actual / `requestId` 的固定任务记录 |
| **ChatGPT Web** | DCR/OAuth 连通（client `gmc_4eeeeff9…`） | `structuredContent` + text JSON | 🔨 B 门未跑；M4 Gate 5 部分通过（ChatGPT 2/3；AT-XU-01 FAIL；Gemini 未复验） | R2 分页修复后实测捕获 10 条请求（重跑口径；scorecard 2026-11-24 `chatgpt=10`）；`server/discover` 400 已定位为协议版本协商（ChatGPT 发 2026-07-28，网关支持到 2025-11-25，随后回退 `initialize` 200），不是待查 bug；AT-GH-01 / AT-LN-01 / AT-XU-01 条件具备 |
| **Claude Web** | callback 代码已实现 | text + annotations | ❌ 未实测 | 未派发真实 connector 验收 |

---

## 4. 上游真实可用矩阵

| 上游 | 当前挂载快照 | 授权路线 | 真实只读 | 真实写入 / 写回环 | 当前核心阻塞 |
|---|---|---|---|---|---|
| **GitHub** | observed（42 tools） | 已有可用 token | ✅ 已验证 | ⚠️ PARTIAL | 验收仓库已跑通 read→patch→commit→PR，但 CI 因账户 billing 未启动；Issue #15 剩余 `normalizeMerge` / `writeFiles` 契约待修 |
| **Figma** | observed（47 tools） | OAuth | ⚠️ 部分 | — | 跨实例缓存未建 |
| **Vercel** | observed（73 tools） | OAuth-only（需 `offline_access`） | ⚠️ 未验收 | — | CIMD 路由代码已就绪，但稳定域名实测被 AS 拒绝（BLOCKED） |
| **Linear** | **observed（27 tools）** | `static_bearer` + PAT（`/mcp/readonly`，env `LINEAR_API_KEY`） | ✅ 线上实测 `linear__list_teams` 成功 | — | PAT 无刷新；8h/72h 生命周期与跨环境隔离未验（D 门） |
| **Notion** | **待在线实测（PR #31 已随 `42caaf2` 部署）** | 网关自有 OAuth/DCR（KV `owner=gateway`、`source=gateway-dcr`、`refresh=yes`） | ❌ 未验收 | — | 根因已由 PR #31 修复；本地直连 `tools/list` 200；部署后 `codemode.services()` 是否恢复待云端实测，未测前不写可用 | `offline`（0 tools、`needsReauth`）：根因是 `_resolveToken` 在无 `tokenEnv` 时提前 return，生产请求不带 Authorization；Pack 2 / PR #31 修复中 |

> `f2002d9` 历史实测在线工具合计 **189**（Figma 47 / GitHub 42 / Linear 27 / Vercel 73）；`42caaf2` 的 Notion 结果待本次在线实测。

---

## 5. P0 缺口四态与依赖阻塞链

| ID | 缺口 / 工作包 | 代码态 | 生产态（`42caaf2`） | 验收态 | 直接前置阻塞（卡在哪） |
|---|---|---|---|---|---|
| **Pack 2 / Notion offline** | `_resolveToken` 在无 `tokenEnv` 时提前 return，生产请求不带 Authorization | 🔨 PR #31 已修（OPEN） | ❌ `offline`（0 tools，`needsReauth`） | ❌ | PR #31 review → merge → deploy；部署后 `codemode.services()` 与 `search('notion')` 复验 |
| **Pack 1 / R2 weekly** | weekly 在 R2 REST 1200 req/5min 限流下出现 0 GET/429 | 🔨 PR #30（OPEN）：默认读 scorecard（0 R2 GET）+ 显式 R2 fallback/429 | ⚠️ 短窗可用；周报仍受 R2 限流 | ❌ M4 Gate 2 周报未过 | PR #30 merge + 周报重跑 |
| **PR #28 语义发现** | `responsePreview` / `observed.findings` 覆盖核对 | ✅ 已合入 `cd23fdc`（脚本/评测层） | ✅ 已随 `42caaf2` 部署 | ❌ 待冷却重跑 | 冷却窗重跑 active→passive；`findings`/`missed` 有实测后再关 #14 |
| **Issue #15 剩余** | `normalizeMerge` 顶层 `number/url`；`writeFiles` 入参 / 默认 dryRun 静默 | ❌ 未修 | ❌ 同生产 | ❌ | 先补确定性测试，再修；不得按反馈直接改 |
| **V0-B 真实客户端** | Gemini / ChatGPT 10 条固定任务 | ✅ 网关就绪 | ⚠️ `42caaf2` 可用但未跑验收任务 | ❌ FAIL | 缺带 `requestId` / exact args / actual 的真实窗口记录 |
| **V0-D 授权生命周期** | 独立 grant、重启、跨环境、8h/72h | 🔨 Linear PAT 已通；Notion 凭据已存 | ⚠️ Notion runtime `offline`；8h/72h 未验 | ❌ FAIL | PR #31 上线后观察；跨环境隔离未实测 |
| **V0-F 真实安全** | 真实 401、Docker build、`npm audit` | ✅ 代码 / 单测 | ⚠️ 未实测 | ⚠️ PARTIAL | 需真实 401 演练与本地 Docker / `npm audit` 实跑结论 |

---

## 6. M4 五道验收门

> 判定口径：只有**真实采集 / 生产构建上可复现的证据**才算 PASS；PR 合并、部署成功、单测绿灯都不单独构成验收。M4 五门与 V0 A–G 不互相替代。

| # | 验收门 | 状态 | 证据 / 未完成条件 |
|---|---|---|---|
| 1 | 线上采集 + 平台分账 | **PASS（按本轮指定口径）** | scorecard 2026-11-24：335 请求，`gemini` 104 / `chatgpt` 10 / `unknown` 221（旧 envelope）；四维分账与 `--platform` / `--eval-mode` 过滤已用真实采集验证；`unknown` 按显式字段规则分账，不按 UA 猜 |
| 2 | R2 + 免费模型稳定跑通 | **短窗 PASS；周报未过** | 单次 60m 短窗本轮实跑通过；周报受 R2 REST 1200 req/5min 限流，出现 0 GET/429，Pack 1 / PR #30（默认读 scorecard，0 R2 GET + 显式 fallback）OPEN |
| 3 | 主被动精确对齐 + 反哺 | **请求对齐 PASS；语义发现未验** | PR #24 + [active-passive-2026-11-24-window1.json](eval/active-passive-2026-11-24-window1.json) `match=exact`（3 个 requestId 在窗内验证）；window2 `unmatched` 如实记录。`responsePreview` + `observed.findings` 在 PR #28（`cd23fdc`）已合入，但未进生产构建、冷却窗同窗重跑未做 → `findings`/`missed` 未验，#14 保持 OPEN |
| 4 | 缺陷闭环修复 | **PASS** | PR #22 已随 `3dd206f` 部署并线上复验（`fileResult` 40KB 不误报、`issue_write` number URL 兜底）；`42caaf2` 为其后续构建（包含该修复）。Issue #15 前两项闭环，剩余契约项另列 |
| 5 | ChatGPT 跨客户端防回退 | **未执行** | 条件具备：ChatGPT DCR/OAuth 连通、R2 分页修复后重跑捕获 10 条请求；待跑 AT-GH-01 / AT-LN-01 / AT-XU-01。未跑前只能写“跨客户端未验证”，不得写“公共层已修复/已通过” |

---

## 7. 下一站（M1×M2）与 Top 3 优先打点

### 7.1 进入 M1×M2 联合收口的前提

1. **Pack 2 / Notion runtime**：PR #31 合并并部署后，线上 `codemode.services()` 不再把 Notion 标为 `offline`，`search('notion')` 有工具；
2. **Pack 1 / weekly**：PR #30 合并后，周报走 0 R2 GET 路径稳定，M4 Gate 2 周报项有结论；
3. **PR #28 语义发现**：冷却窗重跑 active→passive，`responsePreview` / `observed.findings` 的 `findings`/`missed` 有实测结论（命中或明确 `NOT_ENOUGH`），#14 才可关闭；
4. **M4 Gate 5**：ChatGPT 已跑 AT-GH-01 / AT-LN-01 / AT-XU-01（2/3 通过，AT-XU-01 FAIL，见 BADCASES M4-C）；Gemini 端未复验，跨客户端仍写“未验证”。

### 7.2 下一站工作项

- **M1 Client × M2 Execution 联合收口**：真实客户端固定任务（B 门）与执行器路由 / Profile 编码同批验证；对外仍只有 `search` / `execute_read` / `execute` 三工具。
- **Issue #15 剩余项**：`normalizeMerge` 顶层 `number/url`、`writeFiles` 入参契约（`patches` vs `files`、默认 dryRun 静默）；先确定性测试后修复。

### 7.3 Top 3 优先打点（按依赖收益排序，不排日历）

1. **先修通 Notion 线上 runtime（Pack 2 / PR #31）**：当前唯一整上游 0 tools 的功能缺口，直接阻塞 M1/M4 验收；上线后以 `codemode.services()` 实测为准。
2. **收口 M4 Gate 2/3（Pack 1 + PR #28 冷却重跑）**：周报 0 R2 GET/429、语义发现 `findings`/`missed` 都要有实测；`#14` 未重跑前不关闭。
3. **Issue #15 剩余契约 → M1×M2 入口**：先补 `normalizeMerge` / `writeFiles` 确定性测试，再进入下一站；未完成前不宣称公共层已修复。

---

## 刷新纪律

- 每次代码 PR 合并、手动生产部署、M4 / V0 门状态变化后，由 `[云端总控]` 同步刷新本文件；
- PR #30 / #31 合并后必须刷新本文件，不能把“PR 合并”写成“线上已修复”；
- 架构骨架不变时，不修改 [ARCHITECTURE-INDEX.md](ARCHITECTURE-INDEX.md)。
