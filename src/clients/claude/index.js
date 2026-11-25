/**
 * Claude client adapter.
 *
 * Claude consumes the text result plus the tool `annotations` the gateway has
 * always advertised; `structuredContent` is intentionally NOT sent. This is the
 * historical default (identical to Gemini's wire text) but it is declared and
 * owned here independently, so Gemini/ChatGPT tuning cannot move Claude's face.
 *
 * Claude-specific behaviour is otherwise inherited from the shared base
 * contract (text-JSON encoding, 20000-character execute budget, full tool
 * descriptions, compact list-mode search descriptions).
 */
import {
  DEFAULT_OUTPUT_BUDGET_CHARS,
  WIRE_TEXT_JSON,
  createClientAdapter,
} from '../_base/index.js';
import { compactDescriptions, fullDescriptions } from './prompts.js';

export const CLAUDE_CLIENT_ID = 'claude';

export const claudeAdapter = createClientAdapter({
  id: CLAUDE_CLIENT_ID,
  // Text result + annotations; structuredContent is disabled by default.
  wireEncoding: WIRE_TEXT_JSON,
  descriptionMode: 'full',
  outputBudgetChars: DEFAULT_OUTPUT_BUDGET_CHARS,
  prompts: { full: fullDescriptions, compact: compactDescriptions },
  search: {
    defaultLimit: 8,
    compactListDescriptions: true,
  },
  // encodeModelOutput / encodeToolResult intentionally omitted: the base
  // text-JSON encoders ARE Claude's encoding strategy.
});

export default claudeAdapter;
