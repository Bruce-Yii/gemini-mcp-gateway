# B15 后续 — auth architecture 附录 A 残留风险 R1–R6 修复

> 状态：实施完成（未 commit / push / deploy）。
> 范围：只改 `src/upstream-auth.js`、`src/upstream-oauth.js`、`src/store.js`、`src/upstreams.js`，新增 `tests/auth-arch-fix.test.js`、`docs/ledger/batch-15-auth-arch-fix.md`；按 lead 授权同步更新了下列旧测试中直接与 R2/R4/R1 冲突的断言（不删测试、不改无关语义）：`upstream-token-lifecycle.test.js`、`upstream-auth.test.js`、`refresh-once.test.js`、`refresh-concurrency.test.js`、`stale-kv.test.js`、`token-liveness.test.js`、`cas-fencing.test.js`、`invalid-grant.test.js`、`upstream-auth-generic.test.js`、`upstream-oauth.test.js`。
> 未改 `src/capture.js`、`src/server.js`、`scripts/`、README、workflows。
> 设计依据：`docs/ledger/batch-15-auth-architecture.md`（附录 A R1–R6、§1.2、§4.1、§5.2、§6）、`docs/ledger/batch-15-token-lifecycle.md`、`docs/eval/AUTH-PROVIDERS.md`（Notion/Linear static bearer、Vercel `offline_access`）。

---

## 0. 结论（先读这条）

**gateway-owned grant 现在有三条独立的安全边界：owner fence（不刷别人的 grant）、environment fence（不刷别的环境的 grant）、单 refresher（同一 grant 同时只有一个刷新者）。** 旧代码三条都有缺口；本批逐条补齐，并以确定性测试固定。

来源事实（`batch-15-auth.md` / `AUTH-PROVIDERS.md`）：DSH 与网关是两个独立 OAuth client，共享 rotating refresh token 在协议层就是 grant-binding 违规；Notion 对 replay 直接整族 revoke。因此任何"未显式标记 owner"的 grant 一律按不可信处理。

---

## 1. R1 — unmarked owner 不再默认 gateway

**差距**：旧 `_grantOwner()` 对空 owner/source 返回 `gateway`，与"未标记=不可信"冲突。

**修法**（`src/upstream-auth.js::_grantOwner` / `_mayRefresh`）：

- 空/未标记 → `shared`，`_mayRefresh()` 返回 false；即使 provider 401（`force:true`）也只用现有 access token，返回 `REAUTH_REQUIRED / SHARED_GRANT_REFRESH_FORBIDDEN`。
- 只有显式 `owner=gateway` / `source=gateway-*` / `source=gateway-dcr` 才返回 `gateway`。
- `dsh-*` → `dsh`；`manual` / `static_bearer` / `pat` → `manual`；其他 → `shared`。
- **唯一例外**：legacy v1 只读别名里的无标记记录（迁移窗口，设计文档 §4.1/§6）仍按 gateway 处理，让既有部署能再轮换一次后重新授权。该标记由 `_load()` 从 legacy key 读取时写入内部 `__fromLegacyKey`，只影响判定，不写回 KV。

**证据**：`tests/auth-arch-fix.test.js` 的 R1 三条（unmarked 拒绝刷新、`_grantOwner` 映射表、显式 gateway 正常刷新）+ 旧 G1/G2 保持绿。

---

## 2. R2 — `resolveEnvironment` 本地默认 local

**差距**：旧实现无元数据时返回 `production`，本地冷启动会读写线上 KV key。

**修法**（`src/upstream-auth.js::resolveEnvironment`）：

| 输入 | 返回 |
|---|---|
| `GMCGW_ENVIRONMENT` ∈ {production,preview,development,local} | 该值（最高优先级） |
| `VERCEL_ENV` ∈ {production,preview,development} | 该值 |
| `VERCEL === '1'`（无 VERCEL_ENV） | `preview`（安全兜底） |
| 其他（本地 shell / 测试 / 未识别容器） | `local` |

未知 `GMCGW_ENVIRONMENT` 不再回退 production，而是走 `local`。本地实例默认环境与 production 实例的 key 完全分离（见 R4）。

**证据**：新测试 R2 三条（无元数据→local、Vercel 无 env→preview、显式覆盖 + 本地冷启动不读 production）。

---

## 3. R3 — OAuth 回调写完整 grant 身份

**差距**：旧 `src/upstream-oauth.js` 的 callback 直接 `new UpstreamAuth({store, fetch})`（默认 environment=process.env 解析），`seed()` 不传 environment/grantOwner/source/grantId，结果落到 legacy production key 且没有 owner 标记。

