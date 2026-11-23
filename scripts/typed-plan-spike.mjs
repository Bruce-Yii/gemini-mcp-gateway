#!/usr/bin/env node
/**
 * typed-plan-spike.mjs — isolated, non-production prototype of a declarative
 * `plan: [{op, ...}]` executor. Batch 14.
 *
 * Goal: prove that a typed plan (a list of registry-named steps with validated
 * arguments) is a viable *addition to*, never a replacement for, Code Mode.
 * Nothing here is imported by src/, registered as a tool, or wired to any
 * upstream. All I/O is injected via a `deps` object whose defaults are fakes —
 * no network, no credentials, no filesystem writes.
 *
 * Explicit non-goals (documented in docs/ledger/batch-14-typed-plan-spike.md):
 *   - no control flow (if/loop), no free-form JS, no cross-step expressions;
 *   - no production integration, no schema registration, no commit/deploy;
 *   - no attempt to cover every GitHub tool — only the six ops below.
 *
 * Reuse: `applyPatch` delegates its PURE diff logic to
 * `../src/file-write.js::applyTextPatch` rather than re-implementing a unified
 * diff parser. Only the *installation* side (write) is faked here. The report
 * explains exactly what is reused and what is deliberately not copied.
 */

import { applyTextPatch } from '../src/file-write.js';
import { pathToFileURL } from 'node:url';

/**
 * Op registry. Each entry declares:
 *   - effect: 'read' | 'write' — write ops need explicit authorization;
 *   - fields: arg name -> primitive type validator;
 *   - run: async (args, ctx) => result object (fake unless injected).
 *
 * The registry is frozen-style (plain object; never mutated at runtime) so the
 * validator has a single source of truth for both operation names and arg
 * shapes. Adding an op here is the only way to make it executable — unknown
 * ops are rejected before any handler runs.
 */
export const OP_REGISTRY = Object.freeze({
  readFileRange: Object.freeze({
    effect: 'read',
    fields: Object.freeze({ path: 'string', startLine: 'number', endLine: 'number' }),
    run: async (args, ctx) => ctx.io.readFileRange(args),
  }),
  repoGrep: Object.freeze({
    effect: 'read',
    fields: Object.freeze({ pattern: 'string' }),
    optional: Object.freeze({ pathPrefix: 'string', limit: 'number' }),
    run: async (args, ctx) => ctx.io.repoGrep(args),
  }),
  ensureBranch: Object.freeze({
    effect: 'write',
    fields: Object.freeze({ owner: 'string', repo: 'string', branch: 'string' }),
    run: async (args, ctx) => ctx.io.ensureBranch(args),
  }),
  applyPatch: Object.freeze({
    effect: 'write',
    fields: Object.freeze({ path: 'string', patch: 'string' }),
    run: async (args, ctx) => {
      // Reuse the host's pure, strict-context patcher. The read is injected;
      // the returned text is handed to the injected write only when authorized.
      const current = await ctx.io.readFileRange({ path: args.path });
      const text = typeof current === 'string' ? current : current && current.text;
      const applied = applyTextPatch(text == null ? '' : text, args.patch);
      if (!applied.ok) {
        const err = new Error(applied.error);
        err.code = 'PATCH_FAILED';
        throw err;
      }
      if (ctx.dryRun) return { path: args.path, diff: applied.diff ?? {
        added: applied.added, removed: applied.removed, hunks: applied.hunks,
      }, preview: applied.text, dryRun: true };
      return ctx.io.writeFile({ path: args.path, content: applied.text });
    },
  }),
  openPr: Object.freeze({
    effect: 'write',
    fields: Object.freeze({ owner: 'string', repo: 'string', head: 'string', base: 'string', title: 'string' }),
    run: async (args, ctx) => ctx.io.openPr(args),
  }),
  runChecks: Object.freeze({
    // A check runner is nominally read-only, but it can be slow/costly; the
    // prototype treats it as 'read' (no authorization needed) while still
    // allowing a dryRun to skip the actual runner via the fake io.
    effect: 'read',
    fields: Object.freeze({ command: 'string' }),
    run: async (args, ctx) => ctx.io.runChecks(args),
  }),
});

/** Deterministic, dependency-free default fakes. Override with `deps.io`. */
export function createFakeIO(overrides = {}) {
  const files = overrides.files || { 'example.txt': 'one\ntwo\nthree\n' };
  const calls = [];
  const record = (op, args, value) => {
    calls.push({ op, args: { ...args } });
    return value;
  };
  return {
    calls,
    files,
    readFileRange: async (args) => record('readFileRange', args, {
      path: args.path,
      text: files[args.path] ?? '',
      lines: (files[args.path] ?? '').split('\n').slice((args.startLine || 1) - 1, args.endLine),
      truncated: false,
    }),
    repoGrep: async (args) => record('repoGrep', args, { matches: [], pattern: args.pattern }),
    ensureBranch: async (args) => record('ensureBranch', args, { branch: args.branch, created: true }),
    writeFile: async (args) => record('writeFile', args, { path: args.path, written: true }),
    openPr: async (args) => record('openPr', args, { number: 1, head: args.head, base: args.base }),
    runChecks: async (args) => record('runChecks', args, { command: args.command, ok: true }),
    ...overrides,
  };
}

