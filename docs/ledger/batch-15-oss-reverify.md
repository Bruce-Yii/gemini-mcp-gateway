# Batch 15 — OSS staging + local release repo re-verification (2026-11-23 evening)

> Scope: local only. Re-exported the OSS staging tree from the latest available
> source, rebuilt the local release repository, and re-ran the release gates.
> **No push, no new remote, no tag, no publish/deploy. No commit was made in the
> private repository; `src/`, `scripts/`, `tests/`, README and workflows were not
> modified.** The private repo's pre-existing `origin` (pointing at the private
> repo) was left untouched and was not fetched or pushed to.

## 1. Inputs

- Source: private checkout working tree at the start of this task, HEAD
  `01d58f0` (`chore(oss): neutral fixtures, identity/path cleanup, private-fixture skips`).
  During the run another agent committed `35230945a559f50723b8035190583d0da566113b`
  (`docs: refresh agents, handoff, execution plan, eval status`, 21:36 +08:00);
  that commit only touches docs/planning files that are excluded from the OSS
  export, so the exported snapshot is unaffected. Later still, other agents
  left uncommitted edits in `src/capture.js`, `src/codemode.js`,
  `src/tool-format.js`, `src/upstreams.js` and added `scripts/local-e2e-verify.mjs`;
  these were **not** part of the export and were **not** committed by this task.
- Documents read first: `docs/OPEN-SOURCE/RELEASE-LOCAL.md`,
  `RELEASE-DRYRUN.md`, `PUBLIC-SAFETY-AUDIT.md`,
  `scripts/export-oss.mjs`, `scripts/prepare-neutral-source.mjs`.
- Node `v24.16.0`, npm `11.13.0`, Windows (PowerShell), Asia/Singapore.

## 2. What was rebuilt

| Step | Command / action | Result |
| --- | --- | --- |
| Neutralize latest source | `node scripts/prepare-neutral-source.mjs --out <temp> --write` | 297 included, 54 replacements, 297 files written, post-write validation 0 violations |
| Neutralizer self-check | `node scripts/prepare-neutral-source.mjs --out <temp> --check` | `NEUTRAL CHECK PASSED (0 handle forms)` |
| Export dry-run | `node scripts/export-oss.mjs --source <temp> --out work/oss-release-staging` | 297 include / 0 denied / 0 outside allowlist; 20 dirs |
| Staging re-export | `node scripts/export-oss.mjs --source <temp> --out work/oss-release-staging --write` | **297 files written** (was 287), post-export check passed (296 text files), no `.git` |
| Exporter gate | `node scripts/export-oss.mjs --out work/oss-release-staging --check` | `checked 296 text files` → **CHECK PASSED**, exit 0 |
| Local repo rebuild | copy staging (minus `node_modules`) → `work/oss-release-repo`, `git init -b main`, local identity `OSS Release Bot <oss-release@example.com>`, `git add -A`, `git commit`; `node_modules/` added to `.git/info/exclude` (local-only, uncommitted) | **297 tracked files**, single commit **`db10c63991594ebb684224962d3eac7e1b9bad3f`**, branch `main`, **no remote**, clean tree, **no tag** |
| Repo re-check | `node scripts/export-oss.mjs --out . --check` (inside repo) | `checked 296 text files` → CHECK PASSED, exit 0 |

Staging has no `.git`; the repo has no `node_modules` tracked. File-count change
287 → 297 reflects other agents' source additions since the previous snapshot,
which the task explicitly allowed.

## 3. Gate results (staging and local repo)

| Gate | Staging | Local repo |
| --- | --- | --- |
| `npm ci` | exit 0 — `added 117 packages in 12s` | exit 0 — `added 117 packages in 2s` |
| `npm test` | **exit 1 — 1316 tests / 1199 pass / 11 fail / 100 skipped / 6 todo** | **exit 1 — 1316 tests / 1200 pass / 10 fail / 100 skipped / 6 todo** |
| `node scripts/audit-truncation.mjs --ci` | **exit 0 — PASS** (P1 warning-only, P2 informational, no P0) | exit 0 — PASS |
| `node scripts/check-config.mjs` | exit 0 — `config OK` (5 servers; token env vars absent as expected) | exit 0 — `config OK` |
| `node scripts/export-oss.mjs --check` | exit 0 — CHECK PASSED | exit 0 — CHECK PASSED |
| `node scripts/eval-search.mjs` | exit 0 — explicit `SKIP:` reason | same |
| `node scripts/audit-tools.mjs --server figma` | exit 0 — explicit `SKIP:` reason | same |
| `node scripts/measure-context.mjs` | exit 0 — explicit `SKIP:` reason | same |
| `node scripts/check-task-coverage.mjs --server figma` | **exit 1 — ENOENT `explore/figma-tasks.json`** | same |
| `node bench/run.mjs --dry-run` | exit 0 — `dry run OK` | same |
| `node scripts/write-build-info.mjs --print` | exit 0 | same |
| `check-config` over `examples/*.json` + `templates/upstreams/*.json` | exit 0 for all 4 + 14 files | same |

Logs (untracked, local only): `work/oss-reverify-staging-npm-test.txt`,
`work/oss-reverify-repo-npm-test.txt`. Temporary scanners
(`work/oss-reverify-*.mjs`) and the temp neutral source under `%TEMP%` are local
artifacts, not deliverables.

### 3.1 `npm test` failures — classification (11 staging / 10 repo)

All failures are **export-tree artifacts**, not source regressions. Verified by
running the same six test files in the private checkout (fixtures present):
**92 tests / 92 pass / 0 fail**.

