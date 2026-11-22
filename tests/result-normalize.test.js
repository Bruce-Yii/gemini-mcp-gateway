import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeFileResult,
  normalizePrResult,
  normalizeIssueResult,
  normalizeResult,
} from '../src/result-normalize.js';

const FILE_KEYS = ['content', 'sha', 'size', 'encoding', 'path', 'truncated', 'raw'].sort();
const PR_KEYS = [
  'number',
  'title',
  'url',
  'state',
  'headSha',
  'baseRef',
  'mergeable',
  'sha',
  'id',
  'raw',
].sort();
const ISSUE_KEYS = ['number', 'id', 'url', 'state', 'title', 'raw'].sort();

// ---------------------------------------------------------------------------
// normalizeFileResult：每种形状漂移
// ---------------------------------------------------------------------------

test('file：纯字符串 → content + size，其他字段 null，raw 保留', () => {
  const out = normalizeFileResult('hello world');
  assert.deepEqual(Object.keys(out).sort(), FILE_KEYS);
  assert.equal(out.content, 'hello world');
  assert.equal(out.size, 11);
  assert.equal(out.sha, null);
  assert.equal(out.path, null);
  assert.equal(out.encoding, null);
  assert.equal(out.truncated, false);
  assert.equal(out.raw, 'hello world');
});

test('file：{text, resources} → 从 text 取 content，resources 不重复覆盖', () => {
  const input = { text: 'hello', resources: [{ text: 'hello' }, { text: 'tail' }] };
  const out = normalizeFileResult(input);
  assert.deepEqual(Object.keys(out).sort(), FILE_KEYS);
  assert.equal(out.content, 'hello');
  assert.equal(out.raw, input);
});

test('file：仅 resources[].text → 合并为单一字符串，重复文本只保留一次', () => {
  const input = { resources: [{ text: 'A' }, { text: 'A' }, { text: 'B' }] };
  const out = normalizeFileResult(input);
  assert.equal(out.content, 'A\nB');
  assert.equal(out.raw, input);
});

test('file：{content, sha, size, encoding, path} → 元信息全部保留', () => {
  const out = normalizeFileResult({
    content: 'abc',
    sha: 'deadbeef',
    size: 1234,
    encoding: 'base64',
    path: 'src/a.js',
  });
  assert.equal(out.content, 'abc');
  assert.equal(out.sha, 'deadbeef');
  assert.equal(out.size, 1234);
  assert.equal(out.encoding, 'base64');
  assert.equal(out.path, 'src/a.js');
});

test('file：{result:{content...}} envelope → 内容从 result 取', () => {
  const out = normalizeFileResult({
    result: { content: 'xyz', sha: 's1', size: 3, path: 'b.txt' },
  });
  assert.equal(out.content, 'xyz');
  assert.equal(out.sha, 's1');
  assert.equal(out.size, 3);
  assert.equal(out.path, 'b.txt');
});

test('file：result 里的 resources[].text 也能取到', () => {
  const out = normalizeFileResult({ result: { resources: [{ text: 'nested' }] } });
  assert.equal(out.content, 'nested');
});

test('file：content 数组（字符串项 / {text} 项）→ 合并为字符串', () => {
  assert.equal(normalizeFileResult({ content: ['a', 'b'] }).content, 'a\nb');
  assert.equal(
    normalizeFileResult({ content: [{ text: 'a' }, { content: 'b' }, 'c'] }).content,
    'a\nb\nc',
  );
});

test('file：content 为对象时尝试 text/content/data', () => {
  assert.equal(normalizeFileResult({ content: { text: 'from-text' } }).content, 'from-text');
  assert.equal(normalizeFileResult({ content: { data: 'from-data' } }).content, 'from-data');
});

test('file：JSON 文本形式的 GitHub 返回也能解出 content', () => {
  const json = JSON.stringify({ content: 'from-json', sha: 'j1', size: 8 });
  const out = normalizeFileResult(json);
  assert.equal(out.content, 'from-json');
  assert.equal(out.sha, 'j1');
  assert.equal(out.size, 8);
  assert.notEqual(out.raw, out);
});

test('file：MCP content 数组 envelope（{type,text}）→ 解出 content', () => {
  const out = normalizeFileResult([
    { type: 'text', text: 'part1' },
    { type: 'text', text: 'part2' },
  ]);
  assert.equal(out.content, 'part1\npart2');
});

