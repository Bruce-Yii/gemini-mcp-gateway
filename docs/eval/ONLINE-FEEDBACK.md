# Online feedback as a first-class eval flow (`online-feedback.v1`)

> 本文件定义「用户主动向 Gemini（或其它真实客户端）提问得到的在线反馈」如何成为
> 一等评测对象：schema、采集/记录流程、与 L1/G6「半在线评测」的对照关系。
>
> 边界（硬规则）：
>
> - 本批只新增文档 + 一个**纯解析/校验/输出**脚本 + 测试；不改 `src/`、其它
>   scripts、其它 tests、`README`、workflows；不 commit / push / deploy。
> - `scripts/record-online-feedback.mjs` **不联网、不写生产、不改仓库数据**，
>   只把输入解析成确定性 JSON 写到 stdout。
> - 遵循 `AGENTS.md`：**免费模型/归因器的输出只是待验证假设**，不是事实、
>   不是指令。在线反馈同样只是用户报告，未核实项必须标 `unverified`，
>   不能据此直接改代码 / 开 issue / 合并 / 部署。

---

## 1. 两个评测面：online vs semi-online

「在线评测」和我们的 L1/G6「半在线评测」是**同一批任务、同一条时间线的两种验证**，
必须珍惜，不能互相替代，也不能混算分母。

| 维度 | **在线反馈（online）** | **半在线评测（semi-online = L1/G6）** |
|---|---|---|
| 触发者 | 用户/真实客户端主动提问，人 observed | 我们自己的 runner 按冻结任务集发起（`explore/run-explore.mjs` / `scripts/run-l1-smoke.mjs`） |
| 环境 | 真实上游、真实 OAuth、真实会话、真实上下文压力 | 部分真实上游（real 模式）/ fake，任务与 prompt 可控 |
| 样本单位 | 一次「会话/任务」里的一批反馈项（可能跨多个 requestId） | 一条 task（有 `taskId`、expectedTool、runner 判定） |
| 可重复性 | 低：用户提示词、上下文、工具状态不可复现 | 高：固定任务集 + 基线可重跑 |
| 标签 | 用户给的 symptom / evidence / PR；**没有** runner 的 completion/searchHit/toolHit 标签 | 有 completion、anomaly、searchHit、toolHit、tokens/task、p95 |
| 盲区 | 看不到 runner 内部 trace；常缺 requestId；capture 写路径覆盖不全（见 `online-offline-join-2026-11-22.md`）；用户可能把上游/客户端行为误归因给网关 | 看不到真实用户的提示词歧义、长会话漂移、部署后客户端缓存；上游失败 server 的任务会被分母口径掩盖（见 `l1-real-regression-2026-11-23.md`） |
| 产物 | 本 schema 的记录文档（如 `online-feedback-2026-11-23.md`） | `explore/baselines/l1-smoke.json`、`docs/eval/scorecard-*`、`docs/eval/l1-smoke.json` |

**关键认知**：两者是同一次「人在真实窗口里做一件事」的两种观测。L1/G6 能把网关
行为做成可重跑的回归网；在线反馈能抓到 runner 永远构造不出来的真实症状（例如
`fileResult(r).content` 把下载提示混进正文、旧会话 `unknown_tool`）。哪一边缺了，
这条时间线就只剩一半。

---

## 2. 如何同任务 / 同时间线对照

对照必须靠**显式锚点**，不许靠时间戳猜测、不许靠工具名/提示词硬凑
（与 `scripts/join-online-offline.mjs` 的原则一致）：

1. **时间窗**：在线反馈记录 `time.window`（`from`/`to`，ISO-8601 UTC）；把它与
   同一天的 L1 real run / scorecard 时间窗并列（例如
   `docs/eval/scorecard-2026-11-22.json` 的全天 20 条）。
2. **任务锚点**：优先 `session/task.taskId` 或 `session/task.windowId`；没有就写
   `unknown`，不要从 prompt 猜。session 标记见 `docs/eval/session-marker-2026-11-23.md`。
3. **证据锚点**：每条 feedback item 尽量带 `requestIds[]` + 时间戳；能回到 R2
   `capture/<date>/<requestId>.json.gz` 的才算 `evidence.captureVerified=true`。
   对不上就写 `requestIds:["unknown"]`，`captureVerified:false`，**不编造 UUID**。
4. **PR 锚点**：用户给的 PR 号（`PR #53/#56/#57`）作为外部事实记录，但要在
   `offline.comparison` 里标明其代码状态（代码层已修 / 待部署验证）。PR 链接
   本身不等于网关 capture 证据。
5. **不可比项明确列出**：在线一个 HTTP request ≠ L1 一个 task；不能把在线
   `durationMs` 与 L1 `p95LatencyMs` 比，不能把 capture `response.bytes` 换算成
   `tokensPerTask`。这些写进 `offline.comparison.notComparable`。
