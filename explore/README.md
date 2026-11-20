# 探索式测试（规模化版 Gemini 试用）

## 目的

不是打分（pass@k），而是**像 Gemini 那样"试用、感受"，但规模大得多**——用大量来自四个 MCP 官方的示例任务，自动跑，自动捕捉异常，产出"问题清单"作为优化方向。

## 流程

1. `tasks/` — 四个 MCP 官方示例任务（标注来源 URL）
2. `run-explore.mjs` — 用 hy4 通过网关 search+execute 执行每个任务，捕捉异常
3. `report.mjs` — 把异常归类成问题清单（就像 Gemini 给的那份）

## 捕捉的异常类型

- `tool_error`：工具调用返回 isError / 上游 4xx/5xx
- `retry`：同一任务重复调用工具（参数变化 = 盲猜重试）
- `wrong_tool`：调用了与任务明显无关的工具
- `search_empty` / `search_irrelevant`：search 返回空或不相关
- `execute_error`：execute 脚本语法/运行时错误
- `result_too_large` / `truncated`：结果超大或被截断
- `timeout` / `no_result`：超时或没产出
- `model_confusion`：模型表达困惑（"I cannot"、"not sure" 等）

## 模型

- hy4（OpenCode Go，主）：大规模自动跑
- 反重力 flash（对照）：跑一部分，对比不同模型的坑
