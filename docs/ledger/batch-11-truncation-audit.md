# Batch 11 — 模型侧静默截断：capture/analyzer 可检测化（P0）

> 状态：已实现（工作区未提交）· 2026-11-23
> 范围：`src/capture.js`（仅新增 envelope 审计字段）、`scripts/capture-digest.mjs`、`scripts/analyze-captures.mjs`、`tests/capture-truncation-audit.test.js`、本文档。
> 明确不改：`src/codemode.js`、`src/result-normalize.js`、`src/file-write.js`、`src/server.js`、`src/vercel-app.js`、README、CHANGELOG。
> 不 commit / push / deploy。免费模型输出仍是**待验证假设**（见 AGENTS.md 硬规则），本批新增的也仅是**确定性审计信号**，不是结论。

## 1. 背景与证据

线上出现两类请求，网关/上游链路完整、但模型侧可见输出被无声截断：

| requestId | 现象 |
|---|---|
| `363fd3e7-a9ff-44b7-b2f0-c1e4c27329b6` | 上游/网关响应完整，模型输出被截断，无 `truncated` 标记 |
| `21896fe1-da1c-4682-93b9-1c8c53f5405c` | 同上 |

根因线索：模型代码 `.slice(0,150)` 之类的投影把完整上游结果裁短后返回；`toModelOutput()` 只把 `output.result` 交给模型，`toolCalls` / `logs` 不进模型上下文。传统观测只看 HTTP 状态、capture `overflow`、wire `truncated` 标记——这些在静默截断场景中**全部健康**，因此问题此前只靠改 README 提醒，无法被自动检测。

本批目标：把"模型侧静默截断"变成 capture → digest → analyzer 三处都可计算、可聚合、可回溯的问题，而不是再补一次文档。

## 2. 判定规则（确定性，字节级，无语义猜测）

### 2.1 capture 新增字段（`envelope.model`）

`src/capture.js` 新增纯函数 `buildModelOutputAudit({ events, response })`，在 `res.end` 构造 envelope 时**附加** `model` 字段；捕捉语义、所有旧字段（含 `request.raw`、`response.raw`、`bytes`、`overflow`）完全不变。

| 字段 | 定义 |
|---|---|
| `modelOutput.summary` | 模型可见输出的可读摘要（最长 160 字符 + `…`），不含上游全文 |
| `modelOutput.length` | 可见输出的字符数（字符串）或字节数（非字符串） |
| `modelOutput.sha256` | 可见输出的 SHA-256 前 16 位，用于和 R2 raw 交叉核对 |
| `sourceBytes` | 本次请求内**最大的上游响应字节数**：`upstream` 事件的 `payload.result`，或 `upstream_frame` 中 `direction:'in'` 的 `message`；取最大值。无上游数据记 0 |
| `modelOutputBytes` | sandbox 事件 `payload.output.result`（即 `toModelOutput` 交给模型的值）的 wire 字节数 |
| `possibleModelTruncation` | 布尔，见下 |

"可见输出"严格取 sandbox 事件的 `output.result`，与 `toModelOutput()` 的投影一致；"源"严格取上游完成响应，与"上游/网关响应完整"的证据一致。

### 2.2 `possibleModelTruncation = true` 的充要条件

四条**同时成立**才置 true：

1. 存在 sandbox `output`（没有 sandbox 输出就不猜）；
2. 存在上游源且 `sourceBytes > 0`（没有源不猜）；
3. `modelOutputBytes <= sourceBytes * 0.5` **且** `sourceBytes - modelOutputBytes >= 64`（明显更短，两个保守阈值同时满足）；
4. sandbox `output`、可见输出、`response.truncated`、`response.raw` 中**没有**显式截断标记：`truncated === true`、`--- TRUNCATED ---`、`…[truncated N]`、JSON `"truncated":`。

不满足任一条一律 false。规则只比字节数和显式标记，**不读内容语义**（不判断"像不像被截断的句子"）。

