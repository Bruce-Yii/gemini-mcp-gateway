# B15 · 在线 ↔ 半在线持续迭代检查（continuous eval cycle）

> 范围（本批只新增 4 个文件）：
>
> - `scripts/eval-cycle.mjs`（新增）：一条命令跑 fake L1 + online-gap profile、
>   replay fixture、join 覆盖审计、docs artifact 检查、只读 baseline 对比；
>   写时间戳 JSON/MD 报告，默认不覆盖旧报告。
> - `tests/eval-cycle.test.js`（新增）：纯函数/注入式 fake 测试，确定性、离线。
> - `docs/eval/CONTINUOUS-EVAL.md`（新增）：怎么跑、CI 可选接入、什么算持续迭代、
>   人工 intake 边界。
> - 本台账 `docs/ledger/batch-15-continuous-eval.md`（新增）。
>
> **未改** `src/`、其它 scripts/tests、README、workflows、`explore/` 任务集、
> `explore/baselines/*`、其它 docs；**未 commit / push / deploy**；不接定时器、
> 不联网、零真实凭据、零真实写。工作区里其它 agent 的并发改动一概未碰。

---

## 一、目标

把 `ONLINE-SEMIONLINE-JOIN-2026-11-23.md` 的“一次性 join 文档”升级成可重复运行的
检查：每次改动后同一条命令就能重新核对 F1–F6 覆盖、J1–J6 / N1–N9 任务存在性、
replay 管线与 docs artifact，并产出可与上一轮比较的签名报告。

## 二、实际执行内容

| 阶段 | 做法 | 关键不变量 |
|---|---|---|
| L1 fake + online-gap profile | 复用 `run-l1-smoke.mjs` 的 `fakeMetrics` / `loadOnlineGapTasks` / `computeOnlineGapMetrics`；不调用会写固定路径的 `runOnlineGapProfile()` | fake 只验管线，不是质量测量 |
| replay fixture | 复用 `replay-online-session.mjs` 的 `createFakeSession` → `buildReplayPlan` → `replayPlan` → `diffReplay`；默认 offline stub | 写强制 dryRun；unknown requestId 不伪造；宿主/模型字段 not-comparable |
| join 覆盖 | 从 join 文档解析 F1–F6 的 covered/weak/missing；核对 N/J 任务 id | unknown/SKIP/缺失 id 永不算 pass（缺 id = FAIL，weak/missing = 显式 INFO） |
| docs artifact | 检查 join/gaps/feedback 文档、两个任务集、本批两个新文档存在且含预期标记 | 缺失即 FAIL |
| baseline | 只读 `explore/baselines/*` 与上一轮 `eval-cycle-*.json` 的 signature；schema 不同的冻结 L1 指标记为 `REFERENCE` | DRIFT/NO_BASELINE 显式但不 fail；baseline 永不写回 |

## 三、产物与退出语义

- 报告：`docs/eval/eval-cycle-<ISO 时间戳>[-tag].json` / `.md`，独占创建（`wx`），
  不覆盖历史；同一时间戳+标签重跑会失败，而不是静默覆写。
- 退出码：`0` 无 FAIL；`1` 有 FAIL；`2` CLI 输入错误。
- 当前 checkout 没有 `explore/baselines/l1-online-gap.json`，首轮 `NO_BASELINE`
  是预期结果，必须显式打印，不能解读为质量门禁通过。

## 四、人工边界与不变量

- 在线反馈 intake 仍靠人工按 `ONLINE-FEEDBACK.md` 登记；cycle 不产生新 F 条目，
  不把用户报告/模型建议当事实或指令。
- 生产是旧构建且未部署；禁止跨构建硬比、禁止宣称现网已修好。
- 不新增 workflow / schedule；“持续迭代”= 改动后反复人工或既有 CI 触发同一条命令，
  每轮留不可覆盖的报告与可比较签名。
- 部署后 J-DEPLOY 在线复验、requestId/capture 证据、vault 凭据均不在本命令范围。

## 五、验证

- `node --test tests/eval-cycle.test.js`（纯函数 + 注入式 fake，离线、确定性）。
- `npm test` 全量绿（以 lead 最近一次全量结果为准；本批新增测试只增不减）。
- CLI 本地验证：`node scripts/eval-cycle.mjs --now <固定时间> --tag local`，检查
  报告双文件生成、stdout 含 baseline 状态、退出码 0（无 FAIL 时）。
