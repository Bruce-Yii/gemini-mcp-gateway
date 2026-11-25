/**
 * M1 physical client isolation — adapter contract, platform dispatch and
 * byte-level regression against the PRE-REFACTOR baseline.
 *
 * `tests/fixtures/m1-client-baseline.json` was captured from commit 45efd2e
 * (before `src/clients/<platform>/` existed) by running the then-current
 * `createCodeModeTools` / `encodeToolResult` / `encodeModelOutput` /
 * `toModelOutput` for every stock profile. These tests assert the refactor is
 * behaviour-preserving: the tool face (names/order/schemas/descriptions/
 * annotations), the wire encodings and the default execute budget are all
 * byte-for-byte identical to that snapshot.
 *
 * They also pin the physical separation: each platform adapter serves its own
 * prompts.js, the router is the only dispatch point, and a platform's tuning
 * cannot leak into another platform's face.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  CHATGPT,
  CLAUDE,
  CLIENT_PROFILES,
  DESCRIPTION_MODE_COMPACT,
  GEMINI,
  PROFILE_HEADER,
} from '../src/client-profile.js';
import { detectClientPlatform } from '../src/client-platform.js';
import { createCodeModeTools, toModelOutput } from '../src/codemode.js';
import {
  CLIENT_ADAPTERS,
  CLIENT_PLATFORMS,
  describeClientResolution,
  isClientAdapter,
  resolveClientAdapter,
  stockClientAdapter,
} from '../src/clients/index.js';
import { fullDescriptions as geminiFull } from '../src/clients/gemini/prompts.js';
import { fullDescriptions as chatgptFull } from '../src/clients/chatgpt/prompts.js';
import { fullDescriptions as claudeFull } from '../src/clients/claude/prompts.js';

const BASELINE = JSON.parse(fs.readFileSync(
  fileURLToPath(new URL('./fixtures/m1-client-baseline.json', import.meta.url)),
  'utf8',
));

const EMPTY_ENV = Object.freeze({});
const PLATFORM_IDS = Object.freeze({ gemini: GEMINI, chatgpt: CHATGPT, claude: CLAUDE });

// Test-only OAuth client ids (real ones live in CLIENT_PLATFORM_OAUTH_MAP env).
const TEST_OAUTH_MAP = Object.freeze({
  'test-client-gemini': GEMINI,
  'test-client-chatgpt': CHATGPT,
  'test-client-claude': CLAUDE,
});

/** Same fixture upstreams used to capture the baseline snapshot. */
const ENTRIES = [
  {
    name: 'fake__list_issues', server: 'fake', tool: 'list_issues',
    description: 'List issues in a repository.\nLong second line that must not matter.',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer' } }, required: ['limit'] },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: 'fake__create_issue', server: 'other', tool: 'create_issue',
    description: 'Create one issue.',
    inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
];

function fakeManager() {
  return {
    getEntries: () => ENTRIES,
    callTool: async () => ({ content: [{ type: 'text', text: '{}' }] }),
  };
}

function toolFace(tools) {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations,
  }));
}

async function executeResult(tools, code, name = 'execute') {
  const tool = tools.find((entry) => entry.name === name);
  return tool.handler({ code });
}

/* ================================================================== *
 * 1. Router: the only dispatch point, reusing the existing resolvers
 * ================================================================== */

test('M1-physical router: every stock platform is reachable and frozen', () => {
  assert.deepEqual(CLIENT_PLATFORMS, ['gemini', 'chatgpt', 'claude']);
  assert.deepEqual(Object.keys(CLIENT_ADAPTERS).sort(), [...CLIENT_PLATFORMS].sort());
  for (const platform of CLIENT_PLATFORMS) {
    const adapter = CLIENT_ADAPTERS[platform];
    assert.equal(adapter.id, platform);
    assert.equal(isClientAdapter(adapter), true);
    assert.equal(Object.isFrozen(adapter), true);
    for (const mode of ['full', 'compact']) {
      for (const tool of ['search', 'execute_read', 'execute']) {
        assert.equal(typeof adapter.prompts[mode][tool], 'function', `${platform}.${mode}.${tool}`);
      }
    }
  }
});

