#!/usr/bin/env node
/**
 * Host-side GitHub idempotency / pagination / repo-search primitives (B10 P1).
 *
 * Pure module: every I/O operation is supplied by the caller as an injected
 * callback. No imports from codemode.js / upstreams.js, no network, no new
 * dependencies. Safe to unit-test with fakes.
 *
 * Design rules:
 *  - Callbacks are awaited (sync or async fakes both work).
 *  - Errors thrown by callbacks are NEVER swallowed — they propagate.
 *    The only intentional exception is repoGrep's per-file read failure,
 *    which is recorded in `errors` so one unreadable file does not kill a
 *    whole repo search.
 *  - Result shapes are normalized defensively because GitHub MCP tools may
 *    return arrays, {items}, {data}, {result}, or MCP text content.
 */

/** Unwrap common list-response shapes into a plain array. */
function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') {
    for (const key of ['items', 'data', 'result', 'branches', 'values']) {
      if (Array.isArray(value[key])) return value[key];
    }
    // MCP-style text content: [{type:'text', text:'[...]'}] / {content:[...]}
    const content = Array.isArray(value.content) ? value.content : null;
    if (content) {
      for (const part of content) {
        if (part && typeof part.text === 'string') {
          try {
            const parsed = JSON.parse(part.text);
            const arr = toArray(parsed);
            if (arr.length) return arr;
          } catch (_) {
            // Not JSON text — not a list payload; keep looking.
          }
        }
      }
    }
  }
  return [];
}

function requireFn(fn, name) {
  if (typeof fn !== 'function') throw new TypeError(`${name} must be a function`);
  return fn;
}

/**
 * Ensure a branch exists, idempotently.
 *
 * @param {object}   opts
 * @param {Function} opts.listBranches  () => branches (array or wrapped)
 * @param {Function} opts.createBranch  ({name, fromSha}) => branch
 * @param {Function} [opts.deleteBranch] ({name}) => void — required for reset
 * @param {string}   [opts.name]        branch name (alias: `branch`, `branchName`)
 * @param {string}   [opts.branch]      branch name alias used by GitHub tools
 * @param {string}   [opts.branchName]  branch name alias
 * @param {string}   opts.fromSha       base commit sha for creation/reset
 * @param {'reuse'|'reset'} [opts.ifExists='reuse']
 * @returns {Promise<{created:boolean,reused:boolean,reset:boolean,branch:any}>}
 */
export async function ensureBranch({
  listBranches,
  createBranch,
  deleteBranch,
  name,
  branch,
  branchName,
  fromSha,
  ifExists = 'reuse',
} = {}) {
  requireFn(listBranches, 'listBranches');
  requireFn(createBranch, 'createBranch');
  // Real GitHub tools use `branch`; older callers used `name`/`branchName`.
  // Normalize all aliases to one canonical name before any work, so the error
  // message stays actionable whichever spelling the caller used.
  const resolvedName = name ?? branch ?? branchName;
  if (!resolvedName || typeof resolvedName !== 'string') {
    throw new TypeError('ensureBranch: branch name is required (pass name, branch or branchName)');
  }
  if (ifExists !== 'reuse' && ifExists !== 'reset') {
    throw new TypeError("ifExists must be 'reuse' or 'reset'");
  }

  const branches = toArray(await listBranches());
  const found = branches.find((b) => {
    if (typeof b === 'string') return b === resolvedName;
    if (!b || typeof b !== 'object') return false;
    return b.name === resolvedName || b.ref === resolvedName || (typeof b.ref === 'string' && b.ref.endsWith(`/${resolvedName}`));
  });

  if (found !== undefined) {
    if (ifExists === 'reuse') {
      return { created: false, reused: true, reset: false, branch: found };
    }
    // reset: delete then recreate. Deletion is optional by design — without
    // a deleteBranch callback we must fail loudly rather than silently reuse.
    if (typeof deleteBranch !== 'function') {
      throw new Error('ensureBranch: ifExists="reset" requires a deleteBranch callback (unsupported)');
    }
    await deleteBranch({ name: resolvedName, branch: found });
    const created = await createBranch({ name: resolvedName, fromSha });
    return { created: true, reused: false, reset: true, branch: created ?? found };
  }

  const created = await createBranch({ name: resolvedName, fromSha });
  return { created: true, reused: false, reset: false, branch: created };
}

