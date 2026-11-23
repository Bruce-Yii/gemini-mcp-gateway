# 架构深读审计 04 — 评测体系

> 只读审计，只写本报告。按用户六模块架构，针对「模块三：评测体系」做深读。
> 依据：`docs/FRAMEWORK.md`（用户原文 + 定稿）、`docs/EVALUATION.md`、`docs/eval/*`、
> `src/capture.js` / `src/capture-queue.js` / `src/project-tag.js`、
> `scripts/run-l1-smoke.mjs` / `scripts/replay-online-session.mjs` / `scripts/eval-cycle.mjs`、
> `explore/tasks-online-gap*.json`、`docs/ledger/batch-15-online*.md` 及官方/权威任务集相关 docs。
>
> 审计日期：2026-11-24（Asia/Singapore）。本审计不 commit / push / deploy，不改
> `src/`、`scripts/`、`tests/`、README、其它 docs 或 workflows。
>
> 口径：所有「已实现/状态」均来自当前 checkout 的文件与台账；台账自述的状态若与当前源码
> 冲突，以源码为准并标「陈旧」。fake / fixture / 无 baseline / 未部署 / unknown 一律不得算通过。

---

## 0. 审计结论（先看）

1. **用户原话的三条线都「有骨架、无闭环」**：离线基准确认（官方/权威任务集）有历史产物但
   不达「逐工具全覆盖 + 可发布分数」；主动线上评测有 `online-feedback.v1` schema 和三份
   人工记录，但全批 `requestIds:["unknown"]`、`captureVerified:false`，且主动/被动**没有
   字段隔离**；被动线上采集有 full-fidelity capture + project/session 标签，但**没有 task
   维度、没有自动采集线、没有主动反哺被动的机械闭环**。
2. **用户明确口径「主动 > 被动、主动反哺被动」在文档层已写对**（`FRAMEWORK.md` §13.2、
   `EVALUATION.md` §4、join §4），但**代码/数据层没有任何机制区分主动与被动**，也没有
   "同时间窗主动 vs 被动"的对照产物。当前所谓 online 几乎都是人工贴进来的用户报告。
3. **工具级真值是这个项目最扎实的资产**：被动 capture 缺任务级预期，但有可核验的工具级
   真值（同 args 重放、上游 API 核验、schema 断言、真形状 fixture、写后字节回读）；
   `replay-online-session.mjs` 已实现只读/dryRun 重放与分字段 diff。但这些仍**只在 fake
   fixture 上跑通**，真实 capture 端到端重放状态为 unknown。
4. **成熟度**：采集层 L2、半在线接线 L2、主动反馈 schema L2、官方离线集 L1–L2、
   闭环/自动采集 L0–L1、真实验收 L0–L1。整体处于 **L1–L2，未达可宣称"评测体系已建成"**。
5. **最重要的缺口**：主动/被动隔离字段、同时间窗对照、真实 capture 的 requestId 证据链
   （写路径尤其）、自动采集与标注抽样、评测自身质量（baseline 冻结/基准污染）、
   官方逐工具覆盖 Linear/Vercel 结构性 0、成本模型。
6. **发现一处文档陈旧**：join 文档/任务 J6 断言 checkout 无 `waitForPrChecks`，但当前源码
   `src/github-helpers.js:855` 已实现、`src/codemode.js` 已接线并进入 read-only helper 指引。
   旧断言不应继续作为「missing-capability/unknown」依据。

---

## 1. 用户原话校验（FRAMEWORK.md §0 §13，最高意图来源）

