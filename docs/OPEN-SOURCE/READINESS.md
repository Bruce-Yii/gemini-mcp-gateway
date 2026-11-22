# Open-Source Readiness Audit

Audit date: 2026-11-23. Scope: repository state as checked out locally (git HEAD `00b62bf`, branch `main`, 195 commits, 249 tracked files). This document is **audit-only**: no source files, configuration, or git state were changed, and nothing was committed, pushed, or deployed.

Priorities: **P0 = must fix before making the repo public** (privacy / accidental-disclosure / broken first-run); **P1 = fix soon after (onboarding / consistency / maintainability)**; **P2 = optional polish**.

Evidence format: `file:line` refers to the current checked-out file. "Tracked" means present in `git ls-files` and therefore part of a public push unless explicitly removed.

---

## 0. Verdict

The code itself has no embedded live secrets: a scan of every git blob in all 195 commits found no `ghp_`/`gho_`/`github_pat_`/`sk-`/`ya29.`/private-key strings, and `config.example.json` uses `tokenEnv` placeholders only. Reproducibility is good (`npm ci` dry-run succeeds, 642 tests pass, CI covers Node 20/22/24).

The blockers are **not code secrets but personal/environment residue in tracked docs and fixtures**: a real Vercel domain in a tracked handoff note, a personal home-directory vault path in multiple tracked files, a personal GitHub username in package metadata/READMEs/datasets/exploration fixtures, a git remote pinned to a personal account, and a scheduled workflow that commits generated eval data to the repo. These must be cleaned or converted to placeholders before publication. Naming (`gemini-mcp-gateway`) and the single-user strategy are coherent but should be stated explicitly in the release notes.

---

## 1. P0 — must fix before publishing

### P0-1. Real production deployment URL in a tracked handoff document
- **Evidence:** `docs/HANDOFF-2026-11-23.md:79` (tracked): `curl -s https://gemini-mcp-gateway.vercel.app/healthz`. Also `docs/ledger/batch-4-figma.md:90` (tracked): `https://gemini-mcp-gateway-f7hyjkzcj-yu-ac3a.vercel.app` with status `READY`, timestamp, and at line 92 the model's identity response `Yi Yu / plan "Yi Yu's team" (starter, admin) / seat View`. `AGENTS.md:17` (tracked) states the stable domain was `<your-domain>` — i.e. this was later replaced with a real host in tracked notes.
- **Impact:** Publicizes a live single-user deployment endpoint and account/plan details. The endpoint is behind OAuth, but exposing a real host invites unsolicited traffic and fingerprinting; it also reveals the owner's identity. Directly contradicts `SECURITY.md:23-27` ("deployment is you", "do not share").
- **Action:** Replace both hostnames with `https://<your-domain>` (or `https://<your-app>.vercel.app`) and replace the Figma `whoami` identity with a generic example. Add `.gitignore` entry for `docs/HANDOFF-*.md` if dated snapshots should stay private, or delete this file from the public tree. `docs/HANDOFF.md` is already ignored (`.gitignore:16`), but the dated copy is not.

### P0-2. Personal vault/absolute local paths in tracked documentation and a tracked script header
- **Evidence:** `docs/CREDENTIALS.md:15` (tracked): `D:\12412\dsh-home\.secrets\gemini-mcp-gateway`; `docs/ledger/batch-4-figma.md:25` (tracked): `D:\12412\dsh-home\.secrets\gemini-mcp-gateway\figma-oauth.json`; `scripts/figma-token.mjs:18` (tracked): same absolute path in the usage comment; `AGENTS.md:18` (tracked): same path plus `%APPDATA%\com.vercel.cli\Data\auth.json`. The implementation itself is portable (`scripts/figma-token.mjs:28-32`: `GATEWAY_SECRET_DIR`, else `$DSH_HOME`/`$USERPROFILE` + `.secrets/gemini-mcp-gateway`), so only the documented default is machine-specific.
- **Impact:** Leaks the owner's Windows username/directory layout; confuses strangers who copy-paste the path (it does not exist on their machine). The `AGENTS.md` instructions are also project-specific agent policy that will be published verbatim.
- **Action:** Change all path examples to `<your-secret-dir>` / `~/.secrets/gemini-mcp-gateway` (and `GATEWAY_SECRET_DIR` env var), e.g. `docs/CREDENTIALS.md:15`, `docs/ledger/batch-4-figma.md:25`, `scripts/figma-token.mjs:18`. Decide whether `AGENTS.md` (project-local agent rules, including the "don't ask for tokens" policy tied to the private vault) belongs in the public repo; if not, add it to `.gitignore` (it is currently tracked, `git ls-files AGENTS.md` returns it).

