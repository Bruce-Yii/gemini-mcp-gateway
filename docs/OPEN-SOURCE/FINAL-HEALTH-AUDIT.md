# 发布前全面健康检查（FINAL-HEALTH-AUDIT）

**日期/时区：** 2026-11-23 22:55–23:05 +08:00（Asia/Singapore）
**范围：** 私有仓库 `D:\12412\dsh工作区\projects\gemini-mcp-gateway`，HEAD `0ae6d9f`，Node `v24.16.0`，npm `11.13.0`。
**约束遵守：** 本报告是本次唯一人工新增/修改的仓库内文件；未改 `src/`、`scripts/`、`tests/`、`README`、其他 `docs`、workflows；未 commit / push / tag / deploy。所有命令输出证据落在未跟踪的 `work/audit-2026-11-23-*.txt`（本地工作产物，非仓库交付物）。
**重要区分：** “代码绿”（本地确定性检查通过）≠“线上已部署/已授权”。本次没有运行任何部署、真实授权或在线复验；生产 Vercel 仍按基线视为**旧构建、未部署**。SKIP / NOT-RUN / BLOCKED 一律不计为 PASS。

---

## 0. 总览（逐项结论）

| # | 项目 | 结论 | 一句话证据 |
|---|---|---|---|
| 1.1 | 私有 `npm test` | **PASS** | `1352 tests / 1346 pass / 0 fail / 6 todo`，exit 0 |
| 1.2 | `audit-truncation.mjs --ci` | **PASS**（带告警） | `P0=0 P1=28 P2=240`，PASS，exit 0 |
| 1.3 | `check-config.mjs` | **PASS**（带告警） | `config OK`，5 servers，token env 未设置（预期） |
| 1.4 | `measure-context.mjs` | **PASS** | 506 → 3 工具，245,377 → 3,564 tokens（-98.5%），exit 0 |
| 2.1 | `local-e2e-verify.mjs` | **PASS** | 全部 check `ok: true`，含 v1/v2 开关、纯 content、PR number |
| 2.2 | `mcp-v2-smoke.mjs` | **PASS** | 全项 `ok: true`，v2 三工具、flag/401/只读契约成立 |
| 3.1 | L1 `--mode fake` | **PASS** | `50/50`，`gatewayAnomalies=0`，completion 100% |
| 3.2 | L1 `--profile online-gap` | **PASS（有限）** | `loaded=15 skipped=0`，但 `baseline=none`，所有指标 unknown |
| 4 | replay `--fixture` | **PASS（离线 fixture）** | exit 0，输出 `online-replay.v1`；非真实在线回放 |
| 5.1 | `auth-e2e-harness.mjs` | **PASS（fake）** | `"ok": true`，11 项检查全绿；不代表真实 provider 授权 |
| 5.2 | `auth-provision --help` | **SKIP→改用离线 plan** | `--help` 不在 CLI 支持列表（exit 2）；已跑三 provider 离线 plan，均 BLOCKED（预期） |
| 6.1 | OSS staging `npm test` | **PASS** | `1352 / 1229 pass / 0 fail / 117 skip / 6 todo` |
| 6.2 | OSS staging `audit-truncation` | **PASS** | P0=0，PASS |
| 6.3 | OSS staging `check-task-coverage` | **SKIP（脚本内显式）** | 私有 fixture 被导出排除，未做覆盖审计 |
| 6.4 | OSS staging `export-oss --check` | **PASS** | checked 300 text files，CHECK PASSED |
| 6.5–6.8 | OSS repo 同四项 | 同上（PASS/PASS/SKIP/PASS） | 与 staging 一致 |
| 7 | Docker build | **NOT-RUN** | Docker CLI 存在，但 daemon 未运行（npipe 不存在） |
| 8 | `npm audit --omit=dev` | **NOT-RUN（工具失败）** | registry npmmirror 返回 404 NOT_IMPLEMENTED，无法给出漏洞结论 |
| 9 | 文档一致性 | **FAIL（不一致）** | HANDOFF 顶部 660/660、commit 8a6cd48、“已触发 Vercel”与全局基线冲突；EVALUATION §6 陈旧；README token 口径与实测不符 |

