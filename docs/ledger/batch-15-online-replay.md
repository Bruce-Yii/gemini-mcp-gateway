# Batch 15 ledger — online-session replay harness（2026-11-23）

> 任务：把「在线真实会话」变成可离线重放的 harness，让半在线更接近在线。
> 本批**只新增 4 个文件**：
>
> - `scripts/replay-online-session.mjs`（新增）
> - `tests/replay-online-session.test.js`（新增）
> - `docs/eval/ONLINE-REPLAY-HARNESS.md`（新增）
> - 本 ledger（新增）
>
> 不改 `src/`、其它 scripts/tests、README、其它 docs、workflows；
> 不联网、不接生产、不真写、不 commit / push / deploy。

## 1. 交付

| 文件 | 作用 |
|---|---|
| `scripts/replay-online-session.mjs` | 纯离线 harness：capture/fixture → session → replay plan → 只读/dryRun 重放 → 分字段 diff；CLI stdout 输出确定性 JSON |
| `tests/replay-online-session.test.js` | 22 项离线测试，覆盖解析/只读/写 dryRun/diff 分类/不可比/确定性 |
| `docs/eval/ONLINE-REPLAY-HARNESS.md` | R2 导出步骤、可复现/不可复现边界、L1 接入方式 |
| 本文件 | 批次台账与验证记录 |

## 2. 验证（真实执行结果）

| 检查 | 命令 | 结果 |
|---|---|---|
| 新增测试 | `node --test tests/replay-online-session.test.js` | **22 pass / 0 fail**（exit 0） |
| CLI fixture | `node scripts/replay-online-session.mjs --fixture` | exit 0；`schema=online-replay.v1`，2 steps，`verdict=diff`（默认离线 stub 与 fixture recorded 结果不同，诚实报差异） |
| 确定性 | 测试内两次 extract→plan→replay→diff 逐字节比较 | 通过；输出无 `generatedAt`/时间戳 |
| 网络 | 测试中注入 `fetch`，断言 harness 自身调用次数为 0 | 通过 |
| 真写 | 写工具强制 `dryRun:true` / `forRealWrite:false`；`forRealWrite:true` 仅记录 `realWriteAttempted` | 通过 |
| 身份 | 缺 requestId/sessionId → `unknown`；输出无新造 UUID | 通过 |

> 修复记录：初次运行 22 项中 2 项失败——(a) `isWriteTool` 未识别 camelCase
> `applyFilePatch`；(b) `classifyField path` 在 fixture 无显式 `path` 时应为
> `not-comparable`（测试断言写错）。已分别修正正则与测试断言，并重跑全绿。
> 另将 verdict 聚合改为「可比字段才决定 pass/diff；host/model/timing 只记录不降级」。

## 3. 可复现边界（诚实登记）

### 已验证可复现（离线、确定性）

- 从 `gmg.capture.v1` envelope 提取 clientPlatform/profile、model 审计块、
  `tools/list` 快照、每次 upstream 调用的 name/args/result、requestId/sessionId、
  时间线；输入 envelope 不被修改（测试断言规范化 JSON 前后一致）。
- fixture 无真实 capture 时可用；注入 upstream / fetch，零联网。
- 同 prompt / 同 tool args / 同 client profile 的只读重放；写工具 dryRun。
- diff 分类：`exactness`（结构化深比较）、`contract`（text-JSON wire 契约）、
  `truncation`（显式标记）、`path`（两侧都有才比）、`id`（两侧真实 UUID 才比）。
- 整体 verdict 与字段计数稳定；`not-comparable` 明确列出原因。

### 不能复现（本批不解决，明确 not-comparable）

- 客户端宿主行为（Gemini 展示/缓存/用户误判、长会话 `unknown_tool`）。
- 模型服务方行为（工具选择、提示词歧义、上下文压力、模型侧静默截断）。
- 部署/传输层（`deployment`、`durationMs`、`responseBytes`、`ts`、`oauthClientId`）。
- 真实写（只能 dryRun；原子写/落盘后条件归 J5/L1 任务轴）。
- F1/F2 的 `pending-deploy` 升级：需部署窗口的可回放 requestId + capture；本批无
  网络、无真实 capture，不能声称现网状态。

## 4. 与上游文档/批次的关系

- 依据 `ONLINE-FEEDBACK.md`（schema / 锚点 / 不编造 requestId）与
  `ONLINE-SEMIONLINE-JOIN-2026-11-23.md`（同构建配对、禁止跨构建硬比、J1–J6）。
- 与 `batch-15-online-eval.md` / `batch-15-online-semionline-join.md` 并列：
  那两批做在线反馈 schema 与 join 轴登记，本批做**执行侧 harness**。
- 输入 capture 结构只读参考 `src/capture.js`（未改动）。

## 5. 状态与后续（不由本批自动执行）

| 项 | 状态 | 后续条件 |
|---|---|---|
| harness + 测试 | `fixed 代码层`（22 项绿） | 接入 L1 fake/replay 模式时不改 L1 runner，仅把 plan.steps 当输入段 |
| 真实 capture 端到端重放 | `unknown` | 需人工从 R2 导出并用自身凭据（不进仓库）；本批无网络 |
| F1/F2 现网复验 | `pending-deploy` | 部署窗口 + requestId + capture；本 harness 不能替代 |
| diff 触发的修复 | 无 | 按 `AGENTS.md`：回到 requestId → 本地复现 → 回归测试 → 再谈修复；不自动开 issue/PR |

> 本批未改任何产品代码；所有 diff/失败都是待核查信号，不是事实或指令。
> 不 commit / push / deploy。
