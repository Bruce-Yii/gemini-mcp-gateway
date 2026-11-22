# Batch 9 — Capture 完整性（生产请求多 / R2 capture 少）

> 状态：已实现（工作区未提交）· 2026-11-23
> 范围：`src/capture.js`、`src/server.js`、`src/vercel-app.js`、`tests/capture-completeness.test.js`、本文档。
> 明确不改：`src/codemode.js`、`src/upstreams.js`、`scripts/`、`workflows`、`README`、`CHANGELOG`。
> 背景：北京时间 2026-11-23 04:58（UTC 2026-11-22T20:58Z）之后，R2 只有 10 个 capture（2 execute_read、2 tools/list、1 个 405、5 个 `/` 404），但同一时段 Vercel 日志有大量 `POST /mcp`；没有任何 `capture_dropped`。

## 1. 根因定位

### 1.1 最可能的真实原因：`waitUntil` 在 `queueMicrotask` 里才被调用

原 `startCapture()` 的 `res.end` 包装把 envelope 构建、sink 启动和 `waitUntil(task)` 都放进了 `queueMicrotask`：

```js
const result = originalEnd(...);
queueMicrotask(() => {
  const task = Promise.resolve().then(() => writeSink(...)).catch(...);
  try { waitUntil(task); } catch {}
});
return result;
```

Vercel 的 serverless runtime 会在响应 finalize 后尽快冻结/回收实例。若 microtask 在冻结后才 flush，`writeSink` 根本没执行 —— 于是**既没有 capture，也没有 `capture_dropped`**（因为 catch 也从来没跑）。这与证据高度吻合：“不是简单 sink 失败（无 dropped 日志），而是请求没进入 capture / 响应结束路径没触发”。

**修复**：envelope 构建、`Promise.resolve().then(() => writeSink(...))` 和 `waitUntil(task)` 全部在 `res.end` 的**同步路径**完成，microtask 只负责真正的 I/O（不参与调度决策）。`res.end` 返回前，`waitUntil` 已经持有 sink promise。

### 1.2 第二个原因：capture 关闭/部署 env 不一致时完全静默

原 `vercel-app.js` appHandler 顶部无条件 `startCapture(req, res)`，但 `startCapture` 读 `process.env.CAPTURE_MODE`；若部署环境未设置或设为 `off`，直接 `return null`，**无任何日志**。此时“capture 没开”和“capture 静默丢失”在日志里不可区分。

**修复**：任何未启用 capture 的请求都会输出一条 `[capture_skipped]`，`reason='capture_disabled'`，并附带 `build`（commit/buildHash/builtAt），可直接和 `/healthz` 对比是否部署/env 不一致。

### 1.3 第三个原因：没有请求级关联键

原路径没有把 Vercel 的 `POST /mcp` 日志行和 R2 object 关联起来的字段，无法判断“哪些请求没进 capture”。

**修复**：每个请求一条同步 `[capture_ack]`（requestId/path/method/mode/sink/enabled/requestBytes/bodyBuffered）和一条 `[capture_done]`（同一 requestId/status/duration/sinkQueued/sinkError）。不记录认证值或大 body。

## 2. 改动摘要

### `src/capture.js`

| 变更 | 说明 |
|---|---|
| `[capture_ack]` | `startCapture` 同步输出；字段：`requestId,path,method,mode,sink,enabled,requestBytes,bodyBuffered,build`。 |
| `[capture_done]` | `res.end` 同步输出；字段：`requestId,path,method,status,duration,sink,sinkQueued,sinkError?`。 |
| `[capture_skipped]` | mode off 时输出；reason 为封闭枚举（`capture_disabled/env_missing/non_post/body_buffer_failed/handler_error/already_started/...`），`detail` 过滤掉任何含 bearer/token/authorization/secret/cookie 的文本，绝不记录 header/token/body。 |
| 同步调度 | envelope 构建 + `writeSink` 启动 + `waitUntil(task)` 全部在 `res.end` 同步路径；无 `queueMicrotask` 调度。 |
| 失败兜底 | sink 失败的 `.catch` 独立于 `waitUntil`，即使 `waitUntil` 不可用/抛错也一定 `console.error('[capture_dropped]', ...)`。 |
| 幂等 | `req.__gatewayCaptureStarted` + `req.__gatewayCapture` 防重；第二次 `startCapture` 返回同一 context，不产生第二个 envelope / ack。 |
| `captureSkip()` | 非 POST / 非 /mcp / 早退路径的独立 skip 输出；带 requestId。 |

### `src/vercel-app.js`

