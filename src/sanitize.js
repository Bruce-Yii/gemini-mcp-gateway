/**
 * Gemini function-declaration schema sanitizer.
 *
 * Gemini imposes hard constraints on the tool schemas exposed by an MCP
 * connector (e.g. every `array` must declare `items`, multi-type unions are
 * not supported, `oneOf`/`anyOf` are capped at 8 branches). This module
 * normalises an upstream schema into something Gemini accepts, WITHOUT ever
 * mutating the caller's objects.
 */

/** @type {{readOnlyHint: boolean, destructiveHint: boolean, openWorldHint: boolean}} */
const DEFAULT_ANNOTATIONS = Object.freeze({
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: true,
});

const MAX_BRANCHES = 8;
const MAX_NAME_LENGTH = 63;

/** Keys whose value is a single nested schema object. */
const SINGLE_SCHEMA_KEYS = [
  'items',
  'additionalProperties',
  'not',
  'if',
  'then',
  'else',
  'contains',
  'propertyNames',
];

/** Keys whose value is an array of nested schema objects. */
const ARRAY_SCHEMA_KEYS = ['anyOf', 'oneOf', 'allOf', 'prefixItems'];

/** Keys holding a map of name -> nested schema object. */
const SCHEMA_MAP_KEYS = ['properties', '$defs', 'definitions', 'patternProperties'];

/**
 * Deep-clone only the JSON-shaped values that make up a JSON Schema.
 * Plain objects and arrays are cloned recursively; primitives pass through.
 */
function deepClone(value) {
  if (Array.isArray(value)) return value.map(deepClone);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) out[key] = deepClone(value[key]);
    return out;
  }
  return value;
}

/**
 * Recursively normalise a (already cloned) schema node in place.
 */
function sanitizeNode(node) {
  if (node === null || typeof node !== 'object') return node;
  if (Array.isArray(node)) {
    for (const item of node) sanitizeNode(item);
    return node;
  }

  // Rule 2: collapse multi-type unions to the first non-"null" type.
  // Doing this first keeps long-ID string fields as "string" and never
  // introduces a "number" type (Rule 4).
  if (Array.isArray(node.type)) {
    const nonNull = node.type.find((t) => t !== 'null');
    node.type = nonNull !== undefined ? nonNull : (node.type[0] ?? 'string');
  }

  // Rule 1: every array must declare `items`.
  if (node.type === 'array' && (node.items === undefined || node.items === null)) {
    node.items = { type: 'string' };
  }

  // Rule 3: cap oneOf/anyOf branch count and annotate the node.
  for (const key of ['oneOf', 'anyOf']) {
    if (Array.isArray(node[key]) && node[key].length > MAX_BRANCHES) {
      const original = node[key].length;
      node[key] = node[key].slice(0, MAX_BRANCHES);
      const base = typeof node.description === 'string' ? node.description : '';
      const hint =
        ` [gateway-sanitize] ${key} branches truncated from ${original} to ${MAX_BRANCHES}` +
        ` (Gemini function declaration limit)`;
      node.description = base + hint;
    }
  }

  // Recurse into every nested schema location.
  for (const key of SINGLE_SCHEMA_KEYS) {
    const child = node[key];
    if (child === undefined) continue;
    if (Array.isArray(child)) {
      // e.g. tuple-form `items` / `prefixItems`
      for (const item of child) sanitizeNode(item);
    } else if (child !== null && typeof child === 'object') {
      sanitizeNode(child);
    }
  }
  for (const key of ARRAY_SCHEMA_KEYS) {
    if (Array.isArray(node[key])) {
      for (const branch of node[key]) sanitizeNode(branch);
    }
  }
  for (const key of SCHEMA_MAP_KEYS) {
    const map = node[key];
    if (map !== null && typeof map === 'object' && !Array.isArray(map)) {
      for (const child of Object.values(map)) sanitizeNode(child);
    }
  }

  return node;
}

/**
 * Normalise an input JSON Schema for Gemini. Returns a new object; the input
 * is never modified. Unrelated fields (description, title, format, …) survive.
 *
 * @param {object} schema
 * @returns {object}
 */
export function sanitizeInputSchema(schema) {
  return sanitizeNode(deepClone(schema));
}

/**
 * Sanitize a tool definition into the exact shape Gemini expects.
 *
 * @param {{name?: string, description?: string, inputSchema?: object, annotations?: object}} tool
 * @returns {{name: string, description: string|undefined, inputSchema: object, annotations: object}}
 */
export function sanitizeTool(tool) {
  const source = tool !== null && typeof tool === 'object' ? tool : {};

  // Rule 5: keep only [a-zA-Z0-9_-], replace everything else with "_", cap 63.
  const rawName = typeof source.name === 'string' ? source.name : '';
  const name = rawName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, MAX_NAME_LENGTH);

  // Rule 6: guarantee the three hints, with caller values overriding defaults.
  const annotations = { ...DEFAULT_ANNOTATIONS };
  if (source.annotations !== null && typeof source.annotations === 'object') {
    for (const [key, value] of Object.entries(source.annotations)) {
      if (value !== undefined) annotations[key] = value;
    }
  }

  return {
    name,
    description: source.description,
    inputSchema: sanitizeInputSchema(
      source.inputSchema !== undefined ? source.inputSchema : { type: 'object', properties: {} },
    ),
    annotations,
  };
}
