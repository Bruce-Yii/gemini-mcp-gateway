# 在线反馈 ↔ 半在线（L1/G6）真正 join（2026-11-23 · Gemini）

> 状态：**评测 join 文档（新增）**。本文件把 `online-feedback-2026-11-23-gemini.md` 的
> F1–F6 与 `SEMI-ONLINE-GAPS.md` 的 N1–N9 / T1–T7 做**逐条 join**，不记流水账。
> 同批只新增 4 个文件（本文、`explore/tasks-online-gap-2.json`、
> `tests/online-semionline-join.test.js`、`docs/ledger/batch-15-online-semionline-join.md`）；
> 不改 `src/`、`scripts/`、其它 tests、README、其它 docs、workflows；不 commit / push / deploy。
>
> **这不是 bug 清单**：每条 F 的回答是「哪条半在线轴能观测它、现在覆盖成色、
> 代码层处于哪一态、缺口属于哪一类」，而不是「去修什么」。

## 0. 输入与证据边界（先读，否则下面所有状态都不能理解）

| 输入 | 作用 |
|---|---|
| `docs/eval/online-feedback-2026-11-23-gemini.md` | 在线侧事实源（`online-feedback.v1`，F1–F6 + 正面三项）。**全部来自生产旧构建**。 |
| `docs/eval/SEMI-ONLINE-GAPS.md`（§1.1 / §2 / §4 / §6） | 半在线缺口抽象、T1–T7 测试类、N1–N9 任务清单、Gemini addendum 映射。 |
| `explore/tasks-online-gap.json`（N1–N9） | 现有半在线任务集（本 join 只引用，不修改）。 |
| `docs/eval/TYPED-PLAN-TEST-PLAN.md`（§1.3 / §2 / §6.3 / §8） | 配对与分账规则来源：同 prompt 配对、新会话、反序、冻结基线、fake/replay/real 分层。 |
| `docs/eval/ONLINE-FEEDBACK.md`（§2） | 锚点规则：时间窗 / taskId / requestId / PR；对不上写 unknown，不猜。 |
| `docs/eval/online-offline-join-2026-11-22.md`（§3.3） | 不可比指标清单（单请求 durationMs ≠ task p95；bytes ≠ tokens）。 |

硬边界（继承 `AGENTS.md` 与上述文档）：

1. **生产旧构建 ≠ 当前 checkout**。F1/F2 的 P0 修复在代码层存在但**未部署**，
   一律 `pending-deploy`；不能写「现网已修好」，也不能写「现网仍失败」。
2. **`requestIds:["unknown"]`、`captureVerified:false`** 适用于 F1–F6 全部条目。
   本文不补造 UUID，不从 prompt 猜 task，不把 PR 号当网关 capture 证据。
3. 在线用户报告与免费模型/归因器输出都是**待验证假设**，不驱动改代码、开 issue、
   合并或部署。本批没有跑真实窗口、没有真实 PR/CI replay、没有网络。
4. 「代码层已修」= 有纯函数 + 确定性测试；**不等于**半在线任务集已覆盖该轴，
   更不等于端到端闭环。

### 0.1 判定所用的四态口径（写死，避免解读漂移）

| 维度 | 枚举 | 含义 |
|---|---|---|
| **当前覆盖状态** | `covered` / `weak` / `missing` | 半在线（L1/G6 任务集 + 定向回归）现在能否**观测**这条轴。`covered`=有任务或定向测试且断言到具体字段/字节；`weak`=只有代理指标或纯函数测试、没有任务级后条件；`missing`=无任何可执行断言。 |
| **代码层状态** | `fixed` / `pending-deploy` / `unknown` | `fixed`=当前 checkout 有修复且有确定性定向测试；`pending-deploy`=代码层 `fixed` 但生产旧构建未部署；`unknown`=证据不足或需按同 code/args/fixture 复现（含「helper 在 checkout 中不存在」）。**本批没有任何条目处于「现网已验证」态。** |
| **缺口类型** | 见 §2 的 `G1`–`G6` | 区分「半在线盲区」「旧构建未部署」「客户端不可控」「在线-only 新维度」。 |

---

## 1. 主 join 矩阵：F1–F6 × 半在线

> 每一列都是 join 的结果，不是症状复述。「在线证据」列写清**能证明什么/不能证明什么**；
> 「当前覆盖」只评价半在线，**不评价现网**。

