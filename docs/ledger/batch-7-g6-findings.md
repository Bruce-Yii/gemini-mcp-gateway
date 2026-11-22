# B7 · G6 全量重测发现：sandbox 缺少 Intl + 检测器误归因

> 2026-11-23。G6 用 5 上游 228 任务跑完（run `run-1795367330219-12631ed7`）。
> 本批只登记发现与分类，**不宣布 G6 通过**。

## ISSUE-G6-1：sandbox 没有 Intl（真缺口）

- **表象**：5 条 Notion 任务 `execute error: Intl is not defined (script line 299...)`。
- **L1**：QuickJS guest prelude/global 没有 `Intl`；模型用 `new Intl.DateTimeFormat(...)` 构造日期范围。
- **L2**：沙箱的能力契约只写了"JS"，没有列出可用/不可用的标准全局；模型按 Node 习惯写代码。
- **L3**：Code Mode 的"可预期运行时"没有定义——与 B5 的截断预算不透明同源（让模型猜）。
- **影响**：可恢复（模型重试改用 UTC getter 后继续），但会浪费一轮上下文；若任务依赖 locale/时区格式化，可能直接失败。
- **候选修复**（未定）：
  1. 加最小 `formatDate()` sandbox helper（UTC/ISO），并在 guidance 明确 "Intl 不可用"；
  2. 提供受限 `Intl.DateTimeFormat`/`NumberFormat` polyfill（覆盖常用 options；风险是 locale 语义不完整）；
  3. DEC：保留缺失，只文档化。
- **状态**：⚠️ 待决策/实现；G6 因此不能通过。

## ISSUE-G6-2：检测器把非网关问题归到 gateway

- `not a function` 5 条：模型抄了不存在的 callName（如 `notion__notion_get_page`），
  实际可调用名在 search 的 `callName` 字段；非网关。
- `services` 对象 16 条：`execute_read` 返回 `codemode.services()` 的合法对象，detector 却发
  `execute_error`；属于 **detector 口径 bug**，与网关功能无关。
- 其余 124 条 gateway 中，约 98 条是上游套餐/账号（Notion Business/日历未连接）、
  Vercel token 权限 403/404、Figma 占位 fileKey/nodeId、Linear 复杂度/team 不存在、
  GitHub 404 等，均非网关功能 bug。
- **修复方向**：G7 前先修 detector 的 `services` 误报与 execute_error 归因，否则 G6 数字不可用于验收。

## 验证与门控

- **初次运行（修复前）**：228 tasks / 855 turns / 703 tool calls；anomalies 387（model 257 / gateway 124 / infra 3 / synthetic 3）。
- 逐条复核后：真网关缺口 = Intl（5）；其余为模型/上游/账号/检测器。
- 初次结论：未通过（Intl 未解决 + detector 口径未修）；修复后重跑见下节，G6 通过。

## 修复与重跑（2026-11-23）

- **Intl**：`src/codemode.js` 加 `codemode.formatDate()` / `codemode.nowISO()`，guidance 明确
  "Intl is unavailable"；不塞不完整的 Intl polyfill（避免 locale 语义骗模型）。
- **Detector**：`explore/trace.mjs` `classifyExecuteResult` 只在 JSON 显式 error（isError/status/error/`execute error:`）时判错；
  成功的 `services()` / 含 "not found" 数据的成功结果不再误报；`not a function` 归 model（模型 callName 写错）。
- 测试：`tests/codemode-date-helper.test.js` 3 条 + `tests/detector.test.js` #24 4 条；全量 **350/350**。

### G6 重跑结果

- 228 tasks / 873 turns / 718 tool calls；3,409,329 prompt + 71,224 completion tokens；wall ~45 min。
- anomalies **363**（model 273 / gateway 86 / infra 1 / synthetic 3）；searchHitRate 85.3%、toolHitRate 52.9%。
- Intl 0 条、services 误报 0 条；`not a function` 7 条全部归 model。
- gateway 86 复核：Vercel 404 19 / 403 9、Notion Business 9、upstream validation 9、not-found 10、
  Linear complexity 5、Figma 占位 fileKey 3、其余为上游数据/账号；**没有新的网关功能 bug**。
- 已知差异：本轮 Notion token 只暴露 47 工具（上一轮 53），属于 token/工作区权限差异，非网关。
- **G6 结论：✅ 通过（无新网关功能 bug）**；G7 线上带客户端 token 真实调用仍未做。
