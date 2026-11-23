# B15 — 网关独立 OAuth grant 架构（绝不共享 DSH refresh token）

> 状态：设计稿（只写文档；不改 `src/`、`scripts/`、`tests/`、其它 docs、workflows；不 commit / push / deploy）。
> 归属：`auth-architecture` agent，对应 `docs/ledger/batch-15-auth.md` 中的 `auth-architecture` 行。
> 证据来源（本次实际读取）：`src/upstream-auth.js`、`src/upstreams.js`、`src/store.js`、
> `src/upstream-oauth.js`、`src/config.js`、`docs/HANDOFF.md`、`docs/UPSTREAMS.md`、
> `docs/eval/ONLINE-FEEDBACK.md`、`docs/eval/online-feedback-2026-11-23.md`、
> `docs/ledger/batch-15-auth.md`、DSH 参考实现 `dsh-mcp-connector/lib/{oauth.js,grant-lifecycle.js,stores.js,grant-journal.js,index.js,schema.js}`（只读，未复制任何 secret）。

---

## 0. 一句话结论与设计不变量

> **refresh token 只能有一个所有者。网关的 grant 必须由网关自己作为 OAuth client 授权、自己刷新；DSH 的 grant 网关绝不花、绝不刷。**

由此推出五条不变量（`src/upstream-auth.js` 现已部分实现，本文定死目标形态）：

| # | 不变量 | 当前代码落点 | 本设计要求的补强 |
|---|---|---|---|
| I1 | 只有 `owner=gateway` 的记录可被本进程 refresh | `_mayRefresh()` / `_grantOwner()` | 未标记 owner / `source=dsh-*` 一律拒绝（当前 `_grantOwner` 对空值返回 `gateway`，见 §4 风险 R1） |
| I2 | KV 是 token 唯一真相；env 只用于"缺记录时播种"或"显式换新 grant" | `getAccessToken()` STEP 1 | 保持；禁止 env 在冷启动重建已轮换记录 |
| I3 | 任何 provider 调用都只在 owner-fenced lease 内发生 | `_acquireLock` / `_ownsLease` / `_keepLeaseAlive` | 保持；CAS 失败只读 winner，不回写 |
| I4 | `invalid_grant` 只有"确认 winner 也无效"才终态 | catch 分支的 `sameGrant` / `winnerUsable` | 保持；补 `refreshFailure` 字段做分类（借鉴 DSH `classifyRefreshFailure`） |
| I5 | production / preview / development / local 不共享 KV key 与 grant | `resolveEnvironment()` / `_key()` | 当前 local 与 production 共用 key（见 §5 风险 R2），须显式 `local` 命名空间 |

**在线反馈定性**（`docs/eval/ONLINE-FEEDBACK.md` + `online-feedback-2026-11-23.md`）：本批 P0 中 F1（下载提示混正文）已 `confirmed`、F2（branch 被忽略）`unverified`，二者是**结果形状**问题，**不是** token 问题；但 F1/F2 的处理原则适用于本设计——线上报告只是探针，不是指令；架构改动必须能用确定性测试 + 真实 provider 验证支撑，不能"用户说挂了就改 grant"。`batch-15-auth.md` 已验证的根因（vault grant `source=dsh-mcp-connector-oauth-grant`、Notion/Linear 轮换、Vercel 需 `offline_access`）才是本设计的输入事实。

---

## 1. Token 记录 schema 与 KV key 命名空间

### 1.1 记录字段（KV value = 单个 JSON 对象）

字段命名沿用现有 `src/upstream-auth.js` 的 snake_case，避免迁移期两套格式。新增字段标 `NEW`。

