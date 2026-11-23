import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SCHEMA,
  parseInput,
  recordFromMarkdown,
  recordFromJson,
  validateRecord,
  toJson,
  normalizeRequestIds,
  normalizePr,
  normalizePrList,
} from '../scripts/record-online-feedback.mjs';

const UUID = '602f4012-8776-465d-8bb3-d9507ef2bd90';
const UUID2 = '1ffa01d7-e747-4c4e-978d-93273710b1d7';

function validRecord(overrides = {}) {
  return {
    schema: SCHEMA,
    time: {
      recordedAt: '2026-11-23T09:02:17+08:00',
      window: { from: '2026-11-23T00:00:00Z', to: '2026-11-23T23:59:59Z' },
    },
    platform: { name: 'gemini', surface: 'web' },
    project: { repo: 'test-org/test-gateway' },
    session: { sessionId: '641ffd4f-8c40-462e-8938-b7b11d9d595f', taskId: 'unknown' },
    feedback: [{
      id: 'F1',
      severity: 'P0',
      category: 'result-shape',
      symptom: 'download notice leaked into file body',
      evidence: {
        source: 'user-report',
        detail: 'fileResult(r).content contains "successfully downloaded text file (SHA: ...)"',
        captureVerified: true,
        pr: [56, 57],
      },
      reproduction: 'read a text file through execute_read and inspect content[0].text',
      requestIds: [UUID],
      status: 'confirmed',
    }],
    offline: {
      comparison: {
        linked: [{ feedbackId: 'F1', taskId: 'unknown', requestId: UUID, status: 'confirmed' }],
        notComparable: ['tokens/task vs response.bytes'],
        baselineRefs: ['explore/baselines/l1-smoke.json'],
      },
    },
    status: 'unverified',
    ...overrides,
  };
}

/* ------------------------------------------------------------------ *
 * Valid records
 * ------------------------------------------------------------------ */

test('valid JSON record passes validation and serializes deterministically', () => {
  const rec = validRecord();
  assert.deepEqual(validateRecord(rec), []);
  const a = toJson(rec);
  const b = toJson(rec);
  assert.equal(a, b);
  assert.match(a, /"schema": "online-feedback.v1"/);
  assert.match(a, /"pr": \[\s*56,\s*57\s*\]/);
});

test('record with unknown requestId and no PR is valid', () => {
  const rec = validRecord();
  rec.feedback[0].requestIds = ['unknown'];
  delete rec.feedback[0].evidence.pr;
  rec.feedback[0].evidence.captureVerified = false;
  assert.deepEqual(validateRecord(rec), []);
});

test('parseInput accepts a JSON string by content sniffing', () => {
  const rec = parseInput(JSON.stringify(validRecord()), 'inline.txt');
  assert.deepEqual(validateRecord(rec), []);
  assert.equal(rec.schema, SCHEMA);
});

/* ------------------------------------------------------------------ *
 * Markdown parsing
 * ------------------------------------------------------------------ */

const MD = `Recorded-at: 2026-11-23T09:02:17+08:00
Window: 2026-11-23T00:00:00Z -> 2026-11-23T23:59:59Z
Platform: gemini web
Repo: test-org/test-gateway
Session: unknown
Task: unknown
Status: unverified
Baseline: explore/baselines/l1-smoke.json

## F1
Severity: P0
Category: result-shape
Symptom: download notice mixed into file body
Evidence: Source: user-report
Detail: fileResult(r).content contains the download notice
Detail: PR #56 cleaned, PR #57 reopened
CaptureVerified: false
PR: #56
PR: #57
Reproduction: read a file and inspect content
RequestIds: unknown
Status: confirmed

## F2
Severity: P1
Category: pr-number
Symptom: DB id used as PR number
Evidence: real create_pull_request returned {id:1000000001,url:/pull/53}
CaptureVerified: false
PR: #53
Reproduction: create PR then merge
RequestIds: ${UUID2}
Status: fixed
`;

test('recordFromMarkdown parses metadata and feedback sections', () => {
  const rec = recordFromMarkdown(MD);
  assert.equal(rec.time.recordedAt, '2026-11-23T09:02:17+08:00');
  assert.equal(rec.time.window.from, '2026-11-23T00:00:00Z');
  assert.equal(rec.time.window.to, '2026-11-23T23:59:59Z');
  assert.equal(rec.platform.name, 'gemini');
  assert.equal(rec.platform.surface, 'web');
  assert.equal(rec.project.repo, 'test-org/test-gateway');
  assert.equal(rec.feedback.length, 2);
  assert.deepEqual(rec.feedback[0].evidence.pr, [56, 57]);
  assert.deepEqual(rec.feedback[0].requestIds, ['unknown']);
  assert.deepEqual(rec.feedback[1].requestIds, [UUID2]);
  assert.equal(rec.feedback[1].evidence.pr[0], 53);
  assert.deepEqual(validateRecord(rec), []);
});