test('M1-physical router: header / clientInfo / OAuth map / UA dispatch', () => {
  const cases = [
    [{ headers: { [PROFILE_HEADER]: 'chatgpt' } }, CHATGPT],
    [{ headers: { [PROFILE_HEADER]: 'claude' } }, CLAUDE],
    [{ headers: { [PROFILE_HEADER]: 'gemini' } }, GEMINI],
    [{ body: { params: { clientInfo: { name: 'chatgpt' } } } }, CHATGPT],
    [{ body: { params: { clientInfo: { name: 'claude' } } } }, CLAUDE],
    [{ oauthClientId: 'test-client-chatgpt', oauthClientMap: TEST_OAUTH_MAP }, CHATGPT],
    [{ oauthClientId: 'test-client-claude', oauthClientMap: TEST_OAUTH_MAP }, CLAUDE],
    [{ headers: { 'user-agent': 'ChatGPT-Agent/1.0' } }, CHATGPT],
    [{ headers: { 'user-agent': 'claude-code/1.0' } }, CLAUDE],
  ];
  for (const [input, expected] of cases) {
    const adapter = resolveClientAdapter({ ...input, env: EMPTY_ENV });
    assert.equal(adapter.id, expected, JSON.stringify(input));
  }
});

test('M1-physical router: env opt-ins still choose the platform; unknown falls back to gemini', () => {
  assert.equal(resolveClientAdapter({ env: { GATEWAY_CLIENT_CHATGPT: '1' } }).id, CHATGPT);
  assert.equal(resolveClientAdapter({ env: { GATEWAY_CLIENT_CLAUDE: 'true' } }).id, CLAUDE);
  assert.equal(resolveClientAdapter({ env: { GATEWAY_CLIENT_PROFILE: 'chatgpt' } }).id, CHATGPT);
  // Unknown / missing / ambiguous -> gemini (historical default).
  assert.equal(resolveClientAdapter({ env: EMPTY_ENV }).id, GEMINI);
  assert.equal(resolveClientAdapter({ headers: { 'user-agent': 'Mozilla/5.0' }, env: EMPTY_ENV }).id, GEMINI);
  assert.equal(resolveClientAdapter({ profile: { id: 'not-a-platform' } }).id, GEMINI);
  assert.equal(resolveClientAdapter({ profile: '__proto__' }).id, GEMINI);
  // Explicit `profile` wins over header signals (server.js passes it through).
  assert.equal(resolveClientAdapter({ profile: CLIENT_PROFILES[CLAUDE], headers: { [PROFILE_HEADER]: 'chatgpt' } }).id, CLAUDE);
});

test('M1-physical router: resolution record agrees with the capture platform label', () => {
  for (const [input, expected] of [
    [{ headers: { [PROFILE_HEADER]: 'chatgpt' } }, CHATGPT],
    [{ headers: { [PROFILE_HEADER]: 'claude' } }, CLAUDE],
    [{ body: { params: { clientInfo: { name: 'claude' } } } }, CLAUDE],
    [{ oauthClientId: 'test-client-chatgpt', oauthClientMap: TEST_OAUTH_MAP }, CHATGPT],
    [{ headers: { 'user-agent': 'claude-code/2' } }, CLAUDE],
  ]) {
    const record = describeClientResolution({ ...input, env: EMPTY_ENV });
    assert.equal(record.adapterId, expected, JSON.stringify(input));
    assert.equal(record.platform, expected, JSON.stringify(input));
    assert.equal(detectClientPlatform({ ...input, env: EMPTY_ENV }).platform, expected);
  }
  const unknown = describeClientResolution({ env: EMPTY_ENV });
  assert.equal(unknown.adapterId, GEMINI, 'adapter fallback');
  assert.equal(unknown.platform, 'unknown', 'observability label stays honest');
  assert.equal(stockClientAdapter('chatgpt'), CLIENT_ADAPTERS.chatgpt);
});

/* ================================================================== *
 * 2. Tool face: byte-identical to the pre-refactor snapshot
 * ================================================================== */

test('M1-physical regression: stock tool face matches the pre-refactor baseline', () => {
  const baselineDefault = JSON.stringify(BASELINE.toolFaceDefault);
  assert.equal(JSON.stringify(toolFace(createCodeModeTools(fakeManager(), { env: EMPTY_ENV }))), baselineDefault);
  for (const [label, id] of Object.entries(PLATFORM_IDS)) {
    const face = toolFace(createCodeModeTools(fakeManager(), {
      profile: CLIENT_PROFILES[id],
      env: EMPTY_ENV,
    }));
    assert.equal(JSON.stringify(face), JSON.stringify(BASELINE.toolFace[label]), label);
  }
});

test('M1-physical regression: names, order and schemas are the objective contract', () => {
  for (const id of [GEMINI, CHATGPT, CLAUDE]) {
    const tools = createCodeModeTools(fakeManager(), { profile: CLIENT_PROFILES[id], env: EMPTY_ENV });
    assert.deepEqual(tools.map((tool) => tool.name), ['search', 'execute_read', 'execute'], id);
    assert.deepEqual(tools.map((tool) => tool.inputSchema), BASELINE.toolFace.gemini.map((tool) => tool.inputSchema), id);
  }
});

