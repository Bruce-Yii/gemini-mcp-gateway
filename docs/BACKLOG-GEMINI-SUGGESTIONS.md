# Gemini 后续建议（记账，未实施）

> 来源：Gemini 在 UI 验收后给的两条建议。记录了但本轮没做——先记清楚，避免丢失。

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
- 配套：`codemode.attachImage(data, mimeType)` 显式方法

**关联**：`unwrapResult` 现在已经把 image 块放进 `images[]`（P0-1 修复），但最后 execute 的 MCP 响应没把它作为原生 image block 返回——差的就是"回传侧拼装"这一步。

## 建议 2：沙箱内入参轻量校验（跨工具类型安全）

**问题**：`search("select:<name>")` 返回 JSON Schema，但沙箱里 `codemode.<tool>(args)` 调用时没有入参校验——必填字段填错/漏填只能等上游 400，造成无效重试。

**建议**：在沙箱内对 `codemode.<tool>(args)` 的入参做轻量必填字段校验，缺必填字段时给精准报错（哪个字段、什么类型），在调用上游前就拦下来。

**关联**：探索测试里大量 retry 是参数填错导致的——这个能直接减少无效重试。注意不要和上游的完整 validation 重复，只做"必填 + 基础类型"的轻量前置检查。

## 状态

两条都**未实施**。优先级：建议 1（图片透传）在需要视觉能力时是刚需；建议 2（入参校验）能减少 retry，ROI 高。