/** Extract head/base identifiers from a PR-like object. */
function prHead(pr) {
  if (!pr || typeof pr !== 'object') return undefined;
  if (typeof pr.head === 'string') return pr.head;
  if (pr.head && typeof pr.head === 'object') return pr.head.ref ?? pr.head.sha ?? pr.head.label;
  return pr.head_ref ?? pr.headRef ?? pr.sourceBranch ?? pr.ref;
}

function prBase(pr) {
  if (!pr || typeof pr !== 'object') return undefined;
  if (typeof pr.base === 'string') return pr.base;
  if (pr.base && typeof pr.base === 'object') return pr.base.ref ?? pr.base.sha ?? pr.base.label;
  return pr.base_ref ?? pr.baseRef ?? pr.targetBranch;
}

/**
 * Find an open PR for the same head/base, then update or create it.
 *
 * @param {object}   opts
 * @param {Function} opts.listPrs   ({head, base, state?}) => PRs (array or wrapped)
 * @param {Function} opts.createPr  ({head, base, title, body}) => PR
 * @param {Function} [opts.updatePr] ({number, title, body}) => PR
 * @param {string}   opts.head      head ref (or {ref} object)
 * @param {string}   opts.base      base ref
 * @param {string}   opts.title
 * @param {string}   [opts.body]
 * @param {string}   [opts.state='open']
 * @returns {Promise<{created:boolean,updated:boolean,reused:boolean,pr:any}>}
 */
export async function upsertPr({
  listPrs,
  createPr,
  updatePr,
  head,
  base,
  title,
  body,
  state = 'open',
} = {}) {
  requireFn(listPrs, 'listPrs');
  requireFn(createPr, 'createPr');
  if (!head || !base) throw new TypeError('head and base are required');

  const headRef = typeof head === 'object' ? (head.ref ?? head.sha ?? head.label) : head;
  const baseRef = typeof base === 'object' ? (base.ref ?? base.sha ?? base.label) : base;
  const existing = toArray(await listPrs({ head: headRef, base: baseRef, state })).find((pr) => {
    if (!pr || typeof pr !== 'object') return false;
    const st = (pr.state ?? 'open').toLowerCase();
    return st === 'open' && prHead(pr) === headRef && prBase(pr) === baseRef;
  });

  if (existing) {
    if (typeof updatePr === 'function') {
      const updated = await updatePr({
        number: existing.number,
        head: headRef,
        base: baseRef,
        title,
        body,
        pr: existing,
      });
      return { created: false, updated: true, reused: false, pr: updated ?? existing };
    }
    // No update callback: reuse as-is (explicit flag, not a silent no-op).
    return { created: false, updated: false, reused: true, pr: existing };
  }

  const pr = await createPr({ head: headRef, base: baseRef, title, body });
  return { created: true, updated: false, reused: false, pr };
}

/**
 * Iterate a cursor-paginated fetcher until exhaustion or maxPages.
 *
 * Accepts page shapes: {items,nextCursor} | {items,next} | {data,next}.
 * Items are de-duplicated by identity (stable JSON key) — repeated pages do
 * not duplicate items. An empty page stops iteration. Reaching maxPages sets
 * truncated:true (even if the final page happened to be the last one — the
 * caller can raise maxPages to confirm). Callback errors propagate.
 *
 * @param {object}   opts
 * @param {Function} opts.fetchPage  (cursor) => page
 * @param {number}   [opts.maxPages=20]
 * @param {string}   [opts.cursorKey='cursor'] key passed in fetchPage argument
 * @returns {Promise<{items:any[],pages:number,nextCursor:any,truncated:boolean}>}
 */
