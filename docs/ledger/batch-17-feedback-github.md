# B17 · PR #80–#101 反馈：GitHub / API 类根因修复

> 状态：**代码 + 测试已修，未 commit / push / deploy**。
> 本次**只写**以下文件：
> - `src/execution/github-helpers.js`（修改）
> - `src/execution/result-normalize.js`（修改）
> - `src/execution/codemode.js`（修改）
> - `tests/feedback-github.test.js`（新增）
> - 本文（新增）
>
> `src/execution/codemode-v2.js` **未改**（typed-plan 路径不消费这些 sandbox helper，无需改动）。
> 没有改其他任何文件；对外三工具面（`search` / `execute_read` / `execute`）与默认行为不变。
> 依据：`docs/eval/ONLINE-FEEDBACK-2026-11-24-PR80-101.md` §2/§5（OF-1/3/5/8/9/10）。
> 遵循 `docs/ledger/README.md`：反馈是待验证线索，不编造上游能力；所有结论附本地证据。

---

## 0. 交付物

| 文件 | 内容 |
|---|---|
| `src/execution/github-helpers.js` | 新增 `createIssue` / `canonicalIssue` / `unwrapBatch` / `rerunFailedJobs` / `mergePrWithOptionalBranchDelete` / `deleteFiles` / `renameFiles` / `UNSUPPORTED_UPSTREAM_TOOL` |
| `src/execution/result-normalize.js` | 抽出共享 `canonicalIdentity`；`normalizePrResult` / `normalizeIssueResult` / 新增 `canonicalIssueResult` 共用同一 URL-first + id-分离规则 |
| `src/execution/codemode.js` | guest prelude 暴露 5 个新 helper + 统一 `unwrapBatch`；host registry 从**实际挂载的工具**构建 callables；新增 `B17_FEEDBACK_GUIDANCE` 并注入两个 execute 描述 |
| `tests/feedback-github.test.js` | 27 个确定性回归测试（全 fake，无网络/无 token/无墙钟） |
| 本文 | 根因 / 实现 / 证据 / 限制 / 未验证 |

---

## 1. 根因（逐条回到源码）

1. **建 Issue `number` 空/内部 id、创建后索引延迟导致重复创建 #90**
   - `result-normalize.js` 原有 `normalizeIssueResult` 与 `github-helpers.js` 的 `canonicalResult` 各自维护一份 number 解析规则，可能漂移；创建路径没有「建前查重 + 建后短轮询回查」，列表索引最终一致导致模型重试时重复建 Issue。
   - `create_pull_request` 实测返回 `{id:1000000001, url:'.../pull/53'}`，把 id 当 number 会让后续 merge 404（已有 URL-first 规则，但 Issue 路径未覆盖）。
2. **建 PR number 偶发内部 id**：URL-first 仅覆盖部分路径；`prResult`（guest）与 `normalizePr`（host）是两套实现，需统一到同一身份解析核心。
3. **批处理多包一层 `{ok,value}`**：`codemode.unwrapBatch` 不处理 JSON 字符串与 `{result}`/`{value}` 信封，模型需手工再剥一层。
4. **不能 rerun failed jobs**：无对应 helper；`waitForPrChecks` 已实现但未在两个 execute 描述里稳定可发现。
5. **合并后自动删源分支**：能力（delete tool）存在但没有「显式 opt-in」的合并包装，且默认不能自动删。
6. **重命名/删除要两次 commit**：`push_files` 的 schema 只有 `{files:[{path,content}]}`，**不支持 delete/rename 字段**；原仓库没有 helper，不能直接假称原子。

---

## 2. 实现要点

### 2.1 `createIssue`（OF-1）
- 工具名从**注入的 `callables`** 解析，覆盖 `create_issue` / `issues_create` / `issue_write`（后者自动带 `action:'create'`）及 list/get 的实际命名差异；host registry 用 `buildCallables()` 从 `byIdent`（本会话实际挂载的工具）构建，绝不硬编码上游能力。
- **建前查重**：按 `repo + 归一化 title/body` 在 list 工具结果里查找；命中则 `created:false, reused:true`，零 create 调用（幂等）。list 调用失败时 fail closed（`DEDUPE_PRECHECK_FAILED`），不盲目创建。
- **建后短轮询**：create 响应缺 number/URL 时，用 get（优先）或 list 回查最多 `maxPolls`（默认 5）次；`number` 只从 URL 或显式 number 字段取，`id`/`node_id` **永不**作为 number 兜底；轮询耗尽返回 `numberMissing:true` 而不是猜一个数。
- 标准返回 `{ok, created, reused, issue:{number,id,url,state,title,raw}, polls, foundAfterCreate}`；`raw` 标 `UNTRUSTED_RAW_MARKER`。

### 2.2 canonical 统一（OF-2）
- `result-normalize.js` 新增 `canonicalIdentity(value,{numberKeys})`：`unwrap` → 全信封搜 URL（`findNumberUrl` 已覆盖 root/result/items/pull_request link）→ 显式 number 字段 → 绝不 id 兜底。
- `normalizePrResult` / `normalizeIssueResult` / 新增 `canonicalIssueResult` 全部走这一核心；`nodeId` 仍为非枚举附加字段，稳定字段集不变。`github-helpers.canonicalIssue` 与之同规则。

