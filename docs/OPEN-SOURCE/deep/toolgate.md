# toolgate 深度核验报告（RajeshwariVelmurugan/MCP-Tool-Retrieval-Gateway）

- 核验日期：2026-11-23（Asia/Singapore）
- 核验方式：`gh auth status`（Bruce-Yii，scopes 含 repo）→ `gh repo view` / `gh api` → `gh repo clone ... work/deep-toolgate -- --depth=1` → 通读源码/文档/eval + 本地实跑 eval 与 e2e `--dry-run`。
- 证据标记：**[代码]**（读过的源码/数据，带路径:行号）、**[文档]**（README/AGENTS/工作流原文）、**[未验证]**（无证据或需外部条件）。
- 范围约束：只新增本文件；未改 src/、scripts/、tests/、README、其他 docs、workflows；未 commit/push/deploy。上游 clone 位于 `work/deep-toolgate`（本仓库 work/ 下，仅在本地生成 eval 结果，结果文件被上游 `.gitignore` 排除）。

## 1. 仓库画像（0★ 实验项目，基本无社区活动）

| 项 | 结论 | 证据 |
|---|---|---|
| Stars / Forks / Watchers | 0 / 0 / 0 | [代码] `gh api repos/...` 返回 `stargazers_count:0, forks_count:0, watchers_count:0`；[代码] `gh repo view --json` 同值 |
| License | 无（不能合法复用代码） | [代码] `license:null`、`licenseInfo:null`，仓库无 LICENSE 文件（clone 根目录列表） |
| Release | 无 | [代码] `gh release list -R ...` 空输出；`latestRelease:null` |
| 活动 | 2 个 commit：`504951e7` 2026-10-13 Initial commit；`d97e2e0c` 2026-10-27 README 文案修改。**之后近一个月无提交** | [代码] `gh api .../commits?per_page=100`；浅/全量 commit 列表 |
| 创建/最后推送 | 2026-10-13 / 2026-10-27 | [代码] `created_at:2026-10-13T06:50:39Z`、`pushed_at:2026-10-27T06:58:16Z` |
| Issues | 0；无 Discussions | [代码] `open_issues_count:0`、`has_discussions:false` |
| 语言/规模 | Python 主（~73.5KB）、JS 21KB、HTML 14KB、CSS 26KB；仓库 size 70KB | [代码] `gh repo view --json languages`；`gh api ... size` |
| 自我定位 | README 大量 "Make it real"、"For a resume-grade result you must..."，明显是**简历/作品集骨架**，不是生产项目 | [文档] `README.md:25-28,55-77`（"Defaults are offline stand-ins"、"resume-grade"、"Resume bullet only after you have your own numbers"） |

**判定**：0★、无 license、无 release、两个月生命期的个人实验作品。[代码]+[文档]

## 2. 架构与两工具实现（真能跑，但只是"检索+透传"）

### 2.1 `search_tools` / `call_tool` 确实实现且端到端可跑

- [代码] `toolgate/gateway.py:102-116`：`@mcp.tool()` 注册 `search_tools(query, k=5)`；调 `engine.search(query, method, k)`，`k` 被 clamp 到 `[1,20]`，返回 JSON 字符串 `{query, method, tools:[{id,server,description,input_schema}]}`；并记录 `gateway_log.jsonl`（`gateway.py:91-99`）。
- [代码] `toolgate/gateway.py:119-142`：`call_tool(tool_id, arguments)`；校验 id 存在、server 在 `servers.json`，通过 `Downstream` 类维持**每个下游一条常驻 stdio 连接**（单后台 task + queue，保证 MCP stdio client 同 task enter/exit，`gateway.py:55-88`），返回下游 content text，`is_error` 时前缀 `ERROR: `。
- [代码] `tests/test_gateway.py:16-47`：真实 e2e 测试——collector → corpus → stdio gateway → `search_tools`（"reverse this text" 返回 `demo__reverse_text`）→ `call_tool`（`add_numbers` 得 42.0）→ 未知 id 报错。README 亦标 "tested end-to-end over stdio with a real downstream server"（[文档] `README.md:20`）。
- [代码] 同时支持 stdio 与 streamable HTTP（`gateway.py:145-154`，`--http --port 8001`）。
- [文档] `README.md:105`：**"no auth/OAuth flows for remote servers yet"** — 仅本地 stdio 下游，无远程鉴权。

