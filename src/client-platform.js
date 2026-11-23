/**
 * Client platform detection — observability layer only (B13, layer 1).
 *
 * This module derives a *label* for the calling client platform (Gemini /
 * ChatGPT / Claude / unknown) from explicit signals already present on the
 * request. It is a pure function: no I/O, no mutation of inputs, no ambient
 * state beyond the explicitly injected `env`.
 *
 * HARD RULES (do not weaken):
 *   - This label is for capture/encoding/observability ONLY. It is NEVER used
 *     by write paths, idempotency keys, permissions, tool names/count/schema,
 *     or upstream auth decisions.
 *   - Nothing is guessed from vague strings. Only an explicit profile header,
 *     an explicit `clientInfo.name`, an explicitly configured OAuth client-id
 *     mapping, or an explicit UA product token may produce a non-unknown label.
 *   - Unknown / missing / ambiguous input resolves to `unknown` + the legacy
 *     default profile `gemini-text-json`. That default is byte-for-byte the
 *     existing behaviour — the label never changes what the gateway does.
 *
 * The low-level signal classification is reused from `src/client-profile.js`
 * (the single source of truth for "what is an explicit client declaration"),
 * so platform detection and result encoding can never disagree.
 */
import {
  resolveClientProfile,
  CLIENT_PROFILES,
  GEMINI,
  CLAUDE,
  CHATGPT,
  PROFILE_HEADER,
} from './client-profile.js';

/** Public platform ids. `unknown` is a first-class value, not an error. */
export const PLATFORM_GEMINI = GEMINI;
export const PLATFORM_CHATGPT = CHATGPT;
export const PLATFORM_CLAUDE = CLAUDE;
export const PLATFORM_UNKNOWN = 'unknown';

/** Wire profile strings carried in capture envelopes. */
export const PROFILE_GEMINI_TEXT_JSON = 'gemini-text-json';
export const PROFILE_CHATGPT_STRUCTURED = 'chatgpt-structured';
export const PROFILE_CLAUDE_TEXT = 'claude-text';

const PLATFORM_PROFILES = Object.freeze({
  [PLATFORM_GEMINI]: PROFILE_GEMINI_TEXT_JSON,
  [PLATFORM_CHATGPT]: PROFILE_CHATGPT_STRUCTURED,
  [PLATFORM_CLAUDE]: PROFILE_CLAUDE_TEXT,
});

/**
 * Explicit OAuth client-id -> platform mapping. This is deliberately NOT
 * inferred from client-id shape, prefix, or any heuristic: only exact values
 * supplied by the caller (via `options.oauthClientMap` or the explicitly
 * documented `env.CLIENT_PLATFORM_OAUTH_MAP` JSON string) count. A client id
 * that is not in the map contributes no signal at all -> unknown.
 */
const ENV_OAUTH_MAP = 'CLIENT_PLATFORM_OAUTH_MAP';

function firstString(value) {
  if (Array.isArray(value)) return value.find((v) => typeof v === 'string');
  return value;
}

function asObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

/** Read a header case-insensitively (mirrors client-profile.js semantics). */
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

/**
 * Tokens explicitly recognized by client-profile.js's classifyExplicit().
 * We check membership so an unrecognized value (which resolveClientProfile()
 * maps to the gemini *fallback*) is not misattributed as an explicit signal.
 */
const EXPLICIT_TOKENS = new Set([
  'gemini', 'legacy', 'default',
  'claude', 'claude-code', 'anthropic',
  'chatgpt', 'chat-gpt', 'openai',
]);

function normalizedToken(value) {
  return typeof value === 'string' ? value.toLowerCase().trim() : '';
}

/** Recognized explicit profile-header value, or null. */
function recognizedHeaderPlatform(headers) {
  const value = firstString(headerValue(headers, PROFILE_HEADER));
  const token = normalizedToken(value);
  if (!EXPLICIT_TOKENS.has(token)) return null;
  // Delegate the actual id mapping to client-profile.js (single source of truth).
  const id = resolveClientProfile({ headers: { [PROFILE_HEADER]: value }, env: {} }).id;
  return id === GEMINI || id === CHATGPT || id === CLAUDE ? id : null;
}

/** Recognized explicit clientInfo.name, or null. */
function recognizedClientInfoPlatform(body) {
  const value = firstString(body?.params?.clientInfo?.name ?? body?.clientInfo?.name);
  const token = normalizedToken(value);
  if (!EXPLICIT_TOKENS.has(token)) return null;
  const id = resolveClientProfile({ body: { params: { clientInfo: { name: value } } }, env: {} }).id;
  return id === GEMINI || id === CHATGPT || id === CLAUDE ? id : null;
}

