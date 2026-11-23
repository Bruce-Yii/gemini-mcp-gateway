# Batch 11 · W6-A：持久状态 / 断点恢复（设计，不改代码）

> 状态：**设计方案，未实现**。本文只把 PLAN-2026-11-23 §3 P1「持久状态/断点」、§5 W6 的
> 「外部状态存储 + 任务 checkpoint + 幂等 key」落成可执行方案。
> **本次不改** `src/`、`scripts/`、`tests/`、`README`、其他 docs、workflows；**未 commit / push / deploy**。
> 证据规则遵循 `docs/ledger/README.md`：所有现状断言都能回到具体源码行/文档/requestId；免费模型输出只作 advisory。

## 一、现状证据（为什么需要）

### 1. Vercel 无状态 + 实例冻结已经造成过真实事故
- `src/figma-guard.js:11-13` 文件注释明确：所有 guard 状态 per-process；serverless 每个 warm
  实例各自一份，cold start 清零，**无共享 KV/Redis 协调**。
- `docs/ledger/batch-11-recent.md` §1：capture 曾把 envelope 构建 + `waitUntil` 放进 `res.end` 的
  `queueMicrotask`，Vercel 在 `res.end` 后冻结实例，microtask/sink 不跑；修调度顺序后
  `originalEnd` 仍先于 `waitUntil`，最终必须 `CAPTURE_SYNC=1` 同步落盘（+0.4–0.5s）。
  **这条事故证明：任何"进程内、res.end 之后、依赖后台任务继续跑"的长流程在 Vercel 都不可靠。**
- `docs/eval/capture-verification-2026-11-23.md` requestId `3f19584b…`、`af0c3eb0…`、`602f4012…`
  是同步落盘后才可对账；`docs/PLAN-2026-11-23.md` §2.1 判据 `A===D`、`R+dropped===A`。

### 2. 传输层也是 stateless，session 只是标记不是状态
- `docs/ledger/batch-11-recent.md` §3：`initialize` 生成 `Mcp-Session-Id` 响应头，capture 记录
  `sessionId` + `clientInfo`，但**transport 仍 stateless，不引入服务端 session 状态**；
  requestId `641ffd4f-8c40-462e-8938-b7b11d9d595f` 实测。
- `docs/ledger/mcp-2026-07-compat.md`：SDK 1.32.2 只支持 2025-11-25 legacy；2026-07-28 协议
  本身也全 stateless。**不能指望协议层提供恢复语义。**

### 3. 写流程已有原语，但"重跑"仍会重复建分支/PR
- `src/store.js`：Upstash Redis REST（fetch POST，零新依赖）**已经上线**用于 OAuth client/code/token。
  已有原语可直接复用：
  - `compareAndSet(key, expected, next)` — EVAL GET+SET  fencing（`:100-106`）；
  - `casToken(...)` — 按 refresh_token 做 fencing（`:113-123`）；
  - `takeCode/takeOAuthState` — GETDEL 一次性消费（`:229-238`、`:248-257`）；
  - TTL 表 `TTL`（`:17-22`）、key 前缀 `gmcgw:v1`（`:14`）、`_commandBody`/`_command` 两种调用方式。
- `docs/ledger/batch-10-idempotent.md`：`ensureBranch` / `upsertPr` 已是**幂等原语**
  （reuse/update/reused 语义），但这是 host 侧纯模块，**未接 codemode，且没有跨请求持久状态**——
  实例重启后不知道"这个 branch/PR 是不是我上次建的"，只能靠上游再查一遍。
- `docs/ledger/batch-11-write-transaction.md`：`writeFiles` 用 `github__push_files` 做一次提交；
  失败时返回 `written[]/remaining[]/compensation`，**但没有把补偿清单持久化**——
  模型/实例一掉，这份清单就丢了。
- `docs/ledger/batch-11-session-clustering.md`：离线只能靠 `windowId`/`sessionId` 聚类 + 显式
  `taskId` join，**没有 taskId 埋点则 unmatched，绝不硬凑**。持久 checkpoint 应顺带补这个锚点。

### 4. 有 R2 capture 但它是"事后审计"，不是"事中状态"
- `docs/OBSERVABILITY-AND-EVAL.md`：全量 capture（HTTP/MCP/上游帧/sandbox/config）→ R2；
  扇出 sink。`CAPTURE_SYNC=1` 让响应等 R2 写完。
- 结论：R2 适合**只追加的审计日志**，不适合"读-改-写、CAS、TTL、一次性消费"的 checkpoint；
  且同步写 R2 有 +0.4–0.5s 代价，不应在每次工具调用都做。

