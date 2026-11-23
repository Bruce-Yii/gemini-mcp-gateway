- 总纲/用户原文：[FRAMEWORK.md](FRAMEWORK.md)

- 渐进式披露版本：[ARCHITECTURE-PROGRESSIVE.md](ARCHITECTURE-PROGRESSIVE.md)

# Architecture breakdown — gemini-mcp-gateway

> 按产品目标拆框架、架构、模块。
> 一句话：**面向 Web MCP 客户端的上下文/多步执行网关；Code Mode 是核心底座，但不是唯一执行器；评测体系负责把“目标客户端适配”变成可证明的工程。**

---

## 1. 框架层：产品价值链

```text
目标客户端（Gemini / ChatGPT / Claude / 未来免费平台）
        │  只暴露 3 个稳定工具
        ▼
┌─────────────────────────────────────────────┐
│  Client Adaptation Layer                    │
│  OAuth / profile / encoding / limits        │
└─────────────────────────────────────────────┘
        ▼
┌─────────────────────────────────────────────┐
│  Execution Core（可替换底座）                │
│  Code Mode / Typed Plan / Native / Hybrid   │
│  search / execute_read / execute            │
└─────────────────────────────────────────────┘
        ▼
┌─────────────────────────────────────────────┐
│  Upstream Integration                       │
│  GitHub / Notion / Linear / Vercel / Figma  │
│  auth / grant / catalog / canonical result  │
└─────────────────────────────────────────────┘
        ▼
┌─────────────────────────────────────────────┐
│  Evidence & Eval                            │
│  capture / online feedback / semi-online    │
│  official suites / authoritative tasks      │
└─────────────────────────────────────────────┘
        ▼
┌─────────────────────────────────────────────┐
│  Runtime & Release                          │
│  local+tunnel / Vercel / Docker / free PaaS │
│  OSS export / safety / license              │
└─────────────────────────────────────────────┘
```

### 产品边界

- 单 owner、单租户；
- 不做多租户隔离；
- 不试图替代宿主 UI；
- 不承诺所有客户端所有能力；
- 目标客户端优先 Gemini，但不是唯一目标。

### 核心不变量

1. 对外永远 3 个工具：`search` / `execute_read` / `execute`；
2. 工具 schema 会话中途不变（Gemini 不消费 `list_changed`）；
3. 读通道不可写；写通道必须 dryRun/approve/原子；
4. 文件 `content` 纯正文；notice/SHA 只放元数据；
5. PR `number` URL 优先，id 永不兜底；
6. 无静默截断，截断必须带字段级元数据；
7. 网关授权独立，不共享 DSH rotating refresh token；
8. capture full-fidelity，模型可见错误脱敏；
9. 失败不能留半成品；
10. 测试绿 ≠ 验收。

---

## 2. 架构层：六层 + 五个接口

### L1 Client Adaptation Layer

职责：

- OAuth / DCR / CIMD / locked client；
- 平台识别（Gemini / ChatGPT / Claude / unknown）；
- client profile：tools schema、structuredContent、annotations、text JSON；
- 工具面冻结与版本（`/mcp` vs `/mcp/v2`）；
- 客户端限制：计划、上下文、工具名解析、UI 截断。

接口：

```text
ClientAdapter
  detect(request)
  resolveProfile()
  encodeTools()
  encodeResult()
  capabilities()
```

模块：

- `src/oauth.js`
- `src/client-platform.js`
- `src/client-profile.js`
- `src/sanitize.js`
- `src/vercel-app.js`
- `api/index.js`

### L2 Execution Core（可替换）

职责：

- 维护 3 个稳定工具；
- `search`：BM25/标识符检索、`select:<name>`、方法枚举；
- `execute_read`：只读沙箱；
- `execute`：读写沙箱、dryRun/approve、原子写；
- 执行器选择：Code Mode / Typed Plan / Native / Hybrid；
- 预算、超时、错误分类、fallback。

接口：

