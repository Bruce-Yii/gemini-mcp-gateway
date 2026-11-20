/**
 * tests/detector.test.js — regression tests for the explorer detector
 * mislabels #21 / #22 / #23 (see work/full-audit.md, work/v2-gateway-triage.md).
 *
 * Everything here is pure-local: constructed fake anomalies / tool results only.
 * No model call, no network, no run-explore.mjs execution, no quota touched.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DETECTOR_VERSION, AnomalyCollector, classifyRootCause,
  pickExecuteResult, classifyExecuteResult, isExecuteTool,
  countToolsByServer, applyServerCoverage,
} from '../explore/trace.mjs';

/* ------------------------------------------------------------------ *
 * Fixtures — shapes copied from the v2 anomalies data, with placeholder
 * ids (my-app / rec_123 / cert_123) that produced clean upstream 404/403.
 * ------------------------------------------------------------------ */
const clean404 = (what) => JSON.stringify({
  result: `execute error: {"error":{"message":"Vercel API request failed (404: not_found). ${what} not found.","recovery":"Check the API message, arguments, target team and resource state."},"isError":true}`,
  isError: true,
  status: 'error',
  // The old detector matched a bare "schema" inside this embedded blob.
  inputSchemaAttached: { type: 'object', properties: { projectId: { type: 'string' } } },
});
const clean403 = (what) => JSON.stringify({
  result: `execute error: {"error":{"message":"Vercel API request failed (403: forbidden). No access to ${what}.","schemaHint":"team_abc"},"isError":true}`,
  isError: true,
  status: 'error',
});
// Real validation errors (v2 F116/F129) must stay in the validation classes.
const enumValidation = JSON.stringify({
  result: 'execute error: validating "arguments": validating /properties/fields/items: enum: repository does not equal any of: [number title body state]',
  isError: true,
});
// A catalog search result — often contains "not found" inside a tool
// description, which is exactly what poisoned 6 execute_error details (#22).
const searchPayload = JSON.stringify({
  matches: [{
    name: 'vercel__get_project_trace',
    description: 'Get the resolved trace. Returns not found when the trace does not exist.',
  }],
  total: 1,
  hint: 'use select:<tool> for an exact name',
});
const realExecuteError = clean404('Record rec_123');

/* ------------------------------------------------------------------ *
 * #21 — clean 404/403 must not be labelled schema mismatch
 * ------------------------------------------------------------------ */
test('#21: bare "schema" substring in a clean 404 blob is not a schema mismatch', () => {
  const detail = clean404('Record rec_123');
  assert.match(detail, /schema/i, 'fixture really contains a schema substring (old false-positive trigger)');
  assert.equal(classifyRootCause(detail), 'upstream_not_found');
  assert.notEqual(classifyRootCause(detail), 'schema/arg-name mismatch');
});

test('#21: clean 403 maps to upstream_forbidden, not schema mismatch', () => {
  const detail = clean403('team_abc');
  assert.match(detail, /schema/i);
  assert.equal(classifyRootCause(detail), 'upstream_forbidden');
  assert.notEqual(classifyRootCause(detail), 'schema/arg-name mismatch');
});

test('#21: the 20 placeholder 404/403 anomalies are all classified as upstream_*', () => {
  const ids = ['my-app', 'rec_123', 'cert_123', 'store_123', 'dpl_123', 'env_123',
    'file_123', 'example.com', 'octocat/Hello-World'];
  const anomalies = Array.from({ length: 20 }, (_, i) => ({
    task: `F${140 + i}`,
    server: 'vercel',
    type: 'execute_error',
    detail: i % 3 === 0 ? clean403(ids[i]) : clean404(ids[i]),
  }));
  const rootCauses = anomalies.map((a) => classifyRootCause(a.detail));
  assert.equal(rootCauses.length, 20);
  assert.deepEqual([...new Set(rootCauses)].sort(), ['upstream_forbidden', 'upstream_not_found']);
  assert.equal(rootCauses.filter((c) => c === 'schema/arg-name mismatch').length, 0);
});

