# 部署交接文档（给 Vercel 窗口）

本仓库是给 Gemini 网页版自定义连接器用的 MCP 网关。本窗口已把代码全部写好并推到 GitHub；**请用你的 Vercel 窗口照下面步骤导入部署**，部署完成后回到本窗口，把部署后的 URL 给我，我做联调测试。

## 一句话背景

Gemini 通过 OAuth + DCR 连本网关的 `/mcp`，网关把 GitHub（只读）等上游 MCP 的几十个工具收敛成"白名单工具 + gateway_call 兜底"。GitHub token 由网关代持，从环境变量读，不进文件。

## 部署步骤

### 1. 从 GitHub 导入

- Vercel → Add New → Project → Import 这个仓库。
- Framework Preset：**Other**（`vercel.json` 里 `framework: null`）。
- Root Directory：默认（仓库根，含 `api/index.js` 和 `vercel.json`）。
- Build Command / Output Directory：留默认（`vercel.json` 已配）。
- 直接 Deploy。**先别填环境变量也没关系**，但此时 `/mcp` 会因缺 KV 而报错——下一步配好即可。

### 2. 添加 KV 存储（关键）

Gemini 的 OAuth 授权需要持久化 client/code/token。用 Vercel Marketplace 免费 KV：

- 项目 → Storage → Create Database → 选 **Upstash Redis**（或 Marketplace 里的 KV，免费层）。
- 创建后 Vercel 会自动把 `KV_REST_API_URL`、`KV_REST_API_TOKEN` 注入到项目环境变量。
- **确认这两个变量已出现在 Environment Variables 里**（所有环境 Production/Preview/Development 都勾上）。

### 3. 配环境变量

在项目 → Settings → Environment Variables 添加：

| 变量 | 值 | 说明 |
|---|---|---|
| `GITHUB_TOKEN` | GitHub token | 网关代持的 GitHub 凭证。**从我这个窗口给的临时值填入**（或你自己生成一个 fine-grained PAT）。只读端点只需 repo 读权限。 |
| `PUBLIC_BASE_URL` | 部署后的域名 | 如 `https://xxx.vercel.app`（不带尾斜杠）。若留空，代码会从请求 host 推导。建议显式填。 |
| `GATEWAY_CONFIG` | 可选 | 若不用仓库里的 `config.example.json`，可传一段 JSON 字符串覆盖 server 配置。一般不用填。 |
| `UPSTREAMS_JSON` | 可选 | 直接传 server 配置数组 JSON。一般不用填。 |

> ⚠️ `GITHUB_TOKEN` 是敏感值：Vercel 里勾 "Sensitive"（若可选），不要写进任何文件或提交。

### 4. 重新部署

配完环境变量后，项目 → Deployments → 点最新一次 → Redeploy（勾 "Use existing Build Cache" 即可）。

### 5. 验证部署

浏览器打开（把 `<BASE>` 换成你的域名）：

- `https://<BASE>/.well-known/oauth-authorization-server` → 应返回一段 JSON（含 `registration_endpoint` 等字段），**不能是 404**。
- `https://<BASE>/.well-known/oauth-protected-resource` → 应返回 JSON。
- `https://<BASE>/mcp` → 应返回 401（无 token），且响应头有 `WWW-Authenticate`。

三项都符合就说明 HTTP 层正常，把 `<BASE>` 发给我，我做完整 OAuth 握手 + 工具列表测试。

### 6. Gemini 侧填写（联调通过后）

- `gemini.google.com` → Settings → Connected Apps → Custom apps → Add
- MCP server URL 填 `https://<BASE>/mcp`
- Client ID / Client Secret **留空**（网关支持 DCR，Gemini 会自动注册）
- Next → 同意授权 → Connect

## 已知约束 / 注意

- 要求个人 Google 账号、18+、美国、History 开启、英文界面——这是 Gemini 侧限制，与部署无关。
- GitHub 用只读端点 `https://api.githubcopilot.com/mcp/readonly`，网关白名单只放行读工具。
- Notion 暂未接入（缺 token + 需单独 OAuth），后续再加。
- 网关工具列表是静态快照，Gemini 不消费 `notifications/tools/list_changed`；改工具要换新版本路径（如 `/mcp/v2`）。

## 出问题怎么定位

- `/mcp` 返回 401 但没有 `WWW-Authenticate`：检查 `PUBLIC_BASE_URL` 是否填对。
- DCR 注册报 "redirect URL was rejected"：后端必须接受 >=6 个 Google redirect URI（代码已实现，确认部署的是最新 commit）。
- 授权后 `/token` 永不到达：同意页 CSP 拦了 Google relay 二次跳转——代码已用 meta refresh 规避，确认版本。
- 连不上 KV：确认 Upstash 的两个环境变量在所有环境下都注入了，并且 Redeploy 过。

## 本窗口能提供的

- GitHub 仓库地址、最新 commit、真实 GitHub token（通过安全渠道给，不写文档）
- 部署后的联调测试、问题修复、代码更新并推送
- 你只需：导入部署、加 KV、填 `GITHUB_TOKEN` + `PUBLIC_BASE_URL`、把域名发我
