# Batch 11 · 项目/仓库作为 capture 的一等派生标签（2026-11-23）

> 范围：只写 `src/project-tag.js`（新增）、`src/capture.js`（仅新增 envelope 字段/调用）、
> `tests/project-tag.test.js`（新增）、本台账。**未改** `src/codemode.js`、`src/server.js`、
> `scripts/`、其他 `tests/`、`README`、`CHANGELOG`、`.github/workflows/`。
> **未 commit / push / deploy**；改动全部留在工作区。

## 一、问题与目标

同一项目的多个 Gemini 窗口经常分属不同 MCP session，而一个 session 也可能跨多个仓库：
`sessionId` 边界不可靠，无法回答"这个请求是关于哪个项目的"。
`docs/eval/online-offline-join-2026-11-22.md` 的真实窗口里，`05d1b10d` / `0a099ec7`
两次 `execute_read` 读的是 `Bruce-Yii/recruitment-agent`，而网关自身是
`Bruce-Yii/gemini-mcp-gateway`。仅靠 sessionId / 时间窗会把同一项目的多窗口拆开，
也会把不同项目的请求混在一起。

本批把**请求里显式出现的仓库**派生为稳定标签 `github:<owner>/<repo>`，写入 capture
envelope 的两个新字段，让后续聚合可以按项目接力，而不信任 session 边界。

## 二、实现（纯函数，request-only）

`src/project-tag.js` 导出 `extractProjects(request)`：

```js
extractProjects(request) -> {
  projects: [{ server, owner, repo, key, confidence, source }],
  primaryProject: { server, owner, repo, key, confidence, source } | null
}
```

输入接受三形态：带 `__gatewayRawBody` 的 request 对象（字符串或已解析 body）、
MCP JSON-RPC body 字符串、已解析的 body 对象。**只处理 `method === 'tools/call'`**；
其他方法（initialize / tools/list / 通知 / GET / 非 JSON）返回空结果。

约束（与 AGENTS.md 一致）：

- **不调用模型、不联网、不解析上游结果**。只读取请求体本身。
- `owner` / `repo` 必须来自**显式字段或代码**：`params.arguments.owner/repo`、
  code 字符串里的 `owner: "..."` / `repo: "..."`，或 PR URL
  `github.com/<owner>/<repo>/pull/<n>`。**不从自然语言猜仓库名**。
- 没有 repo 就返回 `{ projects: [], primaryProject: null }`，不伪造。
- 同一请求多标签按 `key` 去重；保留首次出现的元数据，若同一 key 后来以更高优先级
  来源出现，则升级该标签的来源/置信度。

### 2.1 抽取规则与置信度

| 来源 `source` | 置信度 | 规则 |
|---|---|---|
| `tool-args` | `high` | `params.arguments` 同时有合法的 `owner` 与 `repo` 字符串字段 |
| `code-literal` | `medium` | code 字符串内成对的 `owner:`/`repo:`（或 `owner=`/`repo=`，支持单双引号与反引号）；**只有 repo 没有 owner 时丢弃** |
| `pr-url` | `medium` | `github.com/<owner>/<repo>/pull/<数字>`（可带 https:// 与 www.），server 固定为 `github` |

- 只检查 `params.arguments` 中 `code` / `script` / `source` 字段（以及 `arguments.input`
  下的同名字段），避免把任意对象当代码。body 长度上限 1,000,000 字符，超过不解析。
- owner/repo 校验为 GitHub 风格标识 `[A-Za-z0-9_.-]{1,100}`（排除 `.`/`..`），
  不做小写化，显式值原样保留。
- `server` 来自 `params.name` 的 `github__` 前缀或 code 中出现的 `github__...(` 调用；
  PR URL 自带 server；无法判定时为 `null`。**不把未知 server 猜成 github**。
- 位置参数形式（如 `github__get_file_contents("owner", "repo", path)`）不抽取：
  参数位置没有明确语义，猜就是伪造。这是已知误报/漏报边界，见第五节。

### 2.2 primaryProject 选择

1. 有 `tool-args` 标签时：在显式标签中选**出现次数最多**的；并列时按首次出现顺序。
2. 没有显式标签时：按来源优先级（`code-literal` 先于 `pr-url`）取第一个。
3. 完全没有仓库证据时：`null`。

"工具调用参数优先于 code 字符串"既体现在 dedupe 的来源升级，也体现在 primary
一定优先选显式标签——即使 code 里另一个 repo 出现次数更多。

## 三、envelope 接入（additive）

`src/capture.js` 在 `res.end` 构建 envelope 时调用 `extractProjects`，把两个字段展开到
顶层：

```json
{
  "schema": "gmg.capture.v1",
  "requestId": "...",
  "projects": [
    {"server":"github","owner":"Bruce-Yii","repo":"recruitment-agent",
     "key":"github:Bruce-Yii/recruitment-agent","confidence":"high","source":"tool-args"}
  ],
  "primaryProject": { "...": "与上面同形状；无 repo 时为 null" }
}
```