| # | 用户原话要点（摘自 §0/§13） | 文档是否落实 | 代码/数据是否落实 | 判定 |
|---|---|---|---|---|
| 1 | 「主动线上评测 > 被动线上评测；主动含金量更高」 | ✅ §13.2 明确写死 | ❌ 无主动/被动标识字段、无优先级/频度控制 | **文档是，实现否** |
| 2 | 「根据同一时间内的主动线上评测和被动线上评测做评估，并且反哺优化被动线上评测的设计」 | ⚠️ `EVALUATION.md` §2/§3、join §4 写了"同时间窗对照/主动反哺被动"的规则 | ❌ 无同时间窗对照产物；无"主动结论 → 被动规则/标签"的落地机制；`eval-cycle.mjs` 只审计"已登记轴是否仍覆盖" | **规则是，机制否** |
| 3 | 「被动缺任务预期但有工具级真值」 | ✅ §13.3 纠正为"被动缺任务级预期，但有工具级可核验真值"，列出同调用重放/上游 API 核验/schema/主动标签回填/已知 fixture | ⚠️ 重放与 schema/真形状 fixture 有实现（`replay-online-session.mjs`、`result-normalize.js`）；但真实 capture 端到端未跑通、上游 API 真值核验无独立产物 | **概念对，能力半通** |
| 4 | 「采集层按 session / project / task 等等交叉，这个交叉有助于被动线上评测的分析和优化升级」 | ✅ `EVALUATION.md`/`ARCHITECTURE-PROGRESSIVE.md` L4-2 写 join 目标 | ⚠️ `capture.js` envelope 有 `sessionId`、`projects[]`/`primaryProject`、`requestId`；**无 `taskId`**；`capture-digest` 出 sessions/windows 与 projectTimelines 聚合，但 task 维度缺失 | **部分（session+project 有，task 无）** |
| 5 | 「进行主动和被动的隔离评测」 | ✅ `FRAMEWORK.md` §4「必须隔离统计，不能混算」 | ❌ capture/scorecard/反馈记录均无 `evalMode=active|passive` 之类字段，scorecard 只有 `clientPlatform` 分账 | **未落实** |
| 6 | 「被动在线评测闭环还包含自动化采集线」 | ✅ 原文与 §2 写明 | ❌ 在线反馈 intake 明确「靠人工」（`CONTINUOUS-EVAL.md` §6、`batch-15-online-eval.md` §6）；`capture.js` 是请求路径自动记录，但"采集→分析→反哺"的线不自动 | **采集动作自动，闭环不自动** |
| 7 | 「用主动反哺被动，降低主动频率和成本，不是取消主动」 | ✅ §13.2 写明 | ❌ 无主动频率/成本指标，无"被动逼近主动"的量化指标 | **未落实** |
| 8 | 「按不同上游工具做官方/权威任务集全覆盖离线评测」 | ⚠️ `AUTHORITATIVE-TASK-SOURCES.md` 诚实登记天花板（Linear/Vercel 无权威 benchmark；191 任务中 108 官方逐字=56%） | ⚠️ 有 `explore/tasks-v2.json`（191）、G6 228、L1 50 与冻结基线；但"全覆盖"只对当前暴露工具，且权威 benchmark 无法直接跑 | **部分，结构性缺口已登记** |

> 校验结论：**意图层全部正确，方法层部分正确，实现层大面积缺失**。任何把现有 repo
> 描述成"主动/被动闭环已完成"的说法都与证据不符。

---

## 2. 当前实现清单（文件 / 命令 / 状态）

### 2.1 采集层

| 组件 | 文件 | 命令/触发 | 状态与证据 |
|---|---|---|---|
| full-fidelity capture | `src/capture.js` | 请求路径自动；`startCapture()` | 已实现。`gmg.capture.v1` envelope 含 requestId / sessionId / clientInfo / clientPlatform/clientProfile / mode / deployment / request{headers,raw} / events[] / response{raw,bytes,durationMs,overflow} / model 审计 / projects[]。full-fidelity，不做隐私过滤（符合 §6）。 |
| capture 审计行 | `src/capture.js` | `capture_ack` / `capture_done` / `capture_dropped` / `capture_sink_ok` / `capture_flush_end` | 已实现。`capture-verification-2026-11-23.md` 记录一次完整对账（requestId `602f4012…`，ack→done→sink_ok→R2 四证齐全）。**仅一次样本**，不能推广为线上普遍成立。 |
| 模型静默截断审计 | `src/capture.js` `buildModelOutputAudit()` | 自动（从 envelope 计算） | 已实现；字节规则（source vs visible，≤50% 且 ≥64B，无显式 truncated 标记），F-03 审计投毒已修。scorecard 2026-11-23 显示 9/20 请求有 suspect（advisory，不是判据）。 |
| 异步队列（降延迟） | `src/capture-queue.js` + `src/capture.js` 的 `CAPTURE_ASYNC_QUEUE=1` 分支 | 默认 OFF；opt-in | 代码层已实现并经 `tests/capture-queue*.test.js` 验证（22 + 9 项，见 batch-15-capture-queue / -integration ledger），但**生产 flag 是否开、线上延迟收益均未验证**。属于自动采集的基础设施，非闭环本身。 |
| project 标签 | `src/project-tag.js` `extractProjects()` | capture 时自动（纯函数） | 已实现；只从请求里的显式 owner/repo、代码字面量、PR URL 推导，`projects[]`/`primaryProject` 进 envelope。不猜自然语言。 |
| session 标记 | `Mcp-Session-Id`（`session-marker-2026-11-23.md`） | initialize 回传 | Gemini 实测有效；现代 MCP 已移除该头，未来需 clientInfo 兜底。**session 是 capture 关联用，不是服务端 sticky state**。 |
| 聚合/scorecard | `scripts/capture-digest.mjs` → `docs/eval/scorecard-*.{md,json}` | 每日 workflow（外部提及；本审计未核验 workflow 当前状态） | 已产出 `scorecard-2026-11-22/23`。含 sessions/windows、projectTimelines、platform 分账、modelTrunc。2026-11-23 scorecard 的 clientPlatform **全部是 unknown**（20/20），平台分账形同虚设。 |

