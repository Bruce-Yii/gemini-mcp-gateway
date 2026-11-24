/**
 * Daily capture digest: aggregate raw envelopes from R2 (or a local dir) into a
 * small, sanitized scorecard. Raw payloads stay in R2; the digest contains only
 * counts, timings, sizes, tool names and truncated error messages.
 *
 * Usage:
 *   node scripts/capture-digest.mjs --date 2026-11-22
 *   node scripts/capture-digest.mjs --dir work/capture
 *   node scripts/capture-digest.mjs --since 2026-11-16 --days 7 --out work/weekly
 *
 * R2 env: R2_ACCOUNT_ID, R2_BUCKET, R2_AUTH_EMAIL + R2_AUTH_KEY, or R2_API_TOKEN.
 *
 * Compatibility: every field previously emitted in the scorecard / metrics
 * object is preserved. New fields are additive only.
 *
 * Batch 13 (platform eval): capture stamps three additive top-level scalar
 * fields on each envelope (see src/capture.js):
 *   - clientPlatform: 'gemini' | 'chatgpt' | 'claude' | 'unknown'
 *   - clientProfile:  'gemini-text-json' | 'chatgpt-structured' | 'claude-text' | 'unknown'
 *   - oauthClientId:  opaque OAuth client id, or null when none was used.
 * Only an explicit, recognized value is trusted; anything missing, null,
 * non-string or unrecognized is `unknown` (we NEVER guess a platform from a
 * User-Agent, client name or tool name here). This keeps per-platform metrics
 * from being cross-contaminated while old envelopes (no fields) stay in the
 * single `unknown` bucket instead of being silently attributed to Gemini.
 */
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createRequire } from 'node:module';

/* ------------------------------------------------------------------ *
 * Project tags (batch 11, project rollup)
 *
 * `src/capture.js` stamps two additive fields on every envelope:
 *   - `projects`:     Array<{server, owner, repo, key, confidence, source}>
 *   - `primaryProject`: the same shape, or null when no repo could be tagged.
 * These are DERIVED labels computed by a deterministic extractor at capture
 * time (`src/project-tag.js`). They are never a client-provided fact and must
 * not be treated as a verified repository identity.
 *
 * Old envelopes (no fields) are backfilled here by calling the SAME extractor
 * on `{ __gatewayRawBody: envelope.request.raw }`. We load it lazily with
 * createRequire so this script still works while the capture-side file is
 * being landed concurrently; a tiny deterministic fallback keeps the rollup
 * honest if the module is genuinely unavailable. No model is ever consulted.
 * ------------------------------------------------------------------ */
const requireModule = createRequire(import.meta.url);
let extractProjectsImpl = null;
let extractProjectsResolved = false;

/** Resolve the canonical deterministic extractor from src/project-tag.js. */
function canonicalExtractor() {
  if (extractProjectsResolved) return extractProjectsImpl;
  extractProjectsResolved = true;
  try {
    const mod = requireModule('../src/project-tag.js');
    if (typeof mod?.extractProjects === 'function') extractProjectsImpl = mod.extractProjects;
  } catch {
    // Not landed yet (concurrent work) — use the embedded fallback below.
  }
  return extractProjectsImpl;
}

/**
 * Deterministic fallback, mirroring the documented rules of
 * src/project-tag.js: only explicit owner+repo pairs (adjacent in args or in
 * one code literal) and PR/branch URLs count. Natural-language repo names do
 * NOT. Used only when the canonical module is unavailable.
 */
