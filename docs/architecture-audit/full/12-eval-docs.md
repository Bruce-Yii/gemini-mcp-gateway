# 12 — docs/eval 全量逐文件深读审计（41 文件）

> 审计日期：2026-11-24（Asia/Singapore）· 只读任务：逐文件读完 `docs/eval` 下全部 tracked 文件，**不动代码、不 commit / push / deploy**。
> 审计框架：`docs/FRAMEWORK.md` §3/§4/§13.2/§13.3/§13.7（离线权威集、主动>被动、工具级真值、session/project/task 交叉、capture 自动线、baseline、replay、join、scorecard、安全/权限）。
> 证据标签：**[代码]** = 本轮实际打开源码/配置核对；**[文档]** = 文件自身陈述；**[测试]** = 文档声称的测试结果（本轮未重跑）；**[未验证]** = 无证据或证据链断裂，绝不写成事实。
> 本轮 `git status --short` 起始显示 `?? docs/architecture-audit/full/`（同目录另有 10-ledger-a.md，非本任务产物）；本文件是新增文件，未触碰其它路径。

---

## 0. 清单与覆盖率（硬要求 1）

`git ls-files docs/eval` 输出 **41 个 tracked 文件**（本报告逐字取自该命令）。

| 项 | 数值 |
|---|---:|
| expected（git ls-files） | 41 |
| read（本轮 `read` 工具逐文件全文打开） | 41 |
| unread | 0 |
| 其中 Markdown | 34 |
| 其中 JSON | 7 |
| 总字节（工作树 `Get-Item.Length`） | 约 566 KB（逐文件字节见 §1） |

覆盖率判定：**41/41，expected = read，unread = 0**。所有文件按完整内容读取（大型文件分段读完，最后一段读到 EOF 行号）；未用 grep/标题代替阅读。grep 仅用于交叉验证代码事实（见 §3.1），不是文件阅读手段。

---

## 1. 逐文件阅读记录（硬要求 2）

格式：`路径` — 字节 / 读完 / 关键结论。结论均为文档自身内容或明确标注的交叉验证。

### 1.1 索引与分析器（6 文件）

1. **`docs/eval/README.md`** — 1,457 B / 读完 / 索引指向 `../EVALUATION.md`；列在线反馈、半在线缺口/join、runner、安全/平台文档；末尾「未完成/阻塞」写 `l1-task-wire` 与 `online-replay-harness` **进行中**。以 2026-11-22/23 为时间锚，未随后续接线文档更新（stale 索引，[文档]）。
2. **`docs/eval/ANALYZER-REVIEW.md`** — 2,788 B / 读完 / 免费模型建议的人工闸门 checklist；周审 `capture-daily.yml` 每周一 `0 3 * * 1` 跑 `--dry-run`（不调模型），只产确定性聚类候选；阈值表明确「分母<10 不下结论、截断只认显式标记、非 MCP 路由单列」；禁止模型候选直接生成 PR/issue/改配置。`validateAnalyzerOutput()` 是本仓库唯一闸门（[文档]，未重新核对代码）。
3. **`docs/eval/VERCEL-CIMD-BLOCKER.md`** — 1,686 B / 读完 / 2026-11-23 CIMD 外部验收 BLOCKED；本地 tunnel、alias、public gist、Notion control 四组实验：Notion control 到达 PKCE 阶段（证明 Vercel CIMD 机制本身工作），我方三种 CIMD 均 `Invalid client_id`；结论「不是网关 OAuth bug」但生产 BLOCKED，三条解除条件（预注册 client / 未复现的 validator 要求 / 稳定域名托管；当时 Vercel 配额耗尽不可测）。明确「不要告诉用户 Vercel auth 已就绪」。
4. **`docs/eval/weekly-2026-46.md`** — 1,012 B / 读完 / 自动生成周报，窗口 2026-11-15+7d，**全 0**（0 requests / 0 candidates），`trend` 空；四项目审 gate 全未勾选；advisory only。
5. **`docs/eval/weekly-2026-47.md`** — 1,184 B / 读完 / 窗口 2026-11-16+7d：20 requests / 14 MCP / 6 errors / error rate 0.3；唯一候选 W1 `model_truncation_suspect`（3 hits，P3/unknown，附 3 个 requestId）。拒绝按 error rate 0.3 直接判系统故障；周报只列候选。
6. **`docs/eval/session-marker-2026-11-23.md`** — 1,967 B / 读完 / `Mcp-Session-Id` 由网关生成、客户端回传，仅 capture/eval 关联用；stateless（`sessionIdGenerator: undefined`）；capture 同时记 `clientInfo`；Gemini 实测回传同一 ID。**stale 数字**：称「全量 550 项通过」，与 AGENTS.md 当前基线 1406 tests 明显不同（[文档]）。文件第 28 行混入字面 `\n` 转义（未渲染的换行），markdown 格式缺陷。边界：现代 MCP（2026-07-28）已移除 session 头，未来需 clientInfo 兜底。

### 1.2 验收 JSON 与冒烟产物（6 文件）

7. **`docs/eval/acceptance-2026-11-24/env-isolation-result.json`** — 1,304 B / 读完 / **`ok:false`**：4 条 P0 `shared-record` 违规（PUBLIC_BASE_URL、UPSTASH_REDIS_REST_TOKEN、UPSTASH_REDIS_REST_URL、REDIS_URL），同一 env record 同时指向 production 与 preview，即同凭据跨环境复用。与 AGENTS.md §0「preview/production KV 隔离检查脚本已部署」存在张力：有检查脚本不等于隔离违规已修（[文档]/[未验证]）。
8. **`docs/eval/acceptance-2026-11-24/tools-list-results.json`** — 1,078 B / 读完 / `generatedAt 2026-11-23T18:40:38Z`：github 28 tools ok、linear 60 tools ok、figma 51 tools ok；**notion `ok:false`（0 tools，空错误体）**、**vercel `ok:false`（HTTP_401 invalid_token）**。注意 figma 出现在验收结果里，但 FRAMEWORK 上游清单是 GitHub/Notion/Linear/Vercel（figma 只是 L1 默认跳过的第 5 server）。这是被埋掉的"2/5 上游不可用"质量信号。
9. **`docs/eval/acceptance-2026-11-24/write-loop-report.json`** — 3,221 B / 读完 / 真实 GitHub 写回环 9 步：read/create-branch/dry-run/real-write/verify/failure-no-write/add-ci/create-pr 均 ok；`actual.pullRequest` 中 `number:null, urlNumber:1, matches:false`，**`pass:false`**，错误是 `REST .../pulls/undefined -> 404`（number 反复用 id / 未从 URL 解析的直接证据）。`readShape.hasNoticeInContent:false` 与 `truncated:false`；`failureCase.noHalfWritten:true`。
10. **`docs/eval/acceptance-2026-11-24/write-loop-verify.json`** — 3,128 B / 读完 / 同一 run 的复核：`pass:true`，PR 通过 URL 找到 #1（`prNumberFromUrl:true`），writtenFile 52 bytes 匹配 dryRun，但你写文件无 notice；**`ci.conclusion:"failure"`、`billingBlocked:true`、annotation 为 GitHub 账号付款失败/额度不足**——验证写路径通过但 CI 未跑，不能写"端到端 CI 绿"。`ciVerdict:"BLOCKED_BY_GITHUB_BILLING"`。
11. **`docs/eval/l1-smoke-report.md`** — 1,190 B / 读完 / 标题 `L1 Smoke Report`，**Result: PASS**、50/50、所有指标与 baseline 完全相同（100% / 0 / 0ms tokens）；尾部 caveat 写明 `fake-dry-run`：确定性仿真、无模型/上游调用、只验 runner+compare+report 接线，**不得读作网关质量**。典型"测试绿≠完成"陷阱。
12. **`docs/eval/l1-smoke.json`** — 2,841 B / 读完 / 同上机器可读版：`mode:"fake-dry-run"`、`ok:true`、`metrics.source` 与 `baseline.source` 都标 deterministic simulation、`datasetSha256:null`、6 项 comparison 全 pass 但 current===baseline===0/100。无真实捕获与数据集指纹。