### 2.2 主动线上评测

| 组件 | 文件 | 命令/触发 | 状态与证据 |
|---|---|---|---|
| schema + 校验器 | `docs/eval/ONLINE-FEEDBACK.md`、`scripts/record-online-feedback.mjs` | `node scripts/record-online-feedback.mjs <md> > work/online-feedback.json` | 已实现，`online-feedback.v1`；26 项测试（batch-15-online-eval §五）。纯校验、不联网。 |
| 反馈记录 | `docs/eval/online-feedback-2026-11-23.md`、`-chatgpt.md`、`-gemini.md` | 人工登记 | 3 份。Gemini 记录 F1–F6（+正面三项）；ChatGPT 记录 F1–F5+。**全部 `requestIds:["unknown"]`、`captureVerified:false`**，整批状态 `unknown`。 |
| 缺口抽象 | `docs/eval/SEMI-ONLINE-GAPS.md` | 文档 | 已实现 T1–T7 测试类、N1–N9 任务清单、G1–G6 缺口字典（join 文档内）。F1/F2 `pending-deploy`，F3–F5 `needs-repro`，F6 `unknown`。 |
| F×N/J join | `docs/eval/ONLINE-SEMIONLINE-JOIN-2026-11-23.md` | 文档 + `tests/online-semionline-join.test.js`（14/14） | 已实现逐条矩阵与配对规则。**注意其"wait helper 不存在"的结论已陈旧**（见 §0.6）。 |
| 主动反馈 → 半在线任务 | `explore/tasks-online-gap.json`（N1–N9）、`-2.json`（J1–J6） | 任务描述（fake/replay，禁真写） | 已登记；**不是 runner 实际执行的断言**，是"schema-valid 的任务描述"。 |

### 2.3 离线/半在线（含工具级真值）

| 组件 | 文件 / 命令 | 状态与证据 |
|---|---|---|
| L1 smoke | `scripts/run-l1-smoke.mjs --mode fake|real|replay` | 已实现。fake=50 任务确定性接线（报告自述 `fake-dry-run … not a gateway measurement`）；real 需凭据；冻结基线 `explore/baselines/l1-smoke.json`（G6 228 → smoke 50，runId `run-1795368949291-1d86ee2a`，git `6b4254c`）。有 baseline===current 自引用防护、failed-server 分母口径。 |
| online-gap profile | `run-l1-smoke.mjs --profile online-gap` | 已接线（batch-15-l1-gap-wire，21/21 测试）。加载 15 任务、0 SKIP；6 扩展指标（writePostConditionOk / idAsPrNumberCount / wrapperUnwrapDepthConsistent / truncationTailMetadataOk / atomicByDefault / ciWaitRounds）；**冻结基线 `explore/baselines/l1-online-gap.json` 当前不存在** → 全指标 `unknown`、报告标 `no frozen baseline: all metrics unknown`。这是"无 baseline，不得算通过"的典型。 |
| 在线会话重放 | `scripts/replay-online-session.mjs` | 已实现（22/22 测试，batch-15-online-replay）；`online-replay.v1`，同 prompt/args/profile 重放，写强制 dryRun，字段 diff（exactness/contract/truncation/path/id），host/model/timing 记 not-comparable。CLI fixture 输出 `verdict=diff`（诚实报差异）。**真实 capture 端到端 = unknown**。 |
| 持续 cycle | `scripts/eval-cycle.mjs` | 已实现（batch-15-continuous-eval）。一条命令跑 fake L1 + replay fixture + join 覆盖审计 + docs 检查 + 只读 baseline 对比，写时间戳 `docs/eval/eval-cycle-*.{json,md}`。当前 checkout 无 eval-cycle 报告产物；首跑预期 `NO_BASELINE`，显式不算 fail；`advisoryOnly:true`、`requiresHumanReview:true`。 |
| 真形状/工具级断言 | `tests/online-gap-regression.test.js`、`tests/gh-file-p0.test.js` | 部分。纯 `normalizeFileResult` 真形状 pass，guest/no-resources 两例 todo（P0-1/P0-2 红项）。T2/T4 部分 todo。不得当"已修通过"。 |
| 官方/权威逐工具集 | `explore/tasks-v2.json`（191）、`explore/tasks-g6.json`（228）、`docs/AUTHORITATIVE-TASK-SOURCES.md`、`docs/EXPLORATION-FINDINGS.md` | 历史产物。191 条覆盖全部暴露工具，105 官方逐字 + 86 schema 反向验证；108/191（56%）有官方来源；Linear/Vercel 权威 benchmark 结构性 0。**不适合发布分数**（文档自己写明）。 |
| scorecard | `docs/eval/scorecard-2026-11-22/23.{md,json}` | 已产出。2026-11-23: 20 请求、3 错误、9 modelTrunc suspects；平台全 unknown；1 个 project（github:Bruce-Yii/recruitment-agent）。 |

