# REPO-MAP — 文件到六模块的映射

> **状态：物理迁移已做（兼容 shim 保留）。**
> src/ 的 25 个实现文件已 `git mv` 到六个模块目录；旧 `src/xxx.js` 路径保留为
> 纯 re-export shim（`export * ...`，有 default 的再加 `export { default } ...`），
> 不含任何逻辑，保证 tests/scripts/api 的现有 import 继续可用。
> 目标结构与阶段状态见 [REPO-STORAGE-PLAN.md](REPO-STORAGE-PLAN.md)。

## src → 模块（物理路径；旧路径为兼容 shim）

| 旧路径（shim） | 实现路径 | 模块 | 说明 |
|---|---|---|---|
| `src/oauth.js` | `src/client/oauth.js` | Client | 入站 OAuth（有 default） |
| `src/client-platform.js` | `src/client/client-platform.js` | Client | 平台识别 |
| `src/client-profile.js` | `src/client/client-profile.js` | Client | profile/编码 |
| `src/codemode.js` | `src/execution/codemode.js` | Execution | Code Mode 核心 |
| `src/codemode-v2.js` | `src/execution/codemode-v2.js` | Execution | v2 plan/code 路由（有 default） |
| `src/codemode-util.js` | `src/execution/codemode-util.js` | Execution | codemode 工具映射 |
| `src/typed-plan.js` | `src/execution/typed-plan.js` | Execution | typed plan 引擎（有 default） |
| `src/tool-format.js` | `src/execution/tool-format.js` | Execution | 工具描述/错误/截断 |
| `src/result-normalize.js` | `src/execution/result-normalize.js` | Execution | canonical 结果 |
| `src/github-helpers.js` | `src/execution/github-helpers.js` | Execution | GitHub helper（有 default） |
| `src/file-write.js` | `src/execution/file-write.js` | Execution | patch/write（有 default） |
| `src/upstreams.js` | `src/upstream/upstreams.js` | Upstream | MCP 连接/调用 |
| `src/upstream-auth.js` | `src/upstream/upstream-auth.js` | Upstream | grant/refresh |
| `src/upstream-oauth.js` | `src/upstream/upstream-oauth.js` | Upstream | DCR/CIMD callback |
| `src/figma-guard.js` | `src/upstream/figma-guard.js` | Upstream | Figma 配额/缓存 |
| `src/capture.js` | `src/evidence/capture.js` | Evidence | capture |
| `src/capture-queue.js` | `src/evidence/capture-queue.js` | Evidence | 异步队列（有 default） |
| `src/project-tag.js` | `src/evidence/project-tag.js` | Evidence | 项目标签（有 default） |
| `src/vercel-app.js` | `src/runtime/vercel-app.js` | Runtime | Vercel HTTP（有 default） |
| `src/server.js` | `src/runtime/server.js` | Runtime | Node/CLI server |
| `src/config.js` | `src/shared/config.js` | Shared | 配置校验 |
| `src/sanitize.js` | `src/shared/sanitize.js` | Shared | schema sanitize |
| `src/catalog.js` | `src/shared/catalog.js` | Shared | 工具目录/搜索 |
| `src/build-info.js` | `src/shared/build-info.js` | Shared | 构建标识（构建时生成） |
| `src/store.js` | `src/shared/store.js` | Shared | KV/store（有 default） |
| `api/index.js` | `api/index.js` | Runtime | Vercel entry（未移动） |

### 迁移兼容处理

- `src/runtime/vercel-app.js` 中 config 模板路径由 `../config.example.json` 改为
  `../../config.example.json`（目录层级多一层）。
- `src/runtime/server.js` 的 `isMain()` 同时识别真实路径与旧 `src/server.js`
  shim 路径，`node src/server.js --config ...` / `npm start` 行为不变。
- `scripts/write-build-info.mjs` 递归扫描 src/ 子目录，生成文件写入
  `src/shared/build-info.js`（根 shim 继续 re-export）。
- `scripts/check-module-boundaries.mjs` 只扫描六个实现目录，排除 shim；
  9 条 legacy 边按迁移后路径重新登记，new violations=0。
- `scripts/export-oss.mjs` 导出整个 `src/`（实现 + shim），并校验 6 个模块目录
  全部进入导出计划。

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