## 二、方案（选型 + 契约）

### 2.1 选型决策：复用现有 Upstash Redis REST，不引入 Postgres

| 候选 | 结论 | 理由（基于证据） |
|---|---|---|
| **Upstash Redis REST（现有 TokenStore 实例）** | ✅ **选它** | `src/store.js` 已在生产、已配 `KV_REST_API_URL/TOKEN`、已实现 CAS/GETDEL/TTL；零新依赖、零新凭据、零新 vendored SDK。checkpoint 需要的所有原语（原子写、一次性领取、过期）都已存在。 |
| Postgres（Neon/Supabase/Vercel PG） | ❌ 不做（本批） | 需要新连接管理/连接池（serverless 冷启动）、新依赖、新凭据与新迁移流程；checkpoint 是短生命周期 kv，不是关系型查询；收益不足以付运维成本。若未来要"按 task 多维查询/报表"，再评估。 |
| 纯 R2 / Vercel KV 文件 | ❌ 不做 | R2 无 CAS/TTL/GETDEL，且同步写有延迟代价；只能做日志，不能做协调状态。 |
| Vercel KV（新实例） | ❌ 不做 | 与现有 Upstash 是同一 REST 协议，再开一个实例只是多一份凭据/账单；直接扩展现有实例。 |

**决策**：新建 `CheckpointStore`（与 `TokenStore` 并列、共用 `src/store.js` 的 fetch 传输与
key 前缀），或作为 `TokenStore` 的新 namespace 方法族。**不新增 npm 依赖，不改 OAuth 现有 key。**

### 2.2 Key 命名与命名空间

沿用 `KEY_PREFIX = 'gmcgw:v1'`（`src/store.js:14`），新增命名空间，避免与 OAuth 冲突：

```
gmcgw:v1:ckpt:<taskId>            -> checkpoint JSON（含 TTL）
gmcgw:v1:idem:<idempotencyKey>    -> 已完成结果指针（含 TTL）
gmcgw:v1:cklock:<taskId>          -> 运行租约（SET NX EX，短 TTL）
gmcgw:v1:ckptIndex:<sessionId>    -> 该 session 下 taskId 集合（SET，供 join/恢复列举）
```

- `taskId`：显式由调用方/L1 runner 提供（对齐 `batch-11-session-clustering.md` 的 `taskId` 锚点）；
  没有显式 taskId 的请求**不建 checkpoint**（不猜、不按时间硬凑）。
- `sessionId`：`Mcp-Session-Id`（已落 capture），用于索引与 join，不用于鉴权。
- `idempotencyKey`：见 §2.4。

### 2.3 Checkpoint schema（JSON，版本化）

```jsonc
{
  "schema": 1,                       // 版本号，破坏性变更 +1；读取方不认识则视为不兼容，不猜
  "taskId": "T042",
  "sessionId": "641ffd4f-...",       // 可为 null；null 时不建 ckptIndex
  "requestId": "602f4012-...",       // 当前步骤的 HTTP 请求锚点（可与 capture 对账）
  "status": "running|succeeded|failed|compensating",
  "phase": "discover|patch|write|pr|done",  // 粗粒度阶段，恢复时从这里续
  "steps": [
    {
      "name": "ensureBranch",
      "idempotencyKey": "sha256:...",
      "state": "pending|done|failed",
      "resultRef": "idem:<hash>",   // 大结果不内联，存指针
      "at": "2026-11-23T...Z"
    }
  ],
  "compensation": [                  // 来自 batch-11-write-transaction 的 written[]/compensation
    { "op": "deleteFile", "path": "..." }
  ],
  "partial": false,                  // 是否留下半成品（对齐 write-transaction 契约）
  "createdAt": "2026-11-23T...Z",
  "updatedAt": "2026-11-23T...Z",
  "leaseUntil": 1795...              // 毫秒时间戳；与 cklock 对齐，用于判断"是否还在跑"
}
```

**不存**：token / 上游凭据 / 用户明文 secret（沿用 store.js 安全约束：只存 hash 指针），
不存完整大结果（只存 `resultRef`），不存仅对单次进程有意义的内存对象。

### 2.4 幂等 key（决定"重跑会不会双建"）

```
idempotencyKey = sha256(
  taskId + "|" + toolName + "|" + stableStringify(normalizedArgs) + "|" + schemaVersion
)
```

- `stableStringify` 复用 `src/figma-guard.js:73-78` 的 key 排序做法（避免参数顺序造成不同 key）。
- `normalizedArgs` 必须是 `normalizeToolArguments` **之后**的实参（`src/upstreams.js:393-394` 的既有路径），
  否则 camelCase 别名会让同一调用算出两个 key。
