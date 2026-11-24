# AGENTS.md — gemini-mcp-gateway

> **框架/架构入口（最高优先级）**：先读 `docs/FRAMEWORK.md`。
> 用户原文、六个模块、主动/被动线上评测、客户端/上游 SOP、部署/开源架构都以它为准；以后框架性/架构性沉淀只写该文件。
> 目标态/渐进路线见 `docs/FRAMEWORK-FULL.md`。

本文件只写本项目特有、且与工作区根 `AGENTS.md` 不同的规则；通用规则以根文件为准。

最后更新：2026-11-25（Asia/Singapore）

---

## 0. 当前真实状态（先读，防止把“代码已修”当“线上已生效”）

- **生产已部署 `f2002d9`**（2026-11-25 01:55 手动 `vercel --prod`，带 `VERCEL_GIT_COMMIT_SHA`）：`https://gemini-mcp-gateway.vercel.app` healthz 已核 `commit=f2002d9…` / `buildHash=3b1a0772…` / `builtAt=2026-11-24T17:54:55.59Z`；`deploymentId=dpl_6P2Ww8vsTHXbbSF98GTE55HKitB4`。
  本次合并 PR #29：Linear 切 `static_bearer` PAT（`https://mcp.linear.app/mcp/readonly` + `LINEAR_API_KEY`），Notion 改网关自有 OAuth/DCR（`owner=gateway`）；production 新增 `LINEAR_API_KEY` / `UPSTREAM_OAUTH_ADMIN_KEY`。
- **`main=cd23fdc`**（PR #28 评测工具层修复已合、**未部署**）；不要声称线上包含 #28。
- **线上上游实况（`f2002d9` 实测 2026-11-24T18:17Z）**：GitHub 42 / Linear 27 / Vercel 73 / Figma 47 tools 在线（合计 189）；`linear__list_teams` 成功，Linear PAT 路径已验证。
  **Notion 仍 `offline`（0 tools、`needsReauth`）**：OAuth 授权已落 KV（`owner=gateway`、`source=gateway-dcr`、`refresh=yes`，直接 `tools/list` 200），但运行时 `_resolveToken()` 在无 `tokenEnv` 时提前 return，请求不带 `Authorization`。PR #31 修复中、**未合并**；在合并部署并复验 `codemode.services()` 前，不能写“Notion 可用”。
- **入站安全变量名**（只记名字，严禁记录值）：生产已生效 `OAUTH_APPROVE_PASSPHRASE`（PR #26，consent 审批口令；缺失/错误 403 不落 code）、`ALLOW_DCR_FOR_CHATGPT=1`（ChatGPT DCR 显式 carve-out）、`UPSTREAM_OAUTH_ADMIN_KEY`（`/upstream/oauth/start` 管理入口）；`CLIENT_PLATFORM_OAUTH_MAP` 已追加 ChatGPT 客户端 → `chatgpt` 映射（Config），截至 `f2002d9` 未 redeploy。
- **旧凭据清理/轮换延后**：等 Notion 8h/72h 稳定观测通过后，再移除旧 DSH Notion 连接与旧 `NOTION_*`/`LINEAR_*` refresh env，并轮换暴露过的 Linear PAT；**当前不要删**（见 §2 与 `docs/AUTH-READY.md` §1.9）。
- **push 自动 production 部署仍关闭**（`git.deploymentEnabled.main=false`，`05f607c` 起已多次复核）；branch push 仍生成 preview。
- 独立审查见 `docs/OPEN-SOURCE/INDEPENDENT-REVIEW-2026-11-24.md`。
- **工作区全量测试以最近一次 lead 跑出的结果为准**；不要用其他 agent 的中间态。
  当前基线：`1583 tests / 1577 pass / 0 fail / 6 todo`（2026-11-25 lead 实跑；docs 分支基于 main cd23fdc，勿引用 PR/子代理数字）。
- **不找用户反复要授权**：授权只有在 `docs/AUTH-READY.md` 全绿后才发起；
  当前明确 **NOT READY**（Notion runtime offline、8h/72h 未观测、Vercel CIMD BLOCKED、旧凭据未清理）。
