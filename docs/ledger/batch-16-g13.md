# B16 · G-13 修复：capture-queue 的 seen Set 无限增长

> 状态：**代码 + 测试已修，未 commit / push / deploy**。
> 本次**只写**三个文件：`src/capture-queue.js`（修改）、`tests/fix-g13.test.js`（新增）、本文（新增）。
> 没有改 `src/capture.js`、其他 tests/docs、scripts、配置、workflows。
> 依据：`docs/architecture-audit/FULL-REPO-FINDINGS.md` G-13 行、`docs/architecture-audit/full/15-src.md:353`（`capture-queue.js:120,184`）。
> 遵循 `docs/ledger/README.md` 证据规则：根因回到源码行，结论附命令输出；free-model analyzer 输出不作为依据。

---

## 0. 交付物

| 文件 | 内容 |
|---|---|
| `src/capture-queue.js` | `seen` 从永不清空的 `Set` 改为**有界 LRU + TTL 的 Map**；新增 `seenMaxEntries` / `seenTtlMs` 构造参数、`seenEvicted` 计数、`seenSize`/`seenCap`/`seenTtlMs` 快照字段、`seen_evicted`/`seen_overflow` 事件 |
| `tests/fix-g13.test.js` | 12 个确定性回归测试（fake scheduler + 同步 fake sink + 固定 microtask tick，无网络、无墙钟、无 env） |
| 本文 | 根因 / 修复 / 证据 / 未验证项 |

---

## 1. 根因（ISSUE / ROOT）

- 审计定位：`capture-queue.js` 原 `this.seen = new Set()`（原 120 行），enqueue 时 `seen.add(requestId)`（原 184 行），**只在 `inFlight` 释放时删除，seen 自身从不清空**。
- 设计意图是端到端幂等：同一 `requestId` 的 envelope 即使已经交付，也不能再次写入（DLQ 分支注释原 404 行明确"保留 seen 防止重复重投"）。
- 后果：长生命周期进程（本地守护 / 常驻 worker）按累计请求数线性占用内存，且 Set 只增不减；属全仓库审计 G-13「长进程内存增长」。`[未验证]` 真实生产规模增长量（队列默认关闭，见 §5）。
- 反例约束：不能简单"定期清空 seen"——清空后同一 requestId 的迟到 replay 会变成第二次写，破坏幂等；也不能淘汰仍在队列/重试中的 id，否则会立刻产生重复写。

---

## 2. 修复（FIX）

### 2.1 数据结构与淘汰策略

- `seen` 改为 `Map<requestId, lastSeenAt>`；JS Map 的插入顺序天然构成 LRU 队列（头 = 最久未用，尾 = 最近使用）。
- `_hasSeen(id)`（新 170 行）：命中后 `delete + set` 做 LRU 提升；若 TTL 已过期且**不在 inFlight**，删除并返回 false（新 id 可写）；若过期但仍在 inFlight，**刷新时间戳保留盾牌**，绝不因 TTL 丢失活跃去重。
- `_rememberSeen(id)`（新 189 行）：登记新 id 后按 LRU 从头扫描，淘汰**最旧的、不在 `inFlight` 的** id；跳过新 id 自身（它在 enqueue 中随后才加入 inFlight）；若全部 id 都活跃，允许暂时越界并 emit `seen_overflow`（与 ring 的 critical overflow 同策略：宁可短暂越界，也不丢活跃请求的幂等盾牌）。
- 关键不变量：**淘汰只针对已落定（delivered / dropped / DLQ，即已释放 inFlight）的 id**，因此淘汰绝不会让一个仍会被写入的 requestId 失去去重保护——满足"不能因淘汰导致立即重复写"。
- 淘汰计数 `stats.seenEvicted`、事件 `seen_evicted`（reason=`lru`）/ `seen_overflow`（均 body-free，仅含 size/cap/reason）进入现有 observability 通道。

### 2.2 可配置项与默认值

| 参数 | 默认 | 语义 |
|---|---|---|
| `seenMaxEntries` | `4096` | 已落定 id 的 dedupe 窗口容量；`0`/`Infinity`/非正数 = 不设上限（兼容旧行为） |
| `seenTtlMs` | `24h` | 条目有效期；`0`/`Infinity`/非正数 = 不过期 |
| `idempotent` | `true` | 既有开关；`false` 时完全不登记 seen（去重整体关闭） |

- 默认值理由：4096 个 id 的字符串键约数百 KiB 量级，相对 ring 默认 256 项 × 4 MiB 正文的预算可忽略；24h 覆盖常见的迟到 replay / 重试窗口，同时保证长期运行有上界。
- 快照新增 `seenSize` / `seenCap` / `seenTtlMs`（仅计数，无 payload），供测试断言与运维监控使用。
- 内存上界的诚实表述：**窗口上界 = cap + 当前同时 in-flight 的 id 数**。若一瞬间有 5000 个请求同时在途，seen 必须保留 5000 个盾牌（否则会产生重复写），这是正确性和内存的必然权衡；一旦条目落定，下一次 enqueue 会把它裁回 cap。

### 2.3 兼容性

