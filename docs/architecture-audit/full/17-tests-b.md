# 17 — 全量测试逐文件深读（后半部分，L–V）

> 只读审计。未改 `src/`、`scripts/`、`tests/`、README、其他 docs、workflows。
> 未 commit / push / deploy。
> 采样时间：2026-11-24（Asia/Singapore）。
> 判定口径：`docs/FRAMEWORK.md` 六模块 + “测试绿 ≠ 验收”（`docs/ACCEPTANCE.md` 门）。
> 证据标签：`[测试]` = 文件里真实存在的断言/事实；`[代码]` = 由被测源码行为推断（未逐行审 src）；`未验证` = 文件未覆盖且本审计未实跑/实连。

---

## 0. 文件清单与 expected / read / unread

命令：`git ls-files tests | sort`（在该 Windows 工作区用 PowerShell `Sort-Object -CaseSensitive` 复现同一字节序，等价于 git-bash `sort` 的大小写敏感排序）。

- `git ls-files tests` 总数：**127**
- 前半：索引 0–62，共 63 个，末文件 `tests/l1-online-gap-wire.test.js`
- **后半：索引 63–126，共 64 个，首文件 `tests/l1-smoke.test.js`，末文件 `tests/vercel-cimd-probe.test.js`**
- 说明：任务描述写“约 63 个，N–Z 范围”；按“取后半”的字面实现是 **64 个**（127 为奇数，后半多 1 个），且实际起点是 `l` 而非 `n`。本审计以完整清单为准，未擅自裁掉 `l*`/`m*` 文件。前半（A–L 交界前）不在本报告范围。

计数：**expected = 64 / read = 64 / unread = 0**。每个文件均用 `read` 工具逐行打开全文，未只读文件名、未只用 grep 代替阅读。

后半完整清单（64 个，按 sort 顺序，括号内为该文件中 `test(...)` / `test.todo(...)` / 包装器声明数，**约数，含 skip 与 todo**）：

1. `tests/l1-smoke.test.js` (12)
2. `tests/local-e2e-verify.test.js` (2)
3. `tests/logs-errors.test.js` (10)
4. `tests/maxwhitelist-zero.test.js` (1)
5. `tests/mcp-session.test.js` (1)
6. `tests/mcp-v2-smoke.test.js` (3)
7. `tests/merge-collector-contract.test.js` (1)
8. `tests/no-silent-truncation.test.js` (16)
9. `tests/normalization-order.test.js` (4)
10. `tests/normalization.test.js` (13)
11. `tests/oauth-origin.test.js` (5)
12. `tests/oauth.test.js` (6)
13. `tests/online-feedback.test.js` (26)
14. `tests/online-gap-regression.test.js` (23)
15. `tests/online-gap-tasks.test.js` (6，全部可达时执行；OSS 导出会 SKIP)
16. `tests/online-semionline-join.test.js` (14，task/doc 分组 SKIP 可达)
17. `tests/oss-neutralizer.test.js` (12)
18. `tests/oss-private-fixture-skip.test.js` (2)
19. `tests/oss-staging-curation.test.js` (8)
20. `tests/owner-marking.test.js` (12)
21. `tests/p0-fixes.test.js` (5)
22. `tests/platform-conformance-suite.test.js` (21)
23. `tests/platform-eval.test.js` (17)
24. `tests/project-llm-labeler.test.js` (16)
25. `tests/project-rollup.test.js` (10)
26. `tests/project-tag.test.js` (20)
27. `tests/provider-dcr-cimd.test.js` (13)
28. `tests/readonly-tool-stub.test.js` (2)
29. `tests/real-gh-replay.test.js` (14)
30. `tests/reconnect-server.test.js` (9)
31. `tests/refresh-concurrency.test.js` (1)
32. `tests/refresh-once.test.js` (1)
33. `tests/replay-online-session.test.js` (22)
34. `tests/residual-security-fix.test.js` (10)
35. `tests/resource-blob-image.test.js` (7)
36. `tests/result-bound.test.js` (6)
37. `tests/result-normalize.test.js` (35)
38. `tests/sanitize.test.js` (14)
39. `tests/search-cjk.test.js` (1 + 8 个 `catalogTest` 包装)
40. `tests/search-rework.test.js` (6)
41. `tests/search-service-attribution.test.js` (4)
42. `tests/security-fix-2.test.js` (21)
43. `tests/security-fixes.test.js` (3)
44. `tests/server.test.js` (7)
45. `tests/services-honesty.test.js` (8)
46. `tests/session-clustering.test.js` (16)
47. `tests/stale-kv.test.js` (1)
48. `tests/structured-content-blocks.test.js` (2)
49. `tests/task-coverage.test.js` (5，全部可达时执行；OSS 导出会 SKIP)
50. `tests/token-liveness.test.js` (9)
51. `tests/tool-format-dedupe.test.js` (6)
52. `tests/true-isolation.test.js` (3)
53. `tests/typed-plan-ab.test.js` (18)
54. `tests/typed-plan-engine.test.js` (12)
55. `tests/typed-plan-integration.test.js` (16)
56. `tests/typed-plan-security.test.js` (18)
57. `tests/typed-plan-spike.test.js` (9)
58. `tests/typed-plan-v2-route.test.js` (20)
59. `tests/upstream-auth-generic.test.js` (4)
60. `tests/upstream-auth.test.js` (4)
61. `tests/upstream-oauth.test.js` (4)
62. `tests/upstream-token-lifecycle.test.js` (23)
63. `tests/upstreams.test.js` (6)
64. `tests/vercel-cimd-probe.test.js` (12)

