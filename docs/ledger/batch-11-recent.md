# B11.1 — 2026-11-23 近期修复批次

> 状态：进行中。本文记录 2026-11-22 晚到 2026-11-23 的线上修复、真实验证和未完成项。
> 不按日历排期；完成后由 lead 统一集成。

## 1. Capture 可信性（已完成并真实验证）

### 问题

生产 Vercel 日志有大量 `POST /mcp`，R2 只有少数对象，且没有 `capture_dropped`。

### 根因链

1. `startCapture` 把 envelope 构建 + `waitUntil` 放进 `res.end` 的 `queueMicrotask`；
2. Vercel 在 `res.end` 后冻结实例，microtask/sink 不跑；
3. 修调度顺序后，`originalEnd` 仍先于 `waitUntil`，sink 仍未保留；
4. Vercel 该 runtime 对 `waitUntil` 的保留不可靠，最终启用 `CAPTURE_SYNC=1` 同步落盘。

### 修复

- 同步路径构建 envelope、调用 `waitUntil`、再 `originalEnd`；
- 每个 `/mcp` POST：`capture_ack` / `capture_done` / `capture_sink_start` / `capture_sink_ok`；
- 失败：`capture_dropped` + `capture_sink_error`；
- `CAPTURE_SYNC=1`：响应等待 R2 写完，代价约 +0.4–0.5s。

### 证据

- requestId `3f19584b-7f9e-4f5f-81fe-51fd699832d3`（refresh-test-a）
- requestId `af0c3eb0-8cd3-41cf-962d-4c8cf95a593a`（refresh-test-b）
- requestId `602f4012-8776-465d-8bb3-d9507ef2bd90`（README execute_read）
- 均能在 R2 按 requestId 直接取到对象；`capture_done` 含 `sync:true`。

### 提交

`e4db9e7`、`8acdad9`、`8100971`、`c1fb779`

### 文档

`docs/eval/capture-verification-2026-11-23.md`

## 2. 真实 GitHub 写回放（已完成）

### 操作

测试分支 `codex/write-replay-*` → 建文件 → `applyFilePatch(dryRun)` → 真实 patch → 校验正文 → 删除分支。

### 抓到并修复的真实 bug

1. `{text, resources}` 的下载提示被当正文；
2. blob sha 未从 `SHA:` 提示提取，真实写入被 GitHub 拒绝；
3. `{content:{sha}, commit:{sha}}` 嵌套未解析，`commitSha` 取错。

### 结果

正文 `one\nTWO\nthree\n` 校验通过；顶层 `sha`/`commitSha` 正确；分支已清理。

### 提交

`7f5c4c9`

### 文档

`docs/eval/write-replay-2026-11-23.md`、`scripts/replay-write.mjs`

## 3. 会话标记（已完成并 Gemini 实测）

### 实现

- `initialize` 生成 `Mcp-Session-Id` 响应头；
- capture 记录 `sessionId` + `clientInfo`；
- transport 仍 stateless，不引入服务端 session 状态。

### Gemini 实测

- `641ffd4f-8c40-462e-8938-b7b11d9d595f`（Gemini 1.0.0）后续 `execute_read` 回传同一头；
- 同时段 `6ef4f489...`、`cb65fcae...` 被正确切分为不同 session；
- 旧窗口不一定重新 initialize，仍需离线聚类兜底。

### 提交

`f6ca670`、`6a1b853`

### 文档

`docs/eval/session-marker-2026-11-23.md`

## 4. MCP 2026-07-28 兼容审计（已完成，决策：暂不迁移）

- 当前 SDK 1.32.2 实际支持 2025-11-25 legacy；
- 2026-07-28 已移除 session/initialize，新增 `server/discover`、`resultType`、MRTR；
- Gemini 当前走 legacy，线上可用；
- **不升级 SDK、不双栈**；等客户端实际升级再做版本分流。

### 提交

`0f943a3`

### 文档

`docs/ledger/mcp-2026-07-compat.md`

## 5. 模型侧静默截断（P0，进行中）

### 证据

- `363fd3e7-a9ff-44b7-b2f0-c1e4c27329b6`：模型代码 `l.slice(0, 150)`；
- `21896fe1-da1c-4682-93b9-1c8c53f5405c`：同上；
- 网关响应完整（711/779 bytes，`overflow:false`），模型输出被截断且无 `truncated` 标记。

### 影响

- 模型可见输出 ≠ 网关 capture；
- 评测可能基于截断结果误判；
- 同类 `.slice(n)` / `substring(n)` / `maxChars` 可能污染写路径。

### 修复中

三个子代理并行：

1. `truncation-guard`：`readFileRange`、默认不字符截断、长行 golden 测试、guidance；
2. `truncation-audit`：capture 记录模型可见输出/`possibleModelTruncation`，digest/analyzer 聚类；
3. `truncation-scan`：仓库级截断扫描 + CI 守门。

### 验收

- 长行逐字符一致；
- 显式截断必须 `truncated:true` + reason；
- P0 扫描命中 CI 失败；
- 真实会话复测不复发。

## 6. 未完成 / 下一步

- 离线 session 聚类（无 `Mcp-Session-Id` 的旧窗口）；
- 在线/离线 join 脚本升级，按 session 聚合；
- 多文件写事务/补偿（当前预检失败整批不写，写阶段非原子）；
- 静默截断 P0 集成与真实会话复测；
- W4 Gemini 结构化原语 A/B。
