# OSS release: local repository preparation (2026-11-23)

> Scope: **local only**. A standalone git repository was created from the latest
> validated OSS staging snapshot. No remote was added, nothing was pushed,
> nothing was published or deployed. The private repository's source, README,
> workflows, and git history were not modified and were not committed.

> **Update 2026-11-23 (P0 fix):** the historical 263-file snapshot below was
> superseded. The canonical neutralizer/detector fix re-exported **282 files**
> to `work/oss-release-staging/` and `work/oss-release-repo/` (local commits
> `36f677b` + `99365f8`, still no remote). Section 4 records the resolved P0
> and the new `--check` evidence; the earlier numbers in §§1–3 are the
> original run. Concurrent agents added files during this work, so the final
> count moved from 281 to 282.

## 1. What was done (original 263-file run)

1. Read `docs/OPEN-SOURCE/RELEASE-DRYRUN.md` and
   `docs/OPEN-SOURCE/EXPORT-MANIFEST.md`; confirmed the staging path is
   `work/oss-release-staging/` (263 files, no `.git`, previously validated by
   the export script). §7 of the dry-run records the final `263-file` re-export
   with `npm test` at 0 fail and `audit-truncation --ci` PASS.
2. Rebuilt the neutralized source copy with
   `node work/prepare-neutral-source.mjs` (temporary helper, not a deliverable)
   and re-ran the export script in dry-run mode to confirm the current private
   tree has drifted: the plan now selects **272 files**, not 263 (other agents
   added files since the dry-run). To preserve the **validated latest staging
   snapshot** as requested, the release repo was populated by copying the
   263-file staging tree, not by re-exporting the 272-file live plan.
3. Copied the 263 staging files into `work/oss-release-repo/`, excluding
   `.git`, `node_modules`, `ledger`, `HANDOFF*`, `PLAN*`, `AGENTS*`, `explore/`,
   `work/`, `capture/`, `data/`, `outputs/`, `coverage/`, `test-results/`,
   `.vercel*`, `*.log`, `*.capture.json*`, real `config.local.*`, `.env`,
   credentials/secrets. Public-safe example templates (`*.env.example`,
   `config.local.example.json`) were retained — these are explicitly
   allowlisted by the export script's `isDenied()` exemption and are needed by
   the quickstart.
4. Validated the copied tree with `node scripts/export-oss.mjs --out
   work/oss-release-repo --check` → `checked 262 text files`, `CHECK PASSED`.
   Independent grep for real hostnames, personal Windows/vault paths and the
   literal personal handle → 0 hits (see §4 caveat for the escaped form).
5. Created a brand-new local repository in `work/oss-release-repo/`:
   - `git init -b main`
   - local-only identity override: `OSS Release Bot <oss-release@example.com>`
     (global personal identity was deliberately **not** used)
   - `node_modules/` excluded via `.git/info/exclude` (local-only; not a
     committed file, so the tree stays at exactly 263 tracked files)
   - `git add -A` → 263 staged files; `git commit` → initial commit
   - **no `git remote add`, no push, no tag, no deploy**

## 2. Local repository facts

| Item | Original run | Current (P0 re-export) |
| --- | --- | --- |
| Path | `work/oss-release-repo/` | same |
| Branch | `main` | `main` |
| Commits | `f710346` initial | `f710346` + `36f677b` + `99365f8` (P0 fix + docs) |
| Commit author | `OSS Release Bot <oss-release@example.com>` | same local override |
| Tracked files | 263 | **282** (`git ls-files`) |
| Remotes | none | **none** (`git remote -v` empty) |
| Work tree | clean | clean (`git status --short` empty) |
| Private repo | untouched | untouched; no commit, no remote change |

## 3. Validation actually run (inside `work/oss-release-repo/`)

| Command | Result |
| --- | --- |
| `npm ci` | exit 0 — `added 117 packages in 4s` |
| `npm test` | **exit 0 — 1098 tests / 996 pass / 0 fail / 96 skipped / 6 todo** (duration ~16.3 s) |
| `node scripts/audit-truncation.mjs --ci` | **exit 0 — PASS (P1 warning-only; P2 informational)**; no P0 |
| `node scripts/check-config.mjs` | **exit 0 — `config OK`** (5 servers; token env vars absent as expected; warnings about `_authProvisioning` and missing snapshot data are informational) |
| `node scripts/export-oss.mjs --out work/oss-release-repo --check` | exit 0 — `checked 262 text files`, `CHECK PASSED` |

Log artifacts (private checkout, untracked, local only):
`work/oss-release-repo-npm-test.txt`,
`work/oss-release-repo-audit-truncation.txt`,
`work/oss-release-repo-check-config.txt`.

