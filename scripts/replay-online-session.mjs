#!/usr/bin/env node
/**
 * Offline replay harness for a real "online session" capture.
 *
 * Goal: make semi-online (L1/G6) evaluation closer to the real online window
 * by replaying the SAME prompt / SAME tool args / SAME client profile against
 * the CURRENT checkout, then diffing current output against the recorded
 * online output. It is a harness for evidence, not a verdict engine.
 *
 * HARD BOUNDARIES (inherit AGENTS.md + docs/eval/ONLINE-FEEDBACK.md):
 *   - 100% offline: no network, no R2, no production, no credentials.
 *   - No writes to src/ or any repo file. stdout only from the CLI.
 *   - Read-only tools are replayed; WRITE tools default to `dryRun:true`
 *     and are never really executed. An injected `upstream` may implement a
 *     real-looking write, but this harness never calls a write path for real.
 *   - `fetch` / `upstream` are injectable, so tests can run with a fake.
 *   - requestId / sessionId are NEVER invented: missing -> 'unknown'.
 *   - Model-provider / client-host behaviour is NOT reproducible offline and
 *     is reported as `not-comparable`, never as pass/fail.
 *
 * Input: an array of `gmg.capture.v1` envelopes (src/capture.js), or a fixture
 * from `createFakeSession()`. Envelopes are read-only: extraction never mutates
 * them.
 *
 * Usage:
 *   node scripts/replay-online-session.mjs <captures.json> [--fixture]
 *   node scripts/replay-online-session.mjs --fixture --stdin   # emit fixture JSON
 *
 * Pure API (tests / other scripts):
 *   extractSession, buildReplayPlan, replayPlan, diffReplay, classifyField,
 *   createFakeSession, toJson, main
 */

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const SCHEMA = 'online-replay.v1';
export const UNKNOWN = 'unknown';

/** Diff classification vocabulary. */
export const DIFF_STATUSES = Object.freeze(['pass', 'diff', 'not-comparable']);
/** Overall comparison verdict vocabulary. */
export const VERDICTS = Object.freeze(['pass', 'diff', 'partial', 'not-comparable']);

// Fields that belong to the client host / model provider / transport, not to
// the gateway code under test. They are reported, but never judged.
export const NOT_COMPARABLE_FIELDS = Object.freeze([
  'clientHost',
  'clientInfo',
  'oauthClientId',
  'model',
  'modelProvider',
  'durationMs',
  'responseBytes',
  'ts',
  'deployment',
  'hostUserAgent',
]);

// Tool names / prefixes that identify write operations. Offline replay of
// these uses dryRun only; the result is a *simulation*, never a real mutation.
// Writes appear either snake_case (`create_or_update_file`), camelCase
// (`applyFilePatch`, `pushFiles`) or as a bare verb. Match all three so a
// write can never slip through to a real execution path.
const WRITE_VERBS = 'write|create|update|delete|remove|patch|push|edit|set|merge|commit|upload|apply|post|put';
// A verb counts as a write when bounded by separators, by a camelCase upper
// letter, or by start/end. `(?:^|[_\\s-]|[a-z])` covers `github__push_files`,
// `github__applyFilePatch` and `createBranch` without matching `get_file`.
const WRITE_MARKERS = new RegExp(
  `(?:^|[_\\s-]|[a-z])(${WRITE_VERBS})(?:[_\\s-]|$|[A-Z])|draft|__execute$`,
  'i',
);

/** Stable string id from an envelope, never a fabricated UUID. */
function idOf(value) {
  return value === null || value === undefined || value === '' ? UNKNOWN : String(value);
}

/** True for a non-empty string. */
function isText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Deterministic JSON value clone (arrays/objects only; no dates/functions). */
function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/** Stable deep-equal that tolerates object key ordering. */
function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const key of ak) {
    if (!Object.prototype.hasOwnProperty.call(b, key) || !deepEqual(a[key], b[key])) return false;
  }
  return true;
}

