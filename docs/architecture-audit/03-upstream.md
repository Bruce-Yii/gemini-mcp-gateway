# 六模块架构审计 · 03 上游接入（Upstream Integration）

> 只读审计：**只新增本文件**；不改 `src/`、`scripts/`、`tests/`、README、其他 docs、workflows；不 commit / push / deploy。
> 时间：2026-11-24（Asia/Singapore）。本文区分【事实】（有代码/测试/文档落点）、【判断】（基于事实的架构判断）、【缺口】（未做/未验证）。
> 证据纪律：fake / replay / SKIP ≠ pass；“代码就绪” ≠ “线上验收”；真实 token 值不进本文，生产 env 只核变量名是否设置（本次 shell 全部 unset，见 §6.4）。

---

## 0. 审计范围与证据来源

### 0.1 必读并实际读取

- 框架/架构：`docs/FRAMEWORK.md`（用户原文、六模块、SOP、授权第一、配额/浪费）、`docs/ARCHITECTURE-PROGRESSIVE.md`（L0–L4、模块 3 边界）。
- 源码：`src/upstreams.js`、`src/upstream-auth.js`、`src/upstream-oauth.js`、`src/config.js`、`src/store.js`、`src/github-helpers.js`、`src/result-normalize.js`、`src/file-write.js`；辅助核对 `src/sanitize.js`（别名归一化）、`src/catalog.js`（allow/deny + search 排序）、`src/figma-guard.js`（经 UPSTREAMS.md 引用）。
- 配置/文档：`config.example.json`、`docs/UPSTREAMS.md`、`docs/AUTH-READY.md`、`docs/eval/AUTH-PROVIDERS.md`、`docs/ledger/batch-15-auth*.md`（6 篇）、`docs/eval/REAL-GH-REPLAY.md`。
- 测试：`tests/upstream-token-lifecycle.test.js`（23 项）、`tests/upstream-auth.test.js`（4 项）、`tests/upstream-auth-generic.test.js`（4 项）、`tests/upstream-oauth.test.js`（4 项）、`tests/provider-dcr-cimd.test.js`（13 项）、`tests/auth-e2e-harness.test.js`（9 项）。
- 真实证据补充（为回答“真实 vs fake”而额外只读）：`docs/ACCEPTANCE-EVIDENCE-2026-11-24.md`、`docs/AUTH-OWNER-POLICY.md`、`docs/AUTHORITATIVE-TASK-SOURCES.md`、`data/tool-snapshots/*.json`（元数据）、`templates/upstreams/`（文件名）。

### 0.2 本次未采信的内容

- `scripts/analyze-captures.mjs` / 免费模型输出：按 `AGENTS.md` §1 一律只作假设，未作为本报告事实。
- 未读任何 token/client_secret 值；生产 env 只做“是否设置”的存在性检查。

---

## 1. 用户原话校验

`docs/FRAMEWORK.md` §0 逐字保存的 2026-11-24 口述中，模块四（上游接入）原文要点与本报告逐条对照：

| # | 用户原话要点（摘自模块四及交叉段落） | 框架落点 | 本报告对应 |
|---|---|---|---|
| U1 | “目前是 github notion linear Vercel 后续可能会加入 cloudflare Gmail firecrawl exa tavily 等等高频 mcp” | FRAMEWORK §2 模块四、§9 未决 #9 | §2.1 实现清单（四个当前上游 + Figma 额外存在）；§5.2 未来上游延伸 |
| U2 | “授权是一个很重要的问题，涉及到用户体验，可以排在第一位，反复的授权让人很无语” | FRAMEWORK §2 模块四、§8 决策 4 | §2.2 grant owner/refresh/static/DCR/CIMD；§4.1–4.3 owner/DSH/UX 缺口 |
| U3 | “根据不同上游的接入方法…属于开源工程一部分；用户首次使用…引导性问题…做好流程” | FRAMEWORK §2 模块四、§7 | §4.5 公共开源引导缺口；§5.3 SOP 模板（接入/授权含首次引导） |
| U4 | “对每个上游的优化，我们都有固定的 sop” | FRAMEWORK §5 上游 SOP（8 步）、§3.3 交叉表 | §5.3 每上游 SOP 模板（8 步逐项映射到本仓库落点） |
| U5 | 交叉关系：“网关和多个客户端…隔离…哪些东西底层复用…并发场景，上游也有并发限制” | FRAMEWORK §3.1/§3.3、§12 #3/#4 | §4.4 多上游并发/限流缺口；§6.1 可复用底层方法 |
| U6 | “Firecrawl/Exa 等搜索 API 的浪费调用可以优化：去重/缓存/查询预算/结果裁剪/调用合并”（§13.5） | FRAMEWORK §13.5 | §4.5 配额浪费缺口（当前仅 Figma 有 guard，搜索类无） |

结论：六项用户口径在框架中均有明确落点；实现层面对 U2 最直接（授权机制代码最多），U3/U4/U6 的“首次引导、每上游 SOP 全覆盖、搜索类配额优化”仍是缺口（§4、§5）。

---

## 2. 实现清单（连接 / 目录 / 授权 / 别名 / canonical / 写 / 限流重试）

