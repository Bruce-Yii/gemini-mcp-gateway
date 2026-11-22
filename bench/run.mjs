#!/usr/bin/env node
/**
 * Model-in-loop benchmark harness.
 *
 * Starts the gateway against the bundled fake upstream (or connects to
 * `--gateway <url>`), gives an OpenAI-compatible chat model the three gateway
 * tools, and runs the tasks in `bench/tasks.json`. For each task it reports:
 *
 *   - pass/fail (deterministic checks declared in the task file)
 *   - turns, gateway tool calls, model tokens (from the API usage field)
 *   - wall-clock latency
 *
 * This measures the *harness path* end to end (model -> gateway -> upstream ->
 * model). The bundled tasks use the deterministic fake upstream, so they are a
 * smoke benchmark, not a quality score for real upstreams. Point
 * `--gateway https://.../mcp --token ...` at a real deployment and supply your
 * own task file to measure real usage.
 *
 * Usage:
 *   BENCH_MODEL=... BENCH_MODEL_KEY=... BENCH_MODEL_BASE=https://.../v1 \
 *     node bench/run.mjs [--tasks bench/tasks.json] [--max-turns 6]
 *   node bench/run.mjs --dry-run          # no model calls; check gateway + tasks
 *   node bench/run.mjs --gateway https://host/mcp --token "$TOKEN" \
 *     --tasks my-tasks.json               # external gateway (static bearer)
 *
 * No secrets are printed. Results are written to bench/results.json.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const valueArg = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};

const DRY_RUN = flag('--dry-run');
const TASKS_FILE = path.resolve(valueArg('--tasks', path.join(root, 'bench', 'tasks.json')));
const MAX_TURNS = Number(valueArg('--max-turns', '6'));
const GATEWAY_URL = valueArg('--gateway', null);
const GATEWAY_TOKEN = valueArg('--token', process.env.BENCH_GATEWAY_TOKEN ?? '');
const MODEL_BASE = (process.env.BENCH_MODEL_BASE ?? '').replace(/\/+$/, '');
const MODEL = process.env.BENCH_MODEL ?? '';
const MODEL_KEY = process.env.BENCH_MODEL_KEY ?? '';
const MODEL_MAX_TOKENS = Number(process.env.BENCH_MAX_TOKENS ?? '2000');
let EXTRA_HEADERS = {};
try { EXTRA_HEADERS = JSON.parse(process.env.BENCH_MODEL_HEADERS ?? '{}'); } catch { die('BENCH_MODEL_HEADERS must be a JSON object'); }

function die(message, code = 2) {
  console.error(`[bench] ${message}`);
  process.exit(code);
}

const tasks = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
if (!Array.isArray(tasks.tasks) || tasks.tasks.length === 0) die(`${TASKS_FILE} has no tasks`);

if (!DRY_RUN) {
  if (!MODEL_BASE || !MODEL || !MODEL_KEY) {
    die('set BENCH_MODEL_BASE (OpenAI-compatible /v1), BENCH_MODEL and BENCH_MODEL_KEY; or use --dry-run');
  }
}

let gatewayProcess = null;

function startFakeGateway() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/server.js', '--config', 'bench/config.fake.json', '--port', '0'], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    gatewayProcess = child;
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('gateway did not start within 20s')), 20_000);
    const onData = (chunk) => {
      buffer += chunk.toString();
      const match = /Streamable HTTP endpoint: (http:\/\/127\.0\.0\.1:\d+\/mcp)/.exec(buffer);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`gateway exited early (code ${code}): ${buffer.slice(-500)}`));
    });
  });
}

async function connectGateway(url) {
  const options = GATEWAY_TOKEN ? { requestInit: { headers: { Authorization: `Bearer ${GATEWAY_TOKEN}` } } } : {};
  const client = new Client({ name: 'bench', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), options));
  const { tools } = await client.listTools();
  if (tools.length !== 3) throw new Error(`expected 3 gateway tools, got ${tools.length}: ${tools.map((t) => t.name).join(', ')}`);
  return { client, tools };
}

function toOpenAiTools(tools) {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description ?? '',
      parameters: tool.inputSchema ?? { type: 'object', properties: {} },
    },
  }));
}

function toolResultText(result) {
  const blocks = Array.isArray(result?.content) ? result.content : [];
  const text = blocks.filter((block) => block?.type === 'text').map((block) => block.text).join('\n');
  return (text || JSON.stringify(result)).slice(0, 8000);
}

async function chat(messages, tools) {
  const response = await fetch(`${MODEL_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${MODEL_KEY}`,
      'User-Agent': 'gateway-bench/1.0',
      // OpenCode Go routes requests by session id; harmless for other endpoints.
      ...(/opencode\.ai/.test(MODEL_BASE) ? { 'x-opencode-session': randomUUID() } : {}),
      ...EXTRA_HEADERS,
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      tools,
      tool_choice: 'auto',
      temperature: 0,
      ...(Number.isFinite(MODEL_MAX_TOKENS) && MODEL_MAX_TOKENS > 0 ? { max_tokens: MODEL_MAX_TOKENS } : {}),
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`model endpoint HTTP ${response.status}: ${body.slice(0, 500)}`);
  }
  return response.json();
}

function checkAnswer(answer, checks = []) {
  const text = String(answer ?? '');
  for (const check of checks) {
    if (check.contains !== undefined) {
      const needles = Array.isArray(check.contains) ? check.contains : [check.contains];
      if (!needles.some((needle) => text.includes(needle))) return `missing "${needles.join('" or "')}"`;
    }
    if (check.notContains !== undefined) {
      const needles = Array.isArray(check.notContains) ? check.notContains : [check.notContains];
      if (needles.some((needle) => text.includes(needle))) return `contains forbidden "${needles.join('" or "')}"`;
    }
    if (check.regex !== undefined && !new RegExp(check.regex, 'i').test(text)) return `does not match /${check.regex}/`;
  }
  return null;
}

async function runTask(client, tools, task, toolsForModel) {
  const started = Date.now();
  let turns = 0;
  let toolCalls = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  const messages = [{ role: 'user', content: task.prompt }];
  const trace = [];

  while (turns < MAX_TURNS) {
    turns += 1;
    const payload = await chat(messages, toolsForModel);
    const usage = payload.usage ?? {};
    promptTokens += Number(usage.prompt_tokens ?? 0);
    completionTokens += Number(usage.completion_tokens ?? 0);
    const message = payload.choices?.[0]?.message ?? {};
    const calls = message.tool_calls ?? [];
    if (calls.length === 0) {
      const answer = message.content ?? '';
      const failure = checkAnswer(answer, task.checks);
      return {
        id: task.id,
        pass: failure === null,
        reason: failure,
        answer: answer.slice(0, 2000),
        turns,
        toolCalls,
        promptTokens,
        completionTokens,
        latencyMs: Date.now() - started,
        trace,
      };
    }
    messages.push(message);
    for (const call of calls) {
      toolCalls += 1;
      let result;
      try {
        result = await client.callTool({ name: call.function.name, arguments: JSON.parse(call.function.arguments ?? '{}') });
      } catch (error) {
        result = { content: [{ type: 'text', text: `gateway error: ${error.message}` }], isError: true };
      }
      const text = toolResultText(result);
      trace.push({ tool: call.function.name, args: call.function.arguments, chars: text.length, isError: Boolean(result?.isError) });
      messages.push({ role: 'tool', tool_call_id: call.id, content: text });
    }
  }

  return {
    id: task.id,
    pass: false,
    reason: `max turns (${MAX_TURNS}) exceeded`,
    answer: '',
    turns,
    toolCalls,
    promptTokens,
    completionTokens,
    latencyMs: Date.now() - started,
    trace,
  };
}

function printSummary(results) {
  const total = results.length;
  const passed = results.filter((result) => result.pass).length;
  const calls = results.reduce((sum, result) => sum + result.toolCalls, 0);
  const promptTokens = results.reduce((sum, result) => sum + result.promptTokens, 0);
  const completionTokens = results.reduce((sum, result) => sum + result.completionTokens, 0);
  const latency = results.reduce((sum, result) => sum + result.latencyMs, 0);
  console.log('');
  console.log(`tasks: ${total}  passed: ${passed} (${((passed / total) * 100).toFixed(0)}%)`);
  console.log(`tool calls: ${calls}  tokens: ${promptTokens} in / ${completionTokens} out  wall: ${latency}ms`);
  console.log('');
  for (const result of results) {
    const mark = result.pass ? 'PASS' : 'FAIL';
    const reason = result.reason ? ` (${result.reason})` : '';
    console.log(`${mark}  ${result.id}  turns=${result.turns} calls=${result.toolCalls} tokens=${result.promptTokens}/${result.completionTokens} ${result.latencyMs}ms${reason}`);
  }
}

async function main() {
  if (DRY_RUN) {
    const url = GATEWAY_URL ?? await startFakeGateway();
    const { client, tools } = await connectGateway(url);
    const names = tools.map((tool) => tool.name).sort();
    console.log(`[bench] gateway: ${url}`);
    console.log(`[bench] tools: ${names.join(', ')}`);
    console.log(`[bench] tasks: ${tasks.tasks.length} from ${TASKS_FILE}`);
    await client.close();
    console.log('[bench] dry run OK');
    return;
  }

  const url = GATEWAY_URL ?? await startFakeGateway();
  const { client, tools } = await connectGateway(url);
  const toolsForModel = toOpenAiTools(tools);
  console.log(`[bench] gateway: ${url} | model: ${MODEL} @ ${MODEL_BASE} | tasks: ${tasks.tasks.length}`);
  const results = [];
  try {
    for (const task of tasks.tasks) {
      const result = await runTask(client, tools, task, toolsForModel);
      results.push(result);
      console.log(`${result.pass ? 'PASS' : 'FAIL'}  ${task.id}`);
    }
  } finally {
    await client.close();
  }
  printSummary(results);
  const outFile = path.join(root, 'bench', 'results.json');
  fs.writeFileSync(outFile, JSON.stringify({ model: MODEL, modelBase: MODEL_BASE, tasksFile: TASKS_FILE, results }, null, 2));
  console.log(`\n[bench] wrote ${outFile}`);
}

main()
  .catch((error) => die(error.message, 1))
  .finally(() => {
    if (gatewayProcess) gatewayProcess.kill();
  });
