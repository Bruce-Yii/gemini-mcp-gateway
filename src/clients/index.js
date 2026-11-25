/**
 * Client adapter router — the ONLY place the gateway decides which physical
 * client adapter (`src/clients/gemini|chatgpt|claude`) serves a request.
 *
 * Resolution is reused verbatim from the existing client layers, so runtime
 * behaviour cannot drift from the captured `clientPlatform` label:
 *   - `src/client/client-profile.js#resolveClientProfile` — the single source of
 *     truth for explicit signals: `x-gateway-client-profile` header,
 *     `clientInfo.name`, exact `CLIENT_PLATFORM_OAUTH_MAP` OAuth client-id
 *     match, explicit UA product token, and explicit env opt-ins;
 *   - `src/client/client-platform.js#detectClientPlatform` — the observability
 *     label (gemini | chatgpt | claude | unknown) exposed on the resolution
 *     record for capture/tests.
 * Unknown/ambiguous input falls back to Gemini, the historical default.
 *
 * Boundary contract (enforced by `scripts/check-module-boundaries.mjs`):
 *   - `src/execution/**`, `src/upstream/**`, `src/evidence/**` may import THIS
 *     router or `src/clients/_base/**`, but never `src/clients/<platform>/**`.
 *   - a platform directory may import `_base`, never another platform.
 */

import { resolveClientProfile } from '../client/client-profile.js';
import { detectClientPlatform } from '../client/client-platform.js';
import { CLIENT_PLATFORMS, isClientAdapter, tuneClientAdapter } from './_base/index.js';
import { geminiAdapter } from './gemini/index.js';
import { chatgptAdapter } from './chatgpt/index.js';
import { claudeAdapter } from './claude/index.js';

/** Frozen platform -> stock adapter map. `gemini` is the unknown fallback. */
export const CLIENT_ADAPTERS = Object.freeze({
  gemini: geminiAdapter,
  chatgpt: chatgptAdapter,
  claude: claudeAdapter,
});

/** The documented fallback platform id (historical default). */
export const FALLBACK_CLIENT_ID = 'gemini';

/**
 * Map a profile id (or a resolved profile object) to a known platform id.
 * Only the three exact platform ids count; anything else -> gemini.
 */
export function platformIdOf(profile) {
  const raw = typeof profile === 'string' ? profile : profile?.id;
  return Object.prototype.hasOwnProperty.call(CLIENT_ADAPTERS, raw) ? raw : FALLBACK_CLIENT_ID;
}

/** Stock adapter for a platform id / profile object (no profile tuning). */
export function stockClientAdapter(profileOrId) {
  return CLIENT_ADAPTERS[platformIdOf(profileOrId)];
}

/**
 * Resolve the per-request client adapter.
 *
 * @param {{
 *   profile?: object,           // already-resolved profile (server.js passes it)
 *   headers?: object,
 *   body?: object,
 *   oauthClientId?: string,
 *   oauthClientMap?: Record<string,string>,
 *   env?: object,
 * }} [input]
 * @returns {object} frozen adapter, tuned with the resolved profile's
 *   descriptionMode / outputBudgetChars / annotation overrides.
 */
export function resolveClientAdapter(input = {}) {
  const source = input ?? {};
  const profile = source.profile ?? resolveClientProfile({
    headers: source.headers,
    body: source.body,
    oauthClientId: source.oauthClientId,
    oauthClientMap: source.oauthClientMap,
    env: source.env,
  });
  return tuneClientAdapter(stockClientAdapter(profile), profile);
}

/**
 * Full resolution record: the adapter plus the existing observability label
 * (`detectClientPlatform`) and the profile that drove the choice. Used by tests
 * and capture/eval code; the adapter is what the runtime consumes.
 */
export function describeClientResolution(input = {}) {
  const source = input ?? {};
  const profile = source.profile ?? resolveClientProfile({
    headers: source.headers,
    body: source.body,
    oauthClientId: source.oauthClientId,
    oauthClientMap: source.oauthClientMap,
    env: source.env,
  });
  const detected = detectClientPlatform({
    headers: source.headers,
    body: source.body,
    oauthClientId: source.oauthClientId,
    oauthClientMap: source.oauthClientMap,
    env: source.env,
  });
  const adapter = tuneClientAdapter(stockClientAdapter(profile), profile);
  return {
    adapter,
    adapterId: adapter.id,
    profile,
    platform: detected.platform,
    profileLabel: detected.profile,
    source: detected.source,
    confidence: detected.confidence,
  };
}

/** True when the value is a client adapter produced by `_base`. */
export { isClientAdapter };
export { CLIENT_PLATFORMS };

// Shared contract + assembler re-exports: objective modules (execution /
// runtime) import these from the router so rule B can stay strict.
export {
  assembleToolDefinitions,
  applyClientToTools,
  defaultDescribeTool,
  defaultEncodeModelOutput,
  defaultEncodeToolResult,
  describeTools,
  resolveAnnotations,
  resolveOutputBudget,
  tuneClientAdapter,
  CLIENT_ADAPTER_MARKER,
  CLIENT_TOOL_NAMES,
  DEFAULT_OUTPUT_BUDGET_CHARS,
  DEFAULT_SEARCH_POLICY,
  DESCRIPTION_MODE_COMPACT,
  DESCRIPTION_MODE_FULL,
  WIRE_STRUCTURED_CONTENT,
  WIRE_TEXT_JSON,
} from './_base/index.js';
