#!/usr/bin/env node
/**
 * scripts/platform-conformance.mjs — offline, read-only client-platform conformance.
 *
 * Batch 13 (platform eval). Given one or more capture/envelope fixture files,
 * check the four platform invariants that keep Gemini / ChatGPT / Claude from
 * contaminating each other's metrics and behaviour:
 *
 *   1. gemini   — tool results must NOT carry `structuredContent`.
 *   2. chatgpt  — tool results must be dual-encoded: `structuredContent` AND
 *                 a text JSON block in `content[]` (same logical payload).
 *   3. claude   — tool annotations must include `readOnlyHint` and
 *                 `destructiveHint` (they must be explicit booleans).
 *   4. tools/list — the entry tool surface stays exactly the same three tools
 *                 (`search`, `execute_read`, `execute`) on every platform.
 *
 * Hard rules for this script:
 *   - READ-ONLY: it never writes a file, never mutates the fixtures.
 *   - OFFLINE: no fetch, no network, no subprocess, no model/upstream calls.
 *   - DETERMINISTIC: every check returns one of `pass` | `fail` | `unknown`
 *     with at least one evidence requestId. `unknown` means "not enough signal
 *     in the fixture" — it is never silently treated as pass.
 *   - NO GUESSING: the platform is read only from the explicit envelope field
 *     `clientPlatform`. Missing / null / non-string / unknown -> `unknown` and
 *     that envelope is excluded from platform-specific checks (it can still be
 *     used for the platform-agnostic tools/list check when explicitly tagged).
 *
 * Usage:
 *   node scripts/platform-conformance.mjs --fixtures work/fixtures/gemini.json
 *   node scripts/platform-conformance.mjs --fixtures work/fixtures/   # dir of *.json
 *   node scripts/platform-conformance.mjs a.json b.json --json out.json   # (out is stdout only)
 *
 * Fixture shapes accepted (JSON):
 *   - a single envelope object
 *   - an array of envelopes
 *   - { "fixtures": [ ...envelopes ] }
 * An envelope is a capture-style record:
 *   {
 *     "requestId": "req-1",
 *     "clientPlatform": "gemini|chatgpt|claude|unknown",
 *     "request":  { "raw": "{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\",...}" },
 *     "response": { "raw": "{\"jsonrpc\":\"2.0\",\"result\":{...}}" }
 *   }
 * For convenience, `request.raw` / `response.raw` may also be objects or
 * pre-parsed JSON-RPC bodies. A `tools/list` envelope contributes tool-surface
 * evidence; a `tools/call` envelope contributes encoding/annotation evidence.
 *
 * Exit code: 0 = all checks pass; 1 = at least one `fail`; 2 = bad usage/input.
 * `unknown` results never cause exit 1 by themselves but are surfaced loudly.
 */

const KNOWN_PLATFORMS = ['gemini', 'chatgpt', 'claude'];
const UNKNOWN_PLATFORM = 'unknown';
export const EXPECTED_TOOLS = Object.freeze(['search', 'execute_read', 'execute']);

/* ------------------------------------------------------------------ *
 * Pure helpers (unit-tested in tests/platform-eval.test.js)
 * ------------------------------------------------------------------ */

/** Read the explicit clientPlatform from an envelope. Never infer. */
export function platformOf(envelope) {
  const value = envelope?.clientPlatform;
  if (typeof value !== 'string') return UNKNOWN_PLATFORM;
  const p = value.trim().toLowerCase();
  return KNOWN_PLATFORMS.includes(p) ? p : UNKNOWN_PLATFORM;
}

/** Stable requestId for evidence, or a deterministic positional fallback. */
function idOf(envelope, index) {
  const value = envelope?.requestId ?? envelope?.request?.id ?? envelope?.id;
  return value !== null && value !== undefined && String(value) !== ''
    ? String(value)
    : `idx:${index}`;
}

