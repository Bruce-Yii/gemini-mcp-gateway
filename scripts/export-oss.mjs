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
 *   - no real hostnames, personal paths, personal-handle defaults or secret
 *     patterns may survive into the exported tree
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
 *   validateSelected(root, files)     -> { ok, violations }
 *   scanTree(root, [options])         -> raw file list (used by both)
 *   canonicalizeForScan(text)         -> decoded lowercase text
 *   detectHandleForms(text)           -> [{ form, sample }] for any encoding
 *   hasHandleLeak(text)               -> boolean
 *   neutralizeHandleText(text, pats, rep) -> { text, replacements }
 *
 * P0 fix: the detector canonicalizes escaped / URL-encoded / concatenated
 * handle forms before matching, so a neutralizer that emits an escaped handle
 * can no longer produce a false PASS from `--check`.
 */
import { createHash } from 'node:crypto';
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
  // real deployment artifacts (required by the public quickstart)
  'Dockerfile',
  'docker-compose.yml',
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

/* -------------------------------------------------------------------------- *
 * Personal-handle detection (P0 fix)
 *
 * The old detector matched only one literal form. The neutralizer rewrote that
 * literal into a JS unicode escape, so the exported tree evaded detection and
 * `--check` reported a false PASS.
 *
 * The fix has two layers:
 *   1. Canonicalization: decode unicode/hex escapes, URL encoding (including
 *      double encoding), HTML entities, case and concatenation syntax, then
 *      compare candidate tokens by SHA-256 against stored handle digests.
 *   2. No recoverable signature in this source: only one-way digests are
 *      embedded. The detector cannot rebuild the handle it guards, and its
 *      own exported copy is clean by construction.
 *
 * Digests are of the lowercased canonical handle with and without a hyphen.
 * -------------------------------------------------------------------------- */

