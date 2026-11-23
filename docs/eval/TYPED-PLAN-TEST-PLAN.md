# Typed-first + Code fallback — 详细测试方案

> 状态：**设计稿（未执行）**。本文只定义测试方案，不写生产代码、不改 `src/`/`scripts/`/`tests/`/
> `README`/其他 docs/workflows、不 commit/push/deploy。
>
> 对应台账：`docs/ledger/batch-14-typed-plan.md`（B14）。上游背景：`docs/CODEMODE-SURVEY.md`
> （类型定义进上下文是最大短板）、`docs/eval/L1-SMOKE.md`（L1 口径与冻结基线）、
> `docs/ledger/batch-13-platform-eval.md`（per-platform lane，不硬比）、
> `docs/eval/write-replay-2026-11-23.md`（写路径真实回放）。
>
> 一句话目标：在**不改产品核心**（仍是 `search`/`execute_read`/`execute` 三工具、读写分层、
> capture/eval/写语义不变）的前提下，用 A/B 证明「typed plan 为主 + code fallback」是否优于
> 现状自由 Code Mode。**数据不齐就维持现状，不默认切换。**

---

## 0. 范围与不变量（先固定，避免后面漂移）

### 0.1 本方案要回答的唯一问题

> 对同一批任务、同一 token budget、同一模型，Profile S（`plan:[...]` + 复杂任务 fallback
> `code`）是否在 completion / tokens / repair / 写回放上**不劣于** Profile F（自由 `code`），
> 且在 Gemini 的「自由脚本回退」上有可复现的改善？

### 0.2 不变量（A/B 双方必须完全一致，否则 A/B 无效）

| 不变量 | F 与 S 都必须 |
|---|---|
| 工具面 | 恰好 `search` / `execute_read` / `execute`，同名同序（conformance `stable_tools_list`） |
| schema 管线 | 注册前都过 `sanitizeTool`；Gemini 无 `structuredContent`、text JSON |
| 读写分层 | `execute_read` 内写工具仍是会抛可操作错误的 stub；`execute` 才有写权限 |
| 权限/OAuth/项目标签/session 标签/capture | 全部不变；按 `clientPlatform` 分账，不猜平台 |
| 写语义 | dryRun → 真写 → verify；幂等/审批不因 plan 而绕过 |
| 任务集与 prompt | 逐字复用，不因 profile 改写措辞 |
| token budget / max turns / deadline | 两侧相同（见 §6.3） |

> 任一条被改动，该轮 A/B 作废，不得计入验收。

---

## 1. A/B 定义

### 1.1 Profile F — 现状自由 Code Mode（baseline）

```
search({ query, limit })
execute_read({ code })   // async () => { ... } 自由 JS
execute({ code })        // 自由 JS（含写）
```

- 这是当前生产行为，作为**对照组**。
- 基线来源：`explore/baselines/l1-smoke.json`（G6 228 → L1 50；冻结于 git `6b4254c`，
  runId `run-1795368949291-1d86ee2a`，见 `docs/eval/l1-real-2026-11-22.md`）。
- F 的基线必须**按平台重新冻结**（当前冻结文件是 Gemini 单平台）；ChatGPT/Claude lane
  在首轮跑出自己的 frozen baseline 前记 `no-measurement`。

### 1.2 Profile S — typed plan + code fallback（实验组）

```
execute_read({ plan: [{ op, args, ... }] })        // 只读 typed ops
execute({ plan: [{ op, args, dryRun?, ... }] })    // typed ops（写需 dryRun/批准）
execute({ code })                                 // 仅复杂任务 fallback
```

- **typed-first**：默认路径是 plan；每个 op 走 op registry → schema 校验 → dryRun(写) →
  逐步结果。plan 不是第二套工具面，仍从 `execute_read`/`execute` 进。
- **fallback 触发条件（写死，避免模型随意选）**：
  1. 任务含多步数据变换/条件分支/跨结果拼接，超出 registry 的 op 表达力；
  2. 需要调用 registry 中不存在的 op（op 不存在错误累计 1 次后允许）；
  3. plan 校验/schema 错误累计 ≥ 2 次；
  4. 显式 `fallback: "code"` 由模型在 plan 首步声明（用于「我知道这题要写代码」）。
