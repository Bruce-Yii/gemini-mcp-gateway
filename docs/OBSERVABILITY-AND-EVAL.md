# 透明观测与评测体系（Full-Fidelity Observability + Evaluation）

> 状态：**P1 已实现（HTTP/MCP 请求/响应全量 capture + file/http sink）；P2 上游/sandbox 明细待做** · 2026-11-23
> 目标：Gemini 侧完全无感；网关把**边界内所有可观测事件**按原始保真度记录下来，
> 不采样、不按主观判断裁剪；用这些数据做回放、回归和迭代。

## 0. 结论（修正版）

**能记录的，全部记录；范围拉到网关的物理边界为止。**

- 不做“只记元数据 / 10% 采样”的默认裁剪；
- 不按“我觉得这个字段没用”丢数据；
- 记录粒度到**每一次 HTTP/MCP/JSON-RPC/SSE 帧、每一次上游调用、每一段 sandbox 代码与结果**；
- “有界”只指：**可见性边界、单请求大小、存储容量、保留时间**，不是内容范围。

必须同时说清楚**物理上看不到的**部分（不是我们选择不记）：

| 数据 | 网关能否看到 | 原因 |
|---|---|---|
| Gemini 的聊天上下文 / 历史 | ❌ | 不出现在 MCP 请求里 |
| Gemini 的隐藏推理 / thoughts | ❌ | 客户端内部，不发送 |
| Gemini 的模型 token 用量 | ❌ | 客户端/模型侧计量，MCP 协议不传 |
| Gemini 最终怎么组织答案 | ❌ | 发生在网关响应之后 |
| MCP 请求/响应全文 | ✅ | 经过网关 |
| `search` query / `execute` 代码 | ✅ | MCP 工具参数 |
| 工具参数 / 上游返回 / 错误 | ✅ | 网关与上游之间 |
| 耗时 / 字节 / 截断 / 部署版本 | ✅ | 网关自身 |

如果你要“连聊天上下文、隐藏推理、模型 token 也全记”，那只能在 **Gemini 客户端侧**做插桩；
这需要改客户端或拿到客户端数据，**做不到“无感、和以前完全一样”**。网关侧不可能凭空看到没经过它的数据。

**唯一的安全例外**：`Authorization`/Cookie/OAuth token/API key 不落明文。
记录“是否存在、长度、hash、前缀”即可；明文密钥对优化没有价值，但泄露会导致账号被接管。
其余内容（包括用户代码、Notion/GitHub 正文、报错）全部按原文记录。

## 1. 可见性边界矩阵

| 层 | 事件 | 记录方式 |
|---|---|---|
| HTTP | method、path、query、headers（脱敏）、body 原文、status、response headers/body | 原始字节 + 结构化 |
| MCP | 每个 JSON-RPC request/response/notification、`tools/list`、`tools/call`、progress、error | 原始 JSON |
| SSE | 每个 `event:` / `data:` 帧、顺序、时间 | tee 原始帧 |
| Code Mode | `search` query/结果、`execute_read/execute` 代码、tool calls/参数/返回、console、错误、最终结果、截断、行标记 | 原始文本 + 元数据 |
| Upstream | 每个上游 MCP 帧、server/tool、args、raw result、耗时、重试、HTTP 状态 | 原始帧 + 元数据 |
| Sandbox | 代码、日志、异常栈、行号、超时、资源限制 | 原始文本 |
| OAuth | grant/refresh 事件、client_id、scope、过期时间、结果 | 元数据；token 不落明文 |
| 部署/配置 | commit、buildHash、工具目录快照、feature flags、上游列表 | 快照 |
| 客户端 | User-Agent、Accept、MCP-Protocol-Version、session header、IP（可选） | 元数据 |

## 2. 全量采集架构

```text
Gemini
  │ 原样 MCP /mcp（不新增字段、不改 schema）
  ▼
Vercel Function
  ├─ raw HTTP tap（req/res/SSE tee）──────────────► 原响应（字节不变）
  ├─ MCP JSON-RPC tap
  ├─ Code Mode / sandbox tap
  ├─ UpstreamManager tap（每个上游帧）
  └─ telemetry.envelope
           │ 同步：复制/脱敏/限长（微秒级，不 await）
           ▼
     waitUntil(async flush)
           ├─ 原始事件 → 私有 Vercel Blob（gzip JSONL / 每请求对象）
           └─ 索引元数据 → Postgres/Upstash/日志（可选）
```

