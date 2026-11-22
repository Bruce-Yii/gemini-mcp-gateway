# B10 后续 · Gemini PR #41–#48 写入语义增量建议（2026-11-23）

> 范围：只写 `src/codemode.js`、`src/file-write.js`、`src/github-helpers.js`、
> 新增 `tests/b10-write-semantics.test.js`、新增本台账。
> **未改** `src/capture.js`、`src/upstreams.js`、`scripts/`、workflows、`README`、
> `CHANGELOG`；**未 commit / push / deploy**，改动全部留在工作区。
> 免费模型分析仍是待验证假设；本批只按源码、确定性测试与真实工具 schema 落地，
> 未依据任何自动建议直接改动线上或发起写操作。

## 一、现状（本批之前）

- `src/github-helpers.js` 已有 `ensureBranch`（reuse/reset）、`upsertPr`、
  `fetchAllPages`、`repoGrep`，均为注入回调的纯模块。
- `src/file-write.js` 已有 `applyTextPatch`（strict context、原子失败）+ 可注入
  I/O 的 `applyFilePatch`（默认 dryRun）。
- `src/result-normalize.js` 已有 file/PR/Issue canonical adapter（保留 `raw`）。
- `src/codemode.js` 已把这些接进沙箱：`codemode.applyFilePatch`、
  `ensureBranch`、`upsertPr`、`fetchAllPages`、`repoGrep`、`normalize*`。
- 缺口（PR #41–#48）：建分支不是推送入口的幂等选项；单文件 sha 要模型自己读；
  单/多文件写法与返回形状不统一；PR/Issue/merge 结果没有稳定的顶层
  `number/url/sha`；大文件补丁没有写前轻量预检。

## 二、本批实现

### 1. `create_branch_if_missing`（幂等建分支选项）

| 位置 | API | 行为 |
|---|---|---|
| `src/github-helpers.js` | `createBranchIfMissing({listBranches,createBranch,deleteBranch?,name,base,ifExists})`，别名 `create_branch_if_missing` | 薄封装 `ensureBranch`：`base` 映射到 `fromSha`；不存在则从 base 建，存在则 reuse；`ifExists:'reset'` 是显式 opt-in，缺少 `deleteBranch` 时明确报错 |
| `src/codemode.js` | `codemode.createBranchIfMissing` / `create_branch_if_missing` | guest 侧薄包装，把 `base`/`fromBranch` 归一成 `fromSha` 后调用既有 `__dshB10EnsureBranch`，走同一条工具桥 |

- 没有新权限、没有新 MCP 工具；`reset` 仍只删后建，不做 rebase / 三方合并。
- 回调错误照旧不吞：`ensureBranch` 的 `listBranches`/`createBranch`/`deleteBranch`
  抛错原样传播。

### 2. 统一写入入口 + sha 自动补齐

| 位置 | API | 返回 |
|---|---|---|
| `src/file-write.js` | `applyFilePatch` 增强：`includeContent`、`precheck`、`resolveSha`（内部）、第 3 个 write 参数 `{sha,path}` | 保持原 `{ok,diff,commitSha?,content?}`，新增失败时的 `precheck` 标记 |
| `src/file-write.js` | 新增 `applyFilePatches(...)` / 别名 `writeFiles(...)` | 统一 `{ok,files,diff,sha,commitSha,number?,url?}`；单文件 `diff` 为对象、多文件为数组 |
| `src/file-write.js` | 新增 `normalizeWriteResult(value,{sha})` | 顶层恒有 `sha`/`commitSha`（未知为 `null`），上游给了 `number`/`url` 才带上 |
| `src/codemode.js` | `codemode.applyFilePatch` 重写为统一入口，`codemode.writeFiles` 为其别名 | 接受 `{path,patch,sha?}` 或 `{patches:[...]}`；读结果里的 `sha` 自动补齐；先全部 stage + 预检，再逐文件写；返回同一字段集合 |

- 单文件未传 `sha`：从 `get_file_contents` 的 canonical/fileResult 结果里取
  `sha`，透传给 `create_or_update_file` 作乐观锁；显式 `sha` 永远优先。
- 多文件与单文件走**同一段逻辑**（同一 read→patch→precheck→write 路径），不再
  两套形状；顶层 `sha`/`commitSha` 取自最后一个写响应，`number`/`url` 仅在
  上游返回时出现（`optional` 字段不伪造）。
- dryRun 仍是默认安全态：只读、只返回 diff，不写、不造 commit 数据。

### 3. PR/Issue/merge 顶层 `number/url/sha`

- `src/github-helpers.js` 新增 `canonicalResult(value)`：复用 result-normalize
  的“防御解包 + 显式字段优先 + 保留 `raw`”思路，产出最小稳定集合
  `{number,url,sha,raw}`；显式字段优先，URL 正则只是**兜底**（不再依赖抠 URL）。
- `unwrapResultPayload` 处理 JSON 文本 / `{result}` / MCP `{content:[{type:'text'}]}`。
- 不覆盖 `normalizePr`/`normalizeIssue` 的既有字段集合（向后兼容）；
  需要统一最小视图时显式调用：
  - host：`canonicalResult(value)`
  - sandbox：`codemode.canonicalize(value)`、`codemode.normalizeMerge(value)`
    （`normalizeResult` 的 `kind='merge'|'canonical'` 也走这条）
- 写响应同样通过 `normalizeWriteResult` 保证顶层 `sha/commitSha`。

### 4. 写前轻量预检（失败不写）