export async function fetchAllPages({ fetchPage, maxPages = 20, cursorKey = 'cursor' } = {}) {
  requireFn(fetchPage, 'fetchPage');
  if (!Number.isInteger(maxPages) || maxPages < 1) throw new TypeError('maxPages must be a positive integer');

  const items = [];
  const seen = new Set();
  let cursor;
  let pages = 0;

  while (pages < maxPages) {
    const page = await fetchPage(cursor === undefined ? {} : { [cursorKey]: cursor });
    pages += 1;
    if (page == null) return { items, pages, nextCursor: null, truncated: false };

    const pageItems = toArray(page);
    const rawItems = Array.isArray(page) ? page : (page.items ?? page.data ?? toArray(page));
    const list = Array.isArray(rawItems) ? rawItems : pageItems;
    if (list.length === 0) return { items, pages, nextCursor: null, truncated: false };

    for (const item of list) {
      let key;
      try {
        key = JSON.stringify(item) ?? String(item);
      } catch (_) {
        key = String(item);
      }
      if (!seen.has(key)) {
        seen.add(key);
        items.push(item);
      }
    }

    const next = page.nextCursor ?? page.next ?? (page.pageInfo && page.pageInfo.endCursor);
    if (next === undefined || next === null || next === '') {
      return { items, pages, nextCursor: null, truncated: false };
    }
    if (next === cursor) {
      // Cursor did not advance: avoid an infinite loop, treat as exhausted.
      return { items, pages, nextCursor: next, truncated: false };
    }
    cursor = next;
  }

  return { items, pages, nextCursor: cursor ?? null, truncated: true };
}

/**
 * Search files in a repository (repo-level grep) using injected read/list.
 *
 * @param {object}   opts
 * @param {Function} opts.readFile  (path) => string | {text|content}
 * @param {Function} opts.listFiles () => string[] (or wrapped)
 * @param {string|RegExp} opts.pattern
 * @param {string}  [opts.flags='i'] regex flags when pattern is a string
 * @param {number}  [opts.limit=50] max matches returned
 * @returns {Promise<{matches:Array<{file,line,column,text}>,errors:Array<{file,error}>,scanned:number,truncated:boolean}>}
 */
export async function repoGrep({ readFile, listFiles, pattern, flags = 'i', limit = 50 } = {}) {
  requireFn(readFile, 'readFile');
  requireFn(listFiles, 'listFiles');
  if (pattern === undefined || pattern === null || pattern === '') throw new TypeError('pattern is required');

  const baseRegex = pattern instanceof RegExp ? pattern : new RegExp(pattern, flags);
  // exec() only advances lastIndex for global regexes; clone with 'g' so
  // non-global patterns/regexes still iterate all matches on a line.
  const regex = baseRegex.global
    ? baseRegex
    : new RegExp(baseRegex.source, baseRegex.flags.includes('g') ? baseRegex.flags : baseRegex.flags + 'g');
  const files = toArray(await listFiles()).filter((f) => typeof f === 'string');
  const matches = [];
  const errors = [];
  let truncated = false;

  for (const file of files) {
    if (matches.length >= limit) {
      truncated = true;
      break;
    }
    let raw;
    try {
      raw = await readFile(file);
    } catch (err) {
      errors.push({ file, error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    let text = raw;
    if (raw && typeof raw === 'object') text = raw.text ?? raw.content ?? raw.result?.text ?? '';
    if (typeof text !== 'string') text = String(text ?? '');

    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      regex.lastIndex = 0;
      let m;
      while ((m = regex.exec(lines[i])) !== null) {
        matches.push({
          file,
          line: i + 1,
          column: m.index + 1,
          text: lines[i],
        });
        if (m[0] === '') regex.lastIndex += 1; // guard zero-width matches
        if (matches.length >= limit) {
          truncated = true;
          break;
        }
      }
      if (matches.length >= limit) break;
    }
  }

  return { matches, errors, scanned: errors.length ? files.length - errors.length : files.length, truncated };
}

// ---------------------------------------------------------------------------
// PR #41–#48 incremental suggestions (B10 follow-up): unified write semantics.
// ---------------------------------------------------------------------------

/**
 * Idempotent branch creation at the push/commit entry point.
 *
 * Thin, opinionated wrapper over `ensureBranch`: reading a missing branch from
 * `base` (a branch name or a commit sha) and reusing an existing one is the
 * default; resetting an existing branch is an EXPLICIT opt-in
 * (`ifExists:'reset'`) and requires `deleteBranch`. No callback errors are
 * swallowed — see `ensureBranch`.
 *
 * @param {object}   opts
 * @param {Function} opts.listBranches
 * @param {Function} opts.createBranch
 * @param {Function} [opts.deleteBranch] required only for reset
 * @param {string}   [opts.name]          branch to ensure
 * @param {string}   [opts.branch]        branch to ensure (GitHub tool spelling)
 * @param {string}   [opts.branchName]    branch to ensure (alias)
 * @param {string}   opts.base            base ref / commit sha to create from
 * @param {'reuse'|'reset'} [opts.ifExists='reuse']
 * @returns {Promise<{created:boolean,reused:boolean,reset:boolean,branch:any}>}
 */
export async function createBranchIfMissing({ listBranches, createBranch, deleteBranch, name, branch, branchName, base, ifExists = 'reuse' } = {}) {
  return ensureBranch({
    listBranches,
    createBranch,
    deleteBranch,
    name,
    branch,
    branchName,
    // ensureBranch calls its callback with {name, fromSha}; callers that use
    // this helper directly see `base` mapped to `fromSha` for compatibility.
    fromSha: base,
    ifExists,
  });
}

/** snake_case alias used by the in-sandbox / Python-style call sites. */
export const create_branch_if_missing = createBranchIfMissing;

/** Read a property without letting a hostile getter throw. */
function safeGet(obj, key) {
  try {
    if (obj === null || typeof obj !== 'object') return undefined;
    return obj[key];
  } catch (_) {
    return undefined;
  }
}

function firstDefined(obj, keys) {
  for (const key of keys) {
    const value = safeGet(obj, key);
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function toFiniteNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Best-effort unwrap of the opaque shapes GitHub MCP tools return: JSON text,
 * `{content:[{type:'text',text:'...'}]}`, `{result:{...}}`, or plain objects.
 * Only one layer of `result` and one JSON parse is attempted — no deep magic.
 */
export function unwrapResultPayload(value) {
  let v = value;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch (_) {
      return v;
    }
  }
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const inner = safeGet(v, 'result');
    if (inner && typeof inner === 'object') v = inner;
    const content = safeGet(v, 'content');
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part && typeof part.text === 'string') {
          try {
            const parsed = JSON.parse(part.text);
            if (parsed && typeof parsed === 'object') return parsed;
          } catch (_) {
            // Not JSON text; keep the original envelope.
          }
        }
      }
    }
  }
  return v;
}

