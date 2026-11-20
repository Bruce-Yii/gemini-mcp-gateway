import test from 'node:test';
import assert from 'node:assert/strict';

import { sanitizeInputSchema, sanitizeTool } from '../src/sanitize.js';

/**
 * Final-review regression suite for the edge cases that used to break tool
 * definitions after sanitization: cyclic inputs, pathological depth,
 * type/enum mismatch, untraversed schema keywords, non-object inputSchema and
 * annotation prototype pollution.
 */

function maxDepth(value, depth = 0) {
  if (value === null || typeof value !== 'object') return depth;
  let worst = depth;
  for (const child of Object.values(value)) worst = Math.max(worst, maxDepth(child, depth + 1));
  return worst;
}

// ---------------------------------------------------------------------------
// 1. Cyclic inputs must not crash / must stay serialisable
// ---------------------------------------------------------------------------

test('自环引用不会栈溢出，输出有限且可 JSON 序列化', () => {
  const schema = { type: 'object', properties: {} };
  schema.properties.self = schema;

  const out = sanitizeInputSchema(schema);

  assert.equal(out.type, 'object');
  assert.deepEqual(out.properties.self, {}, '回边被替换为安全空对象');
  assert.doesNotThrow(() => JSON.stringify(out));
  assert.ok(maxDepth(out) < 10);
});

test('两个节点互相引用不会栈溢出', () => {
  const a = { type: 'object', properties: {} };
  const b = { type: 'object', properties: { a } };
  a.properties.b = b;

  const out = sanitizeInputSchema(a);

  assert.equal(out.type, 'object');
  assert.deepEqual(out.properties.b.properties.a, {});
  assert.doesNotThrow(() => JSON.stringify(out));
});

test('数组自环也会被断开', () => {
  const arr = [{ type: 'array' }];
  arr.push(arr);

  const out = sanitizeInputSchema({ type: 'array', items: arr });

  assert.ok(Array.isArray(out.items));
  assert.deepEqual(out.items[1], []);
  assert.doesNotThrow(() => JSON.stringify(out));
});

test('共享（非循环）引用仍被独立深拷贝，互不 alias', () => {
  const shared = { type: 'array' };
  const schema = { type: 'object', properties: { a: shared, b: shared } };

  const out = sanitizeInputSchema(schema);

  assert.notStrictEqual(out.properties.a, out.properties.b);
  assert.deepEqual(out.properties.a.items, { type: 'string' });
  out.properties.a.items = { type: 'number' };
  assert.deepEqual(out.properties.b.items, { type: 'string' });
});

// ---------------------------------------------------------------------------
// 2. Pathological depth must not crash
// ---------------------------------------------------------------------------

test('极深嵌套被限深，不再抛出 RangeError', () => {
  let schema = { type: 'array' };
  for (let i = 0; i < 5000; i += 1) schema = { type: 'object', properties: { n: schema } };

  const out = sanitizeInputSchema(schema);

  assert.equal(out.type, 'object');
  assert.ok(maxDepth(out) < 300, `输出深度应被限制，实际 ${maxDepth(out)}`);
  assert.doesNotThrow(() => JSON.stringify(out));
});

// ---------------------------------------------------------------------------
// 3. enum / type consistency
// ---------------------------------------------------------------------------

test('多类型 + 混合 enum：选择与多数 enum 值匹配的类型并过滤 enum', () => {
  const out = sanitizeInputSchema({ type: ['string', 'integer'], enum: [1, 2, 'auto'] });

  assert.equal(out.type, 'integer');
  assert.deepEqual(out.enum, [1, 2]);
  assert.match(out.description, /enum filtered/);
});

test('多类型 + enum 全部命中某一类型时保留完整 enum 且不加提示', () => {
  const out = sanitizeInputSchema({ type: ['integer', 'string'], enum: [1, 2] });

  assert.equal(out.type, 'integer');
  assert.deepEqual(out.enum, [1, 2]);
  assert.equal(out.description, undefined);
});

test('单类型但 enum 混入其它类型时被过滤', () => {
  const out = sanitizeInputSchema({ type: 'string', enum: ['a', 1, true] });

  assert.deepEqual(out.enum, ['a']);
  assert.match(out.description, /enum filtered/);
});

test('没有任何 enum 值匹配声明类型时删除 enum', () => {
  const out = sanitizeInputSchema({ type: 'integer', enum: ['a', 'b'] });

  assert.equal(out.enum, undefined);
  assert.match(out.description, /enum removed/);
});

