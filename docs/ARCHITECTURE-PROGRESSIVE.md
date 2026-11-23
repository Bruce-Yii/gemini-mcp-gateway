# 六模块 · 渐进式披露架构

> 读法：L0 一眼看全貌；L1 看模块边界；L2 看每个模块内部；L3 看跨模块契约与代码落点。
> 原则：**模型只看到 3 个工具；运维只看到模块接口；实现细节按需展开。**
> 本文件只讲架构，不把台账/评测细节塞进主视图。

---

# L0 · 一屏看全

```text
                    ┌──────────────────────────────┐
Web 客户端           │ 1. Client Adaptation         │
(Gemini/ChatGPT/     │    OAuth / profile / encoding│
 Claude)             └──────────────┬───────────────┘
                                    │ 3 tools
                                    ▼
                    ┌──────────────────────────────┐
                    │ 2. Execution Core            │
                    │    3 tools + Code Mode       │
                    │    Typed Plan / fallback     │
                    └──────────────┬───────────────┘
                                    │ tool calls
                                    ▼
                    ┌──────────────────────────────┐
                    │ 3. Upstream Integration      │
                    │    MCP clients / auth /      │
                    │    catalog / canonical       │
                    └──────────────┬───────────────┘
                                    │ events/results
                                    ▼
                    ┌──────────────────────────────┐
                    │ 4. Evidence & Eval           │
                    │    capture / replay / L1 /   │
                    │    official suites / join    │
                    └──────────────┬───────────────┘
                                    │
        ┌───────────────────────────┴───────────────────────────┐
        ▼                                                       ▼
┌──────────────────────────────┐                 ┌──────────────────────────────┐
│ 5. Runtime & Deployment      │                 │ 6. OSS Release               │
│    Vercel / Docker / local   │                 │    export / safety / docs    │
│    KV / R2 / health          │                 │    license / templates       │
└──────────────────────────────┘                 └──────────────────────────────┘
```

一句话：

> **1 让客户端只看见 3 个工具；2 在沙箱里执行；3 连真实上游；4 证明真的能用；5 负责跑起来；6 负责交付给别人。**

---

# L1 · 模块卡片

| # | 模块 | 一句话 | 对外接口 | 不负责 |
|---|---|---|---|---|
| 1 | Client Adaptation | 把不同客户端适配成同一套 3 工具契约 | `ClientAdapter` | 执行、上游连接 |
| 2 | Execution Core | 3 工具 + 可替换执行器 + 沙箱 | `ExecutionAdapter` | OAuth、canvas/UI |
| 3 | Upstream Integration | 连接真实 MCP、授权、canonical、写 | `UpstreamAdapter` | 客户端编码 |
| 4 | Evidence & Eval | 把运行变成证据并回归 | `EvalHarness` | 生产执行 |
| 5 | Runtime & Deployment | HTTP 入口、配置、存储、部署 | `RuntimeAdapter` | 业务编排 |
| 6 | OSS Release | 安全导出、许可证、发布 | `ReleaseAdapter` | 运行时能力 |

### 依赖方向

```text
Client → Execution → Upstream
             │
             └→ Evidence (events)
Runtime 负责组装以上模块
OSS 只读/导出，不反向依赖运行时
```

硬规则：

- 不允许 `Client` 直接依赖 `Upstream`；
- 不允许 `Upstream` 反向依赖 `Client`；
- 不允许 `Evidence` 反向控制执行；
- 不允许 `OSS` 进入核心运行时；
- 跨模块只通过接口/数据，不通过全局状态。

---

# L2 · 模块内部

## 模块 1：Client Adaptation

### 目标

同一套 3 工具，在不同客户端上表现一致；客户端差异只留在这一层。

### 内部渐进层次

```text
L1-1 detect        识别 Gemini / ChatGPT / Claude / unknown
L1-2 profile       工具 schema / structuredContent / annotations / text JSON
L1-3 auth          OAuth / DCR / CIMD / locked client
L1-4 route         /mcp v1 / v2 / 平台隔离
L1-5 encode        结果编码、错误编码、工具面冻结
```

### 输入 / 输出

- 输入：HTTP 请求、headers、OAuth client、UA/host；
- 输出：profile、工具清单、编码后的结果。

### 失败隔离

- 无法识别平台 → `unknown`，走保守 Code Mode；
- 客户端不支持 structuredContent → 退回 text JSON；
- schema 变更 → 版本路径，不原地改。

### 代码落点

`src/oauth.js`、`src/client-platform.js`、`src/client-profile.js`、`src/sanitize.js`、`src/vercel-app.js`、`api/index.js`

### 验收

