# OSS release dry-run: staging export + publication gate (2026-11-23)

> **Final blocker-fix re-run (2026-11-23 ~22:00 +08:00):** the publication
> blockers found in §8 were cleared and the export/gates re-run. Staging and
> local release repo: 301 files; `npm ci`, `npm test` (**0 fail**; 117 explicit
> SKIPs in the export trees), `audit-truncation --ci`, `check-config`,
> `check-task-coverage` (explicit SKIP with reason in exports), `export-oss
> --check` all exit 0; 0 real DB/node/job ids in the export; unified
> `codemode-mcp-gateway` identity. Full evidence:
> `docs/ledger/batch-15-oss-publish-blockers.md`. Remaining items are pure human
> actions (owner/repo name, release notes, first tag). No push/remote/tag.

> Scope: **records an actual dry-run only**. No `git init`, `git add`, `git commit`,
> `git push`, remote setup, npm publish, or deploy was performed. No source,
> README, other docs, or workflow was changed by this task. No commit was made.
>
> Update 2026-11-23 (fixture curation): the three remaining staging failures
> from §4 were curated (two `existsSync` gates, one script SKIP fallback) and a
> new regression test was added. The staging export now runs `npm test` with
> **0 fail**. See §7. The P0 truncation at `src/upstream-oauth.js` was fixed by
> the auth owner (not by this task); `audit-truncation --ci` now passes.

## 1. Environment and inputs

- Date: 2026-11-23 (Asia/Singapore; run started ~09:42, final gate ~09:47).
- Repo: the private `gemini-mcp-gateway` checkout (path omitted deliberately:
  it matches a sensitive-path detector pattern).
- Node `v24.16.0`, npm `11.13.0`.
- Documents read first: `docs/OPEN-SOURCE/EXPORT-MANIFEST.md`,
  `EXPORT-IMPLEMENTATION.md`, `EXPORT-VERIFICATION.md`, `PLAN.md`, and
  `docs/EXECUTION-PLAN.md` (the execution plan lives under `docs/`, not
  `docs/OPEN-SOURCE/`).
- The private work tree had **uncommitted changes from other agents** throughout
  the run (auth work: `src/upstream-auth.js`, `src/upstream-oauth.js`,
  `src/store.js`, `src/upstreams.js`, and several `tests/*.test.js`). The export
  source is therefore a point-in-time snapshot, not a committed revision. Other
  agents also made commits during the run (e.g. `bf8760d test(eval): N1-N9...`
  at 09:47); none of them were made by this task. Test counts changed between
  runs because of this concurrent editing; the final numbers below are from the
  last consistent run (see §3/§4).

## 2. Commands actually run, and results

| # | Command | Result |
| --- | --- | --- |
| 1 | `node scripts/export-oss.mjs --out work/oss-release-staging` (live repo, dry-run) | **exit 1 — REFUSED by design.** Plan: 244 include, 14,773 denied, 24 outside allowlist (of 15,041). Denied set includes `AGENTS.md`, `work/`, `explore/`, `data/`, `docs/ledger/`, `docs/HANDOFF*`, `docs/PLAN-*`, `docs/OPEN-SOURCE/READINESS.md`, `.vercel*`, owner-only workflows, eval scorecards/weeklies. Nothing written. |
| 2 | `node work/prepare-neutral-source.mjs` | Built a neutralized **copy** of allowlisted files in `%TEMP%\oss-neutral-src-verify` (helper already present under `work/` from the earlier verification; untracked). Private source was not edited. |
| 3 | `node scripts/export-oss.mjs --source <temp neutral source> --out work/oss-release-staging` (dry-run) | **exit 0.** First run: 244 include, 0 denied, 0 outside allowlist; would create 20 dirs / copy 244 files. |
| 4 | `node scripts/export-oss.mjs --source <temp neutral source> --out work/oss-release-staging --write` | **exit 0.** First run: wrote 244 files, post-export check passed (243 text files). Re-run later after other agents' edits: **246 files**, 245 text files, check passed. Re-run mode: printed `DONE. No git init/commit/push/deploy performed.` |
| 5 | `npm ci` (in staging) | **exit 0** — `added 117 packages in 8s`. |
| 6 | `npm test` (in staging, first snapshot) | **exit 1** — 941 tests / 845 pass / 13 fail. Snapshot contained stale auth test files paired with updated auth source (other agents edited tests at ~09:43 after the 09:42 copy). |
| 7 | `npm test` (in staging, refreshed snapshot; final) | **exit 1** — 942 tests / 856 pass / 3 fail / 77 skipped / 6 todo. Full log: `work/oss-release-npm-test-final.txt`. |
| 8 | `node scripts/audit-truncation.mjs --ci` (in staging) | **exit 1** — 1 P0: `src/upstream-oauth.js:124` unmarked production truncation. P1 warnings are informational (unmarked `slice()` in scripts, including `scripts/export-oss.mjs`). |
| 9 | `node scripts/export-oss.mjs --out . --check` (in staging) | **exit 0** — `checked 245 text files`, `CHECK PASSED`. |
| 10 | `node scripts/check-config.mjs` | **exit 0** — `config OK` (token placeholders reported as absent, as expected). |
| 11 | `node scripts/measure-context.mjs` | **exit 1** — `ENOENT ... data/tool-dataset.json` (private fixture excluded by manifest). |
| 12 | `node --test tests/export-oss.test.js` | **exit 0** — 11 pass / 0 fail (export script self-tests). |
| 13 | Comparison: `node --test tests/{stale-kv,token-liveness,upstream-auth-generic,upstream-oauth,audit-truncation}.test.js` in the **live** repo | **exit 1** — 33 tests / 32 pass / 1 fail (the truncation-audit assertion). Confirms the final staging auth-test failures from step 6 were a stale-snapshot artifact, not an export defect. |