| 反馈 | 在线证据（旧构建，无 requestId） | 对应半在线测试 / 任务 | 当前覆盖状态 | 代码层状态 | 缺口类型 |
|---|---|---|---|---|---|
| **F1**（P0）`content` 混入 `successfully downloaded text file (SHA: …)` 提示，写回脏数据 | 用户报告：读文本文件后 `content` 首段是提示，写回污染正文。`requestIds:["unknown"]`、`captureVerified:false`。**能证明**：该观测在旧构建窗口被用户看见；**不能证明**：当前 checkout 或现网仍复现。 | 半在线检查：**byte-exact roundtrip**（T1）+ **canonical real-shape**（T3）。任务 `N1`（read→patch→write→readback）、`N6`（截断硬停）、`N9`（写后 post-condition）；定向回归 `tests/online-gap-regression.test.js` T1（纯 `normalizeFileResult` 真形状 pass，guest/no-resources 两例 `todo`）；`tests/gh-file-p0.test.js` P0-1/P0-2 为本 checkout 红项。 | **`weak`**：纯函数真形状断言存在；但任务级 `writePostConditionOk` 指标与 guest `fileResult` 两例仍是 `todo`（N1/N9 只是任务描述，runner 未落），L1 只验 completion 看不到写后字节。 | **`pending-deploy`**：`src/result-normalize.js` 的 `FILE_DOWNLOAD_NOTICE` / `isDownloadNotice` / resources 优先剥离 + SHA 提取已存在且有定向测试；生产旧构建未部署。 | **`G2`**（旧构建未部署）为主；叠加 **`G1`**（半在线缺写后字节校验）→ 需 J1 把 N1/N9 的 post-condition 从」任务描述」升为可执行轴。 |
| **F2**（P0）PR 结果 `number` 偶尔是内部 DB id，后续按 number 调用失败 | 用户报告：旧构建 `create_pull_request` 一类返回中 `number` 取到内部 DB id，merge 报错；PR #53 是外部事实，**不是网关 capture 证据**。`unknown` / `false`。**能证明**：用户观测；**不能证明**：当前代码/现网仍有 id→number 回退。 | 半在线检查：**canonical PR number**（T3）。任务 `N3`（真形状 `{id:1000000001,url:'…/pull/53'}` 断言 `number===53`、`id` 仅字符串）；`normalizePrResult` 定向测试（`numberFromUrl(url) ?? …`）。 | **`weak`**：`N3` 与纯函数测试覆盖 URL 优先取 number；但 G6 fixture 仍是简化形状（N3 的 fixture pack 升级未实施），任务级 `idAsPrNumberCount` 计数器未接 runner（SEMI-ONLINE-GAPS §4 N4）。 | **`pending-deploy`**：`src/result-normalize.js` `normalizePrResult` 已 URL 优先且有定向测试；生产旧构建未部署。 | **`G2`** 为主；叠加 **`G1`**（半在线 fixture 非真形状）→ 需 J2 把真形状 PR fixture 固定为任务级断言。 |
| **F3**（P1）并发批处理返回包装不统一，容易解包错层 | 用户报告：旧构建并发批处理时不同路径包装不一（直接值 / `{ok,value}` / envelope），按固定层解包取错字段。无 capture、无 requestId。**能证明**：观测存在；**不能证明**：当前 checkout 的 `unwrap`/`safeAll` 契约是否仍不一致（未复现）。 | 半在线检查：**batch wrapper contract**（T5 不变量）。现有 `docs/HANDOFF.md` 的 safeAll 槽位说明 + `tests/online-gap-regression.test.js` 对三工具/写安全的保护；**没有**专门断言「并发批次的每个槽位解包层级一致、失败槽结构恒为 `{ok:false,value}`」的任务或测试。 | **`missing`**：`N1`–`N9` 无 batch-wrapper 轴（N9 只测原子写/后条件）；线上症状的确定性复现尚未写（`needs-repro`）。 | **`unknown`**：按 `AGENTS.md` 需同 code/args/fixture 复现；本批未复现，不假设已修。 | **`G3`**（半在线此前没有的在线-only 维度）→ 新增 **J3** 建立 wrapper 契约轴。 |
| **F4**（P1）大返回整块截断，切掉末尾关键字段 | 用户报告：旧构建读大返回时整块截断、末尾关键字段丢失。是否由旧构建硬切策略导致未知。**能证明**：用户观测；**不能证明**：当前 checkout 的截断元数据行为（未复现）。 | 半在线检查：**truncation metadata**（T3 真形状 + T5 硬停）。任务 `N5`（fake job-log 302/2MiB + `assertTruncationFlag`）、`N6`（大文件截断硬停 + 分页 join 字节相等）；已有 `tests/no-silent-truncation.test.js`、`tests/audit-truncation.test.js`、`docs/ledger/batch-11-truncation.md`。 | **`weak`**：已有「截断要有 flag」的断言与 N6 硬停；但**没有**专门验证「截断元数据含 limit/original 计数、末尾关键字段不被静默丢弃」的任务级轴；旧构建的症状是否与当前策略同源未复现。 | **`unknown`**：需同 code/args/fixture 复现；`needs-repro`，本批不假设已修。 | **`G3`**（在线-only 维度：truncation *tail metadata*，不只是「有 flag」）→ 新增 **J4**。 |
| **F5**（P1）多文件修改仍逐文件提交，失败留半成品 | 用户报告：旧构建多文件修改是逐文件提交而非原子提交。与本项目 `github__push_files` 原子写设计相悖。**能证明**：用户观测；**不能证明**：该观测是否来自未走原子写路径的旧构建调用。 | 半在线检查：**atomic-by-default**（T5 写安全）。任务 `N9`（`writeFiles`/`applyFilePatches` 一次提交、失败零落盘、dryRun 零字节、后条件）；`tests/b11-write-transaction.test.js` 已覆盖原子写。 | **`covered`（原子写本身）** 但 **`weak`（默认语义）**：现有测试证明「调用方显式走原子路径时安全」，**没有**断言「多文件写默认即原子、无需调用方声明」这一默认语义轴；旧构建症状未复现。 | **`unknown`**：需同 code/args/fixture 复现确认该在线症状来自哪条路径；`needs-repro`。 | **`G3`**（在线-only 维度：**atomic-by-default**，非「原子写是否存在」）→ 新增 **J5**。 |
| **F6**（P2）CI 轮询过碎，需 3–4 轮工具调用才拿到结果 | 用户报告：旧构建等 PR checks 时轮询粒度碎、多轮往返。无 capture、无 requestId。**能证明**：用户观测；**不能证明**：目标构建是否有「一次等待」的 helper。本 checkout 实测：存在 REST helper `github_actions_list_workflow_runs` / `list_workflow_jobs` / `get_job_logs`（gateway-side，见 `src/codemode.js`），但**不存在 `waitForPrChecks` 或任何 wait/poll helper**（全仓搜索 `waitFor`/`pollPrChecks` 无匹配）。 | 半在线检查：**CI wait helper**（N6 Actions-log lane 的等待侧）。`N5`（fake job logs + 302 不转 token + 截断标记）覆盖「取日志」，**不覆盖**「一次等待到终态」；fake CI 状态序列（pending→…→completed）的等待辅助任务此前完全不存在。 | **`missing`**：无 wait-helper 任务；`N5` 只验日志获取。 | **`unknown`**：helper 在 checkout 中不存在（实测），不是「已修未部署」，也不是「现网回归」——是**能力缺失 + 未复现**。 | **`G3`**（在线-only 维度：**CI wait helper**）→ 新增 **J6**；`G4`（客户端不可控部分另记，不并入 F6 的网关判据）。 |