### 2.1 连接层（`src/upstreams.js`）

| 能力 | 事实 | 代码落点 |
|---|---|---|
| 传输类型 | 仅 `stdio` 与 `http`（Streamable HTTP）；SSE-only 不支持 | `upstreams.js:279–321`；`config.js:126–138`；`UPSTREAMS.md` Troubleshooting |
| 工具名 | `server__tool`，双下划线避免 Gemini 首个下划线拆分；上游已自带前缀时不重复加 | `upstreams.js:418–435` |
| 并行连接 | `connect()` 用 `Promise.all` 并行连接所有 server；单个失败进 `failedServers` 与 `errors`，不拖垮网关 | `upstreams.js:323–456` |
| 401 反馈环 | `isAuthError()` 严格识别 401/invalid_token → 强制刷新一次并重连一次；static（`authMode=static_bearer` / `staticBearer`）或无 refreshUrl 的静态 token 直接 `ReauthRequiredError(STATIC_TOKEN_NO_REFRESH)`，不重试 | `upstreams.js:164–190, 351–414` |
| 失败隔离 | 单上游失败关闭 client/transport；错误包装 `upstreamError()` 保留原始 `message` 供 capture full-fidelity，同时挂不可枚举 `modelMessage`（脱敏）供模型可见路径 | `upstreams.js:197–207, 437–455` |
| capture hook | `tapTransport()` 抓 MCP 帧；`makeCaptureFetch()` 抓 HTTP 请求/响应（响应体 clone 后上限 64KB；SSE 不读 body）；`upstream_connect`/`upstream_http`/`upstream` 事件 | `upstreams.js:27–145, 347–356, 502–517` |
| 关闭 | `close()` 逐 client 关闭，失败回退 transport.close，聚合错误 | `upstreams.js:521–539` |

【判断】连接层是模块 3 里最“工程化”的部分：并行、失败隔离、capture、脱敏都已落地；缺口在“跨实例协调”而非单实例连接（§4.4）。

### 2.2 工具目录 / allow-deny（`src/catalog.js`、`src/config.js`）

- 连接时对每个工具跑 `isAllowed(config, entry)`：`denyTools` 先应用，再应用 `allowTools`；空/缺失均放行（`catalog.js:243–249`；`upstreams.js:435, 462–469`）。
- `config.js` 校验 `allowTools`/`denyTools` 必须是非空字符串数组；两者同时设置时 warning（`config.js:275–283`）。
- 上游 annotations（`readOnlyHint` 等）随 entry 保留（`upstreams.js:430–433`），供 `execute_read` 判定只读。
- 搜索是 BM25 + 标识符加权 + `select:<name>` 精确取 schema；`SERVER_ALIASES` 仅硬编码 `repository/repo→github`、`deployment(s)→vercel`（`catalog.js:258–284`）。

【缺口】没有按 server 的“官方/权威任务集 → 工具 allow/deny 基线”自动对齐机制（见 §5.3 SOP 第 3/4 步与 §4.5）。

### 2.3 授权：owner / refresh / static / DCR / CIMD

这是本模块代码量最大、最“深”的部分。核心不变量（来自 `AGENTS.md` §2、`batch-15-auth.md`、`batch-15-auth-architecture.md`）：**DSH 与网关是两个独立 OAuth client，绝不共享 rotating refresh token**。

#### 2.3.1 grant owner 与 fence（`src/upstream-auth.js`）

| 机制 | 事实 | 落点 |
|---|---|---|
| owner 枚举 | `gateway` / `dsh` / `manual`，其余（含未标记）→ `shared`；`_grantOwner()` 按显式 options/record 判定，`dsh-*`→dsh、`gateway-*`→gateway、`manual/static_bearer/pat`→manual | `upstream-auth.js:78, 218–232` |
| 刷新闸门 | `_mayRefresh()` 仅 `owner=gateway` 返回 true；foreign/environment-mismatch grant 只用 access token，返回 `REAUTH_REQUIRED/SHARED_GRANT_REFRESH_FORBIDDEN` | `upstream-auth.js:229–232, 651–687` |
| KV 命名空间 | v2 key `gmcgw:v2:grant:<environment>:<owner>:<server>`；v1 只读别名（仅 gateway + 非 local）；key 的 owner 段取记录自身而非进程默认 | `upstream-auth.js:46–53, 184–202, 237–291` |
| 环境解析 | `GMCGW_ENVIRONMENT`(四值) > `VERCEL_ENV` > `VERCEL=1`→`preview` > 默认 `local`；**永不默认 production** | `upstream-auth.js:147–154` |
| 单 refresher | ① 同实例 `_refreshPromises` 合并并发；② 跨实例 owner-fenced lease（`SET NX EX` + UUID + Lua compare-and-delete + 20s keepalive + 锁内二次读）；③ provider 调用只在锁内；④ CAS 以“实际花掉的 refresh_token”为 fencing，CAS 失败读 winner 不回写；⑤ `invalid_grant` 只有确认 KV 同一 grant 且 winner 不可用才写终态 | `upstream-auth.js:161–181, 318–387, 453–520, 712–843`；`store.js:94–162` |
| 幂等 seed | env 只在“缺记录”或“显式不同 envSeed”时播种；`bootstrapped` 一次尝试后无论成败清掉；`needsReauth` 只有不同 env seed 能清除 | `upstream-auth.js:581–644, 845–887` |

