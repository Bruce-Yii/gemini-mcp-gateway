# 多客户端「一句话自举跑测」统一执行协议（RUNNER）

> **治理标记**：`[云端总控]` 定型（2026-11-25）。  
> **核心理念**：不靠本地脚本代替客户端跑模型，也不靠人工复制几十 KB 提示词。用户在任意已接入 `gemini-mcp-gateway` 的客户端窗口（Gemini / ChatGPT / Claude / Codex）发 **1 句短指令**，客户端自行读仓库、按套餐抽题、逐条执行并按统一格式交卷。

---

## 一、给用户的「一句话触发口令」（直接复制发给目标客户端）

- **部署后极速烟测（T0，4 题只读，~3 分钟）**：
  > 请读取 `Bruce-Yii/gemini-mcp-gateway`（`main`）的 `docs/eval/suites/RUNNER.md` 与 `INDEX.json`，以 `<你的客户端名>` 身份执行 `T0` 套餐（全程只读），严格按 `RUNNER.md` 的交卷格式输出报告。

- **新客户端接入 / 公共层防串伤（T1，纯只读）**：
  > 请读取 `Bruce-Yii/gemini-mcp-gateway`（`main`）的 `docs/eval/suites/RUNNER.md` 与 `INDEX.json`，以 `<你的客户端名>` 身份执行 `byClient.<客户端名>.recommendedT1` 套餐（全程只读），严格按 `RUNNER.md` 的交卷格式输出报告。

- **定向专项压测（按上游或题号）**：
  > 请读取 `Bruce-Yii/gemini-mcp-gateway`（`main`）的 `docs/eval/suites/RUNNER.md` 与 `INDEX.json`，执行 `<upstream 或具体题号列表，如 VLF-LN-01, VLF-LN-03, AC-ADV-02>`，严格按 `RUNNER.md` 的交卷格式输出报告。

---

## 二、客户端执行步骤（强制按序）

1. **读索引选包**：读取 `docs/eval/suites/INDEX.json`，根据用户指定的套餐（`T0` / `T1` / `T2` / `T3`）、客户端名或题号，定位每道题所在的批次文件（`mcpmark-gold.json` / `universe-atlas-gold.json` / `vercel-linear-figma-gold.json` / `adversarial-client-gold.json`）。
2. **拉取完整精题**：并发读取涉及的批次 JSON，提取目标题目的完整 `userPrompt`、`verifiableClaims` 与 `efficiencyBaseline`。
3. **安全边界硬约束**：
   - 若用户要求“纯只读”或套餐为 `T0`/`T1`，**严禁调用任何写工具（`execute` 写入次数必须为 0）**；
   - 若包含写题（`access: write / read-write`），**仅允许写入受控测试仓 `Bruce-Yii/gateway-acceptance-test` 或指定的 Notion 测试父页**，绝对禁止修改 `Bruce-Yii/gemini-mcp-gateway` 主仓或生产配置；
   - 遇到 `rateLimitSensitive: true`（如 Figma 题目）严格控频，遇 429 立即停手并归因上游配额，严禁死循环重试；
   - 严禁打印或回显任何 token / secret / passphrase 明文。
4. **先做冷启动基线检查**：首轮顺带调用 `codemode.services()` 记录 5 大上游状态与 `toolCount`。
5. **逐题实跑并自核 Claims**：严禁凭记忆编造数据、commit SHA 或 `requestId`；遇到截断不得使用 `.slice(0, N)` 静默丢数据。

---

## 三、统一交卷格式（供本地 `AGENTS.md` §3.1.0 强制小闭环自动消费）

客户端最终输出必须包含以下 4 个固定区块：

### Section 0 · 动作范围起止锚点
- **客户端平台**：`gemini` / `chatgpt` / `claude` / `codex`
- **执行套餐 / 题号清单**：...
- **精确可审计时间窗（UTC）**：首个工具返回 UTC 时间 — 最后一次工具返回 UTC 时间（无则写 `unknown`，严禁编造）
- **起止关键动作**：起始动作 → 结束动作
- **可见 requestId**：逐条列出（不可见诚实写 `unknown`）

### Section 1 · 上游服务状态（`codemode.services()` 快照）
- 列出 GitHub / Vercel / Linear / Notion / Figma 的 `toolCount` 与 `status`。

### Section 2 · 逐题验收与 Claim 打分表
- 对每道已执行题目输出：
  - **题号 & 判定**：`PASS` / `PASS-FRICTION` / `FAIL-GATEWAY` / `FAIL-GOVERNANCE` / `FAIL-HOST`
  - **Claim 逐条核验**：对照该题 `verifiableClaims` 逐条标 `1.0 (PASS)` / `0.5 (PARTIAL)` / `0.0 (FAIL)` + 实测证据值，并计算 `coverage = 得分 / 总 Claim 数`（默认 `>= 0.75` 为通过）
  - **失败模式归类（如有）**：从 MCP-Atlas 11 类诊断法中标出主因（工具侧：`malformed_parameters` / `wrong_tool_selection` / `no_tool_use` / `failed_error_recovery`；认知侧：`task_misunderstanding` / `faulty_synthesis` / `response_misparsing` / `early_termination` / `hallucinated_facts` / `logical_errors` / `constraint_violations`）

### Section 3 · 定量效率与摩擦清单
- **效率汇总**：`search` 次数 / `execute_read` 次数 / `execute` 次数 / 审批弹窗次数（无 UI 遥测写 `unknown`）/ 文件正文截断次数 / 输出层截断次数 / 手工 `.slice()` 次数 / 脚本语法重试次数
- **摩擦与缺陷清单（按 P0/P1/P2）**：每条注明属于 `passive-observable` 还是 `active-only`，方便赛后直接进 `AGENTS.md` §3.1.0 小闭环与 `BADCASES.md`。
