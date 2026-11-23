# FRAMEWORK-FULL — 六模块的完全态架构

> 这是目标态，不是现状。
> 现状与缺口见 `docs/architecture-audit/FULL-REPO-FINDINGS.md`。
> 本文件只定义“完全态怎么搭、怎么渐进、每一步验收什么”，不把目标写成已完成。

---

## 0. 北极星

> 一个单 owner、可自托管的 MCP 网关：  
> **Web 非代码模式客户端**只用 3 个稳定工具，就能通过可替换执行底座，真实、可靠、低成本地操作多个上游；  
> 用离线评测 + 主动线上评测 + 被动线上评测持续适配客户端和上游，逐步降低主动评测成本；  
> 以免费/低成本载体交付，并具备开源 L1 的完整度。

### 非目标

- 多租户 SaaS；
- 全客户端/全上游；
- 生产级 SLA；
- 替代宿主 Agent/UI；
- 用审批堆安全。

---

## 1. 完全态总图

```text
┌─────────────────────────────────────────────────────────────┐
│ Client Capability Layer                                     │
│  ClientRegistry · ModeResolver · AuthAdapter · Profile      │
│  Onboarding · ApprovalPolicy                                │
└───────────────────────────┬─────────────────────────────────┘
                            │ 3 tools
┌───────────────────────────▼─────────────────────────────────┐
│ Execution Layer                                             │
│  ExecutionRouter · CodeMode · TypedPlan · Native · Hybrid   │
│  ContextBudget · ResultLifecycle · WriteGuard               │
└───────────────────────────┬─────────────────────────────────┘
                            │ tool calls
┌───────────────────────────▼─────────────────────────────────┐
│ State & Isolation Plane                                     │
│  Scope(client/session/project/task/request)                 │
│  GrantBroker · Scheduler · RateLimiter · Quota              │
└───────────────────────────┬─────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────┐
│ Upstream Layer                                              │
│  UpstreamRegistry · ProviderAdapters · Canonical            │
│  WriteTransaction · Health · QuotaOptimizer                 │
└───────────────────────────┬─────────────────────────────────┘
                            │ events
┌───────────────────────────▼─────────────────────────────────┐
│ Evidence & Eval Plane                                       │
│  Capture · TruthStore · Annotation · Replay                 │
│  EvalOrchestrator · Active/Passive · Calibrator             │
└───────────────────────────┬─────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────┐
│ Runtime Layer                                               │
│  RuntimeAdapter(local/tunnel/vercel/docker/free-paas)       │
│  Config · Store · Sink · Health · Deploy · Rollback         │
└───────────────────────────┬─────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────┐
│ Release Layer                                               │
│  Export · Safety · Templates · Governance                   │
└─────────────────────────────────────────────────────────────┘
```

**六个模块不变，四个横切平面补上：**

1. 能力/模式平面：平台 × 模式 × MCP 能力 × 计划；
2. 状态/隔离平面：client/session/project/task/request/grant；
3. 证据/真值平面：capture/annotation/tool-truth/active-passive；
4. 信任/成本平面：auth/sandbox/secret/quota/deploy cost。

---

## 2. 完全态模块定义

### 模块一：Client Capability Layer

目标：不同 Web 客户端只通过 3 个工具接入，客户端差异不进入执行核心。

组件：

- `ClientRegistry`：平台、模式、计划、MCP 能力、已知限制；
- `ModeResolver`：web-non-code / desktop / ide / cli-code；不可靠时 fallback；
- `AuthAdapter`：OAuth/DCR/CIMD/locked/manual；
- `Profile`：tool schema、结果编码、annotations、上下文限制；
- `Onboarding`：首次接入向导（部署→上游授权→客户端连接）；
- `ApprovalPolicy`：客户端权限优先；网关只做代码级闸；
- per-client SOP：接入→测试→优化→评测→回归。

完全态行为：

- 平台按 **模式** 分 lane，不按品牌一刀切；
- Web 非代码模式是主场景，网关承担 Code Mode；
- Code 模式客户端只做兼容，不重复编排；
- 免费/会员权限差异建模为 capability flags；
- 客户端审批设置是权威，annotations 只做诚实声明，不做伪装。

### 模块二：Execution Layer

目标：3 个稳定工具；执行器可替换；上下文/多步/跨上游。

组件：

