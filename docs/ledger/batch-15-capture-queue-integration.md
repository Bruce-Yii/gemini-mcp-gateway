# B15 · 异步 capture 队列接入 capture.js（默认关闭 flag）

> 状态：**已实现，未 commit / push / deploy**。
> 本任务只写三个文件：`src/capture.js`（修改）、`tests/capture-queue-integration.test.js`（新增）、本文（新增）。
> **没有改** `src/capture-queue.js`、`src/vercel-app.js`、`src/server.js`、`scripts/`、`README`、其他 tests/docs、workflows。
> 设计依据：`docs/ledger/batch-15-capture-latency.md`（D 方向：P0 同步、正文异步）、`docs/ledger/batch-15-capture-queue.md`（原型接口与约束）。
> 证据规则遵循 `docs/ledger/README.md`：结论都能回到源码行与测试输出；免费模型 analyzer 输出不作为依据。

---

## 0. 交付物与接线范围

| 文件 | 改动 |
|---|---|
| `src/capture.js` | 新增 `CAPTURE_ASYNC_QUEUE=1` opt-in 分支：critical 保留原同步日志路径；envelope 正文交给 `CaptureQueue` 异步 flush；新增队列 sink / DLQ / drop 处理与配置项 |
| `tests/capture-queue-integration.test.js` | 9 个确定性集成测试（fake sink / fake scheduler，无网络） |
| 本文 | 接线语义、互斥优先级、兼容性、风险与验收证据 |

`src/capture-queue.js` 本身零改动（原型接口直接复用：`CaptureQueue`、`pushEnvelope`、`pushCritical`、`drain()`、`onDrop`/`onDlq`/`onEvent`）。

---

## 1. 需求逐条对应

### 1.1 `CAPTURE_ASYNC_QUEUE=1` 才启用，默认关闭逐字不变

- `configFromOptions()`（`src/capture.js`）读取 `options.asyncQueue ?? env.CAPTURE_ASYNC_QUEUE === '1'`。只有字符串 `'1'` 或显式 option 为 true 才开启。
- 默认（flag off）时：`sync` 的计算表达式与旧版完全一致（`options.sync ?? env.CAPTURE_SYNC === '1'`）；`res.end` 中新增的 `if (cfg.asyncQueue)` 分支不进入，后续 `onSinkError` / `task` / `cfg.sync` / `waitUntil(task)` / `finish()` 代码逐字保留。
- 新增的 `[capture_queue_mode]` 日志与 `capture_flush_end.asyncQueue` 字段仅在 flag on 时发出；flag off 的日志字段集合不变。
- 测试证据：`flag OFF: CAPTURE_SYNC=1 still blocks originalEnd on the sink and writes once`、`flag OFF: queue options are inert and the legacy waitUntil path is unchanged`。

### 1.2 critical 同步、正文异步、响应不被 sink 阻塞

- critical（`capture_ack` / `capture_done` / `capture_dropped` / meta）：继续走现有同步 `log()` 路径。`capture_ack` 在 startCapture 顶部同步发出；`capture_done` 在 `res.end` 里 `originalEnd` 之前同步发出；失败时 `[capture_dropped]` 由队列回调同步 `console.error` 发出（schema 仍是 `gmg.capture_dropped.v1`）。
- envelope 正文：`queue.pushEnvelope(requestId, envelope)` 入队即返回；`CaptureQueue` 内部 `queueMicrotask` + fire-and-forget flush，sink 慢/失败都不 await。
- `res.end` 在入队后直接 `originalEnd(chunk, encoding, callback)`；`waitUntil(queue.drain().catch(...))` 只是尽力延长 runtime 生命周期，不阻塞响应。
- 测试证据：`flag ON: gated sink does not delay res.end; ack/done stay synchronous`——gate 未释放时 `res.ended === true`、响应字节完整、sink 调用数为 0，而 ack/done 已同步落日志。

### 1.3 sink 失败重试 / DLQ