### P0-3. Personal GitHub identity baked into package metadata, READMEs, and git remote
- **Evidence:** `package.json:10,12,14` — `repository.url`, `homepage`, `bugs.url` all `github.com/Bruce-Yii/gemini-mcp-gateway`; `README.md:3` (CI badge) and `:98` (clone URL), `README.zh-CN.md:77` (clone URL); `LICENSE:3` — `Copyright (c) 2026 Bruce-Yii`; `git remote -v` → `https://github.com/Bruce-Yii/gemini-mcp-gateway.git`. Additionally `scripts/replay-write.mjs:24-25` defaults `REPLAY_OWNER`/`REPLAY_REPO` to `Bruce-Yii`/`gemini-mcp-gateway`, and tracked exploration fixtures hardcode the same repo dozens of times (`explore/build-tasks.mjs:21,27`, `explore/tasks.json:80,122`, `explore/tasks-v2.json:12,90,190`, `explore/tasks-g6.json:11,89,189`, `explore/tasks-smoke.json:35,64`, `explore/tasks-deep.json` prompts, etc.); `docs/OBSERVABILITY-AND-EVAL.md:100` and `docs/eval/write-replay-2026-11-23.md:8` also reference it.
- **Impact:** If the public repo moves to a different owner/org, all links, badges, and the npm package's `repository` field point at the wrong place; the default write-replay script would target the original owner's repo with a real token (destructive script — see `scripts/replay-write.mjs:5-9`, requires `--yes` + `GITHUB_TOKEN` and creates/deletes a branch). Publishing under a personal account is a valid choice, but this must be a deliberate decision, not residue.
- **Action:** Decide the publishing account/org first. If it stays `Bruce-Yii`, this item is "verify, no change" except for `replay-write.mjs` defaults (use required env vars or `example-owner/example-repo`). If it moves, update all listed lines and re-point the remote. For the replay script specifically, remove personal defaults so a stranger cannot accidentally write to the original owner's repository.

### P0-4. Scheduled workflow commits generated eval artifacts into the repository
- **Evidence:** `.github/workflows/capture-daily.yml:9-10` (`permissions: contents: write`), `:45-56` (daily job copies digest scorecards into `docs/eval/` and does `git commit` + `git pull --rebase` + `git push`), `:118-125` (weekly job commits `docs/eval/weekly-*.md` and pushes), `:25-29,36-43` (reads `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_AUTH_EMAIL`, `R2_AUTH_KEY`, `ANALYZER_API_KEY` from repo secrets). Tracked outputs already exist: `docs/eval/scorecard-2026-11-22.json/.md`, `docs/eval/weekly-2026-46.md`.
- **Impact:** After publication, a cron job with write permissions will push generated content (including capture-derived statistics and model-generated candidate labels) to the public `main` branch every day. Forks could inherit the schedule; secrets are not exposed by GitHub to forks, but the workflow will fail or spam. This is an operational surprise for anyone who forks or for the owner after going public. Also, the generated scorecards are derived from **real production traffic captures** (R2), not synthetic data.
- **Action:** Decide whether these eval artifacts are intended for the public record. If yes, document that the workflow writes to `main`, restrict it to `github.repository == '<owner>/<repo>'` (or disable scheduled runs by default), and review `docs/eval/scorecard-2026-11-22.json` contents for request-level data before publishing. If no, set the workflow to `workflow_dispatch` only or remove the git-push steps. Note: `docs/eval/scorecard-2026-11-22.json:1-60` currently contains only aggregated metrics (counts, durations, bytes) — no request IDs or tokens in the sampled range — but the full file should be reviewed at publication time.

