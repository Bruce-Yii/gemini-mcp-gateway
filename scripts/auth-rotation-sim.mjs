#!/usr/bin/env node
/**
 * auth-rotation-sim.mjs — isolated, deterministic OAuth refresh / rotation
 * simulation harness. Batch 15 (auth-sim). NON-PRODUCTION.
 *
 * Purpose
 * -------
 * Validate the *shape* of a future auth architecture (owner-fenced leases,
 * in-lease re-read, CAS + winner read-back, cross-environment namespaces,
 * shared-grant refusal) before touching src/oauth.js or src/upstream-auth.js.
 * Nothing here is imported by src/, registered as a tool, or wired to a real
 * OAuth provider. No network, no credentials, no real tokens anywhere.
 *
 * Determinism contract
 * --------------------
 *  - FakeClock: integer milliseconds, advanced explicitly in fixed quanta.
 *  - FakeKV: a Map with explicit NX/EX, owner-aware compare-and-delete and
 *    refresh-token CAS. Lock expiry is evaluated against FakeClock.now().
 *  - FakeOAuthProvider: a single-use refresh-token set. A second use of the
 *    same token returns {error:'invalid_grant'} and is counted. Rotation is
 *    synchronous inside a queued step; no Promise race against wall time.
 *  - A cooperative FIFO run queue pumps one "step" at a time. Each await of a
 *    fake async op enqueues a continuation; the scheduler drains in insertion
 *    order and advances the clock by CLOCK_QUANTUM_MS per drained step. The
 *    same seed always produces the same interleaving and the same report.
 *
 * The four strategies
 * -------------------
 *  none                 : no lock, no CAS — every instance spends its seed RT.
 *  current              : lock WITHOUT owner token + unconditional DEL (the
 *                         historically buggy shape; reproducible mis-delete /
 *                         double-refresh when a lease expires).
 *  owner-fenced         : NX lease with owner token, owner-aware release,
 *                         and CAS keyed on the spent RT (losers adopt winner).
 *  owner-fenced-readback: owner-fenced PLUS a re-read inside the lease and a
 *                         winner read-back after losing the CAS.
 *
 * This file exports a small API for tests and, when run directly, prints a
 * markdown-ish table to stdout.
 */

// ─── Constants ──────────────────────────────────────────────────────────────

export const STRATEGIES = Object.freeze([
  'none',
  'current',
  'owner-fenced',
  'owner-fenced-readback',
]);

export const CLOCK_QUANTUM_MS = 10;
export const DEFAULT_LEASE_TTL_MS = 100;
export const REFRESH_LATENCY_STEPS = 3; // provider "network" takes 3 queue turns
export const LOCK_WAIT_STEPS = 6;       // loser waits past provider latency + commit so winner read-back sees the new pair

const KEY_PREFIX = 'gmcgw:v1:upstream';

// ─── Fake clock ─────────────────────────────────────────────────────────────

export class FakeClock {
  constructor(start = 1_700_000_000_000) {
    this.t = start;
  }
  now() { return this.t; }
  advance(ms = CLOCK_QUANTUM_MS) { this.t += ms; return this.t; }
}

// ─── Cooperative queue ──────────────────────────────────────────────────────

/**
 * A microtask queue we control. `later(fn)` appends a step; `run()` drains it
 * in FIFO order and advances the clock once per step. Async simulation code
 * uses `later()` instead of `setTimeout`/bare Promise continuations, so all
 * interleavings are explicit and reproducible.
 */
export class StepQueue {
  constructor(clock) {
    this.clock = clock;
    this.q = [];
    this.steps = 0;
  }
  later(fn) { this.q.push(fn); }
  async drain(maxSteps = 10_000) {
    while (true) {
      // Flush promise continuations from the previous step (several chained
      // async wrappers deep) so their follow-up steps are queued before we
      // decide the queue is empty. Microtask order is fully deterministic.
      for (let i = 0; i < 8; i++) await Promise.resolve();
      if (!this.q.length) break;
      if (this.steps++ > maxSteps) throw new Error('sim: step budget exceeded (possible livelock)');
      const fn = this.q.shift();
      fn();
      this.clock.advance(CLOCK_QUANTUM_MS);
    }
    return this.steps;
  }
}

/** Wraps a synchronous value as a step-delayed "async" result. */
function deferred(queue, value) {
  return new Promise((resolve) => queue.later(() => resolve(value)));
}

