# 全量开源文档深读审计（13-oss-docs）

> 审计日期：2026-11-24（Asia/Singapore）。
> **只读审计；本报告是本次唯一写入文件。**
> 未修改 `src/`、`scripts/`、`tests/`、README、其他 docs、workflows；未 commit / push / tag / deploy。
> 阅读范围：`git ls-files docs/OPEN-SOURCE` 全部 29 个文件，**逐文件完整打开**（非只看标题、非 grep 替代阅读）；两个超长表格行（WEB-CLIENTS.md L32/L33）另用逐行全文读取补齐。
>
> 标注约定：本报告所有结论按证据等级标注 **`[代码]` / `[文档]` / `[测试]` / `[未验证]`**。
> **绝不把「本地通过」写成「可公开」**：`PASS(本地)` ≠ `公开可用`；`SKIP` / `NOT-RUN` / `BLOCKED` ≠ `PASS`。
> 所有数字、commit、状态以被审文档自身记载为准；对相互矛盾处并列记录、不裁决、不编造。

---

## 1. 清单与覆盖：expected / read / unread

`git ls-files docs/OPEN-SOURCE` 输出（29 行，即 expected=29）：

```text
docs/OPEN-SOURCE/CLIENT-PROFILES.md
docs/OPEN-SOURCE/COMPETITOR-RANKING.md
docs/OPEN-SOURCE/COMPETITORS.md
docs/OPEN-SOURCE/DEPLOYMENT-TEMPLATES.md
docs/OPEN-SOURCE/DIFFERENTIATION.md
docs/OPEN-SOURCE/DOCKER-VERIFICATION.md
docs/OPEN-SOURCE/DOCKER.md
docs/OPEN-SOURCE/EXPORT-IMPLEMENTATION.md
docs/OPEN-SOURCE/EXPORT-MANIFEST.md
docs/OPEN-SOURCE/EXPORT-TEST-CURATION.md
docs/OPEN-SOURCE/EXPORT-VERIFICATION.md
docs/OPEN-SOURCE/FINAL-HEALTH-AUDIT.md
docs/OPEN-SOURCE/IBM-CONTEXTFORGE-VS-US.md
docs/OPEN-SOURCE/INDEPENDENT-REVIEW-2026-11-24.md
docs/OPEN-SOURCE/PLAN.md
docs/OPEN-SOURCE/PUBLIC-SAFETY-AUDIT.md
docs/OPEN-SOURCE/READINESS.md
docs/OPEN-SOURCE/README.md
docs/OPEN-SOURCE/RELEASE-DRYRUN.md
docs/OPEN-SOURCE/RELEASE-LOCAL.md
docs/OPEN-SOURCE/RESIDUAL-RISK-AUDIT.md
docs/OPEN-SOURCE/REUSE-RESEARCH.md
docs/OPEN-SOURCE/WEB-CLIENTS.md
docs/OPEN-SOURCE/deep/README.md
docs/OPEN-SOURCE/deep/agentgateway.md
docs/OPEN-SOURCE/deep/bifrost.md
docs/OPEN-SOURCE/deep/cloudflare-portals.md
docs/OPEN-SOURCE/deep/gemini-bastion.md
docs/OPEN-SOURCE/deep/toolgate.md
```

**覆盖统计：expected=29 / read=29 / unread=0。**

- 字节数由 `Get-Item -LiteralPath <file>.Length` 取得（见 §2 表，合计约 526 KB）。
- 29 个文件全部用 read 工具逐行读完；其中 `WEB-CLIENTS.md` L32（2938 字符）、L33（2019 字符）被 read 工具的 2000 字符行截断，已用 `Get-Content` 逐行读取全文补齐，无遗漏。
- 未使用 grep 替代阅读；grep 仅用于 §5 旧数字/内部引用的交叉核验。

---

## 2. 逐文件读取记录（路径 / 字节 / 读完 / 关键结论）

