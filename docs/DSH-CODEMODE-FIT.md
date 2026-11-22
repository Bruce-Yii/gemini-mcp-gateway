# DSH 本地接入 Code Mode MCP 网关 · 可行性调研

> **归档说明（2026-11-22 从 `work/` 移入 `docs/`）**：调研快照，不是规范。DSH 版本与配置字段可能随后升级变化，接入前按文末"版本敏感"一条复核。

> 只读调研，未改任何代码。调研时间 2026-11-22。
> DSH 版本：`0.2.2-rc.5`（`@deepseek-ai/dsh-desktop-runtime`），profile=`desktop`，`DSH_HOME=<DSH_HOME>`。
> 网关对象：`<repo>`（线上 `https://<your-domain>/mcp`）。

---

## 0. 结论（放最前）

### 总体技术可行性：**中高**

拆开看：**协议/传输/工具名/content 四项是"高"**（几乎零适配），**OAuth 认证一项是"中"**（需要绕一下）。综合判定为中高——能接，但不是零成本。

一句话：**网关是标准 Streamable HTTP MCP server，DSH 的 MCP 客户端原生支持 Streamable HTTP，所以工具面可以直接接；真正的障碍是网关按 Gemini 自定义连接器要求实现了 OAuth 2.1 + DCR + PKCE，而 DSH 的 MCP 客户端只会发"配置里写死的静态 header"，没有 OAuth 客户端流程。** 接受"手工拿一次 token 配成静态 Bearer"就能跑；要长期稳定则需要在中间加一个本地 OAuth 代理。

### 四维速查

| 维度 | 结论 | 是否要改网关 |
|---|---|---|
| 传输 / 协议 | ✅ 高：`transport: streamable-http`，SDK 选 2026-07-28 协议并回退旧版；网关 `2025-11-25` 在兼容范围 | 否 |
| 工具名 `__` | ✅ 高：DSH 公共名 `mcp__<server>__<raw>`，`__` 合法且**从不反解析**，与网关内部 `server__tool` 不冲突 | 否 |
| content block | ✅ 高：网关只回 text JSON，DSH 原生 text 完全支持；结构化/富媒体当前都没用上 | 否 |
| OAuth DCR/PKCE | ⚠️ 中：DSH MCP 客户端无 OAuth 流程，只有静态 header + 凭据模板 | 否（但要加人工/代理环节） |
| 模型写 JS 代码 | ✅ 可用，但有可靠性风险；且 DSH 自带原生 PTC（`run_code`），与网关 Code Mode 概念重叠 | 否 |

### 需要适配的点（一句话版）

1. **配置**：desktop profile 的 `cordis.patch.yml` 加一条 `dsh-mcp-client` 条目（`serverName` / `transport: streamable-http` / `url` / `headers.Authorization`），建议 `expandTemplates: true` + `${credential:REF}` 存 token、`failOnStartupError: true`、`toolCallTimeoutMs` 调大。
2. **工具名**：无需适配。网关只暴露 `search` / `execute` / `execute_read` 三个短名，DSH 会变成 `mcp__<serverName>__execute` 等；64 字符上限内安全。
3. **content**：无需适配。text JSON 直通；若将来上 audio/embedded resource，DSH 会降级成诊断文本（当前无影响）。
4. **OAuth**：**唯一实质适配点**。网关要 Bearer token，DSH 不会自己去 DCR/PKCE/refresh。两条路：静态 token 手工轮换（最小），或本地 OAuth 代理（稳健）。

### 最大的障碍是什么

**不是模型写代码能力，也不是 MCP 协议支持**——DSH 原生支持 Streamable HTTP，网关就是标准 MCP，工具名/content 全兼容。

**是认证模型不匹配**：网关按 Gemini 自定义连接器的硬性要求实现了完整 OAuth 2.1 + DCR + PKCE（6 个 redirect URI、S256、state、token 不轮换），而 DSH 的 MCP 客户端是"部署方在配置里放好静态 header"的模型。