### P0-5. `.gitignore` misses several personal/local artifact classes
- **Evidence:** `.gitignore:1-18` ignores `node_modules/`, `work/`, `*.log`, `.env*`, `.vercel`, `explore/results/traces/`, `explore/results/anomalies/`, `bench/results.json`, `docs/HANDOFF.md`, `project.json`. `git check-ignore` confirms these work. **Not ignored:** `outputs/` (empty locally, but the project layout in `project.json:10` declares it), `capture.json`/`*.capture.json`, `config.local.json`, `.DS_Store` is covered but `Thumbs.db` is not, `docs/HANDOFF-*.md` (dated snapshots — one is already tracked, see P0-1), `explore/results/` subdirectories other than `traces/` and `anomalies/` (e.g. any future `explore/results/captures/`), and `test-results/`/`coverage/` if added later. `.vercelignore:1-3` covers deployment but is a different boundary.
- **Impact:** The next "add all" commit can publish local captures, outputs, or a local config containing tokens. Given that capture/sink data is flowing (`.github/workflows/capture-daily.yml`, `src/capture.js`), this is a realistic leak path.
- **Action:** Add defensive patterns before publication: `outputs/`, `captures/`, `*.capture.json`, `capture*.json` (with an allowlist for fixtures if needed), `config.local.*`, `Thumbs.db`, `docs/HANDOFF-*.md`, and `explore/results/**` with explicit exceptions for any fixtures that must be tracked. Re-run `git status --ignored` and a `git ls-files` review after the change.

---

## 2. P1 — fix soon after publication

### P1-1. Test counts disagree across documentation
- **Evidence:** `README.md:90` says "364 unit/integration tests"; `README.md:101` says `# offline: 300 tests`; `README.zh-CN.md:70,80` says 364; `CHANGELOG.md:19` says "suite now 364"; `docs/ledger/batch-4-figma.md:50` says `343/343`; `docs/HANDOFF-2026-11-23.md:13` says `623/623`. Actual run on 2026-11-23: `npm test` → **642 pass, 0 fail** (`node scripts/run-tests.mjs`, Node in workspace). `CONTRIBUTING.md:54` correctly says CI runs Node 20/22/24 but does not state the count.
- **Impact:** A newcomer cannot tell whether their checkout is healthy; stale numbers undermine trust in the docs. Counts are inflated in the handoff note because the suite grew during the session.
- **Action:** Remove absolute test counts from READMEs and CHANGELOG (say "offline test suite, no credentials"), or add a single generated badge/script output. Keep `CONTRIBUTING.md:10-19` as the authoritative setup steps.

### P1-2. Publish target, license owner, and contribution boundaries are implicit
- **Evidence:** `LICENSE:3` (MIT, "Bruce-Yii"), `package.json:7` (`"license": "MIT"`), `SECURITY.md:3-6` (pre-1.0, fixes on latest `main`, no backports), `SECURITY.md:19-43` (explicit **single-user** threat model, "not audited"), `CONTRIBUTING.md:32-49` (stable tool surface, `sanitizeTool`, no new deps, no secrets, evidence for search changes), `.github/ISSUE_TEMPLATE/feature_request.yml:28-29` (checkboxes acknowledging stable surface and single-user design). There is **no `CODE_OF_CONDUCT.md`** (verified absent at repo root).
- **Impact:** MIT is compatible with the stated single-user/self-hosted posture, but the repo gives no answer to "can I run this as a hosted multi-tenant service?" — `SECURITY.md:25-27` says no, while the code implements OAuth/DCR and KV token storage that look multi-user-capable. Contributors also have no conduct policy, which many public repos expect.
- **Action:** Add an explicit "Scope & non-goals" section to `README.md` (single-user self-hosting only; not a hosted service; no multi-tenancy; MIT license; upstream credentials remain yours), link `SECURITY.md` prominently, and add a `CODE_OF_CONDUCT.md` (Contributor Covenant or a short custom policy) plus a `FUNDING.yml` only if desired. No license change is required.

