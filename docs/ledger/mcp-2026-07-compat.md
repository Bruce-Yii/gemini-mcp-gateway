# MCP 2026-07-28 compatibility audit (report only)

Date: 2026-11-23. Scope: read-only audit. No production behavior changed, no commit/push/deploy.

Official sources:
- [Key Changes — MCP 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/changelog) (the normative list of changes since 2025-11-25)
- [Versioning and Compatibility](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning) (modern vs legacy, `UnsupportedProtocolVersionError`, compatibility matrix)
- [Deprecated Features](https://modelcontextprotocol.io/specification/2026-07-28/deprecated) (Roots/Sampling/Logging/DCR deprecated in 2026-07-28; earliest removal 2027-07-28)
- [Discovery (`server/discover`)](https://modelcontextprotocol.io/specification/2026-07-28/server/discover) (MUST-implement RPC in 2026-07-28)
- [Architecture](https://modelcontextprotocol.io/specification/2026-07-28/architecture) / [Tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools) / [Transports](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http) (transport and tool-list rules)

## 0. TL;DR

- We are **legacy (2025-11-25)**, not modern (2026-07-28). The installed SDK (`@modelcontextprotocol/sdk@1.32.2`) declares `LATEST_PROTOCOL_VERSION = '2025-11-25'` and `SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25','2025-06-18','2025-03-26','2024-11-05','2024-10-07']`; none of the 2026-07-28 primitives (`server/discover`, `resultType`, `subscriptions/listen`, `Mcp-Method`/`Mcp-Name`, `cacheScope`/`ttlMs`, `UnsupportedProtocolVersionError`) exist in the SDK's shipped ESM JS.
- A 2026-07-28-only client **cannot** use us as-is: it sends `_meta` version + no `initialize`, and expects `server/discover` plus `resultType` on every result. Our SDK never sees a version it recognizes (no `MCP-Protocol-Version` handling in `StreamableHTTPServerTransport`), and has no `server/discover` handler.
- Gemini's connector today speaks the legacy handshake, so the gateway keeps working. **Do not upgrade the SDK or add dual-stack until a 2026-07-28 client is actually in front of us.** Recommendation: **wait for client upgrade** on protocol work; **do now** only the two cheap, zero-risk observations (deterministic tool order already satisfied; capture protocol-version signal).

## 1. What we actually support, with evidence

### 1.1 Declared SDK version

`package.json:48` — `"@modelcontextprotocol/sdk": "^1.32.2"`.
Installed: `node_modules/@modelcontextprotocol/sdk/package.json:3` — `"version": "1.32.2"`.

### 1.2 The installed SDK is a 2025-11-25 implementation

- `node_modules/@modelcontextprotocol/sdk/dist/esm/types.js:2` — `export const LATEST_PROTOCOL_VERSION = '2025-11-25';`
- `.../types.js:3` — `DEFAULT_NEGOTIATED_PROTOCOL_VERSION = '2025-03-26'`
- `.../types.js:4` — `SUPPORTED_PROTOCOL_VERSIONS = [LATEST_PROTOCOL_VERSION, '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07']`
- `.../server/index.js:260–265` — server handles `initialize` by choosing a version from that list; classic handshake semantics.
- `.../client/index.js:285–300` — client still sends `initialize` with `protocolVersion: LATEST_PROTOCOL_VERSION` and rejects a server version not in the list.
- `.../server/streamableHttp.js` and `.../client/streamableHttp.js:80–81, 440, 473–476` — session/`Mcp-Session-Id` machinery and `mcp-protocol-version` header only in the legacy sense.
- Repo-wide grep over `node_modules/@modelcontextprotocol/sdk/dist/esm/**/*.js` found **no** `server/discover`, `resultType`, `InputRequiredResult`, `subscriptions/listen`, `Mcp-Method`, `Mcp-Name`, `x-mcp-header`, `cacheScope`, `ttlMs`, or `UnsupportedProtocolVersionError`. The only 2026 string is `.../spec.types.js:12` (`LATEST_PROTOCOL_VERSION = "DRAFT-2026-v1"`), an auto-generated *draft* identity stub from `schema/draft/schema.ts`, not an implemented runtime protocol (that file is 24 lines of constants; it is not wired into the transports).

Conclusion: the SDK is pre-2026-07-28. It is a "Legacy" implementation in the terminology of [Versioning and Compatibility](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning).

### 1.3 Our own code inherits that legacy surface

- `src/server.js:18–25` — imports `McpServer`, `StreamableHTTPServerTransport`, `StdioServerTransport`, and `isInitializeRequest` from the SDK. `isInitializeRequest` is imported but **never called** in the file (grep: only line 24); the SDK transport handles `initialize` internally, so the import is vestigial.
- `src/server.js:403–408` — every POST creates a fresh `StreamableHTTPServerTransport({ sessionIdGenerator: undefined })` + `McpServer`, calls `connect`, `handleRequest`, then closes. This is our stateless-per-request trick for Vercel; it suppresses session creation but does **not** change the protocol revision — the `initialize` request/response shape is still SDK-owned.
- `src/server.js:419–430` — GET returns 405, DELETE returns 204. Under 2026-07-28 GET SSE is gone entirely and notifications move to `subscriptions/listen` (POST), so this block is legacy-shaped but harmless in practice.
- `src/server.js:311` — `registerCapabilities({ tools: { listChanged: false } })`; no `extensions` capability field, which 2026-07-28 capabilities carry ([changelog, minor 1](https://modelcontextprotocol.io/specification/2026-07-28/changelog)).
- `src/server.js:313–331` — only `tools/list` and `tools/call` handlers. **No `server/discover` handler**, which 2026-07-28 makes mandatory.
- `src/server.js:313–320` — `tools/list` returns `{ tools: [...] }` with no `ttlMs`/`cacheScope`; required by 2026-07-28 `CacheableResult` ([changelog, minor 5](https://modelcontextprotocol.io/specification/2026-07-28/changelog)).
- `src/server.js:148–161` — `textResult()`/`errorResult()` return MCP results without `resultType`. Under 2026-07-28 every result must carry `resultType: "complete"` (or `"input_required"`); clients must treat missing field as `"complete"` for older servers, so this specific omission is tolerated by compliant clients.
- `src/vercel-app.js:248` — CORS `Access-Control-Allow-Headers` still advertises `Mcp-Session-Id` (removed in 2026-07-28); harmless for legacy clients, and `Mcp-Method`/`Mcp-Name` would need adding for a modern client.
- `src/vercel-app.js:198–232` — `/mcp` only does bearer validation then delegates to `createMcpRequestHandler`; no protocol-version gate. A modern client's `MCP-Protocol-Version: 2026-07-28` header is ignored by the SDK transport (it does not validate that header; only `webStandardStreamableHttp.js:762–779` does, and we don't use that transport).

### 1.4 What we already satisfy (no change needed)

- **Deterministic `tools/list` order**: `src/server.js:217–220` sorts the whitelist by `sortKey()` (`server__tool`, `localeCompare('en')`), then appends `gateway_call` and `gateway_search` last (`:244–268`). This already meets the 2026-07-28 SHOULD for deterministic order / client caching, and matches `AGENTS.md` ("工具列表必须稳定").
- **Statelessness**: we already mint no sessions (`src/server.js:403–405`), aligning with the *spirit* of SEP-2567 even though we don't speak the new wire format.

## 2. Can we still connect to Gemini under 2026-07-28? Breaking changes

Short answer: **not with a 2026-07-28-only client, and not by merely bumping a dependency.** The gateway's side of the connection is fine today because Gemini is a legacy client. For a modern client these are the blockers, in rough order of severity:

1. **No `server/discover`** (`src/server.js:313–331`; mandatory RPC per [Discovery](https://modelcontextprotocol.io/specification/2026-07-28/server/discover)). A client that probes up front gets `METHOD_NOT_FOUND` and may refuse to continue. This is the single hardest blocker.
2. **Handshake mismatch / version declaration**: modern clients send no `initialize` and put version + capabilities in `_meta` (`io.modelcontextprotocol/protocolVersion`, `io.modelcontextprotocol/clientCapabilities`, `io.modelcontextprotocol/clientInfo`) and the `MCP-Protocol-Version` header ([changelog, major 2](https://modelcontextprotocol.io/specification/2026-07-28/changelog); [versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)). Our SDK expects `initialize` first; a request that skips it may be rejected or mis-handled at the transport layer.
3. **Version negotiation error shape**: we would need to return `UnsupportedProtocolVersionError` with supported versions for a version we don't implement ([versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)); today such a header is silently ignored and the SDK falls back to defaults (`server/index.js:260–265`, `webStandardStreamableHttp.js:588–589`).
4. **Missing `ttlMs`/`cacheScope`** on `tools/list` (and other list/read results) — required, not optional ([changelog, minor 5](https://modelcontextprotocol.io/specification/2026-07-28/changelog)). A strict client validator can reject our payload.
5. **Missing `resultType`** on all results (`src/server.js:148–161`, `:313–331`) — formally required; compliant clients must treat missing as `"complete"`, so this is low practical risk but is a conformance gap ([changelog, major 8](https://modelcontextprotocol.io/specification/2026-07-28/changelog)).
6. **Required request headers `Mcp-Method`/`Mcp-Name`** on Streamable HTTP POST ([changelog, minor 4](https://modelcontextprotocol.io/specification/2026-07-28/changelog)); our CORS allow-list (`src/vercel-app.js:248`) doesn't include them, so browser-based modern clients would have them preflight-blocked.
7. **Notification model changed**: GET SSE and `resources/subscribe`/`unsubscribe` replaced by `subscriptions/listen` ([changelog, major 4](https://modelcontextprotocol.io/specification/2026-07-28/changelog)). Our GET 405 is fine for stateless servers, but we have no POST listen stream; we don't emit list-changed (`listChanged: false`, `:311`) nor resource subscriptions, so this is a "nothing lost" case for us.
8. **MRTR / `input_required`** ([changelog, major 7](https://modelcontextprotocol.io/specification/2026-07-28/changelog)) and **tasks extension** ([changelog, major 6](https://modelcontextprotocol.io/specification/2026-07-28/changelog)) are not implemented. We use neither server-initiated requests (roots/sampling/elicitation) nor tasks, so these don't break us — but they're part of the new surface a conformance suite would check.
9. **Removed `ping`, `logging/setLevel`, `notifications/roots/list_changed`** ([changelog, major 5](https://modelcontextprotocol.io/specification/2026-07-28/changelog)). We don't implement any; no action.
10. **SSE resumability removed** (`Last-Event-ID`, event IDs) — we never had it. No action.
11. **OAuth-adjacent**: RFC 9207 `iss` validation and DCR `application_type`, plus credentials bound to issuer ([changelog, minor 7–9](https://modelcontextprotocol.io/specification/2026-07-28/changelog)). Note DCR is itself **deprecated** in 2026-07-28 in favor of Client ID Metadata Documents ([Deprecated Features](https://modelcontextprotocol.io/specification/2026-07-28/deprecated)), earliest removal 2027-07-28. Our DCR implementation in `src/oauth.js` / `src/vercel-app.js:271` is therefore legacy-but-still-valid for now. Out of scope of this audit to change.

Gemini-specific constraint from `AGENTS.md` remains decisive regardless of protocol revision: Gemini does not consume `notifications/tools/list_changed`, requires sanitized schemas, fixed tool order, `server__tool` names, and text-JSON results (no `structuredContent`). Our result shape at `src/server.js:148–153` is already correct for Gemini; adding `resultType` alongside it would not disturb that as long as `content` stays text JSON.

## 3. If Gemini stays on the old handshake: dual-stack?

**Recommendation: no dual-stack now.** Rationale:

- There is currently exactly one observed client family (Gemini custom connectors / MCP Inspector), all legacy. A dual-stack server is more failure modes (version detection, two result shapes, two notification models) with no consumer.
- The spec itself anticipates a transition period: it defines "dual-era" implementations and says clients **MUST** treat results from earlier-protocol servers that omit `resultType` as `"complete"` ([changelog, major 8](https://modelcontextprotocol.io/specification/2026-07-28/changelog); [versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)). A legacy server is explicitly still a valid peer for a modern client that chooses to interoperate.
- The gateway is stateless per request (`src/server.js:403–411`), so a future version router can be added at one choke point without touching tool handlers.

If/when a 2026-07-28 client appears, the **minimal-change** design (not implemented here) would be:

1. Add a version discriminator in `createMcpRequestHandler()` before transport creation (`src/server.js:390–408`): read `MCP-Protocol-Version` header and/or `_meta.io.modelcontextprotocol/protocolVersion` from the parsed body. If it is absent → legacy path (unchanged). If `2026-07-28` → modern path.
2. Implement `server/discover` as a plain JSON-RPC method in the modern path, returning supported versions `['2026-07-28']` (or `['2026-07-28','2025-11-25']` if dual), capabilities, identity from `SERVER_INFO` (`src/server.js:34`). This is the only new RPC; it does not need SDK support if handled before `transport.handleRequest`.
3. For modern requests, inject `resultType: 'complete'` into every result, and add `ttlMs`/`cacheScope` to `tools/list`. Keep Gemini's text-JSON `content` untouched.
4. Keep the legacy `initialize` path behind the old SDK transport; do **not** upgrade `@modelcontextprotocol/sdk` until an SDK release declares `LATEST_PROTOCOL_VERSION = '2026-07-28'` and ships `server/discover` + MRTR. (Watch `node_modules/@modelcontextprotocol/sdk/dist/esm/spec.types.js:12` — `DRAFT-2026-v1` is a preview stub, not a shipped implementation.)
5. Add `Mcp-Method`, `Mcp-Name` (and drop `Mcp-Session-Id`) from the CORS allow-list at `src/vercel-app.js:248` only when a browser modern client exists.
6. tests/ and src/ changes would be required for the above; none were made in this audit.

Do not attempt "translate modern→legacy" by stripping `_meta` and synthesizing an `initialize` — that would mask version mismatches and break `UnsupportedProtocolVersionError` semantics.

## 4. Capture / eval impact

`src/capture.js:164–255` captures the **full request envelope** (method, url, headers, raw body) and the **full response bytes** via `res.write`/`res.end` monkey-patching, plus `captureEvent()` events (`src/server.js:293–307` records `gateway_catalog`). It is transport-agnostic: it records whatever crosses the HTTP boundary.

What disappears or changes when a client moves from legacy to modern:

- **`initialize` / `notifications/initialized` frames vanish.** Under 2026-07-28 there is no handshake ([changelog, major 2](https://modelcontextprotocol.io/specification/2026-07-28/changelog)). Today those frames are captured as raw POST bodies in `envelope.request.raw` and their responses in `envelope.response.raw`. Eval scripts that count or parse them will see zero.
- **`Mcp-Session-Id` header vanishes** from captured request/response headers (`src/capture.js:35–39`, `:215`, `:221`); we already mint none because `sessionIdGenerator: undefined` (`src/server.js:404`), so in practice nothing is lost here, but any eval that keys on it should move to `requestId`.
- **New frames appear**: `server/discover` request/response, per-request `_meta` version/clientInfo/capabilities in every request, `resultType` in every result, `cacheScope`/`ttlMs` on `tools/list`, and `Mcp-Method`/`Mcp-Name` headers. Captures will contain them automatically (raw bytes), but `scripts/analyze-captures.mjs` and any parser keyed to the old shape won't recognize them.
- **`notifications/tools/list_changed` / resources subscribe frames**: already absent in our captures (`listChanged: false`, `src/server.js:311`; GET 405 at `:419–422`). Under 2026-07-28 these would move to `subscriptions/listen`, which we don't implement — still absent. No regression.
- **Request-id semantics under GET SSE**: resumability removed ([changelog, major 9](https://modelcontextprotocol.io/specification/2026-07-28/changelog)); irrelevant to us since we never serve GET SSE.
- `gateway_catalog` capture events (`src/server.js:293–307`) are emitted at server construction for **every** POST, including `initialize` and `tools/list`. In a modern world where every request still creates a fresh `McpServer`, this event still fires per request; its payload (mode, limits, tools, upstreams) remains stable. Note this duplication is already noisy today; a version-aware eval should filter by `envelope.request.raw`'s JSON-RPC `method`, not by event count.

Per `AGENTS.md`, free-model output from `scripts/analyze-captures.mjs` remains hypotheses only; any eval change caused by protocol drift must be traced to a `requestId` and reproduced locally before action. No eval/capture code was modified in this audit.

## 5. Priorities

| Priority | Item | Why |
| --- | --- | --- |
| **Now (cheap, no production behavior change)** | Add a capture/eval note that `initialize`-derived metrics must tolerate zero frames; keep using `requestId` as the correlation key. Document current legacy status (this report). | Zero risk; prevents future misreading of captures. |
| **Now (verification only)** | Keep the optional read-only probe `scripts/probe-mcp-2026.mjs` in the repo; run it against a local server to record observed protocol version without network calls. | Gives a repeatable evidence trail, no production change. |
| **Wait for client upgrade** | `server/discover`, `resultType`, `ttlMs`/`cacheScope`, `Mcp-Method`/`Mcp-Name` CORS, dual-stack version router. | No 2026-07-28 client observed; spec explicitly tolerates legacy servers. Implement when a real client proves the need. |
| **Do not do (yet)** | Upgrade `@modelcontextprotocol/sdk` past 1.32.2; rewrite `src/server.js` around a 2026 SDK; migrate OAuth DCR to Client ID Metadata Documents; implement MRTR/tasks/subscriptions/listen. | SDK has no shipped 2026-07-28 implementation; DCR only deprecated (earliest removal 2027-07-28); we don't use the affected features. Revisit when SDK and clients converge. |

## 6. Files touched by this audit

- Added: `docs/ledger/mcp-2026-07-compat.md` (this file).
- Added (optional, read-only): `scripts/probe-mcp-2026.mjs`.
- No changes to `src/`, `tests/`, `README`, `CHANGELOG`, workflows. No commit/push/deploy.