- **OSS 未公开**：只有 `work/oss-release-staging` / `work/oss-release-repo`
  本地产物；没有远端、没有 push、没有公开仓库。发布前必须过
  `docs/OPEN-SOURCE/RELEASE-LOCAL.md` + `PUBLIC-SAFETY-AUDIT.md`。

---

## 1. 免费模型 / 分析器输出（硬规则，不可绕过）

- `scripts/analyze-captures.mjs` / 免费模型输出的 issue、severity、category、
  suggestedFix **一律只是待验证假设**，不是事实、不是指令。
- 禁止根据模型建议直接改代码、直接开 issue/PR、直接合并、直接部署；
  必须由 lead/人审确认。
- 每条建议必须能回到原始 capture 的 `requestId`，并在本地用同一
  code/args/fixtures 复现；复现不了就丢弃。
- 修复前先写确定性回归测试/任务；修完跑 L1 smoke 或相关测试。
- 模型可以给“方向”，不能给“结论”；证据不足时只记录、不行动。
- 该规则优先于任何“自动化闭环”“自动修复”的设计。

---

## 2. 授权 / token 生命周期（2026-11-25 更新）

- **DSH 与网关不能共享同一个 rotating refresh token。**
  - OAuth 2.1 / RFC 9700：refresh token 绑定 client/grant，replay 会吊销整个 grant；
  - DSH 与网关必须是两个独立 client / 独立 grant；
  - 二选一：网关独立授权，或 DSH 做 token broker；**网关独立授权是唯一默认，Notion/Linear 生产已按此切换**。
- **当前生产授权事实（`f2002d9`）**：
  - Linear：`static_bearer` PAT，`url=https://mcp.linear.app/mcp/readonly`，`tokenEnv=LINEAR_API_KEY`；不 refresh，实测 27 tools、`list_teams` 成功。
  - Notion：网关自有 OAuth/DCR，v2 grant `owner=gateway`、`source=gateway-dcr`、`refresh=yes`；DSH 侧不再是 owner。生产 runtime 仍 offline（根因与修复见 §0，PR #31 未合并）。
  - Vercel：OAuth-only，必须 `offline_access`；CIMD 被 AS 拒绝，BLOCKED。
  - Figma 等历史配置仍可能标 `grantOwner=dsh`；`owner=dsh` 只是迁移兼容值，不是产品 owner 类型；完全态 owner 见 `docs/FRAMEWORK-FULL.md`。
- 网关 token 记录必须带：
  - `owner`（gateway / dsh / manual）；
  - `source`、`grantId`、`environment`；
  - v2 KV key：`gmcgw:v2:grant:<env>:<owner>:<server>`；
  - legacy v1 key 只读，不写。
- 只有 `owner=gateway` 才允许自动 refresh；
  `owner=dsh` / 未标记必须拒绝自动刷新，只允许显式长期 access token。
- 本地默认 `environment=local`；Vercel 无 `VERCEL_ENV` 默认 `preview`；
  绝不让本地/预览读写 production key。
- **入站最小暴露**：
  - `/oauth/authorize` consent 必须过 `OAUTH_APPROVE_PASSPHRASE`（常量时间比较；缺失/错误 403、不落 code、不打印口令）；
  - DCR 默认关闭（LOCKED）；只有显式 `ALLOW_DCR_FOR_CHATGPT` / `ALLOW_DCR_FOR_CLAUDE` 才 carve-out；
  - `/upstream/oauth/start` 必须带 `UPSTREAM_OAUTH_ADMIN_KEY`（值不记录）；
  - 生产同时存在预注册 client 与 DCR 两套接入，属已知分裂；统一 Client Registry 是 **Issue #27**（M6 开源前必须）。
- **旧凭据清理顺序（强制）**：Notion 8h（至少跨一次自动 refresh）+ 72h 无 `invalid_grant` 通过 → 移除旧 DSH Notion 连接 → 移除旧 `NOTION_*`/`LINEAR_*` refresh env → 轮换暴露过的 Linear PAT → 复验 `codemode.services()`/`search`。**观测通过前禁止删除/轮换**。
- token / client_secret / PAT / passphrase / admin key 永远不进 stdout、日志、git、公开文档。
- `docs/AUTH-READY.md` 是唯一“何时找用户授权”的门禁；不是全绿就不要发起授权。

