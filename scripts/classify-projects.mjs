/**
 * Offline, advisory-only LLM labeler for project/repository classification.
 *
 * Why: the deterministic extractor (`src/project-tag.js`) only sees explicit
 * owner/repo pairs. Windows with no repo, several repos, or mixed Notion/Linear/
 * GitHub activity are left untagged. This script asks a free model to propose
 * PROJECT CANDIDATES for those windows — but the labels are hypotheses only:
 * they are never merged back into captures, never used as a write path or an
 * idempotency key, and low-confidence labels are separated for human review.
 *
 * Input is a SMALL SUMMARY per window (requestIds, mcp methods/tools, repo /
 * path / branch hints, PR/Issue titles, short result summaries). Full request
 * bodies are never sent to the model, and no model output is trusted without
 * schema validation and a cited requestId from the input window.
 *
 * Usage (no writes to R2 / src / repo data; stdout JSON or --out file):
 *   # dry-run from digest/window rows supplied as JSON (no API key required):
 *   node scripts/classify-projects.mjs --windows work/digest/windows.json --dry-run
 *   # fixture mode (offline, deterministic, for tests/demos):
 *   node scripts/classify-projects.mjs --fixture tests/fixtures/project-labels.json --dry-run
 *   # real free-model call (same client style as scripts/analyze-captures.mjs):
 *   LABELER_API_KEY=... LABELER_BASE_URL=... node scripts/classify-projects.mjs \
 *     --windows work/digest/windows.json --out work/labels
 *
 * Env (parallel to ANALYZER_* in analyze-captures.mjs, independent of it):
 *   LABELER_BASE_URL  OpenAI-compatible chat completions base URL (required for live)
 *   LABELER_MODEL     default: hy4-flash-free
 *   LABELER_API_KEY   optional bearer token
 *
 * Dry-run / fixture mode never calls fetch and is the only mode used by tests.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const LABELER_SCHEMA = 'project-labels.v1';
export const LABELER_POLICY = 'free-model-advisory-v1';

/** Default confidence threshold. At or above = reviewed bucket; below = lowConfidence. */
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.7;

const MAX_TITLE = 200;
const MAX_RESULT = 200;
const MAX_REASON = 400;
const MAX_LABELS = 20;
const MAX_WINDOWS = 50;
const MAX_REQUEST_IDS = 5;

function text(value, limit = MAX_RESULT) {
  if (value === null || value === undefined) return null;
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  if (!raw) return null;
  return raw.length > limit ? `${raw.slice(0, limit)}…` : raw;
}

function finiteConfidence(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.min(1, Math.max(0, Math.round(number * 100) / 100));
}

/**
 * Normalize one digest/session window row into the minimal summary the model
 * is allowed to see. No full bodies, no prose guessing, no fabricated ids.
 * `projects` from the deterministic rollup are passed as HINTS only — a label
 * may agree or disagree, but both stay advisory and need human review.
 */
