/**
 * Offline platform conformance suite — B15 "document -> tests" landing.
 *
 * Scope: turn docs/eval/PLATFORM-CONFORMANCE-MATRIX.md into deterministic,
 * local-only tests. NO production code is changed by this file; every fixture
 * is built from functions exported by src/ (or from the read-only offline
 * checker in scripts/platform-conformance.mjs). Nothing here fetches, writes,
 * spawns, uses real credentials, or calls an upstream.
 *
 * Coverage:
 *   A. three platforms: Gemini / ChatGPT / Claude
 *   B. tool-face hard invariants (3 tools, stable names, annotations informational)
 *   C. typed-plan compatibility GAP: current schema has no `plan` -> assert
 *      "unsupported / awaiting v2", never pretend it passes
 *   D. profile isolation: same result -> different encodings, unknown falls
 *      back to Gemini, no cross-platform leakage
 *
 * Concurrency: all tests are serial and pure; they do not touch env, fs,
 * timers, or shared fixtures. Any parallel-runner effects are not produced
 * by this file.
 */
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

import {
  detectClientPlatform,
  PLATFORM_GEMINI,
  PLATFORM_CHATGPT,
  PLATFORM_CLAUDE,
  PLATFORM_UNKNOWN,
  PROFILE_GEMINI_TEXT_JSON,
  PROFILE_CHATGPT_STRUCTURED,
  PROFILE_CLAUDE_TEXT,
} from '../src/client-platform.js';

import { sanitizeTool, sanitizeInputSchema } from '../src/sanitize.js';
import { createCodeModeTools, toModelOutput, validateToolArgs } from '../src/codemode.js';
import { isAllowedRedirectUri } from '../src/oauth.js';
import {
  runConformance,
  isDualEncoded,
  platformOf,
  EXPECTED_TOOLS,
} from '../scripts/platform-conformance.mjs';

const EMPTY_ENV = Object.freeze({});

/* ------------------------------------------------------------------ *
 * Fixture builders — derived from src/, not invented wire snapshots
 * ------------------------------------------------------------------ */

/** Build the real tool descriptors via the exported factory (no upstream I/O). */
function sourceTools() {
  return createCodeModeTools({ getEntries: () => [] }, { env: EMPTY_ENV });
}

/**
 * tools/list descriptor as src/server.js exposes it: sanitized schema, explicit
 * annotation booleans, and additive _meta.securitySchemes (profile-independent).
 */
function listedTools() {
  return sourceTools().map((tool) => {
    const clean = sanitizeTool(tool);
    return {
      name: clean.name,
      description: clean.description,
      inputSchema: sanitizeInputSchema(tool.inputSchema),
      annotations: clean.annotations,
      _meta: { securitySchemes: [{ type: 'oauth2', scopes: ['mcp', 'offline_access'] }] },
    };
  });
}

/** Normal MCP text-JSON tool result, mirroring server.js's textResult(). */
function textResult(value, annotations) {
  const result = { content: [{ type: 'text', text: JSON.stringify(value) }] };
  if (annotations !== undefined) result.annotations = annotations;
  return result;
}

/** Envelope accepted by scripts/platform-conformance.mjs (offline checker). */
function envelope({ id, platform, method = 'tools/call', result }) {
  return {
    requestId: id,
    clientPlatform: platform,
    request: { raw: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { name: 'search' } }) },
    response: { raw: JSON.stringify({ jsonrpc: '2.0', result }) },
  };
}

function checkByName(report, name) {
  const check = report.checks.find((c) => c.check === name);
  assert.ok(check, `missing conformance check: ${name}`);
  return check;
}

/* ================================================================== *
 * A. Three platforms
 * ================================================================== */

test('A1 Gemini: no structuredContent, text JSON preserved, input not mutated', () => {
  const payload = { ok: true, n: 7 };
  const incoming = { ...textResult(payload), structuredContent: { leaked: true } };
  const out = encodeToolResult(incoming, CLIENT_PROFILES[GEMINI]);

  assert.equal(Object.prototype.hasOwnProperty.call(out, 'structuredContent'), false);
  assert.deepEqual(out.content, [{ type: 'text', text: JSON.stringify(payload) }]);
  assert.deepEqual(JSON.parse(out.content[0].text), payload);
  assert.deepEqual(incoming.structuredContent, { leaked: true }, 'source fixture untouched');

  const report = runConformance([
    envelope({ id: 'gemini-clean', platform: PLATFORM_GEMINI, result: out }),
    envelope({ id: 'gemini-list', platform: PLATFORM_GEMINI, method: 'tools/list', result: { tools: listedTools() } }),
  ]);
  assert.equal(checkByName(report, 'gemini_no_structured_content').status, 'pass');
  assert.deepEqual(checkByName(report, 'gemini_no_structured_content').evidence, ['gemini-clean']);
});

