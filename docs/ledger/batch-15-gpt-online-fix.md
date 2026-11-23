# B15 · ChatGPT 在线实测三网关问题修复 + 在线评测记录（2026-11-23）

> 范围（本批只写所列文件）：
> - `src/github-helpers.js`（改）：Actions 日志 REST Accept + 302 signed URL 跟随；`canonicalResult` additive `id`/`nodeId`。
> - `src/result-normalize.js`（改）：`normalizeFileResult` 从 URI 解析 `path`；`normalizePrResult` additive `nodeId`（非枚举，稳定字段集不变）。
> - `src/codemode.js`（改）：guest `fileResult` URI→path、`prResult` `id`/`nodeId` 分离为 string。
> - `tests/gpt-online-fix.test.js`（新增）：15 项确定性回归（415/302/200、path、raw envelope、PR id/nodeId、两者一致）。
> - `docs/eval/online-feedback-2026-11-23-chatgpt.md`（新增）：按 `online-feedback.v1` 记录通过项/失败项/证据/半在线映射。
> - 本台账 `docs/ledger/batch-15-gpt-online-fix.md`（新增）。
>
> **未改** `src/capture.js`、`src/server.js`、`scripts/`、其它 `tests`、`README`、workflows、契约文档。
> **未 commit / push / deploy**。未触凭据、不联网、不开 issue、不合并。
> 遵守 `AGENTS.md`：在线用户报告是待验证证据；先写确定性测试，再改代码，再跑测试证明。

---

## 一、输入证据（只引用，不重新取证）

- 用户通过 ChatGPT 经本地网关只读实测的工具输出与 curl 复现（本记录 F1–F5）。
- F1：`codemode.github_actions_get_job_logs` 返回 `ok:false status:415`；curl 证实 REST 端点要求 `Accept: application/vnd.github+json`，`application/octet-stream` → 415；302 到 signed Blob URL，跟随不能带 `Authorization`，Accept 用 `*/*`/`text/plain`。
- F2：`normalizeFile.path` 为 null；原始 `resources[].uri = repo://Bruce-Yii/.../contents/<path>`。
- F3：`normalizeFile` canonical content 已剥离 notice，但外层 `value.text` 仍有 `successfully downloaded...`（上游包装，不改上游）。
- F4：`prResult`/canonical 未暴露 PR DB `id`/`node_id`；需与 number 区分（PR #59）。
- F5：正面项——branch 别名控制实验、PR #59 number/checks、大文件 `truncated=false`、工具发现均符合预期。
- 无 requestId / 无 capture 可回放：全部 `requestIds:["unknown"]`，`captureVerified:false`。

## 二、改动逐项

| 反馈 | 根因 | 修复 | 回归测试 |
|---|---|---|---|
| F1 Actions 415 | `githubActionsGetJobLogs` 给 REST 端点传 `Accept: application/octet-stream` | 初始请求改 `application/vnd.github+json`；新增 `followAccept` 选项；`githubRestGet` 302 跟随改为不带 token、Accept 默认 `*/*`（或显式 `text/plain`） | 首跳 Accept 断言、415 结构错误、302 signed URL 无 token + 通用 Accept、200 返回 text、followAccept 覆盖 |
| F2 path=null | 只取显式 `path`/`name`/`uri`，不解析 `contents/` URI | 新增 `pathFromUri`/`resolveFilePath`，从 root + resources + content 数组解析 `repo://.../contents/<path>`；无 URI→null，不猜测；显式 path 优先；guest 同步解析 | URI 解析、root/嵌套/显式优先、无 URI→null、百分号解码、guest 一致 |
| F3 envelope vs content | 误把 raw.text 的提示当 bug | 不改上游；raw 按契约保留原引用；文档写清「原始 envelope ≠ canonical content」 | `out.raw === raw` 且 `out.raw.text` 含提示、`out.content` 纯 body |
| F4 PR id/nodeId | 旧字段把 id/node_id 混在一起，canonical 无 id/nodeId | `canonicalResult` additive `id`/`nodeId`（有则 string，仅上游提供时出现，保持历史 4-key 形状）；`normalizePrResult` `nodeId` 非枚举 additive（稳定字段集不变）；guest `prResult` `id`/`nodeId` 分离为 string | `{id:5444514334,number:999,url:/pull/59}` → `number=59`、`id`、`nodeId`、number≠id；guest/host/canonical 三方一致 |
| F5 正面项 | 无（不变量） | 不改实现，纳入回归保护 | 既有 `online-gap-regression`、`result-normalize` 测试全量绿 |

