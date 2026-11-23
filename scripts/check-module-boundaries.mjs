#!/usr/bin/env node
/**
 * Repository module-boundary audit.
 *
 * This is the first, low-risk step of the six-module storage architecture:
 * it maps the current flat src/ files to logical modules and reports import
 * edges that violate the target dependency direction.
 *
 * It does NOT move files. Existing violations are explicitly baselined so new
 * violations fail, while the migration can proceed module by module later.
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
 * for new violations. Keep this list small and shrink it as modules move.
 */
export const LEGACY_EDGES = new Set([
  'execution->client',       // codemode.js -> client-profile.js
  'execution->evidence',     // codemode.js / codemode-v2.js -> capture.js
  'upstream->execution',     // upstreams.js -> tool-format.js
  'upstream->evidence',      // upstreams.js / upstream-auth.js -> capture.js
  'upstream->client',        // upstream-oauth.js -> oauth.js
  'evidence->client',        // capture.js -> client-platform.js
  'shared->upstream',        // config.js -> upstream-auth.js
]);

export function moduleOf(file) {
  return FILE_TO_MODULE.get(file) ?? 'unmapped';
}

export function importsOf(source) {
  const out = new Set();
  for (const m of String(source).matchAll(/from\s+['"]\.\/([^'"]+)['"]/g)) {
    let target = m[1];
    if (!target.endsWith('.js')) target += '.js';
    out.add(target);
  }
  return [...out];
}

export function analyzeGraph(graph) {
  const edges = [];
  const violations = [];
  for (const [file, deps] of Object.entries(graph)) {
    const from = moduleOf(file);
    for (const dep of deps) {
      const to = moduleOf(dep);
      const edge = { fromFile: file, toFile: dep, from, to, allowed: false, legacy: false };
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

function main() {
  const args = new Set(process.argv.slice(2));
  const json = args.has('--json');
  const strict = args.has('--strict');
  const files = fs.readdirSync(SRC).filter((f) => f.endsWith('.js')).sort();
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
    console.log(`[module-boundaries] src files=${files.length} edges=${edges.length}`);
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
