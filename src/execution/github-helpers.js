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
 * Batch 15 security audit · raw upstream values retained on canonical results
 * are UNTRUSTED external data. Consumers must check this marker before treating
 * `raw` as gateway-verified content. Exported so host and guest can agree on a
 * single literal instead of growing two drifting spellings.
 */
export const UNTRUSTED_RAW_MARKER = 'untrusted-upstream-envelope';

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
  // Security audit: upstream truncation on ANY page must survive the adapter.
  // Previously a page carrying `truncated:true` was silently reported as a
  // complete result once its cursor ran out, so callers paginated as if they
  // had the whole dataset.
  let upstreamTruncated = false;
  const noteTruncation = (page) => {
    if (!page || typeof page !== 'object') return;
    const raw = page.truncated ?? page.isTruncated ?? (page.truncation !== undefined);
    if (raw === true || raw === 1 || raw === '1' || raw === 'true' || (raw && typeof raw === 'object')) {
      upstreamTruncated = true;
    }
    const inner = page.result;
    if (inner && typeof inner === 'object') noteTruncation(inner);
  };
  const out = (extra) => ({
    items, pages, nextCursor: extra.nextCursor ?? null,
    truncated: extra.truncated === true || upstreamTruncated,
    upstreamTruncated,
  });

  while (pages < maxPages) {
    const page = await fetchPage(cursor === undefined ? {} : { [cursorKey]: cursor });
    pages += 1;
    noteTruncation(page);
    if (page == null) return out({ truncated: false });

    const pageItems = toArray(page);
    const rawItems = Array.isArray(page) ? page : (page.items ?? page.data ?? toArray(page));
    const list = Array.isArray(rawItems) ? rawItems : pageItems;
    if (list.length === 0) return out({ truncated: false });

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
      return out({ truncated: false });
    }
    if (next === cursor) {
      // Cursor did not advance: avoid an infinite loop, treat as exhausted.
      return out({ nextCursor: next, truncated: false });
    }
    cursor = next;
  }

  return out({ nextCursor: cursor, truncated: true });
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
  // Security audit: a truncated read means the grep only covered a PREFIX of
  // that file. Matches may be missing, so the whole result is incomplete even
  // if the match limit was not reached.
  let upstreamTruncated = false;

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
    if (raw && typeof raw === 'object') {
      const flag = raw.truncated ?? raw.isTruncated ?? (raw.result && raw.result.truncated);
      if (flag === true || flag === 1 || flag === '1' || flag === 'true') upstreamTruncated = true;
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

  return {
    matches, errors,
    scanned: errors.length ? files.length - errors.length : files.length,
    truncated: truncated || upstreamTruncated,
    upstreamTruncated,
  };
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
 * Batch 15 GPT online fix · `id` / `nodeId` are additive fields kept distinct
 * from `number`: GitHub exposes both a database `id` and a GraphQL `node_id`,
 * and callers need them to disambiguate a PR/issue from its user-visible
 * number. They are NEVER used as a fallback for `number`.
 *
 * Issue #15 / BC-011 · merge results only carry `{sha, merged, message}` — no
 * `number`/`url` at all. An optional `context` lets the CALLER supply the call
 * identity it already knows: `{owner, repo, pullNumber, url?}` (or just the
 * pull number). The response still wins when it carries its own URL/number; the
 * context only fills fields that would otherwise be null, and a PR URL is built
 * (`https://github.com/<owner>/<repo>/pull/<n>`) only when the context states
 * the number AND it matches the resolved number. `id` is never used.
 *
 * @param {*} value upstream merge/PR/issue/write result (any defensive shape)
 * @param {object|number|string} [context] `{owner,repo,pullNumber,url?}` or a bare number
 * @returns {{number:number|null,url:string|null,sha:string|null,id?:string,nodeId?:string,raw:*}}
 */
export function canonicalResult(value, context) {
  try {
    const v = unwrapResultPayload(value);
    const root = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    // Merge results have no top-level sha sometimes; look one level into
    // head/commit for a sha, mirroring result-normalize's normalizePrResult.
    const head = safeGet(root, 'head');
    const commit = safeGet(root, 'commit');
    // BC-011 call context: only the fields the caller explicitly states.
    const ctx = context && typeof context === 'object' && !Array.isArray(context) ? context : {};
    const bareContext = (typeof context === 'number' || typeof context === 'string') ? context : undefined;
    const ctxPullNumber = bareContext !== undefined
      ? toFiniteNumber(bareContext)
      : toFiniteNumber(firstDefined(ctx, ['pullNumber', 'pull_number', 'prNumber', 'pr_number', 'number']));
    const ctxUrlRaw = firstDefined(ctx, ['url', 'html_url', 'web_url']);
    const ctxOwner = typeof ctx.owner === 'string' && ctx.owner ? ctx.owner : null;
    const ctxRepo = typeof ctx.repo === 'string' && ctx.repo ? ctx.repo : null;
    // `id` is a database identifier and must NEVER be used as a PR/issue
    // number (real create_pull_request returns {id:1000000001, url:.../pull/53}).
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
    // Response URL wins; then the caller-supplied URL; then a constructed PR URL
    // only when the context's own pull number agrees with the resolved number.
    let urlOut = urlRaw !== undefined ? String(urlRaw) : (ctxUrlRaw !== undefined ? String(ctxUrlRaw) : null);
    if (numberOut === null && typeof urlOut === 'string') {
      const m = /\/pulls?\/(\d+)(?:\/|$|\?)|\/issues\/(\d+)(?:\/|$|\?)/.exec(urlOut);
      const raw = m && (m[1] ?? m[2]);
      if (raw) numberOut = Number(raw);
    }
    if (numberOut === null && ctxPullNumber !== null) numberOut = ctxPullNumber;
    if (urlOut === null && ctxOwner !== null && ctxRepo !== null
        && ctxPullNumber !== null && numberOut === ctxPullNumber) {
      urlOut = `https://github.com/${ctxOwner}/${ctxRepo}/pull/${numberOut}`;
    }
    const shaRaw = firstDefined(root, ['sha', 'commitSha', 'commit_sha', 'head_sha', 'headSha'])
      ?? firstDefined(head && typeof head === 'object' ? head : {}, ['sha'])
      ?? firstDefined(commit && typeof commit === 'object' ? commit : {}, ['sha']);
    const idRaw = firstDefined(root, ['id']);
    const nodeIdRaw = firstDefined(root, ['node_id', 'nodeId']);
    const result = {
      number: numberOut,
      url: urlOut !== null ? String(urlOut) : null,
      sha: shaRaw !== undefined && shaRaw !== null ? String(shaRaw) : null,
      raw: value,
    };
    // Additive and only present when the upstream actually carries an id:
    // this keeps the historical 4-key shape byte-stable for id-less inputs.
    // Values are strings; they are NEVER a fallback for `number` (URL-first).
    if (idRaw !== undefined && idRaw !== null) result.id = String(idRaw);
    if (nodeIdRaw !== undefined && nodeIdRaw !== null) result.nodeId = String(nodeIdRaw);
    // Non-enumerable: keeps the historical 4-key shape byte-stable while
    // explicitly labelling the retained upstream value as untrusted.
    Object.defineProperty(result, 'rawUntrusted', {
      value: UNTRUSTED_RAW_MARKER, enumerable: false, configurable: true, writable: true,
    });
    return result;
  } catch (_) {
    return Object.defineProperty(
      { number: null, url: null, sha: null, raw: value },
      'rawUntrusted',
      { value: UNTRUSTED_RAW_MARKER, enumerable: false, configurable: true, writable: true },
    );
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
 * @param {string}   [opts.followAccept] Accept header for the 302 signed-URL
 *   follow-up. GitHub's signed Blob URL is not a REST endpoint: asking it for
 *   `application/vnd.github+json` is unnecessary, and the old code sent
 *   `application/octet-stream` to the REST endpoint which GitHub rejects with
 *   415. Defaults to `accept`.
 * @param {number}   [opts.timeoutMs]
 * @param {number}   [opts.maxBytes]   max response body bytes before truncation
 * @returns {Promise<{ok:boolean,status:number,text:string|null,truncated:boolean,error?:string}>}
 */
async function githubRestGet({ fetch: doFetch, url, token, accept, followAccept, timeoutMs = DEFAULT_ACTIONS_TIMEOUT_MS, maxBytes = DEFAULT_ACTIONS_MAX_BYTES } = {}) {
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
        // The signed Blob URL is NOT a GitHub REST endpoint and must NOT carry
        // our Authorization header. Use a plain Accept (`*/*` by default for
        // log text); never reuse the API-specific media type here.
        res = await doFetch(location, {
          method: 'GET',
          headers: { Accept: followAccept || accept || '*/*', 'User-Agent': 'gemini-mcp-gateway-actions-helper' },
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
 *
 * Online evidence (2026-11-23 ChatGPT read-only test): this endpoint returns
 * HTTP 415 when the request asks for `Accept: application/octet-stream`. The
 * REST endpoint must be called with `Accept: application/vnd.github+json`;
 * GitHub then replies 302 to a signed Blob URL, which is followed WITHOUT the
 * Authorization header and with a generic `Accept: * / *` (spelling without the
 * space in code). `redirect:'follow'` handles that in a real fetch, and fakes
 * can supply a 302 response carrying a `Location` header.
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
  // REST endpoint requires the JSON media type. octet-stream gets HTTP 415.
  // The 302 target is a signed storage URL, followed with a plain Accept and
  // no token (see githubRestGet / followAccept).
  const res = await githubRestGet({
    fetch: doFetch,
    url,
    token: resolveToken(env),
    accept: 'application/vnd.github+json',
    followAccept: opts.followAccept || '*/*',
    timeoutMs: opts.timeoutMs,
    maxBytes: opts.maxBytes,
  });
  if (!res.ok) return actionsOutcome(res.ok, res.status, { text: null, truncated: res.truncated, error: res.error });
  return actionsOutcome(true, res.status, { text: res.text, truncated: res.truncated });
}

// ---------------------------------------------------------------------------
// Batch 15 · CI polling ergonomics (read-only, injected tool bridge)
// ---------------------------------------------------------------------------

const DEFAULT_WAIT_TIMEOUT_MS = 30000;
const DEFAULT_WAIT_MAX_POLLS = 30;
const DEFAULT_WAIT_POLL_INTERVAL_MS = 1000;

function sleepMs(ms) {
  return new Promise((resolve) => { if (typeof setTimeout === 'function') setTimeout(resolve, ms); else resolve(); });
}

/** Normalize the many check-run shapes GitHub MCP returns into a flat list. */
function normalizeCheckRuns(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  for (const key of ['check_runs', 'checkRuns', 'checks', 'items', 'runs']) {
    const found = value[key];
    if (Array.isArray(found)) return found;
  }
  const inner = value.result;
  if (inner && typeof inner === 'object') return normalizeCheckRuns(inner);
  return [];
}

function checksCompleted(snapshot) {
  const status = String(snapshot?.status ?? snapshot?.state ?? '').toLowerCase();
  if (status === 'completed' || status === 'success' || status === 'failure' || status === 'failed'
      || status === 'error' || status === 'neutral' || status === 'cancelled') return true;
  const runs = normalizeCheckRuns(snapshot);
  return runs.length > 0 && runs.every((r) => {
    const s = String(r?.status ?? r?.state ?? '').toLowerCase();
    return s === 'completed' || s === 'success' || s === 'failure' || s === 'error';
  });
}

/**
 * Verdict of one check run, normalized to the GitHub conclusion vocabulary.
 * Returns '' when the run has no settled verdict yet (in_progress/queued) or
 * when the upstream only says "completed" without a conclusion — an unknown
 * verdict must never be guessed into success.
 */
function checkRunVerdict(run) {
  if (!run || typeof run !== 'object') return '';
  const conclusion = String(run.conclusion ?? '').toLowerCase();
  if (conclusion) return conclusion;
  const state = String(run.state ?? run.status ?? '').toLowerCase();
  if (!state || state === 'completed') return '';
  if (state === 'success' || state === 'skipped' || state === 'neutral') return state;
  if (state === 'failure' || state === 'failed' || state === 'error') return 'failure';
  if (state === 'cancelled' || state === 'canceled') return 'cancelled';
  return '';
}

/**
 * Aggregate the top-level conclusion of a settled `check_runs` snapshot.
 *
 * GitHub's `pull_request_read` (`method:"get_check_runs"`) returns ONLY
 * `{total_count, check_runs[]}` — no top-level `status`/`conclusion`. Precedence
 * per the contract: any failure/timed_out/action_required -> failure, else any
 * cancelled -> cancelled, else success (all success/skipped/neutral). Returns
 * null when at least one run has no settled verdict, so an aggregate is never
 * invented from partial data.
 */
function aggregateCheckConclusion(runs) {
  const list = Array.isArray(runs) ? runs : [];
  if (list.length === 0) return null;
  const verdicts = list.map(checkRunVerdict);
  if (verdicts.some((v) => v === '')) return null;
  if (verdicts.some((v) => v === 'failure' || v === 'timed_out' || v === 'action_required')) return 'failure';
  if (verdicts.some((v) => v === 'cancelled')) return 'cancelled';
  // Only the documented success vocabulary maps to success; an unknown verdict
  // (e.g. `stale`) stays null rather than being guessed as a pass.
  if (verdicts.every((v) => v === 'success' || v === 'skipped' || v === 'neutral')) return 'success';
  return null;
}

/**
 * Wait at most `timeoutMs` (hard-capped at 30s) for PR checks to settle.
 *
 * Pure orchestration: the actual read is injected via `opts.check`, so the
 * host bridge can implement it with the existing `pull_request_read`
 * (`method:"get_check_runs"`) tool. No new MCP tool, no direct network call,
 * no token handling here. A single call replaces 3–4 manual poll rounds.
 *
 * @returns {Promise<{ok:boolean,pullNumber:number|null,status:string|null,
 *   conclusion:string|null,checkRuns:any[],polls:number,elapsedMs:number,
 *   timedOut:boolean,rawUntrusted?:string}>}
 */
export async function waitForPrChecks({
  owner,
  repo,
  pullNumber,
  check,
  timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
  maxPolls = DEFAULT_WAIT_MAX_POLLS,
  pollIntervalMs = DEFAULT_WAIT_POLL_INTERVAL_MS,
} = {}) {
  requireFn(check, 'check');
  if (typeof owner !== 'string' || !owner || typeof repo !== 'string' || !repo) {
    throw new TypeError('waitForPrChecks: owner and repo are required');
  }
  const number = toFiniteNumber(pullNumber);
  if (number === null) throw new TypeError('waitForPrChecks: pullNumber is required');
  const budget = Math.min(Math.max(0, Number(timeoutMs) || 0), 30000);
  const pollsCap = Math.max(1, Math.min(Number(maxPolls) || 0, 100));
  const interval = Math.max(0, Math.min(Number(pollIntervalMs) || 0, 5000));
  const started = typeof Date.now === 'function' ? Date.now() : 0;
  let polls = 0;
  let snapshot = null;
  let lastError = null;

  for (;;) {
    polls += 1;
    try {
      snapshot = await check({ owner, repo, pullNumber: number, poll: polls });
    } catch (err) {
      lastError = err && err.message ? err.message : String(err);
      // A transient read failure must not kill the wait; keep the last good
      // snapshot so the caller can still see partial evidence.
    }
    const runs = normalizeCheckRuns(snapshot);
    const status = String(snapshot?.status ?? snapshot?.state ?? (runs.length ? 'in_progress' : 'pending'));
    const topStatusRaw = snapshot?.status ?? snapshot?.state;
    const hasTopStatus = topStatusRaw !== undefined && topStatusRaw !== null && String(topStatusRaw) !== '';
    const done = checksCompleted(snapshot);
    const elapsedMs = started ? Date.now() - started : 0;
    if (done) {
      // CI-polling contract fix: a `get_check_runs` snapshot carries ONLY
      // check_runs[]; the old code returned the placeholder status
      // ("in_progress") and conclusion:null even though every run had settled.
      // Derive the aggregate from the runs when the upstream did not supply a
      // top-level field, so callers can tell success from failure in one call.
      // Upstream-supplied status/conclusion always win (unchanged behaviour).
      const derivedStatus = hasTopStatus ? null : (runs.length ? 'completed' : null);
      const topConclusionRaw = snapshot?.conclusion;
      const hasTopConclusion = topConclusionRaw !== undefined && topConclusionRaw !== null && topConclusionRaw !== '';
      const derivedConclusion = hasTopConclusion ? null : aggregateCheckConclusion(runs);
      return {
        ok: true,
        pullNumber: number,
        status: derivedStatus ?? String(topStatusRaw ?? status),
        conclusion: hasTopConclusion ? topConclusionRaw : derivedConclusion,
        checkRuns: runs,
        polls,
        elapsedMs,
        timedOut: false,
        ...(snapshot && typeof snapshot === 'object' && 'raw' in snapshot ? { rawUntrusted: UNTRUSTED_RAW_MARKER } : {}),
      };
    }
    if (polls >= pollsCap || elapsedMs >= budget) {
      return {
        ok: false,
        pullNumber: number,
        status,
        conclusion: null,
        checkRuns: runs,
        polls,
        elapsedMs,
        timedOut: true,
        ...(lastError ? { error: lastError } : {}),
      };
    }
    await sleepMs(interval);
  }
}

// ---------------------------------------------------------------------------
// Batch 17 · PR #80–#101 feedback: Issue creation / CI rerun / branch cleanup
// / multi-file delete+rename. All helpers are pure orchestration: every side
// effect goes through an injected callable, nothing here touches the network.
// ---------------------------------------------------------------------------

/**
 * Batch 17 · unified batch unwrapping (host twin of codemode.unwrapBatch).
 *
 * Every input shape produces the SAME flat array of `{ok,value}` slots:
 *   - a bare value                  -> [{ok:true, value}]
 *   - a JSON string of an array     -> slots for each element
 *   - an array (including nested)   -> flattened slots
 *   - an `{ok,value}` slot          -> preserved as-is (never double-wrapped)
 *   - an upstream envelope          -> one slot for its inner value
 * Never throws, never leaves an extra `{ok,value}` layer for the caller to
 * peel by hand. This is the single host-side contract; the guest prelude
 * mirrors it so host and sandbox callers see identical shapes.
 */
export function unwrapBatch(input) {
  let value = input;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch (_) {
      return [{ ok: true, value: input }];
    }
  }
  const out = [];
  const push = (item) => {
    if (Array.isArray(item)) {
      for (const sub of item) push(sub);
      return;
    }
    if (item && typeof item === 'object' && !Array.isArray(item)
        && typeof item.ok === 'boolean' && 'value' in item) {
      out.push({ ok: item.ok, value: item.value });
      return;
    }
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const keys = Object.keys(item);
      if (keys.length === 1 && (keys[0] === 'result' || keys[0] === 'value')) {
        push(item[keys[0]]);
        return;
      }
    }
    out.push({ ok: true, value: item });
  };
  if (value === null || value === undefined) return [];
  push(value);
  return out;
}

/** Stable error code returned when a required upstream tool is not injected. */
export const UNSUPPORTED_UPSTREAM_TOOL = 'UNSUPPORTED_UPSTREAM_TOOL';

/**
 * Names of GitHub MCP issue tools, in resolution order. The upstream naming
 * drifted across versions (create_issue / issues_create / issue_write with an
 * `action:"create"` argument). We resolve the FIRST callable actually present
 * on the injected `callables` object instead of hard-coding one spelling.
 */
const ISSUE_CREATE_TOOL_NAMES = [
  'github__create_issue', 'github__issues_create', 'github__issue_write',
  'create_issue', 'issues_create', 'issue_write',
];
const ISSUE_LIST_TOOL_NAMES = [
  'github__list_issues', 'github__issues_list', 'github__search_issues',
  'list_issues', 'issues_list', 'search_issues',
];
const ISSUE_GET_TOOL_NAMES = [
  'github__get_issue', 'github__issues_get', 'get_issue', 'issues_get',
];

/** Resolve a callable by exact tool name, then by bare-name suffix. */
function resolveCallable(callables, names) {
  if (!callables || typeof callables !== 'object') return null;
  for (const name of names) {
    if (typeof callables[name] === 'function') return { name, fn: callables[name] };
  }
  // Fallback: accept any key whose bare tool name matches (server prefix may
  // differ from `github__`). Keeps actual GitHub naming differences usable.
  const bare = names.map((n) => n.includes('__') ? n.slice(n.indexOf('__') + 2) : n);
  for (const [key, fn] of Object.entries(callables)) {
    if (typeof fn !== 'function') continue;
    const short = key.includes('__') ? key.slice(key.indexOf('__') + 2) : key;
    if (bare.includes(short)) return { name: key, fn };
  }
  return null;
}

/** Extract a PR/Issue number from ANY URL found in a value (URL-first rule). */
function numberFromAnyUrl(value) {
  if (typeof value === 'string') {
    const m = /\/pulls?\/(\d+)(?:\/|$|\?|#)|\/issues\/(\d+)(?:\/|$|\?|#)/.exec(value);
    return m ? Number(m[1] ?? m[2]) : null;
  }
  if (!value || typeof value !== 'object') return null;
  const seen = new Set();
  const walk = (v, depth) => {
    if (v === null || typeof v !== 'object' || depth > 4 || seen.has(v)) return null;
    seen.add(v);
    if (Array.isArray(v)) {
      for (const item of v) {
        const n = walk(item, depth + 1);
        if (n !== null) return n;
      }
      return null;
    }
    for (const key of ['html_url', 'url', 'web_url', 'api_url']) {
      if (typeof v[key] === 'string') {
        const n = numberFromAnyUrl(v[key]);
        if (n !== null) return n;
      }
    }
    for (const key of Object.keys(v)) {
      if (['raw', 'result'].includes(key)) continue;
      const n = walk(v[key], depth + 1);
      if (n !== null) return n;
    }
    return null;
  };
  return walk(value, 0);
}

/** Canonical `{number,id,url,state,title}` view for create/fetch Issue results. */
export function canonicalIssue(value) {
  const v = unwrapResultPayload(value);
  const root = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  const urlRaw = firstDefined(root, ['html_url', 'url', 'web_url', 'api_url']);
  let number = numberFromAnyUrl(v);
  if (number === null) {
    number = toFiniteNumber(firstDefined(root, ['number', 'issueNumber', 'issue_number', 'prNumber', 'pr_number']));
  }
  // `id` / `node_id` are database identifiers, NEVER a number fallback.
  const idRaw = firstDefined(root, ['id', 'node_id', 'nodeId']);
  const stateRaw = firstDefined(root, ['state']);
  const titleRaw = firstDefined(root, ['title']);
  const out = {
    number,
    id: idRaw !== undefined && idRaw !== null ? String(idRaw) : null,
    url: urlRaw !== undefined && urlRaw !== null ? String(urlRaw) : null,
    state: stateRaw !== undefined && stateRaw !== null ? String(stateRaw) : null,
    title: titleRaw !== undefined && titleRaw !== null ? String(titleRaw) : null,
    raw: value,
  };
  Object.defineProperty(out, 'rawUntrusted', {
    value: UNTRUSTED_RAW_MARKER, enumerable: false, configurable: true, writable: true,
  });
  return out;
}

/**
 * Create an Issue idempotently: dedupe by repo+title/body BEFORE creating,
 * then SHORT-POLL the list/get tool after creation until the number appears
 * (the list index is eventually consistent — the #90 duplicate root cause).
 *
 * - `number` is ALWAYS derived from a URL or an explicit `number` field; an
 *   internal `id` is exposed only as `id` and NEVER used as `number`.
 * - Repeat calls with the same repo/title/body reuse the existing issue and
 *   report `created:false` (idempotent), with no second upstream create.
 * - All I/O goes through injected callables: `opts.callables` maps tool names
 *   to functions, and optional `opts.tools` (descriptors) is only used for
 *   discovery hints. No network, no token, no hard-coded upstream tool name.
 *
 * @param {object}   opts
 * @param {object}   opts.callables         { '<toolName>': fn(args)=>issue }
 * @param {string}   opts.owner
 * @param {string}   opts.repo
 * @param {string}   opts.title
 * @param {string}   [opts.body]
 * @param {object}   [opts.tools]           optional descriptors (discovery)
 * @param {object}   [opts.listArgs]        extra args merged into list calls
 * @param {object}   [opts.createArgs]      extra args merged into create calls
 * @param {number}   [opts.maxPolls=5]      short-poll budget after creation
 * @param {Function} [opts.sleep]           injected timer (fake in tests)
 * @returns {Promise<{created:boolean,reused:boolean,issue:CanonicalIssue,
 *   polls:number,foundAfterCreate:boolean,rawUntrusted?:string}>}
 */
export async function createIssue({
  callables,
  owner,
  repo,
  title,
  body,
  tools,
  listArgs,
  createArgs,
  maxPolls = 5,
  sleep,
} = {}) {
  if (typeof owner !== 'string' || !owner || typeof repo !== 'string' || !repo) {
    throw new TypeError('createIssue: owner and repo are required');
  }
  if (typeof title !== 'string' || !title) {
    throw new TypeError('createIssue: title is required');
  }
  const createTool = resolveCallable(callables, ISSUE_CREATE_TOOL_NAMES);
  if (!createTool) {
    return {
      ok: false,
      error: 'createIssue: no issue-create tool available in callables',
      code: UNSUPPORTED_UPSTREAM_TOOL,
      created: false,
      reused: false,
      polls: 0,
      foundAfterCreate: false,
    };
  }
  const listTool = resolveCallable(callables, ISSUE_LIST_TOOL_NAMES);
  const getTool = resolveCallable(callables, ISSUE_GET_TOOL_NAMES);
  const pollsCap = Math.max(1, Math.min(Math.floor(Number(maxPolls) || 0) || 5, 20));
  const doSleep = typeof sleep === 'function' ? sleep : (ms) => sleepMs(ms);
  const baseArgs = { owner, repo, ...(listArgs && typeof listArgs === 'object' ? listArgs : {}) };

  // 1) PRE-CHECK: dedupe before creating. A list tool may be absent; in that
  // case we cannot dedupe — we still create (never silently pretend to dedupe).
  const normalizedTitle = String(title).trim().toLowerCase();
  const normalizedBody = body === undefined || body === null ? '' : String(body).trim().toLowerCase();
  const matches = (issue) => {
    const c = canonicalIssue(issue);
    return c.title !== null && c.title.trim().toLowerCase() === normalizedTitle
      && (normalizedBody === '' || String(c.raw?.body ?? '').trim().toLowerCase() === normalizedBody);
  };
  if (listTool) {
    let listed = [];
    try {
      listed = toArray(await listTool.fn({ ...baseArgs, state: 'all' }));
    } catch (_) {
      // A failed pre-check must not become a duplicate create: fail closed
      // with an explicit error instead of guessing that no issue exists.
      return {
        ok: false,
        error: 'createIssue: issue list (dedupe pre-check) failed; refusing to create blindly',
        code: 'DEDUPE_PRECHECK_FAILED',
        created: false,
        reused: false,
        polls: 0,
        foundAfterCreate: false,
      };
    }
    const existing = listed.find(matches);
    if (existing) {
      const issue = canonicalIssue(existing);
      return { ok: true, created: false, reused: true, issue, polls: 0, foundAfterCreate: false };
    }
  }

  // 2) CREATE with the resolved tool. issue_write needs an explicit action.
  const createPayload = {
    owner,
    repo,
    title,
    ...(body !== undefined && body !== null ? { body } : {}),
    ...(createTool.name.endsWith('issue_write') ? { action: 'create' } : {}),
    ...(createArgs && typeof createArgs === 'object' ? createArgs : {}),
  };
  const created = await createTool.fn(createPayload);
  let issue = canonicalIssue(created);

  // 3) SHORT-POLL after create: the list index is eventually consistent, so
  // the create response may carry only an internal id and no number/URL yet.
  // Re-read until a real number appears. The create response has no number,
  // so list-by-title/body is the ONLY reliable lookup — never pass an internal
  // id as `issue_number` to get_issue (that would 404 and waste the budget).
  // `getTool` is used only when an explicit number is somehow available.
  let polls = 0;
  let foundAfterCreate = false;
  const hasNumber = (v) => canonicalIssue(v).number !== null;
  const knownNumber = toFiniteNumber(firstDefined(
    unwrapResultPayload(created) && typeof unwrapResultPayload(created) === 'object' ? unwrapResultPayload(created) : {},
    ['number', 'issue_number', 'issueNumber'],
  ));
  if (!hasNumber(created) && (getTool || listTool)) {
    for (let i = 0; i < pollsCap; i += 1) {
      polls += 1;
      await doSleep(Math.min(200 * (i + 1), 1000));
      try {
        let read;
        if (listTool) {
          read = toArray(await listTool.fn({ ...baseArgs, state: 'all' })).find(matches);
        } else if (getTool && knownNumber !== null) {
          read = await getTool.fn({ owner, repo, issue_number: knownNumber, ...(baseArgs || {}) });
        }
        if (read && hasNumber(read)) {
          issue = canonicalIssue(read);
          foundAfterCreate = true;
          break;
        }
      } catch (_) {
        // Transient read failure: keep polling within the budget, never
        // fabricate a number from an internal id.
      }
    }
  }

  // 4) Final safety: if a number was found during polling but the create
  // response had a WRONG explicit number, the polled value wins (URL-first).
  return {
    ok: true,
    created: true,
    reused: false,
    issue,
    polls,
    foundAfterCreate,
    ...(issue.number === null ? { numberMissing: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// Batch 17 · CI rerun: only call an injected upstream tool; never fake success
// ---------------------------------------------------------------------------

const RERUN_TOOL_NAMES = [
  'github__rerun_failed_jobs', 'github__rerun_workflow', 'github__run_workflow',
  'rerun_failed_jobs', 'rerun_workflow', 'run_workflow',
];

/**
 * Rerun failed CI jobs for a workflow run.
 *
 * Returns a stable `{ok, ...}` result. When NO rerun tool is injected, the
 * result is `{ok:false, code:'UNSUPPORTED_UPSTREAM_TOOL'}` — there is NO silent
 * fake success. We do not assume the gateway has REST/token access here; the
 * tool must be supplied by the caller.
 *
 * @param {object} opts
 * @param {object} opts.callables       injected tool map
 * @param {string} opts.owner
 * @param {string} opts.repo
 * @param {string|number} opts.runId    workflow run id (or job id with jobId)
 * @param {object} [opts.extraArgs]     passed through to the upstream tool
 */
export async function rerunFailedJobs({ callables, owner, repo, runId, extraArgs } = {}) {
  const tool = resolveCallable(callables, RERUN_TOOL_NAMES);
  if (!tool) {
    return {
      ok: false,
      code: UNSUPPORTED_UPSTREAM_TOOL,
      error: 'rerunFailedJobs: no upstream rerun tool is available in this session (github__rerun_failed_jobs / run_workflow); not performing a fake rerun',
      rerun: false,
    };
  }
  if (typeof owner !== 'string' || !owner || typeof repo !== 'string' || !repo) {
    throw new TypeError('rerunFailedJobs: owner and repo are required');
  }
  if (runId === undefined || runId === null || runId === '') {
    throw new TypeError('rerunFailedJobs: runId is required');
  }
  const args = {
    owner,
    repo,
    ...(String(tool.name).includes('rerun_failed') ? { run_id: runId } : { run_id: runId, workflow_id: runId }),
    ...(extraArgs && typeof extraArgs === 'object' ? extraArgs : {}),
  };
  const raw = await tool.fn(args);
  return { ok: true, code: null, rerun: true, tool: tool.name, result: raw, raw };
}

// ---------------------------------------------------------------------------
// Batch 17 · merge with optional source-branch deletion (opt-in only)
// ---------------------------------------------------------------------------

/**
 * Merge a PR and, ONLY when `deleteBranch:true`, delete the source branch via
 * an injected delete callback. Deletion is never the default: the feedback
 * asks for an option, not a behaviour change. A failed delete is reported
 * honestly (`branchDeleted:false`, `deleteError`), never swallowed.
 */
export async function mergePrWithOptionalBranchDelete({
  merge,
  deleteBranchTool,
  owner,
  repo,
  pullNumber,
  head,
  deleteBranch,
  mergeArgs,
  deleteArgs,
} = {}) {
  requireFn(merge, 'merge');
  const number = toFiniteNumber(pullNumber);
  if (number === null) throw new TypeError('mergePrWithOptionalBranchDelete: pullNumber is required');
  const merged = await merge({
    owner, repo, pullNumber: number,
    ...(mergeArgs && typeof mergeArgs === 'object' ? mergeArgs : {}),
  });
  const out = { ok: true, merged, branchDeleted: false, deleteError: null };
  // `deleteBranch:true` is the explicit opt-in; without it no deletion happens
  // (deletion must never be a silent default). `deleteBranchTool` is the
  // injected callback that actually performs the deletion.
  if (deleteBranch !== true) return out;
  if (typeof deleteBranchTool !== 'function') {
    out.deleteError = 'deleteBranch:true requires an injected deleteBranchTool callback (unsupported)';
    out.code = UNSUPPORTED_UPSTREAM_TOOL;
    return out;
  }
  const source = typeof head === 'string' ? head : (head && (head.ref ?? head.name)) ?? null;
  if (!source) {
    out.deleteError = 'deleteBranch:true requires head (source branch name)';
    return out;
  }
  try {
    await deleteBranchTool({
      owner, repo, name: source, branch: source,
      ...(deleteArgs && typeof deleteArgs === 'object' ? deleteArgs : {}),
    });
    out.branchDeleted = true;
  } catch (err) {
    out.deleteError = err && err.message ? err.message : String(err);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Batch 17 · multi-file delete / rename (two-phase, honestly non-atomic)
// ---------------------------------------------------------------------------
//
// FACT: GitHub's `push_files` schema is {files:[{path,content}]} — it has NO
// delete/rename field. We therefore CANNOT promise a single atomic commit for
// deletes/renames via that tool. These helpers do a two-phase sequence:
//   rename: read source -> write destination -> delete source
//   delete: delete paths one by one
// and report `atomic:false`, `partial:true` plus `written`/`failed` honestly.
// Only an INJECTED git-data-API callback (`gitData`) may make it atomic; if
// supplied, it is called once with both operations and `atomic:true` is set.

/**
 * Delete multiple files. Two-phase/per-file unless a git-data callback is
 * injected. Never claims atomicity it cannot prove.
 */
export async function deleteFiles({
  deleteFile,
  gitData,
  owner,
  repo,
  branch,
  paths,
  message = 'delete files via codemode',
} = {}) {
  const list = Array.isArray(paths) ? paths.filter((p) => typeof p === 'string' && p) : [];
  if (!list.length) throw new TypeError('deleteFiles: paths must be a non-empty string array');
  if (typeof gitData === 'function') {
    const raw = await gitData({ owner, repo, branch, operation: 'delete', paths: list, message });
    return { ok: true, atomic: true, partial: false, deleted: list.slice(), failed: [], raw };
  }
  requireFn(deleteFile, 'deleteFile');
  const deleted = [];
  const failed = [];
  for (const path of list) {
    try {
      const raw = await deleteFile({ owner, repo, branch, path, message });
      deleted.push({ path, raw });
    } catch (err) {
      failed.push({ path, error: err && err.message ? err.message : String(err) });
    }
  }
  return {
    ok: failed.length === 0,
    atomic: false,
    partial: failed.length > 0 || deleted.length > 0,
    deleted,
    failed,
    remaining: failed.map((f) => f.path),
    reason: 'push_files schema only supports {path,content}; deletes require separate commits (injected gitData callback required for atomicity)',
  };
}

/**
 * Rename files: read source -> write destination -> delete source, per file.
 * Two separate commits are REQUIRED with the GitHub MCP push_files tool;
 * `atomic:false` is reported unless a `gitData` callback is injected.
 */
export async function renameFiles({
  readFile,
  writeFile,
  deleteFile,
  gitData,
  owner,
  repo,
  branch,
  renames,
  message = 'rename files via codemode',
} = {}) {
  const list = Array.isArray(renames)
    ? renames.filter((r) => r && typeof r.from === 'string' && r.from && typeof r.to === 'string' && r.to)
    : [];
  if (!list.length) throw new TypeError('renameFiles: renames must be a non-empty [{from,to}] array');
  if (typeof gitData === 'function') {
    const raw = await gitData({ owner, repo, branch, operation: 'rename', renames: list, message });
    return { ok: true, atomic: true, partial: false, renamed: list.slice(), failed: [], raw };
  }
  requireFn(readFile, 'readFile');
  requireFn(writeFile, 'writeFile');
  requireFn(deleteFile, 'deleteFile');
  const renamed = [];
  const failed = [];
  for (const { from, to } of list) {
    try {
      const read = await readFile({ owner, repo, path: from, ref: branch, branch });
      const v = unwrapResultPayload(read);
      const root = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
      let content = firstDefined(root, ['content', 'text', 'data']);
      if (Array.isArray(content)) {
        content = content.map((part) => (part && typeof part.text === 'string' ? part.text : '')).join('\n');
      }
      if (content === undefined || content === null) throw new Error(`renameFiles: no content for ${from}`);
      await writeFile({ owner, repo, branch, path: to, content: String(content), message });
      await deleteFile({ owner, repo, branch, path: from, message });
      renamed.push({ from, to });
    } catch (err) {
      failed.push({ from, to, error: err && err.message ? err.message : String(err) });
    }
  }
  return {
    ok: failed.length === 0,
    atomic: false,
    partial: true, // two commits per rename (write + delete) even on full success
    commitsRequired: 2,
    renamed,
    failed,
    remaining: failed.map((f) => f.from),
    reason: 'push_files supports {path,content} only; rename needs a write commit + a delete commit (injected gitData callback required for atomicity)',
  };
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
  waitForPrChecks,
  // Batch 17 · PR #80–#101 feedback helpers
  UNSUPPORTED_UPSTREAM_TOOL,
  unwrapBatch,
  canonicalIssue,
  createIssue,
  rerunFailedJobs,
  mergePrWithOptionalBranchDelete,
  deleteFiles,
  renameFiles,
  UNTRUSTED_RAW_MARKER,
};
