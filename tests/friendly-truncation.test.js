/**
 * 建议 4（网关层）：大返回体友好截断提示。
 *
 * 验证 truncateResultValue / truncateResponseText 在被截断时：
 *  - 对象带 `top-level keys: [...]` 摘要
 *  - 数组带 `array length: <n>` 摘要
 *  - 字符串带总长度 + grepSnippet/text.slice 定位提示
 *  - 输出仍是合法 JSON、同形状，且保留 `--- TRUNCATED ---` 标记
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { truncateResultValue } from '../src/tool-format.js';

/* ---------------- 对象：顶层 keys 摘要 ---------------- */

test('超长对象截断后带 top-level keys 摘要，且保持合法 JSON 与标记', () => {
  const value = {
    results: Array.from({ length: 500 }, (_, i) => ({ id: i, blob: 'x'.repeat(40) })),
    nextCursor: 'abc',
    total: 12345,
  };
  const out = truncateResultValue(value, { maxChars: 800 });
  const serialized = JSON.stringify(out);

  assert.ok(serialized.includes('--- TRUNCATED ---'), '保留原有截断标记');
  assert.ok(
    serialized.includes('top-level keys: [results, nextCursor, total]'),
    `应给出原始顶层 keys，实际输出：${serialized.slice(-200)}`,
  );
  assert.ok(serialized.length <= 800, `序列化长度 ${serialized.length} 必须 <= 800`);

  const round = JSON.parse(serialized); // 合法 JSON
  assert.equal(typeof round, 'object');
  assert.equal(round.total, 12345, '小字段原样保留');
  assert.ok(Array.isArray(round.results), '数组字段形状不变');
});

test('top-level keys 摘要包含被丢弃的 key（即使其值被整个删掉）', () => {
  const value = {
    hugeA: 'a'.repeat(6000),
    hugeB: 'b'.repeat(6000),
    keepMe: 7,
  };
  const out = truncateResultValue(value, { maxChars: 400 });
  const serialized = JSON.stringify(out);
  assert.ok(serialized.includes('--- TRUNCATED ---'));
  assert.ok(serialized.includes('top-level keys: [hugeA, hugeB, keepMe]'));
  assert.equal(JSON.parse(serialized).keepMe, 7);
});

/* ---------------- 数组：长度摘要 ---------------- */

test('超长数组截断后带 array length 摘要，且保持合法 JSON 与标记', () => {
  const value = Array.from({ length: 42 }, (_, i) => ({ id: i, payload: 'z'.repeat(200) }));
  const out = truncateResultValue(value, { maxChars: 800 });

  assert.ok(Array.isArray(out), '数组形状保持');
  const serialized = JSON.stringify(out);
  assert.ok(serialized.includes('--- TRUNCATED ---'), '保留原有截断标记');
  assert.ok(serialized.includes('array length: 42'), `应给出原始长度，实际：${serialized.slice(-200)}`);
  assert.ok(serialized.length <= 800, `序列化长度 ${serialized.length} 必须 <= 800`);
  assert.ok(JSON.parse(serialized).length < 42, '确实丢掉了尾部元素');
});

test('数组仅因元素内容过大而缩短时，也带 array length 摘要', () => {
  const value = ['q'.repeat(5000)]; // 只有一个元素，不会被丢，但内容会被截
  const out = truncateResultValue(value, { maxChars: 300 });
  const serialized = JSON.stringify(out);
  assert.ok(Array.isArray(out));
  assert.ok(serialized.includes('--- TRUNCATED ---'));
  assert.ok(serialized.includes('array length: 1'));
  assert.ok(serialized.length <= 300);
});

/* ---------------- 字符串：总长度 + 定位提示 ---------------- */

test('超长纯文本截断后带总长度与 grepSnippet/text.slice 定位提示', () => {
  const text = 'A'.repeat(12000);
  const out = truncateResultValue(text, { maxChars: 800 });

  assert.equal(typeof out, 'string');
  assert.ok(out.includes('--- TRUNCATED ---'), '保留原有截断标记');
  assert.ok(out.includes((text.length).toLocaleString()), '带原始总长度');
  assert.ok(/grepSnippet\/text\.slice/.test(out), `带定位提示，实际：${out.slice(-200)}`);
  assert.ok(out.length <= 800, `文本长度 ${out.length} 必须 <= 800`);
});

test('对象内的超长字符串同样带定位提示（shrinkString 路径）', () => {
  const out = truncateResultValue({ log: 'B'.repeat(12000) }, { maxChars: 500 });
  const serialized = JSON.stringify(out);
  assert.ok(serialized.includes('--- TRUNCATED ---'));
  assert.ok(/grepSnippet\/text\.slice/.test(serialized));
  assert.ok(serialized.includes((12000).toLocaleString()));
  assert.ok(serialized.length <= 500);
});

/* ---------------- 向后兼容 ---------------- */

test('未超长的值原样返回，不附加任何提示或标记', () => {
  const small = { a: 1, b: [1, 2, 3] };
  assert.deepEqual(truncateResultValue(small, { maxChars: 800 }), small);
  assert.equal(truncateResultValue('short text', { maxChars: 800 }), 'short text');
});

test('所有被截断的形态都保留 --- TRUNCATED --- 标记（现有断言兼容）', () => {
  const cases = [
    { big: 'x'.repeat(5000), keep: 1 },             // object
    Array.from({ length: 1000 }, (_, i) => i),       // array
    'y'.repeat(5000),                               // string
  ];
  for (const value of cases) {
    const out = truncateResultValue(value, { maxChars: 600 });
    const serialized = typeof out === 'string' ? out : JSON.stringify(out);
    assert.ok(serialized.includes('--- TRUNCATED ---'), `形态缺失标记：${serialized.slice(0, 80)}`);
    assert.ok(serialized.length <= 610);
  }
});
