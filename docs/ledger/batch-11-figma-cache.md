# Batch 11 · W6-B：Figma 跨实例缓存 / 熔断（设计，不改代码）

> 状态：**设计方案，未实现**。把 PLAN-2026-11-23 §3 P1「跨实例缓存/熔断」、§5 W6
> 「Figma 冷却跨实例」落成可执行方案。
> **本次不改** `src/`、`scripts/`、`tests/`、`README`、其他 docs、workflows；**未 commit / push / deploy**。
> 证据规则遵循 `docs/ledger/README.md`：配额结论必须有实测/官方出处，不凭缓存文案或二手摘要断言。

## 一、现状证据

### 1. 当前 guard 是 per-instance —— 源码明说
`src/figma-guard.js`：
- 文件头注释 `:2-14`：**"Everything here is per-process, in-memory state. On serverless (Vercel)
  every warm instance owns its own cooldown and cache; a cold start starts with a clean slate.
  There is no shared KV/Redis coordination."**
- 默认值 `:16-19`：`DEFAULT_COOLDOWN_MS = 24h`、`DEFAULT_CACHE_TTL_MS = 1h`、
  `DEFAULT_CACHE_MAX = 200`、`CACHEABLE_TOOLS = {whoami, get_metadata}`。
- 状态载体 `:95-97`：`let cooldownUntil = 0` + `const cache = new Map()`（进程内）。
- `trip()` `:110-113`：设 `cooldownUntil = Date.now()+cooldownMs` 并 `cache.clear()`；
  `get/set/assertCool` 全在这份 Map 上。
- `createFigmaGuard` `:91` 注释："The UpstreamManager creates one per instance, so state is never shared."
- 接线 `src/upstreams.js:207`（每实例一个 guard）、`:395-424`：cooldown 优先于 cache；
  命中 quota 错误（`isError:true` 或抛错）→ `trip()`；`whoami/get_metadata` 成功 → `set()`。
  **注意 `src/upstreams.js:398` `assertCool()` 在 cache 之前——一旦 trip，连缓存读都不给。**