| # | 文件 | 字节 | 读完 | 关键结论（证据等级见 §3–§7） |
|---:|---|---:|---|---|
| 1 | `README.md` | 1,578 | ✅ | 开源工作区索引；建议名 `codemode-mcp-gateway`；v0.1 客户端 Gemini tested / Claude target / ChatGPT documented-not-promised；部署 Local+Docker+Vercel，Cloudflare design-only；单一 owner；**未过 `PLAN.md` §7 不得发布**。文件本身含字面 `\n`（L8）渲染 bug。 |
| 2 | `PLAN.md` | 10,535 | ✅ | 发布计划（proposal，非决策）：定位、交付模型（新公开仓 + allowlist 导出）、客户端/部署矩阵、W-OSS-1…6 工作流、§7 release gate（11 项全未勾）、§8 非目标、§9 五个 lead 未决项。L45 含字面 `\n`。 |
| 3 | `READINESS.md` | 5,319 | ✅ | **L0–L3 四级门槛 + G0–G6 门禁的权威定义**；当前 G0/G1/G5 部分、G2/G3/G4 未过、G6 未做；结论「不能公开发布」；首发目标 L1 usable alpha，不跳过 L0。 |
| 4 | `DIFFERENTIATION.md` | 9,405 | ✅ | 差异化 = 持续上下文/工具调用优化闭环，不是聚合；**L70/L84 仍写 1,520 tokens / -99.4%**（与最终实测 3,564 / -98.5% 冲突，待清）；记录「检索提升 ≠ 任务成功」外部证据。 |
| 5 | `COMPETITOR-RANKING.md` | 10,794 | ✅ | 按用户/痛点/场景加权的竞品 Top12（工程判断，非市场数据）；deep 核验后 agentgateway 从 #1 降到 #10、toolgate 从 #3 到 #7；L18/L114 用 506→3 / -99.4% 旧口径。 |
| 6 | `COMPETITORS.md` | 36,815 | ✅ | 三轮竞品调研（品类→问题空间→Firecrawl）；**L96 直接写真实个人 handle `Bruce-Yii/gemini-mcp-gateway`**；L146 旧数字 1,520/-99.4%；L12 字面 `\n`；竞品自述数字均标注未独立复现；「未验证」项不升级为事实。 |
| 7 | `IBM-CONTEXTFORGE-VS-US.md` | 38,846 | ✅ | 对 IBM/mcp-context-forge 的源码级审查（commit `14a4c4a6`）；结论：它压工具**结果**（TOON，默认 disabled），我们压工具**定义**；无 Code Mode / web connector；**[代码]/[官方]/[未验证] 标记规范**；L239/L268/L330/L414 旧数字 1,520/-99.4%。 |
| 8 | `REUSE-RESEARCH.md` | 38,420 | ✅ | 复用/许可证深调研：可复用 `@cloudflare/codemode@0.5.6` 的纯函数；**不采纳 MCP Groups SEP-2084（已被 Core Maintainers 拒绝）**；`forgemax` = FSL-1.1-ALv2 **不能复制**；§5 逐项许可证分级；明确「research only，无实现决策」。 |
| 9 | `WEB-CLIENTS.md` | 19,440 | ✅ | 客户端矩阵（Gemini/ChatGPT/Claude/Copilot/Grok/Perplexity 等）：Streamable HTTP + OAuth 2.1 DCR + PKCE 是共同基线；阻断是账号/策略与 schema 大小；Gemini 不支持 `structuredContent`、ChatGPT 需 `readOnlyHint`；Gemini 是唯一实测客户端；第三方数字标未验证。 |
| 10 | `CLIENT-PROFILES.md` | 7,661 | ✅ | **DESIGN ONLY**：`templates/client-profiles/*.json` 运行时不读取；`src/client-profile.js` 硬编码三个 frozen profile；ChatGPT callback / Claude callback 是提案；明确「一 owner 多平台 ≠ 多租户」。 |
| 11 | `DEPLOYMENT-TEMPLATES.md` | 29,392 | ✅ | 四种环境（Local/Vercel/Cloudflare/Docker）模板与 gap list；只有 Local Node + Vercel 今天能跑；Cloudflare/Docker OAuth+KV 全部「需开发」；**L127 含真实私有 vault 路径 `D:\12412\dsh-home\.secrets\...`**（PUBLIC-SAFETY-AUDIT F-04 命中，公开前必须中性化）；§0 称「无 Dockerfile」，与后续实际新增的 Dockerfile 不一致（旧事实）。 |
| 12 | `DOCKER.md` | 4,650 | ✅ | 独立 CLI 容器路径的可运行说明；镜像只跑 `node src/server.js`，无 OAuth/`/healthz`/KV；healthcheck 是 TCP 3000 而非 HTTP；`--host 0.0.0.0` 必需；config 只放 env 变量名。 |
| 13 | `DOCKER-VERIFICATION.md` | 8,988 | ✅ | 2026-11-23 真实 Docker Desktop 验证记录：build / non-root / 0.0.0.0 监听 / healthcheck healthy / `curl /mcp` 405(GET)/200(POST) / `/healthz` 404 全 PASS；无真实 token；**与后续 FINAL-HEALTH-AUDIT §7 的 daemon 未运行 NOT-RUN 并存**，需按时间点解读。 |
| 14 | `EXPORT-MANIFEST.md` | 4,533 | ✅ | 新公开仓交付模型：allowlist include / denylist exclude 清单；导出树必须过 `npm ci && npm test` + truncation audit + config validation；fresh git history；**L132 注释含个人 handle 默认值描述**。 |
| 15 | `EXPORT-IMPLEMENTATION.md` | 6,932 | ✅ | `scripts/export-oss.mjs` 机制说明：默认 dry-run，只 copy，不 git init/commit/push/deploy；allowlist→denylist→内容与路径校验；**L86/L87 描述检测器覆盖 `Bruce-Yii`/`D:\12412` 等个人模式**（私有工具语义，公开版需自擦除）。 |
| 16 | `EXPORT-VERIFICATION.md` | 10,262 | ✅ | 2026-11-23 真实导出验证：活仓库直接导出 **REFUSED**（14,510 denylist 命中），须先 stage 中性源再用 `--source`；215 文件写入 --write 成功；**`npm test` FAIL 678/669/9**（测试未 export-clean，需策展）——历史状态，后续 EXPORT-TEST-CURATION 修复。 |
| 17 | `EXPORT-TEST-CURATION.md` | 5,239 | ✅ | 测试策展：私有 fixture 依赖的测试用 `{skip: reason}` 显式跳过；**761 tests / 684 pass / 0 fail / 77 skipped**；「绝不伪造 fixture」；列出全部 77 skip 的归属。 |
| 18 | `RELEASE-DRYRUN.md` | 16,366 | ✅ | 多次 dry-run 历史：顶部为最终 blocker-fix re-run（301 文件、0 fail、117 SKIP、0 真实 DB/node/job id）；§8 记录最新源码复核出现 **11 fail + `check-task-coverage` exit 1**（2 个未决问题）与 PR DB id 残留 8+1 文件——顶部与历史段落并存，须按顶部解读。 |
| 19 | `RELEASE-LOCAL.md` | 13,262 | ✅ | 本地 release repo 准备：多次重导出（263→287→297→301 文件）；当前 HEAD/文件数按顶部为准；**全程 0 remote / 0 tag / 0 push**；P0 handle 转义逃逸已修；剩人工项（真实 owner/repo、release notes、首个 tag）。 |
| 20 | `PUBLIC-SAFETY-AUDIT.md` | 28,453 | ✅ | 独立公开安全审计（历史快照）：F-01 个人 handle 转义形态 63 处/11 文件（P0）、F-02 检测器假阴性（P0）、F-03…F-11；结论 **DO NOT PUBLISH**；§5 记录 P1/P2 部分修复（F-03/F-04/F-05/F-07/F-09 fixed in-scope；F-06/F-08/F-10 open）。 |
| 21 | `RESIDUAL-RISK-AUDIT.md` | 31,461 | ✅ | 安全复核 + auth readiness：R-01（server.js 直接工具错误未脱敏）、R-02（v2 预算绕过）、F-08/F-09（截断字段矛盾/缺失）当时未修；AUTH-READY 判 NOT READY（8 FAIL + 3 UNKNOWN）；Vercel CIMD BLOCKED；capture 保真 vs 模型脱敏是双投影不矛盾。**注：INDEPENDENT-REVIEW §2 称 R-01/F-08/F-09/R-02 后续已在代码与测试落地**——两文档时间点不同，并列保留。 |
| 22 | `FINAL-HEALTH-AUDIT.md` | 18,427 | ✅ | 发布前全面健康检查（HEAD `0ae6d9f`）：私库 1352/1346/0/6 PASS；OSS 两产物 0 fail/117 skip PASS；**Docker NOT-RUN、npm audit NOT-RUN（npmmirror 404）、文档一致性 FAIL**；§10 明确「代码绿 vs 线上未部署/未授权」。L4 含真实私有工作区绝对路径。 |
| 23 | `INDEPENDENT-REVIEW-2026-11-24.md` | 5,820 | ✅ | 接手窗口独立审查（HEAD `758a232`）：推翻旧结论——生产是 `758a232` 不是 `87d91af`；V0 仍 0/7；A 退回 PARTIAL；push 即上线；Vercel CIMD 结论应 UNKNOWN；真实 tools/list 5 上游未验收。 |
| 24 | `deep/README.md` | 2,106 | ✅ | 5 份源码级 deep dive 索引；对竞品排名的 4 项关键修正（agentgateway 不做 Code Mode、toolgate 是 PoC、Cloudflare `search_and_execute`≠Code Mode、gemini-bastion 的 hint 是策略层）。 |
| 25 | `deep/agentgateway.md` | 29,050 | ✅ | 源码核验：无 progressive disclosure/Code Mode；PR #3859（与本项目几乎同构的 `mcp_search`/`mcp_call`）被 maintainer 明确拒绝（「proxy 不该内置 bespoke MCP server」）；hosted web client 适配是 OPEN issue #4366；**L4 含个人 handle**（`gh auth status` 记录）。 |
| 26 | `deep/bifrost.md` | 17,655 | ✅ | 9.9k★ 但主体是 LLM gateway；Code Mode = 4 工具 + Starlark 沙箱；92.8% 有公开基准原始数据但只在大规模工具场景成立且未本地复跑；无 Gemini/ChatGPT web；无 `execute_read` 强分层。 |
| 27 | `deep/cloudflare-portals.md` | 32,835 | ✅ | 纠正三机制混淆：`minimize_tools`（只留 name）、`optimize_context=search_and_execute`（2 工具代理，**非** Code Mode）、`codemode=search_and_execute`（真 JS）；Portals 闭源、企业向；无 Gemini/ChatGPT web 一手支持；**L4/L28 含个人 handle**。 |
| 28 | `deep/gemini-bastion.md` | 26,566 | ✅ | 1★ 极新项目、单 commit 不可审计历史；10 固定工具、无 Code Mode；`readOnlyHint:true` 默认欺骗 Web Gemini 弹窗（自承是 hint 层非真只读）；Docker/GHCR 分发领先；capture/eval 完全没有；**L4 含个人 handle**。 |
| 29 | `deep/toolgate.md` | 17,624 | ✅ | 0★ 无 license PoC；两工具检索+透传真实可跑；默认 hash/heuristic 假模型、e2e 从未对真实 API 跑；本地实跑评测 full-hit@5 最高 0.821、rerank 反而降 MRR；**L4 含个人 handle**；结论「抄方法论可以，抄结论不行」。 |

