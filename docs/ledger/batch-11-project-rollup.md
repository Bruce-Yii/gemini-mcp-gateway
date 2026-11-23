# Batch 11 · 项目级聚合（digest / analyzer / join）（2026-11-23）

> 范围：只写 `scripts/capture-digest.mjs`、`scripts/analyze-captures.mjs`、
> `scripts/join-online-offline.mjs`、新增 `tests/project-rollup.test.js`、
> 新增本台账。**未改** `src/`、其他 `scripts/`、其他 `tests/`、`README`、
> `CHANGELOG`、`.github/workflows/`。**未 commit / push / deploy**，改动全部
> 留在工作区。
>
> 依赖：另一个 agent 在 `src/capture.js` / `src/project-tag.js` 落盘的
> `projects[]` / `primaryProject` 字段（纯函数 `extractProjects()`）。本批按该
> envelope 契约实现，并对旧 envelope 做确定性回退兼容。

## 一、背景与目标

在线 capture 是逐 HTTP 请求的 envelope；session/window 聚类解决了「哪些请求属于
同一次会话」，但会话边界不可靠：一个 Gemini 窗口可能跨会话恢复，一个会话也可能
碰多个仓库。`src/project-tag.js` 从**请求本身**确定性地抽取 `github:<owner>/<repo>`
标签，给每条 capture 打上项目维度。本批把该标签接进三处离线分析：

1. **digest**：生成 `byProject` 聚合与跨 session 的 `projectTimelines`；
2. **analyzer**：把项目视图作为 advisory 输入，prompt 明确「project 是派生标签」；
3. **join**：允许按 `projectKey` 做显式匹配，但显式 `taskId` 优先，无字段即
   `unmatched`，绝不硬凑。

## 二、envelope 契约（来自 project-tag-core，本批只读消费）

```js
envelope.projects: Array<{
  server: string | null,   // 'github' 或 null（网关工具无 server）
  owner: string,
  repo: string,
  key: string,             // `github:<owner>/<repo>`
  confidence: 'high' | 'medium',
  source: 'tool-args' | 'code-literal' | 'pr-url'
}>
envelope.primaryProject: 同形状对象 | null
```

- 顶层字段是 additive；旧 envelope 没有这两个字段。
- `extractProjects()` 只从显式 `owner`/`repo` 参数、代码字面量里的成对
  `owner:`/`repo:`、以及 PR URL 抽取；自然语言里的仓库名**不算**。
- 去重按 `key` 精确匹配；同一 key 多次出现时，primary 选择遵循
  「显式 tool-args 优先 → 出现次数最多 → 首次出现」。

## 三、旧 envelope 兼容（确定性回退，不用模型）

`capture-digest.mjs` 通过 `createRequire` **懒加载** `../src/project-tag.js` 的
`extractProjects()`，对缺字段的旧 envelope 调用：

```js
extractProjects({ __gatewayRawBody: envelope.request.raw })
```

这样新旧兼容共用**同一套抽取规则**，不存在两套正则漂移。若模块尚未落盘（并发开发
场景）或加载失败，则使用一个内置的极简确定性 fallback：仅接受 JSON-RPC
`params.arguments` 中成对的 `owner`+`repo`、同一 code 字面量中的成对键、以及
`github.com/<owner>/<repo>` URL；自然语言/工具名/时间一律不抽。`fallback` 只在
canonical 模块不可用时生效，模块落盘后自动切回 canonical，无需改代码。

**规则要点**：

- 没有 project 标签的请求不会进入任何 `byProject` 桶，也不会出现在
  `projectTimelines`；
- 一个请求带多个标签时，**每个标签独立计数**（同一请求可同时属于两个 project 桶）；
- `primaryProject` 只用于 `primaryProjectRequests` 归因计数，不影响多标签计数。

## 四、digest 新增字段

### 4.1 `byProject`（metrics 中的键控对象，JSON 顶层亦有）

每个 key 一行，字段：

| 字段 | 含义 |
|---|---|
| `key` | `github:<owner>/<repo>` |
| `requests` | 携带该标签的请求数（多标签请求每标签各计一次） |
| `mcpRequests` | 其中 MCP JSON-RPC 请求数 |
| `errors` | HTTP ≥ 400 或 wire `isError:true` 的请求数 |
| `toolCalls` | `tools/call` 方法数 |
| `truncationSuspects` | gateway wire 截断 + advisory 模型静默截断 |
| `firstTs` / `lastTs` | 该项目的首末时间（ISO，来自 envelope.ts） |
| `sessionIds` | 该项目出现过的 sessionId 去重列表（按时间排序） |
| `requestIdSamples` | 最多 5 个 requestId，供 R2 回放 |

### 4.2 `projectTimelines`

按 `(projectKey, sessionId)` 分组的时间线行。同一个 project 出现在多个 session
时产生多行，**按 firstTs 排序**，从而把 handoff 显式展示出来，而不是在 `byProject`
里被压平。每行额外带 `primaryProjectRequests`，用于区分「这个 session 是否把该项目
当作主项目」。

### 4.3 `sessions[]` 与 MD

- 每个 session/window 行新增 `projects[]`（带每个标签的 `requests` 计数）与
  `primaryProjects[]`（主项目 key 列表）；
- `scorecard-<label>.md` 新增 **Projects** 表；`renderProjectTimelines()` 生成
  **Project timelines** 表，追加在 Sessions 表之后；
- `scorecard-<label>.json` 顶层新增 `byProject` / `projectTimelines`，
  `sessions[]` 内每个行含 projects 汇总。所有旧字段保持原样（additive only）。

