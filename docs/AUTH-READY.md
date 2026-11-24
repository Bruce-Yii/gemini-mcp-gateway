# AUTH-READY — 什么时候才能找用户要授权

> 状态：**NOT READY**。当前不能找用户授权。本文是"授权前必须全绿"的唯一清单。
> 用户明确要求"完全做好再找我要授权，不能再反复试"——所以任何一行不是绿，都不发授权请求、不说"请授权"。
> 证据与命令均可本地复现。本文只描述门槛，不替代真实 provider 验证。
> **事实基线（2026-11-25）**：生产 `f2002d9`（`buildHash=3b1a0772…`、`deploymentId=dpl_6P2Ww8vsTHXbbSF98GTE55HKitB4`）；`main=cd23fdc`（PR #28 已合、未部署）。
> 本版按 PR #29（Linear → `static_bearer` + PAT；Notion → 网关自有 OAuth/DCR）与 PR #26（入站审批口令）后的真实状态重写 §1–§4，并新增 §1.9 旧凭据清理条件：**授权动作已部分完成，但运行时/生命周期未验收——不要把"KV 里有 grant"或"本地直连 200"误读为"已可用/可授权"。**
> 本文同时用于两件事：① 是否可以对该 provider 发起（或再次发起）授权；② 该 provider 的授权生命周期是否已验收（8h/72h）；两者都要求 §1 全绿。

---

## 0. 一句话判据

**只有当 §1 九项（§1.1–§1.9，每项都有命令 + 证据）全部打勾，且 §2 全部消除，才允许发起一次授权请求，或宣布某个 provider 的授权已验收。**

当前状态一句话：**Linear 生产只读路径已验证（`f2002d9` 实测 27 tools、`linear__list_teams` 成功）；Notion 真实 OAuth 已成功落 KV，但生产 runtime 仍 `offline`（根因代码 bug，PR #31 未合并）、8h/72h 稳定观测未开始；Vercel CIMD 仍被 AS 拒绝（BLOCKED）** —— 因此现在既不能要授权，也不能宣布授权验收。

---

## 1. 授权前必须全绿的 checklist

每项格式：`[ ] 项 — 命令/证据 — 通过标准`。任何一项失败 → 清单整体 NOT READY。

### 1.1 Code/tests

- [x] **static_bearer 在 config 校验中显式可用** —
  `node --test tests/auth-provision.test.js tests/config-validation.test.js tests/auth-static-config.test.js` —
  `authMode` 是已知 key（不产生 unknown warning），非法值/缺 `tokenEnv`/带 refresh 字段都被拒绝；`AUTH_MODES = ['oauth','static_bearer']`。
- [x] **static token 不 refresh** —
  `node --test tests/auth-provision.test.js tests/token-liveness.test.js` 中 `static_bearer returns token verbatim and NEVER calls the token endpoint` —
  即使 `force:true`（模拟 provider 401），token endpoint 调用数 `== 0`。
- [x] **v2 key 与 owner=manual** —
  `node --test tests/auth-provision.test.js` 中 `static_bearer persists owner=manual at the explicit v2 key` —
  记录落在 `gmcgw:v2:grant:<environment>:manual:<server>`，含 `environment`、`grantId`、`authMode`，无 `refresh_token`。
- [x] **token 不打印** —
  `node --test tests/auth-provision.test.js` + `formatPlan redacts...` —
  stdout 不含 token 明文；即使调用方误注入 token 也被 `[REDACTED]`。
- [x] **入站审批口令有确定性测试（PR #26）** —
  `node --test tests/oauth-approve-passphrase.test.js` —
  配置口令后 consent 页要求密码；缺失/错误 → HTTP 403 且 `codeCount()==0`（不落 code）；未配置时保持 legacy 行为；口令值不出现在日志/403 页面。
  （DCR 默认 403 的断言另由 `tests/claude-connector.test.js` 覆盖。）
