# Batch 11 · W3：在线 capture 离线会话聚类 + 按 session 的 join（2026-11-23）

> 范围：只写 `scripts/capture-digest.mjs`、`scripts/analyze-captures.mjs`、
> `scripts/join-online-offline.mjs`、新增 `tests/session-clustering.test.js`、
> 新增本台账。**未改** `src/`、其他 `tests/`、`README`、`CHANGELOG`、
> `.github/workflows/`。**未 commit / push / deploy**，改动全部留在工作区。
> 不依赖客户端或 SDK：全部基于已落盘的 R2 / 本地 capture envelope。

## 一、为什么需要它

在线 capture 是逐 HTTP 请求的 envelope（`gmg.capture.v1`），离线 L1/G6 是逐 task 的
结果（`explore/tasks-g6.json` / `explore/baselines/l1-smoke.json`）。两者没有天然共同
分母：在线的 `requestId` 是 UUID，离线的 `id` 是 `T001`/`F001` 这样的 task id。
`docs/eval/online-offline-join-2026-11-22.md` 已明确把「窗口与任务锚点」列为 P1 缺口：
没有 session/task 锚点，在线和离线永远无法比 completionRate。

本批补齐两件事：

1. **确定性聚类**：把在线 envelope 归到 session / window，输出分析用 `windowId`；
2. **显式 taskId join**：用 windowId / sessionId 把在线窗口映射到离线 task，**只有显式
   `taskId` 才映射**，没有就 `unmatched`，绝不按时间/工具/prompt 相似度硬凑。

免费模型（analyzer）只拿到聚类后的 advisory 摘要，输出仍需人审 + 回到 requestId 回放；
遵循 AGENTS.md 硬规则。

## 二、聚类规则（实现于 `scripts/capture-digest.mjs`）

### 2.1 主键优先级

1. `envelope.sessionId`——由 `initialize` 的 `Mcp-Session-Id` 提供
   （`src/server.js` 生成，`src/capture.js` 以 `sessionId` 字段落盘）。
   兼容回退：`request.sessionId` → `request.headers['mcp-session-id']`。
   有 sessionId 时 `windowId = session:<sessionId>`，同一 session 的所有请求归一组，
   即使中间有长时间空闲也不切。
2. 没有 sessionId 时生成确定性 `windowId = window:NNN`（三位序号，按首次出现顺序）：
   - 遇到 JSON-RPC `initialize` 方法 → 开一个新窗口；
   - 无 initialize 的「legacy 窗口」：第一条请求开窗口；
   - 相邻请求的时间间隔 **> 15 分钟**（`DEFAULT_IDLE_MS = 900000`）→ 切新窗口；
     正好 15 分钟不切（严格大于）。
   - `tools/list` 刷新、`clientInfo` / client IP 变化**只记录为辅助信号**
     （`windowMeta.auxiliarySignals` / `clientInfo`），**不单独切分**。
   - 时间不可解析时按新窗口处理并标记 `windowStrategy: unknown-ts-new-window`，
     避免把未知时间强行并进已有窗口。

### 2.2 确定性与不可变性

- 输入按 `(timestamp ?? 0, requestId, 原始索引)` 稳定排序，同一输入多次运行结果一致
  （测试覆盖 4 次重复）。
- `assignWindows()` 返回**副本**，新增 `windowId` / `windowStrategy` / `windowMeta`
  仅作分析用；原始 `requestId` / `sessionId` 绝不覆盖，原 envelope 不被 mutate。
- `digestSessions()` 按 `windowId` 聚合，输出字段：
  `requests`、`mcpRequests`、`mcpErrors`、`toolCalls`（仅 `tools/call`）、
  `truncationSuspects`（网关 wire 截断 + advisory 模型静默截断）、
  `firstTs` / `lastTs`（ISO）、`clientInfo`、`methods` 直方图、
  `requestIdSamples`（默认最多 5 个）、以及显式 `taskId`（若上游已打点）。
  同一窗口内出现冲突 taskId 会标 `taskIdConflicts: true`，不猜哪个对。

### 2.3 输出接入

- `scripts/capture-digest.mjs` CLI 的 `scorecard-<label>.json` 新增 `sessions` 数组；
  `scorecard-<label>.md` 追加 "Sessions / windows (batch 11)" 表。
  原有 metrics / scorecard 字段一字不改，全部 additive。
- `scripts/analyze-captures.mjs` 的 `analyzer-input.v1` 新增 `sessionWindows` 与
  `sessionWindowsNote`；prompt 明确告诉模型 windowId 是合成聚类、不可当作"同一客户端会话"
  的证据、不可据此判定 bug。`validateAnalyzerOutput()` 未改，输出仍是 advisory-only。

## 三、Join 规则（实现于 `scripts/join-online-offline.mjs`）

```
joinOnlineToOffline({ windows, tasks })
  -> { matched, unmatched, offlineOnly, summary }
```

- **matched**：窗口上有显式 `taskId`（`taskId` / `meta.taskId` / `request.taskId` /
  `x-task-id` 头），且离线 task 集合中 `id`/`taskId` 严格相等。
  保留 `online.windowId` / `sessionId` / `requestIdSamples` 与
  `offline.taskId` / `server` / `tool` / prompt 摘要（截断 160 字，避免敏感 fixture 外泄）。