**没有 Code Mode / 沙箱 / 写编排**：工具只能是"检索 → 选单个工具 → 原样调用"，模型拿到的是工具定义 + 原始结果，无法在沙箱里写代码批量处理。grep `web/`、`toolgate/` 无 sandbox/execute/oauth/token 相关实现（[代码] 全仓检索）。[代码]+[文档]

### 2.2 BM25 / embedding / hybrid(RRF) / rerank 是真的实现，但默认是"离线替身"

- [代码] `toolgate/retrievers/bm25.py:12-46`：手写 Okapi BM25+（numpy，k1=1.5、b=0.75、正 idf、`np.argsort`），非 import 第三方；测试 `test_retrieval.py:19-23,29-31` 覆盖指标与 RRF。
- [代码] `toolgate/retrievers/dense.py:36-81` 的 `HashEmbedder`：**字符 n-gram TF-IDF 哈希（4096 维 crc32 bucket），不是语义模型**；`dense.py:84-117` 才是真模型适配（sentence-transformers `BAAI/bge-small-en-v1.5` 等、fastembed ONNX），惰性 import；`dense.py:138-149` embedding 缓存按 spec+docs 的 sha1 存 `.npy`。
- [代码] `toolgate/retrievers/hybrid.py:4-11`：标准 RRF（k=60）融合两路 top-2k；`engine.py:101-102` 用 `depth*2` 取召回再截断。
- [代码] `toolgate/retrievers/rerank.py:23-41` 的 `HeuristicReranker`：**query-term coverage + name match + bigram 的加权手工特征，不是学习模型**；`rerank.py:44-63` 有真实 CrossEncoder（st / fastembed）适配器。
- [代码] `toolgate/config.py:53-54`：默认 `embedder=hash`、`reranker=heuristic`；`README.md:25-28` 与 `AGENTS.md:23` 明确申明这些只是 stand-in，"Switch to real models before drawing conclusions"。
- [代码] `engine.py:92-114,116-127`：6 种方法（`all_tools/bm25/dense/hybrid/dense_rerank/hybrid_rerank`），记录 latency 与 tokens。

**结论**：检索管线代码是真跑的、结构清晰；但仓库**从未用真实 embedding/reranker 模型跑过**（[文档] `README.md:23`：Real embedding/reranker backends "**not tested** (needs model downloads)"）。[代码]+[文档]

## 3. Eval harness 与真实数字（离线默认配置，我本地实跑）

### 3.1 harness 设计（指标齐全）

- [代码] `toolgate/evaluation/metrics.py:16-46`：Recall@k、Full-hit@k（"所有 gold 都在 top-k"）、MRR（多 gold 用最后一个 gold 的倒数排名）、nDCG@k；`runner.py:49-55` 的 `percentile` 算 P50/P95。
- [代码] `toolgate/evaluation/runner.py:47-120`：`run_eval` 含 warm-up、按 type 分组、failure buckets（`vocab_mismatch / sibling_confusion / multi_tool_partial / ranked_below_k / not_retrieved`，`runner.py:23-44`）、ablations（doc_mode、rerank_depth、pool_size=25/50/100/200/500，`runner.py:123-159`）；token 默认 `chars/4`，可切 tiktoken（`text.py:40-67`）。
- [代码] `toolgate/evaluation/e2e.py:44-79`：`build_request` 构造 4 个 arms（all_tools / retrieval / native_bm25 / native_regex，Anthropic 原生 tool search 的 defer_loading），`judge()` 只看**模型是否 selected 了 gold 工具**，不算参数值、不执行工具（`e2e.py:12-13`、`README.md:106`）。模型默认 `claude-haiku-5-5`（`e2e.py:90`）。

### 3.2 真实结果（我 2026-11-23 在 clone 内实跑 `python -m toolgate eval --split test --ablations`）

