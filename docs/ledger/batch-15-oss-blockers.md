# Batch 15 — OSS public-safety blockers (P1/P2) fix record

Date: 2026-11-23
Scope: private source checkout `projects/gemini-mcp-gateway`. No commit, push,
tag or deploy. Files written are limited to the blocker-fix allowlist:

- `package.json`
- `bench/results.json`
- `scripts/figma-token.mjs`, `scripts/real-gh-replay.mjs`
- `scripts/eval-search.mjs`, `scripts/audit-tools.mjs` (lead-authorized addition for F-09)
- `tests/*.test.js`
- `docs/OPEN-SOURCE/PUBLIC-SAFETY-AUDIT.md`
- `docs/OPEN-SOURCE/RELEASE-LOCAL.md`
- this ledger

Explicitly **not** touched: `src/`, `scripts/export-oss.mjs`,
`scripts/prepare-neutral-source.mjs`, other scripts, README, workflows,
LICENSE, package-lock, `docs/eval/*`, and other docs. The P0 neutralizer/detector
fix is owned by a separate agent (`batch-15-oss-neutralizer.md`).

## 1. Identity decision (F-07)

Public identity chosen: `example-org/codemode-mcp-gateway`.

- `package.json` now has `name: "codemode-mcp-gateway"`, `author: "example-org"`,
  `repository.url: git+https://github.com/example-org/codemode-mcp-gateway.git`,
  matching `homepage` and `bugs.url`.
- Rationale: `docs/OPEN-SOURCE/README.md` and `docs/OPEN-SOURCE/PLAN.md`
  recommend `codemode-mcp-gateway`; `example-org` is the neutral placeholder
  already used in README/LICENSE/badges.

Owner follow-up (out of write scope): mirror this identity into
`package-lock.json` root `name` (lines 2 and 8), LICENSE copyright, README
badges/clone URLs in both languages, and the Docker image tag.

## 2. Neutral fixtures (F-01/F-03/F-05)

All personal owner/repo strings were replaced in `tests/*.test.js`:

| Old value | Neutral fixture |
|---|---|
| `<private-handle>` (owner) | `test-org` |
| `<private-project>` (repo) | `test-repo` |
| `gemini-mcp-gateway` (as repo fixture in tests) | `test-gateway` |
| real DB ids `5444514xxx` | `1000000001`–`1000000004` |
| `PR_kwDOABC123`, `PR_kwNODE<n>` | `PR_kwDOEXAMPLE001` shape |
| real PR sequence 53/56/57/59 in replay | `1/2/3/4` |
| real Actions job id | `999999999999` |

Files changed: `project-tag.test.js`, `project-llm-labeler.test.js`,
`gpt-online-fix.test.js`, `online-feedback.test.js`, `real-gh-replay.test.js`,
`gh-feedback-fixes.test.js`, `online-gap-regression.test.js`,
`export-oss.test.js`. Test semantics (id-vs-number distinction, tool-args
priority, PR-URL parsing, redaction, etc.) are unchanged.

`tests/export-oss.test.js` note: the `personal-handle` detector in
`scripts/export-oss.mjs` is digest-pinned to the private identity, so a neutral
fixture cannot trigger it. That test now exercises the remaining detector
classes (`denylist`, `real-domain`, `secret-assignment`) with synthetic values
built at runtime; handle-detector coverage moves to private release tooling.
All sensitive-looking values in the test *source* are assembled at runtime so
the public file itself stays clean under `--check`.

`tests/oss-private-fixture-skip.test.js` added: asserts F-09 SKIP behaviour.

## 3. Paths and vault configuration (F-04)

- `bench/results.json`: `tasksFile` is now the relative path `bench/tasks.json`.
- `scripts/figma-token.mjs`: `vaultDir()` uses `GATEWAY_SECRET_DIR` when set,
  otherwise `~/.config/codemode-mcp-gateway/` built from `HOME`/`USERPROFILE`.
  The machine-specific `<private-workspace>\...` comment and the internal `DSH_HOME`
  variable were removed.
