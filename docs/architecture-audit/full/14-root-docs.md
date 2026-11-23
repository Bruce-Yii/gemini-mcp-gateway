# 14 — docs/ 根目录 + 仓库根文档全量深读审计（只读）

> 任务性质：**只读审计**。本轮只新增本文件；未改 src/、scripts/、tests/、其他 docs、README、workflows；未 commit/push/deploy。
> 范围：`docs/` 根目录下所有 `.md`（**不含子目录**）+ 仓库根 `AGENTS.md`、`README.md`、`README.zh-CN.md`、`CHANGELOG.md`、`CONTRACT*.md`、`CONTRIBUTING.md`、`DEPLOY.md`、`LICENSE`、`SECURITY.md`。
> 标签约定：**[代码]** = 源码/配置事实（本轮未逐文件读源码，仅按文档自述与已索引审计引用）；**[文档]** = 文档写了什么；**[测试]** = 测试/数字声称；**[未验证]** = 无证据、需要真实客户端/真实授权/生产实测。
> 关键纪律：**测试绿 ≠ 验收**；部署成功 ≠ 验收通过；不把代理评测当真实客户端结论；不编造 requestId/commit/生产状态。

---

## 1. 清单与覆盖（硬要求 1）

### 1.1 取清单的方式

```
git ls-files 'docs/*.md'
```

注意：Git pathspec 中 `docs/*.md` **会递归匹配子目录**（返回了 `docs/OPEN-SOURCE/...`、`docs/eval/...`、`docs/ledger/...`、`docs/architecture-audit/...` 等）。本任务只要根目录，因此按「路径中 `docs/` 后不再含 `/`」过滤：

```
git ls-files 'docs/*.md' | Where-Object { $_ -notmatch '^docs/.+/' }
```

根文件按任务给定清单逐一确认存在。

### 1.2 Expected / Read / Unread 汇总

| 组 | expected | read（逐文件全文打开） | unread |
|---|---:|---:|---:|
| docs/ 根目录 `.md` | 37 | 37 | 0 |
| 仓库根指定文件 | 10 | 10 | 0 |
| **合计** | **47** | **47** | **0** |

- 37 个 docs 根文件：`ACCEPTANCE-CLIENT-RUNBOOK.md`、`ACCEPTANCE-EVIDENCE-2026-11-24.md`、`ACCEPTANCE.md`、`ADOPTION-RANKINGS.md`、`ARCHITECTURE-PROGRESSIVE.md`、`ARCHITECTURE.md`、`AUTH-OWNER-POLICY.md`、`AUTH-READY.md`、`AUTHORITATIVE-TASK-SOURCES.md`、`BACKLOG-GEMINI-SUGGESTIONS.md`、`CAPTURE-ANALYZER.md`、`CLIENTS-CHATGPT.md`、`CLIENTS.md`、`CODEMODE-SURVEY.md`、`CONTEXT-AND-EVAL.md`、`CREDENTIALS.md`、`DEPLOY-POLICY.md`、`DEPLOYMENTS.md`、`DSH-CODEMODE-FIT.md`、`ENV-ISOLATION.md`、`EVALUATION.md`、`EXECUTION-PLAN.md`、`EXPLORATION-FINDINGS.md`、`FRAMEWORK.md`、`GEMINI-OFFICIAL-DOCS.md`、`GEMINI-PROBE.md`、`GEMINI-REAL-TASK-FEEDBACK.md`、`HANDOFF-2026-11-23.md`、`HANDOFF-NEXT-WINDOW.md`、`OBSERVABILITY-AND-EVAL.md`、`ONLINE-EVAL-GPT-CHARTER.md`、`PLAN-2026-11-23.md`、`SANDBOX-SECURITY.md`、`UNNEEDED-TOOLS.md`、`UPSTREAMS.md`、`WHY.md`、`WORKFLOW.md`。
- 10 个根文件：`AGENTS.md`、`README.md`、`README.zh-CN.md`、`CHANGELOG.md`、`CONTRACT.md`、`CONTRACT.vercel.md`、`CONTRIBUTING.md`、`DEPLOY.md`、`LICENSE`、`SECURITY.md`。
- `CONTRACT*.md` 展开为 2 个（CONTRACT.md、CONTRACT.vercel.md）。
- 全部 47 个目标均存在、均可读、均已全文读取（无仅看标题/grep）。

### 1.3 阅读异常（不影响覆盖，但属文档缺陷）

- [文档] `docs/HANDOFF-2026-11-23.md`：文件含 **1 个 NUL 字节 + 若干低位控制字符**（如第 120/122/124 行呈现 `\0/\x07/\x0c` 前缀的提交号），导致标准文本读取器报 "binary file"。已改用字节级 UTF-8 读取并逐行核对全文 152 行，确认内容为文本。属于应清理的编码污染。
- [文档] `docs/CAPTURE-ANALYZER.md:154`、`docs/EXECUTION-PLAN.md:86`：正文中出现字面 `\n`（未换行的转义序列），属排版缺陷。
- [文档] `docs/CODEMODE-SURVEY.md:40`：粗体标记未闭合（`**别人有而我们缺的（按重要度）：`）。
- [文档] `docs/DEPLOYMENTS.md:17-18`：表格中间空行导致表格被拆成两段。

---

## 2. 逐文件结论（硬要求 2）

> 「读完」列均为 **是**（全文打开，非标题/grep）。字节为 `Get-Item.Length`。结论只记录文件自身陈述与可交叉核对的事实，不延伸编造。