### 1.3 Scorecard 与日级报表（4 文件）

13. **`docs/eval/scorecard-2026-11-22.md`** — 2,036 B / 读完 / 20 requests / 9 MCP POST / 11 非 MCP / 11 HTTP errors 但 **mcpErrors=0**；`GET /` 9×404 与 `GET /mcp` 2×405 单列；execute_read ×3；p95 775ms（全天最慢 6228ms 在 github）；truncated/overflow 0。
14. **`docs/eval/scorecard-2026-11-22.json`** — 2,638 B / 读完 / 上者机器源：statuses `{200:7,202:2,404:9,405:2}`、`durations` 数组含 6228、`byRoute` 与 `upstreamStats`（github 3 calls / unknown 6）逐项可分。注意 `upstreamStats.unknown` 6 calls 其实是握手/通知类，不应误读为上游调用。
15. **`docs/eval/scorecard-2026-11-23.md`** — 9,349 B / 读完 / 20 requests / 20 MCP / 3 errors（auth 1 + upstream_4xx 2）；**`Model truncation suspects (silent): 9`，rate 0.45，全部 github、execute_read 5 / execute 4**；wire truncated 0、overflow 0——三个独立信号不混算。`By client platform (batch 13)` 表 **20/20 全落 `unknown`**（旧 envelope 无字段，不猜平台）；project 标签 `github:Bruce-Yii/recruitment-agent` 10 requests 跨多 window；session 表 7 真 sessionId + 5 `window:*` 合成窗口（idle-gap / first-request）。文件明确「共享 project key 不证明同一 client 或同一 task」（[文档]）。**被埋的质量信号：45% 静默截断嫌疑被标 advisory-only，却没有任何后续 J/T 任务专门消费它**（见 §3.4）。
16. **`docs/eval/scorecard-2026-11-23.json`** — 20,133 B / 读完 / 上者机器源：`byClientPlatform.unknown` 20 requests / 7 sessions / 1 project / 9 truncation suspects；`projectTimelines` 的 `sessionId:null` 但跨窗 handoff 可见；`durations` 最大 5213ms。重要细节：`sessions[]` 每项 `taskId:null`（task 维度实际未落），`clientInfo` 有的只是 IP（如 `{"ip":"192.178.23.41"}`）——session/task/project 交叉目前是分析侧推导，不是完整采集字段。

### 1.4 真实回放 / 捕获验证（4 文件）

17. **`docs/eval/l1-real-2026-11-22.md`** — 2,956 B / 读完 / L1 真实基线冻结说明，不是 PASS 报告。记录并修复自引用 bug：`deriveBaselineForServers()` 原先读当前 run 产物导致 baseline===current 恒 pass；现只读 `explore/baselines/l1-smoke.json`。冻结 50 条（completion 76%、gatewayAnomaly 21、searchHit 86.4%、toolHit 51.3%、tokens/task 15691、p95 22025）与 40 条 serverSets（77.5% 等）及 byServer（notion completion 50%、toolHit 0%；linear anomalies 8）；完成率用 anomaly proxy 而非 `finished`。
18. **`docs/eval/capture-verification-2026-11-23.md`** — 1,716 B / 读完 / 修复后首次 `ack→done→sink_ok→R2 object` 全链路对账（requestId `602f4012-…`，build `8100971b…`）；R2 对象含 README 前 10 行与 upstream/sandbox events。根因三层（waitUntil 在 queueMicrotask / originalEnd 顺序 / Vercel 保留不可靠 → `CAPTURE_SYNC=1`）；代价：每 `/mcp` 请求 +0.4–0.5s。捕获自动线的关键证据（[文档]）。
19. **`docs/eval/write-replay-2026-11-23.md`** — 2,526 B / 读完 / 真实 GitHub 写回放（本地 UpstreamManager→createCodeModeTools→execute→applyFilePatch）6 步通过并清理分支；抓到 3 个 fake 测试没覆盖的真实 bug：下载提示混入 `content`、blob sha 未从 notice 提取、写结果嵌套 `{content:{sha},commit:{sha}}` 未解析。结论「真实回放抓到单测盲区」；多文件写仍非事务性（中途失败可能留前序文件）。与 acceptance write-loop 的 `number:null` 失败形成互补证据。
20. **`docs/eval/REAL-GH-REPLAY.md`** — 5,650 B / 读完 / 2026-11-23 只读真实 GitHub 回放：PR number/id 分离 + Actions 415/302 helper 修复；`overallOk:true`；14/14 fake 测试 pass；无 commit/push/deploy。**重大证据瑕疵 [未验证]**：文中「真实结果」表的 PR `html_url` 全部为 `https://github.com/example-org/example-repo/pull/53` 等占位域名，`id` 为 `1000000001` 等示例值；与在线反馈记录里 `{id:1000000001, url:.../pull/53}` 的 fixture 形状完全一致。看起来是脱敏后未标注的样例，却以「真实结果」名义呈现；不能作为"真实 PR #53 回放已完成"的证据。另 `saw302:false` 已如实说明 302 由 fetch 自动跟随、显式分支仅 fake 覆盖。

### 1.5 在线反馈（3 文件）

