/**
 * Network-free regressions for scripts/real-gh-replay.mjs.
 *
 * The replay is the REAL-GitHub counterpart of tests/gpt-online-fix.test.js:
 * here we inject a fake fetch so no token, no network, no commit is involved.
 * Coverage:
 *   - PR list #1/#2/#3/#4: `number` is small, `id` is a long DB id,
 *     id is never used as number (same bug class as gpt-online-fix F4).
 *   - PR #1 detail records number/id/node_id/html_url.
 *   - Actions logs: first hop Accept: application/vnd.github+json with token;
 *     302 -> signed URL followed WITHOUT Authorization and with Accept: * / *;
 *     200 returns text; HTTP 415 no longer appears (gpt-online-fix F1).
 *   - Token safety: the fake token never appears in the evidence JSON.
 *   - Token-absent / 401 / 403 failures are recorded honestly, never faked.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  runReplay,
  redact,
  logDigest,
  resolveGithubToken,
  tokenSourceLabel,
  WANTED_PR_NUMBERS,
  JOB_ID,
  JSON_ACCEPT,
} from '../scripts/real-gh-replay.mjs';

const TOKEN = 'ghp_faketoken_not_logged_000';

function response(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (k) => (k && headers[String(k).toLowerCase()] !== undefined ? headers[String(k).toLowerCase()] : null),
    },
    text: async () => body,
  };
}

function makePr(number, id) {
  return {
    number,
    id,
    node_id: `PR_kwDOEXAMPLE00${number}`,
    html_url: `https://github.com/test-org/test-repo/pull/${number}`,
  };
}

// Fake api.github.com with long DB ids that deliberately differ from numbers.
function prList() {
  return [makePr(1, 1000000002), makePr(2, 1000000003), makePr(3, 1000000004), makePr(4, 1000000001)];
}

/**
 * Build a fake fetch. Logs: first hop 302 to signed URL, second hop 200 text.
 * Records every request so header assertions can be made.
 */
function fakeFetch({ prs = prList(), pr1 = makePr(1, 1000000002), logStatus = 200, firstStatus = 302, listStatus = 200 } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, headers: { ...(init?.headers || {}) }, redirect: init?.redirect });
    if (url.includes('/pulls?state=all')) return response(listStatus, JSON.stringify(prs));
    if (/\/pulls\/1$/.test(url)) return response(200, JSON.stringify(pr1));
    if (url.includes(`/actions/jobs/${JOB_ID}/logs`)) {
      if (firstStatus !== 200) {
        return response(firstStatus, '', { location: 'https://storage.example.com/signed-log?sig=abc123&token=secret' });
      }
      return response(logStatus, '2026-11-23T00:00:00Z step started\n');
    }
    if (url.includes('storage.example.com')) {
      return response(logStatus, '2026-11-23T00:00:00Z Error: process exited with code 1\nsigned-url-body\n');
    }
    return response(404, '{}');
  };
  return { fn, calls };
}

// ---------------------------------------------------------------------------
// 1. PR list: number vs id
// ---------------------------------------------------------------------------

test('PR list: #1/#2/#3/#4 found; number is small, id is a long DB id, never conflated', async () => {
  const { fn } = fakeFetch();
  const out = await runReplay({ fetch: fn, token: TOKEN });
  const list = out.checks.listPullRequests;
  assert.equal(list.ok, true);
  assert.equal(list.status, 200);
  assert.deepEqual(list.wanted, [1, 2, 3, 4]);
  assert.equal(list.found.length, 4);
  for (const f of list.found) {
    assert.equal(f.found, true);
    assert.equal(f.numberIsSmall, true);
    assert.equal(f.idIsLongDbId, true);
    assert.notEqual(f.id, String(f.number));
  }
  assert.equal(list.numberNotId, true);
  assert.deepEqual(WANTED_PR_NUMBERS, [1, 2, 3, 4]);
  assert.equal(out.overallOk, true);
});

test('PR list: URL query is state=all&per_page=100', async () => {
  const { fn, calls } = fakeFetch();
  await runReplay({ fetch: fn, token: TOKEN });
  assert.ok(calls[0].url.includes('/pulls?state=all&per_page=100'));
});

test('PR list: missing PR is reported honestly (not fabricated)', async () => {
  const { fn } = fakeFetch({ prs: [makePr(1, 1000000002), makePr(2, 1000000003)] });
  const out = await runReplay({ fetch: fn, token: TOKEN });
  assert.equal(out.checks.listPullRequests.ok, false);
  assert.equal(out.overallOk, false);
  assert.ok(out.errors.some((e) => e.includes('#3') && e.includes('#4')));
});

// ---------------------------------------------------------------------------
// 2. PR #1 detail
// ---------------------------------------------------------------------------

test('PR #1 detail: records number/id/nodeId/htmlUrl and keeps id != number', async () => {
  const { fn } = fakeFetch();
  const out = await runReplay({ fetch: fn, token: TOKEN });
  const pr = out.checks.pullExact;
  assert.equal(pr.ok, true);
  assert.equal(pr.number, 1);
  assert.equal(pr.id, '1000000002');
  assert.equal(pr.nodeId, 'PR_kwDOEXAMPLE001');
  assert.equal(pr.htmlUrl, 'https://github.com/test-org/test-repo/pull/1');
  assert.equal(pr.numberNotId, true);
});

// ---------------------------------------------------------------------------
// 3. Actions logs: 302 -> signed URL (no token), 200 text, no 415
// ---------------------------------------------------------------------------