### P1-3. Project-local agent instructions and internal ledgers will be published as-is
- **Evidence:** 58 tracked files under `docs/`, including `docs/ledger/batch-*.md` (30+ files), `docs/HANDOFF-2026-11-23.md`, `docs/PLAN-2026-11-23.md`, `docs/GEMINI-PROBE.md`, `docs/BACKLOG-GEMINI-SUGGESTIONS.md`, and `AGENTS.md` (tracked). Several are internal working notes with personal names, account IDs (`yu-ac3a` in `docs/ledger/batch-4-figma.md:90`), and test data references (`docs/HANDOFF.md:166` — ignored, but the pattern shows what exists in the working set). `docs/CREDENTIALS.md:8` says "Nothing here should be committed. Put values in environment variables only" while the file itself is tracked and documents vault contents.
- **Impact:** Low security risk (no tokens found) but high noise: a stranger sees a large internal ledger full of session-specific state, and `AGENTS.md:18` instructs agents to read a private vault path that does not exist for them. It also exposes real upstream account identifiers and internal test artifact names (Linear `LAJI-36`, GitHub probe repo `mcp-probe-20261122`, etc. in the ignored `docs/HANDOFF.md:166` — verify no equivalent survived in tracked docs).
- **Action:** Split `docs/` into public (`CREDENTIALS.md`, `UPSTREAMS.md`, `CLIENTS.md`, `WHY.md`, `DEPLOY.md` at root, `CONTRACT*.md`, `SANDBOX-SECURITY.md`, curated `eval/` summaries) and internal. Move or ignore `docs/ledger/`, `docs/PLAN-*.md`, `docs/HANDOFF-*.md`, `docs/BACKLOG-*`, and `AGENTS.md`. If keeping the ledger, add a `docs/ledger/README.md` note that entries are historical internal notes, not user documentation.

### P1-4. `npm start` works without tokens, but the docs are inconsistent about what happens next
- **Evidence:** `package.json:30` → `node src/server.js --config config.example.json --port 3000`; `README.md:108-110` and `README.zh-CN.md:87-88` state upstreams with unset `tokenEnv` are skipped, so the three-tool surface can be inspected without credentials. `DEPLOY.md:27-28` says the Vercel deployment boots without env vars but `/mcp` will not work. `CONTRIBUTING.md:10-11` says the default test suite is offline and needs no credentials — verified (`npm test` → 642 pass with no tokens set in this session). `.github/workflows/ci.yml:25-46` runs `npm ci`, tests, audits, config validation, search eval, context measurement, bench dry run, build-info check on every Node version — no credentials required.
- **Impact:** Actually good. The only issue is that `docs/CREDENTIALS.md:15-30` tells readers to use a private vault that is a local convention, and `scripts/figma-token.mjs status` is mentioned in datasets but not in `CONTRIBUTING.md`; a newcomer may think real tokens are mandatory to run anything.
- **Action:** Add one sentence to `README.md` quick start: "No real upstream tokens are needed for local inspection or tests; tokens are only needed to call real upstreams." Cross-link `docs/CREDENTIALS.md` with the vault section rewritten per P0-2.

### P1-5. Example/dataset fixtures contain personal-flavored values that should be neutralized
- **Evidence:** `scripts/replay-write.mjs:24-25` personal defaults (see P0-3); `explore/build-tasks.mjs:21,27,81` and `explore/tasks*.json` use `Bruce-Yii/gemini-mcp-gateway`, `myapp.vercel.app`, `team_abc`, `dpl_123`, `user_123`; `data/tool-dataset.json:31973` and `data/tool-snapshots/vercel.json:19308` contain upstream vendor example `kyliau@example.com` (third-party schema example, not owner data — classify as documentation example, keep). `explore/tasks-deep.json:803,1136` use `maya@example.com` / `alex@example.com` (clearly synthetic).
- **Impact:** Most of these are synthetic test fixtures, not secrets. The real issue is consistency: a stranger searching the repo will find the owner's GitHub handle in 60+ places and may assume the project is a personal playground rather than a reusable gateway. The `Bruce-Yii/gemini-mcp-gateway` strings in exploration tasks are **fixture data**, not live references, but they still leak the handle.
- **Action:** Do a mechanical replacement in tracked fixtures: `Bruce-Yii/gemini-mcp-gateway` → `<owner>/<repo>` or `example-org/example-repo` in `explore/tasks*.json`, `explore/build-tasks.mjs`, `docs/OBSERVABILITY-AND-EVAL.md:100`, `docs/eval/write-replay-2026-11-23.md:8`. Keep vendor-provided examples like `kyliau@example.com`, `team_1a2b3c4d5e6f7g8h9i0j1k2l`, and `myapp.vercel.app` — they are upstream schema examples, not personal data.

