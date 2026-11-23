# Platform conformance matrix — Gemini / ChatGPT / Claude (typed-plan + Code Mode)

> Status: **documentation only**. This file records a test matrix and an executable
> conformance checklist. It changes **no code, config, tests, README, other docs,
> workflows, or deployment state**. Nothing was committed, pushed, or deployed.
>
> Scope: B14 typed-plan / adaptive execution. The candidate shape is
> **typed plan primary, Code Mode fallback**; the three-tool surface
> (`search` / `execute_read` / `execute`), context compression, read/write
> layering, capture, and eval lanes remain unchanged. See
> `docs/ledger/batch-14-typed-plan.md` and `scripts/typed-plan-spike.mjs`.
>
> Grab/evaluation date for external claims: **2026-11-23**. Facts marked
> 未验证 / `unknown` have no first-party source or no real-client run behind them;
> do not promote them to pass without evidence. Where the gateway side is
> implemented but untested against a real account, that is stated explicitly.

---

## 0. How to read this document

- **Status values** (per test item and per capability):
  - `pass` — a deterministic local/offline test or a real-client run produced
    evidence in this repository; an evidence link is given.
  - `fail` — a test reproduced a mismatch, or the code demonstrably does not
    implement the capability.
  - `unknown` — no fixture / no real account / no first-party source; **not a
    pass**. `unknown` is the honest default for anything requiring a paid,
    region-gated, or admin-gated client we have not touched.
- **Blocking first launch** (`阻塞首发`) means: if the item is `fail` or unresolved
  `unknown`, the typed-plan launch gate for that platform cannot be claimed.
  `unknown` blocks *the claim*, not necessarily the work — an untested item stays
  `unknown` until someone runs the checklist with a real client and attaches
  evidence.
- **Evidence taxonomy**:
  - `[src]` — current implementation in `src/` at this checkout.
  - `[test]` — deterministic local/offline test in `tests/`.
  - `[doc]` — repository doc with first-party URL citations.
  - `[external]` — vendor docs / community reports; labeled by source quality.
  - `[fixture]` — offline capture fixture consumed by
    `scripts/platform-conformance.mjs` (B13).
  - **No real-client run** has been performed for ChatGPT or Claude. Gemini web
    custom apps are the only actually tested client (`docs/CLIENTS.md:9`).

---

## 1. Executive summary (read this before making any promise)

1. **ChatGPT Free/Plus cannot currently be promised full MCP.** First-party
   plan gating gives full read/write MCP connectors only to Business /
   Enterprise / Education; Pro is read/fetch only; Free/Go are not listed
   (`docs/OPEN-SOURCE/WEB-CLIENTS.md:32`, `docs/CLIENTS-CHATGPT.md:13-17`).
   **The UI being able to create a connector does not mean the capability is
   usable** — plan, region, admin policy, and undocumented schema caps can still
   block tool discovery/calls. Do not advertise typed-plan support on Free/Plus.
2. **Gemini is the only tested baseline**; it also has the strictest surface
   (no `structuredContent`, `sanitizeTool`, stable `__` names, text-JSON results,
   no `notifications/tools/list_changed`) — `AGENTS.md`, `docs/GEMINI-OFFICIAL-DOCS.md`.
3. **The three-tool surface is stable across all profiles**; typed plan must be
   an input shape *inside* `execute` / `execute_read`, never a new tool or a
   fourth tool (`docs/ledger/batch-14-typed-plan.md:6-12`).
4. **Claude's redirect callback is not allowed by the current OAuth code**, and
   CIMD is not implemented for ChatGPT — both are `fail` for first launch unless
   explicitly changed (out of scope for this doc).

---

## 2. Per-platform conformance tables

### 2.1 Gemini web custom apps (tested baseline)

