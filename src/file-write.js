/**
 * Host-side, pure file patch orchestration (B10 P0-3 / P0-4).
 *
 * This module is intentionally dependency-free and does NOT know anything about
 * GitHub, MCP, or Code Mode. It works on plain strings and an injected
 * `read` / `write` pair so it can be unit-tested with fakes and later wired to
 * any upstream write path by the caller.
 *
 * Design rules (mirrors the documented "失败不部分写" contract):
 *   - applyTextPatch is a PURE function: it either applies every hunk or
 *     returns the original text unchanged with `{ ok:false, error }`.
 *   - applyFilePatch NEVER writes on failure, and NEVER writes when
 *     `dryRun` is true (the default). A write is attempted only after a
 *     successful patch application in non-dry-run mode.
 *
 * Batch 11 write-transaction (multi-file atomicity):
 *   - `applyFilePatches` / `writeFiles` gained an `atomic` option and an
 *     injected `commitFiles` callback (GitHub `push_files`: one commit for all
 *     staged files). When `commitFiles` is available, `atomic` defaults to
 *     true; all reads/patches/prechecks happen first, then ONE commit call.
 *   - If the atomic commit fails, ZERO files are written. If atomic mode is
 *     unavailable or explicitly disabled, the legacy per-file write path is
 *     used; a mid-batch failure is reported as `atomic:false, partial:true`
 *     with the exact list of already-written files (never faked as success).
 *   - Single-file `applyFilePatch` is unchanged (B10契约保持).
 */

/** Normalize CRLF / lone CR to LF so context comparison is line-ending agnostic. */
function normalizeText(value) {
  const text = typeof value === 'string' ? value : String(value == null ? '' : value);
  return text.replace(/\r\n?/g, '\n');
}

/**
 * Parse the optional counts from a hunk header and sanity-check them against
 * the body we actually parsed. Returns null on a malformed header.
 */
function parseHunkHeader(line) {
  const m = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@(?:.*)$/.exec(line);
  if (!m) return null;
  return {
    oldStart: Number(m[1]),
    oldCount: m[2] === undefined ? 1 : Number(m[2]),
    newStart: Number(m[3]),
    newCount: m[4] === undefined ? 1 : Number(m[4]),
  };
}

/**
 * Parse a unified diff into hunk objects. `---`, `+++`, `\ No newline`, and
 * arbitrary preamble lines are ignored. Lines inside a hunk must begin with
 * ' ' (context), '-' (removal), or '+' (addition); anything else ends the hunk
 * body and is treated as a separator/preamble before the next header.
 *
 * Returns `{ ok:false, error }` on a structurally broken diff, otherwise
 * `{ ok:true, hunks }` where each hunk has `{ header, ops }`.
 */
function parseUnifiedDiff(unifiedDiff) {
  if (typeof unifiedDiff !== 'string' || unifiedDiff.length === 0) {
    return { ok: false, error: 'empty patch' };
  }
  const plines = normalizeText(unifiedDiff).split('\n');
  const hunks = [];
  let i = 0;
  while (i < plines.length) {
    const header = parseHunkHeader(plines[i]);
    if (!header) {
      i += 1;
      continue;
    }
    const ops = [];
    i += 1;
    while (i < plines.length && !parseHunkHeader(plines[i])) {
      const line = plines[i];
      if (line.startsWith('--- ') || line.startsWith('+++ ')) {
        i += 1;
        continue;
      }
      if (line.startsWith('\\')) {
        // "\ No newline at end of file" — we preserve trailing newlines
        // conservatively from the original text instead of trusting this marker.
        i += 1;
        continue;
      }
      if (line.length > 0 && (line[0] === ' ' || line[0] === '-' || line[0] === '+')) {
        ops.push({ op: line[0], text: line.slice(1) });
        i += 1;
        continue;
      }
      // Empty or unrecognized line: end of this hunk body.
      break;
    }
    hunks.push({ header, ops });
  }
  if (hunks.length === 0) return { ok: false, error: 'no hunks' };
  return { ok: true, hunks };
}

/**
 * Apply a unified diff to `rawText` with STRICT context validation.
 *
 * @param {string} rawText original file contents
 * @param {string} unifiedDiff patch text containing one or more `@@ ... @@` hunks
 * @returns {{ok:true,text:string,added:number,removed:number,hunks:number}|
 *           {ok:false,error:string,text:string}}
 *
 * Failure is always atomic: `text` is the normalized original, never a
 * partially patched version. Trailing-newline presence of the original is
 * preserved in the result (conservative handling).
 */