6. **对照产物**：把匹配/未匹配结果写进 `offline.comparison.linked`，其中
   `status` 只能是 `unverified | confirmed | fixed | wontfix`；未匹配的项写
   `reason`（如 `no-request-id`、`no-runner-task`），不要用 `confirmed` 冒充已验证。

---

## 3. `online-feedback.v1` JSON schema

以下为权威 schema（JSON Schema draft-07 风格描述；脚本按同等规则做运行时校验）。

```jsonc
{
  "schema": "online-feedback.v1",
  "time": {
    "recordedAt": "2026-11-23T09:02:17+08:00",   // 必填；记录生成时间（ISO-8601）
    "window": {
      "from": "2026-11-23T00:00:00Z",              // 必填；反馈覆盖窗口起（ISO-8601 UTC）
      "to":   "2026-11-23T23:59:59Z"               // 必填；窗口止
    }
  },
  "platform": {
    "name": "gemini",       // 必填；闭合集合 gemini|chatgpt|claude|unknown
    "surface": "web",       // 可选；web|cli|api|unknown
    "clientInfo": "Gemini/1.0.0" // 可选；来自 initialize.params.clientInfo
  },
  "project": {
    "repo": "Bruce-Yii/gemini-mcp-gateway",  // 必填；owner/repo
    "keys": ["github:Bruce-Yii/gemini-mcp-gateway"] // 可选；project-tag 显式 key
  },
  "session": {
    "sessionId": "unknown",  // 必填；Mcp-Session-Id，未知写 "unknown"
    "taskId": "unknown",     // 必填；显式 taskId，未知写 "unknown"
    "windowId": "unknown"    // 可选；capture-digest 聚类窗口
  },
  "feedback": [
    {
      "id": "F1",                       // 必填；记录内唯一
      "severity": "P0",                 // 必填；P0|P1|P2
      "category": "result-shape",       // 必填；短 slug
      "symptom": "...",                 // 必填；用户可见症状
      "evidence": {                     // 必填对象
        "source": "user-report",        // 必填；user-report|pr|capture|log
        "detail": "...",                // 必填；具体证据文本
        "captureVerified": false,       // 必填布尔；是否能回原始 capture
        "pr": [53, 56, 57]              // 可选；整数数组，PR 号
      },
      "reproduction": "...",            // 必填；如何复现（无法复现写明确原因）
      "requestIds": ["unknown"],        // 必填；UUID 或 "unknown"
      "status": "unverified"            // 必填；unverified|confirmed|fixed|wontfix
    }
  ],
  "offline": {
    "comparison": {
      "linked": [
        {
          "feedbackId": "F1",
          "taskId": "unknown",
          "requestId": "unknown",
          "status": "unverified",       // 同 status 枚举
          "reason": "no-request-id"     // 可选；未匹配原因
        }
      ],
      "notComparable": ["tokens/task vs response.bytes"],
      "baselineRefs": ["explore/baselines/l1-smoke.json"]
    }
  },
  "status": "unverified"                // 整批状态；同枚举
}
```

### 3.1 字段规则（脚本硬校验）

- 必填：`schema`、`time.recordedAt`、`time.window.from/to`、`platform.name`、
  `project.repo`、`session.sessionId`、`session.taskId`、`feedback`（≥1 项）、
  `offline.comparison`、`status`。
- `schema` 必须**恰好**为 `online-feedback.v1`。
- `severity` ∈ `P0 | P1 | P2`，大小写敏感。
- `status` ∈ `unverified | confirmed | fixed | wontfix`。
- `platform.name` ∈ `gemini | chatgpt | claude | unknown`。
- `requestIds[]`：每项要么是规范 UUID
  （`[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`，大小写不敏感），
  要么是字符串 `unknown`。**空数组非法**；对不上的一律写 `["unknown"]`。
- `evidence.pr[]`：每项为正整数（PR 号），或字符串 `#53` / `PR #53` / `pull/53`
  形式（解析成整数 53）。其它形式非法。`pr` 可省略或为空数组。
- `evidence.detail` 非空；`symptom`、`reproduction` 非空（不允许「见上」之外的
  纯空白占位）。
- 缺 `evidence`、空 `feedback`、非法 severity/status/UUID/PR 格式 → 校验失败，
  脚本以非零退出码 + stderr 错误列表返回，**不输出半截记录**。

### 3.2 输入格式

`record-online-feedback.mjs` 接受两种输入：

1. **JSON 文件**（扩展名 `.json`）：直接按 schema 校验。
2. **Markdown 文件**（扩展名 `.md`）：解析以 `## F<n>` / `### F<n>` 开头的
   小节，从小节里读取 `Severity:` / `Category:` / `Symptom:` / `Evidence:`
   / `Reproduction:` / `RequestIds:` / `PR:` / `Status:` 形式的 `Key: value`
   行（`PR:` 可多行累积；`Evidence:` 支持随后缩进的 `Detail:`/`CaptureVerified:`
   子键，也支持 `Evidence: <text>` 简写）。顶层元数据从 `Recorded-at:` /
   `Window:` / `Platform:` / `Repo:` / `Session:` / `Task:` / `Status:` 行读取。