- fallback 必须**可观测**：`meta.fallback = { reason, attemptPlan, atStep }` 写进 trace，
  否则无法区分「S 用 plan 完成」和「S 偷偷全走 code」（那样 S≈F，实验无意义）。

### 1.3 配对方式（paired A/B）

- 同一任务在 F 与 S 下各跑一次（或按 §6.2 多重复），**prompt 完全相同**。
- 顺序随机化 + 反序复跑一次，抵消学习/缓存效应（见 §6.3）。
- 结果以 task 为单位配对比较（paired diff），不只看聚合率。

---

## 2. 平台 lane（独立基线，禁止跨平台硬比）

| Lane | 是否可跑真实 A/B | baseline | 特殊约束 |
|---|---|---|---|
| **Gemini web** | ✅ 可跑（目标平台） | 复用 `explore/baselines/l1-smoke.json` 的 Gemini 口径，但必须确认该 run 的 `clientPlatform=gemini`；否则先重冻 | Gemini 无 `structuredContent`；schema 必过 `sanitizeTool`；工具名 `__` 分隔；工具列表稳定 |
| **ChatGPT** | ⚠️ 取决于计划：Business/Enterprise/Education 全量 connector 可跑；Pro/Plus 只读 connector 只能跑读任务（写任务标 `no-measurement`） | 首轮在可达 plan 上冻结 `l1-smoke.chatgpt.json` | `docs/CLIENTS-CHATGPT.md`：Free/其他无 connector；DCR 需 `ALLOW_DCR_FOR_CHATGPT=1`；双编码（structuredContent + text JSON）；**不可承诺** |
| **Claude** | ⚠️ 若 plan 可用（Streamable HTTP + OAuth 自定义头）；否则 **protocol-ready**：只跑离线 conformance/schema fixture，不做 A/B | 首轮冻结 `l1-smoke.claude.json`（仅在真实可用时） | annotations 必须显式布尔（`readOnlyHint`/`destructiveHint`）；MCP connector 工具不能进 Anthropic PTC（`CODEMODE-SURVEY.md`） |
| **Inspector** | ✅ 本地 MCP Inspector（确定性，非模型） | 不涉及基线 | 只验证工具面/schema/plan/code 两路参数都能被接受；**不是质量 lane**，是协议守门 |

规则（继承 `batch-13-platform-eval.md` §五）：

1. 分账**只认 envelope 的 `clientPlatform`**，缺失进 `unknown`，不与任何 lane 混算。
2. 每 lane 独立 frozen baseline、独立分母、独立阈值；跨平台差值只能写「观察」，不能当 pass/fail 判据。
3. 某 lane 本轮无任务/无 capture → 报 `unknown (no measurement)`，不补零、不借分母。
4. 真实客户端实测前，ChatGPT/Claude 的 plan 结论一律标 **protocol-ready / 未实测**。
5. 每条结论保留 requestId / taskId，可回到 capture 回放（见 §8.3）。

> **验收的「S 不劣于 F」默认指 Gemini lane。** 其他 lane 数据不足时只给 conformance 与
> protocol-ready 结论，不参与切换决策。

---

## 3. 任务集（40 条：L1 30 + 新增 10；全部标注 expected ops）

### 3.1 来源与选择规则

- 主体从 `explore/tasks-smoke.json`（L1，50 条，确定性 evenPick）里选 **30 条**，保留原 id /
  prompt / server / category，**逐字不改**。
- 新增 **10 条** `TP-xx`，补齐 L1 覆盖不足的维度：长文件、截断、多 repo、失败恢复、
  跨服务写入链、PR 全流程、op 不存在负例。新任务的 prompt 也写成本文表格内容，
  后续若实现 runner，需把本表逐字落成 fixtures（本文不落代码）。
- 层化配额（对齐 L1 的 `byGroup` 思路，但按本测试意图重分配）：

| 维度 | 目标条数 | 说明 |
|---|---:|---|
| 读（含 derived/official） | 10 | 单跳读、搜索、列表 |
| 搜索/检索 | 5 | `search` 命中 + `select:` 负例 |
| 跨服务（cross） | 5 | notion/linear/vercel/github 组合 |
| 写（含 PR 链） | 8 | 其中 PR 全流程 3 |
| 失败恢复 | 5 | schema 错 / op 不存在 / patch anchor 错 / 上游失败 / 超时 |
| 长文件/截断/多 repo | 7 | 长文件、sliceLines、静默截断、跨 repo |
| **合计** | **40** | 读+搜索可重叠计数于「读」列时以主意图归类 |

