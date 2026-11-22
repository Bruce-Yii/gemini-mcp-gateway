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
import { normalizeCode, sanitizeToolName } from './codemode-util.js';
import { normalizeToolArguments } from './sanitize.js';
import { searchEntries } from './catalog.js';
import {
  unwrapResult,
  formatToolSummary,
  formatToolDetail,
  truncateResultValue,
  truncateResponseText,
} from './tool-format.js';

const DEFAULT_MAX_CALLS = 50; // max upstream tool calls per execute() (was 30)
const DEFAULT_MAX_RESULT_CHARS = 20000; // cap the execute() return value
const EXEC_TIMEOUT_MS = 30000;
const ARG_FIELD_MAX = 200; // cap each arg field in the audit trail (prevents context leak)
const DEFAULT_MAX_LOG_CHARS = 4000; // cap serialized console logs so a chatty script cannot flood context

// RC-D7: brief boundary/refusal guidance appended to BOTH execute tool
// descriptions, so the model knows what to do when it cannot/should not comply
// instead of forcing a tool call. Kept as one shared constant to avoid drift.
const EXEC_BOUNDARY_GUIDANCE = " Boundary: if the task exceeds the available tools' capabilities, requires an external service, or information is insufficient, explicitly state it cannot be done and explain why — do not force tool calls; refuse harmful requests.";

// Gemini feedback #3: upstreams do not share one result shape. One short line
// nudges the model to defend before field access instead of crashing mid-script.
const RETURN_SHAPE_GUIDANCE = ' Results differ by service: Notion/Linear mostly return objects, GitHub often JSON text or arrays, Vercel mostly objects — guard with Array.isArray(x) / typeof x === "string" before reading fields; safeAll(tasks) keeps a batch alive when one sub-task fails; grepSnippet(text, keyword, window) extracts context slices from long results; codemode.unwrap(x) normalizes JSON text, {result}, {text,resources} and content arrays; fileResult(x)/prResult(x) flatten common file/PR shapes. Intl is unavailable in the sandbox: use codemode.formatDate(value, {date:true,time:true,ms:true}) or Date UTC getters. For large files, fetch inside the sandbox and return codemode.sliceLines(text, start, end) instead of the full text. Edit with codemode.replaceLines/applyPatch; call diffSummary before writing.';

// Gemini feedback #2: tell the model which identifier is actually callable.
const CALLNAME_GUIDANCE = ' Each result carries "callName": pass that exact identifier to codemode (the "name" field may contain hyphens — do not copy it literally into codemode["..."]).';

// 2026-11-22 residual feedback: tool calls used to resolve synchronously at the
// bridge, so `.then()/.catch()` were "not a function". They are native Promises
// now; spell out which helpers stay synchronous so models neither await a plain
// object nor chain on one.
const ASYNC_GUIDANCE = ' Tool calls return Promises (await / .then / .catch work); codemode.search, listTools, remainingCalls and services are synchronous helpers.';

