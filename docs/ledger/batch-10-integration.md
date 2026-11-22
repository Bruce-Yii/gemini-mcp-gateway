# B10 · 已合入 host helper 接入 Code Mode（唯一允许改 `src/codemode.js` 的任务）

> 日期：2026-11-23。把 `batch-10-canonical.md` / `batch-10-patch-write.md` /
> `batch-10-idempotent.md` 已合入的 host 侧纯模块接入沙箱。
> 本次只改 **3 个文件**：`src/codemode.js`（允许）、新增
> `tests/b10-codemode.test.js`、新增本台账。
> 未改 `src/upstreams.js` / `src/capture.js` / `src/result-normalize.js` /
> `src/file-write.js` / `src/github-helpers.js` / README / CHANGELOG；
> **未 commit / push / deploy**，改动留在工作区。

## 一、接了什么

### 1. Canonical adapter（host bridge）

| 沙箱 API | 实现路径 |
|---|---|
| `codemode.normalizeFile(value, toolName?)` | `__dshInvoke("normalizeResult", ["file", name, value])` → host `normalizeResult()` |
| `codemode.normalizePr(value, toolName?)` | 同上，`kind="pr"` |
| `codemode.normalizeIssue(value, toolName?)` | 同上，`kind="issue"` |
| `codemode.normalizeResult(toolName, value)` | 同上，`kind="dispatch"` |

- host 侧直接复用 `src/result-normalize.js` 的 `normalizeResult`（只读 import，未改文件），
  所以字段集合、去重、`raw` 语义与 host adapter **完全一致**。
- `run` SDK 的 host bridge 用结构化克隆：guest 函数无法跨桥。因此 **stateful 编排 helper
  在 guest 侧实现**，而 canonical 归一化走专用 bridge 函数（只传 kind / toolName / value）。
- 默认工具名：`get_file_contents` / `get_pull_request` / `get_issue`；传显式 `toolName` 时尊重调用方。
- `fileResult` / `prResult` **行为零改动**（保留独立实现，不替换、不删除）。
- 覆盖真实 capture 回归：GitHub `get_file_contents` 的 `content[0].text` 是
  “successfully downloaded … (SHA: …)”下载提示，正文在嵌套
  `{type:"resource", resource:{text}}`；集成测试断言提示不会被当正文（`raw` 保留）。

### 2. 编排 helper（guest 侧，复用 host 逻辑，调用真实工具白名单）

| 沙箱 API | 默认工具（已按 `data/tool-dataset.json` 核对） |
|---|---|
| `codemode.applyFilePatch({owner,repo,path,patch,branch,message,dryRun=true,readTool?,writeTool?,tools?})` | 读 `github__get_file_contents({owner,repo,path,ref})`；写 `github__create_or_update_file({owner,repo,path,content,message,branch,sha})` |
| `codemode.ensureBranch({owner,repo,name,fromBranch,ifExists,tools?})` | `github__list_branches` → `github__create_branch({owner,repo,branch,from_branch})`（reset 还需 `github__delete_branch`） |
| `codemode.upsertPr({owner,repo,head,base,title,body?,state?,tools?})` | `github__list_pull_requests` → `github__create_pull_request` / `github__update_pull_request` |
| `codemode.fetchAllPages({tools:{pageTool},maxPages,cursorKey,pageArgs?,pageBased?})` | 任意分页工具（必须显式给 `pageTool`；GitHub 侧如 `github__search_code`） |
| `codemode.repoGrep({owner,repo,listTool,readTool,pattern,flags,limit,listArgs?,readArgs?})` | `listTool` 必须显式给（如 `github__search_code`）；读默认 `github__get_file_contents` |

实现要点：

- 所有 helper 通过 `__dshInvoke("tool", [ident, args])` 调工具，与
  `codemode.<tool>(args)` **同一条桥**：工具调用预算、审计、`toolCalls`、只读去重全部复用；
  没有新权限，也不硬编码任何 token / 私有 API。
- 工具名可配置：`tools: {readTool, writeTool, listTool, createTool, ...}` 或直接
  `readTool` / `writeTool` / `pageTool` / `listTool` / `readTool`；默认值来自 GitHub 白名单。
- `applyFilePatch` 流程：读 → canonical/fileResult 解出正文 → **strict context patch**
  → 生成 diff；`dryRun`（默认 `true`）到此为止，**绝不写**；只有 `dryRun:false`
  且 patch 成功时才调用写工具，并把读到的 `sha` 作为乐观锁参数透传。
  返回 `{ok, diff, commitSha?, content?}`；失败返回 `{ok:false, error, diff?}`。