全半段测试/包装器声明合计：**约 662**（含 `test.todo` 与带 skip 条件的声明；不等于本审计实跑数，**未验证**实际 pass/skip 分布）。

---

## 1. 逐文件深读表

“fake/真实”口径：**fake** = 全离线、注入 fetch/store/IO；**真实路由(loopback)** = 真 `createAppHandler`/`createMcpRequestHandler` 挂在 127.0.0.1 临时端口、真 MCP SDK client；**真 IO** = 真 `UpstreamManager` + `harness/fake-upstream.mjs` STDIO 子进程；**磁盘真实写** = 写临时目录后清理；**纯函数** = 只调纯函数/内存结构。

“断言强度”：**强** = 精确值/字节级/错误码/副作用为零；**中** = 关键字段+存在性；**弱** = 仅布尔/形状/文档字符串断言。

### 1.1 L–M 段

| # | 文件 | 测试数 | 覆盖什么 | fake / 真实 | 跳过条件 | 断言强度 |
|---|---|---|---|---|---|---|
| 1 | `l1-smoke.test.js` | 12 | L1 评测 runner：50 任务选择、指标计算、baseline 比较、报告渲染、workflow 静态校验、ALERT 两连败规则、fake 模式端到端 | 纯函数 + 静态文件读 + 一次 `spawnSync` 跑 `run-l1-smoke.mjs --mode fake`（写报告后还原） | `fixtureSkip`：`explore/select-smoke.mjs`/`tasks-g6.json`/`tasks-smoke.json`/`baselines/l1-smoke.json` 缺失则 SKIP；`workflowSkip`：`.github/workflows/l1-smoke.yml` 缺失 SKIP；`derivedSkip`：私有 `explore/results/*.json` 缺失 SKIP | 强（字节级确定性、verbatim G6 复制、阈值逐项 pass/fail） |
| 2 | `local-e2e-verify.test.js` | 2 | 离线 E2E：真 `createAppHandler`/`createMcpRequestHandler` 跑 healthz/OAuth metadata/CIMD/401/三工具/纯正文/PR number/wait-checks/v2 flag；注入失败不被吞 | **真实路由(loopback)**，token store 与 upstream manager fake；无网络/凭据/落盘 | 无 | 强（11 项检查名精确、逐项 ok+detail、注入失败可见） |
| 3 | `logs-errors.test.js` | 10 | `runInSandbox` 的 console 日志 4000 字符结构化截断、throw 结构化 error（保留 legacy `isError`/`result`）、预算耗尽 | fake upstream `callTool`；沙箱真跑 | 无 | 强（序列化长度≤4000、marker、字段精确） |
| 4 | `maxwhitelist-zero.test.js` | 1 | `maxWhitelistTools=0` 表示无上限：全部白名单工具暴露 | MCP `Client` + `InMemoryTransport` + 真 `createGatewayServer`，manager fake | 无 | 中（3 个工具名断言） |
| 5 | `mcp-session.test.js` | 1 | initialize 发 `Mcp-Session-Id`，client 回显 | 真 `createMcpRequestHandler` over loopback + SDK `StreamableHTTPClientTransport`，manager fake | 无 | 中（UUID 格式 + 回显一致） |
| 6 | `mcp-v2-smoke.test.js` | 3 | `runSmoke()` 九项 v1/v2 契约：同名同序三工具、plan/readonly/approve、flag 关 404、401 challenge；注入 fetch  sabotage 可见 | 真 `startSmokeServer()` loopback，upstream/typed-plan IO/token store fake；禁止非 loopback | 无 | 强（逐项 detail 字段、非 loopback 直接 reject） |
| 7 | `merge-collector-contract.test.js` | 1 | `mergeCollectors` 返回 `.items` 而非 `.anomalies`（避免调用方崩溃） | 真 import `explore/trace.mjs`（私有夹具） | 私有 `explore/trace.mjs` 缺失 SKIP | 中 |
| 8 | `no-silent-truncation.test.js` | 16 | P0：长行逐字返回；`maxCharsPerLine` 显式截断带 reason；lineRange/upstream/in-band 截断标记；四种 envelope 形状；`grepSnippet` 窗口标记；`applyFilePatch` 截断读拒绝写；description 禁 `slice(0,150)` | 沙箱真跑 + 纯函数，fake upstream | 无 | 强（逐字符相等、truncation 字段精确、writes=0） |

### 1.2 N–O 段