#### 2.3.2 static_bearer（`src/upstreams.js`、`src/upstream-auth.js`、`src/config.js`）

- 只有显式 `authMode:'static_bearer'`（或 `staticBearer:true`）才走静态路径，**绝不从 envToken 推断**（`upstreams.js:231–256`）。
- 直接返回 env token，不进 refresh 生命周期；best-effort `seed({grantOwner:'manual', source:'manual', force:true})` 落 `gmcgw:v2:grant:<env>:manual:<server>` 供 `getAuthStatus()` 报告；静态 401 → `ReauthRequiredError(STATIC_TOKEN_NO_REFRESH)`，不重连（`upstreams.js:367–388`；`upstream-auth.js:530–561`）。
- `config.js` 强制静态模式必须有 `tokenEnv`，禁止任何 refresh/DCR 字段（`config.js:155–205`）。

#### 2.3.3 网关自授权 OAuth / DCR / CIMD（`src/upstream-oauth.js`、`src/store.js`、`src/vercel-app.js`）

- 入口：`/upstream/oauth/start?server=&env=&key=<ADMIN_KEY>`，admin key 恒定时间比较，未设 `UPSTREAM_OAUTH_ADMIN_KEY` 则 404；env 必显式合法（`upstream-oauth.js:207–248`）。
- PKCE S256 + state(24B)+verifier(48B)；state 以 `gmcgw:v1:oauthstate:<env>:<owner>:<hash(state)>` 存储，GETDEL 一次性消费（`store.js:287–316`）。
- `resolveClient()` 三路：DCR（RFC 7591 POST `/register`，持久化 `gmcgw:v2:client:<env>:<server>`，重复 start 复用不 orphan grant）、CIMD（`clientId` 为 HTTPS 元数据 URL）、静态 `clientIdEnv`（`upstream-oauth.js:76–160`）。
- RFC 8707 `resource` 与 scope 增强：Notion=`https://mcp.notion.com/mcp` + `default`（DCR/CIMD 路径**不发** offline_access，AS 按策略发 refresh）；Vercel=`https://mcp.vercel.com/` + `openid offline_access`（PRM 只广告 openid，必须补齐）；回调无 refresh_token（Vercel）直接 400，不 seed（`upstream-oauth.js:38–50, 315–341, 460–467`）。
- 回调 seed 完整 grant 身份：`owner=gateway`、`source=gateway-dcr|cimd|oauth`、`grantId=gw:<env>:<server>:<sha256(clientId|refreshUrl)>`、`environment`，写 v2 key（**完整 sha256，无截断**，修复过 truncation P0）（`upstream-oauth.js:469–484`；`batch-15-auth-arch-fix.md` §9）。

#### 2.3.4 provider 事实（来自 `docs/eval/AUTH-PROVIDERS.md`，2026-11-23 抓取/实探）

| provider | 授权形态 | access | refresh | 网关路径 |
|---|---|---|---|---|
| Notion | OAuth DCR/CIMD，或 Business/Enterprise owner 创建 static MCP token；REST integration token 无效 | ~8h（代码里 `OAUTH_PROVIDER_FACTS` 写 3600s，**与文档 8h 不一致**，见 §6.3 unknown） | 每次轮换，一步 reuse 窗口，replay 整族 revoke；180 天上限 | DCR 已实现代码；真实授权未做 |
| Linear | 官方 MCP 支持 Bearer PAT（static），也支持 OAuth 2.1 DCR | auth-code 24h | 30 天轮换 + 30 分钟丢失响应重试窗 | 优先 static_bearer PAT |
| Vercel | OAuth-only，CIMD 免审核；DCR client 需审核 | 不请求 offline_access 时 ~1h（第三方 wire 证据） | 仅显式请求 offline_access 才发 | CIMD 代码就绪，真实授权 BLOCKED |

【判断】授权机制是本模块“最深”的部分：owner fence、环境隔离、单 refresher、DCR/CIMD、offline_access 都有代码 + 确定性测试。但**这仍是代码与 fake 验证的深度，不是真实授权的深度**（§3、§4.1）。

### 2.4 参数别名、canonical、写路径、限流/重试

