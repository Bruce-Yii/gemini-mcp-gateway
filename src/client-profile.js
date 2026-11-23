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
 * Detection is deliberately conservative: Claude/ChatGPT are recognized ONLY
 * from an explicit profile header, an explicit client name in the initialize
 * body (`clientInfo.name`), an explicit User-Agent marker, or an explicit
 * opt-in environment variable. Nothing is guessed from vague UA strings; any
 * unknown or ambiguous input falls back to the gemini profile.
 */

export const GEMINI = 'gemini';
export const CLAUDE = 'claude';
export const CHATGPT = 'chatgpt';

/** Public profile objects (frozen so callers cannot mutate defaults). */
export const CLIENT_PROFILES = Object.freeze({
  [GEMINI]: Object.freeze({ id: GEMINI, structuredContent: false, textJson: true, annotations: true }),
  [CLAUDE]: Object.freeze({ id: CLAUDE, structuredContent: false, textJson: true, annotations: true }),
  [CHATGPT]: Object.freeze({ id: CHATGPT, structuredContent: true, textJson: true, annotations: true }),
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

/**
 * Resolve the client profile for a request.
 *
 * @param {{headers?: object, body?: object, env?: object}} [input]
 *   `headers` is the incoming HTTP header map; `body` is the parsed JSON-RPC
 *   body (used only for `params.clientInfo.name` on initialize); `env` is
 *   injectable for tests and defaults to process.env.
 * @returns {{id: string, structuredContent: boolean, textJson: boolean, annotations: boolean}}
 *   one of the frozen CLIENT_PROFILES values. Unknown input -> gemini.
 */
export function resolveClientProfile(input = {}) {
  const { headers, body, env = process.env } = input ?? {};

  // 1. Highest priority: explicit profile header.
  const declared = classifyExplicit(headerValue(headers, PROFILE_HEADER));
  if (declared) return CLIENT_PROFILES[declared];

  // 2. Explicit client name in the initialize body's clientInfo.name. This is
  //    a first-class declaration by the MCP client, not a guess.
  const clientName = body?.params?.clientInfo?.name ?? body?.clientInfo?.name;
  const fromClientInfo = classifyExplicit(clientName);
  if (fromClientInfo) return CLIENT_PROFILES[fromClientInfo];

  // 3. Explicit User-Agent product token.
  const fromUa = classifyUserAgent(headerValue(headers, 'user-agent'));
  if (fromUa) return CLIENT_PROFILES[fromUa];

  // 4. Explicit environment opt-ins. These must be exact "1"/"true"/profile
  //    names; a client must deliberately set them.
  const envProfile = classifyExplicit(env?.[ENV_PROFILE_VAR]);
  if (envProfile) return CLIENT_PROFILES[envProfile];
  if (['1', 'true', 'yes'].includes(lower(env?.[ENV_CLAUDE_OPTIN]))) return CLIENT_PROFILES[CLAUDE];
  if (['1', 'true', 'yes'].includes(lower(env?.[ENV_CHATGPT_OPTIN]))) return CLIENT_PROFILES[CHATGPT];

  // 5. Unknown / missing / ambiguous -> gemini (legacy text-JSON default).
  return CLIENT_PROFILES[GEMINI];
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
  const wantsStructured = Boolean(effective.structuredContent);

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
  if (!effective.structuredContent) return { ...rest };
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
 * Adjust tool annotations for a profile WITHOUT touching tool names, count,
 * schemas, descriptions, or handlers. Returns a new tools array.
 *
 * Current annotations already carry readOnlyHint/destructiveHint/openWorldHint
 * from sanitizeTool(). For every profile we keep those exact values. The only
 * permitted adjustment is filling in defaults for a tool that has no
 * annotations at all — and even then the defaults match what sanitizeTool()
 * already produces, so the default (Gemini) path is byte-for-byte unchanged.
 */
export function applyProfileToTools(tools, profile = CLIENT_PROFILES[GEMINI]) {
  if (!Array.isArray(tools)) return tools;
  const id = typeof profile === 'string' ? profile : profile?.id;
  void id; // annotations are kept identical across profiles today
  return tools.map((tool) => {
    if (!tool || typeof tool !== 'object') return tool;
    const next = { ...tool };
    if (next.annotations === undefined) {
      next.annotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
    }
    return next;
  });
}
