# 评测历史资产打捞（2026-11-24）

> 分支：`docs/mine-eval-history`  
> 范围：只挖本地已有证据，不改 `src/`，不贴 token/secret，不编造 requestId。  
> 结论先行：**主动评测的历史主线是“内容丢失/上下文泄漏 → 结果协议/截断 → 编号/写路径 → 客户端体验”；被动日志的主线是“形状不统一、重试/慢调用、上游套餐/权限噪音”。**

---

## 0. 证据范围与口径

| 来源 | 本地路径 | 时间 | 用途 |
|---|---|---|---|
| Gemini 真实项目反馈 | `docs/GEMINI-REAL-TASK-FEEDBACK.md` | 2026-11-21 | 主动评测 P0/P1 原文 |
| Gemini B5 真实任务 | `docs/ledger/batch-5-gemini-feedback.md` | 2026-11-22 | 主动评测问题与修复 |
| Gemini 在线反馈 | `docs/eval/online-feedback-2026-11-23.md` | 2026-11-23 09:02 SGT | 主动评测 6 问题 + 正面项 |
| ChatGPT 在线反馈 | `docs/eval/online-feedback-2026-11-23-chatgpt.md` | 2026-11-23 09:35 SGT | ChatGPT 只读实测 |
| Gemini 在线反馈 | `docs/eval/online-feedback-2026-11-23-gemini.md` | 2026-11-23 11:13 SGT | 另一轮 Gemini 反馈 |
| PR80–101 反馈 | `docs/eval/ONLINE-FEEDBACK-2026-11-24-PR80-101.md` | 2026-11-24 | 最近真实使用反馈 |
| 被动异常 | `explore/results/anomalies.json` | 2026-11-22T17:50Z | 228 任务、363 异常 |
| analyzer | `work/analyzer/analyzer-output-2026-11-22.json` | 2026-11-22 | 4 个真实 sample |
| capture digest | `work/digest/scorecard-2026-11-22.*`、`work/digest-test/scorecard-2026-11-22+1d.*` | 2026-11-22 | 请求/延迟/错误 |
| capture scorecard | `docs/eval/scorecard-2026-11-23.md` | 2026-11-23 | 20 请求、9 truncation suspects |
| 任务集 | `explore/tasks-v2.json`、`explore/figma-tasks.json`、`explore/tasks-g6.json`、`explore/tasks-smoke.json` | 2026-11 | 高价值任务索引 |

边界：

- 主动反馈多来自旧构建；`requestId` 大多 `unknown`。
- 被动 `clientPlatform` 多为 `unknown`。
- 2026-11-23 scorecard 的 **20 条不是 R2 分页 bug**，是已知“一次执行/单窗口约 20 次”的测试上限；样本小，不能当全量分母。
- `model truncation suspect` 是 advisory，不能直接定罪网关。
- `attribution=gateway` 也不等于网关功能 bug；B7 人工复核显示大量是上游套餐/权限/占位数据。

---

# 1. 历史主动在线评测原文与优缺点反馈

## 1.1 2026-11-21 · Gemini · 真实项目任务

客户端：Gemini web（真实项目，非抽象任务）  
来源：[docs/GEMINI-REAL-TASK-FEEDBACK.md](../../GEMINI-REAL-TASK-FEEDBACK.md)

### 核心原文

> “调 `github__get_file_contents` 读文件时，返回值退化成纯字符串 `successfully downloaded text file (SHA: 91f35b3a...)`，文件内容完全丢失。”

> “`toolCalls` 审计数组把 10 个文件的完整源码内容（数万字符）原封不动塞回上下文。”

> “`execute` 单入口固定标 `destructiveHint:true, readOnlyHint:false`，即便脚本只做 `get_commit` 纯读，宿主也频繁拦截。”

> “触发 `tool call limit (30) exceeded` 后报错中断，已拉取数据全丢。”

### 优点

- 单轮批量编排被明确肯定：拉历史 → 内存校验 10 文件 → `push_files` 原子提交 → 建 PR，20+ 轮压到 1 轮。
- `search` + 按需 schema 发现被肯定：不把全量 schema 塞系统提示。

### 当时问题

