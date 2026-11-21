/**
 * Shared formatting/unwrapping helpers for Code Mode tools.
 * Central so the external `search` tool and the in-sandbox `codemode.search`
 * return identical shapes, and every tool call unwraps results consistently.
 */

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
 * ------------------------------------------------------------------ */

const TRUNC_MARKER = '--- TRUNCATED ---';
const MIN_SLOT = 128;

function jsonSize(value) {
  try { return JSON.stringify(value)?.length ?? 0; } catch { return 0; }
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
  const suffix =
    `\n\n${TRUNC_MARKER} ${text.length.toLocaleString()} chars omitted ` +
    `(limit ${maxChars.toLocaleString()}). Narrow the request to reduce response size.`;
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
  const suffix = ` ${TRUNC_MARKER} ${value.length.toLocaleString()} chars`;
  let keep = Math.max(0, maxChars - suffix.length - 2);
  let out = value.slice(0, keep) + suffix;
  while (keep > 0 && jsonSize(out) > maxChars) {
    keep = Math.max(0, keep - (jsonSize(out) - maxChars));
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
  const marker = (dropped) => `${TRUNC_MARKER} ${dropped.toLocaleString()} more items`;
  const floors = items.map((x) => floorSize(x, maxChars));
  const skeleton = (count) => 2 + Math.max(0, count - 1);
  let keep = items.length;
  if (floors.reduce((n, f) => n + f, 0) + skeleton(keep) > maxChars) {
    const tail = jsonSize(marker(items.length)) + 1;
    let used = skeleton(0) + tail;
    keep = 0;
    while (keep < items.length && used + floors[keep] + 1 <= maxChars) {
      used += floors[keep] + 1;
      keep += 1;
    }
  }
  const kept = items.slice(0, keep);
  const dropped = items.length - keep;
  const tail = dropped > 0 ? jsonSize(marker(dropped)) + (keep > 0 ? 1 : 0) : 0;
  const allocation = allocate(kept, maxChars - skeleton(keep) - tail);
  const out = kept.map((item, i) => shrink(item, allocation[i]));
  if (dropped > 0 && jsonSize([...out, marker(dropped)]) <= maxChars) out.push(marker(dropped));
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
  const dropped = new Set();
  let present = entries.length;
  let floorsSum = floors.reduce((n, f) => n + f, 0);
  let namesLength = 0;
  const noteLength = () => `${dropped.size.toLocaleString()} keys omitted: `.length + namesLength + 2 * (dropped.size - 1);
  const cost = () => {
    const marker = dropped.size > 0 ? keyCost(markerKey) + floorOf(noteLength() + 2) : 0;
    const count = present + (dropped.size > 0 ? 1 : 0);
    return 2 + Math.max(0, count - 1) + floorsSum + marker;
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
  const note = `${omitted.length.toLocaleString()} keys omitted: ${omitted.join(', ')}`;
  if (cost() > maxChars) {
    const room = maxChars - 2 - keyCost(markerKey);
    return room >= 2 ? { [markerKey]: shrink(note, room) } : {};
  }
  const all = [...kept];
  if (omitted.length > 0) all.push([markerKey, note]);
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
    const shrunk = shrink(JSON.parse(serialized), maxChars);
    out = jsonSize(shrunk) <= maxChars ? shrunk : truncateResponseText(serialized, { maxChars });
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
  const resources = [];
  const images = [];
  const audios = [];
  const resourceLinks = [];

  for (const c of contents) {
    if (!c || typeof c !== 'object') continue;
    switch (c.type) {
      case 'text':
        if (typeof c.text === 'string') texts.push(c.text);
        break;
      case 'resource': {
        const res = c.resource && typeof c.resource === 'object' ? c.resource : {};
        let body = '';
        if (typeof res.text === 'string') body = res.text;
        else if (typeof res.blob === 'string') {
          // Decode base64 as UTF-8. Do NOT use global atob() here — it returns
          // a latin1 string and mangles non-ASCII text (Chinese/accented chars).
          try { body = Buffer.from(res.blob, 'base64').toString('utf8'); }
          catch { body = res.blob; }
        }
        resources.push({ uri: res.uri, mimeType: res.mimeType, text: body });
        if (body) texts.push(body);
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
        if (typeof c.text === 'string') texts.push(c.text);
    }
  }

  const allText = texts.join('\n');
  if (r.isError === true) {
    throw new Error(allText || 'upstream tool returned an error');
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
      ...(resources.length > 0 ? { content: resources.map((x) => x.text).join('\n') } : {}),
    };
  }
  if (r.structuredContent !== undefined) return r.structuredContent;
  return allText || r;
}