/* ================================================================== *
 * 3. Encodings: each platform owns its strategy, parity with legacy output
 * ================================================================== */

const WIRE_RESULT = {
  content: [{ type: 'text', text: JSON.stringify({ ok: true, count: 3 }) }],
  structuredContent: { ok: true, count: 3 },
};
const MODEL_PAYLOAD = { result: { ok: true, count: 3 }, status: 'ok', isError: false };

test('M1-physical regression: per-platform encoding matches the pre-refactor baseline', () => {
  for (const [label, id] of Object.entries(PLATFORM_IDS)) {
    const adapter = resolveClientAdapter({ profile: CLIENT_PROFILES[id], env: EMPTY_ENV });
    assert.equal(adapter.wireEncoding, BASELINE.legacy[label].encodeModelOutput.structuredContent ? 'structuredContent' : 'textJson', label);
    assert.equal(
      JSON.stringify(adapter.encodeToolResult(WIRE_RESULT)),
      JSON.stringify(BASELINE.legacy[label].encodeToolResult),
      `${label} encodeToolResult`,
    );
    assert.equal(
      JSON.stringify(adapter.encodeModelOutput(MODEL_PAYLOAD)),
      JSON.stringify(BASELINE.legacy[label].encodeModelOutput),
      `${label} encodeModelOutput`,
    );
    assert.equal(
      JSON.stringify(toModelOutput(MODEL_PAYLOAD, CLIENT_PROFILES[id])),
      JSON.stringify(BASELINE.toModelOutput[label]),
      `${label} toModelOutput`,
    );
  }
});

test('M1-physical: structuredContent is a ChatGPT-only strategy', () => {
  const withStructured = { ...MODEL_PAYLOAD, structuredContent: { leaked: true } };
  for (const id of [GEMINI, CLAUDE]) {
    const adapter = resolveClientAdapter({ profile: CLIENT_PROFILES[id], env: EMPTY_ENV });
    assert.equal(adapter.wireEncoding, 'textJson');
    assert.equal(
      Object.prototype.hasOwnProperty.call(adapter.encodeModelOutput(withStructured), 'structuredContent'),
      false,
      id,
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(adapter.encodeToolResult({ ...WIRE_RESULT, structuredContent: undefined }), 'structuredContent'),
      false,
      id,
    );
  }
  const chatgpt = resolveClientAdapter({ profile: CLIENT_PROFILES[CHATGPT], env: EMPTY_ENV });
  assert.equal(chatgpt.wireEncoding, 'structuredContent');
  assert.deepEqual(chatgpt.encodeModelOutput(MODEL_PAYLOAD).structuredContent, { ok: true, count: 3 });
  assert.deepEqual(chatgpt.encodeToolResult(WIRE_RESULT).structuredContent, { ok: true, count: 3 });
  // toModelOutput without a profile keeps the historical plain projection.
  assert.equal(
    Object.prototype.hasOwnProperty.call(toModelOutput(withStructured), 'structuredContent'),
    true,
    'no-profile callers keep the legacy projection (structuredContent untouched)',
  );
});

/* ================================================================== *
 * 4. Each adapter serves its OWN prompts directory
 * ================================================================== */

test('M1-physical: each adapter describes through its own prompts.js', () => {
  const context = Object.freeze({ servicesSuffix: ' Connected services: fake.', guidance: Object.freeze({}) });
  assert.equal(geminiFull.search.length > 0, true);
  // The adapter's own prompt builder is what produces its description.
  assert.equal(resolveClientAdapter({ env: EMPTY_ENV, headers: { [PROFILE_HEADER]: 'gemini' } }).id, GEMINI);
  const geminiCtx = { ...context, descriptionMode: 'full' };
  assert.equal(CLIENT_ADAPTERS.gemini.describeTool('search', geminiCtx), geminiFull.search(geminiCtx));
  assert.equal(CLIENT_ADAPTERS.chatgpt.describeTool('search', geminiCtx), chatgptFull.search(geminiCtx));
  assert.equal(CLIENT_ADAPTERS.claude.describeTool('search', geminiCtx), claudeFull.search(geminiCtx));
  // Physical separation: the three adapters do not share a prompts catalog.
  assert.notEqual(CLIENT_ADAPTERS.gemini.prompts, CLIENT_ADAPTERS.chatgpt.prompts);
  assert.notEqual(CLIENT_ADAPTERS.chatgpt.prompts, CLIENT_ADAPTERS.claude.prompts);
  assert.notEqual(CLIENT_ADAPTERS.gemini.prompts, CLIENT_ADAPTERS.claude.prompts);
});

