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
 *   R8  worker pool: one UpstreamManager + one AnomalyCollector PER WORKER,
 *       task-scoped trace/anomaly files, 429 backoff, manifest records concurrency
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
  toolNameMatches, truncate, pickExecuteResult, classifyExecuteResult,
  countToolsByServer, applyServerCoverage,
  gitSha, sha256File, writeTrace, writeTaskAnomalies, writeManifest, writeMetrics,
  readConcurrency, runWorkerPool, mergeCollectors, withRetries, LLM_MAX_RETRIES,
} from './trace.mjs';

/**
 * L1 smoke support (Kept backward compatible):
 *   EXPLORE_SUITE=smoke  -> use explore/tasks-smoke.json instead of the default dataset
 *   EXPLORE_TASK_IDS=ID1,ID2 -> restrict to explicit ids (applied AFTER server filter)
 *   EXPLORE_SUITE=g6     -> explicit alias for explore/tasks-g6.json
 * CLI aliases: --suite=smoke|g6, --task-ids=ID1,ID2
 * With no suite/ids set, the dataset is exactly what it was before (tasks.json
 * or EXPLORE_DATASET) — existing G6 runs and evaluation artifacts are untouched.
 */
const CLI_ARGS = process.argv.slice(2);
function cliValue(name) {
  const eq = CLI_ARGS.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = CLI_ARGS.indexOf(`--${name}`);
  return i >= 0 ? CLI_ARGS[i + 1] : undefined;
}
const SUITE = cliValue('suite') ?? process.env.EXPLORE_SUITE ?? '';
const SUITE_DATASETS = {
  smoke: 'explore/tasks-smoke.json',
  g6: 'explore/tasks-g6.json',
};
if (SUITE && !SUITE_DATASETS[SUITE]) {
  console.error(`[explore] unknown suite "${SUITE}" (expected: ${Object.keys(SUITE_DATASETS).join(', ')})`);
  process.exit(2);
}
const DATASET = (SUITE && SUITE_DATASETS[SUITE]) || process.env.EXPLORE_DATASET || 'explore/tasks.json';
const TASK_IDS = (cliValue('task-ids') ?? process.env.EXPLORE_TASK_IDS ?? '')
  .split(',').map((s) => s.trim()).filter(Boolean);
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
  // Optional local convenience only. Set EXPLORE_MODEL_KEY in CI/other setups.
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const file = path.join(dshHome, '.credentials.yaml');
  try {
    const c = fs.readFileSync(file, 'utf8');
    const m = /^\s{2}OPENCODE_GO_API_KEY:\s*(.+?)\s*$/m.exec(c);
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

// ---- upstream tokens (env only; local files are a convenience, never committed) ----
const TOKEN_DIR = process.env.GEMINI_GATEWAY_TOKENS_DIR || path.join(os.homedir(), '.gemini-gateway-tokens');
function readTokenFile(file, hint) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    console.error(`[explore] cannot read ${file}: ${hint}`);
    process.exit(2);
  }
}
const n = readTokenFile(path.join(TOKEN_DIR, 'notion.json'), 'set GEMINI_GATEWAY_TOKENS_DIR or create the file');
const l = readTokenFile(path.join(TOKEN_DIR, 'linear.json'), 'set GEMINI_GATEWAY_TOKENS_DIR or create the file');
// GITHUB_TOKEN from the environment is sufficient (CI uses GH_PAT/GITHUB_TOKEN);
// only fall back to the local Copilot auth file when no env token is present.
let cop = {};
if (!process.env.GITHUB_TOKEN) {
  cop = readTokenFile(
    path.join(os.homedir(), '.cc-switch', 'copilot_auth.json'),
    'export GITHUB_TOKEN instead, or create ~/.cc-switch/copilot_auth.json',
  );
}
process.env.GITHUB_TOKEN = process.env.GITHUB_TOKEN || Object.values(cop.accounts ?? {})[0]?.github_token || '';
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
const REQUIRED_TOOLS = ['search', 'execute_read', 'execute'];
const CONCURRENCY = readConcurrency(process.env.EXPLORE_CONCURRENCY);
console.error('explore concurrency:', CONCURRENCY);

