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

/**
 * Unwrap an upstream MCP tool result, preserving ALL content blocks.
 *
 * MCP results are a `content` array that may mix:
 *   - { type:'text', text }
 *   - { type:'resource', resource:{ uri, text?, blob?, mimeType? } }  (embedded)
 *   - { type:'image', data, mimeType }
 * Some servers (e.g. GitHub get_file_contents) put a status string in the first
 * text block and the ACTUAL FILE CONTENT in a resource block. Dropping the
 * resource block loses the data — this was a real P0 bug.
 *
 * Rules:
 *  - isError -> throw with all error text
 *  - extract text from text blocks AND resource blocks (resource.text/blob)
 *  - single text block holding JSON -> parse to object (convenience)
 *  - multiple blocks -> return { text, resources, ... } so nothing is lost
 */
export function unwrapResult(result) {
  const r = result && typeof result === 'object' ? result : {};
  const contents = Array.isArray(r.content) ? r.content : [];

  const texts = [];
  const resources = [];
  const images = [];
  for (const c of contents) {
    if (!c || typeof c !== 'object') continue;
    if (c.type === 'text' && typeof c.text === 'string') {
      texts.push(c.text);
    } else if (c.type === 'resource' && c.resource && typeof c.resource === 'object') {
      const res = c.resource;
      let body = '';
      if (typeof res.text === 'string') body = res.text;
      else if (typeof res.blob === 'string') {
        // base64 blob: decode if possible, keep raw otherwise
        try { body = typeof atob === 'function' ? atob(res.blob) : Buffer.from(res.blob, 'base64').toString('utf8'); }
        catch { body = res.blob; }
      }
      resources.push({ uri: res.uri, mimeType: res.mimeType, text: body });
      if (body) texts.push(body);
    } else if (c.type === 'image') {
      images.push({ data: c.data, mimeType: c.mimeType });
    } else if (typeof c.text === 'string') {
      texts.push(c.text);
    }
  }

  const allText = texts.join('\n');
  if (r.isError === true) {
    throw new Error(allText || 'upstream tool returned an error');
  }

  // Single text block (no resources/images) holding JSON -> parse for convenience.
  if (contents.length === 1 && texts.length === 1 && resources.length === 0 && images.length === 0) {
    try { return JSON.parse(texts[0]); } catch { return texts[0]; }
  }

  // Multiple blocks: return structured object so no content is silently dropped.
  if (resources.length > 0 || images.length > 0 || texts.length > 1) {
    return { text: allText, resources, images, ...(resources.length ? { content: resources.map((x) => x.text).join('\n') } : {}) };
  }
  return allText || r;
}
