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
 * M1 physical client isolation adds two more rules over src/clients/:
 *   Rule A — src/clients/<platformA>/** must NEVER import
 *            src/clients/<platformB>/** (A != B), and the shared base
 *            src/clients/_base/** must never import a concrete platform.
 *   Rule B — src/execution/**, src/upstream/** and src/evidence/** must NEVER
 *            import a concrete client (src/clients/{gemini,chatgpt,claude}/**).
 *            They may import the router (src/clients/index.js) or the shared
 *            base (src/clients/_base/**).
 * Both rules are physical (filesystem) rules: a violation exits non-zero and is
 * reported with a distinct rule id, while the pre-existing module rules and
 * their output format are preserved unchanged.
 *
 * Usage:
 *   node scripts/check-module-boundaries.mjs
 *   node scripts/check-module-boundaries.mjs --json
 *   node scripts/check-module-boundaries.mjs --strict   # fail on legacy too
 *   node scripts/check-module-boundaries.mjs --src <dir> # audit another tree
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
 * Parse relative ESM imports for the legacy flat-module API. `./x.js` and
 * `x.js` are normalized to the same basename (the legacy analyzer only needs a
 * basename lookup, and existing callers/tests depend on this normalization).
 * For path-based physical rules use relativeImportsOf() instead.
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

/**
 * Parse relative ESM imports WITHOUT dropping the leading './' (plus
 * side-effect imports such as `import '../clients/gemini/prompts.js'`).
 * Required by the client-isolation rules, which must resolve each specifier
 * against the importing file's own directory.
 */
export function relativeImportsOf(source) {
  const out = new Set();
  const text = String(source);
  const add = (spec) => {
    out.add(spec.endsWith('.js') ? spec : `${spec}.js`);
  };
  for (const m of text.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) add(m[1]);
  for (const m of text.matchAll(/\bimport\s+['"](\.[^'"]+)['"]/g)) add(m[1]);
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

/* ========================================================================== *
 * M1 physical client isolation (rules A and B)
 * ========================================================================== */

/** The concrete client platforms that own a physical directory. */
export const CLIENT_PLATFORMS = Object.freeze(['gemini', 'chatgpt', 'claude']);

const CLIENT_PLATFORM_DIRS = new Set(CLIENT_PLATFORMS);

/** Shared, platform-agnostic client code: the only cross-platform imports. */
export const CLIENT_SHARED_DIR = '_base';

/** Objective layers that must talk to clients only through the router/base. */
export const OBJECTIVE_MODULES = Object.freeze(['execution', 'upstream', 'evidence']);

const OBJECTIVE_DIRS = new Set(OBJECTIVE_MODULES);

/** Distinct, reportable rule ids (stable strings used by tests/CI logs). */
export const CLIENT_BOUNDARY_RULES = Object.freeze({
  CROSS_CLIENT_IMPORT: 'rule-a/cross-client-import',
  OBJECTIVE_IMPORTS_CLIENT: 'rule-b/objective-imports-client',
});

export function toPosixPath(file) {
  return String(file).replace(/\\/g, '/');
}

/**
 * Resolve one relative import specifier against the importing file, returning a
 * src-relative posix path (e.g. 'clients/chatgpt/index.js'). Bare package
 * specifiers return null (never a client-boundary edge).
 */
export function resolveImportTarget(fromFile, specifier) {
  const spec = toPosixPath(specifier);
  if (!spec.startsWith('.')) return null;
  const from = toPosixPath(fromFile);
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  return resolved.replace(/^\.\//, '');
}

/** Platform id owning a path under src/clients/<platform>/, else null. */
export function clientPlatformOf(file) {
  const match = /^clients\/([^/]+)\//.exec(toPosixPath(file));
  if (!match) return null;
  return CLIENT_PLATFORM_DIRS.has(match[1]) ? match[1] : null;
}

/** True for the shared base (src/clients/_base/**). */
export function isClientBaseFile(file) {
  return toPosixPath(file).startsWith(`clients/${CLIENT_SHARED_DIR}/`);
}

/** True for the sole router (src/clients/index.js). */
export function isClientRouterFile(file) {
  return toPosixPath(file) === 'clients/index.js';
}

/** Objective layer owning a path, else null. */
export function objectiveModuleOf(file) {
  const match = /^([^/]+)\//.exec(toPosixPath(file));
  return match && OBJECTIVE_DIRS.has(match[1]) ? match[1] : null;
}

function layerName(file) {
  const platform = clientPlatformOf(file);
  if (platform) return `clients/${platform}`;
  if (isClientBaseFile(file)) return `clients/${CLIENT_SHARED_DIR}`;
  if (isClientRouterFile(file)) return 'clients/index.js';
  const head = toPosixPath(file).split('/')[0];
  return head || file;
}

/**
 * Audit the client-isolation rules over a src-relative import graph.
 *
 * Rule A violation: a concrete platform imports another concrete platform, or
 * the shared base imports any concrete platform.
 * Rule B violation: execution/upstream/evidence imports a concrete platform.
 * Imports of src/clients/index.js and src/clients/_base/** are always allowed.
 *
 * @param {Record<string, string[]>} graph src-relative file -> relative imports
 * @returns {{edges: object[], violations: object[]}}
 */
export function analyzeClientBoundaries(graph) {
  const edges = [];
  const violations = [];
  for (const [file, deps] of Object.entries(graph)) {
    const fromFile = toPosixPath(file);
    const fromPlatform = clientPlatformOf(fromFile);
    const fromBase = isClientBaseFile(fromFile);
    const fromObjective = objectiveModuleOf(fromFile);
    for (const dep of deps ?? []) {
      const target = resolveImportTarget(fromFile, dep);
      if (!target) continue;
      const toPlatform = clientPlatformOf(target);
      const toSharedClient = isClientRouterFile(target) || isClientBaseFile(target);
      // Only edges that touch the physical client tree are client-rule edges.
      if (!fromPlatform && !fromBase && !toPlatform && !toSharedClient) continue;

      const edge = {
        fromFile,
        toFile: target,
        rawSpecifier: dep,
        from: layerName(fromFile),
        to: layerName(target),
        rule: null,
        allowed: true,
        reason: 'allowed',
      };
      if (fromPlatform && toPlatform && fromPlatform !== toPlatform) {
        edge.rule = CLIENT_BOUNDARY_RULES.CROSS_CLIENT_IMPORT;
        edge.allowed = false;
        edge.reason = `concrete client ${fromPlatform} must not import concrete client ${toPlatform}`;
      } else if (fromBase && toPlatform) {
        edge.rule = CLIENT_BOUNDARY_RULES.CROSS_CLIENT_IMPORT;
        edge.allowed = false;
        edge.reason = `shared base clients/_base must not import concrete client ${toPlatform}`;
      } else if (fromObjective && toPlatform) {
        edge.rule = CLIENT_BOUNDARY_RULES.OBJECTIVE_IMPORTS_CLIENT;
        edge.allowed = false;
        edge.reason = `${fromObjective} must import clients/index.js or clients/_base, not concrete client ${toPlatform}`;
      }
      edges.push(edge);
      if (!edge.allowed) violations.push(edge);
    }
  }
  return { edges, violations };
}

/** Recursively collect every .js file under src/clients (src-relative paths). */
export function scanClientModules(srcDir = SRC) {
  const root = path.join(srcDir, 'clients');
  const files = [];
  if (!fs.existsSync(root)) return files;
  const walk = (dir, prefix) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const rel = `${prefix}${entry.name}`;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), `${rel}/`);
      } else if (entry.name.endsWith('.js')) {
        files.push(rel);
      }
    }
  };
  walk(root, 'clients/');
  return files;
}

