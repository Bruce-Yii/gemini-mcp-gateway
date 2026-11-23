/**
 * Fake-only regressions for scripts/vercel-cimd-probe.mjs.
 *
 * Every fetch is a local fake: no DNS, no network, no Vercel/Notion call, no
 * login, no token. These tests pin the evidence contract:
 *   - the Notion control must reach pkce_stage_reached before any case is judged;
 *   - our CIMD is only ever scored client_id_rejected / fetch_failed, never
 *     reported as "accepted" on weak evidence;
 *   - document-only field variants cannot fabricate an AS verdict;
 *   - the probe only ever issues GET requests to the CIMD URL and the authorize
 *     endpoint (never a token POST, never follows a redirect).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  NOTION_CONTROL,
  VERCEL_AUTHORIZE,
  DEFAULT_REDIRECT_URI,
  SHORT_CHALLENGE,
  buildAuthorizeUrl,
  classifyAuthorizeResponse,
  verifyCimdDocument,
  runProbe,
} from '../scripts/vercel-cimd-probe.mjs';

const OUR_CIMD = 'https://samples-formula-insulation-sara.trycloudflare.com/.well-known/mcp-client.json';
const GIST_CIMD = 'https://gist.githubusercontent.com/example/raw/cimd.json';

function jsonResponse(body, { status = 200, contentType = 'application/json; charset=utf-8' } = {}) {
  return {
    status,
    headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? contentType : null) },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

function controlDocument() {
  return {
    client_id: NOTION_CONTROL,
    client_name: 'Notion',
    client_uri: 'https://www.notion.so',
    redirect_uris: ['https://www.notion.so/workflows/mcp/oauth/callback'],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    application_type: 'web',
  };
}

function ourDocument(clientId = OUR_CIMD) {
  return {
    client_id: clientId,
    client_name: 'Gemini MCP Gateway (Vercel)',
    client_uri: `${new URL(clientId).origin}/`,
    redirect_uris: ['https://gw.example/upstream/oauth/callback'],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    code_challenge_methods_supported: ['S256'],
    scope: 'openid offline_access',
  };
}

/** Fake fetch: Vercel returns PKCE error for the control, Invalid client_id for us. */
function scenarioFetch(overrides = {}) {
  const calls = [];
  const {
    controlBody = '{"error":"invalid_request","error_description":"code_challenge is too short"}',
    ourBody = '{"error":"invalid_client","error_description":"Invalid client_id: The app ID is invalid"}',
    ourDocStatus = 200,
    ourContentType = 'application/json',
    ourDoc = ourDocument(),
  } = overrides;
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init?.method, redirect: init?.redirect });
    if (url === NOTION_CONTROL) return jsonResponse(controlDocument());
    if (url === VERCEL_AUTHORIZE || String(url).startsWith(`${VERCEL_AUTHORIZE}?`)) {
      const clientId = new URL(url).searchParams.get('client_id');
      return jsonResponse(clientId === NOTION_CONTROL ? controlBody : ourBody);
    }
    if (url === OUR_CIMD) return jsonResponse(ourDoc, { status: ourDocStatus, contentType: ourContentType });
    throw new Error(`unexpected fake fetch: ${url}`);
  };
  return { fetchImpl, calls };
}

// ── pure helpers ────────────────────────────────────────────────────────────

test('buildAuthorizeUrl: uses a deliberately short challenge and no code redemption', () => {
  const url = new URL(buildAuthorizeUrl(OUR_CIMD));
  assert.equal(url.origin + url.pathname, VERCEL_AUTHORIZE);
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('client_id'), OUR_CIMD);
  assert.equal(url.searchParams.get('code_challenge'), SHORT_CHALLENGE);
  assert.ok(SHORT_CHALLENGE.length < 43, 'challenge must be invalid on purpose');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('redirect_uri'), DEFAULT_REDIRECT_URI);
  assert.equal(url.searchParams.get('resource'), 'https://mcp.vercel.com/');
});