### 2.4 验证命令清单（本审计未执行会改变仓库状态的命令）

```bash
# 只读/离线
node scripts/record-online-feedback.mjs docs/eval/online-feedback-2026-11-23-gemini.md
node scripts/run-l1-smoke.mjs --mode fake
node scripts/run-l1-smoke.mjs --profile online-gap
node scripts/replay-online-session.mjs --fixture
node scripts/eval-cycle.mjs --now <fixed ISO> --tag audit
node --test tests/online-feedback.test.js \
         tests/online-semionline-join.test.js \
         tests/l1-online-gap-wire.test.js \
         tests/replay-online-session.test.js \
         tests/eval-cycle.test.js
```

> 本报告仅静态读取，未运行上述命令；测试数字引用自对应台账的自述结果，非本审计复跑。

---

## 3. 成熟度 L0–L3（含 fake/fixture/无 baseline 的判定规则）

评级定义：
- **L0** 无产物或只有口头/文档意图；
- **L1** 有文档/任务描述/fake 接线，但无可信真实数据；
- **L2** 代码层实现 + 确定性测试，局部真实样本；
- **L3** 有可重复真实证据、冻结基线、端到端闭环与线上复验。

| 能力 | 级别 | 依据 | 不得算通过的部分 |
|---|---|---|---|
| capture 采集（请求自动落 envelope） | **L2** | `src/capture.js` 全字段；一次 ack→R2 全链路对账 | 仅一次样本；生产 flag/延迟未验；写路径 envelope 覆盖缺口（`online-offline-join-2026-11-22.md`） |
| capture 队列/降延迟 | **L1–L2** | 原型 + 接线 + 单测（31 项） | 默认 OFF；线上收益/flag 未验；属基础设施非闭环 |
| session/project 交叉 | **L2** | session marker Gemini 实测；project-tag 纯函数；scorecard sessions/projectTimelines | **无 task 维度**；clientPlatform 全 unknown；session 跨窗口并不可靠（文档自述） |
| 主动反馈 schema/intake | **L2** | schema + 校验脚本 + 26 测试 + 3 份记录 | 全批无 requestId、无 captureVerified；纯人工 |
| 主动 > 被动 / 隔离 / 反哺 | **L0–L1** | 只有文档规则与 `eval-cycle` 的覆盖审计 | 无字段隔离、无同时间窗对照、无反哺机制、无主动成本/频度指标 |
| 被动工具级真值（重放/断言） | **L1–L2** | replay harness（22/22）、真形状 fixture、写后回读设计 | 只在 fake/fixture 上通；真实 capture 端到端 unknown；写只能 dryRun，真实写后条件靠受控仓库未做 |
| 半在线 L1 / online-gap 接线 | **L2** | profile 加载 15 任务、0 SKIP、6 指标、只读基线 | **无冻结 baseline（文件不存在）→ 全指标 unknown，fake 只验管线**；J6 旧断言陈旧 |
| 官方/权威离线集 | **L1–L2** | 191/228 任务、历史 G6 基线、覆盖率审计 | 56% 官方逐字；Linear/Vercel 权威 0；MCPMark 钉旧版会假 404；"适合找问题，不适合发布分数" |
| 闭环（online→半在线→部署复验→baseline 更新） | **L0–L1** | join 文档 + eval-cycle 定期核对 | 无真实部署后复验（J-DEPLOY 未执行）；baseline 未冻结/未更新；DRIFT/NO_BASELINE 是显式非失败 |
| 自动采集线 / 标注抽样 | **L0** | 无 | 明确人工 intake；无标注、无抽样、无偏差控制 |

