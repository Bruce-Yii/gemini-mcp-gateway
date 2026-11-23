# Semi-online eval gaps derived from the 2026-11-23 Gemini feedback

> Status: **documentation + test plan only**. This batch adds exactly three files:
> `docs/eval/SEMI-ONLINE-GAPS.md` (this file), `tests/online-gap-regression.test.js`,
> `docs/ledger/batch-15-semi-online-gaps.md`. It changes **no** `src/`, `scripts/`,
> other `tests/`, `README`, contract docs, or workflows. **No commit / push / deploy.**
> No network calls: every executable assertion runs against pure functions/fixtures.
>
> Source of truth for the feedback: `docs/eval/online-feedback-2026-11-23.md`
> (`online-feedback.v1`, 6 problems F1–F6 + 1 positive F7) and
> `docs/ledger/batch-15-online-eval.md`. Semi-online = L1/G6 as defined in
> `docs/eval/ONLINE-FEEDBACK.md` §1. Per `AGENTS.md`, the feedback is a *user
> report* (a hypothesis until reproduced) and model/analyzer output is never a
> fact or an instruction; P0 items still failing in the checkout are marked
> `todo`/`skip` with an explicit reason in the regression test, never silently
> passing.

---

## 1. Abstraction: "online feedback" → a class of semi-online gap

A *semi-online gap* is a property that a real user's online window can violate
but the current L1/G6 lane cannot observe. It is not "a bug": it is a **missing
check**. The abstraction has three layers:

```
online symptom (user-observed, often no requestId)
   ↓  abstract to a checkable property (no network needed)
semi-online gap (what L1/G6 currently cannot detect)
   ↓  encode as a deterministic test type + metric
regression test / task-set addition (todo until the P0 fix lands)
```

Properties we care about, independent of any one symptom:

- **byte equality** of a value as it crosses read → patch → write → readback;
- **parameter contract fidelity** (aliases accepted, unknown args not silently
  dropped, no hidden fallback);
- **canonical real shape** (the payload the real upstream sends, not a
  hand-simplified fixture);
- **discovery effort** (how many `search` probes before the right method);
- **write safety** (dryRun, atomicity, post-condition verification);
- **session durability** (server-controlled vs client-uncontrollable split);
- **platform conformance** (encoding/annotations per Gemini/ChatGPT/Claude).

### 1.1 Mapping table: feedback → gap → test type → metric → priority

