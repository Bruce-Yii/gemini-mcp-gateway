/**
 * Full-fidelity gateway capture (P1) + request-level audit trail (P0).
 *
 * The capture path is deliberately boring: copy request/response bytes and
 * headers verbatim, and hand the envelope to an async sink. It never awaits the
 * sink and never throws into the MCP handler.
 *
 * P0 addition: every request that enters a capture-enabled route emits a
 * structured `[capture_ack]` synchronously (with a stable requestId) and a
 * `[capture_done]` when the response finishes. When capture cannot run for a
 * request, a `[capture_skipped]` line records the exact reason. These lines
 * exist so Vercel logs can be reconciled against R2 objects by requestId.
 *
 * IMPORTANT (P0 fix): the sink is queued *eagerly* inside `res.end`, and
 * `waitUntil()` is called before `res.end` returns. Previously both were
 * deferred into a `queueMicrotask`; on Vercel the runtime may freeze the
 * function as soon as the response is finalized, so the microtask never ran —
 * producing a missing capture AND no `capture_dropped` log.
 *
 * Storage is intentionally pluggable. P1 ships file/HTTP/console/R2 sinks.
 */
import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { waitUntil } from '@vercel/functions';
import { BUILD } from './build-info.js';
import { extractProjects } from './project-tag.js';
import { detectClientPlatform } from './client-platform.js';

const MAX_BODY_BYTES = 32 * 1024 * 1024;
// Fallback POST timeout — keep it short so a dead endpoint never holds the
// function open long enough to matter.
const FALLBACK_TIMEOUT_MS = 3000;
export const captureStore = new AsyncLocalStorage();
let droppedCount = 0;

export function captureFailureStats() {
  return { dropped: droppedCount };
}

export function captureEvent(type, payload) {
  const store = captureStore.getStore();
  if (!store) return;
  store.events.push({ type, ts: Date.now(), payload });
}

export function captureHeaders(headers = {}) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) out[name] = value;
  return out;
}

/**
 * Low-cardinality MCP request metadata for audit lines. Never includes the body
 * or arguments; used to diagnose "host stopped registering tools" incidents.
 */
function captureMcpInfo(req) {
  const raw = req?.__gatewayRawBody;
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 1_000_000) {
    return { mcpMethod: null, mcpTool: null, mcpId: null };
  }
  try {
    const body = JSON.parse(raw);
    return {
      mcpMethod: typeof body?.method === 'string' ? body.method : null,
      mcpTool: typeof body?.params?.name === 'string' ? body.params.name : null,
      mcpId: body?.id ?? null,
    };
  } catch (_) {
    return { mcpMethod: null, mcpTool: null, mcpId: null };
  }
}

/* ------------------------------------------------------------------ *
 * Client platform label (B13, layer 1 — observability only)
 *
 * Derives `clientPlatform` / `clientProfile` / `oauthClientId` from explicit
 * request signals. This is ADDITIVE: it never changes capture eligibility,
 * raw bytes, headers, events, or any existing envelope field. The label is
 * never consulted by write/idempotency/permission paths.
 * ------------------------------------------------------------------ */

/**
 * Read an OAuth client id if the route attached one to `req`. Several common
 * attachment names are accepted; nothing is inferred from auth headers (a
 * bearer token is NOT a client id). Absent -> null.
 */
export function captureOAuthClientId(req) {
  if (!req || typeof req !== 'object') return null;
  for (const key of ['oauthClientId', '__gatewayOAuthClientId', '__gatewayOauthClientId']) {
    const value = req[key];
    if (typeof value === 'string' && value) return value;
  }
  return null;
}

