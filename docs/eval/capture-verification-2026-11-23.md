# Capture verification（2026-11-23，post-fix）

## 结论

修复后的在线 capture 首次完成 `ack → done → sink_ok → R2 object` 全链路对账。

## 证据（用户 README 请求）

| 字段 | 值 |
|---|---|
| requestId | `602f4012-8776-465d-8bb3-d9507ef2bd90` |
| build | `8100971b778a5bd9f154b933f84607c5308541f2` |
| path / method | `/mcp` / `POST` |
| MCP 方法/工具 | `tools/call` → `execute_read` |
| status | 200 |
| duration | 1049 ms（含同步 sink） |
| `capture_ack` | 22:13:55.892Z |
| `capture_done` | 22:13:56.941Z，`sync:true`，`sinkQueued:true` |
| `capture_sink_start` | 22:13:56.941Z |
| `capture_sink_ok` | 22:13:57.393Z |
| R2 object | `capture/2026-11-22/602f4012-...json.gz` |
| R2 内容 | 响应 raw 含 README 前 10 行；events 含 `gateway_catalog/upstream_frame/upstream_http/upstream/sandbox` |

## 根因链（三层）

1. `waitUntil` 放在 `queueMicrotask` → Vercel 冻结后没跑；
2. 修了调度顺序，但 `originalEnd` 在 `waitUntil` 之前调用 → 还是不保留；
3. Vercel runtime 对 `waitUntil` 的保留仍不可靠 → 最后加 `CAPTURE_SYNC=1`：响应等待 sink 完成。

## 代价

- 同步 sink 给每个 `/mcp` 请求增加约 **0.4–0.5s**（本次 1049ms 总耗时内）；
- R2 写失败会走 `capture_sink_error`/`capture_dropped`，响应仍会结束；
- 后续若要降延迟，可改为 collector/队列或修复 `waitUntil` 上下文；当前以“数据可信”优先。

## 对账判据

- `A === D`：同一 requestId 有 ack + done；
- `sink_ok`：同一 requestId 有 sink_start + sink_ok；
- `R`：R2 存在同一 requestId 对象；
- `dropped`：无 `capture_dropped`；
- 本次四项全部成立。
