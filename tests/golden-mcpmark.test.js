import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  DEFAULT_MCPMARK_ROOT,
  DEFAULT_TASKS_FILE,
  SUPPORTED_SERVICES,
  discoverAuthoritativeTasks,
  classifyVerifier,
  loadDerivedTasks,
  mapDerivedToAuthoritative,
  buildGoldenReport,
} from '../explore/golden-mcpmark.mjs';

const discovered = discoverAuthoritativeTasks();
const authoritative = discovered.tasks;
const derived = loadDerivedTasks();
const mapping = mapDerivedToAuthoritative(derived, authoritative);

const cloneAvailable = discovered.sourcePresent;
const cloneTest = (name, fn) => test(
  name,
  { skip: cloneAvailable ? false : 'MCPMark local clone not present (optional dev fixture; see explore/README.md)' },
  fn,
);
cloneTest('本地 MCPMark 克隆存在，权威任务清单数量与结构正确', () => {
  assert.equal(discovered.sourcePresent, true);
  assert.equal(DEFAULT_MCPMARK_ROOT.endsWith(path.join('work', 'mcpmark')), true);
  assert.equal(DEFAULT_TASKS_FILE.endsWith(path.join('explore', 'tasks-final.json')), true);
  assert.deepEqual(SUPPORTED_SERVICES, ['github', 'notion']);
  assert.equal(authoritative.length, 71);
  const byService = {};
  const bySuite = {};
  for (const task of authoritative) {
    byService[task.service] = (byService[task.service] || 0) + 1;
    bySuite[task.suite] = (bySuite[task.suite] || 0) + 1;
  }
  assert.deepEqual(byService, { github: 33, notion: 38 }); // GitHub 23+10 / Notion 28+10
  assert.deepEqual(bySuite, { standard: 51, easy: 20 });
});

cloneTest('每条权威任务的 prompt 取自 description.md 原文且三件套齐备', () => {
  for (const task of authoritative) {
    assert.ok(task.key.startsWith(`${task.service}/${task.suite}/`));
    assert.ok(task.prompt.length > 0, `${task.key} 缺 prompt`);
    assert.ok(task.files.description.endsWith('description.md'));
    assert.ok(task.files.meta.endsWith('meta.json'));
    assert.ok(task.files.verify && task.files.verify.endsWith('verify.py'));
    assert.ok(task.stateType === 'url' || task.stateType === null);
  }
  const hotfix = authoritative.find((t) => t.taskId === 'critical_issue_hotfix_workflow');
  assert.ok(hotfix.prompt.includes('Step 1: Create Critical Bug Tracking Issue'));
  assert.ok(hotfix.prompt.includes('hotfix/memory-optimization-v1.0.72'));
  assert.equal(hotfix.stateUrl, 'https://github.com/mcpmark-source/claude-code');
});

cloneTest('GitHub verify.py 判定不可运行：终态检查 + 固定评测环境证据', () => {
  const verdict = classifyVerifier(
    authoritative.find((t) => t.service === 'github' && t.taskId === 'critical_issue_hotfix_workflow'),
  );
  assert.equal(verdict.runnableAgainstOurAccount, false);
  assert.equal(verdict.requiresExternalState, true);
  assert.ok(verdict.markers.some((m) => m.includes('api.github.com')));
  assert.ok(verdict.evidence.some((e) => e.includes('api.github.com')));
  assert.ok(verdict.evidence.some((e) => e.includes('GITHUB_EVAL_ORG')));
  assert.ok(verdict.evidence.some((e) => e.includes('mcpmark-source/claude-code')));
  assert.match(verdict.reason, /终态检查/);
});

cloneTest('Notion verify.py 判定不可运行：读固定评测页面的 block 结构', () => {
  const verdict = classifyVerifier(
    authoritative.find((t) => t.service === 'notion' && t.taskId === 'work_history_addition'),
  );
  assert.equal(verdict.runnableAgainstOurAccount, false);
  assert.ok(verdict.evidence.some((e) => e.includes('notion_client')));
  assert.ok(verdict.evidence.some((e) => e.includes('notion.site')));
});

test('classifyVerifier 接受原始源码字符串，也处理缺 verify.py 的情况', () => {
  const raw = classifyVerifier('from notion_client import Client\nverify against fixed page');
  assert.equal(raw.runnableAgainstOurAccount, false);
  assert.ok(raw.evidence.some((e) => e.includes('notion_client')));
  const missing = classifyVerifier({ files: { verify: null }, stateUrl: null });
  assert.equal(missing.runnableAgainstOurAccount, false);
  assert.equal(missing.requiresExternalState, false);
  assert.match(missing.evidence[0], /缺少 verify.py/);
});

