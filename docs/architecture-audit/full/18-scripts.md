# 18 — 脚本层全量只读审计（scripts/ + harness/ + bench/）

> 只读审计，2026-11-24。审计者：full-scripts。
> 本报告只写 `docs/architecture-audit/full/18-scripts.md`；未改 `src/` / `scripts/` / `tests/` / README / 其他 docs / workflows；未 commit / push / deploy。
> 标签约定：**[代码]** = 从文件内容直接读到的实现事实；**[脚本]** = 该文件的角色/接线事实；**[未验证]** = 报告无法证明，需真实环境或人工复核。
>
> 方法：先用 `git ls-files scripts harness bench` 固定文件全集，再用 read 工具逐文件完整打开（没有只读文件名 / grep 代替阅读）。grep 只用于事后交叉核对（CI / package.json / src 的调用点），不替代逐文件阅读。

---

## 0. 文件清单与 expected / read / unread

`git ls-files scripts harness bench` 输出（完整，逐行）：

```
bench/README.md
bench/config.fake.json
bench/run.mjs
bench/tasks.json
harness/fake-upstream.mjs
scripts/analyze-captures.mjs
scripts/audit-tools.mjs
scripts/audit-truncation.mjs
scripts/auth-e2e-harness.mjs
scripts/auth-migrate-owners.mjs
scripts/auth-provision.mjs
scripts/auth-rotation-sim.mjs
scripts/capture-digest.mjs
scripts/check-config.mjs
scripts/check-env-isolation.mjs
scripts/check-task-coverage.mjs
scripts/classify-projects.mjs
scripts/collect-tools.mjs
scripts/eval-cycle.mjs
scripts/eval-search.mjs
scripts/export-oss.mjs
scripts/figma-token.mjs
scripts/gen-figma-tasks.mjs
scripts/join-online-offline.mjs
scripts/local-e2e-verify.mjs
scripts/mcp-v2-smoke.mjs
scripts/measure-context.mjs
scripts/platform-conformance.mjs
scripts/prepare-neutral-source.mjs
scripts/probe-mcp-2026.mjs
scripts/real-gh-replay.mjs
scripts/reconnect-probe.mjs
scripts/record-online-feedback.mjs
scripts/replay-online-session.mjs
scripts/replay-write.mjs
scripts/run-l1-smoke.mjs
scripts/run-tests.mjs
scripts/seed-upstream-tokens.mjs
scripts/smoke.mjs
scripts/typed-plan-ab.mjs
scripts/typed-plan-spike.mjs
scripts/vercel-cimd-probe.mjs
scripts/verify-real-github.mjs
scripts/write-build-info.mjs
```

| 集合 | expected | read（完整打开） | unread |
|---|---:|---:|---:|
| `scripts/` | 39 | 39 | 0 |
| `harness/` | 1 | 1 | 0 |
| `bench/` | 4 | 4 | 0 |
| **合计** | **44** | **44** | **0** |

> 任务描述中的“39 个脚本”与 `scripts/` 实际 39 个 `.mjs` 相符；连同 harness 1 + bench 4 共 44 个 git-tracked 文件，全部读完。
> 大文件分段读完：`capture-digest.mjs`（1–1153 / 1154–1240）、`run-l1-smoke.mjs`（1–1099 / 1100–1109）。

---

## 1. 逐文件速查表

说明：
- **联网**：`无` = 纯离线 / loopback；`条件` = 仅特定 flag 或显式注入的 fetch 时联网；`是` = 默认路径会访问外部网络。
- **真实写**：指对 KV / 远端仓库 / 本地文件系统的实际写入；stdout / dry-run 产物单列。
- **flag**：列出会改变行为的关键开关。

### 1.1 scripts/（39）

