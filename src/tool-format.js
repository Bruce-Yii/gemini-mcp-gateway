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
    if (Array.isArray(d.enum) && d.enum.length <= 8) sig += ` (${d.enum.join('|')})`;
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
 * Unwrap an upstream MCP tool result:
 *  - if isError -> throw so the model sees a real failure in `execute`
 *  - if a single text content block holds JSON -> parse to object
 *  - otherwise return the plain text
 */
export function unwrapResult(result) {
  const r = result && typeof result === 'object' ? result : {};
  const contents = Array.isArray(r.content) ? r.content : [];
  const text = contents
    .filter((c) => c && (c.type === 'text' || typeof c.text === 'string'))
    .map((c) => (typeof c.text === 'string' ? c.text : ''))
    .join('\n');
  if (r.isError === true) {
    throw new Error(text || 'upstream tool returned an error');
  }
  if (contents.length === 1 && typeof contents[0]?.text === 'string') {
    try { return JSON.parse(contents[0].text); } catch { return contents[0].text; }
  }
  return text || r;
}
