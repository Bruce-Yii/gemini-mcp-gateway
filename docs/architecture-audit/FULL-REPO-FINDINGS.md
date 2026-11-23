# 全仓库逐文件审计 · 汇总（2026-11-24）

> 覆盖：10 个 agent 分区逐文件阅读；每份报告都带 expected/read/unread 与逐文件表。
> 本文件只做跨报告汇总，不替代分报告。
>
> 分区报告：
> [ledger A](full/10-ledger-a.md) · [ledger B](full/11-ledger-b.md) ·
> [eval docs](full/12-eval-docs.md) · [OSS docs](full/13-oss-docs.md) ·
> [root docs](full/14-root-docs.md) · [src](full/15-src.md) ·
> [tests A](full/16-tests-a.md) · [tests B](full/17-tests-b.md) ·
> [scripts](full/18-scripts.md) · [assets](full/19-assets.md)

## 0. 覆盖

| 分区 | 文件数 | 结果 |
|---|---:|---|
| docs/ledger | 79 | 全部读完 |
| docs/eval | 41 | 全部读完 |
| docs/OPEN-SOURCE | 29 | 全部读完 |
| docs 根层 + 根文档 | 37 + 10 | 全部读完 |
| src/api/workflows/根配置 | 39 | 全部读完 |
| tests | 127 | 全部读完 |
| scripts/harness/bench | 44 | 全部读完 |
| explore/data/templates/examples | 68 | 全部读完 |

审计文档自身（8 份 architecture-audit）不在被审计范围。

## 1. 最重要结论

> **架构方向成立，代码原型强；但“架构承诺”远高于“生产默认”，文档证据链仍断。**

- 生产默认只有 v1 Code Mode；Typed Plan 是 flag/v2；Native/Hybrid/RuntimeAdapter/按客户端选执行器/多客户端隔离/主动被动字段隔离仍是 L0–L1。
- 测试是强回归网，但大量 fake/offline；真实客户端、真实写、真实授权生命周期仍未验收。
- 文档里存在大量 stale commit、旧数字、能力过度宣称、互相矛盾；不能作为验收依据。

## 2. 代码级硬缺口（报告 15-src）

| ID | 问题 | 影响 |
|---|---|---|
| G-03 | `/mcp/v2` plan 路径未注入 typedPlanIO，fail closed | v2 plan 实际不可用 |
| G-04 | `callTool()` 不复核 allow/deny，仅 connect 时过滤 | guest 可调被 deny 工具 |
| G-05 | `file-write.js` commitSha 被 blobSha 覆盖 | 写路径元数据错 |
| G-07 | `vercel-app.js` startCapture 未透传 options | oauthClientMap/sink/asyncQueue 注入失效 |
| G-09 | capture-queue 注释称未接线，实际已接线 | 文档漂移 |
| G-10 | guest applyPatch 与 host applyTextPatch 两份实现 | 语义漂移风险 |
| G-13 | capture-queue seen Set 永不清空 | 长进程内存增长 |

其他：

- `mode` 代码缺省 `whitelist`，配置写 `codemode`，缺配置会暴露多工具面；
- `config.example.json` 的 `_authProvisioning` 与 `servers[]` 冲突；
- 4 vs 5 上游（Figma 未进部分列表）；
- `gateway_call`/`gateway_search` 旧脚本仍存在，和 3 工具契约冲突。

## 3. 测试真相（16/17）

- 127 个测试文件全部读完；强断言多，但：
  - 真实网页客户端零覆盖；
  - 真实写回环零覆盖；
  - 真实 provider refresh/401 零覆盖；
  - Native/Hybrid 零覆盖；
  - 多客户端隔离/并发零覆盖；
  - 大量 fake upstream / 纯函数 / 私有 fixture skip。
- 多个测试是“文档结构自洽”“元测试”“workflow 文本静态断言”，不能当行为验证。
- `1406/1400/0` 是当前基线，但不是 V0 验收。

## 4. 台账的反复根因（10/11）

