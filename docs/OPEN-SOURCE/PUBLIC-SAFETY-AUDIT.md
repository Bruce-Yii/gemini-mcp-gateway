# Public safety audit — OSS staging / local release repo (independent review)

**Date:** 2026-11-23
**Scope (read-only):** `work/oss-release-staging/` (263 non-`node_modules` files),
`work/oss-release-repo/` (local git repo, 263 tracked files, single commit
`f710346ac07d728ccf07948cd83abfea7e6f1581`, branch `main`, no remotes, clean
tree), and `docs/OPEN-SOURCE/RELEASE-LOCAL.md`.
**Actions taken:** inspection only. No source, script, test, workflow, README,
other docs, commit, push, tag, or deploy was performed. No remote configured.
This document is the only file added.

## 0. Executive summary

| # | Finding | Severity |
|---|---|---|
| F-01 | Personal GitHub handle survives in Unicode-escaped form `<private-handle>` in 63 locations in 11 files, including `package.json` metadata and test/script fixtures | **P0 — publication blocker** |
| F-02 | The export detector's own regex cannot match the escaped form present in the tree (verified: its pattern matches the hyphenated literal, not the escaped text) — `--check` passing is a false negative | **P0 — gate is broken** |
| F-03 | String-concatenation evasions (`<concatenated-private-handle>`) in a shipped test survive any literal-handle detector | **P1** |
| F-04 | Escaped + literal internal paths: `<private-workspace>\dsh工作区\...`, `<private-workspace>\<private-home>\<private-store>\...`, `C:\work\local-home/...` in scripts, bench artifact and docs | **P1** |
| F-05 | Real PR data (DB ids, node_ids, job id) and the internal repo name `<private-project>` in shipped docs/fixtures; URL owner neutralized to `example-org` but values remain | **P1** |
| F-06 | Shipped docs expose internal-asset names: `docs/ledger/`, `docs/HANDOFF*`, `docs/PLAN-2026-11-23.md`, `work/...`, R2 bucket `<private-r2-bucket>` | **P1** |
| F-07 | `package.json` name/URLs still `gemini-mcp-gateway` while README/LICENSE/docs use `example-org` / recommend `codemode-mcp-gateway` — identity inconsistent, not finalized | **P1** |
| F-08 | ~22 dangling documentation links, including 6 where the target is explicitly internal/private (`CREDENTIALS.md`, `AUTH-READY.md`, `HANDOFF.md`, `PLAN-2026-11-23.md`, `WORKFLOW.md`, `ONLINE-EVAL-GPT-CHARTER.md`); README references private "issue #3" | **P1** |
| F-09 | `eval-search.mjs` (run unconditionally by CI) reads excluded private fixtures with no guard; dry-run already records it as ENOENT. Public CI will fail | **P1 — CI red on first push** |
| F-10 | Stale/overstated capability claims in shipped docs (e.g. "G6 ❌ until fixed" in CHANGELOG vs matrix `pass (offline)`, "daily workflow commits scorecard" while that workflow is excluded; "AGENTS.md" referenced as public file) | **P2** |
| F-11 | No real credentials found: all token/key strings are env-var names, placeholders or fixtures. Emails are `@example.com`/test URLs. No Vercel project id or Upstash REST URL present | **False positive / pass** |

**Verdict: DO NOT PUBLISH.** F-01/F-02 are hard blockers. The local repo is
byte-identical to staging (verified: 0 differing files), so fixing staging alone
is insufficient — the release repo must be re-exported and re-committed by the
release owner (this audit does not modify it).

## 1. Method and coverage

- Enumerated 263 non-`node_modules` files in staging and 263 `git ls-files`
  entries in the repo; pairwise hash comparison → **0 differences**.
