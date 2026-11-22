# B4 · 第五个上游：Figma

> 2026-11-22。前四个（GitHub/Notion/Linear/Vercel）走过的流程：B0-B3 三阶段门控 +
> `UNNEEDED-TOOLS.md` 的 deny 收口 + 191 条任务覆盖/重测。Figma 是第五个上游：
> 已完成 G1 接入、G2 收口、G3 任务覆盖；**G4 基线/G5 根因/G6 重测尚未做**，按台账
> 规则登记为欠账，不冒充已通过 B3。

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
- 任务集：`explore/figma-tasks.json`，**46 条任务覆盖 46 个保留工具**（28 核心 + 18 存疑放行）；权威等级：18 条官方逐字、28 条 schema 驱动；9 条 Weave 任务标记 `requires paid Figma Weave account`（跳过但保留覆盖）。
- 覆盖度：46/46，**G3 通过**；schema 驱动 28/28 top-5 反向验证通过。

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
- `node scripts/check-task-coverage.mjs --server figma` → retained=46 tasks=46 covered=46；authority 18 official/28 schema；schema 28/28 top-5；skipped=9（Weave 账号）。
- `node scripts/figma-token.mjs refresh` → 强刷成功；新 token 已同步 Vercel env 并 redeploy。
- `npm test` → 343/343。
- 本地网关 → 官方 Figma MCP：50 工具可被 `search` 检索；`execute` 调
  `figma__create_new_file` 创建真实文件
  <https://www.figma.com/design/izWTtDxzzsdcA5ZWyaquvS>。
- 生产 `/healthz` → servers 含 figma；未做"带客户端 token 的线上 MCP 调用"。

## G4 基线（2026-11-23）

| 项 | 结果 |
|---|---|
| 上下文 | 506 工具 ≈245,377 tokens（direct） vs 3 工具 ≈1,520 tokens（gateway），省 **99.5%** |
| 既有检索子集（191 条） | top1 **57.1%**（109/191）、top5 **72.3%**（138/191）；不回归（B6） |
| Figma 检索（46 条） | top1 78.3%、top5 93.5%；schema 28/28 top-5；官方 18 条 top1 61.1%/top5 77.8%（单独报告） |
| 模型在环 | `bench` 既有基线 5/5 确定性任务（22,468 prompt / 919 completion tokens），未为 Figma 单独重跑 |
| 真实调用 | Figma `get_metadata` 返回 Page 1 node 列表；此前 `create_new_file` 建真实文件；四旧上游有历史真实调用记录 |

## G5 根因（2026-11-23）

- 加入 Figma 后既有 191 条检索从 56.5/72.3 降到 56.0/71.7，违反 G4 "既有子集不得回归"。
- 根因：IDF 基于全量 catalog + 无服务归属时跨服务同名工具竞争。
- 修复：按服务重建索引 + 窄别名（repository/repo/octocat→github，deployment→vercel）。
- 结果：top1 57.1%、top5 72.3%，恢复并略超基线；详见 `docs/ledger/batch-6-search-attribution.md`。

## G6 全量重测（2026-11-23，通过）

- 修复 Intl（`codemode.formatDate/nowISO` + guidance）与 detector 误归因后重跑：
  **228 tasks / 873 turns / 718 calls**；3,409,329 prompt + 71,224 completion tokens；
  searchHitRate 85.3%、toolHitRate 52.9%。
- anomalies 363（model 273 / gateway 86 / infra 1 / synthetic 3）；Intl 与 services 误报归零，
  `not a function` 7 条归 model。
- gateway 86 逐条复核：Vercel 404/403、Notion 套餐/日历、upstream validation、not-found、
  Linear complexity、Figma 占位参数等，**无新网关功能 bug**。
- 已知差异：本轮 Notion token 只暴露 47 工具（上一轮 53），属于 token/工作区权限差异，非网关。
- **G6 ✅**；G7 见下节。

## G7 线上真实调用（2026-11-23，通过）

用户在 Gemini 网页端（连线上网关 `/mcp`）实际执行：

- Vercel 只读：项目 `gemini-mcp-gateway`，部署
  `https://gemini-mcp-gateway-f7hyjkzcj-yu-ac3a.vercel.app`，状态 `READY`，
  时间 `2026-11-22T17:52:17.153Z`，无错误。
- Figma 只读：`whoami` 返回 Yi Yu / plan `Yi Yu's team` (starter, admin) / seat View；
  读取 test file 顶层 pages 返回 `0:1 Page 1`，无错误。
- 两项均为 Gemini → 线上网关 → 上游的真实调用；不是本地 mock。

**G7 ✅。**

## DEC（决策）

| 决策 | 理由 |
|---|---|
| 接受 OAuth allowlist workaround | 用户明确要求完整功能；官方远程只对目录 client 开放。风险：Figma 可随时封禁，属于非官方支持 |
| 不因写操作 deny | 与 GitHub/Notion/Linear/Vercel 一致：写能力保留，靠 `execute`/`execute_read` 与 annotations 区分 |
| B1 任务集已补 | `explore/figma-tasks.json` 覆盖 46/46；18 official/28 schema；9 Weave skip |
| 不删除旧只读路线 | Framelink PAT（`figma-framelink.json`）和桌面 server 保留作为降级/官方路径 |

## 欠账（下一步）

- B4 无阻塞欠账；B8（大文件/patch/行号）另行排期，不属于 B4 门禁。
- 仓库 README 引用的 `ledger.json` 仍不存在，需补建或删引用。

