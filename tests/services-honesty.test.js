import test from 'node:test';
import assert from 'node:assert/strict';
import { createCodeModeTools, servicesSnapshot } from '../src/codemode.js';

/**
 * Regression suite for the services() "false sense of security" fix.
 *
 * The old implementation marked every mounted server as `online: true` from a
 * cold-start snapshot. A credential can expire moments later, so a bare
 * "online" boolean is an unsafe claim. These tests pin the honest contract:
 *   - every service carries an ISO `verifiedAt` and a snapshot/not-live `note`;
 *   - failedServers are reported as `offline`;
 *   - no service claims absolute "healthy" without real freshness evidence;
 *   - both execute tool descriptions warn about the cold-start snapshot and
 *     tell the model to re-auth on invalid_token/unauthorized;
 *   - services() still makes ZERO upstream tool calls.
 */

const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const ENTRIES = [
  { server: 'github', tool: 'get_me', name: 'github__get_me', description: '', inputSchema: {} },
  { server: 'github', tool: 'search_code', name: 'github__search_code', description: '', inputSchema: {} },
  { server: 'linear', tool: 'list_issues', name: 'linear__list_issues', description: '', inputSchema: {} },
  { server: 'notion', tool: 'notion-search', name: 'notion__notion-search', description: '', inputSchema: {} },
];

/** A manager with an explicit callTool counter so "zero network" is provable. */
function makeManager({ failedServers = [] } = {}) {
  let callToolCount = 0;
  const manager = {
    getEntries: () => ENTRIES,
    failedServers,
    callTool: () => {
      callToolCount += 1;
      throw new Error('services() must not call the upstream');
    },
  };
  return { manager, callToolCount: () => callToolCount };
}

const servicesFromSandbox = async (exec) => {
  const wire = await exec.handler({ code: 'async () => codemode.services()' });
  assert.equal(wire.isError, undefined, JSON.stringify(wire));
  return wire.result;
};

test('honesty#1: every service has an ISO verifiedAt and a snapshot / not-live note', async () => {
  const { manager } = makeManager({ failedServers: ['notion'] });
  const [, , exec] = createCodeModeTools(manager);
  const before = Date.now();
  const { services } = await servicesFromSandbox(exec);
  const after = Date.now();

  assert.ok(services.length >= 3, 'expected aggregated services');
  for (const svc of services) {
    assert.match(svc.verifiedAt, ISO_TS, `${svc.name}: verifiedAt must be an ISO timestamp`);
    const observedMs = Date.parse(svc.verifiedAt);
    assert.ok(
      observedMs >= before - 1000 && observedMs <= after + 1000,
      `${svc.name}: verifiedAt must reflect when this snapshot was produced`,
    );
    assert.match(svc.note, /snapshot/i, `${svc.name}: note must say this is a snapshot`);
    assert.match(
      svc.note,
      /not live-verified|not a live health check/i,
      `${svc.name}: note must say it is not live-verified`,
    );
    assert.ok(svc.note.includes(svc.verifiedAt), `${svc.name}: note should quote its own snapshot time`);
    assert.equal(typeof svc.toolCount, 'number', `${svc.name}: toolCount preserved`);
  }
});

test('honesty#2: failedServers services are offline (mounted or not)', async () => {
  const { manager } = makeManager({ failedServers: ['notion', 'vercel'] });
  // vercel has no entries at all — it must still be surfaced as offline.
  const snap = servicesSnapshot(manager);
  const byName = new Map(snap.services.map((s) => [s.name, s]));

  assert.equal(byName.get('notion').status, 'offline');
  assert.equal(byName.get('notion').online, false);
  assert.equal(byName.get('vercel').status, 'offline');
  assert.equal(byName.get('vercel').toolCount, 0);
  for (const name of ['notion', 'vercel']) {
    assert.ok(byName.get(name).verifiedAt, `${name}: offline service still has verifiedAt`);
    assert.match(byName.get(name).note, /snapshot|not live-verified/i);
  }
});