```text
ExecutionAdapter
  tools()
  search(query)
  runRead(code|plan)
  runWrite(code|plan, opts)
  fallback(reason)
```

模块：

- `src/codemode.js`
- `src/codemode-v2.js`
- `src/typed-plan.js`
- `src/tool-format.js`
- `src/result-normalize.js`
- `src/github-helpers.js`
- `src/file-write.js`

> Code Mode 是默认底座，但执行器可替换：
> 强模型/复杂任务用 Code Mode；Gemini/简单任务用 Typed Plan；
> 宿主原生 tool search 可用时用 Native；按 profile 做 Hybrid。

### L3 Upstream Integration

职责：

- MCP server 连接/重连；
- 工具目录与索引；
- 授权/grant owner/refresh；
- 参数别名（branch→ref）；
- 结果 canonical 化；
- 写语义/原子提交/补偿。

接口：

```text
UpstreamAdapter
  connect()
  listTools()
  call(name,args)
  canonicalize()
  authStatus()
```

模块：

- `src/upstreams.js`
- `src/upstream-auth.js`
- `src/upstream-oauth.js`
- `src/config.js`
- `src/store.js`
- `config.example.json`

### L4 Evidence & Eval

职责：

- full-fidelity capture；
- session/project/task/request 关联；
- 在线反馈 intake；
- 半在线 L1/G6/replay；
- 官方测试集 + 权威任务集；
- 在线/半在线互补 join；
- 逐工具覆盖率、失败分类、scorecard；
- 持续 eval cycle。

接口：

```text
EvalHarness
  ingestOnline()
  replaySession()
  runL1(profile)
  runOfficialSuites()
  join()
  report()
```

模块：

- `src/capture.js`
- `src/capture-queue.js`
- `src/project-tag.js`
- `explore/`
- `scripts/run-l1-smoke.mjs`
- `scripts/replay-online-session.mjs`
- `scripts/eval-cycle.mjs`
- `docs/eval/`

### L5 Runtime & Deployment

职责：

- 本地 / 内网穿透 / Vercel / Docker / 免费 PaaS；
- 环境变量、KV/Redis、R2 capture；
- 健康检查、构建信息、版本；
- 部署策略：不频繁、手动 promote、可回滚。

接口：

```text
RuntimeAdapter
  serve(http)
  store()
  captureSink()
  health()
  deploy()
```

模块：

- `src/vercel-app.js`
- `src/server.js`
- `Dockerfile`
- `docker-compose.yml`
- `vercel.json`
- `scripts/write-build-info.mjs`

### L6 OSS Release（支撑层）

职责：

- allowlist export；
- 身份/路径/个人数据清理；
- 许可证、README、模板；
- 本地 release repo；
- 发布门禁。

模块：

- `scripts/export-oss.mjs`
- `scripts/prepare-neutral-source.mjs`
- `docs/OPEN-SOURCE/`
- `work/oss-release-*`

> OSS 是支撑，不是核心目标；但公开前必须过安全/身份/测试门禁。

---

## 3. 模块拆解与依赖

```text
api/index.js
  └─ src/vercel-app.js
       ├─ src/oauth.js
       ├─ src/client-platform.js
       ├─ src/client-profile.js
       ├─ src/server.js
       │    ├─ src/codemode*.js
       │    ├─ src/typed-plan.js
       │    └─ src/tool-format.js
       ├─ src/upstreams.js
       │    ├─ src/upstream-auth.js
       │    ├─ src/upstream-oauth.js
       │    └─ src/store.js
       └─ src/capture*.js

独立：
  src/config.js
  src/sanitize.js
  src/result-normalize.js
  src/github-helpers.js
  src/file-write.js
  src/project-tag.js
```

| 模块 | 责任 | 不应承担 |
|---|---|---|
| `client-*` | 客户端差异 | 业务编排 |
| `codemode*` | 执行 | OAuth/上游生命周期 |
| `typed-plan` | 类型化编排 | 直接 MCP tool 注册 |
| `upstream*` | 连接/auth/canonical | 客户端编码 |
| `capture*` | 证据 | 质量判定 |
| `eval/scripts` | 评测 | 生产执行 |
| OSS scripts | 发布 | 运行时 |

