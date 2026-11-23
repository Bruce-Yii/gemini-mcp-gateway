# 在线反馈记录（2026-11-23 · ChatGPT）— `online-feedback.v1`

> 来源：用户通过 **ChatGPT** 客户端、经本地网关（本地 `gemini-mcp-gateway`）
> 做的一次**只读实测**。本记录按 [`ONLINE-FEEDBACK.md`](./ONLINE-FEEDBACK.md) 的
> `online-feedback.v1` schema 写：通过项与失败项都记，证据/工具调用照实抄，
> **requestId 未知就写 `unknown`，绝不编造 UUID**。
>
> 修复边界：本批只改 `src/github-helpers.js`、`src/result-normalize.js`、
> `src/codemode.js` 与新增测试/文档；不改上游 MCP 工具、`src/capture.js`、
> `src/server.js`、`scripts/`、其它 tests、README、workflows；不 commit/push/deploy。
> 遵循 `AGENTS.md`：用户报告与工具输出是待验证证据，本地确定性测试复现后才标
> `fixed`，没拿到 requestId 的项保持 `unverified`。

## 顶层元数据（脚本可解析）

Recorded-at: 2026-11-23T09:35:00+08:00
Window: 2026-11-23T00:00:00Z -> 2026-11-23T23:59:59Z
Platform: chatgpt web
Repo: Bruce-Yii/gemini-mcp-gateway
Session: unknown
Task: unknown
Status: unverified
Baseline: explore/baselines/l1-smoke.json

## F1
Severity: P0
Category: actions-job-logs-415-accept
Symptom: codemode.github_actions_get_job_logs 返回 {ok:false,status:415,error:"GitHub REST returned HTTP 415"}，读不到 Actions 失败日志
Evidence:
Source: user-report
Detail: 用户通过本地网关只读实测：调用 codemode.github_actions_get_job_logs({owner,repo,job_id}) 得到 ok:false / status:415。用户另用 curl 复现：GitHub GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs 在请求头 Accept: application/octet-stream 时返回 415；必须带 Accept: application/vnd.github+json。该 REST 接口随后返回 302 到 signed Blob URL，跟随该 URL 时不能带 Authorization，Accept 用 */* 或 text/plain。证据形式为在线工具输出 + 用户 curl 复现；无 R2 capture 可回放。
CaptureVerified: false
PR: #59
Reproduction: 本批已写确定性测试 tests/gpt-online-fix.test.js：fake fetch 第一次断言 Accept=application/vnd.github+json 且带 token；返回 302 后第二次断言 URL 为 signed 链接、无 Authorization、Accept=*/*；另测 415 → {ok:false,status:415}、200 → text。已跑通 15/15。真实 GitHub 端到端仍需部署后复验。
RequestIds: unknown
Status: fixed

## F2
Severity: P1
Category: result-path-uri-parse
Symptom: normalizeFile.path 返回 null；原始 resources[].uri 形如 repo://Bruce-Yii/<repo>/contents/<path>，应解析出 path
Evidence: Source: user-report
Detail: 在线实测读文件工具的 canonical 结果里 path 为 null，而原始返回值含 resources[].uri = "repo://Bruce-Yii/gemini-mcp-gateway/contents/<path>"。旧 normalizeFileResult 只从显式 path/name/uri 字段取 path，拿到完整 URI 时既不解析也不剥离，导致消费者失去文件路径。无 capture 可回放，requestIds 写 unknown。
CaptureVerified: false
Reproduction: 用真实形状 {text, resources:[{uri:"repo://.../contents/docs/eval/note.md", text:body}]} 跑 normalizeFileResult，断言 path === "docs/eval/note.md"；无 URI 时断言 null（不猜测）；guest codemode.fileResult 同样解析。测试在 tests/gpt-online-fix.test.js，已通过。
RequestIds: unknown
Status: fixed

## F3
Severity: P2
Category: envelope-vs-canonical-content
Symptom: normalizeFile 已正确剥离下载提示，但外层原始 value.text 仍含 "successfully downloaded..."，被误认为修复遗漏
Evidence: Source: user-report
Detail: 在线实测观察到：canonical content 是纯正文（不含 "successfully downloaded text file (SHA: ...)"），但 raw envelope 的原始 value.text 仍带该提示。这是**上游包装**：网关归一化只产出 canonical 字段，不改写上游返回的原始值；raw 按契约保留原引用供审计。结论是「原始 envelope ≠ canonical content」，不是网关 bug，**不改上游**。
CaptureVerified: false
Reproduction: 断言 normalizeFileResult(raw).content 为纯 body 且不含提示；同时断言 out.raw === raw 且 out.raw.text 仍含提示（raw 保留、上游未改）。测试在 tests/gpt-online-fix.test.js，已通过。本项是对 F1/F2 之外的说明性正面结论：无需改代码，状态记 fixed（契约已明确并有测试保护）。
RequestIds: unknown
Status: fixed

