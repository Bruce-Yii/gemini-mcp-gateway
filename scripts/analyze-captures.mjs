/**
 * Offline capture analyzer: deterministic digest -> free model -> validated JSON.
 *
 * Usage:
 *   ANALYZER_API_KEY=... node scripts/analyze-captures.mjs --date 2026-11-22
 *   node scripts/analyze-captures.mjs --dir work/capture --dry-run
 *   node scripts/analyze-captures.mjs --since 2026-11-16 --days 7 --dry-run --out work/weekly
 *
 * The model never runs in the gateway path and never gets tools; it only labels
 * clusters and proposes issue drafts. The validator is the source of truth and
 * is intentionally unchanged: all model output stays advisory-only.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  listR2Keys, readR2Envelope, readDirEnvelopes, aggregateEnvelopes, classifyError,
  isTruncated, isModelTruncationSuspect, upstreamOf, digestSessions, digestProjects,
  clientPlatformOf, clientProfileOf, protocolVersionOf, executorOf,
  buildCommitOf, serversOf, evalModeOf, UNKNOWN_BUCKET,
} from './capture-digest.mjs';
import { redactSecrets } from '../src/execution/tool-format.js';

const MAX_CODE = 2000;
const MAX_ERROR = 1000;
// Success-state blind spot: the analyzer used to see only code/status/subCalls,
// so HTTP-200 semantic friction (number:null, double nesting, silent no-op
// writes) was invisible. These caps keep the additive response outline small
// and deterministic: a bounded preview plus a one-level structural outline.
const MAX_RESPONSE_PREVIEW = 500;
const MAX_SHAPE_KEYS = 10;
const MAX_NESTED_KEYS = 8;
const MAX_SHAPE_ENTRIES = 10;
const MAX_SUBCALL_ERROR_NAME = 80;
const MAX_SUBCALL_ERROR_MESSAGE = 300;

function truncate(value, limit) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) return null;
  return text.length > limit ? `${text.slice(0, limit)}…[truncated ${text.length - limit}]` : text;
}

function requestJson(envelope) {
  try { return JSON.parse(String(envelope?.request?.raw ?? '')); } catch { return null; }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Lightweight, deterministic structural outline of a parsed JSON value.
 *
 * It deliberately exposes COUNTS and KEY NAMES only (never values): top-level
 * keys, top-level null fields, top-level array lengths and ONE level of child
 * keys for top-level objects / arrays-of-objects. Bounded by the MAX_* caps so
 * a large upstream payload cannot bloat the analyzer prompt.
 */
function shapeOf(value) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    const first = value.length && isPlainObject(value[0]) ? value[0] : null;
    return {
      kind: 'array',
      length: value.length,
      itemKeys: first ? Object.keys(first).slice(0, MAX_NESTED_KEYS) : [],
    };
  }
  if (typeof value !== 'object') {
    return typeof value === 'string' ? { kind: 'string', length: value.length } : { kind: typeof value };
  }
  const keys = Object.keys(value);
  const nullKeys = [];
  const arrays = {};
  const nested = {};
  let arrayEntries = 0;
  let nestedEntries = 0;
  for (const key of keys) {
    const item = value[key];
    if (item === null) {
      if (nullKeys.length < MAX_SHAPE_ENTRIES) nullKeys.push(key);
      continue;
    }
    if (Array.isArray(item)) {
      if (arrayEntries < MAX_SHAPE_ENTRIES) {
        arrays[key] = item.length;
        arrayEntries += 1;
      }
      const first = item.length && isPlainObject(item[0]) ? item[0] : null;
      if (first && nestedEntries < MAX_NESTED_KEYS) {
        nested[key] = Object.keys(first).slice(0, MAX_NESTED_KEYS);
        nestedEntries += 1;
      }
      continue;
    }
    if (isPlainObject(item) && nestedEntries < MAX_NESTED_KEYS) {
      nested[key] = Object.keys(item).slice(0, MAX_NESTED_KEYS);
      nestedEntries += 1;
    }
  }
  return {
    topLevelKeys: keys.slice(0, MAX_SHAPE_KEYS),
    keyCount: keys.length,
    nullKeys,
    arrays,
    nested,
  };
}

/**
 * Bounded preview of the captured success response body plus its parsed
 * outline. Parse failures keep only the preview (no inference from a partial
 * body). `preview` is capped at MAX_RESPONSE_PREVIEW characters and carries the
 * existing explicit truncation marker, so it is never a silent cut.
 */
function responsePreviewOf(envelope) {
  const raw = envelope?.response?.raw;
  const original = typeof raw === 'string' ? raw : '';
  if (!original) return { preview: null };
  // This preview is model-visible. Keep the same secret-shape redaction as
  // model-facing errors even though the HTTP status was 200.
  const preview = truncate(redactSecrets(original), MAX_RESPONSE_PREVIEW);
  let parsed;
  try { parsed = JSON.parse(original); } catch { return { preview, parseError: true }; }
  return { preview, ...(shapeOf(parsed) ?? {}) };
}

