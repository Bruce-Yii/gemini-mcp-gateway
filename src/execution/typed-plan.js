/**
 * typed-plan — production-grade, pure typed-plan executor (Batch 14).
 *
 * This module promotes `scripts/typed-plan-spike.mjs` from a throwaway prototype
 * into a standalone, importable module. It is deliberately NOT wired into the
 * MCP tool surface: no tool schema changes, no fourth tool, no route changes.
 * Future integration is described in docs/ledger/batch-14-typed-plan-engine.md
 * (host helper `codemode.runTypedPlan(plan, opts)`).
 *
 * Design constraints (inherited from the spike and the B14 ledger):
 *   - Pure / deterministic: no network, no credentials, no filesystem access
 *     unless the caller injects an `io` adapter. The same (plan, options) pair
 *     always produces the same result shape.
 *   - Injectable op registry: `executeTypedPlan(plan, { ops, io, dryRun, approve,
 *     readOnly, allowTruncatedRead })`. The six built-in ops mirror the spike
 *     exactly; callers can replace or extend the registry without editing this file.
 *   - Strict whole-plan validation BEFORE any handler runs: unknown op, missing
 *     / wrong-type / unknown fields, and write-effect authorization are all
 *     rejected with zero side effects. A bad step cannot leave a partial write.
 *   - Host-only safety gates: write approval comes ONLY from the host-supplied
 *     top-level `approve` option (never from a plan step), and `applyPatch`
 *     refuses truncated reads unless the host opts in with
 *     `allowTruncatedRead:true`. Guest plans cannot forge either gate.
 *   - Stable result on every path: `{ok, dryRun, steps, stoppedAt, error, meta}`.
 *     Steps contain only ops that actually ran — skipped steps are NOT emitted.
 *   - Immutability: the input plan (including frozen plans) is never mutated.
 *   - Reuse, not copy: `applyPatch` delegates its pure diff logic to
 *     `./file-write.js::applyTextPatch` via a relative import. No unified diff
 *     parser is duplicated here.
 *
 * Public API:
 *   - `executeTypedPlan(plan, options)` — validate + execute sequentially.
 *   - `createDefaultOps()` — a fresh, unfrozen-but-private copy of the six ops.
 *   - `DEFAULT_OPS` — the frozen built-in registry (read-only snapshot).
 *   - `validateTypedPlan(plan, options)` — the pure validator (errors array).
 *   - `PLAN_VERSION` / `OP_EFFECTS` — metadata for capture tags.
 */

import { applyTextPatch } from './file-write.js';

/** Plan schema version; bump when op fields or effects change. */
export const PLAN_VERSION = 'v2.0.0';

/**
 * Build the six built-in ops. Each entry declares:
 *   - effect: 'read' | 'write' (write needs dryRun or explicit approve);
 *   - fields: required arg name -> primitive type ('string' | 'number');
 *   - optional: optional arg name -> primitive type;
 *   - run: async (args, ctx) => result object, using only injected ctx.io.
 *
 * Returned as a fresh object so a caller mutating its copy cannot poison the
 * DEFAULT_OPS snapshot. Handlers themselves are shared pure functions.
 */
export function createDefaultOps() {
  return {
    readFileRange: {
      effect: 'read',
      fields: { path: 'string', startLine: 'number', endLine: 'number' },
      optional: {},
      run: async (args, ctx) => ctx.io.readFileRange(args),
    },
    repoGrep: {
      effect: 'read',
      fields: { pattern: 'string' },
      optional: { pathPrefix: 'string', limit: 'number' },
      run: async (args, ctx) => ctx.io.repoGrep(args),
    },
    ensureBranch: {
      effect: 'write',
      fields: { owner: 'string', repo: 'string', branch: 'string' },
      optional: {},
      run: async (args, ctx) => ctx.io.ensureBranch(args),
    },
    applyPatch: {
      effect: 'write',
      fields: { path: 'string', patch: 'string' },
      optional: {},
      run: async (args, ctx) => {
        // Reuse the host's pure strict-context patcher (no duplicated parser).
        const current = await ctx.io.readFileRange({ path: args.path });
        const text = typeof current === 'string' ? current : current && current.text;
        // HIGH (typed-plan audit): a patch built on a truncated read would be
        // applied to a partial file and then written back — silently destroying
        // the tail. Fail closed on the explicit flag OR an in-band marker,
        // before the patcher/dryRun/writeFile runs. Only a host-supplied
        // allowTruncatedRead:true may opt out (default false).
        const truncated = !!current && typeof current === 'object' && current.truncated === true;
        const marker = typeof text === 'string' && text.includes(TRUNCATED_MARKER);
        if ((truncated || marker) && ctx.allowTruncatedRead !== true) {
          const err = new Error(
            'refusing to applyPatch on a truncated read for ' + args.path
            + ': re-read the full file before writing (set allowTruncatedRead:true to override)',
          );
          err.code = 'PATCH_READ_TRUNCATED';
          throw err;
        }
        const applied = applyTextPatch(text == null ? '' : text, args.patch);
        if (!applied.ok) {
          const err = new Error(applied.error);
          err.code = 'PATCH_FAILED';
          throw err;
        }
        if (ctx.dryRun) {
          return {
            path: args.path,
            diff: applied.diff ?? {
              added: applied.added, removed: applied.removed, hunks: applied.hunks,
            },
            preview: applied.text,
            dryRun: true,
          };
        }
        return ctx.io.writeFile({ path: args.path, content: applied.text });
      },
    },
    openPr: {
      effect: 'write',
      fields: {
        owner: 'string', repo: 'string', head: 'string', base: 'string', title: 'string',
      },
      optional: {},
      run: async (args, ctx) => ctx.io.openPr(args),
    },
    runChecks: {
      // Nominally read-only (no authorization needed); a real adapter may be
      // slow/costly but does not mutate repo state. Kept 'read' per the spike.
      effect: 'read',
      fields: { command: 'string' },
      optional: {},
      run: async (args, ctx) => ctx.io.runChecks(args),
    },
  };
}

