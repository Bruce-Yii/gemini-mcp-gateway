import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveClientProfile,
  encodeToolResult,
  encodeModelOutput,
  applyProfileToTools,
  CLIENT_PROFILES,
  GEMINI,
  CLAUDE,
  CHATGPT,
  PROFILE_HEADER,
} from '../src/client-profile.js';

const EMPTY_ENV = {}; // no env opt-ins

// --- resolveClientProfile ---------------------------------------------------

test('default: no signals -> gemini (legacy text-JSON)', () => {
  const p = resolveClientProfile({ headers: {}, body: {}, env: EMPTY_ENV });
  assert.equal(p.id, GEMINI);
  assert.equal(p.structuredContent, false);
  assert.equal(p.textJson, true);
  assert.equal(p.annotations, true);
});

test('explicit header: claude / chatgpt / gemini are recognized', () => {
  assert.equal(resolveClientProfile({ headers: { [PROFILE_HEADER]: 'claude' }, env: EMPTY_ENV }).id, CLAUDE);
  assert.equal(resolveClientProfile({ headers: { [PROFILE_HEADER]: 'chatgpt' }, env: EMPTY_ENV }).id, CHATGPT);
  assert.equal(resolveClientProfile({ headers: { [PROFILE_HEADER]: 'gemini' }, env: EMPTY_ENV }).id, GEMINI);
});

test('header lookup is case-insensitive', () => {
  assert.equal(resolveClientProfile({ headers: { 'X-Gateway-Client-Profile': 'chatgpt' }, env: EMPTY_ENV }).id, CHATGPT);
  assert.equal(resolveClientProfile({ headers: { 'X-GATEWAY-CLIENT-PROFILE': 'claude' }, env: EMPTY_ENV }).id, CLAUDE);
});

test('header array value: first string wins', () => {
  assert.equal(resolveClientProfile({ headers: { [PROFILE_HEADER]: ['chatgpt', 'claude'] }, env: EMPTY_ENV }).id, CHATGPT);
});

test('clientInfo.name in initialize body is an explicit declaration', () => {
  const body = { method: 'initialize', params: { clientInfo: { name: 'claude-code', version: '1' } } };
  assert.equal(resolveClientProfile({ headers: {}, body, env: EMPTY_ENV }).id, CLAUDE);
  const body2 = { clientInfo: { name: 'openai' } };
  assert.equal(resolveClientProfile({ headers: {}, body: body2, env: EMPTY_ENV }).id, CHATGPT);
});

test('explicit User-Agent product token is recognized', () => {
  assert.equal(resolveClientProfile({ headers: { 'user-agent': 'Claude-Desktop/1.2' }, env: EMPTY_ENV }).id, CLAUDE);
  assert.equal(resolveClientProfile({ headers: { 'user-agent': 'ChatGPT-Agent/4' }, env: EMPTY_ENV }).id, CHATGPT);
});

test('vague / generic User-Agent is NOT a signal -> gemini', () => {
  assert.equal(resolveClientProfile({ headers: { 'user-agent': 'Mozilla/5.0 some browser' }, env: EMPTY_ENV }).id, GEMINI);
  assert.equal(resolveClientProfile({ headers: { 'user-agent': 'curl/8.0' }, env: EMPTY_ENV }).id, GEMINI);
});

test('unknown header value falls back to gemini', () => {
  assert.equal(resolveClientProfile({ headers: { [PROFILE_HEADER]: 'mystery-client' }, env: EMPTY_ENV }).id, GEMINI);
  assert.equal(resolveClientProfile({ headers: { [PROFILE_HEADER]: '' }, env: EMPTY_ENV }).id, GEMINI);
});

test('env opt-ins: explicit GATEWAY_CLIENT_PROFILE and booleans', () => {
  assert.equal(resolveClientProfile({ env: { GATEWAY_CLIENT_PROFILE: 'chatgpt' } }).id, CHATGPT);
  assert.equal(resolveClientProfile({ env: { GATEWAY_CLIENT_CLAUDE: '1' } }).id, CLAUDE);
  assert.equal(resolveClientProfile({ env: { GATEWAY_CLIENT_CHATGPT: 'true' } }).id, CHATGPT);
  assert.equal(resolveClientProfile({ env: { GATEWAY_CLIENT_PROFILE: 'wat' } }).id, GEMINI);
  assert.equal(resolveClientProfile({ env: { GATEWAY_CLIENT_CLAUDE: 'maybe' } }).id, GEMINI);
});

test('priority: explicit header overrides body/Ua/env', () => {
  const p = resolveClientProfile({
    headers: { [PROFILE_HEADER]: 'gemini', 'user-agent': 'Claude-Desktop/1' },
    body: { params: { clientInfo: { name: 'openai' } } },
    env: { GATEWAY_CLIENT_PROFILE: 'chatgpt' },
  });
  assert.equal(p.id, GEMINI);
});

test('profiles are frozen and cannot be mutated by callers', () => {
  assert.ok(Object.isFrozen(CLIENT_PROFILES));
  assert.ok(Object.isFrozen(CLIENT_PROFILES[GEMINI]));
  assert.throws(() => { CLIENT_PROFILES[GEMINI].structuredContent = true; }, TypeError);
});

// --- encodeToolResult ------------------------------------------------------

const textResult = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });

test('gemini: text JSON only; structuredContent is stripped (never leaks)', () => {
  const input = { ...textResult({ ok: true }), structuredContent: { ok: true, secret: 'sc' } };
  const out = encodeToolResult(input, CLIENT_PROFILES[GEMINI]);
  assert.equal(Object.prototype.hasOwnProperty.call(out, 'structuredContent'), false);
  assert.deepEqual(out, textResult({ ok: true }));
  // input not mutated
  assert.equal(input.structuredContent.secret, 'sc');
});

test('claude: text result + annotations; structuredContent omitted by default', () => {
  const input = { ...textResult({ ok: true }), structuredContent: { ok: true }, annotations: { readOnlyHint: true } };
  const out = encodeToolResult(input, CLIENT_PROFILES[CLAUDE]);
  assert.equal(out.structuredContent, undefined);
  assert.deepEqual(out.annotations, { readOnlyHint: true });
  assert.deepEqual(out.content, input.content);
});

test('chatgpt: both structuredContent and text JSON are present', () => {
  const input = textResult({ ok: true, n: 2 });
  const out = encodeToolResult(input, CLIENT_PROFILES[CHATGPT]);
  assert.deepEqual(out.structuredContent, { ok: true, n: 2 });
  assert.deepEqual(out.content, input.content);
  assert.equal(out.content[0].text, '{"ok":true,"n":2}');
});

test('chatgpt: pre-existing structuredContent is preserved verbatim', () => {
  const sc = { custom: 'value' };
  const input = { ...textResult({ custom: 'value' }), structuredContent: sc };
  const out = encodeToolResult(input, CLIENT_PROFILES[CHATGPT]);
  assert.equal(out.structuredContent, sc);
});

test('chatgpt: non-JSON text does not gain structuredContent', () => {
  const input = { content: [{ type: 'text', text: 'plain text' }] };
  const out = encodeToolResult(input, CLIENT_PROFILES[CHATGPT]);
  assert.equal(Object.prototype.hasOwnProperty.call(out, 'structuredContent'), false);
});

test('chatgpt: multiple text blocks do not gain derived structuredContent', () => {
  const input = { content: [{ type: 'text', text: '{"a":1}' }, { type: 'text', text: '{"b":2}' }] };
  const out = encodeToolResult(input, CLIENT_PROFILES[CHATGPT]);
  assert.equal(out.structuredContent, undefined);
});

test('default regression: encodeToolResult without profile equals current behavior byte-for-byte', () => {
  const input = textResult({ a: 1, b: [1, 2, 3] }); // no structuredContent, as today
  const out = encodeToolResult(input);
  assert.equal(JSON.stringify(out), JSON.stringify(input));
  assert.deepEqual(Object.keys(out), Object.keys(input));
});

test('unknown profile id falls back to gemini encoding', () => {
  const input = { ...textResult({ ok: 1 }), structuredContent: { ok: 1 } };
  const out = encodeToolResult(input, { id: 'unknown' });
  assert.equal(out.structuredContent, undefined);
});

test('non-object results pass through unchanged', () => {
  assert.equal(encodeToolResult(null), null);
  assert.equal(encodeToolResult('x'), 'x');
  assert.deepEqual(encodeToolResult([1, 2]), [1, 2]);
});

// --- encodeModelOutput (codemode boundary) ---------------------------------

test('encodeModelOutput: gemini default keeps projected shape unchanged', () => {
  const out = { result: { ok: true }, isError: false };
  const encoded = encodeModelOutput(out, CLIENT_PROFILES[GEMINI]);
  assert.equal(JSON.stringify(encoded), JSON.stringify(out));
});

test('encodeModelOutput: chatgpt adds structuredContent from result object', () => {
  const out = { result: { ok: true, n: 3 } };
  const encoded = encodeModelOutput(out, CLIENT_PROFILES[CHATGPT]);
  assert.deepEqual(encoded.structuredContent, { ok: true, n: 3 });
  assert.deepEqual(encoded.result, out.result);
});

test('encodeModelOutput: chatgpt parses JSON string result', () => {
  const out = { result: '{"parsed":true}' };
  const encoded = encodeModelOutput(out, CLIENT_PROFILES[CHATGPT]);
  assert.deepEqual(encoded.structuredContent, { parsed: true });
});

// --- applyProfileToTools ---------------------------------------------------

test('applyProfileToTools: names/count/schema/annotations unchanged for all profiles', () => {
  const tools = [
    { name: 'gateway_call', description: 'd', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true } },
    { name: 'gateway_search', description: 'd2', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
  ];
  for (const id of [GEMINI, CLAUDE, CHATGPT]) {
    const out = applyProfileToTools(tools, CLIENT_PROFILES[id]);
    assert.equal(out.length, tools.length);
    assert.deepEqual(out.map((t) => t.name), ['gateway_call', 'gateway_search']);
    assert.deepEqual(out.map((t) => t.inputSchema), tools.map((t) => t.inputSchema));
    assert.deepEqual(out.map((t) => t.annotations), tools.map((t) => t.annotations));
    // default gemini path is byte-for-byte identical
    if (id === GEMINI) assert.equal(JSON.stringify(out), JSON.stringify(tools));
  }
});

test('applyProfileToTools: missing annotations get benign defaults (no schema change)', () => {
  const tools = [{ name: 't', inputSchema: { type: 'object' } }];
  const out = applyProfileToTools(tools, CLIENT_PROFILES[GEMINI]);
  assert.deepEqual(out[0].annotations, { readOnlyHint: false, destructiveHint: false, openWorldHint: false });
  assert.ok(!Object.prototype.hasOwnProperty.call(tools[0], 'annotations'), 'input not mutated');
});