function fallbackExtractProjects(rawBody) {
  let body = rawBody;
  if (body && typeof body === 'object' && !Array.isArray(body)) body = body.__gatewayRawBody ?? body.request?.raw ?? null;
  let text = typeof body === 'string' ? body : '';
  try { if (!text) text = JSON.stringify(body ?? ''); } catch { /* ignore */ }
  if (!text) return { projects: [], primaryProject: null };

  const seen = new Map();
  const add = (server, owner, repo, source, confidence) => {
    if (!owner || !repo || !/^[A-Za-z0-9._-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(repo)) return;
    const key = `${server ?? 'github'}:${owner}/${repo}`;
    if (!seen.has(key)) {
      seen.set(key, { server: server ?? 'github', owner, repo, key, confidence, source, _count: 1 });
    } else {
      seen.get(key)._count += 1;
    }
  };
  // Explicit JSON-RPC tool arguments: owner + repo keys in the same object.
  try {
    const json = JSON.parse(text);
    const args = json?.params?.arguments ?? json?.params?.args ?? null;
    if (args && typeof args === 'object') {
      const server = serverFromTool(String(json?.params?.name ?? ''));
      if (typeof args.owner === 'string' && typeof args.repo === 'string') {
        add(server, args.owner, args.repo, 'tool-args', 'high');
      } else if (typeof args.repo === 'string') {
        const m = args.repo.match(/^([\w.-]+)\/([\w.-]+)$/);
        if (m) add(server, m[1], m[2], 'tool-args', 'high');
      }
      // code / script strings: owner:'x' and repo:'y' must be in one literal.
      for (const value of Object.values(args)) {
        if (typeof value !== 'string' || value.length > 20000) continue;
        extractFromCode(value, server, add);
      }
    }
  } catch { /* not JSON: still scan as text for URLs */ }
  // PR / tree / blob URLs carry an unambiguous owner/repo pair.
  const urlRe = /https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)(?:[\/#?]|$)/g;
  let match;
  while ((match = urlRe.exec(text)) !== null) add('github', match[1], match[2], 'pr-url', 'medium');

  const projects = [...seen.values()].map(({ _count, ...rest }) => rest);
  const primary = projects.length
    ? [...projects].sort((a, b) => b._count - a._count)[0]
    : null;
  return { projects, primaryProject: primary ? { ...primary } : null };
}

function serverFromTool(name) {
  const idx = String(name).indexOf('__');
  return idx > 0 ? String(name).slice(0, idx) : 'github';
}

function extractFromCode(code, server, add) {
  // Only adjacent-ish explicit pairs inside one code literal. No NLP.
  const ownerRe = /\bowner\s*[:=]\s*['"]([\w.-]+)['"]/g;
  const repoRe = /\brepo(?:sitory)?\s*[:=]\s*['"]([\w.-]+)['"]/g;
  const owners = [...code.matchAll(ownerRe)].map((m) => m[1]);
  const repos = [...code.matchAll(repoRe)].map((m) => m[1]);
  if (owners.length && repos.length) add(server, owners[0], repos[0], 'code-literal', 'medium');
}

/**
 * Project tags for one envelope. Prefers envelope fields when present,
 * otherwise deterministically backfills from request.raw via the canonical
 * extractor (no model, no heuristics on prose).
 */
export function projectTagsOf(envelope) {
  const hasProjectsField = Array.isArray(envelope?.projects);
  const explicitProjects = hasProjectsField ? envelope.projects : null;
  const explicitPrimary = envelope?.primaryProject ?? null;

  // When the envelope carries the field at all, trust it — including the
  // explicit-empty case (`projects: []` means "no tag found at capture time").
  if (hasProjectsField) {
    const projects = explicitProjects;
    const primary = explicitPrimary ?? projects[0] ?? null;
    return { projects, primaryProject: primary, source: 'envelope' };
  }

  // Old envelope: deterministically backfill from request.raw.
  const extractor = canonicalExtractor();
  const extracted = extractor
    ? (() => { try { return extractor({ __gatewayRawBody: envelope?.request?.raw ?? null }); } catch { return null; } })()
    : null;
  const result = extracted ?? fallbackExtractProjects(envelope?.request?.raw ?? null);
  const primary = explicitPrimary ?? result.primaryProject ?? result.projects[0] ?? null;
  return {
    projects: result.projects,
    primaryProject: primary && result.projects.some((p) => p?.key === primary?.key) ? primary : (result.projects[0] ?? null),
    source: 'derived',
  };
}

/** Project keys attached to one envelope (deduped, stable order). */
export function projectKeysOf(envelope) {
  const { projects } = projectTagsOf(envelope);
  return [...new Set(projects.map((p) => String(p?.key ?? '')).filter(Boolean))];
}

/** Primary project key of one envelope, or null. */
export function primaryProjectKeyOf(envelope) {
  return projectTagsOf(envelope).primaryProject?.key ?? null;
}

/* ------------------------------------------------------------------ *
 * Client platform attribution (batch 13, platform eval)
 *
 * Capture stamps three additive top-level scalars on every new envelope:
 *   clientPlatform / clientProfile / oauthClientId.
 * This module ONLY reads them. It never infers a platform from a UA string,
 * a tool name, an OAuth client id, or a clientInfo.name — doing so would let
 * one platform's metrics leak into another's bucket. The canonical values are
 * explicit and closed; anything else maps to the single `unknown` bucket.
 * ------------------------------------------------------------------ */

/** Recognized clientPlatform values. Closed set — no fuzzy matching. */
export const CLIENT_PLATFORMS = Object.freeze(['gemini', 'chatgpt', 'claude']);
/** Canonical unknown bucket (老的 envelope 没有字段 → unknown，不猜测). */
export const UNKNOWN_PLATFORM = 'unknown';

/**
 * Read the explicit clientPlatform from an envelope.
 * Returns one of CLIENT_PLATFORMS, or 'unknown' when absent / null /
 * non-string / unrecognized. Old envelopes without the field are 'unknown'.
 */
export function clientPlatformOf(envelope) {
  const value = envelope?.clientPlatform;
  if (typeof value !== 'string') return UNKNOWN_PLATFORM;
  const normalized = value.trim().toLowerCase();
  return CLIENT_PLATFORMS.includes(normalized) ? normalized : UNKNOWN_PLATFORM;
}

/**
 * Read the explicit clientProfile label from an envelope. Returns one of the
 * three canonical profile labels or 'unknown'. We do NOT translate a profile
 * back into a platform: that would re-introduce cross-platform inference.
 */
export function clientProfileOf(envelope) {
  const value = envelope?.clientProfile;
  if (typeof value !== 'string') return UNKNOWN_PLATFORM;
  const normalized = value.trim().toLowerCase();
  const known = ['gemini-text-json', 'chatgpt-structured', 'claude-text'];
  return known.includes(normalized) ? normalized : UNKNOWN_PLATFORM;
}

/** OAuth client id attached to the envelope, or null. Never used for inference. */
export function oauthClientIdOf(envelope) {
  const value = envelope?.oauthClientId;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/* ------------------------------------------------------------------ *
 * Four-dimension ledger (M4-A): clientPlatform × protocolVersion ×
 * clientProfile × buildCommit.
 *
 * Protocol version is NEVER guessed from the client name: it is either an
 * explicit future `protocolVersion` field on the envelope, or derived from the
 * request path (`/mcp/v2` -> v2, `/mcp` -> v1). Everything else is `unknown`,
 * including old envelopes captured before these fields existed.
 * ------------------------------------------------------------------ */

/** Recognized protocol versions. Closed set — no fuzzy matching. */
export const PROTOCOL_VERSIONS = Object.freeze(['v1', 'v2']);
/** Canonical executor per protocol version (v2 is the flag-gated typed-plan). */
export const EXECUTORS = Object.freeze({ v1: 'codemode', v2: 'typed-plan' });
/** Canonical unknown bucket used by every dimension. */
export const UNKNOWN_BUCKET = 'unknown';

/** Pathname of the captured request URL (never throws). */
function requestPathOf(envelope) {
  try {
    return new URL(String(envelope?.request?.url ?? '/'), 'http://localhost').pathname;
  } catch {
    return '';
  }
}

/**
 * Read the protocol version of an envelope: explicit `protocolVersion` first
 * (future capture stamping), otherwise the request path. Unknown stays unknown.
 */
export function protocolVersionOf(envelope) {
  const explicit = envelope?.protocolVersion;
  if (typeof explicit === 'string') {
    const normalized = explicit.trim().toLowerCase();
    if (PROTOCOL_VERSIONS.includes(normalized)) return normalized;
  }
  const path = requestPathOf(envelope);
  if (path === '/mcp/v2') return 'v2';
  if (path === '/mcp') return 'v1';
  return UNKNOWN_BUCKET;
}

/** Executor label for the envelope's protocol version (unknown when unknown). */
export function executorOf(envelope) {
  return EXECUTORS[protocolVersionOf(envelope)] ?? UNKNOWN_BUCKET;
}

/** Build commit from `deployment.commit`; missing/empty -> unknown. */
export function buildCommitOf(envelope) {
  const commit = envelope?.deployment?.commit;
  return typeof commit === 'string' && commit.trim() ? commit.trim() : UNKNOWN_BUCKET;
}

/**
 * Explicit `servers[]` of one envelope (cross-upstream tags). Missing / empty /
 * non-array -> `['unknown']`. We NEVER infer servers here: per-upstream stats
 * have their own event-based derivation; this field is the explicit capture tag.
 */
export function serversOf(envelope) {
  const raw = envelope?.servers;
  if (!Array.isArray(raw)) return [UNKNOWN_BUCKET];
  const list = [...new Set(raw.filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim()))];
  return list.length ? list : [UNKNOWN_BUCKET];
}

/** Evaluation mode label (`active` / `passive`), otherwise unknown. */
export function evalModeOf(envelope) {
  const value = envelope?.evalMode;
  return value === 'active' || value === 'passive' ? value : UNKNOWN_BUCKET;
}

/** Stable key of the four-dimension bucket, in fixed dimension order. */
export function fourDimensionKeyOf(envelope) {
  return [
    clientPlatformOf(envelope),
    protocolVersionOf(envelope),
    clientProfileOf(envelope),
    buildCommitOf(envelope),
  ].join('|');
}

function env(name) {
  return process.env[name] ?? '';
}

function r2AuthHeaders() {
  if (env('R2_API_TOKEN')) return { authorization: `Bearer ${env('R2_API_TOKEN')}` };
  return {
    'x-auth-email': env('R2_AUTH_EMAIL'),
    'x-auth-key': env('R2_AUTH_KEY'),
  };
}

function r2Endpoint(key = '') {
  const encoded = key.split('/').map(encodeURIComponent).join('/');
  const base = `https://api.cloudflare.com/client/v4/accounts/${env('R2_ACCOUNT_ID')}/r2/buckets/${env('R2_BUCKET')}`;
  return key ? `${base}/objects/${encoded}` : `${base}/objects`;
}

/** Cloudflare R2 list default page size is 20 (UUID-ordered), so one unpaged
 *  request silently hides most of a day's captures. Always ask for the max. */
const R2_LIST_PER_PAGE = 1000;
const R2_LIST_MAX_PAGES = 50;

/**
 * List every `.json.gz` key under `prefix`, following `result_info.cursor`.
 *
 * The R2 list API pages (default 20, maximum `per_page=1000`) and returns a
 * `result_info.cursor` while more pages remain. A single request therefore used
 * to drop most capture logs silently; this walker keeps all pages, de-dupes
 * keys and filters to `.json.gz`.
 *
 * `options.fetchImpl` overrides `fetch` (tests inject a fake; never hits R2).
 * `options.maxPages` caps the walk (default 50). If the cap is hit while a
 * cursor is still present, a one-line warning is logged and the returned array
 * carries `truncated=true` + `pages` so the loss is explicit, never silent.
 * Non-2xx responses and unparseable JSON throw, exactly like the previous
 * single-request implementation.
 */
const R2_RETRY_STATUSES = new Set([429, 502, 503, 504]);
const R2_MAX_WAIT_MS = 120000;

function retryDelayMs(response, attempt) {
  const retryAfter = Number(response?.headers?.get?.('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter >= 0) return Math.min(15000, retryAfter * 1000);
  // Cloudflare Ratelimit: `"default";r=50;t=30` (t = seconds until reset).
  const ratelimit = response?.headers?.get?.('ratelimit') ?? response?.headers?.get?.('ratelimit-policy') ?? '';
  const reset = /(?:^|[;,\s])t=(\d+)/.exec(String(ratelimit));
  if (reset) return Math.min(15000, Number(reset[1]) * 1000);
  return Math.min(15000, 1000 * (2 ** attempt));
}

/**
 * R2 HTTP with bounded retries for transient 429/5xx. Sequential GETs across a
 * 7-day weekly review can trip the R2 API rate limit; a hard failure there made
 * the whole evidence workflow red even after the digest had succeeded.
 *
 * After the retry budget is exhausted we throw `R2_RATE_LIMITED` explicitly:
 * a rate-limited read must never be reported as a successful/empty result.
 */
async function fetchR2(url, options, { fetchImpl = fetch, maxAttempts = 6, maxWaitMs = R2_MAX_WAIT_MS } = {}) {
  let response;
  let waitedMs = 0;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    response = await fetchImpl(url, options);
    if (response.ok || !R2_RETRY_STATUSES.has(response.status) || attempt === maxAttempts - 1) break;
    const delay = retryDelayMs(response, attempt);
    if (waitedMs + delay > maxWaitMs) break;
    waitedMs += delay;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  if (response && R2_RETRY_STATUSES.has(response.status)) {
    const error = new Error(`R2_RATE_LIMITED: HTTP ${response.status} after ${maxAttempts} attempts / ${waitedMs}ms wait`);
    error.code = 'R2_RATE_LIMITED';
    throw error;
  }
  return response;
}

export async function listR2Keys(prefix, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxAttempts = Number(options.maxAttempts) > 0 ? Math.floor(Number(options.maxAttempts)) : 6;
  const requestedPages = Number(options.maxPages);
  const maxPages = Number.isFinite(requestedPages) && requestedPages >= 1
    ? Math.floor(requestedPages)
    : R2_LIST_MAX_PAGES;

  const keys = [];
  const seen = new Set();
  let cursor = '';
  let pages = 0;

  while (pages < maxPages) {
    const params = new URLSearchParams({ prefix, per_page: String(R2_LIST_PER_PAGE) });
    if (cursor) params.set('cursor', cursor);
    const response = await fetchR2(`${r2Endpoint()}?${params.toString()}`, { headers: r2AuthHeaders() }, {
      fetchImpl, maxAttempts, maxWaitMs: options.maxWaitMs,
    });
    if (!response.ok) throw new Error(`R2 list failed: ${response.status}`);
    const body = await response.json();
    pages += 1;

    const rows = Array.isArray(body?.result) ? body.result : [];
    for (const row of rows) {
      const key = row?.key;
      if (typeof key !== 'string' || !key.endsWith('.json.gz') || seen.has(key)) continue;
      seen.add(key);
      keys.push(key);
    }

    const next = body?.result_info?.cursor;
    cursor = typeof next === 'string' ? next : '';
    if (!cursor) break;
  }

  if (cursor) {
    // Prefix only (a capture path); never the auth headers or full URL.
    console.warn(`[digest] R2 list prefix="${prefix}" stopped at maxPages=${maxPages} with a cursor still present: ${keys.length} keys fetched, listing is INCOMPLETE (truncated=true)`);
  }
  keys.pages = pages;
  keys.truncated = Boolean(cursor);
  return keys;
}

export async function readR2Envelope(key, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxAttempts = Number(options.maxAttempts) > 0 ? Math.floor(Number(options.maxAttempts)) : 6;
  const response = await fetchR2(r2Endpoint(key), { headers: r2AuthHeaders() }, {
    fetchImpl, maxAttempts, maxWaitMs: options.maxWaitMs,
  });
  if (!response.ok) throw new Error(`R2 get failed: ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  try {
    return JSON.parse(gunzipSync(buffer).toString('utf8'));
  } catch {
    // Some proxies transparently decode Content-Encoding; accept raw JSON too.
    return JSON.parse(buffer.toString('utf8'));
  }
}

export async function readDirEnvelopes(dir) {
  const files = (await readdir(dir)).filter((name) => name.endsWith('.json') || name.endsWith('.json.gz'));
  const envelopes = [];
  for (const name of files) {
    const buffer = await readFile(join(dir, name));
    envelopes.push(JSON.parse(name.endsWith('.gz') ? gunzipSync(buffer).toString('utf8') : buffer.toString('utf8')));
  }
  return envelopes;
}

export function classifyError(envelope) {
  const status = Number(envelope?.response?.status ?? 0);
  const raw = String(envelope?.response?.raw ?? '');
  if (status === 401 || status === 403 || /invalid_token|unauthorized|forbidden/i.test(raw)) return 'auth';
  if (status === 429 || /rate.?limit|too many requests/i.test(raw)) return 'rate_limit';
  if (/timeout|timed out|RUN_TIMEOUT/i.test(raw)) return 'timeout';
  if (/validation|invalid argument|expected one of|missing required/i.test(raw)) return 'validation';
  if (status >= 500 || /internal error|upstream 5\d\d/i.test(raw)) return 'upstream_5xx';
  if (status >= 400 || /isError":true|execute error/i.test(raw)) return 'upstream_4xx';
  return 'unknown';
}

/** A wire marker is only trusted near the end of the payload (a cut tail). */
const TRUNCATION_TAIL_CHARS = 256;
/** Fixed in-band markers only: `--- TRUNCATED ---` / `…[truncated]` / `…[truncated N]`. */
const TRUNCATION_TAIL_MARKER = /--- TRUNCATED ---|…\s*\[truncated/i;

/**
 * True when a response was truncated, flagged by capture or by an explicit wire
 * marker.
 *
 * Strict on purpose (false-positive fix): plain payload text is never a signal,
 * so a normal JSON body containing `{"truncated": false}` — or even a literal
 * `"truncated": true` string in the payload — is NOT counted. Only three things
 * count:
 *   1. `response.truncated === true` (boolean stamp, not the string "true");
 *   2. a present `response.truncation` object (capture/adapters attach it only
 *      after a real cut; null, arrays and bare strings are not objects);
 *   3. one of the two fixed in-band markers inside the last 256 chars of
 *      `response.raw` (`--- TRUNCATED ---`, `…[truncated...]`).
 * The old broad `truncated:` regex is deleted.
 */
export function isTruncated(envelope) {
  const response = envelope?.response;
  if (response?.truncated === true) return true;
  const truncation = response?.truncation;
  if (truncation !== null && typeof truncation === 'object' && !Array.isArray(truncation)) return true;
  const raw = String(response?.raw ?? '');
  if (!raw) return false;
  const tail = raw.length > TRUNCATION_TAIL_CHARS ? raw.slice(-TRUNCATION_TAIL_CHARS) : raw;
  return TRUNCATION_TAIL_MARKER.test(tail);
}

/**
 * True when the MODEL's visible output was silently truncated (batch 11).
 *
 * This is a DIFFERENT signal from gateway truncation (`isTruncated`) and from
 * capture overflow (`response.overflow`): the gateway wire was complete, but
 * the model only saw a shorter projection. We trust the deterministic boolean
 * stamped by `buildModelOutputAudit()` in capture.js and never re-derive it
 * from prose. Older envelopes without the field are not retro-flagged.
 */
export function isModelTruncationSuspect(envelope) {
  return envelope?.model?.possibleModelTruncation === true;
}

/** Summarize a list of durations; empty list yields all zeroes. */
function timing(durations) {
  const sorted = [...durations].sort((a, b) => a - b);
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))] ?? 0;
  return {
    calls: sorted.length,
    p50Ms: pct(0.5),
    p95Ms: pct(0.95),
    avgMs: sorted.length ? Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length) : 0,
  };
}

function rate(count, total) {
  return total ? Math.round((count / total) * 10000) / 10000 : 0;
}

/** YYYY-MM-DD + HH from envelope.ts, with a deterministic fallback. */
function timeParts(envelope) {
  const raw = envelope?.ts ?? envelope?.timestamp ?? envelope?.request?.ts;
  const date = typeof raw === 'string' && raw.length >= 10 ? raw.slice(0, 10) : 'unknown';
  let hour = 'unknown';
  if (typeof raw === 'string') {
    const match = raw.match(/T(\d{2}):/);
    if (match) hour = match[1];
  }
  if (hour === 'unknown' && Number.isFinite(Date.parse(raw))) {
    hour = String(new Date(raw).getUTCHours()).padStart(2, '0');
  }
  return { date, hour };
}

/** Server name from upstream events, falling back to the `<server>__<tool>` prefix. */
export function upstreamOf(envelope, tool) {
  const event = (envelope.events ?? []).find((item) => item?.type === 'upstream' && item?.payload?.server);
  if (event) return String(event.payload.server);
  const name = String(tool ?? '');
  const idx = name.indexOf('__');
  return idx > 0 ? name.slice(0, idx) : 'unknown';
}

function blankGroup() {
  return { calls: 0, errors: 0, durations: [], errorClasses: {}, truncated: 0, overflow: 0, modelTruncationSuspects: 0 };
}

function finishGroup(group) {
  const { calls, errors, durations, errorClasses, truncated, overflow, modelTruncationSuspects } = group;
  return {
    calls,
    errors,
    errorRate: rate(errors, calls),
    ...timing(durations),
    errorClasses,
    truncated,
    overflow,
    modelTruncationSuspects,
  };
}

function bumpHistogram(hist, key) {
  hist[key] = (hist[key] ?? 0) + 1;
}

/* ------------------------------------------------------------------ *
 * Project-level rollup (batch 11, project rollup)
 *
 * Projects are ORTHOGONAL to sessions: one session can touch many projects,
 * and one project can span many sessions (a handoff). `byProject` therefore
 * aggregates across all sessions; `projectTimelines` keeps the per-project,
 * per-session ordering so the handoff is visible instead of flattened.
 * ------------------------------------------------------------------ */

/** A per-platform row. Every platform starts from an identical zero shape. */
function blankPlatformRow(platform) {
  return {
    platform,
    requests: 0,
    mcpRequests: 0,
    errors: 0,
    toolCalls: 0,
    truncationSuspects: 0,
    sessions: 0,
    projects: 0,
    sessionIds: [],
    projectKeys: [],
  };
}

function addPlatformSample(row, key, id) {
  if (!row[key].includes(id)) row[key].push(id);
}

function blankProjectRow(key) {
  return {
    key,
    requests: 0,
    mcpRequests: 0,
    errors: 0,
    toolCalls: 0,
    truncationSuspects: 0,
    firstTs: null,
    lastTs: null,
    firstTsRaw: null,
    lastTsRaw: null,
    sessionIds: [],
    // Batch 13: which client platforms touched this project. Orthogonal to the
    // project label — a project may span several platforms (and vice versa).
    clientPlatforms: [],
    requestIdSamples: [],
  };
}

function addProjectSample(row, id, max) {
  if (row.requestIdSamples.length < max) row.requestIdSamples.push(id);
}

function addProjectSession(row, id) {
  if (id && !row.sessionIds.includes(id)) row.sessionIds.push(id);
}

/**
 * Aggregate envelopes by project key. Each envelope contributes to EVERY tag
 * it carries (multi-project request), and exactly one primaryProject key is
 * also recorded in `primaryProjectRequests` for attribution clarity.
 *
 * `projectTimelines` groups (projectKey -> sessionId) so the same project
 * across several sessions appears as an ordered handoff timeline.
 */
export function digestProjects(envelopes, { maxRequestIdSamples = 5 } = {}) {
  const byProject = new Map();
  const timelineGroups = new Map();

  for (const envelope of envelopes) {
    const { projects, primaryProject } = projectTagsOf(envelope);
    const keys = [...new Set(projects.map((p) => String(p?.key ?? '')).filter(Boolean))];
    const primaryKey = primaryProject?.key ?? null;
    const ts = requestTimeOf(envelope);
    const rawTs = envelope?.ts ?? envelope?.timestamp ?? envelope?.request?.ts ?? null;
    const session = sessionIdOf(envelope);
    const id = String(envelope?.requestId ?? envelope?.request?.id ?? envelope?.id ?? 'unknown');
    let method = null;
    try {
      const json = JSON.parse(String(envelope?.request?.raw ?? ''));
      method = typeof json?.method === 'string' ? json.method : null;
    } catch { /* not JSON */ }
    const status = Number(envelope?.response?.status ?? 0);
    const raw = String(envelope?.response?.raw ?? '');
    const isError = status >= 400 || /isError":true|execute error/i.test(raw);
    const suspect = isTruncated(envelope) || isModelTruncationSuspect(envelope);
    const platform = clientPlatformOf(envelope);

    for (const key of keys) {
      const row = byProject.get(key) ?? blankProjectRow(key);
      if (!row.clientPlatforms.includes(platform)) row.clientPlatforms.push(platform);
      row.requests += 1;
      if (method) row.mcpRequests += 1;
      if (method === 'tools/call') row.toolCalls += 1;
      if (isError) row.errors += 1;
      if (suspect) row.truncationSuspects += 1;
      if (ts !== null) {
        if (row.firstTs === null || ts < row.firstTs) { row.firstTs = ts; row.firstTsRaw = rawTs; }
        if (row.lastTs === null || ts > row.lastTs) { row.lastTs = ts; row.lastTsRaw = rawTs; }
      }
      addProjectSession(row, session);
      addProjectSample(row, id, maxRequestIdSamples);
      byProject.set(key, row);

      const timelineKey = `${key}\u0000${session ?? 'unknown'}`;
      const timeline = timelineGroups.get(timelineKey) ?? {
        projectKey: key,
        sessionId: session,
        requests: 0,
        mcpRequests: 0,
        errors: 0,
        toolCalls: 0,
        truncationSuspects: 0,
        firstTs: null,
        lastTs: null,
        firstTsRaw: null,
        lastTsRaw: null,
        requestIdSamples: [],
        primaryProjectRequests: 0,
        // Batch 13: platforms seen on this (project, session) pair.
        clientPlatforms: [],
      };
      if (!timeline.clientPlatforms.includes(platform)) timeline.clientPlatforms.push(platform);
      timeline.requests += 1;
      if (method) timeline.mcpRequests += 1;
      if (method === 'tools/call') timeline.toolCalls += 1;
      if (isError) timeline.errors += 1;
      if (suspect) timeline.truncationSuspects += 1;
      if (primaryKey === key) timeline.primaryProjectRequests += 1;
      if (ts !== null) {
        if (timeline.firstTs === null || ts < timeline.firstTs) { timeline.firstTs = ts; timeline.firstTsRaw = rawTs; }
        if (timeline.lastTs === null || ts > timeline.lastTs) { timeline.lastTs = ts; timeline.lastTsRaw = rawTs; }
      }
      addProjectSample(timeline, id, maxRequestIdSamples);
      timelineGroups.set(timelineKey, timeline);
    }
  }

  const finalizeTimes = (row) => {
    row.firstTs = row.firstTs === null ? null : new Date(row.firstTs).toISOString();
    row.lastTs = row.lastTs === null ? null : new Date(row.lastTs).toISOString();
    return row;
  };
  const byProjectRows = [...byProject.values()].map(finalizeTimes).sort((a, b) => {
    const n = b.requests - a.requests;
    return n !== 0 ? n : a.key.localeCompare(b.key);
  });
  const projectTimelines = [...timelineGroups.values()].map(finalizeTimes).sort((a, b) => {
    const ka = a.firstTs ?? 0;
    const kb = b.firstTs ?? 0;
    if (ka !== kb) return ka - kb;
    return a.projectKey.localeCompare(b.projectKey) || String(a.sessionId ?? '').localeCompare(String(b.sessionId ?? ''));
  });
  return { byProject: byProjectRows, projectTimelines };
}

/** Convert the byProject array into the stable keyed object used in metrics. */
function projectRowsToObject(rows) {
  return Object.fromEntries(rows.map((row) => [row.key, row]));
}

export function aggregateEnvelopes(envelopes, { date = '' } = {}) {
  const result = {
    requests: envelopes.length,
    mcpRequests: 0,
    nonMcpRequests: 0,
    errors: 0,
    mcpErrors: 0,
    statuses: {},
    errorClasses: {},
    routeErrors: {},
    tools: {},
    upstreams: {},
    durations: [],
    bytes: 0,
    truncated: 0,
    overflow: 0,
    // Additive fields (batch 9).
    truncationRate: 0,
    overflowRate: 0,
    errorRate: 0,
    byDay: {},
    byHour: {},
    byDayHour: {},
    byRoute: {},
    upstreamStats: {},
    toolStats: {},
    // Additive fields (batch 11) — model-side silent truncation.
    // Kept strictly separate from gateway `truncated` / `overflow`.
    model_truncation_suspects: 0,
    modelTruncationRate: 0,
    modelTruncationByServer: {},
    modelTruncationByTool: {},
    modelTruncationBySession: {},
    // Additive fields (batch 11, project rollup) — filled below.
    byProject: {},
    projectTimelines: [],
    // Additive fields (batch 13, platform eval) — filled below. Strictly
    // additive: the legacy aggregate shape above is preserved byte-for-byte.
    byClientPlatform: {},
    platformSummary: [],
    // Additive fields (M4-A, four-dimension ledger) — filled below.
    // clientPlatform × protocolVersion(v1/v2) × clientProfile × buildCommit.
    byProtocolVersion: {},
    byClientProfile: {},
    byBuildCommit: {},
    byEvalMode: {},
    byServerTag: {},
    multiServerRequests: 0,
    byFourDimension: {},
    fourDimensionSummary: [],
    // Eval closure (additive): structured connect failures + services() state.
    upstreamConnect: { failures: 0, byServer: {} },
    serviceState: { snapshots: 0, byServer: {}, offlineServers: [], staleServers: [], onlineServers: [], currentOfflineServers: [] },
    helperStats: [],
  };
  const upstreamGroups = new Map();
  const toolGroups = new Map();
  const routeGroups = new Map();
  // Eval closure: deterministic aggregation of connection failures and
  // `codemode.services()` snapshots. Both come from structured capture events
  // (upstream_connect / gateway_helper), never from prose or model output.
  const connectGroups = new Map();
  const serviceGroups = new Map();
  const connectSnapshotGroups = new Map();
  const helperGroups = new Map();
  let serviceSnapshotCount = 0;
  let connectSnapshotCount = 0;
  // Per-platform accumulator. Every platform gets its own row so one client's
  // errors / tool calls / truncations can never inflate another's.
  const platformGroups = new Map();

  for (const envelope of envelopes) {
    const platform = clientPlatformOf(envelope);
    const envelopeRequestId = String(envelope?.requestId ?? envelope?.request?.id ?? envelope?.id ?? 'unknown');
    // ── Eval closure: structured connect failures + services() snapshots ──
    for (const event of Array.isArray(envelope?.events) ? envelope.events : []) {
      if (event?.type === 'upstream_connect') {
        const server = typeof event.payload?.server === 'string' && event.payload.server
          ? event.payload.server : 'unknown';
        const ok = event.payload?.ok !== false;
        const status = ok ? 'online' : 'offline';
        const message = String(event.payload?.error?.message ?? '');
        const authFailure = !ok && /invalid_token|unauthorized|forbidden|401|reauth|invalid_grant/i.test(message);
        const connectRow = connectSnapshotGroups.get(server) ?? {
          name: server,
          snapshots: 0,
          toolCount: 0,
          statuses: {},
          needsReauth: false,
          sampleRequestIds: [],
          latest: null,
          source: 'upstream_connect',
        };
        connectRow.snapshots += 1;
        if (ok) connectRow.toolCount = Number(event.payload?.toolCount ?? connectRow.toolCount ?? 0) || 0;
        connectRow.statuses[status] = (connectRow.statuses[status] ?? 0) + 1;
        if (authFailure) connectRow.needsReauth = true;
        connectRow.latest = {
          status,
          toolCount: connectRow.toolCount,
          needsReauth: authFailure || connectRow.needsReauth,
          at: envelope?.ts ?? null,
          requestId: envelopeRequestId,
          source: 'upstream_connect',
        };
        if (connectRow.sampleRequestIds.length < 5 && !connectRow.sampleRequestIds.includes(envelopeRequestId)) {
          connectRow.sampleRequestIds.push(envelopeRequestId);
        }
        connectSnapshotGroups.set(server, connectRow);
        connectSnapshotCount += 1;
      }
      if (event?.type === 'upstream_connect' && event?.payload?.ok === false) {
        const server = typeof event.payload.server === 'string' && event.payload.server
          ? event.payload.server : 'unknown';
        const message = String(event.payload?.error?.message ?? '');
        const errorClass = /invalid_token|unauthorized|forbidden|401|reauth|invalid_grant/i.test(message)
          ? 'auth' : 'connect';
        const row = connectGroups.get(server) ?? { server, failures: 0, errorClasses: {}, sampleRequestIds: [] };
        row.failures += 1;
        row.errorClasses[errorClass] = (row.errorClasses[errorClass] ?? 0) + 1;
        if (row.sampleRequestIds.length < 5 && !row.sampleRequestIds.includes(envelopeRequestId)) {
          row.sampleRequestIds.push(envelopeRequestId);
        }
        connectGroups.set(server, row);
      }
      if (event?.type === 'gateway_helper') {
        const helper = typeof event.payload?.helper === 'string' && event.payload.helper
          ? event.payload.helper : 'unknown';
        const helperRow = helperGroups.get(helper) ?? { helper, calls: 0, last: null };
        helperRow.calls += 1;
        const payload = event.payload ?? {};
        helperRow.last = helper === 'services'
          ? { services: Array.isArray(payload.services) ? payload.services.length : 0 }
          : helper === 'listTools'
            ? { count: Number(payload.count ?? 0) || 0 }
            : helper === 'remainingCalls'
              ? { remaining: Number(payload.remaining ?? 0) || 0 }
              : {};
        helperGroups.set(helper, helperRow);
      }
      if (event?.type === 'gateway_helper' && event?.payload?.helper === 'services') {
        serviceSnapshotCount += 1;
        const rows = Array.isArray(event.payload.services) ? event.payload.services : [];
        for (const service of rows) {
          const name = typeof service?.name === 'string' && service.name ? service.name : 'unknown';
          const status = typeof service?.status === 'string' && service.status ? service.status : 'unknown';
          const row = serviceGroups.get(name) ?? {
            name, snapshots: 0, toolCount: 0, statuses: {}, needsReauth: false, sampleRequestIds: [], latest: null,
          };
          row.snapshots += 1;
          row.toolCount = Number(service?.toolCount ?? 0) || 0;
          row.statuses[status] = (row.statuses[status] ?? 0) + 1;
          if (service?.needsReauth === true) row.needsReauth = true;
          // G8: keep the latest observation separately from the historical
          // counts; comparisons must not treat "was offline once" as "is offline".
          row.latest = {
            status,
            toolCount: row.toolCount,
            needsReauth: service?.needsReauth === true,
            at: envelope?.ts ?? null,
            requestId: envelopeRequestId,
          };
          if (row.sampleRequestIds.length < 5 && !row.sampleRequestIds.includes(envelopeRequestId)) {
            row.sampleRequestIds.push(envelopeRequestId);
          }
          serviceGroups.set(name, row);
        }
      }
    }
    const platformRow = platformGroups.get(platform) ?? blankPlatformRow(platform);
    platformRow.requests += 1;
    // Count a requestId sample for evidence (bounded, stable insertion order).
    const requestId = String(envelope?.requestId ?? envelope?.request?.id ?? envelope?.id ?? 'unknown');
    const platformSession = sessionIdOf(envelope);
    if (platformSession) addPlatformSample(platformRow, 'sessionIds', platformSession);
    for (const key of projectKeysOf(envelope)) addPlatformSample(platformRow, 'projectKeys', key);
    if (!platformRow.requestIdSamples) platformRow.requestIdSamples = [];
    if (platformRow.requestIdSamples.length < 5 && !platformRow.requestIdSamples.includes(requestId)) {
      platformRow.requestIdSamples.push(requestId);
    }
    platformGroups.set(platform, platformRow);

    const status = Number(envelope?.response?.status ?? 0);
    let path = '/';
    try { path = new URL(String(envelope?.request?.url ?? '/'), 'http://localhost').pathname; } catch { /* keep default */ }
    const method = String(envelope?.request?.method ?? 'POST').toUpperCase();
    const isMcp = (path === '/mcp' || path === '/mcp/v2') && method === 'POST';
    if (isMcp) {
      result.mcpRequests += 1;
      platformRow.mcpRequests += 1;
    } else result.nonMcpRequests += 1;
    result.statuses[status] = (result.statuses[status] ?? 0) + 1;
    result.durations.push(Number(envelope?.response?.durationMs ?? 0));
    result.bytes += Number(envelope?.response?.bytes ?? 0);

    const truncated = isTruncated(envelope);
    const overflow = envelope?.response?.overflow === true;
    const modelSuspect = isModelTruncationSuspect(envelope);
    if (truncated || modelSuspect) platformRow.truncationSuspects += 1;
    if (truncated) result.truncated += 1;
    if (overflow) result.overflow += 1;
    if (modelSuspect) result.model_truncation_suspects += 1;

    const session = envelope?.sessionId ?? envelope?.request?.sessionId ?? null;
    if (modelSuspect) bumpHistogram(result.modelTruncationBySession, session ?? 'unknown');

    const { date: day, hour } = timeParts(envelope);
    bumpHistogram(result.byDay, day);
    bumpHistogram(result.byHour, hour);
    bumpHistogram(result.byDayHour, `${day}T${hour}`);

    const routeKey = `${method} ${path}`; // MCP routes keep their exact path (v1 vs v2).
    const route = routeGroups.get(routeKey) ?? blankGroup();
    route.calls += 1;
    route.durations.push(Number(envelope?.response?.durationMs ?? 0));
    if (truncated) route.truncated += 1;
    if (overflow) route.overflow += 1;
    if (modelSuspect) route.modelTruncationSuspects += 1;
    routeGroups.set(routeKey, route);

    let errorClass = null;
    if (status >= 400 || /isError":true|execute error/i.test(String(envelope?.response?.raw ?? ''))) {
      result.errors += 1;
      platformRow.errors += 1;
      errorClass = classifyError(envelope);
      if (isMcp) {
        result.mcpErrors += 1;
        result.errorClasses[errorClass] = (result.errorClasses[errorClass] ?? 0) + 1;
      } else {
        result.routeErrors[errorClass] = (result.routeErrors[errorClass] ?? 0) + 1;
        route.errors += 1;
        route.errorClasses[errorClass] = (route.errorClasses[errorClass] ?? 0) + 1;
      }
    }

    if (!isMcp) continue;
    try {
      const json = JSON.parse(String(envelope?.request?.raw ?? ''));
      const mcpMethod = json?.method;
      if (mcpMethod) result.tools[mcpMethod] = (result.tools[mcpMethod] ?? 0) + 1;
      if (mcpMethod === 'tools/call') platformRow.toolCalls += 1;
      const name = json?.params?.name;
      if (name) result.upstreams[name] = (result.upstreams[name] ?? 0) + 1;

      const server = upstreamOf(envelope, name);
      const upstream = upstreamGroups.get(server) ?? blankGroup();
      const toolName = name ?? 'unknown';
      const tool = toolGroups.get(toolName) ?? blankGroup();
      for (const group of [upstream, tool]) {
        group.calls += 1;
        group.durations.push(Number(envelope?.response?.durationMs ?? 0));
        if (truncated) group.truncated += 1;
        if (overflow) group.overflow += 1;
        if (modelSuspect) group.modelTruncationSuspects += 1;
        if (errorClass) {
          group.errors += 1;
          group.errorClasses[errorClass] = (group.errorClasses[errorClass] ?? 0) + 1;
        }
      }
      if (modelSuspect) {
        bumpHistogram(result.modelTruncationByServer, server);
        bumpHistogram(result.modelTruncationByTool, toolName);
      }
      upstreamGroups.set(server, upstream);
      if (name) toolGroups.set(name, tool);
    } catch { /* not JSON */ }
  }

  result.truncationRate = rate(result.truncated, result.requests);
  result.overflowRate = rate(result.overflow, result.requests);
  result.errorRate = rate(result.errors, result.requests);
  result.modelTruncationRate = rate(result.model_truncation_suspects, result.requests);
  result.durations.sort((a, b) => a - b);
  const pct = (p) => result.durations[Math.min(result.durations.length - 1, Math.max(0, Math.ceil(result.durations.length * p) - 1))] ?? 0;
  result.p50Ms = pct(0.5);
  result.p95Ms = pct(0.95);
  result.avgMs = result.durations.length ? Math.round(result.durations.reduce((a, b) => a + b, 0) / result.durations.length) : 0;

  for (const [name, group] of upstreamGroups) result.upstreamStats[name] = finishGroup(group);
  for (const [name, group] of toolGroups) result.toolStats[name] = finishGroup(group);
  for (const [name, group] of routeGroups) result.byRoute[name] = finishGroup(group);

  const projectRollup = digestProjects(envelopes);
  result.byProject = projectRowsToObject(projectRollup.byProject);
  result.projectTimelines = projectRollup.projectTimelines;

  // --- Batch 13: per-platform ledger -------------------------------------
  // Stable column order: known platforms first, unknown last. Only platforms
  // that actually appear are emitted (no fabricated zero rows for platforms
  // that never sent a request). Each row is self-contained and carries its
  // session/project ids as evidence for cross-checking against the rollups.
  const platformOrder = [...CLIENT_PLATFORMS, UNKNOWN_PLATFORM];
  const platformRows = [...platformGroups.values()]
    .map((row) => {
      row.sessions = row.sessionIds.length;
      row.projects = row.projectKeys.length;
      row.clientPlatforms = [row.platform]; // convenience for consumers
      return row;
    })
    .sort((a, b) => platformOrder.indexOf(a.platform) - platformOrder.indexOf(b.platform));
  for (const row of platformRows) result.byClientPlatform[row.platform] = row;
  // Compact summary used by the MD table and by downstream eval lanes.
  result.platformSummary = platformRows.map((row) => ({
    platform: row.platform,
    requests: row.requests,
    mcpRequests: row.mcpRequests,
    errors: row.errors,
    toolCalls: row.toolCalls,
    truncationSuspects: row.truncationSuspects,
    sessions: row.sessions,
    projects: row.projects,
    requestIdSamples: row.requestIdSamples,
  }));

  // --- M4-A: four-dimension ledger ---------------------------------------
  // clientPlatform × protocolVersion(v1/v2) × clientProfile × buildCommit.
  // Every dimension is explicit-only; old envelopes without the fields land in
  // `unknown` instead of being silently attributed to a modern client/build.
  const dimensionGroups = new Map();
  const protocolGroups = new Map();
  const profileGroups = new Map();
  const buildGroups = new Map();
  const evalModeGroups = new Map();
  const serverTagGroups = new Map();
  const bumpBucket = (map, key, extra, flags) => {
    const row = map.get(key) ?? {
      ...extra, requests: 0, mcpRequests: 0, errors: 0, toolCalls: 0, truncationSuspects: 0,
    };
    row.requests += 1;
    if (flags.isMcp) row.mcpRequests += 1;
    if (flags.isError) row.errors += 1;
    if (flags.toolCall) row.toolCalls += 1;
    if (flags.suspect) row.truncationSuspects += 1;
    map.set(key, row);
    return row;
  };
  for (const envelope of envelopes) {
    const platform = clientPlatformOf(envelope);
    const protocolVersion = protocolVersionOf(envelope);
    const executor = executorOf(envelope);
    const clientProfile = clientProfileOf(envelope);
    const buildCommit = buildCommitOf(envelope);
    const evalMode = evalModeOf(envelope);
    const servers = serversOf(envelope);
    const path = requestPathOf(envelope);
    const method = String(envelope?.request?.method ?? 'POST').toUpperCase();
    const isMcp = (path === '/mcp' || path === '/mcp/v2') && method === 'POST';
    const mcpMethod = mcpMethodOf(envelope);
    const status = Number(envelope?.response?.status ?? 0);
    const raw = String(envelope?.response?.raw ?? '');
    const isError = status >= 400 || /"isError":true|execute error/i.test(raw);
    const suspect = isTruncated(envelope) || isModelTruncationSuspect(envelope);
    const flags = { isMcp, isError, toolCall: isMcp && mcpMethod === 'tools/call', suspect };
    const requestId = String(envelope?.requestId ?? envelope?.request?.id ?? envelope?.id ?? 'unknown');
    if (servers.length > 1) result.multiServerRequests += 1;

    const dimensionKey = fourDimensionKeyOf(envelope);
    const dimension = dimensionGroups.get(dimensionKey) ?? {
      clientPlatform: platform,
      protocolVersion,
      executor,
      clientProfile,
      buildCommit,
      requests: 0,
      mcpRequests: 0,
      errors: 0,
      toolCalls: 0,
      truncationSuspects: 0,
      evalModes: {},
      servers: [],
      requestIdSamples: [],
    };
    dimension.requests += 1;
    if (isMcp) dimension.mcpRequests += 1;
    if (isError) dimension.errors += 1;
    if (flags.toolCall) dimension.toolCalls += 1;
    if (suspect) dimension.truncationSuspects += 1;
    dimension.evalModes[evalMode] = (dimension.evalModes[evalMode] ?? 0) + 1;
    for (const server of servers) if (!dimension.servers.includes(server)) dimension.servers.push(server);
    if (dimension.requestIdSamples.length < 5 && !dimension.requestIdSamples.includes(requestId)) {
      dimension.requestIdSamples.push(requestId);
    }
    dimensionGroups.set(dimensionKey, dimension);

    bumpBucket(protocolGroups, protocolVersion, { protocolVersion, executor }, flags);
    bumpBucket(profileGroups, clientProfile, { clientProfile }, flags);
    const buildRow = bumpBucket(buildGroups, buildCommit, { buildCommit, clientPlatforms: [] }, flags);
    if (!buildRow.clientPlatforms.includes(platform)) buildRow.clientPlatforms.push(platform);
    bumpBucket(evalModeGroups, evalMode, { evalMode }, flags);
    for (const server of servers) bumpBucket(serverTagGroups, server, { server }, flags);
  }

  const orderBy = (order) => (a, b) => order.indexOf(a) - order.indexOf(b);
  const rowsToObject = (map, order, field) => Object.fromEntries(
    [...map.values()]
      .sort((a, b) => {
        const base = orderBy(order)(a[field], b[field]);
        return base !== 0 ? base : String(a[field]).localeCompare(String(b[field]));
      })
      .map((row) => [row[field], row]),
  );
  result.byProtocolVersion = rowsToObject(protocolGroups, [...PROTOCOL_VERSIONS, UNKNOWN_BUCKET], 'protocolVersion');
  result.byClientProfile = rowsToObject(
    profileGroups,
    ['gemini-text-json', 'chatgpt-structured', 'claude-text', UNKNOWN_BUCKET],
    'clientProfile',
  );
  result.byEvalMode = rowsToObject(evalModeGroups, ['active', 'passive', UNKNOWN_BUCKET], 'evalMode');
  result.byBuildCommit = Object.fromEntries(
    [...buildGroups.values()]
      .sort((a, b) => (b.requests - a.requests) || a.buildCommit.localeCompare(b.buildCommit))
      .map((row) => [row.buildCommit, row]),
  );
  result.byServerTag = Object.fromEntries(
    [...serverTagGroups.values()]
      .sort((a, b) => (b.requests - a.requests) || a.server.localeCompare(b.server))
      .map((row) => [row.server, row]),
  );
  result.fourDimensionSummary = [...dimensionGroups.values()]
    .sort((a, b) => (b.requests - a.requests)
      || fourDimensionKeyOf({
        clientPlatform: a.clientPlatform,
        protocolVersion: a.protocolVersion,
        clientProfile: a.clientProfile,
        deployment: { commit: a.buildCommit },
      }).localeCompare(fourDimensionKeyOf({
        clientPlatform: b.clientPlatform,
        protocolVersion: b.protocolVersion,
        clientProfile: b.clientProfile,
        deployment: { commit: b.buildCommit },
      })));
  result.byFourDimension = Object.fromEntries(
    [...result.fourDimensionSummary]
      .map((row) => [`${row.clientPlatform}|${row.protocolVersion}|${row.clientProfile}|${row.buildCommit}`, row])
      .sort(([a], [b]) => a.localeCompare(b)),
  );

  // ── Eval closure: deterministic connect-failure + service-state summary ──
  const connectRows = [...connectGroups.values()].map((row) => ({
    server: row.server,
    failures: row.failures,
    errorClasses: Object.fromEntries(Object.entries(row.errorClasses).sort(([a], [b]) => a.localeCompare(b))),
    sampleRequestIds: row.sampleRequestIds,
  })).sort((a, b) => (b.failures - a.failures) || a.server.localeCompare(b.server));
  const serviceRows = [...serviceGroups.values()].map((row) => ({
    name: row.name,
    snapshots: row.snapshots,
    toolCount: row.toolCount,
    statuses: Object.fromEntries(Object.entries(row.statuses).sort(([a], [b]) => a.localeCompare(b))),
    needsReauth: row.needsReauth,
    latest: row.latest ?? null,
    sampleRequestIds: row.sampleRequestIds,
  })).sort((a, b) => a.name.localeCompare(b.name));
  // Cold-start connection events are snapshots too. Merge only servers that a
  // codemode.services() helper did not already describe, so one server is not
  // counted twice in the same observation.
  let mergedConnectSnapshots = 0;
  for (const row of connectSnapshotGroups.values()) {
    if (serviceGroups.has(row.name)) continue;
    serviceRows.push({
      name: row.name,
      snapshots: row.snapshots,
      toolCount: row.toolCount,
      statuses: Object.fromEntries(Object.entries(row.statuses).sort(([a], [b]) => a.localeCompare(b))),
      needsReauth: row.needsReauth,
      latest: row.latest ?? null,
      sampleRequestIds: row.sampleRequestIds,
      source: 'upstream_connect',
    });
    mergedConnectSnapshots += row.snapshots;
  }
  serviceRows.sort((a, b) => a.name.localeCompare(b.name));
  result.upstreamConnect = {
    failures: connectRows.reduce((sum, row) => sum + row.failures, 0),
    byServer: Object.fromEntries(connectRows.map((row) => [row.server, row])),
  };
  result.serviceState = {
    snapshots: serviceSnapshotCount + mergedConnectSnapshots,
    helperSnapshots: serviceSnapshotCount,
    connectSnapshots: mergedConnectSnapshots,
    byServer: Object.fromEntries(serviceRows.map((row) => [row.name, row])),
    offlineServers: serviceRows.filter((row) => row.needsReauth || (row.statuses.offline ?? 0) > 0).map((row) => row.name).sort(),
    staleServers: serviceRows.filter((row) => (row.statuses.stale ?? 0) > 0).map((row) => row.name).sort(),
    onlineServers: serviceRows
      .filter((row) => !row.needsReauth && (row.statuses.offline ?? 0) === 0 && (row.statuses.stale ?? 0) === 0)
      .map((row) => row.name).sort(),
    currentOfflineServers: serviceRows
      .filter((row) => row.latest && (row.latest.needsReauth === true || row.latest.status === 'offline'))
      .map((row) => row.name).sort(),
    source: 'codemode.services+upstream_connect',
  };
  result.serviceSnapshots = result.serviceState;
  result.serviceSnapshotCounts = {
    snapshots: result.serviceState.snapshots,
    helper: result.serviceState.helperSnapshots,
    connect: result.serviceState.connectSnapshots,
  };
  result.helperStats = [...helperGroups.values()]
    .sort((a, b) => a.helper.localeCompare(b.helper));

  // Keep a stable, human-friendly order in JSON output.
  for (const key of ['byDay', 'byDayHour', 'byHour', 'statuses', 'errorClasses', 'routeErrors', 'upstreamStats', 'toolStats', 'byRoute', 'modelTruncationByServer', 'modelTruncationByTool', 'modelTruncationBySession', 'byClientPlatform']) {
    result[key] = Object.fromEntries(Object.entries(result[key]).sort(([a], [b]) => a.localeCompare(b)));
  }
  result.date = date || Object.keys(result.byDay).filter((d) => d !== 'unknown').sort().at(-1) || 'unknown';
  return result;
}

function statTable(stats, { tool = false } = {}) {
  const rows = Object.entries(stats).sort((a, b) => b[1].calls - a[1].calls).slice(0, 10)
    .map(([name, s]) => {
      const errors = Object.entries(s.errorClasses).map(([cls, count]) => `${cls}:${count}`).join(',') || '—';
      return `| ${name} | ${s.calls} | ${s.errors} | ${s.errorRate} | ${s.p50Ms} | ${s.p95Ms} | ${s.avgMs} | ${s.truncated} | ${s.overflow} | ${s.modelTruncationSuspects ?? 0} | ${errors} |`;
    });
  return [
    `| ${tool ? 'Tool' : 'Upstream'} | Calls | Errors | Error rate | p50 ms | p95 ms | Avg ms | Truncated | Overflow | ModelTrunc | Error classes |`,
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|',
    ...(rows.length ? rows : ['| — | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | — |']),
  ].join('\n');
}

export function renderScorecard(date, metrics) {
  const toolRows = Object.entries(metrics.upstreams).sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([name, count]) => `| ${name} | ${count} |`).join('\n');
  const errorRows = Object.entries(metrics.errorClasses).sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `| ${name} | ${count} |`).join('\n') || '| — | 0 |';
  const dayRows = Object.entries(metrics.byDay ?? {}).sort(([a], [b]) => a.localeCompare(b))
    .map(([day, count]) => `| ${day} | ${count} |`).join('\n') || '| — | 0 |';
  const hourRows = Object.entries(metrics.byHour ?? {}).sort(([a], [b]) => a.localeCompare(b))
    .map(([hour, count]) => `| ${hour}:00 | ${count} |`).join('\n') || '| — | 0 |';
  const projectRows = Object.entries(metrics.byProject ?? {})
    .sort((a, b) => b[1].requests - a[1].requests || a[0].localeCompare(b[0]))
    .map(([key, p]) => {
      const sessions = (p.sessionIds ?? []).map((id) => `\`${id}\``).join(', ') || '—';
      const ids = (p.requestIdSamples ?? []).map((id) => `\`${id}\``).join(', ') || '—';
      const platforms = (p.clientPlatforms ?? []).join(', ') || '—';
      return `| ${key} | ${platforms} | ${p.requests} | ${p.mcpRequests} | ${p.errors} | ${p.toolCalls} | ${p.truncationSuspects} | ${p.firstTs ?? '—'} | ${p.lastTs ?? '—'} | ${sessions} | ${ids} |`;
    }).join('\n') || '| — | — | 0 | 0 | 0 | 0 | 0 | — | — | — | — |';
  const platformRows = (metrics.platformSummary ?? [])
    .map((p) => {
      const ids = (p.requestIdSamples ?? []).map((id) => `\`${id}\``).join(', ') || '—';
      return `| ${p.platform} | ${p.requests} | ${p.mcpRequests} | ${p.errors} | ${p.toolCalls} | ${p.truncationSuspects} | ${p.sessions} | ${p.projects} | ${ids} |`;
    }).join('\n') || '| — | 0 | 0 | 0 | 0 | 0 | 0 | 0 | — |';
  const protocolRows = Object.values(metrics.byProtocolVersion ?? {}).map((p) => `| ${p.protocolVersion} | ${p.executor} | ${p.requests} | ${p.mcpRequests} | ${p.errors} | ${p.toolCalls} | ${p.truncationSuspects} |`).join('\n') || '| — | — | 0 | 0 | 0 | 0 | 0 |';
  const profileRows = Object.values(metrics.byClientProfile ?? {}).map((p) => `| ${p.clientProfile} | ${p.requests} | ${p.mcpRequests} | ${p.errors} | ${p.toolCalls} | ${p.truncationSuspects} |`).join('\n') || '| — | 0 | 0 | 0 | 0 | 0 |';
  const evalModeCell = (modes) => Object.entries(modes ?? {}).map(([mode, count]) => `${mode}:${count}`).join(', ') || '—';
  const fourDimRows = (metrics.fourDimensionSummary ?? []).map((row) => {
    const ids = (row.requestIdSamples ?? []).map((id) => `\`${id}\``).join(', ') || '—';
    return `| ${row.clientPlatform} | ${row.protocolVersion} | ${row.executor} | ${row.clientProfile} | ${row.buildCommit} | ${row.requests} | ${row.mcpRequests} | ${row.errors} | ${row.toolCalls} | ${row.truncationSuspects} | ${evalModeCell(row.evalModes)} | ${(row.servers ?? []).join(', ')} | ${ids} |`;
  }).join('\n') || '| — | — | — | — | — | 0 | 0 | 0 | 0 | 0 | — | — | — |';
  const serverTagRows = Object.values(metrics.byServerTag ?? {}).map((row) => `| ${row.server} | ${row.requests} | ${row.mcpRequests} | ${row.errors} | ${row.toolCalls} | ${row.truncationSuspects} |`).join('\n') || '| — | 0 | 0 | 0 | 0 | 0 |';
  const evalModeRows = Object.values(metrics.byEvalMode ?? {}).map((row) => `| ${row.evalMode} | ${row.requests} | ${row.mcpRequests} | ${row.errors} | ${row.toolCalls} | ${row.truncationSuspects} |`).join('\n') || '| — | 0 | 0 | 0 | 0 | 0 |';
  const connectRowsMd = Object.values(metrics.upstreamConnect?.byServer ?? {}).map((row) => {
    const ids = (row.sampleRequestIds ?? []).map((id) => `\`${id}\``).join(', ') || '—';
    const classes = Object.entries(row.errorClasses ?? {}).map(([name, count]) => `${name}:${count}`).join(', ') || '—';
    return `| ${row.server} | ${row.failures} | ${classes} | ${ids} |`;
  }).join('\n') || '| — | 0 | — | — |';
  const serviceRowsMd = Object.values(metrics.serviceState?.byServer ?? {}).map((row) => {
    const ids = (row.sampleRequestIds ?? []).map((id) => `\`${id}\``).join(', ') || '—';
    const statuses = Object.entries(row.statuses ?? {}).map(([name, count]) => `${name}:${count}`).join(', ') || '—';
    const latest = row.latest ? `${row.latest.status ?? 'unknown'}${row.latest.needsReauth ? '/needsReauth' : ''}` : '—';
    return `| ${row.name} | ${row.snapshots} | ${row.toolCount} | ${statuses} | ${latest} | ${ids} |`;
  }).join('\n') || '| — | 0 | 0 | — | — | — |';
  const helperRowsMd = (metrics.helperStats ?? []).map((row) => {
    const last = row.last ? JSON.stringify(row.last) : '—';
    return `| ${row.helper} | ${row.calls} | ${last} |`;
  }).join('\n') || '| — | 0 | — |';
  return `# Capture Scorecard — ${date}

| Metric | Value |
|---|---|
| Requests | ${metrics.requests} |
| MCP POST requests | ${metrics.mcpRequests} |
| Non-MCP routes | ${metrics.nonMcpRequests} |
| Errors (HTTP >= 400) | ${metrics.errors} |
| MCP errors | ${metrics.mcpErrors} |
| p50 latency | ${metrics.p50Ms} ms |
| p95 latency | ${metrics.p95Ms} ms |
| Avg latency | ${metrics.avgMs} ms |
| Response bytes | ${metrics.bytes} |
| Truncated responses (gateway wire) | ${metrics.truncated} |
| Overflow captures (capture limit) | ${metrics.overflow} |
| Truncation rate | ${metrics.truncationRate ?? 0} |
| Overflow rate | ${metrics.overflowRate ?? 0} |
| Model truncation suspects (silent) | ${metrics.model_truncation_suspects ?? 0} |
| Model truncation rate | ${metrics.modelTruncationRate ?? 0} |
| Overall error rate | ${metrics.errorRate ?? 0} |

## By client platform (batch 13)
> 每个平台的指标单独成行，绝不互相污染。\`clientPlatform\` 只接受显式且可识别的值；
> 缺失 / null / 非字符串 / 未知值一律进 \`unknown\`，不根据 UA / 工具名猜测。
> 旧 envelope（无字段）全部落在 \`unknown\`，不会被算进 Gemini。
> 平台之间**不做硬比**：baseline 与任务分母按平台独立（见 batch-13-platform-eval.md）。

| Platform | Requests | MCP requests | Errors | Tool calls | Trunc suspects | Sessions | Projects | RequestId samples |
|---|---:|---:|---:|---:|---:|---:|---:|---|
${platformRows}

## By protocol version (v1 / v2) — M4-A
> \`protocolVersion\` 只来自显式字段或请求路径（\`/mcp/v2\`=v2，\`/mcp\`=v1）；
> 旧 envelope / 非 MCP 路由一律 \`unknown\`，不猜。

| Protocol | Executor | Requests | MCP requests | Errors | Tool calls | Trunc suspects |
|---|---|---|---:|---:|---:|---:|
${protocolRows}

## By client profile — M4-A

| Profile | Requests | MCP requests | Errors | Tool calls | Trunc suspects |
|---|---|---:|---:|---:|---:|
${profileRows}

## Four-dimension ledger — platform × protocol × profile × build (M4-A)
> 每个桶独立统计；桶与桶之间不做硬比。\`unknown\` 是合法桶（旧 envelope / 缺字段）。

| Platform | Protocol | Executor | Profile | Build commit | Requests | MCP | Errors | Tool calls | Trunc | Eval modes | Servers[] | RequestId samples |
|---|---|---|---|---:|---:|---:|---:|---:|---|---|---|
${fourDimRows}

## By servers[] (cross-upstream) — M4-A
> 只读 capture 显式 \`servers[]\`；缺失记 \`unknown\`，不从工具名反推。
> 一次请求串多个上游时，每个 server 各计一次；\`multiServerRequests\`=${metrics.multiServerRequests ?? 0}。

| Server | Requests | MCP requests | Errors | Tool calls | Trunc suspects |
|---|---|---:|---:|---:|---:|
${serverTagRows}

## By eval mode (active / passive) — M4-A
> \`evalMode\` 缺省/非法一律 \`unknown\`，绝不按时间或来源猜测。

| Eval mode | Requests | MCP requests | Errors | Tool calls | Trunc suspects |
|---|---|---:|---:|---:|---:|
${evalModeRows}

## Tool calls (MCP method)
${Object.entries(metrics.tools).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, count]) => `- ${name}: ${count}`).join('\n') || '- none'}

## Top upstream tools (legacy tally)
| Tool | Calls |
|---|---|
${toolRows || '| — | 0 |'}

## Per-upstream stats (MCP tools/call)
${statTable(metrics.upstreamStats ?? {})}

## Per-MCP-tool stats
${statTable(metrics.toolStats ?? {}, { tool: true })}

## Upstream connect failures (eval closure)
> 来自结构化 capture 事件 \`upstream_connect{ok:false}\`，不读模型/正文；用于被动侧看见
> “哪个上游连不上/需要重新授权”，而不是只看成功的 tools/call。

| Server | Failures | Error classes | RequestId samples |
|---|---:|---|---|
${connectRowsMd}

## Service state snapshots (codemode.services())
> 来自 \`gateway_helper{helper:"services"}\` 的冷启动快照（name/toolCount/status/online/needsReauth）；
> 它不是 live 健康检查。\`latest\` 是该服务在本窗口的最后一次观察，历史 counts 只作证据。

| Service | Snapshots | Tool count | Status counts | Latest | RequestId samples |
|---|---:|---:|---|---|---|
${serviceRowsMd}

## Gateway helper calls (eval closure)
> 来自 \`gateway_helper\` 的全部 helper 调用（services / listTools / remainingCalls）。

| Helper | Calls | Last payload |
|---|---:|---|
${helperRowsMd}

## Truncation / overflow
> Three independent signals. "Model truncation suspects" is the silent case:
> the gateway wire was complete, but the model received a materially shorter,
> unmarked projection (e.g. model code calling slice(0, 150)). It is advisory-only.

| Signal | Count | Rate |
|---|---:|---:|
| Truncated responses (gateway wire) | ${metrics.truncated} | ${metrics.truncationRate ?? 0} |
| Overflow captures (capture limit) | ${metrics.overflow} | ${metrics.overflowRate ?? 0} |
| Model truncation suspects (silent, advisory) | ${metrics.model_truncation_suspects ?? 0} | ${metrics.modelTruncationRate ?? 0} |

### Model truncation suspects by server
| Server | Suspects |
|---|---:|
${Object.entries(metrics.modelTruncationByServer ?? {}).sort((a, b) => b[1] - a[1]).map(([name, count]) => `| ${name} | ${count} |`).join('\n') || '| — | 0 |'}

### Model truncation suspects by tool
| Tool | Suspects |
|---|---:|
${Object.entries(metrics.modelTruncationByTool ?? {}).sort((a, b) => b[1] - a[1]).map(([name, count]) => `| ${name} | ${count} |`).join('\n') || '| — | 0 |'}

### Model truncation suspects by session
| Session | Suspects |
|---|---:|
${Object.entries(metrics.modelTruncationBySession ?? {}).sort((a, b) => b[1] - a[1]).map(([name, count]) => `| ${name} | ${count} |`).join('\n') || '| — | 0 |'}

## Projects (derived labels, batch 11)
> \`projects[]\` / \`primaryProject\` are deterministic tags derived at capture time
> from explicit owner/repo pairs, never client-declared identities. One request
> may carry several tags; each tag is counted independently. Projects are
> ORTHOGONAL to sessions — see \`projectTimelines\` in the JSON scorecard for
> the same project spanning multiple sessions (handoff).

| Project | Platforms | Requests | MCP requests | Errors | Tool calls | Trunc suspects | First ts | Last ts | SessionIds | RequestId samples |
|---|---|---:|---:|---:|---:|---:|---|---|---|---|
${projectRows}

## Requests by day
| Day | Requests |
|---|---:|
${dayRows}

## Requests by hour (UTC)
| Hour | Requests |
|---|---:|
${hourRows}

## Non-MCP routes (kept separate)
${statTable(metrics.byRoute ?? {})}

## Error classes (MCP only)
| Class | Count |
|---|---|
${errorRows}

## Route errors (non-MCP)
| Class | Count |
|---|---|
${Object.entries(metrics.routeErrors ?? {}).map(([name, count]) => `| ${name} | ${count} |`).join('\n') || '| — | 0 |'}

> Generated by \`scripts/capture-digest.mjs\`. Raw payloads remain in R2.
`;
}

/* ------------------------------------------------------------------ *
 * Session / window clustering (batch 11)
 *
 * Goal: group ONLINE capture envelopes into sessions so they can be joined
 * against OFFLINE L1/G6 tasks without any client or SDK cooperation.
 *
 * Rules (see docs/ledger/batch-11-session-clustering.md):
 *   1. Prefer envelope.sessionId (issued by initialize as Mcp-Session-Id).
 *   2. Without sessionId, cluster deterministically into a synthetic windowId:
 *      - `initialize` opens a new window;
 *      - a legacy window with no initialize: the first request opens it, and
 *        an idle gap > 15 minutes opens a new one;
 *      - tools/list refresh and clientInfo / client-IP changes are auxiliary
 *        signals only — they never split a window on their own;
 *      - original requestId / sessionId are never overwritten; windowId is
 *        analysis-only metadata on a returned copy.
 * ------------------------------------------------------------------ */

/** Default idle gap that splits a sessionId-less window (15 minutes, ms). */
export const DEFAULT_IDLE_MS = 15 * 60 * 1000;

/** Timestamp of an envelope as epoch ms, or null when unparseable. */
export function requestTimeOf(envelope) {
  const raw = envelope?.ts ?? envelope?.timestamp ?? envelope?.request?.ts ?? '';
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : null;
}

/**
 * Preferred correlation key. The gateway stamps `sessionId` from initialize's
 * Mcp-Session-Id (src/capture.js); older captures may only echo it on the
 * request object or header. Never synthesize here — clustering does that.
 */
export function sessionIdOf(envelope) {
  const candidates = [
    envelope?.sessionId,
    envelope?.request?.sessionId,
    envelope?.request?.headers?.['mcp-session-id'],
    envelope?.request?.headers?.['Mcp-Session-Id'],
  ];
  for (const candidate of candidates) {
    if (candidate !== null && candidate !== undefined && String(candidate) !== '') return String(candidate);
  }
  return null;
}

/** MCP method name from the captured JSON-RPC body, or null. */
export function mcpMethodOf(envelope) {
  try {
    const json = JSON.parse(String(envelope?.request?.raw ?? ''));
    return typeof json?.method === 'string' ? json.method : null;
  } catch { return null; }
}

/** Stable client descriptor (auxiliary signal only, never a split trigger). */
export function clientInfoOf(envelope) {
  if (envelope?.clientInfo !== null && envelope?.clientInfo !== undefined) return envelope.clientInfo;
  if (envelope?.request?.clientInfo !== null && envelope?.request?.clientInfo !== undefined) return envelope.request.clientInfo;
  const headers = envelope?.request?.headers ?? {};
  const ip = headers['x-forwarded-for'] ?? headers['x-real-ip'] ?? headers['cf-connecting-ip'] ?? null;
  return ip ? { ip: String(ip).split(',')[0].trim() } : null;
}

/** Stable fingerprint used for deterministic tie-breaking when ts is missing. */
function requestIdOf(envelope, index) {
  const id = envelope?.requestId ?? envelope?.request?.id ?? envelope?.id;
  return id !== null && id !== undefined && String(id) !== '' ? String(id) : `idx:${index}`;
}

/**
 * Assign an analysis-only `windowId` to every envelope and return copies.
 * Input is never mutated: requestId / sessionId stay byte-for-byte identical.
 *
 * The sort is deterministic on (timestamp ?? 0, requestId, original index), so
 * the same input always yields the same window membership and window numbering.
 */
export function assignWindows(envelopes, { idleMs = DEFAULT_IDLE_MS } = {}) {
  const gap = Number.isFinite(idleMs) && idleMs >= 0 ? idleMs : DEFAULT_IDLE_MS;
  const indexed = envelopes.map((envelope, index) => ({ envelope, index }));
  indexed.sort((a, b) => {
    const ta = requestTimeOf(a.envelope);
    const tb = requestTimeOf(b.envelope);
    if (ta !== tb) return (ta ?? 0) - (tb ?? 0);
    return requestIdOf(a.envelope, a.index).localeCompare(requestIdOf(b.envelope, b.index));
  });

  // Counts are per strategy so session-backed and synthetic ids never collide.
  const sessionCounts = new Map();
  let legacyWindowCount = 0;
  let currentWindowId = null;
  let lastLegacyEnd = null; // last event time of the current synthetic window
  let lastStrategy = 'first-request';

  const out = indexed.map(({ envelope, index }) => {
    const sessionId = sessionIdOf(envelope);
    const method = mcpMethodOf(envelope);
    const ts = requestTimeOf(envelope);
    let windowId;
    let strategy;

    if (sessionId) {
      const next = (sessionCounts.get(sessionId) ?? 0) + 1;
      sessionCounts.set(sessionId, next);
      windowId = `session:${sessionId}`;
      strategy = 'sessionId';
      // An initialize inside a session does not split it — the session key
      // already provides the boundary.
    } else {
      const newWindow = method === 'initialize'
        || lastLegacyEnd === null
        || ts === null
        || ts - lastLegacyEnd > gap;
      if (newWindow) {
        legacyWindowCount += 1;
        currentWindowId = `window:${String(legacyWindowCount).padStart(3, '0')}`;
        lastStrategy = initializeStrategy(method, ts, lastLegacyEnd, gap, newWindow);
      } else {
        // Continue current window; tools/list and client changes are auxiliary
        // signals only and never open a window by themselves.
        lastStrategy = 'continued';
      }
      windowId = currentWindowId;
      strategy = lastStrategy;
      lastLegacyEnd = ts;
    }

    return {
      ...envelope,
      windowId,
      windowStrategy: strategy,
      windowMeta: {
        mcpMethod: method,
        clientInfo: clientInfoOf(envelope),
        // tools/list / client changes are recorded for review, never split on.
        auxiliarySignals: [
          method === 'tools/list' ? 'tools-list-refresh' : null,
        ].filter(Boolean),
      },
      // Kept for tests/debugging; original identity fields are untouched.
      _windowSortIndex: index,
    };
  });

  return out;
}

/** Human-readable reason a synthetic window was opened/extended. */
function initializeStrategy(method, ts, lastEnd, gap, isNew) {
  if (!isNew) return 'continued';
  if (method === 'initialize') return 'initialize';
  if (lastEnd === null) return 'first-request';
  if (ts === null) return 'unknown-ts-new-window';
  return ts - lastEnd > gap ? 'idle-gap' : 'continued';
}

/**
 * Aggregate envelopes by session/window. Returns a stable, sorted array of
 * digest rows. Every row keeps requestId samples so a reviewer can replay the
 * exact envelopes from R2 (see batch-11 ledger doc).
 */
export function digestSessions(envelopes, { idleMs = DEFAULT_IDLE_MS, maxRequestIdSamples = 5 } = {}) {
  const windows = assignWindows(envelopes, { idleMs });
  const groups = new Map();
  for (const envelope of windows) {
    const key = envelope.windowId;
    const row = groups.get(key) ?? {
      windowId: key,
      strategy: envelope.windowStrategy,
      sessionId: sessionIdOf(envelope),
      // Explicit upstream anchor only; never synthesized by clustering.
      taskId: envelope?.taskId ?? envelope?.meta?.taskId ?? envelope?.request?.taskId ?? null,
      requests: 0,
      mcpRequests: 0,
      mcpErrors: 0,
      toolCalls: 0,
      truncationSuspects: 0,
      firstTs: null,
      lastTs: null,
      firstTsRaw: null,
      lastTsRaw: null,
      clientInfo: null,
      requestIdSamples: [],
      methods: {},
      // Additive: project tags seen in this window (orthogonal to sessions).
      projects: [],
      primaryProjects: [],
      // Batch 13: platforms seen in this window. A window is usually one
      // platform; if several appear, all are listed (never guessed).
      clientPlatforms: [],
      requestsByClientPlatform: {},
    };
    row.requests += 1;
    const rowPlatform = clientPlatformOf(envelope);
    if (!row.clientPlatforms.includes(rowPlatform)) row.clientPlatforms.push(rowPlatform);
    row.requestsByClientPlatform[rowPlatform] = (row.requestsByClientPlatform[rowPlatform] ?? 0) + 1;
    const rowTaskId = envelope?.taskId ?? envelope?.meta?.taskId ?? envelope?.request?.taskId ?? null;
    if (rowTaskId) {
      if (row.taskId && row.taskId !== String(rowTaskId)) row.taskIdConflicts = true;
      else row.taskId = String(rowTaskId);
    }
    const ts = requestTimeOf(envelope);
    const rawTs = envelope?.ts ?? envelope?.timestamp ?? envelope?.request?.ts ?? null;
    if (ts !== null) {
      if (row.firstTs === null || ts < row.firstTs) { row.firstTs = ts; row.firstTsRaw = rawTs; }
      if (row.lastTs === null || ts > row.lastTs) { row.lastTs = ts; row.lastTsRaw = rawTs; }
    }
    if (row.clientInfo === null) row.clientInfo = clientInfoOf(envelope);

    const method = mcpMethodOf(envelope);
    if (method) {
      row.methods[method] = (row.methods[method] ?? 0) + 1;
      row.mcpRequests += 1;
      if (method === 'tools/call') row.toolCalls += 1;
    }
    const status = Number(envelope?.response?.status ?? 0);
    const raw = String(envelope?.response?.raw ?? '');
    if (status >= 400 || /isError":true|execute error/i.test(raw)) row.mcpErrors += 1;
    if (isTruncated(envelope) || isModelTruncationSuspect(envelope)) row.truncationSuspects += 1;

    const id = requestIdOf(envelope, envelope._windowSortIndex);
    if (row.requestIdSamples.length < maxRequestIdSamples) row.requestIdSamples.push(id);

    // Project rollup per session: every tag on every envelope in this window.
    const tags = projectTagsOf(envelope);
    for (const project of tags.projects) {
      const key = String(project?.key ?? '');
      if (!key) continue;
      if (!row.projects.some((p) => p.key === key)) {
        row.projects.push({ ...project, requests: 0 });
      }
      row.projects.find((p) => p.key === key).requests += 1;
    }
    const primaryKey = tags.primaryProject?.key ?? null;
    if (primaryKey && !row.primaryProjects.includes(primaryKey)) row.primaryProjects.push(primaryKey);
    groups.set(key, row);
  }
  const rows = [...groups.values()].sort((a, b) => {
    const ka = a.firstTs ?? 0;
    const kb = b.firstTs ?? 0;
    if (ka !== kb) return ka - kb;
    return a.windowId.localeCompare(b.windowId);
  });
  for (const row of rows) {
    row.firstTs = row.firstTs === null ? null : new Date(row.firstTs).toISOString();
    row.lastTs = row.lastTs === null ? null : new Date(row.lastTs).toISOString();
    row.methods = Object.fromEntries(Object.entries(row.methods).sort(([a], [b]) => a.localeCompare(b)));
    delete row._windowSortIndex;
  }
  return rows;
}

/** Render a human-readable session digest section for the scorecard. */
export function renderSessionDigest(rows) {
  const tableRows = rows.map((row) => {
    const client = row.clientInfo ? JSON.stringify(row.clientInfo) : '—';
    const ids = row.requestIdSamples.map((id) => `\`${id}\``).join(', ') || '—';
    const projects = (row.projects ?? []).map((p) => `\`${p.key}\``).join(', ') || '—';
    const platforms = (row.clientPlatforms ?? []).join(', ') || '—';
    return `| ${row.windowId} | ${row.strategy} | ${row.sessionId ?? '—'} | ${platforms} | ${row.requests} | ${row.mcpErrors} | ${row.toolCalls} | ${row.truncationSuspects} | ${row.firstTs ?? '—'} | ${row.lastTs ?? '—'} | ${projects} | ${client} | ${ids} |`;
  }).join('\n') || '| — | — | — | — | 0 | 0 | 0 | 0 | — | — | — | — | — |';
  return `## Sessions / windows (batch 11)

> Analysis-only grouping of online capture envelopes. \`windowId\` is synthetic
> when no \`sessionId\` exists; original \`requestId\`/\`sessionId\` are untouched.
> Truncation suspects include gateway wire truncation and advisory model-side
> silent truncation; neither is a verdict. \`projects\` are derived labels and
> are ORTHOGONAL to these windows: one window may touch several projects, and
> one project may span several windows.

| Window | Strategy | SessionId | Platforms | Requests | MCP errors | Tool calls | Trunc suspects | First ts | Last ts | Projects | Client info | RequestId samples |
|---|---|---|---|---:|---:|---:|---:|---|---|---|---|---|
${tableRows}
`;
}

/** Render the cross-session project timeline section (handoff visibility). */
export function renderProjectTimelines(rows) {
  const tableRows = rows.map((row) => {
    const ids = (row.requestIdSamples ?? []).map((id) => `\`${id}\``).join(', ') || '—';
    return `| ${row.projectKey} | ${row.sessionId ?? '—'} | ${row.primaryProjectRequests} | ${row.requests} | ${row.mcpRequests} | ${row.errors} | ${row.toolCalls} | ${row.truncationSuspects} | ${row.firstTs ?? '—'} | ${row.lastTs ?? '—'} | ${ids} |`;
  }).join('\n') || '| — | — | 0 | 0 | 0 | 0 | 0 | 0 | — | — | — |';
  return `## Project timelines (batch 11, cross-session handoff)

> One project key can appear in multiple independent sessions/windows. Rows are
> ordered by first timestamp so a handoff is visible. Project tags are derived
> labels; a shared key does NOT prove the same client or the same task.

| Project | SessionId | Primary requests | Requests | MCP requests | Errors | Tool calls | Trunc suspects | First ts | Last ts | RequestId samples |
|---|---|---:|---:|---:|---:|---:|---:|---|---|---|
${tableRows}
`;
}

/** Aggregate a range of R2 day prefixes into one metrics object. */
export async function aggregateR2Range({ since, days = 7 }) {
  const start = new Date(`${since}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime())) throw new Error(`invalid --since date: ${since}`);
  const keys = [];
  for (let offset = 0; offset < days; offset += 1) {
    const day = new Date(start.getTime() + offset * 86400000).toISOString().slice(0, 10);
    keys.push(...await listR2Keys(`capture/${day}/`));
  }
  const envelopes = await Promise.all(keys.map(readR2Envelope));
  return { days, since, keys: keys.length, metrics: aggregateEnvelopes(envelopes, { date: since }) };
}

/**
 * Envelope bundle I/O (NDJSON). One R2 read per run: the digest writes the
 * envelopes it already fetched, and analyze-captures reuses that file instead
 * of hitting the Cloudflare REST API a second time. NDJSON keeps memory flat
 * and lets the analyzer stream-read.
 */
export function encodeEnvelopeBundle(envelopes) {
  return arr2(envelopes).map((envelope) => JSON.stringify(envelope)).join('\n') + (arr2(envelopes).length ? '\n' : '');
}

export async function writeEnvelopeBundle(file, envelopes) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, encodeEnvelopeBundle(envelopes), 'utf8');
  return arr2(envelopes).length;
}

export async function readEnvelopeBundle(file) {
  const text = await readFile(file, 'utf8');
  const rows = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    rows.push(JSON.parse(trimmed));
  }
  return rows;
}

const arr2 = (value) => (Array.isArray(value) ? value : []);

/** Keys for a rolling window (same day math as analyze-captures --last-minutes). */
function windowKeys(lastMinutes) {
  const now = new Date();
  const start = new Date(now.getTime() - lastMinutes * 60 * 1000);
  const days = new Set([start.toISOString().slice(0, 10), now.toISOString().slice(0, 10)]);
  return [...days].sort();
}

async function main() {
  const args = process.argv.slice(2);
  const arg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : '');
  const date = arg('--date') || new Date().toISOString().slice(0, 10);
  const dir = arg('--dir');
  const out = arg('--out') || join('docs', 'eval');
  const since = arg('--since');
  const days = Number(arg('--days') || 7);
  const lastMinutes = Number(arg('--last-minutes') || 0);
  const bundleOut = arg('--bundle-out');

  let payload;
  let label = date;
  let envelopes = null;

  if (lastMinutes > 0) {
    // Rolling window: read ONCE, then aggregate/sessions/bundle from the same
    // batch. Older code re-listed and re-fetched every envelope a second time.
    const keys = [];
    for (const day of windowKeys(lastMinutes)) keys.push(...await listR2Keys(`capture/${day}/`));
    envelopes = await Promise.all(keys.map(readR2Envelope));
    label = `last-${lastMinutes}m`;
    payload = { metrics: aggregateEnvelopes(envelopes, { date: label }) };
  } else if (since) {
    payload = await aggregateR2Range({ since, days });
    label = `${since}+${days}d`;
  } else if (dir) {
    envelopes = await readDirEnvelopes(dir);
    payload = { metrics: aggregateEnvelopes(envelopes, { date }) };
  } else {
    const keys = await listR2Keys(`capture/${date}/`);
    envelopes = await Promise.all(keys.map(readR2Envelope));
    payload = { metrics: aggregateEnvelopes(envelopes, { date }) };
  }

  if (bundleOut && envelopes) {
    const written = await writeEnvelopeBundle(bundleOut, envelopes);
    console.log(`[digest] bundle -> ${bundleOut} (${written} envelopes)`);
  }

  const metrics = payload.metrics;
  // Sessions/projects reuse the SAME envelopes when we have them; only the
  // legacy --since range path still needs its own read.
  let digestRows = [];
  let projectTimelines = [];
  try {
    let allEnvelopes = envelopes;
    if (!allEnvelopes) {
      if (since) {
        const start = new Date(`${since}T00:00:00.000Z`);
        const keys = [];
        for (let offset = 0; offset < days; offset += 1) {
          const day = new Date(start.getTime() + offset * 86400000).toISOString().slice(0, 10);
          keys.push(...await listR2Keys(`capture/${day}/`));
        }
        allEnvelopes = await Promise.all(keys.map(readR2Envelope));
      } else {
        allEnvelopes = await Promise.all((await listR2Keys(`capture/${date}/`)).map(readR2Envelope));
      }
    }
    digestRows = digestSessions(allEnvelopes);
    projectTimelines = metrics.projectTimelines ?? [];
  } catch (error) {
    console.error(`[digest] session aggregation skipped: ${error?.message ?? String(error)}`);
  }
  await mkdir(out, { recursive: true });
  await writeFile(join(out, `scorecard-${label}.md`), renderScorecard(label, metrics) + '\n' + renderSessionDigest(digestRows) + '\n' + renderProjectTimelines(projectTimelines), 'utf8');
  await writeFile(join(out, `scorecard-${label}.json`), JSON.stringify({
    date: label, ...payload, sessions: digestRows,
    byProject: metrics.byProject ?? {},
    projectTimelines,
  }, null, 2), 'utf8');
  console.log(`[digest] ${label}: ${metrics.requests} requests, ${metrics.errors} errors, ${digestRows.length} sessions/windows, ${Object.keys(metrics.byProject ?? {}).length} projects -> ${out}`);
}

if (process.argv[1] && process.argv[1].endsWith('capture-digest.mjs')) {
  main().catch((error) => {
    console.error(`[digest] failed: ${error?.message ?? String(error)}`);
    process.exitCode = 1;
  });
}
