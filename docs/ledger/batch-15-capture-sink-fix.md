# B15 · Capture 已证实小 bug 修复（HTTP sink status / mcp_latency_ms）

> 状态：**已实现，未 commit / push / deploy**。
> 仅改 `src/capture.js`，新增 `tests/capture-sink-fix.test.js` 与本文件。
> 不做 `batch-15-capture-latency.md` 中的 D+C 架构重写；`CAPTURE_SYNC` 默认值、R2 key、
> `src/vercel-app.js` / `src/server.js` / `scripts/` / 其他 tests / README / workflows 均未改。

## 0. 范围与依据

`docs/ledger/batch-15-capture-latency.md` §2/§3 给出了两处可由源码直接证实的小 bug，
且明确要求“先检查 status，否则 collector 5xx 会被当成成功”（§3.3.1）以及
“`mcp_latency_ms` 必须在 `originalEnd` 真正调用处打点，否则会漏掉同步等待”（§1.3 / §1.2）。
本工单只修这两处及其可测性，不落地 collector / ring / P0 meta 分层。

**证据锚点**（均来自该台账）：

| 断言 | 原文位置 |
|---|---|
| `writeHttpSink` 忽略 status（非 2xx 当成功） | `batch-15-capture-latency.md:312-313` |
| sync 模式 `capture_done.duration` 在 sink 完成前记录，不含 sink | 同上 `:96-99`、`:593-596` |
| `mcp_latency_ms` 应在 `originalEnd` 处打点 | 同上 `:115, 124-126` |
| 实测 sink 452ms / 总 1049ms（requestId `602f4012-...`） | 同上 `:13-15, 86-99` |
| 硬约束：不许通过关 `CAPTURE_SYNC` “修复” | 同上 `:18-19, 445-446` |

## 1. 代码改动（仅 `src/capture.js`）

### 1.1 HTTP sink 必须检查 2xx

- 新增 `isOkSinkResponse(response)`：仅当 `response.ok !== false` **且** `status` 是数值且
  `200 <= status < 300` 才算成功。同时检查 `ok` 与 `status`，使轻量 fetch double
  （只给 `status`、不给 `ok`）不能把 500/429 误判为成功；真实 `Response` 的 `ok` 语义不变。
- `writeHttpSink` 改为注入式 `cfg.fetchImpl`（与 `writeR2Sink` 一致，便于 fake sink 延迟注入），
  拿到响应后若非 2xx 则 `throw new Error('HTTP capture sink failed: status <n>')`：
  - 错误沿 `.then(() => log('capture_sink_ok')).catch(onSinkError)` 传播 →
    记 `[capture_dropped]`、`droppedCount += 1`、触发现有 `postFallback`，**不会产生
    `capture_sink_ok` 日志**，可被重试/对账系统消费；
  - 错误信息**只含 status code**，不读、不记录响应 body（collector/fallback 的 body 可能回显 token）；
  - 请求头的 `authorization: Bearer <token>` 仍只出现在发往 sink 的请求里，不进任何日志。
- 204 视为成功（`response.ok === true`，status 2xx）；200 成功；500 / 429 失败；
  传输层 abort/抛错仍按原路径失败。

### 1.2 `mcp_latency_ms` 在真正响应结束点打点

- `res.end` 入口记录 `endEnteredAt`；新增 `finish()` 包住 `originalEnd(chunk, encoding, callback)`，
  在调用前取 `endAt = Date.now()`、`mcpLatencyMs = endAt - started`，并用 `try/finally`
  在 `originalEnd` 执行后同步输出新日志：

  ```
  [capture_flush_end] {requestId, path, method, status, mode, sink, sync,
                       duration, waitedMs, mcp_latency_ms, endAt}
  ```

