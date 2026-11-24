/**
 * Thin client profile / encoding adapter.
 *
 * This module is NOT a multi-tenant or security layer. It only decides how an
 * already-computed tool result is encoded for the wire, based on an explicitly
 * declared client profile. It never inspects credentials, never changes tool
 * names, tool count, input schemas, or execution semantics.
 *
 * Facts encoded here:
 *   - Gemini (default / legacy): does not consume `structuredContent`; wants
 *     a single text block containing JSON.
 *   - ChatGPT: wants both `structuredContent` and a text JSON block.
 *   - Claude: wants a text result plus `annotations`; structuredContent is
 *     optional and is disabled by default here.
 *
 * Detection is deliberately conservative: Claude/ChatGPT/gemini are recognized
 * ONLY from an explicit profile header, an explicit client name in the
 * initialize body (`clientInfo.name`), an EXACT match in the configured OAuth
 * client-id map (`CLIENT_PLATFORM_OAUTH_MAP`), an explicit User-Agent marker, or
 * an explicit opt-in environment variable. Nothing is guessed from vague UA
 * strings; any unknown or ambiguous input falls back to the gemini profile.
 *
 * M1 client-isolation slots (per profile, all optional at read time):
 *   - `wireEncoding`      'textJson' | 'structuredContent' — descriptive view
 *                         of the legacy `structuredContent` / `textJson` flags
 *                         (the legacy booleans stay authoritative so existing
 *                         output is byte-for-byte unchanged);
 *   - `annotations`       per-tool override hints for `search` /
 *                         `execute_read` / `execute`; the built-in defaults are
 *                         EXACTLY the historical annotation values;
 *   - `descriptionMode`   'full' (default, historical text) | 'compact';
 *   - `outputBudgetChars` per-execute output budget; the default equals the
 *                         historical codemode cap (20000 chars).
 *
 * These slots are tuning only. They never change tool names, tool count, input
 * schemas, execution semantics, or the safety boundary (annotations are
 * informational, NOT permissions).
 */

export const GEMINI = 'gemini';
export const CLAUDE = 'claude';
export const CHATGPT = 'chatgpt';

/** Wire encodings (descriptive slot; mirrors the legacy boolean flags). */
export const WIRE_TEXT_JSON = 'textJson';
export const WIRE_STRUCTURED_CONTENT = 'structuredContent';

/** Tool-description verbosity slot. `full` is the historical default. */
export const DESCRIPTION_MODE_FULL = 'full';
export const DESCRIPTION_MODE_COMPACT = 'compact';

/**
 * Default output budget (characters) for one execute_read/execute result.
 * Deliberately identical to the historical codemode `DEFAULT_MAX_RESULT_CHARS`
 * (codemode.js imports this constant), so the untuned default path is
 * byte-for-byte unchanged.
 */
export const DEFAULT_OUTPUT_BUDGET_CHARS = 20000;

/** The three stable Code Mode tool names; the order is part of the contract. */
export const CLIENT_TOOL_NAMES = Object.freeze(['search', 'execute_read', 'execute']);

/**
 * Built-in Code Mode annotations. These are the exact values codemode.js has
 * always advertised; a profile may override them per tool, but an unoverridden
 * profile MUST resolve to these same objects (byte-for-byte default output).
 */
const BUILTIN_TOOL_ANNOTATIONS = Object.freeze({
  search: Object.freeze({ readOnlyHint: true, destructiveHint: false, openWorldHint: false }),
  execute_read: Object.freeze({ readOnlyHint: true, destructiveHint: false, openWorldHint: true }),
  execute: Object.freeze({ readOnlyHint: false, destructiveHint: true, openWorldHint: true }),
});

/** Only these documented boolean hints may be overridden by a profile. */
const ANNOTATION_HINT_KEYS = Object.freeze(['readOnlyHint', 'destructiveHint', 'openWorldHint']);

/**
 * Build a frozen per-tool annotation map for one profile. Only explicit
 * booleans override the built-in value; unknown keys and non-boolean values are
 * ignored (a profile can never invent a new annotation or a permission field).
 */