正面三项（批处理省上下文 / 读写隔离 / 高频封装）映射半在线 **T5 不变量保护**
（`SEMI-ONLINE-GAPS.md` §1.1 F7 行）：状态 `confirmed`（设计不变量在代码层存在且有
既有测试保护），**不需要修复或部署**；但 F3 的 join 说明「批处理被用户肯定」与
「批处理包装契约缺断言」可以同时成立——前者是价值判断，后者是覆盖缺口，不互相抵消。

---

## 2. 缺口类型字典（为什么分类，而不只是列症状）

| 代码 | 缺口类型 | 判据 | 对应 F |
|---|---|---|---|
| `G1` | **半在线盲区** | 现有任务/回归不观测该属性（只看 completion 或只测纯函数） | F1（写后字节）、F2（真形状 fixture 未进任务集） |
| `G2` | **旧构建未部署** | 当前 checkout 有修复 + 定向测试，生产旧构建未含该修复 | F1、F2 |
| `G3` | **在线-only 新维度** | 半在线此前没有该轴；不是「旧代码有 bug」，是「我们从未测过这个契约」 | F3（batch wrapper）、F4（truncation tail metadata）、F5（atomic-by-default）、F6（CI wait helper） |
| `G4` | **客户端/上游不可控** | 网关无法观测或强制；记 `unknown`，不记 pass/fail | 用户澄清的「漏看可加载列表」（wontfix，不计入 F1–F6）；F6b 长会话 `unknown_tool`（本批不在 F1–F6 判据内） |
| `G5` | **不可比指标误用风险** | 在线单请求与 L1 任务级指标无共同分母，禁止换算 | 跨全部 F（见 §3.3 / §5） |
| `G6` | **证据链断裂** | 全批 `requestIds:["unknown"]`、`captureVerified:false`；无法把在线观测回到具体 task/request | 跨全部 F（N9 的 evidence chain 尚未实施） |