test('classifyAuthorizeResponse: only PKCE-stage errors count as CIMD acceptance', () => {
  assert.equal(classifyAuthorizeResponse({ status: 400, body: '{"error_description":"code_challenge too short"}' }), 'pkce_stage_reached');
  assert.equal(classifyAuthorizeResponse({ status: 400, body: 'Invalid client_id: app ID is invalid' }), 'client_id_rejected');
  assert.equal(classifyAuthorizeResponse({ status: 302, body: '' }), 'unknown');
  assert.notEqual(classifyAuthorizeResponse({ status: 200, body: '' }), 'accepted');
});

test('verifyCimdDocument: pins client_id == URL, redirect_uris, and JSON content-type', () => {
  const ok = verifyCimdDocument({ clientId: OUR_CIMD, document: ourDocument(), contentType: 'application/json; charset=utf-8' });
  assert.deepEqual(ok, {
    isObject: true, clientIdMatchesUrl: true, hasRedirectUris: true, contentTypeJson: true, fetched: true,
  });
  assert.equal(verifyCimdDocument({ clientId: OUR_CIMD, document: ourDocument(), contentType: 'text/html' }).fetched, false);
  assert.equal(verifyCimdDocument({ clientId: OUR_CIMD, document: { ...ourDocument(), client_id: GIST_CIMD }, contentType: 'application/json' }).clientIdMatchesUrl, false);
});

// ── end-to-end with fake fetch ──────────────────────────────────────────────

test('runProbe: control reaches PKCE stage, our CIMD is scored client_id_rejected', async () => {
  const { fetchImpl, calls } = scenarioFetch();
  const report = await runProbe({ fetchImpl, clientIds: [OUR_CIMD] });

  assert.equal(report.controlOk, true);
  assert.equal(report.control.stage, 'pkce_stage_reached');
  const ours = report.cases.find((c) => c.clientId === OUR_CIMD);
  assert.equal(ours.authorize.stage, 'client_id_rejected');
  assert.equal(ours.cimdFetch.checks.fetched, true, 'our document really is valid JSON at a 200 URL');
  assert.match(report.conclusions.join('\n'), /pre-registration likely/);
  assert.ok(report.conclusions.some((line) => line.startsWith(OUR_CIMD)));
  // Read-only: only GETs, never a token POST, never follows redirects.
  assert.ok(calls.length >= 4);
  assert.ok(calls.every((c) => c.method === 'GET' && c.redirect === 'manual'));
  assert.equal(calls.some((c) => String(c.url).includes('/token')), false);
});

test('runProbe: a gist URL is classified independently of the tunnel URL', async () => {
  const gistDoc = ourDocument(GIST_CIMD);
  const fetchImpl = async (url) => {
    if (url === NOTION_CONTROL) return jsonResponse(controlDocument());
    if (String(url).startsWith(`${VERCEL_AUTHORIZE}?`)) {
      const clientId = new URL(url).searchParams.get('client_id');
      return jsonResponse(clientId === NOTION_CONTROL
        ? '{"error_description":"code_challenge too short"}'
        : 'Invalid client_id');
    }
    if (url === GIST_CIMD) return jsonResponse(gistDoc);
    throw new Error(`unexpected fake fetch: ${url}`);
  };
  const report = await runProbe({ fetchImpl, clientIds: [GIST_CIMD] });
  assert.equal(report.controlOk, true);
  assert.equal(report.cases.find((c) => c.clientId === GIST_CIMD).authorize.stage, 'client_id_rejected');
});

test('runProbe: a non-JSON content type is reported as an unfetchable document, not accepted', async () => {
  const { fetchImpl } = scenarioFetch({ ourContentType: 'text/html' });
  const report = await runProbe({ fetchImpl, clientIds: [OUR_CIMD] });
  const ours = report.cases.find((c) => c.clientId === OUR_CIMD);
  assert.equal(ours.cimdFetch.checks.contentTypeJson, false);
  assert.equal(ours.cimdFetch.checks.fetched, false);
  assert.match(report.conclusions.join('\n'), /document not fetchable\/valid over HTTPS/);
});