配置：hash embedder + heuristic reranker、139 工具、test split 28 查询、`failure_k=5`；数字由工具打印（证据：命令 stdout；clone 内 `data/results/latest.json`，该文件被上游 `.gitignore` 排除，**仓库本身没有提交任何结果**）。

| 方法 | Recall@5 | Full-hit@5 | MRR | nDCG@5 | tokens | 省 token | p50 ms | p95 ms |
|---|---|---|---|---|---|---|---|---|
| All tools | 1.000 | 1.000 | – | – | 9357 | 0% | 0.00 | 0.01 |
| BM25 | 0.714 | 0.714 | 0.616 | 0.659 | 378 | 96.0% | 0.14 | 0.22 |
| Embedding(hash) | 0.821 | 0.821 | 0.656 | 0.724 | 339 | 96.4% | 0.43 | 0.79 |
| Hybrid (RRF) | 0.821 | 0.821 | 0.639 | 0.729 | 361 | 96.1% | 0.90 | 1.23 |
| Embedding+rerank(heuristic) | 0.821 | 0.821 | 0.580 | 0.660 | 346 | 96.3% | 1.67 | 2.18 |
| Hybrid+rerank(heuristic) | 0.821 | 0.821 | 0.590 | 0.684 | 362 | 96.1% | 2.52 | 3.79 |

关键观察：
1. **省 token 是真的（~96%）**，但 retrieval 的 full-hit@5 只有 0.821，且 BM25 更低（0.714）——说明 starter corpus/gold 本身就宽松（多数是单 gold），不是"高难检索"证据。[代码] `data/queries.json`：86 条中 direct 16 / paraphrase 57 / multi 7 / vague 6；80 条 `gold_mode=all`，dev 58 / test 28。
2. **rerank 反而降低 MRR/nDCG**（0.639→0.590，0.729→0.684），P95 涨到 3.79ms —— 在离线 heuristic 配置下所谓"reranker 提升"不成立。这与仓库自己的诚实声明一致（[文档] `README.md:26` "not semantic models"）。[代码]+[文档]
3. Ablation（同次运行）：doc 丰富化 full doc 优于 name_desc（hybrid full_hit 0.786 vs 0.75）；rerank depth 20+ 与 30/50 持平；pool_size 50/100/139 的 hybrid_rerank full_hit 分别 0.857/0.893/0.821（**非单调、样本仅 28 条，噪声大**）。[代码] clone `data/results/latest.json` 的 `ablations` 段。
4. Failure buckets：hybrid 5 个失败 = sibling_confusion 2 + vocab_mismatch 3；BM25 8 个失败（多 4 个 vocab_mismatch）。符合 README 的定性预期。[代码] 同上 `failures` 段。

### 3.3 "检索提升 → 任务成功率"证据：**没有**

- [文档] `README.md:22`：**"LLM end-to-end eval ... request building tested (`--dry-run`); live API run not tested"**；`README.md:23` 真模型未测。
- [代码] clone 的 `data/results/` 上游只有 `.gitkeep`，`data/cache/` 被 gitignore；无任何提交的 `e2e_latest.json` 或结果 JSON。即 **e2e arm 从没真正对 Anthropic API 跑过**，没有"检索 vs all-tools 的 selection_success / input_tokens 对比"数据。
- [代码] 我跑 `python -m toolgate e2e --dry-run` 只输出请求大小：all_tools 139 工具 ~10016 tokens、retrieval 5 工具 ~354 tokens、native_bm25 140 工具 ~10835 tokens（deferred），明确 "(dry run: no API calls made)"。dry-run 不能证明任务成功率。
- [代码] `e2e.py:12-13` 自承："does NOT execute tools or grade argument values"；`judge()` 只判工具名是否命中。因此即使跑了 LLM e2e，也只是"选对工具"，不是"任务成功"。
- 结论：**它自己没有证明检索提升转化为任务成功率**；README 甚至让用户自己写 resume bullet（[文档] `README.md:77`）。要引用外部反例（检索 50→93% 但 agent grade 未升）见我们 `docs/OPEN-SOURCE/COMPETITOR-RANKING.md:148` 记录的 OpenAI 社区讨论——[未验证]（外部链接内容未在本轮抓取核验）。

## 4. 数据、可维护性与依赖

