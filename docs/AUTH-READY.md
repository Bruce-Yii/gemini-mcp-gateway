# AUTH-READY — 什么时候才能找用户要授权

> 状态：**NOT READY**。当前不能找用户授权。本文是"授权前必须全绿"的唯一清单。
> 用户明确要求"完全做好再找我要授权，不能再反复试"——所以任何一行不是绿，都不发授权请求、不说"请授权"。
> 证据与命令均可本地复现。本文只描述门槛，不替代真实 provider 验证。
> 本批新增：Notion DCR 与 Vercel CIMD 的**代码与确定性测试已就绪**，但真实部署/授权/KV 验证未做，见 §1.3 / §2；不要把"代码就绪"误读为"可以授权"。

---

## 0. 一句话判据

**只有当 §1 八项全部打勾（每项都有命令 + 证据），且 §2 三个 provider 的真实验证都由 lead/用户在受控环境执行过，才允许向用户发出一次授权请求。**

当前状态：`static_bearer` 代码与确定性测试已就绪；**真实 provider 授权、KV 落地、部署后 tools/list 验证、回滚演练都未做**。因此现在不能要授权。

---

## 1. 授权前必须全绿的 checklist

每项格式：`[ ] 项 — 命令/证据 — 通过标准`。任何一项失败 → 清单整体 NOT READY。

### 1.1 Code/tests

- [x] **static_bearer 在 config 校验中显式可用** —
  `node --test tests/auth-provision.test.js tests/config-validation.test.js` —
  `authMode` 是已知 key（不产生 unknown warning），非法值/缺 `tokenEnv`/带 refresh 字段都被拒绝；`AUTH_MODES = ['oauth','static_bearer']`。
- [x] **static token 不 refresh** —
  `node --test tests/auth-provision.test.js` 中 `UpstreamAuth: authMode=static_bearer returns token verbatim and NEVER calls the token endpoint` —
  即使 `force:true`（模拟 provider 401），token endpoint 调用数 `== 0`。
- [x] **v2 key 与 owner=manual** —
  同上 `UpstreamAuth: static_bearer persists owner=manual at the explicit v2 key` —
  记录落在 `gmcgw:v2:grant:<environment>:manual:<server>`，含 `environment`、`grantId`、`authMode`，无 `refresh_token`。
- [x] **token 不打印** —
  同上 `provision stdout/stderr contain no token value` + `formatPlan redacts...` —
  stdout 不含 token 明文；即使调用方误注入 token 也被 `[REDACTED]`。
- [x] **全量 npm test 绿** —
  `npm test` — `1087 tests, 1081 pass, 0 fail, 6 todo`（含本批 13 项 `tests/provider-dcr-cimd.test.js`；本批相关子集 `node --test tests/provider-dcr-cimd.test.js tests/auth-arch-fix.test.js tests/upstream-oauth.test.js` 为 35/35 绿）。并发 agent 新增测试会改变总数，以 ledger §5 当次记录为准。
- [x] **静态扫描无 P0** —
  `node scripts/audit-truncation.mjs --ci` — `P0=0 PASS`（仅 P1 warning）。

### 1.2 Deploy

- [ ] **目标环境已部署包含本批代码** —
  证据：部署记录 + `GET /healthz` 返回的新 build-info（commit/build id）。
  通过标准：部署的是本批改动之后的构建，不是旧 artifact。
- [ ] **环境变量命名空间正确** —
  证据：Vercel project env / 本地 shell 中 `GMCGW_ENVIRONMENT` 或 `VERCEL_ENV` 的取值。
  通过标准：授权目标 env 与部署 env 一致；local 部署绝不写 production key。

### 1.3 Provider method（每个 provider 都要单独确认）

- [x] **Linear 优先 static_bearer（PAT）** —
  证据：`docs/eval/AUTH-PROVIDERS.md` §2.2（官方 MCP 接受 `Authorization: Bearer <PAT>`）+ 测试 `Linear PAT: offline plan is ready...`。
  通过标准：不走 refresh；PAT 在 vault、scope 尽量只读。
- [ ] **Linear PAT 已由 owner 创建并放入 vault** —
  证据：vault 文件存在且 `tools/list --verify` 真实成功（见 1.7）。
  通过标准：不是用户临时从聊天窗口贴 token。
- [x] **Notion 分支诚实** —
  证据：测试 `Notion: static MCP token path is ready...` + `tests/provider-dcr-cimd.test.js`（DCR 注册/复用/回调/刷新）。
  通过标准：文档明确"static token 需 Business/Enterprise；REST integration token 无效；DCR 已实现但尚未真实授权"。注意：`scripts/auth-provision.mjs` 的 blocker 文案仍是旧版（脚本不在本批改动范围），因此 `auth-provision.test.js` 中 `Notion: interactive OAuth is explicitly BLOCKED...` 一项仍绿但**文案已过时**——以本节为准。
