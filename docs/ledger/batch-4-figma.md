# B4 · 第五个上游：Figma

> 2026-11-22。前四个（GitHub/Notion/Linear/Vercel）走过的流程：B0-B3 三阶段门控 +
> `UNNEEDED-TOOLS.md` 的 deny 收口 + 191 条任务覆盖/重测。Figma 是第五个上游，
> 目前只完成"接入 + 工具收口 + 本地端到端"，**任务覆盖与重测尚未做**，按台账
> 规则登记为欠账，不冒充已通过 B1/B3。

## SCENARIO（测评场景）

- 官方 Figma MCP 暴露 50 个工具（2026-11-22 实测），deny 后保留 28 个。
- 任务集：**0 条**。Figma 官方文档有示例 prompt（design-to-code、发 UI 到 Figma、
  生成 FigJam 等），可作为权威来源；schema 驱动任务也还没生成。
- 覆盖度：0/28，**未通过 B1**。不把"本地能建一个文件"当成场景覆盖。

## ROOT / FIX（问题与修复）

| 项 | 内容 | 证据 |
|---|---|---|
| 认证 | Figma 只允许目录内 client（`mcp:connect` scope）；采用社区 workaround：DCR 注册为 `client_name: "Codex"`、授权 URL **不带 scope 参数**，token 生命周期 90 天 + refresh | 本地实测 `tools/list` 50 个；`create_new_file` 成功 |
| 工具收口 | `denyTools` 22 个：ChatGPT/UI 内部 4（`authorize_mcp_app`、`open_figma_mcp_app`、`open_figma_mcp_app_in_thread`、`get_profile_for_chatgpt`）、Figma Weave 9、shader 5、generative plugin 4 | `config.example.json`；`check-config` 显示 deny=22 |
| 保留 | 28 个：建文件/`use_figma`/design-to-code/Code Connect/评论/变量/FigJam/图片/视频等；**写工具没有因为是写操作被删**，与四个旧上游原则一致 | 工具清单 |
| 凭据 | token 只存在 Vercel sensitive env；仓库无 token；`.vercelignore` 排除 `work/` | 部署记录 |

## TEST（验证）

- `node scripts/check-config.mjs config.example.json` → config OK，figma deny=22。
- `npm test` → 308/308。
- 本地网关 → 官方 Figma MCP：50 工具可被 `search` 检索；`execute` 调
  `figma__create_new_file` 创建真实文件
  <https://www.figma.com/design/izWTtDxzzsdcA5ZWyaquvS>。
- 生产 `/healthz` → servers 含 figma；未做"带客户端 token 的线上 MCP 调用"。

## DEC（决策）

| 决策 | 理由 |
|---|---|
| 接受 OAuth allowlist workaround | 用户明确要求完整功能；官方远程只对目录 client 开放。风险：Figma 可随时封禁，属于非官方支持 |
| 不因写操作 deny | 与 GitHub/Notion/Linear/Vercel 一致：写能力保留，靠 `execute`/`execute_read` 与 annotations 区分 |
| 暂不做 B1 任务集 | 先完成接入与收口；任务覆盖是下一步欠账，不能宣称已过 B1 |
| 不删除旧只读路线 | Framelink PAT（`figma-framelink.json`）和桌面 server 保留作为降级/官方路径 |

## 欠账（下一步）

1. 20-30 条 Figma 任务覆盖 28 个保留工具（官方 prompt + schema 驱动），按 B1 权威等级标注。
2. Figma 加入 `measure-context` 与 `eval-search` 的口径（当前统计仍是 4 上游 456 工具）。
3. B3 式全量重测，并核实线上（带客户端 token）实际调用。
4. 若 Figma 封禁 workaround，降级到 Framelink PAT（只读）或等待目录开放。
