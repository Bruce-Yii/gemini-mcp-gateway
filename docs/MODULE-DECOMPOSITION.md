# MODULE DECOMPOSITION — 架构到可并行工作包

> **定位（云端总控收口）**：本文件专职 **L2 组件 → L3 可并行工作包** 拆解与派发（写作用域、接口、依赖 DAG、验收）；高层全景与六模块目录见唯一主入口 [ARCHITECTURE-INDEX.md](ARCHITECTURE-INDEX.md)。

> 架构不是一张图，是一套**坐标系**：
> 大模块 → 子模块 → 组件 → 数据/接口 → 工作包。
> 有了坐标系，抽象的东西可以落位，小东西可以具象化，多个 agent 可以按接口并行。

---

## 0. 分解方法

```text
L0 模块（六模块）
  → L1 子模块（能力边界）
    → L2 组件（可独立设计/测试）
      → L3 工作包（可分配给一个 agent）
        → 文件/接口/测试/验收
```

每个工作包必须有：

- 所属模块/子模块；
- 输入/输出接口；
- 依赖；
- 写作用域（文件）；
- 验收（测试/真实证据）；
- 状态（设计/代码/测试/真实/未做）。

---

## 1. 六模块 L1 分解

### 1. Client

```text
1.1 Registry        平台/模式/计划/能力
1.2 Mode             web-non-code / desktop / ide / cli-code
1.3 AuthAdapter      OAuth / DCR（默认关、仅显式 carve-out）/ CIMD / locked / manual / 审批口令
1.4 Profile          schema / 编码 / annotations / 上下文限制
1.5 Onboarding       部署→上游授权→客户端连接
1.6 Approval        客户端权限优先；annotations 策略
```

### 2. Execution

```text
2.1 Router           按客户端/任务选执行器
2.2 CodeMode         自由 JS
2.3 TypedPlan        类型化 op
2.4 Native           宿主原生
2.5 Hybrid           plan + code fallback
2.6 ContextBudget    截断/摘要/结果预算
2.7 ResultLifecycle  raw→canonical→model
2.8 WriteGuard       dryRun/approve/原子/回滚
```

### 3. Upstream

```text
3.1 Registry         provider/transport/auth/SOP
3.2 ProviderAdapter  GitHub/Notion/Linear/Vercel/Figma/搜索类
3.3 GrantBroker      owner/refresh/static PAT/DCR/CIMD/入站审批
3.4 Canonical        file/PR/issue/action
3.5 WriteTransaction patch/commit/PR/CI/回滚
3.6 Health           tools/list/auth/quota
3.7 QuotaOptimizer   去重/缓存/查询预算/调用合并
```

### 4. Evidence & Eval

```text
4.1 Offline          官方/权威任务集
4.2 ActiveOnline     主动提问/标注
4.3 PassiveOnline    采集/归一/分析
4.4 Link             主动↔被动关联
4.5 Calibration      主动反哺被动
4.6 Orchestrator     eval-cycle/baseline/scorecard
```

### 5. Runtime

```text
5.1 Adapter          local/tunnel/vercel/docker/free-paas/server
5.2 Config           env/JSON/校验
5.3 Store            KV/Redis/file
5.4 Sink             file/R2/HTTP
5.5 Health           gateway/upstream/build
5.6 Deploy           manual promote/rollback/log
5.7 CostGuard        free quota/扣费风险
```

### 6. Release

```text
6.1 Export           allowlist/denylist/中立化
6.2 Safety           secret/handle/path/domain
6.3 Templates        client/upstream/deploy onboarding
6.4 Docs             quickstart/limits/matrix
6.5 Governance       license/security/contributing/version
6.6 Release          local repo/tag/notes
```

---

## 2. 深挖示例：评测体系（4）

### 4.1 Offline Benchmark

