import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAppHandler } from '../src/vercel-app.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function makeReq({ method = 'GET', url = '/', headers = {} } = {}) {
  return {
    method,
    url,
    headers: { host: 'gateway.example', ...headers },
    async *[Symbol.asyncIterator]() {},
  };
}

function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    headersSent: false,
    ended: false,
    body: '',
    writeHead(status, headers = {}) {
      this.statusCode = status;
      for (const [key, value] of Object.entries(headers)) this.headers[key.toLowerCase()] = value;
      this.headersSent = true;
      return this;
    },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) this.body += chunk.toString();
      this.ended = true;
      return this;
    },
    getHeader(key) {
      return this.headers[key.toLowerCase()];
    },
  };
}

async function invoke(handler, options) {
  const res = makeRes();
  await handler(makeReq(options), res);
  return res;
}

const store = {
  async getToken() {
    throw new Error('healthz must not read the token store');
  },
};

test('GET /healthz reports build identity and config without touching upstreams or the token store', async () => {
  const handler = createAppHandler({
    store,
    config: { mode: 'codemode', servers: [{ name: 'github' }, { name: 'notion' }] },
    mcpHandler: async () => {
      throw new Error('healthz must not build the MCP handler');
    },
  });
  const res = await invoke(handler, { method: 'GET', url: '/healthz' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.getHeader('cache-control'), 'no-store');
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(typeof body.commit, 'string');
  assert.ok(body.commit.length > 0);
  assert.equal(typeof body.buildHash, 'string');
  assert.ok(body.buildHash.length > 0);
  assert.equal(body.mode, 'codemode');
  assert.deepEqual(body.servers, ['github', 'notion']);
  assert.equal(body.configLoaded, true);
  assert.equal(body.env, 'development');
  assert.equal(typeof body.uptimeMs, 'number');
  assert.ok(body.uptimeMs >= 0);
  assert.ok(!Number.isNaN(Date.parse(body.startedAt)));
});

test('GET /healthz stays 200 and reports the config error when the config is broken', async () => {
  const handler = createAppHandler({
    store,
    config: { servers: 42 },
    mcpHandler: async () => {
      throw new Error('healthz must not build the MCP handler');
    },
  });
  const res = await invoke(handler, { method: 'GET', url: '/healthz' });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.configLoaded, false);
  assert.match(body.configError, /map|not a function/i);
});

test('unknown routes still 404 alongside /healthz', async () => {
  const handler = createAppHandler({ store, config: { servers: [] } });
  const res = await invoke(handler, { method: 'GET', url: '/nope' });
  assert.equal(res.statusCode, 404);
});

test('write-build-info --print is deterministic and does not modify the checkout', () => {
  const generated = path.join(root, 'src', 'build-info.js');
  const before = readFileSync(generated, 'utf8');
  const run = () =>
    JSON.parse(
      execFileSync(process.execPath, [path.join(root, 'scripts', 'write-build-info.mjs'), '--print'], {
        cwd: root,
        encoding: 'utf8',
      }),
    );
  const first = run();
  const second = run();
  assert.equal(first.buildHash, second.buildHash);
  assert.match(first.buildHash, /^[0-9a-f]{40}$/);
  assert.match(first.pathHash, /^[0-9a-f]{40}$/);
  assert.ok(Array.isArray(first.files) && first.files.length > 10);
  assert.ok(first.files.includes('src/vercel-app.js'));
  assert.ok(!first.files.includes('src/build-info.js'), 'the generated file must not hash itself');
  assert.equal(typeof first.commit, 'string');
  assert.ok(first.commit.length > 0);
  assert.ok(!Number.isNaN(Date.parse(first.builtAt)));
  assert.equal(readFileSync(generated, 'utf8'), before, '--print must not rewrite src/build-info.js');
});
