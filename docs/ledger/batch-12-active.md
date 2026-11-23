# B12 — Active parallel dispatch (2026-11-23)

> 状态：**执行中**。本页是当前批次的任务板；无日历排期，完成即集成。
> 所有 agent 均禁止 commit/push/deploy；lead 统一 review、全量测试、部署。

## 当前并行 agent

| Agent | 目标 | 写入范围 | 验收 |
|---|---|---|---|
| `project-tag-core` | capture 派生 `projects[]` / `primaryProject` | `src/project-tag.js`、`src/capture.js`、`tests/project-tag.test.js`、`docs/ledger/batch-11-project-tag.md` | 真实 recruitment-agent fixture 可抽；多 repo/去重；全量测试 |
| `project-tag-eval` | digest/analyzer/join 按项目聚合 | `scripts/capture-digest.mjs`、`scripts/analyze-captures.mjs`、`scripts/join-online-offline.mjs`、`tests/project-rollup.test.js`、`docs/ledger/batch-11-project-rollup.md` | 跨 3 session 同项目合并；byProject 时间线；join project 匹配 |
| `l1-regression` | 调查冻结基线后的 L1 real regression | `docs/eval/l1-real-regression-2026-11-23.md` | 拆分 notion/vercel 上游失败 vs search 回归；给证据/下一步 |
| `docker-verify` | 真实构建/运行 Docker | `docs/OPEN-SOURCE/DOCKER-VERIFICATION.md`，必要时 Docker 文件 | 容器启动、TCP health、`/mcp` 可达、无 token 入镜像 |
| `oss-export-verify` | 跑 export staging + 干净 clone 测试 | `docs/OPEN-SOURCE/EXPORT-VERIFICATION.md`，必要时 export 脚本 | staging 无禁带文件；`npm ci/test/audit` |
| `project-llm-labeler` | 离线 LLM 项目分类（advisory） | `scripts/classify-projects.mjs`、tests、`docs/ledger/batch-11-project-llm.md` | schema/低置信度/无 repo/多 repo；不覆盖原始标签 |
| `client-adapter` | Gemini/Claude/ChatGPT 结果编码 profile | `src/client-profile.js`、`src/server.js`、`src/codemode.js`、tests、`docs/ledger/batch-11-client-adapter.md` | 默认 Gemini 逐字节兼容；Gemini 无 structuredContent；ChatGPT 双编码 |
| `design-backlog` | 持久状态 / 自适应 Code Mode / Figma 跨实例缓存 | 3 个 `docs/ledger/batch-11-*.md` | 每项有现状/方案/收益风险/验收/不做 |\n| `gh-feedback-fixes` | 分支别名 `branch`、PR `number` 修正、GitHub Actions 只读日志 helper | `src/github-helpers.js`、`src/result-normalize.js`、`src/codemode.js`、tests、ledger | 真实 PR id/number 场景；helper 不新增工具面；全量测试 |\n| `reconnect-research` | 发版后旧会话重连缓解方案（只读） | `docs/ledger/batch-11-reconnect.md` | 明确网关不能强制客户端，给可行缓解 |

## 当前已完成（本轮之前）

- `l1-baseline`：冻结 per-server 基线，修 `baseline === current` 自引用；669/669。
- `deep-*`：agentgateway / Bifrost / Cloudflare / toolgate / gemini-bastion 源码级报告；排行榜已修正。
- `docker-runtime`：真 Dockerfile/compose/`--host`。
- `oss-export`：allowlist 导出脚本。
- `readme-oss-reframe`：README 优化定位。
- capture 诊断：`mcpMethod/mcpTool/sessionId` 已进 ack/skip 日志（`3fa7a53`）。

## 阻塞/不派

| 项 | 原因 |
|---|---|
| `taskId` 显式锚点 | 等 `project-tag-core` 完成，避免同时改 `capture.js` |
| capture 同步延迟优化 | 同上，避免 capture 双改 |
| 真实掉线会话复测 | 等用户 new window / 重新 @ 网关 |
| W4 Gemini 自适应实现 | 先由 `design-backlog` 出方案；等真实数据 |
| MCP 2026 实现 | 故意暂缓，等客户端升级 |
| 多文件写事务 | 已由 `write-transaction` 完成（`00b62bf`） |

## 集成顺序

1. 项目 tag core + eval（先 core 后 eval 合）；
2. L1 regression 报告（只读，不改代码）；
3. Docker/export 验证；
4. client adapter + LLM labeler；
5. 全量测试、CI、部署；
6. 更新 B11.1/B12 与本页状态。