test('#21: an explicit upstream 404 wins over validation-like text embedded in the blob', () => {
  // The old failure mode: a 5k-char Vercel error blob also embedded tool
  // descriptions / schema text, so any broad "schema"/"validating" match won.
  const blob = '{"result":"execute error: Vercel API request failed (404: not_found). Project my-app not found. '
    + 'Tool docs: validating arguments, required parameter projectId, expected one of: [a,b]. '
    + 'inputSchema: {...}","isError":true}';
  assert.equal(classifyRootCause(blob), 'upstream_not_found');
  const forbidden = blob.replace('404: not_found', '403: forbidden');
  assert.equal(classifyRootCause(forbidden), 'upstream_forbidden');
});

test('#21: explicit validation signatures still classify as validation classes', () => {
  assert.equal(classifyRootCause(enumValidation), 'enum/valid-option mismatch');
  assert.equal(classifyRootCause('Invalid option: foo for parameter state'), 'enum/valid-option mismatch');
  assert.equal(classifyRootCause('expected one of: open, closed, merged'), 'enum/valid-option mismatch');
  assert.equal(classifyRootCause("required parameter 'projectId' is missing"), 'param validation');
  assert.equal(classifyRootCause('arg name mismatch: got project_id, expected projectId'), 'schema/arg-name mismatch');
  assert.equal(classifyRootCause('Unexpected argument "dryRun" for this tool'), 'schema/arg-name mismatch');
});

/* ------------------------------------------------------------------ *
 * #22 — execute_error detail comes from the execute tool result by name
 * ------------------------------------------------------------------ */
test('#22: pickExecuteResult selects execute/execute_read by name, not by turn order', () => {
  const turnResults = [
    { name: 'search', text: searchPayload },
    { name: 'execute', text: realExecuteError },
  ];
  const picked = pickExecuteResult(turnResults);
  assert.equal(picked.name, 'execute');
  assert.equal(picked.text, realExecuteError);
  assert.notEqual(picked.text, searchPayload);
  assert.equal(pickExecuteResult([{ name: 'execute_read', text: 'x' }]).name, 'execute_read');
  assert.equal(pickExecuteResult([{ name: 'github__execute', text: 'x' }]).name, 'github__execute');
  assert.equal(isExecuteTool('search'), false);
  assert.equal(pickExecuteResult([{ name: 'search', text: searchPayload }]), null,
    'search-only turns must not produce execute_error');
});

test('#22: a search payload is never an execute_error even if it mentions "not found"', () => {
  assert.match(searchPayload, /not found/, 'fixture really contains a "not found" phrase');
  assert.equal(classifyExecuteResult({ name: 'search', text: searchPayload }), null);
  const finding = classifyExecuteResult({ name: 'execute', text: realExecuteError });
  assert.equal(finding.type, 'execute_error');
  assert.equal(finding.detail, realExecuteError);
  assert.ok(!finding.detail.includes('"matches":'), 'detail must not be a search result');
});

test('#22: the 6 poisoned execute_error details resolve to the execute result', () => {
  // F138/F141/F142/F143/F149/F188 — each turn had a search result first.
  const poisoned = ['F138', 'F141', 'F142', 'F143', 'F149', 'F188'];
  const fixed = poisoned.map((task) => {
    const turnResults = [
      { name: 'search', text: searchPayload },
      { name: 'execute_read', text: `execute error: ${task} failed (404: not_found). rec_123 not found.` },
    ];
    const picked = pickExecuteResult(turnResults);
    const finding = classifyExecuteResult(picked);
    return { task, detail: finding?.detail ?? null };
  });
  assert.equal(fixed.length, 6);
  for (const row of fixed) {
    assert.ok(row.detail?.includes(row.task), `${row.task}: detail came from the execute result`);
    assert.ok(!row.detail.includes('"matches":'), `${row.task}: detail is not a search result`);
    assert.equal(classifyRootCause(row.detail), 'upstream_not_found');
  }
});

/* ------------------------------------------------------------------ *
 * #23 — a server with 0 exposed tools is infra, not a gateway defect
 * ------------------------------------------------------------------ */
test('#23: countToolsByServer aggregates mgr.getEntries() by server', () => {
  const entries = [
    { server: 'github', name: 'github__list_issues' },
    { server: 'github', name: 'github__get_file_contents' },
    { server: 'vercel', name: 'vercel__list_projects' },
    { server: undefined, name: 'broken' },
  ];
  assert.deepEqual(countToolsByServer(entries), { github: 2, vercel: 1 });
  assert.equal(countToolsByServer(entries).linear, undefined);
});

