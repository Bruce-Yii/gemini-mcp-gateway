/**
 * Batch 11 — project/repository as a first-class derived capture tag.
 *
 * Problem: MCP session boundaries are unreliable for "which project was this
 * request about?" — a Gemini window may be resumed across sessions, and one
 * session may touch several repos. Deriving a stable `github:<owner>/<repo>`
 * tag from the REQUEST (never from upstream results or prose) lets later
 * windows on the same project be joined without trusting sessionId.
 *
 * Hard rules (mirror AGENTS.md):
 *   - pure function: no model, no network, no upstream-result parsing;
 *   - owner/repo must come from explicit fields, code literals, or a PR URL;
 *   - never guess a repo from natural-language text;
 *   - no repo found -> empty projects / primaryProject = null (no fabrication);
 *   - deterministic: same input -> same output, in input order.
 *
 * Accepted inputs:
 *   - a request-like object with `__gatewayRawBody` (string or parsed body),
 *   - a JSON string (MCP JSON-RPC body),
 *   - an already-parsed JSON-RPC body object.
 */

const SERVER = 'github';
const CONFIDENCE_BY_SOURCE = {
  'tool-args': 'high',
  'code-literal': 'medium',
  'pr-url': 'medium',
};
const SOURCE_PRIORITY = {
  'tool-args': 0,
  'code-literal': 1,
  'pr-url': 2,
};

/** Only conservative owner/repo identifiers: GitHub-style, no spaces or quotes. */
const IDENT = /^[A-Za-z0-9_.-]+$/;

function validIdent(value) {
  return typeof value === 'string' && value.length > 0
    && value.length <= 100 && IDENT.test(value) && value !== '.' && value !== '..';
}

function normalizeInput(request) {
  if (typeof request === 'string') return { text: request, parsed: null };
  if (!request || typeof request !== 'object') return { text: null, parsed: null };
  const raw = request.__gatewayRawBody;
  if (typeof raw === 'string') return { text: raw, parsed: null };
  if (raw && typeof raw === 'object') return { text: null, parsed: raw };
  // Also accept a bare JSON-RPC body object passed directly.
  if (typeof request.method === 'string' || request.jsonrpc !== undefined) {
    return { text: null, parsed: request };
  }
  return { text: null, parsed: null };
}

function parseBody(normalized) {
  if (normalized.parsed) return normalized.parsed;
  if (typeof normalized.text !== 'string' || normalized.text.length === 0) return null;
  try {
    const body = JSON.parse(normalized.text);
    return body && typeof body === 'object' ? body : null;
  } catch {
    return null;
  }
}

/** `params.name` like `github__get_file_contents` -> 'github'; gateway tools -> null. */
function serverFromToolName(name) {
  if (typeof name !== 'string' || !name.includes('__')) return null;
  const prefix = name.slice(0, name.indexOf('__')).toLowerCase();
  return SERVER === prefix ? SERVER : null;
}

/** Stringify a code value only when it is genuinely code text (not arbitrary prose). */
function codeStrings(value, out = []) {
  if (typeof value === 'string') {
    if (value.length <= 1_000_000) out.push(value);
    return out;
  }
  if (!value || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const item of value) codeStrings(item, out);
    return out;
  }
  // Only look at fields that plausibly carry guest code. This avoids treating
  // arbitrary tool-result-like objects in arguments as code.
  for (const key of ['code', 'script', 'source']) {
    if (typeof value[key] === 'string') out.push(value[key]);
  }
  if (value.input && typeof value.input === 'object') codeStrings(value.input, out);
  return out;
}

/**
 * Extract explicit `owner:` / `repo:` keyed literals from code.
 * Requires BOTH keys in the same code string: a lone `repo:` without `owner:`
 * is ambiguous and is deliberately dropped.
 *
 * Supports double quotes, single quotes and backticks. Values must be plain
 * GitHub identifiers. A code string may contain multiple owner/repo pairs; all
 * are returned in appearance order.
 */
