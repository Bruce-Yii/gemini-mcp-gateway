#!/usr/bin/env node
/**
 * Vercel CIMD rejection probe — READ-ONLY, offline-testable evidence collector.
 *
 * Goal: find out WHY `mcp.vercel.com` answers `Invalid client_id` to our CIMD
 * `client_id` while the Notion CIMD gets past client resolution (and fails on a
 * deliberately-too-short `code_challenge` instead). This script never logs in,
 * never obtains a code, never POSTs to a token endpoint, and never writes files.
 *
 * Method: for each candidate CIMD URL, issue a GET to Vercel's authorize
 * endpoint with an intentionally invalid (too short) PKCE challenge and a
 * throwaway redirect_uri. Then classify ONLY from what the server returns:
 *
 *   - `client_id_rejected` : error text matches Invalid client_id / app ID
 *                            invalid — Vercel never accepted the client.
 *   - `pkce_stage_reached` : error text/code mentions code_challenge / PKCE —
 *                            client resolution SUCCEEDED. This is the same
 *                            class of result as the Notion control; it is the
 *                            ONLY signal this probe treats as "CIMD accepted".
 *   - `fetch_failed`       : the CIMD URL itself could not be fetched (we do a
 *                            separate GET on it). Covers SSRF/private-IP blocks,
 *                            non-200, wrong content-type, client_id mismatch.
 *   - `unknown`            : anything else. Never guessed, never counted as OK.
 *
 * IMPORTANT — no fabricated success:
 *   - There is no `accepted: true` unless the observed error is pkce_stage.
 *   - A case that returns 200 / a consent page with our short challenge is
 *     reported as `unexpected_no_error` (still NOT a successful authorization),
 *     because no code/token was requested and none was received.
 *   - The whole report is marked `controlOk: false` when the Notion control does
 *     not reach pkce_stage; in that situation no conclusion may be drawn.
 *
 * Fetch injection: pass `fetchImpl` to runProbe. All HTTP goes through it.
 * The CLI uses globalThis.fetch; importing the module never performs I/O.
 *
 * Usage (CLI, network — only when operator explicitly allows it):
 *   node scripts/vercel-cimd-probe.mjs --client-id https://example.com/cimd.json
 *   node scripts/vercel-cimd-probe.mjs --case-file ./cases.json
 *
 * Library use (tests, zero network):
 *   import { runProbe, NOTION_CONTROL, verifyCimdDocument } from './scripts/vercel-cimd-probe.mjs';
 *   const report = await runProbe({ fetchImpl: myFakeFetch, clientIds: ['https://x/y'] });
 *
 * The `--case-file` JSON is an array of strings (URLs) or objects
 * `{ clientId, label, document? }`. When `document` is supplied, the CIMD-GET
 * step uses it instead of a network fetch — useful for field-combination
 * experiments without hosting each variant (the authorize call still goes
 * through the real AS, so a document-only variant can only be scored on the
 * CIMD-GET checks, with authorize stage reported as `skipped_document_only`).
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

/** Known-good control: Vercel accepts this document and then fails on PKCE. */
export const NOTION_CONTROL = 'https://www.notion.so/oauth/mcp-client-metadata.json';
export const VERCEL_AUTHORIZE = 'https://vercel.com/oauth/authorize';
export const DEFAULT_REDIRECT_URI = 'https://localhost/__vercel_cimd_probe__/callback';
/** Deliberately too short — RFC 7636 S256 requires 43..128 chars. No code issued. */
export const SHORT_CHALLENGE = 'short';

const CLIENT_ID_RE = /invalid\s*client[_ ]?id|app\s*(?:id|ID)\s*is\s*invalid|invalid\s*app\b/i;
const PKCE_RE = /code[_-]?challenge|pkce|challenge_method/i;

function normalizeCase(input) {
  if (typeof input === 'string') return { clientId: input, label: input, document: undefined, contentType: undefined };
  if (input && typeof input === 'object' && typeof input.clientId === 'string') {
    return {
      clientId: input.clientId,
      label: input.label ?? input.clientId,
      document: input.document,
      contentType: input.contentType,
    };
  }
  throw new Error('each probe case must be a URL string or { clientId, ... }');
}

/** Build the (never-submitted) authorize URL used for error classification. */
export function buildAuthorizeUrl(clientId, { redirectUri = DEFAULT_REDIRECT_URI, challenge = SHORT_CHALLENGE } = {}) {
  const url = new URL(VERCEL_AUTHORIZE);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('code_challenge', challenge); // intentionally invalid
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', 'cimd-probe-no-login');
  url.searchParams.set('resource', 'https://mcp.vercel.com/');
  url.searchParams.set('scope', 'openid');
  return url.toString();
}

