# 架构审计补篇 16 — tests/ 逐文件深读（前半 A–M）

> 只读审计。未改 `src/`、`scripts/`、`tests/`、README、其他 docs、workflows；未 commit/push/deploy。
> 依据：`docs/FRAMEWORK.md`（六模块 + §13 定稿）、`docs/ARCHITECTURE.md` 指向的架构口径、`docs/ACCEPTANCE.md` 的“测试绿 ≠ 验收”、`docs/architecture-audit/README.md`。
> 标记约定：**[测试]** = 本半集测试文件直接证明；**[代码]** = 由测试导入/断言反推的源码事实（未逐行读源码）；**[未验证]** = 本半集不能证明、需真实客户端/真实上游/线上证据。
> 本审计只覆盖 `git ls-files tests | sort` 的前半（A–L 段），后半（M–Z）由另一 agent 覆盖。

---

## 0. 清单与完成度

`git ls-files tests | sort` 结果：**TOTAL=127**，前半取 `floor(127/2)=63` 个文件（序号 1–63，A–L；最后一个是 `tests/l1-online-gap-wire.test.js`）。

- **expected = 63**
- **read = 63**（全部以 read 工具逐文件完整打开，非仅文件名/grep）
- **unread = 0**

完整清单（按排序序，括号内为本文件顶层 `test()/t()/cloneTest()` 声明数；`for` 循环展开的测试另注）：

1. `tests/arg-validation.test.js` (13)
2. `tests/audit-leak.test.js` (5)
3. `tests/audit-tools.test.js` (6)
4. `tests/audit-truncation.test.js` (15)
5. `tests/auth-arch-fix.test.js` (18)
6. `tests/auth-e2e-harness.test.js` (9)
7. `tests/auth-provision.test.js` (21)
8. `tests/auth-rotation-sim.test.js` (16)
9. `tests/b10-codemode.test.js` (14)
10. `tests/b10-write-semantics.test.js` (19)
11. `tests/b11-write-transaction.test.js` (19)
12. `tests/b2-patch.test.js` (4)
13. `tests/capture-analyzer.test.js` (10)
14. `tests/capture-completeness.test.js` (17)
15. `tests/capture-digest.test.js` (7)
16. `tests/capture-http.test.js` (6)
17. `tests/capture-queue-integration.test.js` (9)
18. `tests/capture-queue.test.js` (20)
19. `tests/capture-sink-fix.test.js` (9：2 个 for 循环各展开 2 → 实际 11 个用例)
20. `tests/capture-truncation-audit.test.js` (11)
21. `tests/capture.test.js` (10)
22. `tests/cas-fencing.test.js` (1)
23. `tests/catalog.test.js` (13)
24. `tests/chatgpt-oauth.test.js` (12)
25. `tests/check-env-isolation.test.js` (8)
26. `tests/claude-connector.test.js` (8)
27. `tests/client-lock.test.js` (3)
28. `tests/client-platform.test.js` (17)
29. `tests/client-profile.test.js` (17)
30. `tests/codemode-date-helper.test.js` (3)
31. `tests/codemode-edit-helpers.test.js` (10)
32. `tests/codemode-ergonomics.test.js` (19)
33. `tests/codemode-file-pr-helpers.test.js` (3)
34. `tests/codemode-fixes.test.js` (10)
35. `tests/codemode-rest.test.js` (12)
36. `tests/codemode-slice-lines.test.js` (3)
37. `tests/codemode-unwrap.test.js` (6)
38. `tests/codemode.test.js` (6)
39. `tests/config-validation.test.js` (7)
40. `tests/detector.test.js` (20，全部私有 fixture gate)
41. `tests/docker-host.test.js` (5)
42. `tests/eval-cycle.test.js` (15)
43. `tests/export-oss.test.js` (10)
44. `tests/figma-guard.test.js` (12)
45. `tests/file-write.test.js` (15)
46. `tests/final-review.test.js` (14)
47. `tests/friendly-truncation.test.js` (8)
48. `tests/gateway-rest.test.js` (13)
49. `tests/gemini-feedback.test.js` (8)
50. `tests/gemini-feedback2.test.js` (10)
51. `tests/gh-feedback-fixes.test.js` (15)
52. `tests/gh-file-p0.test.js` (13)
53. `tests/github-helpers.test.js` (13)
54. `tests/golden-mcpmark.test.js` (9，6 个需私有 fixture + 本地 clone；3 个 t() 也需私有 fixture)
55. `tests/gpt-online-fix.test.js` (13)
56. `tests/grep-snippet.test.js` (3)
57. `tests/harness-parallel.test.js` (13，全部私有 fixture gate)
58. `tests/healthz.test.js` (5)
59. `tests/image-passthrough.test.js` (4)
60. `tests/invalid-grant.test.js` (1)
61. `tests/l1-baseline.test.js` (4 + 6 个私有 fixture gate)
62. `tests/l1-failed-server.test.js` (5 + 11 个私有 fixture gate)
63. `tests/l1-online-gap-wire.test.js` (11 + 6 个私有 fixture gate)

---

## 1. 逐文件深读表

字段含义：**路径 / 测试数 / 覆盖什么 / fake 还是真实 / 跳过条件 / 断言强度**。
断言强度分：强（精确到字段/字节/计数/调用次数/错误文案且含反例）、中（主路径+部分边界）、弱（只断言存在性/形状/布尔）。

### 1.1 `tests/arg-validation.test.js` — 13
- 覆盖：Code Mode 沙箱内 `codemode.<tool>(args)` 的 required 缺失、顶层基础类型校验；校验失败不消耗预算、不进审计；合法参数透传；enum/items/嵌套不深挖；discovery helper 不受影响；导出 `validateToolArgs` 纯函数。
- fake/真实：vm 沙箱真实运行 `runInSandbox`；`callTool` 是记录型 fake（**fake upstream**）；无网络。
- 跳过：无。
- 断言强度：**强**（错误文案正则、`calls.length===0`、预算/审计计数、跨 realm JSON 规整、原型链属性不算填充）。

### 1.2 `tests/audit-leak.test.js` — 5
- 覆盖：模型侧 execute 输出不泄漏 toolCalls/大参数摘要/unbounded console.logs；`toModelOutput` 投影；错误结果保留 status/error；内部审计链保留。
- fake/真实：真实 `createCodeModeTools`/`runInSandbox`；`fakeManager()` 注入的 **fake upstream**；文件注释显式指出 `toModelOutput` 已实现、skip 分支不再触发。
- 跳过：`typeof mod.toModelOutput !== 'function'` 时 skip（当前不触发，历史兼容）。
- 断言强度：**强**（哨兵字符串存在/不存在、正则禁止审计字段、长度上界、内部 toolCalls 仍在）。