| 能力 | 事实 | 落点 |
|---|---|---|
| 参数别名 | `normalizeToolArguments(args, 上游原始 inputSchema)`：camelCase→snake_case 仅重命名；已声明的原生 camelCase（Notion `pageId`）保留；显式 snake_case 优先；冲突不重命名；不递归/不改值；所有调用路径（Code Mode + 白名单 + gateway_call）统一走 `callTool` | `sanitize.js:252–340`；`upstreams.js:471–498` |
| canonical（GitHub） | `result-normalize.js` 纯函数、不抛错；file 结果 content 恒为纯正文（notice 只进元数据）；PR number **URL 优先**，`id`/`node_id` 只作独立字段、绝不兜底 number；raw 保留但打不可枚举 `untrusted-upstream-envelope` 标记；截断须有字段级原因 | `result-normalize.js:26–32, 151–201, 361–403, 419–512, 572–654` |
| canonical（GitHub helpers） | `github-helpers.js` 提供 `ensureBranch`/`upsertPr`（幂等）、`fetchAllPages`（去重 + 上游截断透传）、`repoGrep`（单文件读失败隔离 + 截断标记）、`canonicalResult`、`detectPushFiles`/`buildPushFilesArgs`；GitHub Actions REST helper（只读，注入 fetch，token 不输出） | `github-helpers.js` 全文 |
| 写路径 | `file-write.js` 纯编排：`applyTextPatch` 全有或全无；`applyFilePatches/writeFiles` 先全部 read→patch→precheck 再写；`commitFiles`（GitHub `push_files`）可用时默认原子一次提交；失败返回 `partial:true/written/remaining/compensation`，绝不假成功；dryRun 默认 true | `file-write.js:111–200, 246–326, 524–699` |
| 真实写回环 | 真实 GitHub 私有仓库：读→dryRun→真 commit→byte verify→失败用例→PR，写回环 PASS；CI 因账户 billing 未启动，`PARTIAL` | `docs/ACCEPTANCE-EVIDENCE-2026-11-24.md` §1 |
| 限流/重试 | **仅 Figma** 有配额 breaker + 只读缓存（whoami/get_metadata），内存态、每实例独立；`429/rate limit/plan limit` 词触发 cooldown（默认 24h），tripping 清缓存，cooldown 优先于缓存命中 | `UPSTREAMS.md` §Figma；`upstreams.js:482–509` |
| 错误脱敏 | capture 保留完整原文（产品决定）；模型可见错误走 `redactSecrets()` 后的 `modelMessage`（Bearer/ghp_/github_pat_/API key 形态） | `upstreams.js:23–25, 197–207`；`AGENTS.md` §6 |

【判断】canonical + 写路径属于模块 2/3 的共享成果，成熟度较高且有真实写回环证据；限流/重试则是**单点特例**（Figma），不是通用能力。

---

## 3. 成熟度 L0–L3 与“真实 tools/list vs fake/代码”盘点

### 3.1 成熟度分级（本模块内部 6 层，对齐 `ARCHITECTURE-PROGRESSIVE.md` L3-1..L3-6）

| 层 | 成熟度 | 依据 |
|---|---|---|
| L3-1 connect | **L2**（本地/代码完备，跨实例未验） | 并行连接、失败隔离、capture 齐全；真实 tools/list 3/5 可用（GitHub/Linear/Figma），2 个 token 过期 |
| L3-2 auth | **L2**（代码深，真实闭环未完成） | owner/lease/CAS/DCR/CIMD/static 全有确定性测试；真实 gateway-owned 授权、KV 落地、回滚演练未做；AUTH-READY **NOT READY** |
| L3-3 catalog | **L2** | allow/deny + BM25 + `select:`；快照入库 5 个上游；但无“官方任务集→允许工具”基线自动化 |
| L3-4 call/别名 | **L2** | 统一别名归一化；GitHub 有 Actions helper；搜索类上游无预算/去重/缓存 |
| L3-5 canonical | **L2**（GitHub 较深，其他浅） | GitHub file/PR/issue 归一化与 id/number 分离有真实回放证据；Notion/Linear/Vercel 无同类 canonical |
| L3-6 write | **L2**（GitHub 可真写，其余未知） | 原子/partial/补偿契约完整且真实回环 PASS；仅 GitHub 有真实写路径 |

### 3.2 真实 tools/list 证据（只读探测，2026-11-24 02:20 SGT）

来源：`docs/ACCEPTANCE-EVIDENCE-2026-11-24.md` §2、`docs/AUTH-OWNER-POLICY.md` §4；证据 JSON `docs/eval/acceptance-2026-11-24/tools-list-results.json`。方式为 local MCP SDK `initialize + tools/list`，token 来自本地 vault/CC Switch，**未经过网关 refresh 路径、未打印 token、未写 KV、未部署**。

| 上游 | 真实 tools/list | 工具数 | 备注 |
|---|---|---|---|
| GitHub | ✅ OK | 28 | `https://api.githubcopilot.com/mcp/readonly` |
| Linear | ✅ OK | 60 | 本地 token 仍有效 |
| Figma | ✅ OK | 51 | 90 天 token 未过期 |
| Notion | ❌ 401 invalid_token | 0 | 本地 access token 过期；refresh 属 DSH，禁止 |
| Vercel | ❌ 401 invalid_token | 0 | 需网关独立 OAuth |

判定：**3/5 真实 tools/list 通过**。这不是 5/5 全绿，也不是“全 fake”。

### 3.3 工具快照（离线目录）

`data/tool-snapshots/`：figma（50 tools，`capturedAt=2026-11-22 16:24:40`，source=live `tools/list`）、github（46）、linear（60）、notion（77）、vercel（273）——后四个 `capturedAt=unknown`，来自 legacy `data/tool-dataset.json#<server>`（原始来源标注为 live tools/list，但时间未知）。【判断】可作为目录/搜索评测基线，不能当作“当前线上工具面”证明。