/** Classify one observed authorize response. Never returns 'accepted'. */
export function classifyAuthorizeResponse({ status, body }) {
  const text = typeof body === 'string' ? body : '';
  let data = null;
  try { data = JSON.parse(text); } catch { /* plain-text error pages are normal */ }
  const haystack = [data?.error, data?.error_description, data?.message, text]
    .filter(Boolean).join(' | ');
  if (CLIENT_ID_RE.test(haystack)) return 'client_id_rejected';
  if (PKCE_RE.test(haystack)) return 'pkce_stage_reached';
  if (status >= 200 && status < 300 && !haystack) return 'unexpected_no_error';
  return 'unknown';
}

/**
 * Offline structural checks on a CIMD document. These are facts we can verify
 * without Vercel; they are reported separately from the AS verdict.
 */
export function verifyCimdDocument({ clientId, document, contentType = '' }) {
  const checks = {
    isObject: Boolean(document) && typeof document === 'object' && !Array.isArray(document),
    clientIdMatchesUrl: document?.client_id === clientId,
    hasRedirectUris: Array.isArray(document?.redirect_uris) && document.redirect_uris.length > 0,
    contentTypeJson: /application\/(?:json|\S+\+json)/i.test(contentType),
  };
  checks.fetched = checks.isObject && checks.clientIdMatchesUrl
    && checks.hasRedirectUris && checks.contentTypeJson;
  return checks;
}

async function readBody(response) {
  try { return await response.text(); } catch { return ''; }
}

function header(response, name) {
  if (typeof response?.headers?.get === 'function') return response.headers.get(name) ?? '';
  const h = response?.headers ?? {};
  return String(h[name] ?? h[name.toLowerCase()] ?? '');
}

/**
 * Run the probe. Every network operation calls `fetchImpl(url, init)`.
 * @param {object} opts
 * @param {Function} opts.fetchImpl - injectable fetch (required for tests)
 * @param {(string|object)[]} opts.clientIds - candidate CIMD URLs/cases
 * @param {string} [opts.controlClientId] - control URL (default NOTION_CONTROL)
 * @param {string} [opts.redirectUri] - throwaway redirect_uri
 * @param {string} [opts.challenge] - deliberately short challenge
 */