次要障碍：**DSH 自带原生 PTC（Programmatic Tool Calling）**，形态与网关 Code Mode 高度相似（模型写代码字符串，宿主跑沙箱，工具作为 binding）。如果同时启用 DSH 的 PTC preset 和网关，会出现"代码里写代码"（`run_code` 里再调 `mcp__gw__execute(code: "…")`）。**建议保持 DSH 默认 native executor，只用网关的 `execute`**，不要开 PTC preset。

### 最小可行路径（MVP）

1. 本地（或线上域名）确认 `/mcp` 可达；网关保持 `codemode` 模式，只暴露 3 个工具。
2. 用浏览器走一次网关的 OAuth 同意流程，拿到 `access_token`（PKCE S256、state 约 1400 字符，走网关同意页）。
3. 在 `<DSH_HOME>\profiles\desktop\cordis.patch.yml` 增加一条 `dsh-mcp-client` 条目：
   - `serverName: geminigw`（或 `codemode`）
   - `transport: streamable-http`
   - `url: https://<your-domain>/mcp`（或本地 `http://localhost:3000/mcp`）
   - `headers.Authorization: 'Bearer ${credential:GEMINI_GW_TOKEN}'` + `expandTemplates: true`
   - `failOnStartupError: true`、`toolCallTimeoutMs: 120000`（沙箱 + 上游调用比普通工具慢）
   - token 通过 DSH 凭据存储/环境变量注入，不写进 patch（避免重蹈现有 `mcp-linear` 条目把 Bearer 明文写进配置的覆辙）。
4. 重启宿主使 profile patch 生效（desktop profile 的插件由应用管理）。
5. 验证：`mcp__geminigw__search({query:"github search repos"})` 能返回工具；`mcp__geminigw__execute({code:"async () => { const r = await codemode.github__search_repositories({query:'x'}); return r.total_count; }"})` 能返回小摘要。
6. 不要启用 `ptc.patch.yml` preset（保持默认 native executor），避免嵌套代码。

---

## 1. 先对齐"被接对象"：网关实际接口

调研发现网关已远超 `CONTRACT.md` 里的 MVP 形态，真实接口以 README / `CONTRACT.vercel.md` / `src/codemode.js` 为准：

- **工具**：codemode 模式只暴露 `search`、`execute_read`、`execute` 三个（`src/codemode.js:919` `return [searchTool, makeExecute('execute_read', true), makeExecute('execute', false)]`）。`execute` 的入参是 `{ code: string }`，描述为 "An async arrow function that calls codemode tools and returns a result"（`src/codemode.js:890-894`）。工具描述里带完整示例和 `codemode.*` SDK 说明（`src/codemode.js:889`）。
- **传输**：单 `/mcp` endpoint，Streamable HTTP，MCP `2025-11-25`（至少兼容 `2025-03-26`）（`CONTRACT.vercel.md:15`）。
- **认证**：网关同时是 OAuth 资源服务器 + 授权服务器。`/mcp` 所有 JSON-RPC 必须带 `Authorization: Bearer <access_token>`，否则 401 + `WWW-Authenticate` 指向 protected resource 元数据（`CONTRACT.vercel.md:8,32`；`src/vercel-app.js:133-144` 正则 `^Bearer\s+(.+)$`）。实现含 DCR、PKCE S256、state 原样保留、refresh token 不轮换（`CONTRACT.vercel.md:21-31`）。README 标注"线上全链路验证通过（6 redirect URI / PKCE / state / token / MCP 握手）"（`README.md:12`）。
- **工具名**：上游 entry 用 `server__tool` 双下划线（`AGENTS.md:12`、`CONTRACT.md:72`），但**这是沙箱内部调用名**，对 MCP 客户端暴露的顶层工具只有上面 3 个短名。
- **content**：结果统一 `content:[{type:'text', text: JSON.stringify(result)}]`，明确不用 `structuredContent`（`AGENTS.md:13`、`CONTRACT.md:91`、`README.md:42`）。
- **工具列表稳定**：Gemini 不消费 `notifications/tools/list_changed`，改 schema 要换版本路径（`AGENTS.md:11`）。

> 这对 DSH 反而是好消息：稳定的 3 个工具定义 = 稳定 KV cache；不需要 DSH 侧的动态刷新能力。

