#!/usr/bin/env node
/**
 * Repo-wide "silent truncation" audit (read-only).
 *
 * Lexical, heuristic scanner: it never imports or executes project code, never
 * writes files, and never talks to the network. It flags two things:
 *
 *   1. string cuts: `.slice(n)` / `.substring(n)` / `.substr(n)` (one arg),
 *   2. explicit truncation call sites: `truncate(...)` / `truncateResultValue(...)`
 *      / `truncateResponseText(...)` / `boundResult(...)` / `sliceLines(...)`,
 *      or a `maxChars` / `maxBytes` / `maxLength` bound applied with a `.slice()`.
 *
 * It then grades each finding:
 *
 *   P0 - production path (src/) truncates without a marker
 *   P1 - possible context/result truncation without a marker
 *   P2 - log/display truncation, explicit marker present, or exempt use
 *
 * "Marked" means a known marker is visible at the call site, in the enclosing
 * helper, or anywhere in the same file (e.g. `--- TRUNCATED ---`,
 * `truncationSuffix`, `…[truncated]`, `…[+N chars]`, `REDACTED`, a locating
 * hint). A marker near the truncation makes the loss observable to the
 * human/model, so it is acceptable (P2, noted in the ledger).
 *
 * Exit codes: P0 -> 1; P1/P2 -> 0. `--ci` keeps P1 warning-only. `--json`
 * prints a machine-readable report. Tests import the pure functions below.
 *
 * Usage:
 *   node scripts/audit-truncation.mjs
 *   node scripts/audit-truncation.mjs --json
 *   node scripts/audit-truncation.mjs --ci
 *   node scripts/audit-truncation.mjs --root DIR   # tests / alternate tree
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
export const DEFAULT_ROOTS = ['src', 'scripts', 'tests', 'harness', 'bench'];
const SCAN_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);
const SKIP_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'coverage', 'data', 'docs', '.github']);

/** Tokens that make a truncation observable to a human/model. */
export const MARKER_TOKENS = [
  '--- truncated ---',
  'truncated',
  'truncation',
  'truncating',
  '…[',
  '[truncated',
  'chars by gateway',
  'chars total',
  'more items',
  'locating hint',
  'redacted',
  '…[+',
  'marker',
];