### 2.1 docs/ 根目录（37 个）

| # | 路径 | 字节 | 读完 | 关键结论（原文口径） |
|---:|---|---:|:---:|---|
| 1 | docs/ACCEPTANCE-CLIENT-RUNBOOK.md | 4680 | 是 | Gate B 需用户真实浏览器跑 3 任务（T1 读文件纯正文/T2 PR number vs id/T3 大文件截断）。[文档] 头部仍写生产 `9ab0e57`、PR #7 未部署、线上 401 resource_metadata 仍指向 `…yu-ac3a…` —— **旧生产状态**，与 AGENTS.md 当前 `d1f36ba` 不符。记录模板要求 `requestId` 没有写 `unknown`。 |
| 2 | docs/ACCEPTANCE-EVIDENCE-2026-11-24.md | 6001 | 是 | [文档] 记录 Gate C 真实写回环（read→dryRun→commit→byte verify→PR；CI 被 GitHub billing 阻塞，判 PARTIAL）、真实 tools/list 3/5（GitHub 28/Linear 60/Figma 51 OK；Notion/Vercel 401）、KV 隔离 FAIL、origin 修复未部署。[文档] 生产 `9ab0e57`、PR #6/#7「未合并未部署」—— **旧状态**；与当前 `d1f36ba` 已部署 #6/#7 冲突。[测试] 证据 JSON 路径 `docs/eval/acceptance-2026-11-24/`（子目录，不在本轮范围）。 |
| 3 | docs/ACCEPTANCE.md | 4269 | 是 | [文档] V0 七门 A–G；当前 A PASS（d1f36ba / buildHash a1002d86）、B FAIL、C PARTIAL、D FAIL、E FAIL、F PARTIAL、G FAIL。明确「测试绿、CI 绿、fake harness 不算验收」「117 个 skip 是私有 fixture 不存在」。[文档] 第 83 行 E 门写「未部署；baseline=none」与第 26 行 A PASS 矛盾；第 104 行「0/7 门全过；真实验收未开始」与 A PASS/C PARTIAL 措辞冲突。 |
| 4 | docs/ADOPTION-RANKINGS.md | 7679 | 是 | [文档] 调研快照：无官方 MCP/ChatGPT 采用排名，所有数字都是代理指标；给出上游筛选四问（可托管/客户端原生连接器/工具面价值/凭据可获得）与 A–E 优先级（A: Slack/Atlassian/Figma/Sentry）。数据来源链接齐全。未做真实部署验证，也未宣称。 |
| 5 | docs/ARCHITECTURE-PROGRESSIVE.md | 13980 | 是 | [文档] 六模块渐进式披露 L0–L4；硬规则：不允许 Client 直接依赖 Upstream、不允许 Evidence 反向控制执行、不允许 OSS 进入核心运行时。[文档] 执行器选择表称 Gemini→Typed Plan、强模型→Code Mode、宿主支持 tool search→Native —— 与架构审计共同结论（Native/Hybrid、按客户端选执行器仍 L0–L1）不符，属**架构承诺高于生产默认**。[文档] 成熟度表诚实标注真实客户端未验、A/B 未做、Docker/npm audit 未验、OSS 未公开。 |
| 6 | docs/ARCHITECTURE.md | 11427 | 是 | [文档] 六层 + 五个接口（ClientAdapter/ExecutionAdapter/UpstreamAdapter/EvalHarness/RuntimeAdapter）；产品边界单 owner、不做多租户；10 条核心不变量含「测试绿≠验收」。[文档] §5 执行器适配矩阵、§7 成熟度表（Client 部分/Execution 较强/Upstream 部分/Evidence 框架强/Runtime Vercel 可跑/OSS 未公开）；§8 八个最高优先级缺口与当前验收门一致。同样存在「执行器按 profile 选择」的架构承诺 vs 生产默认 gap。 |
| 7 | docs/AUTH-OWNER-POLICY.md | 5168 | 是 | [文档] owner 决策已定：只有显式 `owner=gateway` 可 refresh；未标记一律 shared；DSH grant 标 dsh 永不 refresh；v2 key `gmcgw:v2:grant:<env>:<owner>:<server>`；legacy v1 只读。[文档] 迁移脚本 `--apply` 本次未执行；生产 KV 迁移未做。[测试] 真实 tools/list 3/5（2026-11-24 02:20）；Notion/Vercel 需新授权。声明不据此向用户发起授权（AUTH-READY NOT READY）。 |
| 8 | docs/AUTH-READY.md | 13599 | 是 | [文档] 唯一授权门禁，状态 **NOT READY**；§1.1 代码/测试项多数已 [x]（含 `1087 tests / 1081 pass / 0 fail / 6 todo` 旧数字），§1.2–1.8 部署/环境/provider 真实验证均 [ ]。[文档] Notion DCR 与 Vercel CIMD 代码已实现但真实授权未做、对外 BLOCKED；明确 `scripts/auth-provision.mjs` blocker 文案过时。§4 列变更范围。 |
| 9 | docs/AUTHORITATIVE-TASK-SOURCES.md | 4111 | 是 | [文档] 权威任务源盘点：只有 GitHub/Notion 有 MCP benchmark，Linear/Vercel 无；86 条 derived 中仅 24 条（28%）理论可替换；改用 schema 驱动 + 反向验证 86/86 通过；明确「不要宣称权威评测」，定位是广度扫描。 |
| 10 | docs/BACKLOG-GEMINI-SUGGESTIONS.md | 4794 | 是 | [文档] 两条 Gemini 建议（图片透传、沙箱入参轻量校验）均已在 commit `03c294b` 落地；旧文案「17 条未修」已过期；残留 L1/L2 已逐条决定补修或 DEC。注意「均已实施」只指这两条建议，非全项目。 |
| 11 | docs/CAPTURE-ANALYZER.md | 6309 | 是 | [文档] 免费模型输出只是假设；固定离线流水线（digest→analyzer-input.v1→模型→validator→work/→人审）。[测试] 首次真实运行 11 条 MCP POST、p95 6228ms、2 条 P2 issue。[文档] §0 模型不进请求路径；§154 行字面 `\n` 排版缺陷；**p95 数字来自 durationMs**，与 AGENTS.md §3「不把 durationMs/bytes 换算成 p95」的口径存在张力（此处作为历史记录，不作为评测结论）。 |
| 12 | docs/CLIENTS-CHATGPT.md | 8703 | 是 | [文档] ChatGPT 连接器**未端到端实测**；实现含 redirect allowlist、RFC 9207 iss、401 linking UI、tools/list `_meta.securitySchemes`、`ALLOW_DCR_FOR_CHATGPT=1` 显式开启。[文档] 明确未实现 CIMD、Pro/Plus read-only 靠客户端、mTLS/UserInfo/id_token_hint 未做。[文档] 第 16 行出现 `gateway_search`/`gateway_call` 旧工具名，与 3 工具不变量不一致（历史命名残留）。 |
| 13 | docs/CLIENTS.md | 2222 | 是 | [文档] 客户端兼容矩阵：Gemini web 标 **Tested**（与验收门 B FAIL「真实窗口未跑」冲突——「连上过」被写成「Tested」）；Claude callback allowed 但 real connector unverified；ChatGPT/IDE/DSH untested。 |
| 14 | docs/CODEMODE-SURVEY.md | 42791 | 是 | [文档] 归档快照（2026-11-22），明确文中行号/工具数/线上状态可能变化。谱系对比 Cloudflare/OpenCode/Claude Code/Anthropic PTC/Vercel AI SDK/网关派；自评优势（execute_read/execute 可见性分层、token 生命周期、QuickJS 真隔离、诚实状态、3 工具）；短板（类型未进上下文、截断不可回读、无持久化/审批/重放、无 per-tool 计量）。[文档] 含旧行号与旧数字（424→9 工具、50 次上限）；第 40 行粗体未闭合。 |
| 15 | docs/CONTEXT-AND-EVAL.md | 4851 | 是 | [文档] 关切一省上下文（挂载 + 调用侧 boundResult 8000 字符）；关切二准确性（无可复用评测工具，代理评测不可靠，唯一终极验证是 Gemini 真机）。[测试] 2026-11-23 五上游实测 506 工具 ≈245,377 tokens → 3 工具 ≈1,520 tokens / -99.4%；[文档] 三层截断预算未统一；第 76 行 `npm test # 52 项测试` 为极旧数字。 |
| 16 | docs/CREDENTIALS.md | 12525 | 是 | [文档] **核心矛盾**：第 3 行「gateway does not implement OAuth acquisition for upstreams」与第 63/131 行「Gateway-initiated OAuth」实现及 AUTH-READY 的 DCR/CIMD 实现冲突；第 62 行「persists rotated tokens in KV」与 owner 策略「未标记 grant 永不 refresh」冲突。[文档] 含个人绝对路径 `D:\12412\dsh-home\.secrets\...`（OSS 清洁度风险）；Figma 官方远程受 client-name allowlist 限制，社区 workaround 属 client-name spoofing；Slack/Atlassian/Sentry 凭据指南完整。 |
| 17 | docs/DEPLOY-POLICY.md | 1717 | 是 | [文档] 部署纪律（无进展不部署、docs/tests-only 不部署、部署前 0 fail、部署后 healthz + DEPLOYMENTS 记录）。[文档] §5「当前状态：生产 `87d91af`（A PASS）」是**旧生产状态**，与 DEPLOYMENTS/AGENTS 的 `d1f36ba` 不符。 |
| 18 | docs/DEPLOYMENTS.md | 3557 | 是 | [文档] 部署日志：00:50 `87d91af`、01:51 `9ab0e57`（最后一次自动）、01:59 起 main 自动部署关闭、02:57 手动 `d1f36ba`（#6/#7 合并；owner 标记 + origin 一致；healthz commit/buildHash 已核）。历史 40 次自动部署未登记（不补造）。preview 仍由 branch push 生成。[文档] 表格被空行拆开（排版缺陷）。 |
| 19 | docs/DSH-CODEMODE-FIT.md | 21166 | 是 | [文档] 归档调研（2026-11-22，DSH 0.2.2-rc.5）：协议/工具名/content 高兼容；唯一实质障碍是 DSH MCP 客户端无 OAuth 流程（只静态 header）。建议保持 DSH native executor，不要同时开 DSH PTC preset（双层代码字符串）。[未验证] 明确未实测 DSH 里发起网关 execute、token 有效期/refresh 在静态 header 模式下的表现。含 `<DSH_HOME>`/`<repo>` 占位与个人路径描述。 |
| 20 | docs/ENV-ISOLATION.md | 3305 | 是 | [文档] 2026-11-24 02:35 只读检查：**NOT ISOLATED**，4 个 P0 共享项（PUBLIC_BASE_URL 全环境；UPSTASH_REDIS_REST_URL/TOKEN/REDIS_URL preview+production 共用）。代码侧 origin 修复（请求 host 优先）已做；KV 凭据拆分必须由 operator 在 Vercel 完成，本轮未做。 |
| 21 | docs/EVALUATION.md | 5905 | 是 | [文档] 评测总入口：在线（发现）× 半在线（固化）互补；L0–L4 分层；在线反馈闭环（F 矩阵→G1–G6→N/J/T→确定性测试→旧/新构建同任务→部署后复验→join/baseline）。[文档] §6 第 107 行「部署未做：Vercel 100/day」是**旧状态**（与 d1f36ba 已部署冲突）；含旧 commit acba249/1bb8f8a。 |
| 22 | docs/EXECUTION-PLAN.md | 4503 | 是 | [文档] 任务路由页。[文档] 快照极旧：`1381 tests / 1375 pass`、生产 `9ab0e57`、三个在跑 agent、`Vercel 100/day`、「最新代码未部署」——与 AGENTS.md 当前 `1406 tests / 1400 pass` / `d1f36ba` 全面冲突。第 86 行含字面 `\n\n`。 |
| 23 | docs/EXPLORATION-FINDINGS.md | 8661 | 是 | [文档] 191 条任务探索测试（105 官方逐字 + 86 基于 description）；原始轮 360 异常，其中约 21 个是占位符假 404；v2 干净基线 138 条 / 215 异常 / gateway 归因 73，逐条归类后真网关确定性缺陷 5 条且已修。[文档] 明确 hy4 不是 Gemini、占位符假错误、manifest gitSha=937b2e7 非最新代码。 |
| 24 | docs/FRAMEWORK.md | 23139 | 是 | **[文档·最高优先级]** 用户原文逐字（§0）+ 六模块 + 分层/交叉 + 主动/被动评测 + 客户端/上游 SOP + 部署/成本 + 开源 + 11 客户端模式纠正 + 12 原框架遗漏 + 13 定稿 + 14 审批 UX + 15 七模块审计索引。关键：底座按客户端替换但生产默认仅 Code Mode；主动>被动；不评模型思考只评工具调用；「被动缺任务级预期但有工具级可核验真值」；不引入 canary/通用能力检测框架；§15 承认架构承诺与生产默认有距离。 |
| 25 | docs/GEMINI-OFFICIAL-DOCS.md | 4508 | 是 | [文档] Google 官方文档要点：官方反对 mega-tool（`execute(code)` 属此类）、工具数偏多会被标记、大结果先在服务端过滤（方向一致）、annotations 必须显式。[文档] 第 34/60 行「199 工具（禁用 265 后）/452 全量」为**旧数字**（其他文档为 456/506）。[未验证] 对准确率/速度的影响明确标注为推断、无实测。 |
| 26 | docs/GEMINI-PROBE.md | 5256 | 是 | [文档] 给 lead 的 Gemini 网页手动探针（2 对话 8 任务 + 追问 + 回收处理）。[文档] 记录 Gemini 单轮约 20 次工具调用上限（客户端侧，非网关）；明确「不把 Gemini 建议直接当工单」，需先归因。 |
| 27 | docs/GEMINI-REAL-TASK-FEEDBACK.md | 5923 | 是 | [文档] 一次真实 Gemini 实战反馈：P0 多段 content/resource 块丢失、toolCalls 全量 args 回显破坏省上下文；P1 读写分离/沙箱 Web API/30 次上限/返回值类型/listTools 过重。[文档] 旧行号定位（仅供改造参考）；状态是否全部已修需看 BACKLOG-GEMINI-SUGGESTIONS 与 ledger。 |
| 28 | docs/HANDOFF-2026-11-23.md | 5872 | 是（字节级） | [文档] 顶部历史表 + 文末 checkpoint，均标旧：`1381 tests`、commit `7a82c1d`、生产「旧构建、100/day 未部署」。[文档] 含控制字符污染（1 NUL + 若干低位字节）。「不要再犯」清单仍有价值（sessionId≠taskId、不让模型可见静默截断等）。 |
| 29 | docs/HANDOFF-NEXT-WINDOW.md | 15431 | 是 | [文档] 已转为「背景 + 审查清单」；头部更新为 `d1f36ba` / V0 1/7（仅 A PASS）/写回环已跑通。[文档] 但 §2「已确认」仍写 healthz `9ab0e57`、A PARTIAL、「真实写回环未在验收仓库跑」——**同一文件内部新旧并存**。[文档] 第 240 行给出 README 应修正的 token 数字（3,564 / -98.5%，不是 1,520 / -99.4%）；含个人 vault 路径与 GitHub 仓库名。 |
| 30 | docs/OBSERVABILITY-AND-EVAL.md | 15709 | 是 | [文档] 全量 capture 架构（不采样、不按内容裁剪、边界到网关物理边界）；SSE 当前无流（GET 405）。**[文档·核心矛盾]** §0 第 32 行与 §9 第 254 行写「认证头/token/body 原文记录」，而事件模型示例第 91 行写 `"authorization": "<redacted:hash>"`，§11 验收项又要求「日志中无 token 明文」——三者自相矛盾；与 AGENTS.md §6（capture full-fidelity 但模型可见错误脱敏）也不完全一致，需澄清。[测试] 旧数字 `364 tests`、`228 任务`。 |
| 31 | docs/ONLINE-EVAL-GPT-CHARTER.md | 207 | 是 | [文档] 独立 ChatGPT 评测 agent 章程：只读、只读工具、发现缺陷开 issue、不关闭 bug、证据规则（exact call、unknown 可接受、finding 是假设）。[文档] §7 状态为 2026-11-23（修复待部署）；master issue #3。 |
| 32 | docs/PLAN-2026-11-23.md | 13343 | 是 | [文档] 全局计划：W1–W7 工作流、capture 漏采根因（waitUntil 在 queueMicrotask）、写路径类型化原语、Gemini 自适应、MCP 2026 暂不迁移。[文档] 状态极旧：`623/623`、部署 `ff4c1ee`；与当前基线不符。 |
| 33 | docs/SANDBOX-SECURITY.md | 5117 | 是 | [文档] 真隔离已落地（Vercel run SDK / QuickJS worker thread；`.constructor` 逃逸被挡，线上探活 + `tests/true-isolation.test.js`）。关键告诫：隔离≠授权；host function 在宿主 realm 执行且受信任；annotations 不可信；execute_read 价值是减少审批摩擦不是安全隔离。历史对照表说明旧 node:vm 结论已过期。 |
| 34 | docs/UNNEEDED-TOOLS.md | 9621 | 是 | [文档] 工具收口逐项理由；明确「存疑全部放行、写操作不因写而删」；Figma 纠错（误 deny 18 个官方工具后放回）。[文档] 数字多处不一致：第 4 行 442→456、第 17 行合计 492、Vercel 212 vs 配置 213、第 5 行 Figma deny 22 vs 第 98/116 行 deny 4 —— **旧数字/自相矛盾**。 |
| 35 | docs/UPSTREAMS.md | 9878 | 是 | [文档] 上游接入配置字段全表（tokenEnv/tokenHeader/authScheme/refreshEnv/authorizeUrl/allow-deny 等）、5 种 auth 模式、stdio、Figma quota breaker（24h cooldown + whoami/get_metadata 缓存；state 仅进程内、无跨实例协调）。[文档] 明确 `maxCalls` 默认 50（与 GEMINI-REAL-TASK-FEEDBACK 提到的 30 次旧上限不同，已演进）。 |
| 36 | docs/WHY.md | 3708 | 是 | [文档] 动机与实测：456 工具 ~217,601 tokens → 3 工具 ~1,286 tokens / -99.4%；工具分布 GitHub 46/Notion 77/Linear 60/Vercel 273，启用 191；search top1 56.5%/top5 72.3%。[文档] **与 README（506/245,377/3,564/-98.5%）和 CONTEXT-AND-EVAL（506/1,520/-99.4%）数字口径不一致**；第 21 行主动标注 424→9 的旧数字已过期。 |
| 37 | docs/WORKFLOW.md | 23852 | 是 | [文档] 上游接入 G1–G7 质量门（DoD、证据路径、角色、台账协议、指标定义、风险登记）。[文档] §17 把 Figma 标「✅ 通过」，但 §0 第 18 行与 §18 第 484 行仍要求 reviewer 检查「Figma B4 是否诚实标注为 ⚠️」——review candidate 文本未同步；第 89 行称 `config.example.json` 为「生产配置」（应仅示例）。 |