test('derived 任务集读出 86 条 official:false，按服务分布 19/5/16/46', () => {
  assert.equal(derived.length, 86);
  const byService = {};
  for (const task of derived) byService[task.server] = (byService[task.server] || 0) + 1;
  assert.deepEqual(byService, { github: 19, notion: 5, linear: 16, vercel: 46 });
  assert.ok(derived.every((t) => t.id && t.tool && t.prompt));
});

test('Linear / Vercel derived 任务权威源 0 覆盖，不编造映射', () => {
  const uncovered = mapping.filter((r) => r.server === 'linear' || r.server === 'vercel');
  assert.equal(uncovered.length, 62);
  for (const record of uncovered) {
    assert.equal(record.status, 'no_authoritative_source');
    assert.deepEqual(record.matches, []);
    assert.equal(record.recommendation, 'keep_derived_no_authoritative_source');
  }
});

cloneTest('GitHub / Notion derived 任务映射到 MCPMark 权威 prompt 候选，但仅话题级', () => {
  const covered = mapping.filter((r) => r.server === 'github' || r.server === 'notion');
  assert.equal(covered.length, 24);
  for (const record of covered) {
    assert.equal(record.status, 'authoritative_prompt_candidate');
    assert.ok(record.matches.length > 0);
    assert.equal(record.recommendation, 'use_mcpmark_description_as_authoritative_prompt');
    for (const match of record.matches) {
      assert.equal(match.matchKind, 'topic-only');
      assert.ok(match.prompt.length > 0, `${record.id} 的权威 prompt 为空`);
      assert.ok(authoritative.some((t) => t.key === match.key), `未知权威任务 ${match.key}`);
      assert.ok(match.stateUrl, '权威任务应绑定固定评测环境');
      assert.ok(match.score >= 1);
    }
  }
});

cloneTest('特有工具的等价性警告被如实标注，不冒充逐工具 gold', () => {
  const f001 = mapping.find((r) => r.id === 'F001');
  assert.ok(f001.note.includes('v0.15.0 不含该工具'));
  const sidebar = mapping.find((r) => r.tool === 'notion-update-sidebar-tabs');
  assert.ok(sidebar.note.includes('新版 Notion MCP 工具'));
});

test('映射结果确定可复现（无时间戳、无随机性）', () => {
  const again = mapDerivedToAuthoritative(loadDerivedTasks(), discoverAuthoritativeTasks().tasks);
  assert.deepEqual(again, mapping);
});

cloneTest('总报告：prompt 权威性可用，gold 打分不可用，计数自洽', () => {
  const report = buildGoldenReport();
  assert.equal(report.source.present, true);
  assert.equal(report.verifier.runnableAgainstOurAccount, false);
  assert.equal(report.verifier.goldScoringAvailable, false);
  assert.equal(report.verifier.tasksWithVerifier, 71);
  assert.equal(report.conclusion.promptAuthorityAvailable, true);
  assert.equal(report.conclusion.goldScoringAvailable, false);
  assert.equal(report.conclusion.summary, '只能做 prompt 权威性，不能自动打分');
  assert.equal(report.mapping.derivedTotal, 86);
  assert.equal(report.mapping.withAuthoritativePromptCandidate, 24);
  assert.equal(report.mapping.withoutAuthoritativeSource, 62);
  assert.equal(
    report.mapping.withAuthoritativePromptCandidate + report.mapping.withoutAuthoritativeSource,
    report.mapping.derivedTotal,
  );
  assert.deepEqual(report.mapping.derivedByService, { github: 19, notion: 5, linear: 16, vercel: 46 });
  assert.deepEqual(buildGoldenReport(), report);
});

test('本地克隆缺失时不假装成功：如实标记 sourcePresent:false 且仍拒绝 gold 打分', () => {
  const missing = discoverAuthoritativeTasks({ root: path.join('Z:', '__definitely_missing_mcpmark__') });
  assert.equal(missing.sourcePresent, false);
  assert.deepEqual(missing.tasks, []);
  const report = buildGoldenReport({ root: path.join('Z:', '__definitely_missing_mcpmark__') });
  assert.equal(report.source.present, false);
  assert.equal(report.source.authoritativeCount, 0);
  assert.equal(report.conclusion.promptAuthorityAvailable, false);
  assert.equal(report.conclusion.goldScoringAvailable, false);
  assert.equal(report.verifier.runnableAgainstOurAccount, false);
});