> `expected ops` 写法：`server__tool`（与 `codemode.<name>` 一一对应，沿用
> `run-explore.mjs` 的 `expectedTool` 口径）；多步用 `→` 串联；`*` 表示允许等价替代。
> 写任务必须给出 `dryRun` 步骤，否则不算完整 expected ops。

### 3.2 L1 选中 30 条（expected ops 逐条标注）

| # | id | server | 主意图 | expected ops（typed plan / code 通用） | 备注 |
|---:|---|---|---|---|---|
| 1 | F010 | github | 读 | `github__get_commit` | 官方逐字；单跳 |
| 2 | F014 | github | 读 | `github__get_me` | 自描述 |
| 3 | F020 | github | 读 | `github__list_commits` | 带 since 参数 |
| 4 | F024 | github | 读 | `github__list_pull_requests` | 列表 |
| 5 | F033 | github | 搜索 | `github__search_code` | search 命中 |
| 6 | F037 | github | 搜索 | `github__search_repositories` | 搜索 |
| 7 | F002 | github | 跨/写 | `github__add_issue_comment` | PR 评论 |
| 8 | F001 | github | 写 | `github__add_comment_to_pending_review` | FILE 级 anchor |
| 9 | F018 | github | 写 | `github__issue_write` | 需 dryRun |
| 10 | F032 | github | 失败恢复 | `github__run_secret_scanning` | boundary |
| 11 | F043 | notion | 搜索 | `notion__notion-search` | 全文搜索 |
| 12 | F048 | notion | 读 | `notion__notion-download-attachment` | 附件（字段兜底） |
| 13 | F073 | notion | 读 | `notion__notion-list-private-pages` | 列表 |
| 14 | F080 | notion | 读 | `notion__notion-view-version` | 版本 |
| 15 | F088 | notion | 失败恢复 | `notion__notion-calendar-list-contacts` | **已知 Business-plan 错误**（`l1-real-regression-2026-11-23.md`），测错误分类 |
| 16 | F046 | notion | 跨/写 | `notion__notion-create-attachment` | 写 |
| 17 | F063 | notion | 写 | `notion__notion-update-comment` | patch/anchor 类 |
| 18 | F052 | notion | 失败恢复 | `notion__notion-delete-pages` | boundary 写权限 |
| 19 | F096 | linear | 读 | `linear__get_attachment` | 单跳 |
| 20 | F107 | linear | 读 | `linear__list_issues` | **含 `Invalid option` schema 负例**（`EXPLORATION-FINDINGS.md`） |
| 21 | F112 | linear | 读 | `linear__list_projects` | 列表 |
| 22 | F117 | linear | 读 | `linear__get_milestone` | derived |
| 23 | F098 | linear | 跨/写 | `linear__save_comment` | 写 |
| 24 | F114 | linear | 跨/写 | `linear__save_project` | 写 |
| 25 | F106 | linear | 失败恢复 | `linear__get_issue` | boundary；编号类查询 |
| 26 | F132 | vercel | 搜索 | `vercel__search_vercel_documentation` | 搜索 |
| 27 | F155 | vercel | 跨 | `vercel__aggregate_pageviews` | 数据变换（**fallback 候选**） |
| 28 | F163 | vercel | 读 | `vercel__list_teams` | 列表 |
| 29 | F134 | vercel | 跨/失败恢复 | `vercel__list_deployments` / `open_deployments` | 0 工具 server 的 degraded 口径 |
| 30 | F139 | vercel | 写 | `vercel__get_access_to_vercel_url` | 访问授权类 |

> Figma 10 条（FIG-001…FIG-043）不进主 A/B：配额低、默认跳过（沿用 L1 规则）。
> 仅在 Gemini lane 显式授权后作为附加读任务，结果单列，不并入分母。

### 3.3 新增 10 条 `TP-xx`（补齐覆盖）