### 1.3 `tests/audit-tools.test.js` — 6
- 覆盖：`scripts/audit-tools.mjs` 的 snapshot/official/policy 三方对照：缺官方工具、未声明额外工具、deny 需显式理由、deny 双向一致、allowExtra 不可被 deny。
- fake/真实：纯函数 + 内存 snapshot/official/policy 夹具；**fake**。
- 跳过：无。
- 断言强度：**强**（`ok` 布尔 + 精确错误文案 + stats 计数）。

### 1.4 `tests/audit-truncation.test.js` — 15
- 覆盖：`scripts/audit-truncation.mjs` 词法扫描的 P0/P1/P2 分类、exempt、JSON/退出码契约、`--ci` 隐藏 P2、`auditTree` 只扫配置根、`summarize`仅在 P0>0 FAIL；含真实 CLI `spawnSync` + 临时目录树。
- fake/真实：**临时文件树 + 真 CLI 子进程**（非网络）；源码夹具为字符串。
- 跳过：无。
- 断言强度：**强**（severity 数组 deepEqual、status 0/1、stdout 正则、committed src 必须 P0=0）。

### 1.5 `tests/auth-arch-fix.test.js` — 18
- 覆盖：R1 unmarked owner 永不 refresh；R2 环境默认 local/preview；R3/R5 OAuth state 与 callback 携带 env+owner+source+grantId 写入 v2 key；R4 legacy key 只读、写 v2；R6 同实例 refresh 合并 + 跨实例 lease；static_bearer 路径；Vercel offline_access；环境串写污染检测。
- fake/真实：`UpstreamAuth` 是**真实源码**；fakeStore（内存 KV + casToken/releaseLease/renewLease）、fakeFetch 拦截 token endpoint；`RealTokenStore` 仅测 key 形状（url 为 `.invalid`）。**全 fake I/O，零网络**。
- 跳过：无。
- 断言强度：**强**（providerCalls 计数、KV key 精确、字段值、错误 reason 常量、跨环境 key 隔离）。

### 1.6 `tests/auth-e2e-harness.test.js` — 9
- 覆盖：`scripts/auth-e2e-harness.mjs` 在真实 Node loopback HTTP server 上跑完整 OAuth 流程：Notion DCR 注册一次、Vercel CIMD document route、offline_access、缺 refresh_token→400、state/env 拒绝、shared grant 不刷新、preview/prod 隔离、fake fetch 白名单、注入失败、报告脱敏。
- fake/真实：**真实 loopback HTTP + 真实 handler**；provider 响应与 KV 全 fake（文件头明示）。
- 跳过：无。
- 断言强度：**强**（每个 named check 的 ok、整体 ok、stdout/stderr 口令泄漏守卫、序列化报告无口令）。

### 1.7 `tests/auth-provision.test.js` — 21
- 覆盖：static_bearer config 校验与 token 不打印；v2 显式 key；Linear PAT / Notion static / DCR / Vercel offline_access 分支；“not-ready”清单；`main()` 退出码与 `--json`。
- fake/真实：`validateConfig`/`planProvision`/`provision` 是真实脚本/源码；fakeStore + 注入 `fetchImpl` 断言只打官方 tools/list URL；**fake network**。
- 跳过：无。
- 断言强度：**强**（no-token→零网络、token 不出现在 stdout、key 精确、blockers 非空、exit code 2/1/0）。

### 1.8 `tests/auth-rotation-sim.test.js` — 16
- 覆盖：四种 refresh 策略（none/current/owner-fenced/owner-fenced-readback）在并发/cold-start/lease-expiry/shared-grant/cross-env/CAS-failure 场景下的行为；token 掩码；确定性矩阵。
- fake/真实：**纯模型仿真**——`scripts/auth-rotation-sim.mjs` 的 FakeClock/StepQueue/FakeKV/FakeOAuthProvider/Instance；文件头明示“no src/ imports”。**fake upstream**。
- 跳过：无。
- 断言强度：**强**（refreshCount/invalidGrantCount/finalTokenUsable/staleDeleteCount 精确数值、报告字节级确定性、口令不出现）。

### 1.9 `tests/b10-codemode.test.js` — 14
- 覆盖：B10 canonical adapters（normalizeFile/Pr/Issue/Result）、download notice 不冒充正文、helper 隐藏；applyFilePatch dryRun/mismatch/sha 乐观锁/写失败；ensureBranch/upsertPr/fetchAllPages/repoGrep；helper 消耗预算；3 工具 schema 不变。
- fake/真实：真实 `runInSandbox`；`callTool` 返回 MCP content-envelope 形状的 **fake upstream**；无网络。
- 跳过：无。
- 断言强度：**强**（调用序列、args 字段、返回字段集合、预算边界）。

### 1.10 `tests/b10-write-semantics.test.js` — 19
- 覆盖：create_branch_if_missing 三态；applyFilePatch/writeFiles 单/多文件统一字段与 sha 自动填充；canonical number/url/sha；写前 precheck（JSON 严格、JS/TS 括号平衡）阻断写。
- fake/真实：host 层注入 read/write/getSha fake；sandbox 层 fake tool bridge。**fake upstream/无真实 GitHub 写**。
- 跳过：无。
- 断言强度：**强**（字段集合 deepEqual、写入次数 0/1/2、precheck 失败零写、host/sandbox 一致性）。

### 1.11 `tests/b11-write-transaction.test.js` — 19
- 覆盖：push_files 原子写成功/失败/不可用；precheck 失败零写；fallback 部分失败 partial/written/remaining/compensation；单文件回归；atomic 能力探测与 args 构造；sandbox 对应路径。
- fake/真实：host `commitFiles`/`write` 全 fake；sandbox `github::push_files` 等 fake tool bridge；**无真实写回环**。
- 跳过：无。
- 断言强度：**强**（commit 次数恰好 1、per-file write 恰好 0、失败不伪装成功、compensation 文案、fail-fast 零调用）。

### 1.12 `tests/b2-patch.test.js` — 4
- 覆盖：sandbox `codemode.search` 空结果兜底与外层 handler 共用 `searchWithFallback`；`select:` 不走兜底、保留完整 schema；execute/execute_read 描述含边界/拒绝引导。
- fake/真实：真实 `createCodeModeTools`/`runInSandbox`；固定工具清单 + `callTool: OK` fake。
- 跳过：无。
- 断言强度：**强**（名称/总数/hint 三方 deepEqual、文案子串）。