| 问题 | 状态 |
|---|---|
| MCP `resource` content 块被丢弃，文件正文丢失 | **已修**（`tool-format.js` 保留 `resource.text/blob/uri`） |
| `toolCalls.args` 全量回显，上下文爆炸 | **已修/部分**（`summarizeArgs` 截断摘要） |
| 读写未分离，纯读也审批 | **已修**（`execute_read` 只读通道） |
| 30 次调用上限，超限整轮作废 | **已修**（默认 50，`remainingCalls()`） |
| 沙箱缺 `TextEncoder/atob/URL/crypto` | **已修**（prelude 注入） |
| 返回值 JSON 字符串/对象混用 | **部分**（`unwrap`/`unwrapBatch`） |
| `listTools()` 输出过重 | **部分**（brief/服务过滤） |

## 1.2 2026-11-22 · Gemini · B5 真实任务

客户端：Gemini web；任务包含 Vercel/GitHub 混查、282KB HTML 解析、图片资产检查。  
来源：[docs/ledger/batch-5-gemini-feedback.md](../ledger/batch-5-gemini-feedback.md)

### 核心原文

> “读 4.8KB README / 14KB RELEASE-GATE 时，对象里同时有 `text`、`resources[].text`、`content` 三份几乎相同正文，体积放大 3 倍并触发截断。”

> “单字段/总返回在约 5K–12K 字符处被截断，提示未写具体上限，只能试探切片。”

> “JSON 字符串、`{result}`、`.text`/`.content` 混用，每次编排先写 `parseMaybe/getText`。”

> “GitHub 图片返回 `encoding`/`download_url` 空，也没有可用的 base64/图片块。”

### 优点

- 同一轮内批量读取 + 端内裁剪，上下文明显受控。
- 图片/二进制链路被提出后补成了 `images[]` native block。

### 当时问题

| 问题 | 状态 |
|---|---|
| 文本三份重复、体积放大 | **已修**（`textBlockBodies` 去重） |
| 截断预算不透明 | **已修**（true cap + `limit/original`） |
| 上游结果形状不统一 | **已修/部分**（`codemode.unwrap`） |
| 图片/二进制无投影 | **已修**（mimeType 门控、1 MiB cap、`images[]`） |

## 1.3 2026-11-23 09:02 SGT · Gemini · 在线反馈

客户端：Gemini web；来源：[docs/eval/online-feedback-2026-11-23.md](online-feedback-2026-11-23.md)

### 核心原文

> “`fileResult(r).content` 首段是下载提示而非正文；该脏文本被写入 docs/17 与 5 个前端文件。”

> “调用 `github__get_file_contents` 时传 `branch=<非 main 分支>`，实际读到的是 main 的内容，未报错也未提示参数被忽略。”

> “`prResult` 把 DB id 1000000001 当 PR number，真实 PR 为 #53。”

> “`createBranchIfMissing` 参数 `name` vs `branch` 割裂（传 `branch` 报 name is required）。”

> “`pull_request_read` 聚合 `method` 枚举未写进工具描述，导致模型多一轮试探。”

### 优点

- 批处理、原子多文件、`execute_read`/`execute` 分离、`safeAll`/`unwrap` 被明确肯定。

### 状态

| 项 | 状态 |
|---|---|
| F1 下载提示混正文（PR #56/#57） | **代码已修**；真实窗口端到端未回放 |
| F2 branch 被静默忽略 | **未验证/待复现** |
| F3 PR number=DB id | **代码已修**（URL 优先） |
| F4 name/branch 别名 | **代码已修** |
| F5 method 枚举不可见 | **未验证** |
| F6 Actions 日志 + 发版后 `unknown_tool` | **部分**（Actions helper 有；重连需客户端侧） |
| F7 正面项 | **confirmed**（不变量保护） |

## 1.4 2026-11-23 09:35 SGT · ChatGPT · 只读实测

客户端：ChatGPT web；来源：[docs/eval/online-feedback-2026-11-23-chatgpt.md](online-feedback-2026-11-23-chatgpt.md)

### 核心原文

> “`codemode.github_actions_get_job_logs` 返回 `{ok:false,status:415,...}`，读不到 Actions 失败日志。”

> “`normalizeFile.path` 返回 null；原始 `resources[].uri` 形如 `repo://Bruce-Yii/<repo>/contents/<path>`，应解析出 path。”

> “canonical content 是纯正文，但 raw envelope 的原始 `value.text` 仍含 `successfully downloaded...`。”

> “旧 `prResult` 只返回一个把 id 与 node_id 混在一起的字段，`canonicalResult` 完全没有 id/nodeId。”

### 优点

- branch 别名控制实验、PR #59 number/checks、大文件 `truncated=false`、工具发现一次命中，均被用户确认为通过项。

