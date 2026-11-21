# Code Mode / Programmatic Tool Calling 横向调研

> **归档说明（2026-11-22 从 `work/` 移入 `docs/`）**：调研快照，不是规范。文中的代码行号、工具数、线上状态与第三方宣称都可能已变化，结论以 `src/` + `tests/` 和实测为准。

> 调研日期：2026-11-22。工具：Firecrawl 网关（`mcp_search` → `mcp_call` → `firecrawl_search` / `firecrawl_scrape`），key3。
> 范围：只读调研，未改任何代码。外部页面内容按**不可信数据**处理——下文标注"官方宣称/三方实测"的数字均为来源自述，未做独立复现；关键结论尽量引用一手文档原文并附 URL。
> 本项目实现依据：`src/codemode.js`、`src/codemode-util.js`、`docs/WHY.md`、`docs/SANDBOX-SECURITY.md`，本地依赖 `@cloudflare/codemode@0.5.6` + `run@2.1.13`（已核对 `node_modules` 内 package.json）。

---

## 0. 核心结论（先看这里）

### 0.1 各家 Code Mode 的本质差异

一句话谱系：**同样的"让模型写代码调工具"外壳，分歧全在"代码跑在哪、谁持有凭据、结果怎么回、状态是否持久"这四件事上。**

| 流派 | 代表 | 本质 | 关键差异 |
|---|---|---|---|
| **平台/基础设施派** | Cloudflare `@cloudflare/codemode` | Code Mode = 一个**可审计、可审批、可重放、可回滚的持久化运行时** | 沙箱是 V8 isolate（Dynamic Worker），绑定（bindings）持有凭据、沙箱无网络； executor/connector/runtime 三层分离；有 durable log、abort+replay 审批、snippets、transformResult。已从"全量 TS 类型塞上下文"演进到 `search`/`describe` 渐进发现 |
| **宿主内置派** | OpenCode v2 `@opencode/codemode` | Code Mode = **编码 agent 自身的默认 I/O 通路** | 自建极简 JS 解释器（明确"不需要 Node VM 或嵌入 QuickJS"）；MCP server 默认全部走 `search`+`execute`（`codemode:false` 才直出 schema）；`tools.<server>.<method>` 命名空间；`execute` 内也有 `search()`；权限逐工具仍生效 |
| **CLI 编排派** | Claude Code Code Mode | Code Mode = **用户会话里的脚本层**，主要省往返，不是省工具定义上下文 | JS 跑在用户会话进程内；`edit()` / `$` 模板标签调内置工具；**JS 本身和文件/网络/MCP 工具调用明确跑在沙箱之外**，靠权限规则 + PreToolUse/PostToolUse hooks 管控；实验性、默认关 |
| **托管云原语派** | Anthropic 平台 PTC / code execution | Code Mode = **厂商托管的 Python 容器** | `code_execution_20260120` + `allowed_callers`；工具调用时 API 暂停、应用回传 `tool_result`、容器续跑；`$OUTPUT_DIR` → `file_id` 外部 spill；容器可复用 30 天；**MCP connector 工具明确不支持 programmatic calling** |
| **框架库派** | Vercel AI SDK `@ai-sdk/code-mode` | Code Mode = **一个可配置的库工具** | 与我们沙箱路线最像：每次调用独立 QuickJS context，`experimental_toolCallers` 做逐工具可见性，`toolDiscovery:'conversation'` 保持工具定义稳定，11 项 `executionPolicy` 细粒度限额 |
| **网关治理派** | 我们 / Speakeasy / solo.io agentgateway / Forgemax | Code Mode = **放在网关里的统一治理 choke point** | 沙箱前置在 MCP 网关，所有子调用过同一套身份/策略/凭据/审计；一次建设，所有背后 MCP server 和所有客户端受益 |

