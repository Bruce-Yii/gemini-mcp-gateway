import test from 'node:test';
import assert from 'node:assert/strict';
import { runInSandbox } from '../src/codemode.js';

async function evalBody(body) {
  const out = await runInSandbox({
    code: `async () => { ${body} }`,
    tools: [],
    callTool: async () => ({}),
  });
  assert.ok(!out.isError, out.result);
  return out.result;
}

test('codemode.formatDate returns ISO/date/time and nowISO is UTC ISO', async () => {
  const result = JSON.parse(await evalBody(`
    return {
      iso: codemode.formatDate('2026-01-02T03:04:05.006Z'),
      date: codemode.formatDate('2026-01-02T03:04:05.006Z', { date: true }),
      time: codemode.formatDate('2026-01-02T03:04:05.006Z', { time: true }),
      both: codemode.formatDate('2026-01-02T03:04:05.006Z', { date: true, time: true, ms: true }),
      now: codemode.nowISO(),
      globalName: typeof formatDate,
    };
  `));
  assert.equal(result.iso, '2026-01-02T03:04:05.006Z');
  assert.equal(result.date, '2026-01-02');
  assert.equal(result.time, '03:04:05');
  assert.equal(result.both, '2026-01-02T03:04:05.006Z');
  assert.match(result.now, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(result.globalName, 'function');
});

test('codemode.formatDate throws a clear error for invalid input', async () => {
  const out = await runInSandbox({
    code: `async () => { try { codemode.formatDate('not-a-date'); return 'no-throw'; } catch (e) { return String(e.message); } }`,
    tools: [],
    callTool: async () => ({}),
  });
  assert.ok(!out.isError, out.result);
  assert.match(out.result, /formatDate: invalid date value/);
});

test('execute guidance states Intl is unavailable and recommends formatDate', async () => {
  const { createCodeModeTools } = await import('../src/codemode.js');
  const manager = {
    getEntries: () => [
      { server: 'github', tool: 'get_me', name: 'github__get_me', description: 'x', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
    ],
    callTool: async () => ({ content: [{ type: 'text', text: '{}' }] }),
    services: () => ({ services: [] }),
    remainingCalls: () => 50,
  };
  const tools = createCodeModeTools(manager);
  const execute = tools.find((tool) => tool.name === 'execute');
  assert.match(execute.description, /Intl is unavailable/);
  assert.match(execute.description, /formatDate/);
});