- 结果协议/可见性契约缺位，导致同一类 bug 反复出现；
- gateway 归因口径失真，很多“网关 bug”实际是上游/客户端；
- 操作层根因靠纪律绕开（CAS 双花、多 worker 抢 grant、30 次整轮作废）；
- 历史修复多次“代码 ✅”但真实客户端/真实写/B5 三项从未验证；
- 测试数字跨批次不可硬比；当前 1406 是 B0–B7 之后结果。

## 5. 评测体系（12/04）

- capture/L1/online-gap/replay/eval-cycle 骨架存在；
- 但：
  - 无 `taskId`；
  - 主动/被动无字段隔离、无同窗对照；
  - online-gap baseline=none；
  - replay 用 fixture；
  - 官方/权威任务集覆盖不完整；
  - scorecard 有 9/20 静默截断嫌疑被 advisory-only 淡化；
  - env-isolation-result 有 4 条 P0 跨环境共享凭据。
- 文档矛盾：
  - join 说 `waitForPrChecks` 不存在，源码已实现；
  - Claude callback 矩阵写 fail，代码已实现；
  - N1–N9 编号漂移；F<n> 语义冲突；
  - 安全审计 F-03/F-09 已过时。

## 6. 上游/授权（03/11/15）

- 代码骨架最深：owner、v2 KV、lease/CAS、DCR/CIMD、static_bearer、写回环；
- 真实 tools/list **3/5**：GitHub/Linear/Figma OK；Notion/Vercel 401；
- owner 生产迁移未做；DSH grant 未替换；KV preview/production 共用；
- 通用限流/退避缺失；Firecrawl/Exa/Tavily 未实现；
- 授权 UX 仍未 ready。

## 7. 客户端（01/14）

- 目标场景是网页非代码模式；但 mode detection 未实现；
- Claude/ChatGPT 真实端到端 unknown；
- 审批弹窗：`execute_read` openWorld=true、`execute` destructive+openWorld=true；实验 profile 未实现；
- onboarding 只有静态文档，没有产品化向导；
- Grok/Muse/Manus 仅调研。

## 8. 运行时（05）

- Vercel HTTP/health 身份 L3；
- Docker L1，NOT-RUN；
- 无 RuntimeAdapter；
- 无扣费硬保障；
- healthz 不反映上游；
- 无回滚演练；
- 文档仍有旧 commit 残留。

## 9. 开源（06/13）

- L0 未过线：公开 README 已有“Gemini tested/可自托管”宣称；
- L1 未过：真实 E2E/授权/Docker/npm audit 未过；
- 文档仍含个人 handle/路径/真实 remote；
- 旧 token 数字 1,520/-99.4% 与 3,564/-98.5% 冲突；
- 治理/模板/兼容策略缺失。

## 10. 资产/模板（19）

- 任务集/基线链条可追溯，但真实 owner/team/fileKey 大量存在；
- 模板分级：
  - local 可跑；
  - vercel reference 未实测；
  - Docker scaffold（绑 127.0.0.1、无 OAuth）；
  - Cloudflare 明确不可部署；
  - client profile 是 design-only。
- 工具快照暴露高危工具（env 解密、Edge Config token、buy_domain 等），默认放行策略未定。

## 11. 最高优先级修复（P0）

1. `/mcp/v2` plan IO 接线（G-03）；
2. `callTool` allow/deny 复核（G-04）；
3. commitSha/blobSha（G-05）；
4. startCapture options（G-07）；
5. 生产 owner 迁移 + KV 隔离；
6. 真实客户端/真实写/授权生命周期验收；
7. 文档去 stale（旧 commit/数字/能力宣称）；
8. 多客户端隔离与 taskId（架构缺口，不是小修）。

## 12. 判断

> **这不是一个已经完成的产品；是一个功能很强、测试较多、但真实链路尚未验收的原型。**
> 架构文档可以继续演进，但在 B/C/D/E 证据出来前，不该对外宣称稳定可用，也不该开源为 L1。