| Axis | Status | Detail / evidence | Blocking first launch? |
|---|---|---|---|
| OAuth / redirect | `pass` | OAuth 2.1 DCR + PKCE S256; Google relay allowlist `oauth-redirect*.googleusercontent.com` + `/r/`/`/a/`; non-rotating refresh tokens. `[src] src/oauth.js:25-31,473-499`; `[doc] docs/GEMINI-OFFICIAL-DOCS.md:16-21`; `[doc] docs/CLIENTS.md:9` full-chain tested. Locked-client mode uses manually entered client id/secret. | No (already conformant) |
| Transport | `pass` | Streamable HTTP single `/mcp`, JSON-RPC over POST, `Accept: application/json, text/event-stream`, GET stream may 405; protocol up to `2025-11-25`, legacy 2024-11-05 SSE unsupported. `[src] src/server.js`; `[doc] docs/OPEN-SOURCE/WEB-CLIENTS.md:31` | No |
| Tool schema / annotations | `pass` | `sanitizeTool` before registration; `__` separator; flat schema; explicit `readOnlyHint`/`destructiveHint`/`openWorldHint` on all three tools (`search` true/false/false, `execute_read` true/false/true, `execute` false/true/true). `[src] src/codemode.js:1314,1341-1343`; `[src] src/sanitize.js:223-249` | No |
| `structuredContent` | `pass` (non-leak) | Gemini profile strips `structuredContent`; result is text JSON only. `[src] src/client-profile.js:29,150-160`; `[test] tests/client-profile.test.js` (gemini strip); `[doc] AGENTS.md:13` | No — must stay this way |
| Tool-list snapshot | `pass` | Frozen order `['search','execute_read','execute']`, no mid-session change; Gemini ignores `notifications/tools/list_changed`; schema changes require `/v1`,`/v2` path. `[src] src/codemode.js:1372`; `[doc] AGENTS.md:11`; `[test] tests/platform-eval.test.js` stable_tools_list | No |
| Plan limits (account) | `pass` (known constraint) | Consumer custom apps: US, 18+, personal Google account, English UI, Activity on; work/school unsupported. Enterprise flow needs client id/secret and fixed redirect. Account-gated, not a product capability failure. `[doc] docs/GEMINI-OFFICIAL-DOCS.md:19` | No — document as precondition |
| Known failure modes | `pass` (documented) | Mega-tool / dozens of tools flagged in review (our 3 are safe); `execute(code)` runs against Google's atomic-tool optimization; schema snapshot breaks if changed in place. `[doc] docs/GEMINI-OFFICIAL-DOCS.md:26-35,63-70` | No |

### 2.2 ChatGPT web connectors (plan-gated, untested end-to-end)

| Axis | Status | Detail / evidence | Blocking first launch? |
|---|---|---|---|
| OAuth / redirect | `pass` (server side) / `unknown` (client side) | Allowlist `chatgpt.com/connector_platform_oauth_redirect` + `chatgpt.com/connector/oauth/<callbackId>`; RFC 9207 `iss` on responses; `offline_access`, `resource` echoed; DCR carve-out `ALLOW_DCR_FOR_CHATGPT=1`; **CIMD not implemented** and `client_id_metadata_document_supported` not advertised. `[src] src/oauth.js:34-56,305-368`; `[doc] docs/CLIENTS-CHATGPT.md:51-78,87-91`. No real ChatGPT end-to-end test. | **Yes** for any ChatGPT claim until real-client run; CIMD is `fail` if client insists on it |
| Transport | `unknown` | Server is Streamable HTTP at public HTTPS `/mcp`; ChatGPT docs say Streamable HTTP recommended, SSE still accepted; no static bearer header field in UI. Real client untested. `[doc] docs/OPEN-SOURCE/WEB-CLIENTS.md:32` | Yes for claim |
| Tool schema / annotations | `unknown` / risk | Undocumented caps: community reports "<5000 tokens all tools" and "451 tools/2.43MB fails" — **not officially documented**. Tools without `readOnlyHint` treated as write needing confirmation; `execute` name/description ("Write JavaScript … arbitrary code") may trip security review. Gateway keeps 3 tools with explicit hints + `_meta.securitySchemes`. `[doc] docs/OPEN-SOURCE/WEB-CLIENTS.md:32,64-68`; `[src] src/server.js:324-342` | Yes — must reproduce caps with real account before promising |
| `structuredContent` | `pass` (server encoding) / `unknown` (client consumption) | ChatGPT profile sends both `structuredContent` and same JSON text block; derived from text when absent. `[src] src/client-profile.js:31,162-168`; `[test] tests/client-profile.test.js`; `[fixture] scripts/platform-conformance.mjs chatgpt_dual_encoding` (`docs/ledger/batch-13-platform-eval.md:111`). Real ChatGPT consumption unverified. | No for server; Yes for end-to-end claim |
| Tool-list snapshot | `pass` (invariant) | Same three tools, same order, annotations identical across profiles; additive `_meta` only. `[src] src/server.js:320-342`; `[doc] docs/ledger/batch-11-client-adapter.md:28-36` | No |
| Plan limits | `pass` (documented) / `unknown` (enforcement) | Full MCP = Business/Enterprise/Edu; Pro = read/fetch only; Free/Go not listed; admins publish; web only, not mobile. **Free/Plus cannot be promised.** Pro/Plus read-only restriction is expected client-side; the server does not gate tool names by plan — a valid token can still call `execute`. `[doc] docs/OPEN-SOURCE/WEB-CLIENTS.md:32`; `[doc] docs/CLIENTS-CHATGPT.md:13-17,98-101` | Yes — do not target Free/Plus; Business lane needs admin |
| Known failure modes | `pass` (documented) / `unknown` (real) | CIMD requirement; meta-refresh vs 302 redirect; exact redirect URI mismatch; Pro/Plus write tools still callable server-side; no domain/mTLS/`id_token_hint`/profile tool; resource tokens not aud-bound. `[doc] docs/CLIENTS-CHATGPT.md:80-110` | Yes if the target account hits one |