### 2.2 仓库根（10 个）

| # | 路径 | 字节 | 读完 | 关键结论 |
|---:|---|---:|:---:|---|
| 38 | AGENTS.md | 9828 | 是 | 项目级最高规则，指向 FRAMEWORK.md。当前状态：生产 `d1f36ba`（02:57 手动）、自动 production 部署关闭、测试基线 `1406 tests / 1400 pass / 0 fail / 6 todo`、AUTH-READY NOT READY、OSS 未公开。硬规则：免费模型输出只是假设、DSH 与网关不共享 rotating refresh token、3 工具不变量、capture full-fidelity 但模型可见错误脱敏、部署纪律、测试绿≠验收。 |
| 39 | README.md | 17897 | 是 | [文档] 对外门面：506 工具 ~245,377 tokens → 3 工具 ~3,564 tokens / -98.5%（与 HANDOFF-NEXT-WINDOW 的「应为」一致，与 WHY/CONTEXT-AND-EVAL 不一致）。**[文档·过度宣称]** 第 29 行「Tested with Gemini web custom apps」、第 91 行 Gemini「**Tested.**」——与验收门 B FAIL（真实窗口未跑）冲突。第 3 行 CI badge 指向 `example-org/codemode-mcp-gateway`（占位）。第 294 行「OAuth acquisition out of scope; bring tokens」与已实现的网关 OAuth/DCR/CIMD 冲突。 |
| 40 | README.zh-CN.md | 16013 | 是 | [文档] 中文镜像。同样有「已在 Gemini 网页版自定义 app 实测 / 已实测」过度宣称；数字口径 506/245,377/3,564/-98.5% 与英文 README 一致；第 255 行「不包含上游 OAuth 获取流程」与实现冲突。 |
| 41 | CHANGELOG.md | 10130 | 是 | [文档] Keep-a-Changelog 格式；[Unreleased] 大量条目截至 Figma/B10/capture/analyzer 等，**缺少 2026-11-23/24 关键事件**（owner 标记、origin 一致、d1f36ba 部署、验收门状态）。第 19 行「suite now 364」为旧数字。 |
| 42 | CONTRACT.md | 6872 | 是 | [文档] 明确标注 **Historical document**（早期 whitelist + `gateway_call` 阶段），当前以 src/tests 为准。仍保留 `gateway_call`/`gateway_search`、白名单工具逐条注册等历史设计——不能当作当前契约引用。 |
| 43 | CONTRACT.vercel.md | 119 | 是 | [文档] 同样标注 **Historical**（Vercel/OAuth 部署阶段）。含 DCR 6 redirect、PKCE、token 不轮换、KV 哈希存储等早期约定；当前行为以 src/tests 为准。 |
| 44 | CONTRIBUTING.md | 2637 | 是 | [文档] 贡献规则：3 工具不变量、sanitizeTool、新上游需 config + docs + contract-style test、搜索改动需 before/after 数字、CHANGELOG 更新。未涉及验收门/测试绿≠验收的强调。 |
| 45 | DEPLOY.md | 6882 | 是 | [文档] Vercel 部署指南。[文档] 第 66 行「Commits to main trigger automatic deployments」与当前 `git.deploymentEnabled.main=false` 冲突；第 97 行「does not implement OAuth acquisition for upstreams」与网关 OAuth 实现冲突。安全默认值（ALLOWED_CLIENT_ID 必填、KV、healthz）描述清晰。 |
| 46 | LICENSE | 1066 | 是 | [文档] MIT，Copyright (c) 2026 **Bruce-Yii** —— 真实姓名句柄，OSS 发布前需确认中立化策略（与「未公开」状态一致，尚非公开缺陷）。 |
| 47 | SECURITY.md | 2024 | 是 | [文档] 单用户威胁模型（持有真实凭据、沙箱是隔离不是授权、工具输出不可信输入、锁 OAuth client、不提交密钥）。第 12 行指向本仓库 GitHub private vulnerability reporting，仓库私有/未公开时该流程实际不可用；「not audited, run at your own risk」诚实。 |

