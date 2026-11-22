# Adoption rankings: MCP servers and chat-app connectors (Nov 2026)

This note records what public data actually says about usage, so upstream
coverage decisions are not driven by intuition. **There is no official usage
ranking for MCP servers or for ChatGPT apps/connectors.** Every number below is
a proxy that counts one narrow thing (installs inside one client, container
pulls, hosted connections, page views, directory categories, or search demand),
and the same server ranks differently in each source.

## 1. MCP servers: four public counts

### Cline marketplace installs (closest to "a person chose it")

Cline counts an install each time a user installs a server from inside the
editor: **1.47M installs across 199 servers, 52% in the top ten; the median
server has 1,475 installs** (checked 12 Nov 2026).

| # | Server | Installs |
|---|---|---|
| 1 | Filesystem (reference) | 162,680 |
| 2 | Context7 (library docs) | 135,084 |
| 3 | Browser Tools | 87,432 |
| 4 | Sequential Thinking (reference) | 84,488 |
| 5 | Git | 58,369 |
| 6 | Playwright (ExecuteAutomation's) | 54,435 |
| 7 | GitHub | 51,437 |
| 8 | Fetch (zcaceres') | 49,845 |
| 9 | Figma | 43,003 |
| 10 | Puppeteer | 37,256 |

### Docker MCP catalog image pulls (machines, often CI)

| # | Image | Pulls |
|---|---|---|
| 1 | Playwright | 2,774,039 |
| 2 | Fetch | 1,986,900 |
| 3 | SonarQube | 1,705,807 |
| 4 | Grafana | 1,179,264 |
| 5 | Time | 1,085,665 |
| 6 | DuckDuckGo | 1,055,322 |
| 7 | Context7 | 666,686 |
| 8 | Memory | 577,650 |
| 9 | Kubernetes | 467,960 |
| 10 | Sequential Thinking | 439,949 |

### Smithery hosted connections (hosted servers only)

Smithery's readable listing covers only ~260 of its 20,756 servers; its leaders
are hosted aggregators and data services, not the dev tools above:
`pipeworx/gateway` 419,019; SparkForge 219,896; Brave Search 87,579; UK company
checks 60,881; paper search 59,106; Gmail 57,738; Google Sheets 56,138; Agent
News 43,392; PubMed 42,137; Korean financial data 40,620. GitHub has 5,908.

### Directory sizes (not usage)

Glama 119,868 servers (usage undefined/keyed); Official MCP Registry 62,550
(42,197 remote; **no usage count at all**); MCP Market 53,663 (GitHub stars);
PulseMCP 21,556 (modelled weekly visitors); Smithery 20,756 (connections);
mcp.so 18,911 (page views); Docker catalog 316 (pulls); Cline marketplace 199
(installs).

### Caveats

- The same server scores very differently: Playwright has 54,435 Cline installs,
  2.77M Docker pulls, 34k mcp.so views and 39.5k GitHub-registry stars. A pull is
  a machine, a view is a visit, an install is a person inside one client.
- Docker pulls accumulate since publication; older servers had longer.
- Hosted servers (Notion, Slack, Figma, Stripe, Atlassian, Linear) are invisible
  to npm/PyPI/container counts.
- No registry is market share.

## 2. ChatGPT apps / connectors: no public usage ranking

OpenAI does not publish per-app or per-connector usage. The directory shows
categories and editorial placement, not installs; per-workspace connector
link/unlink events exist in ChatGPT Enterprise audit logs but are private to the
workspace. Third-party "top ChatGPT apps" lists are editorial, not measured.

What is public:

**ChatGPT app directory composition (apps per category)** — travel, finance and
shopping dominate; work/dev tools are a minority:

| Category | Apps |
|---|---|
| Travel & Hospitality | 149 |
| Finance & Trading | 136 |
| Marketing & Sales | 95 |
| Retail & Shopping | 90 |
| Analytics & Data | 81 |
| Real Estate | 70 |
| Education | 68 |
| Dev Tools | 30 |
| Research & Academic | 18 |

**Claude's ordered connector list** (the closest thing to a vendor-published
connector ranking, for comparison): Google Drive, Gmail, Google Calendar, Canva,
Microsoft 365, Notion, Figma, Slack, HubSpot, Asana, Linear, monday.com.

**Editorial examples of early ChatGPT apps**: Spotify, Photoshop, AllTrails,
Expedia, Instacart, OpenTable, Tripadvisor, Airtable, Apple Music, Canva, Figma,
Zillow, Gmail, Dropbox, Booking.com, DoorDash, Coursera.

**Demand proxies** (Google searches for "<tool> mcp", Aug 2026): Playwright
60.5k/mo, GitHub 27.1k, Notion 18.1k, Chrome DevTools 18.1k, Supabase 12.1k,
Slack 12.1k, Context7 9.9k, Figma 49.5k (designers), Blender 49.5k (creators).
These measure interest in MCP servers, not usage of ChatGPT connectors.

## 3. What this means for this gateway

"High frequency" is an input, not the priority order. Filter candidate upstreams
through four questions before adding one:

1. **Is it reachable from a hosted gateway?** Local-only servers (Filesystem,
   Playwright/Chrome DevTools/Puppeteer/Browser Tools, local Git) lead the
   install/pull charts but cannot be wrapped by a hosted web-client gateway.
2. **Does the web client lack a native connector?** ChatGPT/Gemini already ship
   native Google Drive/Gmail/Calendar (and ChatGPT: SharePoint/Box/Dropbox)
   connectors; duplicating those through the gateway adds maintenance without a
   clear context win.
3. **Is the tool surface big enough to matter?** The gateway's core value is
   collapsing many tool definitions and sandboxing results. A two-tool docs
   server (e.g. Context7) gains little.
4. **Can a user actually obtain credentials?** Pre-registered/confidential OAuth
   (Slack, Figma, Atlassian, Google, Microsoft) needs a documented token
   acquisition flow; a template without that guide is dead weight.

Applying those filters:

| Priority | Upstreams | Why |
|---|---|---|
| **A — next** | **Slack, Atlassian (Jira/Confluence), Figma, Sentry** | Remote, work-heavy usage, meaningful tool surfaces; all need pre-registered OAuth or DCR plus a short token-acquisition guide. `clientSecretEnv` refresh already supports the confidential ones. |
| **B — later** | **Google Workspace, Microsoft 365** | Highest web-connector usage, but heaviest OAuth (own OAuth client, consent, refresh) and largely duplicated by native client connectors. Google template exists; add the acquisition guide first. |
| **C — low value** | **Context7** | Very high installs, but a docs-only, tiny tool surface; the gateway saves little context. |
| **D — out of scope** | Playwright, Filesystem, Chrome DevTools, Puppeteer, Browser Tools, local Git | Local-only; would need a separate local companion mode, not a hosted gateway. |
| **E — not upstreams** | ChatGPT consumer apps (Spotify, Expedia, OpenTable, ...) | Closed consumer integrations, not MCP servers to wrap. |

Coverage vs quality: for v0.1/v1.0, **5–8 well-supported upstreams with credential
guides, contract tests and one real client** beat a long template list. The
current four (GitHub, Notion, Linear, Vercel) already cover the author's daily
use; breadth should follow the filters above, with onboarding docs before more
templates.

The leading Smithery server is a gateway (`pipeworx/gateway`, 419k connections),
which validates the Code Mode/gateway category — and means competing
meta-gateways exist.

## Sources

- hedwigai, *Ten MCP registries and the use they can see* (data checked 12 Nov
  2026): <https://www.hedwigai.com/blog/mcp-registries>
- hedwigai, *Which MCP servers, connectors and skills each community uses*:
  <https://www.hedwigai.com/blog/mcp-servers-by-community>
- KeenEthics, *ChatGPT Apps in 2025–2026*:
  <https://mcp-app-store.keenethics-labs.com/blog/chatgpt-apps-in-2025-2026-trends-and-the-most-popular-use-cases>
- Yahoo Tech, *ChatGPT's app store: 7 favorite apps* (editorial):
  <https://tech.yahoo.com/ai/chatgpt/articles/chatgpts-app-store-heres-7-142246795.html>
- OpenAI does not publish connector usage; the directory only exposes categories.
