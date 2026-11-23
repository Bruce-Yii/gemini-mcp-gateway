#!/usr/bin/env node
/**
 * Measure the CORE metric of this project: how much context the Code Mode tool
 * face costs compared with connecting the four upstream MCP servers directly.
 *
 *   direct  = all upstream tools as an MCP client would present them to a model
 *   gateway = the 3 fixed MCP tools (search / execute_read / execute); the 191
 *             enabled upstream tools are callable inside the sandbox but their
 *             definitions never enter the model context
 *
 * Token estimate: JSON bytes / 4 (rough but consistent for comparison).
 * No model calls, no network, no secrets.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCodeModeTools } from '../src/codemode.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATASET = path.join(root, 'data', 'tool-dataset.json');
const CONFIG = path.join(root, 'config.example.json');

// data/tool-dataset.json is a private eval fixture, excluded from the clean
// OSS export. In that case emit an explicit SKIP and exit 0 so gate commands
// (`npm run verify`) stay green; never silently fake a measurement. In the
// private repo the dataset exists and the original measurement runs unchanged.
if (!fs.existsSync(DATASET)) {
  console.log('SKIP: data/tool-dataset.json is a private eval fixture excluded from the OSS export; '
    + 'no context measurement performed (see docs/OPEN-SOURCE/EXPORT-TEST-CURATION.md).');
  process.exit(0);
}

const allTools = JSON.parse(fs.readFileSync(DATASET, 'utf8'));
const config = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
const denyByServer = new Map((config.servers ?? []).map((s) => [s.name, new Set(s.denyTools ?? [])]));
const enabled = allTools.filter((t) => !denyByServer.get(t.server)?.has(t.tool));

const fakeManager = {
  getEntries: () => enabled.map((t) => ({ ...t })),
  getWhitelist: () => [],
};
const gatewayTools = createCodeModeTools(fakeManager).map(({ name, description, inputSchema, annotations }) => ({
  name,
  description,
  inputSchema,
  annotations,
}));

function defBytes(tools) {
  return JSON.stringify(
    tools.map((t) => {
      const def = { name: t.name, description: t.description ?? '', inputSchema: t.inputSchema ?? {} };
      if (t.annotations) def.annotations = t.annotations;
      return def;
    }),
  ).length;
}
const tokens = (bytes) => Math.round(bytes / 4);

const directBytes = defBytes(allTools);
const gwBytes = defBytes(gatewayTools);
const directTok = tokens(directBytes);
const gwTok = tokens(gwBytes);
const reductionPct = Number(((1 - gwBytes / directBytes) * 100).toFixed(1));

const byServer = {};
for (const t of allTools) byServer[t.server] = (byServer[t.server] ?? 0) + 1;
const enabledByServer = {};
for (const t of enabled) enabledByServer[t.server] = (enabledByServer[t.server] ?? 0) + 1;

console.log('=== Tool-definition context footprint (real schemas, bytes/4) ===');
console.log('Upstream tools in dataset:', JSON.stringify(byServer));
console.log('Enabled upstream tools (callable inside the sandbox):', enabled.length, JSON.stringify(enabledByServer));
console.log(`Direct (all ${allTools.length} upstream tools):  ${directBytes} bytes  ~${directTok} tokens`);
console.log(`Gateway (${gatewayTools.length} Code Mode tools):     ${gwBytes} bytes  ~${gwTok} tokens`);
console.log(`Reduction: ${((1 - gwBytes / directBytes) * 100).toFixed(1)}%  (${directTok - gwTok} tokens saved)`);
console.log('');
console.log('Gateway tools exposed to the model:');
for (const t of gatewayTools) console.log(`  - ${t.name} (${JSON.stringify(t).length} bytes)`);

const outDir = path.join(root, 'work');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(
  path.join(outDir, 'context-measure.json'),
  JSON.stringify(
    {
      measuredAt: new Date().toISOString(),
      mode: 'codemode',
      directTools: allTools.length,
      enabledUpstreamTools: enabled.length,
      gatewayTools: gatewayTools.length,
      directBytes,
      directTokens: directTok,
      gatewayBytes: gwBytes,
      gatewayTokens: gwTok,
      reductionPct,
      byServer,
      enabledByServer,
    },
    null,
    2,
  ),
);
console.log('\nsaved work/context-measure.json');