---

## 2. DSH 的 MCP 客户端能力（调研方向 1）

**证据**：`@deepseek-ai/dsh-mcp-client/README.md`，版本 0.2.2-rc.5；`src/transport.ts`；desktop profile `cordis.patch.yml`。

- **库**：依赖 `@modelcontextprotocol/client` 2.2.0（`dsh-mcp-client/package.json:53`）。README 明确："The official SDK selects the 2026-07-28 protocol when available and falls back to supported legacy revisions."（`README.md:28`）→ 网关的 `2025-11-25` 兼容。
- **传输**：只支持两种——`stdio` 与 `streamable-http`（`README.md:57`）。`src/transport.ts:40-44` 直接 `new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } })`。**不做 SSE fallback、不做 OAuth**。
- **现成例证**：本机 desktop profile 已经用 streamable-http 连过 Linear（`<DSH_HOME>\profiles\desktop\cordis.patch.yml:277-286`：`serverName: linear`、`transport: streamable-http`、`url: https://mcp.linear.app/mcp`、`headers.Authorization: "Bearer …"`）。这直接证明"DSH 本地连远程 HTTP MCP + Bearer header"路径已在本机跑通过。（注意该条目的 token 是明文写在配置里的，新接入不要照抄这个坏习惯。）
- **配置字段**（`README.md:55-71`）：`serverName`（`[A-Za-z0-9_-]{1,32}`）、`transport`、`url`/`headers`、`toolCallTimeoutMs`（默认 60000）、`startupTimeoutMs`、`failOnStartupError`（默认 false）、`reconnect.*`、`expandTemplates`（默认 false）、`maxInstructionBytes`。
- **凭据**：`expandTemplates: true` 时 `url`/`headers`/`env` 等支持 `${credential:REF}`，由 credentials provider 解析并对诊断信息打码（`README.md:64,101-105`；`dsh-mcp-manager/README.md:82`）。DSH 凭据文件支持 `grant` 类型 + `type: oauth` 记录（`dsh-credentials-local/README.md:93-100`），但**这是通用存储，不是 MCP 的 OAuth 客户端流程**——token 得由外部先拿到再存进去。
- **OAuth DCR / PKCE**：在 `dsh-mcp-client`、`dsh-mcp-manager` 的源码与文档中**未找到**任何 DCR、authorization code、PKCE challenge 的实现；只支持静态 header。DSH 里确实存在 PKCE 代码，但属于其他子系统：`dsh-deepseek-account`（DeepSeek 账号登录，`README.zh.md:68`）、`dsh-experimental-liveshare`（owner 授权，`src/host/owner-authorization.ts:36,64`）、`dsh-credentials` 的快照字段说明（`docs/subsystems/credentials.md:274`）——**都与 MCP 连接无关**。
- **重连与同步**：断线自动重连（500ms 翻倍到 30s，10 次后摘除工具）；tool-list 通知触发重新同步；配置改动原地重载连接（`README.md:92-96`）。

**结论**：Streamable HTTP ✅；OAuth DCR/PKCE ❌（需外部 token 或代理）。

---

## 3. 工具名解析（调研方向 2）

**证据**：`dsh-mcp-client/src/tools.ts:55-97`（`MAX_PUBLIC_NAME_LENGTH`、`INVALID_NAME_CHARS`、`publicToolName()`）。

算法（逐行可核对）：

```
joined     = `mcp__${serverName}__${rawName}`        // :92
normalized = joined.replace(/[^A-Za-z0-9_-]/g, '_')  // :93
if (normalized === joined && length <= 64) return normalized  // :94
hash = sha256(`${serverName}\0${rawName}`).slice(0,12) // :95
return normalized.slice(0, 64-12-1) + '_' + hash       // :96
```

要点：

