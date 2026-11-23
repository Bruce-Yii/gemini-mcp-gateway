# B15 后续 — gateway-owned 授权剩余两条 provider 路径（Notion DCR / Vercel CIMD）

> 状态：**代码 + 确定性测试完成，未 commit / push / deploy**。真实授权仍 **NOT READY**，见 `docs/AUTH-READY.md`。
> 范围：只写 `src/upstream-oauth.js`、`src/config.js`、`config.example.json`（仅占位）、`src/vercel-app.js`（仅新增 CIMD 路由）、`tests/provider-dcr-cimd.test.js`（新增）、`docs/AUTH-READY.md`、`docs/ledger/batch-15-provider-dcr-cimd.md`（新增）。
> 未改：`src/upstream-auth.js`、`src/capture.js`、`scripts/`、其他 `tests/`、README、workflows。
> 依据：`docs/eval/AUTH-PROVIDERS.md` §2.1/§2.3（2026-11-23 抓取的 AS/PR metadata）、`docs/ledger/batch-15-auth-provisioning.md`。

---

## 0. 结论

两条 provider 路径的**网关侧代码与确定性回归测试已就绪**：

- Notion：`dcr:true` 时在 start 通过 `POST https://mcp.notion.com/register` 注册公共客户端（RFC 7591），持久化到 `gmcgw:v2:client:<env>:<server>`，client_id 写入 OAuth state；callback/refresh 使用 state/记录里的 client_id，不依赖 env。
- Vercel：公开 CIMD 文档路由 `GET /.well-known/mcp-client.json`（client_id 就是该 URL），authorize 请求显式 `openid offline_access` + `resource=https://mcp.vercel.com/`；回调无 refresh_token 明确失败。

**真实授权/部署/KV 写入验证未做**，所以 `docs/AUTH-READY.md` 保持 NOT READY；不要把"代码就绪"标绿为"可授权"。

---

## 1. 事实依据（已抓取 metadata，非推测）

| Provider | 事实 | 来源 |
| --- | --- | --- |
| Notion | AS `https://mcp.notion.com`，authorize `/authorize`、token `/token`、register `/register`；`scopes_supported: default`（**不广告 offline_access**，refresh 由 AS 策略签发给注册客户端）；`token_endpoint_auth_methods` 含 `none`；`client_id_metadata_document_supported: true`；DCR 重复注册会 orphan 旧 grant | `docs/eval/AUTH-PROVIDERS.md` §2.1 的 live curl（2026-11-23） |
| Vercel | AS `https://vercel.com`，authorize `/oauth/authorize`、token `https://api.vercel.com/login/oauth/token`；PR metadata 只广告 `openid`，AS 广告 `openid email profile offline_access`；CIMD（client_id 为 HTTPS 元数据文档 URL）是免 review 路径；`resource=https://mcp.vercel.com/` | `docs/eval/AUTH-PROVIDERS.md` §2.3 |
| Linear | 本批未改；hosted MCP 直接接受 Bearer PAT，preferred static 路径已在 auth-provision 完成 | `docs/eval/AUTH-PROVIDERS.md` §2.2 |

这些 URL/scope 在 `PROVIDER_ENDPOINTS` 中固定并有测试断言，**不联网**。

---

## 2. 改动逐项

### 2.1 `src/upstream-oauth.js`

1. 新增导出 `PROVIDER_ENDPOINTS`（Notion registration/resource/dcrScopes=`default`；Vercel resource/dcrScopes=`openid offline_access`）。公开常量，无凭据。
2. `resolveClient()`：优先级 DCR（复用 KV `gmcgw:v2:client:<env>:<server>`，无则注册）→ CIMD（`server.clientId` HTTPS URL）→ legacy `clientIdEnv`。
3. DCR 注册 body：
   - `redirect_uris: [<callback URL with env>]`、`client_name`（含 server/env，不含 secret）、`grant_types: [authorization_code, refresh_token]`、`response_types: [code]`、`token_endpoint_auth_method: none`、`scope: default`。
   - 成功响应只持久化 `client_id`（若有 client_secret 一并存但不打印）；记录含 registration_endpoint/environment/server/createdAt。
   - 存储用 `store._command('set'|'get', 'gmcgw:v2:client:<env>:<server>')`，**不调用 `TokenStore.saveClient`**（那是 legacy v1 哈希 key）。
4. 不重复注册：start 先读 KV；注册失败/竞态时重新读 KV，若另一 worker 已写入则复用其 client_id，避免重复注册或 orphan grant。失败不写 state，允许重试。
5. OAuth state 新增 `clientId`、`clientSecret`、`clientKind`（`dcr`/`cimd`/`static`）。callback 用 `saved.clientId` 优先，env 仅作 legacy 回退；token 请求附带 RFC 8707 `resource`。
6. Scope 补齐：Vercel 和其他 providers 沿用 `requiredScopes()`（含 `offline_access`）+ provider dcrScopes；Notion 的 **DCR/CIMD 新路径只用其 AS 广告的 `default`**（避免 invalid_scope），legacy static-client 配置保留历史 `offline_access` 行为（见 §4 兼容说明）。
7. `source` 区分 `gateway-dcr` / `gateway-cimd` / `gateway-oauth`；grant 仍 seed 到 v2 `<env>:gateway:<server>`，refresh 由 `UpstreamAuth._refresh` 使用记录中的 `client_id`，无需 env。

### 2.2 `src/config.js`