export function summarizeWindow(row, index = 0) {
  if (!row || typeof row !== 'object') return null;
  const windowId = text(row.windowId ?? row.sessionId ?? row.projectKey ?? `window-${index + 1}`, 160);
  if (!windowId) return null;

  const requestIds = (Array.isArray(row.requestIdSamples) ? row.requestIdSamples : [])
    .map((id) => text(id, 160)).filter(Boolean).slice(0, MAX_REQUEST_IDS);
  const methods = row.methods && typeof row.methods === 'object' && !Array.isArray(row.methods)
    ? Object.keys(row.methods).sort()
    : [];
  const toolsRaw = row.tools ?? row.toolCalls ?? row.mcpTools ?? [];
  const tools = (Array.isArray(toolsRaw)
    ? toolsRaw
    : (toolsRaw && typeof toolsRaw === 'object' ? Object.keys(toolsRaw) : []))
    .map((tool) => text(tool, 160)).filter(Boolean).sort().slice(0, 20);

  // Hints only: repo/path/branch/PR-Issue titles and short result summaries are
  // taken from explicit, already-sanitized digest fields. Strings are truncated
  // to keep the prompt small and to avoid leaking full upstream payloads.
  const hints = {
    repoKeys: (Array.isArray(row.projects) ? row.projects : [])
      .map((project) => text(project?.key ?? project?.repo, 160)).filter(Boolean).slice(0, 10),
    primaryProjectKey: text(row.primaryProjectKey ?? row.primaryProjects?.[0], 160),
    repos: (Array.isArray(row.repos) ? row.repos : []).map((r) => text(r, 160)).filter(Boolean).slice(0, 10),
    paths: (Array.isArray(row.paths) ? row.paths : []).map((p) => text(p, 200)).filter(Boolean).slice(0, 10),
    branches: (Array.isArray(row.branches) ? row.branches : []).map((b) => text(b, 160)).filter(Boolean).slice(0, 10),
    prOrIssueTitles: (Array.isArray(row.prOrIssueTitles) ? row.prOrIssueTitles : (Array.isArray(row.titles) ? row.titles : []))
      .map((title) => text(title, MAX_TITLE)).filter(Boolean).slice(0, 10),
    resultSummaries: (Array.isArray(row.resultSummaries) ? row.resultSummaries : [])
      .map((summary) => text(summary, MAX_RESULT)).filter(Boolean).slice(0, 10),
  };

  return {
    windowId,
    strategy: text(row.strategy, 60) ?? null,
    sessionId: text(row.sessionId, 160),
    requestIds,
    requests: Number.isFinite(Number(row.requests)) ? Number(row.requests) : null,
    mcpErrors: Number.isFinite(Number(row.mcpErrors)) ? Number(row.mcpErrors) : null,
    mcpMethods: methods,
    tools,
    hints,
    // Explicitly NOT included: full request.raw, response.raw, sandbox code,
    // full prompts, upstream payloads, and any write-path/idempotency metadata.
  };
}

/**
 * Build the batched model input from digest/session windows and/or pre-summarized
 * windows. Accepts an array, `{windows:[...]}`, or `{sessions:[...]}`.
 */
export function buildLabelerInput(source, { maxWindows = MAX_WINDOWS, date = '' } = {}) {
  const rows = Array.isArray(source)
    ? source
    : (Array.isArray(source?.windows) ? source.windows : (Array.isArray(source?.sessions) ? source.sessions : []));
  const limit = Number.isFinite(Number(maxWindows)) ? Math.max(0, Math.min(Number(maxWindows), 500)) : MAX_WINDOWS;
  const windows = [];
  for (let i = 0; i < rows.length && windows.length < limit; i += 1) {
    const summary = summarizeWindow(rows[i], i);
    if (summary) windows.push(summary);
  }
  // Deduplicate by windowId, keeping the first deterministic occurrence.
  const seen = new Set();
  const unique = windows.filter((window) => {
    if (seen.has(window.windowId)) return false;
    seen.add(window.windowId);
    return true;
  });
  return {
    schema: LABELER_SCHEMA,
    date: text(date, 40) ?? '',
    advisoryOnly: true,
    requiresHumanReview: true,
    policy: LABELER_POLICY,
    note: 'Window summaries only. windowId is an analysis artifact, not a verified client session. Do not invent requestIds, repos, or titles. A label is a candidate, never a fact.',
    windows: unique,
    limits: { maxLabels: MAX_LABELS, confidenceThreshold: DEFAULT_CONFIDENCE_THRESHOLD },
  };
}

/**
 * Validate raw model output. Drops anything that cannot be traced back to the
 * input: unknown windowId, invented evidence requestIds, bad confidence,
 * empty reason, missing model. Never throws on malformed model JSON — it just
 * yields zero accepted labels, which downstream renders as "nothing to review".
 */