| # | id | server | 意图 | prompt（逐字） | expected ops | 测什么 |
|---:|---|---|---|---|---|---|
| 31 | TP-01 | github | 长文件 | "Read `src/codemode.js` from Bruce-Yii/gemini-mcp-gateway on main and tell me only the lines defining `normalizeCode`." | `github__get_file_contents` → `codemode.sliceLines` | 长文件 + 行级切片 |
| 32 | TP-02 | github | 截断 | "Read the largest file in the repo and report its last 20 lines." | `github__get_file_contents` → `sliceLines(last)` | 静默截断检测（B11） |
| 33 | TP-03 | github | 多 repo | "Compare `README.md` in `octocat/Hello-World` and `Bruce-Yii/gemini-mcp-gateway`; list two differences." | `github__get_file_contents` ×2（不同 repo） | 跨 repo 参数 |
| 34 | TP-04 | github | PR 全流程 | "Create branch `tp/replay`, add `work/tp.txt` with 'one\\ntwo', dryRun a patch changing 'two'→'TWO', then commit and open a PR." | `github__create_branch` → `github__create_or_update_file` → `applyFilePatch(dryRun:true)` → `applyFilePatch(dryRun:false)` → `github__create_pull_request` | 写回放 + dryRun（对齐 `write-replay-2026-11-23.md`） |
| 35 | TP-05 | github | 失败恢复 | "Patch `work/tp.txt` on branch tp/replay replacing line containing 'NOTFOUND' with 'x'." | `applyFilePatch` → 预期 anchor 错 → 重定位后重试 | patch/anchor 错分类 |
| 36 | TP-06 | notion | 跨服务 | "Find the launch decision page in Notion, then create a Linear issue titled 'Follow up: <title>'." | `notion__notion-search` → `linear__save_issue` | 跨服务链 + 参数传递 |
| 37 | TP-07 | linear | 失败恢复 | "List issues with option `bogus-option` and recover by using a valid value." | `linear__list_issues` → schema 错 → 重试 | 参数/schema 错 |
| 38 | TP-08 | github | op 不存在 | "Call a tool named `github__notARealTool` and then recover to get_me." | `github__notARealTool`(负例) → `github__get_me` | op 不存在 + fallback 触发 |
| 39 | TP-09 | vercel | 失败恢复 | "List deployments for a project when the upstream returns 500; retry once and report failure." | `vercel__list_deployments` → 上游失败重试 | 上游失败分类 |
| 40 | TP-10 | github/code | 复杂 fallback | "For each PR closed last week, fetch its files, count changed lines per file, and return the top 3 by churn with links." | `github__list_pull_requests` → `github__get_pull_request_files` ×N → **code fallback**（聚合/排序） | 证明 S 在复杂任务确实 fallback 到 code |

### 3.4 expected ops 的使用

- `searchHit` 用 `search` 结果是否含 expected ops 的第一个 `server__tool` 判定（沿用
  `run-explore.mjs` 的 `toolNameMatches`）。
- `toolHit` 用 `execute(_read)` 脚本/plan 内是否出现 expected ops 全部关键名判定。
- 写任务必须检查 `dryRun:true` 出现在真写之前，否则记「写回放成功率」失败。
- `TP-08`、`F107`、`F088` 等负例**不要求 completion**，只要求错误被正确分类并恢复。

---

## 4. 指标定义（统一口径，写进每条 trace）

| 指标 | 定义 | 判据来源 |
|---|---|---|
| `completion` | 任务完成率；**anomaly proxy**（无 `runner_error`/`max_turns_exceeded` 即完成），不用原始 `finished`（harness 伪影）。负例任务按「正确识别+恢复」单独计 | `l1-real-2026-11-22.md` §完成率 |
| `toolHit` | `execute(_read)` 调用中出现 expected ops 关键名的比例；null 剔除口径与冻结基线一致，另报 `toolHitAdjusted`（null 当 miss） | `L1-SMOKE.md` §分母 |
| `searchHit` | `search` 结果命中 expected op 的比例；同样报 `searchHitAt3` 与 adjusted | 同上 |
| `repair` 次数 | 每次「调用后返回 error / schema 错 / op 不存在 / 空结果重试」计 1；按 task 求均值。含 fallback 触发前的 plan 重试 | 本方案新增 |
| `tokens` | `totalTokens/task`（输入+输出）；S 需把 plan schema 指引 token 计入，不能漏算 | trace `summary.totalTokens` |
| `p95` | 端到端 task wallMs 的 p95；与在线单请求 p95 不可比（`online-offline-join` §3.3） | trace `wallMs` |
| `写回放成功率` | 写任务中 `dryRun → 真写 → verify` 三步齐全且结果字段齐全（`sha`/`commitSha` 等）的比例；真写类用受控测试仓库 | `write-replay-2026-11-23.md` |
| `错误分类命中率` | 每个错误归属到 §5 的 8 类之一的比例；未分类=漏标 | 本方案新增 |
| `fallback 率` | S 任务中 `meta.fallback` 出现的比例；按 reason 拆分 | 本方案新增（S 专属） |
| `op 覆盖率` | plan 中实际用到的 op 数 / registry op 数；衡量 typed 面是否够用 | 本方案新增（S 专属） |

