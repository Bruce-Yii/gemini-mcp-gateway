# 架构审计 06 — 开源工程（只读深读）

> 审计日期：2026-11-24（Asia/Singapore）。**只读审计；本报告是本次唯一写入文件。**
> 未修改 `src/`、`scripts/`、`tests/`、README、其他 docs、workflows；未 commit / push / tag / deploy。
> 所有结论来自本地文件与本地只读检查；外部调研一律按 `docs/OPEN-SOURCE/REUSE-RESEARCH.md` 的 URL  attributed 记录，不作新事实声明。
> 约定：`PASS(本地)` ≠ `公开可用`；`SKIP` / `NOT-RUN` / `BLOCKED` ≠ `PASS`，与 `docs/OPEN-SOURCE/FINAL-HEALTH-AUDIT.md` 口径一致。

---

## 0. 执行摘要（给 lead 的一页结论）

1. **用户口径校验通过**：开源是第六层、依赖前五层；发布前问题可后置；优秀项目治理可提前调研。来源为 `docs/FRAMEWORK.md` §0 用户原文逐字记录、§2 模块六、§7、§8 决策 8、§12 第 12 条纠正。
2. **当前实现清单**（详见 §2）：已有 allowlist 导出器 + 规范化器 + 检测器 + 12 项 neutralization 回归 + 本地 release repo（301 tracked files，`3260414`，0 remote / 0 tag）+ 一批策略文档。这是**产出管线与本地产物**，不是“已发布”。
3. **成熟度判定：L0 接近但未过，L1 未过，L2/L3 远未到**（READINESS §1 分级）。本地 repo 的 `npm test` 0 fail / `export-oss --check` PASS 都属于 **本地门**；117 个 reason-bearing SKIP、Figma 覆盖审计 SKIP、Docker 与 npm audit 的 NOT-RUN、真实端到端未验收，均不能当公开可用证据。
4. **缺口是结构性的**（§4）：可复现干净 clone、客户端/上游接入模板的可运行化、Docker 与 Node 矩阵、身份/许可证一致性、安全披露与贡献流程、版本/兼容策略、治理模式，均尚未形成“陌生人可自助”的闭环。治理调研已做得较深（REUSE-RESEARCH / COMPETITORS / DIFFERENTIATION / deep/），但**调研 ≠ 治理模式已选**。
5. **渐进式延伸**（§5）不是泛泛 checklist，而是按“模块 → 交付物 → 验收命令”给出应补的模板/流程，且严格排在“前五层成熟”之后；治理调研和发布前文档一致性属于可提前做的部分。
6. **优先级/依赖/unknown** 见 §6；无新代码、无新依赖、无 commit。

---

## 1. 用户原话校验（最高意图来源：`docs/FRAMEWORK.md`）

### 1.1 逐字引用与判定

| 要求 | 用户原文（FRAMEWORK §0，逐字） | 整理落点 | 本次审计判定 |
|---|---|---|---|
| 开源是第六层、依赖前五层 | “第六开源工程，其实依赖于前五层做的足够完整。” | §2 模块六；§3.3 交叉表“开源 × 全部 → 依赖前五层成熟度”；§8 决策 8“开源依赖前五层，不提前公开半成品” | **一致**。当前未公开、只有本地产物，符合该约束。 |
| 发布前问题可后置 | “然后剩下的工作可能就是发布前的一些问题，这类问题都比较简单，都有很多成熟的参照无需担心，优先级也可以排后” | §7“优先级可后置，但依赖前五层”；§9 未决问题 10“开源治理采用什么模式” | **一致，但被实务修正**：READINESS/PUBLIC-SAFETY-AUDIT 证明“发布前问题”里有 P0 泄漏与假阴性门禁，不能简单视为“简单、无需担心”；优先级可后置 ≠ 门槛可降。 |
| 治理可提前调研 | “但可以提前调研优秀项目的开源治理” | §7 列“开源治理调研”；`docs/OPEN-SOURCE/REUSE-RESEARCH.md`、`COMPETITORS.md`、`DIFFERENTIATION.md`、`deep/*`、`COMPETITOR-RANKING.md` | **已执行且质量较高**，但调研聚焦“竞品与可复用技术”，治理本身（许可证族、安全披露 SLA、贡献者阶梯、兼容性承诺、版本策略、行为准则执法）尚未形成“选定模式 + 落地文件”。 |
| 客户端接入属于开源工程 | “关于客户端接入同时也属于开源工程的一部分，这个客户端接入跟免不免费无关” | §2 模块二；PLAN W-OSS-3；`docs/OPEN-SOURCE/WEB-CLIENTS.md`、`CLIENT-PROFILES.md` | 一致；但 `CLIENT-PROFILES.md` 明示 **DESIGN ONLY**，模板不可运行，见 §4.2。 |
| 上游接入属于开源工程 | “另外可能还有根据不同上游的接入方法，这个也属于开源工程一部分，用户首次使用我们项目的时候，这些引导性的问题，我们都应该做好流程” | §2 模块四；§5 上游 SOP；`docs/UPSTREAMS.md`（在 ALLOWLIST） | 一致；引导/首次使用流程尚未形成可复用 onboarding，见 §4.2。 |
| 运行时/部署与开源交叉 | “这些既属于运行时也属于开源工程” | §2 模块五；PLAN §4 部署矩阵；`DEPLOYMENT-TEMPLATES.md`、`DOCKER.md`、`DOCKER-VERIFICATION.md` | 一致；Docker 文档存在，但最近 FINAL-HEALTH-AUDIT §7 记 NOT-RUN（daemon 未运行），见 §3.3。 |
| 六模块非孤立、上层交叉 | “其实并不是互相孤立，很多都是交叉关系……怎么做隔离？哪些东西又是底层复用？” | §3 分层与交叉；§12 补充 12 项（含开源治理、协议/版本兼容） | 一致；本审计按“层六依赖层一到五”的判据评估，不把开源门当成独立 checklist。 |