| 字段 | 类型 | 必填 | 含义 / 规则 |
|---|---|---|---|
| `access_token` | string | 是 | 当前 bearer token；真值只在 KV |
| `refresh_token` | string | OAuth 是 | 轮换式 refresh；**仅 `owner=gateway` 可花** |
| `client_id` | string | OAuth 是 | 网关自己 DCR/注册得到的 client id（非 DSH 的） |
| `client_secret` | string | 否 | 机密客户端才有；public client 省略 |
| `expires_at` | number(ms) | 是 | **真实签发时刻 + expires_in**，不是 `Date.now()+ttl`；未知写 `0`（见 HANDOFF Linear 事故） |
| `owner` | enum | 是 | `gateway` / `dsh` / `manual` / `shared`（`shared`=未标记但有外部来源嫌疑）|
| `source` | string | 是 | `gateway-oauth` / `gateway-dcr` / `dsh-mcp-connector-oauth-grant` / `manual` / `static` |
| `grantId` `NEW` | string | 是 | 网关内部 grant 标识 `gw:<env>:<server>:<shortHash(issuer\|clientId\|scope)>`；一次授权一个，轮换不改；用于 journal/审计/迁移对账 |
| `environment` `NEW` | enum | 是 | `production` / `preview` / `development` / `local`；**必须与 key 中的 env 一致，不一致视为污染并拒绝 refresh** |
| `needsReauth` | boolean | 是 | 终态；只有"换一个不同的 grantId + 新 seed"才能清除 |
| `status` | string `NEW` | 否 | `ACTIVE` / `REAUTH_REQUIRED`，与 `needsReauth` 冗余但便于 `getAuthStatus()` |
| `reauthReason` `NEW` | enum | 否 | `invalid_grant` / `shared_grant_refresh_forbidden` / `static_token_no_refresh` / `client_secret_expired` / `refresh_lock_timeout` |
| `needsReauthAt` | number(ms) `NEW` | 否 | 进入终态时刻 |
| `refreshFailure` `NEW` | object | 否 | `{kind:'permanent'\|'transient', code, httpStatus?, message, failureCount, retryAt?}`，借鉴 DSH `classifyRefreshFailure` + `refreshRetryDelay`，日志必须过脱敏 |
| `envSeed` | string | 是 | 首次 seed 的 access_token 指纹，防冷启动重建；轮换后保留 |
| `bootstrapped` | boolean | 是 | 一次性 bootstrap 刷新标记；**任何一次 refresh 尝试后无论成败都置 false** |
| `authorizedResources` `NEW` | string[] | 否 | 多资源 grant（Notion/Linear）记录 audience，刷新时避免按第一个 resource 收窄（借鉴 DSH `refreshGrant`）|
| `updatedAt` `NEW` | number(ms) | 否 | 最后写入时刻；跨实例判断 winner 用 |

**校验不变量（写入前 assert）**：

```text
assert(owner ∈ {gateway,dsh,manual,shared})
assert(source 存在)
assert(environment === key 中的 env)
assert(grantId 匹配 gw:<environment>:<server>:<hash>)
assert(owner !== 'gateway' || refresh_token != null || reauthReason === 'static_token_no_refresh')
```

### 1.2 KV key 命名空间（Upstash Redis REST，hash 索引沿用 `TokenStore`）

现有 `src/upstream-auth.js::_key()` 已做 env+owner 前缀，但 `production+gateway` 特例保留 legacy key。本设计改为**全量显式命名空间**（`v2`），旧 key 只读迁移，见 §6。

```text
gmcgw:v2:grant:<environment>:<owner>:<server>            # 主记录（token pair）
  env      ∈ production | preview | development | local
  owner    ∈ gateway | dsh | manual | shared
  server   = config.name（如 notion/linear/vercel）

gmcgw:v2:grant:<environment>:<owner>:<server>:lock        # owner-fenced lease（值 = {owner:<uuid>,expiresAt}）
gmcgw:v2:grant:<environment>:<owner>:<server>:journal     # NEW：每次轮换的记录（只追加/覆盖最新 + hash 链，见 §3.4）
gmcgw:v2:grant:<environment>:<owner>:<server>:status      # NEW：可选，getAuthStatus 的持久镜像

# 现有的 OAuth 临时态（src/store.js）保持不变，但补 env 前缀：
gmcgw:v1:oauthstate:<hash(state)>                          # 一次性 PKCE state，TTL 10min（当前实现）
```

示例：

```text
gmcgw:v2:grant:production:gateway:notion       ← 网关自己的 Notion DCR grant（唯一可刷）
gmcgw:v2:grant:production:dsh:notion           ← DSH 导出的共享 grant（只读，永不刷）
gmcgw:v2:grant:preview:gateway:notion          ← preview 独立 grant
gmcgw:v2:grant:local:gateway:notion            ← 本地独立 grant（不再借 production）
```

> **注意**：`production:gateway:*` 从 legacy 的 `gmcgw:v1:upstream:<server>` 迁来时保留旧 key 的一个只读别名，迁移完成并观察一个刷新周期后删除别名（§6.4）。`preview/development` 当前是 `gmcgw:v1:upstream:<env>:<server>`，迁移脚本必须同时识别这两种旧形态。

---

## 2. Gateway-owned OAuth provisioning（一次性授权流程）

### 2.1 三个 provider 的获取方式（事实来自 `src/upstream-auth.js::OAUTH_PROVIDER_FACTS` + `docs/ledger/batch-15-auth.md`）

| provider | 授权形态 | client 来源 | scope 要点 | refresh | 网关动作 |
|---|---|---|---|---|---|
| **Notion** | OAuth 2.1 **DCR only**（无 API key / Bearer 模式） | DCR 动态注册（RFC 7591）：`POST registration_endpoint` → `client_id`(+可选 `client_secret`)，grant_types `authorization_code`+`refresh_token` | `offline_access`（+ 业务 scope）；access ~1h | **每次轮换**，单次使用 | 走通用授权码 + PKCE；DCR 注册结果随 grant 落 KV（`grantId` + client 元数据），轮换不重复注册 |
| **Linear** | OAuth（官方 MCP 只认 OAuth；PAT 仅 GraphQL API 可用） | 在 Linear 应用面板**预注册** confidential/public client，client id 入 env `LINEAR_CLIENT_ID` | `offline_access`；access ~24h | **轮换** | 用 `/upstream/oauth/start` 走授权码 + PKCE（现有 `src/upstream-oauth.js`），换新 client id 时配置变更 |
| **Vercel** | OAuth（Vercel MCP access ~1h） | 预注册 client，client id 入 env | **必须在 authorize 请求带 `offline_access`**，否则无 refresh token → 回到 `STATIC_TOKEN_NO_REFRESH` | 轮换（若有 offline_access） | 同上；**授权 URL 必须含 offline_access**，否则回调里没有 refresh_token，显式告警 |

