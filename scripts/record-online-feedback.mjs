/**
 * Parse / validate / emit an `online-feedback.v1` record.
 *
 * Pure offline tool:
 *   - no network, no upstream calls, no model calls
 *   - no writes to R2, src/, or any repo file (stdout only)
 *   - deterministic: same input -> byte-identical JSON output
 *
 * Schema authority: docs/eval/ONLINE-FEEDBACK.md
 *
 * Usage:
 *   node scripts/record-online-feedback.mjs <input.json|input.md>
 *   node scripts/record-online-feedback.mjs --stdin < file.md
 *
 * Pure API (tests / other scripts):
 *   import { parseInput, validateRecord, toJson, recordFromMarkdown,
 *            recordFromJson, normalizeRequestIds, normalizePr } from ...
 */

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const SCHEMA = 'online-feedback.v1';
export const SEVERITIES = Object.freeze(['P0', 'P1', 'P2']);
export const STATUSES = Object.freeze(['unverified', 'confirmed', 'fixed', 'wontfix']);
export const PLATFORMS = Object.freeze(['gemini', 'chatgpt', 'claude', 'unknown']);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PR_PLAIN_RE = /^(?:#|PR\s*#?|pull\/)?\s*(\d+)\s*$/i;

/* ------------------------------------------------------------------ *
 * Normalizers
 * ------------------------------------------------------------------ */

/**
 * Normalize requestIds: a UUID is returned lowercase; the literal "unknown"
 * is preserved. Anything else is left for validateRecord to reject.
 */
export function normalizeRequestIds(input) {
  if (input === undefined || input === null) return ['unknown'];
  if (typeof input === 'string') {
    const parts = input.split(/[\s,;]+/).filter(Boolean);
    return parts.length ? parts : ['unknown'];
  }
  if (Array.isArray(input)) return input.length ? input.map(String) : ['unknown'];
  return [String(input)];
}

/**
 * Normalize PR references to positive integers. Accepts numbers, "#53",
 * "PR #53", "pull/53", "53". Returns null for invalid values so callers can
 * surface a validation error instead of silently dropping the evidence.
 */
export function normalizePr(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value === 'string') {
    const m = PR_PLAIN_RE.exec(value.trim());
    if (!m) return null;
    const n = Number(m[1]);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  }
  return null;
}

