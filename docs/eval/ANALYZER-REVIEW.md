# Analyzer Review Checklist（免费模型建议的人工闸门）

> 任何来自 `scripts/analyze-captures.mjs` 的 issue，在变成代码改动前必须逐项通过。

- [ ] `advisoryOnly === true` 且 `requiresHumanReview === true`；
- [ ] 每条 issue 的 `evidenceEventIds` 都能在 R2 找到对应 envelope；
- [ ] 用同一 `code` / `args` / fixtures 在本地复现，失败现象与 capture 一致；
- [ ] 能区分是 gateway、upstream、model 还是 data 问题，不靠猜；
- [ ] 先写确定性测试/回归任务，再改代码；
- [ ] 改完跑 `npm test` + 相关 L1 smoke/G6；
- [ ] 由 lead/人确认后才合并、部署；
- [ ] 证据不足或复现不了的，直接在 `ignored`/issue 里关闭，不进入 backlog。

**禁止**：模型建议直接生成 PR、自动合并、自动改生产配置、自动开 issue 后当任务执行。