### 2.2 一次性授权状态机

沿用并补强现有 `src/upstream-oauth.js`（start → callback → `UpstreamAuth.seed()`）与 DSH `oauth.js` 的 RFC 8414/9728 发现 + PKCE S256：

```text
[operator] GET /upstream/oauth/start?server=<s>&key=<ADMIN_KEY>&env=<environment>
     │  admin key 恒定时间比较（现有 safeEqual）；env 参数必填且 ∈ 四环境
     ▼
START: 生成 state(24B) + verifier(48B) + challenge=S256
     │  store.saveOAuthState(state, {server, verifier, redirectUri, environment, createdAt, grantId})
     │  （grantId 预分配，便于回调时写入；state TTL 10min，GETDEL 一次性）
     ▼
AUTH_URL: authorize?response_type=code&client_id&redirect_uri&scope&state&code_challenge&challenge_method=S256
     │  scope 必须包含 offline_access（OAUTH_PROVIDER_FACTS.requiredScopes）
     │  Notion DCR 时先 registerClient() 得到 client_id（可缓存到 KV 的 client 记录）
     ▼
[用户在 provider 页面同意] → GET /upstream/oauth/callback?code&state
     ▼
CALLBACK:
     │  1. takeOAuthState(state)  → 不存在/过期 → 400（一次性）
     │  2. exchangeCode(tokenEndpoint, {code, verifier, client_id, [client_secret], redirect_uri})
     │  3. assert refresh_token 存在；缺失 → 400 + 明确告警 "offline_access 未生效"
     │  4. 构造记录（§1.1）：owner='gateway', source='gateway-oauth'/'gateway-dcr',
     │     grantId, environment, expires_at=now+expires_in*1000, bootstrapped=false,
     │     needsReauth=false, envSeed=access_token 指纹
     │  5. seed(KV key=<env>/gateway/<server>, force=true) ← 只覆盖本 owner+env 命名空间
     ▼
ACTIVE（首次 refresh 由正常 expiry skew 触发，不再有 bootstrap 强制刷新）
```

失败分类（借鉴 DSH `grant-lifecycle.js`，但**只在网关进程内记录，不自动重试无限循环**）：

| 情况 | 分类 | 动作 |
|---|---|---|
| `invalid_grant` / `invalid_client` / `unauthorized_client` / `missing_refresh_token` / 401/403 | permanent | 写 `needsReauth=true` + `reauthReason`（CAS 保护），停止自动刷新 |
| 网络错误 / 5xx / 超时 / 未知 | transient | 按 `refreshRetryDelay(count, base, max)` 指数退避，**有上限**（DSH 有 timer 自动重排；serverless 无稳定 timer，改由下次请求触发 + `retryAt` 门控） |

### 2.3 存储 / 迁移要求（本设计提出，代码改动不在本批）

- **必须修的既有缺陷**：`src/upstream-oauth.js:200` 目前 `new UpstreamAuth({ store, fetch })` 没传 `environment`，`seed()` 也没传 `grantOwner`/`source`/`grantId`；结果是网关授权落到 legacy production key 且没有环境隔离。按本设计要求：handler 从 start 的 `env` 参数（默认 `resolveEnvironment()`，但 admin 授权必须显式传）构造 `new UpstreamAuth({store, environment: env})`，seed 时带齐 `owner:'gateway'`, `source:'gateway-dcr'|'gateway-oauth'`, `grantId`, `environment: env`。
- **DCR client 注册信息**（Notion）持久化在 `gmcgw:v2:client:<env>:<server>`（value 含 `client_id`、可选 `client_secret` 的 hash + 密文按 `TokenStore` 现有规则），轮换 grant 时复用，不重复 DCR。
- 授权回调只写 `<env>/gateway/<server>` 命名空间；**永不写 `<env>/dsh/*`**。

---

## 3. 单 refresher：owner-fenced lease + 锁内二次读 + CAS

### 3.1 状态机（对齐现有 `upstream-auth.js` 顶部注释并补 journal）