**硬判定**：当前没有任何一条线达到 L3。任何"评测体系已完成/已验收"的表述都不成立。
`fake-dry-run`、`--fixture`、`NO_BASELINE`、`unknown`、`not-comparable`、`pending-deploy`、
`needs-repro`、缺 baseline、测试 todo 全部**不算通过**。

---

## 4. 缺口（按用户原话逐条对齐）

### 4.1 主动/被动隔离（用户明确要求）—— 完全缺失
- capture envelope 无 `evalMode`/`source`/`lane` 标识主动或被动；scorecard 只按
  `clientPlatform` 分账，且 2026-11-23 全部落 `unknown`。
- `online-feedback.v1` schema 的 `feedback[].evidence.source` 是 `user-report|pr|capture|log`，
  **不是主动/被动标记**；三份反馈记录都是用户报告（被动侧视角），却承担了"主动评测"的叙述角色。
- 后果：无法分别统计主动/被动的发现率、成本、覆盖；`FRAMEWORK.md` §4「必须隔离统计」无落点。

### 4.2 同时间窗主动 vs 被动对照 —— 规则有、产物无
- `ONLINE-FEEDBACK.md` §2 定义了 `time.window` + taskId + requestId 锚点，禁止猜；
  join §4 写"同 prompt/同构建/新会话/同预算/同判据"配对。
- 但实际记录 `Session: unknown` / `Task: unknown` / 全 `requestIds:["unknown"]`，**无法把任何一条
  主动反馈回连到一条被动 capture**，更谈不上同时间窗对照。
- "反哺被动"目前只是文档里的闭环箭头；没有"主动结论 → 被动规则/标签/采样策略"的
  数据结构或落地实例。

### 4.3 工具级真值与重放核验 —— 半通，真实链路断
- 已有：只读 + dryRun 重放、字段 diff、真形状 fixture、`normalizeFileResult`/`normalizePrResult`
  的契约测试、写后字节回读设计（N1/N9/J1）。
- 缺：
  - 真实 R2 capture → replay 的端到端流程（`batch-15-online-replay.md` §5 标 unknown）；
  - **上游 API 直接核验**作为独立真值来源（用户 §13.3 列出，但无对应产物/命令）；
  - 写路径 envelope 覆盖缺口（`online-offline-join-2026-11-22.md`），导致真实写的工具级真值
    无法从 capture 侧证实；
  - guest `fileResult` 真形状两例仍 todo（P0 红项），不能算"工具级真值已全绿"。

### 4.4 自动采集线 —— 动作自动、闭环不自动
- `capture.js` 自动落 envelope，但"采集 → 分析 → 抽象半在线轴 → 回归 → 反哺"的线由
  `eval-cycle.mjs` 做了**审计部分**（检查已登记轴是否仍覆盖），不产生新 F 条目、不自动
  更新 baseline、不接定时器（`CONTINUOUS-EVAL.md` §4/§6 明确禁止）。
- `record-online-feedback.mjs` 只做解析/校验，不 intake。用户原话的"自动化采集线"尚未成形。

### 4.5 标注 / 抽样 / 偏差控制 —— 空白
- `FRAMEWORK.md` §12.5/§12.6 已识别"被动缺用户意图/标准答案"与"主被动采样偏差"，但
  当前无标注 schema、无抽样策略、无偏差控制机制。
- scorecard 的 analyzer 输出按 `AGENTS.md` §1 只是假设，不能当标注真值。
- 被动 capture 无法判断用户意图是否达成，只能做工具级核验——这本身是合理的，但需要
  "主动任务标签回填"机制（§13.3 列出）来桥接，目前没有。

### 4.6 评测自身质量 —— 部分有防护，仍有风险
- 已有：baseline 只读/深冻结、fixture hash 身份、baseline===current 自引用防护、
  failed-server 分母剔除、DRIFT/NO_BASELINE 显式、allowlist 与权威等级标注。
