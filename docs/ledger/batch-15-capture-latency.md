# B15 · Capture 同步写对 MCP 延迟的影响：异步 / collector 方案设计

> 状态：**设计方案，未实现，未 commit / push / deploy**。
> 本次只新增本文件；不改 `src/`、`scripts/`、`tests/`、`README`、其他 docs、workflows。
> 证据规则遵循 `docs/ledger/README.md`：现状断言都能回到具体源码行 / 已有台账 / requestId；
> 免费模型 analyzer 输出不作为本设计的依据。

## 0. 结论先行（TL;DR）

- **当前生产路径确实阻塞响应**：`CAPTURE_SYNC=1` 时 `src/capture.js:591-599` 让 `res.end` 等
  `task.finally(finish)`，而 `task` 包含 `writeSink(cfg, envelope)`（R2 PUT，
  `src/capture.js:344-370`，15s abort 超时）。每个 `POST /mcp` 都要等这一次 R2 往返才 finalize。
- **量化基线**：线上已测 requestId `602f4012-8776-465d-8bb3-d9507ef2bd90` 总耗时 1049ms，其中
  同步 sink 占 ~0.4–0.5s（`docs/eval/capture-verification-2026-11-23.md:30-34`、
  `docs/ledger/batch-11-recent.md:24`）。即 sink 约占该请求 **40–48%** 的墙钟时间。
- **根因不是“capture 慢”而是“不可靠 + 用同步换可靠”**：`waitUntil` 在 `queueMicrotask` 里调用 →
  Vercel 冻结；改同步顺序后仍不可靠；最终 `CAPTURE_SYNC=1` 以延迟换数据可信
  （`docs/ledger/batch-11-recent.md:12-17`）。因此**只把 `CAPTURE_SYNC` 关掉、退回裸
  `waitUntil`，在 Vercel 上等于回到丢数据状态**——本次历史事故明确禁止这样做。
- **推荐**：选项 **D（关键事件同步、正文异步）** 为第一阶段，叠加 **C（外部 collector）**
  作为目标态：把 R2 PUT 从请求关键路径移到“网关 → 同 VPC/同区域 HTTP collector →
  批量写 R2”。P0（`capture_ack`/`capture_done`/`capture_dropped`，含 requestId）继续同步落
  可被对账的地方；正文 envelope 异步投递，允许 **秒级 capture lag**，但用 **幂等 key +
  持久化待写队列 + 重试** 保证“最终完整率不降”。选项 A/B 作为退化/兜底，不单独采用。
- **硬约束**：不引入付费服务除非明确标注；现有 Upstash（`src/store.js`）与 R2 已是本项目
  在用的服务，复用不算新增。Cloudflare Worker/Queue 会标注为“若选用则涉及 Cloudflare
  计费/额度”，默认不假设已开通。

---

## 1. 当前路径量化

### 1.1 每个 MCP 请求的 capture 写是否阻塞响应

`src/vercel-app.js:311-327` 在路由前对 `POST /mcp` 调一次 `startCapture`；`startCapture`
包装 `res.write`/`res.end`（`src/capture.js:483-620`）。关键分支在 `res.end`：

```
src/capture.js:578-584   task = Promise.resolve()
                          .then(() => writeSink(cfg, envelope))
                          .then(() => log('capture_sink_ok'))
                          .catch(onSinkError)

src/capture.js:591-599   if (cfg.sync) {           // CAPTURE_SYNC=1
                            sinkQueued = true
                            log('capture_done', {... sync:true})
                            task.finally(finish)   // <-- finish = originalEnd(...)
                            return undefined       // <-- 原始 res.end 不在这里调用
                          }

src/capture.js:605-619   try { waitUntil(task) } catch {}
                         log('capture_done', ...)
                         return finish()           // 异步模式：立即 end
```

结论：

| 模式 | `originalEnd` 何时发生 | 响应是否等 sink | 证据 |
|---|---|---|---|
| `CAPTURE_SYNC=1`（当前生产） | `task.finally` 之后（`:597`） | **是**，等 `writeSink` resolve/reject | `src/capture.js:591-599` |
| 异步（`CAPTURE_SYNC` 未设）且 `waitUntil` 可用 | `res.end` 同步路径立即（`:619`） | 否（尽力保留实例） | `src/capture.js:605-619` |
| 异步但 Vercel 冻结 | 同上，但 microtask 可能不跑 | 否，且**静默丢 capture** | `docs/ledger/batch-9-capture-completeness.md:10-25` |

