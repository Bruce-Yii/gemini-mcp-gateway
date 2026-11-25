/**
 * ChatGPT client adapter.
 *
 * ChatGPT consumes BOTH `structuredContent` and the text JSON block, so this
 * platform owns a structured-content encoder. It lives here — not in
 * `_base`/`client-profile` — so a ChatGPT-specific encoding tweak can never
 * change the Gemini or Claude wire shape (rule A boundary audit enforces the
 * physical separation; tests pin byte-level parity with the historical
 * `client-profile.encodeModelOutput` / `encodeToolResult` defaults).
 *
 * Descriptions / budget / search policy are declared here and served from this
 * directory's own prompts.js.
 */
import {
  DEFAULT_OUTPUT_BUDGET_CHARS,
  WIRE_STRUCTURED_CONTENT,
  createClientAdapter,
} from '../_base/index.js';
import { compactDescriptions, fullDescriptions } from './prompts.js';

export const CHATGPT_CLIENT_ID = 'chatgpt';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Best-effort derivation of structured content from a single text JSON block.
 * A plain string/number is NOT treated as structured JSON (historical rule).
 */
function deriveStructuredContent(content) {
  if (!Array.isArray(content)) return undefined;
  const texts = content
    .filter((item) => item && item.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text);
  if (texts.length !== 1) return undefined;
  try {
    const parsed = JSON.parse(texts[0]);
    if (parsed !== null && typeof parsed === 'object') return parsed;
  } catch {
    /* not JSON: leave structuredContent absent */
  }
  return undefined;
}

/**
 * MCP tool-result encoding: keep/derive `structuredContent` next to the text
 * JSON block. Identical semantics to the historical
 * `encodeToolResult(result, CLIENT_PROFILES.chatgpt)`.
 */
export function encodeChatgptToolResult(result) {
  if (!isPlainObject(result)) return result;
  const { structuredContent, ...rest } = result;
  let sc = structuredContent;
  if (sc === undefined) sc = deriveStructuredContent(result.content);
  if (sc === undefined) return { ...rest };
  return { ...rest, structuredContent: sc };
}

/**
 * Code Mode model-output encoding: add `structuredContent` derived from the
 * projected `result` (object/array, or a JSON string that parses to one).
 * Identical semantics to the historical `encodeModelOutput(output, chatgpt)`.
 */
export function encodeChatgptModelOutput(output) {
  if (!isPlainObject(output)) return output;
  const { structuredContent, ...rest } = output;
  let sc = structuredContent;
  if (sc === undefined) {
    const candidate = rest.result;
    if (candidate !== null && typeof candidate === 'object') sc = candidate;
    else if (typeof candidate === 'string') {
      try {
        const parsed = JSON.parse(candidate);
        if (parsed !== null && typeof parsed === 'object') sc = parsed;
      } catch {
        /* not JSON: leave structuredContent absent */
      }
    }
  }
  if (sc === undefined) return { ...rest };
  return { ...rest, structuredContent: sc };
}

export const chatgptAdapter = createClientAdapter({
  id: CHATGPT_CLIENT_ID,
  // ChatGPT is the only platform that receives structuredContent by default.
  wireEncoding: WIRE_STRUCTURED_CONTENT,
  descriptionMode: 'full',
  outputBudgetChars: DEFAULT_OUTPUT_BUDGET_CHARS,
  prompts: { full: fullDescriptions, compact: compactDescriptions },
  search: {
    defaultLimit: 8,
    compactListDescriptions: true,
  },
  encodeModelOutput: encodeChatgptModelOutput,
  encodeToolResult: encodeChatgptToolResult,
});

export default chatgptAdapter;
