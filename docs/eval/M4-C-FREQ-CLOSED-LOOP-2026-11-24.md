# M4-C — 跨客户端防串伤规则 + 高频评测闭环实测（2026-11-24）

> 对应 Issue #14（M4-C）。本文件只记录：规则落位、真实命令与输出、有限对照、阻塞与未验证项。
> 不修改 `src/` / `scripts/` / `tests/`；不部署生产；不打印任何 token/secret；不编造 requestId。
> 依赖能力：#12（PR #18，分支 `feat/m4-a-four-dim-digest` @ `07c2d31`）的四维分账与
> `--platform` / `--eval-mode` 过滤。

## 0. 结论先行

1. **规则已落地**：`AGENTS.md` §3.2「公共层 vs 平台隔离层 — 跨客户端防串伤规则」；
   `docs/eval/BADCASES.md` 增加「跨客户端验证结果」列与「跨客户端防串伤回归记录区」。
2. **真实 60 分钟闭环实跑：BLOCKED（R2 credentials unavailable）**。
   `R2_*` 与 `ANALYZER_*` 在本机均未配置；命令在读取 R2 前退出，**没有伪造任何日志数据**，
   也没有用假数据冒充真实日志。
3. **可用的真实归档证据**（不同时间窗，只能做方向对照，不能当同窗闭环）：
   - 被动：`docs/eval/scorecard-2026-11-23.md`（真实采集聚合，20 请求窗口）；
   - 免费模型：`work/analyzer/analyzer-output-2026-11-22.json`（真实 analyzer 输出，9 请求窗口）。
4. **跨客户端验证：`未验证`**。本任务无第二客户端真实窗口，不得写“公共层已修复/已通过”。

## 1. 主动反馈原文与构建

- 来源：[ONLINE-FEEDBACK-2026-11-24-PR80-101.md](ONLINE-FEEDBACK-2026-11-24-PR80-101.md)（用户真实使用反馈，项目 `github:Bruce-Yii/recruitment-agent`）。
- 原文记录的构建：旧构建（`9ab0e57` / `1481408`，按原文档）；**本次对照基线 `buildCommit=5039ac6`**。
- 本次只读核验生产：`/healthz` → `commit=5039ac69d4e514bc11cdcc4fb2ce19d7dd5e234a`、
  `buildHash=c060691d006e5f3d6c590740e560ae5e76ab3a42`、`deploymentId=dpl_Ao5R8WoDpZZfXQbjxEeLVFFMntZ3`。

### 1.1 用户明确肯定的优点（原文节选）

> “单次原子推送直接把所有文件打进同一条 commit，再也不像早先那样逐文件提交留下一串碎 commit。”
>
> “在一个调用里并发读 5–8 个文件，直接在端内做正则检索、行号切片、集合对账……只把几十行结论带回对话。”
>
> “直接通过网关拉到失败 job 的完整日志，端内搜 `failing tests:` 精准定位。”

### 1.2 用户报告的问题（原文节选）

> “每次读取仓库文本文件，正文开头都会拼着一行 `successfully downloaded text file (SHA: ...)`。”
>
> “建 PR 返回的 `number` 时不时给的是内部数据库 ID 而不是真正的 PR 编号。”
>
> “创建 Issue 返回里 `number` 为空，紧接着查 open Issue 列表又因索引延迟返回空数组，导致重复 #90。”
>
> “并发批处理外面会多包一层 `{ ok, value }` 的状态壳；有些上游返回数组、有些返回 JSON 字符串。”
>
> “在端内 JS 模板字符串里拼 TypeScript 源码时，正则里的 `\d`、`\s`、`\n` 被外层模板字符串吃掉一层转义。”
>
> “每次改一个 1,000 行的文件，我大多只能全量读出来做字符串 `replace` 再整文件写回去。”
>
> “等 CI 收尾的轮询体验很碎，全量单测跑一次大约 2.5–3 分钟……光在等 CI 上浪费十几轮。”
>
> “CI 偶发失败时不能一键触发 `rerun-failed-jobs`。”

## 2. 真实实跑记录（命令 / 输出 / 阻塞）

执行分支：`feat/m4-a-four-dim-digest` @ `07c2d31`（#12 能力）；生产只读基线 `5039ac6`。

```text
$ node scripts/analyze-captures.mjs --last-minutes 60 --dry-run
[analyze] failed: fetch failed
exit=1

$ node scripts/analyze-captures.mjs --platform gemini --eval-mode active --last-minutes 60 --dry-run
[analyze] failed: fetch failed
exit=1
```