/** Frozen snapshot of the built-in registry (single source of truth). */
export const DEFAULT_OPS = Object.freeze(createDefaultOps());

/** Effect lookup derived from the registry, for read-only gating + meta. */
export const OP_EFFECTS = Object.freeze(
  Object.fromEntries(Object.entries(DEFAULT_OPS).map(([name, def]) => [name, def.effect])),
);

const CONTROL_FIELDS = new Set(['op', 'approve']);

/** In-band truncation marker used by gateway read/normalization layers. */
const TRUNCATED_MARKER = '--- TRUNCATED ---';

function isPlainStep(step) {
  return !!step && typeof step === 'object' && !Array.isArray(step);
}

function typeMatches(value, type) {
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'boolean') return typeof value === 'boolean';
  return typeof value === type;
}

function approvalSet(approve) {
  if (Array.isArray(approve)) return new Set(approve);
  if (typeof approve === 'string') return new Set([approve]);
  return new Set();
}

/**
 * Pure whole-plan validator. Returns an array of human-readable error strings
 * (empty means valid). No handler runs and no I/O is touched here.
 *
 * Rejections:
 *   - plan not a non-empty array of plain objects;
 *   - unknown op (not present in the injected registry);
 *   - missing required args / wrong primitive type (NaN rejected for numbers);
 *   - unknown fields (anything not `op`, a declared field or an optional field);
 *   - per-step `approve` / `allowTruncatedRead` control fields — approval and
 *     truncated-read overrides are HOST-issued options, never plan data, so a
 *     guest plan cannot self-authorize a real write (APPROVAL_REQUIRES_HOST);
 *   - write-effect ops without dryRun / host-level approve list;
 *   - readOnly mode with any write-effect op (server-side safety boundary).
 */
export function validateTypedPlan(plan, {
  ops = DEFAULT_OPS,
  dryRun = false,
  approve = [],
  readOnly = false,
  allowTruncatedRead = false,
} = {}) {
  const errors = [];
  if (!Array.isArray(plan) || plan.length === 0) {
    return ['plan must be a non-empty array of steps'];
  }
  if (typeof allowTruncatedRead !== 'boolean') {
    errors.push('allowTruncatedRead must be boolean');
  }
  const registry = ops && typeof ops === 'object' && !Array.isArray(ops) ? ops : {};
  const approved = approvalSet(approve);

  for (let i = 0; i < plan.length; i += 1) {
    const at = `step ${i}`;
    const step = plan[i];
    if (!isPlainStep(step)) {
      errors.push(`${at}: must be an object`);
      continue;
    }
    const name = step.op;
    if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(registry, name)) {
      errors.push(`${at}: unknown op ${JSON.stringify(name)}`);
      continue;
    }
    const def = registry[name];
    const fields = (def && def.fields) || {};
    const optional = (def && def.optional) || {};

    for (const [field, type] of Object.entries(fields)) {
      if (!Object.prototype.hasOwnProperty.call(step, field)) {
        errors.push(`${at}: ${name} missing required arg "${field}" (expected ${type})`);
        continue;
      }
      if (!typeMatches(step[field], type)) {
        errors.push(`${at}: ${name}.${field} must be ${type}, got ${typeof step[field]}`);
      }
    }
    for (const [field, type] of Object.entries(optional)) {
      if (Object.prototype.hasOwnProperty.call(step, field) && !typeMatches(step[field], type)) {
        errors.push(`${at}: ${name}.${field} must be ${type}, got ${typeof step[field]}`);
      }
    }

    // Unknown fields: strict allowlist = op + declared/optional fields.
    for (const key of Object.keys(step)) {
      if (key === 'op' || Object.prototype.hasOwnProperty.call(fields, key)
        || Object.prototype.hasOwnProperty.call(optional, key)) continue;
      errors.push(`${at}: unknown field "${key}" for op ${name}`);
    }
    // MEDIUM (typed-plan audit): per-step `approve` is a guest-side forgery of
    // host consent. Reject it explicitly — never treat it as authorization.
    // Same for `allowTruncatedRead`: both are HOST options, not plan data.
    if ('approve' in step) {
      errors.push(`${at}: APPROVAL_REQUIRES_HOST: per-step approve is not allowed; host must pass top-level approve`);
    }
    if ('allowTruncatedRead' in step) {
      errors.push(`${at}: allowTruncatedRead is host-only; per-step override is not allowed`);
    }

    const effect = def && def.effect;
    if (effect === 'write') {
      if (readOnly) {
        errors.push(`${at}: write op "${name}" is not allowed in read-only mode`);
      }
      // Only host-issued authorization counts: dryRun preview, or the global
      // approve whitelist passed in options by the host. Plan steps cannot
      // grant themselves write permission.
      if (!dryRun && !approved.has(name)) {
        errors.push(`${at}: APPROVAL_REQUIRES_HOST: write op "${name}" requires dryRun or explicit approve (host top-level approve only)`);
      }
    }
  }
  return errors;
}