/** Sub-call error keeps only name/message (stack and raw text are dropped). */
function subCallError(error) {
  if (typeof error === 'string') {
    return { name: null, message: truncate(redactSecrets(error), MAX_SUBCALL_ERROR_MESSAGE) };
  }
  if (error && typeof error === 'object') {
    return {
      name: typeof error.name === 'string' && error.name.trim()
        ? truncate(redactSecrets(error.name), MAX_SUBCALL_ERROR_NAME)
        : null,
      message: typeof error.message === 'string' && error.message.trim()
        ? truncate(redactSecrets(error.message), MAX_SUBCALL_ERROR_MESSAGE)
        : null,
    };
  }
  return { name: null, message: truncate(String(error), MAX_SUBCALL_ERROR_MESSAGE) };
}

/** Deterministic per-day rollup used as cross-day trend evidence. */
export function dailyTrend(envelopes) {
  const byDate = new Map();
  for (const envelope of envelopes) {
    const raw = envelope?.ts ?? envelope?.timestamp ?? '';
    const day = typeof raw === 'string' && raw.length >= 10 ? raw.slice(0, 10) : 'unknown';
    const list = byDate.get(day) ?? [];
    list.push(envelope);
    byDate.set(day, list);
  }
  return [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, list]) => {
    const m = aggregateEnvelopes(list, { date });
    return {
      date,
      requests: m.requests,
      mcpRequests: m.mcpRequests,
      errors: m.errors,
      errorRate: m.errorRate,
      p50Ms: m.p50Ms,
      p95Ms: m.p95Ms,
      truncated: m.truncated,
      overflow: m.overflow,
    };
  });
}

