# 架构审计 01 — 客户端模块（Client Adaptation）

> 范围：按用户六模块架构，对「客户端模块」做全项目深读审计。
> 方法：只读代码/文档，只写本文件；不改 `src/`、`scripts/`、`tests/`、README、其它 docs、workflows；不 commit / push / deploy。
> 审计时间：2026-11-24（Asia/Singapore）。当前 checkout HEAD = `f542e93`（git 实测，工作区干净）。
> 生产部署状态：最新登记生产为 `d1f36ba`（2026-11-24 02:57 手动；`docs/DEPLOYMENTS.md:18`；healthz `commit=d1f36ba…` / `buildHash=a1002d86…`）。`AGENTS.md:0` 明确「部署成功不等于验收通过」。本审计所有「已实现/测试绿」均为 checkout 本地证据，**不代表生产生效、不代表真实客户端验收**。
> 证据纪律：引用仅限已读文件；无来源写 `unknown`；测试绿 ≠ L1 可用；不引用未读文件。

---

## 1. 用户原话校验（FRAMEWORK.md §0、§13、§14）

### 1.1 客户端模块目标（原文，逐字摘录）

- `docs/FRAMEWORK.md:16`：「第二个就是客户端，Gemini ChatGPT Claude 等等这种网页端或者客户端的非code模式，可能还会有grok muse manus……等等一系列没处理mcp问题的同类型平台。哦对了还有客户端接入，目前积累了Gemini ChatGPT的接入方法 我们也会继续做更多的……这个客户端接入跟免不免费无关，可能有的平台根据免费和会员有不同的自定义mcp权限。对了，提到这里，我们同时会对客户端做适配和优化，按照我们自己在客户端做一些权威任务集的主动和被动线上评测……」
- `docs/FRAMEWORK.md:16`（多客户端交叉）：「为什么是上层，我构造一个场景，用户首选选择运行部署，接下来就是客户端了吧，可能用户也会使用多个客户端，这就是一个网关和多个客户端的场景，怎么做隔离？哪些东西又是底层复用？」
- `docs/FRAMEWORK.md:16`（SOP）：「对每个上游的优化，我们都有固定的sop。同理每个客户端也是。」
- 定稿纠正 `docs/FRAMEWORK.md:366-374`：目标就是**网页端非代码模式**；按「客户端 × MCP 设计 × 非代码模式」逐平台做；每个平台走「接入 → 测试 → 优化 → 评测 → 回归」；Code 模式客户端（Claude Code/Codex 等）不是当前主战场，只作后续兼容对象。
- 审批/权限 `docs/FRAMEWORK.md:436-499`：Gemini 已设「允许」仍弹窗；判断是网关问题还是客户端设计问题；原则「审批是客户端 UX，不是网关功能；网关只保留代码级安全闸」；建议先做实验 profile（B 方案），不改默认。

### 1.2 范围 / 非目标

| 维度 | 用户口径（原文/定稿） | 整理落在哪 |
|---|---|---|
| 目标平台 | Gemini / ChatGPT / Claude 网页端非代码模式；后续同类平台 | FRAMEWORK §2 模块二、§13.1 |
| 同类平台 | Grok / Muse / Manus（以是否存在同类问题为主） | FRAMEWORK §2、§9 未决 #2 |
| 内容 | 接入方法、适配优化、客户端主动/被动线上评测、开源接入部分、首次引导 | FRAMEWORK §2 模块二 |
| 计划/权限 | 免费/会员自定义 MCP 权限差异，「与是否免费无关」 | FRAMEWORK §2 模块二、§3.2 |
| 交叉 | 一网关多客户端隔离、底层复用、并发、capture 标签 | FRAMEWORK §3.1、§13.6 |
| 非目标（定稿） | 不按品牌抽象一堆「能力矩阵」；不做通用客户端能力检测框架（逐个实测优先）；Code 模式不是主战场 | FRAMEWORK §11、§13.7 |
| 非目标（整理） | 不引入 canary/shadow/复杂发布工程；不把安全/成本/真值做独立模块 | FRAMEWORK §13.7 |

### 1.3 理解正确 / 偏差

**正确的部分（代码/文档与原话一致）：**

1. **逐平台、非代码 Web 模式为主**：`docs/ARCHITECTURE-PROGRESSIVE.md:86-124` 把 Client Adaptation 作为模块 1，内部 L1-1 detect → L1-5 encode 分层；`docs/CLIENTS.md:7-14` 按平台列 Gemini / Claude / ChatGPT / Cursor 等状态。与定稿「按平台做、Code 模式兼容」方向一致。
2. **逐平台 profile + 编码隔离**：`src/client-profile.js:28-32` 三个冻结 profile（Gemini/Claude text-only，ChatGPT dual encoding）；`src/client-platform.js:33-48` 平台标签仅用于观测/编码，明确「不用于写路径/权限/工具面/上游授权」（`src/client-platform.js:9-12`）。符合「逐平台适配」「一网关多客户端底层复用」。
3. **不猜客户端**：`src/client-profile.js:16-20,100-126`、`src/client-platform.js:13-22,153-194` 只接受显式 header / `clientInfo.name` / UA token / env opt-in / 显式 OAuth client-id map，unknown → gemini 默认；与 FRAMEWORK §13.7「不做通用能力检测框架」一致。
4. **按模式分 lane 的意图正确**：`docs/eval/PLATFORM-CONFORMANCE-MATRIX.md:31-38` 证据分级、无真实客户端即 `unknown`；§9 明确 ChatGPT/Claude 端到端 `unknown`。符合定稿「主动/被动隔离、逐平台分账」。
5. **审批 UX 的网关侧原则正确**：`AGENTS.md:4` + `src/sanitize.js:230-237` 显式 annotations；`docs/FRAMEWORK.md:445-451` 代码事实与用户反馈一致；FRAMEWORK §14 已把「annotations 不是安全边界、网关不叠加用户审批」写清。