21. **`docs/eval/online-feedback-2026-11-23.md`** — 9,180 B / 读完 / 第一批（Gemini 用户报告）：F1 下载提示混入正文（PR #56/#57）标 `confirmed` 但 CaptureVerified:false；F2 branch 被静默忽略 `unverified`；F3 PR number=id `fixed`（21 项定向测试）、F4 name/branch 别名 `fixed`、F5 method 枚举缺失 `unverified`、F6 Actions 日志 + 重连 `unverified`、F7 正面项 `confirmed`。整批 `Status: unverified`；不可比项明确（durationMs≠p95、bytes≠tokens）。**ID 命名空间冲突**：此处 F2=branch 被忽略、F3=PR number；Gemini 专档 F1=下载提示、F2=PR number；ChatGPT 档 F1=415。同一天三份记录 F<n> 语义不同，join 文档以 Gemini 档为准。
22. **`docs/eval/ONLINE-FEEDBACK.md`** — 13,690 B / 读完 / `online-feedback.v1` 权威 schema + 流程：online 与 semi-online 是同一时间线两种验证、分母不能混；锚点规则（时间窗/session/task/requestId/PR）；`requestIds:["unknown"]` 不编造；状态机 `unverified|confirmed|fixed|wontfix`；§6 追加 Gemini 记录说明（旧构建、四态 `unknown/fixed 代码层/待部署验证/needs-repro` 与 schema 枚举不混用）；§7 索引。明确「batch-13-platform-eval.md」作为 conformance 来源，而该文件不在 docs/eval（实际位于 docs/ledger/），引用路径不精确（[文档]）。
23. **`docs/eval/online-feedback-2026-11-23-chatgpt.md`** — 9,281 B / 读完 / ChatGPT 本地只读实测：F1 Actions 415（用户 curl 复现 Accept 头）、F2 `resources[].uri` path=null、F3 raw envelope≠canonical content（契约说明，状态 fixed）、F4 PR id/nodeId additive、F5 正面项。全部 `requestIds:unknown`、`captureVerified:false`、整批 `unverified`；15/15 定向测试 [测试]；声称「已跑全量 npm test 无回退」但无数字。
24. **`docs/eval/online-feedback-2026-11-23-gemini.md`** — 15,256 B / 读完 / Gemini 真实任务反馈，全部来自**生产旧构建**；F1 下载提示/F2 PR number 标 `fixed 代码层 → 待部署验证`；F3 batch wrapper、F4 truncation metadata、F5 atomic multi-file write `needs-repro`；F6 CI 轮询碎 `unknown`；用户澄清「漏看可加载列表」非网关故障。正面三项（批处理省上下文/读写隔离/高频封装）标 confirmed 不变量保护。明确「代码层已修≠现网已修」，requestId 全 unknown。

### 1.6 Join / 缺口 / 任务集（4 文件）

25. **`docs/eval/online-offline-join-2026-11-22.md`** — 18,165 B / 读完 / 只读 join：R2 全天 20 envelope，窗口 11 个，只有 3 个真 MCP tools/call（全 execute_read）；PR #41–#48 在 GitHub 时间线真实发生但 capture 完全无写调用 → 判定「写操作走别的通道 + capture 写路径覆盖不完整」，**不是时间窗错位**；11 条 envelope 逐条 requestId 清单；可比/不可比矩阵；B10 反馈逐项 capture 可证实性（只有读侧字段兜底+行级切片+canonical 未接入可证实，写侧零证据）；§5 六项最小埋点补充（写路径 capture、upstream event↔requestId 配对、结构化变更清单、taskId/sessionId、token/意图标签、跨服务器归属）。是"主动>被动"原则的关键反例证据：被动 capture 当年无法证明用户主动做的 PR 操作。
26. **`docs/eval/ONLINE-SEMIONLINE-JOIN-2026-11-23.md`** — 23,734 B / 读完 / F1–F6 × N1–N9 / T1–T7 逐条 join：四态口径（covered/weak/missing；fixed/pending-deploy/unknown）；G1–G6 缺口分类；新任务 J1–J6（J1 byte-exact postcondition、J2 canonical PR number、J3 batch wrapper、J4 truncation tail metadata、J5 atomic-by-default、J6 CI wait helper）；§4 同 prompt / 同 build / 新 session / 同预算 / 同判据，禁止跨构建硬比；§5.3 J-DEPLOY 需部署窗口证据。**当前代码事实冲突 [代码]**：文中称「全仓搜索 waitFor/pollPrChecks 无匹配，helper 不存在」；本轮核对 `src/codemode.js:38,137,498,1431-1438,1887` 与 `src/github-helpers.js:855` **存在** `waitForPrChecks`（且 `chargeBudget('waitForPrChecks')` 已接入），故该判断是快照过期（详见 §3.2）。
27. **`docs/eval/SEMI-ONLINE-GAPS.md`** — 21,237 B / 读完 / 缺口抽象：online symptom → checkable property → deterministic test/task；T1–T7 七类测试；§4 原 N1–N9 计划（N1 非默认分支读、N2 写后字节校验、N3 canonical fixture pack、N4 四个计数器、N5 discovery-effort、N6 Actions lane、N7 long-session、N8 platform axis、N9 evidence chain）；§6 Gemini addendum 的 F1–F6 映射；§7 join 索引。**编号漂移**：§4 的 N1–N9 与 `ONLINE-GAP-TASKS.md` 实际落地的 N1–N9 编号不一致（例如 §4 N2=写后字节校验 vs 任务文件 N2=branch/ref；§4 N5=discovery vs 任务文件 N5=Actions logs）；跨文档引用 N<number> 时必须核对目标文件（详见 §3.3）。
28. **`docs/eval/ONLINE-GAP-TASKS.md`** — 7,537 B / 读完 / N1–N9 任务集 runbook：N1 byte-exact、N2 branch/ref、N3 PR number、N4 discovery（todo 至 P0-4）、N5 Actions logs（fake + gated real）、N6 truncation、N7 long session、N8 platform、N9 write safety；每任务 `dryRun:true`/`forRealWrite:false`、顶层 `realWritesAllowed:false`；完整性测试检查 ID/字段/tool 存在性/axis 提及；明确 fake 任务不能单独闭合并行审计缺口。

### 1.7 Runner / harness / 持续迭代（4 文件）

29. **`docs/eval/ONLINE-REPLAY-HARNESS.md`** — 11,192 B / 读完 / `online-replay.v1`：从 `gmg.capture.v1` envelope 提取 session，逐字 prompt/args/profile 构造 replay plan，写强制 dryRun，按 exactness/contract/truncation/path/id 五字段 diff 输出 pass/diff/partial/not-comparable；22 项测试 [测试]；`not-comparable` 明列客户端宿主、模型行为、部署/时序、真实写、跨构建硬比。**注意 verdict 规则「只要有可比字段 pass 即 pass」与「写工具固定 not-comparable」并存，读侧 diff 会主导整体判定**（[文档]，逻辑上需人审）。
30. **`docs/eval/L1-ONLINE-GAP-WIRE.md`** — 9,039 B / 读完 / `--profile online-gap` 接 N1–N9 + J1–J6 共 15 任务；6 个扩展指标算不出记 unknown；冻结基线按 taskId+fixtureHash 只读、禁止读 explore/results 自引用；**当前 checkout 无 `explore/baselines/l1-online-gap.json`，profile run 的 `ok:true` 是接线 PASS、`allUnknown:true`，不是质量通过**；21 项测试 [测试]。**未兑现产物 [代码]**：文档承诺 run 会写 `docs/eval/l1-online-gap.json` / `l1-online-gap-report.md`，本轮核对两文件均不存在（`git ls-files` + `Test-Path` 均 false）；基线文件也不存在（文档已声明预期无基线，故仅前两项算未兑现/未生成）。
31. **`docs/eval/CONTINUOUS-EVAL.md`** — 7,445 B / 读完 / `scripts/eval-cycle.mjs` 五步（L1 fake + profile、replay fixture、join 覆盖审计、docs artifact 检查、baseline 只读对比）；签名 STABLE/DRIFT/NO_BASELINE 三种状态、`DRIFT/NO_BASELINE` 不算 fail；报告 `docs/eval/eval-cycle-<timestamp>.{json,md}` 独占创建不覆盖；不接定时器/不联网；§6 人工 intake 边界。**未生成产物 [代码]**：`docs/eval/` 下无任何 `eval-cycle-*` 文件，说明该命令本 checkout 尚未实际运行或无归档结果。
32. **`docs/eval/MCP-V2-SMOKE.md`** — 7,934 B / 读完 / `/mcp/v2` 本地真实 HTTP socket 9 项检查（v1 逐字不变、v2 三工具同序、plan 执行、read-only 拒写、approve/dryRun 闸、v1 拒 plan、输入边界、flag-off 404、401 challenge）；9/9 + 3/3 [测试]。**stale 数字**：全量 `tests 1224 / pass 1216 / fail 2 / todo 6`（且两个失败在 capture-queue-integration），与 AGENTS.md 当前基线 `1406/1400/0 fail/6 todo` 不一致；不能引用此处的 fail 作为当前状态。明确未覆盖真实客户端/真实上游/生产默认/OAuth 完整握手/真实写/capture/并发。