读完率 **29/29**。字节合计 **488,434**（`Get-Item.Length` 对 29 个文件求和，与 §2 表逐项相加一致，约 477 KiB）。

---

## 3. 开源 L0–L3 门槛审计（权威定义来自 `READINESS.md` §1）

| 等级 | READINESS 定义 | 本目录文档中的当前判定 | 关键证据 |
|---|---|---|---|
| **L0** source-available alpha | 可公开：源码/README/LICENSE/CI/基本测试；不可宣称「可自托管/支持某客户端」 | **接近但未确认过线；若此刻公开会超 L0 宣称** | `READINESS` §3 G0 部分/G1 部分；`PUBLIC-SAFETY-AUDIT` F-01/F-02 历史 P0（§5 记录修复）；`COMPETITORS.md:96` 含真实个人 handle；`DIFFERENTIATION.md:70` 旧数字；`06-oss.md` §3.1 同判定。 |
| **L1** usable alpha | 一条真实客户端端到端 + 真实读/写/授权至少一条 + Docker/安装可复现 | **未过** | `READINESS` §3 G2 未过/G5 部分；`FINAL-HEALTH-AUDIT` §7 Docker NOT-RUN；`INDEPENDENT-REVIEW` §4 B/C/D 门 FAIL；`RESIDUAL-RISK-AUDIT` §3 AUTH NOT READY。 |
| **L2** maintainable beta | 多客户端/多上游、稳定 API、贡献流程、安全策略、版本/发布 | **未过** | `CLIENT-PROFILES.md` DESIGN ONLY；无 tag/release notes（`RELEASE-LOCAL` §5 未勾）；`06-oss.md` §4.4/§4.6 记录社区与版本策略缺口。 |
| **L3** production-ready | SLO、迁移/回滚、安全响应、依赖治理、长期维护承诺 | **远未到** | `FINAL-HEALTH-AUDIT` §8 npm audit 无结论；`RESIDUAL-RISK-AUDIT` §3.1 回滚演练 FAIL；`06-oss.md` §3.1 同判定。 |