/** Parse just enough of the raw body for an initialize clientInfo.name. */
function platformBodyFromReq(req) {
  const raw = req?.__gatewayRawBody;
  if (typeof raw !== 'string' || !raw || raw.length > 1_000_000) return undefined;
  try {
    const body = JSON.parse(raw);
    return body !== null && typeof body === 'object' ? body : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Compute the additive platform block for a capture envelope. Always returns
 * an object; callers must only write it into an envelope that is actually
 * being persisted (never into a skipped/disabled capture).
 */
function buildClientPlatformBlock(req, options = {}) {
  const oauthClientId = captureOAuthClientId(req);
  let result;
  try {
    result = detectClientPlatform({
      headers: req?.headers,
      body: platformBodyFromReq(req),
      oauthClientId,
      oauthClientMap: options.oauthClientMap,
      env: options.env ?? process.env,
    });
  } catch {
    result = { platform: 'unknown', profile: 'gemini-text-json', source: 'default', confidence: 'low' };
  }
  return {
    clientPlatform: result.platform,
    clientProfile: result.profile,
    oauthClientId,
  };
}

/* ------------------------------------------------------------------ *
 * Model-output truncation audit (P0, batch 11)
 *
 * The gateway captures the FULL upstream/sandbox response. The model only
 * sees a projection (`toModelOutput` -> `output.result`). When model code
 * slices that projection (e.g. `.slice(0, 150)`), the wire capture still looks
 * healthy: status 200, no `overflow`, no `truncated` marker. That silent
 * loss was invisible to capture/analyzer until now.
 *
 * These helpers add a COMPUTABLE audit signal to the envelope. They never
 * change how a response is captured or written. Every rule is deterministic
 * and byte-based — no semantic/natural-language guessing about content.
 * ------------------------------------------------------------------ */

/** Byte length of a value as it would appear in the JSON wire payload. */
function wireBytes(value) {
  if (value === undefined) return 0;
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return typeof text === 'string' ? Buffer.byteLength(text, 'utf8') : 0;
  } catch {
    return 0;
  }
}

/** Stable, short hash of a value for correlating a model-output summary to raw R2. */
function auditHash(value) {
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    if (typeof text !== 'string') return null;
    return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}

/** An explicit truncation marker on the wire — never inferred from prose. */
function hasExplicitTruncationMark(...values) {
  return values.some((value) => {
    if (typeof value === 'boolean') return value === true;
    if (value && typeof value === 'object' && value.truncated === true) return true;
    const text = typeof value === 'string' ? value : (() => {
      try { return JSON.stringify(value) ?? ''; } catch { return ''; }
    })();
    return /--- TRUNCATED ---|…\[truncated\s*\d*\]|(?:^|["'\s])truncated["'\s]*:/i.test(text);
  });
}

/**
 * Build the model-output audit block from data already present in the envelope.
 *
 * Source of truth for "source" vs "visible":
 *   - source  = the FULL upstream response captured by `captureEvent('upstream',
 *     { server, tool, args, result })` (or an `upstream_frame` direction:'in'
 *     message). This is the complete upstream/gateway data — evidence shows the
 *     wire was healthy in the silent-truncation incidents.
 *   - visible = the sandbox event's `output.result`, i.e. exactly what
 *     `toModelOutput()` returns to the model. When model code does
 *     `.slice(0, 150)` this is a short projection of the full source.
 *
 * `possibleModelTruncation` is true only when ALL hold:
 *   1. a sandbox output exists (never guess when there is nothing to compare),
 *   2. an upstream source exists with bytes > 0 (never flag without a source),
 *   3. the visible model output is materially shorter than the source
 *      (<= 50% AND at least 64 bytes smaller — both conservative),
 *   4. there is NO explicit `truncated:true` / wire marker on output/response.
 * The rule is purely byte-based; it makes no claim about content semantics.
 * Gateway `overflow` is unrelated and is deliberately NOT consulted here.
 */
export function buildModelOutputAudit({ events = [], response = {} } = {}) {
  const list = Array.isArray(events) ? events : [];
  const sandbox = list.find(
    (event) => event?.type === 'sandbox' && event?.payload?.output !== undefined,
  );
  const empty = {
    modelOutput: null,
    sourceBytes: 0,
    modelOutputBytes: 0,
    possibleModelTruncation: false,
  };
  const output = sandbox?.payload?.output;
  if (output === undefined || output === null) return empty;

  // Largest captured upstream response in this request = the source bytes.
  let sourceBytes = 0;
  for (const event of list) {
    if (event?.type === 'upstream' && event?.payload?.result !== undefined) {
      sourceBytes = Math.max(sourceBytes, wireBytes(event.payload.result));
    } else if (event?.type === 'upstream_frame' && event?.payload?.direction === 'in'
      && event?.payload?.message !== undefined) {
      sourceBytes = Math.max(sourceBytes, wireBytes(event.payload.message));
    }
  }

  const hasObject = typeof output === 'object' && !Array.isArray(output);
  const visible = hasObject && Object.prototype.hasOwnProperty.call(output, 'result')
    ? output.result
    : output;
  const modelOutputBytes = wireBytes(visible);
  const text = typeof visible === 'string' ? visible : (() => {
    try { return JSON.stringify(visible) ?? ''; } catch { return ''; }
  })();
  const summary = text.length > 160 ? `${text.slice(0, 160)}…` : text;

  const marked = hasExplicitTruncationMark(
    output, visible, response?.truncated, response?.raw,
  );
  const materiallyShorter = sourceBytes > 0
    && modelOutputBytes <= sourceBytes * 0.5
    && sourceBytes - modelOutputBytes >= 64;
  return {
    modelOutput: {
      summary,
      length: typeof visible === 'string' ? visible.length : modelOutputBytes,
      sha256: auditHash(visible),
    },
    sourceBytes,
    modelOutputBytes,
    possibleModelTruncation: sourceBytes > 0 && modelOutputBytes < sourceBytes && materiallyShorter && !marked,
  };
}

function chunkToBuffer(chunk, encoding) {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  if (typeof chunk === 'string') return Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8');
  return Buffer.from(String(chunk), typeof encoding === 'string' ? encoding : 'utf8');
}

function configFromOptions(options = {}, env = process.env) {
  const mode = options.mode ?? env.CAPTURE_MODE ?? 'off';
  return {
    mode: mode === 'full' || mode === 'meta' ? mode : 'off',
    sink: options.sink ?? env.CAPTURE_SINK ?? 'file',
    fileDir: options.fileDir ?? env.CAPTURE_FILE_DIR ?? join(process.cwd(), 'work', 'capture'),
    httpUrl: options.httpUrl ?? env.CAPTURE_HTTP_URL ?? '',
    httpToken: options.httpToken ?? env.CAPTURE_HTTP_TOKEN ?? '',
    maxBytes: Number(options.maxBytes ?? env.CAPTURE_MAX_BYTES ?? MAX_BODY_BYTES),
    r2AccountId: options.r2AccountId ?? env.R2_ACCOUNT_ID ?? '',
    r2Bucket: options.r2Bucket ?? env.R2_BUCKET ?? '',
    r2AuthEmail: options.r2AuthEmail ?? env.R2_AUTH_EMAIL ?? '',
    r2AuthKey: options.r2AuthKey ?? env.R2_AUTH_KEY ?? '',
    r2ApiToken: options.r2ApiToken ?? env.R2_API_TOKEN ?? '',
    r2Prefix: options.r2Prefix ?? env.R2_PREFIX ?? 'capture',
    fallbackHttpUrl: options.fallbackHttpUrl ?? env.CAPTURE_FALLBACK_HTTP_URL ?? '',
    fallbackHttpToken: options.fallbackHttpToken ?? env.CAPTURE_FALLBACK_HTTP_TOKEN ?? '',
    sync: options.sync ?? env.CAPTURE_SYNC === '1',
    fetchImpl: options.fetchImpl ?? fetch,
  };
}

/**
 * Structured, low-cardinality audit line. Never includes auth values or body.
 * Exported so callers can emit a skip from outside startCapture when the route
 * is not eligible (e.g. a non-POST /mcp request).
 */
export function captureLog(tag, fields) {
  console.log(`[${tag}]`, JSON.stringify(fields));
}

// capture_skipped reasons are a closed enum. Free-form text is never accepted
// as a reason/detail so an auth value or body can never leak into this line.
const SAFE_SKIP_REASONS = new Set([
  'capture_disabled',
  'capture_mode_off',
  'env_missing',
  'not_eligible',
  'already_started',
  'non_post',
  'body_buffer_failed',
  'handler_error',
]);
function safeSkipReason(reason) {
  return SAFE_SKIP_REASONS.has(reason) ? reason : 'not_eligible';
}
function safeSkipDetail(detail) {
  // Only short, fixed diagnostics are allowed. No header/token/body content.
  return typeof detail === 'string' && detail.length <= 120 && !/bearer|token|authorization|secret|cookie/i.test(detail)
    ? detail
    : undefined;
}

async function writeFileSink(cfg, envelope) {
  await mkdir(cfg.fileDir, { recursive: true });
  const name = `${envelope.ts.replace(/[:.]/g, '-')}-${envelope.requestId}.json`;
  await writeFile(join(cfg.fileDir, name), JSON.stringify(envelope), 'utf8');
}

/**
 * A response counts as success only for a 2xx status. `response.ok` is the
 * Fetch-spec signal; status is checked as well so lightweight fetch doubles
 * that omit `ok` cannot turn a 500/429 into a false success. We deliberately
 * do NOT read (let alone log) the response body: collector/fallback bodies may
 * echo tokens, and no body text is needed to decide success.
 */
function isOkSinkResponse(response) {
  if (!response) return false;
  const status = Number(response.status);
  const statusOk = Number.isFinite(status) && status >= 200 && status < 300;
  return response.ok !== false && statusOk;
}

async function writeHttpSink(cfg, envelope) {
  if (!cfg.httpUrl) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  let response;
  try {
    response = await cfg.fetchImpl(cfg.httpUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.httpToken ? { authorization: `Bearer ${cfg.httpToken}` } : {}),
      },
      body: JSON.stringify(envelope),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!isOkSinkResponse(response)) {
    // Status only — never include response body text (it may contain tokens).
    const status = response?.status ?? 'unknown';
    throw new Error(`HTTP capture sink failed: status ${status}`);
  }
}

async function writeR2Sink(cfg, envelope) {
  if (!cfg.r2AccountId || !cfg.r2Bucket) throw new Error('R2 capture sink missing account/bucket');
  if (!cfg.r2ApiToken && (!cfg.r2AuthEmail || !cfg.r2AuthKey)) {
    throw new Error('R2 capture sink missing auth');
  }
  const day = envelope.ts.slice(0, 10);
  const key = `${cfg.r2Prefix}/${day}/${envelope.requestId}.json.gz`;
  const encodedKey = key.split('/').map(encodeURIComponent).join('/');
  const url = `https://api.cloudflare.com/client/v4/accounts/${cfg.r2AccountId}/r2/buckets/${cfg.r2Bucket}/objects/${encodedKey}`;
  const headers = {
    'content-type': 'application/gzip',
  };
  if (cfg.r2ApiToken) headers.authorization = `Bearer ${cfg.r2ApiToken}`;
  else {
    headers['x-auth-email'] = cfg.r2AuthEmail;
    headers['x-auth-key'] = cfg.r2AuthKey;
  }
  const body = gzipSync(Buffer.from(JSON.stringify(envelope)));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await cfg.fetchImpl(url, { method: 'PUT', headers, body, signal: controller.signal });
    if (!response.ok) throw new Error(`R2 put failed: ${response.status}`);
  } finally {
    clearTimeout(timer);
  }
}

function writeSink(cfg, envelope) {
  if (cfg.sink === 'console') {
    // Debug only: Vercel log limits are not a durable raw store.
    console.log(`[capture] ${JSON.stringify(envelope)}`);
    return Promise.resolve();
  }
  if (cfg.sink === 'http') return writeHttpSink(cfg, envelope);
  if (cfg.sink === 'r2') return writeR2Sink(cfg, envelope);
  return writeFileSink(cfg, envelope);
}

/**
 * Last-resort POST when the primary sink fails. Fire-and-forget: never throws,
 * never blocks the response, and silently ignores its own failure. When R2 is
 * down this still leaves a structured record at the fallback endpoint (and the
 * `[capture_dropped]` console line above always lands in Vercel logs).
 */
async function postFallback(cfg, record) {
  if (!cfg.fallbackHttpUrl) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FALLBACK_TIMEOUT_MS);
  try {
    await cfg.fetchImpl(cfg.fallbackHttpUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.fallbackHttpToken ? { authorization: `Bearer ${cfg.fallbackHttpToken}` } : {}),
      },
      body: JSON.stringify(record),
      signal: controller.signal,
    });
  } catch {
    // Fallback failure is intentionally silent — we already logged dropped.
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Start capture for one /mcp POST. Returns null when disabled.
 * The returned object has no protocol surface; it only carries the requestId
 * and helpers used by the route to enrich the audit trail.
 *
 * @param {any} req
 * @param {any} res
 * @param {{
 *   mode?: string, sink?: string, [key: string]: any,
 *   bodyBuffered?: boolean, path?: string, route?: string,
 *   log?: (tag: string, fields: object) => void,
 * }} [options]
 */
export function startCapture(req, res, options = {}) {
  // Idempotency guard: production wires startCapture at the top of the app
  // handler, and the local /mcp handler may also attempt it. Never create two
  // envelopes (and two [capture_ack] lines) for the same request.
  if (req && req.__gatewayCaptureStarted) {
    return req.__gatewayCapture ?? null;
  }
  const cfg = configFromOptions(options);
  const log = typeof options.log === 'function' ? options.log : captureLog;
  const path = options.path ?? req?.url ?? '/';
  const method = typeof req?.method === 'string' ? req.method.toUpperCase() : 'GET';
  const enabled = cfg.mode !== 'off';
  const requestId = options.requestId ?? randomUUID();
  const requestBytes = Number(options.requestBytes ?? req?.__gatewayRawBody?.length ?? 0) || 0;
  const mcpInfo = captureMcpInfo(req);

  if (req) req.__gatewayCaptureStarted = true;

  if (!enabled) {
    // A disabled capture must be auditable: otherwise "no capture" and
    // "capture silently lost" are indistinguishable in Vercel logs.
    log('capture_skipped', {
      requestId,
      path,
      method,
      sink: cfg.sink,
      enabled: false,
      reason: safeSkipReason('capture_disabled'),
      detail: safeSkipDetail('CAPTURE_MODE is off/unset on this deployment'),
      build: BUILD,
    });
    const disabled = { requestId, enabled: false, skip() {} };
    if (req) req.__gatewayCapture = disabled;
    return null;
  }

  const started = Date.now();
  const context = { requestId, started, events: [] };
  captureStore.enterWith(context);
  const chunks = [];
  let bytes = 0;
  let overflow = false;

  // Synchronous ack: emitted before any handler work so every request that
  // entered the route is visible in Vercel logs with a stable requestId.
  log('capture_ack', {
    requestId,
    path,
    method,
    mode: cfg.mode,
    sink: cfg.sink,
    enabled: true,
    requestBytes,
    bodyBuffered: Boolean(options.bodyBuffered ?? req?.__gatewayRawBody !== undefined),
    mcpMethod: mcpInfo.mcpMethod,
    mcpTool: mcpInfo.mcpTool,
    sessionId: req?.__gatewaySessionId ?? req?.headers?.['mcp-session-id'] ?? null,
    build: BUILD,
  });

  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);
  let finished = false;
  let sinkQueued = false;
  let sinkError = null;

  res.write = function captureWrite(chunk, encoding, callback) {
    if (chunk && !overflow) {
      const buf = chunkToBuffer(chunk, encoding);
      bytes += buf.length;
      if (bytes > cfg.maxBytes) {
        overflow = true;
        chunks.length = 0;
      } else {
        chunks.push(buf);
      }
    }
    return originalWrite(chunk, encoding, callback);
  };

  res.end = function captureEnd(chunk, encoding, callback) {
    // Re-entrant/late end after an abort is passed straight through. It never
    // queues a second sink task, so a retry cannot duplicate the envelope.
    if (finished) return originalEnd(chunk, encoding, callback);
    finished = true;
    const endEnteredAt = Date.now();
    if (chunk && !overflow) {
      const buf = chunkToBuffer(chunk, encoding);
      bytes += buf.length;
      if (bytes > cfg.maxBytes) overflow = true;
      else chunks.push(buf);
    }
    const duration = Date.now() - started;

    // Build the envelope eagerly. Do NOT defer with queueMicrotask: Vercel can
    // freeze the function immediately after res.end, so waitUntil must already
    // hold the sink promise by then.
    const envelope = {
      schema: 'gmg.capture.v1',
      ts: new Date(started).toISOString(),
      requestId,
      sessionId: req.__gatewaySessionId ?? req.headers?.['mcp-session-id'] ?? null,
      clientInfo: req.__gatewayClientInfo ?? null,
      // Additive B13 platform label. Observation/encoding only; no write-path
      // or idempotency semantics depend on these values.
      ...buildClientPlatformBlock(req, options),
      mode: cfg.mode,
      deployment: BUILD,
      request: {
        method: req.method,
        url: req.url,
        headers: captureHeaders(req.headers),
        raw: req.__gatewayRawBody ?? null,
      },
      events: context.events,
      response: {
        status: res.statusCode,
        headers: captureHeaders(res.getHeaders?.() ?? {}),
        raw: overflow ? null : Buffer.concat(chunks).toString('utf8'),
        bytes,
        overflow,
        durationMs: duration,
      },
      // Additive model-output truncation audit. Computed from data already in
      // the envelope; capture semantics and all existing fields are unchanged.
      model: buildModelOutputAudit({ events: context.events, response: { status: res.statusCode } }),
      // Additive project/repository tag derived from the REQUEST only (pure,
      // no model/network/upstream-result parsing). Never fail capture on it.
      ...(() => {
        try {
          return extractProjects({ __gatewayRawBody: req.__gatewayRawBody });
        } catch {
          return { projects: [], primaryProject: null };
        }
      })(),
    };

    // Record the drop in Vercel logs unconditionally, even when `waitUntil`
    // is unavailable or throws. The Promise chain owns its own .catch, so the
    // structured line lands regardless of platform support.
    const onSinkError = (error) => {
      sinkQueued = false;
      sinkError = error?.message ?? String(error);
      droppedCount += 1;
      const record = {
        schema: 'gmg.capture_dropped.v1',
        ts: new Date().toISOString(),
        requestId,
        sink: cfg.sink,
        dropped: droppedCount,
        error: sinkError,
      };
      console.error('[capture_dropped]', JSON.stringify(record));
      // Best-effort remote copy of the dropped envelope. Includes the full
      // original envelope so a dead R2 bucket does not lose the capture.
      postFallback(cfg, { ...record, envelope }).catch(() => {});
    };

    const task = Promise.resolve()
      .then(() => {
        log('capture_sink_start', { requestId, sink: cfg.sink });
        return writeSink(cfg, envelope);
      })
      .then(() => log('capture_sink_ok', { requestId, sink: cfg.sink }))
      .catch(onSinkError);

    // `mcp_latency_ms` is measured at the REAL response-end point: `finish()`
    // is where `originalEnd` actually runs. In sync mode that is after the sink
    // promise settles, so the number includes the sink wait; the legacy
    // `capture_done.duration` above is intentionally left unchanged (it is
    // recorded before the sink completes) for backwards compatibility.
    const finish = () => {
      const endAt = Date.now();
      const mcpLatencyMs = endAt - started;
      try {
        return originalEnd(chunk, encoding, callback);
      } finally {
        log('capture_flush_end', {
          requestId,
          path,
          method,
          status: res.statusCode,
          mode: cfg.mode,
          sink: cfg.sink,
          sync: Boolean(cfg.sync),
          duration,
          waitedMs: endAt - endEnteredAt,
          mcp_latency_ms: mcpLatencyMs,
          endAt: new Date(endAt).toISOString(),
        });
      }
    };

    // Optional synchronous mode: hold the response until the sink completes.
    // Vercel's waitUntil is not reliable on every runtime; CAPTURE_SYNC=1 makes
    // capture correctness win over a small response latency increase.
    // Default behaviour (CAPTURE_SYNC unset / != '1') is unchanged.
    if (cfg.sync) {
      sinkQueued = true;
      log('capture_done', {
        requestId, path, method, status: res.statusCode, duration,
        sink: cfg.sink, sinkQueued, sync: true,
      });
      // `.catch` keeps a throwing `originalEnd` from becoming an unhandled
      // rejection on the sink promise; the error still surfaces to the caller.
      task.finally(finish).catch(() => {});
      return undefined;
    }

    // Keep the function alive after the response where the platform allows it.
    // Called synchronously in res.end, before it returns, so Vercel sees the
    // pending work before the response is finalized. Locally waitUntil may
    // throw; the Promise still runs and still logs a drop on failure.
    try { waitUntil(task); } catch { /* best-effort local runtime */ }
    sinkQueued = true; // queued (not necessarily completed) before res.end returns

    log('capture_done', {
      requestId,
      path,
      method,
      status: res.statusCode,
      duration,
      sink: cfg.sink,
      sinkQueued,
      ...(sinkError ? { sinkError } : {}),
    });
    // Send the response only after waitUntil() has seen the pending sink task.
    return finish();
  };

  const capture = {
    requestId,
    mode: cfg.mode,
    sink: cfg.sink,
    enabled: true,
    /** Mark the request as skipped after capture started (e.g. handler error). */
    skip(reason, detail) {
      log('capture_skipped', {
        requestId,
        path,
        method,
        sink: cfg.sink,
        enabled: true,
        reason: safeSkipReason(reason),
        ...(safeSkipDetail(detail) ? { detail: safeSkipDetail(detail) } : {}),
      });
    },
    /** Exposed for tests/routes: what the sync ack reported. */
    ack: {
      requestId,
      path,
      method,
      mode: cfg.mode,
      sink: cfg.sink,
      enabled: true,
      requestBytes,
      bodyBuffered: Boolean(options.bodyBuffered ?? req?.__gatewayRawBody !== undefined),
    },
  };
  if (req) req.__gatewayCapture = capture;
  return capture;
}

