# Export implementation: private repo -> new public repo

> Companion to [EXPORT-MANIFEST.md](EXPORT-MANIFEST.md) and
> [PLAN.md §0.1](PLAN.md#01-delivery-model-new-public-repo-private-repo-stays-source-of-truth).
> This document describes the **mechanics** of the clean export only.

## What the script does — and does not do

`scripts/export-oss.mjs` produces a **clean staging tree** from the current
private repository. That is its entire job.

It **does not**:

- run `git init`, `git add`, `git commit`, `git push`, `git remote add`;
- deploy to Vercel or any other host;
- publish to npm;
- rewrite or redact file contents;
- touch the private repository (all operations are read-only on the source).

The default mode is **dry-run**: it prints the plan and validates, but writes
nothing. Only an explicit `--write` copies files into the staging directory.
Publication (`git init` in staging, first commit, remote setup, push) is a
**separate, manual, human-controlled step** after the gates below pass.

## Usage

```bash
# 1. Dry-run: see the plan, validate, write nothing (default)
node scripts/export-oss.mjs --out ../codemode-export

# 2. Actually copy allowlisted files into staging
node scripts/export-oss.mjs --out ../codemode-export --write

# 3. Validate a staging tree without copying (e.g. after manual edits)
node scripts/export-oss.mjs --out ../codemode-export --check

# Help
node scripts/export-oss.mjs --help
```

Exit codes: `0` = success / clean check, `1` = validation failure or CLI error.

`--write` and `--check` are mutually exclusive. `--out <dir>` is required.
`--source <dir>` overrides the source root and exists for tests/internal use;
normal runs always export the repository the script lives in. The staging path
is printed on every run as `staging=<path>`.

## How it works

### 1. Allowlist first (`buildPlan()`)

`buildPlan(root)` walks the source tree (skipping `node_modules`, `.git`, and
symlinks that escape to directories) and classifies every file into:

- `files` — allowlisted and not denied: the copy set;
- `denied` — matched the denylist: a hard refusal condition;
- `outsideAllowlist` — not in either list: excluded by default.

The allowlist includes only public-safe roots and files: `package.json`,
`package-lock.json`, README/LICENSE/CHANGELOG/CONTRIBUTING/SECURITY/DEPLOY,
`config.example.json`, `vercel.json`, `api/`, `src/`, `tests/`, `scripts/`,
`harness/`, `bench/`, `examples/`, `templates/`, selected curated `docs/`
entries, `docs/eval/`, `docs/OPEN-SOURCE/` (curated), and
`.github/workflows/ci.yml`.

If **any** denylisted path is found in the source, the export aborts before
copying — it never relies on "copy everything then delete" semantics.

### 2. Denylist as a second line of defense (`isDenied()`)

Denied regardless of parent allowlist: `AGENTS.md`, `project.json`,
`docs/ledger/`, `docs/PLAN-*`, `docs/HANDOFF-*`,
`docs/OPEN-SOURCE/READINESS.md`, `docs/GEMINI-PROBE.md`,
`docs/BACKLOG-GEMINI-SUGGESTIONS.md`, `docs/superpowers/`, `explore/`,
`data/`, `work/`, `outputs/`, `capture/`, eval scorecards/weeklies,
`.vercel*`, `coverage/`, `test-results/`, `*.log`, `*.capture.json`, owner-only
workflows (`capture-daily.yml`, `l1-smoke.yml`), `config.local.*`, `.env`,
`credentials`, `secrets`.

### 3. Content & path validation (`validateExport()`, `validateSelected()`)

These are **checks, not transformations**. Nothing is ever "sanitized" in
place; a hit fails the run so a human fixes the source. Detectors cover:

- denylisted file present in the tree;
- `Bruce-Yii` (personal handle / owner default);
- personal Windows paths (`D:\12412`, `dsh-home/`, `.secrets/`);
- real deployment hostnames of this project (`*.vercel.app` etc.);
- literal secret-like assignments (`API_KEY`, `ACCESS_TOKEN`, `CLIENT_SECRET`,
  `REFRESH_TOKEN`, `BEARER` followed by a long quoted value).

`validateSelected()` applies the same content checks to only the plan's copy
set (pre-export gate); `validateExport()` scans a whole tree (post-export gate
and `--check` mode). Text files larger than 2 MiB are flagged for manual
review. Capture data is **never** redacted or rewritten — it is simply never
selected for export.

The CLI sequence is:

```text
buildPlan -> refuse if denied.length > 0 -> validateSelected (source)
   -> [dry-run: print & stop] -> write staging -> validateExport (staging)
```

Both a pre-export and a post-export check must pass for `--write` to succeed.

## Pure, testable API

The module can be imported without side effects; the CLI only runs when the
file is executed directly. Exports:

- `ALLOWLIST`, `DENYLIST` (frozen arrays);
- `isAllowed(rel)`, `isDenied(rel)`;
- `buildPlan(root)` -> `{ root, files, directories, denied, outsideAllowlist, counts }`;
- `validateExport(root)` / `validateSelected(root, files)` -> `{ ok, violations, ... }`;
- `parseArgs(argv)`.

Tests in `tests/export-oss.test.js` use temporary directories and fixtures only;
they never execute `npm`, never touch the real repo, and never call the network.
They cover allowlist inclusion, denylist exclusion, sensitive-string hits,
dry-run writing nothing, `--write` copying, and `--check` pass/fail.

## Process: private -> public (manual steps after export)

1. In the private repo, neutralize metadata that the detector flags: neutral
   `name`/`repository`/`homepage`/`bugs` in `package.json` (`codemode-mcp-gateway`,
   `example-org/example-repo`), public README, no personal paths.
2. Run the dry-run, review the printed plan and denial list.
3. Run `--write` into a **new, empty** staging directory outside the private
   repo. Confirm `staging=` path and the post-export check pass.
4. In staging, run the validation gate from the manifest:
   `npm ci`, `npm test`, `node scripts/audit-truncation.mjs --ci`,
   `node scripts/check-config.mjs`, `node scripts/measure-context.mjs`.
5. Run `node scripts/export-oss.mjs --out <staging> --check` again after any
   manual edits (public README rewrite, neutral fixtures, metadata).
6. Only then, **manually**: `git init` in staging, one initial/release commit,
   add the new public remote, and push. Keep the private repo private.
7. Ongoing development continues in the private repo; publish further release
   snapshots by repeating the export, never by making the private repo public.

## Limitations

- The allowlist is conservative: new public files must be added to `ALLOWLIST`
  deliberately; nothing is auto-discovered.
- Detectors are best-effort string checks. They do not parse code semantics or
  detect obfuscated secrets; human review of the staging tree is mandatory.
- Binary files are not content-scanned (only their paths are checked).
- The script does not validate that the exported project actually builds or
  tests green — that is step 4 above, run in staging.
- No git/deploy operations are performed by design; do not reinterpret this
  script as a release automation tool.