function extractKeyedPairs(code) {
  const results = [];
  const re = /\b(owner|repo)\s*[:=]\s*(['"`])([A-Za-z0-9_.-]{1,100})\2/g;
  let match;
  while ((match = re.exec(code)) !== null) {
    const value = match[3];
    if (!validIdent(value) || value === '.' || value === '..') continue;
    results.push({ field: match[1], value, index: match.index });
  }
  // Pair each repo with the closest preceding owner (or the next owner if the
  // code writes `repo:` first). Never pair across a different repo occurrence.
  const repos = results.filter((r) => r.field === 'repo');
  const owners = results.filter((r) => r.field === 'owner');
  const pairs = [];
  for (const ownerOwner of owners) {
    const repo = repos
      .filter((r) => r.index > ownerOwner.index)
      .sort((a, b) => a.index - b.index)[0]
      ?? repos.filter((r) => r.index < ownerOwner.index).sort((a, b) => b.index - a.index)[0];
    if (repo) pairs.push({ owner: ownerOwner.value, repo: repo.value });
  }
  return pairs;
}

/** `https://github.com/<owner>/<repo>/pull/<n>` (also bare `github.com/...`). */
function extractPrUrls(code) {
  const out = [];
  const re = /(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})\/pull\/\d+/g;
  let match;
  while ((match = re.exec(code)) !== null) {
    if (validIdent(match[1]) && validIdent(match[2])) {
      out.push({ owner: match[1], repo: match[2] });
    }
  }
  return out;
}

function makeTag({ owner, repo, server, source }) {
  return {
    server,
    owner,
    repo,
    key: `${SERVER}:${owner}/${repo}`,
    confidence: CONFIDENCE_BY_SOURCE[source] ?? 'medium',
    source,
  };
}

function tagKey(tag) {
  return tag.key;
}

/**
 * Pure extraction of project tags from an MCP JSON-RPC request body.
 *
 * @param {any} request request object / raw JSON string / parsed body
 * @returns {{ projects: Array<{server:string|null,owner:string,repo:string,key:string,confidence:string,source:string}>,
 *            primaryProject: object|null }}
 */
export function extractProjects(request) {
  const normalized = normalizeInput(request);
  const body = parseBody(normalized);
  if (!body) return { projects: [], primaryProject: null };

  const method = typeof body.method === 'string' ? body.method : null;
  const params = body.params && typeof body.params === 'object' ? body.params : null;
  if (method !== 'tools/call' || !params) return { projects: [], primaryProject: null };

  const toolName = typeof params.name === 'string' ? params.name : null;
  const fromToolName = serverFromToolName(toolName);
  const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : null;
  const collected = [];

  // 1. Highest confidence: explicit owner/repo in tool-call arguments.
  if (args && validIdent(args.owner) && validIdent(args.repo)) {
    collected.push(makeTag({
      owner: args.owner,
      repo: args.repo,
      server: fromToolName ?? SERVER,
      source: 'tool-args',
    }));
  }

  // 2. Code strings: keyed literals and PR URLs. Only inspect tool arguments
  //    (guest code lives in params.arguments.code for gateway tools).
  if (args) {
    for (const code of codeStrings(args)) {
      const server = fromToolName ?? (/github__[A-Za-z0-9_]+\s*\(/.test(code) ? SERVER : null);
      for (const pair of extractKeyedPairs(code)) {
        collected.push(makeTag({ ...pair, server, source: 'code-literal' }));
      }
      for (const pair of extractPrUrls(code)) {
        // A github.com/<owner>/<repo>/pull/<n> URL is itself explicit evidence
        // of the server; no need to rely on the tool name.
        collected.push(makeTag({ ...pair, server: SERVER, source: 'pr-url' }));
      }
    }
  }

  if (collected.length === 0) return { projects: [], primaryProject: null };

  // Deduplicate by key, counting occurrences for primary selection. Keep the
  // first occurrence's metadata; prefer an explicit tool-args occurrence when
  // the same key also appears only in code (tool params always win).
  const byKey = new Map();
  for (const tag of collected) {
    const existing = byKey.get(tagKey(tag));
    if (!existing) {
      byKey.set(tagKey(tag), {
        tag,
        count: 1,
        explicitCount: tag.source === 'tool-args' ? 1 : 0,
      });
      continue;
    }
    existing.count += 1;
    if (tag.source === 'tool-args') existing.explicitCount += 1;
    if (SOURCE_PRIORITY[tag.source] < SOURCE_PRIORITY[existing.tag.source]) {
      existing.tag = tag;
    }
  }

  const entries = [...byKey.values()];
  const projects = entries.map((entry) => entry.tag);

  // Primary selection:
  //   1. among explicit (tool-args) tags, pick the one seen most often in
  //      explicit arguments; ties fall back to appearance order;
  //   2. no explicit tag -> first explicit-style code pair (keyed literals come
  //      before PR URLs by SOURCE_PRIORITY);
  //   3. nothing explicit at all -> first collected tag.
  // "Tool params first" also means explicit tags are always preferred over
  // code-derived ones for primary, regardless of raw occurrence counts.
  const explicitEntries = entries.filter((entry) => entry.tag.source === 'tool-args');
  let primary;
  if (explicitEntries.length > 0) {
    primary = [...explicitEntries]
      .sort((a, b) => b.explicitCount - a.explicitCount)[0].tag;
  } else {
    primary = [...entries]
      .sort((a, b) => SOURCE_PRIORITY[a.tag.source] - SOURCE_PRIORITY[b.tag.source])[0].tag;
  }

  return { projects, primaryProject: primary ?? null };
}

export default extractProjects;
