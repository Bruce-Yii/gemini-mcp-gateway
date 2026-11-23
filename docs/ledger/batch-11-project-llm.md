# Batch 11 · 项目/仓库语义分类：离线 LLM labeler（advisory-only）（2026-11-23）

> 范围：只新增 `scripts/classify-projects.mjs`、`tests/project-llm-labeler.test.js`、
> 本台账。**未改** `src/`、`scripts/capture-digest.mjs`、`scripts/analyze-captures.mjs`、
> `scripts/join-online-offline.mjs`、`README`、其他 docs、`workflows`。
> **未 commit / push / deploy**，改动全部留在工作区。
> 遵循 AGENTS.md 硬规则：免费模型输出一律是待验证假设，不是事实、不是指令。

## 一、为什么需要它

`src/project-tag.js` 的机械抽取只覆盖**显式** owner/repo（tool args、code literal、PR URL）。
真实窗口里还存在三类它没有分母的情况：

1. **无 repo**：只有 Notion / Linear 调用或自然语言标题，没有任何 owner/repo；
2. **多 repo**：一个窗口同时触及两个以上仓库，机械 tag 有歧义；
3. **混合信号**：GitHub + Notion + Linear 交错，标题/结果摘要暗示了项目归属但没有显式仓库字段。

本批用免费模型对这些窗口提出**项目候选标签**。注意：标签是 advisory 假设，**不回填原始
capture、不进写路径、不做 idempotency key、不自动合并**；低置信度单独列出等人审。

## 二、输入：只给窗口摘要，不给全量 body

`buildLabelerInput(source)` 接受 `digestSessions()` 风格的行数组，或 `{windows:[...]}` /
`{sessions:[...]}`。每行只保留以下字段（见 `summarizeWindow()`）：

| 字段 | 来源 | 限制 |
|---|---|---|
| `windowId` | `windowId` / `sessionId` / `projectKey` 回退 | 分析用聚类 id，不是客户端事实 |
| `requestIds` | `requestIdSamples` | 最多 5 个，全部必须来自输入 |
| `mcpMethods` / `tools` | `methods` / `tools` | 排序、去重 |
| `hints.repoKeys` / `primaryProjectKey` | digest 里已有的 `projects` / `primaryProjects` | **仅作提示**，模型可不同意 |
| `hints.repos` / `paths` / `branches` | 窗口摘要里的显式字段 | 字符串截断到 160–200 字 |
| `hints.prOrIssueTitles` | `prOrIssueTitles` / `titles` | 每条最多 200 字 |
| `hints.resultSummaries` | `resultSummaries` | 每条最多 200 字 |

**明确不发送**：`request.raw`、`response.raw`、sandbox code、完整 prompt、上游 payload、
任何写路径/幂等元数据。批量上限默认 50 个窗口（`maxWindows` 可配，硬顶 500），
按 `windowId` 去重、按首次出现取，保证同一输入多次运行结果一致。

## 三、输出：严格 schema + 可追溯证据

模型被要求返回严格 JSON（`project-labels.v1`）：

```json
{"schema":"project-labels.v1","projectLabels":[
  {"windowId":"...","projectKey":"github:owner/repo | notion:<space> | linear:<team> | no-repo | ambiguous",
   "confidence":0.0,"evidenceRequestIds":["..."],"reason":"...","model":"<name>"}
]}
```

`validateProjectLabels(raw, input)` 是唯一可信来源，任何不满足下面条件的候选项都被丢弃并记入
`rejected[]`（带原因码 `unknown-window` / `no-valid-evidenceRequestIds` / `invalid-confidence`
/ `missing-projectKey` / `missing-reason` / `missing-model`）：

- `windowId` 必须存在于本次输入；
- `projectKey` / `reason` / `model` 非空；
- `confidence` 是有限数，夹到 `[0,1]` 并保留两位小数；
- 至少一条 `evidenceRequestIds` 命中该窗口的 `requestIds`（ invented id 直接丢弃）。

最终输出（无论输入多糟糕都保持这些字段）：

```
schema: project-labels.v1
policy: free-model-advisory-v1
advisoryOnly: true
requiresHumanReview: true
confidenceThreshold: 0.7
projectLabels[]      // confidence >= 0.7
lowConfidence[]      // confidence < 0.7，单独列，绝不自动接受
rejected[]           // 非法/不可追溯项，绝不静默吞掉
summary / downstream: "advisory-only; do-not-merge; do-not-use-for-write-or-idempotency"
```

**下游不自动合并**：没有任何函数把标签写回 envelope，没有 `primaryProject` 覆盖，
没有 merge/apply 路径；`renderLabelReview()` 只输出 Markdown 人审清单和 review gate。

