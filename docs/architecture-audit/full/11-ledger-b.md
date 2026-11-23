# 11 · Ledger B 深读报告（README + batch-8 … batch-15）

> 审计类型：**只读逐文件深读**（不写代码、不 commit、不 push、不 deploy）
> 审计范围：`docs/ledger/` 中 README + batch-8 到 batch-15 的全部 tracked 文件
> 采样时间：2026-11-24（Asia/Singapore）
> 证据标注：`[代码]` = ledger 自述有源码落点；`[文档]` = 仅文档承诺/设计稿；`[测试]` = ledger 自述有定向/全量测试；`[未验证]` = 无真实证据或明确待验证。**测试绿 ≠ 完成 ≠ 线上生效。**
> 对照入口：`docs/FRAMEWORK.md`（六模块）、`AGENTS.md` §0（生产 `d1f36ba` / AUTH-READY NOT READY / OSS 未公开）、`docs/ledger/README.md`（门控与证据规则）、同系列 `10-ledger-a.md`。

---

## 0. 覆盖完整性（硬要求 1 / 2）

### 0.1 `git ls-files docs/ledger` 与本次负责清单

`git ls-files docs/ledger` 全量返回 **82** 个 tracked 文件。本审计员负责 **README + batch-8 … batch-15**，共 **70 个文件**；全部逐文件用 read 工具全文打开（非目录/标题/grep），逐字节数由 `Get-Item.Length` 实测。

