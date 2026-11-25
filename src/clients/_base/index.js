/**
 * Shared, platform-agnostic client-adapter contract for Code Mode.
 *
 * PURPOSE
 *   `src/clients/<platform>/` physically owns one MCP client's Code Mode
 *   adaptation surface (tool descriptions, output encoding, output budget,
 *   search/retrieval policy). This module owns only the generic contract and
 *   the shared assembler that turns an adapter + objective upstream guidance
 *   into the three stable tool definitions.
 *
 * HARD RULE
 *   There must be NO single-platform special branch in this file. Anything that
 *   says "gemini does X" / "chatgpt does Y" belongs in that platform's own
 *   directory, never here. The base may only implement defaults that every
 *   platform gets when it does not override them (currently: text-JSON output,
 *   the historical 20000-character output budget, full descriptions).
 *
 * WHAT AN ADAPTER MAY INFLUENCE
 *   - tool DESCRIPTIONS (via its own prompts.js tables)   -> wording only
 *   - tool ANNOTATIONS (informational hints)              -> never permissions
 *   - model/tool-result ENCODING                          -> text JSON vs
 *                                                            structuredContent
 *   - execute output BUDGET (characters)                  -> truncation budget
 *   - search/retrieval policy (default limit, list-mode
 *     description compaction)
 *
 * WHAT IT MAY NEVER INFLUENCE
 *   Tool names, tool order, input schemas, handlers, sandbox semantics, the
 *   read-only/write boundary, upstream auth, or any permission decision.
 *   Those are the objective contract assembled here and in
 *   src/execution/codemode.js.
 */

import {
  CLIENT_TOOL_NAMES,
  DEFAULT_OUTPUT_BUDGET_CHARS,
  DESCRIPTION_MODE_COMPACT,
  DESCRIPTION_MODE_FULL,
  WIRE_STRUCTURED_CONTENT,
  WIRE_TEXT_JSON,
  applyProfileToTools,
  resolveToolAnnotations,
} from '../../client/client-profile.js';

export {
  CLIENT_TOOL_NAMES,
  DEFAULT_OUTPUT_BUDGET_CHARS,
  DESCRIPTION_MODE_COMPACT,
  DESCRIPTION_MODE_FULL,
  WIRE_STRUCTURED_CONTENT,
  WIRE_TEXT_JSON,
};

/** The three concrete platforms this gateway ships adapters for. */
export const CLIENT_PLATFORMS = Object.freeze(['gemini', 'chatgpt', 'claude']);

/**
 * Brand used to recognise an adapter object without importing any platform
 * module (the router, codemode.js and server.js only ever hold an adapter
 * reference; rule B forbids them from importing a concrete platform).
 */
const ADAPTER_BRAND = Symbol.for('gemini-mcp-gateway.client-adapter.v1');

/** Search/retrieval policy defaults: identical to the historical behaviour. */
export const DEFAULT_SEARCH_POLICY = Object.freeze({
  defaultLimit: 8,
  compactListDescriptions: true,
});

/** Marker property exposed in JSON snapshots/tests (symbol itself is private). */
export const CLIENT_ADAPTER_MARKER = 'clientAdapter';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPositiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function requireOneOf(value, allowed, label) {
  if (!allowed.includes(value)) {
    throw new TypeError(`[clients/_base] ${label} must be one of ${allowed.join('|')}, got ${String(value)}`);
  }
  return value;
}

/** True for an object produced by createClientAdapter() (stock or tuned). */
export function isClientAdapter(value) {
  return Boolean(value && typeof value === 'object' && value[ADAPTER_BRAND] === true);
}

/**
 * Default text-JSON model-output encoding (the historical Gemini/Claude shape):
 * a plain object with any `structuredContent` field removed. The input is never
 * mutated. Non-object inputs are returned untouched, exactly like the legacy
 * `encodeModelOutput` helper.
 */
export function defaultEncodeModelOutput(output) {
  if (!isPlainObject(output)) return output;
  const { structuredContent, ...rest } = output;
  void structuredContent;
  return { ...rest };
}

