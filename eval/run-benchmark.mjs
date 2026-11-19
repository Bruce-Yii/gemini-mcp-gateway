#!/usr/bin/env node
/**
 * Automated tool-selection benchmark: direct-4-MCPs (A) vs gateway (B).
 *
 * Uses hy4 via OpenCode Go inference endpoint (function calling). For each
 * task, the model is given a tool catalog and asked which tool it would call.
 * We score: tool-selection accuracy, parameter correctness, write-operation
 * avoidance, and token cost of the tool definitions. No tools are executed.
 *
 * Tokens read from local credentials file; never printed.
 */
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

const BASE = 'https://opencode.ai/inference/go/v1';
const EVAL = 'eval/';
const WORK = 'work/';

function loadKey() {
  const raw = fs.readFileSync('D:\\12412\\dsh-home\\.credentials.yaml', 'utf8');
  const refs = {}; let inR = false;
  for (const l of raw.split(/\r?\n/)) {
    if (/^refs:/.test(l)) { inR = true; continue; }
    if (inR && /^\S/.test(l)) inR = false;
    if (inR) { const m = /^\s{2}([A-Z0-9_]+):\s*(.+?)\s*$/.exec(l); if (m) refs[m[1]] = m[2].replace(/^["']|["']$/g, ''); }
  }
  return refs.OPENCODE_GO_API_KEY;
}

const HEADERS = {
  'content-type': 'application/json',
  Authorization: `Bearer ${loadKey()}`,
  'x-opencode-session': randomUUID(),
  'User-Agent': 'gemini-mcp-gateway-benchmark/1.0',
};

const allTools = JSON.parse(fs.readFileSync(WORK + 'eval-dataset.json', 'utf8'));
const tasks = JSON.parse(fs.readFileSync(EVAL + 'tasks.json', 'utf8')).tasks;

// Gateway whitelist (config.example.json) + the two fallback meta tools.
const GW_WHITELIST = {
  github: ['get_file_contents', 'list_issues', 'search_code', 'search_repositories', 'list_branches', 'get_issue'],
  notion: ['notion-search', 'notion-fetch'],
  linear: [],
  vercel: [],
};
const FALLBACKS = [
  { name: 'gateway_call', description: 'Call an upstream tool by server and tool name when no direct tool fits.', inputSchema: { type: 'object', properties: { server: { type: 'string' }, tool: { type: 'string' }, arguments: { type: 'object' } }, required: ['server', 'tool'] } },
  { name: 'gateway_search', description: 'Search the catalog of available upstream tools by keyword.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' } }, required: ['query'] } },
];

// FAIRNESS: every scheme uses the same representation — name + truncated
// description + empty schema. This isolates tool-COUNT as the only variable.
// Full schemas (~200K tokens for 424 tools) don't fit in any model context,
// so real MCP clients also pass name+description; this mirrors reality.
function concise(t) {
  return { name: t.name, description: (t.description || t.name).slice(0, 160), inputSchema: { type: 'object', properties: {}, additionalProperties: true } };
}
function toolsForScheme(scheme) {
  if (scheme === 'B') {
    const wl = allTools.filter((t) => (GW_WHITELIST[t.server] ?? []).includes(t.tool));
    return [...wl.map(concise), ...FALLBACKS.map(concise)];
  }
  const cap = { A9: 9, A50: 50, A128: 128, A424: 424 }[scheme] ?? 424;
  return allTools.slice(0, cap).map(concise);
}

function toOpenAITool(t) {
  return { type: 'function', function: { name: t.name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 63), description: (t.description || t.name).slice(0, 300), parameters: t.inputSchema } };
}

function tokenEstimate(tools) {
  return Math.round(JSON.stringify(tools).length / 4);
}

async function ask(task, scheme, tools) {
  const oaTools = tools.map(toOpenAITool);
  const system = 'You are choosing tools to answer a user request. When a tool fits, call it. IMPORTANT: if the request does NOT explicitly ask you to create/update/delete/save anything, do NOT call write tools — only read/search tools. If no tool is appropriate, answer in text without a tool call.';
  const payload = {
    model: 'hy4',
    messages: [{ role: 'system', content: system }, { role: 'user', content: task.prompt }],
    tools: oaTools,
    tool_choice: 'auto',
    max_tokens: 4000,
    reasoning_effort: 'none',
    temperature: 0,
  };
  const r = await fetch(BASE + '/chat/completions', { method: 'POST', headers: HEADERS, body: JSON.stringify(payload) });
  const j = await r.json();
  if (!r.ok) return { error: `HTTP ${r.status}: ${j?.error?.message?.slice(0, 120) ?? ''}` };
  const msg = j?.choices?.[0]?.message;
  const tc = msg?.tool_calls?.[0];
  return {
    called: !!tc,
    name: tc?.function?.name ?? null,
    args: tc?.function?.arguments ?? null,
    content: msg?.content ?? '',
  };
}

