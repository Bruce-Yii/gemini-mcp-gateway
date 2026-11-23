# Batch 13 · 平台分账：digest / conformance / eval lane（2026-11-23）

> 范围（本 agent 只写这 4 个文件）：
> - `scripts/capture-digest.mjs`（改，pure additive）
> - `scripts/platform-conformance.mjs`（新增，纯检查 / 只读）
> - `tests/platform-eval.test.js`（新增）
> - 本台账 `docs/ledger/batch-13-platform-eval.md`（新增）
>
> **未改** `src/`、`scripts/run-l1-smoke.mjs`（另一 agent 正在改）、其他 scripts、
> 其他 tests、`README`、`workflows`、契约文档。
> **未 commit / push / deploy**，改动全部留在工作区，由 lead 集成。

## 一、目标与边界（先说清楚不做什么）

目标是让 Gemini / ChatGPT / Claude 的 digest 指标**互不污染**，并提供一个
离线、只读的 conformance 检查器验证三平台的编码/注解/工具面不变量。

**不是**多租户、不是安全层、不是客户端真实性判定。具体不做：

- 不根据 User-Agent / `clientInfo.name` / 工具名 / OAuth client id **猜测**平台；
  只认 envelope 上显式的 `clientPlatform`，其余一律 `unknown`。
- 不改 `tools/list` 的工具名、数量、schema；三工具 `search` / `execute_read` /
  `execute` 在所有平台完全一致（conformance 里作为硬不变量检查）。
- 不把平台标签用在写路径 / 幂等 / 权限；写算法保持平台无关。
- **不跨平台硬比 baseline**。每个平台有独立的任务集、分母和阈值；同一份
  L0/L1 任务可以复用，但结果不能混算成一条基线。
- 不在本批接 L1 lane：脚本不动 `scripts/run-l1-smoke.mjs`，只在第六节给出
  后续接入点；真实客户端实测仍未做。

## 二、输入契约（依赖 platform-capture 落地的字段）

capture 侧在每个 envelope 顶层加三个**加性标量**：

| 字段 | 合法值 | 说明 |
|---|---|---|
| `clientPlatform` | `gemini` / `chatgpt` / `claude` / `unknown` | 分账唯一依据 |
| `clientProfile` | `gemini-text-json` / `chatgpt-structured` / `claude-text` / `unknown` | 编码标签，**不反推平台** |
| `oauthClientId` | 字符串或 `null` | 仅作证据，不用来猜平台 |

读取规则（`clientPlatformOf()` / `clientProfileOf()` / `oauthClientIdOf()`）：

- 只有 **string 且在闭合集合内** 才算有效；大小写 / 首尾空白做归一化。
- 缺失、`null`、数字、空串、未知 token → `unknown`。
- **旧 envelope（三个字段都没有）全部进 `unknown` 桶**，不会被悄悄算进
  Gemini，也不会因为某个请求带了 Gemini 风格的 `content[]` 就归到 Gemini。

## 三、digest 改动（`scripts/capture-digest.mjs`）

全部为加性字段，旧 scorecard / metrics 字段保持原样（旧测试 58/58 通过）。

### 1. `byClientPlatform`

键为 `gemini` / `chatgpt` / `claude` / `unknown`（只输出实际出现的平台），
每个值一行：

```
{ platform, requests, mcpRequests, errors, toolCalls, truncationSuspects,
  sessions, projects, sessionIds[], projectKeys[], requestIdSamples[] }
```

- `truncationSuspects` 合并 gateway wire truncation 与 advisory model-side
  silent truncation（与顶层两个独立计数器语义保持一致）。
- `sessions` / `projects` 为该平台见过的**不同** sessionId / projectKey 数量；
  id 列表同时保留，便于回到 R2 用 requestId 回放。
- `requestIdSamples` 有上限 5、去重、按出现顺序，作为可回放证据。

### 2. `platformSummary`

`platformSummary` 是 compact 数组，字段顺序固定：

```
platform, requests, mcpRequests, errors, toolCalls,
truncationSuspects, sessions, projects, requestIdSamples
```

顺序为 `gemini, chatgpt, claude, unknown`（只为稳定输出，**不代表质量排名**）。

### 3. sessions / projects 的平台维度