// R8: one context PER WORKER. A worker owns its UpstreamManager, tool map,
// OpenAI tool list and AnomalyCollector; no mgr is ever shared across workers.
// `SHARED.serverToolCounts` is filled once in onReady and read-only afterwards,
// so task attribution is identical regardless of which worker picks it up.
const SHARED = { serverToolCounts: {}, failedServers: [] };

async function createWorkerContext(workerIndex) {
  const mgr = new UpstreamManager(activeCfg, { auth: staticAuth });
  await mgr.connect();
  const gatewayTools = createCodeModeTools(mgr); // [search, execute_read, execute]
  // R0: index by name, never by position. Hard-fail on contract drift.
  const toolsByName = new Map(gatewayTools.map((t) => [t.name, t]));
  const toolNames = gatewayTools.map((t) => t.name);
  for (const name of REQUIRED_TOOLS) {
    if (!toolsByName.has(name)) throw new Error(`harness contract broken: ${name} missing (got: ${toolNames.join(',')})`);
  }
  // #23: how many tools this worker's servers exposed. Dominant/first worker
  // value is published via SHARED for consistent per-task attribution.
  const serverToolCounts = countToolsByServer(mgr.getEntries());
  const collector = new AnomalyCollector(DETECTOR_VERSION);
  const flag = (task, type, detail, meta) => collector.flag(
    task, type, detail,
    applyServerCoverage(meta, task.server, SHARED.serverToolCounts[task.server] ?? 0, type),
  );
  // Failed upstreams are an explicit, per-run input for hit-rate attribution.
  // Capture them on SHARED so every worker marks its task rows identically.
  const failedServers = [...(mgr.failedServers || [])];
  if (workerIndex === 0) {
    SHARED.failedServers = failedServers;
    console.error('gateway tools:', toolNames.join(','));
    console.error('upstreams connected:', [...mgr._clients.keys()].join(','), '| failed:', failedServers.join(',') || 'none');
    console.error('tools exposed per server:', JSON.stringify(serverToolCounts));
  }
  return { mgr, toolsByName, TOOLS: gatewayTools.map(oaTool), collector, flag, serverToolCounts, failedServers };
}

// ---- LLM helpers ----
const RETRYABLE_LLM_STATUS = new Set([429, 500, 502, 503, 504]);

/**
 * Free models are rate-limited. Retry 429/5xx with exponential backoff
 * (2^n seconds, n = 0..2, at most LLM_MAX_RETRIES retries). Retries are
 * tracked in `stats.infraRetries` and are NOT flagged as anomalies.
 */
