import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startCapture } from '../src/capture.js';
import { makeCaptureFetch } from '../src/upstreams.js';

function fakeRes() {
  const body = [];
  return {
    statusCode: 200,
    headersSent: false,
    getHeaders() { return {}; },
    write(chunk) { body.push(Buffer.from(String(chunk))); return true; },
    end(chunk) { if (chunk) body.push(Buffer.from(String(chunk))); this.ended = true; return this; },
    body,
  };
}

/** Run `fn` inside a capture envelope and return the events array from the
 * persisted envelope. Calls res.end() so the sink flushes. */
async function withCapture(fn, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'gmg-cap-http-'));
  try {
    const req = { method: 'POST', url: '/mcp', headers: {}, __gatewayRawBody: '{}' };
    const res = fakeRes();
    const cap = startCapture(req, res, { mode: 'full', sink: 'file', fileDir: dir, ...options });
    assert.ok(cap, 'capture must be enabled');
    await fn();
    res.end('ok');
    // Allow the sink write to settle (waitUntil/microtask + fs); poll instead of
    // assuming a fixed 100ms under full-suite load.
    let files = [];
    for (let i = 0; i < 40; i += 1) {
      files = await readdir(dir);
      if (files.length > 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(files.length, 1, 'file sink should have written one envelope');
    return JSON.parse(await readFile(join(dir, files[0]), 'utf8'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('makeCaptureFetch captures non-SSE response body (capped) without changing the returned Response', async () => {
  const payload = '{"jsonrpc":"2.0","result":{"tools":[{"name":"t"}]}}';
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = async (input, init) => {
    fetchCalled = true;
    return new Response(payload, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    let returned;
    const envelope = await withCapture(async () => {
      const captureFetch = makeCaptureFetch('github');
      returned = await captureFetch('https://example.invalid/mcp', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
    });
    assert.ok(fetchCalled);
    // The SDK-facing Response is untouched and fully readable.
    assert.equal(returned.status, 200);
    assert.equal(await returned.text(), payload);
    const events = envelope.events.filter((e) => e.type === 'upstream_http');
    assert.equal(events.length, 2);
    assert.equal(events[0].payload.phase, 'request');
    assert.equal(events[0].payload.method, 'POST');
    assert.equal(events[1].payload.phase, 'response');
    assert.equal(events[1].payload.status, 200);
    assert.equal(events[1].payload.body, payload);
    assert.ok(!events[1].payload.bodySkipped);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('makeCaptureFetch marks SSE responses as bodySkipped:stream and does not block', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('data: {"x":1}\n\n', {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
  try {
    let returned;
    const started = Date.now();
    const envelope = await withCapture(async () => {
      const captureFetch = makeCaptureFetch('sse-server');
      returned = await captureFetch('https://example.invalid/sse');
    });
    // Must not wait for the stream body to finish.
    assert.ok(Date.now() - started < 1000);
    assert.equal(await returned.text(), 'data: {"x":1}\n\n');
    const events = envelope.events.filter((e) => e.type === 'upstream_http');
    const resp = events.find((e) => e.payload.phase === 'response');
    assert.equal(resp.payload.bodySkipped, 'stream');
    assert.ok(!('body' in resp.payload));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('makeCaptureFetch truncates large non-SSE bodies at the cap', async () => {
  const originalFetch = globalThis.fetch;
  const big = 'x'.repeat(80 * 1024);
  globalThis.fetch = async () => new Response(big, {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  try {
    let returned;
    const envelope = await withCapture(async () => {
      const captureFetch = makeCaptureFetch('big');
      returned = await captureFetch('https://example.invalid/big');
    });
    // SDK still sees the full body.
    assert.equal((await returned.text()).length, big.length);
    const resp = envelope.events.find((e) => e.type === 'upstream_http' && e.payload.phase === 'response').payload;
    assert.equal(resp.body.length, 64 * 1024);
    assert.equal(resp.bodyTruncated, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('makeCaptureFetch degrades gracefully when Response has no clone', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    status: 204,
    headers: new Headers(),
    ok: true,
    // No clone(), no body — like some SDK test doubles.
  });
  try {
    const envelope = await withCapture(async () => {
      const captureFetch = makeCaptureFetch('fake');
      await captureFetch('https://example.invalid/noclone');
    });
    const resp = envelope.events.find((e) => e.type === 'upstream_http' && e.payload.phase === 'response').payload;
    assert.equal(resp.status, 204);
    assert.equal(resp.bodySkipped, 'no-clone');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('capture_dropped fallback POSTs the envelope with token and timeout', async () => {
  const { captureFailureStats } = await import('../src/capture.js');
  const before = captureFailureStats().dropped;
  const posts = [];
  const fakeFetch = async (url, init) => {
    posts.push({ url, init });
    return { ok: true, status: 200 };
  };
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    const req = { method: 'POST', url: '/mcp', headers: {}, __gatewayRawBody: '{}' };
    const res = fakeRes();
    startCapture(req, res, {
      mode: 'full',
      sink: 'r2',
      fetchImpl: fakeFetch,
      r2AccountId: '', // force R2 failure (missing account/bucket)
      fallbackHttpUrl: 'https://fallback.example/capture',
      fallbackHttpToken: 'fb-token',
    });
    res.end('ok');
    await new Promise((r) => setTimeout(r, 80));
  } finally {
    console.error = originalError;
  }
  assert.equal(captureFailureStats().dropped, before + 1);
  assert.ok(errors.some((line) => line.includes('gmg.capture_dropped.v1')));
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, 'https://fallback.example/capture');
  assert.equal(posts[0].init.method, 'POST');
  assert.equal(posts[0].init.headers.authorization, 'Bearer fb-token');
  const body = JSON.parse(posts[0].init.body);
  assert.equal(body.schema, 'gmg.capture_dropped.v1');
  assert.ok(body.envelope, 'full envelope included in fallback POST');
  assert.equal(body.envelope.request.raw, '{}');
});

test('fallback POST failure stays silent and does not affect counting', async () => {
  const { captureFailureStats } = await import('../src/capture.js');
  const before = captureFailureStats().dropped;
  const fakeFetch = async () => { throw new Error('fallback down'); };
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    const req = { method: 'POST', url: '/mcp', headers: {} };
    const res = fakeRes();
    startCapture(req, res, {
      mode: 'full', sink: 'r2', fetchImpl: fakeFetch,
      r2AccountId: '', fallbackHttpUrl: 'https://fallback.example/capture',
    });
    res.end('ok');
    await new Promise((r) => setTimeout(r, 80));
  } finally {
    console.error = originalError;
  }
  assert.equal(captureFailureStats().dropped, before + 1);
  // Only the capture_dropped line, no unhandled fallback error.
  assert.ok(errors.some((line) => line.includes('[capture_dropped]')));
});
