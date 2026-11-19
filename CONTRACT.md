# 接口契约（并发开发的唯一真相来源）

所有子代理必须严格遵守本文件的文件路径与导出接口，不得自行改接口名、不得写别人的文件。

## 项目目标

标准远程 MCP server（Node.js + `@modelcontextprotocol/sdk`），给 Gemini 网页版自定义连接器用。
把 GitHub / Notion 等上游 MCP 的几十个工具，收敛成：
- 白名单内的高频工具（完整 schema、固定顺序）——热路径
- `gateway_call(server, tool, args)` 兜底元工具——异常路径
MVP 阶段只本地跑通（假上游 + MCP Inspector 验证），不接 OAuth、不部署 Vercel。

## 文件清单与写权限（严格 disjoint）

| 文件 | 负责模块 | 允许写 |
|---|---|---|
| `src/catalog.js` | 工具目录 / BM25 搜索 / allow-deny | agent-catalog |
| `src/sanitize.js` | Gemini schema 清洗 | agent-sanitize |
| `src/upstreams.js` | 上游 MCP 客户端（连接 + tools/list + callTool） | agent-upstreams |
| `src/server.js` | MCP server 入口（注册白名单工具 + gateway_call） | agent-server |
| `tests/catalog.test.js` | catalog 单测 | agent-catalog |
| `tests/sanitize.test.js` | sanitize 单测 | agent-sanitize |
| `tests/server.test.js` | server 集成测试 | agent-server |
| `harness/fake-upstream.mjs` | 假上游 MCP server（stdio，模拟 GitHub/Notion 工具） | agent-server |
| `scripts/smoke.mjs` | 本地冒烟（连假上游 + 调 gateway_call） | agent-server |

其他文件（package.json / project.json / README.md / AGENTS.md / config.example.json / 本契约）由 lead 写，子代理不要碰。

## 导出接口

### `src/catalog.js`（从 `../dsh-mcp-gateway/src/catalog.js` 复制后按需微调，保持这些导出）
```js
export function tokenize(text) -> string[]
export function buildIndex(entries) -> index
export function searchEntries(entries, rawQuery, options?) -> {matches, total, hint?}
export function patternMatches(patterns, entry) -> boolean
export function isAllowed(serverConfig, entry) -> boolean
```
entry 形状：`{ server, tool, name, description?, inputSchema?, transport?, _client? }`
（`_client` 是上游客户端引用，不参与搜索/序列化）

### `src/sanitize.js`
```js
export function sanitizeInputSchema(schema) -> object
export function sanitizeTool(tool) -> {name, description, inputSchema, annotations}
```
规则：
- 递归保证每个 `type:"array"` 节点都有 `items`（缺失补 `{type:"string"}`），含 `anyOf`/`oneOf` 分支内
- 把 `type:["string","null"]` 这类多类型收敛为第一个非 null 类型
- 去掉 `oneOf` 中超过 8 个分支的（截断并加 description 提示），避免 Gemini 状态机超限
- 长数字 ID 保持 string（不强制转换，只是不新增 number）
- 工具名只保留 `[a-zA-Z0-9_-]`，非法字符替换为 `_`；超 63 字符截断
- `annotations` 显式补 `readOnlyHint`/`destructiveHint`/`openWorldHint`（默认 readOnlyHint=false, destructiveHint=true, openWorldHint=true，由调用方覆盖）
- 不修改入参对象（深拷贝）

### `src/upstreams.js`
```js
export class UpstreamManager {
  constructor(configs) // configs: [{name, transport:'stdio'|'http', command?, args?, url?, env?, allowTools?, denyTools?, headers?}]
  async connect() -> void   // 连接所有上游，拉 tools/list，填充 this.entries
  getEntries() -> entry[]   // 全量 entry（已按 allow/deny 过滤）
  getWhitelist() -> entry[] // 白名单工具（在 allowTools 里且未在 denyTools 里的）
  async callTool(server, tool, args) -> result  // 路由到对应上游 client
  async close() -> void
}
```
- 用 `@modelcontextprotocol/sdk/client/index.js` 的 `Client` + `StdioClientTransport` / `StreamableHTTPClientTransport`
- `transport:'http'` 时 url 必填；`'stdio'` 时 command/args 必填
- `connect()` 对每个上游：`client.connect(transport)` → `client.listTools()` → 逐条转 entry（name 用 `server__tool` 双下划线分隔，避免和 Gemini 的"第一个下划线分 namespace"冲突）
- allow/deny 用 `catalog.js` 的 `isAllowed`
- `callTool` 参数 server/tool 是原始名（不含前缀），内部查 this._clients map
- 错误要带上游名前缀，便于定位

### `src/server.js`
```js
// CLI: node src/server.js --config <path> [--port 3000 | --stdio]
// 导出（便于测试）:
export function createGatewayServer(upstreamManager, options?) -> McpServer
export async function startHttpServer(upstreamManager, port) -> http.Server
```
- 用 `@modelcontextprotocol/sdk/server/mcp.js` 的 `McpServer` + `StreamableHTTPServerTransport`
- 注册的工具：
  1. 白名单内每个工具一个独立工具，schema 经 `sanitizeTool` 处理
  2. `gateway_call`（description 说明用于白名单未覆盖时）：参数 `{server, tool, arguments}`，内部调 `upstreamManager.callTool`
  3. `gateway_search`（可选兜底）：参数 `{query, limit?}`，内部调 `searchEntries`
- `initialize` 的 instructions 写高层说明（"白名单工具可直接调用；未覆盖时用 gateway_call 或 gateway_search"），不要罗列工具名
- 工具注册顺序固定（白名单按 server+name 排序，再 gateway_call、gateway_search），保证 schema 稳定吃缓存
- 每个工具调用结果用 `content:[{type:'text', text: JSON.stringify(result)}]`，不用 `structuredContent`

### `config.example.json`（lead 写）
```json
{
  "maxWhitelistTools": 20,
  "servers": [
    {"name":"github","transport":"http","url":"https://api.githubcopilot.com/mcp/readonly","allowTools":["get_file_contents","list_issues","search_code"]},
    {"name":"notion","transport":"http","url":"https://mcp.notion.com/mcp","allowTools":["notion-search","notion-fetch"]}
  ]
}
```

## 测试约定
- `node --test tests/`，每个模块至少一个测试文件
- fake 上游用 stdio 的 `@modelcontextprotocol/sdk/server/mcp.js`，模拟 4-6 个工具（含 github 风格 + notion 风格）
- 测试不得访问真实网络、不得读真实凭据

## 硬规则
- 不把任何凭据写进仓库（config.example.json 里只能有占位符）
- 所有子代理只在自己的文件里写，跨文件需求通过本契约的接口解决，需要改契约先给 lead 发消息
- MVP 不实现 OAuth / DCR / 部署，只做本地可验证的 MCP server