- [x] **全量 npm test 绿（以 lead 最近实跑为准）** —
  `npm test` — 上一记录 `1583 tests / 1577 pass / 0 fail / 6 todo`（2026-11-25 lead 实跑）；docs 分支基于 main cd23fdc（含 PR #28），
  **不要引用子代理/PR 里的数字**；并发 agent 会改变总数，以 ledger §5 当次记录为准。
- [x] **静态扫描无 P0** —
  `node scripts/audit-truncation.mjs --ci` — `P0=0 PASS`（仅 P1 warning）。

### 1.2 Deploy

- [x] **生产已部署包含授权切换的构建** —
  证据：[DEPLOYMENTS.md](DEPLOYMENTS.md) 2026-11-25 01:55 行 + 2026-11-25 02:39 SGT 实查生产 `GET /healthz`：
  `commit=f2002d9ca48e55292eb824faa10b85b39ea35440` / `buildHash=3b1a07726fdaa28a21f594cdb07981bcbd015f0c` / `builtAt=2026-11-24T17:54:55.590Z` / `env=production` / `deploymentId=dpl_6P2Ww8vsTHXbbSF98GTE55HKitB4` / `configLoaded=true` / `mode=codemode`。
  通过标准：部署的是 PR #29（Linear static PAT + Notion gateway-owned OAuth）之后的构建，不是旧 artifact。`main cd23fdc` 只有评测修复（PR #28），未部署，不影响本授权路径。
- [ ] **环境变量命名空间正确** —
  证据：生产 `/healthz` 已核 `env=production`；但 preview/local 是否隔离、能否读到 production key 未实测。
  通过标准：授权目标 env 与部署 env 一致（生产部署 = production）；local/preview 绝不写 production key。

### 1.3 Provider method（每个 provider 都要单独确认）

- [x] **Linear 生产走 `static_bearer`（PAT），且已实测可用** —
  证据：配置 `authMode: static_bearer` + `tokenEnv: LINEAR_API_KEY` + `url: https://mcp.linear.app/mcp/readonly`（`config.example.json` 的 linear 上游条目与生产一致；`_authProvisioning` 里的 `LINEAR_PAT_STATIC` 只是脚本占位名）；
  `f2002d9` 实测 2026-11-24T18:17Z：`linear` 27 tools，`codemode.linear__list_teams({ limit: 5 })` 返回真实团队（[active-eval 记录](eval/active-eval-2026-11-24-cloud-control.json)；`requestId: unknown`）。
  通过标准：不走 refresh；PAT 只存部署环境 Secret（值不记录），scope 尽量只读（`/mcp/readonly`）。
- [x] **Linear PAT 已由 owner 创建并注入目标环境 Secret（不是聊天窗口临时贴 token）** —
  证据：production Secret `LINEAR_API_KEY` 已配置（[DEPLOYMENTS.md](DEPLOYMENTS.md) 2026-11-25 01:55 行，值不记录）+ 上项实测。
  通过标准：token 值不进 git/文档/日志；由 operator 在正确 env 注入。
- [ ] **暴露过的 Linear PAT 已轮换** —
  证据：无（按 §1.9，须在 Notion 8h/72h 观测通过后执行，现在**不要**轮换以免打断观测）。
- [x] **Notion 网关自有 OAuth/DCR 已完成一次真实授权** —
  证据：2026-11-25 01:56 callback 已落网关 v2 KV grant（`owner=gateway`、`source=gateway-dcr`、`refresh=yes`）；用该 access token 直接对 Notion `tools/list` 返回 200（[DEPLOYMENTS.md](DEPLOYMENTS.md) 注记）。
  通过标准：grant 必须属于网关、可 refresh；不得复用 DSH 的 rotating refresh token。