- **首发目标**：`READINESS` §1/§4 明确 L1 usable alpha，不跳过 L0，不承诺 L3。
- **G0–G6 当前状态**（`READINESS` §3 `[文档]`）：G0 部分、G1 部分、G2 未过、G3 未过、G4 未过、G5 部分、G6 未做 → 结论「不能公开发布」。
- **禁止「本地通过=可公开」的证据**（`[测试]` 为历史记录值，非当前实跑）：私库 `npm test`、导出树 `npm test 0 fail / 117 SKIP`、`export-oss --check PASS`、`audit-truncation P0=0` 全是本地门；`INDEPENDENT-REVIEW` §4 的真实客户端/写回环/授权门全 FAIL；SKIP / NOT-RUN / BLOCKED 一律不计 PASS。

---

## 4. 安全 / 身份 / 许可证审计

### 4.1 安全（含模型可见脱敏、capture 边界、授权）

- `[文档]` `RESIDUAL-RISK-AUDIT` §1–§2：F-01 模型错误脱敏核心路径 PASS（但 R-01 `src/server.js:67-68` 直接工具错误路径未脱敏，当时判 P0）；F-03 capture 截断审计误判 PASS；F-06 `__proto__` 守卫 PASS；F-07 三态语义 PASS；**F-08（`truncated:false` 与 `--- TRUNCATED ---` 并存）、F-09（`boundResult` 无结果级 flag）当时 FAIL**；R-02 v2 plan 预算绕过（v2 默认关闭）。
- `[文档]` `INDEPENDENT-REVIEW` §2 称 R-01/F-08/F-09/R-02 后续已在代码与测试落地；两文档时间点不同（11-23 vs 11-24），**本报告并列记录，不合并为「已修」结论**。
- `[文档]` `RESIDUAL-RISK-AUDIT` §4：**capture 全保真**（`tests/capture.test.js` 反向断言保留 credential header）与**模型可见错误脱敏**是同一数据两种投影，不矛盾；R-01 是模型投影侧漏做脱敏，不是 capture 保真问题。
- `[文档]` `RESIDUAL-RISK-AUDIT` §3：AUTH-READY 22 项中 11 PASS（均代码/测试层）、3 UNKNOWN、8 FAIL → **NOT READY，不得发起授权**；Vercel CIMD 代码就绪但真实授权 BLOCKED。
- `[文档]` `INDEPENDENT-REVIEW` R2：生产 env 有 NOTION/LINEAR/FIGMA refresh token 但无 owner 标记；未标记 grant 禁止刷新；`/healthz` 不连上游；R4 preview/production 共 KV。
- `[文档]` `PUBLIC-SAFETY-AUDIT` F-11：未发现真实凭据；`*_TOKEN` 都是 env 变量名或占位符；邮箱 `@example.com`；无 Vercel project id / Upstash REST URL。

