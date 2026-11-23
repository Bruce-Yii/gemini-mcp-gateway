/**
 * Shared formatting/unwrapping helpers for Code Mode tools.
 * Central so the external `search` tool and the in-sandbox `codemode.search`
 * return identical shapes, and every tool call unwraps results consistently.
 */

/* ------------------------------------------------------------------ *
 * F-01 · model-visible error redaction (NOT capture redaction)
 *
 * Security audit F-01: upstream error text (Bearer headers, GitHub PATs,
 * Slack tokens, API keys, token/secret query parameters) used to reach the
 * model verbatim via `unwrapResult`'s isError throw and the sandbox bridge.
 *
 * Boundary: this is the MODEL-VISIBLE projection only. `captureEvent` and all
 * capture sinks stay full-fidelity by explicit product decision — the raw
 * `Error.message` (including any secret) remains untouched for the audit
 * trail; only the text handed to the model / JSON-RPC response is redacted.
 * Error `code`, envelope shape and prefix strings are preserved byte-for-byte.
 * ------------------------------------------------------------------ */

// Ordered: longest/most-specific first so a token is consumed once. Each entry
// has a capture group for the part that must be kept (label/separator); token
// families have no such group and are replaced wholesale.
const SECRET_PATTERNS = [
  // Authorization headers and explicit secret assignments (query/body/form).
  // Keep the label + separator so the error stays actionable ("api_key=[REDACTED]").
  /\b(authorization\s*:\s*(?:bearer|basic|token|sentry-bearer)\s+)[A-Za-z0-9._~+/=-]+/gi,
  /\b(bearer\s+)[A-Za-z0-9._~+/=-]+/gi,
  /\b((?:access[_-]?token|refresh[_-]?token|client[_-]?secret|api[_-]?key|apikey|token|secret|password|passwd|pwd)\s*[:=]\s*["']?)[^\s&"',;}\[\]]+/gi,
  /\b([?&](?:access[_-]?token|refresh[_-]?token|client[_-]?secret|api[_-]?key|apikey|token|secret|code)=)[^&\s#"']+/gi,
  // Well-known token prefixes (no capture group -> whole match is replaced).
  /\bgh[pousr]_[A-Za-z0-9]+/g,
  /\bgithub_pat_[A-Za-z0-9_]+/g,
  /\bxox[baprs]-[A-Za-z0-9-]+/g,
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\bAKIA[A-Z0-9]{16}\b/g,
  /\bAIza[A-Za-z0-9_-]{20,}\b/g,
];

/** Redact credential-shaped substrings in MODEL-VISIBLE text only. */
export function redactSecrets(text) {
  if (typeof text !== 'string' || text === '') return text;
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, (match, prefix) => (
      // The 2nd callback arg is `offset` (a number) for patterns WITHOUT a
      // capture group; only a string is a real prefix to preserve.
      typeof prefix === 'string' ? `${prefix}[REDACTED]` : '[REDACTED]'
    ));
  }
  return out;
}

/** Model-visible message of an Error: prefer an explicitly attached redacted
 * projection (upstreamError), otherwise redact the public message. The raw
 * `error.message` is never mutated so capture retains full fidelity. */
export function modelErrorMessage(err) {
  if (err && typeof err === 'object') {
    const safe = err.modelMessage;
    if (typeof safe === 'string') return redactSecrets(safe);
  }
  const raw = err instanceof Error ? err.message : (err && typeof err.message === 'string' ? err.message : String(err));
  return redactSecrets(raw);
}

/** Build a compact param signature from an inputSchema. */
export function formatParams(inputSchema, { full = false } = {}) {
  const schema = inputSchema && typeof inputSchema === 'object' ? inputSchema : {};
  const props = schema.properties ?? {};
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  if (full) return schema; // select:<name> returns the whole schema

  return Object.entries(props).map(([name, def]) => {
    const d = def && typeof def === 'object' ? def : {};
    let type = d.type ?? 'any';
    if (Array.isArray(type)) type = type.filter((t) => t !== 'null')[0] ?? type[0];
    if (type === 'array' && d.items?.type) type = `${d.items.type}[]`;
    const marker = required.has(name) ? '!' : '?';
    let sig = `${name}${marker}: ${type}`;
    if (Array.isArray(d.enum) && d.enum.length > 0) {
      if (d.enum.length <= 8) sig += ` (${d.enum.join('|')})`;
      else sig += ` (${d.enum.length} options; use select:<tool> for full list)`;
    }
    return sig;
  });
}

/** Format a tool entry for search results (compact). */
export function formatToolSummary(entry) {
  return {
    name: entry.name,
    description: entry.description,
    params: formatParams(entry.inputSchema),
  };
}

/** Format a tool entry for select:<name> (full schema). */
export function formatToolDetail(entry) {
  return {
    name: entry.name,
    description: entry.description,
    inputSchema: formatParams(entry.inputSchema, { full: true }),
  };
}

/* ------------------------------------------------------------------ *
 * Structured result truncation
 *
 * Ported from @cloudflare/codemode (MIT, v0.5.6, dist/truncate-Dd-VZZYQ.js).
 * The published package root cannot be imported from Node because it pulls
 * in `cloudflare:workers`, so the algorithm lives here instead.
 *
 * Unlike a naive `slice()`, these helpers keep the output *valid JSON of the
 * same shape*: strings end with a `--- TRUNCATED ---` marker, arrays get a
 * trailing marker counting dropped items, and objects drop the largest values
 * and name the omitted keys. The budget is shared by water-filling.
 *
 * Every marker also carries a lightweight *structure summary* so the model
 * knows what was lost without re-fetching blindly: objects list their original
 * top-level keys, arrays report their original length, and strings report the
 * total length plus a grepSnippet/text.slice locating hint. The `--- TRUNCATED
 * ---` token is preserved verbatim so existing assertions keep working.
 * ------------------------------------------------------------------ */

const TRUNC_MARKER = '--- TRUNCATED ---';
const MIN_SLOT = 128;

/* ------------------------------------------------------------------ *
 * F-08 · unified truncation truthiness
 *
 * A value counts as an explicit truncation flag ONLY when it is a true-like
 * boolean/number/string or a `truncation` reason object. Arbitrary non-empty
 * strings (e.g. an upstream `truncated:"benign"`) are NOT a flag on their own —
 * they are a REASON and must be paired with a boolean `truncated:true` before
 * they can influence canonical/model-visible state. This mirrors the capture
 * audit's `hasExplicitTruncationMark` truth table and keeps result-normalize
 * and tool-format on one semantics (boolean flag + separate reason).
 * ------------------------------------------------------------------ */
export function isExplicitTruncationFlag(value) {
  if (value === true) return true;
  if (value === 1 || value === '1' || value === 'true') return true;
  if (isObjTruncation(value)) return true;
  return false;
}

function isObjTruncation(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reason text carried by an upstream `truncation` field, or null. */
function truncationReason(value) {
  if (typeof value === 'string') return value.trim() !== '' ? value.trim().slice(0, 160) : null;
  if (isObjTruncation(value)) {
    for (const key of ['reason', 'detail', 'message']) {
      const v = value[key];
      if (typeof v === 'string' && v.trim() !== '') return v.trim().slice(0, 160);
    }
    return 'upstream:truncation-object';
  }
  return null;
}

function jsonSize(value) {
  try { return JSON.stringify(value)?.length ?? 0; } catch { return 0; }
}

/* ------------------------------------------------------------------ *
 * PR80-101 feedback #3 · structured truncation metadata
 *
 * A truncation marker alone tells the model "something was lost" but not
 * WHICH fields or how big they were, so it cannot decide what to re-request.
 * Every truncated object/string now carries `truncation.fields` (one entry per
 * original top-level key: UTF-8 bytes + line count when meaningful), plus a
 * `tail` excerpt and a `next` locating hint. The legacy `--- TRUNCATED ---`
 * token and F-08 `truncated:true` flag are untouched.
 * ------------------------------------------------------------------ */

const MAX_TRUNCATION_FIELDS = 32;
const TRUNCATION_TAIL_CHARS = 120;

/** UTF-8 byte size of a value (JSON representation). */
function utf8Bytes(value) {
  const s = JSON.stringify(value);
  return typeof s === 'string' ? Buffer.byteLength(s, 'utf8') : 0;
}

/** Per-original-top-level-key sizes, so a model can target a narrow re-read. */
export function truncationFields(value) {
  const fields = {};
  if (typeof value === 'string') return fields;
  if (Array.isArray(value)) {
    value.slice(0, MAX_TRUNCATION_FIELDS).forEach((item, i) => {
      fields[String(i)] = { bytes: utf8Bytes(item) };
    });
    if (value.length > MAX_TRUNCATION_FIELDS) {
      fields.__moreKeys = value.length - MAX_TRUNCATION_FIELDS;
    }
    return fields;
  }
  if (value && typeof value === 'object') {
    Object.entries(value).slice(0, MAX_TRUNCATION_FIELDS).forEach(([key, item]) => {
      const entry = { bytes: utf8Bytes(item) };
      if (typeof item === 'string' && item.includes('\n')) entry.lines = item.split('\n').length;
      fields[key] = entry;
    });
    const total = Object.keys(value).length;
    if (total > MAX_TRUNCATION_FIELDS) fields.__moreKeys = total - MAX_TRUNCATION_FIELDS;
  }
  return fields;
}

/** Short tail excerpt of the ORIGINAL value (never fabricated). */
function truncationTail(value) {
  if (typeof value === 'string') return value.slice(-TRUNCATION_TAIL_CHARS);
  let serialized;
  try { serialized = JSON.stringify(value); } catch { return ''; }
  return typeof serialized === 'string' ? serialized.slice(-TRUNCATION_TAIL_CHARS) : '';
}

/** Build the full metadata block. `reason` preserves F-08 upstream reasons. */
export function buildTruncationMeta(value, { reason } = {}) {
  const next = typeof value === 'string'
    ? 'use grepSnippet(text, keyword) or text.slice to locate a segment, then narrow the request'
    : 're-request only the large fields named above (or use a cursor/limit)';
  return {
    ...(reason !== undefined ? { reason } : {}),
    fields: truncationFields(value),
    tail: truncationTail(value),
    next,
  };
}

function shrinkable(value) {
  return typeof value === 'string' || (typeof value === 'object' && value !== null);
}

function floorSize(value, maxChars) {
  const full = jsonSize(value);
  return shrinkable(value) ? Math.min(full, MIN_SLOT, Math.max(2, Math.floor(maxChars / 2))) : full;
}

/** Truncate a plain text response, appending a marker with the original size. */
export function truncateResponseText(text, { maxChars = 24000 } = {}) {
  if (typeof text !== 'string' || text.length <= maxChars) return text;
  // Keep `--- TRUNCATED --- <n> chars` verbatim for existing assertions; the
  // extra sentences are append-only guidance (total length + locating hint).
  // PR80-101: also emit a machine-readable truncation block (fields/tail/next)
  // so the model does not have to guess which part of a large text was lost.
  let meta = buildTruncationMeta(text);
  const head =
    `\n\n${TRUNC_MARKER} ${text.length.toLocaleString()} chars total ` +
    `(limit ${maxChars.toLocaleString()}). Use grepSnippet/text.slice to locate ` +
    `a segment, then narrow the request.`;
  const suffixOf = (m) => `${head} truncation.fields=${JSON.stringify(m.fields)} tail=${JSON.stringify(m.tail)} next=${JSON.stringify(m.next)}`;
  let suffix = suffixOf(meta);
  // Keep the structured block (and the verbatim marker) even under a tight
  // budget by shortening the OPTIONAL tail/next excerpts, never the marker.
  while (suffix.length > maxChars && meta.tail.length > 0) {
    meta = { ...meta, tail: meta.tail.slice(0, -1) };
    suffix = suffixOf(meta);
  }
  while (suffix.length > maxChars && meta.next.length > 0) {
    meta = { ...meta, next: meta.next.slice(0, -1) };
    suffix = suffixOf(meta);
  }
  let keep = Math.max(0, maxChars - suffix.length);
  let out = text.slice(0, keep) + suffix;
  while (keep > 0 && out.length > maxChars) {
    keep = Math.max(0, keep - (out.length - maxChars));
    out = text.slice(0, keep) + suffix;
  }
  if (out.length <= maxChars) return out;
  return text.slice(0, Math.max(0, maxChars - TRUNC_MARKER.length)) + TRUNC_MARKER;
}

function shrinkString(value, maxChars) {
  // `<n> chars` is the full original length (a locating hint, not a count of
  // removed bytes) — keep that prefix stable and extend it with guidance.
  // PR80-101: structured fields/tail/next travel with nested strings too, but
  // when the per-value budget is tiny the COMPACT legacy suffix wins: keeping
  // early content is more useful than a marker-only string.
  const meta = buildTruncationMeta(value);
  const head = ` ${TRUNC_MARKER} ${value.length.toLocaleString()} chars total (use grepSnippet/text.slice to locate)`;
  const full = `${head} truncation.fields=${JSON.stringify(meta.fields)} tail=${JSON.stringify(meta.tail)} next=${JSON.stringify(meta.next)}`;
  const compact = `${head} truncation.fields=${JSON.stringify(meta.fields)} tail=${JSON.stringify(meta.tail.slice(0, 24))} next="narrow the request"`;
  const minimal = head;
  let suffix = [full, compact, minimal].find((candidate) => candidate.length + 2 <= maxChars) ?? minimal;
  let keep = Math.max(0, maxChars - suffix.length - 2);
  let out = value.slice(0, keep) + suffix;
  while (keep > 0 && jsonSize(out) > maxChars) {
    keep = Math.max(0, keep - (jsonSize(out) - maxChars));
    out = value.slice(0, keep) + suffix;
  }
  // Last resort for an extremely small budget: never lose the marker.
  if (jsonSize(out) > maxChars && minimal.length + 2 <= maxChars) {
    suffix = minimal;
    keep = Math.max(0, maxChars - suffix.length - 2);
    out = value.slice(0, keep) + suffix;
  }
  return jsonSize(out) <= maxChars ? out : TRUNC_MARKER.slice(0, Math.max(0, maxChars - 2));
}

/** Share `available` chars across values by water-filling (smallest first). */
function allocate(values, available) {
  if (available <= 0) return values.map(() => 0);
  const sizes = values.map(jsonSize);
  const order = sizes.map((_, i) => i).sort((a, b) => sizes[a] - sizes[b]);
  const allocation = new Array(values.length);
  let remaining = available;
  let count = values.length;
  for (const i of order) {
    const alloc = Math.min(sizes[i], Math.floor(remaining / count));
    allocation[i] = alloc;
    remaining -= alloc;
    count -= 1;
  }
  return allocation;
}

function shrink(value, maxChars) {
  if (jsonSize(value) <= maxChars) return value;
  if (typeof value === 'string') return shrinkString(value, maxChars);
  if (Array.isArray(value)) return shrinkArray(value, maxChars);
  if (typeof value === 'object' && value !== null) return shrinkObject(value, maxChars);
  return value;
}

function shrinkArray(items, maxChars) {
  const total = items.length;
  // The marker is always present on a truncated array (even when no element
  // was dropped but a nested value was shrunk), so the model learns the
  // original length. `--- TRUNCATED --- <n> more items` is kept verbatim.
  const marker = (dropped) => dropped > 0
    ? `${TRUNC_MARKER} ${dropped.toLocaleString()} more items (array length: ${total.toLocaleString()})`
    : `${TRUNC_MARKER} array length: ${total.toLocaleString()}`;
  const floors = items.map((x) => floorSize(x, maxChars));
  const skeleton = (count) => 2 + Math.max(0, count - 1);
  const tailCost = (dropped) => jsonSize(marker(dropped)) + 1; // +1 = separator comma
  let keep = items.length;
  if (floors.reduce((n, f) => n + f, 0) + skeleton(keep) + tailCost(items.length) > maxChars) {
    let used = skeleton(0) + tailCost(items.length);
    keep = 0;
    while (keep < items.length && used + floors[keep] + 1 <= maxChars) {
      used += floors[keep] + 1;
      keep += 1;
    }
  }
  const kept = items.slice(0, keep);
  const dropped = items.length - keep;
  const tail = tailCost(dropped);
  const allocation = allocate(kept, maxChars - skeleton(keep) - tail);
  const out = kept.map((item, i) => shrink(item, allocation[i]));
  if (jsonSize([...out, marker(dropped)]) <= maxChars) out.push(marker(dropped));
  return out;
}

function shrinkObject(value, maxChars) {
  const entries = Object.entries(value);
  let markerKey = TRUNC_MARKER;
  while (markerKey in value) markerKey += ' ';
  const keyCost = (key) => jsonSize(key) + 1;
  const floors = entries.map(([k, v]) => keyCost(k) + floorSize(v, maxChars));
  const floorOf = (chars) => Math.min(chars, MIN_SLOT, Math.max(2, Math.floor(maxChars / 2)));
  const byValueSize = entries.map((_, i) => i).sort((a, b) => jsonSize(entries[b][1]) - jsonSize(entries[a][1]));
  // Structure summary: the original top-level keys, so the model knows the
  // full shape even when some values were dropped or shortened.
  const summary = `top-level keys: [${entries.map(([k]) => k).join(', ')}]`;
  const summaryCost = `. ${summary}`.length;
  const dropped = new Set();
  let present = entries.length;
  let floorsSum = floors.reduce((n, f) => n + f, 0);
  let namesLength = 0;
  const noteLength = () =>
    `${dropped.size.toLocaleString()} keys omitted: `.length + namesLength +
    2 * Math.max(0, dropped.size - 1) + summaryCost;
  // F-08: a genuinely truncated object always emits a normalized boolean
  // `truncated:true` (plus a separate `truncation` reason) alongside the marker.
  // Reserve their keys in the budget so the output never overflows maxChars.
  const hasTruncKey = Object.prototype.hasOwnProperty.call(value, 'truncated')
    || Object.prototype.hasOwnProperty.call(value, 'isTruncated')
    || Object.prototype.hasOwnProperty.call(value, 'truncation');
  const extraKeyCost = keyCost('truncated') + jsonSize(true) + 1
    + (hasTruncKey ? keyCost('truncation') + floorOf(40) + 1 : 0);
  const cost = () => {
    // The marker key is always emitted on a truncated object, so always
    // reserve its cost (previously it was only reserved when keys were dropped).
    const marker = keyCost(markerKey) + floorOf(noteLength() + 2);
    const count = present + 1;
    return 2 + Math.max(0, count - 1) + floorsSum + marker + extraKeyCost;
  };
  for (const i of byValueSize) {
    if (cost() <= maxChars) break;
    dropped.add(i);
    present -= 1;
    floorsSum -= floors[i];
    namesLength += jsonSize(entries[i][0]) - 2;
  }
  const kept = entries.filter((_, i) => !dropped.has(i));
  const omitted = [...dropped].sort((a, b) => a - b).map((i) => entries[i][0]);
  const note = omitted.length > 0
    ? `${omitted.length.toLocaleString()} keys omitted: ${omitted.join(', ')}. ${summary}`
    : summary;
  const reason = truncationReason(value.truncated) ?? truncationReason(value.truncation)
    ?? truncationReason(value.isTruncated) ?? 'tool-format:object-shrunk';
  if (cost() > maxChars) {
    // F-08: even in the minimal-marker fallback, never emit a contradictory
    // `truncated:false` alongside the marker. The boolean flag is authoritative.
    const room = maxChars - 2 - keyCost(markerKey) - keyCost('truncated') - jsonSize(true)
      - (hasTruncKey ? keyCost('truncation') + jsonSize(reason) + 1 : 0);
    const minimal = { truncated: true, ...(hasTruncKey ? { truncation: reason } : {}) };
    return room >= 2 ? { ...minimal, [markerKey]: shrink(note, room) } : minimal;
  }
  // F-08: the marker is emitted ONLY on genuine structural truncation. Any
  // upstream `truncated` field in `kept` is replaced by a normalized boolean
  // `truncated:true` plus a separate `truncation` reason, so a model can never
  // observe `truncated:false` coexisting with `--- TRUNCATED ---`.
  const normalized = kept.filter(([k]) => k !== 'truncated' && k !== 'truncation' && k !== 'isTruncated');
  const all = [
    ...normalized,
    ['truncated', true],
    ...(hasTruncKey ? [['truncation', reason]] : []),
    [markerKey, note],
  ];
  const fixed = 2 + Math.max(0, all.length - 1) + all.reduce((n, [k]) => n + keyCost(k), 0);
  const allocation = allocate(all.map(([, v]) => v), maxChars - fixed);
  const out = {};
  all.forEach(([k, v], i) => { out[k] = shrink(v, allocation[i]); });
  return out;
}

/** An `images[]` entry from unwrapResult(): `{data, mimeType}`. */
function isImagePayload(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    typeof value.data === 'string';
}

/**
 * Attach structured truncation metadata to an already-shrunk object/array
 * without exceeding `maxChars`. The legacy marker is never removed; when the
 * budget is tight we shorten the marker's explanatory note and the optional
 * tail/next excerpts first, and keep every top-level field entry as long as
 * possible. If even that cannot fit, return the original shrunk value rather
 * than emitting an over-budget or half-written result.
 */
function attachTruncationMeta(base, original, maxChars) {
  if (!base || typeof base !== 'object' || Array.isArray(base)) return base;
  const upstreamReason = truncationReason(original?.truncated) ?? truncationReason(original?.truncation)
    ?? truncationReason(original?.isTruncated);
  let meta = buildTruncationMeta(original, { reason: upstreamReason ?? undefined });
  const prior = base.truncation && typeof base.truncation === 'object' && !Array.isArray(base.truncation)
    ? base.truncation : {};
  const merged = () => ({ ...meta, ...prior, fields: meta.fields, tail: meta.tail, next: meta.next });
  const markerKey = Object.keys(base).find((k) => k.startsWith(TRUNC_MARKER));
  const originalNote = markerKey ? base[markerKey] : undefined;
  // F-08 compatibility: when shrinkObject chose a STRING `truncation` reason,
  // keep that field exactly as-is and expose the structured block under
  // `truncationMeta` instead. Never turn a string reason into an object.
  const legacyStringReason = typeof base.truncation === 'string';
  const candidate = (note) => {
    const withMarker = note === undefined ? base : { ...base, [markerKey]: note };
    return legacyStringReason
      ? { ...withMarker, truncationMeta: merged() }
      : { ...withMarker, truncation: merged() };
  };

  let out = candidate(originalNote);
  if (jsonSize(out) <= maxChars) return out;

  // First keep the full marker note (existing assertions depend on its
  // "top-level keys: [...]" / "N keys omitted" summary) and trim only the
  // OPTIONAL tail/next excerpts.
  while (meta.next.length > 0 || meta.tail.length > 0) {
    meta = {
      ...meta,
      next: meta.next.length > 0 ? meta.next.slice(0, -1) : meta.next,
      tail: meta.next.length > 0 ? meta.tail : (meta.tail.length > 0 ? meta.tail.slice(0, -1) : meta.tail),
    };
    out = candidate(originalNote);
    if (jsonSize(out) <= maxChars) return out;
  }
  // Then drop the reason (if any) and keep fields-only metadata.
  if (meta.reason !== undefined) {
    const { reason: _reason, ...rest } = meta;
    void _reason;
    meta = rest;
    out = candidate(originalNote);
    if (jsonSize(out) <= maxChars) return out;
  }
  // Only now shorten the marker note; the marker key itself stays verbatim.
  for (const note of ['truncated', '']) {
    out = candidate(note);
    if (jsonSize(out) <= maxChars) return out;
  }
  return base;
}

/**
 * Bound a value to `maxChars` of serialized JSON, keeping its shape valid.
 * Strings are truncated as text; objects/arrays are shrunk structurally.
 *
 * Image payloads are the exception: their base64 must reach the gateway
 * untouched so it can emit a native MCP `image` content block. Truncating it
 * would corrupt the picture while still filling the text context, so we detach
 * any `images[]` array before shrinking and reattach it afterwards. The text
 * budget therefore applies only to the textual part of the result.
 */
export function truncateResultValue(value, { maxChars = 24000 } = {}) {
  if (typeof value === 'string') return truncateResponseText(value, { maxChars });

  let images;
  let rest = value;
  if (value && typeof value === 'object' && !Array.isArray(value) &&
      Array.isArray(value.images) && value.images.some(isImagePayload)) {
    images = value.images.filter(isImagePayload);
    const { images: _detached, ...withoutImages } = value;
    void _detached;
    rest = withoutImages;
  }

  let serialized;
  try { serialized = JSON.stringify(rest); } catch { return value; }
  if (serialized === undefined) return value;
  let out;
  if (serialized.length <= maxChars) {
    out = rest;
  } else {
    // Reserve room for the structured truncation block BEFORE shrinking, so
    // fields/tail/next are present without pushing the output over maxChars.
    // Reserve a modest, bounded slice of the budget for the structured block.
    // Reserving ALL of it would squeeze short values down to a bare marker;
    // attachTruncationMeta() trims the optional tail/next if the estimate is
    // slightly short.
    const metaReserve = Math.min(360, Math.max(96, Math.floor(maxChars / 3)));
    const base = (() => {
      const shrunk = shrink(JSON.parse(serialized), maxChars - metaReserve);
      return jsonSize(shrunk) <= maxChars ? shrunk : truncateResponseText(serialized, { maxChars });
    })();
    out = attachTruncationMeta(base, rest, maxChars);
  }
  if (images && out && typeof out === 'object' && !Array.isArray(out)) {
    return { ...out, images };
  }
  return out;
}

/* ------------------------------------------------------------------ */

function pickMeta(source, keys) {
  const out = {};
  for (const key of keys) if (source[key] !== undefined) out[key] = source[key];
  return out;
}

/* ------------------------------------------------------------------ *
 * Binary (image/audio) resource blobs
 *
 * MCP embedded resources may carry base64 in `resource.blob` with an
 * `image/*` or `audio/*` mimeType. Decoding that as UTF-8 produces mojibake
 * in `text[]` and is useless to the model; the gateway's native image
 * passthrough needs `{data, mimeType}` in `images[]` instead. Text-ish
 * resources keep the original UTF-8 decoding path unchanged.
 * ------------------------------------------------------------------ */

/** Hard cap on a decoded binary resource payload (1 MiB). */
export const MAX_RESOURCE_BINARY_BYTES = 1024 * 1024;

/** Strict-enough base64 shape check: invalid blobs keep the legacy text path. */
function isBase64Blob(blob) {
  return typeof blob === 'string' && blob.length % 4 === 0 &&
    /^[A-Za-z0-9+/]*={0,2}$/.test(blob);
}

/** Cheap upper-bound estimate of decoded bytes, avoiding a huge decode just to reject. */
function estimateDecodedBytes(base64) {
  const padding = /={1,2}$/.exec(base64)?.[0].length ?? 0;
  return Math.max(0, Math.floor(base64.length * 3 / 4) - padding);
}

/** Classify a resource.blob: 'image' | 'audio' | null (legacy text path). */
function binaryResourceKind(res) {
  if (typeof res.blob !== 'string' || typeof res.mimeType !== 'string') return null;
  const mime = res.mimeType.toLowerCase();
  if (!mime.startsWith('image/') && !mime.startsWith('audio/')) return null;
  // A malformed blob is not base64: leave it on the legacy UTF-8 path so the
  // original behavior (including its replacement chars) is preserved.
  if (!isBase64Blob(res.blob)) return null;
  return mime.startsWith('image/') ? 'image' : 'audio';
}

/**
 * Unwrap an upstream MCP tool result, preserving ALL content blocks.
 *
 * MCP results are a `content` array that may mix five block types:
 *   - { type:'text', text }
 *   - { type:'resource', resource:{ uri, text?, blob?, mimeType? } }  (embedded)
 *   - { type:'image', data, mimeType }
 *   - { type:'audio', data, mimeType }
 *   - { type:'resource_link', uri, name?, mimeType?, description? }
 * plus a result-level `structuredContent` object.
 * Some servers (e.g. GitHub get_file_contents) put a status string in the first
 * text block and the ACTUAL FILE CONTENT in a resource block. Dropping the
 * resource block loses the data — this was a real P0 bug.
 *
 * Rules (following Cloudflare Code Mode / MCP spec):
 *  - isError -> throw with all error text
 *  - structuredContent -> expose directly as an object (highest priority)
 *  - single text block holding JSON -> parse to object (convenience)
 *  - multiple / mixed blocks -> return a structured object; audio and
 *    resource_link keep their metadata instead of being silently dropped.
 */
export function unwrapResult(result) {
  const r = result && typeof result === 'object' ? result : {};
  const contents = Array.isArray(r.content) ? r.content : [];

  const texts = [];
  // Bodies that came from an explicit `text` block. GitHub's get_file_contents
  // echoes the SAME body in a text block and a resource block; tracking this
  // set lets us drop the redundant copy in `resources[].text` while keeping the
  // resource's uri/mimeType metadata.
  const textBlockBodies = new Set();
  const resources = [];
  const images = [];
  const audios = [];
  const resourceLinks = [];

  for (const c of contents) {
    if (!c || typeof c !== 'object') continue;
    switch (c.type) {
      case 'text':
        if (typeof c.text === 'string') {
          textBlockBodies.add(c.text);
          if (!texts.includes(c.text)) texts.push(c.text);
        }
        break;
      case 'resource': {
        const res = c.resource && typeof c.resource === 'object' ? c.resource : {};
        const kind = binaryResourceKind(res);

        if (kind !== null) {
          // Binary payload: never UTF-8-decode it into `texts` (that yields
          // mojibake and floods the model context with garbage/base64).
          const estimated = estimateDecodedBytes(res.blob);
          const meta = { uri: res.uri, mimeType: res.mimeType, size: estimated };
          if (estimated > MAX_RESOURCE_BINARY_BYTES) {
            // Over cap: keep metadata + a short marker; no native image block.
            resources.push({ ...meta, omitted: 'binary payload over cap' });
            break;
          }
          const size = Buffer.from(res.blob, 'base64').length;
          const dataLength = res.blob.length;
          if (kind === 'image') {
            // `blobRef` points at the entry we are about to add to `images[]`;
            // server.js's collectImages() turns it into a native MCP image
            // content block and leaves a compact {__imageRef, mimeType} behind.
            const blobRef = images.length;
            images.push({ data: res.blob, mimeType: res.mimeType, size });
            resources.push({ ...meta, size, dataLength, blobRef });
          } else {
            // Audio stays metadata-only: no native image block, no base64 in
            // text. The payload length tells the model audio was present.
            resources.push({ ...meta, size, dataLength });
          }
          break;
        }

        let body = '';
        if (typeof res.text === 'string') body = res.text;
        else if (typeof res.blob === 'string') {
          // Decode base64 as UTF-8. Do NOT use global atob() here — it returns
          // a latin1 string and mangles non-ASCII text (Chinese/accented chars).
          try { body = Buffer.from(res.blob, 'base64').toString('utf8'); }
          catch { body = res.blob; }
        }
        if (body && !texts.includes(body)) texts.push(body);
        resources.push({
          uri: res.uri,
          mimeType: res.mimeType,
          // Only omit the body when a text block already carried that exact
          // body (the GitHub duplication bug). A resource-only result keeps
          // its `text` so existing consumers still see the payload here.
          ...(body === '' || !textBlockBodies.has(body) ? { text: body } : {}),
        });
        break;
      }
      case 'image':
        // Keep the block but do not concatenate base64 into `text` (it would
        // dump binary into the model context on `return result`).
        images.push(pickMeta(c, ['data', 'mimeType']));
        break;
      case 'audio':
        // MCP 2025-06-18 content type. Preserve metadata; keep only the
        // payload *length* so the model knows audio was present without
        // pushing raw base64 into its context.
        audios.push({
          ...pickMeta(c, ['mimeType', 'name']),
          ...(typeof c.data === 'string' ? { dataLength: c.data.length } : {}),
        });
        break;
      case 'resource_link':
        // MCP 2025-06-18 content type: a link to a resource, no inline data.
        resourceLinks.push(pickMeta(c, ['uri', 'name', 'mimeType', 'description', 'size']));
        break;
      default:
        if (typeof c.text === 'string' && !texts.includes(c.text)) texts.push(c.text);
    }
  }

  const allText = texts.join('\n');
  if (r.isError === true) {
    // F-01: the thrown text is model-visible (sandbox try/catch and tool error
    // responses). Redact credential shapes here; the raw upstream envelope is
    // still captured verbatim by captureEvent before unwrapResult runs.
    throw new Error(redactSecrets(allText) || 'upstream tool returned an error');
  }

  // Cloudflare contract: structuredContent is exposed directly — but ONLY when
  // it is the sole payload. RC-A3 root cause: an unconditional early return
  // swallowed image/resource/audio blocks present in the SAME result.
  const hasOtherBlocks = resources.length > 0 || images.length > 0 ||
    audios.length > 0 || resourceLinks.length > 0;
  if (r.structuredContent !== undefined && !hasOtherBlocks) return r.structuredContent;

  // Single text block (no other blocks) holding JSON -> parse for convenience.
  if (contents.length === 1 && texts.length === 1 &&
      resources.length === 0 && images.length === 0 &&
      audios.length === 0 && resourceLinks.length === 0) {
    try { return JSON.parse(texts[0]); } catch { return texts[0]; }
  }

  // Multiple / mixed blocks: return structured object so nothing is dropped.
  if (resources.length > 0 || images.length > 0 || audios.length > 0 ||
      resourceLinks.length > 0 || texts.length > 1) {
    return {
      ...(r.structuredContent !== undefined ? { structuredContent: r.structuredContent } : {}),
      text: allText,
      resources,
      images,
      ...(audios.length > 0 ? { audios } : {}),
      ...(resourceLinks.length > 0 ? { resourceLinks } : {}),
      // NOTE: no `content` alias. All distinct bodies already live in `text`
      // (and, where needed, `resources[].text`), so a `content` echo would be
      // a third copy of the same payload and could trigger false truncation.
    };
  }
  if (r.structuredContent !== undefined) return r.structuredContent;
  return allText || r;
}