- [ ] **Notion 经生产网关运行时可用** —
  证据：`f2002d9` 实测 `codemode.services()` 中 `notion` 仍 `offline`（0 tools、`needsReauth`），`codemode.search('notion')` 为 0；同窗口 github 42 / linear 27 / vercel 73 / figma 47 在线，共 189 tools（active-eval 记录）。生产 `/healthz` 显示 `configLoaded=true` 且 `servers` 列表含 `notion`，说明配置已加载、问题不在配置缺失。
  通过标准：部署 PR #31 后冷启动不再报 `notion` 401，`services()` 显示 online 且 tools>0。**当前未通过。**
- [x] **Notion runtime offline 根因已定位（待修）** —
  证据：`src/upstream/upstreams.js` 的 `_resolveToken()` 首行 `if (!config.tokenEnv) return undefined;`，`_createTransport()` 仅在 `config.tokenEnv` 存在时注入 `Authorization`；
  PR #29 后生产 Notion 没有 `tokenEnv`（token 在 KV），于是运行时从不读 KV grant、请求不带 Authorization → 必然 401。PR #31（`fix/notion-gateway-oauth-token`，commit `9e7c57c`）修复中，**未合并、未部署**。
- [x] **Notion DCR 代码已实现** —
  证据：`src/upstream-oauth.js` 对 `dcr:true` 在 start 时 POST `registration_endpoint`，持久化 `gmcgw:v2:client:<env>:<server>`，client_id 写入 OAuth state；callback/refresh 使用 state/record 的 client_id；`tests/provider-dcr-cimd.test.js` 覆盖注册成功/失败/重复 start 不重复注册/竞态复用/回调/刷新。
- [x] **Notion static MCP token 路线诚实** —
  证据：`tests/auth-provision.test.js` 的 Notion static 分支测试；
  Business/Enterprise 才能创建 MCP token，REST integration token 无效。当前生产走网关自有 OAuth，不依赖 static token。
- [x] **Vercel OAuth-only 配置带 offline_access** —
  证据：`src/upstream-oauth.js` authorize URL 显式添加 `openid offline_access`（Vercel PR metadata 只广告 `openid`，不足）+ `resource=https://mcp.vercel.com/`；回调无 refresh_token 直接 400；测试 `Vercel CIMD: authorize URL carries openid + offline_access...`。
- [x] **Vercel CIMD 代码已实现（但真实部署/授权未做）** —
  证据：`src/vercel-app.js` 新增公开路由 `GET /.well-known/mcp-client.json`（`client_id` = 文档 URL、`token_endpoint_auth_method: none`、S256、`scope: openid offline_access`）；`config.example.json` 中 `clientId` 为占位 HTTPS URL；测试覆盖文档形状与路由。
- [ ] **Vercel CIMD 真实部署并完成一次授权** —
  证据：无；CIMD 文档尚未部署到稳定 HTTPS 域名，`clientId` 仍是占位 URL，也未确认真实 `refresh_token` 非空。AS 侧曾拒绝 CIMD → **BLOCKED**。

### 1.4 Env namespace

- [x] **入站/授权相关变量名在目标环境存在（只记变量名，不记值）** —
  生产已配：`LINEAR_API_KEY`（Linear static PAT）、`UPSTREAM_OAUTH_ADMIN_KEY`（`/upstream/oauth/start` 管理入口）、`OAUTH_APPROVE_PASSPHRASE`（consent 审批口令）、`ALLOW_DCR_FOR_CHATGPT=1`（ChatGPT DCR 显式 carve-out）。
  另有 `CLIENT_PLATFORM_OAUTH_MAP`：已追加 ChatGPT 客户端 → `chatgpt` 的平台映射（Config），截至 `f2002d9` **尚未 redeploy 生效**。
  通过标准：变量名齐全且只写名字；任何值（PAT/passphrase/admin key/client secret）都不进文档/日志/stdout。
- [ ] **KV 凭据只在该环境配置** —
  证据：生产 KV 已有 Notion grant；preview/local 是否共用同一 KV 未实测。
  通过标准：不存在跨环境共用 KV；本地/预览读不到 production key。

