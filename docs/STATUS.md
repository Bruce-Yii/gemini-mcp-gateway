# STATUS — 项目实况雷达（云端总控维护）

> **治理标记**：`[云端总控]` 维护（最后刷新：2026-11-24）。
> **定位**：与静态架构骨架 [ARCHITECTURE-INDEX.md](ARCHITECTURE-INDEX.md) 分离，本文件只记录**当下真实运行状态、四层状态落差（代码态 / 生产态 / 验收态）与最优先推进的 3 件事**。
> **证据底线**：代码已修 ≠ 生产已生效 ≠ 真实验收通过；无真实命令/字段/`requestId` 一律不写 PASS。

---

## 1. 一屏实况快照

| 维度 | 当前真实状态 | 证据 / 说明 |
|---|---|---|
| `main` HEAD | **评测闭环接线 PR #10（`2b04829`）**之后 | 已接通 `oauthClientId` 平台归因、`servers[]`、`evalMode` 与 `--last-minutes` 分析器（代码态已就绪，待随下一批功能部署到生产） |
| 生产部署（Vercel） | **`1481408`**（2026-11-24 手动部署） | `main` 自动生产部署已关闭；含 P0 修复 `4de5341` |
| CI 回归（PR #8 实跑） | Node 20.x / 24.x 全绿（`1518 tests`） | Node 22.x 有 1 例无关的 1ms 时钟抖动（`tests/capture-sink-fix.test.js:222`） |
| V0 真实验收门（A–G） | **NOT ACCEPTED**（仅 A 当前构建可追溯） | B/D/E/G FAIL，C/F PARTIAL（见 [ACCEPTANCE.md](ACCEPTANCE.md)） |
| 上游授权门禁 | **NOT READY** | 见 [AUTH-READY.md](AUTH-READY.md)，全绿前不向用户发起授权 |
| 开源发布（OSS） | **未公开** | 仅本地 staging/release 产物，禁止建远端/push/tag |

---

## 2. 客户端真实可用矩阵（Web 非代码模式为主）

| 客户端 | 接入 / 认证 | Profile 编码 | 真实窗口任务（B 门） | 当前核心阻塞 / 备注 |
|---|---|---|---|---|
| **Gemini Web** | 已接入生产 | text JSON（无 `structuredContent`） | ❌ 未完成 10 条固定任务 | 即使设“允许”仍频繁弹窗（`openWorldHint`/`destructiveHint`）；需实验 profile B+D |
| **ChatGPT Web** | 手工连通 | `structuredContent` + text JSON | ❌ 正式回归未跑 | 独立评测总入口已建（Issue #3），待按工作流执行 |
| **Claude Web** | callback 代码已实现 | text + annotations | ❌ 未实测 | 未派发真实 connector 验收 |

---

## 3. 上游真实可用矩阵

| 上游 | 当前挂载快照 | 授权路线 | 真实只读 | 真实写入 / 写回环 | 当前核心阻塞 |
|---|---|---|---|---|---|
| **GitHub** | observed（42 tools） | 已有可用 token | ✅ 已验证 | ⚠️ PARTIAL | 验收仓库已跑通 read→patch→commit→PR，但 CI 因账户 billing 未启动；另有 #4（`fileResult.path`）、#5（`commitSha`）与建 Issue 幂等（`OF-1`）待核验/补齐 |
| **Figma** | observed（47 tools） | OAuth | ⚠️ 部分 | — | 跨实例缓存未建 |
| **Vercel** | observed（73 tools） | OAuth-only（需 `offline_access`） | ⚠️ 未验收 | — | CIMD 路由代码已就绪，但稳定域名实测被 AS 拒绝（BLOCKED） |
| **Linear** | **offline**（0 tools） | 优先 `static_bearer`（PAT） | ❌ 未验收 | — | 等 `AUTH-READY` 全绿后由 owner 放 PAT 到 vault 并 `--verify --apply` |
| **Notion** | **offline**（0 tools） | DCR 代码已实现 / 或 static MCP token | ❌ 未验收 | — | 真实 DCR 授权与 KV 写入未执行；等 `AUTH-READY` 全绿 |

---

## 4. P0 缺口四态与依赖阻塞链

| ID | 缺口 / 工作包 | 代码态 | 生产态（`1481408`） | 验收态 | 直接前置阻塞（卡在哪） |
|---|---|---|---|---|---|
| **评测闭环接线** | `clientPlatform` 断线、跨上游 `servers[]` 缺失、缺半小时快拉分析 | ✅ 已修（PR #10 `2b04829`） | ⚠️ 待随下批部署（`1481408` 未含） | ❌ | 注：原 scorecard `20` 为 Gemini 单轮调用上限（非 R2 分页 bug）；代码已通，待部署后在真实窗口核验 |
| **E2 / E3** | capture 补 `taskId`/`clientMode` + `link-active-passive` | ❌ 未实现 | ❌ | ❌ | 依赖 `E1`（`active-eval.v1`）与 `OF-3` 分母准确 → **直接卡住“主动反哺被动”闭环** |
| **OF-1 / #4 / #5** | 建 Issue 幂等回查、`fileResult.path`、`commitSha` 复验 | ⚠️ 部分已修（`4de5341`） | ⚠️ 待复验 | ❌ | 需用当前生产 `1481408` 做同任务复验并补 Issue 幂等/回查 |
| **V0-B** | Gemini / ChatGPT 真实窗口 10 条固定任务 | ✅ 网关就绪 | ✅ `1481408` | ❌ FAIL | 缺带 `requestId` / exact args / actual 的真实窗口验收记录 |
| **V0-D** | 网关独立授权 + KV 环境隔离 + 72h 无 `invalid_grant` | ✅ 核心代码就绪 | ⚠️ 缺环境隔离实测 | ❌ FAIL | `AUTH-READY` §1.2–§1.8 未全绿（KV 隔离、稳定域名 CIMD、回滚演练） |
| **V0-F** | 真实上游 401 脱敏实测 + Docker build + `npm audit` | ✅ 代码单测绿 | ⚠️ 未实测 | ⚠️ PARTIAL | 需真实 401 演练与本地 Docker / `npm audit` 实跑结论 |

---

## 5. 当前 Top 3 优先打点（按依赖收益排序，不排日历）

1. **打点 1 — 核验并上线评测闭环接线（PR #10）**：PR #10 已将平台归因、`servers[]`、`evalMode` 与 `--last-minutes` 分析器合入 `main`，待随下一批实质代码一起部署并在真实客户端验证 `clientPlatform` 分账生效。
2. **打点 2 — 收口 GitHub 高频写入痛点（`OF-1` + Issue #4/#5 核验 + 1ms 测试抖动）**：核对 `1481408` 上 #4/#5 是否已根治，补齐建 Issue 幂等/回查，顺手修掉 `tests/capture-sink-fix.test.js:222` 的 1ms 抖动让 CI 全平台稳定全绿。
3. **打点 3 — 逐项清零 `AUTH-READY` 非交互前置项（为 V0-D 铺路）**：先完成 preview/prod KV 隔离核验、env 命名空间检查与回滚演练，做到清单除人工授权外全绿，再一次性发起上游授权。

---

## 刷新纪律

- 每次代码 PR 合并、手动生产部署或真实验收门状态变化后，由 `[云端总控]` 同步刷新本文件；
- 架构骨架不变时，不修改 [ARCHITECTURE-INDEX.md](ARCHITECTURE-INDEX.md)。