注意 `CAPTURE_SYNC` 读取方式：`configFromOptions` 的
`sync: options.sync ?? env.CAPTURE_SYNC === '1'`（`src/capture.js:283`），
即只有字符串 `'1'` 开启；测试可通过 `options.sync` 覆盖。

### 1.2 R2 / HTTP sink 的延迟构成

`writeR2Sink`（`src/capture.js:344-370`）：

1. `gzipSync(Buffer.from(JSON.stringify(envelope)))`（`:361`）—— **同步 CPU**，对最大 32MB
   （`MAX_BODY_BYTES`，`:32`）的 envelope 在 event loop 上压缩，这部分本身就会阻塞请求线程，
   与 sync/async 无关。
2. `fetch(PUT https://api.cloudflare.com/client/v4/accounts/{id}/r2/buckets/{b}/objects/...)`，
   `AbortController` 超时 **15000ms**（`:362-369`）——跨公网到 Cloudflare API 的 TLS + 认证 +
   对象写入，通常是百毫秒级，尾延迟可到秒级。
3. 失败：`.catch(onSinkError)`（`:560-576`）记 `[capture_dropped]` 并 fire-and-forget
   `postFallback`（3s abort，`:35, 389-408`）。**同步模式下，fallback 虽然 fire-and-forget，
   但 `onSinkError` 完成是 `task`  resolve 的前提，所以一次 R2 失败 + 同步 envelope 构造仍会
   进入响应路径**；真正慢慢跑的 fallback POST 不阻塞 end。

`writeHttpSink`（`:325-342`）：5s abort 的 POST；`writeFileSink`（`:319-323`）：
`mkdir + writeFile`（本地盘，serverless 上无意义，`docs/OPEN-SOURCE/DEPLOYMENT-TEMPLATES.md:296`）。

**实测锚点**：requestId `602f4012` 的时间戳链
（capture-verification-2026-11-23.md:17-20）：

```
capture_ack                22:13:55.892Z
capture_done (sync:true)   22:13:56.941Z   (+1049ms from ack)
capture_sink_start         22:13:56.941Z
capture_sink_ok            22:13:57.393Z   (+452ms sink)
```

同步 sink 的 **452ms** 与 documented “+0.4–0.5s” 一致。`capture_done` 在 sync 模式下记录于
`task` 完成**之前**（`:593-596` 在 `task.finally(finish)` 之前），所以日志里的 `duration`
**不包含** sink 时间；`capture_sink_ok` 才是 sink 完成时间。这是设计量化指标时必须注意的
陷阱（见 §1.3 指标定义）。

### 1.3 sync / async 模式差异与可测指标

| 维度 | sync（当前） | async（裸 waitUntil） |
|---|---|---|
| 响应 p95 增量 | +452ms 实测，约 0.4–0.5s | 理论上仅 envelope 构造 + gzip（仍同步） |
| 数据完整率 | R2 object + dropped 可对账（A===D, R+dropped===A） | Vercel 冻结可能既无 object 也无 dropped |
| 失败可见性 | `capture_dropped` + fallback POST | 冻结时不可见 |
| 背压 | 天然反压（客户端等 sink） | 无背压，突发时并发 PUT 打爆连接 |
| 适用 | 数据可信优先（当前生产） | 需先解决“保留/持久化”才可用 |

**可测指标（建议接入现有日志，不新增付费监控）**：