## 3. Staging inspection facts (final 246-file tree, before/independent of `npm ci`)

- **No `.git` directory** in staging. No commit, push, or remote was created.
- Absent as required: `AGENTS.md`, `project.json`, `docs/ledger/`, `docs/HANDOFF*`,
  `docs/PLAN-*.md`, `explore/` (incl. `results/`, `tasks*.json`), `work/`,
  `capture/`, `outputs/`, `data/`, `.vercel/`, `.vercelignore`, `coverage/`,
  `test-results/`, `*.log`, `*.capture.json*`, real `config.local.*`,
  `.env`, `credentials`, `secrets`, `docs/eval/scorecard-*`,
  `docs/eval/weekly-*`, `docs/OPEN-SOURCE/READINESS.md`, owner-only workflows
  (`capture-daily.yml`, `l1-smoke.yml`). Only `.github/workflows/ci.yml` present.
- Present as required: `src/`, `api/`, `tests/`, `scripts/`, `harness/`,
  `templates/`, `bench/`, `examples/`, `docs/`, root `README.md`,
  `README.zh-CN.md`, `LICENSE`, `CHANGELOG.md`, `CONTRIBUTING.md`,
  `SECURITY.md`, `DEPLOY.md`, `config.example.json`, `vercel.json`,
  `package.json`, `package-lock.json`, `Dockerfile`, `docker-compose.yml`,
  `templates/local/config.local.example.json`.
- Independent text grep over all 246 exported files for sensitive classes
  (personal handle, personal Windows/vault paths, real deployment hostnames)
  → **0 hits**. Export script's own detector check also passed (§2 step 9).
- Note: `docs/eval/` in the export currently contains 18 curated-allowlisted
  markdown/JSON reports (no scorecards/weeklies). Several were added recently
  by other agents (e.g. `ONLINE-GAP-TASKS.md`, `online-feedback-*.md`); a human
  should re-confirm they are intended to be public (manifest §Include says
  "curated summaries only").

## 4. Final `npm test` failure classification (3 failures)

| Failing test | Root cause | Class |
| --- | --- | --- |
| `tests/l1-failed-server.test.js` (file-level) | Top-level `readFileSync('explore/tasks-smoke.json')` → `ENOENT`; private fixture excluded by manifest. | **Private fixture not trimmed** — test needs the same `existsSync` gate/dynamic-import curation documented in `EXPORT-TEST-CURATION.md`. |
| `tests/online-gap-tasks.test.js` (file-level) | Top-level `readdirSync('data/tool-snapshots')` → `ENOENT`; private fixture excluded by manifest. Test was added after the curation doc's `fail 0` claim. | **Private fixture not trimmed** — same curation gap. |
| `tests/audit-truncation.test.js` — `summarize() reports FAIL only when P0 > 0` | `src/upstream-oauth.js:124` uses `.slice(0, 12)` on a hash inside `grantId` with no truncation marker; P0 in production code. Reproduced in the **live** repo too (32/33 subset pass there; this single test fails). | **Real issue** — introduced by in-flight auth source work. Fix belongs to the auth owner (`auth-arch-fix`), not to the export script; outside this task's write scope. |

