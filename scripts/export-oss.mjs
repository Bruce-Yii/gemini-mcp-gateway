#!/usr/bin/env node
/**
 * Clean allowlist export: private repo -> staging tree -> new public repo.
 *
 * This script NEVER initializes git, commits, pushes, deploys, or publishes.
 * It only copies files into a staging directory. By default it is a dry-run:
 * nothing is written. Pass --write to actually copy, or --check to only run
 * validation against the staging/private tree without copying.
 *
 * Design contract (see docs/OPEN-SOURCE/EXPORT-MANIFEST.md, PLAN.md 0.1):
 *   - allowlist-based, NOT "copy everything then delete";
 *   - denylist is a second line of defense (must never be exported);
 *   - no real hostnames, personal paths, Bruce-Yii defaults or secret patterns
 *     may survive into the exported tree;
 *   - capture data is NEVER redacted or copied -- only path/content checks.
 *
 * Usage:
 *   node scripts/export-oss.mjs --out <dir>            # dry-run (default)
 *   node scripts/export-oss.mjs --out <dir> --write    # actually copy
 *   node scripts/export-oss.mjs --out <dir> --check    # validate only
 *
 * Exit codes: 0 = ok (or clean check), 1 = validation failure / CLI error.
 *
 * Public (testable) pure functions:
 *   buildPlan(root, [options])        -> { files, directories, skipped, ... }
 *   validateExport(root, [options])   -> { ok, violations, checkedFiles }
 *   scanTree(root, [options])         -> raw file list (used by both)
 */
import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Paths/directories that may be exported. Everything else is excluded.
 * Each entry is a posix-style path relative to the repo root. A directory
 * entry means "this directory and everything below it" (still subject to the
 * denylist and to the sensitive-content scan).
 */
export const ALLOWLIST = Object.freeze([
  // root files
  'package.json',
  'package-lock.json',
  'README.md',
  'README.zh-CN.md',
  'LICENSE',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'CODE_OF_CONDUCT.md',
  'DEPLOY.md',
  'config.example.json',
  'vercel.json',
  // source & tests & public scripts
  'api',
  'src',
  'tests',
  'scripts',
  'harness',
  // neutral fixtures / templates / examples
  'bench',
  'examples',
  'templates',
  // curated docs only
  'docs/CLIENTS.md',
  'docs/UPSTREAMS.md',
  'docs/WHY.md',
  'docs/CONTRACT.md',
  'docs/CONTRACT.vercel.md',
  'docs/SANDBOX-SECURITY.md',
  'docs/OBSERVABILITY-AND-EVAL.md',
  'docs/eval',
  'docs/OPEN-SOURCE',
  // offline CI only (other workflows intentionally excluded)
  '.github/workflows/ci.yml',
]);

/**
 * Never export these, even if a parent directory is allowlisted.
 * Matching is by normalized posix relative path: exact match, directory
 * prefix, basename, or extension glob.
 */
export const DENYLIST = Object.freeze([
  // internal notes / ledgers / planning
  'AGENTS.md',
  'project.json',
  'docs/ledger',
  'docs/HANDOFF',
  'docs/PLAN-',
  'docs/OPEN-SOURCE/READINESS.md',
  'docs/GEMINI-PROBE.md',
  'docs/BACKLOG-GEMINI-SUGGESTIONS.md',
  'docs/superpowers',
  // private working areas
  'explore',
  'data',
  'work',
  'outputs',
  'capture',
  '.vercel',
  '.vercelignore',
  'coverage',
  'test-results',
  // eval artifacts
  'docs/eval/scorecard-',
  'docs/eval/weekly-',
  // owner-only / real-eval workflows
  '.github/workflows/capture-daily.yml',
  '.github/workflows/l1-smoke.yml',
  // local secrets & captures
  'config.local.',
  '.env',
  'credentials',
  'secrets',
  '*.log',
  '*.capture.json',
  '*.capture.jsonl',
]);

/**
 * Sensitive-value detectors. These are content/path checks only -- nothing is
 * rewritten or "redacted"; a hit is a hard validation failure.
 */
