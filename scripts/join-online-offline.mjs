/**
 * TEMP, read-only join helper for online-vs-offline analysis.
 * Reads R2 capture envelopes for the 2026-11-22T20:58Z+ window and emits a
 * redacted JSON summary to stdout. Never writes to R2, src/, or any repo file
 * other than stdout. Credentials come from environment variables only.
 *
 * Usage (env R2_ACCOUNT_ID / R2_BUCKET / R2_AUTH_EMAIL / R2_AUTH_KEY set):
 *   node scripts/tmp-join-online-offline.mjs > work/join-summary.json
 */
import { listR2Keys, readR2Envelope, classifyError, isTruncated } from './capture-digest.mjs';

const SINCE = Date.parse('2026-11-22T20:58:00.000Z');
const REDACT = /(ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|sk-[A-Za-z0-9]|Bearer\s+[A-Za-z0-9._-]{8}|cfk_[A-Za-z0-9]{8}|cfut_|cfat_|x-auth-key["']?\s*[:=]\s*["']?[A-Za-z0-9_-]{8}|authorization["']?\s*[:=]\s*["']?[A-Za-z0-9 ._-]{8})/gi;

function redact(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) return '';
  return text.replace(REDACT, (m) => `${m.slice(0, 6)}…[REDACTED]`).slice(0, 4000);
}

function tsOf(env) {
  const raw = env?.ts ?? env?.timestamp ?? env?.request?.ts ?? '';
  const t = Date.parse(raw);
  return { raw, iso: Number.isFinite(t) ? new Date(t).toISOString() : null };
}

function methodPath(env) {
  let url = String(env?.request?.url ?? '/');
  try { url = new URL(url, 'http://localhost').pathname; } catch { /* keep */ }
  return `${String(env?.request?.method ?? 'POST').toUpperCase()} ${url}`;
}

function mcpInfo(env) {
  try {
    const json = JSON.parse(String(env?.request?.raw ?? ''));
    return { method: json?.method ?? null, paramsName: json?.params?.name ?? null,
      paramsKeys: json?.params ? Object.keys(json.params) : [], id: json?.id ?? null };
  } catch { return { method: null, paramsName: null, paramsKeys: [], id: null }; }
}

function eventKinds(env) {
  const counts = {};
  for (const e of env.events ?? []) {
    const k = `${e?.type ?? 'unknown'}${e?.payload?.server ? ':' + e.payload.server : ''}`;
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return counts;
}

const keys = [];
for (const day of ['2026-11-22', '2026-11-23']) keys.push(...await listR2Keys(`capture/${day}/`));

const requests = [];
const loadErrors = [];
await Promise.all(keys.map(async (key) => {
  try {
    const env = await readR2Envelope(key);
    const ts = tsOf(env);
    const m = mcpInfo(env);
    const requestId = String(env?.requestId ?? env?.request?.id ?? env?.id ?? key.split('/').at(-1).replace(/\.json\.gz$/, ''));
    requests.push({
      key, requestId,
      ...ts,
      route: methodPath(env),
      status: Number(env?.response?.status ?? 0),
      durationMs: Number(env?.response?.durationMs ?? 0),
      bytes: Number(env?.response?.bytes ?? 0),
      mcpMethod: m.method, mcpTool: m.paramsName, mcpParamsKeys: m.paramsKeys, mcpId: m.id,
      errorClass: Number(env?.response?.status ?? 0) >= 400 || /isError":true|execute error/i.test(String(env?.response?.raw ?? '')) ? classifyError(env) : null,
      truncated: isTruncated(env), overflow: env?.response?.overflow === true,
      events: eventKinds(env),
      rawReqSnippet: redact(env?.request?.raw ?? '').slice(0, 600),
      rawRespSnippet: redact(env?.response?.raw ?? env?.response?.error ?? '').slice(0, 600),
    });
  } catch (e) { loadErrors.push({ key, error: String(e?.message ?? e) }); }
}));

requests.sort((a, b) => (a.iso ?? a.raw).localeCompare(b.iso ?? b.raw));
const inWindow = requests.filter((r) => r.iso && Date.parse(r.iso) >= SINCE);

// Search every raw envelope for PR/branch/issue-workflow keywords and tool names.
const SIGNALS = ['pull_request', 'create_pull_request', 'create_branch', 'create_ref', 'create_commit', 'create_or_update_file', 'push_files', 'merge_pull_request', 'create_issue', 'update_issue', 'create_issue_comment', 'list_issues', 'get_pull_request', 'gh pr', 'git push', '#41', '#42', '#43', '#44', '#45', '#46', '#47', '#48', 'rebase', 'conflict', 'issue', 'patch', 'diff', 'sha', 'line'];
const keywordHits = requests.map((r) => {
  const blob = `${r.rawReqSnippet} ${r.rawRespSnippet} ${JSON.stringify(r.events)}`.toLowerCase();
  return { requestId: r.requestId, iso: r.iso, hits: SIGNALS.filter((s) => blob.includes(s.toLowerCase())) };
}).filter((x) => x.hits.length);

console.log(JSON.stringify({
  totalKeys: keys.length, loadErrors,
  totalRequests: requests.length,
  windowSince: new Date(SINCE).toISOString(),
  inWindowCount: inWindow.length,
  allRequests: requests,
  inWindow: inWindow.map((r) => r.requestId),
  keywordHits,
}, null, 2));
