import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  detectClientPlatform,
  PLATFORM_GEMINI,
  PLATFORM_CHATGPT,
  PLATFORM_CLAUDE,
  PLATFORM_UNKNOWN,
  PROFILE_GEMINI_TEXT_JSON,
  PROFILE_CHATGPT_STRUCTURED,
  PROFILE_CLAUDE_TEXT,
  CLIENT_PLATFORM_PROFILES,
} from '../src/client-platform.js';
import { PROFILE_HEADER } from '../src/client-profile.js';
import { startCapture, captureOAuthClientId } from '../src/capture.js';

const EMPTY_ENV = {};
const OAUTH_MAP = {
  'gmc_gemini_locked_001': PLATFORM_GEMINI,
  'gmc_chatgpt_dcr_002': PLATFORM_CHATGPT,
  'gmc_claude_dcr_003': PLATFORM_CLAUDE,
};

function fakeRes() {
  const body = [];
  return {
    statusCode: 200,
    headers: {},
    headersSent: false,
    getHeaders() { return this.headers; },
    write(chunk) { body.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); return true; },
    end(chunk) { if (chunk) body.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); this.ended = true; return this; },
    body,
  };
}

// --- detectClientPlatform: platform + profile correctness -----------------

test('Gemini: explicit header -> gemini / gemini-text-json', () => {
  const out = detectClientPlatform({ headers: { [PROFILE_HEADER]: 'gemini' }, env: EMPTY_ENV });
  assert.deepEqual(out, {
    platform: PLATFORM_GEMINI,
    profile: PROFILE_GEMINI_TEXT_JSON,
    source: 'profile_header',
    confidence: 'high',
  });
});

test('ChatGPT: explicit header -> chatgpt / chatgpt-structured', () => {
  const out = detectClientPlatform({ headers: { [PROFILE_HEADER]: 'chatgpt' }, env: EMPTY_ENV });
  assert.deepEqual(out, {
    platform: PLATFORM_CHATGPT,
    profile: PROFILE_CHATGPT_STRUCTURED,
    source: 'profile_header',
    confidence: 'high',
  });
});

test('Claude: explicit header -> claude / claude-text', () => {
  const out = detectClientPlatform({ headers: { [PROFILE_HEADER]: 'claude' }, env: EMPTY_ENV });
  assert.deepEqual(out, {
    platform: PLATFORM_CLAUDE,
    profile: PROFILE_CLAUDE_TEXT,
    source: 'profile_header',
    confidence: 'high',
  });
});

test('unknown: no signals -> unknown / legacy gemini-text-json default', () => {
  const out = detectClientPlatform({ headers: {}, body: {}, env: EMPTY_ENV });
  assert.deepEqual(out, {
    platform: PLATFORM_UNKNOWN,
    profile: PROFILE_GEMINI_TEXT_JSON,
    source: 'default',
    confidence: 'low',
  });
  // default profile value must be byte-for-byte the legacy default string
  assert.equal(out.profile, PROFILE_GEMINI_TEXT_JSON);
});

// --- priority: header > clientInfo > oauth id > UA -------------------------

test('header wins over clientInfo, oauth id and UA', () => {
  const out = detectClientPlatform({
    headers: { [PROFILE_HEADER]: 'gemini', 'user-agent': 'Claude-Desktop/1' },
    body: { method: 'initialize', params: { clientInfo: { name: 'openai' } } },
    oauthClientId: 'gmc_chatgpt_dcr_002',
    oauthClientMap: OAUTH_MAP,
    env: EMPTY_ENV,
  });
  assert.equal(out.platform, PLATFORM_GEMINI);
  assert.equal(out.source, 'profile_header');
});

test('header lookup is case-insensitive and accepts array values', () => {
  const a = detectClientPlatform({ headers: { 'X-Gateway-Client-Profile': 'claude' }, env: EMPTY_ENV });
  assert.equal(a.platform, PLATFORM_CLAUDE);
  const b = detectClientPlatform({ headers: { [PROFILE_HEADER]: ['chatgpt', 'claude'] }, env: EMPTY_ENV });
  assert.equal(b.platform, PLATFORM_CHATGPT);
});

test('unrecognized header value is NOT a signal -> unknown default', () => {
  const out = detectClientPlatform({ headers: { [PROFILE_HEADER]: 'mystery-client' }, env: EMPTY_ENV });
  assert.equal(out.platform, PLATFORM_UNKNOWN);
  assert.equal(out.source, 'default');
  assert.equal(out.profile, PROFILE_GEMINI_TEXT_JSON);
});

test('clientInfo.name from initialize body is recognized', () => {
  const claude = detectClientPlatform({
    headers: {},
    body: { method: 'initialize', params: { clientInfo: { name: 'claude-code', version: '1' } } },
    env: EMPTY_ENV,
  });
  assert.equal(claude.platform, PLATFORM_CLAUDE);
  assert.equal(claude.source, 'client_info');
  const chatgpt = detectClientPlatform({ headers: {}, body: { clientInfo: { name: 'openai' } }, env: EMPTY_ENV });
  assert.equal(chatgpt.platform, PLATFORM_CHATGPT);
});