export function validateProjectLabels(raw, input) {
  const knownWindows = new Map((input?.windows ?? []).map((window) => [window.windowId, window]));
  const accepted = [];
  const rejected = [];
  const rawLabels = Array.isArray(raw?.projectLabels)
    ? raw.projectLabels
    : (Array.isArray(raw?.labels) ? raw.labels : []);

  for (const label of rawLabels) {
    const key = text(label?.windowId ?? label?.projectKey, 160);
    const window = key ? knownWindows.get(key) : null;
    const allowedIds = new Set(window?.requestIds ?? []);
    const cited = Array.isArray(label?.evidenceRequestIds)
      ? label.evidenceRequestIds.map((id) => text(id, 160)).filter((id) => id && allowedIds.has(id))
      : [];
    const confidence = finiteConfidence(label?.confidence);
    const reason = text(label?.reason, MAX_REASON);
    const model = text(label?.model, 120);
    const projectKey = text(label?.projectKey ?? label?.label ?? label?.project, 160);

    if (!window || !projectKey || !reason || !model || confidence === null || cited.length === 0) {
      rejected.push({
        windowId: key ?? null,
        reason: !window ? 'unknown-window'
          : !projectKey ? 'missing-projectKey'
            : !reason ? 'missing-reason'
              : !model ? 'missing-model'
                : confidence === null ? 'invalid-confidence'
                  : 'no-valid-evidenceRequestIds',
      });
      continue;
    }
    accepted.push({
      windowId: window.windowId,
      projectKey,
      confidence,
      evidenceRequestIds: [...new Set(cited)].slice(0, MAX_REQUEST_IDS),
      reason,
      model,
    });
    if (accepted.length >= MAX_LABELS) break;
  }

  // Deterministic order; stable across repeated calls.
  accepted.sort((a, b) => a.windowId.localeCompare(b.windowId)
    || b.confidence - a.confidence
    || a.projectKey.localeCompare(b.projectKey));

  const threshold = finiteConfidence(input?.limits?.confidenceThreshold) ?? DEFAULT_CONFIDENCE_THRESHOLD;
  const lowConfidence = accepted.filter((label) => label.confidence < threshold);
  const projectLabels = accepted.filter((label) => label.confidence >= threshold);

  return {
    schema: LABELER_SCHEMA,
    policy: LABELER_POLICY,
    advisoryOnly: true,
    requiresHumanReview: true,
    confidenceThreshold: threshold,
    projectLabels,
    lowConfidence,
    rejected,
    summary: {
      windows: (input?.windows ?? []).length,
      labels: projectLabels.length,
      lowConfidence: lowConfidence.length,
      rejected: rejected.length,
    },
  };
}

function labelerPrompt(input) {
  return [
    {
      role: 'system',
      content: [
        'You are an offline project-classification labeler for a private MCP gateway capture dataset.',
        'Classify ONLY from the provided window summaries. Do not invent requestIds, repos, paths, titles, or windows.',
        'Your output is ADVISORY ONLY: labels are candidate hypotheses for a human reviewer. They are never merged into raw captures and never used for writes or idempotency.',
        'windowId is an analysis-only clustering artifact; do not claim two windows are the same client session.',
        'Use no-repo when a window has no explicit repo evidence; use ambiguous when several repos are equally plausible; cite the requestIds that support each label.',
        'Return ONLY strict JSON matching project-labels.v1:',
        '{"schema":"project-labels.v1","projectLabels":[{"windowId":"...","projectKey":"github:owner/repo | notion:<space> | linear:<team> | no-repo | ambiguous","confidence":0.0,"evidenceRequestIds":["..."],"reason":"...","model":"<name you are>"}]}',
        'Every projectLabel MUST cite at least one evidenceRequestIds from that window. Lower confidence is allowed and will be reviewed separately. No markdown, no code fences, no extra text.',
      ].join('\n'),
    },
    { role: 'user', content: JSON.stringify(input) },
  ];
}

function labelerEndpoint(base) {
  if (!base) throw new Error('LABELER_BASE_URL is required for a live model call');
  const trimmed = String(base).replace(/\/+$/, '');
  return trimmed.endsWith('/chat/completions') ? trimmed : `${trimmed}/chat/completions`;
}

/**
 * Free-model call. Mirrors scripts/analyze-captures.mjs's client (temperature 0,
 * reasoning_effort none, bearer key, per-request session header) but is fully
 * independent: separate env vars, no import from that script, no tool access.
 * Tests inject `fetchImpl` and never hit the network.
 */
export async function callProjectLabeler(input, options = {}) {
  const base = options.baseUrl ?? process.env.LABELER_BASE_URL ?? '';
  const model = options.model ?? process.env.LABELER_MODEL ?? 'hy4-flash-free';
  const apiKey = options.apiKey ?? process.env.LABELER_API_KEY ?? '';
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(labelerEndpoint(base), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      'x-opencode-session': randomUUID(),
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 4000,
      reasoning_effort: 'none',
      messages: labelerPrompt(input),
    }),
  });
  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(`labeler HTTP ${response.status}: ${bodyText.slice(0, 500)}`);
  }
  const body = await response.json();
  const content = body?.choices?.[0]?.message?.content ?? body?.choices?.[0]?.message?.reasoning_content ?? '';
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error(`labeler returned no JSON: ${JSON.stringify(body).slice(0, 800)}`);
  return JSON.parse(content.slice(start, end + 1));
}

