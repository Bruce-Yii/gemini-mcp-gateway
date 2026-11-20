/**
 * explore/trace.mjs — harness observability helpers for the exploration runner.
 *
 * This module is deliberately side-effect free at import time. It provides:
 *   - run provenance helpers (git sha / file hashes)
 *   - fixture (placeholder) detection, so "fake 404s" from official examples
 *     can be attributed to task data instead of the gateway
 *   - root-cause classification shared by run-explore.mjs and analyze2.mjs
 *   - a deduplicating anomaly collector (task + type + detail[:80])
 *   - trace / manifest / metrics writers that only persist STRUCTURE, never
 *     full raw token text (all previews are bounded).
 *
 * All outputs go under explore/results/ and are git-ignored (see .gitignore).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const RESULTS_DIR = 'explore/results';
const TRACES_DIR = path.join(RESULTS_DIR, 'traces');
export const DETECTOR_VERSION = '2.1';

/* ------------------------------------------------------------------ *
 * Provenance
 * ------------------------------------------------------------------ */
export function gitSha() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

export function sha256File(file) {
  try {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Fixture / placeholder detection (D8 / R4)
 * ------------------------------------------------------------------ */
// Known synthetic identifiers used by official MCP examples. A task prompt
// containing any of these cannot produce a reliable "not found" signal.
export const PLACEHOLDER_RE = /octocat|hello-world|abc1234|example\.com|v1\.0\.0|#\d{1,6}\b|123456|LIN-123|lorem ipsum|test-repo|dummy/ig;

export function detectPlaceholders(text) {
  const found = new Set();
  const src = String(text ?? '');
  for (const m of src.matchAll(PLACEHOLDER_RE)) found.add(m[0]);
  return [...found];
}

/* ------------------------------------------------------------------ *
 * Root-cause classification (R2 / R5)
 *
 * #21: a bare "schema" substring is NOT a schema-validation signal.
 * Upstream error blobs embed whole JSON schemas / tool descriptions, which is
 * why 20 clean Vercel 404/403 results used to get labelled
 * "schema/arg-name mismatch". Only explicit validation signatures count as
 * the schema class; plain upstream 404/403 map to upstream_not_found /
 * upstream_forbidden instead of being pinned on the gateway.
 * ------------------------------------------------------------------ */
const ENUM_VALIDATION_RE = /Invalid option|does not equal any of|expected one of|valid option/i;
const PARAM_VALIDATION_RE = /missing required|required parameter|Invalid arguments for tool/i;
const SCHEMA_VALIDATION_RE = /arg(?:ument)?[ -]?name mismatch|unexpected\s+\w*\s*argument|does not (?:match|conform to) (?:the )?schema|schema validation|validating\s+"?arguments"?|validation (?:failed|error)/i;
const UPSTREAM_FORBIDDEN_RE = /\b403\b|\b401\b|unauthorized|forbidden|not accessible/i;
const UPSTREAM_NOT_FOUND_RE = /\b404\b|\bnot found\b|not_found\b|no commit found|does not exist/i;

/** Strong upstream HTTP failure marker (survives JSON quote escaping). */
function explicitUpstreamStatus(s) {
  const re = /API request failed \(\s*(404|403|401)\b|\bstatus[^0-9]{0,6}(404|403|401)\b/i;
  const m = re.exec(s);
  return m ? ((m[1] ?? m[2]) === '404' ? 'upstream_not_found' : 'upstream_forbidden') : null;
}

export function classifyRootCause(detail) {
  const s = String(detail ?? '');
  // An explicit upstream 404/403 wins over validation-like text that a long
  // error blob may embed (tool schemas / descriptions) — that embedding is
  // exactly what produced the 20 false schema labels (#21).
  const explicitStatus = explicitUpstreamStatus(s);
  if (explicitStatus) return explicitStatus;
  // Explicit validation signatures otherwise: genuine input/schema problems.
  if (ENUM_VALIDATION_RE.test(s)) return 'enum/valid-option mismatch';
  if (PARAM_VALIDATION_RE.test(s)) return 'param validation';
  if (SCHEMA_VALIDATION_RE.test(s)) return 'schema/arg-name mismatch';
  // #21: a clean upstream 404/403 is an upstream condition, not a gateway
  // schema defect. Check status BEFORE any generic runtime/result markers.
  if (UPSTREAM_FORBIDDEN_RE.test(s)) return 'upstream_forbidden';
  if (UPSTREAM_NOT_FOUND_RE.test(s)) return 'upstream_not_found';
  if (/ReferenceError|TypeError|is not a function|not defined|undefined/i.test(s)) return 'JS/runtime error';
  if (/truncated|too large|exceeds|maxResultChars|content-block/i.test(s)) return 'result too large';
  if (/429|500|502|503|504|ETIMEDOUT|ECONNRESET|timeout/i.test(s)) return 'infra';
  return 'other';
}

export function isNotFound(text) {
  return /404\s+not\s+found|\bnot found\b|no commit found|does not exist/i.test(String(text ?? ''));
}

export function isInfraError(text) {
  return /429|500|502|503|504|ETIMEDOUT|ECONNRESET|timeout/i.test(String(text ?? ''));
}

/* ------------------------------------------------------------------ *
 * #22 — pick the execute tool result by NAME, never by turn position
 * ------------------------------------------------------------------ */
export const EXECUTE_TOOL_NAMES = ['execute', 'execute_read'];

export function isExecuteTool(name) {
  const n = String(name ?? '');
  return EXECUTE_TOOL_NAMES.includes(n) || EXECUTE_TOOL_NAMES.some((x) => n.endsWith('__' + x));
}

/**
 * A single turn may contain both a `search` and an `execute`/`execute_read`
 * tool result. Pick the execute one by tool name; a search result must never
 * become the detail of an execute_error anomaly (#22). Returns null on a
 * search-only turn.
 */
export function pickExecuteResult(toolResults) {
  if (!Array.isArray(toolResults)) return null;
  return toolResults.find((r) => isExecuteTool(r?.name)) ?? null;
}

const EXECUTE_ERROR_RE = /"isError":true|ReferenceError|TypeError|invalid_grant|error_description|execute error|404\s+not\s+found|\bnot found\b|no commit found|does not exist|403\s+forbidden|unauthorized/i;

/**
 * Pure classifier for ONE execute result. Returns the anomaly to flag
 * ({ type, detail, meta }) or null. Keeping this pure makes the fix testable
 * without running the model-driven runner.
 */
export function classifyExecuteResult(result, fixtures = []) {
  const text = String(result?.text ?? '');
  if (!text || !EXECUTE_ERROR_RE.test(text)) return null;
  // Defensive: a catalog/search payload is not an execute error even if a
  // tool description inside it happens to mention "not found".
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed?.matches) && parsed.isError !== true) return null;
  } catch {}
  if (fixtures.length && isNotFound(text)) {
    return {
      type: 'execute_error',
      detail: text,
      meta: {
        attribution: 'synthetic_data', syntheticData: true, isGatewayDefect: false,
        subtype: 'placeholder_404', rootCause: 'not found (synthetic placeholder)',
        note: `fixture tokens: ${fixtures.join(', ')}`,
      },
    };
  }
  if (isInfraError(text) && text.includes('429')) {
    return { type: 'infra_error', detail: text, meta: { attribution: 'infra', note: 'upstream rate limit / server error' } };
  }
  return { type: 'execute_error', detail: text, meta: {} };
}

