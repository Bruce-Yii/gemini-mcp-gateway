# B15 后续 — gateway-owned 授权 provisioning 与"授权前全绿"清单

> 状态：代码 + 确定性测试完成（**未 commit / push / deploy**）。真实授权处于 **NOT READY**，见 `docs/AUTH-READY.md`。
> 范围：只写 `src/upstream-oauth.js`、`src/upstream-auth.js`、`src/config.js`、`config.example.json`（仅占位字段）、`scripts/auth-provision.mjs`（新增）、`tests/auth-provision.test.js`（新增）、`docs/AUTH-READY.md`、`docs/ledger/batch-15-auth-provisioning.md`。
> 未改 `src/capture.js`、`src/server.js`、其他 scripts/tests/README/workflows。
> 依据：`docs/ledger/batch-15-auth-arch-fix.md`（owner/environment/lease/static_bearer 后端已完成）、`docs/eval/AUTH-PROVIDERS.md`（2026-11-23 provider 事实）、`docs/ledger/batch-15-auth-architecture.md`（§6 迁移/回滚）。

---

## 0. 用户约束与结论

用户明确要求"**完全做好再找我要授权，不能再反复试**"。本批把"可交付前状态"定义为：代码、确定性测试、provider 方法事实、命名空间、owner、provisioning 脚本、清单全部就绪；**真实授权/部署/验证另算，未做就不叫可交付**。

结论：**代码侧就绪，真实授权 NOT READY**。`docs/AUTH-READY.md` 是唯一门槛文档；任何一项不绿都不发授权请求。

---

## 1. 改动逐项

### 1.1 `src/config.js` — authMode 显式可用

- 导出 `AUTH_MODES = ['oauth','static_bearer']`、`STATIC_BEARER`。
- `SERVER_KEYS` 增加 `authMode`、`staticBearer`（不再产生 unknown warning）。
- 校验：非法 `authMode` 报错；`staticBearer` 必须是 boolean；`authMode:'oauth'` 与 `staticBearer:true` 冲突报错。
- `static_bearer` **必须**有 `tokenEnv`；**禁止** `refreshEnv`/`refreshUrl`/`authorizeUrl`/`clientIdEnv`/`clientSecretEnv`/`expiresInEnv`/`obtainedAtEnv`（静态 token 无 rotating grant，防止静默错配）。
- 绝不从 `envToken` 推断静态模式 —— 必须显式声明。

### 1.2 `src/upstream-auth.js` — UpstreamAuth 显式 static 路径

- 导出 `AUTH_MODES` / `STATIC_BEARER`（与 config 对齐）。
- `getAccessToken(..., { authMode })`：当 `authMode === 'static_bearer'` 时：
  - 直接返回 `envToken`；**不读 refresh endpoint，即使 `force:true`（provider 401）也不刷新**。
  - best-effort 在 `gmcgw:v2:grant:<environment>:manual:<server>` 写 `owner=manual`、`source=manual`、`authMode=static_bearer`、`bootstrapped:false`、无 `refresh_token`/`client_id` 的记录；KV 缺失不影响静态连接。
  - `force:true` 时把状态置为 `REAUTH_REQUIRED / STATIC_TOKEN_NO_REFRESH`（终态，明确告知 owner 需轮换）。
- 原有 OAuth refresh 生命周期（owner fence / environment fence / lease / CAS / invalid_grant 终态 / 同实例 coalescing）**逐字保留**，未改语义。

### 1.3 `src/upstream-oauth.js` — 未改功能，只记录事实

本批未改该文件逻辑（保持上一批 auth-arch-fix 的实现）。关键事实写入清单与脚本：

- 当前仅支持静态 `authorizeUrl` + `clientIdEnv` 的授权码 + PKCE；**没有 DCR/CIMD 注册流程**。
- Notion 官方 OAuth 需要 DCR（`/register`）或 CIMD；现有 handler 做不到 → 清单标 BLOCKED。
- Vercel 需要 CIMD/预审批 client + `offline_access`；现有 handler 已补齐 scope 并在回调无 refresh_token 时 400，但缺 CIMD client_id → 清单标 BLOCKED。
- Linear 官方 MCP 直接接受 Bearer PAT → 优先 static_bearer，不走 handler。

### 1.4 `scripts/auth-provision.mjs`（新增）

