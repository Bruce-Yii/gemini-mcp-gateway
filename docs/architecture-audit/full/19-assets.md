# 19 — 资产逐文件审计：explore/ · data/ · templates/ · examples/

> 只读审计。没有写代码、没有 commit/push/deploy。
> 审计时间：2026-11-24（Asia/Singapore）。框架基线：[docs/FRAMEWORK.md](../../FRAMEWORK.md)。
> 本文只写这 4 个目录；`src/`、`scripts/`、`tests/`、README、其他 docs、workflows 均未改动。
>
> 标注约定：**[数据]** = 数据集/任务集/快照；**[模板]** = 可复制的配置或部署样例；**[未验证]** = 文档宣称但本次未实测（没有运行部署、没有跑任务、没有连上游）。
> 证据不足的地方明确写"未验证/未知"，不编造。

---

## 0. 清单完整性（硬要求 1）

`git ls-files explore data templates examples` 输出 **68 个文件**：

- `explore/`：22
- `data/`：9
- `templates/`：33
- `examples/`：4

**expected = 68；read（实际打开阅读）= 68；unread = 0。**

"read" 的口径：用 read 工具真实打开文件正文，不是只看文件名或 grep。对超大文件另加说明：

- `data/tool-dataset.json`（41,439 行）：read 工具逐页读到约 L17,980，并对全文件做了 `ConvertFrom-Json` 全量解析 + 全文规则扫描；剩余行未逐行肉眼读，标记为 **分页读取 + 全量解析**（见 §2）。
- `data/tool-snapshots/vercel.json`（26,517 行）：read 工具逐页读到约 L25,059（约 95%），同样做了全量解析 + 全文扫描；标记为 **分页读取 + 全量解析**。
- 其余 66 个文件：逐文件打开；小文件读到 EOF，大 JSON 用 offset/limit 分页读到 EOF。

没有二进制/图片文件；68 个全部是 UTF-8 文本（`.json` / `.mjs` / `.js` / `.md` / `.toml` / `.yml` / `.conf` / `.example` / `.env.example`），无需核图片类型。

---

## 1. explore/ — 22 个文件（[数据] + 脚本）

### 1.1 总用途与来源链

`explore/` 是**离线评测资产工厂**：把各 MCP 官方文档任务 → 全工具覆盖任务 → 合并/派生/改写 → L1 smoke 子集 → 线上缺口任务（N1–N9 / J1–J6），并提供 runner/harness 与异常分析脚本。对应 FRAMEWORK 模块三（评测体系）与模块四（上游 SOP 的"官方/权威任务集"）。

来源链（由脚本元数据与源码证实）：

```
build-tasks.mjs → tasks.json (69)
merge-deep.mjs  ← work/deep-{server}.json → tasks-deep.json (191)
merge-final.mjs ← work/deep-* + work/re*   → tasks-final.json (191)
merge-regen.mjs ← tasks-final + work/regen-* → tasks-v2.json (191)
figma-tasks.json (46) + tasks-v2.json → tasks-g6.json (228, skipped 9)
select-smoke.mjs ← tasks-g6.json → tasks-smoke.json (50)
tasks-online-gap.json (N1–N9) / tasks-online-gap-2.json (J1–J6) ← docs/eval/*
```

注意：`work/*.json` 输入（deep-/re-/regen-）不在本次 4 目录内，且多数被 gitignore；本文**未验证**这些中间产物的当前可用性。

### 1.2 逐文件表

