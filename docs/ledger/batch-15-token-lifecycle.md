# Batch 15 · 上游 token 生命周期（2026-11-23）

范围：只改 `src/upstream-auth.js`、`src/upstreams.js`、`src/store.js`（仅新增 lease 原语），新增 `tests/upstream-token-lifecycle.test.js` 与本文件。
未改 `src/capture.js`、`src/server.js`、`scripts/`、其他 tests、README、workflows；未 commit / push / deploy。

---

## 0. 第一结论（最重要，先读这条）

**DSH 和网关不能共用同一个 rotating refresh token。** 本地 vault 里 Notion `source=dsh-mcp-connector-oauth-grant`、Linear 也是 DSH 导出的 grant——那是一个由 DSH `dsh-mcp-connector` 单 owner 管理的 grant family。DSH 刷新一次，网关手里的 refresh token 立即失效；网关刷新一次，DSH 下次刷新就会 `invalid_grant`。**锁、CAS、重试都解决不了跨进程抢同一个 grant**，因为它们看不见另一个进程。

必须二选一：

1. **网关独立授权（推荐）**：为网关单独做一次 OAuth DCR 授权，refresh token 只归网关（`owner=gateway`），写入网关自己的 KV 命名空间。DSH 的 grant 继续归 DSH，互不干扰。
2. **DSH 做 token broker**：DSH 成为唯一 refresh owner，网关每次从 DSH 取短期 access token（不持有 refresh token）。这需要 DSH 侧提供接口，本批未实现。

在切换完成前，网关对任何非 gateway-owned 的 grant **只使用其 access token，绝不调用 token endpoint 刷新**；到期后显式报 `REAUTH_REQUIRED / SHARED_GRANT_REFRESH_FORBIDDEN`，而不是假装能自动刷新。

为什么 DSH 一直稳定而网关反复坏：DSH 的 grant store 是**单 owner + journal + 单例 refreshPromise + permanent/transient 错误分类**；网关过去是多个 serverless 实例各自持有 grant 副本、各自刷新。问题不在"谁的锁更高级"，而在**有没有多个进程刷新同一个 grant**。

---

## 1. 根因（按层级）

### L1 表象
- Notion `invalid_grant`（refresh grant 被判无效）反复出现；用户被要求反复重授权。
- Linear `invalid_token`：本地 KV 认为 token 新鲜，上游却拒绝。
- Vercel `invalid_token`：token 过期后没有 refresh 路径，只能重授权。

### L2 直接机制（代码层，均已修）

| # | 旧行为 | 后果 | 修法 |
|---|---|---|---|
| A | env seed 写 `bootstrapped:true`，该标记只在 refresh 成功后清除；失败则每次请求都再刷 | 冷启动/失败期间把 grant 刷爆 | bootstrap 的"验证一次"尝试**无论成败都消费一次**，清标记；旋转后的 KV 记录保留 `envSeed`，冷启动不再重建 |
| B | 锁是 `SET NX EX 30` + 盲 `DEL`，无 owner | A 租约过期后删除 B 的锁，C 进入并发刷新 | UUID owner + Lua compare-and-delete (`TokenStore.releaseLease`)；TTL 60s + 20s 续租 (`renewLease`)；释放只能释放自己的锁 |
| C | 锁外先读、进锁后不重读就调 provider | 两个实例用同一个 rotating refresh token 向 provider 各刷一次——**即使 CAS 只有一个赢，输家的那次调用也可能把整族 grant 作废** | provider 调用严格在租约内；进锁后二次读 KV，确认仍需要刷新才调用；未拿到锁的实例只等待+重读 winner，**绝不调用 provider、绝不把旧 token 当成功** |
| D | CAS 失败时返回 winner，但异常路径用普通 `set` 写 `needsReauth` | stale loser 把 winner 刚旋转出的新记录覆盖成"死 grant + 终态" | 终态写入用 `casToken` 守卫；`invalid_grant` 时先读 KV：只有 winner 仍是**同一份 refresh token**（且无有效 token）才标终态；winner 已旋转则判定 grant 活着，采用 winner token |
| E | KV key 全局：`gmcgw:v1:upstream:<server>` | preview 与 production 共用 grant，preview 冷启动/刷新会烧掉生产 grant | `resolveEnvironment()`（VERCEL_ENV / GMCGW_ENVIRONMENT）+ key 命名空间；production 保留 legacy key 以兼容线上已旋转数据，preview/development 加后缀 |
| F | Vercel 无 refreshUrl，静态 token 直接返回；401 后原样重试 | 过期后永远坏，用户看不到明确原因 | 静态 token 401 → `ReauthRequiredError(REAUTH_REQUIRED, STATIC_TOKEN_NO_REFRESH)`，不发起第二次无效重连；提示"长期 token 或补齐 OAuth 配置" |
| G | env 每次冷启动都可能重建 KV 记录，seed 也无保护 | 新部署覆盖已旋转的 grant | KV 为唯一 source of truth；env 仅用于seed 缺失记录或显式新 grant；`seed()` 默认不覆盖已有不同 refresh token（需 `force:true`） |
| H | **grant 无 owner 概念** | 网关刷新 DSH 的 grant（见第 0 节） | 记录加 `owner`/`source`；非 gateway-owned 一律拒绝刷新；KV key 按 owner+env 分离 |