| 指标 | 定义 | 数据来源 |
|---|---|---|
| `mcp_latency_ms` | 从 `[req] POST /mcp` 到 `originalEnd` 真正执行的时间 | 新日志 `capture_flush_end`（见下）减去 `[req]` 时间；sync 模式下 `capture_done` 不够（见 §1.2） |
| `sink_wall_ms` | `capture_sink_ok`/`capture_dropped` 时间 − `capture_sink_start` 时间 | 现有日志，取 timestamp 差 |
| `envelope_build_ms` | `res.end` 进入 → `capture_sink_start` | 同期日志差；含 gzipSync |
| `capture_lag_ms` | R2 object 的 `ts` 或 collector 落盘时间 − `capture_ack` 时间 | 新增 `persistedAt` 字段；衡量异步方案 lag |
| `capture_completeness` | `R + dropped === A`（B9 判据） | Vercel 日志 + R2 list，`docs/ledger/batch-9-capture-completeness.md:113-120` |
| `dropped_rate` | `capture_dropped` 条数 / `capture_ack` 条数 | 现有日志 |
| `queue_depth` / `queue_max` | collector 待写队列长度（峰值） | 新指标，背压验证 |
| `retry_count` / `dlq_size` | 重试次数、进死信的 envelope 数 | 新指标 |

**p95 测量口径**：`mcp_latency_ms` 必须在 `originalEnd` 真正调用处打点（sync 模式在
`task.finally(finish)` 内、async 模式在 `finish()` 前），否则会漏掉同步等待。建议新增
`[capture_flush_end]` 一行带 `{requestId, mode, sync, waitedMs, endAt}`，纯日志、无新依赖。

---

## 2. 设计选项

四个选项共用同一 envelope schema（`gmg.capture.v1`，`src/capture.js:518-555`），
不改 MCP 协议、不改响应字节（`docs/OBSERVABILITY-AND-EVAL.md:138-147` 的硬契约）。

### A. 完全异步 `waitUntil` + 队列

```
res.end:  build envelope -> enqueue(in-process) -> waitUntil(drain) -> originalEnd
```

- 在 `res.end` 同步路径把 envelope 放进**进程内 Promise 队列**，由 `waitUntil(drainPromise)`
  持有；drain 串行消费队列写 R2。
- **优点**：响应不再等单次 R2；突发时串行化，避免并发 PUT 打爆连接。
- **致命问题**：`docs/ledger/batch-11-recent.md:16` 已证明**纯 `waitUntil` 在该 Vercel runtime
  不可靠**——冻结后队列连同未 drain 的 envelope 一起丢，连 `capture_dropped` 都没有。
  进程内队列与实例同生命周期，不能作为持久化保证。
- **定位**：只能作为 B/C 的“本地缓冲层”，不能单独承担“不丢 P0”的承诺。

### B. 本地内存 ring + 批量 flush

```
captureStore -> RingBuffer{capacity:N, dropPolicy} --batch(k)/interval(T)--> writeSink
```

数据结构（伪代码，仅示意；本次不实现）：

```js
class CaptureRing {
  constructor({ capacity = 256, batch = 32, intervalMs = 1000, sink, onDrop }) {
    this.buf = [];           // envelope[]
    this.capacity = capacity;
    this.batch = batch;
    this.intervalMs = intervalMs;
    this.sink = sink;        // 批量 sink: writeBatch(envelopes)
    this.onDrop = onDrop;    // 记 capture_dropped + P0 强制同步写
    this.timer = null;
  }
  push(env) {
    if (this.buf.length >= this.capacity) {
      const victim = this.buf.shift();       // 丢弃最旧的“可丢”事件
      this.onDrop(victim, 'ring_overflow');
    }
    this.buf.push(env);
    this._maybeSchedule();
  }
  async _maybeSchedule() {
    if (this.timer || this.buf.length < this.batch) return;
    this.timer = setTimeout(() => this.flush(), this.intervalMs);
  }
  async flush() {
    const chunk = this.buf.splice(0, this.batch);
    clearTimeout(this.timer); this.timer = null;
    try { await this.sink.writeBatch(chunk); }
    catch (e) { chunk.forEach(env => this.onDrop(env, 'batch_failed')); }
  }
}
```

- **优点**：把 N 次 R2 PUT 合并成 1 次批量写（R2 单 object 多 envelope 的 gzip JSONL），
  摊薄 TLS/认证开销；内存有界，符合“有界内存”契约（`<OBSERVABILITY-AND-EVAL.md>:144`）。
- **问题**：①进程内 ring 同样随 Vercel 冻结丢失（与 A 同源）；②批量 key 设计要与现有
  `capture/<day>/<requestId>.json.gz` 兼容，否则下游 analyzer（`scripts/analyze-captures.mjs`）
  和 `docs/ledger/batch-11-truncation-audit.md:122` 的取回路径全断；③ring 溢出必须明确丢什么。