test('M1-physical: codemode.js no longer imports a concrete client or the legacy profile', () => {
  const source = fs.readFileSync(
    fileURLToPath(new URL('../src/execution/codemode.js', import.meta.url)),
    'utf8',
  );
  for (const forbidden of [
    'client/client-profile.js',
    'clients/gemini/',
    'clients/chatgpt/',
    'clients/claude/',
  ]) {
    assert.equal(source.includes(forbidden), false, `codemode.js must not reference ${forbidden}`);
  }
  // ...it talks only to the router / shared assembler.
  assert.equal(source.includes("from '../clients/index.js'"), true);
});

/* ================================================================== *
 * 5. Tuning stays inside its own adapter (no cross-client contamination)
 * ================================================================== */

test('M1-physical: tuned profile only changes its own adapter/face', async () => {
  const tunedGemini = {
    ...CLIENT_PROFILES[GEMINI],
    descriptionMode: DESCRIPTION_MODE_COMPACT,
    outputBudgetChars: 400,
    annotations: { search: { openWorldHint: true } },
  };
  const tunedAdapter = resolveClientAdapter({ profile: tunedGemini, env: EMPTY_ENV });
  assert.equal(tunedAdapter.id, GEMINI);
  assert.equal(tunedAdapter.descriptionMode, DESCRIPTION_MODE_COMPACT);
  assert.equal(tunedAdapter.outputBudgetChars, 400);

  const tools = createCodeModeTools(fakeManager(), { profile: tunedGemini, env: EMPTY_ENV });
  assert.deepEqual(tools.map((tool) => tool.name), ['search', 'execute_read', 'execute']);
  assert.equal(tools[0].annotations.openWorldHint, true);
  // Compact descriptions are actually shorter than the historical full ones.
  const baseline = createCodeModeTools(fakeManager(), { profile: CLIENT_PROFILES[GEMINI], env: EMPTY_ENV });
  for (const tool of tools) {
    const full = baseline.find((entry) => entry.name === tool.name);
    assert.ok(tool.description.length < full.description.length, `${tool.name} compact`);
  }
  // Budget applies to this adapter only.
  const out = await executeResult(tools, `async () => 'x'.repeat(2000)`);
  assert.ok(out.result.length <= 400, `tuned budget, got ${out.result.length}`);

  // The other two platforms are byte-for-byte untouched.
  assert.equal(
    JSON.stringify(toolFace(createCodeModeTools(fakeManager(), { profile: CLIENT_PROFILES[CHATGPT], env: EMPTY_ENV }))),
    JSON.stringify(BASELINE.toolFace.chatgpt),
  );
  assert.equal(
    JSON.stringify(toolFace(createCodeModeTools(fakeManager(), { profile: CLIENT_PROFILES[CLAUDE], env: EMPTY_ENV }))),
    JSON.stringify(BASELINE.toolFace.claude),
  );
});

test('M1-physical: legacy profile objects still resolve and execute', async () => {
  const legacy = { id: GEMINI, structuredContent: false, textJson: true, annotations: true };
  const adapter = resolveClientAdapter({ profile: legacy, env: EMPTY_ENV });
  assert.equal(adapter.id, GEMINI);
  const tools = createCodeModeTools(fakeManager(), { profile: legacy });
  assert.equal(
    JSON.stringify(toolFace(tools)),
    JSON.stringify(BASELINE.toolFaceDefault),
  );
  const out = await executeResult(tools, `async () => 'ok'`);
  assert.equal(out.result, 'ok');
});

/* ================================================================== *
 * 6. Default execute output / budget is unchanged
 * ================================================================== */

test('M1-physical regression: default execute output and budget match the baseline', async () => {
  for (const [label, id] of Object.entries(PLATFORM_IDS)) {
    const tools = createCodeModeTools(fakeManager(), { profile: CLIENT_PROFILES[id], env: EMPTY_ENV });
    const out = await executeResult(tools, `async () => 'x'.repeat(2000)`);
    const expected = BASELINE.executeDefault[label];
    assert.equal(out.result.length, expected.resultLength, label);
    assert.equal(out.result.includes('TRUNCATED'), expected.truncated, label);
    assert.deepEqual(Object.keys(out).sort(), expected.keys, label);
  }
});

test('M1-physical: explicit config maxResultChars still wins over the adapter budget', async () => {
  const out = await executeResult(
    createCodeModeTools(fakeManager(), { maxResultChars: 1500, env: EMPTY_ENV }),
    `async () => 'y'.repeat(2000)`,
  );
  assert.ok(out.result.length > 1000);
  assert.ok(out.result.length <= 1500);
});