**偏差 / 与原文张力（需 lead 关注）：**

1. **「平台 × 模式 × MCP 能力」的 mode detection 未落地**：FRAMEWORK §11 直接含义第 1 条「客户端适配层需要 mode detection，不能只 detect 品牌」。但 `src/client-platform.js:33-37` 平台只有 `gemini|chatgpt|claude|unknown`，`src/client-profile.js:23-25` 同；`docs/ARCHITECTURE-PROGRESSIVE.md:95` 也只写 `detect Gemini/ChatGPT/Claude/unknown`。**当前没有模式维度（网页/桌面/IDE/CLI/Code）的字段或分账**。偏差性质：架构意图与实现差距，非用户原话冲突。
2. **「Grok / Muse / Manus 同类平台」仅停留在调研，未进入适配/评测 lane**：`docs/OPEN-SOURCE/WEB-CLIENTS.md:36` 有 Grok 调研（DCR+authorize 疑似 broken），但 `src/client-profile.js`、`src/oauth.js` allowlist、conformance matrix 均无 Grok/Muse/Manus 项。FRAMEWORK §9 未决 #2 仍列未决。符合「以是否存在同类问题为主」的谨慎，但未形成 SOP 条目。
3. **「主动/被动线上评测」在客户端模块的实现偏弱**：本模块内 `tests/platform-conformance-suite.test.js`、`tests/claude-connector.test.js`、`tests/chatgpt-oauth.test.js` 全是离线/服务端证据；`docs/eval/PLATFORM-CONFORMANCE-MATRIX.md:294` 退出标准明确真实客户端端到端未做。FRAMEWORK §4/§13.2 要求的「客户端主动/被动 lane、主动反哺被动」在 `docs/eval/ONLINE-SEMIONLINE-JOIN-2026-11-23.md:1-5` 只覆盖 **Gemini 单一平台**（文档标题即「2026-11-23 · Gemini」）。ChatGPT/Claude 无在线反馈样本。
4. **审批 UX 的原话诉求（「Gemini 已设允许仍弹窗」）尚未在真实窗口验证**：FRAMEWORK §14「待验证」四条全部未完成；`docs/FRAMEWORK.md:485` 建议的「B 实验 profile + D 抑制重试」未在 `src/client-profile.js` / `src/codemode.js` 找到对应实验 profile 或开关（当前 `applyProfileToTools` 明确保持 annotations 跨平台一致，`src/client-profile.js:219-241`）。偏差属于「已记录但未实施」，符合「先验证再改」的纪律，不是误做。
5. **文档状态漂移（重要）**：`docs/eval/PLATFORM-CONFORMANCE-MATRIX.md:2.3`（§1 第 4 条、§4.1 A2、§5、§6.4 L0）多处写「Claude callback NOT allowed / `fail` / 需先改代码」。但当前 `src/oauth.js:45-49,72-75` 已加入 Claude 回调，`src/oauth.js:377-379` 有 `ALLOW_DCR_FOR_CLAUDE`，`tests/claude-connector.test.js` 9/9 pass，`docs/ledger/batch-15-claude-connector.md:28-52` 记录落地。即**矩阵文档未随 B15 实现回填**（矩阵 §8/§9 明确「只更新 §9 测试落地状态，§1–§8 行未重打分」）。审计以代码为准：Claude callback = 服务端 `pass` / 真实客户端 `unknown`，不是 `fail`。同理矩阵 §1.2/§2.1 对 Gemini「已实测」的表述与 `docs/CLIENTS.md:9` 一致，可保留。

---

## 2. 当前实现清单（平台 / 模式 / OAuth / profile / 编码 / 工具面 / 接入 / 标志位 / 部署）

### 2.1 平台与 profile

| 平台 | 平台常量 | profile id | 编码 | 检测来源（显式） | 证据 |
|---|---|---|---|---|---|
| Gemini | `PLATFORM_GEMINI` | `gemini-text-json` | text JSON，**无** structuredContent | header `x-gateway-client-profile: gemini` / `clientInfo.name` / env `GATEWAY_CLIENT_PROFILE`；UA 无显式 gemini token | `src/client-platform.js:34-48,85-103,171-193`；`src/client-profile.js:28-32,67-88` |
| ChatGPT | `PLATFORM_CHATGPT` | `chatgpt-structured` | structuredContent **+** 同文 text JSON | header / `clientInfo.name` / UA token (`chatgpt|openai`) / env / 显式 OAuth client-id map | `src/client-platform.js:35,46,105-123,131-151`；`src/client-profile.js:84-87,162-168` |
| Claude | `PLATFORM_CLAUDE` | `claude-text` | text JSON + annotations，**无** structuredContent | header / `clientInfo.name` / UA token (`claude|anthropic`) / env | `src/client-platform.js:36,47`；`src/client-profile.js:30,85-86` |
| unknown | `PLATFORM_UNKNOWN` | 回退 `gemini-text-json` | 与 Gemini 逐字相同 | 无显式信号 | `src/client-platform.js:37,192-193,213-221`；`src/client-profile.js:124-125` |