// ─── Fake KV ────────────────────────────────────────────────────────────────

/**
 * Minimal KV with the commands the harness needs:
 *  - get(key): value or null (expired locks read as null).
 *  - set(key, value, 'NX', 'EX', ttl): NX + TTL; returns 'OK' or null.
 *  - del(key): unconditional delete (used by the buggy `current` strategy).
 *  - releaseLease(key, owner): compare-and-delete; only the owner succeeds.
 *  - renewLease(key, owner, ttl): extend only if still owned.
 *  - casToken(key, expectedRefresh, nextRaw): CAS on JSON.refresh_token.
 * Every command is deferred by one queue step, mirroring an async KV client.
 */
export class FakeKV {
  constructor(clock, queue) {
    this.clock = clock;
    this.queue = queue;
    this.map = new Map();
    this.calls = [];
  }

  _live(key) {
    const raw = this.map.get(key);
    if (raw == null) return null;
    try {
      const v = JSON.parse(raw);
      if (v && typeof v === 'object' && typeof v.expiresAt === 'number' && v.expiresAt <= this.clock.now()) {
        this.map.delete(key); // expired lease is logically absent
        return null;
      }
    } catch { /* plain value */ }
    return raw;
  }

  async get(key) {
    this.calls.push(['get', key]);
    return deferred(this.queue, this._live(key));
  }

  async set(key, value, ...rest) {
    this.calls.push(['set', key, ...rest]);
    const nx = rest.includes('NX');
    const exIdx = rest.indexOf('EX');
    const ttl = exIdx >= 0 ? Number(rest[exIdx + 1]) * 1000 : null;
    const raw = typeof value === 'string' ? value : JSON.stringify(value);
    let ok = true;
    if (nx && this._live(key) != null) ok = false;
    if (ok) {
      const stored = ttl != null ? JSON.stringify({ ...parseMaybe(raw), expiresAt: this.clock.now() + ttl }) : raw;
      this.map.set(key, stored);
    }
    return deferred(this.queue, ok ? 'OK' : null);
  }

  async del(key) {
    this.calls.push(['del', key]);
    this.map.delete(key);
    return deferred(this.queue, 1);
  }

  async releaseLease(key, owner) {
    this.calls.push(['releaseLease', key, owner]);
    const raw = this._live(key);
    if (raw == null) return deferred(this.queue, false);
    let held;
    try { held = JSON.parse(raw); } catch { held = { owner: raw }; }
    const heldOwner = typeof held === 'string' ? held : held?.owner;
    if (heldOwner !== owner) return deferred(this.queue, false);
    this.map.delete(key);
    return deferred(this.queue, true);
  }

  async renewLease(key, owner, ttlMs) {
    this.calls.push(['renewLease', key, owner]);
    const raw = this._live(key);
    if (raw == null) return deferred(this.queue, false);
    let held;
    try { held = JSON.parse(raw); } catch { held = { owner: raw }; }
    if (held?.owner !== owner) return deferred(this.queue, false);
    this.map.set(key, JSON.stringify({ ...held, expiresAt: this.clock.now() + ttlMs }));
    return deferred(this.queue, true);
  }

  async casToken(key, expectedRefresh, nextRaw) {
    this.calls.push(['casToken', key, String(expectedRefresh)]);
    const raw = this._live(key);
    if (raw == null) return deferred(this.queue, false);
    let cur;
    try { cur = JSON.parse(raw); } catch { return deferred(this.queue, false); }
    if (String(cur.refresh_token) !== String(expectedRefresh)) return deferred(this.queue, false);
    this.map.set(key, nextRaw);
    return deferred(this.queue, true);
  }

  /** Synchronous raw read, for assertions only. */
  peek(key) { return this.map.get(key) ?? null; }
  parse(key) {
    const raw = this.peek(key);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }
}

// JSON.parse that tolerates non-JSON stored values (plain helper, no globals).
function parseMaybe(s) { try { return JSON.parse(s); } catch { return {}; } }

// ─── Fake OAuth provider (single-use rotating refresh tokens) ───────────────

/**
 * Models a provider with rotating RTs: each RT may be exchanged exactly once.
 * A second exchange of an already-spent RT returns invalid_grant. Access and
 * refresh token values are synthetic and NEVER real credentials.
 */