- bridge 级错误（工具预算耗尽 / 未知工具）在 guest 侧**重新抛出**，不会被 helper 的
  `try/catch` 降级成 `{ok:false}` 数据，从而保持 execute 的边界语义。
- 所有新增 helper 都经 `__dshHide` 包装（`.constructor === undefined`），
  guidance 只增补简短一行；`search` / `execute_read` / `execute` 的 MCP tool schema
  **完全不变**（仍是 `search{query,limit}` / `execute{code}`）。

## 二、哪些仍是 host-only（没接进沙箱的部分）

- `src/file-write.js` 的 `applyTextPatch` 本身仍是 host 纯函数；沙箱里用的是
  `codemode.applyPatch`（原有字符串 helper），`applyFilePatch` 复用它的 strict 校验语义。
  两者不是同一个函数对象，但行为对齐（context mismatch 整体失败、CRLF 归一、末尾换行保守）。
- `src/github-helpers.js` 的 `ensureBranch` / `upsertPr` / `fetchAllPages` / `repoGrep`
  原样保留为 host 纯模块；**沙箱版本是按同一契约在 guest 侧重写的**，并非把 host 函数
  注入沙箱（bridge 不能传函数）。host 调用方不会因此改变行为。
- 未做 CAS 重试：`read` 与 `write` 之间文件被他人改动时，strict context 会拒绝并报错，
  不会自动合并；`sha` 只是透传给上游做乐观锁。
- 未接入网关层“结果自动归一化”：模型仍需显式调用 `codemode.normalize*`。
- 未做真实 GitHub capture 回放 / L1 smoke 的端到端验证（本次是单元 + fake 工具级）。

## 三、工具名依赖与失败边界

- 工具名以 `data/tool-dataset.json` 为准；若上游工具改名或该工具未挂载，
  `__dshInvoke("tool", ...)` 抛 `unknown tool: ...`，helper 不写任何东西。
- `get_file_contents` 的 `ref` 参数只在传了 `branch` 时设置；写工具的 `sha`
  只在读到 sha 时设置（新建文件场景可能不需要）。
- `repoGrep` 的 `listTool` 返回项支持字符串或 `{path,name}` 对象；
  单个文件读失败记入 `errors` 并继续（与 host `repoGrep` 一致），不中断整次搜索。
- `fetchAllPages` 的 `nextCursor` / `next` / `pageInfo.endCursor` 都识别；
  游标不前进视为耗尽；到达 `maxPages` 返回 `truncated:true`。
- 归一化只覆盖 file / PR / Issue 三类；其他工具走 `{raw:value}` fallback。
  结构化克隆会复制 `raw`，不是同一对象引用（host 直接调用仍保留引用）。
- "免费模型分析仅是假设"规则照旧：本批改动只依据源码、确定性测试与真实 capture 形状，
  未根据任何自动建议直接改代码 / 开 issue / 部署。

## 四、测试与证据

- 新增 `tests/b10-codemode.test.js`，**14 个测试**，全部通过：
  canonical 四形态 + `raw`、下载提示回归、隐藏 constructor、dryRun 不写、
  patch mismatch 不写、真实写带 sha/commitSha、read 失败不写、ensureBranch 幂等/创建、
  upsertPr 创建/更新、分页去重与截断、repoGrep 匹配/错误记录、工具预算传播、
  MCP schema 不变。全部使用 fake 工具结果（MCP text-content envelope），**不联网、无凭据**。
- `node --check src/codemode.js` 通过。
- `node --test tests/b10-codemode.test.js` → 14/14 通过。
- 全量 `npm test`：见交付报告（不在这里重复，避免与并行改动的结果漂移）。

## 五、风险

1. **guest 侧重写 ≠ host 函数复用**：逻辑按 host 契约移植，但两份实现未来可能漂移；
   修改 `github-helpers.js` / `file-write.js` 时需同步检查沙箱版本。
2. **canonical `raw` 是克隆**：沙箱内 `raw !== 原始对象引用`（结构化克隆限制），
   仅内容一致；需要引用语义的场景应走 host adapter。
3. **工具参数形状假设**：默认参数按当前 GitHub MCP 白名单填写；上游 schema 变更需更新默认值或显式传 `tools`/`*Args`。
4. **工具预算**：helper 每次 read/write 都消耗 `maxCalls`；一个批量脚本可能被预算截断，
   模型应关注 `codemode.remainingCalls()`。
5. **没有真实写验证**：非 dryRun 分支只用 fake 工具验证，未对真实仓库发起写操作（刻意）。