### 状态

| 项 | 状态 |
|---|---|
| Actions 日志 415 | **代码已修**（Accept 头/302 signed URL） |
| file path=null | **代码已修**（解析 repo:// contents URI） |
| envelope ≠ canonical | **契约明确**（raw 保留） |
| PR id/nodeId 缺失 | **代码已修**（additive） |
| F5 正面项 | **confirmed** |

## 1.5 2026-11-23 11:13 SGT · Gemini · 另一轮在线反馈

客户端：Gemini web；来源：[docs/eval/online-feedback-2026-11-23-gemini.md](online-feedback-2026-11-23-gemini.md)

### 核心原文

> “文件内容结果 `content` 混入 `successfully downloaded text file (SHA: ...)` 提示行，写回文件时把提示当正文写入，导致脏数据。”

> “PR 结果的 `number` 偶尔是内部对象 ID（数据库 id）而非 PR 号。”

> “并发批处理返回结果包装不统一，调用方容易解包错层。”

> “大返回被整块截断，切掉末尾关键字段。”

> “多文件修改仍逐文件提交，失败时留下半成品。”

> “CI 轮询过碎，通常要 3–4 轮才能等到结果。”

### 优点

> “批处理 + 端内裁剪省上下文；读写隔离清晰；高频动作封装省心。”

### 状态

| 项 | 状态 |
|---|---|
| F1 下载提示混正文 | 代码已修；**待线上复验** |
| F2 PR number=内部 ID | 代码已修；待真实 PR 回放 |
| F3 batch wrapper 不统一 | **已补 `unwrapBatch`**（2026-11-24） |
| F4 大返回整块截断 | **已补结构化截断**（2026-11-24） |
| F5 多文件逐文件提交 | **原子写已有**；需确认调用路径 |
| F6 CI 轮询碎 | `waitForPrChecks` 已有并暴露 guidance |

## 1.6 2026-11-24 · PR #80–#101 · 真实高强度使用反馈

客户端：Gemini/宿主窗口（另一个项目 `Bruce-Yii/recruitment-agent`）  
来源：[docs/eval/ONLINE-FEEDBACK-2026-11-24-PR80-101.md](ONLINE-FEEDBACK-2026-11-24-PR80-101.md)

### 用户明确肯定的优点（核心原文）

> “单次原子推送直接把所有文件打进同一条 commit，再也不像早先那样逐文件提交留下一串碎 commit。”

> “在一个调用里并发读 5–8 个文件，直接在端内做正则检索、行号切片、集合对账……只把几十行结论带回对话。”

> “直接通过网关拉到失败 job 的完整日志，端内搜 `failing tests:` 精准定位。”

> “只读查状态、读源码、看 Issue 评论不会触发写操作心理负担。”

### 用户报告的问题（核心原文）

> “每次读取仓库文本文件，正文开头都会拼着一行 `successfully downloaded text file (SHA: ...)`。”

> “建 PR 返回的 `number` 时不时给的是内部数据库 ID 而不是真正的 PR 编号。”

> “创建 Issue 返回里 `number` 为空，紧接着查 open Issue 列表又因索引延迟返回空数组，导致重复 #90。”

> “并发批处理外面会多包一层 `{ ok, value }` 的状态壳；有些上游返回数组、有些返回 JSON 字符串。”

> “在端内 JS 模板字符串里拼 TypeScript 源码时，正则里的 `\d`、`\s`、`\n` 被外层模板字符串吃掉一层转义。”

> “每次改一个 1,000 行的文件，我大多只能全量读出来做字符串 `replace` 再整文件写回去。”

> “等 CI 收尾的轮询体验很碎，全量单测跑一次大约 2.5–3 分钟……光在等 CI 上浪费十几轮。”

> “CI 偶发失败时不能一键触发 `rerun-failed-jobs`。”

### 状态（2026-11-24 修复后）

| 问题 | 状态 |
|---|---|
| 文件正文前缀 | 代码已有纯净 content 修复；已部署 `5039ac6`；线上复验待做 |
| PR number | `prResult` URL-first；已补 issue canonical |
| Issue 重复/编号空 | **新增 `createIssue` 幂等 + 回查** |
| batch `{ok,value}` | **新增 `unwrapBatch`** |
| TS/正则转义 | **新增写前 TS/JS 预检**（Node 22+；Node20/TSX 降级 unchecked） |
| 整文件 replace | **新增 `editText/applyTextEdits`**（唯一命中） |
| 大返回截断 | **新增结构化 `truncation.fields/tail/next`** |
| CI 轮询 | `waitForPrChecks` 已有并暴露 |
| rerun failed jobs | 有上游工具才调用；无则明确 `UNSUPPORTED_UPSTREAM_TOOL` |
| delete/rename 原子 | 当前 `push_files` 只支持 path/content，**只能两阶段并标 `atomic:false`** |
| 合并后删分支 | 支持显式 `deleteBranch`；默认不删 |