- 队列 batch sink = `makeQueueBatchSink(cfg)`，逐条复用 `writeSink(cfg, envelope)`（file/http/console/r2），因此 R2 PUT 仍用 `gzipSync` 与固定 key。
- sink throw / `{ok:false}` 由 `CaptureQueue._deliverBatch` 处理：`408/425/429/5xx/abort` 可重试，指数退避；耗尽后触发 `onDlq`。
- capture.js 的 `onDlq`：`droppedCount += 1` + `[capture_dropped]` 日志 +（R2 sink 时）写 `dlq/<day>/<requestId>.json.gz`；其他 sink 走 `postFallback`。`onDrop`（ring 溢出）同样发 `capture_dropped`。
- 注入队列（`options.captureQueue`）时 capture.js 会挂上自己的 reconciliation handlers（只挂一次），避免测试/调用方绕过 dropped 对账。
- 测试证据：`flag ON: HTTP 500 is retried by the queue and eventually delivered`（第 1、2 次 500，第 3 次成功，`retries >= 2`）；`flag ON: sink failure leaves critical logs intact and emits capture_dropped`（重试耗尽 → `dlq >= 1`、`captureFailureStats().dropped + 1`、控制台出现 `[capture_dropped]` 与 `gmg.capture_dropped.v1`）。

### 1.4 与 CAPTURE_SYNC 互斥 / 优先级明确

- `configFromOptions()` 中 `asyncQueue` 为 true 时强制 `sync = false`，并记录 `syncRequested` 原始值。
- `res.end` 的 async 分支在 legacy `task` 创建之前 return，因此**不会**再调用 `writeSink`，绝无重复 sync 写；关闭 flag 时回退旧逻辑（含 `CAPTURE_SYNC=1` 的 `task.finally(finish)`）。
- 日志显式声明：`[capture_queue_mode] { asyncQueue:true, syncRequested, syncEffective:false }`；`[capture_done] { asyncQueue:true, sync:false, syncOverride:true }`（当 `CAPTURE_SYNC` 也被设置）。
- 测试证据：`flag ON with CAPTURE_SYNC=1: sync override is explicit and only one write path runs`——legacy fetch 注入为“一调用就 throw”，实际零调用，队列 sink 恰好收到 1 条。

### 1.5 requestId 幂等 / capture_dropped / R2 key + envelope 兼容

- `startCapture` 原有的 `req.__gatewayCaptureStarted` guard 保留；队列侧 `pushEnvelope` 按 requestId 去重（同一 requestId 第二条返回 `reason:'duplicate'`）。
- envelope 对象本身在 async 分支创建的代码与 legacy 分支完全共用（schema `gmg.capture.v1`、字段集合、`buildModelOutputAudit`、`extractProjects` 等都不变）。
- batch sink 复用 `writeSink`，R2 PUT 的 key `capture/<day>/<requestId>.json.gz`、gzip body、header 完全不变；DLQ 仅换前缀 `dlq/`。
- 测试证据：`flag ON: queue sink keeps R2 key, gzip payload and envelope schema`（envelope 字段与 requestId 原样到达 sink）；`flag ON: duplicate requestId enqueues only one envelope`（两条 envelope 只交付 1 条，同时同 id 的 2 条 critical 全部保留，两个请求各自的同步 ack 仍各 1 条）。

### 1.6 配置面（全部可选，不读新凭据）

| 环境变量 | 默认 | 用途 |
|---|---|---|
| `CAPTURE_ASYNC_QUEUE` | `0` | 唯一总开关，只有 `'1'` 开启 |
| `CAPTURE_QUEUE_MAX_ITEMS` | `256` | ring 条目上限 |
| `CAPTURE_QUEUE_MAX_BYTES` | `4194304` | ring 字节上限 |
| `CAPTURE_QUEUE_BATCH_SIZE` | `32` | 批量 flush 大小 |
| `CAPTURE_QUEUE_FLUSH_MS` | `250` | idle flush 间隔 |
| `CAPTURE_QUEUE_MAX_ATTEMPTS` | `4` | 重试总次数 |
| `CAPTURE_QUEUE_BACKOFF_MS` / `CAPTURE_QUEUE_BACKOFF_MAX_MS` | `50` / `2000` | 退避基数 / 上限 |