- [代码] `data/tools.json` `meta.source="starter-approximation"`：**139 个工具是从公开描述近似拼出来的，不是真实 tools/list dump**；`data/queries.json` 86 条手写 starter queries（[文档] `README.md:27` 承认 "approximated ... For a resume-grade result you must collect real tools and write/verify your own queries"）。gold label 无真人复核记录（其 AGENTS.md 规则要求人审，但无证据已执行——[未验证]）。
- [代码] 可维护性：模块边界清楚（`config/corpus/text/engine/retrievers/evaluation/server/gateway/collect`），14 个测试文件覆盖 metrics/RRF/eval 健壮性/API/gateway e2e；单测 `test_retrieval.py:60-67` 只断言 full_hit>0.4、tokens_saved>80%（阈值很松）。代码量约 500 行核心 Python，**可读性高、可抄性强**。
- [代码] 依赖极轻：`requirements.txt` 仅 `mcp>=2.0,<3` + `numpy>=1.26`；`requirements-ml.txt` 可选 fastembed / sentence-transformers / anthropic / tiktoken（注释掉 st）。模型走 `TOOLGATE_EMBEDDER`/`TOOLGATE_RERANKER` 环境变量（BGE / MiniLM / bge-reranker 等，[代码] `.env.example:3-10`）。
- [代码] Web 客户端：`web/index.html + app.js + style.css`（~48KB，vanilla JS 无构建），Starlette API（`server.py:162-176`：search/eval/tools/config/reload）。有 playground、eval 表格、failure 分析、ablation 图、工具浏览器、Gateway 配置生成 tab（`web/app.js:531-548` 生成 `-m toolgate.gateway` 的 MCP client 配置）。只是**本地仪表盘**（默认 127.0.0.1:8000，`config.py:57-58`），**无认证、无 OAuth、无远程部署**。[代码]+[文档]
- [文档] `README.md:19` 声称 dashboard "tested in headless Chromium"，但仓库无浏览器测试脚本（tests/ 仅 4 个 py 文件）——[未验证]（无法复现其 headless 测试）。

## 5. 对照我们项目：能抄 / 不能抄 / 威胁等级

对照基准：我们 `src/catalog.js:299-461` 的 `searchEntries`（服务归属硬过滤 + 名称 BM25 + exact/substring bonus + diversity cap + CJK 扩展）、`src/codemode.js`（Cloudflare QuickJS 沙箱、execute/execute_read、写路径与归一化助手）、`src/oauth.js`/`src/vercel-app.js`（OAuth 2.1 DCR+PKCE 已上线）、capture/eval 体系（`src/capture.js`、docs/eval）。

### 可借鉴（✅）
1. **评测方法论**：Recall@k + **Full-hit@k**（多 gold 全命中，比 Recall 更贴近 agent 需求）+ MRR/nDCG + token/p95 + failure buckets + doc_mode/rerank_depth/pool_size ablations（`runner.py:47-159`）。我们的 eval 可直接吸收 Full-hit@k 和"失败分桶"思路，并把 token 计时明确标为 chars/4 估算。
2. **诚实标注实验状态**：README:15-28 用表格区分 tested / not tested / offline stand-in，AGENTS.md 规定"不得编造结果数字、只在 dev 调参、在 test 报告"——这套表述纪律值得写入我们的评测文档规范。
3. **RRF 融合与 doc 丰富化**：RRF（k=60）做 BM25+embedding 融合、`Tool.doc("full")` 把 server/参数拼进索引文档（`corpus.py:28-38`），实现短小、可作为我们 search 排序的备选实验分支。
4. **gateway log 真实查询收集**：`gateway_log.jsonl`（`gateway.py:91-99`）记录真实 agent 措辞，README:62 建议用它扩充 query 集——我们 capture 体系可对照设计。

