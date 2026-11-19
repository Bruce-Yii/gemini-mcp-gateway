import test from 'node:test';
import assert from 'node:assert/strict';
import {
  tokenize,
  buildIndex,
  searchEntries,
  parseQuery,
  patternMatches,
  isAllowed,
} from '../src/catalog.js';

const entries = [
  {
    server: 'github',
    tool: 'get_file_contents',
    name: 'github__get_file_contents',
    description: 'Get the contents of a file in a repository',
    transport: 'http',
  },
  {
    server: 'github',
    tool: 'list_issues',
    name: 'github__list_issues',
    description: 'List issues in a repository',
    transport: 'http',
  },
  {
    server: 'notion',
    tool: 'notion-search',
    name: 'notion__notion-search',
    description: 'Search Notion pages by title',
    transport: 'http',
  },
];

// ---------- tokenize ----------

test('tokenize: 英文按词切分、小写化，保留下划线标识符，丢弃单字', () => {
  assert.deepEqual(tokenize('Hello World'), ['hello', 'world']);
  assert.deepEqual(tokenize('GET_file Contents'), ['get_file', 'contents']);
  assert.deepEqual(tokenize('a I 42'), ['42']);
  assert.deepEqual(tokenize(''), []);
  assert.deepEqual(tokenize(undefined), []);
  assert.deepEqual(tokenize(123), []);
});

test('tokenize: 中文产生单字 + bigram', () => {
  assert.deepEqual(tokenize('域名解析'), ['域', '名', '解', '析', '域名', '名解', '解析']);
  assert.deepEqual(tokenize('中文'), ['中', '文', '中文']);
});

test('tokenize: 中英混合', () => {
  assert.deepEqual(tokenize('GitHub 域名'), ['github', '域', '名', '域名']);
});

// ---------- buildIndex + searchEntries ----------

test('buildIndex: 建立索引并统计文档与平均长度', () => {
  const index = buildIndex(entries);
  assert.equal(index.total, 3);
  assert.equal(index.docs.length, 3);
  assert.ok(index.df.has('github'));
  assert.ok(index.avgNameLen > 0);
  assert.ok(index.avgDescLen > 0);

  const empty = buildIndex([]);
  assert.equal(empty.total, 0);
  assert.equal(empty.docs.length, 0);
  assert.equal(empty.avgNameLen, 0);
  assert.equal(empty.avgDescLen, 0);
});

test('searchEntries: 基本命中（英文名 / 描述）', () => {
  const r = searchEntries(entries, 'notion');
  assert.equal(r.total, 1);
  assert.equal(r.matches[0].tool, 'notion-search');
  assert.ok(r.matches[0].score > 0);

  const r2 = searchEntries(entries, 'repository');
  assert.ok(r2.matches.some((m) => m.tool === 'get_file_contents'));
  assert.ok(r2.matches.some((m) => m.tool === 'list_issues'));
});

test('searchEntries: 排序——名称命中高于仅描述命中，且按分数降序', () => {
  const rankEntries = [
    { server: 's', tool: 'alpha', name: 's__alpha', description: 'issue tracking' },
    { server: 's', tool: 'beta', name: 's__beta_issue', description: 'unrelated' },
  ];
  const r = searchEntries(rankEntries, 'issue');
  assert.equal(r.matches[0].tool, 'beta');
  assert.ok(r.matches[0].score > r.matches[1].score);
  for (let i = 1; i < r.matches.length; i++) {
    assert.ok(r.matches[i - 1].score >= r.matches[i].score);
  }
});

test('searchEntries: 限制条数并给出截断 hint', () => {
  const many = Array.from({ length: 12 }, (_, i) => ({
    server: 's',
    tool: `tool_${i}`,
    name: `s__tool_${i}`,
    description: 'common keyword',
  }));
  const r = searchEntries(many, 'common', { limit: 3 });
  assert.equal(r.matches.length, 3);
  assert.equal(r.total, 12);
  assert.match(r.hint, /showing 3/);
});

// ---------- parseQuery ----------

