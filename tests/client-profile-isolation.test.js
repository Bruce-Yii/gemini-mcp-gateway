/**
 * M1 — client isolation底座 tests.
 *
 * Covers the four isolation slots added to `CLIENT_PROFILES`
 * (wireEncoding / annotations / descriptionMode / outputBudgetChars), the
 * exact-only OAuth client-id routing, and the cross-client anti-contamination
 * guarantee: tuning one profile must not change any other client's tool
 * definitions or model output.
 *
 * Rules exercised here:
 *   - OAuth routing uses ONLY an exact `CLIENT_PLATFORM_OAUTH_MAP` hit; unknown
 *     ids are never guessed, and header/clientInfo keep their priority.
 *   - The runtime profile (`resolveClientProfile`) and the captured
 *     `clientPlatform` label (`detectClientPlatform`) agree.
 *   - Stock profiles resolve to the historical values byte-for-byte.
 *   - A tuned profile only changes its own tool face / output budget.
 *
 * Test-only fake client ids are used; no real client id, token, or secret is
 * hardcoded anywhere in this file.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import {
  applyProfileToTools,
  CHATGPT,
  CLAUDE,
  CLIENT_PROFILES,
  DEFAULT_OUTPUT_BUDGET_CHARS,
  DESCRIPTION_MODE_COMPACT,
  DESCRIPTION_MODE_FULL,
  encodeModelOutput,
  encodeToolResult,
  GEMINI,
  PROFILE_HEADER,
  resolveClientProfile,
  resolveToolAnnotations,
  WIRE_STRUCTURED_CONTENT,
  WIRE_TEXT_JSON,
} from '../src/client-profile.js';
import { detectClientPlatform } from '../src/client-platform.js';
import { createCodeModeTools, toModelOutput } from '../src/codemode.js';
import { createGatewayServer, createMcpRequestHandler } from '../src/server.js';

const EMPTY_ENV = Object.freeze({});

// Test-only client ids. The production map is read from
// CLIENT_PLATFORM_OAUTH_MAP and is never printed.
const TEST_OAUTH_MAP = Object.freeze({
  'test-client-gemini': GEMINI,
  'test-client-chatgpt': CHATGPT,
  'test-client-claude': CLAUDE,
});
const oauthEnv = (map = TEST_OAUTH_MAP) => ({
  CLIENT_PLATFORM_OAUTH_MAP: JSON.stringify(map),
});

function fakeManager(entries = []) {
  return {
    getEntries: () => entries,
    callTool: async () => ({ content: [{ type: 'text', text: '{}' }] }),
  };
}

/** Stable snapshot of the model-facing tool face (names/schemas/descriptions). */
function toolFace(tools) {
  return JSON.stringify(tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations,
  })));
}

/* ================================================================== *
 * 1. OAuth clientId -> profile (exact-only, no guessing)
 * ================================================================== */

test('M1 oauth: an exact env map hit routes all three profiles', () => {
  const env = oauthEnv();
  for (const [clientId, expected] of Object.entries(TEST_OAUTH_MAP)) {
    const profile = resolveClientProfile({ headers: {}, body: {}, env, oauthClientId: clientId });
    assert.equal(profile.id, expected, clientId);
    assert.equal(profile, CLIENT_PROFILES[expected], 'returns the frozen profile object');
  }
});