### 1.2 用户口径与当前实践的两处张力（需 lead 知悉，不是要求改用户原文）

- **“发布前问题都比较简单” vs. 实际 P0**：`docs/OPEN-SOURCE/PUBLIC-SAFETY-AUDIT.md` F-01/F-02 是 publication blocker（个人 handle 的转义逃逸 63 处 / 11 文件；检测器自身正则假阴性），`RELEASE-LOCAL.md` 记录修复后重新导出。结论：**发布前问题可后置，但必须清零**；不能因“简单”而在未清零时公开。
- **“治理可提前调研” vs. “不能提前公开半成品”**：FRAMEWORK §8 决策 8 明确“不提前公开半成品”。调研文件写在私有仓库里、属于准备，不违反；若把调研产物直接当公开承诺（例如 README 的兼容性声明）则违反。

---

## 2. 当前实现清单（文件 / 命令 / 状态，逐项有证据）

### 2.1 导出管线：allowlist + denylist + 规范化 + 检测

| 组件 | 文件 | 关键实现（带行号） | 命令 | 状态 |
|---|---|---|---|---|
| 导出器 | `scripts/export-oss.mjs` | ALLOWLIST `52-91`（根文件 + `api/src/tests/scripts/harness/bench/examples/templates` + 指定 docs + 仅 `.github/workflows/ci.yml`）；DENYLIST `98-133`（`AGENTS.md`、`docs/ledger`、`explore/data/work/capture/.vercel`、真实本地配置、capture 文件、owner-only workflows）；`buildPlan` `368-404`；`validateExport` `425-467`；`validateSelected` `601-626`；CLI `518-595`。**默认 dry-run，从不 git init/commit/push/deploy**（脚本头注释 2-8 行、结束输出 `593`）。 | `node scripts/export-oss.mjs --out <dir>` / `--write` / `--check`；`--check` 必须带 `--out`（`FINAL-HEALTH-AUDIT` §6 注） | 本地实现完整；P0 修复后检测器用 SHA-256 单向摘要（`HANDLE_DIGESTS` `153-156`），`canonicalizeForScan` `167-179` 解码 unicode/hex/URL/HTML/Unicode 连字符，`detectHandleForms` `202-226` 命名编码类别，`hasHandleLeak` `229-231`。 |
| 规范化器 | `scripts/prepare-neutral-source.mjs` | 从 `export-oss.mjs` 复用同一语法（import `31-34`）；`NEUTRAL` `39-48`；`handlePatterns` `70-100` 覆盖字面/unicode/URL(双重)/HTML/拼接/`String.fromCharCode`；`BARE_SEGMENT_PATTERNS` `106-109`；`OTHER_PATTERNS` `112-126` 处理路径、域名、伪 secret；`neutralizeText(...,{self:true})` `133-160` **自擦除签名常量**；`assertClean` `163-168`；`buildNeutralMap` `215-239`；CLI `241-300`。 | `node scripts/prepare-neutral-source.mjs --out <dir> [--source <dir>] [--write|--check]` | 本地实现完整；自擦除解决“检测器源文件本身泄漏 handle”的旧问题（`PUBLIC-SAFETY-AUDIT` F-01/F-02）。注意文件头 `21-23` 明示它必须在私有源里识别真实片段，**这是有意的私有工具**。 |
| 回归测试 | `tests/oss-neutralizer.test.js` + fixtures | `RELEASE-LOCAL.md` §4 记录 12 项：字面/转义/URL/拼接/大小写、clean-content 不误报、neutralizer 输出、`--check` 退出码；F-09 修复后另有 `tests/oss-private-fixture-skip.test.js`（`PUBLIC-SAFETY-AUDIT` §5 表 F-09）。 | `npm test`（私有 + 两份导出树） | 私有基线由 lead 统一口径（`AGENTS.md` §0：`1406 tests / 1400 pass / 0 fail / 6 todo`，2026-11-24）；**本审计未跑全量测试**，引用既有记录。 |

> 已验证的过程事实：`docs/OPEN-SOURCE/EXPORT-VERIFICATION.md` §1 记录直接从活仓库导出会 **REFUSED**（14510 denylist 命中，`AGENTS.md`/`work/`/`explore/` 必然存在），因此实际流程必须是“先 stage 中性源 → 再 export（`--source`）”。这是**架构性过程约束**，应写入 SOP（§6），否则新人会误以为导出器坏了。

### 2.2 身份 / 元数据 / 许可证