test('A2 Gemini: annotations and schemas pass through sanitizeTool without drift', () => {
  const tools = listedTools();
  for (const tool of tools) {
    for (const key of ['readOnlyHint', 'destructiveHint', 'openWorldHint']) {
      assert.equal(typeof tool.annotations[key], 'boolean', `${tool.name}.annotations.${key}`);
    }
    assert.equal(tool.inputSchema.type, 'object', `${tool.name} schema stays object`);
    assert.equal(JSON.stringify(tool.inputSchema), JSON.stringify(sanitizeTool(tool).inputSchema),
      `${tool.name} schema is already sanitized (idempotent)`);
  }
  assert.deepEqual(Object.keys(tools[1].inputSchema.properties), ['code'], 'execute_read input');
  assert.deepEqual(Object.keys(tools[2].inputSchema.properties), ['code'], 'execute input');
});

test('A2b Gemini: sanitizeTool enforces array items / single type / branch cap on fixtures', () => {
  // A deliberately non-Gemini-safe schema, constructed locally — no upstream.
  const dirty = sanitizeTool({
    name: 'bad__schema',
    inputSchema: {
      type: ['object', 'null'],
      properties: {
        list: { type: 'array' },
        choice: { oneOf: Array.from({ length: 10 }, (_, i) => ({ type: 'string', enum: [`v${i}`] })) },
      },
    },
  });
  assert.equal(dirty.inputSchema.type, 'object');
  assert.deepEqual(dirty.inputSchema.properties.list.items, { type: 'string' });
  assert.equal(dirty.inputSchema.properties.choice.oneOf.length, 8);
  assert.match(dirty.inputSchema.description ?? dirty.inputSchema.properties.choice.description ?? '',
    /truncated/);
});

test('A3 ChatGPT: dual encoding is derived from the same text JSON payload', () => {
  const payload = { ok: true, steps: [{ op: 'readFileRange' }] };
  const out = encodeToolResult(textResult(payload), CLIENT_PROFILES[CHATGPT]);

  assert.equal(isDualEncoded(out), true);
  assert.deepEqual(out.structuredContent, payload);
  assert.deepEqual(JSON.parse(out.content[0].text), out.structuredContent, 'same logical payload');

  const report = runConformance([
    envelope({ id: 'chatgpt-dual', platform: PLATFORM_CHATGPT, result: out }),
  ]);
  assert.equal(checkByName(report, 'chatgpt_dual_encoding').status, 'pass');
  assert.deepEqual(checkByName(report, 'chatgpt_dual_encoding').evidence, ['chatgpt-dual']);
});

test('A3b ChatGPT: code-mode model projection also gains structuredContent only for chatgpt', () => {
  const projected = { result: { ok: true, v: 3 }, isError: false };
  const gemini = toModelOutput(projected, CLIENT_PROFILES[GEMINI]);
  const chatgpt = toModelOutput(projected, CLIENT_PROFILES[CHATGPT]);

  assert.equal(Object.prototype.hasOwnProperty.call(gemini, 'structuredContent'), false);
  assert.deepEqual(gemini, projected, 'gemini projection byte-for-byte unchanged');
  assert.deepEqual(chatgpt.structuredContent, { ok: true, v: 3 });
  assert.deepEqual(chatgpt.result, projected.result, 'text/result payload unchanged');
  // The standalone adapter agrees with the codemode boundary.
  assert.deepEqual(encodeModelOutput(projected, CLIENT_PROFILES[CHATGPT]).structuredContent,
    chatgpt.structuredContent);
});

