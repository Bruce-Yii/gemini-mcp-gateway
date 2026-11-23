# Client profiles / platform registry — design & configuration example

> **Status: DESIGN ONLY.** This document and the three JSON files in
> `templates/client-profiles/` are a **configuration/registry design proposal**.
> **The current runtime does NOT read these files.** `src/client-profile.js`
> hard-codes three frozen profile objects; `src/oauth.js` hard-codes its redirect
> allowlist and DCR switch. Adding or editing these JSON files changes **no
> behavior** — no encoding, no OAuth validation, no tool surface, no deployment.
> Nothing here is "already in effect". Evidence base: `src/client-profile.js`,
> `src/oauth.js`, [CLIENTS.md](../CLIENTS.md), and
> [WEB-CLIENTS.md](WEB-CLIENTS.md) (survey grabbed 2026-11-23). No code,
> tests, README, workflows, or other docs are changed by this work.

## 1. Files in this design

| File | Platform | Status in reality | Encoding target | OAuth callback shape |
|---|---|---|---|---|
| `templates/client-profiles/gemini.json` | Gemini web custom apps | **Tested baseline** | text JSON only, no `structuredContent` | Google relay hosts `oauth-redirect*.googleusercontent.com` + `/r/` or `/a/` |
| `templates/client-profiles/chatgpt.json` | ChatGPT web connectors | Untested design target | text JSON **+** `structuredContent` | `https://chatgpt.com/connector_platform_oauth_redirect` and `https://chatgpt.com/connector/oauth/<callbackId>` |
| `templates/client-profiles/claude.json` | Claude.ai web connectors | Untested design target | text JSON, `structuredContent` off | `https://claude.ai/api/mcp/auth_callback` (**not allowed by current code**) |

Each JSON expresses: `clientPlatform`, `displayName`, result encoding
(`textJson` / `structuredContent`), default annotations, OAuth callback
allowlist, scopes, and explicit `knownLimitations` / `unverified` arrays.
Fields marked as design target are documented as **not implemented** in the
file itself; do not read them as current capabilities.

### 1.1 What the code actually does today (for comparison)

- `src/client-profile.js` exports frozen `CLIENT_PROFILES`: gemini
  `{structuredContent:false, textJson:true, annotations:true}`, claude the
  same, chatgpt `{structuredContent:true, ...}`. Resolution is by explicit
  header `x-gateway-client-profile`, `initialize` body `clientInfo.name`,
  explicit User-Agent token, or explicit env opt-in; unknown → gemini.
  `applyProfileToTools()` keeps annotations **identical across all profiles**
  and only fills benign defaults when a tool has no annotations at all.
- `src/oauth.js` allowlists only Google relay hosts and the two documented
  ChatGPT callback shapes. `SCOPES = mcp, openid, email, profile,
  offline_access`. Refresh tokens are explicitly non-rotating. DCR is off in
  LOCKED mode except for the narrow `ALLOW_DCR_FOR_CHATGPT=1` carve-out.
- Therefore: the ChatGPT `readOnlyHint` default and the Claude callback entry
  in these JSON files are **proposals that require a future code/config change**;
  they are not descriptions of the running gateway.

## 2. Isolation boundary: one owner, multiple platforms

This registry is an **adapter/organization scheme for a single owner**. It is
**not multi-tenant and not user isolation**.

- One gateway owner / one deployment / one upstream credential set. Profiles
  only choose how an already-computed result is encoded; they never inspect
  credentials, never change tool names/count/schemas/execution semantics.
- What **is** separated per platform:
  - **OAuth client**: separate client registration per platform (Gemini
    pre-registered locked client, ChatGPT DCR client behind its own switch,
    Claude/manual client if ever enabled). Never reuse one client's
    secret/redirect set across platforms.
  - **Profile**: explicit `x-gateway-client-profile` / `clientInfo.name`
    declaration; unknown or ambiguous falls back to gemini. Encoding is chosen
    per request, not per user.
  - **Capture tags**: every `/mcp` envelope should carry a platform/profile tag
    (via the existing session marker / capture metadata) so online traffic can
    be attributed to a lane without mixing identities.
  - **Eval lane**: separate L1/smoke baselines per profile. Do not merge scores
    across platforms; compare each profile against its own baseline.
- What is **not** separated: tenant identity, per-user quotas, per-user
  authorization, or data visibility between users of the same owner. A
  "platform" here is a client integration, not a tenant.

## 3. Conflict with the existing locked client (ChatGPT)

The deployed gateway runs in **LOCKED mode** (`ALLOWED_CLIENT_ID` set), which
disables dynamic client registration so a random person with the URL cannot
self-register. ChatGPT connectors normally rely on DCR. Conflict and handling:

- `src/oauth.js` already contains a narrow escape hatch:
  `ALLOW_DCR_FOR_CHATGPT=1` enables DCR **only** when every redirect is a
  documented ChatGPT callback and the registration metadata identifies an
  OpenAI client (`client_name`/`client_uri`, or
  `token_endpoint_auth_method` = `none` / `private_key_jwt`). Arbitrary hosts
  are still rejected, and the Gemini pre-registered client id/secret are
  untouched.
- Recommendation (no code change made here):
  - keep the switch **off** by default;
  - if ChatGPT support is pursued, use a **separate toggle and config name**,
    suggested `oauth.chatgptDcr.enabled` with profile name
    **`chatgpt-dcr`** (see `templates/client-profiles/chatgpt.json`), so the
    Gemini locked client and its secret remain isolated;
  - alternatively pre-register a dedicated ChatGPT client id/secret rather than
    opening DCR at all;
  - Claude's manual client-id/secret path additionally needs its callback
    `https://claude.ai/api/mcp/auth_callback` added to the allowlist — a code
    change that is explicitly **out of scope** of this design task.
- These are suggestions for a future implementation. Nothing is enabled by
  creating the JSON files.

## 4. Acceptance checklist (for a FUTURE implementation, not this change)

Use this list when someone actually wires the registry into the runtime and
tests each platform. It is **not** a claim that these checks pass today.

- [ ] **OAuth redirect**: for each profile, confirm the exact allowlist from
      its JSON: Gemini Google relay hosts + `/r/`/`/a/`; ChatGPT stable
      `chatgpt.com/connector_platform_oauth_redirect` and
      `chatgpt.com/connector/oauth/<id>`; Claude
      `claude.ai/api/mcp/auth_callback` (requires a code change first). Verify
      DCR is off in LOCKED mode except the explicit `chatgpt-dcr` carve-out.
- [ ] **tools/list**: each platform sees all three tools — `search`,
      `execute_read`, `execute` — in stable order, with sanitized flat schemas
      and `server__tool` names; no mid-session schema changes.
- [ ] **Result encoding**: Gemini/Claude results are text JSON only with no
      `structuredContent` leakage; ChatGPT carries both `structuredContent`
      and the same JSON text block; annotations include the required hints.
- [ ] **Baseline accounting (分账)**: capture/eval lanes are tagged per profile;
      each platform's L1 baseline (completion rate / toolHit / tokens / p95) is
      compared to its own baseline, and platform tags never mix with tenant
      identity. Capture ack/done reconciliation (`A===D`,
      `R+dropped===A`) must still hold.

## 5. Out of scope / non-goals

- No runtime code, scripts, tests, README, other docs, or workflow changes.
- No multi-tenant or per-user isolation.
- No claim that ChatGPT/Claude connections work; both are untested targets.
- No commit, push, or deployment.