```text
(no record)            --seed(env|oauth callback)-->  SEEDING(grantId 已分配)
SEEDING                --lease 内一次 refresh 成功--> ACTIVE
SEEDING                --尝试失败-->                 ACTIVE(bootstrapped=false；无循环)
ACTIVE                 --expiry-skew / provider 401--> REFRESHING
REFRESHING             --CAS win-->                  ACTIVE(新 pair + journal 追加)
REFRESHING             --CAS lose-->                 读 winner 并 adopt，绝不回写自己的结果
REFRESHING             --invalid_grant 且 winner 无效--> REAUTH_REQUIRED(终态, CAS-guarded)
REFRESHING             --transient-->                ACTIVE + refreshFailure.transient + retryAt
REAUTH_REQUIRED        --不同 grantId 的新授权 seed--> SEEDING
任意状态               --owner≠gateway-->            使用 access token，但禁止 refresh（§4）
```

### 3.2 刷新伪代码（目标形态；现有代码已基本实现，标注必保点）

```pseudo
getAccessToken(server, seedInputs):
  rec = KVGET(key(env,'gateway',server))            # 只认 gateway 命名空间
  if (needsSeed(rec, seedInputs)):                  # 缺记录或 grantId 不同
      owner = acquireLease(key, ttl=60s, owner=uuid)   # SET NX EX
      if !owner: wait(1200ms); return KVGET(...).access_token ?? seed.access_token
      try:
          latest = KVGET(key)                        # 锁内二次读
          if latest && latest.grantId === seed.grantId: rec = latest
          else: rec = seedRecord(...); CAS-seed 或 SET（仅 seed 路径允许 SET）
      finally: releaseLease(key, owner)              # Lua compare-and-delete

  if rec.needsReauth: return rec.access_token        # 终态，永不重试
  if !shouldRefresh(rec): return rec.access_token

  # ── owner fence（最深根因） ─────────────────────────────
  if rec.owner !== 'gateway' || rec.environment !== env || isDshSource(rec.source):
      markStatus('REAUTH_REQUIRED', 'shared_grant_refresh_forbidden')
      emit warn(server, owner, source)               # 不打印 token
      return rec.access_token                        # 只使用现有 access token

  if !rec.refresh_token:
      markStatus('REAUTH_REQUIRED', 'static_token_no_refresh'); return rec.access_token

  # ── 单 refresher ────────────────────────────────────────
  lease = acquireLease(key, ttl=60s, owner=uuid)     # 失败关闭：backend error → 不刷
  if !lease:
      wait(1200ms); fresh = KVGET(key)
      return (fresh.usable && fresh.access_token !== rec.access_token)
             ? fresh.access_token : rec.access_token

  stopKeepalive = renewLeaseEvery(20s, lease)        # 仅当仍持有 owner 才续
  try:
      latest = KVGET(key)                            # 锁内二次读（必须）
      if latest.access_token !== rec.access_token && !needsRefresh(latest):
          return latest.access_token                 # winner 已产出
      if latest.needsReauth: return latest.access_token

      next = callProviderRefresh(latest)             # provider 调用只在锁内
      if !ownsLease(lease):                          # 租约中途丢失
          return KVGET(key).access_token ?? next.access_token  # 信 winner，不信自己

      ok = CAS(key, expectedRefresh=latest.refresh_token, value=next)
      if !ok:
          winner = KVGET(key)
          emit('cas_lost'); return winner.access_token   # 绝不写回自己的结果

      journalAppend(key, next)                       # 借鉴 DSH GrantJournal，见 §3.4
      clearStatus(); return next.access_token
  catch e:
      f = classifyRefreshFailure(e)                  # permanent / transient + 脱敏
      if f.permanent:
          winner = KVGET(key)
          sameGrant = winner.refresh_token === latest.refresh_token
          winnerUsable = winner.access_token && !winner.needsReauth && !sameGrant
          if sameGrant && !winnerUsable: markReauth(latest, f.code)   # CAS-guarded
          else: emit('invalid_grant_loser'); return winner.access_token
      else:
          write refreshFailure.transient + retryAt（不写 needsReauth）
          if rec.bootstrapped: clearBootstrap(CAS-guarded)
      return rec.access_token
  finally:
      stopKeepalive(); releaseLease(key, lease)      # Lua 只删自己的
```

**必须保留的现有代码细节**（逐条对照 `src/upstream-auth.js`）：

1. `_acquireLock()` 用 `SET key value NX EX ttl`，owner 是 `randomUUID()`；失败返回 `null`（含 backend 异常），**绝不降级为无锁刷新**。
2. `_releaseLock()` 优先 `TokenStore.releaseLease()`（Lua `cjson.decode` + owner 比对 + DEL）；退化路径也先 get 再比对 owner。
3. `_ownsLease()` 在 commit 前再次确认；`_keepLeaseAlive()` 每 20s  renew，且只在 owner 仍是自己时更新 `expiresAt`。
4. `_refresh()` 的 CAS 以 `rec.refresh_token` 为 fencing token；CAS 失败读 winner 并 `captureEvent('upstream_auth',{phase:'cas_lost'})`。
5. `invalid_grant` 终态写入用 `_saveTerminal()`（先读、比对 refresh token 未变、再 CAS 写 patch）；**绝不能是一个裸 SET**——历史上 loser 覆盖 winner 就是因为这个。
6. `bootstrapped` 在任何一次 refresh 尝试（成功或失败）后都清掉——这是 Notion"刷太多"的直接修复。