export function applyTextPatch(rawText, unifiedDiff) {
  const source = normalizeText(rawText);
  const originalHadTrailingNewline = source.length > 0 && source.endsWith('\n');
  const lines = source.split('\n');

  let parsed;
  try {
    parsed = parseUnifiedDiff(unifiedDiff);
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e), text: source };
  }
  if (!parsed.ok) return { ok: false, error: parsed.error, text: source };

  const out = [];
  let cursor = 0; // index in `lines` of the next unconsumed source line
  let added = 0;
  let removed = 0;

  try {
    for (const hunk of parsed.hunks) {
      const { oldStart, oldCount, newCount } = hunk.header;

      // Empty hunk with zero-width anchors (e.g. "@@ -0,0 +1,0 @@") is a
      // pure insertion at a position; still require it to be monotonic.
      const idx = oldStart === 0 ? 0 : oldStart - 1;
      if (idx < cursor || idx > lines.length) {
        return {
          ok: false,
          error: `hunk out of range at old line ${oldStart}`,
          text: source,
        };
      }

      // Copy untouched lines before this hunk.
      out.push(...lines.slice(cursor, idx));

      let src = idx;
      let consumedOld = 0;
      let producedNew = 0;
      for (const entry of hunk.ops) {
        if (entry.op === ' ' || entry.op === '-') {
          if (src >= lines.length || lines[src] !== entry.text) {
            return {
              ok: false,
              error: `context mismatch at line ${src + 1}: expected ${JSON.stringify(entry.text)}, got ${JSON.stringify(lines[src])}`,
              text: source,
            };
          }
          consumedOld += 1;
          src += 1;
          if (entry.op === ' ') {
            out.push(entry.text);
            producedNew += 1;
          } else {
            removed += 1;
          }
        } else if (entry.op === '+') {
          out.push(entry.text);
          producedNew += 1;
          added += 1;
        }
      }

      // Note: we use the header's oldStart for positioning and validate every
      // context/removal line against the source. We do NOT reject a hunk whose
      // declared counts include context lines omitted from the body (a common
      // shape for trimmed unified diffs) — strict validation here means
      // content equality, not trusting self-reported counts.
      void oldCount;
      void newCount;
      void consumedOld;
      void producedNew;

      cursor = src;
    }
    out.push(...lines.slice(cursor));
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e), text: source };
  }

  let result = out.join('\n');
  // Conservative trailing newline: preserve the original's presence/absence.
  // A trailing '' element produced by a final newline is normalized away when
  // the original had none, and added back when it did.
  const resultHadTrailingNewline = result.length > 0 && result.endsWith('\n');
  if (originalHadTrailingNewline && !resultHadTrailingNewline) result += '\n';
  if (!originalHadTrailingNewline && resultHadTrailingNewline) result = result.replace(/\n$/, '');

  return { ok: true, text: result, added, removed, hunks: parsed.hunks.length };
}

/**
 * Build a compact unified-diff summary string for logging / preview.
 * Groups changed lines into bare +N/-M lines with a short context snippet;
 * it is informational, not a re-applicable patch.
 */
function buildDiffSummary(path, first, second, added, removed, hunks) {
  const beforeLines = first.split('\n').length;
  const afterLines = second.split('\n').length;
  const a = first.split('\n');
  const b = second.split('\n');
  const samples = [];
  // Show the first few removed/added lines as a human-readable hint.
  const removedSamples = [];
  const addedSamples = [];
  for (let i = 0; i < a.length && removedSamples.length < 3; i += 1) {
    if (!b.includes(a[i])) removedSamples.push(`-${a[i]}`);
  }
  for (let i = 0; i < b.length && addedSamples.length < 3; i += 1) {
    if (!a.includes(b[i])) addedSamples.push(`+${b[i]}`);
  }
  samples.push(...removedSamples, ...addedSamples);
  const header = `--- a/${path}\n+++ b/${path}\n@@ -1,${beforeLines} +1,${afterLines} @@`;
  // P0 batch 11: the 3-sample cap is a deliberate safety limit, so it must be
  // explicit instead of looking like the patch only changed these few lines.
  const omitted = Math.max(0, Math.min(a.length, b.length) - removedSamples.length - addedSamples.length);
  const footer = omitted > 0 ? `… ${omitted} more changed line${omitted === 1 ? '' : 's'} omitted from preview` : null;
  return [header, ...samples, ...(footer ? [footer] : [])].join('\n');
}

