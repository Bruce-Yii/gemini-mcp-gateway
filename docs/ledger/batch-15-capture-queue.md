# B15 · 隔离的异步 capture 队列原型（D+C 方向）

> 状态：**原型实现，未接入生产，未 commit / push / deploy**。
> 本次只新增三个文件：`src/capture-queue.js`、`tests/capture-queue.test.js`、本文件。
> **没有改** `src/capture.js`、`src/vercel-app.js`、`src/server.js`、`scripts/`、`README`、其他 tests/docs、workflows。
> 遵循 `docs/ledger/README.md` 的证据规则：本文断言都能回到源码行 / 测试输出 / 已归档台账；免费模型 analyzer 输出不作为依据。
> 方向来源：`docs/ledger/batch-15-capture-latency.md`（D = 关键事件同步、正文异步；C = 外部 collector）。

---

## 0. 交付物

| 文件 | 内容 |
|---|---|
| `src/capture-queue.js` | `CaptureQueue`（内存 ring + 批量 flush + 背压 + 重试退避 + DLQ + 幂等）、`createHttpSink`（注入式 collector HTTP sink）、`CRITICAL_TAGS` |
| `tests/capture-queue.test.js` | 22 个确定性单测（fake scheduler，无墙钟等待） |
| 本文 | 接线方式、风险、明确未做事项 |

**模块自包含**：只依赖 Node core（`node:test`/`node:assert` 仅在测试里）。不 import `capture.js`、不读 env、不读 token、不打印正文。

---

## 1. 实现对照需求

### 1.1 `CaptureQueue`：ring + 批量 flush + 背压

- 内存 ring 是 `this.ring`（`src/capture-queue.js`），按 `maxItems`（默认 256）和 `maxBytes`（默认 4 MiB）双重设限。
- `_enforceBackpressure()`：溢出时**只淘汰最旧的非 critical 条目**，调用 `onDrop(item, 'ring_overflow')`；critical 永不淘汰（全 critical 时 emit `critical_overflow` 事件并允许暂时越界，宁可越界也不丢 P0）。
- 批量 flush：`batchSize`（默认 32）满立即调度；否则 `flushIntervalMs`（默认 250ms）空闲定时器触发。同一批以整体传给注入的 `sink(batch, meta)`。
- 确定性：`scheduler = { now, setTimeout, clearTimeout, sleep }` 可注入；测试用 fake clock 精确验证退避时间（20/40/80ms…）。

### 1.2 sink 注入（fake / HTTP）

- 构造参数 `sink(batch, meta)` 必填，缺失即 `TypeError`（测试覆盖）。
- `createHttpSink({ url, fetchImpl, timeoutMs, headers })` 提供 C 方向的 HTTP collector 实现：
  - **检查 `response.ok`**（这是与旧 `writeHttpSink` 的关键差异，`src/capture.js:330-338` 忽略 status，会把 collector 5xx 当成功——见 batch-15-capture-latency.md §3.3）。
  - `AbortController` 超时（默认 5s，对齐 `src/capture.js:328`）。
  - 测试注入 fake fetch，覆盖成功 202、500（retryable）、400（非 retryable）、abort。

### 1.3 失败重试 + 指数退避 + DLQ

- `_deliverBatch()` 把整批作为一个重试单元；`attempt` 递增并随 `meta` 传给 sink。
- 可重试判定：`408/425/429/500/502/503/504` 或无 status（网络/abort 类错误）；非 retryable（如 400）立即进 DLQ。
- 退避：`delay = min(backoffBaseMs * 2^(attempt-1), backoffMaxMs)`，默认 `50 * 2^(n-1)`，上限 2s；`maxAttempts` 默认 4。
- 重试中的条目用 `inRetry` 标记，防止普通 flush 与重试定时器重复投递同一批。
- 重试耗尽：`onDlq(item, { reason:'max_attempts', attempt, status, requestId })` 逐条回调，并从 ring 移除；`requestId` 保留在 `seen` 中防止重复重投。DLQ 回调失败被吞掉，不抛进调用方。
- `onDrop` 用于 ring 溢出；`onDlq` 用于`sink` 彻底失败——对应设计文档里 `dlq/<day>/<requestId>.json.gz` 前缀（本原型不实际写 R2，由接线方实现）。

### 1.4 requestId 幂等

- `seen` + `inFlight` 两个 Set：入队即登记，成功/丢弃/进 DLQ 后从 `inFlight` 释放但 `seen` 保留（端到端去重）。
- 同一 `requestId` 的 envelope 重复 enqueue 返回 `{ accepted:false, reason:'duplicate' }` 并 emit `duplicate` 事件；测试中同一 id 投递 3 次只落 1 条。
- **critical 例外**：`ack/done/dropped/meta` 是不同审计行，即使同 requestId 也必须全部保留（测试覆盖）。

### 1.5 不丢 P0 小事件