测试可通过 `options.asyncQueue / queueSink / queueScheduler / queueMax* / captureQueue` 注入；生产路径使用模块内按配置签名缓存的单例 queue（同一进程内多请求才能合批）。

---

## 2. 测试结果

### 2.1 集成测试（本任务新增）

命令：`node --test tests/capture-queue-integration.test.js`
结果：**tests 9 / pass 9 / fail 0 / duration ≈ 0.4s**。覆盖：

| 场景 | 断言要点 |
|---|---|
| flag off + `CAPTURE_SYNC=1` | `originalEnd` 仍等 sink；只写一次；无 queue 日志 |
| flag off + queue options 注入 | 全部 inert；legacy waitUntil 路径、日志形状不变 |
| flag on + gated sink | `res.end` 同 tick 返回；ack/done 同步；sink 未调用；gate 释放后 flush |
| flag on + `CAPTURE_SYNC=1` | syncOverride 日志；legacy sink 零调用；队列仅 1 次写 |
| 响应字节不变 | 同一 fixture 下 flag on/off 的 `Buffer.concat(res.body)` 完全一致 |
| sink 失败 | critical 日志仍在；`capture_dropped` + `gmg.capture_dropped.v1` 出现；DLQ 计数 ≥1 |
| sink 500 重试 | 两次 500 后第三次成功；`retries >= 2`；envelope/requestId 原样 |
| R2 兼容 | envelope schema / requestId / request.raw / response.raw 原样到达 sink；key 格式断言 |
| 重复 requestId | 两条 envelope 只交付 1 条；同 id 的 ack/done 仍全部接受 |

### 2.2 全量回归

命令：`npm test`（与其他 agent 并发运行）
最近一次结果：**tests 1224 / pass 1212 / fail 6 / todo 6**，6 个失败全部来自其他 agent 并发改动的文件：
- `tests/real-gh-replay.test.js`：3 个 PR #53/#56/#57 相关断言
- `tests/typed-plan-engine.test.js`：3 个 approve/unknown-field 相关断言

**本文件的 9 个用例在全量运行中全部通过**（失败列表不含 `capture-queue-integration.test.js`）。并发影响只报告到此，不修改他人文件。

---

## 3. 风险与限制

1. **进程内 ring 不持久化**：Vercel 冻结会丢未 flush 的正文；与 `batch-15-capture-latency.md §1.1` 事故约束相同。因此本 flag 默认关闭，生产切到异步队列前需先验证 collector / runtime 生命周期（不能仅靠本 flag 替代 `CAPTURE_SYNC=1` 的数据可信性）。
2. **`waitUntil` 尽力而为**：本地/非 Vercel runtime 下 `@vercel/functions.waitUntil` 是 no-op；Promise 仍会跑，但进程退出前未 flush 的队列内容不保证落盘。
3. **整批重试**：batch 内某条失败会导致整批重投，依赖 sink 幂等（R2 固定 key + requestId 去重）——这是原型既有前提。
4. **DLQ 语义**：R2 sink 的 DLQ 写同 bucket 的 `dlq/` 前缀；其他 sink 只有 `[capture_dropped]` 日志（与 legacy 失败语义一致）+ 可选 fallback POST。
5. **单例队列缓存**：按配置签名缓存，进程内共享；若同一进程需要多独立队列请用 `options.captureQueue` 注入。

---

## 4. 明确未做

- 不改 `src/capture-queue.js` / `src/vercel-app.js` / `src/server.js` 任何一行。
- 不改 `CAPTURE_SYNC` 的默认值；不把默认切到异步队列。
- 不实现 `src/runtime/waitUntil.js` 三 runtime 适配层；不实现外部 collector Worker/Queue。
- 不改 R2 key 格式、envelope schema、MCP 响应字节、任何既有日志 tag 语义。
- 不新增 npm 依赖、不读凭据、不碰 vault。
- 不 commit / push / deploy。
