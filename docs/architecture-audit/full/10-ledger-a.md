# 10 · Ledger A 深读报告（README + batch-0 … batch-7）

> 审计类型：**只读逐文件深读**（不写代码、不 commit、不 push、不 deploy）
> 审计范围：`docs/ledger/` 中 README + batch-0 到 batch-7（含 README 若落范围）
> 采样时间：2026-11-24（Asia/Singapore）
> 读者须知：本文中的结论严格按 `[代码]/[文档]/[测试]/[未验证]` 标注，绝不把"测试绿"等同于"完成"。
> 关键契约对照：`docs/FRAMEWORK.md`（六模块/七模块审计）、`docs/WORKFLOW.md`（G1–G7、G5 四步法）、
> `docs/ACCEPTANCE.md`（V0 验收门，NOT ACCEPTED）、`docs/ARCHITECTURE.md`、`docs/ledger/README.md`（门控/证据规则）。

---

## 0. 覆盖完整性（硬要求 1 / 2）

### 0.1 `git ls-files docs/ledger` 的完整清单

该命令返回 **82** 个 tracked 文件（README + batch-0..15 的全部台账 + `mcp-2026-07-compat.md`）。
本次任务被明确限定为 **README + batch-0 到 batch-7**，故本审计员的负责子集为 **9 个文件**：

| # | 路径 | 字节 | 是否读完 | 关键结论（摘要） |
|---|---|---:|---|---|
| 1 | `docs/ledger/README.md` | 7758 | ✅ 全文 75 行 | 定义分类(SCENARIO/ISSUE/ROOT/FIX/TEST/DEC)与三阶段门控(B1→B2→B3)；写死三条防再犯证据规则(额度逐个实测+时间戳/逐文件读源码+交叉验证/配置改后校验)；制度化"反馈四步法"(逐层 L1-L3、找同类、识别收益风险、走一步看三步)。**索引里声明的 `ledger.json` 实际不存在**（见 §5.1）。 |
| 2 | `docs/ledger/batch-0-history.md` | 3941 | ✅ 全文 54 行 | 回溯登记 B0-1..B0-16 已做工作；16 个提交修复(resource 丢失/CAS fencing/真隔离 QuickJS/非法 runtime 字段等)；6 条 DEC；记录 62→207 测试。多为历史快照，含"当时已修"表述，需按当前代码复核。 |
| 3 | `docs/ledger/batch-1-scenario.md` | 2972 | ✅ 全文 37 行 | B1 通过(附条件)：191/191 工具覆盖；105 官方逐字 + 86 schema 驱动；两轮调研确认 Linear/Vercel 权威任务结构性 0 覆盖；TrueFoundry mcp-skillbench 404 登记为遗留 DEC。 |
| 4 | `docs/ledger/batch-2-rootcause.md` | 6888 | ✅ 全文 86 行 | B2 通过：6 份根因报告 A-F；2 真 bug(归一化时序、structuredContent 吞块)已修；4 高 ROI 补修；10 项 L1/L2 残留逐条登记 DEC；RC-F 三类 lead 认知 L3 催生 README 三条证据规则。**首版判定"未通过"→补修后"通过"，是门控真实生效的范例**。 |
| 5 | `docs/ledger/batch-3-retest.md` | 3237 | ✅ 全文 58 行 | B3 通过：191 任务全跑；237 异常(gateway 45/模型 157/synthetic 4/infra 31)；逐条复核 45 个 gateway **无新功能 bug**；searchHitRate 55.4% 诚实标注为找问题基线，非发布分数；首跑 merge bug(.items vs .anomalies)已修+回归。 |
| 6 | `docs/ledger/batch-4-figma.md` | 7471 | ✅ 全文 111 行 | 第五上游 Figma：50 工具/deny 4/保留 46；DCR workaround("Codex" client_name、不带 scope、90 天+refresh)；首版按名字猜 22 deny 被官方文档纠正为 4(误伤教训)；G1-G7 全过；G7 线上真实调用；**文末记录 `ledger.json` 仍不存在(欠账)**。 |
| 7 | `docs/ledger/batch-5-gemini-feedback.md` | 5110 | ✅ 全文 75 行 | 4 个 Gemini 真实反馈(ISSUE-1 三份重复正文 / 2 截断预算不透明 / 3 解包 helper / 4 二进制图片)全部按 L1-L3 追溯并代码层修复；明确"**不能宣称 B5 通过**"(真实客户端重测未做)；后补线上回归：三份重复消失、Intl helper 正常，但 >24KB 显式截断标记/图片二进制/unwrap 真实任务仍未覆盖。 |
| 8 | `docs/ledger/batch-6-search-attribution.md` | 2909 | ✅ 全文 55 行 | 新增 Figma 致既有 191 条检索回归(56.5→56.0 top1)；L3=没有"新增上游不得回归既有子集"约束；修复=按服务重建 IDF 索引 + 窄别名(repository/repo→github, deployment→vercel)；恢复 57.1/72.3；风险=别名硬过滤可能误伤。 |
| 9 | `docs/ledger/batch-7-g6-findings.md` | 3854 | ✅ 全文 52 行 | G6 首跑发现 sandbox 无 Intl(5 条真缺口) + detector 误归因(services 16、not a function 5)；修复 codemode.formatDate/nowISO + guidance、detector 只在显式 error 判错；重跑 228/873/718，anomalies 363(gateway 86 逐条复核无新功能 bug)，**注意：文件开头写"不宣布 G6 通过"，文末写"G6 ✅通过"——这是同一文件内的状态演进，不是矛盾**(见 §5.2)。 |

