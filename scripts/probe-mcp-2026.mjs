#!/usr/bin/env node
/**
 * Read-only MCP protocol-revision probe.
 *
 * Purpose: produce a repeatable, local-only evidence record of which protocol
 * revision this checkout and the installed SDK actually speak. It does NOT
 * modify production code, does NOT call any external network service, and
 * only (optionally) sends a JSON-RPC probe to a *localhost* endpoint that the
 * caller explicitly starts.
 *
 * Usage:
 *   node scripts/probe-mcp-2026.mjs                 # local files only
 *   node scripts/probe-mcp-2026.mjs --url http://127.0.0.1:3000/mcp
 *
 * The optional --url form accepts only loopback hosts (127.0.0.1, localhost,
 * ::1) and issues two harmless POSTs: server/discover and tools/list. It
 * reports what comes back; it never asserts success and never retries.
 */
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET_2026_FEATURES = [
  'server/discover',
  'resultType',
  'subscriptions/listen',
  'Mcp-Method',
  'Mcp-Name',
  'x-mcp-header',
  'cacheScope',
  'ttlMs',
  'UnsupportedProtocolVersionError',
];

function parseArgs(argv) {
  let url;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--url') url = argv[++i];
    else if (argv[i].startsWith('--url=')) url = argv[i].slice('--url='.length);
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (url) {
    let parsed;
    try { parsed = new URL(url); } catch { throw new Error('--url must be a valid URL'); }
    const host = parsed.hostname.toLowerCase();
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1' && host !== '[::1]') {
      throw new Error('--url must be a loopback host; external network is disabled');
    }
  }
  return { url };
}

async function readJson(path) {
  return JSON.parse(await readFile(resolve(ROOT, path), 'utf8'));
}

async function readText(path) {
  return readFile(resolve(ROOT, path), 'utf8');
}

async function probeLocal() {
  const pkg = await readJson('package.json');
  let installedVersion = '(not installed)';
  try {
    installedVersion = (await readJson('node_modules/@modelcontextprotocol/sdk/package.json')).version;
  } catch { /* keep default */ }

  let latest = '(unknown)';
  let supported = [];
  try {
    const types = await readText('node_modules/@modelcontextprotocol/sdk/dist/esm/types.js');
    latest = /LATEST_PROTOCOL_VERSION\s*=\s*['"]([^'"]+)['"]/.exec(types)?.[1] ?? '(not found)';
    const match = /SUPPORTED_PROTOCOL_VERSIONS\s*=\s*\[([^\]]*)\]/.exec(types)?.[1] ?? '';
    supported = [...match.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
    // The first element is the LATEST_PROTOCOL_VERSION identifier, not a literal.
    if (latest && !supported.includes(latest)) supported.unshift(latest);
  } catch { /* keep defaults */ }

  let sdkSource = '';
  try {
    // Only scan the SDK's runtime JS; avoid node_modules noise elsewhere.
    const { readdir } = await import('node:fs/promises');
    const sdkRoot = resolve(ROOT, 'node_modules/@modelcontextprotocol/sdk/dist/esm');
    const entries = await readdir(sdkRoot, { recursive: true });
    for (const entry of entries) {
      if (!entry.endsWith('.js')) continue;
      try { sdkSource += await readText(`node_modules/@modelcontextprotocol/sdk/dist/esm/${entry}`); } catch {}
    }
  } catch { /* keep empty */ }

  const ourSource = (await readText('src/server.js')) + (await readText('src/vercel-app.js'));
  return {
    declaredSdkRange: pkg.dependencies?.['@modelcontextprotocol/sdk'] ?? null,
    installedSdkVersion: installedVersion,
    sdkLatestProtocolVersion: latest,
    sdkSupportedProtocolVersions: supported,
    classification: latest === '2025-11-25' ? 'legacy (2025-11-25)' : `unknown (${latest})`,
    targetFeaturesInSdk: Object.fromEntries(
      TARGET_2026_FEATURES.map((feature) => [feature, sdkSource.includes(feature)]),
    ),
    targetFeaturesInOurCode: Object.fromEntries(
      TARGET_2026_FEATURES.map((feature) => [feature, ourSource.includes(feature)]),
    ),
    notes: [
      'spec.types.js declares DRAFT-2026-v1 but is a generated stub, not a runtime implementation.',
      'No server/discover, resultType, subscriptions/listen, Mcp-Method/Name, cacheScope/ttlMs, or UnsupportedProtocolVersionError in SDK ESM JS.',
      'src/server.js:24 imports isInitializeRequest but never calls it; SDK transport owns the legacy handshake.',
      'GET /mcp returns 405 and DELETE returns 204 (src/server.js:419-430).',
    ],
  };
}

async function post(url, payload) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': payload.method,
      'mcp-name': 'mcp-2026-readonly-probe',
    },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  return { status: response.status, contentType: response.headers.get('content-type'), body: text.slice(0, 4000) };
}

async function probeRemote(url) {
  const discover = await post(url, {
    jsonrpc: '2.0', id: 'probe-discover', method: 'server/discover',
    params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } },
  });
  const list = await post(url, {
    jsonrpc: '2.0', id: 'probe-tools', method: 'tools/list',
    params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } },
  });
  return { discover, toolsList: list };
}

const { url } = parseArgs(process.argv.slice(2));
const report = { generatedAt: new Date().toISOString(), local: await probeLocal() };
if (url) report.remoteLoopback = await probeRemote(url);
console.log(JSON.stringify(report, null, 2));
