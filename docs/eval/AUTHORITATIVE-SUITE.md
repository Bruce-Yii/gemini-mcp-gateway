# AUTHORITATIVE-SUITE — 高复用「单上游 + 跨上游」权威任务集与客户端深度投喂模板

> **治理标记**：`[云端总控]` 基于真实历史资产定稿（2026-11-24，关闭 Issue #13）。
> **事实来源**：100% 提炼自 [HISTORY-MINED-2026-11-24.md](HISTORY-MINED-2026-11-24.md)、`explore/tasks-v2.json`（191 题）、`explore/figma-tasks.json`（46 题）、`explore/results/anomalies.json`、`work/analyzer/analyzer-output-2026-11-22.json` 与历次真实客户端主动评测（Gemini / ChatGPT / Issue #4、#5、#15），**零凭空编造**。
> **使用定位**：
> - **Gemini**：日常真实业务会话为主，隔 5–10 轮用「模板二」深度拷问；发版/大改时可挑本表核心项跑专项；
> - **ChatGPT / Claude 及新接入平台**：直接用「模板一」按本任务集批量跑测，横向对比不同客户端表现；
> - **离线回归**：仅跑无 LLM 的纯确定性契约测试，不再拿本地 `hy4`（及 DSH 宿主）结果评判客户端适配质量。

---

## 一、单上游高频核心任务（13 条，全部映射真实历史源 ID）

### 1.1 GitHub（5 条 — 覆盖真实高频痛点与历史 P0 坑）

| 套件 ID | 历史源 / 依据 | 读写 | 任务内容与工具级真值验收点 | 前置条件 |
|---|---|---|---|---|
| **AT-GH-01** | B5 / PR80-101 / Issue #4 / #15 | 只读 | 读取 >30KB 文件（如 `src/evidence/capture.js`），校验 `fileResult.content` 纯正文无 download notice/SHA、`path` 非 null、40KB 完整文件不误标 `truncated:true` | 立即可跑 |
| **AT-GH-02** | 11-23 F2 / `285e881c` | 只读 | 并发读取同一文件在 `main` 与另一分支上的内容（验证 `branch→ref` 别名不静默回退到 main），输出差异摘要 | 立即可跑 |
| **AT-GH-03** | B1 / B5 / `56854cdc` / PR80-101 | 只读 | 单次 `execute_read` 用 `safeAll` + `unwrapBatch` 并发读 5–8 个源码文件并在端内做正则/导出汇总，校验批处理包装层级统一、不回显全量 `toolCalls.args` | 立即可跑 |
| **AT-GH-04** | `F004/F005/F008` / Issue #5 / PR80-101 | 写入 | 在受控仓库 `Bruce-Yii/gateway-acceptance-test` 建分支 → 局部编辑（`editText/applyTextEdits`）+ 原子多文件推送（`push_files`）→ 建 PR；校验 `commitSha` 非 `blobSha`、PR `number` 来自 URL、写前 TS 预检生效 | 立即可跑 |
| **AT-GH-05** | `F001` / PR80-101 / Issue #15 | 读写 | 在受控仓库建 Issue（校验顶层 `number` 非 null 且无重复创建）+ 读一次失败 CI job 日志与 `waitForPrChecks` 单次等待（非 3–4 轮碎轮询） | 立即可跑 |

### 1.2 Vercel（3 条 — 来自 `tasks-v2.json` 与 B5 真实任务）

| 套件 ID | 历史源 / 依据 | 读写 | 任务内容与工具级真值验收点 | 前置条件 |
|---|---|---|---|---|
| **AT-VC-01** | `F134`（`open_deployments`） | 只读 | 查询 `gemini-mcp-gateway` 指定分支与最新 commit 的部署记录，准确区分 production vs preview、提取 `deploymentId` 与 commit SHA | 立即可跑 |
| **AT-VC-02** | `F136`（`get_runtime_logs`） | 只读 | 拉取项目最近 1 小时的运行时错误日志摘要，校验大日志截断元数据完整、无静默丢尾 | 立即可跑 |
| **AT-VC-03** | `F140` / `anomalies.json` 403/404 | 只读 | 抓取或检查项目端点/文档（`search_vercel_documentation` / `web_fetch_vercel_url`），并验证遇到 403/404 时清晰归因为上游权限/资源缺失而非网关故障 | 立即可跑 |

### 1.3 Figma（2 条 — 来自 `figma-tasks.json` 官方 verbatim，注意 Starter 配额控频）

| 套件 ID | 历史源 / 依据 | 读写 | 任务内容与工具级真值验收点 | 前置条件 |
|---|---|---|---|---|
| **AT-FG-01** | `FIG-001/FIG-002`（`get_design_context`） | 只读 | 先查 metadata 定位目标 node，再拉取指定选区的设计上下文或截图，校验大节点 JSON 在沙箱内裁剪、不撑爆对话上下文 | 立即可跑（控频） |
| **AT-FG-02** | `FIG-005/FIG-006/FIG-012` | 只读 | 读取文件未读评论摘要（`get_comments`）、变量定义（`get_variable_defs`）或 Code Connect 映射，校验返回结构清晰且无静默截断 | 立即可跑（控频） |