**发布阻塞判定：**
1. **文档不一致（§9）** — 建议发布前修正 HANDOFF 顶部表 / EVALUATION §6 / README 口径；属于文档阻塞，不影响代码正确性。
2. **线上未部署 / 未授权（§10）** — 不是代码阻塞，但是**发布状态阻塞**：没有生产复验前，不能宣称 F1–F6 / J1–J6 在线修好。
3. **npm audit 无结论（§8）** — 供应链安全未验证；需换 registry 或人工 CVE 核查后才能称安全门禁通过。
4. OSS 仓库公开动作（owner/repo 确认、release notes、首次 tag）按 RELEASE-LOCAL 仍为人工待办；本次未做、未 push。

---

## 1. 私库检查

所有命令在仓库根目录执行；证据文件为 `work/audit-2026-11-23-private-npm-test.txt` 等。

### 1.1 `npm test` — PASS
```
ℹ tests 1352   ℹ pass 1346   ℹ fail 0   ℹ cancelled 0   ℹ skipped 0   ℹ todo 6
ℹ duration_ms 11614.4997
EXITCODE=0
```
与 AGENTS.md / EXECUTION-PLAN.md 记录的基线 `1352 / 1346 / 0 / 6` 完全一致（HEAD `0ae6d9f` 与基线 `4a77fc0` 不同，但测试数一致；见 §9 风险）。6 个 todo 是已登记的未完成项，不是失败。

### 1.2 `node scripts/audit-truncation.mjs --ci` — PASS
```
[audit-truncation] scanned 185 files: P0=0 P1=28 P2=240
[audit-truncation] PASS (P1 is warning-only; P2 is informational).
TRUNC_EXIT=0
```
P1=28 全部是 warning-only（如 `bench/run.mjs:122`、脚本里的 `JSON.stringify(...).slice(0,200)` 断言/诊断输出），`--ci` 下不阻塞。风险：告警数量较多，若不清理，未来新增真实静默截断容易被噪声淹没；建议后续单独立项，本次不改代码。

### 1.3 `node scripts/check-config.mjs` — PASS
```
mode: codemode; servers: 5 (github/notion/linear/vercel/figma)
warnings: unknown top-level key "_authProvisioning" (ignored);
  5 × "<TOKEN> is not set in this environment; the upstream will be skipped"
config OK   CONFIG_EXIT=0
```
无真实 token 出现在 stdout；token env 缺失是本地预期状态，因而不是 FAIL。

### 1.4 `node scripts/measure-context.mjs` — PASS（但与 README 口径冲突，见 §9）
```
Upstream tools in dataset: 506; Enabled upstream tools: 237
Direct: 981507 bytes ~245377 tokens
Gateway (3 Code Mode tools): 14256 bytes ~3564 tokens
Reduction: 98.5% (241813 tokens saved)
saved work/context-measure.json   CONTEXT_EXIT=0
```

---

## 2. 本地 E2E

### 2.1 `node scripts/local-e2e-verify.mjs` — PASS
exit 0；证据 `work/audit-2026-11-23-local-e2e.txt`。关键 check：`content` 纯正文且 notice/SHA 走独立元数据、PR number URL 优先（53 来自 URL）、`waitForPrChecks`、`runTypedPlan` 经 fake IO 执行、`/mcp/v2` flag off→404 / on→200 且三工具带 plan 入参。全部 `ok: true`。这是本地 checkout 的离线 HTTP E2E（fake upstream），不等于线上联调。

### 2.2 `node scripts/mcp-v2-smoke.mjs` — PASS
exit 0；证据 `work/audit-2026-11-23-mcp-v2-smoke.txt`。覆盖 v2 三工具同序、`plan` 为入参、只读 op 枚举、写操作需 host approve/dryRun、v1 不接受 plan、401 challenge、flag 关闭 404；各项 `ok: true`。

---

## 3. L1 smoke

### 3.1 `node scripts/run-l1-smoke.mjs --mode fake` — PASS
```
[l1-smoke] fake-dry-run: PASS | measured=50/50 (full=50) failed=none
  skippedByServer={} completion=100% gatewayAnomalies=0
  searchHit=100% toolHit=100% tokens/task=0 p95=0ms
L1_FAKE_EXIT=0
```
注：该命令会重写 `docs/eval/l1-smoke-report.md` / `l1-smoke.json` 的 Generated/Trigger 字段；为满足“只写报告”约束，本次运行后已用 `git checkout --` 还原这两个文件，未保留修改。