### 1.8 平台 / 安全 / 诊断 / 回归（7 文件）

33. **`docs/eval/PLATFORM-CONFORMANCE-MATRIX.md`** — 35,730 B / 读完 / 三平台 × OAuth/transport/schema/编码/计划限制矩阵；Gemini 唯一实测基线；ChatGPT Free/Plus 不可承诺完整 MCP；Claude callback 当前 allowlist `fail`；C1 typed-plan `plan` 字段 schema `fail`；T1–T6、A1–A5、O1–O6 测试项；§9 落地状态（21/21 pass 离线 [测试]）。**内部矛盾**：§2.3/§4 A2/§5 写「Claude 当前不能连 / callback 未实现」，§9 却写「callback allowlist implemented (strict host/path) pass (offline)」；§8 自承「矩阵行未被测试落地任务重新评分」，故 §1–§8 是过期快照（详见 §3.2）。
34. **`docs/eval/CODEMODE-SECURITY-AUDIT.md`** — 33,044 B / 读完 / F-01～F-11 安全审计：高危 F-01 错误 token 回显模型、F-02 capture 原样持久化凭据（有意设计，capture 必须当 secret 存储）、F-03 截断审计可被 `truncated:false` 投毒；中高 F-04 typed-plan/Actions 桥绕过预算、F-05 per-step approve 自授权；中 F-06 `__bridge` 直触/`__proto__` 工具名、F-07 写路径截断检查不一致、F-08 canonical 矛盾截断字段、F-09 boundResult 无结果级 flag；F-10 profile/annotations 不是安全边界（设计确认）、F-11 沙箱逃逸面关闭。P0/P1/P2 修复建议「未实施」。[代码] 当前快照已修 F-01（`src/tool-format.js:41 redactSecrets`）、F-03（`src/capture.js:185-203` 只认真 flag）、F-09（`src/server.js:125` 返回 `truncated:true`），与 AGENTS.md §6「F-08/F-09 已修」部分吻合，但**审计文档本身从未更新状态**；F-02 依用户要求保持 capture full-fidelity（不得据此添加隐私过滤），但模型可见错误必须脱敏。
35. **`docs/eval/VERCEL-CIMD-DIAGNOSIS.md`** — 22,333 B / 读完 / 诊断 `Invalid client_id`：Notion accepted control（短 PKCE 触发 code_challenge 错误）vs 我方 rejected，定位为 client resolution 阶段；三假设 H1 host trust/pre-registration（最可能）、H2 元数据要求（logo_uri/application_type）、H3 Vercel egress/SSRF/负缓存；只读 probe 脚本 + 12/12 fake 测试 [测试]；明确「没有 accepted:true 状态、control 失败则压制结论、document-only 不伪造 AS verdict」；BLOCKED 升级判据四条；不 commit。
36. **`docs/eval/RECONNECT-TESTS.md`** — 7,945 B / 读完 / 重连/发版后工具消失：只测网关 wire 可观测部分（9/9 [测试]）；stale session 实测 200 + 完整工具表（不伪造 404 信号）；`tools/list` 三次 sha256 快照一致；客户端 `unknown_tool` 明确 unknown；线上复现步骤记录 buildHash/新窗口/旧会话/手动 @ 是用户动作；不模拟宿主、不发 404 重连信号、不改契约。
37. **`docs/eval/LOCAL-E2E-VERIFY.md`** — 8,371 B / 读完 / 本地最新代码 HTTP loopback + fake upstream 11 项检查（healthz/OAuth metadata/CIMD/401/三工具/file 纯正文/PR number URL 优先/**waitForPrChecks helper**/typed-plan helper/v2 flag 开关）；真实链路只 fake token store 与 upstream；明确「本地绿≠线上绿」对比表。**与 §1.26 的 helper 不存在判断直接冲突**；本轮 [代码] 证实本文件对 helper 的描述符合当前 checkout。

### 1.9 Auth 研究（1 文件）

38. **`docs/eval/AUTH-PROVIDERS.md`** — 33,366 B / 读完 / Notion/Linear/Vercel MCP token 生命周期权威调研（2026-11-23 抓取）：Notion 8h access / 每次刷新轮换 / 一步重试窗 / 180 天 grant / replay 撤销整个 grant；Linear 24h access / 30 天 refresh / 30 分钟丢失响应重试窗 / 官方 PAT→hosted MCP 路径；Vercel OAuth-only、PRM 只报 openid、必须显式 `offline_access`（第三方 wire 证据 1h 无 refresh）；SEP-2207/OAuth 2.1/RFC 9700 规范链；**DSH 与网关必须两个独立 client/grant，绝不共享 rotating refresh token**；无凭据入库。"Vercel 1h/no-refresh"明确标注经验性、非 SLA（[文档] 已自我限定）。

### 1.9a 回归 / 计划 / 手册补记（3 文件）

