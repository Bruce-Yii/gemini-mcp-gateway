# B15 — 在线反馈一等评测流程与首批评录（2026-11-23）

> 范围（本批只写以下 5 个文件）：
>
> - `docs/eval/ONLINE-FEEDBACK.md`（新增，schema + 流程）
> - `docs/eval/online-feedback-2026-11-23.md`（新增，本批记录）
> - `scripts/record-online-feedback.mjs`（新增，纯解析/校验/输出）
> - `tests/online-feedback.test.js`（新增）
> - 本台账 `docs/ledger/batch-15-online-eval.md`（新增）
>
> **未改** `src/`、其它 scripts、其它 tests、`README`、workflows、契约文档。
> **未 commit / push / deploy**，改动全部留在工作区，由 lead 集成。
> 凭据未触碰；脚本不联网、不写生产，只写 stdout。

## 一、目标

把「用户主动向 Gemini 提问得到的在线反馈」做成一等评测对象：定义
`online-feedback.v1` schema、明确 online 与 semi-online（L1/G6）的互补关系、
提供离线校验工具，并把 2026-11-23 这批反馈按 schema 落成可回放记录。

**不是**：不是自动修复闭环，不是把用户报告当事实，不是用在线数据替换 L1/G6
基线，不是模型建议驱动的改动。按 `AGENTS.md`，任何修复都要先有确定性回归测试。

## 二、关键认知：在线 vs 半在线是同一时间线的两种验证

| | 在线反馈 | 半在线 L1/G6 |
|---|---|---|
| 能抓到 | 真实提示词歧义、长会话漂移、结果形状脏数据、部署后客户端缓存症状（本次 F1/F6） | 可重跑的 completion/searchHit/toolHit、固定任务集、基线回归 |
| 盲区 | 缺 runner trace、常无 requestId、写路径 capture 覆盖不全、用户可能误归因 | 构造不出真实用户上下文；上游失败 server 的任务被分母口径掩盖（见 `l1-real-regression-2026-11-23.md`） |
| 对照 | 靠 `time.window` + `session/task` + `requestIds` + PR 号显式锚定；对不上写 `unknown`，不猜 | 每条反馈按 `offline.comparison.linked` 标 `unverified/confirmed/fixed/wontfix` |

依据文档：`docs/eval/online-offline-join-2026-11-22.md`（capture 写路径缺口、
不可比指标清单）、`docs/eval/session-marker-2026-11-23.md`（session 锚点）、
`docs/eval/capture-verification-2026-11-23.md`（requestId 全链路对账）。

## 三、交付物

1. **`docs/eval/ONLINE-FEEDBACK.md`**：schema 权威说明 + 流程。定义 `time/window`、
   `platform`、`project`、`session/task`、`feedback[]`（severity/category/
   symptom/evidence{source,detail,captureVerified,pr}/reproduction/requestIds/PR/
   status）、`offline.comparison`、`status`（unverified/confirmed/fixed/wontfix）。
   硬校验规则：severity ∈ P0/P1/P2；requestIds 只能是 UUID 或 `unknown`；
   PR 只能是正整数（或 `#53`/`PR #53`/`pull/53` 归一化）；缺 evidence 即失败。
2. **`scripts/record-online-feedback.mjs`**：纯函数 `parseInput` /
   `recordFromMarkdown` / `recordFromJson` / `validateRecord` / `toJson`，
   支持 JSON 与 markdown（`## F<n>` + `Key: value`）输入；CLI stdout 输出确定性
   JSON，校验失败非零退出 + stderr 错误列表；不联网、不写仓库、不写当前时间。
   入口守卫用 `pathToFileURL` 处理 Windows 路径。
3. **`tests/online-feedback.test.js`**：26 项离线测试（合法/非法记录、缺
   evidence、severity/status、requestId/PR 解析与归一化、输出确定性、真实记录
   文档解析、CLI 跨平台入口）。
4. **`docs/eval/online-feedback-2026-11-23.md`**：本批 7 条记录（6 问题 + 1
   正面），保留 PR #53/#56/#57 证据；无 requestId 全部写 `unknown`。
5. 本台账。

## 四、逐条反馈的后续动作（本批不实施修复）

> **重要**：任务描述问「哪些已由 B15 修」——B15 本身**只做评测流程与记录**，
> 不改代码。下表按证据如实归属：代码层修复发生在 B8/B11 等先前批次，
> B15 的职责是登记、对照、定状态。任何「已修」都指"代码层 + 定向测试"，
> 不等于"线上已验证"。

