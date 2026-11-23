# Client compatibility

The gateway is a standard MCP server over **Streamable HTTP** at `/mcp`, with an
OAuth 2.1 authorization server in front of it. The model-facing surface is
always the same three tools: `search`, `execute_read`, `execute`.

| Client | Status | Notes |
|---|---|---|
| Gemini web custom apps | **Tested** | Google currently limits custom apps to personal accounts, 18+, US, English UI. Locked-client mode requires entering the client id/secret in the advanced settings. |
| MCP Inspector (local) | Works for tool listing | Point it at `http://localhost:3000/mcp`; OAuth on localhost is untested. |
| Claude Desktop / Claude Code / Claude.ai web connector | OAuth callback allowed; real connector unverified | `https://claude.ai/api/mcp/auth_callback` is on the shared OAuth redirect allowlist (DCR / authorize / token). Locked-client mode still disables DCR unless `ALLOW_DCR_FOR_CLAUDE=1` is set. No live Claude connector session was exercised; Streamable HTTP, custom headers and 401 metadata handling still need real-client verification. |
| ChatGPT connectors | Untested | Custom MCP connector support and OAuth requirements vary by plan/region; do not assume it works without testing. |
| Cursor / Cline / other IDE agents | Untested | Static `/mcp` with OAuth may require manual client registration; some clients only support stdio. |
| OpenCode / DSH / similar agent runtimes | Untested with this repo | They can usually call Streamable HTTP MCP directly; OAuth support differs. |

## What a client needs

1. Streamable HTTP transport (SSE-only clients are not supported).
2. Either an OAuth 2.1 client flow (the gateway implements DCR, PKCE S256, and
   non-rotating refresh tokens) **or** the ability to send a static
   `Authorization: Bearer` header for a manually issued token.
3. No assumption that tool definitions change mid-session: the gateway keeps
   them stable on purpose.

## Reporting a client

When opening an issue, include the client/version, the transport/OAuth path you
used, whether the tool list loaded, and the first failing tool call with its
exact error text. "It doesn't work" is not actionable; the three-tool surface and
the OAuth flow are the two usual suspects.
