# 新窗口接手文档 — gemini-mcp-gateway

> 给下一个接手的 agent / 人。
> **不要先信这份文档，也不要先信上一任 lead 的验收结论。**
> 你的任务不是“接着跑测试”，而是独立判断：这个网关到底能不能在真实客户端、真实仓库、真实授权下可靠工作。
>
> 当前日期锚点：2026-11-24（Asia/Singapore）。
> 当前生产：`758a232`。当前验收：**V0 只过了 A（部署可追溯）**，整体 **NOT ACCEPTED**。
> 当前全量回归基线：1381 tests / 1375 pass / 0 fail / 6 todo（接手后请自己重跑）。

---

## 0. 你的角色与边界

### 角色

你是新的 **lead / 独立审查者**，不是上一任 lead 的复读机。

你要做四件事：

1. **独立审查**：不接受“测试绿=完成”，要自己构造真实任务、真实客户端、真实写入、真实授权验证。
2. **判断风险**：区分代码候选、部署成功、真实验收、线上可用四层状态。
3. **并行推进**：能并行的用子代理并行；不能并行的按依赖串行；你负责集成。
4. **对用户负责**：不粉饰、不编造、不拿测试数当验收；证据不足就说不足。

### 硬边界

- **不要把“文档写了”当“已经实现”。**
- **不要把“测试通过”当“真实可用”。**
- **不要把“部署成功”当“验收通过”。**
- **不要在 AUTH-READY 全绿前找用户要授权。**
- **不要在用户明确同意前公开 OSS、建远端、push、打 tag。**
- **不要在没有证据时写“完成 / 修好 / 验收通过”。**
- **不要对 capture 做隐私/安全过滤**（用户明确要求 full-fidelity）；但模型可见错误必须脱敏。
- **不要共享 DSH 与网关的 rotating refresh token。**
- **不要用日历排期/日期计划**；用户明确反感。用依赖、批次、验收门表达。

---

## 1. 项目一句话

`gemini-mcp-gateway` 是面向 Web AI 客户端的 MCP 网关：

- 上游：GitHub / Notion / Linear / Vercel / Figma 等 MCP server；
- 对外：3 个稳定工具 `search` / `execute_read` / `execute`；
- 核心：Code Mode（QuickJS 沙箱）+ 渐进发现 + canonical 结果 + 读写分离 + full-fidelity capture + 在线/半在线评测；
- 形态：单 owner、自托管，不做多租户。

不是“工具聚合器”，价值是：

> 把工具定义/结果上下文压到最小，同时让上游工具可发现、可执行、可审计、可回归。

---

## 2. 当前真实状态（接手先核）

### 已确认

- 生产：`https://gemini-mcp-gateway.vercel.app`
  - `/healthz` 返回 `commit=758a2320caf84f1bc2f5ed1fff3ba20bbe234472`
  - `buildHash=02c96881...`
  - 验收门 A：PASS（仅“部署可追溯”）。
- 回归：1381 tests / 1375 pass / 0 fail / 6 todo（自己重跑确认）。
- 安全修复：模型错误脱敏、截断审计、预算、`__proto__`、typed-plan 截断/approve 等已修。
- 评测：在线记录、F/G 矩阵、N1–N9、J1–J6、L1 online-gap profile、replay harness、eval-cycle 已存在。
- OSS：本地 staging / release repo 可审计，301 文件级别，无 remote/push/tag。

### 未确认 / 不通过

- V0 验收 B–G 未过；
- 真实 Gemini/ChatGPT 任务未跑；
- 真实写回环未在验收仓库跑；
- 真实授权生命周期未做；
- Vercel CIMD 被 AS 拒绝，BLOCKED；
- 同构建/同任务在线复验未做；
- Docker build、npm audit 未跑；
- online-gap baseline=none；
- 独立 evaluator 未跑；
- 线上是否真的可用：**未知**。

### 一句话

> 代码候选 + 已部署 + 安全修复较多，但真实可用性没有被独立证明。

---

## 3. 必读文档（按顺序）

### Tier 0：不读不要动手

1. `AGENTS.md`
2. `docs/ACCEPTANCE.md`
3. `docs/DEPLOY-POLICY.md`
4. `docs/EVALUATION.md`

### Tier 1：进度与阻塞

