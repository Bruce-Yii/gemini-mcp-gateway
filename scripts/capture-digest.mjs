/**
 * Daily capture digest: aggregate raw envelopes from R2 (or a local dir) into a
 * small, sanitized scorecard. Raw payloads stay in R2; the digest contains only
 * counts, timings, sizes, tool names and truncated error messages.
 *
 * Usage:
 *   node scripts/capture-digest.mjs --date 2026-11-22
 *   node scripts/capture-digest.mjs --dir work/capture
 *
 * R2 env: R2_ACCOUNT_ID, R2_BUCKET, R2_AUTH_EMAIL + R2_AUTH_KEY, or R2_API_TOKEN.
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

export function aggregateEnvelopes(envelopes) {
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
  };
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
    if (status >= 400) {
      result.errors += 1;
      const cls = classifyError(envelope);
      if (isMcp) {
        result.mcpErrors += 1;
        result.errorClasses[cls] = (result.errorClasses[cls] ?? 0) + 1;
      } else {
        result.routeErrors[cls] = (result.routeErrors[cls] ?? 0) + 1;
      }
    }
    if (envelope?.response?.overflow) result.overflow += 1;
    if (!isMcp) continue;
    try {
      const json = JSON.parse(String(envelope?.request?.raw ?? ''));
      const method = json?.method;
      if (method) result.tools[method] = (result.tools[method] ?? 0) + 1;
      const name = json?.params?.name;
      if (name) result.upstreams[name] = (result.upstreams[name] ?? 0) + 1;
    } catch { /* not JSON */ }
  }
  result.durations.sort((a, b) => a - b);
  const pct = (p) => result.durations[Math.min(result.durations.length - 1, Math.max(0, Math.ceil(result.durations.length * p) - 1))] ?? 0;
  result.p50Ms = pct(0.5);
  result.p95Ms = pct(0.95);
  result.avgMs = result.durations.length ? Math.round(result.durations.reduce((a, b) => a + b, 0) / result.durations.length) : 0;
  return result;
}

export function renderScorecard(date, metrics) {
  const toolRows = Object.entries(metrics.upstreams).sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([name, count]) => `| ${name} | ${count} |`).join('\n');
  const errorRows = Object.entries(metrics.errorClasses).sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `| ${name} | ${count} |`).join('\n') || '| — | 0 |';
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
| Truncated responses | ${metrics.truncated} |
| Overflow captures | ${metrics.overflow} |

## Tool calls (MCP method)
${Object.entries(metrics.tools).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, count]) => `- ${name}: ${count}`).join('\n') || '- none'}

## Top upstream tools
| Tool | Calls |
|---|---|
${toolRows || '| — | 0 |'}

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

async function main() {
  const args = process.argv.slice(2);
  const date = args.includes('--date') ? args[args.indexOf('--date') + 1] : new Date().toISOString().slice(0, 10);
  const dir = args.includes('--dir') ? args[args.indexOf('--dir') + 1] : '';
  const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : join('docs', 'eval');
  const envelopes = dir ? await readDirEnvelopes(dir) : (await listR2Keys(`capture/${date}/`)).map(readR2Envelope);
  const resolved = dir ? envelopes : await Promise.all(envelopes);
  const metrics = aggregateEnvelopes(resolved);
  await mkdir(out, { recursive: true });
  await writeFile(join(out, `scorecard-${date}.md`), renderScorecard(date, metrics), 'utf8');
  await writeFile(join(out, `scorecard-${date}.json`), JSON.stringify({ date, metrics }, null, 2), 'utf8');
  console.log(`[digest] ${date}: ${metrics.requests} requests, ${metrics.errors} errors -> ${out}`);
}

if (process.argv[1] && process.argv[1].endsWith('capture-digest.mjs')) {
  main().catch((error) => {
    console.error(`[digest] failed: ${error?.message ?? String(error)}`);
    process.exitCode = 1;
  });
}
