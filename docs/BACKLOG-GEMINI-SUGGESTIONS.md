# Gemini 后续建议（两条均已实施；保留原始记录备查）

> 来源：Gemini 在 UI 验收后给的两条建议。原文写于实施前，标"未实施"；两条在 commit `03c294b` 已落地，其后主线继续推进（真隔离 `633cb6f` 等）。
> 本文件保留原始问题描述与实现位置，供后来者核对。状态以文末表格为准。

## 建议 1：图片透传通道（MCP image content block 旁路）

**问题**：上游 MCP 返回 `{type:"image", data, mimeType}` 时，CodeMode 把 execute 返回值统一序列化成单个 `type:"text"` 块。图片 Base64 混进 JSON 文本后：
- 模型看不见（视觉编码器不解析文本里的 Base64）
- 一张 1440 截图 100-500KB，要么撑爆上下文，要么被截断成 `<string len=...>`

**触发场景**：
1. 仓库 UI 截图复核（Gemini 已遇到，只能读 README/CSS 文本推断）
2. Linear `extract_images` 提取 issue 截图（网关已挂载，现在形同虚设）
3. 后续接 Figma/Playwright MCP 做视觉自检
4. Notion 内嵌图、GitHub issue 报错截图

**建议的轻量补法**（零体感损耗，不改 search/execute 用法）：
- 沙箱侧：上游返回 image 块时暂存到 `images[]`，在 JS 返回对象里用轻占位符 `{__imageRef:0, mimeType:"image/png"}` 替代大 Base64
- 网关回传侧：构建最终 MCP `content` 数组——第 1 项是 return 值的 `type:"text"`，后面跟 `images[]` 里收集的原生 `{type:"image", data, mimeType}` 块
- 配套：`codemode.attachImage(data, mimeType)` 显式方法（**未单独实现**：最终采用自动 detach，不需要模型显式调用）

**关联**：`unwrapResult` 把 image 块放进 `images[]`（P0-1 修复）；"回传侧拼装"这一步已由 `src/server.js` 的 `collectImages` / `textResult` 完成（见下方状态表）。

## 建议 2：沙箱内入参轻量校验（跨工具类型安全）

**问题**：`search("select:<name>")` 返回 JSON Schema，但沙箱里 `codemode.<tool>(args)` 调用时没有入参校验——必填字段填错/漏填只能等上游 400，造成无效重试。

**建议**：在沙箱内对 `codemode.<tool>(args)` 的入参做轻量必填字段校验，缺必填字段时给精准报错（哪个字段、什么类型），在调用上游前就拦下来。

**关联**：探索测试里大量 retry 是参数填错导致的——这个能直接减少无效重试。注意不要和上游的完整 validation 重复，只做"必填 + 基础类型"的轻量前置检查。

## 状态：两条均已实施

旧文案"两条都**未实施**"已过期。依据当前源码与 commit `03c294b`（及后续 B0/B2 修复），两条都已落地并配了真测试：

| 建议 | 状态 | commit / 代码位置 | 测试 |
|---|---|---|---|
| 建议 1 图片透传通道 | ✅ 已实施 | `03c294b`（`feat: image passthrough + lightweight arg validation + free-model guard + v2 triage corrections`）；`src/server.js:83-126` `collectImages` / `textResult`（detach 成原生 `{type:'image'}` block，文本里只留 `{__imageRef, mimeType}`）、`src/tool-format.js:192-235`（images detach/reattach） | `tests/image-passthrough.test.js`（InMemoryTransport 端到端断言原生 image block） |
| 建议 2 沙箱内入参轻量校验 | ✅ 已实施 | 同一 commit `03c294b`；`src/codemode.js:173-235` `validateToolArgs`（必填字段 + 顶层基础类型，跨 realm 安全的类型名），`src/codemode.js:271` 在上游调用前执行 | `tests/arg-validation.test.js` |

> 注明范围（2026-11-21 更新）：这里说的"均已实施"**仅指这两条建议**。旧文案"`work/full-audit.md` 对账还有 17 条明确未修项（含沙箱逃逸、探测器误标）"已过期，勿再引用。
> 按 B2 根因追溯（`docs/ledger/batch-2-rootcause.md`）当前状态：沙箱逃逸（SBX-1）随 `633cb6f` 换 Vercel run SDK QuickJS 已修（线上探活 `Function constructor is not allowed`，回归测试 `tests/true-isolation.test.js`）；探测器误标已在 B0-14 修复；两条真 bug 也已补修——归一化时序（`validateToolArgs` 先跑 `normalizeToolArguments`，`tests/normalization-order.test.js` 4/4）与 `structuredContent` 吞块（`tool-format.js` 仅当无其它内容块时才提前返回，`tests/structured-content-blocks.test.js`）。
> 仍有少量 L1/L2 残留（search 排序 v2 命中率 75.4%、`select:` 接口设计、execute_read annotations L3、30 次上限整轮作废、沙箱内 `search_empty` 兜底、Notion 操作层双根因、GitHub 凭据流程、lock+CAS 双花窗口）——已逐条决定"补修 or 接受（登记 DEC）"，见 ledger 的"L1/L2 残留处置决定"，不再笼统写"17 条未修"。lead 认知 L3（RC-F）已制度化进 `docs/ledger/README.md` 的证据规则。
