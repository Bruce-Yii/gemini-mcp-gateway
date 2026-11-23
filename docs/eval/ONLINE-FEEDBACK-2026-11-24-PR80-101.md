# Online feedback — PR #80–#101（2026-11-24 记录）

> 来源：用户在另一个窗口提供的真实使用反馈（非本仓库自动采集）。
> 项目：`github:Bruce-Yii/recruitment-agent`
> 时间线：PR #80 → PR #101，跨 20+ PR、并行分支、跨文件读写、CI 排查。
> 记录原则：用户反馈是**待验证线索**，不是事实；被动 scorecard 是**有限样本**，不是全量分母。

---

## 1. 被动侧证据（现有 scorecard）

来源：`docs/eval/scorecard-2026-11-23.md`

| 指标 | 值 |
|---|---:|
| 总请求 | 20 |
| MCP 请求 | 20 |
| 项目匹配 | `github:Bruce-Yii/recruitment-agent` 10 |
| 工具调用 | 10（execute 5 / execute_read 5） |
| 错误 | 3 |
| p95 | 5153 ms |
| 模型截断嫌疑 | 9（45%） |
| clientPlatform | 全部 unknown |
| 项目时间窗 | 2026-11-23T00:43:27Z – 03:24:31Z |

### 能证明什么

- 这段时间确实有真实 MCP 使用；
- 工具调用集中在 `execute` / `execute_read`；
- **9/10 次调用被标为 model truncation suspect**，与反馈里的“上下文/截断/整文件读写”痛点方向一致；
- 出现 2 个 upstream_4xx + 1 个 auth 错误，与“偶发失败/重试”方向一致；
- p95 5.1s，说明有慢调用。

### 不能证明什么

- **不能证明“上百次跨文件读取”**：scorecard 只有 20 请求、10 工具调用；Code Mode 内部的多次上游调用未完整计数；
- **不能证明截断是网关造成**：`model truncation suspect` 是 advisory，无法区分模型脚本自己 `slice` 与网关投影；
- **不能精确关联反馈**：反馈没有 requestId/build，clientPlatform 全 unknown；
- **20 很可能是 R2 list 上限**：`capture-digest.mjs` 的 `listR2Keys()` 只请求一页，没有 cursor；当前 scorecard 的分母不可靠。

> 结论：被动数据**支持方向**，不支持**定量结论**；先修采集分母，再谈“主动/被动一致率”。

---

## 2. 反馈 → 当前代码状态

| 反馈 | 当前状态 | 判断 |
|---|---|---|
| 文件正文混入 `successfully downloaded text file (SHA: ...)` | 代码已有 `content` 独立/notice 分离与回归测试 | 可能是旧构建；需用当前构建复验 |
| 建 PR `number` 偶发内部 ID | `prResult` URL-first 已实现 | 旧构建可能已修；需复验 |
| 建 Issue `number` 空/索引延迟/重复 #90 | `normalizeIssueResult` 有 number 归一，但创建后没有幂等/回查等待 | **真实缺口** |
| 批处理多包一层 `{ok,value}` | 已有 `unwrapBatch` 约定 | 旧构建/使用方式问题；需文档化 |
| 多文件改写无 TS/正则转义预检 | 当前预检只查 JSON/括号，无 TS/TSX AST | **真实缺口** |
| 缺补丁式局部修改，只能整文件 replace | 已有 `applyFilePatch` / `replaceLines`，但模型未稳定使用 | 能力存在，**可发现性/契约不足** |
| 大返回整块截断，切掉关键字段 | 有 `withTruncationMetadata`，但反馈要“每顶层键字节/行数清单” | 部分缺口 |
| 等 CI 只能反复轮询 | `waitForPrChecks` 已实现 | 旧构建或未暴露；需验证/文档化 |
| 不能 rerun failed jobs | 未实现 | **真实缺口** |
| 重命名要两次 commit | `push_files` 是否支持 delete/rename 未确认 | 需核验；大概率缺口 |
| 合并后不自动删源分支 | `deleteBranch` helper 存在，但合并没有默认清理 | 能力存在，流程缺口 |

---

## 3. 反馈里最值得信的三点

1. **原子多文件推送是正向升级**：与代码里 `push_files`/原子写路径一致；
2. **端内脚本批处理大幅省上下文**：与 Code Mode 的设计目标一致；
3. **CI 日志直读闭环有效**：与 `getJobLogs`/CI 排查能力一致。

这三点说明核心方向成立，不是“工具调用堆砌”。

---

## 4. 被动侧暴露的真正问题

不是“网关没能力”，是**证据链和分母不可靠**：

- R2 list 只取一页 → scorecard 20 条可能不是当天全部；
- capture 只记外层 `execute`，Code Mode 内部多次上游调用没有逐次入 capture；
- `clientPlatform` 全 unknown；
- 没有 `taskId`，PR 任务与 capture 无法关联；
- 反馈没有 requestId/build，无法做“旧构建 vs 新构建”同任务对照。

所以这份反馈不能直接拿“9/45%”当结论；它应该触发：

```text
修 R2 分页/分母
  → 补 taskId/clientMode
  → 把本次反馈登记为 active-eval
  → 用当前构建复验
  → 形成 N/J 半在线任务
```

---

## 5. 建议的后续工作包

### P0

| WP | 内容 |
|---|---|
| OF-1 | 建 Issue 返回标准 `{number,id,url,state}`；创建后短轮询/回查；请求幂等键防重复 |
| OF-2 | 文件正文/notice 分离用当前生产构建复验；补 requestId/build 证据 |
| OF-3 | R2 list 分页 + capture 分母校验；修 scorecard 20 条上限 |

### P1

| WP | 内容 |
|---|---|
| OF-4 | 写前 TS/TSX 语法预检（Node strip-types / parser），错误在推送前返回 |
| OF-5 | `rerunFailedJobs` + `waitForChecks` 统一 CI 辅助 |
| OF-6 | 补丁式编辑一等契约：`{path, edits:[{oldText,newText}]}`，唯一命中校验，原子提交 |
| OF-7 | 结构化截断：每顶层键 bytes/lines/tail/next |
| OF-8 | `push_files` 支持 delete/rename 原子提交 |

### P2

| WP | 内容 |
|---|---|
| OF-9 | 合并后 `deleteBranch` 选项 |
| OF-10 | 批处理返回形状统一文档/类型 |

---

## 6. 结论

> 反馈的方向和被动 scorecard 对得上：真实使用、真实慢调用、真实截断嫌疑、真实错误。
> 但 passive 分母不可靠，不能把 9/45% 当结论；先把采集分页、taskId、构建身份补齐，再做旧/新构建对照。

**这份记录不自动创建 issue/PR，不自动改代码；按 AGENTS §1，免费模型/反馈只是待验证假设。**