| 项 | 严重度 | 本批状态 | 已修归属（证据） | 待复现 / 待部署验证 |
|---|---|---|---|---|
| F1 `fileResult(r).content` 混入下载提示，写脏 docs/17 + 5 前端文件 | P0 | confirmed（代码层） | `write-replay-2026-11-23.md`：normalizeFileResult 优先 `resources[].text` 并提取 SHA；PR #56 洗净、PR #57 清脏文件；`tests/codemode-file-pr-helpers.test.js` | **待真实窗口回放**：用可关联 requestId 的 `execute_read` 读文件，确认 content 首段是正文、无下载提示；无 requestId 不升级整批状态 |
| F2 `get_file_contents` 的 `branch` 被静默忽略回退 main | P0 | **unverified** | 无 | **需要新增复现**：测试仓库建分支写差异内容 → execute_read 传 branch → 比对内容；建议补一条 L1 task，让 G6 基线覆盖非默认分支读取 |
| F3 `prResult` 把 DB id 5444514334 当 PR number（真实 #53） | P1 | fixed（代码层） | `batch-11-gh-feedback` 反馈 2：URL 优先、id 仅作字符串；21/21 定向测试；PR #53 为外部事实 | **待真实 PR #53 回放**（`batch-12` follow-up #4）：用 `{id:5444514334,url:/pull/53}` 跑 merge helper |
| F4 `createBranchIfMissing` name vs branch 割裂 | P1 | fixed（代码层） | `batch-11-gh-feedback` 反馈 1：host/sandbox 接受 name/branch/branchName 三别名；含 capture `d6f59a7e...` 报错证据 | **待部署后在线复验**：新窗口用 `branch` 参数建分支成功 |
| F5 `pull_request_read` 聚合 method 枚举未写进描述，多一轮试探 | P1 | **unverified** | 无 | **需先看上游 schema 原样 + sanitizeTool 输出**；若确认缺枚举，补一条 tools/list 描述可见性测试（与 B7/B8 可见性契约同源）；不直接改 tools/list（工具名/数量必须稳定） |
| F6a 缺 GitHub Actions 失败日志 | P2 | **unverified** | `batch-11-gh-feedback` 反馈 3：网关侧 REST helper `github_actions_list_workflow_runs/jobs/get_job_logs`，不新增对外工具数，fake 测试覆盖 | **待真实 CI run 验证** `get_job_logs`（需 GITHUB_TOKEN，确认 302 不转 token、2MiB 截断） |
| F6b 发版后长会话 unknown_tool，手动 @ 恢复 | P2 | **unverified**（外部客户端行为） | `batch-11-reconnect`：网关不能强制客户端重连；Skew Protection 不适用；Google 侧 wire 未抓到 | **待部署窗口复验**：旧会话调用观察 unknown_tool → 手动 @ 恢复；网关侧只能做缓解与记录，不下"已修"结论 |
| F7 正面：单次脚本批处理、原子多文件、read/execute 分离、safeAll/unwrap | P0（保护项） | confirmed | `batch-11-write-transaction` 19/19（`github__push_files` 原子提交）；读写分离与 capture 指标无回归 | 作为**不变量保护**：后续改动若触及批处理/原子写/分层，须回归确认不回退 |

## 五、测试与结果

- `node --check scripts/record-online-feedback.mjs`：通过。
- `node --test tests/online-feedback.test.js`：**26 / 26 通过**，0 fail。
- `node scripts/record-online-feedback.mjs docs/eval/online-feedback-2026-11-23.md`：
  exit 0，stdout 203 行 JSON；`schema=online-feedback.v1`，`feedback=7`，
  `status=unverified`；F1.PR=[56,57]、F3.PR=[53]；所有 requestId=`unknown`。
- 输出确定性：同一文档两次解析 + `toJson()` 逐字节相等（测试覆盖）。
- 未跑全量 `npm test`：本批零 src 改动，且其它 agent 可能在并发改仓库；
  由 lead 统一复跑。若全量出现与本批无关的失败，以本文件定向结果为准。

## 六、风险 / 限制

1. **整批状态保持 `unverified`**：即使 F1/F3/F4/F7 单项已 confirmed/fixed，
   没有 requestId 端到端回放就不升级整批。这是刻意的诚实做法。
2. **不编造 evidence**：本次反馈没有可关联 capture 的 requestId（用户报告里
   未给出，也没有对应 R2 envelope），全部写 `unknown`；PR #53/#56/#57 是外部
   GitHub 事实，不当成网关 capture 证据。
3. **markdown 解析是宽松的**：脚本只认 `Key: value` 与 `## F<n>` 结构；文档的
   说明性章节被忽略。若后续记录格式漂移，需同步解析器（一处）。
4. **不替代 L1/G6**：本流程没有 runner 标签，不与 scorecard 硬比；
   在线 request 与离线 task 没有共同分母。
5. **修复归属如实写**：B15 不修代码；表的「已修归属」指向 B8/B11 等已有证据，
   避免把用户反馈误登记成"本批已解决"。

## 七、给 lead 的后续接入建议（本批未做）

1. 部署窗口后，先做 F1/F2 的真实窗口回放并记录 requestId，把整批状态从
   `unverified` 升级为 `confirmed`。
2. 为 F2 增加一条 L1 task（非默认分支读取），补 G6 基线覆盖。
3. F3 的真实 PR #53 回放、F6a 的真实 Actions 日志调用，按 `batch-12`
   follow-up #4 执行；结果回填 `online-feedback-2026-11-23.md` 的 `status`。
4. F5 先取证再决定是否需要描述可见性测试；遵守"工具名与数量稳定"不变量。
5. 后续每次在线反馈按 `ONLINE-FEEDBACK.md` 流程新增 `online-feedback-<date>.md`
   并跑校验脚本，不直接改 `src/`。