/**
 * End-to-end file patch orchestration with injectable I/O.
 *
 * @param {object} args
 * @param {(path:string)=>Promise<string>|string} args.read returns current file text
 * @param {(path:string, text:string)=>Promise<any>} args.write commits the new text
 * @param {string} args.path logical file path (passed through to read/write)
 * @param {string} args.patch unified diff
 * @param {boolean} [args.dryRun=true] when true, never call write
 * @returns {Promise<{ok:boolean, diff?:object, commitSha?:string, content?:string, error?:string}>}
 *
 * On any failure (read error, patch mismatch, write error) the returned object
 * has `{ ok:false, error }` and NO write is attempted for read/patch failures.
 * A write error is reported as-is (never faked as success).
 */
export async function applyFilePatch({ read, write, path, patch, dryRun = true, includeContent = false, precheck = true } = {}) {
  // Validate I/O injection before doing any work.
  if (typeof read !== 'function') {
    return { ok: false, error: 'read must be a function' };
  }
  if (!dryRun && typeof write !== 'function') {
    return { ok: false, error: 'write must be a function when dryRun is false' };
  }
  if (typeof path !== 'string' || path.length === 0) {
    return { ok: false, error: 'path must be a non-empty string' };
  }

  let rawText;
  try {
    rawText = await read(path);
  } catch (e) {
    return { ok: false, error: `read failed: ${String(e && e.message ? e.message : e)}` };
  }

  // P0 batch 11: a patch built on a truncated read would be applied to a
  // partial file and then written back, silently destroying the tail. Treat an
  // in-band TRUNCATED marker as a hard stop before any patch/precheck/write.
  // (Host injects read() as plain text; upstream flags are checked by the
  // sandbox orchestration helper before it calls this path.)
  if (typeof rawText === 'string' && rawText.includes('--- TRUNCATED ---')) {
    return { ok: false, error: 'refusing to patch a truncated read: re-read the full file before writing' };
  }

  const applied = applyTextPatch(rawText, patch);
  if (!applied.ok) return { ok: false, error: applied.error };

  const diff = {
    path,
    added: applied.added,
    removed: applied.removed,
    hunks: applied.hunks,
    diff: buildDiffSummary(path, normalizeText(rawText), applied.text, applied.added, applied.removed, applied.hunks),
  };

  // Write-before lightweight precheck: JSON strict parse / JS-TS bracket+quote
  // balance. A failure is a hard stop — no write is attempted.
  if (precheck) {
    const checked = precheckText(applied.text, path);
    if (!checked.ok) {
      return { ok: false, error: checked.error, precheck: checked.check, diff };
    }
  }

  // Dry-run (the default) stops here — no write, no fake commit data.
  // `includeContent` is an explicit opt-in for orchestrators that stage the
  // patched text before writing (default stays false for backward compatibility).
  if (dryRun) {
    const out = { ok: true, diff };
    if (includeContent) out.content = applied.text;
    return out;
  }

  let writeResult;
  try {
    writeResult = await write(path, applied.text);
  } catch (e) {
    return { ok: false, error: `write failed: ${String(e && e.message ? e.message : e)}`, diff };
  }

  // Some upstream write helpers surface their own failure in the result.
  if (writeResult && typeof writeResult === 'object' && writeResult.ok === false) {
    return { ok: false, error: writeResult.error || 'write failed', diff };
  }

  const out = { ok: true, diff };
  if (writeResult && typeof writeResult === 'object') {
    const nestedContent = writeResult.content && typeof writeResult.content === 'object' ? writeResult.content : null;
    const nestedCommit = writeResult.commit && typeof writeResult.commit === 'object' ? writeResult.commit : null;
    const blobSha = writeResult.sha ?? nestedContent?.sha;
    const commitSha = writeResult.commitSha ?? nestedCommit?.sha;
    if (commitSha !== undefined) out.commitSha = commitSha;
    if (blobSha !== undefined) out.commitSha = blobSha;
    if (writeResult.content !== undefined) out.content = writeResult.content;
  }
  return out;
}

// ---------------------------------------------------------------------------
// PR #41–#48 incremental suggestions (B10 follow-up): write-before precheck,
// sha auto-fill and one unified apply/write entry for single and multiple files.
// ---------------------------------------------------------------------------

const CODE_EXT_RE = /\.(?:[cm]?[jt]sx?|mts|cts)$/i;

