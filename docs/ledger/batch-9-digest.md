# Batch 9 — Capture Digest + Analyzer 质量提升与周审自动化

> 状态：已实现（工作区未提交）· 2026-11-23
> 范围：`scripts/capture-digest.mjs`、`scripts/analyze-captures.mjs`、两份测试、`.github/workflows/capture-daily.yml`、本文档、`docs/eval/ANALYZER-REVIEW.md`。
> 明确不改：`src/`、`explore/`、其他 workflows、README、CHANGELOG。

## 1. 做了什么

### Digest（确定性聚合）
- 保留原有 scorecard 字段：`requests`、`mcpRequests`、`nonMcpRequests`、`errors`、`mcpErrors`、`statuses`、`errorClasses`、`routeErrors`、`tools`、`upstreams`、`durations`、`bytes`、`truncated`、`overflow`、`p50Ms`、`p95Ms`、`avgMs`。
- 新增**每上游**（`upstreamStats[name]`）与**每 MCP 工具**（`toolStats[name]`）统计：`calls`、`errors`、`errorRate`、`p50Ms`、`p95Ms`、`avgMs`、`truncated`、`overflow`、`errorClasses`。
  - 上游名优先取 `upstream` 事件 `payload.server`；没有事件时回退到 `<server>__<tool>` 前缀，取不到记 `unknown`。
  - 旧字段 `upstreams` 仍按完整工具名计数，语义未变。
- 新增**截断/overflow 统计**：`isTruncated()` 同时识别 `response.truncated === true`、`response.overflow === true` 与线上显式标记（`--- TRUNCATED ---`、`…[truncated N]`、JSON 的 `"truncated":` 字段）；`truncationRate` / `overflowRate` 单独输出，避免把普通代码里出现 “truncated” 一词误判为截断。
- 新增**按天/按小时分布**：`byDay`（`YYYY-MM-DD`）、`byHour`（UTC `00`–`23`）、`byDayHour`，取自 envelope `ts`；缺时间戳时归 `unknown`，不猜时间。
- **非 MCP 路由仍单列**：`nonMcpRequests`、`routeErrors` 之外新增 `byRoute[method path]`，含调用数、错误、分位数与截断；绝不并入 MCP 错误率。
- 新增 `--since YYYY-MM-DD --days N` 范围聚合（`aggregateR2Range`），供周审复用；输出 `scorecard-<since>+<N>d.{md,json}`。

### Analyzer（免费模型，advisory-only）
- `buildAnalyzerInput()` 新增可选 `trend`（来自 `dailyTrend(envelopes)`）和 `upstreamErrorRates`（分母为该上游全部 MCP `tools/call`，而非只数失败）。样例新增 `truncated` 标记。
- `trend` 每行：`date`、`requests`、`mcpRequests`、`errors`、`errorRate`、`p50Ms`、`p95Ms`、`truncated`、`overflow`；只有多天输入才非空。单日调用保持 `trend: null`，旧消费者不受影响。
- `schema` 仍为 `analyzer-input.v1`；`validateAnalyzerOutput()` **逐字未改**，`policy=free-model-advisory-v1`、`advisoryOnly=true`、`requiresHumanReview=true` 不变。
- 新增纯函数 `renderWeeklyReview()` 与 `isoWeek()`：周报只渲染**候选（candidate）+ 证据 requestId（最多 5 条/候选）**，不含补丁、不开 issue、不自动改代码。
- CLI 支持 `--since/--days`；周审用 `--dry-run`，不调用模型。

### Workflow
- `capture-daily` 保留每日 digest + analyzer candidate（模型失败 `continue-on-error`，不阻塞 scorecard）。
- 新增每周一 `0 3 * * 1` 的 `weekly-review` job：过去 7 天 R2 → 范围 digest → `--dry-run` analyzer input → 生成 `docs/eval/weekly-YYYY-WW.md` → artifact（30 天）+ 仅提交该文档。**不开 issue、不改代码、不部署。**
- `workflow_dispatch` 同时触发两个 job，便于手动补跑。

## 2. 质量闸门与阈值/噪声

| 信号 | 阈值/规则 | 噪声来源与处理 |
|---|---|---|
| 每上游/每工具错误率 | 只作候选排序信号；**不设自动动作阈值** | 分母过小时（<10 calls）先人工确认，低样本不升级 severity |
| 跨天趋势 | 只有 ≥2 天数据才输出；单日 `trend: null` | 周末/低流量日会制造假趋势，周报里以证据 id 为准，不用趋势直接定性 |
| 截断 | 仅认显式标记与 flag | 代码正文出现 “truncated” 单词不算；`overflow` 单独计数，不与截断混为一谈 |
| 非 MCP 路由 | 单独 `byRoute` / `routeErrors` | `/healthz`、OAuth、405 探针不计入 MCP 错误率，避免污染上游归因 |
| 免费模型输出 | validator 拒收即丢弃 | 无证据 id、枚举外 category/severity、超长字段一律过滤；最多 5 条 |

## 3. 测试

- `tests/capture-digest.test.js`：新增 5 个用例（分上游/分工具统计与分位数、前缀回退、截断/overflow、按天按小时、非 MCP 单列），共 7 个。
- `tests/capture-analyzer.test.js`：新增 5 个用例（多天 `dailyTrend`、跨天趋势 + 每上游错误率、上游口径来自 events、ISO 周键、周报渲染含证据 id 上限 5 且无补丁），共 10 个。
- 两文件合计 17 个用例，定向 `node --test` 全绿。
- 全量 `npm test`：**512/512 通过、0 失败**（含其他 agent 并发新增的 b10 / capture-http / l1-real 用例；本批改动未导致任何失败）。

## 4. 风险与后续

- **周审 candidate 来自确定性聚类，不经过免费模型**：优点是便宜、可复现、无幻觉；缺点是语义标签弱（`P3/unknown`），需要人审改写成真实 issue。
- **周报自动提交文档**：只 `git add docs/eval/weekly-*.md` 和当天 scorecard，不碰 `src/`；若 bot 无写权限，job 会失败但不影响 daily digest。
- **R2 读取范围**：`--since` 按 UTC 日前缀列举 7 个 prefix；若某天无 envelope，该天在趋势中不会补零（周报总数仍能对上），后续可按需补零。
- **validator 不变**：新增 `upstreamErrorRates` 的样本 id 不进入 validator 证据白名单，模型不能靠上游统计行“合法化”编造 issue；若需要引用，必须先出现在 cluster/sample 中。
- 未做：自动开 issue、自动修复、自动部署、契约文档变更（按 AGENTS.md 约定 Code Mode 以源码为准）。
