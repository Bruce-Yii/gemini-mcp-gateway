# B13 第一层 — 客户端平台隔离（capture 派生标签）

> 范围：只记录本层（`src/client-platform.js` + `src/capture.js` 的 envelope 增量 + `tests/client-platform.test.js`）。
> 不做 OAuth 多 client、不做 digest/eval、不做写路径改动。禁止 commit/push/deploy。

## 1. 目标与边界

在 single-owner 前提下，为 Gemini / ChatGPT / Claude 的分账提供**可观测标签**。本层只做三件事：

1. 从请求中已存在的显式信号派生 `clientPlatform` / `clientProfile` / `oauthClientId`；
2. 把这三个字段**增量**写入 capture envelope；
3. 用纯函数 + 测试证明：默认行为不变、识别保守、envelope 旧字段不变。

**明确不做**（本层不做，且以后也不得用这些标签做）：写路径、幂等键、权限判断、工具名/数量/schema、上游认证决策、跨租户隔离。标签只是观测/编码元数据。

## 2. 规则

### 2.1 `detectClientPlatform({ headers, body, oauthClientId, oauthClientMap, env })`

纯函数，无 I/O、不改入参、不依赖可变全局状态（`env` 显式注入，默认 `process.env`）。返回：

```
{
  platform:  gemini | chatgpt | claude | unknown,
  profile:   gemini-text-json | chatgpt-structured | claude-text,
  source:    profile_header | client_info | oauth_client_id | user_agent | default,
  confidence: high | medium | low
}
```

识别优先级（第一个命中的显式信号胜出）：

1. `x-gateway-client-profile` header（大小写不敏感，array 取首个字符串）；
2. initialize body 的 `clientInfo.name`（也兼容 `body.clientInfo.name`）；
3. OAuth client id 映射 —— **仅显式配置**，不按前缀/子串/形状猜测；
4. 明确的 UA product token（如 `Claude-Desktop/...`、`ChatGPT-Agent/...`）；
5. 其余一律 `unknown` + `gemini-text-json`。

底层 token 分类复用 `src/client-profile.js` 的 `resolveClientProfile()`（single source of truth），因此平台标签与结果编码口径不会分叉。为避免把"未识别而回退到 gemini"误报成显式 gemini 信号，header/clientInfo 先做受认可 token 校验；UA 只在明确识别为 ChatGPT/Claude token 时才算信号。

### 2.2 OAuth client id 映射

仅两种显式来源，均不猜测：

- `input.oauthClientMap`：`{ "<exact-client-id>": "gemini"|"chatgpt"|"claude" }`；
- `env.CLIENT_PLATFORM_OAUTH_MAP`：同 shape 的 JSON 字符串（格式错误则忽略，返回 unknown）。

未在映射表中的 client id 一律不产生信号。authorization bearer token **不是** client id，不会被读取。

### 2.3 profile 映射

| platform | profile |
|---|---|
| gemini | `gemini-text-json` |
| chatgpt | `chatgpt-structured` |
| claude | `claude-text` |
| unknown | `gemini-text-json`（与既有默认逐字节一致） |

### 2.4 capture envelope 增量

`src/capture.js` 在**已启用的** envelope 构造处（`res.end` 内）新增三个顶层字段：

- `clientPlatform`
- `clientProfile`
- `oauthClientId`（`req.oauthClientId` / `req.__gatewayOAuthClientId` / `req.__gatewayOauthClientId`，没有则 `null`）

不改动：捕捉资格、`schema`、`ts`、`requestId`、`request`/`response` 原始字节与 headers、`events`、`model`、`projects`、ack/skip/done 日志。capture disabled / skipped 时不构造 envelope，因此不会写入任何平台字段。检测异常被吞掉并回退到 unknown，绝不让 capture 因标签失败。

## 3. 证据

### 3.1 代码落点

- `src/client-platform.js`：`detectClientPlatform()` 纯函数；显式 token 校验；OAuth 显式映射；冻结 `CLIENT_PLATFORM_PROFILES`。
- `src/capture.js`：import `detectClientPlatform`；新增 `captureOAuthClientId()` / `buildClientPlatformBlock()`；envelope 中 `...buildClientPlatformBlock(req, options)` 仅一行增量。
- `tests/client-platform.test.js`：23 个用例。

### 3.2 测试覆盖（全部通过）

- 三平台 + unknown：各自 platform/profile/source/confidence 精确断言；
- 优先级：header > clientInfo > OAuth id > UA；header 大小写不敏感 + array 值；
- 未识别 header / 模糊 UA 不被误报；
- clientInfo `initialize` 与非 `initialize` shape；
- OAuth id：option map、env JSON map、未映射不猜测、错误 JSON 忽略；
- 默认兼容：Gemini 风格请求 → `unknown` + `gemini-text-json`；
- 纯函数确定性（重复调用一致）与不改入参（frozen 输入不抛）；profile map 冻结；
- envelope additive：旧字段（`schema`/`request.raw`/`response.raw`/headers/status/`model`/`events`）保持，新增三字段正确；
- 默认 envelope：`unknown` / `gemini-text-json` / `oauthClientId: null`；
- disabled capture：不写任何 envelope 文件。

运行：`node --test tests/client-platform.test.js` → 23 pass / 0 fail。
全量：`npm test`（由 lead 统一回归；若并发导致其他 agent 的用例失败，以各自最终全量结果为准）。

## 4. 误报边界

- **不猜**：header/clientInfo 只认可 `client-profile.js` 中明确列出的 token；未知字符串视为无信号。
- **UA 保守**：仅明确 product token 命中才识别；`Mozilla/...`、`curl/...`、`node-fetch/...` 等通用 UA 不算。
- **OAuth 必须显式配置**：client id 形状/前缀（如 `gmc_*chatgpt*`）不构成证据；未配置映射即 unknown。
- **显式 gemini 是真实信号**：header/clientInfo 明确声明 `gemini` 时返回 `platform: gemini`、`source: profile_header|client_info`、高置信度；这与"无信号"的 `unknown` 可区分。
- **unknown 不等于异常**：未知一律落在 legacy 默认 profile，行为与改造前逐字节一致。
- **来源置信度**：header/clientInfo/OAuth = high；UA = medium；默认 = low。仅供分析使用，不改变任何执行路径。
- **标签非授权**：任何代码路径不得因 `clientPlatform` 值改变写权限、幂等、工具注册或上游 token 选择。

## 5. 未覆盖 / 后续

- OAuth 多 client 注册与 token 分账属于 `chatgpt-oauth` agent 的范围；本层只读其可能附加在 `req` 上的 client id。
- `byClientPlatform` digest / conformance 属于 `platform-eval` agent。
- 配置模板与公开文档属于 `platform-registry` agent。
- 本层不修改 `src/oauth.js`、`src/vercel-app.js`、`src/server.js`、`scripts/`、其他 tests、README、workflows。
