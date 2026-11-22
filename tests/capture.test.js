import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gunzipSync } from 'node:zlib';
import { startCapture, captureHeaders, captureEvent, captureFailureStats } from '../src/capture.js';

function fakeRes() {
  const body = [];
  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    headersSent: false,
    writeHead(status, headers) { this.statusCode = status; this.headersSent = true; Object.assign(this.headers, headers ?? {}); },
    getHeaders() { return this.headers; },
    write(chunk) { body.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); return true; },
    end(chunk) { if (chunk) body.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); this.ended = true; return this; },
    body,
  };
}

test('capture preserves credential headers verbatim and preserves response bytes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gmg-capture-'));
  try {
    const req = {
      method: 'POST', url: '/mcp',
      headers: { authorization: 'Bearer secret-token', 'content-type': 'application/json', 'x-trace': 't1' },
      __gatewayRawBody: '{"jsonrpc":"2.0","method":"tools/list","id":1}',
    };
    const res = fakeRes();
    const cap = startCapture(req, res, { mode: 'full', sink: 'file', fileDir: dir });
    assert.ok(cap?.requestId);
    res.write('{"jsonrpc":"2.0",');
    res.end('"result":{}}');
    assert.equal(Buffer.concat(res.body).toString(), '{"jsonrpc":"2.0","result":{}}');
    await new Promise((resolve) => setTimeout(resolve, 150));
    const files = await readdir(dir);
    assert.equal(files.length, 1);
    const envelope = JSON.parse(await readFile(join(dir, files[0]), 'utf8'));
    assert.equal(envelope.schema, 'gmg.capture.v1');
    assert.equal(envelope.request.raw, req.__gatewayRawBody);
    assert.equal(envelope.response.raw, '{"jsonrpc":"2.0","result":{}}');
    assert.equal(envelope.request.headers.authorization, 'Bearer secret-token');
    assert.equal(envelope.request.headers['x-trace'], 't1');
    assert.equal(envelope.response.status, 200);
    assert.ok(envelope.response.durationMs >= 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('capture can be disabled without touching the response', () => {
  const req = { method: 'POST', url: '/mcp', headers: {} };
  const res = fakeRes();
  assert.equal(startCapture(req, res, { mode: 'off' }), null);
  assert.equal(typeof res.write, 'function');
  res.write('ok');
  res.end();
  assert.equal(Buffer.concat(res.body).toString(), 'ok');
});

test('captureHeaders copies all header values (no redaction)', () => {
  const out = captureHeaders({ cookie: ['a=1', 'b=2'], 'x-api-key': 'k', accept: 'application/json' });
  assert.deepEqual(out.cookie, ['a=1', 'b=2']);
  assert.equal(out['x-api-key'], 'k');
  assert.equal(out.accept, 'application/json');
});

test('capture sink failure never throws into the response path', async () => {
  const req = { method: 'POST', url: '/mcp', headers: {}, __gatewayRawBody: '{}' };
  const res = fakeRes();
  startCapture(req, res, { mode: 'full', sink: 'http', httpUrl: 'http://127.0.0.1:1/capture', httpToken: '' });
  res.end('ok');
  assert.equal(Buffer.concat(res.body).toString(), 'ok');
  await new Promise((resolve) => setTimeout(resolve, 100));
});

test('R2 sink uploads gzipped raw envelope to the private capture bucket', async () => {
  const req = { method: 'POST', url: '/mcp', headers: { authorization: 'Bearer x' }, __gatewayRawBody: '{"a":1}' };
  const res = fakeRes();
  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return { ok: true, status: 200 };
  };
  startCapture(req, res, {
    mode: 'full', sink: 'r2', fetchImpl,
    r2AccountId: 'acct', r2Bucket: 'bucket', r2AuthEmail: 'u@example.com', r2AuthKey: 'k',
    r2Prefix: 'capture',
  });
  res.end('{"ok":true}');
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.ok(captured, 'R2 PUT was issued');
  assert.match(captured.url, /accounts\/acct\/r2\/buckets\/bucket\/objects\/capture\/\d{4}-\d{2}-\d{2}\//);
  assert.equal(captured.init.method, 'PUT');
  assert.equal(captured.init.headers['x-auth-email'], 'u@example.com');
  assert.equal(captured.init.headers['content-type'], 'application/gzip');
  const envelope = JSON.parse(gunzipSync(captured.init.body).toString('utf8'));
  assert.equal(envelope.request.raw, '{"a":1}');
  assert.equal(envelope.response.raw, '{"ok":true}');
});

test('captureEvent adds upstream/sandbox events to the active envelope', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gmg-capture-events-'));
  try {
    const req = { method: 'POST', url: '/mcp', headers: {}, __gatewayRawBody: '{}' };
    const res = fakeRes();
    startCapture(req, res, { mode: 'full', sink: 'file', fileDir: dir });
    captureEvent('upstream', { server: 'github', tool: 'get_file_contents', args: { path: 'README.md' }, result: { ok: true } });
    captureEvent('sandbox', { tool: 'execute', code: 'async () => 1', output: { result: '1' } });
    res.end('ok');
    await new Promise((resolve) => setTimeout(resolve, 150));
    const files = await readdir(dir);
    const envelope = JSON.parse(await readFile(join(dir, files[0]), 'utf8'));
    assert.equal(envelope.events.length, 2);
    assert.equal(envelope.events[0].type, 'upstream');
    assert.equal(envelope.events[1].type, 'sandbox');
    assert.equal(envelope.events[0].payload.tool, 'get_file_contents');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


test('tapTransport records both upstream directions as raw frames', async () => {
  const { tapTransport } = await import('../src/upstreams.js');
  const dir = await mkdtemp(join(tmpdir(), 'gmg-capture-frames-'));
  try {
    const req = { method: 'POST', url: '/mcp', headers: {}, __gatewayRawBody: '{}' };
    const res = fakeRes();
    startCapture(req, res, { mode: 'full', sink: 'file', fileDir: dir });
    const transport = {
      sent: [],
      async send(message) { this.sent.push(message); },
      onmessage: null,
    };
    tapTransport(transport, 'github');
    await transport.send({ jsonrpc: '2.0', method: 'tools/list', id: 1 });
    transport.onmessage({ jsonrpc: '2.0', result: { tools: [] }, id: 1 });
    res.end('ok');
    await new Promise((resolve) => setTimeout(resolve, 150));
    const files = await readdir(dir);
    const envelope = JSON.parse(await readFile(join(dir, files[0]), 'utf8'));
    const frames = envelope.events.filter((event) => event.type === 'upstream_frame');
    assert.equal(frames.length, 2);
    assert.equal(frames[0].payload.direction, 'out');
    assert.equal(frames[0].payload.message.method, 'tools/list');
    assert.equal(frames[1].payload.direction, 'in');
    assert.equal(frames[1].payload.server, 'github');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('capture sink failure emits a structured capture_dropped event', async () => {
  const { captureFailureStats } = await import('../src/capture.js');
  const before = captureFailureStats().dropped;
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    const req = { method: 'POST', url: '/mcp', headers: {}, __gatewayRawBody: '{}' };
    const res = fakeRes();
    startCapture(req, res, { mode: 'full', sink: 'http', httpUrl: 'http://127.0.0.1:1/capture' });
    res.end('ok');
    await new Promise((resolve) => setTimeout(resolve, 150));
  } finally {
    console.error = original;
  }
  assert.equal(captureFailureStats().dropped, before + 1);
  assert.ok(errors.some((line) => line.includes('[capture_dropped]')));
  assert.ok(errors.some((line) => line.includes('gmg.capture_dropped.v1')));
});

test('capture preserves Uint8Array response chunks as text, not comma-separated bytes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gmg-capture-u8-'));
  try {
    const req = { method: 'POST', url: '/mcp', headers: {}, __gatewayRawBody: '{}' };
    const res = fakeRes();
    startCapture(req, res, { mode: 'full', sink: 'file', fileDir: dir });
    res.write(new TextEncoder().encode('event: message\n'));
    res.end(new TextEncoder().encode('data: {"ok":true}\n'));
    await new Promise((resolve) => setTimeout(resolve, 150));
    const files = await readdir(dir);
    const envelope = JSON.parse(await readFile(join(dir, files[0]), 'utf8'));
    assert.equal(envelope.response.raw, 'event: message\ndata: {"ok":true}\n');
    assert.ok(!envelope.response.raw.startsWith('101,118'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('capture_dropped includes fallback envelope and increments the counter once', async () => {
  const before = captureFailureStats().dropped;
  const posts = [];
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    const req = { method: 'POST', url: '/mcp', headers: { 'x-t': 'v' }, __gatewayRawBody: '{"q":1}' };
    const res = fakeRes();
    startCapture(req, res, {
      mode: 'full', sink: 'r2', fetchImpl: async (url, init) => {
        posts.push({ url, init });
        return { ok: true, status: 200 };
      },
      r2AccountId: '', // forces a failure inside writeR2Sink
      fallbackHttpUrl: 'https://fb.example/capture',
    });
    res.end('done');
    await new Promise((r) => setTimeout(r, 80));
  } finally {
    console.error = originalError;
  }
  assert.equal(captureFailureStats().dropped, before + 1);
  assert.equal(posts.length, 1);
  const body = JSON.parse(posts[0].init.body);
  assert.equal(body.schema, 'gmg.capture_dropped.v1');
  assert.equal(body.envelope.request.headers['x-t'], 'v');
  assert.equal(body.envelope.response.raw, 'done');
  assert.ok(errors.some((l) => l.includes('[capture_dropped]')));
});

test('capture fallback is disabled when no fallback URL is configured', async () => {
  const before = captureFailureStats().dropped;
  let fetchCalls = 0;
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    const req = { method: 'POST', url: '/mcp', headers: {} };
    const res = fakeRes();
    startCapture(req, res, {
      mode: 'full', sink: 'r2', fetchImpl: async () => { fetchCalls += 1; return { ok: true }; },
      r2AccountId: '',
    });
    res.end('ok');
    await new Promise((r) => setTimeout(r, 80));
  } finally {
    console.error = originalError;
  }
  assert.equal(captureFailureStats().dropped, before + 1);
  assert.equal(fetchCalls, 0);
  assert.ok(errors.some((l) => l.includes('[capture_dropped]')));
});