- Content scans with literal, Unicode-escaped (`\u002d`, `\u0031`, `\u0073`),
  URL-encoded (`%2d`), concatenated and plain-text variants of the personal
  handle; credential token patterns (`sk-`, `ghp_`, `github_pat_`, `AIza`,
  `xox*`, 20+ char secret assignments); emails; `vercel.app`/`onrender.com`/
  `railway.app`/`netlify.app` domains; `C:\`, `D:\`, `<private-home>`, `<private-store>`,
  `local-home`; internal asset names; doc-link resolution.
- Verified detector semantics by applying its regex to the shipped literal text.
- No network calls, no git writes, no test execution that writes artifacts.

## 2. Detailed findings (path / line / risk / fix)

### F-01 (P0) Personal handle in escaped form — 63 hits / 11 files

Exact counts by file (line numbers complete):

| File | Lines | Count |
|---|---|---|
| `package.json` | 10, 12, 14 | 3 |
| `scripts/export-oss.mjs` | 132 | 1 |
| `scripts/real-gh-replay.mjs` | 7, 31 | 2 |
| `scripts/replay-write.mjs` | 24 | 1 |
| `src/result-normalize.js` | 179 | 1 |
| `tests/gpt-online-fix.test.js` | 157, 169, 229, 236, 260 | 5 |
| `tests/online-feedback.test.js` | 27, 91, 130 | 3 |
| `tests/project-llm-labeler.test.js` | 65, 66, 68, 69, 103, 109, 110, 213, 220, 228, 229, 404 | 12 |
| `tests/project-tag.test.js` | 9, 10, 46, 57, 81, 83, 93, 100, 107, 111, 123, 124, 129, 130, 141, 146, 158, 161, 162, 163, 180, 181, 195, 200, 202, 210, 212, 216, 261, 267, 315, 323, 325 | 33 |
| `tests/real-gh-replay.test.js` | 48, 130 | 2 |

Evidence (literal file text):
- `package.json:10` `"url": "git+https://github.com/<private-handle>/gemini-mcp-gateway.git"`
- `package.json:12` `"homepage": "https://github.com/<private-handle>/gemini-mcp-gateway#readme"`
- `package.json:14` `"url": "https://github.com/<private-handle>/gemini-mcp-gateway/issues"`
- `scripts/real-gh-replay.mjs:31` `const OWNER = '<private-handle>';`
- `scripts/replay-write.mjs:24` `const owner = process.env.REPLAY_OWNER || '<private-handle>';`
- `src/result-normalize.js:179` comment: ``The online raw shape was `repo://<private-handle>/<repo>/contents/<path>`…``
- `scripts/export-oss.mjs:132` detector source embeds the handle as its own pattern string.

**Why it matters:** the escaped form renders as an ordinary personal handle when
JSON/JS string literals are parsed or displayed by tooling; `package.json` alone
would publish the handle in npm/GitHub metadata. It also reveals that the
neutralization step was cosmetic (escape the hyphen) rather than substitute a
neutral identity.

**Executable fix (release owner, in private source → re-export → re-gate → new commit):**
1. Replace all 63 occurrences with a neutral literal, e.g. `example-org` (use one
   canonical placeholder everywhere; do not invent a real-looking owner).
2. In `package.json`, set `name`/`repository`/`homepage`/`bugs` consistently to
   the chosen public owner/repo (decide `codemode-mcp-gateway` vs current name —
   F-07).
3. Replace fixtures in `tests/*` and `scripts/*` with `example-org/example-repo`
   and `example-org/<private-project>`→`example-org/example-project`; keep the
   *shape* of fixtures (owner/repo/key structure) so tests still exercise the
   parsing logic. Update `src/result-normalize.js:179` comment to `repo://example-org/<repo>/...`.
4. Remove the handle from `scripts/export-oss.mjs` detector source entirely:
   build the pattern from neutral parts at runtime if the check must stay, e.g.
   derive it from an env-provided denylist in the private release tooling, not
   from a string committed to the public tree. A public detector that names the
   private handle is itself a disclosure.

