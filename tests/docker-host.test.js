/**
 * Docker runtime: --host CLI parsing/resolution and the actual bind address.
 *
 * These tests exercise the exported pure helpers (parseCliArgs / resolveHost)
 * plus startHttpServer's real listen() so a future refactor cannot silently
 * move the default back to 0.0.0.0 or drop the explicit --host thread-through.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_HOST,
  parseCliArgs,
  resolveHost,
  startHttpServer,
} from '../src/server.js';

/* ---------- 1. pure CLI parsing ---------- */

test('parseCliArgs: default has no host set (loopback is applied by resolveHost)', () => {
  const args = parseCliArgs(['--config', 'gateway.json', '--port', '3000']);
  assert.equal(args.config, 'gateway.json');
  assert.equal(args.port, 3000);
  assert.equal(args.host, undefined, 'absence of --host must stay unset so the default can win');
  assert.equal(args.stdio, false);
});

test('parseCliArgs: --host <addr> and --host=<addr> both parse', () => {
  assert.equal(parseCliArgs(['--host', '0.0.0.0']).host, '0.0.0.0');
  assert.equal(parseCliArgs(['--host=0.0.0.0']).host, '0.0.0.0');
  assert.equal(parseCliArgs(['--host', '::1']).host, '::1');
  // Full CLI shape used by docker-compose.yml.
  const dockerArgs = parseCliArgs([
    '--config', '/app/gateway-config.json',
    '--host', '0.0.0.0',
    '--port', '3000',
  ]);
  assert.deepEqual(dockerArgs, {
    config: '/app/gateway-config.json',
    host: '0.0.0.0',
    port: 3000,
    stdio: false,
  });
});

test('parseCliArgs: --host without a value or followed by a flag is rejected', () => {
  assert.throws(() => parseCliArgs(['--host']), /--host requires an address/);
  assert.throws(() => parseCliArgs(['--host', '--port', '3000']), /--host requires an address/);
});

test('parseCliArgs: existing flags are unchanged (no regression)', () => {
  assert.equal(parseCliArgs(['--stdio']).stdio, true);
  assert.equal(parseCliArgs(['--port=8080']).port, 8080);
  assert.throws(() => parseCliArgs(['--port', '70000']), /invalid --port/);
  assert.throws(() => parseCliArgs(['--stdio', '--port', '3000']), /mutually exclusive/);
  assert.throws(() => parseCliArgs(['--bogus']), /unknown argument/);
});

/* ---------- 2. resolution default ---------- */

test('resolveHost: default is 127.0.0.1 and explicit host wins', () => {
  assert.equal(DEFAULT_HOST, '127.0.0.1');
  assert.equal(resolveHost(parseCliArgs([])), '127.0.0.1');
  assert.equal(resolveHost(parseCliArgs(['--port', '3000'])), '127.0.0.1');
  assert.equal(resolveHost(parseCliArgs(['--host', '0.0.0.0'])), '0.0.0.0');
  assert.equal(resolveHost({ host: undefined }), '127.0.0.1');
});

/* ---------- 3. real bind address ---------- */

test('startHttpServer binds 127.0.0.1 by default and honours options.host', async () => {
  const upstreamManager = { getEntries: () => [], getWhitelist: () => [] };

  const defaultServer = await startHttpServer(upstreamManager, 0);
  try {
    assert.equal(defaultServer.address().address, '127.0.0.1', 'default must stay loopback');
  } finally {
    await new Promise((done) => defaultServer.close(done));
  }

  const dockerServer = await startHttpServer(upstreamManager, 0, { host: '0.0.0.0' });
  try {
    assert.equal(dockerServer.address().address, '0.0.0.0', '--host must be threaded into listen()');
  } finally {
    await new Promise((done) => dockerServer.close(done));
  }
});

test('startHttpServer: passing host through options does not break gateway options', async () => {
  const upstreamManager = { getEntries: () => [], getWhitelist: () => [] };
  const server = await startHttpServer(upstreamManager, 0, {
    host: '127.0.0.1',
    mode: 'codemode',
    maxCalls: 3,
  });
  try {
    assert.equal(server.address().address, '127.0.0.1');
    assert.equal(typeof server.address().port, 'number');
  } finally {
    await new Promise((done) => server.close(done));
  }
});