test('honesty#3: no service claims absolute "healthy" without freshness evidence', async () => {
  const { manager } = makeManager({ failedServers: [] });
  const [, , exec] = createCodeModeTools(manager);
  const { services } = await servicesFromSandbox(exec);

  assert.ok(services.length > 0);
  for (const svc of services) {
    // The real UpstreamManager exposes no token-expiry / lastConnectAt, so the
    // honest downgrade must be "observed" — NEVER bare "healthy".
    assert.notEqual(svc.status, 'healthy', `${svc.name}: no evidence means no "healthy" claim`);
    assert.ok(
      ['observed', 'offline'].includes(svc.status),
      `${svc.name}: expected conservative status vocabulary, got ${svc.status}`,
    );
  }
});

test('honesty#4: execute descriptions warn it is a cold-start snapshot, not a live check', () => {
  const { manager } = makeManager();
  const [searchTool, execRead, exec] = createCodeModeTools(manager);
  for (const tool of [execRead, exec]) {
    assert.match(tool.description, /cold-start snapshot/i, `${tool.name}: mentions cold-start snapshot`);
    assert.match(tool.description, /NOT a live health check/i, `${tool.name}: denies being a live check`);
    assert.match(tool.description, /invalid_token/i, `${tool.name}: names the auth-failure signal`);
    assert.match(tool.description, /unauthorized/i, `${tool.name}: names the auth-failure signal`);
    assert.match(tool.description, /needs re-auth/i, `${tool.name}: tells the model to re-auth`);
    assert.doesNotMatch(
      tool.description,
      /check connected-service online status/i,
      `${tool.name}: old misleading wording removed`,
    );
  }
  // The helper is intentionally not a new MCP tool schema (no reconnect needed).
  assert.equal(searchTool.name, 'search');
});

test('honesty#5: services() makes zero upstream tool calls', async () => {
  const { manager, callToolCount } = makeManager({ failedServers: ['notion'] });
  const [, execRead, exec] = createCodeModeTools(manager);
  await servicesFromSandbox(execRead);
  await servicesFromSandbox(exec);
  await servicesFromSandbox(exec); // getter path: still local-only
  assert.equal(callToolCount(), 0, 'services() must never reach the upstream');
});

test('honesty#6: an offline service with no entries still carries the honest fields', () => {
  const snap = servicesSnapshot({
    getEntries: () => [],
    failedServers: new Set(['github']), // Set is accepted as well as Array
  });
  assert.deepEqual(Object.keys(snap), ['services']);
  assert.equal(snap.services.length, 1);
  const svc = snap.services[0];
  assert.equal(svc.name, 'github');
  assert.equal(svc.status, 'offline');
  assert.match(svc.verifiedAt, ISO_TS);
  assert.match(svc.note, /not live-verified/i);
  assert.match(svc.needsReauth, /token|授权/);
});

test('honesty#7: when real freshness evidence exists, even "healthy"/"stale" keeps the caveat', () => {
  const now = Date.now();
  const snap = servicesSnapshot({
    getEntries: () => [
      { server: 'github', tool: 'get_me', name: 'github__get_me' },
      { server: 'linear', tool: 'list_issues', name: 'linear__list_issues' },
    ],
    failedServers: [],
    lastConnectAt: now,
    tokenExpiresAt: { github: now + 2 * 60 * 60 * 1000, linear: now + 10 * 60 * 1000 },
  });
  const byName = new Map(snap.services.map((s) => [s.name, s]));
  assert.equal(byName.get('github').status, 'healthy');
  assert.equal(byName.get('linear').status, 'stale'); // credential expires within 1h
  for (const svc of snap.services) {
    assert.match(svc.verifiedAt, ISO_TS);
    assert.match(svc.note, /not a live health check/i, `${svc.name}: caveat survives the upgrade`);
    assert.match(svc.note, /re-auth/i);
  }
});

test('honesty#8: defensive on a missing / malformed manager', () => {
  assert.deepEqual(servicesSnapshot({}), { services: [] });
  assert.deepEqual(servicesSnapshot({ getEntries: () => null, failedServers: 'github' }), { services: [] });
});