- 语义：**同一 idempotencyKey 重跑 → 直接返回首次成功结果指针，不再调用上游写工具。**
  这是 `ensureBranch/upsertPr` 幂等原语之外的第二层保护（跨进程、跨重启）。
- `idem:` 记录用 `SET NX EX`（不存在才写 + TTL），返回首次写入者胜出；超时（如写操作 > TTL）
  由租约续期处理，见 §2.5。

### 2.5 恢复边界（明确"能恢复什么、不能恢复什么"）

| 时刻 | 行为 |
|---|---|
| 任务开始 | 有 taskId → 建 `ckpt:<taskId>`（status=running, phase=discover）+ 申请 `cklock` 租约 + 加入 `ckptIndex:<sessionId>`。 |
| 每个写步骤前 | 写 `steps[].idempotencyKey`（状态 pending），**先持久化再调用上游**。 |
| 写步骤成功 | CAS 更新 step=done + 存 `idem:` 结果指针；更新 `phase`/`updatedAt`/续租约。 |
| 实例冻结/崩溃 | 租约 `cklock` 到期（短 TTL）后，重跑方用 `SET NX` 拿到租约 → 读 checkpoint → 从 `phase` 续跑；已 done 的步骤命中 `idem:` 直接跳过，**不重复建分支/PR**。 |
| `compensation` 非空 | 恢复先进入 `status=compensating`，按清单补偿或提示用户；**不自动假设"上次没写成功"**。 |
| 终态 | status=succeeded/failed 写入后设较长 TTL（如 7d）供对账；到期自动清。 |

**恢复边界硬限制**：
1. 只能恢复到**步骤边界**，不能恢复"一次 `execute` 脚本执行到一半"——QuickJS 沙箱
   （`src/codemode.js`）是单次工具调用，模型写代码本身不是可持久化的状态机。恢复单位是
   `task` → `phase` → `写步骤`，不是 JS 指令。
2. 只能恢复**有显式 taskId 的调用**。在线已发生的 Gemini 请求大多没有 taskId
   （`batch-11-session-clustering.md`：无 taskId → unmatched），因此它们**不享受断点续跑**；
   要覆盖需先做 taskId 埋点（§四依赖）。
3. 上游"写在中途但 checkpoint 未落盘"的极窄窗口（写完上游、CAS 前崩溃）：靠 `ensureBranch/upsertPr`
   的上游幂等查询兜底，**不保证 100% 无副作用**，只能保证"重跑不产生第二个分支/PR"。
4. **不做进程内缓存作为恢复源**：capture 事故已证明 Vercel 会冻结实例，`src/figma-guard.js`
   的 per-process 状态不可信。

### 2.6 最小实现（明确口径）

只新增一个 host 侧模块（建议 `src/checkpoint.js`，本次不写），API 与 `TokenStore` 同风格：

| 方法 | 语义 | 原语来源 |
|---|---|---|
| `begin(taskId, sessionId, requestId)` | SET NX 建租约 + 写 running checkpoint + 索引 | `_command('set', ..., 'NX','EX',lease)` |
| `load(taskId)` | 读 checkpoint；校验 `schema`；不认识则抛不兼容错误 | `_get`-风格 |
| `saveStep(taskId, step, idemKey)` | CAS 写 steps/phase（fencing） | `compareAndSet` |
| `takeIdem(key)` / `putIdem(key, resultRef, ttl)` | GETDEL 一次性领取 / SET NX EX 首次写入 | `takeCode` / `_put` |
| `acquireLease(taskId, ownerId)` | SET NX EX；成功者获得恢复权 | `_command` |
| `renewLease(taskId, ownerId)` | fencing CAS，仅 owner 可续 | `casToken` 模式 |
| `finish(taskId, status, resultRef)` | 终态 + 长 TTL；释放租约 | `compareAndSet` + DEL |

**接入点（本次只设计不接）**：`src/server.js`（request 生命周期 begin/finish）、
`src/upstreams.js:callTool`（写步骤 idempotencyKey）、`src/file-write.js` / `src/github-helpers.js`
（compensation 持久化）。这些都是后续独立工单，需各自定义写范围与测试。

## 三、收益 / 风险

### 收益
- 长流程跨实例/冷启动可续，消除 Vercel 冻结导致的"任务凭空消失"（§一.1 同类问题）。
- 重跑不重复建分支/PR：在 `ensureBranch/upsertPr` 上游幂等之上加一层跨进程幂等门。
- 补偿清单不丢：`batch-11-write-transaction.md` 的 `written[]/compensation` 从"进程内返回值"
  变成"可恢复状态"。