### 3.3 锁语义对比表（网关 vs DSH）

| 维度 | DSH（`grant-journal.js` / `index.js`） | 网关目标 |
|---|---|---|
| 跨进程互斥 | 文件系统 `open('wx')` + stale lock 5min + owner 校验删除 | Redis `SET NX EX` + Lua compare-and-delete；fencing CAS 是真正保证 |
| 同进程去重 | `entry.refreshPromise`（同一 grant 并发调用共享一个 Promise） | **借鉴**：在 `UpstreamAuth` 实例上加 `Map<key, Promise>`，单实例并发只发一次 provider 调用；跨实例仍靠 lease |
| 锁内重读 | `grantStore.get()` 从独立 journal 读（不信进程内存） | 锁内 `KVGET` 重读（不信第一次读的 `rec`） |
| 失败分类 | `classifyRefreshFailure()` permanent/transient + 指数退避 | 借鉴分类 + `retryAt`；serverless 不做定时器自动重排 |
| winner 采用 | `persisted.updatedAt > observed.updatedAt && refreshToken 不同` → adopt | 用 CAS + refresh_token 比对；不依赖时钟戳做 liveness 判断（HANDOFF Linear 事故：时间戳"新"但 token 已被拒） |
| journal | 独立文件、每 grant 一个、0700/0600、先落 journal 再落 domain table | 见下 |

### 3.4 借鉴什么、不照搬什么（明确边界）

**借鉴**（思想是通用的，不复制实现/secret）：

- grant journal 的**"先写独立轮换记录，再写主表"**顺序：主表可能被旧实例整文件/整值覆盖，独立记录能找回最新轮换 token。网关对应 Redis key `...:journal`（只保存最近 N 条轮换摘要：`refreshTokenHash`、`accessTokenHash`、`at`、`grantId`；**不存明文 token**——`TokenStore._prepare` 既有 hash 规则）。
- `refreshPromise` 同进程合并（§3.3）。
- `classifyRefreshFailure` + `redactOAuthDetail`（日志脱敏；禁止把 `Authorization`/`refresh_token` 打到 capture/console）。
- `scheduleRefresh` 的"真实 expiry 用于调度、skew 不能伪造签发时间"原则。

**不照搬**（DSH 是桌面多 Host 长驻进程，网关是 Vercel serverless）：

| 不照搬 | 原因 |
|---|---|
| 文件锁 / `$DSH_HOME/storages` 目录 | serverless 无共享文件系统；用 Redis lease |
| 基于 `setTimeout` 的定时刷新 `scheduleRefresh` | 实例随时被回收，定时器不可靠；改为"请求触发 + retryAt 门控" |
| DSH JSON domain 的 last-write-wins + journal 双写 | 网关 KV 本身有 CAS；不需要 domain/journal 双写一致性层，只保留 journal 作为审计/恢复的**只读追加** |
| `legacySource`/跨插件迁移状态机 | 网关没有 DSH 插件体系；共享 grant 直接拒绝刷新即可 |
| `revokeRefreshToken` 自动撤销 | 撤销别人的 grant 会打断 DSH；网关只撤销自己 `owner=gateway` 的 grant，且需显式操作 |

---

## 4. Shared-grant 保护（owner=dsh / 未标记 → 拒绝自动 refresh）

### 4.1 判定规则（按优先级短路）

```pseudo
function grantOwner(rec, opts):
  explicit = lower(opts.grantOwner ?? opts.source ?? rec?.owner ?? rec?.source ?? '')
  if !explicit:
      # R1 修复点：当前代码默认返回 'gateway'（兼容旧记录），
      # 新架构要求「未标记 = 不可信」；仅 legacy key 迁移窗口内允许 gateway 默认。
      return isLegacyKey ? 'gateway' : 'shared'
  if explicit.includes('dsh') || explicit === 'dsh-mcp-connector-oauth-grant': return 'dsh'
  if explicit === 'gateway' || explicit.includes('gateway'): return 'gateway'
  if explicit === 'manual': return 'manual'
  return 'shared'
```

### 4.2 行为矩阵

| 记录特征 | 能否使用 access token | 能否自动 refresh | 告警 |
|---|---|---|---|
| `owner=gateway` + `source=gateway-*` + key 在 `.../gateway/...` | ✅ | ✅（走 §3） | 无 |
| `owner=dsh` 或 `source=dsh-*` | ✅（在过期前） | ❌ 永久 | `SHARED_GRANT_REFRESH_FORBIDDEN`，每实例每 server 去重告警；capture `phase=shared_grant_refresh_refused` |
| `owner=manual` | ✅ | ❌ | 同上（reason 注明 manual） |
| owner 未标记（新 key） | ✅ | ❌（视为 shared） | `SHARED_GRANT_REFRESH_FORBIDDEN` + "owner 未标记" |
| owner 未标记（legacy key，迁移窗口） | ✅ | ⚠️ 仅当 `source` 也缺失且记录来自旧 seed | 迁移告警，要求尽快重新授权 |
| 无 refresh_token（static / Vercel 未带 offline_access） | ✅ | ❌ | `STATIC_TOKEN_NO_REFRESH`，提示补齐 `offline_access` 或长期 token |

