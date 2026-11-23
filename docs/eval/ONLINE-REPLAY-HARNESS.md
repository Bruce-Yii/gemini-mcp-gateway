# Online-session replay harness（`online-replay.v1`）

> 状态：**新增离线 harness + 测试 + 文档**。把「在线真实会话」变成可离线重放的
> harness，让半在线（L1/G6）更接近在线：**同 prompt / 同 tool args / 同 client
> profile** 在当前 checkout 重放只读工具，写工具强制 `dryRun`，再把当前输出与在线
> 录制输出按字段 diff，明确输出 `pass` / `diff` / `not-comparable`。
>
> 硬边界（继承 `AGENTS.md` 与 `ONLINE-FEEDBACK.md`）：
>
> - **不接生产、不联网、不写仓库数据、不 commit / push / deploy**；不改 `src/`、
>   其它 scripts/tests/README/workflows。本批只新增四个文件（本文件、脚本、测试、
>   ledger）。
> - 该 harness 是**证据重放器，不是裁判机**：diff 输出是待核查信号，不是改代码、
>   开 issue、合并或部署的依据（免费模型/归因器输出同样只是假设）。
> - **不伪造 requestId**：缺失一律 `unknown`；`unknown` 不参与 id 相等性判定。
> - 客户端宿主 / 模型服务方 / 传输层的效果**不可离线复现**，一律标
>   `not-comparable`，绝不写成 pass/fail。
>
> 实现：`scripts/replay-online-session.mjs`；测试：`tests/replay-online-session.test.js`。

---

## 1. 它解决什么缺口

| 现状 | 本 harness 的做法 |
|---|---|
| 在线 capture 是一次性的，用户窗口过去就没了 | 从 `gmg.capture.v1` envelope 提取规范化 session，可反复重放 |
| L1/G6 的 prompt 与 fixture 是人工构造的，离真实用户远 | 用**在线录制里逐字的 prompt / tool args / client profile** 构造 replay plan |
| 在线写操作不能重跑，怕真写 | 写工具强制 `dryRun:true` / `forRealWrite:false`，真实写为零 |
| 「当前输出和在线录制相比到底差在哪」没有结构 | 按 `exactness / contract / truncation / path / id` 分字段 diff，输出稳定 verdict |
| 无 capture 时什么也做不了 | `createFakeSession()` 提供确定性 fixture；`fetch` / `upstream` 可注入，全程不联网 |

与 `ONLINE-SEMIONLINE-JOIN-2026-11-23.md` 的关系：join 文档负责「F1–F6 × 半在线轴」
的**覆盖缺口登记**；本 harness 负责把一条真实会话**转成可执行的半在线输入**。
它不替代 J1–J6 任务，也不把在线 HTTP request 当 L1 task。

---

## 2. 输入：从 R2 / capture 导出

`src/capture.js` 的 envelope（`gmg.capture.v1`）关键字段（只读，脚本不改源）：

| 字段 | 用途 |
|---|---|
| `requestId` / `sessionId` | 身份锚点；缺失写 `unknown` |
| `ts` / `deployment` | 时间线排序与构建标签；仅记录，不参与判定 |
| `clientPlatform` / `clientProfile` / `oauthClientId` | 重放时保持同 client profile；host 侧标注不可比 |
| `request.raw` | JSON-RPC body：`tools/call` 的 `params.arguments.code` 即 prompt；`tools/list` 响应提供工具快照 |
| `events[]`（`upstream`） | 每次工具调用：`payload.server` / `payload.tool` / `payload.args` / `payload.result`（或 `payload.error`） |
| `events[]`（`sandbox`） | `payload.code` 是 Code Mode 执行的用户脚本 |
| `response.raw` / `model` | 在线录制的输出与模型侧审计；模型字段仅记录，不可比 |

### 2.1 从 R2 导出（人工步骤，harness 不联网）

R2 对象键格式见 `src/capture.js`：`capture/<date>/<requestId>.json.gz`。
按 `docs/eval/ONLINE-FEEDBACK.md` §2 的显式锚点（时间窗 / session / task /
requestId）挑选对象，用你自己的 R2 凭据（**不进仓库、不进日志**）导出到工作目录，
拼成数组文件，例如 `work/replay-input.json`：

