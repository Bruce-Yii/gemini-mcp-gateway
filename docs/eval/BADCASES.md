# BADCASES — 分类 Badcase 库（云端总控维护）

> **治理标记**：`[云端总控]` 定型（2026-11-24）。
> **用途**：沉淀所有来自真实客户端主动评测与被动高频分析的高价值问题。
> **分类原则**：按 **客户端 × 上游（含跨上游） × 问题类别** 归档，同时保留原文来源与 `buildCommit`——既保洞察与定向抽测权，也支持随时全量丢给单个客户端回归。
> **下线声明**：不再继续新增 `N10+ / J6+ / FB10+` 等碎片字母编号；新问题统一登记于本表并沉淀进确定性回归测试。
> **跨客户端规则**：公共层（tool 描述 / 返回结构 / 截断规则 / helper 契约）的改动见 `AGENTS.md` §3.2；未完成“主客户端 + 至少一个第二客户端”回归的，只能标「未验证」。

---

## 分类维度字典

- **客户端**：`gemini` | `chatgpt` | `claude` | `cross-client`（网关共性）
- **上游**：`github` | `notion` | `linear` | `vercel` | `figma` | `cross-upstream`（单次任务串多个上游）
- **问题类别**：`正文/契约` | `参数/发现` | `写路径/原子性` | `截断/预算` | `跨上游衔接` | `授权/401` | `弹窗/宿主体验` | `CI/轮询`
- **跨客户端验证结果**：`通过`（两端均正向） | `退化`（一端正向一端退化） | `未验证`（未做/证据不足） | `不适用`（客户端/上游专属，不属公共层）
- **状态**：`待复现` | `已修待部署` | `已上生产待复验` | `已通过`

---

## 活跃 Badcase 登记表

| ID | 客户端 | 上游 | 类别 | 现象摘要 | 来源原文 | 发现构建 | 跨客户端验证结果 | 状态 |
|---|---|---|---|---|---|---|---|---|
| **BC-001** | `cross-client` | `github` | 正文/契约 | 读文件 `content` 偶发混入下载提示/SHA；`fileResult.path` 丢失 | [PR80-101 反馈](ONLINE-FEEDBACK-2026-11-24-PR80-101.md) / Issue #4 | `9ab0e57`（旧） | `未验证`（Gemini 未在当前构建复验，第二客户端未跑） | 已修待复验（`1481408`） |
| **BC-002** | `cross-client` | `github` | 正文/契约 | 创建 PR 时 `number` 偶发内部 ID；创建 Issue `number` 空或重复 | [PR80-101 反馈](ONLINE-FEEDBACK-2026-11-24-PR80-101.md) | `9ab0e57`（旧） | `未验证`（同上） | PR 已修待复验；Issue 幂等待补 |
| **BC-003** | `cross-client` | `github` | 写路径/原子性 | `applyFilePatch` 返回 `blobSha` 作 `commitSha`；缺局部补丁一等契约与 TS 预检 | Issue #5 / [PR80-101 反馈](ONLINE-FEEDBACK-2026-11-24-PR80-101.md) | `1481408` | `未验证`（同上） | `commitSha` 已修；补丁/TS 预检待补 |
| **BC-004** | `gemini` | `cross-upstream` | 弹窗/宿主体验 | 客户端已设“允许”仍频繁弹确认框（`openWorldHint`/`destructiveHint`） | [FRAMEWORK.md](../FRAMEWORK.md) §14 | `1481408` | `不适用`（客户端宿主专属，不属公共层） | 待实验 profile B+D |
| **BC-005** | `cross-client` | `github` | CI/轮询 | CI 失败缺少 `rerunFailedJobs` helper；合并后未默认清理源分支 | [PR80-101 反馈](ONLINE-FEEDBACK-2026-11-24-PR80-101.md) | `9ab0e57`（旧） | `未验证`（同上） | 待补 |
| **BC-006** | `cross-client` | `cross-upstream` | 跨上游衔接 | 旧采集 `scorecard` 平台全 `unknown`，且未展开沙箱内部 `subCalls` 给分析器 | [scorecard-2026-11-23](scorecard-2026-11-23.md) | `1481408` | `未验证`（四维分账已落地 PR #18，真实分账未验证） | **代码已修（PR #10）待部署** |
| **BC-007** | `cross-client` | `cross-upstream` | 跨上游衔接 | 单次 `execute_read` 跨 GitHub+Notion+Linear 11 步串行尾延迟 6.2s–14.5s，缺 per-step timing 优化 | [HISTORY-MINED](HISTORY-MINED-2026-11-24.md) §2.2 (`10c13554`) | `2026-11-22` | `未验证`（公共层性能优化，需两端回归） | 待优化 |
| **BC-008** | `cross-client` | `linear` | 参数/发现 | `list_projects` 触发 GraphQL 复杂度超限（19130 > 10000）与 `limit <= 50` 参数边界报错 | [HISTORY-MINED](HISTORY-MINED-2026-11-24.md) §2.3 (`F112/F116`) | `2026-11-22` | `不适用`（上游参数约束，非公共层优化） | 待优化/提示约束 |
| **BC-009** | `cross-client` | `notion` | 写路径/原子性 | `notion-update-page` 局部更新防整页覆盖；`validation_error 400` 与 Business 套餐门控需与网关 bug 区分 | [HISTORY-MINED](HISTORY-MINED-2026-11-24.md) §2.3/§3.3 (`F051/F060/F088`) | `2026-11-22` | `不适用`（上游行为/套餐门控） | 待回归 |
| **BC-010** | `gemini` | `github` | 正文/契约 | 实测 `github__issue_write` 顶层 `number:null`、`normalizeMerge` `number/url:null`、`fileResult` 对 40KB 完整文件误标 `truncated:true`、`writeFiles` 误传 `files` 静默无报错 | Issue #15（云端总控 Gemini 实测） | `1481408` | `未验证`（公共 canon/写路径，需 ChatGPT/Claude 防串伤回归） | 待复现修复 |