- 缺：
  - `explore/baselines/l1-online-gap.json` 不存在 → online-gap 指标全 unknown，
    **无 baseline 不等于通过**；
  - 无基准污染/过拟合检测；主动任务是人挑的，不代表真实分布（§12.6）；
  - eval-cycle 签名只覆盖"任务 id/覆盖状态/fake 指标/replay verdict"，**不覆盖真实质量**；
  - 无"主动任务选择偏差"的量化。

### 4.7 成本 —— 只有规则，无模型
- `FRAMEWORK.md` §13.5 写"降低主动频率与成本"、"Firecrawl/Exa 浪费调用可优化"，
  但评测体系内**没有主动评测成本指标、没有 token/调用预算的评测侧统计**。
- L1 的 `tokensPerTask` 是跑任务成本，不是"主动评测成本"；两者不能混用。

### 4.8 官方逐工具覆盖 —— 结构性缺口 + 陈旧数据
- `AUTHORITATIVE-TASK-SOURCES.md`：权威 benchmark 只覆盖 GitHub/Notion；Linear/Vercel
  结构性 0；GitHub 19 条中 8–10 条 MCP 特有工具权威源没有；MCPMark 钉 `@1.9.1`、
  MCP-Atlas 用旧式 `notion_API-*`，与当前工具集对不上。
- 191 任务中 108 官方逐字（56%），83 条靠 schema 反向验证；**"全覆盖"只覆盖当前暴露工具，
  不等于权威全覆盖**，且任务集随工具快照漂移需持续维护。
- **陈旧断言**：J6 的 `skipReason`（"No waitForPrChecks / equivalent helper exists in the
  checkout"）与 join §1 的 F6 行已过时——`src/github-helpers.js:855` 已实现
  `waitForPrChecks`，`src/codemode.js:137/498/1435` 已接线。J6 应从
  "missing-capability/unknown" 升级为可执行的"single-wait 到终态"断言（仍需真实 CI run
  才可做线上复验）。

---

## 5. 渐进式延伸：下一层评测架构 / 接口 / 数据模型

> 严格按用户"渐进式"要求：先补最小数据模型与接口，再谈自动化，不引入 canary/shadow、
> 不做通用客户端能力检测框架（`FRAMEWORK.md` §13.7）。

### 5.1 数据模型（建议新增，均为 additive）

1. **evalMode 维度**（解决 4.1）
   - capture envelope 增加 `evalMode: "active" | "passive" | "unknown"` 与
     `sourceRef: { feedbackId?, taskId?, sessionId?, windowId? }`。
   - 主动：人工在真实客户端发起时显式标注；被动：默认 `passive`。**默认未知写 unknown，不猜**。
   - scorecard 增加按 `evalMode` 的分账表，与 `clientPlatform` 正交。

2. **主动/被动对照单元**（解决 4.2）
   - 新增 `eval-window.v1`：`{ window:{from,to}, platform, taskIds[], activeRefs[], passiveQuery, pairingRule }`。
   - 同时间窗内：用 `requestId`/`sessionId`/`project key` 做显式 join；对不上写 reason，
     不从 prompt 猜。禁止跨构建硬比（继承 join §4）。

3. **工具级真值记录**（解决 4.3）
   - 新增 `tool-truth.v1`：`{ requestId, tool, argsHash, truth: {kind: replay|upstream-api|schema|fixture|write-readback, expected, observed, ok, evidenceRef} }`。
   - 每条被动 capture 可挂 0..N 条 tool-truth；无 truth 不伪造。
   - 写后回读的 `writePostConditionOk` 是真值的一种，进同一模型。

4. **标注/抽样模型**（解决 4.5）
   - 新增 `annotation.v1`：`{ requestId, annotator, intent?, expectedOutcome?, labels[], confidence, source }`。
   - 被动抽样策略显式记录（随机/按 project/按错误类），偏差控制写进 window 文档。
   - 模型/analyzer 输出必须标 `source: model-hypothesis`，不进真值表。

### 5.2 接口（渐进扩展 `EvalHarness`）

