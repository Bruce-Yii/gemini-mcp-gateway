/**
 * Code Mode for the gateway (based on Cloudflare @cloudflare/codemode, MIT).
 *
 * Exposes only two MCP tools to the model:
 *   - search(query): find upstream tools (name + one-line description + params)
 *   - execute(code): the model writes an async arrow function that calls
 *     codemode.<tool>(args); only the function's return value enters context.
 *
 * Big upstream results never enter the model context directly: the model can
 * process/filter them inside the sandbox and return only a summary.
 *
 * Sandbox: Vercel `run` SDK — a hardened QuickJS context inside a worker
 * thread. Guest code has no process/require/fetch/Node globals and its built-in
 * prototypes are frozen; only the host functions declared below are reachable.
 * This is a real engine-level boundary (unlike node:vm), so `.constructor`
 * cannot reach the host realm.
 */
import { createRunner } from 'run';
import { createHash } from 'node:crypto';
import { parse } from 'acorn';
import { normalizeCode, sanitizeToolName } from './codemode-util.js';
import { normalizeToolArguments } from '../shared/sanitize.js';
import { captureEvent } from '../evidence/capture.js';
import { searchEntries } from '../shared/catalog.js';
import {
  DEFAULT_OUTPUT_BUDGET_CHARS,
  DESCRIPTION_MODE_COMPACT,
  encodeModelOutput,
  resolveClientProfile,
  resolveToolAnnotations,
} from '../client/client-profile.js';
// B10 integration: canonical adapters are exposed into the sandbox through the
// existing host bridge (values serialize; guest functions cannot cross it).
// The existing fileResult/prResult helpers stay byte-for-byte unchanged.
import { normalizeResult as hostNormalizeResult, explainTruncation, UNTRUSTED_RAW_MARKER as RESULT_RAW_MARKER } from './result-normalize.js';
// B10 follow-up (PR #41–#48): unified write semantics. These are pure host
// modules; only data crosses the bridge, so the guest helpers below stay thin.
import {
  canonicalResult,
  createBranchIfMissing,
  githubActionsListWorkflowRuns,
  githubActionsListWorkflowJobs,
  githubActionsGetJobLogs,
  waitForPrChecks,
  // Batch 17 · PR #80–#101 feedback helpers (pure orchestration over injected
  // callables; the host registry below builds those callables from the ACTUAL
  // tools mounted in this session, so we never invent an upstream capability).
  createIssue as createIssueHelper,
  rerunFailedJobs as rerunFailedJobsHelper,
  mergePrWithOptionalBranchDelete as mergeWithBranchDeleteHelper,
  deleteFiles as deleteFilesHelper,
  renameFiles as renameFilesHelper,
  UNTRUSTED_RAW_MARKER,
} from './github-helpers.js';
import { applyFilePatches, precheckText, normalizeWriteResult } from './file-write.js';
import {
  unwrapResult,
  redactSecrets,
  modelErrorMessage,
  formatToolSummary,
  formatToolDetail,
  truncateResultValue,
  truncateResponseText,
} from './tool-format.js';
// B14 typed-plan host helper (sandbox-only; NOT a new MCP tool). The typed-plan
// engine stays a pure host module; this import is the single runtime bridge
// between Code Mode and the executor. No tool schema/route changes follow from it.
import { executeTypedPlan } from './typed-plan.js';

const DEFAULT_MAX_CALLS = 50; // max upstream tool calls per execute() (was 30)
const MAX_TYPED_PLAN_STEPS = 64; // align v1 bridge with the v2 schema's maxItems
// M1: single-sourced with client-profile.js so a profile's default
// `outputBudgetChars` is exactly the historical global threshold.
const DEFAULT_MAX_RESULT_CHARS = DEFAULT_OUTPUT_BUDGET_CHARS; // cap the execute() return value
// F-06: the `run` SDK injects every syncHostFunctions group as a guest global.
// Calling it `__bridge` let guest code bypass __dshInvoke's Error rebuilding and
// reach the host registry with raw `{value}` / `{__hostError,...}` envelopes.
// Use a non-guessable group name so `__bridge` is simply undefined in guest.
const BRIDGE_GLOBAL = '__dshHostBridge9f4c2a';
// F-06: tool names come from upstream MCP servers (untrusted). Binding a tool
// called `__proto__` / `constructor` onto the guest `codemode` object mutates
// its prototype or shadows a built-in; filter these at the host boundary.
const RESERVED_TOOL_IDENTS = new Set([
  '__proto__', 'constructor', 'prototype', '__defineGetter__', '__defineSetter__',
  '__lookupGetter__', '__lookupSetter__',
  '__dshInvoke', '__dshHide', '__dshLine', '__dshStr', '__dshSearch', '__dshCal',
  'codemode', 'search', 'console', 'stub', 'tool', 'log', 'atob', 'btoa',
  'crypto', 'TextEncoder', 'TextDecoder', 'URL', 'URLSearchParams',
  'setTimeout', 'clearTimeout', 'safeAll', 'unwrap', 'unwrapBatch',
]);
const EXEC_TIMEOUT_MS = 30000;
const ARG_FIELD_MAX = 200; // cap each arg field in the audit trail (prevents context leak)
const DEFAULT_MAX_LOG_CHARS = 4000; // cap serialized console logs so a chatty script cannot flood context

// RC-D7: brief boundary/refusal guidance appended to BOTH execute tool
// descriptions, so the model knows what to do when it cannot/should not comply
// instead of forcing a tool call. Kept as one shared constant to avoid drift.
const EXEC_BOUNDARY_GUIDANCE = " Boundary: if the task exceeds the available tools' capabilities, requires an external service, or information is insufficient, explicitly state it cannot be done and explain why — do not force tool calls; refuse harmful requests.";

// Gemini feedback #3: upstreams do not share one result shape. One short line
// nudges the model to defend before field access instead of crashing mid-script.
const RETURN_SHAPE_GUIDANCE = ' Results differ by service: Notion/Linear mostly return objects, GitHub often JSON text or arrays, Vercel mostly objects — guard with Array.isArray(x) / typeof x === "string" before reading fields; safeAll(tasks) keeps a batch alive when one sub-task fails; grepSnippet(text, keyword, window) extracts context slices from long results (each clipped snippet is now marked truncated); codemode.unwrap(x) normalizes JSON text, {result}, {text,resources} and content arrays; fileResult(x)/prResult(x) flatten common file/PR shapes. Intl is unavailable in the sandbox: use codemode.formatDate(value, {date:true,time:true,ms:true}) or Date UTC getters. NO SILENT CHARACTER TRUNCATION: never write `l.slice(0, 150)`, `line.substring(0, N)` or any other manual per-line character cut — that silently destroys data and is the P0 bug this guidance fixes. To control context, read with codemode.readFileRange({path,startLine,endLine,maxCharsPerLine?}) (returns {lines,truncated,truncation?,nextStart,totalLines}; NO maxCharsPerLine means full lines, with it every cut line is flagged) or codemode.sliceLines(text,start,end) (line-based, reports truncated) and REPORT the truncated flag in your answer; follow nextStart to page through. grepSnippet also reports truncated on clipped windows. Never patch or write a read whose truncated flag is true — re-read the full file first. Edit with codemode.replaceLines/applyPatch; call diffSummary before writing. codemode.normalizeFile/normalizePr/normalizeIssue/normalizeResult give canonical field sets (raw kept; truncated is true on any upstream/marker/nested flag); codemode.applyFilePatch previews/writes via GitHub tools (dryRun by default; refuses truncated reads); codemode.ensureBranch/upsertPr/fetchAllPages/repoGrep wrap injected GitHub tools. Batch 11 atomic writes: when github__push_files is available, codemode.writeFiles commits all staged files in ONE push (atomic:true); if a push fails nothing is written. Without it, per-file writes are non-atomic — a mid-batch failure returns partial:true plus written[] and a compensation hint, and explicitly requesting atomic:true without push_files fails with zero writes. Unified writes: codemode.applyFilePatch/writeFiles accept {patches:[{path,patch,sha?}]} (or single path+patch), auto-fill sha from the read, precheck JSON/JS-TS before writing, and return top-level {sha,commitSha,number?,url?}; codemode.canonicalize/normalizeMerge give {number,url,sha}; codemode.createBranchIfMissing creates from base when absent; codemode.precheckText is a lightweight write-before check (JSON strict, JS/TS brackets only — not a compiler).';

// Gemini feedback #2: tell the model which identifier is actually callable.
const CALLNAME_GUIDANCE = ' Each result carries "callName": pass that exact identifier to codemode (the "name" field may contain hyphens — do not copy it literally into codemode["..."]).';

// 2026-11-22 residual feedback: tool calls used to resolve synchronously at the
// bridge, so `.then()/.catch()` were "not a function". They are native Promises
// now; spell out which helpers stay synchronous so models neither await a plain
// object nor chain on one.
const ASYNC_GUIDANCE = ' Tool calls return Promises (await / .then / .catch work); codemode.search, listTools, remainingCalls and services are synchronous helpers.';

// Batch 11 · GitHub Actions failure logs. These are gateway-side GitHub REST
// helpers (host fetch + GITHUB_TOKEN), NOT new upstream MCP tools; the public
// tool set stays at three. Available in both execute_read and execute.
const ACTIONS_GUIDANCE = ' GitHub Actions read-only helpers (gateway-side REST, not upstream tools): codemode.github_actions_list_workflow_runs({owner,repo,workflow_id?,status?,branch?,per_page?}), codemode.github_actions_list_workflow_jobs({owner,repo,run_id}), codemode.github_actions_get_job_logs({owner,repo,job_id}). Each returns {ok,status,data|text,truncated} or {ok:false,status,error}; log text may be truncated — check the flag. Requires GITHUB_TOKEN.';

// Batch 15 P0 guidance. The model used to waste a round probing
// pull_request_read's aggregated `method`, and passed `branch` to
// get_file_contents (silently ignored -> main). State both up front; `usage`
// on search results carries the same note so select:<name> is self-documenting.
const GH_HIGHFREQ_GUIDANCE = ' GitHub high-frequency args: github__pull_request_read is an aggregated tool — pass method:"get" | "get_files" | "get_check_runs" (pick directly, no probing round). github__get_file_contents selects a commit/ref with `ref`; `branch` is accepted as a compatibility alias (mapped to ref when ref is absent).';
// Gate5 AT-LN-01: keep the default Linear read inside the output budget.
const LINEAR_CONTEXT_GUIDANCE = ' Linear list_issues is verbose by default: pass a small `limit` (e.g. 10–20) plus a minimal `fields` array like ["id","title","status","url"], add "description" only for the issues you need, and page with `cursor`; a default 10-issue page can exceed the ~26.8KB execute output cap and be truncated.';
const GH_TOOL_USAGE = {
  pull_request_read: 'method: "get" | "get_files" | "get_check_runs" (aggregated pull_request_read — pick one directly; no probe round).',
  get_file_contents: 'Use `ref` (commit/branch/tag SHA or name) to select a revision; `branch` is accepted as a compatibility alias and mapped to ref when ref is absent.',
};

// Gate5 AT-LN-01 (ChatGPT live eval): Linear's default `list_issues` page is the
// one read that reliably blows the execute output budget — ~10 issues with full
// descriptions ≈ 26.8KB, past the truncation cap. The upstream schema is NOT
// changed; this hint only tells the caller to narrow the default request.
const LINEAR_TOOL_USAGE = {
  list_issues: 'Linear list_issues is verbose by default: pass a small `limit` (e.g. 10–20; max 250) and a minimal `fields` array such as ["id","title","status","url"], adding "description" only for the issues you actually need. A default 10-issue page can exceed the ~26.8KB execute output cap and be truncated. Page with `cursor` while hasNextPage is true.',
};

/**
 * Extra per-tool usage note for search list + select detail (no schema change).
 * Server-aware so Linear and GitHub can share a tool name (`list_issues`)
 * without leaking one service's hint onto the other.
 */
function toolUsageNote(entry) {
  const full = String(entry?.tool ?? entry?.name ?? '');
  const parts = full.split(/__/);
  const tool = parts.length > 1 ? parts[parts.length - 1] : full;
  const server = String(entry?.server ?? (parts.length > 1 ? parts[0] : '')).toLowerCase();
  const specific = server === 'linear' ? LINEAR_TOOL_USAGE[tool] : null;
  return specific ?? GH_TOOL_USAGE[tool] ?? null;
}

// Gemini new feedback #3: a read-only, in-sandbox service status helper. Kept
// out of the MCP tool schemas on purpose — changing those requires the client
// to reconnect, whereas a sandbox helper is available immediately.
//
// Honesty fix: the old wording ("check connected-service online status") made a
// cold-start snapshot look like a live health check. The guidance now says
// explicitly that services() is point-in-time evidence, that credentials can
// expire at any moment, and what to do when the provider rejects a token.
const SERVICES_GUIDANCE = ' Use codemode.services() for a cold-start snapshot of locally known services (name/toolCount/status/verifiedAt/note); it reads local state only and makes no network call. status is point-in-time evidence ("observed" = mounted with no recorded failure, "offline" = connection failed at cold start), NOT a live health check — credentials can expire at any moment and the legacy `online` flag only means "mounted at cold start". If a tool call returns invalid_token/unauthorized, the upstream needs re-auth; treat that service as stale until it is reconnected.';

// Batch 15 codemode ergonomics (2026-11-23 online feedback, PR #77–#80).
// One line each so the model can defend without trial-and-error rounds.
const B15_ERGONOMICS_GUIDANCE = [
  'File reads: fileResult(x).content / normalizeFile(x).content / readFileRange().lines are ALWAYS the pure file body — no "successfully downloaded ..." prefix; SHA and the notice live in sha/notice metadata fields. Never strip anything yourself.',
  'Batch contract: codemode.safeAll(tasks) and codemode.unwrapBatch(x) both return a FLAT array of {ok,value} slots (success: ok:true,value; failure: ok:false,value=error text). unwrapBatch accepts a single result, an envelope, or an array and always returns the same flat shape; never hand-unwrap one more layer.',
  'Truncation: if a result carries truncated:true or a truncation object, report it and re-read with readFileRange / grepSnippet; model-facing execute results may carry a `truncation` object naming the field, totalChars/totalLines, tailTruncated and continuation hints — the tail field names are preserved.',
  'Multi-file writes: prefer codemode.writeFiles (github__push_files) for N files — it commits all files in ONE atomic push; do not loop create_or_update_file. If atomic is unavailable and you still write per-file, the result carries partial:true, written[], remaining[] and a compensation string: surface it to the user and restore the written files before retrying.',
  'CI polling: codemode.waitForPrChecks({owner,repo,pullNumber,timeoutMs?,maxPolls?}) waits up to 30s in ONE call and returns the latest {status,conclusion,checkRuns[],polls,truncated} snapshot instead of 3–4 manual polls.',
].join(' ');

// Batch 17 · PR #80–#101 feedback. One line each so the new helpers are
// discoverable in BOTH execute descriptions without a probing round. No tool
// surface or default behaviour changes; all helpers are sandbox-only.
const B17_FEEDBACK_GUIDANCE = [
  'GitHub Issue creation: codemode.createIssue({owner,repo,title,body?,listArgs?,createArgs?,maxPolls?}) dedupes by repo+title/body, short-polls after create for the list-index delay, and returns {ok,created,reused,issue:{number,id,url,state,title}} — number is ALWAYS URL/field-derived, never an internal id; a repeated call is idempotent.',
  'Batch unwrapping: codemode.unwrapBatch(x) ALWAYS returns a flat [{ok,value}] array for a single result, {ok,value}, JSON string or nested array; codemode.unwrap(x) flattens one upstream envelope. Issue/PR results: codemode.unwrap fills a MISSING top-level number from a GitHub /issues/<n> or /pull/<n> URL (never overrides an existing number, never uses an internal id). Never hand-peel an extra {ok,value} layer.',
  'CI: codemode.waitForPrChecks({owner,repo,pullNumber,...}) waits up to 30s in one call; codemode.rerunFailedJobs({owner,repo,runId}) calls an injected upstream rerun tool and returns code UNSUPPORTED_UPSTREAM_TOOL when none is mounted (never a fake success).',
  'Branch cleanup: codemode.mergePrWithOptionalBranchDelete({owner,repo,pullNumber,head,deleteBranch:true}) deletes the source branch ONLY with the explicit flag and an injected delete tool; no default deletion.',
  'Multi-file delete/rename: codemode.deleteFiles({paths}) and codemode.renameFiles({renames:[{from,to}]}) are TWO-PHASE because push_files supports only {path,content}; results carry atomic:false and partial:true. Only an injected git-data callback can make them atomic — do not claim otherwise.',
  'writeFiles contract: call codemode.writeFiles({owner,repo,branch,patches:[{path,patch}],dryRun:false}) — `patches` with unified diffs, NOT the push_files {files:[...]}/{content} shape (it is rejected with an actionable error). Without dryRun:false nothing is committed: the result says dryRun:true, written:0 and carries a warning — never report that as a write.',
  'Merged PRs: a github__merge_pull_request result only carries {sha,merged,message}. Call codemode.normalizeMerge(result, {owner,repo,pullNumber}) (or a bare pull number) and the returned number/url are filled from that call identity — never from an internal id.',
].join(' ');

/**
 * Guest-side compatibility layer, injected as a single function body prefix.
 *
 * QuickJS has no TextEncoder/TextDecoder/URL/atob/crypto/timers, `console`
 * only implements `log`, and run-js-v1 drops named properties on arrays
 * (which would break codemode.search's array-with-named-props contract).
 * All of that is reconstructed here. Every exposed value is passed through
 * __dshHide() so `.constructor` never resolves to the guest Function either
 * — the isolation is real, but this also keeps the historical probes green.
 *
 * Line 1 deliberately creates a sentinel Error: its `run.js:N` frame lets the
 * host calibrate the SDK's internal wrapper offset for error line numbers.
 */