- 两个冻结映射：`CLIENT_PROFILES`（`src/client-profile.js:28-32`）、`CLIENT_PLATFORM_PROFILES`（`src/client-platform.js:44-48`）；`tests/platform-conformance-suite.test.js:477-487` D6 验证冻结不可变。
- profile 优先级（header → clientInfo → UA → env → 默认 gemini）：`src/client-profile.js:100-126`；平台检测优先级（header → clientInfo → OAuth map → UA → unknown）：`src/client-platform.js:153-194`。
- **mode detection：无**（见 §1.3 偏差 1）。

### 2.2 OAuth / 接入（服务端已实现部分）

| 能力 | 状态 | 证据 | 标志位/部署 |
|---|---|---|---|
| OAuth 2.1 + PKCE S256 + DCR | 已实现 | `src/oauth.js:28-30,404-433,435-510,681-771` | 生产 LOCKED（`ALLOWED_CLIENT_ID`），默认关闭 DCR |
| Google relay 回调 allowlist | 已实现 | `src/oauth.js:32-36,63-65`；`tests/chatgpt-oauth.test.js:533-563` 6 redirect + 1422 字符 state 逐字节 | Gemini 主基线，`docs/CLIENTS.md:9` 标 Tested |
| ChatGPT 两个回调 allowlist + RFC 9207 `iss` + `offline_access` + `resource` echo | 已实现（服务端） | `src/oauth.js:41-43,66-71,404-419,747-770`；`tests/chatgpt-oauth.test.js:169-349` | DCR carve-out `ALLOW_DCR_FOR_CHATGPT=1` 默认关闭（`src/oauth.js:369-374`）；CIMD 未实现（`docs/CLIENTS-CHATGPT.md:87-91`） |
| Claude 单一回调 allowlist + DCR carve-out | **已实现（服务端）** | `src/oauth.js:45-49,72-75,307-315,377-379,560-561,587-598,716-722`；`tests/claude-connector.test.js:170-434` 9 项 pass；`docs/ledger/batch-15-claude-connector.md:28-52` | `ALLOW_DCR_FOR_CLAUDE=1` 默认关闭；生产是否开启 = unknown |
| 平台隔离（client/code/redirect 不串台） | 已实现 | `src/oauth.js:461-474,559-598,703-722,783-789`；`tests/chatgpt-oauth.test.js:419-527`；`tests/claude-connector.test.js:243-434` | — |
| 非轮换 refresh token | 已实现 | `src/oauth.js:663-679,773-813`；`tests/claude-connector.test.js:380-387` | 与 `AGENTS.md:2` 授权生命周期一致 |
| 入站 origin 一致性（issuer/resource/401/CIMD 跟随请求 host） | 已实现，生产已部署 `d1f36ba` | `src/oauth.js:106-145`；`src/vercel-app.js:277,305-343,372-390`；`docs/DEPLOYMENTS.md:18` | 部署≠验收（`AGENTS.md:0`） |
| 401 `_meta["mcp/www_authenticate"]` | 已实现 | `src/vercel-app.js:196-215`；`tests/chatgpt-oauth.test.js:355-381` | ChatGPT linking UI 展示 = unknown |

### 2.3 工具面与编码

- **三工具不变量**：`search` / `execute_read` / `execute`，同名同序，profile 不改：`src/codemode.js:1859-1930`；`tests/platform-conformance-suite.test.js:250-282` B1/B2。annotations：`search {true,false,false}`、`execute_read {true,false,true}`、`execute {false,true,true}`（`src/codemode.js:1867,1894-1896`；`tests/platform-conformance-suite.test.js:284-309` B3）。与 FRAMEWORK §14 代码事实表一致。
- **schema sanitizer**（Gemini 约束）：`src/sanitize.js:210-249`——array 补 `items`、多 type 折叠、oneOf/anyOf 截 8、enum 过滤、`__proto__` 等不安全键拦截（`src/sanitize.js:52,234`）；`tests/platform-conformance-suite.test.js:145-162,311-327`。
- **结果编码**：`encodeToolResult` / `encodeModelOutput` / `applyProfileToTools`（`src/client-profile.js:145-241`）；chatgpt 由纯文本 JSON 派生 structuredContent（`:201-217`）；codemode 边界 `toModelOutput` 带 profile（`src/codemode.js:1851,1925`）；`tests/platform-conformance-suite.test.js:113-244` A1–A6、`:388-475` D1–D5。
- **`_meta.securitySchemes`**（ChatGPT，additive、不污染 Gemini）：`tests/chatgpt-oauth.test.js:383-413`、`tests/platform-conformance-suite.test.js:193-210`。注意：`tests/chatgpt-oauth.test.js:399` 中 `createGatewayServer` 暴露的是 `gateway_call` / `gateway_search` 两个工具，与 3 工具主面不是同一工厂；`createCodeModeTools` 才是 3 工具面（`tests/platform-conformance-suite.test.js:64-67,250-259`）。审计时不要把两者混为一谈。
- **typed-plan / v2**：`ENABLE_MCP_V2=1` 才启用 `/mcp/v2`，默认关闭，`AGENTS.md:4`；本地 smoke 9/9（`docs/eval/MCP-V2-SMOKE.md:53-61,97-98`，只读未运行）；v1 无 `plan` 字段、v2 同名同序三工具且 `execute` 同时有 `plan`/`code`（同上 :54）。当前 profile 层与 conformance suite 把 `plan` 标记为「未支持，等 v2」（`tests/platform-conformance-suite.test.js:333-382` C1–C3；`docs/eval/PLATFORM-CONFORMANCE-MATRIX.md:3` §9 `plan 字段 未支持`）。**真实客户端是否接受 v2 schema = unknown**（`docs/eval/MCP-V2-SMOKE.md:83`）。