- [x] **Notion DCR 代码已实现（但真实授权未做）** —
  证据：`src/upstream-oauth.js` 对 `dcr:true` 在 start 时 POST `registration_endpoint`，持久化 `gmcgw:v2:client:<env>:<server>`，client_id 写入 OAuth state；callback/refresh 使用 state/record 的 client_id；测试覆盖注册成功/失败/重复 start 不重复注册/竞态复用/回调/刷新。
  通过标准：确定性测试全绿；**真实 DCR 授权、KV 落地与部署后验证未完成，见 §2，Notion 交互授权对外仍 BLOCKED**。static MCP token 路线仍需 owner 在 vault 创建。
- [x] **Vercel OAuth-only 配置带 offline_access** —
  证据：`src/upstream-oauth.js` authorize URL 显式添加 `openid offline_access`（Vercel PR metadata 只广告 `openid`，不足）+ `resource=https://mcp.vercel.com/`；回调无 refresh_token 直接 400；测试 `Vercel CIMD: authorize URL carries openid + offline_access...`。
  通过标准：scope/resource 代码与测试就绪；CIMD client 配置见下一项。
- [x] **Vercel CIMD 代码已实现（但真实部署/授权未做）** —
  证据：`src/vercel-app.js` 新增公开路由 `GET /.well-known/mcp-client.json`（`client_id` = 文档 URL、`token_endpoint_auth_method: none`、S256、`scope: openid offline_access`）；`config.example.json` 中 `clientId` 为占位 HTTPS URL；测试覆盖文档形状与路由。
  通过标准：确定性测试全绿；**真实 CIMD 文档必须部署在稳定 HTTPS 域名并把该 URL 写入 `clientId`，再做一次真实授权确认 refresh_token 非空——未完成前 Vercel 授权对外仍 BLOCKED**。`auth-provision.mjs` 的 CIMD blocker 文案同样过时（脚本不在本批范围）。

### 1.4 Env namespace

- [ ] **token/client env 变量名在目标环境存在** —
  命令：`node scripts/auth-provision.mjs --provider linear --token-env LINEAR_PAT_STATIC --environment <env>`
  通过标准：offline plan 不再报 `env ... is not set`（只检查变量名，不打印值）。
- [ ] **KV 凭据只在该环境配置** —
  证据：Vercel project env 中 KV URL/TOKEN 与 env 绑定；local shell 无 production KV 凭据。
  通过标准：不存在跨环境共用 KV 的情况。

### 1.5 Owner / provisioning

- [x] **脚本对 static 写 owner=manual 的 v2 grant，不写 OAuth grant** —
  证据：`buildStaticGrant()` + `Vercel: --apply on an OAuth plan performs no KV write` 测试。
  通过标准：static 记录 `owner=manual`、`source=manual`、`authMode=static_bearer`；OAuth provider 不被脚本写 grant。
- [ ] **`--apply` 已由 operator 在正确 env 执行且 KV 记录可读** —
  命令：`node scripts/auth-provision.mjs --provider linear --token-env LINEAR_PAT_STATIC --environment <env> --verify --apply`
  通过标准：`result: READY ... wrote=true`；KV 中 v2 key 存在且 `environment` 与 key 一致。
- [ ] **`getAuthStatus()` 返回 ACTIVE（或明确的 static 状态）** —
  证据：管理端点/脚本调用 `getAuthStatus(server)` 的输出。
  通过标准：不是 `REAUTH_REQUIRED`/`SHARED_GRANT_REFRESH_FORBIDDEN`；static 过期报 `STATIC_TOKEN_NO_REFRESH`。

### 1.6 Real validation（必须真实跑过，不能用 fake 代替）

- [ ] **真 `tools/list` 成功** —
  命令：`... --verify`（真实 fetch，非测试 fake）。
  通过标准：Linear/Notion 官方 MCP 返回工具列表；Vercel OAuth 回调返回非空 `refresh_token`。
- [ ] **真实 gateway 冷启动连得上上游** —
  命令：`npm run smoke:l1:real` 或 lead 指定的真实冒烟。
  通过标准：上游工具出现在 `search`/`execute` 列表，无 401/REAUTH。
- [ ] **跨环境隔离实测** —
  证据：preview 实例故意缺授权时读不到 production key。
  通过标准：无跨环境 grant 读取，无 production grant 被烧。

### 1.7 Provisioning 脚本自身

- [x] **离线默认零网络** —
  证据：`provision without token never performs a network call` 测试 + CLI 默认输出。
  通过标准：不带 `--verify` 绝不发请求。
- [x] **`--verify` 可注入 fake fetch** —
  证据：`Linear PAT: verify hits the official MCP tools/list` 测试。
  通过标准：测试不联网；真实运行时用真实 fetch。

### 1.8 Rollback

- [ ] **回滚方案已演练** —
  证据：按 `docs/ledger/batch-15-auth-architecture.md` §6.4 逐项确认。
  通过标准：
    - static token 失效 → 只改 env token + `--apply`，不动 OAuth 记录；
    - 新 grant 授权失败 → 保留旧 gateway-source v2 记录，不回滚到 `dsh` source；
    - environment 错配 → 删除错误 key 重新 `--apply`，绝不复制 production 记录到 preview/local；
    - **不可回滚底线**：任何回滚路径都不重新启用 `owner=dsh`/未标记 grant 的自动刷新。

