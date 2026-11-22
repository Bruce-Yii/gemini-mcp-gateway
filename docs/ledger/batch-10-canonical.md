# B10 P0-1 · GitHub 高频返回值 canonical 归一化（adapter）

> 日期：2026-11-23。对应 `docs/ledger/batch-10-pr-workflow.md` 的 P0-1。
> 本批只新增独立 adapter 与测试；未改 `src/codemode.js` / `src/upstreams.js` /
> `src/tool-format.js` / README / CHANGELOG，未 commit / push / deploy。

## 一、做了什么

新增 `src/result-normalize.js`，导出四个纯函数：

| 函数 | 输出字段（恒定） |
|---|---|
| `normalizeFileResult(value)` | `{content, sha, size, encoding, path, truncated, raw}` |
| `normalizePrResult(value)` | `{number, title, url, state, headSha, baseRef, mergeable, sha, id, raw}` |
| `normalizeIssueResult(value)` | `{number, id, url, state, title, raw}` |
| `normalizeResult(toolName, value)` | 按工具名分发到上面三者；未命中 → `{raw: value}` |

实现约束：

- **纯函数**：无网络、无状态、无新依赖；不修改入参（返回新对象；`raw` 保留传入引用）。
- **不抛错**：属性读取全部走安全访问；对 getter 抛异常的 Proxy 也能返回稳定形状。
- **字段稳定**：无法识别的字段一律 `null`（`truncated` 恒为 boolean）；`content` 恒为 string 或 null。
- **重复资源去重**：`resources[].text` 按首次出现去重再合并，避免 B5 已修过的“同一文本重复进入上下文”问题在 adapter 层复发。
- **截断显式化**：识别 `--- TRUNCATED ---` 标记与上游已有 `truncated` 字段。
- **兜底编号**：PR / Issue 的 `number` 在没有数字字段时，会从 `html_url`/`url` 的 `/pull/N`、`/issues/N` 中提取。

## 二、为什么是 adapter，而不是直接改上游返回（DEC）

1. **不改上游返回是既有契约**：B5 已经在 `tool-format.js` 做了文本去重和 true cap，B8 在
   `codemode.js` 里做了 `fileResult` / `prResult` 沙箱 helper。上游原始返回仍被 capture、
   审计、重试与调试链路消费；在传输层替换它会破坏这些不变量，也会让“raw 回退”无从谈起。
2. **漂移是消费侧问题**：GitHub MCP 在不同工具/版本间对同一文件给出字符串、`{text,resources}`、
   `{content,sha,...}`、`{result:{...}}` 等不同形状；这不是网关能“修正”的上游 bug，而是
   消费者需要一个稳定视图。适配放在消费边界，代价最小、可逆性最好。
3. **不抢沙箱 helper 的活**：`codemode.fileResult/prResult` 继续保留，adapters 不与之冲突；
   lead 可在网关层选择何时调用，沙箱内仍可继续用原 helper。
4. **风险隔离**：adapter 是可选调用；未接入时现有行为零变化。若某工具形状判断有误，
   `raw` 始终可用，模型/调用方可以回退到原始值，不会出现“归一化把信息弄丢”的死路。

收益：模型侧读文件/PR/Issue 时字段集合恒定，不必每次猜形状；截断与元信息显式化。
风险：见第五节。

## 三、后续如何接入（lead 集成）

adapter **当前未接入任何调用路径**，需由 lead 决定接入点。两种推荐方式：

1. **网关层统一视图（推荐）**：在结果离开网关前，根据工具名调用
   `normalizeResult(toolName, value)`，把 canonical 视图放进返回载荷，同时把原值留在 `raw`。
   对未命中工具返回 `{raw:value}`，天然兼容非 GitHub 上游。
2. **Code Mode 显式调用**：在 `execute` 的脚本里由模型调用 adapter（与现有
   `codemode.fileResult` 并列）。适合先小范围验证，再推广到网关层。

接入前必须确认：
- 工具名清单（白名单里 GitHub 读文件/PR/Issue 的真实工具名）与 `normalizeResult`
  的 `FILE_TOOL_NAMES` / `PR_TOOL_NAMES` / `ISSUE_TOOL_NAMES` 对齐；
