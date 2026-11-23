/**
 * Batch 11 · real GitHub usage feedback regressions.
 *
 * Covers three confirmed reports:
 *  1. createBranchIfMissing / ensureBranch only accepted `name`; real callers
 *     pass `branch` and got "ensureBranch: name is required".
 *  2. normalizePrResult treated the database `id` as the PR number; a real
 *     create_pull_request returned {id:1000000001, url:'.../pull/53'} and the
 *     follow-up merge call 404'd. The number must come from number/URL only.
 *  3. High-frequency read-only need: GitHub Actions failure logs. Added as
 *     gateway-side REST helpers in Code Mode (no new upstream MCP tool).
 *
 * All network I/O is faked; no real token, no real GitHub calls.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ensureBranch,
  createBranchIfMissing,
  canonicalResult,
  githubActionsListWorkflowRuns,
  githubActionsListWorkflowJobs,
  githubActionsGetJobLogs,
} from '../src/github-helpers.js';
import { normalizePrResult, normalizeResult, normalizeIssueResult } from '../src/result-normalize.js';
import { runInSandbox, createCodeModeTools } from '../src/codemode.js';

// ---------------------------------------------------------------------------
// 1. Branch alias normalization
// ---------------------------------------------------------------------------

test('branch alias: createBranchIfMissing accepts branch (real GitHub tool spelling)', async () => {
  const created = [];
  const out = await createBranchIfMissing({
    listBranches: async () => [{ name: 'main' }],
    createBranch: async (a) => { created.push(a); return { name: a.name }; },
    branch: 'fix/gh-feedback',
    base: 'main',
  });
  assert.equal(out.created, true);
  assert.deepEqual(created, [{ name: 'fix/gh-feedback', fromSha: 'main' }]);
});

test('branch alias: ensureBranch accepts branchName and name too', async () => {
  for (const key of ['name', 'branch', 'branchName']) {
    const out = await ensureBranch({
      listBranches: async () => [],
      createBranch: async (a) => ({ name: a.name }),
      [key]: 'feature/alias',
      fromSha: 'base',
    });
    assert.equal(out.created, true, `alias ${key}`);
  }
});

test('branch alias: matching an existing branch works through branch alias', async () => {
  const existing = { name: 'feature/x', sha: 'abc' };
  let createCalls = 0;
  const out = await ensureBranch({
    listBranches: async () => ({ items: [existing] }),
    createBranch: async () => { createCalls += 1; return {}; },
    branch: 'feature/x',
  });
  assert.equal(out.reused, true);
  assert.equal(out.branch, existing);
  assert.equal(createCalls, 0);
});

test('branch alias: clears error when no name is supplied at all', async () => {
  await assert.rejects(
    ensureBranch({ listBranches: async () => [], createBranch: async () => ({}) }),
    /ensureBranch: branch name is required \(pass name, branch or branchName\)/,
  );
});

test('branch alias: Code Mode ensureBranch/createBranchIfMissing accept branch (capture d6f59a7e)', async () => {
  const calls = [];
  const tool = (name) => ({
    server: 'github', tool: name, name: `github__${name}`,
    description: name, inputSchema: { type: 'object', properties: {}, required: [] },
  });
  const out = await runInSandbox({
    code: `async () => {
      const a = await codemode.ensureBranch({ owner: 'o', repo: 'r', branch: 'fix/alias', fromBranch: 'main' });
      const b = await codemode.createBranchIfMissing({ owner: 'o', repo: 'r', branch: 'fix/alias-2', base: 'main' });
      return { a, b };
    }`,
    tools: [tool('list_branches'), tool('create_branch')],
    callTool: async (server, tool, args) => {
      calls.push({ tool, args });
      if (tool === 'list_branches') return { content: [{ type: 'text', text: '[]' }] };
      return { content: [{ type: 'text', text: JSON.stringify({ name: args.branch }) }] };
    },
  });
  assert.ok(!out.isError, out.result);
  const value = JSON.parse(out.result);
  assert.equal(value.a.created, true);
  assert.equal(value.b.created, true);
  const creates = calls.filter((c) => c.tool === 'create_branch');
  assert.deepEqual(creates.map((c) => c.args.branch), ['fix/alias', 'fix/alias-2']);
});

// ---------------------------------------------------------------------------
// 2. PR number must never come from the database id
// ---------------------------------------------------------------------------

// Exact shape from the reported capture: database id plus html/API URL.
const REAL_PR = { id: 1000000001, url: 'https://github.com/o/r/pull/53' };

test('PR number: real create_pull_request shape → number 53 from URL, not id', () => {
  const out = normalizePrResult(REAL_PR);
  assert.equal(out.number, 53);
  assert.equal(out.id, '1000000001', 'id is preserved only as the id field');
});

test('PR number: explicit number wins over URL when both agree; URL wins when they disagree', () => {
  assert.equal(normalizePrResult({ number: 53, id: 123, url: 'https://github.com/o/r/pull/53' }).number, 53);
  assert.equal(normalizePrResult({ number: 999, id: 123, url: 'https://github.com/o/r/pull/53' }).number, 53,
    'URL extraction is authoritative');
});

test('PR number: id alone never becomes number', () => {
  const out = normalizePrResult({ id: 1000000001 });
  assert.equal(out.number, null);
  assert.equal(out.id, '1000000001');
});

test('PR number: prNumber/pr_number aliases still work without a URL', () => {
  assert.equal(normalizePrResult({ prNumber: 7 }).number, 7);
  assert.equal(normalizePrResult({ pr_number: 8 }).number, 8);
});

test('PR number: dispatch and canonicalResult / merge helper agree', () => {
  const dispatched = normalizeResult('github__create_pull_request', REAL_PR);
  assert.equal(dispatched.number, 53);
  assert.equal(canonicalResult(REAL_PR).number, 53);
  const merge = canonicalResult({ id: 1000000001, url: 'https://github.com/o/r/pull/53', sha: 'abc' });
  assert.equal(merge.number, 53);
  assert.equal(merge.sha, 'abc');
});

test('PR number: issue normalize also refuses id-as-number', () => {
  const out = normalizeIssueResult({ id: 1000000001, url: 'https://github.com/o/r/issues/21' });
  assert.equal(out.number, 21);
  assert.equal(out.id, '1000000001');
  assert.equal(normalizeIssueResult({ id: 9 }).number, null);
});

test('PR number: sandbox prResult and normalizeMerge use URL, not id', async () => {
  const out = await runInSandbox({
    code: `async () => {
      const pr = codemode.prResult(${JSON.stringify(REAL_PR)});
      const canon = codemode.canonicalize(${JSON.stringify(REAL_PR)});
      const merge = codemode.normalizeMerge(${JSON.stringify(REAL_PR)});
      return { pr, canon, merge };
    }`,
    tools: [],
    callTool: async () => ({}),
  });
  assert.ok(!out.isError, out.result);
  const value = JSON.parse(out.result);
  assert.equal(value.pr.number, 53);
  assert.equal(value.canon.number, 53);
  assert.equal(value.merge.number, 53);
});

// ---------------------------------------------------------------------------
// 3. GitHub Actions read-only helpers (host bridge + injected fake fetch)
// ---------------------------------------------------------------------------

const TOKEN_ENV = { GITHUB_TOKEN: 'fake-token-not-logged' };

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'application/json' : null) },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

function textResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => body,
  };
}

function redirectResponse(location) {
  return {
    ok: false,
    status: 302,
    headers: { get: (k) => (k.toLowerCase() === 'location' ? location : null) },
    text: async () => '',
  };
}

test('actions: list workflow runs sends correct URL/query and returns stable shape', async () => {
  const urls = [];
  const fakeFetch = async (url) => {
    urls.push(url);
    return jsonResponse({ total_count: 1, workflow_runs: [{ id: 10, status: 'failure' }] });
  };
  const out = await githubActionsListWorkflowRuns({
    fetch: fakeFetch,
    env: TOKEN_ENV,
    owner: 'o',
    repo: 'r',
    workflow_id: 42,
    status: 'failure',
    branch: 'main',
    per_page: 5,
  });
  assert.equal(out.ok, true);
  assert.equal(out.status, 200);
  assert.equal(out.data.workflow_runs[0].id, 10);
  assert.equal(out.truncated, false);
  assert.match(urls[0], /^https:\/\/api\.github\.com\/repos\/o\/r\/actions\/runs\?/);
  assert.match(urls[0], /workflow_id=42/);
  assert.match(urls[0], /status=failure/);
  assert.match(urls[0], /branch=main/);
  assert.match(urls[0], /per_page=5/);
});

test('actions: list jobs accepts runId alias and returns data', async () => {
  const fakeFetch = async () => jsonResponse({ jobs: [{ id: 99, conclusion: 'failure' }] });
  const out = await githubActionsListWorkflowJobs({ fetch: fakeFetch, env: TOKEN_ENV, owner: 'o', repo: 'r', runId: 123 });
  assert.equal(out.ok, true);
  assert.equal(out.data.jobs[0].id, 99);
});

test('actions: get job logs returns text (including failure diagnostics)', async () => {
  const log = '2026-11-23T00:00:00Z Error: process exited with code 1\n';
  const out = await githubActionsGetJobLogs({ fetch: async () => textResponse(log), env: TOKEN_ENV, owner: 'o', repo: 'r', jobId: 77 });
  assert.equal(out.ok, true);
  assert.equal(out.status, 200);
  assert.equal(out.text, log);
  assert.equal(out.truncated, false);
});

test('actions: 302 to signed log URL is followed without forwarding the token', async () => {
  const urls = [];
  const fakeFetch = async (url, init) => {
    urls.push({ url, auth: init?.headers?.Authorization });
    if (urls.length === 1) return redirectResponse('https://storage.example.com/signed-log?sig=abc');
    return textResponse('signed log body');
  };
  const out = await githubActionsGetJobLogs({ fetch: fakeFetch, env: TOKEN_ENV, owner: 'o', repo: 'r', job_id: 77 });
  assert.equal(out.ok, true);
  assert.equal(out.text, 'signed log body');
  assert.equal(urls.length, 2);
  assert.equal(urls[0].auth, 'Bearer fake-token-not-logged');
  assert.equal(urls[1].auth, undefined, 'token must not be forwarded to the redirect target');
});

test('actions: no token returns structured error (never prints token)', async () => {
  let called = 0;
  const fakeFetch = async () => { called += 1; return jsonResponse({}); };
  for (const fn of [githubActionsListWorkflowRuns, githubActionsListWorkflowJobs, githubActionsGetJobLogs]) {
    const out = await fn({ fetch: fakeFetch, env: {}, owner: 'o', repo: 'r', run_id: 1, job_id: 2 });
    assert.equal(out.ok, false);
    assert.equal(out.status, 0);
    assert.match(out.error, /GITHUB_TOKEN/);
    assert.ok(!JSON.stringify(out).includes('fake-token'));
  }
  assert.equal(called, 0, 'no network call without a token');
});

test('actions: non-200 responses become stable structured errors', async () => {
  const out = await githubActionsListWorkflowRuns({
    fetch: async () => jsonResponse({ message: 'Not Found' }, 404),
    env: TOKEN_ENV,
    owner: 'o',
    repo: 'r',
  });
  assert.equal(out.ok, false);
  assert.equal(out.status, 404);
  assert.equal(out.data, null);
  assert.match(out.error, /404/);
  assert.equal(JSON.stringify(out).includes('fake-token-not-logged'), false);
});

test('actions: oversized log body is truncated with flag', async () => {
  const big = 'x'.repeat(5000);
  const out = await githubActionsGetJobLogs({
    fetch: async () => textResponse(big),
    env: TOKEN_ENV,
    owner: 'o',
    repo: 'r',
    job_id: 1,
    maxBytes: 1024,
  });
  assert.equal(out.ok, true);
  assert.equal(out.truncated, true);
  assert.equal(out.text.length, 1024);
});

test('actions: helpers are reachable in Code Mode sandbox via injected fetch', async () => {
  const fakeFetch = async (url) => {
    if (url.includes('/actions/runs/') && url.endsWith('/jobs')) return jsonResponse({ jobs: [{ id: 5 }] });
    if (url.includes('/actions/jobs/')) return textResponse('job failed');
    return jsonResponse({ workflow_runs: [{ id: 1 }] });
  };
  const out = await runInSandbox({
    code: `async () => {
      const runs = await codemode.github_actions_list_workflow_runs({ owner: 'o', repo: 'r', status: 'failure' });
      const jobs = await codemode.github_actions_list_workflow_jobs({ owner: 'o', repo: 'r', run_id: 1 });
      const logs = await codemode.github_actions_get_job_logs({ owner: 'o', repo: 'r', job_id: 5 });
      return { runs, jobs, logs };
    }`,
    tools: [],
    callTool: async () => ({}),
    fetch: fakeFetch,
    env: TOKEN_ENV,
  });
  assert.ok(!out.isError, out.result);
  const value = JSON.parse(out.result);
  assert.equal(value.runs.ok, true);
  assert.equal(value.runs.data.workflow_runs[0].id, 1);
  assert.equal(value.jobs.data.jobs[0].id, 5);
  assert.equal(value.logs.text, 'job failed');
});

test('actions: no new MCP tool is registered; still exactly three tools', () => {
  const manager = { getEntries: () => [], callTool: async () => ({}) };
  const tools = createCodeModeTools(manager);
  assert.deepEqual(tools.map((t) => t.name), ['search', 'execute_read', 'execute']);
});