| 组件 | 输入 | 输出 | 当前 |
|---|---|---|---|
| 官方逐工具采集 | 厂商文档/schema | 工具契约任务 | 部分 |
| 权威任务集 | 人工/来源 | task bundle | 有 N/J/G6 |
| Runner | task set | pass/fail/metrics | L1 fake |
| Baseline | runner 结果 | 冻结基线 | 仅 l1-smoke |

### 4.2 Active Online

| 组件 | 输入 | 输出 | 当前 |
|---|---|---|---|
| active-eval record | 用户原话/时间/平台/项目 | `active-eval.v1` | 设计 |
| task fingerprint | prompt + expectedTools | hash | 设计 |
| label/expected | 人工判断 | tool-level truth | 设计 |
| active task promotion | 主动失败 | 新任务 | 人工 |

### 4.3 Passive Online

```text
4.3.1 Capture Producer
  请求/结果事件 → full-fidelity envelope
4.3.2 Sink/Queue
  file/R2/HTTP + async queue + backpressure
4.3.3 Normalize/Join
  session/project/request/task/call 归一
4.3.4 Analysis
  规则/契约/异常/截断/写后校验
  免费模型只做 advisory hypothesis
4.3.5 Active-Passive Link
  时间窗/平台/项目/工具序列/taskId
4.3.6 Rule Feedback
  主动标签 → 被动检查器 → 盲区/误报统计
```

| 组件 | 接口 | 状态 |
|---|---|---|
| capture | `capture(event)` | 有 full-fidelity；taskId 缺失 |
| sink | `sink.write()` | R2/file/HTTP；同步默认 |
| join | `join(session, project, task, request)` | session/project 有；taskId 无 |
| analyzer | `analyze(capture)` | 免费模型 advisory，非结论 |
| link | `link(activeEval, capture)` | 设计，未实现 |
| calibrator | `compare(active, passive)` | 设计，未实现 |

### 4.4 Calibration

```text
主动标签
  → 被动规则 precision/recall
  → 误报/漏报
  → 主动频率/成本
  → 是否达到“被动逼近主动”
```

### 4.5 Orchestrator

```text
eval-cycle:
  offline + active sample + passive scan
  → report
  → baseline compare
  → optimization backlog
```

### 4.6 评测数据模型

```text
taskId / evalMode(active|passive|offline)
truth(tool-level expected)
annotation(expected/actual/verdict)
link(activeEvalId, passiveRequestIds, match, confidence)
```

---

## 3. 工作包拆分（可并行）

### Eval 示例

| WP | 内容 | 依赖 | 写作用域（建议） |
|---|---|---|---|
| E1 | active-eval.v1 记录 | 无 | `docs/eval`、`scripts/record-active-eval` |
| E2 | capture 补 taskId/clientMode | E1 | `src/evidence/capture*` |
| E3 | active-passive link | E1/E2 | `scripts/link-active-passive` |
| E4 | 被动规则/检查器 | E2 | `src/evidence/eval-*` |
| E5 | calibration 指标 | E3/E4 | `scripts/eval-calibrate` |
| E6 | baseline/scorecard | E5 | `explore/baselines`、`scripts/eval-cycle` |
| E7 | 官方逐工具覆盖 | 无 | `explore/tasks-official`、docs |

并行前提：

- E1/E2 先定 schema；
- E3/E4 可并行，但都依赖 schema；
- E5/E6 依赖 E3/E4；
- 每个 WP 只写自己作用域；
- 接口先用 JSON schema 冻结。

### 其他模块并行示例

| 模块 | 可并行 WP |
|---|---|
| Client | registry / mode / auth / profile / onboarding / approval |
| Execution | router / codemode / typedplan / native/hybrid / context / writeguard |
| Upstream | provider adapters / grant / canonical / write / health / quota |
| Runtime | adapter / config / store / sink / health / deploy / cost |
| Release | export / safety / templates / docs / governance |

### Upstream / Auth 工作包（2026-11-25 活跃，按依赖排序）

