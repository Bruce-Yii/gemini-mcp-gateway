#!/usr/bin/env node
/**
 * Offline tool-inventory audit + optional live snapshot capture.
 *
 * Usage:
 *   node scripts/audit-tools.mjs --server figma                 # offline check
 *   node scripts/audit-tools.mjs --server figma --write-snapshot
 *   node scripts/audit-tools.mjs --server figma --write-snapshot --sync-dataset
 *
 * Inputs:
 *   data/tool-snapshots/<server>.json  — live tools/list snapshot (committed)
 *   data/official-tools/<server>.json  — official docs tool list (committed)
 *   data/tool-policy/<server>.json    — deny reasons + allowed undocumented extras
 *
 * This makes "total/exposed/denied" reproducible for a fresh clone: no token is
 * needed unless you are writing a new snapshot.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { validateConfig } from '../src/config.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const valueArg = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};

const serverName = valueArg('--server', 'figma');
const configPath = resolve(valueArg('--config', resolve(root, 'config.example.json')));
const snapshotPath = resolve(valueArg('--snapshot', resolve(root, 'data', 'tool-snapshots', `${serverName}.json`)));
const officialPath = resolve(valueArg('--official', resolve(root, 'data', 'official-tools', `${serverName}.json`)));
const policyPath = resolve(valueArg('--policy', resolve(root, 'data', 'tool-policy', `${serverName}.json`)));
const datasetPath = resolve(root, 'data', 'tool-dataset.json');

function readJson(path, label) {
  if (!existsSync(path)) return { missing: true, path };
  try {
    return { value: JSON.parse(readFileSync(path, 'utf8')), path };
  } catch (error) {
    throw new Error(`${label} is not valid JSON (${path}): ${error.message}`);
  }
}

function patternMatches(pattern, server, tool) {
  const value = String(pattern);
  if (value.includes('/')) {
    const [service, name] = value.split('/', 2);
    if (service !== server && service !== '*') return false;
    return name === '*' || name === tool;
  }
  return value === tool;
}

function isDenied(server, toolName) {
  return (server.denyTools ?? []).some((pattern) => patternMatches(pattern, server.name, toolName));
}

function isAllowed(server, toolName) {
  if (!Array.isArray(server.allowTools) || server.allowTools.length === 0) return true;
  return server.allowTools.some((pattern) => patternMatches(pattern, server.name, toolName));
}

/** Pure audit function (used by CLI and tests). */
export function auditTools({ snapshot, official, policy, server }) {
  const errors = [];
  const warnings = [];
  const tools = Array.isArray(snapshot?.tools) ? snapshot.tools : [];
  const names = tools.map((tool) => tool.name).filter(Boolean);
  const nameSet = new Set(names);

  if (names.length !== tools.length) errors.push('snapshot contains tools without a name');
  if (new Set(names).size !== names.length) errors.push('snapshot contains duplicate tool names');

  const officialNames = Array.isArray(official?.tools)
    ? official.tools.map((tool) => (typeof tool === 'string' ? tool : tool.name)).filter(Boolean)
    : [];
  if (officialNames.length > 0) {
    const missing = officialNames.filter((name) => !nameSet.has(name));
    if (missing.length > 0) errors.push(`official tools missing from snapshot: ${missing.join(', ')}`);
    const extra = names.filter((name) => !officialNames.includes(name));
    const declaredExtras = new Set((policy?.allowExtra ?? []).map((entry) => entry.name));
    const denied = new Set(names.filter((name) => isDenied(server, name)));
    for (const name of extra) {
      if (!declaredExtras.has(name) && !denied.has(name)) {
        errors.push(`snapshot tool not in official docs and not declared in policy.allowExtra: ${name}`);
      }
    }
    if (extra.length > 0) warnings.push(`snapshot extras vs official docs: ${extra.join(', ')}`);
  } else {
    warnings.push('official tool list missing; skipped official-vs-snapshot diff');
  }

  const deniedNames = names.filter((name) => isDenied(server, name));
  const exposedNames = tools
    .filter((tool) => !isDenied(server, tool.name) && isAllowed(server, tool.name))
    .map((tool) => tool.name);

  const denyPolicy = new Map((policy?.deny ?? []).map((entry) => [entry.name, entry]));
  for (const name of deniedNames) {
    const entry = denyPolicy.get(name);
    if (!entry) {
      errors.push(`denied tool has no policy entry: ${name}`);
      continue;
    }
    if (!entry.category || entry.category === 'uncertain') {
      errors.push(`denied tool policy category must be explicit (not uncertain): ${name}`);
    }
    if (!entry.reason) errors.push(`denied tool policy missing reason: ${name}`);
  }
  for (const entry of policy?.deny ?? []) {
    if (!nameSet.has(entry.name)) errors.push(`policy denies unknown snapshot tool: ${entry.name}`);
    if (!isDenied(server, entry.name)) errors.push(`policy denies a tool that config does not deny: ${entry.name}`);
  }

  const allowExtra = new Map((policy?.allowExtra ?? []).map((entry) => [entry.name, entry]));
  for (const entry of allowExtra.values()) {
    if (!nameSet.has(entry.name)) errors.push(`policy allowExtra references unknown tool: ${entry.name}`);
    if (isDenied(server, entry.name)) errors.push(`policy allowExtra tool is denied by config: ${entry.name}`);
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    stats: {
      total: names.length,
      denied: deniedNames.length,
      exposed: exposedNames.length,
      official: officialNames.length,
      extras: names.filter((name) => officialNames.length > 0 && !officialNames.includes(name)),
      deniedNames,
      exposedNames,
    },
  };
}

