# B15 后续 — gateway-owned OAuth 隔离 HTTP 端到端 harness

> 状态：**代码 + 测试完成，未 commit / push / deploy**。本 harness 只做隔离验证，
> 不等于真实授权就绪；`docs/AUTH-READY.md` 的 NOT READY 结论不变。
> 范围：只新增 `scripts/auth-e2e-harness.mjs`、`tests/auth-e2e-harness.test.js`、本文。
> 未改：`src/`、其他 `scripts/`、`tests/`、README、workflows、config、任何契约文档。

---

## 0. 结论

新增一条**隔离 HTTP 端到端**验证链路：真实 Node `http` loopback + 真实路由处理器
（`src/upstream-oauth.js` 的 `/upstream/oauth/start`、`/callback`，`src/vercel-app.js`
的公开 CIMD 路由），只在最外两层注入 fake：

- **fake provider fetch**：固定字符串响应（`FAKE-ACCESS` / `FAKE-REFRESH` /
  `FAKE-NOTION-DCR-CLIENT` / `FAKE-CODE` …），绝不读真实 token/client_secret；
  任何不在 allowlist 的 URL 直接抛错，网络泄漏立即失败。
- **fake store**：内存 Map，模拟 `_command` / OAuth state / `casToken`，
  绝不访问真实 KV、vault 或磁盘。

跑法：

```text
node scripts/auth-e2e-harness.mjs     # 输出 {ok, checks[]}，全绿退出码 0
node --test tests/auth-e2e-harness.test.js
npm test
```

输出是机器可读 JSON；任一 check 失败时 `ok:false`，该 check 带明确的 `error`。
不打印 token / client_secret（固定字符串也不会出现在报告或断言消息里，
失败消息经 redact 处理）。

---

## 1. 覆盖的 check

| check 名 | 验证内容 |
| --- | --- |
| `notion-dcr-start-register-redirect` | HTTP start → 302；authorize URL 的 DCR client_id、RFC 8707 resource、PKCE challenge；恰好一次注册 POST；只写 `gmcgw:v2:client:local:notion`，不碰 v1 |
| `notion-dcr-repeated-start-reuses-client` | 第二次 start 不再 POST /register（不 orphan grant） |
| `notion-dcr-callback-seeds-v2-gateway-grant` | callback 200；`gmcgw:v2:grant:local:gateway:notion` 记录 `owner=gateway` / `source=gateway-dcr` / `environment=local`；响应体无 fake secret |
| `vercel-cimd-document-route-200` | 真实路由 `GET /.well-known/mcp-client.json` 返回 200 JSON；client_id = 文档 URL；公开客户端无 client_secret |
| `vercel-cimd-authorize-scope-and-resource` | authorize URL 含 `openid`、`offline_access`、`resource=https://mcp.vercel.com/`、`client_id`=CIMD URL；CIMD 不做 DCR |
| `vercel-cimd-callback-no-refresh-token-400` | 变体 fake AS 返回无 refresh_token → 400，且**不** seed 任何 grant |
| `callback-missing-state-400` | 缺失 state → 400 |
| `callback-wrong-environment-400` | local state 用 `env=production` 回调 → 400，不写 production grant |
| `shared-grant-never-refreshed` | seed `owner=dsh` 的 grant 后强制 refresh：token endpoint 调用数不变、状态 `REAUTH_REQUIRED` / `SHARED_GRANT_REFRESH_FORBIDDEN` |
| `preview-production-key-isolation` | preview 与 production 各写一条 v2 grant，key/token 完全隔离，无 v1 key |

`runAuthE2E({ failCheck })` 可注入失败，用于验证报告的失败语义（`ok:false`
+ 明确的 check 名 / error），测试中有对应用例。

---

## 2. 安全边界（为什么它不联网、不泄密）

1. `createFakeFetch()` 只接受三个 allowlist URL（Notion register/token、Vercel token），
   其他任何 URL（包括 `https://attacker.example`）立即抛错；测试直接断言该行为。