/** Default text-JSON MCP tool-result encoding: strips `structuredContent`. */
export function defaultEncodeToolResult(result) {
  if (!isPlainObject(result)) return result;
  const { structuredContent, ...rest } = result;
  void structuredContent;
  return { ...rest };
}

/**
 * Default description selection. `prompts` is the platform's catalog:
 * `{ full: {search, execute_read, execute}, compact: {...} }`, where every
 * entry is a function of the description context.
 */
export function defaultDescribeTool(prompts, name, context = {}) {
  const mode = context.descriptionMode === DESCRIPTION_MODE_COMPACT ? 'compact' : 'full';
  const table = prompts?.[mode];
  const build = table?.[name];
  if (typeof build !== 'function') {
    throw new TypeError(`[clients/_base] no ${mode} prompt builder for tool "${name}"`);
  }
  return build(context);
}

/**
 * Default execute-output budget selection. Precedence is unchanged from the
 * pre-refactor code: an explicit operator/config `maxResultChars` always wins
 * (it may be a hard global cap); otherwise the adapter's per-client budget;
 * otherwise the historical global default.
 */
export function resolveOutputBudget(adapter, options = {}) {
  const configured = options?.maxResultChars;
  if (configured !== undefined && configured !== null) return configured;
  const budget = adapter?.outputBudgetChars;
  if (isPositiveNumber(budget)) return budget;
  return DEFAULT_OUTPUT_BUDGET_CHARS;
}

function normalizeSearchPolicy(policy) {
  const source = isPlainObject(policy) ? policy : {};
  const defaultLimit = Number.isInteger(source.defaultLimit) && source.defaultLimit > 0
    ? source.defaultLimit
    : DEFAULT_SEARCH_POLICY.defaultLimit;
  return Object.freeze({
    defaultLimit,
    compactListDescriptions: source.compactListDescriptions !== false,
  });
}

function validatePrompts(prompts) {
  if (!isPlainObject(prompts)) {
    throw new TypeError('[clients/_base] adapter.prompts must be an object { full, compact }');
  }
  for (const mode of ['full', 'compact']) {
    const table = prompts[mode];
    if (!isPlainObject(table)) {
      throw new TypeError(`[clients/_base] adapter.prompts.${mode} must be an object`);
    }
    for (const name of CLIENT_TOOL_NAMES) {
      if (typeof table[name] !== 'function') {
        throw new TypeError(`[clients/_base] adapter.prompts.${mode}.${name} must be a function`);
      }
    }
  }
  return prompts;
}

/**
 * Build a frozen stock adapter from one platform's declarative spec.
 *
 * @param {{
 *   id: string,
 *   wireEncoding?: 'textJson'|'structuredContent',
 *   descriptionMode?: 'full'|'compact',
 *   outputBudgetChars?: number,
 *   prompts: {full: object, compact: object},
 *   encodeModelOutput?: Function,
 *   encodeToolResult?: Function,
 *   search?: {defaultLimit?: number, compactListDescriptions?: boolean},
 * }} spec
 */
export function createClientAdapter(spec = {}) {
  if (typeof spec.id !== 'string' || !spec.id.trim()) {
    throw new TypeError('[clients/_base] adapter.id must be a non-empty string');
  }
  const wireEncoding = requireOneOf(
    spec.wireEncoding ?? WIRE_TEXT_JSON,
    [WIRE_TEXT_JSON, WIRE_STRUCTURED_CONTENT],
    'wireEncoding',
  );
  const descriptionMode = requireOneOf(
    spec.descriptionMode ?? DESCRIPTION_MODE_FULL,
    [DESCRIPTION_MODE_FULL, DESCRIPTION_MODE_COMPACT],
    'descriptionMode',
  );
  const outputBudgetChars = isPositiveNumber(spec.outputBudgetChars)
    ? spec.outputBudgetChars
    : DEFAULT_OUTPUT_BUDGET_CHARS;
  const prompts = validatePrompts(spec.prompts);

  const adapter = {
    [ADAPTER_BRAND]: true,
    [CLIENT_ADAPTER_MARKER]: true,
    id: spec.id,
    wireEncoding,
    descriptionMode,
    outputBudgetChars,
    prompts,
    encodeModelOutput: typeof spec.encodeModelOutput === 'function'
      ? spec.encodeModelOutput
      : defaultEncodeModelOutput,
    encodeToolResult: typeof spec.encodeToolResult === 'function'
      ? spec.encodeToolResult
      : defaultEncodeToolResult,
    search: normalizeSearchPolicy(spec.search),
    /** Per-request profile that tuned this adapter (undefined for stock). */
    profile: undefined,
    /**
     * Produce one tool description from this platform's own prompt catalog.
     * The assembler always supplies the effective descriptionMode.
     */
    describeTool(name, context = {}) {
      return defaultDescribeTool(prompts, name, context);
    },
  };
  return Object.freeze(adapter);
}

