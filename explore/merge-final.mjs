import fs from 'node:fs';
const servers = ['github','notion','linear','vercel'];
const rewin = { github: 'work/regithub.json', notion: 'work/renotion.json', linear: 'work/relinear.json', vercel: 'work/revercel.json' };

const all = [];
for (const s of servers) {
  const base = JSON.parse(fs.readFileSync(`work/deep-${s}.json`, 'utf8'));
  const re = fs.existsSync(rewin[s]) ? JSON.parse(fs.readFileSync(rewin[s], 'utf8')) : [];
  const reByTool = new Map(re.map(x => [x.tool, x]));
  let official = 0, derived = 0;
  for (const t of base) {
    const upgraded = reByTool.get(t.tool);
    let task;
    if (upgraded && upgraded.prompt) {
      task = { tool: t.tool, prompt: upgraded.prompt, source: upgraded.source, category: upgraded.category ?? t.category, official: true };
      official++;
    } else {
      const isOfficial = t.official === true || (typeof t.source === 'string' && /^https?:\/\//.test(t.source));
      task = { tool: t.tool, prompt: t.prompt, source: t.source, category: t.category, official: isOfficial };
      if (task.official) official++; else derived++;
    }
    all.push({ id: 'F' + String(all.length + 1).padStart(3, '0'), server: s, ...task });
  }
  console.log(s, 'total', base.length, 'official', official, 'derived', derived);
}
fs.writeFileSync('explore/tasks-final.json', JSON.stringify({
  generatedAt: new Date().toISOString(),
  description: 'Final task set. Official verbatim prompts prioritized; derived-from-description only where official has no per-tool prompt. Full per-tool coverage.',
  count: all.length,
  officialCount: all.filter(t=>t.official).length,
  derivedCount: all.filter(t=>!t.official).length,
  tasks: all,
}, null, 2));
console.log('\ntotal', all.length, '| official', all.filter(t=>t.official).length, '| derived', all.filter(t=>!t.official).length);