/** Normalize a `pr` array (or single PR value) into integers. */
export function normalizePrList(value) {
  if (value === undefined || value === null) return [];
  if (value === '') return [];
  const arr = Array.isArray(value) ? value : [value];
  const out = [];
  for (const item of arr) {
    if (typeof item === 'string') {
      // Try the whole string first: "PR #57" / "#56" / "pull/53" are single PRs.
      const whole = normalizePr(item);
      if (whole !== null) {
        if (!out.includes(whole)) out.push(whole);
        continue;
      }
      // Otherwise treat commas as separators ("#56, #57"); never split on
      // whitespace alone because "PR #57" is a valid single reference.
      const parts = item.split(/[,;]+/).map((s) => s.trim()).filter(Boolean);
      if (parts.length > 1) {
        for (const part of parts) {
          const n = normalizePr(part);
          if (n === null) return null;
          if (!out.includes(n)) out.push(n);
        }
        continue;
      }
      return null;
    }
    const n = normalizePr(item);
    if (n === null) return null;
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

function nonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

/* ------------------------------------------------------------------ *
 * Markdown parsing
 * ------------------------------------------------------------------ */

function parseKeyValueLine(line) {
  const m = /^\s*([A-Za-z][A-Za-z0-9 _/-]*)\s*:\s*(.*?)\s*$/.exec(line);
  if (!m) return null;
  return [m[1].trim().toLowerCase(), m[2].trim()];
}

/**
 * Parse the `## F<n>` / `### F<n>` sections of a markdown record into feedback
 * items. Header metadata comes from top-level `Key: value` lines before the
 * first feedback section.
 */
export function recordFromMarkdown(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const meta = {};
  const items = [];
  let current = null;
  let subKey = null;

  const setMeta = (key, value) => {
    const k = key.toLowerCase();
    if (k === 'recorded-at' || k === 'recordedat') meta.recordedAt = value;
    else if (k === 'window') meta.window = value;
    else if (k === 'platform') meta.platform = value;
    else if (k === 'surface') meta.surface = value;
    else if (k === 'clientinfo') meta.clientInfo = value;
    else if (k === 'repo' || k === 'project') meta.repo = value;
    else if (k === 'session') meta.sessionId = value;
    else if (k === 'task') meta.taskId = value;
    else if (k === 'windowid') meta.windowId = value;
    else if (k === 'status') meta.status = value;
    else if (k === 'baseline' || k === 'baselinerefs') meta.baselineRefs = value;
  };

  const applyFeedbackKey = (item, key, value) => {
    const k = key.toLowerCase();
    if (k === 'severity') item.severity = value;
    else if (k === 'category') item.category = value;
    else if (k === 'symptom') item.symptom = value;
    else if (k === 'reproduction' || k === 'repro') item.reproduction = value;
    else if (k === 'requestids' || k === 'requestid') item.requestIds = item.requestIds.concat(
      value.split(/[\s,;]+/).filter(Boolean),
    );
    else if (k === 'pr' || k === 'prs') item.prRaw = (item.prRaw || []).concat(value);
    else if (k === 'status') item.status = value;
    else if (k === 'evidence') {
      if (value) item.evidenceDetailParts = [value];
      else item.evidenceDetailParts = [];
      item.evidencePrRaw = [];
      item.captureVerified = false;
    }
  };

  const flush = () => {
    if (!current) return;
    const evidenceDetail = (current.evidenceDetailParts || []).filter(Boolean).join('\n').trim();
    const item = {
      id: current.id,
      severity: current.severity || '',
      category: current.category || '',
      symptom: current.symptom || '',
      evidence: {
        source: current.evidenceSource || 'user-report',
        detail: evidenceDetail,
        captureVerified: current.captureVerified === true,
      },
      reproduction: current.reproduction || '',
      requestIds: normalizeRequestIds(current.requestIds.length ? current.requestIds : ['unknown']),
      status: current.status || 'unverified',
    };
    const prValues = [...(current.evidencePrRaw || []), ...(current.prRaw || [])];
    if (prValues.length) item.evidence.pr = normalizePrList(prValues) ?? prValues;
    items.push(item);
    current = null;
    subKey = null;
  };

  for (const line of lines) {
    const header = /^\s*#{2,3}\s+F(\d+)\s*(?:[:\-–—].*)?\s*$/.exec(line);
    if (header) {
      flush();
      current = {
        id: `F${header[1]}`,
        requestIds: [],
        evidenceDetailParts: [],
        evidencePrRaw: [],
        prRaw: [],
        captureVerified: false,
        evidenceSource: 'user-report',
      };
      subKey = null;
      continue;
    }
    if (!current) {
      const kv = parseKeyValueLine(line);
      if (kv) setMeta(kv[0], kv[1]);
      continue;
    }
    const kv = parseKeyValueLine(line);
    if (!kv) {
      // Continuation of a multi-line Evidence/Reproduction value.
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#') && subKey) {
        if (subKey === 'evidence-detail' || subKey === 'detail') {
          current.evidenceDetailParts.push(trimmed);
        } else if (subKey === 'reproduction' && trimmed) {
          current.reproduction = `${current.reproduction}\n${trimmed}`.trim();
        }
      }
      continue;
    }
    const [key, value] = kv;
    if (key === 'detail') {
      current.evidenceDetailParts.push(value);
      subKey = 'evidence-detail';
      continue;
    }
    if (key === 'source') { current.evidenceSource = value || 'user-report'; subKey = null; continue; }
    if (key === 'captureverified' || key === 'captured') {
      current.captureVerified = /^true$/i.test(value);
      subKey = null;
      continue;
    }
    if (key === 'evidencepr' || key === 'pr') {
      current.evidencePrRaw.push(value);
      subKey = null;
      continue;
    }
    applyFeedbackKey(current, key, value);
    subKey = key === 'evidence' ? 'evidence-detail' : (key === 'reproduction' ? 'reproduction' : null);
  }
  flush();

  // Top-level window: "from -> to" or two ISO timestamps separated by "..".
  let window = null;
  if (meta.window) {
    const parts = meta.window.split(/\s*(?:->|\.\.|to)\s*/i).map((s) => s.trim()).filter(Boolean);
    if (parts.length >= 2) window = { from: parts[0], to: parts[1] };
  }

  const platformRaw = (meta.platform || 'unknown').trim().toLowerCase();
  const platformParts = platformRaw.split(/[\s/]+/).filter(Boolean);

  const linked = items.map((item) => ({
    feedbackId: item.id,
    taskId: meta.taskId || 'unknown',
    requestId: item.requestIds[0] || 'unknown',
    status: item.status,
    ...(item.requestIds[0] === 'unknown'
      ? { reason: 'no-request-id' }
      : { reason: 'no-runner-task' }),
  }));

  return {
    schema: SCHEMA,
    time: {
      recordedAt: meta.recordedAt || '',
      window: window || { from: '', to: '' },
    },
    platform: {
      name: PLATFORMS.includes(platformParts[0]) ? platformParts[0] : platformRaw,
      ...(platformParts[1] ? { surface: platformParts[1] } : {}),
      ...(meta.clientInfo ? { clientInfo: meta.clientInfo } : {}),
    },
    project: {
      repo: meta.repo || '',
    },
    session: {
      sessionId: meta.sessionId || 'unknown',
      taskId: meta.taskId || 'unknown',
      ...(meta.windowId ? { windowId: meta.windowId } : {}),
    },
    feedback: items,
    offline: {
      comparison: {
        linked,
        notComparable: [],
        baselineRefs: meta.baselineRefs
          ? meta.baselineRefs.split(/[\s,;]+/).filter(Boolean)
          : [],
      },
    },
    status: meta.status || 'unverified',
  };
}

/* ------------------------------------------------------------------ *
 * JSON input (same schema, with a few tolerant normalizations)
 * ------------------------------------------------------------------ */

export function recordFromJson(value) {
  const rec = JSON.parse(typeof value === 'string' ? value : JSON.stringify(value));
  // Normalize only representations, never invent missing evidence.
  if (rec.feedback && Array.isArray(rec.feedback)) {
    rec.feedback = rec.feedback.map((item) => {
      const out = { ...item };
      out.requestIds = normalizeRequestIds(item.requestIds);
      if (item.evidence && item.evidence.pr !== undefined) {
        out.evidence = { ...item.evidence, pr: normalizePrList(item.evidence.pr) ?? item.evidence.pr };
      }
      return out;
    });
  }
  return rec;
}

export function parseInput(text, filename = '') {
  const trimmed = String(text).trim();
  if (!trimmed) throw new Error('empty input');
  if (filename.toLowerCase().endsWith('.json') || trimmed.startsWith('{')) {
    return recordFromJson(trimmed);
  }
  return recordFromMarkdown(trimmed);
}

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

/**
 * Validate a record. Returns an array of error strings; empty means valid.
 * Errors are deterministic and sorted by discovery order.
 */
export function validateRecord(record) {
  const errors = [];
  const err = (msg) => errors.push(msg);
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return ['record: must be an object'];
  }
  if (record.schema !== SCHEMA) err(`schema: must be exactly "${SCHEMA}"`);

  const time = record.time;
  if (!time || typeof time !== 'object') {
    err('time: required object');
  } else {
    if (!nonEmptyString(time.recordedAt)) err('time.recordedAt: required non-empty string');
    else if (Number.isNaN(Date.parse(time.recordedAt))) err('time.recordedAt: invalid ISO-8601');
    const w = time.window;
    if (!w || typeof w !== 'object') err('time.window: required object with from/to');
    else {
      for (const k of ['from', 'to']) {
        if (!nonEmptyString(w[k])) err(`time.window.${k}: required non-empty string`);
        else if (Number.isNaN(Date.parse(w[k]))) err(`time.window.${k}: invalid ISO-8601`);
      }
    }
  }

  const platform = record.platform;
  if (!platform || typeof platform !== 'object') err('platform: required object');
  else if (!PLATFORMS.includes(platform.name)) {
    err(`platform.name: must be one of ${PLATFORMS.join(', ')}`);
  }

  const project = record.project;
  if (!project || typeof project !== 'object') err('project: required object');
  else if (!nonEmptyString(project.repo)) err('project.repo: required non-empty string');

  const session = record.session;
  if (!session || typeof session !== 'object') {
    err('session: required object');
  } else {
    if (!nonEmptyString(session.sessionId)) err('session.sessionId: required');
    if (!nonEmptyString(session.taskId)) err('session.taskId: required');
  }

  if (!Array.isArray(record.feedback) || record.feedback.length === 0) {
    err('feedback: must be a non-empty array');
  } else {
    const ids = new Set();
    record.feedback.forEach((item, i) => {
      const at = `feedback[${i}]`;
      if (!item || typeof item !== 'object') { err(`${at}: must be an object`); return; }
      if (!nonEmptyString(item.id)) err(`${at}.id: required non-empty string`);
      else if (ids.has(item.id)) err(`${at}.id: duplicate id "${item.id}"`);
      else ids.add(item.id);
      if (!SEVERITIES.includes(item.severity)) {
        err(`${at}.severity: must be one of ${SEVERITIES.join(', ')}`);
      }
      if (!nonEmptyString(item.category)) err(`${at}.category: required non-empty string`);
      if (!nonEmptyString(item.symptom)) err(`${at}.symptom: required non-empty string`);
      if (!nonEmptyString(item.reproduction)) err(`${at}.reproduction: required non-empty string`);

      const ev = item.evidence;
      if (!ev || typeof ev !== 'object' || Array.isArray(ev)) {
        err(`${at}.evidence: required object`);
      } else {
        if (!nonEmptyString(ev.source)) err(`${at}.evidence.source: required non-empty string`);
        if (!nonEmptyString(ev.detail)) err(`${at}.evidence.detail: required non-empty string`);
        if (typeof ev.captureVerified !== 'boolean') {
          err(`${at}.evidence.captureVerified: required boolean`);
        }
        if (ev.pr !== undefined) {
          if (!Array.isArray(ev.pr)) err(`${at}.evidence.pr: must be an array`);
          else {
            ev.pr.forEach((p, j) => {
              if (!Number.isSafeInteger(p) || p <= 0) {
                err(`${at}.evidence.pr[${j}]: must be a positive integer PR number`);
              }
            });
          }
        }
      }

      if (!Array.isArray(item.requestIds) || item.requestIds.length === 0) {
        err(`${at}.requestIds: non-empty array required (use ["unknown"] if unknown)`);
      } else {
        item.requestIds.forEach((r, j) => {
          if (typeof r !== 'string' || (r !== 'unknown' && !UUID_RE.test(r))) {
            err(`${at}.requestIds[${j}]: must be a UUID or "unknown"`);
          }
        });
      }
      if (!STATUSES.includes(item.status)) {
        err(`${at}.status: must be one of ${STATUSES.join(', ')}`);
      }
    });
  }

  const offline = record.offline;
  if (!offline || typeof offline !== 'object' || !offline.comparison || typeof offline.comparison !== 'object') {
    err('offline.comparison: required object');
  } else {
    if (!Array.isArray(offline.comparison.linked)) err('offline.comparison.linked: must be an array');
    else {
      offline.comparison.linked.forEach((row, i) => {
        const at = `offline.comparison.linked[${i}]`;
        if (!row || typeof row !== 'object') { err(`${at}: must be an object`); return; }
        if (!nonEmptyString(row.feedbackId)) err(`${at}.feedbackId: required`);
        if (!STATUSES.includes(row.status)) err(`${at}.status: invalid`);
      });
    }
  }
  if (!STATUSES.includes(record.status)) {
    err(`status: must be one of ${STATUSES.join(', ')}`);
  }
  return errors;
}

