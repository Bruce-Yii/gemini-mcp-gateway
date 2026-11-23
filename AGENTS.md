# AGENTS.md — gemini-mcp-gateway

本文件只写本项目特有、且与工作区根 `AGENTS.md` 不同的规则；通用规则以根文件为准。

最后更新：2026-11-23（Asia/Singapore）

---

## 0. 当前真实状态（先读，防止把“代码已修”当“线上已生效”）

- **生产是旧构建**：`https://gemini-mcp-gateway.vercel.app` 仍在跑旧代码；
  Vercel 免费额度 `100 deployments/day` 已用尽，最新修复**未部署**。
  因此：
  - 不能写“线上已修好”；
  - 不能拿旧构建的在线反馈直接判新代码仍失败；
  - 部署窗口恢复后，必须重新跑 `healthz` / `tools/list` / 在线同任务复验。
- **工作区全量测试以最近一次 lead 跑出的结果为准**；不要用其他 agent 的中间态。
  当前基线：`1381 tests / 1375 pass / 0 fail / 6 todo`（2026-11-23 晚，提交 `7a82c1d` 后）。
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

## 8. 部署纪律（必须遵守）\n\n- 默认每天 ≤ 3 次生产部署；不为单点小改动部署。\n- docs/tests-only、中间态修复、未过全量测试的改动一律不部署。\n- 部署前过 `docs/DEPLOY-POLICY.md`；部署后记录 `docs/DEPLOYMENTS.md`。\n- 能本地/回放验证就不要发 preview。\n- 当前生产：`87d91af`（验收门 A PASS），下一次等完整批次。\n\n## 9. 当前不要做的事

- 不要声称 Vercel 已部署最新代码；
- 不要声称 ChatGPT Free/Plus 支持完整 MCP；
- 不要公开 OSS 仓库 / push / 建远端；
- 不要为过测试保留无标记截断；
- 不要用 DSH token 给网关做授权；
- 不要在没有 A/B 数据时默认切 typed-plan；
- 不要用 `unknown_tool` 猜客户端行为。

---

## 10. 恢复时先读

1. `docs/EVALUATION.md`
2. `docs/EXECUTION-PLAN.md`
3. `docs/ledger/README.md`
4. `docs/AUTH-READY.md`
5. `docs/OPEN-SOURCE/RELEASE-LOCAL.md`
6. `docs/HANDOFF-2026-11-23.md`\n7. `docs/ACCEPTANCE.md`（V0 真实验收门；测试绿 ≠ 验收）\n8. `docs/DEPLOY-POLICY.md`（少部署/批量部署）\n9. `docs/DEPLOYMENTS.md`（部署日志）
