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
  isTruncated, upstreamOf,
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
  const samples = [];
  for (const envelope of mcpOnly) {
    const req = requestJson(envelope);
    if (samples.length < 8 && req?.method === 'tools/call') {
      const sandbox = (envelope.events ?? []).find((event) => event.type === 'sandbox');
      samples.push({
        id: envelope.requestId,
        tool: req.params?.name ?? null,
        code: truncate(req.params?.arguments?.code ?? sandbox?.payload?.code, MAX_CODE),
        status: Number(envelope?.response?.status ?? 0),
        durationMs: Number(envelope?.response?.durationMs ?? 0),
        bytes: Number(envelope?.response?.bytes ?? 0),
        sandboxTools: sandbox?.payload?.output?.toolCalls?.length ?? 0,
        truncated: isTruncated(envelope),
      });
    }
  }
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

  return {
    schema: 'analyzer-input.v1',
    date,
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
    clusters: [...groups.values()].sort((a, b) => b.count - a.count).slice(0, maxClusters),
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
  return [
    {
      role: 'system',
      content: [
        'You are an offline analyzer for a private MCP gateway capture dataset.',
        'Classify only from the provided JSON. Do not invent evidence.',
        'Your output is advisory only: it must be verified against raw captures and a local replay before any code change.',
        trendHint,
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

async function main() {
  const args = process.argv.slice(2);
  const arg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : '');
  const date = arg('--date') || new Date().toISOString().slice(0, 10);
  const dir = arg('--dir');
  const out = arg('--out') || join('work', 'analyzer');
  const dryRun = args.includes('--dry-run');
  const since = arg('--since');
  const days = Number(arg('--days') || 7);

  let envelopes;
  if (dir) {
    envelopes = await readDirEnvelopes(dir);
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

  const trend = since || dir ? dailyTrend(envelopes) : null;
  const input = buildAnalyzerInput(envelopes, { date: since || date, maxClusters: 10, trend });
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