### 0.2 计数

```
expected = 9   （README + batch-0..batch-7 的 tracked 文件）
read     = 9   （全部逐文件全文打开，非仅目录/标题/grep）
unread   = 0
```

> 说明：`git ls-files docs/ledger` 全量为 82 个文件，但任务只授权读 batch-0..7 + README。
> batch-8..15 与 `mcp-2026-07-compat.md` **不在本审计范围，未打开，不对其内容下结论**；
> 提到 B8-B15 时仅引用 README 索引与 FRAMEWORK/ACCEPTANCE 的既有陈述，并标注为 `[文档]` 转述。

---

## 1. 历史修复与召回（历史快照，均需按当前代码复核）

> 这些是"当时记录已修"的历史条目，属 `[文档]` 记载 + 当时 `[测试]`；**不等于当前生产仍成立**，按 AGENTS.md §0 当前生产为 `d1f36ba`。

### 1.1 B0 回溯的修复链（batch-0-history.md）

- `[文档]` B0-1/9（299e9ee→1328506）：P0 resource 内容块丢失、isError 静默、toolCalls 泄漏、Web API、`execute_read` 拆分、enum 提示、search 兜底。
- `[文档]` B0-2/5（2f17d5a / fd8b74b 系）：**token 并发安全三件套**——CAS fencing（RFC 9700，并发 refresh 不覆盖 winner）、Notion token 反复烧的 bootstrapped 清除 + 锁 + CAS + self-heal、静态 token 禁 refresh（B0-7 全跑 53 条）。
- `[文档]` B0-3/8（fd8b74b→a04ce39）：探索测试基建、191 条官方任务集、86 条重生任务 + 真隔离调研。
- `[文档]` B0-4（4bf27f5→1328506）：execute 崩溃兜底、invalid_grant 终态、分布式锁、全量探索。
- `[文档]` B0-11（a1c8051→4bf27f5）：6 代理并行修复——双重序列化、结构化截断、5 类内容块、listTools 精简、50 次上限+去重、toModelOutput 审计剥离、logs 上限、错误结构化、sanitize 6 bug。
- `[文档]` B0-15（633cb6f）：**真隔离**——Vercel run SDK QuickJS（替代 Node `vm`，作用在"vm 不能当安全边界"的 L3）。
- `[文档]` B0-16（5ab2e47）：修复非法 vercel runtime 字段导致的部署 ERROR。
- `[文档+测试]` TEST-H1：单测 62→207 全绿；TEST-H2：v2 探索 138 条 215 异常（旧基线 gitSha 937b2e7）；TEST-H3：线上真隔离探活；TEST-H4：Notion grant 修复后恢复。

### 1.2 B1–B3 三阶段门控（通过链）

- `[文档+测试]` B1：191/191 工具全覆盖；105 官方逐字 + 86 schema 驱动（86/86 top5）。
- `[文档+测试]` B2：2 真 bug 修复（归一化时序、structuredContent 吞块）+ 回归测试；6 项补修；10 项 DEC；`npm test` 217/217。
- `[文档+测试]` B3：191 任务全跑、237 异常、gateway 45 逐条复核无新功能 bug；`npm test` 数据见 batch-3。首跑 merge bug 修复+回归。