function loadServer(config) {
  const configValue = validateConfig(config).config;
  const server = (configValue.servers ?? []).find((item) => item.name === serverName);
  if (!server) throw new Error(`server "${serverName}" not found in config`);
  return server;
}

async function writeSnapshot(server) {
  const token = server.tokenEnv ? process.env[server.tokenEnv] : '';
  if (!token) throw new Error(`cannot capture snapshot: ${server.tokenEnv ?? 'tokenEnv'} is not set`);
  const headers = { accept: 'application/json, text/event-stream', 'content-type': 'application/json' };
  const headerName = server.tokenHeader ?? 'Authorization';
  if (headerName.toLowerCase() === 'authorization') {
    const scheme = server.authScheme || 'Bearer';
    headers.Authorization = `${scheme} ${token}`;
  } else {
    headers[headerName] = token;
  }
  const client = new Client({ name: 'audit-tools', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers } }));
  try {
    const { tools } = await client.listTools();
    const snapshot = {
      server: serverName,
      capturedAt: new Date().toISOString(),
      source: `${server.url} tools/list`,
      toolCount: tools.length,
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? '',
        inputSchema: tool.inputSchema ?? {},
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
      })),
    };
    mkdirSync(dirname(snapshotPath), { recursive: true });
    writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2) + '\n');
    console.log(`[audit-tools] snapshot written: ${snapshotPath} (${tools.length} tools)`);
    return snapshot;
  } finally {
    await client.close();
  }
}

function syncDataset(snapshot) {
  const dataset = existsSync(datasetPath) ? JSON.parse(readFileSync(datasetPath, 'utf8')) : [];
  const kept = Array.isArray(dataset) ? dataset.filter((entry) => entry.server !== serverName) : [];
  const added = snapshot.tools.map((tool) => ({
    server: serverName,
    tool: tool.name,
    name: `${serverName}__${tool.name}`,
    description: tool.description ?? '',
    inputSchema: tool.inputSchema ?? {},
  }));
  const next = [...kept, ...added];
  writeFileSync(datasetPath, JSON.stringify(next, null, 2) + '\n');
  console.log(`[audit-tools] dataset synced: ${datasetPath} (${kept.length} + ${added.length} = ${next.length})`);
}

async function main() {
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const server = loadServer(config);

  if (flag('--write-snapshot')) {
    const snapshot = await writeSnapshot(server);
    if (flag('--sync-dataset')) syncDataset(snapshot);
    return;
  }

  const snapshot = readJson(snapshotPath, 'snapshot');
  if (snapshot.missing) {
    console.error(`[audit-tools] snapshot missing: ${snapshotPath}`);
    console.error('[audit-tools] capture it with: node scripts/audit-tools.mjs --server ' + serverName + ' --write-snapshot --sync-dataset');
    process.exitCode = 2;
    return;
  }
  const official = readJson(officialPath, 'official tool list');
  const policy = readJson(policyPath, 'tool policy');
  const result = auditTools({
    snapshot: snapshot.value,
    official: official.missing ? null : official.value,
    policy: policy.missing ? null : policy.value,
    server,
  });

  const { stats } = result;
  console.log(`[audit-tools] server=${serverName} snapshot=${snapshotPath}`);
  console.log(`[audit-tools] total=${stats.total} exposed=${stats.exposed} denied=${stats.denied} official=${stats.official}`);
  if (stats.extras.length > 0) console.log(`[audit-tools] extras: ${stats.extras.join(', ')}`);
  for (const warning of result.warnings) console.log(`  ! ${warning}`);
  for (const error of result.errors) console.error(`  ✗ ${error}`);
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(`[audit-tools] ${error.message}`);
    process.exit(1);
  });
}
