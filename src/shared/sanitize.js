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
/** Guard against stack overflow on adversarially deep (but acyclic) schemas. */
const MAX_DEPTH = 200;

/** Keys whose value is a single nested schema object (or a boolean schema). */
const SINGLE_SCHEMA_KEYS = [
  'items',
  'additionalItems',
  'additionalProperties',
  'not',
  'if',
  'then',
  'else',
  'contains',
  'propertyNames',
  'unevaluatedItems',
  'unevaluatedProperties',
  'contentSchema',
];

/** Keys whose value is an array of nested schema objects. */
const ARRAY_SCHEMA_KEYS = ['anyOf', 'oneOf', 'allOf', 'prefixItems'];

/** Keys holding a map of name -> nested schema object. */
const SCHEMA_MAP_KEYS = [
  'properties',
  '$defs',
  'definitions',
  'patternProperties',
  'dependentSchemas',
];

/** Keys that must never be written through `annotations[key] = value`. */
const UNSAFE_ANNOTATION_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** JSON-type predicates used to keep `enum` consistent with a collapsed `type`. */
const TYPE_MATCHERS = {
  string: (v) => typeof v === 'string',
  integer: (v) => typeof v === 'number' && Number.isInteger(v),
  number: (v) => typeof v === 'number',
  boolean: (v) => typeof v === 'boolean',
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
  array: (v) => Array.isArray(v),
  null: (v) => v === null,
};

function appendDescriptionHint(node, hint) {
  const base = typeof node.description === 'string' ? node.description : '';
  node.description = base + ` [gateway-sanitize] ${hint}`;
}

/**
 * Deep-clone only the JSON-shaped values that make up a JSON Schema.
 * Plain objects and arrays are cloned recursively; primitives pass through.
 *
 * Defensive guarantees:
 *  - a true JS cycle is broken (the back-edge becomes an empty placeholder),
 *    so the clone stays finite and JSON-serialisable instead of overflowing;
 *  - recursion is capped at MAX_DEPTH for the same reason.
 * Shared (non-cyclic) references are still cloned independently, preserving
 * the "never mutate / never alias the caller's objects" contract.
 */