| 项 | 私有源 | 本地 release repo | 状态 |
|---|---|---|---|
| `package.json` | `name: codemode-mcp-gateway`、`author: example-org`、URL 全为 `example-org/codemode-mcp-gateway`（`package.json:2-16`）；`version 0.1.0`、`license MIT`、`engines.node >=20.19.0`、依赖 5 个（`:43-53`） | 同（逐字一致） | `PUBLIC-SAFETY-AUDIT` §5 F-07 标 FIXED(in package.json)；**owner 真实名字仍是 `example-org` 占位**，需发布 owner 决定（`RELEASE-LOCAL` §4 第 1 条 / §5）。 |
| `package-lock.json` | 存在 | 存在（301 files 内） | `RELEASE-LOCAL` §4.1 仍列“root `name` 字段待同步”为 owner 后续项；本次未逐行复核 lock，记为 **unknown/待确认**。 |
| `LICENSE` | MIT | `work/oss-release-repo/LICENSE`：`Copyright (c) 2026 example-org` | 许可类型明确；`RELEASE-LOCAL` §4 第 2 条“确认 owner/year”未勾。 |
| README | 私有 `README.md:1` 标题仍 `# gemini-mcp-gateway`；badge/clone URL 已指 `example-org/codemode-mcp-gateway`（`:3-5`）；数字已更新为 3,564 tokens / -98.5%（`:7-11, 74`）；客户端矩阵诚实（`:87-95`）；非目标明确（`:113-120`） | 导出树 README 同族 | `FINAL-HEALTH-AUDIT` §9：README 数字“已修”（独立审查 `INDEPENDENT-REVIEW` §2 确认与实测一致）；但 `PLAN.md:45` 字面含 `\n` 渲染 bug、`docs/OPEN-SOURCE/README.md:8` 也有 `\n`，`PUBLIC-SAFETY-AUDIT` F-08 曾记录——发布前仍需全链复核。 |
| `README.zh-CN.md` | 存在并随导出 | 存在 | 与英文版需同步校对 clone URL / token 口径，见 `FINAL-HEALTH-AUDIT` §9。 |

### 2.3 本地 release repo（只读核验结果）

```
git -C work/oss-release-repo status --short   → (空，clean)
git -C work/oss-release-repo log --oneline -5 → 3260414 chore(oss): initial public release snapshot
git -C work/oss-release-repo remote -v        → (空，0 remote)
git -C work/oss-release-repo tag -l           → (空，0 tag)
git -C work/oss-release-repo ls-files | count → 301
```

- 与 `FINAL-HEALTH-AUDIT` §6 记录一致：HEAD `3260414`、无 remote/tag。**没有公开仓库、没有 push**（`AGENTS.md` §0 同样声明）。
- 历史版本记录在 `RELEASE-LOCAL.md` 顶部：263 → 287 → 297 → 301 文件多次重导出；当前顶部称“剩余纯人工动作：确认真实 owner/repo、写 release notes、建首个 tag”。历史段落并存（297 文件“2 open problems”等），必须按顶部最新说明解读（`FINAL-HEALTH-AUDIT` §9 同结论）。
- 首次 tag 建议 `v0.1.0` 或 `v0.1.0-alpha.1`，**未创建本地**；本报告也不创建。

### 2.4 文档矩阵（治理调研已成的部分）

| 文档 | 作用 | 关键事实 |
|---|---|---|
| `docs/OPEN-SOURCE/PLAN.md` | 发布计划、W-OSS-1…6、release gate §7、open decisions §9 | 定位“Code Mode MCP gateway for web AI clients”；建议名 `codemode-mcp-gateway`；v0.1 客户端 Gemini tested / Claude target / ChatGPT documented-not-promised；部署 Local+Docker+Vercel，Cloudflare design-only；**§9 五个 lead 未决项**。 |
| `docs/OPEN-SOURCE/EXPORT-MANIFEST.md` | 新仓库交付模型（私有源 = source of truth） | Include/Exclude 清单；导出树必须先过 `npm ci && npm test` + truncation audit + config validation；fresh git history。 |
| `docs/OPEN-SOURCE/DEPLOYMENT-TEMPLATES.md` | 四种环境 + 配置分层 + gap list | §0 明确“**只有 Vercel 和 local Node 今天能跑**”；Cloudflare/Docker OAuth+KV 均 `需开发`；该文档本身含真实私有路径（`§1.2` 的 vault 默认），**不是公开文档**，需中性化后才可导出。 |
| `docs/OPEN-SOURCE/WEB-CLIENTS.md`、`CLIENT-PROFILES.md` | 客户端调研 / 配置档案设计 | `CLIENT-PROFILES.md` 顶部明示 **DESIGN ONLY**，运行时只读 `src/client-profile.js` 的三个 frozen profile；JSON 模板改了不生效。 |
| `docs/OPEN-SOURCE/REUSE-RESEARCH.md` | 深调研：typed plan / 编排 / 客户端适配 / 许可证 | 15+ 项目、来源 URL、`REUSE-RESEARCH` §5 许可证分级；`forgemax` = FSL-1.1-ALv2 **不能复制**；`@cloudflare/codemode` MIT 且已在依赖树；MCP Groups SEP-2084 已被拒绝、不采纳。 |
| `docs/OPEN-SOURCE/COMPETITORS.md` / `DIFFERENTIATION.md` / `COMPETITOR-RANKING.md` / `deep/*` / `IBM-CONTEXTFORGE-VS-US.md` | 竞品与差异化 | 结论：不与“聚合网关”竞争；差异化 = 3 工具 + 读写分离 + QuickJS 隔离 + full-fidelity capture/eval。**注意 `DIFFERENTIATION.md:70` 仍写 `~1,520 tokens / -99.4%`，与 README/实测 `3,564 / -98.5%` 冲突**，是待清的文档一致性项。 |
| `docs/OPEN-SOURCE/READINESS.md` | 四级成熟度 + G0–G6 门禁 + 当前对照 | 首发目标 L1；当前 G0/G1/G5 部分、G2/G3/G4 未过、G6 未做；“不能公开发布”。 |
| `docs/OPEN-SOURCE/PUBLIC-SAFETY-AUDIT.md` | 独立公开安全审计（历史快照 + fix status） | F-01/F-02 P0；F-03…F-11；§5 记录 in-scope 修复与 out-of-scope 开放项。 |
| `docs/OPEN-SOURCE/RESIDUAL-RISK-AUDIT.md` | 安全复核 + auth readiness | R-01（server.js 直接工具错误路径脱敏）、R-02（v2 预算）、F-08/F-09（截断语义）等；`INDEPENDENT-REVIEW` §2 确认 R-01/F-08/F-09/R-02 已在代码与测试落地。 |
| `docs/OPEN-SOURCE/FINAL-HEALTH-AUDIT.md` | 发布前全面健康检查 | §1–§6 本地绿；§7 Docker NOT-RUN、§8 npm audit NOT-RUN、§9 文档一致性 FAIL；§10 明确“代码绿 vs 线上未部署/未授权”。 |
| `docs/OPEN-SOURCE/INDEPENDENT-REVIEW-2026-11-24.md` | 接手窗口独立审查 | 推翻若干旧结论：V0 仍 0/7；A PARTIAL；生产 `758a232`；push 即上线；V0 证据链仍叙述化。 |

