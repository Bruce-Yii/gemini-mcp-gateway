# B9 · L1 smoke 升级：每日 fake + 每周 real（Figma 跳过，不烧配额）（2026-11-23）

> 批次 9 子项。只改 workflow / runner / 测试 / 文档，不碰 `src/`、`explore/`、`package.json`、`README`、`CHANGELOG`。
> 不 commit / push / deploy，改动留工作区。

## 一、决策（DEC）

| 项 | 决策 | 理由 |
|---|---|---|
| 每日调度 | 保留原 cron `0 18 * * *`，跑 fake | 原行为不变，零凭据、零网络、零配额 |
| 每周调度 | 新增 cron `0 18 * * 1`（周一 02:00 SGT），跑 real | 真实回归有固定节奏，不靠手动 |
| 手动 | `workflow_dispatch` 显式 `fake\|real` | 便于排障/复跑 |
| Figma | real 默认排除（`--servers github,notion,linear,vercel`） | Figma Starter 配额有限；跳过记 skipped，不记 failed |
| real 产物 | `docs/eval/l1-real-YYYY-MM-DD.md` / `.json`，按日期保留 | 历史可追，不被每日 fake 覆盖 |
| 失败语义 | 单次 real 失败仍 exit 1；ALERT 需连续两次失败 | 不掩盖回归，也不把免费模型抖动误报成告警 |
| 基线 | real 跳过 Figma 时从 G6 结果派生 40-task 同集合基线 | 40-task 实测对 40-task 基线，计数指标才可比 |

## 二、改动文件与收益/风险

| 文件 | 收益 | 风险（已识别） |
|---|---|---|
| `.github/workflows/l1-smoke.yml` | 双 schedule + dispatch 模式解析；real 注入免费模型 key 与 4 上游 secrets；无 Figma 凭据；artifact `if: always()` 保留 30 天 | `GITHUB_TOKEN` 为 Actions 默认 token，权限依赖仓库设置；cron 为 UTC，需按 SGT 换算 |
| `scripts/run-l1-smoke.mjs` | 新增 `parseArgs` / `resolveMode` / `selectTasksByServers` / `realReportPaths` / `evaluateConsecutiveAlerts` / `deriveBaselineForServers`；real 写日期报告与状态文件 | 派生基线依赖已提交的 `explore/results/*.json`；若 G6 结果被清理需回退到固定基线 |
| `tests/l1-smoke.test.js` | +11 测试：workflow 静态校验、参数解析、周模式选择、server 过滤、报告路径、基线派生、ALERT 状态机、fake 端到端 | 静态测试绑 Workflow 文本结构；改注释/格式可能需同步测试 |
| `docs/eval/L1-SMOKE.md` | 运行前提、secrets、Figma 跳过、免费模型波动、fake/real 分工 | 文档与实现需同步维护 |
| `docs/ledger/batch-9-l1-real.md` | 本文件，记录决策与证据 | 无 |

## 三、实施细节

1. **Workflow 模式解析**：单个 `Resolve smoke mode` step 依据 `github.event_name` / `github.event.schedule` / `inputs.mode` 输出 `mode` 与 `date`；两个运行 step 用 `if: steps.resolve.outputs.mode == 'fake'|'real'` 选择。周模式由 cron 第 5 字段 `1` 判定。
2. **Figma 排除**：real step 执行 `node scripts/run-l1-smoke.mjs --mode real --servers github,notion,linear,vercel --date "$L1_DATE"`；脚本把 allow-list 传给 `run-explore.mjs` 的 `EXPLORE_SERVERS`，Figma 10 个 task 不进入执行集，报告中 `skippedServers: ['figma']`。**没有任何 Figma 凭据注入**。
3. **报告与基线**：real 报告写入 `docs/eval/l1-real-<date>.md/.json`；比较基线由 G6 全量结果按相同 task id 过滤得到（40 task，Figma excluded），阈值沿用 `explore/baselines/l1-smoke.json`。失败退出 1，artifact 仍上传。
4. **ALERT 状态机**：`docs/eval/l1-real-state.json` 持久化 `consecutiveFailures`；通过清零，两次连续失败标 ALERT。单次失败只写 "single red — no ALERT yet"，但仍 exit 1。
5. **fake 报告路径**：为避免与本文档 `L1-SMOKE.md` 在大小写不敏感文件系统上冲突，生成的 fake markdown 改为 `docs/eval/l1-smoke-report.md`（JSON 路径不变）。

## 四、验证证据（本次执行）

- `npm test`（全量）：**512 passed / 0 failed**（本任务开始时基线 466；本任务新增 11，其余为并行批次新增）。
- `node --test tests/l1-smoke.test.js`：**23 passed / 0 failed**（原 12 + 新 11）。
- `node scripts/run-l1-smoke.mjs --mode fake`：**exit 0，PASS**，50 tasks，无网络/凭据；报告写入 `l1-smoke-report.md` / `l1-smoke.json`。
- 静态校验：workflow 两个 cron、`fake|real` dispatch 选项、4 上游 secrets、无 Figma secret、artifact `if: always()` + 30 天保留，均由测试断言。
- 派生基线实测（40 task，Figma excluded）：completion 77.5%、gatewayAnomalies 18、searchHit 82.4%、toolHit 53.3%、tokens/task 16547，与 50-task 基线量级一致。

## 五、遗留与下一步

- 首次真实周跑尚未发生（本任务不执行 real，不消耗免费额度）；需在下一个周一观察 `l1-real-YYYY-MM-DD.md` 与 state 文件。
- 若 `explore/results/*.json` 在后续批次被清理，`deriveBaselineForServers` 会失败；届时可把 40-task 基线固化进 `explore/baselines/l1-smoke.json` 的新 section。
- 免费模型波动只做标注，不自动开 issue / 改代码（遵循项目硬规则：模型输出是待验证假设）。
