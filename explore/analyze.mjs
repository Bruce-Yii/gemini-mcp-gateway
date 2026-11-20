import fs from 'node:fs';
const d = JSON.parse(fs.readFileSync('explore/results/anomalies.json', 'utf8'));
const byType = {};
d.anomalies.forEach(a => (byType[a.type] ??= []).push(a));
for (const [type, list] of Object.entries(byType)) {
  console.log(`\n===== ${type} (${list.length}) =====`);
  list.slice(0, 6).forEach(a => console.log(`[${a.task}/${a.server}/${a.category}] ${a.detail}\n   prompt: ${a.prompt.slice(0,90)}`));
}
// by server
const byServer = {};
d.anomalies.forEach(a => byServer[a.server] = (byServer[a.server]||0)+1);
console.log('\n=== by server ===', JSON.stringify(byServer));