---

## 3. 审计结论（硬要求 3）

### 3.1 FRAMEWORK 六模块 vs 用户原话

| 模块 | 用户原话要点（FRAMEWORK §0） | 文档落点 | 与代码/生产实际的差距（引用既有审计，[未验证] 亲自读源码） |
|---|---|---|---|
| 1 核心底座 | 可替换，节省上下文/多步/跨上游；Code Mode/Typed Plan/Native/Hybrid；按客户端替换 | FRAMEWORK §2/§13、ARCHITECTURE L2、ARCHITECTURE-PROGRESSIVE 模块 2 | [文档] 架构矩阵称按客户端选执行器；**生产默认仅 v1 Code Mode**，Typed Plan 需 `ENABLE_MCP_V2=1`，Native/Hybrid 不存在。审计 README/00 共同结论：按客户端选执行器仍 L0–L1。 |
| 2 客户端 | Gemini/ChatGPT/Claude 等网页端**非代码模式**；客户端接入属于开源；主动/被动线上评测 | FRAMEWORK §11/§13.1（纠正为「平台 × 模式 × MCP 能力」，最终定稿网页端非代码模式逐个平台）、CLIENTS*/README | [文档] README/CLIENTS 写 Gemini "Tested"，但验收 B FAIL；mode detection 未落地（审计 01/00）。 |
| 3 评测体系 | 离线官方/权威任务集全覆盖；客户端主动+被动线上评测；采集层 session/project/task 交叉；主动反哺被动、降低主动成本 | FRAMEWORK §4/§13.2-13.3、EVALUATION、CONTEXT-AND-EVAL、AUTHORITATIVE-TASK-SOURCES、EXPLORATION-FINDINGS | [文档] 离线 191 任务已做但明确「不宣称权威评测」；[文档] 主动/被动字段隔离与同窗对照仍 L0–L1；baseline=none、replay 为 fixture（审计 04/00）。[文档] FRAMEWORK §13.3 明确「被动缺任务级预期但有工具级可核验真值」——纠偏到位。 |
| 4 上游接入 | GitHub/Notion/Linear/Vercel + 后续 Cloudflare/Gmail/Firecrawl/Exa/Tavily；授权第一位；首次引导属于开源 | FRAMEWORK §2、AUTH-OWNER-POLICY、AUTH-READY、CREDENTIALS、UPSTREAMS、ADOPTION-RANKINGS | [文档] owner 策略/代码已就绪；[未验证] 真实 tools/list 仅 3/5（Notion/Vercel 401），生产 KV 迁移/独立授权未做；[文档] ADOPTION-RANKINGS 建议下一批 Slack/Atlassian/Figma/Sentry（与用户候选列表不同，属于数据驱动调整，需用户确认优先级）。 |
| 5 运行时/部署 | Vercel 方便/免费；同类平台/费用风险；Cloudflare 内网穿透；本地容器/服务器 | FRAMEWORK §6、DEPLOY/DEPLOYMENTS/DEPLOY-POLICY/ENV-ISOLATION | [文档] Vercel 生产 d1f36ba 可跑；[文档] Docker build/npm audit 未验证；[文档] KV preview/production 共用 P0 未修；[文档] RuntimeAdapter 多载体适配仍 L0–L1（审计 05/00）。 |
| 6 开源工程 | 依赖前五层；发布前问题可后置但提前调研治理 | FRAMEWORK §7/§15、OSS 文档（子目录，不在本轮）、LICENSE、CONTRIBUTING | [文档] 未公开、仅本地产物；[文档] 审计 06/索引称公开 README 已有超出证据的宣称；LICENSE 含真实 handle。 |