const GUEST_PRELUDE = [
  // F-06: no stable `__bridge` global for guest code. The real host bridge is
  // injected under BRIDGE_GLOBAL; this const makes any legacy probe see
  // `undefined` instead of a callable raw registry proxy. Kept on line 1 with
  // the sentinel Error so prelude line numbering stays byte-identical.
  'const __bridge = undefined; const __dshCal = (() => { const m = /run\\.js:(\\d+)/.exec(String(new Error().stack || "")); return m ? Number(m[1]) : 1; })();',
  'const __dshHide = (f) => { try { Object.defineProperty(f, "constructor", { value: undefined, configurable: true }); } catch (_) {} return f; };',
  'let __dshLineNo = 0;',
  'const __dshLine = __dshHide((n) => { __dshLineNo = n; });',
  // F-06: use the non-guessable bridge global; guest code cannot reach the raw
  // registry envelope through a stable `__bridge` name any more.
  `const __dshInvoke = (name, args) => { const r = ${BRIDGE_GLOBAL}.invoke(name, args); if (r && r.__hostError) { const e = new Error(r.message); e.name = r.type; e.__dshHostOrigin = true; if (r.code) e.code = r.code; throw e; } return r.value; };`,
  'const __dshStr = (x) => { if (typeof x === "string") return x; try { const s = JSON.stringify(x); return s === undefined ? "" : s; } catch (_) { return String(x); } };',
  'const console = __dshHide({ log: __dshHide((...a) => __dshInvoke("log", ["", a.map(__dshStr)])), info: __dshHide((...a) => __dshInvoke("log", ["", a.map(__dshStr)])), debug: __dshHide((...a) => __dshInvoke("log", ["", a.map(__dshStr)])), warn: __dshHide((...a) => __dshInvoke("log", ["WARN", a.map(__dshStr)])), error: __dshHide((...a) => __dshInvoke("log", ["ERROR", a.map(__dshStr)])) });',
  'const atob = __dshHide((s) => __dshInvoke("atob", [s]));',
  'const btoa = __dshHide((s) => __dshInvoke("btoa", [s]));',
  'const crypto = __dshHide({ digest: __dshHide((algo, data, enc) => __dshInvoke("digest", [algo, data, enc === undefined ? "hex" : enc])), createHash: __dshHide((algo) => { const parts = []; return { update(d) { parts.push(d); return this; }, digest(enc) { return __dshInvoke("digest", [algo, parts.map(__dshStr).join(""), enc === undefined ? "hex" : enc]); } }; }) });',
  'class TextEncoder { encode(s) { return new Uint8Array(__dshInvoke("encode", [String(s)])); } }',
  'class TextDecoder { decode(bytes) { return __dshInvoke("decode", [Array.from(bytes || [])]); } }',
  '__dshHide(TextEncoder); __dshHide(TextDecoder); __dshHide(TextEncoder.prototype); __dshHide(TextDecoder.prototype);',
  'class URLSearchParams { constructor(init) { this._p = {}; if (typeof init === "string") { const q = init.charAt(0) === "?" ? init.slice(1) : init; for (const pair of q.split("&")) { if (!pair) continue; const i = pair.indexOf("="); const k = i < 0 ? pair : pair.slice(0, i); const v = i < 0 ? "" : pair.slice(i + 1); try { this._p[decodeURIComponent(k.replace(/\\+/g, " "))] = decodeURIComponent(v.replace(/\\+/g, " ")); } catch (_) { this._p[k] = v; } } } else if (init && typeof init === "object") { for (const k of Object.keys(init)) this._p[k] = String(init[k]); } } get(k) { return Object.prototype.hasOwnProperty.call(this._p, k) ? this._p[k] : null; } has(k) { return Object.prototype.hasOwnProperty.call(this._p, k); } set(k, v) { this._p[k] = String(v); } toString() { return Object.keys(this._p).map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(this._p[k])).join("&"); } }',
  'class URL { constructor(input) { const s = String(input); const m = /^([A-Za-z][A-Za-z0-9+.-]*):\\/\\/([^/?#]*)([^?#]*)(\\?[^#]*)?(#.*)?$/.exec(s); if (m) { this.protocol = m[1] + ":"; this.host = m[2]; this.pathname = m[3] || "/"; this.search = m[4] || ""; this.hash = m[5] || ""; } else { this.protocol = ""; this.host = ""; this.pathname = s; this.search = ""; this.hash = ""; } this.href = s; this.searchParams = new URLSearchParams(this.search); } toString() { return this.href; } }',
  '__dshHide(URLSearchParams); __dshHide(URL); __dshHide(URLSearchParams.prototype); __dshHide(URL.prototype);',
  'const __dshSearch = __dshHide((q) => { const raw = __dshInvoke("search", [q == null ? "" : String(q)]); const matches = raw.matches.slice(); matches.matches = matches.slice(); matches.total = raw.total; matches.hint = raw.hint; return __dshHide(matches); });',
  'const search = __dshSearch;',
  'const codemode = __dshHide({});',
  'codemode.listTools = __dshHide((options) => __dshInvoke("listTools", [options]));',
  'codemode.search = __dshSearch;',
  'codemode.remainingCalls = __dshHide(() => __dshInvoke("remainingCalls", []));',
  // Gemini new feedback #3: pure-local service status helper (no network call
  // and, crucially, no new MCP tool — its schema would force a Gemini reconnect).
  'codemode.services = __dshHide(() => __dshInvoke("services", []));',
  // B14 · typed-plan host helper. Sandbox-only helper (NOT a fourth tool and
  // NOT an inputSchema change): the model calls it from an execute({code})
  // script. The real executor + io adapter live on the host; only (plan, opts)
  // cross the bridge and only a stable plain object comes back. The host forces
  // readOnly for execute_read and dryRun-by-default for execute, and never
  // throws across the boundary (errors become {ok:false,...} data).
  'codemode.runTypedPlan = __dshHide((plan, opts) => __dshInvoke("runTypedPlan", [plan, opts]));',
  // QuickJS has no event loop/timers. A microtask-based shim keeps the common
  // `await new Promise(r => setTimeout(r, 0))` pattern working without blocking
  // the host event loop (a host-side sleep would freeze the whole MCP server).
  'const __dshTimerIds = {}; let __dshTimerSeq = 0;',
  'const setTimeout = __dshHide((fn, ms, ...args) => { const id = ++__dshTimerSeq; __dshTimerIds[id] = true; Promise.resolve().then(() => { if (__dshTimerIds[id]) { try { fn(...args); } catch (_) {} } }); return id; });',
  'const clearTimeout = __dshHide((id) => { delete __dshTimerIds[id]; });',
  // Gemini feedback #4: concurrency helper. One rejected sub-task must not
  // throw away the whole batch (that used to cost a full retry round). Each
  // slot is {ok, value}; on failure `value` carries the error text, because
  // the tool bridge already reifies tool errors as data. Tasks may be promises
  // or thunks (thunks also catch *synchronous* throws during construction).
  'const __dshSafeAll = (tasks) => Promise.all((Array.isArray(tasks) ? tasks : []).map((task) => Promise.resolve().then(() => (typeof task === "function" ? task() : task)).then((value) => ({ ok: true, value }), (err) => ({ ok: false, value: err && err.message !== undefined ? String(err.message) : String(err) }))));',
  'const safeAll = __dshHide(__dshSafeAll); codemode.safeAll = safeAll;',
  // Batch 15 P1 · one flat batch contract. Every input shape (a bare value, a
  // `{ok,value}` slot, an upstream envelope, or an array of any of those)
  // produces the SAME array of {ok,value} slots. This is the ONE place that
  // decides unwrapping depth so callers never guess how many layers to peel.
  'const __dshFlattenSlot = (item) => { if (item && typeof item === "object" && !Array.isArray(item) && typeof item.ok === "boolean" && "value" in item) return { ok: item.ok, value: item.value }; if (item && typeof item === "object" && !Array.isArray(item)) { const keys = Object.keys(item); if (keys.length === 1 && (keys[0] === "result" || keys[0] === "value")) return __dshFlattenSlot(item[keys[0]]); } return { ok: true, value: item }; };',
  // Batch 17: JSON strings and `{result}`/`{value}` envelopes now go through
  // the SAME flat-slot contract as bare arrays and `{ok,value}` slots, so a
  // double-wrapped batch never reaches model code as a surprise. Nested arrays
  // are flattened. This is the single host+guest batch unwrapping contract.
  'const __dshUnwrapBatch = (input) => { let v = input; if (typeof v === "string") { try { v = JSON.parse(v); } catch (_) { return [{ ok: true, value: input }]; } } if (v === null || v === undefined) return []; const out = []; const push = (item) => { if (Array.isArray(item)) { for (const sub of item) push(sub); return; } out.push(__dshFlattenSlot(item)); }; push(v); return out; };',
  'const unwrapBatch = __dshHide(__dshUnwrapBatch); codemode.unwrapBatch = unwrapBatch;',
  // Gemini feedback #4: extract context windows around a keyword from a long
  // text — avoids hand-writing slice/indexOf loops after results get truncated.
  // Accepts string or any object (JSON-stringified). Returns an array of
  // {index, text} snippets; case-insensitive; capped at 10 snippets.
  // P0 batch 11: a snippet is a char-window slice of a line. It MUST say so —
  // the captured model bug was exactly an unmarked `l.slice(0,150)`.
  'const __dshGrepSnippet = (input, keyword, window) => { const s = typeof input === "string" ? input : JSON.stringify(input); if (!s || !keyword) return []; const w = Math.max(20, Math.min(Number(window) || 300, 4000)); const needle = String(keyword).toLowerCase(); const hay = s.toLowerCase(); const out = []; let from = 0; while (out.length < 10) { const i = hay.indexOf(needle, from); if (i < 0) break; const start = Math.max(0, i - Math.floor(w / 2)); const end = Math.min(s.length, start + w); const clipped = start > 0 || end < s.length; const item = { index: i, text: s.slice(start, end), fullLength: s.length, truncated: clipped }; if (clipped) item.truncation = { reason: "grepWindow", window: w, start: start, end: end, detail: "grepSnippet char window; use readFileRange to get the full line" }; out.push(item); from = i + needle.length; } return out; };',
  'const grepSnippet = __dshHide(__dshGrepSnippet); codemode.grepSnippet = grepSnippet;',
  // Inconsistent upstream result shapes: normalize defensively without ever
  // throwing. Ambiguous payloads are returned untouched so the model can still
  // inspect the original envelope (mirrors tool-format.js's unwrapResult
  // conventions: structuredContent wins when sole, text beats duplicate
  // resource bodies, mixed/non-text blocks stay un-collapsed).
'const __dshTruncMarkerAtTail = (text) => { if (typeof text !== "string" || !text) return false; const tail = text.length > 256 ? text.slice(-256) : text; return tail.indexOf("--- TRUNCATED ---") >= 0 || /…\\s*\\[truncated\\s*\\d*/.test(tail); };',
  'const __dshFillGithubNumber = (value) => { try { if (!value || typeof value !== "object" || Array.isArray(value)) return value; if (value.number !== undefined && value.number !== null) return value; const url = value.html_url !== undefined && value.html_url !== null ? value.html_url : (value.url !== undefined && value.url !== null ? value.url : (value.web_url !== undefined && value.web_url !== null ? value.web_url : value.issue_url)); if (typeof url !== "string" || !/^https?:\\/\\/(?:api\\.)?github\\.com\\//i.test(url)) return value; const m = /\\/(?:issues|pull)\\/(\\d+)(?:[/?#]|$)/.exec(url); if (!m) return value; const copy = {}; for (const k of Object.keys(value)) copy[k] = value[k]; copy.number = Number(m[1]); return copy; } catch (_) { return value; } };',
  'const __dshUnwrapRaw = (value) => { try { if (typeof value === "string") { try { return JSON.parse(value); } catch (_) { return value; } } if (value === null || typeof value !== "object" || Array.isArray(value)) return value; const own = (k) => Object.prototype.hasOwnProperty.call(value, k); const hasText = own("text") && typeof value.text === "string"; const hasContent = own("content") && Array.isArray(value.content); const hasResult = own("result"); const hasSC = own("structuredContent") && value.structuredContent !== undefined; if (hasSC && !hasText && !hasContent && !hasResult) return value.structuredContent; if (hasResult && !hasSC && !hasText && !hasContent) return value.result; if (hasText && own("resources") && Array.isArray(value.resources)) return value.text; if (hasContent) { const candidates = []; for (const c of value.content) { if (!c || typeof c !== "object") return value; let body; if (c.type === "text" || c.type === undefined) { if (typeof c.text !== "string") return value; body = c.text; } else if (c.type === "resource") { const res = c.resource; if (!res || typeof res !== "object" || typeof res.text !== "string") return value; body = res.text; } else { return value; } if (candidates.indexOf(body) < 0) candidates.push(body); } if (candidates.length !== 1) return value; const s = candidates[0]; try { return JSON.parse(s); } catch (_) { return s; } } return value; } catch (_) { return value; } };',
  'const __dshUnwrap = (value) => __dshFillGithubNumber(__dshUnwrapRaw(value));',
  'const unwrap = __dshHide(__dshUnwrap); codemode.unwrap = unwrap;',
  // QuickJS has no Intl. Give a small, explicit UTC formatter instead of
  // pretending a partial Intl polyfill is complete. Models that reach for
  // Intl get a guidance line in the execute description; this helper covers
  // the common date-range use case (Notion/GitHub/Vercel timestamps).
  'const __dshFormatDate = (value, options) => { const d = value === undefined || value === null ? new Date() : (value instanceof Date ? value : new Date(value)); if (!(d instanceof Date) || isNaN(d.getTime())) throw new Error("formatDate: invalid date value"); const o = options && typeof options === "object" ? options : {}; const pad = (n) => (n < 10 ? "0" : "") + n; const date = d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate()); const time = pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes()) + ":" + pad(d.getUTCSeconds()); if (o.date && !o.time) return date; if (o.time && !o.date) return time; if (o.date && o.time) return date + "T" + time + (o.ms ? "." + String(d.getUTCMilliseconds()).padStart(3, "0") : "") + "Z"; return d.toISOString(); };',
  'const formatDate = __dshHide(__dshFormatDate); codemode.formatDate = formatDate;',
  'const nowISO = __dshHide(() => new Date().toISOString()); codemode.nowISO = nowISO;',
  // Large files: the sandbox can hold the full upstream text, but the model
  // only needs a line range. Returning this object keeps the payload bounded
  // and makes truncation explicit instead of guessed.
  'const __dshSliceLines = (value, startLine, endLine) => { const normalize = (x) => typeof x === "string" ? x : __dshStr(x); const text = normalize(value).replace(/\\r\\n?/g, "\\n"); const lines = text.split("\\n"); const total = lines.length; let start = Math.floor(Number(startLine)); if (!Number.isFinite(start) || start < 1) start = 1; let end = Math.floor(Number(endLine)); if (!Number.isFinite(end)) end = Math.min(total, start + 199); if (end < start) end = start - 1; if (end > total) end = total; const slice = start <= end ? lines.slice(start - 1, end).join("\\n") : ""; return { text: slice, startLine: start, endLine: end, totalLines: total, truncated: start > 1 || end < total }; };',
  'const sliceLines = __dshHide(__dshSliceLines); codemode.sliceLines = sliceLines;',
  // P0 batch 11 · typed line-range read primitive.
  //
  // Design contract (do not weaken):
  //   - `path` is required; the file is fetched through the SAME tool bridge as
  //     every other codemode call (`tools.readTool`, default GitHub read tool).
  //   - Content extraction REUSES codemode.normalizeFile (host canonical
  //     adapter) with codemode.fileResult as fallback. No second upstream read
  //     implementation, no second shape parser.
  //   - No `maxCharsPerLine` => NO character truncation at all, ever.
  //   - With `maxCharsPerLine`, each over-long line is cut AND the result
  //     carries `truncated:true` + `truncation.reason:'maxCharsPerLine'` plus
  //     the 1-based line numbers that were cut.
  //   - Line-range clipping and upstream truncation are also reported.
  'const __dshReadFileRange = async (opts) => {',
  '  const o = opts && typeof opts === "object" ? opts : {};',
  '  if (typeof o.path !== "string" || o.path.length === 0) return { ok: false, error: "readFileRange: path must be a non-empty string" };',
  '  let cap = null;',
  '  if (o.maxCharsPerLine !== undefined && o.maxCharsPerLine !== null) {',
  '    const n = Number(o.maxCharsPerLine);',
  '    if (!Number.isFinite(n) || n <= 0) return { ok: false, error: "readFileRange: maxCharsPerLine must be a positive finite number" };',
  '    cap = Math.floor(n);',
  '  }',
  '  const names = __dshB10Cfg(o.tools || {}, { readTool: "github__get_file_contents" });',
  '  const readArgs = Object.assign({}, o.readArgs || {}, { owner: o.owner, repo: o.repo, path: o.path });',
  '  if (o.branch !== undefined) readArgs.ref = readArgs.ref || o.branch;',
  '  let raw;',
  '  try { raw = await __dshCallTool(names.readTool, readArgs); } catch (e) { __dshB10Rethrow(e); return { ok: false, error: "readFileRange: read failed for " + o.path + ": " + __dshB10Str(e && e.message ? e.message : e) }; }',
  '  const nf = codemode.normalizeFile(raw, names.readTool);',
  '  let text = nf && typeof nf.content === "string" ? nf.content : null;',
  '  if (text === null) { const fr = codemode.fileResult(raw); text = typeof fr.content === "string" ? fr.content : null; }',
  '  if (text === null) return { ok: false, error: "readFileRange: read did not yield file text: " + o.path };',
  '  const normalized = text.replace(/\\r\\n?/g, "\\n");',
  '  const allLines = normalized.split("\\n");',
  '  const totalLines = allLines.length;',
  '  let start = Math.floor(Number(o.startLine));',
  '  if (!Number.isFinite(start) || start < 1) start = 1;',
  '  if (start > totalLines) start = totalLines;',
  '  let end = Math.floor(Number(o.endLine));',
  '  if (!Number.isFinite(end)) end = totalLines;',
  '  if (end < start) end = start - 1;',
  '  if (end > totalLines) end = totalLines;',
  '  const lines = [];',
  '  const cappedLines = [];',
  '  for (let i = start; i <= end; i += 1) {',
  '    const line = allLines[i - 1];',
  '    if (cap !== null && line.length > cap) { lines.push(line.slice(0, cap)); cappedLines.push(i); }',
  '    else lines.push(line);',
  '  }',
  '  const omittedBefore = start - 1;',
  '  const omittedAfter = totalLines - end;',
  '  const rangeClipped = omittedBefore > 0 || omittedAfter > 0;',
  '  const pickTruncationDetail = (v) => { if (!v || typeof v !== "object") return null; const t = v.truncation !== undefined ? v.truncation : (v.result && typeof v.result === "object" ? v.result.truncation : undefined); if (t === undefined || t === null) return null; if (typeof t === "string") return t.slice(0, 160); const r = t.reason !== undefined ? t.reason : (t.detail !== undefined ? t.detail : t.message); return r === undefined ? "upstream truncation object" : __dshB10Str(r).slice(0, 160); };',
  '  const upstreamDetail = pickTruncationDetail(raw) || pickTruncationDetail(nf);',
  '  const upstreamTruncated = Boolean(nf && nf.truncated) || __dshTruncMarkerAtTail(normalized) || upstreamDetail !== null;',
  '  const truncated = rangeClipped || cappedLines.length > 0 || upstreamTruncated;',
  '  const reasons = [];',
  '  if (rangeClipped) reasons.push({ reason: "lineRange", omittedBefore: omittedBefore, omittedAfter: omittedAfter });',
  '  if (cappedLines.length) reasons.push({ reason: "maxCharsPerLine", maxCharsPerLine: cap, lines: cappedLines, detail: "lines exceeded maxCharsPerLine and were cut at the character boundary" });',
  '  if (upstreamTruncated) reasons.push({ reason: "upstream", detail: upstreamDetail || "upstream file read reported truncated" });',
  '  const out = { lines: lines, truncated: truncated, nextStart: omittedAfter > 0 ? end + 1 : null, totalLines: totalLines };',
  '  if (truncated) out.truncation = reasons.length === 1 ? reasons[0] : { reason: "multiple", causes: reasons };',
  '  return out;',
  '};',
  'codemode.readFileRange = __dshHide(__dshReadFileRange);',
  // Common capability shapes: upstreams disagree on file/PR field names. These
  // helpers are best-effort flat views; they never throw and return `null` for
  // fields they cannot find (callers can still inspect the original value).
  // Batch 15 P0 · the guest helper used to prefer `text`; GitHub's
  // "{text:download notice + body, resources:[{text:body}]}" shape therefore
  // put the notice on line 1 of written files. Narrow notice regex only;
  // resources[].text wins whenever it is present alongside text. Keep the
  // exact six-field return set (callers rely on it).
  'const __dshFileNotice = /^successfully downloaded text file \\(SHA: ([0-9a-f]+)(?:,[^)]*)?\\)[ \\t]*(?:\\r?\\n)?/i;',
  'const __dshStripFileNotice = (s) => { if (typeof s !== "string") return { text: s, sha: null, notice: null }; const m = __dshFileNotice.exec(s); return m ? { text: s.slice(m[0].length), sha: m[1], notice: m[0].trim() } : { text: s, sha: null, notice: null }; };',
  // A notice is metadata, never file text. Apply this at EVERY body source.
  'const __dshPureFileText = (s) => { const r = __dshStripFileNotice(s); return { text: typeof r.text === "string" ? r.text : "", sha: r.sha, notice: r.notice }; };',
  // Batch 15 GPT online fix — parse a real file path out of a GitHub resource
  // URI (`repo://owner/repo/contents/<path>`). Never return the raw URI as a
  // path; never guess when there is no marker.
  'const __dshPathFromUri = (uri) => { if (typeof uri !== "string" || !uri.length) return null; const idx = uri.indexOf("/contents/"); if (idx >= 0) { const p = uri.slice(idx + 10).split(/[?#]/)[0]; if (p.length) { try { return decodeURIComponent(p); } catch (_) { return p; } } return null; } if (/^repo:\\/\\//i.test(uri)) { const parts = uri.slice(7).split(/[?#]/)[0].split("/").filter(Boolean); if (parts.length >= 3) return parts.slice(2).join("/"); } return null; };',
  'const __dshResourceText = (o) => { if (!o || typeof o !== "object") return null; const nested = o.result && typeof o.result === "object" ? o.result : o; const list = Array.isArray(nested.resources) ? nested.resources : (Array.isArray(o.resources) ? o.resources : []); const seen = []; const parts = []; for (const r of list) { let t = null; if (typeof r === "string") t = r; else if (r && typeof r === "object") { t = typeof r.text === "string" ? r.text : (r.resource && typeof r.resource.text === "string" ? r.resource.text : null); } if (t !== null && seen.indexOf(t) < 0) { seen.push(t); parts.push(t); } } return parts.length ? parts.join("\\n") : null; };',
  // Batch 15 GPT online fix — scan the ORIGINAL result envelope (not the
  // unwrapped v2, which may have collapsed to a string) for a resource URI.
  'const __dshResourcePath = (o) => { if (!o || typeof o !== "object") return null; const roots = [o]; if (o.result && typeof o.result === "object") roots.push(o.result); for (const root of roots) { const explicit = root.path || root.file_path || root.filePath; if (typeof explicit === "string" && explicit.length) return explicit; const lists = [root.resources, root.content]; for (const list of lists) { if (!Array.isArray(list)) continue; for (const r of list) { const inner = r && typeof r === "object" && r.resource && typeof r.resource === "object" ? r.resource : r; const p = __dshPathFromUri(inner && typeof inner === "object" ? inner.uri : null); if (p !== null) return p; } } const direct = __dshPathFromUri(root.uri); if (direct !== null) return direct; } return null; };',
  // Batch 15 P0: `content` is ALWAYS pure body; notice/SHA are metadata only.
  // Keeps the historical six enumerable fields; `notice` is non-enumerable so
  // the stable field set asserted by older callers is unchanged.
  'const __dshFileResult = (value) => { const pick = (o, keys) => { if (!o || typeof o !== "object") return undefined; for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k]; return undefined; }; let v; try { v = __dshUnwrap(value); } catch (_) { v = value; } const fromResourcesRaw = __dshResourceText(value) || __dshResourceText(v); const fromResources = fromResourcesRaw === null ? null : __dshPureFileText(fromResourcesRaw); let noticeSha = fromResources ? fromResources.sha : null; let notice = fromResources ? fromResources.notice : null; let v2 = v; if (typeof v2 === "string") { const s = __dshPureFileText(v2); noticeSha = noticeSha || s.sha; notice = notice || s.notice; v2 = s.text; } if (typeof v2 === "object" && v2 !== null) { const nested = v2.result && typeof v2.result === "object" ? v2.result : v2; const c = pick(nested, ["content", "text", "data"]); if (typeof c === "string") { const s = __dshPureFileText(c); noticeSha = noticeSha || s.sha; notice = notice || s.notice; const copy = {}; for (const k of Object.keys(nested)) copy[k] = nested[k]; copy.content = fromResources ? fromResources.text : s.text; copy.__dshShaFromNotice = noticeSha; v2 = copy; } } if (typeof v2 === "string") { const body = fromResources ? fromResources.text : v2; const out = { content: body, size: body.length, sha: noticeSha, path: __dshResourcePath(value), encoding: null, truncated: __dshTruncMarkerAtTail(body) }; Object.defineProperty(out, "notice", { value: notice, enumerable: false, configurable: true, writable: true }); return out; } const root = v2 && typeof v2 === "object" ? v2 : {}; const nested = root.result && typeof root.result === "object" ? root.result : root; let content = fromResources ? fromResources.text : pick(nested, ["content", "text", "data"]); if (typeof content !== "string") { const resources = Array.isArray(nested.resources) ? nested.resources : []; const joined = resources.map((r) => r && typeof r.text === "string" ? __dshPureFileText(r.text).text : "").filter(Boolean).join("\\n"); if (joined) content = joined; } const stripped = __dshPureFileText(typeof content === "string" ? content : ""); content = stripped.text; noticeSha = noticeSha || stripped.sha || __dshStripFileNotice(String(pick(nested, ["text", "content", "data"]) ?? "")).sha || root.__dshShaFromNotice; notice = notice || stripped.notice; const sha = pick(nested, ["sha", "sha256", "content_sha", "commit_sha"]) ?? noticeSha ?? null; const path = __dshResourcePath(value) ?? (() => { const explicit = pick(nested, ["path", "name", "file_path", "filePath"]); if (explicit !== undefined) return explicit; const list = (Array.isArray(nested.resources) ? nested.resources : []).concat(Array.isArray(nested.content) ? nested.content : []); for (const r of list) { const inner = r && typeof r === "object" && r.resource && typeof r.resource === "object" ? r.resource : r; const parsed = __dshPathFromUri(inner && typeof inner === "object" ? pick(inner, ["uri"]) : null); if (parsed !== null) return parsed; } const direct = __dshPathFromUri(pick(nested, ["uri"])); return direct === null ? null : direct; })(); const encoding = pick(nested, ["encoding"]); const rawSize = pick(nested, ["size", "bytes"]); const out = { content: typeof content === "string" ? content : null, sha: sha, size: Number(rawSize ?? (typeof content === "string" ? content.length : 0)) || 0, path: path ?? null, encoding: encoding ?? null, truncated: Boolean(nested.truncated) || Boolean(nested.isTruncated) || __dshTruncMarkerAtTail(String(content ?? "")) }; Object.defineProperty(out, "notice", { value: notice, enumerable: false, configurable: true, writable: true }); return out; };',
  'const fileResult = __dshHide((v) => { try { return __dshFileResult(v); } catch (_) { return { content: null, sha: null, size: 0, path: null, encoding: null, truncated: false }; } }); codemode.fileResult = fileResult;',
  // Batch 15 P0: notice is metadata, never content. `fileMeta` exposes it
  // explicitly without changing fileResult's stable six-field shape.
  'codemode.fileMeta = __dshHide((v, toolName) => { try { const nf = codemode.normalizeFile(v, toolName); return { notice: nf.notice ?? null, noticeSha: nf.noticeSha ?? nf.sha ?? null, truncated: Boolean(nf.truncated), truncation: nf.truncation ?? null }; } catch (_) { return { notice: null, noticeSha: null, truncated: false, truncation: null }; } });',
  // Batch 15 GPT online fix — additive PR identifiers. `id` (DB id) and
  // `nodeId` (GraphQL node_id) are exposed as separate strings, and NEVER
  // used as the PR number: `number` stays URL-first.
  'const __dshPrResult = (value) => { const pick = (o, keys) => { if (!o || typeof o !== "object") return undefined; for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k]; return undefined; }; const asString = (x) => (x === undefined || x === null ? null : String(x)); let v; try { v = __dshUnwrap(value); } catch (_) { v = value; } const root = v && typeof v === "object" ? v : {}; const nested = root.result && typeof root.result === "object" ? root.result : root; const url = pick(nested, ["html_url", "url", "web_url"]); const fromUrl = (() => { const m = /\\/pulls?\\/(\\d+)(?:\\/|$|\\?)/.exec(String(url ?? "")); return m ? Number(m[1]) : null; })(); const numberRaw = pick(nested, ["number", "prNumber", "pr_number"]); const numFromField = numberRaw !== undefined && Number.isFinite(Number(numberRaw)) ? Number(numberRaw) : null; const number = fromUrl !== null ? fromUrl : numFromField; const sha = pick(nested, ["sha", "head_sha", "headSha"]); return { number: number, url: url ?? null, sha: sha ?? null, id: asString(pick(nested, ["id"])), nodeId: asString(pick(nested, ["node_id", "nodeId"])) }; };',
  'const prResult = __dshHide((v) => { try { return __dshPrResult(v); } catch (_) { return { number: null, url: null, sha: null, id: null, nodeId: null }; } }); codemode.prResult = prResult;',
  // Advanced file editing: line-range replace, unified diff apply, diff summary.
  // These are sandbox-local string helpers; failures return {ok:false,error}
  // and never partially write.
  'const __dshNormalizeText = (x) => (typeof x === "string" ? x : __dshStr(x)).replace(/\\r\\n?/g, "\\n");',
  'const __dshReplaceLines = (value, startLine, endLine, newText) => { try { const text = __dshNormalizeText(value); const lines = text.split("\\n"); const total = lines.length; let start = Math.floor(Number(startLine)); let end = Math.floor(Number(endLine)); if (!Number.isFinite(start)) start = 1; if (!Number.isFinite(end)) end = start; if (start < 1) start = 1; if (start > total + 1) return { ok: false, error: "startLine out of range", text: text, totalLines: total }; if (end < start) end = start - 1; if (end > total) end = total; const inserted = (newText === undefined || newText === null || newText === "") ? [] : __dshNormalizeText(newText).split("\\n"); const out = lines.slice(0, start - 1).concat(inserted, lines.slice(end)); return { ok: true, text: out.join("\\n"), startLine: start, endLine: end, totalLines: total, added: inserted.length, removed: Math.max(0, end - start + 1) }; } catch (e) { return { ok: false, error: String(e && e.message ? e.message : e), text: __dshNormalizeText(value) }; } };',
  'const replaceLines = __dshHide(__dshReplaceLines); codemode.replaceLines = replaceLines;',
  'const __dshDiffSummary = (before, after) => { try { const a = __dshNormalizeText(before).split("\\n"); const b = __dshNormalizeText(after).split("\\n"); let p = 0; while (p < a.length && p < b.length && a[p] === b[p]) p += 1; let ea = a.length - 1; let eb = b.length - 1; while (ea >= p && eb >= p && a[ea] === b[eb]) { ea -= 1; eb -= 1; } return { beforeLines: a.length, afterLines: b.length, added: Math.max(0, eb - p + 1), removed: Math.max(0, ea - p + 1), changed: a.length !== b.length || p < a.length || p < b.length }; } catch (_) { return { beforeLines: 0, afterLines: 0, added: 0, removed: 0, changed: false }; } };',
  'const diffSummary = __dshHide(__dshDiffSummary); codemode.diffSummary = diffSummary;',
  'const __dshApplyPatch = (value, patch) => { try { const source = __dshNormalizeText(value); const lines = source.split("\\n"); const plines = __dshNormalizeText(patch).split("\\n"); const hunks = []; let i = 0; while (i < plines.length) { const m = /^@@ -(\\d+)(?:,(\\d+))? \\+(\\d+)(?:,(\\d+))? @@/.exec(plines[i]); if (!m) { i += 1; continue; } const h = { oldStart: Number(m[1]), lines: [] }; i += 1; while (i < plines.length && !/^@@ /.test(plines[i])) { const l = plines[i]; if (l.startsWith("--- ") || l.startsWith("+++ ")) { i += 1; continue; } if (l.startsWith("\\\\")) { i += 1; continue; } if (l.length > 0 && (l[0] === " " || l[0] === "+" || l[0] === "-")) { h.lines.push({ op: l[0], text: l.slice(1) }); i += 1; } else { break; } } hunks.push(h); } if (hunks.length === 0) return { ok: false, error: "no hunks", text: source }; const out = []; let cursor = 0; let added = 0; let removed = 0; for (const h of hunks) { const idx = h.oldStart > 0 ? h.oldStart - 1 : 0; if (idx < cursor || idx > lines.length) return { ok: false, error: "hunk out of range", text: source }; out.push.apply(out, lines.slice(cursor, idx)); let src = idx; for (const l of h.lines) { if (l.op === " " || l.op === "-") { if (src >= lines.length || lines[src] !== l.text) return { ok: false, error: "context mismatch at line " + (src + 1), text: source }; src += 1; if (l.op === " ") out.push(l.text); else removed += 1; } else if (l.op === "+") { out.push(l.text); added += 1; } } cursor = src; } out.push.apply(out, lines.slice(cursor)); return { ok: true, text: out.join("\\n"), hunks: hunks.length, added: added, removed: removed }; } catch (e) { return { ok: false, error: String(e && e.message ? e.message : e), text: __dshNormalizeText(value) }; } };',
  'const applyPatch = __dshHide(__dshApplyPatch); codemode.applyPatch = applyPatch;',
  // ------------------------------------------------------------------ //
  // B10 integration: canonical adapters + upstream orchestration helpers.
  //
  // The `run` SDK bridge uses structured cloning, so guest functions cannot be
  // passed to host functions. Canonical normalize therefore goes through a
  // dedicated bridge function (host imports result-normalize.js); the stateful
  // orchestration helpers are implemented here in the guest and call upstream
  // tools via the existing `__dshInvoke("tool", [ident, args])` path — i.e. the
  // exact same tool bridge as `codemode.<tool>(args)`. No token/private API is
  // embedded; tool names are configurable and default to the public whitelist.
  'const __dshNormalize = __dshHide((kind, toolName, value, context) => __dshInvoke("normalizeResult", [kind, toolName, value, context]));',
  'codemode.normalizeFile = __dshHide((value, toolName) => __dshNormalize("file", toolName === undefined ? "get_file_contents" : toolName, value));',
  'codemode.normalizePr = __dshHide((value, toolName) => __dshNormalize("pr", toolName === undefined ? "get_pull_request" : toolName, value));',
  'codemode.normalizeIssue = __dshHide((value, toolName) => __dshNormalize("issue", toolName === undefined ? "get_issue" : toolName, value));',
  'codemode.normalizeResult = __dshHide((toolName, value) => __dshNormalize("dispatch", toolName, value));',
  // PR #41–#48: canonical {number,url,sha} for PR / Issue / merge / write
  // results, plus a pure write-before precheck (host adapters, data-only bridge).
  'codemode.canonicalize = __dshHide((value, context) => __dshInvoke("canonicalize", [value, context]));',
  // Issue #15 / BC-011: a merge result only carries {sha,merged,message}. Pass
  // the identity you already used ({owner,repo,pullNumber} or just the number)
  // as the second argument and the host fills a non-null number/url from it.
  'codemode.normalizeMerge = __dshHide((value, context) => __dshNormalize("merge", "", value, context));',
  'codemode.precheckText = __dshHide((text, path) => __dshInvoke("precheckText", [text, path]));',
  // Generic tool caller used by every orchestration helper below. It goes
  // through the SAME bridge as codemode.<tool>(), so tool-call budget, audit
  // and read-only dedup all apply; no new privilege is introduced.
  // Bridge-level failures (tool-call budget, unknown tool) must never be
  // converted into `{ok:false}` data by a helper's try/catch — they are
  // sandbox boundary errors and have to propagate to execute()'s error path.
  'const __dshBridgeError = (e) => { const m = e && e.message !== undefined ? String(e.message) : ""; return /tool call limit|unknown tool|unknown bridge function|Host function failed/.test(m); };',
  'const __dshCallTool = __dshHide((ident, args) => __dshInvoke("tool", [ident, args]));',
  'const __dshB10Rethrow = (e) => { if (__dshBridgeError(e)) throw e; };',
  // ---- shared small utilities (ported from host github-helpers/file-write) ----
  'const __dshB10Str = (x) => (typeof x === "string" ? x : (x === null || x === undefined ? "" : String(x)));',
  'const __dshB10ToArray = (v) => { if (Array.isArray(v)) return v; if (v && typeof v === "object") { for (const k of ["items", "data", "result", "branches", "values"]) if (Array.isArray(v[k])) return v[k]; const c = Array.isArray(v.content) ? v.content : null; if (c) for (const part of c) { if (part && typeof part.text === "string") { try { const arr = __dshB10ToArray(JSON.parse(part.text)); if (arr.length) return arr; } catch (_) {} } } } return []; };',
  'const __dshB10Need = (fn, name) => { if (typeof fn !== "function") throw new Error(name + " must be a function"); return fn; };',
  'const __dshB10Cfg = (tools, defaults) => { const t = tools && typeof tools === "object" ? tools : {}; const out = {}; for (const k of Object.keys(defaults)) out[k] = t[k] !== undefined && t[k] !== null && t[k] !== "" ? t[k] : defaults[k]; return out; };',
  // ---- applyFilePatch: read -> strict patch -> optional write via tools ----
  // Defaults verified against data/tool-dataset.json (GitHub MCP whitelist):
  //   github__get_file_contents({owner,repo,path,ref}) -> {content,sha,...}
  //   github__create_or_update_file({owner,repo,path,content,message,branch,sha})
  // PR #41–#48: ONE unified entry for single and multi-file patches. Both use
  // the same read -> strict patch -> write-before precheck -> staged write path and
  // both return top-level {ok,files,diff,sha,commitSha,number?,url?}. `sha` is
  // auto-filled from the read result when the caller omits it, so a single-file
  // update does not need a separate get_file_contents round trip by the model.
  'const __dshB10ApplyFilePatch = async (opts) => {',
  '  const o = opts && typeof opts === "object" ? opts : {};',
  // Issue #15 / BC-012: `files:[...]` is the github__push_files shape, not a
  // patch batch. Rejecting it explicitly beats validating a phantom path and
  // leaving the caller to believe the write silently succeeded.
  '  if (!Array.isArray(o.patches) && Array.isArray(o.files) && o.files.length > 0) return { ok: false, error: "writeFiles/applyFilePatch expect {patches:[{path,patch}]} but received files[] (the github__push_files shape). Rename files->patches and give every item a unified-diff `patch` string; files[i].content is full-file content and is not applied here.", hint: "codemode.writeFiles({ owner, repo, branch, patches: [{ path, patch }], dryRun: false })", written: 0, partial: false };',
  '  const names = __dshB10Cfg(o.tools, { readTool: "github__get_file_contents", writeTool: "github__create_or_update_file", pushTool: "github__push_files" });',
  '  const list = Array.isArray(o.patches) ? o.patches : [{ path: o.path, patch: o.patch, sha: o.sha }];',
  '  if (!list.length) return { ok: false, error: "patches must be a non-empty array (or provide path+patch)" };',
  '  const dryRun = o.dryRun !== false;',
  // Batch 11: atomic mode is ON by default when github__push_files is exposed.
  '  const pushAvailable = __dshInvoke("hasTool", [names.pushTool]) === true;',
  '  const atomic = o.atomic === true ? true : (o.atomic === false ? false : pushAvailable);',
  '  const atomicReason = atomic ? null : (pushAvailable ? "atomic write explicitly disabled by caller" : "github__push_files unavailable; using per-file writes");',
  // Explicit atomic:true with no committer is a HARD failure: zero reads, zero writes.
  '  if (o.atomic === true && !pushAvailable) return { ok: false, error: "atomic write requested but github__push_files is unavailable", atomic: false, reason: "github__push_files unavailable", files: [], written: [], writtenFiles: [], partial: false };',
  '  const staged = [];',
  '  for (const item of list) {',
  '    if (!item || typeof item.path !== "string" || !item.path) return { ok: false, error: "path must be a non-empty string" };',
  '    if (typeof item.patch !== "string") return { ok: false, error: "patch must be a string" };',
  '    const readArgs = Object.assign({}, o.readArgs || {}, { owner: o.owner, repo: o.repo, path: item.path });',
  '    if (o.branch !== undefined) readArgs.ref = readArgs.ref || o.branch;',
  '    let raw;',
  '    try { raw = await __dshCallTool(names.readTool, readArgs); } catch (e) { __dshB10Rethrow(e); return { ok: false, error: "read failed for " + item.path + ": " + __dshB10Str(e && e.message ? e.message : e) }; }',
  '    const nf = codemode.normalizeFile(raw, names.readTool);',
  '    let text = nf.content;',
  '    if (typeof text !== "string") { const fr = codemode.fileResult(raw); text = fr.content; }',
  '    if (typeof text !== "string") return { ok: false, error: "read did not yield file text: " + item.path };',
  // P0 batch 11: never patch/write on a truncated read. A patch against a
  // partial file would silently destroy the unread tail when written back.
    '    if (nf.truncated || __dshTruncMarkerAtTail(text)) return { ok: false, error: "refusing to patch a truncated read for " + item.path + ": re-read the full file before writing" };',
  '    const applied = codemode.applyPatch(text, item.patch);',
  '    if (!applied.ok) return { ok: false, error: item.path + ": " + applied.error };',
  '    const checked = __dshInvoke("precheckText", [applied.text, item.path]);',
  '    if (!checked.ok) return { ok: false, error: item.path + ": " + checked.error, precheck: checked.check };',
  '    const sha = (item.sha !== undefined && item.sha !== null && item.sha !== "") ? String(item.sha) : (nf.sha || null);',
  '    staged.push({ path: item.path, text: applied.text, sha: sha, before: text, added: applied.added, removed: applied.removed, hunks: applied.hunks });',
  '  }',
  '  const diffs = staged.map((s) => {',
  '    const beforeLines = s.before.replace(/\\r\\n?/g, "\\n").split("\\n");',
  '    const afterLines = s.text.split("\\n");',
  '    let p = 0; while (p < beforeLines.length && p < afterLines.length && beforeLines[p] === afterLines[p]) p += 1;',
  '    const header = "--- a/" + s.path + "\\n+++ b/" + s.path + "\\n@@ -" + (p + 1) + "," + Math.max(0, beforeLines.length - p) + " +" + (p + 1) + "," + Math.max(0, afterLines.length - p) + " @@";',
  '    return { path: s.path, added: s.added, removed: s.removed, hunks: s.hunks, diff: header };',
  '  });',
  '  const files = staged.map((s) => ({ path: s.path, sha: s.sha }));',
  '  const diff = staged.length === 1 ? diffs[0] : diffs;',
  '  const out = { ok: true, files: files, diff: diff };',
  '  if (dryRun) {',
  // Issue #15 / BC-012: a preview must never look like a completed write.
  '    const dryOut = Object.assign({}, out, { dryRun: true, written: 0, writtenFiles: [], warning: "dryRun is ON (default): NO files were written and no commit was created. Pass dryRun:false to actually commit these patches." });',
  // B10 compatibility: preserve the legacy dry-run shape in non-atomic mode.
  '    if (!atomic) return dryOut;',
  '    return Object.assign({}, dryOut, { atomic: true });',
  '  }',
  // ---- atomic path: one push_files call, zero partial writes on failure ----
  '  if (atomic) {',
  '    const pushArgs = Object.assign({}, o.pushArgs || {}, { owner: o.owner, repo: o.repo, branch: o.branch, files: staged.map((s) => ({ path: s.path, content: s.text })), message: o.message === undefined ? "batch write via codemode" : o.message });',
  '    let pr;',
  '    try { pr = await __dshCallTool(names.pushTool, pushArgs); } catch (e) { __dshB10Rethrow(e); return { ok: false, error: "atomic commit failed: " + __dshB10Str(e && e.message ? e.message : e), atomic: false, files: [], written: [], writtenFiles: [], partial: false, diff: diff }; }',
  '    const pv = pr && typeof pr === "object" && pr.ok === false ? pr : (() => { try { return typeof pr === "string" ? JSON.parse(pr) : pr; } catch (_) { return pr; } })();',
  '    if (pv && typeof pv === "object" && pv.ok === false) return { ok: false, error: __dshB10Str(pv.error || "atomic commit failed"), atomic: false, files: [], written: [], writtenFiles: [], partial: false, diff: diff };',
  '    const top = __dshInvoke("normalizeWriteResult", [pv, staged[staged.length - 1].sha]);',
  '    return Object.assign({}, out, top, { atomic: true });',
  '  }',
  // ---- non-atomic / fallback: legacy per-file writes with honest partial report ----
  '  const written = [];',
  '  let last;',
  '  const __dshB10Partial = (error) => ({ ok: false, error: error, atomic: false, partial: true, written: written.slice(), writtenFiles: written.slice(), remaining: staged.slice(written.length).map((s) => s.path), compensation: written.length ? "Restore the " + written.length + " already-written file(s) from their previous contents, or re-run with atomic:true (github__push_files) so the whole batch commits once." : "No files were written; safe to retry.", files: files, diff: diff, reason: atomicReason });',
  '  for (const s of staged) {',
  '    const writeArgs = Object.assign({}, o.writeArgs || {}, { owner: o.owner, repo: o.repo, path: s.path, content: s.text, branch: o.branch, message: o.message === undefined ? "patch via codemode" : o.message });',
  '    if (s.sha) writeArgs.sha = s.sha;',
  '    let wr;',
  '    try { wr = await __dshCallTool(names.writeTool, writeArgs); } catch (e) { __dshB10Rethrow(e); return __dshB10Partial("write failed for " + s.path + ": " + __dshB10Str(e && e.message ? e.message : e)); }',
  '    const wv = wr && typeof wr === "object" && wr.ok === false ? wr : (() => { try { return typeof wr === "string" ? JSON.parse(wr) : wr; } catch (_) { return wr; } })();',
  '    if (wv && typeof wv === "object" && wv.ok === false) return __dshB10Partial(__dshB10Str(wv.error || "write failed"));',
  '    written.push(s.path);',
  '    last = wv;',
  '  }',
  '  const top = __dshInvoke("normalizeWriteResult", [last, staged[staged.length - 1].sha]);',
  '  if (last && typeof last === "object" && last.content !== undefined) top.content = last.content;',
  // B10 compatibility: no `atomic` key on legacy non-atomic success.
  '  return Object.assign({}, out, top);',
  '};',
  'codemode.applyFilePatch = __dshHide(__dshB10ApplyFilePatch);',
  'codemode.writeFiles = codemode.applyFilePatch;',
  // ---- ensureBranch: idempotent branch creation via list/create tools ----
  'const __dshB10EnsureBranch = async (opts) => { const o = opts && typeof opts === "object" ? opts : {}; const names = __dshB10Cfg(o.tools, { listTool: "github__list_branches", createTool: "github__create_branch", deleteTool: "github__delete_branch" }); const branchName = o.name !== undefined && o.name !== null && o.name !== "" ? o.name : (o.branch !== undefined && o.branch !== null && o.branch !== "" ? o.branch : o.branchName); if (typeof branchName !== "string" || branchName.length === 0) throw new Error("ensureBranch: branch name is required (pass name, branch or branchName)"); const ifExists = o.ifExists === "reset" ? "reset" : "reuse"; const listArgs = Object.assign({}, o.listArgs || {}, { owner: o.owner, repo: o.repo }); const branches = __dshB10ToArray(await __dshCallTool(names.listTool, listArgs)); const found = branches.find((b) => { if (typeof b === "string") return b === branchName; if (!b || typeof b !== "object") return false; return b.name === branchName || b.ref === branchName || (typeof b.ref === "string" && b.ref.indexOf("/" + branchName) >= 0); }); if (found !== undefined) { if (ifExists === "reuse") return { created: false, reused: true, reset: false, branch: found }; if (!names.deleteTool) throw new Error("ensureBranch: ifExists=\\"reset\\" requires a deleteTool (unsupported)"); await __dshCallTool(names.deleteTool, Object.assign({}, o.deleteArgs || {}, { owner: o.owner, repo: o.repo, name: branchName, branch: found })); const reset = await __dshCallTool(names.createTool, Object.assign({}, o.createArgs || {}, { owner: o.owner, repo: o.repo, branch: branchName, from_branch: o.fromBranch || o.fromSha })); return { created: true, reused: false, reset: true, branch: reset }; } const created = await __dshCallTool(names.createTool, Object.assign({}, o.createArgs || {}, { owner: o.owner, repo: o.repo, branch: branchName, from_branch: o.fromBranch || o.fromSha })); return { created: true, reused: false, reset: false, branch: created }; };',
  'codemode.ensureBranch = __dshHide(__dshB10EnsureBranch);',
  // PR #41–#48: idempotent branch option at the push/commit entry. Missing
  // branch is created from `base`; existing branch is reused unless reset is
  // explicitly opted into. Thin alias over ensureBranch — same tool bridge.
  'codemode.createBranchIfMissing = __dshHide(async (opts) => { const o = opts && typeof opts === "object" ? Object.assign({}, opts) : {}; o.fromSha = (o.base !== undefined ? o.base : (o.fromSha !== undefined ? o.fromSha : o.fromBranch)); delete o.base; return __dshB10EnsureBranch(o); });',
  'codemode.create_branch_if_missing = codemode.createBranchIfMissing;',
  // ---- upsertPr: find matching open PR then update or create ----
  'const __dshB10UpsertPr = async (opts) => { const o = opts && typeof opts === "object" ? opts : {}; const names = __dshB10Cfg(o.tools, { listTool: "github__list_pull_requests", createTool: "github__create_pull_request", updateTool: "github__update_pull_request" }); if (!o.head || !o.base) throw new Error("upsertPr: head and base are required"); const state = o.state || "open"; const listArgs = Object.assign({}, o.listArgs || {}, { owner: o.owner, repo: o.repo, head: typeof o.head === "object" ? (o.head.ref || o.head.sha) : o.head, base: typeof o.base === "object" ? (o.base.ref || o.base.sha) : o.base, state: state }); const prs = __dshB10ToArray(await __dshCallTool(names.listTool, listArgs)); const headRef = typeof o.head === "object" ? (o.head.ref || o.head.sha) : o.head; const baseRef = typeof o.base === "object" ? (o.base.ref || o.base.sha) : o.base; const existing = prs.find((pr) => { if (!pr || typeof pr !== "object") return false; const st = __dshB10Str(pr.state || "open").toLowerCase(); const h = pr.head && typeof pr.head === "object" ? (pr.head.ref || pr.head.sha) : pr.head; const b = pr.base && typeof pr.base === "object" ? (pr.base.ref || pr.base.sha) : pr.base; return st === "open" && h === headRef && b === baseRef; }); if (existing) { if (names.updateTool) { const updated = await __dshCallTool(names.updateTool, Object.assign({}, o.updateArgs || {}, { owner: o.owner, repo: o.repo, pullNumber: existing.number !== undefined && existing.number !== null ? existing.number : undefined, title: o.title, body: o.body, head: headRef, base: baseRef })); return { created: false, updated: true, reused: false, pr: updated }; } return { created: false, updated: false, reused: true, pr: existing }; } const created = await __dshCallTool(names.createTool, Object.assign({}, o.createArgs || {}, { owner: o.owner, repo: o.repo, head: headRef, base: baseRef, title: o.title, body: o.body })); return { created: true, updated: false, reused: false, pr: created }; };',
  'codemode.upsertPr = __dshHide(__dshB10UpsertPr);',
  // ---- fetchAllPages: cursor/page pagination with de-dup ----
  // Security audit: preserve upstream truncation flags across the guest
  // adapter. A page that says truncated:true means the whole collection is
  // incomplete even when the cursor chain ends normally.
  'const __dshB10FetchAllPages = async (opts) => { const o = opts && typeof opts === "object" ? opts : {}; const names = __dshB10Cfg(o.tools, { pageTool: o.pageTool || "" }); if (!names.pageTool) throw new Error("fetchAllPages: tools.pageTool (or opts.pageTool) is required"); const maxPages = Number.isFinite(o.maxPages) && o.maxPages > 0 ? Math.floor(o.maxPages) : 20; const cursorKey = o.cursorKey || "cursor"; const items = []; const seen = {}; let cursor; let pages = 0; let upstreamTruncated = false; const note = (p) => { if (!p || typeof p !== "object") return; const f = p.truncated !== undefined ? p.truncated : (p.result && typeof p.result === "object" ? p.result.truncated : undefined); if (f === true || f === 1 || f === "1" || f === "true") upstreamTruncated = true; }; const out = (extra) => ({ items, pages, nextCursor: extra.nextCursor === undefined ? null : extra.nextCursor, truncated: extra.truncated === true || upstreamTruncated, upstreamTruncated }); while (pages < maxPages) { const args = Object.assign({}, o.pageArgs || {}, {}, cursor === undefined ? {} : (o.pageBased ? { page: cursor } : { [cursorKey]: cursor })); const page = await __dshCallTool(names.pageTool, args); pages += 1; note(page); if (page === null || page === undefined) return out({ truncated: false }); const raw = Array.isArray(page) ? page : (page.items !== undefined ? page.items : (page.data !== undefined ? page.data : __dshB10ToArray(page))); const list = Array.isArray(raw) ? raw : []; if (list.length === 0) return out({ truncated: false }); for (const item of list) { let key; try { key = JSON.stringify(item); } catch (_) { key = __dshB10Str(item); } if (!Object.prototype.hasOwnProperty.call(seen, key)) { seen[key] = true; items.push(item); } } const next = page.nextCursor !== undefined ? page.nextCursor : (page.next !== undefined ? page.next : (page.pageInfo ? page.pageInfo.endCursor : undefined)); if (next === undefined || next === null || next === "") return out({ truncated: false }); if (next === cursor) return out({ nextCursor: next, truncated: false }); cursor = next; } return out({ nextCursor: cursor, truncated: true }); };',
  'codemode.fetchAllPages = __dshHide(__dshB10FetchAllPages);',
  // ---- repoGrep: list files then read each, regex search with line/column ----
  // Security audit: a truncated read means grep only saw a prefix of that
  // file — matches may be missing, so report both limit and upstream truncation.
  'const __dshB10RepoGrep = async (opts) => { const o = opts && typeof opts === "object" ? opts : {}; const names = __dshB10Cfg(o.tools, { listTool: o.listTool || "", readTool: o.readTool || "github__get_file_contents" }); if (!names.listTool) throw new Error("repoGrep: tools.listTool (or opts.listTool) is required"); if (!o.pattern) throw new Error("repoGrep: pattern is required"); const flags = o.flags === undefined ? "i" : o.flags; let re; try { re = o.pattern instanceof RegExp ? o.pattern : new RegExp(o.pattern, flags); } catch (e) { throw new Error("repoGrep: invalid pattern: " + __dshB10Str(e && e.message ? e.message : e)); } const global = re.global ? re : new RegExp(re.source, re.flags.indexOf("g") >= 0 ? re.flags : re.flags + "g"); const files = __dshB10ToArray(await __dshCallTool(names.listTool, Object.assign({}, o.listArgs || {}, { owner: o.owner, repo: o.repo }))).map((f) => (typeof f === "string" ? f : (f && typeof f === "object" ? (f.path || f.name) : null))).filter((f) => typeof f === "string" && f.length > 0); const limit = Number.isFinite(o.limit) && o.limit > 0 ? o.limit : 50; const matches = []; const errors = []; let truncated = false; let upstreamTruncated = false; for (const file of files) { if (matches.length >= limit) { truncated = true; break; } let raw; try { raw = await __dshCallTool(names.readTool, Object.assign({}, o.readArgs || {}, { owner: o.owner, repo: o.repo, path: file })); } catch (e) { errors.push({ file, error: __dshB10Str(e && e.message ? e.message : e) }); continue; } if (raw && typeof raw === "object") { const f = raw.truncated !== undefined ? raw.truncated : (raw.result && typeof raw.result === "object" ? raw.result.truncated : undefined); if (f === true || f === 1 || f === "1" || f === "true") upstreamTruncated = true; } let text = raw; if (raw && typeof raw === "object") text = raw.text !== undefined ? raw.text : (raw.content !== undefined ? raw.content : (raw.result && raw.result.text !== undefined ? raw.result.text : "")); if (typeof text !== "string") { const nf = codemode.normalizeFile(raw, names.readTool); text = nf.content || ""; if (nf.truncated) upstreamTruncated = true; } const lines = text.split(/\\r?\\n/); for (let i = 0; i < lines.length; i += 1) { global.lastIndex = 0; let m; while ((m = global.exec(lines[i])) !== null) { matches.push({ file, line: i + 1, column: m.index + 1, text: lines[i] }); if (m[0] === "") global.lastIndex += 1; if (matches.length >= limit) { truncated = true; break; } } if (matches.length >= limit) break; } } return { matches, errors, scanned: files.length - errors.length, truncated: truncated || upstreamTruncated, upstreamTruncated }; };',
  'codemode.repoGrep = __dshHide(__dshB10RepoGrep);',
  // Batch 11 · GitHub Actions read-only REST helpers. Gateway-side only: the
  // host performs the fetch with GITHUB_TOKEN; no new MCP tool is registered.
  // Stable shape: {ok,status,data|text,truncated[,error]}.
  'codemode.github_actions_list_workflow_runs = __dshHide((opts) => __dshInvoke("github_actions_list_workflow_runs", [opts]));',
  'codemode.github_actions_list_workflow_jobs = __dshHide((opts) => __dshInvoke("github_actions_list_workflow_jobs", [opts]));',
  'codemode.github_actions_get_job_logs = __dshHide((opts) => __dshInvoke("github_actions_get_job_logs", [opts]));',
  // Batch 15 P2 · one-call CI wait over the existing tool bridge.
  'codemode.waitForPrChecks = __dshHide((opts) => __dshInvoke("wait_for_pr_checks", [opts]));',
  // Batch 17 · PR #80–#101 feedback helpers. All are host-side pure
  // orchestration over the SAME injected tool bridge / callables; no new MCP
  // tool, no network in the sandbox. `callables` is built by the host registry
  // from the tools actually present in this session (see registry.createIssue).
  'codemode.createIssue = __dshHide((opts) => __dshInvoke("create_issue", [opts]));',
  'codemode.rerunFailedJobs = __dshHide((opts) => __dshInvoke("rerun_failed_jobs", [opts]));',
  'codemode.mergePrWithOptionalBranchDelete = __dshHide((opts) => __dshInvoke("merge_with_branch_delete", [opts]));',
  'codemode.deleteFiles = __dshHide((opts) => __dshInvoke("delete_files", [opts]));',
  'codemode.renameFiles = __dshHide((opts) => __dshInvoke("rename_files", [opts]));',
].join('\n');
const GUEST_PREFIX_LINES = GUEST_PRELUDE.split('\n').length;

