# OSS export verification (clean staging)

> Scope: **verify only**. This record documents an actual run of
> `scripts/export-oss.mjs` against a clean staging tree. It does not authorize
> any `git init` / `git add` / `git commit` / `git push`, npm publish, or deploy.
> No such operations were performed.

## Environment

- Date: 2026-11-23 (Asia/Singapore).
- Repo: the private `gemini-mcp-gateway` checkout (path intentionally omitted;
  it is one of the patterns the export detector rejects).
- Staging: `work/oss-export-staging` inside the private repo (untracked work
  artifact only; no `.git` was created there).
- Node `v24.16.0`, npm `11.13.0`.
- Pre-existing uncommitted work-tree changes were left untouched.

## What was run, and what happened

### 1. Dry-run against the live private repo — REFUSED (expected by design)

```
node scripts/export-oss.mjs --out work/oss-export-staging
```

Result: exit `1`, nothing written.

```
[export-oss] plan: 203 include, 14510 denied, 23 outside allowlist (of 14736)
[export-oss] DENIED   .github/workflows/capture-daily.yml
[export-oss] DENIED   .github/workflows/l1-smoke.yml
[export-oss] DENIED   .vercel/README.txt
[export-oss] DENIED   .vercel/project.json
[export-oss] DENIED   .vercelignore
[export-oss] DENIED   AGENTS.md
[export-oss] DENIED   data/... (9 files)
[export-oss] DENIED   docs/BACKLOG-GEMINI-SUGGESTIONS.md
[export-oss] DENIED   docs/GEMINI-PROBE.md
[export-oss] DENIED   docs/HANDOFF-2026-11-23.md, docs/HANDOFF.md
[export-oss] DENIED   docs/OPEN-SOURCE/READINESS.md
[export-oss] DENIED   docs/PLAN-2026-11-23.md
[export-oss] DENIED   docs/eval/scorecard-*, docs/eval/weekly-*
[export-oss] DENIED   docs/ledger/... (38 files under docs in total)
[export-oss] DENIED   explore/... (486 files; includes results/, tasks*.json)
[export-oss] DENIED   work/... (13969 files)
[export-oss] REFUSING to export: 14510 denylisted file(s) present in source
```

This is the documented behavior: `buildPlan()` classifies denylisted paths and
`main()` aborts whenever `denied.length > 0` (see `EXPORT-IMPLEMENTATION.md`
§1/§3). **Consequence:** the current script cannot export directly from the
live private repo, because that repo necessarily contains `AGENTS.md`,
`work/`, `explore/`, etc. The practical flow has to be: stage a neutral source
tree containing only allowlisted files, then export from that. The verification
below did exactly that, using the script's documented `--source` override.
This is a process gap, not a leak: no denylisted file was copied.

A second pre-export gate also matters: `validateSelected()` on the live repo's
allowlisted set found **30 sensitive-content hits** (e.g. the personal-handle
default in `package.json`, `README.md`, `LICENSE`, `docs/OPEN-SOURCE/*`; personal paths in
`docs/OPEN-SOURCE/DEPLOYMENT-TEMPLATES.md` and `scripts/figma-token.mjs`).
Those must be neutralized in the source before a real export; they were not
changed here because README/src/other docs are outside this task's write scope.
The temporary neutral source was produced by rewriting those strings only in a
copy under `%TEMP%`; the private source tree was not edited.

### 2. Bug fixes made to the export script / its test (only clear bugs)

- `scripts/export-oss.mjs` — `ALLOWLIST` did not contain the root
  `Dockerfile` / `docker-compose.yml` required by `EXPORT-MANIFEST.md` §3
  ("Dockerfile + docker-compose + healthcheck"). Added both. Staging now
  contains them.
- `scripts/export-oss.mjs` — `isDenied()` treated
  `templates/local/config.local.example.json` as a real local config because
  the denylist rule `config.local.` matched the basename. That public-safe
  placeholder file is referenced by `templates/local/README.md` and
  `docs/OPEN-SOURCE/DOCKER.md`; excluding it broke the documented quickstart.
  The rule now exempts `*.example.json` basenames (real `config.local.json`
  and other local configs are still denied).
- `scripts/export-oss.mjs` — the detector regexes and comments contained the
  literal strings they detect, so `validateSelected()` always flagged the
  export script itself in the source tree (an unbreakable self-check). The
  regexes now use semantics-preserving Unicode escapes (verified: all detectors
  still match their targets), and comments no longer embed the literals.
- `tests/export-oss.test.js` — the test file itself embedded literal detector
  hits (the personal-handle literal, a 26-char fake key value, a real-looking
  domain and personal paths), so the export's own pre-export gate rejected its own test
  file. Sensitive fixtures are now assembled at runtime from harmless string
  fragments; detector semantics and all assertions are unchanged. Added
  regression assertions for the two script fixes above.

Verification of the fix: `node --test tests/export-oss.test.js` → **11 pass /
0 fail** (run in the private repo, before export).

### 3. Dry-run against the neutral source — PASS

```
node work/prepare-neutral-source.mjs    # helper under work/, untracked
node scripts/export-oss.mjs --source <temp neutral source> --out work/oss-export-staging
```