/**
 * Orchestrate: build summary -> obtain raw labels -> validate. In dry-run /
 * fixture mode no fetch happens; `fixture` may be an object/array or a JSON file
 * path, and is validated with the exact same rules as live model output.
 */
export async function classifyProjects(source, options = {}) {
  const input = buildLabelerInput(source, options);
  let raw;
  let mode = 'live';
  if (options.fixture !== undefined && options.fixture !== null && options.fixture !== '') {
    mode = 'fixture';
    raw = typeof options.fixture === 'string'
      ? JSON.parse(await readFile(options.fixture, 'utf8'))
      : options.fixture;
  } else if (options.dryRun || options.raw !== undefined) {
    mode = 'dry-run';
    raw = options.raw ?? { schema: LABELER_SCHEMA, projectLabels: [] };
  } else {
    raw = await callProjectLabeler(input, options);
  }
  const labels = validateProjectLabels(raw, input);
  return {
    schema: LABELER_SCHEMA,
    input,
    mode,
    ...labels,
    // Explicit downstream guard: labels are advisory, never a write input.
    downstream: 'advisory-only; do-not-merge; do-not-use-for-write-or-idempotency',
  };
}

/** Markdown render for human review. No file writes, no apply/merge actions. */
export function renderLabelReview(result) {
  const rows = [...(result.projectLabels ?? []), ...(result.lowConfidence ?? [])]
    .map((label) => {
      const ids = label.evidenceRequestIds.map((id) => `\`${id}\``).join(', ') || '—';
      const bucket = (result.lowConfidence ?? []).includes(label) ? 'LOW' : 'normal';
      return `| ${bucket} | ${label.windowId} | ${label.projectKey} | ${label.confidence} | ${ids} | ${label.reason} |`;
    }).join('\n') || '| — | — | no labels | — | — | — |';
  return `# Project label review — ${result.input?.date || 'unknown'}
> Generated by scripts/classify-projects.mjs (mode: ${result.mode ?? 'n/a'}). **Advisory only.**
> Labels are unverified candidate hypotheses. They are not merged into captures,
> are not write-path or idempotency inputs, and require human review against raw
> captures (replay by evidence requestId) before any action.

| Bucket | Window | Candidate projectKey | Confidence | Evidence requestId | Reason |
|---|---|---|---:|---|---|
${rows}

## Review gate
- [ ] Every evidenceRequestIds resolves to a raw capture envelope (replay by requestId).
- [ ] Low-confidence labels are reviewed separately and never auto-accepted.
- [ ] No label is used for writes, merges, issue/PR creation, or idempotency keys.
- [ ] Invalid model output was rejected, not silently accepted (see \`rejected\` in JSON).
`;
}

async function main() {
  const args = process.argv.slice(2);
  const arg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : '');
  const windowsFile = arg('--windows');
  const fixture = arg('--fixture') || undefined;
  const out = arg('--out');
  const dryRun = args.includes('--dry-run');
  const date = arg('--date') || '';

  if (!windowsFile && !fixture) {
    throw new Error('provide --windows <json> or --fixture <json>');
  }
  const source = windowsFile ? JSON.parse(await readFile(windowsFile, 'utf8')) : [];
  const result = await classifyProjects(source, { date, fixture, dryRun });
  const rendered = JSON.stringify(result, null, 2);
  if (out) {
    await mkdir(out, { recursive: true });
    await writeFile(join(out, `project-labels${date ? `-${date}` : ''}.json`), rendered, 'utf8');
    await writeFile(join(out, `project-labels${date ? `-${date}` : ''}.md`), renderLabelReview(result), 'utf8');
  } else {
    console.log(rendered);
  }
  console.error(`[classify] ${result.mode}: ${result.summary.labels} labels, ${result.summary.lowConfidence} low-confidence, ${result.summary.rejected} rejected`);
}

if (process.argv[1] && process.argv[1].endsWith('classify-projects.mjs')) {
  main().catch((error) => {
    console.error(`[classify] failed: ${error?.message ?? String(error)}`);
    process.exitCode = 1;
  });
}
