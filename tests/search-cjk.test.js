import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { existsSync } from 'node:fs';
import { expandAsciiAbbrev, expandCjkQuery, searchEntries } from '../src/catalog.js';

// The CJK term-expansion rules are public and stay testable in the clean
// export. The catalog-ranking tests need data/tool-dataset.json, a private
// eval fixture excluded from the OSS export; those tests skip explicitly.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hasDataset = existsSync(path.join(root, 'data', 'tool-dataset.json'));
const datasetSkip = hasDataset
  ? false
  : 'private eval fixture data/tool-dataset.json is excluded from the OSS export (see docs/OPEN-SOURCE/EXPORT-TEST-CURATION.md)';
const config = JSON.parse(readFileSync(path.join(root, 'config.example.json'), 'utf8'));
const dataset = hasDataset
  ? JSON.parse(readFileSync(path.join(root, 'data', 'tool-dataset.json'), 'utf8'))
  : [];
const denyByServer = new Map((config.servers ?? []).map((s) => [s.name, new Set(s.denyTools ?? [])]));
const enabled = dataset.filter((t) => !denyByServer.get(t.server)?.has(t.tool));

const catalogTest = (name, fn) => test(name, { skip: datasetSkip }, fn);
const names = (query, limit = 5) => searchEntries(enabled, query, { limit }).matches.map((m) => m.name);

test('CJK map: longest term wins; ASCII abbreviations only expand for CJK queries', () => {
  const openOnly = expandCjkQuery('未合并的 PR');
  assert.ok(openOnly.includes('open'));
  assert.ok(!openOnly.includes('merge'), '未合并 must not also expand to merge');
  assert.ok(expandAsciiAbbrev('未合并的 PR').includes('pull'));
  assert.deepEqual(expandCjkQuery('plain english query'), []);
  assert.deepEqual(expandAsciiAbbrev('plain english query'), []);
});

catalogTest('中文 Vercel 运行时错误/日志查询命中 get_runtime_errors + get_runtime_logs', () => {
  for (const query of ['Vercel 运行时 错误 日志', 'Vercel 运行时错误和日志']) {
    const top = names(query);
    assert.ok(top.includes('vercel__get_runtime_errors'), `${query} -> ${top.join(',')}`);
    assert.ok(top.includes('vercel__get_runtime_logs'), `${query} -> ${top.join(',')}`);
  }
});

catalogTest('中文 Notion 页面搜索仍能看到 notion-search', () => {
  const top = names('Notion 搜索 页面 最近更新');
  assert.ok(top.includes('notion__notion-search'), top.join(','));
});

catalogTest('中文最近页面查询命中 notion-list-recent-pages', () => {
  const top = names('我最近的文档页面');
  assert.ok(top.includes('notion__notion-list-recent-pages'), top.join(','));
});

catalogTest('中文读文件查询命中 github get_file_contents', () => {
  const top = names('读一下这个仓库的 README');
  assert.ok(top.includes('github__get_file_contents'), top.join(','));
});

catalogTest('中文 Linear 评论查询命中 list_comments', () => {
  const top = names('Linear 评论 issue comments');
  assert.ok(top.includes('linear__list_comments'), top.join(','));
});

catalogTest('中英混合的 issue 查询把 list_issues 排进前 5（复数扩展）', () => {
  assert.ok(expandAsciiAbbrev('Linear 分配给我的 issue').includes('issues'));
  assert.deepEqual(expandAsciiAbbrev('list issues'), []);
  const top = names('Linear 分配给我的 issue 未完成');
  assert.ok(top.includes('linear__list_issues'), top.join(','));
});

catalogTest('中文域名 + DNS 查询能召回 list_domains 或 get_records', () => {
  const top = names('Vercel 域名 DNS 记录');
  assert.ok(
    top.includes('vercel__list_domains') || top.includes('vercel__get_records'),
    top.join(','),
  );
});

catalogTest('纯英文查询不会被中文同义词表污染', () => {
  assert.deepEqual(expandCjkQuery('deployments'), []);
  const top = names('deployments');
  assert.ok(top.length > 0);
});