```text
ingestOnline(record)        → 已实现（record-online-feedback）
tagEvalMode(envelope, mode) → 新增：主动/被动标注
joinWindow(window)          → 新增：同时间窗主动 vs 被动，显式锚点
attachTruth(requestId, t)   → 新增：工具级真值挂载
replaySession(captures)     → 已实现
runL1(profile)              → 已实现
runOfficialSuites(tool)     → 部分：历史任务集，需按当前工具快照重冻
compare(buildA, buildB)     → 仅同构建/同 prompt 配对，禁止硬比
report()                    → 已实现（scorecard / cycle）
```

不引入：自动修复、自动开 issue/PR、自动部署、自动更新 baseline、定时任务。这些既违反
`AGENTS.md` §1，也违反 `FRAMEWORK.md` §13.7。

### 5.3 分层路线（最小可验证链优先）

```text
第 1 层（先做）：加 evalMode 字段 + scorecard 分账 + 冻结 l1-online-gap baseline
第 2 层：真实 R2 capture → replay 端到端（先只读，再 dryRun 写）
第 3 层：eval-window 同时间窗对照 + 主动标签回填到被动 capture
第 4 层：标注/抽样模型 + 被动偏差控制 + 主动成本指标
第 5 层：自动采集线（intake → 抽象 → 回归 → cycle），仍保留人工裁决门
```

---

## 6. 可复用底层方法 / SOP

| 方法/SOP | 出处 | 复用方式 |
|---|---|---|
| 在线反馈闭环 9 步 | `EVALUATION.md` §3、`ONLINE-FEEDBACK.md` §4 | 每条新反馈照抄；未核实写 unverified，不许只写"已记录" |
| 显式锚点（时间窗/session/task/requestId/PR） | `ONLINE-FEEDBACK.md` §2 | 禁止猜；对不上写 reason；PR 不是 capture 证据 |
| F 矩阵 + G1–G6 缺口分类 | join §2、`SEMI-ONLINE-GAPS.md` | 每条 F 先答"能证明/不能证明"，再分类，不写 bug 清单 |
| T1–T7 测试类 | `SEMI-ONLINE-GAPS.md` §2 | 字节回环/负契约/真形状/发现成本/写安全/长会话/平台编码 |
| 同构建配对 5 同规则 | join §4、`TYPED-PLAN-TEST-PLAN.md` §1.3/§6.3 | 同 prompt/fixture/构建/会话边界/预算/判据；反序抵消；跨构建硬比作废 |
| 不可比指标清单 | `ONLINE-FEEDBACK.md` §2、`online-offline-join-2026-11-22.md` | durationMs≠p95、bytes≠tokens、在线无 runner 标签 |
| baseline 只读与身份 | `run-l1-smoke.mjs`、`L1-SMOKE.md`、batch-15-l1-gap-wire | 冻结文件读，当前结果分离；fixture hash 身份；NO_BASELINE 显式 |
| 工具级真值五式 | `FRAMEWORK.md` §13.3 | 同调用重放 / 上游 API 核验 / schema 断言 / 主动标签回填 / fixture 对照 |
| 写入先回归 | `AGENTS.md` §1 | 模型输出只是假设；先确定性回归 → 修 → L1 smoke；不自动改代码/开 issue/部署 |
| 分账不混算 | `batch-13-platform-eval.md`、`PLATFORM-CONFORMANCE-MATRIX.md` | 只认 envelope `clientPlatform`，缺失进 unknown；lane 独立分母 |
| 诚实状态词 | `ONLINE-FEEDBACK.md` §6、join §0.1 | unverified / needs-repro / pending-deploy / unknown 与 covered/weak/missing 不混用 |

---

## 7. 优先级 / 依赖 / unknown

### P0（阻断"评测体系可信"声明）
1. **加 evalMode 主动/被动字段并分账**（依赖：capture envelope additive 字段；不改契约）。
2. **冻结 `explore/baselines/l1-online-gap.json`**（依赖：lead 人审 + 真实或至少明确的
   fake 冻结口径；在此之前所有 online-gap 指标 unknown，**不得算通过**）。
3. **修正陈旧 J6 断言**：`waitForPrChecks` 已存在，J6 应改可执行断言（依赖：更新 join
   文档与任务集的 decide，属文档/任务层；本审计不改）。
4. **写路径 capture 覆盖核验**（依赖：真实 capture + requestId；当前 `online-offline-join`
   已登记缺口）。

### P1（闭环成形）
5. 真实 R2 capture → `replay-online-session.mjs` 端到端（依赖：人工导出 + 自身凭据，
   不进仓库）。
