# Acceptance criteria (V0) — 不是测试数，是真实结果

> **当前结论：NOT ACCEPTED（1/7：A PASS；B/D/E/G FAIL；C/F PARTIAL）。**
> 最后同步：2026-11-25（Asia/Singapore）；生产 `f2002d9`，`main` HEAD `cd23fdc`（PR #28 已合入、未进入生产构建）。
> 下面的“已通过”只能说明代码层回归；不能说明线上、真实客户端、真实写入、真实授权可用。
> 测试数量、CI 绿灯、fake harness 通过，**都不算验收**。

## 0. 为什么现有“全绿”不算验收

- 测试是我们自己写的，可能和实现共享同一个错误假设；
- L1/G6 用 fake upstream，不等于真实 GitHub/Notion/Linear/Vercel；
- replay fixture 不含真实 requestId/真实模型/真实宿主；
- 生产 `f2002d9` 与 `main` `cd23fdc` 存在差距（PR #28 未进生产；Pack 1 / Pack 2 未合并）；
- skip 是“私有 fixture 不存在”，不是功能通过；
- Docker build、npm audit 未跑；
- M4 Gate 2/3 仍有未验项（周报限流、语义发现重跑）；
- 没有真实客户端 lane、没有 canary、没有真实授权生命周期。

## 1. V0 验收门（全部必须通过，不允许部分分）

### A. 构建与部署可追溯

- [x] 生产 `/healthz` 返回的 commit/buildHash 与当前验收构建 `f2002d9` 一致；
- [x] 部署记录可查（DEPLOYMENTS + deploymentId）；
- [x] 不是旧构建、不是本地 loopback（Vercel `env=production`）。

**当前：PASS（2026-11-25 01:55 手动部署 `f2002d9`；healthz `commit=f2002d9…` / `buildHash=3b1a0772…` / `deploymentId=dpl_6P2Ww8vsTHXbbSF98GTE55HKitB4`；DEPLOYMENTS 已登记。历史 40 次自动部署仍不可追溯，不影响当前构建可追溯性；A 门只证明构建可追溯，不代表 B–G 验收）**

### B. 真实客户端任务

在 Gemini web + ChatGPT（可用的话）真实窗口跑固定任务，至少 10 条：

- 读文件并返回首行/长度/truncated；
- 按分支读真实变化文件（ref/branch 控制）；
- PR number vs DB id；
- 大文件末尾字段；
- 批处理包装；
- 多文件原子写；
- CI 等待；
- 失败恢复；
- 长会话重连；
- 错误消息不含 token。

每条必须有：

- 客户端原文；
- 工具调用名/参数；
- 实际返回字段；
- 期望 vs 实际；
- requestId 或明确 unknown。

**当前：FAIL（未跑 10 条固定任务；ChatGPT 10 条请求是 capture 计数，不是 B 门验收记录）**

### C. 真实写回环

在受控测试仓库：

- [x] read → patch → commit → PR；
- [ ] 写后文件首行/字节与预期一致，无 notice；
- [x] PR number 是真实编号；
- [ ] CI 能跑完并读取；
- [ ] 失败不留半成品；
- [ ] 仓库无脏文件。

**当前：PARTIAL（真实写回环已在验收仓库跑通 read→patch→commit→PR，见 `ACCEPTANCE-EVIDENCE-2026-11-24.md`；CI 因 GitHub 账户 billing 未启动，无法读到完成状态；失败补偿 / 仓库脏文件仍需补跑）**

### D. 授权生命周期

- [ ] 网关独立 grant，不使用 DSH refresh token；
- [ ] 重启后仍可用；
- [ ] 跨环境隔离；
- [ ] 72h 无 `invalid_grant`；
- [ ] 失败有 `REAUTH_REQUIRED`，不静默。

**当前：FAIL（仅凭据侧有进展：Linear 已切 `static_bearer` + PAT 并在 `f2002d9` 线上 `list_teams` 成功；Notion OAuth 已存储 `owner=gateway` / `source=gateway-dcr` / `refresh=yes`，但 runtime 仍 `offline`（0 tools、`needsReauth`），Pack 2 / PR #31 未合并。重启后可用、跨环境隔离、8h/72h 无 `invalid_grant`、`REAUTH_REQUIRED` 实测均未完成）**

### E. 在线 ↔ 半在线同任务对照

- [ ] 旧生产构建 vs 新构建，同 prompt/fixture/session；
- [ ] F1–F6 每项有 old/new 两列；
- [ ] 不跨构建硬比；
- [ ] 数据不足标 `NOT_ENOUGH`，不判通过。

**当前：FAIL（无冻结 baseline；PR #24 双窗口已有请求级 `match=exact`（window1 3 个 requestId 在窗内验证），但同一任务的 old/new 构建同 prompt/fixture/session 对照未做；PR #28 语义发现（`responsePreview` / `observed.findings`）未重跑）**

### F. 真实安全结果

- [ ] 模型可见错误中无 token（真实上游 401 实测）；
- [ ] capture 仍 full-fidelity；
- [ ] 预算/原型/截断防护在真实路径生效；
- [ ] Docker build + npm audit 有结论。

**当前：PARTIAL（代码 / 单测与模型可见错误脱敏有覆盖；真实上游 401 演练、Docker build、`npm audit` 仍缺；capture full-fidelity 规则未变）**

### G. 独立评测

- [ ] 非 lead 的 GPT/独立 evaluator 按 Issue #3 跑任务；
- [ ] 结果与 lead 结论独立；
- [ ] 发现的问题进 join/半在线任务。

**当前：FAIL（Issue #3 模板 / 工作队列已有，独立 evaluator 有部分证据但未归档为完成；无独立于 lead 的完整跑分结论）**

## 2. 当前状态一句话

> **V0：1/7 门通过（A）；B / D / E / G FAIL，C / F PARTIAL；整体 NOT ACCEPTED。**

## 3. 验收证据格式

每条 gate 必须附：

```text
gate:
commit/build:
client: gemini | chatgpt | claude | inspector | independent
task:
exact tool call:
actual:
expected:
requestId:
pass/fail:
evidence path:
```

没有证据的“通过”一律视为 FAIL。

## 4. 下一步

1. 合并并部署 Pack 2 / PR #31，验证 Notion runtime 不再 `offline`；
2. 合并 Pack 1 / PR #30，周报 0 R2 GET/429 有结论（M4 Gate 2）；
3. 跑 B 门：Gemini / ChatGPT 各 10 条固定任务，逐条留存原文、exact args、actual、requestId；
4. 修 GitHub billing 后补 C 门：CI 跑完并读取、失败补偿、仓库无脏文件；
5. D 门：Notion runtime 上线后做重启、跨环境隔离、8h/72h 生命周期与 `REAUTH_REQUIRED` 实测；
6. E 门：冻结 baseline，做同任务 old/new 构建对照，并重跑 PR #28 语义发现；
7. F 门：真实上游 401 演练、Docker build、`npm audit` 补结论；
8. G 门：让独立 evaluator 按 Issue #3 跑完并归档；
9. 以上收口后再进入 M1×M2 联合收口；全过才写“验收通过”。