> 分母规则沿用 L1：失败 server 的任务从分子分母**同时剔除**，`skippedByServer` 记录数量；
> 主指标保留 null 剔除以对齐冻结基线，`*Adjusted` 作诊断。禁止 `baseline === current`。

---

## 5. 失败分类（8 类，互斥；每条错误必须落一类）

| 代码 | 类别 | 判定信号 | 示例（本任务集） |
|---|---|---|---|
| `E1` | tool 选择错 | `search` 多次未命中 expected op；调了无关工具 | T019 曾 `select:` 空结果 |
| `E2` | 参数/schema 错 | 工具返回 `Invalid option` / validation error | F107 `Invalid option: expected one of ...` |
| `E3` | op 不存在 | `Unknown tool` / `notARealTool` / plan op 不在 registry | TP-08 |
| `E4` | patch/anchor 错 | `applyFilePatch` 返回 hunk 未匹配 / dryRun diff 空 | TP-05、F063 |
| `E5` | 写权限 | `requires Business plan` / 只读 stub 报错 / token scope 不足 | F088 `This tool requires a Business plan` |
| `E6` | 上游失败 | 5xx / timeout / upstream connect fail / `failedServers` | TP-09、F134 degraded |
| `E7` | 模型放弃 | `max_turns_exceeded` / 无 further tool call / 明确说无法完成 | — |
| `E8` | 静默截断 | 结果含 `--- TRUNCATED ---` 但模型未察觉并使用截断内容 / 无 ack 的 wire truncation | TP-02 |

分类原则：

- 按**第一个导致任务无法继续的错误**归类，不按最后一个。
- 免费模型/归因器的分类只是**假设**（AGENTS.md 硬规则）：每条必须能回到 `requestId` +
  本地用同 code/args/fixtures 复现；复现不了标 `unverified`，不计入验收统计。
- E6（上游失败）剔除时不写 gateway 回归；E5 区分「客户端 plan 限制」与「网关权限」，后者才是网关问题。

---

## 6. 实验设计

### 6.1 三种环境（按可信度递进，不可互相替代）

| 环境 | 用途 | 网络/凭据 | 输出 |
|---|---|---|---|
| **fake** | 接线验证：plan registry 校验、dryRun、fallback 触发、指标计算、A/B runner 正确性 | 零网络零凭据；`harness/fake-upstream.mjs` | 确定性测试，**不代表质量** |
| **replay** | 离线回放既有 G6/L1 traces + 新 fixture，验证指标口径与错误分类；可批量重放 S 计划（把 F 的脚本拆成 plan） | 离线；fixture 来自 `explore/results/traces/*.json` 与 capture envelope | 指标一致性检查；不是新质量证据 |
| **real** | 真实模型 + 真实上游 A/B；唯一可用于切换决策的数据 | 模型 key + 上游 token（从 vault 读，见 AGENTS.md） | `docs/eval/typed-plan-ab-YYYY-MM-DD.md/.json` |

规则：fake/replay 结果**不得**写成「S 优于 F」的证据；只能证明测试管线正确。

### 6.2 样本量与重复次数