test('type 数组里的非字符串项被忽略，回退到 string', () => {
  const out = sanitizeInputSchema({ type: [1, 2] });
  assert.equal(out.type, 'string');
});

test('多类型收敛仍按首个非 null 类型（无 enum 时）', () => {
  const out = sanitizeInputSchema({ type: ['null', 'integer', 'string'] });
  assert.equal(out.type, 'integer');
});

// ---------------------------------------------------------------------------
// 4. Previously untraversed nested-schema keywords
// ---------------------------------------------------------------------------

test('dependentSchemas / unevaluated* / additionalItems / contentSchema 内的 array 也补 items', () => {
  const schema = {
    type: 'object',
    dependentSchemas: { a: { properties: { b: { type: 'array' } } } },
    unevaluatedItems: { type: 'array' },
    unevaluatedProperties: { properties: { c: { type: 'array' } } },
    contentSchema: { type: 'array' },
    additionalItems: { type: 'array' },
  };

  const out = sanitizeInputSchema(schema);

  assert.deepEqual(out.dependentSchemas.a.properties.b.items, { type: 'string' });
  assert.deepEqual(out.unevaluatedItems.items, { type: 'string' });
  assert.deepEqual(out.unevaluatedProperties.properties.c.items, { type: 'string' });
  assert.deepEqual(out.contentSchema.items, { type: 'string' });
  assert.deepEqual(out.additionalItems.items, { type: 'string' });
});

test('$defs 中的定义被清洗，且 $ref 被原样保留', () => {
  const schema = {
    type: 'object',
    properties: { x: { $ref: '#/$defs/X' } },
    $defs: { X: { type: 'array' } },
  };

  const out = sanitizeInputSchema(schema);

  assert.deepEqual(out.properties.x, { $ref: '#/$defs/X' });
  assert.deepEqual(out.$defs.X.items, { type: 'string' });
});

// ---------------------------------------------------------------------------
// 5. inputSchema normalization
// ---------------------------------------------------------------------------

test('sanitizeTool 遇到 null / 数组 / 原始值 inputSchema 时回退到安全默认对象', () => {
  for (const inputSchema of [null, [1, 2], 'oops', 42, true]) {
    const out = sanitizeTool({ name: 'x', inputSchema });
    assert.deepEqual(out.inputSchema, { type: 'object', properties: {} });
  }
});

test('sanitizeInputSchema 直接接收非对象时也返回安全默认对象', () => {
  assert.deepEqual(sanitizeInputSchema(null), { type: 'object', properties: {} });
  assert.deepEqual(sanitizeInputSchema([]), { type: 'object', properties: {} });
});

// ---------------------------------------------------------------------------
// 6. Annotation hardening
// ---------------------------------------------------------------------------

test('annotations 中的 __proto__ 不会污染返回对象或全局 Object.prototype', () => {
  const annotations = JSON.parse('{"__proto__":{"polluted":true},"readOnlyHint":true}');

  const out = sanitizeTool({ name: 'x', annotations });

  assert.equal(Object.prototype.hasOwnProperty.call(out.annotations, '__proto__'), false);
  assert.equal(out.annotations.polluted, undefined);
  assert.equal({}.polluted, undefined);
  assert.equal(out.annotations.readOnlyHint, true);
  assert.equal(out.annotations.destructiveHint, true, '其它默认值仍保留');
});

// ---------------------------------------------------------------------------
// 7. Core rules still hold (regression smoke)
// ---------------------------------------------------------------------------

test('核心规则回归：array items / oneOf 截断 / 名称清洗 / 默认值 / 不改入参', () => {
  const tool = {
    name: 'bad/name:with spaces',
    description: 'desc',
    inputSchema: {
      type: 'object',
      properties: { list: { type: 'array' } },
      oneOf: Array.from({ length: 9 }, () => ({ type: 'string' })),
    },
    annotations: { readOnlyHint: true },
  };
  const snapshot = structuredClone(tool);

  const out = sanitizeTool(tool);

  assert.deepEqual(tool, snapshot, '入参未被修改');
  assert.equal(out.name, 'bad_name_with_spaces');
  assert.deepEqual(out.inputSchema.properties.list.items, { type: 'string' });
  assert.equal(out.inputSchema.oneOf.length, 8);
  assert.match(out.inputSchema.description, /9/);
  assert.equal(out.annotations.readOnlyHint, true);
  assert.equal(out.annotations.destructiveHint, true);
  assert.equal(out.annotations.openWorldHint, true);
});