- 分层 API：`pushCritical(tag, payload)`（tag ∈ `CRITICAL_TAGS = ['ack','done','dropped','meta']`）+ `pushEnvelope(requestId, envelope)`。
- 自动识别：`criticalTagOf()` 识别 `tag:'ack'|'done'|'dropped'|'meta'`、`capture_ack`/`capture_done.v1`/`capture_dropped`/`capture_meta` 等历史 tag，以及 `critical:true`；识别为 critical 的条目进入优先通道。
- 优先通道行为：critical 入队时取消挂起的空闲定时器并用 `queueMicrotask` 合并同 tick 的多个 critical（例如 ack + done）为一个优先批次；flush 循环里 `filter(lane==='critical')` 永远排在 envelope 前面。
- 背压淘汰 `findIndex(e => e.lane !== 'critical')` 明确排除 critical——测试验证 maxItems 与 maxBytes 两种溢出下 P0 均存活。

### 1.6 不打印 token / 正文

- `onEvent` 事件只含 `{ type, at, requestId, lane, tag, bytes, depth, attempt, status, retryable, size, delayMs, errorKind, ... }`——**不含 item/envelope/raw/error.message**。
- 原始错误文本可能夹带 token/body，因此 `flush_failed` 只 emit `error.name`（`errorKind`），不 emit `error.message`（源码注释与测试均有说明）。
- `onDrop` / `onDlq` 回调按设计接收完整 item（它们是**持久化 sink**，例如写 DLQ 对象，不是日志）；测试明确只断言 `onEvent` 流无敏感信息。
- `createHttpSink` 的请求体只作为 HTTP payload 发送，不进入任何日志。

### 1.7 flush 失败不阻塞 MCP 响应（除非 critical）

- `enqueue()` / `pushEnvelope()` / `pushCritical()` 均为**同步返回**，内部 `queueMicrotask` + fire-and-forget `Promise.catch`，不 await sink。
- sink 延迟测试：sink 被 gate 卡住时 `enqueue` 立即返回，MCP 调用方无需等待。
- critical 仅表示**投递优先级**（先于 envelope 被 flush），本原型同样不 await sink；生产接线时若要同步落 P0（D 方向要求），应在 `capture.js` 侧用现有同步写/日志完成，而不是在队列里 await（见 §2.1）。

---

## 2. 与现有 CAPTURE_SYNC / R2 的接线方式（仅设计，本次未做）

### 2.1 接线点

`src/capture.js:523-619` 的 `res.end` 是唯一 sink 入队点；`CAPTURE_SYNC=1` 时 `:591-599` 让 `originalEnd` 等 `task.finally(finish)`，即等 `writeSink`（R2 PUT，`:344-370`，15s abort），这是 452ms 延迟来源（batch-15-capture-latency.md §1.2，requestId `602f4012-8776-465d-8bb3-d9507ef2bd90`）。

未来接线（**本原型不改这些文件**）：

```
res.end（capture.js）
  ├─ P0: [capture_ack]/[capture_done]/[capture_dropped] 同步 console.log（现状保留）
  │      + 可选同步写小 ack 对象 ack/<day>/<requestId>.json
  │      → 本原型的 pushCritical('ack'|'done'|'dropped', {...})
  └─ P1: envelope → queue.pushEnvelope(requestId, envelope)
           └─ sink = createHttpSink({ url: CAPTURE_COLLECTOR_URL })
                └─ collector 批量写 R2: capture/<day>/<requestId>.json.gz（key 不变）
                   失败 → onDlq → dlq/<day>/<requestId>.json.gz（同 bucket 新前缀）
```

- **生产默认仍保持 `CAPTURE_SYNC=1`**（batch-15-capture-latency.md §1.1 / §6 的硬约束：Vercel 冻结会让裸 `waitUntil` 丢数据且无 dropped）。切换到异步队列前必须先真实验证 collector 持久化能力。
- 队列的 `flush()`/`drain()` 应由 collector 侧的 runtime waitUntil / Docker 进程生命周期持有；Vercel 侧不能直接把 ring 当持久化层（进程冻结即丢）。
- R2 key `capture/<day>/<requestId>.json.gz` 不改（`docs/OBSERVABILITY-AND-EVAL.md` 与 analyzer 依赖，batch-15-capture-latency.md §6）。

### 2.2 与 batch-15-capture-latency.md 设计文档的对应

| 设计文档条目 | 原型对应 |
|---|---|
| §2 B（内存 ring + 批量 flush） | `CaptureQueue` ring + batchSize/flushIntervalMs |
| §2 D（关键同步、正文异步） | `pushCritical` 优先通道 / `pushEnvelope` 异步通道 |
| §3.2 消息结构（attempt/enqueuedAt/deadlineAt） | `entry.attempt` / `entry.enqueuedAt` 已具备；`deadlineAt` 由接线方的 DLQ 策略实现（原型只按 maxAttempts） |
| §3.3 指数退避 / DLQ | `_deliverBatch` + `onDlq` |
| §3.3 collector 429 背压 | 429 视为 retryable；真实 collector 超阈值返回 429 时本原型会退避重试，接线方需在重试耗尽后记 dropped |
| §3.3 P0 不丢形式化 | 测试证明 critical 不被背压淘汰；对账（`queued \ R2` 差集）属 collector/离线任务职责 |
| §5.1 测试项 | burst 200 / sink 延迟 / 500 / 429 / abort / 重复 / 顺序 / 背压 / DLQ / P0 不丢 / 确定性——全部覆盖 |

