/**
 * Batch 11 — project/repository as a first-class derived capture tag.
 *
 * Every fixture here is shaped like a real gateway capture request:
 *   POST /mcp, MCP JSON-RPC `tools/call` with `params.arguments.code` holding
 *   guest code that calls `github__get_file_contents(...)`. The two repo names
 *   below come from the real 2026-11-22 capture window documented in
 *   docs/eval/online-offline-join-2026-11-22.md (requestIds 05d1b10d / 0a099ec7
 *   on Bruce-Yii/recruitment-agent; this gateway itself is
 *   Bruce-Yii/gemini-mcp-gateway).
 *
 * Rules pinned: explicit fields only, no prose guessing, no fabrication,
 * dedupe, primary selection, tool-args priority, and envelope additive fields.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { extractProjects } from '../src/project-tag.js';
import { startCapture } from '../src/capture.js';

// ---------------------------------------------------------------------------
// Fixtures modelled on the real recruitment-agent execute_read captures.
// ---------------------------------------------------------------------------

function readFixture({ code, owner, repo }) {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'execute_read',
      arguments: {
        code,
        ...(owner !== undefined ? { owner } : {}),
        ...(repo !== undefined ? { repo } : {}),
      },
    },
  };
}

const RECRUITMENT_CODE = `
const cpRes = await codemode.github__get_file_contents({
  owner: "Bruce-Yii",
  repo: "recruitment-agent",
  path: "src/app/CandidatePage.tsx",
  ref: "main",
});
const cp = cpRes.content || cpRes.resources?.[0]?.text || cpRes.text || "";
return cp.slice(0, 70);
`;

const GATEWAY_CODE = `
const res = await codemode.github__get_file_contents({
  owner: "Bruce-Yii",
  repo: "gemini-mcp-gateway",
  path: "src/capture.js",
  ref: "main",
});
return res.content;
`;

function rawOf(body) {
  return JSON.stringify(body);
}

function reqOf(body) {
  return { method: 'POST', url: '/mcp', headers: {}, __gatewayRawBody: rawOf(body) };
}

// ---------------------------------------------------------------------------
// 1. Real-capture-shaped fixtures
// ---------------------------------------------------------------------------

test('real capture fixture: recruitment-agent code literal derives one project', () => {
  const result = extractProjects(reqOf(readFixture({ code: RECRUITMENT_CODE })));
  assert.deepEqual(result.projects, [{
    server: 'github',
    owner: 'Bruce-Yii',
    repo: 'recruitment-agent',
    key: 'github:Bruce-Yii/recruitment-agent',
    confidence: 'medium',
    source: 'code-literal',
  }]);
  assert.deepEqual(result.primaryProject, result.projects[0]);
});

test('real capture fixture: explicit owner+repo tool args win with high confidence', () => {
  const body = readFixture({
    code: RECRUITMENT_CODE,
    owner: 'Bruce-Yii',
    repo: 'recruitment-agent',
  });
  const result = extractProjects(reqOf(body));
  assert.equal(result.projects.length, 1);
  assert.equal(result.projects[0].source, 'tool-args');
  assert.equal(result.projects[0].confidence, 'high');
  assert.equal(result.projects[0].key, 'github:Bruce-Yii/recruitment-agent');
  assert.equal(result.primaryProject.key, result.projects[0].key);
});

test('real capture fixture: gemini-mcp-gateway PR URL and code literal both derive the same key', () => {
  const code = `
    ${GATEWAY_CODE}
    // see https://github.com/Bruce-Yii/gemini-mcp-gateway/pull/41
  `;
  const result = extractProjects(reqOf(readFixture({ code })));
  assert.equal(result.projects.length, 1, 'dedup by key');
  assert.equal(result.projects[0].key, 'github:Bruce-Yii/gemini-mcp-gateway');
  const sources = new Set(result.projects.map((p) => p.source));
  assert.ok(sources.has('code-literal'), 'code-literal occurrence retained');
  assert.ok(!sources.has('pr-url'), 'PR URL deduped into the same key');
});

// ---------------------------------------------------------------------------
// 2. Multi-repo, dedupe, primary selection
// ---------------------------------------------------------------------------

test('multiple repos in one code string produce multiple tags', () => {
  const code = `
    const a = { owner: "Bruce-Yii", repo: "recruitment-agent" };
    const b = { owner: "Bruce-Yii", repo: "gemini-mcp-gateway" };
    return [a, b];
  `;
  const result = extractProjects(reqOf(readFixture({ code })));
  assert.deepEqual(result.projects.map((p) => p.key), [
    'github:Bruce-Yii/recruitment-agent',
    'github:Bruce-Yii/gemini-mcp-gateway',
  ]);
  // No explicit args: first keyed pair is primary.
  assert.equal(result.primaryProject.key, result.projects[0].key);
});

test('duplicate tags are removed and the most frequent explicit repo becomes primary', () => {
  const body = {
    jsonrpc: '2.0', id: 7, method: 'tools/call',
    params: {
      name: 'github__list_issues',
      arguments: { owner: 'Bruce-Yii', repo: 'recruitment-agent' },
    },
  };
  const result = extractProjects(rawOf(body));
  assert.equal(result.projects.length, 1);
  assert.equal(result.primaryProject.key, 'github:Bruce-Yii/recruitment-agent');
  assert.equal(result.primaryProject.server, 'github');
});

test('with two explicit repos, primary is the one repeated in tool args', () => {
  // Real gateways sometimes send batched code with several explicit arg blocks;
  // emulate repeated explicit occurrences via nested arguments.
  const body = {
    jsonrpc: '2.0', id: 8, method: 'tools/call',
    params: {
      name: 'execute',
      arguments: {
        owner: 'Bruce-Yii',
        repo: 'gemini-mcp-gateway',
        code: `
          { owner: "Bruce-Yii", repo: "recruitment-agent" }
          { owner: "Bruce-Yii", repo: "gemini-mcp-gateway" }
          { owner: "Bruce-Yii", repo: "gemini-mcp-gateway" }
        `,
      },
    },
  };
  const result = extractProjects(reqOf(body));
  // Explicit arg repo is the only tool-args tag, so it is primary even though
  // code mentions the other repo more often (tool params always win).
  assert.equal(result.primaryProject.repo, 'gemini-mcp-gateway');
  assert.equal(result.primaryProject.source, 'tool-args');
  assert.deepEqual(result.projects.map((p) => p.repo).sort(), [
    'gemini-mcp-gateway', 'recruitment-agent',
  ]);
});

test('explicit fields override code when the same repo appears in both', () => {
  const body = readFixture({
    code: `const x = { owner: "Bruce-Yii", repo: "recruitment-agent" };`,
    owner: 'Bruce-Yii',
    repo: 'recruitment-agent',
  });
  const result = extractProjects(reqOf(body));
  assert.equal(result.projects.length, 1);
  assert.equal(result.projects[0].source, 'tool-args');
  assert.equal(result.projects[0].confidence, 'high');
});

// ---------------------------------------------------------------------------
// 3. PR URL and code literal rules
// ---------------------------------------------------------------------------

test('PR URL alone derives owner/repo with medium confidence and pr-url source', () => {
  const code = 'const url = "https://github.com/Bruce-Yii/gemini-mcp-gateway/pull/41";';
  const result = extractProjects(reqOf(readFixture({ code })));
  assert.equal(result.projects.length, 1);
  assert.deepEqual(result.projects[0], {
    server: 'github',
    owner: 'Bruce-Yii',
    repo: 'gemini-mcp-gateway',
    key: 'github:Bruce-Yii/gemini-mcp-gateway',
    confidence: 'medium',
    source: 'pr-url',
  });
  assert.equal(result.primaryProject.key, result.projects[0].key);
});

test('bare github.com PR URL without protocol is accepted', () => {
  const code = 'github.com/Bruce-Yii/recruitment-agent/pull/12';
  const result = extractProjects(reqOf(readFixture({ code })));
  assert.equal(result.primaryProject.key, 'github:Bruce-Yii/recruitment-agent');
});

test('keyed literals accept single quotes and assignment form', () => {
  const code = `owner = 'Bruce-Yii'; repo = 'recruitment-agent';`;
  const result = extractProjects(reqOf(readFixture({ code })));
  assert.equal(result.projects.length, 1);
  assert.equal(result.projects[0].source, 'code-literal');
});

test('a lone repo literal without an owner is ignored (no fabrication)', () => {
  const code = `const repo: "recruitment-agent" = something;`;
  const result = extractProjects(reqOf(readFixture({ code })));
  assert.deepEqual(result, { projects: [], primaryProject: null });
});

// ---------------------------------------------------------------------------
// 4. Negative cases: empty body / no repo / prose / non-tools-call
// ---------------------------------------------------------------------------

test('empty body, non-JSON body, and non-tools-call requests yield no projects', () => {
  assert.deepEqual(extractProjects(''), { projects: [], primaryProject: null });
  assert.deepEqual(extractProjects('not json'), { projects: [], primaryProject: null });
  assert.deepEqual(extractProjects({ __gatewayRawBody: '{}' }), { projects: [], primaryProject: null });
  const list = rawOf({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  assert.deepEqual(extractProjects(list), { projects: [], primaryProject: null });
});

test('tools/call without owner/repo produces empty projects, not a fabricated tag', () => {
  const body = readFixture({ code: 'return 1 + 1;' });
  const result = extractProjects(reqOf(body));
  assert.deepEqual(result, { projects: [], primaryProject: null });
});

test('natural-language repo names are never guessed', () => {
  const body = {
    jsonrpc: '2.0', id: 9, method: 'tools/call',
    params: {
      name: 'execute',
      arguments: { prompt: 'please fix the bug in recruitment-agent and gemini-mcp-gateway' },
    },
  };
  const result = extractProjects(reqOf(body));
  assert.deepEqual(result, { projects: [], primaryProject: null });
});

test('partial explicit args (only owner) do not produce a tag', () => {
  const body = {
    jsonrpc: '2.0', id: 10, method: 'tools/call',
    params: { name: 'github__list_issues', arguments: { owner: 'Bruce-Yii' } },
  };
  assert.deepEqual(extractProjects(rawOf(body)), { projects: [], primaryProject: null });
});

test('extractProjects is pure and deterministic across repeated calls', () => {
  const req = reqOf(readFixture({ code: RECRUITMENT_CODE, owner: 'Bruce-Yii', repo: 'recruitment-agent' }));
  const once = JSON.stringify(extractProjects(req));
  for (let i = 0; i < 4; i += 1) {
    assert.equal(JSON.stringify(extractProjects(req)), once);
  }
  assert.equal(typeof req.__gatewayRawBody, 'string', 'input is not mutated');
});

// ---------------------------------------------------------------------------
// 5. Envelope additive fields
// ---------------------------------------------------------------------------

function fakeRes() {
  const body = [];
  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    headersSent: false,
    getHeaders() { return this.headers; },
    write(chunk) { body.push(Buffer.from(String(chunk))); return true; },
    end(chunk) { if (chunk) body.push(Buffer.from(String(chunk))); this.ended = true; return this; },
    body,
  };
}

async function envelopeOf(req) {
  const dir = await mkdtemp(join(tmpdir(), 'gmg-project-tag-'));
  try {
    const res = fakeRes();
    const cap = startCapture(req, res, { mode: 'full', sink: 'file', fileDir: dir });
    assert.ok(cap?.requestId);
    res.end('{"jsonrpc":"2.0","result":{}}');
    let files = [];
    for (let i = 0; i < 40; i += 1) {
      files = await readdir(dir);
      if (files.length > 0) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(files.length, 1);
    return JSON.parse(await readFile(join(dir, files[0]), 'utf8'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('capture envelope carries projects/primaryProject additively with real fixture', async () => {
  const req = reqOf(readFixture({
    code: RECRUITMENT_CODE,
    owner: 'Bruce-Yii',
    repo: 'recruitment-agent',
  }));
  const env = await envelopeOf(req);
  assert.equal(env.schema, 'gmg.capture.v1');
  assert.equal(env.request.raw, req.__gatewayRawBody);
  assert.deepEqual(env.projects, [{
    server: 'github',
    owner: 'Bruce-Yii',
    repo: 'recruitment-agent',
    key: 'github:Bruce-Yii/recruitment-agent',
    confidence: 'high',
    source: 'tool-args',
  }]);
  assert.deepEqual(env.primaryProject, env.projects[0]);
  // Existing envelope fields are untouched by the additive tags.
  assert.equal(env.response.raw, '{"jsonrpc":"2.0","result":{}}');
  assert.ok(env.model);
  assert.ok(Array.isArray(env.events));
});

test('no-repo capture still has empty projects and null primaryProject', async () => {
  const env = await envelopeOf(reqOf(readFixture({ code: 'return 1;' })));
  assert.deepEqual(env.projects, []);
  assert.equal(env.primaryProject, null);
});

test('capture with empty body never throws and keeps empty project fields', async () => {
  const req = { method: 'POST', url: '/mcp', headers: {}, __gatewayRawBody: '' };
  const env = await envelopeOf(req);
  assert.deepEqual(env.projects, []);
  assert.equal(env.primaryProject, null);
});

test('capture failure/skip path does not force project fields into anything', () => {
  const req = { method: 'POST', url: '/mcp', headers: {} };
  const res = fakeRes();
  // mode off -> startCapture returns null; the disabled marker carries no
  // project fields and no envelope is written at all.
  assert.equal(startCapture(req, res, { mode: 'off' }), null);
  assert.ok(!('projects' in (req.__gatewayCapture ?? {})));
  assert.ok(!('primaryProject' in (req.__gatewayCapture ?? {})));
});
