/**
 * Offline capture analyzer: deterministic digest -> free model -> validated JSON.
 *
 * Usage:
 *   ANALYZER_API_KEY=... node scripts/analyze-captures.mjs --date 2026-11-22
 *   node scripts/analyze-captures.mjs --dir work/capture --dry-run
 *
 * The model never runs in the gateway path and never gets tools; it only labels
 * clusters and proposes issue drafts. The validator is the source of truth.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  listR2Keys, readR2Envelope, readDirEnvelopes, aggregateEnvelopes, classifyError,
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

export function buildAnalyzerInput(envelopes, { date = 'unknown', maxClusters = 10 } = {}) {
  const mcpOnly = envelopes.filter((envelope) => {
    try {
      const path = new URL(String(envelope?.request?.url ?? '/mcp'), 'http://localhost').pathname;
      const method = String(envelope?.request?.method ?? 'POST').toUpperCase();
      return path === '/mcp' && method === 'POST';
    } catch { return true; }
  });
  const metrics = aggregateEnvelopes(mcpOnly);
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
      });
    }
  }
  for (const envelope of mcpOnly) {
    const status = Number(envelope?.response?.status ?? 0);
    const raw = String(envelope?.response?.raw ?? '');
    if (status < 400 && !/"isError":true|execute error/i.test(raw)) continue;
    const req = requestJson(envelope);
    const sandbox = (envelope.events ?? []).find((event) => event.type === 'sandbox');
    const upstream = (envelope.events ?? []).find((event) => event.type === 'upstream');
    const tool = req?.params?.name ?? sandbox?.payload?.tool ?? upstream?.payload?.tool ?? 'unknown';
    const server = upstream?.payload?.server ?? 'unknown';
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
  return {
    schema: 'analyzer-input.v1',
    date,
    metrics: {
      requests: metrics.requests,
      errors: metrics.errors,
      p95Ms: metrics.p95Ms,
      topErrorClasses: metrics.errorClasses,
    },
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
    summary: truncate(output?.summary ?? '', 500),
    issues,
    ignored: Array.isArray(output?.ignored) ? output.ignored.slice(0, 20) : [],
  };
}

function analyzerPrompt(input) {
  return [
    {
      role: 'system',
      content: [
        'You are an offline analyzer for a private MCP gateway capture dataset.',
        'Classify only from the provided JSON. Do not invent evidence.',
        'Return ONLY strict JSON matching analyzer-output.v1:',
        '{"schema":"analyzer-output.v1","summary":"...","issues":[{"id":"issue-1","severity":"P0|P1|P2|P3","category":"gateway|upstream|model|data|unknown","title":"...","evidenceEventIds":["..."],"likelyCause":"...","suggestedFix":"...","confidence":0.0,"regressionTask":{"prompt":"...","expectedTool":"...","assertions":["..."]}}],"ignored":[{"clusterId":"c1","reason":"..."}]}',
        'Each issue MUST cite at least one evidenceEventIds from the input. If unsure, use ignored.',
        'Also inspect successful samples: propose issues for real friction (wrong arg types, repeated unwrap/casting, slow tool chains, missing helpers) even when there is no error cluster.',
        'No markdown, no code fences, no extra text.',
      ].join('\n'),
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
  const date = args.includes('--date') ? args[args.indexOf('--date') + 1] : new Date().toISOString().slice(0, 10);
  const dir = args.includes('--dir') ? args[args.indexOf('--dir') + 1] : '';
  const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : join('work', 'analyzer');
  const dryRun = args.includes('--dry-run');
  const envelopes = dir ? await readDirEnvelopes(dir) : await Promise.all((await listR2Keys(`capture/${date}/`)).map(readR2Envelope));
  const input = buildAnalyzerInput(envelopes, { date, maxClusters: 10 });
  await mkdir(out, { recursive: true });
  await writeFile(join(out, `analyzer-input-${date}.json`), JSON.stringify(input, null, 2), 'utf8');
  if (dryRun) {
    console.log(`[analyze] dry-run: ${input.clusters.length} clusters, ${input.metrics.requests} requests`);
    return;
  }
  const raw = await callAnalyzer(input);
  const validated = validateAnalyzerOutput(raw, input);
  await writeFile(join(out, `analyzer-output-${date}.json`), JSON.stringify({ date, input, raw, validated }, null, 2), 'utf8');
  console.log(`[analyze] ${date}: ${validated.issues.length} issues, ${validated.ignored.length} ignored`);
}

if (process.argv[1] && process.argv[1].endsWith('analyze-captures.mjs')) {
  main().catch((error) => {
    console.error(`[analyze] failed: ${error?.message ?? String(error)}`);
    process.exitCode = 1;
  });
}
