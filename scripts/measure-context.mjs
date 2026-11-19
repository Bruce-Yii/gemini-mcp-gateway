#!/usr/bin/env node
/**
 * Measure the CORE metric of this project: how much context (in tokens) the
 * gateway saves by exposing a curated tool set instead of all upstream tools.
 *
 * Uses REAL tool schemas (name + full description + full inputSchema), the way
 * an MCP client actually presents them to a model. Compares:
 *   - direct: all 424 tools from the 4 servers
 *   - gateway: whitelisted tools (config.example.json) + 2 fallback meta tools
 *
 * Token estimate: JSON bytes / 4 (rough but consistent for comparison).
 * No model calls, no network, no secrets.
 */
import fs from 'node:fs';

const DATASET = 'data/tool-dataset.json';
const CONFIG = 'config.example.json';

const allTools = JSON.parse(fs.readFileSync(DATASET, 'utf8'));
const config = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));

// Fallback meta tools defined in src/server.js (CALL_TOOL / SEARCH_TOOL schemas).
const FALLBACKS = [
  {
    name: 'gateway_call',
    description: 'Fallback: call an upstream tool directly by its server name and tool name. Use this only when no direct tool covers the request.',
    inputSchema: { type: 'object', properties: { server: { type: 'string', description: 'Upstream server name' }, tool: { type: 'string', description: 'Tool name on that upstream (without any prefix)' }, arguments: { type: 'object', description: 'Arguments to pass to the upstream tool', additionalProperties: true } }, required: ['server', 'tool'], additionalProperties: false },
  },
  {
    name: 'gateway_search',
    description: 'Fallback: search the catalog of upstream tools when a direct tool cannot be found by name.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Keywords, or "select:<exact name>" for an exact lookup' }, limit: { type: 'integer', description: 'Maximum number of matches', minimum: 1, maximum: 10 } }, required: ['query'], additionalProperties: false },
  },
];

// Tools actually configured as allow-listed servers in this deployment.
const configuredServers = new Set((config.servers ?? []).map((s) => s.name));
const allowByServer = new Map((config.servers ?? []).map((s) => [s.name, new Set(s.allowTools ?? [])]));

const whitelisted = allTools.filter((t) => {
  if (!configuredServers.has(t.server)) return false;
  const allow = allowByServer.get(t.server);
  return !allow || allow.size === 0 || allow.has(t.tool);
});

// The full "direct" set is what Gemini would see if all 4 MCPs were connected
// with no filtering: every tool from all servers in the dataset.
const directSet = allTools;

function defBytes(tools) {
  return JSON.stringify(tools.map((t) => ({ name: t.name, description: t.description ?? '', inputSchema: t.inputSchema ?? {} }))).length;
}
function tokens(bytes) { return Math.round(bytes / 4); }

const set = [...whitelisted, ...FALLBACKS];
const directBytes = defBytes(directSet);
const gwBytes = defBytes(set);
const directTok = tokens(directBytes);
const gwTok = tokens(gwBytes);

const byServer = {};
for (const t of directSet) byServer[t.server] = (byServer[t.server] ?? 0) + 1;

console.log('=== Context footprint of tool definitions (real schemas, bytes/4) ===');
console.log('Upstream tools per server:', JSON.stringify(byServer));
console.log(`Direct (all ${directSet.length} tools):     ${directBytes} bytes  ~${directTok} tokens`);
console.log(`Gateway (${whitelisted.length} whitelist + 2 fallback = ${set.length} tools): ${gwBytes} bytes  ~${gwTok} tokens`);
console.log(`Saved: ${directBytes - gwBytes} bytes / ${directTok - gwTok} tokens  (${((1 - gwBytes / directBytes) * 100).toFixed(1)}% reduction)`);
console.log('');
console.log('Gateway tools exposed:');
for (const t of set) console.log('  -', t.name);

fs.mkdirSync('work', { recursive: true });
fs.writeFileSync('work/context-measure.json', JSON.stringify({
  directTools: directSet.length,
  gatewayTools: set.length,
  directTokens: directTok,
  gatewayTokens: gwTok,
  reductionPct: Number(((1 - gwBytes / directBytes) * 100).toFixed(1)),
  byServer,
}, null, 2));
console.log('\nsaved work/context-measure.json');