| # | 文件 | 测试数 | 覆盖什么 | fake / 真实 | 跳过条件 | 断言强度 |
|---|---|---|---|---|---|---|
| 9 | `normalization-order.test.js` | 4 | RC-D3：camelCase 参数先归一化再校验；端到端 `perPage`→`per_page` 到 sandbox | 沙箱真跑 + 纯函数 | 无 | 中 |
| 10 | `normalization.test.js` | 13 | `toSnakeCase` 四条规则、不递归、显式优先、歧义保护；三条调用路径（直连/`gateway_call`/Code Mode）都在 `callTool` 归一化 | `UpstreamManager` 真类 + `_clients` 注入 fake client；真 `createGatewayServer` + `InMemoryTransport` | 无 | 强（精确参数对象、输入不变） |
| 11 | `oauth-origin.test.js` | 5 | 入站 origin 一致性：issuer/resource/CIMD/401 challenge 都跟随请求 host，不受 `PUBLIC_BASE_URL` 二次 origin 污染；恶意 host 不反射 | 真 `createAppHandler` + `resolveBaseUrl`，store stub，改 `process.env` 后还原 | 无 | 强（多 surface 同 host、逐字段精确） |
| 12 | `oauth.test.js` | 6 | DCR 六个 Google redirect、PKCE S256、state 1422 字符逐字、code 单次使用、refresh 不 rotation、well-known 200、`/mcp` 401→valid token 三态 | `createOAuthHandlers` 真逻辑 + `MemoryStore` fake；`createAppHandler` 路由 | 无 | 强（state 字节级、replay invalid_grant、token 计数） |
| 13 | `online-feedback.test.js` | 26 | `online-feedback.v1` schema/解析/校验/规范化/确定性；解析真实已提交记录 + CLI 子进程 | 纯函数 + 读真实 `docs/eval/online-feedback-2026-11-23.md` + `spawnSync` CLI | 无 | 强（key order 固定、真实文件 7 条 feedback、CLI 0 退出） |
| 14 | `online-gap-regression.test.js` | 23 | T1–T7 半在线缺口：真实 capture 形状归一化、byte-exact patch/write/readback、别名/未知参数、search 发现、写安全、长会话工具面稳定、三平台编码 | 纯函数 + fake IO；无网络/token/文件写（除读 feedback 记录） | 多处 `test.todo`：P0 未修（gh-file-p0 P0-1/2/3/4）、客户端不可观测项标 todo 并注明“不伪造 pass” | 强 + 显式 todo（诚实边界） |
| 15 | `online-gap-tasks.test.js` | 6 | N1–N9 任务集 schema/唯一 ID/必填字段/expectedTools 存在/dryRun 默认/覆盖轴 | 只读私有 `tasks-online-gap.json` + `data/tool-snapshots` | 私有夹具缺失 SKIP（OSS 导出必 SKIP） | 中（结构完整性，不执行任务） |
| 16 | `online-semionline-join.test.js` | 14 | J1–J6 任务集 + join 文档机器可读字段一致；F1–F6 覆盖、禁止跨构建硬比、requestId=unknown、无凭据泄漏 | 只读两个私有 JSON/MD | task/doc 分组 SKIP（OSS 导出 SKIP）；doc 存在性 gate | 强（键字段逐项、regex 断言“禁止 requestId 编造”等） |

### 1.3 O–P 段

| # | 文件 | 测试数 | 覆盖什么 | fake / 真实 | 跳过条件 | 断言强度 |
|---|---|---|---|---|---|---|
| 17 | `oss-neutralizer.test.js` | 12 | 个人 handle 泄露检测/规范化/中和：literal/escaped/URL-encoded/HTML entity/concatenation；`--check` 假阳性回归；临时目录写 | 真 import 导出脚本 + 子进程 CLI + `os.tmpdir()` 真实写后清理 | `signatureSkip`：私有签名常量被 scrub 则自中和测试 SKIP | 强（多种等价形态、退出码 0/1） |
| 18 | `oss-private-fixture-skip.test.js` | 2 | 私有夹具缺失时 `eval-search.mjs`/`audit-tools.mjs` 打印 `SKIP:` 且 exit 0、不打印测量数字 | 子进程 CLI + 故意传不存在路径 | 无（主动构造缺失条件） | 中 |
| 19 | `oss-staging-curation.test.js` | 8 | 源码级 guard 存在；夹具缺失→reason-bearing SKIP 且不虚增 pass；夹具存在→断言真执行；`measure-context` 缺数据不造产物 | 子进程 `node --test --test-reporter=tap` + 临时目录 | 夹具存在分支的 `l1-failed-server` 若私有夹具缺失则 SKIP | 强（TAP pass/skip/fail 计数精确） |
| 20 | `owner-marking.test.js` | 12 | owner 标记全链：config 键/硬错误/警告、`config.example.json` 标 dsh、dsh grant 永不 refresh、gateway 才 refresh、legacy 只读、`planMigration`/`migrate --apply` 不碰 legacy v1 key | `UpstreamAuth` 真逻辑 + `fakeStore` + 真迁移脚本 + 注入 `refreshFetch` | 无 | 强（KV key 精确、命令计数、拒绝 gateway 无 opt-in） |
| 21 | `p0-fixes.test.js` | 5 | P0-1 resource block 保留、单 JSON text 解析；P0-2 大参数审计截断；Web API；全局 `search()` | 沙箱真跑 + 纯函数 | 无 | 中–强 |
| 22 | `platform-conformance-suite.test.js` | 21 | 三平台一致性：Gemini 无 structuredContent、ChatGPT 双编码、Claude annotations；三工具不变量；typed-plan schema 缺口标“未支持”；profile 隔离/冻结；redirect allowlist | 纯函数 + `runConformance` 离线 checker；fixture 由 src 导出函数构造 | 无 | 强（跨污染 fail、缺 fixture 记 unknown 不伪 pass） |
| 23 | `platform-eval.test.js` | 17 | capture 聚合按 `clientPlatform` 分桶、legacy 落 unknown、每平台计数、scorecard 渲染、conformance 全场景 pass/fail/unknown | 纯函数 + 构造 envelope | 无 | 强（unknown 不借证据、表字段精确） |
| 24 | `project-llm-labeler.test.js` | 16 | 离线项目标注器：有界摘要输入、低置信分桶、no-repo/multi-repo、拒造 repo、注入 `fetchImpl` 不联网、advisory-only 渲染 | 纯函数 + 注入 fetch + fixture raw | 无 | 强（证据 requestId 可追溯、rejected 原因数组精确） |
| 25 | `project-rollup.test.js` | 10 | 项目级聚合：跨 3 session 合并、多标签、无标签不污染、join 按 taskId/projectKey、旧 envelope 从 `request.raw` 确定性回填 | 纯函数 + 内联 fixture | 无 | 强（timeline 行、确定性重复） |
| 26 | `project-tag.test.js` | 20 | `extractProjects` 显式字段优先、code literal/PR URL、去重、primary、不猜散文；capture envelope 加性字段 | 纯函数 + 真 `startCapture` 写临时目录（`file` sink）后清理 | 无 | 强（精确 tag 对象、真实 envelope 落盘读取） |
| 27 | `provider-dcr-cimd.test.js` | 13 | Notion DCR 注册一次/v2 client key/失败重试/竞态复用/state client_id/刷新用 KV client；Vercel CIMD scope/文档形状/无注册/无 refresh_token 失败 | `createUpstreamOAuthHandlers` 真逻辑 + `FakeStore` + 注入 fetch；不打印 secret | 无 | 强（调用次数、client_id 来源、无 v1 key、无 secret） |
| 28 | `readonly-tool-stub.test.js` | 2 | `execute_read` 过滤工具报可操作错误而非 "not a function"；`readOnlyHint` 优先于名字正则 | 沙箱真跑 | 无 | 中 |

