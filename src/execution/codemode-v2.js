/**
 * codemode-v2 — versioned (/mcp/v2) tool factory for typed plans.
 *
 * This module is deliberately isolated from the v1 surface:
 *   - it NEVER edits `src/codemode.js`, `src/typed-plan.js`, or the v1 `/mcp`
 *     tool definitions; the three tools stay `search`/`execute_read`/`execute`
 *     with identical names, order and annotations on both endpoints;
 *   - v2 only swaps the two execute tools' inputSchema (plan path) and handlers;
 *     the `search` tool object is reused verbatim from v1;
 *   - every registered schema is passed through `sanitizeTool` before it can
 *     reach a client (Gemini hard rule), with flat step objects (no per-op
 *     oneOf), all arrays carrying `items`, and at most two oneOf branches;
 *   - plan execution delegates to the existing `executeTypedPlan` engine — no
 *     duplicated op registry / validator — with read-only and dryRun/approve
 *     enforced server-side before any handler runs.
 *
 * Everything is offline: no network, no credentials, no implicit real I/O.
 * Callers inject `options.typedPlanIO` / `options.typedPlanOps` (the same seams
 * the v1 sandbox helper uses). Without an injected io adapter the engine fails
 * closed with a stable validation error and zero side effects.
 */

import { createCodeModeTools, toModelOutput, fileTextFromRaw } from './codemode.js';
import { sanitizeTool } from '../shared/sanitize.js';
import {
  executeTypedPlan,
  PLAN_VERSION,
  OP_EFFECTS,
} from './typed-plan.js';
import { unwrapResult } from './tool-format.js';
import { captureEvent } from '../evidence/capture.js';

/** Protocol/plan labels added additively to every v2 plan result. */
export const PROTOCOL_VERSION = 'v2';
export const V2_PROFILE = 'S';

/* -------------------------------------------------------------------------- *
 * Schemas (design: docs/ledger/batch-14-typed-plan-v2.md §2)
 * -------------------------------------------------------------------------- */

const READ_OPS = ['readFileRange', 'repoGrep', 'runChecks'];
const ALL_OPS = [...READ_OPS, 'ensureBranch', 'applyPatch', 'openPr'];
const WRITE_OPS = Object.entries(OP_EFFECTS)
  .filter(([, effect]) => effect === 'write')
  .map(([name]) => name); // ensureBranch, applyPatch, openPr

// Flat step properties shared by both endpoints. Types only; per-op required
// fields are validated server-side by validateTypedPlan (no per-op oneOf).
const STEP_PROPERTIES = {
  op: { type: 'string' },
  path: { type: 'string' },
  startLine: { type: 'integer', minimum: 1 },
  endLine: { type: 'integer', minimum: 1 },
  pattern: { type: 'string' },
  pathPrefix: { type: 'string' },
  limit: { type: 'integer', minimum: 1 },
  command: { type: 'string' },
  owner: { type: 'string' },
  repo: { type: 'string' },
  branch: { type: 'string' },
  patch: { type: 'string' },
  head: { type: 'string' },
  base: { type: 'string' },
  title: { type: 'string' },
  approve: { type: 'boolean' },
};

function stepSchema(ops) {
  return {
    type: 'object',
    description: 'A single typed op. `op` selects the registry entry; all other fields are that op\'s validated args.',
    additionalProperties: false,
    properties: {
      ...STEP_PROPERTIES,
      op: {
        type: 'string',
        enum: ops,
        description: 'Registry op name. Unknown ops are rejected before any step runs.',
      },
    },
    required: ['op'],
  };
}

// Inline the step schema (rather than $ref) so clients that do not resolve
// $defs still see a complete, sanitize-safe array-of-objects shape.
function planSchema(ops) {
  return {
    type: 'array',
    description: 'Ordered typed steps. Schema guarantees types; the server validates per-op fields.',
    items: stepSchema(ops),
    minItems: 1,
    maxItems: 64,
  };
}

const EXECUTE_READ_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { plan: planSchema(READ_OPS) },
  required: ['plan'],
};

const EXECUTE_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  // Two object-level branches only (well below the Gemini oneOf cap of 8).
  // Both present => both branches match => oneOf fails (plus server checks).
  oneOf: [{ required: ['plan'] }, { required: ['code'] }],
  properties: {
    plan: planSchema(ALL_OPS),
    code: {
      type: 'string',
      description: 'Fallback only: an async arrow function using codemode.<tool>(args) for logic the op registry cannot express.',
    },
    dryRun: {
      type: 'boolean',
      default: false,
      description: 'Plan-level gate: when true write ops only produce previews; no real side effect.',
    },
    approve: {
      type: 'array',
      description: 'Op names explicitly authorized for real writes (alternative to per-step approve). Ignored when dryRun is true.',
      items: { type: 'string', enum: WRITE_OPS },
      uniqueItems: true,
    },
  },
};

