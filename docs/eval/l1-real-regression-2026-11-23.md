# L1 real regression root-cause investigation — 2026-11-23

> 只读调查。未改动 `src/`、`scripts/`、`tests/`、CI 或已有文档；唯一新增文件是本文件。
> 未 commit / push / deploy。日志与 artifact 下载到 `%TEMP%\l1-real-investigation\`（仓库外），
> 以下证据中的 `log-4508xxxxxxx.txt:<行号>` 指 `gh run view <run> --log` 的完整日志副本，
> `artifact/...:<行号>` 指 `gh api repos/Bruce-Yii/gemini-mcp-gateway/actions/runs/<run>/artifacts`
> 下载并解压的同名文件内容。

## 0. 结论摘要（TL;DR）

1. **本次 FAIL 不是 23:44Z→23:51Z 之间新出现的 gateway 编码回归。** 两次 run 的
   upstream 状态完全相同（notion/vercel 均连接失败，github/linear 均连接成功，工具数
   `{github:42,linear:36}`），逐任务 anomaly 形态也几乎相同（50 vs 52 条、gateway 归属
   8 vs 7）。23:44Z 之所以 PASS，是因为那次 run 的 baseline 就是它自己（自引用 bug）；
   它的裸指标 searchHit 50% / toolHit 31% 已经远低于冻结基线 82.4% / 53.3%。
   证据：run 45084689061 artifact `l1-real-2026-11-22.json:30-45`（baseline.source =
   `G6 run run-1795390959459-1f2715c1 ...`，即当前 run id）；run 45085493847
   artifact 同名文件 `:31`（baseline.source = 冻结快照）、`:73-90`（仅 searchHit/toolHit 失败）；
   两次日志的 upstream 段（见 §2）。
2. **可归因于环境/口径：冻结基线是"5 个 server 全部连通"的 G6 采样（manifest 里
   notion=47、vercel=62 个工具），而两次 real run 都只有 2/4 连通且 notion/vercel 暴露 0 个
   工具。** notion/vercel 的 20 个任务，其 expected tool 全部属于失败 server；`search()` 只检索
   `upstreamManager.getEntries()` 中已挂载的工具，因此这些 expected tool 不可能出现在
   搜索结果中，searchHit/toolHit 必然系统性下降。证据：
   `explore/results/manifest.json:11-24`（基线 serverToolCounts）；
   `src/codemode.js:1264,1285-1290`；失败 run 日志 `log-45085493847.txt:201-206`。
3. **指标定义存在两处放大/掩盖效应的 harness 缺陷**（不是本次 FAIL 的唯一原因，但影响归因）：
   - searchHit/toolHit 的分母只计"模型实际调用了 search / execute(_read) 且任务有 expectedTool"
     的任务；没调用就记为 `null` 并从分母剔除，失败 server 的任务因此有时被算入、有时被
     剔除。基线分母 34/30，失败 run 分母反推为 36/31。
     证据：`explore/run-explore.mjs:370-385,562-584`；
     `scripts/run-l1-smoke.mjs:83-96`。
   - `applyServerCoverage()` 会把"server 暴露 0 工具"时本属 gateway 的 anomaly 降级为
     infra，所以 notion/vercel 故障不会推高 gatewayAnomalyCount（8 < 基线 18）。
     证据：`explore/trace.mjs:219-237`；`explore/run-explore.mjs:155-158`；
     artifact `l1-real-2026-11-22.json:22,38`。
4. **不可归因于"gateway 搜索/工具选择代码回归"**：基线 run（6b4254c）到失败 run
   （3fa7a53）之间 `src/catalog.js` 未改动，search 工具描述与 `searchWithFallback` 调用路径
   未改动；23:44Z（d6cdbd9）到 23:51Z（3fa7a53）之间只改了基线冻结/文档/捕获代码，
   没有改 `explore/run-explore.mjs`、`src/codemode.js` 或 `src/catalog.js`。
   证据：`git diff --stat d6cdbd9..3fa7a53`；`git diff --stat 6b4254c..3fa7a53 -- src/catalog.js`（空）。
5. **FAIL 可归因的组合**：环境（notion/vercel token 失效）+ 基线口径不匹配（全连通基线 vs
   半连通 real）+ 免费模型选择波动（同环境两次裸指标 50→44.4、31→32.3）+ 指标分母定义。
   当前证据**不足以**证明 gateway 搜索排序或工具选择发生代码级回归。

## 1. 两次 run 与 artifact 对账

| 项目 | 23:44Z（自引用 bug） | 23:51Z（冻结基线，FAIL） |
|---|---|---|
| GitHub run id | 45084689061 | 45085493847 |
| headSha | d6cdbd9 | 3fa7a53 |
| explore runId | `run-1795390959459-1f2715c1` | `run-1795391502089-4a996abb` |
| conclusion | success（假阳性 PASS） | failure |
| completion / anomalies | 90% / 7 | 90% / 8 |
| searchHit / toolHit | 50 / 31 | 44.4 / 32.3 |
| tokens/task / p95 | 14613 / 17463 | 14728 / 19668 |
| gatewayAnomalies | 7 | 8 |

证据：
- `gh run view 45084689061 --json ...`：conclusion=success, headSha=d6cdbd9；
  `gh run view 45085493847 --json ...`：conclusion=failure, headSha=3fa7a53（run metadata）。
- artifact（两次均名 `l1-smoke-real-2026-11-22`，id 14778986454 / 14778881987）中
  `l1-real-2026-11-22.json`：前者 `:17-28` metrics、`:31-44` baseline（source 含自己 runId，
  current===baseline 全部 pass，`:47-110`）；后者 `:17-28` metrics、`:30-47` baseline
  （`byServer snapshot ... run-1795368949291-1d86ee2a`）、`:49-113` 仅 searchHit/toolHit fail。
- 日志 `log-45085493847.txt:255-258`：`FAIL ... searchHit=44.4% toolHit=32.3%` +
  两条 `REGRESSION`。

## 2. 上游可用性：两次 real run 相同，基线不同

- 失败 run：`log-45085493847.txt:192-205` — notion 401/invalid_token 强制刷新后重连失败；
  vercel `invalid_token`；`2/4 upstreams failed: notion, vercel`；
  `upstreams connected: github,linear | failed: notion,vercel`；
  `tools exposed per server: {"github":42,"linear":36}`。
- 自引用 run：`log-45084689061.txt`（"L1 smoke (real upstreams)" 段，约 :190-200）
  同样的 vercel `invalid_token`、notion 401、`2/4 upstreams failed: vercel, notion`、
  `tools exposed per server: {"github":42,"linear":36}`。
- 冻结基线：`explore/results/manifest.json:5-24` — runId `run-1795368949291-1d86ee2a`、
  gitSha `6b4254c`、servers 含 5 个、`serverToolCounts` 为
  `{figma:46,notion:47,github:42,linear:36,vercel:62}`。
- 代码路径：`src/codemode.js:1264` `const tools = upstreamManager.getEntries()`；
  `:1285-1290` `searchWithFallback(tools, ...)` → `matches: res.matches.map(...)`。
  即未挂载的 server 的工具不进入搜索索引，且 `servicesSnapshot()` 会把它标为 offline
  （`src/codemode.js:1195-1253`）。

**判断**：notion/vercel 上游不可用确实能造成 searchHit/toolHit 下降，但它不能单独解释
"FAIL"事件——同样的不可用已经在 23:44Z 存在，只是被自引用基线掩盖。

## 3. searchHit / toolHit / anomalies 的定义与分母问题

1. `expectedTool = task.tool`（`explore/run-explore.mjs:290`；40 个 smoke 任务全部有 tool，
   见 `explore/tasks-smoke.json` 每条任务的 `"tool"` 字段，例如 `:43-46` F010=get_commit、
   `:52-55` F014=get_me）。
2. `searchHit`：仅在模型调用 `search` 时计算；对 `matches` 用 `toolNameMatches()` 匹配
   expectedTool，匹配成功写 `true`，否则写 `false`；从未调用 search 则保持 `null`
   （`explore/run-explore.mjs:364-377`）。`toolNameMatches` 是宽松子串匹配
   （`explore/trace.mjs:247-253`）。
3. `toolHit`：仅在模型调用 `execute/execute_read` 时，从代码文本里抽取
   `codemode.<name>` 名称，与 expectedTool 做小写 includes 匹配；未调用则 `null`
   （`explore/run-explore.mjs:379-385`）。这是弱诊断信号：它可能把"搜索没找到但代码里提到了
   名字"算成命中，反之也可能漏掉用别名调用的成功执行。
4. 汇总时分母是 `searchHit !== null` / `toolHit !== null` 的行
   （`explore/run-explore.mjs:562-584`），再由 `metricsFromExplore()` 直接取率
   （`scripts/run-l1-smoke.mjs:83-96`）。**失败 server 的任务不是被自动排除**：只要模型调了
   search，就会作为 `false` 进入分母；而当模型因工具不可用而直接放弃（no_tool_call /
   direct_answer）时，反而作为 `null` 被剔除。
5. 基线 40 任务实际分母：search 34、tool 30（用本地
   `explore/results/metrics.json` + `tasks-smoke.json` 复算：search 28/34=82.4%，
   tool 16/30=53.3%）。失败 run 的报告值只能由 search 16/36=44.4%、tool 10/31=32.3%
   得到，说明分母也发生了漂移（更多失败-server 任务调用了工具但没命中）。证据：
   artifact 失败 run `l1-real-2026-11-22.json:24-25`；`log-45085493847.txt:254`
   中 `toolRecall` 段：`tasksWithExpectedTool:40, searchHitRate:44.4, toolHitRate:32.3`。
6. anomaly 计数：`completionRate` 用 "无 runner_error / max_turns_exceeded" 的 proxy
   （`scripts/run-l1-smoke.mjs:73-99`）；gatewayAnomalyCount 只数 `attribution==='gateway'`
   的 anomaly（`:82`）。而 server 暴露 0 工具时 `applyServerCoverage()` 把 gateway 归属降级为
   infra（`explore/trace.mjs:225-237`），所以上游故障本身不会体现在 gateway 异常里。

## 4. 具体失败 task 证据（3–5 个）

说明：CI artifact 只上传报告（`l1-smoke*` + `l1-real*`），**没有上传 explore/results/traces**，
所以 23:51Z run 的逐任务 expected/actual tool 明细不在日志中；以下用
（a）失败 run 日志的逐任务行、（b）本地保留的基线 run trace（同 task id、server 连通时
的实际搜索结果）、（c）任务定义三方交叉举证。"actual tool"一栏若无失败 run trace，
明确标注为基线 trace 中的观测，不伪造。

| # | task / server | expected tool | 23:51Z 失败 run 证据 | 基线 trace（server 在线）中的实际行为 | anomaly |
|---|---|---|---|---|---|
| 1 | **F048** / notion, read | `notion-download-attachment`（`explore/tasks-smoke.json:135-142`） | `log-45085493847.txt:218`：`tools=2 tokens=9652 turns=3 anomalies=0`；notion 暴露 0 工具（`log:201-205`） | 基线 trace `explore/results/traces/F048.json`：searchCalls=0、searchHit=null、直接回答；说明该任务本就脆弱；失败 run 中 tools=2（至少发生了工具调用，具体工具名未上传 trace），但在 notion 暴露 0 工具的前提下 `download-attachment` 不可能被搜到 | 失败 run 0；基线 3（model_confusion / direct_answer / no_tool_call） |
| 2 | **F080** / notion, read | `notion-view-version`（`explore/tasks-smoke.json:153`） | `log-45085493847.txt:221`：`tools=2 tokens=6512 turns=2 anomalies=0`，而基线该任务 37857 tokens / 3 anomalies | 基线 trace `traces/F080.json`：第 0 轮 search 返回 `notion__notion-view-version`（第 8 项），searchHit=true、searchHitAt3=false、toolHit=false；离线时该条目不存在 | 失败 run 0；基线 3（max_turns_exceeded + 2×retry） |
| 3 | **F088** / notion, read | `notion-calendar-list-contacts`（`explore/tasks-smoke.json:173`） | `log-45085493847.txt:226`：`tools=3 tokens=9118 turns=3 anomalies=2`；基线同任务 28798 tokens | 基线 trace `traces/F088.json`：两次 search 均未返回 expected tool（searchHit=false）；第 4 轮 `execute_read` 报 `execute error: This tool requires a Business plan or higher`，attribution=gateway；离线后连该错误都不会出现 | 失败 run 2；基线 3（execute_error + 2×retry） |
| 4 | **F134** / vercel, cross | `open_deployments`（`explore/tasks-smoke.json:400`） | `log-45085493847.txt:245`：`tools=0 tokens=2581 turns=1 anomalies=3`；vercel 暴露 0 工具 | 基线 trace `traces/F134.json`：search 命中 github 工具，execute_read 实际返回了 deployments 数据（但 `codemode.open_deployments` 调用记录缺失，toolHit=false） | 失败 run 3；基线 1（retry） |
| 5 | **F139** / vercel, write | `get_access_to_vercel_url`（`explore/tasks-smoke.json:409`） | `log-45085493847.txt:248`：`tools=3 tokens=11413 turns=4 anomalies=1` | 基线 `explore/results/metrics.json` 中 F139：searchHit=true、toolHit=true；失败 run 中 vercel 工具不可挂载，该 expected tool 不可能被 search 返回 | 失败 run 1；基线 1 |

补充：失败 run 中唯一显著新增的 gateway 归属异常聚集在
`log-45085493847.txt:217`（F020，anomalies=3，基线 1，tokens 43315 vs 基线 28212）
和 `:239`（F106，anomalies=1，基线 2），二者均为 github/linear（在线 server）任务，
更符合免费模型波动而非 gateway 代码回归。`byAttribution {"model":40,"gateway":8,"infra":2}`
见 `log-45085493847.txt:252`，与 23:44Z 的 `{"model":43,"gateway":7,"infra":2}`
（`log-45084689061.txt`，"DONE"/"byAttribution" 行）相近。

## 5. 可归因 / 不可归因判定与后续动作

### 可归因（高置信）
- **FAIL 事件的可见性**：自引用基线 bug 已修复；23:44Z 的 PASS 是假阳性，不能用作"之前正常"的证据。
  证据：artifact 两次 `l1-real-2026-11-22.json` 的 baseline.source（前者 `:31`，后者 `:31`）。
- **指标下降的环境部分**：冻结基线（5 server 全连通）与 real run（2/4 连通）口径不一致，
  notion/vercel 的 expected tool 无法进入搜索索引，searchHit/toolHit 系统性偏低。
  证据：`explore/results/manifest.json:11-24`；`log-45085493847.txt:201-205`；
  `src/codemode.js:1264,1285-1290`。
- **间接证据**：两次 real run raw 指标波动（searchHit 50→44.4、toolHit 31→32.3）来自
  免费模型/运行时非确定性（temperature=0 但 `hy4-flash-free` 仍非确定性，见
  `explore/run-explore.mjs:60-67,178-184`；两次 upstream 状态一致、代码一致）。
  证据：`git diff --stat d6cdbd9..3fa7a53`（无 search/harness 改动）；两次日志 metrics 行。

### 不可归因 / 证据不足
- **不能断言 gateway 搜索排序或工具选择代码回归**：基线后的 `src/catalog.js` 零改动；
  search 工具描述与 `searchWithFallback` 路径零改动；两次 real run 的代码只差基线冻结相关文件。
  需要失败 run 的逐任务 trace 才能最终排除（当前 CI 未上传）。
- **不能把 gatewayAnomalyCount=8 当作"网关没问题"的证据**：0-工具 server 的 anomaly 被
  `applyServerCoverage()` 降级为 infra（`explore/trace.mjs:225-237`）。
- **不能用 23:44Z 的 PASS 来判定 23:51Z 是"新回归"**（见上）。

### 需要补的修复 / 测试（建议，本次未实施）
1. **CI 前置健康检查 + skip 而非 FAIL**：real 模式在 `mgr.connect()` 后若任一目标 server
   在 `failedServers` 中，应打印明确的 `degraded upstreams` 标记并把该 server 的任务标为
   skipped（或选择与之匹配的退化基线），而不是用全连通基线比较。
   现有基础设施：`explore/run-explore.mjs:159-163` 已记录 failedServers / serverToolCounts，
   `scripts/run-l1-smoke.mjs:328` 已支持按 server 选择基线。
2. **冻结"按可用 server 组合"的退化基线**：在 `explore/baselines/l1-smoke.json` 增加
   `github,linear` 子集快照（需先采集一次全连通以外的可信 run），避免用 40 任务全量基线
   与 20 任务有效基线比较。
3. **修正 hit-rate 分母**：把"调用了 search 但 miss"与"从未调用 search"都计入分母
   （或至少分别报告 coverage-adjusted rate 与原始 rate），并新增单测覆盖
   "failed server task must stay in denominator"。当前 null-剔除逻辑在
   `explore/run-explore.mjs:562-584`。
4. **逐任务 trace 上传 artifact**：CI workflow 的 `Upload L1 report` 只上传 `docs/eval/*`
   （见 `.github/workflows/l1-smoke.yml` 的 upload 段；`log-45085493847.txt:260-274`
   显示只有 5 个文件）。应额外上传 `explore/results/traces/*`、
   `metrics.json`、`anomalies.json`、`manifest.json`，否则每次 FAIL 都无法做 task-level 归因。
5. **token 失效的快速失败/告警**：notion 401 与 vercel `invalid_token` 在两次 run 均出现；
   建议在 real smoke 开始前做轻量 token 检查并在凭据失效时明确报
   `REAUTH_REQUIRED`，避免把凭据问题混同为 gateway 回归。
6. 所有上述修复需按项目规则先写确定性回归测试，再改代码，并用 fake/replay 与一次 real
   smoke 验证；模型输出不能作为结论依据。

### 下一步最小验证（不触发写操作，不部署）
1. 先人工刷新 notion / vercel 凭据（vault 中的 token），本地确认 4/4 upstream 可连接。
2. 重跑一次同样命令：
   `node scripts/run-l1-smoke.mjs --mode real --servers github,notion,linear,vercel --date 2026-11-23`
   并确认日志中 `upstreams connected: github,notion,linear,vercel`、
   `tools exposed per server` 含 notion/vercel 非零值。
3. 若 4/4 连通后 searchHit/toolHit 回到基线容差内（≥72.4 / ≥43.3），即可确认本次 FAIL
   为上游+口径问题；若仍低，再用新 run 上传的 trace 做逐任务归因并排查搜索排序。
4. 若暂时无法恢复凭据，最小替代验证是本地用 `--mode replay` 对 23:51Z 的
   artifacts 重算指标，确认 44.4 / 32.3 可复现（无需真实网络），并检查修正分母后的
   coverage-adjusted rate，用于量化口径影响。

## 6. 证据索引

- GitHub run 元数据：`gh run view 45085493847` / `gh run view 45084689061`。
- 完整日志（本地副本）：`%TEMP%\l1-real-investigation\log-45085493847.txt`、
  `...\log-45084689061.txt`。关键行：192-206（上游失败）、207-248（逐任务）、
  250-254（汇总）、255-258（FAIL 与两条 REGRESSION）。
- Artifact（本地副本）：
  `%TEMP%\l1-real-investigation\run-45085493847\unzipped\l1-real-2026-11-22.json`、
  `...\run-45084689061\unzipped\l1-real-2026-11-22.json`（artifact id 14778881987 / 14778986454）。
- 冻结基线：`explore/baselines/l1-smoke.json:1-7,20-24,34-68,83-96`；
  原始 run 产物 `explore/results/manifest.json:5-24`、`explore/results/metrics.json`
  （本地 40-task 复算见 §3.5）。
- 代码：`explore/run-explore.mjs:124-125,141-165,290,364-385,562-584`；
  `explore/trace.mjs:209-237,247-253`；
  `scripts/run-l1-smoke.mjs:73-99,131-158,328-384`；
  `src/codemode.js:1195-1253,1264,1285-1290`。
- 现有背景文档：`docs/eval/l1-real-2026-11-22.md:5-22,33-72`。