1. **DeepSeek function-name 合约**：最多 64 字符，只允许 `[A-Za-z0-9_-]`（`tools.ts:54-61`）。`_` 和 `-` 都合法，所以 **`__` 完全合法**。
2. **公共名从不被反解析**：`tools.ts:8-10` 注释明确 "The raw name is only ever sent on the wire (`tools/call`); the public name is never parsed to recover it."；`tools/call` 始终传 `tool.name` 原始名（`:154-157`）。因此 DSH **没有"按第一个下划线分 namespace"的行为**，网关用 `__` 规避 Gemini 解析的动机在 DSH 侧不存在，也不会造成歧义。
3. **网关 3 个工具名很短**：`mcp__geminigw__execute` 约 21 字符，远低于 64，不会触发 hash 截断。
4. **潜在冲突面**：同一注册 scope 内两个 `serverName` 相同会加载失败；同名工具在两服务器下共存为不同命名空间（`README.md:80-84`）。网关内部的 `server__tool` 名不进入 MCP 工具表，无冲突。
5. **重名保护**：服务器重复列同一工具会被判非法并保留上一代工具集（`tools.ts:140-144`）。

**结论**：工具名零适配。

---

## 4. content block 支持（调研方向 3）

**证据**：`dsh-mcp-client/src/tools.ts:487-537`（`projectContent()` switch）、`:327-339`（canonical value）、README `:86-90, 201, 235`。

| MCP block | DSH 行为 | 证据 |
|---|---|---|
| `text` | 原生支持，按 block 顺序以 `\n` 合并 | `tools.ts:509-511`, `:497-500` |
| `image` | 仅 PNG/JPEG/WebP/GIF；需当前模型声明 image input + attachment 特性启用；通过才作为图片附件进上下文，否则降级为诊断文本 | `tools.ts:66-72`, `:333-337`, `:412-465`, `:394-396` |
| `audio` | 降级为 `[audio result unsupported: …; raw audio data remains available to programmatic callers]`，原始 payload 只在 canonical value 里 | `tools.ts:523-525` |
| `resource`（embedded） | 降级文本，同上 | `tools.ts:526-528` |
| `resource_link` | 仅保留 name + URI 作为文本 | `tools.ts:516-522` |
| 未知 type | 诊断文本 | `tools.ts:529-531` |
| `structuredContent` | 完整保留在 canonical value `{content, structuredContent?}`，供 programmatic/PTC 调用者使用；Native 渲染仍只取 text | `tools.ts:48-52`, `:327-332`, `:276-291`；README `:157` |

网关当前只回 text JSON（`AGENTS.md:13`、`CONTRACT.md:91`），完全落在 DSH 原生支持范围内。**零适配。**

补充：DSH 对 MCP `isError` 会直接抛错而不是伪造成功（README `:88`、`tools.ts:322-325`），这对网关的错误透传是好事。

---

## 5. 模型写代码 / PTC（调研方向 4）——最关键的一节

### 5.1 DSH 有原生 PTC，但默认关闭

**证据**：`dsh-base/cordis.patch.yml:407-408`（挂载 `dsh-ptc-runtime-node`）、`:522-524`（`tool-executor-ptc` **`disabled: true`**）；`dsh-web-app/presets/ptc.patch.yml:127-128`（PTC preset 里启用它）。当前会话是 native 模式（工具以独立 `mcp__*` / `functions.*` 暴露，而非单一 `run_code`），与"base 默认 disabled"一致。

PTC 机制（`dsh-tool-executor-ptc/README.md`）：

- 只暴露保留工具 `run_code`，入参 `{ code, description }`，code 是 **async TypeScript 函数体**；宿主生成 SDK binding，`await tools.name(args)` 调用工具；示例见 `:99-113`。
- Node 后端 `per-call` 模式在独立 Node 进程跑 erasable TypeScript，`vm-script` / `persistent-in-memory` 可保留状态（`dsh-ptc-runtime-node/README.md:12,48-52`）。
- 有防护：每次程序工具调用上限 `maxSubCallsPerMinute: 1024`（换算 2 分钟默认超时 = 2048 次），超限整段 abort 并返回 `CODE_RUN_FAILED`（`README.md:37-39`）。
- MCP 工具在 PTC 下正常工作：canonical value 保留完整 JSON block 与 structuredContent，"for programmatic and PTC mode callers"（`dsh-mcp-client/README.md:157,201`）。

### 5.2 这对网关接入意味着什么