- **定位**：Docker/本地长驻进程可用（无冻结，ring 可安全 flush）；Vercel 上只能作为
  “发送前的微批”（在 `waitUntil` 生命周期内尽快 flush），不能作为持久化层。

### C. 外部 collector（Cloudflare Worker/Queue/Upstash）接收

```
Vercel gateway --POST envelope(HTTP, 5s abort)--> collector endpoint
                                                    |-- 立即 202 ack
                                                    |-- 批量/队列写 R2
                                                    +-- 失败 -> DLQ/重试
```

三种受体：

| 受体 | 机制 | 成本/依赖标注 | 与现有栈的关系 |
|---|---|---|---|
| **Cloudflare Worker（HTTP endpoint）** | Worker 收到 POST，先用 `ctx.waitUntil` 批量写 R2；单请求体小（只有 envelope） | **若选用**：Worker 免费额度通常够单用户自建，但超量按 Cloudflare 计费计费；R2 操作本身已在使用 | 与现有 R2 同账号，PutObject 可直接走 R2 binding（无需 Cloudflare API 公网 PUT） |
| **Cloudflare Queues** | Worker 投递到 Queue，consumer 批量写 R2 | **若选用**：Queues 有付费额度/按消息计费，超出免费层需付费；需 Cloudflare 控制台配置 | 天然重试/DLQ/顺序由平台负责 |
| **Upstash Redis（复用现有实例）** | 用 List/Stream 做待写队列，gateway `LPUSH`，独立 worker `BRPOP` 批量写 R2 | **免费**（已配 `KV_REST_API_URL/TOKEN`，`src/store.js:43-45`），零新凭据 | 复用 `src/store.js` 的 fetch 传输；但 Redis 存大 envelope 成本高，建议只存“指针 + 小 P0”，正文先写 R2 或对象存储 |

关键点：**collector 的 POST 本身仍在请求路径上**（`writeHttpSink` 5s，`src/capture.js:325-342`）。
如果仍用 `CAPTURE_SYNC=1`，只是把“等 R2 452ms”换成“等同区域 collector 20–80ms”，
延迟大幅下降但没归零；要真正归零，POST 必须进 `waitUntil` 或 ring，且由 collector 承担持久化
（见 §3 推荐）。

**兼容性**：`docs/OPEN-SOURCE/DEPLOYMENT-TEMPLATES.md:314, 525, 533` 明确指出 Cloudflare
环境需把 `@vercel/functions.waitUntil` 换成 `ctx.waitUntil` 抽象，Docker 环境用 no-op。
本设计建议封一层 `runtimeWaitUntil(promise)`（见 §4.3），三端各自注入。

### D. 关键事件同步、正文异步（推荐第一阶段）

把 capture 内容按可靠性分层：

| 层 | 内容 | 写方式 | 保证 |
|---|---|---|---|
| **P0 审计行**（必须同步且不丢） | `[capture_ack]`（requestId/path/method/status 预测）、`[capture_done]`、`[capture_dropped]`、`[capture_queued]`（异步投递锚点） | `console.log` 到 Vercel 日志 +（可选）同步 PUT 一个小 `gmg.capture_ack.v1` 对象到 R2 `ack/<day>/<requestId>.json`（几百字节） | 同步小写入 ~20–80ms；或仅日志（日志本身在 Vercel 是同步可查的） |
| **P0 工具结果锚点**（必须同步落） | 对 `execute`/`execute_read` 的 `tools/call`，其 `mcpMethod`、`mcpTool`、`mcpId`、`status`、结果 `sha256` + 字节数（来自 `buildModelOutputAudit` 的字段，`src/capture.js:206-257`） | 跟随 envelope 的小 `meta` 对象同步写，或进 Upstash `gmcgw:v1:capture:meta:<requestId>`（复用 `src/store.js`） | 即使正文异步失败，P0 事实仍可与 `[capture_ack]` 对账 |
| **P1 正文**（允许 lag） | 完整 `request.raw`、`events[]`、`response.raw`、`sandbox` 原文 | 异步 collector / ring flush，写 `capture/<day>/<requestId>.json.gz`（**key 不变**） | 最终完整率不降：幂等 key + 重试 + DLQ |

