# Acceptance criteria (V0) — 不是测试数，是真实结果

> 当前结论：**NOT ACCEPTED**。
> 下面的“已通过”只能说明代码层回归；不能说明线上、真实客户端、真实写入、真实授权可用。
> 测试数量、CI 绿灯、fake harness 通过，**都不算验收**。

## 0. 为什么现有“全绿”不算验收

- 测试是我们自己写的，可能和实现共享同一个错误假设；
- L1/G6 用 fake upstream，不等于真实 GitHub/Notion/Linear/Vercel；
- replay fixture 不含真实 requestId/真实模型/真实宿主；
- 生产仍是旧构建，线上行为未被验证；
- 117 个 skip 是“私有 fixture 不存在”，不是功能通过；
- Docker build、npm audit 未跑；
- F1/F2 只是 `pending-deploy`，F3–F6 没在线复验；
- 没有真实客户端 lane、没有 canary、没有真实授权生命周期。

## 1. V0 验收门（全部必须通过，不允许部分分）

### A. 构建与部署可追溯

- [ ] 生产 `/healthz` 返回的 commit/buildHash 与验收 commit 一致；
- [ ] 部署记录可查；
- [ ] 不是旧构建、不是本地 loopback。

**当前：PARTIAL（生产 `9ab0e57`；healthz 匹配，但验收 commit 已失效、push 自动部署 40 次、部署记录不全）**

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

**当前：FAIL（未跑真实窗口）**

### C. 真实写回环

在受控测试仓库：

- [ ] read → patch → commit → PR；
- [ ] 写后文件首行/字节与预期一致，无 notice；
- [ ] PR number 是真实编号；
- [ ] CI 能跑完并读取；
- [ ] 失败不留半成品；
- [ ] 仓库无脏文件。

**当前：PARTIAL（真实只读 replay 做过；真实写未在验收仓库跑）**

### D. 授权生命周期

- [ ] 网关独立 grant，不使用 DSH refresh token；
- [ ] 重启后仍可用；
- [ ] 跨环境隔离；
- [ ] 72h 无 `invalid_grant`；
- [ ] 失败有 `REAUTH_REQUIRED`，不静默。

**当前：FAIL（AUTH-READY NOT READY；无真实授权）**

### E. 在线 ↔ 半在线同任务对照

- [ ] 旧生产构建 vs 新构建，同 prompt/fixture/session；
- [ ] F1–F6 每项有 old/new 两列；
- [ ] 不跨构建硬比；
- [ ] 数据不足标 `NOT_ENOUGH`，不判通过。

**当前：FAIL（未部署；baseline=none）**

### F. 真实安全结果

- [ ] 模型可见错误中无 token（真实上游 401 实测）；
- [ ] capture 仍 full-fidelity；
- [ ] 预算/原型/截断防护在真实路径生效；
- [ ] Docker build + npm audit 有结论。

**当前：PARTIAL（代码测试有；真实 401/镜像/审计未做）**

### G. 独立评测

- [ ] 非 lead 的 GPT/独立 evaluator 按 Issue #3 跑任务；
- [ ] 结果与 lead 结论独立；
- [ ] 发现的问题进 join/半在线任务。

**当前：FAIL（Issue 模板已有；独立跑分未完成）**

## 2. 当前状态一句话

> **V0：0/7 门全过；代码层候选，真实验收未开始。**

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

1. 部署最新代码（Vercel 额度恢复）；
2. 跑 B/C 的真实客户端与真实写回环；
3. 跑 D 的授权生命周期；
4. 跑 E 的双构建对照；
5. 补 Docker/npm audit；
6. 让独立 evaluator 跑 Issue #3；
7. 全过才写“验收通过”。