### 1.5 Owner / provisioning

- [x] **脚本对 static 写 owner=manual 的 v2 grant，不写 OAuth grant** —
  证据：`buildStaticGrant()` + `Vercel: --apply on an OAuth plan performs no KV write` 测试。
  通过标准：static 记录 `owner=manual`、`source=manual`、`authMode=static_bearer`；OAuth provider 不被脚本写 grant。
- [x] **网关 grant 记录身份完整** —
  证据：Notion callback 写入的 v2 grant 记录 `owner=gateway`、`source=gateway-dcr`、含 `grantId`/`environment`；refresh 由记录自身 client 信息完成（无需 env client_id）。
- [ ] **`--apply` 已由 operator 在正确 env 执行且 KV 记录可读** —
  证据：无。Linear 走环境变量 Secret（不经 `auth-provision --apply`）；Notion 的 gateway grant 由 OAuth callback 直接写 KV，未走 `--apply`。
  通过标准：如走脚本，`result: READY ... wrote=true` 且 v2 key 的 `environment` 与 key 一致。
- [ ] **`getAuthStatus()` 返回 ACTIVE（或明确的 static 状态）** —
  证据：`f2002d9` 的 `codemode.services()` 对 `notion` 报 `offline/needsReauth`（runtime bug，不是 grant 失效）；Linear static 状态未单独核。
  通过标准：不是 `REAUTH_REQUIRED`/`SHARED_GRANT_REFRESH_FORBIDDEN`；static 过期报 `STATIC_TOKEN_NO_REFRESH`。

### 1.6 Real validation（必须真实跑过，不能用 fake 代替）

- [x] **Linear 真 `tools/list` 经生产网关成功** —
  证据：`f2002d9` 实测 `linear` 27 tools + `linear__list_teams` 返回真实团队（2026-11-24T18:17Z；`requestId: unknown`，回查锚点已写入 active-eval 记录）。
  通过标准：真实 fetch，非测试 fake。
- [ ] **Notion 真 `tools/list` 经生产网关成功** —
  证据：直接连接 Notion `tools/list` 返回 200（用 KV 里的 access token），但经生产网关 `codemode.services()` 仍 0 tools。**未通过。**
- [ ] **真实 gateway 冷启动连得上全部上游** —
  证据：`f2002d9` 冷启动日志 `1/5 upstreams failed: notion`（`401/invalid_token`，实为请求不带 Authorization）。通过标准：无 401/REAUTH。
- [ ] **跨环境隔离实测** —
  证据：preview 实例故意缺授权时读不到 production key。通过标准：无跨环境 grant 读取，无 production grant 被烧。
- [ ] **Notion 8h 稳定观测** —
  证据：无。仅完成一次授权；须至少跨越一次 access token 生命周期/一次自动 refresh，确认 refresh 成功且不触发 `invalid_grant`。
  前置：先合并并部署 PR #31，`services()` 恢复 online 后才开始计时。
- [ ] **72h 无 `invalid_grant`（[ACCEPTANCE.md](ACCEPTANCE.md) 门 D）** —
  证据：无。连续 72h 观测（含至少一次强制刷新/重启）通过后才算授权生命周期验收。

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
    - static token 失效/需轮换 → 只换目标 env 的 `LINEAR_API_KEY` 并重验，不动 OAuth/grant 记录；
    - 新 grant 授权失败 → 保留旧 gateway-source v2 记录，不回滚到 `dsh` source；
    - environment 错配 → 删除错误 key 重新 `--apply`/重新授权，绝不复制 production 记录到 preview/local；
    - **不可回滚底线**：任何回滚路径都不重新启用 `owner=dsh`/未标记 grant 的自动刷新。

### 1.9 旧凭据清理与轮换（8h/72h 后执行；当前禁止执行）