- Gemini：无 structuredContent、text JSON；
- ChatGPT：structuredContent + text；
- Claude：text + annotations；
- 三工具名/顺序稳定；
- 真实客户端任务（当前未完成）。

---

## 模块 2：Execution Core

### 目标

用 3 个工具完成多步骤执行，且上下文不爆炸；执行器可替换。

### 内部渐进层次

```text
L2-1 tool surface     search / execute_read / execute
L2-2 discovery         BM25、select:<name>、method 枚举
L2-3 sandbox           QuickJS、无 Node/process/fetch
L2-4 executor          Code Mode / Typed Plan / Native / Hybrid
L2-5 result lifecycle  canonical / truncation / profile encode
L2-6 safety            readOnly / dryRun / approve / budget
```

### 执行器接口

```text
ExecutionAdapter
  tools()
  search(query)
  runRead(code|plan)
  runWrite(code|plan, {dryRun, approve})
  fallback(reason)
```

### 选择策略

| 客户端/模型 | 默认 | fallback |
|---|---|---|
| Gemini | Typed Plan | Code Mode |
| 强模型 | Code Mode | Typed Plan |
| 宿主支持 tool search | Native | Code Mode |
| 未知 | Code Mode | 直接工具 |

### 失败隔离

- 沙箱错误 → 结构化错误，不崩溃；
- 预算超限 → `TOOL_CALL_LIMIT_EXCEEDED`；
- 截断读 → 拒绝写；
- 写未批准 → 0 handler 调用；
- fallback 必须可观测 `meta.fallback`。

### 代码落点

`src/codemode.js`、`src/codemode-v2.js`、`src/typed-plan.js`、`src/tool-format.js`、`src/result-normalize.js`、`src/github-helpers.js`、`src/file-write.js`

### 验收

- 真实多步骤任务；
- 上下文不爆；
- 读写分离；
- 写原子；
- 与客户端 profile 兼容。

---

## 模块 3：Upstream Integration

### 目标

把真实 MCP 服务接进来，并保证授权/结果/写路径可靠。

### 内部渐进层次

```text
L3-1 connect      HTTP MCP / Streamable HTTP / 重连
L3-2 auth         grant owner / refresh / static / DCR / CIMD
L3-3 catalog      tools/list、搜索索引、allow/deny
L3-4 call         参数别名、幂等、预算
L3-5 canonical    file/PR/issue/action 结果
L3-6 write        patch/commit/PR/CI/原子/补偿
```

### 接口

```text
UpstreamAdapter
  connect()
  listTools()
  call(name,args)
  canonicalize()
  authStatus()
```

### 失败隔离

- 单上游失败不拖垮整批；
- `invalid_grant` 不重试，标 REAUTH；
- 未标记 grant 不自动 refresh；
- 写失败返回 partial/compensation；
- 上游错误模型可见部分脱敏。

### 代码落点

`src/upstreams.js`、`src/upstream-auth.js`、`src/upstream-oauth.js`、`src/config.js`、`src/store.js`

### 验收

- GitHub 真实只读/写；
- Notion/Linear/Vercel 至少一条真实链路；
- 授权独立；
- 重启不失效；
- 结果与真实形状一致。

---

## 模块 4：Evidence & Eval

### 目标

把“能跑”变成“有证据能证明”，并让在线反馈驱动半在线回归。

### 内部渐进层次

```text
L4-1 capture        full-fidelity envelope / ack/done/dropped
L4-2 join           session / project / task / request
L4-3 online         user feedback intake
L4-4 semi-online    L1/G6 / N-J tasks / replay
L4-5 official       official per-tool suites
L4-6 cycle          eval-cycle / baseline / scorecard
```

### 接口

```text
EvalHarness
  ingestOnline()
  replaySession()
  runL1(profile)
  runOfficialSuites()
  join()
  report()
```

### 证据规则

- 没有 requestId → unknown；
- 不跨构建硬比；
- fake/replay/SKIP ≠ pass；
- 数据不足 → NOT_ENOUGH；
- 客户端宿主问题记 unknown。

### 代码落点

`src/capture.js`、`src/capture-queue.js`、`src/project-tag.js`、`explore/`、`scripts/run-l1-smoke.mjs`、`scripts/replay-online-session.mjs`、`scripts/eval-cycle.mjs`

### 验收

- 官方逐工具覆盖；
- 权威任务；
- 在线反馈回放；
- 同构建对照；
- baseline 可重复。

---

## 模块 5：Runtime & Deployment

### 目标

同一套核心跑在不同载体，且部署可控、可回滚。

### 内部渐进层次