### 1.3 B4–B7（Figma 与投放后回归链）

- `[文档+测试]` B4：Figma 50/46/4；审计脚本入库；token 强刷实测；343/343；G1-G7 全过（G7 线上 Gemini→网关→Vercel/Figma 真实调用）。
- `[文档+测试]` B5：4 个真实反馈代码层修复，362/362；线上回归确认 3 份重复消失 + Intl 正常，但 3 项未覆盖。
- `[文档+测试]` B6：按服务索引 + 窄别名，恢复 57.1/72.3，343/343。
- `[文档+测试]` B7：Intl helper + detector 修复，350/350，重跑 gateway 86 无新功能 bug。

### 1.4 "召回"情况（已发现并回收的缺陷类别）

| 类别 | 首次记录 | 召回方式 | 是否形成永久回归网 |
|---|---|---|---|
| resource/toolCalls 泄漏 | B0-1/B0-9 | 真实 Gemini 任务反馈 | `[文档]` 有测试，未在范围内核实具体文件 |
| token 并发双花/烧 token | B0-2/5/7 | 探索+线上异常 | `[文档]` CAS+锁+静态 token；B2 仍登记 lock+CAS 窗口为 DEC |
| 双重序列化/结构化截断 | B0-11 / B2 RC-F1/F2 | 6 代理并行审计 | `[文档]` 修到 L2/L3 |
| 新增上游检索回归 | B4 G5 / B6 | G4 基线对比拦截 | ✅ `tests/search-service-attribution.test.js` |
| sandbox 能力缺口(Intl) | B7 | G6 全量重测 | ✅ `tests/codemode-date-helper.test.js` |
| detector 误归因 | B3/B7 | 逐条复核 gateway 异常 | ✅ `tests/detector.test.js` |
| 一处 merge 契约漂移 | B3 | 首跑汇总崩溃 | ✅ 回归测试 |

---

## 2. 反复出现的根因（跨文件聚类）

> 这些是 B0-B7 中**跨多个文件/批次重复出现**的 L2/L3，不是单次 bug。标注 `[文档]`（台账自身结论）+ 本文分析。

1. **"结果协议/可见性契约缺位"（最强反复根因）**
   - B5 ISSUE-1/3/4 全部指向同一 L3："网关只做安全截断，没有定义给模型的结果协议"，三份重复正文、解包样板、二进制乱码是同一病根的三个症状。
   - B7 ISSUE-G6-1 自认"与 B5 的截断预算不透明同源（让模型猜）"。
   - README 反馈机制 §63 直接点名："共同 L3 是 Code Mode 折叠了元数据但没把可见性做成一等能力——所以要建可见性契约，而不是补 4 个字段"。
   - `[文档]` 这是从 B5 到 B7 一致复现、并被制度化的最核心根因。

2. **"有权威依据可支配却没去用"——lead 认知 L3（RC-F）**
   - B2 记载三类错误：Firecrawl 额度误判、Cloudflare normalize 误判、部署 runtime 非法。
   - 已制度化为 README 三条证据规则（额度逐 key 实测+时间戳 / 逐文件读源码+交叉验证 / 配置改后校验）。
   - `[文档]` 这是唯一被写进 README 硬规则的"认知层"根因，说明项目已意识到"工具链错误常被误归为外部问题"。

3. **"门控/稳定性约束缺失导致回归"**
   - B6 L3："没有新增上游不得回归既有子集的稳定性约束——正是 G4 要拦的，旧实现没有提供机制"。
   - B4 评审条件"证据必须入库、换人可复核"（gitignored work/ 里的证据不算数）也是同一类：没有机制化的门控，证据和稳定性就会漂移。

4. **"归因口径失真"反复污染评测结论**
   - B3：45 个 gateway 里混了模型漏填参数/预期 stub 报错/上游占位数据；B7：detector 把 `services()` 合法对象判 execute_error、`not a function` 误归 gateway。
   - `[文档]` 两次都靠"逐条复核"而非自动机制发现，说明归因正确性仍依赖人工，是反复暴露的系统性弱点。

5. **"沙箱/运行时能力边界未显式契约化"**
   - B2 SBX-1（vm 不能当安全边界）、B7 Intl 缺失、B5 截断预算三层口径不同——都指向"模型按 Node 习惯/按猜测写代码，而运行时边界没写成一等契约"。
   - `[文档]` 修复方向一致：显式 helper + guidance（formatDate/nowISO、true cap），而非补不完整 polyfill。

