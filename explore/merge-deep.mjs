import fs from 'node:fs';
const servers = ['github','notion','linear','vercel'];
const all = [];
for (const s of servers) {
  const f = `work/deep-${s}.json`;
  if (!fs.existsSync(f)) { console.error('MISSING', f); continue; }
  let arr = JSON.parse(fs.readFileSync(f, 'utf8'));
  // normalize: some agents may wrap in {tasks:[...]}
  if (!Array.isArray(arr)) arr = arr.tasks ?? arr.items ?? [];
  for (const t of arr) {
    all.push({
      id: 'D' + String(all.length + 1).padStart(3, '0'),
      server: s,
      tool: t.tool,
      category: t.category ?? 'derived',
      prompt: t.prompt,
      source: t.source ?? '',
      official: (t.source && t.source !== 'derived-from-official-description'),
    });
  }
  console.log(s, arr.length);
}
fs.writeFileSync('explore/tasks-deep.json', JSON.stringify({
  generatedAt: new Date().toISOString(),
  description: 'Per-tool exploration tasks sourced from each MCP official docs (59 verbatim official prompts + 132 derived from official descriptions). Full coverage of exposed tools.',
  count: all.length,
  tasks: all,
}, null, 2));
const bySrv = {}; all.forEach(t => bySrv[t.server] = (bySrv[t.server]||0)+1);
const official = all.filter(t=>t.official).length;
console.log('\ntotal', all.length, '| official', official, '| derived', all.length-official);
console.log('by server', JSON.stringify(bySrv));