---

## 3. 成熟度 L0–L3 与“本地通过 ≠ 公开可用”

### 3.1 判定表（READINESS §1 分级）

| 等级 | 名称 | 要求摘要 | 当前判定 | 依据 |
|---|---|---|---|---|
| **L0** | source-available alpha | LICENSE、README、CI、基本测试；**不能宣称可自托管/支持某客户端** | **接近，未确认过线** | 有 MIT LICENSE、README、离线 CI、本地测试绿；但 G0 身份未统一（真实 owner 占位）、G1 干净 clone 未重跑（117 SKIP）、`export-oss --check` 只覆盖探测器已知形态；且公开 README 已写“Tested with Gemini web”“可自托管”类声明——**若此刻公开，会超 L0 宣称**。 |
| **L1** | usable alpha | 一条真实客户端端到端；真实读/写/授权至少一条路径验证；Docker/安装可复现 | **未过** | `READINESS` §3 G2 未过、G5 部分；`FINAL-HEALTH-AUDIT` §7 Docker NOT-RUN、§6 OSS 117 SKIP；`INDEPENDENT-REVIEW` §4 B/C/D 门 FAIL；真实写回环/授权/KV 证据缺失。 |
| **L2** | maintainable beta | 多客户端/多上游、稳定 API、贡献流程、安全策略、版本/发布 | **未过** | CONTRIBUTING/SECURITY 文件存在（§2.5），但“多客户端”只到 documented/target；无版本/兼容策略、无 tag/release notes、无 G6 社区实操。 |
| **L3** | production-ready | SLO、迁移/回滚、安全响应、依赖治理、长期维护承诺 | **未过** | `SECURITY.md` 自述 “not audited / no backport”；`FINAL-HEALTH-AUDIT` §8 npm audit 无结论；回滚演练未做（`RESIDUAL-RISK-AUDIT` §1.8-1 FAIL）。 |

### 3.2 “本地通过”清单——**不得**当公开可用

| 命令 / 项 | 最近记录结果 | 性质 | 不能推出什么 |
|---|---|---|---|
| 私有 `npm test` | `1406/1400/0 fail/6 todo`（`AGENTS.md` §0 lead 基线）；独立审查曾 `1381/1375/0/6` | **本地代码绿** | 不能推出线上已部署、真实客户端通过、AUTH READY。 |
| `audit-truncation --ci` | P0=0（P1=28/P2=240+ 告警不 fail） | **本地静态绿** | P1 噪声未清，未来真实静默截断易被淹没（`FINAL-HEALTH-AUDIT` §1.2 风险）。 |
| OSS staging/repo `npm test` | `1352 / 1229 pass / 0 fail / 117 skipped / 6 todo`（`FINAL-HEALTH-AUDIT` §6） | **本地导出树绿** | SKIP 是 reason-bearing 私有 fixture 排除，**不是覆盖通过**；Figma 任务覆盖审计 SKIP。 |
| `export-oss --check` | checked 300 text files, CHECK PASSED（同上） | **本地探测器绿** | 只覆盖探测器已知形态；`PUBLIC-SAFETY-AUDIT` 曾证明假阴性历史；数字 ID/嵌套形态不在检测范围。 |
| `local-e2e-verify` / `mcp-v2-smoke` / L1 fake 50/50 / replay `--fixture` / `auth-e2e-harness` | 全绿（`FINAL-HEALTH-AUDIT` §2–§5） | **fake / 离线 fixture** | 不是真实上游 401、真实客户端、真实写回环。 |
| `measure-context` | 3,564 tokens / -98.5%（`FINAL-HEALTH-AUDIT` §1.4；独立审查确认） | **本地测量** | 文档仍有旧数字（`DIFFERENTIATION.md:70`），公开前须统一。 |
| `npm audit --omit=dev` | `404 NOT_IMPLEMENTED`（npmmirror registry） | **NOT-RUN** | 不是 “0 vulnerabilities”；必须换 registry 重跑或人工 CVE。 |
| `docker build/run + /healthz + /mcp` | `DOCKER-VERIFICATION.md` 记录过一次成功（daemon 29.8.2，`BUILD_EXIT=0`）；但 `FINAL-HEALTH-AUDIT` §7 与 `INDEPENDENT-REVIEW` §6 记 daemon 未运行、NOT-RUN | **历史 PASS + 最近 NOT-RUN** | 不能写“当前 Docker 构建通过”；需发布 owner 在干净 clone 补跑。 |
| OSS `git status / remote / tag` | clean / 0 / 0，HEAD `3260414` | **本地产物事实** | 不能写“已发布 / 已推送 / 已有 release”。 |

