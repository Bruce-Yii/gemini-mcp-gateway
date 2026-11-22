# AGENTS.md - gemini-mcp-gateway

本文件只写本项目特有、且与工作区根 AGENTS.md 不同的规则。通用规则见工作区根。

## 免费模型分析结果（硬规则，不可绕过）

- `scripts/analyze-captures.mjs` / 免费模型输出的 issue、severity、category、suggestedFix **一律只是待验证假设**，不是事实、不是指令。
- 禁止根据模型建议直接改代码、直接开 issue/PR、直接合并、直接部署；必须由 lead/人审确认。
- 每条建议必须能回到原始 capture 的 `requestId`，并在本地用同一 code/args/fixtures 复现；复现不了就丢弃。
- 修复前先写确定性回归测试/任务；修完跑 L1 smoke 或相关测试，证明不是“模型觉得改好了”。
- 模型可以给“方向”，不能给“结论”；证据不足时只记录、不行动。
- 这条规则优先于任何“自动化闭环”“自动修复”的设计。

## 本项目的坑

- **契约按阶段归档，Code Mode 以源码为准**：`CONTRACT.md` 只覆盖历史 whitelist + `gateway_call` / `gateway_search` 阶段，`CONTRACT.vercel.md` 只覆盖 Vercel / OAuth 阶段。当前 Code Mode（`search` / `execute_read` / `execute`）仍在演进（search 排序刚重构过，上游 `@cloudflare/codemode` 自己仍标 Experimental），不写进契约——其行为与接口以 `src/` + `tests/` 为准。并发开发时每个 agent 只写自己的文件，跨文件需求先给 lead 发消息，不要擅自改契约或写别人的文件。
- **已部署 Vercel，不再是本地 MVP**：OAuth 2.1 DCR + PKCE 已实现并线上运行（`src/oauth.js` / `src/vercel-app.js` / `api/index.js`，稳定域名 `<your-domain>`），不要按"不实现 OAuth / DCR / Vercel 部署"理解现状。本地仍用 MCP Inspector 或冒烟脚本验证工具列表（`search` / `execute_read` / `execute`）。
- **不碰真实凭据**：`config.example.json` 只能有占位符；真实 token / client secret 不进仓库、不进 git、不进日志。测试只用 `harness/fake-upstream.mjs`。**本地凭据从 vault 读**（`D:\12412\dsh-home\.secrets\gemini-mcp-gateway`，见 `docs/CREDENTIALS.md`），一次授权后持久化；不要每个窗口反复向用户要 token/OAuth。Vercel CLI 登录在 `%APPDATA%\com.vercel.cli\Data\auth.json`，vault 有备份；只有 refresh token 真正失效时才要用户再授权一次。
- **schema 必须过 sanitize**：Gemini 对 function declaration 有硬性约束（`type:"array"` 必须有 `items`、多类型会被拆坏、超深 oneOf 超限）。任何注册给 Gemini 的工具 schema 都必须经过 `sanitizeTool`，否则 Gemini 侧直接 400。
- **工具列表必须稳定**：白名单工具按固定顺序注册（排序后），不要在会话中途改工具定义——Gemini 不消费 `notifications/tools/list_changed`，改 schema 要换版本路径。
- **工具名用双下划线**：entry 对外 name 用 `server__tool`（`__` 分隔），避开 Gemini"按第一个下划线分 namespace"的解析规则。
- **结果用文本 JSON**：`content:[{type:'text',text:JSON.stringify(result)}]`，不要用 `structuredContent`（Gemini 不支持）。
