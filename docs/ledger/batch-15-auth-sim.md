# B15 · 隔离 OAuth refresh 并发 / 轮换模拟 harness（2026-11-23）

> 范围（本批只写 3 个文件）：
> - `scripts/auth-rotation-sim.mjs`（新增）：确定性模拟 harness + CLI 表格输出。
> - `tests/auth-rotation-sim.test.js`（新增）：离线回归断言（16 例）。
> - 本台账 `docs/ledger/batch-15-auth-sim.md`（新增）。
>
> **未改** `src/`、其它 `scripts/`、其它 `tests/`、`README`、契约文档、workflows。
> **未 commit / push / deploy**，全部改动留在工作区，由 lead 集成。
> 不联网、不读凭据、不写真实 token，不接生产。模拟结果**只是待验证假设**，不是线上事实，也不是改 `src/` 的指令（见 `AGENTS.md`）。

---

## 一、目标与边界

在**不触碰生产代码**的前提下，用一个可控的 fake 环境验证未来 auth 架构的几个关键不变量：

1. 多个网关实例共享 KV 与一个「refresh token 单次使用」的 fake provider 时，旋转 grant 是否会被重复消费；
2. 四种锁/CAS 策略（无锁、当前无 owner 锁、owner-fenced lease、owner-fenced + 锁内二次读 + winner 读回）在并发、冷启动、锁过期、CAS 失败下的行为差异；
3. 跨环境命名空间与 shared DSH grant 只读这两条边界是否成立。

**不是**：不是修 OAuth 代码、不是证明真实 provider 如此行为、不是上线前的 white-light 验证。任何真实修复仍需先写确定性回归测试、再改代码、再跑相关 smoke（见 `AGENTS.md`）。

## 二、模型（如何保证确定性）

| 组件 | 实现 | 确定性来源 |
|---|---|---|
| 时钟 | `FakeClock`：整数毫秒，只由 `advance()` 推进 | 不读 `Date.now()`/wall clock |
| I/O 调度 | `StepQueue`：FIFO 步骤队列，每步推进固定 `CLOCK_QUANTUM_MS=10` | 所有「异步」操作都通过 `deferred()` 入队；无真实 timer/network |
| KV | `FakeKV`：Map + `NX/EX`、`del`、owner-aware `releaseLease/renewLease`、`casToken(refreshToken)` | 命令入队、租约过期按 fake clock 判定 |
| Provider | `FakeOAuthProvider`：单次使用 RT 集合；复用即 `invalid_grant` 并撤销 family | 3 个队列步骤模拟延迟；轮换同步完成，无 Promise 竞态 |
| 实例 | `Instance`：一次 `getAccessToken` 等价周期 | 全部 I/O 注入；种子 token 均为合成值，报告中一律 `mask()` |

报告中的所有 token（包括 per-instance `result`）都经 `mask()` 处理，`scripts/auth-rotation-sim.mjs` 不打印任何完整 token。`node scripts/auth-rotation-sim.mjs --scenario <name>` 输出四种策略的对比表；`runMatrix()` / `runScenario()` 供测试直接调用。

## 三、场景与结果（本 checkout 实测）

命令：`node --test tests/auth-rotation-sim.test.js` → **16 pass / 0 fail**。
矩阵重复运行两次 JSON 完全一致（`deterministic: true`）。

| 场景 | 策略 | refresh 次数 | invalid_grant | 误删锁 | 最终 token 可用 |
|---|---|---:|---:|---:|:---:|
| concurrent-2 / concurrent-3 | none | 2 / 3 | 1 / 2 | 0 | NO |
| concurrent-2 / concurrent-3 | current（无 owner 锁） | 1 / 1 | 0 / 0 | 0 | yes |
| concurrent-2 / concurrent-3 | owner-fenced | 1 / 1 | 0 / 0 | 0 | yes |
| concurrent-2 / concurrent-3 | owner-fenced + 二次读 | 1 / 1 | 0 / 0 | 0 | yes |
| cold-start（2 实例） | none | 2 | 1 | 0 | NO |
| cold-start | current / owner-fenced / +二次读 | 1 | 0 | 0 | yes |
| lock-expiry（租约中途过期） | none | 3 | 2 | 0 | NO |
| lock-expiry | current | 2 | 1 | **1** | NO |
| lock-expiry | owner-fenced | 2 | 1 | 0 | NO |
| lock-expiry | owner-fenced + 二次读 + keepalive | 1 | 0 | 0 | yes |
| cas-failure（锁后端失效 + 滞后副本） | none / current | 2 | 0 | 0 | yes* |
| cas-failure | owner-fenced / +二次读 | 2 / 1 | 0 | 0 | yes |
| shared-grant（DSH grant） | 全部四种 | 0 | 0 | 0 | yes（只读） |
| cross-env（prod vs preview） | 全部四种 | 2 | 0 | 0 | yes（两命名空间互不干扰） |

\* `none/current` 在 CAS 失败场景里没有 CAS，滞后者最终覆盖 winner：终态 refresh token 为 `REF…_2`；fenced 策略终态保持 winner 的 `REF…_1`（测试明确断言）。

## 四、模拟结论（待真实 provider 验证的假设）