5. `docs/EXECUTION-PLAN.md`
6. `docs/HANDOFF-2026-11-23.md`（顶部历史表可能过时，以文末 checkpoint 为准）
7. `docs/AUTH-READY.md`
8. `docs/ledger/README.md`

### Tier 2：评测体系

9. `docs/eval/ONLINE-FEEDBACK.md`
10. `docs/eval/SEMI-ONLINE-GAPS.md`
11. `docs/eval/ONLINE-SEMIONLINE-JOIN-2026-11-23.md`
12. `docs/eval/TYPED-PLAN-TEST-PLAN.md`
13. `docs/eval/CONTINUOUS-EVAL.md`
14. `docs/eval/README.md`

### Tier 3：安全 / 发布

15. `docs/eval/CODEMODE-SECURITY-AUDIT.md`
16. `docs/OPEN-SOURCE/RESIDUAL-RISK-AUDIT.md`
17. `docs/OPEN-SOURCE/PUBLIC-SAFETY-AUDIT.md`
18. `docs/OPEN-SOURCE/RELEASE-LOCAL.md`
19. `docs/OPEN-SOURCE/FINAL-HEALTH-AUDIT.md`
20. `docs/DEPLOYMENTS.md`

### Tier 4：具体台账

21. `docs/ledger/batch-15-auth*.md`
22. `docs/ledger/batch-15-security*.md`
23. `docs/ledger/batch-15-oss*.md`
24. `docs/ledger/batch-14-typed-plan*.md`
25. `docs/ledger/batch-15-online*.md`

---

## 4. 必读代码（按顺序）

### 入口 / OAuth / 路由

1. `api/index.js`
2. `src/vercel-app.js`
3. `src/server.js`
4. `src/oauth.js`
5. `src/upstream-oauth.js`

### 上游 / token / 存储

6. `src/upstream-auth.js`
7. `src/upstreams.js`
8. `src/store.js`

### Code Mode / 写路径 / 结果

9. `src/codemode.js`
10. `src/codemode-v2.js`
11. `src/typed-plan.js`
12. `src/tool-format.js`
13. `src/result-normalize.js`
14. `src/github-helpers.js`
15. `src/file-write.js`

### 平台 / 结果编码

16. `src/client-platform.js`
17. `src/client-profile.js`
18. `src/sanitize.js`

### Capture

19. `src/capture.js`
20. `src/capture-queue.js`

### 先读测试

21. `tests/gh-file-p0.test.js`
22. `tests/codemode-ergonomics.test.js`
23. `tests/typed-plan-security.test.js`
24. `tests/residual-security-fix.test.js`
25. `tests/local-e2e-verify.test.js`
26. `tests/online-semionline-join.test.js`

---

## 5. 你必须独立审查的东西

### P0 — 真实可用性

- [ ] 生产 healthz 的 commit/buildHash 是否真的与验收 commit 一致；
- [ ] 真实 Gemini web 窗口跑固定任务，记录 exact tool call/args/actual；
- [ ] 真实 ChatGPT（如果账号计划允许）同样；
- [ ] 文件读取 `content` 是否纯正文，notice/SHA 是否只在元数据；
- [ ] PR `number` 是否 URL 优先，id/nodeId 是否只作独立字段；
- [ ] 真实 read→patch→commit→PR→CI 回环；
- [ ] 失败是否留半成品；
- [ ] 大返回截断是否保留末尾关键字段；
- [ ] 批处理包装是否一致；
- [ ] CI wait helper 是否真的减少轮询。

### P0 — Auth

- [ ] 是否还有共享 DSH refresh token；
- [ ] owner/source/grantId/environment 是否正确；
- [ ] 重启后是否仍可用；
- [ ] preview/production/local 是否隔离；
- [ ] Linear PAT / Notion token 是否真的在 vault 且 tools/list 通过；
- [ ] Vercel CIMD 是否真的被 AS 接受；
- [ ] `AUTH-READY.md` 每一项是否有真实证据；
- [ ] 回滚演练是否真的做过。

### P0 — 安全