const READ_ONLY_TOOL_RE =
  /^(get|list|search|query|read|fetch|view|describe|find|count|aggregate|check)_|^notion-(get|list|search|query|memory)/i;

/** Conservative read-only detection: upstream annotation wins, then name hint. */
export function isReadOnlyTool(t) {
  return t?.annotations?.readOnlyHint === true || READ_ONLY_TOOL_RE.test(String(t?.tool ?? ''));
}

/** Summarize tool-call args for the audit trail — never echo large payloads
 * (e.g. push_files with full source of 10 files) back into model context.
 * Cycle-safe (#41): a self-referential array (`a.push(a)`) used to recurse
 * through `sample` forever and blow the stack. We track the current path in a
 * WeakSet (works for cross-realm objects too) and cap nesting depth, emitting
 * a short placeholder instead. */
function summarizeArgs(args, max = ARG_FIELD_MAX, seen = new WeakSet(), depth = 0) {
  if (args === null || args === undefined) return null;
  if (typeof args === 'string') return args.length > max ? `<string len=${args.length}>` : args;
  if (typeof args !== 'object') return args;
  if (seen.has(args)) return '[Circular]';
  if (depth >= 8) return '[Deeply nested]';
  seen.add(args);
  try {
    if (Array.isArray(args)) {
      return { __array: args.length, sample: args.slice(0, 3).map((x) => summarizeArgs(x, max, seen, depth + 1)) };
    }
    const out = {};
    for (const [k, v] of Object.entries(args)) {
      if (typeof v === 'string' && v.length > max) out[k] = `<string len=${v.length}>`;
      else if (Array.isArray(v)) out[k] = { __array: v.length };
      else if (v && typeof v === 'object') out[k] = { __object: Object.keys(v).length };
      else out[k] = v;
    }
    return out;
  } finally {
    seen.delete(args);
  }
}

