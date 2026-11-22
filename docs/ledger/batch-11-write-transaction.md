# Batch 11 · 多文件写入原子化 / 补偿（2026-11-23）

> 范围：只写 `src/file-write.js`、`src/codemode.js`、`src/github-helpers.js`（helper）、
> 新增 `tests/b11-write-transaction.test.js`、新增本台账。
> **未改** `src/capture.js`、`src/result-normalize.js`、`src/server.js`、
> `src/vercel-app.js`、`scripts/`、workflows、`README`、`CHANGELOG`。
> **未 commit / push / deploy**，改动全部留在工作区。

## 一、背景与问题

`applyFilePatches / writeFiles` 已有「全部预检再逐文件写」。但写阶段非原子：
第 N 个文件写成功后第 N+1 个失败，仓库里会留下半成品，调用方拿到 `{ok:false}`
却不知道哪些文件已经落盘，也没有补偿指引。

GitHub 上游存在 `github__push_files`（一次提交多文件），schema：

```
{owner, repo, branch, files:[{path, content}], message}
```

它是天然的事务边界：一次调用要么整批提交，要么整批不提交。本批把它设为
**优先路径**，并保留原逐文件写作为 fallback。

## 二、契约

### 1. `atomic` 选项（`writeFiles` / `applyFilePatches`）

| 条件 | `atomic` 默认值 | 结果 |
|---|---|---|
| 检测到 `github__push_files`（host：`commitFiles` 回调；sandbox：工具在册） | `true` | 原子路径 |
| 未检测到 | `false` | 逐文件 fallback，返回 `atomic:false` + `reason` 说明原因 |
| 调用方显式 `atomic:true` 但工具不可用 | — | **硬失败**：零读、零写，`{ok:false, atomic:false, reason}` |
| 调用方显式 `atomic:false` | `false` | 强制 fallback，理由为「caller disabled」 |

`reason` 固定文本（host / sandbox 一致）：
- `github__push_files unavailable; using per-file writes`
- `atomic write requested but github__push_files is unavailable`
- `atomic write explicitly disabled by caller`

### 2. 原子路径（一次提交）

流程严格按序：**读全部 → 应用 patch → 预检全部 → 一次 `push_files`**。

- 请求体 `files[]` 为 `{path, content}`，content 是**完整的新文本**（非 diff）。
- 成功返回顶层：
  ```
  { ok:true, atomic:true, files:[{path,sha?}], diff?, sha?, commitSha?, url?, number? }
  ```
  `sha/commitSha/url/number` 只在上游真的返回时出现，不伪造。
- `push_files` 抛错或返回 `{ok:false}` → 整批失败：
  `{ok:false, atomic:false, partial:false, written:[], writtenFiles:[], files:[]}`，
  **绝不**降级到逐文件写（避免「原子失败后反而写了一半」）。
- 预检失败发生在提交前 → 零 `push_files` 调用、零逐文件写。

### 3. 非原子 / fallback（原逐文件写）

- 成功：保持 B10 顶层形状（host 额外多 `atomic:false` + `reason`；
  **sandbox 成功路径刻意不返回 `atomic` 字段**，以维持 B10 严格 key 断言
  `['commitSha','diff','files','ok','sha']`）。
- 中途失败 → 明确的部分失败，不伪造成功：
  ```
  { ok:false, atomic:false, partial:true,
    written:[...已写路径], writtenFiles:[...同 written],
    remaining:[...未写路径], compensation:'Restore the N already-written
    file(s)... or re-run with atomic:true (github__push_files)...',
    error, reason?, files, diff? }
  ```
- 如果第一个文件就失败：`written:[]`、`compensation:'No files were written;
  safe to retry.'`。

### 4. 单文件 `applyFilePatch` / dryRun

- 单文件 `applyFilePatch` 的 dryRun 默认、预检、sha 处理、返回字段**完全不变**；
  B10/write-semantics 的严格 key 断言保持通过。
- `atomic:true` 仅作为「同一统一入口」的附加模式：当 push_files 可用时，
  单文件也会走一次 push_files；无该工具时保持原逐文件写与 B10 形状。
- `dryRun:true` 永不调用写工具；原子模式下返回 `atomic:true` 预览，
  非原子模式维持原形状。

## 三、失败边界

| 失败点 | 原子模式 | fallback 模式 |
|---|---|---|
| read 失败 / 截断读 | 零写、整批失败 | 零写、整批失败（既有行为） |
| patch 上下文不匹配 | 零写、整批失败 | 零写、整批失败（既有行为） |
| JSON / JS-TS 预检失败 | 零写、整批失败 | 零写、整批失败（既有行为） |
| push_files 抛错 / `{ok:false}` | 零写、不降级 | n/a |
| 第 N 个逐文件写失败 | n/a | `partial:true` + `written[]` + 补偿建议 |
| 显式 `atomic:true` 但无 push_files | 零读零写硬失败 | n/a |

## 四、如何清理半成品

