# 架构审计索引（2026-11-24）

七个只读审计，按用户六模块 + 跨模块拆解。每份报告都区分 [代码]/[文档]/[测试]/[未验证]。

| # | 模块 | Agent | 报告 |
|---|---|---|---|
| 00 | 跨模块 | arch-crosscut | [00-crosscut.md](00-crosscut.md) |
| 01 | 客户端 | arch-client | [01-client.md](01-client.md) |
| 02 | 核心底座/执行 | arch-execution | [02-execution.md](02-execution.md) |
| 03 | 上游接入 | arch-upstream | [03-upstream.md](03-upstream.md) |
| 04 | 评测体系 | arch-eval | [04-eval.md](04-eval.md) |
| 05 | 运行时/部署 | arch-runtime | [05-runtime.md](05-runtime.md) |
| 06 | 开源工程 | arch-oss | [06-oss.md](06-oss.md) |

## 共同结论

1. **架构方向成立**：六模块 + 分层 + 主动/被动评测的表述与用户原话一致；文档已纠偏。
2. **实现与架构不对等**：
   - 生产默认只有 v1 Code Mode；
   - Typed Plan 是 flag/v2，不是默认；
   - Native/Hybrid、按客户端选执行器、RuntimeAdapter、多客户端隔离、执行所有权都还是 L0-L1。
3. **真实证据不足**：
   - 真实 tools/list 3/5；Notion/Vercel 401；
   - owner 迁移未做，KV preview/production 共用；
   - 真实客户端/真实写回环/授权生命周期未验收；
   - L1 online-gap baseline=none，replay 是 fixture；
   - Docker/npm audit 未验证。
4. **审批 UX 双触发**：`execute_read` openWorld=true、`execute` destructive+openWorld=true；实验 profile B+D 未实现。
5. **开源仍是 L0**：公开 README 已有超出证据的宣称；L1 未过。

## 最关键的五个“文档说有、代码没有”

- 按客户端自动选择执行器；
- Native/Hybrid 执行器；
- RuntimeAdapter 多载体适配；
- 多客户端隔离与并发调度；
- 主动/被动评测字段隔离与同窗对照。

> 这些是架构审计的核心发现：**不是模块没写，是“架构承诺”和“生产默认”之间还有距离。**
