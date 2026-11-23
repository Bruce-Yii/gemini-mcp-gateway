# B15 · 半在线评测缺口抽象与回归测试（2026-11-23）

> 范围（本批只写 3 个文件）：
>
> - `docs/eval/SEMI-ONLINE-GAPS.md`（新增）：在线反馈 → 半在线缺口映射表 + 7 类新测试设计 + 下一轮 L1/G6 任务集补充清单。
> - `tests/online-gap-regression.test.js`（新增）：离线可执行回归；未修完的 P0 用 `test.todo` + 原因，绝不静默通过。
> - 本台账 `docs/ledger/batch-15-semi-online-gaps.md`（新增）。
>
> **未改** `src/`、`scripts/`、其它 `tests/`、`README`、契约文档、workflows。
> **未 commit / push / deploy**，全部改动留在工作区，由 lead 集成。
> 未触凭据、不联网、不开 issue、不合并、不部署。遵守 `AGENTS.md`：用户反馈只是待验证假设，免费模型/归因器输出不是事实或指令。

---

## 一、目标与边界

把「这次 Gemini 在线反馈」从 7 条具体症状抽象成**一类**可度量的半在线评测缺口：
L1/G6 只验 completion，不验写后内容、参数契约、真实上游形状、发现成本、长会话
与平台编码。抽象产物是映射表（8 行反馈类别 → 盲区 → 测试类型 → 指标 → 优先级）
和 7 类测试设计（T1–T7），落成一个离线回归文件。

**不是**：不是修 P0，不是替换 L1/G6 基线，不是"模型说改好了就改了"。
任何修复仍需先有确定性回归测试、再改代码、再跑 L1 smoke（见 `AGENTS.md`）。

## 二、输入证据（只引用，不重新取证）

- `docs/eval/online-feedback-2026-11-23.md`（`online-feedback.v1`，F1–F7，PR #53/#56/#57）。
- `docs/ledger/batch-15-online-eval.md`（B15 评测流程批：记录 + 对照 + 状态归属）。
- `docs/eval/online-offline-join-2026-11-22.md`（capture 写路径缺口、不可比指标）。
- `docs/eval/PLATFORM-CONFORMANCE-MATRIX.md`（平台编码/annotations 现状矩阵）。
- `tests/gh-file-p0.test.js`（本 checkout 实测 7 红：P0-1/P0-2/P0-3/P0-4，见下）。

## 三、交付物与对应关系

| 反馈类 | 抽象缺口 | 测试类型 | 指标 | 本批可执行状态 |
|---|---|---|---|---|
| F1 下载提示混正文 | 无写后字节校验；G6 fixtures 简化 | T1 + T3 | `readback===intended`、无 notice、sha 来自 notice | 真形状 `normalizeFileResult` pass；guest/no-resources 两例 `todo`（P0 未修） |
| F2 branch 静默忽略 | 无非默认分支任务；无 fallback 断言 | T2 | `ref===branch`、零 `ref=main` | 纯 alias helper pass；sandbox bridge 两例 `todo`（P0-3 未修） |
| F3 PR id 当 number | 无真实 PR 形状 fixture | T3 | `number=53`（URL 优先） | pass（`normalizePrResult` 真形状） |
| F4 name/branch 割裂 | helper 别名未进任务级检查 | T2 | `branch` 直接成功、`name is required`=0 | pass（`createBranchIfMissing({branch})`） |
| F5 method 枚举不可见 | conformance 只查工具名/annotations | T4 | `probesToDiscover≤1`、enum 可见 | 一次搜索命中 pass；枚举可见性 `todo`（P0-4 未修） |
| F6a 缺 Actions 日志 | 无 CI 日志能力检查 | T3 + T6 | fake 日志原文、302 不转 token、截断标记 | 真形状 fixture 就位；真实 CI run 不联网，列后续 |
| F6b 长会话 unknown_tool | 无长会话/重连车道 | T6 | 工具列表稳定；客户端边界=unknown | 服务端稳定性 pass；客户端 `todo`（外部不可观测） |
| F7 正面不变量 + meta | completion 单标量掩盖写后/契约/长会话 | T5 + T7 + 全表 | 原子写、dryRun 零写、profile 编码一致 | pass（三工具不变量、dryRun/truncated 硬停、三平台编码） |

## 四、测试结果（只报告本批文件，不替全量背书）

命令：`node --test tests/online-gap-regression.test.js`