test('runProbe: a 404 on the CIMD URL is recorded verbatim (no faked 200)', async () => {
  const { fetchImpl } = scenarioFetch({ ourDocStatus: 404, ourDoc: { error: 'not_found' } });
  const report = await runProbe({ fetchImpl, clientIds: [OUR_CIMD] });
  const ours = report.cases.find((c) => c.clientId === OUR_CIMD);
  assert.equal(ours.cimdFetch.status, 404);
  assert.equal(ours.cimdFetch.checks.clientIdMatchesUrl, false);
  assert.equal(ours.cimdFetch.checks.fetched, false);
});

test('runProbe: control failure blocks all conclusions', async () => {
  const { fetchImpl } = scenarioFetch({
    controlBody: '{"error":"invalid_client","error_description":"Invalid client_id"}',
  });
  const report = await runProbe({ fetchImpl, clientIds: [OUR_CIMD] });
  assert.equal(report.controlOk, false);
  assert.equal(report.control.stage, 'client_id_rejected');
  assert.deepEqual(report.conclusions, [
    'CONTROL_FAILED: Notion CIMD did not reach pkce_stage; results are not interpretable. Re-run or check network/proxy.',
  ]);
});

test('runProbe: document-only variants never fabricate an AS verdict', async () => {
  const { fetchImpl } = scenarioFetch();
  const variantDoc = { ...ourDocument(OUR_CIMD), client_uri: 'https://www.notion.so' };
  const report = await runProbe({
    fetchImpl,
    clientIds: [{ clientId: OUR_CIMD, label: 'client_uri=notion', document: variantDoc, contentType: 'application/json' }],
  });
  const variant = report.cases.find((c) => c.label === 'client_uri=notion');
  assert.equal(variant.authorize.stage, 'skipped_document_only');
  assert.equal(variant.authorize.url, null, 'no authorize request was issued');
  assert.equal(variant.cimdFetch.checks.fetched, true);
  assert.match(report.conclusions.join('\n'), /document-only variant/);
  assert.doesNotMatch(report.conclusions.join('\n'), /CIMD ACCEPTED/);
});

test('runProbe: a document-only variant that passes all structural checks is still not "accepted"', async () => {
  const fetchImpl = async (url) => {
    if (url === NOTION_CONTROL) return jsonResponse(controlDocument());
    if (String(url).startsWith(`${VERCEL_AUTHORIZE}?`)) {
      return jsonResponse('{"error_description":"code_challenge too short"}');
    }
    throw new Error(`unexpected network call: ${url}`);
  };
  const report = await runProbe({
    fetchImpl,
    clientIds: [{ clientId: OUR_CIMD, document: ourDocument(), contentType: 'application/json' }],
  });
  assert.equal(report.control.stage, 'pkce_stage_reached');
  assert.equal(report.cases[1].authorize.stage, 'skipped_document_only');
  assert.equal(JSON.stringify(report).includes('accepted: true'), false);
  assert.equal(JSON.stringify(report).includes('"accepted"'), false);
});

test('runProbe: network fetch failure is recorded as fetch_failed, not a rejection', async () => {
  const fetchImpl = async (url) => {
    if (url === NOTION_CONTROL) return jsonResponse(controlDocument());
    if (String(url).startsWith(`${VERCEL_AUTHORIZE}?`)) {
      const clientId = new URL(url).searchParams.get('client_id');
      if (clientId === NOTION_CONTROL) return jsonResponse('{"error_description":"code_challenge too short"}');
      throw new Error('ENETUNREACH');
    }
    if (url === OUR_CIMD) return jsonResponse(ourDocument());
    throw new Error(`unexpected fake fetch: ${url}`);
  };
  const report = await runProbe({ fetchImpl, clientIds: [OUR_CIMD] });
  const ours = report.cases.find((c) => c.clientId === OUR_CIMD);
  assert.equal(ours.authorize.stage, 'fetch_failed');
  assert.equal(ours.authorize.errorText, 'ENETUNREACH');
});

test('runProbe: rejects a non-function fetchImpl instead of silently going online', async () => {
  await assert.rejects(() => runProbe({ fetchImpl: null, clientIds: [OUR_CIMD] }), /fetchImpl must be a function/);
});