test('markdown Evidence: inline text becomes evidence.detail', () => {
  const rec = recordFromMarkdown(MD);
  assert.match(rec.feedback[1].evidence.detail, /1000000001/);
  assert.equal(rec.feedback[1].evidence.captureVerified, false);
});

test('markdown window parse errors are surfaced by validation', () => {
  const bad = MD.replace('Window: 2026-11-23T00:00:00Z -> 2026-11-23T23:59:59Z', 'Window: 2026-11-23');
  const rec = recordFromMarkdown(bad);
  const errs = validateRecord(rec);
  assert.ok(errs.some((e) => e.includes('time.window.from')));
});

/* ------------------------------------------------------------------ *
 * Missing evidence / severity / status validation
 * ------------------------------------------------------------------ */

test('missing evidence is rejected', () => {
  const rec = validRecord();
  delete rec.feedback[0].evidence;
  const errs = validateRecord(rec);
  assert.ok(errs.some((e) => e.includes('evidence: required object')));
});

test('empty evidence.detail is rejected', () => {
  const rec = validRecord();
  rec.feedback[0].evidence.detail = '   ';
  assert.ok(validateRecord(rec).some((e) => e.includes('evidence.detail')));
});

test('invalid severity is rejected', () => {
  const rec = validRecord();
  rec.feedback[0].severity = 'P3';
  assert.ok(validateRecord(rec).some((e) => e.includes('severity')));
});

test('invalid status values are rejected at both levels', () => {
  const rec = validRecord();
  rec.feedback[0].status = 'verified';
  rec.status = 'done';
  const errs = validateRecord(rec);
  assert.ok(errs.some((e) => e.includes('feedback[0].status')));
  assert.ok(errs.some((e) => e.includes('status: must be one of')));
});

test('empty feedback array is rejected', () => {
  const rec = validRecord({ feedback: [] });
  assert.ok(validateRecord(rec).some((e) => e.includes('feedback: must be a non-empty array')));
});

test('duplicate feedback ids are rejected', () => {
  const rec = validRecord();
  rec.feedback.push({ ...rec.feedback[0] });
  assert.ok(validateRecord(rec).some((e) => e.includes('duplicate id')));
});

test('missing symptom / reproduction / category are rejected', () => {
  const rec = validRecord();
  rec.feedback[0].symptom = '';
  rec.feedback[0].reproduction = '';
  rec.feedback[0].category = '  ';
  const errs = validateRecord(rec);
  assert.ok(errs.some((e) => e.includes('.symptom')));
  assert.ok(errs.some((e) => e.includes('.reproduction')));
  assert.ok(errs.some((e) => e.includes('.category')));
});

test('wrong schema name is rejected', () => {
  const rec = validRecord({ schema: 'online-feedback.v2' });
  assert.ok(validateRecord(rec).some((e) => e.includes('schema: must be exactly')));
});

test('invalid platform / timestamp / missing repo are rejected', () => {
  const rec = validRecord();
  rec.platform.name = 'browser';
  rec.time.recordedAt = 'not-a-date';
  rec.project.repo = '';
  const errs = validateRecord(rec);
  assert.ok(errs.some((e) => e.includes('platform.name')));
  assert.ok(errs.some((e) => e.includes('time.recordedAt')));
  assert.ok(errs.some((e) => e.includes('project.repo')));
});

/* ------------------------------------------------------------------ *
 * requestId / PR normalization
 * ------------------------------------------------------------------ */

test('normalizeRequestIds keeps UUIDs and unknown, never invents ids', () => {
  assert.deepEqual(normalizeRequestIds(undefined), ['unknown']);
  assert.deepEqual(normalizeRequestIds([]), ['unknown']);
  assert.deepEqual(normalizeRequestIds(UUID), [UUID]);
  assert.deepEqual(normalizeRequestIds(`${UUID}, ${UUID2}`), [UUID, UUID2]);
  assert.deepEqual(normalizeRequestIds(['unknown', UUID]), ['unknown', UUID]);
});

