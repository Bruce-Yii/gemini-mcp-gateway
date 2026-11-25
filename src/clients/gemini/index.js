/**
 * Gemini client adapter.
 *
 * Gemini is the historical default: text-JSON output with NO `structuredContent`,
 * the full tool descriptions, the historical 20000-character execute budget, and
 * compact list-mode search descriptions (select:<name> keeps the full text).
 *
 * The encoding/budget/description defaults are inherited from
 * `src/clients/_base/index.js` (text JSON); this file declares that this client
 * WANTS them, so a change to another platform can never move Gemini's defaults.
 */
import {
  DEFAULT_OUTPUT_BUDGET_CHARS,
  WIRE_TEXT_JSON,
  createClientAdapter,
} from '../_base/index.js';
import { compactDescriptions, fullDescriptions } from './prompts.js';

export const GEMINI_CLIENT_ID = 'gemini';

export const geminiAdapter = createClientAdapter({
  id: GEMINI_CLIENT_ID,
  // Gemini does not consume `structuredContent`: text JSON only.
  wireEncoding: WIRE_TEXT_JSON,
  // Historical default descriptions remain the full text.
  descriptionMode: 'full',
  // Historical execute-result cap; a profile may tune it per request.
  outputBudgetChars: DEFAULT_OUTPUT_BUDGET_CHARS,
  prompts: { full: fullDescriptions, compact: compactDescriptions },
  search: {
    // Historical `limit = args.limit ?? 8`.
    defaultLimit: 8,
    // List-mode hits keep their bounded description; `select:` stays full.
    compactListDescriptions: true,
  },
  // encodeModelOutput / encodeToolResult intentionally omitted: the base
  // text-JSON encoders ARE Gemini's encoding strategy.
});

export default geminiAdapter;