test('#23: a missing server downgrades a gateway anomaly to infra', () => {
  const meta = applyServerCoverage({ traceId: 'run:F100', turnIndex: 0 }, 'linear', 0, 'search_empty');
  assert.equal(meta.attribution, 'infra');
  assert.equal(meta.isGatewayDefect, false);
  assert.match(meta.note, /linear.*0 tools/);
  assert.equal(meta.traceId, 'run:F100', 'original meta is preserved');
});

test('#23: servers with tools and non-gateway attributions are untouched', () => {
  const original = { attribution: 'gateway', traceId: 'run:X' };
  assert.deepEqual(applyServerCoverage(original, 'github', 3, 'search_empty'), original);
  for (const attribution of ['model', 'synthetic_data', 'expected_behavior', 'infra', 'harness']) {
    assert.deepEqual(applyServerCoverage({ attribution }, 'linear', 0, 'search_empty'), { attribution });
  }
});

test('#23: collected anomalies for a zero-tool server count as infra, not gateway', () => {
  // Mirrors the 10 Linear search_empty anomalies (F100/F101/F102/F111/...).
  const tasks = ['F100', 'F101', 'F102', 'F111', 'F115', 'F117', 'F119', 'F122', 'F123', 'F126']
    .map((id) => ({ id, server: 'linear', category: 'derived', prompt: `linear task ${id}` }));
  const exposed = countToolsByServer([
    { server: 'github', name: 'github__a' },
    { server: 'vercel', name: 'vercel__a' },
  ]);
  const collector = new AnomalyCollector(DETECTOR_VERSION);
  for (const task of tasks) {
    collector.flag(
      task, 'search_empty', task.prompt,
      applyServerCoverage({}, task.server, exposed[task.server] ?? 0, 'search_empty'),
    );
  }
  const anomalies = collector.toJSON().anomalies;
  assert.equal(anomalies.length, 10);
  assert.ok(anomalies.every((a) => a.attribution === 'infra'));
  assert.ok(anomalies.every((a) => a.isGatewayDefect === false));
  assert.equal(anomalies.filter((a) => a.attribution === 'gateway').length, 0);
});

/* ------------------------------------------------------------------ *
 * End-to-end sanity on constructed anomalies (still no model / no I/O)
 * ------------------------------------------------------------------ */
test('detector version bumped so old mislabeled data can be told apart', () => {
  assert.equal(DETECTOR_VERSION, '2.1');
});

test('combined: the three mislabels no longer surface as gateway/schema defects', () => {
  const anomalies = [
    { task: 'F147', server: 'vercel', type: 'execute_error', detail: clean404('Record rec_123') },
    { task: 'F188', server: 'vercel', type: 'execute_error', detail: searchPayload },
    { task: 'F100', server: 'linear', type: 'search_empty', detail: 'linear cycles teams issues' },
  ];
  const exposed = countToolsByServer([{ server: 'vercel', name: 'vercel__a' }]);
  const result = anomalies.map((a) => {
    if (a.type === 'execute_error') {
      const exec = classifyExecuteResult({ name: 'execute', text: a.detail });
      if (!exec) return { task: a.task, flagged: false };
      const meta = applyServerCoverage(exec.meta, a.server, exposed[a.server] ?? 0, a.type);
      return {
        task: a.task, flagged: true,
        attribution: meta.attribution ?? 'gateway',
        isGatewayDefect: meta.isGatewayDefect !== false,
        rootCause: meta.rootCause ?? classifyRootCause(exec.detail),
      };
    }
    const meta = applyServerCoverage({}, a.server, exposed[a.server] ?? 0, a.type);
    return {
      task: a.task, flagged: true,
      attribution: meta.attribution ?? 'gateway',
      isGatewayDefect: meta.isGatewayDefect !== false,
      rootCause: meta.rootCause ?? classifyRootCause(a.detail),
    };
  });
  assert.equal(result[0].rootCause, 'upstream_not_found');
  assert.ok(!result[0].rootCause.includes('schema'), 'no schema mislabel on a clean 404');
  assert.equal(result[1].flagged, false, 'search payload is rejected, not flagged as execute_error');
  assert.equal(result[2].attribution, 'infra');
  assert.equal(result[2].isGatewayDefect, false);
  assert.equal(result.filter((r) => r.flagged && r.rootCause === 'schema/arg-name mismatch').length, 0);
});