### 2.4 接入方式 / 文档 / flags 汇总

| 项 | 状态 | 证据 |
|---|---|---|
| Gemini web custom apps | Tested（唯一真实测试基线） | `docs/CLIENTS.md:9`；账号门槛 US/18+/个人号/英文 UI，`docs/OPEN-SOURCE/WEB-CLIENTS.md:31` |
| ChatGPT connectors | 服务端实现 + 本地测试；真实账号端到端未测 | `docs/CLIENTS.md:12` Untested；`docs/CLIENTS-CHATGPT.md:3,80-110` |
| Claude web connector | 服务端 callback + DCR 已实现；真实 connector 未验证 | `docs/CLIENTS.md:11`；`docs/ledger/batch-15-claude-connector.md:64-69` |
| MCP Inspector / IDE agents / DSH 等 | Untested（`docs/CLIENTS.md:10,13-14`） | `docs/CLIENTS.md` |
| 注册配置样例（design only） | `templates/client-profiles/*.json` + `docs/OPEN-SOURCE/CLIENT-PROFILES.md:3-12` 明示 runtime 不读这些文件 | 真实行为来自硬编码 `src/client-profile.js` / `src/oauth.js` |
| 开关清单 | `ALLOWED_CLIENT_ID/SECRET`（LOCKED）、`ALLOW_DCR_FOR_CHATGPT`、`ALLOW_DCR_FOR_CLAUDE`、`GATEWAY_CLIENT_PROFILE`/`GATEWAY_CLIENT_CLAUDE`/`GATEWAY_CLIENT_CHATGPT`、`CLIENT_PLATFORM_OAUTH_MAP`、`ENABLE_MCP_V2`、`PUBLIC_BASE_URL` | `src/oauth.js:366-379`；`src/client-profile.js:39-41`；`src/client-platform.js:57`；`src/vercel-app.js:315-316` |
| 生产部署 | `d1f36ba`（手动，2026-11-24 02:57），B–G 门未完成；push 自动 production 关闭，preview 仍生成 | `AGENTS.md:0,8`；`docs/DEPLOYMENTS.md:3-6,18,28-35` |

---

## 3. 成熟度分级（L0 代码 / L1 可用 / L2 可维护 / L3 生产）

> 分级口径：L0=有代码且有确定性测试；L1=真实环境 L1 smoke 可用（不是测试绿）；L2=可维护（SOP/文档同步、回归覆盖、隔离清晰）；L3=生产（真实客户端、部署后在线复验、生命周期闭环）。**测试绿只支撑 L0，不自动给 L1。**

| 能力项 | L0 代码 | L1 可用 | L2 可维护 | L3 生产 | 定级理由 / 证据 |
|---|---|---|---|---|---|
| Gemini 平台检测 + text-JSON 编码 | ✅ | ✅ | ✅ | ❌ | 代码+测试 `tests/platform-conformance-suite.test.js:113-143`；唯一真实测试客户端 `docs/CLIENTS.md:9`；但生产 `d1f36ba` 后无部署后在线复验（`AGENTS.md:0`） |
| ChatGPT dual encoding（服务端） | ✅ | — | ✅ | ❌ | `src/client-profile.js:162-168`；`tests/...:164-190`；真实消费 unknown |
| Claude text+annotations（服务端） | ✅ | — | ✅ | ❌ | `src/client-profile.js:30,155-160`；`tests/...:212-227`；真实 connector 未测 |
| ChatGPT OAuth（allowlist/iss/resource/401/DCR carve-out） | ✅ | — | ⚠️ | ❌ | `tests/chatgpt-oauth.test.js` 全链路本地；CIMD 未实现、meta-refresh vs 302 未验证，`docs/CLIENTS-CHATGPT.md:80-110` |
| Claude OAuth（callback + DCR carve-out） | ✅ | — | ⚠️ | ❌ | `tests/claude-connector.test.js` 9/9；但 conformance matrix 文档未回填（§1.3 偏差 5）；真实 connector 未验证 |
| 平台隔离（client/code/profile/capture 不串台） | ✅ | — | ✅ | ❌ | `src/oauth.js:461-474,703-722`；`tests/...:388-475` D1–D6 |
| 三工具面 + sanitizer | ✅ | ✅（Gemini） | ✅ | ❌ | `src/codemode.js:1859-1930`；`src/sanitize.js`；真实 Gemini 工具列表观测 G2 尚未作为证据归档（`docs/eval/PLATFORM-CONFORMANCE-MATRIX.md:254-261`） |
| mode detection（网页/桌面/IDE/CLI/Code） | ❌ | ❌ | ❌ | ❌ | 无字段/无分账（§1.3 偏差 1） |
| Grok/Muse/Manus 接入与 SOP | ❌（仅调研） | ❌ | ❌ | ❌ | `docs/OPEN-SOURCE/WEB-CLIENTS.md:36` Grok 调研；无代码适配 |
| 免费/会员权限差异 | ❌（文档记录，无服务端 gate） | ❌ | ⚠️ | ❌ | `docs/CLIENTS-CHATGPT.md:98-101` 明确 Pro/Plus 只读是客户端侧，服务端不 gate；`docs/OPEN-SOURCE/WEB-CLIENTS.md:32` plan gating |
| 审批 UX（实验 profile / 抑制重试） | ❌ | ❌ | ⚠️ | ❌ | FRAMEWORK §14 建议 B+D 未落地；`applyProfileToTools` 跨平台 annotations 一致（`src/client-profile.js:229-240`） |
| 客户端主动/被动线上评测 lane | ⚠️ | ❌ | ❌ | ❌ | 仅 Gemini 在线 join（`docs/eval/ONLINE-SEMIONLINE-JOIN-2026-11-23.md:1`）；ChatGPT/Claude 无样本 |
| typed-plan / v2 在真实客户端 | ✅（本地） | ❌ | ⚠️ | ❌ | `docs/eval/MCP-V2-SMOKE.md:97-98,83`；`ENABLE_MCP_V2` 默认关；真实客户端 schema 接受度 unknown |
| 首次引导 / onboarding | ⚠️（文档 checklist） | ❌ | ❌ | ❌ | `docs/CLIENTS-CHATGPT.md:23-47`（要用户配 `ALLOW_DCR_FOR_CHATGPT`）、`docs/OPEN-SOURCE/CLIENT-PROFILES.md:97-118`（acceptance 未来清单）；无产品化引导流程 |

