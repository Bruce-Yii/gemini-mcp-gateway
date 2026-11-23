/**
 * Isolated prototype: async capture queue (batch-15, D+C direction).
 *
 * This module is a STANDALONE PROTOTYPE. It is deliberately not imported by
 * `capture.js`, `vercel-app.js` or `server.js`; nothing here changes the
 * production capture path. The eventual wiring is documented in
 * `docs/ledger/batch-15-capture-queue.md`.
 *
 * Design goals (see docs/ledger/batch-15-capture-latency.md §3):
 *   - P0 "critical" audit rows (ack / done / dropped / meta) are never dropped
 *     and are delivered synchronously or at priority before envelope bodies.
 *   - P1 "envelope" bodies are queued in a bounded in-memory ring, flushed in
 *     batches to an injected sink (fake or HTTP), with idempotency by requestId.
 *   - Backpressure by maxItems / maxBytes: overflow drops the OLDEST known-
 *     droppable envelope and calls onDrop (never a critical item).
 *   - Retry with exponential backoff; after maxAttempts, hand the item to a DLQ
 *     callback. 429/5xx/abort are all treated as retryable failures.
 *   - No token / envelope body is ever logged. Observability callbacks only
 *     receive requestId, lane, attempt, and status codes — never raw bytes.
 *   - Deterministic: timer/now/sleep implementations are injectable.
 *
 * There are no dependencies outside Node core, and no new environment
 * variables are read. This file does not import capture.js.
 */

/** Critical audit tags that must never be dropped (D direction, P0). */
export const CRITICAL_TAGS = Object.freeze(['ack', 'done', 'dropped', 'meta']);

/** How retryable HTTP failures are recognised. */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * A minimal deterministic clock/timer/sleep adapter. Production code can pass
 * the defaults; tests pass a fake scheduler so outcomes are reproducible.
 */