### 3.4 fake / 代码级证据（不能升级为 pass）

| 证据类型 | 覆盖 | 为何不能算真实 |
|---|---|---|
| `tests/upstream-token-lifecycle.test.js`（23 项） | 并发 seed、lease、CAS、invalid_grant、环境隔离、static、shared grant | 全 fake KV + fake fetch；`batch-15-auth-sim.md` 明言“模拟结果只是待验证假设” |
| `tests/provider-dcr-cimd.test.js`（13 项） | Notion DCR 注册/复用/回调/刷新、Vercel CIMD scope/resource/文档形状 | 全 FakeStore + fake fetch；真实 DCR 注册/CIMD 部署未做（AUTH-READY §1.3/§2） |
| `tests/auth-e2e-harness.test.js`（9 项） | 真实 Node loopback + 真路由处理器，10 项 check 全绿 | 最外层仍注入 fake provider fetch + fake store，allowlist 外 URL 直接抛错；**隔离验证，不等于真实授权就绪** |
| `tests/upstream-oauth.test.js`（4 项）/ `upstream-auth*.test.js` | start/callback/seed/刷新基本契约 | MemoryStore + mock fetch |
| `docs/eval/REAL-GH-REPLAY.md` | 真实 GitHub 只读：PR number/id 分离、Actions 日志 415 修复 | 仅 GitHub REST 只读两处修复；不代表其它上游或其它工具真实回放过 |
| `docs/eval/AUTHORITATIVE-TASK-SOURCES.md` | 191 任务集定位为“官方为主 + 无任务处构造”的广度扫描 | 明确“不要宣称权威评测”；Linear/Vercel 62 条无权威 benchmark 任务 |

---

## 4. 缺口（按用户关注点逐条）

### 4.1 owner 显式化（机制已落地，落地态未完成）

- 【事实】代码层 owner 三标记 + 未标记=shared + 删除 legacy gateway 例外已实现（`AUTH-OWNER-POLICY.md` §2、`owner-marking.test.js` 14 项、PR #6 未合并/未部署）。
- 【缺口】生产 KV 的 owner 迁移**未执行**：`docs/ACCEPTANCE-EVIDENCE-2026-11-24.md` §3 实测 preview/production 共用 KV 凭据（`PUBLIC_BASE_URL`/`UPSTASH_REDIS_REST_*`/`REDIS_URL` 均 target production+preview），`ok=false`（P0 shared-record）。也就是“代码能拒绝共享 grant”，但“生产数据的归属”尚未打标。
- 【缺口】`config.example.json` 的 notion/linear/figma 仍是 `"grantOwner": "dsh"`（env-seeded 共享 grant），真实授权后需切到 manual/gateway 并改写配置。

### 4.2 DSH 不共享（不变量已定，外部边界未治理）

- 【事实】协议层依据充分（`AUTH-PROVIDERS.md` §3/§4：OAuth 2.1 §4.3.1、RFC 9700 §2.2.2/§4.14.2、SEP-2207）；网关侧 owner fence + shared-grant 只读在代码与 fake 测试中成立；`AUTH-OWNER-POLICY.md` §1 明确决策表。
- 【缺口】`AUTH-READY.md` §2 第 1 项：Linear PAT / Notion static MCP token 未由 owner 创建，Vercel 无 CIMD client_id；也就是 DSH grant 还没被网关自己的凭证替换。
- 【缺口】跨实例 lease 依赖真实 Upstash Lua（releaseLease/renewLease/casToken）——`batch-15-auth-arch-fix.md` §9 明确“真实 Upstash 的 Lua 脚本未在本批跑”。

### 4.3 授权 UX（授权第一，但当前明显 NOT READY）

- 【事实】`AUTH-READY.md` 明确 **NOT READY**，§2 六项阻塞；`config.example.json` 顶部 `_authProvisioning` 全是占位；`UPSTREAM_OAUTH_ADMIN_KEY` 在本次 shell 未设置。
- 【缺口】`docs/ACCEPTANCE-EVIDENCE-2026-11-24.md` §2：Notion/Vercel 真实 401；§4 入站 OAuth origin 修复（PR #7）**未合并未部署**，线上 401 仍指向旧 host。
- 【缺口】审批/弹窗 UX（FRAMEWORK §14）：当前 annotations `execute_read.openWorldHint=true`、`execute.destructiveHint=true` 仍可能触发客户端确认；建议的 Gemini profile 实验（方案 B）与“减少模型重试叠加确认”（方案 D）都未验证。
- 【缺口】`scripts/auth-provision.mjs` 的 Notion「DCR 未实现」/Vercel「无 CIMD」blocker 文案已过时（代码已实现，只是未真实授权），`AUTH-READY.md` §4 明确标注但脚本不在改动范围——**用户首次接入会看到错误指引**。

### 4.4 多上游并发 / 限流 / 错误（横切，当前单点）