/* ------------------------------------------------------------------ *
 * #23 — per-server tool coverage (config problem, not a gateway defect)
 * ------------------------------------------------------------------ */
export function countToolsByServer(entries) {
  const out = {};
  for (const e of entries ?? []) {
    const server = e?.server;
    if (!server) continue;
    out[server] = (out[server] ?? 0) + 1;
  }
  return out;
}

/**
 * If this run exposed ZERO tools for the task's server, an otherwise-gateway
 * anomaly is an infra/config problem (upstream failed to connect or nothing
 * was whitelisted), not a gateway defect. Non-gateway attributions are left
 * untouched.
 */
export function applyServerCoverage(meta, server, serverToolCount, type) {
  const safeMeta = meta ?? {};
  const attribution = safeMeta.attribution ?? inferAttribution(type);
  if (serverToolCount !== 0 || attribution !== 'gateway') return safeMeta;
  const note = `server '${server}' exposed 0 tools in this run (config/upstream failure, not a gateway defect)`;
  return {
    ...safeMeta,
    attribution: 'infra',
    isGatewayDefect: false,
    note: safeMeta.note ? `${safeMeta.note}; ${note}` : note,
    rootCause: safeMeta.rootCause ?? 'upstream tools unavailable (infra)',
  };
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */
export function truncate(value, n = 300) {
  const s = value === undefined || value === null ? '' : String(value);
  return s.length > n ? s.slice(0, n) + `…[+${s.length - n} chars]` : s;
}

/** Normalize a tool name so `github__list_issues` matches expected `list_issues`. */
export function toolNameMatches(actual, expected) {
  if (!actual || !expected) return false;
  const a = String(actual).toLowerCase();
  const e = String(expected).toLowerCase();
  return a === e || a.endsWith('__' + e) || a.includes('__' + e) || a.includes(e);
}

/* ------------------------------------------------------------------ *
 * Deduplicating anomaly collector (R2)
 * ------------------------------------------------------------------ */
export class AnomalyCollector {
  constructor(detectorVersion = DETECTOR_VERSION) {
    this.items = [];
    this.byKey = new Map();
    this.dedupCount = 0;
    this.detectorVersion = detectorVersion;
  }

  /**
   * @param task      task object (id/server/category/prompt/tool/...)
   * @param type      anomaly type string
   * @param detail    human-readable detail (truncated to 300 chars when stored)
   * @param meta      { attribution, severity, turnIndex, traceId, ... }
   */
  flag(task, type, detail, meta = {}) {
    const raw = String(detail ?? '');
    const key = `${task.id}|${type}|${raw.slice(0, 80)}`;
    if (this.byKey.has(key)) {
      const existing = this.byKey.get(key);
      existing.occurrences += 1;
      this.dedupCount += 1;
      return existing;
    }
    const attribution = meta.attribution ?? inferAttribution(type);
    const item = {
      task: task.id,
      server: task.server,
      category: task.category,
      type,
      detail: truncate(raw, 300),
      prompt: task.prompt,
      occurrences: 1,
      attribution,
      severity: meta.severity ?? severityFor(attribution, type),
      rootCause: meta.rootCause ?? classifyRootCause(raw),
      detectorVersion: this.detectorVersion,
      traceId: meta.traceId ?? null,
      turnIndex: meta.turnIndex ?? null,
      ...extraMeta(meta),
    };
    this.items.push(item);
    this.byKey.set(key, item);
    return item;
  }

  toJSON() {
    return {
      anomalies: this.items,
      dedupCount: this.dedupCount,
      rawCount: this.items.reduce((s, a) => s + a.occurrences, 0),
    };
  }
}

function extraMeta(meta) {
  const out = {};
  for (const k of ['syntheticData', 'expectedBehavior', 'isGatewayDefect', 'subtype', 'note', 'source']) {
    if (meta[k] !== undefined) out[k] = meta[k];
  }
  return out;
}

export function inferAttribution(type) {
  if (type === 'placeholder_404') return 'synthetic_data';
  if (type === 'infra_error' || type === 'timeout') return 'infra';
  if (type === 'harness_contract_error' || type === 'runner_error') return 'harness';
  if (type === 'direct_answer' || type === 'no_tool_call' || type === 'retry' || type === 'model_confusion') return 'model';
  return 'gateway';
}

export function severityFor(attribution, type) {
  if (attribution === 'synthetic_data' || attribution === 'expected_behavior' || attribution === 'infra') return 'P2';
  if (type === 'harness_contract_error' || type === 'runner_error') return 'P0';
  if (attribution === 'model') return 'P2';
  return 'P1';
}

/* ------------------------------------------------------------------ *
 * Writers (structure only — no full token text)
 * ------------------------------------------------------------------ */
function ensureDirs() {
  fs.mkdirSync(TRACES_DIR, { recursive: true });
}

export function writeTrace(taskId, trace) {
  ensureDirs();
  const file = path.join(TRACES_DIR, `${String(taskId).replace(/[^\w.-]/g, '_')}.json`);
  fs.writeFileSync(file, JSON.stringify(trace, null, 2));
  return file;
}

export function writeManifest(manifest) {
  ensureDirs();
  fs.writeFileSync(path.join(RESULTS_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
}

export function writeMetrics(metrics) {
  ensureDirs();
  fs.writeFileSync(path.join(RESULTS_DIR, 'metrics.json'), JSON.stringify(metrics, null, 2));
}