### 2.3 Claude.ai / Claude Desktop web connectors (untested target)

| Axis | Status | Detail / evidence | Blocking first launch? |
|---|---|---|---|
| OAuth / redirect | `fail` (current code) / `unknown` (client) | **Claude callback `https://claude.ai/api/mcp/auth_callback` is NOT in the current allowlist** — needs a code change. DCR or CIMD default, or user-entered client id/secret; 401 `WWW-Authenticate: Bearer resource_metadata=…` required; discovery/register/token ≤10s, refresh ≤30s; S256 PKCE; refresh rotation for public clients. `[src] src/oauth.js:25-56` (no Claude host); `[doc] docs/OPEN-SOURCE/CLIENT-PROFILES.md:20,91-93`; `[doc] docs/OPEN-SOURCE/WEB-CLIENTS.md:33` | **Yes** — callback allowlist must be added before any Claude connector test |
| Transport | `unknown` | Streamable HTTP recommended, legacy SSE accepted; no stdio on hosted; HTTPS 443 only, Anthropic egress IPv4 `160.79.104.0/21`; private networks need tunnel. Real client untested. `[doc] docs/OPEN-SOURCE/WEB-CLIENTS.md:33` | Yes for claim |
| Tool schema / annotations | `pass` (server) / `unknown` (client) | All tools must declare `readOnlyHint` + `destructiveHint`; gateway emits both (explicit booleans). No documented tool-count cap. `[src] src/codemode.js:1314,1341-1343`; `[src] src/server.js:329-334`; `[fixture] scripts/platform-conformance.mjs claude_annotations` (`docs/ledger/batch-13-platform-eval.md:112`) | No for server; Yes for real client |
| `structuredContent` | `pass` (non-leak) | Claude profile strips `structuredContent`; text JSON + annotations. `[src] src/client-profile.js:30,150-160`; `[doc] docs/ledger/batch-11-client-adapter.md:23-27` | No |
| Tool-list snapshot | `pass` (invariant) | Same three tools, stable order. No documented tool-count cap. `[src] src/codemode.js:1372`; `[doc] docs/OPEN-SOURCE/WEB-CLIENTS.md:33` | No |
| Plan limits | `pass` (documented) | Best supported: Free (1 custom connector), Pro/Max/Ultra/Team/Enterprise; Team/Enterprise only Owners/Library managers add. `[doc] docs/OPEN-SOURCE/WEB-CLIENTS.md:33` | No — widest support, but still untested here |
| Known failure modes | `pass` (documented) | Auth settings cannot be edited after save; cross-host redirect drops Authorization; discovery failure shows "Couldn't reach the MCP server"; result ≤~150,000 chars (we truncate at 8000); tool call timeout 240s. `[doc] docs/OPEN-SOURCE/WEB-CLIENTS.md:33` | No (document as precondition) |

---

## 3. typed-plan compatibility (the core of this matrix)

Candidate shape (from `docs/ledger/batch-14-typed-plan.md:23-33` and
`scripts/typed-plan-spike.mjs`):

```text
Profile F (current):  execute({ code })                 自由 JS
Profile S (candidate): execute_read({ plan: [...] })     typed ops (read)
                       execute({ plan: [...] })          typed ops (write needs dryRun/approve)
                       execute({ code })                 fallback for complex tasks
```

The spike's op registry is `readFileRange`, `repoGrep`, `ensureBranch`,
`applyPatch`, `openPr`, `runChecks`; validation is structural and whole-plan
before any handler runs; write ops require `dryRun:true` or `approve:true`
(`scripts/typed-plan-spike.mjs:36-86,128-175`). None of this is wired to production.

### 3.1 Compatibility matrix

