# 真实客户端 3 任务 — 运行手册（需要用户操作）

> Gate B 不能由 agent 单独完成：需要用户在真实 Gemini web（或 ChatGPT/Claude）窗口里操作。
> 下面 3 个任务已经准备好确定性输入；用户执行后把「客户端原文 / 工具调用 / 返回字段 / requestId」
> 贴回来，按 [ACCEPTANCE.md](ACCEPTANCE.md) §3 的字段补进
> [ACCEPTANCE-EVIDENCE-2026-11-24.md](ACCEPTANCE-EVIDENCE-2026-11-24.md) §6。
>
> 当前生产：`9ab0e57`（`https://gemini-mcp-gateway.vercel.app`）。
> 注意：入站 OAuth origin 修复（PR #7）**尚未部署**，线上 401 的 `resource_metadata`
> 仍指向 `…yu-ac3a.vercel.app`；如果客户端连接报 issuer/resource 错误，记录原文，
> 不要当成网关 bug 直接改代码。

## 0. 前置（用户操作）

1. 在 Gemini web 里确认 gateway 已连接（`search`/`execute_read`/`execute` 可见，3 个工具，顺序不变）。
   如果还没连接：按 `docs/CLIENTS-*.md` 走一次连接；这一步本身就是 Gate D 的真实证据，
   记录授权前后的 URL/issuer/回调结果。
2. 准备一个能粘贴结果的地方（本文件 §4 模板）。

## 1. 任务 T1 — 读文件（纯正文 + 首行 + 长度）

**粘贴给客户端的 prompt：**

```text
Use the gateway's execute_read tool to read the file src/sample.txt from the private
repo Bruce-Yii/gateway-acceptance-test at ref main. Then answer exactly:
1) the first line of the file content,
2) the character count of the content,
3) whether the result has truncated=true,
4) whether the content string contains the phrase "successfully downloaded".
Do not guess; if the tool fails, paste the exact error.
```

**期望（本地同路径实测）：** first line `line1`；content 19 chars（`line1\nline2\nline3\n\n`）；
`truncated=false`；不含 `successfully downloaded`（notice/SHA 只应在元数据）。

## 2. 任务 T2 — PR number vs DB id

**粘贴给客户端的 prompt：**

```text
Use the gateway to read pull request #1 in Bruce-Yii/gateway-acceptance-test.
Report: the PR number, the full html_url, the PR title, and the repo name.
If the tool exposes an internal id/nodeId, list it separately as "id" and do not use it as number.
```

**期望：** number=`1`；url=`https://github.com/Bruce-Yii/gateway-acceptance-test/pull/1`；
title=`acceptance: read → patch → commit → PR (20261123183811)`；id/nodeId 只能作为独立字段。

## 3. 任务 T3 — 大文件截断（末尾/字段元数据）

输入 fixture：分支 `acceptance/large-fixture`，文件 `fixtures/large.txt`，12,000 chars / 120 行。
（该分支只含 fixture，不动 main。）

**粘贴给客户端的 prompt：**

```text
Use the gateway's execute_read tool to read fixtures/large.txt from
Bruce-Yii/gateway-acceptance-test at ref acceptance/large-fixture.
Report exactly:
1) truncated (true/false/null),
2) the truncation metadata fields you received (field/total/tail/next if any),
3) the first line and the last line of the content you actually got,
4) whether the last line is line-120 or something else.
```

**期望：** 默认 `GATEWAY_MAX_RESULT_CHARS=8000`，12,000 chars 应触发截断：
`truncated=true` + 明确 marker/元数据；**末尾是否保留 line-120 是本次要观察的点**
（如果只保留头部，记录 `tail` 缺失，不要替它补结论）。

## 4. 记录模板（每个任务一份）

```text
gate: B
commit/build: 9ab0e57（healthz 实查）
client: gemini web | chatgpt | claude | inspector
task: T1 / T2 / T3
exact tool call: <客户端显示的工具名 + 参数；没有就写 unknown>
actual: <客户端原文 / 返回字段>
expected: <上文期望>
requestId: <客户端/capture 提供的；没有就写 unknown，不要编造>
pass/fail: <按实际>
evidence: <截图/客户端原文路径 或“用户粘贴”>
```

## 5. 完成标准

- T1–T3 各有一份上述记录；
- 失败项写清是客户端宿主不可控（记 `unknown`）还是网关行为（记 fail）；
- 任何一项与期望不符，进入半在线任务/测试，而不是直接改代码；
- 三项都完成后 B 门才可能从 FAIL 升级；**在此之前不要写“客户端验收通过”**。

## 6. 已知阻塞 / 需要用户动作

| 项 | 需要谁 |
|---|---|
| 真实客户端 3 任务 | 用户浏览器 |
| GitHub Actions 绿灯（C 门 CI） | 用户修 billing/spending limit |
| preview 独立 KV（D 门隔离） | 用户改 Vercel env |
| Linear PAT / Notion token / Vercel OAuth | 用户按 AUTH-READY 全绿后一次性授权 |
| PR #6 / #7 合并与手动部署 | 用户决定（当前禁止自动 production 部署） |