> 关键结论：**没有任何一条 F 是「现网已验证仍失败」**。F1/F2 是 `G2`（代码层已修、
> 等部署窗口）；F3–F6 是 `G3`/`G6`（我们此前没有对应观测轴 + 无 requestId），
> 不能靠「部署一下」解决——部署不会让不存在的测试出现。

---

## 3. 在线-only 缺口：半在线此前没有的四个维度 → 新任务 J1–J6

`SEMI-ONLINE-GAPS.md` N1–N9 覆盖了字节回环、分支/ref、PR number、发现成本、
Actions 日志、长会话、平台编码、写安全，但**没有**把下面四个「用户在线才暴露、
半在线从未建模」的契约写成任务。本批新增任务集 `explore/tasks-online-gap-2.json`
（J1–J6，与现有 N1–N9 并列、不修改它）：

| 在线-only 维度（半在线此前没有） | 为什么 N1–N9 不够 | 新任务 | 闭合的 F / 缺口类型 |
|---|---|---|---|
| **batch wrapper contract**（并发批次每个槽位解包层级一致、失败槽恒为 `{ok:false,value}`） | N9 只测「原子写 + 后条件」，N1 只测「单文件回环」；没有任何任务把「一批调用的结果形状」当断言对象。用户肯定批处理价值，但价值不等于契约已被测。 | **J3** | F3 / `G3` |
| **truncation tail metadata**（`truncated` + limit/original 计数 + 末尾关键字段存在性） | N5/N6 只断言「有截断 flag / 硬停 / 分页 join 字节等」，没有断言元数据字段完整性与尾部字段保留。 | **J4** | F4 / `G3` |
| **CI wait helper**（pending→…→completed 一次等待返回终态） | N5 取日志（REST helper 存在），但 checkout 里没有 wait helper；N1–N9 无等待序列任务。 | **J6** | F6 / `G3` |
| **atomic-by-default**（多文件写默认原子，不需调用方显式声明） | N9 证明「显式原子路径安全」，没证明「默认就是原子」；旧构建症状恰好是这条默认语义的 suspicion。 | **J5** | F5 / `G3` |

另外两条是为了让 F1/F2 的 `G2` **可验证**而补的「同构建配对」任务，不是新维度本身：

| 新任务 | 作用 | 闭合 |
|---|---|---|
| **J1** | 把 F1 的 byte-exact post-condition 从「任务描述」升为可执行轴：同一 fixture 上旧生产构建 vs 当前代码构建各跑一次 `read→patch→write→readback`，断言新构建 `readback===intendedBody` 且无 notice、`sha` 来自提示；旧构建结果只作对照，不与新构建混算。 | F1 / `G1`+`G2`，配 J2 证据链 |
| **J2** | 把 F2 的 canonical PR number 真形状 fixture 固定为任务级断言：URL 优先取 `number=53`、`id` 仅字符串；两构建分别记录 `idAsPrNumberCount`，禁止跨构建硬比。 | F2 / `G1`+`G2` |

部署后在线复验（不是本任务集能做的）单独列为 **J-DEPLOY**（非可执行任务，见 §5）：
它需要真实窗口 + requestId + capture，本批不执行、不编造。

### 3.1 J1–J6 一览（详见任务集 JSON）

| ID | 名称 | 覆盖轴 | 模式 | 前置条件 |
|---|---|---|---|---|
| J1 | same-build byte-exact postcondition (F1) | byte-exact / readback | fake/replay（两构建标签分离） | 旧构建结果只作对照；dryRun；无网络 |
| J2 | same-build canonical PR number (F2) | URL-first number | fake/replay（两构建标签分离） | 真形状 PR fixture；零真合并；无网络 |
| J3 | batch wrapper contract (F3) | 解包层级 / 失败槽 | fake/replay | 并发批次 fake 上游；无真实凭据 |
| J4 | truncation tail metadata (F4) | limit/original / 尾部字段 | fake/replay | 超阈值 fake body；截断即硬停 |
| J5 | atomic-by-default multi-file write (F5) | 默认原子 / 失败零落盘 | fake/replay | N 文件 + 第 k 个失败；dryRun 零字节；无真写 |
| J6 | CI wait helper sequence (F6) | 一次等待到终态 | fake/replay | fake pending→completed 序列；无网络/真 CI |

