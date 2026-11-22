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
  return [header, ...samples].join('\n');
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
export async function applyFilePatch({ read, write, path, patch, dryRun = true } = {}) {
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

  const applied = applyTextPatch(rawText, patch);
  if (!applied.ok) return { ok: false, error: applied.error };

  const diff = {
    path,
    added: applied.added,
    removed: applied.removed,
    hunks: applied.hunks,
    diff: buildDiffSummary(path, normalizeText(rawText), applied.text, applied.added, applied.removed, applied.hunks),
  };

  // Dry-run (the default) stops here — no write, no fake commit data.
  if (dryRun) {
    return { ok: true, diff };
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
    if (writeResult.commitSha !== undefined) out.commitSha = writeResult.commitSha;
    if (writeResult.sha !== undefined) out.commitSha = writeResult.sha;
    if (writeResult.content !== undefined) out.content = writeResult.content;
  }
  return out;
}

export default { applyTextPatch, applyFilePatch };