/**
 * Canonical `{number, url, sha}` view for PR / Issue / merge / write results.
 *
 * Reuses the result-normalize idea (defensive unwrap + explicit field picking
 * + `raw` preserved) but emits the *minimal, stable* field set requested by the
 * PR #41–#48 feedback. Explicit fields always win; URL extraction is only a
 * last-resort fallback so a number is never guessed when a field is present.
 * Never throws; unknown fields stay available through `raw`.
 *
 * @returns {{number:number|null,url:string|null,sha:string|null,raw:*}}
 */
export function canonicalResult(value) {
  try {
    const v = unwrapResultPayload(value);
    const root = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    // Merge results have no top-level sha sometimes; look one level into
    // head/commit for a sha, mirroring result-normalize's normalizePrResult.
    const head = safeGet(root, 'head');
    const commit = safeGet(root, 'commit');
    // `id` is a database identifier and must NEVER be used as a PR/issue
    // number (real create_pull_request returns {id:5444514334, url:.../pull/53}).
    // URL is authoritative when present; explicit number fields are next.
    const urlRaw = firstDefined(root, ['html_url', 'url', 'web_url']);
    let numberOut = null;
    if (typeof urlRaw === 'string') {
      const m = /\/pulls?\/(\d+)(?:\/|$|\?)|\/issues\/(\d+)(?:\/|$|\?)/.exec(urlRaw);
      const raw = m && (m[1] ?? m[2]);
      if (raw) numberOut = Number(raw);
    }
    if (numberOut === null) {
      numberOut = toFiniteNumber(
        firstDefined(root, ['number', 'prNumber', 'pr_number', 'issueNumber', 'issue_number', 'pullNumber', 'pull_number']),
      );
    }
    const shaRaw = firstDefined(root, ['sha', 'commitSha', 'commit_sha', 'head_sha', 'headSha'])
      ?? firstDefined(head && typeof head === 'object' ? head : {}, ['sha'])
      ?? firstDefined(commit && typeof commit === 'object' ? commit : {}, ['sha']);
    return {
      number: numberOut,
      url: urlRaw !== undefined ? String(urlRaw) : null,
      sha: shaRaw !== undefined && shaRaw !== null ? String(shaRaw) : null,
      raw: value,
    };
  } catch (_) {
    return { number: null, url: null, sha: null, raw: value };
  }
}