| # | 路径 | 字节 | 读完 | 关键结论（摘要） |
|---:|---|---:|:---:|---|
| 1 | `docs/ledger/README.md` | 7758 | ✅ 75 行 | 分类/批次总索引；三阶段门控；三条防再犯证据规则；反馈四步法（L1-L3/找同类/收益风险/走一步看三步）。索引中 `ledger.json` 声明存在（A 报告已核实实际不存在）。 |
| 2 | `batch-8-gemini-file-workflow.md` | 7885 | ✅ 122 行 | B8-1 canonical helper、B8-2 sliceLines（实测修正：沙箱本可持全量文本）、B8-3 patch/diff、B8-4 acorn 行标记线上复验 `script line 2:1`。选择 sandbox helper 而非网关强改上游。 |
| 3 | `batch-9-capture-completeness.md` | 12309 | ✅ 176 行 | 根因=`waitUntil` 在 `queueMicrotask` 才调用→Vercel 冻结；修为同步路径 + ack/done/skipped + 判据 `A===D`、`V-A===S`、`R+dropped===A`；未提交/未部署，需运维对账。 |
| 4 | `batch-9-digest.md` | 5803 | ✅ 54 行 | digest 增加 per-upstream/per-tool/截断/按天小时/`--since`；analyzer advisory-only、validator 未改；周审只出候选+证据 id，不开 issue。 |
| 5 | `batch-9-http-sink.md` | 4641 | ✅ 57 行 | HTTP response body 采集（非 SSE 64KB、SSE 跳过）；sink 失败兜底 HTTP POST；注意此时 `writeHttpSink` 仍未检查 status（后被 B15 capture-sink-fix 修）。 |
| 6 | `batch-9-l1-real.md` | 4978 | ✅ 48 行 | L1 每日 fake + 每周 real，Figma 跳过不烧配额，ALERT 需连续两次失败；首次 real 周跑未发生。 |
| 7 | `batch-10-canonical.md` | 7721 | ✅ 115 行 | `src/result-normalize.js` 四纯函数；真实 capture 回放发现下载提示被当正文，修 `extractBodyText` 取最长正文；**当时未接调用路径**。 |
| 8 | `batch-10-idempotent.md` | 5708 | ✅ 58 行 | `src/github-helpers.js` ensureBranch/upsertPr/fetchAllPages/repoGrep 纯模块，17 测试；未接 codemode。 |
| 9 | `batch-10-integration.md` | 8152 | ✅ 107 行 | host helper 接入沙箱（guest 侧按契约重写）；applyFilePatch 默认 dryRun；14 测试；**未做真实 GitHub 写回放**。 |
| 10 | `batch-10-patch-write.md` | 6659 | ✅ 111 行 | applyTextPatch strict context、原子失败、dryRun 默认；当时尚未接 codemode。 |
| 11 | `batch-10-pr-workflow.md` | 3727 | ✅ 53 行 | Gemini PR #14–#41 反馈映射 P0/P1/P2；指出最大摩擦=返回形状/行级读写/写前 diff。 |
| 12 | `batch-10-write-semantics.md` | 9631 | ✅ 136 行 | create_branch_if_missing、统一写入入口、sha 自动补齐、顶层 number/url/sha、写前轻量预检；19 测试；**多文件逐文件写中途失败非原子**（后由 B11.6 修）。 |
| 13 | `batch-11-adaptive-codemode.md` | 14205 | ✅ 175 行 | **纯设计方案**：Profile S/F、L-A..L-D 分层、配对 A/B、验收线；明确不改 schema、不做运行时自动路由、免费模型只 advisory。 |
| 14 | `batch-11-client-adapter.md` | 7766 | ✅ 137 行 | `src/client-profile.js`：gemini strip SC / chatgpt 双编码 / claude text+annotations；显式声明不猜；25 测试；**无真实客户端实测**。 |
| 15 | `batch-11-durable-state.md` | 15710 | ✅ 220 行 | **纯设计**：复用 Upstash 做 checkpoint/CAS/租约；硬限制=只恢复步骤边界、需显式 taskId；前置依赖 taskId 埋点。 |
| 16 | `batch-11-figma-cache.md` | 14572 | ✅ 199 行 | **纯设计**：跨实例 cooldown/cache（官方 20/月 View/Starter，whoami 豁免）；阶段 1 同步回源（Vercel 冻结风险）；未实现。 |
| 17 | `batch-11-gh-feedback.md` | 5379 | ✅ 58 行 | 分支别名、PR number URL 优先（id 5444514334→#53）、Actions REST helper；21 测试；全量 761/761。 |
| 18 | `batch-11-project-llm.md` | 8177 | ✅ 139 行 | 免费模型项目标签 advisory-only、validator 拒伪造 requestId、lowConfidence 单列；16 测试；未跑全量。 |
| 19 | `batch-11-project-rollup.md` | 10162 | ✅ 185 行 | digest `byProject`/`projectTimelines`、analyzer 项目视图、join projectKey 严格相等；10+33 测试；多数旧 envelope 因位置参数不抽而 unmatched。 |
| 20 | `batch-11-project-tag.md` | 8930 | ✅ 148 行 | `extractProjects()` request-only 确定性标签，envelope additive 两字段；20 测试；位置参数不抽是已知漏报。 |
| 21 | `batch-11-recent.md` | 4407 | ✅ 137 行 | B11.1 近期修复汇总：capture 需 `CAPTURE_SYNC=1` 才可信（4 提交）、真实写回放、session 标记、MCP 2026 暂不迁移、静默截断 P0 进行中。 |
| 22 | `batch-11-reconnect.md` | 20603 | ✅ 186 行 | **只读调研**：网关无法强制客户端重连；Skew Protection 不适用；404/SSE/list_changed 均否决；唯一已验证恢复=手动 @；未知内部机制标 `[未验证]`。 |
| 23 | `batch-11-session-clustering.md` | 9343 | ✅ 145 行 | windowId 聚类（sessionId 优先/15min idle）；join **仅显式 taskId**，无则 unmatched；16+31 测试；windowId 是合成字段。 |
| 24 | `batch-11-truncation-audit.md` | 10455 | ✅ 135 行 | `possibleModelTruncation` 四条件字节规则；三信号分账（wire/overflow/model suspect）；14+28 测试；旧数据不回溯。 |
| 25 | `batch-11-truncation-scan.md` | 9119 | ✅ 148 行 | 词法扫描器 + CI 守门；P0=0/P1=2/P2=177；P0 非零 CI 红；15 测试；启发式。 |
| 26 | `batch-11-truncation.md` | 9669 | ✅ 139 行 | P0 修复：readFileRange 默认不字符截断、patch 截断读硬停、grepSnippet/diffSummary 标记；22+6 测试；模型仍可手写 slice 绕过（guidance 非静态拦截）。 |
| 27 | `batch-11-write-transaction.md` | 9197 | ✅ 153 行 | `github__push_files` 原子写 + 失败 written[]/compensation；19+94 测试；补偿是建议非自动回滚。 |
| 28 | `batch-12-active.md` | 5802 | ✅ 69 行 | 并行任务板；10 agent 完成；follow-ups：OSS staging 9 fail、L1 failed-server 口径、b1a4956 已 push 但 Vercel 未自动部署。 |
| 29 | `batch-13-active.md` | 2661 | ✅ 50 行 | 平台隔离模型表；single-owner 分账；不做多租户/不用平台标签做写路径；**capture 尚未加 clientPlatform（当时）**。 |
| 30 | `batch-13-platform-eval.md` | 11643 | ✅ 209 行 | `byClientPlatform`/conformance 四项检查/per-platform baseline；17+58 测试；**不接 L1 lane、不跨平台硬比、无真实客户端实测**。 |
| 31 | `batch-13-platform-isolation.md` | 6387 | ✅ 108 行 | `detectClientPlatform` 显式信号、envelope 三字段 additive；23 测试；标签非授权。 |
| 32 | `batch-14-typed-plan.md` | 2302 | ✅ 56 行 | B14 不变量与验收线；typed-plan 为主/code fallback；无 A/B 数据不默认切换。 |
| 33 | `batch-14-typed-plan-spike.md` | 10118 | ✅ 142 行 | 原型 6 op/validatePlan/executePlan；9 测试；控制流/跨步计算必须留 Code Mode。 |
| 34 | `batch-14-typed-plan-engine.md` | 9107 | ✅ 141 行 | `src/typed-plan.js` 独立执行器、whole-plan 校验、readOnly 硬边界；12 测试；**未接任何路由**。 |
| 35 | `batch-14-typed-plan-v2.md` | 30464 | ✅ 511 行 | **设计稿**：原地加 plan 会破坏 Gemini snapshot；走 `/mcp/v2` 版本路径；schema/状态机/迁移/回滚/12 风险/验收清单；本文不执行切换。 |
| 36 | `batch-14-typed-plan-v2-route.md` | 7978 | ✅ 127 行 | `/mcp/v2` 已落地，`ENABLE_MCP_V2=1` 才暴露；v1 字节不变；20 测试；全量 1200/1194/0 fail/6 todo。 |
| 37 | `batch-14-typed-plan-ab.md` | 8649 | ✅ 122 行 | A/B runner 骨架（fake/replay），23 测试；CLI 报告必然 NOT_ENOUGH；`defaultSwitchAllowed` 恒 false。 |
| 38 | `batch-14-typed-plan-integration.md` | 6796 | ✅ 117 行 | `codemode.runTypedPlan` helper 接入三工具沙箱；16 测试；**不接 /mcp/v2 路由**。 |
| 39 | `batch-14-typed-plan-security.md` | 6769 | ✅ 106 行 | 截断读硬停 `PATCH_READ_TRUNCATED`、per-step approve 拒绝 `APPROVAL_REQUIRES_HOST`；18 测试；原型与生产语义有意不一致。 |
| 40 | `batch-15-auth.md` | 2984 | ✅ 63 行 | B15 总纲：owner/source/grantId/environment、v2 KV key、单 refresher、shared-grant 拒绝刷新；授权零容忍。 |
| 41 | `batch-15-auth-architecture.md` | 34801 | ✅ 455 行 | **设计稿**：五不变量、token schema、v2 key、OAuth provisioning、单 refresher 伪码、迁移回滚、T1–T12 + 真实 provider 清单；附录 A 列 R1–R6 代码差距。 |
| 42 | `batch-15-auth-arch-fix.md` | 11676 | ✅ 164 行 | R1–R6 实施：unmarked owner→shared、本地默认 local、回调完整身份、v2 key、state env 前缀、refreshPromise 合并；18 测试；迁移未执行。 |
| 43 | `batch-15-auth-e2e-harness.md` | 6722 | ✅ 116 行 | 隔离 HTTP E2E harness（loopback + fake fetch/store）；10 checks/9 测试；AUTH-READY 仍 NOT READY。 |
| 44 | `batch-15-auth-provisioning.md` | 8080 | ✅ 122 行 | config authMode、static_bearer、provision 脚本、AUTH-READY 门禁；22 测试；真实授权/KV/部署均未做。 |
| 45 | `batch-15-auth-sim.md` | 9330 | ✅ 100 行 | 确定性 refresh 并发模拟；16 测试；owner-fenced+二次读+keepalive 全绿；明确是待验证假设，不能外推真实 provider。 |
| 46 | `batch-15-capture-latency.md` | 28605 | ✅ 464 行 | **设计稿**：sync sink 实测 452ms/总 1049ms；推荐 D+C；硬约束不许关 CAPTURE_SYNC；P0 meta/正文分层；waitUntil 三 runtime 适配。 |
| 47 | `batch-15-capture-queue-integration.md` | 10025 | ✅ 124 行 | `CAPTURE_ASYNC_QUEUE=1` opt-in 接入 capture.js；9 测试；默认关闭，进程内 ring 不持久化，未验证 collector。 |
| 48 | `batch-15-capture-queue.md` | 12783 | ✅ 169 行 | 原型 ring/批量 flush/背压/DLQ/幂等/P0 优先通道；22 测试；未接生产。 |
| 49 | `batch-15-capture-sink-fix.md` | 6527 | ✅ 99 行 | HTTP sink 检查 2xx、`mcp_latency_ms` 在 originalEnd 打点；11 测试；不做 D+C 重写。 |
| 50 | `batch-15-claude-connector.md` | 5598 | ✅ 74 行 | Claude 官方回调精确 allowlist + DCR carve-out；9+20 测试；真实 connector 未验证。 |
| 51 | `batch-15-codemode-ergonomics.md` | 6741 | ✅ 109 行 | PR #77–#80 六项体验修复（notice-only content=''、URL 优先、unwrapBatch、truncation 元数据、默认原子、waitForPrChecks）；26 测试；旧构建反馈待部署复验。 |
| 52 | `batch-15-continuous-eval.md` | 3753 | ✅ 57 行 | `eval-cycle.mjs` 可重复检查；报告不覆盖；NO_BASELINE 预期；不接定时器/不联网。 |
| 53 | `batch-15-gh-p0.md` | 4908 | ✅ 53 行 | 真正下载提示混正文根因修复（guest 在 unwrap 前取 resources）、branch→ref 别名、method 枚举 guidance；16+112 测试。 |
| 54 | `batch-15-gpt-online-fix.md` | 7318 | ✅ 88 行 | ChatGPT 实测：Actions 415/302 不转 token、path 解析、id/nodeId 分离；15 测试；整批 unverified。 |
| 55 | `batch-15-l1-gap-wire.md` | 4989 | ✅ 79 行 | N1–N9/J1–J6 接入 L1 `--profile online-gap`；21 测试；不是质量证据，F1/F2 pending-deploy。 |
| 56 | `batch-15-local-e2e.md` | 4293 | ✅ 97 行 | loopback 真实路由 E2E 11 checks/2 测试；生产仍旧构建；8 个全量失败属并发 security-fix-2。 |
| 57 | `batch-15-online-eval.md` | 9218 | ✅ 108 行 | online-feedback.v1 schema + 记录脚本；7 条反馈逐条归属；整批保持 unverified 直到有 requestId 回放。 |
| 58 | `batch-15-online-replay.md` | 4873 | ✅ 79 行 | 在线会话离线回放 harness；22 测试；宿主/模型/部署/真写明确 not-comparable。 |
| 59 | `batch-15-online-semionline-join.md` | 8207 | ✅ 124 行 | F1–F6↔N1–N9 join + J1–J6；14 测试；同构建配对、禁止跨构建硬比；F1/F2 只是旧构建未部署。 |
| 60 | `batch-15-oss-blockers.md` | 6671 | ✅ 139 行 | 身份 `example-org/codemode-mcp-gateway`、中性 fixture、路径/vault 清理、F-09 fixture guard；147 测试；README/docs/eval 残留开放。 |
| 61 | `batch-15-oss-neutralizer.md` | 7839 | ✅ 156 行 | P0：转义形式 handle 泄漏（regex 解码后匹配导致假阴性）；neutralizer 覆盖 9 种编码 + digest 检测；23 测试；导出全绿但真实 handle 需独立扫描。 |
| 62 | `batch-15-oss-publish-blockers.md` | 6893 | ✅ 89 行 | 本地最终清理：真 DB id/node id/job id、fixture guard、package-lock/README 身份；staging/repo npm test 0 fail（117 skip）；剩余纯人工动作。 |
| 63 | `batch-15-oss-reverify.md` | 10489 | ✅ 146 行 | 重新导出 297 文件；**CI 首推门禁不绿**（npm test 10–11 fail + check-task-coverage exit 1）；真 DB id 存活 8+1 文件；publication blocked。 |
| 64 | `batch-15-platform-suite.md` | 4446 | ✅ 63 行 | 21 项离线 conformance 套件；真实 ChatGPT/Claude 客户端仍 unknown；typed-plan C1/C2/C3 记「未支持/等 v2」。 |
| 65 | `batch-15-provider-dcr-cimd.md` | 9490 | ✅ 118 行 | Notion DCR + Vercel CIMD 代码/13 测试；真实授权/KV/部署未做；AUTH-READY NOT READY；scope 分支兼容说明。 |
| 66 | `batch-15-reconnect-suite.md` | 6227 | ✅ 97 行 | 网关侧可观测测试 9 项 + 探针；实测 stale session 返回 200 完整表（非 404）；客户端内部分类记 unknown。 |
| 67 | `batch-15-residual-security-fix.md` | 6945 | ✅ 122 行 | R-01 错误脱敏（capture raw 不变）、F-08 截断语义统一、F-09 result.truncated、R-02 v2 预算；10 测试；R-07 未修。 |
| 68 | `batch-15-security-fix-2.md` | 6447 | ✅ 88 行 | F-01 模型可见错误脱敏、F-03 截断检测、F-04 预算、`__bridge` 不可猜测 + 原型污染防护、F-07 三态；21 测试；capture 不脱敏。 |
| 69 | `batch-15-semi-online-gaps.md` | 7650 | ✅ 97 行 | 8 类反馈→7 类半在线测试设计；23 测试 **17 pass / 6 todo**（P0 未修占位，不静默通过）。 |
| 70 | `batch-15-token-lifecycle.md` | 15045 | ✅ 168 行 | 根因 L1/L2/L3 + 状态机 + provider facts + 23 测试；生产 legacy key 需显式 owner；DSH-as-broker 未实现。 |