- `digestSessions()` 每行新增 `clientPlatforms[]` 与
  `requestsByClientPlatform{}`；一个窗口若出现多平台会如实列出，不合并。
- `digestProjects()` 每行新增 `clientPlatforms[]`；`projectTimelines[]` 同样。
  项目与平台正交：一个项目可跨多平台，一个平台也可触达多项目。

### 4. Markdown

`renderScorecard()` 新增 `## By client platform (batch 13)` 表：
Platform / Requests / MCP requests / Errors / Tool calls / Trunc suspects /
Sessions / Projects / RequestId samples。
Projects 表增加 `Platforms` 列，Sessions 表增加 `Platforms` 列；旧列顺序
其余不变，旧章节全保留。

## 四、conformance 检查器（`scripts/platform-conformance.mjs`）

### 1. 性质

- **只读**：只用 `node:fs/promises` 的 `readFile` / `readdir` / `stat`；
  不写文件、不联网、不启子进程、不调模型、不调上游。
- **确定性**：纯函数，同一输入两次调用输出一致；每项检查输出
  `pass | fail | unknown` + `evidence: requestId[]`。
- **`unknown` 不是 pass**：没有对应平台的 fixture 时返回 `unknown`，汇总状态
  只有当所有检查都 pass 才是 `pass`；有任一 `fail` 是 `fail`；否则 `unknown`。
- **不猜测**：平台只读 `clientPlatform`；旧 envelope 被排除出三平台专项检查，
  但仍可用于平台无关的 tools/list 检查。

### 2. 四项检查

| Check | 通过条件 | 失败条件 | unknown |
|---|---|---|---|
| `gemini_no_structured_content` | 每个 gemini `tools/call` 结果无 `structuredContent` | 任一结果泄漏 `structuredContent` | 无 gemini tools/call fixture |
| `chatgpt_dual_encoding` | 每个 chatgpt 结果同时有 `structuredContent` 和单个 text JSON block，且两者 JSON 深度相等 | 缺一项或编码不一致 | 无 chatgpt tools/call fixture |
| `claude_annotations` | 每个 claude `tools/list` 的每个工具有显式布尔 `readOnlyHint` 与 `destructiveHint` | 任一工具缺失或非布尔 | 无 claude tools/list fixture |
| `stable_tools_list` | 每个 `tools/list` 的工具名**恰好** `['search','execute_read','execute']`（数量与顺序都稳定） | 改名 / 增减 / 乱序 | 无 tools/list fixture |

### 3. 用法与 fixture

```
node scripts/platform-conformance.mjs --fixtures work/fixtures/gemini.json
node scripts/platform-conformance.mjs work/fixtures/            # 目录里的 *.json
```

fixture 接受单个 envelope、envelope 数组，或 `{ "fixtures": [...] }`。
envelope 为 capture 风格记录：

```json
{
  "requestId": "g-001",
  "clientPlatform": "gemini",
  "request":  { "raw": "{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\"}" },
  "response": { "raw": "{\"jsonrpc\":\"2.0\",\"result\":{...}}" }
}
```

`request.raw` / `response.raw` 也可直接是已解析对象。`tools/list` 响应里
`result.tools[]` 提供工具面与 annotations 证据。
退出码：`0` 全 pass，`1` 任一 fail，`2` 用法/输入错误（`unknown` 单独不触发 1，
但报告里会显式展示）。

## 五、评测 lane 规则（per-platform baseline，不硬比）

1. **分账单位**：一次 L1/G6 run 必须带平台标签（`gemini` / `chatgpt` /
   `claude`）；缺标签进 `unknown`，不与任何平台基线混算。
2. **独立基线**：每个平台有自己的 frozen baseline、任务分母、阈值。
   例如 `explore/baselines/l1-smoke.json` 当前是单平台（Gemini）基线；
   ChatGPT / Claude 不得直接拿它当分母，必须在各自 lane 冻结后建立。
3. **复用任务，不复用判定**：同一套 L0/L1 任务可跨平台跑，但命中率、
   latency、失败分布按平台分组报告；跨平台差值只能写作观察，不能作为
   "回归/pass" 的判据。
4. **分母透明度**：某平台本轮没有任务/没有 capture 时报告 `unknown`
   （no measurement），不能补零、不能用别的平台分母代替。