export function buildAnalyzerInput(envelopes, { date = 'unknown', maxClusters = 10, trend = null, filters = null } = {}) {
  const mcpOnly = envelopes.filter((envelope) => {
    try {
      const path = new URL(String(envelope?.request?.url ?? '/mcp'), 'http://localhost').pathname;
      const method = String(envelope?.request?.method ?? 'POST').toUpperCase();
      return (path === '/mcp' || path === '/mcp/v2') && method === 'POST';
    } catch { return true; }
  });
  const metrics = aggregateEnvelopes(mcpOnly, { date });
  // Eval closure: an empty filtered window is NOT "healthy". Distinguish it so
  // the analyzer cannot report "0 issues" as if no data were the same thing.
  const dataStatus = mcpOnly.length === 0 ? 'EMPTY_WINDOW' : 'HAS_DATA';
  const groups = new Map();
  const candidateSamples = [];
  for (const envelope of mcpOnly) {
    const req = requestJson(envelope);
    if (req?.method === 'tools/call') {
      const sandbox = (envelope.events ?? []).find((event) => event.type === 'sandbox');
      const upstreamEvents = (envelope.events ?? []).filter((event) => event?.type === 'upstream');
      const subCalls = upstreamEvents.slice(0, 20).map((event) => ({
        server: upstreamOf({ events: [event] }, event?.payload?.tool),
        tool: event?.payload?.tool ?? null,
        ok: event?.payload?.ok ?? null,
        durationMs: Number(event?.payload?.durationMs ?? 0),
        // Additive: success-state shape of the upstream result (keys/counts only)
        // and the name/message of a failed sub-call. Both stay bounded.
        error: event?.payload?.error == null ? null : subCallError(event.payload.error),
        resultShape: event?.payload?.result === undefined ? null : shapeOf(event.payload.result),
      }));
      const status = Number(envelope?.response?.status ?? 0);
      const durationMs = Number(envelope?.response?.durationMs ?? 0);
      const truncated = isTruncated(envelope);
      const priority = (status >= 400 ? 1000 : 0) + (truncated ? 500 : 0) + (subCalls.length * 20) + Math.min(400, Math.floor(durationMs / 50));
      candidateSamples.push({
        priority,
        sample: {
          id: envelope.requestId,
          ts: envelope.ts ?? null,
          clientPlatform: clientPlatformOf(envelope),
          clientProfile: clientProfileOf(envelope),
          protocolVersion: protocolVersionOf(envelope),
          executor: executorOf(envelope),
          evalMode: envelope.evalMode ?? null,
          buildCommit: envelope.deployment?.commit ?? null,
          servers: Array.isArray(envelope.servers) && envelope.servers.length
            ? envelope.servers
            : [...new Set(subCalls.map((c) => c.server).filter((s) => s && s !== 'unknown'))],
          tool: req.params?.name ?? null,
          code: truncate(req.params?.arguments?.code ?? sandbox?.payload?.code, MAX_CODE),
          status,
          durationMs,
          bytes: Number(envelope?.response?.bytes ?? 0),
          sandboxTools: sandbox?.payload?.output?.toolCalls?.length ?? subCalls.length,
          subCalls,
          responsePreview: responsePreviewOf(envelope),
          truncated,
        },
      });
    }
  }
  const samples = candidateSamples
    .sort((a, b) => b.priority - a.priority)
    .slice(0, 15)
    .map((entry) => entry.sample);
  // Per-upstream denominator comes from upstream EVENTS, not from MCP params.name
  // (execute_read / execute are gateway tools, not upstream servers). One MCP call
  // can touch several upstreams, so each event contributes one call.
  const upstreamCalls = new Map();
  for (const envelope of mcpOnly) {
    const req = requestJson(envelope);
    const callName = req?.params?.name;
    const upstreamEvents = (envelope.events ?? []).filter((event) => event?.type === 'upstream');
    const servers = upstreamEvents.length
      ? upstreamEvents.map((event) => upstreamOf({ events: [event] }, event?.payload?.tool ?? callName))
      : [upstreamOf(envelope, callName)];
    const status = Number(envelope?.response?.status ?? 0);
    const raw = String(envelope?.response?.raw ?? '');
    const failed = status >= 400 || /"isError":true|execute error/i.test(raw);
    for (const server of servers) {
      const row = upstreamCalls.get(server) ?? { calls: 0, errors: 0, sampleEventIds: [] };
      row.calls += 1;
      if (failed) {
        row.errors += 1;
        if (row.sampleEventIds.length < 5) row.sampleEventIds.push(envelope.requestId);
      }
      upstreamCalls.set(server, row);
    }
  }

  for (const envelope of mcpOnly) {
    const status = Number(envelope?.response?.status ?? 0);
    const raw = String(envelope?.response?.raw ?? '');
    if (status < 400 && !/"isError":true|execute error/i.test(raw)) continue;
    const req = requestJson(envelope);
    const sandbox = (envelope.events ?? []).find((event) => event.type === 'sandbox');
    const upstream = (envelope.events ?? []).find((event) => event.type === 'upstream');
    const tool = upstream?.payload?.tool ?? req?.params?.name ?? sandbox?.payload?.tool ?? 'unknown';
    const server = upstreamOf(envelope, tool);
    const errorClass = classifyError(envelope);
    const key = `${errorClass}:${server}:${tool}`;
    const group = groups.get(key) ?? {
      id: `c${groups.size + 1}`,
      errorClass, server, tool, count: 0,
      sampleEventIds: [], sampleCode: null,
      sampleError: truncate(raw || sandbox?.payload?.output || `HTTP ${status}`, MAX_ERROR),
      durationMs: [],
    };
    group.count += 1;
    if (group.sampleEventIds.length < 5) group.sampleEventIds.push(envelope.requestId);
    group.durationMs.push(Number(envelope?.response?.durationMs ?? 0));
    group.sampleCode = group.sampleCode ?? truncate(req?.params?.arguments?.code ?? sandbox?.payload?.code, MAX_CODE);
    groups.set(key, group);
  }

  const upstreamErrorRates = [...upstreamCalls.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([server, row]) => ({
      server,
      calls: row.calls,
      errors: row.errors,
      errorRate: row.calls ? Math.round((row.errors / row.calls) * 10000) / 10000 : 0,
      sampleEventIds: row.sampleEventIds,
    }));

  // Independent model-side silent-truncation cluster (batch 11). Advisory only:
  // this is a deterministic flag stamped at capture time, never a verdict about
  // content. It stays separate from error clusters and from gateway truncation.
  // Each entry keeps its requestId AND sessionId so a reviewer can go straight
  // back to the raw R2 envelope (see batch-11 ledger doc for the replay steps).
  const truncationSuspects = [];
  for (const envelope of mcpOnly) {
    if (!isModelTruncationSuspect(envelope)) continue;
    const req = requestJson(envelope);
    const upstream = (envelope.events ?? []).find((event) => event?.type === 'upstream');
    const sandbox = (envelope.events ?? []).find((event) => event?.type === 'sandbox');
    const tool = upstream?.payload?.tool ?? req?.params?.name ?? sandbox?.payload?.tool ?? 'unknown';
    truncationSuspects.push({
      requestId: envelope.requestId ?? null,
      sessionId: envelope.sessionId ?? envelope?.request?.sessionId ?? null,
      server: upstreamOf(envelope, tool),
      tool,
      sourceBytes: Number(envelope?.model?.sourceBytes ?? 0),
      modelOutputBytes: Number(envelope?.model?.modelOutputBytes ?? 0),
      modelOutputLength: Number(envelope?.model?.modelOutput?.length ?? 0),
      modelOutputSha256: envelope?.model?.modelOutput?.sha256 ?? null,
      modelOutputSummary: truncate(envelope?.model?.modelOutput?.summary ?? '', MAX_ERROR),
    });
  }
  // Expose the suspect ids as a cluster so validateAnalyzerOutput()'s existing
  // evidence whitelist accepts them WITHOUT any validator change.
  const truncationCluster = truncationSuspects.length
    ? [{
        id: `model-truncation-${truncationSuspects.length}`,
        kind: 'model_truncation_suspect',
        advisoryOnly: true,
        errorClass: 'model_truncation_suspect',
        server: 'multiple',
        tool: 'multiple',
        count: truncationSuspects.length,
        sampleEventIds: truncationSuspects.slice(0, 20).map((suspect) => suspect.requestId).filter(Boolean),
        sampleError: 'Model-visible output materially shorter than source with no truncation marker (advisory).',
        durationMs: [],
      }]
    : [];

  // Additive (batch 11): per-session/window digest of ALL envelopes (not just
  // mcpOnly). Deterministic, advisory-only: windowId is a clustering artifact,
  // never a client/SDK-provided fact. Each row keeps requestId samples so the
  // free model can cite raw envelopes for human replay.
  const sessionWindows = digestSessions(envelopes);

  // Additive (batch 11, project rollup): project tags are DERIVED labels
  // computed deterministically at capture time from explicit owner/repo pairs,
  // never client-declared repository identities. They are orthogonal to
  // sessions: one project may span several sessions (handoff) and one session
  // may touch several projects. Kept advisory-only; no validator change.
  const projectRollup = digestProjects(envelopes);
  const projectSummary = {
    projects: projectRollup.byProject.length,
    requestsWithProjects: projectRollup.byProject.reduce((sum, row) => sum + row.requests, 0),
    multiProjectSessions: sessionWindows.filter((row) => (row.projects ?? []).length > 1).length,
    handoffProjects: new Set(projectRollup.projectTimelines
      .map((row) => row.projectKey)
      .filter((key) => projectRollup.projectTimelines.filter((r) => r.projectKey === key).length > 1)).size,
  };

  // M4-A: additive four-dimension summary, computed from the SAME explicit
  // fields as the digest (clientPlatform × protocolVersion × clientProfile ×
  // buildCommit). Buckets are independent; the analyzer prompt is told never to
  // compare across them or across builds.
  const dimensions = {
    byClientPlatform: metrics.platformSummary ?? [],
    byProtocolVersion: metrics.byProtocolVersion ?? {},
    byClientProfile: metrics.byClientProfile ?? {},
    byBuildCommit: metrics.byBuildCommit ?? {},
    byEvalMode: metrics.byEvalMode ?? {},
    byServerTag: metrics.byServerTag ?? {},
    multiServerRequests: metrics.multiServerRequests ?? 0,
    byFourDimension: metrics.fourDimensionSummary ?? [],
    unknownBucket: UNKNOWN_BUCKET,
  };

  // Eval closure (G3): full request index for the filtered window. Unlike
  // `samples` (top 15) and per-bucket requestIdSamples (top 5), this is NOT
  // sampled, so active/passive comparison can prove requestId membership
  // without suffering false negatives from the sample cap.
  const requestIndex = mcpOnly.map((envelope) => {
    const request = requestJson(envelope);
    return {
      id: String(envelope?.requestId ?? envelope?.request?.id ?? envelope?.id ?? 'unknown'),
      ts: envelope?.ts ?? null,
      clientPlatform: clientPlatformOf(envelope),
      clientProfile: clientProfileOf(envelope),
      protocolVersion: protocolVersionOf(envelope),
      buildCommit: buildCommitOf(envelope),
      method: request?.method ?? null,
      tool: request?.params?.name ?? null,
      status: Number(envelope?.response?.status ?? 0),
      durationMs: Number(envelope?.response?.durationMs ?? 0),
      servers: serversOf(envelope),
    };
  }).sort((a, b) => String(a.ts ?? '').localeCompare(String(b.ts ?? '')) || a.id.localeCompare(b.id));

  return {
    schema: 'analyzer-input.v1',
    date,
    dataStatus,
    filters: filters ?? null,
    // Full-window request index (id/ts/platform/build/tool/servers). Not sampled.
    requestIndex,
    dimensions,
    // Eval closure: deterministic, non-model signals that make offline /
    // needsReauth / connect failures visible to the passive lane.
    connectFailures: metrics.upstreamConnect ?? { failures: 0, byServer: {} },
    serviceState: metrics.serviceState ?? { snapshots: 0, byServer: {} },
    helperCalls: metrics.helperStats ?? [],
    sessionWindows,
    sessionWindowsNote: 'Advisory clustering: sessionId when present, otherwise initialize / 15-min idle windows. windowId is analysis-only; cite requestId samples for replay. Do not treat cluster boundaries as verified client sessions.',
    // Project-level views (additive, advisory-only).
    projectWindows: projectRollup.projectTimelines,
    projectSummary,
    projectNote: 'Projects are DERIVED labels from deterministic capture-time extraction of explicit owner/repo pairs (envelope.projects / primaryProject), not client-declared identities. One request may carry several tags and one project may span several sessions. Treat shared project keys as a grouping hint only — never as proof of the same client or task. Cite requestId samples for replay.',
    metrics: {
      requests: metrics.requests,
      errors: metrics.errors,
      p95Ms: metrics.p95Ms,
      topErrorClasses: metrics.errorClasses,
      truncationRate: metrics.truncationRate,
      overflowRate: metrics.overflowRate,
    },
    // Additive: present whenever multi-day data is supplied; null/undefined otherwise.
    trend: trend ?? null,
    upstreamErrorRates,
    // Independent, advisory-only model-side silent-truncation cluster/suspects.
    truncationSuspects,
    clusters: [
      ...[...groups.values()].sort((a, b) => b.count - a.count).slice(0, maxClusters),
      ...truncationCluster,
    ],
    samples,
    limits: { maxIssues: 5, maxCharsPerIssue: 1200 },
  };
}