Also gate-related, same fixture class: `node scripts/measure-context.mjs` fails
on missing `data/tool-dataset.json`. 77 skipped tests are explicit and
intentional (documented curation); 6 todo markers are pre-existing.

No export-script defect was found in this run; no changes to
`scripts/export-oss.mjs` or `tests/export-oss.test.js` were needed. The earlier
verification's script fixes (Dockerfile allowlist, `*.example.json` denylist
exemption, Unicode-escaped detectors) are present and working.

## 5. Remaining pre-publication checklist (NOT executed)

1. **Decide new repo name / owner** (`codemode-mcp-gateway` recommended by PLAN),
   neutralize `package.json` metadata (`name`, `repository`, `homepage`, `bugs`)
   and README clone URLs in the private source before the next export.
2. ~~**Curate the two fixture-dependent tests** (`l1-failed-server`,
   `online-gap-tasks`) and `measure-context.mjs` for a fixture-free export.~~
   **DONE** — see §7. Re-ran `npm test` from a clean staging tree: 0 fail.
3. ~~**Fix the P0 truncation in `src/upstream-oauth.js:124`** (auth owner).~~
   **DONE by the auth owner** (not this task): `node scripts/audit-truncation.mjs
   --ci` in staging now exits 0 with PASS (P1 warnings only).
4. **Freeze the source**: wait for other agents' uncommitted work to land, then
   re-export once from a clean, neutralized source; confirm detectors have 0 hits.
5. **Manually, by a human**: `git init` in staging, one initial/release commit
   with public-only author metadata, add the new public remote, push. None of
   this was done here.
6. Prepare release notes: v0.1 alpha, single-owner/self-hosted scope, API may
   change, honest client matrix (Gemini tested / Claude target / ChatGPT
   documented-not-promised).
7. Confirm Node 20/22/24 CI matrix offline, Docker compose `/healthz` + `/mcp`
   reachable, and the private repo stays private.

## 6. Artifacts and cleanup

- Staging: `work/oss-release-staging/` (246 exported files; `node_modules/`
  from `npm ci` is an untracked local artifact only). No `.git`.
- Neutral source: `%TEMP%\oss-neutral-src-verify\` (temp copy, not a deliverable).
- Logs: `work/oss-release-npm-test.txt`, `work/oss-release-npm-test-final.txt`,
  `work/oss-release-live-auth-tests.txt` (local untracked artifacts).
- Nothing was committed, pushed, published, or deployed.

## 7. Fixture curation follow-up (2026-11-23, later run)

Write scope was limited to `tests/l1-failed-server.test.js`,
`tests/online-gap-tasks.test.js`, `scripts/measure-context.mjs`, the new
`tests/oss-staging-curation.test.js`, and this document. No `src/`, other
tests/scripts, README, or workflow was edited. No commit/push/deploy.

Changes:

1. `tests/l1-failed-server.test.js` — both private reads
   (`explore/tasks-smoke.json`, `explore/baselines/l1-smoke.json`) are behind
   `existsSync`. 12 fixture-dependent tests use `test(name, { skip: reason },
   fn)`; 3 pure helper tests (CLI parse, report render, legacy metrics) still
   run in staging. In the private repo all 15 run unchanged.
2. `tests/online-gap-tasks.test.js` — `explore/tasks-online-gap.json` and
   `data/tool-snapshots/` are guarded before any top-level read; all 6 tests
   skip with the explicit reason when absent.
3. `scripts/measure-context.mjs` — when `data/tool-dataset.json` is absent it
   prints `SKIP: ...` and exits 0, without writing `work/context-measure.json`.
   Private-repo behaviour is unchanged.
4. `tests/oss-staging-curation.test.js` (new, 8 tests) — asserts the guards in
   source; runs each curated file in a temp tree without fixtures and checks
   the reason-bearing `# SKIP` lines, `fail 0`, and that skipped tests are not
   counted as passes (TAP `# pass` equals only executed `ok` lines); checks
   fixture-present execution; checks `measure-context.mjs` skip/exit-0/no-file.
   Nested `node --test` invocations strip `NODE_TEST_CONTEXT` so the child
   emits a real TAP plan.

Verification actually run:

| Command | Result |
| --- | --- |
| `node work/prepare-neutral-source.mjs` | exit 0 — rebuilt neutral source copy |
| `node scripts/export-oss.mjs --source <temp neutral source> --out work/oss-release-staging --write` | exit 0 — 261 files written, 260 text files checked, post-export check passed, no `.git` created |
| `node --test tests/oss-staging-curation.test.js` (live repo) | **8 tests / 8 pass / 0 fail / 0 skipped** |
| `npm test` (staging, curated 261-file snapshot) | **exit 0 — 1075 tests / 973 pass / 0 fail / 96 skipped / 6 todo** (up from 77 skips: +18 from the two newly gated files; curation tests included) |
| `npm test` (staging, intermediate 263-file re-export with other agents' in-flight `capture` work) | exit 1 — 1098 / 993 pass / 3 fail / 96 skip / 6 todo. Failures: `tests/capture-sink-fix.test.js` — `sync mode: mcp_latency_ms includes sink wait, legacy duration does not`, `async mode: originalEnd is immediate; mcp_latency_ms excludes sink wait`, `response bytes unchanged with capture on vs off (string + Uint8Array chunks)`. Captured mid-edit; resolved by the capture owner below. |
| `npm test` (staging, final re-export after capture owner's fix) | **exit 0 — 1098 tests / 996 pass / 0 fail / 96 skipped / 6 todo**. All 3 capture failures disappeared; all 8 curation tests pass (7 pass + 1 explicit fixture-present skip). |
| `node scripts/measure-context.mjs` (staging) | exit 0 — printed `SKIP: data/tool-dataset.json is a private eval fixture excluded from the OSS export ...`; no artifact written |
| `node scripts/audit-truncation.mjs --ci` (staging) | exit 0 — `PASS (P1 is warning-only; P2 is informational)`; the former P0 `src/upstream-oauth.js` truncation is gone (auth owner's fix) |
| `npm test` (live private repo, full suite) | **exit 0 — 1087 tests / 1081 pass / 0 fail / 0 skipped / 6 todo**; all curation and curated tests pass with fixtures present |

One transient `tests/capture.test.js:144` failure (`path.join` with undefined)
was observed in an intermediate staging run; a clean re-run was 0 fail and it
is unrelated to the curated files. The 3 later `tests/capture-sink-fix.test.js`
failures came from other agents' in-flight `src/capture.js` work; after their
fix landed the final staging re-export was 0 fail (see table above). They were
reported, not fixed by this task. **No failures in any file owned by this
task.**

Skips in staging are explicit and carry the fixture reason; nothing is
reported as a fake pass. No commit was made.

## 8. Latest-source re-verification (2026-11-23 evening)

A further re-export from the latest source (private HEAD `01d58f0` at export
time; `3523094` landed during the run as a docs-only commit) produced **297
staging files** (up from 287) and a new local repo commit
`db10c63991594ebb684224962d3eac7e1b9bad3f` (no remote, no tag). Neutralizer:
297 included / 54 replacements / 0 post-write violations; `export-oss --check`:
`checked 296 text files`, CHECK PASSED.

Gates in the new staging tree: `npm ci` exit 0; `npm test` **exit 1 — 1316 tests
/ 1199 pass / 11 fail / 100 skipped / 6 todo** (10 fail in the repo copy);
`audit-truncation --ci` exit 0 PASS; `check-config` exit 0 `config OK`;
`eval-search` / `audit-tools` / `measure-context` explicit SKIP with exit 0;
`bench/run.mjs --dry-run` and `write-build-info --print` exit 0. The new
failures are fixture/neutralizer-signature artifacts: `typed-plan-ab.test.js`
(5), `l1-online-gap-wire.test.js` (2), `online-semionline-join.test.js` (1),
`export-oss.test.js` + `oss-neutralizer.test.js` (2, private-handle signature
scrubbed from export), and one flaky capture timing assertion (passed in the
other tree). The same six files pass 92/92 in the private checkout with
fixtures present. **`check-task-coverage.mjs --server figma` (a CI step) still
exits 1 on the excluded `explore/figma-tasks.json`** — the remaining open part
of audit F-09. Therefore the CI first-push gate is not green (2 problems).
Independent scans: 0 personal handle / real domain / absolute path, but real
PR DB ids/node_ids/job id remain in 8+1 files — a publication blocker outside
this task's write scope. Full evidence:
`docs/ledger/batch-15-oss-reverify.md`. No push, tag, or private commit.