**总评**：客户端模块整体处于 **L0（代码+离线测试扎实）+ 局部 L1（仅 Gemini 有真实测试历史）**。不存在任何客户端能力达到 L3；主要卡在真实客户端端到端、mode 维度、审批 UX、plan 权限建模四项。

---

## 4. 缺口（按用户关注点逐项）

1. **Web 非代码模式 vs Code 模式**：这是定稿的核心目标（`docs/FRAMEWORK.md:366-374`），但平台层无 mode 维度（§1.3 偏差 1）。`docs/ARCHITECTURE-PROGRESSIVE.md:95` 只 detect 品牌；同一品牌不同模式无分 lane。风险：Claude 网页与 Claude Code、ChatGPT 网页与 Codex 的能力/ schema 容忍度不同，混算会污染评测与 profile 选择。FRAMEWORK §11「按平台 × 模式分 lane」尚未成为数据结构。
2. **Gemini / ChatGPT / Claude 三平台**：
   - Gemini：唯一真实测试基线，但账号门槛（US/18+/个人/英文）限制复现；审批弹窗问题未验证（`docs/FRAMEWORK.md:487-492`）。
   - ChatGPT：服务端齐备但真实账号零测试；CIMD 缺失、meta-refresh vs 302 未知、schema-token 未验证上限（`docs/CLIENTS-CHATGPT.md:80-110`）。
   - Claude：callback/DCR 代码已落地（与矩阵文档冲突，§1.3 偏差 5），但真实 connector 未测；auth 设置保存后不可改、IPv4-only egress 等前置（`docs/OPEN-SOURCE/WEB-CLIENTS.md:33`）。
3. **Grok / Muse / Manus 类**：`docs/OPEN-SOURCE/WEB-CLIENTS.md:36` 有 Grok 调研且 DCR+authorize 疑似 broken；Muse/Manus 无任何文档记录（**unknown**）。FRAMEWORK §9 未决 #2 原样保留；未形成「同类问题 → 是否适配」判定 SOP。
4. **免费/会员 MCP 权限**：`docs/CLIENTS-CHATGPT.md:13-17` 与 `docs/OPEN-SOURCE/WEB-CLIENTS.md:32` 已记录 plan gating（Business/Enterprise/Edu 全量，Pro 只读，Free 未列）；服务端不 gate（`docs/CLIENTS-CHATGPT.md:98-101`），annotations 不是安全边界（`docs/SANDBOX-SECURITY.md:37`，经 `docs/eval/PLATFORM-CONFORMANCE-MATRIX.md:229-231` 引用）。「与是否免费无关」的用户口径已理解，但缺少面向体验的权限建模与引导。
5. **审批 UX**：FRAMEWORK §14 判断「双重触发、非纯 Gemini 问题」；当前三工具 annotations 诚实声明 destructive/openWorld（`src/codemode.js:1867,1894-1896`），B 实验 profile 与 D 抑制重试均未实施；网关内部 approve 是否引发模型重试叠弹窗 = unknown（需真实窗口计数）。
6. **origin / 隔离**：入站 origin 一致性已在 `d1f36ba` 部署（`src/oauth.js:106-145`、§2.2）；**preview/production KV 隔离**有检查脚本但未做真实客户端验证（`AGENTS.md:0` 把「隔离检查脚本」列为已部署内容，但「真实客户端、写回环、授权生命周期」列为未完成）。客户端 profile 的 capture 标签：设计文档要求每个 `/mcp` envelope 带 platform/profile 标签（`docs/OPEN-SOURCE/CLIENT-PROFILES.md:61-63`），但 `tests/platform-conformance-suite.test.js:94-101` 的 envelope 是离线构造的 `clientPlatform` 字段；真实 `/mcp` capture 是否写入平台标签需核对 capture 实现（本次未读 `src/capture.js` → **unknown**）。
7. **onboarding**：`docs/CLIENTS-CHATGPT.md:23-47` 是运维 checklist（要用户理解 `ALLOW_DCR_FOR_CHATGPT`、复制精确 redirect）；FRAMEWORK §2/§4 要求「首次使用引导流程」，当前只有文档，没有产品化向导；`docs/OPEN-SOURCE/CLIENT-PROFILES.md:3-12` 的 registry 是 design-only、runtime 不读——易被误当作已生效配置。