/** Truncation helper calls that count as explicit cap sites. */
const TRUNC_CALL_RE = /\b(?:truncate|truncateResultValue|truncateResponseText|boundResult|sliceLines|truncateResult|boundLogs|compactDescription)\s*\(/;
/** Cap identifiers (used only in combination with a cut/call, not alone). */
const CAP_RE = /\b(?:maxChars|maxBytes|maxLength|maxResultChars|maxCode|maxError|MAX_NAME_LENGTH|MAX_BRANCHES|MAX_SEARCH_DESC_CHARS)\b/;
/** String cut with up to two simple args: `.slice(n)` or `.slice(0, n)`. */
const CUT_RE = /\.(slice|substring|substr)\s*\(\s*([^()]*?)\s*\)/g;

/** Receiver expressions that are arrays/argv, not payload strings. */
const ARRAY_RECEIVER_RE = /(?:\bprocess\.argv|\bargv|\bargs|\bitems|\blines|\bhunks|\bsegments|\bgroups|\bevents|\bmatches|\bfiles|\btokens|\bkeys|\bentries|\btools|\bnames|\bresults|\blist|\barray|\barr|\bparts|\bout|\bcommands?|\bsegments?|\bsuites?|\btodo|\bselected|\btargets|\bsource\.matchAll|\bplines|\bops)\s*$/;
/** Prefix/flag stripping passed as an argument expression (not a length cap). */
const PREFIX_STRIP_ARG_RE = /^\s*(?:['"`]|--|[A-Za-z_$][\w$]*\s*\.\s*length)\b/;

/**
 * Classify a single candidate finding.
 * @param {{path:string,line:number,text:string,snippet:string,marker:boolean,
 *          kind:string, fileMarked:boolean}} candidate
 * @returns {{severity:'P0'|'P1'|'P2',reason:string,exempt:boolean}}
 */
export function classify(candidate) {
  const { path, snippet, marker, kind, fileMarked } = candidate;
  const src = String(snippet ?? '');
  const normalizedPath = String(path ?? '').replace(/\\/g, '/');
  const inSrc = normalizedPath.startsWith('src/');
  const inTests = normalizedPath.startsWith('tests/') || normalizedPath.startsWith('fixtures/');

  // ---- Hard exemptions ----------------------------------------------------
  // process.argv / args parsing is never a payload truncation.
  if (/process\.argv\s*\.slice|\bargv\.slice\(|\bargs\s*=\s*process\.argv|const \[?\s*\w+\s*,?\s*\.\.\.\w+\]?\s*=\s*process\.argv/.test(src)) {
    return { severity: 'P2', reason: 'argv parsing (not a payload truncation)', exempt: true };
  }
  // Prefix stripping: arg.slice('--config='.length), q.slice(1), parts.slice(1),
  // line.slice(1) after a diff-op prefix check (`line[0] === '+'`).
  if (/\.slice\(\s*(?:['"`]|--|[A-Za-z_$][\w$]*\s*\.\s*length)/.test(src) ||
      (/\.slice\(\s*1\s*\)/.test(src) && /(arg|name|args|command|parts|prefix|fragment|init|raw|line\[0\]|line\.charAt)/i.test(src))) {
    return { severity: 'P2', reason: 'prefix/flag stripping (not payload truncation)', exempt: true };
  }
  // Array/argv receiver: command.slice(1), lines.slice(cursor), items.slice(0,n).
  const receiver = src.split(/\.(?:slice|substring|substr)\s*\(/)[0];
  if (ARRAY_RECEIVER_RE.test(receiver)) {
    return { severity: 'P2', reason: 'array/argv receiver (not a string cut)', exempt: true };
  }
  // Delimiter split: name.slice(0, separator) where the cut index is a computed
  // separator position, not a fixed cap.
  if (/\.slice\(\s*0\s*,\s*(?:separator|idx|index|sep|i|pos|end|n)\s*\)/i.test(src)) {
    return { severity: 'P2', reason: 'delimiter split (not a fixed-cap truncation)', exempt: true };
  }
  if (kind === 'cut') {
    // Zero-arg clone.
    if (/\.(?:slice|substring|substr)\s*\(\s*\)/.test(src)) {
      return { severity: 'P2', reason: 'array clone (no truncation)', exempt: true };
    }
    // Date / timestamp prefix extraction: iso.slice(0, 10), raw.slice(0, 10).
    if (/\.slice\(\s*0\s*,\s*10\s*\)/.test(src) && /(date|day|iso|time|timestamp|toISOString|raw)/i.test(src)) {
      return { severity: 'P2', reason: 'date prefix extraction', exempt: true };
    }
    // Literal window used by test fixtures / demo analysis (e.g. slice(-200)).
    if (inTests && /\.slice\(\s*-?\d/.test(src)) {
      return { severity: 'P2', reason: 'test-only slice', exempt: true };
    }
  }
  // Cap identifier declarations / config pass-through are not truncations.
  if (kind === 'cap' && !TRUNC_CALL_RE.test(src) && !/\.(slice|substring|substr)\s*\(/.test(src)) {
    return { severity: 'P2', reason: 'cap declaration/config pass-through (not a cut site)', exempt: true };
  }

  // ---- Grading ------------------------------------------------------------
  if (marker || fileMarked) {
    return { severity: 'P2', reason: 'explicit truncation marker present', exempt: false };
  }
  const isLogOrDisplay = /(console\.|logger\.|\blog\(|errorMessage|e\.message|err\.message|preview|digest|report|markdown|`\| |\bprompt\.slice|\bbody:|\banswer:|\bsummary:|\btext:|\btitle:|\bsampleError:|\brawReqSnippet|\brawRespSnippet|console\.log|\.push\([^)]*slice)/i.test(src);
  const isErrorSnippet = /(HTTP|response\.status|throw new Error|failed|exited early)/i.test(src) && /\.(slice|substring|substr)\(\s*-?\d/.test(src);
  if (isLogOrDisplay || isErrorSnippet) {
    return { severity: 'P2', reason: 'log/display/error-message truncation (acceptable, note required)', exempt: false };
  }
  if (inSrc) {
    return { severity: 'P0', reason: 'production path (src/) truncates without a marker', exempt: false };
  }
  if (inTests) {
    return { severity: 'P2', reason: 'test-only truncation', exempt: false };
  }
  return { severity: 'P1', reason: 'possible context/result truncation without a marker', exempt: false };
}

/** Explicit marker phrases that make a cut observable on the same/nearby line. */
const LOCAL_MARKER_RE = /(---\s*truncated\s*---|truncated\s+from|truncated\s+\d|\[truncated|…\[|\.\.\.\[|truncationsuffix|trunc_marker|truncated_marker|\[redacted\]|chars\s+by\s+gateway|chars\s+total|more\s+items|truncated\s*\?|truncated\s*:|\btruncated\s*=|\bhint\s*:|showing\s+\$\{|showing\s+\d|narrow\s+the\s+query|raise\s+limit)/i;

function fileHasMarker(lines) {
  const text = lines.join('\n');
  // A file that defines a marker constant or emits a marker string makes its
  // cut sites observable by construction.
  return /(---\s*truncated\s*---|truncationsuffix|…\[truncated|…\[\+|\[redacted\]|trunc_marker|truncated_marker|marker\s*=|\.\.\.\[truncated|truncated\s+from)/i.test(text);
}

function hasLocalMarker(lines, index) {
  const window = lines.slice(Math.max(0, index - 3), Math.min(lines.length, index + 8)).join('\n');
  return LOCAL_MARKER_RE.test(window);
}

function contextOf(text) {
  if (/console\.|logger\.|\blog\(|error|preview|digest|report|markdown/i.test(text)) return 'log/display';
  if (/result|response|body|output|text|context|content/i.test(text)) return 'result/context';
  return 'other';
}

function locationsInLine(line, pattern) {
  const matches = [];
  let match;
  pattern.lastIndex = 0;
  while ((match = pattern.exec(line)) !== null) {
    matches.push(match);
    if (match[0].length === 0) pattern.lastIndex += 1;
  }
  return matches;
}

/**
 * Scan one in-memory source string. Pure: no filesystem access.
 * @returns {Array<object>} findings with severity/reason/exempt attached
 */
export function scanSource(source, path = '<memory>') {
  const lines = String(source).split(/\r?\n/);
  const fileMarked = fileHasMarker(lines);
  const findings = [];
  lines.forEach((line, index) => {
    if (/^\s*(\/\/|\/\*|\*|#)/.test(line)) return; // comment-only line
    const marked = fileMarked || hasLocalMarker(lines, index);
    const cuts = locationsInLine(line, CUT_RE);
    let hasCut = false;

    for (const match of cuts) {
      const args = String(match[2] ?? '').split(',').map((part) => part.trim());
      // Range expressions (start + 1, Math.min(...), ternaries, property reads)
      // are selective reads, not "drop the tail" truncations.
      if (args.some((arg) => /[+?]/.test(arg) || /Math\./.test(arg) || /[.\[\]'"`]/.test(arg))) continue;
      // Empty arg list is a clone/no-op. `.slice(0)` is also a no-op.
      if (args.length === 0 || (args.length === 1 && args[0] === '')) continue;
      if (args.length === 1 && args[0] === '0') continue;
      // `.slice(a, b)` with two non-numeric variables is a selective range read
      // unless the first arg is 0 (keep-head truncation).
      const numeric = (value) => /^-?\d+$/.test(value) || /^[A-Z][A-Z0-9_]*$/.test(value) || /\bmax(?:Chars|Bytes|Length)\b/i.test(value);
      if (args.length === 2 && args[0] !== '0' && (!numeric(args[0]) || !numeric(args[1]))) continue;
      hasCut = true;
      const snippet = line.trim();
      findings.push({
        path, line: index + 1, text: snippet, kind: 'cut',
        context: contextOf(snippet), marker: marked, fileMarked,
        ...classify({ path, line: index + 1, text: snippet, snippet, marker: marked, kind: 'cut', fileMarked }),
      });
    }

    // Truncation helper call sites (one per line). Skip if the line already
    // produced a cut finding, to avoid double-reporting the same statement.
    if (!hasCut && (TRUNC_CALL_RE.test(line) || (CAP_RE.test(line) && /\.(slice|substring|substr)\s*\(/.test(line)))) {
      const snippet = line.trim();
      findings.push({
        path, line: index + 1, text: snippet, kind: 'cap',
        context: contextOf(snippet), marker: marked, fileMarked,
        ...classify({ path, line: index + 1, text: snippet, snippet, marker: marked, kind: 'cap', fileMarked }),
      });
    }
  });
  return findings;
}

/** Scan a file on disk. */
export function scanFile(file, rootPath = REPO_ROOT) {
  return scanSource(readFileSync(file, 'utf8'), relative(rootPath, file).split(sep).join('/'));
}

function walk(dir, rootPath, found = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return found; }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name) || entry.name.startsWith('.')) continue;
      walk(full, rootPath, found);
    } else if (entry.isFile() && SCAN_EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf('.')))) {
      found.push(full);
    }
  }
  return found;
}