| # | Compatibility question | Gemini | ChatGPT | Claude | Evidence | Blocking? |
|---|---|---|---|---|---|---|
| C1 | **`plan` field accepted by client schema?** | `unknown` | `unknown` | `unknown` | Current `execute`/`execute_read` `inputSchema` is `{type:'object', properties:{code:{type:'string'}}, required:['code']}`; no `plan` property, and `sanitizeTool` keeps `additionalProperties` only if declared (it is not). A `{plan:[...]}` argument will be **rejected by client-side schema validation** until the tool inputSchema is changed to accept `plan`. `[src] src/codemode.js:1336-1340`; `[src] src/sanitize.js:24-37,210-215`. Also unresolved: whether each client's function-calling schema supports arrays-of-objects with mixed primitive fields after sanitize (Gemini caps `oneOf` at 8, arrays need `items`). `[doc] docs/GEMINI-OFFICIAL-DOCS.md:41-55` | **Yes** — schema change is a prerequisite for Profile S on all platforms; changing it in place breaks Gemini's snapshot, so use a version path (`/v1`,`/v2`) |
| C2 | **Three tool names/count unchanged?** | `pass` | `pass` | `pass` | Conformance invariant: tools exactly `['search','execute_read','execute']` in that order; `applyProfileToTools` never changes names/count/schema. `[src] src/codemode.js:1372`; `[src] src/client-profile.js:224-231`; `[test] tests/platform-eval.test.js` stable_tools_list; `[doc] docs/ledger/batch-14-typed-plan.md:6-12` | No — must be preserved |
| C3 | **Result encoding** | `pass`: text JSON only, no `structuredContent` | `pass` server / `unknown` client: `structuredContent` + same JSON text | `pass` server / `unknown` client: text JSON + annotations, no `structuredContent` | `[src] src/client-profile.js:29-31,150-168`; `[test] tests/client-profile.test.js`; `[fixture] scripts/platform-conformance.mjs` gemini_no_structured_content / chatgpt_dual_encoding / claude_annotations (`docs/ledger/batch-13-platform-eval.md:108-113`). Typed-plan step results are plain objects → same encoding path; ChatGPT will derive `structuredContent` from the plan result object. | No for server; Yes for end-to-end claim |
| C4 | **Write confirmation / approval** | `pass` (client gating) / `unknown` (plan-specific) | `unknown` | `unknown` | Today: `execute` annotated `destructiveHint:true`, `execute_read` read-only stub for write tools; clients gate confirmation on annotations, and annotations are **not a security boundary** (`docs/SANDBOX-SECURITY.md:37`). Typed-plan adds in-band `dryRun`/`approve` in the spike (`scripts/typed-plan-spike.mjs:168-173`), but B14 explicitly does **not** let typed plan replace the write path/idempotency/approval (`docs/ledger/batch-14-typed-plan.md:51-56`). Need a test that the client confirmation UX still triggers for plan writes. | **Yes** — must prove approval still surfaces; currently only structural validation, no client UX test |
| C5 | **Tool-list freeze / versioning** | `pass` | `pass` | `pass` | Server keeps list stable; Gemini doesn't consume `list_changed`; schema change requires version path. `[doc] AGENTS.md:11`; `[doc] docs/OPEN-SOURCE/WEB-CLIENTS.md:31,69`. Adding `plan` to inputSchema is a schema change → must be on `/v2` (or equivalent), not in-place, to avoid breaking Gemini's snapshot. | **Yes** — versioning decision required before shipping Profile S |

### 3.2 Additional typed-plan risks (all `unknown` until tested)

- **Client-side plan shape tolerance**: array-of-objects with `op` string + typed
  fields + optional `approve` boolean has not been submitted to any real client's
  function-calling schema. Gemini's sanitizer caps `oneOf`/`anyOf` at 8 branches —
  a plan schema that uses `oneOf` per op type could be silently truncated
  (`src/sanitize.js:141-151`). Prefer a flat step schema with a plain `op: string`
  + `enum` of registry names rather than `oneOf` per op.
- **Step-result trace as text JSON**: `executePlan` returns
  `{ok,dryRun,steps:[{ok,op,result|error}],stoppedAt,error}`
  (`scripts/typed-plan-spike.mjs:180-222`). On Gemini this becomes one text JSON
  block (fine); on ChatGPT the same object becomes `structuredContent` too
  (fine); on Claude text (fine). No client has consumed this shape.
- **`code` fallback coexistence**: Profile S keeps `execute({code})`. The
  tool description currently *only* documents code; adding `plan` means the
  description must describe both without tripping ChatGPT's code-execution
  security review (`docs/OPEN-SOURCE/WEB-CLIENTS.md:32,66`).