---

## 3. 在线 ↔ 半在线评测（强制流程）

在线反馈不是“记一条事件”就结束。每条反馈必须走：

```text
online-feedback.v1 记录
  → F 矩阵（能证明/不能证明）
  → G1–G6 缺口分类
  → 对应 N/J/T 半在线任务
  → 确定性测试/任务
  → 旧构建 vs 新构建同任务对照
  → 部署后在线复验
  → 更新 join / baseline
```

必读：

- `docs/EVALUATION.md` — 总架构/L0–L4/未落实清单
- `docs/eval/ONLINE-FEEDBACK.md` — schema/流程
- `docs/eval/SEMI-ONLINE-GAPS.md` — 缺口抽象 + N1–N9
- `docs/eval/ONLINE-SEMIONLINE-JOIN-2026-11-23.md` — F1–F6 + J1–J6
- `explore/tasks-online-gap.json`、`explore/tasks-online-gap-2.json`
- `scripts/replay-online-session.mjs`、`scripts/run-l1-smoke.mjs --profile online-gap`

硬规则：

- 没有 `requestId` 就写 `unknown`，不补造 UUID；
- 不跨构建硬比；旧构建/新构建分列；
- 不把 durationMs/bytes 换算成 tokens 或 p95；
- 数据不足就标 `NOT_ENOUGH`，不自动切默认；
- 客户端宿主不可控部分记 `unknown`，不记网关 pass/fail；
- 不能只写“已记录”就结束；必须进半在线任务/测试。

### 3.1 主动评测触发接续规则（`[云端总控]` 定型）

只要用户把**主动线上评测结果**或**真实会话优缺点/改进反馈**丢进开发窗口，Agent 必须立即按以下 5 步接续，缺一不可：
1. **保留原文**：原封不动保存用户/客户端原文与当前 `buildCommit`；
2. **按动作范围锚点拉同期被动日志对照**：优先依据主动回复第 0 条给出的「起止动作锚点 + 关键 PR/Issue/分支/文件名」（不要求客户端猜时间戳），配合 `node scripts/analyze-captures.mjs --last-minutes 60`（按需指定 `--platform` / `--commit`）卡出对应 R2 被动日志窗口，核对问题在 `subCalls` / `servers` / `clientPlatform` 中是否可见；
3. **记入分类 Badcase**：按 `客户端 × 上游(含跨上游) × 问题类别` 登记进 `docs/eval/BADCASES.md`，作为高价值抽测与全量回归资产；
4. **派单复现修复**：换受控测试仓库复现动作并修复，高频核心问题同步补进离线确定性测试；
5. **被动反哺核对**：顺手确认“为什么刚才被动分析没抓到/有没有抓到”，若漏抓则补采集字段或调优分析提示词。

### 3.1.1 主动评测触发探针（开发窗口必跑，M5-E 定型 2026-11-24）

当用户在本窗口粘贴**主动评测结果 / 真实会话反馈**（任何形式、语言），必须按以下顺序执行，缺一不可：

1. **原文落盘 + 生成 active-eval**：
   - 把原文（不转述、不删减）、`buildCommit`、动作范围锚点、expected/observed 写进
     `work/active-<date>.json`（字段见 [docs/eval/EVAL-CLOSURE.md](docs/eval/EVAL-CLOSURE.md) §1）；
   - `node scripts/record-active-eval.mjs --input work/active-<date>.json --raw work/active-<date>.txt --out docs/eval/active-eval-<date>.json`；`--raw` 是逐字原文，缺它直接失败（不存摘要）；
   - 校验失败（退出码 2）先补字段，**不得跳过**；`requestId` 没有就写 `unknown`，不编造。
2. **拉同窗口被动**：
   - 本地有 R2：`node scripts/analyze-captures.mjs --last-minutes 60 --commit <build> [--platform <p>] --dry-run --out work/analyzer`；
   - 本地没有 R2（当前常态）：`gh workflow run capture-daily.yml -f last_minutes=60 -f commit=<build>`，
     完成后 `gh run download <run-id> -n capture-digest -D work/run-<run-id>`。