- **为什么不直接全异步**：P0 audit 行是 `docs/ledger/batch-9-capture-completeness.md` 中
  `A===D`、`R+dropped===A` 判据的基础。若 P0 也异步，一旦冻结就回到“既无 object 也无
  dropped”的不可观测状态（`batch-11-recent.md:16`）。把 P0 留在同步路径，是用极小代价
  （几百字节的小写）保住可观测性。
- **正文异步如何保证不丢**：P0 meta 先落（同步），正文 envelope 带同一 requestId 进
  collector；collector 以 `requestId` 为幂等 key，写 R2 后回写“已持久化”标记到 meta
  （或只靠 R2 object 存在性对账）。若正文最终失败，`[capture_dropped]` 必须由
  **collector 的失败回调**产生——但 collector 在 Vercel 外，日志不进 Vercel；因此引入
  `[capture_queued]`（网关同步日志，证明已投递）与“R2 object”做集合差：
  `queued \ R2 = 正文丢失集合`，由离线对账任务按 requestId 重投（见 §3.3）。

---

## 3. 推荐方案与不丢保证

### 3.1 推荐组合

**D + C，分两阶段落地（本次仅设计）**：

- **阶段 1（Vercel，最小改动）**：P0 同步（现有 `capture_ack/done` 继续），
  把 `writeSink`（R2 PUT）从 `CAPTURE_SYNC=1` 的 `task.finally(finish)` 移出，改为
  `runtimeWaitUntil(postToCollector)`，collector 用**同区域 Cloudflare Worker + R2 binding**
  接收并写 R2。把 `CAPTURE_SYNC` 默认改为 `'0'`，但保留开关作为应急回滚
  （回滚 = 延迟回到 0.4–0.5s，数据可信不变）。
- **阶段 2（Docker/本地）**：不需要 collector，用 B 的 ring 批量写本地文件/HTTP sink；
  长驻进程无冻结，ring 安全。Collector 仍可选用于统一 R2 汇聚。
- **Cloudflare Queues / Upstash List** 作为 collector 内部实现选择，不在阶段 1 强制。

### 3.2 envelope 与队列消息数据结构

网关到 collector 的消息（正文，异步）：

```jsonc
{
  "schema": "gmg.capture_message.v1",
  "requestId": "602f4012-8776-465d-8bb3-d9507ef2bd90", // 幂等 key
  "sessionId": "641ffd4f-...",
  "attempt": 0,                 // 第几次投递（collector 重试递增）
  "enqueuedAt": "2026-11-23T22:13:56.941Z",
  "deadlineAt": "2026-11-23T22:23:56.941Z", // 超过则不再自动重试，进 DLQ
  "envelope": { /* 原样 gmg.capture.v1，见 src/capture.js:517-555 */ }
}
```

P0 meta（同步，小）：

```jsonc
{
  "schema": "gmg.capture_ack.v1",
  "requestId": "602f4012-...",
  "ts": "2026-11-23T22:13:55.892Z",
  "mcpMethod": "tools/call",
  "mcpTool": "execute_read",
  "mcpId": 7,
  "status": 200,
  "isWrite": false,             // 由 mcpTool 白名单判断，P0 工具结果必留
  "resultSha256": "sha256:9f...",// 正文 result 的 hash，正文缺失时可验
  "resultBytes": 12774,
  "queued": true,               // 网关已成功 POST 到 collector
  "build": "8100971b..."
}
```

R2 key 保持兼容：

```
ack/<day>/<requestId>.json                  // P0 meta（小、同步写）
capture/<day>/<requestId>.json.gz           // 正文（异步写，key 不变！）
dlq/<day>/<requestId>.json.gz               // 多次重试失败（标注后运维）
```

**幂等 key = requestId**（`randomUUID()`，`src/capture.js:435`），R2 PUT 用固定 key 天然幂等：
重复 PUT 同一对象覆盖写，不产生重复对象；对账按 `requestId` 集合做差即可。

### 3.3 失败 / 重试 / 背压策略

**失败分层**：

