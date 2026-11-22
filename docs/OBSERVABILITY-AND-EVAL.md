# 透明观测与评测体系（Observability + Evaluation）

> 状态：**设计稿（DOC ONLY，未实现）** · 2026-11-23
> 目标：Gemini 侧完全无感，网关侧持续留下可回放的原始数据/日志，用数据驱动迭代，
> 不再靠用户反复问 Gemini“哪里不好用”。

## 0. 一句话结论

可以做，而且应该做成**网关侧旁路采集 + 异步落盘 + 分层脱敏**：

- 不改 MCP 工具列表、schema、instructions、响应格式、认证流程；
- 采集不阻塞响应，存储失败自动丢弃（fail-open）；
- 默认只存安全元数据，原始 payload 采样/加密/短 TTL；
- 用采集到的失败轨迹自动生成回归任务，接入现有 G1–G7 与定时评测。

**关键边界**：网关只能看到 MCP 请求/响应，**看不到 Gemini 的聊天上下文、隐藏推理和模型 token 用量**。
能拿到的是：`search` 的 query、`execute_read/execute` 的代码、工具调用参数、上游结果/错误、
耗时、字节数、截断、部署版本。这已经足够做“使用日志 + 失败回放 + 回归”，但不足以单独评“答案好不好”；
答案质量要靠定时评测或客户端反馈补。

## 1. 先区分三个概念