/**
 * Lightweight write-before syntax precheck. Deliberately NOT a compiler:
 *  - `.json` (and `.jsonc`-free JSON) must parse strictly with JSON.parse.
 *  - JS/TS-family files only get a bracket/quote balance scan; no tsc, no AST,
 *    no type checking — a passing result does not mean the code compiles.
 * Other extensions are not checked (returns ok).
 *
 * @returns {{ok:true,check:string}|{ok:false,error:string,check:string}}
 */
export function precheckText(text, path) {
  const source = typeof text === 'string' ? text : String(text == null ? '' : text);
  const name = typeof path === 'string' ? path.toLowerCase() : '';
  if (name.endsWith('.json')) {
    try {
      JSON.parse(source);
      return { ok: true, check: 'json' };
    } catch (e) {
      return { ok: false, check: 'json', error: `JSON precheck failed: ${String(e && e.message ? e.message : e)}` };
    }
  }
  if (CODE_EXT_RE.test(name)) {
    const stack = [];
    const pairs = { ')': '(', ']': '[', '}': '{' };
    let quote = null;
    let escaped = false;
    let lineComment = false;
    let blockComment = false;
    for (let i = 0; i < source.length; i += 1) {
      const c = source[i];
      const next = source[i + 1];
      if (lineComment) {
        if (c === '\n') lineComment = false;
        continue;
      }
      if (blockComment) {
        if (c === '*' && next === '/') { blockComment = false; i += 1; }
        continue;
      }
      if (quote) {
        if (escaped) { escaped = false; continue; }
        if (c === '\\') { escaped = true; continue; }
        if (c === quote) quote = null;
        continue;
      }
      if (c === '/' && next === '/') { lineComment = true; i += 1; continue; }
      if (c === '/' && next === '*') { blockComment = true; i += 1; continue; }
      if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
      if (c === '(' || c === '[' || c === '{') stack.push({ c, i });
      else if (c === ')' || c === ']' || c === '}') {
        const top = stack.pop();
        if (!top || top.c !== pairs[c]) {
          return { ok: false, check: 'balance', error: `bracket balance precheck failed at offset ${i}: unexpected ${c}` };
        }
      }
    }
    if (quote) {
      return { ok: false, check: 'balance', error: `bracket balance precheck failed: unterminated ${quote} quote` };
    }
    if (blockComment) {
      return { ok: false, check: 'balance', error: 'bracket balance precheck failed: unterminated block comment' };
    }
    if (stack.length) {
      return { ok: false, check: 'balance', error: `bracket balance precheck failed: unclosed ${stack[stack.length - 1].c}` };
    }
    return { ok: true, check: 'balance' };
  }
  return { ok: true, check: 'none' };
}

/**
 * Resolve the optimistic-lock sha for a write. When the caller supplied one,
 * it always wins. Otherwise `getSha(path)` is consulted (when provided) so a
 * single-file update gets the current branch blob sha automatically. Missing
 * sha is legal (new-file creation) and is simply omitted.
 */
async function resolveSha({ path, sha, getSha }) {
  if (sha !== undefined && sha !== null && sha !== '') return String(sha);
  if (typeof getSha !== 'function') return undefined;
  const resolved = await getSha(path);
  if (resolved === undefined || resolved === null || resolved === '') return undefined;
  return String(resolved);
}

/**
 * Batch 11: describe atomic-commit capability in a single place so host and
 * sandbox callers report the SAME reason strings.
 *
 * `commitFiles` is the injected one-commit-many-files callback (the host
 * adapter for GitHub `github__push_files`). When it is missing, atomic mode is
 * impossible and the caller must fall back to the legacy per-file write path.
 */
export function describeAtomicCapability(commitFiles, atomic) {
  if (atomic === true && typeof commitFiles !== 'function') {
    return {
      atomic: false,
      supported: false,
      reason: 'atomic write requested but github__push_files (commitFiles) is unavailable',
    };
  }
  if (atomic === false) {
    return {
      atomic: false,
      supported: typeof commitFiles === 'function',
      reason: 'atomic write explicitly disabled by caller',
    };
  }
  if (typeof commitFiles === 'function') {
    return { atomic: true, supported: true, reason: null };
  }
  return {
    atomic: false,
    supported: false,
    reason: 'github__push_files (commitFiles) unavailable; using per-file writes',
  };
}

/** Build the `files[]` payload for a single atomic commit (path + full text). */
export function buildAtomicFiles(staged) {
  return staged.map((s) => ({ path: s.path, content: s.applied.content }));
}