---

## 4. 同任务 / 同时间线对照规则（硬性，伪对照一律作废）

 遵循 `TYPED-PLAN-TEST-PLAN.md` §1.3 / §6.3 与 `ONLINE-FEEDBACK.md` §2：
**用同一 prompt/task 在「旧生产构建」与「新代码构建」各跑一次，两列并列；
不能把旧构建的在线观测和新构建的离线结果混算成一个差值。**

### 4.1 配对单元

1. **同任务**：J1–J6 每个任务的 `prompt`（原文）和 fixture（`RAW` 真形状 /
   `PR_REAL` / CI 序列 / N 文件等）在两构建中**逐字、逐字节相同**。
2. **同构建**：每个样本明确标注 `buildId` ∈ {`prod-old-2026-11-23`,
   `checkout-current`}（外加部署后的 `prod-new-<deploy-window>`）；**同构建内**的
   前置/后置才是合法对照。
3. **同会话边界**：每个 (task, build) 用新 `initialize` / 新 sessionId；
   不复用上下文（session marker 已验证可行）。顺序交替 A→B / B→A 抵消缓存。
4. **同预算**：token budget / maxTurns / deadline / 工具面（三工具同名同序）
   在两构建一致；任一不同则该配对作废、不计入验收。
5. **同判据**：每轴输出布尔/计数（`writePostConditionOk`、`idAsPrNumberCount`、
   `wrapperUnwrapDepthConsistent`、`truncationTailMetadataOk`、
   `atomicByDefault`、`ciWaitRounds`），不是单一 `completionRate`。

### 4.2 禁止事项（明确写死）

- **禁止跨构建硬比**：不得写「旧构建 F1 失败 → 新构建 pass，因此提升 X pp」。
  旧构建只提供「当时观测到什么」，新构建只提供「当前代码在该任务上是否可观测」；
  两者的判据、capture、runner 标签都不同，没有共同分母。
- **禁止 requestId 编造**：全批 `requestIds:["unknown"]`；写不出 UUID 就写 unknown。
  在线观测没有 taskId/sessionId 时（N9 证据链未实施）不许从 prompt 猜 task。
- **禁止把在线单请求指标当 L1 task 指标**：`durationMs` ≠ `p95LatencyMs`；
  `response.bytes` ≠ `tokensPerTask`；在线无 completion/searchHit/toolHit 标签。
- **禁止未部署即宣称现网修好**：F1/F2 状态只能是 `pending-deploy`，
  直到部署窗口拿到可回放 requestId 证据。
- **禁止把「helper 不存在」写成「测试失败」**：J6 在 checkout 中应记为
  `unknown/missing-capability`，只有 helper 落地后才能转真断言。

### 4.3 允许的三类合法结论

| 对照 | 能得出 | 不能得出 |
|---|---|---|
| 旧构建在线观测 ↔ 同一 prompt 的新代码构建 fake/replay | 「该轴在新代码是否可观测 / 是否有确定性测试」 | 「现网已修好」「旧构建 bug 已消除」 |
| 部署后在线 replay（同 prompt、有 requestId） ↔ 冻结基线（同构建口径） | 「部署是否生效」「轴是否闭合」 | 跨平台/跨构建差值 |
| 同构建内 J1–J6 的前后配对 | 指标口径一致性、回归检测 | 质量提升幅度（fake/replay 只验管线，不是质量证据） |

---

## 5. 结论：三类问题各归其位（本 join 的答案）

### 5.1 说明「半在线缺口」的问题（G1 / G3，靠加测试与任务闭合，不靠部署）

- **F3 batch wrapper contract**：`missing`。用户肯定批处理，但我们从没把「一批结果
  的解包层级一致 / 失败槽结构恒定」写成可断言属性 → **J3**。
- **F4 truncation tail metadata**：`weak`。我们测过「有 flag」和「截断即硬停」，
  没测「limit/original 计数 + 尾部关键字段保留」→ **J4**。