test('M1 oauth: oauthClientMap option works; only exact own-key hits count', () => {
  assert.equal(
    resolveClientProfile({ oauthClientId: 'test-client-chatgpt', oauthClientMap: TEST_OAUTH_MAP, env: EMPTY_ENV }).id,
    CHATGPT,
  );
  // Look-alike / unmapped ids contribute NO signal -> legacy gemini fallback.
  assert.equal(resolveClientProfile({ oauthClientId: 'test-client-gpt-4o', oauthClientMap: TEST_OAUTH_MAP, env: EMPTY_ENV }).id, GEMINI);
  assert.equal(resolveClientProfile({ oauthClientId: '', oauthClientMap: TEST_OAUTH_MAP, env: EMPTY_ENV }).id, GEMINI);
  assert.equal(resolveClientProfile({ oauthClientId: 42, oauthClientMap: TEST_OAUTH_MAP, env: EMPTY_ENV }).id, GEMINI);
  // Only the three documented platform values are accepted.
  assert.equal(resolveClientProfile({ oauthClientId: 'x', oauthClientMap: { x: 'openai' }, env: EMPTY_ENV }).id, GEMINI);
  // Inherited/prototype keys are not own keys -> not a platform.
  assert.equal(resolveClientProfile({ oauthClientId: 'toString', oauthClientMap: {}, env: EMPTY_ENV }).id, GEMINI);
  assert.equal(resolveClientProfile({ oauthClientId: '__proto__', oauthClientMap: {}, env: EMPTY_ENV }).id, GEMINI);
});

test('M1 oauth: malformed or non-object env map is ignored, never guessed', () => {
  for (const raw of ['not-json', '[]', '"chatgpt"', 'null']) {
    const profile = resolveClientProfile({
      oauthClientId: 'test-client-chatgpt',
      env: { CLIENT_PLATFORM_OAUTH_MAP: raw },
    });
    assert.equal(profile.id, GEMINI, raw);
  }
});

test('M1 oauth: precedence header > clientInfo > oauth > UA > env opt-in', () => {
  const env = { ...oauthEnv(), GATEWAY_CLIENT_CLAUDE: '1' };
  // Existing header priority is unchanged, even against an OAuth hit.
  assert.equal(resolveClientProfile({
    headers: { [PROFILE_HEADER]: GEMINI },
    oauthClientId: 'test-client-chatgpt',
    env,
  }).id, GEMINI);
  // Existing initialize-body priority is unchanged, even against an OAuth hit.
  assert.equal(resolveClientProfile({
    body: { params: { clientInfo: { name: 'claude-code' } } },
    oauthClientId: 'test-client-chatgpt',
    env,
  }).id, CLAUDE);
  // An exact OAuth hit overrides UA / env opt-ins (same order as detection).
  assert.equal(resolveClientProfile({
    headers: { 'user-agent': 'Claude-Desktop/1.2' },
    oauthClientId: 'test-client-chatgpt',
    env,
  }).id, CHATGPT);
  assert.equal(resolveClientProfile({ oauthClientId: 'test-client-gemini', env }).id, GEMINI);
  // Without an OAuth hit, UA/env behaviour is unchanged.
  assert.equal(resolveClientProfile({ headers: { 'user-agent': 'ChatGPT-Agent/4' }, env: EMPTY_ENV }).id, CHATGPT);
  assert.equal(resolveClientProfile({ env: { GATEWAY_CLIENT_CLAUDE: '1' } }).id, CLAUDE);
});

test('M1 oauth: runtime profile and captured clientPlatform agree (no divergence)', () => {
  const env = oauthEnv();
  for (const [clientId, expected] of Object.entries(TEST_OAUTH_MAP)) {
    const input = { headers: {}, body: {}, oauthClientId: clientId, env };
    const captured = detectClientPlatform(input);
    const runtime = resolveClientProfile(input);
    assert.equal(captured.platform, expected, clientId);
    assert.equal(captured.source, 'oauth_client_id', clientId);
    assert.equal(runtime.id, expected, `runtime profile must equal captured platform (${clientId})`);
  }
  // An unmapped id is honestly unknown to capture, while runtime keeps the
  // documented legacy gemini fallback.
  assert.equal(detectClientPlatform({ headers: {}, oauthClientId: 'unmapped', env }).platform, 'unknown');
  assert.equal(resolveClientProfile({ headers: {}, oauthClientId: 'unmapped', env }).id, GEMINI);
});