**总判定**：[文档] 六模块表述与用户原话**基本一致并已多次纠偏**（尤其 §11 客户端模式、§13 定稿、§15 审计索引）；但**架构承诺 ≠ 生产默认**：执行器可替换、按客户端选执行器、Native/Hybrid、RuntimeAdapter、多客户端隔离、主动/被动字段隔离仍是 L0–L1，这在 FRAMEWORK §15 与审计索引中已被承认。

### 3.2 架构文档、验收/授权/部署/评测总览

- [文档] 架构入口链完整：AGENTS → FRAMEWORK → ARCHITECTURE / ARCHITECTURE-PROGRESSIVE → EVALUATION → 各子文档；索引齐全。
- [文档] 验收门定义清晰（ACCEPTANCE A–G），但状态表在多个文件间不同步（见 3.3）。
- [文档] 授权门禁（AUTH-READY 唯一入口）明确 NOT READY；代码/测试就绪 ≠ 真实授权就绪。
- [文档] 部署纪律清楚（DEPLOY-POLICY + DEPLOYMENTS 日志），但 DEPLOY.md 与 DEPLOY-POLICY §5 仍含旧口径。
- [文档] 评测总览（EVALUATION）流程完整，但「部署未做」「Vercel 100/day」是旧状态。

### 3.3 文档矛盾、旧数字/旧 commit/旧生产状态（集中列表）