| # | 路径 | 类型 | 用途 / 内容 | 风险 / 证据 |
|---|---|---|---|---|
| 14 | `explore/README.md` | [数据] 文档 | 探索式测试说明。明确 11 类 anomaly（`tool_error`/`execute_error`/`infra_error`/`search_empty`/`model_confusion`/`token_anomaly`/`runner_error`/`max_turns_exceeded`/`direct_answer`/`retry`/`no_tool_call`），并列出**未实现**的 detector（`wrong_tool`、`search_irrelevant`、`result_too_large`、`truncated`、`timeout`、`no_result`）。MCPMark 金标小节：只用 `description.md` 做权威 prompt，明确 `verify.py` 跑不通（依赖 MCPMark 临时 eval org）。 | 诚实标注：`work/full-audit.md` #21–#23 的归因误标被写进 README，避免高估覆盖率。无凭据/私有路径。 |
| 15 | `explore/analyze.mjs` | [数据] 脚本 12 行 | 读 `explore/results/anomalies.json`，按 type/server 汇总打印前 6 条样例。 | 依赖 gitignored 的运行产物；无敏感值。 |
| 16 | `explore/analyze2.mjs` | [数据] 脚本 100 行 | 读 anomalies，按 attribution×type×server 汇总；只用 `attribution==='gateway'` 作为可行动缺陷；区分 model/harness/synthetic/expected/infra。 | 无敏感值；强调归因隔离，符合 AGENTS §1（模型输出只是假设）。 |
| 17 | `explore/baselines/l1-smoke.json` | [数据] 基线 | **唯一运行时基线源**。顶层 REAL baseline 来自 2026-11-22 G6 全跑（run `6b4254c` / `run-1795368949291-1d86ee2a`），50 smoke 任务：completionRate 76、gatewayAnomalyCount 21、searchHitRate 86.4、toolHitRate 51.3、tokensPerTask 15691、p95LatencyMs 22025。`byServer` 5×10 任务快照；`serverSets` 精确 40 任务快照（无 Figma）；`fake` 段是确定性全通过 wiring check，明确不是网关测量。阈值容差：completionRate min-10%、gatewayAnomalyCount max+3、searchHitRate/toolHitRate min-10%、tokensPerTask max+3000、p95 max+15000ms。 | 基线冻结于 2026-11-22，明确**不得运行时从 `explore/results/*` 重新推导**（防自引用）。`p95LatencyMs` 是毫秒不是 token；报告未把它换算成 token/p95 成本。无凭据。 |
| 18 | `explore/build-tasks.mjs` | [数据] 脚本 94 行 | 69 条官方任务生成器（GitHub 18、Notion 15、Linear 16、Vercel 20），分类 read/write/cross/boundary，带 prompt injection 与 secret 泄露边界任务。 | **个人 repo 出现**：`Bruce-Yii/gemini-mcp-gateway`（L21、L27），属于真实感个人 GitHub 归属。OSS 发布前应中性化。 |
| 19 | `explore/deep-dive.mjs` | [数据] 脚本 21 行 | 读 anomalies，按 tool_error 根因（enum/param/auth/schema）与 retry by tool 汇总。 | 无敏感值。 |
| 20 | `explore/figma-tasks.json` | [数据] 46 任务 | Figma 全工具覆盖任务：18 official-verbatim + 28 schema-reverse，9 条付费 Weave 工具标 `skipReason: "requires a paid Figma Weave account"`。来源均为 Figma help 文章 URL。 | **具体资源 ID**：37 条 `preconditions` 含 `test fileKey izWTtDxzzsdcA5ZWyaquvS` 与 `planKey team::1666468412261620272`（L25–26 起重复）；prompt 中多次出现 `https://www.figma.com/design/izWTtDxzzsdcA5ZWyaquvS`。若是真实测试文件，OSS 前应替换占位符。 |
| 21 | `explore/golden-mcpmark.mjs` | [数据] 脚本 397 行 | 纯本地 MCPMark 权威映射：扫描 `work/mcpmark`（gitignore，缺失不拉取），导出 `description.md` 作权威 prompt；静态判定 `verify.py` 不可运行；把 derived 任务映射到 MCPMark 话题候选（GitHub 19 + Notion 5 = 24 条 `topic-only`；Linear 16 + Vercel 46 = 62 条 `no_authoritative_source`）。明确 `goldScoringAvailable:false`，不产出 pass/fail 金标。 | 无网络、无子进程、无凭据读取、不写文件（源码注释与实现一致）。`TOOL_TOPICS`/`EQUIVALENCE_NOTES` 明說 MCPMark 钉住 GitHub MCP v0.15.0 / Notion MCP @1.9.1，新版工具只有工作流级语义替换——**不是逐工具 gold**，不可据此宣称权威打分。 |
| 22 | `explore/merge-deep.mjs` | [数据] 脚本 32 行 | 合并 `work/deep-*.json` → `tasks-deep.json`（191，59 official + 132 derived）。 | 输入在 gitignored `work/`；[未验证] 当前可重现性。 |
| 23 | `explore/merge-final.mjs` | [数据] 脚本 34 行 | `work/deep-*` + `work/re*` 升级 official prompt → `tasks-final.json`（191：105 official / 86 derived）。 | 同上。 |
| 24 | `explore/merge-regen.mjs` | [数据] 脚本 32 行 | `tasks-final` + `work/regen-*` 把 derived 任务替换为 schema-driven 并反向校验（目标工具本地 BM25 top-5） → `tasks-v2.json`。official verbatim 保持不动。 | 这一步是**个人标识泄漏的引入点**（见 tasks-v2 行）。 |
| 25 | `explore/run-explore.mjs` | [数据] 脚本 653 行 | 主 runner：免费 hy4-flash-free + Go endpoint（`https://opencode.ai/zen/go/v1`），强制拒绝计费用 endpoint/非免费模型（L64–67）；本地凭据从 `~/.dsh/.credentials.yaml`、`~/.gemini-gateway-tokens/{notion,linear}.json`、`~/.cc-switch/copilot_auth.json` 读取，Vercel token 必须由 env 注入；3 工具契约硬失败；每 worker 独立 UpstreamManager + collector，429 退避；trace 只存结构预览；输出 `explore/results/*`（gitignored）。 | **私有路径只出现在代码默认值里**，不是真实值：`~/.dsh/...`、`~/.gemini-gateway-tokens`、`~/.cc-switch/...`（L72–101）。注释明确"never committed"。但源码暴露了本地凭据布局，OSS 发布时属于环境信息，不是凭据泄漏。staticAuth 不刷新，避免与部署网关竞争同一 grant——符合 AGENTS §2。 |
| 26 | `explore/select-smoke.mjs` | [数据] 脚本 194 行 | 从 G6 确定性分层抽 50 条（每 server 10，保证 read/write/boundary 覆盖），`evenPick` 无随机；`--check` 校验已提交文件与选择一致。 | 无敏感值。 |
| 27 | `explore/tasks-deep.json` | [数据] 191 任务 | D001–D191；github 42 / notion 53 / linear 36 / vercel 60；59 official 逐字 URL + 132 `derived-from-official-description`。 | 相对干净：使用 GitHub 官方 `octocat/Hello-World`、`example.com` 邮箱、`ENG-2844`/`LIN-123` 等通用样例。D150 要求读取 `DATABASE_URL` 环境变量值（L1352），属敏感能力提示而非凭据。无个人 repo、无 Figma key。 |
| 28 | `explore/tasks-final.json` | [数据] 191 任务 | F001–F191；105 official / 86 derived；same split as deep。 | **干净**：无 `Bruce-Yii/`、无 `Yi workspace`、无 Figma key、无真实 token。仅有 `alex@example.com`（L1137）、`Mona Octocat`（L345）等官方示例。OSS 风险低。 |
| 29 | `explore/tasks-g6.json` | [数据] 228 任务 | F001–F191（v2 改写版）+ FIG-001..013、023..046（37 个可运行 Figma；9 个付费 Weave 跳过）；generatedAt 2026-11-22T17:35:48.978Z。 | **高风险**：`Bruce-Yii/gemini-mcp-gateway` ×19（L11/31/78/…/407）；`Yi Linear workspace`/`Yi workspace` ×13（L941/961/…/1259）；伪 UUID `3f1c2d9e-…`（L941）、`8c7b6a5d-…`（L1146）、`2a1b3c4d-…`（L1259）；Figma `fileKey izWTtDxzzsdcA5ZWyaquvS` + `planKey team::1666468412261620272` 各 37 处（L1911…2524）。无真实 token、无本地绝对路径。OSS 前必须中性化。 |
| 30 | `explore/tasks-online-gap-2.json` | [数据] 6 任务 | J1–J6，来自 `docs/eval/ONLINE-SEMIONLINE-JOIN-2026-11-23.md`。全部 `dryRun:true` / `forRealWrite:false` / `network:'fake/replay only'`；`requestIds:'unknown'`；buildAxis 为 `prod-old-2026-11-23` vs `checkout-current`，明令禁止跨构建硬比；`skipReason` 让 J6 保持 missing-capability/unknown。 | 纪律最严格的一份：不编造 requestId、不把 unknown 当 pass/fail、不声称线上已修。无凭据。 |
| 31 | `explore/tasks-online-gap.json` | [数据] 9 任务 | N1–N9，来自 `docs/eval/SEMI-ONLINE-GAPS.md §4`。覆盖 byte-exact 读改写回、branch/ref 控制、PR number vs id URL 优先、discovery effort、Actions 日志 302 不转发 token、大文件截断硬停、长会话工具列表稳定、三 profile 编码、写安全 dryRun/原子后条件。全部 fake/replay，`realWritesAllowed:false`。 | 与 AGENTS §5（PR number URL 优先）、§4（3 工具稳定）一致。任务 prompt 含 `Bruce-Yii/gemini-mcp-gateway`（N1 L21）；无真实 token。 |
| 32 | `explore/tasks-smoke.json` | [数据] 50 任务 | 由 `select-smoke.mjs` 从 G6 确定性抽取；每 server 10；categories derived 18 / read 15 / cross 5 / write 3 / boundary 4 / official 5。 | 继承 G6 的个人标识：`Bruce-Yii/...`（L35、L64）、`Yi Linear workspace`（L230 等）、Figma fileKey/planKey 各 10 处（L430…584）。 |
| 33 | `explore/tasks-v2.json` | [数据] 191 任务 | v2：105 official + 86 regenerated（`source:'schema-driven+validated'`、`rank`、`regenerated:true`）。 | **高风险**：`Bruce-Yii/gemini-mcp-gateway` ×19（L12/32/79/…/408，含 `src/app.js`、`docs/old-notes.md` 等内部路径文本）、`Yi workspace` ×15（L942…1260）、伪 UUID ×3。无真实凭据。 |
| 34 | `explore/tasks.json` | [数据] 69 任务 | `build-tasks.mjs` 产物；T001–T069，来源标注为四家官方文档组合字符串。 | 同 build-tasks：`Bruce-Yii/...` ×3（L80、L122、L…）。 |
| 35 | `explore/trace.mjs` | [数据] 脚本 505 行 | harness 观测：gitSha/sha256 provenance、placeholder 检测（正则 `octocat|hello-world|abc1234|example.com|…`）、根因分类（显式 404/403 优先，修掉 #21 schema 误标）、按工具名选 execute 结果（修掉 #22）、anomaly 去重 collector、bounded preview writer、worker pool + 429 退避。DETECTOR_VERSION=2.1，并发默认 3/上限 5。 | 源码注释明确"outputs go under explore/results/ and are git-ignored"。无敏感值。 |