// ---------------------------------------------------------------------------
// Batch 11 write transaction: GitHub push_files (one commit, many files).
// ---------------------------------------------------------------------------

/** Canonical tool name for GitHub's one-commit-many-files write. */
export const PUSH_FILES_TOOL = 'github__push_files';

/**
 * Detect whether the atomic `github__push_files` write is reachable.
 *
 * Accepts either a tools array (`[{name:'github__push_files', ...}]`) or a set
 * of exposed callables (`{github__push_files: fn}`). Never throws; missing or
 * malformed inputs simply report `available:false` with an actionable reason.
 *
 * @param {object} opts
 * @param {Array}  [opts.tools] tool descriptors from codemode.listTools()
 * @param {object} [opts.callables] object with tool-name keys
 * @returns {{available:boolean, tool:string, reason:string|null}}
 */
export function detectPushFiles({ tools, callables } = {}) {
  const tool = PUSH_FILES_TOOL;
  const inTools = Array.isArray(tools) && tools.some((t) => {
    if (typeof t === 'string') return t === tool;
    return t && typeof t === 'object' && (t.name === tool || t.tool === `push_files`);
  });
  const inCallables = !!(callables && typeof callables[tool] === 'function');
  if (inTools || inCallables) return { available: true, tool, reason: null };
  return {
    available: false,
    tool,
    reason: 'github__push_files is not available in this tool set; multi-file writes will be non-atomic',
  };
}

/**
 * Build the exact `push_files` argument object from staged files.
 * Schema: {owner, repo, branch, files:[{path,content}], message}
 */
export function buildPushFilesArgs({ owner, repo, branch, message, files, extraArgs } = {}) {
  if (!Array.isArray(files) || files.length === 0) throw new TypeError('files must be a non-empty array');
  return {
    ...(extraArgs && typeof extraArgs === 'object' ? extraArgs : {}),
    owner,
    repo,
    branch,
    files: files.map((f) => ({ path: f.path, content: f.content })),
    message: message === undefined ? 'batch write via codemode' : message,
  };
}

// ---------------------------------------------------------------------------
// Batch 11 · GitHub Actions read-only REST helpers (gateway-side, not MCP tools)
// ---------------------------------------------------------------------------
//
// These are HOST-SIDE helpers that call the GitHub REST API directly with
// `GITHUB_TOKEN`. They are NOT new upstream MCP tools: they are exposed only
// through the Code Mode sandbox prelude/bridge, so the public tool count stays
// at three (search / execute_read / execute). All network I/O is injected via
// `fetch` so tests can supply a fake; no token is ever logged or returned.

const GITHUB_API_BASE = 'https://api.github.com';
const DEFAULT_ACTIONS_TIMEOUT_MS = 15000;
const DEFAULT_ACTIONS_MAX_BYTES = 2 * 1024 * 1024; // 2 MiB of log text by default

/** Build a stable error/result shape without leaking the token. */
function actionsOutcome(ok, status, extra) {
  return { ok, status, ...extra };
}

/** Read the token from an injected env object (defaults to process.env). */
function resolveToken(env) {
  const source = env && typeof env === 'object' ? env : (typeof process !== 'undefined' ? process.env : {});
  const token = source.GITHUB_TOKEN;
  return typeof token === 'string' && token.length > 0 ? token : null;
}

/** Build the auth + accept headers. Token never appears in returned data. */
function actionsHeaders(token, accept) {
  return {
    Accept: accept || 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'gemini-mcp-gateway-actions-helper',
  };
}

/**
 * Perform one bounded GitHub REST GET.
 *
 * @param {object}   opts
 * @param {Function} opts.fetch        injected fetch(url, init) -> Response-like
 * @param {string}   opts.url
 * @param {string}   opts.token
 * @param {string}   [opts.accept]
 * @param {number}   [opts.timeoutMs]
 * @param {number}   [opts.maxBytes]   max response body bytes before truncation
 * @returns {Promise<{ok:boolean,status:number,text:string|null,truncated:boolean,error?:string}>}
 */