---

## 3. 测试结果

命令：`node --test tests/capture-queue.test.js`（原型单测）与 `npm test`（全量）。

原型 22/22 通过。覆盖清单：

| 场景 | 断言要点 |
|---|---|
| burst 200 | 200 条全部送达，无重复，≥7 批（batchSize=32） |
| sink 延迟 | 入队同步返回，gate 未释放时调用方不阻塞 |
| 500 | 重试 3 次（attempt 1→2→3），退避 20/40ms 精确 |
| 429 | retryable；耗尽后 DLQ，attempt=3 |
| abort | 无 status 的 reject 按 retryable 处理，耗尽进 DLQ |
| 重复 | 同 requestId 3 次只交付 1 条，duplicate 计数 2 |
| 顺序 | 批次内保持 enqueue 顺序 |
| 背压 | maxItems 淘汰最旧 envelope；maxBytes 同理；critical 均存活 |
| DLQ | 400 非 retryable 立即 DLQ；重试耗尽也 DLQ |
| critical 不丢 | 优先批次先于 envelope；同 id 的 ack/done 均保留 |
| 确定性 | 相同输入两次运行 snapshot / calls / events 完全一致 |
| 无泄漏 | `onEvent` 流不含 token / 正文 / 原始错误文本 |
| HTTP sink | 注入 fetch：202 成功、500 retryable、400 非 retryable、abort |

全量 `npm test` 由 lead / 本 agent 执行，结果记录在本文 §5。

---

## 4. 风险与限制（原型态）

1. **进程内 ring 不持久化**：Vercel 冻结会丢未 flush 的 envelope，且本原型的 `onDrop` 只在溢出时触发，冻结时不会自动产生 `capture_dropped`。因此**不能单独替代生产 `CAPTURE_SYNC=1`**；`batch-15-capture-latency.md §1.1` 的事故约束仍然有效。
2. **整批重试**：一批失败时整批重投，依赖 sink 端幂等（R2 固定 key + requestId 去重）；若 collector 不是幂等的会产生重复。当前设计文档规定固定 key，符合前提。
3. **背压丢弃是数据丢失**：`ring_overflow` 只调用 `onDrop` 回调，不自动补写 DLQ；接线方必须在 `onDrop` 里落 dropped 记录或触发离线重投，否则 `R+dropped===A` 判据会破。
4. **DLQ 回调接收完整 item**：若接线方把 `onDlq` 误接到日志而不是对象存储，会把正文/token 打进日志；这是接线责任，原型已用测试和注释明确边界。
5. **`deadlineAt` 未实现**：原型按 `maxAttempts` 终止，没有设计文档 §3.2 的 10 分钟 deadline；长尾重试需接线方补充。
6. **无并发多 sink / 分片**：单 sink、单 ring；高吞吐场景需多实例分片或外部 Queue（设计文档 §2 C 的可选项）。
7. **`close()` 语义**：只停止接收新项，不取消已排队重试；`drain()` 有 timeout 但不当取消在途 sink。
8. **不接 `waitUntil` 适配层**：`src/runtime/waitUntil.js` 与设计文档 §4.1 的三 runtime 适配均属后续独立工单，本原型不假设任何 runtime。

---

## 5. 验收证据

- 原型单测：`node --test tests/capture-queue.test.js` → `tests 22 / pass 22 / fail 0`。
- 全量回归：`npm test` → `tests 1200 / pass 1194 / fail 0 / skipped 0 / todo 6 / duration 16.16s`（含本原型 22 个新测试；6 个 todo 为仓库既有，见 full 输出 `[oauth-error]` 等既有测试日志）。基线见 `docs/ledger/README.md` B11.6 642/642。
- 文件范围：`git status --short` 应只显示本任务新增的三个文件（其他 agent 的并发改动属于其他任务，不在本次范围）。
- 未执行任何 commit / push / deploy。

---

## 6. 明确未做

- 不改 `src/capture.js` / `src/vercel-app.js` / `src/server.js` 任何一行（包括 `CAPTURE_SYNC` 默认值、`gzipSync`、`waitUntil` import）。
- 不写 R2 / collector Worker / Cloudflare Queue / Upstash List 的真实实现；只提供可注入的 sink 接口与 fake/HTTP 两种测试用实现。
- 不改 R2 key 格式、不新增 npm 依赖、不新增付费服务、不读凭据、不碰 vault。
- 不实现 `src/runtime/waitUntil.js`（设计文档 §4.1 的后续工单）。
- 不改 `docs/ledger/batch-15-capture-latency.md` 的任何结论（它是本原型的设计依据）。
- 不 commit / push / deploy。