- **No client identity guessing**: profile resolution is explicit (header /
  `clientInfo.name` / UA token / env), unknown → gemini (`src/client-profile.js`).
  A real ChatGPT/Claude client that declares nothing will get Gemini encoding —
  by design (`docs/ledger/batch-11-client-adapter.md:130-134`). Typed-plan tests
  must set the profile explicitly.

---

## 4. Test-item matrix (pass/fail/unknown + evidence + blocking)

Each row is a concrete check. Status is the **current** state at this checkout,
not a target. "Evidence" is where to look today; "Run" tells you what to execute
to move `unknown` → `pass`/`fail`.

### 4.1 OAuth

| ID | Test | Status | Evidence | Blocking first launch? | Run to verify |
|---|---|---|---|---|---|
| A1 | OAuth DCR / custom client registration | `pass` server / `unknown` client | `[src] src/oauth.js:303-393` DCR + PKCE S256, `ALLOW_DCR_FOR_CHATGPT` carve-out; `[src] src/client-profile.js` locked Gemini client; `[doc] docs/CLIENTS-CHATGPT.md:30-47`. Local tests emulate ChatGPT; no real account. | **Yes** (ChatGPT/Claude) | Real ChatGPT Business connector add; real Claude connector add; capture `/oauth/register` request/response |
| A2 | Redirect allowlist per platform | `pass` Gemini+ChatGPT / `fail` Claude | `[src] src/oauth.js:25-56` Google + two ChatGPT shapes, **no Claude host**; `[doc] docs/OPEN-SOURCE/CLIENT-PROFILES.md:20,91-93` | **Yes** (Claude) | Add `https://claude.ai/api/mcp/auth_callback` then real-client test |
| A3 | 401 `_meta["mcp/www_authenticate"]` challenge | `pass` server / `unknown` client UI | `[src] src/vercel-app.js:149-168` — 401 body carries top-level `error`, `error_description`, additive `_meta` array with `error`/`error_description`; `WWW-Authenticate` header preserved. `[doc] docs/CLIENTS-CHATGPT.md:66-70` | No for server; Yes for UI claim | Unauthenticated `tools/list` → assert 401 body + header; real ChatGPT linking UI appears |
| A4 | CIMD support | `fail` | `[doc] docs/CLIENTS-CHATGPT.md:87-91` not implemented, not advertised; `[src] src/oauth.js` no CIMD fetch | Yes **if** target ChatGPT client requires CIMD | Test with real connector; if it insists on CIMD, implement or pre-register client |
| A5 | Token refresh / non-rotating refresh tokens | `pass` server / `unknown` real | `[doc] docs/CLIENTS-CHATGPT.md:62-65,75-78`; `[doc] docs/CLIENTS.md:19-21` | No for Gemini; Yes for long-running ChatGPT | Exercise refresh past token expiry in each client |

### 4.2 Protocol / tool surface

| ID | Test | Status | Evidence | Blocking first launch? | Run to verify |
|---|---|---|---|---|---|
| B1 | `tools/list` returns exactly `search`,`execute_read`,`execute` in order | `pass` | `[src] src/codemode.js:1372`; `[test] tests/platform-eval.test.js` stable_tools_list; `[fixture] scripts/platform-conformance.mjs` | No | Real `tools/list` per client; assert names/order |
| B2 | Tool annotations explicit and correct | `pass` | `[src] src/codemode.js:1314,1341-1343`; `[src] src/server.js:329-334`; `[doc] docs/ledger/batch-13-platform-eval.md:112` | No | Real `tools/list` per client; assert booleans |
| B3 | Schema sanitized (array `items`, no multi-type, `oneOf`≤8) | `pass` | `[src] src/sanitize.js:102-199`; `[doc] AGENTS.md:12`; `[doc] docs/GEMINI-OFFICIAL-DOCS.md:41-55` | No | Feed typed-plan schema through `sanitizeTool`; assert no truncation hint |
| B4 | Tool-list freeze (no mid-session `list_changed`) | `pass` | `[doc] AGENTS.md:11`; `[src] src/server.js` no `list_changed` notification | No | Observe a long real session; assert no list change |
| B5 | `structuredContent` per platform | `pass` server / `unknown` real | `[src] src/client-profile.js:150-168`; `[test] tests/client-profile.test.js`; `[fixture] docs/ledger/batch-13-platform-eval.md:110-112` | No for server; Yes for end-to-end | Run conformance script on captured fixtures; then real tools/call |

### 4.3 typed-plan execution

