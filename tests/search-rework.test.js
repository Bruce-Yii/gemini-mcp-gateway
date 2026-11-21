/**
 * Search ranking rework regression tests (L3 fixes):
 *   - service attribution as a structured filter / diversity dimension
 *   - description noise isolated into a capped tie-break
 *   - strong name + exact-match ranking
 *   - select: and the {matches, total, hint} contract stay compatible
 *
 * All fixtures below are local and untrusted-data-safe: no network, no real
 * tool descriptions from upstream services.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { searchEntries } from '../src/catalog.js';

/** A long, keyword-stuffed description that used to win by raw word count. */
const STUFFED_DESCRIPTION = Array.from({ length: 120 }, () => 'page page page').join(' ');

const mixedEntries = [
  // Long description, weak name: must NOT win on description alone.
  { server: 'alpha', tool: 'note', name: 'alpha__note', description: STUFFED_DESCRIPTION },
  // Short description, strong name.
  { server: 'alpha', tool: 'create_page', name: 'alpha__create_page', description: 'Create a page.' },
  { server: 'beta', tool: 'create_page', name: 'beta__create_page', description: 'Create a page.' },
  { server: 'gamma', tool: 'create_page', name: 'gamma__create_page', description: 'Create a page.' },
  { server: 'delta', tool: 'create_page', name: 'delta__create_page', description: 'Create a page.' },
];

// ---------- ① description noise isolation ----------

test('search-rework①: 长描述堆词不再压过名字命中的短描述工具', () => {
  const result = searchEntries(mixedEntries, 'create page', { limit: 5 });
  assert.ok(result.matches.length > 0);
  assert.notEqual(result.matches[0].name, 'alpha__note', '描述堆 page 的工具不应排到第一');
  assert.equal(result.matches[0].tool, 'create_page');

  // 单纯命中描述的条目仍可被召回（兼容 searchEntries(entries, 'repository')），
  // 但分数必须显著低于名字命中者。
  const byDescOnly = searchEntries(mixedEntries, 'page', { limit: 5 });
  const stuffed = byDescOnly.matches.find((m) => m.name === 'alpha__note');
  const named = byDescOnly.matches.find((m) => m.name === 'alpha__create_page');
  assert.ok(stuffed, '仅描述命中的工具仍应被召回');
  assert.ok(named, '名字命中的工具应被召回');
  assert.ok(named.score > stuffed.score, `名字命中分数应更高: ${named.score} vs ${stuffed.score}`);
});

// ---------- ② cross-service diversity ----------

test('search-rework②: query 不带服务名时，top5 跨服务公平曝光且单服务不超 2 个', () => {
  const entries = ['alpha', 'beta', 'gamma', 'delta'].flatMap((server) =>
    [1, 2, 3].map((i) => ({
      server,
      tool: `list_items_${i}`,
      name: `${server}__list_items_${i}`,
      description: 'list items',
    })),
  );
  const result = searchEntries(entries, 'list items', { limit: 5 });
  assert.equal(result.matches.length, 5);
  const counts = new Map();
  for (const m of result.matches) counts.set(m.server, (counts.get(m.server) ?? 0) + 1);
  assert.ok(counts.size >= 3, `top5 应覆盖至少 3 个服务，实际 ${[...counts.keys()].join(',')}`);
  for (const [server, count] of counts) assert.ok(count <= 2, `服务 ${server} 占据 ${count} 个席位，超过上限`);
  assert.equal(result.total, 12, 'total 应反映全部召回候选，而不是 diversity 截断后的数量');

  // 带服务名时是硬过滤，不再做 diversity 截断。
  const filtered = searchEntries(entries, 'list items alpha', { limit: 5 });
  assert.ok(filtered.matches.length > 0);
  assert.ok(filtered.matches.every((m) => m.server === 'alpha'));
});

// ---------- ③ exact / substring name weighting ----------