// Exported for tests: sanitized schemas must be inspectable without a server.
export const V2_EXECUTE_READ_INPUT_SCHEMA = sanitizeTool({
  name: 'execute_read',
  inputSchema: EXECUTE_READ_INPUT_SCHEMA,
}).inputSchema;
export const V2_EXECUTE_INPUT_SCHEMA = sanitizeTool({
  name: 'execute',
  inputSchema: EXECUTE_INPUT_SCHEMA,
}).inputSchema;

/* -------------------------------------------------------------------------- *
 * Handlers
 * -------------------------------------------------------------------------- */

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

/** Default per-execute I/O budget, kept in sync with v1 `DEFAULT_MAX_CALLS`. */
const DEFAULT_V2_MAX_CALLS = 50;

/* -------------------------------------------------------------------------- *
 * R-02 · v2 plan I/O budget (F-04 residual)
 *
 * v1 charges every upstream I/O (tool calls, runTypedPlan IO, github_actions_*)
 * against a single per-execute `chargeBudget` counter that throws a stable
 * TOOL_CALL_LIMIT_EXCEEDED error. The v2 `makePlanHandler` used to call
 * `executeTypedPlan` directly, bypassing that counter: a 64-step plan whose IO
 * adapter performs multiple upstream calls (or a custom IO adapter) could do
 * unbounded I/O. We now wrap every IO adapter method (except the local
 * `runChecks` stub, matching v1) with an equivalent charge so the same
 * `maxCalls` budget applies and the over-budget error code is stable.
 * -------------------------------------------------------------------------- */
function makeChargeBudget(maxCalls) {
  let calls = 0;
  const limit = Number.isFinite(maxCalls) && maxCalls >= 0 ? maxCalls : DEFAULT_V2_MAX_CALLS;
  return {
    charge(kind = 'typedPlanV2') {
      calls += 1;
      if (calls > limit) {
        const err = new Error(`tool call limit (${limit}) exceeded`);
        err.code = 'TOOL_CALL_LIMIT_EXCEEDED';
        err.kind = kind;
        throw err;
      }
    },
    remaining() { return Math.max(0, limit - calls); },
  };
}

/** Wrap each IO method so each invocation consumes the shared plan budget. */
function budgetIO(io, budget) {
  if (!io || typeof io !== 'object') return io;
  const wrapped = {};
  for (const [name, fn] of Object.entries(io)) {
    // `runChecks` is a local stub in v1 and does not consume the budget;
    // do the same here for parity with the v1 typed-plan IO semantics.
    wrapped[name] = (typeof fn === 'function' && name !== 'runChecks')
      ? (...args) => { budget.charge('typedPlanV2'); return fn(...args); }
      : fn;
  }
  return wrapped;
}

/* -------------------------------------------------------------------------- *
 * G-03 · real default I/O adapter for /mcp/v2 plans
 *
 * Root cause: the original v2 `makePlanHandler` only passed `io` when the caller
 * injected `options.typedPlanIO`; otherwise it called `executeTypedPlan` with no
 * adapter and the engine's intentional fail-closed branch returned
 * "io adapter is required". That made every /mcp/v2 plan — even pure reads —
 * unusable on the real gateway, unlike v1 `codemode.runTypedPlan`, which builds
 * a REAL adapter from the upstream tool bridge when no adapter is injected
 * (`createDefaultTypedPlanIO` in src/codemode.js).
 *
 * Fix: use the SAME injection seam as v1. When `typedPlanIO` is supplied we wrap
 * it with the per-plan budget (as before); when it is not, we build a default
 * adapter from the SAME two dependencies v1 uses — `upstreamManager.getEntries()`
 * and `upstreamManager.callTool()` — charging each upstream invocation against
 * the same budget. `src/codemode.js` and the three v1 tools/schemas are NOT
 * touched. With a real manager present the v2 plan path is now executable;
 * only when no usable upstream adapter can be constructed (e.g. a manager with
 * no tool bridge) do we leave `io` absent and let the engine fail closed with
 * its explicit error — zero side effects, never a silent fallback.
 * -------------------------------------------------------------------------- */