- 既有 `tests/capture-queue.test.js`（20 项）与 `tests/capture-queue-integration.test.js`（9 项）零改动全部通过：默认 4096/24h 远大于这两组测试的规模，行为与旧版一致。
- critical 审计行例外保留：ack/done/dropped/meta 不参与 seen/inFlight，同 requestId 仍逐条交付。
- DLQ 分支仍保留 requestId 在窗口内，防止重投。

---

## 3. 证据（TEST）

### 3.1 新增测试覆盖（`tests/fix-g13.test.js`，12 项）

| 分组 | 用例 | 断言要点 |
|---|---|---|
| 默认值 | 默认 cap=4096 / TTL=24h / seenSize=0；可配置、0 禁用、idempotent:false 不登记 | 快照字段可观测 |
| 幂等 | 同 requestId 在窗口内重复 enqueue 只交付 1 次（含 LRU 提升场景）；critical 同 id 仍逐条交付 | reason=`duplicate`、`duplicates` 计数 |
| 淘汰 | cap 触发 LRU 淘汰已落定 id、新 id 可写；活跃 id 在高压下不被淘汰；TTL 过期后同 id 可重写；TTL 不剥离活跃盾牌 | `seen_evicted`/`seen_overflow` 事件、`seenSize` 收缩 |
| 长 burst | 5000 个唯一 id 分 50 批（fake clock 驱动），全部交付、零重复，窗口始终有界，下一次 enqueue 裁剪回 cap | `seenSize <= 108`、最终 `<= 9` |
| 生命周期 | close 后拒收；drain 正常完成；快照无 payload/token 泄漏 | `closed`、`depth=0` |

### 3.2 确定性保证（回应 flaky 反馈）

- fake scheduler：`now`/`setTimeout`/`clearTimeout`/`sleep` 全注入，无 `Date.now()` 依赖、无真实定时器。
- 同步 fake sink：返回普通对象 `{ ok:true }`，`_deliverBatch` 的 `await` 在固定 microtask 边界完成；不使用异步/IO sink。
- `tick(n)` 固定 N 次 `await Promise.resolve()`，不用变长的 `setImmediate` 轮询，不按"就绪次数"做断言。
- 命令与输出（2026-11-24，Asia/Singapore）：
  - `node --test tests/fix-g13.test.js` 连跑 3 次 → 每次 `tests 12 / pass 12 / fail 0`。
  - 早前一次 flaky 已定位并修复：根因是 (a) 变长 `setImmediate` 轮询 + 断言假设与 insert-driven 淘汰时机不符；(b) `_rememberSeen` 的 guard 按 cap 计（cap+1），overshoot 后单次 insert 只能裁 9 个。修复 (b) 后裁剪一次到位，测试改为固定 tick。
  - `node --test tests/capture-queue.test.js tests/capture-queue-integration.test.js` → `tests 31 / pass 31 / fail 0`（修改前后各跑一次，无回归）。
  - `npm test`（全量）最终一次 → `tests 1461 / pass 1455 / fail 0 / todo 6 / cancelled 0 / skipped 0`。
  - 说明：全量曾出现 1 次 `tests/fix-g03-g07.test.js` 的 G-07 用例失败；该文件独立重跑 2 次 8/8 通过，随后全量重跑 0 fail，判定为**其他 agent 文件在并发负载下的既有 flaky**，与 G-13 无关；按"只写三文件"约束未改动它。

---

## 4. 决策（DEC）

- 选 LRU + TTL 而非定期全清：全清会破坏端到端幂等；LRU 只淘汰已落定条目，正确性无缺口。
- 活跃 id 不可淘汰：宁可 cap 暂时越界（emit `seen_overflow`），也不制造重复写——与 ring 的 P0 永不淘汰策略一致。
- 不把默认值接 env：本模块原型自包含、不读环境；配置由构造参数注入，调用方（capture.js 集成层）若要暴露 env 属另一文件的改动，本任务不做。
- 不做定时扫描器：淘汰 insert-driven（新 enqueue 时触发），避免新增定时器/后台任务；代价是最后一批落定 id 会留到下次 enqueue 才裁剪，已由有界断言覆盖。

---

## 5. 未验证项（明确不声称）

- **未验证生产环境收益**：`CAPTURE_ASYNC_QUEUE` 默认关闭（见 `docs/architecture-audit/04-eval.md`），G-13 的实际内存增长规模在生产中 `[未验证]`；本修复是代码层 + 单元测试证据，不等于线上观测到内存下降。
- **未验证真实 collector / 网络**：所有测试用 fake sink/fake fetch，无真实 HTTP/R2 写入。
- **未验证长周期真实进程**：5000 条 burst 用 fake clock 在毫秒级模拟；没有跑数小时的真实常驻进程 RSS 测量。
- **未部署**：无 preview / production 部署，无 commit / push / PR。
- **未改生产接线**：`src/capture.js` 的队列集成路径零改动；`seenMaxEntries`/`seenTtlMs` 目前只能通过构造参数传入，集成层未暴露 env（默认 4096/24h 生效）。
- **全量套件的 G-07 flaky**：见 §3.2；不是本文件引入，未在本任务中修复。