同步路径只做三件事：**复制、脱敏、封包**。不做网络 IO、不 await 存储、不因采集失败改响应。

## 3. 事件模型（一个请求一个 envelope）

```json
{
  "schema": "gmg.capture.v1",
  "requestId": "req_...",
  "ts": "2026-11-23T03:00:00.000Z",
  "deployment": { "commit": "a2004e2", "buildHash": "..." },
  "client": { "ua": "...", "protocol": "2025-06-18" },
  "http": {
    "method": "POST", "path": "/mcp", "query": {},
    "reqHeaders": { "content-type": "application/json", "authorization": "<redacted:hash>" },
    "reqBytes": 1234, "resStatus": 200, "resBytes": 5678, "durationMs": 1234,
    "rawBody": "<original JSON-RPC body>",
    "rawResponse": "<original response body / SSE frames>"
  },
  "mcp": { "messages": [ { "direction": "in", "jsonrpc": "2.0", "method": "tools/call", "id": 1, "params": {} } ] },
  "calls": [
    {
      "server": "github", "tool": "get_file_contents",
      "args": { "owner": "Bruce-Yii", "repo": "gemini-mcp-gateway", "path": "README.md" },
      "rawResult": "<upstream raw result>",
      "status": "ok", "durationMs": 210, "bytes": 12774
    }
  ],
  "sandbox": {
    "code": "async () => { ... }",
    "logs": ["..."],
    "toolCalls": ["..."],
    "result": "<raw final result>",
    "error": null,
    "line": null,
    "truncated": false
  },
  "search": { "query": "read file", "results": [ "github__get_file_contents" ] }
}
```

规则：

- 一个 MCP 请求一个 envelope；SSE 帧按顺序保留；
- 原文不截断；超过单请求容量上限时**分片写 Blob**，并记 `chunks` / `overflow`；
- 脱敏只作用于认证类字段；其余原样；
- 事件按天分区，索引与原文分离，便于回放。

## 4. “有界”的准确含义

| 边界 | 处理 |
|---|---|
| 可见性 | 只记经过网关的事件；Gemini 内部数据物理上不存在 |
| 单请求大小 | 默认 32MB/请求；超过则分片，不丢内容 |
| 存储容量 | Blob 按天分区 + 生命周期；可扩 |
| 保留时间 | 原始默认 30 天（可调）；蒸馏任务/scorecard 长期保留 |
| 请求速率 | 高峰排队写 Blob；不阻塞响应；写失败记录 `capture_dropped` |
| 密钥 | 不落明文，只记 hash/存在性 |

**不设“采样率”**；不设“只记错误”；不设“只记元数据”。
如果容量不够，扩存储/缩短保留期，而不是缩小观测范围。

## 5. 无感硬契约（可测试）

1. **协议不变**：不新增/删除工具，不改 schema/instructions/响应字段/headers。
2. **响应字节不变**：capture on/off，同一请求响应逐字节一致。
3. **延迟预算**：同步采集 p95 增量 < 5ms；不做网络/磁盘 IO。
4. **fail-open**：Blob/索引/序列化失败全部吞掉，MCP 正常返回。
5. **有界内存**：单请求上限 + 背压；超限分片，不 OOM。
6. **SSE 透明**：tee 不改变帧顺序/内容/时序；客户端感知不到。
7. **可关闭**：`CAPTURE_MODE=off` 立即恢复零采集。
8. **可验证**：测试“响应不变 / sink 异常不影响响应 / 超长分片 / 密钥脱敏”。