- `SERVER_KEYS` 新增 `dcr`、`registrationEndpoint`、`clientId`、`resource`（不再产生 unknown warning）。
- 校验：`dcr` 必须 boolean；`dcr:true` 必须有 `registrationEndpoint`、不得与 `clientIdEnv` 同用；`clientId` 必须是绝对 https URL（CIMD），与 `clientIdEnv` 互斥；`resource` 必须是 http(s) URL；`authorizeUrl` 的 client 来源三选一。
- `static_bearer` 禁用列表新增三个新 key，防止把静态 token 配成 OAuth 客户端。

### 2.3 `src/vercel-app.js`（仅新增）

- 导出 `CIMD_PATH='/.well-known/mcp-client.json'`、`cimdClientId()`、`buildCimdDocument()`。
- 文档字段：`client_id`（= 抓取 URL）、`client_name`、`client_uri`、`redirect_uris`（callback）、`grant_types`、`response_types`、`token_endpoint_auth_method: none`、`code_challenge_methods_supported: ['S256']`、`scope: 'openid offline_access'`。无 client_secret。
- 新路由 `GET /.well-known/mcp-client.json`：公开（无 auth）、`content-type: application/json`、`cache-control: public, max-age=3600`。origin 可由 `cimdBaseUrl` / `PUBLIC_BASE_URL` / `VERCEL_URL` / 请求 host 解析。

### 2.4 `config.example.json`（仅占位）

- `_authProvisioning.notion` 增加 `dcrPlaceholder`（registrationEndpoint/resource/clientKvKey 占位）；状态文字更新为"DCR 已实现，待真实授权"。
- `servers[notion]`：新增 `authorizeUrl`、`dcr:true`、`registrationEndpoint`、`resource`、`oauthScopes:['default']`；移除 `clientIdEnv`（DCR 拥有 client id）。
- `servers[vercel]`：新增 `authorizeUrl`、`refreshUrl`、`clientId`（`https://your-domain.example/.well-known/mcp-client.json` 占位）、`resource`、`oauthScopes`。
- 无真实 token/secret；全部 URL 为公开 provider endpoint 或示例域名。

### 2.5 `tests/provider-dcr-cimd.test.js`（新增，13 项）

1. config：新 key 合法无 warning；非法组合（dcr 非 boolean/缺 registrationEndpoint/dcr+clientIdEnv/非 https clientId/clientId+clientIdEnv/非法 resource）报错。
2. Notion DCR：注册 body 形状与 v2 client key 持久化、state client 绑定、无 v1 key 污染。
3. 重复 start 只注册一次；失败不留下 client/state 且可重试；竞态已写入 KV 时复用（不 orphan grant）。
4. callback 使用 state client_id（即使 env 设置了不同 client id），token form 含 resource、无 Basic auth、grant source=gateway-dcr。
5. refresh 使用 KV grant 记录里的 client_id（无 env client id），轮换后 client_id 保持。
6. Vercel：authorize 含 openid+offline_access+resource、CIMD client_id、无注册请求、无 KV client。
7. Vercel：无 refresh_token 回调明确 400 且不 seed grant。
8. CIMD 文档形状（含 client_secret 缺失、https 校验）与公开路由（200 / cache-control / 无 auth）。
9. provider facts 常量断言。

全部 fake fetch/store，零联网；不打印任何 token/client_secret。

---

## 3. 验证记录

```text
node --test tests/provider-dcr-cimd.test.js   # 13 tests, 13 pass, 0 fail
node --test tests/provider-dcr-cimd.test.js tests/auth-arch-fix.test.js \
          tests/upstream-oauth.test.js tests/config-validation.test.js  # 44 tests, 44 pass, 0 fail
node --test tests/provider-dcr-cimd.test.js tests/auth-arch-fix.test.js \
          tests/upstream-oauth.test.js  # 35 tests, 35 pass, 0 fail
node scripts/check-config.mjs                  # config OK（仅占位 warning）
npm test                                       # 见 §5（全量）
```

---

## 4. 兼容 / 已知限制（诚实记录）

- **Notion scope 分支**：`scripts/auth-provision.mjs`（本批不可改）与 `tests/auth-provision.test.js` 仍保留"DCR 未实现"的旧文案；`tests/auth-arch-fix.test.js:206` 断言 legacy static-client Notion 配置仍带 `offline_access`，因此仅对**新的 DCR/CIMD 路径**跳过该 scope。旧路径语义逐字保留，相关测试全绿。
- **Vercel CIMD 真实可用性**：文档路由只保证形状正确；AS 是否成功抓取、是否要求 `logo_uri`、CIMD URL 是否稳定 HTTPS，均需真实部署后由 lead/用户验证。文档明确未完成前不得授权。
- **未做**：真实 DCR 注册、真实 CIMD 部署、真实 OAuth 授权、KV 真实写入/读取、部署后 tools/list、`getAuthStatus()` ACTIVE、回滚演练。
- **未 commit / push / deploy**。

→ 详见 `docs/AUTH-READY.md` §2：**现在不能要授权**。

---

## 5. 最终全量测试

> 并发影响：只报告本批与相关测试状态；其他 agent 并发修改造成的失败不归入本批。

```text
# 最终全量运行（并发 agent 修复其测试后）：
npm test   # 1087 tests, 1081 pass, 0 fail, 6 todo
# 途中出现的临时失败均来自并发 agent 的文件（oss-staging-curation.test.js
# 曾 fail，capture-completeness.test.js 的 80ms 文件 sink 断言偶发 flake），
# 与本批改动无关；最终运行全绿。
```