```text
L5-1 http          Node http / Vercel handler
L5-2 config        env / config.json / validation
L5-3 state         KV / Redis / token store
L5-4 capture sink  file / R2 / HTTP
L5-5 health        healthz / buildHash / deploymentId
L5-6 deploy        manual promote / rollback / policy
```

### 接口

```text
RuntimeAdapter
  serve(handler)
  store()
  captureSink()
  health()
  deploy()
```

### 失败隔离

- 配置错误 fail fast；
- KV 不可用降级；
- capture sink 失败不阻塞响应（critical 除外）；
- 部署不自动覆盖生产；
- healthz 不伪装上游健康。

### 代码落点

`src/vercel-app.js`、`src/server.js`、`Dockerfile`、`docker-compose.yml`、`vercel.json`、`scripts/write-build-info.mjs`

### 验收

- Vercel/Docker/本地至少两种；
- healthz/buildHash；
- 部署策略；
- 回滚。

---

## 模块 6：OSS Release

### 目标

把项目安全、可复现地交付给外人。

### 内部渐进层次

```text
L6-1 allowlist     export manifest
L6-2 neutralizer   handle/path/domain
L6-3 safety        secret scan / license / audit
L6-4 docs          README / quickstart / limitations
L6-5 package       Docker / templates / version
L6-6 release       local repo / tag / notes
```

### 接口

```text
ReleaseAdapter
  export()
  check()
  scan()
  package()
  release()
```

### 失败隔离

- 泄露 → 不发布；
- 测试不过 → 不发布；
- 身份不一致 → 不发布；
- 未人工确认 → 不建远端。

### 代码落点

`scripts/export-oss.mjs`、`scripts/prepare-neutral-source.mjs`、`docs/OPEN-SOURCE/`

### 验收

- 干净 clone 可复现；
- 无个人/内部数据；
- license/identity；
- 发布门禁。

---

# L3 · 跨模块契约

## 1. 端到端请求流

```text
HTTP 请求
  → Runtime：鉴权/路由
  → Client：识别平台/profile
  → Execution：3 tools
  → Upstream：调用真实 MCP
  → Execution：canonical/裁剪/编码
  → Client：按 profile 返回
  → Evidence：capture + eval 标签
```

## 2. 数据契约

```text
sessionId      一次会话
project        业务项目（github:owner/repo 等）
taskId         评测/回放任务
requestId      单次请求
toolCall       上游工具调用
result         原始/规范化/模型投影
```

## 3. 安全契约

- client OAuth ≠ upstream grant；
- upstream grant owner 必须明确；
- 不共享 DSH refresh token；
- 模型可见错误脱敏；
- capture full-fidelity；
- 沙箱无 Node/process/fetch；
- 写必须 dryRun/approve/原子。

## 4. 版本契约

- 3 工具名/顺序不变；
- schema 变更走 `/mcp/v2`；
- 执行器可替换但接口不变；
- 结果 canonical 字段稳定；
- capture/eval 标签稳定。

## 5. 扩展点

| 想加什么 | 改哪个模块 |
|---|---|
| 新客户端 | Client Adaptation |
| 新执行器 | Execution Core |
| 新上游 | Upstream Integration |
| 新评测集 | Evidence & Eval |
| 新部署载体 | Runtime |
| 新发布渠道 | OSS Release |

---

# L4 · 代码落点与依赖

```text
api/index.js
  └─ src/vercel-app.js
       ├─ src/oauth.js
       ├─ src/client-platform.js
       ├─ src/client-profile.js
       ├─ src/server.js
       │    ├─ src/codemode.js / codemode-v2.js
       │    ├─ src/typed-plan.js
       │    ├─ src/tool-format.js
       │    └─ src/result-normalize.js
       ├─ src/upstreams.js
       │    ├─ src/upstream-auth.js
       │    ├─ src/upstream-oauth.js
       │    └─ src/store.js
       └─ src/capture.js / capture-queue.js
```

独立支撑：

```text
src/config.js
src/sanitize.js
src/github-helpers.js
src/file-write.js
src/project-tag.js
scripts/* eval/replay/export
tests/*
```

---

# 当前成熟度（不美化）

| 模块 | 状态 |
|---|---|
| Client Adaptation | 部分：profile 有；真实客户端未验收 |
| Execution Core | 较强：3 工具/Code Mode/Typed Plan；真实 A/B 未做 |
| Upstream Integration | 部分：GitHub 真实只读；授权/多上游未验收 |
| Evidence & Eval | 框架强；真实 baseline/replay 不足 |
| Runtime | Vercel 可跑；Docker/npm audit 未验 |
| OSS Release | 本地可审计；未公开 |

---

# 一句话

**六模块负责“系统怎么搭”；渐进式披露负责“每层只暴露该看的接口”；验收负责“证明这套东西真的能用”。**