### F-02 (P0) Detector blind spot makes `--check` a false negative

`scripts/export-oss.mjs:132`:

```js
{ id: 'personal-handle', re: /<private-handle>/i, note: 'default personal GitHub handle / author name' },
```

In a JavaScript regex literal `\u002d` is interpreted as the **hyphen character**,
so the pattern matches the plain hyphenated handle but not the shipped escaped
text `<private-handle>`. Verified against the actual file text:
`contains(escaped literal) = true`, `regex.IsMatch(escaped literal) = false`,
`regex.IsMatch(plain hyphenated handle) = true`. The same
blindness affects the other detectors at lines 133–135 (`<private-workspace>`,
`<private-home>`, `\<private-store>`) — they only match unescaped paths, while the
shipped scripts contain the escaped ones (F-04).

**Executable fix:**
1. Make `SENSITIVE_PATTERNS` escape-aware before matching: for each text line,
   generate a decoded candidate set (decode `\uXXXX` sequences and `%XX` with a
   bounded loop) and run both raw and decoded patterns against it. Add detector
   cases for `<private-handle-prefix>` + any separator encoding (`[-_]` or `\\u002d|%2d` etc.).
2. Add a unit test (in the private tooling) that feeds the exact string
   `<private-handle>` and asserts a hard failure; add an integration assertion that
   `--check` fails on a fixture containing the escaped form. RELEASE-LOCAL.md §5
   already lists this; treat it as a release gate, not a note.
3. Re-run `node scripts/export-oss.mjs --out <staging> --check` after the fix and
   require **0 hits over raw + decoded text**; record the command output in the
   release notes.

### F-03 (P1) Concatenation evasions in test source

`tests/export-oss.test.js:177,208,306` build the handle at runtime as
`<concatenated-private-handle>` (including embedding it into generated fixture content
`"const who = ..."` and `"maintained by ..."`). No literal-handle grep finds
these; the detector cannot either because it scans file content, not computed
values.

**Fix:** replace with `example-org` literal. Add a review rule: test fixtures
must not reconstruct identity strings via concatenation. (Note these lines are
*test code that writes temp fixtures*, which is legitimate testing technique —
the problem is the specific identity value, not the concatenation pattern; see
False Positives.)

### F-04 (P1) Internal/absolute paths, some escape-encoded

| File:line | Value | Risk |
|---|---|---|
| `bench/results.json:4` | `"tasksFile": "<private-workspace>\\dsh工作区\\projects\\gemini-mcp-gateway\\bench\\tasks.json"` | Real personal workspace path in a committed benchmark artifact |
| `scripts/real-gh-replay.mjs:19,44` | `<private-workspace>\<private-home>\<private-store>\gemini-mcp-gateway`, `path.join('<private-workspace>\\<private-home>', '<private-store>', ...)` | Personal vault location (escaped, so detector misses it); script defaults to it at runtime |
| `scripts/figma-token.mjs:18,31` | same vault path; `resolve(home, '<private-store>', 'gemini-mcp-gateway')` | Same |
| `docs/eval/AUTH-PROVIDERS.md:194` | `C:\work\local-home/.config/gemini-mcp-gateway` | Internal credential-store location described as fact |
| `docs/eval/PLATFORM-CONFORMANCE-MATRIX.md:209` | same path plus `AGENTS.md` rule citation | Internal path + internal doc name |
| `docs/eval/REAL-GH-REPLAY.md:5` | same path + `github-auth.json` | Internal path |
| `docs/OPEN-SOURCE/DEPLOYMENT-TEMPLATES.md:127` | same path | Internal path |
| `docs/OPEN-SOURCE/EXPORT-IMPLEMENTATION.md` | describes `C:\work`, `local-home/`, `.config/` as neutralized categories (fine as a description, but see below) | Informational |
| `tests/real-gh-replay.test.js:130` | `GATEWAY_SECRET_DIR: 'D:\\__no_such_vault_dir__\\real-gh-replay-test'` | False positive — deliberately nonexistent test path |