**explore 审计结论**：任务集/基线链条完整可追溯，官方任务来源逐条带 URL；但 **v2/g6/smoke 三个高频使用的任务集被 regeneration 注入了个人 repo 与工作区标识**，这是开源发布前的首要清洗项。MCPMark 部分诚实（只做 prompt 权威性，不做 gold 打分），符合 FRAMEWORK 模块三"官方/权威任务集"的边界。

---

## 2. data/ — 9 个文件（[数据]）

| # | 路径 | 类型 | 用途 / 内容 | 风险 / 证据 |
|---|---|---|---|---|
| 1 | `data/official-tools/figma.json` | [数据] | Figma 官方 Tools 表快照（source = Figma help 文章，capturedAt 2026-11-22）。按 category（design-to-code / code-to-design / design-systems / generative-plugins-shaders / figma-make / account / weave）列出工具并标 read/write。note 明说快照有 6 个 undocumented extras：4 个 ChatGPT/UI internals deny + `create_session`/`create_branch` 为工作流保留。 | 与 `data/tool-policy/figma.json` 配套。无凭据/私有路径。 |
| 2 | `data/tool-dataset.json` | [数据] 1,688,836 字节 / 41,439 行 | MCP 工具描述符主数据集：JSON array，**506 个工具** = vercel 273 + notion 77 + linear 60 + figma 50 + github 46。字段 `{server, tool, name, description, inputSchema}`；name 为 `<server>__<tool>`。供 Code Mode 工具发现与 schema 注册。 | 分页读取（到约 L17,980）+ 全量 `ConvertFrom-Json` 解析与全文扫描：无 `ghp_`/`github_pat_`/`xoxb-`/`AKIA`/`AIza`/私钥/本地绝对路径/Bruce-Yii/个人邮箱域名。`sk-` 3 处是 "skills" 子串；`Bearer ${VERCEL_TOKEN}`（L25075）是文档占位；`alex@example.com`（L2331）/ `kyliau@example.com`（L31973）+ commit SHA 是公开开源示例。风险：描述大量写/凭据相关工具（env 解密、Edge Config tokens、buy_domain 等），发布时只作为 schema 元数据，运行时 token 不得随仓库分发（AGENTS §6）。[未验证] 上游文档的许可/归属需另行确认。 |
| 3 | `data/tool-policy/figma.json` | [数据] | Figma 工具白/黑名单策略。deny 4 个 ChatGPT/UI 内部工具（`authorize_mcp_app`、`open_figma_mcp_app`、`open_figma_mcp_app_in_thread`、`get_profile_for_chatgpt`）；allowExtra 2 个（`create_session`、`create_branch`）。source 指向 `docs/UNNEEDED-TOOLS.md` + review 2026-11-22。 | 无敏感值。对应模块二（客户端适配：为 Gemini web 去掉 ChatGPT UI 工具）。 |
| 4 | `data/tool-snapshots/README.md` | [数据] 文档 | 快照格式说明；capture 命令 `node scripts/audit-tools.mjs --server figma --write-snapshot --sync-dataset`；明确"requires a valid token in configured tokenEnv; never commit the token"，并要求 fresh clone 无凭据可跑 audit。 | 无敏感值。 |
| 5 | `data/tool-snapshots/figma.json` | [数据] 2,349 行 | Figma MCP tools/list 快照，capturedAt 2026-11-22T16:24:40.613Z，source `https://mcp.figma.com/mcp tools/list`。toolCount=50，实际 50 ✅（逐行读完）。 | `init_token` 参数说明（L13/17/21）是 OAuth iframe 短时公开 token 的描述，非真实值。无敏感泄漏。 |
| 6 | `data/tool-snapshots/github.json` | [数据] 2,241 行 | GitHub tools/list 快照，46/46 ✅；legacy 来源 `data/tool-dataset.json#github`，capturedAt 记为 unknown。逐行读完。 | `run_secret_scanning` 描述里的 secret/token/password 词（L1606 附近）是功能文本。无敏感值。 |
| 7 | `data/tool-snapshots/linear.json` | [数据] 3,292 行 | Linear tools/list 快照，60/60 ✅；legacy 来源。逐行读完。 | 无敏感串命中。工具面含 `get_attachment`/`prepare_attachment_upload` 等长描述（含签名 URL/60 秒过期说明），属文档。 |
| 8 | `data/tool-snapshots/notion.json` | [数据] 6,317 行 | Notion tools/list 快照，77/77 ✅；legacy 来源。逐行读完。 | `query_type` enum `internal`（L19/22）、`preserve_internal_links`（L460）、`upload_token` 描述（L288/937）均为 schema 文本；`alex@example.com`（L9）为合成示例。无敏感泄漏。 |
| 9 | `data/tool-snapshots/vercel.json` | [数据] 26,517 行 | Vercel tools/list 快照，273/273 ✅；legacy 来源。分页读到约 L25,059（约 95%）+ 全量解析/扫描。 | `Authorization: Bearer ${VERCEL_TOKEN}`（L12498）是文档变量占位；`kyliau`/`kyliau@example.com`（L19303/19308）及 token 形态示例串（L24031）来自上游 Vercel MCP 文档 example 字段，与 dataset 同源，非本项目/个人数据。无真实凭据。工具面暴露高权限能力（env 解密、Edge Config tokens、buy_domain、防火墙/域名写、sandbox sudo 等）——[未验证] 是否应在 OSS 默认白名单里收紧，需另外决策。 |

