#!/usr/bin/env node
/**
 * Real GitHub (READ-ONLY) replay of the PR number/id and Actions-log helper
 * fixes from batch 15 (gpt-online-fix). No commit / push / deploy.
 *
 * What it verifies against api.github.com, using a real token:
 *   1. GET /repos/Bruce-Yii/recruitment-agent/pulls?state=all&per_page=100
 *      - find PR #53, #56, #57, #59; assert `number` is the small PR number
 *        and `id` is a long database id; never use id as number.
 *   2. GET /repos/.../pulls/53 -> record number / id / node_id / html_url.
 *   3. GET /repos/.../actions/jobs/137420494321/logs:
 *      - first hop Accept: application/vnd.github+json, check for 302;
 *      - follow the signed URL WITHOUT Authorization, check 200 + text;
 *      - never print the full log: only a length + redacted 200-char digest.
 *
 * Token source (priority):
 *   1. GITHUB_TOKEN env var
 *   2. Local vault github-auth.json (GATEWAY_SECRET_DIR override, default
 *      D:\12412\dsh-home\.secrets\gemini-mcp-gateway), field `token`.
 * The token is only ever placed in request headers. It is NEVER printed,
 * logged, written to evidence, or included in any error message.
 *
 * The token-free, injectable `runReplay({ fetch, token })` export is what the
 * fake-fetch test imports; this file performs no work on import.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API_BASE = 'https://api.github.com';
const OWNER = 'Bruce-Yii';
const REPO = 'recruitment-agent';
const WANTED_PR_NUMBERS = [53, 56, 57, 59];
const EXACT_PR_NUMBER = 53;
const JOB_ID = 137420494321;
const JSON_ACCEPT = 'application/vnd.github+json';

// ---------------------------------------------------------------------------
// Token resolution (never returns the token to callers that print evidence)
// ---------------------------------------------------------------------------

function vaultTokenPath(env = process.env) {
  const dir = env.GATEWAY_SECRET_DIR
    || path.join('D:\\12412\\dsh-home', '.secrets', 'gemini-mcp-gateway');
  return path.join(dir, 'github-auth.json');
}

/** Read the token from env or the local vault. Returns undefined if none. */
export function resolveGithubToken(env = process.env) {
  if (typeof env.GITHUB_TOKEN === 'string' && env.GITHUB_TOKEN.length > 0) {
    return env.GITHUB_TOKEN;
  }
  // A caller can explicitly disable the vault (e.g. tests) by pointing
  // GATEWAY_SECRET_DIR at a non-existent directory.
  try {
    const file = vaultTokenPath(env);
    if (!fs.existsSync(file)) return undefined;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return typeof data.token === 'string' && data.token.length > 0 ? data.token : undefined;
  } catch {
    return undefined;
  }
}

/** True when a token was found, without revealing any part of it. */
export function tokenSourceLabel(env = process.env) {
  if (typeof env.GITHUB_TOKEN === 'string' && env.GITHUB_TOKEN.length > 0) return 'env:GITHUB_TOKEN';
  try {
    return fs.existsSync(vaultTokenPath(env)) ? 'vault:github-auth.json' : 'none';
  } catch {
    return 'none';
  }
}

// ---------------------------------------------------------------------------
// Redaction helpers — the log body must never leak verbatim into evidence
// ---------------------------------------------------------------------------

/** Redact signed URLs / query tokens / bearer values from a snippet. */
export function redact(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/https?:\/\/\S+/gi, '<url>')
    .replace(/(Bearer\s+)\S+/gi, '$1<redacted>')
    .replace(/([?&](?:sig|token|access_token|X-Amz-Signature|se)=)[^&\s]+/gi, '$1<redacted>');
}

/** Length + first 200 chars of the log, with URLs/tokens redacted. */
export function logDigest(text) {
  const str = typeof text === 'string' ? text : '';
  return {
    length: str.length,
    preview200: redact(str.slice(0, 200)),
    redacted: true,
  };
}

// ---------------------------------------------------------------------------
// HTTP helpers — all reads, all token-safe
// ---------------------------------------------------------------------------

function authHeaders(token, accept = JSON_ACCEPT) {
  return {
    Accept: accept,
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'gemini-mcp-gateway-real-gh-replay',
  };
}