39. **`docs/eval/L1-SMOKE.md`** — 7,747 B / 读完 / L1 快速回归手册：50 任务（G6 228 中筛），fake（默认，只验接线、不代表质量）/ replay（离线回放指标）/ real（每周一次，Figma 默认跳过避免烧配额）三模式；单一基线来源冻结于 `explore/baselines/l1-smoke.json`（含 `byServer` 与 40 条 `serverSets`）；`failedServers` 为显式输入，degraded scope 三态 full/degraded-subset/no-measured-tasks；修正 searchHit/toolHit 分母公式（`measurable` 剔失败 server，主指标 null 剔除对齐冻结基线，另报 `*Adjusted`）；阈值 10%/+3，连续两次红才标 ALERT；限制写明归因器误标与 fake/replay 非质量。
40. **`docs/eval/TYPED-PLAN-TEST-PLAN.md`** — 29,511 B / 读完 / typed-first + code fallback 详细测试方案，**设计稿未执行**：40 任务（L1 30 + TP-01…TP-10 10 条，逐字 prompt 与 expected ops）；F/S 两 profile 的配对 A/B（同 prompt/预算/新 session/顺序抵消）、三环境 fake/replay/real、8 类错误分类 E1–E8、9 个指标定义（含 fallback 率/op 覆盖率）；§7 硬门槛 A1–A7（completion −3pp、tokens ≤F、repair −30%、写回放 ≥F、基线口径、平台分账、conformance）+ 写死"数据不到不切"；§8 CLI 与产物均为占位，未创建 runner/测试。
41. **`docs/eval/l1-real-regression-2026-11-23.md`** — 17,921 B / 读完 / L1 real FAIL 根因调查：23:44Z PASS 是 baseline===current 自引用假阳性（裸指标 searchHit 50/toolHit 31 已远低于冻结基线 82.4/53.3）；23:51Z FAIL 由 notion/vercel 失效（2/4 连通）+ 全连通基线口径不匹配 + 免费模型波动 + hit-rate 分母定义共同造成；逐任务 F048/F080/F088/F134/F139 交叉举证（缺失败 run trace，不伪造 actual tool）；明确"不能断言网关代码回归"，并列出 6 项修复建议（CI 健康检查、退化基线、分母修正、trace 上传、REAUTH_REQUIRED、先测试后改）与 4 步最小验证。

### 1.10 覆盖核对表（41 路径，逐条 expected=read）

下表按 `git ls-files docs/eval` 顺序列出 41 个路径；每条均在本章以完整路径详述。"字节"取 `Get-Item.Length`（工作树），与上文详述一致。

| # | 文件（docs/eval 下） | 字节 | 读完 | 详见 |
|---:|---|---:|---|---|
| 1 | ANALYZER-REVIEW.md | 2,788 | ✓ | §1.1-2 |
| 2 | AUTH-PROVIDERS.md | 33,366 | ✓ | §1.9-38 |
| 3 | CODEMODE-SECURITY-AUDIT.md | 33,044 | ✓ | §1.8-34 |
| 4 | CONTINUOUS-EVAL.md | 7,445 | ✓ | §1.7-31 |
| 5 | L1-ONLINE-GAP-WIRE.md | 9,039 | ✓ | §1.7-30 |
| 6 | L1-SMOKE.md | 7,747 | ✓ | §1.9a-39 |
| 7 | LOCAL-E2E-VERIFY.md | 8,371 | ✓ | §1.8-37 |
| 8 | MCP-V2-SMOKE.md | 7,934 | ✓ | §1.7-32 |
| 9 | ONLINE-FEEDBACK.md | 13,690 | ✓ | §1.5-22 |
| 10 | ONLINE-GAP-TASKS.md | 7,537 | ✓ | §1.6-28 |
| 11 | ONLINE-REPLAY-HARNESS.md | 11,192 | ✓ | §1.7-29 |
| 12 | ONLINE-SEMIONLINE-JOIN-2026-11-23.md | 23,734 | ✓ | §1.6-26 |
| 13 | PLATFORM-CONFORMANCE-MATRIX.md | 35,730 | ✓ | §1.8-33 |
| 14 | README.md | 1,457 | ✓ | §1.1-1 |
| 15 | REAL-GH-REPLAY.md | 5,650 | ✓ | §1.4-20 |
| 16 | RECONNECT-TESTS.md | 7,945 | ✓ | §1.8-36 |
| 17 | SEMI-ONLINE-GAPS.md | 21,237 | ✓ | §1.6-27 |
| 18 | TYPED-PLAN-TEST-PLAN.md | 29,511 | ✓ | §1.9a-40 |
| 19 | VERCEL-CIMD-BLOCKER.md | 1,686 | ✓ | §1.1-3 |
| 20 | VERCEL-CIMD-DIAGNOSIS.md | 22,333 | ✓ | §1.8-35 |
| 21 | acceptance-2026-11-24/env-isolation-result.json | 1,304 | ✓ | §1.2-7 |
| 22 | acceptance-2026-11-24/tools-list-results.json | 1,078 | ✓ | §1.2-8 |
| 23 | acceptance-2026-11-24/write-loop-report.json | 3,221 | ✓ | §1.2-9 |
| 24 | acceptance-2026-11-24/write-loop-verify.json | 3,128 | ✓ | §1.2-10 |
| 25 | capture-verification-2026-11-23.md | 1,716 | ✓ | §1.4-18 |
| 26 | l1-real-2026-11-22.md | 2,956 | ✓ | §1.4-17 |
| 27 | l1-real-regression-2026-11-23.md | 17,921 | ✓ | §1.9a-41 |
| 28 | l1-smoke-report.md | 1,190 | ✓ | §1.2-11 |
| 29 | l1-smoke.json | 2,841 | ✓ | §1.2-12 |
| 30 | online-feedback-2026-11-23-chatgpt.md | 9,281 | ✓ | §1.5-23 |
| 31 | online-feedback-2026-11-23-gemini.md | 15,256 | ✓ | §1.5-24 |
| 32 | online-feedback-2026-11-23.md | 9,180 | ✓ | §1.5-21 |
| 33 | online-offline-join-2026-11-22.md | 18,165 | ✓ | §1.6-25 |
| 34 | scorecard-2026-11-22.json | 2,638 | ✓ | §1.3-14 |
| 35 | scorecard-2026-11-22.md | 2,036 | ✓ | §1.3-13 |
| 36 | scorecard-2026-11-23.json | 20,133 | ✓ | §1.3-16 |
| 37 | scorecard-2026-11-23.md | 9,349 | ✓ | §1.3-15 |
| 38 | session-marker-2026-11-23.md | 1,967 | ✓ | §1.1-6 |
| 39 | weekly-2026-46.md | 1,012 | ✓ | §1.1-4 |
| 40 | weekly-2026-47.md | 1,184 | ✓ | §1.1-5 |
| 41 | write-replay-2026-11-23.md | 2,526 | ✓ | §1.4-19 |

> 本表 41 行与 §1 编号 1–41 一一对应；所有文件均已按完整内容阅读（大文件分段读到 EOF），未以标题或 grep 代替。
> 权威覆盖判定：**expected=41 / read=41 / unread=0**。

---

## 2. 按 FRAMEWORK 评测体系的维度审计

### 2.1 官方/权威离线评测（FRAMEWORK §3 第一条线 / §2 上游 SOP）