### 4.2 身份与个人 residue（公开门槛）

| 类型 | 命中位置（节选） | 证据 | 风险 |
|---|---|---|---|
| 真实个人 handle `Bruce-Yii` | `COMPETITORS.md:96`；`deep/{agentgateway,cloudflare-portals,gemini-bastion,toolgate}.md:4`（cloudflare-portals 还有 L28）；`EXPORT-MANIFEST.md:132`、`EXPORT-IMPLEMENTATION.md:86` 为检测器描述 | `[文档]` | `PUBLIC-SAFETY-AUDIT` F-01 历史 P0；私有检测器 + neutralizer 已修（RELEASE-LOCAL §4），但**这些文档自身在本次读取时仍含字面 handle**，导出必须中性化。 |
| 真实私有路径 `D:\12412\dsh工作区\...` | `FINAL-HEALTH-AUDIT.md:4`；`DEPLOYMENT-TEMPLATES.md:127`（`D:\12412\dsh-home\.secrets\...`） | `[文档]` | `PUBLIC-SAFETY-AUDIT` F-04 命中；公开前必须替换为占位。 |
| 真实仓库名 / 部署域名 | `FINAL-HEALTH-AUDIT.md:156`（`origin https://github.com/Bruce-Yii/gemini-mcp-gateway.git`）；`RESIDUAL-RISK-AUDIT:16`、`INDEPENDENT-REVIEW:47` (`gemini-mcp-gateway.vercel.app`) | `[文档]` | 私有仓库自有远端/Vercel 域名，非 OSS 产物，但出现在公开候选文档里需清理。 |
| 真实 PR DB id / node_id / job id / R2 bucket | `PUBLIC-SAFETY-AUDIT` F-05；`RELEASE-DRYRUN` §8 / `RELEASE-LOCAL` 顶部称本地导出已降到 0 命中 | `[文档]` | 历史 P1；以顶部最新说明为准，仍需独立复核。 |

### 4.3 许可证审计