### L3 根因
1. **多 owner 共享 rotating grant**（第 0 节）——最根本。
2. **把"本地时间戳新鲜"当作 token 存活证明**——Linear 事件的直接原因；provider 401 才是唯一权威信号。
3. **并发控制只覆盖写，不覆盖"消费一次性凭证"**——provider 刷新调用本身就是不可逆的凭证消费，必须在排他租约内且只能发生一次。
4. **环境边界缺失**——serverless 预览部署与生产共享持久状态。

---

## 2. 状态机（实现后的真实状态）

```
(no KV record) ──env seed / OAuth callback──> SEEDED
    │                                          │
    │  owner != gateway                        │ owner == gateway
    ├──────────> SHARED_GRANT (read-only)       │
    │            access token 可用即用          │
    │            到期 -> REAUTH_REQUIRED        │
    │            (SHARED_GRANT_REFRESH_FORBIDDEN)│
    │                                           v
    │                                  bootstrapped: true
    │                                           │ 一次租约内的刷新尝试
    │                              ┌────────────┴────────────┐
    │                           success                    failure
    │                              │                          │
    │                              v                          v
    │                           ACTIVE             ACTIVE (attempt consumed)
    │                              │                          │
    │              expiry skew / provider 401 / force          │
    │                              v                          │
    │                         REFRESHING (lease owner + keepalive + re-read)
    │                    ┌─────────┼───────────────┐          │
    │                 CAS win   CAS lose      invalid_grant    │
    │                    │          │              │          │
    │                    v          v              v          │
    │                 ACTIVE     ACTIVE      REAUTH_REQUIRED   │
    │              (new pair) (adopt winner)  (terminal, CAS)  │
    │                                              │          │
    └──────────────────────────────────────────────┴──────────┘
                          new env grant / gateway OAuth re-auth
```

关键不变量：
- **只有 `owner=gateway` 的记录会被刷新**。
- 一个 grant 在任何时刻只有一个 lease owner；provider 调用只在 lease 内发生。
- 写回永远走 fencing CAS（按 refresh_token）；CAS 输家绝不写回、绝不标终态。
- `REAUTH_REQUIRED` 是终态，直到出现**不同的**新 env seed 或显式 gateway OAuth 重新授权。

---

## 3. Provider facts（2026-11 核实）