环境核验（只检查是否存在，不打印值）：

```text
R2_ACCOUNT_ID=false  R2_BUCKET=false  R2_AUTH_EMAIL=false  R2_AUTH_KEY=false  R2_API_TOKEN=false
ANALYZER_API_KEY=false  ANALYZER_BASE_URL=false
```

判定：

- `BLOCKED: R2 credentials unavailable` —— 无法读取真实 R2 capture，命令在 fetch 阶段退出；
- `BLOCKED: analyzer credentials unavailable` —— 即使有 R2 数据，本机也无免费模型 endpoint/key 可调用；
- **这不是“capture 里 0 条”**，也不是网关执行失败；是评测环境缺少数据访问凭据；
- 未使用、未打印、未提交任何环境变量或 token 值；未用假数据替代。

## 3. 有限对照（归档真实证据，非同一时间窗）

### 3.1 被动侧：`scorecard-2026-11-23.md`（真实采集聚合）

| 指标 | 值 |
|---|---:|
| 请求 | 20 |
| MCP 请求 | 20 |
| 错误 | 3（auth 1 / upstream_4xx 2） |
| p95 | 5153 ms |
| 工具调用 | 10（`execute` 5 / `execute_read` 5） |
| 模型截断嫌疑（advisory） | 9 |
| clientPlatform | 全部 `unknown` |
| 项目标签 | `github:Bruce-Yii/recruitment-agent` 10 |
| 窗口 | 2026-11-23T00:43Z–03:24Z |

真实 requestId 样本（摘自 scorecard，仅作归档证据，不用于硬关联）：
`0069576d-86d7-477a-924f-1eb65a19fc30`、`008159d0-eb18-4739-9475-3e318cdb91a8`、
`02217adb-8545-41a7-b3fb-554aef02c87d`、`04179ab4-ee1d-42c4-92ae-d7a12c74c574`、
`05188d82-bee4-4a7b-b7b0-6708c3ad951a`。

### 3.2 免费模型侧：`work/analyzer/analyzer-output-2026-11-22.json`（真实 analyzer 输出）

- 9 请求；0 个错误聚类；4 个成功样本（`execute_read` ×3、`search` ×1）；
- 输出 2 条 **P2 advisory**：
  1. “Tool result shapes require repeated defensive unwrapping and normalization.”
  2. “Long chained execute_read call dominates p95 latency.”
- 证据 requestId：`10c13554-6936-4a93-9ef2-9662fa55d1c6`、`56854cdc-5c79-4980-b4e2-7a12d373dcc2`、
  `285e881c-aa31-4786-83f4-49285cf9ed25`（真实归档，未编造）。

### 3.3 主动反馈 × 被动/免费模型对照

| 主动反馈项 | 被动 scorecard 是否可见 | 免费模型是否覆盖 | 漏抓原因 | 反哺动作（不改代码，只进任务/提示词） |
|---|---|---|---|---|
| content 混入下载提示 | ❌（聚合无内容级字段） | ❌（该窗口无此类样本） | capture 聚合只计错误/截断/字节；结果内容不进聚合；旧窗口无 `servers[]/clientPlatform` | 用 #12 四维过滤缩小平台/协议；成功样本提示词要求“返回字段/正文污染”检查；真实 R2 可用后同窗回放 |
| PR number=内部 ID | ❌ | ❌ | 同上；`number`/`id` 不在聚合维度 | 在 analyzer 成功样本中显式要求核对 canonical 字段；对应 BADCASES BC-002 抽测 |
| Issue number 空/重复 | ❌ | ❌ | 缺 `createIssue` 结果级字段与幂等观测 | 需要 capture 记录工具结果关键字段或主动任务复现；不凭反馈改代码 |
| 批处理 `{ok,value}` 包装 | ❌ | ❌ | 聚合不看返回形状 | 半在线任务 J3/BC 抽测；提示词加“wrapper 一致性”检查 |
| TS/正则转义 | ❌ | ❌ | 属于写前预检，聚合不采集写入内容 | 写前预检任务（OF-4）复现；本地确定性测试 |
| 整文件 replace / 缺局部补丁 | ❌ | ⚠️ 方向（“defensive unwrapping”近似） | 免费模型看到的是成功样本的“重复解包”摩擦，不是补丁契约 | 补丁式编辑契约（OF-6）任务；提示词区分“解包摩擦”和“编辑契约” |
| 大返回截断切尾 | ⚠️ 有 9 个 truncation suspects（advisory） | ❌ | suspect 是模型侧静默截断的启发式，不是网关截断事实；无 tail/next 字段 | 保留 advisory 隔离；需要 `truncation.fields/tail/next` 的结构化采集 |
| CI 轮询碎 / 无法 rerun | ⚠️ 有 p95/慢调用，但不区分轮询 | ❌ | 聚合无 helper 调用序列 | 半在线 J6/OF-5；成功样本提示词加“轮询轮次”摩擦 |
| delete/rename 原子 / 合并删分支 | ❌ | ❌ | 不在聚合维度 | OF-8/OF-9 任务；不凭反馈直接改 |