/** Deterministic, cycle-safe key for dedup (independent of object key order). */
function stableKey(value, seen = new Set()) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (seen.has(value)) return '"[circular]"';
  seen.add(value);
  let out;
  if (Array.isArray(value)) {
    out = `[${value.map((v) => stableKey(v, seen)).join(',')}]`;
  } else {
    out = `{${Object.keys(value).sort()
      .map((k) => `${JSON.stringify(k)}:${stableKey(value[k], seen)}`).join(',')}}`;
  }
  seen.delete(value);
  return out;
}

/** Compact one-line tool summary for codemode.listTools(). */
function listSummary(t) {
  const desc = String(t.description ?? '').replace(/\s+/g, ' ').trim();
  const summary = desc.length > 80 ? `${desc.slice(0, 79)}…` : desc;
  return {
    name: t.name,
    service: t.server ?? '',
    readOnly: isReadOnlyTool(t),
    summary,
  };
}

/**
 * Bound captured console logs before they can re-enter the model context.
 * A single `console.log(bigObject)` used to be pushed verbatim; we reuse the
 * structured truncator so the array stays valid JSON and carries a
 * `--- TRUNCATED ---` marker instead of silently losing entries.
 */
function boundLogs(logs, maxChars = DEFAULT_MAX_LOG_CHARS) {
  if (!Array.isArray(logs)) return logs;
  return truncateResultValue(logs, { maxChars });
}