async function githubRestGet({ fetch: doFetch, url, token, accept, timeoutMs = DEFAULT_ACTIONS_TIMEOUT_MS, maxBytes = DEFAULT_ACTIONS_MAX_BYTES } = {}) {
  if (typeof doFetch !== 'function') {
    return actionsOutcome(false, 0, { text: null, truncated: false, error: 'github actions helper: fetch is unavailable' });
  }
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    let res = await doFetch(url, {
      method: 'GET',
      headers: actionsHeaders(token, accept),
      ...(controller ? { signal: controller.signal } : {}),
      redirect: 'follow', // job logs commonly 302 to a signed storage URL
    });
    let status = res && typeof res.status === 'number' ? res.status : 0;
    // Fakes (and some runtimes) do not honor redirect:'follow'. Follow a 3xx
    // Location once ourselves; the signed log URL must not carry our token.
    if (status >= 300 && status < 400) {
      const location = res && typeof res.headers?.get === 'function' ? res.headers.get('location') : (res?.headers?.location ?? null);
      if (location && /^https?:\/\//i.test(location)) {
        res = await doFetch(location, {
          method: 'GET',
          headers: { Accept: accept || 'application/octet-stream', 'User-Agent': 'gemini-mcp-gateway-actions-helper' },
          ...(controller ? { signal: controller.signal } : {}),
          redirect: 'follow',
        });
        status = res && typeof res.status === 'number' ? res.status : 0;
      }
    }
    // Read as text so JSON and logs share one path; bound the bytes consumed.
    let text = res && typeof res.text === 'function' ? await res.text() : '';
    if (typeof text !== 'string') text = String(text ?? '');
    let truncated = false;
    if (maxBytes !== null && maxBytes !== undefined && text.length > maxBytes) {
      text = text.slice(0, maxBytes);
      truncated = true;
    }
    if (!res || !res.ok || status < 200 || status >= 300) {
      // Do not include response body verbatim (may contain sensitive URLs).
      return actionsOutcome(false, status, {
        text: null,
        truncated,
        error: `GitHub REST returned HTTP ${status || 'unknown'}${truncated ? ' (response truncated)' : ''}`,
      });
    }
    return actionsOutcome(true, status, { text, truncated });
  } catch (err) {
    const message = err && err.name === 'AbortError'
      ? `GitHub REST request timed out after ${timeoutMs}ms`
      : `GitHub REST request failed: ${err && err.message ? err.message : String(err)}`;
    return actionsOutcome(false, 0, { text: null, truncated: false, error: message });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Parse a bounded JSON text body, returning a stable error shape on failure. */
function parseActionsJson(text, truncated) {
  try {
    return { ok: true, data: JSON.parse(text), truncated };
  } catch (_) {
    return { ok: false, status: 200, data: null, truncated, error: 'GitHub REST returned invalid JSON' };
  }
}

/** Validate an owner/repo pair (GH rejects path injection). */
function validRepo(owner, repo) {
  return typeof owner === 'string' && /^[A-Za-z0-9_.-]+$/.test(owner)
    && typeof repo === 'string' && /^[A-Za-z0-9_.-]+$/.test(repo);
}

function noTokenOutcome() {
  return {
    ok: false,
    status: 0,
    data: null,
    text: null,
    truncated: false,
    error: 'GITHUB_TOKEN is not configured; GitHub Actions helpers are read-only and require a token',
  };
}

/**
 * GET /repos/{owner}/{repo}/actions/runs — list workflow runs (read-only).
 */
export async function githubActionsListWorkflowRuns(opts = {}) {
  const {
    fetch: doFetch,
    env,
    owner,
    repo,
    status,
    branch,
  } = opts;
  // Accept both snake_case (GitHub REST spelling) and camelCase aliases.
  const workflow = pickAlias(opts, 'workflow_id', 'workflowId');
  const size = pickAlias(opts, 'per_page', 'perPage');
  if (!resolveToken(env)) return noTokenOutcome();
  if (!validRepo(owner, repo)) {
    return actionsOutcome(false, 0, { data: null, truncated: false, error: 'owner and repo must be non-empty GitHub identifiers' });
  }
  const params = new URLSearchParams();
  if (workflow !== undefined && workflow !== null) params.set('workflow_id', String(workflow));
  if (status !== undefined && status !== null) params.set('status', String(status));
  if (branch !== undefined && branch !== null) params.set('branch', String(branch));
  if (size !== undefined && size !== null) params.set('per_page', String(size));
  const qs = params.toString();
  const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/actions/runs${qs ? `?${qs}` : ''}`;
  const res = await githubRestGet({ fetch: doFetch, url, token: resolveToken(env), timeoutMs: opts.timeoutMs, maxBytes: opts.maxBytes });
  if (!res.ok) return actionsOutcome(res.ok, res.status, { data: null, text: res.text, truncated: res.truncated, error: res.error });
  const parsed = parseActionsJson(res.text, res.truncated);
  return { ok: parsed.ok, status: res.status, data: parsed.data, text: null, truncated: parsed.truncated, ...(parsed.error ? { error: parsed.error } : {}) };
}

/** Return the first defined alias from an options object. */
function pickAlias(opts, ...keys) {
  for (const key of keys) {
    if (opts[key] !== undefined && opts[key] !== null) return opts[key];
  }
  return undefined;
}

/**
 * GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs — list jobs for a run.
 */
export async function githubActionsListWorkflowJobs(opts = {}) {
  const { fetch: doFetch, env, owner, repo } = opts;
  const id = pickAlias(opts, 'run_id', 'runId');
  if (!resolveToken(env)) return noTokenOutcome();
  if (!validRepo(owner, repo)) {
    return actionsOutcome(false, 0, { data: null, truncated: false, error: 'owner and repo must be non-empty GitHub identifiers' });
  }
  if (id === undefined || id === null || id === '') {
    return actionsOutcome(false, 0, { data: null, truncated: false, error: 'run_id is required' });
  }
  const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/actions/runs/${encodeURIComponent(String(id))}/jobs`;
  const res = await githubRestGet({ fetch: doFetch, url, token: resolveToken(env), timeoutMs: opts.timeoutMs, maxBytes: opts.maxBytes });
  if (!res.ok) return actionsOutcome(res.ok, res.status, { data: null, text: res.text, truncated: res.truncated, error: res.error });
  const parsed = parseActionsJson(res.text, res.truncated);
  return { ok: parsed.ok, status: res.status, data: parsed.data, text: null, truncated: parsed.truncated, ...(parsed.error ? { error: parsed.error } : {}) };
}

/**
 * GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs — job log text.
 * GitHub returns 302 to a signed URL; `redirect:'follow'` handles that in a
 * real fetch, and fakes can supply a 302 response carrying a `Location` header.
 */
export async function githubActionsGetJobLogs(opts = {}) {
  const { fetch: doFetch, env, owner, repo } = opts;
  const id = pickAlias(opts, 'job_id', 'jobId');
  if (!resolveToken(env)) return noTokenOutcome();
  if (!validRepo(owner, repo)) {
    return actionsOutcome(false, 0, { text: null, truncated: false, error: 'owner and repo must be non-empty GitHub identifiers' });
  }
  if (id === undefined || id === null || id === '') {
    return actionsOutcome(false, 0, { text: null, truncated: false, error: 'job_id is required' });
  }
  const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/actions/jobs/${encodeURIComponent(String(id))}/logs`;
  const res = await githubRestGet({ fetch: doFetch, url, token: resolveToken(env), accept: 'application/octet-stream', timeoutMs: opts.timeoutMs, maxBytes: opts.maxBytes });
  if (!res.ok) return actionsOutcome(res.ok, res.status, { text: null, truncated: res.truncated, error: res.error });
  return actionsOutcome(true, res.status, { text: res.text, truncated: res.truncated });
}

export default {
  ensureBranch,
  createBranchIfMissing,
  create_branch_if_missing,
  unwrapResultPayload,
  canonicalResult,
  upsertPr,
  fetchAllPages,
  repoGrep,
  PUSH_FILES_TOOL,
  detectPushFiles,
  buildPushFilesArgs,
  githubActionsListWorkflowRuns,
  githubActionsListWorkflowJobs,
  githubActionsGetJobLogs,
};