### 2. 官方配额：Starter/View 是每月 20 次（不是每天），且 whoami 豁免
官方 Figma 文档 [Rate limits & access](https://developers.figma.com/docs/figma-mcp-server/rate-limits-access/)（本次 web_fetch 2026-11-23 实测）：
- **View / Collab seat：Starter/Professional/Organization/Enterprise 一律 up to 20 per month。**
- Full/Dev seat：Professional 200/day、10/min；Organization 200/day、15/min；Enterprise 600/day、20/min。
- 限制只作用于**读工具**；写工具（`create_new_file` 等）与 `whoami` **豁免**。
- 官方原文："Figma may change rate limits at any time."

`docs/ledger/batch-4-figma.md` G7 实测：`whoami` 返回 "plan `Yi Yu's team` (starter, admin) / seat View"
——**我们是 Starter + View seat = 每月 20 次读**。这解释了为什么 24h cooldown 不够，
以及为什么缓存必须跨实例：每个 warm 实例 20 次，多实例 = 配额成倍烧掉。

### 3. 已有上游证据（真实请求）
- `docs/eval/online-offline-join-2026-11-22.md`：execute_read 脚本含
  `figma__whoami`、`figma__get_metadata`（`10c13554…`）；`116da831…` 的 `upstream_http:figma`
  事件说明多实例各自探测过 figma。
- `docs/ledger/batch-4-figma.md` G4/G7：figma 有真实调用（get_metadata、create_new_file）；
  `docs/eval/l1-real-2026-11-22.md` figma toolHit 44.4% / searchHit 100%。
- `docs/PLAN-2026-11-23.md` §8 风险表已列："Figma 配额 → 默认跳过 real L1；熔断/缓存；不每日烧"。

### 4. 可复用的基础设施
- `src/store.js`：Upstash Redis REST 已上线（OAuth 用），有 `compareAndSet`、`casToken`、
  GETDEL、`_command('set', ..., 'EX'|'NX')`、TTL 表与 `gmcgw:v1` 前缀——**跨实例共识不需要新组件**。
- `src/figma-guard.js` 已有纯函数可复用：`isFigmaQuotaError`、`cacheKey`（稳定 JSON key，
  `:68-78`）——外部 KV 沿用同一 key 算法即可保证行为一致。

## 二、方案

### 2.1 选型：用现有 Upstash Redis REST 做共享状态，不引入新组件

| 候选 | 结论 | 理由 |
|---|---|---|
| **Upstash Redis REST（扩展现有实例）** | ✅ 选它 | 已配 `KV_REST_API_URL/TOKEN`；`src/store.js` 已证明 serverless 可用；SET NX EX / GET / TTL / EVAL 全具备，正好覆盖 cooldown 与 SWR 的原子需求；零新依赖。 |
| 每实例内存（现状） | ❌ 保留为 L1 但不再单独决策 | 作为 L1 快路径减少 Redis 往返；但**不能作为唯一真相**（§一.1）。 |
| R2 | ❌ 不做 | 无 TTL/原子锁；同步写 +0.4–0.5s，不适合热路径。 |
| 新 Redis / KV 实例 | ❌ 不做 | 多一份凭据与账单，现有实例足够。 |

### 2.2 外部 KV 键（沿用 `gmcgw:v1` 前缀）

```
gmcgw:v1:figma:cooldown              -> JSON { until: <ms>, reason, trippedAt, trippedBy: <instanceId> }  (EX = cooldown 上限)
gmcgw:v1:figma:cache:<cacheKey>      -> JSON { value, storedAt, expires }  (EX = TTL + stale 窗口)
gmcgw:v1:figma:reval:<cacheKey>      -> 短锁（SET NX EX，防止多实例同时回源）
gmcgw:v1:figma:gen                   -> 全局代号 bump（trip 时 INCR，使所有旧缓存逻辑失效）
```

- `<cacheKey>` = 现有 `cacheKey(tool, finalArgs)` 的返回值（`src/figma-guard.js:69-71`，
  `tool:stableStringify(args)`），哈希后作为 key 片段（避免超长/非法字符）。
- `value` = 现有 `guard.get()` 返回的 MCP result 对象（`{content:[{type:'text',text:...}]}`），
  不重新序列化成别的结构。
- 只缓存 `CACHEABLE_TOOLS`（whoami/get_metadata）；**whoami 官方豁免配额，但缓存它仍能省往返**，
  且必须支持 cooldown 时读取（见 §2.4 降级），所以保留。

### 2.3 TTL / cooldown 参数（基于官方 20/月）

| 参数 | 值 | 依据 |
|---|---|---|
| `cache TTL` | 1h（沿用 `DEFAULT_CACHE_TTL_MS`） | 设计文档现有值；Figma 文件内容小时级变化，1h 可接受 |
| `stale 窗口` | +24h（SWR 用：fresh 1h，stale 最多再 24h） | Starter 每月 20 次，宁可用 25h 旧数据也别烧当月配额 |
| `cooldown` | 24h（沿用 `DEFAULT_COOLDOWN_MS`），trip 时写 `until=now+24h` | 月度配额被打爆后 24h 内基本不会自动恢复；到期后再探测 |
| `reval 锁 TTL` | 30s | 单次回源耗时上界；锁过期后可重试，防卡死 |
| `cooldown key EX` | cooldown + 5min 余量 | 避免 key 在 `until` 前过期 |
| `gen` | trip 时 INCR | 代替本地 `cache.clear()`；所有实例看到代号变化即逻辑失效 |

> 这些是**默认值**，走 env 覆盖（沿用 `envMs` 模式 `figma-guard.js:80-85`）；
> 官方说"may change at any time"，所以参数必须可配且不硬编码假设。

### 2.4 读路径（stale-while-revalidate + 跨实例 cooldown）

```
callTool(figma, tool, args):
  1. L1 本地 guard.assertCool()            // 进程内快路径，命中直接抛（省 Redis）
  2. shared = redis.GET(cooldown)          // 跨实例真相
     if shared.until > now: throw FigmaQuotaCooldownError(shared.until-now)   // 所有实例一致
  3. key = cacheKey(tool,args); gen = redis.GET(gen)
     hit = redis.GET(cache:<key>)          // 或 L1 Map 命中且 gen 未变
     if hit.fresh (now-hit.storedAt <= TTL): 返回 hit.value（capture cacheHit:'fresh'）
     if hit.stale (TTL < age <= TTL+staleWindow):
         - 尝试 SET NX reval:<key> 30s
           成功 → 异步回源（见下），本次先返回 stale（capture cacheHit:'stale'）
           失败 → 别的实例正在回源，直接返回 stale（capture cacheHit:'stale-other'）
     无 hit → 同步回源（见下）
  4. 回源：
     - 成功且 !isError → 写 cache:<key>（EX=TTL+staleWindow, value+storedAt+expires+gen）
     - quota 错误（isFigmaQuotaError） → 共享 trip：
         SET cooldown {until, reason, trippedAt, trippedBy} EX(24h+5m)（用 SET 或 EVAL 取较晚的 until）
         INCR gen；清本地 L1；抛 FigmaQuotaCooldownError
     - 非配额错误 → 不 trip；按现有 upstreamError 抛出；不写缓存
  5. cooldown 期间只读降级：whoami/get_metadata 若本地/共享 cache 有未过期副本，
     **允许返回 stale**（capture cacheHit:'stale-degraded'）；
     其它工具一律 FigmaQuotaCooldownError（不烧配额、不假装成功）。
```

**与现状的关键差异**：
- 现状 `src/upstreams.js:398` 是 "assertCool 在 cache 之前 → trip 后连缓存都不给"；
  新方案 §2.4.5 对只读工具**允许 stale 降级**（但标记清楚）。这是收益也是风险（见 §三）。
- 现状 trip 清本地 Map（`figma-guard.js:112`）；新方案 trip 靠 `INCR gen` 让**所有实例**的
  本地 L1 失效，而不是只清 trip 的那个实例。
- 异步回源必须在响应结束后完成——**Vercel 会冻结实例**（`batch-11-recent.md` §1）：
  所以 SWR 回源必须用 `waitUntil`/同步等待，不能放进 `queueMicrotask` 后不管。
  鉴于该 runtime 的 `waitUntil` 保留不可靠（capture 事故），**最小实现先把回源做成同步**
  （在本次请求的响应内完成），SWR 的"先返 stale 再后台刷新"留到确认 waitUntil 可靠后再开。
  这是本方案最重要的降级约束。

### 2.5 最小实现（明确口径）

分两阶段，**本次只交付设计**：

**阶段 1（最小可用，建议先做）**
- 新增 host 侧 `src/figma-shared-guard.js`（或扩展 `createFigmaGuard` 接受一个 `sharedStore`）：
  复用 `cacheKey`/`isFigmaQuotaError`，把 cooldown 与 cache 的**真相**放到 Upstash；
  保留 L1 Map 作快路径，但每次读 cooldown 必须查共享（或短 TTL 本地缓存 + 版本号）。
- `src/upstreams.js` 接线处（`figma` 分支）改为调用共享 guard；**不改其它上游、不改工具面**。
- SWR 回源先同步（§2.4 降级约束）；cooldown 期间只读 stale 降级开关默认**关**，
  用 env 打开（先观察行为）。
- capture 记录 `cacheHit: fresh|stale|miss|degraded`、`cooldownShared:true`、`instanceId`。

**阶段 2（视数据再做）**
- 确认 `waitUntil` 在部署 runtime 可靠后，把 stale 回源改成真异步（请求先返 stale）。
- 加 `FIGMA_QUOTA_REMAINING` 指标/告警（如共享 cooldown key 命中次数/天）。

**不做**：新 KV 实例、改 Figma 工具清单、改配额假设为"每天 20"（官方是每月）。

## 三、收益 / 风险

### 收益
- 一个实例 trip → 所有实例立刻短路，避免 N 个 warm 实例各烧 20 次/月（核心收益）。
- 跨实例命中缓存，重复 `get_metadata`/`whoami` 不再消耗配额。
- trip 时 `INCR gen` 全局失效旧缓存，杜绝"别的实例还在给过期结果"。
- 复用 `src/store.js` 已上线的 Upstash，零新依赖/凭据。
- capture 区分 fresh/stale/degraded，可与 L1/G6 对账。

### 风险（逐条带缓解）
| 风险 | 缓解 |
|---|---|
| stale 数据误导用户（尤其 SWR 异步先返旧值） | 阶段 1 同步回源；stale 带 `cacheHit:'stale'`；cooldown 降级默认关、env 打开；24h 上限。 |
| Redis 不可用 → figma 调用全挂 | 降级：共享读失败时回退 L1 本地 guard（保留现状行为），capture 记 `sharedStoreDegraded`；**绝不因为 Redis 挂了就拒绝本来能成功的读**。 |
| 共享 cooldown 与本地 L1 不一致（短暂窗口） | 以共享为准；本地 L1 只做快路径，cooldown 决策每次查共享（或版本校验）。 |
| `INCR gen` 与 cache 写入竞态（旧 gen 的写覆盖新值） | 写 cache 时带 gen；读时校验 gen，不匹配视为 miss 并重回源。 |
| 官方改配额（"may change at any time"） | TTL/cooldown 全部 env 可配；不硬编码 20/月假设；定期复核官方文档。 |
| 月度配额被打爆后 24h cooldown 到期仍无额度 | 到期后只探测一次；再次 trip 则续 24h；配合告警，不无限重试。 |
| Vercel 冻结导致 SWR 后台回源丢失（capture 事故同类） | 阶段 1 不做真异步；必须做时先用真实请求验证 `waitUntil`，否则永远同步。 |
| 缓存 key 参数顺序不同导致重复调用 | 复用 `cacheKey` 的 stableStringify（`figma-guard.js:73-78`）+ `normalizeToolArguments` 后的实参（`src/upstreams.js:394`）。 |

## 四、依赖与验收

### 依赖
- **已有**：`src/store.js` Upstash 连接 + EVAL/GET/SET NX EX/TTL；`src/figma-guard.js` 的
  `cacheKey`/`isFigmaQuotaError`/env 模式；`src/upstreams.js:395-424` 的唯一接线点；
  capture（cacheHit 字段可扩，`docs/OBSERVABILITY-AND-EVAL.md`）。
- **前置**：无硬阻塞；但需要确认 Vercel 环境变量里 Upstash 凭据包含写权限（OAuth 已在用，推断可写，
  部署前**实测** key 权限，遵循证据规则"逐个 key 实测并附时间戳"）。
- **并行**：与 W4（自适应）、W6-A（持久状态，同样复用 Upstash）可并行；两者共享 store 但 key 命名空间不同，不冲突。

### 验收（实现时的门控，非本次）
- 单元（fake Redis，无网络）：
  - L1/L2 一致性：实例 A trip → 实例 B `assertCool` 立即抛（同一 cooldown key）。
  - cache：A `set` 的值 B 能 `get`；fresh/stale/过期三态；`gen` 变化后旧值视为 miss。
  - SWR 同步回源：stale 命中时只回源一次（reval 锁阻止多实例重复）。
  - 降级：Redis GET 抛错 → 回退 L1，调用不失败，capture 有 `sharedStoreDegraded`。
  - quota 识别沿用 `isFigmaQuotaError` 的所有 pattern（`figma-guard.js:21-27,41-66`）。
- 真实（受控）：两实例（或两个部署 alias）共享同一 Upstash；A 触发 trip，B 在下一次
  `figma__get_metadata` 立刻收到 `FIGMA_QUOTA_COOLDOWN`；capture 的 requestId 可对账。
- 配额对账：记录实施前后 `figma.read.calls` 与 trip 次数；预期多实例下重复读调用显著下降。
- 全量：`npm test` 保持全绿（当前 B11.6 基线 642/642）；CI Node 20/22/24；不改 figma 工具面。
- 官方参数复核：实施时重新 web_fetch 官方 rate-limits 页并记录时间戳（本设计已记 2026-11-23 实测值）。

## 五、明确不做

- 不改 `src/`、scripts、tests、README、其他 docs、workflows；不 commit/push/deploy。
- 不引入新 Redis/KV 实例、新 npm 依赖、新凭据。
- 不把配额假设写死为"20/天"（官方是 **20/月 View/Starter**）；参数全部可配。
- 不做真异步 SWR（阶段 2 待 `waitUntil` 可靠性验证）；不在 Vercel 冻结后跑后台回源。
- 不缓存写工具 / 非 `CACHEABLE_TOOLS`（whoami/get_metadata 之外）；不缓存 quota 错误结果。
- 不改 Figma 工具清单、不恢复 Weave 付费项、不动 OAuth workaround（`batch-4-figma.md` DEC）。
- 不替代 `batch-11-durable-state.md` 的任务 checkpoint：本设计只管 figma 配额协调，不管任务恢复。
