# 上下文与准确性：诚实的现状

## 两个关切

用户不放心连接 Gemini，核心是两点：
1. 省上下文不能只是挂载时省，**调用工具时也不能多占**；
2. **准确性**要有可信验证，而不是自说自话。

## 关切一：调用时也省上下文

### 之前的缺陷（已实测确认）
网关只是转发上游结果。实测 `github__get_file_contents` 一次返回约 1900 tokens 全灌进 Gemini 上下文——挂载时省 97%，但调用时不省。

### 已修复（commit be64e63）
`src/server.js` 的 `boundResult()` 对每个文本结果块做上限（默认 8000 字符，环境变量 `GATEWAY_MAX_RESULT_CHARS` 可调）：
- 超限时截断，并附加"已截断 N 字符 + 请用更精确的查询"提示；
- 保留 MCP content 结构（image 等非文本不动）；
- 5 项单元测试覆盖（`tests/result-bound.test.js`）。

这是 Anthropic spill 机制的轻量版，也是 CData harness 采用的业界标准（其工具结果截断阈值就是 8000 字符）。网关单边可控，不需要 Gemini 配合。

### 状态更新（2026-11-22）

完整 Code Mode **已实现并上线**：`search` + `execute`/`execute_read`，结果在沙箱里处理只回摘要。沙箱用 Vercel `run` SDK（QuickJS，真隔离，非 Node vm）。此段旧文字"仍未做"已过期，保留仅作历史。详见 `docs/ledger/batch-0-history.md`、`docs/SANDBOX-SECURITY.md`。

### 截断预算（三层，当前未统一）

| 层 | 位置 | 默认 | 行为 |
|---|---|---|---|
| 上游结果单文本块 | `src/server.js` `boundResult` | `GATEWAY_MAX_RESULT_CHARS`（8000） | 超出时 true cap（head+suffix ≤ maxChars），suffix 写明 `limit/original` |
| `execute()` 返回值 | `src/codemode.js` | 20000 | 结构化截断（同形状 JSON） |
| 模板/文本结果 | `src/tool-format.js` `truncateResponseText` | 24000 | 文本截断 + 定位提示 |

模型看到的上限取决于路径不同；B5 已把 `boundResult` 的提示显式化，三层是否统一/文档化仍是待办（见 `docs/ledger/batch-5-gemini-feedback.md` ISSUE-2）。

## 关切二：准确性

### 结论：没有可拿来即用的评测工具
调研了 Anthropic、OpenCode、CData、Stacklok 等全部现有资产：
- **Anthropic**：工具评测数字（Opus 49%→74%）是内部 eval，无开源数据集/任务/代码；开源的只有实现范式（cookbook）。
- **OpenCode Go**：是模型订阅服务，不是评测框架，无官方工具评测资产。
- **CData connect-ai-gateway-benchmark（MIT）**：评的是数仓/CRM/ITSM 任务，需搬一整套 Snowflake + 3 个特定 MCP server，与我们的场景不适配，适配成本高于重写。
- **Stacklok mcp-tef**：唯一"输入 MCP URL 输出工具选择 TP/FP/TN/FN/参数准确率"的工具，但 2026-11-10 归档、容器镜像私有需 PAT、License TBD。

### 已有的硬事实（不依赖模型，可信）
| 事实 | 数据 | 来源 |
|---|---|---|
| 挂载时上下文节省 | 424 工具 ~202,924 tokens → 16 工具 ~5,300 tokens（省 97%+） | `scripts/measure-context.mjs` 实测真实 schema |
| 四服务工具可调 | 每个服务各实际调用一个工具，返回真实数据 | 线上端到端测试 |
| OAuth 全链路 | 元数据/DCR 6 redirect/PKCE/state/token/MCP 握手全通过 | 线上端到端测试 |
| token 自动续期 | Notion/Linear refresh 逻辑 47 项测试通过 | `tests/upstream-auth.test.js` |

### 缺失的（无法用代理评测可靠得出）
"给 Gemini 用这些工具，任务成功率/工具选择准确率具体多少"——这个数字**只有在 Gemini 里实际跑任务才能得到**。所有代理评测（用 hy4 等别的模型）都有系统性偏差，之前自造的评测已因对照组不公平、gold 错误、评分过宽作废，不再重犯。

## 判断

1. **省上下文：已解决到位**。挂载省 97%，调用侧加了 8000 字符截断。
2. **准确性：代理评测不可靠，不再自己造**；权威 A/B（Anthropic/RAG-MCP）证明"少而精的工具集"方向正确，我们的实现符合该方向。
3. **终极验证**：在 Gemini 里连上真实跑几个任务。这一步无法替代，需要用户操作。

## 复现

```powershell
node scripts/measure-context.mjs      # 上下文节省实测
npm test                              # 52 项测试（含截断 + refresh）
node scripts/verify-real-github.mjs   # 真实 GitHub 调用
```