function buildToolAnnotations(overrides = {}) {
  const result = {};
  for (const name of CLIENT_TOOL_NAMES) {
    const base = BUILTIN_TOOL_ANNOTATIONS[name];
    const override = overrides !== null && typeof overrides === 'object' ? overrides[name] : undefined;
    const merged = {};
    for (const key of ANNOTATION_HINT_KEYS) {
      merged[key] = (override && typeof override === 'object' && typeof override[key] === 'boolean')
        ? override[key]
        : base[key];
    }
    result[name] = Object.freeze(merged);
  }
  return Object.freeze(result);
}

/** Build one frozen profile object from its M1 isolation slots. */
function makeProfile(id, { structuredContent, annotations, descriptionMode, outputBudgetChars } = {}) {
  return Object.freeze({
    id,
    // Legacy encoding booleans (authoritative, kept for compatibility).
    structuredContent: structuredContent === true,
    textJson: true,
    wireEncoding: structuredContent === true ? WIRE_STRUCTURED_CONTENT : WIRE_TEXT_JSON,
    annotations: buildToolAnnotations(annotations),
    descriptionMode: descriptionMode ?? DESCRIPTION_MODE_FULL,
    outputBudgetChars: Number.isFinite(outputBudgetChars) && outputBudgetChars > 0
      ? outputBudgetChars
      : DEFAULT_OUTPUT_BUDGET_CHARS,
  });
}

/** Public profile objects (frozen so callers cannot mutate defaults). */
export const CLIENT_PROFILES = Object.freeze({
  [GEMINI]: makeProfile(GEMINI, { structuredContent: false }),
  [CLAUDE]: makeProfile(CLAUDE, { structuredContent: false }),
  [CHATGPT]: makeProfile(CHATGPT, { structuredContent: true }),
});

/** Header used to declare a profile explicitly. Case-insensitive via lookup helper. */
export const PROFILE_HEADER = 'x-gateway-client-profile';

// Environment opt-ins. Only exact, explicit values enable a non-default
// profile; anything else is ignored (unknown -> gemini).
const ENV_PROFILE_VAR = 'GATEWAY_CLIENT_PROFILE';
const ENV_CLAUDE_OPTIN = 'GATEWAY_CLIENT_CLAUDE';
const ENV_CHATGPT_OPTIN = 'GATEWAY_CLIENT_CHATGPT';

function lower(value) {
  return typeof value === 'string' ? value.toLowerCase() : '';
}

function headerValue(headers, name) {
  if (!headers || typeof headers !== 'object') return undefined;
  const direct = headers[name];
  if (direct !== undefined) return direct;
  const wanted = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === wanted) return headers[key];
  }
  return undefined;
}

function firstString(value) {
  return Array.isArray(value) ? value.find((v) => typeof v === 'string') : value;
}

/**
 * Classify an explicit declaration string into a profile id, or null if it is
 * not an explicit, recognized declaration. Kept intentionally narrow: only
 * exact known tokens count, never substring matching.
 */
function classifyExplicit(declaration) {
  const value = lower(firstString(declaration)).trim();
  if (!value) return null;
  if (value === GEMINI || value === 'legacy' || value === 'default') return GEMINI;
  if (value === CLAUDE || value === 'claude-code' || value === 'anthropic') return CLAUDE;
  if (value === CHATGPT || value === 'chat-gpt' || value === 'openai') return CHATGPT;
  return null;
}

/**
 * Recognize an explicit client marker from a User-Agent string. We only accept
 * unmistakable product tokens; a bare "Mozilla" or generic word never matches.
 */
function classifyUserAgent(ua) {
  const value = lower(firstString(ua));
  if (!value) return null;
  // ChatGPT / OpenAI agents identify themselves with these explicit tokens.
  if (/\bchatgpt\b|\bopenai\b|\bchatgpt-agent\b/.test(value)) return CHATGPT;
  // Claude agents identify themselves with these explicit tokens.
  if (/\bclaude\b|\bclaude-code\b|\banthropic\b/.test(value)) return CLAUDE;
  return null;
}