### 1.4 R–S 段

| # | 文件 | 测试数 | 覆盖什么 | fake / 真实 | 跳过条件 | 断言强度 |
|---|---|---|---|---|---|---|
| 29 | `real-gh-replay.test.js` | 14 | `real-gh-replay.mjs`：PR number≠id、Actions logs 302→signed URL 无 token、415 标记、token 不进证据、无 token/401/403 诚实失败 | 注入 fake fetch（无 DNS/网络） | 无 | 强（header 精确、token 不序列化、失败如实） |
| 30 | `reconnect-server.test.js` | 9 | loopback：initialize/tools.list 快照稳定、stale session 不产生半表/不伪造 unknown_tool、HTTP 方法语义、401 challenge、`unknown tool:` 原样回显；客户端内部状态标 unknown | 真 `createMcpRequestHandler`/`createGatewayServer`/`createAppHandler` over loopback + SDK client，upstream fake | 无 | 强（schemaHash、6b 文档即测试明确 UNKNOWABLE 边界） |
| 31 | `refresh-concurrency.test.js` | 1 | 两实例并发 `getAccessToken` 只 refresh 一次（rotation-safe） | `UpstreamAuth` 真逻辑 + memory store + 延迟 fetch | 无 | 强（refreshCount=1、结果相同） |
| 32 | `refresh-once.test.js` | 1 | bootstrap 后重复调用不重复刷；新 env token 才再刷一次 | `UpstreamAuth` + memory store + 计数 fetch | 无 | 强 |
| 33 | `replay-online-session.test.js` | 22 | `replay-online-session.mjs`：capture 解析、只读 replay、写强制 dryRun、diff 分类、未知字段不编造、client-host 字段 not-comparable、确定性 | 纯函数 + 注入 upstream/fetch；无网络/真写 | 无 | 强（unknown 无 UUID、dryRun 写不算 exactness、无时间戳） |
| 34 | `residual-security-fix.test.js` | 10 | R-01 模型可见错误脱敏（两条 server 路径）、F-08 截断标记一致、F-09 result-level truncated 跨 profile 保留、R-02 v2 plan I/O 计费 | loopback 真 handler + SDK client + 纯函数 | 无 | 强（token 不出现、raw error 不被改、超限无额外 I/O） |
| 35 | `resource-blob-image.test.js` | 7 | `unwrapResult` 图片/音频 blob→images[]/metadata，超限 omitted，text/plain UTF-8，非法 base64 回退 | 纯函数 + 内联 base64 | 无 | 强 |
| 36 | `result-bound.test.js` | 6 | `boundResult` 小结果原样、大文本截断带 limit/original 提示、总长度≤maxChars、保留非文本块 | 纯函数 | 无 | 强（removed count 与 kept head 对齐） |
| 37 | `result-normalize.test.js` | 35 | file/PR/issue 各形状归一化、下载提示剥离、SHA 提取、截断标记、Proxy 防御、按工具名分发、未知工具 `{raw}` fallback | 纯函数 | 无 | 强（键集合精确、提示不进正文、恶意 toString 不抛） |
| 38 | `sanitize.test.js` | 14 | schema 清洗六规则：array items、多类型收敛、ID 保 string、oneOf/anyOf≤8、工具名、annotations 默认、不改入参 | 纯函数 | 无 | 强 |
| 39 | `search-cjk.test.js` | 1 + 8 | CJK 词表最长匹配、ASCII 缩写仅 CJK 查询触发；中文查询召回（Vercel/Notion/Linear/GitHub） | `searchEntries` 纯函数；catalog 排名测试用私有 dataset | `catalogTest`：私有 `data/tool-dataset.json` 缺失 SKIP | 中（CJK 纯规则强；召回依赖私有夹具） |
| 40 | `search-rework.test.js` | 6 | 描述堆词隔离、跨服务多样性、精确名加权、`options.server` 过滤、`select:` 兼容、离线召回率阈值 | `searchEntries` 纯函数 + 私有 dataset 的召回测试 | 召回测试 SKIP：`explore/tasks-v2.json` + `data/tool-dataset.json` 缺失 | 强（分数/排序精确；召回基线 54%/69%） |
| 41 | `search-service-attribution.test.js` | 4 | server 别名（repository/deployment）硬过滤；per-server 索引不受他服务增长影响 | `searchEntries` 纯函数 + 内联工具集 | 无 | 中–强 |
| 42 | `security-fix-2.test.js` | 21 | F-01 脱敏全覆盖、capture 保持 full-fidelity；F-03 截断审计不被 `truncated:false` 文本污染；F-04 typed-plan/actions 计费；F-06 `__bridge`/原型污染；F-07 fileText unknown 不报 false | 沙箱真跑 + 纯函数 | 无 | 强（raw error 不 mutate、budget 精确、原型完整） |
| 43 | `security-fixes.test.js` | 3 | base64 UTF-8 解码、Buffer 不暴露、atob/btoa 往返 | 沙箱真跑 + 纯函数 | 无 | 中 |
| 44 | `server.test.js` | 7 | 真 `UpstreamManager` + STDIO fake upstream：白名单过滤、顺序、gateway_call/search、sanitize、instructions、text JSON 无 structuredContent | **真 IO**：`harness/fake-upstream.mjs` 子进程 + `InMemoryTransport` | 无 | 强（写工具 create_issue 被过滤） |
| 45 | `services-honesty.test.js` | 8 | `services()` 不再谎称 online：verifiedAt/snapshot note、failedServers=offline、不称 healthy、描述提示 cold-start/re-auth、零上游调用 | 沙箱真跑 + 纯函数，manager 计数 callTool | 无 | 强（zero network 可证、状态词汇保守） |
| 46 | `session-clustering.test.js` | 16 | sessionId 主分组、initialize/15 分钟切窗、跨窗不混、join 仅显式 taskId、确定性 | 纯函数 + 内联 envelope | 无 | 强（不猜 prompt 相似度） |
| 47 | `stale-kv.test.js` | 1 | 陈旧 KV 记录被新 env token 替换、用新 refresh 而非 stale | `UpstreamAuth` + memory store + 注入 fetch | 无 | 强 |
| 48 | `structured-content-blocks.test.js` | 2 | `structuredContent` 单独返回；图片块与 structuredContent 共存 | 纯函数 | 无 | 中 |

