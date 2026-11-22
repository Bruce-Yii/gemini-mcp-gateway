# B10 P1 · GitHub 幂等原语 + 自动分页 + 仓库级搜索 helper（2026-11-23）

> 本批是 `batch-10-pr-workflow.md` 中 P1-6/7/8（原语、repo grep、分页）的**host 侧纯模块**实现。
> 只新增 `src/github-helpers.js`、`tests/github-helpers.test.js`、本文档；不接 codemode，不改上游适配/结果归一化/写文件模块。

## 一、实现内容

`src/github-helpers.js`（ESM，零新增依赖，不 import codemode/upstreams，纯注入回调）：

| 导出 | 语义 | 返回 |
|---|---|---|
| `ensureBranch({listBranches,createBranch,deleteBranch?,name,fromSha,ifExists})` | 已存在 + `reuse`（默认）→ 直接返回；已存在 + `reset` → 先删后建（**未提供 `deleteBranch` 抛显式 unsupported 错误**，不静默复用）；不存在 → 从 `fromSha` 创建 | `{created, reused, reset, branch}` |
| `upsertPr({listPrs,createPr,updatePr?,head,base,title,body,state})` | 查同 head/base 的**开放** PR（state 默认 `open`）；命中且有 `updatePr` → update；命中无 `updatePr` → 显式 `reused`；未命中 → create | `{created, updated, reused, pr}` |
| `fetchAllPages({fetchPage,maxPages=20,cursorKey='cursor'})` | 循环 `fetchPage({[cursorKey]:cursor})`，兼容 `{items,nextCursor}` / `{items,next}` / `{data,next}`（另兼容 `{pageInfo.endCursor}`、`{result}`/MCP text 包装）；按 JSON key 去重；空页停止；游标不前进时停止；**仅因达到 maxPages 退出才 `truncated:true`** | `{items, pages, nextCursor, truncated}` |
| `repoGrep({readFile,listFiles,pattern,flags='i',limit=50})` | 对 `listFiles()` 的文件逐个 `readFile()` 跑正则；支持字符串 pattern+flags 或 RegExp；返回 1-based `line/column` 及整行 `text`；**单文件读失败跳过并记入 `errors`，不中断全仓搜索**；达到 limit 置 `truncated` | `{matches, errors, scanned, truncated}` |

错误策略：除 `repoGrep` 的逐文件读失败（显式记录）外，**所有注入回调抛错原样向上抛，不吞、不转 success**。
入参校验：`ifExists` 非法值、缺 `createBranch`/`fetchPage` 等必填回调、缺 `name`/`head`/`base`/`pattern` 均抛 `TypeError`。

## 二、预期接入点（本次未接）

1. **Code Mode 沙箱暴露**（后续 P1 接入，需改 `src/codemode.js`，本次禁止）：把四个函数挂到 `codemode` 命名空间，
   注入的回调由网关侧 `callTool('github', ...)` 包装。注意沙箱内 `Intl` 不可用等既有约束不变。
2. **上游 GitHub 工具适配**（后续改 `src/upstreams.js`）：`listBranches/createBranch/deleteBranch/listPrs/createPr/updatePr`
   需按实际 GitHub MCP 工具名与返回形状接一层 adapter；本模块已兼容 array / `{items|data|result}` / MCP text content，
   但若上游返回 `{branches:[...]}` 之外的自定义键，adapter 需先摊平。
3. **结果归一化**（后续改 `src/result-normalize.js`）：本模块返回的是 **`branch`/`pr` 原始对象**（不套 `fileResult/prResult`），
   需要 canonical 视图时在调用方组合，不要在纯模块里耦合。
4. **Repo grep 的文件清单**：`listFiles()` 由调用方提供（GitHub MCP 的 tree/list 工具或本地索引），
   本模块不假设 GitHub API 具体实现；大仓库建议调用方先做路径过滤再传入，避免全量 readFile。
5. **write 路径组合**：`ensureBranch` →（未来 P0 patch write）→ `upsertPr` 组成端到端写流程；
   当前 patch/dry-run 仍是 B10 P0 未完成项。

## 三、测试

`tests/github-helpers.test.js` 共 **17 个 `node:test` 用例**，全部 fake 注入，**无网络、无新依赖**：

- `ensureBranch`：reuse 不写、missing 创建、reset 删除重建、reset 无 deleteBranch 报错、list/create 错误传播 + 参数校验（6）。
- `upsertPr`：create、update、reuse、list/create 错误传播（4）。
- `fetchAllPages`：cursor/next/data 多形状 + 去重、空页停止、maxPages 截断、游标停滞与错误传播（4）。
- `repoGrep`：命中定位（file/line/column/text）、读失败跳过记 errors、limit+flags、对象内容形状与入参校验（4）。

验证：单文件 `node --test tests/github-helpers.test.js` → 17/17 通过；全量 `npm test` 结果见最终报告。

## 四、未完成项 / 风险

1. **未接生产链路**：本批只交付 host 纯模块与测试；codemode/upstreams/result-normalize/file-write 均未改动，
   线上 `search/execute` 工具行为不变，不能据此认为 P1 已端到端可用。
2. **分页 `maxPages` 语义**：达到上限即报 `truncated:true`，即便最后一页恰好是末页；调用方需提高 `maxPages` 复核。
   游标停滞检测需要多一次同游标调用（pages 会 +1），已在测试中固定该行为。
3. **`repoGrep` 性能与内存**：逐文件串行读取并保留整行文本；超大文件/超多文件场景需要调用方做路径过滤与分页，
   本模块只限制返回条数（`limit`），不限制读取量。
4. **`upsertPr` 匹配口径**：按 head/base 字符串精确相等匹配开放 PR；若上游 head 用 `owner:ref` 形式、
   或存在多个同 head/base 的开放 PR，当前取第一个。需要更严格匹配（含 owner、更新旧 PR）由 adapter/调用方处理。
5. **`ensureBranch` reset 的破坏性**：删除分支不可逆；调用方应先确认分支无未合并提交。本模块不执行任何安全检查，
   只提供 `deleteBranch` 注入点与显式 unsupported 保护。
6. **正则 ReDoS**：`repoGrep` 接受任意 pattern；内置 limit 限制输出条数，但不限制单行的正则回溯耗时，
   生产接入时应对模式来源做约束。