- 旧字段（`schema`/`ts`/`request`/`events`/`response`/`model`/`sessionId` 等）一字不改；
  捕捉语义（字节记录、overflow、sink、ack/done/skipped）不变。
- 抽取失败或 body 为空时回退 `{ projects: [], primaryProject: null }`，**绝不让 tag 逻辑
  使 capture 失败**。capture 被 disabled / skipped 时不写 envelope，因此也不强行加字段。
- 本次未改 `scripts/capture-digest.mjs` 等聚合脚本；下游如何消费这两个字段由另行任务处理。

## 四、误报边界（明确不做的事）

| 信号 | 处理 | 原因 |
|---|---|---|
| 自然语言里的仓库名（"fix bug in recruitment-agent"） | 不抽取 | 用户描述不是结构化证据，会大量误报 |
| code 里只有 `repo: "x"` 没有 `owner` | 丢弃 | 无法确定 owner，不能拼出合法 key |
| code 里的位置参数 `f("owner","repo")` | 不抽取 | 参数位置无语义；猜即伪造 |
| `github.com/o/r` 非 pull URL（普通链接/issue） | 不抽取 | 规则只覆盖显式 PR URL；避免把任意链接当项目 |
| 上游返回内容里的 owner/repo | 不读取 | 硬规则：不解析上游结果 |
| `tools/list` 工具描述里的仓库示例 | 不抽取 | 非 `tools/call` 请求 |
| 同一 key 多次出现 | 去重，只留一个标签 | 避免聚合重复计数；出现次数只用于 primary |
| 无证据请求 | `projects=[]`, `primaryProject=null` | 不伪造标签 |

`confidence` 只是来源分类（显式字段 vs 代码/URL），**不是"这个标签一定正确"的概率**；
按 AGENTS.md，任何基于标签的自动结论都必须回到 requestId 人工复核。

## 五、如何回到 requestId 重算

每个 envelope 自带 `requestId` 和完整的 `request.raw`，标签可由原始请求确定性重算：

1. 从聚合结果取 `requestId`（例如 `05d1b10d-9909-42fb-b28c-5a02959dffdb`）。
2. 取原始 envelope：
   - R2：`R2_ACCOUNT_ID=... R2_BUCKET=... node -e "import('./scripts/capture-digest.mjs').then(m=>m.readR2Envelope('capture/2026-11-22/<requestId>.json.gz')).then(e=>console.log(JSON.stringify(e,null,2)))"`
   - 本地：`work/capture/<ts>-<requestId>.json` 直接读取。
3. 核对 `envelope.request.raw` 的 `method`、`params.name`、`params.arguments`；
   **只看请求，不看 response / events**。
4. 本地重算（与线上同一份代码）：
   ```
   node --input-type=module -e "import {extractProjects} from './src/project-tag.js'; import {readFileSync} from 'node:fs'; const e=JSON.parse(readFileSync('work/capture/<file>.json','utf8')); console.log(JSON.stringify(extractProjects({__gatewayRawBody:e.request.raw}),null,2));"
   ```
   对比 `projects` / `primaryProject` 与落盘字段；不一致说明输入 body 或代码版本不同，
   不要归因于随机性——该函数是纯函数且确定性的。
5. 若要验证某个仓库的实际操作，仍须用同一 code/args/fixtures 在
   `harness/fake-upstream.mjs` 上回放，并先写确定性回归测试（AGENTS.md 硬规则）。

## 六、验证

- 新增 `tests/project-tag.test.js`，**20 个用例全绿**：
  真实 capture fixture（`Bruce-Yii/recruitment-agent` 的 code literal / 显式字段、
  `Bruce-Yii/gemini-mcp-gateway` 的 PR URL + code 去重）、多 repo、单 repo 去重、
  primary 选择、显式字段优先、PR URL（带/不带协议）、单引号/赋值式、
  孤立的 repo 无 owner 丢弃、空 body / 非 JSON / 非 tools/call、
  无 repo 不伪造、自然语言不猜、纯函数确定性、envelope additive 字段、
  capture disabled/skip 不强行加字段。
- 全量 `npm test` 已运行并通过；若并发改动导致其他文件失败，以本批 20 个用例为准。
- **未 commit / push / deploy**。

## 七、残留与后续

- 真实历史 capture 里 guest code 常用位置参数调用 `github__get_file_contents("owner", ...)`；
  本批按"不猜"原则不抽取这些旧数据，因此历史 envelope 上 `projects` 多为空是预期且诚实的，
  不是缺陷。若要覆盖，需另立任务定义明确的位置参数契约并配套测试。
- 本批只在 envelope 落盘字段；digest/analyzer/join 的项目级聚合由并行任务处理。
- 标签只覆盖 GitHub；其他 server（Notion/Linear/Vercel/Figma）的"项目"概念不同，
  不硬套同一 `key` 格式。