- 【事实】连接并行（`Promise.all`）、单上游失败隔离、401 强制刷新一次并只重连一次已实现。
- 【缺口】限流/退避只有 Figma 特例，且是**每实例内存态**：serverless 每个 warm 实例各自 cooldown/cache，冷启动清零，可能重复花配额（`UPSTREAMS.md` §Figma Limitations）。无通用 429/5xx 指数退避、无上游级并发限制/队列/背压（FRAMEWORK §12 #3/#4、§13.6 均未落实）。
- 【缺口】`getAuthStatus()` 报 `REAUTH_REQUIRED` 只表示“网关不能自动恢复”，不等于 token 当下失效（`AUTH-OWNER-POLICY.md` §5）；缺少统一、模型可见的逐上游健康状态展示。
- 【缺口】`batch-15-auth-architecture.md` §1.1 设计的 `refreshFailure`/`journal`/`authorizedResources` 字段尚未在代码中全部体现（当前记录有 owner/source/grantId/environment/needsReauth 等，但无 journal、无 refreshFailure 分类持久化）——这是“设计稿 vs 实现”的差距。

### 4.5 配额浪费（Firecrawl/Exa 类搜索 API）与公共开源引导

- 【事实】FRAMEWORK §13.5 明确搜索 API 浪费可优化：去重/缓存/查询预算/结果裁剪/调用合并；当前仓库 `src/` 中**没有** firecrawl/exa/tavily 上游实现或搜索配额优化（grep 仅在 Cloudflare codemode/R2/模板等无关处命中）。`templates/upstreams/` 有 cloudflare.json 等 15 个模板，但没有 Firecrawl/Exa/Tavily/Gmail。
- 【缺口】用户点名的未来上游（Cloudflare/Gmail/Firecrawl/Exa/Tavily）尚无接入模板、SOP、评测集；Cloudflare 虽有 `templates/upstreams/cloudflare.json`，但无真实 tools/list 证据与 SOP。
- 【缺口】首次使用引导（`UPSTREAMS.md` 是开发者向的“加配置”文档，非“用户首次使用”的分步引导）；`docs/OPEN-SOURCE/*` 有客户端/部署模板，但上游接入引导未成体系。
- 【缺口】`docs/AUTHORITATIVE-TASK-SOURCES.md`：权威 benchmark 只覆盖 GitHub/Notion 部分工具，Linear/Vercel 62 条无权威任务——每上游“官方/权威任务集全覆盖”（FRAMEWORK §2 模块三、§5 上游 SOP 第 4 步）远未完成。

---

## 5. 渐进式延伸与每上游 SOP 模板

### 5.1 渐进式延伸（对齐 `ARCHITECTURE-PROGRESSIVE.md` 的 L0–L4 读法）

```text
L0 一眼看全：上游 = {连接, 授权, 目录, 调用, canonical, 写} 六件事；模型只见 3 工具
L1 模块边界：UpstreamAdapter = connect/listTools/call/canonicalize/authStatus（不碰客户端编码）
L2 模块内部：L3-1 connect → L3-2 auth → L3-3 catalog → L3-4 call → L3-5 canonical → L3-6 write
L3 跨模块契约：client OAuth ≠ upstream grant；owner 必须显式；错误脱敏；写要 dryRun/approve/原子
L4 代码落点：src/upstreams.js → upstream-auth.js/upstream-oauth.js/store.js → catalog.js
              → result-normalize.js/github-helpers.js/file-write.js
```

延伸原则（来自 FRAMEWORK §12/§13、ARCHITECTURE-PROGRESSIVE L1 硬规则）：

1. 新上游优先走**配置 + 模板**（UPSTREAMS.md 的“adding a server is configuration, not code”），只有 provider 特有授权/限流/canonical 才写新代码。
2. 不破坏 3 工具不变量、不改 schema 原地（Gemini 不吃 `tools/list_changed`）。
3. 授权体验第一：优先 static_bearer（Linear PAT / Notion static MCP token）或网关独立 DCR/CIMD；DSH grant 只读。
4. 每加一个上游必须补 SOP 八步（§5.3）与真实 tools/list 证据；fake 只算“代码就绪”。
5. 搜索类上游（Firecrawl/Exa/Tavily）接入前先定义缓存/去重/查询预算/结果裁剪策略，避免“浪费调用”。

### 5.2 未来上游延伸优先级（【判断】，依赖见 §6.2）

| 优先级 | 上游 | 理由 | 前置依赖 |
|---|---|---|---|
| P0 | 打通现有四上游真实授权 | 用户“授权第一”；Notion/Vercel 当前 401 | AUTH-READY 全绿；KV 隔离；CIMD 域名；owner 迁移 |
| P1 | Cloudflare | 已有 `templates/upstreams/cloudflare.json`（FRAMEWORK 点名候选） | 真实 tools/list + SOP + 授权方式确认 |
| P1 | Gmail | 高频 MCP，OAuth 生命周期与现有框架同类 | CIMD/SDK 可行性调研（TTL/scope） |
| P2 | Firecrawl / Exa / Tavily | 搜索类，**先做配额浪费策略**再接入 | 缓存/去重/预算/裁剪方案；未做不应接入（FRAMEWORK §13.5） |

### 5.3 每上游 SOP 模板（8 步，逐项映射到仓库落点）

> 与 `docs/FRAMEWORK.md` §5「上游 SOP」8 步逐条对齐；每个上游一份，缺项标 `NOT DONE`。