### 0.2 计数

```
expected = 70   （git ls-files docs/ledger 中 README + batch-8..15）
read     = 70   （全部逐文件全文打开）
unread   = 0
```

> `mcp-2026-07-compat.md`（18786 字节）与 batch-0..7 不在本审计员范围；仅在被范围文件引用时作为 `[文档]` 转述，未逐字打开，不对其内容独立下结论。

---

## 1. 五大重点主题的历史决策链

### 1.1 Auth owner（[文档] 定死 → [代码] 实现 → [未验证] 真实授权）

- **不可变结论**（`batch-15-auth.md` / `batch-15-token-lifecycle.md`）：DSH 与网关不能共用 rotating refresh token；Notion 对 replay 直接整族 revoke；锁/CAS 看不见外部进程。默认选**网关独立授权**，备选 DSH-as-broker（未实现）。
- **架构设计**（`batch-15-auth-architecture.md`）：owner ∈ gateway/dsh/manual/shared；`gmcgw:v2:grant:<env>:<owner>:<server>`；只有 `owner=gateway` 可刷新；local 默认、Vercel 无 `VERCEL_ENV` 兜底 preview；迁移 D 阶段清理 legacy 别名。附录 A 明确 R1（空 owner 默认 gateway）、R2（本地默认 production）、R3（回调缺身份）、R4（legacy key）、R5（state 无 env）、R6（无 refreshPromise 合并）六处代码差距。
- **代码落地**（`batch-15-auth-arch-fix.md`，18 测试）：R1–R6 全修；三条独立边界 = owner fence / environment fence / 单 refresher；truncation gate 把 `grantId.slice(0,12)` 改为完整 sha256（P0=0）。
- **provider 路径**（`batch-15-auth-provisioning.md` / `batch-15-provider-dcr-cimd.md`）：Notion DCR、Vercel CIMD + `offline_access`、Linear `static_bearer`；12+13+22 测试。
- **验证边界**：`batch-15-auth-sim.md` 16 测试证明「owner-fenced + 锁内二次读 + keepalive」在 fake 模型下全绿，但**明确不可外推真实 provider**；`batch-15-auth-e2e-harness.md` 10 checks 全绿但只注入 fake fetch/store。**迁移未执行、真实 KV/授权/部署未做，AUTH-READY 仍 NOT READY**（`AGENTS.md` §0）。这是「代码就绪 ≠ 可授权」最典型的例子。