---

## 3. P2 — optional polish

### P2-1. Naming: `gemini-mcp-gateway` is narrower than the project's actual scope
- **Evidence:** `README.md:7-9,88-89` and `package.json:4` describe an upstream-agnostic Code Mode gateway for "web-based MCP clients"; `README.md:37-58` shows GitHub/Notion/Linear/Vercel; `.github/ISSUE_TEMPLATE/bug_report.yml:43-50` lists Gemini, Claude, ChatGPT, Cursor/Cline, Inspector. But the package name, repo slug, homepage, docs title, and banner all say `gemini-*`, and `AGENTS.md` has Gemini-specific rules (`sanitizeTool`, tool-name `__` convention, no `structuredContent`) baked into the design narrative.
- **Impact:** Newcomers using Claude/ChatGPT/Cursor may skip the project. npm/keyword search associates it only with Gemini. Renaming now (pre-1.0, v0.1.0) is cheap; after publication it becomes a breaking URL/package rename.
- **Action (recommendation only — do not change in this audit):** Rename the public repo/npm package to something neutral such as `codemode-mcp-gateway`, `compact-mcp-gateway`, or `mcp-context-gateway`, keep `gemini` as a keyword and in the README "tested with Gemini" section, and add a redirect from the old name. If a rename is too costly, keep the name but add a first-paragraph clarification: "The name is historical; any MCP client can connect." No change was made.

### P2-2. `files` field absent from package.json
- **Evidence:** `package.json:1-52` has no `"files"` array (and no `.npmignore` at root). If published to npm, the package would include `node_modules`-excluded source, tests, docs, `config.example.json`, `data/tool-dataset.json` (3.28 MB), exploration fixtures, and potentially tracked handoff notes.
- **Impact:** Larger install, accidental distribution of internal notes via npm tarball. Not a GitHub-publication blocker, but relevant if an npm release is planned.
- **Action:** Add `"files": ["src/", "api/", "templates/", "examples/", "config.example.json", "README.md", "README.zh-CN.md", "LICENSE", "CHANGELOG.md", "DEPLOY.md"]` (adjust to the actual runtime set) and run `npm pack --dry-run` to review the tarball before any publish.

### P2-3. CI badge/README links assume the repo stays at the current owner
- **Evidence:** `README.md:3` badge URL, `README.md:98`/`README.zh-CN.md:77` clone URLs, `package.json:12` homepage — already covered in P0-3, but note that forks will display a CI badge pointing to the original repo's workflow.
- **Action:** Use a relative badge URL (`../../actions/workflows/ci.yml/badge.svg` does not work on GitHub; prefer `![CI](actions/workflows/ci.yml/badge.svg)`) so forks show their own status.

### P2-4. `openchamber` keyword from the task brief is not present
- **Evidence:** A targeted grep for `openchamber` across tracked `.md`/`.json` files returned no matches. No action needed; recorded here so the audit is complete against the requested search list.

---

## 4. Classification of the requested personal/environment signals

| Signal | Found in tracked files? | Classification | Action |
|---|---|---|---|
| `Bruce-Yii` | Yes — `package.json:10,12,14`, `README.md:3,98`, `README.zh-CN.md:77`, `LICENSE:3`, `scripts/replay-write.mjs:24`, `explore/tasks*.json`, `explore/build-tasks.mjs:21,27`, `docs/OBSERVABILITY-AND-EVAL.md:100`, `docs/eval/write-replay-2026-11-23.md:8` | Mix: publishing identity (legit if intentional) + personal defaults in script + fixture noise | P0-3 (decide owner; neutralize script defaults and fixtures) |
| Personal Vercel domain | Yes — `docs/HANDOFF-2026-11-23.md:79`, `docs/ledger/batch-4-figma.md:90` | Real deployment URL — must clean | P0-1 |
| Account IDs (`yu-ac3a`, `R2_ACCOUNT_ID` env references, `team_abc`) | Yes — `docs/ledger/batch-4-figma.md:90` (real), `.github/workflows/capture-daily.yml:26-29` (env-var name only), `explore/tasks*.json` (`team_abc` synthetic) | Real account name in ledger; others are placeholders/env names | P0-1 / P1-5 |
| Emails | `capture-bot@users.noreply.github.com` (`.github/workflows/capture-daily.yml:52,121`) is a bot identity; `kyliau@example.com` (`data/tool-dataset.json:31973`) is vendor schema example; `maya@example.com`/`alex@example.com` are synthetic fixtures | Documentation examples / synthetic — keep, but note bot identity in workflow | P1-5 (no real personal email found) |
| Local paths (`D:\12412\...`) | Yes — `docs/CREDENTIALS.md:15`, `docs/ledger/batch-4-figma.md:25`, `scripts/figma-token.mjs:18`, `AGENTS.md:18`; also `bench/results.json:4` (ignored) | Must clean in tracked files | P0-2 |
| Vault path (`dsh-home/.secrets/...`) | Same as above; implementation is portable via `GATEWAY_SECRET_DIR` | Must clean docs; implementation fine | P0-2 |
| `openchamber` | Not found in tracked files | N/A | P2-4 |
| Real token references | No literal token values anywhere in git history; `tokenEnv`/env-var names only (`config.example.json:9,23-27,61-65,98,320-325`, `DEPLOY.md:39-49`, `.github/workflows/capture-daily.yml:26-43`) | Safe — placeholders/env names | None (re-verify at publish time) |

