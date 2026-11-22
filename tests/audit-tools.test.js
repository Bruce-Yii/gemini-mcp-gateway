import test from 'node:test';
import assert from 'node:assert/strict';

import { auditTools } from '../scripts/audit-tools.mjs';

const SERVER = { name: 'figma', denyTools: ['denied-tool'], allowTools: [] };

function snapshot(names) {
  return { tools: names.map((name) => ({ name, description: name, inputSchema: {} })) };
}

function official(names) {
  return { tools: names.map((name) => ({ name, category: 'test', type: 'read' })) };
}

function policy({ deny = [], allowExtra = [] } = {}) {
  return { deny, allowExtra };
}

test('auditTools: valid snapshot/official/policy passes with total/exposed/denied', () => {
  const result = auditTools({
    snapshot: snapshot(['a', 'b', 'denied-tool']),
    official: official(['a', 'b']),
    policy: policy({ deny: [{ name: 'denied-tool', category: 'internal-ui', reason: 'not needed' }] }),
    server: SERVER,
  });
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.deepEqual(result.stats.deniedNames, ['denied-tool']);
  assert.equal(result.stats.total, 3);
  assert.equal(result.stats.exposed, 2);
  assert.equal(result.stats.denied, 1);
});

test('auditTools: official tool missing from snapshot fails', () => {
  const result = auditTools({
    snapshot: snapshot(['a']),
    official: official(['a', 'b']),
    policy: policy(),
    server: SERVER,
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /official tools missing from snapshot: b/);
});

test('auditTools: undocumented extra must be declared in allowExtra or denied', () => {
  const result = auditTools({
    snapshot: snapshot(['a', 'extra']),
    official: official(['a']),
    policy: policy(),
    server: SERVER,
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /not declared in policy\.allowExtra: extra/);

  const declared = auditTools({
    snapshot: snapshot(['a', 'extra']),
    official: official(['a']),
    policy: policy({ allowExtra: [{ name: 'extra', category: 'workflow-support', reason: 'needed' }] }),
    server: SERVER,
  });
  assert.equal(declared.ok, true, declared.errors.join('\n'));
});

test('auditTools: denied tool needs an explicit policy reason (not uncertain)', () => {
  const missing = auditTools({
    snapshot: snapshot(['denied-tool']),
    official: official(['denied-tool']),
    policy: policy(),
    server: SERVER,
  });
  assert.equal(missing.ok, false);
  assert.match(missing.errors.join('\n'), /denied tool has no policy entry/);

  const uncertain = auditTools({
    snapshot: snapshot(['denied-tool']),
    official: official(['denied-tool']),
    policy: policy({ deny: [{ name: 'denied-tool', category: 'uncertain', reason: 'maybe' }] }),
    server: SERVER,
  });
  assert.equal(uncertain.ok, false);
  assert.match(uncertain.errors.join('\n'), /must be explicit \(not uncertain\)/);
});

test('auditTools: policy/config deny mismatch fails both directions', () => {
  const configNotPolicy = auditTools({
    snapshot: snapshot(['a', 'denied-tool']),
    official: official(['a', 'denied-tool']),
    policy: policy({ deny: [{ name: 'a', category: 'internal-ui', reason: 'r' }] }),
    server: SERVER,
  });
  assert.equal(configNotPolicy.ok, false);
  assert.match(configNotPolicy.errors.join('\n'), /config does not deny|no policy entry/);

  const policyNotConfig = auditTools({
    snapshot: snapshot(['a', 'b']),
    official: official(['a', 'b']),
    policy: policy({ deny: [{ name: 'b', category: 'internal-ui', reason: 'r' }] }),
    server: SERVER,
  });
  assert.equal(policyNotConfig.ok, false);
  assert.match(policyNotConfig.errors.join('\n'), /config does not deny: b/);
});

test('auditTools: allowExtra tool cannot be denied by config', () => {
  const result = auditTools({
    snapshot: snapshot(['a', 'denied-tool']),
    official: official(['a']),
    policy: policy({
      deny: [{ name: 'denied-tool', category: 'internal-ui', reason: 'r' }],
      allowExtra: [{ name: 'denied-tool', category: 'workflow-support', reason: 'r' }],
    }),
    server: SERVER,
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /allowExtra tool is denied/);
});