/* ------------------------------------------------------------------ *
 * Explicit OAuth client-id -> profile mapping
 *
 * The lookup rules deliberately MIRROR `src/client/client-platform.js`
 * (`oauthClientMap()` / `platformFromOAuth()`), because the runtime profile
 * and the captured `clientPlatform` label must never disagree. The mapping is
 * implemented here rather than imported: client-platform.js already imports
 * THIS module, so a reverse import would create an ESM cycle that evaluates
 * client-platform's frozen platform map before these constants initialize.
 * `tests/client-profile-isolation.test.js` pins both implementations together.
 *
 * Only two explicit channels count, and nothing is inferred from client-id
 * shape/prefix:
 *   1. `input.oauthClientMap` — an object of exact client-id -> platform id;
 *   2. `env.CLIENT_PLATFORM_OAUTH_MAP` — a JSON string of that same shape.
 * An unmapped / malformed / non-exact client id contributes NO signal.
 * ------------------------------------------------------------------ */
const ENV_OAUTH_MAP = 'CLIENT_PLATFORM_OAUTH_MAP';

function asPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

/** Resolve the explicit OAuth map (option wins over the env JSON string). */
function oauthClientMapFrom(input, env) {
  const fromOption = asPlainObject(input?.oauthClientMap);
  if (fromOption) return fromOption;
  const raw = env?.[ENV_OAUTH_MAP];
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    return asPlainObject(JSON.parse(raw)) ?? {};
  } catch {
    return {}; // malformed explicit config is ignored, never guessed
  }
}

/**
 * Exact OAuth client-id lookup. Returns one of the three profile ids or null.
 * Own keys only, and only the three documented platform values count.
 */
function platformFromOAuthClientId(clientId, map) {
  if (typeof clientId !== 'string' || !clientId) return null;
  if (!map || typeof map !== 'object') return null;
  if (!Object.prototype.hasOwnProperty.call(map, clientId)) return null;
  const value = map[clientId];
  if (value === GEMINI || value === CLAUDE || value === CHATGPT) return value;
  return null;
}

/**
 * Resolve the client profile for a request.
 *
 * @param {{
 *   headers?: object,
 *   body?: object,
 *   env?: object,
 *   oauthClientId?: string,
 *   oauthClientMap?: Record<string,string>,
 * }} [input]
 *   `headers` is the incoming HTTP header map; `body` is the parsed JSON-RPC
 *   body (used only for `params.clientInfo.name` on initialize); `env` is
 *   injectable for tests and defaults to process.env; `oauthClientId` is the
 *   authenticated OAuth client id (from the token record); `oauthClientMap`
 *   overrides the env JSON map for tests/injection.
 * @returns {object} one of the frozen CLIENT_PROFILES values. Unknown input
 *   -> gemini.
 */
export function resolveClientProfile(input = {}) {
  const { headers, body, env = process.env, oauthClientId } = input ?? {};

  // 1. Highest priority: explicit profile header.
  const declared = classifyExplicit(headerValue(headers, PROFILE_HEADER));
  if (declared) return CLIENT_PROFILES[declared];

  // 2. Explicit client name in the initialize body's clientInfo.name. This is
  //    a first-class declaration by the MCP client, not a guess.
  const clientName = body?.params?.clientInfo?.name ?? body?.clientInfo?.name;
  const fromClientInfo = classifyExplicit(clientName);
  if (fromClientInfo) return CLIENT_PROFILES[fromClientInfo];

  // 3. Exact OAuth client-id mapping. Only a configured EXACT match determines
  //    the profile; an unmapped id falls through to the lower-priority
  //    signals. Placed after header/clientInfo (their priority is unchanged)
  //    and before UA/env to match detectClientPlatform()'s precedence, so the
  //    runtime profile and the captured clientPlatform label stay consistent.
  const oauthPlatform = platformFromOAuthClientId(oauthClientId, oauthClientMapFrom(input, env));
  if (oauthPlatform) return CLIENT_PROFILES[oauthPlatform];

  // 4. Explicit User-Agent product token.
  const fromUa = classifyUserAgent(headerValue(headers, 'user-agent'));
  if (fromUa) return CLIENT_PROFILES[fromUa];

  // 5. Explicit environment opt-ins. These must be exact "1"/"true"/profile
  //    names; a client must deliberately set them.
  const envProfile = classifyExplicit(env?.[ENV_PROFILE_VAR]);
  if (envProfile) return CLIENT_PROFILES[envProfile];
  if (['1', 'true', 'yes'].includes(lower(env?.[ENV_CLAUDE_OPTIN]))) return CLIENT_PROFILES[CLAUDE];
  if (['1', 'true', 'yes'].includes(lower(env?.[ENV_CHATGPT_OPTIN]))) return CLIENT_PROFILES[CHATGPT];

  // 6. Unknown / missing / ambiguous -> gemini (legacy text-JSON default).
  return CLIENT_PROFILES[GEMINI];
}