**data 审计结论**：5 份快照 toolCount 与实际数组 5/5 一致，是 `total/extras/denied` 结论的可复现证据；主数据集 506 工具、无凭据泄漏。风险不在"数据"而在"能力面"——快照揭示网关会暴露 decrypt env / tokens / 付费购买 / 防火墙改写等高危工具，这与 FRAMEWORK §12「信任与安全边界」和 §13.5「成本控制」相关，是否默认放行属于**未验证**的策略决策。

---

## 3. templates/ — 33 个文件（[模板]）

### 3.1 部署模板可部署性（硬要求 3）

| 模板 | 状态（文件自称） | 可部署？ | 私有路径？ | 证据 |
|---|---|---|---|---|
| `templates/local/` | "works with the existing code"（CLI） | ✅ 本地可跑（stdio 或 `--port`，仅 loopback） | 无；`config.local.example.json` 用 `https://mcp.example.invalid/mcp`、`npx some-mcp-server@1.0.0` | README L3、L17–30、L39–42 |
| `templates/vercel/` | "reference deployment, works with the existing code" | ✅[未验证] 文件自称参考部署；本次未实际 deploy | 无；`.env.example` 全占位（`gmc_REPLACE_WITH_RANDOM_HEX`、`YOUR_GITHUB_TOKEN`、`.example.invalid`） | README L3–6、L29–46；`vercel.example.json` 是根 `vercel.json` 的无值副本 |
| `templates/docker/` | "example files only" | ⚠️ 部分：CLI 在容器内可跑，但 `startHttpServer()` 绑 `127.0.0.1`，端口映射不通；OAuth on `/mcp` 不支持 | 无；`node:20-bookworm-slim`、`/app/gateway-config.json` 是容器内路径，非个人路径 | README L3–5、L38–44；Dockerfile L1–22；compose L9–12、L17；nginx `gateway.example.invalid` |
| `templates/cloudflare/` | "not deployable with the current code"（需开发） | ❌ 不可部署；`worker.example.js` 故意返回 501 | 无；wrangler `database_id = "REPLACE_WITH_YOUR_D1_DATABASE_ID"`、`https://<your-worker>.example.invalid` | README L1–7、L9–21、L41–49；worker L14–25；wrangler L1–23 |