```markdown
# <server> 上游 SOP

## 1. 传输/端点（connect）
- 配置：name / transport / url|command / headers / tokenEnv（config.example.json 模板）
- 验证：npm run check:config -- <file>；npm start 日志显示 connected
- 证据：真实 initialize + tools/list（工具数、时间、endpoint）
- 本仓库落点：src/upstreams.js::_createTransport / connect

## 2. 授权方式与 owner（授权第一）
- 方式：static_bearer(PAT/静态 MCP token) | 网关 OAuth(DCR/CIMD) | long-lived token
- owner：gateway / dsh(只读,禁止 refresh) / manual；KV key gmcgw:v2:grant:<env>:<owner>:<server>
- 必查：offline_access（Vercel）、resource(RFC 8707)、scope 最小化、token 不打印
- 首次使用引导：owner 创建凭证 → auth-provision --verify --apply → 页面 Connected → 重连客户端
- 本仓库落点：src/upstream-auth.js / upstream-oauth.js / AUTH-READY.md

## 3. 工具清单 / allow-deny
- 真实 tools/list 快照入库 data/tool-snapshots/<server>.json（capturedAt + source）
- allowTools/denyTools 基线；只读工具 annotations 透传
- 本仓库落点：src/catalog.js::isAllowed / config.js allowTools|denyTools

## 4. 官方/权威任务集
- 优先官方 task suite；无则用 schema 驱动生成 + 反向验证（AUTHORITATIVE-TASK-SOURCES.md）
- 覆盖度与“权威性”如实标注；不要宣称权威评测

## 5. 离线评测
- search 召回 top1/top5；select:<name> schema 完整；execute_read 只读事实一致
- 与 baseline 同构建对照；fake/replay/SKIP 不算 pass

## 6. canonical / 写路径
- 该上游返回值形状 → canonical 字段集合（file/PR/issue 或自建）
- 写：dryRun → precheck → 原子|partial/compensation；读截断拒绝写
- 本仓库落点：result-normalize.js / github-helpers.js / file-write.js

## 7. 限流 / 并发 / 失败处理
- provider 并发限制、429/5xx 退避、配额缓存/去重/预算（搜索类必填）
- 错误脱敏：模型可见错误无 token；capture 保持 full-fidelity

## 8. 文档与开源引导
- docs/UPSTREAMS.md 配置示例 + templates/upstreams/<server>.json
- 首次使用引导文案（不含过时 blocker）；回归与本 SOP 更新
```

### 5.4 进度登记（当前各上游对模板的满足度，基于已读证据）

| 上游 | 1 传输 | 2 授权 | 3 目录/快照 | 4 权威任务 | 5 离线评测 | 6 canonical/写 | 7 限流 | 8 引导 |
|---|---|---|---|---|---|---|---|---|
| GitHub | ✅ 真实 | ✅ 长期 token | ✅ 46/28 快照 | ⚠️ 部分（有任务集，非全权威） | ✅ 有 | ✅ 真实写回环 | ⚠️ Actions 只读 helper，无通用限流 | ⚠️ 文档有，首次引导弱 |
| Linear | ✅ 真实 OK | ⚠️ PAT 未建/未落 KV | ✅ 60 快照 | ❌ 无权威任务 | ⚠️ 部分 | ❌ 无专门 canonical | ❌ | ❌ |
| Notion | ❌ 401 | ❌ 未授权/DCR 未真跑 | ✅ 77 快照（legacy） | ⚠️ 少量 | ⚠️ 部分 | ❌ | ❌ | ❌ |
| Vercel | ❌ 401 | ❌ CIMD 未部署 | ✅ 273 快照（legacy） | ❌ 无权威任务 | ⚠️ 部分 | ❌ | ❌ | ❌ |
| Figma | ✅ 真实 OK | ⚠️ 90 天 token，是否启用未定 | ✅ 50 live 快照 | ❌ | ⚠️ 部分 | ❌ | ✅ 唯一有 guard | ⚠️ |
| Cloudflare/Gmail/Firecrawl/Exa/Tavily | ❌ 仅 Cloudflare 模板 | ❌ | ❌ | ❌ | ❌ | ❌ | ❌（搜索类须先做） | ❌ |

---

## 6. 可复用底层方法、优先级/依赖/unknown

### 6.1 可复用底层方法（跨上游，不绑定具体 provider）