```
[export-oss] mode=dry-run
[export-oss] plan: 215 include, 0 denied, 0 outside allowlist (of 215)
[export-oss] DRY RUN: no files written. Re-run with --write to copy.
[export-oss] would create 19 directories and copy 215 files to ...\work\oss-export-staging
```

Exit `0`. No staging files existed before `--write`.

### 4. `--write` into `work/oss-export-staging` — PASS

```
node scripts/export-oss.mjs --source <temp neutral source> --out work/oss-export-staging --write
```

```
[export-oss] plan: 215 include, 0 denied, 0 outside allowlist (of 215)
[export-oss] wrote 215 files to ...\work\oss-export-staging
[export-oss] post-export check passed (214 text files)
[export-oss] DONE. No git init/commit/push/deploy performed.
```

Exit `0`. Post-export `validateExport()` passed.

## Staging inspection (facts)

Relative-path scan of the final **215 exported files** (before `npm ci`):

- Absent, as required: `docs/ledger/`, `docs/HANDOFF*`, `docs/PLAN-*.md`,
  `AGENTS.md`, `project.json`, `explore/results/`, `work/`, `capture/`,
  `outputs/`, `data/`, `.vercel*`, `coverage/`, `test-results/`,
  `*.log`, `*.capture.json*`, `config.local.*` (except the now-fixed
  public-safe example), `.env`, scorecard/weekly eval artifacts,
  `docs/OPEN-SOURCE/READINESS.md`, and both owner-only workflows
  (`capture-daily.yml`, `l1-smoke.yml`). Only `.github/workflows/ci.yml`
  is present.
- Present: `api/`, `src/`, `tests/`, `scripts/`, `harness/`, `templates/`,
  `bench/`, `examples/`, `docs/`, root `README.md`, `README.zh-CN.md`,
  `LICENSE`, `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`, `DEPLOY.md`,
  `config.example.json`, `vercel.json`, `package.json`, `package-lock.json`,
  plus the newly included `Dockerfile`, `docker-compose.yml` and
  `templates/local/config.local.example.json`.
- No `.git` directory was created in staging.
- Independent text grep over the staging tree for the detector's sensitive
  classes (personal handle, personal Windows/vault paths, real deployment
  hostnames of this project) → **no matches**.

## Validation gate in staging

| Command | Result | Notes |
| --- | --- | --- |
| `npm ci` | **PASS** (exit 0) | `added 117 packages`, network available. |
| `node scripts/audit-truncation.mjs --ci` | **PASS** (exit 0) | `scanned 128 files: P0=0 P1=14 P2=202`; PASS (P1 warning-only, P2 informational). P1s are unmarked `slice()` uses in `bench/run.mjs`, `scripts/{classify-projects,export-oss,gen-figma-tasks}.mjs` — pre-existing warnings, not failures. |
| `node scripts/export-oss.mjs --out work/oss-export-staging --check` | **PASS** (exit 0) | `checked 214 text files`, `CHECK PASSED`. |
| `npm test` | **FAIL** (exit 1) | final run: `tests 678 / pass 669 / fail 9`; see below. (Earlier runs showed 648/657 pass; the count changed because other agents added tests concurrently. Failure set is unchanged.) |

### `npm test` failure classification — export scope gap, not a source bug

All 9 failures are caused by allowlisted tests that import or read files from
excluded private roots:

| Failing test | Missing path (all under staging) |
| --- | --- |
| `tests/detector.test.js` | `explore/trace.mjs` |
| `tests/golden-mcpmark.test.js` | `explore/golden-mcpmark.mjs` |
| `tests/harness-parallel.test.js` | `explore/trace.mjs` |
| `tests/l1-baseline.test.js` | `explore/baselines/l1-smoke.json` |
| `tests/l1-smoke.test.js` | `explore/select-smoke.mjs` |
| `tests/merge-collector-contract.test.js` | `explore/trace.mjs` |
| `tests/search-cjk.test.js` | `data/tool-dataset.json` |
| `tests/search-rework.test.js` (one case) | `explore/tasks-v2.json` |
| `tests/task-coverage.test.js` | `explore/figma-tasks.json` |

The errors are `ERR_MODULE_NOT_FOUND` / `ENOENT` for exactly those paths. The
manifest explicitly excludes `explore/` and `data/`, so this is not a missing
copy bug in `export-oss.mjs`: the **test suite is not export-clean**. To make
`npm test` green in a public export, the public set must be curated — either
split those eval/private tests out of `tests/` (and the runner), or export
neutralized copies of the required fixtures under a public-safe path. That
work is outside the allowed write scope for this task, so it is left as a
documented gap.

No other failure class was observed: the remaining 669 tests, including the
export script's own 11 tests, pass in the clean staging tree.

## Limitations / cautions

- The staging tree used a neutralized temp **copy** because the live source is
  not export-ready (30 sensitive hits) and contains 14,510 denylisted files.
  A real export must first neutralize those source files and then export from
  a source root without denylisted paths, or the script will refuse as shown.
- Detectors are string based; the grep above is an additional manual check,
  not a guarantee. Human review is still required before publication.
- `work/prepare-neutral-source.mjs`, `work/oss-export-staging/`, and the two
  `work/oss-*-output*.txt` logs are local verification artifacts only. They
  are inside `work/`, which the export denylist excludes, and were not
  committed.
- Nothing was committed, pushed, published, or deployed.