test('M1 oauth: precedence matches detectClientPlatform for mixed signals', () => {
  const env = oauthEnv();
  const cases = [
    { headers: { [PROFILE_HEADER]: 'gemini' }, oauthClientId: 'test-client-chatgpt' },
    { body: { params: { clientInfo: { name: 'claude-code' } } }, oauthClientId: 'test-client-chatgpt' },
    { headers: { 'user-agent': 'Claude-Desktop/1.2' }, oauthClientId: 'test-client-chatgpt' },
    { headers: { 'user-agent': 'ChatGPT-Agent/4' }, oauthClientId: 'test-client-gemini' },
  ];
  for (const input of cases) {
    const runtime = resolveClientProfile({ ...input, env }).id;
    const captured = detectClientPlatform({ ...input, env }).platform;
    assert.equal(runtime, captured, JSON.stringify(input));
  }
});

/* ================================================================== *
 * 2. Four isolation slots on CLIENT_PROFILES
 * ================================================================== */

const HISTORICAL_ANNOTATIONS = Object.freeze({
  search: Object.freeze({ readOnlyHint: true, destructiveHint: false, openWorldHint: false }),
  execute_read: Object.freeze({ readOnlyHint: true, destructiveHint: false, openWorldHint: true }),
  execute: Object.freeze({ readOnlyHint: false, destructiveHint: true, openWorldHint: true }),
});

test('M1 profiles: all four slots exist with the historical defaults', () => {
  assert.equal(DEFAULT_OUTPUT_BUDGET_CHARS, 20000, 'historical codemode result cap');
  for (const id of [GEMINI, CLAUDE, CHATGPT]) {
    const profile = CLIENT_PROFILES[id];
    const structured = id === CHATGPT;
    // Legacy encoding fields remain authoritative and unchanged.
    assert.equal(profile.structuredContent, structured, id);
    assert.equal(profile.textJson, true, id);
    // New slot 1: wireEncoding mirrors the legacy flags.
    assert.equal(profile.wireEncoding, structured ? WIRE_STRUCTURED_CONTENT : WIRE_TEXT_JSON, id);
    // New slot 2: per-tool annotations default to the historical values.
    for (const name of ['search', 'execute_read', 'execute']) {
      assert.deepEqual(profile.annotations[name], HISTORICAL_ANNOTATIONS[name], `${id}/${name}`);
    }
    // New slots 3+4: full descriptions and the global output budget.
    assert.equal(profile.descriptionMode, DESCRIPTION_MODE_FULL, id);
    assert.equal(profile.outputBudgetChars, DEFAULT_OUTPUT_BUDGET_CHARS, id);
  }
  // Frozen, including the nested annotation maps (no cross-profile mutation).
  assert.ok(Object.isFrozen(CLIENT_PROFILES));
  for (const profile of Object.values(CLIENT_PROFILES)) {
    assert.ok(Object.isFrozen(profile));
    assert.ok(Object.isFrozen(profile.annotations));
    for (const entry of Object.values(profile.annotations)) assert.ok(Object.isFrozen(entry));
    assert.throws(() => { profile.annotations.search.readOnlyHint = false; }, TypeError);
  }
});

test('M1 resolveToolAnnotations: default returns the fallback as-is; overrides only documented hints', () => {
  const fallback = Object.freeze({
    readOnlyHint: true, destructiveHint: false, openWorldHint: true, title: 'kept',
  });
  // Stock profile -> no override, the exact same object is returned.
  assert.equal(resolveToolAnnotations('execute_read', CLIENT_PROFILES[GEMINI], fallback), fallback);
  assert.equal(resolveToolAnnotations('execute_read', CLIENT_PROFILES[CHATGPT], fallback), fallback);

  // Tuned profile -> only the three hints are overlaid; `title` is preserved.
  const tuned = { id: GEMINI, annotations: { execute_read: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, title: 'ignored' } } };
  assert.deepEqual(resolveToolAnnotations('execute_read', tuned, fallback), {
    readOnlyHint: false, destructiveHint: true, openWorldHint: false, title: 'kept',
  });
  assert.equal(fallback.readOnlyHint, true, 'fallback not mutated');

  // Unknown keys, non-boolean values, and legacy boolean `annotations` are
  // all tolerated as "no override".
  assert.equal(resolveToolAnnotations('search', { annotations: { search: { permission: 'admin' } } }, fallback), fallback);
  assert.equal(resolveToolAnnotations('search', { annotations: { search: { readOnlyHint: 'yes' } } }, fallback), fallback);
  assert.equal(resolveToolAnnotations('search', { annotations: true }, fallback), fallback);
  assert.equal(resolveToolAnnotations('search', 'not-a-profile-id', fallback), fallback);
});