/** Parse a possibly-string JSON-RPC body. Returns null when not parseable. */
function parseBody(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/** JSON-RPC method of an envelope, or null. */
function methodOf(envelope) {
  return parseBody(envelope?.request?.raw)?.method ?? null;
}

/** JSON-RPC `result` of an envelope, or null. */
function resultOf(envelope) {
  return parseBody(envelope?.response?.raw)?.result ?? null;
}

/** A result is dual-encoded when it has structuredContent + one text JSON block. */
export function isDualEncoded(result) {
  if (!result || typeof result !== 'object') return false;
  const hasSc = Object.prototype.hasOwnProperty.call(result, 'structuredContent')
    && result.structuredContent !== undefined;
  const blocks = Array.isArray(result.content)
    ? result.content.filter((item) => item && item.type === 'text' && typeof item.text === 'string')
    : [];
  if (!hasSc || blocks.length !== 1) return false;
  try {
    const parsed = JSON.parse(blocks[0].text);
    // The two encodings must describe the same logical payload (deep-equal JSON).
    return JSON.stringify(parsed) === JSON.stringify(result.structuredContent);
  } catch {
    return false;
  }
}

function makeResult(check, status, evidence, detail) {
  return { check, status, evidence, detail };
}

/* ------------------------------------------------------------------ *
 * Individual checks — each returns { check, status, evidence, detail }
 * ------------------------------------------------------------------ */

/** Gemini tool results must never carry structuredContent. */
export function checkGeminiNoStructuredContent(envelopes) {
  const candidates = envelopes
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => platformOf(e) === 'gemini' && methodOf(e) === 'tools/call');
  if (!candidates.length) {
    return makeResult('gemini_no_structured_content', 'unknown', [], 'no gemini tools/call fixture');
  }
  const offenders = [];
  const checked = [];
  for (const { e, i } of candidates) {
    const id = idOf(e, i);
    checked.push(id);
    const result = resultOf(e);
    if (result && Object.prototype.hasOwnProperty.call(result, 'structuredContent')
        && result.structuredContent !== undefined) offenders.push(id);
  }
  return offenders.length
    ? makeResult('gemini_no_structured_content', 'fail', offenders, `${offenders.length} gemini result(s) leaked structuredContent`)
    : makeResult('gemini_no_structured_content', 'pass', checked.slice(0, 5), `${checked.length} gemini tool result(s) clean`);
}

/** ChatGPT tool results must be dual-encoded (structuredContent + text JSON). */
export function checkChatgptDualEncoding(envelopes) {
  const candidates = envelopes
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => platformOf(e) === 'chatgpt' && methodOf(e) === 'tools/call');
  if (!candidates.length) {
    return makeResult('chatgpt_dual_encoding', 'unknown', [], 'no chatgpt tools/call fixture');
  }
  const offenders = [];
  const checked = [];
  for (const { e, i } of candidates) {
    const id = idOf(e, i);
    checked.push(id);
    if (!isDualEncoded(resultOf(e))) offenders.push(id);
  }
  return offenders.length
    ? makeResult('chatgpt_dual_encoding', 'fail', offenders, `${offenders.length} chatgpt result(s) missing dual encoding`)
    : makeResult('chatgpt_dual_encoding', 'pass', checked.slice(0, 5), `${checked.length} chatgpt result(s) dual-encoded`);
}

/** Claude tool descriptors must carry explicit readOnlyHint + destructiveHint. */
export function checkClaudeAnnotations(envelopes) {
  const candidates = envelopes
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => platformOf(e) === 'claude' && methodOf(e) === 'tools/list');
  if (!candidates.length) {
    return makeResult('claude_annotations', 'unknown', [], 'no claude tools/list fixture');
  }
  const offenders = [];
  const checked = [];
  for (const { e, i } of candidates) {
    const id = idOf(e, i);
    checked.push(id);
    const tools = resultOf(e)?.tools;
    if (!Array.isArray(tools)) { offenders.push(id); continue; }
    for (const tool of tools) {
      const a = tool?.annotations;
      if (!a || typeof a.readOnlyHint !== 'boolean' || typeof a.destructiveHint !== 'boolean') {
        offenders.push(`${id}:${tool?.name ?? 'unnamed'}`);
      }
    }
  }
  return offenders.length
    ? makeResult('claude_annotations', 'fail', offenders, `${offenders.length} claude tool annotation violation(s)`)
    : makeResult('claude_annotations', 'pass', checked.slice(0, 5), `${checked.length} claude tools/list fixture(s) annotated`);
}