### 2.3 误报边界（明确不报）

| 场景 | 是否命中 | 理由 |
|---|---|---|
| 上游 1000B → 模型可见 1000B | 否 | 没有变短 |
| 上游 1000B → 模型可见 900B（正常摘要） | 否 | 未过 50% 阈值 |
| 可见输出短但带 `truncated:true` / wire 标记 | 否 | 发送方已声明，属显式截断 |
| 无 sandbox 输出（`output === null`/缺事件） | 否 | 没有可比对象 |
| 无上游响应（例如纯本地计算） | 否 | `sourceBytes = 0` |
| `response.overflow === true`（capture 超限） | 否 | 这是**网关 capture 限制**，与模型侧截断无关；规则明确不引用 `overflow` |
| `response.truncated === true`（wire 截断） | 否 | 属显式 wire 截断，计入旧的 `truncated`，不重复计为模型静默截断 |
| 旧 envelope 没有 `model` 字段 | 否 | digest/analyzer 只信确定性 stamp，不追溯猜 |

## 3. Digest 新增（与网关 overflow 严格分账）

`scripts/capture-digest.mjs` 新增导出 `isModelTruncationSuspect(envelope)`：只认 `envelope.model.possibleModelTruncation === true`，不从正文推断。

新增聚合字段（均为 additive，旧 scorecard 字段不变）：

- `model_truncation_suspects`：总数；
- `modelTruncationRate`：占请求数比例（4 位小数）；
- `modelTruncationByServer` / `modelTruncationByTool` / `modelTruncationBySession`：按 server / tool / sessionId 聚合的 suspect 数；
- 每个 `upstreamStats` / `toolStats` / `byRoute` 组新增 `modelTruncationSuspects` 计数。

scorecard 的 "Truncation / overflow" 表格现在列三种**互相独立**的信号：

| 信号 | 含义 |
|---|---|
| Truncated responses（gateway wire） | 网关/上游 wire 上的显式截断或 `response.truncated` |
| Overflow captures | capture 超过 `maxBytes` 被丢弃的 body |
| Model truncation suspects（silent, advisory） | 本批新增；wire 完整但模型可见输出显著更短且无标记 |

`statTable()` 增加 `ModelTrunc` 列；按 server/tool/session 独立小节渲染。三者绝不混算——测试显式固定了这一点。

## 4. Analyzer 新增（advisory-only，validator 不变）

`scripts/analyze-captures.mjs` 的 `buildAnalyzerInput()` 新增：

- `truncationSuspects[]`：每条保留 `requestId`、`sessionId`、`server`、`tool`、`sourceBytes`、`modelOutputBytes`、`modelOutputLength`、`modelOutputSha256`、`modelOutputSummary`（摘要截断到 1000 字符）；
- 独立 cluster：`kind: 'model_truncation_suspect'`、`advisoryOnly: true`，`sampleEventIds` 取 suspect 的 requestId（最多 20 条）。

**validator 规则逐字未改**：`validateAnalyzerOutput()` 仍用原有证据白名单（来自 `input.clusters` / `input.samples`）。本批把 suspect id 以 cluster 形式放入输入，因此模型引用这些 requestId 合法，但**不能**凭空造证据、不能改 severity/category 枚举、不能突破 5 条 issue / 1200 字符上限。`policy=free-model-advisory-v1`、`advisoryOnly=true`、`requiresHumanReview=true` 均不变。

模型 prompt 增加一条提示：把 suspect cluster 当作**字节级 advisory hint**，不得归类为网关错误或 overflow，引用前必须回到 raw capture 本地复现。依据 AGENTS.md 硬规则：模型建议一律是假设，不直接改代码、不开 issue、不部署。

## 5. 测试

新增 `tests/capture-truncation-audit.test.js`（14 个用例）：

