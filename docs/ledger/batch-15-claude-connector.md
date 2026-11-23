# B15 · Claude.ai web connector OAuth callback 最小兼容（2026-11-23）

> 范围（本批只写所列文件）：
> - `src/oauth.js`（改）：共享 redirect 校验器新增 Claude 官方回调；不新增工具、不改工具面。
> - `tests/claude-connector.test.js`（新增）：9 项确定性回归。
> - `docs/CLIENTS.md`（仅改 Claude 行）：状态改为「OAuth callback allowed；真实 connector 未验证」。
> - 本台账 `docs/ledger/batch-15-claude-connector.md`（新增）。
>
> **未改** `src/upstream-*`、`scripts/`、其它 `tests`、`README`、workflows、契约文档。
> **未 commit / push / deploy**。未联网、未触真实凭据、未开 issue。
> 遵守 `AGENTS.md`：conformance 的 fail 标记是待验证信号，本批只按用户给定的官方回调地址做确定性实现与本地回归，不代表真实 connector 已验证。

---

## 一、输入与判断

- 背景：现有 redirect allowlist 支持 Google relay 与 ChatGPT 的
  `chatgpt.com/connector_platform_oauth_redirect`、`/connector/oauth/<id>`；
  Claude.ai 的 `https://claude.ai/api/mcp/auth_callback` 未允许，conformance 标 fail。
- Claude 所需的 401 `WWW-Authenticate` metadata、`readOnlyHint`/`destructiveHint`、text results
  已由 `src/vercel-app.js` / `src/client-profile.js` 处理；本批**不重做**、不改工具面。
- 用户指定的唯一官方回调：`https://claude.ai/api/mcp/auth_callback`。

## 二、改动逐项

| 项 | 实现 | 约束 |
|---|---|---|
| 共享校验器 | `isAllowedRedirectUri` 新增 `claude.ai` 分支：严格 `https:`、无 userinfo、host=`claude.ai`、pathname=`/api/mcp/auth_callback`、无显式非默认端口、无 query、无 fragment | 只加一个精确回调；其它 host/path 一律 false；Google/ChatGPT 分支未动 |
| 平台识别 | 新增导出 `isClaudeRedirectUri`（共享校验器 + host 精确匹配） | 与 `isChatgptRedirectUri` 对称，供 authorize/token 平台隔离使用 |
| DCR | 新增 `isClaudeClientRegistration`：所有 redirect 必须是 Claude 回调，且 `client_name`/`client_uri`/`token_endpoint_auth_method` 显式标识 Anthropic/Claude；记录 `platform: 'claude'`、`claudeDcr: true` | LOCKED 默认仍拒绝全部 DCR；仅 `ALLOW_DCR_FOR_CLAUDE=1` 打开窄 carve-out；混合平台 redirect 集合被拒 |
| authorize | Claude 客户端只能用自己的回调；Gemini locked client 明确拒绝 Claude 回调（沿用既有 ChatGPT 拒绝语义，错误文案新增 Claude 版本）；legacy「locked 客户端接受任意 allowlist redirect」分支收窄为仅 Google relay | 不改变 Google/ChatGPT 既有流程与错误文案 |
| token | code/refresh 记录 `platform: 'claude'`；Claude code 只能由 Claude 客户端兑换；refresh 走同一公共客户端语义（非轮换） | 与 ChatGPT 隔离一致；Gemini code 不受影响 |
| 校验器复用 | DCR、authorize、token 全部调用同一个 `isAllowedRedirectUri` | 无第二套白名单 |

## 三、测试结果（只报告本批文件，不替并发改动背书）

### 新增测试
`node --test tests/claude-connector.test.js` → **9 tests, 9 pass, 0 fail**。

覆盖：
- Claude 官方回调允许（含大小写 host 归一化）；
- 恶意变体拒绝：http、非默认端口、其它 host（含后缀欺骗）、`www.`/`anthropic.com`、path 变体（`/`、`/api/mcp`、尾斜杠、附加段、大小写、`..`、`/other/path`）、userinfo（含/不含密码）、query（含 `code=evil`）、fragment、非 URL；
- Google relay（含 legacy 嵌套 path）与 ChatGPT 两种回调回归；
- DCR 拒绝恶意 Claude 变体、接受精确回调、`platform=claude`；
- 混合平台 redirect 集合（Claude+Google、Claude+ChatGPT）被拒；
- DCR → authorize（RFC 9207 `iss`）→ token（PKCE、非轮换 refresh）全链路；
- LOCKED 默认拒绝 DCR；`ALLOW_DCR_FOR_CLAUDE=1` 窄 carve-out 可用且不动 Gemini locked client；
- Gemini locked client 拒绝 Claude 回调；Claude code 不能被 Gemini locked client 兑换。

### 既有相关测试（定向复跑）
`node --test tests/chatgpt-oauth.test.js tests/oauth.test.js tests/client-lock.test.js`
→ **20 tests, 20 pass, 0 fail**。ChatGPT/Gemini OAuth 行为零回归。

### 全量 npm test（实际运行结果）
`npm test` → **988 tests, 982 pass, 0 fail, 6 todo**。

说明：第一次全量运行出现 1 例 `tests/audit-truncation.test.js` 的 P0 断言失败
（扫描 `src/` 中未标记截断）。独立运行 `node scripts/audit-truncation.mjs` 得到 P0=0，
单独复跑该文件 15/15 通过；判定为该时刻其它 agent 并发改 `src/` 造成的瞬时状态，
**与本批 `src/oauth.js` 改动无关**（本批未新增任何字符串截断）。
随后重跑全量即为上面的全绿结果。按要求「并发影响只报告自己的」：本批自己的 9 项
测试与 OAuth 相关既有测试全绿；未改、未修、不为其它 agent 的并发改动背书。

## 四、诚实边界

- `docs/CLIENTS.md` 只写「OAuth callback allowed；真实 connector 未验证」，不承诺已实测。
- 未使用真实 Claude.ai connector / 真实 OAuth 授权窗口；未验证 Streamable HTTP、
  自定义 header、401 metadata 在真实 Claude 客户端上的表现。
- 未改工具数/工具 schema（仍为三工具面）；未改 DCR 之外的认证架构。

## 五、变更控制

本批只写 4 个文件（1 src + 1 test + 2 docs）；未 commit / push / deploy；
无凭据入仓；无网络调用。证据留在工作区与台账，供 lead 集成与复核。