/** Deterministic JSON serialization with fixed key order. */
export function toJson(record) {
  const ordered = {
    schema: SCHEMA,
    time: {
      recordedAt: record.time.recordedAt,
      window: { from: record.time.window.from, to: record.time.window.to },
    },
    platform: {
      name: record.platform.name,
      ...(record.platform.surface !== undefined ? { surface: record.platform.surface } : {}),
      ...(record.platform.clientInfo !== undefined ? { clientInfo: record.platform.clientInfo } : {}),
    },
    project: {
      repo: record.project.repo,
      ...(record.project.keys !== undefined ? { keys: record.project.keys } : {}),
    },
    session: {
      sessionId: record.session.sessionId,
      taskId: record.session.taskId,
      ...(record.session.windowId !== undefined ? { windowId: record.session.windowId } : {}),
    },
    feedback: record.feedback.map((f) => ({
      id: f.id,
      severity: f.severity,
      category: f.category,
      symptom: f.symptom,
      evidence: {
        source: f.evidence.source,
        detail: f.evidence.detail,
        captureVerified: f.evidence.captureVerified,
        ...(f.evidence.pr !== undefined ? { pr: f.evidence.pr } : {}),
      },
      reproduction: f.reproduction,
      requestIds: f.requestIds,
      status: f.status,
    })),
    offline: {
      comparison: {
        linked: (record.offline.comparison.linked || []).map((row) => ({
          feedbackId: row.feedbackId,
          taskId: row.taskId,
          requestId: row.requestId,
          status: row.status,
          ...(row.reason !== undefined ? { reason: row.reason } : {}),
        })),
        notComparable: record.offline.comparison.notComparable || [],
        baselineRefs: record.offline.comparison.baselineRefs || [],
      },
    },
    status: record.status,
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

export async function main(argv = process.argv.slice(2)) {
  let text;
  let filename = '';
  if (argv.includes('--stdin')) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    text = Buffer.concat(chunks).toString('utf8');
  } else {
    const file = argv.find((a) => !a.startsWith('-'));
    if (!file) {
      process.stderr.write('usage: node scripts/record-online-feedback.mjs <input.json|input.md> | --stdin\n');
      return 2;
    }
    filename = file;
    text = await readFile(file, 'utf8');
  }
  let record;
  try {
    record = parseInput(text, filename);
  } catch (e) {
    process.stderr.write(`parse error: ${e.message}\n`);
    return 2;
  }
  const errors = validateRecord(record);
  if (errors.length) {
    process.stderr.write(`validation failed (${errors.length}):\n${errors.map((e) => `  - ${e}`).join('\n')}\n`);
    return 1;
  }
  process.stdout.write(toJson(record));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
