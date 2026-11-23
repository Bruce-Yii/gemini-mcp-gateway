# Batch 15 — OSS neutralizer / detector P0 fix (2026-11-23)

## Scope

Fix the P0 leak that allowed a personal GitHub handle to survive the OSS export
in escaped form while `export-oss --check` reported PASS.

**Write scope (only these files were touched):**

- `scripts/prepare-neutral-source.mjs` (new)
- `scripts/export-oss.mjs` (detector/check code only)
- `tests/oss-neutralizer.test.js` (new)
- `docs/OPEN-SOURCE/RELEASE-LOCAL.md` (P0 status)
- `docs/ledger/batch-15-oss-neutralizer.md` (this file)

No changes to `src/`, other scripts/tests, `README`, or workflows. No commit,
push, deploy or remote in the private repository. The separate local-only
release snapshot in `work/oss-release-repo/` was updated as described below.

## Root cause

`work/prepare-neutral-source.mjs` (temporary, denylisted helper) replaced the
literal handle with a JS unicode escape, e.g. a file containing the literal
handle became text containing the *characters* `\u002d` in the separator:

```text
original:  github.com/<handle-part-a>-<handle-part-b>/repo
old output: github.com/<handle-part-a>\u002d<handle-part-b>/repo
```

The detector regex was written as `/<part-a>\u002d<part-b>/i` in a JS regex
literal. In a regex literal `\u002d` is interpreted by the JS parser as the
hyphen character, so the pattern matched the *decoded* handle but not the
literal backslash-u sequence written into exported files. Every escaped
occurrence was a false negative. `work/oss-release-repo/` had 66 lines with
the handle prefix; the old `--check` reported `CHECK PASSED` on all of them.

## Fix

### 1. Neutralizer (`scripts/prepare-neutral-source.mjs`)

- Builds the same allowlist plan as the exporter (`buildPlan`).
- Replaces **all** equivalent handle forms with `example-org`:
  - literal (any case, ASCII/Unicode hyphen);
  - JS/JSON unicode escape (`\u002d`), doubled backslash form (`\\u002d`),
    hex escape (`\x2d`);
  - URL encoding (`%2d`) and double URL encoding (`%252d`);
  - HTML entity separators (`&#45;`, `&#x2d;`, `&hyphen;`);
  - runtime concatenation (`'A' + '-B'`) — replaced with a quoted JS literal
    so exported tests/scripts stay syntactically valid;
  - character-code reconstruction (`String.fromCharCode(...)`);
  - bare handle segments in prose (word-boundary matched, so npm integrity
    base64 strings such as `...Yyii07...` are not corrupted).
- Self-neutralizes its own signature constants: the copy written to staging
  contains no handle segments and cannot rebuild them.
- Also neutralizes private workspace paths and real deployment hostnames.
- Supports `--out`, `--source`, `--write`, `--check`; dry-run by default.
- Post-write validation via the exporter's own detector.

### 2. Detector (`scripts/export-oss.mjs`)

- `canonicalizeForScan()` decodes unicode/hex escapes, URL encodings (including
  double encoding), HTML entities and Unicode hyphen variants, repeatedly
  until stable, then lowercases.
- `detectHandleForms()` compares candidate tokens from the canonical and
  concatenation-stripped views against **SHA-256 digests** of the handle.
  Only one-way digests are stored in the source; the detector cannot rebuild
  the handle it guards, and its own exported copy is clean by construction.
- `hasHandleLeak()` is wired into `SENSITIVE_PATTERNS` as a predicate, so
  `validateExport()`, `validateSelected()` and `validateExport --check` all
  fail hard on any hit. No regex-only path remains for this detector.
- `neutralizeHandleText()` is exported so neutralizer and detector share one
  grammar; it supports per-pattern replacements for syntactic correctness.

### 3. Tests (`tests/oss-neutralizer.test.js`)

12 tests, all passing:

- detector catches literal / uppercase / mixed case / unicode escape /
  double-backslash escape / URL / double URL / HTML entity / concatenation;