### 1.2 Online-eval（[文档] 流程 + [测试] harness；线上状态仍 unverified）

- `batch-15-online-eval.md` 定义 `online-feedback.v1`；7 条反馈 F1–F7，**requestId 全 `unknown`**，整批状态 unverified；F1/F3/F4 的「已修」只指代码层+定向测试，归属 B8/B11。
- `batch-15-semi-online-gaps.md`：把 7 条症状抽象为 T1–T7；23 测试中 **6 个 test.todo** 对应 P0 未修（branch→ref、method 枚举、guest notice），绝不静默通过。
- `batch-15-online-semionline-join.md` + `batch-15-l1-gap-wire.md`：F1–F6↔N1–N9 join，新任务 J1–J6；写死**同构建配对、禁止跨构建硬比**；F1/F2 判定为「旧构建未部署」（G2）而非当前缺陷。
- `batch-15-online-replay.md` / `batch-15-continuous-eval.md`：离线回放 harness 与可重复检查；宿主/模型/部署/真写明确 not-comparable；NO_BASELINE 是预期，不能当质量门禁通过。
- **与 FRAMEWORK 呼应**：对应「主动/被动线上评测」模块——在线反馈必须走 F 矩阵 → G1–G6 → N/J/T → 确定性测试 → 旧/新构建对照 → 部署后复验。ledger 完整记录了前半段，**部署后在线复验（J-DEPLOY）全部未完成**。