### 4.3 显式告警文本（不打印 token）

```text
[upstream-auth] <server> SHARED_GRANT_REFRESH_FORBIDDEN: grant owner=<owner> source=<source>;
DSH 与网关不能共用同一个 rotating refresh token —— 请使用网关独立 OAuth grant
（owner=gateway, source=gateway-oauth|gateway-dcr）或改用长期 access token。
```

`upstreams.js` 的 401 兜底路径（`isAuthError` → `force:true` 再刷新一次）也受同一 owner fence 约束：shared grant 即使 provider 返回 401，也**不会**花 refresh token，只会把 `getAuthStatus()` 的 `REAUTH_REQUIRED` 报给调用方（现有代码在 `_resolveToken` 里已经检查 `authStatus.status === REAUTH_REQUIRED` 并跳过重连）。

---

## 5. Environment 隔离（production / preview / development / local）

### 5.1 规则

- 每个环境的 KV key、grantId、lease、journal **完全分离**（§1.2）。
- `environment` 必须从部署元数据解析：Vercel 用 `VERCEL_ENV`（production/preview/development）；本地显式 `GMCGW_ENVIRONMENT=local`；`GMCGW_ENVIRONMENT` 覆盖优先级最高。
- **拒绝跨环境读取**：记录里的 `environment` 字段与 key 不一致 → 视为污染，禁止 refresh + 告警（不静默使用）。
- **授权入口带 env**：`/upstream/oauth/start` 必须显式传 `env=`；admin key 持有者才能为 preview 授权；preview 的回调只写 preview key。
- **preview 绝不读 production grant**：没有 fallback 到无后缀 key 的逻辑；缺失即"未授权"，走 seed 路径。

### 5.2 当前代码与目标差距（风险 R2）

`src/upstream-auth.js::resolveEnvironment()` 现在只在 `GMCGW_ENVIRONMENT ∈ {production,preview,development}` 时返回，否则回落到 `VERCEL_ENV`，再否则返回 `'production'`。这意味着**本地开发（既无 VERCEL_ENV 也无 GMCGW_ENVIRONMENT）会读写 production key**——本地一次冷启动 refresh 就可能烧掉线上 grant。本设计要求：

```text
resolveEnvironment(env):
  explicit = lower(env.GMCGW_ENVIRONMENT ?? '')
  if explicit ∈ {production,preview,development,local}: return explicit
  vercel = lower(env.VERCEL_ENV ?? '')
  if vercel ∈ {production,preview,development}: return vercel
  if env.VERCEL === '1': return 'preview'      # 兜底：Vercel 上绝不默认 production
  return 'local'                               # 修复 R2：本地默认 local，非 production
```

迁移期例外：legacy `gmcgw:v1:upstream:<server>` 只有 production 一份，`production+gateway` 的读路径在 §6 迁移窗口内保留别名；迁移完成即删。

---

## 6. 迁移步骤：旧 KV 记录 → 网关独立 grant

### 6.1 旧记录盘点（来自 `docs/HANDOFF.md` / `batch-15-auth.md`）

| 旧记录来源 | 旧 key 形态 | 问题 | 处置 |
|---|---|---|---|
| vault 导入的 Notion/Linear grant | `gmcgw:v1:upstream:<server>`，`source=dsh-mcp-connector-oauth-grant` | 与 DSH 共用轮换 refresh token | **不迁移 grant 本身**；作为 `owner=dsh` 只读快照保留到 §6.4 |
| 已有的网关授权（若有） | `gmcgw:v1:upstream:<server>`，`source=gateway-oauth` | 无 `grantId`/`environment`；prod key 无后缀 | 复制+补字段到 v2（仅 owner=gateway） |
| preview/development 旧记录 | `gmcgw:v1:upstream:<env>:<server>` | 环境前缀规则不同 | 复制+补字段到 v2 对应 env |

### 6.2 迁移步骤（分阶段，间可观察）