test('Actions logs: 302 then 200; JSON Accept on REST, no token / generic Accept on signed URL', async () => {
  const { fn, calls } = fakeFetch();
  const out = await runReplay({ fetch: fn, token: TOKEN });
  const logs = out.checks.actionsLogs;
  assert.equal(logs.ok, true);
  assert.equal(logs.status, 200);
  assert.equal(logs.saw302, true);
  assert.equal(logs.no415, true);
  assert.equal(logs.hop1.accept, JSON_ACCEPT);
  assert.equal(JSON_ACCEPT, 'application/vnd.github+json');
  assert.equal(logs.hop1.hasAuthorization, true);
  assert.equal(logs.hop1.redirectLocationPresent, true);
  assert.ok(logs.hop2, 'signed URL must be followed');
  assert.equal(logs.hop2.hasAuthorization, false);
  assert.equal(logs.hop2.accept, '*/*');
  assert.equal(logs.hop2.status, 200);

  const logCalls = calls.filter((c) => c.url.includes('/logs') || c.url.includes('storage.example.com'));
  assert.equal(logCalls.length, 2);
  assert.equal(logCalls[0].headers.Accept, 'application/vnd.github+json');
  assert.equal(logCalls[0].headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(logCalls[1].headers.Authorization, undefined, 'no token on signed URL');
  assert.equal(logCalls[1].headers.Accept, '*/*');
});

test('Actions logs: direct 200 (no redirect) is accepted and no 415 is observed', async () => {
  const { fn } = fakeFetch({ firstStatus: 200, logStatus: 200 });
  const out = await runReplay({ fetch: fn, token: TOKEN });
  const logs = out.checks.actionsLogs;
  assert.equal(logs.no415, true);
  assert.equal(logs.ok, true);
  assert.equal(logs.saw302, false);
  assert.equal(logs.hop2, null);
  assert.equal(logs.status, 200);
});

test('Actions logs: an actual 415 would be flagged as failure', async () => {
  const { fn } = fakeFetch({ firstStatus: 415 });
  const out = await runReplay({ fetch: fn, token: TOKEN });
  assert.equal(out.checks.actionsLogs.no415, false);
  assert.equal(out.checks.actionsLogs.ok, false);
  assert.ok(out.errors.some((e) => e.includes('415')));
});

test('Actions logs: log digest gives only length + redacted preview, never the full log', async () => {
  const { fn } = fakeFetch();
  const out = await runReplay({ fetch: fn, token: TOKEN });
  const digest = out.checks.actionsLogs.log;
  const expected = '2026-11-23T00:00:00Z Error: process exited with code 1\nsigned-url-body\n';
  assert.equal(digest.length, expected.length);
  assert.equal(digest.redacted, true);
  assert.equal(digest.preview200, expected.slice(0, 200));
  assert.equal(JSON.stringify(out).includes(expected), false, 'full log must not be in evidence');
});

// ---------------------------------------------------------------------------
// 4. Token safety and honest failure recording
// ---------------------------------------------------------------------------

test('token safety: fake token never appears in evidence JSON', async () => {
  const { fn } = fakeFetch();
  const out = await runReplay({ fetch: fn, token: TOKEN });
  const json = JSON.stringify(out);
  assert.equal(json.includes(TOKEN), false, 'token must never be serialized');
  assert.equal(json.includes('Bearer'), false, 'auth header must never be serialized');
  assert.equal(out.tokenPrinted, false);
});

test('redact(): signed URL and query token are removed', () => {
  const snippet = 'see https://storage.example.com/log?sig=abc&token=xyz for details';
  const r = redact(snippet);
  assert.equal(r.includes('sig=abc'), false);
  assert.equal(r.includes('token=xyz'), false);
  assert.ok(r.includes('for details'));
});

test('logDigest(): gives length and redacted 200-char preview only', () => {
  const long = 'A'.repeat(500);
  const d = logDigest(long);
  assert.equal(d.length, 500);
  assert.equal(d.preview200.length, 200);
  assert.equal(d.redacted, true);
  assert.deepEqual(logDigest(null), { length: 0, preview200: '', redacted: true });
});

test('no token: replay records a real failure, does not fabricate evidence', async () => {
  const { fn, calls } = fakeFetch();
  const out = await runReplay({ fetch: fn, token: '' });
  assert.equal(out.overallOk, false);
  assert.ok(out.errors.some((e) => e.includes('no GitHub token')));
  assert.equal(calls.length, 0, 'no network calls without a token');
  assert.deepEqual(out.checks, {});
});

test('401/403: unauthorized token failures are recorded honestly', async () => {
  for (const status of [401, 403]) {
    const { fn } = fakeFetch({ listStatus: status });
    const out = await runReplay({ fetch: fn, token: TOKEN });
    const list = out.checks.listPullRequests;
    assert.equal(list.ok, false);
    assert.equal(list.status, status);
    assert.match(list.error, /unauthorized|expired|scope/i);
    assert.equal(out.overallOk, false);
    assert.equal(JSON.stringify(out).includes(TOKEN), false);
  }
});

test('resolveGithubToken / tokenSourceLabel: env preferred; none reported safely', () => {
  // Point GATEWAY_SECRET_DIR at a path that cannot exist so no real vault
  // token can ever enter the test process output.
  const noVault = { GATEWAY_SECRET_DIR: 'D:\\__no_such_vault_dir__\\real-gh-replay-test' };
  assert.equal(resolveGithubToken({ ...noVault, GITHUB_TOKEN: TOKEN }), TOKEN);
  assert.equal(resolveGithubToken(noVault), undefined);
  assert.equal(tokenSourceLabel({ ...noVault, GITHUB_TOKEN: TOKEN }), 'env:GITHUB_TOKEN');
  assert.equal(tokenSourceLabel(noVault), 'none');
});