5. **证据可回放**：所有平台级指标保留 requestId；conformance 的每条结论
   也必须带 requestId，便于回到原始 capture 复核。

## 六、接入 L1 的后续步骤（本批不做，交给后续 agent / lead）

> 本批**没有**修改 `scripts/run-l1-smoke.mjs`。以下是给后续接入的确定性步骤，
> 不是已实现功能。

1. 等 `platform-capture` 落地 envelope 的 `clientPlatform` 字段并跑通旧字段
   兼容测试；确认 `src/capture.js` 写出的顶层标量名与本台账第二节一致。
2. 在 L1 的 run manifest / 结果里记录 `clientPlatform`（缺失写 `unknown`），
   并在 `run-l1-smoke.mjs` 的任务分组处按平台 filter 分母；
   `explore/baselines/l1-smoke.json` 保持 Gemini 基线不动，新增
   `explore/baselines/l1-smoke.<platform>.json`（按平台冻结）。
3. 把 `scripts/platform-conformance.mjs` 作为 L1 的前置 gate：从该次 run 的
   capture 导出 fixture，conformance 必须 **pass** 才允许把该平台的 L1 指标
   写进基线；`fail` 阻断，`unknown` 标 no-measurement 而不阻断其他平台。
4. 在 scorecard / L1 report 中引用 `platformSummary` 与 conformance 报告里的
   requestId，形成 capture → digest → conformance → eval 的证据链。
5. 真实客户端联调（ChatGPT connector / Claude / Gemini）后，再确认各平台
   编码在 wire 上确实符合第四节的不变量；本批只有离线确定性测试。

## 七、测试与结果

新增 `tests/platform-eval.test.js`，**17 个测试**（全离线、无网络、无模型）：

| 覆盖点 | 测试 |
|---|---|
| 平台字段闭合集合 / 不猜测 / 旧字段 unknown | clientPlatformOf ×2、clientProfileOf/oauthClientIdOf |
| gemini / chatgpt / claude / unknown 分组 | digest groups…、legacy envelopes… |
| 每平台 errors/toolCalls/truncation 独立 | per-platform toolCalls… |
| sessions/projects 平台维度 | platformSummary…、sessions and projects… |
| MD per-platform 表 + 旧章节保留 | scorecard renders… |
| conformance 四个场景（双编码 / annotations / 三工具） | dual encoding detector、all four pass、gemini leak fail、chatgpt/claude fail、stable tools list |
| unknown 不当 pass | no matching fixture yields UNKNOWN… |
| 只读 / 离线 / 确定性 | conformance module is read-only and offline |

验证命令与结果（本 agent 工作区内）：

- `node --check scripts/capture-digest.mjs`：通过
- `node --check scripts/platform-conformance.mjs`：通过
- `node --test tests/platform-eval.test.js`：**17 / 17 通过**
- 回归 `node --test tests/capture-digest.test.js tests/session-clustering.test.js
  tests/project-rollup.test.js tests/client-profile.test.js`：**58 / 58 通过**
- 全量 `npm test`（本 agent 工作区，当前并发状态下）：**827 / 827 通过，0 fail**（含
  本批 17 个新测试），未观察到其他 agent 并发改动造成的失败。并发改动若继续落地，
  由 lead 统一复跑全量；届时若出现与本批无关的失败，**以本文件上述定向结果为准**，
  不把并发失败算作本批回归。

## 八、风险 / 限制

1. **依赖未落地字段**：本批按约定的顶层标量实现并做了 tolerant 读取；若 capture
   侧最终字段名不同，需要同步 `clientPlatformOf()`（一处）。
2. **无真实客户端实测**：conformance 检查的是 fixture 里的 wire 结果，不替代
   ChatGPT / Claude / Gemini 的真实兼容性验证。
3. **`unknown` 可能偏大**：部署初期旧 envelope 多，`unknown` 桶会偏大；这是
   刻意的诚实做法，不把历史流量偷偷归属给任何平台。
4. **conformance 的输入是离线 fixture**：它不主动从 R2 拉取 capture（保持只读
   离线）；需要由调用方先导出 fixture，这也是第六节接入步骤的一部分。
