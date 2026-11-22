# B5 · Gemini 真实任务反馈（2026-11-22）

> 来源：用户在 Gemini 网页端完成真实任务后的一手复盘（Vercel/GitHub 混查、282KB HTML 解析、
> 图片资产检查）。按 `docs/WORKFLOW.md` G5 四步法登记：表象 → L1 → L2 → L3；修复作用在
> 结果投影/沙箱 helper 层，不改变外层 3 工具 schema，不需要 Gemini 重连。

## ISSUE-1：GitHub 文件返回三份重复正文

- **表象**：读 4.8KB README / 14KB RELEASE-GATE 时，对象里同时有 `text`、`resources[].text`、
  `content` 三份几乎相同正文，体积放大 3 倍并触发截断。
- **L1**：`src/tool-format.js` `unwrapResult()` 在 text+resource 同时存在时，把 resource 正文
  又 push 进 `texts`，并返回 `content: resources.map(text).join()`，形成三份。
- **L2**：结果投影没有 canonical shape，默认"上游给什么就转发什么"。
- **L3**：网关只做了安全截断，没有定义"给模型的结果协议"。
- **FIX**：`textBlockBodies` 去重；`resources[].text` 仅在与 text 块不同（resource-only）时保留；
  删除恒为冗余的 `content` 别名。`src/tool-format.js` + `tests/tool-format-dedupe.test.js`。
- **状态**：✅（4 份测试；`content` 无既有消费者）。

## ISSUE-2：截断预算不透明

- **表象**：单字段/总返回在约 5K–12K 字符处被截断，提示未写具体上限，只能试探切片。
- **L1**：`src/server.js` `boundResult()` 默认 8000/文本块，suffix 只报"截掉多少"；另有
  `codemode.js` 20k execute 上限、`tool-format.js` 24k 文本截断，三层口径不同。
- **L2**：预算没有单一来源，提示不与实际 cap 对齐。
- **L3**：上下文纪律只做了"截"，没做"可预期"。
- **FIX**：`boundResult` 改为 true cap（head+suffix ≤ maxChars），suffix 明确
  `limit N chars, original M chars`，removed 按实际丢弃数计算；`tests/result-bound.test.js`。
  不改默认预算；三层预算的统一/文档化登记为后续。
- **状态**：✅（修复本层）；**待办**：把 8k/20k/24k 三层关系写进 `CONTEXT-AND-EVAL.md` 并决定是否统一。

## ISSUE-3：上游返回格式不统一，样板防御代码多

- **表象**：JSON 字符串、`{result}`、`.text`/`.content` 混用，每次编排先写 `parseMaybe/getText`。
- **L1**：沙箱只有 `safeAll`/`grepSnippet`，没有统一解包 helper。
- **L2**：网关保留上游差异，未提供"模型侧结果协议"。
- **L3**：协议设计缺位（与 ISSUE-1 同源）。
- **FIX**：`src/codemode.js` 增加 `codemode.unwrap(value)`（同步、不抛错；JSON 字符串、
  `{result}`、`{text,resources}`、content 数组；歧义/异常原样返回）；仅 +88 字符 guidance。
  `tests/codemode-unwrap.test.js`。
- **状态**：✅；风险：sandbox prelude 每轮多约 2 行 guest 代码（~180 tokens），歧义时保守返回原对象。

## ISSUE-4：二进制/图片资产链路不顺畅

- **表象**：GitHub 图片返回 `encoding`/`download_url` 空，也没有可用的 base64/图片块。
- **L1**：`unwrapResult` 对所有 `resource.blob` 一律按 UTF-8 解码（图片变乱码），且没有
  resource→image 的桥；`server.js` 的 image passthrough 只认 `{type:'image',data}`。
- **L2**：二进制没有独立投影；文本和图片共用一个解码路径。
- **L3**：结果协议只考虑了文本。
- **现状**：已实现（`src/tool-format.js` + `tests/resource-blob-image.test.js`）：mimeType 门控
  （image/audio）、图片转 `images[]` native block、1 MiB cap、超限只给 metadata、文本路径不变。
- **状态**：✅ 实现；风险：cap 为硬编码 1 MiB，超大图片被省略为 metadata（不与 server 原生
  image 路径混用）；严格 base64 形状检查会把带空白/URL-safe 的 blob 回退为文本。

## 验证与门控

- `npm test` → 350/350（含 dedupe/truncation/unwrap/binary 新测试）。
- 未做：真实 Gemini 重测（B5 的 G6 等价项）、token 前后对比、binary 修复的端到端真实调用。
- **不能宣称 B5 通过**；ISSUE-1/2/3/4 代码层已修，真实客户端回归未做。

## Gemini 线上回归（2026-11-23）

- 任务 2（GitHub 大文件）：README/WORKFLOW 均**无三份重复**（text 1 次 + resources 元数据，
  无 `content` 字段）；README 12,774 字符、WORKFLOW 14,073 字符，均未触发截断，因此
  `truncated` 标记仍未被实际验证。
- 任务 3（Intl）：`codemode.nowISO/formatDate` 正常返回，`typeof Intl` = `undefined`，无报错。
- 未覆盖：>24KB 文件的显式截断标记、图片二进制、直接调用 `unwrap` 的真实任务。

## DEC

| 决策 | 理由 |
|---|---|
| 删除 `content` 别名 | 无 src/测试消费者；保留即第三份重复 |
| 截断采用 true cap | 提示声称 limit 必须与实际一致 |
| unwrap 歧义时返回原对象 | 不静默丢数据；模型可自行防御 |
| binary 采用 mimeType 门控 + 1MiB cap | 保留原 base64 到 images[]，超限只给 metadata，避免上下文爆炸 |