**旧生产状态（与当前 `d1f36ba` 冲突）**：
1. `ACCEPTANCE-CLIENT-RUNBOOK.md:8-11` — 生产 `9ab0e57`、PR #7 未部署、线上 origin 仍 yu-ac3a。
2. `ACCEPTANCE-EVIDENCE-2026-11-24.md:5,11,15,71-95` — 生产 `9ab0e57`、#6/#7 未合并未部署。
3. `DEPLOY-POLICY.md:47` — 生产 `87d91af`。
4. `EVALUATION.md:107` — 「部署未做：Vercel 100/day」。
5. `EXECUTION-PLAN.md:9-13,32,67,86` — `1381 tests` / `9ab0e57` / 「最新代码未部署」/ `Vercel 额度`。
6. `HANDOFF-2026-11-23.md` — `1381 tests` / `7a82c1d` / 旧构建未部署。
7. `HANDOFF-NEXT-WINDOW.md:64-66,85` — 头部 d1f36ba 与正文 9ab0e57 / 「写回环未跑」并存。
8. `PLAN-2026-11-23.md:24-25` — `623/623` / 部署 `ff4c1ee`。
9. `DEPLOY.md:66` — main push 自动部署（现已关闭）。

**旧测试数字**：AUTH-READY `1087`、EXECUTION-PLAN/HANDOFF `1381`、CONTEXT-AND-EVAL `52`、OBSERVABILITY `364`、PLAN `623`、CHANGELOG `364`、HANDOFF-NEXT-WINDOW `1381`；当前 AGENTS 基线 `1406 tests / 1400 pass / 0 fail / 6 todo`。