- `[文档]` 本项目 LICENSE = MIT（`RELEASE-LOCAL` §4.2；`06-oss.md` §2.2），但 owner/year 仍是 `example-org` 占位，需发布 owner 确认。
- `[文档]` `REUSE-RESEARCH` §5 给出 15+ 候选许可证分级：`@cloudflare/codemode`/`run`/`acorn` MIT 可依赖；`@ai-sdk/code-mode` Apache-2.0 可借鉴；`@modelcontextprotocol/sdk` 处于 MIT→Apache-2.0 过渡，摘抄源码需逐文件审；**`postrv/forgemax` FSL-1.1-ALv2 不可复制**；`mcp-use-ts` 无 license 且 archived 不要碰；无 AGPL 依赖。
- `[文档]` `READINESS` G0「第三方依赖许可证审计」未勾；`06-oss.md` §4.4 指出**对本仓库实际依赖树的许可证清单 + NOTICE 产物缺失**——调研结论 ≠ 合规产物。

---

## 5. 客户端 / 上游 onboarding 模板审计

- `[文档]` `WEB-CLIENTS.md` §1/§2：Gemini 是唯一实测；Claude.ai 描述为 low-effort target（需补 annotations、≤150k 结果、401 metadata）；ChatGPT 是 **plan-gated**（Business/Enterprise/Edu full MCP；Pro read/fetch only），需 adapter（annotations、dual encoding、benign 描述、`offline_access`），明确「不作为首发目标」；Grok OAuth+DCR 有第三方复现 broken 报告（未验证）；Grok/Perplexity/Consumer Copilot 一律不承诺。
- `[文档]` `CLIENT-PROFILES.md`：**DESIGN ONLY**——三个 JSON 模板运行时不读取；`src/client-profile.js` 硬编码 frozen profiles；`ALLOW_DCR_FOR_CHATGPT=1` 是窄开关；Claude callback 需改代码；「一 owner 多平台 ≠ 多租户」。
- `[文档]` `FRAMEWORK.md` §5 SOP 要求每客户端 7 步 / 每上游 8 步（接入、授权 owner、allow/deny、权威任务集、离线评测、canonical/写路径、限流失败、首次引导）；本目录文档覆盖了调研与设计，但**缺「复制即跑」的 onboarding 模板与首次使用引导 checklist**（`06-oss.md` §4.2 同结论）。
- `[文档]` 上游 onboarding 相关：`docs/UPSTREAMS.md` 在导出 allowlist，但本目录无专门的上游接入模板文档；`RESIDUAL-RISK-AUDIT` §3 的授权 NOT READY 意味着「反复授权已解决」不能写进公开引导（用户强调授权体验第一位，`FRAMEWORK.md` §2 模块四）。

---

## 6. 部署模板审计

- `[文档]` `DEPLOYMENT-TEMPLATES.md`: 四种环境（Local Node / Vercel / Cloudflare Workers / Docker）统一 config shape + 分层 + gap table；只有 Local+Vercel 今天可用；Cloudflare 全链路需适配器（`src/runtime/waitUntil.js`、`store-webcrypto.js`、`store-d1.js`、`worker-app.js`、`sandbox/quickjs-wasm.js`、`local-app.js` 等均需开发）；Docker 的 `--host` 当时记「需开发」。
- `[文档]` `DOCKER.md` + `DOCKER-VERIFICATION.md`: **后续已落地**根 Dockerfile/compose（加入 ALLOWLIST），一次真实验证全 PASS（non-root、0.0.0.0、TCP healthcheck、/mcp 405/200、无 secret 入层）；但 CLI 路径无 `/healthz`、无 OAuth/DCR/KV，不得公开暴露。
- `[文档]` 时间线冲突需并列：`DOCKER-VERIFICATION`（11-23，daemon v29.8.2，PASS）vs `FINAL-HEALTH-AUDIT` §7（daemon 未运行，NOT-RUN）vs `INDEPENDENT-REVIEW` §6（daemon 未运行）。**不能写「当前 Docker 构建通过」**。
- `[文档]` `PLAN` §4 与 `DEPLOYMENT-TEMPLATES` §0 的旧事实（「无 Dockerfile」）已被后续新增 Dockerfile 推翻；文档未同步更新。
- `[文档]` 成本纪律（`FRAMEWORK` §6：默认部署不能有扣费风险）：Vercel/Hobby 配额、Cloudflare Workers CPU 限制已记录，但无「零扣费默认路径」公开承诺与检查项（`06-oss.md` §4.3）。

---

## 7. 治理 / 旧数字 / 旧 commit / 内部引用 / 与六模块和 FRAMEWORK 的关系

### 7.1 治理