| ID | Test | Status | Evidence | Blocking first launch? | Run to verify |
|---|---|---|---|---|---|
| T1 | `plan` accepted by tool inputSchema | `fail` (current schema) | `[src] src/codemode.js:1336-1340` only `code`; `[src] src/sanitize.js` no `plan` | **Yes** | Change schema on version path; re-run real `tools/list` per client |
| T2 | Plan validation rejects unknown ops / bad args before any side effect | `pass` (spike) | `[src] scripts/typed-plan-spike.mjs:128-175` whole-plan validation; `[doc] docs/ledger/batch-14-typed-plan.md:20` | No for spike; Yes for production | Run spike tests; wire only after review |
| T3 | Partial failure / stoppedAt shape stable | `pass` (spike) | `scripts/typed-plan-spike.mjs:191-222` returns `{ok,steps,stoppedAt,error}`; skipped steps not emitted | No | Spike test with injected failing io |
| T4 | Write ops require `dryRun` or `approve` | `pass` structural / `unknown` UX | `scripts/typed-plan-spike.mjs:168-173`; `docs/SANDBOX-SECURITY.md:37` annotations not a security boundary; `docs/ledger/batch-14-typed-plan.md:55` don't replace approval | **Yes** (UX) | Real client: confirm write plan surfaces approval before execution |
| T5 | `code` fallback still works alongside `plan` | `pass` current / `unknown` after schema change | `[src] src/codemode.js:1336-1368` current code path; B14 keeps code fallback | No for current; Yes after change | Regression test + real execute({code}) after change |
| T6 | Result encoding of plan trace (text JSON / dual / text+annotations) | `pass` server / `unknown` real | Same encoding path as C3; `scripts/typed-plan-spike.mjs` result shape | Yes for end-to-end | Capture real tools/call result per client |

### 4.4 Operational / failure paths

| ID | Test | Status | Evidence | Blocking first launch? | Run to verify |
|---|---|---|---|---|---|
| O1 | Session reconnect / stateless handler | `unknown` | `[doc] docs/DSH-CODEMODE-FIT.md:86` DSH reconnect 500ms→30s×10; gateway stateless per POST (`src/server.js`); no real-session reconnect test for the three web clients | No (nice-to-have) | Drop session mid-plan; reconnect; assert no duplicate write |
| O2 | Upstream failure shape (descriptive error vs McpError) | `pass` (gateway) / `unknown` client render | `[doc] docs/GEMINI-OFFICIAL-DOCS.md:53`; `[src] src/server.js:355-357` errorResult; `[src] src/codemode.js` stub errors | No | Inject fake upstream failure via `harness/fake-upstream.mjs`; assert error text |
| O3 | Error shape for validation vs runtime failure | `pass` (spike) / `unknown` client | `validatePlan` returns string[]; `executePlan` returns normalized `{error}` — client rendering untested | No | Real client: show validation error to model; check self-correction |
| O4 | Tool volume / schema-token cap (ChatGPT undocumented) | `unknown` | `[doc] docs/OPEN-SOURCE/WEB-CLIENTS.md:32` community reports 5000 tokens / 2.43MB, not official | **Yes** (ChatGPT) | Real Business account: add connector; if fails, measure tool text tokens |
| O5 | 150k-char result cap (Claude) | `pass` (gateway truncation) | `[doc] docs/OPEN-SOURCE/WEB-CLIENTS.md:33`; gateway truncates at 8000 chars (`docs/GEMINI-OFFICIAL-DOCS.md:42`) | No | Real Claude call with large result |
| O6 | No credentials / secrets in repo or fixtures | `pass` | `AGENTS.md` "不碰真实凭据"; `config.example.json` placeholders only; vault at `D:\12412\dsh-home\.secrets\gemini-mcp-gateway` | No | Grep repo for token patterns before any test artifact is saved |

---

## 5. Explicit non-promises (do not delete or soften)

- **ChatGPT Free/Plus currently cannot be promised complete MCP.** UI connector
  creation is not proof of usable capability: plan gating, admin policy, region,
  undocumented schema caps, and client-side read-only restrictions all apply
  (`docs/OPEN-SOURCE/WEB-CLIENTS.md:32,75-77`; `docs/CLIENTS-CHATGPT.md:13-17,98-101`).
- **Creating a connector in the UI does not equal capability available.** This
  is true for ChatGPT (plan-gated), Gemini (US/personal/18+/English), and Claude
  (admin-gated on Team/Enterprise, and currently blocked by our missing callback
  allowlist).
- **Claude cannot connect today** with the current OAuth allowlist; CIMD and
  Claude callback support are `fail`/not implemented (`docs/OPEN-SOURCE/CLIENT-PROFILES.md:20`).