### 3.3 发布状态阻塞（非代码阻塞，但阻断公开）

- 生产最新 commit 与验收证据在独立审查中被推翻（`INDEPENDENT-REVIEW` §1/§4），A 门 PARTIAL、B/C/D/E/G FAIL，**没有可外宣的真实端到端证据**。
- `AUTH-READY.md` = NOT READY（`RESIDUAL-RISK-AUDIT` §3：8 FAIL + 3 UNKNOWN）；不可发起授权。
- 文档一致性 FAIL（`FINAL-HEALTH-AUDIT` §9）：HANDOFF 顶部 660/660、EVALUATION §6 陈旧、`DIFFERENTIATION.md` 旧 token 数字。
- 未公开仓库、未 push、未 tag（本报告同样未做）。

---

## 4. 缺口清单（只列证据支撑的缺口，不臆造）

### 4.1 G0–G1：clean clone 可复现

- **缺口**：没有“陌生人 clone → `npm ci` → 全门禁绿”的**当前**证据。`RELEASE-LOCAL` §5 与 `EXPORT-MANIFEST` §Validation gate 都要求，但最近记录在导出树里是 117 SKIP + Figma 覆盖 SKIP（`FINAL-HEALTH-AUDIT` §6.3）。
- **具体未知**：`package-lock.json` root `name` 是否同步（RELEASE-LOCAL §4.1 待办）；Node 20/22/24 矩阵从未跑（RELEASE-LOCAL §5 “Verify … Node 20/22/24”未勾）；从活仓库直接导出必然 REFUSED（EXPORT-VERIFICATION §1），需要把“先 neutral-source → 再 export → 再 clean-clone gate”固化为 SOP。
- **为什么是结构缺口**：READINESS G1 是 L0/L1 的硬门；现在只是“本地导出树绿”，不等于“干净环境可复现”。

### 4.2 客户端 / 上游接入模板：文档与可运行之间断层

- **客户端**：`CLIENT-PROFILES.md` 明示 DESIGN ONLY；三份 JSON 模板运行时不读取（`src/client-profile.js` 硬编码 frozen profiles）。`PLAN` W-OSS-3 把“Claude adapter”列为 P1 且尚未验收；README 只能写 Claude = target / ChatGPT = documented-not-promised。
- **上游**：`docs/UPSTREAMS.md` 在 ALLOWLIST，但“首次使用引导流程”仍是散文；`DEPLOYMENT-TEMPLATES.md` §1.2 的 vault 默认含真实私有路径，说明**模板文档尚未中性化到可公开**。
- **授权体验（用户强调第一位）**：owner/refresh 未落地（`INDEPENDENT-REVIEW` R2），Vercel CIMD 真实授权 BLOCKED/UNKNOWN（`RESIDUAL-RISK-AUDIT` §3.3 与 `INDEPENDENT-REVIEW` §1 结论冲突），无法把“反复授权问题已解决”写进公开引导。
- **缺口本质**：模块二/四的 SOP 已有骨架（FRAMEWORK §5），但缺 **可复制即跑的模板 + 首次引导 checklist + 每个上游/客户端的验证命令**，即“开源工程”层还没把前五层的能力包装成他人可用资产。

### 4.3 Docker / 部署载体

- **存在**：根 `Dockerfile` / `docker-compose.yml` 已加入 ALLOWLIST（`export-oss.mjs:67-68`）；`DOCKER-VERIFICATION.md` 记录过一次 build/inspect/history 全绿、`--host 0.0.0.0`、healthcheck TCP 检查。
- **缺口**：最近两次健康检查记 daemon 未运行 → NOT-RUN；`PLAN` W-OSS-2 验收项“`docker compose up` 暴露 `/healthz` + `/mcp`、容器可从宿主浏览器访问”**没有当前证据**；Node 20/22/24 矩阵同样缺。
- **文档冲突**：`DOCKER-VERIFICATION.md` 说 Docker healthcheck 可用，旧 README 曾说 “`/healthz` 只在 Vercel entry”（`PUBLIC-SAFETY-AUDIT` F-10）——必须统一为一种真话再公开。
- **成本原则**：用户要求“按项目方式部署不能有扣费风险”。Vercel/Hobby 配额、Cloudflare Workers CPU 限制（`DEPLOYMENT-TEMPLATES` §4）已记录，但**没有把“零扣费默认路径”写成公开承诺与检查项**。

### 4.4 许可证 / 身份 / 安全披露

- **许可证类型**：MIT 明确；但 `LICENSE` 的 owner/year 仍占位 `example-org`（`RELEASE-LOCAL` §4.2 待确认）。
- **第三方许可证审计**：`REUSE-RESEARCH` §5 对 15+ 项目做了分级（MIT/Apache 可依赖、FSL 不可复制、TS SDK 许可过渡需按文件审计），但**对本仓库实际 5 个直接依赖的传递依赖许可证清单 + NOTICE 文件**没有独立产物；`READINESS` G0 “第三方依赖许可证审计”未勾。
- **安全披露**：`work/oss-release-repo/SECURITY.md` 已具备“不要公开 issue、GitHub private reporting、triage best-effort、威胁模型”，是**文件级完成**；但“问题分级与响应预期”仍是 best-effort 无 SLA，`READINESS` G6 要求“问题分级与响应预期”——文件存在 ≠ 流程运转。
- **身份一致性**：`example-org` 是占位；真实 owner/repo 决定前，badge/clone URL、LICENSE、Docker image tag、README（双语）都要同步（RELEASE-LOCAL §4.1、§5）。

