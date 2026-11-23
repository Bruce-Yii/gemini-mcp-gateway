# 在线反馈记录（2026-11-23 · Gemini）— `online-feedback.v1`

> 来源：用户通过 **Gemini** 客户端、经网关做真实任务后给出的在线反馈。本记录按
> [`ONLINE-FEEDBACK.md`](./ONLINE-FEEDBACK.md) 的 `online-feedback.v1` schema 写，
> 并与 [`SEMI-ONLINE-GAPS.md`](./SEMI-ONLINE-GAPS.md) 的半在线缺口做映射。
>
> **关键边界（先读）**：本批反馈全部来自**生产旧构建**。用户所报告的 P0 修复
> （F1、F2）虽已在代码层落地，但**尚未部署到现网**。因此：
>
> - 不能据本报告断言「现网仍存在 F1–F6」；本报告只记录旧构建上的用户观察。
> - 代码层已修的项，状态一律标 **`待部署验证`**（不是 `fixed` 端到端、也不是
>   `confirmed` 现网）；须等部署窗口在线复验后才能升级。
> - `unknown` / `needs-repro` 表示证据不足或需按同一 code/args/fixture 复现；
>   不得据模型/归因器建议直接改代码、开 issue 或部署（`AGENTS.md`）。
> - **不编造 requestId**：本批客户端未给出可回放的 requestId，所有项
>   `requestIds:["unknown"]`、`captureVerified:false`。
>
> 本批只写文档；不改 `src/`、`scripts/`、`tests/`、README、其它 docs、
> workflows；不 commit / push / deploy。

## 顶层元数据（脚本可解析）

Recorded-at: 2026-11-23T11:13:00+08:00
Window: 2026-11-23T00:00:00Z -> 2026-11-23T23:59:59Z
Platform: gemini web
Repo: Bruce-Yii/gemini-mcp-gateway
Session: unknown
Task: unknown
Status: unknown
Baseline: explore/baselines/l1-smoke.json

> 整批 `Status: unknown`：本批无 requestId 回放、无 capture 验证，且 P0 修复未部署，
> 不具备升级为 `confirmed`/`fixed` 的证据。

---

## 正面反馈（P0 不变量，须保护）

用户明确肯定三点，均属当前设计的不变量，**无需修复，但改动相关路径时须回归确认不回退**：

1. **批处理 + 端内裁剪省上下文**：一次脚本里批量发调用，并在端内裁剪返回，显著减少往返与上下文占用。
2. **读写隔离清晰**：`execute_read` / `execute` 分层，读路径与写路径边界明确。
3. **高频动作封装省心**：常用动作（如 `safeAll` / `unwrap`、分页、PR 助手）封装后编排负担低。

这三点映射到半在线的 **T5 write safety / 不变量保护**（见
[`SEMI-ONLINE-GAPS.md`](./SEMI-ONLINE-GAPS.md) §1.1 的 F7 行）。证据来源为用户报告，
`captureVerified:false`、`requestIds:["unknown"]`，状态记为 `confirmed`（正面项，指设计不变量在
代码层存在且有既有测试保护，不等于现网端到端复验）。

---

## 问题反馈 F1–F6

> 状态枚举采用本记录约定的四态：`unknown` / `fixed 代码层` / `待部署验证` /
> `needs-repro`。其中 **`fixed 代码层` = 代码层已修且有确定性测试，但未经部署后在线复验**；
> **`待部署验证` = 代码层已修、明确等待部署窗口在线复验**。二者都**不**等于「现网已修好」。

## F1

Severity: P0
Category: result-shape-download-notice
Symptom: 文件内容结果 `content` 混入 `successfully downloaded text file (SHA: ...)` 提示行，写回文件时把提示当正文写入，导致脏数据
Evidence:
Source: user-report
Detail: 用户报告：在生产旧构建上读文本文件后，`content` 首段是下载提示而非纯正文；该脏文本被写回文件，易污染目标内容（写回易脏）。证据形式为在线用户观察；无 R2 capture 可回放，故 captureVerified=false，不编造 requestId。
CaptureVerified: false
Reproduction: 用真实形状 `{text: "successfully downloaded text file (SHA: <hex>)\n<body>", resources:[{text:"<body>"}]}` 调用 normalizeFileResult，断言 `content === body` 且 `content.startsWith('successfully downloaded') === false`、sha 从提示提取；本地纯函数测试已覆盖该形状。真实窗口端到端复现需部署后用同一调用回放。
RequestIds: unknown
Status: fixed 代码层