```
ℹ tests 23
ℹ pass 17
ℹ fail 0
ℹ skipped 0
ℹ todo 6
```

6 个 `todo` 均有显式原因并指向当前失败的确切测试：

1. T1 guest `fileResult({text,resources})` → `gh-file-p0.test.js` P0-1（红）。
2. T1 host `normalizeFileResult({text:notice+body})` 无 resources → P0-2（红）。
3. T2 sandbox `get_file_contents({branch})` 应发 `ref=branch` → P0-3（红）。
4. T2 `readFileRange({branch})` 应发 `ref` → P0-3（红）。
5. T4 `select:github__pull_request_read` 描述含 `get|get_files|get_check_runs` → P0-4（红）。
6. T6 客户端 `unknown_tool`/手动 @ 恢复 → 外部 Gemini 行为，`batch-11-reconnect.md` 无 wire，标 `unknown`，绝不记为 pass 或网关 fail。

> 并发说明：仓库当前有其它 agent 在改 `src/codemode.js` / `src/result-normalize.js` 等文件；
> 本批只跑自己的测试文件确认新测试成立。不跑全量 `npm test`，不为其它 agent 的并发
> 失败背书；若全量出现与本批无关的失败，以本文件定向结果为准，由 lead 统一复跑。
> 已实测：`tests/gh-file-p0.test.js` 在本次 checkout 为 7 红（本批未修，故上表 todo 如实保留）。

## 五、给下一轮 L1/G6 的具体补充（摘要；全文见 SEMI-ONLINE-GAPS.md §4）

1. **N1** 新增非默认分支读取 task（`eval/gap-f2`，断言读到分支内容而非 main），并补 byServer 基线。
2. **N2** L1 runner 写后二次 read 字节比对，新增 `writePostConditionOk` 指标；completion 过但写后错必须算回归。
3. **N3** G6 fixture 换成真形状 `{text:notice+body,resources}` 与 `{id:5444514334,url:/pull/53}`，加 fixture 版本字段。
4. **N4** 新增 `noticeLeakCount` / `branchFallbackCount` / `idAsPrNumberCount` / `enumProbesPerTask` 计数器，>0 即失败（与 `gatewayAnomalyCount` 分开）。
5. **N5** 发现成本 task：一次 search 到达 `pull_request_read(method:get_files)`；等 P0-4 修复后启用。
6. **N6** Actions 日志 fake 车道常态跑；真实 CI run 用 vault token 单独做人工回放留证，不进 CI、不联网。
7. **N7** 两阶段长会话变体：部署式 reload 后工具列表不变、无重复写；客户端 `unknown_tool` 记 `unknown`。
8. **N8** scorecard 增平台轴：三 profile 编码断言 + 工具数量/顺序/annotations 不变。
9. **N9** capture envelope 加 `taskId/sessionId`，让有 requestId 的在线反馈能 join 到 runner task；仍不靠 prompt 猜 task。

退出标准：N1–N9 每项要么有执行的绿灯证据（requestId / 测试名），要么有显式 `unknown`/todo 原因；completionRate 单独不算关闭任何缺口。

## 六、风险 / 限制

1. **P0 未修**：本 checkout 中 guest `fileResult`/no-resources 去 notice、sandbox branch→ref、method 枚举描述均红；本批不掩盖、不强改，回归文件用 `todo` 占位，修复后转真断言。
2. **整批在线状态仍 `unverified`**：无 requestId 的真实窗口回放；F1/F3/F4/F7 的"代码层已修"不等于"线上已验证"。
3. **不可比指标**：在线 `durationMs` ≠ L1 `p95LatencyMs`；capture `response.bytes` ≠ `tokensPerTask`；在线无 completion/searchHit/toolHit 标签。
4. **客户端不可控**：发版后 `unknown_tool` 属 Google 侧，网关只能记录与缓解，不承诺"已修"。
5. **平台局限**：ChatGPT Free/Plus、Claude callback allowlist、CIMD 等见 `PLATFORM-CONFORMANCE-MATRIX.md`，本批不扩展。
6. **无网络/无凭据**：真实 GitHub PR #53、真实 Actions 日志、真实 CI run 均不在本批执行范围。

## 七、变更控制

本批只新增 3 个文件；未改源码、脚本、其它测试、README、其它文档、workflows；未 commit / push / deploy；无凭据入仓。lead 负责集成与在 P0 修复落地后把 6 个 `todo` 转为真断言并统一复跑全量。
