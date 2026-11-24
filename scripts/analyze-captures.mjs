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
} from './capture-digest.mjs';

const MAX_CODE = 2000;
const MAX_ERROR = 1000;

function truncate(value, limit) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) return null;
  return text.length > limit ? `${text.slice(0, limit)}…[truncated ${text.length - limit}]` : text;
}

function requestJson(envelope) {
  try { return JSON.parse(String(envelope?.request?.raw ?? '')); } catch { return null; }
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

export function buildAnalyzerInput(envelopes, { date = 'unknown', maxClusters = 10, trend = null } = {}) {
  const mcpOnly = envelopes.filter((envelope) => {
    try {
      const path = new URL(String(envelope?.request?.url ?? '/mcp'), 'http://localhost').pathname;
      const method = String(envelope?.request?.method ?? 'POST').toUpperCase();
      return path === '/mcp' && method === 'POST';
    } catch { return true; }
  });
  const metrics = aggregateEnvelopes(mcpOnly, { date });
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
          clientPlatform: envelope.clientPlatform ?? 'unknown',
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

  return {
    schema: 'analyzer-input.v1',
    date,
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
      regressionTask: issue.regressionTask ?? null,
    });
    if (issues.length >= (input.limits?.maxIssues ?? 5)) break;
  }
  return {
    schema: 'analyzer-output.v1',
    policy: 'free-model-advisory-v1',
    advisoryOnly: true,
    requiresHumanReview: true,
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

function analyzerPrompt(input) {
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
        'Return ONLY strict JSON matching analyzer-output.v1:',
        '{"schema":"analyzer-output.v1","summary":"...","issues":[{"id":"issue-1","severity":"P0|P1|P2|P3","category":"gateway|upstream|model|data|unknown","title":"...","evidenceEventIds":["..."],"likelyCause":"...","suggestedFix":"...","confidence":0.0,"regressionTask":{"prompt":"...","expectedTool":"...","assertions":["..."]}}],"ignored":[{"clusterId":"c1","reason":"..."}]}',
        'Each issue MUST cite at least one evidenceEventIds from the input. If unsure, use ignored.',
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

export function filterEnvelopes(envelopes, { lastMinutes = 0, commit = '', nowMs = Date.now() } = {}) {
  const mins = Number(lastMinutes);
  const cutoff = Number.isFinite(mins) && mins > 0 ? nowMs - mins * 60 * 1000 : null;
  const commitPrefix = typeof commit === 'string' ? commit.trim() : '';
  return (Array.isArray(envelopes) ? envelopes : []).filter((env) => {
    if (cutoff !== null) {
      const t = Date.parse(env?.ts ?? env?.timestamp ?? '');
      if (!Number.isFinite(t) || t < cutoff) return false;
    }
    if (commitPrefix) {
      const c = String(env?.deployment?.commit ?? '');
      if (!c.startsWith(commitPrefix)) return false;
    }
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
  const lastMinutes = Number(arg('--last-minutes') || 0);
  const commit = arg('--commit') || '';

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

  envelopes = filterEnvelopes(envelopes, { lastMinutes, commit });
  const trend = since || dir ? dailyTrend(envelopes) : null;
  const labelSuffix = lastMinutes > 0 ? `last-${lastMinutes}m` : '';
  const input = buildAnalyzerInput(envelopes, { date: since || (labelSuffix ? `${date}-${labelSuffix}` : date), maxClusters: 10, trend });
  await mkdir(out, { recursive: true });
  const label = since || date;
  await writeFile(join(out, `analyzer-input-${label}.json`), JSON.stringify(input, null, 2), 'utf8');
  if (dryRun) {
    console.log(`[analyze] dry-run: ${input.clusters.length} clusters, ${input.metrics.requests} requests, ${trend?.length ?? 0} days`);
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