- **代码层证据**：`src/result-normalize.js` 已有 `FILE_DOWNLOAD_NOTICE` /
  `isDownloadNotice` 与 `normalizeFileResult` 的 resources 优先分支（提示行剥离、SHA 提取）。
- **部署状态**：生产旧构建未部署该修复 → **待部署验证**；不能断言现网已消失。
- **影响**：写回脏数据，可能破坏目标文件内容（用户报告的 observable impact）。
- **半在线映射**：`byte-exact roundtrip`（见下）。

## F2

Severity: P0
Category: pr-number-id-confusion
Symptom: PR 结果的 `number` 偶尔是内部对象 ID（数据库 id）而非 PR 号，导致后续按 number 调用（如 merge）失败
Evidence: Source: user-report
Detail: 用户报告：生产旧构建上 `create_pull_request` 一类返回中，`number` 偶尔取到内部 DB id 而不是 URL 中的 PR 号；按该 number 做后续操作时报错。证据为在线用户观察；PR 号本身不是本网关 capture 证据，且用户未给出可回放 requestId。
CaptureVerified: false
Reproduction: 用真实形状 `{id:1000000001, url:"https://api.github.com/repos/o/r/pulls/53"}` 跑 normalizePrResult，断言 `number === 53`（来自 URL）且 `id` 仅以字符串保留、绝不被当作 number。本地纯函数测试已覆盖该形状；真实 PR 回放未做。
RequestIds: unknown
Status: fixed 代码层

- **代码层证据**：`src/result-normalize.js` 的 `normalizePrResult` 已 `numberFromUrl(url) ?? toNumber(pick(root,['number',...]))`，URL 优先，避免 id 回退为 number。
- **部署状态**：生产旧构建未部署该修复 → **待部署验证**；不能断言现网已消失。
- **影响**：以错误 number 发起的后续调用失败（如 merge 404）。
- **半在线映射**：`canonical PR number`（见下）。

## F3

Severity: P1
Category: batch-wrapper-contract
Symptom: 并发批处理返回结果包装不统一，调用方容易解包错层
Evidence: Source: user-report
Detail: 用户报告：在生产旧构建上做并发批处理时，不同工具/路径的返回包装不一致（有的直接是值，有的带 `{ok,value}` 或 envelope），导致按某一层解包时取错字段。证据为在线用户观察；无 capture 可回放，未定位到具体 requestId。
CaptureVerified: false
Reproduction: 用同一批 fake 上游返回分别走直接值与 `{ok:true,value}` / envelope 形状，断言经过统一 helper（如 `unwrap` / `safeAll`）后解包层级一致、失败槽结构一致（`{ok:false,value}`）；当前需按同一 code/args/fixture 在本地复现以确认是否仍存在。
RequestIds: unknown
Status: needs-repro

- **影响**：解包错层导致取到错误字段或误判失败，增加调用方防御代码与上下文开销。
- **半在线映射**：`batch wrapper contract`（见下）。

## F4

Severity: P1
Category: truncation-metadata
Symptom: 大返回被整块截断，切掉末尾关键字段
Evidence: Source: user-report
Detail: 用户报告：生产旧构建上读取大返回时，结果被整块截断，末尾的关键字段丢失，调用方看不到完整结构。证据为在线用户观察；是否由旧构建的截断策略（如按字节硬切、无结构化截断标记）导致，需本地复现确认。
CaptureVerified: false
Reproduction: 用超过阈值的大 body（含末尾关键字段）跑截断路径，断言：截断时有明确元数据（如 `truncated:true`、limit/original 计数），且不能静默丢弃末尾关键字段或以整块硬切替代结构化提示；本地 fake fixture 可构造，需先复现再判状态。
RequestIds: unknown
Status: needs-repro