| 方法 | 文件/符号 | 复用价值 |
|---|---|---|
| owner fence + 环境隔离 + 单 refresher | `upstream-auth.js`: `_grantOwner/_mayRefresh/_key/resolveEnvironment/_acquireLock/_coalescedRefresh/_refreshWithLease` | 任何新增 OAuth 上游直接复用；不共享 grant 是硬底线 |
| 静态 token 路径 | `upstreams.js`: `_resolveToken` 的 `static_bearer` 分支 + `config.js` 校验 | PAT/静态 MCP token 类上游（Linear/未来 Gmail API key 类）零成本接入 |
| 网关自授权框架 | `upstream-oauth.js`: `createUpstreamOAuthHandlers` + `resolveClient`(DCR/CIMD/static) + `PROVIDER_ENDPOINTS` | 新 OAuth 上游只需加 provider facts + config，不重写 PKCE/state/callback |
| KV 原语 | `store.js`: `compareAndSet/releaseLease/renewLease/casToken/_oauthStateKey` | CAS/lease/state 隔离是存储层通用能力 |
| 配置 fail-fast | `config.js`: `validateConfig`（SERVER_KEYS、authMode/grantOwner/DCR/CIMD 校验） | 新上游接入的第一道闸 |
| 参数别名归一化 | `sanitize.js`: `normalizeToolArguments` | 所有上游 camelCase/snake_case 漂移统一处理 |
| canonical + 脱敏 raw | `result-normalize.js`: `normalizeFileResult/normalizePrResult/normalizeIssueResult/markUntrustedRaw`；`github-helpers.js`: `canonicalResult` | 新上游结果形状先折叠成稳定字段集合，raw 永不可信 |
| 原子/补偿写 | `file-write.js`: `applyTextPatch/applyFilePatches/writeFiles/partialFailure` | 任何“多文件写”上游可注入 read/write/commitFiles 复用 |
| 捕获与脱敏 | `upstreams.js`: `tapTransport/makeCaptureFetch/upstreamError.modelMessage` | capture full-fidelity + 模型可见脱敏的统一模式 |
| 幂等/分页 helper | `github-helpers.js`: `ensureBranch/upsertPr/fetchAllPages/repoGrep/waitForPrChecks` | GitHub 类上游的幂等/分页范式，其它上游可借鉴 |

### 6.2 优先级与依赖（【判断】）

```text
P0（解锁当前四上游）
  ├─ AUTH-READY 1.1–1.8 全绿（代码/部署/provider/环境/owner/真实验证/脚本/回滚）
  ├─ 生产 KV owner 迁移 + preview/production KV 隔离（当前 FAIL）
  ├─ CIMD 文档部署到稳定 HTTPS + clientId 配置（Vercel）
  └─ PR #6/#7 合并部署（owner 标记 + origin 一致性）
        ↓
P1（能力补齐）
  ├─ GitHub 之外的 canonical / 写路径 SOP
  ├─ 通用限流/退避/背压（替代 Figma 单点）
  └─ Cloudflare / Gmail 接入（先 tools/list + SOP）
        ↓
P2（成本与规模化）
  └─ Firecrawl/Exa/Tavily：先去重/缓存/查询预算/结果裁剪/调用合并，再接入（FRAMEWORK §13.5）
```

### 6.3 Unknown / 需 lead 确认（不臆测）

1. **Notion access TTL 口径不一致**：`upstream-auth.js:120` 写 `accessTtlSeconds: 3600`，而 `AUTH-PROVIDERS.md` 写“~8h，trust expires_in”。代码实际信任 `expires_in`，但文档常量不一致；需 lead 决定是否修正常量（本报告不改代码）。
2. **Figma 是否纳入六模块“当前上游”**：用户原话四上游不含 Figma，但 `config.example.json`/tools-list 证据里有 Figma；其是否启用、owner=gateway 授权路径未定（`AUTH-OWNER-POLICY.md` §1/§6）。
3. **真实 Upstash Lua 行为**：releaseLease/renewLease/casToken 仅在 fake store 验证；真实后端跨地域复制延迟未测。
4. **生产 KV owner 迁移的执行者/时间窗**：需有权限 operator，禁止用生产 token；本报告不触碰。
5. **“权威任务集全覆盖”的判定标准**：`AUTHORITATIVE-TASK-SOURCES.md` 明确“不要宣称权威评测”；Linear/Vercel 无权威 benchmark，需 lead 定义替代验收口径。
6. **搜索类上游配额策略的归属**：是放模块 3（上游）还是模块 2（执行底座的预算）需架构决策；FRAMEWORK §13.5 只说“可优化”，未定模块边界。
7. **生产 env 名称**：本次 shell 中 §0 列出的所有相关 env（`GMCGW_ENVIRONMENT`、`VERCEL_ENV`、`UPSTREAM_OAUTH_ADMIN_KEY`、各 provider token 名等）均为 unset；未读取任何值，无法判断 Vercel 项目侧的绑定情况（`.AGENTS.md` §0 / `ACCEPTANCE-EVIDENCE` §3 显示生产 KV 凭据跨环境 target）。

### 6.4 一句话结论

> 上游接入模块在**代码深度**上已建成“owner fence + 单 refresher + DCR/CIMD + canonical + 原子写”的完整骨架，并具备 GitHub 真实写回环与 3/5 真实 tools/list 证据；但它仍处在 **L2（代码/离线就绪，线上未验收）**：真实授权未做、生产 KV 隔离 FAIL、每上游 SOP 未成体系、搜索类配额与多上游通用限流缺失。按用户“授权第一”的口径，下一步不是加新上游，而是先把 `AUTH-READY.md` 全绿、把 owner 迁移与 CIMD 授权做实。

---

> 变更控制：仅新增 `docs/architecture-audit/03-upstream.md`。未改 `src/`、`scripts/`、`tests/`、README、其他 docs、workflows；未 commit / push / deploy；未读取或写入任何 token 值。