- `bufferCaptureBody(req)` 集中缓冲 POST body（在 auth 之前），供 401/403 也有完整 envelope；`appHandler` 在路由前调用，使 `[capture_ack]` 的 `requestBytes/bodyBuffered` 准确。
- 唯一生产入口：`appHandler` 顶部对 `POST /mcp` 调用一次 `startCapture`，覆盖成功 / 401 / 403 / 404 / 405 / MCP handler early return / body 读取失败。
- 非 POST `/mcp` 输出 `[capture_skipped] reason=non_post`。
- body 缓冲失败输出 `capture.skip('body_buffer_failed')`。

### `src/server.js`

- `createMcpRequestHandler` 在 POST `/mcp` 入口检查 `req.__gatewayCaptureStarted`：已启动则只读 `req.__gatewayCapture`，**不创建第二个 capture**（生产防双写）；独立使用（local `startHttpServer` / 单测）才自行 `startCapture`。
- body 读取失败与 handler 异常分别输出 `capture.skip('body_buffer_failed')` / `capture.skip('handler_error')`；响应仍走 `res.end` 触发 `[capture_done]`。
- 非 POST / 非 /mcp 路径输出 `captureSkip(...)`。

## 3. 用 Vercel 日志 requestId 对 R2 object（运维核对方法）

### 3.1 从 Vercel 日志取 requestId

在 Vercel 项目日志（或 `vercel logs <deployment> --follow`）里筛：

```
[capture_ack]    # 每个 POST /mcp 一条，含 requestId
[capture_done]   # 同一 requestId，含 status/sinkQueued/sinkError
[capture_skipped]# 非 POST / capture 关闭 / body 失败 / early return，含 reason
[req] POST /mcp  # 原有访问日志
```

`capture_ack` 与 `capture_done` 必须成对出现且 requestId 相同。若只有 `[req] POST /mcp` 而没有 ack，说明该请求在 `appHandler` 之前就被平台拒绝（边缘层/路由层），不在本修复范围。

### 3.2 从 R2 找 object

R2 object key 形如：

```
<R2_PREFIX>/<YYYY-MM-DD>/<requestId>.json.gz
```

默认 `R2_PREFIX=capture`，`YYYY-MM-DD` 取 envelope `ts` 的 UTC 日期。可用 Cloudflare API 或 `wrangler r2 object get`：

```bash
# 用 Vercel 日志里的 requestId
REQUEST_ID=<从 [capture_ack] 复制的 UUID>
DAY=$(date -u +%F)   # 或 ack 当天 UTC 日期

# wrangler（已登录、有 bucket 权限）
npx wrangler r2 object get "$BUCKET" "capture/$DAY/$REQUEST_ID.json.gz" --file "$REQUEST_ID.json.gz"
gunzip -c "$REQUEST_ID.json.gz" | jq '.requestId, .response.status, .events'

# 或 Cloudflare API（等价于 writeR2Sink 的 PUT URL，改 GET）
curl -sS \
  -H "Authorization: Bearer $R2_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$R2_ACCOUNT_ID/r2/buckets/$R2_BUCKET/objects/capture/$DAY/$REQUEST_ID.json.gz" \
  -o "$REQUEST_ID.json.gz"
```

`gunzip` 后校验 `.requestId === <日志中的 requestId>`、`.response.status === done.status`。

### 3.3 对账判据（当前窗口未覆盖的请求数）

对某一时间窗（例：UTC `2026-11-22T20:58Z` 起）：

1. `V = Vercel 日志中 [req] POST /mcp 的条数`；
2. `A = [capture_ack] 条数`；`D = [capture_done] 条数`；`S = [capture_skipped] 条数`；
3. `R = R2 中 prefix/date 下 `.json.gz` object 数量`；
4. 判据：
   - `A === D`（每个 ack 都有 done）—— 否则有响应结束路径漏触发；
   - `V - A === S`（Vercel 访问数与 capture 覆盖的差等于显式跳过的数量）—— 否则有请求在 `appHandler` 之前丢失；
   - `R + droppedCount === A`（R2 object + drop 数 = ack 数）—— 否则 sink 排队/冻结问题仍在；
   - 任何 `sinkError` 或 `[capture_dropped]` 都应能在 fallback endpoint 找到完整 envelope。

**当前窗口（用户提供的证据）**：`R = 10`，`V` 为“大量”（具体数需从 Vercel 日志导出）。在本次修复前没有 ack/done/skip 行，因此 `A/D/S` 不可考，**未覆盖请求数 = V - 10**（V 需运维从日志统计）。修复后按上述三条判据重跑同一窗口即可定位缺口：
- 若 `A << V` 且 `S` 很小 → 请求在 `appHandler` 之前被平台丢弃，或部署的不是本版本；
- 若 `A ≈ V` 但 `R << A` 且无 `capture_dropped` → sink 调度/冻结问题（本修复针对）；
- 若 `A ≈ V` 且有 `capture_dropped` → sink 配置/网络问题，查 R2 env 与 fallback。