**Fix:** regenerate `bench/results.json` with a relative `tasksFile` (`bench/tasks.json`);
in both scripts replace the hardcoded vault default with a generic config
(`process.env.GATEWAY_SECRET_DIR` only; if unset, resolve to
`~/.config/gemini-mcp-gateway` or document that the env var is required). In docs
replace the concrete path with `<your-local-credential-store>`. Keep the
description in `EXPORT-IMPLEMENTATION.md` (it names categories, not a live path)
but verify no decoder-visible literal survives.

### F-05 (P1) Real PR/Actions data and internal project name

- `docs/eval/REAL-GH-REPLAY.md:35-52`: PR numbers 53/56/57/59 with real numeric
  DB ids `<real-db-id>`, `<real-db-id>`, `<real-db-id>`, `<real-db-id>`, real node_ids
  `<real-node-id>` etc., and Actions job id `<real-job-id>`. URL owner is
  neutralized to `example-org`, but the values themselves are real identifiers.
- `scripts/real-gh-replay.mjs:33-35`: `WANTED_PR_NUMBERS = [53,56,57,59]`,
  `EXACT_PR_NUMBER = 53`, `JOB_ID = <real-job-id>`.
- `docs/eval/online-offline-join-2026-11-22.md:4,34,65,80`: R2 bucket
  `<private-r2-bucket>`, full capture prefixes, request id
  `<real-request-id>`, and the internal repo name
  `<private-project>` in captured code.
- `<private-project>` appears 47 times across docs/tests/scripts (e.g.
  `tests/project-tag.test.js:9,25,77`, `tests/project-llm-labeler.test.js:65-69`,
  `tests/real-gh-replay.test.js:48,130`).

**Fix:** replace numeric ids/node_ids/job id with clearly synthetic values
(e.g. `1000000001`, `PR_kwDOEXAMPLE000000000`, `999999999999`); replace the
bucket name with `<your-r2-bucket>`; replace `<private-project>` with
`example-project` everywhere; keep the PR-number/id *distinction* tests intact.
If any real session evidence must be cited, describe it without copyable
identifiers (e.g. "a private PR with a long DB id").

### F-06 (P1) Internal asset names in shipped docs

Examples:
- `CHANGELOG.md`, `docs/SANDBOX-SECURITY.md`, `docs/eval/ONLINE-FEEDBACK.md`:
  `docs/ledger/batch-*.md` references (ledger is explicitly excluded from export).
- `docs/OPEN-SOURCE/EXPORT-VERIFICATION.md:39,41`:
  `docs/HANDOFF-2026-11-23.md`, `docs/HANDOFF.md`, `docs/PLAN-2026-11-23.md`
  appear verbatim in DENIED output.
- `docs/OPEN-SOURCE/WEB-CLIENTS.md`: links to `../PLAN-2026-11-23.md`.
- `README.md:263-265`: repository-layout table lists `data/`, `explore/`,
  `work/capture` as if shipped, though they are excluded.
- `docs/eval/ONLINE-FEEDBACK.md`, `docs/OBSERVABILITY-AND-EVAL.md`: `work/...`
  paths and "main repo" capture/scorecard workflow descriptions.

**Fix:** in export-facing docs, replace internal paths with neutral descriptions
(`<private-ledger>`, `<private-plan>`), or remove the DENIED-listing examples
from the public `EXPORT-VERIFICATION.md`. Update the README layout table to list
only paths that exist in the public repo. Keep a private copy of the detailed
verification log.

### F-07 (P1) Unfinalized identity / metadata mismatch

- `package.json:2` name `gemini-mcp-gateway`; repository/homepage/bugs use escaped
  personal handle (F-01).