Vercel `waitUntil` 可在响应后继续短任务（[Functions API](https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package)）；
运行时日志保留很短（Hobby 1h / Pro 1d），不能当原文仓库（[limits](https://vercel.com/docs/limits)）。

## 6. 存储

- **原文**：私有 Vercel Blob，`capture/YYYY-MM-DD/<requestId>.json.gz`；每请求一个对象，SSE 帧、上游原文、sandbox 原文都在里面。
- **索引**：Postgres/Upstash（requestId、ts、tool、server、ok、errorClass、bytes、duration、blobPath）。
- **日志**：只做实时 tail/告警，不作为长期数据源。
- **保留**：原始 30 天；蒸馏后的失败样本/回归任务永久。
- **访问**：私有、签名 URL、最小权限；不公开。

### 6.1 GitHub / Notion 能不能当存储？

可以，但要分工，**不要把全量 raw 高频塞进 Notion，也不建议把 raw 永久提交到主仓库**。

| 用途 | 推荐存储 | 原因 |
|---|---|---|
| 热原始数据（每请求/SSE/上游原文） | 私有 Vercel Blob / S3 / R2 | 高吞吐、可 TTL、私有、按对象取回；日志系统不适合 |
| 冷归档（脱敏后的日报/周报原文包） | **私有 GitHub 仓库**（独立 `gateway-capture`，非主仓库） | 版本化、可复现；用 Git LFS 或 Release assets，避免主仓库膨胀 |
| 回归任务/scorecard | **主仓库 `docs/eval/` 或 `explore/tasks-*.json`** | 与代码同版本，评审可 diff |
| 人看的 dashboard/决策记录 | **Notion** | 适合页面/数据库，不适合当高频原文仓库 |

**GitHub 当原始存储的现实限制**：

- 仓库会持续膨胀，clone/CI 变慢；删除历史很麻烦，TTL 很难真正落实；
- API 有速率限制，逐请求提交不现实；必须按天/小时打包成 `.json.gz`；
- 私有仓库仍要防 token 泄露；raw 原文含用户内容，GitHub 是第三方处理器；
- 不建议用 gateway 现有的 GitHub 上游 token 写日志（会和用户操作混权限/配额）；
  用独立的 bot token，只给 `contents:write` 到专门的 capture 仓库。

**Notion 当原始存储的现实限制**：

- API 约 3 req/s、页面/block 有大小上限；高频日志会被限流；
- 不适合存二进制/压缩包；base64 塞页面会很快爆；
- 全量 raw 原文进 Notion 等于把敏感内容再复制到一个协作工具，隐私面更大；
- 适合存**摘要/评分/决策**，不适合存逐请求原文。

**建议的组合**：

```text
热 raw      → Vercel Blob（30 天 TTL，按请求 gzip）
冷归档      → 独立私有 GitHub capture 仓库（每天一个 .json.gz，脱敏/加密，保留 90 天）
回归/评分   → 主仓库 docs/eval/ + explore/tasks-*.json（永久）
人看报告    → Notion 页面/数据库（只放摘要、链接、结论）
```

如果要“零新增存储”，最低配是 **私有 GitHub 仓库 + 每天一个压缩包**；但它是冷归档，
不适合当在线查询/回放的主存储，且 TTL 删除需要额外轮转策略。Notion 不建议承载 raw。

### 6.2 其他存储产品（免费/付费都可）

> 价格/额度以厂商页面为准；下表是选型维度，不是报价单。

| 产品 | 免费额度（约） | 付费 | 适合 | 注意 |
|---|---|---|---|---|
| **Cloudflare R2** | 10 GB-month；Class A 1M/月、Class B 10M/月；出站免费 | $0.015/GB-month 起 | **原始事件 Blob**（推荐） | S3 API；需要 Worker/签名 |
| **Backblaze B2** | 10 GB；出站 3× 存储/月 | $6/TB-month | 原始事件冷存储 | S3 兼容；延迟高于 R2 |
| **Vercel Blob** | Hobby/Pro 有 included 额度 | 按存储/流量 | 已在 Vercel 的最少配置 | 私有 store；和部署同域 |
| **Supabase** | 500 MB DB + 1 GB Storage | $25/月起 | 索引 + 小原文 | Postgres 查询方便 |
| **Neon** | 0.5 GB 存储 | 按用量 | **索引/聚合**（推荐配 R2） | Serverless Postgres |
| **Upstash Redis** | 256 MB、10k commands/天 | 按量 | 最近事件/索引/去重 | 不适合大原文 |
| **Axiom / Grafana Loki** | 有免费日志额度 | 按量 | 元数据日志/检索/告警 | 日志不等于原文仓库 |
| **Langfuse** | 有 free/hobby 额度 | 按量/自托管 | LLM/tool trace、可视化 | 外部托管需评估隐私 |
| **GitHub 私有仓库** | 免费；LFS 1 GB 免费 | LFS/存储按量 | **冷归档/蒸馏任务** | 不适合热数据；TTL 删除难 |
| **Notion** | 免费个人版 | 按套餐 | **周报/dashboard/决策** | API 3 req/s，不适合 raw |

**推荐组合**：

- **零预算**：R2（raw）+ Neon（索引）+ GitHub Actions（日报/回归）+ 主仓库 `docs/eval/`（scorecard）。
- **最少配置**：Vercel Blob（raw）+ Upstash（索引）+ Vercel Cron。
- **人看**：Notion 只放周报和链接，不放原文。

Cloudflare R2 的免费额度对“每天几十~几百次网关调用、每次几十 KB”的量级足够；
如果原文很大（Figma/Notion 大结果），优先 R2/B2，不要用 Redis/Notion 硬扛。

## 7. 从全量数据到迭代

```text
全量 capture → 错误/模式聚类 → 取原始 envelope 本地回放 → 最小回归任务
→ 修复 → smoke/全量评测 → 基线对比
```

因为原文全量保留，可以：

- 看 Gemini 实际生成的代码模式、参数错误、工具选择；
- 回放失败请求（code + args + upstream fixtures）；
- 统计各上游/各工具/各错误类的真实分布；
- 发现截断、空结果、慢调用、重试、认证过期；
- 把高频失败自动转成 `explore/tasks-*.json` 用例。

## 8. 评测频率与指标

| 层 | 频率 | 规模 | 内容 |
|---|---|---|---|
| L0 CI | 每次 push | 364 tests + config/audit/coverage | 确定性门禁 |
| L1 smoke | 每晚/每周 | 40–60 分层任务 | 成功、工具命中、token、p95 |
| L2 全量 | 每周/双周 | 228 任务 | 现有 G6 |
| L3 质量 | 每月/按需 | 20–30 golden | judge/人工 |
| L4 线上 | 持续 | 全量 capture | 真实使用与失败 |

指标：成功率、`gateway` 归因错误率、上游错误率、p50/p95、结果字节、截断率、
工具命中、任务成功、capture 完整率（目标 100%，失败单独计数）。

## 9. 隐私与安全

全量原文意味着可能包含用户代码、Notion/GitHub 内容、路径、Issue 文本，甚至模型误贴的密钥。

- 认证头/令牌：不落明文；只记 hash/存在性；
- 原文：私有 Blob、加密、最小权限、访问审计；
- TTL：原始 30 天（可配）；到期删除；
- 脱敏：`authorization`、`cookie`、`token`、`secret`、`api_key` 正则替换；
- 数据出境/第三方：默认不发送；如用外部 judge，需单独同意；
- 用户可见：README/文档说明“网关会记录 MCP 边界内全量原文”。

## 10. 实施阶段

| 阶段 | 内容 | 预估 |
|---|---|---|
| P0 | 本文档 + envelope schema | 完成 |
| P1 | HTTP/MCP 原始 tap + file/http sink + 开关 | ✅ 已实现（`src/capture.js` + 4 tests） |
| P2 | Code Mode/sandbox/upstream 明细 tap + Blob/R2 适配 | 1–2 天 |
| P3 | 回放脚本 + 错误聚类 + scorecard | 2 天 |
| P4 | L1 smoke 定时任务 | 1–2 天 |
| P5 | L3 judge/人工（可选） | 按需 |

## 11. 验收

- [ ] capture on/off 响应字节一致；
- [ ] p95 增量 <5ms；
- [ ] sink 异常不影响响应；
- [ ] 32MB 请求可分片落盘且可回放；
- [ ] SSE 帧顺序/内容不变；
- [ ] 日志中无 token 明文；
- [ ] 一条真实失败可本地回放；
- [ ] scorecard 与上周基线对比。

## 12. 参考

- Dify：Monitoring / Observability / Evaluation：
  https://dify.ai/blog/ai-agent-monitoring-and-evaluation
- Google Cloud 评估数据集结构：
  https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/eval-python-sdk/evaluation-dataset?hl=zh-cn
- Vercel `waitUntil`：
  https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package
- Vercel 运行时日志限制：
  https://vercel.com/docs/limits
- Agent eval 框架对比：
  https://github.com/francisco-perez-sorrosal/praxion/blob/main/skills/agent-evals/references/framework-patterns.md
- MCP benchmark 参考：
  https://neurips.cc/virtual/2026/loc/atlanta/poster/139650
  https://ar5iv.labs.arxiv.org/html/2508.20453