### 1.3 Typed-plan（[代码] 完整骨架 + [文档] 设计 + [未验证] A/B 与切换）

- `batch-14-typed-plan*.md` 六份：设计/测试计划 → spike（9 测试）→ 生产引擎 `src/typed-plan.js`（12 测试）→ v2 设计稿（511 行）→ `/mcp/v2` 路由（20 测试）→ A/B runner（23 测试）→ codemode helper 集成（16 测试）→ 安全修复（18 测试）。
- **核心架构决策**：不原地给 v1 `execute` 加 `plan`（破坏 Gemini function-declaration snapshot 与工具列表冻结），改走 `/mcp/v2`；`ENABLE_MCP_V2=1` 才启用，默认关闭；三工具同名同序，`plan` 是入参不是第四工具。
- **安全硬化**：`PATCH_READ_TRUNCATED` 截断读硬停、per-step `approve` 改为 `APPROVAL_REQUIRES_HOST`（只有 host options 可授权）、`readOnly` 服务端硬边界、v2 预算接入（R-02）。
- **未验证**：无真实 A/B 数据；`defaultSwitchAllowed` 恒 false；`meta.fallback` 四原因中仅 reason=4 在路由实现；OAuth `resource`/audience 方案 A/B 待真机确认。**「测试绿」在这里明确不等于切换到 S**。

