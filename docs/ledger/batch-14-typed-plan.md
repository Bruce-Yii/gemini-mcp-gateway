# B14 — Typed-plan / adaptive execution test program

> 状态：执行中。目标不是换产品核心，而是给“执行层”增加一个平台适配方案：
> **typed plan 为主，Code Mode 为 fallback**。三工具、上下文压缩、读写分层、capture/eval 不变。

## 不变量

- 仍然只暴露 `search` / `execute_read` / `execute`；
- 上游 token、项目标签、session 标签、capture、写路径语义不变；
- 平台隔离（OAuth/clientProfile/eval lane）继续有效；
- 不做多租户；
- 没有 A/B 数据，不默认切换。

## 当前并行 agent

| Agent | 产物 | 验收 |
|---|---|---|
| `typed-plan-design` | `docs/eval/TYPED-PLAN-TEST-PLAN.md` | A/B 设计、任务集、指标、失败分类、验收线 |
| `reuse-research` | `docs/OPEN-SOURCE/REUSE-RESEARCH.md` | 可复用项目/代码、license、集成成本、3 条建议 |
| `typed-plan-spike` | `scripts/typed-plan-spike.mjs` + tests + ledger | op registry、校验、dryRun、部分失败、无生产接线 |
| `platform-conformance` | `docs/eval/PLATFORM-CONFORMANCE-MATRIX.md` | Gemini/ChatGPT/Claude 的 OAuth/schema/plan/code 测试矩阵 |

## 方案概要

```text
Profile F（现状）
  execute({ code })        自由 JS

Profile S（候选）
  execute_read({ plan: [...] })   typed ops
  execute({ plan: [...] })        typed ops（写需 dryRun/批准）
  execute({ code })               复杂任务 fallback
```

## 为什么做

- Gemini 在自由 Code Mode 下回退（外部 benchmark + 本地 G6/真实窗口）；
- 参数名、PR number、截断、anchor 等错误来自“自由脚本空间过大”；
- typed op 可做 schema 校验、dry-run、幂等、逐步观测；
- 但复杂数据变换仍需 Code Mode，不能一刀切。

## 验收线

- Profile S 的 completion 不低于 F − 3pp；
- tokens/task 不高于 F；
- repair 次数下降 ≥30%；
- 写回放成功率不低于 F；
- 每平台独立 lane/baseline，不跨平台硬比；
- 数据不够就保持 F，不切换默认。

## 明确不做

- 不直接用 Anthropic/OpenAI/第三方代码而不做 license 审计；
- 不把 `plan` 做成第二套工具面（仍通过 execute_read/execute）；
- 不用 typed plan 替代写路径/幂等/审批；
- 不承诺 ChatGPT Free/Plus 完整 MCP。
