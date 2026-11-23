# Batch 17 · PR80-101 写入 / 预检 / 截断反馈修复

范围（本次代理只写这些文件）：

- `src/execution/file-write.js`（真实实现；`src/file-write.js` 是纯 re-export shim，未改）
- `src/execution/tool-format.js`（真实实现；`src/tool-format.js` 是纯 re-export shim，未改）
- `tests/feedback-write.test.js`（新增，17 条确定性回归测试）
- `docs/ledger/batch-17-feedback-write.md`（本文件）

未改：`src/execution/codemode.js`（由另一个代理负责接线）、其他源码 / 测试 / 配置 /  workflows；未 commit / push / deploy。

## 反馈 1 · 多文件改写缺少真实语法预检，CI 3 分钟后才发现语法错

**旧行为**：`precheckText` 对 `.json` 用 `JSON.parse`，对 `.js/.mjs/.ts/.tsx/...` 只做括号 / 引号平衡扫描；`const x = ;`、`const x: number = ;` 这类真语法错能穿到 CI 才失败。

**新行为**：

- 返回值升级为结构化 `{ok, errors, language, checked, check, error?}`。`errors` 是错误数组，`language ∈ {json, javascript, typescript, jsx, tsx, other}`，`checked:true` 表示**真的跑了解析器**。
- `.js/.mjs/.cjs`：用依赖中已有的 `acorn`（`ecmaVersion:'latest'`，先 module 后 script fallback）做真实语法解析；解析失败 `ok:false`，写入前硬停。
- `.ts/.mts/.cts`：Node 22+ `module.stripTypeScriptTypes(..., {mode:'strip'})` 去类型后用 acorn 解析；类型标注可过，`const x: number = ;` 这类真语法错被拦下。
- `.jsx/.tsx`：acorn 未装 JSX 插件、`stripTypeScriptTypes` 也不处理 JSX，因此**明确返回 `checked:false` + `reason`**（"JSX/TSX AST parsing is not available..."）。旧平衡扫描只用于挡住明显不平衡，**绝不假装语法检查通过**。
- TS `enum` / `namespace` / decorator 等 strip-only 模式不支持的语法：同样返回 `checked:false` + `reason`，不阻断写、不误报通过。
- **既有 fixture 兼容**：`tests/online-gap-regression.test.js` 的 `.ts` 路径里放的是 Markdown 正文（`# test-gateway` + 中文 prose），旧平衡预检会放行。新解析器若把这当 TS 解析会误报语法错，导致写入被拒。现识别 Markdown 前缀（`# `、`>`、三反引号、`~~；`#!/` shebang 不算）并如实标记 `checked:false` + "content looks like Markdown/prose" 原因，退回旧平衡扫描，既不为它撒谎"已检查"，也不误伤合法写入。该回归已补进 `tests/feedback-write.test.js`。
- 兼容：保留旧字段 `check`（`json` / `balance` / `none`）与 `error`，错误文案仍以 `bracket balance precheck failed:` / `JSON precheck failed:` 开头，既有 `applyFilePatch`、sandbox bridge、旧测试无需改动。
- 多文件 `applyFilePatches` 的预检循环不变：任一文件预检失败 → 全部文件零写入。

**不是完整编译器**：没有 tsc、没有类型检查、没有 emit；`checked:true` 只代表"语法解析通过"，不代表可编译。Node < 22 或 acorn 不可用时诚实降级为 `checked:false` + `reason`。

## 反馈 2 · 缺补丁式局部修改一等体验

**新增纯函数 `editText(source, edits)`**：

- `edits` 形如 `[{oldText, newText}]`；`newText:''` 表示删除；支持新增行、多 edit 顺序应用（后一个 edit 看到前一个的结果）。
- `oldText` 必须在**当前工作文本中唯一命中**；0 次命中、>1 次命中、空 `oldText`、非字符串 `newText` 一律 `ok:false`。
- 原子：任一 edit 失败返回原始文本，绝不返回半应用结果。
- 换行保留：先做精确匹配；若 `oldText` 用 LF 而文件是 CRLF（或反向），按文件 EOL 变体再匹配一次，替换不会重写无关行尾。不做整文件 `normalizeText`。