| # | 文件 | 用途 | 联网 | 真实写 | flag | 风险 / 证据定位 |
|---|---|---|---|---|---|---|
| 1 | `analyze-captures.mjs` | 每日 capture digest → 免费模型打标 → 校验为 advisory issue | 条件：`--date/--since` 走 R2；非 dry-run 调 `ANALYZER_BASE_URL` | 写 `work/analyzer/*.json`（本地） | `--date`,`--dir`,`--since`,`--days`,`--dry-run`,`--out` | 模型输出只产出假设；validator 强制 `advisoryOnly:true, requiresHumanReview:true`；evidence 必须命中白名单 requestId（L243–279）。AGENTS §1 硬规则在代码层落实。 |
| 2 | `audit-tools.mjs` | 提交快照 vs 官方工具表 vs deny/allow 策略的离线审计 | 条件：`--write-snapshot` 连上游 tools/list | 写 `data/tool-snapshots/<srv>.json`、`data/tool-dataset.json`（仅 `--write-snapshot` / `--sync-dataset`） | `--server`,`--config`,`--snapshot`,`--official`,`--policy`,`--write-snapshot`,`--sync-dataset` | 快照缺失时打印 SKIP 并退出 0（L223–227）；CI 中该步实际可能“空跑”。Figma token 走本地 vault（L155–160）。 |
| 3 | `audit-truncation.mjs` | 全仓词法扫描无标记截断，P0/P1/P2 分级 | 无 | 无（只读） | `--json`,`--ci`,`--root` | 启发式：marker 在同文件即视为 P2（L147–152）；P0→exit 1、P1 warning（L25–26）。CI 已接（`ci.yml:29`）。 |
| 4 | `auth-e2e-harness.mjs` | 真 HTTP loopback 上跑真 OAuth 路由（Notion DCR / Vercel CIMD），假 fetch + 内存 store | 无（fake fetch 白名单 URL，非白名单直接抛错 L143–145） | 无（内存 Map，不落盘） | 无 CLI flag；可 import `runAuthE2E(overrides)`（`vercelNoRefresh`,`failCheck`） | 声称 NON-PRODUCTION、0 真实凭据；覆盖 DCR 复用、v2 grant、CIMD document、no-refresh→400、env mismatch、shared-grant 拒绝、preview/prod 隔离（L314–475）。**与 auth-provision 的“DCR 未实现”文案冲突（见 §4）。** |
| 5 | `auth-migrate-owners.mjs` | owner 标记迁移计划/执行（v1 legacy → v2 owner 命名空间） | 无 | 条件：`--apply` 写 KV（只复制，不删 legacy，不调 provider，L166–177） | `--apply`,`--owner`,`--allow-gateway`,`--json`,`--environment`,`--config` | 默认 plan 只读；`owner=gateway` 需显式 `--allow-gateway`；不打印 token 值，只打印 bool（L18–19）。需 KV 才能 plan（L214–216）。**未验证：** owner 迁移是否已在生产执行（AGENTS §0 说“owner 迁移未做”）。 |
| 6 | `auth-provision.mjs` | 授权预置：离线 plan + 可选 `--verify`（真 tools/list）+ 可选 `--apply`（写 v2 static grant） | 条件：`--verify` 对 MCP endpoint 发真请求（L235–259） | 条件：`--apply` 写 KV（L262–282） | `--provider`,`--token-env`,`--environment`,`--verify`,`--apply`,`--json`,`--mode`,`--callback-base-url` | token 不打印；静态凭据 owner=manual、无 refresh。**过时 blocker：**“src/upstream-oauth.js has no DCR support”（L161,L166,L30–34），但源码已实现 DCR（见 §4）。Vercel 仍 BLOCKED（“do not ask the user yet”, L162），与 AGENTS §0“NOT READY”一致。 |
| 7 | `auth-rotation-sim.mjs` | 确定性 OAuth 刷新/轮换仿真，对比 4 种策略 | 无 | 无（FakeClock/FakeKV/FakeOAuthProvider，内存） | `--scenario`（CLI），import `runScenario/runMatrix` | NON-PRODUCTION；仿真结论不是线上证据。KEY_PREFIX 仍是 `gmcgw:v1:upstream`（L56），与当前 v2 key 命名不同（sandbox 刻意镜像旧代码，注意别当生产事实）。 |
| 8 | `capture-digest.mjs` | 聚合 R2/本地 envelope 为 scorecard（指标/session/project/platform） | 是（R2 API：`listR2Keys`/`readR2Envelope`，L241–259）；`--dir` 可完全离线 | 写 `docs/eval/scorecard-*.{md,json}`（默认 out=docs/eval，L1185,L1225–1231） | `--date`,`--dir`,`--since`,`--days`,`--out` | 不猜平台：只认显式 clientPlatform（L187–215）；project 标签为派生的 advisory；`sessions` 算法 L950–1018。已接入 capture-daily workflow。注意 main 中 R2 模式重复取两次 envelopes（L1195–1219），非功能问题。 |
| 9 | `check-config.mjs` | 校验 config + 打印每个 server 的 allow/deny 与快照计数 | 无 | 无 | 位置参数 / `GATEWAY_CONFIG` / `UPSTREAMS_JSON` | 快照缺失时 `tools total=? ...`（L79–81），不报错。CI 已接（ci.yml:36–38）。 |
| 10 | `check-env-isolation.mjs` | 只读检查 Vercel preview/prod 是否共用 KV 等敏感 env | 是（Vercel API `/v9/projects/:id/env`，L138–148） | 无 | `--project`,`--token`,`--json` | 只比较相等性，不打印值（L17）；读取本地 Vercel CLI auth.json（L118–136）。**未验证：** 是否已在生产项目实跑通过（AGENTS §0 称 preview/prod KV 共用是历史问题）。 |
| 11 | `check-task-coverage.mjs` | 检查 Figma 保留工具是否都有任务、authority 合法、search top5 命中 | 无（本地 fixture + src/catalog） | 无 | `--server`,`--tasks`,`--snapshot`,`--config`,`--no-search` | 私有 fixture 缺失时打印 SKIP 并 `exit 0`（L129–140）。CI 中该步可能空跑。 |
| 12 | `classify-projects.mjs` | 免费模型给无 repo 窗口打项目候选标签（advisory） | 条件：live 模式需 `LABELER_BASE_URL`（L243–285）；dry-run / fixture 完全离线 | 写 `work/labels/project-labels*.{json,md}`（仅 `--out`，L359–363） | `--windows`,`--fixture`,`--dry-run`,`--out`,`--date` | 标签永不回写 capture、不作写路径/幂等键（L7–10,L314）；evidence requestId 必须在输入窗口内（L166–174）；输出 `requiresHumanReview:true`。 |
| 13 | `collect-tools.mjs` | 从真实上游抓 tool schema 写入 `data/tool-dataset.json` | 是：GitHub/Vercel live MCP；Linear/Notion 读 DSH 本地缓存（L49–52） | 写 `data/tool-dataset.json`（L57–58） | 无（env：`VERCEL_TOKEN`,`USERPROFILE/HOME`,`DSH_HOME`） | 从 `~/.cc-switch/copilot_auth.json` 取 GitHub token（L15–22）；token 不打印。数据是后续 eval 的基础 fixture。 |
| 14 | `eval-cycle.mjs` | 离线可重复的 online↔semi-online 评测周期（fake L1 + replay + join 覆盖 + 文档 + baseline） | 无（继承 fake/replay 离线；报告 `networkCalls:0`, L441） | 仅写新时间戳 `docs/eval/eval-cycle-*.{json,md}`（`wx` 独占创建，L531,L591–597） | `--out-dir`,`--report-dir`,`--now`,`--tag`,`--help` | `unknown`/SKIP/missing task id 绝不算 pass（L457–459）；DRIFT/NO_BASELINE 明确但不 fail；baseline 只读（L357–358）。写 fixed 路径由 run-l1-smoke 负责，本脚本不碰。 |
| 15 | `eval-search.mjs` | 离线 search recall 诊断（生产 catalog vs `--all` 旧目录） | 无 | 无（stdout） | `--show-misses`,`--limit=`,`--all`,`--tasks`,`--authority` | **过时数字**：注释“old (misleading) 456-tool catalog”（L7–8），实际当前 dataset 数量随 `data/tool-dataset.json` 变化，未同步。私有 fixture 缺失时 SKIP exit 0（L38–46）。CI 已接（ci.yml:40）。 |
| 16 | `export-oss.mjs` | 白名单导出私有仓库到 staging（默认 dry-run） | 无 | 条件：`--write` 复制文件到 staging；`--check` 只验证 | `--out`,`--source`,`--write`,`--check`,`--help` | 明确“never git init/commit/push/deploy”（L5）；P0 修复：handle 检测先 canonicalize 再 SHA-256 比对（L167–231），避免转义形式假 PASS。DENYLIST 排除 docs/ledger/work/explore 等。 |
| 17 | `figma-token.mjs` | 本地 Figma OAuth vault 桥：status / refresh / run 包装 | 是：`refresh` 打 `https://api.figma.com/v1/oauth/token`（L26,L82–86） | 写 vault `figma-oauth.json`（mode 0600，L50–54,L101）；`run` 向子进程注入 env（L131–142） | `status`,`refresh`,`run -- <cmd>`；env `GATEWAY_SECRET_DIR` | 无机器绝对路径硬编码（L29–35）；refresh 用 client_secret，凭据只在 vault。被 audit-tools 复用（L26）。**未验证：** 本地 vault 是否实配（`status` 会告知）。 |
| 18 | `gen-figma-tasks.mjs` | 从 Figma snapshot + 官方文档列表生成覆盖任务 | 无 | 写 `explore/figma-tasks.json`（L111–113） | 无 | 硬编码测试 fileKey/planKey（L20–21）；weave_* 标 skipReason（付费账户，L92–94）。`npm run gen:tasks` 接入。 |
| 19 | `join-online-offline.mjs` | 只读把在线 capture 窗口 join 到离线 L1/G6 任务 | 条件：`--dir` 离线；默认 R2 联网（L250–264） | 无（stdout JSON） | `--dir`,`--since`,`--days`,`--date`,`--tasks` | 严格锚点：先显式 taskId，再严格相等 projectKey；不按时间戳/工具名/提示猜（L111–118,L223）；unmatched 如实保留。 |
| 20 | `local-e2e-verify.mjs` | 真 HTTP loopback 上跑真 handler 链的本地 E2E（11 项检查） | 无（loopback + fake upstream + fake typedPlanIO） | 无（内存 store，stdout JSON） | 无 CLI flag；可 import `runLocalE2E({failCheck})` | 覆盖三工具、file content 纯正文、PR number URL 优先、v2 flag on/off 等（L266–439）。是本地代码验证，不等于线上验收。 |
| 21 | `mcp-v2-smoke.mjs` | `/mcp/v2` typed-plan 路由的本地 live smoke（9 项检查） | 无（仅 loopback，非 loopback URL 直接拒绝 L176–178） | 无（fake IO/store） | 无 CLI flag；import `runSmoke({fetchImpl,baseUrl})` | 校验 v1 surface 不变、v2 schema、readOnly、approve/dryRun、flag off 404、401 challenge（L236–386）。flag 通过 options.env 注入，不写 process.env（L11–13）。 |
| 22 | `measure-context.mjs` | 计算核心指标：直接暴露全部工具 vs 3 工具网关的上下文占用（bytes/4） | 无 | 写 `work/context-measure.json`（L82–104） | 无 | **过时数字**：注释“the 191 enabled upstream tools”（L7–9），实际数量由 dataset/deny 动态决定（L37）。私有 dataset 缺失时 SKIP exit 0（L24–32）。CI 已接（ci.yml:42）。 |
| 23 | `platform-conformance.mjs` | 离线只读校验 4 条平台不变量（Gemini/ChatGPT/Claude + 稳定三工具） | 无 | 无（stdout / stderr） | 位置参数 `--fixtures <file|dir>`（解析时忽略 `--` 开头的参数，L278） | `unknown` 绝不算 pass（L20–22,L48–50）；平台只认显式 clientPlatform（L60–66）。示例用法写了 `--json out.json`（L31）但解析未实现 `--json`/写文件——**文档/CLI 描述与实现不符**。 |
| 24 | `prepare-neutral-source.mjs` | 为 OSS 导出构建中立化源码副本（含自中立化） | 无 | 条件：`--write` 写中立化副本；`--check` 只验 | `--out`,`--source`,`--write`,`--check`,`--help` | 私有 handle 常量在源码里是字面量（L21–24,L55–56），靠 self-neutralization 从导出的副本里抹掉（L147–157）；断言无残留 handle（L163–168）。与 export-oss 共用 grammar。 |
| 25 | `probe-mcp-2026.mjs` | 只读探测本协议版本 / SDK 能力；可选 loopback JSON-RPC 探测 | 无 / 条件：`--url` 仅 loopback（L43–50） | 无（stdout） | `--url <loopback>` | 硬编码 notes（L105–110）是编写时的观察，可能随 SDK 升级过期；`--url` 只发 server/discover + tools/list，不断言成功（L17）。 |
| 26 | `real-gh-replay.mjs` | 真实 GitHub REST 只读回放 PR number/id 与 Actions 日志 302→签名 URL | 是：`https://api.github.com`（L37,L181,L233,L257） | 无（全 GET，写证据仅 stdout） | env：`GITHUB_TOKEN`,`REPLAY_*`,`GATEWAY_SECRET_DIR`；import `runReplay({fetch,token})` | token 不打印；signed URL / Bearer / query token 做 redact（L95–112）。默认 owner/repo 是 `test-org/test-repo`（中性占位，L46–47）。**未验证：** 真 token 实跑结果（属“未验证 real”）。 |
| 27 | `reconnect-probe.mjs` | 离线 loopback 上的重连/可观测性 6 项观察 | 无（仅 loopback，`assertLoopbackUrl` L72–80） | 无（stdout JSON） | `--base-url <loopback>`；import `runProbe/startProbeServer` | **过时数字/断言**：`ok` 判定要求 `snapshot?.count === 4`（L280），与当前稳定三工具（search/execute_read/execute）矛盾，测试侧同样残留 4 工具期望（见 §4）。unknown tool 的客户端内部分类记 `unknown`（L274–275），符合 AGENTS §4。 |
| 28 | `record-online-feedback.mjs` | 解析/校验/规范化输出 `online-feedback.v1` 记录 | 无 | 无（stdout） | `<input.json|md>`,`--stdin` | requestId 缺失写 `unknown`，不造 UUID（L39–47,L411–419）；PR 规整为正整数；schema 权威是 docs/eval/ONLINE-FEEDBACK.md。 |
| 29 | `replay-online-session.mjs` | 离线回放真实/假在线 session，逐字段 diff（证据而非判决） | 无 | 无（stdout） | `<captures.json>`,`--fixture`,`--stdin` | 写操作强制 `dryRun:true, forRealWrite:false`（L363–383）；model/host/timing 记 not-comparable（L47–58,L590–619）；requestId 缺失写 unknown（L75–77）。 |
| 30 | `replay-write.mjs` | **真实 GitHub 写回放**（建临时分支→seed→dryRun+真实 patch→校验→finally 删分支） | 是：`api.githubcopilot.com` + `api.github.com`（L43,L55,L64） | **是**：真实写远端分支/文件/删分支（L43–48,L61–68） | 必须 `--yes`；env `GITHUB_TOKEN`,`REPLAY_OWNER`,`REPLAY_REPO` | 最高风险脚本。默认 owner=`Bruce-Yii`（个人 handle，L24），repo=`gemini-mcp-gateway`（L25）——**与 OSS 脚本尝试抹掉的 handle 一致，属私有标识残留**；真写依赖 `--yes`。**未验证：** 是否曾实跑成功（AGENTS §0 说真实写回环 CI 未完成）。本次未执行。 |
| 31 | `run-l1-smoke.mjs` | L1 冒烟：fake/real/replay；baseline 冻结隔离；online-gap profile | 条件：fake 无网络；real 调 `explore/run-explore.mjs`（子进程，真模型/上游，L836–867） | 写 `docs/eval/l1-smoke.*`、`l1-real-*`、`l1-real-state.json`、`l1-online-gap.*`（L16–21,L85–86） | `--mode fake|real|replay`,`--profile online-gap`,`--input`,`--baseline`,`--servers`,`--failed-servers`,`--date` | fake 明确标 `fake-dry-run`，不用于衡量网关质量（L37–39,L195–209）；baseline 只读冻结（L567–607）；`unknown` 不转 pass（L639–647）。online-gap baseline 当前缺失 → NO_BASELINE。 |
| 32 | `run-tests.mjs` | 跨平台枚举 tests/*.test.js 并跑 `node --test` | 无 | 无 | 透传额外参数（如 `--watch`） | 无 glob 依赖，Node 20+ 可用（L3–7）。`npm test` 入口。 |
| 33 | `seed-upstream-tokens.mjs` | 把本地 token 文件 seed 到 UpstreamAuth（KV） | 无（只写 KV） | **是**：写 KV token 记录（L66–76） | env `KV_REST_API_URL/TOKEN`,`GATEWAY_CONFIG`,`GEMINI_GATEWAY_TOKENS_DIR` | 输出只报计数；**过时文案**：结尾打印 “seeded into KV under `gmcgw:v1:upstream:*`”（L79），但 `UpstreamAuth.seed` 当前写 v2 命名空间（见 §4）。token 不打印。 |
| 34 | `smoke.mjs` | 老式端到端冒烟：fake upstream stdio → gateway → MCP client | 无（loopback + stdio child） | 无 | 无 | **过时**：仍调用 `gateway_call` / `gateway_search` 旧工具名（L61,L71–78），与当前三工具契约不符；直接工具名查找带老 fallback（L59–62）。`npm run smoke` 入口，可能是历史遗留。 |
| 35 | `typed-plan-ab.mjs` | offline A/B 框架（F=Code Mode / S=typed plan），A1–A7 门槛 | 无（默认 fake；真模型只能由调用方注入 `options.model`） | 仅 `--write` 写 `docs/eval/typed-plan-ab.*`（L651–659,L721–723） | `--tasks`,`--repeats`,`--environment`,`--platform`,`--out-dir`,`--base-name`,`--write`,`--help` | `environment!=real` 或 repeats<3 或 platform!=gemini → 所有 gate `NOT_ENOUGH`（L498–545）；决策只有 KEEP_F/INSUFFICIENT/BLOCKED，**永不 SWITCH**（L56–61,L530–544）；`defaultSwitchAllowed:false`。 |
| 36 | `typed-plan-spike.mjs` | 非生产 typed-plan executor 原型（6 个 op） | 无 | 无（fake IO；复用 `src/file-write.js::applyTextPatch` 纯逻辑，L23） | 无 CLI flag（直接运行打印一条 dry-run trace，L232–242） | 明确非生产、未被 src 引用（L3–10）；write op 必须 dryRun 或显式 approve（L169–173）；A/B 复用其 OP_REGISTRY/executePlan。 |
| 37 | `vercel-cimd-probe.mjs` | 只读探测 Vercel 为何拒绝 CIMD client_id（错误分类） | 是（CLI 真发 GET；import + `fetchImpl` 可完全离线） | 无 | `--client-id`,`--case-file`,`--control`；import `runProbe({fetchImpl,...})` | 用故意错误的短 PKCE challenge，不登录/不换 code/不 POST token（L5–8,L59–60）；`controlOk=false` 时不做结论（L235–238）；没有 `accepted:true`（L25–29）。 |
| 38 | `verify-real-github.mjs` | 对真实 GitHub MCP 做连接 + search_repositories 验证 | 是：`api.githubcopilot.com/mcp/`（默认 readonly L45–46） | 无（只读调用） | env `GITHUB_TOKEN`,`GITHUB_MCP_READONLY=0` | token 来自 env 或 CC Switch 本地文件（L18–32），不打印。`npm run verify:github` 入口。**未验证：** 真 token 实跑结果。 |
| 39 | `write-build-info.mjs` | 构建时把 commit/buildHash 写进 `src/build-info.js` | 无（本地 `git rev-parse`，L58–68） | **是**：默认写 `src/build-info.js`；`--print` 不写 | `--print` | 失败时写 unknown 并 exit 0，不阻断构建（L11–12,L70–84）；hash 排除 generated 文件与 vercel.json（L26–29）。CI 已接 `--print`（ci.yml:46）。 |

### 1.2 harness/（1）

| 文件 | 用途 | 联网 | 真实写 | flag | 风险 / 证据 |
|---|---|---|---|---|---|
| `harness/fake-upstream.mjs` | 确定性 stdio MCP 假上游（6 个 GitHub/Notion 风格工具） | 无 | 无（stdout JSON-RPC） | 无（作为 stdio child 被 spawn） | 故意让 `github__search_code` 的 `filters` 少 `items` 以验证网关 sanitizeTool（L9–15,L64–76）；不在白名单的工具返回 `isError:true`（L159–168）。供 tests/server.test.js 与 scripts/smoke.mjs 使用。 |

### 1.3 bench/（4）

| 文件 | 用途 | 联网 | 真实写 | flag | 风险 / 证据 |
|---|---|---|---|---|---|
| `bench/README.md` | 模型在环 benchmark 说明 | — | — | — | 明确“fake upstream 是 harness sanity check，不是真实质量分”（L12–15）；`--gateway` 指向真实部署需自己 bearer token（L60–65）；警告 `execute` 跑任意 JS（L101–102）。 |
| `bench/config.fake.json` | fake benchmark 的网关配置（codemode + stdio fake-upstream） | 无 | 无 | — | 仅 fixture 工具；不含真实凭据。 |
| `bench/tasks.json` | 5 个确定性 smoke 任务 | — | — | — | `count-tools` 期望 6（L13）——与 fake-upstream 的 6 个工具一致，但网关实际只暴露 3 个固定工具，该任务通过 sandbox 检查上游数量，需实跑确认语义。 |
| `bench/run.mjs` | 模型在环基准：spawn 网关 / 连 `--gateway`，给模型三工具，执行并打分 | 条件：`--dry-run` 无模型调用；真跑需 `BENCH_MODEL_*`；`--gateway` 连外部 URL | 写 `bench/results.json`（git-ignored，L276–278） | `--tasks`,`--max-turns`,`--gateway`,`--token`,`--dry-run` | 连接时强制 `tools.length===3`（L104）；token 不打印；`stdio:['ignore','pipe','pipe']` 子进程（L75–96），finally kill（L283–285）。CI 只跑 `--dry-run`（ci.yml:44）。 |

---

## 2. 六模块映射（评测 / auth / 部署 / OSS / typed-plan / capture）

> 六模块是审计分类，不是用户 FRAMEWORK 的六模块一一对应；此处按任务要求只映射脚本。

### 2.1 评测脚本（最密集）
- **L1 / 在线↔半在线**：`run-l1-smoke.mjs`、`eval-cycle.mjs`、`replay-online-session.mjs`、`record-online-feedback.mjs`、`join-online-offline.mjs`、`replay-write.mjs`（真实写回放）、`real-gh-replay.mjs`（真实只读回放）。
- **搜索/覆盖/上下文**：`eval-search.mjs`、`check-task-coverage.mjs`、`measure-context.mjs`、`collect-tools.mjs`、`gen-figma-tasks.mjs`、`audit-tools.mjs`、`platform-conformance.mjs`。
- **模型分析**：`analyze-captures.mjs`、`classify-projects.mjs`（均 advisory-only，evidence 白名单 + 人审门）。
- **bench**：`bench/run.mjs` + `bench/tasks.json`。
- **状态**：大多数已接 CI / npm scripts；但 `eval-cycle.mjs`、`replay-online-session.mjs`、`join-online-offline.mjs`、`record-online-feedback.mjs`、`platform-conformance.mjs`、`classify-projects.mjs` 未出现在 CI 或 package.json scripts（[代码] 事实，grep 核对）。它们存在且可运行，但**不在生产/CI 默认门禁里**。

### 2.2 auth
- 真路由 E2E：`auth-e2e-harness.mjs`；仿真：`auth-rotation-sim.mjs`；预置：`auth-provision.mjs`；迁移：`auth-migrate-owners.mjs`；KV seed：`seed-upstream-tokens.mjs`；Figma vault：`figma-token.mjs`；env 隔离：`check-env-isolation.mjs`；CIMD 探测：`vercel-cimd-probe.mjs`。
- **均未进 CI**（除 check-config 在 CI）；属离线工具/人工运维脚本。
- **AGENTS §0 状态一致**：授权 NOT READY；`auth-provision` 对 Vercel 仍输出 BLOCKER“do not ask the user yet”。[代码]
- **未验证**：真实授权生命周期、owner 迁移是否已执行、preview/prod KV 是否真隔离、Figma vault 是否配置。

### 2.3 部署
- `write-build-info.mjs`（构建身份，CI 已用 --print）、`check-env-isolation.mjs`（Vercel env 只读，未进 CI）、`seed-upstream-tokens.mjs`（KV seed）、`export-oss.mjs` / `prepare-neutral-source.mjs`（发布前准备，非部署本身）。
- 未发现脚本执行 `vercel deploy` / `git push` / `git commit`（[代码] 事实，逐文件阅读确认）。符合“不要 commit/push/deploy”的纪律。

### 2.4 OSS
- `export-oss.mjs`（白名单 staging）、`prepare-neutral-source.mjs`（中立化副本）。二者默认 dry-run，P0 修复后 handle 检测 canonicalize，但**源码仍含私有 handle 字面量**（prepare-neutral-source L55–56；replay-write L24），靠导出时抹除。
- `audit-tools.mjs`、`check-task-coverage.mjs`、`measure-context.mjs`、`eval-search.mjs` 都有“私有 fixture 缺失 → SKIP exit 0”，使公开 CI 可绿但不代表审计真跑。[代码]

### 2.5 typed-plan
- 原型：`typed-plan-spike.mjs`；A/B：`typed-plan-ab.mjs`；路由 smoke：`mcp-v2-smoke.mjs`、`local-e2e-verify.mjs`。
- 状态：spike 明示非生产、未被 src 引用；A/B 决策永不 SWITCH、`defaultSwitchAllowed:false`；mcp-v2-smoke / local-e2e-verify 是本地 loopback 验证。与 FRAMEWORK §15“Typed Plan 是 flag/v2，不是默认”一致。
- **未验证**：真实 Gemini 客户端上 typed-plan 的 A/B 数据（需 ≥3 real repeats、平台 gemini），当前只有 fake。

### 2.6 capture
- `capture-digest.mjs`、`analyze-captures.mjs`、`classify-projects.mjs`、`join-online-offline.mjs`、`record-online-feedback.mjs`、`replay-online-session.mjs`。
- 采集/聚合/分析都是离线可复现；capture 原样保存在 R2，模型可见输出有 secret 形态脱敏边界（见 analyze-captures prompt）。`capture-digest.mjs` 已接 capture-daily workflow。

---

## 3. “脚本存在但未接生产”

按是否在 CI / package.json / workflows 中可触发分类（[代码] 事实来自 `.github/workflows/*.yml`、`package.json` 与逐文件读取）：

| 类别 | 脚本 |
|---|---|
| **CI 已接** | `run-tests.mjs`（npm test）、`audit-truncation.mjs`、`audit-tools.mjs`、`check-task-coverage.mjs`、`check-config.mjs`、`eval-search.mjs`、`measure-context.mjs`、`write-build-info.mjs`（`ci.yml`）；`capture-digest.mjs`、`analyze-captures.mjs`（`capture-daily.yml`）；`run-l1-smoke.mjs`（`l1-smoke.yml`）；`bench/run.mjs --dry-run`（ci.yml） |
| **npm scripts 可手动触发，但 CI 未接** | `smoke.mjs`（smoke）、`verify-real-github.mjs`（verify:github）、`gen-figma-tasks.mjs`（gen:tasks）、`run-l1-smoke.mjs --mode real`（smoke:l1:real） |
| **仅作为 import 库 / 手动 CLI，完全不在 CI/npm scripts** | `auth-e2e-harness.mjs`、`auth-rotation-sim.mjs`、`auth-provision.mjs`、`auth-migrate-owners.mjs`、`check-env-isolation.mjs`、`classify-projects.mjs`、`export-oss.mjs`、`prepare-neutral-source.mjs`、`figma-token.mjs`（被 audit-tools 间接用）、`eval-cycle.mjs`、`replay-online-session.mjs`、`join-online-offline.mjs`、`record-online-feedback.mjs`、`platform-conformance.mjs`、`probe-mcp-2026.mjs`、`real-gh-replay.mjs`、`reconnect-probe.mjs`、`mcp-v2-smoke.mjs`、`local-e2e-verify.mjs`、`typed-plan-ab.mjs`、`typed-plan-spike.mjs`、`vercel-cimd-probe.mjs`、`replay-write.mjs`、`seed-upstream-tokens.mjs` |

结论：脚本层“证据工具”非常丰富，但**多数未进入默认门禁**；这与架构审计 README 的共同结论“架构承诺与生产默认有距离”一致。注意“存在脚本”不等于“生产已做”。

---

## 4. 过时 blocker 文案 / stale 数字 / 未验证 real

### 4.1 过时 blocker 文案（[代码] 事实 + 源码交叉核对）
- `auth-provision.mjs` L30–34、L161、L166、L192 反复称 “src/upstream-oauth.js does NOT implement DCR / no DCR support / not yet implemented”。
  但 `src/upstream-oauth.js` L23–52、L73–121、L127–149 已实现 RFC 7591 DCR（`registerClient`、`dcrClientKey`、v2 client 命名空间），`auth-e2e-harness.mjs` 的 `notion-dcr-*` 检查也验证了该链路。**这是脚本注释/ blocker 文案滞后于代码。** 影响：可能误导“为何仍 BLOCKED”的判断；Vercel CIMD 真授权仍 BLOCKED 的部分（需 AS 接受 CIMD client_id）另当别论，不能一并作废。
- 根 `AGENTS.md` §2 仍把“Vercel CIMD 被 AS 拒绝、BLOCKED”列为 provider 事实；`vercel-cimd-probe.mjs` 正是为查这个拒绝原因而存在。两者不矛盾，但脚本注释把 DCR 与 CIMD 两个不同卡点混写。

### 4.2 stale 数字（[代码] 事实）
- `measure-context.mjs` L7–9：“the 191 enabled upstream tools”——实际 enabled 数量动态由 `data/tool-dataset.json` 与 config deny 决定（L34–37），191 是某次快照的旧数。
- `eval-search.mjs` L7–8：“old (misleading) 456-tool catalog”——同样为旧 dataset 快照描述，未随 fixture 更新；`--all` 才使用该目录。
- `reconnect-probe.mjs` L280：`o.snapshot?.count === 4` ——与当前稳定三工具契约（`search/execute_read/execute`）冲突；测试侧 `tests/reconnect-server.test.js` L160–163 也仍断言 4 个旧工具（`github__get_file`,`notion__search`,`gateway_call`,`gateway_search`）。属 4→3 工具迁移后的断言残留，**会使 reconnect-probe 的 `ok` 判定基于旧契约**。
- `smoke.mjs` L61,L71–78：仍调用 `gateway_call` / 排除 `gateway_search`——旧工具面残留；`npm run smoke` 可能是历史入口。
- `seed-upstream-tokens.mjs` L79：打印“seeded into KV under `gmcgw:v1:upstream:*`”，但 `UpstreamAuth.seed` 当前写 v2 命名空间（`gmcgw:v2:grant:*`，见 src/upstream-auth.js 与 auth-e2e-harness grantKey）。日志文案过时。
- `auth-rotation-sim.mjs` L56 `KEY_PREFIX='gmcgw:v1:upstream'` 是刻意镜像旧策略的形状，不是生产 key 事实；不要据此推断当前 KV 布局。
- `bench/tasks.json` L13 `count-tools` 期望 6：与 fake-upstream 的 6 个工具有关，和网关“3 工具”不是同一层；文案“How many upstream tools does this gateway expose”有歧义，需实跑确认。

### 4.3 未验证 real（[未验证]，报告无法证明）
- 真实客户端（Gemini / ChatGPT / Claude web）上的主动/被动评测：脚本齐备，但无运行证据。
- 真实 OAuth 授权生命周期（授权→refresh→轮换→revoke）：`auth-e2e-harness` / `auth-rotation-sim` 全是 fake。
- owner 迁移、preview/prod KV 隔离：`auth-migrate-owners` / `check-env-isolation` 存在，但是否在生产执行/通过未从脚本层证明；AGENTS §0 明确“owner 迁移未做、KV 共用是历史问题”。
- 真实写回环：`replay-write.mjs` 是真写脚本，但本次未运行；AGENTS/ACCEPTANCE 记“CI 因 billing 未启动，PARTIAL”。
- 真实上游 401 / secret 脱敏：`real-gh-replay.mjs`、`verify-real-github.mjs` 可验，未从脚本层证明已跑。
- Vercel CIMD 是否被 AS 接受：`vercel-cimd-probe.mjs` 可产出证据，未从脚本层证明结论。
- `figma-token` vault、`collect-tools` 本地缓存、CC Switch token 文件等个人本地前置条件是否具备：脚本本身无法证明。

### 4.4 脚本层自身的安全/纪律观察（[代码]）
- **真写/真联网脚本需显式 flag 或 env**：`replay-write.mjs` 必须 `--yes`；`auth-provision` 真写需 `--apply`；`export-oss`/`prepare-neutral-source` 真写需 `--write`；`vercel-cimd-probe` 真发请求是 CLI 路径，import 时可注入 fake。总体符合“不误触真实写”。
- **个人 handle 残留风险**：`replay-write.mjs` L24 默认 `Bruce-Yii`、`prepare-neutral-source.mjs` L55–56 的 SEG_A/SEG_B 字面量，正是 OSS 中立化要抹除的标识；若这些文件被改动/新增而未经 `prepare-neutral-source`，导出检查可能拦截或有泄漏风险（当前 export-oss 的 detector 会命中字面量，见 SENSITIVE_PATTERNS）。
- **私有 fixture SKIP 语义**：多个审计脚本在 fixture 缺失时 `exit 0` 并打印 SKIP；公开 CI 绿不代表审计真跑（这是设计取舍，非 bug，但不可当通过证据）。
- **重复抓 R2**：`capture-digest.mjs` main 中 R2 模式取两次 envelopes（L1195–1219），可能影响成本/时延，非正确性问题。

---

## 5. 结论

1. 文件全集 44（scripts 39 + harness 1 + bench 4），**expected=read=44, unread=0**，全部逐文件完整读完。
2. 脚本层覆盖了六模块几乎所有“证据生产”场景，且大量内置 advisory-only / dryRun / evidence 白名单 / 人审门，纪律性较强。
3. 但“脚本存在”≠“接生产”：多数 auth / eval / typed-plan / capture _join 脚本未进 CI/npm 默认门禁。
4. 发现多类过时产物：DCR blocker 文案滞后于代码、191/456/4 工具等 stale 数字、`reconnect-probe`/`smoke` 的旧工具面断言、v1/v2 KV 文案混用。
5. 真实授权、真实写、真实客户端、真实 401/CIMD 仍属 **[未验证]**；脚本提供了验证手段，但本次审计未执行任何真联网/真写操作，也未 commit / push / deploy。
