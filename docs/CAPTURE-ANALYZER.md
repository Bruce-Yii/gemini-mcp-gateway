# 免费分析模型的固定工作流（Capture Analyzer）

> 目标：让免费推理模型只做“脏活累活”的**离线归类/摘要**，不进入网关请求路径，
> 不影响 Gemini，也不直接改代码/仓库。人只审结果和决定修什么。

## 1. 角色边界

| 角色 | 做什么 | 不做什么 |
|---|---|---|
| Gateway capture | 全量记录 MCP 边界内的原始事件 | 不调用分析模型 |
| Deterministic digest | 计数、p50/p95、错误类、工具/上游分布 | 不做语义判断 |
| Free model analyzer | 把失败簇归类、写问题假设、生成回归任务草稿 | 不读密钥、不执行工具、不写仓库 |
| Human | 审 issue、定优先级、改代码 | 不手工翻原始日志 |

## 2. 固定工作流

```text
R2 原始 envelope
  → capture-digest（确定性聚合，当天 scorecard）
  → analyzer-input.v1（脱敏、限长、按错误簇分批）
  → free model（JSON 输出，固定 schema）
  → validator（schema + evidence id + 长度/敏感词）
  → work/analyzer-YYYY-MM-DD.json
  → GitHub issue / scorecard 摘要 / Notion 周报
  → 人审 → 修 → 回归任务进 smoke
```

模型调用是**离线批处理**，不在 `/mcp` 请求里；模型挂了只影响分析，不影响网关。

## 3. 输入 `analyzer-input.v1`

只给模型“可判断的最小证据”，不给完整原文/密钥。

```json
{
  "schema": "analyzer-input.v1",
  "date": "2026-11-22",
  "metrics": {
    "requests": 120,
    "errors": 9,
    "p95Ms": 2400,
    "topErrorClasses": { "upstream_4xx": 5, "timeout": 2, "validation": 2 }
  },
  "clusters": [
    {
      "id": "c1",
      "errorClass": "upstream_4xx",
      "tool": "github__get_file_contents",
      "count": 5,
      "sampleEventIds": ["req_...", "req_..."],
      "sampleCode": "async () => { ... }",
      "sampleError": "404 not found: path ...",
      "durationMs": [120, 300, 900],
      "upstream": "github"
    }
  ],
  "limits": { "maxIssues": 5, "maxCharsPerIssue": 1200 }
}
```

规则：

- `sampleCode`/`sampleError` 先脱敏、截断（例如 2KB/1KB）；
- 每个 cluster 最多 5 个 event id；
- 不传 Authorization/OAuth token、用户隐私字段、完整大文件；
- 单次输入上限约 80KB，超了按 cluster 分批。

## 4. 输出 `analyzer-output.v1`

模型只能返回严格 JSON：

```json
{
  "schema": "analyzer-output.v1",
  "summary": "1-2 句当天主要问题",
  "issues": [
    {
      "id": "issue-1",
      "severity": "P1",
      "category": "gateway | upstream | model | data | unknown",
      "title": "GitHub 文件读取对带空格路径返回 404",
      "evidenceEventIds": ["req_..."],
      "likelyCause": "参数未做 URL 编码",
      "suggestedFix": "在 upstream adapter 编码 path",
      "confidence": 0.6,
      "regressionTask": {
        "prompt": "读取路径含空格的 README",
        "expectedTool": "github__get_file_contents",
        "assertions": ["不返回 404", "返回内容非空"]
      }
    }
  ],
  "ignored": [
    { "clusterId": "c2", "reason": "上游套餐限制，非网关问题" }
  ]
}
```

硬约束：

- 最多 `maxIssues` 条；每条必须引用存在的 `evidenceEventIds`；
- `category` 只能取枚举；`severity` 只能 P0–P3；
- 不确定的放 `ignored`，不要编造；
- 不允许输出代码补丁、命令、链接或自由文本字段；
- validator 拒收 → 记 `analyzer_rejected`，不自动开 issue。

## 5. Prompt 模板（要点）

```text
你是网关 capture 的离线分析器。只根据给定 JSON 归类，不要猜没有证据的东西。
优先区分：gateway 缺陷 / 上游限制 / 模型写法问题 / 数据问题 / 未知。
每条 issue 必须绑定 evidenceEventIds；证据不足就放 ignored。
输出必须是 analyzer-output.v1 JSON，不要 markdown，不要额外解释。
```

## 6. 失败与降级

- 模型超时/限流：跳过当天，保留 digest，不阻塞；
- 输出不合 schema：最多重试 1 次，仍失败则只发 digest；
- 模型编造 event id：validator 删除该 issue；
- 成本/额度：每天只跑 Top N cluster，N 默认 10；
- 数据安全：输入不含密钥；输出不含原文长文本。

## 7. 自动化落点

- `scripts/capture-digest.mjs`：确定性聚合（已实现）；
- `scripts/analyze-captures.mjs`：读 digest + 抽样 envelope，调免费模型，校验输出（待实现）；
- GitHub Actions：每天/每周跑 digest + analyzer，scorecard 进主仓库；issue 由人确认后开；
- 免费模型只配 `ANALYZER_BASE_URL`、`ANALYZER_MODEL`、`ANALYZER_API_KEY`，不接触 R2 写权限。