/**
 * Effective structuredContent desire for a profile. The legacy
 * `structuredContent` boolean stays authoritative (byte-for-byte compatible
 * with existing encoding); a profile that only declares the new
 * `wireEncoding` slot is honored as an optional convenience.
 */
function wantsStructuredContent(profile) {
  if (!profile || typeof profile !== 'object') return false;
  if (typeof profile.structuredContent === 'boolean') return profile.structuredContent;
  return profile.wireEncoding === WIRE_STRUCTURED_CONTENT;
}

/**
 * Encode an already-computed tool result for the given profile.
 *
 * The input is the normal MCP tool result shape:
 *   `{ content: [{type:'text', text: JSON.stringify(value)}, ...], ... }`
 * The returned object is a NEW object; the input is never mutated.
 *
 * - Gemini: text JSON only. `structuredContent` is removed entirely so it can
 *   never leak to a client that cannot consume it.
 * - ChatGPT: both `structuredContent` (when derivable) and the text JSON block.
 * - Claude: text result; `structuredContent` is omitted by default (profile's
 *   `structuredContent` flag is false).
 *
 * If the result already carries `structuredContent` and the profile wants it,
 * it is preserved. If it does not, we try to derive it from a single text JSON
 * block (best-effort; a plain string is not treated as structured JSON).
 */
export function encodeToolResult(result, profile = CLIENT_PROFILES[GEMINI]) {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return result;

  const id = typeof profile === 'string' ? profile : profile?.id;
  const effective = CLIENT_PROFILES[id] ?? CLIENT_PROFILES[GEMINI];
  const wantsStructured = wantsStructuredContent(effective);

  const { structuredContent, ...rest } = result;
  void structuredContent;

  if (!wantsStructured) {
    // Gemini / Claude: strip structuredContent entirely, keep text JSON as-is.
    // This is byte-for-byte identical to the current default when the input
    // never contained structuredContent (the normal case).
    return { ...rest };
  }

  // ChatGPT: keep/derive structuredContent alongside the text JSON block.
  let sc = structuredContent;
  if (sc === undefined) {
    sc = deriveStructuredContent(result.content);
  }
  if (sc === undefined) return { ...rest };
  return { ...rest, structuredContent: sc };
}

/**
 * Encode a projected Code Mode model payload for the profile.
 *
 * The projected payload is `{ result, ... }` (see toModelOutput in codemode.js)
 * rather than an MCP `{content:[...]}` envelope. For the default gemini profile
 * this returns the payload unchanged (no structuredContent); for chatgpt it
 * adds structuredContent derived from `result` when that is an object/array.
 */
export function encodeModelOutput(output, profile = CLIENT_PROFILES[GEMINI]) {
  if (output === null || typeof output !== 'object' || Array.isArray(output)) return output;
  const id = typeof profile === 'string' ? profile : profile?.id;
  const effective = CLIENT_PROFILES[id] ?? CLIENT_PROFILES[GEMINI];
  const { structuredContent, ...rest } = output;
  void structuredContent;
  if (!wantsStructuredContent(effective)) return { ...rest };
  let sc = structuredContent;
  if (sc === undefined) {
    const candidate = rest.result;
    if (candidate !== null && typeof candidate === 'object') sc = candidate;
    else if (typeof candidate === 'string') {
      try {
        const parsed = JSON.parse(candidate);
        if (parsed !== null && typeof parsed === 'object') sc = parsed;
      } catch { /* not JSON */ }
    }
  }
  if (sc === undefined) return { ...rest };
  return { ...rest, structuredContent: sc };
}