- [ ] 模型可见错误是否不含 token（真实上游 401 实测）；
- [ ] capture 是否仍 full-fidelity（不要被“安全修复”改成脱敏）；
- [ ] 预算是否覆盖 v1/v2/typed-plan/actions；
- [ ] `__proto__`/constructor 守卫是否有效；
- [ ] 截断 flag 是否不矛盾；
- [ ] Docker build / npm audit 是否有结论；
- [ ] 是否有未修的 F-08/F-09 类边界。

### P1 — 评测真实性

- [ ] L1 fake 是否被当成质量证据；
- [ ] online-gap baseline 是否真的存在，不是 `none`；
- [ ] replay 是否真的用了真实 capture，而不是 fixture；
- [ ] 117 个 OSS skip 是否每个都有原因；
- [ ] 测试是否在自证（测试和实现共享同一错误假设）；
- [ ] 独立 evaluator 是否跑过；
- [ ] 旧构建 vs 新构建是否同任务对照。

### P1 — 文档/代码一致性

- [ ] README token 数字是否与 `measure-context` 一致（当前应为 3,564 / -98.5%，不是 1,520 / -99.4%）；
- [ ] HANDOFF/EXECUTION-PLAN 是否又过时；
- [ ] AGENTS 是否仍声称旧构建；
- [ ] package identity 是否统一；
- [ ] OSS staging 是否还有真实 id/owner/路径；
- [ ] `/healthz` 与 Docker healthcheck 是否一致。

### P1 — OSS

- [ ] staging 0 真实个人 handle / 真实 DB id / 真实域名 / 个人路径；
- [ ] `export-oss --check` PASS；
- [ ] local release repo 无 remote/tag；
- [ ] 没有任何人把“本地通过”当“可以公开”；
- [ ] LICENSE/README/release notes 未定项仍在人工清单里。

---

## 6. 工作方式

### 证据规则

- 没有命令/字段/requestId 的“通过”视为 FAIL；
- `unknown` 是合法状态，不要填假值；
- 不跨构建硬比；
- 不把 durationMs/bytes 换算成 tokens/p95；
- 不把 fake/replay/SKIP 当 pass。

### 在线 ↔ 半在线

```text
在线反馈
  → online-feedback.v1
  → F 矩阵
  → G1–G6 缺口
  → N/J 任务
  → 确定性测试
  → 旧/新构建同任务对照
  → 部署后在线复验
```

不要只记录一条事件就结束。

### 子代理

- 能并行的用子代理；每个 agent 只写自己的文件；
- 同一文件不要多 agent 并写；
- agent 不 commit / push / deploy；
- 你负责最终 diff、测试、集成、提交；
- 大 fan-out 才用 workflow；一两件事用普通 subagent；
- 给 agent 的 prompt 要写清：范围、禁止事项、验收、并发冲突。

### 当前可用模型

- 子代理默认可用：
  - provider：`opencode-go-openai-key2`
  - model：`hy4-flash-free`
- 如果模型不可用/限流，换其他可用模型；不要让整个任务卡死。
- 免费模型输出仍只是假设，必须复核。

### 部署

- 不设固定次数上限；
- 没有值得部署的进展就不部署；
- 有明确进展 / 必须真实实测 / 紧急修复就部署；
- docs/tests-only 不部署；
- 部署后 healthz + 目标验证 + `docs/DEPLOYMENTS.md`。

### 授权

- `AUTH-READY.md` 不全绿不找用户；
- 不共享 DSH token；
- 一次授权只做一次，不反复。

### OSS

- 用户没明确批准：不建远端、不 push、不打 tag、不公开；
- 发布前必须过安全审计 + identity + staging 测试 + 人工清单。

---

## 7. 密钥 / 环境 / 本机资产

> 只给位置和名字，**不要把值写进文档、日志、聊天**。

### 本地 vault