| 用例组 | 覆盖 |
|---|---|
| 完整数据不误报 | source 1000B → visible 1000B，flag=false |
| 短且无标记命中 | source 1000B → visible 150B，flag=true |
| 显式 `truncated:true` 不命中 | flag=false |
| wire 标记不命中 | flag=false |
| 无 sandbox / 无上游不误报 | 全空，`possibleModelTruncation=false` |
| 阈值边界 | 900/1000（>50%）不命中 |
| overflow 不混算 | `response.overflow=true` 不触发模型 flag |
| envelope 附加字段 | 旧 `schema`/`response.raw`/`overflow` 不变，`model` 正确附加 |
| digest 分账 | `truncated=1`、`overflow=1`、`model_truncation_suspects=1` 互不干扰；按 server/tool/session 聚合 |
| scorecard | 渲染独立小节与三类信号 |
| analyzer | 独立 cluster、保留 requestId/sessionId、validator 证据白名单仍生效、健康数据不产 cluster |
| 真实证据 id | 两条 requestId 都能进入 suspect 列表 |

定向：`node --test tests/capture-truncation-audit.test.js` → **14/14 通过**。
存量回归：`node --test tests/capture.test.js tests/capture-digest.test.js tests/capture-analyzer.test.js` → **28/28 通过**。
全量 `npm test` 结果见交付报告（本批完成后执行，见 §7）。

## 6. 如何回到 R2 raw 复核（人工门控）

审计字段只提示"哪里可能丢了字节"，定性必须回到原始 capture：

1. 从 scorecard / analyzer 输出拿到 `requestId`（本批两条：`363fd3e7-a9ff-44b7-b2f0-c1e4c27329b6`、`21896fe1-da1c-4682-93b9-1c8c53f5405c`）与 `sessionId`、`modelOutput.sha256`。
2. 拉取 R2 原始对象：`capture/<YYYY-MM-DD>/<requestId>.json.gz`（键前缀与 `CAPTURE_MODE=full` 的 `writeR2Sink` 一致）。用 `gunzipSync` 解压后读完整 envelope。
3. 在 raw envelope 里核对三处：`events[].type==='upstream'` 的 `payload.result`（源全文）、`events[].type==='sandbox'` 的 `payload.output.result`（模型可见投影）、`events[].type==='upstream_frame'` 的 `direction:'in'` 帧（wire 原文）。
4. 用 `modelOutput.sha256` 对 `output.result` 做 SHA-256 前 16 位比对，确认摘要指向同一段可见输出。
5. 检查模型提交的 `code`（sandbox 事件 `payload.code`）是否含 `.slice(0, 150)` 或等价投影——这是**人工归因**，不是自动结论。
6. 本地用相同 code / args / fixtures 复现：上游返回完整数据、模型可见输出被裁短、无 `truncated` 标记。复现不出来就丢弃假设。
7. 只有在 1–6 全部闭环后，才允许写确定性回归测试并按 AGENTS.md 走人审；不自动开 issue / PR / 修代码 / 部署。

## 7. 风险与后续

- **阈值是保守的**：50% + 64B 双阈值会漏掉"上游 1000B → 模型 600B"这类中等裁剪；这是为了不误报正常摘要。后续若出现该模式，先补证据再调阈值，并同步更新本文档的边界表。
- **多上游取最大值**：`sourceBytes` 取本次请求最大上游响应；若模型只裁了其中一个较小上游的结果，可能不命中。多上游裁剪的更细粒度归因留作后续。
- **旧数据不回溯**：没有 `model` 字段的历史 envelope 不会被 retro-flag；需要历史分析时用 `CAPTURE_MODE=full` 重新跑样本。
- **摘要不入原始全文**：`modelOutput.summary` 只留 160 字符，避免 digest/analyzer 泄露完整上游内容；复核必须回 R2 raw。
- **未做**：自动修复模型代码、自动改 README、自动开 issue、部署、改契约文档、动上述禁改文件。