/** Recognized explicit UA product token, or null. */
function recognizedUaPlatform(headers) {
  const ua = firstString(headerValue(headers, 'user-agent'));
  if (typeof ua !== 'string' || !ua.trim()) return null;
  const id = resolveClientProfile({ headers: { 'user-agent': ua }, env: {} }).id;
  // resolveClientProfile() maps an unrecognized UA to the gemini fallback.
  // Treat that fallback as "no signal" — only chatgpt/claude UA tokens are
  // honest platform evidence (there is no explicit gemini UA product token).
  return id === CHATGPT || id === CLAUDE ? id : null;
}

/**
 * Resolve the explicit OAuth client-id mapping into a frozen lookup object.
 * Only two opt-in channels are honored, and neither guesses:
 *   1. `input.oauthClientMap` — an object of exact client-id -> platform id.
 *   2. `env.CLIENT_PLATFORM_OAUTH_MAP` — a JSON string of the same shape.
 */
function oauthClientMap(input, env) {
  const fromOption = asObject(input?.oauthClientMap);
  if (fromOption) return fromOption;
  const raw = env?.[ENV_OAUTH_MAP];
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    return asObject(JSON.parse(raw)) ?? {};
  } catch {
    return {}; // malformed explicit config is ignored, never guessed
  }
}

/** Map a client id through the explicit map only; unknown -> null. */
function platformFromOAuth(clientId, map) {
  if (typeof clientId !== 'string' || !clientId) return null;
  const value = map[clientId];
  if (value === PLATFORM_GEMINI || value === PLATFORM_CHATGPT || value === PLATFORM_CLAUDE) {
    return value;
  }
  return null;
}

/**
 * Derive the platform id for one request.
 *
 * Precedence (first explicit signal wins):
 *   1. `x-gateway-client-profile` header
 *   2. `clientInfo.name` in an initialize body
 *   3. OAuth client id via the explicit map
 *   4. explicit UA product token
 *   5. otherwise `unknown`
 *
 * Detection at each layer is delegated to `resolveClientProfile()` from
 * client-profile.js, which already implements the conservative classifiers.
 * We isolate a layer by passing only that layer's signals and verify the raw
 * declaration is a recognized token (so a generic UA falling back to gemini
 * is NOT misreported as an explicit gemini signal). An explicit `gemini`
 * header/clientInfo declaration IS a real signal and is reported with its
 * source; it simply maps to the gemini platform/profile.
 */
function resolvePlatform(input) {
  const { headers, body, oauthClientId, env = process.env } = input ?? {};
  const map = oauthClientMap(input, env);

  // 1. Explicit profile header. An explicitly declared `gemini` is a real
  //    signal (reported with its source); an unrecognized value is not.
  const fromHeader = recognizedHeaderPlatform(headers);
  if (fromHeader) return { platform: fromHeader, source: 'profile_header', confidence: 'high' };

  // 2. Explicit clientInfo.name from the initialize body.
  const fromClientInfo = recognizedClientInfoPlatform(body);
  if (fromClientInfo) return { platform: fromClientInfo, source: 'client_info', confidence: 'high' };

  // 3. Explicit OAuth client-id mapping (configured only, no guessing).
  const fromOAuth = platformFromOAuth(oauthClientId, map);
  if (fromOAuth) return { platform: fromOAuth, source: 'oauth_client_id', confidence: 'high' };

  // 4. Explicit UA product token.
  const fromUa = recognizedUaPlatform(headers);
  if (fromUa) return { platform: fromUa, source: 'user_agent', confidence: 'medium' };

  // 5. Unknown / missing / ambiguous -> unknown + legacy default profile.
  return { platform: PLATFORM_UNKNOWN, source: 'default', confidence: 'low' };
}

/**
 * Pure client-platform detector.
 *
 * @param {{
 *   headers?: object,
 *   body?: object,
 *   oauthClientId?: string,
 *   oauthClientMap?: Record<string,string>,
 *   env?: object,
 * }} [input]
 * @returns {{
 *   platform: 'gemini'|'chatgpt'|'claude'|'unknown',
 *   profile: 'gemini-text-json'|'chatgpt-structured'|'claude-text',
 *   source: 'profile_header'|'client_info'|'oauth_client_id'|'user_agent'|'default',
 *   confidence: 'high'|'medium'|'low',
 * }}
 */
export function detectClientPlatform(input = {}) {
  const { platform, source, confidence } = resolvePlatform(input);
  return {
    platform,
    profile: PLATFORM_PROFILES[platform] ?? PROFILE_GEMINI_TEXT_JSON,
    source,
    confidence,
  };
}

/** Exported for tests/observability: the frozen platform -> profile map. */
export const CLIENT_PLATFORM_PROFILES = PLATFORM_PROFILES;

/** Exported for tests: the frozen set of client profiles we defer to. */
export const DELEGATED_CLIENT_PROFILES = CLIENT_PROFILES;