- canonicalization maps all encodings to the same token;
- clean content (including npm integrity base64) produces zero hits;
- neutralizer removes every form and records replacements;
- neutralizer self-neutralization erases its signature constants;
- `validateExport` / `validateSelected` fail on escaped and URL-encoded
  handles and pass clean fixtures;
- `export-oss --check` exits 0 on clean staging and 1 on escaped, URL-encoded
  and concatenated forms;
- `prepare-neutral-source --check` exits 0 on the live source tree.

Existing `tests/export-oss.test.js` also still passes (11/11). Both suites
together: **23/23 pass, 0 fail**.

Full `npm test` on the private checkout (concurrent agents active):
**1224 tests / 1216 pass / 2 fail / 6 todo**. The 2 failures are both in
`tests/capture-queue-integration.test.js` (a file added concurrently, outside
this task's write scope):
`TypeError: Cannot read properties of null (reading 'snapshot')` at lines 315
and 352 ("flag ON: sink failure leaves critical logs intact ..." and
"flag ON: HTTP 500 is retried by the queue ..."). They reproduce in isolation
with `node --test tests/capture-queue-integration.test.js` (7 pass / 2 fail)
and are unrelated to the neutralizer/detector changes. Log:
`work/oss-neutralizer-npm-test.txt`. Report to lead; do not touch that file.

## Re-export and verification evidence

Commands run from the private checkout root:

```text
$ node scripts/prepare-neutral-source.mjs --out work/oss-release-staging --write
[prepare-neutral] plan: 287 included, 136 replacements
[prepare-neutral] wrote 282 neutralized files to .../work/oss-release-staging
[prepare-neutral] post-write validation passed (0 violations)

$ node scripts/export-oss.mjs --out work/oss-release-staging --check
[export-oss] checked 286 text files
[export-oss] CHECK PASSED                       (exit 0)

$ node scripts/export-oss.mjs --out work/oss-release-repo --check
[export-oss] checked 286 text files
[export-oss] CHECK PASSED                       (exit 0)
```

Independent grep over the rebuilt staging tree (287 files):

| Token | Hits | Notes |
| --- | --- | --- |
| `Bruce` | **0** | previously 66 lines in the old snapshot |
| `u002d`, `%2d`, `&#45;` | present only as escape-pattern *names* in `scripts/export-oss.mjs` / `scripts/prepare-neutral-source.mjs` and in `docs/OPEN-SOURCE/PUBLIC-SAFETY-AUDIT.md`; no handle prefix adjacent to them, so no recoverable handle form |
| `Yii` | 4 | npm integrity base64 (`...Yyii07...`) and audit prose describing those hashes; not the handle |

Local release repo state after update:

- `work/oss-release-repo/` — 287 tracked files, clean worktree, local-only
  identity `OSS Release Bot <oss-release@example.com>`;
- commits: `f710346` (initial) + `36f677b` (P0 neutralization) + `f5688d5` (docs);
- `git remote -v` empty; no push, tag, deploy or publish;
- private repo working tree: only the five write-scope files above are modified
  or new; no commit made there.

## Known limitations / follow-ups

- The final public owner/repository name is still undecided. `example-org` is
  a neutral placeholder in `package.json` repository/homepage/bugs and README
  clone URLs; the human release checklist in `RELEASE-LOCAL.md` covers this.
- Full `npm test`, `audit-truncation --ci` and `check-config` were previously
  green on the 263-file snapshot; this task re-ran the export gates and the
  two export test suites on the private checkout. A fresh clean-clone gate run
  on the 281-file snapshot remains on the human release checklist.
- Other agents were adding files concurrently; the plan count moved from 263
  to 278 to 281 to 287 during this task. The final staging/repo snapshot
  contains 287 files and is internally consistent.
- `scripts/export-oss.mjs` still contains the literal strings `u002d`, `%2d`
  and `&#45;` because it must name the encodings it detects. These are not
  handle forms (no 5-letter handle prefix, no digest match) and cannot
  reconstruct the handle on their own.
