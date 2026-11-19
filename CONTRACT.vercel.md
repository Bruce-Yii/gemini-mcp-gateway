# Vercel / OAuth-DCR 阶段接口契约

本地 MVP 契约见 `CONTRACT.md`（保持不动）。本文件定义 Vercel 部署 + OAuth 授权服务器阶段的所有文件路径与导出接口。所有子代理严格遵守，只写自己的文件。

## 目标

把本地 MVP 变成可部署到 Vercel 的标准远程 MCP server，满足 Gemini 网页版自定义连接器的硬性要求：

- Gemini 通过 OAuth 2.1 + DCR 连网关；网关自身是 OAuth 资源服务器 + 授权服务器
- 上游 GitHub/Notion 的 token 由网关代持（从环境变量读，不进文件）
- 稳定工具列表 + schema sanitize（沿用 MVP 的 `server.js` / `sanitize.js` / `catalog.js` / `upstreams.js`，不重写）

## Gemini 侧硬约束（必须逐条满足）

1. 传输：单 `/mcp` endpoint，Streamable HTTP，JSON-RPC over POST；GET 流可回 405；协议版本 `2025-11-25`（至少兼容 `2025-03-26`）；识别 `User-Agent: Google`。
2. 元数据：
   - `/.well-known/oauth-authorization-server` 返回 200，含 `authorization_endpoint`、`token_endpoint`、`response_types_supported:["code"]`、`registration_endpoint`、`grant_types_supported`、`code_challenge_methods_supported:["S256"]`、`scopes_supported`。
   - `/.well-known/oauth-protected-resource`（RFC 9728）含 resource = `/mcp` URL、authorization_servers。
   - 401 的 `WWW-Authenticate` 指向 protected resource 元数据。
   - **第一个 well-known URL 必须返回 200，不能靠 404 回退猜路径**。
3. DCR `POST /oauth/register`：
   - `client_name:"Google"`，**接受 >=6 个 redirect URI**（覆盖 `oauth-redirect{,-sandbox,-test}.googleusercontent.com` 的 `/r/*` 与 `/a/*` 模式）。
   - `response_types:["code"]`、`grant_types:["authorization_code","refresh_token"]`、`token_endpoint_auth_method:"client_secret_post"`；支持 public client（无 secret）。
   - 注册结果持久化，做幂等（同一 redirect 集合重复注册返回同一 client）。
4. `GET /oauth/authorize`：PKCE S256；`state` 逐字节保留（~1400 字符，必须存得下）；单用户场景：一个"同意"页，POST 到本路由换 code。**注意 CSP**：不要设 `form-action 'self'`——Google relay 会二次跳转，被 CSP 拦会导致 302 后 `/token` 永不到达；用 200 + `<meta http-equiv=refresh>` 页面代替裸 302。
5. `POST /oauth/token`：
   - authorization_code：校验 `code_verifier`（PKCE S256）、server-side code 单次使用、client 绑定。
   - refresh_token：**发 refresh token 且不要轮换**（Gemini 长期连接需要持久化，轮换会导致重连）。
   - 返回 `access_token`、`token_type:Bearer`、`expires_in`、`refresh_token`。
6. `POST /oauth/revoke`：使 token 失效。
7. 存储：client / code / token 持久化到 Upstash Redis（通过 Vercel Marketplace 注入的 `KV_REST_API_URL` + `KV_REST_API_TOKEN`，用 REST 调用，无额外依赖）。key 用哈希，值里**不存明文 token**——存 token 哈希 + 索引（够用即可）；client secret 可选（public client 场景无需）。
8. 入站校验：`/mcp` 的所有 JSON-RPC 请求校验 `Authorization: Bearer <access_token>`；无 token → 401 + `WWW-Authenticate`。**复用 MVP 的 `server.js`，不要重写工具注册逻辑**。
9. 上游凭据：`GITHUB_TOKEN`（可选）、Notion 后续；config 用 `tokenEnv`（见 CONTRACT.md）。

## 文件清单与写权限（严格 disjoint）

| 文件 | 负责模块 | 允许写 |
|---|---|---|
| `src/store.js` | Upstash KV 存储适配（client/code/token 的 CRUD） | agent-auth |
| `src/oauth.js` | OAuth 授权服务器路由 + 元数据 + PKCE + DCR | agent-auth |
| `src/vercel-app.js` | Vercel HTTP 入口：路由分发（well-known / oauth / mcp）+ 入站 token 校验 | agent-auth |
| `api/index.js` | Vercel serverless 入口（薄 shim，export default handler，调用 vercel-app） | agent-auth |
| `vercel.json` | Vercel 配置（rewrites 全路由到 /api/index） | agent-lead(我) |
| `tests/oauth.test.js` | OAuth 路由单测（DCR 6 redirect、state、PKCE、token 不轮换） | agent-auth |
| `DEPLOY.md` | 交接文档（GitHub 仓库 → Vercel 导入 → Marketplace 加 KV → 环境变量 → Gemini 表单填写） | agent-lead(我) |