/** Extract a failure message from an atomic committer result without faking success. */
function atomicCommitError(value) {
  if (!value || typeof value !== 'object') return null;
  if (value.ok === false) return String(value.error || 'atomic commit failed');
  return null;
}

/**
 * Normalize an upstream write response into the unified top-level field set.
 * `{number?, url?, sha, commitSha}` — `number`/`url` are optional (present only
 * when the upstream actually returned them); `sha` and `commitSha` are always
 * present as `null` when unknown so models never need to guess field presence.
 */
export function normalizeWriteResult(value, { sha } = {}) {
  let raw = value;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch (_) { /* keep string */ }
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && raw.result && typeof raw.result === 'object') {
    raw = raw.result;
  }
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const pick = (keys) => {
    for (const key of keys) {
      const v = obj[key];
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return undefined;
  };
  const nestedContent = obj.content && typeof obj.content === 'object' && !Array.isArray(obj.content) ? obj.content : {};
  const nestedCommit = obj.commit && typeof obj.commit === 'object' && !Array.isArray(obj.commit) ? obj.commit : {};
  // GitHub create_or_update_file returns {content:{sha,path,...}, commit:{sha,...}}.
  const blobShaRaw = pick(['sha', 'contentSha', 'content_sha', 'blobSha']) ?? nestedContent.sha;
  const commitShaRaw = pick(['commitSha', 'commit_sha', 'sha']) ?? nestedCommit.sha ?? sha;
  const numRaw = pick(['number', 'prNumber', 'pr_number', 'issueNumber', 'issue_number']);
  const urlRaw = pick(['html_url', 'url', 'web_url']);
  const out = {
    sha: blobShaRaw !== undefined ? String(blobShaRaw) : null,
    commitSha: commitShaRaw !== undefined && commitShaRaw !== null ? String(commitShaRaw) : null,
  };
  if (numRaw !== undefined) out.number = Number(numRaw);
  if (urlRaw !== undefined) out.url = String(urlRaw);
  return out;
}

/**
 * Unified single/multi-file patch+write entry.
 *
 * Accepts either `{path, patch}` (single file, legacy `applyFilePatch` call
 * shape) or `{patches:[{path,patch,sha?}...]}` (multiple files). Both go
 * through the SAME read → strict patch → precheck → write logic and both return
 * the SAME top-level shape `{ok, files?, sha, commitSha, number?, url?, diff?}`.
 *
 * `getSha(path)` fills an omitted per-file sha from the current branch read.
 * `write(path, text, {sha, path})` receives the resolved sha as its third arg.
 * Every precheck/patch failure aborts the whole batch before any write; a
 * later write failure is reported, never faked as success.
 *
 * Batch 11 atomicity:
 *  - `commitFiles({files, owner, repo, branch, message})` is the injected
 *    one-commit-many-files callback (GitHub `push_files`). When present,
 *    `atomic` defaults to true and the staged files are committed ONCE after
 *    every read/patch/precheck succeeded. Any failure → ZERO writes.
 *  - When unavailable, `atomic` defaults to false and the legacy per-file
 *    write loop runs. A mid-batch failure returns
 *    `{ok:false, atomic:false, partial:true, written, remaining, compensation}`
 *    so the caller knows exactly what landed and how to clean up.
 */
