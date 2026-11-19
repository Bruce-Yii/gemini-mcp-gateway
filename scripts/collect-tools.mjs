#!/usr/bin/env node
/**
 * Collect real tool schemas from the 4 upstream MCP servers into data/tool-dataset.json.
 * Run by measure-context.mjs's prerequisite. Tokens from env/local config, never printed.
 *
 * GitHub/Vercel: live remote MCP (Streamable HTTP).
 * Linear/Notion: DSH's cached tool catalog (avoids needing live OAuth tokens).
 */
import fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

function ccSwitchGithubToken() {
  const f = `${process.env.USERPROFILE ?? process.env.HOME}/.cc-switch/copilot_auth.json`;
  if (!fs.existsSync(f)) return '';
  try {
    const cop = JSON.parse(fs.readFileSync(f, 'utf8'));
    return Object.values(cop.accounts ?? {})[0]?.github_token ?? '';
  } catch { return ''; }
}
function dshCached(keyPart) {
  const f = 'D:\\12412\\dsh-home\\storages\\mcp_connector.json';
  if (!fs.existsSync(f)) return [];
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  const arr = Object.values(j.tables?.tool_catalog ?? {});
  const e = arr.find((x) => (x.key ?? '').includes(keyPart) || (x.serverName ?? '').includes(keyPart));
  return e ? (e.tools ?? []).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) : [];
}
async function live(url, headers) {
  if (!url) return [];
  const client = new Client({ name: 'tool-collector', version: '1' });
  const t = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } });
  try {
    await client.connect(t);
    const { tools } = await client.listTools();
    await client.close();
    return tools.map((x) => ({ name: x.name, description: x.description, inputSchema: x.inputSchema }));
  } catch (e) {
    try { await client.close(); } catch {}
    console.error(`[collect-tools] failed ${url}: ${e.message}`);
    return [];
  }
}

const github = await live('https://api.githubcopilot.com/mcp/', { Authorization: `Bearer ${ccSwitchGithubToken()}` });
const vercel = await live('https://mcp.vercel.com/', process.env.VERCEL_TOKEN ? { Authorization: `Bearer ${process.env.VERCEL_TOKEN}` } : {});
const linear = dshCached('linear');
const notion = dshCached('notion');
const all = [];
for (const [srv, tools] of [['github', github], ['notion', notion], ['linear', linear], ['vercel', vercel]]) {
  for (const t of tools) all.push({ server: srv, tool: t.name, name: `${srv}__${t.name}`, description: t.description, inputSchema: t.inputSchema });
}
fs.mkdirSync('data', { recursive: true });
fs.writeFileSync('data/tool-dataset.json', JSON.stringify(all, null, 2));
console.log('[collect-tools] saved data/tool-dataset.json', { github: github.length, notion: notion.length, linear: linear.length, vercel: vercel.length, total: all.length });