结论：**没有模板包含真实凭据或个人私有路径**。唯一"路径"类是容器内的 `/app/...` 和本地 `~/.dsh` 类默认凭据位置（后者在 explore 脚本里，不在 templates）。Cloudflare 模板明写 `需开发`，不能对外宣称支持 Cloudflare Workers——与 FRAMEWORK §6/§12 一致。

### 3.2 逐文件表

| # | 路径 | 类型 | 用途 / 内容 | 风险 / 证据 |
|---|---|---|---|---|
| 36 | `templates/client-profiles/gemini.json` | [模板] 57 行 | Gemini web 设计/配置草稿。`$schemaNote` 明说 runtime **不读此文件**，编码它不改变行为。status `tested-baseline`；OAuth DCR+PKCE/callback allowlist（Google hosted hosts）、scopes、3 工具面、已知限制（个人账户/18+/US only/English UI/Activity on）。 | `unverified`：只测过一个真实 Gemini 账号/区域。无敏感值。 |
| 37 | `templates/client-profiles/chatgpt.json` | [模板] 63 行 | ChatGPT web connectors 设计目标，status `untested-design-target`；structuredContent+text JSON；DCR 在 LOCKED 模式默认被拒，需 `ALLOW_DCR_FOR_CHATGPT=1`；标注社区报告的 token/volume 限制为"unverified"。 | `unverified`：无真实端到端连接。`execute(code)` 名称可能被安全审核拒绝——诚实写出。无敏感值。 |
| 38 | `templates/client-profiles/claude.json` | [模板] 57 行 | Claude web connectors/Desktop remote 设计目标；text-json-only；callback `claude.ai` **不在当前 allowlist**（明写需代码/配置改动）；public client 期望轮换 refresh token，而网关当前不轮换——标为已知 gap。 | 明确区分"设计目标"与"当前行为"，避免过度宣称。含 IP 段 `160.79.104.0/21`（Claude 文档里的公网 egress 段），非内网/私人地址。 |
| 39 | `templates/cloudflare/README.md` | [模板] 57 行 | Workers 可行性评估：列 Node API、stdio、HTTP server、QuickJS worker thread、`@vercel/functions` waitUntil、Upstash Lua CAS、OAuth routes 等阻塞点与所需适配。 | 明确"不要宣称 Cloudflare support until adapters exist and are tested"。无敏感值。 |
| 40 | `templates/cloudflare/config.cloudflare.example.json` | [模板] | http-only 示例：`mcp.example.invalid`、`EXAMPLE_TOKEN`、allow/deny 空数组。 | 无私有路径/凭据。 |
| 41 | `templates/cloudflare/worker.example.js` | [模板] 26 行 | 故意返回 501 的 sketch，注释写明"NOT A WORKING WORKER"。 | 避免误当可部署入口。 |
| 42 | `templates/cloudflare/wrangler.example.toml` | [模板] 23 行 | 目标 bindings 草图；`database_id = REPLACE_WITH_YOUR_D1_DATABASE_ID`；secrets 用 `wrangler secret put`，不写文件。 | 明确"Do not commit real account_id / database_id / secrets"。 |
| 43 | `templates/docker/.env.example` | [模板] | env 名占位：`EXAMPLE_HTTP_TOKEN=YOUR_UPSTREAM_TOKEN`、`CAPTURE_HTTP_URL=...example.invalid`。 | 无真实值。 |
| 44 | `templates/docker/Dockerfile.example` | [模板] 22 行 | `node:20-bookworm-slim`、prod deps、non-root `node`、`USER node`、CMD CLI + `--config /app/gateway-config.json --port 3000`；注释明确 no secrets in image、`--host` 需开发。 | `/app/...` 是容器内路径，非私有路径。 |
| 45 | `templates/docker/README.md` | [模板] 86 行 | 快速启动、compose、config/env、OAuth/回调、storage、limits。多次标 `需开发`（host flag、bearer auth、Node HTTP entry、durable token store）。 | "Do not expose the container publicly without auth"（L61）。无敏感值。 |
| 46 | `templates/docker/compose.example.yml` | [模板] 35 行 | 单 gateway + optional nginx proxy profile；bind-mount `../../my-gateway.local.json:ro`；注释提示端口映射当前不可达。 | 无私有路径。 |
| 47 | `templates/docker/nginx.example.conf` | [模板] 23 行 | 反代 sketch：`gateway.example.invalid`、只转发明文 HTTP、TLS/auth 需开发、`client_max_body_size 2m`（网关 /mcp 限 1 MiB，代理不得更小）。 | 无真实主机名/证书。 |
| 48 | `templates/local/.env.example` | [模板] | env 名占位 + `GATEWAY_CONFIG/UPSTREAMS_JSON are ignored by CLI` 注记。 | 无真实值。 |
| 49 | `templates/local/README.md` | [模板] 84 行 | 本地 CLI 用法：stdio / `--port`（loopback only）、3 工具面、OAuth 不在 CLI（`需开发`）、无 KV、capture 默认 off。 | "personal use" 建议复制示例而非 `npm start` 参考配置。无敏感值。 |
| 50 | `templates/local/config.local.example.json` | [模板] | 双 server 示例：`example-http`（`mcp.example.invalid`）+ `example-stdio`（`npx some-mcp-server@1.0.0`）；`allowTools:[]`/`denyTools:[]`。 | 无真实 URL/凭据。 |
| 51 | `templates/upstreams/README.md` | [模板] 58 行 | 13 个公开 MCP server 模板索引表 + 官方来源链接；明说 "Nothing here contains credentials"；补记为何缺 Microsoft 365（tenant-scoped）、Figma remote（catalog 限制）、Workspace secret。 | 指向 `docs/CREDENTIALS.md`（本次未读该文档，[未验证] 其内容）。无敏感值。 |
| 52 | `templates/upstreams/atlassian-personal-token.json` | [模板] | `mcp.atlassian.com/v2/mcp?tools=all`，`authScheme:basic`，`ATLASSIAN_BASIC_TOKEN`（应为 base64(email:token)）。 | 仅 env 名。 |
| 53 | `templates/upstreams/atlassian-service-account.json` | [模板] | 同 endpoint，`ATLASSIAN_MCP_API_KEY` Bearer。 | 仅 env 名。 |
| 54 | `templates/upstreams/cloudflare.json` | [模板] | `mcp.cloudflare.com/mcp`，`CLOUDFLARE_API_TOKEN`。 | 仅 env 名。对应 FRAMEWORK 模块四后续候选 Cloudflare。 |
| 55 | `templates/upstreams/figma-desktop.json` | [模板] | `http://127.0.0.1:3845/mcp`，无认证；README 明确"Local gateway only"，hosted 不可达。 | loopback 地址是公开文档端点，非内网/私有。 |
| 56 | `templates/upstreams/figma-framelink.json` | [模板] | `http://127.0.0.1:3333/mcp`，`X-Figma-Token` / `FIGMA_API_KEY`；README 指向第三方 Framelink server（MIT）。 | 仅 env 名。 |
| 57 | `templates/upstreams/figma-oauth.json` | [模板] | `mcp.figma.com/mcp`，`mcp:connect` scope，`oauth2.googleapis.com`-like Figma token endpoint；README 明说被 catalog 限制"Blocked for custom apps"。 | 仅 env 名，明确不可用状态。 |
| 58 | `templates/upstreams/google-drive.json` | [模板] | `drivemcp.googleapis.com/mcp/v1`，refresh + client id/secret env + `oauth2.googleapis.com/token`。 | 需要用户提供自己的 client secret，文件里只有变量名。 |
| 59 | `templates/upstreams/neon.json` | [模板] | `mcp.neon.tech/mcp`，`NEON_API_KEY`。 | 仅 env 名。 |
| 60 | `templates/upstreams/sentry.json` | [模板] | `mcp.sentry.dev/mcp`，`SENTRY_ACCESS_TOKEN`，`authScheme:"Sentry-Bearer"`。 | 仅 env 名。 |
| 61 | `templates/upstreams/slack.json` | [模板] | `mcp.slack.com/mcp`，OAuth refresh + client id/secret + refreshUrl `slack.com/api/oauth.v2.user.access`。 | 仅 env 名；README 明说 no DCR。 |
| 62 | `templates/upstreams/stripe.json` | [模板] | `mcp.stripe.com`，`STRIPE_AGENT_API_KEY`。 | 仅 env 名。 |
| 63 | `templates/upstreams/supabase.json` | [模板] | `mcp.supabase.com/mcp`，`SUPABASE_ACCESS_TOKEN`。 | 仅 env 名。 |
| 64 | `templates/upstreams/twilio-docs.json` | [模板] | `mcp.twilio.com/docs`，无 token（公共文档 server）。 | 无凭据。 |
| 65 | `templates/upstreams/zapier.json` | [模板] | `mcp.zapier.com/api/v1/connect`，`ZAPIER_MCP_TOKEN`。 | 仅 env 名。 |
| 66 | `templates/vercel/.env.example` | [模板] | 全占位：`PUBLIC_BASE_URL=https://<your-app>.example.invalid`、`gmc_REPLACE_WITH_RANDOM_HEX`、`REPLACE_WITH_RANDOM_SECRET`、`YOUR_GITHUB_TOKEN`。 | 无真实值。 |
| 67 | `templates/vercel/README.md` | [模板] 87 行 | Vercel 参考部署：quickstart、required env（含 Upstash KV）、OAuth callbacks、storage（KV 是生产唯一 token store）、limits（60s、single-owner、GET→405、工具面稳定）。 | 明确"placeholder-only copies"、根 `vercel.json` 才是活动配置。无敏感值。[未验证] 本次未实际部署验证。 |
| 68 | `templates/vercel/vercel.example.json` | [模板] 14 行 | 根 vercel.json 的无值副本：`framework:null`、`maxDuration:60`、`/(.*)` → `/api/index`。 | 无敏感值。 |