**跨缺口结论**：`docs/eval/ONLINE-SEMIONLINE-JOIN-2026-11-23.md` 的 F1–F6 全为 `requestIds:["unknown"]`、`captureVerified:false`，且全部来自生产旧构建；本模块没有 ChatGPT/Claude 的在线反馈样本，因此「客户端适配优化由主动/被动线上评测驱动」（FRAMEWORK §2 模块二）目前只对 Gemini 有雏形。

---

## 5. 渐进式延伸（下一层应加什么，具体到接口/能力/测试）

> 对齐 `docs/ARCHITECTURE-PROGRESSIVE.md` 的 L1-1 → L1-5 层次。不加空泛 checklist，只写可落地的下一层增量。

1. **L1-1 加 mode 维度（先于任何新平台）**
   - 接口：`detectClientPlatform(input)` 返回值增加 `mode: 'web'|'desktop'|'ide'|'cli'|'code'|'unknown'` 与 `mcpCapability: 'unknown'|'read'|'readwrite'|'search'|'code'`（枚举值对齐 FRAMEWORK §11 能力矩阵），来源仍是显式声明（header `x-gateway-client-mode` / `clientInfo.name` 映射表），unknown 不猜。
   - capture：`clientPlatform` 旁并列 `clientMode`、`mcpCapability` 字段；eval lane 按 `(platform, mode)` 分账，禁止跨 lane 合并。
   - 测试：`tests/platform-conformance-suite.test.js` D2 扩展——显式 mode 声明必须选中，vague UA 仍落 unknown；新增「同一 profile 不同 mode 的编码/annotations 不串台」断言。
   - 依赖：先确认 capture envelope 是否已有可扩展的标签槽位（见 §4.6 unknown）。
2. **L1-2 审批 UX 实验 profile（FRAMEWORK §14 B+D）**
   - 能力：在 `CLIENT_PROFILES` 增加**非默认**实验项（如 `gemini-text-json-annotations-experiment`），仅对 gemini-web mode 降低 `execute_read.openWorldHint` 与 `execute.destructiveHint/openWorldHint`；默认 profile 与 ChatGPT/Claude 不变；`applyProfileToTools` 允许 profile 覆盖 annotations（当前它刻意不覆盖，`src/client-profile.js:229-240`），但必须有「安全边界不依赖 annotations」的测试护栏（`tests/platform-conformance-suite.test.js:284-309` B3 已声明 annotations 非安全闸，需扩展为负向断言）。
   - D 方案：codemode 写路径识别「客户端已发起的 execute」为 host approval，避免网关拒绝→模型重试→多次确认；要在 capture 里记 `approvalSource` 与 `retryCount`。
   - 测试：真实 Gemini 窗口记录一次写操作平均确认次数（FRAMEWORK §14 待验证第 4 条），这是 L1 证据，离线测试不能替代。
3. **L1-3 ChatGPT CIMD 决策点**
   - 能力：目前 `client_id_metadata_document_supported` 故意不广告（`docs/CLIENTS-CHATGPT.md:87-91`）。下一层先做**决策测试**：用真实 ChatGPT Business 账号看连接是否坚持 CIMD；若坚持，再实现 fetch + 严格 host/path 校验（复用 `isAllowedRedirectUri` 的单一校验器模式），否则保留 DCR 路径。不要在无真实账号前实现 CIMD。
   - 测试：真实账号连接记录 DCR vs CIMD 选择 + 实际 redirect_uri；不 widen allowlist（`docs/CLIENTS-CHATGPT.md:121-125`）。
4. **L1-4 Claude 真实 connector 冒烟（把 matrix 从 unknown 升级）**
   - 前置：`ALLOW_DCR_FOR_CLAUDE=1` 是否在目标部署开启（unknown）；网络需满足 HTTPS 443 / IPv4 egress（`docs/OPEN-SOURCE/WEB-CLIENTS.md:33`）。
   - 证据：真实 `tools/list`（3 工具 / annotations）、一次 `execute_read`、一次写确认、`WWW-Authenticate` 401 链接 UI；回填 `docs/eval/PLATFORM-CONFORMANCE-MATRIX.md` 被 B15 代码变更影响的 §2.3/§4.1 A2/§6.4 L0 行（本次审计不写那些文件，只提出）。