### 3.4 同窗判定

`NOT_ENOUGH`：主动反馈（2026-11-24）没有 `requestId`、没有同窗 capture；被动归档窗口为
2026-11-23（scorecard）与 2026-11-22（analyzer），**不是同一时间窗**。因此：

- 不能写“被动抓到了/没抓到该次会话”；
- 不能跨构建硬比（反馈来自旧构建，基线 `5039ac6` 是当前构建）；
- 本对照只用于**方向性反哺**，不作为闭环完成的证据。

## 4. 跨客户端防串伤：规则与本批候选

规则（已写入 `AGENTS.md` §3.2）：

1. 公共层（tool 描述 / 返回结构 / 截断规则 / helper 契约 / 底座默认参数）优化，先在主客户端
   （Gemini web 非代码模式）真实窗口验证；
2. 验证有效后，从 BADCASES 抽核心共性条目，在至少另一个客户端（ChatGPT / Claude）做同一行为回归；
3. 两端均正向 → 保留公共层；一端退化 → **不硬凑折中**，下沉到 `client-profile` / 底座配置隔离；
4. 任何一端未验证 → 只能写“主客户端通过、跨客户端未验证”，不得写“公共层已修复”；
5. 证据写进 BADCASES 的「跨客户端验证结果」列 / 回归记录区（客户端、buildCommit、requestId 或 unknown、两端结论）。

本批 PR80–101 公共层候选与当前验证状态：

| 公共层候选 | 主客户端（Gemini） | 第二客户端（ChatGPT/Claude） | 结论 |
|---|---|---|---|
| content notice 剥离（`result-normalize`） | 旧构建用户反馈为问题；当前 `5039ac6` **未复验** | **未执行** | `未验证` |
| PR number URL-first | 旧构建反馈为问题；当前 **未复验** | **未执行** | `未验证` |
| truncation metadata（tail/next） | 反馈要求但未同窗复验 | **未执行** | `未验证` |
| CI wait / rerun helper | 反馈要求；当前能力存在性未复验 | **未执行** | `未验证` |
| 批处理 wrapper 契约 | 反馈存在；当前未复验 | **未执行** | `未验证` |

已登记到 [BADCASES.md](BADCASES.md)「跨客户端防串伤回归记录区」。

## 5. requestId 与证据政策

- 主动反馈：`requestId: unknown`（原文无 requestId；不编造）；
- 被动归档：只引用 scorecard/analyzer 中**已存在的**真实 requestId 作为证据样本，不声称与主动反馈同会话；
- 本次真实命令没有产生新 requestId（未到达 capture 读取阶段）；
- 所有“未验证”项保持 `未验证`，不以 `NOT_ENOUGH` 当 pass。

## 6. 新真问题登记

- 本批**没有**确认新的产品级真问题（所有方向均已被 BC-001～BC-006 覆盖）；
- 新增的是**证据链缺口记录**：跨客户端验证未执行、R2/analyzer 凭据不可用、主动反馈与被动窗口无法对齐；
  已写入 BADCASES 回归记录区与本文，不冒充 badcase、不驱动改代码。

## 7. 未验证 / 阻塞清单

| 项 | 状态 | 原因 |
|---|---|---|
| 真实 `--last-minutes 60` R2 拉取 | **BLOCKED** | `R2_*` 未配置；命令 exit 1（`fetch failed`） |
| 免费模型真实分析 | **BLOCKED** | `ANALYZER_API_KEY` / `ANALYZER_BASE_URL` 未配置 |
| 同窗主动↔被动对照 | **NOT_ENOUGH** | 主动反馈无 requestId；归档被动窗口不同 |
| 跨客户端防串伤回归（ChatGPT/Claude） | **未验证** | 无真实第二客户端窗口 |
| 主客户端当前构建复验（Gemini, `5039ac6`） | **未验证** | 本任务不做真实窗口操作 |
| `CLIENT_PLATFORM_OAUTH_MAP` 实际配置 | **UNKNOWN** | 本机 Vercel CLI token 被 API 拒绝（见 #12 PR） |