### 4.5 贡献流程与社区

- **已有**：`CONTRIBUTING.md`（README 布局、规则六条、PR/commit 约定）、`SECURITY.md`、`ALLOWLIST` 含 `CONTRIBUTING.md`/`SECURITY.md`/`CODE_OF_CONDUCT.md`（`export-oss.mjs:60-62`）。
- **缺口**：`CODE_OF_CONDUCT.md` 在 ALLOWLIST/PLAN 里，但 `work/oss-release-repo` 顶层文件清单中**未见**（§2.3 glob 结果与 ALLOWLIST 对照）；`PLAN` W-OSS-4 明确“Add CODE_OF_CONDUCT.md”。贡献流程文件存在但未验证：Issue/PR 模板、行为准则落地、支持范围/路线图、问题分级与响应预期（`READINESS` G6 六项）。`CONTRIBUTING.md:30` 仍列 `explore/` 为仓库布局——该目录被导出排除，是 F-06 类“公开文档描述不存在路径”的残留。

### 4.6 版本 / 兼容策略

- **缺口**：无 tag、无 release notes（`RELEASE-LOCAL` §4.2/§5）；`SECURITY.md` 自述“无 backport policy”；无 MCP 版本 / 客户端能力 / 工具面版本矩阵。
- **已有素材**：`FRAMEWORK` §12 第 10 条把“协议/版本兼容（MCP 版本、客户端能力、工具面版本 /mcp/v2）”列为横切；§4/§5 工具契约（v1 不变、v2 flag 关闭、Gemini 不消费 list_changed）；`CONTRIBUTING.md:34-37` 写明 3 工具稳定是 breaking-change 边界。这些是**策略素材**，尚未整理成公开的 `VERSIONING.md` / compat policy。
- **必要内容**：v0.1 alpha 声明“API 可能变”、semver 规则、v1↔v2 迁移与 flag、每个客户端的“tested/target/documented”分层（README 已有雏形）、依赖升级策略（REUSE-RESEARCH 的 Experimental 包 pin 0.5.6 需要写明）。

### 4.7 治理模式（用户允许提前调研，但尚未选定）

- **调研完成**：`REUSE-RESEARCH`（可复用与许可证）、`COMPETITORS`/`DIFFERENTIATION`/`deep/*`（竞品与定位）、`EXPORT-MANIFEST`/`PLAN`（交付模型）。
- **未决**：`PLAN` §9 五个 open decisions（项目名、个人 vs org、v0.1 客户端集合、公开 eval 产物、Cloudflare），`FRAMEWORK` §9 第 10 项“开源治理采用什么模式”。即：**单人维护 + 私有源为真源 + 定期快照导出** 的治理模式虽在 `EXPORT-MANIFEST` 事实上采用，但未被明确定义为“治理模式”（角色、决策权、发布节奏、issue triage、安全响应、贡献者晋升、归档策略）。
- **不应做**：把 FSL 项目代码复制进仓库（REUSE-RESEARCH §0 第 6 条 / §5）；把 Experimental 上游当稳定承诺；把竞品 benchmark 当自己的结论（REUSE-RESEARCH §2.5 标注 vendor-published、未复现）。

---

## 5. 渐进式延伸：开源工程应补的模块 / 模板 / 流程

> 原则：不是“再加个 checklist”，而是把 FRAMEWORK 第一至五层的既有能力**包装成他人可复现的交付物**；每一项都写清“模块 → 交付物 → 验收命令 → 依赖”。

### 5.1 模块 A — 可复现发布管线（对应 W-OSS-1；先于一切公开）

| 项 | 交付物（应新增/补齐） | 验收命令（来自现有文档） | 依赖 |
|---|---|---|---|
| A1 固定导出 SOP | `docs/OPEN-SOURCE/EXPORT-SOP.md`：neutral-source → export → clean-clone gate → 人工建 remote/tag，明确“直接从活仓库导出会 REFUSED” | `node scripts/prepare-neutral-source.mjs --out <stage> --write` → `node scripts/export-oss.mjs --source <stage> --out <out> --write` → `node scripts/export-oss.mjs --out <out> --check` | 无（纯文档） |
| A2 干净 clone 门禁脚本 | `scripts/oss-clean-clone-gate.mjs`（或 CI job）：`npm ci && npm test && audit-truncation --ci && check-config && export-oss --check`，对缺 fixture 强制显式 SKIP 文案 | 与 A1 同 + Node 20/22/24 三矩阵 | 需 lead 授权改 scripts/workflows；本审计不改 |
| A3 探测器覆盖扩展 | 将 `--check` 扩展到数字 ID / 嵌套 JSON / 多形态编码；把 digest 私有化到 denylisted 私有工具（现已在 detector 内用 SHA-256，仍应审计未知形态） | `PUBLIC-SAFETY-AUDIT` §4 checklist + `tests/oss-neutralizer.test.js` 新用例 | 依赖安全 owner 复核 |

### 5.2 模块 B — 客户端与上游 onboarding 模板（对应 W-OSS-3 + 用户“首次使用引导”）