test('file：--- TRUNCATED --- 标记与已有 truncated 都识别', () => {
  assert.equal(normalizeFileResult({ content: 'a--- TRUNCATED --- 10 chars total' }).truncated, true);
  assert.equal(normalizeFileResult({ content: 'ok', truncated: true }).truncated, true);
  assert.equal(normalizeFileResult({ content: 'ok' }).truncated, false);
});

test('file：空/null/无法识别 → 字段稳定且为 null，不抛错', () => {
  for (const input of [null, undefined, {}, 42, [], { nonsense: true }, true]) {
    const out = normalizeFileResult(input);
    assert.deepEqual(Object.keys(out).sort(), FILE_KEYS, `input=${JSON.stringify(input)}`);
    if (input === null || input === undefined || input === 42 || input === true) {
      assert.equal(out.content, null);
      assert.equal(out.size, null);
    }
    assert.equal(out.truncated, false);
    assert.equal(out.raw, input);
  }
});

test('file：不修改入参、content 恒为字符串或 null', () => {
  const input = { content: ['a', 'b'], resources: [{ text: 'a' }] };
  const snapshot = JSON.stringify(input);
  const out = normalizeFileResult(input);
  assert.equal(JSON.stringify(input), snapshot);
  assert.equal(typeof out.content, 'string');
  assert.notEqual(out, input);
});

test('file：抛 getter 的 Proxy 不导致异常', () => {
  const hostile = new Proxy(
    {},
    {
      get() {
        throw new Error('boom');
      },
    },
  );
  const out = normalizeFileResult(hostile);
  assert.deepEqual(Object.keys(out).sort(), FILE_KEYS);
  assert.equal(out.content, null);
  assert.equal(out.raw, hostile);
});

// ---------------------------------------------------------------------------
// normalizePrResult：字段兼容
// ---------------------------------------------------------------------------

test('pr：number/id/url/html_url/sha 常见 GitHub 形状', () => {
  const input = {
    number: 12,
    id: 'PR_1',
    html_url: 'https://github.com/a/b/pull/12',
    sha: 'abc',
    title: 'Fix bug',
    state: 'open',
  };
  const out = normalizePrResult(input);
  assert.deepEqual(Object.keys(out).sort(), PR_KEYS);
  assert.equal(out.number, 12);
  assert.equal(out.id, 'PR_1');
  assert.equal(out.url, 'https://github.com/a/b/pull/12');
  assert.equal(out.title, 'Fix bug');
  assert.equal(out.state, 'open');
  assert.equal(out.sha, 'abc');
  assert.equal(out.headSha, 'abc');
  assert.equal(out.raw, input);
});

test('pr：result envelope + head.sha / head.ref / base.ref / mergeable', () => {
  const out = normalizePrResult({
    result: {
      number: 7,
      url: 'https://github.com/a/b/pull/7',
      title: 'T',
      state: 'closed',
      head: { sha: 'def', ref: 'feature' },
      base: { ref: 'main' },
      mergeable: true,
    },
  });
  assert.equal(out.number, 7);
  assert.equal(out.url, 'https://github.com/a/b/pull/7');
  assert.equal(out.headSha, 'def');
  assert.equal(out.sha, 'def');
  assert.equal(out.baseRef, 'main');
  assert.equal(out.mergeable, true);
});

test('pr：id 兜底为 number，url 仅有时从 URL 提取编号', () => {
  const byId = normalizePrResult({ id: 99, url: 'https://example/pull/99' });
  assert.equal(byId.number, 99);
  const byUrl = normalizePrResult({ url: 'https://github.com/a/b/pull/42' });
  assert.equal(byUrl.number, 42);
});

test('pr：mergeable_state 字符串映射，空/null → 字段为 null', () => {
  assert.equal(normalizePrResult({ mergeable_state: 'mergeable' }).mergeable, true);
  assert.equal(normalizePrResult({ mergeable_state: 'conflicting' }).mergeable, false);
  for (const input of [null, undefined, {}, 42, [], { nonsense: true }, true]) {
    const out = normalizePrResult(input);
    assert.deepEqual(Object.keys(out).sort(), PR_KEYS, `input=${JSON.stringify(input)}`);
    assert.equal(out.number, null);
    assert.equal(out.mergeable, null);
    assert.equal(out.raw, input);
  }
});

test('pr：抛 getter 的 Proxy 不导致异常', () => {
  const hostile = new Proxy(
    {},
    {
      get() {
        throw new Error('boom');
      },
    },
  );
  const out = normalizePrResult(hostile);
  assert.deepEqual(Object.keys(out).sort(), PR_KEYS);
  assert.equal(out.number, null);
});