async function llm(messages, tools, stats) {
  const started = Date.now();
  return withRetries(async () => {
    const r = await fetch(MODEL_BASE + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${MODEL_KEY}`, 'x-opencode-session': randomUUID(), 'User-Agent': 'gateway-explore/2.0' },
      body: JSON.stringify({
        model: MODEL, messages, tools,
        tool_choice: 'auto', max_tokens: 2000, temperature: 0, reasoning_effort: 'none',
      }),
    });
    let j = {};
    try { j = await r.json(); } catch {}
    if (!r.ok) {
      const e = new Error('LLM ' + r.status + ': ' + String(j?.error?.message ?? '').slice(0, 120));
      e.status = r.status;
      e.retryable = RETRYABLE_LLM_STATUS.has(r.status);
      throw e;
    }
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
  }, {
    retries: LLM_MAX_RETRIES,
    shouldRetry: (err) => err?.retryable === true,
    onRetry: (_err, attempt, ms) => {
      if (stats) stats.infraRetries += 1;
      console.error(`[llm] retry ${attempt + 1}/${LLM_MAX_RETRIES} after ${ms}ms`);
    },
  });
}
function oaTool(t) {
  return { type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } };
}
// R8: TOOLS and toolsByName are per-worker now (see createWorkerContext).

async function runToolCall(tc, toolsByName) {
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

// R8: collector + flag now live in each worker context (createWorkerContext).

const allTasks = JSON.parse(fs.readFileSync(DATASET, 'utf8')).tasks;
let tasks = allTasks.filter(t => EXPLORE_SERVERS.includes(t.server));
if (TASK_IDS.length) {
  const wanted = new Set(TASK_IDS);
  tasks = tasks.filter((t) => wanted.has(t.id));
  const missing = TASK_IDS.filter((id) => !tasks.some((t) => t.id === id));
  if (missing.length) {
    console.error(`[explore] task ids not found in ${DATASET} (after server filter): ${missing.join(',')}`);
    process.exit(2);
  }
}
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
  suite: SUITE || null,
  taskIds: TASK_IDS.length ? TASK_IDS : null,
  datasetSha256: sha256File(DATASET),
  configSha256: sha256File('config.example.json'),
  timestamp: startedAt,
  model: MODEL,
  modelBase: MODEL_BASE,
  servers: EXPLORE_SERVERS,
  serverToolCounts: {}, // filled from the first worker in onReady (R8)
  // Explicit input for downstream L1 smoke: which upstreams failed to connect
  // in THIS run. `scripts/run-l1-smoke.mjs` reads this to build a degraded-subset
  // baseline instead of comparing half-connected real runs to the all-connected
  // 40-task snapshot. Derived from UpstreamManager.failedServers (not guessed
  // from tool counts), so a server that connected but exposes 0 whitelisted
  // tools is NOT mislabelled as an upstream failure.
  failedServers: [], // filled from the first worker in onReady
  taskCount: selected.length,
  taskLimit: limit || null,
  toolContract: REQUIRED_TOOLS,
  detectorVersion: DETECTOR_VERSION,
  // R8: record the configured parallelism in the run manifest.
  concurrency: CONCURRENCY,
};

/**
 * Process ONE task inside one worker. All mutable state is either local or
 * owned by `ctx` (its own mgr / collector), so workers never interfere.
 */
async function runTask(task, ctx) {
  // Local aliases keep the detector body below unchanged while binding every
  // shared-looking name to this worker's private context.
  const { flag, collector, toolsByName, TOOLS, failedServers } = ctx;
  const taskStart = Date.now();
  const traceId = `${runId}:${task.id}`;
  const isBoundary = task.category === 'boundary';
  const fixtures = detectPlaceholders(task.prompt);
  const expectedTool = task.tool ?? null;
  const turnRecords = [];
  const messageTrace = [];
  const calledSigs = [];
  // #22: per-turn full tool results (name + text) used ONLY in memory for
  // name-based execute selection; traces keep bounded previews as before.
  let turnToolResults = [];
  const m = {
    task: task.id, server: task.server, category: task.category,
    official: task.official ?? null, expectedTool, fixtures,
    turns: 0, llmCalls: 0, toolCalls: 0, searchCalls: 0, executeCalls: 0,
    promptTokens: 0, completionTokens: 0, totalTokens: 0,
    llmMs: 0, toolMs: 0, maxSingleToolMs: 0, wallMs: 0,
    finished: false, finishReason: null,
    // Failed-upstream marking (explicit input from UpstreamManager.failedServers).
    // A task whose server failed to connect has no searchable tools, so it must
    // be EXCLUDED from the hit-rate denominator (not counted as a miss and not
    // silently dropped from some tasks but not others). The L1 smoke runner
    // reads this field to build a like-for-like degraded baseline.
    serverFailed: (failedServers ?? []).includes(task.server),
    searchHit: null, searchHitAt3: null, toolHit: null,
    anomalyCount: 0,
    // R8: LLM 429/5xx retries (infra, never an anomaly).
    infraRetries: 0,
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
      const llmOut = await llm(messages, TOOLS, m);
      const msg = llmOut.message;
      turnToolResults = [];
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
          const out = await runToolCall(tc, toolsByName);
          turnToolResults.push({ name: toolName, text: out.text, error: out.error });
          calledSigs.push({ name: toolName, argsKey: String(tc.function?.arguments ?? '{}') });
          m.toolCalls += 1;
          m.toolMs += out.latencyMs;
          m.maxSingleToolMs = Math.max(m.maxSingleToolMs, out.latencyMs);
          if (toolName === 'search') m.searchCalls += 1;
          if (toolName === 'execute' || toolName === 'execute_read') m.executeCalls += 1;

          if (out.error) flag(task, 'tool_error', out.error, { traceId, turnIndex: turn });

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
        // #22: classify execute errors from the execute/execute_read result
        // ONLY, matched by tool name. A search result in the same turn (whose
        // tool descriptions often contain "not found") must never become the
        // detail of an execute_error anomaly.
        const execResult = pickExecuteResult(turnToolResults);
        if (execResult) {
          const finding = classifyExecuteResult(execResult, fixtures);
          if (finding) flag(task, finding.type, finding.detail, { traceId, turnIndex: turn, ...finding.meta });
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

  // R1/R8: per-task trace + per-task anomaly file, keyed by taskId. Parallel
  // workers write distinct files, so nothing is clobbered.
  const taskAnomalies = collector.items.filter((a) => a.task === task.id)
    .map((a) => ({ type: a.type, attribution: a.attribution, occurrences: a.occurrences }));
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
      infraRetries: m.infraRetries,
    },
    messages: messageTrace,
    turns: turnRecords,
    finalAnswer: { chars: finalContent.length, preview: truncate(finalContent, 600) },
    anomalies: taskAnomalies,
  };
  writeTrace(task.id, trace);
  writeTaskAnomalies(task.id, taskAnomalies);

  console.error(`[${task.id}] ${task.server}/${task.category} tools=${m.toolCalls} tokens=${m.totalTokens} turns=${m.turns} anomalies=${m.anomalyCount}${m.infraRetries ? ` retries=${m.infraRetries}` : ''}`);
  return { m, trace };
}

// ---- R8: dispatch all tasks through the worker pool (replaces serial for) ----
const { results: taskResults, contexts: workers } = await runWorkerPool(selected, {
  concurrency: CONCURRENCY,
  initWorker: (workerIndex) => createWorkerContext(workerIndex),
  onReady: (contexts) => {
    // Publish coverage once, before any task starts, so every worker's flag()
    // applies identical server-coverage attribution.
    SHARED.serverToolCounts = contexts[0]?.serverToolCounts ?? {};
    SHARED.failedServers = contexts[0]?.failedServers ?? [];
    manifest.serverToolCounts = SHARED.serverToolCounts;
    manifest.failedServers = SHARED.failedServers;
    manifest.workerCount = contexts.length;
  },
  worker: (task, ctx) => runTask(task, ctx),
  onWorkerDone: async (ctx) => { await ctx.mgr.close(); },
});

// ---- aggregate metrics (R3/R6) ----
const metricsPerTask = taskResults.filter(Boolean).map((r) => r.m);
const summary = summarizeMetrics(metricsPerTask, { failedServers: SHARED.failedServers });
const metrics = { runId, generatedAt: new Date().toISOString(), failedServers: SHARED.failedServers, perTask: metricsPerTask, summary };

// ---- final artifacts ----
fs.mkdirSync('explore/results', { recursive: true });
const collected = mergeCollectors(workers.map((c) => c.collector));
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
  failedServers: SHARED.failedServers,
  totalTasks: selected.length,
  anomalies: collected.items,
  dedupCount: collected.dedupCount,
  rawCount: collected.rawCount,
  metrics: summary,
};
fs.writeFileSync('explore/results/anomalies.json', JSON.stringify(out, null, 2));
console.error('\nDONE. anomalies:', collected.items.length, '| deduped:', collected.dedupCount, '| raw:', collected.rawCount);
const byType = {}; collected.items.forEach(a => byType[a.type] = (byType[a.type] || 0) + 1);
const byAttr = {}; collected.items.forEach(a => byAttr[a.attribution] = (byAttr[a.attribution] || 0) + 1);
const infraRetries = metricsPerTask.reduce((s, r) => s + (r.infraRetries || 0), 0);
console.error('byType', JSON.stringify(byType));
console.error('byAttribution', JSON.stringify(byAttr));
console.error('infraRetries', infraRetries);
console.error('metrics', JSON.stringify(summary));

/* ---------------- helpers (hoisted function declarations) ---------------- */

/**
 * Hit-rate denominators (see docs/eval/L1-SMOKE.md "Hit-rate denominator").
 *
 * For a task to be in the hit-rate denominator it must (a) have an expectedTool
 * and (b) belong to a server that CONNECTED in this run (`serverFailed !== true`).
 * A failed-server task is excluded from BOTH numerator and denominator — it is
 * a skipped upstream, never a gateway miss. Counting it as a miss when the
 * model happened to call search and dropping it when the model did not call
 * search (the old null-exclusion rule) made the rate depend on model whim.
 *
 *   measurable = rows.filter(r => r.expectedTool && !r.serverFailed)
 *   searchHitRate  = count(measurable, r.searchHit === true) / |measurable| * 100
 *   searchHitAt3Rate = count(measurable, r.searchHitAt3 === true) / |measurable| * 100
 *   toolHitRate    = count(measurable, r.toolHit === true) / |measurable| * 100
 *
 * `null` (search/execute never called) is a MISS for a measurable task: the
 * gateway did not surface the expected tool in that task, regardless of
 * whether the model chose to call a tool. The legacy raw rates (null excluded,
 * failed servers included) remain in `toolRecallRaw` for backward comparison.
 */
function summarizeMetrics(rows, { failedServers = [] } = {}) {
  const n = rows.length || 1;
  const num = (k) => rows.reduce((s, r) => s + (Number(r[k]) || 0), 0);
  const avg = (k) => Math.round((num(k) / n) * 100) / 100;
  const pct = (hit, total) => total ? Math.round((hit / total) * 1000) / 10 : null;

  const failed = new Set(failedServers);
  const isFailed = (r) => r.serverFailed === true || failed.has(r.server);
  const withTool = rows.filter((r) => r.expectedTool);
  const measurable = withTool.filter((r) => !isFailed(r));
  const skippedByServer = {};
  for (const r of withTool.filter(isFailed)) {
    skippedByServer[r.server] = (skippedByServer[r.server] ?? 0) + 1;
  }

  // Legacy raw view: null-excluded denominator, failed servers NOT excluded.
  // Kept unchanged so old consumers/dashboards do not break; do not use it to
  // judge gateway quality when any upstream failed.
  const searchHitRows = withTool.filter((r) => r.searchHit !== null && r.searchHit !== undefined);
  const toolHitRows = withTool.filter((r) => r.toolHit !== null && r.toolHit !== undefined);

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
    // R8: LLM 429/5xx retries are infra signals, not anomalies.
    infraRetries: num('infraRetries'),
    // Failed-server marking: explicit input, never inferred from tool counts.
    failedServers: [...failed],
    skippedByServer,
    toolRecall: {
      tasksWithExpectedTool: withTool.length,
      denominatorTasks: measurable.length,
      denominatorFormula: 'expectedTool && !serverFailed; null counts as miss',
      searchHitRate: pct(measurable.filter((r) => r.searchHit === true).length, measurable.length),
      searchHitAt3Rate: pct(measurable.filter((r) => r.searchHitAt3 === true).length, measurable.length),
      toolHitRate: pct(measurable.filter((r) => r.toolHit === true).length, measurable.length),
    },
    toolRecallRaw: {
      note: 'LEGACY: null excluded from denominator, failed servers included; not like-for-like when upstreams fail',
      searchHitDenominator: searchHitRows.length,
      toolHitDenominator: toolHitRows.length,
      searchHitRate: pct(searchHitRows.filter((r) => r.searchHit === true).length, searchHitRows.length),
      searchHitAt3Rate: pct(searchHitRows.filter((r) => r.searchHitAt3 === true).length, searchHitRows.length),
      toolHitRate: pct(toolHitRows.filter((r) => r.toolHit === true).length, toolHitRows.length),
    },
  };
}