### 3.4 验证部署/env 一致的命令与判据

本地与生产对比 build 身份（`/healthz` 已暴露 `commit`/`buildHash`/`builtAt`）：

```bash
# 本地当前 checkout 的 buildHash（不修改文件）
node scripts/write-build-info.mjs --print

# 生产
curl -sS https://<your-domain>/healthz | jq '{commit, buildHash, builtAt, env, deploymentId, mode, configLoaded, servers}'
```

判据：
- `buildHash` 必须一致；否则生产部署的不是本工作区代码 → 本修复尚未上线。
- `mode` 应为 `codemode`/`whitelist` 且 `configLoaded=true`；否则 `UPSTREAMS_JSON`/`GATEWAY_CONFIG` 有问题。
- capture 相关 env（`CAPTURE_MODE=full|meta`、`CAPTURE_SINK=r2`、`R2_ACCOUNT_ID`、`R2_BUCKET`、`R2_API_TOKEN` 或 `R2_AUTH_EMAIL/R2_AUTH_KEY`、`R2_PREFIX`）需在 Vercel Project Settings → Environment Variables 中确认；注意 **Preview 与 Production 环境可分别设置**，可能只有其中一个开启了 capture。Vercel CLI 只读查看：

```bash
vercel env ls            # 列出环境变量名与各环境勾选状态
vercel env pull .env.local --environment=production   # 如需本地核对值（含敏感值，注意保管）
```

判据：
- 若生产 `[capture_skipped] reason=capture_disabled` 大量出现 → `CAPTURE_MODE` 未设置或为 `off`（env 不一致）。
- 若 `[capture_ack]` 出现但 `[capture_done].sink='file'` 而非 `r2` → `CAPTURE_SINK` 未设为 `r2`。
- 若 `sink='r2'` 且有 `[capture_dropped] error='R2 capture sink missing ...'` → R2 凭据 env 缺失。

## 4. 测试

- 新增 `tests/capture-completeness.test.js`：**14 项**，覆盖：
  - 正常响应 ack/done 同 requestId、字段完整、无认证值；
  - 401/403/405 状态都有 ack/done；
  - `res.end` 调两次只有一条 done；
  - sink 失败有 `capture_dropped` 且 done 标记 sinkQueued；
  - mode off → `capture_skipped reason=capture_disabled`、无 ack/done；
  - `captureSkip` 的 reason/detail 不泄露 header/token/body；
  - `captureEnabled` 对 full/meta/off 的判定；
  - `startCapture` 幂等（第二次复用 context、只有一条 envelope/ack/done）；
  - sink 在 `res.end` 同步路径调度（done 在 res.end 返回时已输出，非 queueMicrotask）；
  - vercel-app：无 token 401、valid token 到 MCP handler、非 POST /mcp skip；
  - server handler 在已有 capture context 时不双写、独立使用时自行审计。
- 全量 `npm test`（末次运行）：**545 项，544 通过、1 失败**（测试总数因其他 agent 并发新增而增长；本批次首次运行时为 526 项 / 525 通过 / 1 失败）。唯一失败的测试位于 `tests/b10-codemode.test.js:74` 或 `tests/b10-write-semantics.test.js:135`（`normalizeIssue` 多出 `sha` 字段 / file-write 语义变化），由其他 agent 并发修改的 `src/codemode.js`/`src/file-write.js`/`src/github-helpers.js` 引起；本批次未触碰这些文件，stash 本批次三个源文件后相关测试仍失败，确认与本改动无关。本批次的 14 项新测试与既有 17 项 capture 测试均 100% 通过。

## 5. 风险与限制

1. **同步 sink 启动的微小开销**：`res.end` 同步路径多一次 envelope 构造和 `Promise.resolve().then`（无网络等待）；网络 I/O 仍在微任务中执行，不阻塞响应。
2. **`waitUntil` 在 Vercel 的语义**：`waitUntil` 只是“尽力延长函数生命周期”，不保证无限期；极端冻结下仍可能丢 capture，但现在至少会先有 `[capture_ack]`/`[capture_done]` 可审计，且 `capture_dropped` 与 fallback 独立于它。
3. **幂等键挂在 `req` 上**：同一 `req` 对象被多个 handler 复用时只会 capture 一次（这正是期望）；若测试/框架克隆了 `req` 对象，需确保透传同一实例。
4. **非 POST /mcp 不产出 envelope**：GET/DELETE/405 探针只记 `[capture_skipped]`，不进 R2 —— 与证据中“5 个 `/` 404、1 个 405”这类探针一致，不应计入 MCP capture 覆盖率。
5. **未提交/未部署**：按 P0 要求改动只留工作区，未 commit/push/deploy。需由 lead/人审确认后再合入与部署，部署后用第 3 节判据复核同一窗口。
