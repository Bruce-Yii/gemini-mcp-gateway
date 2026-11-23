# Batch 11 · 薄客户端 profile / 结果编码 adapter（2026-11-23）

> 范围：只写 `src/client-profile.js`（新增）、`src/server.js`（只在 tools/list 与
> tool result 组装处接 profile）、`src/codemode.js`（只在 `toModelOutput` /
> 结果编码处接 profile）、`tests/client-profile.test.js`（新增）、本台账。
> **未改** `src/capture.js`、`scripts/`、其他 tests、`README`、`CHANGELOG`、
> workflows、MCP 工具名 / 工具面 / schema / 执行语义。
> **未 commit / push / deploy**，改动全部留在工作区。

## 一、边界声明（先说清楚这不是什么）

- 这是 **结果编码 adapter（encoding adapter）**，不是多租户层、不是安全层。
- 它只决定「已经算好的工具结果如何编码上线」：是否附 `structuredContent`、
  是否保留 text JSON、annotations 默认值。
- 它 **不** 读凭据、**不** 做鉴权 / 隔离 / 配额、**不** 改工具名、工具数量、
  inputSchema、description、handler、执行流程。
- 识别客户端靠**显式声明**，不是猜测；任何未知输入一律回退 `gemini`。
- **不承诺任何客户端实测**：本批无真实 Claude / ChatGPT / Gemini 客户端联调，
  行为依据是任务给定的事实与本地确定性测试；真实客户端兼容性需另行验证。

## 二、事实与编码策略

| Profile | text JSON | `structuredContent` | annotations |
|---|---|---|---|
| `gemini`（默认 / legacy） | 必需 | **不发送**（绝不能泄漏） | 保持现状 |
| `chatgpt` | 必需 | **同时发送** | 保持现状 |
| `claude` | 必需 | 默认关闭（`structuredContent=false`） | 保持现状（text + annotations） |

现有 annotations（`readOnlyHint` / `destructiveHint` / `openWorldHint`）由
`sanitizeTool()` 产出，本 adapter 原样保留，三个 profile 下取值一致。

## 三、契约

### 1. `resolveClientProfile({headers, body, env?})`

返回冻结的 `CLIENT_PROFILES[id]` 之一。判定顺序（先命中即停）：

1. 显式 header `X-Gateway-Client-Profile`（大小写不敏感，数组取首个字符串）。
   接受 `gemini|legacy|default` → gemini，`claude|claude-code|anthropic` → claude，
   `chatgpt|chat-gpt|openai` → chatgpt。
2. initialize body 的 `params.clientInfo.name`（或顶层 `clientInfo.name`）— 仅当
   值为上述精确 token 时算显式声明。
3. User-Agent 中**明确的产品 token**（`\bclaude\b|\bclaude-code\b|\banthropic\b`
   → claude；`\bchatgpt\b|\bopenai\b|\bchatgpt-agent\b` → chatgpt）。
   `Mozilla/...`、`curl/...` 等泛化字符串**不是**信号。
4. 显式环境变量：`GATEWAY_CLIENT_PROFILE=<token>`，或
   `GATEWAY_CLIENT_CLAUDE` / `GATEWAY_CLIENT_CHATGPT` 为 `1|true|yes`。
5. 其余（缺失、未知、空）→ **gemini**（legacy text-JSON 默认）。

不做子串猜测；未知 header 值直接回退。

### 2. `encodeToolResult(result, profile)`

输入为 MCP 工具结果 `{content:[{type:'text',text:JSON.stringify(value)}, ...], ...}`；
返回**新对象**，不改入参。

- gemini / claude：移除 `structuredContent`，其余字段原样返回。默认
  （无 structuredContent）情况下与旧代码逐字节一致。
- chatgpt：保留既有 `structuredContent`；若无，则从单个 text JSON block
  最佳努力派生（对象 / 数组才派生，纯文本或多个 text block 不派生）。

### 3. `encodeModelOutput(output, profile)`

Code Mode 投影结果 `{result, ...}` 的编码：gemini 原样；chatgpt 从 `result`
（对象 / 数组或可解析 JSON 字符串）派生 `structuredContent`。

### 4. `applyProfileToTools(tools, profile)`