test('A4 ChatGPT: _meta.securitySchemes never pollutes Gemini encoding or tool surface', () => {
  const tools = listedTools();
  assert.ok(tools.every((t) => t._meta?.securitySchemes?.length === 1), 'server-side additive _meta present');

  for (const profileId of [GEMINI, CLAUDE, CHATGPT]) {
    const projected = applyProfileToTools(tools, CLIENT_PROFILES[profileId]);
    assert.deepEqual(projected.map((t) => t.name), EXPECTED_TOOLS, 'names/count stable');
    assert.deepEqual(projected.map((t) => t.inputSchema), tools.map((t) => t.inputSchema), 'schemas stable');
    assert.deepEqual(projected.map((t) => t._meta), tools.map((t) => t._meta), '_meta stays tools/list-only');
  }

  const scResult = encodeToolResult({ ...textResult({ ok: 1 }), _meta: { securitySchemes: ['x'] } },
    CLIENT_PROFILES[GEMINI]);
  assert.equal(Object.prototype.hasOwnProperty.call(scResult, 'structuredContent'), false);
  assert.deepEqual(scResult._meta, { securitySchemes: ['x'] }, 'pass-through only; encoding adds nothing');
  assert.equal(CLIENT_PROFILES[GEMINI].structuredContent, false);
  assert.equal(CLIENT_PROFILES[CLAUDE].structuredContent, false);
});

test('A5 Claude: text JSON + annotations, no structuredContent', () => {
  const annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };
  const payload = { ok: true, op: 'search' };
  const out = encodeToolResult({ ...textResult(payload), structuredContent: payload, annotations },
    CLIENT_PROFILES[CLAUDE]);

  assert.equal(out.structuredContent, undefined);
  assert.deepEqual(out.annotations, annotations);
  assert.deepEqual(JSON.parse(out.content[0].text), payload);

  const report = runConformance([
    envelope({ id: 'claude-list', platform: PLATFORM_CLAUDE, method: 'tools/list', result: { tools: listedTools() } }),
  ]);
  assert.equal(checkByName(report, 'claude_annotations').status, 'pass');
  assert.deepEqual(checkByName(report, 'claude_annotations').evidence, ['claude-list']);
});

test('A6 Claude callback allowlist is implemented (strict host/path only)', () => {
  assert.equal(isAllowedRedirectUri('https://claude.ai/api/mcp/auth_callback'), true);
  for (const bad of [
    'https://claude.ai/api/mcp/auth_callback?x=1',
    'https://claude.ai:8443/api/mcp/auth_callback',
    'https://claude.ai/api/mcp/auth_callback#frag',
    'https://claude.ai/other/path',
    'https://evil.example.com/api/mcp/auth_callback',
    'http://claude.ai/api/mcp/auth_callback',
  ]) {
    assert.equal(isAllowedRedirectUri(bad), false, `must reject ${bad}`);
  }
  // Other platforms' allowlists are unchanged by the Claude addition.
  assert.equal(isAllowedRedirectUri('https://chatgpt.com/connector_platform_oauth_redirect'), true);
  assert.equal(isAllowedRedirectUri('https://oauth-redirect.googleusercontent.com/r/abc'), true);
});

/* ================================================================== *
 * B. Tool-face hard invariants
 * ================================================================== */

test('B1 The entry tool surface is exactly the three stable names, in order', () => {
  assert.deepEqual([...EXPECTED_TOOLS], ['search', 'execute_read', 'execute']);
  const names = sourceTools().map((t) => t.name);
  assert.deepEqual(names, [...EXPECTED_TOOLS]);
  assert.equal(names.length, 3, 'no fourth tool may be added by a profile');
  // Rebuilding is deterministic: no mid-session drift, no rename by profile.
  for (let i = 0; i < 5; i += 1) {
    assert.deepEqual(sourceTools().map((t) => t.name), [...EXPECTED_TOOLS]);
  }
});

test('B2 tools/list check passes on all three platforms and fails on rename/count drift', () => {
  const tools = listedTools();
  const good = runConformance([
    envelope({ id: 'p-g', platform: PLATFORM_GEMINI, method: 'tools/list', result: { tools } }),
    envelope({ id: 'p-c', platform: PLATFORM_CHATGPT, method: 'tools/list', result: { tools } }),
    envelope({ id: 'p-cl', platform: PLATFORM_CLAUDE, method: 'tools/list', result: { tools } }),
  ]);
  assert.equal(checkByName(good, 'stable_tools_list').status, 'pass');
  assert.equal(checkByName(good, 'stable_tools_list').evidence.length, 3);

  const renamed = tools.map((t, i) => i === 1 ? { ...t, name: 'execute_write' } : t);
  const badRename = runConformance([
    envelope({ id: 'bad-name', platform: PLATFORM_CLAUDE, method: 'tools/list', result: { tools: renamed } }),
  ]);
  assert.equal(checkByName(badRename, 'stable_tools_list').status, 'fail');
  assert.deepEqual(checkByName(badRename, 'stable_tools_list').evidence, ['bad-name']);

  const extra = [...tools, { ...tools[0], name: 'extra_tool' }];
  assert.equal(checkByName(runConformance([
    envelope({ id: 'bad-count', platform: PLATFORM_GEMINI, method: 'tools/list', result: { tools: extra } }),
  ]), 'stable_tools_list').status, 'fail');
});

