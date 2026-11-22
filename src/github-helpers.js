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
 * @param {string}   opts.name          branch name
 * @param {string}   opts.fromSha       base commit sha for creation/reset
 * @param {'reuse'|'reset'} [opts.ifExists='reuse']
 * @returns {Promise<{created:boolean,reused:boolean,reset:boolean,branch:any}>}
 */
export async function ensureBranch({
  listBranches,
  createBranch,
  deleteBranch,
  name,
  fromSha,
  ifExists = 'reuse',
} = {}) {
  requireFn(listBranches, 'listBranches');
  requireFn(createBranch, 'createBranch');
  if (!name || typeof name !== 'string') throw new TypeError('name must be a non-empty string');
  if (ifExists !== 'reuse' && ifExists !== 'reset') {
    throw new TypeError("ifExists must be 'reuse' or 'reset'");
  }

  const branches = toArray(await listBranches());
  const branch = branches.find((b) => {
    if (typeof b === 'string') return b === name;
    if (!b || typeof b !== 'object') return false;
    return b.name === name || b.ref === name || (typeof b.ref === 'string' && b.ref.endsWith(`/${name}`));
  });

  if (branch !== undefined) {
    if (ifExists === 'reuse') {
      return { created: false, reused: true, reset: false, branch };
    }
    // reset: delete then recreate. Deletion is optional by design — without
    // a deleteBranch callback we must fail loudly rather than silently reuse.
    if (typeof deleteBranch !== 'function') {
      throw new Error('ensureBranch: ifExists="reset" requires a deleteBranch callback (unsupported)');
    }
    await deleteBranch({ name, branch });
    const created = await createBranch({ name, fromSha });
    return { created: true, reused: false, reset: true, branch: created ?? branch };
  }

  const created = await createBranch({ name, fromSha });
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
        number: existing.number ?? existing.id,
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
 * @param {string}   opts.name            branch to ensure
 * @param {string}   opts.base            base ref / commit sha to create from
 * @param {'reuse'|'reset'} [opts.ifExists='reuse']
 * @returns {Promise<{created:boolean,reused:boolean,reset:boolean,branch:any}>}
 */
export async function createBranchIfMissing({ listBranches, createBranch, deleteBranch, name, base, ifExists = 'reuse' } = {}) {
  return ensureBranch({
    listBranches,
    createBranch,
    deleteBranch,
    name,
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
    const number = toFiniteNumber(
      firstDefined(root, ['number', 'prNumber', 'pr_number', 'issueNumber', 'issue_number', 'pullNumber', 'pull_number', 'id']),
    );
    const urlRaw = firstDefined(root, ['html_url', 'url', 'web_url']);
    const shaRaw = firstDefined(root, ['sha', 'commitSha', 'commit_sha', 'head_sha', 'headSha'])
      ?? firstDefined(head && typeof head === 'object' ? head : {}, ['sha'])
      ?? firstDefined(commit && typeof commit === 'object' ? commit : {}, ['sha']);
    let numberOut = number;
    if (numberOut === null && typeof urlRaw === 'string') {
      // Only fallback when no explicit number field exists at all.
      const m = /\/pull\/(\d+)(?:\/|$|\?)|\/issues\/(\d+)(?:\/|$|\?)/.exec(urlRaw);
      const raw = m && (m[1] ?? m[2]);
      if (raw) numberOut = Number(raw);
    }
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

export default {
  ensureBranch,
  createBranchIfMissing,
  create_branch_if_missing,
  unwrapResultPayload,
  canonicalResult,
  upsertPr,
  fetchAllPages,
  repoGrep,
};
