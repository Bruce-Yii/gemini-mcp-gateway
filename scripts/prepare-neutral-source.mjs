#!/usr/bin/env node
/**
 * Build a neutralized copy of the allowlisted source tree for OSS export.
 *
 * This script fixes the P0 neutralizer bug: the old temporary helper rewrote
 * the private handle into a JS unicode escape, which is itself a recoverable
 * form. The new neutralizer replaces every equivalent form with a neutral
 * placeholder and then self-neutralizes its own source, so its exported copy
 * contains no handle signature at all.
 *
 * It never touches the private source tree, never initializes git, and never
 * commits, pushes or deploys. By default it is a dry-run; pass --write to copy.
 *
 * Usage:
 *   node scripts/prepare-neutral-source.mjs --out <dir> [--source <dir>]
 *   node scripts/prepare-neutral-source.mjs --out <dir> --write
 *   node scripts/prepare-neutral-source.mjs --out <dir> --check
 *
 * Exit codes: 0 = ok / clean, 1 = validation or CLI failure.
 *
 * NOTE: the private handle segments are literal constants in this file because
 * this tool must recognize them in the private source. They are scrubbed from
 * the copy written to staging (including this file itself) before export.
 */
import {
  copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildPlan, canonicalizeForScan, detectHandleForms, hasHandleLeak,
  neutralizeHandleText, validateSelected,
} from './export-oss.mjs';

const SCRIPT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Neutral values written into the exported tree. */
const NEUTRAL = Object.freeze({
  handle: 'example-org',
  workspace: 'C:\\work',
  home: 'local-home',
  secrets: '.config',
  domain: 'example-org.example.com',
  // Used only when scrubbing this script's own signature constants.
  segmentA: 'owner',
  segmentB: 'label',
});

/**
 * Private handle segments. Kept as two separate literals so the detector's
 * own canonicalization cannot be trivially reversed from a single constant;
 * both are erased from the exported copy by self-neutralization.
 */
const SEG_A = 'Bruce';
const SEG_B = 'Yii';

const HYPHEN = '[\\u002d\\u2010-\\u2015]';

/** Escape a literal for safe interpolation into a RegExp source. */
function esc(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * All regexes that describe an equivalent form of the handle.
 * Patterns use `gi` flags; each entry is { re, flags } for the shared
 * neutralizeHandleText() helper.
 */
export function handlePatterns() {
  const a = esc(SEG_A);
  const b = esc(SEG_B);
  return [
    // Canonical / literal, optionally split by hyphen or Unicode hyphen.
    { re: new RegExp(`${a}${HYPHEN}?${b}`, 'gi'), flags: 'gi' },
    // JS/JSON unicode-escaped separator: \u002d or \\u002d (and \x2d).
    { re: new RegExp(`${a}(?:\\\\{1,2}u002d|\\\\{1,2}x2d)${b}`, 'gi'), flags: 'gi' },
    // URL encoding, single and double encoded.
    { re: new RegExp(`${a}(?:%2d|%45|%252d|%2545)${b}`, 'gi'), flags: 'gi' },
    // HTML entity separators.
    { re: new RegExp(`${a}(?:&#0*45;?|&#x0*2d;?|&hyphen;|&dash;)${b}`, 'gi'), flags: 'gi' },
    // Runtime concatenation: 'A' + '-B', "A"+"B", backtick forms. The match
    // consumes the surrounding quotes, so replace with a quoted JS literal.
    {
      re: new RegExp(`(['"\`]?)${a}\\1\\s*\\+\\s*(['"\`]?)${HYPHEN}?${b}\\2`, 'gi'),
      flags: 'gi',
      replacement: `'${NEUTRAL.handle}'`,
    },
    // Character-code reconstruction (as used by older tooling). Also an
    // expression, so use a quoted literal.
    {
      re: new RegExp(
        `String\\.fromCharCode\\(\\s*${[...SEG_A, ...SEG_B].map((c) => c.charCodeAt(0)).join('\\s*,\\s*')}\\s*\\)`,
        'g',
      ),
      flags: 'g',
      replacement: `'${NEUTRAL.handle}'`,
    },
  ];
}

/**
 * Bare handle segments in prose. Word boundaries keep npm integrity hashes
 * (e.g. "...Yyii07tpPsLw==") and other unrelated identifiers untouched.
 */
const BARE_SEGMENT_PATTERNS = Object.freeze([
  { re: new RegExp(`\\b${esc(SEG_A)}\\b`, 'g'), replacement: NEUTRAL.segmentA },
  { re: new RegExp(`\\b${esc(SEG_B)}\\b`, 'g'), replacement: NEUTRAL.segmentB },
]);

/** Additional non-handle neutralizations (paths, real hostnames). */
const OTHER_PATTERNS = Object.freeze([
  { re: /D:\\12412/g, replacement: NEUTRAL.workspace },
  { re: /dsh[-_]home[\\/]/gi, replacement: `${NEUTRAL.home}/` },
  { re: /\.secrets[\\/]/gi, replacement: `${NEUTRAL.secrets}/` },
  {
    re: /(?:gemini-mcp-gateway|codemode-mcp-gateway)\.(?:vercel\.app|onrender\.com|railway\.app|netlify\.app)/gi,
    replacement: NEUTRAL.domain,
  },
]);

/**
 * Neutralize one text file. `self: true` additionally erases this script's own
 * signature constants from the copy that will be exported.
 * Returns { text, replacements }.
 */
export function neutralizeText(content, { self = false } = {}) {
  let text = String(content);
  let replacements = 0;

  const out = neutralizeHandleText(text, handlePatterns(), NEUTRAL.handle);
  text = out.text;
  replacements += out.replacements;

  for (const { re, replacement } of [...OTHER_PATTERNS, ...BARE_SEGMENT_PATTERNS]) {
    const before = text;
    text = text.replace(new RegExp(re.source, re.flags), replacement);
    if (text !== before) replacements += 1;
  }

  if (self) {
    // The signature constants are themselves whole words, so the generic rule
    // above already erases them from the copy. This fallback catches any
    // uppercase variant that word-boundary matching might have missed.
    for (const [segment, neutral] of [[SEG_A, NEUTRAL.segmentA], [SEG_B, NEUTRAL.segmentB]]) {
      const re = new RegExp(esc(segment), 'gi');
      const before = text;
      text = text.replace(re, neutral);
      if (text !== before) replacements += 1;
    }
  }

  return { text, replacements };
}

/** Throw if any recoverable handle form survived neutralization. */
export function assertClean(text, label = 'tree') {
  const hits = detectHandleForms(text);
  if (hits.length) {
    throw new Error(`handle leak survived neutralization in ${label}: ${hits.map((h) => h.form).join(', ')}`);
  }
}

function parseArgs(argv) {
  const args = { out: null, source: null, write: false, check: false, help: false, errors: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) args.errors.push('--out requires a directory');
      else args.out = value;
    } else if (arg.startsWith('--out=')) {
      args.out = arg.slice('--out='.length) || null;
    } else if (arg === '--source') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) args.errors.push('--source requires a directory');
      else args.source = value;
    } else if (arg.startsWith('--source=')) {
      args.source = arg.slice('--source='.length) || null;
    } else if (arg === '--write') args.write = true;
    else if (arg === '--check') args.check = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else args.errors.push(`unknown argument: ${arg}`);
  }
  if (args.write && args.check) args.errors.push('--write and --check are mutually exclusive');
  if (!args.help && !args.out) args.errors.push('--out <dir> is required');
  return args;
}