- taskId 锚点顺带打通在线 capture ↔ 离线 join（`batch-11-session-clustering.md` 的未决项）。
- 零新依赖/凭据：完全复用 `src/store.js` 已上线的 Upstash 连接。

### 风险（逐条带缓解）
| 风险 | 缓解 |
|---|---|
| Redis 不可用 → 所有任务因 checkpoint 失败而卡死 | checkpoint 写失败走**降级**：不阻断主流程，记录 `checkpointDegraded` 到 capture，任务继续但不享受恢复（可用≠必须）。 |
| 幂等 TTL 设为 24h 内 done、长流程超过 TTL | TTL 按步骤类型设定；写步骤 completion 的 idem TTL ≥ 租约 ×N；大流程续期；到期的幂等记录丢失靠上游幂等兜底。 |
| 租约过期但旧 owner 还在跑（fencing 失效） | 每个写步骤前 `renewLease` + CAS；CAS 失败（已被新 owner 接管）立即放弃，不写上游。 |
| checkpoint 里 sessionId/taskId 被伪造 | sessionId/taskId 只用于状态定位，不用于鉴权；鉴权仍走现有 OAuth (`src/oauth.js`)。 |
| Upstash 单实例延迟给每次调用加一次网络往返 | 只在**写步骤/阶段边界**读写 checkpoint（不是每次工具调用），读步骤不落状态；快路径开销可控。 |
| schema 演进导致旧 checkpoint 读错 | `schema` 版本号 + 不兼容即显式失败，不静默按旧结构续跑。 |
| 免费模型 analyzer 拿到 checkpoint 当"事实" | 遵循 AGENTS.md：advisory-only，回到 requestId 回放 + 人审。 |

## 四、依赖与顺序

1. **已有（可立即用）**：`src/store.js` Upstash REST + CAS/GETDEL/TTL；`KV_REST_API_URL/TOKEN`
   已在 Vercel 配置；`Mcp-Session-Id` 已落 capture（B11.3）；`ensureBranch/upsertPr` 幂等
   （B10）；`github__push_files` 原子写 + compensation（B11.6）。
2. **前置（必须先做）**：taskId 埋点（在线 capture 记录显式 taskId）——否则在线请求无法建 checkpoint；
   这是 `batch-11-session-clustering.md` 已列的未决依赖。
3. **并行关系**：与 W4（自适应 Code Mode）、W7（维护性）可并行；与 W2 写路径已闭环无阻塞。
4. **后续独立工单**：`src/checkpoint.js` 模块 + 测试 → server/upstreams 接入 → 真实 kill-and-resume
   演练 → 才谈上线。**本批只交付设计。**

## 五、验收（实现时的门控，非本次）

- 单元：`begin/load/saveStep/takeIdem/putIdem/acquireLease/renewLease/finish` 全路径 + fake Redis
  （无真实网络），含 CAS 冲突、租约过期、schema 不兼容、Redis 降级分支。
- 幂等证明：同一 taskId 重跑写流程，**上游 createBranch/createPr 调用次数不增加**（用 fake upstream 计数断言）。
- 恢复证明：在 phase=write 后强制换 owner（模拟冷启动），从 checkpoint 续跑，`compensation`
  清单被正确处理，不重复写、不丢半成品提示。
- 对账：checkpoint 的 `requestId` 能在 R2 capture 按 requestId 取到（对齐 `A===D`/`R+dropped===A`）。
- 全量：`npm test` 保持全绿（当前基线见 `docs/ledger/README.md` B11.6 642/642）；CI Node 20/22/24。
- 线上（后续）：用真实 Gemini 会话 + 显式 taskId 做一次 kill-and-resume，capture 有完整 envelope。

## 六、明确不做（本批与可预见范围）

- 不写任何代码、不改 `src/store.js` 的 OAuth 逻辑与 key。
- 不引入 Postgres / 新 npm 依赖 / 新环境变量 / 新凭据。
- 不实现 MCP 2026 MRTR/tasks/durable session（`docs/ledger/mcp-2026-07-compat.md`：客户端仍 legacy）。
- 不把 QuickJS 脚本本身变成可恢复状态机（只恢复步骤边界）。
- 不自动补偿"上游已写但 checkpoint 未落"的极窄窗口；只保证重跑不双建。
- 不替代 R2 capture：capture 继续做审计日志，checkpoint 只做事中协调状态。
- 不做 per-user 配额/多租户状态（单用户自建场景）。
- 不在本次 commit / push / deploy。
