# Batch 11 · W4：Gemini 自适应 Code Mode（结构化原语 vs 自由脚本）A/B 设计

> 状态：**设计方案，未实现、未改代码**。把 PLAN-2026-11-23 §3 P1「Gemini 下 Code Mode 收敛」、
> §4.2/§4.3、§5 W4 落成可执行的 profile + A/B 实验。
> **本次不改** `src/`、`scripts/`、`tests/`、`README`、其他 docs、workflows；**未 commit / push / deploy**。
> 遵循 `AGENTS.md` 硬规则：免费模型 analyzer 输出只是 advisory；任何结论必须回到 requestId + 本地复现 + 人审。

## 一、现状证据（不要空泛，全部有出处）

### 1. 外部证据：Gemini 在 Code Mode 下回退
- `docs/PLAN-2026-11-23.md` §2.3 / §3：`IJCA 2026` 论文（[链接](https://www.ijcaonline.org/archives/volume187/number136/benchmarking-llm-tool-orchestration-in-resource-constrained-agentic-workflows-native-mcp-function-calling-vs-code-mode/)）
  显示 Code Mode 平均省 token/成本，但 **Gemini 家族通过率明显回退**。这是"外部 benchmark"，
  不是我们的线上数据，不能直接当本地结论。
- `docs/GEMINI-OFFICIAL-DOCS.md` §2/§3：Google 官方 MCP 集成标准**反对 mega-tool**
  （"Treat tools as atomic endpoints without inside tool conditions or multiple functionalities"），
  而我们 `execute(code)` 正是万能执行器。官方倾向原子工具；分析指出
  "Google 的模型是围绕原子工具优化的"——与论文方向一致。§4 明确标注这些影响是**推断，未实测**。
- `docs/CODEMODE-SURVEY.md`：Vercel AI SDK 用 `toolDiscovery:'conversation'` 保持工具定义不变
  （"improves prompt-cache reuse"），且**明确不支持需要审批的工具进 code mode**；
  Cloudflare 官方自己仍把 `@cloudflare/codemode` 标 Experimental。AGENTS.md 据此规定
  "Code Mode 以源码为准，不写进契约，改 schema 要换版本路径"。

### 2. 本地证据：toolHit 31–53%、searchHit 44–82%（分层）
证据来源 `docs/eval/l1-real-2026-11-22.md`（冻结基线 run `run-1795368949291-1d86ee2a`，git `6b4254c`，模型 hy4-flash-free）：

| 切片 | completionRate | gatewayAnomalies | searchHit | toolHit | tokens/task | p95 ms |
|---|---:|---:|---:|---:|---:|---:|
| 整体 50（含 Figma） | 76% | 21 | 86.4% | **51.3%** | 15,691 | 22,025 |
| real 默认 40（跳过 Figma） | 77.5% | 18 | 82.4% | **53.3%** | 16,547 | 22,709 |
| figma（10） | 70% | 3 | 100% | **44.4%** | 12,266 | 18,563 |
| notion（10） | 50% | 3 | 62.5% | **0%** | 29,398 | 25,632 |
| linear（10） | 60% | 8 | 75% | 62.5% | 20,303 | 27,296 |
| vercel（10） | 100% | 6 | 90% | 70% | 8,003 | 12,435 |
| github（10） | 100% | 1 | 100% | 100% | 8,486 | 14,210 |

补充：`docs/ledger/batch-4-figma.md` G6（228 tasks / 873 turns / 718 calls）searchHit **85.3%** /
toolHit **52.9%**；`docs/EXPLORATION-FINDINGS.md` Notion 专项 toolHit **59.4%**。
用户给的 31–53% / 44–82% 区间与上述冻结数据一致（figma toolHit 44.4% 是低点，github 100% 是高点）。

### 3. 在线证据：Gemini 实测确实走自由脚本，且确认粒度粗
- `docs/eval/online-offline-join-2026-11-22.md` requestId `10c13554-6936-4a93-9ef2-9662fa55d1c6`：
  Gemini 的 `execute_read` 脚本里调了 `github__get_file_contents` ×3、`sliceLines`、`notion__notion_search`、
  `linear__list_teams/linear__list_issues`、`vercel__list_projects/list_deployments`、`figma__whoami/get_metadata`
  ——**一个脚本跨 5 个上游自由编排**。
- `docs/HANDOFF.md`：10 个上游写操作只用了 **2 次 `execute`**（Gemini 把每个服务写步骤批量塞进一次
  execute），"Gemini 的确认粒度是一次 execute 工具调用，不是每个上游写操作"。
- `docs/GEMINI-REAL-TASK-FEEDBACK.md`：模型把 toolCalls 审计里的 args 截断/摘要不足，
  "只有 return 值进入上下文"未完全兑现 → 触发 B11 静默截断 P0 系列
  （`batch-11-truncation*.md`）。说明自由脚本路径容易踩坑。

### 4. 已有原语（方案要基于它们，不重造）
- 三工具面 `search` / `execute_read` / `execute` 稳定（`AGENTS.md`、`docs/WHY.md` ≈1,286 tokens）；
  工具名双下划线、schema 过 `sanitizeTool`、结果文本 JSON——**这些约束不能因 profile 改变**。
- `src/codemode.js:173-235` `validateToolArgs`（入参轻量校验）、`codemode.js:558-570,900`
  写工具在 `execute_read` 里被替换成会抛可操作错误的 stub（读写分层）；
  `src/codemode.js` 有 50 次调用上限和 deadline（`docs/SANDBOX-SECURITY.md`）。
- `src/github-helpers.js`：`ensureBranch/upsertPr/fetchAllPages/repoGrep`（B10 P1，host 纯模块，**未接 codemode**）；
  `src/file-write.js`：`applyFilePatch/writeFiles`（B10/B11.6，原子写 + compensation）。
- `docs/ledger/batch-10-integration.md`：host helper 接入 code mode 是"唯一允许改 codemode.js 的任务"已做；
  新增 profile 必须沿用该接入面，不要另起一套。

## 二、方案：Profile + A/B 实验（不直接改代码）

### 2.1 两种 profile（实验变量只有一个：原语暴露形态）

| | **Profile S（Structured，结构化原语默认）** | **Profile F（Free，现状自由脚本 / 对照组）** |
|---|---|---|
| 工具面 | 三工具不变 + 在 `search`/`execute` 的 **description/guidance** 里优先推荐固定原语（readFileRange/applyPatch/ensureBranch/upsertPr/fetchAllPages/repoGrep），给出 2–3 个完整 JS 片段示例 | 现有 `search`/`execute`/`execute_read`，只有现状 guidance，不新增原语推荐 |
| 原语形态 | 把 `src/github-helpers.js` 与 `file-write.js` 的 host helper **以固定签名挂到 `codemode` 命名空间**（B10 P1 原语接入），返回固定字段；模型不再手写 sha/分页/分支兼容代码 | 现状：模型自己在脚本里调原始上游工具并拼逻辑 |
| 读写分层 | 不变：`execute_read` 仍只暴露只读原语，写原语只在 `execute` 可见 | 不变 |
| schema / 工具名 | **完全不变**（`AGENTS.md`：Gemini 不吃 tools/list_changed，改 schema 要换版本路径） | 不变 |
| 沙箱/隔离 | 不变（QuickJS `run` SDK，真隔离） | 不变 |
| 运行时切换 | **不做会话中途切换**；profile 由"部署配置 + 版本化工具路径"决定，一个客户端会话内固定 | 同左 |

**关键约束**：Profile S 只改 **description 文字 + 在沙箱已挂载的 codemode 命名空间里增挂 helper**，
**不改工具 name/参数 schema**（避免 Gemini 不重连时拿到不一致定义；`docs/HANDOFF.md:36` 说明
用户不重连也能用最新版工具定义，这是因为 name/schema 没变——Profile S 必须保持这条性质）。
若实测必须改 schema，则按 AGENTS.md 要求**换版本路径**，不在原路径上改。

### 2.2 任务分层（按任务类型选 profile，是"自适应"的核心）

用现有 50-task smoke / 228-task G6 的子集，按 `docs/eval/L1-SMOKE.md` 的 byServer 切片分层：

| 层 | 任务特征 | 预期更优 profile | 依据 |
|---|---|---|---|
| L-A 简单多步 | 单服务、2–4 步、已知工具（github/vercel 读、list issues/deployments） | **S** | github/vercel toolHit 100%/70%，原语可直接覆盖，自由脚本反增转义/语法风险（`DSH-CODEMODE-FIT.md:154`） |
| L-B 写路径 | 建分支/写文件/建 PR（B10/B11.6 原语已覆盖） | **S** | 现状写确认粒度粗（HANDOFF.md），原语把 sha/幂等/分页收口，减少模型手写兼容代码 |
| L-C 探索/跨服务 | 跨 ≥3 服务、目标不确定、需要 `search` 多轮（figma/notion 语义类） | **F 或 S+guidance** | figma toolHit 44.4%、notion 0%——原语救不了检索 miss；保留自由脚本探索能力，只加 guidance |
| L-D 纯检索 miss | searchHit 低的语义/编号类（PR #123、Notion 语义、附件） | **两者都跑，仅作对照** | `batch-4-figma.md` G5/`docs/HANDOFF.md:215`：53/191 miss 是语义类，profile 不该背锅 |

> 分层只用于**实验分组与结果解读**，不是在生产运行时按内容自动选 profile（自动路由需要
> 分类器，属于后续能力；本方案明确不做，见 §六）。

### 2.3 A/B 实验设计

- **单位**：task（50 smoke 或 228 G6 子集），按 taskId 确定性分组（hash(taskId) % 2），
  **同一 task 既跑 S 又跑 F**（配对设计，消除任务难度差异），顺序固定 F→S 并记录模型温度/种子。
- **模型**：两组用同一模型。本地 runner 用 hy4-flash-free（现有基线同模型）；
  **Gemini 侧**：在网页端用同一账号、同一 prompt 分别跑 S/F 版本（需 profile 版本路径切换），
  记录 capture 的 `clientInfo`（已落，`batch-11-recent.md` §3）。
- **样本量**：每 profile ≥ 全部 50 smoke task（配对 = 100 次执行）；L-C/L-D 额外从 G6 取
  figma(10)+notion(10) 配对。样本不足时只报方向，不报"显著"。
- **数据留痕**：每次执行生成 requestId；capture 记录 `profile`、`taskId`、`layer`、toolCalls、
  searchHit/toolHit 标注、modelVisibleOutput（B11.3 已做截断标记），与 R2 envelope 可对账。
  免费模型 analyzer 只 advisory，**验收看确定性指标，不看 analyzer 的"我觉得更好"**。

### 2.4 指标与验收门控（数据决定默认）

主指标（沿用 `docs/eval/L1-SMOKE.md` 容差：completionRate/searchHit/toolHit 各 10% / +3）：

| 指标 | 来源 | S 相对 F 的验收线 |
|---|---|---|
| completionRate（anomaly proxy） | `explore/results/metrics.json` | **不低于** F −3pp（不因原语变差） |
| toolHitRate | 同上 | L-A/L-B **≥ F**；整体 ≥ 51.3% 基线 −3pp |
| searchHitRate | 同上 | ≥ 基线 86.4% −10%（profile 不该影响检索） |
| tokens/task | 同上 | **≤ F**（原语应减少手写兼容代码；这是 S 的核心卖点） |
| 手工兜底代码量 | sandbox toolCalls 里 `sliceLines`/手写 sha/分页循环的出现次数 | L-A/L-B **下降**（≥30% 为有效） |
| gatewayAnomalyCount | anomalies.json | 不高于 F |
| p95LatencyMs | metrics.json | 不因多挂 helper 明显变差 |

**决策规则（事前写死，防事后找理由）**：
1. S 在 L-A/L-B 各项达标 **且** tokens/task 不升 → **Gemini 默认 profile = S**；L-C/L-D 保留 F。
2. S 在 L-A/L-B 与 F 打平但 tokens 反升 → 只把原语 guidance 加进 F（profile 不切换），记录 DEC。
3. S 在任一层 completionRate 掉 >3pp → **不切换**，回查是 guidance 误导还是原语签名问题，
   定位前不上线。
4. Gemini 网页端实测若与本地 hy4 结论相反 → **以 Gemini 为准**（目标是 Gemini），
   本地数据只作辅助；但必须回到 requestId 回放确认不是 capture/截断污染。

### 2.5 不直接改代码的交付形态

本次只产出本文档。实现阶段独立工单建议顺序：
1. 写 profile guidance 文本 + 示例（改工具 description 文字，**name/schema 不变**）；
2. 在 `codemode` 命名空间增挂已有 host helper（`src/github-helpers.js`/`file-write.js`，
   沿用 `batch-10-integration.md` 的接入面）；
3. 加 capture 的 `profile`/`taskId`/`layer` 字段（与 W6 checkpoint 的 taskId 埋点协同）；
4. 跑 A/B 配对实验；5. 按决策规则选默认，写 DEC 进台账。
每步都要确定性回归测试 + 人审，不凭模型建议直接切默认。

## 三、收益 / 风险

### 收益
- 用本地 + Gemini 双源数据回答"Gemini 到底该用哪种形态"，不再靠论文推断。
- 结构化原语把 sha/幂等/分页/patch 收口（`B10`/`B11.6` 已实现），减少模型手写兼容代码。
- 保留自由脚本给探索任务，不牺牲复杂场景的表达力。
- 不破坏三工具面稳定、不改 schema、不触碰 OAuth/契约。

### 风险（逐条）
| 风险 | 缓解 |
|---|---|
| 改 description 仍可能影响 Gemini 行为（prompt 敏感） | name/schema 不变；按 AGENTS.md 如需改 schema 则换版本路径；A/B 用配对设计隔离文字影响。 |
| 原语 guidance 误导模型在探索任务上硬套原语 | 分层里 L-C/L-D 明确默认 F；guidance 写"简单多步才用原语"。 |
| `execute_read` 的只读 stub 与原语混用造成混淆 | 原语沿用现有读写分层（写原语只在 execute 可见），不新增第三种可见性。 |
| 本地 hy4 结论不代表 Gemini | 双源实验；决策规则 #4 以 Gemini 为准；capture 的 clientInfo 区分来源。 |
| 截断/审计污染指标（B11 静默截断 P0） | 用 B11.3 的 modelVisibleOutput/truncated 标记过滤；回放 requestId 确认。 |
| 免费模型 analyzer 误把相关性当因果 | advisory-only；验收只看确定性指标 + 人审（AGENTS.md 硬规则）。 |
| 样本小导致"看起来好" | 配对设计 + 明确样本量；不足时只报方向不报显著。 |

## 四、依赖

- **已有**：三工具面与稳定 schema（AGENTS.md）；读写分层（`src/codemode.js`）；host 原语
  `github-helpers.js`/`file-write.js`（B10/B11.6，未接 codemode 但已实现）；capture 的
  sessionId/clientInfo/截断标记（B11.1/B11.3）；L1 smoke 基线冻结（`l1-real-2026-11-22.md`）。
- **前置**：原语接入 codemode（`batch-10-idempotent.md` §二列为"后续 P1 接入"）；
  taskId/profile 埋点（与 W6 checkpoint 协同，见 `batch-11-durable-state.md` §四）。
- **并行**：与 W6（持久状态）、W7（维护性）可并行；W4 自身不阻塞其他工作流。
- **顺序**：A/B 实验必须在原语接入 + 埋点完成后跑，否则无法归因。

## 五、明确不做

- 不改工具 name / 参数 schema；不做会话中途工具列表变更（Gemini 不消费 list_changed）。
- 不实现运行时自动分类器按任务内容选 profile（本方案只做静态分层实验）。
- 不升级 MCP 到 2026-07-28、不双栈（`mcp-2026-07-compat.md`）。
- 不改 sandbox 隔离模型、不引入 embedding/新依赖。
- 不根据论文或免费模型建议直接切默认——必须过 A/B 数据 + 人审。
- 不改 `src/`、scripts、tests、README、其他 docs、workflows；不 commit/push/deploy。