export async function runProbe({
  fetchImpl = globalThis.fetch,
  clientIds = [],
  controlClientId = NOTION_CONTROL,
  redirectUri = DEFAULT_REDIRECT_URI,
  challenge = SHORT_CHALLENGE,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetchImpl must be a function');
  const cases = [controlClientId, ...clientIds].map(normalizeCase);
  const report = {
    generatedAt: new Date().toISOString(),
    authorizeEndpoint: VERCEL_AUTHORIZE,
    note: 'read-only: no login, no code redemption, no token request, no files written',
    control: { clientId: controlClientId, stage: 'not_run' },
    cases: [],
    controlOk: false,
    conclusions: [],
  };

  const runCase = async (entry, isControl) => {
    const result = {
      clientId: entry.clientId,
      label: entry.label,
      isControl,
      cimdFetch: { status: null, contentType: '', checks: null, bodyExcerpt: '' },
      authorize: { url: null, status: null, stage: 'skipped_document_only', errorText: '' },
    };

    // Step 1: fetch the document itself (unless a literal document was injected).
    let observedDocument = entry.document;
    if (observedDocument === undefined) {
      try {
        const res = await fetchImpl(entry.clientId, {
          method: 'GET',
          headers: { accept: 'application/json' },
          redirect: 'manual',
        });
        const body = await readBody(res);
        result.cimdFetch.status = res.status ?? null;
        result.cimdFetch.contentType = header(res, 'content-type');
        result.cimdFetch.bodyExcerpt = body.slice(0, 300);
        try { observedDocument = JSON.parse(body); } catch { observedDocument = null; }
      } catch (error) {
        result.cimdFetch.bodyExcerpt = `fetch threw: ${error instanceof Error ? error.message : String(error)}`;
        observedDocument = null;
      }
    } else if (entry.contentType !== undefined) {
      // Injected document + explicitly supplied header (e.g. a recorded
      // response): use it so structural checks stay honest.
      result.cimdFetch.contentType = String(entry.contentType);
    } else {
      result.cimdFetch.contentType = 'not-observed (document injected)';
    }
    result.cimdFetch.checks = verifyCimdDocument({
      clientId: entry.clientId,
      document: observedDocument,
      contentType: result.cimdFetch.contentType,
    });

    // Step 2: authorize GET with a broken challenge. Document-only variants are
    // not submitted to the AS — a doc that isn't actually hosted can't be tested.
    if (entry.document !== undefined) {
      result.authorize.stage = 'skipped_document_only';
      return result;
    }
    result.authorize.url = buildAuthorizeUrl(entry.clientId, { redirectUri, challenge });
    try {
      const res = await fetchImpl(result.authorize.url, {
        method: 'GET',
        headers: { accept: 'text/html,application/json' },
        redirect: 'manual',
      });
      const body = await readBody(res);
      result.authorize.status = res.status ?? null;
      result.authorize.stage = classifyAuthorizeResponse({ status: res.status, body });
      result.authorize.errorText = body.slice(0, 300);
    } catch (error) {
      result.authorize.stage = 'fetch_failed';
      result.authorize.errorText = error instanceof Error ? error.message : String(error);
    }
    return result;
  };

  for (const entry of cases) {
    const result = await runCase(entry, entry.clientId === controlClientId);
    report.cases.push(result);
    if (result.isControl) report.control = {
      clientId: result.clientId,
      stage: result.authorize.stage,
      status: result.authorize.status,
      errorText: result.authorize.errorText,
      cimdFetch: result.cimdFetch,
    };
  }

  report.controlOk = report.control.stage === 'pkce_stage_reached';
  if (!report.controlOk) {
    report.conclusions.push('CONTROL_FAILED: Notion CIMD did not reach pkce_stage; results are not interpretable. Re-run or check network/proxy.');
  } else {
    for (const c of report.cases.filter((x) => !x.isControl)) {
      if (c.authorize.stage === 'skipped_document_only') {
        report.conclusions.push(`${c.label}: document-only variant; CIMD-GET checks only, AS not queried.`);
      } else if (c.authorize.stage === 'pkce_stage_reached') {
        report.conclusions.push(`${c.label}: CIMD ACCEPTED by Vercel (same stage as control). Difference that made it pass: ${c.label}.`);
      } else if (!c.cimdFetch.checks?.fetched) {
        report.conclusions.push(`${c.label}: document not fetchable/valid over HTTPS (${c.cimdFetch.status}); server cannot have accepted it.`);
      } else if (c.authorize.stage === 'client_id_rejected') {
        report.conclusions.push(`${c.label}: valid-looking document but Vercel rejected the client_id — host/path allowlist or pre-registration likely.`);
      } else {
        report.conclusions.push(`${c.label}: stage=${c.authorize.stage}; inconclusive.`);
      }
    }
  }
  return report;
}

function parseArgs(argv) {
  const clientIds = [];
  let caseFile;
  let controlClientId;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--client-id' && argv[i + 1]) clientIds.push(argv[++i]);
    else if (argv[i].startsWith('--client-id=')) clientIds.push(argv[i].slice('--client-id='.length));
    else if (argv[i] === '--case-file' && argv[i + 1]) caseFile = argv[++i];
    else if (argv[i].startsWith('--case-file=')) caseFile = argv[i].slice('--case-file='.length);
    else if (argv[i] === '--control' && argv[i + 1]) controlClientId = argv[++i];
    else if (argv[i].startsWith('--control=')) controlClientId = argv[i].slice('--control='.length);
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return { clientIds, caseFile, controlClientId };
}

const invokedDirectly = (() => {
  try { return Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch { return false; }
})();

if (invokedDirectly) {
  const { clientIds, caseFile, controlClientId } = parseArgs(process.argv.slice(2));
  let cases = [...clientIds];
  if (caseFile) {
    const parsed = JSON.parse(await readFile(caseFile, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error('--case-file must contain a JSON array');
    cases = cases.concat(parsed);
  }
  if (cases.length === 0) {
    console.error('usage: vercel-cimd-probe.mjs --client-id <https-url> [--case-file cases.json] [--control <url>]');
    process.exitCode = 2;
  } else {
    const report = await runProbe({
      fetchImpl: globalThis.fetch,
      clientIds: cases,
      ...(controlClientId ? { controlClientId } : {}),
    });
    console.log(JSON.stringify(report, null, 2));
    if (!report.controlOk) process.exitCode = 1;
  }
}
