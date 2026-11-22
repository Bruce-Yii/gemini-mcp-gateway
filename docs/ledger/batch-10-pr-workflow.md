# B10 · Gemini PR #14–#41 工程总控反馈映射（2026-11-23）

> 来源：Gemini 连续完成 PR #14–#41 的读大文件、多分支并发、多文件提交、解冲突合主干、批量清 Issue。
> 本批只做“反馈 → 现有实现 → 缺口”映射，不重复 B5/B8 的修复记录。

## 一、已经修复或已缓解

| 反馈 | 对应实现 | 状态 |
|---|---|---|
| 同一文件文本重复 2–3 份、提前触发截断 | B5 `tool-format.js` 去重 text/resources/content，删除 content 别名 | ✅ |
| 截断隐式、缺元信息 | true cap + `limit/original` 标记；`sliceLines` 返回 `truncated/totalLines` | ✅ 部分（非所有结果统一字段） |
| 文件/PR 返回结构不统一 | `codemode.fileResult` / `prResult` helper（兼容 text/resources/result、number/id/url/head.sha） | ✅ helper 可用，非强制 |
| 大文件只能整文件拉取 | `codemode.sliceLines(text,start,end)`；`grepSnippet` | ✅ helper 可用 |
| 改大文件只能整文件覆盖 | `codemode.replaceLines` / `applyPatch`（strict context，失败不部分写入） | ✅ helper 可用，未接上游写工具 |
| 推送前无 diff | `codemode.diffSummary` | ✅ helper，非自动 dry-run |
| 报错行号偏移 | acorn 语句级 `__dshLine` 标记，线上已验证 `script line 2:1` | ✅ |
| 重复文本/上下文保护 | 已有 Code Mode 只回传函数返回值 + 全量 capture 不进入上下文 | ✅ |

## 二、仍未解决（按 P0/P1/P2）

### P0

1. **强制 canonical 结果**：`normalizeFileResult/prResult/issueResult` 已实现（B10-canonical），但**未接调用路径**；下一步是接入 Code Mode/网关。
2. **行区间读取/站内搜索参数化**：GitHub MCP 工具本身没有 `start_line/end_line/search_pattern`；helper 仍需先拉全文。若要“永不截断 + 不拉全文”，需要网关 side adapter 或专用上游 API。
3. **补丁级写入端到端**：`applyTextPatch/applyFilePatch` host 模块已实现（B10-patch-write），**未接上游/codemode**；下一步接入写入路径。
4. **dry-run 写前预览**：`applyFilePatch` 已支持 dryRun（host 模块），未接写工具/codemode。

### P1

5. 原生 `update_branch/rebase`、单文件三方合并：未做。
6. `ensure_branch` / `upsert_pr` / `fetchAllPages` / `repoGrep`：host helper 已实现（B10-idempotent），未接 codemode。
7. 跨文件 Repo Grep / AST 符号查找：只有 `grepSnippet`（对已有文本），没有仓库级搜索封装。
8. 分页自动迭代 `fetchAllPages`：未做。

### P2

9. 写前轻量语法预检：未做。
10. 响应附带 `meta: {duration_ms, upstream_calls, rate_limit_remaining}`：capture 有记录，但未回传给模型。
11. 写操作标准变更清单（branch/commit/PR/Issue 状态）：capture 全量有，未作为结构化结果返回。

## 三、下一步建议

1. **P0-1 canonical adapter**：先做 GitHub 文件/PR/Issue 三类，保留 `raw` 字段；不改现有原始调用。
2. **P0-3 patch write helper**：`codemode.applyFilePatch(...)` 组合 read→apply→update，返回 `{ok, diff, commitSha}`；失败不写。
3. **P0-4 dry-run**：写前默认返回 diff 摘要（或 `dryRun:true`）。
4. **P1 幂等/分页**：`ensureBranch`、`upsertPr`、`fetchAllPages`。
5. 以上均先用真实 capture 回放 + L1 smoke 验证；免费模型只能提示方向。

## 四、结论

Gemini 的“脚本化批量编排 + 沙箱裁剪”方向已被验证；剩余最大摩擦确实集中在
**返回形状、大文件行级读写、写前 patch/diff**。B5/B8 已经把底层 helper 补齐，
下一步不是再改沙箱，而是把 helper 组合成**端到端写路径**并做 canonical 输出。
