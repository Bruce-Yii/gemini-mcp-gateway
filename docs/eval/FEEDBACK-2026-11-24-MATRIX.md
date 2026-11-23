# F/G/N/J 矩阵 — PR #80–#101 反馈接入离线/半在线评测（2026-11-24）

> 状态：**评测接入文档（新增）**。把 `ONLINE-FEEDBACK-2026-11-24-PR80-101.md`
> 的真实体感反馈转成**可重复回归**，而不是只写报告。
> 本批只新增/更新任务指定的文件；不改 `src/`、`scripts/`、`tests/`、其它 docs、
> workflows；不 commit / push / deploy。
>
> 证据规则（继承 `AGENTS.md` §1、§3）：
> - 反馈与免费模型/归因器输出都是**待验证假设**，不直接驱动改代码/开 issue/部署；
> - 没有 requestId 写 `unknown`，**不补造 UUID**；
> - 不跨构建硬比；`durationMs`/`bytes` 不换算 tokens；
> - 客户端宿主不可控部分记 `unknown`，不记网关 pass/fail；
> - **9 个 model truncation suspect 是 advisory**，不是事实、不作判据；
> - **20 次是已知每次执行/单轮工具调用上限**（Gemini web ~20/轮，见 `GEMINI-PROBE.md`），
>   不是 R2 list 分页 bug、不是 capture 分母 bug；样本不足，不能定量。

---

## 0. 四个字母的含义

| 列 | 含义 |
|---|---|
| **F** | Feedback item：一条真实体感反馈/被动信号（抽象后，不照抄原文） |
| **G** | Gap class：缺口分类（G1 半在线盲区 / G2 旧构建未部署 / G3 在线-only 新维度 / G4 客户端不可控 / G5 指标误用 / G6 证据链） |
| **N** | 离线任务：`explore/tasks-feedback-2026-11-24.json` 的 FB1–FB10（工具级真值 + fixture + 断言） |
| **J** | 半在线任务：`explore/tasks-online-gap-3.json` 的 N10–N16（抽象后的在线-only 轴，编号避开 N1–N9） |

「能证明/不能证明」回答：**这条在线证据在半在线里能被什么观测，以及它不能支撑什么结论**。

---

## 1. 主矩阵：F → 能证明/不能证明 → G → N → J → 验收

| F（反馈，抽象） | 在线能证明 | 在线不能证明 | G | 离线任务 N (FB) | 半在线任务 J (N10+) | 验收判据 |
|---|---|---|---|---|---|---|
| **F1** 创建类结果主键空/索引延迟/重复 | 旧构建窗口有此体感 | 当前 checkout 是否仍复现；具体 requestId | G1+G3+G6 | **FB1** issue-create-no-duplicate-number | **N10** issue-create-idempotency-and-number | 同幂等键创建 1 次；number URL 优先；空值不作成功；`requestIds:unknown` |
| **F2** PR number 取到内部 id | 用户观测到 number 失真 | 现网仍存在；PR 号为网关 capture 证据 | G1+G2+G6 | **FB2** pr-number-url-first | 交 N3/J2 已有 URL-first 轴，本批不重复编号 | number===URL 号；id 仅字符串；fake merge 指向 URL 号 |
| **F3** 文件正文混入下载注释 | 旧构建写回被污染 | 当前构建/现网仍复现 | G1+G2+G6 | **FB3** file-content-notice-separated | 交 N1/J1 已有字节回环轴 | content 逐字等于正文；无注释前缀；sha 来自注释；readback 零污染 |
| **F4** 批处理包装解包层级不一 | 观测存在（旧构建） | 当前 `unwrap/safeAll` 契约仍不一致（未复现） | G3+G6 | **FB4** batch-unwrap-uniform-depth | 交 J3 batch-wrapper 轴 | 成功槽同层同形；失败槽恒 `{ok:false,value}`；调用方不分支 |
| **F5** 多文件改写无 TS/正则预检 | 旧构建 push 后 tsc 报错 | 当前预检是否存在（未复现） | G1+G3+G6 | **FB5** ts-presubmit-check | **N11** ts-presubmit-and-patch-edit（预检半） | 无效文件 path+line 结构化错误；push 中止；零字节落盘 |
| **F6** 只能整文件 replace | 缺局部编辑体感 | 当前 `applyFilePatch` 不可发现 vs 能力缺失 | G1+G3+G6 | **FB6** patch-edit-first-class | **N11** ts-presubmit-and-patch-edit（patch 半） | 每 oldText 唯一命中；readback 逐字相等；多/零命中结构化拒绝 |
| **F7** 大返回整块截断、尾部字段丢失 | 用户观测 + scorecard 9 suspect（advisory） | 截断是网关造成（suspect 无法区分模型 slice） | G3+G5+G6 | **FB7** truncation-structured-metadata | **N12** truncation-advisory-separation；补 J4 tail-metadata 轴 | `{truncated,limit,original,tail,next}` 齐全；尾字段有着落；suspect 计数不改判据；截断即硬停 |
| **F8** CI 反复轮询 + 不能 rerun | 旧构建多轮往返、无法重跑 | 目标构建是否有 wait/rerun helper | G3+G6 | **FB8** ci-rerun-and-wait | **N13** ci-wait-and-rerun-helper（扩展 J6：wait+rerun） | ciWaitRounds===1；失败 job rerun 1 次；302 不转 token；无 helper 记 unknown |
| **F9** 重命名两次 commit | 旧构建非原子重命名 | 当前 push_files 是否支持 delete/rename（未核验） | G1+G3+G6 | **FB9** delete-rename-atomic | **N14** delete-rename-atomic-commit | 单 commit；注入失败零落盘；partial/written/remaining/compensation 齐全 |
| **F10** 合并后不删源分支 | 流程缺口体感 | 能力是否存在（`deleteBranch` 存在但未默认接入） | G1+G3+G6 | **FB10** branch-cleanup-after-merge | **N15** branch-cleanup-after-merge | 成功后删 1 次；失败删 0 次；ref 来自 canonical PR |
| **Meta** 反馈/scorecard 归因与分母 | 20 请求 / 9 suspect / p95 5153ms 的事实 | 不能当全量分母、不能当定量、不能跨构建硬比 | G5+G6 | 全部任务 `requestIds:unknown` | **N16** feedback-evidence-chain | 不造 UUID；20 记为执行上限；suspect 标 advisory；同构建配对 |