3. **同窗对照**：
   `node scripts/compare-active-passive.mjs --active docs/eval/active-eval-<date>.json --passive work/run-<run-id>/analyzer/analyzer-output-*.json --out docs/eval/active-passive-<date>.json --json`
   - 结果必须含 `match`（exact/likely/weak/unmatched）、`missed[]`、`dataStatus`；
   - `EMPTY_WINDOW` 表示“没有数据”，不是通过；`unmatched` 要写原因，不硬配。
4. **登记与分类**：新真问题按 `客户端 × 上游 × 类别` 写进 [docs/eval/BADCASES.md](docs/eval/BADCASES.md)，
   带 `activeEvalId`/`requestId`/`buildCommit`/回归任务；`node scripts/check-badcases.mjs --strict`
   要求新条目两个字段非空；`missed` 项必须落到“补采集字段/补提示词/补确定性测试”之一。
5. **反哺 + 重跑**：改完后用同一条 active 记录重跑第 2/3 步；`missed` 清零才算反哺生效；
   否则写 `NOT_ENOUGH` + 原因，不更新 baseline/不宣称修复。

禁止：只写“已记录/已分析”就结束；编造 requestId；跨构建硬比；把免费模型输出当结论；未复验就写“修好”。

### 3.2 公共层 vs 平台隔离层 — 跨客户端防串伤规则（`[云端总控]` M4-C 定型）

同一个网关服务多个客户端，**公共层**（tool 描述、返回结构、截断规则、helper 契约、执行底座默认参数）的优化不能只在一个客户端验证就宣称“修好”。

对任何公共层优化，强制按以下规则判定（缺一不可）：

1. **主客户端验证**：先在主客户端（当前 Gemini web 非代码模式）真实窗口验证有效，保留原文与 `buildCommit`；
2. **跨客户端防串伤**：验证有效后，从 [docs/eval/BADCASES.md](docs/eval/BADCASES.md) 抽出核心共性条目，在**至少另一个客户端**（ChatGPT / Claude，按可用性）做同一公共层行为的回归；
3. **两端均正向 → 保留公共层**；任何一端未验证，只能写“主客户端通过、跨客户端未验证”，**不得写“公共层已修复/已通过”**；
4. **一端正向、一端退化 → 不硬凑折中方案**，下沉到对应客户端的 `client-profile` / 底座配置做隔离（按客户端分叉），公共层保持两端都成立的子集；
5. **证据落库**：跨客户端回归必须写进 `docs/eval/BADCASES.md` 的「跨客户端验证结果」列或「跨客户端防串伤回归记录区」，字段包含：客户端、`buildCommit`、`requestId`（没有就写 `unknown`，禁止编造）、主客户端结论、第二客户端结论；
6. 该规则优先于“单个客户端体验优化”的发布冲动：未完成跨客户端回归的公共层改动，不得进入“已修复”状态。

---

## 4. Code Mode / 工具面

- 当前对外只有 **3 个稳定工具**：`search` / `execute_read` / `execute`；
  顺序/名称/schema 不得在会话中途改变。
- `execute_read` 是只读通道；`execute` 是读写通道。写操作必须有
  dryRun / host approve；guest 不能靠 per-step approve 自授权。
- Gemini 不消费 `notifications/tools/list_changed`；改 schema 必须换版本路径
  （例如 `/mcp/v2`），不能原地改。
- `ENABLE_MCP_V2=1` 才启用 `/mcp/v2`；默认关闭；v1 逐字不变。
- `/mcp/v2` 仍是同名同序三工具；`plan` 是入参，不是第四个工具。
- typed-plan 的写 op：
  - 截断读默认拒绝（`PATCH_READ_TRUNCATED`）；
  - per-step `approve` 显式拒绝（`APPROVAL_REQUIRES_HOST`）；
  - 只有 host `options.approve` 或 dryRun 两条路。
- 结果编码：
  - Gemini：text JSON，无 `structuredContent`；
  - ChatGPT：`structuredContent` + text JSON（profile 隔离）；
  - Claude：text + annotations；
  - annotations 不是安全边界。