- **F5 atomic-by-default**：原子写本身 `covered`，默认语义 `weak` → **J5**。
- **F6 CI wait helper**：`missing`；且 checkout 里 `waitForPrChecks` **不存在**，
  不是部署能解决的，是能力/覆盖双缺 → **J6**。
- **F1 / F2 的半在线侧**：字节后条件与真形状 PR fixture 只到 `weak`，
  N1/N9/N3 仍是任务描述而非 runner 落地 → **J1 / J2** 把它升成可执行轴。

> 这些项即使明天部署，也不会自动变成「已覆盖」。**部署 ≠ 补测试。**

### 5.2 只是「旧构建未部署」的问题（G2，代码层已修，等窗口）

- **F1**：`src/result-normalize.js` 的提示剥离/SHA 提取 + 定向测试已在 checkout；
  生产旧构建未部署 → `pending-deploy`。
- **F2**：`normalizePrResult` 的 URL 优先取 number + 定向测试已在 checkout；
  生产旧构建未部署 → `pending-deploy`。

这两条**不是**当前代码缺陷；但它们仍需要 (a) J1/J2 把半在线轴补成可执行，
(b) §5.3 的部署后在线复验，才能从 `pending-deploy` 升级。

### 5.3 需要部署后在线复验的问题（J-DEPLOY，非本批可执行）

| 复验项 | 前置 | 需要的证据（缺一不可） | 当前 |
|---|---|---|---|
| F1 真窗口文本读→写→读回 | 部署窗口；真实 `get_file_contents` | requestId + capture（读/写 path 覆盖，见 N2 写路径缺口）+ `readback===intended`、无 notice | `unverified` |
| F2 真 PR 结果 number | 部署窗口；真实 PR（如 #53，外部事实） | requestId + `number` 来自 URL、`id` 未当 number、后续调用不失败 | `unverified` |
| F3/F4/F5 | 先 J3/J4/J5 本地复现并写确定性回归（AGENTS.md 流程） | 复现证据（同 code/args/fixture）+ 升级为 `fixed 代码层` 后随窗口复验 | `needs-repro` |
| F6 CI wait | 先 J6 落地 wait helper；再真实 CI run（vault token，非 CI） | helper 存在性证明 + 一次等待到终态 + 302 不转 token + 截断标记 | `unknown` |
| 整批状态 | 上述证据 + 可回放 requestId | 按 `ONLINE-FEEDBACK.md` 把 `offline.comparison.linked` 升级 | `unverified`（保持） |

> 客户端侧的「漏看可加载列表」属用户误判（`wontfix`，客户端使用），
> 不计入 F1–F6、不触发修复/部署；F6b 长会话 `unknown_tool` 属外部客户端行为，
> 记录为 `unknown`，不并进 F6 的网关判据。

---

## 6. 交付与验证

- 新任务集：`explore/tasks-online-gap-2.json`（J1–J6，`realWritesAllowed:false`、
  每任务 `dryRun:true` / `forRealWrite:false` / fake 前置条件）。
- 校验测试：`tests/online-semionline-join.test.js`（任务 schema/ID/覆盖轴/无真实凭据；
  本文关键字段可解析），命令 `node --test tests/online-semionline-join.test.js`。
- 台账：`docs/ledger/batch-15-online-semionline-join.md`。
- 本批零 `src/`/`scripts/`/其它 tests/README/workflows 改动；无网络、无凭据、无真实写；
  不 commit / push / deploy。

### 6.1 给测试程序解析的关键字段（保持稳定）

```
JOIN_DATE: 2026-11-23
ONLINE_RECORD: docs/eval/online-feedback-2026-11-23-gemini.md
SEMI_ONLINE_SOURCE: docs/eval/SEMI-ONLINE-GAPS.md
EXISTING_TASK_SET: explore/tasks-online-gap.json (N1-N9, unchanged)
NEW_TASK_SET: explore/tasks-online-gap-2.json
TASK_IDS: J1,J2,J3,J4,J5,J6
REQUIRED_AXES: batch-wrapper-contract,truncation-tail-metadata,ci-wait-helper,atomic-by-default
ONLINE_ONLY_GAPS: G3
DEPLOY_BLOCKED: F1,F2
NEEDS_REPRO: F3,F4,F5
UNKNOWN: F6
REQUEST_ID_POLICY: unknown (never fabricated)
CAPTURE_VERIFIED: false
COMPARISON_RULE: same-prompt-same-build-paired; cross-build-hard-compare=forbidden
```