6. **"操作层根因靠纪律/绕开而非工程隔离"**
   - B2 AUTH-1（多 worker 抢 grant 靠静态 token 绕开）、AUTH-3（CAS 后置双花窗口靠锁+自愈降到极低）均登记为 DEC 接受。
   - `[文档]` 这些是"已知未闭环"的工程债，B15/FRAMEWORK §14 后续仍在授权所有权上打转。

---

## 3. 与当前 FRAMEWORK / 六模块的对应

> FRAMEWORK.md 定义六模块：①核心底座 ②客户端 ③评测体系 ④上游接入 ⑤运行时/部署 ⑥开源工程。
> 映射按台账文件主要内容归类；一项可跨模块。

| 台账 | 主要对应模块 | 交叉 | 证据性质 |
|---|---|---|---|
| README | ③评测（门控/证据规则）/ 全模块（反馈机制） | ①④（权威任务、可见性契约） | `[文档]` 制度层 |
| B0 history | ①④②③⑤ | 全模块历史快照 | `[文档]` 历史 + 当时 `[测试]` |
| B1 scenario | ③（离线评测/权威任务） | ④（四上游工具覆盖） | `[文档+测试]` |
| B2 rootcause | ①（codemode/沙箱）②③⑤ | ①④（授权/检索） | `[文档+测试]` |
| B3 retest | ③（全量重测） | ①④ | `[文档+测试]` |
| B4 figma | ④（上游接入 SOP 样板）+ ⑤（token 同步 Vercel/redeploy） | ②（G7 Gemini 线上调用）③（G4/G6） | `[文档+测试+未验证]`（线上调用有 G7 实证，但"带客户端 token 线上 MCP 调用"未做） |
| B5 gemini | ②（客户端反馈/适配）①（结果协议、codemode unwrap） | ③（真实回归） | `[文档+测试+未验证]`（三份重复/Intl 线上已验，截断标记/图片未验） |
| B6 search | ①（核心底座检索）③（稳定性门控） | ④（新增上游） | `[文档+测试]` |
| B7 g6 | ①（sandbox 能力）+ ③（detector 归因） | ②（Intl 是模型在客户端写 JS 触发） | `[文档+测试]` |

### 3.1 B0-B7 在六模块中的"已覆盖 / 缺口"

- **①核心底座**：B0-15 真隔离、B5 unwrap/结果协议、B6 检索归属、B7 Intl helper——**代码/离线证据充分**；但 FRAMEWORK §8/§15 明确 Native/Hybrid、按客户端选执行器仍是 L0-L1，typed-plan 默认关闭（B14 不在本范围）。
- **②客户端**：仅 Gemini 有真实线上调用（B4 G7、B5 线上回归）；ChatGPT/Claude 无；FRAMEWORK §11-§13 的"平台×模式"分 lane 在 B0-B7 时代尚未成型。
- **③评测体系**：B1-B3/B6/B7 建立了离线+归因方法；但主动/被动线上评测、采集层 session/project/task 交叉是 B9+ 才做（本范围只到 B7，FRAMEWORK §4/§15 仍列为进行中）。
- **④上游接入**：四上游 + Figma 走完 G1-G7 是重要 SOP 样板；授权 owner/grant 隔离在 B2 登记 DEC、B15 继续（本范围未覆盖）。
- **⑤运行时/部署**：B0-16 runtime 字段、B4 token 同步 Vercel；但部署纪律/多平台部署调研属 FRAMEWORK §6 未决。
- **⑥开源工程**：B0-B7 完全未触及；FRAMEWORK §15 标注开源仍 L0。

---

## 4. 可复用 SOP / 方法（从台账中提炼）