> Speakeasy 对"网关派"的价值概括最到位："**Code mode keeps tool results out of the model's context, which tool search alone can't do, but it moves the work into a sandbox someone has to run and govern.**"（[来源](https://www.speakeasy.com/resources/code-mode)）

**关键洞察**：Cloudflare 是源头，但它现在的主线是"durable runtime + 连接器生态"；OpenCode 把 search+execute 做成了默认通路；Anthropic 把 PTC 做成托管 API 却**不覆盖 MCP connector**；Vercel AI SDK 在库层面复刻了 QuickJS 路线。**"在 MCP 网关层做 code mode + 多上游聚合 + 真隔离"这个交叉点上，我们的形态反而最接近 Speakeasy 所描述的理想位置**，但持久化和类型发现是明显短板。

### 0.2 我们在谱系里的位置

**属于我们独有的生产化打磨（别家没有或只停留在 issue 阶段）：**

1. **`execute_read` / `execute` 双执行器的可见性分层**：读工具在沙箱内可调用，写工具被替换成会抛可操作错误的 stub（`src/codemode.js:558-570, 900`）。Cloudflare 用 `requiresApproval`+重放、Vercel 用"需要审批的工具干脆别放进 code mode"、OpenCode 用逐工具权限规则、Anthropic 用 `allowed_callers`——**没有一家在 MCP 工具边界上做"只读/全量"双 execute 的拆法**。这对不能做细粒度审批的 Gemini 客户端特别实用。
2. **token 生命周期全链路工程化**：`summarizeArgs` 循环安全 + 200 字符字段上限 → `stableKey` 只读幂等去重（不消耗调用预算）→ 50 次调用上限 → `boundLogs` 4000 字符 → `toModelOutput()`（沿用 Cloudflare 0.5.6 的投影思路）剥掉 `toolCalls`/`calls`/`logs`/`toJSON` → 最终结果结构化截断并打 `--- TRUNCATED ---` 标记 → wall-clock deadline + `AbortController`。**这套"从入参到回包逐层设防"的完整度在被调研对象里是最高的**：OpenCode 的"输出封顶且 spill 到文件"还是 [未实现的功能请求](https://github.com/anomalyco/opencode/issues/58708)，Vercel 有 11 项限额但没有公开的去重/审计投影叙事，Cloudflare 因重放语义**故意不截断** durable value。
3. **真隔离 + 可验证性**：Vercel `run` SDK（QuickJS in worker thread）替代 node:vm，`.constructor` 逃逸被挡（`docs/SANDBOX-SECURITY.md`），并有 `tests/true-isolation.test.js` + 线上探活证据。OpenCode 明确走"自研解释器、不嵌 QuickJS"，Claude Code 的 JS 压根不在沙箱里，Cloudflare 依赖 Workers 平台——**在 Node/Vercel 可部署的 MCP 网关里做引擎级 QuickJS 隔离并留回归测试，是我们独有的组合**。
4. **诚实的运行时状态**：`codemode.services()` 明确标注冷启动快照、不是 live health check，凭据过期要重新授权（`codemode.js:49-57, 769-847`）。各家都在展示"可用工具"，没看到谁主动给模型注入这种反幻觉说明。
5. **面向 Gemini 的静态工具面**：固定 3 个工具（`search` / `execute_read` / `execute`）、稳定顺序、搜索命中 160 字符短描述 + `select:<name>` 取完整 schema、结果用文本 JSON。契合项目硬规则"Gemini 不消费 `notifications/tools/list_changed`"。

**别人有而我们缺的（按重要度）：

1. **类型定义进入模型上下文**——最大短板。Cloudflare 把 JSON Schema 生成带 doc comment 的 TypeScript 声明喂给模型；Vercel 在 code_mode 工具描述里放 TS signatures；Pydantic Monty 同理。我们虽然从 0.5.6 导入了 `generateTypesFromJsonSchema`（`codemode-util.js:25`），但 `codemode.js` 实际只用了 `normalizeCode` 和 `sanitizeToolName`——**生成的类型没用上**。现在模型靠"一行摘要 + `select:` 完整 JSON Schema"，调用正确率上限低于 typed 方案。
2. **spill 而非截断**——Anthropic 的 `$OUTPUT_DIR` → `file_id` + Files API；Cloudflare durable value 超限报错并建议"存到别处、传一个小引用（如文件路径）"；OpenCode 把这条列为待办。我们的 `truncateResultValue` 会**永久丢数据**，模型没法回读被切掉的部分。
3. **持久化执行 / 审批 / 重放 / 回滚 / 可复用 snippet**——Cloudflare runtime 的整套 durable log、`approve()`/`reject()`/`rollback()`、`codemode.run()` 我们都没有。我们是单次无状态执行；写操作只能整段 `execute()`，没有逐动作审批闸门。
4. **逐工具 token 计量与预算**——OpenCode issue #58708 明确要 per-tool breakdown 和 token budget；Vercel 有 `maxToolInputBytes`/`maxToolOutputBytes`/`maxConsoleOutputBytes`。我们只有 `remainingCalls()`（调用次数），没有 token/字节预算的可见性。
5. **压缩（compaction）感知**——OpenCode [#58717](https://github.com/anomalyco/opencode/issues/58717) 指出：一个 code step 隐藏 50 次底层调用，压缩时若只算一条消息会丢掉程序发现的信息。我们的 `toModelOutput` 把审计轨迹全部剥掉，同样存在这个风险。
6. **更细的 executionPolicy**——Vercel 的 11 项（memory/stack/source size/per-tool I/O bytes/in-flight bridge requests/process-wide worker cap）比我们的 5 项更完整。
7. **多语言（Python）**——Anthropic PTC、Pydantic Monty、Speakeasy 都是 Python；我们只能 JS/TS。对 Gemini 宿主不算硬伤，但限制了可复用的生态代码。

### 0.3 可借鉴到本项目的设计（按优先级）

| 优先级 | 借鉴项 | 来源 | 落地形态建议 |
|---|---|---|---|
| P0 | **给 `search` 命中加紧凑 TS 签名** | Cloudflare `generateTypesFromJsonSchema` / Vercel tool description | 复用已导入但未使用的 `generateTypesFromJsonSchema`，在 `select:<name>` 时返回 TS 声明 + JSON Schema；list 模式保留短描述 |
| P0 | **大结果 spill + 引用回读** | Anthropic `$OUTPUT_DIR`/`file_id`、Cloudflare 超限建议、OpenCode issue #3 | 超 `maxResultChars` 时写 host-side store（按 executeId+序号 key），返回 `{truncated:true, ref, preview}`；再给沙箱一个 `codemode.readRef(ref, offset, limit)` 桥函数 |
| P1 | **`toolDiscovery:'conversation'` 式稳定工具定义** | Vercel AI SDK | 我们已经固定 3 个工具，进一步把"当前可用上游目录"放进 initialize instructions / 首轮 user message，而不是改工具 schema——与我们 AGENTS.md 的硬规则完全同向 |
| P1 | **逐工具输入/输出字节上限 + worker 上限** | Vercel `executionPolicy` | 在 `registry.tool()` 里对 `args` 和 `unwrapResult(raw)` 分别设 `maxToolInputBytes` / `maxToolOutputBytes`；`maxSourceBytes` 防超长代码；进程级并发 worker cap |
| P1 | **压缩友好的审计摘要** | OpenCode #58717 | 不剥光 `toolCalls`：保留 `{callCount, services, sample:[前3个工具名]}` 这类几十 token 的 digest 进模型上下文，供 compaction 判断 |
| P2 | **写操作审批闸门（轻量版）** | Cloudflare `requiresApproval` + abort/replay | 先不做完整重放：在 `execute()` 里对写工具调用改为返回 `pending` 并中止，宿主确认后带 executionId 重跑（只读调用靠现有 dedup 缓存避免重复副作用） |
| P2 | **snippet / 已保存脚本** | Cloudflare `codemode.run()` / snippets | 把模型验证过的代码提升为服务端注册的命名脚本，`codemode.run(name, input)` 调用；注意与"工具列表稳定"约束兼容（放沙箱内，不加新 MCP 工具） |
| P2 | **per-tool token/call 明细** | OpenCode #58708 | 在 `toolCalls` 记录里补 `approxTokens`，并在 `result` 里附一句 `{usedCalls, remainingCalls, approxResultTokens}` |

---

## 1. Cloudflare Code Mode（源头）

**来源**：
- 设计博客 <https://blog.cloudflare.com/code-mode>（2025-09-26，2026-11-09 修订）
- 产品博客 <https://blog.cloudflare.com/code-mode-mcp>（2500 endpoints / 1000 tokens）
- 总览文档 <https://developers.cloudflare.com/agents/tools/codemode/>
- 机制文档 <https://developers.cloudflare.com/agents/tools/codemode/how-it-works/>
- 包 README（一手） <https://raw.githubusercontent.com/cloudflare/agents/main/packages/codemode/README.md>
- MCP server 仓库 <https://github.com/cloudflare/mcp>
- 本地依赖 `@cloudflare/codemode@0.5.6`（`node_modules/@cloudflare/codemode/package.json`）

### 1.1 定位与演进

Cloudflare 在 2025-09-26 提出这个模式，核心论点原文：

> "It turns out we've all been using MCP wrong... Convert the MCP tools into a TypeScript API, and then ask an LLM to write code that calls that API... **LLMs are better at writing code to call MCP, than at calling MCP directly.**"

原因解释得很直白：

> "LLMs have seen a lot of code. They have not seen a lot of 'tool calls'... Making an LLM perform tasks with tool calling is like putting Shakespeare through a month-long class in Mandarin."

2025 年的两个 MCP 工具形态（`https://blog.cloudflare.com/code-mode-mcp`）：

```json
[
  {"name":"search","description":"Search the Cloudflare OpenAPI spec. All $refs are pre-resolved inline.","inputSchema":{"type":"object","properties":{"code":{"type":"string","description":"JavaScript async arrow function to search the OpenAPI spec"}},"required":["code"]}},
  {"name":"execute","description":"Execute JavaScript code against the Cloudflare API.","inputSchema":{"type":"object","properties":{"code":{"type":"string","description":"JavaScript async arrow function to execute"}},"required":["code"]}}
]
```

宣称效果："**Two tools, roughly 1,000 tokens, and coverage of every endpoint in the API**"（2500+ endpoints）。这与我们的 `search`+`execute` 形态几乎一一对应——我们确实是以它为源头。

**2026 年的重要演进**：主线已从"把全量 TS API 塞进上下文"转向"渐进发现 + 持久化运行时"。当前文档明确写：

> "Large tool catalogs can consume significant model context if every definition is loaded up front. **Connector-based Code Mode runtimes support progressive discovery through `codemode.search()` and `codemode.describe()`.**"

且博客也承认早期方案的局限："Currently, the entire API is loaded, but future improvements could allow an agent to search and browse the API more dynamically."

### 1.2 沙箱机制

- 执行器：`DynamicWorkerExecutor`，通过 **Dynamic Worker Loader** 为每次执行创建独立 V8 isolate（毫秒级启动、几 MB 内存，"no containers"）。
- 网络隔离在 Workers 运行时层强制：`globalOutbound: null`，即 `fetch()`/`connect()` 直接抛错；可选传 `Fetcher` 做受控出网。
- 凭据不出宿主：MCP/OpenAPI 连接器是 host-side RPC target，沙箱只拿到已经授权好的 JS 接口。"**An additional benefit of bindings is that they hide API keys... the AI cannot possibly write code that leaks any keys.**"
- 执行器接口刻意做得很小，README 明确允许替换：

  > "The `Executor` interface is deliberately minimal — implement it to run code in any sandbox... `DynamicWorkerExecutor` is the Cloudflare Workers implementation, but you can build your own for Node VM, QuickJS, containers, or anything else."

  **这点直接印证我们换 QuickJS executor 的做法在它的设计允许范围内。**
- 另有 `IframeSandboxExecutor`（`@cloudflare/codemode/browser`），用 CSP `default-src 'none'` 的隔离 iframe，但文档诚实标注"timeout cannot preempt tight synchronous loops"。

### 1.3 result shaping / 类型生成 / 生产就绪

- **结果处理**：`ExecuteResult = { result, error?, logs? }`；`toModelOutput` 投影（我们代码注释引用 0.5.6 `dist/index.js:1774`）把 `toolCalls` 和 `logs` 视为 audit-only，不进模型。
- **durable value 上限**：每次可重放值序列化后 **1,000,000 字符**。超限**故意不截断**（截断会破坏重放），报错并建议："**storing the data elsewhere, then passing a small reference such as a file path.**" 最终结果不受此限；`transformResult` 可在模型收到前重塑结果，审计记录保留原值。
- **类型生成**：`generateTypesFromJsonSchema(tools)` 从 JSON Schema 生成 TS 声明；`createCodeTool` 把类型写进工具描述（`{{types}}` 占位符）。`sanitizeToolName()`（连字符/数字/保留字处理）、`normalizeCode()`（AST/acorn 规范化）是公开工具函数——**我们 0.5.6 的 codemode-util.js 正是映射这三个导出**。
- **生产就绪度**：**不就绪/需谨慎**。README 首行警告：

  > "**Experimental** — may have breaking changes. Use with caution in production."

  产品侧：`https://mcp.cloudflare.com/mcp` 已上线可用；但 2025 年博客里的 Worker Loader API 当时是 closed beta（需报名）；2026 文档已按 GA 形态写 Dynamic Workers。限制还包括"Limited to JavaScript execution"。
- **最近更新**：文档/仓库已包含 approval、replay policy、rollback、role lifetimes、retention（`maxExecutions` 默认 50）、snippets、Vite facet 等 2026 年能力。TOC 中 `codemode.search/describe/step/run` 都是新增的平台级 SDK。

### 1.4 关键原文引用

> "Code Mode is a tool-use pattern where a model writes code instead of requesting each operation separately. The model receives one code-execution tool. Its code becomes a compact plan that calls tools, processes results, and returns the information needed for a response."
> — <https://developers.cloudflare.com/agents/tools/codemode/>

> "`codemode.search()` searches connector methods and saved snippets. It returns ranked paths, not complete schemas. The model can then pass one path to `codemode.describe()` to request focused TypeScript documentation."
> — <https://developers.cloudflare.com/agents/tools/codemode/how-it-works/>

---

## 2. OpenCode Code Mode

**来源**：
- 官方 v2 工具文档 <https://opencode.ai/docs/tools#execute>（抓取时重定向自 `/v2/docs/tools/`）
- 发布公告 <https://anoma.ly/notes/opencode-2-0/>（2026-10-12）
- 社区详解 <https://flaviocopes.com/opencode-code-mode/>（2026-10-17，2026-11-04 修订）
- issue #58708（token 预算/per-tool 明细） <https://github.com/anomalyco/opencode/issues/58708>（2026-10-24）
- 仓库 <https://github.com/anomalyco/opencode>，`packages/codemode`

### 2.1 机制

- **入口**：模型看到 `execute` 工具；`@opencode/codemode` 是一个**自研的最小 JS 解释器**。发布公告原文：

  > "We've built a minimal JavaScript interpreter in the `@opencode/codemode` package... It can run these scripts natively **without the complexity of Node.js VMs or embedding complicated solutions like QuickJS**."

  这与我们（以及 Vercel AI SDK）走 QuickJS 引擎级隔离的路线明确不同。
- **search + execute**：发布公告示例里，模型在 `execute` 内先 `return [search({query:"list github issues"}), search({query:"create linear issue"})]`，再 `await tools.github.list_issues(...)`、`tools.linear.save_issue(...)`。即 `search()` 是沙箱内可用函数，`tools.<server>.<method>` 是调用入口。
- **与 MCP 的关系（重点）**：
  - "**All MCP servers in 2.0 are opted into code mode by default.**"（发布公告）
  - 官方工具文档："By default, agents reach them through `execute` under the server's namespace; set `codemode: false` on a server to list its tools directly."
  - 维护者在 issue #58708 的回复："in v2, **MCP tools already go through Code Mode (`search` + `execute`) by default**. A server only gets its schemas inline if it has `codemode: false` in its MCP config."
  - 拒绝 `execute`（resource `*`）会移除 Code Mode，此时这些工具会以完整定义直出为普通工具。
  - 有专门的 PR 处理 Cloudflare MCP server 默认 `codemode: false`（[#57193](https://github.com/anomalyco/opencode/pull/57193)）——说明"code mode 套 code mode"确实会造成叠加问题。
- **权限**：`execute` 本身受权限控制，但"Nested built-in and MCP tools still enforce their own permissions, and plugin tools enforce the permissions they assert."。这与我们的 `execute_read`/宿主侧授权是同方向的纵深防御。
- **沙箱能力**：官方工具文档说 `execute` 的 runtime "has no direct filesystem access, imports, or timers. It provides `fetch` for HTTP requests"；issue #56811 说 `require('fs')` 不存在。**注意**：这里有文档冲突——flaviocopes 的文章写"no ... `fetch`"，而当前官方文档写"provides `fetch`"。以官方文档为准，说明 OpenCode 允许沙箱内出网，隔离弱于我们（我们 guest 完全没有 fetch）。
- **未覆盖**：内置工具（read/grep/edit/shell）能否从 `execute` 调用仍在推进中（[#55087](https://github.com/anomalyco/opencode/issues/55087)）；partial-failure/幂等、输出 spill 都是社区指出的痛点。

### 2.2 实测数据（三方，非官方）

issue #58708 作者用 207 工具的 MCP server（"rea"）实测：

- `tools/list` 原始 payload：3,423,785 字符 / **1,033,360 tokens**（`o200k_base`）；单个工具 `address_name` 2,721 tokens。
- 用 `search()` 后：工具 + 系统提示 + 2 个签名 ≈ **6.6k tokens**。
- 同一任务（抓 8 个 URL）A 逐次调用 vs B 单程序：

  | | A：逐个调用 | B：单程序 |
  |---|---|---|
  | tokens in | 31,427 | 696 |
  | total tokens | 34,489 | 1,257 |
  | cost | $0.00783 | $0.00057 |
  | 正确答案 | 5/8（截断导致 3 个错） | 8/8 |

  "**27.4x fewer tokens, 13.6x cheaper**"，且 B 因在沙箱内对全文 grep 而避免了截断造成的错误答案。这条直接支撑我们"大结果在沙箱里过滤"的设计。
- 作者明确点出的缺口，正是我们已在做的或可借鉴的：
  - "**Output caps that spill instead of truncate.** ... Could a configurable cap (say 4k tokens per tool result, full output in a file, path returned) become the default for every tool, MCP included?"
  - "Compaction accounting. One Code Mode step can hide 50 underlying calls."
  - "Sandbox and audit. ... What are the actual limits on network, filesystem, memory and time, and can a user inspect or replay the code that ran?"

### 2.3 关键原文引用

> "The runtime has no direct filesystem access, imports, or timers. It provides `fetch` for HTTP requests; everything else goes through tools in its catalog."
> — <https://opencode.ai/docs/tools#execute>

> "MCP servers ... By default, agents reach them through `execute` under the server's namespace; set `codemode: false` on a server to list its tools directly."
> — 同上

---

## 3. Claude Code Code Mode（CLI）

**来源**：
- 官方文档 <https://code.claude.com/docs/en/code-mode>（`dateModified` 2026-11-20）
- 三方对比 <https://www.marktechpost.com/2026/11/17/anthropic-claude-code-code-mode-javascript-tool-calls/>（2026-11-17）
- 社区详解 <https://flaviocopes.com/claude-code-code-mode/>（链接自 OpenCode 文章）

### 3.1 定位与实现

- **实验性、默认关闭**，v2.1.323+，通过 `CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1` 启用。官方原话：

  > "Code Mode is experimental and off by default. It may change or be removed in any release."

- 形态：Claude 写一段 JavaScript，Claude Code **在你的会话里**执行。示例（官方）：

  ```js
  const files = await $`rg -l "function retryPolicy" src`.text();
  const target = files.trim().split("\n")[0];
  await edit(target, "maxAttempts: 3", "maxAttempts: 5");
  ({ edited: target, tests: $`npm test -- retryPolicy`.nothrow() });
  ```

  对话里只看到工具调用（如 diff），代码要按 `Ctrl+O` 在 transcript viewer 里看。

- **沙箱真相（对我们对比极关键）**：

  > "Your sandbox settings apply to the shell commands that code runs. **The JavaScript itself and its file, web, and MCP tool calls run outside the sandbox.** To isolate the JavaScript and those calls too, run Claude Code in a container or virtual machine."

  也就是说，Claude Code 的 Code Mode **没有引擎级代码隔离**；安全靠权限规则 + hooks。`REPL` 是承载代码的工具体，可以加 `ask:["REPL"]` 先审代码；`PostToolUse` hook 可以对 `REPL` 的 `tool_response` 做脱敏（`updatedToolOutput`）。auto 模式下分类器是"审代码，不是逐次审工具调用"，且看不到运行时算出来的值。

- **限制**：等待模式 10 分钟超时，后台模式 2 小时；仅 Anthropic API + 订阅/Console，不支持网关 / Bedrock / Vertex / Foundry；仅终端原生构建；不支持 Remote Control / computer use / VS Code / Desktop / 云会话；无 HIPAA / ZDR。
- **无官方 token 节省数字**。三方测得系统工具上下文 11.1k tokens（开）vs 24.6k（关），单一第三方数据点。

### 3.2 与其他家的对比表（三方整理，已核对与官方文档一致）

| 维度 | Claude Code Code Mode | Claude API PTC | Cloudflare Code Mode |
|---|---|---|---|
| 语言 | JavaScript | Python | TypeScript |
| 编排对象 | CLI 内置工具（Bash/Read/Edit） | 开发者自定义工具 | MCP server（TS API） |
| 运行状态 | 实验、默认关 | 2025-11 上线（现 GA） | Worker Loader 曾 closed beta |
| 官方 token 数字 | 无 | 43,588→27,297（约 -37%） | 发布文未给 |
| 超时 | 等待 10 分钟 / 后台 2 小时 | 未披露（cell 90s） | 未披露 |
| 云平台 | 仅 Anthropic API | 不支持 Bedrock / Google Cloud | Cloudflare Workers |

### 3.3 关键原文引用

> "With Code Mode, Claude writes a piece of JavaScript that makes the tool calls, and Claude Code runs that code in your session."
> — <https://code.claude.com/docs/en/code-mode>

---

## 4. Anthropic 平台：code execution + Programmatic Tool Calling

**来源**：
- 研究博客 <https://www.anthropic.com/research/code-execution-with-mcp>（2025-11-04，2026-10-18 修订）
- PTC 平台文档 <https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling>
- code execution 工具文档 <https://platform.claude.com/docs/en/agents-and-tools/tool-use/code-execution-tool>
- Academy（Files API 示例） <https://academy.claude.com/courses/building-with-the-claude-api/code-execution-and-the-files-api>

### 4.1 code execution with MCP（研究方案）

提出了两种发现机制：

1. **文件系统式**：把每个 MCP server 的每个工具写成一个 `.ts` 文件，agent 通过 `ls ./servers/`、`cat getDocument.ts` 按需读定义。宣称 "**This reduces the token usage from 150,000 tokens to 2,000 tokens—a time and cost saving of 98.7%**"。
2. **`search_tools` 工具**：支持 detail level（name only / name+description / full definition with schemas）。这与我们的 `search` + `select:<name>` 双层设计几乎一致。
3. 特别强调隐私与状态：中间结果默认留在执行环境；可对 PII 做 tokenize，在 MCP client 里 untokenize，让敏感数据"从 Google Sheets 流到 Salesforce，但从不经过模型"；可用文件系统跨调用保持状态、把验证过的代码存成 Skills。

### 4.2 PTC（API 产品）与工具暴露方式

- 工具版本 `code_execution_20260120`（PTC 最低版本；最新 `code_execution_20260521`）。模型写 **Python** 代码调用工具函数。
- **工具如何暴露给模型写代码调用**：给每个工具定义加 `allowed_callers: ["code_execution_20260120"]`（可搭配 `"direct"`）。响应中的 `tool_use` 块带 `caller: {type:"code_execution_20260120", tool_id:"srvtoolu_..."}`。
- **执行流程是"暂停-回传-续跑"**：Claude 写代码 → 容器内运行 → 遇到工具函数时 API 暂停并返回 `tool_use` → 应用回传 `tool_result` → 容器从暂停处继续 → 最终只有 `stdout` 进上下文。容器 ID 必须回传（pending 时是必填），否则 400。
- **限制（重要）**：
  - "**Tools provided by an MCP connector cannot be called programmatically.**" —— Anthropic 自己的 MCP connector 工具不能进 PTC。这对"用 MCP 做工具暴露"的我们是重要边界信息：PTC 路线并不能直接替代网关层 code mode。
  - 递归 `$ref` schema 不支持；structured outputs / `tool_choice` 强制 / `disable_parallel_tool_use` 不兼容；ZDR / HIPAA 不适用。
  - 工具结果是字符串，文档提醒防代码注入。
- **收益数字（官方）**：75 工具项目管理 benchmark 账单输入 token **约 -38%** 且准确率不变；BrowseComp/DeepSearchQA 平均 +11% 表现、-24% 输入 token；10–49 工具的请求典型省 20–40%。但 τ²-bench（每轮 1–2 次顺序调用）**成本反而 +8%**——顺序单调用场景不划算。这与 Cloudflare/Anthropic 都建议"简单任务用直调"一致，也支持我们保留 whitelist 直调模式。

### 4.3 `$OUTPUT_DIR` / `file_id` spill（用户点名重点）

来源：code execution 工具文档 "How generated files are captured"。

> "Each `bash_code_execution` call gets a new, empty directory, available to the command as `$OUTPUT_DIR`. When the command completes, the files at the top level of that directory are captured and returned as the `file_id` entries in the result's `content` list. Files written anywhere else stay in the container and aren't returned."

要点：

- 模型是通过**工具描述被告知**要把要共享的文件 `cp` 到 `$OUTPUT_DIR`，并且因为模型看不到 `content` 列表，官方建议在同一条命令里 `ls "$OUTPUT_DIR"` 来自证：
  ```bash
  python /tmp/make_report.py && cp /tmp/report.pdf "$OUTPUT_DIR/" && ls "$OUTPUT_DIR"
  ```
- `bash_code_execution_result.content[].file_id` → Files API `client.files.download(file_id)`。上传方向则是 `container_upload` + `file_id`。
- 容器：Python 3.11 / Linux x86_64 / 5 GiB RAM / 5 GiB 磁盘 / 1 CPU / **完全无网络** / 30 天过期 / 5 分钟不活动 checkpoint。每次 REPL cell 90 秒墙钟（20260521 起写进工具描述）。
- 定价：与 web search/fetch 同用时 code execution 免费；单独用按执行时间计费（最低 5 分钟，每组织每月 1,550 免费小时，超出 $0.05/小时/容器）。

**对我们的意义**： Anthropic 用"文件系统 + 外部文件 ID"解决了我们 `truncateResultValue` 丢数据的问题；Cloudflare 在 durable value 超限时给出同样建议。这是 P0 借鉴项。

### 4.4 关键原文引用

> "Intermediate results stay in the execution environment by default. This way, the agent only sees what you explicitly log or return."
> — <https://www.anthropic.com/research/code-execution-with-mcp>

> "Programmatic tool calling allows Claude to write code that calls your tools programmatically within a code execution container, rather than requiring round trips through the model for each tool call."
> — <https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling>

---

## 5. 其它值得看的

### 5.1 Vercel AI SDK `@ai-sdk/code-mode`（与我们最接近的库）

来源：<https://ai-sdk.dev/docs/ai-sdk-core/code-mode>；发布信息 <https://www.developersdigest.tech/blog/vercel-ai-sdk-whats-new-2026>（2026-10，包首发 2026-07-29）。

- 官方定位："Code mode lets a model write JavaScript or TypeScript that calls your AI SDK tools. **The generated code runs in an isolated QuickJS sandbox** and returns a JSON-serializable result." experimental，Node 22+，不支持 browser/edge。
- **逐工具可见性**：`experimental_toolCallers: { getInventory: ['code_mode'], getDemand: ['code_mode', DIRECT_TOOL_CALL] }`——比我们的 read/write 二分更细，可"仅 code mode 可调"或"两者皆可"。
- **稳定工具定义**：`toolDiscovery:'conversation'`——把完整 code mode capability catalog（TS 签名 + 调用示例）放进 user message，provider 可见的 `code_mode` 工具定义不变。"**This mode can improve prompt-cache reuse because the provider-visible tool definition stays unchanged.**" 这与 Gemini 不吃 `tools/list_changed` 的约束完美同向。
- **延迟工具**：`toolSearch()` + `deferLoading: true`。
- **执行限额（11 项）**：`timeoutMs` / `cpuTimeoutMs` / `memoryLimitBytes` / `maxStackSizeBytes` / `maxSourceBytes` / `maxResultBytes` / `maxConsoleOutputBytes` / `maxToolInputBytes` / `maxToolOutputBytes` / `maxBridgeRequests` / `maxInFlightBridgeRequests`；另有进程级 `experimental_setMaxWorkers`（默认按内存，上限 32）。
- **隔离声明**：每次调用全新 QuickJS context；无 `process`/`require`/`module`、无文件系统、`fetch`/WebCrypto/performance 都不可用、无 `eval`/动态 `Function`；"Treat the sandbox as defense in depth... Tools execute in your host application, outside the QuickJS sandbox... Enforce authorization and validate inputs inside each tool." 与我们 `docs/SANDBOX-SECURITY.md` 的告诫几乎逐字对应。
- **审批**：明确不支持——"Tool calls made by generated code ... cannot pause the generation and surface a tool approval request... Do not expose tools that rely on user approval to code mode." 我们用 `execute_read` 绕开摩擦，是另一种解法。

### 5.2 Google Gemini code execution

来源：<https://aistudio.google.com/docs/code-execution>、<https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/tools/code-execution>。

- `tools=[{"type":"code_execution"}]`，模型生成代码 → `code_execution_call` / `code_execution_result` 交错步骤。支持生成图表/图像。
- **它是"计算工具"而不是"工具编排协议"**：没有把 MCP/外部工具暴露成代码里的函数这一层（至少公开文档未展示）。与我们要解决的问题不是同一层，但可作为"宿主原生 code execution 存在"的背景。

### 5.3 2026 年新网关 / 生态

| 项目 | 形态 | 要点 | 来源 |
|---|---|---|---|
| **Speakeasy Code Mode** | MCP 网关里的 `execute` | 跑短 **Python** 脚本，带 live tool search / schema lookup / 跨所有 hosted+remote+tunneled server 的授权调用；每调用过 identity/policy/credentials、有 audit log；明确"gateway 是跑 code mode 的正确位置" | <https://www.speakeasy.com/resources/code-mode>（2026-11-13） |
| **solo.io agentgateway** | MCP 网关 | 从 OpenAPI 生成 MCP，暴露单个 `run_code`（JS），embedded runtime sandbox，内存上限 + 每次工具调用上限 + 可配超时（默认 60s） | <https://www.solo.io/blog/agentgateway-code-mode-for-openapi-to-mcp> |
| **Pydantic AI Harness** | 框架 | 单一 `run_code`；自研 Rust Python 解释器 **Monty**，默认 30s / 256MiB；Logfire 把每次嵌套工具调用记成独立 span | <https://pydantic.dev/articles/why-code-mode-is-the-future> |
| **Pi** | agent runtime | QuickJS in WebAssembly，"no network, no file system, no timers, limited RAM" | 经 Speakeasy 文章转述 |
| **Forgemax** | 本地 MCP 网关 | 明确"Code Mode inspired local sandboxed MCP Gateway" | <https://github.com/postrv/forgemax> |
| **jev-code-mode** | 单服务两工具 | "Typed Jev judgments behind two MCP tools: search and execute" | <https://glama.ai/mcp/servers/acoyfellow/jev-code-mode> |
| **社区实现** | 各种 | Google ADK + Python 的 PTC 复刻、LangChain DeepAgent 的 Open PTC Agent、Vercel Sandbox 版 PTC（宣称省 80%） | <https://medium.com/the-ai-language/...>、<https://github.com/cameronking4/programmatic-tool-calling-ai-sdk> |

**趋势判断**：2026 年 code mode 已经从 Cloudflare 的单一创意扩散成"网关必备能力"。对我们的直接含义：**"网关 + search/execute"不再是差异化本身，差异化在于可见性分层、真隔离、result/token 生命周期、以及持久化治理**。

---

## 6. 横向对比矩阵（按用户指定维度）

| 维度 | Cloudflare | OpenCode | Claude Code CLI | Anthropic 平台 | Vercel AI SDK | **我们** |
|---|---|---|---|---|---|---|
| **对外暴露什么工具** | 标准配置 1 个 `codemode`（或一个 connector namespace）；早期 MCP server 版是 `search`+`execute` 两个 | `execute`（+沙箱内 `search()`、`tools.*`、namespace）；MCP 默认进去，`codemode:false` 直出 | 无新 MCP 工具；JS 直接调内置工具（`edit`/`$`） | `code_execution` server tool + 带 `allowed_callers` 的普通工具 | `code_mode` 工具 + `experimental_toolCallers` | **3 个：`search` / `execute_read` / `execute`** |
| **沙箱与隔离程度** | V8 isolate，Worker Loader；`globalOutbound:null`；bindings 藏凭据；强 | 自研最小 JS 解释器；无 fs/imports/timers，**但有 `fetch`**；逐工具权限兜底 | **JS 不在沙箱**；仅 Bash 命令走沙箱；靠权限/hooks/容器 | 托管容器（Python 3.11/Linux/1CPU/5GiB/无网络/30 天） | 全新 QuickJS context；无 process/fetch/WebCrypto/eval | **QuickJS in worker thread（run SDK 2.1.13）**；无 process/require/fetch/Node globals；原型冻结、`.constructor` 失效；有逃逸回归测试 |
| **上下文节省方式** | TS 类型 + 渐进 `search`/`describe`；只回 `return`/logs | 全 MCP 默认 search+execute，built-in 工具还在迁移；稳定工具定义 | 主要省往返；系统工具上下文有第三方实测 -55% | 工具定义按需 + 中间结果不进上下文；官方 -38% / -24% / -37% | tool discovery 可放 user message 保 cache；deferLoading | **424→9 工具定义 -97.6%（挂载时）；调用时沙箱内过滤，只回 return 值** |
| **result 处理（截断/spill）** | durable value 1M 字符上限；**不截断**（保重放），建议存外部传小引用；`transformResult` | 输出封顶+spill 仍是 issue；已知 50KB 截断致错 | PostToolUse hook 可脱敏/改 `tool_response` | **`$OUTPUT_DIR` → `file_id` → Files API**；二进制可带 C2PA | `maxResultBytes` / per-tool output bytes / console bytes | **结构化截断 + `--- TRUNCATED ---` 标记；入参/large args/log/调用数/deadline 全链路上限；但截断不可回读** |
| **类型/发现机制** | JSON Schema→TS 声明带 doc comment；`search` 返回路径、`describe` 返回类型；`sanitizeToolName`/`normalizeCode` 公开 | `search()` 找工具，命名空间 `tools.<server>.<method>`；描述质量依赖上游 | 直接写代码，无发现层 | 工具描述建议写清 JSON 结构；无独立 discovery 工具 | TS signatures 进工具描述或 conversation catalog；`toolSearch` | **外层 `search`（BM25）+ `select:<name>` 取完整 schema；沙箱内 `codemode.search`/`listTools`；`callName`/`access` 提示；已导入但未使用 `generateTypesFromJsonSchema`** |
| **适用宿主** | Cloudflare Workers / Agents SDK（另 AI SDK、TanStack、browser iframe） | OpenCode 自身（TUI/Web/Desktop 共享本地 service） | 仅 Claude Code CLI 终端、Anthropic API、原生构建 | Messages API（含 AWS/GCP/Foundry），**MCP connector 工具不支持 PTC** | Node 22+ 的 AI SDK 应用（browser/edge 不支持） | **任何标准 MCP 客户端（Gemini 网页版自定义连接器为目标）** |

---

## 7. 对我们项目的具体判断

### 7.1 站得住的部分

1. **架构选型被趋势验证**：Speakeasy 明确把"网关里放沙箱"定义为正确位置；OpenCode 把 search+execute 设为 MCP 默认；Cloudflare 也转向 search/describe。我们的 `search`+`execute` 主线不是自创怪招，而是收敛中的行业共识。
2. **真隔离是真实差异**：Claude Code 不隔、OpenCode 自研解释器、Cloudflare 绑平台；我们在通用 Node/Vercel 环境里用 QuickJS 做到引擎级隔离并有回归测试。这在"个人工具/可信用户"定位下是足够的纵深防御——但按 `docs/SANDBOX-SECURITY.md` 的告诫，**隔离 ≠ 授权**，宿主侧门不能拆。
3. **token 生命周期是最完整的工程细节**：对照 OpenCode issue 里社区提出的 6 个诉求，我们已经做了其中 3 个（默认 search+execute、逐调用审计、可见性分层），剩下 3 个（spill、per-tool 计量、compaction 感知）在 0.3 节列出。
4. **诚实性设计少见**：边界/拒绝引导、结果形态引导、`services()` 冷启动快照免责声明——这些在别家文档里看不到对应物。

### 7.2 需要警惕的部分

- **类型缺失是准确率天花板**：模型只看一行摘要 + 按需 JSON Schema，没有 TS 签名，写错参数名的概率高于 Cloudflare/Vercel。我们已有 `validateToolArgs` 做前置校验（好设计），但"报错后重试"仍是一次往返。
- **截断丢数据可能被误判为"没有数据"**：OpenCode 的实测表明截断会直接改变答案（3/8 错）。我们打了 `--- TRUNCATED ---` 标记，模型知道被截，但无法回读——应尽快补 spill+ref。
- **Cloudflare SDK 2 年后仍是 Experimental**，我们 pin 在 0.5.6 并直接 import 其内部 minified chunk（`codemode-util.js` 注释已说明映射），SDK 升级有破坏风险。TypeScript 类型生成函数就是升级后可能变动的导出之一。
- **PTC 不支持 MCP connector 这条边界提醒我们**：不要指望"宿主自带 code execution"能替代网关层；反过来，网关层的 code mode 对不原生支持 PTC 的客户端（如 Gemini）价值更大。

---

## 8. 来源清单

**Cloudflare**
1. <https://blog.cloudflare.com/code-mode> — "Code Mode: the better way to use MCP"（2025-09-26）
2. <https://blog.cloudflare.com/code-mode-mcp> — "give agents an entire API in 1000 tokens"
3. <https://developers.cloudflare.com/agents/tools/codemode/>
4. <https://developers.cloudflare.com/agents/tools/codemode/how-it-works/>
5. <https://developers.cloudflare.com/agents/tools/codemode/mcp/> / `build-codemode-mcp-server/`
6. <https://raw.githubusercontent.com/cloudflare/agents/main/packages/codemode/README.md>
7. <https://github.com/cloudflare/mcp>

**OpenCode**

8. <https://opencode.ai/docs/tools#execute>
9. <https://anoma.ly/notes/opencode-2-0/>
10. <https://flaviocopes.com/opencode-code-mode/>
11. <https://github.com/anomalyco/opencode/issues/58708>
12. <https://github.com/anomalyco/opencode/issues/56811>（无 CommonJS require）、#55087（内置工具进 execute）、#57193（Cloudflare MCP 默认 codemode false）

**Anthropic / Claude**

13. <https://www.anthropic.com/research/code-execution-with-mcp>
14. <https://www.anthropic.com/research/advanced-tool-use>
15. <https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling>
16. <https://platform.claude.com/docs/en/agents-and-tools/tool-use/code-execution-tool>
17. <https://code.claude.com/docs/en/code-mode>
18. <https://www.marktechpost.com/2026/11/17/anthropic-claude-code-code-mode-javascript-tool-calls/>
19. <https://academy.claude.com/courses/building-with-the-claude-api/code-execution-and-the-files-api>

**其它 / 生态**

20. <https://ai-sdk.dev/docs/ai-sdk-core/code-mode>
21. <https://aistudio.google.com/docs/code-execution> / <https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/tools/code-execution>
22. <https://www.speakeasy.com/resources/code-mode>
23. <https://www.solo.io/blog/agentgateway-code-mode-for-openapi-to-mcp>
24. <https://pydantic.dev/articles/why-code-mode-is-the-future>
25. <https://github.com/postrv/forgemax>

**本项目内部依据**

26. `src/codemode.js`、`src/codemode-util.js`、`docs/WHY.md`、`docs/SANDBOX-SECURITY.md`、`CONTRACT.md`
27. `node_modules/@cloudflare/codemode/package.json`（0.5.6）、`node_modules/run/package.json`（2.1.13）