---

## 跨客户端防串伤回归记录区（M4-C）

> 规则来源：`AGENTS.md` §3.2。每条“公共层优化在主客户端验证有效后”的跨客户端回归都登记在这里；
> 没有第二客户端证据就写 `未验证`，不得用主客户端单端结果代替。

| 日期 | 公共层候选 / 变更 | 主客户端（Gemini） | 第二客户端（ChatGPT / Claude） | 结论 | 证据 |
|---|---|---|---|---|---|
| 2026-11-24 | 本任务无公共层代码变更（仅规则 + 闭环实测）；PR80–101 候选：content notice / PR number URL-first / truncation metadata / CI wait helper | 仅旧构建用户反馈，**当前构建未复验** | **未执行**（无真实第二客户端窗口） | `未验证` —— 不得写“公共层已修复” | [M4-C-FREQ-CLOSED-LOOP-2026-11-24.md](M4-C-FREQ-CLOSED-LOOP-2026-11-24.md) |

### 跨客户端回归最小检查单（执行时逐项填）

1. 客户端 + buildCommit + requestId（没有写 `unknown`）；
2. 主客户端结果（正向/退化 + 证据字段）；
3. 第二客户端结果（正向/退化 + 证据字段）；
4. 公共层保留 / 下沉 `client-profile` / 底座配置隔离 的判定；
5. 若退化：隔离方案与回归用例路径；
6. 未完成项写 `未验证` 原因，不写成“通过”。

---

## 回归用法

- **定向抽测**：按 `客户端` 或 `上游` 列过滤出 `已上生产待复验` 项，交给对应客户端在受控测试仓库跑一遍；
- **跨客户端防串伤**：按「公共层候选」抽 `cross-client` 条目，先主客户端、再第二客户端各跑一次，结果写进上方记录区；
- **全量回归**：发版前可将表中所有 `cross-client` 与目标客户端条目打包交给单一客户端（如 ChatGPT / Gemini）做回归核验。
