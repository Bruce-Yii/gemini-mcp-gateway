# AGENTS.md — gemini-mcp-gateway

> **框架/架构入口（最高优先级）**：先读 `docs/FRAMEWORK.md`。
> 用户原文、六个模块、主动/被动线上评测、客户端/上游 SOP、部署/开源架构都以它为准；以后框架性/架构性沉淀只写该文件。
> 目标态/渐进路线见 `docs/FRAMEWORK-FULL.md`。

本文件只写本项目特有、且与工作区根 `AGENTS.md` 不同的规则；通用规则以根文件为准。

最后更新：2026-11-23（Asia/Singapore）

---

## 0. 当前真实状态（先读，防止把“代码已修”当“线上已生效”）

- **生产已部署 `5039ac6`**（2026-11-24 07:45 手动部署）：`https://gemini-mcp-gateway.vercel.app` healthz 已核 `commit=5039ac69…` / `buildHash=c060691d…`。
  本次部署包含：owner 标记（未标记 grant 永不 refresh、legacy 例外删除）、入站 origin 一致性
  （issuer/resource/401/CIMD 跟随请求 host）、preview/production KV 隔离检查脚本。
  “部署成功”不等于验收通过：真实客户端、真实写回环 CI、授权生命周期、同任务在线复验仍未完成；不能写“线上已验收”。
- **push 自动 production 部署仍关闭**（`git.deploymentEnabled.main=false`，`05f607c` 起已多次复核）；branch push 仍生成 preview。
- 独立审查见 `docs/OPEN-SOURCE/INDEPENDENT-REVIEW-2026-11-24.md`。
- **工作区全量测试以最近一次 lead 跑出的结果为准**；不要用其他 agent 的中间态。
  当前基线：`1518 tests / 1512 pass / 0 fail / 6 todo`（2026-11-24 feedback 修复后，lead 实跑；Node20 为 1511 pass，1 个 TS 用例按能力 skip）。
- **不找用户反复要授权**：授权只有在 `docs/AUTH-READY.md` 全绿后才发起；
  当前明确 **NOT READY**。
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

## 2. 授权 / token 生命周期（2026-11-23 架构结论）

- **DSH 与网关不能共享同一个 rotating refresh token。**
  - OAuth 2.1 / RFC 9700：refresh token 绑定 client/grant，replay 会吊销整个 grant；
  - DSH 与网关必须是两个独立 client / 独立 grant；
  - 二选一：网关独立授权，或 DSH 做 token broker；**默认网关独立授权**。
- `owner=dsh` 只是当前迁移兼容值，不是产品 owner 类型；完全态 owner 见 `docs/FRAMEWORK-FULL.md`。
- 网关 token 记录必须带：
  - `owner`（gateway / dsh / manual）；
  - `source`、`grantId`、`environment`；
  - v2 KV key：`gmcgw:v2:grant:<env>:<owner>:<server>`；
  - legacy v1 key 只读，不写。
- 只有 `owner=gateway` 才允许自动 refresh；
  `owner=dsh` / 未标记必须拒绝自动刷新，只允许显式长期 access token。
- 本地默认 `environment=local`；Vercel 无 `VERCEL_ENV` 默认 `preview`；
  绝不让本地/预览读写 production key。
- Provider 事实：
  - Notion MCP：OAuth/DCR，或 Business/Enterprise static MCP token；无普通 API key；
  - Linear 官方 MCP：支持 Bearer PAT（优先 static_bearer），也可 OAuth；
  - Vercel：OAuth-only，必须 `offline_access`；CIMD 目前被 AS 拒绝，BLOCKED。
- token / client_secret 永远不进 stdout、日志、git、公开文档。
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
- 部署前过 `docs/DEPLOY-POLICY.md`；部署后记录 `docs/DEPLOYMENTS.md`。
- 能本地/回放验证就不要发 preview。
- 当前生产：`5039ac6`（2026-11-24 手动部署 PR80-101 feedback fixes；A 门当前构建可追溯；B–G 未完成）；下次在有真实客户端/写回环证据时再部署。

## 9. 当前不要做的事

- 不要声称 Vercel 已部署最新代码；
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
