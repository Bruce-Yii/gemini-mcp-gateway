import fs from 'node:fs';
const d = JSON.parse(fs.readFileSync('explore/results/anomalies.json', 'utf8'));

// execute_error: categorize by root cause
const exec = d.anomalies.filter(a => a.type === 'execute_error');
const execCats = {};
for (const a of exec) {
  let c = 'other';
  if (/Invalid option|does not equal any of|expected one of/.test(a.detail)) c = 'enum/valid-option mismatch';
  else if (/missing required|required parameter|Invalid arguments for tool/.test(a.detail)) c = 'param validation';
  else if (/403|401|unauthorized|permission|not accessible/i.test(a.detail)) c = 'permission';
  else if (/ReferenceError|TypeError|is not a function|undefined/.test(a.detail)) c = 'JS/runtime error';
  else if (/truncated|too large|exceeds/.test(a.detail)) c = 'result too large';
  else if (/not found|404|no tool/i.test(a.detail)) c = 'not found';
  execCats[c] = (execCats[c]||0)+1;
}
console.log('=== execute_error categories ===', JSON.stringify(execCats, null, 2));

// which tools errored most
const toolErrors = {};
for (const a of exec) {
  const m = /codemode\.([\w]+)/.exec(a.detail) || /tool (\w+)/.exec(a.detail);
  const k = m ? m[1] : 'unknown';
  toolErrors[k] = (toolErrors[k]||0)+1;
}
console.log('\n=== execute_error by tool (top 12) ===');
Object.entries(toolErrors).sort((x,y)=>y[1]-x[1]).slice(0,12).forEach(([k,v])=>console.log(k,v));

// retry by tool
const retries = d.anomalies.filter(a=>a.type==='retry');
const retryTools = {};
retries.forEach(a=>{const m=/^(\w+) called/.exec(a.detail); const k=m?m[1]:'?'; retryTools[k]=(retryTools[k]||0)+1});
console.log('\n=== retry by tool ===', JSON.stringify(retryTools));

// sample distinct error messages
console.log('\n=== distinct error samples ===');
const seen = new Set();
for (const a of exec) {
  const key = a.detail.slice(0,80);
  if (seen.has(key)) continue;
  seen.add(key);
  console.log(`[${a.server}/${a.tool||''}] ${a.detail.slice(0,180)}`);
  if (seen.size >= 12) break;
}