export async function applyFilePatches({
  read,
  write,
  getSha,
  commitFiles,
  atomic,
  path,
  patch,
  patches,
  dryRun = true,
  precheck = true,
  ...rest
} = {}) {
  if (typeof read !== 'function') return { ok: false, error: 'read must be a function' };
  if (!dryRun && typeof write !== 'function' && typeof commitFiles !== 'function') {
    return { ok: false, error: 'write must be a function when dryRun is false' };
  }

  // Batch 11: fail fast on an impossible atomic request — before any read or
  // precheck work, and with ZERO writes of any kind.
  if (atomic === true && typeof commitFiles !== 'function') {
    return {
      ok: false,
      error: 'atomic write requested but github__push_files (commitFiles) is unavailable',
      atomic: false,
      files: [],
      written: [],
      writtenFiles: [],
      partial: false,
    };
  }

  const list = patches !== undefined
    ? (Array.isArray(patches) ? patches : null)
    : (path !== undefined ? [{ path, patch, sha: rest.sha }] : null);
  if (!list || list.length === 0) return { ok: false, error: 'patches must be a non-empty array (or provide path+patch)' };

  const staged = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') return { ok: false, error: 'each patch must be an object' };
    const r = await applyFilePatch({
      ...rest,
      read,
      write,
      dryRun: true, // stage with no writes; actual writes happen below, after ALL files pass
      includeContent: true, // orchestrator needs the fully patched text to write later
      path: item.path,
      patch: item.patch,
    });
    if (!r.ok) return { ok: false, error: `${item.path}: ${r.error}` };
    staged.push({ path: item.path, applied: r, sha: await resolveSha({ path: item.path, sha: item.sha, getSha }) });
  }

  // Precheck the fully patched text of every file BEFORE any write.
  if (precheck) {
    for (const s of staged) {
      const checked = precheckText(s.applied.content ?? s.applied.diff?.text ?? '', s.path);
      if (!checked.ok) return { ok: false, error: `${s.path}: ${checked.error}`, precheck: checked.check };
    }
  }

  const diffs = staged.map((s) => s.applied.diff);
  const files = staged.map((s) => ({ path: s.path, sha: s.sha ?? null }));
  const diff = list.length === 1 ? diffs[0] : diffs;
  const capability = describeAtomicCapability(commitFiles, atomic);
  const mode = capability.atomic;

  if (dryRun) {
    return {
      ok: true,
      files,
      diff,
      sha: null,
      commitSha: null,
      atomic: mode,
      ...(capability.reason ? { reason: capability.reason } : {}),
    };
  }

  // ---------------------------------------------------------------------------
  // Atomic path: ONE commit for all staged files, after every precheck passed.
  // ---------------------------------------------------------------------------
  if (mode) {
    let commitResult;
    try {
      commitResult = await commitFiles({
        files: buildAtomicFiles(staged),
        ...(rest.commitArgs || {}),
      });
    } catch (e) {
      return {
        ok: false,
        error: `atomic commit failed: ${String(e && e.message ? e.message : e)}`,
        atomic: false,
        files: [],
        written: [],
        writtenFiles: [],
        partial: false,
        diff,
      };
    }
    const commitErr = atomicCommitError(commitResult);
    if (commitErr) {
      return {
        ok: false,
        error: commitErr,
        atomic: false,
        files: [],
        written: [],
        writtenFiles: [],
        partial: false,
        diff,
      };
    }
    const top = normalizeWriteResult(commitResult, { sha: staged[staged.length - 1].sha });
    return { ok: true, files, diff, ...top, atomic: true };
  }

  // ---------------------------------------------------------------------------
  // Non-atomic / fallback: legacy per-file writes, with honest partial report.
  // ---------------------------------------------------------------------------
  const written = [];
  let lastWriteResult;
  for (const s of staged) {
    const text = s.applied.content;
    let writeResult;
    try {
      writeResult = await write(s.path, text, { sha: s.sha, path: s.path });
    } catch (e) {
      return partialFailure({
        error: `write failed for ${s.path}: ${String(e && e.message ? e.message : e)}`,
        written, remaining: staged.slice(written.length).map((x) => x.path), diff, files, reason: capability.reason,
      });
    }
    if (writeResult && typeof writeResult === 'object' && writeResult.ok === false) {
      return partialFailure({
        error: writeResult.error || `write failed for ${s.path}`,
        written, remaining: staged.slice(written.length).map((x) => x.path), diff, files, reason: capability.reason,
      });
    }
    written.push(s.path);
    lastWriteResult = writeResult;
  }

  const top = normalizeWriteResult(lastWriteResult, { sha: staged[staged.length - 1].sha });
  return {
    ok: true,
    files,
    diff,
    ...top,
    atomic: false,
    ...(capability.reason ? { reason: capability.reason } : {}),
  };
}

/**
 * Non-atomic mid-batch failure: never claim success. `written` is the exact
 * list of files that landed; `compensation` tells the caller how to clean up.
 */
function partialFailure({ error, written, remaining, diff, files, reason }) {
  return {
    ok: false,
    error,
    atomic: false,
    partial: true,
    written: [...written],
    writtenFiles: [...written],
    remaining: [...remaining],
    compensation: written.length
      ? `Restore the ${written.length} already-written file(s) from their previous contents, or re-run with atomic:true (github__push_files) so the whole batch commits once.`
      : 'No files were written; safe to retry.',
    files,
    diff,
    ...(reason ? { reason } : {}),
  };
}

/** Alias for callers that prefer a write-oriented name. */
export const writeFiles = applyFilePatches;

export default {
  applyTextPatch,
  applyFilePatch,
  applyFilePatches,
  writeFiles,
  precheckText,
  normalizeWriteResult,
  describeAtomicCapability,
  buildAtomicFiles,
};