1. **无锁必坏**：所有实例都花掉同一枚 RT，第二次起 `invalid_grant`；复用检测撤销整个 family，终态不可用。这是双刷的根因，不是偶发竞态。
2. **当前无 owner 锁**：普通并发下靠 NX 侥幸正确；一旦租约真的过期，无条件 `DEL` 会删掉别人的锁（复现 1 次误删），并且第二个实例重新拿锁后再次花掉同一枚 RT → `invalid_grant`。这解释了「锁看起来在却仍双刷」的现场。
3. **owner-fenced lease**：解决误删（releaseLease 只认 owner），并发/冷启动/丢失竞争场景都只有 1 次 refresh；**但若租约真的过期且没有续租，仍会双刷**——它只是把「误删」变成「过期后重入」。这是需要保留的诚实结论。
4. **owner-fenced + 锁内二次读 + keepalive**：四种场景全部 1 次 refresh、0 invalid、终态可用。锁内二次读让「进锁前别人已轮换」的worker 直接读回 winner 的 token；keepalive 让慢 provider 调用期间租约不丢；CAS 失败后读回保证不覆盖 winner。
5. **CAS 是最后一道闸**：锁失效或滞后副本场景下，只有按「实际花掉的 RT」做 CAS 才能保证 KV 终态是 winner 的 grant；无 CAS 的策略会把 `REF…_1` 覆盖成 `REF…_2`。
6. **shared DSH grant 必须只读**：四种策略都零 provider 调用；「使用 access token 但拒绝 refresh」是唯一安全行为——网关和 DSH 是两个独立 OAuth client，锁/CAS 跨进程不可见。
7. **跨环境命名空间**：prod/preview 的 grant 与锁 key 完全隔离，各自刷新自己的 RT，零 `invalid_grant`。

## 五、与真实 provider 的差异（不可直接外推）

| 维度 | 本模拟 | 真实 provider / 生产环境 |
|---|---|---|
| RT 轮换 | 严格单次使用；复用 → `invalid_grant` + family 撤销 | Notion/Linear/Vercel 文档称会轮换，但撤销范围、宽限期、检测窗口未实测；可能有 grace window 或先到先得 |
| 时钟 | 整数 ms、固定 10ms 步进 | wall clock/NTP 漂移；Vercel 冷启动、边缘地域时钟差 |
| KV | 单 Map、原子 CAS/NX/EX 语义确定 | Upstash/Redis 跨地域复制延迟、CAS 失败重试、锁 TTL 精度、后端故障时的 fail-open/fail-closed 策略 |
| 并发模型 | 协作式 FIFO 步骤队列，无真实线程/进程 | 多实例、多地域、serverless 并发 + 进程内异步 Promise 竞态 |
| 续租 | 由策略标记模拟（owner-fenced-readback 中和过期） | `setInterval` keepalive 受 event loop 阻塞、函数冻结、超时影响 |
| 错误分类 | 只有 `invalid_grant` 与成功 | 429/5xx/网络抖动、`invalid_client`、consent revoked、scope 变更、PKCE/DCR 细节 |
| 环境 | key 后缀字符串隔离 | Vercel `VERCEL_ENV`/preview 环境变量、部署别名、回滚到旧版本的混合流量 |
| 凭据 | 全合成 token，报告 mask | 真实 token/client secret 绝不进仓库、日志或本报告 |

因此：上表结论是**架构方向与反例演示**，不是「真实 provider 一定如此」的证明；不能据此直接合并代码或宣布线上已修复。

## 六、未来验证步骤（建议，不在本批执行）

1. **回归先行**：若决定改 auth 架构，先在本 harness 增加对应的确定性场景（例如「provider 有 30s 复用宽限期」「CAS 后端短暂不可用」「三地域并发」），断言先红后绿。
2. **契约对齐**：把本模拟的 lease owner / CAS key / namespace 语义与 `src/upstream-auth.js` 现状逐条对照（只读审阅），列出真实代码缺失项；改动必须另开工单，不在本批。
3. **本地 fake 回放**：用 `harness/fake-upstream.mjs` 风格的可控 provider，在测试环境跑多实例 L1 smoke，记录 refresh 次数与 `invalid_grant` 计数，验证与模拟趋势一致。
4. **provider 文档核验**：查 Notion/Linear/Vercel 最新 OAuth 文档（轮换、family revocation、grace window），把差异写回本台账；不联网的本批不做。
5. **灰度观测**：若未来上线，先加计数器（refresh 次数、CAS 失败、租约过期、`invalid_grant`、shared-grant 拒绝）与告警，再小流量灰度；无 requestId 的在线反馈只记 `unknown`，不算验证通过。
6. **共享 grant 治理**：确认 DSH 导出的 grant 是否被网关误用；长期方案是网关独立 OAuth 授权或长期 access token，而不是跨进程共用 rotating RT。

## 七、变更控制与证据

- 新增文件仅 3 个；未改 `src/`、其它 `scripts/`、其它 `tests/`、`README`、契约文档、workflows。
- 定向测试证据：`node --test tests/auth-rotation-sim.test.js` → 16 pass / 0 fail（本地实测，2026-11-23）。
- CLI 证据：`node scripts/auth-rotation-sim.mjs --scenario <name>` 输出四策略对比表；矩阵两次运行 JSON 一致。
- 未 commit / push / deploy；无凭据入仓，无真实 token 出现在报告或日志。
- lead 负责集成；本批任何结论在真实 provider 回放前均保持「待验证假设」状态。