| # | Test | Root cause | Class |
| --- | --- | --- | --- |
| 1–5 | `tests/typed-plan-ab.test.js` (5 tests) | unguarded `readFileSync('explore/tasks-online-gap.json')` via `fixtureTasks()`; private fixture excluded by manifest | private fixture missing |
| 6 | `tests/l1-online-gap-wire.test.js:285` end-to-end default | unguarded `explore/tasks-smoke.json` | private fixture missing |
| 7 | `tests/l1-online-gap-wire.test.js:308` `--profile online-gap` | expects `loaded=15 skipped=0` from excluded fixtures | private fixture missing |
| 8 | `tests/online-semionline-join.test.js` (file level) | fixture-dependent module load in excluded `explore/` / `data/` | private fixture missing |
| 9 | `tests/export-oss.test.js` — `CLI refuses sensitive content before copying` | test drives the detector with the private handle signature, which is deliberately absent from the exported neutralizer copy | expected in export tree (audit F-03 caveat) |
| 10 | `tests/oss-neutralizer.test.js` — `neutralizer self-neutralizes its own signature constants` | same; signature constants are scrubbed from the exported copy | expected in export tree |
| 11 | `tests/capture-sink-fix.test.js` — `sync mode: mcp_latency_ms includes sink wait…` | timing assertion; passed in the repo run, failed in the staging run | flaky timing, not export-specific |

100 skips are explicit, reason-bearing fixture gates; no fake passes.

### 3.2 CI first-push gate — **NOT green**

`.github/workflows/ci.yml` runs `npm test` (line 27) and
`node scripts/check-task-coverage.mjs --server figma` (line 33). In a clean clone
of this snapshot:
- `npm test` → 10–11 fail (see above);
- `check-task-coverage.mjs` → exit 1, unguarded `explore/figma-tasks.json`.

Therefore the requirement "CI 首推门禁问题必须 0" is **not met**. The other
CI steps are green (with documented SKIPs). This is the still-open part of audit
F-09; `eval-search`, `audit-tools` and `measure-context` were already guarded,
but `check-task-coverage.mjs` and the newly added fixture-dependent tests were
not. The repo HEAD has no tag and no remote, so nothing has been pushed.

## 4. Sensitive-value verification (independent of `export-oss --check`)

Exhaustive raw + decoded + compacted scan over 296 text files each in staging and
repo (temporary scanner `work/oss-reverify-final-scan.mjs`):

| Class | Result |
| --- | --- |
| Personal handle, literal / unicode-escaped / URL-encoded / HTML-entity / concatenated / bare segments as a full handle | **0 files** ✅ |
| Real deployment hostname (`*.vercel.app` etc.) | **0 files** ✅ |
| Personal Windows workspace / vault paths as real values | **0 files** ✅ (2 hits are the audit doc's redacted prose and `scripts/export-oss.mjs`'s own detector regex) |
| Real PR DB id `5444514334` | **8 files** ❌ |
| Other real DB ids `5445190988/5445221033/5445326882`, real `node_id`s, real Actions job id `137420494321` | **1 file** (`docs/eval/REAL-GH-REPLAY.md`) ❌ |

Real DB id hits: `docs/eval/REAL-GH-REPLAY.md`,
`docs/eval/ONLINE-SEMIONLINE-JOIN-2026-11-23.md`, `docs/eval/SEMI-ONLINE-GAPS.md`,
`docs/eval/online-feedback-2026-11-23{,-chatgpt,-gemini}.md`,
`src/github-helpers.js:477`, `src/result-normalize.js:574`.
The neutralizer maps the owner to `example-org`, but numeric identifiers are not
in its grammar, so they survive. Fixing this requires editing `src/` + `docs/eval/`
in the private checkout, which is **outside this task's write scope**; it is
recorded as a blocking owner action, not silently passed.

Note: `docs/OPEN-SOURCE/PUBLIC-SAFETY-AUDIT.md` itself ships in the export and
contains redacted descriptions of internal asset names and the bare segment
`yii` in a false-positive explanation. Those are advisory text, not live values,
but they remain a disclosure of internal asset names (audit F-06 class).

## 5. Package identity / publication metadata

| Item | Status |
| --- | --- |
| `package.json` | ✅ `name: codemode-mcp-gateway`, `author: example-org`, repository/homepage/bugs = `example-org/codemode-mcp-gateway` |
| `package-lock.json` root `name` (top-level + `packages[""].name`) | ❌ still `gemini-mcp-gateway` |
| `LICENSE` | ✅ MIT, `Copyright (c) 2026 example-org` (owner/year to be confirmed by human) |
| `README.md` badge + clone URL, `README.zh-CN.md` clone URL | ❌ still `example-org/gemini-mcp-gateway` (3 lines total: README:3, README:127, README.zh-CN:107) |
| `docker-compose.yml:10` image tag | cosmetic: `gemini-mcp-gateway:local` |
| Release notes | ❌ not written (v0.1 alpha notes remain owner work) |
| Tag | ❌ none created; first tag should be `v0.1.0` / `v0.1.0-alpha.1` — **not created locally** |
| Real credentials | ✅ none found (env-var names, placeholders, synthetic fixtures only) |
| Internal docs in export | ⚠️ `PUBLIC-SAFETY-AUDIT.md` and curated `docs/eval/*` still need owner confirmation (pre-existing F-06/F-08/F-10) |

## 6. Verdict

Re-export and local repo rebuild completed; exporter `--check` passes and the
"no personal handle / no real domain / no absolute personal path" conditions are
met. **Publication remains blocked**: (1) real DB ids/node ids/job id survive in
8+1 files; (2) CI first-push gate is red (`npm test` 10–11 fail,
`check-task-coverage` exit 1); (3) identity not finalized in `package-lock.json`
and README clone URLs; (4) release notes/tag are pending human action.

No push, no remote creation, no tag, no deploy, no private commit, no source/script/test/README/workflow edit.