/**
 * Validate one step. Returns an array of human-readable error strings (empty
 * means valid). Validation is purely structural and happens for the WHOLE plan
 * before any handler executes, so a bad step cannot cause side effects.
 *
 * Checks:
 *   - plan itself is a non-empty array of objects;
 *   - op is a known registry key (unknown op rejected);
 *   - all required args present with the correct primitive type (missing /
 *     wrong-type rejected, including NaN rejection for numbers);
 *   - write-effect ops require EITHER a global `dryRun:true` OR an explicit
 *     `approve: true` on that step (approval may also be a global list of ops);
 *   - optional args, when present, are type-checked too.
 */
export function validatePlan(plan, { dryRun = false, approve = [] } = {}) {
  const errors = [];
  if (!Array.isArray(plan) || plan.length === 0) {
    return ['plan must be a non-empty array of steps'];
  }
  const globalApprovals = new Set(Array.isArray(approve) ? approve : (approve ? [approve] : []));
  for (let i = 0; i < plan.length; i += 1) {
    const step = plan[i];
    const at = `step ${i}`;
    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      errors.push(`${at}: must be an object`);
      continue;
    }
    const def = OP_REGISTRY[step.op];
    if (!def) {
      errors.push(`${at}: unknown op ${JSON.stringify(step.op)}`);
      continue;
    }
    for (const [name, type] of Object.entries(def.fields)) {
      if (!(name in step)) {
        errors.push(`${at}: ${step.op} missing required arg "${name}" (expected ${type})`);
        continue;
      }
      const value = step[name];
      const ok = type === 'number'
        ? (typeof value === 'number' && Number.isFinite(value))
        : typeof value === type;
      if (!ok) {
        errors.push(`${at}: ${step.op}.${name} must be ${type}, got ${typeof value}`);
      }
    }
    for (const [name, type] of Object.entries(def.optional || {})) {
      if (name in step) {
        const value = step[name];
        const ok = type === 'number'
          ? (typeof value === 'number' && Number.isFinite(value))
          : typeof value === type;
        if (!ok) errors.push(`${at}: ${step.op}.${name} must be ${type}, got ${typeof value}`);
      }
    }
    // Dangerous-op gate: either the whole plan is a dry run, the step opts in
    // with `approve:true`, or the op name is in the global approval list.
    if (def.effect === 'write' && !dryRun && step.approve !== true && !globalApprovals.has(step.op)) {
      errors.push(`${at}: write op "${step.op}" requires dryRun or explicit approve`);
    }
  }
  return errors;
}

/**
 * Execute a validated plan sequentially. Every step yields a STABLE shape
 * `{ ok, op, result | error }`. On the first failure execution stops; the
 * remaining steps are reported as `{ ok:false, op, error:'skipped' }`? No —
 * skipped steps are NOT emitted at all (a stable trace only contains steps that
 * actually ran). The returned object is:
 *
 *   { ok, dryRun, steps: [{ok,op,result? ,error?}, ...],
 *     stoppedAt: <index|null>, error: <message|null> }
 *
 * Errors from handlers are normalized to strings; thrown non-Errors are
 * stringified deterministically. No handler ever sees the plan as code — only
 * its own already-validated args, so there is no dynamic evaluation.
 */
export async function executePlan(plan, { dryRun = false, approve = [], io } = {}) {
  const validationErrors = validatePlan(plan, { dryRun, approve });
  if (validationErrors.length > 0) {
    return {
      ok: false,
      dryRun,
      steps: [],
      stoppedAt: null,
      error: validationErrors.join('; '),
      validationErrors,
    };
  }
  const ctx = { dryRun, io: io || createFakeIO() };
  const steps = [];
  for (let i = 0; i < plan.length; i += 1) {
    const step = plan[i];
    const def = OP_REGISTRY[step.op];
    // Strip control fields before handing args to a handler.
    const args = { ...step };
    delete args.op;
    delete args.approve;
    try {
      const result = await def.run(args, ctx);
      steps.push({ ok: true, op: step.op, result: result ?? null });
    } catch (e) {
      const message = e && e.code ? `${e.code}: ${e.message}` : String(e && e.message ? e.message : e);
      steps.push({ ok: false, op: step.op, error: message });
      return { ok: false, dryRun, steps, stoppedAt: i, error: `${step.op}: ${message}` };
    }
  }
  return { ok: true, dryRun, steps, stoppedAt: null, error: null };
}

/** Convenience: validate + execute in one call (executePlan already validates). */
export async function runTypedPlan(plan, options = {}) {
  return executePlan(plan, options);
}

export default { OP_REGISTRY, createFakeIO, validatePlan, executePlan, runTypedPlan };

// CLI smoke: `node scripts/typed-plan-spike.mjs` prints one dry-run trace.
// Kept side-effect-free unless invoked directly (not on import by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const sample = [
    { op: 'readFileRange', path: 'example.txt', startLine: 1, endLine: 3 },
    { op: 'applyPatch', path: 'example.txt', patch: '@@ -2,1 +2,1 @@\n-two\n+TWO\n' },
    { op: 'runChecks', command: 'npm test' },
  ];
  const out = await executePlan(sample, { dryRun: true });
  console.log(JSON.stringify(out, null, 2));
}