1. **网关注入 collector 失败**（POST 非 2xx / abort）：
   - 当前 `writeHttpSink` 忽略 status（`:330-338` 不检查 `response.ok`）——**必须改为检查 status，
     否则 collector 5xx 会被当成成功**。
   - 失败仍走 `onSinkError`：`[capture_dropped]` + 现有 `postFallback`（3s，`src/capture.js:389-408`）
     把完整 envelope 送兜底端点；`capture_queued=false` 记入 P0 meta（若 meta 写也失败，至少
     Vercel 日志有 dropped）。
2. **collector 写 R2 失败**：
   - 指数退避重试：`delay = min(1000 * 2^attempt, 30000)`，最多 `maxAttempts=8`，总窗口 ~4min；
     仍失败写 `dlq/<day>/<requestId>.json.gz`（**DLQ 是 Cloudflare R2 同 bucket 的前缀，不是新服务**）。
   - 每次重试带 `attempt`，R2 固定 key 保证幂等。
3. **背压**：
   - 网关侧：collector POST 用 5s abort（`src/capture.js:328`），超时即算失败并 dropped；
     不无限重试——重试交给 collector/DLQ，避免请求路径无限等待。
   - collector 侧：Worker `ctx.waitUntil` 持有批量写；队列深度超阈值（如 1000）时返回 `429`，
     网关视作失败并 dropped（可观测），不静默积压。
   - ring（阶段 2 Docker）：`capacity=256`，溢出按“先丢最旧的可丢正文，P0 meta 永不丢”策略，
     每次溢出记 `capture_dropped reason=ring_overflow`。

**“不丢 P0” 的形式化保证**：

```
对每个 POST /mcp：
  A(requestId) 存在 （capture_ack 同步日志）
  D(requestId) 存在 （capture_done 同步日志）
  M(requestId) 存在 （P0 meta，同步小写入；若写失败则 capture_dropped 存在）
  正文 E(requestId) 满足：R2 capture/<day>/<id>.json.gz 存在
                          或 dlq/<day>/<id>.json.gz 存在
                          或 capture_dropped 存在（网关投递失败）
对账：queued 集合 \ R2 集合 = 待重试/丢失集合，必须被 dlq 或 dropped 覆盖
```

允许 `persistedAt - ackAt` 的 **capture lag**（目标 p95 < 5s，p99 < 30s），
但 `A/D/M` 的完整性不允许下降（对齐 `docs/ledger/batch-9-capture-completeness.md:113-120`
判据，只是把 `R` 拆成 `R_capture + R_dlq`）。

---

## 4. 运行时兼容性（Vercel / Cloudflare / Docker）

### 4.1 三个运行时的 waitUntil 语义

| 运行时 | waitUntil | capture 现状 |
|---|---|---|
| Vercel（当前生产） | `@vercel/functions.waitUntil`（`src/capture.js:27` import）；**实测不可靠**（冻结丢任务） | 必须 `CAPTURE_SYNC=1` 才有完整数据（`docs/ledger/batch-11-recent.md:17`） |
| Cloudflare Workers | `ExecutionContext.waitUntil(ctx)`；语义更强（事件存活到 promise settle），但仍有 CPU/时间限制 | 需把 import 换成适配层（`docs/OPEN-SOURCE/DEPLOYMENT-TEMPLATES.md:314, 337`） |
| Docker / Node 长驻（本地） | 无 waitUntil；进程不冻结 | no-op 即可，Promise 自然跑完；B 的 ring 可用 |

**适配伪代码**（本次不实现，示意）：

```js
// src/runtime/waitUntil.js —— 建议未来新增，本次不改
export function createWaitUntil({ vercel, executionContext } = {}) {
  if (executionContext?.waitUntil) {
    return (p) => executionContext.waitUntil(p);          // Cloudflare
  }
  if (vercel) {
    return (p) => requireVercelWaitUntil()(p);            // Vercel：尽力而为
  }
  return (p) => { p.catch(() => {}); };                   // Docker/no-op
}
```