export class FakeOAuthProvider {
  constructor(queue, { latencySteps = REFRESH_LATENCY_STEPS } = {}) {
    this.queue = queue;
    this.latencySteps = latencySteps;
    this.spent = new Set();
    this.counter = 0;
    this.refreshAttempts = 0;
    this.invalidGrants = 0;
    this.familyRevoked = false; // reuse detection revokes the whole token family
    this.events = [];
  }

  /**
   * Spend a refresh token. Returns {ok:true, access_token, refresh_token} or
   * {ok:false, error:'invalid_grant'}. The latency is modelled by queueing a
   * continuation for each of `latencySteps` turns — deterministic interleaving.
   */
  async refresh(refreshToken) {
    this.refreshAttempts++;
    for (let i = 0; i < this.latencySteps; i++) {
      await deferred(this.queue, undefined);
    }
    const key = String(refreshToken);
    if (this.spent.has(key)) {
      this.invalidGrants++;
      this.familyRevoked = true; // real providers revoke the family on reuse
      this.events.push({ kind: 'invalid_grant', refreshToken: mask(key) });
      return { ok: false, error: 'invalid_grant' };
    }
    this.spent.add(key);
    this.counter++;
    const pair = {
      ok: true,
      access_token: `ACCESS_${this.counter}`,
      refresh_token: `REFRESH_${this.counter}`,
      expires_in: 3600,
    };
    this.events.push({ kind: 'rotated', from: mask(key), to: mask(pair.refresh_token) });
    return pair;
  }
}

/** Never print a full token — not even a fake one — in reports or logs. */
export function mask(token) {
  const s = String(token ?? '');
  return s.length <= 4 ? '****' : `${s.slice(0, 3)}…${s.slice(-2)}`;
}

// ─── Namespacing (mirrors src/upstream-auth.js) ─────────────────────────────

/** Production + gateway keeps the legacy key; everything else is isolated. */
export function tokenKey(server, { environment = 'production', owner = 'gateway' } = {}) {
  const base = `${KEY_PREFIX}:${server}`;
  const ns = [];
  if (environment !== 'production') ns.push(environment);
  if (owner !== 'gateway') ns.push(`owner-${owner}`);
  return ns.length ? `${base}:${ns.join(':')}` : base;
}
export function lockKey(server, opts) { return `${tokenKey(server, opts)}:lock`; }

/** Only gateway-owned grants may be refreshed. DSH/manual/shared are read-only. */
export function mayRefresh(owner = 'gateway') { return owner === 'gateway'; }

// ─── Instance: the simulated gateway worker ─────────────────────────────────

/**
 * One gateway instance. `run()` performs a single getAccessToken-equivalent
 * refresh cycle under the given strategy. All I/O goes through FakeKV and the
 * provider; there is no wall-clock I/O and no real fetch.
 */
export class Instance {
  constructor({ id, kv, provider, clock, queue, strategy, server = 'notion',
    environment = 'production', owner = 'gateway', leaseTtlMs = DEFAULT_LEASE_TTL_MS,
    forceLockExpiry = false, casFailure = false, skipLock = false, refreshOverride = null,
    waitSteps = LOCK_WAIT_STEPS }) {
    Object.assign(this, { id, kv, provider, clock, queue, strategy, server,
      environment, owner, leaseTtlMs, forceLockExpiry, casFailure, skipLock, refreshOverride, waitSteps });
    this.key = tokenKey(server, { environment, owner });
    this.lock = lockKey(server, { environment, owner });
    this.lockOwner = null;
  }

  _newOwner() { return `owner-${this.id}`; }
  _now() { return this.clock.now(); }

  async _read() { return this.kv.parse(this.key); }

  async _save(rec) { await this.kv.set(this.key, JSON.stringify(rec)); }

  /** Acquire NX lease. `current` stores no owner; fenced strategies do. */
  async _acquire() {
    const fenced = this.strategy !== 'current';
    const owner = this._newOwner();
    const value = fenced
      ? JSON.stringify({ owner, expiresAt: this._now() + this.leaseTtlMs })
      // `current` has no owner-gated release; the internal marker exists only
      // so the harness can tell "my lock" from "someone else's lock" for the
      // mis-delete statistic. Real owner-less locks cannot make this check.
      : JSON.stringify({ expiresAt: this._now() + this.leaseTtlMs, _internalOwner: owner });
    const r = await this.kv.set(this.lock, value, 'NX', 'EX', String(this.leaseTtlMs / 1000));
    if (r === 'OK') { this.lockOwner = fenced ? owner : null; return true; }
    return false;
  }