// Gemini new feedback #3: a read-only, in-sandbox service status helper. Kept
// out of the MCP tool schemas on purpose — changing those requires the client
// to reconnect, whereas a sandbox helper is available immediately.
//
// Honesty fix: the old wording ("check connected-service online status") made a
// cold-start snapshot look like a live health check. The guidance now says
// explicitly that services() is point-in-time evidence, that credentials can
// expire at any moment, and what to do when the provider rejects a token.
const SERVICES_GUIDANCE = ' Use codemode.services() for a cold-start snapshot of locally known services (name/toolCount/status/verifiedAt/note); it reads local state only and makes no network call. status is point-in-time evidence ("observed" = mounted with no recorded failure, "offline" = connection failed at cold start), NOT a live health check — credentials can expire at any moment and the legacy `online` flag only means "mounted at cold start". If a tool call returns invalid_token/unauthorized, the upstream needs re-auth; treat that service as stale until it is reconnected.';

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
  'const __dshCal = (() => { const m = /run\\.js:(\\d+)/.exec(String(new Error().stack || "")); return m ? Number(m[1]) : 1; })();',
  'const __dshHide = (f) => { try { Object.defineProperty(f, "constructor", { value: undefined, configurable: true }); } catch (_) {} return f; };',
  'const __dshInvoke = (name, args) => { const r = __bridge.invoke(name, args); if (r && r.__hostError) { const e = new Error(r.message); e.name = r.type; e.__dshHostOrigin = true; throw e; } return r.value; };',
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
  // Gemini feedback #4: extract context windows around a keyword from a long
  // text — avoids hand-writing slice/indexOf loops after results get truncated.
  // Accepts string or any object (JSON-stringified). Returns an array of
  // {index, text} snippets; case-insensitive; capped at 10 snippets.
  'const __dshGrepSnippet = (input, keyword, window) => { const s = typeof input === "string" ? input : JSON.stringify(input); if (!s || !keyword) return []; const w = Math.max(20, Math.min(Number(window) || 300, 4000)); const needle = String(keyword).toLowerCase(); const hay = s.toLowerCase(); const out = []; let from = 0; while (out.length < 10) { const i = hay.indexOf(needle, from); if (i < 0) break; const start = Math.max(0, i - Math.floor(w / 2)); out.push({ index: i, text: s.slice(start, Math.min(s.length, start + w)) }); from = i + needle.length; } return out; };',
  'const grepSnippet = __dshHide(__dshGrepSnippet); codemode.grepSnippet = grepSnippet;',
  // Inconsistent upstream result shapes: normalize defensively without ever
  // throwing. Ambiguous payloads are returned untouched so the model can still
  // inspect the original envelope (mirrors tool-format.js's unwrapResult
  // conventions: structuredContent wins when sole, text beats duplicate
  // resource bodies, mixed/non-text blocks stay un-collapsed).
  'const __dshUnwrap = (value) => { try { if (typeof value === "string") { try { return JSON.parse(value); } catch (_) { return value; } } if (value === null || typeof value !== "object" || Array.isArray(value)) return value; const own = (k) => Object.prototype.hasOwnProperty.call(value, k); const hasText = own("text") && typeof value.text === "string"; const hasContent = own("content") && Array.isArray(value.content); const hasResult = own("result"); const hasSC = own("structuredContent") && value.structuredContent !== undefined; if (hasSC && !hasText && !hasContent && !hasResult) return value.structuredContent; if (hasResult && !hasSC && !hasText && !hasContent) return value.result; if (hasText && own("resources") && Array.isArray(value.resources)) return value.text; if (hasContent) { const candidates = []; for (const c of value.content) { if (!c || typeof c !== "object") return value; let body; if (c.type === "text" || c.type === undefined) { if (typeof c.text !== "string") return value; body = c.text; } else if (c.type === "resource") { const res = c.resource; if (!res || typeof res !== "object" || typeof res.text !== "string") return value; body = res.text; } else { return value; } if (candidates.indexOf(body) < 0) candidates.push(body); } if (candidates.length !== 1) return value; const s = candidates[0]; try { return JSON.parse(s); } catch (_) { return s; } } return value; } catch (_) { return value; } };',
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
  // Common capability shapes: upstreams disagree on file/PR field names. These
  // helpers are best-effort flat views; they never throw and return `null` for
  // fields they cannot find (callers can still inspect the original value).
  'const __dshFileResult = (value) => { const pick = (o, keys) => { if (!o || typeof o !== "object") return undefined; for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k]; return undefined; }; let v; try { v = __dshUnwrap(value); } catch (_) { v = value; } if (typeof v === "string") return { content: v, size: v.length, sha: null, path: null, encoding: null, truncated: /--- TRUNCATED ---/.test(v) }; const root = v && typeof v === "object" ? v : {}; const nested = root.result && typeof root.result === "object" ? root.result : root; let content = pick(nested, ["content", "text", "data"]); if (typeof content !== "string") { const resources = Array.isArray(nested.resources) ? nested.resources : []; const fromResources = resources.map((r) => r && typeof r.text === "string" ? r.text : "").filter(Boolean).join("\\n"); if (fromResources) content = fromResources; } const sha = pick(nested, ["sha", "sha256", "content_sha", "commit_sha"]); const path = pick(nested, ["path", "name", "uri"]); const encoding = pick(nested, ["encoding"]); const rawSize = pick(nested, ["size", "bytes"]); return { content: typeof content === "string" ? content : null, sha: sha ?? null, size: Number(rawSize ?? (typeof content === "string" ? content.length : 0)) || 0, path: path ?? null, encoding: encoding ?? null, truncated: Boolean(nested.truncated) || /--- TRUNCATED ---/.test(String(content ?? "")) }; };',
  'const fileResult = __dshHide((v) => { try { return __dshFileResult(v); } catch (_) { return { content: null, sha: null, size: 0, path: null, encoding: null, truncated: false }; } }); codemode.fileResult = fileResult;',
  'const __dshPrResult = (value) => { const pick = (o, keys) => { if (!o || typeof o !== "object") return undefined; for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k]; return undefined; }; let v; try { v = __dshUnwrap(value); } catch (_) { v = value; } const root = v && typeof v === "object" ? v : {}; const nested = root.result && typeof root.result === "object" ? root.result : root; const url = pick(nested, ["html_url", "url", "web_url"]); const numberRaw = pick(nested, ["number", "prNumber", "pr_number", "id"]); const number = numberRaw !== undefined && Number.isFinite(Number(numberRaw)) ? Number(numberRaw) : (() => { const m = /\\/pull\\/(\\d+)/.exec(String(url ?? "")); return m ? Number(m[1]) : null; })(); const sha = pick(nested, ["sha", "head_sha", "headSha"]); return { number: number, url: url ?? null, sha: sha ?? null, id: pick(nested, ["id", "node_id"]) ?? null }; };',
  'const prResult = __dshHide((v) => { try { return __dshPrResult(v); } catch (_) { return { number: null, url: null, sha: null, id: null }; } }); codemode.prResult = prResult;',
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
export function toModelOutput(output) {
  if (output === null || typeof output !== 'object' || Array.isArray(output)) {
    return { result: toJsonSafe(output) };
  }
  // The original `toJSON()` hook must be dropped too: leaving it on the object
  // would re-invoke makeOutput()'s serializer during server.js's JSON.stringify
  // and resurrect logs/toolCalls on the wire. Spreading rather than whitelisting
  // keeps fields added by other fixes (status/error) intact.
  const { toolCalls, calls, logs, toJSON, ...rest } = output;
  void toolCalls; void calls; void logs; void toJSON;
  return toJsonSafe(rest); // cycles / BigInt → {error}, never throws
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
  // Keep the legacy message prefix byte-for-byte for existing callers/tests;
  // append the caught script location only when a vm stack provided one.
  const rawMessage = err instanceof Error ? err.message : String(err);
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

/**
 * Run normalized model code in a hardened QuickJS sandbox (Vercel `run` SDK).
 * The `codemode` global is assembled by the guest prelude from a single host
 * bridge; all counting/validation/audit stays on the host side.
 * @returns { result, logs, toolCalls } with the unchanged legacy output shape.
 */
export function runInSandbox({ code, tools, callTool, maxCalls = DEFAULT_MAX_CALLS, maxResultChars = DEFAULT_MAX_RESULT_CHARS, timeout = EXEC_TIMEOUT_MS, totalTimeout, unavailableTools = [], servicesInfo = { services: [] } }) {
  const normalized = normalizeCode(code);
  const logs = [];
  const toolCalls = [];
  // In-process dedup cache, scoped to THIS execute() run. Identical read-only
  // calls (same tool + same args) reuse the first result and do not consume
  // another call from the budget.
  const cache = new Map();
  let calls = 0;

  // Map sanitized JS identifier -> original tool descriptor.
  const byIdent = new Map();
  for (const t of tools) byIdent.set(sanitizeToolName(t.name), t);

  const hostErrorMessage = (err) => (err instanceof Error || (err && typeof err.message === 'string'))
    ? String(err.message) : String(err);
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
      return opts.brief ? entries.map(({ name, service }) => ({ name, service })) : entries;
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
    remainingCalls: () => Math.max(0, maxCalls - calls),
    // Gemini new feedback #3: the snapshot is computed on the host from local
    // upstream state only; a getter (when provided) keeps it fresh even if the
    // manager was populated after createCodeModeTools() ran.
    services: () => (typeof servicesInfo === 'function' ? servicesInfo() : servicesInfo),
    stub: (name) => {
      throw new Error(`${name} is a write tool and unavailable in execute_read; use execute() instead`);
    },
    tool: async (ident, args) => {
      const tool = byIdent.get(ident);
      if (!tool) throw new Error(`unknown tool: ${ident}`);
      // Pre-flight before any budget/audit/dedup bookkeeping or upstream call:
      // cheap, actionable errors beat an upstream 400 + another model round.
      validateToolArgs(tool, args);
      const dedupeKey = isReadOnlyTool(tool)
        ? `${tool.server ?? ''}::${tool.tool ?? ''}::${stableKey(args ?? {})}`
        : null;
      if (dedupeKey !== null && cache.has(dedupeKey)) return cache.get(dedupeKey);

      calls += 1;
      if (calls > maxCalls) throw new Error(`tool call limit (${maxCalls}) exceeded`);
      toolCalls.push({ name: tool.name, args: summarizeArgs(args) });
      const raw = await callTool(tool.server, tool.tool, args ?? {});
      // Throw on upstream errors and auto-parse JSON results so model scripts
      // can use the return value directly without JSON.parse(content[0].text).
      const value = unwrapResult(raw);
      if (dedupeKey !== null) cache.set(dedupeKey, value);
      return value;
    },
  };

  const invoke = (name, args) => {
    try {
      const fn = registry[name];
      if (!fn) throw new Error(`unknown bridge function: ${name}`);
      return Promise.resolve()
        .then(() => fn(...(Array.isArray(args) ? args : [])))
        .then(
          (value) => ({ value }),
          (err) => ({ __hostError: 1, message: hostErrorMessage(err), type: hostErrorType(err) }),
        );
    } catch (err) {
      return { __hostError: 1, message: hostErrorMessage(err), type: hostErrorType(err) };
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
    if (!byIdent.has(ident)) {
      const expr = `__dshInvoke("stub", [${JSON.stringify(tool.name)}])`;
      bind(ident, expr);
      if (tool.name !== ident) bind(tool.name, expr);
    }
  }
  for (const [ident, tool] of byIdent) {
    const expr = `__dshInvoke("tool", [${JSON.stringify(ident)}, args])`;
    bind(ident, expr, true);
    if (tool.name !== ident) bind(tool.name, expr, true);
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
    `const __dshUserFn = (${normalized});`,
    'let __dshUserStart = 0;',
    'const __dshFn = async () => {',
    '  __dshUserStart = (() => { const m = /run\\.js:(\\d+)/.exec(String(new Error().stack || "")); return m ? Number(m[1]) : 0; })();',
    '  return await __dshUserFn();',
    '};',
    'return Promise.resolve().then(() => __dshFn()).then(',
    '  (v) => ({ __ok: true, v: v, cal: __dshCal, codeStart: __dshUserStart }),',
    '  (e) => ({ __ok: false, cal: __dshCal, codeStart: __dshUserStart, err: { message: e != null && e.message !== undefined ? String(e.message) : String(e), type: (e instanceof Error) ? String(e.name || "Error") : "UnknownError", hostOrigin: !!(e && e.__dshHostOrigin), stack: e && e.stack ? String(e.stack) : "" } })',
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
    syncHostFunctions: { __bridge: { invoke } },
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
      if (!e.hostOrigin && typeof e.stack === 'string') {
        scriptLoc = pickScriptLoc(e.stack, Number(env.codeStart), normalized.split('\n').length);
      }
      const err = new Error(String(e.message ?? ''));
      err.name = String(e.type || 'Error');
      throw Object.assign(err, { __dshScriptLoc: scriptLoc });
    }
    return env.v;
  }).then((sandboxReturn) => {
    // Model-facing value: structured truncation keeps the result valid JSON
    // of the same shape, with `--- TRUNCATED ---` markers at the cut points.
    const structuredResult = truncateResultValue(sandboxReturn, { maxChars: maxResultChars });
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
  const out = {
    ...hit,
    callName: sanitizeToolName(entry.name),
    access: isReadOnlyTool(entry) ? 'read' : 'write',
  };
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

/**
 * Build the two Code Mode MCP tools bound to an UpstreamManager.
 */
export function createCodeModeTools(upstreamManager, options = {}) {
  const tools = upstreamManager.getEntries?.() ?? [];
  const sanitized = tools.map((t) => ({ ...t, ident: sanitizeToolName(t.name) }));
  const servicesSuffix = connectedServicesSuffix(tools);
  // Gemini new feedback #3: pass a getter (not a frozen copy) so codemode.services()
  // reflects local state at call time; it reads no network.
  const getServices = () => servicesSnapshot(upstreamManager);

  const searchTool = {
    name: 'search',
    description: 'Search upstream tools. Two modes: (1) Plain keywords -> a ranked list of matching tools with compact param signatures (name!: required). (2) To see one tool\'s full inputSchema, pass EXACTLY "select:<name>" where <name> is a tool name copied from a search result (e.g. "select:github__issue_write"). Do NOT put task descriptions or phrases after "select:" — only an exact tool name works; for anything else use plain keyword search. Prefix a service name (e.g. "vercel ...") to focus on that service.' + CALLNAME_GUIDANCE + servicesSuffix,
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Keywords describing the capability you need' }, limit: { type: 'integer', minimum: 1, maximum: 10 } },
      required: ['query'],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
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

  const makeExecute = (name, readOnly) => ({
    name,
    description: (readOnly
      ? 'Write JavaScript to call READ-ONLY upstream tools (get/list/search/query) via codemode.<tool>(args). This tool is annotated read-only so the client may prompt less; it runs the same sandbox as execute(). Only your return value enters the conversation. Example: async () => { const r = await codemode.github__search_repositories({query:"x"}); return r.total_count; }'
      : 'Write JavaScript to call upstream tools via codemode.<tool>(args). Only your returned value enters the conversation — process large results inside code and return a summary. Available: codemode.listTools(), codemode.search(q), codemode.remainingCalls(), codemode.services(), safeAll(tasks), global search(), TextEncoder/atob/URL/crypto, and one method per upstream tool. Example: async () => { const r = await codemode.github__search_repositories({query:"x"}); return r.total_count; }') + RETURN_SHAPE_GUIDANCE + SERVICES_GUIDANCE + ASYNC_GUIDANCE + servicesSuffix + EXEC_BOUNDARY_GUIDANCE,
    inputSchema: {
      type: 'object',
      properties: { code: { type: 'string', description: 'An async arrow function that calls codemode tools and returns a result.' } },
      required: ['code'],
    },
    annotations: readOnly
      ? { readOnlyHint: true, destructiveHint: false, openWorldHint: true }
      : { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
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
        maxResultChars: options.maxResultChars,
        servicesInfo: getServices,
      });
      // MakeOutput() attaches a toJSON() that emits the full audit payload;
      // unwrap it first so the projection below is what server.js serializes.
      const wire = typeof full.toJSON === 'function' ? full.toJSON() : full;
      return toModelOutput(wire); // toolCalls + logs never enter model context
    },
  });

  // Two execute tools: read-only (no approval friction) and full (read+write).
  return [searchTool, makeExecute('execute_read', true), makeExecute('execute', false)];
}