test('M1 applyProfileToTools: stock profiles are byte-identical; tuning stays per-profile', () => {
  const tools = createCodeModeTools(fakeManager());
  const baseline = toolFace(tools);
  for (const profile of Object.values(CLIENT_PROFILES)) {
    const adapted = applyProfileToTools(tools, profile);
    assert.equal(toolFace(adapted), baseline, `${profile.id} stock profile must be byte-identical`);
  }

  const tunedGemini = {
    ...CLIENT_PROFILES[GEMINI],
    annotations: { search: { readOnlyHint: false, openWorldHint: true } },
  };
  const tuned = applyProfileToTools(tools, tunedGemini);
  assert.deepEqual(tuned[0].annotations, { readOnlyHint: false, destructiveHint: false, openWorldHint: true });
  assert.deepEqual(tuned[1].annotations, HISTORICAL_ANNOTATIONS.execute_read);
  assert.deepEqual(tuned[2].annotations, HISTORICAL_ANNOTATIONS.execute);

  // The other clients never see the Gemini-only override.
  for (const id of [CHATGPT, CLAUDE]) {
    assert.equal(toolFace(applyProfileToTools(tools, CLIENT_PROFILES[id])), baseline, id);
  }
});

test('M1 applyProfileToTools: missing annotations keep the historical benign defaults', () => {
  const tools = [{ name: 'upstream_tool', inputSchema: { type: 'object' } }];
  const tunedGemini = { ...CLIENT_PROFILES[GEMINI], annotations: { execute: { destructiveHint: false } } };
  const out = applyProfileToTools(tools, tunedGemini);
  assert.deepEqual(out[0].annotations, { readOnlyHint: false, destructiveHint: false, openWorldHint: false });
  assert.equal(Object.prototype.hasOwnProperty.call(tools[0], 'annotations'), false, 'input not mutated');
});

test('M1 encoding: wireEncoding mirrors the legacy flags and output stays byte-identical', () => {
  for (const id of [GEMINI, CLAUDE, CHATGPT]) {
    const profile = CLIENT_PROFILES[id];
    assert.equal(profile.wireEncoding === WIRE_STRUCTURED_CONTENT, profile.structuredContent, id);

    const input = { content: [{ type: 'text', text: '{"a":1}' }], structuredContent: { a: 1 } };
    const encoded = encodeToolResult(input, profile);
    if (profile.structuredContent) assert.deepEqual(encoded.structuredContent, { a: 1 }, id);
    else assert.equal(Object.prototype.hasOwnProperty.call(encoded, 'structuredContent'), false, id);

    const projected = encodeModelOutput({ result: { a: 1 } }, profile);
    if (profile.structuredContent) assert.deepEqual(projected.structuredContent, { a: 1 }, id);
    else assert.equal(Object.prototype.hasOwnProperty.call(projected, 'structuredContent'), false, id);
  }
});

test('M1 compatibility: legacy profile objects (boolean annotations) still work', async () => {
  const legacy = { id: GEMINI, structuredContent: false, textJson: true, annotations: true };
  const stock = createCodeModeTools(fakeManager());
  const withLegacy = createCodeModeTools(fakeManager(), { profile: legacy });
  assert.equal(toolFace(withLegacy), toolFace(stock));
  const exec = await executeResult(withLegacy, `async () => 'ok'`);
  assert.equal(exec.result, 'ok');
});

/* ================================================================== *
 * 3. Code Mode integration: annotations / descriptionMode / budget
 * ================================================================== */