async function readJson(res) {
  const text = typeof res.text === 'function' ? await res.text() : '';
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function statusOf(res) {
  return res && typeof res.status === 'number' ? res.status : 0;
}

function locationOf(res) {
  if (res && typeof res.headers?.get === 'function') return res.headers.get('location');
  return res?.headers?.location ?? null;
}

// ---------------------------------------------------------------------------
// Core replay — pure, injectable fetch, no network on import
// ---------------------------------------------------------------------------

/**
 * Run the read-only replay.
 *
 * @param {object}  opts
 * @param {Function} opts.fetch  fetch(url, init) -> Response-like
 * @param {string}  opts.token   real GitHub token (never included in output)
 * @param {number}  [opts.jobId] job id override (default 137420494321)
 * @returns {Promise<object>} evidence object safe to JSON.stringify/print
 */
export async function runReplay({ fetch: doFetch, token, jobId = JOB_ID } = {}) {
  const evidence = {
    generatedAt: new Date().toISOString(),
    mode: 'real-github-readonly',
    target: { owner: OWNER, repo: REPO, apiBase: API_BASE },
    tokenSource: tokenSourceLabel(),
    tokenPrinted: false,
    checks: {},
    errors: [],
  };

  evidence.overallOk = false;
  if (typeof doFetch !== 'function') {
    evidence.errors.push('fetch is not a function');
    return evidence;
  }
  if (typeof token !== 'string' || token.length === 0) {
    // Honest failure — no fabrication, no token value recorded.
    evidence.errors.push('no GitHub token available (set GITHUB_TOKEN or configure the vault); cannot call api.github.com');
    return evidence;
  }

  // -- Step 1: list PRs -----------------------------------------------------
  const listUrl = `${API_BASE}/repos/${OWNER}/${REPO}/pulls?state=all&per_page=100`;
  let prs;
  try {
    const res = await doFetch(listUrl, { method: 'GET', headers: authHeaders(token) });
    const status = statusOf(res);
    if (status < 200 || status >= 300) {
      evidence.checks.listPullRequests = {
        ok: false, status, url: listUrl, error: `HTTP ${status}${status === 401 || status === 403 ? ' (token unauthorized/expired or lacking scope)' : ''}`,
      };
      evidence.errors.push(`listPullRequests failed: HTTP ${status}`);
      return evidence;
    }
    const body = await readJson(res);
    if (!Array.isArray(body)) {
      evidence.checks.listPullRequests = { ok: false, status, url: listUrl, error: 'response was not a JSON array' };
      evidence.errors.push('listPullRequests: response was not a JSON array');
      return evidence;
    }
    const found = WANTED_PR_NUMBERS.map((n) => {
      const pr = body.find((p) => p && p.number === n);
      if (!pr) return { number: n, found: false };
      return {
        number: pr.number,
        found: true,
        id: String(pr.id),
        idIsLongDbId: Number.isSafeInteger(pr.id) && pr.id > 100000,
        numberIsSmall: Number.isInteger(pr.number) && pr.number < 10000,
        nodeId: pr.node_id ?? null,
        htmlUrl: pr.html_url ?? null,
      };
    });
    const allFound = found.every((f) => f.found);
    const idsDistinct = found.every((f) => !f.found || f.id !== String(f.number));
    evidence.checks.listPullRequests = {
      ok: allFound && idsDistinct,
      status,
      url: listUrl,
      returnedCount: body.length,
      wanted: WANTED_PR_NUMBERS,
      found,
      numberNotId: idsDistinct,
      note: 'number is the small PR number; id is the long DB identifier and is never used as number',
    };
    if (!allFound) evidence.errors.push(`listPullRequests: missing PRs: ${found.filter((f) => !f.found).map((f) => `#${f.number}`).join(', ')}`);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    evidence.checks.listPullRequests = { ok: false, error: redact(msg) };
    evidence.errors.push(`listPullRequests threw: ${redact(msg)}`);
    return evidence;
  }

  // -- Step 2: exact PR #53 ------------------------------------------------
  const prUrl = `${API_BASE}/repos/${OWNER}/${REPO}/pulls/${EXACT_PR_NUMBER}`;
  try {
    const res = await doFetch(prUrl, { method: 'GET', headers: authHeaders(token) });
    const status = statusOf(res);
    const body = status >= 200 && status < 300 ? await readJson(res) : null;
    evidence.checks.pull53 = {
      ok: status >= 200 && status < 300 && !!body,
      status,
      url: prUrl,
      number: body?.number ?? null,
      id: body?.id !== undefined ? String(body.id) : null,
      nodeId: body?.node_id ?? null,
      htmlUrl: body?.html_url ?? null,
      numberNotId: !!body && String(body.id) !== String(body.number),
      error: status >= 300 ? `HTTP ${status}` : undefined,
    };
    if (!evidence.checks.pull53.ok) evidence.errors.push(`pull53 failed: HTTP ${status}`);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    evidence.checks.pull53 = { ok: false, url: prUrl, error: redact(msg) };
    evidence.errors.push(`pull53 threw: ${redact(msg)}`);
  }

  // -- Step 3: Actions job logs (302 -> signed URL, no token on follow) -----
  const logsUrl = `${API_BASE}/repos/${OWNER}/${REPO}/actions/jobs/${jobId}/logs`;
  try {
    const first = await doFetch(logsUrl, {
      method: 'GET',
      headers: authHeaders(token, JSON_ACCEPT),
      redirect: 'follow',
    });
    const firstStatus = statusOf(first);
    const location = locationOf(first);
    const hop1 = {
      url: logsUrl,
      status: firstStatus,
      accept: JSON_ACCEPT,
      hasAuthorization: true,
      redirectLocationPresent: !!location,
    };
    let finalRes = first;
    let finalStatus = firstStatus;
    let hop2 = null;

    // A real fetch with redirect:'follow' may already have landed on 200.
    // Fakes (and some runtimes) hand back the raw 302; follow it ourselves.
    if (firstStatus >= 300 && firstStatus < 400 && location && /^https?:\/\//i.test(location)) {
      hop2 = {
        url: redact(location), // signed URL is redacted in evidence
        status: null,
        hasAuthorization: false,
        accept: '*/*',
      };
      finalRes = await doFetch(location, {
        method: 'GET',
        headers: { Accept: '*/*', 'User-Agent': 'gemini-mcp-gateway-real-gh-replay' },
        redirect: 'follow',
      });
      finalStatus = statusOf(finalRes);
      hop2.status = finalStatus;
    }

    const text = finalStatus >= 200 && finalStatus < 300 && typeof finalRes.text === 'function'
      ? await finalRes.text()
      : null;
    const ok = finalStatus >= 200 && finalStatus < 300 && typeof text === 'string';
    // 415 must NOT appear: Accept: application/vnd.github+json avoids it.
    const no415 = firstStatus !== 415 && finalStatus !== 415;
    evidence.checks.actionsLogs = {
      ok: ok && no415,
      status: finalStatus,
      saw302: firstStatus === 302 || (firstStatus >= 300 && firstStatus < 400),
      no415,
      hop1,
      hop2,
      log: typeof text === 'string' ? logDigest(text) : null,
      error: !ok ? `HTTP ${finalStatus} (first hop ${firstStatus})` : undefined,
    };
    if (!ok) evidence.errors.push(`actionsLogs failed: first=${firstStatus} final=${finalStatus}`);
    if (!no415) evidence.errors.push('actionsLogs: HTTP 415 observed (Accept fix did not take effect)');
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    evidence.checks.actionsLogs = { ok: false, error: redact(msg) };
    evidence.errors.push(`actionsLogs threw: ${redact(msg)}`);
  }

  evidence.overallOk = evidence.errors.length === 0
    && Object.values(evidence.checks).every((c) => c.ok === true);
  return evidence;
}

// ---------------------------------------------------------------------------
// CLI entry (only runs when executed directly, never on import)
// ---------------------------------------------------------------------------

function isMain() {
  if (typeof process === 'undefined' || !process.argv || !process.argv[1]) return false;
  try {
    return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

async function main() {
  const token = resolveGithubToken();
  const result = await runReplay({ fetch: globalThis.fetch, token });
  // Print evidence as JSON. The token is never part of `result`.
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.overallOk) process.exitCode = 1;
}

if (isMain()) {
  main().catch((err) => {
    // Redact any accidental token-bearing message from a thrown error.
    process.stderr.write(`[real-gh-replay] failed: ${redact(err && err.message ? err.message : String(err))}\n`);
    process.exitCode = 1;
  });
}

export { API_BASE, OWNER, REPO, WANTED_PR_NUMBERS, EXACT_PR_NUMBER, JOB_ID, JSON_ACCEPT };