- **影响**：末尾关键字段缺失，调用方基于不完整结果做决策。
- **半在线映射**：`truncation metadata`（见下）。

## F5

Severity: P1
Category: atomic-multi-file-write
Symptom: 多文件修改仍逐文件提交，失败时留下半成品
Evidence: Source: user-report
Detail: 用户报告：在生产旧构建上做多文件修改时，实际是逐文件提交而非一次原子提交；中途失败会留下部分写入的半成品状态。证据为在线用户观察；与本项目 `github__push_files` 原子写设计相悖，需确认该观察是否来自未走原子写路径的旧构建调用。
CaptureVerified: false
Reproduction: 用 N 个文件 + 第 k 个写入失败的 fake fixture，断言：要么全部提交（一次 commit / 一次 push_files），要么全部不写（失败时零字节落盘），不留半成品；并断言 dryRun 写零字节。本地已有 `tests/b11-write-transaction.test.js` 覆盖原子写，需用同一 code/args 复现该在线症状。
RequestIds: unknown
Status: needs-repro

- **影响**：失败留下不一致的多文件状态，需人工清理。
- **半在线映射**：`atomic multi-file write`（见下）。

## F6

Severity: P2
Category: ci-poll-fragmentation
Symptom: CI 轮询过碎，通常要 3–4 轮才能等到结果
Evidence: Source: user-report
Detail: 用户报告：在生产旧构建上等 CI/PR checks 结果时，轮询粒度过碎，需要 3–4 轮工具调用才拿到最终结果，浪费往返。证据为在线用户观察；无 capture 可回放，轮询实现细节未知。
CaptureVerified: false
Reproduction: 用 fake CI 状态序列（pending → … → completed）跑等待 helper，断言用 `waitForPrChecks` / CI helper 一次等待即可返回结果，避免 3–4 轮手工轮询；当前需确认该 helper 在目标构建的存在性与行为（未知）。
RequestIds: unknown
Status: unknown

- **影响**：轮询碎，额外往返与上下文消耗；非阻塞但体验差。
- **半在线映射**：`waitForPrChecks/CI helper`（见下）。

---

## 用户澄清（非网关故障）

用户主动澄清：一次「误以为连不上仓库」的情况，是**自己漏看了可加载列表**，并非网关故障。
本条记录为上下文澄清，**不计入** F1–F6 的问题清单，也不触发任何修复/部署动作；
在台账中可归入「用户侧误判 / wontfix（客户端使用）」，但本记录不据此改状态机。

---

## 与半在线（L1/G6）映射（本任务要求）

> 映射原则（见 [`ONLINE-FEEDBACK.md`](./ONLINE-FEEDBACK.md) §2）：在线一条观察 =
> 一个可重跑的本地确定性检查；不把在线 HTTP request 当 L1 task，不拿在线
> durationMs/bytes 与 L1 p95/tokens 硬比。下表是映射登记，**不是**已执行的测试结论。

| 反馈项 | 半在线检查（契约/属性） | 对应现有测试类 / 缺口 | 当前映射状态 |
|---|---|---|---|
| F1 `content` 混入下载提示 | **byte-exact roundtrip**：`read → patch → write → readback` 逐字节相等；`content` 不含 `successfully downloaded`；sha 从提示提取 | [`SEMI-ONLINE-GAPS.md`](./SEMI-ONLINE-GAPS.md) T1 / T3；`tests/online-gap-regression.test.js` | 代码层已修，**待部署验证** |
| F2 PR `number` 为内部 ID | **canonical PR number**：`number` 取 URL 中的 PR 号，`id` 仅字符串保留、绝不回退为 number | T3 canonical real-shape PR fixture；`normalizePrResult` 定向测试 | 代码层已修，**待部署验证** |
| F3 并发批处理包装不统一 | **batch wrapper contract**：统一解包层级；失败槽结构一致（`{ok:false,value}`）；调用方不解错层 | T2/T5（`safeAll`/`unwrap` 契约）；`docs/HANDOFF.md` 的 safeAll 槽位说明 | `needs-repro` |
| F4 大返回整块截断 | **truncation metadata**：截断必须有显式标记与 limit/original；不得静默丢弃末尾关键字段 | T3 real-shape + T5 硬停；`docs/ledger/batch-11-truncation.md` | `needs-repro` |
| F5 多文件逐文件提交 | **atomic multi-file write**：N 文件一次提交；失败零落盘；dryRun 零字节 | T5 write safety；`tests/b11-write-transaction.test.js` | `needs-repro` |
| F6 CI 轮询碎 | **waitForPrChecks/CI helper**：一次等待拿到结果，避免 3–4 轮手工轮询 | [`SEMI-ONLINE-GAPS.md`](./SEMI-ONLINE-GAPS.md) N6（Actions-log/CI lane，需真实 CI run，本批不联网） | `unknown` |