以下步骤**故意延后**：Notion 是 rotating refresh（一步 reuse 窗口，replay 会吊销整个 grant），在观测通过前删除旧连接/旧 env 或轮换 PAT 会打断观测、并可能制造"看起来像 bug 的 401"。

- [ ] **前置门禁：Notion 8h + 72h 稳定观测通过**（§1.6 后两项全绿）。
- [ ] **移除旧 DSH Notion 连接**（DSH 侧不再持有 Notion grant，避免第二个 client 继续刷新）。
- [ ] **移除旧 `NOTION_*` / `LINEAR_*` refresh env**（旧 refresh token 类环境变量；变量名按部署实际清单核对，值不记录）。
- [ ] **轮换暴露过的 Linear PAT**（更新目标 env Secret 并重验 `linear__list_teams` 与 tools 数）。
- [ ] **清理后复验**：`codemode.services()` 全部 online + Linear/Notion `search` 正常，并记录到 [DEPLOYMENTS.md](DEPLOYMENTS.md)/ledger。

---

## 2. 当前未完成项（为什么现在不能要授权）

诚实清单——以下每一项都是真实阻塞，不是"差不多"：

1. **Notion 生产 runtime offline（P0）**：授权本身成功（KV `owner=gateway`/`source=gateway-dcr`/`refresh=yes`，直接 `tools/list` 200），但 `f2002d9` 网关运行时 `codemode.services()` 0 tools/`needsReauth`；根因是 `_resolveToken()`/`_createTransport()` 在无 `tokenEnv` 时提前返回、请求不带 Authorization。PR #31 未合并、未部署。
2. **Notion 8h/72h 未观测**：只完成一次授权；自动 refresh 稳定性、`invalid_grant` 风险、重启后 grant 复用都未验证（§1.6）。
3. **Vercel CIMD 未落地**：CIMD 文档未部署到稳定 HTTPS 域名，真实授权被 AS 拒绝（BLOCKED）。
4. **KV 环境隔离未实测**：production KV 已有真实 grant，preview/local 隔离与"绝不写 production key"没有实测证据（§1.2/§1.4）。
5. **回滚未演练**：§1.8 没有任何一项有真实证据。
6. **旧凭据清理/轮换未做（有意延后）**：旧 DSH Notion 连接、旧 `NOTION_*`/`LINEAR_*` refresh env 仍在，暴露过的 Linear PAT 未轮换——必须等 8h/72h 稳定观测通过（§1.9）。
7. **入站审批口令未做真实客户端端到端验收**：`OAUTH_APPROVE_PASSPHRASE`/`ALLOW_DCR_FOR_CHATGPT=1`/`UPSTREAM_OAUTH_ADMIN_KEY` 已在生产生效（PR #26 + 部署记录），但"拒绝错误口令 → 403 不落 code"和"正确口令完成授权"没有真实客户端截图/日志证据；`CLIENT_PLATFORM_OAUTH_MAP` 的 ChatGPT 映射尚未部署生效。
8. **Issue #27 未实现**：生产同时存在预注册 client 与 DCR 两套接入；统一 Client Registry 替代生产 DCR 是 M6 开源前必须项（Issue 标签 `p1`，内部 P0 Registry/CLI → P1 cutover），当前未开工。

→ 因此 **NOT READY**。在 §1.1–§1.9 全绿、§2 全部消除前，不要向用户发出任何授权请求。

---

## 3. 授权流程（全绿之后才执行）

一旦 §1 全绿：

1. 每个环境各做一次，**不跨环境复用授权**。
2. Linear static 路线：owner 在目标环境注入 PAT（`LINEAR_API_KEY`，值只进 Secret）→ operator 跑
   `node scripts/auth-provision.mjs --provider linear --token-env LINEAR_API_KEY --environment <env> --verify --apply`
   → 确认 `result: READY ... wrote=true`，并做一次真实 `linear__list_teams` 复验（static token 无 refresh）。
