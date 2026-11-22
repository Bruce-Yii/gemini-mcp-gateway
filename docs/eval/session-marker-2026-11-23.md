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

## 边界

- 如果 Gemini 不回传 `Mcp-Session-Id`，只有 `initialize` 请求有 sessionId；
  后续请求只能按 `clientInfo + 时间/刷新边界` 离线归组。
- 旧窗口不一定重新 `initialize`；要拿到稳定 sessionId，需要新窗口或客户端主动重连。
- 现代 MCP 2026-07-28 已移除 session 头；未来升级时要保留 `clientInfo` 作为兜底。
