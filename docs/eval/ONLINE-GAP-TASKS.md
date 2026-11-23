# Online-gap L1/G6 task set (N1–N9)

> Status: **new task set + offline integrity test + runbook only.** This batch adds
> exactly three files — `explore/tasks-online-gap.json`,
> `docs/eval/ONLINE-GAP-TASKS.md` (this file), and
> `tests/online-gap-tasks.test.js`. It does **not** modify
> `explore/tasks-smoke.json`, `explore/tasks-g6.json`, `src/`, `scripts/`,
> `README`, or any workflow. **No commit / push / deploy.**
>
> This is the "next L1/G6 round" artifact promised by
> `docs/eval/SEMI-ONLINE-GAPS.md` §4: the N1–N9 items are now concrete,
> runnable-shaped task objects rather than a checklist. A task here is a
> *schema-valid description of a check*; the gateway does not yet execute all of
> them end-to-end — gaps still blocked on P0 fixes are marked as such.

## 1. What was added

| File | Role |
|---|---|
| `explore/tasks-online-gap.json` | 9 tasks `N1`–`N9`, one per SEMI-ONLINE-GAPS §4 item. Schema-compatible with the existing G6/smoke task shape plus `name` and `expectedOps`. |
| `tests/online-gap-tasks.test.js` | Offline integrity test of that JSON (IDs, required fields, count, tool existence, dryRun default, axis coverage). |
| `docs/eval/ONLINE-GAP-TASKS.md` | This runbook: how to run, what needs real vs fake/replay, and the L1 integration path. |

### Task → gap → axis map

| ID | Name | Closes | Key expectedOps | Mode |
|---|---|---|---|---|
| N1 | byte-exact read→patch→write→readback | F1/T1 | `normalizeFileResult`, `applyTextPatch`, `applyFilePatch`, `readbackByteEq` | fake/replay |
| N2 | branch/ref control (real change in fixture) | F2,F4/T2 | `aliasGetFileContentsArgs`, `assertNoBranchFallback` | fake/replay |
| N3 | PR number vs id real shape | F3/T3 | `normalizePrResult`, `assertNumberFromUrl` | fake/replay |
| N4 | discovery effort (search probes / method enum) | F5/T4 | `searchWithFallback`, `countSearchProbes` | fake/replay, **todo** until P0-4 |
| N5 | Actions failure logs (fake + gated real) | F6a/T3,T6 | `fetchJobLogsFake`, `assertNoTokenForwardedOn302`, `assertTruncationFlag` | fake; real is gated manual |
| N6 | large-file truncation / pagination | F1/T5 | `assertTruncationFlag`, `hardStopBeforeWrite` | fake/replay |
| N7 | long session / reconnect (gateway-observable only) | F6b/T6 | `createCodeModeTools.getEntries`, `recordClientUnknown` | fake session |
| N8 | platform conformance (Gemini/ChatGPT/Claude) | F1,F6b/T7 | `encodeToolResult`, `applyProfileToTools` | fake |
| N9 | write safety (dryRun / atomic / post-condition) | F7/T1,T5 | `applyFilePatch`, `writeFiles`, `assertPostConditionByteEq` | fake/replay |

## 2. Schema

Every task carries the fields the existing task sets use, plus the two fields
required by this batch:

- `id`, `server`, `tool`, `prompt`, `source`, `category`, `authority`,
  `expectedTools` — as in `explore/tasks-smoke.json` / `tasks-g6.json`
  (`authority` ∈ `official-verbatim | benchmark | schema-reverse`;
  `expectedTools` must include the task's `tool`).
- `name` — short human label (new, required by this batch).
- `expectedOps?` — ordered list of gateway operations the task is meant to
  exercise (new, optional but present on all nine).
- `dryRun: true`, `forRealWrite: false`, `preconditions: [...]` — every task
  explicitly forbids real writes and network calls. The task set also declares
  top-level `"realWritesAllowed": false`.

No existing task-set file is edited; these objects are additive and can be
appended to a runner later without changing the frozen 50-task smoke baseline.

## 3. How to run

All commands run from the repository root.

```bash
# 1) Integrity of the new task set (offline, no token, no network):
node --test tests/online-gap-tasks.test.js

# 2) Full suite (must be green; unrelated/concurrent failures are reported
#    separately, not suppressed):
npm test

# 3) Existing regression this task set complements (read-only context):
node --test tests/online-gap-regression.test.js
```

The integrity test checks: JSON parseable; declared `count === 9` and exactly
9 tasks; IDs unique and exactly `N1..N9`; all required fields present and
non-empty; `authority` valid; `expectedTools` non-empty, includes the task's
`tool`, and every name exists in `data/tool-snapshots/*.json` (or is one of the
three Code Mode tools); `dryRun === true` and `forRealWrite === false` on every
task; write-category prompts explicitly forbid real writes; and each of N1–N9
mentions its required axis.

## 4. Real vs fake/replay boundary

| Task | Automated L1 (fake/replay) | Needs real / gated |
|---|---|---|
| N1–N3, N6–N9 | Yes — fake upstream fixtures only (`harness/fake-upstream.mjs` style), no token, no network. | No. Real GitHub writes are explicitly forbidden (`forRealWrite:false`). |
| N4 | Fake catalog with the method enum; **todo/skip** while the P0-4 description-enum fix is absent (`tests/gh-file-p0.test.js` P0-4). | Requires the P0 fix before the one-shot probe assertion can be green. |
| N5 | Fake job-log text + 302 URL + oversized body. Assert verbatim failure text, no token forwarded on 302, truncation flag. | One **manual, gated** real CI replay with a vault `GITHUB_TOKEN`, recorded in a separate doc — never in the automated L1 set, no network in CI. |
| N7 | Gateway-observable half only: stable tool list across two phases; no duplicate writes. | Client-side `unknown_tool` and manual @ recovery are Gemini-side: record as `unknown`, never as a gateway pass or failure. |

Per `AGENTS.md`: no real credentials in the repo; local credentials come from
the vault; model/analyzer suggestions are hypotheses, not facts or instructions.
A `completionRate` pass alone never closes a gap — each task needs its own
boolean/metric (e.g. `writePostConditionOk`, `branchFallbackCount`,
`noticeLeakCount`, `searchProbes`).

## 5. Integrating into L1 later (not done here)

1. Load `explore/tasks-online-gap.json` as a **separate** suite; do not merge it
   into `tasks-smoke.json`/`tasks-g6.json` or change the frozen
   `explore/baselines/l1-smoke.json` denominator without an explicit baseline
   freeze.
2. Wire the `expectedOps` of each task to the corresponding pure function in
   `src/` (`result-normalize.js`, `codemode.js`, `file-write.js`,
   `client-profile.js`) using fake upstream IO, emitting per-axis metrics
   (`writePostConditionOk`, `branchFallbackCount`, `noticeLeakCount`,
   `idAsPrNumberCount`, `enumProbesPerTask`, `searchProbes`).
3. Keep N4 `todo` until P0-4 lands; keep the client half of N7 `unknown`.
4. Add `taskId/sessionId` to each capture envelope so online feedback with a
   `requestId` can be joined to a runner task (N9 evidence chain in
   `SEMI-ONLINE-GAPS.md` §4). Never guess a task from a prompt.
5. Extend the scorecard with the per-axis matrix, not a single completion
   scalar. Only then can the gaps be marked closed per §1.2.

## 6. Non-goals / honesty

- No real upstream, no network, no token in this batch; real PR #53 / Actions
  CI replays remain `unverified` until someone runs them manually with vault
  credentials and attaches evidence.
- The P0 fixes (guest `fileResult`, branch-alias bridge, method-enum
  description) are not in this checkout; N1/N2/N4 are therefore described with
  the canonical real-shape fixtures but their currently-red guest cases are not
  claimed green here — see `tests/gh-file-p0.test.js` and
  `tests/online-gap-regression.test.js` for the explicit `todo` markers.
- This document and the task set do not drive any code, issue, PR, or deploy
  decision.