const SENSITIVE_PATTERNS = Object.freeze([
  { id: 'personal-handle', re: /Bruce-Yii/i, note: 'default personal GitHub handle / author name' },
  { id: 'personal-path-dsh', re: /D:\\12412/i, note: 'personal Windows workspace path' },
  { id: 'personal-path-home', re: /dsh-home[\\/]/i, note: 'personal home/vault path' },
  { id: 'vault-path', re: /\.secrets[\\/]/i, note: 'local vault / secrets path' },
  { id: 'real-domain', re: /(?:gemini-mcp-gateway|codemode-mcp-gateway)\.(?:vercel\.app|onrender\.com|railway\.app|netlify\.app)/i, note: 'real deployment hostname' },
  { id: 'secret-assignment', re: /['"]?(?:API_KEY|ACCESS_TOKEN|CLIENT_SECRET|REFRESH_TOKEN|BEARER)['"]?\s*[:=]\s*['"][A-Za-z0-9_\-]{20,}['"]/i, note: 'literal secret-like value' },
]);

/** Normalize any platform path to posix separators for matching. */
function toPosix(p) {
  return String(p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/').replace(/\/$/, '');
}

function underPath(rel, prefix) {
  return rel === prefix || rel.startsWith(`${prefix}/`);
}

/** Return true if a normalized relative path matches a denylist rule. */
export function isDenied(relPosix) {
  const rel = toPosix(relPosix);
  const base = rel.split('/').pop();
  return DENYLIST.some((rule) => {
    if (rule.startsWith('*.')) return base.endsWith(rule.slice(1));
    if (rule.startsWith('docs/') || rule.startsWith('.github/') || rule.startsWith('.vercel')) {
      return underPath(rel, rule) || rel.startsWith(rule);
    }
    if (rule.endsWith('.')) return rel.startsWith(rule) || base.startsWith(rule);
    return underPath(rel, rule) || base === rule || rel.startsWith(rule);
  });
}

/** Return true if a normalized relative path is allowlisted. */
export function isAllowed(relPosix) {
  const rel = toPosix(relPosix);
  return ALLOWLIST.some((entry) => {
    if (underPath(rel, entry)) return true;
    // root-level literal filename rules with basename fallback (e.g. docs/CLIENTS.md)
    if (entry.includes('/')) return rel === entry;
    return baseOf(rel) === entry;
  });
}

function baseOf(p) {
  return toPosix(p).split('/').pop();
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'node_modules']);

/**
 * Walk a tree and return all regular files as normalized relative paths.
 * Pure with respect to content (does not read file bodies).
 */
export function scanTree(root, options = {}) {
  const base = resolve(root);
  const files = [];
  const visited = new Set();

  function walk(dir) {
    const real = resolve(dir);
    if (visited.has(real)) return;
    visited.add(real);
    let entries;
    try {
      entries = readdirSync(real, { withFileTypes: true });
    } catch (error) {
      if (options.onError) options.onError(error, real);
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const abs = join(real, entry.name);
      let dirent = entry;
      if (entry.isSymbolicLink()) {
        try {
          const st = statSync(abs);
          if (st.isDirectory()) dirent = { name: entry.name, isDirectory: () => true, isFile: () => false };
          else if (st.isFile()) dirent = { name: entry.name, isDirectory: () => false, isFile: () => true };
          else continue;
        } catch {
          continue;
        }
      }
      if (dirent.isDirectory()) {
        walk(abs);
      } else if (dirent.isFile()) {
        files.push(toPosix(relative(base, abs)));
      }
    }
  }

  walk(base);
  return files.sort();
}

/**
 * Pure: build the export plan from a source root.
 * Returns selected files, rejected denylist hits, outside-allowlist files,
 * and a deterministic list of directories to create in staging.
 */
export function buildPlan(root = SCRIPT_ROOT, options = {}) {
  const all = scanTree(root, options);
  const files = [];
  const denied = [];
  const outsideAllowlist = [];

  for (const rel of all) {
    if (isDenied(rel)) {
      denied.push(rel);
      continue;
    }
    if (!isAllowed(rel)) {
      outsideAllowlist.push(rel);
      continue;
    }
    files.push(rel);
  }

  const directories = [...new Set(files.flatMap((rel) => {
    const parts = rel.split('/');
    return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'));
  }))].sort();

  return {
    root: resolve(root),
    files: files.sort(),
    directories,
    denied: denied.sort(),
    outsideAllowlist: outsideAllowlist.sort(),
    counts: {
      total: all.length,
      included: files.length,
      denied: denied.length,
      outsideAllowlist: outsideAllowlist.length,
    },
  };
}

const TEXT_EXTENSIONS = new Set([
  '', '.js', '.mjs', '.cjs', '.json', '.md', '.txt', '.yml', '.yaml', '.toml',
  '.html', '.css', '.sh', '.ps1', '.example', '.jsonl', '.svg',
]);
const MAX_SCAN_BYTES = 2 * 1024 * 1024;

function isTextFile(rel) {
  const base = baseOf(rel);
  const dot = base.lastIndexOf('.');
  const ext = dot === -1 ? '' : base.slice(dot);
  if (/^Dockerfile/.test(base) || /^Makefile/.test(base) || base === 'LICENSE') return true;
  return TEXT_EXTENSIONS.has(ext);
}

/**
 * Pure: validate a tree (usually staging, or the private root with --check).
 * Checks denylist presence, sensitive paths, and sensitive content in text
 * files. It never modifies, redacts, or copies anything.
 */
export function validateExport(root, options = {}) {
  const files = scanTree(root, options);
  const violations = [];
  let checkedFiles = 0;

  for (const rel of files) {
    if (isDenied(rel)) {
      violations.push({ file: rel, kind: 'denylist', detail: 'denylisted file present in export tree' });
      continue;
    }
    for (const { id, re, note } of SENSITIVE_PATTERNS) {
      if (re.test(rel)) {
        violations.push({ file: rel, kind: id, detail: `sensitive path: ${note}` });
      }
    }
    if (!isTextFile(rel)) continue;
    let content;
    try {
      const st = statSync(join(resolve(root), rel));
      if (st.size > MAX_SCAN_BYTES) {
        violations.push({ file: rel, kind: 'too-large', detail: 'text file exceeds scan limit; manual review required' });
        continue;
      }
      content = readFileSync(join(resolve(root), rel), 'utf8');
    } catch (error) {
      violations.push({ file: rel, kind: 'unreadable', detail: error.message });
      continue;
    }
    checkedFiles += 1;
    for (const { id, re, note } of SENSITIVE_PATTERNS) {
      if (re.test(content)) {
        violations.push({ file: rel, kind: id, detail: `sensitive content: ${note}` });
      }
    }
  }

  return {
    ok: violations.length === 0,
    root: resolve(root),
    checkedFiles,
    violations,
  };
}

/** Helpers for CLI argument parsing (also exported for tests). */
export function parseArgs(argv) {
  const parsed = {
    out: null,
    source: null,
    write: false,
    check: false,
    help: false,
    errors: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) parsed.errors.push('--out requires a directory');
      else parsed.out = value;
    } else if (arg.startsWith('--out=')) {
      parsed.out = arg.slice('--out='.length) || null;
    } else if (arg === '--source') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) parsed.errors.push('--source requires a directory');
      else parsed.source = value;
    } else if (arg.startsWith('--source=')) {
      parsed.source = arg.slice('--source='.length) || null;
    } else if (arg === '--write') {
      parsed.write = true;
    } else if (arg === '--check') {
      parsed.check = true;
    } else if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else {
      parsed.errors.push(`unknown argument: ${arg}`);
    }
  }
  if (parsed.write && parsed.check) parsed.errors.push('--write and --check are mutually exclusive');
  if (!parsed.help && !parsed.out) parsed.errors.push('--out <dir> is required');
  return parsed;
}