test('B3 Annotations exist on every tool and are informational, NOT a security boundary', () => {
  const tools = sourceTools();
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  assert.deepEqual(byName.search.annotations,
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false });
  assert.deepEqual(byName.execute_read.annotations,
    { readOnlyHint: true, destructiveHint: false, openWorldHint: true });
  assert.deepEqual(byName.execute.annotations,
    { readOnlyHint: false, destructiveHint: true, openWorldHint: true });

  // Profile application never rewrites annotation values (no permission semantics).
  for (const profileId of [GEMINI, CHATGPT, CLAUDE]) {
    const projected = applyProfileToTools(tools, CLIENT_PROFILES[profileId]);
    assert.deepEqual(projected.map((t) => t.annotations), tools.map((t) => t.annotations));
  }
  // Profile objects carry encoding flags + the M1 isolation slots only — no
  // auth/permission fields.
  for (const p of Object.values(CLIENT_PROFILES)) {
    assert.deepEqual(Object.keys(p).sort(), [
      'annotations', 'descriptionMode', 'id', 'outputBudgetChars',
      'structuredContent', 'textJson', 'wireEncoding',
    ]);
  }
  // A read-only-annotated tool's result still follows the ordinary encoding path;
  // annotation flags are not consulted by the adapter.
  const readOnlyResult = textResult({ ok: true }, byName.execute_read.annotations);
  assert.equal(isDualEncoded(encodeToolResult(readOnlyResult, CLIENT_PROFILES[CHATGPT])), true);
  assert.equal(Object.prototype.hasOwnProperty.call(
    encodeToolResult(readOnlyResult, CLIENT_PROFILES[GEMINI]), 'structuredContent'), false);
});

test('B4 Fixture tool descriptors are Gemini-safe after sanitize (stable snapshot shape)', () => {
  const tools = listedTools();
  for (const tool of tools) {
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) return node.forEach(walk);
      if (node.type === 'array') assert.ok(node.items !== undefined, `${tool.name}: array has items`);
      assert.equal(Array.isArray(node.type), false, `${tool.name}: no multi-type`);
      for (const key of ['oneOf', 'anyOf']) {
        if (Array.isArray(node[key])) assert.ok(node[key].length <= 8, `${tool.name}: ${key} <= 8`);
      }
      for (const value of Object.values(node.properties ?? {})) walk(value);
      for (const value of node.items ? [node.items] : []) walk(value);
    };
    walk(tool.inputSchema);
  }
});

/* ================================================================== *
 * C. typed-plan compatibility gap — assert "unsupported", wait for v2
 * ================================================================== */

test('C1 typed-plan GAP: current execute/execute_read schemas have NO plan field (awaiting v2)', () => {
  const byName = Object.fromEntries(sourceTools().map((t) => [t.name, t]));
  for (const name of ['execute', 'execute_read']) {
    const props = byName[name].inputSchema.properties;
    assert.deepEqual(Object.keys(props), ['code'], `${name}: only code is declared`);
    assert.equal(Object.prototype.hasOwnProperty.call(props, 'plan'), false, `${name}: no plan property`);
    assert.equal(byName[name].inputSchema.required.includes('plan'), false, `${name}: plan not required`);
    assert.equal(/\bplan\b/.test(JSON.stringify(byName[name].inputSchema)), false,
      `${name}: plan absent from the whole schema`);
  }
  // Honest status: unsupported by the current schema. Do NOT mark as pass.
  const status = '未支持 (unsupported by current inputSchema; typed-plan v2 only)';
  assert.match(status, /未支持/);
});