> 背景：PR #29 已把 Linear 切到 `static_bearer` PAT（`/mcp/readonly` + `LINEAR_API_KEY`）、Notion 切回网关自有 OAuth/DCR（`owner=gateway`），生产 `f2002d9`；
> PR #26 已加入站审批口令。以下四个工作包承接剩余漂移，**A1 未完成前不能宣称 Notion 可用**。

| WP | 内容 | 依赖 | 写作用域（建议） | 状态 / 验收 |
|---|---|---|---|---|
| **A1 Pack 2 · Notion runtime 注入** | 无 `tokenEnv` 的网关自有 OAuth 上游也要从 KV grant 解 token 并注入 `Authorization`（修 `_resolveToken()` 无 `tokenEnv` 提前 return、`_createTransport()` 只在有 `tokenEnv` 时取 token） | PR #29 已合入生产 | `src/upstream/upstreams.js`、`tests/upstreams.test.js` | PR #31（`fix/notion-gateway-oauth-token`，`9e7c57c`）OPEN、**未合并**；验收：冷启动 `codemode.services()` 中 notion online、`search('notion')` 非空 |
| **A2 授权生命周期观测 + 旧凭据清理** | 先 8h（至少跨一次自动 refresh）再 72h 无 `invalid_grant`；通过后移除旧 DSH Notion 连接、旧 `NOTION_*`/`LINEAR_*` refresh env，并轮换暴露过的 Linear PAT | A1 部署 + 生产稳定 | 运维/KV/env（无仓库代码）；记录 `docs/DEPLOYMENTS.md`、`docs/ledger/` | 未开始；当前**禁止**删除/轮换（会打断观测并可能吊销 Notion grant）；条件见 [AUTH-READY.md](AUTH-READY.md) §1.6、§1.9 |
| **A3 Issue #15 剩余契约毛刺** | ① `normalizeMerge` 顶层 `number`/`url` 恒 `null`（BC-011）：补参（如 `pullNumber`）或明确返回契约；② `writeFiles` 误传 `files`/默认 dryRun 时静默成功（BC-012）：入参校验显式报错或兼容 `files` | 无（PR #22 已修 Issue #15 的 #1 `issue_write` number 与 #3 40KB 截断假阳性） | `src/execution/result-normalize.js`、`src/execution/file-write.js`、`src/execution/codemode.js` + `tests/` | 未开始；验收：确定性测试 + Gemini 真实窗口复验；公共层按 AGENTS.md §3.2 需第二客户端防串伤回归 |
| **A4 Issue #27 统一 Client Registry** | 预注册 Client Registry 替代生产 DCR：`client:create/list/rotate/revoke` CLI、authorize/token 读 Registry、`/oauth/register` 默认 403、Gemini/ChatGPT/Claude 迁移、自托管/开源只保留一条接入路径 | A1/A2 完成后再动 OAuth 核心；入站口令已就绪（PR #26） | `src/client/oauth.js`、`src/shared/store.js`、`scripts/`（新 CLI）、`docs/OPEN-SOURCE/` | 未开始；**M6 开源前必须**（P0 = Registry + CLI + authorize/token 读 Registry；P1 = ChatGPT cutover + 删除 DCR compat + 文档/CI 校验） |

---

## 4. 架构 → 并行开发的规则

1. **先冻结接口，再并行实现**；
2. 每个 WP 一个 owner、一个写作用域；
3. 跨模块只通过接口/事件，不共享内部状态；
4. 依赖用 DAG，不用“感觉先后”；
5. 每个 WP 必须有验收（测试/真实证据）；
6. 架构变化先改 `FRAMEWORK` / 本文，再改代码；
7. 不在架构未定时开大并行。

---

## 5. 一句话

> **架构是坐标系：大模块定位方向，子模块划定边界，组件定义接口，工作包分配给 agent；这样抽象能落地，细小能具象，开发能并行。**