  async _release() {
    if (this.strategy === 'current') {
      // BUG: unconditional DEL — can delete a lock that now belongs to someone
      // else after our lease expired. If a DIFFERENT worker's lock is present
      // at release time, this is a genuine mis-delete (counted in the trace).
      const held = this.kv.peek(this.lock);
      const heldOwner = held ? this.kv.parse(this.lock)?._internalOwner : null;
      this.misdeletedLock = Boolean(held) && heldOwner !== this._newOwner();
      await this.kv.del(this.lock);
      return 'unconditional-del';
    }
    if (!this.lockOwner) return 'skipped';
    const ok = await this.kv.releaseLease(this.lock, this.lockOwner);
    return ok ? 'owner-del' : 'fenced-out';
  }

  async _ownsLease() {
    if (this.strategy === 'owner-fenced' || this.strategy === 'owner-fenced-readback') {
      const raw = this.kv.parse(this.lock);
      return Boolean(raw && raw.owner === this.lockOwner);
    }
    return true; // none/current have no fencing
  }

  /**
   * Commit the rotated pair. CAS on the RT we actually spent; on a lost CAS,
   * owner-fenced strategies adopt the winner's record (read-back). The
   * `none`/`current` strategies write unconditionally (the historical bug).
   */
  async _commit(spentRt, next) {
    if (this.strategy === 'none' || this.strategy === 'current') {
      await this._save(next);
      return { committed: true, adoptedWinner: null };
    }
    const forcedFail = this.casFailure ? false : undefined;
    const ok = forcedFail === undefined
      ? await this.kv.casToken(this.key, spentRt, JSON.stringify(next))
      : forcedFail;
    if (ok) return { committed: true, adoptedWinner: null };
    const winner = await this._read();
    return { committed: false, adoptedWinner: winner };
  }