1. **原子模式失败**：不需要清理 —— 单次 GitHub 提交要么全部生效要么全部不生效。
   检查返回的 `ok`/`commitSha`，若 `ok:false` 直接重试即可。
2. **fallback 部分失败**：读返回值的 `written[]`（= `writtenFiles[]`），按
   `remaining[]` 补齐；若要回滚，把 `written[]` 中每个文件恢复到批次前的
   blob sha（`files[i].sha` 是读到的旧 sha，可用 `create_or_update_file` 写回原文），
   或者改成 `atomic:true` 重跑整批（需要 push_files 可用）。
3. **不知道批次前内容**：先用 `get_file_contents` 在批次开始前记录
   `{path, sha, content}`；本契约保证失败时 `files[].sha` 仍是旧 sha，可作为恢复锚点。
4. 永远不要仅凭 `ok:false` 判断「什么都没写」—— 要看 `partial` 与 `written[]`。

## 五、实现要点

- `src/file-write.js`：新增 `describeAtomicCapability`、`buildAtomicFiles`、
  `commitFiles`/`atomic` 入参；`applyFilePatches` 在 staging + precheck 完成后
  二选一（一次 commit 或逐文件写），失败路径返回部分失败元数据。
- `src/github-helpers.js`：新增 `PUSH_FILES_TOOL`、`detectPushFiles`
  （从 tools 数组 / callables 检测）、`buildPushFilesArgs`（构造精确 schema）。
- `src/codemode.js`：guest 侧 `__dshB10ApplyFilePatch` 用 host 桥 `hasTool`
  精确检测工具在册（不消耗 tool-call 预算，不受 stub 干扰）；
  `tools.pushTool` 可覆盖默认工具名。原子模式调用一次 push_files，
  fallback 维持原路径；RETURN_SHAPE_GUIDANCE 追加原子写入提示。
- 无新增依赖、无网络、无真实凭据。

## 六、测试与结果

新增 `tests/b11-write-transaction.test.js` **19 个测试**（全部 fake，无网络）：

| 覆盖点 | 测试 |
|---|---|
| push_files 成功：一次调用、files[] 完整、零逐文件写、顶层字段齐全 | `host writeFiles atomic success...` / `sandbox push_files success...` |
| push_files 失败（抛错 / `{ok:false}`）零写、不伪造成功 | `host push_files throws...` / `host push_files returns {ok:false}...` / `sandbox push_files failure...` / `sandbox push_files throws...` |
| push_files 不存在 → fallback，且 sandbox B10 严格 key 不变 | `host applyFilePatches: atomic defaults to false...` / `sandbox without push_files...` |
| 预检失败零写（原子 & fallback） | `host atomic precheck failure...` / `sandbox precheck failure...` |
| 单文件回归（dryRun / 写 / 预检 / B10 形状） | `single-file applyFilePatch...` / `sandbox single-file applyFilePatch...` |
| 顶层字段与 helper | `describeAtomicCapability / detectPushFiles...` / `buildAtomicFiles / buildPushFilesArgs...` |
| 部分失败补偿 | `host fallback mid-batch write failure...` / `sandbox fallback mid-batch failure...` |
| 显式 atomic:true 无工具硬失败 | `host explicit atomic:true...` / `sandbox explicit atomic:true...` |

验证命令与结果：
- `node --check src/file-write.js && node --check src/github-helpers.js && node --check src/codemode.js`：通过
- `node --test tests/b11-write-transaction.test.js`：**19 / 19 通过**
- B10 + 相关回归（b10-write-semantics / b10-codemode / file-write / github-helpers /
  codemode / b11-write-transaction）：**94 / 94 通过**
- 全量 `npm test`：见最终交付报告（基线 623，本批新增 19，预期 642；
  若并发改动影响计数，以实际运行结果为准并单独报告本批测试）

## 七、仍未覆盖的风险

1. **上游 push_files 的真实 schema 差异**：本批按用户给定 schema
   `{owner,repo,branch,files:[{path,content}],message}` 构造参数；若实际网关
   暴露的 schema 有额外必填项（如 `commitMessage`），需由 lead 在真实工具列表上确认后调整
   `buildPushFilesArgs`。本批无真实凭据，未做联网验证。
2. **`git` 层面的非原子**：push_files 的原子性是 GitHub API 层面的；
   若模型在 sandbox 里手动拼多次 `create_or_update_file`，本契约无法强制拦截
   （guidance 是提示而非静态分析）。
3. **补偿是建议而非自动回滚**：`written[]` 告诉你哪些要恢复，但不会替你恢复；
   旧内容需要调用方在批次前自行记录（见第四部分）。
4. **`maxCalls` 预算**：原子模式反而省预算（1 次 push 替代 N 次 write）；
   但 staging 阶段每文件一次 read 仍消耗预算，与旧行为一致。
5. **host 与 sandbox 的 `atomic` 字段不对称**：sandbox 成功 fallback 不返回该字段
   （B10 兼容），host 返回；契约文档已写明，模型不应依赖 fallback 成功时的 `atomic`。