- `README.md:3,127-128` and `README.zh-CN.md:107-108` use `example-org/gemini-mcp-gateway`.
- `LICENSE:3` `Copyright (c) 2026 example-org`.
- `docs/OPEN-SOURCE/README.md:16` and `PLAN.md:13` recommend `codemode-mcp-gateway`.
- Badge URLs point at `example-org/...` (dead links after publication).

**Fix:** choose one owner/name before export; apply to `package.json`,
`package-lock.json` (root `name` fields at lines 2 and 8), README badges and
clone URLs (both languages), LICENSE copyright, and `docker-compose.yml:10`
image tag if desired. Decide whether `name` becomes `codemode-mcp-gateway`; do
not leave `example-org` in a published badge.

### F-08 (P1) Dangling documentation links (~22)

Missing targets referenced from shipped docs include:
`docs/ADOPTION-RANKINGS.md`, `docs/BACKLOG-GEMINI-SUGGESTIONS.md`,
`docs/CLIENTS-CHATGPT.md`, `docs/CODEMODE-SURVEY.md`, `docs/COMPETITORS.md`,
`docs/CREDENTIALS.md` (×4, including `README.md:185,189,204`),
`docs/DSH-CODEMODE-FIT.md`, `docs/EXECUTION-PLAN.md`,
`docs/GEMINI-OFFICIAL-DOCS.md`, `docs/GEMINI-PROBE.md`,
`docs/grok-connector-report.md`, `docs/HANDOFF-2026-11-23.md`,
`docs/HANDOFF.md`, `docs/PLAN-2026-11-23.md`, `docs/mcp.md`,
`docs/ONLINE-EVAL-GPT-CHARTER.md`, `docs/overview.md`,
`docs/UNNEEDED-TOOLS.md`, `docs/WORKFLOW.md`. Additionally `README.md:272` and
`docs/OPEN-SOURCE/PLAN.md:45` contain a literal `\n-` inside a Markdown list
(rendering bug).

**Fix:** for each link, either include the target in the export allowlist (after
public-safety review) or remove/rewrite the link to an existing public doc.
Highest priority: `docs/CREDENTIALS.md` (4 links from README) — replace with a
short public `docs/CREDENTIALS.md` containing only public token-acquisition
links, or change the text to "obtain a PAT from your provider". Remove the
"issue #3" reference from README:272. Fix the `\n-` formatting in both files.

### F-09 (P1) Public CI will fail on missing private fixtures

`.github/workflows/ci.yml:39-40` runs `node scripts/eval-search.mjs`, which at
`scripts/eval-search.mjs:34-38` unconditionally reads
`explore/tasks-v2.json` and `data/tool-dataset.json` — both excluded from the
export and absent from the 263 files. `RELEASE-DRYRUN.md:46` already records
`measure-context.mjs` ENOENT; `RELEASE-DRYRUN.md:79-80` records two tests that
were later gated. Current status:
- `scripts/measure-context.mjs:28-32` correctly SKIPs (expected).
- `tests/l1-failed-server.test.js:19-25` and `tests/online-gap-tasks.test.js:26-29`
  are `existsSync`-gated (fixed), so `npm test` should not fail for those.
- `eval-search.mjs` has **no guard** → first public CI run will be red.
- `scripts/audit-tools.mjs:38` reads `data/tool-snapshots/<server>.json` and CI
  runs it with `--server figma` (ci.yml:31); that snapshot is absent too.

**Fix:** add `existsSync` guards with a clear `SKIP: private eval fixture
excluded from OSS export` message to `eval-search.mjs` and `audit-tools.mjs`
(or remove those steps from the public CI workflow). Add a test asserting both
scripts exit 0 with the fixtures absent. Re-run the exact CI job list in a clean
clone before pushing.

### F-10 (P2) Capability claims that are stale or overstated