const SELF_REL = 'scripts/prepare-neutral-source.mjs';
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set([
  '', '.js', '.mjs', '.cjs', '.json', '.md', '.txt', '.yml', '.yaml', '.toml',
  '.html', '.css', '.sh', '.ps1', '.example', '.jsonl', '.svg',
]);

function isTextFile(rel) {
  const base = rel.split('/').pop();
  const dot = base.lastIndexOf('.');
  const ext = dot === -1 ? '' : base.slice(dot);
  if (/^Dockerfile/.test(base) || /^Makefile/.test(base) || base === 'LICENSE') return true;
  return TEXT_EXTENSIONS.has(ext);
}

/**
 * Pure: build the neutralized file map for a source root.
 * Returns { files: { [rel]: { text } | { binary: true, source } }, counts }
 */
export function buildNeutralMap(root = SCRIPT_ROOT) {
  const plan = buildPlan(root);
  const files = {};
  let replacements = 0;

  for (const rel of plan.files) {
    const source = join(root, rel);
    let content;
    try {
      if (statSync(source).size > MAX_TEXT_BYTES || !isTextFile(rel)) {
        files[rel] = { binary: true, source };
        continue;
      }
      content = readFileSync(source, 'utf8');
    } catch {
      files[rel] = { binary: true, source };
      continue;
    }
    const result = neutralizeText(content, { self: rel === SELF_REL });
    assertClean(result.text, rel);
    files[rel] = { text: result.text };
    replacements += result.replacements;
  }
  return { files, counts: { ...plan.counts, replacements } };
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log([
      'Usage: node scripts/prepare-neutral-source.mjs --out <dir> [--source <dir>] [--write|--check]',
      '',
      '  --out <dir>     destination neutral-source tree (required)',
      '  --source <dir>  private source root (default: repo root)',
      '  --write         actually write the neutralized copy',
      '  --check         only verify the neutralization grammar, write nothing',
    ].join('\n'));
    return 0;
  }
  if (args.errors.length) {
    for (const error of args.errors) console.error(`[prepare-neutral] ${error}`);
    return 1;
  }

  const root = args.source ? resolve(args.source) : SCRIPT_ROOT;
  const out = resolve(args.out);
  const map = buildNeutralMap(root);
  console.log(`[prepare-neutral] source=${root}`);
  console.log(`[prepare-neutral] plan: ${map.counts.included} included, ${map.counts.replacements} replacements`);

  if (args.check) {
    const dirty = [];
    for (const [rel, entry] of Object.entries(map.files)) {
      if (entry.text && hasHandleLeak(entry.text)) dirty.push(rel);
    }
    if (dirty.length) {
      for (const rel of dirty) console.error(`[prepare-neutral] LEAK ${rel}`);
      return 1;
    }
    console.log('[prepare-neutral] NEUTRAL CHECK PASSED (0 handle forms)');
    return 0;
  }

  if (!args.write) {
    console.log('[prepare-neutral] DRY RUN: no files written. Re-run with --write.');
    return 0;
  }

  mkdirSync(out, { recursive: true });
  for (const [rel, entry] of Object.entries(map.files)) {
    const dest = join(out, rel);
    mkdirSync(dirname(dest), { recursive: true });
    if (entry.binary) copyFileSync(entry.source, dest);
    else writeFileSync(dest, entry.text, 'utf8');
  }
  console.log(`[prepare-neutral] wrote ${Object.keys(map.files).length} neutralized files to ${out}`);

  // Validate the written tree against the export detector.
  const result = validateSelected(out, Object.keys(map.files));
  if (!result.ok) {
    for (const v of result.violations) console.error(`[prepare-neutral] VIOLATION ${v.kind}: ${v.file}`);
    return 1;
  }
  console.log('[prepare-neutral] post-write validation passed (0 violations)');
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2));
}