| 环境 | 任务数 | 重复 | 说明 |
|---|---:|---:|---|
| fake | 40 全跑 | 1 | 每次 CI 都跑 |
| replay | 40 全跑 | 1 | 每次 CI 都跑；口径回归 |
| real（Gemini） | 40 | **3 次**（共 120 task-profile 对；F/S 各 120） | 3 次用于算中位数与置信区间；单次波动不作为结论 |
| real（ChatGPT/Claude，若可用） | 只读可达子集 | 3 次（至少 1 次 conformance） | 数据不足标 protocol-ready，不进切换判据 |
| 写回放（真实 GitHub） | TP-04 + F018/F063 | 各 1 次（成功即清理） | 受控测试仓库，不做破坏性操作 |

**配对**：每个 (task, repeat) 生成一对 (F结果, S结果)；比较用 paired diff，报告同时给聚合与逐 task 表。

### 6.3 控制模型非确定性（关键）

| 手段 | 具体做法 |
|---|---|
| 同 prompt | F/S 使用 `explore/tasks-smoke.json` 原文与 §3.3 表格逐字 prompt；不因 profile 改措辞 |
| 同 token budget | 两 profile 传相同 `maxOutputTokens`/`maxTurns`/deadline；S 的 plan schema 指引**计入** token，不额外放水 |
| 同温度/同模型版本 | 固定 `hy4-flash-free` 版本与 temperature=0（若 API 支持）；记录 model id 与 build |
| 顺序抵消 | 每个 repeat 交替 F→S / S→F（repeat 1 F先、2 S先、3 F先），抵消缓存/学习效应 |
| 新会话 | 每个 (task, profile, repeat) 用新 `initialize` 拿新 sessionId；不复用上下文（session marker 已验证可行） |
| 失败重跑规则 | 仅 E6（上游失败）/infra 可重跑一次；E1–E4/E7/E8 必须保留原样，不能「重跑到过」 |
| 冻结 | 每轮 real 写 `runId`/`gitSha`/`model build`/`timestamp`/`failedServers` 到 manifest；**基线只从冻结文件读，绝不读当前 run 产物**（`tests/l1-baseline.test.js` 已覆盖该自引用 bug） |
| 人工复核 | 所有 E1–E8 分类由 lead 按 requestId 回 capture 复核；免费模型输出只作假设 |

### 6.4 公平性检查表（每轮 real 开始前逐条勾）

```
[ ] F/S 工具列表完全相同（platform-conformance stable_tools_list = pass）
[ ] F/S schema 都过 sanitizeTool；Gemini lane 无 structuredContent
[ ] F/S prompt 逐字相同；token budget / maxTurns / deadline 相同
[ ] F/S 使用同一批 40 任务、同一 failedServers 剔除口径
[ ] F/S 每个 (task,repeat) 新 session；顺序按反序规则
[ ] 基线来自冻结文件，不是当前 run 产物
[ ] 写任务在受控仓库，dryRun 先于真写，成功后清理
[ ] 所有凭据来自 vault/环境变量，未写入仓库、日志、报告
```

---

## 7. 验收门槛（不达标就不切）

### 7.1 硬门槛（必须全部满足，缺一不切）

| # | 判据 | 阈值 | 不达标处理 |
|---:|---|---|---|
| A1 | completion(S) ≥ completion(F) − 3pp（每 lane 独立判） | −3pp | 保持 F |
| A2 | tokens/task(S) ≤ tokens/task(F) | ≤ F | 保持 F |
| A3 | repair/task(S) ≤ 0.7 × repair/task(F)（降 ≥30%） | −30% | 保持 F |
| A4 | 写回放成功率(S) ≥ 写回放成功率(F) | ≥ F | 保持 F |
| A5 | 冻结基线口径正确（无 baseline===current，无借分母） | 必须 | 该轮作废重跑 |
| A6 | 平台 lane 独立；无跨平台硬比；无标签进 unknown | 必须 | 该轮作废重跑 |
| A7 | conformance 四检查（gemini_no_structured_content / chatgpt_dual_encoding / claude_annotations / stable_tools_list）在对应有 fixture 的 lane 全 pass | 必须 | 阻断切换 |

### 7.2 观察项（不作为硬门槛，但写进报告）

- `searchHit`/`toolHit` 的变化方向（期望 S 因 typed op 名更稳定而上升，但不是切换充分条件）。
- fallback 率与 fallback reason 分布（期望复杂任务 TP-10/F155 才 fallback；若 > 50% 任务 fallback，S≈F，收益存疑）。
- 错误分类分布（期望 E2/E3/E4 下降；E6/E5 与 F 持平）。
- p95（S 的校验/dryRun 可能增加延迟，允许小幅上升但需在报告写明）。

