# ChatGPT custom MCP connector

Status: **implemented but NOT end-to-end tested against a real ChatGPT account.**
This document records the server-side changes and the exact steps to try. It
does not promise that a given plan/region/workspace can add a custom connector.

Server endpoint: `https://<your-stable-domain>/mcp`
Authorization server: `https://<your-stable-domain>` (`PUBLIC_BASE_URL` must be
set to this exact origin; `iss` comparisons are exact string matches).

## Plan / capability matrix

| Plan | MCP capability expected (per OpenAI docs / external reports) | What this gateway supports |
|---|---|---|
| Business / Enterprise / Education workspace | Full MCP connector (tools may perform reads and writes) | OAuth 2.1 DCR + PKCE S256, `mcp` / `offline_access` scopes, tool `readOnlyHint`, structuredContent + text JSON, dynamic tool list frozen |
| Pro / Plus individual | Read-only custom MCP connector with Developer Mode | Same server; only call read-only tools or `search` / `gateway_search`. `gateway_call` / `execute` are write-capable and expected to be unavailable or restricted client-side |
| Free / other plans | No custom connector UI confirmed | Not supported; no promise made here |

OpenAI documents custom connectors primarily through the plugin builder and
workspace admin controls; which plans see "Add custom MCP server" is an account
and admin-policy question. Verify in your own ChatGPT UI.

## What the user must provide / configure

1. **ChatGPT side** (if the UI exposes it): Settings → Connectors / Developer
   Mode → Add custom MCP server. Name it, set Connection URL to
   `https://<your-stable-domain>/mcp`, choose OAuth, review the risk warning,
   create. The exact redirect URI and client-id metadata document URL are shown
   by ChatGPT's management page; do not invent them.
2. **Deployment side (operator)** — required because production is LOCKED with
   `ALLOWED_CLIENT_ID` / `ALLOWED_CLIENT_SECRET` for Gemini:
   - Set `ALLOW_DCR_FOR_CHATGPT=1`. This is an explicit opt-in that enables DCR
     **only** for registrations whose redirect URIs are all documented ChatGPT
     callbacks and whose client metadata identifies OpenAI/ChatGPT
     (`client_name`, `client_uri`, or `token_endpoint_auth_method=none|private_key_jwt`).
   - Keep `ALLOWED_CLIENT_ID` / `ALLOWED_CLIENT_SECRET` unchanged. The Gemini
     locked client is **not** reused for ChatGPT: DCR allocates a separate
     `gmc_...` client id with `platform: "chatgpt"`; the Gemini client keeps
     `platform: "gemini"` and Google-relay-only redirects.
   - Do **not** delete `ALLOWED_CLIENT_ID` to "open DCR for everyone"; that would
     remove the Gemini lock and allow arbitrary registrations.
   - `PUBLIC_BASE_URL` must equal the exact HTTPS origin ChatGPT sees. The
     OAuth metadata `issuer`, protected-resource `authorization_servers`, and
     the `iss` parameter on every authorization response are this exact string.
3. **Google account used for upstream tools**: authorization still goes through
   the gateway's own consent page; upstream tokens come from the existing
   upstream OAuth setup. No static bearer token is accepted by ChatGPT.

## What the server implements

- **Redirect allowlist**: `https://chatgpt.com/connector_platform_oauth_redirect`
  (stable, when RFC 9207 is honored) and `https://chatgpt.com/connector/oauth/<callback-id>`
  (callback-specific). Google relay hosts remain allowed. Every other host,
  plain HTTP, userinfo, and malformed callback ids are rejected. The same
  validator is used by DCR, authorize, and token.
- **RFC 9207**: OAuth metadata publishes
  `authorization_response_iss_parameter_supported: true`; every success and
  error authorization response to an allowlisted redirect carries `iss=<issuer>`.
  Protocol errors with no safe redirect stay JSON (never redirected to an
  attacker-supplied host). Gemini's `state` string is preserved byte-for-byte:
  it is appended via `encodeURIComponent` only when building the redirect URL.
- **Scopes / tokens**: `offline_access` added to `scopes_supported` without
  changing existing scope validation. `resource` is accepted at authorize,
  carried through the consent form, stored with the code/refresh grant, and
  echoed in token responses when requested. Refresh tokens remain non-rotating.