`src/capture.js` 顶部当前**在模块加载时**就 `import { waitUntil } from '@vercel/functions'`
（`src/capture.js:27`），这会让 Docker/Cloudflare 构建都需要这个 Vercel 包
（`docs/OPEN-SOURCE/DEPLOYMENT-TEMPLATES.md:37, 314`）。阶段 1 最小改动可不拆 import，
但若要真正三端兼容，必须把 import 移到适配层、按 runtime 注入（见 `DEPLOYMENT-TEMPLATES.md:533`
的既有建议：`src/runtime/waitUntil.js`）。

### 4.2 配置兼容（不新增必需 env）

- 保留 `CAPTURE_MODE` / `CAPTURE_SINK` / `CAPTURE_SYNC` / `R2_*` / `CAPTURE_HTTP_*`
  全部现有变量（`src/capture.js:266-285`，模板 `templates/*/README.md`）。
- 新增可选 `CAPTURE_COLLECTOR_URL`（collector HTTP 端点）与
  `CAPTURE_SYNC_META`（默认 `1`，控制 P0 meta 是否同步写）；
  **不设也全部回退到现有行为**（R2 直写 + CAPTURE_SYNC=1），满足 `README` 的“optional”语义。
- Docker 模板（`docs/OPEN-SOURCE/DOCKER.md:43-47`）当前只支持 `file`/`http` sink，
  本方案不要求改模板；阶段 2 可增 `CAPTURE_SINK=ring` 作为可选值（标注为后续工单）。

### 4.3 付费服务标注

| 组件 | 是否付费 | 说明 |
|---|---|---|
| 现有 Upstash Redis（`src/store.js`） | 已在用（有免费层，超出按量） | 复用，不是新增服务 |
| 现有 Cloudflare R2 | 已在用（有免费层，超出按量） | 复用，key 不变 |
| Cloudflare Worker（collector） | **若选用**：Worker 有免费额度，超量计费；需 Cloudflare 账号与部署 | 本设计标注为“可选基础设施”，默认阶段 1 可在同 Worker 平台内实现，但不在未配置时假设可用 |
| Cloudflare Queues | **若选用**：按消息/操作计费，通常不免费 | 仅作为 C 的可选实现，不默认 |
| Upstash List 队列 | 复用现有实例，不新增付费项 | 但大 envelope 存 Redis 成本高，建议只存 meta |
| Vercel Blob / Postgres | 不采用（现有 R2 已够，`docs/ledger/batch-11-durable-state.md:56-58` 已否决 New KV/Postgres） | 无新增 |

---

## 5. 测试计划（实现时执行；本次仅列方案）

遵循现有测试风格（`tests/capture*.test.js` 用 fake sink / fake fetch 注入，
`src/capture.js:284` 的 `fetchImpl` 可注入）。

### 5.1 必须用 fake sink 延迟注入验证的用例

| 用例 | 注入 | 断言 |
|---|---|---|
| **基线延迟** | fake R2 sink `delay=452ms`（对齐线上锚点） | sync 模式 `originalEnd` 在 sink 完成后调用；异步模式立即调用；`mcp_latency_ms` 差值 ≈ 452ms |
| **p95 降低** | 1000 个请求，sink 延迟分布（p50=80ms/p95=450ms/p99=1500ms） | 推荐方案 p95 `mcp_latency_ms` 比基线下降 ≥ 80%（目标 < 100ms）；`capture_lag_ms` p95 < 5s |
| **burst** | 并发 200 请求同时 `res.end` | 无 OOM；collector 收到 200 条；ring `queue_max` ≤ capacity；429 时 `capture_dropped` 计数正确 |
| **abort** | sink `abort=true`（模拟 R2 超时 15s） | 异步模式响应不被挂住；`[capture_dropped]` 出现；fallback POST 被调用；P0 meta 仍可查 |
| **duplicate** | 同一 requestId 投递 3 次 | R2 只 1 个 object（固定 key 覆盖）；对账 `R+dropped===A` 仍成立；无重复 ack（`src/capture.js:427-429` 的幂等 guard 保留） |
| **ordering** | 同 sessionId 连续 10 个请求，乱序到达 collector | envelope 内 `ts`/`requestId` 保留；analyzer 可按 session 聚类（`docs/ledger/batch-11-session-clustering.md`）；不强行按到达顺序编号 |
| **P0 不丢** | collector 连续失败 3 次后恢复 | 3 个 envelope 进 DLQ 或重试后落 R2；P0 meta 100% 存在；`queued \ R2` 差集为空或被 DLQ/dropped 覆盖 |
| **waitUntil 不可用** | 注入 `waitUntil` 抛错（本地/no-op） | Promise 仍执行；失败仍记 dropped（`src/capture.js:605` 的 catch 语义保留） |
| **响应字节不变** | capture on vs off，同一 fixture | 逐字节相同（`docs/OBSERVABILITY-AND-EVAL.md:141` 硬契约） |
| **三 runtime 适配** | 分别注入 vercel/executionContext/no-op | 各自调用正确 waitUntil；无模块加载期 Vercel import 崩溃 |