function resolveTypedPlanTool(tools, candidates) {
  const list = Array.isArray(tools) ? tools : [];
  for (const wanted of candidates) {
    const hit = list.find((t) => {
      const name = String(t?.name ?? t?.tool ?? '');
      return name === wanted || name.endsWith(`__${wanted}`);
    });
    if (hit) return hit;
  }
  return null;
}

/**
 * Build the default REAL io adapter from the upstream tool bridge. This mirrors
 * v1's `createDefaultTypedPlanIO`: read ops reuse the upstream get/list tools,
 * write ops go through the file/branch/PR tools, and every upstream invocation
 * consumes `charge` (the same per-plan budget). Returns null when the manager
 * exposes no usable tool bridge, so the caller can fail closed explicitly.
 */
function createDefaultV2TypedPlanIO({ tools, callTool, charge }) {
  if (typeof callTool !== 'function') return null;
  const toolName = (t) => String(t?.name ?? t?.tool ?? '');
  const readTool = resolveTypedPlanTool(tools, ['get_file_contents']);
  const listTool = resolveTypedPlanTool(tools, ['list_repo_contents', 'list_directory_contents', 'list_repository_content', 'list_files']);
  const writeTool = resolveTypedPlanTool(tools, ['create_or_update_file', 'push_files']);
  const branchListTool = resolveTypedPlanTool(tools, ['list_branches']);
  const branchCreateTool = resolveTypedPlanTool(tools, ['create_branch']);
  const prListTool = resolveTypedPlanTool(tools, ['list_pull_requests']);
  const prCreateTool = resolveTypedPlanTool(tools, ['create_pull_request']);
  const prUpdateTool = resolveTypedPlanTool(tools, ['update_pull_request']);

  // A manager without any recognised upstream tool cannot execute a plan.
  if (!readTool && !listTool && !writeTool) return null;

  const invoke = async (tool, args) => {
    if (!tool) throw new Error('typed-plan io: required upstream tool is unavailable');
    if (charge) charge();
    return unwrapResult(await callTool(tool.server, tool.tool, args ?? {}));
  };
  const fileText = (raw) => fileTextFromRaw(raw, { normalizeName: toolName(readTool) || 'get_file_contents' });

  return {
    readFileRange: async (args) => {
      const raw = await invoke(readTool, {
        owner: args.owner, repo: args.repo, path: args.path,
        ...(args.ref !== undefined ? { ref: args.ref } : {}),
      });
      const { text, sha, truncated } = fileText(raw);
      if (text === null) throw new Error(`readFileRange: no file text for ${args.path}`);
      const allLines = text.replace(/\r\n?/g, '\n').split('\n');
      const totalLines = allLines.length;
      const start = Number.isFinite(args.startLine) ? Math.max(1, Math.floor(args.startLine)) : 1;
      const end = Number.isFinite(args.endLine)
        ? Math.max(start - 1, Math.min(totalLines, Math.floor(args.endLine)))
        : totalLines;
      return {
        path: args.path,
        text,
        sha,
        lines: allLines.slice(start - 1, end),
        totalLines,
        truncated: truncated === true || start > 1 || end < totalLines ? true : truncated ?? null,
      };
    },
    repoGrep: async (args) => {
      if (!listTool) throw new Error('repoGrep: no repository list tool is available in this session');
      const listed = await invoke(listTool, { owner: args.owner, repo: args.repo, path: args.pathPrefix });
      const entries = Array.isArray(listed) ? listed : (listed?.items ?? listed?.data ?? []);
      const files = entries.map((e) => (typeof e === 'string' ? e : e?.path ?? e?.name)).filter((p) => typeof p === 'string' && p.length);
      const limit = Number.isFinite(args.limit) && args.limit > 0 ? args.limit : 50;
      let re;
      try { re = new RegExp(args.pattern, 'i'); } catch (e) { throw new Error(`repoGrep: invalid pattern: ${e.message}`); }
      const matches = [];
      let truncated = false;
      for (const file of files) {
        if (matches.length >= limit) { truncated = true; break; }
        const raw = await invoke(readTool, { owner: args.owner, repo: args.repo, path: file });
        const { text, truncated: fileTruncated } = fileText(raw);
        if (text === null) continue;
        if (fileTruncated === true) truncated = true;
        text.replace(/\r\n?/g, '\n').split('\n').forEach((line, i) => {
          if (matches.length < limit && re.test(line)) matches.push({ path: file, line: i + 1, text: line });
        });
      }
      return { pattern: args.pattern, matches, truncated };
    },
    ensureBranch: async (args) => {
      const branches = branchListTool ? await invoke(branchListTool, { owner: args.owner, repo: args.repo }) : [];
      const names = (Array.isArray(branches) ? branches : (branches?.branches ?? [])).map((b) => (typeof b === 'string' ? b : b?.name));
      if (names.includes(args.branch)) return { branch: args.branch, created: false, reused: true };
      const created = await invoke(branchCreateTool, { owner: args.owner, repo: args.repo, branch: args.branch });
      return { branch: args.branch, created: true, reused: false, result: created };
    },
    writeFile: async (args) => {
      const written = await invoke(writeTool, {
        owner: args.owner, repo: args.repo, path: args.path,
        content: args.content, message: args.message ?? 'typed-plan write',
        ...(args.branch !== undefined ? { branch: args.branch } : {}),
        ...(args.sha !== undefined ? { sha: args.sha } : {}),
      });
      return { path: args.path, written: true, result: written };
    },
    openPr: async (args) => {
      if (prListTool) {
        const prs = await invoke(prListTool, { owner: args.owner, repo: args.repo, head: args.head, base: args.base, state: 'open' });
        const found = (Array.isArray(prs) ? prs : (prs?.items ?? [])).find(
          (pr) => pr?.head?.ref === args.head && pr?.base?.ref === args.base && String(pr?.state ?? 'open').toLowerCase() === 'open',
        );
        if (found) {
          const updated = prUpdateTool
            ? await invoke(prUpdateTool, { owner: args.owner, repo: args.repo, pullNumber: found.number, title: args.title })
            : found;
          return { number: found.number, created: false, updated: true, result: updated };
        }
      }
      const created = await invoke(prCreateTool, {
        owner: args.owner, repo: args.repo, head: args.head, base: args.base, title: args.title,
      });
      return { number: created?.number ?? null, created: true, updated: false, result: created };
    },
    runChecks: async (args) => ({ command: args.command, ok: true, skipped: true, reason: 'no host check runner is wired for typed plans' }),
  };
}