const CATEGORIES = new Set(['gateway', 'upstream', 'model', 'data', 'unknown']);
const SEVERITIES = new Set(['P0', 'P1', 'P2', 'P3']);

/**
 * G4: an empty filtered window must never reach the model and must never look
 * like a clean analysis. Produces a deterministic, non-model output artifact.
 */
export function buildEmptyWindowAnalyzerOutput(input) {
  return {
    schema: 'analyzer-output.v1',
    policy: 'free-model-advisory-v1',
    advisoryOnly: true,
    requiresHumanReview: true,
    dataStatus: 'EMPTY_WINDOW',
    summary: 'EMPTY_WINDOW: no MCP requests matched the filters; this is NOT_ENOUGH evidence, not a pass.',
    issues: [],
    ignored: [{
      clusterId: 'empty-window',
      reason: 'No MCP requests in the filtered window; the model was not called and no conclusion may be drawn.',
    }],
  };
}

export function validateAnalyzerOutput(output, input) {
  const evidenceIds = new Set([
    ...input.clusters.flatMap((cluster) => cluster.sampleEventIds),
    ...(input.samples ?? []).map((sample) => sample.id),
  ]);
  const issues = [];
  for (const issue of Array.isArray(output?.issues) ? output.issues : []) {
    if (!issue || typeof issue !== 'object') continue;
    if (!SEVERITIES.has(issue.severity) || !CATEGORIES.has(issue.category)) continue;
    if (typeof issue.title !== 'string' || !issue.title.trim()) continue;
    const ids = Array.isArray(issue.evidenceEventIds)
      ? issue.evidenceEventIds.filter((id) => evidenceIds.has(id))
      : [];
    if (ids.length === 0) continue;
    issues.push({
      id: String(issue.id ?? `issue-${issues.length + 1}`),
      severity: issue.severity,
      category: issue.category,
      title: truncate(issue.title, 300),
      evidenceEventIds: ids.slice(0, 5),
      likelyCause: truncate(issue.likelyCause ?? '', 800),
      suggestedFix: truncate(issue.suggestedFix ?? '', 1200),
      confidence: Number.isFinite(Number(issue.confidence)) ? Number(issue.confidence) : null,
      // Optional attribution (blind-spot fix). Unknown types are dropped, never
      // a reason to discard the issue: missing attribution becomes null / [].
      clientPlatform: typeof issue.clientPlatform === 'string' && issue.clientPlatform.trim()
        ? truncate(issue.clientPlatform.trim(), 40)
        : null,
      servers: Array.isArray(issue.servers)
        ? [...new Set(issue.servers
          .filter((server) => typeof server === 'string' && server.trim())
          .map((server) => truncate(server.trim(), 60)))].slice(0, 8)
        : [],
      regressionTask: issue.regressionTask ?? null,
    });
    if (issues.length >= (input.limits?.maxIssues ?? 5)) break;
  }
  return {
    schema: 'analyzer-output.v1',
    policy: 'free-model-advisory-v1',
    advisoryOnly: true,
    requiresHumanReview: true,
    dataStatus: input?.dataStatus ?? null,
    summary: truncate(output?.summary ?? '', 500),
    issues,
    ignored: Array.isArray(output?.ignored) ? output.ignored.slice(0, 20) : [],
  };
}

