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
 */
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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

export async function listR2Keys(prefix) {
  const url = `${r2Endpoint()}?prefix=${encodeURIComponent(prefix)}`;
  const response = await fetch(url, { headers: r2AuthHeaders() });
  if (!response.ok) throw new Error(`R2 list failed: ${response.status}`);
  const body = await response.json();
  return (body.result ?? []).map((item) => item.key).filter((key) => key.endsWith('.json.gz'));
}

export async function readR2Envelope(key) {
  const response = await fetch(r2Endpoint(key), { headers: r2AuthHeaders() });
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

/** True when a response was truncated, flagged by capture or by an explicit wire marker. */
export function isTruncated(envelope) {
  if (envelope?.response?.truncated === true) return true;
  const raw = `${String(envelope?.response?.raw ?? '')} ${String(envelope?.response?.error ?? '')}`;
  // Only explicit wire markers count; an ordinary word "truncated" in user code is noise.
  return /--- TRUNCATED ---|…\[truncated\s*\d*\]|(?:^|["'\s])truncated["'\s]*:/i.test(raw);
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

    for (const key of keys) {
      const row = byProject.get(key) ?? blankProjectRow(key);
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
      };
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
  };
  const upstreamGroups = new Map();
  const toolGroups = new Map();
  const routeGroups = new Map();

  for (const envelope of envelopes) {
    const status = Number(envelope?.response?.status ?? 0);
    let path = '/';
    try { path = new URL(String(envelope?.request?.url ?? '/'), 'http://localhost').pathname; } catch { /* keep default */ }
    const method = String(envelope?.request?.method ?? 'POST').toUpperCase();
    const isMcp = path === '/mcp' && method === 'POST';
    if (isMcp) result.mcpRequests += 1;
    else result.nonMcpRequests += 1;
    result.statuses[status] = (result.statuses[status] ?? 0) + 1;
    result.durations.push(Number(envelope?.response?.durationMs ?? 0));
    result.bytes += Number(envelope?.response?.bytes ?? 0);

    const truncated = isTruncated(envelope);
    const overflow = envelope?.response?.overflow === true;
    const modelSuspect = isModelTruncationSuspect(envelope);
    if (truncated) result.truncated += 1;
    if (overflow) result.overflow += 1;
    if (modelSuspect) result.model_truncation_suspects += 1;

    const session = envelope?.sessionId ?? envelope?.request?.sessionId ?? null;
    if (modelSuspect) bumpHistogram(result.modelTruncationBySession, session ?? 'unknown');

    const { date: day, hour } = timeParts(envelope);
    bumpHistogram(result.byDay, day);
    bumpHistogram(result.byHour, hour);
    bumpHistogram(result.byDayHour, `${day}T${hour}`);

    const routeKey = isMcp ? 'POST /mcp' : `${method} ${path}`;
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

  // Keep a stable, human-friendly order in JSON output.
  for (const key of ['byDay', 'byDayHour', 'byHour', 'statuses', 'errorClasses', 'routeErrors', 'upstreamStats', 'toolStats', 'byRoute', 'modelTruncationByServer', 'modelTruncationByTool', 'modelTruncationBySession']) {
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
      return `| ${key} | ${p.requests} | ${p.mcpRequests} | ${p.errors} | ${p.toolCalls} | ${p.truncationSuspects} | ${p.firstTs ?? '—'} | ${p.lastTs ?? '—'} | ${sessions} | ${ids} |`;
    }).join('\n') || '| — | 0 | 0 | 0 | 0 | 0 | — | — | — | — |';
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

| Project | Requests | MCP requests | Errors | Tool calls | Trunc suspects | First ts | Last ts | SessionIds | RequestId samples |
|---|---:|---:|---:|---:|---:|---|---|---|---|
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
    };
    row.requests += 1;
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
    return `| ${row.windowId} | ${row.strategy} | ${row.sessionId ?? '—'} | ${row.requests} | ${row.mcpErrors} | ${row.toolCalls} | ${row.truncationSuspects} | ${row.firstTs ?? '—'} | ${row.lastTs ?? '—'} | ${projects} | ${client} | ${ids} |`;
  }).join('\n') || '| — | — | — | 0 | 0 | 0 | 0 | — | — | — | — | — |';
  return `## Sessions / windows (batch 11)

> Analysis-only grouping of online capture envelopes. \`windowId\` is synthetic
> when no \`sessionId\` exists; original \`requestId\`/\`sessionId\` are untouched.
> Truncation suspects include gateway wire truncation and advisory model-side
> silent truncation; neither is a verdict. \`projects\` are derived labels and
> are ORTHOGONAL to these windows: one window may touch several projects, and
> one project may span several windows.

| Window | Strategy | SessionId | Requests | MCP errors | Tool calls | Trunc suspects | First ts | Last ts | Projects | Client info | RequestId samples |
|---|---|---|---:|---:|---:|---:|---|---|---|---|---|
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

async function main() {
  const args = process.argv.slice(2);
  const arg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : '');
  const date = arg('--date') || new Date().toISOString().slice(0, 10);
  const dir = arg('--dir');
  const out = arg('--out') || join('docs', 'eval');
  const since = arg('--since');
  const days = Number(arg('--days') || 7);

  let payload;
  let label = date;
  if (since) {
    payload = await aggregateR2Range({ since, days });
    label = `${since}+${days}d`;
  } else {
    const envelopes = dir ? await readDirEnvelopes(dir) : (await listR2Keys(`capture/${date}/`)).map(readR2Envelope);
    const resolved = dir ? envelopes : await Promise.all(envelopes);
    payload = { metrics: aggregateEnvelopes(resolved, { date }) };
  }
  const metrics = payload.metrics;
  // Resolve the envelopes once more for session/window aggregation. R2 mode
  // already fetched them; keep a local cache by reusing range payload keys when
  // present to avoid a second network round-trip where possible.
  let digestRows = [];
  let projectTimelines = [];
  try {
    let allEnvelopes = [];
    if (dir) {
      allEnvelopes = await readDirEnvelopes(dir);
    } else if (since) {
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
