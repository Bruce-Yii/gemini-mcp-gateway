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
  await mkdir(out, { recursive: true });
  await writeFile(join(out, `scorecard-${label}.md`), renderScorecard(label, metrics), 'utf8');
  await writeFile(join(out, `scorecard-${label}.json`), JSON.stringify({ date: label, ...payload }, null, 2), 'utf8');
  console.log(`[digest] ${label}: ${metrics.requests} requests, ${metrics.errors} errors -> ${out}`);
}

if (process.argv[1] && process.argv[1].endsWith('capture-digest.mjs')) {
  main().catch((error) => {
    console.error(`[digest] failed: ${error?.message ?? String(error)}`);
    process.exitCode = 1;
  });
}
