/**
 * Full-fidelity gateway capture (P1).
 *
 * The capture path is deliberately boring: copy request/response bytes and
 * headers verbatim, and hand the envelope to an async sink. It never awaits the
 * sink and never throws into the MCP handler.
 *
 * Storage is intentionally pluggable. P1 ships file/HTTP/console/R2 sinks.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { waitUntil } from '@vercel/functions';

const MAX_BODY_BYTES = 32 * 1024 * 1024;

export function captureHeaders(headers = {}) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) out[name] = value;
  return out;
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
    fetchImpl: options.fetchImpl ?? fetch,
  };
}

async function writeFileSink(cfg, envelope) {
  await mkdir(cfg.fileDir, { recursive: true });
  const name = `${envelope.ts.replace(/[:.]/g, '-')}-${envelope.requestId}.json`;
  await writeFile(join(cfg.fileDir, name), JSON.stringify(envelope), 'utf8');
}

async function writeHttpSink(cfg, envelope) {
  if (!cfg.httpUrl) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    await fetch(cfg.httpUrl, {
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
 * Start capture for one /mcp POST. Returns null when disabled.
 * The returned object is intentionally tiny and has no protocol surface.
 */
export function startCapture(req, res, options = {}) {
  const cfg = configFromOptions(options);
  if (cfg.mode === 'off') return null;

  const started = Date.now();
  const requestId = randomUUID();
  const chunks = [];
  let bytes = 0;
  let overflow = false;

  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);
  let finished = false;

  res.write = function captureWrite(chunk, encoding, callback) {
    if (chunk && !overflow) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), typeof encoding === 'string' ? encoding : 'utf8');
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
    if (finished) return originalEnd(chunk, encoding, callback);
    finished = true;
    if (chunk && !overflow) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), typeof encoding === 'string' ? encoding : 'utf8');
      bytes += buf.length;
      if (bytes > cfg.maxBytes) overflow = true;
      else chunks.push(buf);
    }
    const result = originalEnd(chunk, encoding, callback);
    // Never await: sink failure must not change the MCP response.
    queueMicrotask(() => {
      const envelope = {
        schema: 'gmg.capture.v1',
        ts: new Date(started).toISOString(),
        requestId,
        mode: cfg.mode,
        request: {
          method: req.method,
          url: req.url,
          headers: captureHeaders(req.headers),
          raw: req.__gatewayRawBody ?? null,
        },
        response: {
          status: res.statusCode,
          headers: captureHeaders(res.getHeaders?.() ?? {}),
          raw: overflow ? null : Buffer.concat(chunks).toString('utf8'),
          bytes,
          overflow,
          durationMs: Date.now() - started,
        },
      };
      const task = Promise.resolve()
        .then(() => writeSink(cfg, envelope))
        .catch((error) => console.warn('[capture] sink failed:', error?.message ?? String(error)));
      // Keep the function alive after the response where the platform allows
      // it; locally waitUntil may throw, in which case the task still runs.
      try { waitUntil(task); } catch { /* best-effort local runtime */ }
    });
    return result;
  };

  return { requestId };
}

export function captureEnabled(env = process.env) {
  return (env.CAPTURE_MODE ?? 'off') === 'full' || (env.CAPTURE_MODE ?? 'off') === 'meta';
}