`D:\12412\dsh-home\.secrets\gemini-mcp-gateway\`

常见文件（以实际为准）：

- `github-auth.json`
- `notion-oauth.json`
- `linear-auth.json`
- `vercel-auth.json`
- `figma-oauth.json`

### Vercel

- CLI 登录：`%APPDATA%\com.vercel.cli\Data\auth.json`
- 生产环境变量在 Vercel project：`gemini-mcp-gateway`
- 可用 `vercel env pull` 到临时文件；**不要提交、不要打印值**。
- 关键 env 名称（以实际项目为准）：
  - `GITHUB_TOKEN`
  - `NOTION_TOKEN` / `NOTION_REFRESH_TOKEN` / `NOTION_CLIENT_ID`
  - `LINEAR_TOKEN` / `LINEAR_CLIENT_ID`
  - `VERCEL_TOKEN`
  - `FIGMA_*`
  - `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`
  - `CAPTURE_*`
  - `UPSTREAM_OAUTH_ADMIN_KEY`
  - OAuth 客户端锁定：`ALLOWED_CLIENT_ID` / `ALLOWED_CLIENT_SECRET`
- 不要用 `vercel env pull` 的结果做公开文档。

### 本地测试资产

- `work/local-chatgpt-app.mjs`：本地 OAuth/网关测试 app（可能引用旧 tunnel URL）；
- Cloudflare quick tunnel / ngrok：只用于测试，不是生产；
- 旧进程可能仍在 3000 端口，接手先检查；
- `work/` 下日志/staging 不是公开资产。

### 代码/CI

- GitHub：`Bruce-Yii/gemini-mcp-gateway`（私有）
- 不要自动 push 公开仓库；
- 分支/PR 前先确认用户意图。

---

## 8. 已知坑（上一任踩过）

1. **Vercel 部署额度**：100/day，别为小改反复点。
2. **DSH/网关共享 refresh token**：会互相吊销 grant，绝对不要。
3. **Notion DCR**：client 要持久化；重复注册会产生孤儿 grant。
4. **Vercel CIMD**：本地/公开 gist 都被 AS 拒绝，不是“加个 header”能解决；BLOCKED。
5. **Gemini 不消费 tools/list_changed**：改 schema 必须版本路径。
6. **capture full-fidelity 与模型错误脱敏不矛盾**：raw 给 capture，redacted 给模型。
7. **`fileResult`/`content` notice**：旧构建/旧路径会污染；必须纯正文。
8. **PR number 用 id 兜底**：绝对禁止。
9. **截断**：无标记截断是 P0；截断 flag 不能自相矛盾。
10. **typed-plan approve**：guest 不能自授权；写必须 host approve/dryRun。
11. **OSS 个人 handle 可用转义形式泄漏**：detector 必须解码。
12. **117 个 OSS skip 不是 pass**：必须逐条有原因。
13. **Docker daemon/npm audit 可能不可用**：报告要写 NOT-RUN，不要写 PASS。
14. **本地 fake/loopback 不是线上**：不要混淆。
15. **旧生产构建**：接手时先核对 healthz，不要假设。

---

## 9. 第一个小时做什么

1. 读 AGENTS / ACCEPTANCE / EVALUATION / EXECUTION-PLAN；
2. 跑：
   ```bash
   npm test
   node scripts/audit-truncation.mjs --ci
   node scripts/local-e2e-verify.mjs
   curl -s https://gemini-mcp-gateway.vercel.app/healthz
   ```
3. 读 `AUTH-READY.md`，确认不授权；
4. 选一个 acceptance 门（B/C/D/E/F/G）做真实证据；
5. 不要先改代码；先独立审查。

---

## 10. 给新窗口的第一条指令（可直接用）

```text
你先不要改代码，也不要部署/公开。

先读：
- AGENTS.md
- docs/ACCEPTANCE.md
- docs/EVALUATION.md
- docs/EXECUTION-PLAN.md
- docs/HANDOFF-2026-11-23.md
- docs/AUTH-READY.md
- docs/OPEN-SOURCE/RESIDUAL-RISK-AUDIT.md

然后自己跑：
- npm test
- node scripts/audit-truncation.mjs --ci
- node scripts/local-e2e-verify.mjs
- curl https://gemini-mcp-gateway.vercel.app/healthz

产出一份独立审查：
1. 哪些结论有证据，哪些只是文档自述；
2. 哪些是测试绿但未真实验收；
3. 当前 V0 A–G 每门真实状态；
4. 最可能被上一任 lead 忽略的 5 个风险；
5. 下一步只做哪 3 件事。

不要先相信上一任的“完成/修好”；用真实任务、真实客户端、真实写入、真实授权证明。
```

---

## 11. 最后三句

1. **测试数不是验收；真实客户端/真实写入/真实授权才是。**
2. **部署成功不等于线上可用。**
3. **你是独立审查者，不是上一任的背书人。**