  /**
   * Run one refresh cycle. Returns a per-instance trace entry. Shared/DSH
   * grants are never refreshed: we read the access token and refuse.
   */
  async run({ seedRefresh, skipLock = false, refreshOverride = null }) {
    const rec0 = await this._read();
    const trace = { id: this.id, strategy: this.strategy, refreshCalls: 0,
      invalidGrants: 0, committed: false, adoptedWinner: false,
      release: null, result: null, refusedShared: false, staleReleases: 0,
      seedWrites: 0 };

    // Shared grant gate (read-only). No lease, no provider call.
    if (!mayRefresh(this.owner)) {
      trace.refusedShared = true;
      trace.result = rec0?.access_token ?? 'NO_ACCESS_TOKEN';
      return trace;
    }

    const readBefore = rec0 ?? { access_token: 'ACCESS_seed', refresh_token: seedRefresh };
    // Lagging-replica simulation: a worker may hold a distinct-but-stale RT
    // (not the same token, so no invalid_grant) whose CAS must still lose.
    let spentRt = refreshOverride ?? readBefore.refresh_token;
    const useLock = this.strategy !== 'none' && !skipLock;

    // Acquire lease (unless strategy=none or the scenario simulates a lock
    // backend being unavailable, in which case only CAS protects us).
    let acquired = !useLock;
    if (useLock) acquired = await this._acquire();
    if (!acquired) {
      // Loser waits past provider latency, then either adopts the winner's
      // record or — if the lease vanished (expiry) — re-acquires it.
      for (let i = 0; i < this.waitSteps; i++) await deferred(this.queue, undefined);
      const afterWait = await this._read();
      if (afterWait?.refresh_token && afterWait.refresh_token !== spentRt) {
        // Winner already rotated the grant: adopt its token, never spend ours.
        trace.result = afterWait.access_token;
        trace.adoptedWinner = true;
        trace.release = 'not-held';
        return trace;
      }
      const holder = await this.kv.get(this.lock);
      if (holder === null) {
        acquired = await this._acquire();
        if (!acquired) {
          const winner = await this._read();
          trace.result = winner?.access_token ?? readBefore.access_token;
          trace.adoptedWinner = Boolean(winner);
          trace.release = 'not-held';
          return trace;
        }
      } else {
        const winner = await this._read();
        trace.result = winner?.access_token ?? readBefore.access_token;
        trace.adoptedWinner = Boolean(winner);
        trace.release = 'not-held';
        return trace;
      }
    }

    // Simulate a lease expiring mid-refresh (the historical failure mode):
    // the lock is removed while THIS worker is still inside its provider call.
    let expired = false;
    if (this.forceLockExpiry) {
      await deferred(this.queue, undefined);
      if (this.strategy === 'owner-fenced-readback') {
        // Keepalive renews the lease while the slow provider call is in flight:
        // the expiry attempt is neutralised. This mirrors _keepLeaseAlive in
        // src/upstream-auth.js and is why the full strategy survives here.
        const raw = this.kv.parse(this.lock);
        if (raw?.owner === this.lockOwner) {
          await this.kv.renewLease(this.lock, this.lockOwner, this.leaseTtlMs * 3);
        }
      } else {
        this.kv.map.delete(this.lock);
        expired = true;
      }
    }

    // owner-fenced-readback: re-read INSIDE the lease; if another worker already
    // rotated, adopt its token and do not spend our stale RT.
    if (this.strategy === 'owner-fenced-readback') {
      const latest = await this._read();
      if (latest?.refresh_token && latest.refresh_token !== spentRt) {
        trace.result = latest.access_token;
        trace.adoptedWinner = true;
        trace.release = await this._release();
        return trace;
      }
    }

    // Cold start: no record in KV. Seed it under the lease (or unconditionally
    // for the legacy no-lock strategy) BEFORE spending the RT, so CAS has a
    // record to compare against.
    if (!rec0) {
      const seeded = { access_token: 'ACCESS_seed', refresh_token: seedRefresh, owner: this.owner };
      if (!useLock) {
        await this._save(seeded);
        trace.seedWrites = 1;
      } else {
        const latest = await this._read();
        if (latest?.refresh_token) {
          spentRt = latest.refresh_token; // another worker seeded first
        } else {
          await this._save(seeded);
          trace.seedWrites = 1;
        }
      }
    }

    // Spend the refresh token at the provider.
    const resp = await this.provider.refresh(spentRt);
    trace.refreshCalls = 1;
    if (!resp.ok) {
      trace.invalidGrants = 1;
      trace.result = readBefore.access_token;
      trace.release = await this._release();
      if (this.misdeletedLock) trace.staleReleases = 1;
      return trace;
    }

    const next = {
      access_token: resp.access_token,
      refresh_token: resp.refresh_token,
      owner: this.owner,
      expires_at: this._now() + resp.expires_in * 1000,
    };

    // Lost the lease mid-refresh → our result is not authoritative; adopt
    // whatever is in KV (fenced strategies only). The `current` strategy has
    // no owner check and commits anyway, AND its unconditional DEL can erase
    // the new holder's lock — both bugs are visible in the lock-expiry case.
    if (useLock && !(await this._ownsLease())) {
      if (this.strategy === 'current') {
        await this._save(next);
        trace.committed = true;
        trace.result = resp.access_token;
      } else {
        const winner = await this._read();
        trace.result = winner?.access_token ?? resp.access_token;
        trace.adoptedWinner = Boolean(winner);
      }
      trace.release = await this._release();
      if (this.misdeletedLock) trace.staleReleases = 1;
      return trace;
    }

    const committed = await this._commit(spentRt, next);
    trace.committed = committed.committed;
    trace.adoptedWinner = Boolean(committed.adoptedWinner);
    trace.result = committed.adoptedWinner?.access_token ?? resp.access_token;
    trace.release = await this._release();
    if (this.misdeletedLock) trace.staleReleases = 1;
    return trace;
  }
}

// ─── Scenario runner ────────────────────────────────────────────────────────

/**
 * Run a named scenario for one strategy and return a deterministic report.
 * scenario names:
 *  'concurrent-2' | 'concurrent-3' : N instances refresh the same seed grant.
 *  'cold-start'                    : two instances seed+refresh simultaneously.
 *  'lock-expiry'                   : holder's lease expires mid-refresh.
 *  'cas-failure'                   : winner commits, loser's CAS fails.
 *  'shared-grant'                  : DSH-owned grant must be read-only.
 *  'cross-env'                     : production vs preview namespaces isolated.
 */