**templates 审计结论**：全部 33 个文件都是占位/草图/说明，**无真实凭据、无个人路径、无内部数据**。可部署性诚实分级：local 可跑、vercel 参考部署（本次未实测）、docker scaffold（host 绑定与 OAuth 需开发）、cloudflare 明确不可部署。三个 client profile JSON 都自我声明"runtime 不读此文件"，是设计目标而非行为证据——与 FRAMEWORK §15 的"架构承诺与生产默认仍有距离"一致。

---

## 4. examples/ — 4 个文件（[模板]）

| # | 路径 | 类型 | 用途 / 内容 | 风险 / 证据 |
|---|---|---|---|---|
| 10 | `examples/custom-oauth-refresh.json` | [模板] 16 行 | 通用 OAuth refresh server 示例：`mcp.example.com/mcp`、`auth.example.com/token`，env 名 `MY_UPSTREAM_*`。 | 全占位，无真实 endpoint/凭据。 |
| 11 | `examples/github-bearer.json` | [模板] 11 行 | GitHub Copilot MCP：`https://api.githubcopilot.com/mcp/`，`GITHUB_TOKEN` env 名。 | 公开端点；仅 env 名。 |
| 12 | `examples/local-stdio-fake.json` | [模板] 11 行 | 本地 fake upstream：`transport:stdio`，`command:node`，`args:["harness/fake-upstream.mjs"]`。 | 指向本地 harness；无凭据。[未验证] `harness/` 文件是否在仓库内（不在本次 4 目录）。 |
| 13 | `examples/oauth-refresh-notion.json` | [模板] 15 行 | Notion OAuth refresh：`mcp.notion.com/mcp`，`NOTION_*` env 名。 | 公开端点；仅 env 名。 |