/**
 * Validate + execute a typed plan sequentially.
 *
 * @param {Array} plan ordered list of `{op, ...args}` steps (never mutated)
 * @param {object} [options]
 * @param {object} [options.ops] injectable op registry (defaults to DEFAULT_OPS)
 * @param {object} [options.io] injected adapter; must provide the methods used
 *        by the selected ops. No real adapter is bundled on purpose.
 * @param {boolean} [options.dryRun=false] write ops produce previews only
 * @param {string[]|string} [options.approve=[]] host-issued globally authorized
 *        write op names (or a whitelist token); never read from plan steps
 * @param {boolean} [options.readOnly=false] reject all write-effect ops
 * @param {boolean} [options.allowTruncatedRead=false] host-only opt-out for the
 *        applyPatch truncated-read guard (default false = fail closed)
 * @returns {Promise<{ok:boolean,dryRun:boolean,steps:Array,stoppedAt:number|null,
 *          error:string|null,meta:object,validationErrors?:string[]}>}
 *
 * On validation failure the result has zero steps and a `validationErrors`
 * array. On execution failure `stoppedAt` is the index of the failing step and
 * later steps are absent from `steps`. `meta` is always present and stable:
 * `{ planVersion, readOnly, approvedOps, executedCount }`.
 */
export async function executeTypedPlan(plan, options = {}) {
  const {
    ops = DEFAULT_OPS,
    io,
    dryRun = false,
    approve = [],
    readOnly = false,
    allowTruncatedRead = false,
  } = options || {};
  const registry = ops && typeof ops === 'object' && !Array.isArray(ops) ? ops : {};
  const approved = approvalSet(approve);

  const meta = {
    planVersion: PLAN_VERSION,
    readOnly: readOnly === true,
    approvedOps: [...approved],
    executedCount: 0,
  };
  const validationErrors = validateTypedPlan(plan, {
    ops: registry, dryRun, approve, readOnly, allowTruncatedRead,
  });
  if (validationErrors.length > 0) {
    return {
      ok: false,
      dryRun: dryRun === true,
      steps: [],
      stoppedAt: null,
      error: validationErrors.join('; '),
      meta,
      validationErrors,
    };
  }

  // Fail closed when no I/O adapter is injected: never fall back to real I/O.
  if (!io || typeof io !== 'object') {
    const msg = 'io adapter is required (no default real adapter is bundled)';
    return {
      ok: false,
      dryRun: dryRun === true,
      steps: [],
      stoppedAt: null,
      error: msg,
      meta,
      validationErrors: [msg],
    };
  }

  const ctx = {
    dryRun: dryRun === true,
    readOnly: readOnly === true,
    allowTruncatedRead: allowTruncatedRead === true,
    io,
  };
  const steps = [];
  for (let i = 0; i < plan.length; i += 1) {
    const step = plan[i];
    const def = registry[step.op];
    // Shallow-copy args so control fields can be stripped without touching the
    // caller's plan (works for frozen plans too).
    const args = {};
    for (const [key, value] of Object.entries(step)) {
      if (!CONTROL_FIELDS.has(key)) args[key] = value;
    }
    try {
      const result = await def.run(args, ctx);
      steps.push({ ok: true, op: step.op, result: result ?? null });
      meta.executedCount = steps.length;
    } catch (e) {
      const message = e && e.code ? `${e.code}: ${e.message}` : String(e && e.message ? e.message : e);
      steps.push({ ok: false, op: step.op, error: message });
      meta.executedCount = steps.length;
      return {
        ok: false,
        dryRun: dryRun === true,
        steps,
        stoppedAt: i,
        error: `${step.op}: ${message}`,
        meta,
      };
    }
  }
  return {
    ok: true,
    dryRun: dryRun === true,
    steps,
    stoppedAt: null,
    error: null,
    meta,
  };
}

/** Alias matching the future host helper name documented in the ledger. */
export const runTypedPlan = executeTypedPlan;

export default {
  PLAN_VERSION,
  DEFAULT_OPS,
  OP_EFFECTS,
  createDefaultOps,
  validateTypedPlan,
  executeTypedPlan,
  runTypedPlan,
};
