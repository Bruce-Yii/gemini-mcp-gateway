import fs from 'node:fs';
const base = JSON.parse(fs.readFileSync('explore/tasks-final.json', 'utf8'));
const servers = ['github', 'notion', 'linear', 'vercel'];
const regen = new Map();
for (const s of servers) {
  const f = `work/regen-${s}.json`;
  if (!fs.existsSync(f)) { console.error('MISSING', f); continue; }
  const arr = JSON.parse(fs.readFileSync(f, 'utf8'));
  for (const t of arr) regen.set(`${s}::${t.tool}`, t);
  console.log(s, arr.length);
}
let replaced = 0, kept = 0;
const tasks = base.tasks.map((t) => {
  if (t.official) { kept++; return t; } // keep official verbatim tasks untouched
  const key = `${t.server}::${t.tool}`;
  const r = regen.get(key);
  if (r && r.prompt) {
    replaced++;
    return { ...t, prompt: r.prompt, source: r.source ?? 'schema-driven+validated', rank: r.rank, regenerated: true };
  }
  console.error('NO REGEN for', key);
  return t;
});
fs.writeFileSync('explore/tasks-v2.json', JSON.stringify({
  generatedAt: new Date().toISOString(),
  description: 'Final v2: official verbatim tasks kept; derived tasks replaced by schema-driven prompts with reverse-validation (target tool ranks top-5 in local BM25 search).',
  count: tasks.length,
  officialCount: tasks.filter(t=>t.official).length,
  regeneratedCount: replaced,
  tasks,
}, null, 2));
console.log('\ntotal', tasks.length, '| official kept', kept, '| derived regenerated', replaced);