### 7.3 决策条款（写死，防止事后放宽）

> **「数据不到不切」**：任一 lane 无 ≥3 次有效 real 重复、或某硬门槛未达、或数据被判为
> unverified/口径不一致 → **不默认切换 Profile S**，继续以 F 为默认，S 仅作 opt-in 实验。
>
> 只有 **Gemini lane 全部门槛通过且经 lead 人审确认**，才能提「把 S 设为默认」的后续提案；
> 本方案本身不执行切换、不改任何生产配置。
>
> ChatGPT/Claude 无真实可用 plan 时，结论只能是 **protocol-ready**（schema/conformance 通过），
> 不得据此声明 A/B 通过。

---

## 8. 可执行清单（先写什么、fixture 从哪来、怎么回放、CI 怎么跑）

### 8.1 实现顺序（最小验证链；本文不写这些代码，只列清单）

| 序 | 要写的测试（新增，未来由实现 agent 落） | 依赖 fixture | 通过条件 |
|---:|---|---|---|
| 1 | `tests/typed-plan-registry.test.js` — op registry 枚举、unknown op 拒绝、schema 必填校验 | 无（纯函数） | E3 正确抛；合法 op 通过 |
| 2 | `tests/typed-plan-dryrun.test.js` — 写 op 无 dryRun 拒绝；dryRun 不产生写；真写后才 verify | `harness/fake-upstream.mjs` | 写回放三步齐全 |
| 3 | `tests/typed-plan-fallback.test.js` — §1.2 四个 fallback 条件各自触发；`meta.fallback` 记录 reason | 假 op 错误 | 4 条件全覆盖；≤2 次 plan 错才 fallback |
| 4 | `tests/typed-plan-partial-fail.test.js` — 多 op plan 中途失败的部分写语义（与 B11 对齐） | fake | 失败时不静默吞；前序结果可见 |
| 5 | `tests/typed-plan-error-classify.test.js` — §5 八类各一条样本，含 unverified 标记 | §3 任务样本 | 8/8 分类正确 |
| 6 | `tests/typed-plan-ab-metrics.test.js` — paired diff、分母口径、baseline 非自引用 | `explore/results/traces/` + 冻结基线 | 口径与 L1 一致；无 baseline===current |
| 7 | `tests/typed-plan-platform.test.js` — 三 lane 分账、unknown 不借分母、conformance gate | `work/fixtures/*.json` | 每 lane 独立；unknown=no measurement |

> 与 `typed-plan-spike` agent 的 `scripts/typed-plan-spike.mjs` 对齐：spike 只做
> op registry/校验/dryRun/部分失败、无生产接线；上述测试只针对 spike 接口，不碰 `src/`。

### 8.2 Fixture 来源（全部已存在于仓库或可从现有产物导出）

| 来源 | 用途 | 备注 |
|---|---|---|
| `explore/tasks-g6.json`（228）/ `explore/tasks-smoke.json`（50） | 任务与 prompt 原文 | 不改 prompt |
| `explore/results/traces/*.json`（T/F/FIG/B/V 系列） | replay 输入；searchHit/toolHit/tokens 口径 | 含 `expectedTool`/`summary`/`messages` |
| `explore/results/anomalies/*.json` | 错误分类与 completion proxy 校验 | 免费模型输出只作假设 |
| `explore/baselines/l1-smoke.json` | F 基线（Gemini） | 只从此处读，不从当前 run 读 |
| `harness/fake-upstream.mjs` | fake 模式上游 | 零凭据 |
| R2 capture envelope（`capture/YYYY-MM-DD/<requestId>.json.gz`） | 真实失败样本回放、requestId 证据链 | 经 `capture-digest.mjs` 脱敏；写路径 envelope 覆盖缺口见 `online-offline-join` |
| `work/fixtures/*.json`（conformance） | Gemini/ChatGPT/Claude 编码 fixture | `platform-conformance.mjs` 输入格式 |
| 受控 GitHub 测试仓库 | TP-04 写回放 | 成功后清理分支/文件；token 从 vault |

### 8.3 回放流程（每一步可追溯到 requestId）