## F4
Severity: P1
Category: pr-id-nodeid-additive
Symptom: prResult/canonical 未暴露 PR 数据库 id / node_id；用户需要区分 number 与 id（如 PR #59）
Evidence: Source: user-report
Detail: 在线实测：用户需要区分 PR number（URL 中的 #59）与 GitHub 数据库 id / GraphQL node_id；旧 prResult 只返回一个把 id 与 node_id 混在一起的字段，canonicalResult 完全没有 id/nodeId。要求 additive 保留 id/nodeId（有则 string），number 仍 URL 优先，绝不能用 id 当 number（历史 bug：把 DB id 当 number 导致 merge 404，见 batch-11）。
CaptureVerified: false
PR: #59
Reproduction: 用 {id:1000000001, node_id:"PR_kwDOABC123", number:999, html_url:".../pull/59"} 跑 normalizePrResult / canonicalResult / 沙箱 codemode.prResult：断言 number=59、id="1000000001"、nodeId="PR_kwDOABC123"，且 number !== Number(id)。测试在 tests/gpt-online-fix.test.js，已通过。
RequestIds: unknown
Status: fixed

## F5
Severity: P2
Category: positive-signals
Symptom: 正面项：branch 别名控制实验、PR #59 number/checks、大文件 truncated=false、工具发现均符合预期
Evidence: Source: user-report
Detail: 用户报告的通过项：(a) branch 别名控制实验行为正确（branch→ref 别名不覆盖显式 ref）；(b) PR #59 的 number 从 URL 正确得到 59，checks 读取正常；(c) 大文件读取 truncated=false（未被误判为截断）；(d) 工具发现一次命中，无需反复试探。这些是既有不变量，本批不改其实现，只记录并纳入回归保护。
CaptureVerified: false
PR: #59
Reproduction: 不需要修复。通过 tests/online-gap-regression.test.js（branch 别名 / 发现 / 截断标记）与 tests/result-normalize.test.js（大文件逐字节、truncated 判定）等既有测试保护；改动本批三个 src 文件后已跑全量 npm test 验证无回退。
RequestIds: unknown
Status: confirmed

---

## 与半在线（L1/G6）对照（离线枚举，非脚本字段）

> 本批按 [`SEMI-ONLINE-GAPS.md`](./SEMI-ONLINE-GAPS.md) 的「半在线映射」办理：
> 在线症状抽象成可重跑的本地确定性测试，不把在线 request 当 L1 task，也不
> 拿在线 durationMs/bytes 与 L1 p95/tokens 硬比。

| 反馈项 | 在线证据（ChatGPT 只读实测） | 半在线 / 本地映射 | 对照判定 |
|---|---|---|---|
| F1 Actions 日志 415 | `github_actions_get_job_logs` 返回 415；curl 复现 Accept 问题 | `tests/gpt-online-fix.test.js` 的 415 / 302 / 200 三项 fake-fetch 测试（L1 fake/real 测试的确定性替身） | `fixed`（代码层 + 本地测试）；真实 CI run 端到端待部署后验证 |
| F2 文件 path=null | canonical path 为 null，原始 uri 含 `contents/<path>` | `tests/gpt-online-fix.test.js` 的 URI 解析 / 无 URI→null / guest 一致 测试；canonical 字段回归 | `fixed`（代码层）；真实 capture 回放待做 |
| F3 envelope ≠ content | raw.text 仍含下载提示 | raw 保留契约测试（out.raw === raw）；上游未改 | `fixed`（契约明确，文档记录），无需改上游 |
| F4 PR id/nodeId | 用户需区分 number 与 id（#59） | `{id,number:59,url:/pull/59}` 形状的 ID 分离 / URL 优先测试 | `fixed`（代码层）；真实 PR #59 回放待做 |
| F5 正面项 | branch 别名 / PR #59 checks / 大文件 truncated=false / 发现 | `tests/online-gap-regression.test.js`、`tests/result-normalize.test.js` 既有断言 | `confirmed`；作为不变量保护 |

## 不可比项（明确列出，不硬比）

- 在线一次 HTTP 工具调用的 `durationMs` ≠ L1 的 `p95LatencyMs`（task 级端到端）。
- 在线看到的 `response.bytes` ≠ `tokensPerTask`（runner 统计），不能换算。
- 在线没有 completion/searchHit/toolHit 标签；L1 没有真实用户提示词歧义。
- 本批没有可回放的 requestId（客户端未提供），所有项 `requestIds:["unknown"]`、
  `captureVerified:false`；整批 `status: unverified` 不升级，直到部署窗口回放。

## 半在线映射明细（L1 fake/real ↔ 本批测试）

- **Actions 日志 415 → L1 fake/real 测试**：在线 415 症状被抽象为 `githubRestGet`
  的首跳 Accept 断言 + 302 跟随时的 token 隔离断言；fake fetch 覆盖
  415/302/200，等价于 L1 fake 模式；真实 GitHub（real 模式）需 `GITHUB_TOKEN`
  与部署窗口，本批**不联网、不跑 real**。
- **path / id → canonical 字段测试**：在线 path=null 与 id/number 混淆被抽象为
  `normalizeFileResult` / `normalizePrResult` / `canonicalResult` / 沙箱
  `prResult` 的字段断言；这些是纯函数，确定性、可重跑，属于 L1 层。

> 校验命令：
> `node scripts/record-online-feedback.mjs docs/eval/online-feedback-2026-11-23-chatgpt.md`
> （stdout 为确定性 JSON；本文件末尾说明性章节不参与 `Key: value` 解析。）