| 项 | 交付物 | 验收 | 依赖 |
|---|---|---|---|
| B1 客户端接入模板 | 每客户端一个 `templates/client-<name>/`：接入 URL、annotations 声明、profile header、已知限制（免费/会员差异）、主动评测任务、被动采集标签 | 按 FRAMEWORK §5 客户端 SOP 7 步逐项打勾；Gemini 已有证据，Claude/Inspector 需真实验证 | 前五层的客户端适配 / 真实客户端评测（B 门） |
| B2 上游接入 SOP 模板 | 每上游一个 `templates/upstream-<name>/`：transport、授权 owner、工具 allow/deny、官方任务集、canonical/写路径、限流/失败、首次引导话术 | 按 FRAMEWORK §5 上游 SOP 8 步；`docs/UPSTREAMS.md` 增“首次使用”章节 | 授权生命周期（模块二 owner 落地、AUTH-READY 转绿） |
| B3 把 DESIGN ONLY 模板转成真配置或删除 | `CLIENT-PROFILES.md` 与 `templates/client-profiles/*.json` 二选一：要么实现 runtime 读取，要么明确标为“社区示例、运行时忽略”（现状已是后者，但需公开前统一口径） | 读 `src/client-profile.js` 确认行为不变 | 不能破坏 3 工具/frozen profile 契约 |

### 5.3 模块 C — 部署与成本模板（对应 W-OSS-2 / W-OSS-6）

| 项 | 交付物 | 验收 | 依赖 |
|---|---|---|---|
| C1 Docker 可复现 | 用根 `Dockerfile`/`docker-compose.yml` 在干净 clone 跑 build/run/healthz/`/mcp`；补一份 `docs/OPEN-SOURCE/DOCKER-RECHECK.md` 记录当前 daemon 下的结果 | `docker compose up` → `/healthz` + `POST /mcp` 可达（`PLAN` W-OSS-2 原文） | Docker daemon 可用；发布 owner |
| C2 载体矩阵与成本护栏 | 把 DEPLOYMENT-TEMPLATES §7 gap table 收敛成 README 一页：Local ✅ / Vercel ✅ / Docker ✅(需 C1 证据) / Cloudflare ❌ design-only；写明“默认无扣费路径” | 与 README 客户端/部署矩阵一致 | npm audit / 依赖结论（F 门） |
| C3 Cloudflare 决策 | 按 W-OSS-6 输出“证明或拒绝 Workers port”的报告，拒绝则公开“Docker behind Tunnel” | 有原型证据或明确拒绝，不写半可用模板 | P2，发布后可做 |

### 5.4 模块 D — 法律 / 安全 / 社区（对应 G0/G4/G6）

| 项 | 交付物 | 验收 | 依赖 |
|---|---|---|---|
| D1 身份冻结 | 决定真实 owner/repo，同步 `package.json`/`package-lock.json`/LICENSE/双语 README badge 与 clone URL/Docker image tag | `RELEASE-LOCAL` §5 checklist 前 3 项 | lead 决策（`PLAN` §9.1/§9.2） |
| D2 第三方许可证清单 | 生成实际依赖树许可证报告 + 必要 NOTICE；把 REUSE-RESEARCH §5 的“FSL 不可复制、TS SDK 过渡需按文件审计”转成仓库规则 | `READINESS` G0 “第三方依赖许可证审计”勾上 | 依赖锁文件稳定 |
| D3 安全披露闭环 | 以 `SECURITY.md` 为起点补：报告渠道可用性验证、分级/响应预期、capture 隐私边界公开说明（full-fidelity 但用户自担存储） | G4/G6 对应项；`READINESS` §4 首发形态“capture 含敏感数据，用户需自担” | GitHub repo 建好（private reporting 才可用） |
| D4 社区文件补齐 | 补 `CODE_OF_CONDUCT.md`（ALLOWLIST 已列但 repo 未见）、Issue/PR 模板、支持范围/路线图；清理 `CONTRIBUTING.md:30` 的 `explore/` 描述 | `PLAN` W-OSS-4、`READINESS` G6 六项 | repo 建好 |
| D5 版本 / 兼容策略 | 新增 `VERSIONING.md`：semver、v1/v2 路径、MCP/客户端版本矩阵、 Experimental 依赖 pin 策略、无 backport 现状 | `FRAMEWORK` §12.10、§4/§5 契约、`SECURITY.md` supported versions | 首个 tag 之前 |

### 5.5 模块 E — 治理模式定义（用户明确允许提前调研）

建议把事实上的模式写成一条明确决策：**“私有仓库为 source of truth + allowlist 快照导出 + 单人 release owner + 公开仓库只接收发布快照；日常开发/评测/ledger 留在私有”**（`EXPORT-MANIFEST` 已实现此模型）。
需补足的治理要素（都不要求立即公开）：角色与决策权（lead = release owner）、发布节奏（无日历日期，按依赖触发）、issue triage 与响应预期、安全事件流程、贡献者晋升/PR 审阅门槛、归档与 breaking change 沟通、`PLAN` §9 五项的决议记录。
> 与用户口径一致：治理**调研可提前**；但**公开动作**仍以 FRAMEWORK §8 决策 8 与前五层成熟为门。

---

## 6. 可复用方法 / SOP、优先级、依赖、unknown

### 6.1 可复用 SOP（从本次深读中抽取，可直接给后续 agent/发布 owner）

