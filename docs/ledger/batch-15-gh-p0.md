# Batch 15 · GitHub 在线实测 P0（2026-11-23）

范围：只改 `src/codemode.js`、`src/result-normalize.js`，新增 `tests/gh-file-p0.test.js` 与本文件。
未改 `src/capture.js`、`src/server.js`、`src/upstreams.js`、`src/tool-format.js`、`scripts/`、其他 tests、README、workflows；未 commit / push / deploy。

## 证据（用户在线反馈）

- `github__get_file_contents` 返回 `{text:"successfully downloaded text file (SHA: <hex>)\n<body>", resources:[{text:body}]}`；guest helper `fileResult(r).content` 仍把提示行当正文第 1 行，被写进 `docs/17-decision-ledger.md` 与 5 个 `.ts/.tsx`，导致 tsc 报错。用户已用 PR #57 清理。这是 P0。
- host `normalizeFileResult` 已修过同类问题，但 guest `__dshFileResult` 仍优先 `text`，且 `__dshUnwrap` 对 `{text,resources}` 只返回 `text` 字符串，resources 在 helper 入口就丢了。
- `get_file_contents` 实际参数是 `ref`；传 `branch` 被上游静默忽略并回退 main，差点造成误判。
- `pull_request_read` 聚合了 `method: "get" | "get_files" | "get_check_runs"`，但工具描述/guidance 没写，模型每次多试探一轮。

## 修复

### P0-1 · guest `fileResult`：正文 100% 纯净

- 在 `src/codemode.js` 的 GUEST_PRELUDE 里新增窄匹配的 `__dshFileNotice = /^successfully downloaded text file \(SHA: ([0-9a-f]+)\)\r?\n/i` 与 `__dshStripFileNotice`。只匹配行首提示，不误杀正文里恰好提到 downloaded 的内容。
- `__dshResourceText` 在 unwrap **之前**从原始 `value` 收集 `resources[].text`（含嵌套 `resource.text`），修掉 `__dshUnwrap` 把 resources 丢掉的根因。
- `__dshFileResult`：当 `text` 是下载提示，或 `text` 与 `resources` 同时存在时，优先用 `resources[].text`；无 resources 时也剥离开头提示（支持 LF 与 CRLF）；从提示提取 `sha`。返回字段集合保持 `{content,size,sha,path,encoding,truncated}` 六项不变。
- 宿主侧 `codemode.fileResult` 的 try/catch 兜底形状不变。

### P0-2 · host `normalizeFileResult` 同步复核

- `src/result-normalize.js` 复用同一条窄提示正则：字符串分支与对象 `text/content/data` 分支都先剥离提示再取正文；`sha` 从提示中提取（显式 `sha` 字段仍优先）。
- 嵌套 `result` 里的提示同样处理；`raw` 仍保留原始引用；`truncated` 语义不变（提示本身不代表截断）。
- 旧行为保留：`successfully downloaded text file (SHA: abc, 81 chars)` 这类不带换行的单行提示仍是"唯一正文"，不会被误删；content 数组里的长正文仍按"排除提示后取最长"处理。

### P0-3 · `branch` → `ref` 参数别名

- 新增纯函数 `aliasGetFileContentsArgs(toolName, args)`，只在 `github__get_file_contents` / `get_file_contents` / `github__get_file_contents` 类命名上生效；只有 `ref` 缺失/为空且 `branch` 是非空字符串时，才复制参数并补 `ref: branch`。显式 `ref` 永不覆盖；不删除 `branch`，不改写未知参数，不改上游结果。
- 在 `runInSandbox` 的 host tool 桥 `registry.tool` 中、校验之后、去重/审计/上游调用之前应用，保证去重键与审计记录的是真正发出去的参数。审计条目仅在发生别名时多一个 `argAlias:{ref:'branch'}` 字段，结果 payload 完全不变。
- `codemode.readFileRange` / `applyFilePatch` 等内部读取走同一个桥，因此 `branch` 同样生效。

### P0-4 · guidance / search detail

- 新增 `GH_HIGHFREQ_GUIDANCE` 追加到 `execute_read` / `execute` 描述：明确 `pull_request_read` 的 `method` 三枚举，以及 `get_file_contents` 用 `ref`（`branch` 自动兼容）。
- `withCallName` 对这两个工具在 search 列表与 `select:<name>` detail 都补 `usage` 字段，detail 描述也追加 `Usage:` 行；不新增/不修改任何工具 schema，对外仍恰好 3 个 MCP 工具。

## 测试

`tests/gh-file-p0.test.js`（16 条，全部使用 fake upstream）：

- 真实 raw shape → guest content 纯 body、sha 提取、字段集合固定；
- 无 resources 时剥离提示；CRLF 提示；普通 text+resources 不回归；truncation / JSON-text 语义不回归；
- host `normalizeFileResult` 同形状一致；guest / host / `readFileRange` 三方一致；
- 提示唯一正文 / 超长行 / 截断标记等旧语义不回归；
- `branch`→`ref` 纯函数、显式 `ref` 不被覆盖、非目标工具不别名；sandbox 调用与 `readFileRange` 路径确实发出 `ref`、别名进审计、结果不变；
- search detail 与 execute 描述包含 method 枚举与 ref 说明；仍是 3 个工具。

## 验证

- `node --test tests/gh-file-p0.test.js`：16/16 通过。
- 相关既有测试（result-normalize / normalization / codemode-file-pr-helpers / no-silent-truncation / gh-feedback-fixes / audit-leak / codemode-rest）：112/112 通过。
