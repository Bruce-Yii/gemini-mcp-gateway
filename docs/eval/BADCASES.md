# BADCASES — 分类 Badcase 库（云端总控维护）

> **治理标记**：`[云端总控]` 定型（2026-11-24）。
> **用途**：沉淀所有来自真实客户端主动评测与被动高频分析的高价值问题。
> **分类原则**：按 **客户端 × 上游（含跨上游） × 问题类别** 归档，同时保留原文来源与 `buildCommit`——既保洞察与定向抽测权，也支持随时全量丢给单个客户端回归。
> **下线声明**：不再继续新增 `N10+ / J6+ / FB10+` 等碎片字母编号；新问题统一登记于本表并沉淀进确定性回归测试。

---

## 分类维度字典

- **客户端**：`gemini` | `chatgpt` | `claude` | `cross-client`（网关共性）
- **上游**：`github` | `notion` | `linear` | `vercel` | `figma` | `cross-upstream`（单次任务串多个上游）
- **问题类别**：`正文/契约` | `参数/发现` | `写路径/原子性` | `截断/预算` | `跨上游衔接` | `授权/401` | `弹窗/宿主体验` | `CI/轮询`
- **状态**：`待复现` | `已修待部署` | `已上生产待复验` | `已通过`

---

## 活跃 Badcase 登记表

| ID | 客户端 | 上游 | 类别 | 现象摘要 | 来源原文 | 发现构建 | 状态 |
|---|---|---|---|---|---|---|---|
| **BC-001** | `cross-client` | `github` | 正文/契约 | 读文件 `content` 偶发混入下载提示/SHA；`fileResult.path` 丢失 | [PR80-101 反馈](ONLINE-FEEDBACK-2026-11-24-PR80-101.md) / Issue #4 | `9ab0e57`（旧） | 已修待复验（`1481408`） |
| **BC-002** | `cross-client` | `github` | 正文/契约 | 创建 PR 时 `number` 偶发内部 ID；创建 Issue `number` 空或重复 | [PR80-101 反馈](ONLINE-FEEDBACK-2026-11-24-PR80-101.md) | `9ab0e57`（旧） | PR 已修待复验；Issue 幂等待补 |
| **BC-003** | `cross-client` | `github` | 写路径/原子性 | `applyFilePatch` 返回 `blobSha` 作 `commitSha`；缺局部补丁一等契约与 TS 预检 | Issue #5 / [PR80-101 反馈](ONLINE-FEEDBACK-2026-11-24-PR80-101.md) | `1481408` | `commitSha` 已修；补丁/TS 预检待补 |
| **BC-004** | `gemini` | `cross-upstream` | 弹窗/宿主体验 | 客户端已设“允许”仍频繁弹确认框（`openWorldHint`/`destructiveHint`） | [FRAMEWORK.md](../FRAMEWORK.md) §14 | `1481408` | 待实验 profile B+D |
| **BC-005** | `cross-client` | `github` | CI/轮询 | CI 失败缺少 `rerunFailedJobs` helper；合并后未默认清理源分支 | [PR80-101 反馈](ONLINE-FEEDBACK-2026-11-24-PR80-101.md) | `9ab0e57`（旧） | 待补 |
| **BC-006** | `cross-client` | `cross-upstream` | 跨上游衔接 | 旧采集 `scorecard` 平台全 `unknown`，且未展开沙箱内部 `subCalls` 给分析器 | [scorecard-2026-11-23](scorecard-2026-11-23.md) | `1481408` | **代码已修（PR #10）待部署** |

---

## 回归用法

- **定向抽测**：按 `客户端` 或 `上游` 列过滤出 `已上生产待复验` 项，交给对应客户端在受控测试仓库跑一遍；
- **全量回归**：发版前可将表中所有 `cross-client` 与目标客户端条目打包交给单一客户端（如 ChatGPT / Gemini）做回归核验。