不可比项（明确列出，不硬比）：在线单 HTTP 调用的 `durationMs` ≠ L1 `p95LatencyMs`；
capture `response.bytes` ≠ `tokensPerTask`；在线无 completion/searchHit/toolHit 标签；
客户端未给 requestId，全部 `captureVerified:false`。

---

## 下一步（哪些已由 `codemode-ergonomics` 修，哪些需部署后在线复验）

> 以下按任务给定的修复批次名 `codemode-ergonomics` 归类。**本仓库 checkout 目前未出现
> 名为 `codemode-ergonomics` 的批次文档**；因此这里只按「任务声明该批次修了哪些项」
> 记录归属，**不虚构该批次的 PR/提交/文件内容**。归属若与实际批次不符，由 lead 更正。

### A. 据任务声明，已由 `codemode-ergonomics` 修复（代码层）——须部署后在线复验

- **F1**：下载提示混入 `content`（状态 `fixed 代码层` → 在线 **待部署验证**）。
  代码层证据见 `src/result-normalize.js` 的提示剥离与 SHA 提取；复验方式：
  部署后用真实 `get_file_contents` 读文本文件，断言写回内容为纯正文、无提示行。
- **F2**：PR `number` 偶尔为内部 ID（状态 `fixed 代码层` → 在线 **待部署验证**）。
  代码层证据见 `src/result-normalize.js` 的 URL 优先取 number；复验方式：
  部署后对真实 PR 结果断言 number 来自 URL、非 DB id，并以该 number 走后续调用不失败。

> 注意：A 类「已修」仅指代码层有确定性测试支撑；因生产旧构建未部署，**现网状态未知**，
> 一律保持 `待部署验证`，直至部署窗口拿到可回放证据。

### B. 需在部署后在线复验 / 仍需复现的项

- **F3**（batch wrapper contract）、**F4**（truncation metadata）、**F5**（atomic multi-file write）：
  状态 `needs-repro`。先按上文 Reproduction 用同一 code/args/fixture 在本地复现并写确定性
  回归测试；若确认修复存在，则升级为 `fixed 代码层` 并随部署窗口在线复验。当前不假设其已修。
- **F6**（waitForPrChecks/CI helper）：状态 `unknown`。需确认目标构建是否有该 helper、
  是否真能一次等待拿到 CI 结果；需要真实 CI run（vault 凭据 + 部署窗口），本批不联网、不跑 real。
- **正面三项**（批处理省上下文 / 读写隔离 / 高频封装）：作为不变量保护，后续任何触及
  批处理、原子写、读写分层的改动都须回归确认不回退；不需要修复或部署动作。

### C. 流程约束

- 本记录不改任何代码、测试、脚本、README、其它文档或 workflows；不 commit / push / deploy。
- 不根据本报告直接改代码 / 开 issue / 合并 / 部署（`AGENTS.md`）。需修复时走
  「先写确定性回归测试 → 修 → L1 smoke / 定向测试」流程。
- requestId 一律 `unknown`，不编造；unknown 就写 unknown。

> 校验命令（本文件含说明性章节，脚本只解析 `Key: value` 元数据与 `## F<n>` 小节）：
> `node scripts/record-online-feedback.mjs docs/eval/online-feedback-2026-11-23-gemini.md`