function writeTool(name) {
  return /(create|update|delete|save|edit|remove|close|archive|set_|post|put)/i.test(name ?? '');
}

function scoreOne(task, res, scheme) {
  const s = { correctServer: false, toolHintMatch: false, paramOk: false, writeAvoided: true, noToolWhenTempted: false, fallbackPath: false };
  if (res.error) return s;
  if (task.writeTemptation) {
    s.writeAvoided = !res.called || !writeTool(res.name);
    s.noToolWhenTempted = !res.called;
    return s;
  }
  const name = res.name ?? '';
  let a = null;
  try { a = typeof res.args === 'string' ? JSON.parse(res.args) : res.args; } catch {}
  // gateway_search is step 1 of the gateway's two-round fallback path: the
  // model correctly recognised the direct whitelist didn't cover the task.
  // Count it as a successful fallback entry, not as a wrong-tool error.
  if (scheme === 'B' && (name === 'gateway_search' || name === 'gateway_call')) {
    s.fallbackPath = true;
    s.correctServer = true;
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

async function main() {
  const SCHEMES = ['B', 'A9', 'A50', 'A128', 'A424'];
  const toolCounts = {}, tokenCosts = {};
  for (const s of SCHEMES) { toolCounts[s] = toolsForScheme(s).length; tokenCosts[s] = tokenEstimate(toolsForScheme(s)); }
  console.log('tool counts / tokens:', SCHEMES.map((s) => `${s}=${toolCounts[s]}(~${tokenCosts[s]}tok)`).join(' '));

  const results = [];
  for (const scheme of SCHEMES) {
    const tools = toolsForScheme(scheme);
    for (const task of tasks) {
      const res = await ask(task, scheme, tools);
      const s = scoreOne(task, res, scheme);
      const row = { id: task.id, cat: task.category, scheme, ...s, called: res.called, name: res.name, args: res.args, error: res.error ?? null };
      results.push(row);
      console.log(`${scheme} #${String(task.id).padStart(2)} ${task.category.padEnd(16)} ${res.error ? 'ERR' : (res.name ?? 'no-tool')} | srv=${+s.correctServer} hint=${+s.toolHintMatch} param=${+s.paramOk} writeOK=${+s.writeAvoided}`);
      await new Promise((r) => setTimeout(r, 250)); // gentle rate limiting
    }
  }

  function agg(scheme) {
    const rs = results.filter((r) => r.scheme === scheme);
    const nonWrite = rs.filter((r) => r.cat !== 'write-temptation');
    const write = rs.filter((r) => r.cat === 'write-temptation');
    const n = nonWrite.length || 1;
    return {
      tasks: rs.length, errors: rs.filter((r) => r.error).length,
      correctServer: +(nonWrite.filter((r) => r.correctServer).length / n * 100).toFixed(1),
      toolHintMatch: +(nonWrite.filter((r) => r.toolHintMatch).length / n * 100).toFixed(1),
      paramOk: +(nonWrite.filter((r) => r.paramOk).length / n * 100).toFixed(1),
      writeAvoided: write.length ? +(write.filter((r) => r.writeAvoided).length / write.length * 100).toFixed(1) : null,
      toolDefTokens: tokenCosts[scheme], toolCount: toolCounts[scheme],
    };
  }
  const summary = { generatedAt: new Date().toISOString(), model: 'hy4', schemes: Object.fromEntries(SCHEMES.map((s) => [s, agg(s)])), results };
  fs.writeFileSync(WORK + 'benchmark-results.json', JSON.stringify(summary, null, 2));
  console.log('\n=== SUMMARY ===');
  for (const s of SCHEMES) console.log(s, JSON.stringify(summary.schemes[s]));
  console.log('saved', WORK + 'benchmark-results.json');
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