| Provider | 授权方式 | access TTL | refresh | 网关注意事项 |
|---|---|---|---|---|
| Notion MCP | **仅 OAuth DCR**，无 API key / bearer 模式 | ~1h | 每次使用**单次轮换** | 必须网关独立授权；共享 grant 会被 DSH 顶掉；`offline_access` 必须请求 |
| Linear 官方 MCP | **仅 OAuth**。PAT 只对 GraphQL API 有效，不能用于官方 MCP | ~24h | 轮换 | 必须网关独立授权；缺 `obtainedAt` 会把过期 token 伪造成新鲜（已修） |
| Vercel MCP | OAuth | ~1h | **仅当授权请求包含 `offline_access` 时才下发 refresh token** | 未请求 offline_access 会每小时掉线（oh-my-pi issue #9909）；本仓库当前 Vercel 配置无 refreshUrl/clientId，按静态 token 处理，过期显式报 `STATIC_TOKEN_NO_REFRESH` |
| GitHub | 静态 PAT（非 OAuth 轮换） | 长期 | 无 | 不走 refresh 路径 |

`src/upstream-auth.js` 导出 `OAUTH_PROVIDER_FACTS` / `requiredScopes(server)`；gateway-owned 授权必须带上 `requiredScopes()` 返回的 scope（目前 notion/linear/vercel 都是 `offline_access`），否则缺少 refresh token 时运行时显式报 `STATIC_TOKEN_NO_REFRESH`，而不是假装能刷新。

---

## 4. 测试（`tests/upstream-token-lifecycle.test.js`，23 条，fake store/fetch，零网络）

- **A 组**：bootstrap 失败只刷新一次不循环；旋转记录冷启动不重建；并发冷启动只 seed+refresh 一次。
- **B 组**：lease owner UUID + 只能由 owner 释放；`TokenStore.releaseLease` / `renewLease` 的 Lua 脚本形态。
- **C 组**：并发只调用 provider 一次；锁内二次读发现 winner 已刷新则不再调用 provider；CAS 失败读 winner 且不写回旧 token。
- **D 组**：invalid_grant → REAUTH_REQUIRED 且不重试；输家的 invalid_grant 不误杀已旋转的 winner；只有新 env grant 才解除终态。
- **E 组**：resolveEnvironment 映射；preview/production 的 KV 与失效状态完全隔离；preview invalid_grant 不影响 production。
- **F 组**：静态 token 无 provider 调用；Vercel 401 → REAUTH_REQUIRED/STATIC_TOKEN_NO_REFRESH；错误类型字段完整。
- **G 组**：DSH-sourced grant 标记 owner=dsh 且拒绝刷新（含 force 401）；owner 命名空间隔离；长期 token 路径；gateway-owned grant 正常刷新并保留 owner。

验证命令：
```
node --test tests/upstream-token-lifecycle.test.js   # 23/23
npm test                                              # 924 total, 918 pass, 0 fail, 6 todo
```

---

## 5. 运维步骤（部署前必读）

### 5.1 一次性迁移：让网关拥有自己的 grant

1. **停止共享**：不要把 DSH 导出的 refresh token（vault 里 `source=dsh-mcp-connector-oauth-grant` 的条目）再作为网关的 `NOTION_REFRESH_TOKEN` / `LINEAR_REFRESH_TOKEN` 使用。
2. **网关独立授权**：用网关自己的 OAuth DCR 流程（`GET /upstream/oauth/start?server=notion|linear`）走一次授权；授权请求必须含 `offline_access`（`requiredScopes()`）。拿到 gateway-owned 的 refresh token。
3. **显式标记 owner**：写 KV 时通过 `seed({ grantOwner:'gateway', source:'gateway-oauth' })`，或在 server config 里设 `grantOwner`/`grantSource`（也可用 `grantOwnerEnv`/`grantSourceEnv` 指向环境变量）。未标记的历史记录默认按 gateway 处理以兼容线上，但**新授权必须显式标记**。
4. **环境隔离**：Vercel 生产设 `VERCEL_ENV=production`（平台自动注入）；本地/测试设 `GMCGW_ENVIRONMENT=development|preview`。preview 部署绝不能拿到生产的 refresh token 环境变量。
5. **不要 commit 任何 token**；真实凭据只在 vault / Vercel env / KV。

### 5.2 Vercel