- 是否把 canonical 视图作为**新增字段**而非替换字段，保证旧消费者不被破坏；
- 用真实 capture 回放 + L1 smoke（`npm run smoke:l1`）验证，不能只靠单元测试。

## 四、测试与证据

`tests/result-normalize.test.js` 共 **28 个测试**，覆盖：

- file：纯字符串、`{text,resources}`、仅 resources、重复 resources 去重、
  `{content,sha,size,encoding,path}`、`{result:{...}}`、result 内 resources、
  content 数组、content 对象、JSON 文本、MCP content 数组、两种截断标记、
  空/null/无法识别、不修改入参、抛 getter 的 Proxy。
- PR：number/id/url/html_url/sha/title/state、`result` envelope、`head.sha` /
  `head.ref` / `base.ref` / `mergeable` / `mergeable_state`、id 兜底 number、
  URL 兜底编号、空/null/Proxy。
- Issue：number/id/url/state/title、`result` envelope、PR-as-issue、id 兜底、URL 兜底、
  空/null/Proxy。
- dispatch：三类工具名（含 `server__tool` / `server.tool` / 大小写）分发；
  未知工具 `{raw:value}` fallback；恶意 toolName 不抛错。

运行：`node --test tests/result-normalize.test.js` → 28/28 通过；`npm test` 全量见交付报告。

## 五、真实 capture 回归修复（R2 回放）

来源：`capture/2026-11-22/10c13554-...json.gz` 的 `get_file_contents` 原始 result：

```json
{"content":[
  {"type":"text","text":"successfully downloaded text file (SHA: ...)"},
  {"type":"resource","resource":{"uri":"repo://...","mimeType":"text/plain; charset=utf-8","text":"# gemini-mcp-gateway\n\n..."}}
]}
```

**现象**：初版 adapter 在 `unwrap` 阶段把数组展平成第一个 `text`（下载提示，81 字符），
丢失了 `resource.text` 里的真正正文（约 13KB），canonical `content` 错误。

**修正**：
- `unwrap` 遇到含嵌套 `resource` 块的 content 数组时不再展平，保留数组交给正文选择逻辑。
- 新增 `extractBodyText`（同时读取顶层 `text/content/data` 与 `resource.text/content/data`）、
  `isDownloadNotice`（窄匹配 `successfully downloaded/fetched/retrieved ... (SHA: ...)`）、
  `contentArrayToString`：排除下载提示后在候选中选**最长**的正文。
- 无下载提示、无嵌套 resource 时保持原有逐项合并行为（向后兼容）。
- 极端情况只有下载提示、没有正文时仍返回提示，不返回 `null`；`raw` 始终保留。

**测试**：新增 3 个用例（真实形状、多候选取最长、仅提示兜底），断言 `content.length > 1000`
且包含 `# gemini-mcp-gateway`。`node --test tests/result-normalize.test.js` → 31/31 通过。

## 六、边界与未解决风险（不承诺所有 GitHub 工具）

- **只覆盖三类高频形状**：读文件、PR、Issue。仓库搜索、commit、branch、review、check、
  release、用户等工具不在范围内，统一走 `{raw:value}` fallback。
- **工具名白名单是显式清单**：新工具名（例如 `get_file_contents_v2`）不会自动命中，
  需要 lead 在接入时补齐；误命中也可能把非 GitHub 工具当 GitHub 处理。
- **启发式有假设**：`mergeable_state` 字符串到 boolean 的映射（`'mergeable' → true`，
  其他 → `false`）是简化；复杂状态（如 `'behind'`）语义有损，`raw` 保留原值。
- **size 语义**：优先用上游 `size`；无 size 时用字符串长度推算；无法识别时为 `null`。
  二进制/base64 内容的长度不等于字节数，调用方应以 `raw` 为准。
- **JSON 文本解析只做一层**：刻意不递归解析嵌套 JSON 字符串，避免把普通文本误判为结果。
  极端嵌套 envelope 可能取不到内容，`raw` 仍可用。
- **未做端到端**：未接入调用路径，未做真实 GitHub capture 回放，未做部署。
- **免费模型建议仅为方向**：本批实现只依据现有源码与确定性测试；未根据模型建议直接改代码或部署。