### 1.13 `tests/capture-analyzer.test.js` — 10
- 覆盖：`buildAnalyzerInput` 失败聚类、证据 requestId、代码截断；`validateAnalyzerOutput` 丢弃坏 category/编造证据；405 probe 忽略；advisory-only 门禁；dailyTrend、per-upstream 错误率（源于 events 而非 MCP 工具名）；isoWeek；weekly review 渲染。
- fake/真实：全内存 envelope 夹具（含 `[truncated]` 标记）；纯脚本函数；**fake**。
- 跳过：无。
- 断言强度：**强**（聚类计数、sampleEventIds deepEqual、advisoryOnly/requiresHumanReview、evidence id cap、无代码块）。

### 1.14 `tests/capture-completeness.test.js` — 17
- 覆盖：每个 capture-enabled POST 恰好一个 ack + 一个 done 共享 requestId；401/403/405 也记；双 end 不重复；sink 失败 capture_dropped；mode off→skipped；reason 白名单不泄漏 token；幂等；sink 同步入队；vercel-app 401/有效 token/非 POST；server handler 防双 capture；envelope 带 sessionId/clientInfo。
- fake/真实：真实 `startCapture`/`createAppHandler`/`createMcpRequestHandler` + temp 文件 sink；req/res double；STORE token 为 `valid/expired` 假值；**无真实 R2/线上**。
- 跳过：无。
- 断言强度：**强**（ack/done 计数=1、字段逐项、requestId 一致、文件数=1、安全 reason 枚举）。

### 1.15 `tests/capture-digest.test.js` — 7
- 覆盖：请求/工具/错误类聚合、auth/timeout/rate-limit 分类、scorecard 渲染、per-upstream/per-tool 统计、tool 前缀回退、truncation 与 overflow 分桶、按天/UTC 小时分桶、非 MCP 路由分离。
- fake/真实：内存 envelope 夹具 + 纯脚本函数；**fake**。
- 跳过：无。
- 断言强度：**强**（p50/p95、errorRate 四位小数、分桶 deepEqual、分节标题）。

### 1.16 `tests/capture-http.test.js` — 6
- 覆盖：`makeCaptureFetch` 非 SSE body 捕获与 cap、SSE bodySkipped:stream 不阻塞、大 body 64KB cap、无 clone 降级；capture_dropped fallback POST 带 token；fallback 失败静默。
- fake/真实：真实 `startCapture`+file sink；全局 `fetch` 被替换为返回 `Response` 的 **fake upstream**；无网络。
- 跳过：无。
- 断言强度：**强**（events phase/字段、body 长度、耗时上界、fallback URL/token/schema）。

### 1.17 `tests/capture-queue-integration.test.js` — 9
- 覆盖：CAPTURE_ASYNC_QUEUE flag OFF/ON 的 legacy vs queue 行为；critical 行同步；CAPTURE_SYNC 被覆盖；响应字节一致；sink 失败 ack/done 保留 + DLQ；500 重试；R2 key/gzip/schema 兼容；requestId 去重。
- fake/真实：真实 `startCapture`+`CaptureQueue`；注入 batch sink + 确定性 fakeScheduler；**无网络、无真实计时等待**。
- 跳过：无。
- 断言强度：**强**（gate promise 证明 res.end 不被阻塞、写入次数、重试计数、快照去重计数）。

### 1.18 `tests/capture-queue.test.js` — 20
- 覆盖：`src/capture-queue.js` API/CRITICAL_TAGS、200 突发批处理、顺序、500/429/400/abort 重试与 DLQ、requestId 去重、maxItems/maxBytes 背压、critical 优先、observability 不泄漏 body/token/错误原文、createHttpSink、close/determinism/drain。
- fake/真实：纯队列 + fakeScheduler + 注入 sink/fetchImpl；**fake**。
- 跳过：无。
- 断言强度：**强**（顺序 deepEqual、退避 delay、DLQ meta、ring overflow 保留 critical、序列化无口令）。

### 1.19 `tests/capture-sink-fix.test.js` — 9（2 个循环各展开 2 → 11 用例）
- 覆盖：HTTP sink 2xx 记 sink_ok、500/429 不记且 drop 且不回显响应体里的 token；abort 记 drop；sync 模式 `mcp_latency_ms` 含 sink 等待而 legacy duration 不含；async 不含；默认 CAPTURE_SYNC off；abort/retry 不双写；响应字节不变。
- fake/真实：真实 `startCapture`；`fetchImpl` 注入 200/500/429/abort/delay；**fake network**。
- 跳过：无。
- 断言强度：**强**（endAt 与实际 originalEnd 时间相等、waitedMs ≥ delayMs-20、token 不出现、POST 次数=1）。

### 1.20 `tests/capture-truncation-audit.test.js` — 11
- 覆盖：`buildModelOutputAudit` 源字节/模型输出字节/possibleModelTruncation、显式 truncated、wire marker、50% 阈值、overflow 不触发；envelope 加字段；digest 分桶；scorecard 章节；analyzer 独立 cluster 保留 requestId/sessionId；两个真实事故 requestId。
- fake/真实：内存 envelope（A×1000）+ 一次真实 file sink 写 envelope；**fake**。
- 断言强度：**强**（字节数、sha256 形态、summary 长度、按 server/tool/session 分组、advisoryOnly）。

### 1.21 `tests/capture.test.js` — 10
- 覆盖：capture 原样保留 credential header（**full-fidelity**）、响应字节不变；mode off；R2 gzip PUT；captureEvent；tapTransport 双向帧；sink 失败 capture_dropped；Uint8Array chunk 不变成逗号字节；fallback envelope；无 fallback URL 时禁用。
- fake/真实：真实 `startCapture` + temp file sink；R2 用注入 `fetchImpl`（`captured.url/init`）；**fake R2**。
- 跳过：无。
- 断言强度：**强**（envelope.request.raw 精确、header 值 verbatim、gunzip 后字段、帧方向、drop 计数一次）。

### 1.22 `tests/cas-fencing.test.js` — 1
- 覆盖：stale refresh 结果 CAS 失败不覆盖 winner token，落败 worker 拿到 winner access token。
- fake/真实：真实 `UpstreamAuth._refresh` + 内存 Map + `casToken` fake + fake fetch；**fake**。
- 跳过：无。
- 断言强度：**强**（AT_1/RT_1 精确、KV 仍是 winner RT）。

### 1.23 `tests/catalog.test.js` — 13
- 覆盖：tokenize（英文/中文 bigram/混合）、buildIndex、searchEntries 命中/排序/限制/select/+server/空输入、parseQuery 四式、patternMatches、isAllowed allow/deny 优先级。
- fake/真实：纯函数 + 固定 entry 数组；**fake**。
- 跳过：无。
- 断言强度：**强**（token 数组 deepEqual、score 1000、hint 文案、deny 优先）。