- **ChatGPT CIMD is not implemented**; if the client requires it, connection fails
  until a code change (`docs/CLIENTS-CHATGPT.md:87-91`).
- **No real-client end-to-end run has been done for ChatGPT or Claude.** All
  server-side `pass` values are local/offline evidence only.
- **Annotations are not a security boundary**; a valid token can still call
  write tools regardless of plan-level read-only expectations
  (`docs/SANDBOX-SECURITY.md:37`; `docs/CLIENTS-CHATGPT.md:98-101`).
- **typed-plan is not production-wired**; the spike is isolated, no production
  registration, no schema, no upstream (`docs/ledger/batch-14-typed-plan.md:20`).

---

## 6. Executable conformance checklist (human / automation)

Run in order. Record status (`pass`/`fail`/`unknown`), evidence id (requestId /
URL / test name), operator, and date. `unknown` is never treated as pass.

### 6.1 Preflight (all platforms, no real client needed)

- [ ] **P1** Confirm three tools unchanged: `node --test tests/platform-eval.test.js` → `stable_tools_list` pass. Evidence: test output.
- [ ] **P2** Confirm annotations explicit: same test suite `claude_annotations` pass; Gemini/ChatGPT tool hints match `src/codemode.js:1314,1341-1343`.
- [ ] **P3** Confirm encoding profiles: `node --test tests/client-profile.test.js` → gemini strip / chatgpt dual / claude text pass.
- [ ] **P4** Offline conformance on captured fixtures: `node scripts/platform-conformance.mjs work/fixtures/`; require `pass` for all applicable checks; `unknown` = no-measurement, `fail` blocks (`docs/ledger/batch-13-platform-eval.md:108-137`).
- [ ] **P5** Typed-plan spike: `node scripts/typed-plan-spike.mjs` and its tests → validation/partial-failure/dryRun pass.
- [ ] **P6** Schema impact: feed the proposed `{plan:[...]}` inputSchema through `sanitizeTool`; assert no `oneOf` truncation, every array has `items`, no multi-type. If truncated/failed → redesign schema.
- [ ] **P7** Version path decision: choose `/v2` (or equivalent) for the schema change so Gemini's snapshot is not broken; record decision.
- [ ] **P8** Secret hygiene: grep repo for token/secret patterns; confirm no real credentials in fixtures or docs.

### 6.2 Gemini (must pass before any typed-plan launch)

- [ ] **G1** Real web custom app connect (US/personal/18+/English UI, Activity on, locked client id/secret or DCR).
- [ ] **G2** `tools/list` shows 3 tools, stable order, sanitized schema; no `list_changed` during session.
- [ ] **G3** `execute({code})` baseline works (control run for Profile F).
- [ ] **G4** `execute_read({plan:[...]})` / `execute({plan:[...]})` accepted by client schema; result is text JSON with no `structuredContent`.
- [ ] **G5** Write plan surfaces manual confirmation; `dryRun` plan performs no writes.
- [ ] **G6** `structuredContent` non-leak verified on wire (`platform-conformance.mjs` gemini_no_structured_content).
- [ ] **G7** Failure shape: validation error and upstream failure both return descriptive text the model can self-correct from.

### 6.3 ChatGPT (target Business/Enterprise/Edu only — NOT Free/Plus)

- [ ] **C1** Confirm target account is Business/Enterprise/Edu and connector is admin-published; **do not run this lane on Free/Plus**.
- [ ] **C2** `GET /.well-known/oauth-authorization-server` → `issuer`, `authorization_response_iss_parameter_supported:true`, `registration_endpoint`, `code_challenge_methods_supported:["S256"]`, `offline_access` (Troubleshooting checklist `docs/CLIENTS-CHATGPT.md:114-117`).
- [ ] **C3** `GET /.well-known/oauth-protected-resource` → `resource: https://<domain>/mcp`, same issuer (`docs/CLIENTS-CHATGPT.md:118-120`).
- [ ] **C4** Confirm `ALLOW_DCR_FOR_CHATGPT=1` is set if DCR path is used; capture exact `redirect_uri`; if not one of the two allowlisted, **do not widen arbitrarily** (`docs/CLIENTS-CHATGPT.md:121-125`).
- [ ] **C5** If client insists on CIMD → record `fail`, stop; either implement CIMD or pre-register a client.
- [ ] **C6** Unauthenticated `tools/list` → 401 with `_meta["mcp/www_authenticate"]` and linking UI shown.
- [ ] **C7** `tools/list` loads; assert 3 tools and explicit `readOnlyHint`; if connector add fails, measure tool text for undocumented cap (O4).
- [ ] **C8** `tools/call` result carries `structuredContent` **and** identical text JSON; run `chatgpt_dual_encoding` on fixture.
- [ ] **C9** `execute({plan})` and `execute({code})` fallback both work; write plan triggers confirmation.
- [ ] **C10** Pro/Plus read-only expectation: with a read-only account, verify write tools are unavailable **client-side**; do not rely on server gating (`docs/CLIENTS-CHATGPT.md:98-101`).