/**
 * Describe a thrown value cross-realm-safe: vm errors fail `instanceof Error`.
 * (#12) Also lift the script location out of the guest error stack. The `run`
 * SDK reports `run.js:LINE:COL`; the guest prelude resolves it to the original
 * model-code line before it reaches here (the vm-era fallback is kept for
 * compatibility). `line`/`column` are defined non-enumerable so the legacy
 * `{message, type}` shape stays byte-identical for direct callers and for
 * `JSON.stringify(wire.error)`; the catch path surfaces the location in the
 * human-readable `result` string, which is what the model actually reads.
 */
function errorInfo(err, scriptLoc) {
  const errLike = err && typeof err === 'object' &&
    typeof err.message === 'string' && typeof err.name === 'string';
  const info = (err instanceof Error || errLike)
    ? { message: err.message, type: err.name || err.constructor?.name || 'Error' }
    : { message: String(err), type: 'UnknownError' };
  // Only attribute a *script* location when the throw site itself is in guest
  // code. Host-side errors (arg validation, tool-call budget, upstream
  // failures) are marked by the guest bridge wrapper and carry no location;
  // tagging those would change their legacy message and break callers/tests.
  const loc = scriptLoc ?? (() => {
    const stack = typeof err?.stack === 'string' ? err.stack : '';
    const firstFrame = stack.split('\n').find((line) => line.trim().startsWith('at ')) ?? '';
    return /evalmachine\.<anonymous>:(\d+):(\d+)/.exec(firstFrame) ?? null;
  })();
  if (loc) {
    const line = Array.isArray(loc) ? loc[1] : loc.line;
    const column = Array.isArray(loc) ? loc[2] : loc.column;
    Object.defineProperty(info, 'line', { value: Number(line), enumerable: false, configurable: true });
    Object.defineProperty(info, 'column', { value: Number(column), enumerable: false, configurable: true });
  }
  return info;
}

/**
 * Build the sandbox output object.
 *
 * Direct callers (and the existing tests) read `out.result` as a string, so
 * that field is kept. `server.js` serializes the whole handler result exactly
 * once with JSON.stringify(); a plain string `result` would therefore land in
 * the envelope as a JSON-encoded string (double serialization). `toJSON()`
 * makes the model receive `result` as the real structured value on the wire.
 */
/**
 * Batch 15 P1 · structured truncation metadata for model-facing results.
 *
 * The shared truncator (tool-format.js) marks cut values with an in-band
 * `--- TRUNCATED ---` string. That is deliberately kept for compatibility, but
 * a marker alone does not say which field was cut, how big the original was,
 * whether the TAIL was lost, or how to continue reading. We derive that
 * metadata here at the single model boundary, without changing the truncator.
 */
function withTruncationMetadata(value, original) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  // Only annotate when the boundary truncator actually changed the payload.
  // A model may legitimately RETURN a string containing the marker (e.g. an
  // upstream log excerpt); that is data, not evidence of boundary truncation.
  let originalText;
  let valueText;
  try {
    originalText = JSON.stringify(original);
    valueText = JSON.stringify(value);
  } catch (_) {
    return value;
  }
  if (originalText === valueText) return value;
  const keys = Object.keys(value);
  const markedKeys = keys.filter((k) => {
    if (k.includes('--- TRUNCATED ---')) return true;
    const v = value[k];
    return typeof v === 'string' && v.includes('--- TRUNCATED ---');
  });
  // The truncator uses the marker as a KEY on objects and arrays; its value
  // holds the human-readable note (omitted keys / totals / field names).
  const markerText = keys
    .filter((k) => k.includes('--- TRUNCATED ---'))
    .map((k) => String(value[k] ?? ''))
    .concat(keys.filter((k) => typeof value[k] === 'string' && value[k].includes('--- TRUNCATED ---')).map((k) => String(value[k])))
    .join(' ');
  const marker = /--- TRUNCATED ---\s*([\d,]+)\s*(chars|items)?/i.exec(markerText);
  const totalChars = marker ? Number((marker[1] ?? '0').replace(/,/g, '')) : null;
  const summary = /top-level keys:\s*\[([^\]]*)\]/i.exec(markerText)?.[1] ?? null;
  const omitted = /(\d[\d,]*)\s+keys? omitted:\s*([^.]+)/i.exec(markerText);
  const continuation = keys.includes('truncated') || keys.includes('truncation') || keys.includes('nextStart')
    ? 'Follow nextStart / readFileRange or grepSnippet to read the omitted segment.'
    : 'Narrow the request (readFileRange / grepSnippet) and re-read the omitted segment.';
  // Prefer the exact original size when available; fall back to the marker's
  // embedded count. Either way the model gets a concrete total, not a bare cut.
  let originalChars = totalChars;
  if (original !== undefined) {
    try {
      const text = JSON.stringify(original);
      if (typeof text === 'string') originalChars = text.length;
    } catch (_) { /* keep the marker count */ }
  }
  const fields = markedKeys.filter((k) => !k.includes('--- TRUNCATED ---')).length
    ? markedKeys.filter((k) => !k.includes('--- TRUNCATED ---'))
    : (summary ? summary.split(',').map((s) => s.trim()) : []);
  const meta = {
    truncated: true,
    // Compact keys keep the enriched result inside the model-output budget.
    field: fields.length === 1 ? fields[0] : fields,
    totalChars: originalChars,
    tail: true,
    next: 'readFileRange',
  };
  return { ...value, truncation: meta };
}

function makeOutput({ legacyResult, structuredResult, logs, toolCalls, isError = false }) {
  const out = {
    result: legacyResult,
    logs,
    toolCalls,
    ...(isError ? { isError: true } : {}),
  };
  out.toJSON = () => ({
    result: structuredResult,
    logs,
    toolCalls,
    ...(isError ? { isError: true } : {}),
  });
  return out;
}

/**
 * Cloudflare-style `toModelOutput` projection (see @cloudflare/codemode 0.5.6,
 * dist/index.js:1774): the durable call log (`toolCalls`) and the sandbox
 * `logs` are audit-only and must never reach the model. Everything else —
 * including `isError`, `status` and typed `error` — is preserved.
 *
 * This is applied by the execute handlers at the tool boundary, after
 * runInSandbox() has produced its full internal result. Direct callers of
 * runInSandbox() still see `toolCalls`/`logs` for audit and diagnostics.
 */
export function toModelOutput(output, profile) {
  if (output === null || typeof output !== 'object' || Array.isArray(output)) {
    return { result: toJsonSafe(output) };
  }
  // The original `toJSON()` hook must be dropped too: leaving it on the object
  // would re-invoke makeOutput()'s serializer during server.js's JSON.stringify
  // and resurrect logs/toolCalls on the wire. Spreading rather than whitelisting
  // keeps fields added by other fixes (status/error) intact.
  const { toolCalls, calls, logs, toJSON, ...rest } = output;
  void toolCalls; void calls; void logs; void toJSON;
  const projected = toJsonSafe(rest); // cycles / BigInt → {error}, never throws
  // Thin encoding adapter: gemini (default) keeps the exact projected shape;
  // chatgpt additionally gets structuredContent derived from `result`.
  // No execution semantics change; profile is optional for backward callers.
  return profile === undefined ? projected : encodeModelOutput(projected, profile);
}