```jsonc
[
  { "schema": "gmg.capture.v1", "requestId": "<真实 UUID>", "sessionId": "...", "...": "..." },
  { "schema": "gmg.capture.v1", "requestId": "<真实 UUID>", "...": "..." }
]
```

> 不要从 prompt 猜 requestId/taskId；拿不到就写 `unknown`。
> `capture/<date>/<requestId>.json.gz` 与 `online-feedback*.md` 对不上时，
> 保持 `captureVerified:false`，本 harness 不会替你「补」证据。

本机文件 sink 的 capture 在 `work/capture/*.json`（未压缩），可直接作为数组元素。

### 2.2 无 capture：fixture

```bash
node scripts/replay-online-session.mjs --fixture > work/replay-fixture.json
```

`createFakeSession(options)` 支持 `seed` / `requestId` / `sessionId` /
`includeWrite` / `withTruncation`。fixture 的 requestId/sessionId 默认 `unknown`，
不生成 UUID；测试注入的 UUID 只是 fixture 元数据，**不是生产证据**。

---

## 3. 用法

```bash
# 真实 capture（数组或 {envelopes:[...]}）
node scripts/replay-online-session.mjs work/replay-input.json > work/replay-report.json

# fixture（无输入文件）
node scripts/replay-online-session.mjs --fixture > work/replay-report.json

# 直接消费预构造的 fixture session（stdin）
node scripts/replay-online-session.mjs --fixture --stdin < work/replay-fixture.json
```

CLI 只向 stdout 写确定性 JSON（`schema: online-replay.v1`），包含四块：
`session`（提取结果）、`plan`（重放计划）、`replay`（当前输出）、
`comparison`（diff 报告）。不写任何文件。

### 3.1 纯 API

```js
import {
  extractSession, buildReplayPlan, replayPlan, diffReplay,
  createFakeSession, classifyField, aggregateVerdict, toJson,
} from '../scripts/replay-online-session.mjs';

const session = extractSession(envelopes);       // 输入 envelope 不被修改
const plan = buildReplayPlan(session);           // 同 prompt/args/profile；写 -> dryRun
const output = await replayPlan(plan, { upstream: fakeUpstream, fetch: fakeFetch });
const report = diffReplay(plan, output, { recorded: session });
```

`upstream({name, args, index}) -> result` 可注入；`fetch` 只透传，harness **自身**
从不调用网络（测试对此有断言）。不注入时使用确定性离线 stub。

---

## 4. replay plan 规则

1. **prompt 逐字保留**：`sandbox.code` / `params.arguments.code` 原样进 `plan.prompts`，
   不改写、不摘要。
2. **tool args 逐字保留**：只读调用 arg 原样；写调用强制 `args.dryRun = true`，
   `forRealWrite = false`，并记 `mode:'dryRun'`。
3. **client profile 一致**：`clientPlatform` / `clientProfile` 从 capture 带入；
   `tools/list` 快照原样带入（有则比较，无则跳过）。
4. **相同 build 内对照**：`buildId` 默认 `checkout-current`。旧构建 capture 只作
   recorded 侧对照，**不与当前 checkout 混算差值**（见 join 文档 §4）。
5. **不可能真写**：即使上游传入 `forRealWrite:true`，也只记录在
   `realWriteAttempted` 作为违规信号，不执行真写。

---

## 5. diff 分类与 verdict

| 字段 | 判据 |
|---|---|
| `exactness` | `canonicalJson` 结构化深比较（对象键序无关）；不一致 → `diff` |
| `contract` | 网关 wire 契约：`content:[{type:'text', text:string}]`；形状不同 → `diff` |
| `truncation` | 显式截断标记（`--- TRUNCATED ---` / `…[truncated n]` / `truncated:true`）存在性不一致 → `diff` |
| `path` | 两侧 payload 都有显式 `path` 才比较；任一侧没有 → `not-comparable` |
| `id` | 两侧都是真实 requestId 才比较；任一侧 `unknown` → `not-comparable` |

