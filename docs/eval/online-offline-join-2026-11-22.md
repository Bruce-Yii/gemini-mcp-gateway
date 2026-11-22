# Online capture vs 离线评测对照（2026-11-22）

> 只读对照分析。窗口：UTC 2026-11-22T20:58Z 之后（北京时间 2026-11-23 04:58 之后）。
> 在线数据：R2 bucket `gemini-mcp-gateway-capture`，`capture/2026-11-22/` 与 `capture/2026-11-23/` 前缀下的全部对象（后者 0 个）。
> 离线数据：`explore/baselines/l1-smoke.json`、`docs/eval/scorecard-2026-11-22.{md,json}`、`docs/ledger/batch-10-pr-workflow.md`、`docs/ledger/batch-10-canonical.md`、`docs/eval/L1-SMOKE.md`。
> 方法：只读脚本 `scripts/join-online-offline.mjs`（新建，临时）逐对象读取并脱敏，未修改 `src/`、`explore/`、`README`、`CHANGELOG`、workflows；未 commit / push / deploy。凭据只存在于环境变量与仓库外的 secret 文件，本报告不记录任何 key/token。

## 0. 结论摘要

1. 窗口内 R2 有 **11 个 envelope**，但只有 **3 个是真正的 MCP 业务调用**（`tools/call` → `execute_read`，全部只读）；其余是握手、工具列表、健康检查与 405/404。对象数与既有 scorecard 的 20 条**全天**计数吻合（窗口前 9 条 + 窗口内 11 条），没有数量级缺口。
2. 用户声称的 PR #41–#48（建分支/多文件提交/合并/Issue）在 capture 里**完全没有出现**。但同窗 GitHub API 时间线证明这些 PR/合并确实在 21:00Z–21:17Z 发生，且 capture 的 21:09Z envelope 里还带着 `upstream_http:github` / `upstream_frame:github` 事件。结论：**采集缺失（写路径/capture 覆盖缺口）**，不是时间窗错位，也不像是换服务器。
3. 在线和离线指标只有很少一部分可比：`status` 分布、MCP 方法分布、`execute_read` 耗时、截断/溢出计数可以对齐；`completionRate`、`searchHitRate`、`toolHitRate`、`tokensPerTask`、`p95LatencyMs`（L1 的端到端任务指标）与在线的单请求 HTTP 指标**不可比**，不做硬比。
4. B10 反馈中「字段兜底」「行号偏移修复」「patch/diff」里只有一部分能被 capture 证实：字段兜底（`content || resources[0].text || text`）在两段 `execute_read` 代码里直接可见；行号/SQL 类报错未在本窗出现；patch/diff/sha/commit 在窗口内**没有任何调用证据**，只能靠用户描述与 B10 文档。
5. 下一轮最小补充：在 `execute`（写路径）与 `upstream_http` 层补齐 capture 覆盖 + 结构化 `meta`（duration_ms、upstream_calls、sha、变更清单），并把在线窗口锚定到 PR 时间线。

---

## 1. 在线窗口实际发生了什么

### 1.1 对象数与 R2 对账

- 全天 `capture/2026-11-22/`：**20 个 `.json.gz`**，全部成功解压读取，`loadErrors = []`。
- `capture/2026-11-23/` 与 `capture/2026-11-24/`：**0 个**（Vercel 时区/部署延迟不影响 UTC 前缀；窗口内最后一条是 `21:41:29.550Z`）。
- 窗口 ≥ `20:58:00.000Z`：**11 个**；窗口前：**9 个**。
- 与 `docs/eval/scorecard-2026-11-22.json` 对照：scorecard `requests=20`、`mcpRequests=9`、`nonMcpRequests=11`、`statuses={200:7,202:2,404:9,405:2}`、`byHour={20:10,21:10}` — 与原始 envelope 逐条计数一致。差异只在口径：scorecard 把 `POST /mcp` 9 条算 MCP，其中 `tools/list` 3、`tools/call` 3、`notifications/initialized` 2、`initialize` 1；非 MCP 是 `GET /` 9（404）与 `GET /mcp` 2（405）。**对象数对得上。**

### 1.2 窗口内 11 条逐条清单（UTC，脱敏）