1. **三阶段门控（README §34-38）**：B1 场景覆盖 → B2 根因修复 → B3 全量重测；前项不通过不进下一项；每项结论必须有证据。
2. **G5 四步法（README §54-70、WORKFLOW §10）**：表象→L1→L2→L3 → 找同类 → 识别收益/风险 → 走一步看三步；判定修复作用在 L 几，只压 L1 不算完成。B5 四条反馈是标准范例。
3. **三条防再犯证据规则（README §40-52）**：额度逐 key 实测+时间戳 / 技术结论逐文件读源码+交叉验证 / 配置改后跑校验。
4. **新增上游不得回归既有子集（B6）**：G4 基线用同子集对比 top1/top5；新任务单独报告，不混口径；按服务重建索引 + 窄别名 + 回归样例。
5. **gateway 异常逐条复核（B3/B7）**：不信任 detector 汇总；把 gateway 异常分"上游数据/模型行为/预期行为/真网关 bug"四类，只有真功能 bug 才算缺陷。
6. **detector 口径契约（B7）**：只在 JSON 显式 error（isError/status/error/`execute error:`）判错；成功结果含 "not found" 不误报；`not a function` 归 model。
7. **沙箱能力显式化（B7）**：缺 Intl 时加最小 helper + guidance，不塞不完整 polyfill（避免 locale 语义骗模型）。
8. **外部证据入库（B4 评审条件）**：tools/list 快照、官方工具清单、审计脚本必须入库且换人可复核；gitignored work/ 里的证据不算数。
9. **Figma DCR workaround（B4）**：client_name 伪装 + 不带 scope + 90 天 refresh；标注"非官方支持、可随时封禁"的风险（属 DEC 接受）。

---

## 5. 文档矛盾 / 过时结论 / 被埋掉的风险

### 5.1 文档矛盾与过时

- **D1 `[文档]` `ledger.json` 不存在**：README §74 与 B4 文末（batch-4-figma.md:110）都引用/登记 `docs/ledger/ledger.json`，本次核实 `Test-Path` 返回 **MISSING**。README 称"见 ledger.json（机器可读）"是**过时/悬空引用**；B4 已登记为欠账但从未闭环。**待办：补建或删引用**（本审计只记录，不改）。
- **D2 `[文档]` B5 状态表述需分层读**：README 索引把 B5 标为"⚠️进行中（代码层已修，真实客户端重测未做）"，而 batch-5 正文 §60-66 又记了 2026-11-23 的 Gemini 线上回归（三份重复消失、Intl 正常）。**两者不冲突但 README 未更新**：代码层全修 + 部分线上已验 + 关键项（>24KB 截断标记、图片二进制、unwrap 真实任务）未验。
- **D3 `[文档]` B7 文件内状态演进**：开头 §4"本批只登记发现与分类，**不宣布 G6 通过**"，文末 §52"G6 结论：✅通过（修复后重跑）"。这是"首跑未通过→修复重跑通过"的时间线，**不是自相矛盾**；但读者若只读开头会误判。
- **D4 `[文档]` B2 历史快照保留**：batch-2 §44-48 明确保留"补修前初始判定：未通过"，文末 §63"最终通过"。同样是演进，正文已加注说明，属良好实践。
- **D5 `[文档]` 测试数字跨批次跳跃**：B0 207 → B2 217 → B4/B6 343 → B5 362 → B7 350。数字非单调（362→350 是不同基线/批次范围变化），**不可跨批次硬比**；当前 AGENTS.md 基线为 1406 tests（B0-B7 之后的合并结果，不在本范围）。
- **D6 `[文档]` B0 历史"已修"条目未经当前代码复核**：如 B0-15 真隔离、B0-16 runtime 字段，均为当时提交；按 AGENTS.md §0 当前生产 `d1f36ba` 与这些早期提交的对应关系未在本文核实（`[未验证]`）。
- **D7 `[文档]` FRAMEWORK §15 称"七份只读深读报告"**，而审计目录当前只有本次新建的 `10-ledger-a.md` 等；本文不改变该索引，仅提示索引与实际一致性由 lead 统筹。

### 5.2 被埋掉的风险（台账写了但容易被忽略）