/** ISO week key (YYYY-WW, zero padded) in UTC. */
export function isoWeek(dateString) {
  const date = new Date(`${String(dateString).slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) throw new Error(`invalid date for ISO week: ${dateString}`);
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((target - yearStart) / 86400000) + 1) / 7);
  return `${target.getUTCFullYear()}-${String(week).padStart(2, '0')}`;
}

/**
 * Weekly review renderer: candidate-only, evidence-id-only, advisory-only.
 * It deliberately emits no code patches, no issue creation, no auto-actions.
 */
export function renderWeeklyReview({ week, since, days = 7, trend = [], candidates = [], totals = {} }) {
  const trendRows = trend.map((row) => `| ${row.date} | ${row.requests} | ${row.errors} | ${row.errorRate} | ${row.p95Ms} | ${row.truncated} |`).join('\n') || '| — | 0 | 0 | 0 | 0 | 0 |';
  const candidateRows = candidates.map((candidate, index) => {
    const ids = (candidate.evidenceEventIds ?? []).slice(0, 5).map((id) => `\`${id}\``).join(', ') || '—';
    return `| W${index + 1} | ${candidate.severity ?? 'P3'} | ${candidate.category ?? 'unknown'} | ${String(candidate.title ?? 'candidate').slice(0, 160)} | ${ids} |`;
  }).join('\n') || '| — | — | — | no candidates | — |';
  return `# Weekly Capture Review — ${week}

> Generated by \`scripts/analyze-captures.mjs\`. Window: ${since} + ${days} days (UTC).
> **Advisory only.** Candidate issues are unverified hypotheses; no code changes and no GitHub issues are created by this job.

## Totals
| Requests | MCP requests | Errors | Error rate | Truncated | Overflow |
|---:|---:|---:|---:|---:|---:|
| ${totals.requests ?? 0} | ${totals.mcpRequests ?? 0} | ${totals.errors ?? 0} | ${totals.errorRate ?? 0} | ${totals.truncated ?? 0} | ${totals.overflow ?? 0} |

## Cross-day trend
| Day | Requests | Errors | Error rate | p95 ms | Truncated |
|---|---:|---:|---:|---:|---:|
${trendRows}

## Candidates (human review required)
| ID | Severity | Category | Candidate | Evidence requestId |
|---|---|---|---|---|
${candidateRows}

## Review gate
- [ ] Each \`evidenceEventIds\` resolves to a raw capture envelope in R2.
- [ ] Reproduce locally with the same code / args / fixtures before any fix.
- [ ] Add a deterministic regression test first; merge only after human approval.
- [ ] No automatic issue / PR / code change / deploy from this report.
`;
}