3. Notion 交互路线（生产现行）：确认 `config` 中 `dcr:true` + `registrationEndpoint` →
   走 `/upstream/oauth/start?server=notion&env=<env>&key=<UPSTREAM_OAUTH_ADMIN_KEY>`（key 值不记录）→
   在 consent 页输入 `OAUTH_APPROVE_PASSPHRASE`（值不记录；错误/缺失 403 且不落 code）→
   确认 v2 KV grant `owner=gateway`/`source=gateway-dcr`、`gmcgw:v2:client:<env>:notion` 只写一次且不重复注册 →
   `codemode.services()` 显示 `notion` online 且 `search('notion')` 有结果后才算授权可用。
4. Vercel：把 CIMD 文档部署到稳定 HTTPS 域名，确认 `GET /.well-known/mcp-client.json` 可被 AS 抓取且 `client_id` 等于该 URL → 把该 URL 写入 `config.clientId` → 走一次 `/upstream/oauth/start?server=vercel&env=<env>&key=<ADMIN_KEY>`
   → 回调确认 `refresh_token` 非空 → `getAuthStatus()` ACTIVE。
5. 重连 MCP client（工具 schema 未变，通常不需要改 Gemini 侧）。
6. 观察 8h（Notion 至少一次自动 refresh）与 72h 无 `invalid_grant`（ACCEPTANCE 门 D）→ 通过后才执行 §1.9 清理/轮换。
7. 按 **Issue #27** 迁移到预注册 Client Registry，并把生产 DCR 默认关闭（M6 开源前必须完成）。

再次强调：**这一步在上述 checklist 未全绿前禁止执行。**

---

## 4. 变更范围与不变量

本轮涉及（PR #26/#28/#29 已合入 main；PR #31 仍 OPEN；括号内为部署状态）：

- PR #26 `9eb0c7a`（已部署）：`src/client/oauth.js`（consent 审批口令、常量时间比较）+ `tests/oauth-approve-passphrase.test.js`。
- PR #29 `f2002d9`（已部署）：`config.example.json`（Linear `static_bearer` + `/mcp/readonly` + `LINEAR_API_KEY`；Notion 网关自有 OAuth/DCR）+ `tests/auth-static-config.test.js`、`tests/owner-marking.test.js`、`tests/token-liveness.test.js`；生产配置/env 在 Vercel 侧（值不记录）。
- PR #28 `cd23fdc`（**未部署**，只影响评测脚本）：R2 分页/截断/成功样本/提示词/findings 覆盖修复。
- PR #31（**OPEN，未合并**）：`src/upstream/upstreams.js` + `tests/upstreams.test.js`，修"无 `tokenEnv` 时也要从 KV grant 注入 Authorization"（Notion runtime offline 的根因）。

生产 env（只记变量名，严禁记录值）：`LINEAR_API_KEY`、`UPSTREAM_OAUTH_ADMIN_KEY`、`OAUTH_APPROVE_PASSPHRASE`、`ALLOW_DCR_FOR_CHATGPT=1`；`CLIENT_PLATFORM_OAUTH_MAP` 已追加 ChatGPT 映射但未 redeploy。

不变量：static token 永不 refresh；token / client_secret / passphrase / admin key 永不进 stdout、日志、git、公开文档；v2 key 的 environment + owner 永远显式；未标记/dsh grant 永不自动刷新（这条不回滚）；DCR 客户端只写 `gmcgw:v2:client:<env>:<server>`，绝不污染 legacy v1 key；重复 start 绝不重复注册（避免 orphans grant）；入站 consent 无有效审批口令必须 403 且不落 code；DCR 默认关闭，仅显式 `ALLOW_DCR_FOR_CHATGPT`/`ALLOW_DCR_FOR_CLAUDE` carve-out；旧凭据在 8h/72h 观测通过前不删除、不轮换。
