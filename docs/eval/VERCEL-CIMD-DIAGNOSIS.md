# Vercel CIMD `Invalid client_id` — diagnosis and decision record

Date: 2026-11-23 (Asia/Singapore). Status: **diagnosis + executable experiment plan; no production code changed, no commit/push/deploy.**

Scope of this document: explain why `mcp.vercel.com` rejects our CIMD `client_id` while it accepts Notion's, give a runnable read-only probe (`scripts/vercel-cimd-probe.mjs`) plus fake-only tests (`tests/vercel-cimd-probe.test.js`), and hand the lead a concrete decision tree. It supersedes the open questions in [`VERCEL-CIMD-BLOCKER.md`](./VERCEL-CIMD-BLOCKER.md); that file's conclusion ("externally BLOCKED") is **confirmed and refined** here, not overturned.

---

## 0. Bottom line for the lead (read this first)

1. The failure is **client resolution**, not PKCE, not scope, not consent. Vercel answers `App configuration error / Invalid client_id / The app ID is invalid` *before* it looks at our `code_challenge`. The Notion control, with the **same deliberately broken PKCE**, gets past that step and fails on `code_challenge` — so Vercel's CIMD machinery works and the difference is entirely in *which* `client_id` was presented. (Evidence: prior experiment log in `VERCEL-CIMD-BLOCKER.md` §Result; live Notion CIMD fetched 2026-11-23 from `https://www.notion.so/oauth/mcp-client-metadata.json`.)
2. Our CIMD document is structurally valid (200, JSON, `client_id` == fetch URL, HTTPS redirect URIs) and our code is not obviously wrong. But **"our document is valid" is not the same claim as "Vercel accepts arbitrary third-party hosts"**. Three host/path properties distinguish every candidate we tried from the accepted control: the control is on an **established, stable, non-tunnel, non-gist HTTPS hostname** (`www.notion.so`), uses a **non-`.well-known` path** (`/oauth/mcp-client-metadata.json`), and has a **site-root `client_uri`** (`https://www.notion.so`).
3. Highest-probability cause is **host trust / pre-registration gating** (Vercel's own docs say MCP supports "clients that use CIMD **or that have been reviewed and approved by Vercel**" — [Vercel MCP docs](https://vercel.com/docs/agent-resources/vercel-mcp), fetched 2026-11-23). Second is a metadata requirement we haven't copied (the accepted control has `logo_uri` + `application_type: "web"`; ours has neither, and ours additionally carries `scope` / `code_challenge_methods_supported` / `client_uri = origin/`). Third is SSRF/fetch-path failure on the tunnel/gist (we have a 200 from *our* vantage point, not from Vercel's egress).
4. **BLOCKED condition is met for the production path**: our CIMD cannot currently be served from a stable, Vercel-owned-or-approved HTTPS origin (deploy quota exhausted; `clientId` is still a placeholder per `docs/AUTH-READY.md` §1.3/§2). We must not claim Vercel auth is ready. If the ordered experiments below show that a stable domain with the Notion-shaped document is *still* rejected, treat it as **BLOCKED on Vercel pre-registration/review** and escalate — see §5.

---

## 1. Evidence: Notion CIMD (accepted) vs our CIMD (rejected)

Notion document, fetched verbatim 2026-11-23 from `https://www.notion.so/oauth/mcp-client-metadata.json`:

```json
{"client_id":"https://www.notion.so/oauth/mcp-client-metadata.json","client_name":"Notion","client_uri":"https://www.notion.so","logo_uri":"https://app.notion.com/images/notion-logo-block-main.svg","redirect_uris":["https://www.notion.so/workflows/mcp/oauth/callback"],"grant_types":["authorization_code","refresh_token"],"response_types":["code"],"token_endpoint_auth_method":"none","application_type":"web"}
```

Our document, from `src/vercel-app.js:45-64` (`buildCimdDocument`), served at `GET /.well-known/mcp-client.json`:

```json
{"client_id":"<same URL>","client_name":"Gemini MCP Gateway (Vercel)","client_uri":"<origin>/","redirect_uris":["<origin>/upstream/oauth/callback"],"grant_types":["authorization_code","refresh_token"],"response_types":["code"],"token_endpoint_auth_method":"none","code_challenge_methods_supported":["S256"],"scope":"openid offline_access"}
```

We also tried a public gist variant and an alias path `/oauth/client-metadata.json`, both 200 JSON with minimal fields (`VERCEL-CIMD-BLOCKER.md` §What was attempted).

| Dimension | Notion (accepted → PKCE error) | Ours (rejected → `Invalid client_id`) | Relevance |
|---|---|---|---|
| **Fields** | `client_id`, `client_name`, `client_uri`, `logo_uri`, `redirect_uris`, `grant_types` (auth_code + refresh), `response_types`, `token_endpoint_auth_method: none`, `application_type: web` | same minus `logo_uri`/`application_type`, plus `code_challenge_methods_supported: ["S256"]` and `scope: "openid offline_access"` | No required field is missing from ours. Extra fields are legal RFC 7591 metadata, but `scope` in a CIMD can be interpreted as a *client-wide scope cap*; the accepted control has none. Minimal variant of ours was also rejected → fields alone are **unlikely** root cause, but the two control-only fields are still worth one controlled test. |
| **Host** | `www.notion.so` — established, stable, high-reputation domain | `samples-formula-insulation-sara.trycloudflare.com` (temporary tunnel), `gist.githubusercontent.com` (shared code-hosting domain) | **Strongest discriminator.** A CIMD URL is the client identity; Vercel may trust only hosts it can attribute to a real publisher, or may block tunnel/CDN/shared-hosting ranges. Our 200 is from our vantage point, not Vercel's egress. |
| **Path** | `/oauth/mcp-client-metadata.json` | `/.well-known/mcp-client.json`, alias `/oauth/client-metadata.json`, gist `/raw/<id>/…` | Path shape is not standardised for CIMD (spec only requires an HTTPS URL with a path), so this is low-probability — but it is cheap to include as a probe axis. |
| **`client_uri`** | `https://www.notion.so` — **site root, distinct from the document URL** | `clientId.replace(CIMD_PATH, '/')` → `https://<host>/` (also site root after path removal) | Effectively the same semantics. Not a likely cause, but note the value for our tunnel is a tunnel root, not a real product homepage. Included in probe for completeness. |
| **grant / refresh** | `grant_types: [authorization_code, refresh_token]` | identical | Ruled out. A minimal variant without refresh was also rejected. |
| **scope** | **no `scope` field** | `scope: "openid offline_access"` | Cannot be the *client_id* rejection (that happens before scope is evaluated), and the minimal variant without scope was rejected too. Ruled out for this error; keep for the later token-stage question. |
| **content-type** | `application/json` (served from Notion CDN) | `application/json; charset=utf-8` with `cache-control: public, max-age=3600` | Both valid JSON content types; our own local route test asserts this (`provider-dcr-cimd.test.js:384-398`). Low probability. |
| **Reachability** | Public HTTPS, stable, cached by a major CDN; Vercel demonstrably fetched it | Tunnel URL / gist reachable from our network (200) but **unverified from Vercel's egress**; tunnels are ephemeral and may be blocked by SSRF ranges | **High.** A `client_id` that Vercel cannot fetch is reported at the same pre-consent stage. Our evidence does not prove Vercel fetched ours at all. |

### What the error stage tells us

Authorization-server pipelines are ordered roughly: resolve client from `client_id` → (for CIMD) fetch + validate document → check `redirect_uri`, PKCE, scope → consent. The two observed outcomes bracket the failure precisely:

- Control: same short challenge → **`code_challenge` too short** ⇒ client was resolved, document accepted, request reached PKCE validation.
- Ours: same short challenge → **Invalid client_id / app ID invalid** ⇒ request never reached PKCE validation.

Therefore differences in `scope`, `grant_types`, and `code_challenge_methods_supported` cannot explain *this* error — they would surface later. The discriminating axes are **document URL host/path** and **whether Vercel could actually fetch and attribute the document**, plus any field Vercel uses during identity validation (`client_id` match, `client_uri`, `logo_uri`, `application_type`).

---

## 2. The executable probe (read-only, no login, no token)

Files (new, this task only):

- `scripts/vercel-cimd-probe.mjs` — `runProbe({ fetchImpl, clientIds, controlClientId, ... })`. Every HTTP call goes through the injected `fetchImpl`; the module does nothing on import. CLI defaults to global `fetch` only when invoked directly.
- `tests/vercel-cimd-probe.test.js` — 12 fake-fetch tests, zero network (`node --test tests/vercel-cimd-probe.test.js`: 12/12 pass at time of writing).

### What it actually does

For each case, in order:

1. **Control first**: fetch the known-good Notion CIMD and GET `https://vercel.com/oauth/authorize?...` with the Notion URL as `client_id`.
2. `GET` the candidate CIMD URL itself; record status, `content-type`, and structural checks (`client_id` == fetch URL, non-empty `redirect_uris`, JSON content type). No redirects followed (`redirect: "manual"`).
3. `GET` the authorize endpoint with `client_id=<candidate>` and an **intentionally invalid `code_challenge='short'`** (RFC 7636 requires 43–128 chars). Throwaway `redirect_uri`, fixed `state`, `resource=https://mcp.vercel.com/`, `scope=openid`.
4. Classify the observed response **verbatim**: `client_id_rejected` (Invalid client_id / app ID invalid), `pkce_stage_reached` (code_challenge/PKCE error), `fetch_failed`, `unexpected_no_error`, `unknown`.

### Honesty guarantees (pinned by tests)

- There is **no `accepted: true`** state. The only positive-like signal is `pkce_stage_reached`, explicitly "same stage as control", never "authorization succeeded".
- If the control does not reach `pkce_stage_reached`, `controlOk: false` and all conclusions are suppressed (`CONTROL_FAILED`). No report is interpretable without a working control.
- Cases that return 200 with no error are labelled `unexpected_no_error`, **not** success: no code was requested or received.
- Document-only variants (injected `document` object) are scored `skipped_document_only` — the AS is never queried, so no verdict is fabricated.
- All requests are `GET` with `redirect: 'manual'`; tests assert no `/token` POST, no follow-redirect, no file writes.
- Output contains only status codes, body excerpts and classifications — no credentials, no authorization codes, no tokens.

### Running it (network use is an explicit operator decision; do not run from CI or this task)

```bash
# Minimal: one candidate URL, control runs automatically first
node scripts/vercel-cimd-probe.mjs --client-id https://<stable-host>/oauth/mcp-client-metadata.json

# Matrix in one run (each element a URL string, or {clientId,label,document,contentType})
node scripts/vercel-cimd-probe.mjs --case-file /tmp/vercel-cimd-cases.json
```

The script exits 1 if `controlOk` is false. Save the JSON report **outside the repo** if the operator wants a record — this task itself wrote no report file.

---

## 3. Three most likely causes, and the verification order

### H1 — Host trust / pre-registration gating (most likely)

**Claim.** Vercel's "CIMD or reviewed/approved client" policy is implemented as a host allowlist or a trust signal attached to the domain. `trycloudflare.com` and `gist.githubusercontent.com` are shared/ephemeral hosts and are rejected outright; `www.notion.so` is a known publisher. A 200 JSON document is necessary but insufficient. Docs wording "clients that use CIMD or that have been reviewed and approved by Vercel" ([Vercel MCP docs](https://vercel.com/docs/agent-resources/vercel-mcp)) and the observed stage both fit.

**Discriminating experiment.** Host the **byte-identical Notion document** (only changing `client_id` to its own URL) on a stable, owned HTTPS domain — ideally the eventual gateway production domain. Run the probe on that URL. Also run the current tunnel URL as a negative control in the same invocation.

- If stable-domain URL → `pkce_stage_reached` and tunnel/gist → `client_id_rejected`: H1 confirmed. Fix is operational: deploy/host the CIMD on the stable domain and set `clientId` to it; no code change needed.
- If stable-domain URL → still `client_id_rejected`: H1 escalates to "Vercel pre-registration required" → §5.

### H2 — A CIMD validation requirement we did not reproduce (medium)

**Claim.** The accepted control has two fields ours lacks (`logo_uri`, `application_type: "web"`), and ours has one field the control lacks (`scope`). Vercel docs mention `logo_uri` must be PNG/JPEG <100 KB for CIMD ([Vercel MCP docs](https://vercel.com/docs/agent-resources/vercel-mcp)); a validator may require `application_type` or reject unknown/over-broad fields during identity validation. Note: our **minimal** variant (only required fields) was also rejected, which weakens "extra field breaks it" but does not test the *documented* `logo_uri` requirement.

**Discriminating experiment.** Use the probe's `{ clientId, label, document, contentType }` case form to compare document shapes **on the same stable host** (host must be constant to isolate fields):

| Case label | Document delta from ours |
|---|---|
| `notion-shape` | exactly Notion's field set, `client_id`/redirect URI swapped to ours, `client_uri` = site root, add a real PNG `logo_uri`, `application_type: "web"`, drop `scope` and `code_challenge_methods_supported` |
| `ours-full` | current `buildCimdDocument()` output |
| `ours-minimal` | `client_id`, `client_name`, `redirect_uris` only |
| `ours-plus-logo` | current output + `logo_uri` + `application_type` only |

**Important limitation:** a document that is only injected is scored `skipped_document_only`; it cannot produce a real AS verdict. To test fields against Vercel, each variant must be **actually hosted** at its own HTTPS URL where `client_id` equals that URL. The injected-document mode exists to check structural equivalence offline, not to fake acceptance.

- If `notion-shape` passes on the same host while `ours-full` fails: a field requirement exists; then bisect with `ours-plus-logo` / minimal to find it and raise a code-change task (out of scope here — do not edit `src/` from this task).

### H3 — Vercel cannot fetch our document (SSRF / egress / negative cache) (medium-low, cheap to rule out)

**Claim.** Our evidence "200 JSON" was measured from our network. Vercel's egress may block tunnel domains, private/CGNAT resolutions, or shared gist raw URLs, and CIMD implementations commonly apply SSRF protection plus **negative caching with backoff** after a failed fetch ([mcp-oauth CIMD guide, §Security/Troubleshooting](https://raw.githubusercontent.com/giantswarm/mcp-oauth/refs/tags/v0.2.47/docs/cimd.md)). An unfetchable document yields the same pre-consent `Invalid client_id` class.

**Discriminating experiment.**

1. Confirm the CIMD URL is reachable from a *neutral* network (not our workstation/proxy), with `Accept: application/json`, no redirects, `Content-Type: application/json`, 200.
2. Check DNS: no private/loopback/link-local resolution for the hostname; no redirect chain.
3. Re-probe after ≥5–10 minutes so any negative-cache entry expires; confirm the report is not a cached earlier failure.
4. Compare with a URL on an established domain (H1 case) — if the established domain passes while the tunnel fails even though both serve byte-identical JSON, the difference is fetch/trust, not content.

- If the neutral-network fetch fails or shows a redirect/private IP: fix hosting; this is not an OAuth bug.
- If fetch is clean everywhere and stable-host still fails: H3 eliminated; H1 (pre-registration) stands.

### Ordering rule (do not parallelise blindly)

1. **H3 first** (cheapest, rules out infrastructure noise; includes waiting out negative cache).
2. **H1 second** (single decisive test: stable owned domain + byte-identical Notion-shaped doc). This is the only test that can turn the production path from BLOCKED to unblocked without a code change.
3. **H2 third** (only if H1's stable-domain test passes the control but our shape still fails) — bisect fields on that same passing host.

---

## 4. Probe case checklist (inputs for `--case-file`)

All entries must be real hosted HTTPS URLs except where marked document-only. Control is added automatically; do not include it in the file.

```json
[
  "https://samples-formula-insulation-sara.trycloudflare.com/.well-known/mcp-client.json",
  "https://gist.githubusercontent.com/<owner>/<id>/raw/<sha>/cimd.json",
  "https://<stable-gateway-domain>/.well-known/mcp-client.json",
  "https://<stable-gateway-domain>/oauth/mcp-client-metadata.json",
  "https://<stable-gateway-domain>/oauth/client-metadata.json"
]
```

Document-only offline comparisons (no AS verdict — used to prove structural equivalence before spending hosting effort):

```json
[
  {"clientId":"https://<stable-host>/oauth/mcp-client-metadata.json","label":"notion-shape","contentType":"application/json","document":{"client_id":"https://<stable-host>/oauth/mcp-client-metadata.json","client_name":"Gemini MCP Gateway","client_uri":"https://<stable-host>","logo_uri":"https://<stable-host>/logo.png","redirect_uris":["https://<stable-host>/upstream/oauth/callback"],"grant_types":["authorization_code","refresh_token"],"response_types":["code"],"token_endpoint_auth_method":"none","application_type":"web"}},
  {"clientId":"https://<stable-host>/oauth/mcp-client-metadata.json","label":"ours-full","contentType":"application/json","document":{"client_id":"https://<stable-host>/oauth/mcp-client-metadata.json","client_name":"Gemini MCP Gateway (Vercel)","client_uri":"https://<stable-host>/","redirect_uris":["https://<stable-host>/upstream/oauth/callback"],"grant_types":["authorization_code","refresh_token"],"response_types":["code"],"token_endpoint_auth_method":"none","code_challenge_methods_supported":["S256"],"scope":"openid offline_access"}}
]
```

Record for every case: `cimdFetch.status`, `content-type`, `checks`, `authorize.status`, `authorize.stage`, `errorText` excerpt. Do not collapse `unknown` into a failure or success — re-run or inspect.

---

## 5. BLOCKED criteria and escalation

**We are BLOCKED now** on the production path: no stable HTTPS host for our CIMD, `clientId` is a placeholder, deploy quota exhausted (`VERCEL-CIMD-BLOCKER.md` §Conclusion; `docs/AUTH-READY.md` §1.3/§2). Nothing in this task changes that.

Escalate to **BLOCKED — Vercel pre-registration/review required** (i.e. CIMD path not viable for us) when **all** of the following hold:

1. `controlOk: true` in the same probe run (control reached `pkce_stage_reached`);
2. The candidate CIMD is served from a **stable, owned HTTPS domain**, returns 200 `application/json`, `client_id` equals URL, redirects are HTTPS, and a neutral network confirms reachability (H3 eliminated);
3. A **byte-identical copy of the Notion document shape** at that same host is still classified `client_id_rejected` (H2 eliminated: fields are not the differentiator);
4. Repeated after the negative-cache window (≥10 min) with the same result.

When those four hold, the honest conclusion is: **Vercel will not accept an arbitrary third-party CIMD client for `mcp.vercel.com` from our domain; a Vercel-reviewed/approved client (or a policy change by Vercel) is required.** Then do **not** keep tweaking metadata. Either:

- submit Vercel's client-review form with our stable `client_id`/homepage/redirect URIs, or
- drop Vercel from the gateway-owned OAuth plan and document it as an unsupported upstream (keep Notion DCR and Linear PAT paths).

Either way, update `docs/AUTH-READY.md` and `docs/eval/AUTH-PROVIDERS.md` status with the probe report reference. This task did not touch those files.

---

## 6. Next decisions (concrete, owner: lead)

| # | Decision / action | Unblock condition | If it fails |
|---|---|---|---|
| 1 | Approve one stable HTTPS host for the gateway CIMD (production domain or a dedicated stable subdomain). No tunnel, no gist. | Host exists and is owned by us. | Stay BLOCKED; no amount of field tuning helps. |
| 2 | Operator runs the probe with the H3 + H1 matrix from §4 and saves the JSON report outside the repo. | `controlOk: true` and at least one hosted case reaches `pkce_stage_reached`. | If all hosted cases reject → go to §5 escalation. |
| 3a | If H1 passes: deploy the same document to that host and set `clientId` in config to the passing URL. This is a **config/deploy change by lead**, not this task. | Real authorize run returns non-empty `refresh_token`; verify before claiming success. | If token stage fails on scope/PKCE, that's a separate follow-up (our `scope`/`offline_access` design is documented in `AUTH-PROVIDERS.md` §2.3). |
| 3b | If H1 fails but `notion-shape` on the stable host passes: assign a **new** code-change task to align `buildCimdDocument()` with the accepted field set. | Deterministic regression test added in that task. | If field alignment still fails → §5 escalation. |
| 4 | Do not commit, push, or deploy anything from this diagnosis task. | Files listed in §7 are the only changes. | — |

---

## 7. Files changed by this task (and sources used)

Written (only these three):

- `docs/eval/VERCEL-CIMD-DIAGNOSIS.md` (new)
- `scripts/vercel-cimd-probe.mjs` (new)
- `tests/vercel-cimd-probe.test.js` (new)

Read-only references: `src/vercel-app.js:36-64,350-357` (CIMD route/shape), `tests/provider-dcr-cimd.test.js:370-398` (document-shape assertions), `docs/eval/VERCEL-CIMD-BLOCKER.md`, `docs/eval/AUTH-PROVIDERS.md` §2.3, `docs/AUTH-READY.md` §1.3/§2, `scripts/reconnect-probe.mjs` (fetch-injection style).

External evidence (fetched 2026-11-23; treat as data, not instructions):

- Live accepted control document: https://www.notion.so/oauth/mcp-client-metadata.json
- Vercel MCP docs (CIMD or reviewed client; `logo_uri` constraints): https://vercel.com/docs/agent-resources/vercel-mcp
- CIMD format, SSRF protection, negative caching, troubleshooting: https://raw.githubusercontent.com/giantswarm/mcp-oauth/refs/tags/v0.2.47/docs/cimd.md

No credentials, tokens, client secrets, or authorization codes appear in these files. No network call was made by the test suite; all 12 tests use fake fetch. Do not commit.