- `ExecutionRouter`：按 client profile、任务、历史选择执行器；
- `CodeModeAdapter`：自由 JS/QuickJS；
- `TypedPlanAdapter`：类型化 op；
- `NativeAdapter`：宿主原生 tool search/调用；
- `HybridAdapter`：plan 为主，复杂任务 fallback code；
- `ContextBudget`：按客户端/模型/任务分配 token、结果裁剪、截断策略；
- `ResultLifecycle`：raw→canonical→model projection；
- `WriteGuard`：dryRun/approve/原子/回滚。

完全态行为：

- 对客户端永远只有 3 工具；
- 执行器切换不改变工具 schema；需要变更走 `/mcp/v2`；
- 读写分离、写原子、失败无半成品；
- fallback 可观测（reason、次数、成功率）；
- 不做无数据默认切换。

### 模块三：Upstream Layer

目标：多上游真实接入；授权体验第一；结果/写路径可靠。

组件：

- `UpstreamRegistry`：provider、transport、auth mode、SOP；
- `ProviderAdapter`：GitHub/Notion/Linear/Vercel/Figma/未来搜索类；
- `GrantBroker`：owner（gateway-owned / manual static / external-imported legacy）、refresh、static、DCR/CIMD；
- `CanonicalAdapter`：file/PR/issue/action/result；
- `WriteTransaction`：patch/commit/PR/CI/回滚；
- `UpstreamHealth`：tools/list、auth status、quota；
- `QuotaOptimizer`：去重、缓存、查询预算、调用合并。

完全态行为：

- 每个上游有固定 8 步 SOP；
- 网关独立 grant，不共享外部宿主导入的 refresh token；
- 未标记 grant 永不 refresh；
- owner/环境/客户端作用域可审计；
- 首次接入有引导；
- 搜索类 API 不做浪费调用。

### 模块四：Evidence & Eval Plane

目标：证明“能用”，并让主动评测反哺被动评测。

组件：

- `Capture`：full-fidelity envelope + ack/done/dropped；
- `TruthStore`：工具级预期（schema/上游真值/重放/fixture）；
- `Annotation`：expected/actual/intent-free tool truth；
- `Replay`：真实 capture 重放；
- `EvalOrchestrator`：离线官方/权威 + 主动线上 + 被动线上；
- `Calibrator`：同时间窗、主动→被动规则回填；
- `EvalCycle`：每次改动可重复跑；
- `Scorecard`：按客户端/上游/工具/项目分桶。

完全态行为：

- 不评模型思考，只评工具调用/返回/副作用；
- 被动缺任务预期，但有工具级真值；
- 主动 > 被动：主动有预期、能打边界；被动有真实分布；
- 主动发现的新维度倒推被动规则，降低主动频率；
- 没有 requestId 就 unknown；不跨构建硬比；
- 测试绿 ≠ 验收。

### 模块五：Runtime Layer

目标：同一核心跑在多种免费/自托管载体，默认无扣费风险。

组件：

- `RuntimeAdapter`：local/tunnel/vercel/docker/free-paas/server；
- `Config`：env/JSON、fail-fast、无秘密；
- `Store`：KV/Redis/文件；
- `Sink`：file/R2/HTTP；
- `Health`：commit/buildHash、上游 auth status；
- `Deploy`：手动 promote、回滚、部署日志；
- `CostGuard`：免费额度、扣费风险、预算告警。

完全态行为：

- 至少 Vercel + Docker + 本地三种可复现；
- 默认部署不会产生意外费用；
- healthz 能区分网关健康与上游健康；
- 多客户端/多上游并发有调度/背压；
- 回滚有演练。

### 模块六：Release Layer（开源）

目标：L1 usable alpha，不依赖半成品。

组件：

- `Export`：allowlist/denylist/neutralizer；
- `Safety`：secret/handle/path/domain 扫描；
- `Templates`：客户端/上游 onboarding、部署；
- `Docs`：快速开始、限制、兼容矩阵；
- `Governance`：LICENSE/SECURITY/CONTRIBUTING/版本策略；
- `Release`：本地 repo→tag→notes。

完全态行为：

- 干净 clone 可复现；
- 至少一个真实客户端 + 真实上游链路；
- 能力声明有证据；
- 无个人/内部数据；
- 有安全披露与贡献流程。

---

## 3. 完全态数据模型