---

# 2. 历史被动日志 / analyzer / explore 真问题

## 2.1 Capture / 延迟 / 截断

### 2026-11-22 单日 scorecard

本地路径：`work/digest/scorecard-2026-11-22.md`

| 指标 | 值 |
|---|---:|
| 请求 | 9 |
| 错误 | 0 |
| p50 | 845 ms |
| p95 | **14,525 ms** |
| 平均 | 2,950 ms |
| 响应字节 | 65,014 |
| 截断/overflow | 0 |

观察：9 个请求里有 1 个 14.5s 尾延迟，说明慢调用不是长尾幻觉，是真实样本。

### 2026-11-22 + 1d（20 条窗口）

本地路径：`work/digest-test/scorecard-2026-11-22+1d.md`

| 指标 | 值 |
|---|---:|
| 请求 | 20（已知单窗口/执行上限） |
| MCP 请求 | 12 |
| 错误 | 8（全部非 MCP 路由 404/405） |
| MCP 错误 | 0 |
| p95 | 6,228 ms |
| 工具调用 | `execute_read` 3 |
| 模型截断嫌疑 | 0 |

> 20 不是 R2 分页 bug；是已知执行/窗口上限。不能把 20 当全量分母。

### 2026-11-23 scorecard

本地路径：`docs/eval/scorecard-2026-11-23.md`

| 指标 | 值 |
|---|---:|
| 请求 | 20 |
| MCP 请求 | 20 |
| 项目匹配 | `github:Bruce-Yii/recruitment-agent` 10 |
| 工具调用 | 10（execute 5 / execute_read 5） |
| 错误 | 3（auth 1 / upstream_4xx 2） |
| p95 | 5,153 ms |
| 模型截断嫌疑 | **9（45%）** |
| 平台 | 全部 unknown |
| 窗口 | 2026-11-23T00:43Z–03:24Z |

诚实解读：

- 9/10 的 truncation suspect 支持“上下文/截断摩擦”方向；
- 不能证明网关截断率 45%；可能是模型脚本自己的 `slice`；
- `clientPlatform=unknown`，不能按客户端分桶。

## 2.2 R2 analyzer 的 3 个真实 sample

来源：`work/analyzer/analyzer-output-2026-11-22.json`  
analyzer 输入 4 个 sample，raw/validated 产出 2 个 P2 issue。

### 抽样 requestId

- `10c13554-6936-4a93-9ef2-9662fa55d1c6` — `execute_read`，6228 ms，11,417 bytes，sandboxTools 11
- `56854cdc-5c79-4980-b4e2-7a12d373dcc2` — `execute_read`，结果形状防御
- `285e881c-aa31-4786-83f4-49285cf9ed25` — `execute_read`，并行读两个分支文件

### analyzer 结论原文

> “Tool result shapes require repeated defensive unwrapping and normalization.”

> “Long chained execute_read call dominates p95 latency.”

> “A single execute_read sample performs many sequential or semi-sequential steps across GitHub, Notion, and Linear … its 6228 ms duration matches the reported p95.”

### 对应修复

- `unwrapBatch` / `codemode.unwrap`（2026-11-24）；
- `waitForPrChecks`、结构化截断；
- 但“跨服务批处理尾延迟”仍没有统一 per-step timing，属于未完成优化。

## 2.3 `explore/results/anomalies.json` 聚类

运行：`run-1795368949291-1d86ee2a`，模型 `hy4-flash-free`，228 任务，5 上游。  
生成时间：2026-11-22T17:50:59Z。

### 总览

| 维度 | 分布 |
|---|---|
| 异常总数 | 363 |
| attribution | model 273 / gateway 86 / synthetic 3 / infra 1 |
| severity | P2 277 / P1 86 |
| server | notion 129 / linear 92 / vercel 68 / figma 59 / github 15 |
| type | retry 182 / execute_error 95 / max_turns 46 / model_confusion 16 / direct_answer 11 / no_tool_call 11 / search_empty 1 |
| rootCause | other 302 / upstream_not_found 24 / upstream_forbidden 15 / unknown callName 7 / enum mismatch 5 / param validation 5 |