- **好消息**：DSH 的 hy4-flash-free 等本地模型被明确期望能写"代码字符串"——PTC 的系统提示就是让模型输出 `run_code({ code: "return await tools.bash(...)" })`（`dsh-tool-executor-ptc/README.md:99-113`）。网关 `execute` 的描述同样带示例（`codemode.js:889,892`）。两者对模型的要求是同一类能力，所以**模型写 `execute` 的 code 字符串在能力上没有问题**。
- **风险**：code 是嵌在 JSON tool argument 里的字符串，长程序有转义/语法出错概率；网关 sandbox 还会限制 call 数/结果大小。建议提示模型"短程序、先 search 再 execute、return 小摘要"。本机 hy4-flash-free 配置为 `contextWindow 1,048,576 / maxTokens 65,536 / input text+image`（`cordis.patch.yml:93-102`），足够承载工具描述与生成代码。
- **概念重叠**：DSH 原生 PTC 与网关 Code Mode 都是"模型写代码 → 沙箱调工具 → 只回 return"。因此：
  - **推荐**：保持 DSH native executor，把网关接成 3 个普通工具。此时上下文节省来自"只挂 3 个工具定义"，执行来自网关 sandbox。无需 DSH PTC。
  - **不推荐同时开 PTC preset**：会出现 `run_code` → `mcp__gw__execute(code: "…")` 双层代码字符串，调试和 token 成本都更差。

**结论**：模型写代码不是障碍；DSH 原生 PTC 是"替代方案"而非"前置条件"。（未做实测稳定性基准，见第 11 节未验证项。）

---

## 6. client-plugin HMR / 工具动态刷新（调研方向 5）

两套机制要分清：

1. **Host 侧 MCP 工具同步**（与网关相关）：`dsh-mcp-client` 通过 legacy notifications 或现代 subscription 接收工具列表变化，重新同步；同步串行化、原子替换整代工具；拉取失败保留旧工具集，注册冲突回滚整代；schema 变化会替换定义并可能使 KV cache 从第一个变化 token 起失效（`dsh-mcp-client/README.md:94,120-122,151,193-195`；`src/tools.ts:100-188`）。
2. **Web client-plugin HMR**（与网关无关）：`dsh-client-hmr` 通过 `/plugins/events` SSE 推送 graph/rebuilt，浏览器端换插件 bundle；需要 `pnpm run dev:web` 跑 watcher；只影响 UI 插件层，**对模型输入/输出无影响**，且"Web transport only — Electron installation … do not use this SSE path"（`dsh-client-hmr/README.md:12,32,103,118`）。

对网关的影响：网关**故意保持工具列表稳定**（Gemini 约束，`AGENTS.md:11`），所以第 1 类同步基本不会触发；第 2 类与本场景完全无关。**HMR 不是接入障碍。**

---

## 7. 适配清单（按工作量排序）

| # | 项 | 工作量 | 说明 |
|---|---|---|---|
| 1 | OAuth token 获取与轮换 | 中（唯一实质工作） | 方案 A：手工 OAuth 拿 token → 存 DSH credential → 静态 header，过期重来。方案 B：本地 OAuth 小代理做 DCR/PKCE/refresh，DSH 连 `http://127.0.0.1:<port>/mcp`。 |
| 2 | profile 配置条目 | 低 | desktop `cordis.patch.yml` 加一行；token 走 `${credential:REF}` + `expandTemplates: true`，不要明文。 |
| 3 | 超时/启动策略 | 低 | `toolCallTimeoutMs` 建议 ≥120000；`failOnStartupError: true` 便于发现认证失败。 |
| 4 | 工具名 | 无 | 3 个短名，合法且不被反解析。 |
| 5 | content block | 无 | text JSON 直通。 |
| 6 | 工具列表/HMR | 无 | 网关列表稳定，DSH 不会 churn。 |
| 7 | PTC preset | 建议别开 | 避免双层代码字符串。 |

---

## 8. 证据索引

**DSH 实现 checkout**：`<DSH checkout>`（版本 `0.2.2-rc.5`，见 `package.json:2-4,13`；通过 `ELECTRON_RUN_AS_NODE=1` + Electron exe 做 ASAR 内只读检索，Host `read` 工具可直接读 ASAR 内文件）。