```
1. 选任务 → 从 tasks-smoke.json 取原文 + §3.3 新任务表
2. fake:   node --test tests/typed-plan-*.test.js        （零网络）
3. replay: node <typed-plan-replay> --mode replay --input explore/results/traces/
           → 校验 searchHit/toolHit/tokens/错误分类与冻结产物一致（口径回归，非质量证据）
4. real:   node <typed-plan-ab-runner> --profile F --tasks <40> --repeat 3 --platform gemini ...
           node <typed-plan-ab-runner> --profile S --tasks <40> --repeat 3 --platform gemini ...
           （CLI 参数名待实现 agent 确定；本文只定义行为）
5. 写回放: 受控仓库跑 TP-04；成功后删分支/文件
6. 汇总:   paired diff + §7 门槛 → docs/eval/typed-plan-ab-YYYY-MM-DD.{md,json}
           每条结论带 requestId/taskId；未复现的分类标 unverified
```

### 8.4 CI 怎么跑（不新增 workflow 文件，接入现有）

- **每次 PR**：在 `.github/workflows/ci.yml` 的测试步骤追加 `node --test tests/typed-plan-*.test.js`
  （由 lead 在实现落地后改 workflow；本文不改）。fake + replay 必绿；失败阻断 PR。
- **每日/每次 L1**：在 `.github/workflows/l1-smoke.yml` 里加一个 **typed-plan paired 模式开关**
  （默认 off），打开时对同一批 40 任务跑 F/S 各一次 fake/replay；real 模式不进日常 CI
  （烧额度/需凭据），只在人工触发时跑，产物落 `docs/eval/`。
- **conformance gate**：把 `scripts/platform-conformance.mjs` 作为每 lane 写基线前的 gate
  （沿用 `batch-13-platform-eval.md` §六步 3）：fail 阻断，unknown 标 no-measurement。
- **禁止**：CI 里不 commit 报告、不 push、不 deploy；real 报告作为 artifact 保留，人工决定合并。

### 8.5 最终交付检查（跑完后逐条勾）

```
[ ] docs/eval/typed-plan-ab-YYYY-MM-DD.md + .json 已生成（含逐 task paired 表）
[ ] 每个硬门槛 A1–A7 有 pass/fail/no-measurement 明确值
[ ] 错误分类 8 类均有样本；unverified 单列
[ ] fallback 率/reason 分布已报告
[ ] 写回放三步齐全且测试仓库已清理
[ ] 平台分账正确；unknown 未借分母；无跨平台硬比
[ ] 未 commit / push / deploy；未改 src/scripts/tests/README/其他 docs/workflows
```

---

## 9. 风险与限制（诚实边界）

1. **typed plan 不是银弹**：`CODEMODE-SURVEY.md` 指出类型进上下文能提升参数正确率，但
   Anthropic 数据也显示「顺序单调用场景 code mode 反而 +8% 成本」；简单读任务 S 未必更快。
   本方案用 paired diff 而不是聚合率来捕捉这点。
2. **S 可能退化为 F**：若大多数任务都 fallback 到 code，S≈F，tokens 还多一层 plan 开销，
   A2 会自然失败，这正是要检测的。
3. **真实 capture 写路径覆盖缺口**：`online-offline-join-2026-11-22.md` 证明 `execute`
   调用可能没进 R2；写回放成功与否以受控仓库 verify 为准，capture 仅作辅助证据。
4. **平台计划不确定**：ChatGPT Pro/Plus 只读、Free 无 connector；Claude PTC 不支持 MCP
   connector 程序化调用；这些 lane 可能永远只到 protocol-ready，不得强行宣称 A/B 通过。
5. **免费模型非确定性**：已用 3 重复 + 反序 + 冻结 + 人工复核控制；仍不能消除所有噪声，
   结论只在阈值边缘外的差异上可信（−3pp / −30% 是留了余量的门槛）。
6. **AGENTS.md 硬规则**：任何模型给出的「S 更好」判断都必须回到 requestId 本地复现；
   本方案把它写进分类与决策流程，不让模型建议直接触发切换。

---

> 本文件为新增设计稿。所有 CLI 名（`<typed-plan-replay>` / `<typed-plan-ab-runner>`）为
> 行为占位，待实现 agent 定名后回填；本文未创建、修改任何生产代码或测试文件。