### 1.4 Notion（2 条 — 来自 `tasks-v2.json` 与 `anomalies.json` 真实报错）

| 套件 ID | 历史源 / 依据 | 读写 | 任务内容与工具级真值验收点 | 前置条件 |
|---|---|---|---|---|
| **AT-NT-01** | `F043/F051`（`notion-search` / `notion-update-page`） | 读写 | 语义搜索测试页面并对指定段落做局部更新（保留页面其余内容不覆盖），校验新版 Notion MCP 工具一次召回 | 授权就绪后 |
| **AT-NT-02** | `F060/F088`（真实 400/套餐门控） | 只读 | 触发或验证上游校验错误（`validation_error 400`）或 Business 套餐门控（`notion-calendar-list-contacts`），确认错误信息清晰透传并归类为上游限制而非网关 bug | 授权就绪后 |

### 1.5 Linear（1 条 — 来自 `tasks-v2.json` 与 `anomalies.json` 真实复杂度坑）

| 套件 ID | 历史源 / 依据 | 读写 | 任务内容与工具级真值验收点 | 前置条件 |
|---|---|---|---|---|
| **AT-LN-01** | `F097/F112/F116` | 只读 | 查询团队项目与指定 Issue 评论列表，重点验证不触发 `limit > 50` 参数错误与 GraphQL `Complexity > 10000` 超限；若遇无效 team/issue 清晰归因上游 404 | 授权就绪后 |

---

## 二、跨上游真实串联任务（3 条 — 专打多步编排与省上下文核心价值）

| 套件 ID | 历史源 / 依据 | 涉及上游 | 任务内容与验收点 | 前置条件 |
|---|---|---|---|---|
| **AT-XU-01** | B5 真实混查任务 | GitHub × Vercel | 在单次或最少轮次内：查 Vercel `gemini-mcp-gateway` 最新 production 部署 commit → 回到 GitHub 对照 `docs/DEPLOYMENTS.md` 与 `main` HEAD 的提交差异 → 输出漂移核验报告（校验 `servers: ["github","vercel"]` 与跨上游衔接顺畅度） | 立即可跑 |
| **AT-XU-02** | `analyzer 10c13554`（6228ms 11 步） | GitHub × Notion × Linear | 在单次 `execute_read` 沙箱内跨 GitHub、Notion、Linear 并发拉取项目状态并端内汇总（重点观测批处理并行度、尾延迟与各上游返回形状统一性） | 授权就绪后 |
| **AT-XU-03** | `FIG-006/FIG-012` × GitHub | GitHub × Figma | 读取 Figma 指定组件变量或 Code Connect 映射，再检索 GitHub 对应实现文件做一致性核对（验证双大载荷上游串联不触发截断失真） | 立即可跑（控频） |

---

## 三、黑盒客户端差异探针（3 条 — 横向对比 Gemini / ChatGPT / Claude 与防串伤）

| 套件 ID | 历史源 / 依据 | 探测维度 | 任务内容与观测重点 |
|---|---|---|---|
| **AT-CL-01** | `F5` method 枚举 / Issue #15 `writeFiles` | 工具发现与 schema 清晰度 | 给不带工具名的自然语言需求，观察客户端能否通过 `search` → `select:<name>` 准确拿到参数，是否因工具描述过长或不一致导致猜参数/走弯路 |
| **AT-CL-02** | 11-23 scorecard 9/10 suspect / B5 截断 | 截断元数据与续读恢复 | 故意触发超长返回（大目录或长日志），观察客户端是读懂 `truncation` 用 `readFileRange`/`grepSnippet` 续读，还是自己写 `.slice(0, 150)` 导致静默丢数据 |
| **AT-CL-03** | FRAMEWORK §14 弹窗 / 长会话重连 | 宿主体验与审批弹窗 | 受控仓库跑 1 次只读 + 1 次写入 + 连续 6–8 轮交互，记录 `search`/`execute_read`/`execute` 各自弹了几次审批框、返回编码（text JSON vs `structuredContent`）解析及连接稳定性 |

---

## 四、深度客户端投喂模板（直接复制到目标客户端窗口）

### 模板一：权威任务 / 专项压测深度投喂模板（适合 ChatGPT 等平台批量跑，或 Gemini 专项测）