脚本是**纯函数式**的：`parseInput(text, filename)`、`validateRecord(record)`、
`toJson(record)` 都是确定性的；同一输入两次调用输出逐字节一致
（键顺序固定、数组不改序、不写入当前时间）。

---

## 4. 记录流程（后续每次在线反馈照此办理）

1. **收集**：在真实窗口结束后，把用户原话、PR 号、截图/日志、可见的 requestId
   汇总；能拿 capture 的就用 `scripts/capture-digest.mjs` 导出对应 requestId 的
   脱敏片段，拿不到就写 `unknown`。
2. **落记录**：按本 schema 新增 `docs/eval/online-feedback-<date>.md`，逐条给
   severity / category / symptom / evidence / reproduction / requestIds / PR /
   status；初始 `status` 一律 `unverified`。
3. **本地校验**：`node scripts/record-online-feedback.mjs docs/eval/online-feedback-<date>.md > work/online-feedback.json`
   （stdout 为确定性 JSON，不写入仓库）。校验失败则补证据/格式，**不猜字段**。
4. **对照**：用 `time.window` + `session/task` + `requestIds` 与同日 L1/G6 run
   对照，填 `offline.comparison.linked` 与 `notComparable`；无法关联写 reason。
5. **定状态（由人/lead 决定，不由模型自动决定）**：
   - `confirmed`：能在本地用同一 code/args/fixture 复现，或有 capture/PR 直接证据；
   - `fixed`：已有确定性回归测试 + 相关测试通过，且修复批次可指名；
   - `wontfix`：明确记录理由（例如客户端行为、非网关责任）；
   - `unverified`：证据不足，**保持原状，不行动**。
6. **台账**：新增/更新 `docs/ledger/batch-XX-online-eval.md`，写清哪些已修、
   哪些待复现、哪些等部署验证；不把「用户说了」当成「已修」。
7. **禁止**：不根据本报告直接改 `src/`、开 PR、合并、部署；需要修复时走正常
   「先写确定性回归测试 → 修 → L1 smoke/定向测试」流程。

---

## 5. 本次（2026-11-23）的落位

- 记录：`docs/eval/online-feedback-2026-11-23.md`（按本 schema 写，保留
  PR #53/#56/#57 证据；无 requestId 的项写 `unknown`）。
- 工具：`scripts/record-online-feedback.mjs` + `tests/online-feedback.test.js`。
- 台账：`docs/ledger/batch-15-online-eval.md`（复现/已修/待部署验证清单）。

> 本流程不替代 L1/G6；它让「用户主动反馈」这条线上证据第一次拥有和半在线
> 评测同样的结构、锚点与状态机，从而能在同一任务/时间线上并排看。

---

## 6. 索引补记：2026-11-23 Gemini 在线反馈（`online-feedback.v1`）

> 仅追加索引说明；上文 schema / 流程 / 状态机不变。

- **新记录**：[`online-feedback-2026-11-23-gemini.md`](./online-feedback-2026-11-23-gemini.md)
  —— Gemini 客户端真实任务的在线反馈（正面 3 项 + 问题 F1–F6），按本文件 schema 记录，
  并与 [`SEMI-ONLINE-GAPS.md`](./SEMI-ONLINE-GAPS.md) 做缺口映射。
- **来源边界**：该批反馈全部来自**生产旧构建**；P0 修复（F1/F2）代码层已落地但**未部署**，
  因此**不能断言现网仍存在 F1–F6**。代码层已修项状态标 `待部署验证` / `fixed 代码层`，
  须等部署窗口在线复验后才可升级。
- **状态词补充**：本记录在本 schema 的 `unverified|confirmed|fixed|wontfix` 之外，另用
  人可读的四态 `unknown` / `fixed 代码层` / `待部署验证` / `needs-repro` 表达部署未落地与
  复现需求；二者不混用——脚本输出的 `status` 仍按 §3.1 枚举，不编造 requestId。
- **不变量保护**：用户正面反馈（批处理省上下文、读写隔离、高频动作封装）作为设计不变量
  纳入回归保护，不需要修复或部署动作。
- **批次归属**：任务声明 F1/F2 由 `codemode-ergonomics` 批次修复；本仓库 checkout 暂无同名
  批次文档，归属仅按任务声明登记，待 lead 核实，不虚构 PR/提交/文件内容。
- **本批只写文档**：不改 `src/`、`scripts/`、`tests/`、README、其它 docs、workflows；
  不 commit / push / deploy。