test('C2 typed-plan GAP: a {plan:[...]} call is rejected for missing required code', () => {
  const execute = sourceTools().find((t) => t.name === 'execute');
  assert.throws(
    () => validateToolArgs(execute, { plan: [{ op: 'repoGrep', pattern: 'x' }] }),
    /requires fields: code/,
    'typed-plan args do not validate today — do not pretend they pass',
  );
  // Control: the declared code path still validates (so the failure is plan-specific).
  assert.doesNotThrow(() => validateToolArgs(execute, { code: 'async () => 1' }));
});

test('C3 typed-plan GAP: a hypothetical plan schema is sanitizeable but still not wired', () => {
  // Best-effort shape check of the candidate plan schema (matrix §3.2): flat op
  // string + enum, arrays with items. This is a schema sanity check, NOT a claim
  // that clients accept plans or that production supports them.
  const candidate = sanitizeInputSchema({
    type: 'object',
    properties: {
      plan: {
        type: 'array',
        items: {
          type: 'object',
          properties: { op: { type: 'string', enum: ['readFileRange', 'repoGrep'] } },
          required: ['op'],
        },
      },
    },
  });
  assert.deepEqual(candidate.properties.plan.items.type, 'object');
  assert.deepEqual(candidate.properties.plan.items.properties.op.items, undefined);
  assert.equal(candidate.properties.plan.items.properties.op.type, 'string');
  const liveTools = sourceTools();
  assert.ok(liveTools.every((t) => !Object.prototype.hasOwnProperty.call(t.inputSchema.properties, 'plan')),
    'candidate schema is NOT registered in production; gap remains');
});

/* ================================================================== *
 * D. Profile isolation / no cross-platform leakage
 * ================================================================== */