/** Best-effort derivation of structured content from a single text JSON block. */
function deriveStructuredContent(content) {
  if (!Array.isArray(content)) return undefined;
  const texts = content
    .filter((item) => item && item.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text);
  if (texts.length !== 1) return undefined;
  try {
    const parsed = JSON.parse(texts[0]);
    // Only objects/arrays are meaningful structured content; a bare string or
    // number would be an unnecessarily surprising addition.
    if (parsed !== null && typeof parsed === 'object') return parsed;
  } catch {
    /* not JSON: leave structuredContent absent */
  }
  return undefined;
}

/**
 * Normalize a profile reference (id string, frozen profile object, or a
 * caller-built profile-like object) into an object, or null when unusable.
 * Unknown id strings contribute no overrides; legacy profile objects whose
 * `annotations` is still a boolean are treated as "no overrides" too.
 */
function asProfileObject(profile) {
  if (typeof profile === 'string') return CLIENT_PROFILES[profile] ?? null;
  return profile !== null && typeof profile === 'object' ? profile : null;
}

/** Pick only the three documented boolean hints from a value, or null. */
function annotationHints(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const hints = {};
  for (const key of ANNOTATION_HINT_KEYS) {
    if (typeof value[key] === 'boolean') hints[key] = value[key];
  }
  return Object.keys(hints).length ? hints : null;
}

/** Profile-declared override for one tool, or null (default = no override). */
function profileAnnotationOverride(profile, toolName) {
  if (typeof toolName !== 'string' || !toolName) return null;
  const spec = asProfileObject(profile)?.annotations;
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return null;
  if (!Object.prototype.hasOwnProperty.call(spec, toolName)) return null;
  return annotationHints(spec[toolName]);
}

/**
 * Resolve the annotations a profile declares for one tool WITHOUT changing
 * tool names/count/schemas. `fallback` is the tool's current annotation object
 * (defaults to the built-in Code Mode annotations for a known tool name).
 *
 * - No profile override -> `fallback` is returned AS-IS, so the default path
 *   stays byte-for-byte identical.
 * - Override present -> only readOnlyHint/destructiveHint/openWorldHint are
 *   overlaid; every other field (e.g. `title`) is preserved.
 */
export function resolveToolAnnotations(toolName, profile, fallback) {
  const base = fallback !== undefined && fallback !== null
    ? fallback
    : BUILTIN_TOOL_ANNOTATIONS[toolName];
  const override = profileAnnotationOverride(profile, toolName);
  if (!override) return base;
  if (!base || typeof base !== 'object' || Array.isArray(base)) return { ...override };
  let changed = false;
  for (const key of ANNOTATION_HINT_KEYS) {
    if (override[key] !== undefined && override[key] !== base[key]) changed = true;
  }
  if (!changed) return base;
  return { ...base, ...override };
}

/**
 * Adjust tool annotations for a profile WITHOUT touching tool names, count,
 * schemas, descriptions, or handlers. Returns a new tools array.
 *
 * The M1 `annotations` slot may override the three documented hints per tool
 * (`search` / `execute_read` / `execute`). Tools the profile does not name keep
 * their existing annotations untouched; tools without annotations still get the
 * same benign defaults as before. Every stock profile currently resolves to the
 * historical values, so the default (Gemini) path is byte-for-byte unchanged.
 */
export function applyProfileToTools(tools, profile = CLIENT_PROFILES[GEMINI]) {
  if (!Array.isArray(tools)) return tools;
  return tools.map((tool) => {
    if (!tool || typeof tool !== 'object') return tool;
    const next = { ...tool };
    const override = profileAnnotationOverride(profile, tool.name);
    if (next.annotations === undefined || next.annotations === null) {
      const defaults = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
      next.annotations = override ? { ...defaults, ...override } : defaults;
      return next;
    }
    const resolved = resolveToolAnnotations(tool.name, profile, next.annotations);
    if (resolved !== next.annotations) next.annotations = resolved;
    return next;
  });
}