### 真实出现的网关/上游错误（带 task/tool）

| Task | 上游 | 证据（摘要） | 归类 |
|---|---|---|---|
| F060 | notion write | `APIResponseError validation_error 400`，`URL type webpage not currently supported for fetch tool`，occurrences 3 | 上游/工具行为 |
| F045/F051/F071 | notion | 同类 `validation_error 400`，occurrences 2/2/2 | 上游校验 |
| F088 | notion | `This tool requires a Business plan or higher`，`mcpRequestId=8c34c893...` | 套餐权限 |
| F097 | linear read | `Could not find referenced Issue`，`requestId=a5e9b9da7bc9090a` | 上游 404/占位 |
| F110 | linear derived | `Could not find team "LIN"` / `Issue state not found` | 上游数据 |
| F112 | linear read | `The query is too complex. Complexity: 19130. Maximum allowed: 10000`，`requestId=a5e9bbee1eb936e7` | 上游复杂度 |
| F116 | linear read | `list_projects: limit: Too big: expected number to be <=50` | 参数校验 |
| F088/F091 | notion | Business plan gates | 套餐 |
| 多 Vercel | vercel | `execute_error` 404/403 聚类，18 条 `upstream_not_found` + 若干 `upstream_forbidden` | 上游权限/占位 |

### 重要归因纠偏

`attribution=gateway` 的 86 条不能直接当网关 bug：

- B7 复核对 86 条逐条核对后，剩下的真实网关缺口只有 Intl（已修）；
- 其余是 Vercel token 权限、Notion Business、Linear 复杂度/团队、Figma 占位 fileKey 等上游/账号问题；
- detector 曾把 `codemode.services()` 的成功对象误报为 `execute_error`，已修。

因此这份数据更适合做：

- 上游套餐/权限/占位数据的回归任务；
- 工具参数校验/枚举的任务；
- 慢调用/重试的任务；
- 不能直接做“网关错误率”分母。

---

# 3. 已有高价值任务清单索引

## 3.1 任务集规模

| 文件 | 数量 | 分上游 |
|---|---:|---|
| `explore/tasks-v2.json` | 191 | github 42 / notion 53 / linear 36 / vercel 60 |
| `explore/figma-tasks.json` | 46 | figma 46 |
| `explore/tasks-g6.json` | 228 | 191 + figma 37 |
| `explore/tasks-smoke.json` | 50 | 每上游 10 |

## 3.2 GitHub（最核心/易踩坑）

| ID | tool | prompt（节选） | 坑点 |
|---|---|---|---|
| F001 | `add_comment_to_pending_review` | “Add a review comment ... on pull request #12 target the file src/app.js at the FILE level...” | 评论锚点/PR 上下文 |
| F002 | `add_issue_comment` | “Add a comment to PR #123: 'LGTM, approved'” | 评论对象、占位 PR |
| F004 | `create_branch` | “Create a new branch called feature/new-login in octocat/Hello-World.” | 写分支、别名 |
| F005 | `create_or_update_file` | “Add a new file named hello-world.md to my feature/new-login branch...” | 分支+文件写 |
| F008 | `delete_file` | “Delete ... docs/old-notes.md from branch main...” | 删除、不可逆 |
| F012 | `get_label` | “Get ... details of the label named 'bug'.” | 读小对象、label 名称 |

## 3.3 Notion（读取/写入/套餐）

| ID | tool | prompt（节选） | 坑点 |
|---|---|---|---|
| F043 | `notion-search` | “What did the product team decide this month about the rollout?” | 语义搜索，不是 ID 查询 |
| F046 | upload/attachment | “Upload the report I attached to our project page...” | 附件/上传链路 |
| F050 | `notion-create-pages` | “Save our deployment discussion to the team wiki.” | 写页面、父页面定位 |
| F051 | `notion-update-page` | “Update https://notion.so/deploy-guide with this correction... Keep the rest.” | 只改局部、不能覆盖 |
| F052 | `notion-delete-pages`（任务标注） | “Find our project notes ... create a project update...” | 任务标注与工具不匹配，需核 |
| F088 | `notion-calendar-list-contacts` | “Use Notion MCP to review my calendar for tomorrow...” | Business 套餐门槛（真实 400） |