- **R1 `[文档]` B5 未覆盖项**：>24KB 文件的显式截断标记、图片二进制、unwrap 真实任务——三份重复虽消失，但"截断标记从未被实际验证"（batch-5.md:64），而 B0/B2 又把"结构化截断/无标记截断"列为反复根因。**这是"修了代码但没有证据证明在真实路径生效"的典型埋雷**。
- **R2 `[文档]` B6 窄别名硬过滤风险**：`repo` 若指其他服务会被强行限定 GitHub；只收强别名 + `+server` 覆盖是缓解，但"后续新增别名必须带回归样例"是承诺而非已验证机制。
- **R3 `[文档]` B2 接受的 DEC 债**：lock+CAS 双花窗口、Notion 多 worker 抢 grant（靠静态 token 绕开）、30 次上限整轮作废、`select:` 接口设计（一个 query 两套语法）——全部"接受"而非修复，风险仍在。
- **R4 `[文档]` B4 Figma DCR workaround 风险**：client_name 伪装 + 无 scope 授权属非官方支持，"Figma 可随时封禁"被明确登记为 DEC 接受；18 个 Weave/Shader/Generative 工具"存疑放行"（9 条任务因需付费账号跳过）——覆盖是纸面 46/46，真实能力未全覆盖。
- **R5 `[文档]` B7 detector 修复后 gateway 86 仍需逐条复核**：`not a function` 7 条全归 model 依赖新口径；若 detector 再漂移，G6 数字会再次不可用于验收。
- **R6 `[文档]` B3 的 searchHitRate 55.4% 与 B4/B6 的 57.1% 是不同口径**：B3 明确"不作为发布分数"；任何把 55.4% 当回归证据或把 57.1% 当全局分的引用都是误用。
- **R7 `[未验证]` 本范围所有"线上验收"**. B4 G7 是真实 Gemini 网页端调用（有具体 URL/时间），可信；但 B5 线上回归仅 2 项任务、3 项未覆盖；ACCEPTANCE.md 当前总判定 **NOT ACCEPTED（0/7 门全过）**——B0-B7 的任何"通过"都是代码/离线门控，不是 V0 验收。

---

## 6. 仍需真实证据的项目（`[未验证]` 清单）

> 严格区分：以下均**没有**真实客户端/真实线上/真实授权证据，不能写"完成"。

| 项 | 来源 | 状态 |
|---|---|---|
| B5 的 G6 等价项：真实 Gemini 对 4 个修复任务重测 | batch-5.md:57-58 | `[未验证]` 明确"不能宣称 B5 通过" |
| >24KB 文件显式 `truncated` 标记的真实触发 | batch-5.md:64,66 | `[未验证]` 12.7KB/14KB 未触发，标记从未实测 |
| 图片二进制 `images[]` 桥的真实端到端调用 | batch-5.md:52,66 | `[未验证]` 仅 1 MiB cap 代码，无真实图片任务 |
| `codemode.unwrap` 在真实任务中被调用 | batch-5.md:66 | `[未验证]` |
| B4 "带客户端 token 的线上 MCP 调用" | batch-4.md:54 | `[未验证]` healthz 含 figma ≠ 带 token 调用 |
| Figma 18 个存疑工具（Weave/Shader/Generative）真实能力 | batch-4.md:31-32 | `[未验证]` 9 条任务因付费账号 skip |
| B0 历史修复对应当前生产 `d1f36ba` 的逐条映射 | batch-0-history.md | `[未验证]` 本审计未做代码/commit 对照 |
| 授权生命周期（owner/refresh/跨环境隔离/72h） | B2 DEC + ACCEPTANCE §D | `[未验证]` AUTH-READY NOT READY |
| 主动/被动线上评测、采集交叉 | FRAMEWORK §4/§15 | `[未验证]` B0-B7 范围未覆盖 |
| `ledger.json` 机器可读台账 | README §74 / B4:110 | `[文档]` 文件缺失，欠账未闭环 |

---

## 7. 结论

- `[文档]` B0-B7 建立了**项目方法论的骨架**：三阶段门控、G1-G7 上游 SOP、G5 四步法、三条证据规则、gateway 异常逐条复核、可见性契约。这些方法在 B4-B7 被反复应用并产生了可复用 SOP（§4）。
- `[测试]` 各批次记录的测试数（207/217/343/362/350）与回归测试是本范围内的代码/离线证据；B6/B7 的检索与 detector 修复有明确回归测试文件。
- `[未验证]` **B0-B7 中任何"✅通过"均指门控/代码层，不是 V0 验收**。ACCEPTANCE.md 当前明确 NOT ACCEPTED（0/7），且 B5 自己写明"不能宣称 B5 通过"。真实客户端覆盖、真实写回环、授权生命周期、在线↔半在线对照均未在本范围闭环。
- `[文档]` 最需要 lead 关注的三个遗留：**`ledger.json` 悬空引用**、**B5 三项未覆盖风险（截断标记/二进制/unwrap）**、**B2 已接受但仍在的 DEC 工程债（token 双花窗口/多 worker/上限整轮作废/select 接口）**。

> 本审计未写代码、未改任何 src/scripts/tests/README/其他 docs/workflows，未 commit/push/deploy。