- `node_modules/@deepseek-ai/dsh-mcp-client/README.md:12,28,55-71,74-96,101-105,157,193-209,225-237`
- `node_modules/@deepseek-ai/dsh-mcp-client/src/transport.ts:31-45`
- `node_modules/@deepseek-ai/dsh-mcp-client/src/tools.ts:54-97,126-188,327-339,487-537`
- `node_modules/@deepseek-ai/dsh-mcp-client/package.json:51-55`
- `node_modules/@deepseek-ai/dsh-mcp-manager/README.md:12,36-82,108-110`
- `node_modules/@deepseek-ai/dsh-credentials-local/README.md:93-109`
- `node_modules/@deepseek-ai/dsh-tool-executor-ptc/README.md:12,37-41,57-67,99-113,136-138`
- `node_modules/@deepseek-ai/dsh-ptc-runtime/README.md:28-32,45,73`
- `node_modules/@deepseek-ai/dsh-ptc-runtime-node/README.md:12,34-52,68-72`
- `node_modules/@deepseek-ai/dsh-base/cordis.patch.yml:407-411,522-524`
- `node_modules/@deepseek-ai/dsh-web-app/presets/ptc.patch.yml:127-128`
- `node_modules/@deepseek-ai/dsh-client-hmr/README.md:12,32,103,118`
- `<DSH_HOME>\profiles\desktop\cordis.patch.yml:93-102`（模型配置）、`:277-286`（已有 Linear streamable-http 例证，含明文 token，勿照抄）、`:342-346`（agent-loop 并发）
- `<DSH_HOME>\profiles\desktop\cordis.yml:1-4`（profile 由 patch 组合）

**网关侧**：

- `<repo>\README.md:7-17,56-63`
- `<repo>\AGENTS.md:8-13`
- `<repo>\CONTRACT.vercel.md:8,15-33,83-96`
- `<repo>\src\codemode.js:885-919`
- `<repo>\src\vercel-app.js:133-144`
- `<repo>\CONTRACT.md:72,91`

**官方文档/技能**：`dsh-doc` 技能 `references/mcp-bundle.md:3-5`（配置式 MCP bundle 用 `transport: streamable-http`）、`references/locate-docs.md:23-27,64-66`（Desktop ASAR 读取方式）。

---

## 9. 需要向 lead 强调的两点

1. **不要把"DSH 有原生 PTC"误读成"网关没价值"**：网关把 424 个上游工具压成 3 个工具定义（README `:3,63`），这在 DSH 侧同样省上下文；DSH 原生 PTC 解决的是另一种场景（本地工具编排）。两者可共存，但建议不同时开启网关 Code Mode 与 DSH PTC preset。
2. **不要复制现有 Linear 条目的明文 token 写法**：本机 `cordis.patch.yml:286` 把 Bearer token 直接写在配置里；新接入应使用 `${credential:REF}` + `expandTemplates: true`，token 存 DSH 凭据文件或环境变量。

---

## 10. 风险与未验证项

- **未实测**：没有在 DSH 里实际发起一次网关 `execute` 调用（本次严格只读）。模型写 code 的稳定性、网关 sandbox 与 DSH 60s 默认超时的实际配合，需要 MVP 阶段验证。
- **未验证**：DSH 的 `dsh-mcp-client` 对网关 OAuth 元数据/well-known 是否有任何隐式探测——从 `src/transport.ts` 看没有，只有 `new URL(config.url)` + headers，但端到端仍建议用 `__dsh__` probe 或直接连一次确认。
- **未验证**：线上网关 token 的实际有效期与 refresh 流程在 DSH 静态 header 模式下的表现；若 access token 短期过期，方案 A 的"手工轮换"会很快变得不可接受，应直接上方案 B（本地 OAuth 代理）。
- **版本敏感**：以上结论针对 `0.2.2-rc.5`。DSH 升级后 `dsh-mcp-client` 配置字段或 PTC 默认状态可能变化，接入前复核对应 README。