/** JSON-only copy of a wire value; mirrors Cloudflare's `toJSONValue` helper. */
function toJsonSafe(value) {
  try {
    const text = JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? v.toString() : v));
    return text === undefined ? null : JSON.parse(text);
  } catch (err) {
    return { result: `Result could not be serialized for the model: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/* ------------------------------------------------------------------ *
 * Lightweight pre-flight arg validation (Gemini suggestion 2)
 *
 * Only two layers: (1) required fields present, (2) top-level primitive type
 * for fields whose schema declares a basic type. This is intentionally NOT a
 * full JSON Schema validator: enum/format/items/nested schemas, multi-types and
 * fields the schema never mentions are left to the upstream. The upstream is
 * the authority; we only reject what it would certainly reject anyway, so a
 * bad call fails in one round with an actionable message instead of after an
 * upstream 400 + retry.
 * ------------------------------------------------------------------ */
const BASIC_ARG_TYPES = new Set(['string', 'number', 'boolean', 'array', 'object']);
const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

/** Cross-realm-safe type name for the "got" part of an error message. */
function argType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array'; // Array.isArray works across vm realms
  return typeof value; // string | number | boolean | object | function | ...
}

/** Return the primitive name we check, or null to skip (leave it to upstream). */
function expectedArgType(def) {
  if (!def || typeof def !== 'object') return null;
  const type = def.type;
  if (type === 'integer') return 'number'; // integral-ness is upstream's job, not ours
  return typeof type === 'string' && BASIC_ARG_TYPES.has(type) ? type : null;
}

/**
 * Batch 15 P0 · GitHub get_file_contents' real parameter is `ref`, not `branch`.
 * A `branch` used to be silently ignored by upstream, which then read `main`.
 * Apply ONE narrow alias, only for that tool, only when no explicit `ref` is
 * present. Unknown parameters are left untouched (no dangerous pass-through
 * rewrites); the original `branch` key is preserved for compatibility/audit.
 * Pure, never throws, never mutates its input.
 *
 * @returns {{args:*, aliased:boolean}}
 */
export function aliasGetFileContentsArgs(toolName, args) {
  const name = String(toolName ?? '');
  const isRead = name === 'github__get_file_contents' || name === 'get_file_contents'
    || /^(?:github|gh)[._-]get_file_contents$/i.test(name)
    || /__get_file_contents$/i.test(name);
  if (!isRead || args === null || typeof args !== 'object' || Array.isArray(args)) {
    return { args, aliased: false };
  }
  const ref = args.ref;
  if (ref !== undefined && ref !== null && ref !== '') return { args, aliased: false };
  const branch = args.branch;
  if (typeof branch !== 'string' || branch.length === 0) return { args, aliased: false };
  return { args: Object.assign({}, args, { ref: branch }), aliased: true };
}

/**
 * Validate `codemode.<tool>(args)` against the tool's inputSchema.
 * Throws an actionable Error; the sandbox catch turns it into an execute error
 * the model can fix in a single round.
 */
export function validateToolArgs(tool, args) {
  const schema = tool?.inputSchema;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return;
  const name = tool?.name ?? tool?.tool ?? 'unknown';

  // Odd arg shapes are not our business — pass them through to the upstream.
  if (args !== null && (typeof args !== 'object' || Array.isArray(args))) return;
  // ROOT-CAUSE FIX (RC-D3): normalize camelCase aliases BEFORE validating,
  // otherwise a required snake_case field filled as camelCase is falsely
  // reported missing and normalization in upstreams.callTool never runs.
  // (callTool normalizes again — idempotent — so wire args stay correct.)
  const a = normalizeToolArguments(args ?? {}, schema);

  const props = schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)
    ? schema.properties
    : {};
  const required = Array.isArray(schema.required) ? schema.required : [];

  const missing = required.filter((field) => !hasOwn(a, field) || a[field] === undefined);
  if (missing.length > 0) {
    throw new Error(`tool ${name} requires fields: ${missing.join(', ')}`);
  }

  for (const [field, def] of Object.entries(props)) {
    if (!hasOwn(a, field) || a[field] === undefined) continue; // absent (optional) field
    const expected = expectedArgType(def);
    if (expected === null) continue; // unknown/multi-type: upstream decides
    const actual = argType(a[field]);
    if (actual !== expected) {
      throw new Error(`tool ${name} field '${field}' expected ${expected}, got ${actual}`);
    }
  }
}

/* ------------------------------------------------------------------ *
 * Sandbox hardening helpers
 * ------------------------------------------------------------------ */

/** (#46) Host-side wall-clock deadline; the vm `timeout` only bounds the
 * synchronous slice, while `await callTool()` runs in the host realm with no
 * deadline of its own. The timer is always cleared so tests never hang. */
function withDeadline(promise, ms, message, onTimeout) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try { onTimeout?.(); } catch { /* never let cancellation mask the error */ }
      reject(new Error(message));
    }, ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/** Uniform structured error output, shared by the sandbox error path and the
 * (#46) host deadline path. */
/**
 * Best-effort statement-line instrumentation. QuickJS/Vercel only exposes
 * function frames in production, so instead of reverse-engineering the stack we
 * mark each block statement with its original line. The last marker before a
 * throw is the closest reliable line. Parse failures leave the source untouched.
 */
export function instrumentLineMarkers(source) {
  try {
    let ast;
    let offset = 0;
    try {
      ast = parse(source, { ecmaVersion: 'latest', locations: true, allowAwaitOutsideFunction: true, sourceType: 'script' });
    } catch {
      ast = parse(`(${source})`, { ecmaVersion: 'latest', locations: true, allowAwaitOutsideFunction: true, sourceType: 'script' });
      offset = 1;
    }
    const first = ast.body[0];
    const candidate = first?.type === 'ExpressionStatement'
      ? first.expression
      : (first?.type === 'FunctionDeclaration' ? first : null);
    if (!candidate || !['ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration'].includes(candidate.type)) {
      console.warn('[line-markers] unsupported source shape:', first?.type ?? 'empty');
      return source;
    }
    const expr = candidate;
    const exprStart = expr.start - offset;
    if (expr.body?.type !== 'BlockStatement') {
      if (expr.type !== 'ArrowFunctionExpression') return source;
      // Expression-bodied arrow: wrap in a block so the line marker runs and
      // the original value/async semantics are preserved. Keep parenthesized
      // expression bodies intact (e.g. `() => ({...})`) by replacing the whole
      // parenthesized body, not just the inner object expression.
      const body = expr.body;
      if (!body || typeof body.start !== 'number' || typeof body.end !== 'number') return source;
      let bodyStart = body.start - offset;
      let bodyEnd = body.end - offset;
      const leading = source.slice(exprStart, bodyStart);
      const open = leading.lastIndexOf('(');
      if (open >= 0 && leading.slice(open + 1).trim() === '' && /^\s*\)/.test(source.slice(bodyEnd))) {
        bodyStart = exprStart + open;
        bodyEnd += /^\s*\)/.exec(source.slice(bodyEnd))[0].length;
      }
      const bodySource = source.slice(body.start - offset, body.end - offset);
      const line = body.loc?.start?.line ?? 1;
      return source.slice(0, bodyStart) + `{ __dshLine(${line}); return (${bodySource}); }` + source.slice(bodyEnd);
    }
    const inserts = [];
    const visit = (node) => {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'BlockStatement') {
        for (const stmt of node.body) {
          // Keep directive prologues ("use strict") first.
          if (stmt.type === 'ExpressionStatement' && stmt.directive) { visit(stmt); continue; }
          inserts.push({ pos: stmt.start - offset, line: stmt.loc.start.line });
          visit(stmt);
        }
        return;
      }
      for (const key of Object.keys(node)) {
        if (key === 'loc' || key === 'start' || key === 'end' || key === 'range' || key === 'parent') continue;
        const value = node[key];
        if (Array.isArray(value)) value.forEach(visit);
        else visit(value);
      }
    };
    visit(expr.body);
    inserts.sort((a, b) => b.pos - a.pos);
    let out = source;
    for (const { pos, line } of inserts) out = out.slice(0, pos) + `__dshLine(${line});` + out.slice(pos);
    return out;
  } catch (error) {
    console.warn('[line-markers] parse failed:', error?.message ?? String(error));
    return source;
  }
}

/**
 * Map SDK `run.js:LINE:COL` stack frames back to the guest script line using
 * the `__dshCodeStart` sentinel (the run.js line of the wrapper immediately
 * before the user function). This is independent of prelude/tool-binding length
 * and SDK wrapper offsets. Pick the first positive candidate: wrapper frames
 * before the user code are <=0, the user frame is >0.
 */
export function pickScriptLoc(stack, codeStartLine, codeLines = 1) {
  if (typeof stack !== 'string' || stack === '') return null;
  if (!Number.isFinite(Number(codeStartLine)) || Number(codeStartLine) <= 0) return null;
  const frames = [...stack.matchAll(/run\.js:(\d+):(\d+)/g)];
  if (frames.length === 0) return null;
  // The first run.js frame is the user function start. The wrapper sentinel is
  // codeLines + 3 source lines after the function definition, so this offset
  // maps the function frame back to the user's source line.
  const frame = frames[0];
  const line = Number(frame[1]) - Number(codeStartLine) + Number(codeLines) + 3;
  const column = Number(frame[2]);
  if (line > 0 && Number.isFinite(column)) return { line, column };
  return null;
}

function makeErrorOutput(err, logs, toolCalls, scriptLoc) {
  const info = errorInfo(err, scriptLoc);
  // F-01: `out.error` is part of the model-facing output shape (status/error).
  // Redact its message copy as well; the original `err` stays raw for capture.
  info.message = redactSecrets(info.message);
  // Keep the legacy message prefix byte-for-byte for existing callers/tests;
  // append the caught script location only when a vm stack provided one.
  // F-01: the final model-facing execute error is redacted too — errors that
  // bypass the bridge (SDK/timeout/sandbox throw) reach this path directly.
  const rawMessage = modelErrorMessage(err);
  const loc = info.line != null ? ` (script line ${info.line}:${info.column})` : '';
  const message = `execute error: ${rawMessage}${loc}`;
  const out = makeOutput({
    legacyResult: message,
    structuredResult: message,
    logs: boundLogs(logs),
    toolCalls,
    isError: true,
  });
  out.status = 'error';
  out.error = info;
  const baseToJSON = out.toJSON;
  out.toJSON = () => ({ ...baseToJSON(), status: 'error', error: info });
  return out;
}

/**
 * RC-D4: the ONE shared search routine, used by both the outer `search` MCP
 * handler and the in-sandbox `codemode.search`.
 *
 * Root cause of RC-D4: there were two copies of the search call and only the
 * outer one had the empty-result probe, so they drifted apart. Routing both
 * through this function keeps their fallback behaviour identical.
 *
 * `select:` queries bypass the fallback (exact-name lookup only); the caller
 * decides how to render them. The sandbox never issues `select:`, preserving
 * its historical "no select support" contract (it always uses summaries).
 *
 * @param {Array} tools tool descriptors to search
 * @param {string} query raw query text
 * @param {number} limit max matches
 * @returns {{ res: object, hint: string|undefined, isSelect: boolean }}
 */
export function searchWithFallback(tools, query, limit = 8) {
  const q = String(query ?? '');
  const isSelect = /^select\s*:/i.test(q.trim());
  let res = searchEntries(tools, q, { limit });
  let hint = res.hint;
  // Empty-result fallback: the longest token first, but a known service prefix
  // wins — so a dead-end query like "+github zzzz" still surfaces the closest
  // github tools instead of returning nothing.
  if (!isSelect && res.matches.length === 0 && q.trim()) {
    const tokens = q.trim().toLowerCase().split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3)
      .sort((a, b) => b.length - a.length);
    const service = tokens.find((t) => ['github', 'notion', 'linear', 'vercel'].includes(t));
    for (const probe of (service ? [service, ...tokens] : tokens).slice(0, 3)) {
      const retry = searchEntries(tools, probe, { limit });
      if (retry.matches.length) {
        res = retry;
        hint = `No exact match for "${q}"; showing closest for "${probe}".`;
        break;
      }
    }
  }
  return { res, hint, isSelect };
}

/* ------------------------------------------------------------------ *
 * B14 · typed-plan host helper (sandbox-only, no MCP tool/schema change)
 *
 * `codemode.runTypedPlan(plan, opts)` is a guest prelude helper that goes
 * through the same host bridge as every other capability. The typed-plan
 * executor itself is a pure host module (src/typed-plan.js); the bridge here
 * builds its `io` adapter from the SAME upstream tool bridge used by the
 * codemode read/write helpers, then delegates to executeTypedPlan().
 *
 * Safety invariants (enforced on the HOST, never trusted from the guest):
 *   - `readOnly` from the enclosing execute_read context is forced on, whatever
 *     the guest passes in opts — a write op can never escape the read sandbox.
 *   - `dryRun` defaults to true for execute(); a real write needs an explicit
 *     dryRun:false plus approve (the engine's own whole-plan gate).
 *   - every throw is converted to a stable `{ok:false,...}` result; nothing is
 *     silently truncated or swallowed, and the sandbox never crashes.
 * ------------------------------------------------------------------ */

/** Resolve a tool by short name / full `__`-qualified name from the mounted set. */
function resolveTypedPlanTool(tools, candidates) {
  const list = Array.isArray(tools) ? tools : [];
  for (const wanted of candidates) {
    const hit = list.find((t) => {
      const name = String(t?.name ?? t?.tool ?? '');
      return name === wanted || name.endsWith(`__${wanted}`);
    });
    if (hit) return hit;
  }
  return null;
}

/**
 * Build the default REAL io adapter for typed plans from the upstream tool
 * bridge. Read ops reuse the exact same tool defaults as the guest codemode
 * helpers (github__get_file_contents / list+read for grep); write ops go
 * through file-write's patcher (already applied by the op) + the create/update
 * tools / branch / PR tools, mirroring codemode.applyFilePatch/ensureBranch/
 * upsertPr. Callers can replace this wholesale via `typedPlanIO`.
 */
/**
 * F-07 · typed-plan fileText fallback, extracted as a pure host helper so the
 * "unknown vs explicit" contract can be regression-tested deterministically.
 * `truncated:null` means the upstream reported no evidence either way; it is
 * NEVER a silent `false` that would let a truncated read be written back.
 */
export function fileTextFromRaw(raw, { normalizeName = 'get_file_contents' } = {}) {
  const nf = hostNormalizeResult(normalizeName, raw);
  if (typeof nf?.content === 'string') {
    const reason = explainTruncation(raw, nf.content);
    return {
      text: nf.content,
      sha: nf.sha ?? null,
      truncated: reason === null ? null : true,
      ...(reason === null ? {} : { truncation: reason }),
    };
  }
  const value = raw && typeof raw === 'object' && raw.result ? raw.result : raw;
  if (value && typeof value.text === 'string') {
    const reason = explainTruncation(raw, value.text);
    return {
      text: value.text,
      sha: value.sha ?? null,
      truncated: reason === null ? null : true,
      ...(reason === null ? {} : { truncation: reason }),
    };
  }
  return { text: null, sha: null, truncated: null };
}

function createDefaultTypedPlanIO({ tools, callTool, charge }) {
  const toolName = (t) => String(t?.name ?? t?.tool ?? '');
  const readTool = resolveTypedPlanTool(tools, ['get_file_contents']);
  const listTool = resolveTypedPlanTool(tools, ['list_repo_contents', 'list_directory_contents', 'list_repository_content', 'list_files']);
  const writeTool = resolveTypedPlanTool(tools, ['create_or_update_file', 'push_files']);
  const branchListTool = resolveTypedPlanTool(tools, ['list_branches']);
  const branchCreateTool = resolveTypedPlanTool(tools, ['create_branch']);
  const prListTool = resolveTypedPlanTool(tools, ['list_pull_requests']);
  const prCreateTool = resolveTypedPlanTool(tools, ['create_pull_request']);
  const prUpdateTool = resolveTypedPlanTool(tools, ['update_pull_request']);

  const invoke = async (tool, args) => {
    if (!tool) throw new Error('typed-plan io: required upstream tool is unavailable');
    // F-04: every typed-plan upstream invocation consumes the SAME per-execute
    // budget as codemode.<tool>(). `charge` throws a stable limit error before
    // callTool so an over-budget plan cannot reach the upstream at all.
    if (charge) charge();
    return unwrapResult(await callTool(tool.server, tool.tool, args ?? {}));
  };

  // F-07: single host helper for BOTH the canonical and fallback shapes.
  const fileText = (raw) => fileTextFromRaw(raw, { normalizeName: toolName(readTool) || 'get_file_contents' });

  return {
    readFileRange: async (args) => {
      const raw = await invoke(readTool, {
        owner: args.owner, repo: args.repo, path: args.path,
        ...(args.ref !== undefined ? { ref: args.ref } : {}),
      });
      const { text, sha, truncated } = fileText(raw);
      if (text === null) throw new Error(`readFileRange: no file text for ${args.path}`);
      const allLines = text.replace(/\r\n?/g, '\n').split('\n');
      const totalLines = allLines.length;
      const start = Number.isFinite(args.startLine) ? Math.max(1, Math.floor(args.startLine)) : 1;
      const end = Number.isFinite(args.endLine)
        ? Math.max(start - 1, Math.min(totalLines, Math.floor(args.endLine)))
        : totalLines;
      return {
        path: args.path,
        text,
        sha,
        lines: allLines.slice(start - 1, end),
        totalLines,
        // F-07: null means "upstream did not report either way"; a boolean
        // true from a range cut or an explicit flag is still authoritative.
        truncated: truncated === true || start > 1 || end < totalLines
          ? true
          : truncated ?? null,
      };
    },
    repoGrep: async (args) => {
      if (!listTool) throw new Error('repoGrep: no repository list tool is available in this session');
      const listed = await invoke(listTool, { owner: args.owner, repo: args.repo, path: args.pathPrefix });
      const entries = Array.isArray(listed) ? listed : (listed?.items ?? listed?.data ?? []);
      const files = entries.map((e) => (typeof e === 'string' ? e : e?.path ?? e?.name)).filter((p) => typeof p === 'string' && p.length);
      const limit = Number.isFinite(args.limit) && args.limit > 0 ? args.limit : 50;
      let re;
      try { re = new RegExp(args.pattern, 'i'); } catch (e) { throw new Error(`repoGrep: invalid pattern: ${e.message}`); }
      const matches = [];
      let truncated = false;
      for (const file of files) {
        if (matches.length >= limit) { truncated = true; break; }
        const raw = await invoke(readTool, { owner: args.owner, repo: args.repo, path: file });
        const { text, truncated: fileTruncated } = fileText(raw);
        if (text === null) continue;
        // F-07: an upstream-truncated file must make the whole grep result
        // truncated, not just the local match limit.
        if (fileTruncated === true) truncated = true;
        text.replace(/\r\n?/g, '\n').split('\n').forEach((line, i) => {
          if (matches.length < limit && re.test(line)) matches.push({ path: file, line: i + 1, text: line });
        });
      }
      return { pattern: args.pattern, matches, truncated };
    },
    ensureBranch: async (args) => {
      const branches = branchListTool ? await invoke(branchListTool, { owner: args.owner, repo: args.repo }) : [];
      const names = (Array.isArray(branches) ? branches : (branches?.branches ?? [])).map((b) => (typeof b === 'string' ? b : b?.name));
      if (names.includes(args.branch)) return { branch: args.branch, created: false, reused: true };
      const created = await invoke(branchCreateTool, { owner: args.owner, repo: args.repo, branch: args.branch });
      return { branch: args.branch, created: true, reused: false, result: created };
    },
    writeFile: async (args) => {
      const written = await invoke(writeTool, {
        owner: args.owner, repo: args.repo, path: args.path,
        content: args.content, message: args.message ?? 'typed-plan write',
        ...(args.branch !== undefined ? { branch: args.branch } : {}),
        ...(args.sha !== undefined ? { sha: args.sha } : {}),
      });
      return { path: args.path, written: true, result: written };
    },
    openPr: async (args) => {
      if (prListTool) {
        const prs = await invoke(prListTool, { owner: args.owner, repo: args.repo, head: args.head, base: args.base, state: 'open' });
        const found = (Array.isArray(prs) ? prs : (prs?.items ?? [])).find(
          (pr) => pr?.head?.ref === args.head && pr?.base?.ref === args.base && String(pr?.state ?? 'open').toLowerCase() === 'open',
        );
        if (found) {
          const updated = prUpdateTool
            ? await invoke(prUpdateTool, { owner: args.owner, repo: args.repo, pullNumber: found.number, title: args.title })
            : found;
          return { number: found.number, created: false, updated: true, result: updated };
        }
      }
      const created = await invoke(prCreateTool, {
        owner: args.owner, repo: args.repo, head: args.head, base: args.base, title: args.title,
      });
      return { number: created?.number ?? null, created: true, updated: false, result: created };
    },
    runChecks: async (args) => ({ command: args.command, ok: true, skipped: true, reason: 'no host check runner is wired for typed plans' }),
  };
}

/** Stable fallback used when even the bridge wrapper itself fails unexpectedly. */
function typedPlanFailure(error, dryRun, readOnly) {
  const message = error && typeof error.message === 'string' ? error.message : String(error);
  return {
    ok: false,
    dryRun: dryRun === true,
    steps: [],
    stoppedAt: null,
    error: `runTypedPlan bridge error: ${message}`,
    meta: {
      planVersion: 'v2.0.0',
      readOnly: readOnly === true,
      approvedOps: [],
      executedCount: 0,
    },
    validationErrors: [`runTypedPlan bridge error: ${message}`],
  };
}

/**
 * Run normalized model code in a hardened QuickJS sandbox (Vercel `run` SDK).
 * The `codemode` global is assembled by the guest prelude from a single host
 * bridge; all counting/validation/audit stays on the host side.
 * @returns { result, logs, toolCalls } with the unchanged legacy output shape.
 */
export function runInSandbox({ code, tools, callTool, maxCalls = DEFAULT_MAX_CALLS, maxResultChars = DEFAULT_MAX_RESULT_CHARS, timeout = EXEC_TIMEOUT_MS, totalTimeout, unavailableTools = [], servicesInfo = { services: [] }, fetch: hostFetch, env, typedPlanIO, typedPlanOps, typedPlanReadOnly = false }) {
  const normalized = normalizeCode(code);
  const instrumented = instrumentLineMarkers(normalized);
  const logs = [];
  const toolCalls = [];
  // In-process dedup cache, scoped to THIS execute() run. Identical read-only
  // calls (same tool + same args) reuse the first result and do not consume
  // another call from the budget.
  const cache = new Map();
  let calls = 0;

  /**
   * F-04 · single charging point for EVERY bridge capability that performs
   * upstream I/O: codemode.<tool>, runTypedPlan I/O and github_actions_* REST
   * helpers. The historical message and `calls > maxCalls` check stay
   * byte-identical for registry.tool so existing budget semantics do not move;
   * the new paths simply stop bypassing the same counter. A stable `code`
   * makes the over-budget outcome deterministic for callers/tests.
   */
  const chargeBudget = (kind = 'tool') => {
    calls += 1;
    if (calls > maxCalls) {
      const err = new Error(`tool call limit (${maxCalls}) exceeded`);
      err.code = 'TOOL_CALL_LIMIT_EXCEEDED';
      err.kind = kind;
      throw err;
    }
  };

  // Map sanitized JS identifier -> original tool descriptor.
  // F-06: upstream tool names are untrusted input. Never bind a reserved
  // identifier: `__proto__` would change `codemode`'s prototype and
  // `constructor`/built-in names would shadow guest helpers.
  const byIdent = new Map();
  for (const t of tools) {
    const ident = sanitizeToolName(t.name);
    if (!ident || RESERVED_TOOL_IDENTS.has(ident)) continue;
    byIdent.set(ident, t);
  }

  // Batch 17 · tool resolution for feedback helpers. We NEVER assume an
  // upstream capability exists: a missing tool yields a missing callable, and
  // the helper then returns UNSUPPORTED_UPSTREAM_TOOL / an honest partial.
  const invokeToolByIdent = (ident, args) => {
    const tool = byIdent.get(ident);
    if (!tool) throw new Error(`unknown tool: ${ident}`);
    return registry.tool(ident, args);
  };
  /** Find the first mounted ident whose bare name is one of `candidates`. */
  const findToolIdent = (candidates) => {
    for (const [ident, descriptor] of byIdent) {
      const bare = String(descriptor?.tool ?? descriptor?.name ?? ident)
        .split(/__/).pop();
      if (candidates.includes(bare)) return ident;
    }
    return null;
  };
  /** Build a name->callable map for the ACTUALLY mounted tools. */
  const buildCallables = () => {
    const out = {};
    for (const [ident, descriptor] of byIdent) {
      const full = String(descriptor?.name ?? ident);
      const bare = String(descriptor?.tool ?? descriptor?.name ?? ident);
      const fn = (args) => invokeToolByIdent(ident, args);
      out[ident] = fn;
      out[bare] = fn;
      out[full] = fn;
    }
    return out;
  };
  /** Invoke an explicitly named merge tool, or a sensible default. */
  const toolByIdentArg = (explicit, args, defaultBare) => {
    const ident = (explicit && byIdent.has(explicit))
      ? explicit
      : (findToolIdent([String(defaultBare).split(/__/).pop()]) ?? null);
    if (!ident) throw new Error(`toolByIdentArg: ${defaultBare} is unavailable in this session`);
    return invokeToolByIdent(ident, args);
  };

  // F-01: every string crossing the bridge into the guest is a MODEL-VISIBLE
  // error. Prefer the redacted projection attached by upstreamError, else
  // redact here. Capture keeps the raw original (see captureEvent call sites).
  const hostErrorMessage = (err) => modelErrorMessage(err);
  const hostErrorType = (err) => (err instanceof Error || (err && typeof err.name === 'string'))
    ? String(err.name || 'Error') : 'UnknownError';

  // Every capability the guest can reach is a member of this one registry.
  // Errors are returned as DATA (not thrown) because `run` redacts host error
  // messages to "Host function failed."; the guest wrapper reconstructs a real
  // guest Error with the original message so try/catch and errorInfo() keep
  // their historical, actionable text.
  const registry = {
    log: (prefix, parts) => {
      logs.push(`${prefix ? prefix + ' ' : ''}${parts.join(' ')}`);
    },
    atob: (s) => Buffer.from(String(s), 'base64').toString('utf8'),
    btoa: (s) => Buffer.from(String(s), 'utf8').toString('base64'),
    encode: (s) => Array.from(Buffer.from(String(s), 'utf8')),
    decode: (bytes) => Buffer.from(Array.from(bytes ?? [])).toString('utf8'),
    digest: (algo, data, encoding = 'hex') =>
      createHash(String(algo).toLowerCase())
        .update(typeof data === 'string' ? data : Buffer.from(data))
        .digest(encoding),
    listTools: (options) => {
      const opts = options && typeof options === 'object' ? options : {};
      let list = tools;
      if (typeof opts.service === 'string' && opts.service) {
        list = list.filter((t) => (t.server ?? '') === opts.service);
      }
      const entries = list.map(listSummary);
      // brief:true -> name + service only; default -> name/service/readOnly/summary.
      const result = opts.brief ? entries.map(({ name, service }) => ({ name, service })) : entries;
      // Eval closure: expose a compact, secret-free snapshot of the tool surface
      // to capture so passive analysis can see "which services were mounted"
      // without reading the full response body. Best-effort; never changes the
      // guest-visible return value.
      try {
        captureEvent('gateway_helper', {
          helper: 'listTools',
          ok: true,
          count: result.length,
          services: [...new Set(result.map((entry) => entry?.service).filter(Boolean))].slice(0, 30),
        });
      } catch { /* capture is best-effort */ }
      return result;
    },
    // (#42) Return a plain object: run-js-v1 drops named props on arrays, so
    // the guest prelude rebuilds the array-with-named-props shape.
    // RC-D4: share the exact fallback logic with the outer search handler.
    search: (query) => {
      const { res, hint } = searchWithFallback(tools, query, 5);
      return {
        matches: res.matches.map((e) => withCallName(e, formatToolSummary, { compact: true })),
        total: res.total,
        hint,
      };
    },
    remainingCalls: () => {
      const remaining = Math.max(0, maxCalls - calls);
      try {
        captureEvent('gateway_helper', { helper: 'remainingCalls', ok: true, remaining });
      } catch { /* capture is best-effort */ }
      return remaining;
    },
    // Gemini new feedback #3: the snapshot is computed on the host from local
    // upstream state only; a getter (when provided) keeps it fresh even if the
    // manager was populated after createCodeModeTools() ran.
    services: () => {
      const snapshot = typeof servicesInfo === 'function' ? servicesInfo() : servicesInfo;
      // Eval closure: mirror the cold-start service state into capture so the
      // passive lane can see offline/needsReauth upstreams. Only identity/state
      // fields cross (no tokens, no notes).
      try {
        const rows = Array.isArray(snapshot?.services) ? snapshot.services : [];
        captureEvent('gateway_helper', {
          helper: 'services',
          ok: true,
          services: rows.slice(0, 50).map((row) => ({
            name: row?.name ?? null,
            toolCount: Number(row?.toolCount ?? 0) || 0,
            status: row?.status ?? null,
            online: row?.online === true,
            needsReauth: Boolean(row?.needsReauth),
          })),
        });
      } catch { /* capture is best-effort */ }
      return snapshot;
    },
    // B14 · sandbox-only typed-plan helper. `typedPlanReadOnly` (set by the
    // execute_read handler) is forced on here so a guest cannot opt out; the
    // dryRun default is applied host-side too. Errors never cross the bridge.
    runTypedPlan: (plan, opts) => {
      const o = opts && typeof opts === 'object' && !Array.isArray(opts) ? opts : {};
      const readOnly = typedPlanReadOnly === true;
      const dryRun = o.dryRun === undefined ? true : o.dryRun === true;
      try {
        // F-04: v1 plans have no step cap of their own; enforce the same 64-step
        // ceiling as v2 HERE (host side, guest cannot pass an override) so a
        // huge plan cannot even be validated into an unbounded I/O loop.
        if (Array.isArray(plan) && plan.length > MAX_TYPED_PLAN_STEPS) {
          const err = new Error(`typed plan exceeds ${MAX_TYPED_PLAN_STEPS} steps (${plan.length})`);
          err.code = 'TYPED_PLAN_TOO_MANY_STEPS';
          throw err;
        }
        let io;
        if (typedPlanIO && typeof typedPlanIO === 'object') {
          // Injected adapter: charge once per method invocation (runChecks is a
          // local stub, no upstream I/O). Individual underlying invokes are the
          // adapter's responsibility; the default adapter charges each one.
          io = {};
          for (const [name, fn] of Object.entries(typedPlanIO)) {
            io[name] = typeof fn === 'function'
              ? (...args) => { if (name !== 'runChecks') chargeBudget('typedPlan'); return fn(...args); }
              : fn;
          }
        } else {
          io = createDefaultTypedPlanIO({ tools, callTool, charge: () => chargeBudget('typedPlan') });
        }
        return executeTypedPlan(plan, {
          io,
          ...(typedPlanOps && typeof typedPlanOps === 'object' ? { ops: typedPlanOps } : {}),
          dryRun,
          approve: o.approve,
          readOnly,
        });
      } catch (err) {
        return typedPlanFailure(err, dryRun, readOnly);
      }
    },
    // B10 integration: the canonical adapter runs in the host realm so its
    // `raw` field keeps the exact adapter semantics. Guest cannot pass functions
    // across the bridge, so only (kind, toolName, value, context) are serialized in.
    normalizeResult: (kind, toolName, value, context) => {
      // The canonical adapters are tool-name dispatched; when a caller passes
      // an explicit name we honour it, otherwise we use a representative name
      // for the kind so the dispatch always lands on the right adapter.
      // PR #41–#48: explicit canonical / merge kinds return the minimal
      // {number,url,sha,raw} view so callers never have to regex a URL for the
      // id. All other kinds keep the historical adapter behaviour unchanged.
      // Issue #15 / BC-011: `context` ({owner,repo,pullNumber} or a bare
      // number) fills number/url when a merge result omits them.
      if (kind === 'canonical' || kind === 'merge') {
        const canon = canonicalResult(value, context);
        return { ...canon, rawUntrusted: canon.rawUntrusted ?? RESULT_RAW_MARKER };
      }
      const name = (toolName !== undefined && toolName !== null && toolName !== '')
        ? toolName
        : (kind === 'file' ? 'get_file_contents'
          : kind === 'pr' ? 'get_pull_request'
            : kind === 'issue' ? 'get_issue' : '');
      // Historical adapters keep their exact field sets (normalizePr already
      // carries top-level number/url/sha; normalizeIssue keeps its documented
      // shape). Callers that need the unified minimal view use the explicit
      // `canonical` / `merge` kinds or codemode.canonicalize below.
      const adapted = hostNormalizeResult(name, value);
      // Batch 15 P0: host adapters attach notice/truncation as non-enumerable
      // to preserve stable key sets for direct callers. Across the sandbox
      // bridge we surface them as enumerable metadata so the MODEL sees them
      // (a download notice must be a labelled field, never `content`).
      if (!adapted || typeof adapted !== 'object') return adapted;
      const modelView = { ...adapted };
      for (const key of ['notice', 'noticeSha', 'truncation']) {
        const v = adapted[key];
        if (v !== undefined && v !== null) modelView[key] = v;
      }
      return modelView;
    },
    // Host pure-function bridges for the B10 follow-up write helpers. Safe:
    // only serializable data crosses (no functions).
    canonicalize: (value, context) => canonicalResult(value, context),
    precheckText: (text, path) => precheckText(text, path),
    normalizeWriteResult: (value, sha) => normalizeWriteResult(value, { sha }),
    // Batch 11: exact tool availability check (no tool-call budget consumed).
    hasTool: (name) => byIdent.has(String(name)),
    // Batch 11 · GitHub Actions read-only REST helpers. Gateway-side fetch is
    // injected (tests pass a fake); token comes from GITHUB_TOKEN and is never
    // logged or echoed. F-04: these DO consume the same per-execute tool-call
    // budget now (they issue outbound REST GETs); a stable error is returned
    // when the budget is exhausted, matching registry.tool's limit message.
    ...(() => {
      const action = (fn) => (opts) => {
        chargeBudget('githubActions');
        return fn({
          fetch: hostFetch ?? (typeof fetch === 'function' ? fetch : undefined),
          env,
          ...(opts && typeof opts === 'object' ? opts : {}),
        });
      };
      return {
        github_actions_list_workflow_runs: action(githubActionsListWorkflowRuns),
        github_actions_list_workflow_jobs: action(githubActionsListWorkflowJobs),
        github_actions_get_job_logs: action(githubActionsGetJobLogs),
      };
    })(),
    // Batch 15 P2 · read-only CI wait. The check callback uses the SAME
    // upstream tool bridge as every codemode.<tool>() call (no new MCP tool,
    // no direct REST/token handling). `pull_request_read` is aggregated, so
    // method:"get_check_runs" is passed explicitly to avoid a probe round.
    wait_for_pr_checks: (opts) => {
      const o = opts && typeof opts === 'object' && !Array.isArray(opts) ? opts : {};
      const tool = byIdent.get('github__pull_request_read') ?? [...byIdent.values()].find(
        (t) => String(t?.tool ?? t?.name).endsWith('pull_request_read'),
      );
      if (!tool) {
        return Promise.resolve({
          ok: false, error: 'waitForPrChecks: github__pull_request_read is not available in this session',
          pullNumber: o.pullNumber ?? null, polls: 0, timedOut: false,
        });
      }
      return waitForPrChecks({
        ...o,
        check: async (args) => {
          chargeBudget('waitForPrChecks');
          return unwrapResult(await callTool(
            tool.server,
            tool.tool,
            {
              owner: args.owner, repo: args.repo, pullNumber: args.pullNumber,
              method: 'get_check_runs',
            },
          ));
        },
      });
    },
    // Batch 17 · build the injected callables map from the REAL tools present
    // in this session. Tool names are resolved from `byIdent` / descriptors —
    // never hard-coded as an assumed upstream capability. Every invocation goes
    // through `registry.tool`, so budget, audit and dedup still apply.
    create_issue: (opts) => {
      const o = opts && typeof opts === 'object' && !Array.isArray(opts) ? opts : {};
      // callables are derived from tools actually mounted in this session —
      // an absent issue tool yields UNSUPPORTED_UPSTREAM_TOOL, never a fake.
      return createIssueHelper({ ...o, callables: buildCallables(), tools });
    },
    rerun_failed_jobs: (opts) => {
      const o = opts && typeof opts === 'object' && !Array.isArray(opts) ? opts : {};
      const callables = buildCallables();
      return rerunFailedJobsHelper({ ...o, callables });
    },
    merge_with_branch_delete: (opts) => {
      const o = opts && typeof opts === 'object' && !Array.isArray(opts) ? opts : {};
      const deleteIdent = findToolIdent(['delete_branch', 'delete_ref', 'delete_git_ref']);
      return mergeWithBranchDeleteHelper({
        ...o,
        merge: (args) => toolByIdentArg(o.mergeTool, args, 'merge_pull_request'),
        deleteBranchTool: deleteIdent
          ? (args) => invokeToolByIdent(deleteIdent, args)
          : undefined,
      });
    },
    delete_files: (opts) => {
      const o = opts && typeof opts === 'object' && !Array.isArray(opts) ? opts : {};
      const deleteIdent = findToolIdent(['delete_file', 'delete_files', 'delete_git_file', 'delete_repository_file']);
      const gitDataIdent = findToolIdent(['git_data', 'gitdata', 'git_data_api', 'commit_with_git_data']);
      return deleteFilesHelper({
        ...o,
        deleteFile: deleteIdent ? (args) => invokeToolByIdent(deleteIdent, args) : undefined,
        gitData: gitDataIdent ? (args) => invokeToolByIdent(gitDataIdent, args) : undefined,
      });
    },
    rename_files: (opts) => {
      const o = opts && typeof opts === 'object' && !Array.isArray(opts) ? opts : {};
      const readIdent = findToolIdent(['get_file_contents']);
      const writeIdent = findToolIdent(['create_or_update_file']);
      const deleteIdent = findToolIdent(['delete_file', 'delete_files', 'delete_git_file', 'delete_repository_file']);
      const gitDataIdent = findToolIdent(['git_data', 'gitdata', 'git_data_api', 'commit_with_git_data']);
      return renameFilesHelper({
        ...o,
        readFile: readIdent ? (args) => invokeToolByIdent(readIdent, args) : undefined,
        writeFile: writeIdent ? (args) => invokeToolByIdent(writeIdent, args) : undefined,
        deleteFile: deleteIdent ? (args) => invokeToolByIdent(deleteIdent, args) : undefined,
        gitData: gitDataIdent ? (args) => invokeToolByIdent(gitDataIdent, args) : undefined,
      });
    },
    stub: (name) => {
      throw new Error(`${name} is a write tool and unavailable in execute_read; use execute() instead`);
    },
    tool: async (ident, args) => {
      const tool = byIdent.get(ident);
      if (!tool) throw new Error(`unknown tool: ${ident}`);
      // Pre-flight before any budget/audit/dedup bookkeeping or upstream call:
      // cheap, actionable errors beat an upstream 400 + another model round.
      validateToolArgs(tool, args);
      // Batch 15 P0: branch -> ref for github__get_file_contents only. Applied
      // before dedup/audit so the cache key and the recorded args match what is
      // actually sent upstream. The alias is recorded but the result is NOT
      // altered in any way (pure pass-through of the upstream response).
      const alias = aliasGetFileContentsArgs(tool.name ?? tool.tool, args);
      const finalArgs = alias.args;
      const dedupeKey = isReadOnlyTool(tool)
        ? `${tool.server ?? ''}::${tool.tool ?? ''}::${stableKey(finalArgs ?? {})}`
        : null;
      if (dedupeKey !== null && cache.has(dedupeKey)) return cache.get(dedupeKey);

      chargeBudget('tool');
      toolCalls.push({
        name: tool.name,
        args: summarizeArgs(finalArgs),
        ...(alias.aliased ? { argAlias: { ref: 'branch' } } : {}),
      });
      const raw = await callTool(tool.server, tool.tool, finalArgs ?? {});
      // Throw on upstream errors and auto-parse JSON results so model scripts
      // can use the return value directly without JSON.parse(content[0].text).
      const value = unwrapResult(raw);
      if (dedupeKey !== null) cache.set(dedupeKey, value);
      return value;
    },
  };

  const invoke = (name, args) => {
    try {
      // F-06: registry keys are fixed host capabilities. Reject prototype and
      // inherited names explicitly so no guest-crafted name can reach Object
      // prototype methods or a reserved internal function.
      if (typeof name !== 'string'
        || name === '__proto__' || name === 'constructor' || name === 'prototype'
        || !Object.prototype.hasOwnProperty.call(registry, name)) {
        throw new Error(`unknown bridge function: ${String(name)}`);
      }
      const fn = registry[name];
      if (typeof fn !== 'function') throw new Error(`unknown bridge function: ${name}`);
      return Promise.resolve()
        .then(() => fn(...(Array.isArray(args) ? args : [])))
        .then(
          (value) => ({ value }),
          (err) => ({
            __hostError: 1, message: hostErrorMessage(err), type: hostErrorType(err),
            ...(err && typeof err.code === 'string' ? { code: err.code } : {}),
          }),
        );
    } catch (err) {
      return {
        __hostError: 1, message: hostErrorMessage(err), type: hostErrorType(err),
        ...(err && typeof err.code === 'string' ? { code: err.code } : {}),
      };
    }
  };

  // Tools excluded by execute_read's filter are registered as stubs that throw
  // an actionable message — otherwise the model gets a cryptic "not a function"
  // even though search() showed the tool. (Real regression from v2 exploration.)
  const toolLines = [];
  // Gemini feedback #2: bind every tool under BOTH its sanitized identifier
  // (underscores) and its original name (may contain hyphens). A model that
  // copies either the `callName` or the literal `name` from a search hit now
  // gets a working codemode[…] function instead of "not a function".
  //
  // 2026-11-22 residual feedback: the bridge returns already-resolved values, so
  // tool methods were not Promises and `.then()/.catch()` threw "not a function".
  // Real tool calls are now guest `async` functions (native Promises) so
  // `p.catch(...)`, `p.then(...)` and `Promise.all(map(...))` work. Stubs stay
  // synchronous on purpose: an un-awaited write attempt in execute_read must
  // still fail the script with the actionable "use execute()" error.
  const bind = (key, invokeExpr, asPromise = false) => {
    toolLines.push(`codemode[${JSON.stringify(key)}] = __dshHide(${asPromise ? 'async ' : ''}(args) => ${invokeExpr});`);
  };
  for (const tool of unavailableTools ?? []) {
    const ident = sanitizeToolName(tool.name);
    // F-06: reserved idents are never bound, even as stubs.
    if (!ident || RESERVED_TOOL_IDENTS.has(ident)) continue;
    if (!byIdent.has(ident)) {
      const expr = `__dshInvoke("stub", [${JSON.stringify(tool.name)}])`;
      bind(ident, expr);
      if (tool.name !== ident && !RESERVED_TOOL_IDENTS.has(tool.name)) bind(tool.name, expr);
    }
  }
  for (const [ident, tool] of byIdent) {
    const expr = `__dshInvoke("tool", [${JSON.stringify(ident)}, args])`;
    bind(ident, expr, true);
    if (tool.name !== ident && !RESERVED_TOOL_IDENTS.has(tool.name)) bind(tool.name, expr, true);
  }

  // Keep the sentinel on prelude line 1 and the model function immediately
  // after the prelude: code line L therefore lives on source line
  // GUEST_PREFIX_LINES + L (before the SDK's constant wrapper offset).
  const source = [
    GUEST_PRELUDE,
    ...toolLines,
    // Keep the user function source untouched (works for block and expression
    // arrow bodies). The wrapper samples its own run.js line immediately after
    // the user function definition; mapping uses the fixed 3-line delta.
    `const __dshUserFn = (${instrumented});`,
    'let __dshUserStart = 0;',
    'const __dshFn = async () => {',
    '  __dshUserStart = (() => { const m = /run\\.js:(\\d+)/.exec(String(new Error().stack || "")); return m ? Number(m[1]) : 0; })();',
    '  return await __dshUserFn();',
    '};',
    'return Promise.resolve().then(() => __dshFn()).then(',
    '  (v) => ({ __ok: true, v: v, cal: __dshCal, codeStart: __dshUserStart }),',
    '  (e) => ({ __ok: false, cal: __dshCal, codeStart: __dshUserStart, line: __dshLineNo, err: { message: e != null && e.message !== undefined ? String(e.message) : String(e), type: (e instanceof Error) ? String(e.name || "Error") : "UnknownError", hostOrigin: !!(e && e.__dshHostOrigin), stack: e && e.stack ? String(e.stack) : "" } })',
    ');',
  ].join('\n');

  const totalMs = totalTimeout ?? Math.max(timeout * 2, 1000);
  const controller = new AbortController();
  const runner = createRunner({
    limits: {
      // withDeadline owns the legacy timeout message; give the SDK a little
      // extra wall time so its own RUN_TIMEOUT cannot win that race.
      timeoutMs: totalMs + 100,
      cpuTimeoutMs: Math.max(1, Math.min(timeout, totalMs)),
      maxResultBytes: 16 * 1024 * 1024,
      maxBridgeRequests: 2048,
    },
    // F-06: inject under a non-guessable group name; guest code can only reach
    // the registry through __dshInvoke (which rebuilds guest Errors).
    syncHostFunctions: { [BRIDGE_GLOBAL]: { invoke } },
  });

  const run = runner.run({ source, abortSignal: controller.signal }).then((res) => {
    if (res.status !== 'completed') throw new Error(`sandbox run ${res.status}`);
    const env = res.value && typeof res.value === 'object' ? res.value : {};
    const cal = Number(env.cal);
    // The sentinel Error is created on source line 1; its reported line minus
    // one is the SDK's internal wrapper offset (self-calibrating across versions).
    const wrapperOffset = Number.isFinite(cal) && cal > 0 ? cal - 1 : 2;
    if (!env.__ok) {
      const e = env.err && typeof env.err === 'object' ? env.err : {};
      let scriptLoc;
      if (!e.hostOrigin) {
        // Prefer the last executed statement marker: it is source-line data we
        // control, independent of the SDK's production stack shape.
        const markerLine = Number(env.line);
        if (e.type !== 'UnknownError' && Number.isFinite(markerLine) && markerLine > 0) scriptLoc = { line: markerLine, column: 1 };
        else if (typeof e.stack === 'string') scriptLoc = pickScriptLoc(e.stack, Number(env.codeStart), normalized.split('\n').length);
      }
      const err = new Error(String(e.message ?? ''));
      err.name = String(e.type || 'Error');
      throw Object.assign(err, { __dshScriptLoc: scriptLoc });
    }
    return env.v;
  }).then((sandboxReturn) => {
    // Model-facing value: structured truncation keeps the result valid JSON
    // of the same shape, with `--- TRUNCATED ---` markers at the cut points.
    const truncatedValue = truncateResultValue(sandboxReturn, { maxChars: maxResultChars });
    // Batch 15 P1: derive explicit, machine-readable truncation metadata on
    // the model-facing projection (field names, totals, tail flag, continuation).
    const structuredResult = withTruncationMetadata(truncatedValue, sandboxReturn);
    // Legacy string view kept for direct callers of runInSandbox().
    let legacy;
    try { legacy = typeof sandboxReturn === 'string' ? sandboxReturn : JSON.stringify(sandboxReturn ?? null); }
    catch { legacy = String(sandboxReturn); }
    const legacyResult = truncateResponseText(legacy ?? '', { maxChars: maxResultChars });
    return makeOutput({ legacyResult, structuredResult, logs: boundLogs(logs), toolCalls });
  });

  // (#46) A hung host-side callTool() would otherwise keep the whole round
  // open forever. The wall-clock race is unchanged; aborting also lets `run`
  // retire the blocked worker. Any error becomes the same structured result
  // as a sandbox throw, keeping tool calls/logs in the audit trail.
  return withDeadline(run, totalMs, `execute overall timeout (${totalMs}ms)`, () => controller.abort())
    .catch((err) => {
      const scriptLoc = err?.__dshScriptLoc;
      const e = err?.code === 'RUN_TIMEOUT' ? new Error(`execute overall timeout (${totalMs}ms)`) : err;
      return makeErrorOutput(e, logs, toolCalls, scriptLoc);
    });
}

/**
 * Gemini feedback #1: build a tiny "Connected services: ..." suffix from the
 * ACTUAL upstream entries (deduped by server, sorted for stability). One line,
 * near-zero tokens, so a cold-starting model already knows what is mounted.
 */
function connectedServicesSuffix(entries) {
  const servers = [...new Set(
    (Array.isArray(entries) ? entries : [])
      .map((e) => (e && typeof e.server === 'string' ? e.server : ''))
      .filter(Boolean),
  )].sort();
  return servers.length ? ` Connected services: ${servers.join(', ')}.` : '';
}

/**
 * Gemini new feedback #1: list-mode search hits carry a *bounded* description.
 * Upstream descriptions can be thousands of characters (Notion's spec), which
 * blew the context with just 5 hits. We keep 1 short sentence / the first line,
 * capped at MAX_SEARCH_DESC_CHARS, and append `…` to signal that `select:<name>`
 * still returns the full text. This wraps the shared formatter in codemode.js
 * only — tool-format.js's formatToolSummary() body is left untouched.
 */
const MAX_SEARCH_DESC_CHARS = 160;
const SENTENCE_END_RE = /[.!?。！？]/;
const TRAILING_PUNCT_RE = /[,，、;；:：.!?。！？]+$/;

function compactDescription(description) {
  const raw = String(description ?? '');
  const nl = raw.indexOf('\n');
  const firstLine = nl >= 0 ? raw.slice(0, nl) : raw;
  const s = firstLine.replace(/\s+/g, ' ').trim();
  if (!s) return '';
  let truncated = nl >= 0 && raw.slice(nl + 1).trim().length > 0;
  let cut = s.length;
  const sentence = SENTENCE_END_RE.exec(s);
  if (sentence) cut = Math.min(cut, sentence.index + 1); // keep the terminator
  if (cut < s.length) truncated = true;
  // Reserve one character for the ellipsis so the result is always <=160.
  if (cut > MAX_SEARCH_DESC_CHARS - 1) { cut = MAX_SEARCH_DESC_CHARS - 1; truncated = true; }
  let out = s.slice(0, cut).trimEnd();
  if (truncated) out = out.replace(TRAILING_PUNCT_RE, '') + '…';
  return out;
}

/**
 * Gemini new feedback #2: attach the exact sandbox-callable identifier and an
 * explicit `access` class ("read"/"write", from isReadOnlyTool) to a formatted
 * search hit. Gemini new feedback #1: compact the description for list mode
 * only; `select:<name>` keeps the full upstream description verbatim.
 * Kept here (not in tool-format.js) so the shared format helpers and their
 * file ownership stay untouched.
 *
 * @param {object} entry tool descriptor (carries `name`/`tool`/`annotations`)
 * @param {Function} formatter formatToolSummary | formatToolDetail
 * @param {{compact?: boolean}} opts compact=true for list-mode results
 */
function withCallName(entry, formatter, { compact = false } = {}) {
  const hit = formatter(entry);
  const usage = toolUsageNote(entry);
  const out = {
    ...hit,
    callName: sanitizeToolName(entry.name),
    access: isReadOnlyTool(entry) ? 'read' : 'write',
    ...(usage ? { usage } : {}),
  };
  if (usage) {
    // Search detail (`select:<name>`) must be self-documenting; the compact
    // list keeps its 160-char cap and exposes the same note via `usage`.
    out.description = `${String(out.description ?? '').trimEnd()}\nUsage: ${usage}`.trim();
  }
  if (compact && typeof out.description === 'string') {
    out.description = compactDescription(out.description);
  }
  return out;
}

/**
 * Conservative freshness window (1 hour). Used ONLY when an upstream manager
 * actually exposes a local observation/expiry timestamp — we never infer
 * freshness from "has entries", because a token can expire at any moment.
 */
const SERVICE_FRESHNESS_WINDOW_MS = 60 * 60 * 1000;

/**
 * Best-effort, zero-network read of local freshness evidence for one server.
 * The real UpstreamManager exposes no observation/expiry timestamp today, so
 * every source here is an OPTIONAL seam: missing or unreadable values return
 * null and the caller falls back to the honest "observed" status. Never reads
 * the auth store, never performs I/O, never throws at the caller.
 *
 * @returns {{observedAtMs: number|null, expiresAtMs: number|null}|null}
 */
function readServiceFreshness(upstreamManager, name) {
  if (!upstreamManager || typeof upstreamManager !== 'object') return null;
  const toMs = (v) => {
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
      // Accept unix seconds (10 digits) or milliseconds (13 digits).
      return v < 1e11 ? v * 1000 : v;
    }
    if (typeof v === 'string') {
      const t = Date.parse(v);
      return Number.isFinite(t) ? t : null;
    }
    return null;
  };
  let observedAtMs = null;
  for (const candidate of [
    upstreamManager.lastConnectAtByServer?.[name],
    upstreamManager.connectedAtByServer?.[name],
    upstreamManager.lastConnectAt,
    upstreamManager.connectedAt,
    upstreamManager.coldStartAt,
  ]) {
    observedAtMs = toMs(candidate);
    if (observedAtMs != null) break;
  }
  let expiresAtMs = null;
  try {
    if (typeof upstreamManager.getTokenExpiresAt === 'function') {
      expiresAtMs = toMs(upstreamManager.getTokenExpiresAt(name));
    }
  } catch (_) { /* an optional seam must never break the snapshot */ }
  if (expiresAtMs == null) {
    const map = upstreamManager.tokenExpiresAt ?? upstreamManager.serverTokenExpiry;
    if (map && typeof map === 'object') expiresAtMs = toMs(map[name]);
  }
  if (observedAtMs == null && expiresAtMs == null) return null;
  return { observedAtMs, expiresAtMs };
}

/**
 * Honest, time-aware view of locally known services. Zero network calls: only
 * getEntries()/failedServers and optional local timestamps are read.
 *
 * A mounted upstream has NO live liveness signal here — its token can expire a
 * minute after cold start. So the default is the conservative downgrade:
 *   - status "observed"  = mounted at cold start, no recorded failure, NOT
 *                          live-verified (never "healthy" without evidence);
 *   - status "offline"   = present in failedServers;
 *   - every service carries `verifiedAt` (when the snapshot was produced) and
 *     a `note` stating it is a cold-start snapshot, not a live health check.
 * "healthy"/"stale" are emitted only when real local evidence exists, and even
 * then the note keeps the snapshot caveat. Claiming "healthy" from "has
 * entries" alone is exactly the false sense of security this fix removes.
 *
 * `online`/`needsReauth` are retained as legacy compatibility fields only:
 * `online:true` means "mounted at cold start with no recorded failure", never
 * "verified working now". status/verifiedAt/note are the authoritative fields.
 */
export function servicesSnapshot(upstreamManager) {
  const rawEntries = upstreamManager?.getEntries?.();
  const entries = Array.isArray(rawEntries) ? rawEntries : [];
  const failed = upstreamManager?.failedServers;
  const failedNames = Array.isArray(failed) ? failed : (failed instanceof Set ? [...failed] : []);
  const failedSet = new Set(failedNames.filter(Boolean));
  const byServer = new Map();
  for (const e of entries) {
    const name = e && typeof e.server === 'string' && e.server ? e.server : '';
    if (!name) continue;
    byServer.set(name, (byServer.get(name) ?? 0) + 1);
  }
  const now = Date.now();
  const snapshotAt = new Date(now).toISOString();
  const observedNote = `Observed at cold-start snapshot ${snapshotAt}; not live-verified. Mounted with no recorded failure only — the credential can expire at any time; if a tool call returns invalid_token/unauthorized the upstream needs re-auth.`;
  const offlineNote = `Observed at cold-start snapshot ${snapshotAt}; connection failed — token may have expired / needs re-auth. Not live-verified.`;
  const reauthNote = '连接失败，可能是 token 失效 / 需要重新授权'; // legacy field, kept verbatim
  const services = [];
  for (const [name, toolCount] of byServer) {
    if (failedSet.has(name)) {
      services.push({
        name, toolCount, status: 'offline', verifiedAt: snapshotAt,
        note: offlineNote, online: false, needsReauth: reauthNote,
      });
      continue;
    }
    const evidence = readServiceFreshness(upstreamManager, name);
    if (!evidence) {
      // Honest downgrade: no expiry/observation data -> "observed", not "healthy".
      services.push({
        name, toolCount, status: 'observed', verifiedAt: snapshotAt,
        note: observedNote, online: true,
      });
      continue;
    }
    const observedAtMs = evidence.observedAtMs ?? now;
    const expiresAtMs = evidence.expiresAtMs;
    const nearExpiry = expiresAtMs != null && expiresAtMs - now <= SERVICE_FRESHNESS_WINDOW_MS;
    const oldObservation = now - observedAtMs > SERVICE_FRESHNESS_WINDOW_MS;
    const verifiedAt = new Date(observedAtMs).toISOString();
    services.push({
      name, toolCount,
      status: (nearExpiry || oldObservation) ? 'stale' : 'healthy',
      verifiedAt,
      note: `Local snapshot observed at ${verifiedAt}${expiresAtMs != null ? `; credential expires ${new Date(expiresAtMs).toISOString()}` : ''}; not a live health check — invalid_token/unauthorized means the upstream needs re-auth.`,
      online: true,
    });
  }
  // A server that failed before exposing any tool must still show up as offline.
  for (const name of failedSet) {
    if (!byServer.has(name)) {
      services.push({
        name, toolCount: 0, status: 'offline', verifiedAt: snapshotAt,
        note: offlineNote, online: false, needsReauth: reauthNote,
      });
    }
  }
  services.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return { services };
}

/* -------------------------------------------------------------------------- *
 * M1 client-isolation slots
 *
 * These three helpers are the ONLY places a client profile may influence the
 * Code Mode tool face. They never change tool names/order, input schemas, or
 * execution semantics:
 *   - annotations      -> per-tool hints only (informational, not a boundary);
 *   - descriptionMode  -> 'full' (default, historical text) | 'compact';
 *   - outputBudgetChars-> per-execute result budget (default = historical cap).
 * With the stock profiles every helper returns the historical value, so the
 * default output stays byte-for-byte identical.
 * -------------------------------------------------------------------------- */

/**
 * Per-client output budget for one execute_read/execute result.
 *
 * Precedence: an explicit operator/config `maxResultChars` always wins (it may
 * be a hard global cap); otherwise the profile's `outputBudgetChars` applies;
 * the final fallback is the historical global default. A null/undefined
 * `options.maxResultChars` therefore keeps the exact old behaviour.
 */
function resolveExecuteOutputBudget(profile, options) {
  const configured = options?.maxResultChars;
  if (configured !== undefined && configured !== null) return configured;
  const profileBudget = profile?.outputBudgetChars;
  if (typeof profileBudget === 'number' && Number.isFinite(profileBudget) && profileBudget > 0) {
    return profileBudget;
  }
  return DEFAULT_MAX_RESULT_CHARS;
}

/** Pick the profile's tool-description verbosity; 'full' is byte-identical. */
function resolveToolDescription(profile, fullDescription, compactDescription) {
  return profile?.descriptionMode === DESCRIPTION_MODE_COMPACT
    ? compactDescription
    : fullDescription;
}

/**
 * Build the two Code Mode MCP tools bound to an UpstreamManager.
 */
export function createCodeModeTools(upstreamManager, options = {}) {
  // Thin client profile: options.profile is resolved once per HTTP request by
  // server.js; direct callers get the same resolution from their own
  // headers/body/oauthClientId (unknown -> gemini default). No execution
  // semantics change.
  const profile = options.profile ?? resolveClientProfile({
    headers: options.headers,
    body: options.body,
    env: options.env,
    oauthClientId: options.oauthClientId,
    oauthClientMap: options.oauthClientMap,
  });
  const tools = upstreamManager.getEntries?.() ?? [];
  const sanitized = tools.map((t) => ({ ...t, ident: sanitizeToolName(t.name) }));
  const servicesSuffix = connectedServicesSuffix(tools);
  // Gemini new feedback #3: pass a getter (not a frozen copy) so codemode.services()
  // reflects local state at call time; it reads no network.
  const getServices = () => servicesSnapshot(upstreamManager);

  // M1 `descriptionMode: 'compact'` is a reserved per-client slot. The default
  // 'full' path below is the historical text, byte-for-byte; compact only
  // trims tool-definition prose and keeps the safety boundary line.
  const compactSearchDescription = 'Search upstream tools. Plain keywords return ranked matches; "select:<exact_tool_name>" returns one tool\'s full inputSchema.'
    + CALLNAME_GUIDANCE + servicesSuffix;
  const compactExecuteReadDescription = 'Run READ-ONLY JavaScript via codemode.<tool>(args); return only what the model needs. Example: async () => (await codemode.github__search_repositories({query:"x"})).total_count'
    + servicesSuffix + EXEC_BOUNDARY_GUIDANCE;
  const compactExecuteDescription = 'Run JavaScript calling upstream tools via codemode.<tool>(args); process large results inside code and return only a summary. Example: async () => (await codemode.github__search_repositories({query:"x"})).total_count'
    + servicesSuffix + EXEC_BOUNDARY_GUIDANCE;

  const searchTool = {
    name: 'search',
    description: resolveToolDescription(
      profile,
      'Search upstream tools. Two modes: (1) Plain keywords -> a ranked list of matching tools with compact param signatures (name!: required). (2) To see one tool\'s full inputSchema, pass EXACTLY "select:<name>" where <name> is a tool name copied from a search result (e.g. "select:github__issue_write"). Do NOT put task descriptions or phrases after "select:" — only an exact tool name works; for anything else use plain keyword search. Prefix a service name (e.g. "vercel ...") to focus on that service.' + CALLNAME_GUIDANCE + servicesSuffix,
      compactSearchDescription,
    ),
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Keywords describing the capability you need' }, limit: { type: 'integer', minimum: 1, maximum: 10 } },
      required: ['query'],
    },
    annotations: resolveToolAnnotations('search', profile, { readOnlyHint: true, destructiveHint: false, openWorldHint: false }),
    handler: async (args) => {
      const limit = Number.isFinite(args?.limit) ? args.limit : 8;
      // RC-D4: delegate to the shared routine so this and the in-sandbox
      // codemode.search cannot drift apart again. select: still bypasses the
      // fallback and is rendered as a full detail (formatToolDetail).
      const { res, hint, isSelect } = searchWithFallback(tools, args?.query ?? '', limit);
      const formatter = isSelect ? formatToolDetail : formatToolSummary;
      return {
        // List mode -> compact description; select: -> full description.
        matches: res.matches.map((e) => withCallName(e, formatter, { compact: !isSelect })),
        total: res.total,
        hint,
      };
    },
  };

  const makeExecute = (name, readOnly) => {
    const fullDescription = (readOnly
      ? 'Write JavaScript to call READ-ONLY upstream tools (get/list/search/query) via codemode.<tool>(args). This tool is annotated read-only so the client may prompt less; it runs the same sandbox as execute(). Only your return value enters the conversation. Available read-only helpers: safeAll(tasks), unwrapBatch(x), unwrap(x), readFileRange(), waitForPrChecks(), github_actions_*. Example: async () => { const r = await codemode.github__search_repositories({query:"x"}); return r.total_count; }'
      : 'Write JavaScript to call upstream tools via codemode.<tool>(args). Only your returned value enters the conversation — process large results inside code and return a summary. Available: codemode.listTools(), codemode.search(q), codemode.remainingCalls(), codemode.services(), safeAll(tasks), unwrapBatch(x), unwrap(x), global search(), TextEncoder/atob/URL/crypto, and one method per upstream tool. Example: async () => { const r = await codemode.github__search_repositories({query:"x"}); return r.total_count; }')
      + RETURN_SHAPE_GUIDANCE + SERVICES_GUIDANCE + ASYNC_GUIDANCE + ACTIONS_GUIDANCE
      + GH_HIGHFREQ_GUIDANCE + LINEAR_CONTEXT_GUIDANCE + B15_ERGONOMICS_GUIDANCE + B17_FEEDBACK_GUIDANCE
      + servicesSuffix + EXEC_BOUNDARY_GUIDANCE;
    return {
      name,
      description: resolveToolDescription(
        profile,
        fullDescription,
        readOnly ? compactExecuteReadDescription : compactExecuteDescription,
      ),
      inputSchema: {
        type: 'object',
        properties: { code: { type: 'string', description: 'An async arrow function that calls codemode tools and returns a result.' } },
        required: ['code'],
      },
      annotations: resolveToolAnnotations(
        name,
        profile,
        readOnly
          ? { readOnlyHint: true, destructiveHint: false, openWorldHint: true }
          : { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      ),
      handler: async (args) => {
        const code = String(args?.code ?? '');
        const usable = readOnly ? sanitized.filter(isReadOnlyTool) : sanitized;
        const unavailable = readOnly ? sanitized.filter((t) => !isReadOnlyTool(t)) : [];
        const full = await runInSandbox({
          code,
          tools: usable,
          unavailableTools: unavailable,
          callTool: (server, tool, a) => upstreamManager.callTool(server, tool, a),
          maxCalls: options.maxCalls,
          // M1: profile-specific output budget; explicit config still wins.
          maxResultChars: resolveExecuteOutputBudget(profile, options),
          servicesInfo: getServices,
          fetch: options.fetch,
          env: options.env,
          // B14 typed-plan host helper: read-only is a host-enforced boundary and
          // the io/ops adapters are injectable for offline tests / future wiring.
          typedPlanReadOnly: readOnly,
          typedPlanIO: options.typedPlanIO,
          typedPlanOps: options.typedPlanOps,
        });
        // MakeOutput() attaches a toJSON() that emits the full audit payload;
        // unwrap it first so the projection below is what server.js serializes.
        const wire = typeof full.toJSON === 'function' ? full.toJSON() : full;
        captureEvent('sandbox', {
          tool: readOnly ? 'execute_read' : 'execute',
          code,
          output: wire,
        });
        return toModelOutput(wire, profile); // toolCalls + logs never enter model context
      },
    };
  };

  // Two execute tools: read-only (no approval friction) and full (read+write).
  return [searchTool, makeExecute('execute_read', true), makeExecute('execute', false)];
}