- 文件读取的 `content` 必须是纯正文；download notice/SHA 只放独立元数据；
  notice-only 时 `content==''`，不能悄悄把提示写回文件。

---

## 5. 结果 / 截断 / 写路径

- 禁止静默字符截断；截断必须有字段级元数据（field/total/tail/next）。
- 读写分离：`execute_read` 不接受写 op；`execute` 才可写。
- 写多文件默认优先 `writeFiles` / `push_files` 原子入口；
  失败保留 `partial:true` / `written` / `remaining` / `compensation`。
- PR `number` 必须 URL 优先 `/pull/(\d+)`；`id`/`nodeId` 只作独立字段，
  **永不**用 id 兜底 number。
- raw upstream envelope 与 canonical output 必须区分；raw 不得无标记泄漏到
  capture/模型可见输出（capture 仍按 full-fidelity 保存，见 §6）。

---

## 6. capture / 安全

- capture 目标是 **full-fidelity**：用户明确禁止对 capture 做隐私/安全过滤；
  不要把“脱敏 capture”当修复。
- 但 **模型可见错误** 必须做 secret 形态脱敏（Bearer/ghp_/github_pat_/API key 等）；
  不要把上游原始错误里的 token 回显给模型。
- 安全审计发现（`docs/eval/CODEMODE-SECURITY-AUDIT.md`）中：
  - 已修：typed-plan 截断写、per-step approve、模型错误脱敏、截断审计误判、
    预算绕过、`__proto__` 原型污染、fallback `truncated` 语义；
  - F-08/F-09 已修（residual-security-fix）；仅真实上游 401、Docker build、npm audit 未验证；
  - 不要把“capture 原样保存”误认为“可以回显给模型”。
- 不碰真实凭据：`config.example.json` 只能占位；真实 token 不进仓库/日志。
  本地凭据从 vault 读；只有当 refresh token 真正失效且 AUTH-READY 全绿时，
  才向用户发起一次授权。

---

## 7. 并发 / 写作用域

- 每个 agent 只写自己声明的文件；跨文件需求先给 lead 发消息。
- 同一文件多 agent 并发是事故源；发现冲突立即停下报告。
- 不要互相“代提交”；提交由 lead 统一做。
- 大改动前先读 `docs/EXECUTION-PLAN.md` 与最近 ledger。

---

## 8. 部署纪律（必须遵守）

- 不设固定部署次数；没有值得部署的进展就不部署，有明确进展/必须实测就部署。
- docs/tests-only、中间态修复、未过全量测试的改动一律不部署。
- 部署前过 `docs/DEPLOY-POLICY.md`；部署后记录 `docs/DEPLOYMENTS.md`，并跑
  `node scripts/check-status-drift.mjs --expected <deployed-commit>` 确认 AGENTS/STATUS 没有旧 build 引用。
- 能本地/回放验证就不要发 preview。
- 当前生产：`f2002d9`（2026-11-25 手动部署；`buildHash=3b1a0772…`；A 门当前构建可追溯；B–G 未完成）；下次部署应在 PR #31 合并且全量测试绿后，用于修复 Notion runtime 并复验 `codemode.services()`/`search('notion')`；纯文档/评测脚本改动（如 `main cd23fdc`）不部署。

## 9. 当前不要做的事

- 不要声称 Vercel 已部署最新代码（生产是 `f2002d9`，`main cd23fdc` 未部署）；
- 不要声称 Notion 生产可用：runtime 仍 offline（0 tools），PR #31 未合并、未部署；
- 不要删除旧 DSH Notion 连接 / 旧 `NOTION_*`/`LINEAR_*` refresh env，也不要轮换 Linear PAT（等 Notion 8h/72h 观测通过）；
- 不要打印、记录或提交任何 passphrase / admin key / PAT / client secret 值（只写变量名）；
- 不要声称 ChatGPT Free/Plus 支持完整 MCP；
- 不要公开 OSS 仓库 / push / 建远端；
- 不要为过测试保留无标记截断；
- 不要用 DSH token 给网关做授权；
- 不要在没有 A/B 数据时默认切 typed-plan；
- 不要用 `unknown_tool` 猜客户端行为。