### 1.4 Security（[代码] 双投影边界 + [测试]；capture 不脱敏是红线）

- `batch-15-security-fix-2.md`：F-01 模型可见错误脱敏（`redactSecrets`/`modelErrorMessage`）、`__dshHostBridge9f4c2a` 不可猜测 + 原型污染防护、F-04 唯一计费点、F-07 `truncated:null` 三态；**capture 保持 full-fidelity，raw Error.message 不改**（AGENTS.md §6 双投影）。
- `batch-15-residual-security-fix.md`：R-01 server.js 直接错误路径脱敏、F-08 截断真值表统一、F-09 `boundResult` 结果级 flag、R-02 v2 预算；10 测试。R-07（多层 JSON 嵌套显式截断漏报）仍为已知边界。
- `batch-11-truncation*.md`：P0 静默字符截断的根因是模型手写 `slice(0,150)`，修法是给原语（readFileRange）+ 显式标记 + CI 守门；**模型仍可手写 slice 绕过**（guidance 非静态分析）。
- **安全红线一致性**：所有安全批次都声明「不脱敏 capture，只改模型可见投影」；这与 AGENTS.md §6 完全一致，但要求 capture 桶按 secret 级存储对待。

### 1.5 OSS（[测试] 本地导出全绿 ≠ 可发布）

- `batch-15-oss-neutralizer.md`：P0 泄漏是正则 `\u002d` 被 JS 解析为连字符，导致转义形式 handle 假阴性；修为 9 种编码 neutralization + SHA-256 digest 检测；23 测试。
- `batch-15-oss-blockers.md` / `batch-15-oss-publish-blockers.md`：中性 fixture、身份 `example-org/codemode-mcp-gateway`、真 DB id 替换、fixture guard；staging 与本地 release repo `npm test` 0 fail（117 skip）。
- `batch-15-oss-reverify.md` 是最诚实的反例：重新导出 297 文件后，`export-oss --check` PASS、无 handle/真域名/个人路径，但 **CI 首推门禁不绿**（npm test 10–11 fail、check-task-coverage exit 1），真 DB id 存活 8+1 文件，身份未定稿，release notes/tag 未写；结论 **publication blocked**。
- **与 AGENTS.md 一致**：OSS 未公开，只有 `work/oss-release-staging` / `work/oss-release-repo` 本地产物，0 remote/0 tag；不能有「测试绿=可发布」的推断。

