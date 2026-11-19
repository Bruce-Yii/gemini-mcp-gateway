// Rebuild the 4-service tool dataset. Run once; output eval/tool-dataset.json.
// GitHub/Vercel: live remote MCP. Linear/Notion: DSH connector cache.
import fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

function loadCreds() {
  const c = fs.readFileSync('D:\\12412\\dsh-home\\.credentials.yaml', 'utf8');
  const refs = {}; let inR = false;
  for (const l of c.split(/\r?\n/)) {
    if (/^refs:/.test(l)) { inR = true; continue; }
    if (inR && /^\S/.test(l)) inR = false;
    if (inR) { const m = /^\s{2}([A-Z0-9_]+):\s*(.+?)\s*$/.exec(l); if (m) refs[m[1]] = m[2].replace(/^["']|["']$/g, ''); }
  }
  const cop = JSON.parse(fs.readFileSync('C:\\Users\\12412\\.cc-switch\\copilot_auth.json', 'utf8'));
  const ghtoken = Object.values(cop.accounts ?? {})[0]?.github_token ?? '';
  // Tokens from environment only — never hardcode secrets in the repo.
  const vercel = process.env.VERCEL_TOKEN ?? '';
  if (!vercel) console.error('[build-dataset] VERCEL_TOKEN env var not set; Vercel tools will be skipped');
  return { github: ghtoken, vercel };
}

async function live(url, headers) {
  const client = new Client({ name: 'dataset-builder', version: '1' });
  const t = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } });
  try { await client.connect(t); const { tools } = await client.listTools(); await client.close(); return tools.map(x=>({name:x.name,description:x.description,inputSchema:x.inputSchema})); }
  catch(e){ try{await client.close()}catch{}; console.error('live fetch failed',url,e.message); return []; }
}
function cached(keyPart) {
  const j = JSON.parse(fs.readFileSync('D:\\12412\\dsh-home\\storages\\mcp_connector.json','utf8'));
  const arr = Object.values(j.tables.tool_catalog);
  const e = arr.find(x=>(x.key??'').includes(keyPart)||(x.serverName??'').includes(keyPart));
  return e ? (e.tools??[]).map(t=>({name:t.name,description:t.description,inputSchema:t.inputSchema})) : [];
}
const c = loadCreds();
const github = await live('https://api.githubcopilot.com/mcp/readonly',{Authorization:`Bearer ${c.github}`});
const vercel = await live('https://mcp.vercel.com/',{Authorization:`Bearer ${c.vercel}`});
const linear = cached('linear');
const notion = cached('notion');
const all=[];
for(const [srv,tools] of [['github',github],['notion',notion],['linear',linear],['vercel',vercel]]){
  for(const t of tools) all.push({server:srv,tool:t.name,name:`${srv}__${t.name}`,description:t.description,inputSchema:t.inputSchema});
}
fs.writeFileSync('eval/tool-dataset.json', JSON.stringify(all,null,2));
console.log('saved eval/tool-dataset.json:',{github:github.length,notion:notion.length,linear:linear.length,vercel:vercel.length,total:all.length});