/** Audit an entire tree. Read-only; returns a structured report object. */
export function auditTree({ root = REPO_ROOT, roots = DEFAULT_ROOTS } = {}) {
  const files = [];
  for (const relRoot of roots) {
    const abs = resolve(root, relRoot);
    try { statSync(abs); } catch { continue; }
    walk(abs, root, files);
  }
  files.sort();
  const findings = files.flatMap((file) => scanFile(file, root));
  const counts = { P0: 0, P1: 0, P2: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  return { root, roots, filesScanned: files.length, counts, findings };
}

/** Summarize an audit report for humans/CI/JSON. */
export function summarize(report, { mode = 'human' } = {}) {
  const { counts, findings, filesScanned } = report;
  if (mode === 'json') {
    return JSON.stringify({ ok: counts.P0 === 0, filesScanned, counts, findings }, null, 2);
  }
  const lines = [];
  lines.push(`[audit-truncation] scanned ${filesScanned} files: P0=${counts.P0} P1=${counts.P1} P2=${counts.P2}`);
  const shown = mode === 'ci'
    ? findings.filter((finding) => !finding.exempt && (finding.severity === 'P0' || finding.severity === 'P1'))
    : findings;
  for (const finding of shown) {
    lines.push(`  ${finding.severity} ${finding.path}:${finding.line} [${finding.kind}/${finding.exempt ? 'exempt' : finding.marker ? 'marked' : 'unmarked'}] ${finding.reason}`);
    lines.push(`      ${finding.text.slice(0, 200)}`);
  }
  if (counts.P0 > 0) lines.push(`[audit-truncation] FAIL: ${counts.P0} unmarked production truncation(s) found.`);
  else lines.push('[audit-truncation] PASS (P1 is warning-only; P2 is informational).');
  return lines.join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const ci = args.includes('--ci');
  const rootIndex = args.indexOf('--root');
  const root = rootIndex >= 0 && args[rootIndex + 1] ? resolve(args[rootIndex + 1]) : REPO_ROOT;
  const report = auditTree({ root });
  console.log(summarize(report, { mode: json ? 'json' : ci ? 'ci' : 'human' }));
  process.exitCode = report.counts.P0 > 0 ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