/** Run one execute-family handler and return its model projection. */
async function executeResult(tools, code, name = 'execute') {
  const tool = tools.find((entry) => entry.name === name);
  return tool.handler({ code });
}

test('M1 codemode: stock profiles keep the tool face byte-identical', () => {
  const manager = fakeManager();
  const baselineTools = createCodeModeTools(manager);
  const baseline = toolFace(baselineTools);
  assert.deepEqual(baselineTools.map((tool) => tool.name), ['search', 'execute_read', 'execute']);
  assert.deepEqual(baselineTools.map((tool) => tool.annotations), [
    HISTORICAL_ANNOTATIONS.search,
    HISTORICAL_ANNOTATIONS.execute_read,
    HISTORICAL_ANNOTATIONS.execute,
  ]);
  for (const profile of Object.values(CLIENT_PROFILES)) {
    assert.equal(toolFace(createCodeModeTools(manager, { profile })), baseline, profile.id);
  }
});

test('M1 codemode: gemini tuning does not contaminate chatgpt/claude tool definitions', () => {
  const manager = fakeManager();
  const baseline = createCodeModeTools(manager, { profile: CLIENT_PROFILES[CHATGPT] });
  const baselineFace = toolFace(baseline);
  const tunedGemini = {
    ...CLIENT_PROFILES[GEMINI],
    descriptionMode: DESCRIPTION_MODE_COMPACT,
    annotations: {
      search: { openWorldHint: true },
      execute_read: { destructiveHint: true },
      execute: { destructiveHint: false },
    },
  };
  const tuned = createCodeModeTools(manager, { profile: tunedGemini });

  // Names/order/schemas never move.
  assert.deepEqual(tuned.map((tool) => tool.name), ['search', 'execute_read', 'execute']);
  assert.deepEqual(tuned.map((tool) => tool.inputSchema), baseline.map((tool) => tool.inputSchema));
  // Only the tuned hints change.
  assert.equal(tuned[0].annotations.openWorldHint, true);
  assert.equal(tuned[1].annotations.destructiveHint, true);
  assert.equal(tuned[2].annotations.destructiveHint, false);
  // Compact descriptions are actually shorter, not silently identical.
  for (const tool of tuned) {
    const full = baseline.find((entry) => entry.name === tool.name);
    assert.ok(tool.description.length < full.description.length, `${tool.name} compact description`);
  }

  // The other two clients are byte-for-byte untouched by the Gemini tuning.
  assert.equal(toolFace(createCodeModeTools(manager, { profile: CLIENT_PROFILES[CHATGPT] })), baselineFace);
  assert.equal(
    toolFace(createCodeModeTools(manager, { profile: CLIENT_PROFILES[CLAUDE] })),
    toolFace(createCodeModeTools(manager)),
  );
});

test('M1 codemode: descriptionMode defaults to full; compact only affects its own profile', () => {
  const fullTools = createCodeModeTools(fakeManager());
  const compactProfile = { ...CLIENT_PROFILES[GEMINI], descriptionMode: DESCRIPTION_MODE_COMPACT };
  const compactTools = createCodeModeTools(fakeManager(), { profile: compactProfile });
  assert.deepEqual(compactTools.map((tool) => tool.name), fullTools.map((tool) => tool.name));
  assert.deepEqual(compactTools.map((tool) => tool.inputSchema), fullTools.map((tool) => tool.inputSchema));
  assert.deepEqual(compactTools.map((tool) => tool.annotations), fullTools.map((tool) => tool.annotations));
  for (let i = 0; i < fullTools.length; i += 1) {
    assert.notEqual(compactTools[i].description, fullTools[i].description);
  }
  // Every stock profile keeps the full historical description text.
  for (const profile of Object.values(CLIENT_PROFILES)) {
    assert.deepEqual(
      createCodeModeTools(fakeManager(), { profile }).map((tool) => tool.description),
      fullTools.map((tool) => tool.description),
      profile.id,
    );
  }
});