export async function runScenario(strategy, scenario = 'concurrent-2', options = {}) {
  if (!STRATEGIES.includes(strategy)) throw new Error(`unknown strategy: ${strategy}`);
  const clock = new FakeClock(options.startTime ?? 1_700_000_000_000);
  const queue = new StepQueue(clock);
  const kv = new FakeKV(clock, queue);
  const provider = new FakeOAuthProvider(queue, { latencySteps: options.latencySteps ?? REFRESH_LATENCY_STEPS });
  const server = options.server ?? 'notion';
  const seedRefresh = options.seedRefresh ?? 'REFRESH_seed';

  const make = (id, opts = {}) => new Instance({
    id, kv, provider, clock, queue, strategy, server,
    environment: opts.environment ?? 'production',
    owner: opts.owner ?? 'gateway',
    leaseTtlMs: opts.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS,
    forceLockExpiry: opts.forceLockExpiry ?? false,
    casFailure: opts.casFailure ?? false,
    skipLock: opts.skipLock ?? false,
    refreshOverride: opts.refreshOverride ?? null,
    waitSteps: opts.waitSteps ?? LOCK_WAIT_STEPS,
  });

  const instances = [];
  let finalKey = tokenKey(server, { environment: 'production', owner: 'gateway' });

  switch (scenario) {
    case 'concurrent-2':
    case 'concurrent-3': {
      const n = scenario === 'concurrent-2' ? 2 : 3;
      // Seed ONE grant in KV; all instances share it.
      kv.map.set(finalKey, JSON.stringify({ access_token: 'ACCESS_seed', refresh_token: seedRefresh, owner: 'gateway' }));
      for (let i = 1; i <= n; i++) instances.push(make(i));
      break;
    }
    case 'cold-start': {
      // Two instances start with no KV record and the same env seed: one must
      // seed+refresh; the other must adopt (no double spend).
      for (let i = 1; i <= 2; i++) instances.push(make(i));
      break;
    }
    case 'lock-expiry': {
      kv.map.set(finalKey, JSON.stringify({ access_token: 'ACCESS_seed', refresh_token: seedRefresh, owner: 'gateway' }));
      // Worker 1's lease expires mid-refresh. Worker 2 retries quickly and
      // takes the expired lock; worker 1 then releases with an owner-less DEL
      // (current strategy) or a fenced release (owner-fenced strategies).
      instances.push(make(1, { forceLockExpiry: true }));
      instances.push(make(2, { waitSteps: 2 }));
      instances.push(make(3));
      break;
    }
    case 'cas-failure': {
      kv.map.set(finalKey, JSON.stringify({ access_token: 'ACCESS_seed', refresh_token: seedRefresh, owner: 'gateway' }));
      // Simulate a lock-backend hiccup + a lagging replica holding a distinct
      // stale RT: both provider calls succeed, so ONLY CAS protects the grant.
      // Worker 2's CAS (keyed on its stale RT) must fail and it must adopt
      // worker 1's winner record without overwriting it.
      const noLock = { skipLock: true };
      instances.push(make(1, noLock));
      instances.push(make(2, { ...noLock, casFailure: true, refreshOverride: 'REFRESH_stale' }));
      break;
    }
    case 'shared-grant': {
      finalKey = tokenKey(server, { environment: 'production', owner: 'dsh' });
      kv.map.set(finalKey, JSON.stringify({ access_token: 'ACCESS_dsh', refresh_token: seedRefresh, owner: 'dsh', source: 'dsh-mcp-connector-oauth-grant' }));
      instances.push(make(1, { owner: 'dsh' }));
      instances.push(make(2, { owner: 'dsh' }));
      break;
    }
    case 'cross-env': {
      const prodKey = tokenKey(server, { environment: 'production' });
      const prevKey = tokenKey(server, { environment: 'preview' });
      kv.map.set(prodKey, JSON.stringify({ access_token: 'ACCESS_prod', refresh_token: 'REFRESH_prod', owner: 'gateway' }));
      kv.map.set(prevKey, JSON.stringify({ access_token: 'ACCESS_prev', refresh_token: 'REFRESH_prev', owner: 'gateway' }));
      instances.push(make(1, { environment: 'production' }));
      instances.push(make(2, { environment: 'preview' }));
      break;
    }
    default:
      throw new Error(`unknown scenario: ${scenario}`);
  }

  // Start every instance; the queue drains deterministically. Each run()
  // suspends at its first deferred await, so the queue holds every step in
  // insertion order before we drain. Then await the promises for the traces.
  const pending = instances.map((inst) => inst.run({
    seedRefresh, skipLock: inst.skipLock, refreshOverride: inst.refreshOverride,
  }));
  await queue.drain();
  const traces = await Promise.all(pending);
  traces.sort((a, b) => a.id - b.id);

  const refreshCount = traces.reduce((n, t) => n + t.refreshCalls, 0);
  const invalidCount = traces.reduce((n, t) => n + t.invalidGrants, 0);
  const staleDeleteCount = traces.reduce((n, t) => n + t.staleReleases, 0);
  const refusedShared = traces.some((t) => t.refusedShared);
  const anyCommitted = traces.some((t) => t.committed);
  const finalRec = kv.parse(finalKey);

  // Cross-env has two authoritative keys; report both explicitly.
  const crossEnvRecords = scenario === 'cross-env' ? {
    production: kv.parse(tokenKey(server, { environment: 'production' })),
    preview: kv.parse(tokenKey(server, { environment: 'preview' })),
  } : null;

  const finalUsable = scenario === 'cross-env'
    ? Boolean(crossEnvRecords.production?.access_token && crossEnvRecords.preview?.access_token &&
        crossEnvRecords.production.refresh_token !== crossEnvRecords.preview.refresh_token)
    : scenario === 'shared-grant'
      ? Boolean(finalRec?.access_token && !anyCommitted && refreshCount === 0)
      : Boolean(finalRec?.access_token && !finalRec.needsReauth && !provider.familyRevoked);

  return {
    strategy,
    scenario,
    refreshCount,
    invalidGrantCount: invalidCount,
    staleDeleteCount,
    finalTokenUsable: finalUsable,
    refusedShared,
    // Reports are safe to print: every token value, including per-instance
    // results, is masked. No real (or full synthetic) token ever leaves here.
    traces: traces.map((t) => ({ ...t, result: mask(t.result) })),
    final: finalRec ? {
      access_token: mask(finalRec.access_token),
      refresh_token: mask(finalRec.refresh_token),
    } : null,
    crossEnv: crossEnvRecords ? {
      production: crossEnvRecords.production && {
        access_token: mask(crossEnvRecords.production.access_token),
        refresh_token: mask(crossEnvRecords.production.refresh_token),
      },
      preview: crossEnvRecords.preview && {
        access_token: mask(crossEnvRecords.preview.access_token),
        refresh_token: mask(crossEnvRecords.preview.refresh_token),
      },
    } : null,
    provider: {
      refreshAttempts: provider.refreshAttempts,
      invalidGrants: provider.invalidGrants,
      familyRevoked: provider.familyRevoked,
      rotations: provider.events.filter((e) => e.kind === 'rotated').length,
    },
    steps: queue.steps,
  };
}

