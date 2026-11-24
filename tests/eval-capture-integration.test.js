/**
 * G7 integration: gateway_helper capture events must actually land in the
 * request capture context when the sandbox calls the host helpers. Synthetic
 * digest tests alone do not prove the emission path.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { captureStore } from '../src/evidence/capture.js';
import { runInSandbox } from '../src/execution/codemode.js';

test('G7: services/listTools/remainingCalls emit gateway_helper events inside startCapture context', async () => {
  const context = { requestId: 'req-gateway-helper', started: Date.now(), events: [] };
  const out = await captureStore.run(context, () => runInSandbox({
    code: `async () => {
      const services = codemode.services();
      const listed = codemode.listTools();
      const remaining = codemode.remainingCalls();
      return { serviceCount: services.services.length, listed: listed.length, remaining };
    }`,
    tools: [{ name: 'github__search_repositories', server: 'github', description: '', inputSchema: { type: 'object' } }],
    callTool: async () => ({}),
    servicesInfo: {
      services: [
        { name: 'github', toolCount: 42, status: 'observed', online: true, needsReauth: false },
        { name: 'notion', toolCount: 0, status: 'offline', online: false, needsReauth: true },
      ],
    },
  }));
  assert.ok(!out.isError, out.result);
  const helpers = context.events.filter((event) => event?.type === 'gateway_helper');
  const names = helpers.map((event) => event?.payload?.helper).sort();
  assert.deepEqual(names, ['listTools', 'remainingCalls', 'services']);
  const services = helpers.find((event) => event.payload.helper === 'services');
  assert.equal(services.payload.services.length, 2);
  assert.equal(services.payload.services.find((row) => row.name === 'notion').needsReauth, true);
  const listed = helpers.find((event) => event.payload.helper === 'listTools');
  assert.equal(listed.payload.count, 1);
  assert.deepEqual(listed.payload.services, ['github']);
  // The guest-visible values are unchanged by the capture side-channel.
  assert.deepEqual(JSON.parse(out.result), { serviceCount: 2, listed: 1, remaining: 50 });
});
