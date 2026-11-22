# Differentiation: continuous context & tool-call optimization

> Correction to the earlier competitor framing: this project is **not**
> "another MCP aggregator". Aggregation is a side effect. The product is a
> **continuously measured context/tool-call optimization layer** for web AI
> clients. Competitors that only aggregate or only add auth are not the main
> comparison.

## 1. What we actually optimize

| Layer | What we do | Why it matters | Evidence |
|---|---|---|---|
| **Tool-definition context** | 506 upstream tool schemas (~245,377 tokens) → 3 stable tools (~1,520 tokens), **-99.4%** | Web clients inject the full tool list into every prompt; this is the largest fixed context cost | `scripts/measure-context.mjs`, `README.md`, `docs/WHY.md` |
| **Progressive discovery** | `search` returns ranked candidates, compact signatures, `select:<name>` schemas; BM25 + Chinese optimization | The model does not need all schemas; it needs the right tool at the right step | search eval: top1 56.5%, top5 72.3%, Chinese top1 88% (repo measurements) |
| **Tool-call correctness** | `callName` exact identifier, schema sanitization, flat params, `server__tool`, stable tool order | Wrong tool names / split namespaces / schema mutations are Gemini-specific failure modes | `src/sanitize.js`, `docs/UPSTREAMS.md`, `AGENTS.md` |
| **Result context** | Only the sandbox return value enters the conversation; raw upstream payload stays out; canonical file/PR/Issue shapes; line ranges; truncation markers | Prevents 100KB+ payloads and silent truncation from poisoning the next step | `src/codemode.js`, `src/result-normalize.js`, `docs/ledger/batch-11-truncation.md` |
| **Read/write split** | `execute_read` vs `execute`; write tools stubbed in read mode; per-tool read/write labels | Web clients cannot reliably approve every call; read/write separation reduces blast radius and confirmation fatigue | `src/codemode.js`, ledger B10 |
| **Tool-call orchestration** | multi-call scripts, `safeAll`, pagination (`fetchAllPages`), `repoGrep`, canonical PR/Issue, idempotent branch/PR, atomic `push_files`, dry-run patch | Fewer round trips, fewer partial writes, fewer model-side glue fixes | `src/github-helpers.js`, `src/file-write.js`, ledger B10/B11 |
| **Continuous eval** | full-fidelity capture → digest → analyzer (advisory) → L1/G6 → regression; session clustering; model-truncation audit; truncation scanner in CI | The optimization is not a one-time claim; each change is measured against real sessions and a fixed task set | `docs/OBSERVABILITY-AND-EVAL.md`, `docs/eval/`, `docs/ledger/` |
| **Client fidelity** | Gemini: no `structuredContent`, text JSON, `__`, sanitized schemas, stable tools; OAuth 2.1 DCR; session marker | Works on the actual web client, not just MCP Inspector | `docs/CLIENTS.md`, `docs/eval/session-marker-2026-11-23.md` |
| **Isolation** | QuickJS worker sandbox, frozen guest globals, no Node/require/fetch; read stubs | Safe enough to run model-written code against real tools | `tests/true-isolation.test.js`, `docs/SANDBOX-SECURITY.md` |

## 2. Real comparison, by optimization axis

| Project | Tool-definition compression | Progressive discovery | Result-context control | Tool-call orchestration | Continuous eval | Web-client fidelity |
|---|---|---|---|---|---|---|
| **Us** | ✅ 506→3, -99.4% | ✅ BM25 + schema on demand | ✅ canonical + line ranges + truncation + only return value | ✅ batch/pagination/idempotent/atomic/dry-run | ✅ capture + L1/G6 + analyzer | ✅ Gemini tested; adapters planned |
| **Cloudflare Code Mode / Portals** | ✅ single `code` tool | ✅ inside sandbox | ⚠️ runtime-level, not client-facing eval | ⚠️ platform-specific | ❌ no public client-facing eval loop | ⚠️ enterprise/cloud client path |
| **Limen** | ✅ 2 tools | ✅ JS filter | ⚠️ result goes through sandbox | ⚠️ basic | ❌ no eval/scorecards | ❌ unverified |
| **corrreia/dev-mcp** | ✅ 2 tools | ✅ catalog | ⚠️ logs only | ⚠️ basic | ❌ no eval | ❌ unverified |
| **gemini-bastion-mcp** | ❌ 10 fixed tools; no Code Mode | ❌ no discovery; fixed surface | ❌ no payload folding | ⚠️ approval gate only | ❌ no eval | ✅ Gemini/Claude/ChatGPT tested |
| **MCPHub / MetaMCP / Unla / agentgateway** | ❌ / ⚠️ schema proxy or selective | ⚠️ semantic routing in some | ❌ aggregation, not context folding | ⚠️ policy/auth focus | ⚠️ logs/metrics, not task eval | ❌ client-specific unverified |

Legend: ✅ implemented and evidenced; ⚠️ partial/different layer; ❌ not the project's focus.

## 3. The moat is the loop, not the feature list

A gateway can copy "3 tools" or "sandbox" in a week. What is harder to copy:

1. **Full-fidelity capture** — every HTTP/MCP/upstream/sandbox frame, not sampled.
2. **A fixed task ladder** — L1 smoke + G6, with fake/replay/real modes.
3. **A discipline of evidence** — every optimization must produce a scorecard/capture, not a README claim.
4. **Client-specific hardening** — Gemini schema/result quirks, stable tool snapshots, OAuth details.
5. **Write-path realism** — real GitHub branch/patch/PR replay, not fake-tool unit tests.

That is why the competitor list should be short: only projects that also
compress context or run model-written tool orchestration are relevant. The rest
are adjacent infrastructure, not competitors on our core axis.

## 4. What to say in the README (not a generic comparison table)

> Most MCP gateways make tools *reachable*. This gateway makes them *cheap to
> discover, safe to execute, and measurable to improve*: 506 tools collapse to
> 3 stable tools, only the sandbox return value enters context, read/write are
> separated, and every optimization is checked against real captures and a
> fixed task suite.

Do not lead with "we support 5 upstreams" or "we have OAuth". Those are
table stakes. Lead with the **context/tool-call optimization loop**.