/** Canonical JSON for hashing / exactness, with stable key order. */
export function canonicalJson(value) {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/* ------------------------------------------------------------------ *
 * 1. Extraction: capture envelope(s) -> normalized online session
 * ------------------------------------------------------------------ */

function mcpInfo(raw) {
  if (!isText(raw)) return { method: null, prompt: null, tool: null, toolArgs: null };
  try {
    const body = JSON.parse(raw);
    const method = typeof body?.method === 'string' ? body.method : null;
    // Code Mode stores the user prompt in params.arguments.code.
    const prompt = isText(body?.params?.arguments?.code)
      ? body.params.arguments.code
      : (isText(body?.params?.arguments?.prompt) ? body.params.arguments.prompt : null);
    return {
      method,
      prompt,
      tool: typeof body?.params?.name === 'string' ? body.params.name : null,
      toolArgs: body?.params?.arguments ?? null,
    };
  } catch {
    return { method: null, prompt: null, tool: null, toolArgs: null };
  }
}

function toolsListFromEnvelope(envelope) {
  // tools/list snapshot can be carried explicitly by a fixture, or found in
  // a response.raw of a tools/list request. Never synthesized from tool names.
  if (Array.isArray(envelope?.toolsListSnapshot)) return clone(envelope.toolsListSnapshot);
  const info = mcpInfo(envelope?.request?.raw);
  if (info.method !== 'tools/list') return null;
  try {
    const raw = envelope?.response?.raw;
    const body = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const tools = body?.result?.tools ?? body?.tools;
    if (Array.isArray(tools)) return clone(tools);
  } catch { /* not parseable: no snapshot */ }
  return null;
}

/**
 * Extract a normalized, read-only "online session" from capture envelopes.
 * Envelope shape follows src/capture.js (gmg.capture.v1):
 *   requestId, sessionId, ts, clientPlatform/clientProfile, clientInfo,
 *   deployment, request.raw (JSON-RPC), events[] (upstream / sandbox),
 *   response.raw / model.
 *
 * Returns a deterministic object; never mutates input. Missing identities are
 * 'unknown'. Tool calls keep name/args/result (and isError) verbatim from the
 * `upstream` events; the code prompt comes from `sandbox` events.
 */
export function extractSession(input) {
  let envelopes = [];
  if (Array.isArray(input)) envelopes = input;
  else if (input && typeof input === 'object' && Array.isArray(input.envelopes)) envelopes = input.envelopes;
  else if (isText(input)) {
    const parsed = JSON.parse(input);
    envelopes = Array.isArray(parsed) ? parsed : (parsed?.envelopes ?? [parsed]);
  }
  const valid = envelopes.filter((e) => e && typeof e === 'object' && !Array.isArray(e));

  const sessionIds = new Set();
  const requestIds = [];
  const clientPlatforms = new Set();
  const clientProfiles = new Set();
  const models = new Set();
  const deployments = new Set();
  const prompts = [];
  const toolCalls = [];
  let toolsListSnapshot = null;
  let firstTs = null;
  let lastTs = null;

  for (const envelope of valid) {
    const sessionId = idOf(envelope.sessionId ?? envelope.request?.sessionId);
    if (sessionId !== UNKNOWN) sessionIds.add(sessionId);
    const requestId = idOf(envelope.requestId ?? envelope.request?.id ?? envelope.id);
    requestIds.push(requestId);

    const platform = idOf(envelope.clientPlatform);
    const profile = idOf(envelope.clientProfile);
    if (platform !== UNKNOWN) clientPlatforms.add(platform);
    if (profile !== UNKNOWN) clientProfiles.add(profile);

    // Model attribution is host/provider-owned; record it, never infer it.
    const model = envelope.model ?? envelope.request?.model ?? null;
    if (model !== null && model !== undefined) models.add(canonicalJson(model));
    const deployment = idOf(envelope.deployment);
    if (deployment !== UNKNOWN) deployments.add(deployment);

    const ts = envelope.ts ?? envelope.timestamp ?? envelope.request?.ts ?? null;
    if (typeof ts === 'string') {
      if (firstTs === null || ts < firstTs) firstTs = ts;
      if (lastTs === null || ts > lastTs) lastTs = ts;
    }

    const info = mcpInfo(envelope.request?.raw);
    if (info.prompt !== null) prompts.push(info.prompt);

    const snap = toolsListFromEnvelope(envelope);
    if (snap && !toolsListSnapshot) toolsListSnapshot = snap;

    for (const event of Array.isArray(envelope.events) ? envelope.events : []) {
      const type = event?.type;
      if (type === 'upstream') {
        const payload = event.payload ?? {};
        toolCalls.push({
          requestId,
          name: idOf(payload.tool ? `${idOf(payload.server)}__${payload.tool}` : (payload.name ?? payload.tool)),
          args: clone(payload.args ?? {}),
          result: payload.error !== undefined
            ? { error: clone(payload.error) }
            : clone(payload.result ?? null),
          isError: payload.error !== undefined || payload.result?.isError === true,
          cacheHit: payload.cacheHit === true,
        });
      } else if (type === 'sandbox' && isText(event?.payload?.code)) {
        if (!prompts.includes(event.payload.code)) prompts.push(event.payload.code);
      }
    }
  }

  // Deterministic ordering: stable sort by requestId then appearance index.
  const seen = new Map();
  toolCalls.forEach((call, index) => {
    const key = `${call.requestId}\u0000${canonicalJson(call.name)}\u0000${canonicalJson(call.args)}`;
    const prev = seen.get(key);
    if (!prev) seen.set(key, { call, index, count: 1 });
    else prev.count += 1;
  });
  const orderedCalls = [...seen.values()]
    .sort((a, b) => a.call.requestId.localeCompare(b.call.requestId)
      || String(a.call.name).localeCompare(String(b.call.name))
      || a.index - b.index)
    .map(({ call }) => call);

  // Timeline: one row per envelope, sorted by (ts, requestId, original index).
  const indexed = valid.map((envelope, index) => ({
    index,
    requestId: idOf(envelope.requestId ?? envelope.request?.id ?? envelope.id),
    ts: envelope.ts ?? envelope.timestamp ?? envelope.request?.ts ?? null,
    method: mcpInfo(envelope.request?.raw).method,
  }));
  indexed.sort((a, b) => {
    const ta = typeof a.ts === 'string' ? a.ts : '';
    const tb = typeof b.ts === 'string' ? b.ts : '';
    if (ta !== tb) return ta.localeCompare(tb);
    if (a.requestId !== b.requestId) return a.requestId.localeCompare(b.requestId);
    return a.index - b.index;
  });

  return {
    schema: SCHEMA,
    source: 'capture',
    clientPlatform: [...clientPlatforms][0] ?? UNKNOWN,
    clientProfile: [...clientProfiles][0] ?? UNKNOWN,
    oauthClientId: idOf(valid.find((e) => idOf(e.oauthClientId) !== UNKNOWN)?.oauthClientId),
    model: models.size ? [...models][0] : null,
    deployment: [...deployments][0] ?? UNKNOWN,
    sessionId: [...sessionIds][0] ?? UNKNOWN,
    requestIds,
    window: { from: firstTs ?? UNKNOWN, to: lastTs ?? UNKNOWN },
    prompts: [...new Set(prompts)],
    toolsListSnapshot,
    toolCalls: orderedCalls,
    timeline: indexed.map(({ requestId, ts, method }) => ({ requestId, ts: ts ?? UNKNOWN, method: method ?? UNKNOWN })),
  };
}

/* ------------------------------------------------------------------ *
 * 2. Fixture: deterministic fake session (no real capture)
 * ------------------------------------------------------------------ */

/**
 * Build a deterministic fake online session for tests/docs. No UUIDs are
 * invented: requestId/sessionId default to 'unknown' unless explicitly supplied
 * by the caller as fixture metadata (still not a claim about production).
 */
export function createFakeSession(options = {}) {
  const {
    seed = 'fixture-2026-11-23',
    requestId = UNKNOWN,
    sessionId = UNKNOWN,
    includeWrite = true,
    withTruncation = false,
  } = options;
  const readCall = {
    requestId,
    name: 'github__get_file_contents',
    args: { owner: 'test-org', repo: 'test-repo', path: 'README.md', ref: 'main' },
    result: {
      content: [{ type: 'text', text: JSON.stringify({ ok: true, fixture: seed, body: 'line 1\nline 2\n' }) }],
    },
    isError: false,
    cacheHit: false,
  };
  const writeCall = {
    requestId,
    name: 'github__create_or_update_file',
    args: {
      owner: 'test-org', repo: 'test-repo', path: 'work/fixture.txt',
      content: 'one\ntwo\n', message: 'test: fixture write', dryRun: true,
    },
    result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, dryRun: true, fixture: seed }) }] },
    isError: false,
    cacheHit: false,
  };
  if (withTruncation) {
    readCall.result.content[0].text += '\n--- TRUNCATED ---';
  }
  const toolCalls = [readCall, ...(includeWrite ? [writeCall] : [])];
  return {
    schema: SCHEMA,
    source: 'fixture',
    fixtureSeed: seed,
    clientPlatform: 'gemini',
    clientProfile: 'gemini-text-json',
    oauthClientId: UNKNOWN,
    model: null,
    deployment: 'fixture-checkout',
    sessionId,
    requestIds: [requestId],
    window: { from: '2026-11-23T00:00:00Z', to: '2026-11-23T23:59:59Z' },
    prompts: ['async () => { return await codemode.github__get_file_contents({owner:"test-org",repo:"test-repo",path:"README.md",ref:"main"}); }'],
    toolsListSnapshot: [
      { name: 'github__get_file_contents', description: 'fixture read', inputSchema: { type: 'object', properties: {} } },
      { name: 'github__create_or_update_file', description: 'fixture write', inputSchema: { type: 'object', properties: {} } },
    ],
    toolCalls,
    timeline: [
      { requestId, ts: '2026-11-23T00:00:00Z', method: 'initialize' },
      { requestId, ts: '2026-11-23T00:00:01Z', method: 'tools/list' },
      { requestId, ts: '2026-11-23T00:00:02Z', method: 'tools/call' },
    ],
  };
}

