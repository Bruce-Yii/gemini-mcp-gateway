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
export const DETECTOR_VERSION = '2.0';

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
 * ------------------------------------------------------------------ */
export function classifyRootCause(detail) {
  const s = String(detail ?? '');
  if (/Invalid option|does not equal any of|expected one of|valid option/i.test(s)) return 'enum/valid-option mismatch';
  if (/missing required|required parameter|Invalid arguments for tool/i.test(s)) return 'param validation';
  if (/schema|arg.?name mismatch|unexpected.*argument/i.test(s)) return 'schema/arg-name mismatch';
  if (/403|401|unauthorized|permission|not accessible|forbidden/i.test(s)) return 'permission';
  if (/ReferenceError|TypeError|is not a function|not defined|undefined/i.test(s)) return 'JS/runtime error';
  if (/truncated|too large|exceeds|maxResultChars|content-block/i.test(s)) return 'result too large';
  if (/404|not found|no commit found|does not exist/i.test(s)) return 'not found';
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
