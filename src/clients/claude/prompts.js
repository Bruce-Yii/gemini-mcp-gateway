/**
 * Claude prompt catalog for Code Mode.
 *
 * OWNERSHIP: this file is the ONLY place Claude's tool-description wording
 * lives. Editing it must never affect Gemini or ChatGPT (see
 * `src/clients/<other>/prompts.js` and the rule-A module-boundary audit).
 *
 * The objective upstream/sandbox contract text (result shapes, helper list,
 * truncation rules, boundary line) is NOT owned here: codemode.js injects it as
 * `context.guidance.*` so every platform describes the same real behaviour.
 * This module only owns the client-facing phrasing and its ordering.
 *
 * Claude facts encoded here: text output (no `structuredContent`) plus the
 * historical tool `annotations`, full descriptions by default, list-mode search results carry a bounded
 * (compacted) description while `select:<name>` returns the full one.
 */

const SEARCH_FULL = 'Search upstream tools. Two modes: (1) Plain keywords -> a ranked list of matching tools with compact param signatures (name!: required). (2) To see one tool\'s full inputSchema, pass EXACTLY "select:<name>" where <name> is a tool name copied from a search result (e.g. "select:github__issue_write"). Do NOT put task descriptions or phrases after "select:" — only an exact tool name works; for anything else use plain keyword search. Prefix a service name (e.g. "vercel ...") to focus on that service.';

const SEARCH_COMPACT = 'Search upstream tools. Plain keywords return ranked matches; "select:<exact_tool_name>" returns one tool\'s full inputSchema.';

const EXECUTE_READ_FULL = 'Write JavaScript to call READ-ONLY upstream tools (get/list/search/query) via codemode.<tool>(args). This tool is annotated read-only so the client may prompt less; it runs the same sandbox as execute(). Only your return value enters the conversation. Available read-only helpers: safeAll(tasks), unwrapBatch(x), unwrap(x), readFileRange(), waitForPrChecks(), github_actions_*. Example: async () => { const r = await codemode.github__search_repositories({query:"x"}); return r.total_count; }';

const EXECUTE_FULL = 'Write JavaScript to call upstream tools via codemode.<tool>(args). Only your returned value enters the conversation — process large results inside code and return a summary. Available: codemode.listTools(), codemode.search(q), codemode.remainingCalls(), codemode.services(), safeAll(tasks), unwrapBatch(x), unwrap(x), global search(), TextEncoder/atob/URL/crypto, and one method per upstream tool. Example: async () => { const r = await codemode.github__search_repositories({query:"x"}); return r.total_count; }';

const EXECUTE_READ_COMPACT = 'Run READ-ONLY JavaScript via codemode.<tool>(args); return only what the model needs. Example: async () => (await codemode.github__search_repositories({query:"x"})).total_count';

const EXECUTE_COMPACT = 'Run JavaScript calling upstream tools via codemode.<tool>(args); process large results inside code and return only a summary. Example: async () => (await codemode.github__search_repositories({query:"x"})).total_count';

/** Assemble the full execute guidance chain in its historical order. */
function executeGuidance(context) {
  const g = context?.guidance ?? {};
  return String(g.returnShape ?? '')
    + String(g.services ?? '')
    + String(g.async ?? '')
    + String(g.actions ?? '')
    + String(g.ghHighFreq ?? '')
    + String(g.linearContext ?? '')
    + String(g.b15 ?? '')
    + String(g.b17 ?? '')
    + String(context?.servicesSuffix ?? '')
    + String(g.execBoundary ?? '');
}

const suffix = (context) => String(context?.servicesSuffix ?? '');
const callNameGuidance = (context) => String(context?.guidance?.callName ?? '');
const execBoundary = (context) => String(context?.guidance?.execBoundary ?? '');

/** Full (historical default) descriptions, byte-identical to the pre-split text. */
export const fullDescriptions = Object.freeze({
  search: (context) => SEARCH_FULL + callNameGuidance(context) + suffix(context),
  execute_read: (context) => EXECUTE_READ_FULL + executeGuidance(context),
  execute: (context) => EXECUTE_FULL + executeGuidance(context),
});

/** Compact descriptions (only used when a profile opts into descriptionMode compact). */
export const compactDescriptions = Object.freeze({
  search: (context) => SEARCH_COMPACT + callNameGuidance(context) + suffix(context),
  execute_read: (context) => EXECUTE_READ_COMPACT + suffix(context) + execBoundary(context),
  execute: (context) => EXECUTE_COMPACT + suffix(context) + execBoundary(context),
});

export default { fullDescriptions, compactDescriptions };