### 1.6 平台隔离（[代码] 标签与编码 + [未验证] 真实客户端）

- `batch-13-active.md` 定义 single-owner 分账；`batch-13-platform-isolation.md`（23 测试）与 `batch-13-platform-eval.md`（17+58 测试）落地 clientPlatform/clientProfile/oauthClientId 标签、`byClientPlatform`、conformance 四项检查。
- 硬边界：**不猜平台**（旧 envelope 全进 unknown）、**不跨平台硬比 baseline**、**不用平台标签做写路径/权限**、三工具名/数量/schema 不变。
- `batch-15-claude-connector.md`（9+20 测试）与 `batch-15-platform-suite.md`（21 测试）补 Claude 回调 allowlist 与 conformance 套件，但均标明**真实 connector/真实客户端未验证**。
- `batch-15-gpt-online-fix.md` 是真实 ChatGPT 实测反馈的代码层修复，但 requestId unknown、整批 unverified。

---

## 2. 反复出现的根因（跨批次复盘）

1. **上游结果形状漂移 → 消费侧反复踩坑**：B8 canonical helper → B10 result-normalize → B11 gh-feedback（id 当 number）→ B15 gh-p0（下载提示混正文，根因是 `__dshUnwrap` 在 helper 入口就丢了 resources）→ B15 gpt-online-fix（path 解析）→ B15 codemode-ergonomics（notice-only content='' 固定语义）。L3 = 没有把「常用能力的结果契约」当产品一等能力；治理方式是 canonical adapter + `raw` 保留 + 真实 capture 回放。
2. **Vercel 实例冻结 / waitUntil 不可靠 → 一切"响应后后台跑"都不可信**：B9 capture 丢失 → B11.1 必须 `CAPTURE_SYNC=1`（+0.4–0.5s） → B15 capture-latency 设计 D+C → B15 capture-queue 原型 → B15 capture-queue-integration 默认关闭 flag。结论：**不能靠关 CAPTURE_SYNC「修复」延迟**；进程内 ring 不持久化。
3. **多 owner 共享 rotating grant / 并发消费一次性凭证**：B0 历史 CAS → B15 auth 全链（owner fence + lease + 锁内二次读 + CAS + journal + refreshPromise）。L3 = 锁/CAS 看不见外部 DSH 进程；唯一解是独立 grant 或 broker。
4. **工具列表 / schema 稳定性被低估**：B11 reconnect（Gemini 不消费 list_changed、不能强制重连）→ B14 v2 版本路径（不原地改 schema）→ B15 platform conformance 的 `stable_tools_list` 硬不变量。所有变更都走「版本路径 + 工具名同序 + 不原地改」。
5. **文档承诺跑在代码/真实世界之前**：大量台账自述「已实现 + 测试绿」，但同一文件里写明「未部署 / 未 commit / 真实客户端未验证 / AUTH-READY NOT READY / publication blocked」。这是本批次最需要在审计中显式区分的部分（见 §3–§4）。
6. **并发 agent 干扰导致全量测试数字漂移**：多个 ledger 明确记录「全量 N pass / M fail 属其他 agent 并发改动，本批不碰」，并以本批定向结果为准；这本身是诚实做法，但也意味着任何单一 ledger 的「全量绿」都不能当最终基线（以 lead 最近一次全量为准）。

---

## 3. 与 FRAMEWORK 六模块的对应