/* ------------------------------------------------------------------ *
 * 3. Replay plan + execution (read-only; writes forced dryRun)
 * ------------------------------------------------------------------ */

/** True when a tool name looks like a write operation. */
export function isWriteTool(name) {
  return WRITE_MARKERS.test(String(name ?? ''));
}

/**
 * Build a deterministic replay plan from a session. Same prompt, same tool
 * args, same client profile. Read calls are replayed; write calls are marked
 * `dryRun:true` and `forRealWrite:false` (never executed for real).
 */
export function buildReplayPlan(session, options = {}) {
  if (!session || typeof session !== 'object') throw new Error('session: object required');
  const steps = (Array.isArray(session.toolCalls) ? session.toolCalls : []).map((call, index) => {
    const write = isWriteTool(call?.name);
    const args = clone(call?.args ?? {});
    if (write) {
      // Force dryRun; even if the online arg had dryRun:false, offline replay
      // NEVER performs a real write. The override is recorded for auditing.
      args.dryRun = true;
    }
    return {
      index,
      requestId: idOf(call?.requestId),
      name: idOf(call?.name),
      args,
      mode: write ? 'dryRun' : 'read-only',
      forRealWrite: false,
      recordedResult: clone(call?.result ?? null),
      recordedIsError: call?.isError === true,
    };
  });
  return {
    schema: SCHEMA,
    buildId: options.buildId ?? 'checkout-current',
    source: session.source ?? 'unknown',
    sourceRequestIds: Array.isArray(session.requestIds) ? [...session.requestIds] : [],
    clientPlatform: session.clientPlatform ?? UNKNOWN,
    clientProfile: session.clientProfile ?? UNKNOWN,
    // Same prompt(s) verbatim; never paraphrase.
    prompts: Array.isArray(session.prompts) ? [...session.prompts] : [],
    toolsListSnapshot: clone(session.toolsListSnapshot ?? null),
    steps,
  };
}

