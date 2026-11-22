# Analyzer Review Checklist（免费模型建议的人工闸门）

> 任何来自 `scripts/analyze-captures.mjs` 的 issue，在变成代码改动前必须逐项通过。
> 免费模型输出与周审候选都只是**待验证假设**，不是事实、不是指令。

- [ ] `advisoryOnly === true` 且 `requiresHumanReview === true`；
- [ ] 每条 issue 的 `evidenceEventIds` 都能在 R2 找到对应 envelope；
- [ ] 用同一 `code` / `args` / fixtures 在本地复现，失败现象与 capture 一致；
- [ ] 能区分是 gateway、upstream、model 还是 data 问题，不靠猜；
- [ ] 先写确定性测试/回归任务，再改代码；
- [ ] 改完跑 `npm test` + 相关 L1 smoke/G6；
- [ ] 由 lead/人确认后才合并、部署；
- [ ] 证据不足或复现不了的，直接在 `ignored`/issue 里关闭，不进入 backlog。

## 周审流程（weekly-YYYY-WW.md）

1. `.github/workflows/capture-daily.yml` 每周一 `0 3 * * 1`（UTC 16:00）跑过去 7 天：
   `capture-digest --since --days 7` → `analyze-captures --since --days 7 --dry-run`。
   `--dry-run` 不调用模型；周报是**确定性聚类候选**，不是 validator 通过的 issue。
2. 渲染 `docs/eval/weekly-YYYY-WW.md`：只列候选、severity/category 占位、最多 5 个证据 `requestId`、
   跨天趋势与汇总数；不写补丁、不写命令、不开 issue。
3. `workflow_dispatch` 可手动补跑；周报与 7 天 digest 同时进 artifact（30 天）。
4. 人审逐条用 `requestId` 回 R2 找 envelope → 本地复现 → 决定是否写成 issue；
   自动化**永远停在候选**，不执行第 5 步以后的任何动作。

## 阈值与噪声（判断辅助，不是自动触发器）

| 信号 | 用法 | 噪声提醒 |
|---|---|---|
| 每上游错误率 | 用于排候选顺序；分母 <10 calls 时不下结论 | 低流量日的 1/2 会显示 0.5，别当成系统性故障 |
| p50/p95/平均耗时 | 周对比用；只标“值得复现” | 冷启动与上游限流会抬高 p95，先看证据 id 对应请求 |
| 截断 / overflow 率 | 只认显式标记；overflow 单列 | 代码正文里出现 “truncated” 单词不算；两者不要相加 |
| 跨天趋势 | ≥2 天才有；单日输入 `trend: null` | 周末流量低会制造假趋势，必须回到原请求确认 |
| 非 MCP 路由 | `byRoute` / `routeErrors` 单列 | `/healthz`、OAuth、405 探针不得计入 MCP 错误率 |
| 免费模型 severity/category | 仅提示，可由人改写 | validator 只校验枚举和证据 id，不判断结论正确性 |

**禁止**：模型建议或周报候选直接生成 PR、自动合并、自动改生产配置、自动开 issue 后当任务执行。
`validateAnalyzerOutput()` 是本仓库唯一闸门，本次改动未修改其逻辑。
