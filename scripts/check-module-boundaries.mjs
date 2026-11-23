#!/usr/bin/env node
/**
 * Repository module-boundary audit.
 *
 * The src/ tree has been physically migrated into six module directories, with
 * flat re-export shims left at the old paths for backwards compatibility. This
 * script scans only the real implementations under src/<module>/; shims are
 * intentionally excluded from boundary calculation (they contain no logic).
 *
 * Existing cross-module edges are explicitly baselined so new violations fail.
 *
 * Usage:
 *   node scripts/check-module-boundaries.mjs
 *   node scripts/check-module-boundaries.mjs --json
 *   node scripts/check-module-boundaries.mjs --strict   # fail on legacy too
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve('src');

/** Logical module -> implementation files (basenames). */
export const MODULES = {
  shared: ['config.js', 'sanitize.js', 'catalog.js', 'build-info.js', 'store.js'],
  client: ['oauth.js', 'client-platform.js', 'client-profile.js'],
  execution: [
    'codemode.js', 'codemode-v2.js', 'codemode-util.js', 'typed-plan.js',
    'tool-format.js', 'result-normalize.js', 'github-helpers.js', 'file-write.js',
  ],
  upstream: ['upstreams.js', 'upstream-auth.js', 'upstream-oauth.js', 'figma-guard.js'],
  evidence: ['capture.js', 'capture-queue.js', 'project-tag.js'],
  runtime: ['vercel-app.js', 'server.js'],
};

const FILE_TO_MODULE = new Map();
for (const [module, files] of Object.entries(MODULES)) {
  for (const file of files) {
    if (FILE_TO_MODULE.has(file)) throw new Error(`duplicate module mapping: ${file}`);
    FILE_TO_MODULE.set(file, module);
  }
}

const MODULE_NAMES = new Set(Object.keys(MODULES));

const ALLOWED = {
  shared: new Set(['shared']),
  client: new Set(['client', 'shared']),
  execution: new Set(['execution', 'shared']),
  upstream: new Set(['upstream', 'shared']),
  evidence: new Set(['evidence', 'shared']),
  runtime: new Set(['client', 'execution', 'upstream', 'evidence', 'runtime', 'shared']),
};

/**
 * Known pre-existing edges. Each one is a migration debt item, not a licence
 * for new violations. Keep this list small and shrink it as modules settle.
 */
export const LEGACY_EDGES = new Set([
  'execution->client',       // execution/codemode.js -> client/client-profile.js
  'execution->evidence',     // execution/codemode.js / codemode-v2.js -> evidence/capture.js
  'upstream->execution',     // upstream/upstreams.js -> execution/tool-format.js
  'upstream->evidence',      // upstream/upstreams.js / upstream-auth.js -> evidence/capture.js
  'upstream->client',        // upstream/upstream-oauth.js -> client/oauth.js
  'evidence->client',        // evidence/capture.js -> client/client-platform.js
  'shared->upstream',        // shared/config.js -> upstream/upstream-auth.js
]);

/** Basename lookup, preserved for the original flat-layout API. */
export function moduleOf(file) {
  return FILE_TO_MODULE.get(path.basename(String(file))) ?? 'unmapped';
}

/**
 * Resolve a module-relative path (e.g. '../evidence/capture.js') or a flat
 * basename to a canonical 'module/file.js' key used by the scanner.
 */
export function canonicalKey(file) {
  const raw = String(file).replace(/\\/g, '/').replace(/^\.\//, '');
  const parts = raw.split('/').filter(Boolean);
  const base = parts.pop();
  if (!base) return raw;
  if (parts.length === 0) {
    const mod = FILE_TO_MODULE.get(base);
    return mod ? `${mod}/${base}` : base;
  }
  const dir = parts[parts.length - 1];
  return MODULE_NAMES.has(dir) ? `${dir}/${base}` : base;
}

/**
 * Parse relative ESM imports. Handles both legacy './x.js' (used by unit
 * tests) and migrated '../module/x.js' paths.
 */
export function importsOf(source) {
  const out = new Set();
  for (const m of String(source).matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
    let target = m[1].replace(/^\.\//, '');
    if (!target.endsWith('.js')) target += '.js';
    out.add(target);
  }
  return [...out];
}

export function analyzeGraph(graph) {
  const edges = [];
  const violations = [];
  for (const [file, deps] of Object.entries(graph)) {
    // Preserve original keys in edge output for API compatibility; canonical
    // paths are used only for module lookup.
    const fromFile = file;
    const from = moduleOf(canonicalKey(file));
    for (const dep of deps) {
      const toFile = dep;
      const to = moduleOf(canonicalKey(dep));
      const edge = { fromFile, toFile, from, to, allowed: false, legacy: false };
      if (from === 'unmapped' || to === 'unmapped') {
        edge.reason = 'unmapped file';
        violations.push(edge);
        edges.push(edge);
        continue;
      }
      const target = `${from}->${to}`;
      edge.allowed = from === to || ALLOWED[from]?.has(to) === true;
      edge.legacy = LEGACY_EDGES.has(target);
      edge.reason = edge.allowed ? 'allowed' : edge.legacy ? 'legacy migration debt' : 'forbidden edge';
      edges.push(edge);
      if (!edge.allowed && !edge.legacy) violations.push(edge);
    }
  }
  return { edges, violations };
}

/** Walk only real implementation directories; root shims are not scanned. */
export function scanModules(srcDir = SRC) {
  const files = [];
  for (const module of Object.keys(MODULES)) {
    const dir = path.join(srcDir, module);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).sort()) {
      if (!name.endsWith('.js')) continue;
      files.push(`${module}/${name}`);
    }
  }
  return files;
}

function main() {
  const args = new Set(process.argv.slice(2));
  const json = args.has('--json');
  const strict = args.has('--strict');
  const files = scanModules(SRC);
  const graph = {};
  for (const file of files) {
    graph[file] = importsOf(fs.readFileSync(path.join(SRC, file), 'utf8'));
  }
  const { edges, violations } = analyzeGraph(graph);
  const legacy = edges.filter((e) => e.legacy);
  const unmapped = files.filter((f) => moduleOf(f) === 'unmapped');

  if (json) {
    console.log(JSON.stringify({
      files: files.length,
      modules: Object.fromEntries(Object.entries(MODULES).map(([k, v]) => [k, v.length])),
      edges: edges.length,
      legacy: legacy.length,
      newViolations: violations.length,
      unmapped,
      violations,
    }, null, 2));
  } else {
    console.log(`[module-boundaries] src modules=${files.length} edges=${edges.length} (shims excluded)`);
    for (const [name, list] of Object.entries(MODULES)) {
      console.log(`  ${name}: ${list.length}`);
    }
    if (legacy.length) {
      console.log(`  legacy edges=${legacy.length} (migration debt, not failing)`);
      for (const e of legacy) console.log(`    ~ ${e.fromFile} -> ${e.toFile} (${e.from}->${e.to})`);
    }
    if (unmapped.length) {
      console.error(`  unmapped files: ${unmapped.join(', ')}`);
    }
    if (violations.length) {
      console.error(`  NEW VIOLATIONS=${violations.length}`);
      for (const e of violations) console.error(`    x ${e.fromFile} -> ${e.toFile} (${e.from}->${e.to}) (${e.reason})`);
    } else {
      console.log('  new violations=0');
    }
  }

  if (unmapped.length) process.exitCode = 1;
  if (violations.length) process.exitCode = 1;
  if (strict && legacy.length) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
