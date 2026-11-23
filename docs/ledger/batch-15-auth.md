# B15 — Upstream OAuth grant ownership / token lifecycle

> 状态：执行中。目标不是再修一次锁，而是把 token 所有权和刷新架构定死。
> 用户明确要求：授权问题零容忍，不能反复重授权。

## 根因（已验证）

- 本地 vault 的 Notion/Linear grant `source=dsh-mcp-connector-oauth-grant`；
- DSH 和网关共用同一个 rotating refresh token；
- OAuth 2.1 refresh token 单次使用：一方刷新 → 另一方立即失效；
- 锁/CAS 只能管网关内部，管不到外部 DSH；
- Vercel MCP access token 约 1h，必须 `offline_access` 才有 refresh token；
- Notion MCP 只支持 OAuth/DCR，无 API key/Bearer 模式；
- Linear 官方 MCP OAuth-only，PAT 不能直接用于官方 MCP。

## 不可变结论

> **DSH 与网关不能共用同一个 refresh grant。**
> 二选一：网关独立授权；或 DSH 作为 token broker。默认选网关独立授权。

## 当前并行 agent

| Agent | 产物 | 验收 |
|---|---|---|
| `upstream-token-lifecycle` | `src/upstream-auth.js` / `upstreams.js` / `store.js` + tests | owner-fenced lease、shield、shared-grant 拒绝、env 隔离、缓存修复 |
| `auth-provider-research` | `docs/eval/AUTH-PROVIDERS.md` | Notion/Linear/Vercel 的 token 寿命、refresh、DCR/static 可行性、URL |
| `auth-architecture` | `docs/ledger/batch-15-auth-architecture.md` | token schema、gateway-owned OAuth 流程、迁移/回滚、验收 |
| `auth-sim-harness` | `scripts/auth-rotation-sim.mjs` + tests + ledger | 并发 refresh 模拟，证明无锁会双刷、owner-fenced 成功 |

## 必做改造

1. token 记录：`owner(gateway/dsh/manual)`、`source`、`grantId`、`environment`、`access/refresh/expiry`、`needsReauth`。
2. KV key：`...:gateway:<env>:<server>`；DSH shared 只读；preview/production/local 隔离。
3. gateway-owned OAuth：
   - Notion DCR；
   - Linear 官方 OAuth grant（不直接用 PAT）；
   - Vercel OAuth + `offline_access`。
4. 单 refresher：
   - owner-fenced lease（UUID + Lua compare-del + 续租）；
   - 锁内二次读 KV；
   - provider 调用只在锁内；
   - CAS 失败读 winner；
   - invalid_grant 只有确认 winner 也无效才终态。
5. shared-grant 保护：
   - `owner=dsh` / 未标记 owner → 禁止自动 refresh；
   - 只允许显式长期 access token，并明确告警。
6. 可观测：refresh 成功/失败、needsReauth、owner、environment、provider；告警不打印 token。

## 验收

- 并发 2/3 实例只 refresh 一次；
- 锁过期/误删不会双刷；
- shared grant 永不自动 refresh；
- preview 不烧 production grant；
- 真实 Notion/Linear/Vercel 各一次 gateway-owned 授权后，不再一天一失效；
- 漂移/失败有 `REAUTH_REQUIRED` 而不是静默 401。

## 明确不做

- 不再导入 DSH refresh token；
- 不把“重新授权”当每次故障的修复；
- 不靠更长锁 TTL 掩盖架构问题；
- 不用静态 token 假装 refresh。
