# B0 · 历史回溯台账

> 本轮三阶段门控之前已做的工作，按分类回溯登记。证据为 git log 与 docs/、work/ 下的报告。

## SCENARIO（测评场景）

| 条目 | 内容 | 状态 | 证据 |
|---|---|---|---|
| SCENARIO-H1 | 四 MCP 官方任务深挖（191 条，105 官方逐字） | ✅ | work/deep-*.json, work/re*.json |
| SCENARIO-H2 | 86 条 derived 用 schema 驱动+反向验证重生（86/86 top5） | ✅ | work/regen-*.json, explore/tasks-v2.json |
| SCENARIO-H3 | 权威 benchmark 盘点（MCPMark 等，Linear/Vercel 0 覆盖） | ⚠️ | docs/AUTHORITATIVE-TASK-SOURCES.md（B1 重搜中） |

## ISSUE / ROOT / FIX（暴露问题 → 根因 → 修复）

> 详细逐条在 docs/GEMINI-REAL-TASK-FEEDBACK.md、docs/EXPLORATION-FINDINGS.md、work/full-audit.md（59 条对账）。此处按批次汇总。

| 批次 | commit | 主要修复 |
|---|---|---|
| B0-1 | 299e9ee | P0/P1：resource 内容块丢失、isError 静默、search 权重、console 方法、格式统一 |
| B0-2 | 2f17d5a | CAS fencing：并发 refresh 不能覆盖 winner token（RFC 9700） |
| B0-3 | fd8b74b→a04ce39 | 探索测试基建：官方任务集、异常捕捉、问题清单 |
| B0-4 | 4bf27f5→1328506 | execute 崩溃兜底、invalid_grant 终态、分布式锁、全量探索 191 条 |
| B0-5 | fd8b74b 系 | Notion token 反复烧：bootstrapped 清除 + 锁 + CAS + self-heal |
| B0-6 | 7f0581f | Gemini 真实任务反馈记账（P0 resource 丢失、toolCalls 泄漏、5 处 P1） |
| B0-7 | ac5a858 | Notion 53 条全跑（静态 token 禁 refresh） |
| B0-8 | fd8b74b→a04ce39 | 86 条重生任务 + 真隔离方案调研 + CAS 等 |
| B0-9 | 299e9ee→1328506 | P0/P1 修复：resource 保留、toolCalls 截断、Web API、execute_read 拆分、enum 提示、search 兜底 |
| B0-10 | 4bf27f5 | base64 乱码 + Buffer 逃逸面 + 去掉错误安全承诺 |
| B0-11 | a1c8051→4bf27f5 | 6 代理并行：双重序列化、结构化截断、5 类内容块、listTools 精简、50次上限+去重、toModelOutput 审计剥离、logs 上限、错误结构化、sanitize 6 bug、execute_read 回归 |
| B0-12 | 3b238fa | select: 精确用法引导（根因：模型误用非精确匹配失败） |
| B0-13 | 03c294b | 图片透传通道、入参轻量校验、免费模型 guard |
| B0-14 | 88a290e | 探测器误标、逃逸 Proxy 止血、summarizeArgs 循环、search 形状、错误行号、deadline、过期文档 |
| B0-15 | 633cb6f | **真隔离**（Vercel run SDK QuickJS）、参数归一化、harness 并行、MCPMark 金标映射 |
| B0-16 | 5ab2e47 | 修复非法 vercel runtime 字段导致的部署 ERROR |

## TEST（测试）

| 条目 | 状态 | 证据 |
|---|---|---|
| TEST-H1 | 单元测试从 62 项增至 207 项，全绿 | npm test（多次） |
| TEST-H2 | v2 探索全量跑（138 条，215 异常，带归因） | explore/results/anomalies.json（gitSha 937b2e7 旧基线） |
| TEST-H3 | 真隔离线上探活（逃逸被挡、Web API 正常） | work/probe 实测：Function constructor is not allowed |
| TEST-H4 | Notion grant 修复后实测恢复（搜索返回真实页面） | 早期 verify 记录 |

## DEC（决策）

| 条目 | 决策 | 理由 |
|---|---|---|
| DEC-H1 | 图片透传、入参校验：做 | Gemini 真实任务反馈，已落地 |
| DEC-H2 | camelCase 归一化：做（非全局，四规则） | 只改 schema 声明的 snake 目标，不误伤 Notion 原生 camelCase |
| DEC-H3 | 大结果 spill：不做（已有结构化截断） | Cloudflare 实际只截断不 spill；真 spill 需 Blob+KV，等实测 >5% 超 24k 再上 |
| DEC-H4 | select: 回退：不做 | 根因是模型误用，已改引导文案 |
| DEC-H5 | fetch 注入沙箱：不做 | 扩大网络与逃逸面，与真隔离目标冲突 |
| DEC-H6 | 金标自动打分：不做（只做 prompt 权威性） | MCPMark verifier 依赖其临时 eval 环境，硬跑出假金标 |