/**
 * Apply a resolved client profile's tuning slots to a stock adapter.
 *
 * Only the three documented M1 tuning slots are read, and none of them can
 * change tool names/count/schemas/semantics:
 *   - descriptionMode   full (default) | compact
 *   - outputBudgetChars per-execute result budget
 *   - annotations       informational hint overrides (applied per tool name)
 *
 * The profile is retained so annotations can be resolved lazily per tool.
 * Unknown/invalid profile values leave the stock adapter untouched.
 */
export function tuneClientAdapter(adapter, profile) {
  if (!isClientAdapter(adapter)) {
    throw new TypeError('[clients/_base] tuneClientAdapter expects an adapter');
  }
  if (!isPlainObject(profile)) return adapter;

  const descriptionMode = profile.descriptionMode === DESCRIPTION_MODE_COMPACT
    || profile.descriptionMode === DESCRIPTION_MODE_FULL
    ? profile.descriptionMode
    : adapter.descriptionMode;
  const outputBudgetChars = isPositiveNumber(profile.outputBudgetChars)
    ? profile.outputBudgetChars
    : adapter.outputBudgetChars;

  if (descriptionMode === adapter.descriptionMode
    && outputBudgetChars === adapter.outputBudgetChars
    && adapter.profile === undefined) {
    // Stock-profile fast path: the face is unchanged; only attach the profile
    // so annotation overrides can still be resolved lazily per tool.
    return Object.freeze({ ...adapter, profile });
  }
  return Object.freeze({ ...adapter, descriptionMode, outputBudgetChars, profile });
}

/** Resolve the annotations a tool advertises for this adapter/profile. */
export function resolveAnnotations(adapter, toolName, fallback) {
  return resolveToolAnnotations(toolName, adapter?.profile, fallback);
}

/** Apply the adapter's profile slots to an existing tools array (unsafe copy). */
export function applyClientToTools(adapter, tools) {
  return applyProfileToTools(tools, adapter?.profile);
}

/**
 * Shared assembler: combine objective tool definitions (name/schema/handler)
 * with the client-owned face (description/annotations).
 */
export function assembleToolDefinitions(adapter, context, definitions) {
  if (!isClientAdapter(adapter)) {
    throw new TypeError('[clients/_base] assembleToolDefinitions expects an adapter');
  }
  const descriptions = describeTools(adapter, context);
  return definitions.map((definition) => ({
    name: definition.name,
    description: descriptions[definition.name],
    inputSchema: definition.inputSchema,
    annotations: resolveAnnotations(adapter, definition.name, definition.annotations),
    handler: definition.handler,
  }));
}

/** Build every Code Mode tool description through the adapter's own prompts. */
export function describeTools(adapter, context = {}) {
  if (!isClientAdapter(adapter)) {
    throw new TypeError('[clients/_base] describeTools expects an adapter');
  }
  const result = {};
  for (const name of CLIENT_TOOL_NAMES) {
    result[name] = adapter.describeTool(name, {
      ...context,
      descriptionMode: adapter.descriptionMode,
    });
  }
  return result;
}