function deepClone(value, ancestors = new WeakSet(), depth = 0) {
  if (value === null || typeof value !== 'object') return value;

  const isArray = Array.isArray(value);
  if (ancestors.has(value) || depth >= MAX_DEPTH) return isArray ? [] : {};

  ancestors.add(value);
  let out;
  if (isArray) {
    out = value.map((item) => deepClone(item, ancestors, depth + 1));
  } else {
    out = {};
    for (const key of Object.keys(value)) out[key] = deepClone(value[key], ancestors, depth + 1);
  }
  ancestors.delete(value);
  return out;
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

  // Rule 2: collapse multi-type unions to a single type.
  // Doing this first keeps long-ID string fields as "string" and never
  // introduces a "number" type (Rule 4).
  if (Array.isArray(node.type)) {
    const types = node.type.filter((t) => typeof t === 'string');
    const nonNull = types.find((t) => t !== 'null');
    let chosen = nonNull !== undefined ? nonNull : (types[0] ?? 'string');

    // If an enum is present, prefer the declared type that covers the most
    // enum values. This avoids turning e.g. {type:["string","integer"],
    // enum:[1,2]} into a string field whose enum no longer matches its type.
    if (Array.isArray(node.enum) && node.enum.length > 0) {
      let bestCount = -1;
      for (const t of types) {
        if (t === 'null') continue;
        const matches = TYPE_MATCHERS[t];
        if (!matches) continue;
        const count = node.enum.filter(matches).length;
        if (count > bestCount) {
          bestCount = count;
          chosen = t;
        }
      }
    }
    node.type = chosen;
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
      appendDescriptionHint(
        node,
        `${key} branches truncated from ${original} to ${MAX_BRANCHES} (Gemini function declaration limit)`,
      );
    }
  }

  // Rule 2b: after type collapse, an enum whose values no longer match the
  // declared type is rejected by Gemini. Filter it down to matching values
  // (and document the drop), or remove it entirely when nothing matches.
  if (typeof node.type === 'string' && Array.isArray(node.enum)) {
    const matches = TYPE_MATCHERS[node.type];
    if (matches) {
      const kept = node.enum.filter(matches);
      if (kept.length !== node.enum.length) {
        if (kept.length === 0) {
          delete node.enum;
          appendDescriptionHint(node, `enum removed: no value matches type "${node.type}"`);
        } else {
          node.enum = kept;
          appendDescriptionHint(
            node,
            `enum filtered to ${kept.length} value(s) matching type "${node.type}"`,
          );
        }
      }
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
 * Normalise a JSON Schema for Gemini. Returns a new object; the input
 * is never modified. Unrelated fields (description, title, format, …) survive.
 * Non-object inputs are replaced by a minimal safe object schema because
 * Gemini requires an object as a function-declaration inputSchema.
 *
 * @param {object} schema
 * @returns {object}
 */
export function sanitizeInputSchema(schema) {
  const source = schema !== null && typeof schema === 'object' && !Array.isArray(schema)
    ? schema
    : { type: 'object', properties: {} };
  return sanitizeNode(deepClone(source));
}

/**
 * Sanitize a tool definition into the exact shape Gemini expects.
 *
 * @param {{name?: string, description?: string, inputSchema?: object, annotations?: object}} tool
 * @returns {{name: string, description: string|undefined, inputSchema: object, annotations: object}}
 */
export function sanitizeTool(tool) {
  const source = tool !== null && typeof tool === 'object' && !Array.isArray(tool) ? tool : {};

  // Rule 5: keep only [a-zA-Z0-9_-], replace everything else with "_", cap 63.
  const rawName = typeof source.name === 'string' ? source.name : '';
  const name = rawName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, MAX_NAME_LENGTH);

  // Rule 6: guarantee the three hints, with caller values overriding defaults.
  const annotations = { ...DEFAULT_ANNOTATIONS };
  if (source.annotations !== null && typeof source.annotations === 'object' && !Array.isArray(source.annotations)) {
    for (const [key, value] of Object.entries(source.annotations)) {
      if (value === undefined || UNSAFE_ANNOTATION_KEYS.has(key)) continue;
      annotations[key] = value;
    }
  }

  return {
    name,
    description: source.description,
    // A null/array/primitive inputSchema would be passed through as-is and
    // rejected by Gemini; fall back to a safe empty object schema instead.
    inputSchema: sanitizeInputSchema(
      source.inputSchema !== undefined ? source.inputSchema : { type: 'object', properties: {} },
    ),
    annotations,
  };
}

// ---------------------------------------------------------------------------
// Tool argument normalization (camelCase aliases -> declared snake_case keys)
// ---------------------------------------------------------------------------
// Ported from taylorwilsdon/google_workspace_mcp's
// `core/camel_case_middleware.py::CamelCaseArgumentsMiddleware`. Cloudflare's
// `@cloudflare/codemode` has NO such function (its `normalizeCode()` only
// normalises generated code text), so this is a purpose-built, schema-aware
// alias mapper. It runs on the ORIGINAL upstream inputSchema at call time,
// never on the Gemini-sanitized schema, and never touches nested values.

/**
 * Convert a camelCase/PascalCase key to snake_case.
 *
 * Boundary rules mirror the Python middleware: split lower/digit -> Upper and
 * Upper -> Upper+lower (so both `iCalUid` and `iCalUID` become `i_cal_uid`).
 * Implemented with two replace passes rather than lookbehind so it also works
 * on older Node runtimes.
 */
export function toSnakeCase(name) {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

/**
 * Rename camelCase argument keys to the snake_case names declared by the
 * upstream's original inputSchema. Rename only; never add defaults, coerce
 * values, drop unknown keys, or recurse into nested objects/arrays.
 *
 * Rules (in priority order):
 *  1. A key that is itself declared in the schema is left alone — Notion's
 *     native camelCase params (`pageId`, `isInline`) are never mis-touched.
 *  2. A key whose snake_case form is declared is renamed to that form
 *     (`createdAt` -> `created_at`).
 *  3. If the caller already passed the explicit snake_case key, the camelCase
 *     alias is NOT renamed (explicit key wins, never overwritten).
 *  4. If two different keys normalize to the same target, NONE of them are
 *     renamed; the upstream schema validation decides what to reject.
 *
 * Missing / non-object `inputSchema` (or non-object `args`) returns `args`
 * unchanged. No-op calls return the original `args` reference. Neither input
 * is mutated.
 */
export function normalizeToolArguments(args, inputSchema) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return args;

  const props = inputSchema !== null
    && typeof inputSchema === 'object'
    && !Array.isArray(inputSchema)
    ? inputSchema.properties
    : undefined;
  if (props === null || typeof props !== 'object' || Array.isArray(props)) return args;

  const argKeys = Object.keys(args);
  const argKeySet = new Set(argKeys);
  /** @type {Record<string,string>} argument key -> declared snake_case key */
  const renames = Object.create(null);

  for (const key of argKeys) {
    if (hasOwn(props, key)) continue; // rule 1: declared key (incl. native camelCase)
    const snake = toSnakeCase(key);
    if (snake !== key && hasOwn(props, snake) && !argKeySet.has(snake)) {
      renames[key] = snake; // rules 2 + 3
    }
  }
  if (Object.keys(renames).length === 0) return args;

  // Rule 4: a target claimed by more than one source key is not applied.
  const counts = Object.create(null);
  for (const target of Object.values(renames)) {
    counts[target] = (counts[target] ?? 0) + 1;
  }

  const out = {};
  for (const [key, value] of Object.entries(args)) {
    const target = renames[key];
    const finalKey = target && counts[target] === 1 ? target : key;
    // defineProperty sidesteps the __proto__ setter for untrusted keys.
    Object.defineProperty(out, finalKey, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}