## 三、测试结果（只报告本批文件，不替并发改动背书）

### 新增测试
`node --test tests/gpt-online-fix.test.js` → **15/15 pass, 0 fail**。

### 相关既有测试（本地定向复跑）
`node --test tests/result-normalize.test.js tests/github-helpers.test.js tests/gh-feedback-fixes.test.js tests/b10-write-semantics.test.js tests/online-gap-regression.test.js`
→ **115 tests, 109 pass, 0 fail, 6 todo**（todo 为既有 P0 阻塞项，本批未改其状态）。

### 全量 npm test（实际运行结果）
`npm test` → **955 tests, 929 pass, 20 fail, 6 todo**（0 skipped）。
本批新增的 15 项 `gpt-online-fix` 测试在全量中**全部通过**（逐条确认）。

20 个失败全部落在 auth/oauth/token/store 相关测试文件：
`tests/audit-truncation.test.js`、`tests/cas-fencing.test.js`、
`tests/invalid-grant.test.js`、`tests/refresh-concurrency.test.js`、
`tests/refresh-once.test.js`、`tests/stale-kv.test.js`、
`tests/token-liveness.test.js`、`tests/upstream-auth-generic.test.js`、
`tests/upstream-auth.test.js`、`tests/upstream-oauth.test.js`、
`tests/upstream-token-lifecycle.test.js`。

并发说明：`git status` 显示**其它 agent** 正在改 `src/store.js`、
`src/upstream-auth.js`、`src/upstream-oauth.js`、`src/upstreams.js`、
`tests/upstream-token-lifecycle.test.js`，并新增 `scripts/auth-rotation-sim.mjs` /
`tests/auth-rotation-sim.test.js` / `docs/ledger/batch-15-auth-sim.md`。
上述失败与其认证/轮换改动同域，**与本批三个 src 文件及本批新增测试无关**；
本批不修改、不修复、不为这些并发失败背书。按要求「并发影响只报告自己的」：
本批自己的测试与相关既有测试全绿；全量残留失败由 lead 在集成时与 auth agent 统一处理。

## 四、半在线映射（本次在线评测 → L1 fake/real）

- **Actions 日志 415 → L1 fake/real 测试**：在线 415 症状被抽象为 fake fetch 的首跳
  Accept 断言 + 302 token 隔离断言（fake 模式，确定性可重跑）；真实 GitHub（real 模式）
  需 `GITHUB_TOKEN` + 部署窗口，本批不联网、不跑 real。
- **path / id → canonical 字段测试**：在线 path=null 与 id/number 混淆被抽象为纯函数
  字段断言（host `normalizeFileResult`/`normalizePrResult`/`canonicalResult` + 沙箱
  `prResult`/`fileResult`），属于 L1 层，不占用 L1 task 分母。
- 在线单个 HTTP request ≠ L1 task；不比较 durationMs/p95，不换算 bytes/tokens。

## 五、状态与后续

- F1/F2/F3/F4 在本台账标 **代码层 fixed + 本地测试绿**；真实窗口端到端回放未做，
  在线记录整批仍 `status: unverified`（无 requestId，不升级）。
- F5 标 `confirmed`，作为不变量保护。
- 待 lead / 部署窗口验证：真实 Actions job 日志 415 消失且 302 跟随成功；真实 PR #59
  的 id/nodeId 与 number 区分；真实读取的 path 解析。验证后由人决定是否升级在线状态。
- 本批未改上游、未改工具数（仍为 `search`/`execute_read`/`execute` 三工具）、未改契约。

## 六、变更控制

本批只写 6 个文件（3 src + 1 test + 2 docs）；未 commit / push / deploy；无凭据入仓；
无网络调用。所有证据留在工作区与在线评测文档，供 lead 集成与复核。