**旧 commit/工具计数**：CODEMODE-SURVEY（旧行号、424→9、50 次）、GEMINI-OFFICIAL-DOCS（199/265/452）、UNNEEDED-TOOLS（442/456/492、Vercel 212 vs 213、Figma 22 vs 4）、GEMINI-REAL-TASK-FEEDBACK（旧行号、30 次上限）；WHY（456/217,601/1,286/-99.4%）vs CONTEXT-AND-EVAL（506/245,377/1,520/-99.4%）vs README/README.zh-CN/HANDOFF-NEXT-WINDOW（506/245,377/3,564/-98.5%）——**三套 token 口径**。

**自相矛盾（非时间新旧）**：
- `ACCEPTANCE.md:26` A PASS vs `:83` E「未部署」/`:104`「0/7 全过；真实验收未开始」。
- `OBSERVABILITY-AND-EVAL.md:32,91,254` 认证头原文记录 vs 示例 redacted vs 验收要求无 token 明文。
- `CREDENTIALS.md:3` 无上游 OAuth 获取 vs `:63,131` 已实现 vs README/DEPLOY 同口径冲突。
- `WORKFLOW.md:454` Figma ✅ vs `:18,484` reviewer 应检查是否诚实标 ⚠️。
- `CLIENT` 表述：README/CLIENTS「Gemini Tested」vs ACCEPTANCE B FAIL。
- `cli `工具名：CLIENTS-CHATGPT `gateway_search/gateway_call`、CONTRACT.md（历史）vs 3 工具不变量（历史文件已标注，不算活跃缺陷）。

**格式/编码缺陷**：HANDOFF-2026-11-23 控制字符、CAPTURE-ANALYZER/EXECUTION-PLAN 字面 `\n`、CODEMODE-SURVEY 未闭合粗体、DEPLOYMENTS 表格断裂。

### 3.4 能力过度宣称（重点）