### 3.2 `node scripts/run-l1-smoke.mjs --profile online-gap` — PASS（有限）
```
[l1-smoke] profile=online-gap: PASS (no frozen baseline: all metrics unknown)
  | loaded=15 skipped=0 baseline=none
L1_GAP_EXIT=0
```
风险：15 个 N/J 任务跑通，但 `baseline=none` ⇒ 所有指标 unknown，**没有冻结基线**。按 AGENTS.md §3，“数据不足标 NOT_ENOUGH，不能自动切默认”；因此不能据此宣称 gap 任务有可比较的趋势或已在新构建复验。生成的 `docs/eval/l1-online-gap-*` 已复制到 `work/audit-2026-11-23-l1-online-gap-*` 作证据并从 docs 移除，保持工作区只新增本报告。

---

## 4. Replay

`node scripts/replay-online-session.mjs --fixture` — **PASS（离线 fixture，非真实在线）**，exit 0；证据 `work/audit-2026-11-23-replay-fixture.txt`。

- fixture 存在并已运行（不是 SKIP）：输出 `schema: online-replay.v1`、`source: fixture`、`fixtureSeed: fixture-2026-11-23`。
- 会话内 `requestIds: ["unknown"]` —— 按规则不编造 UUID。
- diff 中 `clientPlatform` / `clientProfile` / `model` / `clientInfo` / `deployment` / `durationMs` / `responseBytes` 均标 `not-comparable`，并附说明“客户端宿主、OAuth client id、模型/提供方、时序与字节数不是网关断言”。符合 AGENTS.md §3 硬规则。
- 局限：fixture-checkout 的离线回放**不能证明真实在线会话的修复效果**；部署后需旧/新构建同任务对照。

---

## 5. Auth

### 5.1 `node scripts/auth-e2e-harness.mjs` — PASS（fake/replay）
exit 0，输出 `"ok": true`，11 项检查全绿；证据 `work/audit-2026-11-23-auth-e2e.txt`。关键项：Notion DCR start/register/redirect、Vercel CIMD 文档路由、回调无 refresh_token→400、缺 state→400、跨环境 state 拒绝、`owner=dsh` 共享 grant 永不 refresh（`SHARED_GRANT_REFRESH_FORBIDDEN`）、preview/production key 隔离（两条不同 v2 key，无 v1 写入）。
风险：日志中的 `SHARED_GRANT_REFRESH_FORBIDDEN`、`offline_access was not honored` 是测试预期路径，不是线上告警；该 harness 用 fake，不替代真实 provider 授权。

### 5.2 `node scripts/auth-provision.mjs --help` — SKIP（CLI 不支持）→ 已用离线 plan 代替
`--help` 不在 CLI 参数列表，exit 2，仅打印 usage；证据 `work/audit-2026-11-23-auth-provision-help.txt`。按任务要求“或离线 plan”，改跑：
```
node scripts/auth-provision.mjs --provider linear   → BLOCKED: missing --token-env
node scripts/auth-provision.mjs --provider notion   → BLOCKED: missing --token-env（并说明 Business/Enterprise static token / DCR 未实现）
node scripts/auth-provision.mjs --provider vercel   → BLOCKED ×2: 缺 CIMD client_id；真实授权+refresh_token 验证未完成
```
三个 plan 均 exit 1（BLOCKED），这是**设计上的正确结果**，与 `docs/AUTH-READY.md` 的 **NOT READY** 一致。**结论：auth 离线代码/plan 可用，但真实授权未做、未找用户授权、不可声称 AUTH READY。**

---

## 6. OSS 本地产物

两个目录均实跑；注意：`export-oss --check` 必须带 `--out <dir>`，单独 `--check` 会报 `--out <dir> is required`（exit 1），这属于 CLI 用法，不是产物失败；已用正确形式复跑。

| 命令 | `work/oss-release-staging` | `work/oss-release-repo` |
|---|---|---|
| `npm test`（`--prefix`） | **PASS**：1352 / 1229 pass / 0 fail / **117 skipped** / 6 todo | **PASS**：1352 / 1229 pass / 0 fail / **117 skipped** / 6 todo |
| `node scripts/audit-truncation.mjs --ci` | **PASS**：P0=0（P1 warning） | **PASS**：P0=0（P1 warning） |
| `node scripts/check-task-coverage.mjs --server figma` | **SKIP**（脚本输出）：`SKIP: private eval fixtures excluded from the OSS export are missing: explore\figma-tasks.json, data\tool-snapshots\figma.json, data\tool-dataset.json; no coverage audit performed` | **SKIP**，同一原因与文案 |
| `node scripts/export-oss.mjs --out <dir> --check` | **PASS**：checked 300 text files，CHECK PASSED | **PASS**：checked 300 text files，CHECK PASSED |