/** Descriptive, model-correctable validation error (E-VAL-*). */
function validationFailure(code, message) {
  return {
    ok: false,
    dryRun: false,
    steps: [],
    stoppedAt: null,
    error: `${code}: ${message}`,
    validationErrors: [`${code}: ${message}`],
    meta: {
      protocolVersion: PROTOCOL_VERSION,
      planVersion: PLAN_VERSION,
      profile: V2_PROFILE,
      fallback: null,
    },
  };
}

/** Attach v2 labels to an engine result without touching its stable step shape. */
function tagPlanResult(result, { dryRun }) {
  return {
    ...result,
    // The engine's dryRun reflects the option we pass it; keep it authoritative.
    dryRun: result.dryRun === true || dryRun === true,
    meta: {
      ...(result.meta ?? {}),
      protocolVersion: PROTOCOL_VERSION,
      planVersion: PLAN_VERSION,
      profile: V2_PROFILE,
      fallback: null,
    },
  };
}

/**
 * Build the plan handler shared by execute_read / execute.
 *
 * @param {boolean} readOnly read-only endpoint rejects write-effect ops even if
 *        a client bypasses the schema enum (server-side safety boundary).
 */
function makePlanHandler({ readOnly, options, upstreamManager }) {
  return async (args) => {
    const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
    if (!hasOwn(a, 'plan')) {
      // execute_read has no code fallback; execute's code fallback is handled
      // by the code branch below, so a plan handler must always receive plan.
      return validationFailure('E-VAL-PLAN', 'plan is required');
    }

    const dryRun = readOnly ? false : a.dryRun === true;
    const approve = readOnly ? [] : a.approve;
    // R-02: each plan execution gets a fresh I/O budget of `maxCalls`, matching
    // v1's per-execute chargeBudget semantics. Every adapter method invocation
    // (except runChecks) is charged before the underlying I/O runs, so an
    // over-budget plan stops with a stable TOOL_CALL_LIMIT_EXCEEDED error.
    const budget = makeChargeBudget(options.maxCalls);
    try {
      const rawIO = options.typedPlanIO && typeof options.typedPlanIO === 'object'
        ? options.typedPlanIO : null;
      // G-03: same injection seam as v1. A caller-supplied adapter is wrapped
      // with the budget; otherwise build a REAL adapter from the same upstream
      // tool bridge v1 uses. If neither exists, leave `io` absent and let the
      // engine fail closed with its explicit error (zero side effects).
      let io;
      if (rawIO) {
        io = budgetIO(rawIO, budget);
      } else {
        const tools = upstreamManager?.getEntries?.() ?? [];
        io = createDefaultV2TypedPlanIO({
          tools,
          callTool: (server, tool, callArgs) => upstreamManager?.callTool?.(server, tool, callArgs),
          charge: () => budget.charge('typedPlanV2'),
        });
      }
      const result = await executeTypedPlan(a.plan, {
        ...(io ? { io } : {}),
        ...(options.typedPlanOps && typeof options.typedPlanOps === 'object'
          ? { ops: options.typedPlanOps } : {}),
        dryRun,
        approve,
        readOnly,
      });
      captureEvent('typed_plan_v2', {
        tool: readOnly ? 'execute_read' : 'execute',
        plan: a.plan,
        dryRun,
        approve,
        result,
      });
      return tagPlanResult(result, { dryRun });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return validationFailure('E-VAL-HANDLER', `typed plan execution failed: ${message}`);
    }
  };
}