**修法**：

- `start` 接受显式 `env=` 参数（admin key 保护）；无 `env` 时使用 `resolveEnvironment()`（local 默认，绝不隐式 production）；非法 env 返回 400。
- 预分配 `grantId = gw:<env>:<server>:<sha256(clientId|tokenUrl).slice(0,12)>`，随 state 一起持久化。
- redirect URI 追加 `?env=<environment>`，callback 用它选择 state 命名空间并校验与 state 记录一致。
- 回调构造 `new UpstreamAuth({ store, environment, grantOwner:'gateway' })`，seed 时传齐 `environment` / `grantOwner:'gateway'` / `source` / `grantId` / `force:true`。
- 授权 URL 用 `requiredScopes(server)` 补齐 scope：Vercel 必带 `offline_access`；Vercel 回调若无 refresh_token 直接 400 失败，而不是接受一个只能活 1 小时的 token。

**证据**：新测试 R3/R5 回调用例（v2 key + 四字段 + 无 legacy production key）、Vercel scope / 无 refresh_token 用例；旧 `upstream-oauth.test.js` 断言已更新为 v2 key。

---

## 4. R4 — legacy key 只读，新写入全量 v2 命名空间

**差距**：旧 `_key()` 对 `production+gateway` 返回无后缀 `gmcgw:v1:upstream:<server>`，新 grant 与旧数据混在同一个 key。

**修法**（`src/upstream-auth.js`）：

- `_key(server, owner)` 永远返回 `gmcgw:v2:grant:<environment>:<owner>:<server>`（导出 `V2_KEY_PREFIX`）。
- `_legacyKey()` 只构造只读别名：production → `gmcgw:v1:upstream:<server>`，preview/development → `gmcgw:v1:upstream:<env>:<server>`；`local` 与非 gateway owner 无别名。
- `_load()` 先读全部 v2 owner 命名空间，再（若有）读 legacy 别名；从 legacy 读到的记录打内部标记，**不回写**。
- `_save()` / `casToken` / `_saveTerminal` 只写 v2；key 的 owner 段取记录的 `owner`（而非进程默认），避免 shared grant 落进 gateway 命名空间。
- 每条 v2 记录写入 `environment` + `grantId`；读到的记录 `environment` 与 key 不一致 → 视为污染，拒绝 refresh（设计文档 §1.1/§5.1）。

**证据**：新测试 R4 两条（prod+gateway 写 v2 不写 legacy、legacy 记录可读但不回写）+ environment pollution 用例。

---

## 5. R5 — OAuth state key 带 environment/owner 前缀

**差距**：`src/store.js` 的 state key 只有 state hash，跨环境回调可能串线。

**修法**（`src/store.js`）：

- 新增 `_oauthStateKey(state, {environment, grantOwner})` → `gmcgw:v1:oauthstate:<env>:<owner>:<hash(state)>`；不传 scope 时保持旧 key 形态（兼容）。
- `saveOAuthState(state, record, scope)` / `takeOAuthState(state, scope)` 使用新 key，并把 `environment`/`grantOwner` 写进 state 记录本身（fake store 忽略 scope 时仍有 record 级校验）。
- handler 侧把 env 追加到 redirect URI，callback 用 `env` 查询参数选择 scope；`saved.environment !== hint` → 400 拒绝。
- 由于 state 用 GETDEL 一次性消费，串线的回调连 state 都取不到。

**证据**：新测试 R5 两条（key 形态与隔离、跨环境取不到 state）+ R3/R5 回调用例。

---

## 6. R6 — 同实例 refreshPromise 合并

**差距**：DSH 有 `entry.refreshPromise` 同进程去重，网关只有 Redis lease；同一 serverless 实例的并发请求仍可能各自持锁、多次调 provider。

**修法**（`src/upstream-auth.js`）：

- 实例新增 `_refreshPromises: Map<key, Promise>`。
- `getAccessToken()` 在进入刷新阶段时调用 `_coalescedRefresh(server, run)`：同 key 已有 in-flight promise 则直接复用；结束后 `finally` 删除。
- 刷新主体抽到 `_refreshWithLease()`，原有 lease owner / keepalive / 锁内二次读 / CAS / invalid_grant loser 保护**逐字保留**。
- 跨实例不依赖该 Map，仍由 Redis lease + CAS 保证。

