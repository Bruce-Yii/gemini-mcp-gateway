# Session marker（2026-11-23）

## 目标

让同一 Gemini 窗口的多次 `initialize → tools/list → execute_read` 能归为一组，
同时不引入服务端 sticky session、不依赖模型记住任何东西。

## 实现

- `initialize` 请求：网关生成 `Mcp-Session-Id` 并写入响应头；
- 后续请求：客户端按 legacy MCP 规范回传该头；
- capture envelope 记录：
  - `sessionId`：网关生成值或客户端回传值；
  - `clientInfo`：`initialize.params.clientInfo`（例如 Gemini/1.0.0）。
- transport 仍是 `sessionIdGenerator: undefined` 的 stateless 模式；这个 ID 只用于 capture/eval 关联，不保存服务端状态。

## 本地验证

用官方 MCP SDK client 连本地 handler：

```text
initialize → transport.sessionId = 0d771f72-...
tools/list → transport.sessionId 保持同一个值
```

测试：`tests/mcp-session.test.js`（1 项），全量 550 项通过。

## Gemini 实测（2026-11-22T22:34Z）\n\n新窗口实测通过：\n\n- `initialize` 返回 sessionId `641ffd4f-8c40-462e-8938-b7b11d9d595f`，`clientInfo={name:"Gemini",version:"1.0.0"}`；\n- 后续 `notifications/initialized`、`execute_read` 都回传同一个 `mcp-session-id`；\n- 同一时段还能看到 `6ef4f489-...`、`cb65fcae-...`、`0499380b-...` 多个不同 session，说明窗口重连/刷新能被正确切开；\n- 该窗口的 execute_read 仍走 `/mcp`，capture 记录完整（约 930ms）。\n\n结论：Gemini 会回传 legacy `Mcp-Session-Id`，标记方案有效；不需要让模型记任何东西。\n\n## 边界

- 如果其他客户端不回传 `Mcp-Session-Id`，只有 `initialize` 请求有 sessionId；
  后续请求只能按 `clientInfo + 时间/刷新边界` 离线归组。
- 旧窗口不一定重新 `initialize`；要拿到稳定 sessionId，需要新窗口或客户端主动重连。
- 现代 MCP 2026-07-28 已移除 session 头；未来升级时要保留 `clientInfo` 作为兜底。