/** Minimal Response-like object for an injected fetch. */
function fakeResponse(body, status = 200) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => text,
    json: async () => JSON.parse(text),
  };
}

function defaultUpstream() {
  // Deterministic, network-free stub: echoes name/args and marks dryRun.
  return async function offlineUpstream({ name, args }) {
    return {
      content: [{ type: 'text', text: JSON.stringify({
        ok: true,
        replay: 'offline-stub',
        name,
        arguments: args ?? {},
        dryRun: args?.dryRun === true,
      }) }],
    };
  };
}

/**
 * Execute a replay plan against an injected upstream (or a deterministic
 * offline stub). No network: `fetch`, if supplied, is only surfaced to the
 * upstream adapter and is never called by this harness itself.
 *
 * @param {object} plan
 * @param {object} [options]
 * @param {(call:{name:string,args:object,index:number})=>any} [options.upstream]
 * @param {Function} [options.fetch] injectable fetch (never used for network here)
 */
export async function replayPlan(plan, options = {}) {
  if (!plan || typeof plan !== 'object' || !Array.isArray(plan.steps)) {
    throw new Error('plan: object with steps[] required');
  }
  const upstream = typeof options.upstream === 'function' ? options.upstream : defaultUpstream();
  const steps = [];
  for (const step of plan.steps) {
    const call = { name: step.name, args: clone(step.args ?? {}), index: step.index };
    let result = null;
    let error = null;
    let realWriteAttempted = false;
    try {
      // Writes are ONLY ever sent to the upstream with dryRun forced. If an
      // injected upstream tries to perform a real write, that is recorded as a
      // violation rather than silently accepted.
      result = await upstream(call);
      if (step.mode === 'dryRun' && call?.args?.forRealWrite === true) realWriteAttempted = true;
    } catch (err) {
      error = { name: err?.name ?? 'Error', message: String(err?.message ?? err) };
    }
    steps.push({
      index: step.index,
      requestId: step.requestId,
      name: step.name,
      mode: step.mode,
      forRealWrite: step.forRealWrite,
      args: call.args,
      result: clone(result ?? null),
      error,
      realWriteAttempted,
    });
  }
  return {
    schema: SCHEMA,
    buildId: plan.buildId,
    source: plan.source,
    clientPlatform: plan.clientPlatform,
    clientProfile: plan.clientProfile,
    prompts: [...(plan.prompts ?? [])],
    toolsListSnapshot: clone(plan.toolsListSnapshot ?? null),
    steps,
  };
}

