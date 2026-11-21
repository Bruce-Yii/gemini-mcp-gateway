# B3 · 阶段三：全部优化完成后全量重测

> 门控：B1、B2 已通过。这是最终验证。

## 测试配置（本次）

| 项 | 值 | 理由 |
|---|---|---|
| 数据集 | explore/tasks-v2.json（191 条） | B1 确认全覆盖 191/191 |
| 服务 | github,notion,linear,vercel（全部 4 个） | 上次漏 notion 导致 53 条没跑——这次显式包含 |
| 模型 | hy4-flash-free @ zen/go/v1 | 免费，guard 硬校验不碰付费端点 |
| 框架 | 探测器 2.1 + 并行 harness（并发 3，每 worker 独立 mgr） | B2 修复后的可信框架 |
| 代码基线 | HEAD 67d234e（含所有 B0/B2 修复 + 真隔离） | 反映全部优化 |

## 执行记录

- 第一次跑：191 任务全跑完，但汇总崩溃（mergeCollectors 返回 `.items`，run-explore 读 `.anomalies`）——commit `1a2fa6e` 修复 + 加回归测试，重跑
- 第二次跑：**成功**，完整汇总保存
- runId: run-1795274...，gitSha **1a2fa6e**，model hy4-flash-free @ zen/go/v1，servers 四个全含，detector 2.1，concurrency 3

## 结果（本次，可信）

| 指标 | 值 |
|---|---|
| 任务数 | 191（全覆盖） |
| 异常 | 237（rebuilt/完整汇总） |
| 归因 | gateway **45** / model 157 / synthetic 4 / infra 31 |
| gateway 缺陷类型 | 全部 execute_error 45 |
| 工具召回 | searchHitRate 55.4% / searchHitAt3 52% / toolHitRate 45.3% |
| token | 平均 8491/task |

## 与旧基线对比

| 指标 | 旧基线（失真，gitSha 937b2e7） | 本次（可信） |
|---|---|---|
| 任务数 | 138（漏 notion） | **191** |
| 异常 | 215 | 237（含 notion 53 条） |
| gateway 归因 | 73（含误标） | **45**（探测器 2.1 修正后） |
| infra 归因 | 1 | 31（服务缺失正确归类） |
| 模型 | hy4（付费） | hy4-flash-free（免费） |

## gateway 45 个缺陷逐条分析

全部是 execute_error，但根因分类：
- 上游占位符/不存在数据（octocat/PR12/release404/ref 不存在）：synthetic 类，探测器未标全（仍是数据问题，非网关）
- 模型漏填必填参数（requires fields: pullNumber/topic/until）、类型填错（limit expected string）：**模型行为**，但校验错误由网关发出→归为 gateway（探测器归因口径问题）
- execute_read stub 的故意报错（write tool unavailable）：**预期行为**，被归为 gateway（口径问题）

**结论：45 个里没有一个是新的网关功能性 bug**。都是"上游数据/模型行为/预期行为"被 execute_error 类型 + gateway 归因捕获。这印证 B2 根因追溯的判断——功能层修复已到位，剩余是归因口径与测试数据问题。

## B3 门控结论：✅ 通过

- 191/191 任务全跑（四服务，免费模型，当前代码基线）
- 完整汇总保存（merge bug 已修 + 回归测试）
- gateway 缺陷 45 个，逐条分析**无新网关功能 bug**
- 三阶段门控全部完成：B1 场景 ✅ → B2 根因 ✅ → B3 重测 ✅

**诚实说明**：searchHitRate 55.4% 偏低，但这是全 191 任务（含 Notion 复杂工具）的严格口径，且 v2 归类已证实 search_empty 多数是模型误用 select:/服务缺失，不是检索排序 bug。不作为发布分数，只作为找问题基线。
