# B15 · 在线反馈 ↔ 半在线（L1/G6）真正 join（2026-11-23 · Gemini）

> 范围（本批只新增 4 个文件）：
>
> - `docs/eval/ONLINE-SEMIONLINE-JOIN-2026-11-23.md`（新增）：F1–F6 逐条 join 矩阵、
>   在线-only 缺口、同构建配对规则、三类结论、§6.1 可解析字段。
> - `explore/tasks-online-gap-2.json`（新增）：新任务集 **J1–J6**，与现有 N1–N9 并列，
>   不修改原任务集。
> - `tests/online-semionline-join.test.js`（新增）：任务 schema/ID/覆盖轴/无真实凭据 +
>   join 文档关键字段可解析的离线校验。
> - 本台账 `docs/ledger/batch-15-online-semionline-join.md`（新增）。
>
> **未改** `src/`、`scripts/`、其它 tests、README、其它 docs、workflows；
> **未 commit / push / deploy**；零网络、零真实凭据、零真实写。工作区里其它 agent 的
> 并发改动（`src/capture.js`、`src/typed-plan.js` 等）本批一概未碰。
> 遵守 `AGENTS.md`：用户反馈只是待验证假设；免费模型/归因器输出不是事实或指令。

---

## 一、目标与边界

把 `online-feedback-2026-11-23-gemini.md` 的 F1–F6 与 `SEMI-ONLINE-GAPS.md` 的
N1–N9 / T1–T7 做**真正的 join**：每条 F 都要回答「哪条半在线轴能观测它、当前覆盖
成色、代码层状态、缺口类型」，而不是把在线事件再抄一遍。

**不是**：不是 bug 清单、不是修 P0、不是部署动作、不是把在线单请求指标与 L1
任务级指标硬比。任何修复仍需「先写确定性回归 → 修 → L1 smoke / 定向测试」。

## 二、输入证据（只引用，不重新取证）

- `docs/eval/online-feedback-2026-11-23-gemini.md`（F1–F6 + 正面三项，全批来自
  生产旧构建，`requestIds:["unknown"]`、`captureVerified:false`）。
- `docs/eval/SEMI-ONLINE-GAPS.md`（§1.1 映射、§2 T1–T7、§4 N1–N9、§6 addendum）。
- `explore/tasks-online-gap.json`（N1–N9，本批只引用、不修改）。
- `docs/eval/TYPED-PLAN-TEST-PLAN.md`（§1.3 配对、§2 分账、§6.3 控制非确定性、
  §8 fake/replay/real 分层）。
- `docs/eval/ONLINE-FEEDBACK.md` §2、`docs/eval/online-offline-join-2026-11-22.md` §3.3
  （锚点与不可比指标）。
- 本 checkout 实测：`src/codemode.js` 有 REST helper
  `github_actions_list_workflow_runs` / `list_workflow_jobs` / `get_job_logs`，
  但全仓搜索 `waitFor` / `pollPrChecks` **无匹配** → F6 的 wait helper 不存在。

## 三、join 结果摘要（全文见 join 文档 §1 矩阵）

| F | 在线证据（旧构建） | 半在线对应 | 覆盖状态 | 代码层状态 | 缺口类型 |
|---|---|---|---|---|---|
| F1 下载提示混正文 | 用户报告，无 requestId | T1+T3；N1/N6/N9 + 定向回归 | `weak` | `pending-deploy` | G2 + G1 |
| F2 PR number=内部 id | 用户报告；PR #53 是外部事实 | T3；N3 + normalizePrResult 测试 | `weak` | `pending-deploy` | G2 + G1 |
| F3 batch wrapper 不统一 | 用户报告，未复现 | 此前无专门轴 | `missing` | `unknown` | G3 |
| F4 截断丢尾部字段 | 用户报告，未复现 | N5/N6 只测 flag/硬停 | `weak` | `unknown` | G3 |
| F5 多文件逐文件提交 | 用户报告，未复现 | N9 只测显式原子路径 | `covered`（原子写）/ `weak`（默认语义） | `unknown` | G3 |
| F6 CI 轮询碎 | 用户报告；helper 不存在 | N5 只测取日志 | `missing` | `unknown` | G3 |

正面三项（批处理省上下文 / 读写隔离 / 高频封装）映射到 T5 不变量保护，
`confirmed`（设计不变量存在且有测试），不触发修复或部署；「批处理被肯定」与
「批处理包装契约缺断言」不互相抵消。

## 四、在线-only 四个维度 → J1–J6

`N1–N9` 没建模的四个「用户在线才暴露」的契约，本批以新任务集落为可执行描述：