/**
 * Build the import graph needed by rules A/B: every logical module file plus
 * every file under src/clients. Uses RAW relative specifiers (leading './'
 * preserved) so each target can be resolved against the importing file.
 * Reads only files that exist in `srcDir`.
 */
export function buildClientGraph(moduleFiles, clientFiles, srcDir = SRC) {
  const graph = {};
  for (const file of [...moduleFiles, ...clientFiles]) {
    graph[file] = relativeImportsOf(fs.readFileSync(path.join(srcDir, file), 'utf8'));
  }
  return graph;
}

/**
 * Build the legacy module graph, excluding imports that target src/clients/**
 * (those are owned by rules A/B so they are not misreported as unmapped).
 */
export function buildLegacyGraph(moduleFiles, srcDir = SRC) {
  const graph = {};
  for (const file of moduleFiles) {
    graph[file] = importsOf(fs.readFileSync(path.join(srcDir, file), 'utf8'))
      .filter((dep) => !resolveImportTarget(file, dep)?.startsWith('clients/'));
  }
  return graph;
}

export function parseArgs(argv) {
  const args = new Set(argv);
  let srcDir = SRC;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--src' && argv[i + 1]) srcDir = path.resolve(argv[i + 1]);
    else if (arg.startsWith('--src=')) srcDir = path.resolve(arg.slice('--src='.length));
  }
  return { json: args.has('--json'), strict: args.has('--strict'), srcDir };
}

function main() {
  const { json, strict, srcDir } = parseArgs(process.argv.slice(2));
  const files = scanModules(srcDir);
  const { edges, violations } = analyzeGraph(buildLegacyGraph(files, srcDir));

  const clientFiles = scanClientModules(srcDir);
  const clientGraph = buildClientGraph(files, clientFiles, srcDir);
  const clientBoundaries = analyzeClientBoundaries(clientGraph);
  const clientViolations = clientBoundaries.violations;
  const ruleACount = clientViolations.filter((e) => e.rule === CLIENT_BOUNDARY_RULES.CROSS_CLIENT_IMPORT).length;
  const ruleBCount = clientViolations.filter((e) => e.rule === CLIENT_BOUNDARY_RULES.OBJECTIVE_IMPORTS_CLIENT).length;

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
      clients: {
        files: clientFiles.length,
        platforms: CLIENT_PLATFORMS,
        rules: CLIENT_BOUNDARY_RULES,
        edges: clientBoundaries.edges.length,
        newViolations: clientViolations.length,
        ruleAViolations: ruleACount,
        ruleBViolations: ruleBCount,
        violations: clientViolations,
      },
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

    console.log(`[client-boundaries] client files=${clientFiles.length} edges=${clientBoundaries.edges.length} rules=A(${CLIENT_BOUNDARY_RULES.CROSS_CLIENT_IMPORT}),B(${CLIENT_BOUNDARY_RULES.OBJECTIVE_IMPORTS_CLIENT})`);
    console.log(`  rule A cross-client imports: ${ruleACount}`);
    console.log(`  rule B objective-layer -> concrete client imports: ${ruleBCount}`);
    if (clientViolations.length) {
      console.error(`  NEW CLIENT VIOLATIONS=${clientViolations.length}`);
      for (const e of clientViolations) {
        console.error(`    x [${e.rule}] ${e.fromFile} -> ${e.toFile} (${e.reason})`);
      }
    } else {
      console.log('  new violations=0');
    }
  }

  if (unmapped.length) process.exitCode = 1;
  if (violations.length) process.exitCode = 1;
  if (clientViolations.length) process.exitCode = 1;
  if (strict && legacy.length) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