/* ------------------------------------------------------------------ *
 * 4. Diff: current output vs online recorded output
 * ------------------------------------------------------------------ */

/** Fields selected for field-level comparison. */
export const DIFF_FIELDS = Object.freeze([
  'exactness', 'contract', 'truncation', 'path', 'id',
]);

/**
 * Classify one field into pass | diff | not-comparable.
 * `not-comparable` fields (client host / model / timing) never become a verdict.
 */
export function classifyField(field, recorded, replayed, options = {}) {
  if (NOT_COMPARABLE_FIELDS.includes(field) || options.notComparable === true) {
    return { field, status: 'not-comparable', reason: options.reason ?? 'client-host/model-provider effect, not gateway code' };
  }
  if (field === 'exactness') {
    const ok = deepEqual(recorded, replayed);
    return { field, status: ok ? 'pass' : 'diff', recorded, replayed };
  }
  if (field === 'contract') {
    // Shape check: tool result must be an object with `content` array of
    // {type:'text', text:string} (gateway wire contract, AGENTS.md).
    const ok = (value) => {
      const content = value?.content;
      return Array.isArray(content) && content.length > 0
        && content.every((c) => c && c.type === 'text' && typeof c.text === 'string');
    };
    const recordedOk = ok(recorded);
    const replayedOk = ok(replayed);
    return { field, status: recordedOk === replayedOk && replayedOk ? 'pass' : 'diff', recordedShapeOk: recordedOk, replayedShapeOk: replayedOk };
  }
  if (field === 'truncation') {
    const marker = (value) => /--- TRUNCATED ---|…\[truncated\s*\d*\]|(?:^|["'\s])truncated["'\s]*:/i.test(
      typeof value === 'string' ? value : canonicalJson(value ?? null),
    );
    const r = marker(recorded);
    const p = marker(replayed);
    return { field, status: r === p ? 'pass' : 'diff', recordedTruncated: r, replayedTruncated: p };
  }
  if (field === 'path') {
    const norm = (value) => {
      const text = typeof value === 'string' ? value : canonicalJson(value ?? {});
      try { return JSON.parse(text)?.path ?? null; } catch { return null; }
    };
    const r = norm(recorded);
    const p = norm(replayed);
    if (r === null || p === null) return { field, status: 'not-comparable', reason: 'no explicit path in payload' };
    return { field, status: r === p ? 'pass' : 'diff', recordedPath: r, replayedPath: p };
  }
  if (field === 'id') {
    // Only compare recorded identity when it is real; 'unknown' is not a value.
    const r = idOf(recorded);
    const p = idOf(replayed);
    if (r === UNKNOWN || p === UNKNOWN) {
      return { field, status: 'not-comparable', reason: 'no real requestId on one side (unknown, never fabricated)' };
    }
    return { field, status: r === p ? 'pass' : 'diff', recordedId: r, replayedId: p };
  }
  return { field, status: 'not-comparable', reason: `unknown field ${field}` };
}

/**
 * Aggregate a step/overall verdict.
 *
 * Only `pass`/`diff` on gateway-comparable fields (exactness, contract,
 * truncation, path) decide the verdict. `not-comparable` context fields —
 * client host, model, timing, and an `unknown` requestId on both sides — are
 * informational and never degrade a clean comparison to `partial`. A step
 * with no comparable fields (e.g. a dryRun write simulation) is itself
 * `not-comparable`.
 */
export function aggregateVerdict(fields) {
  const statuses = new Set(fields.map((f) => f.status));
  if (statuses.has('diff')) return 'diff';
  if (statuses.has('pass')) return 'pass';
  return 'not-comparable';
}

/**
 * Diff replayed output against the recorded online output. Produces a stable
 * report with per-step field diffs and an overall verdict. Writes replayed in
 * dryRun mode can never be judged as byte-exact online writes: they are
 * reported `not-comparable` on exactness with an explicit reason.
 */
export function diffReplay(plan, replayOutput, options = {}) {
  if (!plan || !replayOutput) throw new Error('plan and replayOutput are required');
  const replaySteps = new Map((replayOutput.steps ?? []).map((s) => [s.index, s]));
  const steps = (plan.steps ?? []).map((step) => {
    const observed = replaySteps.get(step.index);
    const fields = DIFF_FIELDS.map((field) => {
      if (step.mode === 'dryRun' && (field === 'exactness' || field === 'contract')) {
        return { field, status: 'not-comparable', reason: 'dryRun write simulation cannot be byte-compared to a real online write' };
      }
      if (field === 'id') {
        return classifyField('id', step.requestId, observed?.requestId ?? step.requestId);
      }
      return classifyField(field, step.recordedResult, observed?.result ?? null);
    });
    return {
      index: step.index,
      requestId: step.requestId,
      name: step.name,
      mode: step.mode,
      verdict: aggregateVerdict(fields),
      fields,
      realWriteAttempted: observed?.realWriteAttempted === true,
    };
  });

  const contextFields = [];
  for (const field of ['clientPlatform', 'clientProfile', 'model', 'clientInfo', 'deployment', 'durationMs', 'responseBytes']) {
    const recorded = field === 'clientInfo'
      ? (options.recordedClientInfo ?? null)
      : (options.recorded?.[field] ?? null);
    const replayed = field === 'clientInfo'
      ? (options.replayClientInfo ?? null)
      : (replayOutput?.[field] ?? null);
    contextFields.push(classifyField(field, recorded, replayed, {
      notComparable: NOT_COMPARABLE_FIELDS.includes(field),
      reason: `${field} is owned by the client host / model provider / transport, not gateway code`,
    }));
  }

  // Context fields are observations, never gateway verdicts: they are reported
  // in `counts` and `context` but deliberately excluded from the verdict.
  const verdict = aggregateVerdict(steps.flatMap((s) => s.fields));
  const counts = { pass: 0, diff: 0, 'not-comparable': 0 };
  for (const s of steps) for (const f of s.fields) counts[f.status] = (counts[f.status] ?? 0) + 1;
  for (const f of contextFields) counts[f.status] = (counts[f.status] ?? 0) + 1;

  return {
    schema: SCHEMA,
    verdict,
    counts,
    buildId: replayOutput.buildId ?? plan.buildId,
    steps,
    context: contextFields,
    notComparableNote: 'Client host, OAuth client id, model/provider, timing and byte counts are observations, not gateway assertions. See docs/eval/ONLINE-REPLAY-HARNESS.md.',
  };
}

/* ------------------------------------------------------------------ *
 * 5. CLI
 * ------------------------------------------------------------------ */

/** Deterministic JSON serialization (fixed key order at top level). */
export function toJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function isMain() {
  if (typeof process === 'undefined' || !process.argv?.[1]) return false;
  try {
    return pathToFileURL(process.argv[1]).href === import.meta.url;
  } catch {
    return false;
  }
}

export async function main(argv = process.argv.slice(2)) {
  const fixtureMode = argv.includes('--fixture');
  let input;
  if (argv.includes('--stdin')) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    input = Buffer.concat(chunks).toString('utf8');
  } else if (fixtureMode) {
    input = null;
  } else {
    const file = argv.find((a) => !a.startsWith('-'));
    if (!file) {
      process.stderr.write('usage: node scripts/replay-online-session.mjs <captures.json> | --fixture [--stdin]\n');
      return 2;
    }
    input = await readFile(file, 'utf8');
  }

  let session;
  if (fixtureMode && input === null) {
    session = createFakeSession();
  } else {
    let parsed;
    try {
      parsed = JSON.parse(input);
    } catch (e) {
      process.stderr.write(`parse error: ${e.message}\n`);
      return 2;
    }
    if (fixtureMode && parsed?.source === 'fixture' && Array.isArray(parsed?.toolCalls)) {
      session = parsed; // pre-built fixture session
    } else {
      session = extractSession(parsed);
    }
  }

  const plan = buildReplayPlan(session);
  const output = await replayPlan(plan, {});
  const report = diffReplay(plan, output, { recorded: session });
  process.stdout.write(toJson({
    schema: SCHEMA,
    session,
    plan,
    replay: output,
    comparison: report,
  }));
  return 0;
}

if (isMain()) {
  main().catch((err) => {
    process.stderr.write(`[replay-online-session] failed: ${err?.message ?? err}\n`);
    process.exitCode = 1;
  });
}

// Re-export a tiny helper for fake-fetch based adapters (no network of its own).
export { fakeResponse };