- `CHANGELOG.md` says the daily workflow "commits scorecard and keeps raw
  analyzer artifacts", but `.github/workflows/capture-daily.yml` is explicitly
  excluded (`scripts/export-oss.mjs:113`) and `docs/eval/scorecard-*` files are
  absent. Readers cannot reproduce this loop from the public repo.
- `docs/OBSERVABILITY-AND-EVAL.md` marks P3 "daily workflow 已实现" and scorecard
  flow as available; same problem.
- `CHANGELOG.md` says "G6 remains ❌ until fixed and retested" while
  `docs/eval/PLATFORM-CONFORMANCE-MATRIX.md:346,260` shows G6 `pass (offline)`
  and an unchecked wire-verification item. Pick one consistent status.
- `README.md:79,243` links `[AGENTS.md](AGENTS.md)` as a public file; AGENTS.md
  is excluded from export (broken link + exposes an internal policy name).
- `README.md:215-218` says "`/healthz` exists only in the Vercel entry", while
  `docs/OPEN-SOURCE/DOCKER-VERIFICATION.md` describes a Docker healthcheck;
  RELEASE-LOCAL.md §4.6 says Docker healthcheck was not re-verified. Verify and
  state one truth.
- `README.md:91` "Gemini web custom apps **Tested**" is appropriately scoped but
  should be dated/qualified by client version since the underlying session
  protocol is pinned (see `docs/OPEN-SOURCE/WEB-CLIENTS.md`).

These are honesty/maintenance issues, not credential leaks; fix by aligning
public docs with what is actually shipped, or by shipping the referenced
artifacts after review.

### F-11 (Pass / false positives) Credentials, emails, domains

- No real secrets found. All `*_KEY`, `*_TOKEN`, `CLIENT_SECRET` occurrences are
  environment-variable names, `tokenEnv` fields, placeholder values, or detector
  regex source. `config.example.json:5` explicitly says "PLACEHOLDERS ONLY".
- No `sk-...`, `ghp_...`, `github_pat_...`, `AIza...`, `xox...` credential-shaped
  strings; no 20+ char literal secret assignments.
- Emails found: `u@example.com` (`tests/capture.test.js`), `@chatgpt.com` /
  `@claude.ai` in URL-parsing test inputs — all synthetic.
- No Vercel project id, no Upstash REST URL (`KV_REST_API_URL` is only an env var
  name); `*.vercel.app` hits are placeholder text and a test fixture
  (`tests/export-oss.test.js:179`), not a live hostname.
- `package-lock.json` "yii"/"<private-handle-prefix>" substring hits are npm integrity hashes
  (`...Yyii07tpPsLw==`) and unrelated third-party metadata — not the handle.
- `tests/real-gh-replay.test.js:130` uses a deliberately nonexistent vault path —
  negative-path test, not a leak.
- `tests/export-oss.test.js` concatenation hits (F-03) are a legitimate detector
  testing technique; only the chosen identity value is a problem.
- Git facts: single commit with neutral author `OSS Release Bot
  <oss-release@example.com>`, no remotes, clean tree — no private history leaked
  into the local repo.

## 3. False-positive and limitation notes

1. Glob of staging included `node_modules` (4,401 extra paths); all findings were
   re-derived from the 263 non-`node_modules` files, confirmed identical to the
   263 tracked repo files. Third-party license/package files in `node_modules`
   are not part of the release artifact.
2. My earlier broad regex passes over `\u0042ruce`-style patterns produced
   inflated counts because of shell escaping; the authoritative count is the
   exact-string scan in F-01 (63 hits, 11 files), reproduced per file/line.
3. No URL-encoded (`%2d`) handle variant was found. No personal email was found.
   These checks are reported as clean, not omitted.
4. This audit is content/policy inspection. It did not run `npm test`,
   `audit-truncation --ci`, or a clean-clone CI job (would create artifacts /
   modify the tree). CI failure in F-09 is inferred from unconditional file
   reads plus documented ENOENT, not from executing CI.