---

## 4. 评测架构（重点）

### 4.1 四条证据线

```text
A. 官方测试集/逐工具契约
   → 每个上游工具：参数、返回、边界、错误

B. 权威任务集（L1/G6）
   → 真实任务：读、搜索、跨服务、写、PR、失败恢复

C. 在线反馈
   → 真实客户端窗口：requestId、症状、PR、截图

D. 半在线 replay
   → capture 重放：同 prompt/args/profile
```

### 4.2 在线 ↔ 半在线互补

```text
在线发现新维度
  → F 矩阵
  → G1–G6 缺口
  → N/J 任务
  → 确定性测试
  → 旧/新构建同任务
  → 部署后在线复验
```

### 4.3 交叉模型

```text
sessionId × project × taskId × requestId × tool × clientPlatform
```

用途：

- 同一 session 内的多步执行；
- 同一 project 的跨会话回归；
- online feedback 回放到 task；
- 失败根因归因；
- 按平台/项目/工具计算覆盖率。

### 4.4 评测不做什么

- 不把测试数当验收；
- 不把 fake/fixture 当真实；
- 不跨构建硬比；
- 不把客户端宿主问题算网关 pass/fail；
- 不自动切默认。

---

## 5. 执行器适配矩阵

| 客户端/模型 | 默认执行器 | fallback |
|---|---|---|
| Gemini web | Typed Plan 优先 | Code Mode |
| ChatGPT 强模型 | Code Mode | Typed Plan |
| Claude | Code Mode / Native | Typed Plan |
| 未知客户端 | Code Mode（保守） | 直接工具 |
| 宿主支持 tool search | Native | Code Mode |

> 执行器选择是 **profile/capability** 的函数，不是全局唯一实现。

---

## 6. 部署适配

| 载体 | 适合 | 约束 |
|---|---|---|
| 本地 + 内网穿透 | 调试/真实客户端测试 | 机器常开、URL 变 |
| Vercel | 生产参考 | 函数时长、部署配额、KV |
| Docker | 自托管/免费服务器 | 需自己运维 |
| 免费 PaaS | 多平台选择 | 需 adapter、CPU/长任务限制 |
| Cloudflare Tunnel | 临时验证 | 非生产托管 |

原则：

- 运行时适配层隔离；
- 不把 Vercel 特有 API 漏进核心；
- 部署手动、可回滚、有 healthz/buildHash。

---

## 7. 当前模块成熟度

| 模块 | 状态 |
|---|---|
| Client adaptation | 部分：Gemini/ChatGPT profile、Claude callback；origin/真实客户端未验收 |
| Execution core | 较强：3 工具、Code Mode、Typed Plan v2 flag、写语义；真实 A/B 未做 |
| Upstream | 部分：GitHub 真实只读通过；Notion/Linear/Vercel 授权未验收 |
| Evidence/eval | 框架较强；真实 capture/replay/baseline 不足 |
| Runtime | Vercel 可跑；Docker/npm audit 未验 |
| OSS | 本地产物可审计；未公开 |

---

## 8. 最高优先级缺口

1. 真实客户端任务（Gemini 浏览器）；
2. 真实写回环（一次性测试仓库）；
3. 网关独立授权（owner 标记 + 真实 tools/list）；
4. 入站 origin 一致（issuer/resource/CIMD）；
5. preview/production KV 隔离；
6. 官方逐工具测试集接入；
7. 在线/半在线 baseline 与 replay 真实化；
8. 部署控制与验收证据。

---

## 9. 一句话总结

**产品核心是“3 个工具 + 可替换执行器 + 干净读写 + 网关独立授权”；评测体系是证明它真的能用的证据链；部署和 OSS 是载体，不是目标。**