### 1.24 `tests/chatgpt-oauth.test.js` — 12
- 覆盖：ChatGPT redirect 白名单与反例；DCR/authorize/token 共用校验；RFC 9207 iss；metadata scopes；resource echo；401 `_meta["mcp/www_authenticate"]`；MCP SDK in-memory client 的 tools/list annotations/securitySchemes；LOCKED DCR carve-out 与平台隔离；Gemini 1422 字符 state 逐字节保持。
- fake/真实：真实 `createOAuthHandlers`/`createAppHandler`/`createGatewayServer` + **真实 MCP SDK InMemoryTransport**；MemoryStore（fake KV）。**无真实 ChatGPT 客户端**。
- 跳过：无。
- 断言强度：**强**（URL 反例 10 项、iss 相等、state 逐字节 hex 对比、平台不可混用）。

### 1.25 `tests/check-env-isolation.test.js` — 8
- 覆盖：preview/production 共用 env 记录为 P0；同值不同记录也违规；敏感值不可比→unknown；非隔离 key 忽略但 PUBLIC_BASE_URL 检查；ISOLATION_KEYS；token/projectId 解析；`fetchProjectEnv`/`main` 退出码与 JSON。
- fake/真实：真实脚本函数 + 注入 fetchImpl；**fake Vercel API**。
- 跳过：无。
- 断言强度：**强**（violations kind/severity、checkedKeys、exit 1/0/2、unknown 不伪装 pass）。

### 1.26 `tests/claude-connector.test.js` — 8
- 覆盖：Claude redirect `https://claude.ai/api/mcp/auth_callback` 接受与大量 look-alike 拒绝；Google/ChatGPT 行为不变；DCR/authorize/token 共用校验；LOCKED 默认与 ALLOW_DCR_FOR_CLAUDE carve-out；refresh token 不轮换；平台隔离。
- fake/真实：真实 `createOAuthHandlers` + MemoryStore + 完整 authorizeFlow（meta refresh 解析 code/state/iss）；**无真实 Claude connector**（文件头明示）。
- 跳过：无。
- 断言强度：**强**（反例数组逐项、platform 字段、iss、token 不可互用）。

### 1.27 `tests/client-lock.test.js` — 3
- 覆盖：LOCKED 模式 metadata 仍暴露 registration_endpoint；LOCKED 拒绝 DCR；unlocked metadata 仍暴露。
- fake/真实：真实 `createOAuthHandlers` + fakeStore + res double；**fake**。
- 跳过：无。
- 断言强度：**中**（status 403、字段存在性）。

### 1.28 `tests/client-platform.test.js` — 17
- 覆盖：`detectClientPlatform` 的 header/clientInfo/oauth id/UA 优先级与置信度；未知不猜测；纯函数确定性/不修改入参；profile map frozen；capture envelope 增加 clientPlatform/clientProfile/oauthClientId 且旧字段不变；capture off 不写文件。
- fake/真实：真实检测函数 + 真实 `startCapture` file sink；req/res double；**fake**。
- 跳过：无。
- 断言强度：**强**（deepEqual 全对象、frozen 断言抛 TypeError、envelope 新字段一致）。

### 1.29 `tests/client-profile.test.js` — 17
- 覆盖：`resolveClientProfile` 信号优先级；profile frozen；三种 profile 的 encodeToolResult / encodeModelOutput / applyProfileToTools；Gemini 去 structuredContent、ChatGPT 加 structuredContent、Claude annotations；默认字节不变。
- fake/真实：纯函数 + 固定结果对象；**fake**。
- 跳过：无。
- 断言强度：**强**（hasOwnProperty 判定结构化字段、JSON.stringify 字节相等、入参不修改）。

### 1.30 `tests/codemode-date-helper.test.js` — 3
- 覆盖：`formatDate` ISO/date/time/ms、`nowISO` UTC 形态、非法输入错误文案；execute 描述声明 Intl 不可用并推荐 formatDate。
- fake/真实：真实 vm 沙箱；`tools: []` + `callTool: async()=>({})`；**fake**。
- 跳过：无。
- 断言强度：**强**（精确字符串、正则、描述子串）。

### 1.31 `tests/codemode-edit-helpers.test.js` — 10
- 覆盖：`replaceLines` 替换/插入/删除/越界；`applyPatch` 单/多 hunk、context mismatch、原样返回；`diffSummary`；guest 错误行号映射；`pickScriptLoc` 纯函数；expression-bodied arrow 行号。
- fake/真实：真实 vm 沙箱 + `tools: []`；**fake**。
- 跳过：无。
- 断言强度：**强**（文本精确、hunks/added/removed 计数、行号正则）。

### 1.32 `tests/codemode-ergonomics.test.js` — 19
- 覆盖：F1 文件正文纯净化（notice→metadata）host+guest+readFileRange；F2 PR number URL-first、id/nodeId 分离；F3 unwrapBatch/safeAll 统一形状；F4 截断元数据字段/total/tail/next；F5 atomic 写默认与 partial 补偿；F6 waitForPrChecks 超时；SEC：truncated 标记保留、raw 标为 untrusted。
- fake/真实：真实 host adapter + vm 沙箱；注入 callTool/fetchPage/check；**fake upstream**。
- 跳过：无。
- 断言强度：**强**（正文精确、number 不取 id、meta 对象字段、polls 计数、untrusted marker）。

### 1.33 `tests/codemode-file-pr-helpers.test.js` — 3
- 覆盖：`fileResult` 展平 text/resources/sha/size/path、截断标记；`prResult` 常见形状 number/url/sha；hostile Proxy 不抛。
- fake/真实：真实 vm 沙箱；`tools: []`；**fake**。
- 跳过：无。
- 断言强度：**中强**（字段值 + Proxy 不抛）。

### 1.34 `tests/codemode-fixes.test.js` — 10
- 覆盖：formatParams 类型/required/enum；unwrapResult 解析与 isError；console.info/warn/debug；工具结果自动 unwrap；MCP SDK in-memory search 类型参数与 select 完整 schema；service 前缀；Promise chaining；helper 同步契约；write stub 同步抛错。
- fake/真实：真实 MCP SDK InMemoryTransport + vm 沙箱；fake manager/callTool。
- 跳过：无。
- 断言强度：**强**（文案子串、JSON.parse 结果 deepEqual、同步/异步类型断言）。

