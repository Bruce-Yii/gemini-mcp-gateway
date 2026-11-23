# Reuse research: typed plan / tool orchestration / client adaptation

> **Status: research only.** This document contains no implementation decisions that
> change runtime code. No code, scripts, tests, README, other docs, or workflows
> were modified. Nothing was committed, pushed, or deployed.
>
> Research date: 2026-11-23. Verification: `gh api` (GitHub CLI, live) for
> stars / license / last push / PR state; `web_fetch` on official docs and
> repository raw files. Every figure below is attributed to a URL checked on
> that date; third-party benchmark numbers are labelled as such and were **not**
> independently reproduced. External page content was treated as untrusted data.
>
> Scope: only items that could plausibly land in this gateway. No awesome lists.

---

## 0. Executive summary (read this first)

1. **The single most reusable artifact is already in our dependency tree**:
   `@cloudflare/codemode@0.5.6` (pinned in `package.json:47`). Its
   `generateTypesFromJsonSchema()` is already imported in `src/codemode-util.js`
   but **not used** by `src/codemode.js` (see `docs/CODEMODE-SURVEY.md` §0.2).
   It is MIT with a permissive, replaceable `Executor` interface. Use the
   generator, do not adopt the runtime.
2. **Do not adopt MCP Groups (SEP-2084).** It was **rejected by MCP Core
   Maintainers on 2026-02-05**; PR [#2084](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2084)
   is `state=closed, merged=false`. Reason recorded by the author: *"the
   ecosystem around searching tools is quickly evolving and it's unclear what
   mechanism is the right one in the longrun ... it might be too early for it."*
   Adopting it would add a wire protocol no client speaks.
3. **Skills over MCP (SEP-2640) is Final and stable** — but it is a *content*
   extension (Resources + `skill://` URI), not a plan/typed-op runtime. Borrow
   the "named, URI-addressable instruction bundle" **shape** for our own
   local snippets; do not ship the wire extension (no client support matrix
   advantage for our three target clients).
4. **Anthropic's and OpenAI's deferred-tool protocols are mutually compatible
   in spirit but not in wire format**: `defer_loading` + `tool_reference`
   (Anthropic, `tool_search_tool_regex_20251119` / `_bm25_20251119`) vs
   `defer_loading` + `{"type":"tool_search"}` with `namespace` tool wrappers
   (OpenAI, gpt-5.4+). Both validate our "stable 3-tool surface + dynamic
   catalog" design; neither is code we can reuse (they are host-side APIs).
   **Anthropic explicitly forbids programmatic calling of MCP connector tools**,
   so "let the host do PTC" is not an option for us.
5. **Orchestration frameworks are all overkill for the gateway itself.**
   FastMCP / mcp-use / mcp-agent / LangGraph / PydanticAI / Temporal solve
   *agent* problems (LLM loops, DAGs, durability) that our gateway deliberately
   does not own. Reuse their **schema/normalization utilities**, never their
   agent runtime.
6. **License trap found**: `postrv/forgemax` — the closest "Code Mode MCP
   gateway" competitor — is **FSL-1.1-ALv2 (Functional Source License)**, not
   MIT/Apache. Cannot copy code; can observe design at a distance.

---

## 1. Main comparison table

Stars / license / last-push values are `gh api repos/...` as of 2026-11-23.
`NOASSERTION` means GitHub could not map the LICENSE file to a single SPDX ID;
the actual text was read and is noted in §5.

| Project | Capability relevant to us | License | Stars / activity (2026-11-23) | Reusable part | Integration cost | Risk |
|---|---|---|---|---|---|---|
| `@cloudflare/codemode` (`cloudflare/agents` monorepo) | JSON Schema → TypeScript declarations; `search`/`describe` progressive discovery; minimal `Executor` interface; `toModelOutput` projection; approval/replay policy | **MIT** (`cloudflare/agents` LICENSE) | 6,031 ★; pushed 2026-11-23 | `generateTypesFromJsonSchema`, `sanitizeToolName`, `normalizeCode` (already imported in `src/codemode-util.js`); `toModelOutput` idea | **Low** — pin stays at 0.5.6; use 3 pure functions only | Upstream README says **Experimental — may have breaking changes**. Importing internal minified chunks is fragile; pin and vendor a fallback |
| `@ai-sdk/code-mode` (`vercel/ai`) | QuickJS executor; `experimental_toolCallers` per-tool visibility; `toolDiscovery:'conversation'`; 11 `executionPolicy` limits; `experimental_runCodeMode` | **Apache-2.0** (LICENSE text verified) | 28,133 ★; pushed 2026-11-22 | **Design spec** for our 11-limit policy and stable-tool-definition catalog; `runCodeMode` if we ever add a non-model plan API | **Medium** — it is AI-SDK-coupled, Node 22+, no browser/edge; not a drop-in for our MCP server | Its own docs: **experimental**; no approval flow. Would pull a large framework tree |
| Anthropic Messages API tool search + PTC | `defer_loading`, `tool_reference`, `allowed_callers`, `$OUTPUT_DIR`→`file_id` spill, `input_examples` | Proprietary API (docs only) | n/a | **Protocol shape only**: deferred catalog, per-tool caller allowlist, spill-by-reference | **None / design only** | PTC **cannot call MCP connector tools**; recursive `$ref`, `strict:true`, `tool_choice` incompatible. Not a runtime we can ship |
| OpenAI Responses tool search + MCP connector + Apps SDK descriptors | `namespace` wrapper, `defer_loading`, `{"type":"tool_search"}`, `outputSchema`+`structuredContent`, `securitySchemes`, `_meta["mcp/www_authenticate"]`, `annotations` | Proprietary API / spec docs | n/a | `_meta.securitySchemes` shape, `annotations`, profile-tool schema, `outputSchema` pairing → feed `src/client-profile.js` ChatGPT profile | **Low** — a few `_meta` keys in the ChatGPT profile only | ChatGPT-specific; Gemini ignores `structuredContent` (project hard rule). Must not leak into Gemini path |
| MCP SEP-2084 Groups | `groups/list`, `io.modelcontextprotocol/groups` reserved `_meta`, `listChanged` | MIT→Apache-2.0 transition (repo LICENSE mixed) | 9,751 ★ spec repo; **PR rejected** | **Nothing to adopt directly.** At most: reserved `_meta` namespace as a convention | **N/A — do not integrate** | Rejected by Core Maintainers 2026-02-05; no client speaks it; would violate "stable tool list" rule (`notifications/list_changed` not consumed by Gemini) |
| MCP SEP-2640 Skills extension (`modelcontextprotocol/ext-skills`) | `io.modelcontextprotocol/skills`, `skill://` URI, `skills/list`, Resources-based | **Apache-2.0** | 813 ★; pushed 2026-11-22 | Named URI-addressable instruction bundle **shape** for our saved snippets | **Low** — internal convention only | Spec is Beta; pin to a commit if ever used. Structural schema, not semantics; no target client support yet |
| `jlowin/fastmcp` | Fast MCP server scaffolding, pydantic-based schemas, streamable HTTP | **Apache-2.0** | 28,714 ★; pushed 2026-11-23 | Schema-annotation helpers if we ever generate descriptors programmatically | **High** — Python; our gateway is Node | Overkill: our 3 tools are hand-authored and must stay stable |
| `lastmile-ai/mcp-agent` | MCP-native agent patterns, `MCPAggregator`, Temporal durability, token accounting | **Apache-2.0** | 8,591 ★; **last push 2026-01-25** (≈10 months stale) | `MCPAggregator` façade idea; nothing to import | **Very high** — Python + LLM loop + Temporal | Stale; architecturally inverts our gateway (it owns the LLM loop, we must not) |
| `mcp-use/mcp-use` | MCP client / agent framework, multi-server | **MIT** | 11,004 ★; pushed 2026-11-21 | Nothing for the gateway; maybe test-harness client | **High** — different stack | Same inversion problem; its TS sibling `mcp-use-ts` is **archived** |
| `pydantic/pydantic-ai` (+ Monty) | `run_code` tool, Rust Python interpreter sandbox, 30 s / 256 MiB defaults, Logfire nested spans | **MIT** | 21,340 ★; pushed 2026-11-23 | **Benchmark data + policy defaults**; "every nested call is a span" idea for our captures | **Very high** — Python runtime, different language | Third-party 5,276-run benchmark (cost −58%, time −51%, success +16 pts on long tasks; small jobs +21–38% tax) is **vendor-published, not reproduced**. Not a library we can depend on |
| `langchain-ai/langgraph` | Graph/DAG orchestration, checkpoints, human-in-the-loop | **MIT** | 45,278 ★; pushed 2026-11-22 | **Nothing.** Our plan is generated code, not a static graph | **Very high** | Directly contradicts "the code is the graph" — adding a graph lib would duplicate our QuickJS control flow |
| `temporalio/temporal` (+ sdk-typescript) | Durable execution, pause/resume/replay, approval gates | **MIT** | 24,549 ★ / 951 ★; pushed 2026-11-22 / 11-21 | Only if we later add durability; Cloudflare replay semantics are a closer model | **Very high** — separate server + worker + DB | Massive operational footprint for a single-owner gateway; P2+ at best |
| `modelcontextprotocol/typescript-sdk` | Official MCP server/client SDK, OAuth helpers, in-memory transport | **Mixed: MIT → Apache-2.0 transition** (LICENSE states new code Apache-2.0, docs CC-BY-4.0, unrelicensed contributions stay MIT) | 13,807 ★; pushed 2026-11-19 | Already a dependency (`^1.32.2`). Token-verification helpers if we widen auth | **None** — already present | License transition needs a per-version audit before vendoring code out of it; do not copy source into our repo |
| `postrv/forgemax` | "Code Mode inspired local sandboxed MCP Gateway", N→2 tools | **FSL-1.1-ALv2** (source-available, **not** OSI open source) | 159 ★; pushed 2026-10-21 | Design observation only | **N/A** | **Cannot copy.** FSL restricts competing use; future ALv2 conversion is not a license grant today |

### Reading the table

- "Reusable part" means *actual code path, package export, or protocol shape*
  we could use — not "inspiring project".
- "Integration cost" is relative to a Node 20+ ESM gateway with a pinned
  QuickJS executor, not to a greenfield agent app.

---

## 2. Detailed findings by research area

### 2.1 Anthropic — programmatic tool calling, tool search, tool-use examples, MCP connector limits

Sources: [Tool reference](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-reference),
[Programmatic tool calling](https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling),
[MCP connector](https://platform.claude.com/docs/en/agents-and-tools/mcp-connector.md),
[Advanced tool use announcement](https://www.anthropic.com/engineering/advanced-tool-use).

**Verified facts (official docs, fetched 2026-11-23):**

- Server tools are date-versioned: tool search is
  `tool_search_tool_regex_20251119` / `tool_search_tool_bm25_20251119` (two
  algorithms, **variants, not versions**); code execution is
  `code_execution_20260120` / `code_execution_20260521`; MCP connector is
  `mcp_toolset` with beta header `mcp-client-2025-11-20` or
  `mcp-client-2026-09-15` (never date-versioned).
- `defer_loading: true` excludes a tool from the initial system prompt; tool
  search returns a `tool_reference` that loads it on demand. **It preserves
  prompt cache** — deferred definitions are not part of the cached prefix, so
  `cache_control` must go on a non-deferred tool. This is the exact rationale
  for our "one stable tool surface, dynamic catalog elsewhere" rule.
- `input_examples` is available on **user-defined tools only**, and each
  example must match `input_schema` (a Bedrock validation error is documented:
  *"Example at index 0 is invalid: `location` is a required property"*). This is
  the closest official analogue of "typed plan examples".
- `allowed_callers` accepts `"direct"` and/or
  `"code_execution_20260120"`/`"code_execution_20260521"` (interchangeable;
  responses always tag caller as `code_execution_20260120`). Omitting `direct`
  guides the model to call only from code. Response `tool_use` blocks carry a
  `caller` field.
- **Hard limits on PTC** (explicit in docs): tools provided by an MCP
  connector **cannot** be called programmatically; computer/browser toolsets
  accept only `["direct"]`; recursive `$ref` causes `400 Circular $ref
  detected`; `strict:true` tools are unsupported; `tool_choice` cannot name a
  tool whose `allowed_callers` omits `direct`; ZDR/HIPAA not eligible.
- **MCP connector limitations**: only *tool calls* from the MCP spec are
  supported; server must be publicly HTTP (Streamable HTTP or SSE), **no local
  stdio**; `type` must be `url` and HTTPS; each server must be referenced by
  exactly one `mcp_toolset`; `configs` merging precedence is
  `configs` > `default_config` > system defaults. With
  `mcp-client-2026-09-15`, the API returns an `mcp_tool_listing` block that can
  be **pinned** into the toolset's `tools` field — a server changing its tools
  does not change the model's view mid-conversation.
- `$OUTPUT_DIR` → `file_id` → Files API is the spill mechanism; model copies
  files into `$OUTPUT_DIR` and is advised to `ls "$OUTPUT_DIR"` in the same
  command because it cannot see `content[].file_id` directly.

**What we can actually reuse:**

| Item | Verdict | Notes |
|---|---|---|
| `defer_loading` + `tool_reference` semantics | **Borrow the pattern, not the code** | Already satisfied by our `search` + `select:<name>`; add "cache-stable" wording to docs if anything |
| `allowed_callers` | **Borrow for docs only** | Our equivalent is `execute_read` vs `execute`; we cannot emit Anthropic fields (Gemini/Claude MCP clients, not Messages API) |
| `input_examples` | **Do not copy** | Adding examples to our 3 tool schemas would violate "stable tool definitions"; put examples in `search` results / instructions instead |
| Tool-list pinning (`mcp_tool_listing` → `tools`) | **Strong conceptual match** | We already serve a fixed 3-tool surface; cite this as external validation in `PLAN.md` discussions, do not change code |
| `$OUTPUT_DIR` spill | **Borrow as design** | Our current `truncateResultValue` loses data; a ref + read-back bridge is the known gap (`docs/CODEMODE-SURVEY.md` §0.2 item 2) |
| Host PTC as executor | **Cannot use** | MCP connector tools are excluded by Anthropic itself |

### 2.2 OpenAI — descriptors, securitySchemes, tool search, MCP connector auth

Sources: [Using tools](https://developers.openai.com/api/docs/guides/tools.md),
[Build an MCP server](https://developers.openai.com/plugins/build/mcp-server.md),
[Auth](https://developers.openai.com/plugins/build/auth.md),
[Reference](https://developers.openai.com/plugins/reference.md).

**Verified facts:**

- `tool_search` is supported on **gpt-5.4 and later only**. Usage shape:
  a `{"type":"namespace","name":"crm","tools":[...]}` wrapper with per-tool
  `defer_loading: true`, plus `{"type":"tool_search"}` in the same `tools`
  array. Recommended with `parallel_tool_calls: false`.
- Remote MCP tool shape: `{"type":"mcp","server_label":...,"server_url":...,"require_approval":"never"}`;
  for OAuth servers the app supplies `authorization` itself. `connector_id`
  is **deprecated for models released after 2026-09-01** in favour of
  `server_url` / `tunnel_id`.
- Tool descriptor requirements: action-oriented name + title, description
  explaining *when* to use, explicit `inputSchema`, `outputSchema` when
  returning `structuredContent`, accurate annotations, server-side auth.
  **`securitySchemes`** is a tool-descriptor field with `noauth` / `oauth2`
  (+ scopes); `_meta["securitySchemes"]` is kept as a compatibility mirror.
- Triggering ChatGPT OAuth UI requires **both** metadata (`securitySchemes`
  *and* protected-resource metadata) **and** a runtime error carrying
  `_meta["mcp/www_authenticate"]` with `error` + `error_description`. Docs
  explicitly say server-level defaults make it hard to evolve individual
  tools — declare per tool.
- Auth is OAuth 2.1 per MCP spec: `/.well-known/oauth-protected-resource`,
  `WWW-Authenticate: Bearer resource_metadata=...`, `resource` echoed into
  tokens, PKCE `S256` mandatory (metadata omitting S256 ⇒ unsupported).
  Client registration: **CIMD preferred** (`client_id_metadata_document_supported: true`,
  `https://chatgpt.com/oauth/client.json` or callback-ID-specific document),
  DCR still supported; `token_endpoint_auth_methods_supported` ∈ {`none`,
  `private_key_jwt`}; RFC 9207 issuer identification changes the redirect URI
  to the stable `https://chatgpt.com/connector_platform_oauth_redirect` vs
  `https://chatgpt.com/connector/oauth/{callback_id}`. mTLS client cert
  (`mtls.prod.connectors.openai.com`) also available.
- `_meta["openai/profile"]: true` designates a read-only profile tool whose
  `outputSchema` requires an opaque stable `id` (use OIDC `sub`, **not email**).
- `_meta` keys hidden from the model; `structuredContent` + `content` are
  surfaced. `annotations`: `readOnlyHint` / `destructiveHint` /
  `openWorldHint` required, `idempotentHint` optional.

**What we can actually reuse:**

| Item | Verdict | Notes |
|---|---|---|
| `securitySchemes` + `_meta["mcp/www_authenticate"]` two-half contract | **Borrow into ChatGPT profile only** | Our `docs/OPEN-SOURCE/CLIENT-PROFILES.md` already notes the profile is design-only; add these keys there, never in Gemini path |
| `outputSchema` + `structuredContent` pairing | **Borrow for ChatGPT profile** | Project hard rule says Gemini must get text JSON only — keep the split at `src/client-profile.js` |
| Profile tool (`sub` as stable id) | **Borrow as concept, do not implement** | Would add a 4th tool, breaking the 3-tool invariant |
| `namespace` + `defer_loading` | **Do not emit** | Gemini sees only our 3 tools; put catalog in `search` results |
| OAuth 2.1 / CIMD / mTLS details | **Audit reference only** | Our `src/oauth.js` already has DCR + PKCE + allowlisted ChatGPT callbacks; gap analysis is a separate task |

### 2.3 MCP Groups / Progressive Disclosure WG / Skills over MCP

Sources: [WG overview](https://modelcontextprotocol.io/community/working-groups/overview),
[Progressive Disclosure charter](https://modelcontextprotocol.io/community/working-groups/progressive-disclosure),
[SEP-2084 text](https://raw.githubusercontent.com/chughtapan/modelcontextprotocol/c7a816b273ccbbf5b32bfd8c9b49a6e4abd6e551/docs/community/seps/2084-primitive-groups.mdx),
[PR #2084](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2084),
[Core Maintainer meeting #2204](https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/2204),
[SEP-2640](https://modelcontextprotocol.io/seps/2640-skills-extension),
[`ext-skills` README](https://raw.githubusercontent.com/modelcontextprotocol/ext-skills/main/README.md).

**Groups — rejected, do not adopt.** SEP-2084 proposed a `groups` capability,
`groups/list`, `notifications/groups/list_changed`, and a reserved
`_meta["io.modelcontextprotocol/groups"]` on every primitive (chosen over a
first-class `groups` property specifically for backward compatibility with
strict older clients). It had reference implementations in the TS SDK
([PR #1399](https://github.com/modelcontextprotocol/typescript-sdk/pull/1399))
and schema changes ([PR #2110](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2110)).
**But**: `gh api repos/modelcontextprotocol/modelcontextprotocol/pulls/2084`
returns `state=closed, merged=false, closed_at=2026-02-05`. Author's comment
that day:

> "this was rejected by Core Maintainers. The main feedback was that the
> ecosystem around searching tools is quickly evolving and it's unclear what
> mechanism is the right one in the longrun. The Core maintainers take a
> careful stance here to not too early standardize a pattern while the patterns
> in the de-facto implementations are still evolving."

Discussion #2204 records the maintainers' alternate framing: *"Tool search and
skills have recently emerged as alternative approaches, and it isn't yet clear
whether explicit grouping will remain the best path forward."* The Progressive
Disclosure WG still exists (leads Tapan Chugh, Sam Morrow) but its charter
explicitly says it "feeds recommendations into the SEP process rather than
picking a single canonical pattern early".

**Consequence for us:** Groups would require us to emit a capability and
`list_changed` notifications that our target clients (especially Gemini, per
project hard rule) do not consume. We already implement the surviving pattern
— **tool search** — in `search` / `execute_read` / `execute`. No adoption.

**Skills over MCP — Final SEP, but not a plan runtime.** SEP-2640 is marked
Final (PR #2640 merged 2026-09-13); `modelcontextprotocol/ext-skills` is
Apache-2.0, 813 ★, pushed 2026-11-22. It defines `io.modelcontextprotocol/skills`
over the **Resources** primitive with `skill://` URIs, `skills/list`, and a
Beta spec at `specification/beta/skills.mdx`. The repo warns the Beta schema
`$id` may change content across revisions — pin to a commit if ever using it;
it validates structure, not semantics (digest integrity, consent,
`resultType:"complete"` require host checks).

**Consequence for us:** borrow the *shape* — a named, URI-addressable,
versioned instruction bundle — for Cloudflare-style saved snippets if we ever
add them. Do not add the wire extension: no advantage for Gemini/Claude/Inspector,
and it would enlarge the tool/capability surface.

### 2.4 Cloudflare Code Mode / `@cloudflare/codemode`

Sources: [package README (primary)](https://raw.githubusercontent.com/cloudflare/agents/main/packages/codemode/README.md),
[docs](https://developers.cloudflare.com/agents/tools/codemode/),
[how it works](https://developers.cloudflare.com/agents/tools/codemode/how-it-works/),
[`cloudflare/agents` repo](https://github.com/cloudflare/agents).

- Repo: **MIT**, 6,031 ★, pushed 2026-11-23. Package README first line after
  the pitch: **"Experimental — may have breaking changes. Use with caution in
  production."**
- We pin **0.5.6** (`package.json:47`). The README for the current version
  documents `createCodeTool`, `DynamicWorkerExecutor`, `IframeSandboxExecutor`,
  framework entrypoints `/ai` and `/tanstack-ai`, and explicitly states the
  main entry has **no peer dependency on `ai` / `@tanstack/ai` / `zod`** —
  "Utilities only" install is supported. That validates our utility-only import.
- The README repeats the key architectural sentence we rely on: the `Executor`
  interface is deliberately minimal so you can implement your own for Node VM,
  QuickJS, containers, or anything else. Our `run@2.1.13` QuickJS executor is
  within the intended extension point.
- Progressive discovery is now the documented mainstream path:
  `codemode.search()` returns ranked paths, `codemode.describe()` returns
  focused TypeScript documentation. This is the same two-stage shape as our
  `search` + `select:<name>`.
- **Executable bits we can reuse:** `generateTypesFromJsonSchema(tools)`,
  `sanitizeToolName()`, `normalizeCode()`. All three are already mapped in
  `src/codemode-util.js`; only `normalizeCode` and `sanitizeToolName` are
  actually consumed by `src/codemode.js`.
- **Do not reuse:** `DynamicWorkerExecutor` (Cloudflare Workers-only),
  `IframeSandboxExecutor` (browser-only, and its README admits timeout cannot
  preempt tight synchronous loops), durable log / abort / replay / rollback /
  snippets (requires CF platform bindings we do not have).
- **Type-generation caveat:** current README says TS type definitions are
  generated from tools for LLM context, but the generated signature must be
  checked against our Gemini schema constraints (`sanitizeTool` in `src/sanitize.js`)
  before being shown to the model — signatures are prose, not a tool schema,
  so this should be safe, but verify on a real Gemini session.

### 2.5 Orchestration libraries — which fit a typed plan, which are overkill

**Short answer: none of them should sit inside the gateway.** Our gateway's
job ends at "execute this code against these tools safely and return a
result". The LLM loop belongs to the client (Gemini/Claude/ChatGPT), and a
"typed plan" in our context is *a schema-constrained program plus typed tool
signatures*, not a LangGraph DAG.

| Library | Fit for *our* typed plan | Why |
|---|---|---|
| `@ai-sdk/code-mode` | **Closest** — but as a specification of limits, not a dependency | Same QuickJS + per-tool callers + conversation catalog. Our Node 20 baseline vs its Node 22+ and AI-SDK coupling blocks direct reuse |
| `@cloudflare/codemode` utilities | **Best direct fit** | Pure functions, already in the dependency tree, MIT |
| PydanticAI / Monty | **Design only** | Python; its 5,276-run benchmark is useful evidence for "long tasks win, short tasks pay a tax", which supports keeping our whitelist/direct path |
| Temporal | **P2, only if we add durability** | Need approval/replay/rollback; a separate server/worker/DB is disproportionate for single-owner v0.1 |
| mcp-agent | **No** | Python, LLM-loop owning, and last pushed 2026-01-25 (≈10 months) |
| mcp-use | **No** | Python agent framework; TS sibling archived |
| FastMCP | **No** | Python server builder; our 3 tools are fixed and hand-verified |
| LangGraph | **No** | Static graph model contradicts "the code is the graph" |
| Forgemax | **Cannot copy** | FSL-1.1-ALv2 |

Notably, Pydantic's own benchmark (vendor-published, 2026-10-28, 5,276 runs)
found **small jobs cost 16–38% more with code mode** and long tasks improved
(cost −58%, wall time −51%, success +16 pts). This supports our existing
decision to keep a direct whitelist path alongside code mode rather than
forcing everything through `execute`.

---

## 3. Do not reinvent vs. must write ourselves

### Don't reinvent (reuse / copy the idea with attribution)

| Area | Use instead of writing |
|---|---|
| JSON Schema → TS signature generation | `generateTypesFromJsonSchema` from the already-pinned `@cloudflare/codemode@0.5.6` (`src/codemode-util.js` already maps it) |
| Tool-name normalization | `sanitizeToolName` (same package) — do not write another regex |
| Code normalization / AST parse | `normalizeCode` + `acorn` (already a dependency, `package.json:50`) |
| QuickJS sandbox engine | `run@2.1.13` (already a dependency); `docs/SANDBOX-SECURITY.md` documents the escape test |
| Result projection for the model | Cloudflare `toModelOutput` shape — audit-only fields out, `return`/logs in |
| Per-tool visibility design | Vercel `experimental_toolCallers` / Anthropic `allowed_callers` — our `execute_read` split is the equivalent |
| Discoverability pattern | Anthropic `defer_loading` + tool search; Cloudflare `search`/`describe`; OpenAI `namespace` + `tool_search` — all converge on our `search` + `select:<name>` |
| Execution budgets | Vercel's 11 named limits (`timeoutMs`, `cpuTimeoutMs`, `memoryLimitBytes`, `maxStackSizeBytes`, `maxSourceBytes`, `maxResultBytes`, `maxConsoleOutputBytes`, `maxToolInputBytes`, `maxToolOutputBytes`, `maxBridgeRequests`, `maxInFlightBridgeRequests`) — use as a checklist, implement in our own registry |
| OAuth 2.1 / PKCE / DCR discovery | Already implemented in `src/oauth.js`; use official MCP SDK token-verification helpers rather than hand-rolling JWT checks if widened |
| ChatGPT descriptor metadata | OpenAI `securitySchemes` / `annotations` / `outputSchema` shapes — declarative data, no library |

### Must write ourselves (product-defining, no suitable upstream)

| Item | Why no upstream fits |
|---|---|
| **Exactly 3 stable tools** (`search` / `execute_read` / `execute`) | No library exposes this contract; Gemini's parser and the project's "no mid-session schema change" rule make it ours by construction. `allowed_callers` / `experimental_toolCallers` are host-side fields we cannot emit. |
| **`execute_read` / `execute` read-write split** | Anthropic uses `allowed_callers`, Cloudflare uses approval+replay, Vercel refuses approval-dependent tools in code mode, OpenCode uses per-tool permission rules. **None** splits at the MCP tool boundary the way we do. This is our differentiator (`docs/CODEMODE-SURVEY.md` §0.2.1). |
| **Capture + eval (`capture.js`, scorecards, L1/G6)** | No upstream produces full-fidelity MCP envelopes tied to replayable real sessions. Pydantic Logfire is a vendor SaaS, not a library we can self-host in this shape. Keep all model suggestions as hypotheses per `AGENTS.md`. |
| **Write path / write replay / idempotency** | Cloudflare's replay is tied to durable bindings; ours must work on Node/Vercel with single-owner credentials. Existing `stableKey` dedup and write-replay evidence are local work. |
| **Client adaptation layer (`client-profile.js`, `client-platform.js`, `oauth.js`)** | We must keep one canonical tool name and switch only *encoding* by profile. No upstream does "Gemini text-JSON only vs ChatGPT structuredContent" while keeping tool definitions byte-identical. |
| **Sanitization for Gemini (`sanitize.js`)** | Hard project constraint (arrays need `items`, multi-type splits, `oneOf` depth). Upstream generators assume generous clients. |
| **Result lifecycle end-to-end** (`summarizeArgs` → dedup → call cap → bounded logs → `toModelOutput` → truncation → deadline) | Vendors each implement pieces; none has our complete chain. Spill/ref is the open gap we must design. |
| **QuickJS host bridge + registry** (`src/codemode.js`) | `Executor` is a *consumer* interface; the host-side tool registry, argument validation, and error stubs are ours. |

---

## 4. Three highest-value reuse recommendations

Ordered by value / effort. **Recommendations only — no code was changed.**

### #1 — Wire the already-imported `generateTypesFromJsonSchema` into `select:<name>`

- **Package / path:** `generateTypesFromJsonSchema` from `@cloudflare/codemode@0.5.6`
  (`package.json:47`), re-exported today in **`src/codemode-util.js`**. Target
  call site: the `select:<name>` branch of **`src/codemode.js`** search handling.
- **Why:** Closes the largest identified accuracy gap — the model currently
  sees a 160-char summary plus raw JSON Schema, not a TS signature. This is a
  pure function we already pay for; no new dependency, no new tool, no schema
  change, so the "stable 3 tools" invariant holds.
- **Cost:** Low. Keep list mode unchanged; add the signature only on `select:`.
  Verify on a real Gemini session that the signature is delivered as text and
  that `sanitizeTool` (`src/sanitize.js`) is still applied to actual tool
  definitions.
- **Risk:** Upstream is Experimental and imports currently reach a minified
  internal chunk. Pin 0.5.6, add a fallback if the export moves, and record the
  exact import in a test fixture rather than upgrading casually.

### #2 — Add per-tool byte limits using Vercel's 11-item `executionPolicy` checklist

- **Package / spec:** `@ai-sdk/code-mode` docs
  <https://ai-sdk.dev/docs/ai-sdk-core/code-mode> — specifically
  `maxToolInputBytes`, `maxToolOutputBytes`, `maxResultBytes`,
  `maxConsoleOutputBytes`, `maxSourceBytes`, `maxBridgeRequests`,
  `maxInFlightBridgeRequests` (plus CPU vs wall clock). Implement in our own
  registry in **`src/codemode.js`** / config in **`src/config.js`**.
- **Why:** We already have call counts and wall-clock deadline, but no
  per-tool byte visibility. OpenCode's community measurement showed a 50 KB
  output cap changing answers from 8/8 to 5/8 — this is a correctness issue,
  not just cost. Per-tool caps let us bound a hostile upstream without blindly
  truncating the final result.
- **Cost:** Medium — config fields + registry enforcement + tests; no runtime
  change for existing configs if defaults are "unset = current behaviour".
- **Risk:** Do **not** adopt Vercel's "no approval in code mode" stance as a
  reason to weaken `execute_read`. Keep the Gemini text-JSON result encoding.

### #3 — Publish a ChatGPT-only metadata profile from the OpenAI descriptor spec

- **Source / paths:** OpenAI [Reference](https://developers.openai.com/plugins/reference.md)
  and [Auth](https://developers.openai.com/plugins/build/auth.md):
  `securitySchemes` (+ `_meta["securitySchemes"]` mirror), `outputSchema` ↔
  `structuredContent`, `annotations`, `_meta["mcp/www_authenticate"]`, and
  `_meta["openai/profile"]`. Target: the **design-only** ChatGPT profile
  described in **`docs/OPEN-SOURCE/CLIENT-PROFILES.md`**, with runtime
  differences confined to **`src/client-profile.js`** when a future task
  implements it.
- **Why:** These are declarative keys with essentially zero integration cost,
  and they are the documented precondition for ChatGPT's OAuth linking UI.
  It also gives the launch plan's "ChatGPT documented, not promised" stance a
  concrete, auditable checklist without touching Gemini behaviour.
- **Cost:** Low as documentation; medium when implemented (needs a real
  ChatGPT test, which is explicitly out of scope for v0.1 promises).
- **Risk:** The two-half OAuth contract (metadata **and** runtime challenge)
  is easy to half-implement. Do not add a fourth `profile` tool — that breaks
  the 3-tool invariant. Keep `_meta` hidden from the model.

**Explicitly not recommended:** porting Forgemax (license), adopting SEP-2084
Groups (rejected), adding LangGraph/Temporal/mcp-agent to the gateway
(architectural inversion), or switching our executor to Cloudflare's
`DynamicWorkerExecutor` (platform-bound).

---

## 5. License audit (explicit reuse classes)

| Project / artifact | License (verified 2026-11-23) | Class | Action |
|---|---|---|---|
| `@cloudflare/codemode` (`cloudflare/agents`) | MIT | **可直接依赖 / 可借鉴** | Keep pinned dependency. Copy only small pure-function ideas with attribution; Bernstein-style MIT permits redistribution with notice |
| `run` / Vercel QuickJS executor | MIT (package in local deps) | **可直接依赖** | Already in `package.json:51` |
| `acorn` | MIT | **可直接依赖** | Already in `package.json:50` |
| `@modelcontextprotocol/sdk` | LICENSE text: MIT→Apache-2.0 transition; new code/spec Apache-2.0, docs CC-BY-4.0, unrelicensed contributions remain MIT | **可直接依赖；不要摘抄源码** | Safe to depend on at a pinned version. Before copying any source into our repo, audit that file's header |
| `@ai-sdk/code-mode` (`vercel/ai`) | **Apache-2.0** (LICENSE verified: "Copyright 2023 Vercel, Inc. Licensed under the Apache License, Version 2.0") | **可借鉴，可不依赖** | Borrow names/shape; Apache-2.0 requires NOTICE + change notices if code is copied. Avoid pulling the framework |
| `pydantic/pydantic-ai` | MIT | **可借鉴（数据/设计），不依赖** | Python; benchmark citations with attribution only |
| `langchain-ai/langgraph` | MIT | **不相关** | No reuse |
| `jlowin/fastmcp` | Apache-2.0 | **不相关（本仓库）** | No reuse |
| `lastmile-ai/mcp-agent` | Apache-2.0 | **不相关 + 陈旧** | No reuse |
| `mcp-use/mcp-use` | MIT | **不相关** | No reuse |
| `temporalio/temporal`, `sdk-typescript` | MIT | **未来可选依赖** | P2 only; MIT-compatible |
| `modelcontextprotocol/ext-skills` | Apache-2.0 | **可借鉴（规范文本）** | Spec/ASCII shape only; no code copy needed |
| MCP spec / SEPs | LICENSE: Apache-2.0 for new code/spec; CC-BY-4.0 for non-spec docs | **可借鉴（引用+署名）** | Quote short passages with URL; do not vendor wholesale |
| `postrv/forgemax` | **FSL-1.1-ALv2** — Functional Source License, future Apache-2.0 conversion | **不能复制** | Source-available is not open source; competing use restricted today. Observation only |
| `mcp-use/mcp-use-ts` | No license detected; **archived** | **不要碰** | No license grant |
| Anthropic / OpenAI API docs | Proprietary documentation | **可借鉴（协议事实，短引用）** | Cite URLs; do not copy large text blocks into product docs |

No **AGPL** dependency was found among the candidates. If one is introduced
later, treat it as a hard block for a self-hosted gateway that may be offered
as a service.

---

## 6. Source list (all checked 2026-11-23)

**Anthropic**
1. <https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-reference>
2. <https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling>
3. <https://platform.claude.com/docs/en/agents-and-tools/mcp-connector.md>
4. <https://www.anthropic.com/engineering/advanced-tool-use>

**OpenAI**
5. <https://developers.openai.com/api/docs/guides/tools.md>
6. <https://developers.openai.com/plugins/build/mcp-server.md>
7. <https://developers.openai.com/plugins/build/auth.md>
8. <https://developers.openai.com/plugins/reference.md>

**MCP / WGs**
9. <https://modelcontextprotocol.io/community/working-groups/overview>
10. <https://modelcontextprotocol.io/community/working-groups/progressive-disclosure>
11. <https://modelcontextprotocol.io/community/working-groups/skills-over-mcp.md>
12. <https://raw.githubusercontent.com/chughtapan/modelcontextprotocol/c7a816b273ccbbf5b32bfd8c9b49a6e4abd6e551/docs/community/seps/2084-primitive-groups.mdx>
13. <https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2084>
14. <https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/2204>
15. <https://modelcontextprotocol.io/seps/2640-skills-extension>
16. <https://raw.githubusercontent.com/modelcontextprotocol/ext-skills/main/README.md>

**Code Mode / libraries**
17. <https://raw.githubusercontent.com/cloudflare/agents/main/packages/codemode/README.md>
18. <https://developers.cloudflare.com/agents/tools/codemode/>
19. <https://developers.cloudflare.com/agents/tools/codemode/how-it-works/>
20. <https://ai-sdk.dev/docs/ai-sdk-core/code-mode.md>
21. <https://pydantic.dev/articles/why-code-mode-is-the-future>
22. <https://raw.githubusercontent.com/lastmile-ai/mcp-agent/main/README.md>
23. <https://github.com/cloudflare/agents>, <https://github.com/jlowin/fastmcp>,
    <https://github.com/lastmile-ai/mcp-agent>, <https://github.com/mcp-use/mcp-use>,
    <https://github.com/pydantic/pydantic-ai>, <https://github.com/langchain-ai/langgraph>,
    <https://github.com/temporalio/temporal>, <https://github.com/modelcontextprotocol/typescript-sdk>,
    <https://github.com/postrv/forgemax> — metadata via `gh api repos/<slug>`

**Local evidence**
24. `package.json`, `src/codemode-util.js`, `src/codemode.js`, `src/sanitize.js`,
    `src/client-profile.js`, `docs/CODEMODE-SURVEY.md`,
    `docs/OPEN-SOURCE/CLIENT-PROFILES.md`, `AGENTS.md`.
