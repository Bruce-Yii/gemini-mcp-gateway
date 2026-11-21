# B2 · 阶段二：所有暴露问题逐条追溯根源 + 修复

> 门控：B1 已通过。本项通过后才能进 B3。
> **"追溯根源"定义**：表象→L1直接原因→L2深层原因→L3根本原因（认知/假设/流程）。修复须作用在根因层。

## 各子批次追溯报告

| 子批次 | 报告 | 状态 |
|---|---|---|
| B2-A 协议/解包 | work/rc-a.md | ✅ |
| B2-B 沙箱/安全 | work/rc-b.md | ✅ |
| B2-C token/认证 | work/rc-c.md | ✅ |
| B2-D 检索/上下文 | work/rc-d.md | ✅ |
| B2-E 测试/工具链 | work/rc-e.md | ✅ |
| B2-F 工程/部署 | work/rc-f.md | ✅ |

## 根因追溯结论汇总

### 修到根因（L3）的 ✅
- 沙箱逃逸（SBX-1）：换 QuickJS 引擎，作用在"vm 不能当安全边界"的 L3 假设
- toolCalls 泄漏（RC-A2）：toModelOutput 出口白名单，作用在"省上下文没变成代码约束"的 L3
- execute 崩溃（RC-A5）：错误 reify 为一等数据，作用在 L3
- 双重序列化（RC-F1）：toJSON 单次序列化，作用在 L2/L3
- 结构化截断（RC-F2）：同形状合法 JSON，作用在 L2/L3

### 修在 L1/L2，L3 未闭环的 ⚠️（需补修或明确接受）
1. **归一化时序 bug（RC-D3，真 bug）**：`validateToolArgs` 在归一化之前执行——模型填 camelCase 的必填字段会先被校验拦下，归一化没机会跑。**必须修**。
2. **structuredContent 吞块（RC-A3）**：`return r.structuredContent` 会吞掉同一结果的 image/resource/audio。需修。
3. **search 排序（RC-D1）**：服务归属没建成结构化过滤维度，只在打分循环里加权；v2 searchHitRate 仅 75.4%。作用在 L1/L2。
4. **select: 误用（RC-D8）**：根因是接口设计（一个 query 参数承载两套语法），改描述是 L1。作用在 L1。
5. **execute_read annotations（SBX-4）**：L3 未闭环——未用真实 listTools 核实上游是否给 annotation；影响是通道降级（stub 给可行动错误），安全不损。
6. **30 次上限（SBX-6）**：提到 50 + 去重，但"超限整轮作废"机制未改。
7. **search_empty 兜底（RC-D4）**：只在外层 search，沙箱内 search 无兜底；对 v2 19 条里 17 条无效。
8. **Notion 双根因（AUTH-1）**：代码根因（rotation 无知）+ 操作根因（多 worker 抢 grant）叠加，后者靠纪律/静态 token 绕开，未实现隔离。
9. **GitHub 403（AUTH-2）**：换 PAT 修 L2，L3 凭据供应流程未修（DEPLOY.md 仍写只读端点，与配置矛盾）。
10. **lock+CAS（AUTH-3）**：CAS 在 provider 调用之后，挡不住已发生的双花；锁失败降级无锁。

### 决策层 L3 未制度化（RC-F）
- Firecrawl 额度误判、Cloudflare normalize 误判、部署 runtime 非法——三类 lead 自身错误的共同 L3："有权威依据可支配却没去用"。建议在 ledger README 的证据规则里写死"额度逐个实测+时间戳""逐文件读源码+交叉验证""配置改后跑 schema 校验"。

### 文档错位（RC-B）
- SANDBOX-SECURITY.md 仍写"真隔离未引入"，但代码已迁移；full-audit/BACKLOG 的"17 条未修"也过期。需同步。

## B2 门控结论

**未通过**——存在 1 个真 bug（归一化时序）和若干 L1/L2 层残留。必须先补修真 bug + 明确接受/处理其它残留，才能进 B3。