| # | requestId | 时间 | 路由 | MCP 方法 / 工具 | status | 耗时 | 关键事件 |
|---|---|---|---|---|---:|---:|---|
| 1 | `1ffa01d7-e747-4c4e-978d-93273710b1d7` | 21:03:06.713Z | GET / | — | 404 | 7 ms | 无 |
| 2 | `116da831-5c24-4742-a2da-83876052d93f` | 21:09:34.791Z | GET /mcp | — | 405 | 775 ms | `upstream_connect:*` ×5、`upstream_frame:*` ×5、`upstream_http:*` ×8（github/vercel/linear/figma/notion），说明此刻在上游连接/探测，但**没有 MCP 方法执行** |
| 3 | `1545fee3-4182-471d-a31a-81404e54bc0b` | 21:09:34.815Z | POST /mcp | `tools/list` | 200 | 8 ms | `gateway_catalog:1`；返回 3 个工具 `search/execute_read/execute` |
| 4 | `05d1b10d-9909-42fb-b28c-5a02959dffdb` | 21:13:01.151Z | POST /mcp | `tools/call` → `execute_read` | 200 | 513 ms | `upstream:github:1`、`upstream_http:github:2`、`upstream_frame:github:2`、`sandbox:1`；脚本调 `github__get_file_contents`(recruitment-agent / CandidatePage.tsx) + `sliceLines` |
| 5 | `0a099ec7-3caa-4041-a49c-2461679727a0` | 21:13:21.119Z | POST /mcp | `tools/call` → `execute_read` | 200 | 724 ms | 同上；第二次 `github__get_file_contents` 同一文件取另一段切片 |
| 6 | `0ee89ae5-9d27-4fa0-99f4-4ae6f3c0f115` | 21:16:08.799Z | GET / | — | 404 | 8 ms | 无 |
| 7 | `00c596e9-30d2-4f53-97b7-5e40aafab7b6` | 21:19:36.155Z | GET / | — | 404 | 7 ms | 无 |
| 8 | `11576fd0-eb7c-4a60-a01f-6faef1bfe1e9` | 21:21:28.405Z | GET / | — | 404 | 7 ms | 无 |
| 9 | `0c17ef96-25b1-4098-b1ed-0e64b784dd48` | 21:22:44.508Z | POST /mcp | `tools/list` | 200 | 28 ms | `gateway_catalog:1`；同样是 `search/execute_read/execute` |
| 10 | `0ebb7bc6-2655-4cdd-997b-c653ff854528` | 21:27:11.350Z | GET / | — | 404 | 8 ms | 无 |
| 11 | `117fbd93-9b0b-45c0-b778-c7b49590615b` | 21:41:29.550Z | GET / | — | 404 | 8 ms | 无 |

窗口前补充（用于与 B10 和全天 scorecard 对账，不属本窗口）：

- `10c13554-6936-4a93-9ef2-9662fa55d1c6` @ `20:16:22.448Z`：`tools/call` → `execute_read`，**200 / 6228 ms**（全天最慢），脚本里调用了 `github__get_file_contents` ×3、`sliceLines`、`notion__notion_search`、`linear__list_teams`、`linear__list_issues`、`vercel__list_projects`、`vercel__list_deployments`、`figma__whoami`、`figma__get_metadata`，并含一个 `notARealTool` 的负向探测。事件：`upstream:github/notion/linear/vercel/figma` 各 1、`sandbox:1`。
- `20:03:13.609Z` 的 `tools/list`（`201dfb63-…`）、`20:16:04.622Z` 的 `GET /mcp` 405（`0d96662b-…`）、`20:16:04.654Z` 的 `notifications/initialized` 202（`0723af62-…`）、`20:16:10.867Z` 的 `initialize` 200（`04e51bb9-…`）、`20:55:32.245Z` 的 `notifications/initialized` 202（`19593b00-…`）以及 4 条 `GET /` 404 — 共 9 条，构成全天 20 条。

### 1.3 状态 / 工具 / 耗时汇总（窗口内）

| 维度 | 值 |
|---|---|
| 路由 | `GET /` 7（全部 404）、`GET /mcp` 1（405）、`POST /mcp` 3（200） |
| MCP 方法 | `tools/list` 2、`tools/call` 2、`（无）` 7（健康检查/405） |
| 上游工具 | 仅 `execute_read` ×2；脚本内上游调用仅 `github__get_file_contents` ×3 + `sliceLines` ×2 |
| HTTP 状态 | 200 ×4、404 ×7、405 ×1；`mcpErrors=0`、`truncated=0`、`overflow=0` |
| 耗时 | 最小 7 ms、最大 775 ms（405 的上游探测）、`tools/call` 分别 513 / 724 ms、`tools/list` 8 / 28 ms |
| 响应字节 | 主要来自 `tools/list`（6.2–6.7 KB）与 `execute_read`（2.0–2.5 KB） |

