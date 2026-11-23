# OSS release dry-run: staging export + publication gate (2026-11-23)

> Scope: **records an actual dry-run only**. No `git init`, `git add`, `git commit`,
> `git push`, remote setup, npm publish, or deploy was performed. No source,
> README, other docs, or workflow was changed by this task. No commit was made.

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
2. **Curate the two fixture-dependent tests** (`l1-failed-server`,
   `online-gap-tasks`) and `measure-context.mjs` for a fixture-free export,
   or update `EXPORT-TEST-CURATION.md` to match reality. Then re-run `npm test`
   until green from a clean staging tree.
3. **Fix the P0 truncation in `src/upstream-oauth.js:124`** (auth owner) so the
   truncation audit passes.
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