/** tools/list must expose exactly the same three entry tools on every platform. */
export function checkStableToolsList(envelopes, expected = EXPECTED_TOOLS) {
  const candidates = envelopes
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => methodOf(e) === 'tools/list');
  if (!candidates.length) {
    return makeResult('stable_tools_list', 'unknown', [], 'no tools/list fixture');
  }
  const offenders = [];
  const checked = [];
  for (const { e, i } of candidates) {
    const id = idOf(e, i);
    checked.push(id);
    const tools = resultOf(e)?.tools;
    const names = Array.isArray(tools) ? tools.map((t) => t?.name) : null;
    if (!names || names.length !== expected.length || names.some((n, k) => n !== expected[k])) {
      offenders.push(id);
    }
  }
  return offenders.length
    ? makeResult('stable_tools_list', 'fail', offenders, `expected exactly [${expected.join(', ')}]`)
    : makeResult('stable_tools_list', 'pass', checked.slice(0, 5), `${checked.length} tools/list fixture(s) stable`);
}

/** Run all checks. `fixtures` may be a single envelope or an array. */
export function runConformance(fixtures, { expectedTools = EXPECTED_TOOLS } = {}) {
  const list = Array.isArray(fixtures) ? fixtures : [fixtures];
  const envelopes = list.filter((item) => item && typeof item === 'object');
  const checks = [
    checkGeminiNoStructuredContent(envelopes),
    checkChatgptDualEncoding(envelopes),
    checkClaudeAnnotations(envelopes),
    checkStableToolsList(envelopes, expectedTools),
  ];
  const status = checks.some((c) => c.status === 'fail') ? 'fail'
    : checks.every((c) => c.status === 'pass') ? 'pass'
      : 'unknown';
  return { status, fixtures: envelopes.length, checks };
}

/* ------------------------------------------------------------------ *
 * Fixture loading (local files / directories only — no network)
 * ------------------------------------------------------------------ */

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

async function loadOne(path) {
  const text = await readFile(path, 'utf8');
  const data = JSON.parse(text);
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.fixtures)) return data.fixtures;
  return [data];
}

/** Load fixtures from files and/or directories of *.json. Purely local. */
export async function loadFixtures(paths) {
  const out = [];
  for (const input of paths) {
    const target = resolve(input);
    const info = await stat(target);
    if (info.isDirectory()) {
      const names = (await readdir(target)).filter((n) => n.endsWith('.json')).sort();
      for (const name of names) out.push(...await loadOne(join(target, name)));
    } else {
      out.push(...await loadOne(target));
    }
  }
  return out;
}

/** Human-readable report. */
export function renderReport(result) {
  const lines = [
    `# Platform conformance — ${result.status.toUpperCase()}`,
    '',
    `Fixtures loaded: ${result.fixtures}`,
    '',
    '| Check | Status | Evidence (requestId) | Detail |',
    '|---|---|---|---|',
    ...result.checks.map((c) => `| ${c.check} | ${c.status} | ${c.evidence.map((id) => `\`${id}\``).join(', ') || '—'} | ${c.detail} |`),
    '',
    '> Offline, read-only. `unknown` = insufficient fixture signal, never a pass.',
  ];
  return lines.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const paths = args.filter((a) => !a.startsWith('--'));
  if (!paths.length) {
    console.error('[conformance] usage: node scripts/platform-conformance.mjs --fixtures <file-or-dir> [...]');
    process.exitCode = 2;
    return;
  }
  try {
    const fixtures = await loadFixtures(paths);
    const result = runConformance(fixtures);
    process.stdout.write(renderReport(result) + '\n');
    process.exitCode = result.status === 'fail' ? 1 : 0;
  } catch (error) {
    console.error(`[conformance] failed: ${error?.message ?? String(error)}`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && process.argv[1].endsWith('platform-conformance.mjs')) {
  main().catch((error) => {
    console.error(`[conformance] failed: ${error?.message ?? String(error)}`);
    process.exitCode = 2;
  });
}