test('clientInfo wins over oauth id and UA', () => {
  const out = detectClientPlatform({
    headers: { 'user-agent': 'ChatGPT-Agent/4' },
    body: { params: { clientInfo: { name: 'claude-code' } } },
    oauthClientId: 'gmc_chatgpt_dcr_002',
    oauthClientMap: OAUTH_MAP,
    env: EMPTY_ENV,
  });
  assert.equal(out.platform, PLATFORM_CLAUDE);
  assert.equal(out.source, 'client_info');
});

test('OAuth client id maps via explicit config only (option map)', () => {
  for (const [id, expected] of Object.entries(OAUTH_MAP)) {
    const out = detectClientPlatform({ headers: {}, oauthClientId: id, oauthClientMap: OAUTH_MAP, env: EMPTY_ENV });
    assert.equal(out.platform, expected, id);
    assert.equal(out.source, 'oauth_client_id', id);
  }
});

test('OAuth id mapping wins over UA token', () => {
  const out = detectClientPlatform({
    headers: { 'user-agent': 'ChatGPT-Agent/4' },
    oauthClientId: 'gmc_claude_dcr_003',
    oauthClientMap: OAUTH_MAP,
    env: EMPTY_ENV,
  });
  assert.equal(out.platform, PLATFORM_CLAUDE);
  assert.equal(out.source, 'oauth_client_id');
});

test('OAuth id mapping via env JSON (explicit opt-in)', () => {
  const env = { CLIENT_PLATFORM_OAUTH_MAP: JSON.stringify(OAUTH_MAP) };
  const out = detectClientPlatform({ headers: {}, oauthClientId: 'gmc_chatgpt_dcr_002', env });
  assert.equal(out.platform, PLATFORM_CHATGPT);
  assert.equal(out.source, 'oauth_client_id');
});

test('OAuth client id with NO explicit mapping is not guessed -> unknown', () => {
  const out = detectClientPlatform({
    headers: {}, oauthClientId: 'gmc_something_that_looks_like_chatgpt_dcr', env: EMPTY_ENV,
  });
  assert.equal(out.platform, PLATFORM_UNKNOWN);
  assert.equal(out.source, 'default');
  // malformed explicit config is ignored, never guessed
  const bad = detectClientPlatform({
    headers: {}, oauthClientId: 'gmc_chatgpt_dcr_002', env: { CLIENT_PLATFORM_OAUTH_MAP: 'not-json' },
  });
  assert.equal(bad.platform, PLATFORM_UNKNOWN);
});

test('UA product token is recognized with medium confidence', () => {
  const claude = detectClientPlatform({ headers: { 'user-agent': 'Claude-Desktop/1.2' }, env: EMPTY_ENV });
  assert.equal(claude.platform, PLATFORM_CLAUDE);
  assert.equal(claude.source, 'user_agent');
  assert.equal(claude.confidence, 'medium');
  const chatgpt = detectClientPlatform({ headers: { 'user-agent': 'ChatGPT-Agent/4' }, env: EMPTY_ENV });
  assert.equal(chatgpt.platform, PLATFORM_CHATGPT);
  assert.equal(chatgpt.source, 'user_agent');
});

test('vague / generic UA is NOT a platform signal', () => {
  for (const ua of ['Mozilla/5.0 some browser', 'curl/8.0', 'node-fetch/2']) {
    const out = detectClientPlatform({ headers: { 'user-agent': ua }, env: EMPTY_ENV });
    assert.equal(out.platform, PLATFORM_UNKNOWN, ua);
    assert.equal(out.source, 'default', ua);
  }
});

test('default compatibility: Gemini-style request resolves legacy profile', () => {
  const out = detectClientPlatform({
    headers: { 'content-type': 'application/json', 'user-agent': 'curl/8.0' },
    body: { jsonrpc: '2.0', method: 'tools/list', id: 1 },
    env: EMPTY_ENV,
  });
  assert.equal(out.platform, PLATFORM_UNKNOWN);
  assert.equal(out.profile, PROFILE_GEMINI_TEXT_JSON);
  assert.deepEqual(CLIENT_PLATFORM_PROFILES[PLATFORM_UNKNOWN], undefined);
});

// --- purity / determinism --------------------------------------------------

test('pure function: deterministic across repeated calls', () => {
  const input = {
    headers: { [PROFILE_HEADER]: 'chatgpt' },
    body: { params: { clientInfo: { name: 'claude-code' } } },
    oauthClientId: 'gmc_chatgpt_dcr_002',
    oauthClientMap: OAUTH_MAP,
    env: EMPTY_ENV,
  };
  const first = detectClientPlatform(input);
  for (let i = 0; i < 5; i += 1) assert.deepEqual(detectClientPlatform(input), first);
  assert.deepEqual(first, {
    platform: PLATFORM_CHATGPT,
    profile: PROFILE_CHATGPT_STRUCTURED,
    source: 'profile_header',
    confidence: 'high',
  });
});

