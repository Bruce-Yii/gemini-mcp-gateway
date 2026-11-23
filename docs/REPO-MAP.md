# REPO-MAP — 文件到六模块的映射

> 逻辑映射，不代表文件已经物理移动。
> 目标结构见 [REPO-STORAGE-PLAN.md](REPO-STORAGE-PLAN.md)。

## src → 模块

| 文件 | 模块 | 说明 |
|---|---|---|
| `src/oauth.js` | Client / Runtime | 入站 OAuth；也可归 runtime |
| `src/client-platform.js` | Client | 平台识别 |
| `src/client-profile.js` | Client | profile/编码 |
| `src/sanitize.js` | Client / Shared | schema sanitize |
| `src/codemode.js` | Execution | Code Mode 核心 |
| `src/codemode-v2.js` | Execution | v2 plan/code 路由 |
| `src/typed-plan.js` | Execution | typed plan 引擎 |
| `src/tool-format.js` | Execution | 工具描述/错误/截断 |
| `src/result-normalize.js` | Execution | canonical 结果 |
| `src/github-helpers.js` | Execution / Upstream | GitHub 高频 helper |
| `src/file-write.js` | Execution / Upstream | patch/write |
| `src/upstreams.js` | Upstream | MCP 连接/调用 |
| `src/upstream-auth.js` | Upstream | grant/refresh |
| `src/upstream-oauth.js` | Upstream | DCR/CIMD callback |
| `src/capture.js` | Evidence | capture |
| `src/capture-queue.js` | Evidence | 异步队列 |
| `src/project-tag.js` | Evidence | 项目标签 |
| `src/vercel-app.js` | Runtime | Vercel HTTP |
| `src/server.js` | Runtime | Node/CLI server |
| `src/store.js` | Shared / Runtime | KV/store |
| `src/config.js` | Shared | 配置校验 |
| `api/index.js` | Runtime | Vercel entry |

## tests → 模块（按文件名前缀）

| 前缀/文件 | 模块 |
|---|---|
| `client-*`, `platform-*`, `chatgpt-*`, `claude-*` | Client |
| `codemode-*`, `typed-plan-*`, `tool-format-*`, `result-normalize-*`, `file-write-*`, `github-*` | Execution |
| `upstream-*`, `auth-*`, `provider-*`, `env-*`, `cas-*`, `invalid-grant-*`, `token-*` | Upstream |
| `capture-*`, `eval-*`, `l1-*`, `online-*`, `replay-*`, `project-*`, `session-*` | Evidence |
| `server-*`, `vercel-*`, `docker-*`, `deploy-*`, `reconnect-*`, `local-*` | Runtime |
| `export-*`, `oss-*`, `neutralizer-*`, `safety-*` | OSS |
| 其他纯工具 | Shared |

## scripts → 模块

| 脚本 | 模块 |
|---|---|
| `run-l1-smoke`, `replay-online-session`, `eval-cycle`, `record-online-feedback`, `join-online-offline`, `capture-digest`, `analyze-captures`, `platform-conformance`, `eval-search`, `measure-context` | Evidence |
| `auth-*`, `check-env-isolation`, `seed-upstream-tokens` | Upstream |
| `local-e2e-verify`, `mcp-v2-smoke`, `reconnect-probe`, `write-build-info`, `check-config` | Runtime |
| `typed-plan-*`, `replay-write`, `real-gh-replay`, `verify-real-github` | Execution |
| `export-oss`, `prepare-neutral-source`, `audit-tools`, `audit-truncation` | OSS |
| `check-task-coverage`, `collect-tools`, `classify-projects`, `figma-token`, `gen-figma-tasks`, `smoke`, `run-tests`, `probe-mcp-2026` | Shared/Tooling |

## docs → 模块

| 目录 | 内容 |
|---|---|
| `docs/FRAMEWORK.md`, `FRAMEWORK-FULL.md` | 总纲/目标态 |
| `docs/ARCHITECTURE*.md` | 架构拆解 |
| `docs/ledger/` | 历史批次 |
| `docs/eval/` | 评测/任务/报告 |
| `docs/OPEN-SOURCE/` | OSS |
| `docs/architecture-audit/` | 审计证据 |
| `docs/*.md` | 验收/授权/部署/客户端/迁移 |

## 根文件

| 文件 | 作用 |
|---|---|
| `AGENTS.md` | agent 规则 + 状态 |
| `README*` | 对外说明 |
| `package.json` / lock | 依赖 |
| `Dockerfile` / compose | 容器 |
| `vercel.json` | Vercel |
| `config.example.json` | 配置模板 |
| `.github/workflows` | CI |
| `CONTRACT*.md` | 历史契约 |
| `LICENSE` / `SECURITY.md` / `CONTRIBUTING.md` | 开源工程 |