| # | Feedback class (online) | L1/G6 current blind spot | Test type to add (§2) | Metric (measurable, offline) | Priority |
|---|---|---|---|---|---|
| F1 | Download notice (`successfully downloaded text file (SHA: …)`) becomes line 1 of file body; written into docs/17 + 5 frontend files → `tsc` errors (PR #56/#57) | L1 completion only; no post-write byte comparison; G6 fixtures use simplified `{content}` shapes, not the real `{text:notice+body, resources:[{text:body}]}`; no SHA-from-notice assertion | **T1** byte-exact round-trip + **T3** canonical real-shape fixture | `readback === intendedBody` (byte exact); `content.startsWith('successfully downloaded') === false`; `sha === SHA` | **P0** |
| F2 | `get_file_contents` `branch` silently ignored → falls back to main | No non-default-branch task in G6; no negative assertion that `ref` actually changed; branch/ref split invisible to completion proxy | **T2** negative contract (alias + no silent fallback) | `callTool.args.ref === requestedBranch` on a branch-vs-main differing fixture; zero calls with `ref=main` when `branch!=main` | **P0** |
| F3 | PR DB `id` used as `number` → merge 404 (real PR #53) | `normalizePrResult` has targeted tests, but L1/G6 has no real-shape PR fixture and no "merge uses URL-derived number" post-condition | **T3** canonical real-shape PR fixture | `number === 53` from `{id:1000000001,url:'…/pull/53'}`; `id` never adopted as number | **P1** |
| F4 | Helper `name` vs `branch` parameter split ("name is required" on `branch:'x'`) | L1 task prompts never use the real spelling; helper aliases only covered in batch-11 unit tests, not in task-level checks | **T2** negative contract / alias matrix | `createBranchIfMissing({branch})` succeeds with zero `name is required` errors; accepts `name`/`branch`/`branchName` | **P1** |
| F5 | Aggregated `pull_request_read` method enum absent from tool description → extra probe round | Conformance checks tool names/annotations only (`batch-13`); no description-visibility assertion; `search select:<name>` detail not tested for enums | **T4** discovery effort | `select:github__pull_request_read` detail contains `get\|get_files\|get_check_runs` in one shot; `extraProbes === 0` | **P1** |
| F6a | Missing GitHub Actions failure logs | L1/G6 has no CI-log capability check; batch-11 helpers only fake-tested | **T3** real-shape + **T6** server/client boundary | fake upstream log text reaches result verbatim; 302 does not forward token; truncation flagged; "real CI run" = `todo` (no network) | **P2** |
| F6b | After deploy, long session returns `unknown_tool`; manual @ restores client | L1 runner is one-shot/short; no long-session or reconnect lane; gateway cannot force client reconnect — must be separated from server behavior | **T6** long-session/reconnect split | server: stable tool list across N sequential calls; client: `unknown` (external, not pass) | **P2** |
| F7 (positive) | Batch scripting, atomic multi-file write, read/write split, `safeAll`/`unwrap` all valued | These are invariants; no dedicated regression that they survive other changes | **T5** write safety (atomic/dryRun/post-condition) as invariant guard | one commit for N files; `dryRun` writes zero bytes; post-condition read matches intended | **P0 (protect)** |
| Meta | Half-online tasks verify completion only — not written content, param contracts, real shapes, or long sessions | `completionRate` is the dominant metric; `l1-failed-server` shows denominator masking; no metric for "did the write produce the right bytes" | all of T1–T6 + **T7** platform | per-axis boolean/metric matrix instead of a single completion scalar | cross-cutting |

### 1.2 What "closing a gap" means

A gap is closed only when **both** hold:

1. a deterministic offline test encodes the property (this batch: `tests/online-gap-regression.test.js`), **and**
2. the L1/G6 task set gains a task whose runner can report the same property
   (next-round checklist §4). Until (2), online feedback stays `unverified`
   at the timeline level per `batch-15-online-eval.md` §6 — a unit test is not
   a real-window replay.

---

## 2. Seven new test classes (design)

All classes are offline: fake `callTool`/`read`/`write`, no token, no network.
They live in `tests/online-gap-regression.test.js` where the needed pure
function exists; items blocked on an unfixed P0 are `test.todo`/`skip` with a
written reason and become real assertions after the fix lands.

### T1 — byte-exact round-trip `read → patch → write → readback`

- Fixture body includes CJK + trailing newline + 20+ lines (the shape from the
  `write-replay-2026-11-23.md` incident). `normalizeFileResult(RAW).content`
  must equal the body byte-for-byte (not `notice+body`).
- `applyTextPatch(body, diff)` → `applyFilePatch({read, write, dryRun:false})`
  writes `intendedBody`; a second `read` returns exactly `intendedBody`.
- Assertions on `size`/`sha` from the notice; `content.includes('successfully downloaded') === false`.
- **Fails today**: the guest `fileResult` on `{text, resources}` and the
  no-resources notice strip are still red (`tests/gh-file-p0.test.js` P0-1/P0-2).
  The pure host `normalizeFileResult` real-shape case *passes* and is asserted
  here; the guest/cleanup cases are `todo` with the exact failing test name.

### T2 — negative contract: alias / unknown args / no silent fallback

- `aliasGetFileContentsArgs` maps `branch → ref`, keeps an explicit `ref`,
  and leaves unrelated tools untouched (pure, passing).
- `validateToolArgs` throws on missing required / wrong type; unknown args are
  *not* silently dropped by the pure helper's contract (documented behavior).
- The **sandbox bridge** cases (`callTool` receives `ref=branch`,
  `readFileRange({branch})` → upstream `ref`) are still red in
  `tests/gh-file-p0.test.js` P0-3 → `todo`.
- `createBranchIfMissing({branch})` alias matrix is green in
  `tests/gh-feedback-fixes.test.js`; we assert the pure behavior again here so
  this gap has an owner in the regression file.

### T3 — canonical real-shape fixtures (not simplified)

- `RAW = {text: NOTICE + BODY, resources:[{text: BODY}]}` — the exact GitHub
  shape; notice line included.
- `PR_REAL = {id: 1000000001, url: 'https://api.github.com/repos/o/r/pulls/53'}` —
  `normalizePrResult` must return `number:53`, keep `id` as string only.
- Actions fake log text with a failure diagnostic + oversized body + 302 URL —
  must not forward token, must flag truncation (green in batch-11 tests).
- These fixtures are the shared vocabulary for T1/T2/T5; no hand-waved
  `{content:'hello'}` stands in for a real upstream response.

### T4 — discovery effort (search count / missing method enum)

- `searchWithFallback(tools, 'pull request read', 5)` must surface
  `github__pull_request_read` in one query; `select:<name>` detail must carry
  the method enum `get | get_files | get_check_runs`.
- Metric: `probesToDiscover ≤ 1`; `enumVisible === true`. Today the pure
  `searchWithFallback` one-shot behavior can be asserted; the **description
  enum** assertion is red (`gh-file-p0.test.js` P0-4) → `todo`.
- The invariant "exactly three MCP tools" is asserted green (no new tool to
  work around the missing enum).

### T5 — write safety (dryRun / atomic / post-condition)

- `applyFilePatch(dryRun:true)` writes zero bytes and returns a diff;
  `applyFilePatches` with `push_files` commits all files in one call; a failed
  push writes nothing (already green in `tests/b11-write-transaction.test.js`,
  re-asserted on the canonical fixture).
- New post-condition: after a real patch the *readback* is compared to the
  intended body (ties T1 to the write path — the online symptom was "wrote
  dirty bytes and `tsc` broke").
- Truncated read is a hard stop before any write.

### T6 — long session / reconnect (server vs client boundary)

- **Server-controlled, assertable**: `createCodeModeTools(manager)` returns the
  same three tools in the same order across N sequential `getEntries()` calls;
  tool annotations stable; a stateless handler answers two calls in one
  session without schema drift.
- **Client-uncontrollable, explicitly `unknown`/`skip`**: post-deploy
  `unknown_tool` and manual @ recovery are Gemini-side; the gateway cannot
  observe or force it. The test documents the boundary and refuses to call it
  a pass (no real client, no network). Follow `batch-11-reconnect.md`.

### T7 — platform conformance (Gemini / ChatGPT / Claude encoding + annotations)

- `encodeToolResult` / `encodeModelOutput`: Gemini & Claude strip
  `structuredContent`; ChatGPT keeps/derives it. `applyProfileToTools` preserves
  the three tool names, order, and `readOnlyHint`/`destructiveHint` across
  profiles (green in batch-11/13 tests).
- Extends the matrix with the *online-gap* axis: a download-notice body must
  stay out of the encoded text JSON on all three platforms, and tool-list
  stability must hold across a simulated reconnect on each — this is the
  platform slice of F1/F6b rather than a re-test of OAuth.

---

## 3. Executable regression file contract

`tests/online-gap-regression.test.js`:

- imports only existing pure functions/helpers:
  `src/result-normalize.js` (`normalizeFileResult`, `normalizePrResult`),
  `src/codemode.js` (`aliasGetFileContentsArgs`, `validateToolArgs`,
  `searchWithFallback`, `createCodeModeTools`, `runInSandbox`),
  `src/file-write.js` (`applyFilePatch`, `applyTextPatch`),
  `src/client-profile.js` (`encodeToolResult`, `encodeModelOutput`,
  `applyProfileToTools`, `CLIENT_PROFILES`), plus the online-feedback parser
  for the canonical record fixture.
- no `fetch`, no token, no filesystem writes, no child processes.
- every test blocked on an unfixed P0 uses `test.todo(name, { reason })` or an
  equivalent explicit skip, naming the exact currently-failing test in
  `tests/gh-file-p0.test.js`; nothing is left as a vacuous pass.
- run command: `node --test tests/online-gap-regression.test.js`.

---

## 4. What the next L1/G6 round must add (concrete, not generic)

Ordered by gap priority; each item names the artifact to change and the
assertion to add. This batch does **not** implement them.

| # | Add to L1/G6 | Concrete task / assertion | Closes |
|---|---|---|---|
| N1 | `explore/tasks-smoke.json` (G6 task set) | One **non-default-branch read** task: seed branch `eval/gap-f2` with body `body@branch` ≠ `body@main`, call `github__get_file_contents` with `branch`, assert returned body is `body@branch` (not main) and no `ref` fallback. Add its expected metrics to the frozen `explore/baselines/l1-smoke.json` byServer `github` entry; do not silently change the 50-task baseline denominator. | F2, T2 |
| N2 | L1 real runner post-condition | For every task that performs a write, capture the final file body via a second read and compare byte-for-byte with the intended patch result; emit `writePostConditionOk` in `metrics.json` and render it in the L1 report. A `completionRate` pass with `writePostConditionOk:false` must be a regression. | F1/F7, T1/T5 |
| N3 | Canonical fixture pack for G6 | Replace simplified read/PR fixtures with `RAW={text:notice+body,resources:[{text:body}]}` and `PR_REAL={id:1000000001,url:'…/pull/53'}`. Assert `sha` from notice and `number` from URL. Bump a fixture-version field so the change is auditable. | F1/F3, T3 |
| N4 | `scripts/run-l1-smoke.mjs` metrics | Add `noticeLeakCount`, `branchFallbackCount`, `idAsPrNumberCount`, `enumProbesPerTask` counters (default 0, fail when >0). Wire to the anomaly classifier only after a baseline is frozen; do not mix with `gatewayAnomalyCount`. | F1–F5, T2/T3/T4 |
| N5 | Discovery-effort task | A task whose prompt is "read the files of PR #53" must reach `pull_request_read` with `method:get_files` in **one** search; record `searchProbes` and assert ≤1. Requires the P0-4 description-enum fix first; keep the task `todo` until then. | F5, T4 |
| N6 | Actions-log lane (fake + one gated real) | Fake: `github_actions_get_job_logs` returns failure text verbatim, follows 302 without token, truncates with flag. Real: one manual CI-run replay with `GITHUB_TOKEN` from vault, recorded as a separate doc (not in the automated L1 set, no network in CI). | F6a, T3/T6 |
| N7 | Long-session lane | Add a 2-phase L1 variant: phase A runs a task, phase B (after a simulated deploy/schema-free reload) runs another; assert server tool list identical and no duplicate writes. Record client-side `unknown_tool` as `unknown`, never as a gateway failure or a pass. | F6b, T6 |
| N8 | Platform axis in scorecard | For each L1 task, run the result through the three profiles in `encodeToolResult`; assert Gemini/Claude have no `structuredContent`, ChatGPT has identical text JSON + derived `structuredContent`, and `applyProfileToTools` never changes tool count/order. | F1/F6b, T7 |
| N9 | Evidence chain | Extend L1 output with `taskId/sessionId` on each capture envelope so online feedback with a requestId can be joined to a runner task (currently `no-request-id` for all F1–F7). Keep `online-feedback.v1` `offline.comparison.linked` as the join point; never guess a task from a prompt. | meta, all |

Exit criterion for the next round: all of N1–N9 have either an executed green
task/test with evidence (requestId or test name) or an explicit `unknown`/todo
reason; `completionRate` alone is not accepted as closing any gap.

---

## 5. Non-goals / honest limits

- No real upstream, no network, no token — real-window replay and real PR #53 /
  Actions CI runs remain `unverified` until someone executes them with vault
  credentials and attaches evidence.
- The P0 fixes for guest `fileResult` / branch-alias bridge / method-enum
  description are **not in this checkout** (confirmed by the 7 red tests in
  `tests/gh-file-p0.test.js`); the regression file marks those cases `todo`
  rather than weakening them.
- OpenAI/Anthropic client behavior (CIMD, Claude callback allowlist, plan
  gating) is out of scope for this gap analysis; see
  `docs/eval/PLATFORM-CONFORMANCE-MATRIX.md` for the existing matrix.
- Per `AGENTS.md`, no code, issue, PR, or deploy decision is driven by this
  document or by the online feedback alone.

---

## 6. Addendum: 2026-11-23 Gemini online-feedback → semi-online gap mapping

> Append-only mapping registration for the new record
> [`online-feedback-2026-11-23-gemini.md`](./online-feedback-2026-11-23-gemini.md).
> This addendum does **not** implement any test or change `src/`, `scripts/`,
> `tests/`, README, other docs, or workflows. No commit / push / deploy.
>
> **Provenance boundary**: these F1–F6 items come from a **production old build**.
> The P0 fixes (F1, F2) are code-layer only and **not deployed**. Do not claim the
> symptoms still exist on the live site; code-layer-fixed items are marked
> **待部署验证** (pending post-deploy online re-verification).

### 6.1 Required feedback → semi-online check mapping

| Feedback (online, old build) | Semi-online check (contract / property) | Existing test class / gap owner | Mapping status |
|---|---|---|---|
| **F1** (P0) `content` mixes in `successfully downloaded text file (SHA: …)`, dirtying writeback | **byte-exact roundtrip**: `read → patch → write → readback` byte-equal; `content` has no download notice; SHA extracted from notice | §1.1 F1 row, **T1** byte-exact round-trip + **T3** canonical real-shape fixture; `tests/online-gap-regression.test.js` | code-layer fixed (`src/result-normalize.js` notice strip / SHA), **待部署验证** |
| **F2** (P0) PR `number` occasionally an internal object id | **canonical PR number**: `number` from URL, `id` kept as string only, never adopted as number | §1.1 F3 row, **T3** canonical real-shape PR fixture; `normalizePrResult` tests | code-layer fixed (`numberFromUrl(url) ?? …`), **待部署验证** |
| **F3** (P1) concurrent batch wrapper shapes inconsistent, easy to unwrap the wrong layer | **batch wrapper contract**: uniform unwrap level; failure slot shape consistent (`{ok:false,value}`); caller never unwraps the wrong layer | §1.1 F7 / **T5** invariants (`safeAll` / `unwrap`); `docs/HANDOFF.md` safeAll slot spec | `needs-repro` — reproduce with same code/args/fixture first |
| **F4** (P1) large response truncated as one block, dropping trailing key fields | **truncation metadata**: explicit `truncated` flag with limit/original counts; never silently drop trailing key fields or hard-cut without structure | §1.1 F6a / **T3** real-shape + **T5** hard-stop; `docs/ledger/batch-11-truncation.md` | `needs-repro` |
| **F5** (P1) multi-file edits still committed per file, leaving partial state on failure | **atomic multi-file write**: N files in one commit / `push_files`; on failure zero bytes written; dryRun writes zero | §1.1 F7 / **T5** write safety; `tests/b11-write-transaction.test.js` | `needs-repro` |
| **F6** (P2) CI polling fragmented, needs 3–4 rounds to get a result | **waitForPrChecks / CI helper**: one wait returns the result, avoiding 3–4 manual poll rounds | §4 **N6** Actions-log/CI lane (needs a real CI run; no network in this batch) | `unknown` — helper existence/behavior unknown on target build |

Positive signals (batch scripting + in-script trimming, read/write split, high-frequency
action helpers) map to **T5 / invariant protection** (§1.1 F7 row); no fix or deploy
action, only guard against regression.

### 6.2 Next-step split (as declared by the task)

- **Declared fixed by `codemode-ergonomics` (code layer) — re-verify after deploy**:
  F1 and F2. Code-layer evidence lives in `src/result-normalize.js`; both stay
  **待部署验证** until a post-deploy online replay with evidence is attached.
  No `codemode-ergonomics` batch document exists in this checkout yet — the
  attribution is recorded from the task statement only; do not fabricate PR/commit.
- **Still needs reproduction / post-deploy re-verification**: F3, F4, F5
  (`needs-repro`) and F6 (`unknown`, needs real CI run). Write deterministic
  regression tests after reproducing with the same code/args/fixture; do not
  assume already fixed.
- **Evidence chain**: all items have `requestIds:["unknown"]`, `captureVerified:false`;
  no requestId is invented. The L1/G6 join point stays §4 **N9**; this addendum
  registers mappings only and never treats an online observation as an L1 task.

## 7. Gemini 2026-11-23 addendum join

N1–N9 覆盖基础轴，但 F3–F6 暴露出四个此前没有的半在线维度：batch wrapper contract、truncation tail metadata、atomic-by-default、CI wait helper。对应新增 J1–J6 任务集：xplore/tasks-online-gap-2.json。

- join 矩阵：[ONLINE-SEMIONLINE-JOIN-2026-11-23.md](ONLINE-SEMIONLINE-JOIN-2026-11-23.md)
- 总览：[../EVALUATION.md](../EVALUATION.md)
- 索引：[README.md](README.md)

---

## 8. Addendum 2026-11-24 — PR #80–#101 反馈 → 新增半在线轴 N10–N16（append-only）

> 本节**只追加**，不改上文 N1–N9 的任何定义；编号故意从 **N10** 起，
> 避免与旧 **N1–N9**（`explore/tasks-online-gap.json`）及 **J1–J6**
> （`explore/tasks-online-gap-2.json`）冲突。任务集：
> `explore/tasks-online-gap-3.json`（N10–N16）。本节不改 src/scripts/tests，
> 不 commit/push/deploy；全部 fake/replay、`dryRun:true`、`forRealWrite=false`，
> `requestIds:unknown`。
>
> 来源：`docs/eval/ONLINE-FEEDBACK-2026-11-24-PR80-101.md`、
> `docs/eval/FEEDBACK-2026-11-24-MATRIX.md`。**重要更正**：20 次是已知每次执行/单轮
> 工具调用上限（非 R2 分页/分母 bug）；9 个 model truncation suspect 一律 advisory。

### 8.1 为什么需要新编号

N1–N9/J1–J6 覆盖了字节回环、分支/ref、PR number、发现成本、Actions 日志、长会话、
平台编码、写安全、batch wrapper、尾截断元数据、atomic-by-default、CI wait。
本批反馈还暴露了六个**此前没有半在线轴**的维度（创建幂等与主键、写前语法预检、
补丁式编辑、CI 失败重跑、delete/rename 原子提交、合并后分支清理），以及一条
「advisory 信号与执行上限不得误用为判据/分母」的证据链轴。它们不能塞进 N1–N9
而不改写旧任务定义，故新增 N10–N16。

### 8.2 N10–N16 登记

| ID | 半在线轴（抽象，不照抄原文） | 缺口类型 | 与旧轴关系 | 验收判据 |
|---|---|---|---|---|
| **N10** | 创建调用幂等 + 返回主键从 canonical 源重导 | G3+G6 | 新轴；旧 N3/J2 只管 PR number | 同键创建 1 次；number URL 优先；空值不作成功 |
| **N11** | 写前 TS/TSX + 正则预检 + 唯一命中 patch 编辑 | G1+G3+G6 | 新轴；旧 N9/J5 只管原子写 | 无效文件 path+line 结构化错误、push 中止、零落盘；patch 每 oldText 命中 1 次 |
| **N12** | advisory truncation suspect 与判据分离 | G5+G3+G6 | 扩展 J4（尾元数据），加 suspect 隔离 | 元数据齐全、尾字段有着落；suspect 计数 0/9 不改布尔判据 |
| **N13** | 一次等待到终态 + 失败 job 重跑 | G3+G6 | 扩展 J6（只覆盖 wait），补 rerun | ciWaitRounds===1；rerun 1 次；302 不转 token；无 helper 记 unknown |
| **N14** | delete+add（重命名）单原子提交 | G3+G6 | 新轴；旧 J5 只测多文件原子写 | 单 commit；注入失败零落盘；partial/compensation 齐全 |
| **N15** | 合并后源分支删除（显式守卫动作） | G3+G6 | 新轴 | 成功删 1 次、失败删 0 次；ref 来自 canonical PR |
| **N16** | 证据链：不造 UUID、20 次=执行上限、suspect=advisory、同构建配对 | G5+G6 | 新轴；补 N9 证据链未落地部分 | 全部 requestIds unknown；20 记上限非 bug；禁止跨构建硬比 |

### 8.3 关闭标准（沿用 §1.2）

一条轴关闭需要同时满足：(1) 有确定性离线测试编码该属性；(2) L1/G6 runner 能报告同一属性。
本批 N10–N16 目前是**任务定义 + 断言点**，尚未接入 runner（与 N1–N9/J1–J6 的历史一致：
先登记任务，再由 runner 落地）。所以状态为 `registered`，不是 `covered`；
按 `AGENTS.md`，在线反馈与模型输出不驱动改代码/部署。

- 矩阵：[FEEDBACK-2026-11-24-MATRIX.md](FEEDBACK-2026-11-24-MATRIX.md)
- 离线任务集：`explore/tasks-feedback-2026-11-24.json`（FB1–FB10）
- 半在线任务集：`explore/tasks-online-gap-3.json`（N10–N16）
- 台账：`docs/ledger/batch-17-feedback-eval.md`