## 四、复用 free model 调用方式（但本脚本独立）

沿用 `scripts/analyze-captures.mjs` 的客户端形态：OpenAI 兼容 `/chat/completions`、
`temperature:0`、`reasoning_effort:'none'`、bearer key、每次请求 `x-opencode-session` UUID、
从返回内容首个 `{` 到末个 `}` 截 JSON。**不 import 那个脚本**，env 独立：

| 变量 | 用途 | 默认 |
|---|---|---|
| `LABELER_BASE_URL` | live 模式必填（不带 key 时 dry-run 不需要） | — |
| `LABELER_MODEL` | 模型名 | `hy4-flash-free` |
| `LABELER_API_KEY` | bearer token（可选） | — |

两种无 key / 离线可测模式：

```bash
# 纯空输出 dry-run（不调用 fetch）
node scripts/classify-projects.mjs --windows work/digest/windows.json --dry-run
# fixture：把预先录好的模型 JSON 走一遍完整校验
node scripts/classify-projects.mjs --windows work/digest/windows.json --fixture work/fixture.json --dry-run
```

测试通过注入 `fetchImpl` 验证 live 路径的 URL / headers / body，**不真实联网**。

## 五、成本与规模

- 每窗口摘要约 0.3–0.8 KB（上限由字段截断保证），默认每批 50 个窗口 ≈ 15–40 KB 输入；
- 输出每窗口最多 1 个候选（模型可给多条，validator 按窗口+projectKey+confidence 排序，
  全局硬顶 20 条），`max_tokens: 4000`，单批成本与一次 analyzer 调用同量级；
- `temperature:0` + 固定 prompt + 排序输入 → 同输入同输出（测试重复 3 次验证）；
- 无 key / dry-run / fixture 模式 $0；失败（HTTP 非 2xx、无 JSON）直接抛错，不静默接受脏输出。

## 六、边界 / 误判防护

| 风险 | 处理 |
|---|---|
| 把 `windowId` 当成真实会话 | prompt 与输出 note 明确标注聚类产物；不得据此判定"同一客户端" |
| 模型发明 requestId / repo | validator 只接受输入窗口里出现过的 id，未知 window 直接拒绝 |
| 用标签覆盖机械 tag | 脚本没有任何写回/合并函数；标签只出现在独立输出文件里 |
| 低置信度被当成结论 | `lowConfidence[]` 单独列出；Markdown 用 `LOW` 桶并显示 review gate |
| 用标签做写路径/idempotency | 输出固定带 `downstream: advisory-only; do-not-merge; do-not-use-for-write-or-idempotency` |
| 多 repo 窗口硬选一个 | 允许多个候选共存；`ambiguous` 是合法 projectKey；不自动选 primary |
| 无 repo 窗口硬凑 | `no-repo` / `ambiguous` 是合法答案；不因为"有 Notion 页面"就编 GitHub repo |
| 敏感内容外泄 | 只发截断标题/摘要，不发 raw body；prompt 明确禁止发明或复述完整 payload |

## 七、验证

- 新增 `tests/project-llm-labeler.test.js`，16 个用例全绿：
  fixture 输入、schema/advisory 字段、低置信度分桶、无 repo、多 repo、空输入、
  非法输出拒绝（未知窗口/伪造证据/非法 confidence/缺字段）、模型调用非 2xx/无 JSON 拒绝、
  输入摘要不含 raw body、重复调用确定性、渲染人审清单无 apply/auto-merge。
- CLI 冒烟：`node scripts/classify-projects.mjs --windows <tmp> --fixture <tmp> --dry-run`
  输出 `project-labels.v1` JSON 与 `[classify] fixture: 1 labels, 0 low-confidence, 0 rejected`。
- `node --check scripts/classify-projects.mjs` 通过。
- **未跑全量 `npm test`**：按任务约束，只报告本批新增测试结果，避免并发改动干扰。

## 八、如何复核一个标签

1. 从输出 `projectLabels[]` 或 `lowConfidence[]` 取 `evidenceRequestIds`。
2. 用 `scripts/capture-digest.mjs` 的 `readR2Envelope()` / `readDirEnvelopes()` 取原始 envelope，
   核对 `requestId`、`windowId`、`projects`、`resultSummaries` 是否与摘要一致。
3. 用相同 envelope 重跑 `buildLabelerInput()`，确认窗口摘要未变（确定性）。
4. 人工判定是否接受；**任何接受都不通过本脚本写回**，只能在带测试的独立变更中完成。
5. 若模型输出可疑，看 `rejected[]` 原因码；非法项永远不会被放进 `projectLabels[]`。