### 进 B3 前的补修进度

| # | 项 | 状态 | 证据 |
|---|---|---|---|
| 1 | 归一化时序 bug（validateToolArgs 归一化前） | ✅ 已修 | codemode.js validateToolArgs 先 normalizeToolArguments；tests/normalization-order.test.js 4/4 |
| 2 | structuredContent 吞块 | ✅ 已修 | tool-format.js 仅当无其它块时才提前返回；tests/structured-content-blocks.test.js |
| 3 | 同步过期文档（SANDBOX-SECURITY/BACKLOG/DEPLOY/ledger 证据规则） | ✅ 已同步 | b2-docs：真隔离状态、端点矛盾、三条防再犯证据规则 |
| 4 | L1/L2 残留逐条决定：补修 or 登记 DEC | ✅ 已完成 | 见下方处置表 |
| 5 | 沙箱内 search 兜底（RC-D4） | ✅ 已修 | 抽 searchWithFallback 共享函数，外层+沙箱共用；tests/b2-patch.test.js |
| 6 | model_confusion 边界引导（RC-D7） | ✅ 已修 | EXEC_BOUNDARY_GUIDANCE 追加到 execute/execute_read 描述 |

**最终测试**：`npm test` 217/217 全绿，0 fail，0 skip。

## B2 门控结论：✅ 通过

- 6 份根因追溯报告齐全（work/rc-a.md ~ rc-f.md），每条问题都做了表象→L1→L2→L3 追溯
- 2 个真 bug 已修（归一化时序、structuredContent 吞块）+ 验证测试
- 2 个高 ROI 补修已做（沙箱 search 兜底、边界引导）
- 文档与代码已同步（真隔离、端点、证据规则）
- 剩余 L1/L2 残留逐条登记为"接受（DEC）"，附理由，不再是隐藏欠账

**可进 B3**：全部优化完成后必须全量重测——用修好的框架（探测器 2.1 + 并行 harness + 免费模型 guard）+ 当前代码基线，重跑 191 条，替换失真的旧数据。

### L1/L2 残留处置决定（逐条）

| 残留 | 决定 | 理由 |
|---|---|---|
| search 排序打补丁（RC-D1） | 接受（登记 DEC） | 用户核心是省上下文+找问题；searchHitRate 75.4% 是可接受探索阶段水平，重构打分模型 ROI 低且有回归风险 |
| select: 接口设计（RC-D8） | 接受（登记 DEC） | 改描述已缓解；真正修要拆成两个工具（search + get_schema），会改变工具快照→又要用户重连，成本高于收益 |
| execute_read annotations L3（SBX-4） | 接受（登记 DEC） | 降级为 stub 可行动错误，安全不损；GitHub/Notion 已证实给 annotation，Vercel 待核实但只影响审批摩擦 |
| 30 次上限整轮作废（SBX-6） | 接受（登记 DEC） | 已提到 50 + 去重，实际触发率低；改增量返回机制复杂 |
| search_empty 兜底仅外层（RC-D4） | 补修 | 沙箱内 search 也应有兜底，小改动 |
| model_confusion 网关引导（RC-D7） | 补修 | instructions 加边界处理引导，小改动 |
| Notion 双根因/操作层（AUTH-1） | 接受（登记 DEC） | 静态 token 禁 refresh 已绕开；实现每 worker 独立 token 隔离成本高，当前不恢复 refresh 就不会触发 |
| GitHub 403 凭据流程（AUTH-2） | 接受（登记 DEC） | 已换 PAT 解决；DEPLOY.md 端点描述矛盾属文档问题，同步修正 |
| lock+CAS 双花窗口（AUTH-3） | 接受（登记 DEC） | CAS 后置是 KV 存储能力限制；分布式锁+自愈已把概率降到极低 |
| lead 认知 L3 制度化（RC-F） | 补修文档 | 把"额度实测+时间戳""逐文件读源码""配置改后校验"写进 ledger 证据规则 |