### 1.35 `tests/codemode-rest.test.js` — 12
- 覆盖：循环/深嵌套参数不爆栈并给 `[Circular]`/`[Deeply nested]`；18 个 constructor 逃逸探针全部不可达宿主；正常 Web API/日志/crypto 未被破坏；search 内外形状一致；script 错误行号与 wire error 形状；host 错误不误标行号；整轮 wall-clock timeout。
- fake/真实：真实 vm 沙箱；`callTool` 有抛错/永久挂起 fake；**fake**。
- 跳过：无。
- 断言强度：**强**（每个探针 ctorType=undefined & hostCodeRan=false、错误 line/column、timeout 文案）。

### 1.36 `tests/codemode-slice-lines.test.js` — 3
- 覆盖：sandbox 持全量 5000 行文本、`sliceLines` 只返回请求区间；clamp/单行/空输入；最终 execute 结果保持小体积。
- fake/真实：真实 vm 沙箱 + 大文本 fake tool result；**fake upstream**。
- 断言强度：**强**（saved>50000、startLine/endLine/totalLines/truncated 精确、结果长度<2000）。

### 1.37 `tests/codemode-unwrap.test.js` — 6
- 覆盖：`unwrap` JSON 字符串/纯文本/`{result}`/sole structuredContent/text vs resources/content 数组/image block/歧义对象原样/ hostile shape 不抛。
- fake/真实：真实 vm 沙箱；`tools: []`；**fake**。
- 跳过：无。
- 断言强度：**强**（歧义保持、getter 抛错与循环引用不崩、结构 deepEqual）。

### 1.38 `tests/codemode.test.js` — 6
- 覆盖：大结果不进最终返回值（只留 return）；console.log→logs；调用预算；readFileRange 完全行/标记截断；grepSnippet 窗口标记；真实 MCP SDK + fake-upstream stdio child 验证 tools/list 恰好 3 个工具及 annotations。
- fake/真实：真实 vm 沙箱；最后一项启动 `harness/fake-upstream.mjs` 真实子进程 + MCP SDK InMemoryTransport；**fake upstream 但真实协议栈**。
- 跳过：无。
- 断言强度：**强**（结果<500、toolCalls 计数、annotations、3 工具名精确）。

### 1.39 `tests/config-validation.test.js` — 7
- 覆盖：合法配置/缺 token 警告；legacy servers 数组；重名/坏 transport/缺端点；顶层值；OAuth refresh 规则；header/env/args/tool-list 类型；examples 与 templates 全量可校验。
- fake/真实：真实 `validateConfig` + 读取仓库真实 JSON 文件（config.example/examples/templates）；**真实文件、无网络**。
- 跳过：无。
- 断言强度：**强**（错误 regex、examples≥3、每个模板单 server）。

### 1.40 `tests/detector.test.js` — 20（全部走 `t()` gate）
- 覆盖：#21 clean 404/403 不误标 schema mismatch；#22 execute_error detail 按工具名取而非 turn order；#23 零工具 server 归 infra；#24 成功 services()/含 not found 的结果不算 execute_error、模型调错名归 model。
- fake/真实：构造的异常/工具结果夹具；**fake**；加载 `explore/trace.mjs`（私有评测 fixture）。
- 跳过条件：`explore/trace.mjs` 不存在时**全部 20 个 skip**（OSS 导出排除私有 fixture）。
- 断言强度：**强**（rootCause 精确、attribution/isGatewayDefect、20/10/6 条历史误标样本计数）。

### 1.41 `tests/docker-host.test.js` — 5
- 覆盖：`parseCliArgs`/`resolveHost` 默认值 127.0.0.1 与 --host 透传；`startHttpServer` 真实 listen 的绑定地址；host 与 gateway options 共存。
- fake/真实：**真实 `listen(0)` 起本地 HTTP server**（非 fake）；upstreamManager 为空 fake。
- 跳过：无。
- 断言强度：**强**（`server.address().address` 精确 127.0.0.1/0.0.0.0、错误投掷）。

### 1.42 `tests/eval-cycle.test.js` — 15
- 覆盖：`scripts/eval-cycle.mjs` CLI/baseline（DRIFT/NO_BASELINE/REFERENCE）、F1–F6 覆盖解析（unknown≠pass）、J1–J6/N1–N9 join（SKIP/缺 id = FAIL）、docs marker、fake L1、replay fixture（requestId `unknown` 不编造）、artifact 命名/不覆盖、full-cycle 退出。
- fake/真实：注入 virtualFs/in-memory writeFile；**fake**；明确 `networkCalls:0`、`noProductionWrites:true`。
- 跳过：无。
- 断言强度：**强**（FAIL/INFO 分级、written.size=2、EEXIST、baselineStatus 精确）。

### 1.43 `tests/export-oss.test.js` — 10
- 覆盖：allow/deny 分类、buildPlan、validateExport/validateSelected、parseArgs；CLI dry-run 不写、`--write` 仅复制白名单且后验、denylist 整体中止、`--check`、敏感内容拒绝。
- fake/真实：真实 CLI 子进程 `spawnSync` + temp 目录树（含中性 fixture，域名/密钥在运行时拼接以免测试文件自身触发扫描）；**真实文件系统，无网络**。
- 跳过：无。
- 断言强度：**强**（status 0/1、stdout/stderr 正则、拷贝后文件存在/不存在）；注意个人 handle 检测类在本文件中**未覆盖**（注释明示由私有发布工具覆盖）。

### 1.44 `tests/figma-guard.test.js` — 12
- 覆盖：默认冷却 24h/缓存 1h/200 条；quota 错误模式；冷却期不触达上游；其他 server 不受影响；whoami/get_metadata 缓存；写工具绕缓存；失败不缓存；冷却优先于缓存；TTL 到期；LRU；冷却到期恢复。
- fake/真实：真实 `UpstreamManager.callTool`；fake client 记录调用；**fake upstream**；两处用真实短 sleep（15ms）。
- 跳过：无。
- 断言强度：**强**（calls 计数精确、错误 code、cooldownRemainingMs 范围）。

### 1.45 `tests/file-write.test.js` — 15
- 覆盖：`applyTextPatch` 单/多 hunk、context mismatch、CRLF、尾换行、无 hunk、越界；`applyFilePatch` 注入 I/O 的成功/dryRun/失败传播/依赖校验；截断读拒绝写；diff 省略提示。
- fake/真实：纯函数 + `fakeIo`；**fake，无真实 FS/上游**。
- 跳过：无。
- 断言强度：**强**（原文原样返回、write 次数 0/1、错误文案、截断拒绝）。