## 3.4 Linear（issue/comment/cycle/document）

| ID | tool | prompt（节选） | 坑点 |
|---|---|---|---|
| F097 | `list_comments` | “Start from issue LIN-123. Read the issue description and all its comments...” | 先用 ID 找 issue；占位 issue 会 400 |
| F098 | `save_comment` | “Turn these standup notes into updates on existing Linear issues...” | 多目标匹配、先展示后写 |
| F100 | `list_cycles` | “Identify the most recently completed cycle for teams LIN and FEA...” | team/cycle 过滤 |
| F104 | `save_document` | “Draft a new document on this project...” | 写文档 |
| F110 | `get_issue_status` | “...get the issue status 'In Review' for team LIN...” | 真实上游 `Could not find team "LIN"` |
| F112 | `list_projects` | “Check project status: see what is at risk...” | 真实上游 complexity 19130 > 10000 |

## 3.5 Vercel（文档/部署/日志/分享）

| ID | tool | prompt（节选） | 坑点 |
|---|---|---|---|
| F132 | `search_vercel_documentation` | “How do I configure custom domains in Vercel?” | 读文档、搜索 |
| F134 | `open_deployments` | “Show the deployment for the branch and commit I just pushed.” | 分支/提交匹配 |
| F136 | `get_runtime_logs` | “Show me the runtime error logs for my project from the last hour” | 日志聚合、时间窗 |
| F139 | `get_access_to_vercel_url` | “myapp.vercel.app is protected by auth. Please create a shareable link for it” | 写/分享链接 |
| F140 | `web_fetch_vercel_url` | “Make sure the content from my-app.vercel.app/api/status looks right” | 抓取/内容判断 |
| F141 | `list_ai_gateway_virtual_models` | “List all virtual models configured in the Vercel AI Gateway for team team_abc...” | 嵌套配置、team 占位 |

## 3.6 Figma（官方/生成/代码连接）

| ID | tool | prompt（节选） | 坑点 |
|---|---|---|---|
| FIG-001 | `get_screenshot` | “Take a screenshot of a frame in the test Figma file...” | 先 metadata 找 node |
| FIG-002 | `get_design_context` | “Generate my Figma selection in Vue.” | 官方 verbatim；代码生成 |
| FIG-005 | `get_comments` | “Summarize the unread comments in this Figma file...” | 评论语义/文件 URL |
| FIG-006 | `get_variable_defs` | “Get the variables used in my Figma selection.” | 变量读取 |
| FIG-010 | `generate_figma_design` | “Use generate_figma_design to capture a live web page...” | 生成/捕获 |
| FIG-011 | `generate_diagram` | “Create a flowchart for the user authentication flow...” | 生成图 |
| FIG-012 | `get_code_connect_map` | “Use get_code_connect_map to get Code Connect mappings...” | Code Connect 映射 |

## 3.7 选型建议

- **离线必跑**：F001/F004/F005/F008（GitHub 写路径）、F097/F110/F112（Linear 上游错误/复杂度）、F139（Vercel 写）、FIG-002/FIG-005/FIG-006（Figma 官方）。
- **容易暴露上游套餐/占位的数据**：F088、F110、F112、Vercel 404/403 系列；这些应归为“上游/账号”而非网关 bug。
- **最容易踩坑的客户端路径**：F001 评论锚点、F051 局部更新、F098 先展示后写、F134 分支/提交匹配。
- **不要把它们当同一分母**：不同任务集、不同上游、不同占位数据，不能直接横向算“网关成功率”。

---

## 4. 这次打捞的结论

1. **主动评测的历史价值很高**：每次真实任务都暴露了协议级问题（resource 丢失、toolCalls 泄漏、content 污染、编号错、截断、CI 轮询）。
2. **被动数据能补规模，但不能直接定量**：20 条执行上限、平台 unknown、model truncation advisory、上游噪音，都决定了它不能当“错误率”。
3. **任务集已经有高价值样本**：GitHub 写/评论、Notion 读写/套餐、Linear 复杂度/团队、Vercel 部署/日志、Figma 生成/Code Connect，足以支撑离线回归和半在线抽象。
4. **下一步不是再造任务，而是把主动反馈映射到 F/G/N/J，再进离线任务与真实构建复验**。

> 本文件只做历史资产索引；不改变任何评测结论，不替代 `EVALUATION.md` / `SEMI-ONLINE-GAPS.md` / `ONLINE-FEEDBACK.md`。
