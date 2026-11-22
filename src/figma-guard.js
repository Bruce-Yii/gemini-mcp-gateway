/**
 * Figma-only quota circuit breaker + read-only result cache (in-process).
 *
 * Figma Starter accounts have a very small allowance for read-tool calls. When
 * the allowance is spent the upstream answers with a plan-limit / rate-limit
 * error. Retrying burns time without ever succeeding, so the gateway trips a
 * cooldown and short-circuits subsequent `server === 'figma'` calls until it
 * expires. Two read-only tools (`whoami`, `get_metadata`) additionally get a
 * short-lived LRU cache so repeated reads do not consume quota at all.
 *
 * Everything here is per-process, in-memory state. On serverless (Vercel)
 * every warm instance owns its own cooldown and cache; a cold start starts
 * with a clean slate. There is no shared KV/Redis coordination.
 */

export const DEFAULT_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24h
export const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000; // 1h
export const DEFAULT_CACHE_MAX = 200;
export const CACHEABLE_TOOLS = new Set(['whoami', 'get_metadata']);

const QUOTA_PATTERNS = [
  /Figma MCP tool call limit/i,
  /Starter plan/i,
  /upgrade your plan/i,
  /\b429\b/,
  /rate limit/i,
];

/** Error thrown while the Figma quota cooldown is active. */
export class FigmaQuotaCooldownError extends Error {
  constructor(remainingMs) {
    const seconds = Math.max(1, Math.ceil(remainingMs / 1000));
    super(`Figma 配额冷却中（剩余 ${seconds} 秒）：已检测到额度/限流错误，请稍后再试`);
    this.name = 'FigmaQuotaCooldownError';
    this.code = 'FIGMA_QUOTA_COOLDOWN';
    this.remainingMs = Math.max(0, remainingMs);
  }
}

/** Inspect a thrown error / error result / nested payload for quota wording. */
export function isFigmaQuotaError(value) {
  if (!value) return false;
  const seen = new Set();
  let text = '';
  const walk = (node, depth) => {
    if (!node || depth > 5 || seen.has(node)) return;
    if (typeof node !== 'object') { text += `\n${String(node)}`; return; }
    seen.add(node);
    if (typeof node.message === 'string') text += `\n${node.message}`;
    if (typeof node.error === 'string') text += `\n${node.error}`;
    if (typeof node.status === 'number') text += `\n${node.status}`;
    if (typeof node.statusCode === 'number') text += `\n${node.statusCode}`;
    if (typeof node.code === 'number') text += `\n${node.code}`;
    if (Array.isArray(node.content)) {
      for (const block of node.content) {
        if (block && typeof block.text === 'string') text += `\n${block.text}`;
        else walk(block, depth + 1);
      }
    }
    if (node.data && typeof node.data === 'object') walk(node.data, depth + 1);
    if (node.cause) walk(node.cause, depth + 1);
  };
  if (typeof value === 'string') text = value;
  else walk(value, 0);
  return QUOTA_PATTERNS.some((pattern) => pattern.test(text));
}

/** Deterministic cache key: tool name + canonical (key-sorted) JSON args. */
export function cacheKey(tool, args) {
  return `${tool}:${stableStringify(args ?? {})}`;
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function envMs(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Create a guard instance. Options override env vars, which override defaults.
 * The UpstreamManager creates one per instance, so state is never shared.
 */
export function createFigmaGuard(options = {}) {
  const cooldownMs = options.cooldownMs ?? envMs('FIGMA_COOLDOWN_MS', DEFAULT_COOLDOWN_MS);
  const ttlMs = options.cacheTtlMs ?? envMs('FIGMA_CACHE_TTL_MS', DEFAULT_CACHE_TTL_MS);
  const max = options.cacheMax ?? envMs('FIGMA_CACHE_MAX', DEFAULT_CACHE_MAX);
  let cooldownUntil = 0;
  /** @type {Map<string, {value:any, expires:number}>} insertion-ordered LRU */
  const cache = new Map();

  const remaining = () => Math.max(0, cooldownUntil - Date.now());

  return {
    get cooldownRemainingMs() { return remaining(); },
    get cacheSize() { return cache.size; },

    assertCool() {
      const left = remaining();
      if (left > 0) throw new FigmaQuotaCooldownError(left);
    },

    trip() {
      cooldownUntil = Date.now() + cooldownMs;
      cache.clear(); // stale cached reads would be misleading after a quota trip
    },

    reset() {
      cooldownUntil = 0;
      cache.clear();
    },

    isCacheable(tool) {
      return CACHEABLE_TOOLS.has(tool);
    },

    get(tool, args) {
      if (!CACHEABLE_TOOLS.has(tool)) return undefined;
      const key = cacheKey(tool, args);
      const hit = cache.get(key);
      if (!hit) return undefined;
      if (hit.expires <= Date.now()) {
        cache.delete(key);
        return undefined;
      }
      // Refresh LRU order on hit.
      cache.delete(key);
      cache.set(key, hit);
      return hit.value;
    },

    set(tool, args, value) {
      if (!CACHEABLE_TOOLS.has(tool) || max <= 0 || ttlMs <= 0) return;
      const key = cacheKey(tool, args);
      cache.delete(key);
      cache.set(key, { value, expires: Date.now() + ttlMs });
      while (cache.size > max) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
      }
    },
  };
}
