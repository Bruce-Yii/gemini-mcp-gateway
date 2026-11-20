import fs from 'node:fs';
import { classifyRootCause } from './trace.mjs';

const d = JSON.parse(fs.readFileSync('explore/results/anomalies.json', 'utf8'));
const anomalies = d.anomalies ?? [];
const occ = (a) => a.occurrences ?? 1;
// Only attribution=gateway is an actionable gateway defect; model / harness /
// synthetic / expected / infra are tracked separately (R2).
const isGatewayDefect = (a) => a.attribution === 'gateway' && a.isGatewayDefect !== false;

/* ------------------------------------------------------------------ *
 * Provenance / dedup sanity (R1 / R2)
 * ------------------------------------------------------------------ */
console.log('=== run manifest ===');
console.log(JSON.stringify({
  runId: d.runId, generatedAt: d.generatedAt, model: d.model,
  manifest: d.manifest, dedupCount: d.dedupCount, rawCount: d.rawCount,
  stored: anomalies.length,
}, null, 2));

const keys = anomalies.map((a) => `${a.task}|${a.type}|${String(a.detail).slice(0, 80)}`);
console.log('\n=== dedup check ===', JSON.stringify({
  stored: anomalies.length,
  uniqueKeys: new Set(keys).size,
  duplicatesRemaining: keys.length - new Set(keys).size,
  totalOccurrences: anomalies.reduce((s, a) => s + occ(a), 0),
}));

/* ------------------------------------------------------------------ *
 * Attribution x type x server (R2) — gateway column is the actionable one
 * ------------------------------------------------------------------ */
const byAttr = {};
const byAttrTypeServer = {};
for (const a of anomalies) {
  const attr = a.attribution ?? 'unknown';
  byAttr[attr] = (byAttr[attr] ?? 0) + occ(a);
  const k = `${attr} | ${a.type} | ${a.server}`;
  byAttrTypeServer[k] = (byAttrTypeServer[k] ?? 0) + occ(a);
}
console.log('\n=== by attribution (occurrence-weighted) ===', JSON.stringify(byAttr, null, 2));
console.log('\n=== attribution x type x server (top 25) ===');
Object.entries(byAttrTypeServer).sort((x, y) => y[1] - x[1]).slice(0, 25)
  .forEach(([k, v]) => console.log(`${String(v).padStart(4)}  ${k}`));

const gw = anomalies.filter(isGatewayDefect);
const synth = anomalies.filter((a) => a.attribution === 'synthetic_data' || a.syntheticData);
const expected = anomalies.filter((a) => a.attribution === 'expected_behavior' || a.expectedBehavior);
console.log('\n=== separation (occurrence-weighted) ===', JSON.stringify({
  gatewayDefects: gw.reduce((s, a) => s + occ(a), 0),
  modelBehavior: anomalies.filter((a) => a.attribution === 'model').reduce((s, a) => s + occ(a), 0),
  harnessErrors: anomalies.filter((a) => a.attribution === 'harness').reduce((s, a) => s + occ(a), 0),
  syntheticDataFakeErrors: synth.reduce((s, a) => s + occ(a), 0),
  expectedBehaviorRefusals: expected.reduce((s, a) => s + occ(a), 0),
  infraErrors: anomalies.filter((a) => a.attribution === 'infra').reduce((s, a) => s + occ(a), 0),
}));

/* ------------------------------------------------------------------ *
 * execute_error: categorize by root cause (uses structured field when present)
 * ------------------------------------------------------------------ */
const exec = anomalies.filter((a) => a.type === 'execute_error');
const execCats = {};
for (const a of exec) {
  const c = a.rootCause && a.rootCause !== 'other' ? a.rootCause : classifyRootCause(a.detail);
  execCats[c] = (execCats[c] || 0) + occ(a);
  if (a.syntheticData) execCats['[synthetic] ' + c] = (execCats['[synthetic] ' + c] || 0) + occ(a);
}
console.log('\n=== execute_error root causes ===', JSON.stringify(execCats, null, 2));

// which tools errored most
const toolErrors = {};
for (const a of exec) {
  const m = /codemode\.([\w]+)/.exec(a.detail) || /tool (\w+)/.exec(a.detail);
  const k = m ? m[1] : 'unknown';
  toolErrors[k] = (toolErrors[k] || 0) + occ(a);
}
console.log('\n=== execute_error by tool (top 12) ===');
Object.entries(toolErrors).sort((x, y) => y[1] - x[1]).slice(0, 12).forEach(([k, v]) => console.log(k, v));

// retry by tool
const retries = anomalies.filter((a) => a.type === 'retry');
const retryTools = {};
retries.forEach((a) => { const m = /^(\w+) called/.exec(a.detail); const k = m ? m[1] : '?'; retryTools[k] = (retryTools[k] || 0) + occ(a); });
console.log('\n=== retry by tool ===', JSON.stringify(retryTools));

// sample distinct error messages (dedup already applied, but keep guard)
console.log('\n=== distinct error samples (gateway defects only) ===');
const seen = new Set();
for (const a of gw) {
  const key = String(a.detail).slice(0, 80);
  if (seen.has(key)) continue;
  seen.add(key);
  console.log(`[${a.server}/${a.tool || ''}] ${String(a.detail).slice(0, 180)} (occ=${occ(a)}, attr=${a.attribution})`);
  if (seen.size >= 12) break;
}

// fixture tasks that produced placeholder 404s
console.log('\n=== synthetic placeholder tasks ===');
for (const a of synth.slice(0, 20)) {
  console.log(`[${a.server}/${a.task}] note=${a.note || ''} prompt=${String(a.prompt).slice(0, 100)}`);
}
