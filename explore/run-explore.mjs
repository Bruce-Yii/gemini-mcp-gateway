#!/usr/bin/env node
/**
 * Exploratory test runner: feed official MCP tasks to hy4, let it use the
 * gateway (search + execute), and CAPTURE PROBLEMS (not scores).
 *
 * Flow per task:
 *   1. Ask hy4 (OpenAI-compatible) with the task + search/execute tools.
 *   2. hy4 calls search(query) / execute(code). We run them against the real
 *      gateway code (UpstreamManager) and feed results back (multi-turn).
 *   3. Record anomalies: tool errors, retries, wrong tools, empty search,
 *      execute errors, timeouts, model confusion.
 *
 * No secrets printed. Tokens read from local credential stores.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const DATASET = process.env.EXPLORE_DATASET || 'explore/tasks.json';
const MODEL_BASE = process.env.EXPLORE_MODEL_BASE || 'https://opencode.ai/zen/go/v1';
const MODEL_KEY = process.env.EXPLORE_MODEL_KEY || readOpencodeKey();

function readOpencodeKey() {
  // from DSH credentials refs
  const c = fs.readFileSync('D:\\12412\\dsh-home\\.credentials.yaml', 'utf8');
  const m = /^\s{2}OPENCODE_GO_API_KEY:\s*(.+?)\s*$/m.exec(c);
  return m ? m[1] : '';
}

// ---- upstream tokens (env only) ----
const n = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.gemini-gateway-tokens/notion.json'), 'utf8'));
const l = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.gemini-gateway-tokens/linear.json'), 'utf8'));
const cop = JSON.parse(fs.readFileSync('C:/Users/12412/.cc-switch/copilot_auth.json', 'utf8'));
process.env.GITHUB_TOKEN = Object.values(cop.accounts ?? {})[0]?.github_token ?? '';
process.env.NOTION_TOKEN = n.access_token; process.env.NOTION_REFRESH_TOKEN = n.refresh_token;
process.env.NOTION_CLIENT_ID = n.client_id; process.env.NOTION_EXPIRES_IN = String(n.expires_in);
process.env.NOTION_OBTAINED_AT = String(new Date(n.obtained_at).getTime());
process.env.LINEAR_TOKEN = l.access_token; process.env.LINEAR_REFRESH_TOKEN = l.refresh_token;
process.env.LINEAR_CLIENT_ID = l.client_id; process.env.LINEAR_EXPIRES_IN = String(l.expires_in);
process.env.LINEAR_OBTAINED_AT = String(new Date(l.obtained_at).getTime());
// Vercel token must be injected via environment, never hardcoded in the repo.
if (!process.env.VERCEL_TOKEN) {
  console.error('[explore] VERCEL_TOKEN env var required');
  process.exit(2);
}

const { UpstreamManager } = await import('../src/upstreams.js');
const { createCodeModeTools } = await import('../src/codemode.js');
const cfg = JSON.parse(fs.readFileSync('config.example.json', 'utf8'));
for (const s of cfg.servers) {
  if (s.name === 'notion') s.obtainedAtEnv = 'NOTION_OBTAINED_AT';
  if (s.name === 'linear') s.obtainedAtEnv = 'LINEAR_OBTAINED_AT';
}
// Never run Notion locally in exploration — doing so competes with the deployed
// gateway for the rotating grant and revokes it. Notion tasks are skipped here.
const EXPLORE_SERVERS = (process.env.EXPLORE_SERVERS || 'github,linear,vercel').split(',');
const activeCfg = cfg.servers.filter(s => EXPLORE_SERVERS.includes(s.name));
// Static-token auth: exploration uses the env access token directly and NEVER
// refreshes. Rotating a token locally would compete with the deployed gateway
// for the same grant and revoke it. Access tokens last ~8h — plenty for a test.
const staticAuth = {
  getAccessToken: async (_server, { envToken } = {}) => envToken,
};
const mgr = new UpstreamManager(activeCfg, { auth: staticAuth });
await mgr.connect();
const gatewayTools = createCodeModeTools(mgr); // [search, execute_read, execute]
const toolsByName = new Map(gatewayTools.map((t) => [t.name, t]));
console.error('gateway tools:', gatewayTools.map((t) => t.name).join(','));
console.error('upstreams connected:', [...mgr._clients.keys()].join(','), '| failed:', (mgr.failedServers || []).join(',') || 'none');

// ---- LLM helpers ----
async function llm(messages, tools) {
  const r = await fetch(MODEL_BASE + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${MODEL_KEY}`, 'x-opencode-session': randomUUID(), 'User-Agent': 'gateway-explore/1.0' },
    body: JSON.stringify({
      model: 'hy4', messages, tools,
      tool_choice: 'auto', max_tokens: 2000, temperature: 0, reasoning_effort: 'none',
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error('LLM ' + r.status + ': ' + (j?.error?.message ?? '').slice(0, 120));
  return j.choices?.[0]?.message ?? {};
}
function oaTool(t) {
  return { type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } };
}
const TOOLS = gatewayTools.map(oaTool);

async function runToolCall(tc) {
  const name = tc.function.name;
  let args = {}; try { args = JSON.parse(tc.function.arguments || '{}'); } catch {}
  const tool = toolsByName.get(name);
  if (!tool) return { error: 'unknown tool ' + name };
  try {
    const res = await tool.handler(args);
    const text = typeof res === 'string' ? res : JSON.stringify(res);
    return { text, result: res, name, args };
  } catch (e) {
    return { error: e.message, name, args };
  }
}

const anomalies = [];
function flag(task, type, detail) {
  anomalies.push({ task: task.id, server: task.server, category: task.category, type, detail: String(detail).slice(0, 300), prompt: task.prompt });
}

const allTasks = JSON.parse(fs.readFileSync(DATASET, 'utf8')).tasks;
const tasks = allTasks.filter(t => EXPLORE_SERVERS.includes(t.server));
const limit = Number(process.env.TASK_LIMIT || 0);
const selected = limit ? tasks.slice(0, limit) : tasks;
console.error('running', selected.length, 'tasks');

for (const task of selected) {
  const messages = [
    { role: 'system', content: 'You are testing an MCP gateway. Use the search tool to find tools, then execute to call them. For WRITE/irreversible operations, describe what you WOULD do and show the exact tool call instead of actually executing destructive actions. Be concise.' },
    { role: 'user', content: task.prompt },
  ];
  const calledTools = [];
  let finished = false;
  try {
    for (let turn = 0; turn < 6 && !finished; turn++) {
      const msg = await llm(messages, TOOLS);
      if (msg.tool_calls?.length) {
        for (const tc of msg.tool_calls) {
          const out = await runToolCall(tc);
          calledTools.push({ name: tc.function.name, args: tc.function.arguments, error: out.error || null });
          if (out.error) flag(task, 'tool_error', out.error);
          // detect execute errors from result text
          if (out.text && /"isError":true|ReferenceError|TypeError|invalid_grant|403|404|error_description/.test(out.text)) {
            flag(task, 'execute_error', out.text);
          }
          // detect empty/irrelevant search
          if (tc.function.name === 'search') {
            try { const d = JSON.parse(out.text); if (!d.matches?.length) flag(task, 'search_empty', task.prompt); } catch {}
          }
          messages.push({ role: 'assistant', tool_calls: [tc] });
          messages.push({ role: 'tool', tool_call_id: tc.id, content: out.text || out.error || '{}' });
        }
      } else {
        const content = msg.content || '';
        if (/i cannot|i'm not sure|unable to|don't have|not available/i.test(content)) flag(task, 'model_confusion', content);
        finished = true;
      }
    }
    // detect retries: same tool called >1 with different args
    const byName = {};
    for (const c of calledTools) (byName[c.name] ??= []).push(c.args);
    for (const [name, calls] of Object.entries(byName)) {
      const uniq = new Set(calls);
      if (calls.length > 1 && uniq.size > 1) flag(task, 'retry', `${name} called ${calls.length}x with ${uniq.size} different args`);
    }
    if (calledTools.length === 0) flag(task, 'no_tool_call', 'model produced no tool call');
  } catch (e) {
    flag(task, 'runner_error', e.message);
  }
  console.error(`[${task.id}] ${task.server}/${task.category} tools=${calledTools.length} anomalies=${anomalies.filter(a => a.task === task.id).length}`);
}

fs.mkdirSync('explore/results', { recursive: true });
fs.writeFileSync('explore/results/anomalies.json', JSON.stringify({ generatedAt: new Date().toISOString(), model: 'hy4', totalTasks: selected.length, anomalies }, null, 2));
console.error('\nDONE. anomalies:', anomalies.length);
const byType = {}; anomalies.forEach(a => byType[a.type] = (byType[a.type] || 0) + 1);
console.error(JSON.stringify(byType, null, 2));
await mgr.close();