### 1.46 `tests/final-review.test.js` — 14
- 覆盖：schema sanitize 的循环引用、互引用、数组自环、共享引用深拷贝、5000 层限深；多类型/enum 一致性；未遍历关键字（dependentSchemas/unevaluated*/contentSchema/additionalItems/$defs）；非对象 inputSchema 回退；`__proto__` 原型污染；核心规则回归且入参不变。
- fake/真实：纯函数 + 构造 schema；**fake**。
- 跳过：无。
- 断言强度：**强**（maxDepth<300/10、JSON.stringify 不抛、`{}.polluted===undefined`、structuredClone 快照 deepEqual）。

### 1.47 `tests/friendly-truncation.test.js` — 8
- 覆盖：对象截断带 top-level keys 摘要、数组带 array length、字符串带总长度与 grepSnippet/text.slice 提示；合法 JSON 同形状；`--- TRUNCATED ---` 保留；未超长原样。
- fake/真实：纯 `truncateResultValue`；**fake**。
- 跳过：无。
- 断言强度：**强**（长度上界、摘要文案、JSON.parse round-trip）。

### 1.48 `tests/gateway-rest.test.js` — 13
- 覆盖：execute 结果不再双重序列化；结构化截断合法 JSON；structuredContent/audio/resource_link 保留且不回显 base64；listTools compact/brief/service；50 调用预算与只读去重缓存；写工具不去重。
- fake/真实：真实 MCP SDK InMemoryTransport + vm 沙箱；fake manager/callTool。
- 跳过：无。
- 断言强度：**强**（wire 上 result 是对象、无 `\"a\"`、audios/resourceLinks 字段、calls=2 与 remaining=48）。

### 1.49 `tests/gemini-feedback.test.js` — 8
- 覆盖：工具描述中 Connected services 去重排序；search/select 带 `callName`、沙箱接受连字符与 sanitized 双名；返回形态引导与安全 `safeAll` 部分失败隔离、顺序保持。
- fake/真实：真实工具/沙箱；emptyCall fake；**fake upstream**。
- 跳过：无。
- 断言强度：**强**（服务名计数=1、双名均调用、safeAll ok/value 槽位精确）。

### 1.50 `tests/gemini-feedback2.test.js` — 10
- 覆盖：list 模式描述≤160 字符且句界/换行边界；select 保留完整描述与 schema；每条结果 `access: read|write`；sandbox 内一致；`codemode.services()` 本地聚合、不调上游、失败 server 标 offline/needsReauth、动态反映失败、防御缺失字段。
- fake/真实：真实工具/沙箱；`callTool` 故意抛错以证明零上游调用；**fake**。
- 跳过：无。
- 断言强度：**强**（长度精确 160、deepEqual services、upstreamCalls=0）。

### 1.51 `tests/gh-feedback-fixes.test.js` — 15
- 覆盖：branch/branchName/name 别名；PR number 绝不取 database id（URL-first）；GitHub Actions REST helpers（runs/jobs/logs）URL/query、302 签名 URL 不转发 token、无 token 零网络、非 200 结构错误、日志截断、sandbox 可达；仍恰好 3 工具。
- fake/真实：真实 host helper + vm 沙箱；`fakeFetch` 注入 JSON/text/redirect 响应；**fake GitHub REST**。
- 跳过：无。
- 断言强度：**强**（query 参数、second hop Authorization undefined、token 不出现、tools 列表精确）。

### 1.52 `tests/gh-file-p0.test.js` — 13
- 覆盖：真实 GitHub get_file_contents raw shape 下 guest fileResult 正文纯净化；host normalizeFileResult 一致；branch→ref 别名（含显式 ref 优先、审计 argAlias）；pull_request_read method 引导；仍 3 工具。
- fake/真实：真实 vm/工具；RAW 为真实 capture 形状夹具 + fake callTool；**fake upstream**。
- 跳过：无。
- 断言强度：**强**（字段集合、正文精确、argAlias.ref='branch'、usage 正则）。

### 1.53 `tests/github-helpers.test.js` — 13
- 覆盖：ensureBranch reuse/create/reset/错误传播；upsertPr create/update/reuse；fetchAllPages cursor/去重/maxPages/停滞/错误；repoGrep file/line/column/不可读/limit/flags/shape。
- fake/真实：纯函数 + 注入 callback fake；**fake**。
- 跳过：无。
- 断言强度：**强**（calls 数组 deepEqual、truncated/nextCursor、错误 regex）。

### 1.54 `tests/golden-mcpmark.test.js` — 9
- 覆盖：MCPMark 权威任务 71 条（GitHub 33/Notion 38，standard 51/easy 20）、prompt 三件套、verify.py 不可运行判定；derived 86 条（19/5/16/46）；Linear/Vercel 62 条无权威源不编造；映射 topic-only；gold 打分不可用；缺失源不假装成功。
- fake/真实：加载私有 `explore/golden-mcpmark.mjs`；需要本地 `work/mcpmark` clone；**评测资产，非线上**。
- 跳过条件：**全部 9 个有 gate**——`explore/golden-mcpmark.mjs` 缺失时全 skip；其中 6 个 `cloneTest` 还需 MCPMark clone 存在。当前 OSS 导出下私有 fixture 缺失 → 实际全 skip。
- 断言强度：**强**（计数与分类 deepEqual、`goldScoringAvailable:false`、`sourcePresent:false` 诚实降级）；**但本半集无法证明其实际运行**。

### 1.55 `tests/gpt-online-fix.test.js` — 13
- 覆盖：Actions logs 415→Accept 头修正、302 签名 URL 不带 token 且通用 Accept、followAccept；file path 从 `repo://.../contents/` 解析、无 URI 不猜；raw envelope ≠ canonical content；PR id/nodeId 附加字段且 number URL-first；guest/host 一致。
- fake/真实：真实 helper + vm 沙箱；fakeFetch 响应 200/302/415；**fake GitHub**。
- 跳过：无。
- 断言强度：**强**（两跳 header 差异、percent-decode、malformed 不抛、nodeId 非枚举）。

### 1.56 `tests/grep-snippet.test.js` — 3
- 覆盖：grepSnippet 大小写不敏感上下文窗口、对象 JSON 化搜索、无匹配返回空；错误行号在 prelude 增长后仍正确。
- fake/真实：真实 vm 沙箱；`tools: []`；**fake**。
- 跳过：无。
- 断言强度：**中强**（hits 数量范围、keyword 包含、行号正则）。

### 1.57 `tests/harness-parallel.test.js` — 13
- 覆盖：R8 并发配置（默认 3、clamp）；worker pool 峰值并发/单任务一次/顺序结果/每 ctx 串行；onReady/onWorkerDone、init 失败清理、不多分配；collector 合并；任务产物路径不冲突；LLM 429 退避 1/2/4s；withRetries 成功/耗尽/不可重试；mock 7 任务→7 anomaly。
- fake/真实：注入 sleep/task；**fake**；加载私有 `explore/trace.mjs`。
- 跳过条件：`explore/trace.mjs` 缺失 → **全部 13 个 skip**。
- 断言强度：**强**（峰值并发=3、contexts 不重叠、退避数组 deepEqual）；**实际未运行**。