---

## 5. Publication checklist (derived from the above)

1. **Decide owner/org and repo name** (P0-3, P2-1), then update `package.json`, READMEs, `LICENSE`, badge, remote, and fixture strings.
2. **Sanitize tracked docs**: real Vercel hostnames → `<your-domain>`; vault/absolute paths → env-var-based; internal handoff/ledger → move out of public tree or ignore (P0-1, P0-2, P1-3).
3. **Harden `.gitignore`**: `outputs/`, capture files, `config.local.*`, dated handoffs, `explore/results/**` exceptions (P0-5).
4. **Decide fate of `capture-daily` workflow** and its generated `docs/eval/` commits (P0-4).
5. **Neutralize `scripts/replay-write.mjs` defaults** (P0-3).
6. **Refresh docs**: test counts, "no tokens needed locally" statement, scope/non-goals, `CODE_OF_CONDUCT.md` (P1-1, P1-2, P1-4).
7. **Optional**: neutral repo name, `files` field + `npm pack --dry-run`, relative CI badge (P2-1..3).
8. **Final gates** (not performed in this audit, to be run by the owner before publishing): `git grep -nEi 'Bruce-Yii|dsh-home|vercel\.app|yu-ac3a|R2_|ghp_|sk-'` on the final tree; `git status --short` clean; `npm ci && npm test`; review `git ls-files` for anything unintended.

---

## 6. What was verified as *already fine*

- `npm ci --dry-run` succeeds with the committed lockfile (`package-lock.json`, lockfileVersion 3, name/version match `package.json`); no install-time scripts that fetch external binaries were found in `package.json:26-52`.
- `npm test` passes **642/642** offline with no credentials (run during this audit).
- CI (`.github/workflows/ci.yml:11-46`) runs on Node 20/22/24 with `npm ci`, tests, truncation audit, tool snapshot/task coverage audits, config validation, search eval, context measurement, bench dry-run, and build-info check; `permissions: contents: read` (`:8-9`) is least-privilege.
- Issue/PR templates exist (`.github/ISSUE_TEMPLATE/{bug_report,feature_request}.yml`, `.github/PULL_REQUEST_TEMPLATE.md`) and already warn against posting secrets (`bug_report.yml:8-10`).
- `SECURITY.md` has a private-reporting path (`:8-17`) and an unusually clear single-user threat model (`:19-43`).
- `CHANGELOG.md` follows Keep a Changelog with an `[Unreleased]` section (`:1-7`).
- `.gitignore`/`.vercelignore` already cover the largest local data: `node_modules` (20.68 MB), `work/` (5.17 MB), `.vercel/`, `explore/results/traces/`, `bench/results.json`. No `node_modules`, `work/`, `.vercel/`, traces, or logs are tracked (`git ls-files` confirms; tracked `explore/` is only 20 source/fixture files, and the 3.23 MB on disk is almost entirely ignored results).
- No literal credentials in any git blob across all 195 commits (full-history scan described in §0).

No files were modified by this audit other than this document. No commit, push, or deploy was performed.