**examples 审计结论**：4 个都是最小配置样例，无真实 token、无个人路径。

---

## 5. 专项审计结论（硬要求 3）

### 5.1 任务集 / 基线 / 官方任务来源

- **任务集**：69 → 191 → 191 → 191(v2) → 228(G6) → 50(smoke)，另有 N1–N9 / J1–J6 两个线上缺口集。链条由脚本与实际 JSON 对得上；`baselines/l1-smoke.json` 是唯一冻结基线源，明确禁止运行时自引用。
- **基线**：REAL 基线 50 任务 / 76% completion / 21 gateway anomaly / p95 22025ms；`fake` 段是 wiring check。本次**未重跑** L1，故这些数值是 [数据] 事实，不是 [已验证] 当前构建表现。
- **官方任务来源**：`tasks.json`、`tasks-deep.json`、`tasks-final.json`、`figma-tasks.json` 逐条带官方文档 URL（github/blog/docs.github.com、developers.notion.com/notion-cookbook、linear.app/docs+agents.md+ai.md、vercel.com/docs/agent-resources、help.figma.com）。MCPMark 部分只取 `description.md` 做权威 prompt，**明确不产出 gold 分数**——不存在"硬跑 verifier 得到假金标"的问题。
- **[未验证]**：`work/deep-*.json`、`work/regen-*.json`、`work/mcpmark` 等输入产物多数 gitignored；本次未验证它们对当前 checkout 的可重现性。

### 5.2 模板可部署性 / 私有路径