### 1.58 `tests/healthz.test.js` — 5
- 覆盖：`GET /healthz` 报告构建身份（commit/buildHash）、mode/servers/configLoaded/env/uptime/startedAt，且不读 token store、不构建 MCP handler；配置损坏仍 200 并报 configError；未知路由 404；`write-build-info.mjs --print` 确定性且不改写 `src/build-info.js`。
- fake/真实：真实 `createAppHandler` + req/res double；store 故意抛错以证明不访问；`execFileSync` 真跑脚本；**真实本地进程，无网络**。
- 跳过：无。
- 断言强度：**强**（字段逐项、cache-control=no-store、buildHash 40 位 hex、文件前后内容相等）。

### 1.59 `tests/image-passthrough.test.js` — 4
- 覆盖：上游 image block 作为**原生 MCP image content block** 透传，base64 不进 text；大图不截断且不膨胀 text；无图时保持单 text block；直连 whitelist 工具同样原生透传。
- fake/真实：真实 MCP SDK InMemoryTransport + `createGatewayServer`；`callTool` 返回图片块的 fake upstream。
- 跳过：无。
- 断言强度：**强**（imageBlocks.length=1、data 原样、text 无 base64、无 TRUNCATED 标记）。

### 1.60 `tests/invalid-grant.test.js` — 1
- 覆盖：`invalid_grant` 后停止刷新（无 rebootstrap 循环）、标记 `needsReauth`、第二次调用不再尝试 refresh。
- fake/真实：真实 `UpstreamAuth` + 内存 store + fake fetch 返回 invalid_grant；**fake provider**。
- 跳过：无。
- 断言强度：**强**（refreshCalls=1 两次调用后仍为 1、needsReauth=true）。

### 1.61 `tests/l1-baseline.test.js` — 4 + 6 私有 fixture gate
- 覆盖：当前指标与独立 baseline 文件比较才能检出回归；自比较恒 pass 是被防止的 bug；byServer 40 任务快照/子集聚合；缺失 byServer 时显式 overall fallback 标签且渲染保留；baseline 选择器不读 `explore/results/*`；污染 current-run 文件不能影响 baseline；文件 byServer/serverSets 冻结可读。
- fake/真实：真实 `scripts/run-l1-smoke.mjs` 纯函数 + temp 文件；部分用例读私有 `explore/baselines/l1-smoke.json` + `explore/tasks-smoke.json`；一个用例**读取脚本源码做静态断言**。
- 跳过条件：私有 baseline/smoke fixture 缺失 → 6 个 `fixtureTest` skip（OSS 导出下实际 skip）；另 4 个纯函数用例运行。
- 断言强度：**强**（comparison.ok=false、阈值全 fail、source 文案、不读 results 的源码正则）。

### 1.62 `tests/l1-failed-server.test.js` — 5 + 11 私有 fixture gate
- 覆盖：failedServers 合并/去重/排序（tool count 不是失败信号）；full/degraded-subset/no-measured-tasks 分类；失败任务从分子分母同时排除；null（未调用）在 adjusted 率中算 miss；报告渲染 scope/failed/measured/公式；真实回归在 degraded 模式仍 FAIL；缺 byServer 快照显式跳过而非硬比；legacy fake/replay 不变。
- fake/真实：真实脚本纯函数 + 合成 perTask 行；私有 smoke/baseline fixture + 静态读取 `explore/run-explore.mjs` 源码。
- 跳过条件：私有 fixture 缺失 → 11 个 `fixtureTest` skip；5 个纯函数用例运行。
- 断言强度：**强**（分母 20/30/40 精确、scope 字符串、ok=false 不误 pass）。

### 1.63 `tests/l1-online-gap-wire.test.js` — 11 + 6 私有 fixture gate
- 覆盖：`--profile online-gap` 接线：默认 profile=null；N1–N9+J1–J6 恰好 15 任务且唯一；未知 id/缺文件/缺 fixture/unsafe write 全部显式 SKIP；baseline 以 `{taskId: fixtureHash}` 冻结且只读；current results 写独立文件；6 个扩展指标不可算时为 `unknown` 而非 pass；hash drift→all-unknown；boolean 回归→fail；默认 fake 路径 0 fail 但 allUnknown；未知 profile exit 2；e2e 子进程运行后恢复文件。
- fake/真实：真实脚本函数 + 注入 read/write/exists；3 个 `spawnSync` 真跑 runner 并恢复 `docs/eval/l1-smoke.json` 等文件；**无网络、私有 fixture 依赖**。
- 跳过条件：私有 `explore/tasks-online-gap{,-2}.json` 或 `tasks-smoke.json` 缺失 → 6 个 `fixtureTest` skip；11 个纯函数/注入用例运行。
- 断言强度：**强**（skips kind 精确、hash 16 hex、read-only 冻结抛错、allUnknown、exit 0/2）。

> 至此 63 个文件均按同一颗粒度记录；§3 结论中提到的 skip 仅针对确有 gate 的文件（detector/harness-parallel/golden-mcpmark/l1-*）。

---

## 2. 对照 FRAMEWORK 六模块

### 模块一：核心底座（可替换）
**[测试]** 覆盖密集但集中在 **Code Mode 单一底座**：`arg-validation`/`codemode*`/`b10*`/`b11*`/`gateway-rest`/`gemini-feedback*`/`gh-*` 等验证 vm 沙箱、helper、预算、去重、截断、结果编码、错误行号、constructor 逃逸止血。
**[代码]** 3 工具稳定面在多个文件中被反复断言（`['search','execute_read','execute']`）。
**[未验证]** **Typed Plan 仅由后半 `typed-plan-*.test.js` 覆盖（不在本半集）**；Native/Hybrid、按客户端自动选执行器、执行所有权：**本半集零覆盖**。即使后半全绿，也只是 flag/v2 路径，**不是生产默认**。