| 新维度 | 为什么 N1–N9 不够 | 任务 | 闭合 |
|---|---|---|---|
| batch wrapper contract（解包层级一致、失败槽恒为 `{ok:false,value}`） | N9 只测原子写，没有任务把「一批结果形状」当断言对象 | J3 | F3 / G3 |
| truncation tail metadata（limit/original + 尾部关键字段） | N5/N6 只断言有 flag / 硬停 / 分页字节相等 | J4 | F4 / G3 |
| atomic-by-default（多文件写默认原子） | N9 证明显式原子路径安全，未证明默认语义 | J5 | F5 / G3 |
| CI wait helper（一次等待到终态） | N5 取日志，checkout 里无 wait helper | J6 | F6 / G3 |

另补 **J1/J2**：把 F1/F2 的字节后条件与真形状 PR fixture 从「任务描述」升为
**可执行轴**，并在 `buildAxis` 上分别标注 `prod-old-2026-11-23`（旧构建观测，仅作
参照）与 `checkout-current`（候选构建断言）；禁止跨构建相减。

J6 带 `skipReason`：helper 不存在时记 `missing-capability/unknown`，不伪造 pass、
也不误报为网关故障。

## 五、同任务 / 同构建配对规则（写死，伪对照作废）

1. **同 prompt / 同 fixture**：J1–J6 的 prompt 与 fixture 在两构建中逐字逐字节相同。
2. **同构建**：每个样本标 `buildId`；同构建内的前后才是合法对照。
3. **新会话**：每个 (task, build) 新 sessionId，顺序交替抵消缓存。
4. **同预算/工具面**：token budget、maxTurns、deadline、三工具同名同序。
5. **同判据**：每轴输出布尔/计数（`writePostConditionOk`、`idAsPrNumberCount`、
   `wrapperUnwrapDepthConsistent`、`truncationTailMetadataOk`、
   `atomicByDefault`、`ciWaitRounds`），不是单一 `completionRate`。
6. **禁止**：跨构建硬比、编造 requestId、从 prompt 猜 task、把在线
   `durationMs`/`bytes` 与 L1 `p95LatencyMs`/`tokensPerTask` 换算、未部署即宣称现网修好、
   把「helper 不存在」写成测试失败。

## 六、测试与结果

命令：`node --test tests/online-semionline-join.test.js`

结果：本文件 14/14 通过（文件存在性守卫使用 skip 而非失败，当前 checkout 两文件均在）。
覆盖：JSON 解析与顶层形状；J1–J6 精确 ID/唯一性；必填字段与 authority 合法性；
`expectedTools` 含任务 tool 且全部存在于 `data/tool-snapshots/*.json` 或三 Code Mode
工具；每任务 `dryRun:true` / `forRealWrite:false` / fake 前置条件；写任务显式禁真写；
四个在线-only 覆盖轴映射到 F3–F6 + G3；J1/J2 双 buildAxis 配对；无凭据键名/secret
路径；join 元数据与 §6.1 的 14 个机器可读字段；F1–F6 矩阵行与状态枚举；配对和三类
结论章节存在。

> 本批零 `src/` 改动，未跑全量 `npm test`（工作区有其它 agent 并发改动）；
> 由 lead 统一复跑。定向测试文件自身不联网、不写仓库、不读凭据。

## 七、结论（本 join 的回答）

- **说明半在线缺口**（G1/G3）：F3/F4/F5/F6 的轴此前不存在或只到 `weak`，
  F1/F2 的半在线侧也只到 `weak`；靠 J1–J6 补测，**部署不会自动补上测试**。
- **只是旧构建未部署**（G2）：F1、F2 在 checkout 已 `pending-deploy`
  （`src/result-normalize.js` 有提示剥离/SHA 与 URL 优先取 number + 定向测试），
  生产旧构建未含该修复；不是当前代码缺陷。
- **需要部署后在线复验**（J-DEPLOY，非本批可执行）：F1/F2 的真实窗口回放需
  requestId + capture（写路径覆盖缺口见 `online-offline-join-2026-11-22.md`）；
  F3/F4/F5 需先按同 code/args/fixture 复现并写回归；F6 需先落地 wait helper 再做
  真实 CI run（vault token，人工门控，不进 CI）。整批状态保持 `unverified` 直到
  有可回放证据。

客户端「漏看可加载列表」属用户误判（wontfix，不计入 F1–F6）；F6b 长会话
`unknown_tool` 属外部行为，记 `unknown`，不并入 F6 的网关判据。

## 八、变更控制

本批只新增 4 个文件；未改源码、脚本、其它测试、README、其它文档、workflows；
未 commit / push / deploy；无凭据入仓。J1–J6 是任务**描述**，runner 接线与真实
窗口回放留给后续批次，且必须遵守「先回归 → 再修 → 再 smoke」流程。