## 五、analyzer 新增字段

`analyzer-input.v1` 新增（全部 advisory-only，validator 不改）：

- `projectWindows`：`projectTimelines` 原样透传；
- `projectSummary`：`projects` / `requestsWithProjects` / `multiProjectSessions` /
  `handoffProjects` 四个确定性计数；
- `projectNote`：写入 prompt，明确 **project 是 capture 时确定性抽取的派生标签，不是
  客户端声明或已验证的仓库身份**；一个请求可多标签，一个项目可跨多 session；共享
  project key 不代表同一客户端/任务/根因；必须回 `requestIdSamples` 回放。

`validateAnalyzerOutput()` **一字未改**：模型输出仍是待验证假设，evidence 必须命中
既有白名单，不因新增字段获得任何自动行动能力。

## 六、join 规则

`joinOnlineToOffline({ windows, tasks })` 的匹配优先级：

1. **显式 taskId**：行为完全不变（`taskId` / `meta.taskId` / `request.taskId` /
   `x-task-id` 头）。若 taskId 存在但离线无对应 task → `unmatched(no-offline-task)`。
2. **显式 projectKey**（新增）：当窗口没有 taskId 时，读 `projects[].key` /
   `primaryProject.key` / `projectKeys`；离线 task 读 `projectKey` / `project.key` /
   `repo`（`owner/name` 形式）/ `owner`+`repo`。**严格字符串相等**才 matched，
   `matchBy: 'projectKey'`。
3. **无锚点**：`unmatched(reason: 'no-online-taskId')`（保持历史 reason 字符串，不破坏
   既有调用方）。有 projectKey 但离线无匹配 → `unmatched(no-offline-task)`，
   `matchAttempt: 'projectKey'`。

导出辅助：`projectKeyOf(record)`、`projectKeysOfWindow(window)`。
`summary` 新增 `matchedByTaskId` / `matchedByProjectKey`；`policy` 字符串包含
`explicit-taskId-only` 子串以保持既有断言兼容，并追加 `then strict explicit projectKey`。

CLI 仍是只读 + stdout JSON，不写 R2 / repo 文件。

## 七、与 session 的关系（正交）

| 维度 | session / window | project |
|---|---|---|
| 来源 | `initialize` 的 Mcp-Session-Id 或 15 分钟 idle 聚类（合成） | capture 时从请求参数/代码字面量确定性抽取 |
| 粒度 | 一次客户端会话 | 一个仓库 |
| 多对多 | 一个 session 可跨多个 project | 一个 project 可跨多个 session（handoff） |
| 是否可当身份证据 | 否（windowId 是合成分析字段） | 否（派生标签，非客户端声明） |

因此 `byProject` **不是** `sessions[]` 的另一种分组：它刻意跨 session 合并，
同时用 `projectTimelines` 保留跨 session 的顺序信息。两者不可互相替代。

## 八、误报边界（明确不做的事）

| 容易被误当信号的 | 本批处理 | 原因 |
|---|---|---|
| prompt / 自然语言里的仓库名 | 不抽取 | 不是显式字段；模型不做解析器（AGENTS.md 硬规则） |
| 仅 `repo: "alpha"` 无 owner | 不抽取 | 缺 owner，不可唯一确定仓库 |
| code 里 `owner` 与 `repo` 不在同一片段 | 不配对 | 避免跨请求/跨变量误拼 |
| 上游返回结果里的 owner/repo | 不抽取 | 只看请求；结果可能是任意数据 |
| 相同 project key 的两个窗口 | 只是分组提示 | 不证明同一客户端、同一任务或同一根因 |
| project key 相近（`acme/alpha` vs `acme/alpha2`） | 不做前缀/模糊匹配 | join 严格相等，避免硬凑 |
| analyzer 的项目结论 | 仅假设 | 必须回 requestId 在本地复现并经人审 |

另外：本批不产 issue、不改代码、不开 PR、不部署；`truncationSuspects` 仍是
字节启发式 flag，不是定论。

## 九、验证

- 新增 `tests/project-rollup.test.js`，10 个用例全绿：
  同一 repo 跨 3 session 合并 + 时间线、一请求多标签分别计数、无 project 请求不
  污染、join taskId 优先、join projectKey matched、join unmatched 不硬凑、
  `projectKeyOf` 只接受显式字段、旧 envelope 回退兼容 + 确定性、prose 不误抽、
  analyzer 输入契约。
- 回归：`node --test tests/capture-digest.test.js tests/session-clustering.test.js
  tests/capture-analyzer.test.js` 共 33 个用例全绿，既有 scorecard / digest /
  analyzer / join 字段未受影响。
- 已确认 `src/project-tag.js` 落盘后，`createRequire` 路径自动切换到 canonical
  `extractProjects()`；回退仅在模块缺失时生效。
- **未跑全量 `npm test`**：按任务要求，全量若被并发改动影响，只报告本批自己的测试
  结果；本批只报告上述 10 + 33 个用例。

## 十、残留与后续

- 真实 R2 历史数据里大部分旧 envelope 没有 `projects[]`，回退只能覆盖显式
  `owner`/`repo` 参数的请求；代码字面量/PR URL 的覆盖取决于 canonical extractor
  在回退路径的可用性（模块落盘后自动可用）。
- `projectKey` join 依赖离线 task 文件里显式写 `projectKey`/`repo` 字段；当前
  `explore/tasks-g6.json` 多数字段缺失，结果大多是 `unmatched`——这是**预期且诚实**
  的结果，不是失败。要让 matched 变多，需要在离线 task 生成侧补项目字段，属于后续
  工作，不在本批范围。
