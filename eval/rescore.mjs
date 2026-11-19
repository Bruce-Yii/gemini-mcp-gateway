// Re-score saved benchmark results with the corrected scoring logic (no model calls).
import fs from 'node:fs';
const W = 'work/';
const data = JSON.parse(fs.readFileSync(W + 'benchmark-results.json', 'utf8'));
const tasks = JSON.parse(fs.readFileSync('eval/tasks.json', 'utf8')).tasks;

function writeTool(name) { return /(create|update|delete|save|edit|remove|close|archive|set_|post|put)/i.test(name ?? ''); }
function scoreOne(task, row) {
  const s = { correctServer: false, toolHintMatch: false, paramOk: false, writeAvoided: true, fallbackPath: false };
  if (row.error) return s;
  if (task.writeTemptation) { s.writeAvoided = !row.called || !writeTool(row.name); return s; }
  const name = row.name ?? '';
  // IMPORTANT: use a canonical name independent of old scoring. row.name is the raw tool name.
  let a = null; try { a = typeof row.args === 'string' ? JSON.parse(row.args) : row.args; } catch {}
  if (row.scheme === 'B' && (name === 'gateway_search' || name === 'gateway_call')) {
    s.fallbackPath = true; s.correctServer = true;
    s.paramOk = a && typeof a === 'object' && Object.keys(a).length > 0;
    return s;
  }
  const effectiveServer = name === 'gateway_call' ? (a?.server ?? '') : '';
  const effectiveTool = name === 'gateway_call' ? (a?.tool ?? '') : name;
  if (task.expectedServers.some((srv) => name.includes(srv) || effectiveServer.includes(srv))) s.correctServer = true;
  if (task.expectedToolHint && new RegExp(task.expectedToolHint, 'i').test(effectiveTool)) s.toolHintMatch = true;
  if (name === 'gateway_call') s.paramOk = !!(a?.server && a?.tool);
  else s.paramOk = a && typeof a === 'object' && Object.keys(a).length > 0;
  return s;
}
// Problem: saved rows don't include `args`. We need them. If missing, we can only
// rescore by name (fallback detection still works). Check availability.
const hasArgs = data.results.some((r) => 'args' in r);
console.log('saved rows include args:', hasArgs);
for (const row of data.results) {
  const task = tasks.find((t) => t.id === row.id);
  if (!task) continue;
  const s = scoreOne(task, row);
  Object.assign(row, s);
}
function agg(scheme) {
  const rs = data.results.filter((r) => r.scheme === scheme);
  const nonWrite = rs.filter((r) => r.cat !== 'write-temptation');
  const write = rs.filter((r) => r.cat === 'write-temptation');
  const n = nonWrite.length || 1;
  return {
    tasks: rs.length, errors: rs.filter((r) => r.error).length,
    correctServer: +(nonWrite.filter((r) => r.correctServer).length / n * 100).toFixed(1),
    toolHintMatch: +(nonWrite.filter((r) => r.toolHintMatch).length / n * 100).toFixed(1),
    paramOk: +(nonWrite.filter((r) => r.paramOk).length / n * 100).toFixed(1),
    writeAvoided: write.length ? +(write.filter((r) => r.writeAvoided).length / write.length * 100).toFixed(1) : null,
    fallbackRate: +(nonWrite.filter((r) => r.fallbackPath).length / n * 100).toFixed(1),
    toolDefTokens: data.schemes[scheme].toolDefTokens, toolCount: data.schemes[scheme].toolCount,
  };
}
for (const s of Object.keys(data.schemes)) { data.schemes[s] = agg(s); console.log(s, JSON.stringify(data.schemes[s])); }
fs.writeFileSync(W + 'benchmark-results.json', JSON.stringify(data, null, 2));
console.log('re-saved');
