# 在线反馈记录（2026-11-23）— `online-feedback.v1`

> 来源：用户主动向 Gemini 提问后给出的在线反馈（本批 6 条问题 + 1 组正面项）。
> 与 L1/G6「半在线评测」是同一任务/时间线的两种验证，见
> [`ONLINE-FEEDBACK.md`](./ONLINE-FEEDBACK.md)。
> 本记录按 schema 写；**能关联 capture 的写 requestId/时间戳，不能关联的写
> `unknown`，不编造**。已按 `AGENTS.md` 把模型/归因器输出仅视为待验证假设。
> 未 commit / push / deploy。

## 顶层元数据（脚本可解析）

Recorded-at: 2026-11-23T09:02:17+08:00
Window: 2026-11-23T00:00:00Z -> 2026-11-23T23:59:59Z
Platform: gemini web
ClientInfo: Gemini/1.0.0
Repo: Bruce-Yii/gemini-mcp-gateway
Session: unknown
Task: unknown
Status: unverified
Baseline: explore/baselines/l1-smoke.json

## F1
Severity: P0
Category: result-shape-download-notice
Symptom: fileResult(r).content 把 "successfully downloaded text file (SHA: ...)" 下载提示混进正文，写脏 docs/17 与 5 个前端文件
Evidence: Source: user-report
Detail: 用户报告：通过网关读文件后，fileResult(r).content 首段是下载提示而非正文；该脏文本被写入 docs/17 与 5 个前端文件。用户 PR #57 清理脏文件，PR #56 洗净根因（normalizeFileResult 在 text 为下载提示时优先 resources[].text，并提取 SHA: <hex>）。
CaptureVerified: false
PR: #56
PR: #57
Reproduction: 用真实 get_file_contents 读取文本文件，检查 fileResult(res).content 是否含 "successfully downloaded text file"；本轮未拿到可回放的 requestId，复现步骤为候选，状态保持 unverified。
RequestIds: unknown
Status: confirmed

## F2
Severity: P0
Category: ignored-parameter-branch
Symptom: get_file_contents 的 branch 参数被静默忽略，回退到 main
Evidence: Source: user-report
Detail: 用户报告调用 github__get_file_contents 时传 branch=<非 main 分支>，实际读到的是 main 的内容，未报错也未提示参数被忽略；同时间线无 capture 可回放到该调用。
CaptureVerified: false
Reproduction: 在测试仓库建分支写入差异内容，用 execute_read 调 get_file_contents 并传 branch=<branch>，比较返回内容是否来自该分支；目前仅有用户报告，未本地复现。
RequestIds: unknown
Status: unverified

## F3
Severity: P1
Category: pr-number-id-confusion
Symptom: prResult 把 DB id 5444514334 当 PR number，真实 PR 为 #53
Evidence: Source: user-report
Detail: 用户报告 create_pull_request 返回 {id:5444514334, url:.../pull/53}，旧 normalizePrResult 把 id 回退为 number，导致后续 merge 调用 404。证据与 batch-11-gh-feedback「反馈 2」一致；PR #53 是外部 PR 事实，不是本仓库 capture 证据。
CaptureVerified: false
PR: #53
Reproduction: 用真实形状 {id:5444514334, url:".../pull/53"} 跑 normalizePrResult / prResult，应得到 number=53；该修复已在 batch-11 有 21 项定向测试覆盖，但「真实 PR #53 回放」尚未做（见 batch-12 follow-up #4）。
RequestIds: unknown
Status: fixed

## F4
Severity: P1
Category: parameter-name-split
Symptom: createBranchIfMissing 参数 name vs branch 割裂（传 branch 报 name is required）
Evidence: Source: user-report
Detail: 用户/真实调用传 branch:'...' 给 createBranchIfMissing，报 "ensureBranch: name is required"。与 batch-11-gh-feedback「反馈 1」一致，capture 中曾有 d6f59a7e... 的报错记录（本批未重新回放到该 UUID，故 requestIds 写 unknown）。
CaptureVerified: false
Reproduction: 在 Code Mode 内用 codemode.createBranchIfMissing({branch:'x',from_branch:'main'}) 调用；修复后 host/sandbox 均接受 name/branch/branchName 三别名并归一化，batch-11 已有定向测试。
RequestIds: unknown
Status: fixed

## F5
Severity: P1
Category: tool-description-enum
Symptom: pull_request_read 聚合 method 枚举未写进工具描述，导致模型多一轮试探
Evidence: Source: user-report
Detail: 用户报告 pull_request_read 的聚合 method 可选值没有出现在工具描述里，模型只能试探后才知道合法枚举，多消耗一轮工具调用。属"元数据可见性"类问题（与 B7/B8 的可见性契约同源）；本批未改 tools/list 描述。
CaptureVerified: false
Reproduction: 在 tools/list 描述里搜索 pull_request_read 的 method 参数，确认枚举是否列出；需先看上游 schema 原样描述与 gateway 的 sanitizeTool 输出，本批未实施。
RequestIds: unknown
Status: unverified