**关键观察**：窗口内没有任何 `tools/call` → `execute`，没有任何 `github__create_branch` / `github__create_or_update_file` / `github__push_files` / `github__create_pull_request` / `github__merge_pull_request` / `github__issue_write` 等写工具调用。`keywordHits` 中出现的 `issue` / `line` 都来自 `tools/list` 的工具描述文本和代码变量名（如 `sliceLines`），不是 PR/Issue 操作（已回原始 envelope 逐条核对）。

---

## 2. PR #41–#48 是否出现在 capture 里？

### 2.1 用户/lead 提供的 GitHub 时间线（外部事实，来自 recruitment-agent 仓库 API）

| PR | created (UTC) | merged (UTC) | 说明 |
|---|---|---|---|
| #41 | 20:04Z | 21:00:11Z | 合并 |
| #42 | 20:42Z | 21:00:08Z | 合并 |
| #43 | 21:03:44Z | 21:03:46Z | 合并 |
| #44 | 21:12:32Z | 21:12:34Z | 合并 |
| #48 | 21:17:19Z | — | open |

这些都落在 21:00–21:17Z，完全在本次窗口（≥20:58Z）内。

### 2.2 Capture 侧证据

- 21:00–21:17Z 之间本窗口的 envelope 只有：`1ffa01d7`（21:03:06 GET / 404）、`116da831`（21:09:34 GET /mcp 405 + 上游连接事件）、`1545fee3`（21:09:34 tools/list）、`05d1b10d`（21:13:01 execute_read）、`0a099ec7`（21:13:21 execute_read）、`0ee89ae5`（21:16:08 GET / 404）。
- 两次 `execute_read` 的脚本内容都是 `github__get_file_contents(recruitment-agent, CandidatePage.tsx, ref: main)` + 字符串切片，**没有写操作**；20:16Z 那次也是跨服务只读探测。
- `tools/list` 返回的工具虽然包含 `execute`（具备写能力），但**从未被调用**。
- `116da831` 的 `upstream_http:github:8` / `upstream_frame:github:5` 证明 21:09Z 网关确实在与 GitHub 通信，但 capture 只记录了连接/帧事件，没有对应的 `tools/call` envelope 与之配对。

### 2.3 判断（采集缺失，非时间窗错位、非换服务器）

| 假设 | 证据 | 判定 |
|---|---|---|
| 时间窗错位 | 窗口从 20:58Z 开始，PR 合并 21:00–21:17Z 全在窗内；21:09Z 还有含 GitHub 上游事件的 envelope | **排除** |
| 走了别的 MCP 服务器 | 20:16Z 与 21:13Z 的 `execute_read` 里都显式写了 `codemode.github__get_file_contents`，说明同一个网关同时挂着 GitHub；`tools/list` 仍是本网关的三工具面 | **低可能，无证据支持** |
| 采集缺失 | 合并发生的 17 分钟内，本网关 capture 只有只读调用 + 404/405 + 上游连接事件；`execute` 工具零调用；`upstream_http:github` 事件存在却没有配对的 MCP 写请求 envelope | **最可能** |

更准确地说：**GitHub 的 PR/分支/合并/Issue 操作很可能不是通过这个 MCP 网关执行的**（例如 Gemini 用了另一套 GitHub 集成/直连 MCP/CLI），所以网关 capture 天然看不到；但 21:09Z 的 GitHub 上游连接事件又表明至少有一次 GitHub 通信途经网关边界却没留下完整 MCP 调用记录，因此**网关 capture 的写路径/上游事件覆盖不完整**也是确定存在的缺口。两者叠加，导致 capture 无法作为 PR #41–#48 的审计证据。

**结论表述**：capture 里没有这些 PR 操作；原因排序为「写操作走了别的通道 + 网关 capture 未覆盖该路径」>「纯采集丢失」。不能据此说“用户没做”。

---

## 3. 在线结果 vs 离线基线：哪些可比，哪些不可比

### 3.1 离线基线口径