### 1.5 T–V 段

| # | 文件 | 测试数 | 覆盖什么 | fake / 真实 | 跳过条件 | 断言强度 |
|---|---|---|---|---|---|---|
| 49 | `task-coverage.test.js` | 5 | `checkCoverage`：保留工具全覆盖、缺失/非保留工具/非法 authority/重复 id/expectedTools 不含工具均失败 | 真 import 私有 `check-task-coverage.mjs`（私有夹具） | 私有 figma 夹具缺失 SKIP（OSS 导出 SKIP） | 中 |
| 50 | `token-liveness.test.js` | 9 | 401/invalid_token→一次强刷+重连；invalid_grant 不重试；expires_at 用真实 obtained_at 不用 now+expiresIn；obtainedAtEnv 透传 | `UpstreamAuth` + `UpstreamManager` + fake clients/fetch/store，改 env 后清理 | 无 | 强（精确计数、bearer 头值、deadline 数值） |
| 51 | `tool-format-dedupe.test.js` | 6 | `unwrapResult` 相同正文只一份、无第三 content alias、图片/isError 不变 | 纯函数 | 无 | 强（出现次数计数） |
| 52 | `true-isolation.test.js` | 3 | Vercel `run` SDK 沙箱：注入能力 `.constructor` 不能执行宿主 40+2、无 process/require/Buffer、正常能力不回归 | 沙箱真跑（QuickJS），fake tools | 无 | 强（哨兵、budget、日志） |
| 53 | `typed-plan-ab.test.js` | 18 | A/B runner：F(v1 code)/S(v2 plan+fallback)、E1–E8、fallback 1–4、A1–A7 gates、NOT_ENOUGH 不默认切换、确定性、报告 | 全 fake model/io；私有 N1–N9 任务集 | 私有 `tasks-online-gap.json` 缺失 SKIP（OSS SKIP） | 强（fake/replay/insufficient 全 NOT_ENOUGH + defaultSwitchAllowed=false） |
| 54 | `typed-plan-engine.test.js` | 12 | 生产 typed-plan 引擎：成功/未知 op/坏参/未知字段/未批准写/只读拒写/部分失败/空 plan/幂等/不可变/meta/六 op registry | 纯函数 + fake IO | 无 | 强（schema 稳定、零 handler 调用） |
| 55 | `typed-plan-integration.test.js` | 16 | `codemode.runTypedPlan` 沙箱 helper：dryRun 默认、只读强制、批准真写、稳定错误、无第四工具/无 schema 泄漏、截断传播 | 沙箱真跑 + 注入 IO | 无 | 强（三工具 schema 逐字、helper 不注册） |
| 56 | `typed-plan-security.test.js` | 18 | 截断读拒绝 patch（含 host-only opt-out）、per-step approve 伪造拒绝、readOnly 整单预校验、严格类型 | 纯函数 + fake IO | 无 | 强（PATCH_READ_TRUNCATED、APPROVAL_REQUIRES_HOST、零副作用） |
| 57 | `typed-plan-spike.test.js` | 9 | 原型 `typed-plan-spike.mjs` 的 op registry/校验/执行契约 | 纯函数 + `createFakeIO` | 无 | 强（注意：测的是 spike 脚本，非生产引擎） |
| 58 | `typed-plan-v2-route.test.js` | 20 | `/mcp/v2`：flag 精确 '1'、v1 逐字不变、v2 同三工具+sanitize schema、plan/code 互斥 E-VAL-BOTH/NONE、只读拒写、批准真写、HTTP 路由、Vercel 401 共享、/mcp/v3 不降级 | loopback 真 handler + SDK client + fake IO + `createAppHandler` | 无 | 强（逐字段、404/200/401 状态） |
| 59 | `upstream-auth-generic.test.js` | 4 | 自定义 provider refreshUrl、内置 provider 默认端点、static token 不进刷新、config 转发 | `UpstreamAuth` + memory store + fake fetch/manager | 无 | 中–强 |
| 60 | `upstream-auth.test.js` | 4 | 长 lived token 不 KV、env bootstrap、过期 refresh 持久化轮换、有效 token 不刷 | `UpstreamAuth` + fake store/fetch | 无 | 强 |
| 61 | `upstream-oauth.test.js` | 4 | Figma OAuth：PKCE start、callback 换 code 并 seed v2 grant、state 单次、admin key gate、Vercel app 路由 | 真 handlers + `MemoryStore` + 注入 fetch，改 env 后清理 | 无 | 强（v2 key、grantId、state replay 400） |
| 62 | `upstream-token-lifecycle.test.js` | 23 | A–G 根因：bootstrap 一次、旋转记录不重建、并发只刷一次、owner-aware lease CAS、loser 不花 grant、invalid_grant 终态但不误杀 winner、preview/prod 隔离、static token 无假刷新、DSH grant 禁用刷新、v2 key 命名空间 | `UpstreamAuth` + 真 `TokenStore` 方法（EVAL 脚本地址断言）+ fake store/fetch | 无 | 强（命令 Lua 文本、跨环境隔离、终态精确） |
| 63 | `upstreams.test.js` | 6 | `tokenEnv` 缺失报错、Bearer/Basic/自定义 scheme/Figma custom header、显式 headers 保留 | `UpstreamManager._createTransport` 真逻辑，改 env 后清理 | 无 | 强（header 值精确） |
| 64 | `vercel-cimd-probe.test.js` | 12 | 探针证据契约：Notion control 先到 pkce_stage 才判案、CIMD 只记 rejected/fetch_failed/unknown、document-only 不造 AS verdict、只 GET 不 follow redirect、无 fetchImpl 直接拒绝 | 注入 fake fetch（无 DNS/网络） | 无 | 强（结论字符串精确、不出现 "accepted"） |

