#!/usr/bin/env node
/**
 * Exploratory test runner: feed official MCP tasks to hy4, let it use the
 * gateway (search + execute), and CAPTURE PROBLEMS (not scores).
 *
 * Improvements (see work/harness-improvements.md):
 *   R0  tool contract by name (search / execute_read / execute) + hard fail
 *   R1  per-task trace (structure only) + run manifest
 *   R2  anomaly dedup (task+type+detail[:80]) with occurrences + attribution
 *   R3  token / latency / turn metrics
 *   R4  placeholder (fixture) 404s -> synthetic_data, not gateway defects
 *   R5  extra detectors: direct_answer / max_turns_exceeded / token_anomaly
 *   R6  tool-recall metrics from the task's `tool` field vs search results
 *
 * No secrets or full raw token text are printed or persisted. Tokens are read
 * from local credential stores; traces only keep bounded structural previews.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  AnomalyCollector, DETECTOR_VERSION, detectPlaceholders,
  isNotFound, isInfraError, toolNameMatches, truncate,
  gitSha, sha256File, writeTrace, writeManifest, writeMetrics,
} from './trace.mjs';

const DATASET = process.env.EXPLORE_DATASET || 'explore/tasks.json';
const MODEL = process.env.EXPLORE_MODEL || 'hy4-flash-free'; // FREE model — never the paid hy4
// Use the FREE Go endpoint. The /inference/openai/v1 endpoint is METERED (and
// rate-limits hard) — never use it for bulk exploration. Fail fast if someone
// overrides to a metered endpoint or a non-free model by accident.
const MODEL_BASE = process.env.EXPLORE_MODEL_BASE || 'https://opencode.ai/zen/go/v1';
if (/\/inference\/openai\//.test(MODEL_BASE) || !/free/.test(MODEL)) {
  throw new Error(`[explore] Refusing non-free model/endpoint: ${MODEL} @ ${MODEL_BASE}. Bulk tests must use a free model on the Go endpoint.`);
}
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
const EXPLORE_SERVERS = (process.env.EXPLORE_SERVERS || 'github,linear,vercel').split(',');
const activeCfg = cfg.servers.filter(s => EXPLORE_SERVERS.includes(s.name));
// Static-token auth: exploration uses the env access token directly and NEVER
// refreshes, to avoid competing with the deployed gateway for the same grant.
const staticAuth = {
  getAccessToken: async (_server, { envToken } = {}) => envToken,
};
const mgr = new UpstreamManager(activeCfg, { auth: staticAuth });
await mgr.connect();
const gatewayTools = createCodeModeTools(mgr); // [search, execute_read, execute]
// R0: index by name, never by position. Hard-fail on contract drift.
const toolsByName = new Map(gatewayTools.map((t) => [t.name, t]));
const TOOL_NAMES = gatewayTools.map((t) => t.name);
const REQUIRED_TOOLS = ['search', 'execute_read', 'execute'];
for (const name of REQUIRED_TOOLS) {
  if (!toolsByName.has(name)) throw new Error(`harness contract broken: ${name} missing (got: ${TOOL_NAMES.join(',')})`);
}
console.error('gateway tools:', TOOL_NAMES.join(','));
console.error('upstreams connected:', [...mgr._clients.keys()].join(','), '| failed:', (mgr.failedServers || []).join(',') || 'none');

// ---- LLM helpers ----
async function llm(messages, tools) {
  const started = Date.now();
  const r = await fetch(MODEL_BASE + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${MODEL_KEY}`, 'x-opencode-session': randomUUID(), 'User-Agent': 'gateway-explore/2.0' },
    body: JSON.stringify({
      model: MODEL, messages, tools,
      tool_choice: 'auto', max_tokens: 2000, temperature: 0, reasoning_effort: 'none',
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error('LLM ' + r.status + ': ' + (j?.error?.message ?? '').slice(0, 120));
  const usage = j.usage ?? {};
  return {
    message: j.choices?.[0]?.message ?? {},
    usage: {
      prompt_tokens: usage.prompt_tokens ?? usage.promptTokens ?? 0,
      completion_tokens: usage.completion_tokens ?? usage.completionTokens ?? 0,
      total_tokens: usage.total_tokens ?? usage.totalTokens ?? 0,
    },
    finishReason: j.choices?.[0]?.finish_reason ?? null,
    latencyMs: Date.now() - started,
  };
}
function oaTool(t) {
  return { type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } };
}
const TOOLS = gatewayTools.map(oaTool);

async function runToolCall(tc) {
  const name = tc.function.name;
  let args = {}; try { args = JSON.parse(tc.function.arguments || '{}'); } catch {}
  const tool = toolsByName.get(name);
  if (!tool) return { error: 'unknown tool ' + name, name, args, latencyMs: 0 };
  const started = Date.now();
  try {
    const res = await tool.handler(args);
    const text = typeof res === 'string' ? res : JSON.stringify(res);
    const isError = /"isError":true/i.test(text);
    const innerToolCalls = Array.isArray(res?.toolCalls) ? res.toolCalls.map((c) => c.name) : [];
    return { text, result: res, name, args, isError, innerToolCalls, latencyMs: Date.now() - started };
  } catch (e) {
    return { error: e.message, name, args, latencyMs: Date.now() - started };
  }
}

const collector = new AnomalyCollector(DETECTOR_VERSION);
const flag = (task, type, detail, meta) => collector.flag(task, type, detail, meta);

const allTasks = JSON.parse(fs.readFileSync(DATASET, 'utf8')).tasks;
const tasks = allTasks.filter(t => EXPLORE_SERVERS.includes(t.server));
const limit = Number(process.env.TASK_LIMIT || 0);
const selected = limit ? tasks.slice(0, limit) : tasks;
console.error('running', selected.length, 'tasks');

// ---- run manifest (R1) ----
const runId = `run-${Date.now()}-${randomUUID().slice(0, 8)}`;
const startedAt = new Date().toISOString();
const manifest = {
  runId,
  generatedAt: startedAt,
  gitSha: gitSha(),
  dataset: DATASET,
  datasetSha256: sha256File(DATASET),
  configSha256: sha256File('config.example.json'),
  timestamp: startedAt,
  model: MODEL,
  modelBase: MODEL_BASE,
  servers: EXPLORE_SERVERS,
  taskCount: selected.length,
  taskLimit: limit || null,
  toolContract: TOOL_NAMES,
  detectorVersion: DETECTOR_VERSION,
};

const metricsPerTask = [];

for (const task of selected) {
  const taskStart = Date.now();
  const traceId = `${runId}:${task.id}`;
  const isBoundary = task.category === 'boundary';
  const fixtures = detectPlaceholders(task.prompt);
  const expectedTool = task.tool ?? null;
  const turnRecords = [];
  const messageTrace = [];
  const calledSigs = [];
  const m = {
    task: task.id, server: task.server, category: task.category,
    official: task.official ?? null, expectedTool, fixtures,
    turns: 0, llmCalls: 0, toolCalls: 0, searchCalls: 0, executeCalls: 0,
    promptTokens: 0, completionTokens: 0, totalTokens: 0,
    llmMs: 0, toolMs: 0, maxSingleToolMs: 0, wallMs: 0,
    finished: false, finishReason: null,
    searchHit: null, searchHitAt3: null, toolHit: null,
    anomalyCount: 0,
  };

  const messages = [
    { role: 'system', content: 'You are testing an MCP gateway. Use the search tool to find tools, then call execute_read for read-only exploration or execute for writes. For WRITE/irreversible operations, describe what you WOULD do and show the exact tool call instead of actually executing destructive actions. Be concise.' },
    { role: 'user', content: task.prompt },
  ];
  messageTrace.push({ role: 'system', contentChars: messages[0].content.length, contentPreview: truncate(messages[0].content, 200) });
  messageTrace.push({ role: 'user', contentChars: task.prompt.length, contentPreview: truncate(task.prompt, 300) });

  let finished = false;
  let finalContent = '';
  const MAX_TURNS = 6;
  try {
    for (let turn = 0; turn < MAX_TURNS && !finished; turn++) {
      const llmOut = await llm(messages, TOOLS);
      const msg = llmOut.message;
      m.llmCalls += 1;
      m.promptTokens += llmOut.usage.prompt_tokens;
      m.completionTokens += llmOut.usage.completion_tokens;
      m.totalTokens += llmOut.usage.total_tokens;
      m.llmMs += llmOut.latencyMs;
      m.finishReason = llmOut.finishReason;

      const record = {
        turnIndex: turn,
        requestedAt: new Date().toISOString(),
        latencyMs: llmOut.latencyMs,
        finishReason: llmOut.finishReason,
        usage: llmOut.usage,
        llmMessage: {
          role: msg.role ?? 'assistant',
          contentChars: (msg.content ?? '').length,
          contentPreview: truncate(msg.content, 300),
          toolCalls: (msg.tool_calls ?? []).map((tc) => ({
            id: tc.id, name: tc.function?.name,
            argsPreview: truncate(tc.function?.arguments, 300),
          })),
        },
        toolResults: [],
      };

      if (msg.tool_calls?.length) {
        for (const tc of msg.tool_calls) {
          const toolName = tc.function.name;
          const out = await runToolCall(tc);
          calledSigs.push({ name: toolName, argsKey: String(tc.function?.arguments ?? '{}') });
          m.toolCalls += 1;
          m.toolMs += out.latencyMs;
          m.maxSingleToolMs = Math.max(m.maxSingleToolMs, out.latencyMs);
          if (toolName === 'search') m.searchCalls += 1;
          if (toolName === 'execute' || toolName === 'execute_read') m.executeCalls += 1;

          if (out.error) flag(task, 'tool_error', out.error, { traceId, turnIndex: turn });

          // R4: fixture 404s are synthetic, not gateway defects.
          // Bare "404"/"403" are NOT an error signal (they appear in normal
          // result text such as URLs or issue bodies); require an explicit
          // error marker so successful results are not misclassified.
          if (out.text && /"isError":true|ReferenceError|TypeError|invalid_grant|error_description|execute error|404\s+not\s+found|\bnot found\b|no commit found|does not exist|403\s+forbidden|unauthorized/i.test(out.text)) {
            if (fixtures.length && isNotFound(out.text)) {
              flag(task, 'execute_error', out.text, {
                traceId, turnIndex: turn,
                attribution: 'synthetic_data', syntheticData: true, isGatewayDefect: false,
                subtype: 'placeholder_404', rootCause: 'not found (synthetic placeholder)',
                note: `fixture tokens: ${fixtures.join(', ')}`,
              });
            } else if (isInfraError(out.text) && out.text.includes('429')) {
              flag(task, 'infra_error', out.text, { traceId, turnIndex: turn, attribution: 'infra', note: 'upstream rate limit / server error' });
            } else {
              flag(task, 'execute_error', out.text, { traceId, turnIndex: turn });
            }
          }

          // tool-recall metrics (R6): compare search matches with expected tool.
          if (toolName === 'search') {
            try {
              const d = JSON.parse(out.text);
              const matches = Array.isArray(d.matches) ? d.matches : [];
              if (!matches.length) flag(task, 'search_empty', task.prompt, { traceId, turnIndex: turn });
              if (expectedTool) {
                const hit = matches.some((x) => toolNameMatches(x?.name, expectedTool));
                const hit3 = matches.slice(0, 3).some((x) => toolNameMatches(x?.name, expectedTool));
                m.searchHit = m.searchHit === null ? hit : (m.searchHit || hit);
                m.searchHitAt3 = m.searchHitAt3 === null ? hit3 : (m.searchHitAt3 || hit3);
              }
              record.searchMatches = matches.map((x) => x?.name).filter(Boolean);
            } catch {}
          }
          // toolHit from execute code (R6, weak diagnostic).
          if (expectedTool && (toolName === 'execute' || toolName === 'execute_read')) {
            const code = String(out.args?.code ?? '');
            const names = [...code.matchAll(/codemode\.([\w$]+)/g)].map((x) => x[1].toLowerCase());
            const hit = names.some((nm) => nm.includes(expectedTool.toLowerCase()));
            m.toolHit = m.toolHit === null ? hit : (m.toolHit || hit);
          }

          record.toolResults.push({
            name: toolName,
            argsPreview: truncate(tc.function?.arguments, 300),
            error: out.error ?? null,
            isError: out.isError ?? null,
            resultChars: (out.text ?? '').length,
            resultPreview: truncate(out.text, 300),
            latencyMs: out.latencyMs,
            innerToolCalls: out.innerToolCalls ?? [],
          });
          messageTrace.push({ role: 'assistant', toolCalls: [{ id: tc.id, name: toolName, argsPreview: truncate(tc.function?.arguments, 300) }] });
          messageTrace.push({ role: 'tool', tool_call_id: tc.id, name: toolName, contentChars: (out.text || out.error || '{}').length, contentPreview: truncate(out.text || out.error || '{}', 300) });
          messages.push({ role: 'assistant', tool_calls: [tc] });
          messages.push({ role: 'tool', tool_call_id: tc.id, content: out.text || out.error || '{}' });
        }
      } else {
        finalContent = msg.content || '';
        if (/i cannot|i'm not sure|unable to|don't have|not available|i'm sorry|not supported/i.test(finalContent)) {
          if (isBoundary) {
            flag(task, 'model_confusion', finalContent, {
              traceId, turnIndex: turn, attribution: 'expected_behavior', expectedBehavior: true,
              isGatewayDefect: false, note: 'boundary task: refusal is the correct behavior',
            });
          } else {
            flag(task, 'model_confusion', finalContent, { traceId, turnIndex: turn });
          }
        }
        messageTrace.push({ role: 'assistant', contentChars: finalContent.length, contentPreview: truncate(finalContent, 300) });
        finished = true;
      }
      m.turns += 1;
      turnRecords.push(record);
      if (llmOut.finishReason === 'length' || llmOut.usage.completion_tokens > 1500) {
        flag(task, 'token_anomaly', `finish_reason=${llmOut.finishReason} completionTokens=${llmOut.usage.completion_tokens} after ${turn + 1} turns`, {
          traceId, turnIndex: turn, attribution: 'model', note: 'response near/over token limit',
        });
      }
    }
  } catch (e) {
    flag(task, 'runner_error', e.message, { traceId, attribution: 'harness', note: truncate(e.stack, 400) });
  }

  // R5: ran out of turns without a final answer.
  if (!finished && m.llmCalls > 0) {
    flag(task, 'max_turns_exceeded', `no final answer after ${MAX_TURNS} turns`, { traceId, attribution: 'model', note: 'silent truncation of exploration' });
  }
  // R5: context explosion — a single turn injected >12000 new tokens.
  // (Absolute total is NOT used: the 3-tool system prompt alone is ~18k.)
  let prevTotal = 0, maxDelta = 0;
  for (const r of turnRecords) {
    const t = r.usage?.total_tokens ?? 0;
    maxDelta = Math.max(maxDelta, t - prevTotal);
    prevTotal = t;
  }
  m.maxTurnTokenDelta = maxDelta;
  if (maxDelta > 12000) {
    flag(task, 'token_anomaly', `single turn added ${maxDelta} tokens`, { traceId, attribution: 'model', note: 'context explosion from tool result' });
  }
  // R5: direct answer (bypassing the gateway) for non-boundary tasks.
  if (finalContent.length > 200 && m.toolCalls === 0 && !isBoundary) {
    flag(task, 'direct_answer', finalContent, { traceId, attribution: 'model', note: 'long confident answer with zero tool calls' });
  }

  // R5/R2: retries by name+arg signature, and no-tool-call (boundary aware).
  const byName = {};
  for (const r of calledSigs) (byName[r.name] ??= []).push(r.argsKey);
  for (const [name, calls] of Object.entries(byName)) {
    const uniq = new Set(calls);
    if (calls.length > 1 && uniq.size > 1) flag(task, 'retry', `${name} called ${calls.length}x with ${uniq.size} different args`, { traceId });
  }
  if (m.toolCalls === 0) {
    if (isBoundary) {
      flag(task, 'no_tool_call', 'model produced no tool call', {
        traceId, attribution: 'expected_behavior', expectedBehavior: true, isGatewayDefect: false,
        note: 'boundary task: no tool call can be a correct refusal',
      });
    } else {
      flag(task, 'no_tool_call', 'model produced no tool call', { traceId });
    }
  }

  m.anomalyCount = collector.items.filter((a) => a.task === task.id).length;
  m.wallMs = Date.now() - taskStart;
  metricsPerTask.push(m);

  // R1: per-task trace (structure only, bounded previews).
  const trace = {
    traceId, runId, taskId: task.id, server: task.server, category: task.category,
    official: task.official ?? null, expectedTool, fixtures,
    prompt: task.prompt,
    startedAt: new Date(taskStart).toISOString(), finishedAt: new Date().toISOString(),
    wallMs: m.wallMs, finished, turnCount: m.turns,
    summary: {
      llmCalls: m.llmCalls, toolCalls: m.toolCalls, searchCalls: m.searchCalls,
      executeCalls: m.executeCalls, totalTokens: m.totalTokens,
      searchHit: m.searchHit, searchHitAt3: m.searchHitAt3, toolHit: m.toolHit,
    },
    messages: messageTrace,
    turns: turnRecords,
    finalAnswer: { chars: finalContent.length, preview: truncate(finalContent, 600) },
    anomalies: collector.items.filter((a) => a.task === task.id).map((a) => ({ type: a.type, attribution: a.attribution, occurrences: a.occurrences })),
  };
  writeTrace(task.id, trace);

  console.error(`[${task.id}] ${task.server}/${task.category} tools=${m.toolCalls} tokens=${m.totalTokens} turns=${m.turns} anomalies=${m.anomalyCount}`);
}

// ---- aggregate metrics (R3/R6) ----
const summary = summarizeMetrics(metricsPerTask);
const metrics = { runId, generatedAt: new Date().toISOString(), perTask: metricsPerTask, summary };

// ---- final artifacts ----
fs.mkdirSync('explore/results', { recursive: true });
const collected = collector.toJSON();
manifest.finishedAt = new Date().toISOString();
manifest.anomalyRawCount = collected.rawCount;
manifest.anomalyDedupCount = collected.dedupCount;
writeManifest(manifest);
writeMetrics(metrics);
const out = {
  generatedAt: new Date().toISOString(),
  runId,
  model: MODEL,
  manifest,
  totalTasks: selected.length,
  anomalies: collected.anomalies,
  dedupCount: collected.dedupCount,
  rawCount: collected.rawCount,
  metrics: summary,
};
fs.writeFileSync('explore/results/anomalies.json', JSON.stringify(out, null, 2));
console.error('\nDONE. anomalies:', collected.anomalies.length, '| deduped:', collected.dedupCount, '| raw:', collected.rawCount);
const byType = {}; collected.anomalies.forEach(a => byType[a.type] = (byType[a.type] || 0) + 1);
const byAttr = {}; collected.anomalies.forEach(a => byAttr[a.attribution] = (byAttr[a.attribution] || 0) + 1);
console.error('byType', JSON.stringify(byType));
console.error('byAttribution', JSON.stringify(byAttr));
console.error('metrics', JSON.stringify(summary));
await mgr.close();

/* ---------------- helpers (hoisted function declarations) ---------------- */
function summarizeMetrics(rows) {
  const n = rows.length || 1;
  const num = (k) => rows.reduce((s, r) => s + (Number(r[k]) || 0), 0);
  const avg = (k) => Math.round((num(k) / n) * 100) / 100;
  const withTool = rows.filter((r) => r.expectedTool);
  const searchHitRows = rows.filter((r) => r.searchHit !== null);
  const toolHitRows = rows.filter((r) => r.toolHit !== null);
  return {
    tasks: rows.length,
    turns: { sum: num('turns'), mean: avg('turns') },
    llmCalls: { sum: num('llmCalls'), mean: avg('llmCalls') },
    toolCalls: { sum: num('toolCalls'), mean: avg('toolCalls') },
    tokens: {
      promptTokens: { sum: num('promptTokens'), mean: avg('promptTokens') },
      completionTokens: { sum: num('completionTokens'), mean: avg('completionTokens') },
      totalTokens: { sum: num('totalTokens'), mean: avg('totalTokens') },
    },
    latencyMs: { llmMs: num('llmMs'), toolMs: num('toolMs'), maxSingleToolMs: Math.max(0, ...rows.map((r) => r.maxSingleToolMs)), wallMs: num('wallMs') },
    toolRecall: {
      tasksWithExpectedTool: withTool.length,
      searchHitRate: searchHitRows.length ? Math.round((searchHitRows.filter((r) => r.searchHit).length / searchHitRows.length) * 1000) / 10 : null,
      searchHitAt3Rate: searchHitRows.length ? Math.round((searchHitRows.filter((r) => r.searchHitAt3).length / searchHitRows.length) * 1000) / 10 : null,
      toolHitRate: toolHitRows.length ? Math.round((toolHitRows.filter((r) => r.toolHit).length / toolHitRows.length) * 1000) / 10 : null,
    },
  };
}