## F6
Severity: P2
Category: observability-and-reconnect
Symptom: 缺 GitHub Actions 失败日志能力；发版后长会话出现 unknown_tool，需手动 @ 网关恢复
Evidence: Source: user-report
Detail: 用户报告两点：(a) 读 GitHub Actions 失败日志需要的能力缺失；(b) 2026-11-22 部署后旧 Gemini 会话工具消失，调用返回 unknown_tool/not-found，对话中手动 @Gemini Mcp Gateway 后恢复。(a) 已由 batch-11-gh-feedback 新增网关侧 REST helper（github_actions_list_workflow_runs/jobs/get_job_logs，不新增对外工具数）；(b) 见 batch-11-reconnect：网关不能强制客户端重连，Google 侧 wire 未抓到，缓解方案为手动 @ / 新窗口。
CaptureVerified: false
Reproduction: (a) 用真实 CI run 调 codemode.github_actions_get_job_logs，需 GITHUB_TOKEN；batch-11 只有 fake 测试。(b) 发版后在旧会话调用工具观察 unknown_tool，再手动 @ 恢复；需在部署窗口复验。
RequestIds: unknown
Status: unverified

## F7
Severity: P0
Category: positive-signals
Symptom: 正面反馈：单次脚本批处理、原子多文件、read/execute 分离、safeAll/unwrap 好用
Evidence: Source: user-report
Detail: 用户明确肯定：单次脚本批处理减少往返；github__push_files 一次提交的原子多文件写入；execute_read/execute 读写分离；safeAll / unwrap 让编排更省心。这些是当前设计不变量，需在后续改动中保持（见 ONLINE-FEEDBACK.md「不变量」与 batch-11-write-transaction）。
CaptureVerified: false
Reproduction: 不需要修复；作为回归保护项，后续若改动批处理/原子写/读写分层/safeAll，需确认这些行为不回退。
RequestIds: unknown
Status: confirmed

---

## 与半在线（L1/G6）对照（离线枚举，非脚本字段）

> 以下 human-readable 对照用于说明「同一时间线两种验证」；脚本输出 JSON 中
> `offline.comparison.linked` 由顶层元数据自动推导（全部 `no-request-id`），
> 不编造 runner task 匹配。

| 反馈项 | 在线证据 | 半在线/离线证据 | 对照判定 |
|---|---|---|---|
| F1 下载提示混正文 | 用户报告 + PR #56/#57 | `write-replay-2026-11-23.md` 已描述同一 bug 与 normalizeFileResult 修复；`tests/codemode-file-pr-helpers.test.js` 覆盖 hostile shape | 代码层已修（confirmed），**真实窗口端到端未回放** |
| F2 branch 被忽略 | 用户报告，无 requestId | L1/G6 任务集无「非默认分支读取」断言；G6 离线基线不含该场景 | unverified；需补一条 L1 task + 真实 capture |
| F3 PR number=id | 用户报告 + PR #53 | `batch-11-gh-feedback` 定向测试 21/21；`batch-12` follow-up #4 真实回放未做 | fixed（代码层），**真实 PR #53 回放待做** |
| F4 name/branch 别名 | 用户报告 | `batch-11-gh-feedback` host+sandbox 测试已覆盖 | fixed（代码层），等部署后在线复验 |
| F5 method 枚举缺描述 | 用户报告 | 无 tools/list 描述断言；conformance 只检查工具名/annotations（`batch-13-platform-eval`） | unverified；需加描述可见性测试 |
| F6 Actions 日志 + 重连 | 用户报告 | `batch-11-gh-feedback` fake 测试；`batch-11-reconnect` 只读结论；L1 real regression 不覆盖长会话 | unverified；Actions helper 要真实 CI run 验证，重连等部署窗口 |
| F7 正面信号 | 用户报告 | `batch-11-write-transaction` 19/19、读写分离测试、capture/scorecard 无回归 | confirmed；作为不变量保护 |

## 不可比项（明确列出，不硬比）

- 在线单 HTTP request 的 `durationMs` ≠ L1 的 `p95LatencyMs`（task 级端到端）。
- capture `response.bytes` ≠ `tokensPerTask`（runner 统计），不能换算。
- 在线没有 completion/searchHit/toolHit 标签；L1 没有用户提示词/长会话漂移。
- PR #53/#56/#57 是外部 GitHub 事实，不等于本网关 R2 capture 证据。

## 说明：状态为何这样写

- F1 标 `confirmed` 是因为 `write-replay-2026-11-23.md` 与本批用户报告相互印证
  （同一症状 + 已定位修复），但**没有 requestId 回放**，所以整体
  `status: unverified` 仍保留——整批只有在所有项端到端验证后才升级。
- F3/F4 标 `fixed` 指"代码层已修且有确定性测试"，不等于"线上已验证"。
- F2/F5/F6 证据不足，保持 `unverified`，**不据此改代码**。

> 校验命令：
> `node scripts/record-online-feedback.mjs docs/eval/online-feedback-2026-11-23.md`
> （stdout 为确定性 JSON；本文件含说明性章节，脚本只解析 `Key: value` 元数据与 `## F<n>` 小节）。