```text
阶段 A（只读盘点，不写生产）
  A1. 用运维脚本（本设计不写脚本，仅描述）GET 所有 gmcgw:v1:upstream:* key；
      只输出 {key, owner(推断), source, environment(推断), refreshTokenHash, needsReauth} —
      禁止输出明文 token。
  A2. 分类：dsh-source / gateway-source / 未标记；列出每个 server × env 的处置。

阶段 B（网关独立授权，先建新后切流）
  B1. 对每个 OAuth provider 走 §2 的 /upstream/oauth/start?env=<env>（Notion DCR、
      Linear 预注册 client、Vercel 带 offline_access）→ 回调写入 gmcgw:v2:grant:<env>:gateway:<server>。
  B2. 验证新 grant：getAuthStatus()=ACTIVE；一次真实 tools/list 成功；
      观察一次正常到期刷新（或 force 一次）确认 CAS/journal 正常。
  B3. 确认 provider 端旧 grant 与新 grant 是两个独立 client（尤其 Notion DCR 的 client_id 不同）。

阶段 C（切流）
  C1. 部署配置把读取指向 v2 key（代码改造，不在本批）；env 解析按 §5.2。
  C2. 旧 dsh-source 记录原地改标 owner='dsh', source='dsh-mcp-connector-oauth-grant',
      needsReauth 保持原值；serverless 读到它只会用 access token + 告警，不刷。
  C3. 监控 1~2 个 provider 的 token 寿命周期（Notion ~1h、Linear ~24h、Vercel ~1h），
      确认没有 invalid_grant / 重复授权请求。

阶段 D（清理）
  D1. 删除 production 旧 key 的只读别名与 gmcgw:v1:upstream:* 中的 dsh 记录（保留审计 hash）。
  D2. 从 vault / Vercel env 中移除 DSH 导出的 refresh token 变量（env 不再是真相）。
```

### 6.3 用户一次重授权流程（人肉步骤，尽量只做一次）

1. 运维触发 `/upstream/oauth/start?server=<s>&env=<env>&key=<ADMIN_KEY>`。
2. 浏览器跳到 provider，用户**只同意一次**（scope 含 `offline_access`）。
3. 回调自动 seed v2 key；页面显示"Connected"，不要求重连 Gemini（工具 schema 未变，见 `docs/HANDOFF.md`）。
4. 若回调报 "no refresh_token" → 说明 offline_access 未生效，重新走 start（这是授权配置问题，不是 grant 坏了）。
5. 对每个 env 各做一次；**不要**用同一个授权码/refresh token 跨 env 播种。

### 6.4 回滚方案（按可逆性分级）

| 场景 | 回滚动作 | 风险 |
|---|---|---|
| 新 grant 授权失败 / provider 拒绝 | 保留旧 gateway-source v2 记录不动；配置指回 legacy key（只读别名仍在） | 旧 gateway grant 可能已临近过期，回滚后只能撑一个 token 周期 |
| 切流后有 `invalid_grant` 且确认非并发问题 | 立即把配置指回 legacy **gateway-source** key（绝不能指回 dsh-source 记录）；重新走 B1 | dsh-source 记录永远不能作为回滚目标 |
| journal / CAS 异常 | 关闭 journal 写（只读），退回纯 KV CAS + lease（现有代码路径本来就不依赖 journal 正确性） | 失去轮换审计，不影响刷新正确性 |
| 环境隔离导致 preview 无 token | 为 preview 单独授权（B1），不要复制 production key | 复制会重新引入跨环境烧 grant 风险 |
| 完全回退到旧架构 | 恢复 v1 key 读取 + 旧 owner 默认；**但 dsh grant 仍然必须禁止 refresh**（这条不回滚） | 回到"授权问题反复出现"的状态；仅作为最后手段 |

**不可回滚的安全底线**：任何回滚路径都不得重新启用"用 `owner=dsh`/未标记 grant 自动刷新"，也不得把 production 记录复制进 preview/local。

---

## 7. 验收：测试矩阵与真实 provider 验证清单

### 7.1 确定性测试（本地/fake，先写测试再改代码；对齐 `AGENTS.md` 规则）

| 编号 | 场景 | 断言 | 现有覆盖 / 缺口 |
|---|---|---|---|
| T1 | 并发 2 实例同时触发 refresh | provider 端点调用次数 == 1；两边拿到同一个 access_token | 现有锁+CAS 测试覆盖基础；需补 v2 key + journal 场景 |
| T2 | 并发 3 实例 + 一方租约被强制过期 | 只有持 owner 者调用 provider；误删锁无效（Lua compare-del） | `releaseLease`/`renewLease` Lua 已实现，补 fake store 断言 |
| T3 | 锁内二次读发现 winner 已产出 | 不再调用 provider，直接返回 winner token | `_refresh` 中 `latest.access_token !== rec.access_token` 分支 |
| T4 | CAS 失败 | 读 winner、不回写自己的结果、capture `cas_lost` | `_refresh` CAS lose 分支已有 |
| T5 | `invalid_grant` 且 KV 已被别人轮换 | **不**写 `needsReauth`，返回 winner token | catch 分支 `winnerUsable` 已有；补跨实例用例 |
| T6 | `invalid_grant` 且 KV 仍是同一 grant | 写终态，且用 CAS（loser 不能覆盖 winner） | `_saveTerminal` 已有；补"两个 loser 并发写终态"用例 |
| T7 | shared grant（`source=dsh-*`）临近过期 / 401 force | provider refresh 调用次数 == 0；status=`shared_grant_refresh_forbidden` | 现有 `_grantOwner` 识别 dsh；补"owner 未标记"用例（R1） |
| T8 | 环境隔离：preview 实例面对 production-only 记录 | 不读 v1 无后缀 key；status=未授权；不刷新 production grant | 需补 §5.2 `resolveEnvironment` 的 local 默认值测试 |
| T9 | 记录 `environment` 与 key 不一致 | 拒绝 refresh + 告警，不使用 token | 新字段，需新增测试 |
| T10 | 冷启动 10 次 | 不重复 DCR、不重复 refresh、不重建已轮换记录 | `envSeed` 机制已有；补 grantId 维度 |
| T11 | Vercel 授权无 refresh_token | status=`STATIC_TOKEN_NO_REFRESH`，提示 `offline_access` | `requiredScopes()` 已有；补回调断言 |
| T12 | 日志脱敏 | capture / console 中无 `access_token`/`refresh_token` 明文 | 借鉴 DSH `redactOAuthDetail`；新增正则断言 |

