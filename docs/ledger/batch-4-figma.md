# B4 · 第五个上游：Figma

> 2026-11-22。前四个（GitHub/Notion/Linear/Vercel）走过的流程：B0-B3 三阶段门控 +
> `UNNEEDED-TOOLS.md` 的 deny 收口 + 191 条任务覆盖/重测。Figma 是第五个上游，
> 目前只完成"接入 + 工具收口 + 本地端到端"，**任务覆盖与重测尚未做**，按台账
> 规则登记为欠账，不冒充已通过 B1/B3。

## 评审（2026-11-22）：有条件通过 → 条件已闭环

独立窗口审 `docs/WORKFLOW.md` 给出 conditional pass，两条条件：

1. **证据必须入库、换人可复核**：Figma 50/46 的 `tools/list` 原始证据此前只在 gitignored 的
   `work/`，`data/tool-dataset.json` 中 figma=0；换人 clone 只能看到 deny=4。
2. **G2 deny 对照需脚本化**：不能靠人工对照官方 Tools 文档。

整改结果：

- ✅ `data/tool-snapshots/figma.json` 已入库（50 工具，live `tools/list`，capturedAt 记录）；
  `data/tool-dataset.json` 已同步为 506（四个旧上游 456 + Figma 50）。
- ✅ `check-config` 现在输出每个 server 的 `total/exposed/denied`；Figma 为 50/46/4。
- ✅ `scripts/audit-tools.mjs` + `data/official-tools/figma.json` +
  `data/tool-policy/figma.json`：官方 44 工具 vs snapshot 50（6 extras 均有声明）vs deny 4，
  自动 diff 通过；缺快照时按设计 exit 2。
- ✅ 本地凭据 vault：Figma access/refresh token 存于
  `D:\12412\dsh-home\.secrets\gemini-mcp-gateway\figma-oauth.json`；一次授权后
  `scripts/figma-token.mjs` 自动 refresh，不再每个窗口要授权。Vercel CLI auth 已备份到 vault。
- ✅ token 强刷实测通过（refresh 后同步回 Vercel sensitive env 并 redeploy）。

## SCENARIO（测评场景）

- 官方 Figma MCP 暴露 50 个工具（2026-11-22 实测），deny 4 个 ChatGPT/UI 内部工具后保留 46 个；18 个 Weave/Shader/Generative plugin 按"存疑放行"保留。
- 任务集：**0 条**。Figma 官方文档有示例 prompt（design-to-code、发 UI 到 Figma、
  生成 FigJam 等），可作为权威来源；schema 驱动任务也还没生成。
- 覆盖度：0/46，**未通过 B1**。不把"本地能建一个文件"当成场景覆盖。

## ROOT / FIX（问题与修复）

| 项 | 内容 | 证据 |
|---|---|---|
| 认证 | Figma 只允许目录内 client（`mcp:connect` scope）；采用社区 workaround：DCR 注册为 `client_name: "Codex"`、授权 URL **不带 scope 参数**，token 生命周期 90 天 + refresh | 本地实测 `tools/list` 50 个；`create_new_file` 成功 |
| 工具收口 | 第一版按名字猜了 22 个 deny（含 Weave/Shader/Generative plugin），复核官方 Tools 文档后判定为**误伤**：最终只 deny 4 个不在官方工具清单里的 ChatGPT/UI 内部工具；18 个存疑项全部放行 | `config.example.json`；`check-config` 显示 deny=4；`docs/UNNEEDED-TOOLS.md` 纠错记录 |
| 保留 | 46 个：建文件/`use_figma`/design-to-code/Code Connect/评论/变量/FigJam/图片/视频/Weave/Shader/Generative plugin 等；**写工具没有因为是写操作被删**，与四个旧上游原则一致 | 官方 Tools 文档 + 工具清单 |
| 凭据 | token 只存在 Vercel sensitive env；仓库无 token；`.vercelignore` 排除 `work/` | 部署记录 |

## TEST（验证）

- `node scripts/check-config.mjs config.example.json` → config OK；figma `total=50 exposed=46 denied=4`。
- `node scripts/audit-tools.mjs --server figma` → total=50 exposed=46 denied=4 official=44，6 个 extras 已声明/deny，exit 0。
- `node scripts/figma-token.mjs refresh` → 强刷成功；新 token 已同步 Vercel env 并 redeploy。
- `npm test` → 327/327。
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

1. 20-30 条 Figma 任务覆盖 46 个保留工具（28 核心 + 18 存疑放行；官方 prompt + schema 驱动），按 B1 权威等级标注。
2. Figma 加入 `measure-context` 与 `eval-search` 的口径（当前统计仍是 4 上游 456 工具）。
3. B3 式全量重测，并核实线上（带客户端 token）实际调用。
4. 若 Figma 封禁 workaround，降级到 Framelink PAT（只读）或等待目录开放。