test('D1 Same result, three encodings: gemini/claude text-only, chatgpt dual', () => {
  const payload = { ok: true, value: 'shared-payload' };
  const withAnnotations = textResult(payload, { readOnlyHint: true, destructiveHint: false, openWorldHint: false });
  const gemini = encodeToolResult(withAnnotations, CLIENT_PROFILES[GEMINI]);
  const chatgpt = encodeToolResult(withAnnotations, CLIENT_PROFILES[CHATGPT]);
  const claude = encodeToolResult(withAnnotations, CLIENT_PROFILES[CLAUDE]);

  assert.equal(Object.prototype.hasOwnProperty.call(gemini, 'structuredContent'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(claude, 'structuredContent'), false);
  assert.deepEqual(chatgpt.structuredContent, payload);
  assert.deepEqual(claude.annotations, withAnnotations.annotations);
  assert.equal(JSON.stringify(gemini.content), JSON.stringify(claude.content));
  assert.equal(JSON.stringify(claude.content), JSON.stringify(chatgpt.content));
  // Encoding never mutates the shared source result.
  assert.equal(Object.prototype.hasOwnProperty.call(withAnnotations, 'structuredContent'), false);
});

test('D2 Explicit declarations select platforms; unknown/ambiguous falls back to Gemini', () => {
  assert.equal(resolveClientProfile({ headers: {}, body: {}, env: EMPTY_ENV }).id, GEMINI);
  assert.equal(resolveClientProfile({ headers: { [PROFILE_HEADER]: 'mystery' }, env: EMPTY_ENV }).id, GEMINI);
  assert.equal(detectClientPlatform({ headers: {}, body: {}, env: EMPTY_ENV }).platform, PLATFORM_UNKNOWN);
  assert.equal(detectClientPlatform({ headers: { [PROFILE_HEADER]: 'mystery' }, env: EMPTY_ENV }).profile,
    PROFILE_GEMINI_TEXT_JSON);

  assert.equal(resolveClientProfile({ headers: { [PROFILE_HEADER]: 'chatgpt' }, env: EMPTY_ENV }).id, CHATGPT);
  assert.equal(detectClientPlatform({ headers: { [PROFILE_HEADER]: 'chatgpt' }, env: EMPTY_ENV }).profile,
    PROFILE_CHATGPT_STRUCTURED);
  assert.equal(resolveClientProfile({ headers: { [PROFILE_HEADER]: 'claude' }, env: EMPTY_ENV }).id, CLAUDE);
  assert.equal(detectClientPlatform({ headers: { [PROFILE_HEADER]: 'claude' }, env: EMPTY_ENV }).profile,
    PROFILE_CLAUDE_TEXT);

  // A generic UA is not an explicit declaration -> gemini encoding.
  const fromVagueUa = resolveClientProfile({ headers: { 'user-agent': 'Mozilla/5.0' }, env: EMPTY_ENV });
  assert.equal(fromVagueUa.id, GEMINI);
  const payload = { ok: true };
  assert.deepEqual(
    encodeToolResult(textResult(payload), fromVagueUa),
    encodeToolResult(textResult(payload), CLIENT_PROFILES[GEMINI]),
  );
});

test('D3 Unknown platform id in the adapter falls back to Gemini byte-for-byte', () => {
  const result = { ...textResult({ ok: true }), structuredContent: { ok: true } };
  for (const profile of ['unknown', '', { id: 'nope' }, undefined]) {
    const out = profile === undefined
      ? encodeToolResult(result)
      : encodeToolResult(result, profile);
    assert.equal(Object.prototype.hasOwnProperty.call(out, 'structuredContent'), false);
    assert.equal(JSON.stringify(out), JSON.stringify(encodeToolResult(result, CLIENT_PROFILES[GEMINI])));
  }
  assert.equal(platformOf({ clientPlatform: 'garbage' }), 'unknown', 'checker never guesses either');
});

test('D4 No cross-platform leakage: a ChatGPT-shaped result on a Gemini envelope is FAIL, not pass', () => {
  const payload = { ok: true };
  const chatgptWire = encodeToolResult(textResult(payload), CLIENT_PROFILES[CHATGPT]);
  assert.equal(isDualEncoded(chatgptWire), true);

  const contaminated = runConformance([
    envelope({ id: 'leak-1', platform: PLATFORM_GEMINI, result: chatgptWire }),
    envelope({ id: 'ok-chat', platform: PLATFORM_CHATGPT, result: chatgptWire }),
  ]);
  assert.equal(checkByName(contaminated, 'gemini_no_structured_content').status, 'fail');
  assert.deepEqual(checkByName(contaminated, 'gemini_no_structured_content').evidence, ['leak-1']);
  // The ChatGPT check still passes on its own envelope — buckets are independent.
  assert.equal(checkByName(contaminated, 'chatgpt_dual_encoding').status, 'pass');
  assert.deepEqual(checkByName(contaminated, 'chatgpt_dual_encoding').evidence, ['ok-chat']);
});

test('D5 Platform-specific checks do not borrow evidence from another platform', () => {
  const payload = { ok: true };
  const report = runConformance([
    envelope({ id: 'only-chat', platform: PLATFORM_CHATGPT, result: encodeToolResult(textResult(payload), CLIENT_PROFILES[CHATGPT]) }),
  ]);
  assert.equal(checkByName(report, 'chatgpt_dual_encoding').status, 'pass');
  assert.equal(checkByName(report, 'gemini_no_structured_content').status, 'unknown',
    'no gemini fixture => unknown, never a pass by borrowing ChatGPT evidence');
  assert.equal(checkByName(report, 'claude_annotations').status, 'unknown');
  assert.equal(checkByName(report, 'stable_tools_list').status, 'unknown');

  // Re-encoding a foreign result under gemini strips the extra field deterministically.
  const stripped = encodeToolResult(
    encodeToolResult(textResult(payload), CLIENT_PROFILES[CHATGPT]),
    CLIENT_PROFILES[GEMINI],
  );
  assert.equal(Object.prototype.hasOwnProperty.call(stripped, 'structuredContent'), false);
  assert.equal(JSON.stringify(stripped.content), JSON.stringify(textResult(payload).content));
});

test('D6 Frozen defaults cannot be mutated across platform boundaries', () => {
  assert.ok(Object.isFrozen(CLIENT_PROFILES));
  for (const id of [GEMINI, CHATGPT, CLAUDE]) assert.ok(Object.isFrozen(CLIENT_PROFILES[id]));
  assert.throws(() => { CLIENT_PROFILES[GEMINI].structuredContent = true; }, TypeError);
  assert.throws(() => { CLIENT_PROFILES[CHATGPT].textJson = false; }, TypeError);
  // Each resolution returns the same frozen object, not a mutable copy.
  for (const id of [GEMINI, CHATGPT, CLAUDE]) {
    const p = resolveClientProfile({ headers: { [PROFILE_HEADER]: id }, env: EMPTY_ENV });
    assert.equal(p, CLIENT_PROFILES[id]);
  }
});