**新增 `applyTextEdits({read, write, getSha, path, edits, sha, dryRun=true, includeContent=false, precheck=true})`**：

- 复用 `applyFilePatch` 的安全契约：截断读拒绝、dryRun 默认、预检失败零写入、写失败如实上报、不伪造 commit sha。
- 自动 sha：`sha` 显式传入优先，否则 `getSha(path)` 自动填充；`write(path, text, {sha, path})` 拿到解析后的 sha。
- 返回 `diff`（含每个 edit 的 `at/oldBytes/newBytes`）、`sha`/`blobSha`/`commitSha` 身份分离，与既有 write 契约一致。
- `includeContent:true` 可把完整文本交给上层做一次 `commitFiles` 原子提交；**本代理不改 codemode 接线**。

## 反馈 3 · 大返回整块截断切掉关键字段

**结构化截断**：

- 对象被截断时，在原有 `--- TRUNCATED ---` marker 之外附 `truncation: {fields, tail, next}`：
  - `fields` 按原始**顶层键**逐项给 `{bytes, lines?}`（UTF-8 字节；多行字符串才有 `lines`），键超过 32 个时附 `__moreKeys` 计数。
  - `tail` 是原文结尾的最多 120 字符摘录；`next` 给出"只重取大字段 / 用 cursor+limit"的下一步提示。
  - 字段 >32 个或原文极大时优先截断 `tail`/`next`，再缩短 marker 的说明文字；marker key 本身与 `truncated:true` 永不删除。
- 纯文本字符串被截断时保持 `typeof out === 'string'`（向后兼容），在 marker 后缀内嵌 `truncation.fields={}`、`tail="…"`、`next="…"`；嵌套字符串同样带 `grepSnippet/text.slice` 定位提示。
- 预算：先为结构化块预留有上限的空间（最多 360 字符且不超过 `maxChars/3`），再 shrink；`attachTruncationMeta` 按"完整 → 缩 tail/next → 缩 marker 说明"顺序适配，输出始终 ≤ `maxChars`。
- 兼容：
  - `--- TRUNCATED ---` 全部既有断言保留；小值原样返回。
  - F-08 的"字符串 reason 必须保持字符串"约束保留：若上游已有字符串 `truncation` reason，结构化块放在 `truncationMeta`，`truncation` 仍是字符串。
  - 数组仍用原来的 `array length: N` marker；数组元素内的字符串因空间极小会退到紧凑 marker 后缀，不保证每个数组元素都带 fields（顶层对象 / 字符串保证）。

## 验证与限制

- `node --test tests/feedback-write.test.js`：18/18 通过（含 Markdown-in-.ts fixture 兼容回归）。
- 既有 write / truncation 相关测试（b10 / b11 / file-write / friendly-truncation / gateway-rest / residual-security-fix / logs-errors / online-gap-regression 等）全绿。
- 全量 `npm test`：**1506 tests / 1500 pass / 0 fail / 6 todo**（2026-11-24 本代理实跑）。
- 限制：
  - JSX/TSX 无 AST，明确 `checked:false`，不是"通过"。
  - TS `enum`/`namespace`/decorator 在 strip-only 模式不支持，明确 `checked:false`，不是"通过"。
  - Node 22+ 的 `stripTypeScriptTypes` 是实验 API，运行时会打印 `ExperimentalWarning`；非 Node 22+ 会降级为未检查，不会假装通过。
  - `editText` 只做字面唯一匹配，不做正则 / 语义 AST 匹配；`oldText` 必须以真实文本片段提供。
  - `applyTextEdits` 的多文件原子提交需要上层注入 `commitFiles` / `getSha`，本次不改 codemode 接线。