export function analyzerPrompt(input) {
  const trendHint = Array.isArray(input.trend) && input.trend.length > 1
    ? 'Cross-day trend and per-upstream error rates are included; only flag a trend if the evidence ids support it.'
    : '';
  const truncationHint = Array.isArray(input.truncationSuspects) && input.truncationSuspects.length
    ? 'truncationSuspects / the model_truncation_suspect cluster are advisory, byte-based hints that the model saw a shorter, unmarked projection while the gateway wire was complete. Do NOT classify them as gateway errors or overflow; cite their requestId only if you want to raise a candidate for human replay.'
    : '';
  const sessionHint = Array.isArray(input.sessionWindows) && input.sessionWindows.length
    ? 'sessionWindows are deterministic clustering of online captures for offline join only. windowId is synthetic when sessionId is absent; do not claim two windows are the same client session, and do not use cluster boundaries as evidence of a bug.'
    : '';
  const projectHint = input.projectSummary && input.projectSummary.projects > 0
    ? 'projectWindows / projectSummary group captures by project key, which is a DERIVED label extracted deterministically from explicit owner/repo arguments or code literals at capture time — NOT a client-declared or verified repository identity. Projects are orthogonal to sessions: the same project key may appear in several sessions (handoff), and one session may touch several projects. Do not claim a shared project key proves the same client, task, or root cause; cite requestId samples for replay.'
    : '';
  const dimensionHint = input.dimensions
    ? 'dimensions.byFourDimension / byProtocolVersion / byClientProfile / byBuildCommit / byEvalMode are INDEPENDENT buckets. Never compare metrics across buckets, and never hard-compare across builds (cross-build hard comparison is forbidden). Treat unknown as a real bucket, not as a missing value to be guessed.'
    : '';
  const dataStatusHint = input.dataStatus === 'EMPTY_WINDOW'
    ? 'dataStatus is EMPTY_WINDOW: the filter matched zero requests. Say exactly that and return no issues; an empty window is NOT evidence that the gateway is healthy (do not report "no problems" as a pass).'
    : '';
  const serviceStateHint = (input.connectFailures?.failures > 0 || input.serviceState?.snapshots > 0)
    ? 'connectFailures and serviceState are DETERMINISTIC capture signals: upstream_connect{ok:false} means an upstream failed to connect, and serviceState rows with latest.status=offline / latest.needsReauth=true mean the gateway itself reported that service as unavailable (latest is the last snapshot; statuses counts are historical). Cite these only with their requestId samples; do not treat a cold-start snapshot as a live health check.'
    : '';
  // Blind-spot fix: samples now carry the success-response outline, so the model
  // can reason about HTTP-200 semantic friction that no error cluster shows.
  const responsePreviewHint = Array.isArray(input.samples) && input.samples.length
    ? 'Each sample also carries responsePreview: a bounded preview (first characters, with an explicit truncation marker) of the captured HTTP response body plus a parsed outline (topLevelKeys / nullKeys / arrays / nested one-level keys) and subCalls[] entries may carry error{name,message} or resultShape. Combine responsePreview + subCalls + clientPlatform + servers[] to look for HTTP-200 SUCCESS-STATE semantic friction that error clusters cannot show: (a) null fields on success (a key field such as number:null where a PR/issue number was expected), (b) double-layer nesting where the real payload is buried inside result.content[0].text as an escaped JSON string, (c) false-positive / mistaken truncation (a complete successful body treated as truncated) and reverse cases, (d) cross-upstream handoff redundancy (the same unwrap/parse/format repeated between github / vercel / notion calls), and (e) repeated defensive parsing or re-wrapping that the gateway or the client keeps doing on every successful call. responsePreview is BOUNDED: absence of a field inside the preview is not proof that it is absent from the full body — say so instead of over-claiming. Attribute each such issue with clientPlatform and servers.'
    : '';
  return [
    {
      role: 'system',
      content: [
        'You are an offline analyzer for a private MCP gateway capture dataset.',
        'Classify only from the provided JSON. Do not invent evidence.',
        'Your output is advisory only: it must be verified against raw captures and a local replay before any code change.',
        trendHint,
        truncationHint,
        sessionHint,
        projectHint,
        dimensionHint,
        dataStatusHint,
        serviceStateHint,
        responsePreviewHint,
        'Return ONLY strict JSON matching analyzer-output.v1:',
        '{"schema":"analyzer-output.v1","summary":"...","issues":[{"id":"issue-1","severity":"P0|P1|P2|P3","category":"gateway|upstream|model|data|unknown","title":"...","evidenceEventIds":["..."],"likelyCause":"...","suggestedFix":"...","confidence":0.0,"clientPlatform":"gemini|chatgpt|claude|unknown|null","servers":["github"],"regressionTask":{"prompt":"...","expectedTool":"...","assertions":["..."]}}],"ignored":[{"clusterId":"c1","reason":"..."}]}',
        'Each issue MUST cite at least one evidenceEventIds from the input. If unsure, use ignored.',
        'Attribution is optional: set "clientPlatform" (string or null) and "servers" (array of upstream server names). Use null / [] when the evidence does not support an attribution. Never drop an issue just because attribution is unknown.',
        'Also inspect successful samples: propose issues for real friction (wrong arg types, repeated unwrap/casting, slow tool chains, missing helpers) even when there is no error cluster.',
        'No markdown, no code fences, no extra text.',
      ].filter(Boolean).join('\n'),
    },
    { role: 'user', content: JSON.stringify(input) },
  ];
}