- 语义：
  - **sync 模式**：`task.finally(finish)` 在 sink settle 后才调用 `finish()`，因此
    `mcp_latency_ms` / `waitedMs` 包含 sink 等待（测试用 120ms fake 延迟验证）；
  - **async 模式**：`finish()` 紧随 `waitUntil(task)` 同步调用，延迟近似 0，不含 sink；
  - `waitedMs = endAt - endEnteredAt` 即“响应结束路径上的等待时长”，用于直接量化 sink 阻塞。
- **兼容性**：`capture_done.duration`（`:535` 采样、`:593-596`/`:608-617` 输出）一行未改，
  仍是“sync task 完成前的时长”，旧字段语义与现有断言保持不变；
  `mcp_latency_ms` 只作为 `[capture_flush_end]` 的独立新字段出现，不改 envelope schema、
  R2 key、响应字节。
- sync 分支把 `task.finally(finish)` 改为 `task.finally(finish).catch(() => {})`，
  仅防止 `originalEnd` 抛错变成未处理 Promise rejection；`res.end` 在该分支的返回值仍是
  `undefined`，行为不变。
- 幂等/重试：`finished` guard 保留；第二次 `res.end` 直接走 `originalEnd`，不再构造 envelope、
  不再排队 sink task，因此 abort / 重试路径不会重复写。

## 2. 新增测试（`tests/capture-sink-fix.test.js`，11 个用例）

| 用例 | 断言 |
|---|---|
| HTTP 200 / 204 | 恰好 1 次 POST、1 条 `capture_sink_ok`、0 drop |
| HTTP 500 / 429 | 0 条 `capture_sink_ok`、drop 计数 +1、`[capture_dropped]` 出现；body 中的 token 不出现在任何日志；错误含 `status 500/429` |
| abort / 传输错误 | 无 `sink_ok`、drop +1、只写一次 |
| sync 模式（120ms fake sink 延迟） | 返回前 `res.ended === false`；`waitedMs >= 100`；`mcp_latency_ms >= duration + 120 - 30`；`duration` 保持旧语义 |
| async 模式（同延迟） | `res.end` 立即结束；`mcp_latency_ms < 120`、`waitedMs < 120` |
| 默认 `CAPTURE_SYNC` 未设 | 仍为 async/非阻塞（`sync:false`） |
| abort 后重试（重复 `startCapture` + 重复 `res.end`） | sink 只 POST 一次；ack/done/flush 各一次；drop +1；响应字节 `part-1part-2retried` 完整 |
| sync 模式失败后重试 | sink 只写一次、done/flush 各一次 |
| 响应字节不变 | capture on/off 对 `Buffer` + `Uint8Array` 分块逐字节相同 |

所有测试用 `options.log` / `fetchImpl` 注入与 `captureFailureStats()` 增量断言，不依赖固定
sleep 作为唯一同步手段（`settle()` 轮询 + 短宽限），以适应全量并发负载。

## 3. 验收

- `node --test tests/capture-sink-fix.test.js`：**11/11 通过**。
- `npm test`（全量，**最终复跑**）：**1098 tests / 1092 pass / 0 fail / 6 todo**（18.6s）。
  `tests/capture.test.js` 与 `tests/capture-completeness.test.js` 全部通过；该文件未被本工单修改
  （`git status --short -- tests/capture.test.js` 为空）。工作区内其他并发代理改动
  （`src/vercel-app.js` 等）的测试同样通过。
- 未 commit、未 push、未 deploy；未修改 `package.json`；未新增依赖；未改 R2 key。

## 4. 明确不做

- 不实现 D+C：不新增 collector / ring / `runtimeWaitUntil` / P0 meta / DLQ / `capture_queued`。
- 不把 `CAPTURE_SYNC` 默认值改成 `'0'`；生产应急回滚开关语义不变。
- 不改 envelope schema 与 `capture/<day>/<requestId>.json.gz` key。
- 不改 `src/vercel-app.js`、`src/server.js`、`scripts/`、其他 tests / README / workflows。