```text
ClientInstance
  id, platform, mode, plan, capabilities, profile

Grant
  server, owner, source, grantId, environment, scopes, status

Session
  id, clientInstanceId, startedAt, profile, contextBudget

Project
  id (github:owner/repo etc), source

Task
  id, prompt, expectedToolOps, authority, evalMode

Request
  id, sessionId, taskId, clientInstanceId, tool, args, result, timings

ToolCall
  requestId, server, tool, args, canonicalResult, truncated, errorClass

Annotation
  toolCallId, expected, actual, verdict, source(active/passive)

EvalRecord
  evalMode(active/passive/offline), windowId, taskId, metrics
```

关键：**taskId 是一等字段**；active/passive/offline 是 `evalMode`，不是三个孤立系统。

---

## 4. 完全态接口

```text
ClientAdapter
  resolveMode(request) -> {platform, mode, capabilities}
  profile() -> Profile
  encodeTools(tools) -> tools
  encodeResult(result) -> envelope
  onboarding() -> steps

ExecutionRouter
  choose(ctx) -> ExecutionAdapter
  runRead(ctx, input)
  runWrite(ctx, input)
  fallback(reason)

ExecutionAdapter
  tools()
  search(query)
  runRead(code|plan)
  runWrite(code|plan, opts)

GrantBroker
  resolve(server, scope) -> accessToken
  status(server) -> ACTIVE|REAUTH|SHARED_FORBIDDEN
  migrate(owner)

UpstreamAdapter
  connect()
  listTools()
  call(name,args)
  canonicalize()
  health()

Scheduler
  acquire(clientScope, upstream, kind)
  release()
  quota()

Evidence
  capture(event)
  annotate(toolCall, truth)
  replay(session)
  run(mode, taskSet)
  calibrate(active, passive)

RuntimeAdapter
  serve(handler)
  store()
  sink()
  health()
  deploy()
  rollback()

ReleaseAdapter
  export()
  scan()
  package()
  release()
```

---

## 5. 渐进式延伸（S0 → S5）

### S0 现状止血

必须完成：

- 修 G-03（v2 plan IO）、G-04（allow/deny 复核）、G-05（commitSha）、G-07（startCapture options）；
- owner 生产迁移；KV preview/prod 隔离；
- 真实客户端、真实写、授权生命周期；
- 文档 stale/矛盾清理。

验收：ACCEPTANCE A–D 至少过；真实写回环有证据；origin/KV 修复。

### S1 客户端-first

- ClientRegistry + per-platform SOP：Gemini → ChatGPT → Claude；
- ModeResolver 只做保守 fallback，不做万能检测；
- 审批实验 profile（只读不弹、写少弹）；
- Onboarding：部署→上游授权→客户端连接。

验收：Gemini 真实 3 任务；ChatGPT/Claude protocol-ready 或真实 lane。

### S2 执行器可替换

- ExecutionRouter：Code Mode + Typed Plan 真选择；
- Native/Hybrid 最小原型；
- ContextBudget 策略化；
- fallback 可观测。

验收：同任务 A/B；不默认切；v2 路由可用。

### S3 隔离/并发/状态

- Scope：client/session/project/task/request/grant；
- taskId 进 capture；
- 多客户端权限/限流/会话分账；
- 上游并发调度/背压。

验收：两客户端不串 grant/capture；并发压测。

### S4 评测闭环

- TruthStore/Annotation；
- active/passive evalMode 字段；
- 同时间窗对照；
- 主动→被动规则回填；
- baseline/replay 真实化。

验收：主动评测成本下降，被动覆盖率提升，无假 pass。

### S5 运行时/开源

- RuntimeAdapter：Vercel/Docker/本地；
- CostGuard；
- 回滚演练；
- OSS L1：clean clone、模板、治理。

验收：干净环境可复现；开源 L1 门全过。

---

## 6. 完全态验收（不是测试数）

1. 真实 Web 非代码客户端完成多步骤读写；
2. 读正文干净、写原子、失败无半成品；
3. 授权网关独立，不依赖外部宿主导入，重启可用；
4. 多客户端隔离，taskId 可追溯；
5. 主动/被动评测同窗可对照，成本下降；
6. 至少两种运行时无扣费风险可复现；
7. 干净 clone + Docker + 真实链路达到 L1；
8. 文档能力声明与证据一致。

---

## 7. 一句话

> **完全态不是“功能更多”，是：执行底座可替换、客户端按模式适配、上游授权独立、评测能证明、运行多载体、开源可复现；而 3 个工具和读写契约始终不变。**