5. Severity is "risk if published", not "current exploitability". The local repo
   has no remote; nothing has been exposed yet.

## 4. Release gate checklist (all boxes must be checked by a human)

- [ ] Choose public owner + repo name; apply consistently to `package.json`,
      `package-lock.json`, README(s), LICENSE, badges, Docker image tag (F-07).
- [ ] Remove all 63 escaped-handle occurrences; verify with an escape-aware scan
      over raw **and decoded** text (F-01), including concatenated test values (F-03).
- [ ] Fix `SENSITIVE_PATTERNS` in `scripts/export-oss.mjs` (or move the detector
      to private tooling) and add a regression test that the escaped form fails
      `--check` (F-02). Remove the handle from detector source itself.
- [ ] Replace personal/absolute paths in `bench/results.json`, scripts, docs;
      make vault location env-driven with a generic default (F-04).
- [ ] Neutralize real PR ids/node_ids/job id/bucket name and `<private-project>`
      in docs/tests/scripts (F-05).
- [ ] Scrub internal asset names (`ledger`, `HANDOFF`, `PLAN-2026-11-23`,
      `work/...`) from public docs; update README layout table (F-06).
- [ ] Fix all dangling doc links; add or rewrite `docs/CREDENTIALS.md`; remove
      "issue #3" and fix literal `\n-` formatting (F-08).
- [ ] Guard or remove `eval-search.mjs` and `audit-tools.mjs` CI steps for absent
      private fixtures; run the full CI job list in a clean clone and require green (F-09).
- [ ] Align capability claims (daily scorecard workflow, G6 status, AGENTS.md
      link, `/healthz` vs Docker healthcheck) with what is actually shipped (F-10).
- [ ] Re-export from neutralized private source into a **new** staging snapshot,
      re-run: `npm ci && npm test`, `audit-truncation --ci`, `check-config`,
      `export-oss --check` (0 raw + decoded hits), `measure-context` (SKIP ok),
      `eval-search` (SKIP ok), Docker compose healthcheck + `/mcp` reachability,
      Node 20/22/24 matrix.
- [ ] Make a fresh commit in `work/oss-release-repo` (or a new local repo) from
      that snapshot; keep `OSS Release Bot <oss-release@example.com>` as the
      local identity; keep no remotes.
- [ ] Only after every box above: human creates the remote, pushes `main`, and
      tags `v0.1.0` / `v0.1.0-alpha.1` with honest release notes (Gemini tested;
      Claude target; ChatGPT documented-not-promised). Keep the private repo private.

**This audit added only this file. No commit, push, tag, deploy, or code change
was performed by the auditor.** The fix-status section below was added later by
the OSS blocker-fix batch; it records remediation performed in the private
source checkout (no commit/push/deploy).

## 5. Fix status — P1/P2 blocker batch (2026-11-23)

Scope of the remediation batch: `package.json`, `bench/results.json`,
`scripts/figma-token.mjs`, `scripts/real-gh-replay.mjs`,
`tests/*.test.js`, this report, `RELEASE-LOCAL.md`, and the new ledger
`docs/ledger/batch-15-oss-blockers.md`. The release owner separately owns
`scripts/export-oss.mjs` / `scripts/prepare-neutral-source.mjs` (P0 neutralizer),
README, LICENSE, package-lock, workflows, and the rest of `docs/`.