---

## 2. 缺口分类字典（沿用 `ONLINE-SEMIONLINE-JOIN-2026-11-23.md` §2）

| 代码 | 本批含义 |
|---|---|
| **G1** 半在线盲区 | 现有任务/回归不观测该属性（只看 completion 或纯函数），本批用 FB 任务补断言点 |
| **G2** 旧构建未部署 | 代码层可能已修但生产旧构建未含；本批不声称现网修好，留待部署后在线复验 |
| **G3** 在线-only 新维度 | 半在线此前没有该轴（issue 幂等、预检、patch、CI rerun、delete/rename、branch cleanup）→ N10–N15 |
| **G4** 客户端/上游不可控 | Gemini 单轮 ~20 次上限、客户端弹窗等记 unknown，不记网关 pass/fail |
| **G5** 不可比指标/信号误用 | 9 model truncation suspect = advisory；20 次 = 执行上限非分母 bug；durationMs/bytes 不换算 |
| **G6** 证据链断裂 | 全批无 requestId，写 unknown；同构建配对，禁止跨构建硬比 |

---

## 3. 为什么 20 次不是 capture 分母 bug（修正旧推断）

旧 `ONLINE-FEEDBACK-2026-11-24-PR80-101.md` 曾推断「20 很可能是 R2 list 上限」。
**该推断已废弃**：用户确认一次执行确实只能 20 次，且以前就有测试上限记录
（`docs/GEMINI-PROBE.md` 记 Gemini 单轮约 20 次工具调用上限，客户端侧，非网关）。
因此：

- 20 = 已知每次执行/单轮工具调用上限，不是 R2 分页 bug，不是 capture 分母 bug；
- 被动 scorecard 的 20 请求 / 10 工具调用是**有限样本**，样本不足、不能定量；
- 保留结论「被动数据支持方向，不支持定量结论」，但归因从「分母不可靠」改为「样本受执行上限约束」；
- 9 个 truncation suspect 标 advisory，不能当网关事实；与「不能定量」一致。

---

## 4. 闭环（本批落实的部分）

```text
PR80-101 反馈
  → F/G/N/J 矩阵（本文）
  → 离线任务 FB1–FB10（工具级真值 + fixture + 断言）
  → 半在线任务 N10–N16（抽象在线-only 轴，避开 N1–N9）
  → L1 smoke online-gap profile 接线检查（结果见 batch-17 ledger）
  → 待部署后：同任务在线复验 + 更新 join / baseline（不在本批）
```

本批不执行真实窗口、不开 issue/PR、不改代码、不部署；FB/N10+ 均为 fake/replay 任务描述，
其「验收判据」是任务 runner 落地后要输出的断言，不是当前已通过的测试结果。

---

## 5. 索引

- 离线任务集：`explore/tasks-feedback-2026-11-24.json`
- 半在线任务集：`explore/tasks-online-gap-3.json`
- 半在线缺口登记：`docs/eval/SEMI-ONLINE-GAPS.md`（§8 N10–N16）
- 原始反馈：`docs/eval/ONLINE-FEEDBACK-2026-11-24-PR80-101.md`
- 总览：`docs/EVALUATION.md`
- 台账：`docs/ledger/batch-17-feedback-eval.md`