5. **L1-5 同类平台 SOP 槽位**
   - 接口：为 Grok/Muse/Manus 预留 profile id 与回调 allowlist 的**扩展点**，但默认不启用；先按 `docs/OPEN-SOURCE/WEB-CLIENTS.md:36` 的 Grok 报告复测一次（DCR+authorize 是否仍 broken），再决定是否进入 SOP。
   - 测试：复测结果无论 pass/fail 都写进 conformance matrix（unknown 不是 pass）；Grok 若 authless 可行，测试静态 bearer 模式是否与网关兼容。
6. **L1-6 typed-plan / v2 真实客户端验收**
   - 在 §5.1 mode 维度落地后，跑 `docs/eval/PLATFORM-CONFORMANCE-MATRIX.md:253-285` G4/C9/L5 三行（真实 `tools/list` 接受 `plan`、写确认 UX、code fallback）；`ENABLE_MCP_V2` 保持默认关，直到有真实 A/B（`AGENTS.md:9`）。

---

## 6. 可复用底层方法与客户端 SOP

### 6.1 可复用底层方法（已经存在、可作其它平台基座）

| 方法 | 复用点 | 证据 |
|---|---|---|
| 单一显式信号分类器 | `resolveClientProfile` / `detectClientPlatform` 共用 `classifyExplicit`，检测与编码不会分歧 | `src/client-platform.js:20-22,80-103`；`src/client-profile.js:62-74` |
| 保守回退 | unknown/ambiguous → gemini，逐字保持 legacy 行为 | `src/client-platform.js:192-193`；`src/client-profile.js:124-125` |
| 单一 redirect 校验器 | DCR / authorize / token 全走 `isAllowedRedirectUri`，新增 Claude 未产生第二套白名单 | `src/oauth.js:51-77,454-468,580-608,699-702`；`docs/ledger/batch-15-claude-connector.md:33` |
| 平台隔离模式 | clientId 按平台派生 `gmc_...`、code/refresh 带 platform、connector 不可互兑、Gemini locked client Google-only | `src/oauth.js:461-495,559-598,703-722,783-789` |
| annotations 由 sanitizeTool 集中生成 | 不散落 per-tool；profile 不改安全语义 | `src/sanitize.js:230-248`；`src/client-profile.js:229-240` |
| 编码边界集中 | `encodeToolResult` / `encodeModelOutput` / `toModelOutput` 一处做 profile 投影 | `src/client-profile.js:145-199`；`src/codemode.js:1851,1925` |
| 离线 conformance checker | `runConformance` + fixture envelope，unknown 永不借证据 | `tests/platform-conformance-suite.test.js:93-107,441-475`；`docs/eval/PLATFORM-CONFORMANCE-MATRIX.md:237-252` |
| origin 一致性 | `resolveBaseUrl` 请求 host 优先，issuer/resource/401/CIMD 同 origin | `src/oauth.js:138-145`；`docs/DEPLOYMENTS.md:18` |

### 6.2 客户端 SOP（按 FRAMEWORK §5 七步，逐平台执行）

按 `docs/FRAMEWORK.md:226-234` 的客户端 SOP 与 `docs/eval/PLATFORM-CONFORMANCE-MATRIX.md:237-295` 的可执行 checklist：

1. **接入方式**：OAuth/DCR/CIMD/手动/静态 header，逐平台记录实际 callback 与开关（Gemini locked client；ChatGPT `ALLOW_DCR_FOR_CHATGPT=1`；Claude `ALLOW_DCR_FOR_CLAUDE=1`）。
2. **工具 schema / profile / 编码**：确认 3 工具名/序稳定、annotations 布尔齐、profile 编码符合平台（Gemini 无 `structuredContent`、ChatGPT dual、Claude text+annotations）。
3. **计划/权限限制**：记录 plan gating（ChatGPT Free/Plus 不可承诺）、admin/region/账号门槛；annotations 不是安全闸。
4. **主动评测任务**：按 `docs/eval/PLATFORM-CONFORMANCE-MATRIX.md:253-285` G1–G7 / C1–C10 / L0–L6 在真实客户端执行；每条带 requestId/capture；未知即 unknown。
5. **被动采集标签**：每 envelope 带 platform（+待补 mode）标签；主动/被动隔离统计；不跨构建硬比（`docs/eval/ONLINE-SEMIONLINE-JOIN-2026-11-23.md:119-160`）。
6. **适配优化**：基于主动发现的新维度倒推被动规则；审批 UX 实验 profile 只在真实窗口验证后改默认。
7. **回归与文档**：离线 conformance suite + 定向 OAuth 测试；回填 matrix 文档（本次审计发现 Claude 行滞后）；不把测试绿写成「线上验收」。

---

## 7. 改进优先级与依赖（明确 unknown）