### 7.2 真实 provider 验证清单（需用户/lead 授权，本批不执行）

- [ ] **Notion**：走一次 DCR 授权（新 client_id），记录 grantId；等 ~1h 或 force 一次刷新，确认新 pair 落 KV 且 `owner=gateway`、`source=gateway-dcr`；重复 3 次刷新无 `invalid_grant`；确认 DSH 侧 Notion 仍能独立工作（两 grant 互不干扰）。
- [ ] **Linear**：预注册 client 授权一次，确认 access ~24h、refresh 轮换；用 401 兜底路径验证"provider 拒绝 → 强制刷新一次 → 重连成功"；确认不再是"一天一失效"。
- [ ] **Vercel**：授权 URL 确认包含 `offline_access`；回调拿到 refresh_token；~1h 后自动刷新成功；若漏 offline_access 则明确出现 `STATIC_TOKEN_NO_REFRESH` 告警。
- [ ] **多实例**：Vercel 上同时制造两个暖实例（或本地起两个进程连同一 Redis），并发触发同一 server 刷新，检查 provider 侧 refresh 次数 == 1。
- [ ] **预览隔离**：在 preview deployment 上确认它只读 `gmcgw:v2:grant:preview:*`；故意让 preview 缺失授权，确认它不读 production key、不烧 production grant。
- [ ] **shared grant**：临时用一个 `source=dsh-*` 记录（hash 脱敏）触发 401，确认 refresh 调用为 0 且告警文本出现；测试后恢复。
- [ ] **观测**：`getAuthStatus()` 在 ACTIVE / REAUTH_REQUIRED / SHARED_GRANT_REFRESH_FORBIDDEN / STATIC_TOKEN_NO_REFRESH 四种状态返回值正确；capture 事件有 `environment` 与 `grantId`，无明文 token。

### 7.3 完成判据（Definition of Done）

1. §7.1 的 T1–T12 全部有确定性测试并通过 `npm test`（当前基线 288 项，只增不减）。
2. §7.2 三个 provider 各完成一次 gateway-owned 授权 + 至少一次真实轮换，且 24h 内无 `invalid_grant`、无重复授权请求。
3. `docs/ledger/batch-15-auth.md` 的"必做改造 1–6"逐条有代码落点或明确 DEC（不做理由）。
4. 任何在线反馈（如 `online-feedback-2026-11-23.md` 的 P0）保持"未核实不行动"原则；架构变更不得用"用户说挂了"替代可复现证据。

---

## 附录 A：本次发现的代码差距清单（供实施 agent 参考，本批不改）

| 编号 | 文件 / 行 | 差距 | 建议修正 |
|---|---|---|---|
| R1 | `src/upstream-auth.js:177` `_grantOwner` | 空 owner 默认 `gateway`，与"未标记=不可信"冲突 | 新 key 下返回 `shared`；仅 legacy key 迁移窗口保留 gateway 默认 |
| R2 | `src/upstream-auth.js:132` `resolveEnvironment` | 本地默认 `production`，会读写线上 key | 改为默认 `local`；Vercel 无 VERCEL_ENV 时兜底 `preview` |
| R3 | `src/upstream-oauth.js:200` 回调 seed | 未传 `environment`/`grantOwner`/`source`/`grantId` | 从 start 的 env 参数透传，写 v2 key |
| R4 | `src/upstream-auth.js:159` `_key` | `production+gateway` 用 legacy 无后缀 key | 迁移到显式 v2 命名空间，旧 key 只读别名过渡 |
| R5 | `src/store.js` | OAuth state key 无 env 前缀 | 授权回调 state 带 environment（§2.2） |
| R6 | `src/upstream-auth.js` | 无同实例 `refreshPromise` 合并 | 借鉴 DSH，减少实例内并发 provider 调用 |

> 本文件是设计产物，不是实施记录。任何代码改动须另开批次，先写 §7.1 的测试，再按 `AGENTS.md` 走 lead/人审流程。未 commit / push / deploy。