| Finding | Status | Evidence / remaining work |
|---|---|---|
| **F-03** concatenation evasions in tests | **FIXED (in-scope files)** | `tests/export-oss.test.js` no longer reconstructs the personal handle; its detector fixtures now use synthetic domain/secret values assembled at runtime. All other `tests/*.test.js` handle fixtures were replaced with `test-org` / `test-repo`. Literal handle and escaped/concatenated forms: 0 hits in `tests/`. Caveat: the digest-pinned `personal-handle` detector in `scripts/export-oss.mjs` can no longer be exercised from a neutral public fixture; that coverage now belongs to private release tooling. |
| **F-04** absolute/internal paths | **FIXED (in-scope files)** | `bench/results.json:4` now `bench/tasks.json`. `scripts/figma-token.mjs` and `scripts/real-gh-replay.mjs` derive the vault location from `GATEWAY_SECRET_DIR` or a portable per-user default (`~/.config/codemode-mcp-gateway`); no `<private-workspace>\...` / `<private-home>` / `<private-store>` literal remains in either file. `GATEWAY_SECRET_DIR` in `tests/real-gh-replay.test.js` is a deliberately nonexistent negative-path fixture. Doc path literals in `docs/eval/*` are outside this batch's write scope — **owner follow-up**. |
| **F-05** real PR/Actions data, internal repo name | **FIXED (in-scope files)** | `scripts/real-gh-replay.mjs` now uses env-driven neutral defaults (`test-org`, `test-repo`, PRs `1,2,3,4`, `JOB_ID=999999999999`, synthetic node id shape) and vault resolution from env. Tests use synthetic DB ids `1000000001`–`1000000004` and `PR_kwDOEXAMPLE001`; `<private-project>` is gone from `tests/`. Capture-id / R2 bucket / internal repo name in `docs/eval/online-offline-join-2026-11-22.md` are **out of scope** — owner follow-up. |
| **F-06** internal asset names in shipped docs | **PARTIAL** | `RELEASE-LOCAL.md` no longer reproduces the escaped handle and now points to this ledger instead of embedding the full private path investigation; it still describes the local release repo path names as part of the release procedure (owner must scrub before export). `README.md`, `docs/eval/*`, `EXPORT-VERIFICATION.md` are outside this batch — **open**. |
| **F-07** identity inconsistent | **FIXED in package.json; owner follow-up elsewhere** | `package.json` is now `name: codemode-mcp-gateway`, `author: example-org`, with repository/homepage/bugs at `example-org/codemode-mcp-gateway`. Decision recorded: adopt the `codemode-mcp-gateway` name recommended by the public plan docs. `package-lock.json` root `name`, LICENSE, README badges/clone URLs and Docker image tag are outside this batch — **open**. |
| **F-08** dangling doc links / "issue #3" | **OPEN (out of scope)** | All 22 links, the private `docs/CREDENTIALS.md` / `HANDOFF` / `PLAN` references, "issue #3", and the literal `\n-` rendering bug live in README and docs outside this batch's write list. No silent pass: recorded here and in `batch-15-oss-blockers.md` as release-owner work. |
| **F-09** CI red on missing private fixtures | **FIXED** | `scripts/eval-search.mjs` and `scripts/audit-tools.mjs` now `existsSync`-guard their private fixtures and print `SKIP: … private eval fixture excluded from OSS export` with a reason, exiting 0. `tests/oss-private-fixture-skip.test.js` asserts exit 0 plus an explicit SKIP reason and forbids measurement output under SKIP. `measure-context.mjs` and the two previously gated tests were already correct. `check-task-coverage.mjs` also reads `explore/figma-tasks.json`; lead authorization covered only the two scripts above, so that step remains an **owner follow-up** for public CI. |
| **F-10** stale capability claims | **OPEN (out of scope)** | Findings are in CHANGELOG, `docs/OBSERVABILITY-AND-EVAL.md`, README (AGENTS.md link, `/healthz` wording, Gemini-test dating). Not changed by this batch; recorded as owner work. `RELEASE-LOCAL.md` now states the Docker/healthz and Node matrix were not re-verified. |

No commit, push, tag, or deploy was performed by this batch. In-scope fixture
tests are green (147 tests / 0 fail); the full `npm test` still has failures
from concurrent, out-of-scope `src/result-normalize.js` / `src/codemode.js`
normalize/unwrap regressions. Details and verification evidence are recorded in
`docs/ledger/batch-15-oss-blockers.md`.