- [文档] `l1-real-2026-11-22.md`/`L1-SMOKE.md`：L1 50 任务从 G6 228 筛出，任务标注 `authority ∈ official-verbatim|benchmark|schema-reverse`（`ONLINE-GAP-TASKS.md` §2）；冻结基线 40/50 条、按 server 分账。
- [文档] `PLATFORM-CONFORMANCE-MATRIX.md` 大量 `unknown`/`fail`（Claude callback、ChatGPT CIMD、typed-plan schema）；`TYPED-PLAN-TEST-PLAN.md` 40 条 A/B 任务、**从未执行**（§0「设计稿（未执行）」、§8 CLI 为占位符）。
- 审计结论：**"按官方/权威任务集全覆盖离线评测"仍是 FRAMEWORK 级承诺，不是现状**。当前离线层的证据主要是 fake-dry-run 接线、纯函数单测与一次真实 G6（git 6b4254c，2026-11-22）；四上游中 notion/vercel 连接失败时真实 L1 直接进入 degraded 口径（`l1-real-regression-2026-11-23.md`）。[未验证]：没有"每个上游官方任务集全覆盖且通过"的证据。
- 正面：`l1-real-regression` 是一份高质量的反自引用审计——明确指出 23:44Z 的 PASS 是 baseline===current 的假阳性，拒绝把"以前绿"当基线。

### 2.2 主动 > 被动线上评测（FRAMEWORK §4 / §13.2）

- [文档] 三份 online-feedback 记录 + ONLINE-FEEDBACK.md 定义主动反馈一等公民：用户真实窗口提问 → schema 记录 → 半在线映射 → 状态机。Gemini 档明确「主动>被动；主动能打到被动覆盖不到的地方」。
- [文档] `online-offline-join-2026-11-22.md` 给出反向证据：用户主动做的 PR #41–#48 在被动 capture 里零痕迹，若只信被动会错判"用户没做"。这正是 FRAMEWORK 强调主动含金量更高的实证。
- 但审计发现：**主动侧证据链几乎全断**——三份 feedback 记录所有 `requestIds:["unknown"]`、`captureVerified:false`；整批状态 `unverified`/`unknown`。FRAMEWORK §4 要求"主动结论要能回放到被动数据；被动结论要能生成新的主动任务"，当前只做到"抽象成半在线任务"，**没有一条带真实 requestId 的主动→被动闭环** [未验证]。
- `online-feedback-2026-11-23-chatgpt.md` 声称通过本地网关只读实测，但无 capture/requestId；属结构化用户报告，不是可回放证据。

### 2.3 工具级真值（FRAMEWORK §13.3："被动缺任务级预期，但有工具级可核验真值"）

- [文档] `SEMI-ONLINE-GAPS.md` T1/T2/T3 与 `ONLINE-GAP-TASKS.md` N1/N3 把工具级真值写成可断言属性：`readback===intendedBody`、`number===53 from URL`、`callTool.args.ref===requestedBranch`、`content` 无下载提示；`write-replay-2026-11-23.md` 的真实回放展示了这类真值能抓到三个字段 bug。
- [文档] `scorecard-2026-11-23.md` 的 9 个 `modelTruncationSuspects` 是**工具级真值的反面信号**：网关 wire 完整但模型收到静默缩短投影（如 `slice(0,150)`），可经重放/上游核验；但它被标 advisory-only 且没有专门任务消费（除 `J4 truncation tail metadata` 间接相关）。
- [文档] `REAL-GH-REPLAY.md` 的"真实"证据疑似占位数据（§1.20），工具级真值核实链在此处失效。
- 结论：工具级真值的**设计**在文档里成立；**执行**只到 fake/纯函数层，真实捕获侧缺 requestId/真值配对 [未验证]。

### 2.4 session / project / task 交叉（FRAMEWORK §3 采集层 / §12 状态与隔离）

- [文档] `session-marker-2026-11-23.md`：sessionId 只作 capture 关联，stateless；Gemini 回传验证通过。
- [文档] `scorecard-2026-11-23.json`：`sessions[]` 有 12 个窗口（7 sessionId + 5 合成 window），`byProject` 1 个 key 跨窗，但每项 `taskId:null`；`byClientPlatform` 20/20 `unknown`。即 **session 与 project 有数据，task 维度始终为空，clientPlatform 未填**；FRAMEWORK 要求的 "session/project/task 交叉" 只实现前两维，且 project 是代码字面量派生标签（`source:"code-literal"`, confidence medium），不是客户端声明身份。
- [文档] `ONLINE-SEMIONLINE-JOIN-2026-11-23.md` 与 `TYPED-PLAN-TEST-PLAN.md` 规定新会话/同 prompt 配对；[代码] session marker 存在于 src/capture.js 相关路径（依 session-marker 文档描述，本轮未逐行核对全部实现）。
- 结论：交叉采集是 "部分实现 + 分析侧合成"，不能写"完整 session/project/task 交叉采集线已落地"。

### 2.5 capture 自动线（FRAMEWORK §3 自动化采集线 / AGENTS §6）

- [文档] `capture-verification-2026-11-23.md`：`ack→done→sink_ok→R2` 全链路对账成功，一项真实 requestId 可回对象；`CAPTURE_SYNC=1` 牺牲 0.4–0.5s 换数据可信。
- [文档] `ANALYZER-REVIEW.md` + weekly-46/47：`capture-daily.yml` 每周 digest + dry-run 聚类 → advisory 候选 → 人审回 R2 envelope → 本地复现。这是自动化采集线的"分析侧"，自动化**停在候选**，符合 AGENTS §1。
- [文档] `online-offline-join-2026-11-22.md`：写路径 capture 缺口 + upstream event↔MCP 请求无配对 → 被动线对主动任务有系统性盲区。
- [文档] `CODEMODE-SECURITY-AUDIT.md` F-02：capture full-fidelity 是有意设计（凭据/完整脚本原样落盘），必须把 R2/目录当 secret 存储；用户明文禁止对 capture 做隐私过滤，故不能把"加 redactor"当修复方向（审计原文的 F-02 建议与本仓库现行规则冲突，见 §3.5）。
- 结论：自动线"采集→落盘→digest→候选"已运转；"写路径全覆盖 + event 配对 + 在线↔任务 join"仍是明确未闭合缺口。

### 2.6 baseline / replay / join / scorecard

- [代码]+[文档] baseline：`l1-real-2026-11-22.md`/`L1-SMOKE.md` 修掉自引用 bug，单一冻结源；`l1-real-regression-2026-11-23.md` 证明旧 PASS 是假阳性；`L1-ONLINE-GAP-WIRE.md` 新基线 `l1-online-gap.json` 尚未建立且产物文件未生成；`l1-smoke.json` 的 fake baseline 是仿真，不能当质量基线。
- [文档] replay：`ONLINE-REPLAY-HARNESS.md`（会话级逐字重放 + 五字段 diff）与 `TYPED-PLAN-TEST-PLAN.md`（fake/replay/real 三级、明确"replay 不是新质量证据"）设计完整；`MCP-V2-SMOKE.md` 的 loopback live smoke 是真正的 HTTP 层回放。[未验证]：replay 从未接真实在线 capture 跑通并附证据。
- [文档] join：三份 join（11-22 capture↔离线、11-23 在线↔半在线、CONTINUOUS-EVAL 的可重复 join 审计）层次清楚，`ONLINE-FEEDBACK.md` 的锚点规则与不可比清单被反复引用。join 质量在本批文档中是最高的一块。
- [文档] scorecard：两份 11-22/11-23 scorecard 区分 wire truncated / overflow / model truncation suspects 三个信号、mcpErrors 与 routeErrors 单列、按 server/tool/platform/project/session 多维聚合；但 11-23 的 clientPlatform 全 `unknown`、`taskId:null`，限制了分账价值。
- 跨构建纪律：多份文档反复写"禁止跨构建硬比、旧构建只作对照"；`CONFIG` 侧"S 不劣于 F"门槛也写死"数据不足不切"（`TYPED-PLAN-TEST-PLAN.md` §7.3）。这是文档体系里执行得最好的硬规则之一。

