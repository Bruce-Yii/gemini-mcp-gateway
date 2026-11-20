import fs from 'node:fs';
const d = JSON.parse(fs.readFileSync('explore/results/anomalies.json', 'utf8'));
const toolErrors = d.anomalies.filter(a => a.type === 'tool_error');
// categorize
const cats = {};
for (const a of toolErrors) {
  let c = 'other';
  if (/Invalid option|does not equal any of|expected one of/.test(a.detail)) c = 'enum/valid-option mismatch';
  else if (/required parameter|missing/.test(a.detail)) c = 'missing required param';
  else if (/401|403|unauthorized|permission/i.test(a.detail)) c = 'auth/permission';
  else if (/validation|validating/.test(a.detail)) c = 'schema validation';
  cats[c] = (cats[c]||0)+1;
}
console.log('tool_error categories:', JSON.stringify(cats, null, 2));
console.log('\n=== enum mismatch samples ===');
toolErrors.filter(a => /Invalid option|does not equal/.test(a.detail)).slice(0,3).forEach(a => console.log(`[${a.task}/${a.server}] ${a.detail.slice(0,250)}`));
// retry breakdown
const retries = d.anomalies.filter(a=>a.type==='retry');
const byTool = {};
retries.forEach(a=>{const m=/^(\w+) called/.exec(a.detail); const k=m?m[1]:'?'; byTool[k]=(byTool[k]||0)+1});
console.log('\nretry by tool:', JSON.stringify(byTool));