来自 [Dify 的生产实践总结](https://dify.ai/blog/ai-agent-monitoring-and-evaluation)：

| 实践 | 回答的问题 | 典型证据 |
|---|---|---|
| Monitoring | 什么在变？ | 调用量、失败率、延迟、token、成本 |
| Observability | 为什么这样？ | trace、模型/工具调用、上下文路径 |
| Evaluation | 结果够不够好？ | 任务成功、正确性、策略合规 |

评测体系不是“跑一次分”，而是：**数据集 + 执行器 + 指标 + 基线 + 阈值 + 报告 + 回归门禁**。
Google 的评估数据集结构也强调 prompt / response / baseline / reference 四类信息，
没有基线就无法判断“变好还是变坏”（[Google Cloud 文档](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/eval-python-sdk/evaluation-dataset?hl=zh-cn)）。

## 2. 现状与缺口

已有：

- `npm test` 364 条离线测试，CI Node 20/22/24；
- `eval-search`：检索 top1/top5；
- `measure-context`：工具定义上下文；
- `explore/run-explore.mjs`：228 任务全量场景评测（G6）；
- ledger / G1–G7 门禁；
- 线上 healthz、部署 hash、Vercel 日志。

缺口：

| 能力 | 现状 | 影响 |
|---|---|---|
| 线上每次 execute 的结构化记录 | 无 | 出问题只能复现，不能回放 |
| 原始 code/args/results 样本 | 无 | 无法知道 Gemini 实际怎么写、哪里踩空 |
| 定时小样本回归 | 无 | 每次靠用户问 Gemini |
| 错误自动聚类/转任务 | 无 | 同类问题反复出现 |
| 答案质量评测 | 无 | 只知道工具调用失败，不知道答得对不对 |

## 3. 总体架构（旁路，不进入请求关键路径）

```text
Gemini
  │  MCP /mcp（原样，无新增字段）
  ▼
Vercel Function
  ├─ 现有 request handler ──────────────► 原有响应（字节级不变）
  │        │
  │        ├─ capture request meta（tool / codeHash / bytes / requestId）
  │        ├─ capture execute result（ok/error/size/truncated）
  │        └─ capture upstream calls（server/tool/args/status/ms）
  │
  └─ telemetry.emit(event)
           │  同步只做：redact + 限长 + 入内存队列（微秒级）
           ▼
     waitUntil(async flush)
           ├─ Tier 0：结构化 JSON → Vercel logs / Log Drain
           └─ Tier 1/2：采样原始 payload → 私有 Vercel Blob（加密/TTL）
```

原则：**同步路径只做“复制 + 脱敏 + 限长”，不做网络 IO、不 await 存储、不抛错**。

## 4. 采集分层（同一份事件，按模式裁剪）

| 层 | 内容 | 默认 | 用途 |
|---|---|---|---|
| T0 元数据 | ts、requestId、deployment、tool、upstream、ok、errorClass、ms、bytes、truncated、sampled | 全量 | 监控、告警、错误率 |
| T1 脱敏原文 | search query、execute code、tool args、结果文本（限长/脱敏） | 10% 采样 | 看真实用法、失败回放 |
| T2 完整原文 | 完整 code/args/result（加密、TTL 7–30 天） | 手动开启 | 深度 debug，默认关闭 |

配置：

```text
CAPTURE_MODE=off | meta | sample | full
CAPTURE_SAMPLE_RATE=0.1
CAPTURE_MAX_BYTES=65536      # 单事件原文上限，超出只存 hash/长度/截断标记
CAPTURE_TTL_DAYS=14
CAPTURE_SINK=logs | blob | both
```

默认建议：`meta + 10% sample`；`full` 只在你明确要 debug 的窗口开。

## 5. 数据模型（建议 `schema: gmg.eval.v1`）

```json
{
  "schema": "gmg.eval.v1",
  "ts": "2026-11-23T03:00:00.000Z",
  "requestId": "req_...",
  "deployment": { "commit": "a2004e2", "buildHash": "..." },
  "mode": "sample",
  "sampled": true,
  "mcp": { "method": "tools/call", "tool": "execute", "durationMs": 1234 },
  "code": { "text": "async () => { ... }", "bytes": 512, "sha256": "..." },
  "result": { "ok": false, "errorClass": "sandbox_runtime", "bytes": 240, "truncated": false },
  "upstreamCalls": [
    { "server": "github", "tool": "get_file_contents", "args": { "path": "README.md" }, "status": "ok", "durationMs": 210, "bytes": 12774 }
  ],
  "search": { "query": "read file", "hits": 8, "top": ["github__get_file_contents"] }
}
```

说明：

- 不记录 `Authorization`、Cookie、OAuth token、上游 token；
- `args`/`text` 只保留白名单字段或脱敏后的值；
- 大结果不复制全量：只存长度、hash、是否截断、前 N 字符（T1）；
- 事件按请求聚合，不跨请求拼会话（网关无状态）。

## 6. “无感”硬契约（必须可测试）

1. **协议不变**：不新增/删除工具，不改 schema、描述、响应字段、headers。
2. **响应字节不变**：开启 capture 前后，同一请求的响应体逐字节一致。
3. **延迟预算**：同步采集 p95 增量 < 5ms；不做网络/磁盘 IO。
4. **fail-open**：存储失败、序列化失败、配额满，全部吞掉，不影响 MCP 响应。
5. **有界**：单事件限长、每秒队列上限、内存上限；超限丢弃并计数。
6. **可关闭**：`CAPTURE_MODE=off` 立即回到零采集。
7. **不阻塞进程退出**：flush 用 `waitUntil`；没有 `waitUntil` 时退化为结构化日志。
8. **可验证**：单测捕获“响应不变 / 异常 sink 不影响响应 / 超长截断 / 敏感字段被删”。

Vercel 的 `waitUntil` 可在响应返回后继续执行短任务，适合日志/分析类后台写入
（[Vercel Functions API](https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package)、
[Fluid compute](https://vercel-docs.vercel.sh/docs/fluid-compute)）。

## 7. 存储选型

| 方案 | 优点 | 缺点 | 建议 |
|---|---|---|---|
| Vercel Runtime Logs | 零依赖、即时 | Hobby 1h / Pro 1d / Enterprise 3d；单行 256KB、单请求 1MB | 只放 T0 元数据 |
| 私有 Vercel Blob | 大对象、便宜、和部署同域 | 需要建 store；检索弱 | T1/T2 原始事件批文件 |
| Upstash Redis / Postgres | 可查询、可聚合 | 多一个依赖/费用 | 需要 SQL 报表时 |
| Log Drain（NDJSON） | 可接外部可观测平台 | 需 Pro/Enterprise | 以后接 Grafana/Datadog |

Vercel 运行时日志保留期很短，**不能当原始数据仓库**（[Vercel limits](https://vercel.com/docs/limits)）。
MVP 建议：`T0 → Vercel logs`，`T1/T2 → 私有 Blob（JSONL + gzip，按天分区）`。
`waitUntil` 里批量写，失败重试一次，仍失败就丢弃并计数。

## 8. 从“日志”到“迭代”的闭环

```text
采集 → 错误聚类 → 抽样回放 → 最小回归任务 → 修复 → 定时评测 → 基线对比
```

具体：

1. **错误聚类**：按 `errorClass + upstream + tool + code 模式` 聚合；每周看 Top 10。
2. **抽样回放**：取 T1/T2 事件，在本地 gateway 用同一 code/args/fixtures 重跑，确认是网关、上游还是模型问题。
3. **转回归**：确认的问题缩成 1 条 `explore/tasks-*.json` 任务，进 smoke 套件。
4. **修复**：按现有 G5 根因流程；修复后跑 smoke + 相关真实调用。
5. **基线**：结果写 `docs/eval/scorecard.md`，与上周比较；超阈值开 issue。

## 9. 评测频率（不靠用户问）

| 层级 | 频率 | 规模 | 内容 |
|---|---|---|---|
| L0 CI | 每次 push | 364 测试 + config/audit/coverage | 确定性门禁 |
| L1 smoke | 每晚/每周 | 40–60 条分层任务 | 工具选择、成功、token、p95 |
| L2 全量 | 每周/双周 | 228 条 | 现有 G6 全套 |
| L3 质量 | 每月/按需 | 20–30 golden | judge/人工抽检 |
| L4 线上 | 持续 | 全量 T0 + 采样 T1 | 真实失败/延迟/使用模式 |

指标：

- 可靠性：MCP 成功率、`gateway` 归因错误率、上游错误率、超时、OAuth 刷新失败；
- 质量：smoke 任务成功率、工具命中、截断正确率、答案正确性（L3）；
- 效率：结果字节、工具调用数、p50/p95、capture 开销；
- 数据质量：采样率、flush 成功率、丢事件数。

## 10. 隐私与安全

原始 payload 可能包含：

- 用户代码、GitHub/Notion/Linear/Vercel 内容、文件路径、Issue 文本；
- 模型误贴的 token/密钥；
- 个人/业务敏感信息。

必须：

- 不记录认证头/令牌；正则脱敏 `authorization`、`cookie`、`token`、`secret`、`api_key`；
- T2 加密存储、私有 Blob、最小权限、访问审计；
- TTL 到期自动删；只保留“蒸馏后的回归任务”，不长期留原文；
- 提供关闭开关；文档写明采集范围；
- 不把原始数据发给第三方模型做 judge，除非明确同意。

## 11. 实施阶段

| 阶段 | 内容 | 预估 | 验收 |
|---|---|---|---|
| P0 | 本文档 + 事件 schema | 0.5 天 | 评审通过 |
| P1 | `src/telemetry.js` + T0 元数据 + 日志 sink + 开关 | 1 天 | 响应不变、p95 增量 <5ms、sink 失败无感 |
| P2 | T1 采样原文 + 私有 Blob + TTL/脱敏 | 1–2 天 | 可回放一条真实失败 |
| P3 | 每日/每周聚合 + `docs/eval/scorecard.md` | 1 天 | 自动生成报告 |
| P4 | L1 smoke 定时任务 + 基线阈值 | 1–2 天 | 回归自动开 issue |
| P5 | L3 judge/人工抽检（可选） | 按需 | 不阻塞主流程 |

## 12. 验收清单

- [ ] 开启 capture 前后，`tools/list` 快照完全一致；
- [ ] 同一组 20 次真实调用，响应字节一致；
- [ ] p95 延迟增量 < 5ms（本地/线上各测一次）；
- [ ] 注入 sink 异常，MCP 仍正常返回；
- [ ] 超长 code/result 被截断并标记，不爆内存；
- [ ] 日志中搜不到 token/Authorization；
- [ ] 能从一条线上失败事件在本地回放；
- [ ] scorecard 能对比上周基线并给出通过/失败。

## 13. 开放决策

1. 默认 `CAPTURE_MODE`：`meta` 还是 `sample`？（建议 `meta + 10% sample`）
2. T1 原始数据 TTL：7 天还是 14 天？
3. 存储：只 Blob，还是 Blob + Postgres？
4. 是否接受新增 `@vercel/functions` 依赖（为了 `waitUntil`）？
5. 原始数据是否允许跨区域/第三方分析？（默认不允许）

## 14. 参考

- Dify：Monitoring / Observability / Evaluation 的区别：
  https://dify.ai/blog/ai-agent-monitoring-and-evaluation
- Google Cloud：评估数据集的 prompt/response/baseline/reference 结构：
  https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/eval-python-sdk/evaluation-dataset?hl=zh-cn
- Vercel `waitUntil`：
  https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package
- Vercel 运行时日志保留/大小限制：
  https://vercel.com/docs/limits
- Agent eval 框架对比（Inspect AI / DeepEval / Promptfoo）：
  https://github.com/francisco-perez-sorrosal/praxion/blob/main/skills/agent-evals/references/framework-patterns.md
- MCP 评测 benchmark 参考：
  https://neurips.cc/virtual/2026/loc/atlanta/poster/139650
  https://ar5iv.labs.arxiv.org/html/2508.20453
- 指标 Goodhart 风险：
  https://ieeexplore.ieee.org/document/11488866/citations#citations#3