1. **[文档] Gemini "Tested" / "已实测"**（README.md:29,91；README.zh-CN.md:19,76；CLIENTS.md:9）— 真实客户端任务门 B 为 FAIL，属于**超出证据的宣称**。
2. **[文档] 执行器选择矩阵**（ARCHITECTURE §5、ARCHITECTURE-PROGRESSIVE 模块 2）— 写成已生效的按客户端选择（Gemini→Typed Plan、Native），实际生产默认仅 Code Mode；审计 00 已确认。
3. **[文档] 省上下文数字** — 多套并存且 README 用最大削减比（-98.5%）；无论哪套，均是 `measure-context.mjs` 的 bytes/4 估算，非真实 tokenizer/真实模型账单；README 自己也承认是 token 估算（:238-239），但标题数字仍以精确数字呈现。
4. **[文档] 「持续评测闭环」措辞**（README:21-25、OBSERVABILITY、CODEMODE-SURVEY）— 在线 baseline=none、replay 为 fixture、真实 capture 端到端 unknown、canary 未实现（EVALUATION §6），「每次改动都对照真实 session」目前证据不足。
5. **[文档] OAuth 能力双向矛盾** — README「OAuth acquisition out of scope」与 AUTH-READY 的 DCR/CIMD 已实现并存；对外表述需统一（代码就绪 ≠ 真实授权可用）。
6. **[文档] 开源门面** — 审计索引称公开 README 已有超出证据宣称；LICENSE 含真实 handle；仓库未公开，属发布前门禁范围。

### 3.5 缺失的上层/横切层（相对用户原话 §3.1/§3.2 与 FRAMEWORK §12）

用户原话明确点出「很多上层的东西」「横切关系」，文档已有骨架但实现/专章缺失：

| 层 | 用户关注 | 文档状态 | 判定 |
|---|---|---|---|
| 多客户端隔离/并发 | 一个网关多客户端如何隔离、哪些底层复用、并发 + 上游并发限制 | FRAMEWORK §3.1/§12/§13.6 列为未决；ARCHITECTURE-PROGRESSIVE 有接口但无实现 | [文档] 有提纲；[未验证] 无生产证据；审计 00/01 记为 L0–L1 |
| 执行所有权 | 谁规划、谁执行、谁持有上下文（网关 Code Mode vs 客户端 agent loop） | FRAMEWORK §12.1 提出；DSH-CODEMODE-FIT 讨论 PTC 重叠 | [文档] 有分析；[未验证] 无统一决策落地 |
| 能力协商/fallback | 模式/计划/MCP 能力无法可靠检测时的降级 | FRAMEWORK §12.4、§13.7「暂不做通用能力检测框架」 | [文档] 明确暂缓，逐个平台实测优先 — 合理但属缺失 |
| 信任与安全边界 | client OAuth、upstream grant、sandbox、secret、capture 存储统一模型 | SANDBOX-SECURITY（沙箱）、AUTH-OWNER-POLICY（grant）、OBSERVABILITY（capture，但自相矛盾）| [文档] 分散在多文件；缺一份统一横切安全模型；capture 原文/脱敏口径需澄清 |
| 成本模型 | token/上游配额/部署/存储；免费平台无扣费风险 | FRAMEWORK §6/§13.5；OBSERVABILITY §6.2 存储选型 | [文档] 有原则与选型；[未验证] 费用/配额无实测 |
| 状态/持久层与调度 | 长流程 checkpoint、跨实例缓存、背压/队列 | PLAN W6、UPSTREAMS Figma 限制（per-instance）、ARCHITECTURE 未列独立层 | [文档] 有缺口登记；[未验证] 未实现 |
| 发布工程 | canary/shadow/回滚 | FRAMEWORK §12.14 提出、§13.7 暂不引入；EVALUATION L3 未实现 | [文档] 有意暂缓，属已知缺失 |
| 评测自身质量 | 基准污染/过拟合/标注偏差 | AUTHORITATIVE-TASK-SOURCES、EXPLORATION-FINDINGS、WORKFLOW 权威等级 | [文档] 有原则；[测试] 具体偏差控制未量化 |

---

## 4. 证据边界与禁止事项声明

- [代码] 本轮**未逐文件读取 src/**，所有关于「代码已实现」的表述均为文档自述或引用既有架构审计索引（docs/architecture-audit/README.md、FRAMEWORK §15），不自行升级为代码事实。
- [测试] 所有测试数字均为文档原文引用；本轮**未运行 npm test**，不把任何历史测试数当作当前通过结论。
- [未验证] 真实客户端、真实写回环 CI、授权生命周期、KV 隔离修复、旧/新构建同任务对照、Docker build、npm audit、OSS 发布门禁 — 均按文档标注保留为未验证。
- 未编造任何 commit、requestId、生产状态或数字；对冲突处以「文件 + 行号 + 两种口径并列」呈现，不擅自判定哪个为准（除 AGENTS.md 明确为最高优先级的当前状态：d1f36ba / 1406 tests / AUTH-READY NOT READY / OSS 未公开）。
- 未执行 commit/push/deploy；未修改本文件以外任何文件。

---

## 5. 一句话总结

**[文档]** docs 根目录与根文件共 47 份全部逐字读完：框架/架构/验收/授权/部署/评测的总纲和门禁体系完整且方向正确，FRAMEWORK 与用户原话对齐度最高；**[文档]** 但存在系统性的状态漂移（旧生产 9ab0e57/87d91af、旧测试数、三套 token 口径、README「Gemini Tested」过度宣称、capture 原文/脱敏自相矛盾、CREDENTIALS 与实现冲突）；**[未验证]** 六模块中的「可替换执行器/按客户端选择/Native/Hybrid/RuntimeAdapter/多客户端隔离/主动被动字段隔离」仍是架构承诺而非生产默认，真实客户端/授权/写回环/在线复验均未验收——**测试绿与部署成功都不能替代验收**。