function copyPlan(plan, staging, root) {
  mkdirSync(staging, { recursive: true });
  for (const dir of plan.directories) {
    mkdirSync(join(staging, dir), { recursive: true });
  }
  for (const rel of plan.files) {
    copyFileSync(join(root, rel), join(staging, rel));
  }
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log([
      'Usage: node scripts/export-oss.mjs --out <dir> [--write|--check]',
      '',
      '  --out <dir>     staging directory (required)',
      '  --write         actually copy files (default: dry-run, no writes)',
      '  --check         only validate, do not build plan or copy',
      '  --source <dir>  override source root (test/internal use; default: repo root)',
    ].join('\n'));
    return 0;
  }
  if (args.errors.length) {
    for (const error of args.errors) console.error(`[export-oss] ${error}`);
    return 1;
  }

  const root = args.source ? resolve(args.source) : SCRIPT_ROOT;
  const staging = resolve(args.out);
  const mode = args.check ? 'check' : args.write ? 'write' : 'dry-run';

  console.log(`[export-oss] mode=${mode}`);
  console.log(`[export-oss] source=${root}`);
  console.log(`[export-oss] staging=${staging}`);

  if (args.check) {
    const result = validateExport(staging, {
      onError: (error, dir) => console.error(`[export-oss] cannot read ${dir}: ${error.message}`),
    });
    console.log(`[export-oss] checked ${result.checkedFiles} text files`);
    if (!result.ok) {
      for (const v of result.violations) console.error(`[export-oss] VIOLATION ${v.kind}: ${v.file} (${v.detail})`);
      console.error(`[export-oss] FAILED: ${result.violations.length} violation(s)`);
      return 1;
    }
    console.log('[export-oss] CHECK PASSED');
    return 0;
  }

  const plan = buildPlan(root, {
    onError: (error, dir) => console.error(`[export-oss] cannot read ${dir}: ${error.message}`),
  });
  console.log(`[export-oss] plan: ${plan.counts.included} include, ${plan.counts.denied} denied, ${plan.counts.outsideAllowlist} outside allowlist (of ${plan.counts.total})`);
  for (const rel of plan.denied.slice(0, 40)) console.log(`[export-oss] DENIED   ${rel}`);
  if (plan.counts.denied > 40) console.log(`[export-oss] ... and ${plan.counts.denied - 40} more denylisted path(s)`);
  if (plan.counts.denied > 0) {
    console.error(`[export-oss] REFUSING to export: ${plan.counts.denied} denylisted file(s) present in source`);
    return 1;
  }

  // Pre-export validation of the plan's source files (content check).
  const pre = validateSelected(root, plan.files);
  if (!pre.ok) {
    for (const v of pre.violations) console.error(`[export-oss] VIOLATION ${v.kind}: ${v.file} (${v.detail})`);
    console.error('[export-oss] REFUSING to export: sensitive content detected in source');
    return 1;
  }

  if (!args.write) {
    console.log('[export-oss] DRY RUN: no files written. Re-run with --write to copy.');
    console.log(`[export-oss] would create ${plan.directories.length} directories and copy ${plan.files.length} files to ${staging}`);
    return 0;
  }

  copyPlan(plan, staging, root);
  console.log(`[export-oss] wrote ${plan.files.length} files to ${staging}`);

  const post = validateExport(staging);
  if (!post.ok) {
    for (const v of post.violations) console.error(`[export-oss] POST VIOLATION ${v.kind}: ${v.file} (${v.detail})`);
    console.error('[export-oss] POST-EXPORT VALIDATION FAILED');
    return 1;
  }
  console.log(`[export-oss] post-export check passed (${post.checkedFiles} text files)`);
  console.log('[export-oss] DONE. No git init/commit/push/deploy performed.');
  return 0;
}

/**
 * Validate only the selected plan files at their source paths. Reuses the
 * same detectors as validateExport without modifying the inputs.
 */
export function validateSelected(root, files) {
  const base = resolve(root);
  const violations = [];
  for (const rel of files) {
    for (const { id, re, note } of SENSITIVE_PATTERNS) {
      if (re.test(rel)) violations.push({ file: rel, kind: id, detail: `sensitive path: ${note}` });
    }
    if (!isTextFile(rel)) continue;
    let content;
    try {
      const st = statSync(join(base, rel));
      if (st.size > MAX_SCAN_BYTES) {
        violations.push({ file: rel, kind: 'too-large', detail: 'text file exceeds scan limit; manual review required' });
        continue;
      }
      content = readFileSync(join(base, rel), 'utf8');
    } catch (error) {
      violations.push({ file: rel, kind: 'unreadable', detail: error.message });
      continue;
    }
    for (const { id, re, note } of SENSITIVE_PATTERNS) {
      if (re.test(content)) violations.push({ file: rel, kind: id, detail: `sensitive content: ${note}` });
    }
  }
  return { ok: violations.length === 0, violations };
}

// Run CLI only when executed directly (safe to import in tests).
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2));
}