- `[文档]` 事实上的治理模式（`EXPORT-MANIFEST.md` + `PLAN.md` §0.1）：**私有仓库为 source of truth + allowlist 快照导出 + 新公开仓 + 单人 release owner**；但 `PLAN` §9 五项决策（项目名、个人 vs org、v0.1 客户端、公开 eval 产物、Cloudflare）与 `FRAMEWORK` §9 第 10 项「开源治理采用什么模式」仍未决——调研 ≠ 选定模式。
- `[文档]` 社区门 G6 未做（`READINESS` §3）；`SECURITY.md`/`CONTRIBUTING.md` 在导出 allowlist，但 CODE_OF_CONDUCT/Issue-PR 模板/响应 SLA 未见完成证据（`06-oss.md` §4.4/§4.5）。

### 7.2 旧数字 / 旧 commit / 旧结论（cross-check 结果）

| 类别 | 内容 | 出现在 | 更新/冲突来源 |
|---|---|---|---|
| token 数字（旧） | `506→3`、`~1,520 tokens`、`-99.4%` | `COMPETITOR-RANKING.md:18,114`、`COMPETITORS.md:146`、`DIFFERENTIATION.md:70,84,110`、`IBM-CONTEXTFORGE-VS-US.md:239,268,330,414`、`PLAN.md:164`、`deep/gemini-bastion.md:148,168` | `FINAL-HEALTH-AUDIT` §1.4/§9 与 `INDEPENDENT-REVIEW` §2：最终实测 **3,564 tokens / -98.5%**（245,377→3,564）；`DIFFERENTIATION.md:70` 被 `06-oss.md` §3.2/§6.1 点名待清。 |
| 生产 commit（被推翻） | `87d91af`（曾说验收 A PASS） | `INDEPENDENT-REVIEW` §1 表格（作为「被证伪的旧结论」记录） | 独立审查：生产实际 `758a232`（healthz commit `758a232b0f5f466835b8e31868284b81484daa73`，`deploymentId=dpl_43d9tWe…`）；AGENTS.md §0（本次会话时点）记生产 `d1f36ba`。**三者是不同时点的记录，并列保留，不推断当前值**。 |
| release 产品 commit / 文件数（多版本并存） | `f710346`/263、`36f677b`+`f5688d5`/287、`db10c639…`/297、`3260414`/301 | `PUBLIC-SAFETY-AUDIT` §0、`RELEASE-LOCAL` §1/顶部、`RELEASE-DRYRUN` §8、`FINAL-HEALTH-AUDIT` §6、`06-oss.md` §2.3 | 按各文档**顶部最新说明**解读；`06-oss.md` §2.3 记当前 301 files / HEAD `3260414` / 0 remote / 0 tag。 |
| 测试数（多版本并存） | 678/669/9（`EXPORT-VERIFICATION`）、761/684/0/77 skip（`EXPORT-TEST-CURATION`）、1098/996/0/96 skip（`RELEASE-DRYRUN` §7）、1352/1229/0/117 skip（`FINAL-HEALTH-AUDIT` §6）、1381/1375/0/6（`INDEPENDENT-REVIEW`）、1406/1400/0/6（`AGENTS.md` §0 lead 基线） | 各文档各自时点 | 均为 `[测试]` 历史记录值；**以 lead 最近一次全量结果为准**，不跨构建硬比。 |
| 旧事实（已被后续代码推翻） | 「无 Dockerfile / docker-compose」（`DEPLOYMENT-TEMPLATES` §0）、Docker `--host` 需开发（同文档 §5） | `DEPLOYMENT-TEMPLATES.md` | `DOCKER.md`/`DOCKER-VERIFICATION.md`/`EXPORT-MANIFEST` 已含真实 Dockerfile 与 `--host` 生效证据。 |
| 旧安全结论（被后续推翻） | F-08/F-09/R-01/R-02 未修（`RESIDUAL-RISK-AUDIT`） | `RESIDUAL-RISK-AUDIT.md` | `INDEPENDENT-REVIEW` §2 称已在代码与测试落地；Vercel CIMD 结论在 `RESIDUAL-RISK-AUDIT` 为 BLOCKED、`INDEPENDENT-REVIEW` 为 UNKNOWN——**并列，不裁决**。 |

### 7.3 内部引用（公开前必须处理）