---

## 2. 当前未完成项（为什么现在不能要授权）

诚实清单——以下每一项都是真实阻塞，不是"差不多"：

1. **没有真实 provider 授权**：Linear PAT / Notion static MCP token尚未由 owner 创建并验证；Vercel 没有 CIMD client_id。
2. **没有真实 KV 写入**：`--apply` 从未在目标环境跑过；v2 grant 记录没有被真实创建/读取。
3. **没有部署验证**：本批代码尚未部署；部署后 `tools/list` 与 `getAuthStatus()` 未验证。
4. **Notion DCR 代码已就绪，但真实授权未做**：`src/upstream-oauth.js` 已支持 DCR 注册/复用/state client/KV 客户端记录并有确定性测试；但尚未在目标环境真实完成一次 DCR 授权，`gmcgw:v2:client:<env>:notion` 未被真实写入，部署后 tools/list 未验证。交互授权对外仍 BLOCKED（或用户已有 static MCP token）。
5. **Vercel CIMD 代码已就绪，但真实部署/授权未做**：CIMD 文档路由 + `clientId` 配置 + `offline_access`/`resource` + 回调无 refresh_token 失败都有测试；但 CIMD 文档尚未部署到稳定 HTTPS 域名、`clientId` 仍是占位 URL，也未真实授权确认 `refresh_token` 非空。对外仍 BLOCKED。
6. **回滚未演练**：§1.8 没有任何一项有真实证据。

→ 因此 **NOT READY**。在 1.1–1.8 全绿、§2 全部消除前，不要向用户发出任何授权请求。

---

## 3. 授权流程（全绿之后才执行）

一旦 §1 全绿：

1. 每个环境各做一次，**不跨环境复用授权**。
2. Linear / Notion static 路线：owner 在 vault 放好 static token → operator 跑
   `node scripts/auth-provision.mjs --provider <p> --token-env <ENV> --environment <env> --verify --apply`
   → 确认 `result: READY ... wrote=true`。
   Notion 交互路线（无需 static token）：确认 `config` 中 `dcr:true` + `registrationEndpoint`，走一次
   `/upstream/oauth/start?server=notion&env=<env>&key=<ADMIN_KEY>` → 确认 KV `gmcgw:v2:client:<env>:notion` 被写入一次且不重复注册 → 回调后 `getAuthStatus()` ACTIVE。
3. Vercel：把 CIMD 文档部署到稳定 HTTPS 域名，确认 `GET /.well-known/mcp-client.json` 可被 AS 抓取且 `client_id` 等于该 URL → 把该 URL 写入 `config.clientId` → 走一次 `/upstream/oauth/start?server=vercel&env=<env>&key=<ADMIN_KEY>`
   → 回调确认 `refresh_token` 非空 → `getAuthStatus()` ACTIVE。
4. 重连 MCP client（工具 schema 未变，通常不需要改 Gemini 侧）。
5. 观察一个真实 token 生命周期（Linear PAT 无刷新；Vercel ~1h 刷新一次），确认无 `invalid_grant`。

再次强调：**这一步在上述 checklist 未全绿前禁止执行。**

---

## 4. 变更范围与不变量

上一批（auth-provisioning，未 commit/push/deploy）：
`src/upstream-oauth.js`、`src/upstream-auth.js`、`src/config.js`、`config.example.json`（仅占位字段）、`scripts/auth-provision.mjs`（新增）、`tests/auth-provision.test.js`（新增）、`docs/AUTH-READY.md`、`docs/ledger/batch-15-auth-provisioning.md`。

本批（provider DCR / CIMD，未 commit/push/deploy）只写：

- `src/upstream-oauth.js`（Notion DCR 注册/复用、state client、RFC 8707 resource、Vercel scope 补齐）
- `src/config.js`（`dcr` / `registrationEndpoint` / `clientId` / `resource` 校验）
- `config.example.json`（仅占位字段：Notion DCR 与 Vercel CIMD 的 URL 都是占位示例）
- `src/vercel-app.js`（仅新增 `GET /.well-known/mcp-client.json` CIMD 路由与构造函数）
- `tests/provider-dcr-cimd.test.js`（新增，13 项，零联网 fake fetch/store）
- `docs/AUTH-READY.md`（本节）、`docs/ledger/batch-15-provider-dcr-cimd.md`（新增）

未改：`src/upstream-auth.js`、`src/capture.js`、`scripts/`、`tests/`（其他）、README、workflows。
注意：`scripts/auth-provision.mjs` 的 Notion「DCR 未实现」与 Vercel「无 CIMD client_id」 blocker 文案因脚本不在本批范围而未更新，属**已知过时文案**，不代表代码能力；真实授权门槛仍以本文为准。

不变量：static token 永不 refresh；token / client_secret 永不进 stdout/日志；v2 key 的 environment + owner 永远显式；未标记/dsh grant 永不自动刷新（这条不回滚）；DCR 客户端只写 `gmcgw:v2:client:<env>:<server>`，绝不污染 legacy v1 key；重复 start 绝不重复注册（避免 orphans grant）。