- **401 linking UI**: `/mcp` 401 keeps the original `WWW-Authenticate` header and
  top-level error fields, and adds
  `_meta["mcp/www_authenticate"] = ['Bearer resource_metadata="…", error="…", error_description="…"']`.
  Per [OpenAI auth docs](https://developers.openai.com/plugins/build/auth), the
  UI needs both per-tool `securitySchemes` metadata and this runtime challenge.
- **tools/list metadata**: every listed tool carries `readOnlyHint` and an
  additive `_meta.securitySchemes: [{type:"oauth2", scopes:["mcp","offline_access"]}]`.
  Tool names, descriptions, input schemas, and the frozen ordering are unchanged;
  Gemini ignores the extra `_meta`.
- **Client registration**: ChatGPT DCR clients are public PKCE clients
  (`token_endpoint_auth_method=none` default, no secret). Gemini's locked client
  still requires its env secret at token/refresh. A ChatGPT code cannot be
  redeemed by the Gemini client id, and vice versa.

## Known limitations / unverified items

- **No real ChatGPT end-to-end test has been run.** The flow was verified with
  local tests that emulate ChatGPT's redirects and OAuth requests. Whether
  ChatGPT actually selects DCR vs CIMD, accepts the meta-refresh redirect page
  (used because Google needs it), or displays the linking UI for a given tool
  is **unverified**.
- **CIMD is not implemented.** The gateway does not fetch or validate
  `https://chatgpt.com/oauth/client.json` / callback-specific CIMD documents.
  `client_id_metadata_document_supported` is deliberately **not** advertised.
  We rely on the documented DCR path. If your ChatGPT connector insists on
  CIMD, connection will fail until CIMD support is added.
- **Meta-refresh vs 302**: authorize success redirects use a 200 HTML page with
  a meta refresh (kept for Gemini). If ChatGPT's OAuth client requires a real
  3xx `Location` response, this needs a follow-up change gated by a test.
- **Exact redirect URI**: if ChatGPT shows a different callback than the two
  allowlisted above (or one with a query string), registration fails with
  `invalid_redirect_uri`. Copy the exact URI from ChatGPT's management page.
- **Plan restrictions**: Pro/Plus read-only enforcement is expected to be a
  client-side restriction. This server does not gate tool names by plan; callers
  with a valid token can still invoke `gateway_call` / `execute`. Do not expose
  write-capable upstreams to accounts that should be read-only.
- **Domain restriction / workspace verification** (OpenID UserInfo, verified
  email domain) and **mTLS client certificate validation** are not implemented.
- **`id_token_hint` reauthorization optimization** is not implemented;
  reauthorization restarts the login flow.
- **No profile tool** with `_meta["openai/profile"]` is published; multi-account
  labels may be less reliable in ChatGPT.
- `resource` is echoed, but access tokens are opaque gateway tokens — the
  `aud`/`resource` claim binding described in OpenAI's guidance is not verified
  by the resource server. This is a pre-existing gateway design, unchanged here.

## Troubleshooting checklist

1. `GET https://<domain>/.well-known/oauth-authorization-server` must return
   `issuer`, `authorization_response_iss_parameter_supported: true`,
   `registration_endpoint`, `code_challenge_methods_supported: ["S256"]`, and
   `offline_access`.
2. `GET https://<domain>/.well-known/oauth-protected-resource` must return
   `resource: https://<domain>/mcp` and the same issuer in
   `authorization_servers`.
3. Confirm `ALLOW_DCR_FOR_CHATGPT=1` is actually set in the deployment; without
   it, registration returns 403.
4. On a failed connect, capture the exact `redirect_uri` ChatGPT sent. If it is
   not one of the two allowlisted URIs, do not widen the allowlist to arbitrary
   hosts — add the exact documented URI instead.
5. If ChatGPT reports an `iss` mismatch, check that `PUBLIC_BASE_URL` has no
   trailing slash and matches the origin used by the well-known metadata.

## References

- [OpenAI Plugins: Authentication](https://developers.openai.com/plugins/build/auth)
- [OpenAI Plugins: Troubleshooting](https://developers.openai.com/apps-sdk/deploy/troubleshooting)
- [RFC 9207 (issuer identification)](https://www.rfc-editor.org/rfc/rfc9207)
- [MCP authorization specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