- `src/file-write.js` 新增 `precheckText(text,path)`：
  - `.json` → `JSON.parse` **严格解析**（trailing comma / 语法错一律拦）。
  - `.js/.jsx/.ts/.tsx/.mjs/.cjs/.mts/.cts` → 括号/引号平衡扫描（跳过字符串、
    模板串、行注释、块注释及转义）；**不是 tsc / AST / 类型检查**，通过不代表能编译。
  - 其他扩展名 → `check:'none'`，直接放行。
- `applyFilePatch`（非 dryRun）在写前执行；失败返回 `{ok:false,error,precheck,diff}`
  且**不调 write**。`applyFilePatches` 对全部文件先 stage + 预检，任一失败则
  **整批零写入**。
- 沙箱通过 host 纯函数桥 `__dshInvoke("precheckText",[text,path])` 复用同一实现，
  没有把语法检查逻辑复制成第二份。

## 三、工具名依赖

沿用 `data/tool-dataset.json` 的 GitHub 白名单，未引入新工具：

| 用途 | 默认工具 | 关键参数 |
|---|---|---|
| 读文件 / 取 sha | `github__get_file_contents({owner,repo,path,ref})` | `ref` 仅在传 `branch` 时设置 |
| 单文件写 | `github__create_or_update_file({owner,repo,path,content,message,branch,sha})` | `sha` 为读到的 blob sha（自动补齐或显式传入） |
| 建分支 | `github__create_branch({owner,repo,branch,from_branch})` | `from_branch` = `base` |
| reset 删分支 | `github__delete_branch({owner,repo,branch/name})` | 仅 `ifExists:'reset'` 时需要 |
| PR 幂等 | `github__list_pull_requests` / `github__create_pull_request` / `github__update_pull_request` | 沿用 B10 集成 |
| merge 归一化 | `github__merge_pull_request`（结果形状由 `canonicalResult` 解析） | 不新增调用路径，仅解析结果 |

工具名可通过 `tools:{...}` / `*Args` 覆盖；上游改名或未挂载时，桥抛
`unknown tool: ...`，helper 不写入、不伪造结果。

## 四、失败边界

- patch context 不匹配、hunk 越界 → 原子失败（原文本返回），不写。
- 预检失败 → 不写；多文件批次中任一文件失败 → 整批不写（先 stage 后写）。
- 读失败 / 写工具抛错 / 写响应 `{ok:false}` → 原样报错，不报成功。
- bridge 级错误（工具预算耗尽、未知工具、未知 bridge 函数）在 guest 侧重新抛出，
  不被 helper 的 `try/catch` 降级成 `{ok:false}` 数据。
- `sha` 缺失（新建文件）是合法的：不传 `sha`，交给上游决定。
- 没有 CAS 重试：read 与 write 之间被他人改动时靠 strict context + `sha`
  让上游拒绝，不自动合并。
- JS/TS 预检只查括号与引号平衡：**不保证语法/类型正确**，也刻意不假装 tsc。

## 五、测试与证据

- 新增 `tests/b10-write-semantics.test.js`，**19 个测试**，全部通过：
  - host `createBranchIfMissing`：reuse / missing-from-base / reset opt-in / 缺 deleteBranch 报错。
  - sandbox `createBranchIfMissing`：reuse / create / reset（delete+create from base）。
  - sha 自动补齐（host `getSha` 与 sandbox 读结果）、显式 sha 优先。
  - 单/多文件返回同一顶层字段集合；`number/url` 可选字段行为。
  - 顶层 `number/url/sha`：`canonicalResult`（PR/Issue/merge/MCP text/nested/URL 兜底）、
    `unwrapResultPayload`、sandbox `canonicalize`/`normalizeMerge`、`normalizeWriteResult`。
  - 预检：JSON 严格、JS/TS 括号/引号、注释跳过、其他扩展名放行；失败不写、
    多文件批次整批不写、sandbox 预检失败零写调用。
  - 新 helper 全部 `__dshHide`（`.constructor===undefined`）。
- 全部使用 fake 工具 / 注入回调，**不联网、无真实凭据、无真实写**。
- `node --check src/codemode.js` / `src/file-write.js` / `src/github-helpers.js` 通过。
- 全量 `npm test` 结果见交付报告；未改既有测试，既有
  `tests/b10-codemode.test.js` / `file-write.test.js` / `github-helpers.test.js`
  全部保持绿。

## 六、风险

1. guest 侧编排 helper 仍是按 host 契约重写（bridge 不能传函数）：两份逻辑需同步维护；
   本批把预检/归一化/写结果折叠放到 host 纯函数桥，减少了一份重复。
2. 预检是启发式的：模板字符串里的复杂插值、正则字面量中的括号可能误判，
   可用 `precheck:false` 关闭；通过预检不等于语法/类型正确。
3. 多文件逐文件写不是原子提交：中途某文件失败时，先前文件可能已写入。
   严格说“预检阶段整批零写”成立、“写阶段事务性”不成立；需要原子性应改用
   `push_files` 并自行放弃 sha 乐观锁（本批未做）。
4. 顶层 `sha` 语义是 blob sha、`commitSha` 是提交 sha；上游只回一个 `sha` 时
   两处都会出现该值，调用方应按上游语义解读。
5. 工具参数形状按当前白名单假设；schema 变更需更新默认值或显式传 `tools`/`*Args`。
6. 未做真实 GitHub 写回放 / L1 smoke 端到端验证（刻意，避免对真实仓库写操作）。