---

## 2. 对照 FRAMEWORK 六模块

### 模块一：核心底座（可替换）—— 覆盖**很厚**（主要在 fake/离线层）

- `[测试]` Code Mode：沙箱隔离（`true-isolation`）、日志/错误结构化（`logs-errors`）、Web API（`p0-fixes`/`security-fixes`）、截断/提示剥离（`no-silent-truncation`/`result-normalize`/`tool-format-dedupe`/`resource-blob-image`/`structured-content-blocks`）、budget 与原型污染（`security-fix-2`/`residual-security-fix`）。
- `[测试]` Typed Plan：spike→引擎→沙箱 helper→v2 route→A/B gate 五层齐全（#53–58），且明确断言“helper 不是第四个工具”“v1 逐字不变”“gate 数据不足时 NOT_ENOUGH 不默认切换”。
- `[测试]` 三工具不变量在 `platform-conformance-suite`/`typed-plan-integration`/`typed-plan-v2-route`/`online-gap-regression` 多处反复钉死。
- `[未验证]` **Native / Hybrid 两种底座**：后半 64 个文件里没有针对 Native（宿主原生工具调用）或 Hybrid（按客户端/任务混合）的测试；`#22 C1` 只断言当前 schema“没有 plan 字段=未支持”，是诚实缺口标记而非覆盖。`#53` 的 A/B 是 Code Mode vs Typed Plan，不是 FRAMEWORK §2 列的四选一全集。**缺失模块轴：底座可替换性本身（切换不改变读/写/授权/结果契约）未被端到端验证**。
- `[未验证]` “底座根据客户端替换”未在任何测试中出现客户端→执行器选择的决策路径。

### 模块二：客户端 —— 覆盖**中厚，但全是离线模拟**

- `[测试]` Gemini/ChatGPT/Claude 三平台编码差异、profile 冻结、redirect allowlist（#22、#23）；`oauth-origin` 验证入站 host 跟随；`reconnect-server` 钉“网关侧可观测，客户端内部 unknown_tool 分类不可观测，不许伪造”。
- `[测试]` `online-gap-regression` T6/T7 明确把“post-deploy Gemini unknown_tool + 手动 @ 恢复”列为 `test.todo`，理由是外部客户端行为不可离线观测。
- `[未验证]` **真实网页端非代码模式客户端**（FRAMEWORK §13.1 的主战场）一次都没连：无真实 Gemini/ChatGPT/Claude 会话、无弹窗/审批实测、无 mode detection（FRAMEWORK §11）。`#30` 是 loopback MCP SDK client，不是网页客户端。缺“平台 × 模式 × MCP 能力”分 lane 的测试轴。