### 模块二：客户端
**[测试]** `client-profile`/`client-platform` 覆盖平台检测、profile 编码；`chatgpt-oauth`/`claude-connector` 覆盖 OAuth 端侧契约（重定向白名单、RFC 9207、resource、401 metadata、平台隔离）；`client-lock` 覆盖 LOCKED DCR；`gemini-feedback*`/`gpt-online-fix`/`gh-file-p0` 覆盖真实反馈回归。
**[代码]** 测试证明 header/clientInfo/oauthClientId/UA 检测与 profile 映射存在；annotations 仍是 `execute_read openWorld=true`、`execute destructive+openWorld=true`（FRAMEWORK §14 的双触发问题在这些测试中作为现状被断言，而非被修复）。
**[未验证]** **没有真实 Gemini/ChatGPT/Claude 网页非代码模式客户端参与**；`claude-connector.test.js` 文件头明示“No live Claude connector was exercised”。弹窗次数、客户端是否忽略“允许”、mode detection 在真实客户端的可靠性：**全未验证**。

### 模块三：评测体系
**[测试]** `capture*`（11 个文件）证明采集链路完整：ack/done/skipped/dropped、queue、R2 key/gzip、去重、背压、sessionId/clientInfo/model audit；`capture-analyzer`/`capture-digest`/`capture-truncation-audit` 证明 scorecard/analyzer 聚合与 advisory-only 门禁；`eval-cycle` 证明 F/J/N 门禁与 NO_BASELINE 诚实降级。
**[代码]** analyzer 输出 `advisoryOnly:true`、`requiresHumanReview:true`、`free-model-advisory-v1`；weekly review “no GitHub issues are created”。
**[未验证]** **主动/被动隔离统计、同时间窗对照、采集层 session/project/task 交叉、用主动反哺被动**：本半集只有 sessionId 与零散字段，**无 project/task 交叉的端到端断言**。`golden-mcpmark`/`harness-parallel`/`detector` 依赖私有 fixture，**当前全 skip**；L1 online-gap baseline 由 `eval-cycle` 证明可为 NO_BASELINE，**不是真实验收**。

### 模块四：上游接入
**[测试]** `figma-guard` 覆盖配额冷却/缓存；`gh-*`/`github-helpers`/`gpt-online-fix` 覆盖 GitHub REST/工具辅助与真实反馈；`auth-*`/`cas-fencing` 覆盖授权生命周期逻辑；`chatgpt-oauth`/`claude-connector` 覆盖 OAuth。
**[代码]** owner 标记、v2 key、static_bearer、offline_access、CAS/lease 在 fake I/O 下被严格断言。
**[未验证]** **没有真实 GitHub/Notion/Linear/Vercel 客户端写回环**；所有 `callTool`/`fetchImpl` 都是 fake；`auth-e2e-harness` 也是 loopback + fake provider。**真实 401/refresh 失效/授权生命周期（首次授权→刷新→撤销→再授权）未验证**；owner 迁移与 preview/production KV 实际隔离只有 `check-env-isolation` 的 script 分析与 fake harness。

### 模块五：运行时 / 部署
**[测试]** `docker-host` 是唯一真实 bind 测试；`check-env-isolation`/`export-oss` 覆盖 env 隔离分析与导出门禁；`capture-sink-fix`/`capture-queue*` 覆盖运行时可靠性。
**[未验证]** **无 Vercel 部署、无 Docker build、无 npm audit、无真实 R2 写入、无内网穿透/本地容器/服务器验证**。FRAMEWORK §0 的生产 commit 与 A–G 门状态不因测试绿而改变。

### 模块六：开源工程
**[测试]** `export-oss` 10 用例覆盖 allowlist/denylist/敏感串/dry-run/write/check；`oss-private-fixture-skip`/`oss-neutralizer`/`oss-staging-curation` 等在后半。
**[未验证]** **OSS 未公开**；发布前的 `PUBLIC-SAFETY-AUDIT`、个人 handle 检测（本文件注释明示未覆盖）、真实远端 push、许可证/治理：均非本半集可证明。

---

## 3. “测试绿 ≠ 验收”专项

本半集呈现四类典型“绿但不足”：

1. **自证测试**：`auth-rotation-sim.test.js` 断言的是 `scripts/auth-rotation-sim.mjs` 自建模型的行为（文件头明示“no src/ imports”“验证模型行为以便未来架构在改生产代码前验证”）；`eval-cycle` 的 fake L1/replay fixture 同理——**绿只证明模型/脚本自洽，不证明生产实现**。
2. **只测纯函数**：`catalog`/`client-profile`/`config-validation`/`final-review`/`friendly-truncation`/`file-write`（host 纯函数部分）等大量断言纯函数输入输出，属于必要但不充分的单元层。
3. **fake upstream**：几乎全部 Code Mode / 写事务 / 上游 helper 测试都以 `callTool`/`fetchImpl`/`fakeFetch` 注入响应；`github-helpers`/`gh-*` 的“写”只是调用计数为 1，**没有任何真实仓库被修改**。这与 AGENTS.md §0“真实写回环 CI 未完成”一致。
4. **缺真实客户端 / 真实写 / 授权生命周期**：`chatgpt-oauth`/`claude-connector` 用 SDK in-memory 或 handler double；`auth-e2e-harness` 用 loopback + fake provider；**没有一项证明真实 rotating refresh token 在真实 provider 上完成过一次刷新且不触发 replay 吊销**。`auth-rotation-sim` 只是仿真。

**缺失的模块轴（本半集）**：Native/Hybrid 执行器、按客户端选底座、多客户端隔离/并发调度、主动/被动隔离统计与同窗对照、project/task 交叉采集、真实部署与真实上游写、开源发布门禁的实际执行。

**结论**：本半集 **63/63 文件已读、测试结构自洽且大量断言强度高**，可作为回归网；但按 FRAMEWORK 与 ACCEPTANCE，**它们不能替代“测试绿≠验收”的各项真实验收**；`golden-mcpmark`/`harness-parallel`/`detector` 在 OSS 导出下实际全 skip，必须单独标注，不能计入覆盖。

---

## 4. 证据索引（关键文件行）
- `tests/auth-rotation-sim.test.js:1-9`：纯仿真声明。
- `tests/auth-e2e-harness.test.js:1-9`：loopback + 全 fake 声明。
- `tests/claude-connector.test.js:10-14`：无真实 Claude connector。
- `tests/chatgpt-oauth.test.js:383-413`：真实 MCP SDK in-memory，但工具面仍是测试态。
- `tests/export-oss.test.js:172-178`：个人 handle 检测类未覆盖说明。
- `tests/detector.test.js:14-28`、`tests/harness-parallel.test.js:13-28`、`tests/golden-mcpmark.test.js:7-38`：私有 fixture skip 门。
- `tests/eval-cycle.test.js:235-243`：replay 为 fixture、`requestIds[0]==='unknown'`。
- `tests/capture.test.js:23-51`：capture 原样保留 credential header（full-fidelity 契约）。
- `tests/docker-host.test.js:70-86`：真实 listen 绑定地址断言。