**其他文件（`src/catalog.js` `sanitize.js` `upstreams.js` `server.js` `config.example.json` `package.json` `README.md` 两个 CONTRACT）由 lead 维护，子代理不要碰。**

## 导出接口

### `src/store.js`
```js
export class TokenStore {
  // 基于 Upstash Redis REST（fetch），环境变量 KV_REST_API_URL / KV_REST_API_TOKEN
  async saveClient(clientId, record) -> void       // TTL 可设长
  async getClient(clientId) -> record | null
  async saveCode(code, record) -> void             // 短 TTL（~10min），单次使用
  async takeCode(code) -> record | null            // 原子取并删（防重放）
  async saveToken(token, record) -> void
  async getToken(token) -> record | null
  async saveRefresh(refreshToken, record) -> void  // 不轮换
  async getRefresh(refreshToken) -> record | null
  async revokeToken(token) -> void                // 标记失效/删除
}
```
- 所有方法在无 KV 环境变量时抛出明确错误（部署前校验）。
- 提供 `isConfigured()` 静态方法便于启动检查。

### `src/oauth.js`
```js
export function createOAuthHandlers(store, options) -> {
  metadata(req,res), protectedResource(req,res), register(req,res),
  authorize(req,res), token(req,res), revoke(req,res)
}
```
- `options`: `{ baseUrl, mcpUrl }`（从 `VERCEL_URL` 或请求 host 推导，允许环境变量 `PUBLIC_BASE_URL` 覆盖）。
- redirect URI 校验：用**模式匹配**——解析出每个 URI 的 origin，允许 `https://oauth-redirect{sandbox,test,}.googleusercontent.com` 三种 host 的 `/r/*` 与 `/a/*` 路径；至少存 6 个；拒绝其他 host（防开放重定向）。
- state：`req.url` query 里的 state 原样存进 code record，`/token` 返回时不改（实际上 state 只在 authorize 回跳时用，token 响应不含 state——按 OAuth 规范即可，但**authorize 回跳 redirect 时必须原样带 state**）。
- PKCE：authorize 存 `code_challenge` + method；token 时 `sha256(base64url(code_verifier)) === code_challenge` 才发 token。
- 单用户同意页：authorize GET 返回 HTML 表单（含隐藏 state/code_challenge/redirect_uri/client_id），POST 后生成 code 并 302（或 meta refresh）回 redirect_uri?code=&state=。
- token 不轮换：refresh grant 返回**同一个 refresh token**（或新的但旧的仍有效）即可；优先同一。

### `src/vercel-app.js`
```js
export function createAppHandler(options?) -> async (req, res) => void
```
- 读 `process.env.KV_REST_API_URL/TOKEN` 建 TokenStore；建 oauth handlers。
- 路由：
  - `GET /.well-known/oauth-authorization-server` → oauth.metadata
  - `GET /.well-known/oauth-protected-resource` → oauth.protectedResource
  - `POST /oauth/register` → oauth.register
  - `GET|POST /oauth/authorize` → oauth.authorize
  - `POST /oauth/token` → oauth.token
  - `POST /oauth/revoke` → oauth.revoke
  - `/mcp` → 先校验 `Authorization: Bearer`，无 token 回 401 + WWW-Authenticate 指向 protected resource；有 token 则 FALLTHROUGH——**本文件不自己处理 MCP 协议**，而是把 req 交给由 `createGatewayServer` 产生的 MCP HTTP handler。
- MCP handler 复用：从 `src/server.js` 导入 `createGatewayServer`；参考 MVP 的 `startHttpServer`（`src/server.js`）里对 StreamableHTTPServerTransport 的用法，抽出一个可复用的 `handleMcpRequest(req,res)`（**放在 src/server.js 里由 lead 导出，子代理不重写 server.js**）。契约：lead 会在 `src/server.js` 额外导出 `createMcpRequestHandler(upstreamManager)` → `(req,res)=>Promise<void>`，子代理直接用。

### `api/index.js`
```js
import { createAppHandler } from '../src/vercel-app.js';
const handler = createAppHandler();
export default async (req, res) => handler(req, res);
```
- Vercel Node serverless：req/res 是 Node http 对象；body 已在 req（StreamableHTTPServerTransport 能读）。
- 注意：`src/server.js` 的 `startHttpServer` 用 `node:http`，Vercel 也支持；但要确保 handler 形态是 `(req,res)`。

## Lead 负责的额外改动

- `src/server.js`：在保留现有导出的前提下，新增 `export function createMcpRequestHandler(upstreamManager)`，复现 `startHttpServer` 里的 session 管理 + transport 逻辑但返回 `(req,res)=>Promise<void>`（不 listen）。`startHttpServer` 内部改为复用它。
- `vercel.json`、`DEPLOY.md`、`package.json`（加 scripts）。

## 硬规则

- 子代理只写自己文件；跨文件需求发消息给 lead。
- 不访问真实网络、不碰真实凭据、不在输出里打印 token。
- 凭据只从环境变量读（KV_* / GITHUB_TOKEN / PUBLIC_BASE_URL）。
- 不修改本地 MVP 已通过的测试与模块（catalog/sanitize/upstreams/server 的核心逻辑）。
