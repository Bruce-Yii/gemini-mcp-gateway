# Auth provider study: Notion / Linear / Vercel MCP token lifecycles

Status: research note for lead decision-making. No code was changed, no commit/push/deploy was made.

All findings are dated. "Fetched 2026-11-23" means the URL was retrieved with `web_fetch` / `curl` on that date (Asia/Singapore time). Live metadata was probed directly on 2026-11-23 — it can drift, so re-probe before implementing. Third-party reports are explicitly labelled as such; official docs take precedence.

---

## 0. Executive summary for lead (decision-ready)

1. **Notion MCP** is the only one of the three where the hosted server natively supports both interactive OAuth 2.1 **and** a static bearer "MCP token" (Business/Enterprise, owner-created). OAuth grants use ~8h access tokens, **rotating refresh tokens** with a one-step reuse window, 180-day max grant, and aggressive theft containment: replaying a rotated-away refresh token **revokes the whole grant**. The gateway can and should own an independent DCR client + grant; never share a rotating refresh token with DSH or any other client. (URLs: [Notion MCP client guide](https://developers.notion.com/guides/mcp/build-mcp-client.md), [Notion MCP setup FAQ](https://developers.notion.com/guides/mcp/get-started-with-mcp.md) — fetched 2026-11-23.)
2. **Linear MCP** interactive flow is OAuth 2.1 + DCR, but the hosted server **also accepts a bearer API key directly** (documented FAQ). Underlying Linear OAuth: 24h access, **30-day refresh tokens, rotating with a 30-minute retry window for a lost refresh response**. Client-credentials (app actor) is an alternative with 30-day non-refreshable tokens. A PAT path exists without self-hosting: point the official hosted MCP at `https://mcp.linear.app/mcp` with `Authorization: Bearer <PAT>`. Mature third-party PAT MCP servers exist but are low-star niche projects — prefer the official endpoint with a PAT. (URLs: [Linear MCP docs](https://linear.app/docs/mcp.md), [Linear OAuth 2.0](https://linear.app/developers/oauth-2-0-authentication.md) — fetched 2026-11-23.)
3. **Vercel MCP** is OAuth-only. `offline_access` is advertised by the **authorization server** (`https://vercel.com`) but **not** by the MCP protected-resource metadata (`https://mcp.vercel.com` publishes only `openid`) — a client that follows only PR metadata (still valid perSEP-2207/MCP spec) gets a **1-hour access token and no refresh token**. The gateway must explicitly add `offline_access` to the scope when the AS advertises it. Client registration requires CIMD or an approved client (DCR is available at `https://api.vercel.com/login/oauth/register` but clients must be reviewed/approved for the MCP server); CIMD with a public HTTPS `client_id` is the no-review path. (URLs: [Vercel MCP docs](https://vercel.com/docs/agent-resources/vercel-mcp.md), live metadata below, [oh-my-pi issue #9909](https://github.com/can1357/oh-my-pi/issues/9909) — fetched 2026-11-23.)
4. **Protocol bottom line**: OAuth 2.1 §4.3.1, RFC 9700 §2.2.2/§4.14.2, and MCP SEP-2207 all converge on: refresh tokens are bound to a **client** (and grant); public clients must rotate or sender-constrain; replay of an invalidated token triggers revocation of the active token **and the associated grant**. Therefore **two independent OAuth clients (DSH and this gateway) must never share a rotating refresh token** — doing so is a protocol-level grant-binding violation and, on Notion, is an operational self-revoke. Each client needs its own registration and its own grant.

---

## 1. Provider table

| Provider | Auth methods (hosted MCP) | Access-token lifetime | Refresh behavior | DCR / client registration | Static option | Gateway-owned grant feasible? |
|---|---|---|---|---|---|---|
| **Notion** (`https://mcp.notion.com/mcp`) | (a) OAuth 2.1 auth-code + PKCE, DCR or CIMD; (b) static **MCP token** bearer (Business/Enterprise, owner-only); (c) enterprise-managed ID-JAG exchange (Enterprise + SAML, no refresh token) | ~8 h, **use `expires_in`** (official says duration subject to change) | Rotating on **every** refresh, new `refresh_token` returned; at most **2 valid at once** (current + previous one-step window); grant max **180 days**; replay of an old token **revokes whole grant**; `invalid_grant` is terminal → reauthorize | `registration_endpoint: https://mcp.notion.com/register` (live-confirmed); `client_id_metadata_document_supported: true`; public client via `token_endpoint_auth_method: none`; also `client_secret_basic/post`, `private_key_jwt` | **Yes** — MCP token (owner-created, non-interactive); old `notion-mcp-server` OSS uses integration token but is unmaintained | **Yes, recommended**: gateway registers its own client (persist credentials!) and completes its own consent → independent grant; or static MCP token if no per-user delegation is needed |
| **Linear** (`https://mcp.linear.app/mcp`) | (a) OAuth 2.1 auth-code + PKCE (interactive, DCR/CIMD), (b) **bearer API key / PAT or OAuth access token directly** in `Authorization`, (c) enterprise-managed (Okta) / Claude-issued managed auth | 24 h (`expires_in: 86399`) for auth-code; 30 days for client-credentials (no refresh) | **Rotating**: refresh yields new access + new refresh; refresh validity **30 days from issuance**, reset on each successful refresh; **30-minute retry window** if the refresh response is lost and you need to recover replacement credentials; coordinate refreshes across processes | `registration_endpoint: https://mcp.linear.app/register` (live-confirmed); `client_id_metadata_document_supported: true`; `token_endpoint_auth_methods: client_secret_basic, client_secret_post, none`; scopes `read write openid email` | **Yes, official**: PAT/API key as bearer to the hosted MCP endpoint; read-only option with a `Read`-only key or `/mcp/readonly` | **Yes**: gateway obtains its own OAuth client/grant, or uses a gateway-owned PAT. If OAuth, keep gateway refresh state strictly separate from DSH's |
| **Vercel** (`https://mcp.vercel.com`) | OAuth 2.1 only. CIMD (no review) or reviewed/approved client. No static token for the hosted MCP (Vercel REST API has static team/account tokens but those are not MCP auth) | **1 hour** when `offline_access` is not requested (empirical, third-party + live metadata); with refresh token, assume short and honour `expires_in` | Refresh grant supported by AS; **only issued when the client asks for `offline_access`** (empirical). Rotate behaviour not documented publicly — persist whatever `refresh_token` is returned | MCP server requires **CIMD or Vercel-approved client** (docs); AS has `registration_endpoint: https://api.vercel.com/login/oauth/register` (live-confirmed), `client_id_metadata_document_supported: true` | No static option for MCP | **Yes**: gateway uses its own CIMD `client_id` (HTTPS URL hosting metadata) and explicitly requests `scope=openid offline_access` (+ any resource scopes needed), then persists the refresh token in the vault |

---

## 2. Per-provider detail

### 2.1 Notion MCP

**Auth methods.** Official "Build an MCP client for Notion" requires OAuth 2.0/2.1 auth-code with PKCE, Streamable HTTP, refresh handling and secure storage. Discovery: 401 `WWW-Authenticate` → `https://mcp.notion.com/.well-known/oauth-protected-resource/mcp` → AS `https://mcp.notion.com/.well-known/oauth-authorization-server`. (Fetched 2026-11-23: https://developers.notion.com/guides/mcp/build-mcp-client.md)

Live AS metadata (curl, 2026-11-23) — notable fields:
```
issuer                     https://mcp.notion.com
authorization_endpoint     https://mcp.notion.com/authorize
token_endpoint             https://mcp.notion.com/token
registration_endpoint      https://mcp.notion.com/register
introspection_endpoint     https://mcp.notion.com/introspect
revocation_endpoint        https://mcp.notion.com/token
grant_types_supported      authorization_code, refresh_token, urn:ietf:params:oauth:grant-type:jwt-bearer
token_endpoint_auth_methods_supported  client_secret_basic, client_secret_post, none, private_key_jwt
code_challenge_methods_supported       S256
client_id_metadata_document_supported  true
scopes_supported           default, ema_issuer:manage
```
Protected-resource metadata: `resource: https://mcp.notion.com/mcp`, `scopes_supported: ["default"]`, `bearer_methods_supported: ["header"]`. **No `offline_access`** — refresh tokens are issued to registered clients by the AS policy, not requested via a scope.

**Static option.** The setup FAQ states: Business/Enterprise workspaces, a **workspace owner** creates an "MCP token" in the Developer portal; the client sends it as a bearer token to `/mcp`, no browser sign-in. The overview FAQ confirms "Notion MCP supports OAuth authorization and MCP tokens". Enterprise + SAML can instead use ID-JAG (assertion) exchange — that flow has **no refresh token** (~8h access, re-exchange assertion when expired). (Fetched 2026-11-23: https://developers.notion.com/guides/mcp/get-started-with-mcp.md and https://developers.notion.com/guides/mcp/enterprise-managed-authorization.md)

Note: the REST API separately accepts internal tokens / PATs (https://developers.notion.com/reference/authentication.md, fetched 2026-11-23), but those are for `api.notion.com`, **not** a documented input to the hosted MCP server. Do not send a REST integration token to `mcp.notion.com` expecting it to work; the old OSS `notion-mcp-server` that used integration tokens is explicitly "no longer actively maintained" per Notion's FAQ.

**DCR / scopes / token endpoint / errors.** DCR is RFC 7591 at `/register` (public client with `token_endpoint_auth_method: "none"`, `grant_types: ["authorization_code","refresh_token"]`, `response_types: ["code"]`, one HTTPS redirect URI). CIMD is supported and preferable for durability. Authorization and token requests must carry `resource=https://mcp.notion.com/mcp` (RFC 8707). Introspection at `/introspect` (RFC 7662): a client can only introspect **its own** tokens; a token issued to another client returns only `{"active": false}`.

Error semantics from official guide (fetched 2026-11-23, same URL):
- `invalid_grant` on refresh = refresh invalid/expired/revoked/**superseded by rotation** → **terminal**, clear tokens and reauthorize; do **not** retry-loop.
- `invalid_client` = client credential mismatch.
- `temporarily_unavailable` / network → retry with backoff.
- HTTP 401 on MCP → `WWW-Authenticate` with `resource_metadata`; 403 = insufficient scope; 400 = malformed request (MCP spec).
- Refresh 5–10 minutes before expiry; serialize refreshes per grant with a mutex/distributed lock.

**Rotation specifics (quoted from official guide):** every refresh returns a new refresh token and retires the sent one; **at most two refresh tokens are valid** (current + immediately previous, one-step window) so a transient storage failure allows one retry with the previous token; replay of a token rotated away more than a brief grace period earlier is treated as **theft → whole grant revoked**, all access/refresh tokens for the connection die, user must reauthorize from scratch. Grant max 180 days from authorization. Access ~8h, always trust `expires_in`.

**Identity fields** (`user_id`, `workspace_id`, `email_domain`, `bot_id`, `workspace_name`, `workspace_icon`) are returned **only on the authorization-code exchange**, not on refresh — persist them on first exchange. MCP access tokens are MCP-only; do not send them to the REST API. OIDC identity scopes (`openid`/`profile`/`email`) are allowlisted by Notion, not generally available.

**Gateway-owned grant.** Feasible and recommended:
- Use a **stable CIMD URL** (e.g. `https://<gateway-domain>/.well-known/mcp-client.json`) as `client_id` — no registration to lose. If using DCR, persist `client_id`/`client_secret` durably: **re-registering orphans prior grants** (official guide).
- Complete the gateway's own consent flow; store access+refresh+identity fields keyed by gateway client ID and Notion workspace.
- One connection = one mutex; atomic write of new refresh token before next MCP request.
- If DSH also connects Notion, it must have its own client/grant. Two clients sharing one rotating token is both a spec violation and a direct trigger for Notion's revoke-the-grant behaviour.

### 2.2 Linear MCP

**Is the official MCP OAuth-only?** No — the official docs explicitly allow bearer credentials. From the MCP setup page (fetched 2026-11-23, https://linear.app/docs/mcp.md): "The interactive setup flow uses OAuth 2.1 with dynamic client registration. **You can also authenticate directly with a bearer token or Linear API key** — see the FAQ for details." FAQ: "The MCP server supports passing OAuth token and API keys directly in the `Authorization: Bearer <yourtoken>` header instead of using the interactive authentication flow... For an alternative read-only approach with your own API key, create a Linear API key with only the `Read` permission enabled." Read-only endpoints: `/mcp/readonly` or standard `/mcp` with only the `read` scope. Multi-workspace needs separate auth contexts (e.g. `MCP_REMOTE_CONFIG_DIR` per workspace).

Live MCP AS metadata (curl 2026-11-23): `https://mcp.linear.app/.well-known/oauth-authorization-server` — `issuer: https://mcp.linear.app`, `authorization_endpoint: /authorize`, `token_endpoint: https://mcp.linear.app/token`, `registration_endpoint: https://mcp.linear.app/register`, `grant_types: authorization_code, refresh_token, jwt-bearer`, `token_endpoint_auth_methods: client_secret_basic, client_secret_post, none`, `scopes_supported: read, write, openid, email`, `S256`, `client_id_metadata_document_supported: true`. No `offline_access` advertised — refresh is issued by AS policy.

**Underlying Linear OAuth (for gateway-owned app)** — official https://linear.app/developers/oauth-2-0-authentication.md (fetched 2026-11-23):
- Authorize `https://linear.app/oauth/authorize`; token `POST https://api.linear.app/oauth/token` (form-urlencoded). Scopes (comma-separated): `read` (always), `write`, `issues:create`, `comments:create`, `timeSchedule:write`, `admin`, `oauth:create`, plus app-actor scopes (`customer:read/write`, `initiative:read/write`, `customView:read`, `app:mentionable`, `app:assignable`). `actor=user|app`, `prompt=consent`, `state`, PKCE `S256`.
- Access token **24 h** (`expires_in: 86399`). Refresh token **30 days from issuance**, each successful refresh returns a new pair with a fresh 30-day refresh life; API calls don't extend either life. Client credentials (`app` actor): **30 days**, no refresh token, must be toggled on for the app.
- **Rotation**: refresh always returns new access + new refresh. Official note: if the refresh succeeds but the response is lost, **retry with the same refresh token within 30 minutes** of the original successful refresh to recover the replacement credentials; the window is not extended by retrying and doesn't restore revoked/replaced credentials. "**Save the returned credentials together and coordinate refreshes across processes sharing an authorization**." This is a documented single-use-with-short-recovery-window pattern — treat the old token as single-use after 30 min.
- Revocation `POST https://api.linear.app/oauth/revoke`. Installation updates, scope changes, client-secret rotation (for client-credentials only), app deletion can invalidate tokens early. Apps created after 2026-04-01 are all on the new refresh system.

**PAT alternative assessment.** Two viable paths, both without self-hosting:
1. **Official hosted MCP + PAT (recommended)**: send `Authorization: Bearer <LINEAR_PAT>` to `https://mcp.linear.app/mcp` (or `/mcp/readonly` with a read-only key). Documented by Linear, no third-party maintenance risk. PAT is static (no rotation) but is a long-lived credential — scope it read-only where possible and rotate per vault policy.
2. **Third-party PAT-only MCP**: e.g. `adelaidasofia/linear-mcp` (PyPI `adelaidasofia-linear-mcp`), described as "Multi-workspace Linear MCP — PAT auth, drop-in for the official OAuth-only Linear MCP". GitHub API check 2026-11-23: **2 stars, 0 forks, MIT, created 2026-05-23, pushed 2026-11-22, not archived** — actively touched but effectively single-maintainer and unproven. Risk: tool/schema drift vs official MCP, security review burden, bus factor. Do not adopt without lead approval; prefer path 1. (URLs: https://github.com/adelaidasofia/linear-mcp, https://pypi.org/project/adelaidasofia-linear-mcp/ — fetched 2026-11-23.)

**Gateway-owned grant**: feasible either with a gateway-owned Linear OAuth app (24h/30d rotation; persist atomically, serialize refreshes, keep separate from DSH's grant) or a gateway-owned PAT. If DSH uses the hosted MCP with its own OAuth/PAT, the gateway must have a distinct credential — never reuse a refresh token, and preferably use a distinct PAT too so revocation is independent.

### 2.3 Vercel MCP

**Auth methods.** Official https://vercel.com/docs/agent-resources/vercel-mcp.md (fetched 2026-11-23): "Vercel MCP is Vercel's official remote MCP server. It's a remote MCP with OAuth... at `https://mcp.vercel.com`". "Vercel MCP supports clients that use CIMD **or that have been reviewed and approved by Vercel**" — a client-review form is linked. CIMD path: set OAuth `client_id` to an HTTPS URL serving client metadata; redirect URIs HTTPS/custom-scheme/loopback; `logo_uri` PNG/JPEG <100 KB; users still approve each connection. That is the gateway's no-review path. (DCR exists at the AS level — live metadata shows `registration_endpoint: https://api.vercel.com/login/oauth/register` — but the MCP docs make client review/CIMD the gate for connecting; do not assume arbitrary DCR clients are accepted by `mcp.vercel.com`.)

Live metadata (curl 2026-11-23):
```
PRM https://mcp.vercel.com/.well-known/oauth-protected-resource
  resource https://mcp.vercel.com/ ; authorization_servers ["https://vercel.com"]
  scopes_supported ["openid"]      <-- NO offline_access
AS  https://vercel.com/.well-known/oauth-authorization-server
  authorization_endpoint https://vercel.com/oauth/authorize
  token_endpoint         https://api.vercel.com/login/oauth/token
  revocation_endpoint    https://api.vercel.com/login/oauth/token/revoke
  scopes_supported       openid, email, profile, offline_access, ema_issuer:manage
  grant_types_supported  authorization_code, client_credentials, refresh_token, device_code, jwt-bearer
  client_id_metadata_document_supported true, code_challenge_methods_supported S256
```

**Lifetime / offline_access.** Third-party but detailed wire evidence, https://github.com/can1357/oh-my-pi/issues/9909 (body via GitHub API, 2026-11-23): without `offline_access`, `mcp.vercel.com` issues a **1-hour** access token and **no refresh token**; the reporter's stored credential showed `expires` exactly 3600 s after mint and `refresh: ""`. Root cause was their client taking scopes solely from PR metadata (`openid`) instead of augmenting from AS metadata. Claude Code works because it includes `offline_access` by default when the AS advertises it. Treat "1 h without offline_access" as empirical (not a published Vercel guarantee), but design for it: **always explicitly request `offline_access` for the gateway grant.**

Vercel's own Connect docs reinforce the model (https://vercel.com/docs/connect/providers.md, fetched 2026-11-23): "Declare `refresh_token` in `grant_types_supported` and issue refresh tokens on the authorization code flow. Without them, every expiry sends your user through an authorization prompt again. If you rotate refresh tokens, return the new one in every refresh response." Tokens handed to user code are short-lived; Vercel Connect stores/refreshes them (`https://vercel.com/docs/connect/concepts/tokens.md`, fetched 2026-11-23). Vercel's OAuth docs for Integrations also describe `offline_access` as the way to get refresh tokens (community/issue evidence above plus AS metadata; official Integration docs not pinned to a specific lifetime here — do not hard-code one, use `expires_in`).

**Gateway independent grant + persistence recipe:**
1. Host a CIMD document at a stable HTTPS URL with `client_id` = that URL, `redirect_uris` including the gateway callback, `token_endpoint_auth_method: none` (+ PKCE S256), `grant_types: ["authorization_code","refresh_token"]`.
2. Authorization request: `response_type=code`, `client_id=<CIMD URL>`, `redirect_uri=<gateway callback>`, `code_challenge`/`S256`, `state`, `resource=https://mcp.vercel.com/`, and **`scope=openid offline_access`** (add `email profile` only if needed).
3. Token exchange at `https://api.vercel.com/login/oauth/token` with `code_verifier`, `resource`, same `redirect_uri`; persist `access_token`, `refresh_token`, `expires_in` in the vault keyed by gateway client id + Vercel account. If AS rotates, persist the new refresh token atomically.
4. Refresh proactively from `expires_in`; on `invalid_grant`, drop and reauthorize. Keep this grant entirely separate from DSH's Vercel credentials (`%APPDATA%\com.vercel.cli\Data\auth.json` CLI login is a different credential family — do not mix).

---

## 3. MCP SEP-2207 / OAuth 2.1 / RFC 9700 — normative requirements

### 3.1 SEP-2207 "OIDC-Flavored Refresh Token Guidance" (Final, created 2026-02-04)
Source: https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/seps/2207-oidc-refresh-token-guidance.md (fetched 2026-11-23; canonical https://modelcontextprotocol.io/seps/2207-oidc-refresh-token-guidance).

- MCP Clients that want refresh tokens and can store them securely **SHOULD** advertise `refresh_token` in `grant_types` client metadata.
- They **MAY** add `offline_access` to the requested scope **when the AS metadata lists `offline_access` in `scopes_supported`**, augmenting the resource's scopes — never assume it guarantees issuance.
- MCP Servers (Protected Resources) **SHOULD NOT** put `offline_access` in `WWW-Authenticate` `scope` or in PRM `scopes_supported` — refresh is a client↔AS concern, not a resource requirement.
- Rationale: pure OAuth 2.1 has no standard "give me a refresh token" scope; OIDC/`offline_access` is the convention; clients that don't advertise the grant may be unable to store refresh tokens safely.

Current MCP spec (2026-07-28) absorbed this verbatim into the "Refresh Tokens" section: clients MUST keep refresh tokens confidential, SHOULD include `refresh_token` grant type, MAY add `offline_access` when AS advertises it, MUST NOT assume issuance; servers SHOULD NOT advertise it. Also: CIMD is now SHOULD, DCR is MAY/deprecated-but-supported, and clients MUST validate `iss` per RFC 9207 and include `resource` per RFC 8707 in both authorize and token requests. (Fetched 2026-11-23: https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization.md)

SDK implementation status (verified via GitHub API 2026-11-23): TypeScript SDK PR [#1523 "SEP-2207: Refresh token guidance"](https://github.com/modelcontextprotocol/typescript-sdk/pull/1523) merged 2026-03-30; Python SDK PR [#2039](https://github.com/modelcontextprotocol/python-sdk/pull/2039) merged 2026-04-14. If the gateway uses these SDKs, upgrade to versions that include them; otherwise implement the scope-augmentation yourself.

### 3.2 OAuth 2.1 (draft-ietf-oauth-v2-1-13, §4.3.1–4.3.3, §7.5.2)
Source: https://www.ietf.org/archive/id/draft-ietf-oauth-v2-1-13.txt (fetched 2026-11-23). MCP 2025-06-18 spec requires AS to support OAuth 2.1, PKCE S256 for clients, and rotation/sender-constraining for public clients (https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization.md, fetched 2026-11-23).

- Token endpoint MUST ensure the refresh token was issued to the authenticated client (or matching `client_id`), and that the **grant is still active**.
- For public clients, AS MUST use either sender-constrained refresh tokens (DPoP/mTLS) or **refresh token rotation**: new refresh token on every refresh, previous invalidated, relationship retained. If attacker and legitimate client both present the token, the loser's invalid token signals breach; the AS **revokes the active refresh token as well as the access authorization grant associated with it**, forcing fresh authorization.
- §4.3.2: if a new refresh token is issued, **the client MUST discard the old one and replace it**. §4.3.3: new refresh token's scope MUST be identical to the old one; AS MAY revoke on security events; refresh tokens SHOULD expire after inactivity.
- PKCE is mandatory for public clients; authorization codes single-use; all endpoints HTTPS.

### 3.3 RFC 9700 (OAuth 2.0 Security BCP, January 2025)
Source: https://www.rfc-editor.org/rfc/rfc9700.txt and https://datatracker.ietf.org/doc/html/rfc9700 (fetched 2026-11-23).

- §2.2.2: "Refresh tokens for public clients **MUST** be sender-constrained or use refresh token rotation." RFC 6749 already mandates confidential clients' refresh tokens can only be used by the client they were issued to.
- §4.14.2: AS MUST decide by risk assessment whether to issue refresh tokens; if issued they MUST be bound to the **consented scope and resource servers**; confidential-client binding is already required by RFC 6749. For public clients, rotation means the previous token is invalidated, and on replay detection the AS **revokes the active refresh token** (and OAuth 2.1 adds: the grant). Refresh tokens SHOULD expire after inactivity; MAY be revoked on password change/logout.
- §2.1 / §2.1.1: exact redirect-URI matching, PKCE S256, `iss`/mix-up defence, CSRF `state`.
- §2.3: least-privilege/audience-restricted access tokens.

---

## 4. Why two independent clients must never share one rotating refresh token (explicit protocol basis)

Combine three independent requirements — this is not folklore, it is normative:

1. **Client binding.** OAuth 2.1 §4.3.1: the token endpoint MUST verify the refresh token was issued to the *authenticated client / matching `client_id`*, and that the corresponding grant is still active. RFC 9700 §4.14.2: refresh tokens MUST be bound to the client (confidential clients) and to the consented scope/resources. Two different `client_id`s are two different clients; a token issued to one cannot legitimately be used by the other. (URLs above, fetched 2026-11-23.)
2. **Single-use rotation.** OAuth 2.1 §4.3.1/§4.3.2 and RFC 9700 §2.2.2/§4.14.2: with rotation every refresh invalidates the previous token; the client MUST discard the old token and store the new one. Two consumers refreshing on their own schedules necessarily produce a presentation of an invalidated token — i.e. an indistinguishable replay signal.
3. **Replay = revoke the grant.** OAuth 2.1 §4.3.1: "revoke the active refresh token as well as the access authorization grant associated with it." RFC 9700 §4.14.2: "it will revoke the active refresh token." Notion documents the concrete consequence: replay of a rotated-away token is treated as stolen-token signal and **revokes the whole connection**; it also warns that distributed setups sharing a connection without an atomic token store are the most common cause. Linear similarly instructs processes sharing an authorization to coordinate refreshes. (URLs: Notion client guide and Linear OAuth docs, fetched 2026-11-23.)

Therefore: **DSH and the gateway must each hold their own client registration (or static credential) and their own grant.** If a credential must be transferred between clients, that is a credential-migration with re-authorization, not a shared refresh token. Within one client, serialize refreshes and persist the new refresh token atomically before further use.

---

## 5. Recommended actions (per provider, concrete)

### Notion
- Preferred for user-delegated gateway access: gateway-owned **CIMD** client, own consent, own grant. Fallback: DCR with durably persisted `client_id`/`client_secret` (never re-register casually — it orphans grants).
- Send `resource=https://mcp.notion.com/mcp` on authorize + token + refresh; PKCE S256; validate `iss`, `state`.
- Refresh 5–10 min before `expires_in`; mutex per grant; atomic token write; one-step retry with previous token allowed only for transient storage failure.
- `invalid_grant` → wipe stored tokens, surface reauthorize, no retry loop. Introspect only own tokens.
- If no delegation needed: owner-created static MCP token from vault (Business/Enterprise) — simplest, no rotation, but broad and non-per-user.

### Linear
- Simplest robust path: gateway-owned **PAT/API key** as bearer to `https://mcp.linear.app/mcp` (read-only key + `/mcp/readonly` if writes aren't needed).
- If user delegation is required: gateway-owned OAuth app (or DCR/CIMD against the MCP AS), scopes minimal (e.g. `read,issues:create,comments:create`), `actor=user` or `actor=app`, PKCE; 24h access / 30d rotating refresh; 30-min recovery retry on lost refresh response; coordinate across processes; persist access+refresh together.
- Avoid third-party PAT MCP servers unless lead explicitly accepts maintenance/security risk.

### Vercel
- Gateway CIMD client, explicit `scope=openid offline_access`, `resource=https://mcp.vercel.com/`, PKCE; persist refresh token in vault; on expiry refresh; on `invalid_grant` reauthorize.
- Do **not** rely on PR metadata scopes (`openid` only) — that yields 1h tokens with no refresh (empirical issue #9909). Do **not** reuse Vercel CLI auth.json tokens as MCP tokens.
- Verify after first connect that a non-empty `refresh_token` was actually returned; if not, fail loudly rather than silently accepting hourly expiry.

---

## 6. Risks / open items

- **Notion rotation severity**: a single accidental concurrent refresh (two workers sharing a grant) can revoke the entire connection, not just fail one call. Highest operational risk of the three.
- **Vercel lifetime evidence**: 1h/no-refresh is from a third-party issue and live metadata inference, not a published Vercel SLA. Confirm on first real gateway authorize by reading `expires_in` and presence of `refresh_token`.
- **Vercel client approval**: CIMD avoids review per docs, but Vercel can change approved-client policy; keep the CIMD document stable and owned by the gateway domain.
- **Linear PAT long-lived credential**: no rotation; treat as a secret in the vault, rotate on policy, scope down. DSH-vs-gateway PAT reuse destroys blast-radius separation.
- **DCR durability**: re-registering a client orphans existing grants on Notion; CIMD avoids this. Prefer CIMD where supported (all three advertise it).
- **Spec drift**: MCP 2026-07-28 deprecates DCR in favour of CIMD and adds RFC 9207 `iss` validation — implementations written against 2025-06-18 need updating.
- **No secrets in repo**: all tokens/client secrets stay in `D:\12412\dsh-home\.secrets\gemini-mcp-gateway`; this document contains no credentials.

---

## 7. Source log (all fetched 2026-11-23 unless noted)

Official provider docs:
- https://developers.notion.com/guides/mcp/build-mcp-client.md
- https://developers.notion.com/guides/mcp/get-started-with-mcp.md
- https://developers.notion.com/guides/mcp/overview.md
- https://developers.notion.com/guides/mcp/enterprise-managed-authorization.md
- https://developers.notion.com/reference/authentication.md
- https://developers.notion.com/reference/intro.md
- https://www.notion.com/help/notion-mcp
- https://linear.app/docs/mcp.md
- https://linear.app/developers/oauth-2-0-authentication.md
- https://linear.app/developers/oauth-actor-authorization.md (referenced in Linear OAuth doc)
- https://vercel.com/docs/mcp.md
- https://vercel.com/docs/agent-resources/vercel-mcp.md
- https://vercel.com/docs/connect/providers.md
- https://vercel.com/docs/connect/concepts/tokens.md

Live metadata (curl 2026-11-23):
- https://mcp.notion.com/.well-known/oauth-authorization-server
- https://mcp.notion.com/.well-known/oauth-protected-resource/mcp
- https://mcp.linear.app/.well-known/oauth-authorization-server
- https://mcp.vercel.com/.well-known/oauth-protected-resource
- https://vercel.com/.well-known/oauth-authorization-server

Specs / standards:
- https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/seps/2207-oidc-refresh-token-guidance.md
- https://modelcontextprotocol.io/seps/2207-oidc-refresh-token-guidance
- https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization.md
- https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization.md
- https://www.ietf.org/archive/id/draft-ietf-oauth-v2-1-13.txt
- https://www.rfc-editor.org/rfc/rfc9700.txt
- https://datatracker.ietf.org/doc/html/rfc9700

Cross-checks / third-party (labelled):
- https://github.com/can1357/oh-my-pi/issues/9909 (body via GitHub API; wire evidence for Vercel 1h/no-refresh)
- https://github.com/adelaidasofia/linear-mcp and https://pypi.org/project/adelaidasofia-linear-mcp/ (PAT MCP alternative; 2 stars/0 forks as of 2026-11-23)
- https://github.com/modelcontextprotocol/typescript-sdk/pull/1523 (merged 2026-03-30), https://github.com/modelcontextprotocol/python-sdk/pull/2039 (merged 2026-04-14) — SEP-2207 SDK implementations verified via GitHub API
- https://www.redcaller.com/docs/references/mcp-client-oauth-refresh-token-support?rev=june2026 (third-party SDK support matrix; not authoritative)