const HANDLE_DIGESTS = Object.freeze(new Set([
  '475d2db4bab2ff52561db77331627ca1811d2997ec907ba1adae23f9973aac0c',
  '921a4128fd209045574d4489ab6f15019ff31873991446b008d99701f24b6e7c',
]));

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Decode all supported encoding layers; repeat so doubled encodings collapse. */
export function canonicalizeForScan(text) {
  let out = String(text);
  for (let round = 0; round < 4; round += 1) {
    const before = out;
    out = out.replace(/\\{1,2}u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    out = out.replace(/\\{1,2}x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    out = out.replace(/%([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    out = out.replace(/&(?:#(?:x(?:2d|45)|45)|hyphen|dash);/gi, '-');
    if (out === before) break;
  }
  // Normalize all Unicode hyphen variants to ASCII '-'.
  return out.toLowerCase().replace(/[\u2010-\u2015]/g, '-');
}

/** Compact view: quotes, plus signs and whitespace removed (concatenation). */
function compactForScan(text) {
  return canonicalizeForScan(text).replace(/['"`+\s]/g, '');
}

/** Return the handle token if a canonicalized string contains it, else null. */
function findHandleToken(canonicalText) {
  // Candidate tokens: letter/hyphen runs. The handle is 8 or 9 characters.
  const re = /[a-z-]{8,9}/g;
  let match;
  while ((match = re.exec(canonicalText)) !== null) {
    const token = match[0].replace(/^-+|-+$/g, '');
    if (HANDLE_DIGESTS.has(digest(token))) return token;
  }
  return null;
}

/**
 * Return all personal-handle hits in `text`. Each hit is { form, sample }.
 * `form` names the concrete encoding class found in the raw input.
 */
export function detectHandleForms(text) {
  const input = String(text);
  const hits = [];
  const canonical = canonicalizeForScan(input);
  const compact = compactForScan(input);
  const canonicalToken = findHandleToken(canonical);
  const compactToken = canonicalToken ? null : findHandleToken(compact);

  // Concrete encoding classes, named only when a real handle token is present.
  const encodedPatterns = [
    { form: 'literal', re: /[a-z]{5}\s*-?\s*[a-z]{3}/i },
    { form: 'unicode-escape', re: /\\{1,2}u002d/i },
    { form: 'url-encoded', re: /%(?:2d|45|252d|2545)/i },
    { form: 'html-entity', re: /&(?:#(?:x(?:2d|45)|45)|hyphen|dash);/i },
  ];
  if (canonicalToken) {
    for (const { form, re } of encodedPatterns) {
      if (re.test(input)) hits.push({ form, sample: re.exec(input)[0] });
    }
    if (hits.length === 0) hits.push({ form: 'canonical', sample: canonicalToken });
  } else if (compactToken) {
    hits.push({ form: 'concatenated', sample: compactToken });
  }
  return hits;
}

/** True if `text` contains any recoverable form of the personal handle. */
export function hasHandleLeak(text) {
  return detectHandleForms(text).length > 0;
}

/**
 * Replace every recoverable handle form in `text` with `replacement`.
 * Used by scripts/prepare-neutral-source.mjs so both tools share one grammar.
 * Returns { text, replacements }. The replacement grammar itself is supplied
 * by the neutralizer from an external (denylisted) signature file, so no
 * handle literal is stored in this detector.
 */
export function neutralizeHandleText(text, patterns, replacement = 'example-org') {
  let out = String(text);
  let replacements = 0;
  for (const { re, flags = 'gi', replacement: perPattern } of patterns) {
    const matcher = new RegExp(re.source, flags);
    const value = perPattern ?? replacement;
    out = out.replace(matcher, () => { replacements += 1; return value; });
  }
  // Safety net: never let a form the canonicalizer recognizes survive.
  if (hasHandleLeak(out)) {
    out = out.split('\n').map((line) => (hasHandleLeak(line) ? replacement : line)).join('\n');
    replacements += 1;
  }
  return { text: out, replacements };
}

/** Sensitive-value detectors. Content/path checks only; a hit is a hard fail. */
const SENSITIVE_PATTERNS = Object.freeze([
  { id: 'personal-handle', note: 'default personal GitHub handle / author name (any encoding)', test: (s) => hasHandleLeak(s) },
  { id: 'personal-path-dsh', re: /D:\\\u00312412/i, note: 'personal Windows workspace path' },
  { id: 'personal-path-home', re: /dsh\u002dhome[\\/]/i, note: 'personal home/vault path' },
  { id: 'vault-path', re: /\.\u0073ecrets[\\/]/i, note: 'local vault / secrets path' },
  { id: 'real-domain', re: /(?:gemini-mcp-gateway|codemode-mcp-gateway)\.(?:vercel\.app|onrender\.com|railway\.app|netlify\.app)/i, note: 'real deployment hostname' },
  { id: 'secret-assignment', re: /['"]?(?:API_KEY|ACCESS_TOKEN|CLIENT_SECRET|REFRESH_TOKEN|BEARER)['"]?\s*[:=]\s*['"][A-Za-z0-9_\-]{20,}['"]/i, note: 'literal secret-like value' },
]);

/** Run one detector entry against a string; supports regex or predicate forms. */
function matchesPattern(detector, text) {
  return detector.re ? detector.re.test(text) : detector.test(text);
}

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
    if (rule.endsWith('.')) {
      // Neutral example templates are public-safe (e.g. the local config
      // example referenced by the quickstart). Only real local configs are
      // denied.
      if (/\.example\.json$/i.test(base)) return false;
      return rel.startsWith(rule) || base.startsWith(rule);
    }
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
    for (const detector of SENSITIVE_PATTERNS) {
      if (matchesPattern(detector, rel)) {
        violations.push({ file: rel, kind: detector.id, detail: `sensitive path: ${detector.note}` });
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
    for (const detector of SENSITIVE_PATTERNS) {
      if (matchesPattern(detector, content)) {
        violations.push({ file: rel, kind: detector.id, detail: `sensitive content: ${detector.note}` });
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
    for (const detector of SENSITIVE_PATTERNS) {
      if (matchesPattern(detector, rel)) violations.push({ file: rel, kind: detector.id, detail: `sensitive path: ${detector.note}` });
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
    for (const detector of SENSITIVE_PATTERNS) {
      if (matchesPattern(detector, content)) violations.push({ file: rel, kind: detector.id, detail: `sensitive content: ${detector.note}` });
    }
  }
  return { ok: violations.length === 0, violations };
}

// Run CLI only when executed directly (safe to import in tests).
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2));
}