6. 同时间窗 `eval-window.v1` 对照与主动标签回填（依赖 P0.1/P0.4）。
7. 官方逐工具覆盖按当前工具快照重冻（依赖：权威源天花板已登记；Linear/Vercel 只能
   schema-reverse，不得宣称权威）。

### P2（降本与质量）
8. 标注/抽样模型与偏差控制（依赖 P1.6）。
9. 主动成本/频度指标与"被动逼近主动"量化（依赖 P0.1 + P1.6）。
10. 自动采集线（依赖 P0–P1 全部；且必须保留人工裁决门）。

### 依赖图（简化）

```text
P0.1 evalMode ─┬─→ P1.6 同时间窗对照 ─→ P2.8 标注 ─→ P2.9 成本 ─→ P2.10 自动线
P0.4 写路径证据 ─┘
P0.2 baseline ──→ 半在线指标可从 unknown 升级（非质量通过）
P0.3 J6 修正 ──→ 在线-only 轴从 unknown 升级为可执行
P1.5 真实 replay ──→ 工具级真值从 fake 变真实证据
P1.7 官方重冻 ──→ 离线基线可维护（仍非权威分数）
```

### Unknown / 未取证（不得被解读为通过）
- 生产是否启用 `CAPTURE_ASYNC_QUEUE`、线上延迟收益。
- 2026-11-23 scorecard 为何 clientPlatform 全 unknown（标签未生效 or envelope 旧）。
- 所有 F1–F6 的现网状态（旧构建未部署；无 requestId；`pending-deploy`/`needs-repro`/`unknown`）。
- 真实 capture 端到端重放、上游 API 真值核验、受控仓库写后回读、真实 CI wait helper run。
- `eval-cycle.mjs` 的真实运行报告（当前 checkout 无 `docs/eval/eval-cycle-*` 产物）。
- ChatGPT/Claude 真实 lane 的可用性与计划权限（`PLATFORM-CONFORMANCE-MATRIX.md` 标 unknown）。
- 最新全量测试结果（本审计未复跑；以 lead 最近一次为准，AGENTS.md §0）。

---

## 8. 附：证据索引（本审计实际读取的文件）

- 框架/意图：`docs/FRAMEWORK.md`、`docs/ARCHITECTURE.md`、`docs/ARCHITECTURE-PROGRESSIVE.md`
- 评测入口：`docs/EVALUATION.md`、`docs/eval/ONLINE-FEEDBACK.md`、`docs/eval/SEMI-ONLINE-GAPS.md`、
  `docs/eval/ONLINE-SEMIONLINE-JOIN-2026-11-23.md`、`docs/eval/TYPED-PLAN-TEST-PLAN.md`、
  `docs/eval/CONTINUOUS-EVAL.md`、`docs/eval/L1-SMOKE.md`、`docs/eval/ONLINE-GAP-TASKS.md`、
  `docs/eval/ONLINE-REPLAY-HARNESS.md`、`docs/eval/session-marker-2026-11-23.md`、
  `docs/eval/capture-verification-2026-11-23.md`、`docs/eval/scorecard-2026-11-23.md`
- 反馈记录：`docs/eval/online-feedback-2026-11-23{,-chatgpt,-gemini}.md`
- 源码：`src/capture.js`、`src/capture-queue.js`、`src/project-tag.js`、
  `src/github-helpers.js`（waitForPrChecks 实证）、`src/codemode.js`（接线实证）
- 脚本/任务：`scripts/run-l1-smoke.mjs`、`scripts/replay-online-session.mjs`、
  `scripts/eval-cycle.mjs`、`explore/tasks-online-gap.json`、`explore/tasks-online-gap-2.json`
- 台账：`docs/ledger/batch-15-online-eval.md`、`batch-15-online-semionline-join.md`、
  `batch-15-online-replay.md`、`batch-15-l1-gap-wire.md`、`batch-15-continuous-eval.md`、
  `batch-15-capture-queue.md`、`batch-15-capture-queue-integration.md`
- 官方/权威：`docs/AUTHORITATIVE-TASK-SOURCES.md`、`docs/EXPLORATION-FINDINGS.md`、
  `docs/ledger/batch-1-scenario.md`、`docs/WORKFLOW.md`（权威等级定义）

> 审计边界重申：本报告不修改任何被审计对象，不 commit / push / deploy；所有状态以当前
> checkout 为准，fake/fixture/无 baseline/unknown/未部署均不得算通过。