### 2.7 安全 / 权限（FRAMEWORK §13.7 作为实现约束）

- [文档] `AUTH-PROVIDERS.md` 是授权层最完整的研究：独立 grant、owner 标记、轮换/重放撤销、CIMD vs DCR、Vercel `offline_access`。与 AGENTS §2 一致。
- [文档] `CODEMODE-SECURITY-AUDIT.md` F-01/F-03/F-04/F-05/F-06/F-07 覆盖模型可见错误、审计投毒、预算绕过、自授权写、保留字污染、写路径截断；F-10/F-11 正面确认 profile 非安全边界、沙箱隔离成立。
- [代码] 交叉核对当前快照：F-01 已在 `src/tool-format.js:41,55-64,551` 有 `redactSecrets` 并在错误路径调用；F-03 已在 `src/capture.js:185-203` 改为只认真 flag（注释明确 `truncated:false` 永不匹配）；F-09 已在 `src/server.js:125` 返回 `truncated:true`；`src/codemode.js:1438` 有 `chargeBudget('waitForPrChecks')`（F-04 部分缓解）。**这些修复未回写审计文档，审计结论以"未实施"呈现，属文档 stale**。
- [文档] `PLATFORM-CONFORMANCE-MATRIX.md` §5 与 `FRAMEWORK.md` §14 一致：annotations 不是安全边界；写确认是客户端 UX，网关只保留代码级闸；对 Gemini profile 的 annotation 调整只建议实验、未全局改。
- [文档] `env-isolation-result.json` 4 条 P0 跨环境共享凭据违规是权限隔离的**未闭合项**；`tools-list-results.json` 的 notion/vercel 401 说明授权生命周期仍未跑通。

---

## 3. 文档矛盾 / stale 数字 / 未实现承诺 / 被埋质量信号（硬要求 3）

### 3.1 矛盾清单

| # | 矛盾 | 证据 | 判定 |
|---|---|---|---|
| M1 | "waitForPrChecks helper 不存在（全仓搜索无匹配）" vs "waitForPrChecks 在 sandbox 内可见且超时返回" | `ONLINE-SEMIONLINE-JOIN-2026-11-23.md` F6 行 / §5.1 / §5.3；`LOCAL-E2E-VERIFY.md` check 表 `wait-for-pr-checks-helper` | **[代码]** 当前 checkout 存在 `src/codemode.js:38,137,498,1431-1438` 与 `src/github-helpers.js:855` 的实现，故 join 文档是过期快照；J6 的 "unknown/missing-capability" 状态需由 lead 复核后更新，本审计不改文档 |
| M2 | "Claude callback allowlist fail，当前不能连" vs "callback allowlist implemented (strict host/path) pass" | `PLATFORM-CONFORMANCE-MATRIX.md` §2.3/§4 A2/§5 vs §9 第 3 行；§8 自承矩阵行未重评分 | **[文档]** 同一文件内部新旧并存；§1–§8 是旧快照，引用 Claude 状态时必须注明 §9 更新 |
| M3 | N1–N9 编号语义在两份文档间漂移 | `SEMI-ONLINE-GAPS.md` §4（N1 非默认分支读、N2 写后字节、N5 discovery）vs `ONLINE-GAP-TASKS.md` §1（N1 byte-exact、N2 branch/ref、N5 Actions logs）；`L1-ONLINE-GAP-WIRE.md`/join 使用后者 | **[文档]** 所有 "N<number>" 引用必须带目标文件名，否则无法判定覆盖关系 |
| M4 | 同一天三份 feedback 的 F<n> ID 指向不同症状 | `online-feedback-2026-11-23.md` F2=branch 忽略 / F3=PR number；`online-feedback-2026-11-23-gemini.md` F2=PR number；`online-feedback-2026-11-23-chatgpt.md` F1=Actions 415 | **[文档]** F-ID 只在单文件内有效；join 以 Gemini 档为准，跨文件比对需先做语义对齐 |
| M5 | 安全审计 F-09/F-03 写"未实施/P2 排期" vs 当前代码已修 | `CODEMODE-SECURITY-AUDIT.md` §0/§3 P2；`src/server.js:125`、`src/capture.js:185-203`、`src/tool-format.js:41` | **[代码]** 审计是 2026-11-23 快照，状态未回写；不要把"文档说未修"当当前事实，也不要把"代码已修"当文档已同步 |
| M6 | capture 是否应脱敏 | `CODEMODE-SECURITY-AUDIT.md` F-02 建议"默认开启 redactor" vs AGENTS §6 "用户明确禁止对 capture 做隐私/安全过滤" + `tests/capture.test.js` 反向断言 | **[文档]** 审计建议与现行硬规则冲突，**不得**据 F-02 给 capture 加过滤；正确边界是"capture 原样保存 + 模型可见错误脱敏"（后者已在 `src/tool-format.js` 实现） |
| M7 | "写回环 PR number 已修/已验证" vs acceptance report 明确失败 | `online-feedback-2026-11-23.md` F3 `fixed` / `LOCAL-E2E-VERIFY.md` `pr-number-url-first` pass vs `write-loop-report.json` `pass:false, number:null, matches:false, 404`；`write-loop-verify.json` 后来从 URL 找到 #1 | **[文档]** 同一周内先失败后复核通过；应保留两个报告并列，不能只引用通过的 `verify.json` 就说首次回放无问题 |

### 3.2 stale 数字（明确列出，禁止外推）

- S1 `session-marker-2026-11-23.md`：「全量 **550** 项通过」→ AGENTS.md 当前基线 **1406 tests / 1400 pass / 0 fail / 6 todo**。[文档] 过期快照。
- S2 `MCP-V2-SMOKE.md`：「全量 tests **1224** / pass 1216 / **fail 2** / todo 6，2 个失败在 capture-queue-integration」→ 当前基线 1406/1400/0 fail。[文档] 过期；**不得**据此声称当前有 2 个失败测试。
- S3 `scorecard-2026-11-23.md`：`byClientPlatform` 全 `unknown`（20/20）——这不是"平台分账已实现"，而是字段缺失；同日 `batch-13` 文档承诺的 `clientPlatform` 写入未体现在 capture。[文档]/[未验证]。
- S4 `weekly-2026-47.md`：error rate 0.3 是 6/20 混合路由样本，且 `ANALYZER-REVIEW.md` 明确分母 <10 不下结论；若有人拿 0.3 当系统性故障率是误用。[文档]。
- S5 `README.md`：「l1-task-wire / online-replay-harness 进行中」→ 后续 `L1-ONLINE-GAP-WIRE.md`/`ONLINE-REPLAY-HARNESS.md` 已作为完成文档落地；索引 stale。[文档]。
- S6 `PLATFORM-CONFORMANCE-MATRIX.md` §3/§4 的 typed-plan `plan` 字段 `fail`（current schema 只 `code`）→ `MCP-V2-SMOKE.md` 验证 `/mcp/v2` 已有 `plan` 入参且 9/9 检查通过（默认关闭、非 v1 原地改）。矩阵是 v2 之前快照。[文档]/[代码] 部分核实。
- S7 `write-loop-verify.json` 的 `ci.conclusion:"failure"` 是 **GitHub billing** 阻塞，不是代码失败；把 `pass:true` 写成"CI 已验证"会掩盖未验证项。[文档]/[未验证]。