| 优先级 | 项 | 为什么先做 | 依赖 / 前置 | 需真实客户端验证？ |
|---|---|---|---|---|
| P0 | Claude callback 文档回填 + 真实 connector 冒烟 | 代码已实现但 conformance matrix 仍写 fail，状态失真；真实链路从未跑 | `ALLOW_DCR_FOR_CLAUDE=1` 在目标部署是否开启 = unknown；HTTPS 443 / IPv4 egress | **是**（真实账号连接、tools/list、一次读、一次写确认） |
| P0 | 审批 UX 实验 profile（FRAMEWORK §14 B+D） | 用户直接反馈、影响 Gemini 日常体验；当前只有记录无实施 | 真实 Gemini 窗口确认弹窗触发条件与次数 | **是**（B 方案效果/写确认次数） |
| P0 | 在线↔半在线 join 扩到 ChatGPT/Claude | 当前只有 Gemini 在线样本，「客户端主动/被动评测」覆盖不足 | 真实账号 + requestId/capture；不补造 UUID | **是** |
| P1 | mode detection + capture 标签 | FRAMEWORK §11 直接含义；不做会污染后续所有 eval lane | 确认 capture envelope 标签槽位（本次未读 `src/capture.js` → unknown） | 否（先离线接口/测试），标签生效需线上确认 |
| P1 | ChatGPT 真实 Business 连接 + CIMD 决策 | 服务端齐备但端到端零测试；CIMD 是否在真实客户端被强制 = unknown | Business/Enterprise/Edu 账号 + admin publish | **是**（DCR vs CIMD、redirect_uri、schema 上限、linking UI） |
| P1 | v2/typed-plan 真实客户端 schema 验收 | v1 无 `plan`、v2 默认关；`docs/eval/MCP-V2-SMOKE.md:83` 明确真实客户端未验证 | `ENABLE_MCP_V2=1`（只在实验环境）；mode 维度先落地更好 | **是**（plan 被接受、写确认、code fallback） |
| P2 | Grok/Muse/Manus 同类平台复测与 SOP | 用户点名但「以是否存在同类问题为主」，先复测再决定是否适配 | Grok 报告 `docs/OPEN-SOURCE/WEB-CLIENTS.md:36` 需重测；Muse/Manus 资料 = unknown | **是**（若复测） |
| P2 | 免费/会员权限建模 | 理解正确但无服务端 gate；只能靠文档/引导，防止误承诺 | 产品决策（是否做服务端只读 gate） | 否（服务端 gate 若做，需真实只读账号验证） |
| P2 | onboarding 产品化 | 当前只有运维 checklist + design-only registry，用户首次接入门槛高 | 依赖 P0/P1 真实流程跑通后固化 | 部分（用真实流程录制/校验） |

**明确的 unknown（不得写成 pass）**：

- ChatGPT / Claude 真实账号端到端连接、tools/list、写确认、401 linking UI、schema-token 上限、meta-refresh 是否被接受、CIMD 是否被强制（`docs/CLIENTS-CHATGPT.md:80-110`）。
- Claude DCR carve-out 在生产部署是否开启 —— unknown（`src/oauth.js:377-379` 默认关；生产 env 未读）。
- 真实 `/mcp` capture 是否带 platform/profile 标签 —— unknown（本次未读 `src/capture.js`；仅见离线 envelope 构造 `tests/platform-conformance-suite.test.js:94-101`）。
- Gemini 已设「允许」仍弹窗的具体触发条件、一次写操作平均确认次数、B 实验 profile 效果（`docs/FRAMEWORK.md:487-492`）。
- Grok 的 OAuth+DCR 是否仍 broken；Muse/Manus 是否存在同类问题（`docs/OPEN-SOURCE/WEB-CLIENTS.md:36`；FRAMEWORK §9 #2）。
- 生产 `d1f36ba` 是否包含 Claude callback / v2 代码：Claude callback 落地在 B15 ledger（未 commit 部署记录），v2 默认关；**当前 checkout HEAD `f542e93` ≠ 生产 `d1f36ba`**，生产是否含这些源码需用 healthz buildHash 对照验证，本审计不下结论。
- 任何「线上已验收」表述：与 `AGENTS.md:0`、`docs/DEPLOYMENTS.md:18` 冲突，禁止。

---

## 附：本次审计的证据边界

- 已读：`docs/FRAMEWORK.md`、`docs/ARCHITECTURE-PROGRESSIVE.md`、`docs/CLIENTS.md`、`docs/CLIENTS-CHATGPT.md`、`docs/OPEN-SOURCE/CLIENT-PROFILES.md`、`docs/eval/PLATFORM-CONFORMANCE-MATRIX.md`、`docs/eval/ONLINE-SEMIONLINE-JOIN-2026-11-23.md`、`src/client-platform.js`、`src/client-profile.js`、`src/oauth.js`、`src/sanitize.js`、`src/vercel-app.js`、`api/index.js`、`tests/platform-conformance-suite.test.js`、`tests/claude-connector.test.js`、`tests/chatgpt-oauth.test.js`、`docs/ledger/batch-15-claude-connector.md`、`docs/DEPLOYMENTS.md`、`docs/OPEN-SOURCE/WEB-CLIENTS.md`（节选）、`docs/eval/MCP-V2-SMOKE.md`（grep 命中）、`src/codemode.js`（工具面节选）。
- 未读（故不引用其内容）：`src/capture.js`、`src/server.js`（除 grep/测试引用外）、`src/store.js`、`templates/client-profiles/*.json` 的实际内容、`docs/eval/online-feedback-2026-11-23-gemini.md`、`docs/eval/SEMI-ONLINE-GAPS.md`、生产环境真实配置。
- **docs/CLIENT-PROFILES.md 不存在**（glob 确认）；`docs/ARCHITECTURE-PROGRESSIVE.md:115` 与 `docs/OPEN-SOURCE/CLIENT-PROFILES.md:5-9` 对 profile 的引用以后者 + `src/client-profile.js` 为准。
- 未运行任何测试、未联网、未使用凭据、未改代码、未 commit / push / deploy。本报告只新增本文件。