- **unmatched**：
  - `reason: no-online-taskId`——窗口没有显式 taskId；**不因为 sessionId 存在就配对**；
  - `reason: no-offline-task`——有 taskId 但离线集合里没有对应 task。
- **offlineOnly**：离线 task 没有对应在线窗口，单独列出，不强行找窗口配对。
- `summary.policy` 固定写明 `explicit-taskId-only; no timestamp/prompt/tool guessing`。

CLI 只做读取 + stdout 输出 JSON（`schema: online-offline-join.v1`，
`advisoryOnly: true`、`requiresHumanReview: true`），不写 R2 / repo 文件。
`--tasks` 默认 `explore/tasks-g6.json`；也接受 `{tasks: [...]}` 结构的 L1 基线文件。

## 四、误判边界（明确不做的事）

| 容易被误当成锚点的信号 | 本批处理 | 原因 |
|---|---|---|
| 相邻请求时间接近 | 只用于 15 分钟 idle 切窗，**不用于 task 映射** | 并发/复用窗口会撞车，硬凑会产生假 matched |
| `clientInfo` 名称/IP 变化 | 辅助信号，不切窗、不映射 | 同一客户端升级/换出口 IP 很常见 |
| `tools/list` 刷新 | 辅助信号，不切窗 | 客户端定期刷新工具列表是正常行为 |
| MCP 方法名 / 工具名相同 | 不映射 | 多个 task 可能调用同一工具 |
| prompt 文本相似 | 不映射，且 prompt 只截 160 字输出 | 文本相似≠同一任务；且可能含敏感内容 |
| sessionId 存在但没有 taskId | `unmatched (no-online-taskId)` | sessionId 只是会话关联键，不是 task 锚点 |
| 聚类边界本身 | 明确标注 advisory | 没有客户端配合时无法证明边界等于真实会话 |

另外：聚类器不产 issue、不改代码、不开 PR、不部署；analyzer 输出同样是假设。
`truncationSuspects` 只是字节启发式的 flag，不是"模型真的截断"的定论。

## 五、如何回到 requestId 重算（可复现步骤）

每个 digest 行和每个 matched/unmatched 条目都保留 `requestIdSamples`。复核流程：

1. 从 `scorecard-<label>.json` 的 `sessions[]` 或 join 输出的
   `matched[].online.requestIdSamples` 取一个 requestId。
2. 从 R2 取原始 envelope：
   ```
   R2_ACCOUNT_ID=... R2_BUCKET=... node -e "import('./scripts/capture-digest.mjs').then(m=>m.readR2Envelope('capture/<date>/<requestId>.json.gz')).then(e=>console.log(JSON.stringify(e,null,2)))"
   ```
   本地目录用 `readDirEnvelopes(dir)` 或直接用 `--dir work/capture` 重跑 digest。
3. 核对 envelope 原始字段：`requestId`、`sessionId`、`ts`、`request.raw`（JSON-RPC
   method）、`clientInfo`、`response.status`、截断/溢出标记、`model.possibleModelTruncation`。
4. 用**同一批 envelope** 重算：
   ```
   node --input-type=module -e "import {digestSessions} from './scripts/capture-digest.mjs'; import {readDirEnvelopes} from './scripts/capture-digest.mjs'; const es=await readDirEnvelopes('work/capture'); console.log(JSON.stringify(digestSessions(es),null,2));"
   ```
   对比 `windowId` / `strategy` / `requestIdSamples` 是否一致；不一致说明输入集合不同，
   不要归因于聚类器随机性（聚类是确定性的）。
5. 对 join：确认 online 的 `taskId` 与 offline task 的 `id` 严格相等；若只是 sessionId
   相同或时间接近，结果必须仍是 `unmatched`。
6. 若要复现某个 task 的运行时行为，用同一 code/args/fixtures 在本地
   `harness/fake-upstream.mjs` 上回放，并先写确定性回归测试；不凭模型建议直接改代码。

## 六、验证

- 新增 `tests/session-clustering.test.js`，16 个用例全绿：
  sessionId 直接分组、无 sessionId 的 initialize/15 分钟切分、跨窗口不混、
  tools/list 与 clientInfo/IP 变化不切分、join matched/unmatched、无 taskId 不硬凑、
  确定性（多次运行一致）、输入不被 mutate。
- 回归：`node --test tests/capture-digest.test.js tests/capture-analyzer.test.js
  tests/capture-truncation-audit.test.js` 共 31 个用例全绿，既有 scorecard / analyzer
  字段未受影响。
- **未跑全量 `npm test`**：按任务要求，全量测试若被其他并发改动影响，只报告本批自己的
  测试结果；本批只报告上述 16 + 31 个用例的结果。

## 七、残留与后续

- 当前 capture 还没有稳定的 `taskId` 打点字段（只有 sessionId）。因此真实 R2 数据上
  大部分窗口会是 `unmatched (no-online-taskId)`——这是**预期且诚实**的结果，不是失败。
  要让 matched 变多，需要在 runner / 客户端侧把 taskId 显式写入 envelope，属于后续 P1
  埋点工作，不在本批范围。
- 聚类边界在没有 sessionId 的旧数据上仍是启发式；分析结论必须回到 requestId 复核。