- 当前 Vercel 上游是静态 token：过期后网关报 `STATIC_TOKEN_NO_REFRESH`，需要换长期 token 或补齐 `refreshUrl` + `clientIdEnv` 并让 OAuth 授权请求 `offline_access` 后重新授权。
- **不要用"再部署一次"试图修复过期 token**——那只会在日志里留下同样的 REAUTH_REQUIRED。

### 5.3 观察与回滚

- 日志关键字：`SHARED_GRANT_REFRESH_FORBIDDEN`、`REAUTH_REQUIRED`、`STATIC_TOKEN_NO_REFRESH`、`cas_lost`、`shared_grant_refresh_refused`、`env=preview|production`。
- `getAuthStatus(server)` 返回 `{status, reason, at}`；`status=REAUTH_REQUIRED` 时不要重试，按 reason 处理。
- 回滚本批：恢复旧 `src/upstream-auth.js` / `src/upstreams.js` / `src/store.js`；注意旧代码会恢复共享 grant 刷新行为，**回滚即回到反复失效状态**，仅在迁移失败且已停用共享 grant 时考虑。

---

## 6. 如何判断"账号坏了 vs 网关坏了"

| 现象 | 判断 | 依据 / 动作 |
|---|---|---|
| 同一个 Linear/Notion 账号在 DSH 里正常、只有网关失效 | **网关坏**（几乎必然） | DSH 单 owner 正常说明 grant family 没坏；查网关是否刷新了 DSH 的 grant、是否多实例并发、是否 preview 烧生产。用户明确指出"其他平台/Agent 多年不失效"正是这个判据 |
| 网关报 `SHARED_GRANT_REFRESH_FORBIDDEN` | **配置坏**（共享 grant 未迁移） | 按 5.1 做网关独立授权；不是账号问题 |
| 网关报 `STATIC_TOKEN_NO_REFRESH`（Vercel） | **配置坏**（缺 refresh 能力） | 换长期 token 或补 OAuth + offline_access |
| 网关报 `REAUTH_REQUIRED` 且 reason=`invalid_grant`，但 DSH 同一 grant 也失效 | **账号/授权真的坏了** | 此时才需要重新授权；授权后同时更新网关 KV 与（如仍共享）DSH |
| 只有某个环境（preview）坏，production 正常 | **网关环境隔离问题** | 检查 VERCEL_ENV / GMCGW_ENVIRONMENT 与 KV 命名空间；本批已隔离 |
| 冷启动后第一次调用失败、后续正常 | 网关 bootstrap 循环（本批已修） | 旧代码 `bootstrapped` 未清会导致每次刷新；现在只尝试一次 |
| provider 返回 401 但 KV 显示"未过期" | **网关坏**（本地时间戳误判） | provider 401 才是权威；本批 force 刷新路径已覆盖，且 DSH-sourced grant 直接拒绝刷新 |

判据一句话：**上游账号在别的客户端正常、只有网关坏 → 先怀疑网关的 grant ownership 与并发实现，永远不要先让用户重授权。**

---

## 7. 副作用与残余风险（诚实记录）

- production 保留 legacy key（为了不丢线上已旋转的 pair），因此默认环境下 DSH-shared 与 gateway 记录若都未显式标 owner 仍会落在同一个 key 上；**必须靠显式 `grantOwner`/`source` 区分**。这是为向后兼容做的取舍。
- `SHARED_GRANT_REFRESH_FORBIDDEN` 意味着共享 grant 的 access token 到期后网关会直接失败——这是**故意的**：继续刷新只会把 DSH 也弄坏。用户会看到一次明确提示，而不是反复失效。
- `src/upstream-oauth.js` 的回调目前通过 `UpstreamAuth.seed()` 写入，默认 owner=gateway；如果将来要从 DSH 导入 grant，必须显式传 `grantOwner:'dsh'` 并确保它被隔离到 owner 命名空间。
- 未实现 DSH-as-broker 方案（需要 DSH 侧接口），第 0 节方案 2 仅为路线说明。
- 未改 config.example.json / 其他文件：Vercel 是否补齐 OAuth 配置属于部署决策，留给 lead/用户按 5.2 决定。