证据：`work/audit-2026-11-23-oss-{staging,repo}-{test,truncation,task-coverage}.txt`、`work/audit-2026-11-23-export-check-{oss-release-staging,oss-release-repo}.txt`。

**重要：SKIP 不是 PASS。** 117 个 skip 是私有 fixture 被导出排除后由 curation 明确 reason-bearing 的跳过，Figma 任务覆盖审计在 OSS 产物中**没有执行**。导出树 PASS 依赖本地 detector；`docs/OPEN-SOURCE/PUBLIC-SAFETY-AUDIT.md` 曾指出该 detector 对转义形态有假阴性历史，RELEASE-LOCAL 顶部称已修复；本次仅按现有脚本实跑记录结果，未独立复核 detector 的全部绕过形态。公开前仍建议按 RELEASE-LOCAL / PUBLIC-SAFETY-AUDIT 由 release owner 做最终人工复核。

OSS repo 状态：`git -C work/oss-release-repo remote -v` 为空、`tag -l` 为空、HEAD `3260414 chore(oss): initial public release snapshot`、无 push。私有仓库 `git remote -v` 显示 `origin https://github.com/Bruce-Yii/gemini-mcp-gateway.git`（私有仓库自有 remote，非 OSS 产物；本次未对其操作）。

---

## 7. Docker — NOT-RUN

```
docker found: D:\Docker\resources\bin\docker.exe (Client 29.8.2)
docker info → failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine;
  check if the path is correct and if the daemon is running: ... The system cannot find the file specified.
DOCKER_INFO_EXIT=1
```
Docker daemon 未运行 ⇒ 未执行 `docker build`，没有镜像产物。证据 `work/audit-2026-11-23-docker-info.txt`。**不能写“Docker 构建通过”**；需启动 Docker Desktop 后由发布负责人补跑。

---

## 8. 依赖 / 安全 — NOT-RUN（工具失败）

```
npm audit --omit=dev --json
npm warn audit 404 Not Found - POST https://registry.npmmirror.com/-/npm/v1/security/advisories/bulk
  - [NOT_IMPLEMENTED] /-/npm/v1/security/* not implemented yet
npm error audit endpoint returned an error
AUDIT_EXIT=1
```
当前 npm registry 是 `https://registry.npmmirror.com/`，其安全端点未实现，npm audit **无法给出任何漏洞结论**。证据 `work/audit-2026-11-23-npm-audit.txt`。这不是“0 vulnerabilities”；必须用可实现 advisory endpoint 的 registry 重跑（`npm audit --omit=dev --registry=https://registry.npmjs.org/`）或人工 CVE 核查后才能解除该发布阻塞。

---

## 9. 文档一致性 — FAIL（需修复后才算文档基线一致）

对照 `AGENTS.md` / `README.md` / `docs/EXECUTION-PLAN.md` / `docs/EVALUATION.md` / `docs/HANDOFF-2026-11-23.md`（含 wiki 基线 `docs/AUTH-READY.md`、`docs/OPEN-SOURCE/RELEASE-LOCAL.md`）：

| 项 | 全局基线（AGENTS / EXECUTION-PLAN / HANDOFF 晚 checkpoint） | 冲突文本 | 判定 |
|---|---|---|---|
| 测试数 / commit | `1352 / 1346 / 0 / 6`，提交 `4a77fc0` 后 | `docs/HANDOFF-2026-11-23.md` 顶部表第 13 行：`测试 **660/660**`；第 15 行：`最新代码 commit 8a6cd48` | **FAIL**（同一文件下半部分的“晚 checkpoint”第 108 行才是 1352/4a77fc0，顶部表陈旧） |
| 部署状态 | 生产旧构建、100/day 用尽、未部署 | HANDOFF 第 16 行：`8a6cd48 触发 Vercel；healthz 待复验` | **FAIL**（顶部表述暗示新代码已触发部署，与“未部署”基线冲突） |
| EVALUATION 未完成清单 | AGENTS §3 / EXECUTION-PLAN §2 已把 L1 online-gap、replay harness 标为已接线 | `docs/EVALUATION.md` §4 inventory 已写 `L1 接线 ✅ 21/21；commit acba249`、`在线 replay ✅ 22/22；commit 1bb8f8a`，但 §6 仍写 `J1–J6 未接入 L1 runner：l1-task-wire 进行中`、`在线 replay 未完成：online-replay-harness 进行中` | **FAIL**（同一文档内自相矛盾；本次实测两项脚本均可运行，§6 已过时） |
| README token 口径 | 实测 `measure-context.mjs`：3 工具 = 14,256 bytes ≈ 3,564 tokens，减少 98.5% | `README.md` 第 9/10/74/226/227 行：`3 stable tools (~1,520 tokens)`、`99.4% reduction` | **FAIL**（数字与当前实测不一致；且仓库根 `README.zh-CN.md` 需同步核对） |
| AUTH 状态 | `AUTH-READY.md` = NOT READY；本次 auth plan 也 BLOCKED | 一致 | **PASS** |
| OSS 公开状态 | 未公开、无远端、未 push；本地产物两份 | `RELEASE-LOCAL.md` 顶部称最终 blocker 已清、剩人工动作；`PUBLIC-SAFETY-AUDIT.md` 是历史 DO NOT PUBLISH 报告（历史快照），顶部已声明历史性 | **PASS（带条件）**：产物本身无 remote/tag；但 RELEASE-LOCAL 中并存 297 文件“2 open problems”等历史段落，读者必须按顶部最新说明解读 |
| 3 工具 / v2 契约 | AGENTS §4：三工具、v1 不变、v2 flag 关闭默认 | README / 本地 E2E / v2 smoke 一致 | **PASS** |