/**
 * Emit a standalone `[capture_skipped]` line when capture never started for a
 * request that the route considered (e.g. a GET /mcp probe, or an early auth
 * rejection before startCapture was wired in). Returns the supplied/generated
 * requestId so callers can reference it from other log lines.
 */
export function captureSkip(req, options = {}) {
  const log = typeof options.log === 'function' ? options.log : captureLog;
  const requestId = options.requestId ?? randomUUID();
  log('capture_skipped', {
    requestId,
    path: options.path ?? req?.url ?? '/',
    method: typeof req?.method === 'string' ? req.method.toUpperCase() : 'GET',
    sink: options.sink ?? process.env.CAPTURE_SINK ?? 'file',
    enabled: captureEnabled(),
    reason: safeSkipReason(options.reason ?? 'not_eligible'),
    mcpMethod: captureMcpInfo(req).mcpMethod,
    sessionId: req?.__gatewaySessionId ?? req?.headers?.['mcp-session-id'] ?? null,
    ...(safeSkipDetail(options.detail) ? { detail: safeSkipDetail(options.detail) } : {}),
  });
  return requestId;
}

export function captureEnabled(env = process.env) {
  return (env.CAPTURE_MODE ?? 'off') === 'full' || (env.CAPTURE_MODE ?? 'off') === 'meta';
}