整体 verdict（`pass` / `diff` / `partial` / `not-comparable`）：

- 任一 step 的可比字段 `diff` → `diff`；
- 否则只要有可比字段 `pass` → `pass`（context 中的 host/model/timing 字段不改变结论）；
- 完全没有可比字段（例如全是 dryRun 写模拟）→ `not-comparable`；
- `counts` 单独统计三类字段数量，供人审阅分布。

写工具在 `exactness` / `contract` 上固定标 `not-comparable`（原因写明 dryRun 无法
与真实在线写做字节对比），绝不会因为「stub 长得像」而判 pass。

---

## 6. 能复现 / 不能复现

### 6.1 可离线复现（网关侧、确定性）

- 同 prompt / 同 tool args / 同 client profile 的**只读工具调用**与结果形状。
- 工具结果 wire 契约（`content` 文本 JSON）与错误槽形状（`isError` / `{error}`）。
- 显式截断标记的一致性（`truncation`），以及 `path` 字段一致性（当两侧都有）。
- F1/F2 相关纯函数路径（`result-normalize.js` 的提示剥离 / URL 优先 PR number）：
  只要有对应的真形状 capture 或 fixture，即可在重放后用 `exactness` 观察是否回退。

### 6.2 不可离线复现（明确 `not-comparable`）

- **客户端宿主行为**：Gemini 客户端如何展示、是否缓存工具列表、用户是否漏看
  可加载列表（用户已澄清的非网关故障）、长会话 `unknown_tool`（F6b）。
- **模型/服务方行为**：模型选哪个工具、提示词歧义、上下文压力、模型侧静默截断
  （`model.possibleModelTruncation` 只记录不判定）、上游服务方实时状态。
- **部署/传输层**：`deployment`、`durationMs`、`responseBytes`、`ts`、
  `oauthClientId`、HTTP 层 `status`/`headers` —— 旧构建 vs 当前 checkout 不具共同分母。
- **真实写**：`push_files` / `applyFilePatch` / `create_or_update_file` 等只能 dryRun；
  原子提交、后条件、落盘字节属 L1/G6 任务轴（J5），不是本 harness 的结论。
- **跨构建硬比**：旧构建 F1/F2 `pending-deploy` 状态不能靠本 harness 升级；
  必须有部署窗口的可回放 requestId + capture。

---

## 7. 接入 L1

1. 把本 harness 的 `plan.steps` 当作 L1 任务的**输入段**（同 prompt/args/profile），
   交给现有 `scripts/run-l1-smoke.mjs` 的 fake/replay 模式执行；**不修改** L1 runner。
2. `comparison.verdict` 只作为「当前 checkout 在该轴上与录制是否一致」的旁证，
   不写进 L1 的 `completionRate`，不与 `p95LatencyMs` / `tokensPerTask` 混算。
3. 每条 diff 按 `AGENTS.md` 流程处理：回到 `requestId`（unknown 则先补证据）→
   本地同 code/args/fixture 复现 → 写确定性回归测试 → 再谈修复；不自动开 issue/PR。
4. 与 J1–J6 的分工：J1/J2 补 F1/F2 的可执行轴，J3–J6 补在线-only 轴；
   本 harness 提供真实会话输入，不替代任务集、也不改任务集文件。
5. 回归命令（本批新增测试）：`node --test tests/replay-online-session.test.js`。

---

## 8. 测试覆盖（`tests/replay-online-session.test.js`，22 项全绿）

- fixture 解析：capture envelope 提取 clientPlatform/profile/model/tools-list/timeline、
  每工具调用 name/args/result、错误事件、输入不被修改、缺身份写 unknown。
- 只读重放：注入 upstream 收到相同 args；注入 fetch 不被调用。
- 写 dryRun：camelCase/snake_case 写工具识别；`dryRun=false` 被强制改 true；
  `forRealWrite:true` 被记为违规且不真写。
- diff 分类：exactness/contract/truncation/path/id 各自 pass/diff/not-comparable 路径。
- 不可比标记：client host / model / timing 全为 `not-comparable`；dryRun 写不可判等。
- 确定性：提取→计划→重放→diff 逐字节一致；无墙钟时间戳。