2. loopback server 只绑定 `127.0.0.1` + 随机端口；`fetch` 走本机回环，
   不发往任何外网地址。fake provider 只回固定字符串，不接受外部输入拼 URL。
3. 所有写入落进 `FakeStore` 的 Map；没有 `TokenStore` 实例、没有 KV 环境变量读取、
   没有文件系统写入。
4. logger 里唯一出现的上游文字是源码自身的
   `[upstream-oauth] ... stored (refresh: yes)`、`[upstream-auth] ... SHARED_GRANT_REFRESH_FORBIDDEN`
   等非敏感行；测试捕获 stdout/stderr 并断言任何 fake secret 字面量都不出现。
5. 报告字段只有 check 名、`ok`、`detail`、`error`；`error` 经 redact。

---

## 3. 验证记录

```text
node scripts/auth-e2e-harness.mjs           # ok:true, 10 checks, 10 pass
node --test tests/auth-e2e-harness.test.js  # 9 tests, 9 pass, 0 fail
npm test                                    # 全量绿（见 §5）
```

---

## 4. 如何用真实环境替换 fake（**部署后**才做，本批未执行）

> 以下是给 lead/operator 在受控环境执行的操作说明，**不是本 harness 自动做的事**。
> 不要在 checklist 未全绿前要授权；见 `docs/AUTH-READY.md` §1/§2。

1. **准备**：确认已部署包含 DCR/CIMD 代码的构建，`GET /healthz` 的
   commit/buildHash 与本地 `node scripts/write-build-info.mjs --print` 一致；
   目标 env 的 `GMCGW_ENVIRONMENT`/`VERCEL_ENV` 与授权 env 一致；KV 环境变量只配在该 env。
2. **替换 fetch**：把 `createFakeFetch()` 换成真实 `globalThis.fetch`（或带超时/重试的
   wrapper）。先只跑 **start**：
   `GET <gateway>/upstream/oauth/start?server=notion&env=<env>&key=<ADMIN_KEY>`，
   期望 302、`location` 指向 provider、`state`/`code_challenge`/`resource` 齐全；
   在 KV 里核对 `gmcgw:v2:client:<env>:notion` 只出现一次。
   Vercel：先 `GET <gateway>/.well-known/mcp-client.json`，确认公网可抓取、
   `client_id` 等于该 URL；再 start，核对 scope 含 `openid offline_access`。
3. **替换 store**：把 `FakeStore` 换成 `new TokenStore()`（读该 env 的真实 KV 凭据）。
   用浏览器完成 provider 授权后跳回真实 callback URL；核对 HTTP 200、
   `gmcgw:v2:grant:<env>:gateway:notion` 与 `...:vercel` 记录存在且
   `owner=gateway`、`environment` 与 key 一致；Vercel 必须非空 `refresh_token`。
4. **生命周期核对**：用 `UpstreamAuth`（真实 store + fetch）调用
   `getAuthStatus(server)` 应为 `ACTIVE`；观察一次真实刷新（Vercel ~1h），
   确认没有 `invalid_grant` / `REAUTH_REQUIRED`。DSH 导出的 shared grant 必须仍拒绝刷新。
5. **隔离核对**：在 preview 实例故意不配授权，确认它读不到 production v2 key；
   任何回滚路径都不重新启用 `owner=dsh`/未标记 grant 的自动刷新。
6. **禁止事项**：真实 token/client_secret 不进仓库、不进日志、不进 harness 报告；
   一次授权后凭据从 vault 读取（`docs/CREDENTIALS.md`），不要每个窗口重新要 token。

---

## 5. 全量测试

> 本节由最终运行填写；并发 agent 对其他文件的改动不计入本批。

```text
npm test   # 1107 tests, 1101 pass, 0 fail, 6 todo（含本批 9 项；全量绿）
```