### 5.2 验收门控

1. **p95 降低**：`mcp_latency_ms` p95 相对当前 `CAPTURE_SYNC=1` 基线（实测锚点 1049ms 总 /
   452ms sink）下降，目标 **< 100ms 增量**（即 sink 退出关键路径），用 fake sink 延迟分布
   与真实 Vercel 预发各测一次。
2. **capture 完整率不降**：`A===D`、`V-A===S`、`(R_capture + R_dlq) + dropped === A`
   三条判据（`docs/ledger/batch-9-capture-completeness.md:113-120` 的扩展）在 burst/abort/
   duplicate 场景下全部成立。
3. **P0 request / 工具结果零丢失**：`tools/call` → `execute_read`/`execute` 的 requestId 在
   P0 meta 与 R2 object（或 DLQ）都可查；`resultSha256` 与正文 `model.modelOutput.sha256`
   （`src/capture.js:250`）一致。
4. **不回归**：`npm test` 全绿（当前基线见 `docs/ledger/README.md` B11.6 642/642）；
   `capture.test.js` / `capture-completeness.test.js` 现有断言不改语义。
5. **不 commit / push / deploy**：实现工单完成后仍需 lead 人审；本设计阶段只交付本文档。

---

## 6. 明确不做

- 不改 `src/capture.js` 的任何一行（包括 `CAPTURE_SYNC` 默认值、gzipSync、waitUntil import）。
- 不新增 npm 依赖、不修改 `package.json`、不引入新付费服务（C 的 Cloudflare 组件已标注为可选）。
- 不改 R2 key 格式 `capture/<day>/<requestId>.json.gz`（下游 analyzer 与台账取回脚本依赖它）。
- 不实现 `src/runtime/waitUntil.js`、collector Worker、ring 模块——这些是后续独立工单。
- 不把“关掉 CAPTURE_SYNC”当作修复；在 collector 持久化能力被真实验证前，生产必须保持
  `CAPTURE_SYNC=1`（`docs/ledger/batch-11-recent.md:17` 的事故硬约束）。
- 不在本次 commit / push / deploy。

## 7. 证据索引

| 断言 | 来源 |
|---|---|
| sync 模式阻塞 `originalEnd` | `src/capture.js:591-599` |
| R2 PUT 15s abort + gzipSync | `src/capture.js:344-370`（尤其 `:361, 362-369`） |
| 实测 sink 452ms / 总 1049ms | `docs/eval/capture-verification-2026-11-23.md:11-34` |
| +0.4–0.5s 代价 / 冻结事故 | `docs/ledger/batch-11-recent.md:12-24` |
| waitUntil 在 microtask 丢失、无 dropped | `docs/ledger/batch-9-capture-completeness.md:10-25` |
| 对账判据 A===D / R+dropped===A | `docs/ledger/batch-9-capture-completeness.md:113-120` |
| envelope schema / 字段 | `src/capture.js:517-555` |
| P0 日志 tag 与幂等 guard | `src/capture.js:43-47, 427-429, 466-481, 557-620` |
| 三 runtime waitUntil 适配缺口 | `docs/OPEN-SOURCE/DEPLOYMENT-TEMPLATES.md:37, 314, 337, 525, 533` |
| 有界内存 / p95<5ms / fail-open 契约 | `docs/OBSERVABILITY-AND-EVAL.md:138-147` |
| 复用 Upstash、否决 New KV/Postgres | `docs/ledger/batch-11-durable-state.md:51-58, 189-198` |
| 测试基线 642/642 | `docs/ledger/README.md`（B11.6 行） |
