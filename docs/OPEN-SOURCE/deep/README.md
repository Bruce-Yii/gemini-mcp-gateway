# Deep-dive reports (GitHub CLI verified)

> These are source-level reviews, not marketing summaries. Each sub-agent used
> `gh repo view` / `gh api` / `gh repo clone --depth=1`, and tags claims as
> `[代码]` / `[文档]` / `[未验证]` with paths or URLs.

| Report | Repo | One-line verdict |
|---|---|---|
| [agentgateway.md](agentgateway.md) | agentgateway/agentgateway | **Does not implement** progressive disclosure/Code Mode; an almost-identical PR #3859 was rejected because "proxy shouldn't be a bespoke MCP server". Low direct threat; validates our niche. |
| [bifrost.md](bifrost.md) | maximhq/bifrost | 9.9k★ but mostly LLM gateway; Code Mode is 4 tools + Starlark sandbox, no Gemini/ChatGPT, no task eval. Medium threat on enterprise, low on Web. |
| [cloudflare-portals.md](cloudflare-portals.md) | closed service + Cloudflare OSS | Three distinct mechanisms: `minimize_tools`, `search_and_execute` (proxy), `codemode` (JS). Closed enterprise, no Gemini/ChatGPT web, weak eval. |
| [toolgate.md](toolgate.md) | RajeshwariVelmurugan/MCP-Tool-Retrieval-Gateway | 0★ PoC; BM25/rerank/eval harness real, but default fake models, no Code Mode/write/OAuth, no task-success evidence. |
| [gemini-bastion.md](gemini-bastion.md) | Kaiserunix/gemini-bastion-mcp | 10 fixed tools, no Code Mode/definition compression; strongest Web-client OAuth/DCR + approval UX; no capture/eval. |

## Biggest corrections to the ranking

1. **agentgateway is not a top competitor** on our axis: no progressive
   disclosure/Code Mode implementation, and its maintainers explicitly rejected
   a `mcp_search`/`mcp_call` PR (`#3859`) as out of scope for a proxy.
2. **toolgate is a PoC**, not a product: useful eval methodology, but default
   fake embedder/reranker and no task-success evidence.
3. **Cloudflare's `search_and_execute` is not Code Mode** — it is a name+args
   proxy; the JS Code Mode is a separate `?codemode=...` mode. Do not conflate.
4. **gemini-bastion's readOnlyHint trick is a hint-layer policy**, not a real
   read-only sandbox; our `execute_read` stubs write tools at execution time.