test('search-rework③: name 精确匹配排第一，且分数远高于部分匹配', () => {
  const entries = [
    { server: 's', tool: 'get_issue_summary', name: 's__get_issue_summary', description: STUFFED_DESCRIPTION },
    { server: 's', tool: 'get_issue', name: 's__get_issue', description: 'short description' },
    { server: 's', tool: 'list_issues', name: 's__list_issues', description: 'short description' },
  ];
  const result = searchEntries(entries, 'get_issue', { limit: 5 });
  assert.equal(result.matches[0].tool, 'get_issue');
  assert.ok(result.matches[0].score >= 50, `精确匹配应拿到 +50 级别的加成，实际 ${result.matches[0].score}`);
  assert.ok(result.matches[0].score > result.matches[1].score + 10);

  // 自然语言 query 的子串命中（create_page 包含于 s__create_page）同样应排第一。
  const sub = searchEntries(mixedEntries, 'create_page', { limit: 5 });
  assert.equal(sub.matches[0].tool, 'create_page');
});

// ---------- ④ options.server explicit filter ----------

test('search-rework④: options.server 显式过滤生效，并覆盖 query 中的服务 token', () => {
  const entries = [
    { server: 'github', tool: 'list_issues', name: 'github__list_issues', description: 'list issues' },
    { server: 'notion', tool: 'list_issues', name: 'notion__list_issues', description: 'list issues' },
    { server: 'linear', tool: 'list_issues', name: 'linear__list_issues', description: 'list issues' },
  ];
  const result = searchEntries(entries, 'list issues', { server: 'notion', limit: 5 });
  assert.equal(result.total, 1);
  assert.equal(result.matches[0].server, 'notion');
  assert.ok(result.matches.every((m) => m.server === 'notion'));

  // 显式参数优先于自动检测到的服务名。
  const override = searchEntries(entries, 'github list issues', { server: 'notion', limit: 5 });
  assert.ok(override.matches.every((m) => m.server === 'notion'));

  // select: 路径同样尊重显式服务过滤。
  const select = searchEntries(entries, 'select:github__list_issues', { server: 'notion', limit: 5 });
  assert.equal(select.total, 0);
});

// ---------- ⑤ select: compatibility ----------

test('search-rework⑤: select: 精确名仍排第一且保持 1000 分与接口结构', () => {
  const result = searchEntries(mixedEntries, 'select:beta__create_page, gamma__create_page', { limit: 5 });
  assert.equal(result.total, 2);
  assert.equal(result.matches[0].name, 'beta__create_page');
  assert.equal(result.matches[1].name, 'gamma__create_page');
  assert.equal(result.matches[0].score, 1000);
  assert.deepEqual(Object.keys(result).sort(), ['hint', 'matches', 'total']);

  const missing = searchEntries(mixedEntries, 'select:nope__tool');
  assert.deepEqual(missing.matches, []);
  assert.match(missing.hint, /No exact name matched/);
});

// ---------- offline recall guard (real dataset, disposable measurement) ----------

test('search-rework: 离线 191 任务工具召回率不低于重构基线', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(here, '..');
  const tasks = JSON.parse(readFileSync(path.join(root, 'explore', 'tasks-v2.json'), 'utf8')).tasks;
  const tools = JSON.parse(readFileSync(path.join(root, 'data', 'tool-dataset.json'), 'utf8'));
  const nameMatches = (actual, expected) => {
    const a = String(actual ?? '').toLowerCase();
    const e = String(expected ?? '').toLowerCase();
    return a === e || a.includes('__' + e) || a.includes(e);
  };
  let top1 = 0;
  let top5 = 0;
  for (const task of tasks) {
    const names = searchEntries(tools, task.prompt, { limit: 5 }).matches.map((m) => m.name);
    const rank = names.findIndex((name) => nameMatches(name, task.tool));
    if (rank === 0) top1++;
    if (rank >= 0) top5++;
  }
  // 基线（重构前）为 top1 48.2% / top5 60.2%；阈值留有余量以容忍无关改动。
  assert.ok(top1 / tasks.length >= 0.50, `top1 召回率 ${(top1 / tasks.length * 100).toFixed(1)}% 低于 50%`);
  assert.ok(top5 / tasks.length >= 0.63, `top5 召回率 ${(top5 / tasks.length * 100).toFixed(1)}% 低于 63%`);
});