只调整 annotations 默认值：缺失时补
`{readOnlyHint:false, destructiveHint:false, openWorldHint:false}`（与
`sanitizeTool()` 默认一致）。**不改**工具名、数量、schema、description、
handler。gemini 默认路径返回内容与输入逐字节一致。

## 四、接线点（最小侵入）

- `src/server.js`
  - `createGatewayServer()`：从 `options.profile` 或 `resolveClientProfile()`
    解析一次；`tools/list` 经 `applyProfileToTools()`；`CallTool` 结果经
    `encodeToolResult()`。
  - `createMcpRequestHandler()`：每次 POST 用 `req.headers` + 已解析 body
    调 `resolveClientProfile()`，作为 `options.profile` 传入（stateless，
    一请求一实例）。
- `src/codemode.js`
  - `toModelOutput(output, profile?)`：profile 缺省时**完全走旧路径**，
    老调用者零影响；显式传入时才做编码。
  - `createCodeModeTools()`：从 `options.profile` 解析（HTTP 路径由 server.js
    注入），execute handler 把 profile 传给 `toModelOutput()`。
- 不改工具名 / 工具数 / schema / 执行语义 / 捕获审计。

## 五、默认行为兼容性（逐字节）

- 无 header / body / env 信号 → gemini。
- `encodeToolResult()` 不带 profile 参数时等价于 gemini；典型结果
  `{content:[...]}` 的 `JSON.stringify` 与旧实现一致。
- `toModelOutput()` 不带 profile 参数时直接返回 `toJsonSafe(rest)`，与旧实现
  一致；codemode 直接调用者（不经 server.js）不受影响。
- `applyProfileToTools()` 对已有 annotations 的工具原样返回。

## 六、测试与结果

新增 `tests/client-profile.test.js`，**25 个测试**（全部 fake / 纯函数，无网络）：

| 覆盖点 | 测试 |
|---|---|
| 四 profile + 未知回退 gemini | default / unknown header / unknown profile id |
| 显式识别：header（含大小写、数组）、clientInfo.name、UA token、env | explicit header / case-insensitive / array / clientInfo / UA / vague UA / env / priority |
| structuredContent 不泄漏给 Gemini | gemini strip 测试 |
| ChatGPT 双编码 + Claude text+annotations | chatgpt / claude 测试 |
| 派生边界：纯文本、多 text block、预存 SC | chatgpt 相关 4 个测试 |
| 默认回归（逐字节） | default regression / toModelOutput gemini / applyProfileToTools gemini |
| annotations 不变（工具名/数量/schema） | applyProfileToTools 两个测试 |
| profile 不可变 | frozen profiles 测试 |

验证命令与结果：

- `node --check src/client-profile.js && node --check src/server.js && node --check src/codemode.js`：通过
- `node --test tests/client-profile.test.js`：**25 / 25 通过**
- 相关回归 `server.test.js` + `codemode.test.js` + `structured-content-blocks.test.js`
  + `l1-baseline.test.js`：**24 / 24 通过**
- 全量 `npm test`：本批相关的 client-profile / server / codemode / structured-content
  测试全部通过；全量结果中出现的 2 个失败位于
  `tests/export-oss.test.js`（`isDenied('my-gateway.local.json')`）与
  `tests/figma-guard.test.js`（cooldown expiry 时间敏感），这两个文件本批未改、
  也不 import client-profile，属并发改动 / 既有问题，非本批引入。

## 七、仍未覆盖的风险 / 限制

1. **无真实客户端实测**：Claude / ChatGPT 对 `structuredContent` 与 annotations
   的实际消费行为未在真实客户端验证；若真实客户端表现与任务给定事实不同，
   需调整 `CLIENT_PROFILES` 或编码策略。
2. **检测是显式声明制**：未声明 profile 的客户端一律按 gemini 处理。若某
   ChatGPT/Claude 客户端不发送任何可识别声明，它不会得到 `structuredContent`
   —— 这是「不猜测」原则的刻意取舍。
3. **UA token 列表有限**：只识别明确的产品 token；新客户端需要扩展
   `classifyUserAgent()`。
4. **注释与文档一致性**：工具名 / 数量 / schema 未变，符合 AGENTS.md 的
   「工具列表必须稳定」约束；未改契约文档（Code Mode 以源码为准）。