test('parseQuery: select / +server / 普通关键词 / 空输入 四种形式', () => {
  assert.deepEqual(parseQuery('select:github__list_issues, notion__notion-fetch'), {
    kind: 'select',
    names: ['github__list_issues', 'notion__notion-fetch'],
    query: 'select:github__list_issues, notion__notion-fetch',
  });
  assert.deepEqual(parseQuery('+github list issues'), {
    kind: 'keywords',
    server: 'github',
    query: 'list issues',
  });
  assert.deepEqual(parseQuery('list issues'), {
    kind: 'keywords',
    server: null,
    query: 'list issues',
  });
  assert.deepEqual(parseQuery('  '), { kind: 'browse', query: '' });
  assert.deepEqual(parseQuery(null), { kind: 'browse', query: '' });
});

test('searchEntries: select 精确名命中与无命中 hint', () => {
  const hit = searchEntries(entries, 'select:github__list_issues');
  assert.equal(hit.total, 1);
  assert.equal(hit.matches[0].tool, 'list_issues');
  assert.equal(hit.matches[0].score, 1000);

  const miss = searchEntries(entries, 'select:nope__tool');
  assert.equal(miss.total, 0);
  assert.deepEqual(miss.matches, []);
  assert.match(miss.hint, /No exact name matched/);
});

test('searchEntries: +server 过滤', () => {
  const r = searchEntries(entries, '+github issue');
  assert.ok(r.matches.length > 0);
  assert.ok(r.matches.every((m) => m.server === 'github'));
  assert.equal(r.matches[0].tool, 'list_issues');
});

// ---------- patternMatches / isAllowed ----------

test('patternMatches: 精确 / 通配符 / 大小写不敏感 / 空列表', () => {
  const entry = {
    server: 'github',
    tool: 'get_file_contents',
    name: 'github__get_file_contents',
  };
  assert.equal(patternMatches([], entry), false);
  assert.equal(patternMatches(undefined, entry), false);
  assert.equal(patternMatches(['github/get_file_contents'], entry), true);
  assert.equal(patternMatches(['github/*'], entry), true);
  assert.equal(patternMatches(['*'], entry), true);
  assert.equal(patternMatches(['get_file_contents'], entry), true);
  assert.equal(patternMatches(['github__get_file_contents'], entry), true);
  assert.equal(patternMatches(['github/get_*'], entry), true);
  assert.equal(patternMatches(['GITHUB/GET_FILE_CONTENTS'], entry), true);
  assert.equal(patternMatches(['github/list_issues'], entry), false);
  assert.equal(patternMatches(['notion/*'], entry), false);
});

test('isAllowed: allow / deny / deny 优先于 allow / 默认放行', () => {
  const ok = { server: 'github', tool: 'get_file_contents', name: 'github__get_file_contents' };
  const bad = { server: 'github', tool: 'delete_file', name: 'github__delete_file' };
  const other = { server: 'notion', tool: 'notion-search', name: 'notion__notion-search' };

  // 无规则默认放行
  assert.equal(isAllowed({}, ok), true);
  // allow 放行 / 拒绝
  assert.equal(isAllowed({ allowTools: ['github/*'] }, ok), true);
  assert.equal(isAllowed({ allowTools: ['github/*'] }, other), false);
  // deny 拒绝 / 不命中放行
  assert.equal(isAllowed({ denyTools: ['github/delete_*'] }, bad), false);
  assert.equal(isAllowed({ denyTools: ['github/delete_*'] }, ok), true);
  // deny 优先于 allow（即使 allow '*' 命中，deny 仍拒绝）
  assert.equal(isAllowed({ allowTools: ['*'], denyTools: ['github/delete_*'] }, bad), false);
  assert.equal(isAllowed({ allowTools: ['github/*'], denyTools: ['github/delete_*'] }, ok), true);
});

// ---------- 空输入 / 无命中 ----------

test('searchEntries: 空输入返回全部（score=1），无命中返回 hint', () => {
  const all = searchEntries(entries, '');
  assert.equal(all.total, 3);
  assert.equal(all.matches.length, 3);
  assert.ok(all.matches.every((m) => m.score === 1));

  const none = searchEntries(entries, 'qqqzzz_no_such_thing');
  assert.deepEqual(none.matches, []);
  assert.equal(none.total, 0);
  assert.match(none.hint, /No tool matched/);

  const emptyCatalog = searchEntries([], 'anything');
  assert.equal(emptyCatalog.total, 0);
  assert.deepEqual(emptyCatalog.matches, []);
  assert.match(emptyCatalog.hint, /No tool matched/);
});