function defaultScheduler() {
  return {
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

function byteLengthOf(value) {
  if (value == null) return 0;
  try {
    return Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
  } catch {
    // Non-serializable payloads are still countable by rough string length.
    return String(value).length;
  }
}

/**
 * CaptureQueue — bounded in-memory ring + batched async flush.
 *
 * Constructor options:
 *   sink            `(batch, meta) => Promise<void>` — receives an array of
 *                   queue items. Throw / reject / return `{ ok:false, status }`
 *                   to signal failure. Injectable (fake sink or HTTP sink).
 *   maxItems        ring capacity in items (default 256).
 *   maxBytes        ring capacity in bytes (default 4 MiB).
 *   batchSize       max items per flush (default 32).
 *   flushIntervalMs idle flush deadline (default 250ms).
 *   maxAttempts     total delivery attempts per item (default 4).
 *   backoffBaseMs   first retry delay (default 50ms).
 *   backoffMaxMs    retry delay ceiling (default 2000ms).
 *   onDrop          `(item, reason) => void` — overflow / abandoned item.
 *   onDlq           `(item, reason) => void|Promise` — dead-letter callback.
 *   onEvent         `({ type, requestId, lane, attempt, status, ... }) => void`
 *                   — structured, body-free observability hook.
 *   scheduler       `{ now, setTimeout, clearTimeout, sleep }` for determinism.
 *   idempotent      dedupe by requestId while queued/in-flight (default true).
 *   seenMaxEntries  end-to-end dedupe window capacity (default 4096). 0 or
 *                   Infinity disables the cap (legacy unbounded behaviour);
 *                   `idempotent:false` disables all dedupe.
 *   seenTtlMs       dedupe entries expire after this long (default 24h).
 *                   0 or Infinity disables TTL expiry. Eviction is LRU+TTL and
 *                   never evicts a requestId that is still inFlight, so an
 *                   eviction can never cause an immediate duplicate write.
 */
export class CaptureQueue {
  constructor(options = {}) {
    const {
      sink,
      maxItems = 256,
      maxBytes = 4 * 1024 * 1024,
      batchSize = 32,
      flushIntervalMs = 250,
      maxAttempts = 4,
      backoffBaseMs = 50,
      backoffMaxMs = 2000,
      onDrop,
      onDlq,
      onEvent,
      scheduler,
      idempotent = true,
      seenMaxEntries = 4096,
      seenTtlMs = 24 * 60 * 60 * 1000,
    } = options;

    if (typeof sink !== 'function') {
      throw new TypeError('CaptureQueue requires a sink(batch, meta) function');
    }

    this.sink = sink;
    this.maxItems = Math.max(1, Number(maxItems) || 256);
    this.maxBytes = Math.max(1, Number(maxBytes) || (4 * 1024 * 1024));
    this.batchSize = Math.max(1, Number(batchSize) || 32);
    this.flushIntervalMs = Math.max(0, Number(flushIntervalMs) || 250);
    this.maxAttempts = Math.max(1, Number(maxAttempts) || 4);
    this.backoffBaseMs = Math.max(0, Number(backoffBaseMs) || 50);
    this.backoffMaxMs = Math.max(this.backoffBaseMs, Number(backoffMaxMs) || 2000);
    this.onDrop = typeof onDrop === 'function' ? onDrop : () => {};
    this.onDlq = typeof onDlq === 'function' ? onDlq : () => {};
    this.onEvent = typeof onEvent === 'function' ? onEvent : () => {};
    this.scheduler = scheduler ?? defaultScheduler();
    this.idempotent = idempotent !== false;

    // G-13: the end-to-end dedupe window used to be a Set that grew forever.
    // Keep it as an insertion-ordered Map so it doubles as an LRU queue:
    //   key = requestId, value = timestamp (from the injectable scheduler).
    // Capacity and TTL are both configurable; 0/Infinity means "no limit" for
    // backwards compatibility. `this.seen` remains a Set-like surface for the
    // dedupe check (`has`) so existing code/tests keep working.
    const cap = Number(seenMaxEntries);
    this.seenMaxEntries = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : 0; // 0 = unbounded
    const ttl = Number(seenTtlMs);
    this.seenTtlMs = Number.isFinite(ttl) && ttl > 0 ? ttl : 0; // 0 = no expiry

    /** @type {Array<{ lane:'critical'|'envelope', item:any, bytes:number, attempt:number, requestId:string|null, enqueuedAt:number }>} */
    this.ring = [];
    this.bytes = 0;
    this.timer = null;
    this.flushing = false;
    this.kickScheduled = false;
    this.closed = false;
    this.inFlight = new Set(); // requestIds currently buffered or being written
    this.seen = new Map();     // requestId -> lastSeenAt, insertion order = LRU order
    this.retryTimers = new Set();
    this.inRetry = new Set();  // entries already owned by a retry timer
    this.stats = {
      enqueued: 0,
      critical: 0,
      envelopes: 0,
      flushed: 0,
      batches: 0,
      retries: 0,
      dropped: 0,
      dlq: 0,
      duplicates: 0,
      overflow: 0,
      seenEvicted: 0,
    };
  }

  // -------------------------------------------------------------------------
  // G-13: bounded end-to-end dedupe window (LRU + TTL).
  //
  // `seen` is a Map used as an LRU list: iterating it yields least-recently-
  // used keys first. `touchSeen` promotes a hit to most-recently-used;
  // `rememberSeen` inserts a new id and evicts the oldest eligible entries.
  // An entry is eligible for eviction only when it is NOT in `inFlight` — that
  // is the requirement that an eviction must never cause an immediate duplicate
  // write (a still-queued/retrying requestId must keep its dedupe shield).
  // -------------------------------------------------------------------------

  /** True if the requestId is inside the current dedupe window. */
  _hasSeen(requestId) {
    if (!this.seen.has(requestId)) return false;
    let at = this.seen.get(requestId);
    if (this.seenTtlMs > 0 && this.scheduler.now() - at >= this.seenTtlMs) {
      if (!this.inFlight.has(requestId)) {
        this.seen.delete(requestId);
        this.stats.seenEvicted += 1;
        return false;
      }
      // Still inFlight: refresh so the shield survives until release.
      at = this.scheduler.now();
    }
    // LRU promotion: re-inserting a key moves it to the end of the Map.
    this.seen.delete(requestId);
    this.seen.set(requestId, at);
    return true;
  }

  /** Register a newly accepted requestId and enforce the capacity bound. */
  _rememberSeen(requestId) {
    this.seen.set(requestId, this.scheduler.now());
    if (this.seenMaxEntries === 0) return; // unbounded by explicit configuration
    // Bound the loop by the number of scanned keys, not by the cap: a window
    // that overshot while many ids were live must be trimmable in one insert
    // once those ids settle.
    let guard = this.seen.size + 1;
    while (this.seen.size > this.seenMaxEntries && guard-- > 0) {
      // Oldest-first scan; skip the newcomer itself (it is added to inFlight
      // immediately after this call) and ids still buffered/in-flight.
      let victim = null;
      for (const id of this.seen.keys()) {
        if (id === requestId) continue;
        if (!this.inFlight.has(id)) { victim = id; break; }
      }
      if (victim === null) {
        // Every id is still active: allow a temporary overshoot rather than
        // dropping the dedupe shield for a live request (same policy as ring
        // critical overflow). Emit a body-free warning for the operator.
        this._emit('seen_overflow', { size: this.seen.size, cap: this.seenMaxEntries });
        break;
      }
      this.seen.delete(victim);
      this.stats.seenEvicted += 1;
      this._emit('seen_evicted', { reason: 'lru', size: this.seen.size });
    }
  }

  /** Emit a body-free structured event. */
  _emit(type, fields = {}) {
    try {
      this.onEvent({ type, at: this.scheduler.now(), ...fields });
    } catch {
      // Observability must never break the queue.
    }
  }

  /** Parse a critical tag from an item without touching its payload. */
  static criticalTagOf(item) {
    if (!item || typeof item !== 'object') return null;
    if (item.critical === true) return item.tag ?? 'meta';
    if (typeof item.tag !== 'string') return null;
    const tag = item.tag.toLowerCase();
    if (tag === 'capture_ack' || tag === 'capture_ack.v1') return 'ack';
    if (tag === 'capture_done' || tag === 'capture_done.v1') return 'done';
    if (tag === 'capture_dropped' || tag === 'capture_dropped.v1') return 'dropped';
    if (tag === 'capture_meta' || tag === 'meta') return 'meta';
    return CRITICAL_TAGS.includes(tag) ? tag : null;
  }

  /**
   * Enqueue one record. Records whose tag is one of CRITICAL_TAGS (or with
   * `critical:true`) enter the priority lane and are never dropped; other
   * records are envelope bodies and obey backpressure.
   *
   * Returns `{ accepted:boolean, critical:boolean, reason?:string }`.
   * This method is synchronous and never throws on sink failure.
   */
  enqueue(item) {
    if (this.closed) {
      return { accepted: false, critical: false, reason: 'closed' };
    }
    const tag = CaptureQueue.criticalTagOf(item);
    const critical = tag !== null;
    const requestId = item?.requestId != null ? String(item.requestId) : null;

    // P0 critical items are always accepted, even on duplicate requestIds:
    // ack/done/dropped/meta are distinct audit rows, not idempotent writes.
    if (this.idempotent && !critical && requestId) {
      if (this._hasSeen(requestId) || this.inFlight.has(requestId)) {
        this.stats.duplicates += 1;
        this._emit('duplicate', { requestId, lane: 'envelope' });
        return { accepted: false, critical, reason: 'duplicate' };
      }
      this._rememberSeen(requestId);
      this.inFlight.add(requestId);
    }

    const entry = {
      lane: critical ? 'critical' : 'envelope',
      tag,
      item,
      bytes: byteLengthOf(item),
      attempt: 0,
      requestId,
      enqueuedAt: this.scheduler.now(),
    };
    this.ring.push(entry);
    this.stats.enqueued += 1;
    if (critical) this.stats.critical += 1;
    else this.stats.envelopes += 1;

    this._emit('enqueued', {
      requestId,
      lane: entry.lane,
      tag: entry.tag,
      bytes: entry.bytes,
      depth: this.ring.length,
    });

    this._enforceBackpressure(critical);
    if (critical && this.timer !== null) {
      // A critical row must not wait behind a pending idle timer: cancel it and
      // dispatch the priority batch now.
      this.scheduler.clearTimeout(this.timer);
      this.timer = null;
    }
    if (critical) this._kickFlush();
    else this._maybeScheduleFlush();
    return { accepted: true, critical };
  }

  /** Alias used by the design doc: enqueue an envelope body by requestId. */
  pushEnvelope(requestId, envelope) {
    return this.enqueue({ requestId, tag: 'envelope', envelope });
  }

  /** P0 helper: enqueue a critical audit row by tag (ack/done/dropped/meta). */
  pushCritical(tag, payload) {
    if (!CRITICAL_TAGS.includes(tag)) {
      throw new TypeError(`Not a critical tag: ${tag}`);
    }
    return this.enqueue({ ...payload, tag, critical: true });
  }

  /**
   * Backpressure: keep the ring bounded by item count and bytes. Critical
   * items are never evicted. On overflow we evict the oldest non-critical
   * entry, report onDrop, and let the caller decide how to reconcile (the
   * design doc maps this to capture_dropped + offline replay).
   */
  _enforceBackpressure(justEnqueuedCritical) {
    let guard = 0;
    while (
      this.ring.length > this.maxItems ||
      (this.bytes > this.maxBytes && this._hasDroppable())
    ) {
      if (++guard > 10000) break; // defensive: never spin forever
      const idx = this.ring.findIndex((e) => e.lane !== 'critical' && !this.inRetry.has(e));
      if (idx === -1) {
        // All-critical ring: allow it to exceed numeric bounds rather than
        // losing a P0 row. Emit a warning event for the operator.
        this._emit('critical_overflow', { depth: this.ring.length, bytes: this.bytes });
        break;
      }
      const [victim] = this.ring.splice(idx, 1);
      this._release(victim);
      this.stats.dropped += 1;
      this.stats.overflow += 1;
      this._emit('drop', {
        requestId: victim.requestId,
        lane: victim.lane,
        reason: this.ring.length > this.maxItems ? 'maxItems' : 'maxBytes',
      });
      try {
        this.onDrop(victim.item, 'ring_overflow');
      } catch {
        // onDrop is best-effort; never break enqueue.
      }
    }
    this.bytes = this.ring.reduce((sum, e) => sum + e.bytes, 0);
    void justEnqueuedCritical;
  }

  _hasDroppable() {
    return this.ring.some((e) => e.lane !== 'critical');
  }

  _release(entry) {
    if (entry?.requestId) this.inFlight.delete(entry.requestId);
  }

  /** Schedule an idle flush. Batch-full flushes happen immediately. */
  _maybeScheduleFlush() {
    if (this.closed || this.flushing || this.timer !== null) return;
    const eligible = this.ring.filter((e) => !this.inRetry.has(e));
    if (eligible.length === 0) return;
    const criticalCount = eligible.filter((e) => e.lane === 'critical').length;
    if (eligible.length >= this.batchSize || criticalCount > 0) {
      // Critical and batch-full flushes are still asynchronous with respect to
      // enqueue() (they do not await the sink), but they are scheduled without
      // waiting for the idle timer so P0 rows leave the process first.
      this._kickFlush();
      return;
    }
    this.timer = this.scheduler.setTimeout(() => {
      this.timer = null;
      this._kickFlush();
    }, this.flushIntervalMs);
  }

  _kickFlush() {
    if (this.closed || this.flushing || this.kickScheduled) return;
    if (!this.ring.some((e) => !this.inRetry.has(e))) return;
    // Coalesce synchronous enqueues (e.g. ack + done emitted in the same tick)
    // into one batch. Deferred by a microtask, never by a timer, so a slow sink
    // still cannot block the caller's response path.
    this.kickScheduled = true;
    queueMicrotask(() => {
      this.kickScheduled = false;
      if (this.closed || this.flushing) return;
      if (!this.ring.some((e) => !this.inRetry.has(e))) return;
      this.flushing = true;
      // Intentionally not awaited by callers: a slow/failing sink must never
      // block the MCP response path. The returned promise is tracked internally.
      this._flushLoop().catch((error) => {
        this._emit('internal_error', { errorKind: error?.name ?? 'Error' });
      });
    });
  }

  /**
   * Flush one batch. Critical entries go first regardless of arrival order.
   * The whole batch is retried as a unit; failures back off exponentially.
   */
  async _flushLoop() {
    try {
      while (!this.closed) {
        const eligible = this.ring.filter((e) => !this.inRetry.has(e));
        if (eligible.length === 0) break;
        const critical = eligible.filter((e) => e.lane === 'critical');
        const chunks = critical.length > 0
          ? critical.slice(0, this.batchSize)
          : eligible.slice(0, this.batchSize);
        const success = await this._deliverBatch(chunks);
        if (!success && !this.closed) break; // retry scheduled outside the loop
        if (!success) break;
      }
    } finally {
      this.flushing = false;
      if (this.ring.length > 0 && !this.closed && this.timer === null) {
        this._maybeScheduleFlush();
      }
    }
  }

  /** Deliver a batch, retrying with exponential backoff. Resolves true/false. */
  async _deliverBatch(batch) {
    const payload = batch.map((e) => e.item);
    for (const entry of batch) entry.attempt += 1;
    const attempt = batch[0]?.attempt ?? 1;

    try {
      const result = await this.sink(payload, {
        lane: batch[0]?.lane,
        attempt,
        size: batch.length,
        requestIds: batch.map((e) => e.requestId).filter(Boolean),
      });
      if (result && result.ok === false) {
        throw Object.assign(new Error('sink_rejected'), {
          status: result.status ?? 500,
          retryable: result.retryable !== false,
        });
      }
      // Success: remove exactly these entries from the ring.
      for (const entry of batch) {
        const idx = this.ring.indexOf(entry);
        if (idx !== -1) this.ring.splice(idx, 1);
        this._release(entry);
      }
      this.bytes = this.ring.reduce((sum, e) => sum + e.bytes, 0);
      this.stats.flushed += batch.length;
      this.stats.batches += 1;
      this._emit('flush_ok', { lane: batch[0]?.lane, size: batch.length, attempt });
      return true;
    } catch (error) {
      const status = error?.status ?? error?.response?.status ?? null;
      const retryable = error?.retryable !== false && (status === null || RETRYABLE_STATUS.has(status));
      // Never echo the raw error message into an event: upstream libraries may
      // embed request bodies or tokens in error strings.
      this._emit('flush_failed', {
        lane: batch[0]?.lane,
        size: batch.length,
        attempt,
        status,
        retryable,
        errorKind: error?.name ?? 'Error',
      });
      if (retryable && attempt < this.maxAttempts) {
        this.stats.retries += 1;
        const delay = Math.min(this.backoffBaseMs * 2 ** (attempt - 1), this.backoffMaxMs);
        for (const entry of batch) this.inRetry.add(entry);
        this._emit('retry_scheduled', { attempt, delayMs: delay, size: batch.length });
        const handle = this.scheduler.setTimeout(async () => {
          this.retryTimers.delete(handle);
          for (const entry of batch) this.inRetry.delete(entry);
          const outcome = await this._deliverBatch(batch);
          if (!outcome && this.ring.length > 0 && !this.flushing) this._kickFlush();
          else if (this.ring.length > 0 && !this.flushing) this._maybeScheduleFlush();
        }, delay);
        this.retryTimers.add(handle);
        return false;
      }
      // Exhausted: hand every item to DLQ, remove from ring, and keep the
      // requestIds marked seen so a duplicate replay cannot re-enqueue them.
      for (const entry of batch) {
        this.inRetry.delete(entry);
        const idx = this.ring.indexOf(entry);
        if (idx !== -1) this.ring.splice(idx, 1);
        this._release(entry);
        this.stats.dlq += 1;
        this._emit('dlq', { requestId: entry.requestId, lane: entry.lane, attempt, status });
        try {
          await this.onDlq(entry.item, {
            reason: 'max_attempts',
            attempt,
            status,
            requestId: entry.requestId,
          });
        } catch {
          // DLQ sink failure must not throw into the response path.
        }
      }
      this.bytes = this.ring.reduce((sum, e) => sum + e.bytes, 0);
      return false;
    }
  }

  /**
   * Await all currently queued work (including scheduled retries). Used by
   * tests and by a collector shutdown hook; never called from the MCP handler.
   * Pass `{ timeoutMs }` to bound the wait.
   */
  async drain({ timeoutMs = 30000 } = {}) {
    const started = this.scheduler.now();
    while (!this.closed && (this.ring.length > 0 || this.flushing || this.retryTimers.size > 0)) {
      if (timeoutMs > 0 && this.scheduler.now() - started >= timeoutMs) {
        this._emit('drain_timeout', { depth: this.ring.length, retries: this.retryTimers.size });
        return false;
      }
      await this.scheduler.sleep(5);
      if (this.ring.length > 0 && !this.flushing && this.timer === null && this.retryTimers.size === 0) {
        this._kickFlush();
      }
    }
    return true;
  }

  /** Stop accepting new items; already-queued work is allowed to finish. */
  close() {
    this.closed = true;
    if (this.timer !== null) {
      this.scheduler.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Snapshot for observability/tests. Contains counts only, never payloads. */
  snapshot() {
    return {
      ...this.stats,
      depth: this.ring.length,
      bytes: this.bytes,
      criticalDepth: this.ring.filter((e) => e.lane === 'critical').length,
      flushing: this.flushing,
      retryTimers: this.retryTimers.size,
      closed: this.closed,
      // G-13: dedupe-window size is observable so long-process memory growth
      // can be asserted in tests and monitored in production. Counts only.
      seenSize: this.seen.size,
      seenCap: this.seenMaxEntries, // 0 = unbounded (explicitly configured)
      seenTtlMs: this.seenTtlMs,
    };
  }
}

/**
 * Convenience HTTP sink factory for the C direction (collector endpoint).
 * It checks response status (unlike the legacy writeHttpSink, which ignores
 * it), aborts on signal, and never includes tokens or envelope bytes in logs.
 */
export function createHttpSink({ url, fetchImpl = fetch, timeoutMs = 5000, headers = {} }) {
  return async function httpSink(batch) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ schema: 'gmg.capture_batch.v1', items: batch }),
        signal: controller.signal,
      });
      const status = response?.status ?? 0;
      if (!response?.ok) {
        throw Object.assign(new Error(`collector_status_${status}`), {
          status,
          retryable: RETRYABLE_STATUS.has(status),
        });
      }
      return { ok: true, status };
    } finally {
      clearTimeout(timer);
    }
  };
}

export default CaptureQueue;