function analyzerEndpoint(base) {
  if (!base) throw new Error('ANALYZER_BASE_URL is required');
  const trimmed = base.replace(/\/+$/, '');
  return trimmed.endsWith('/chat/completions') ? trimmed : `${trimmed}/chat/completions`;
}

export async function callAnalyzer(input, options = {}) {
  const base = options.baseUrl ?? process.env.ANALYZER_BASE_URL ?? '';
  const model = options.model ?? process.env.ANALYZER_MODEL ?? 'hy4-flash-free';
  const apiKey = options.apiKey ?? process.env.ANALYZER_API_KEY ?? '';
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(analyzerEndpoint(base), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      'x-opencode-session': randomUUID(),
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 6000,
      reasoning_effort: 'none',
      messages: analyzerPrompt(input),
    }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`analyzer HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  const body = await response.json();
  const content = body?.choices?.[0]?.message?.content ?? body?.choices?.[0]?.message?.reasoning_content ?? '';
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error(`analyzer returned no JSON: ${JSON.stringify(body).slice(0, 800)}`);
  return JSON.parse(content.slice(start, end + 1));
}

/** Recognized values for the CLI dimension filters (closed sets). */
export const FILTER_PLATFORMS = Object.freeze(['gemini', 'chatgpt', 'claude']);
export const FILTER_EVAL_MODES = Object.freeze(['active', 'passive']);

/**
 * Parse and VALIDATE the M4-A dimension filter flags. Invalid or valueless
 * flags throw with an actionable message — they are never silently ignored.
 */
export function parseCliFilters(argv = []) {
  const list = Array.isArray(argv) ? argv : [];
  const valueOf = (flag) => {
    const index = list.indexOf(flag);
    if (index < 0) return undefined;
    const value = list[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    return value;
  };
  const platformRaw = valueOf('--platform');
  const evalModeRaw = valueOf('--eval-mode');
  const lastMinutesRaw = valueOf('--last-minutes');
  const commitRaw = valueOf('--commit');

  const platform = platformRaw === undefined ? '' : String(platformRaw).trim().toLowerCase();
  if (platform && !FILTER_PLATFORMS.includes(platform)) {
    throw new Error(`invalid --platform "${platformRaw}": expected ${FILTER_PLATFORMS.join('|')}`);
  }
  const evalMode = evalModeRaw === undefined ? '' : String(evalModeRaw).trim().toLowerCase();
  if (evalMode && !FILTER_EVAL_MODES.includes(evalMode)) {
    throw new Error(`invalid --eval-mode "${evalModeRaw}": expected ${FILTER_EVAL_MODES.join('|')}`);
  }
  let lastMinutes = 0;
  if (lastMinutesRaw !== undefined) {
    const parsed = Number(lastMinutesRaw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`invalid --last-minutes "${lastMinutesRaw}": expected a positive number`);
    }
    lastMinutes = Math.floor(parsed);
  }
  if (commitRaw !== undefined && !String(commitRaw).trim()) {
    throw new Error('--commit requires a non-empty commit prefix');
  }
  return { platform, evalMode, lastMinutes, commit: commitRaw === undefined ? '' : String(commitRaw).trim() };
}

export function filterEnvelopes(envelopes, {
  lastMinutes = 0, commit = '', platform = '', evalMode = '', nowMs = Date.now(),
} = {}) {
  const mins = Number(lastMinutes);
  const cutoff = Number.isFinite(mins) && mins > 0 ? nowMs - mins * 60 * 1000 : null;
  const commitPrefix = typeof commit === 'string' ? commit.trim() : '';
  const wantedPlatform = typeof platform === 'string' ? platform.trim().toLowerCase() : '';
  const wantedEvalMode = typeof evalMode === 'string' ? evalMode.trim().toLowerCase() : '';
  if (wantedPlatform && !FILTER_PLATFORMS.includes(wantedPlatform)) {
    throw new Error(`invalid platform filter "${platform}": expected ${FILTER_PLATFORMS.join('|')}`);
  }
  if (wantedEvalMode && !FILTER_EVAL_MODES.includes(wantedEvalMode)) {
    throw new Error(`invalid evalMode filter "${evalMode}": expected ${FILTER_EVAL_MODES.join('|')}`);
  }
  return (Array.isArray(envelopes) ? envelopes : []).filter((env) => {
    if (cutoff !== null) {
      const t = Date.parse(env?.ts ?? env?.timestamp ?? '');
      if (!Number.isFinite(t) || t < cutoff) return false;
    }
    if (commitPrefix) {
      const c = String(env?.deployment?.commit ?? '');
      if (!c.startsWith(commitPrefix)) return false;
    }
    if (wantedPlatform && clientPlatformOf(env) !== wantedPlatform) return false;
    if (wantedEvalMode && evalModeOf(env) !== wantedEvalMode) return false;
    return true;
  });
}

async function main() {
  const args = process.argv.slice(2);
  const arg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : '');
  const date = arg('--date') || new Date().toISOString().slice(0, 10);
  const dir = arg('--dir');
  const out = arg('--out') || join('work', 'analyzer');
  const dryRun = args.includes('--dry-run');
  const since = arg('--since');
  const days = Number(arg('--days') || 7);
  let filters;
  try {
    filters = parseCliFilters(args);
  } catch (error) {
    console.error(`[analyze] ${error.message}`);
    process.exitCode = 1;
    return;
  }
  const { lastMinutes, commit, platform, evalMode } = filters;

  let envelopes;
  if (dir) {
    envelopes = await readDirEnvelopes(dir);
  } else if (lastMinutes > 0) {
    const now = new Date();
    const start = new Date(now.getTime() - lastMinutes * 60 * 1000);
    const daySet = new Set([start.toISOString().slice(0, 10), now.toISOString().slice(0, 10)]);
    const keys = [];
    for (const d of daySet) {
      keys.push(...await listR2Keys(`capture/${d}/`));
    }
    envelopes = await Promise.all(keys.map(readR2Envelope));
  } else if (since) {
    const start = new Date(`${since}T00:00:00.000Z`);
    if (Number.isNaN(start.getTime())) throw new Error(`invalid --since date: ${since}`);
    const keys = [];
    for (let offset = 0; offset < days; offset += 1) {
      const day = new Date(start.getTime() + offset * 86400000).toISOString().slice(0, 10);
      keys.push(...await listR2Keys(`capture/${day}/`));
    }
    envelopes = await Promise.all(keys.map(readR2Envelope));
  } else {
    envelopes = await Promise.all((await listR2Keys(`capture/${date}/`)).map(readR2Envelope));
  }

  envelopes = filterEnvelopes(envelopes, { lastMinutes, commit, platform, evalMode });
  const trend = since || dir ? dailyTrend(envelopes) : null;
  const filterSuffix = [
    lastMinutes > 0 ? `last-${lastMinutes}m` : '',
    platform ? `platform-${platform}` : '',
    evalMode ? `eval-${evalMode}` : '',
    commit ? `commit-${commit}` : '',
  ].filter(Boolean).join('-');
  const baseLabel = since || date;
  const label = filterSuffix ? `${baseLabel}-${filterSuffix}` : baseLabel;
  const input = buildAnalyzerInput(envelopes, { date: label, maxClusters: 10, trend, filters });
  await mkdir(out, { recursive: true });
  await writeFile(join(out, `analyzer-input-${label}.json`), JSON.stringify(input, null, 2), 'utf8');
  if (dryRun) {
    const filterText = [
      platform ? `platform=${platform}` : null,
      evalMode ? `evalMode=${evalMode}` : null,
      lastMinutes ? `lastMinutes=${lastMinutes}` : null,
      commit ? `commit=${commit}` : null,
    ].filter(Boolean).join(', ') || 'none';
    console.log(`[analyze] dry-run: dataStatus=${input.dataStatus} ${input.clusters.length} clusters, ${input.metrics.requests} requests, ${trend?.length ?? 0} days, filters=${filterText}`);
    return;
  }
  // G4: never spend a model call on an empty window, and never emit an output
  // that could be read as "0 issues = healthy".
  if (input.dataStatus === 'EMPTY_WINDOW') {
    const validated = buildEmptyWindowAnalyzerOutput(input);
    await writeFile(join(out, `analyzer-output-${label}.json`), JSON.stringify({ date: label, input, raw: null, validated }, null, 2), 'utf8');
    console.log(`[analyze] ${label}: EMPTY_WINDOW (model not called; NOT_ENOUGH)`);
    return;
  }
  const raw = await callAnalyzer(input);
  const validated = validateAnalyzerOutput(raw, input);
  await writeFile(join(out, `analyzer-output-${label}.json`), JSON.stringify({ date: label, input, raw, validated }, null, 2), 'utf8');
  console.log(`[analyze] ${label}: ${validated.issues.length} issues, ${validated.ignored.length} ignored`);
}

if (process.argv[1] && process.argv[1].endsWith('analyze-captures.mjs')) {
  main().catch((error) => {
    console.error(`[analyze] failed: ${error?.message ?? String(error)}`);
    process.exitCode = 1;
  });
}