### 模块三：评测体系 —— 覆盖**非常厚**（本半段最大宗）

- `[测试]` 离线 L1 runner（#1）、capture 聚类/项目聚合/平台分桶（#23、#25、#26、#46）、online-feedback schema（#13）、JOIN N1–N9/J1–J6（#15、#16）、A/B gate（#53）、replay 工具（#33）、LLM 标注器 advisory（#24）。
- `[测试]` 大量“诚实性”断言：unknown 不编造 requestId（#13/#33/#64）、不借证据、不跨构建硬比（#16）、NOT_ENOUGH 不切默认（#53）、skip 不虚增 pass（#19）、模型可见错误脱敏但 capture 全保真（#42/#34）。
- `[未验证]` **主动/被动线上复验闭环**：全部是离线/半离线夹具或文档结构校验；没有真实线上 capture 回流→任务→旧/新构建同任务对照的实跑证据。`#1` 的 `l1-real-*` 检查是 workflow 文本静态断言，非真实运行结果。**FRAMEWORK §4 的“主动反哺被动、降低主动频率”目标未被任何测试度量**；`[未验证]` 采集层 session/project/task 交叉在真实流量上的完整性。
- `[测试/代码]` 多个评测测试读私有夹具，OSS 导出会 SKIP（#1/#15/#16/#39/#40/#49/#53）；真实私有集是否全绿本审计未跑，不能从“测试绿”推断。

### 模块四：上游接入 —— 覆盖**厚，但全是 fake fetch/store**

- `[测试]` GitHub/Notion/Linear/Vercel 的授权生命周期被反复覆盖：owner 标记与迁移（#20）、DCR/CIMD（#27）、OAuth start/callback（#61）、token 一次刷新/并发/失效回环（#31/#32/#47/#50/#62）、refreshUrl 转发（#59）、header scheme（#63）。
- `[测试]` `real-gh-replay` / `vercel-cimd-probe` 特意用 fake fetch 复刻真实 provider 的形状（PR number vs id、302 signed URL、CIMD client_id_rejected），证据契约严格。
- `[未验证]` **真实上游调用**：后半无一次真 `api.github.com`/Notion/Linear/Vercel 请求（全是注入 fetch 或 fake upstream）。`[未验证]` Cloudflare/Gmail/Firecrawl/Exa/Tavily 等后续候选上游的 SOP 测试完全缺失。真实 provider 401 在 AGENTS §6 里列为“未验证”，本半段 `#29/#34` 只是 fake 401。
- `[未验证]` 真实写回环（CI 内真 PR/file write/readback）与授权门禁 `docs/AUTH-READY.md` 全绿，均未出现。

### 模块五：运行时 / 部署 —— 覆盖**薄**

- `[测试]` `oauth-origin`（host 跟随）、`mcp-session`/`reconnect-server`（loopback HTTP 语义）、`mcp-v2-smoke`/`(local-e2e-verify)`（离线路由）、`oss-private-fixture-skip`/`oss-staging-curation`（CLI 导出门禁）、`l1-smoke` 的 workflow 静态文本校验。
- `[未验证]` Vercel 生产部署、preview/production KV 物理隔离（#62 只是 fake store 的 key 命名隔离）、内网穿透、容器/本地部署、成本保护、并发/限流调度、税：均无运行时或部署实测。
- `[未验证]` “部署成功 ≠ 验收”这条门本身靠文档与人工执行，测试无法替代。

### 模块六：开源工程 —— 覆盖**中厚（发布卫生）**

- `[测试]` OSS neutralizer 假阳性回归（#17）、私有夹具 SKIP 门禁（#18/#19）、任务集无凭据泄漏（#16）、setup curation（#19）、`README/公开声明` 一致性未在此半段覆盖（属前半或其他审计）。
- `[未验证]` OSS 未公开、无远端/push；发布流程只是本地产物校验，不等于发布治理完成。

---

## 3. “测试绿 ≠ 验收”：自证 / fake / 纯函数 / 缺失轴

### 3.1 自证测试（测试在证明文档或测试自身，而非产品行为）

- `[测试]` `#16 online-semionline-join.test.js`：大量断言是“文档里存在某章节/某 KEY 行/某表格列”，以及“任务 JSON 字段与文档键一致”。它证明 artifacts 自洽，不证明评测结论真实。
- `[测试]` `#19 oss-staging-curation.test.js`：源码级 `assert.match(src, /existsSync.../)` 与“skip 不虚增 pass”的 TAP 计数，属于对测试基建的元测试；有用但不是产品验收。
- `[测试]` `#30 reconnect-server.test.js` 的 6b：直接构造 `OBSERVABLE` 常量并断言其值为 `'unknown'`，文件注释自称 “documentation-as-test assertion”。这是诚实的边界声明，但不能被计为“客户端重连已验证”。
- `[测试]` `#1 l1-smoke.test.js` 的 workflow 测试断言 `.github/workflows/l1-smoke.yml` 文本包含 cron/secret 名，属于配置自证；且该文件在 OSS 导出会 SKIP。
- `[测试]` `#17 oss-neutralizer` 中 handle 字符串运行时拼接，避免测试文件自身成为检测器命中——这是正确的防自证设计，但“检测器能抓构造样本”≠“真实导出树零泄漏”。