```text
你现在作为目标客户端执行一次 MCP 网关深度评测（任务 ID：___）。

【执行纪律】
1. 全程必须通过已挂载的 MCP 网关工具完成，禁止凭记忆脑补结果；
2. 你只负责执行和如实暴露所有细节，不要美化或替网关找补；遇到绕路、重试、报错、困惑全部如实记录；
3. 如涉及写操作，仅限受控测试仓库 Bruce-Yii/gateway-acceptance-test，禁止动主仓生产配置。

【任务目标】
（在此粘贴对应任务 ID 的具体内容）

【执行完成后，请严格按以下 0–7 共 8 个模块逐项详细汇报，不要省略任何一项，没有遇到的写“无”】

0. 本次复盘的动作范围锚点（用于和网关日志精准对齐，不要编造时间戳）
- 涉及的项目 / 仓库 / 上游（如 github:owner/repo、Vercel 项目名等）：
- 起始动作锚点（这几轮最早做的一件具体事，如“读取 src/xxx.js”或“处理 PR #80”）：
- 结束动作锚点（刚刚做的最后一件具体事，如“合并 PR #17”或“创建 Issue #15”）：
- 期间碰过的关键标识（列出具体 PR 号、Issue 号、分支名、commit SHA 或关键文件名）：

1. 原始调用链与精确证据
- 按执行顺序列出每一步：调用的网关工具（search / execute_read / execute）→ 沙箱内实际调用的上游工具名 → 关键入参 → 关键原始返回字段（如实贴出 number / id / sha / commitSha / path / truncated / error 原文，缺失写 null 或 unknown）。
- 总共消耗了几轮网关工具调用？单次沙箱内最多串了几个上游调用？

2. 工具发现与参数理解摩擦
- 你一开始搜目标工具搜了几次？用了什么关键词？有没有搜不到、排序靠后或看错工具名？
- 工具描述里的内置 helper（如 safeAll / unwrapBatch / fileResult / prResult / readFileRange / applyFilePatch / writeFiles / waitForPrChecks）有哪些你没注意到、看混了，或参数格式让你猜错了？
- 上游参数名有没有别扭或不一致的地方（如 ref vs branch、pullNumber vs pull_number、patches vs files）？

3. 沙箱编排、批处理与跨上游衔接
- 批处理返回（safeAll / unwrapBatch / unwrap）层级是否一致？有没有因为多包一层或结构不统一导致脚本报错重试？
- 如果涉及多个上游串联，上游 A 的输出传给上游 B 顺不顺手？中间有没有被迫多做额外转换或多余查询？

4. 返回数据纯净度、截断与上下文消耗
- 读文件时 content 是否纯正文（有无混入 download notice / SHA）？path 有没有丢失？
- 写操作（建 PR / 建 Issue / 合并 PR / 原子推文件）返回的 number / sha / commitSha / url 是否准确？有没有出现 null、内部大整数 ID 冒充编号、或 blob SHA 冒充 commit SHA？
- 有没有触发截断？truncation 元数据是否清晰告诉你总大小、尾部字段和下一步怎么续读？有没有出现“明明正文完整却误报 truncated:true”或“返回太大逼得你自己 slice”？

5. 写入安全闸与错误处理
- 写路径有没有遇到默认 dryRun 静默不写入、误拦截、报错信息看不懂、失败留半成品或重复创建？
- 报错信息里有没有帮助定位具体哪一行/哪一步错了？

6. 客户端宿主体验（本平台特有观测）
- 整个任务里，客户端一共弹了几次审批/确认弹窗？分别是哪个工具触发的（search / execute_read / execute）？
- 客户端对网关返回格式解析是否正常？有没有出现 UI 截断、响应明显卡顿、掉线重连，或逼近单轮工具调用上限？
- 哪一步体感最慢？

7. 深度优缺点总结与高优先级改进建议
- 最省力/最值得保留的 3 个优点（不能改坏的地方）；
- 最别扭/最浪费轮次的 Top 3–5 个痛点（每条写清：当时卡在哪 → 如果网关怎么改，你能少走几步弯路）；
- 如果之前测过旧版本：明确对比哪些变好了、哪些没变、哪些反而退化了。
```

### 模板二：日常真实业务会话追问模板（适合 Gemini 日常做项目时隔 5–10 轮顺手拷问）

```text
暂停一下当前业务，帮我做一次针对刚才这几轮 MCP 网关使用体验的深度复盘（不用再调工具，直接基于你刚才真实调用过程回答）：

0. 本次复盘的动作范围锚点（用于和网关日志精准对齐，不要编造时间戳）
- 涉及的项目 / 仓库 / 上游（如 github:owner/repo、Vercel 项目名等）：
- 起始动作锚点（这几轮最早做的一件具体事，如“读取 src/xxx.js”或“处理 PR #80”）：
- 结束动作锚点（刚刚做的最后一件具体事，如“合并 PR #17”或“创建 Issue #15”）：
- 期间碰过的关键标识（列出具体 PR 号、Issue 号、分支名、commit SHA 或关键文件名）：

1. 回顾刚才这几轮你实际调过的网关工具和沙箱脚本：哪些地方让你走弯路、重试、猜参数、或不得不换另一种写法？请精确指出对应的工具名和返回字段问题（比如 null / 内部 ID / 误报截断 / 解包层级不一 / 缺少某个 helper）。
2. 刚才有没有出现“工具描述太长或没写清导致你没用上某个内置能力”的情况？
3. 返回结果里，有哪些字段是冗余撑上下文的，又有哪些关键字段缺失导致你不得不额外多查一轮？
4. 宿主体验上，刚才审批弹窗频率、响应速度和多步连续调用稳不稳定？
5. 如果你是这个网关的开发者，按投入产出比从高到低，给刚才暴露出的问题排一个 Top 3–5 改进清单（每条说明具体改法和预期省下多少轮次）；如果有印象，顺便对比一下和之前版本相比哪里变好或变差了。
```