The 96 skips are explicit fixture-gated tests from the curation work recorded in
`RELEASE-DRYRUN.md` §7; they are reported as skips, not fake passes.

## 4. Blocker status

### P0 — RESOLVED (2026-11-23)

**Personal handle in escaped/encoded forms: FIXED.** The old temporary helper
`work/prepare-neutral-source.mjs` rewrote the literal handle into a JS unicode
escape; the export detector's regex matched the same escape sequence text, so
`--check` reported a false PASS on ~60 occurrences (`package.json`, scripts,
tests, and the detector's own source).

Fix delivered in tracked files (no private source changes):

- `scripts/prepare-neutral-source.mjs` — new canonical neutralizer. Replaces
  literal, single/double unicode-escaped, hex-escaped, URL-encoded (including
  double-encoded), HTML-entity, character-code and concatenation forms with
  `example-org`, plus bare handle segments in prose. It also self-neutralizes
  its own signature constants, so its exported copy carries no signature.
  Supports `--out`, `--source`, `--write`, `--check`.
- `scripts/export-oss.mjs` — detector now canonicalizes all encoding layers
  before matching and compares candidate tokens by SHA-256 against one-way
  digests of the handle. No recoverable handle literal or code-point sequence
  remains in the detector source itself. `--check` exits 1 on any hit.
- `tests/oss-neutralizer.test.js` — 12 regression tests covering literal,
  escaped, URL-encoded, concatenated and case variants; clean-content
  no-false-positive; neutralizer output; and `--check` exit codes.

Re-export and verification evidence:

| Check | Result |
| --- | --- |
| `node scripts/prepare-neutral-source.mjs --out work/oss-release-staging --write` | 282 files written, 136 replacements, post-write validation 0 violations |
| `node scripts/export-oss.mjs --out work/oss-release-staging --check` | `checked 281 text files`, `CHECK PASSED`, exit 0 |
| Independent grep of staging for the handle prefix | **0 hits** (residual `Yii` only in npm integrity base64 / unrelated prose) |
| `node scripts/export-oss.mjs --out work/oss-release-repo --check` | `checked 281 text files`, `CHECK PASSED`, exit 0 |
| Release repo update | 282 tracked files, local commits `36f677b` + `99365f8`, **no remote**, clean worktree |

`docs/ledger/batch-15-oss-neutralizer.md` records the full investigation and
verification. **Do not publish until the remaining blockers below are cleared.**

### Remaining blockers / risks

1. **New repo name / owner undecided.** PLAN/EXPORT-MANIFEST recommend
   `codemode-mcp-gateway`; `package.json` name is still `gemini-mcp-gateway`.
   Repository/homepage/bugs URLs now point at `example-org` (neutralized), but
   the final owner/name must be decided before the next export.
2. **LICENSE / README / release notes / tag not finalized.** LICENSE file exists
   and says MIT; confirm it matches the intended owner/year. README still has
   the private-repo name in metadata paths. Release notes for v0.1 alpha
   (single-owner/self-hosted, API may change, Gemini tested / Claude target /
   ChatGPT documented-not-promised) are still to be written. First tag should
   be `v0.1.0` (or `v0.1.0-alpha.1`) — **not created locally**.
3. **Curated `docs/eval/` and `docs/OPEN-SOURCE/` need human confirmation.**
   The dry-run flagged recently added reports as a review item; they are in the
   current 281-file snapshot.
4. **Docker compose `/healthz` + `/mcp` reachability and Node 20/22/24 CI matrix
   were not re-verified in this task** (covered only by earlier docs).

## 5. Release checklist (for a human, after blockers are cleared)

- [ ] Decide public owner + repo name (`codemode-mcp-gateway` recommended).
- [x] Improve neutralizer + detector for the escaped handle form; re-export;
      confirm 0 hits with an escape-aware scan (P0 — done 2026-11-23, see §4).
- [ ] Decide final owner, then update the neutralized `package.json`
      name/repository/homepage/bugs and README URLs.
- [ ] Confirm LICENSE owner/year; keep MIT.
- [ ] Confirm curated `docs/eval/` and `docs/OPEN-SOURCE/` are public-safe.
- [ ] Re-run in a clean clone: `npm ci && npm test`, `audit-truncation --ci`,
      `check-config`, `measure-context` (SKIP is expected).
- [ ] Verify Docker compose healthcheck and `/mcp` reachability; Node 20/22/24.
- [ ] Write v0.1 alpha release notes with the honest client matrix.
- [ ] Only then, **manually**: create the remote (`git remote add origin
      <new-public-url>`), push `main`, and create the first tag
      (`v0.1.0` / `v0.1.0-alpha.1`). No remote operation was performed here.
- [ ] Keep the private repo private; do not push it or its history.