test('M1 codemode: outputBudgetChars truncates only the tuned profile, default is unchanged', async () => {
  const manager = fakeManager();
  const code = `async () => 'x'.repeat(2000)`;

  // Default profile: exactly the historical full 2000-char result.
  const defaultOut = await executeResult(createCodeModeTools(manager, { profile: CLIENT_PROFILES[GEMINI] }), code);
  assert.equal(typeof defaultOut.result, 'string');
  assert.equal(defaultOut.result.length, 2000);
  assert.equal(defaultOut.result.includes('TRUNCATED'), false);

  // Tuned gemini budget truncates (with an explicit marker) for that client...
  const tunedGemini = { ...CLIENT_PROFILES[GEMINI], outputBudgetChars: 400 };
  const tunedOut = await executeResult(createCodeModeTools(manager, { profile: tunedGemini }), code);
  assert.ok(tunedOut.result.length <= 400, `budget applied, got ${tunedOut.result.length}`);
  assert.ok(tunedOut.result.includes('TRUNCATED'), 'truncation must be marked, never silent');
  assert.ok(tunedOut.result.length < defaultOut.result.length);

  // ...and applies to execute_read too.
  const readOut = await executeResult(createCodeModeTools(manager, { profile: tunedGemini }), code, 'execute_read');
  assert.ok(readOut.result.length <= 400, `execute_read budget applied, got ${readOut.result.length}`);

  // The other clients keep the full result for the same code.
  for (const id of [CHATGPT, CLAUDE]) {
    const out = await executeResult(createCodeModeTools(manager, { profile: CLIENT_PROFILES[id] }), code);
    assert.equal(out.result.length, 2000, id);
  }
});

test('M1 codemode: an explicit config maxResultChars still wins over the profile budget', async () => {
  const tunedGemini = { ...CLIENT_PROFILES[GEMINI], outputBudgetChars: 400 };
  const out = await executeResult(
    createCodeModeTools(fakeManager(), { profile: tunedGemini, maxResultChars: 1500 }),
    `async () => 'y'.repeat(2000)`,
  );
  assert.ok(out.result.length > 1000, `config budget must win, got ${out.result.length}`);
  assert.ok(out.result.length <= 1500);
});

test('M1 codemode: profile annotation overrides never change the read-only execution boundary', async () => {
  const readTool = {
    name: 'fake__list_issues', server: 'fake', tool: 'list_issues',
    description: 'read', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true },
  };
  const writeTool = {
    name: 'fake__create_issue', server: 'fake', tool: 'create_issue',
    description: 'write', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false },
  };
  const tuned = {
    ...CLIENT_PROFILES[GEMINI],
    annotations: {
      search: { readOnlyHint: false },
      execute_read: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
  };
  const tools = createCodeModeTools(fakeManager([readTool, writeTool]), { profile: tuned });
  // Annotations are informational: the host-side read-only filter still stubs
  // out the write tool for execute_read.
  const out = await executeResult(
    tools,
    `async () => { try { await codemode.fake__create_issue({}); return 'allowed'; } catch (_) { return 'blocked'; } }`,
    'execute_read',
  );
  assert.equal(out.result, 'blocked');
});

test('M1 codemode: per-profile tuning does not persist across factory calls', () => {
  const tuned = {
    ...CLIENT_PROFILES[GEMINI],
    descriptionMode: DESCRIPTION_MODE_COMPACT,
    outputBudgetChars: 123,
    annotations: { search: { readOnlyHint: false } },
  };
  const before = toolFace(createCodeModeTools(fakeManager(), { profile: tuned }));
  const stockAfter = toolFace(createCodeModeTools(fakeManager(), { profile: CLIENT_PROFILES[GEMINI] }));
  const tunedAfter = toolFace(createCodeModeTools(fakeManager(), { profile: tuned }));
  assert.equal(tunedAfter, before);
  assert.equal(stockAfter, toolFace(createCodeModeTools(fakeManager())));
});

