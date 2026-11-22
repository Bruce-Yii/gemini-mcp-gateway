# Batch 9 — Upstream HTTP response body + capture sink 兜底

## 范围

补齐两个采集缺口：

1. `makeCaptureFetch` 现在采集上游 HTTP **response body**（此前只有 request/status/headers）。
2. sink 失败时，除了保留 `[capture_dropped]` 结构化日志/计数，新增可选的**兜底 HTTP POST**，把完整 envelope 送到另一个端点。

只改动 `src/capture.js`、`src/upstreams.js`、`src/upstream-auth.js` 及对应测试；不碰 codemode / result-normalize / file-write / github-helpers / scripts / README / CHANGELOG。

## 采集边界与开销

### 1. 上游 HTTP response body

| 响应类型 | 行为 |
|---|---|
| 非 SSE（`content-type` 不含 `text/event-stream`） | 从 `response.clone()` 读取正文，**上限 64 KB**；超出部分丢弃并记 `bodyTruncated: true`。读取是 bounded 且 await 的——clone 不消费原响应，SDK 拿到的 `Response` 对象完全不变（status/headers/body 原样）。 |
| SSE / 流式（`content-type: text/event-stream`） | **不读 body**，事件记 `bodySkipped: 'stream'`。流可能永不结束，读取会阻塞 SDK；这里直接跳过，零延迟。 |
| 无 `clone()` 的 mock / 精简 Response | 记 `bodySkipped: 'no-clone'`（或 `clone-failed` / `read-failed` / `no-body`），不抛错。 |

- **上限 64 KB**：避免异常上游把 envelope 撑大。对 MCP 的 JSON-RPC 响应这个量级足够；更大的 payload 本来也不该进采集事件。
- **不阻塞流**：`reader.cancel()` 在 Node 的 `Response` 流上可能挂起，所以截断时直接停止读取而不 cancel；原响应仍可完整读取（已验证）。
- **token refresh / verify**：`upstream-auth.js` 的 `_refresh`/`_verifyToken` 同样在 fetch 前发 request 事件、fetch 后发 response 事件（含 body，上限 64 KB，超长加 `…[truncated]`）。原先 `_verifyToken` 缺 body，已补齐。

### 2. sink 失败兜底

- 主 sink（file/http/r2/console）失败时仍走原路径：`droppedCount += 1`、`console.error('[capture_dropped]', JSON.stringify(record))`。这条日志在 Vercel 上即使 R2 整体不可用也会留下记录。
- 新增两个可选环境变量（也可用 `startCapture` 的 `fallbackHttpUrl` / `fallbackHttpToken` 选项覆盖）：

  | 变量 | 含义 |
  |---|---|
  | `CAPTURE_FALLBACK_HTTP_URL` | 兜底 POST 端点；留空则禁用兜底 |
  | `CAPTURE_FALLBACK_HTTP_TOKEN` | 可选 Bearer token |

- 兜底 POST 的内容：`{ ...capture_dropped record, envelope }`，即失败原因 + **完整原始 envelope**，保证 R2 挂掉时采集数据不丢。
- 兜底 POST 自身失败（超时/网络错误）**静默吞掉**，不重试、不抛错、不影响计数（计数只反映主 sink 失败）。
- 超时 3 秒（`AbortController`），通过 `waitUntil` 在响应后执行；不引入新依赖，复用 `cfg.fetchImpl`（生产为全局 `fetch`）。

### 3. 不变式

- 对 SDK 的 `Response` 对象零修改：测试验证返回的 `Response.text()` 仍是完整原文（含 >64KB 的截断场景）。
- SSE 响应事件发出耗时 < 1s（不等待 body）。
- 无兜底 URL 配置时行为与之前完全一致（只有 `capture_dropped` 日志，计数 +1）。

## 测试

- `tests/capture-http.test.js`（新增，6 项）：非 SSE body 采集且返回对象不变、SSE 标记跳过、64 KB 截断、无 clone 降级、兜底 POST 带 token+完整 envelope、兜底自身失败静默。
- `tests/capture.test.js`（扩展，2 项）：兜底 envelope 字段与计数、无兜底 URL 时不 POST。
- 全量 `npm test`：**512 项全绿**（含本批新增 8 项；其他批次并行新增的用例也包含在内）。

## 风险 / 已知限制

1. **await 克隆读取的延迟**：非 SSE 响应在返回前会等待最多 64 KB 的读取（通常 < 几毫秒）。若上游响应极慢地流式吐出 JSON（非 SSE 但 `content-type: application/json`），这里会等到读满 64 KB 或流结束才返回——这是为了 capture 确定性的取舍。真正的 SSE 已明确跳过。
2. **内存**：每次非 SSE 响应额外保留一份最多 64 KB 的克隆文本；并发下开销有界。
3. **兜底端点可用性**：兜底本身也可能挂；此时只有 Vercel 日志（`[capture_dropped]`）留有记录，不保证远端持久化。需运维配置可用的兜底端点。
4. **Token 泄露**：鉴权 bearer token 只通过 HTTPS POST 的 `authorization` header 传给兜底端点，不写日志、不进 envelope（envelope 里的 `request.headers` 是网关入站 header，上游 token 只在 `upstream_http` 事件里，与既有行为一致）。