- 可部署性分级见 §3.1：**local 可跑、vercel 参考、docker scaffold、cloudflare 明确不可部署**。
- **私有路径扫描结论**：templates/ 与 examples/ 全部 37 个文件**无个人绝对路径**（无 `/Users/`、`C:\Users\`、`D:\`、`/home/<user>`）；唯一"路径"是容器 `/app/...` 与 loopback `127.0.0.1:3333/3845`、占位域名 `.example.invalid`、公开厂商端点。explore 脚本中的 `~/.dsh/.credentials.yaml`、`~/.gemini-gateway-tokens/`、`~/.cc-switch/copilot_auth.json` 是凭据存储位置默认值，代码注释明说 never committed——不是仓库里的真实凭据。

### 5.3 Cloudflare / Vercel / Docker 模板

- Cloudflare：`worker.example.js` 返回 501；README 列 8 项阻塞；**不可宣称支持**。
- Vercel：参考部署（自称 works），KV 必需（`src/store.js` Upstash REST），无 KV 能起 `/healthz` 但 `/mcp` auth 失败；60s 函数时长；single-owner。本次未部署，状态 [未验证]。
- Docker：CLI 容器内可跑但 HTTP 绑 loopback 使端口映射无效；无 OAuth；nginx 只做明文转发；非 root、不 baked token；`--host` 与 bearer auth 需开发。

### 5.4 真实凭据 / 个人路径 / 内部数据（汇总）

| 类别 | 发现 | 位置 | 处置建议 |
|---|---|---|---|
| 真实 token / secret | **0** | 全 68 文件扫描：`ghp_`/`github_pat_`/`sk-[20+]`/`xoxb-`/`AKIA`/`AIza`/私钥/真实 Bearer 值 0 命中 | 无需处置；`Bearer ${VERCEL_TOKEN}` 等均为变量占位 |
| 个人 repo 归属 | `Bruce-Yii/gemini-mcp-gateway` ×19(G6)/×19(v2)/×15(smoke 等) | explore/tasks-g6.json、tasks-v2.json、tasks-smoke.json、tasks.json、build-tasks.mjs、tasks-online-gap.json | **OSS 前中性化**为 `octocat/Hello-World` 或 `example/repo` |
| 个人工作区 | `Yi Linear workspace` / `Yi workspace` + team key `LIN`/`FEA` | tasks-g6.json、tasks-v2.json、tasks-smoke.json | 同上 |
| Figma 资源 ID | `fileKey izWTtDxzzsdcA5ZWyaquvS`、`planKey team::1666468412261620272` | figma-tasks.json（46 条 preconditions）、tasks-g6.json（37×2）、tasks-smoke.json（10×2） | 若非公开测试文件，替换为明显占位符 |
| 伪 UUID | `3f1c2d9e-4b7a-4c88-9e21-6d0f5a7b8c13` 等 3 个 | tasks-g6/v2（L941/L1146/L1259 一带） | 形似真实，建议换成 `00000000-...` 风格 |
| 公开示例个人标识 | `kyliau` / `kyliau@example.com` / 真实 commit SHA / `alex@example.com` | data/tool-dataset.json、data/tool-snapshots/vercel.json、notion.json | 来自上游/public 数据，非本项目私密；零容忍策略下可换中性示例 |
| 凭据布局信息 | `~/.dsh/.credentials.yaml`、`~/.gemini-gateway-tokens/`、`~/.cc-switch/copilot_auth.json` | explore/run-explore.mjs（L72–101） | 代码默认值，无实际值；OSS 时可改为纯 env 注入以缩小信息面 |
| 本地绝对路径 | 0 | — | — |

**没有 [内部数据] 被确认**：所有扫描到的"内部"词（`query_type=internal`、Vercel "Internal Vercel runtime spans"、Figma `preserve_internal_links`）都是工具 schema 语义，不是私有内容。

### 5.5 与六模块 / FRAMEWORK 的对应

| FRAMEWORK 模块 | 本目录证据 | 支撑/差距 |
|---|---|---|
| 一 核心底座（可替换） | `examples/*.json` 全为 `mode:"codemode"`；templates 都要求 3 工具稳定；Cloudflare 模板点明 QuickJS worker-thread 不可移植 | 支撑"底座按客户端替换但接口不变"；Native/Hybrid 无资产，[未验证] |
| 二 客户端 | `templates/client-profiles/{gemini,chatgpt,claude}.json`；Figma ChatGPT UI 工具 deny | 支撑"按平台×模式分 lane"；profile 文件 runtime 不读（只设计目标），是差距 |
| 三 评测体系 | explore 全目录（任务链、基线、runner、anomaly、MCPMark 诚实边界、N1–N9/J1–J6） | 最强资产区；官方 prompt 有来源，gold 打分明确不可用；采集层 session/project/task 交叉不在这 4 目录，[未验证] |
| 四 上游接入 | `templates/upstreams/*` 13 个公开 MCP + `data/tool-snapshots/*` 5 个快照 + `data/official-tools/figma.json` | 支撑"每个上游固定 SOP"的工具目录部分；授权流程/首次引导只在此留有 env 名与 README 指针，[未验证] |
| 五 运行时/部署 | `templates/{local,vercel,docker,cloudflare}/*` | local/vercel 可用，docker scaffold，cloudflare 不可部署；成本保护（无扣费风险）在 Vercel 模板有 60s/免费限制说明，buy_domain 等高危工具未在模板默认 deny（差距） |
| 六 开源工程 | 所有模板占位化、README 声明、Figma deny 策略 | 支撑发布准备；但 OSS 未公开（AGENTS §0），个人标识清洗未完成，RELEASE-LOCAL + PUBLIC-SAFETY-AUDIT 门禁未过 |

---

## 6. 最终判定

1. **枚举**：expected 68 / read 68 / unread 0；无二进制或图片文件。两个超大文件为分页读取 + 全量结构化解析/扫描，已在 §0 明示，不冒充逐行肉眼读完。
2. **无真实凭据**：4 目录内 0 个真实 token/secret；所有 `.env.example`、`*example*.json` 均为占位。
3. **主要发布风险不是机密，而是归属标识**：`Bruce-Yii/...`、`Yi workspace`、Figma fileKey/planKey、3 个伪 UUID 集中在 tasks-g6/v2/smoke/figma-tasks/build-tasks；应作为 OSS 清洗清单，且必须过 `docs/OPEN-SOURCE/PUBLIC-SAFETY-AUDIT.md`（本次未读该文件内容，状态 [未验证]）。
4. **模板诚实分级**：local 可跑、vercel 参考、docker scaffold、cloudflare 明确不可部署；三个 client profile 明确 runtime 不读取。
5. **未做**：未写任何非本报告文件；未运行任务/部署；未 commit/push/deploy；未修改 src/scripts/tests/README/其他 docs/workflows。