### 3.3 未实现 / 未生成承诺

- U1 `L1-ONLINE-GAP-WIRE.md` 承诺 profile 产出 `docs/eval/l1-online-gap.json` + `l1-online-gap-report.md`：本轮核对**两文件都不存在**（`git ls-files`/`Test-Path` 均 false）。[代码] 未生成。
- U2 `CONTINUOUS-EVAL.md` 承诺 `eval-cycle-<timestamp>.json/.md` 时间戳报告：`docs/eval/` 下 **0 个 `eval-cycle-*` 文件**。[代码] 命令未运行或无归档。
- U3 `TYPED-PLAN-TEST-PLAN.md` 全文是设计稿：`<typed-plan-replay>`/`<typed-plan-ab-runner>` 是占位 CLI，`typed-plan-ab-YYYY-MM-DD.*` 产物、`tests/typed-plan-*.test.js` 七项均"未来由实现 agent 落"；§7.3「数据不到不切」尚未有数据可判。[文档]。
- U4 `SEMI-ONLINE-GAPS.md` §1.2「gap 关闭 = 确定性测试 + L1/G6 任务级 runner 报同一属性」：N/J 任务多处仍是"任务描述"，runner 未落地（join F1/F2 的 `writePostConditionOk`、`idAsPrNumberCount` 等仍 unknown）。[文档]。
- U5 `ONLINE-SEMIONLINE-JOIN-2026-11-23.md` §5.3 J-DEPLOY（部署后在线复验）：AGENTS §0 当前生产 d1f36ba 已完成部分部署，但 docs/eval 内**没有**带 requestId 的部署后复验记录；F1–F6 状态不能升级。[未验证]。
- U6 `ONLINE-REPLAY-HARNESS.md`/`CONTINUOUS-EVAL.md` 复用 harness 产生 diff，但 docs/eval 下**没有**任何 replay-report / diff 产物文件（只有设计文档与测试结论）。[代码]/[未验证]。
- U7 `PLATFORM-CONFORMANCE-MATRIX.md` §6 checklist 的 G1–G7 / C1–C10 / L0–L6 全部未勾选，ChatGPT/Claude 真实客户端 run 从未做。[文档]/[未验证]。
- U8 `env-isolation-result.json` 的 4 条 P0 隔离违规没有对应的"已修/recheck"证据文件。[未验证]。

### 3.4 被埋掉的质量信号（重点）

- B1 **45% 静默截断嫌疑**：`scorecard-2026-11-23.md` 9/20 model truncation suspects（github 100%），wire truncated=0 让总体"截断率 0"看似干净。候选 W1 在 weekly-47 被降为 P3/unknown，J4 只覆盖"tail metadata"间接相关，**没有一条任务以"模型侧静默投影"为一等断言**。这是最被低估的质量信号。
- B2 **2/5 上游不可用**：`tools-list-results.json` notion 0 tools + vercel 401，被放在 acceptance 目录深处；`l1-real-regression` 已证明这会让 searchHit/toolHit 系统性下降并让 gatewayAnomalyCount 掩盖问题（`applyServerCoverage()` 降级为 infra）。不能把命中率下降写成网关回归，也不能把 anomaly 低写成网关没问题。
- B3 **跨环境共享凭据 P0**：`env-isolation-result.json` `ok:false`（production ↔ preview 共享 Redis/PUBLIC_BASE_URL），被"隔离检查脚本已部署"的部署叙事掩盖；检查存在 ≠ 违规清零。
- B4 **CI billing 阻塞**：`write-loop-verify.json` `pass:true` 的醒目字段下，CI 实际 `conclusion:"failure"`，annotation 是付款失败；写回环的"端到端"只到 Git 对象层，未到 CI 层。
- B5 **PR number 首轮失败**：`write-loop-report.json` `pass:false` + `number:null` 是 id/number 混淆在真实路径的直接证据，后续 verify 修好不能抹掉首发失败。
- B6 **capture 写路径覆盖**：11-22 join 表明用户真实 PR 操作在 capture 里零调用，写侧证据只能靠用户描述/外部 GitHub 时间线；被动线对"主动完成的工作"天然失明。
- B7 **平台分账失效**：11-23 scorecard 20/20 `unknown`，尽管 batch-13 文档承诺按 clientPlatform 分账；所有按平台结论目前只能写 "no measurement"。
- B8 **`taskId:null`**：scorecard 11-23 所有 session 窗口无 taskId，join 只能靠时间窗/PR 号等弱锚点；"session/project/task 交叉"的 task 维为空。

---

## 4. 结论（审计判定，不是验收判定）

1. **文档体系质量**：评测文档在"诚实边界"上写得异常充分——advisory-only、不编造 requestId、不跨构建硬比、fake≠质量、部署≠验收、annotations≠安全边界、capture 原样保存但模型侧脱敏。这些硬规则的文字表达达到 FRAMEWORK 要求。
2. **执行现实**：证据链在每一层都断一截——主动反馈无 requestId（§2.2）；capture 写路径与 upstream 配对缺失（§2.5）；taskId/clientPlatform 为空（§2.4）；baseline 只冻结未复验、online-gap 基线不存在（§2.6）；真实 PR replay 疑似占位数据（§1.20）；J-DEPLOY 未附证据（U5）。
3. **文档自身可信度**：存在内部矛盾（M1–M7）、stale 数字（S1–S7）、未生成产物（U1–U8）。引用任何 docs/eval 结论前必须带"文件日期 + 状态词 + 是否已由 lead 复核"三件套。
4. **禁止"测试绿=完成"**：本批文档自身提供了 4 个反例——`l1-smoke-report.md` 的 PASS 是仿真；`l1-real-regression` 的旧 PASS 是自引用假阳性；`CONTINUOUS-EVAL`/`L1-ONLINE-GAP-WIRE` 的 exit 0 是接线通过、`allUnknown`；`write-loop-verify.json` 的 pass:true 下 CI billing failure。任何"全绿"叙事都要回到这些 caveat。
5. **未做事项（本审计不越界）**：未修改任何源码/脚本/测试/其它文档/工作流；未运行全量测试；未 commit/push/deploy；未与 lead 确认冲突项处置。M1/M2/M5 的状态同步、U1/U2 产物是否补交、B1/B3 的跟进，均交 lead 决策。
