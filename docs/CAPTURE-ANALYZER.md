# 免费分析模型的固定工作流（Capture Analyzer）

## 0. 硬规则（不可绕过）

免费模型能力弱于主模型，它的输出**只能当假设**：

- issue / severity / category / suggestedFix 都不是事实，也不是指令；
- 禁止根据它的建议直接改代码、开 issue/PR、合并、部署；
- 每条建议必须能回到原始 capture 的 `requestId`，并在本地用同一 code/args/fixtures 复现；
- 复现不了就丢弃；修复前先写确定性回归测试/任务；
- 修完跑 L1 smoke 或相关测试，证明“不是模型觉得改好了”；
- 模型可以给方向，不能给结论。

这条规则同时写进 `AGENTS.md`，优先级高于任何“自动修复/自动闭环”的设想。

> 目标：让免费推理模型只做“脏活累活”的**离线归类/摘要**，不进入网关请求路径，
> 不影响 Gemini，也不直接改代码/仓库。人只审结果和决定修什么。

## 1. 角色边界

| 角色 | 做什么 | 不做什么 |
|---|---|---|
| Gateway capture | 全量记录 MCP 边界内的原始事件 | 不调用分析模型 |
| Deterministic digest | 计数、p50/p95、错误类、工具/上游分布 | 不做语义判断 |
| Free model analyzer | 把失败簇归类、写问题假设、生成回归任务草稿 | 不执行工具、不直接写仓库 |
| Human | 审 issue、定优先级、改代码 | 不手工翻原始日志 |

## 2. 固定工作流

```text
R2 原始 envelope
  → capture-digest（确定性聚合，当天 scorecard）
  → analyzer-input.v1（原始样本、限长、按错误簇分批）
  → free model（JSON 输出，固定 schema）
  → validator（schema + evidence id + 长度）
  → work/analyzer-YYYY-MM-DD.json
  → GitHub issue / scorecard 摘要 / Notion 周报
  → 人审 → 修 → 回归任务进 smoke
```

模型调用是**离线批处理**，不在 `/mcp` 请求里；模型挂了只影响分析，不影响网关。

## 3. 输入 `analyzer-input.v1`

给模型完整原始样本（仅按长度截断）。

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
  "samples": [
    {
      "id": "req_...",
      "tool": "execute_read",
      "code": "async () => { ... }",
      "status": 200,
      "durationMs": 6228,
      "bytes": 3000,
      "sandboxTools": 11
    }
  ],
  "limits": { "maxIssues": 5, "maxCharsPerIssue": 1200 }
}
```

规则：

- `sampleCode`/`sampleError` 原样传入，仅按长度截断（例如 2KB/1KB）；
- 每个 cluster 最多 5 个 event id；
- 完整 headers/body/上游原文可随 cluster 传入；
- 单次输入上限约 80KB，超了按 cluster 分批。

## 4. 输出 `analyzer-output.v1`

模型只能返回严格 JSON：

```json
{
  "schema": "analyzer-output.v1",
  "policy": "free-model-advisory-v1",
  "advisoryOnly": true,
  "requiresHumanReview": true,
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
- 输入/输出都保留原始样本，不做内容过滤。

## 7. 自动化落点

- `scripts/capture-digest.mjs`：确定性聚合（已实现）；
- `scripts/analyze-captures.mjs`：读 digest + 抽样 envelope，调免费模型，校验输出（已实现）；\n- `.github/workflows/capture-daily.yml`：每日跑 digest + analyzer，scorecard 提交到 `docs/eval/`，原始 artifact 保留 14 天。
- GitHub Actions：每天/每周跑 digest + analyzer，scorecard 进主仓库；issue 由人确认后开；
- 免费模型只配 `ANALYZER_BASE_URL`、`ANALYZER_MODEL`、`ANALYZER_API_KEY`，不接触 R2 写权限。

## 8. 首次真实运行（2026-11-22）

- 输入：11 条 MCP POST 请求、4 条成功 execute 样本、p95 6228ms、0 个错误簇；
- 模型：`hy4-flash-free`（`x-opencode-session` 必填）；
- 输出：2 条 P2 issue（validator 通过）：
  1. 工具结果形状不统一，样本里反复 `unwrap`/字段兜底；
  2. 长链 `execute_read` 拉高 p95，缺分步耗时/批量 helper。
- 说明：即使没有错误簇，模型也能从成功样本里产出“摩擦点/优化建议”；
  这是“用现有采集数据驱动改进”的最小闭环。