---

## 10. 恢复时先读

1. `docs/FRAMEWORK.md`
2. `docs/ARCHITECTURE-INDEX.md`（唯一渐进式架构主目录）
   - 实时项目状态雷达：`docs/STATUS.md`（逐客户端/上游实况、P0 四态与 Top 3 打点）
3. `docs/HANDOFF-NEXT-WINDOW.md`（新窗口接手必读）
2. `docs/EVALUATION.md`
3. `docs/EXECUTION-PLAN.md`
4. `docs/ledger/README.md`
5. `docs/AUTH-READY.md`
6. `docs/OPEN-SOURCE/RELEASE-LOCAL.md`
7. `docs/HANDOFF-2026-11-23.md`
8. `docs/ACCEPTANCE.md`（V0 真实验收门；测试绿 ≠ 验收）
9. `docs/DEPLOY-POLICY.md`（少部署/批量部署）
10. `docs/DEPLOYMENTS.md`（部署日志）

---

## 11. 子代理编排（默认按架构模块并行）

> 原则：**能并行的独立工作不要自己串行做**。默认为按 `docs/ARCHITECTURE-INDEX.md` 的
> M1–M6 模块 / L2 子模块 / 工作包拆 lane，而不是按“一句话任务”拆。root 仍对最终结果、
> diff review、测试、合并与部署负责；子代理输出不是证据，必须由 root 复核。

### 11.1 何时必须 fan-out

满足任一即应拆：

- 任务跨 **≥2 个架构模块**（M1–M6），或跨 **≥3 个互不依赖的文件/工作包**；
- 需要**独立或对抗性验证**（审计、复现、边界检查、第二意见）；
- 可并行的只读研究（每模块 / 每上游 / 每客户端 / 每评测层一条 lane）；
- 大规模机械改动（多文件迁移、重命名、批量替换）且写域可切分。

不得 fan-out（root 自己做并说明原因）：

- 强串行依赖，前一步结果决定后一步；
- 多个 lane 必须写同一个文件/同一目录；
- 需要单一上下文才能做的最终裁决、合并冲突解决、部署判断。

### 11.2 怎么拆

- **按架构轴**：M1 Client（`src/client/`）、M2 Execution（`src/execution/`）、
  M3 Upstream（`src/upstream/`）、M4 Evidence & Eval（`src/evidence/` + `scripts/`）、
  M5 Runtime（`src/runtime/` + `src/shared/`）、M6 Release（`scripts/export-oss.mjs` + `docs/OPEN-SOURCE/`）。
- 写任务必须给每个子代理**互斥写域**（文件/目录前缀），并记录在委派消息或共享任务里；
  跨文件需求先报 root 切 scope，不允许“顺手改一下”。
- 只读审计按模块、上游、客户端、L0–L3 评测层分 lane；不要再按“前端/后端”这类非本项目轴拆。
- **1–2 个独立委派**用 `subagent` / `subagent_fork`；**≥3 个独立 lane** 用 `workflow` 脚本
  fan-out（`pipeline` / `parallel`），不要逐轮串行。
- 每个子代理 prompt 必须含：目标、输入路径、写域（或只读）、验收命令、禁止项
  （不改共享文件 / 不提交 / 不合并 / 不部署 / 不打印 token）、输出 schema
  （findings / files / tests）。
- 独立 lane **同时启动**；root 在等待期间继续做不冲突的集成/验证，不忙轮询。

### 11.3 边界与验收

- 子代理默认**只读**；写权限仅限分配的不相交 scope；不得代提交、合并、部署或碰真实凭据。
- root 必须在合并前 review 最终 diff、跑相关测试/审计；子代理不得自行宣称“通过”。
- 若因冲突/串行依赖没有 fan-out：在回复里写明“未 fan-out 的原因”，不能沉默单干。
- 评测/审计类子代理结论必须能回到 `文件:行` / 命令 / 数据证据；无证据的结论按 advisory 处理。
- 共享任务目录按 scope 组织：同一模块的写任务串行，跨模块的只读/写任务可并行。