test('M1 toModelOutput: profile slots do not change the model projection', () => {
  const output = { result: { ok: true }, isError: false };
  const tunedGemini = {
    ...CLIENT_PROFILES[GEMINI],
    descriptionMode: DESCRIPTION_MODE_COMPACT,
    outputBudgetChars: 10,
    annotations: { search: { readOnlyHint: false } },
  };
  assert.deepEqual(toModelOutput(output, tunedGemini), toModelOutput(output, CLIENT_PROFILES[GEMINI]));
  assert.equal(
    Object.prototype.hasOwnProperty.call(toModelOutput(output, CLIENT_PROFILES[GEMINI]), 'structuredContent'),
    false,
  );
  assert.deepEqual(toModelOutput(output, CLIENT_PROFILES[CHATGPT]).structuredContent, { ok: true });
});

/* ================================================================== *
 * 4. Server wiring: OAuth client id -> per-request runtime profile
 * ================================================================== */

test('M1 server: createGatewayServer uses an exact oauthClientId mapping for encoding', async () => {
  const manager = fakeManager();
  const env = oauthEnv();

  const chatServer = createGatewayServer(manager, {
    mode: 'codemode', oauthClientId: 'test-client-chatgpt', env, headers: {}, body: {},
  });
  const [chatTransport, chatServerTransport] = InMemoryTransport.createLinkedPair();
  await chatServer.connect(chatServerTransport);
  const chatClient = new Client({ name: 'm1-chat-test', version: '1' });
  await chatClient.connect(chatTransport);
  try {
    const { tools } = await chatClient.listTools();
    assert.deepEqual(tools.map((tool) => tool.name), ['search', 'execute_read', 'execute']);
    const result = await chatClient.callTool({ name: 'search', arguments: { query: 'x' } });
    assert.ok(result.structuredContent, 'ChatGPT profile must dual-encode its results');
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  } finally {
    await chatClient.close();
    await chatServer.close();
  }

  // No OAuth signal -> the legacy gemini profile: no structuredContent leaks.
  const geminiServer = createGatewayServer(manager, { mode: 'codemode', env, headers: {}, body: {} });
  const [geminiTransport, geminiServerTransport] = InMemoryTransport.createLinkedPair();
  await geminiServer.connect(geminiServerTransport);
  const geminiClient = new Client({ name: 'm1-gemini-test', version: '1' });
  await geminiClient.connect(geminiTransport);
  try {
    const result = await geminiClient.callTool({ name: 'search', arguments: { query: 'x' } });
    assert.equal(result.structuredContent, undefined);
  } finally {
    await geminiClient.close();
    await geminiServer.close();
  }
});

test('M1 server: request-level __gatewayOAuthClientId drives the per-request profile end-to-end', async () => {
  const env = oauthEnv();
  const cases = [
    { oauthClientId: 'test-client-chatgpt', expectStructured: true },
    { oauthClientId: undefined, expectStructured: false },
  ];

  for (const item of cases) {
    const handler = createMcpRequestHandler(fakeManager(), { mode: 'codemode', env });
    const server = http.createServer((req, res) => {
      // Mirrors vercel-app handleMcp: the auth layer attaches the client id
      // before server.js handles the request.
      if (item.oauthClientId) req.__gatewayOAuthClientId = item.oauthClientId;
      handler(req, res);
    });
    await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    const url = new URL(`http://127.0.0.1:${server.address().port}/mcp`);
    const transport = new StreamableHTTPClientTransport(url);
    const client = new Client({ name: 'm1-http-test', version: '1' });
    try {
      await client.connect(transport);
      const result = await client.callTool({ name: 'search', arguments: { query: 'x' } });
      if (item.expectStructured) {
        assert.ok(result.structuredContent, 'oauth client id must select the ChatGPT profile');
        assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
      } else {
        assert.equal(result.structuredContent, undefined, 'no signal must stay on the gemini default');
      }
    } finally {
      await client.close().catch(() => {});
      await new Promise((resolveClose) => server.close(resolveClose));
    }
  }
});