- `explore/baselines/l1-smoke.json`（G6 228 任务中筛出 50 条 smoke task id）：`completionRate=76%`、`gatewayAnomalyCount=21`、`anomalyCount=92`、`searchHitRate=86.4%`、`toolHitRate=51.3%`、`tokensPerTask=15691`、`p95LatencyMs=22025`。这些是**模型+任务级端到端结果**，来源 `explore/results/metrics.json + anomalies.json`，完成判定用 anomaly proxy。
- `docs/eval/scorecard-2026-11-22.json`：这是**同一 R2 数据的另一个聚合产物**，不是独立基线：`requests=20`、`mcpRequests=9`、`p50=7ms`、`p95=775ms`、`avg=419ms`、`errors=11`、`truncated=0`、`overflow=0`。

### 3.2 可比（同一观测层：HTTP/MCP envelope）

| 指标 | 在线窗口（11 条） | scorecard（全天 20 条） | 说明 |
|---|---|---|---|
| R2 对象数 | 11 | 20 | 20 = 9（窗口前）+ 11（窗口内），逐条核对一致 |
| MCP POST 占比 | 3/11 = 27%（若只算 tools/* 是 4/11；含通知 5/11） | 9/20 = 45% | 口径相同：path=`/mcp` & POST |
| MCP 方法分布 | tools/list ×2、tools/call ×2 | tools/list ×3、tools/call ×3、notifications/initialized ×2、initialize ×1 | 同一分类逻辑 |
| 上游工具 | execute_read ×2（窗口内）；全天 execute_read ×3 | execute_read ×3 | 完全一致 |
| 错误 | 0 个 MCP 错误；8 个 404/405 是 route 错误 | mcpErrors=0、routeErrors=8（9×404+2×405 含窗口前） | 同一 classifyError |
| 截断/溢出 | 0 / 0 | 0 / 0 | 同一 isTruncated/overflow 字段 |
| `execute_read` 耗时 | 513、724 ms | p50=724、p95=6228、avg=2488（含窗口前 6228 ms 那次） | 同一 `response.durationMs` |

### 3.3 不可比（不要硬比）

| 离线指标 | 为什么不能和在线窗口比 |
|---|---|
| `completionRate=76%` | 50 条 smoke task 的完成判定；在线只有 11 个 envelope，没有 task 边界、没有完成/失败标签，也没有对应的 runner 结果。样本单位不同（task vs HTTP request）。 |
| `searchHitRate=86.4%` / `toolHitRate=51.3%` | 需要“任务是否命中正确 tool”的标注；在线没有 `search` 调用（窗口内 tools/call 全是 `execute_read`，没有 `search`），也没有任务意图标签。 |
| `tokensPerTask=15691` | 离线按 runner 统计 token；capture 只记 `response.bytes`，没有模型 token 计数，且 bytes 不是 tokens。 |
| `p95LatencyMs=22025` | L1 的 p95 是端到端任务耗时（分钟级，这里 22 s）；在线的 p95=775 ms 是单 HTTP 请求耗时。两者量纲与观测边界不同。 |
| `gatewayAnomalyCount=21` / `anomalyCount=92` | 归因器基于 50 条 smoke 的异常标注；窗口内没有 anomaly 标签。且 AGENTS.md 规定免费模型/归因器输出只是待验证假设。 |
| B10 的“已修复/未解决”清单 | 是代码与文档层面的状态映射，不是运行时指标；需要写路径调用才能验证，窗口内没有。 |

**结论**：唯一能严格对齐的是「R2 envelope 层」的计数、状态、方法、耗时、截断；L1 的任务级指标和在线请求级指标之间**没有共同分母**，本报告不做比率换算。

---

## 4. B10 反馈哪些能被 capture 证实

| B10 反馈项 | capture 证据 | 判定 |
|---|---|---|
| 字段兜底（同一文件多形状：`content`/`resources[].text`/`text`） | `05d1b10d` 与 `0a099ec7` 的 `execute_read` 脚本里直接写 `cpRes.content \|\| cpRes.resources?.[0]?.text \|\| cpRes.text \|\| ""`；`10c13554` 里也有 `typeof rmRaw?.text === "string" ? rmR…` | **capture 可证实**（消费者侧确实在做兜底） |
| 大文件行级读取 / `sliceLines` | `10c13554` 脚本显式调用 `sliceLines`（两次）并读 README.md 前 30 行 / WORKFLOW.md 前 20 行；`05d1b10d`/`0a099eb0` 用 `cp.lastIndexOf` / `cp.indexOf` + `slice` 做片段截取 | **capture 可证实**（脚本层）；不能证明 helper 端到端正确 |
| 行号偏移 / `script line 2:1` 报错修复 | 窗口内没有脚本语法/行号报错 envelope（MCP errors=0、raw 里无 `script line`） | **capture 无法证实**，只能依据 B10 文档描述 |
| `sha` / commit / 变更清单 | 两次 `execute_read` 只读 `get_file_contents`，没有读取/写入 PR/commit/sha；全天 capture 也没有 | **capture 无法证实** |
| patch / `applyPatch` / dry-run / diff | 窗口内无任何 `replaceLines`/`applyPatch`/`diffSummary` 调用，`execute` 工具零调用 | **capture 无法证实**；只能靠用户描述 + B10 文档（`batch-10-canonical.md` 第 2/3/6 节明确说 helper 未接调用路径） |
| canonical adapter（B10 P0-1） | 返回文本里仍是 `{"result":{…}}` 自定义形状，未见 `normalizeResult` 输出字段；且 `batch-10-canonical.md` 明说未接入 | **capture 证实“尚未接入”** |
| 报错行号/截断元信息 | truncated=0、overflow=0，没有触发截断的结果 | **窗口内无样本可验证** |

总结：**能被 capture 直接证实的只有“读侧字段兜底 + 行级切片 + canonical 未接入”；写侧（branch/commit/PR/Issue/patch/sha/diff）与行号修复在本窗口完全没有运行时证据**，这部分只能引用用户描述和 B10 文档，且要明确标注“未经 capture 验证”。

---

## 5. 下一轮最小数据 / 埋点补充

按“最小且能回答同样问题”排序：

1. **capture 覆盖写路径（P0）**：确认 `execute` 工具的 `tools/call` envelope 是否进入 R2；本窗口 `execute` 零调用，无法区分“没调用”和“调用没采到”。做一个受控写回放（在测试仓库 `ensure_branch` → `create_or_update_file` → `create_pull_request`），验证 R2 里出现对应 `tools/call` 与 `response.raw`。
2. **上游事件 ↔ MCP 请求配对（P0）**：`116da831` 有 `upstream_http:github:8` 却没有配对的 MCP 方法，给每个 upstream event 加 `requestId` 关联字段（或把事件写进同一 envelope 的 `events[].requestId`），才能定位“哪个请求触发了哪些上游调用”。
3. **结构化变更清单（P1）**：写操作结果附带 `meta: {duration_ms, upstream_calls, branch, commitSha, prNumber, issueNumber, changedFiles[]}`（B10 文档 P2-10/11 已提出），这样 capture 直接能回答“PR #41–#48 是否由此网关产生”。
4. **窗口与任务锚点（P1）**：capture envelope 增加 `taskId` / `sessionId` / `userIntent` 摘要（脱敏），使在线请求能与离线 50 条 task 对齐；否则在线与 L1 永远无法比 completionRate。
5. **token / 意图标签（P2）**：若要做在线 vs 离线的 token/命中率对照，需要在 runner 侧记录 tokens 与 searchHit/toolHit 标注，不能从 `response.bytes` 反推。
6. **跨服务器归属（P2）**：在客户端侧给每次 GitHub 操作标记使用的 MCP server（本网关 vs 直连 GitHub MCP vs CLI），避免再次出现“capture 里没有就说是没发生”的误判。

---

## 6. 证据与复现

- 只读 join 脚本：`scripts/join-online-offline.mjs`（本次新建，仅 stdout 输出脱敏 JSON）。
- 原始 envelope 位于 R2：`capture/2026-11-22/<requestId>.json.gz`（`capture/2026-11-23/` 为空）。
- 关键 requestId（窗口内）：`1ffa01d7`、`116da831`、`1545fee3`、`05d1b10d`、`0a099ec7`、`0ee89ae5`、`00c596e9`、`11576fd0`、`0c17ef96`、`0ebb7bc6`、`117fbd93`（均为完整 UUID，见第 1.2 节表格）。
- 窗口前用于对照的 `execute_read`：`10c13554-6936-4a93-9ef2-9662fa55d1c6`（20:16:22.448Z，6228 ms，跨 5 个上游的只读探测）。
- 所有 token/key 均未写入本报告、脚本或输出文件；脚本只从环境变量读取凭据。

> 本报告遵守 AGENTS.md：免费模型/归因器的输出只作假设；本文所有结论只基于原始 envelope 的直接字段与已给时间线，没有据此改代码、开 issue、合并或部署。