### 3.2 fake / 只测纯函数（按文件粗分）

- **纯函数/内存结构为主**（断言强但离真实链路远）：`normalization-order`(4)、`sanitize`(14)、`result-normalize`(35)、`result-bound`(6)、`resource-blob-image`(7)、`tool-format-dedupe`(6)、`structured-content-blocks`(2)、`search-*`(39/40/41)、`project-rollup`/`project-tag`/`session-clustering`/`platform-eval`/`platform-conformance-suite`/`project-llm-labeler`/`online-feedback`/`replay-online-session`、`typed-plan-engine`/`typed-plan-spike`。
- **fake store/fetch 的授权生命周期**（行为真、依赖假）：`owner-marking`、`token-liveness`、`upstream-auth*`、`upstream-token-lifecycle`、`refresh-once`/`refresh-concurrency`、`stale-kv`、`provider-dcr-cimd`、`upstream-oauth`、`real-gh-replay`、`vercel-cimd-probe`。
- **真路由/真 SDK client（最靠近真实但仍是 loopback）**：`local-e2e-verify`、`mcp-session`、`mcp-v2-smoke`、`reconnect-server`、`residual-security-fix`、`typed-plan-v2-route`、`maxwhitelist-zero`、`normalization`、`server.test.js`（STDIO fake upstream）。
- **结论**：后半 64 个文件里，真正跨进程/跨 HTTP 的只有 `#2/#5/#6/#12(部分)/#30/#34/#58/#44/#26(临时落盘)/#19(子进程 TAP)`；其余十之七八是纯函数或注入 fake。这是**单元/契约层的强覆盖，不是端到端验收**。

### 3.3 缺真实客户端 / 真实写 / 授权生命周期（硬缺口）

- `[未验证]` **真实客户端**：无真实 Gemini/ChatGPT/Claude 网页非代码模式会话；无 mode detection；无审批弹窗/OSS 接入实测。FRAMEWORK §13.1 的主战场零覆盖。
- `[未验证]` **真实写回环**：虽然 `typed-plan-*` 与 `no-silent-truncation` 大量断言 “dryRun 不写 / 批准才写 / 写后 readback byte-exact”，但写目标全是 fake IO 或内存字符串；没有真 GitHub PR/file write 的 CI 回环证据。`#29 real-gh-replay` 名字带 real，但明确是 fake fetch、`no commit`。
- `[未验证]` **授权生命周期闭环**：文件里覆盖了 token 刷新的算法与状态机，但 `docs/AUTH-READY.md` 全绿、真实用户授权、refresh token 失效后的一次性授权、provider 真 401 的端到端恢复都未验证；`#64` 甚至证明 Vercel CIMD 被 `client_id_rejected`（BLOCKED 状态）只是 fake 复现历史结论。
- `[未验证]` **owner 迁移已线上生效**：`#20` 测的是迁移脚本对 fake store 的行为，不等于生产 KV 已迁移。
- `[未验证]` **真实上游 401 / Docker build / npm audit**（AGENTS §6 明列未验证），本半段无覆盖。

### 3.4 缺失模块轴汇总

| FRAMEWORK 轴 | 后半覆盖状况 |
|---|---|
| 核心底座：Native / Hybrid | 无测试（只有 Code Mode / Typed Plan） |
| 底座按客户端替换、契约不变 | 无端到端切换测试 |
| 客户端：真实网页非代码模式、mode detection、多客户端隔离 | 无；客户端内部行为被显式标 unknown |
| 主动线上评测、被动复验闭环、成本下降 | 无真实数据；只有离线/文档结构 |
| 后续候选上游（Cloudflare/Gmail/Firecrawl/Exa/Tavily） | 无 |
| 运行时：部署/KV 物理隔离/隧道/本地容器/成本/并发限流 | 无实测 |
| 开源治理/发布 | 仅本地发布卫生；未公开 |

---

## 4. 区分清单（防误读）

- `[测试]` 可确认：上述 64 个文件的测试声明总数约 662；多处强断言与诚实 skip/todo/unknown 设计；三工具不变量、typed-plan 安全闸、owner/DCR/CIMD/刷新状态机、截断契约、平台编码差异均有针对性测试。
- `[代码]` 由测试反推（未逐行审 src）：实现位于 `src/codemode*.js`、`src/upstream-auth.js`、`src/server.js`、`src/vercel-app.js`、`src/result-normalize.js`、`src/typed-plan.js` 等，且行为与测试描述一致；但本审计没有验证测试是否真的全绿。
- `未验证`：全量 `npm test` 的实际 pass/fail/skip 分布；私有夹具存在时的真实执行结果；任何真实网络/真实凭据/真实客户端/真实写/部署后复验。
- `未验证`：前半（A–L，63 个文件）内容；本报告不含它们。

---

## 5. 结论

本半段是**高质量、强断言的契约与回归测试集**，尤其在核心底座安全边界、评测产物诚实性、授权状态机的离线建模上非常扎实；大量测试主动标注 unknown / todo / skip 而不伪造通过，符合 FRAMEWORK 的“不编造”纪律。

但它同时最清楚地证明：**架构方向与测试完备 ≠ 验收**。FRAMEWORK 六模块里，真正缺的是真实客户端、真实写回环、授权生命周期的线上闭环、Native/Hybrid 底座、运行时/部署实测，以及主动/被动评测的真实数据闭环。这些都在这 64 个文件的“未验证”栏里，不能由“测试绿”替代。