- **离线默认**：`planProvision()` 纯函数，零网络；输出 provider/mode/environment/v2 key/token 变量名/blockers/readiness。
- **KV 写入**：仅 `--apply` 时，static 模式写 `gmcgw:v2:grant:<env>:manual:<server>`（`buildStaticGrant()`：`owner=manual`、`source=manual`、`authMode=static_bearer`、无 refresh 字段、含 grantId/environment/leaseId）。OAuth provider **绝不**由脚本写 grant（交给 callback）。
- **网络**：仅 `--verify` 时用可注入的 `fetch` 发 MCP `tools/list`（Bearer），成功才 `verified=true`；401 明确 blocker。测试用 fake fetch，零联网。
- **token 不打印**：`formatPlan()` 对所有输出做 secrets 红 `[REDACTED]`；KV 记录里可有 token，stdout 永不有。
- **环境**：`prod` → `production`；非法 env 直接 blocker。
- **分支**：
  - Linear：static 优先，token env 存在即 offline GREEN；PAT 验证走官方 MCP。
  - Notion：static 路径需 Business/Enterprise static MCP token（REST integration token 无效）；交互 OAuth 明确 BLOCKED（DCR 未实现）。
  - Vercel：OAuth-only，打印 `offline_access`/CIMD/start URL 指引，CIMD 未配置则 BLOCKED。
- **退出码**：0=ready、1=blocked、2=参数错误；`--json` 机器可读（不含 token）。
- CLI 直接执行时才惰性 `import('../src/store.js')` 构造 KV store；被测试 import 时不要求 KV、不联网。

### 1.5 `config.example.json` — 仅占位字段

新增顶层 `_authProvisioning` 占位块（Linear/Notion static env 名 + mode + status，Vercel OAuth client env + requiredScopes + status）。不含真实 token；顶层未知 key 只产生 warning（已验证 `scripts/check-config.mjs` 与 `config-validation.test.js` 仍绿）。

### 1.6 `tests/auth-provision.test.js`（新增，22 项）

覆盖：
1. config：`static_bearer` 合法、缺 tokenEnv/带 refresh 字段/非法值报错（`AUTH_MODES`）。
2. UpstreamAuth：static 不刷新（含 force）、owner=manual + v2 key、force 终态 `STATIC_TOKEN_NO_REFRESH`。
3. token 不打印：`formatPlan` 脱敏（redaction）、`provision` stdout 无 token、无 token 时零网络。
4. v2 key / normalizeEnvironment / buildStaticGrant 结构断言。
5. Linear PAT：offline ready、tools/list verify、401 blocker。
6. Vercel：`offline_access` scope、OAuth plan BLOCKED 指引、OAuth `--apply` 不写 KV。
7. Notion：static ready、交互 OAuth 因 DCR 未实现 BLOCKED、`oauth-dcr` 事实。
8. 清单断言：存在 blocker 即 `ready=false`；`main()` 退出码与 `--json` 无 token。

---

## 2. 验证记录

```text
node --test tests/auth-provision.test.js   # 22 tests, 22 pass, 0 fail
node --test tests/config-validation.test.js tests/auth-arch-fix.test.js \
          tests/upstream-auth.test.js tests/upstreams.test.js  # 37 pass
node scripts/check-config.mjs              # config OK (仅占位字段的 warning)
node --check scripts/auth-provision.mjs    # OK
```

全量 `npm test` 的最终结果在 §4（以实际运行为准；并发 agent 的失败只报告自己的）。

---

## 3. 未做 / 阻塞（诚实记录）

- **真实授权**：Linear PAT / Notion static MCP token 未由 owner 创建；Vercel CIMD client 未配置。
- **真实 KV 写入 / 读取 / getAuthStatus**：`--apply` 从未在目标环境跑过。
- **部署与部署后验证**：本批代码未部署；`tools/list` / `getAuthStatus()` / 冷启动未真实验证。
- **Notion DCR**：未实现；现有 `upstream-oauth.js` 不支持动态注册。必须用户有 static token，或后续批次补 DCR/CIMD。
- **Vercel CIMD**：未配置；OAuth start URL 无法生成。
- **回滚演练**：`docs/ledger/batch-15-auth-architecture.md` §6.4 未逐项真实执行。
- **未 commit / push / deploy**。

→ 详见 `docs/AUTH-READY.md` §2：**现在不能要授权**。

---

## 4. 最终全量测试

> 并发影响：只报告本批 22 项与相关测试的状态，其他 agent 并发修改造成的失败不归入本批。本次运行 `fail 0`。

```text
npm test   # 1010 tests, 1004 pass, 0 fail, 6 todo
```

---

## 5. 人工验收（本批不执行）

- [ ] 按 `docs/AUTH-READY.md` §1 八项逐条打勾并留证据。
- [ ] §1.8 回滚四项演练。
- [ ] 三个 provider 各完成一次真实授权/验证（Vercel 需确认 `refresh_token` 非空）。
- [ ] 观察一个 token 生命周期无 `invalid_grant`。
- [ ] 迁移窗口结束后清理 legacy v1 别名（运维，不在本批范围）。