- `[文档]` `docs/ledger/batch-15-*` / `docs/HANDOFF*` / `docs/PLAN-2026-11-23.md` / `explore/` / `work/` / R2 bucket 名等出现在 `PUBLIC-SAFETY-AUDIT` F-06 与 `EXPORT-VERIFICATION` L39-41 的 DENIED 输出中——这些是**有意记录私有过程**，若整文件进入公开导出会暴露内部资产名。
- `[文档]` `WEB-CLIENTS.md:69` 链接 `../PLAN-2026-11-23.md`（被导出排除）→ 公开后为死链（`PUBLIC-SAFETY-AUDIT` F-08）。
- `[文档]` `PLAN.md:45`、`docs/OPEN-SOURCE/README.md:8` 的字面 `\n` 渲染 bug（`PUBLIC-SAFETY-AUDIT` F-08）。
- `[文档]` `EXPORT-MANIFEST.md:72` 明确把 `docs/OPEN-SOURCE/READINESS.md` 列为导出排除（内部审计），但**其余 28 个 OPEN-SOURCE 文件属于 curated 公开候选**，因此本报告中标注的 handle/路径问题集中在这些候选文件上。

### 7.4 与六模块 / FRAMEWORK 的关系（`[文档]`，基准 `docs/FRAMEWORK.md`）

| FRAMEWORK 口径 | 本目录文档的对应 | 判定 |
|---|---|---|
| 模块六「开源依赖前五层」；§8 决策 8「不提前公开半成品」 | `PLAN` §0.1 新仓导出；`READINESS` 首发 L1；本地产物 0 remote/0 tag | **一致**：未公开、只有本地产物。 |
| 模块一核心底座（可替换，3 工具稳定） | `DIFFERENTIATION`/`COMPETITOR-RANKING`/deep 全部以 3 工具 + QuickJS + 读写分层为轴 | **一致**；`REUSE-RESEARCH` 建议复用 `@cloudflare/codemode` 纯函数、不替换执行器。 |
| 模块二客户端（网页非代码模式，逐平台实测） | `WEB-CLIENTS`/`CLIENT-PROFILES`/`PLAN` §3 | **一致**：Gemini 实测、Claude target、ChatGPT documented-not-promised；但模板 DESIGN ONLY。 |
| 模块三评测（主动/被动隔离、采集交叉） | `DIFFERENTIATION` §1/§3「moat is the loop」；deep 报告普遍指出竞品「有日志无任务级 eval」 | **方向一致**；本目录未细化主动/被动分账（该细节在 `docs/eval/`，不在本次范围）。 |
| 模块四上游（授权第一位，固定 SOP） | `RESIDUAL-RISK-AUDIT` §3、`INDEPENDENT-REVIEW` R2、`REUSE-RESEARCH` | **实践有落差**：授权 NOT READY，owner 标记未完全落地，公开 onboarding 不能承诺。 |
| 模块五运行时/部署（Vercel/本地/容器/Cloudflare，无扣费风险） | `DEPLOYMENT-TEMPLATES`/`DOCKER*`/`PLAN` §4 | **一致**：Vercel+Local 可用、Docker 已验证但最近 NOT-RUN、Cloudflare design-only、成本护栏未成公开承诺。 |
| §12 第 10 条「开源治理」、§9 未决 10 | `REUSE-RESEARCH`/`COMPETITORS`/`deep/*`/`PLAN` §9 | **调研充分，模式未决**。 |
| §13.7「暂不做 canary/shadow/复杂发布工程」 | 本目录发布工程停留在 allowlist 导出 + 门禁清单 | **一致**：无 canary/shadow。 |

---

## 8. 结论（给 lead）

1. **覆盖完成**：expected 29 / read 29 / unread 0；逐文件完整阅读，无标题式/grep 式替代。
2. **成熟度**：按 `READINESS` L0–L3，当前 L0 接近但存在越界宣称与个人 residue，L1 未过（真实客户端/写/授权/当前 Docker 全缺证据），L2/L3 远未到。**本地测试绿、导出 `--check` PASS、SKIP、NOT-RUN、BLOCKED 均不构成「可公开」**。
3. **安全/身份/许可证**：P0 handle 泄漏与检测器假阴性有历史修复记录，但本次读取的候选公开文档仍含字面个人 handle（COMPETITORS、4 份 deep 报告）、真实私有路径、真实远端 URL；MIT LICENSE owner 占位；依赖树许可证产物缺失；AUTH NOT READY。
4. **模板**：客户端 profile 是 DESIGN ONLY；上游 onboarding 未成可运行模板；部署模板只有 Local/Vercel 真可用，Docker 有时间线冲突，Cloudflare 全需开发。
5. **治理与一致性**：调研深、模式未决；旧 token 数字（1,520/-99.4%）、旧生产 commit（87d91af/758a232/d1f36ba 分属不同时点）、多版 release 文件数与测试数并存——公开前必须按各文档顶部最新说明对账，且不能跨构建硬比。
6. **本次审计边界**：只读；只新增本报告；**未改 src/scripts/tests/README/其他 docs/workflows；未 commit/push/tag/deploy**。