### 6.4 Claude (blocked until prerequisite done)

- [ ] **L0** **Prerequisite**: add `https://claude.ai/api/mcp/auth_callback` to OAuth allowlist (code change, out of scope for this doc) — currently `fail`.
- [ ] **L1** Real connector add with DCR or user-entered client id/secret; record plan (Free/Pro/Team) and admin status.
- [ ] **L2** Discovery/register/token endpoints respond ≤10s; refresh ≤30s; S256 PKCE on every request.
- [ ] **L3** `tools/list` has explicit `readOnlyHint` + `destructiveHint` on all 3 tools (`claude_annotations` pass).
- [ ] **L4** `tools/call` result is text JSON, no `structuredContent`, under ~150,000 chars.
- [ ] **L5** `execute({plan})` accepted; write plan confirmation UX verified; `code` fallback works.
- [ ] **L6** Failure shape + reconnect behavior recorded (O1/O2/O3).

### 6.5 Exit criteria for claiming typed-plan conformance

- All applicable rows in §4 are `pass` for the target platform; no `fail`.
  Any `unknown` on a blocking row means "not claimed", with the reason recorded.
- Evidence chain: requestId / test name / URL attached to each checked row;
  `scripts/platform-conformance.mjs` report included.
- Each platform compared only to its own frozen baseline; no cross-platform
  hard comparison (`docs/ledger/batch-13-platform-eval.md:139-152`).
- If ChatGPT Free/Plus or untested client is in scope → **do not claim**.

---

## 7. Evidence index

Repository (all local, no external fetch performed for this document):
- `AGENTS.md:8-13` — Gemini constraints (sanitize, stable list, `__`, text JSON)
- `docs/CLIENTS.md:7-21` — client status and requirements
- `docs/CLIENTS-CHATGPT.md:13-17,49-110,112-134` — ChatGPT plan matrix, OAuth, limitations, troubleshooting
- `docs/GEMINI-OFFICIAL-DOCS.md:16-21,44-55` — Gemini account gates and protocol/annotation rules
- `docs/OPEN-SOURCE/WEB-CLIENTS.md:31-38,64-69,71-85,87-95` — per-client first-party + community sources
- `docs/OPEN-SOURCE/CLIENT-PROFILES.md:16-43,91-95` — design-only profile registry, Claude callback gap
- `docs/ledger/batch-11-client-adapter.md:21-36,126-134` — encoding adapter facts and limits
- `docs/ledger/batch-13-platform-eval.md:93-113,139-171` — conformance checker and eval lane rules
- `docs/ledger/batch-14-typed-plan.md:6-12,23-56` — B14 invariants, shape, non-goals
- `docs/DSH-CODEMODE-FIT.md:18-44,76-88` — DSH clientOAuth gap (context only)
- `docs/SANDBOX-SECURITY.md:37` — annotations not a security boundary
- `src/codemode.js:1306-1373` — three tools, schemas, annotations
- `src/client-profile.js:29-31,150-168,224-231` — profile encoding and annotation handling
- `src/sanitize.js:24-37,102-249` — Gemini schema sanitizer
- `src/oauth.js:25-56,303-393` — redirect allowlist and DCR
- `src/server.js:320-358` — tools/list `_meta`, CallTool result encoding
- `src/vercel-app.js:149-168` — 401 `_meta["mcp/www_authenticate"]`
- `scripts/typed-plan-spike.mjs:36-86,128-175,191-222` — op registry, validation, execution
- `scripts/platform-conformance.mjs` — offline conformance checker (B13)
- `tests/platform-eval.test.js`, `tests/client-profile.test.js` — deterministic test evidence

External sources are cited inside `docs/OPEN-SOURCE/WEB-CLIENTS.md` and
`docs/CLIENTS-CHATGPT.md`; this document does not re-fetch them. Community
numeric limits are explicitly marked 未验证 there and are not treated as
requirements here.

---

## 8. Change control

This file is the only artifact produced by this task. No `src/`, `scripts/`,
`tests/`, `README`, other `docs/`, or workflow file was modified. No commit,
push, or deploy was performed.