test('pure function: does not mutate inputs', () => {
  const headers = Object.freeze({ [PROFILE_HEADER]: 'claude', 'user-agent': 'x' });
  const body = Object.freeze({ params: Object.freeze({ clientInfo: Object.freeze({ name: 'openai' }) }) });
  const map = Object.freeze(OAUTH_MAP);
  assert.doesNotThrow(() => detectClientPlatform({ headers, body, oauthClientMap: map, env: EMPTY_ENV }));
  assert.equal(headers[PROFILE_HEADER], 'claude');
  assert.equal(body.params.clientInfo.name, 'openai');
});

test('platform->profile map is frozen', () => {
  assert.ok(Object.isFrozen(CLIENT_PLATFORM_PROFILES));
  assert.throws(() => { CLIENT_PLATFORM_PROFILES[PLATFORM_GEMINI] = 'x'; }, TypeError);
});

// --- capture envelope: additive, no semantic changes ----------------------

test('captureOAuthClientId reads req attachment if present', () => {
  assert.equal(captureOAuthClientId({ oauthClientId: 'abc' }), 'abc');
  assert.equal(captureOAuthClientId({ __gatewayOAuthClientId: 'def' }), 'def');
  assert.equal(captureOAuthClientId({ headers: { authorization: 'Bearer abc' } }), null);
  assert.equal(captureOAuthClientId(null), null);
});

test('capture envelope is additive: new platform fields + all old fields intact', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gmg-platform-capture-'));
  try {
    const req = {
      method: 'POST', url: '/mcp',
      headers: { [PROFILE_HEADER]: 'claude', 'content-type': 'application/json' },
      __gatewayRawBody: '{"jsonrpc":"2.0","method":"initialize","params":{"clientInfo":{"name":"claude-code"}}}',
      oauthClientId: 'gmc_claude_dcr_003',
    };
    const res = fakeRes();
    const cap = startCapture(req, res, {
      mode: 'full', sink: 'file', fileDir: dir,
      oauthClientMap: OAUTH_MAP, env: EMPTY_ENV,
    });
    assert.ok(cap?.requestId);
    res.write('{"jsonrpc":"2.0",');
    res.end('"result":{}}');
    assert.equal(Buffer.concat(res.body).toString(), '{"jsonrpc":"2.0","result":{}}');
    await new Promise((resolve) => setTimeout(resolve, 150));
    const files = await readdir(dir);
    assert.equal(files.length, 1);
    const envelope = JSON.parse(await readFile(join(dir, files[0]), 'utf8'));

    // old fields unchanged
    assert.equal(envelope.schema, 'gmg.capture.v1');
    assert.equal(envelope.request.raw, req.__gatewayRawBody);
    assert.equal(envelope.response.raw, '{"jsonrpc":"2.0","result":{}}');
    assert.equal(envelope.request.headers[PROFILE_HEADER], 'claude');
    assert.equal(envelope.response.status, 200);
    assert.ok(envelope.model);
    assert.ok(Array.isArray(envelope.events));

    // new fields present and consistent with detectClientPlatform
    assert.equal(envelope.clientPlatform, PLATFORM_CLAUDE);
    assert.equal(envelope.clientProfile, PROFILE_CLAUDE_TEXT);
    assert.equal(envelope.oauthClientId, 'gmc_claude_dcr_003');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('capture envelope default request: unknown platform + legacy profile, oauthClientId null', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gmg-platform-default-'));
  try {
    const req = {
      method: 'POST', url: '/mcp',
      headers: { 'content-type': 'application/json' },
      __gatewayRawBody: '{"jsonrpc":"2.0","method":"tools/list","id":1}',
    };
    const res = fakeRes();
    startCapture(req, res, { mode: 'full', sink: 'file', fileDir: dir, env: EMPTY_ENV });
    res.end('ok');
    await new Promise((resolve) => setTimeout(resolve, 150));
    const files = await readdir(dir);
    const envelope = JSON.parse(await readFile(join(dir, files[0]), 'utf8'));
    assert.equal(envelope.clientPlatform, PLATFORM_UNKNOWN);
    assert.equal(envelope.clientProfile, PROFILE_GEMINI_TEXT_JSON);
    assert.equal(envelope.oauthClientId, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('capture skipped/disabled: no envelope is written', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gmg-platform-disabled-'));
  try {
    const req = { method: 'POST', url: '/mcp', headers: { [PROFILE_HEADER]: 'chatgpt' }, oauthClientId: 'x' };
    const res = fakeRes();
    const cap = startCapture(req, res, { mode: 'off', sink: 'file', fileDir: dir });
    assert.equal(cap, null);
    res.end('ok');
    await new Promise((resolve) => setTimeout(resolve, 80));
    const files = await readdir(dir);
    assert.equal(files.length, 0, 'disabled capture must not write any envelope');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