**风险：** 文档不一致不会让代码测试变红，但会让恢复者误判“已部署/已授权/测试 660”；发布说明若引用 HANDOFF 顶部，会对外传递错误信息。建议发布负责人修正上述三处（HANDOFF 顶部表、EVALUATION §6、README token 数字）后再发版。本次按任务约束**不改这些文件**。

---

## 10. 代码绿 vs 线上未部署 / 未授权（明确分列）

**代码绿（本地确定性证据）：**
- 私库 1352/1346/0/6；本地 E2E、v2 smoke、L1 fake 50/50、replay fixture、auth fake harness 全绿。
- OSS 两份导出树 0 fail（117 reason-bearing SKIP），export-oss --check 通过，无 remote/tag/push。

**线上 / 真实世界未验证（不是 PASS）：**
- 生产 Vercel 仍按基线为旧构建，最新修复未部署；未跑 `healthz` / `tools/list` / 在线同任务复验（F1–F6 / J1–J6 的线上效果未知）。
- 真实 provider 授权未做：`AUTH-READY.md` NOT READY；auth-provision 三个 provider plan 全 BLOCKED；未申请用户授权。
- 真实 Gemini/ChatGPT/Claude connector 未验；只有离线 conformance。
- Docker 镜像未构建（`docker build` NOT-RUN）；npm audit 无结论（NOT-RUN）。
- L1 online-gap 无冻结基线，指标全 unknown（PASS 但不可比）；OSS Figma 任务覆盖审计为 SKIP。

**发布阻塞（按优先级）：**
1. 线上部署窗口 + 部署后复验（状态阻塞，不是代码阻塞）。
2. `npm audit` 换 registry 重跑或人工 CVE 核查（安全门禁未通过，NOT-RUN ≠ 0 漏洞）。
3. 文档一致性三处修正（§9 FAIL）。
4. Docker build 补跑（NOT-RUN）。
5. OSS 公开前 release owner 人工复核（确认 owner/repo、release notes、首次 tag；不 push，直至用户明确授权）。

---

## 附录：本次证据文件清单（均在 `work/`，未跟踪）

```
work/audit-2026-11-23-private-npm-test.txt        work/audit-2026-11-23-truncation-ci.txt
work/audit-2026-11-23-check-config.txt            work/audit-2026-11-23-measure-context.txt
work/audit-2026-11-23-local-e2e.txt               work/audit-2026-11-23-mcp-v2-smoke.txt
work/audit-2026-11-23-l1-fake.txt                 work/audit-2026-11-23-l1-online-gap.txt
work/audit-2026-11-23-l1-online-gap-report.md     work/audit-2026-11-23-l1-online-gap.json
work/audit-2026-11-23-replay-fixture.txt          work/audit-2026-11-23-auth-e2e.txt
work/audit-2026-11-23-auth-provision-help.txt     work/audit-2026-11-23-auth-plan-{linear,notion,vercel}.txt
work/audit-2026-11-23-oss-staging-{test,truncation,task-coverage}.txt
work/audit-2026-11-23-oss-repo-{test,truncation,task-coverage}.txt
work/audit-2026-11-23-export-check-{oss-release-staging,oss-release-repo}.txt
work/audit-2026-11-23-docker-info.txt             work/audit-2026-11-23-npm-audit.txt
```