// ---------------------------------------------------------------------------
// normalizeIssueResult：issue / PR 常见形状
// ---------------------------------------------------------------------------

test('issue：number/id/url/state/title 兼容', () => {
  const input = {
    number: 5,
    id: 'I_5',
    html_url: 'https://github.com/a/b/issues/5',
    state: 'open',
    title: 'Bug report',
  };
  const out = normalizeIssueResult(input);
  assert.deepEqual(Object.keys(out).sort(), ISSUE_KEYS);
  assert.equal(out.number, 5);
  assert.equal(out.id, 'I_5');
  assert.equal(out.url, 'https://github.com/a/b/issues/5');
  assert.equal(out.state, 'open');
  assert.equal(out.title, 'Bug report');
  assert.equal(out.raw, input);
});

test('issue：result envelope + PR-as-issue 形状（pull_request 字段不影响）', () => {
  const out = normalizeIssueResult({
    result: {
      number: 3,
      url: 'https://github.com/a/b/issues/3',
      title: 'PR-as-issue',
      state: 'closed',
      pull_request: { url: 'https://github.com/a/b/pulls/3' },
    },
  });
  assert.equal(out.number, 3);
  assert.equal(out.title, 'PR-as-issue');
  assert.equal(out.state, 'closed');
  assert.equal(out.url, 'https://github.com/a/b/issues/3');
});

test('issue：id 兜底为 number；URL 兜底提取编号', () => {
  assert.equal(normalizeIssueResult({ id: 8, url: 'https://example/issues/8' }).number, 8);
  assert.equal(
    normalizeIssueResult({ url: 'https://github.com/a/b/issues/77' }).number,
    77,
  );
});

test('issue：空/null/无法识别 → 字段稳定，raw 保留，不抛错', () => {
  for (const input of [null, undefined, {}, 42, [], { nonsense: true }, true]) {
    const out = normalizeIssueResult(input);
    assert.deepEqual(Object.keys(out).sort(), ISSUE_KEYS, `input=${JSON.stringify(input)}`);
    assert.equal(out.number, null);
    assert.equal(out.raw, input);
  }
});

test('issue：抛 getter 的 Proxy 不导致异常', () => {
  const hostile = new Proxy(
    {},
    {
      get() {
        throw new Error('boom');
      },
    },
  );
  const out = normalizeIssueResult(hostile);
  assert.deepEqual(Object.keys(out).sort(), ISSUE_KEYS);
  assert.equal(out.number, null);
});

// ---------------------------------------------------------------------------
// normalizeResult：按工具名分发 + fallback
// ---------------------------------------------------------------------------

test('dispatch：读文件工具 → file canonical', () => {
  for (const name of [
    'get_file_contents',
    'read_file',
    'github__get_file_contents',
    'gh.get_file_contents',
    'GET_FILE_CONTENTS',
  ]) {
    const out = normalizeResult(name, { content: 'abc' });
    assert.deepEqual(Object.keys(out).sort(), FILE_KEYS, `name=${name}`);
    assert.equal(out.content, 'abc');
  }
});

test('dispatch：PR / issue 工具 → 各自 canonical', () => {
  for (const name of ['create_pull_request', 'get_pull_request', 'gh__create_pr', 'pull_request']) {
    const out = normalizeResult(name, { number: 1, head: { sha: 'h' } });
    assert.deepEqual(Object.keys(out).sort(), PR_KEYS, `name=${name}`);
    assert.equal(out.number, 1);
  }
  for (const name of ['get_issue', 'create_issue', 'gh__issues_get', 'issue']) {
    const out = normalizeResult(name, { number: 2, title: 'T' });
    assert.deepEqual(Object.keys(out).sort(), ISSUE_KEYS, `name=${name}`);
    assert.equal(out.number, 2);
  }
});

test('dispatch：未知工具 → 明确 {raw:value} fallback，不猜测形状', () => {
  const value = { whatever: 1 };
  for (const name of ['search', 'execute', 'gateway_call', '', null, undefined, 'figma__read_design']) {
    const out = normalizeResult(name, value);
    assert.deepEqual(Object.keys(out), ['raw']);
    assert.equal(out.raw, value);
  }
});

test('dispatch：normalizeResult 本身不抛错（恶意 toolName）', () => {
  const hostile = {
    toString() {
      throw new Error('boom');
    },
  };
  const out = normalizeResult(hostile, 'value');
  assert.deepEqual(Object.keys(out), ['raw']);
});