**证据**：新测试 R6 两条（单实例 3 并发只 1 次 provider 调用；跨 2 实例仍只 1 次）+ 旧 C1/A3/refresh-concurrency 保持绿。

---

## 7. 额外：static_bearer / owner=manual 路径（lead 新指示）

依据 `docs/eval/AUTH-PROVIDERS.md`：Notion 支持 owner 创建的静态 MCP token（Business/Enterprise），Linear 官方 MCP 支持 Bearer PAT。这两条路径**没有 rotating grant**，是消灭 Notion/Linear grant 问题的最直接方式。

**修法**（`src/upstreams.js`）：

- config 显式 `authMode: 'static_bearer'`（或 `staticBearer: true`）才走该路径；**绝不从 envToken 推断**，避免把所有 env token 误判为静态。
- 该路径直接返回 env token，不进 `UpstreamAuth` refresh 生命周期；同时 best-effort `seed({ grantOwner:'manual', source:'manual', force:true })` 落 `gmcgw:v2:grant:<env>:manual:<server>`，供 `getAuthStatus()` 报告。
- 静态 token 401 → `ReauthRequiredError(STATIC_TOKEN_NO_REFRESH)`，不重连、不刷新。
- Vercel 仍走 gateway-owned OAuth（OAuth-only，必须 CIMD + `openid offline_access` + `resource`；scope 由 `requiredScopes()` 补齐）。

**证据**：新测试 static_bearer 两条（不刷新 + owner=manual 持久化；401 不重连）+ Vercel 两条（offline_access scope、无 refresh_token 失败）。

---

## 8. 测试与验证

新增 `tests/auth-arch-fix.test.js`：18 项，覆盖 R1×3、R2×3、R3/R5×2、R4×2、R5×1、R6×2、static_bearer×2、Vercel×2、environment pollution×1。

按 lead 授权更新的旧测试（仅冲突断言）：

- `upstream-token-lifecycle.test.js`：KEY → v2；E1 default → local + 新增 `VERCEL=1` 用例；E2/E3/G3 key → v2；G1/G2 shared grant 落到 dsh 命名空间；新增 `_legacyKey` 只读断言。
- `upstream-auth.test.js` / `cas-fencing` / `invalid-grant` / `refresh-once` / `refresh-concurrency` / `stale-kv` / `token-liveness` / `upstream-auth-generic` / `upstream-oauth`：key 断言 → v2；需要刷新的 seed/env 显式标 `grantOwner:'gateway'` / `source:'gateway-oauth'`（R1 要求）。

---

## 9. 残留风险与未做事项（诚实记录）

- **迁移尚未执行**：生产环境旧 v1 grant 仍是 DSH 导出的共享 grant。代码已能拒绝刷新它，但要真正消除风险仍需按 `batch-15-auth-architecture.md` §6 做一次 gateway 独立授权（或改用 static bearer），并把配置指向 v2 key。
- **legacy 别名只读窗口**：v1 记录可读不可写，迁移完成并观察一个刷新周期后应删除别名（本批不改 scripts/，留给运维）。
- **跨实例 lease 依赖 Redis**：fake store 的 NX/Lua 语义已测，真实 Upstash 的 Lua 脚本未在本批跑（不在允许修改的文件范围内）。
- **并发 agent 干扰**：验收过程中全量 `npm test` 曾出现与本批无关的失败（其他 agent 并发修改的非本批文件）；lead 已确认由对应 agent 处理，本批不碰。最终全量已绿。
- **truncation gate**：lead 的 OSS staging 发现 `src/upstream-oauth.js` 的 grantId 里有未标记 `.slice(0,12)`（P0）。已改为使用**完整 sha256**（无截断、无 P0），`node scripts/audit-truncation.mjs --ci` → `P0=0 PASS`。
- **未 commit / push / deploy**。

### 最终验证

```text
node scripts/audit-truncation.mjs --ci   # P0=0, PASS
npm test                                  # 988 tests, 982 pass, 0 fail, 6 todo
```

---

## 10. 人工验收清单（本批不执行）

- [ ] 三个 provider 各做一次 gateway-owned 授权（或 Notion/Linear 改 static bearer），确认 `getAuthStatus()` 为 ACTIVE。
- [ ] 观察一次真实刷新，确认 `owner=gateway` / `environment` 正确、无 `invalid_grant`。
- [ ] preview 部署故意缺授权，确认不读 production key。
- [ ] 用 `source=dsh-*` 记录触发 401，确认 refresh 调用为 0 且告警出现。
- [ ] 迁移窗口结束后删除 legacy v1 只读别名。