1. **导出 SOP**：`prepare-neutral-source --write` → `export-oss --source <neutral> --out <stage> --write` → `export-oss --out <stage> --check` → 在导出树跑 `npm ci && npm test && audit-truncation --ci && check-config` → 再 `git init` + 单一 commit（本地 identity `OSS Release Bot <oss-release@example.com>`）→ **不建 remote、不 push、不 tag**。理由：活仓库直接导出必然 REFUSED（EXPORT-VERIFICATION §1）。
2. **检测器可信度 SOP**：`--check` PASS 只证明“已知形态 0 命中”；公开前必须加一轮**人工/独立**扫描（raw + decoded + 数字 ID + 嵌套），因为历史上有假阴性（PUBLIC-SAFETY-AUDIT F-02）。任何修复都要补确定性回归测试再重导出（AGENTS.md §1 的“模型建议只是假设”同精神）。
3. **成熟度判据 SOP**：引用 READINESS L0–L3 与 G0–G6；把每个证据标注 `PASS(本地)` / `SKIP` / `NOT-RUN` / `BLOCKED`；SKIP 不得写成 PASS；不跨构建硬比（FRAMEWORK §4、AGENTS.md §3）。
4. **文档一致性 SOP**：公开前对账三处已知冲突——HANDOFF 顶部 660/660、EVALUATION §6、`DIFFERENTIATION.md:70` 的 1,520/-99.4%（与 README 3,564/-98.5% 冲突）；以 lead 最近一次实跑为唯一基线（`AGENTS.md` §0）。
5. **安全/隐私 SOP**：capture 保真与模型可见脱敏是同一数据的两种投影；修复只能改模型投影（`RESIDUAL-RISK-AUDIT` §4）；不得把“capture 原样保存”当“可以回显 token”。
6. **审计边界 SOP**：只读审计只写自己声明的报告文件；不碰 src/scripts/tests/README/其他 docs/workflows；不 commit/push/deploy（本次遵守，亦见 `RESIDUAL-RISK-AUDIT`/`FINAL-HEALTH-AUDIT` 前言）。

### 6.2 优先级（依赖排序，不含日历日期）

| 优先级 | 事项 | 前置依赖 | 对应门 |
|---|---|---|---|
| P0 — 公开前必须 | D1 身份冻结（真实 owner/repo）；D2 第三方许可证结论；A3 检测器独立复核；D3 安全披露可用；D5 版本/兼容策略初稿；§6.1 SOP 3 文档对账 | lead 决策 + repo 建立 | G0/G4 |
| P0 — 公开前必须 | A1/A2 干净 clone 门禁（当前 117 SKIP 需显式说明）；C1 Docker 当前复验；换 registry 的 npm audit | 测试/发布 owner；Docker daemon | G1/G5 |
| P1 — L1 门槛（不可跳过） | B1/B2 客户端/上游 onboarding 模板；真实客户端 3 任务 + 真实写回环 + 网关独立授权 | 前五层：A/B/C/D 门转绿（真实客户端/写回环/授权） | G2/G3 |
| P1 — 社区 | D4 CODE_OF_CONDUCT/Issue-PR 模板/支持范围 | repo 建立 | G6 |
| P2 — L2/L3 | E 治理模式正式决议；C3 Cloudflare 决策；重复授权/root-cause；长期维护承诺 | L1 之后 | L2/L3 |

### 6.3 依赖图（简）

```
前五层成熟（真实客户端 / 写回环 / 授权 / Docker / 安全）
        ↓
G1 干净 clone 可复现  ←  A1/A2 导出 SOP  ←  EXPORT-VERIFICATION 过程约束
        ↓
G2/G3 真实 E2E + 文档一致  ←  B1/B2 模板、§6.1 SOP 3
        ↓
L1 usable alpha（首发目标，不是 L3）
        ↓
G6 社区 + E 治理模式  →  L2/L3
```

### 6.4 Unknown（仓库内无法验证，不推断）

1. 真实 GitHub owner/repo 名与发布账号（个人 vs org）——`PLAN` §9 未决。
2. `package-lock.json` root `name` 是否已随 `package.json` 同步——`RELEASE-LOCAL` 列为待办，本次未逐行核。
3. CODE_OF_CONDUCT.md 是否已存在于待导出的私有源（ALLOWLIST 有，但 release repo 顶层未见；需发布 owner 确认）。
4. Node 20/22/24 三矩阵、当前 Docker daemon 下 build/run、可实现的 npm audit endpoint——NOT-RUN。
5. 真实 provider 授权、KV 隔离、Vercel CIMD 是否被 AS 接受——`RESIDUAL-RISK-AUDIT` NOT READY / `INDEPENDENT-REVIEW` 标 UNKNOWN。
6. 公开后 issue/安全报告渠道是否实际有人 triage、响应预期——需 repo 建好才能验证。
7. 117 SKIP 中每一项是否都有可接受的“私有 fixture 排除”理由及外部复现路径——本次未逐项复核。

---

## 7. 结论

- **用户六模块口径在开源这一层得到忠实反映**：层六依赖层一至五、发布前问题后置、治理可提前调研；当前“未公开 + 本地产物 + 深调研”正是该口径的体现。
- **工程实现已有可用骨架**：导出器、规范化器、检测器、本地 release repo、策略文档齐备；P0 泄漏与 CI 假阴性已修复并留证。
- **但达不到公开标准**：L0 宣称越界、L1 未过；本地测试/SKIP/探测器 PASS 都是本地门；真实 E2E、Docker 当前复验、npm audit、身份/版本/社区/治理仍是硬缺口。
- **下一步不是“再写一份 checklist”**，而是按 §5 把前五层能力做成可复现模板与流程，由 lead 决定开放时机。本次审计**没有 commit、push、tag、deploy**，也未修改除本报告外的任何文件。