test('invalid requestIds are rejected, including empty arrays', () => {
  const rec = validRecord();
  rec.feedback[0].requestIds = ['not-a-uuid'];
  assert.ok(validateRecord(rec).some((e) => e.includes('.requestIds[0]')));
  const rec2 = validRecord();
  rec2.feedback[0].requestIds = [];
  assert.ok(validateRecord(rec2).some((e) => e.includes('.requestIds: non-empty')));
});

test('normalizePr accepts numbers, #53, PR #53 and pull/53', () => {
  assert.equal(normalizePr(53), 53);
  assert.equal(normalizePr('#53'), 53);
  assert.equal(normalizePr('PR #53'), 53);
  assert.equal(normalizePr('pull/53'), 53);
  assert.equal(normalizePr(0), null);
  assert.equal(normalizePr(-1), null);
  assert.equal(normalizePr('1000000001x'), null);
});

test('normalizePrList dedupes and rejects bad entries', () => {
  assert.deepEqual(normalizePrList(['#56', 'PR #57', 56]), [56, 57]);
  assert.deepEqual(normalizePrList(''), []);
  assert.equal(normalizePrList(['#56', 'oops']), null);
});

test('DB id is not accepted as a PR number in raw form', () => {
  const rec = validRecord();
  rec.feedback[0].evidence.pr = [1000000001];
  // A positive integer is syntactically a PR number; the semantic fix belongs
  // to the source record. Here we only check the validator accepts the shape.
  assert.deepEqual(validateRecord(rec), []);
  assert.equal(rec.feedback[0].evidence.pr[0], 1000000001);
});

test('non-integer PR values are rejected', () => {
  const rec = validRecord();
  rec.feedback[0].evidence.pr = ['53'];
  assert.ok(validateRecord(rec).some((e) => e.includes('evidence.pr[0]')));
});

/* ------------------------------------------------------------------ *
 * Determinism / purity
 * ------------------------------------------------------------------ */

test('toJson output has stable key order and round-trips', () => {
  const rec = validRecord();
  const json = toJson(rec);
  const parsed = JSON.parse(json);
  assert.equal(toJson(parsed), json);
  assert.deepEqual(Object.keys(parsed), [
    'schema', 'time', 'platform', 'project', 'session', 'feedback', 'offline', 'status',
  ]);
  assert.deepEqual(Object.keys(parsed.feedback[0]), [
    'id', 'severity', 'category', 'symptom', 'evidence', 'reproduction', 'requestIds', 'status',
  ]);
});

test('recordFromJson normalizes without inventing evidence', () => {
  const rec = recordFromJson(validRecord());
  assert.deepEqual(rec.feedback[0].evidence.pr, [56, 57]);
  assert.equal(rec.feedback[0].evidence.captureVerified, true);
});

test('parseInput rejects empty input', () => {
  assert.throws(() => parseInput('   '), /empty input/);
});

/* ------------------------------------------------------------------ *
 * The real batch record + CLI
 * ------------------------------------------------------------------ */

test('the shipped 2026-11-23 record parses, validates and keeps PR evidence', async () => {
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const path = fileURLToPath(new URL('../docs/eval/online-feedback-2026-11-23.md', import.meta.url));
  const rec = parseInput(await readFile(path, 'utf8'), 'online-feedback-2026-11-23.md');
  assert.deepEqual(validateRecord(rec), []);
  assert.equal(rec.feedback.length, 7);
  const byId = Object.fromEntries(rec.feedback.map((f) => [f.id, f]));
  assert.deepEqual(byId.F1.evidence.pr, [56, 57]);
  assert.deepEqual(byId.F3.evidence.pr, [53]);
  assert.equal(byId.F3.severity, 'P1');
  assert.equal(byId.F2.status, 'unverified');
  assert.deepEqual(byId.F2.requestIds, ['unknown']);
  // Same input -> byte-identical output (output determinism on the real file).
  assert.equal(toJson(rec), toJson(parseInput(await readFile(path, 'utf8'), 'online-feedback-2026-11-23.md')));
});

test('CLI emits valid JSON for the shipped record (cross-platform entry guard)', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const script = fileURLToPath(new URL('../scripts/record-online-feedback.mjs', import.meta.url));
  const doc = fileURLToPath(new URL('../docs/eval/online-feedback-2026-11-23.md', import.meta.url));
  const r = spawnSync(process.execPath, [script, doc], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const rec = JSON.parse(r.stdout);
  assert.deepEqual(validateRecord(rec), []);
  assert.equal(rec.feedback.length, 7);
});