| FRAMEWORK 模块 | 本范围台账证据 | 成熟度判定 |
|---|---|---|
| 1 工具面（search/execute_read/execute） | B8/B10 helper、B11 client-adapter、B13 platform、B14 v2 route、B15 claude/gh-p0 | `[代码]` 三工具稳定；conformance 14 测试 + 21 套件；v2 同三工具。 |
| 2 Code Mode / 沙箱 | B8 helpers、B11 truncation/adaptive、B14 integration、B15 security/ergonomics | `[代码]` 真隔离、原语齐备、预算/脱敏/原型污染防护；`[未验证]` 模型手写 slice 绕过、A/B 未跑。 |
| 3 读写分层与写路径 | B10 patch-write/idempotent/write-semantics、B11 write-transaction、B14 typed-plan 安全 | `[代码]` dryRun 默认、strict patch、push_files 原子写、per-step approve 拒绝；`[未验证]` 真实写回放后线上复验。 |
| 4 结果/截断/编码 | B9 digest、B11 truncation 三件套、B11 client-adapter、B13 platform、B15 residual/security | `[代码]` 三信号分账、字节级审计、profile 隔离；`[未验证]` 真实 ChatGPT/Claude wire 消费。 |
| 5 主动/被动线上评测 | B9 l1-real、B11 session-clustering、B15 online-eval/online-replay/join/semi-online-gaps/continuous-eval/l1-gap-wire | `[文档+测试]` 流程与 harness 齐备；**部署后在线复验 J-DEPLOY 全未做**；requestId 全 unknown。 |
| 6 认证 / 部署 / 开源架构 | B11 reconnect、B15 auth* / provider / oss* / capture-latency / local-e2e / reconnect-suite | `[代码]` owner/environment/lease 三边界、OSS 中性化；`[未验证]` 真实授权、CI 首推门禁、publication blocked、生产仍 `d1f36ba`。 |

---

## 4. 仍需真实验证项（按优先级）

1. **Auth 真实授权与生命周期**：三个 provider 各一次 gateway-owned 授权 / static bearer，观察一个完整刷新周期无 `invalid_grant`；preview 缺授权时不读 production key；shared grant 401 时 refresh 调用=0；迁移后删除 legacy v1 别名。（`AUTH-READY.md` NOT READY 是唯一门禁）
2. **OSS 发布门禁**：CI 首推 `npm test` 与 `check-task-coverage` 必须绿；真 DB id/node id/job id 从 8+1 文件清除；真实 owner/repo 名、release notes、首 tag 由人确认；0 remote/push。
3. **部署后在线复验**：F1/F2 真实窗口回放（带 requestId + capture）、F3 PR #53 merge helper、F6a 真实 Actions 日志、long-session unknown_tool 判别；整批状态从 unverified 升级需可回放证据。
4. **Typed-plan A/B**：`/mcp/v2` 真实 Gemini 会话配对实验（≥3 次 real 重复、反序、每任务新 session）、A1–A7 门槛、fallback 率/reason、OAuth resource 方案 A/B 真机验证；数据不足或任一门槛未达保持 F 默认。
5. **真实客户端 conformance**：ChatGPT Business/Claude 的 `pass` 仍 unknown；structuredContent/annotations/401 metadata 在真实 wire 上验证。
6. **Capture 异步队列**：collector 持久化能力、runtime waitUntil 可靠性、崩溃后 ring 不丢 P0 的实测；在验证前生产保持 `CAPTURE_SYNC=1`。
7. **平台 eval lane**：`run-l1-smoke.mjs` 接平台标签、各平台独立冻结 baseline（当前 Gemini 单平台），`platform-conformance` 作为前置 gate。
8. **持久状态/自适应/Figma 缓存**：三份纯设计（B11 durable-state/adaptive/figma-cache）需先做 taskId 埋点、原语接入、Upstash key 权限实测、waitUntil 可靠性验证，才谈实现。

---

## 5. 证据判读纪律（本报告的自我约束）

- 本报告中「已实现」一律指 ledger 自述 `[代码]` + `[测试]`，**不代表线上生效**；当前生产以 `AGENTS.md` §0 的 `d1f36ba` 为准。
- 凡 ledger 写「未 commit / push / deploy」「NOT READY」「publication blocked」「unverified」「unknown」「todo」的，原样保留为 `[未验证]`，不升级措辞。
- 不引用任何未逐字打开的文件作为独立结论；跨批次引用只做 `[文档]` 转述。
- 测试数字（如 1200/1194、1352/1346、988/982 等）是各 ledger 当时的本地快照，受并发 agent 影响；**最终基线以 lead 最近一次全量测试为准**，本报告不宣称任何单一数字为当前基线。

---

> 本文件为只读审计产物；未修改任何 src/、scripts/、tests/、README、其他 docs 或 workflows；未 commit / push / deploy。