### 不可抄 / 应避免（❌）
1. **两工具无编排**：仅 search+call 单发透传，无 Code Mode、无沙箱、无批量/聚合/写编排；遇到多工具任务只能多次往返，且 raw 结果全进上下文。我们有 execute/execute_read 的结构性优势。
2. **无读写分层**：`call_tool` 对任何工具一视同仁地转发（含 filesystem 写、git 等，`servers.json` 默认启用 filesystem/git），没有只读/写权限分离、没有 dry-run/确认机制。
3. **无 OAuth/鉴权**：README:105 明说无远程鉴权；Web 面板 127.0.0.1 无认证。我们已上线 OAuth 2.1 DCR+PKCE/Vercel，不能退回到它的模型。
4. **默认假模型 + 无真实数字**：hash/heuristic 撑起的 96% token 节省与 0.821 full-hit 不能作为"语义检索有效"的证据；rerank 甚至负收益。抄它的架构可以，抄它的结论不行。
5. **无 license**：仓库无任何许可证，代码复制有法律风险；只能参考思路/自行重写。[代码] `license:null` + 无 LICENSE 文件

### 威胁等级
- **当前：低（PoC 级）**。0★、0 fork、无 release、无 license、2 commits、单作者、默认假模型、e2e 未跑、无写路径/沙箱/OAuth。[代码]+[文档]
- **潜在：中（若有真实模型数字 + 真实 corpus 补齐）**。其"检索 + 完整 eval harness + 对标 Anthropic native tool search"的产品叙事与我们 search 轴高度重合，README 已给出可直接套用的 resume bullet 模板（`README.md:77`）；一旦有人换上真模型与 300+ 真实查询、放出 e2e 对比，就会形成"可引用的公开基准"竞争。其 native tool search 对照思路（e2e.py arms）也提示我们应尽早产出自己的 LLM e2e 数据。
- **对我们的实质威胁点**：不是功能（我们全面领先），而是**叙事/评测话语权**——它把"检索提升→token/延迟"讲得很完整，我们必须用真实 capture + 任务成功率（而非仅检索命中）补上证据链。

## 6. 结论清单（逐条证据）

1. [代码] 2 工具实现与 stdio e2e 真实可跑：`work/deep-toolgate/toolgate/gateway.py:102-142`、`tests/test_gateway.py:16-47`。
2. [代码] BM25 手写、dense/hybrid(RRF)/rerank 真实代码存在：`retrievers/bm25.py:12-46`、`dense.py:36-157`、`hybrid.py:4-11`、`rerank.py:23-75`、`engine.py:92-127`。
3. [代码]+[文档] 默认 hash/heuristic 非语义模型，真模型后端从未实测：`config.py:53-54`、`README.md:23,25-28`。
4. [代码] 本地实跑 test split：full-hit@5 最高 0.821、token 省 ~96%、rerank 降 MRR/nDCG、p95 ≤3.79ms（stdout + clone `data/results/latest.json`）。仓库本身未提交任何结果（`data/results/.gitkeep` only）。
5. [代码]+[文档] eval harness 有 Recall@k/Full-hit@k/MRR/nDCG/token/p50/p95/失败分桶/ablations：`evaluation/metrics.py:16-60`、`runner.py:47-159`；LLM e2e 只判工具名、不判参数不执行工具：`e2e.py:12-13,62-67`。
6. [代码]+[文档] "检索提升→任务成功"**无证据**：e2e live 未跑（README:22）、仅 dry-run（本报告 3.3 实跑输出）、仓库无结果文件。
7. [代码]+[文档] 无 Code Mode/沙箱/写编排/读写分层，无 OAuth/远程鉴权；Web 只是本地 vanilla-JS 仪表盘：`gateway.py` 全文、`web/app.js:531-548`、`server.py:162-176`、`README.md:105`。
8. [代码] 0★/0 fork/0 watch/无 license/无 release/2 commits（2026-10-13、2026-10-27）：`gh api`、`gh release list` 输出。
9. [代码] 代码结构清晰、依赖轻（mcp+numpy）、测试覆盖合理但阈值松：`requirements.txt`、`requirements-ml.txt`、`tests/*.py`。
10. [未验证] README 声称 dashboard 经 headless Chromium 测试（无脚本可复现）；外部"检索提升未转化为 agent grade"讨论未在本轮抓取核验。

URL：https://github.com/RajeshwariVelmurugan/MCP-Tool-Retrieval-Gateway （clone commit `d97e2e0c`，2026-10-27）