/** Run ALL scenarios for ALL strategies (report matrix). */
export async function runMatrix(options = {}) {
  const scenarios = options.scenarios ?? [
    'concurrent-2', 'concurrent-3', 'cold-start', 'lock-expiry',
    'cas-failure', 'shared-grant', 'cross-env',
  ];
  const out = [];
  for (const strategy of STRATEGIES) {
    for (const scenario of scenarios) {
      out.push(await runScenario(strategy, scenario, options));
    }
  }
  return out;
}

// ─── CLI ────────────────────────────────────────────────────────────────────

async function main(argv) {
  const scenarioIdx = argv.indexOf('--scenario');
  const scenario = scenarioIdx >= 0 ? argv[scenarioIdx + 1] : 'concurrent-2';
  const rows = [];
  for (const s of STRATEGIES) rows.push(await runScenario(s, scenario));
  const yes = (b) => (b ? 'yes' : 'NO');
  console.log(`auth-rotation-sim · scenario=${scenario} · deterministic fake clock/queue · no real tokens`);
  console.log('');
  console.log('| strategy | refresh | invalid_grant | stale-del | final usable |');
  console.log('|---|---:|---:|---:|:---:|');
  for (const r of rows) {
    console.log(`| ${r.strategy} | ${r.refreshCount} | ${r.invalidGrantCount} | ${r.staleDeleteCount} | ${yes(r.finalTokenUsable)} |`);
  }
  console.log('');
  console.log(`provider: refreshAttempts=${rows[0].provider.refreshAttempts} (per-strategy; isolated fakes)`);
}

// Detect direct execution without relying on import.meta in older Node paths.
if (typeof process !== 'undefined' && process.argv?.[1]) {
  const entry = process.argv[1].replace(/\\/g, '/');
  if (entry.endsWith('/auth-rotation-sim.mjs')) main(process.argv.slice(2));
}
