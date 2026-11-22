# B8 · Gemini 真实大文件/多文件工作流反馈（2026-11-23）

> 来源：用户在 Gemini 网页端连续十几个回合完成"读多文件 → 切分支 → 多文件提交 → 开 PR →
> 合主干 → 清 Issue"后的复盘。与 B5 部分重叠（重复/截断），但这次暴露的是**文件编辑与
> 结果协议**层面的结构问题，不是单点截断。

## ISSUE-B8-1：返回结构不统一，模型静默踩空

- **表象**：读仓库文件时正文有时在主字段、有时为空而正文藏在 `resources[]`；创建 PR
  有时返回编号、有时只有 `id`+`url`；编排要写多层 `parseMaybe/getText` 兜底。
- **L1**：上游工具 envelope/字段名不同；`codemode.unwrap()` 只处理"信封"，不统一字段。
- **L2**：结果协议是"原样转发 + 沙箱 helper"，没有按能力（读文件、创建 PR）的 canonical shape。
- **L3**：没有把"常用能力的结果契约"当作网关产品的一部分。
- **候选修复**：
  1. 网关层对高频工具做 canonical adapter（`{content,sha,size,truncated}`、
     `{number,url,sha}`），带 `raw` 回退；风险：上游 schema 变更/隐藏字段。
  2. 沙箱层 helper（`normalizeFile(res)`/`normalizePr(res)`），不改变原始调用；风险：模型需知道 helper。
  3. 两者结合：网关保证不丢数据，helper 提供扁平视图。
- **优先级**：高（影响每次编排的样板代码与空值错误）。

## ISSUE-B8-2：大文件隐式截断 + 重复冗余

- **表象**：20KB+ 文档读到几千字就截断；响应里同一段文本重复打包，进一步放大体积。
- **已有修复**：B5 已去重 `text/resources/content` 三份副本，并让 `boundResult` 明确
  `limit/original`；**重复问题基本解决**。
- **仍未解决**：
  - 截断发生在"上游结果进入沙箱之前"还是"返回给模型之前"没有区分；沙箱内本可持有
    更大文本，但被同一预算截断，导致无法整文件读取/编辑。
  - 没有行号区间读取；没有 `truncated: true` + 总行数/总长度的显式元数据。
- **L1**：所有上游结果共用一层文本 cap。
- **L2**：没有区分"沙箱内部可用"与"模型可见"的预算。
- **L3**：上下文纪律只做了"少给模型"，没做"沙箱内完整、出口可控"。
- **优先级**：高（大文件编辑的前置条件）。

## ISSUE-B8-3：改大文件只能整文件覆盖，没有 patch/行区间

- **表象**：30KB+ 组件文件只能"整文件拉取 → 字符串锚点替换 → 整文件覆盖"；锚点差一个
  换行/缩进就失败重来；没有行号或 unified diff 写入。
- **L1**：上游 GitHub 工具只有整文件读写；沙箱没有 patch/行编辑 helper。
- **L2**：没有"读取范围 + 应用 diff + 校验后整文件写回"的安全编辑流程。
- **L3**：没有把"大文件编辑"当成独立能力设计。
- **候选修复**：
  1. 沙箱 helper `codemode.applyPatch(text, patch)`（unified diff/行号编辑），先校验
     context 再写回；失败不产生部分写入。
  2. `readFileRange`/`sliceLines` helper（前提是 B8-2 放开沙箱内文本预算）。
  3. 写回前 `codemode.diffSummary(before, after)` 供模型/用户确认。
- **优先级**：中高（大文件成功率提升最大，但依赖 B8-2）。

## ISSUE-B8-4：错误行号偏移 + 缺 dry-run 预览

- **表象**：脚本报错行号包含网关 prelude 偏移，无法对应脚本行；多文件推送前没有变更摘要。
- **L1**：QuickJS 报错行号 = prelude 行数 + 用户脚本行号；未做偏移校正。`n- **实测（2026-11-23）**：`codemode.notARealTool()` 返回 `TypeError: ... is not a function`，栈帧 `run.js:369:20`，**没有 `script line N`**；无法直接对应脚本行。
- **L2**：沙箱没有 source map / 错误行映射；没有 diff 预览 helper。
- **L3**：可调试性不是一等能力。
- **候选修复**：错误信息减去 `GUEST_PREFIX_LINES`；加 `codemode.diffSummary`；测试覆盖。
- **优先级**：中（低风险、直接改善调试体验）。

## 优先级与依赖

1. **先收口 B7**：Intl + detector 误归因 + G6 重测（当前门禁未过，不能跳过）。
2. **B8-2 内部/可见预算分离 + truncated 元数据 + 行区间读取**（大文件编辑前置）。
3. **B8-1 canonical adapter/helper**（可与 2 并行，独立文件）。
4. **B8-3 patch helper + 写前 diff**（依赖 2）。
5. **B8-4 行号映射 + dry-run 摘要**（独立、低风险，可随时做）。

## 待决策

- canonical adapter 放网关还是沙箱 helper？建议：网关只做"不丢数据 + truncated 元数据"，
  canonical 扁平视图放 helper（避免上游版本漂移时破坏原始调用）。
- 沙箱内文本预算上限（需要内存/CPU 压测；不能无限）。
- patch 的格式支持（unified diff vs 行号 edit；先 unified diff + strict context）。

## 状态

⚠️ 已登记，未实现。B7/G6 收口后再排期；不与当前 G6 修复混在一起。