/**
 * Versioned tool factory. Reuses the v1 `search` tool object verbatim, then
 * replaces the two execute tools' schema + handler while keeping their names,
 * order, descriptions and annotations identical to v1.
 *
 * @param {import('./upstreams.js').UpstreamManager} upstreamManager
 * @param {object} [options] same runtime deps as createCodeModeTools plus
 *        `typedPlanIO` / `typedPlanOps` for offline-safe plan execution.
 * @returns {Array<object>} [search, execute_read, execute]
 */
export function createCodeModeToolsV2(upstreamManager, options = {}) {
  // Start from the v1 factory so `search` (including its description, schema,
  // annotations and handler) is byte-for-byte the v1 tool. We only rewrite the
  // two execute slots below.
  const [searchTool, v1Read, v1Exec] = createCodeModeTools(upstreamManager, options);

  const readOnlyHandler = makePlanHandler({ readOnly: true, options, upstreamManager });
  const writeHandler = makePlanHandler({ readOnly: false, options, upstreamManager });
  const v1WriteHandler = v1Exec.handler;
  const profile = options.profile;

  const readTool = {
    ...v1Read,
    inputSchema: V2_EXECUTE_READ_INPUT_SCHEMA,
    handler: readOnlyHandler,
  };

  const execTool = {
    ...v1Exec,
    inputSchema: V2_EXECUTE_INPUT_SCHEMA,
    handler: async (args) => {
      const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
      const hasCode = hasOwn(a, 'code');
      const hasPlan = hasOwn(a, 'plan');

      // Layer 2/3 defence: even if sanitize downgrades oneOf to anyOf, the
      // server rejects both-present and neither-present inputs explicitly.
      if (hasCode && hasPlan) {
        return validationFailure('E-VAL-BOTH', 'provide either "plan" or "code", not both');
      }
      if (!hasCode && !hasPlan) {
        return validationFailure('E-VAL-NONE', 'exactly one of "plan" or "code" is required');
      }
      if (hasPlan) {
        // A plan branch must not smuggle a code field (defence in depth).
        if (a.code !== undefined) {
          return validationFailure('E-VAL-BOTH', 'provide either "plan" or "code", not both');
        }
        return writeHandler(a);
      }
      // Code fallback: reuse the v1 handler (runInSandbox -> toModelOutput),
      // preserving the exact projection and audit behaviour. Add the additive
      // fallback tag so the S lane can tell a code fallback from a real plan.
      const out = await v1WriteHandler(a);
      const wire = out && typeof out === 'object' && typeof out.toJSON === 'function'
        ? out.toJSON() : out;
      const result = toModelOutput(wire, profile);
      if (result && typeof result === 'object' && !Array.isArray(result)) {
        const existing = result.result && typeof result.result === 'object' && !Array.isArray(result.result)
          ? result.result : {};
        return {
          ...result,
          result: {
            ...existing,
            meta: {
              ...(existing.meta ?? {}),
              protocolVersion: PROTOCOL_VERSION,
              planVersion: PLAN_VERSION,
              profile: V2_PROFILE,
              fallback: {
                reason: 4,
                attemptPlan: false,
                atStep: null,
              },
            },
          },
        };
      }
      return result;
    },
  };

  return [searchTool, readTool, execTool];
}

export default { createCodeModeToolsV2, PROTOCOL_VERSION, V2_PROFILE, PLAN_VERSION };