### 2.3 batch 解包（OF-3/10）
- Host `unwrapBatch(input)` 与 guest `codemode.unwrapBatch` 统一契约：**任何输入**（单值 / `{ok,value}` / JSON 字符串 / 嵌套数组 / `{result}` 单键信封）都返回**扁平** `[{ok,value}]`；`codemode.unwrap(x)` 继续负责单层上游信封。
- 两个 execute 描述增加明确 guidance：不要手工再剥一层 `{ok,value}`。

### 2.4 CI（OF-5）
- `rerunFailedJobs({owner,repo,runId})`：只在注入了 rerun/run-workflow 工具时调用；**未注入返回 `{ok:false, code:'UNSUPPORTED_UPSTREAM_TOOL'}`，绝不静默假成功**。工具名从 callables 解析（含 `github__rerun_failed_jobs` / `run_workflow` 等实际变体）。
- `waitForPrChecks` 保持既有实现，并在 execute/execute_read 描述与 `B17_FEEDBACK_GUIDANCE` 中显式暴露（一次调用最多 30s）。

### 2.5 合并后删源分支（OF-9）
- `mergePrWithOptionalBranchDelete({..., head, deleteBranch:true, deleteBranchTool})`：**只有显式 `deleteBranch:true` 且注入删除工具**才删；默认不删，行为不变。缺 tool 返回 `code:UNSUPPORTED_UPSTREAM_TOOL` 且 `branchDeleted:false`，删除异常写进 `deleteError`，不吞错。

### 2.6 delete / rename（OF-8）
- **事实**：`push_files` 只支持 `{path,content}`，没有 delete/rename 字段；因此向不注入 git-data callback 的路径**明确返回 `atomic:false`**：
  - `deleteFiles`：逐文件删除，`partial` 反映失败/部分成功，`remaining` 列出未完成路径。
  - `renameFiles`：每文件 `read → write(dest) → delete(src)`，`partial:true`、`commitsRequired:2`，从不声称原子。
  - 仅当注入 `gitData` callback（等价 git data API）才一次调用并返回 `atomic:true`。
- guest 侧 `codemode.deleteFiles` / `codemode.renameFiles` 走同一 host 逻辑；tool 缺失时 helper 报明确 unsupported/partial，不伪造提交。

### 2.7 可发现性
- 新增 `B17_FEEDBACK_GUIDANCE`（5 行）拼进两个 execute 的 `description`；`execute_read` 额外列出 `unwrap(x)`。三工具名称/顺序/schema 不变；所有 helper 都是 sandbox-only，没有新增 MCP 工具。

---

## 3. 证据

```
node --test tests/feedback-github.test.js
  tests 27 / pass 27 / fail 0

node --test tests/github-helpers.test.js tests/normalization.test.js \
  tests/normalization-order.test.js tests/codemode-unwrap.test.js tests/b10-codemode.test.js
  tests 54 / pass 54 / fail 0

node --check src/execution/github-helpers.js
node --check src/execution/result-normalize.js
node --check src/execution/codemode.js
  → 均通过
```

全量 `npm test`（本批交付前实跑，含其他并发批次的测试）：**1506 tests / 1500 pass / 0 fail / 6 todo / skipped 0**。
基线 1461 + 本批新增 27 + 其他并发批次新增测试；中途曾出现 1 个失败
（`tests/online-gap-regression.test.js` T1 的 bracket-balance precheck），经确认由并发批次
对 `src/execution/file-write.js` 的改动引入，修复后全量重跑为 0 fail；本批未改该文件。

---

## 4. 限制 / 未验证

- **不联网**：所有测试用 fake callables；真实 GitHub MCP 工具是否暴露 `issue_write` / `rerun_failed_jobs` / delete-file / git-data API **未验证**，按实际挂载情况返回 unsupported。
- `createIssue` 的短轮询间隔是退避上限 1000ms 的同步 fake 友好实现；真实沙箱无阻塞 timer，host 侧 `sleepMs` 可注入替换。
- dedupe 只比较 title + 可选 body（不做语义相似）；不同 body 的同名 Issue 不会被误合并。
- rerun 的成功含义是「上游工具调用成功」；CI 是否真的重跑需另用 `waitForPrChecks` 观察，本 helper 不冒充结论。
- delete/rename 在默认路径会产生多个 commit，且中途失败可能留下部分结果（`partial:true` / `remaining`）；补偿需调用方执行（与既有 writeFiles 的 partial 语义一致）。
- 未改 `codemode-v2.js`：typed-plan 的 op 集合与这些 helper 无关（不同路径），避免无谓变更。
- **未部署**：生产仍是 `1481408`；本批次只做本地修复与回归测试，部署需另按 `docs/DEPLOY-POLICY.md` 决策。

---

## 5. 不做的事

- 不改三工具面、不改默认行为、不 commit / push / deploy；
- 不编造上游能力（缺工具就 `UNSUPPORTED_UPSTREAM_TOOL`）；
- 不把内部 id 当 number；不假称 delete/rename 原子；
- 不修改 `src/execution/codemode-v2.js` 或其他未声明文件。