- `scripts/real-gh-replay.mjs`: `OWNER`/`REPO`/`WANTED_PR_NUMBERS`/
  `EXACT_PR_NUMBER`/`JOB_ID` are env-driven (`REPLAY_OWNER`, `REPLAY_REPO`,
  `REPLAY_PR_NUMBERS`, `REPLAY_EXACT_PR_NUMBER`, `REPLAY_JOB_ID`) with neutral
  defaults. Vault path uses `GATEWAY_SECRET_DIR` or the same portable default.
- No `<private-workspace>`, `<private-home>`, `<private-store>` literal remains in these three files.
  `tests/real-gh-replay.test.js` keeps a deliberately nonexistent
  `GATEWAY_SECRET_DIR` as a negative-path fixture (false positive in the audit).

## 4. CI fixture guards (F-09)

Lead-authorized addition: `scripts/eval-search.mjs` and
`scripts/audit-tools.mjs` may be modified, limited to fixture guards.

- `eval-search.mjs`: checks the tasks file and `data/tool-dataset.json` before
  reading; on absence prints `SKIP: … private eval fixture excluded from OSS
  export` and exits 0. No measurement line is printed on SKIP.
- `audit-tools.mjs`: checks the `--snapshot` path in `main()`; on absence prints
  the same explicit SKIP reason plus a local-capture hint and returns without
  setting a failure exit code.
- `tests/oss-private-fixture-skip.test.js` forces the absent-fixture condition
  with explicit CLI arguments and asserts exit 0, an explicit `SKIP:` line, the
  reason text, and the absence of measurement output.

`check-task-coverage.mjs` (CI step, reads `explore/figma-tasks.json`) was not in
the authorized write set; public CI owner must confirm its fixture is exported
or add an equivalent guard. `measure-context.mjs` and the two previously gated
tests already SKIP correctly per the audit.

## 5. Documentation (F-06/F-08/F-10)

- `PUBLIC-SAFETY-AUDIT.md`: added §5 fix status for F-03–F-10.
- `RELEASE-LOCAL.md`: identity blocker marked decided; P0 section (owned by the
  neutralizer agent) left intact; added F-09 note and updated checklist.
- Findings that live in out-of-scope files remain open, explicitly listed in §5
  of the audit report: README "issue #3" and dangling links, `docs/eval/*`
  internal paths/capture ids/R2 bucket, CHANGELOG G6/daily-workflow claims,
  AGENTS.md link, and `/healthz` vs Docker healthcheck wording.

## 6. Verification evidence

Local private checkout (fixtures present):

```
node --test tests/export-oss.test.js tests/gh-feedback-fixes.test.js \
  tests/online-feedback.test.js tests/online-gap-regression.test.js \
  tests/project-llm-labeler.test.js tests/project-tag.test.js \
  tests/real-gh-replay.test.js tests/oss-private-fixture-skip.test.js \
  tests/online-semionline-join.test.js
# 147 tests / 141 pass / 0 fail / 6 todo

node --test tests/real-gh-replay.test.js tests/export-oss.test.js
# 25 tests / 25 pass / 0 fail

node --test tests/oss-private-fixture-skip.test.js
# 2 tests / 2 pass / 0 fail

node --check <each changed script>  # all exit 0
```

`npm test` (full suite) still reports failures owned by other concurrent agents:
`normalizeFileResult` / unwrap regressions in `src/result-normalize.js` and
`src/codemode.js` (F1/F3/F4/F5/F6/SEC cases in `tests/gpt-online-fix.test.js`,
`tests/result-normalize.test.js`, and related files). Those failures reproduce
with neutral fixture values and are unrelated to identity cleanup. The
blocker-fix batch does not write to `src/`.

No commit/push/tag/deploy was performed.
